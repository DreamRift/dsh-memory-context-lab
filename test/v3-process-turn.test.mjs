/**
 * v3 processTurn 用例测试（M3 第一批）——真实适配器组合（临时数据根），
 * Clock/Random/Metrics 注入替身（计划 §2.7 可确定重放）。
 *
 * ## 判据来源
 * 《开发计划-v3》§2.8 事件顺序（归一化→裁决→持久化→投影→计量）、§2.5 端口注入。
 *
 * ## 断言组
 * - 合法事件：applied、记录落库可回读（bytes 诚实）、decision 深冻结、
 *   outcome 结构合法、回合按真实用户推进；
 * - 插件自有来源的 user 事件：入库但不推进回合；
 * - 非法事件：rejected、errors 逐条、不落库（health.recordCount 不变）、拒绝计数；
 * - 持久化失败：outcome failed 且 failures[0].code 如实、applied 计数 0；
 * - 随机端口必须可派生 16 hex；ownSourceKinds 空 → 装配失败。
 *
 * ## 不适用条件与已知边界
 * surface 投影与 metrics 的 observe 细粒度属 M4/M5；本批 outcome 只结算 store-record。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createProcessTurn } from '../src/v3/application/process-turn.mjs'
import { createSessionStorePort } from '../src/v3/adapters/storage/session-store-port.mjs'

const OWN = ['dsh-memory-context-lab']

function fakeClock(start = 1792845000000) {
  let t = start
  return { now: () => t++ }
}

function fakeRandom() {
  let n = 0
  // 计数器放首段：processTurn 的记录 ID 取 UUID 前 16 位十六进制，必须逐次唯一
  return { uuid: () => String(++n).padStart(8, '0') + '-0000-4000-8000-000000000000' }
}

function fakeMetrics() {
  const counters = new Map()
  const observes = []
  return {
    counters, observes,
    counter(name, value) { counters.set(name, (counters.get(name) ?? 0) + value) },
    observe(name, value) { observes.push({ name, value }) },
  }
}

function userEvent(sourceKind = 'user') {
  return { id: 'evt-1', type: 'user', sessionKey: 'sess-a', at: 1792845000000, source: { kind: sourceKind, form: null } }
}

async function withDeps(body) {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-v3-turn-'))
  const { port, store } = await createSessionStorePort(root, 'sess-a')
  try {
    const metrics = fakeMetrics()
    const processTurn = createProcessTurn({
      store: port, clock: fakeClock(), random: fakeRandom(), metrics, ownSourceKinds: OWN,
    })
    return await body({ processTurn, port, store, metrics })
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
}

test('合法事件：applied 全链路（落库/回读/冻结/outcome/回合推进）', async () => {
  await withDeps(async ({ processTurn, port, metrics }) => {
    const result = await processTurn({ event: userEvent(), text: '用户请求正文' })
    assert.equal(result.status, 'applied')
    assert.equal(result.txn.txn, 1)
    assert.equal(result.turn, 1)
    assert.ok(Object.isFrozen(result.decision), '裁决深冻结')
    assert.equal(result.outcome.status, 'applied')
    const stored = await port.readRecord(result.recordId)
    assert.equal(stored.payload.text, '用户请求正文')
    assert.equal(stored.payload.bytes, Buffer.byteLength('用户请求正文', 'utf8'))
    assert.equal(stored.provenance.sourceEventId, 'evt-1')
    assert.equal((await port.health()).recordCount, 1)
    assert.equal(metrics.counters.get('v3.processTurn.applied'), 1)
    // 2026-10-25 事故修正：写事务不重建索引（O(N²) 根因）——事务后陈化、重建后新鲜
    const afterTxn = await port.health()
    assert.equal(afterTxn.indexStale, true, '写路径不重建（P9：检索时兜底）')
    const index = await port.rebuildIndex()
    assert.equal(index.indexedCount, 1)
    assert.equal((await port.health()).indexStale, false)
  })
})

test('插件自有来源的 user 事件：入库但不推进回合', async () => {
  await withDeps(async ({ processTurn }) => {
    await processTurn({ event: userEvent(), text: '第一回合' })
    const injected = await processTurn({ event: userEvent('dsh-memory-context-lab'), text: '插件注入' })
    assert.equal(injected.status, 'applied')
    assert.equal(injected.turn, 1, '插件注入不推进回合')
    const next = await processTurn({ event: userEvent(), text: '第二回合' })
    assert.equal(next.turn, 2)
  })
})

test('非法事件：rejected、不落库、拒绝计数', async () => {
  await withDeps(async ({ processTurn, port, metrics }) => {
    const bad = await processTurn({ event: { ...userEvent(), type: 'ghost' }, text: 'x' })
    assert.equal(bad.status, 'rejected')
    assert.ok(bad.errors.some((e) => /type 必须是封闭集/.test(e)))
    assert.equal((await port.health()).recordCount, 0)
    assert.equal(metrics.counters.get('v3.processTurn.rejected'), 1)
  })
})

test('持久化失败：outcome failed、failures 如实、applied=0', async () => {
  await withDeps(async ({ processTurn }) => {
    const first = await processTurn({ event: userEvent(), text: 'a' })
    // 用已存在 ID 复现冲突：同一事件同 ID 不可行（random 递增），改为关 store 再投
    // ——这里用注入方式：把端口替换为抛错替身验证用例的失败路径
    const { createProcessTurn: recreate } = await import('../src/v3/application/process-turn.mjs')
    const failingStore = {
      transaction: async () => { const e = new Error('存储已判 damaged（x）'); e.code = 'ESTORE_DAMAGED'; throw e },
      readRecord: async () => null,
      restore: () => null,
      forget: async () => null,
      health: () => null,
      rebuildIndex: async () => null,
      listVouchers: () => [],
      sourceEventIds: async () => [],
    }
    const failed = await recreate({
      store: failingStore, clock: fakeClock(), random: fakeRandom(), metrics: fakeMetrics(), ownSourceKinds: OWN,
    })({ event: { ...userEvent(), id: 'evt-2' }, text: 'b' })
    assert.equal(failed.status, 'failed')
    assert.equal(failed.outcome.appliedEffects, 0)
    assert.equal(failed.outcome.failures[0].code, 'ESTORE_DAMAGED')
    assert.equal(failed.txn, null)
    assert.notEqual(first.status, 'failed')
  })
})

test('装配失败关闭：ownSourceKinds 空、坏 random 派生', async () => {
  await withDeps(async ({ port }) => {
    const clock = fakeClock()
    assert.throws(
      () => createProcessTurn({ store: port, clock, random: fakeRandom(), ownSourceKinds: [] }),
      (e) => e?.name === 'V3ContractViolation',
    )
    assert.throws(
      () => createProcessTurn({ store: port, clock, random: { uuid: () => 'short' }, ownSourceKinds: OWN }),
      (e) => e?.name === 'V3ContractViolation',
    )
  })
})
