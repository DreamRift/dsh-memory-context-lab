/**
 * v2 回读层测试：精确 ID 回读（保真入口）、分页、token 预算装包、退热后再次召回。
 * 全部使用临时隔离库；验证的是读层语义，不是真实会话。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { V2SessionStore } from '../src/v2/store.mjs'
import {
  readRecordById,
  listRecordsPage,
  packWorkingSet,
} from '../src/v2/readback.mjs'
import { ensureLabRoot, sessionKeyFor } from '../src/storage.mjs'
import { recordId, recordsFromEvent, RECORD_KINDS } from '../src/v2/records.mjs'

const SESSION_ID = 'a1b2c3d4e5f6a7b8c9d0e1f2'

async function makeLabRoot(name) {
  const root = await mkdtemp(path.join(tmpdir(), `mclv2rb-${name}-`))
  await ensureLabRoot(root)
  return root
}

/** 一次完整操作：tool-call + tool/result（合法调用与结果成对）。 */
function callEvent(seq, callId, argsJson) {
  return {
    type: 'assistant/message',
    seq,
    data: { message: { id: `m${seq}`, content: [{ type: 'tool-call', id: callId, name: 'read', arguments: argsJson }] } },
  }
}

function resultEvent(seq, callId, text) {
  return {
    type: 'tool/result',
    seq,
    data: { message: { id: `m${seq}`, content: [{ type: 'text', text }], source: { callId } } },
  }
}

/** 预置若干完整操作；返回全部记录 ID（调用、结果交替）。 */
async function seedSession(root, { count = 6 } = {}) {
  const store = await V2SessionStore.init({ labRoot: root, sessionId: SESSION_ID })
  try {
    const txn = await store.openTransaction()
    const ids = []
    let seq = 1
    for (let i = 1; i <= count; i++) {
      const events = [
        callEvent(seq, `call_${i}`, `{"target":"f${i}"}`),
        resultEvent(seq + 1, `call_${i}`, `output of call ${i} ${'payload'.repeat(i * 4)}`),
      ]
      for (const event of events) {
        for (const draft of recordsFromEvent(event)) {
          await store.stageRecord(txn, draft)
        }
        seq += 1
      }
      while (ids.length < 2 * i) ids.push(recordId(txn.txn, ids.length))
    }
    await store.commitTransaction(txn)
    return ids
  } finally {
    await store.close()
  }
}

function payloadPath(labRoot, entry) {
  const hex = entry.payload.hash.slice('sha256:'.length)
  return path.join(path.resolve(labRoot), 'v2', 'sessions', sessionKeyFor(SESSION_ID), 'payloads', hex.slice(0, 2), hex)
}

test('回读：按稳定 ID 读回原文与 verified 标记', async () => {
  const root = await makeLabRoot('read')
  try {
    const ids = await seedSession(root, { count: 4 })
    const loaded = await readRecordById(root, SESSION_ID, ids[1])
    assert.equal(loaded.ok, true)
    assert.equal(loaded.verified, true)
    assert.equal(loaded.record.id, ids[1])
    assert.match(loaded.payloadText, /output of call 1/)
    assert.equal(loaded.integrity, 'ok')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('回读：未知 ID 抛 EREADNOTFOUND，非法 ID 抛 EINVAL', async () => {
  const root = await makeLabRoot('missing')
  try {
    await seedSession(root, { count: 2 })
    await assert.rejects(
      async () => readRecordById(root, SESSION_ID, 't00000009-r0001'),
      (error) => error.code === 'EREADNOTFOUND',
    )
    await assert.rejects(
      async () => readRecordById(root, SESSION_ID, 'garbage'),
      (error) => error.code === 'EINVAL',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('回读：载荷被篡改时抛 EPAYLOADHASH，不静默返回坏内容', async () => {
  const root = await makeLabRoot('tamper')
  try {
    const ids = await seedSession(root, { count: 2 })
    const store = await V2SessionStore.open({ labRoot: root, sessionId: SESSION_ID, readOnly: true })
    const entry = store.getEntry(ids[1])
    await store.close()
    await writeFile(payloadPath(root, entry), 'x'.repeat(entry.payload.size), 'utf8')

    await assert.rejects(
      async () => readRecordById(root, SESSION_ID, ids[1]),
      (error) => error.code === 'EPAYLOADHASH',
    )
    // 不校验哈希时返回内容：integrity 必须报 'unverified'（0.13.2-beta.2 起不再报
    // 'ok'——尺寸一致不等于校验通过），verified 必须为 false：两维都如实。
    const raw = await readRecordById(root, SESSION_ID, ids[1], { verifyHash: false })
    assert.equal(raw.integrity, 'unverified')
    assert.equal(raw.verified, false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('分页：稳定 ID 全序翻页、kinds 过滤、空页终止', async () => {
  const root = await makeLabRoot('page')
  try {
    const ids = await seedSession(root, { count: 6 })
    const seen = []
    let after = null
    let pages = 0
    for (;;) {
      const page = await listRecordsPage(root, SESSION_ID, { pageSize: 4, afterId: after })
      if (page.entries.length === 0) {
        assert.equal(page.hasNextPage, false)
        break
      }
      pages += 1
      seen.push(...page.entries.map((entry) => entry.id))
      if (!page.hasNextPage) break
      after = page.nextAfter
      assert.ok(pages < 20, '分页不得死循环')
    }
    assert.deepEqual(seen, ids)
    assert.equal(pages, 3)

    const callsOnly = await listRecordsPage(root, SESSION_ID, { pageSize: 2, afterId: null, kinds: [RECORD_KINDS.OPERATION_CALL] })
    assert.ok(callsOnly.entries.every((entry) => entry.kind === RECORD_KINDS.OPERATION_CALL))
    assert.equal(callsOnly.total, 6)
    assert.equal(callsOnly.hasNextPage, true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('装包：显式 ID 优先、预算内附载荷、预算不足显式报告不静默截断', async () => {
  const root = await makeLabRoot('pack')
  try {
    const ids = await seedSession(root, { count: 5 })
    const pack = await packWorkingSet(root, SESSION_ID, {
      budgetTokens: 20_000,
      explicitRecordIds: [ids[0], ids[3]],
    })
    assert.equal(pack.entries[0].id, ids[0])
    assert.equal(pack.entries[1].id, ids[3])
    assert.equal(pack.entries[0].payloadIncluded, true)
    assert.ok(pack.usedTokens > 0 && pack.usedTokens <= 20_000)
    assert.deepEqual(pack.openCalls, [])
    // 其余记录按稳定 ID 逆序（最新优先）装头部。
    assert.equal(pack.entries[2].id, ids[ids.length - 1])

    const tight = await packWorkingSet(root, SESSION_ID, {
      budgetTokens: 10,
      explicitRecordIds: [ids[1]],
    })
    // 头部保留，载荷放不下时显式 deferred 警告，不丢弃显式请求。
    assert.ok(tight.entries.some((entry) => entry.id === ids[1] && !entry.payloadIncluded))
    assert.ok(tight.warnings.some((line) => line.startsWith(`payload-deferred:${ids[1]}`)))

    const missing = await packWorkingSet(root, SESSION_ID, {
      budgetTokens: 2_000,
      explicitRecordIds: ['t00000009-r0001'],
    })
    assert.ok(missing.warnings.some((line) => line.startsWith('explicit-missing:t00000009-r0001')))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('退热后再次召回：重开会话（模拟已退出热上下文）后旧 ID 仍可读回原文', async () => {
  const root = await makeLabRoot('recall')
  try {
    const ids = await seedSession(root, { count: 3 })
    // 模拟退役：关闭句柄、重开只读实例再按 ID 召回。
    const again = await readRecordById(root, SESSION_ID, ids[5])
    assert.equal(again.verified, true)
    assert.match(again.payloadText, /output of call 3/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
