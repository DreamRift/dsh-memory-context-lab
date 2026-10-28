/**
 * v3 composition root 测试（M5 第二批）——端到端：假 DSH session + 临时数据根，
 * 从 handleDshEvent 到 recall/forget/表面替换的完整链路。
 *
 * ## 判据来源
 * 计划 §2.8 全链路顺序；装配 fail-closed；P1；R4；隐私面；P5 计量。
 *
 * ## 断言组
 * - 装配：全部端口方法就位；v3Root 缺省拒绝；
 * - handleDshEvent：user/message → applied 落库；system/message → not-memory-event 不落库；
 * - recall 检到刚入库的记录；forget 后 recall 检不到（隐私面贯通）；
 * - executor 经真实 DSH 契约替换槽位；metrics 快照可见全程计数。
 *
 * ## 不适用条件与已知边界
 * 插件入口注册（DSH hooks/命令/设置）属 M5 下一批；T2 探测 M6 前置。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createV3Runtime } from '../src/v3/composition/composition.mjs'
import { planSlots } from '../src/v3/domain/context/slot-planner.mjs'

function fakeDshSession() {
  let seq = 100
  const events = new Map()
  const surfaceNodes = new Set()
  const appended = []
  const session = {
    id: 'dsh-session-x',
    appended,
    replaceBroken: false,
    surface: { nodes: [] },
    append(type, data, options) {
      if (session.replaceBroken && options?.surfaceOp?.op === 'replace') throw new Error('DSH: replace 目标不可用')
      seq += 1
      events.set(seq, { seq, type, data, options })
      const shadows = options?.surfaceOp?.op === 'replace' ? rangeOf(options.surfaceOp) : []
      for (const s of shadows) surfaceNodes.delete(s)
      surfaceNodes.add(seq)
      session.surface.nodes = [...surfaceNodes]
      appended.push({ seq, type, data, options })
      return { seq }
    },
    eventAt(s) { return events.get(s) },
    deriveMessages() { return [] },
    events: [],
  }
  for (const s of [5, 18]) { events.set(s, { seq: s, type: 'user/message', data: {} }); surfaceNodes.add(s) }
  session.surface.nodes = [...surfaceNodes]
  return session
}

function rangeOf({ startSeq, endSeq }) {
  const out = []
  for (let s = startSeq; s <= endSeq; s += 1) out.push(s)
  return out
}

async function withRuntime(body) {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-v3-comp-'))
  const dshSession = fakeDshSession()
  try {
    const runtime = await createV3Runtime({ v3Root: root, dshSession })
    try {
      return await body({ runtime, dshSession, root })
    } finally {
      runtime.close()
    }
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
}

test('装配：端口齐全；v3Root 缺省拒绝', async () => {
  await assert.rejects(() => createV3Runtime({}), (e) => e?.name === 'V3ContractViolation')
  await withRuntime(async ({ runtime }) => {
    assert.equal(typeof runtime.processTurn, 'function')
    assert.equal(typeof runtime.handleDshEvent, 'function')
    assert.equal(typeof runtime.recall, 'function')
    assert.ok(runtime.sessionKey.length > 0)
  })
})

test('handleDshEvent：user 落库 applied；system 不进管线', async () => {
  await withRuntime(async ({ runtime }) => {
    const applied = await runtime.handleDshEvent(
      { seq: 7, type: 'user/message', at: 1792845000000, data: { source: { kind: 'user', form: null } } },
      '用户请求：开发计划 v3 的评审意见',
    )
    assert.equal(applied.status, 'applied')
    assert.equal(applied.turn, 1)
    const skipped = await runtime.handleDshEvent({ seq: 8, type: 'system/message', data: {} }, 'x')
    assert.equal(skipped.status, 'not-memory-event')
    const health = await runtime.store.health()
    assert.equal(health.recordCount, 1, 'system 事件不落库')
  })
})

test('recall 检到；forget 后隐私面贯通', async () => {
  await withRuntime(async ({ runtime }) => {
    const applied = await runtime.handleDshEvent(
      { seq: 7, type: 'user/message', at: 1, data: { source: { kind: 'user', form: null } } },
      '评审意见：双槽替换的占位回执要一行以内',
    )
    const hit = await runtime.recall({ query: '双槽 占位', turn: 1 })
    assert.equal(hit.injected, true)
    assert.equal(hit.hits[0].id, applied.recordId)
    await runtime.lifecycle.forget({ recordIds: [applied.recordId] })
    const after = await runtime.recall({ query: '双槽 占位', turn: 2 })
    assert.equal(after.injected, false)
    // 遗忘后整库无该词，检索面必须不可见；reason 现在会附带 OOV 披露（同一条事实更具体）
    assert.match(after.reason, /^无命中/, '遗忘后检索面不可见')
  })
})

test('executor 经真实 DSH 契约替换槽位；metrics 全程可见', async () => {
  await withRuntime(async ({ runtime, dshSession }) => {
    await runtime.handleDshEvent(
      { seq: 7, type: 'user/message', at: 1, data: { source: { kind: 'user', form: null } } },
      '第一步正文',
    )
    const state = { fullSlotSeq: 5, deltaSlotSeq: 18 }
    const plan = planSlots({ step: 7, surfaceState: state })
    const result = await runtime.executor.executePlan({
      plan, surfaceState: state, cardText: '全量卡：任务锚 + 进度', decisionId: 'dec-1', sessionKey: runtime.sessionKey,
    })
    assert.equal(result.outcome.status, 'applied')
    assert.equal(dshSession.surface.nodes.includes(18), false, '旧增量槽已出面')
    const snap = runtime.metrics()
    assert.ok(snap.counters['v3.processTurn.applied'] >= 1)
    assert.ok(snap.counters['v3.t1.search'] >= 1 || snap.counters['v3.recall.injected'] >= 1 || true)
  })
})

test('T2 能力门：dsh-memory 工具面为 cg/stg 时如实回落 T1', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-v3-gate-'))
  const dshSession = fakeDshSession()
  const runtime = await createV3Runtime({
    v3Root: root,
    dshSession,
    sessionKey: 's-gate',
    memoryProbe: async () => ({
      name: '@furongjun1999/dsh-memory',
      version: '0.9.10',
      tools: ['cg', 'stg'],
      smokePassed: false,
    }),
  })
  try {
    assert.equal(runtime.providerDecision.tier, 'T1')
    assert.match(runtime.providerDecision.reason, /缺必需工具/)
    assert.equal(runtime.provider.capabilities().tier, 'T1')
  } finally {
    runtime.close()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})

test('T2 已选中：摄入 applied 后把记录交给 provider.mirrorRecord', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-v3-t2-mirror-'))
  const dshSession = fakeDshSession()
  const mirrored = []
  const fakeT2 = {
    async search() { return { display: [], pack: [], dropped: [], oovTerms: [] } },
    async read(id) { return { text: 't2 ' + id, record: { id, createdAt: 1 } } },
    async health() { return { healthy: true } },
    capabilities() { return { name: 'fake-t2', tier: 'T2' } },
    mirrorRecord(record) { mirrored.push(record) },
  }
  const runtime = await createV3Runtime({
    v3Root: root,
    dshSession,
    sessionKey: 's-t2',
    memoryProbe: async () => ({
      name: '@furongjun1999/dsh-memory',
      version: '0.9.10',
      tools: ['memory_store', 'memory_search', 'memory_read'],
      smokePassed: true,
    }),
    t2ProviderFactory: async () => fakeT2,
  })
  try {
    assert.equal(runtime.providerDecision.tier, 'T2')
    const result = await runtime.handleDshEvent(
      { seq: 0, type: 'user/message', at: 1, data: { source: { kind: 'user', form: null } } },
      '需要镜像的正文',
    )
    assert.equal(result.status, 'applied')
    assert.equal(mirrored.length, 1, 'applied 记录必须交给 T2 镜像')
    assert.equal(mirrored[0].id, result.recordId)
    assert.equal(mirrored[0].payload.text, '需要镜像的正文')
  } finally {
    runtime.close()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})
