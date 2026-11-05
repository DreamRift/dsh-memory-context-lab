/**
 * H4（2026-11-04 独立审计）：遗忘语义必须显式区分「逻辑遗忘」与「物理清除」。
 *
 * 旧实现只有逻辑遗忘，命令面却显示「隐私面：N 段回执已清除」，读起来像正文已经删掉；
 * 实际 records/*.json 完整留盘，删掉 forgotten.jsonl 就能重新可见。
 *
 * 本套件锁住新语义：
 * - `forget`：读面/检索/导出不可见，**文件保留**（undo 可恢复）——既有合同不变；
 * - `purge`：文件删除、从已提交集移除、重开后库仍 healthy（清除不算账实不符）、
 *   undo 明确拒绝、摘要派生物一并删除。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createV3Runtime } from '../src/v3/composition/composition.mjs'
import { attachV3Engine } from '../src/v3/entry/v3-entry.mjs'
import { openV3SessionStore } from '../src/v3/adapters/storage/session-store.mjs'
import { createFakeSession } from './helpers/fake-session.mjs'
import { textOfDshEvent } from '../src/v3/entry/v3-entry.mjs'

async function ingest(runtime, session) {
  await runtime.handleDshEventBatch(session.log.map((event) => ({ event, text: textOfDshEvent(event), meta: {} })))
}

test('H4 forget 保留正文、purge 真正删除，且重开后库仍 healthy', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-purge-'))
  const session = createFakeSession()
  session.pushUser('可以被物理清除的第一句')
  session.pushAssistant('可以被物理清除的第一答')
  const runtime = await createV3Runtime({ v3Root: root, dshSession: session, sessionKey: 's-purge' })
  try {
    await ingest(runtime, session)
    const ids = await runtime.store.listRecordIds()
    assert.equal(ids.length, 2)
    const [target, other] = ids
    const recordPath = path.join(runtime.store.directory, 'records', target + '.json')

    // 逻辑遗忘：文件仍在（undo 依赖它）。
    await runtime.store.forget([target])
    await stat(recordPath)
    await runtime.store.revokeForget([target])
    assert.ok((await runtime.store.readRecord(target)).payload.text.includes('物理清除'))

    // 物理清除：文件消失、读不到、不可撤销。
    const purged = await runtime.store.purge([target])
    assert.equal(purged.purgedCount, 1)
    await assert.rejects(() => stat(recordPath), (error) => error.code === 'ENOENT')
    await assert.rejects(() => runtime.store.readRecord(target), (error) => error.code === 'EFORGOTTEN')
    await assert.rejects(() => runtime.store.revokeForget([target]), (error) => error.code === 'ESTORE_TXN_CONFLICT')
    assert.deepEqual(runtime.store.listPurged(), [target])
    assert.deepEqual(await runtime.store.listRecordIds(), [other])

    // 重开：purged 的 commit 行没有 payload，必须被识别为合法缺失，而不是 ESTORE_DAMAGED。
    runtime.store.close()
    const reopened = await openV3SessionStore(root, 's-purge')
    try {
      assert.equal(reopened.health().healthy, true, 'purge 不得让账本变成「账实不符」')
      assert.equal(reopened.health().recordCount, 1)
      assert.deepEqual(reopened.listPurged(), [target])
      await assert.rejects(() => reopened.readRecord(target), (error) => error.code === 'EFORGOTTEN')
    } finally {
      reopened.close()
    }
  } finally {
    runtime.close()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})

function fakeCtx() {
  const handlers = new Map()
  const ctx = {
    on(name, handler) { handlers.set(name, handler); return () => handlers.delete(name) },
    logger: { warn() {}, info() {} },
  }
  ctx.callPreStep = async (session) => {
    const handler = handlers.get('agent/pre-step')
    if (!handler) throw new Error('未注册 pre-step')
    return await handler({ agent: { session }, signal: undefined }, async () => ({ kind: 'enter' }))
  }
  return ctx
}

test('H4 engine purge：导出不含正文，purge 后 undo 明确拒绝', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-purge-engine-'))
  const ctx = fakeCtx()
  const engine = attachV3Engine(ctx, { v3Root: root, defaultEnabled: true })
  const session = createFakeSession({ id: 's-purge-engine' })
  try {
    session.pushUser('purge 导出检查的正文')
    await ctx.callPreStep(session)
    await new Promise((resolve) => setTimeout(resolve, 150))
    await engine._waitForIdle().catch(() => {})
    // 记录 ID 从当前工作集拿（公开只读面，不碰内部字段）。
    const working = await engine.workingSet('s-purge-engine')
    const target = working.rows[0]?.recordId
    assert.equal(typeof target, 'string', '需要一条已摄入记录')
    const purged = await engine.forgetRecords('s-purge-engine', [target], { purge: true })
    assert.equal(purged.purged, true, JSON.stringify(purged))
    const undone = await engine.forgetRecords('s-purge-engine', [target], { undo: true })
    assert.equal(undone.error, 'purged')
    const exported = await engine.exportSession('s-purge-engine')
    assert.equal(exported.counts.records, 0, 'purge 后导出不得包含正文')
  } finally {
    await engine._waitForIdle().catch(() => {})
    engine.dispose()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})

test('H4 跨句柄 purge：另一句柄读已清除记录必须是 EFORGOTTEN（不是“损坏”）', async () => {
  const { createSessionStorePort } = await import('../src/v3/adapters/storage/session-store-port.mjs')
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-purge-cross-'))
  const a = await createSessionStorePort(root, 's-purge-cross')
  const b = await createSessionStorePort(root, 's-purge-cross')
  try {
    const record = {
      id: 'v3r-' + 'ab'.repeat(8),
      kind: 'operation',
      sessionKey: 's-purge-cross',
      createdAt: 1,
      payload: { text: '跨句柄清除检查', bytes: Buffer.byteLength('跨句柄清除检查', 'utf8') },
      provenance: { sourceEventId: 'evt-1', sourceForm: 'tool/result', transactionId: 'tx-1' },
    }
    await a.port.transaction([record], { at: 1 })
    // b 先读一次（建立正缓存/内存视图），随后 a 清除
    assert.match((await b.port.readRecord(record.id)).payload.text, /跨句柄/)
    await a.port.purge([record.id])
    await assert.rejects(() => b.port.readRecord(record.id), (error) => error.code === 'EFORGOTTEN')
    assert.deepEqual(await b.port.listRecordIds(), [])
  } finally {
    a.port.close()
    b.port.close()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})
