/**
 * M5.2 压缩摘要 + 遗忘级联：
 * - compact 回执带确定性首部摘要；restore 仍回全文；
 * - 遗忘该回执涉及记录 → 摘要被替换成无正文标记；undo → 回执还原、restore 恢复。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { attachV3Engine } from '../src/v3/entry/v3-entry.mjs'
import { createFakeSession } from './helpers/fake-session.mjs'

function fakeCtx() {
  const handlers = new Map()
  const ctx = {
    on(name, handler) { handlers.set(name, handler); return () => handlers.delete(name) },
    logger: { warn() {}, info() {} },
  }
  ctx.callPreStep = async (session) => {
    const handler = handlers.get('agent/pre-step')
    return await handler({ agent: { session }, signal: undefined }, async () => ({ kind: 'enter' }))
  }
  return ctx
}

async function settle(engine) {
  await new Promise((resolve) => setTimeout(resolve, 150))
  await engine._waitForIdle().catch(() => {})
  await new Promise((resolve) => setTimeout(resolve, 50))
}

test('compact：摘要进回执；遗忘级联清除；undo 还原', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-compact-'))
  const ctx = fakeCtx()
  const engine = attachV3Engine(ctx, { v3Root: root })
  try {
    const session = createFakeSession()
    session.pushUser('第一问：保留这段文字'.repeat(30))
    session.pushAssistant('第一答：也保留'.repeat(30))
    session.pushUser('当前问题'.repeat(10))
    await ctx.callPreStep(session)
    await settle(engine)

    const result = await engine.archiveForStep('session-fake', session, {}, { compact: true })
    assert.equal(result.status, 'archived', JSON.stringify(result))
    assert.match(result.receiptText, /摘要：/)
    assert.match(result.receiptText, /第一问/)
    const voucher = (await engine.historyOf('session-fake')).rows[0]
    assert.equal(voucher.summary, true)

    const target = result.recordIds[0]
    // D-D：pin 是用户意图，forget 不得删除；undo 后自然仍在。
    const pinsBefore = (await engine.pinRecords('session-fake', [target])).pins
    assert.deepEqual(pinsBefore, [target])
    const forgotten = await engine.forgetRecords('session-fake', [target])
    assert.equal(forgotten.redact.changed, 1, '隐私面级联必须报告实际清除段数')
    assert.deepEqual(engine.stateOf('session-fake').pins, pinsBefore, 'forget 不得删除 pin')
    assert.equal((await engine.historyOf('session-fake')).rows[0].redacted, true, '历史里必须标出正文已清除')
    const nodes = await session.surface.nodes
    const redacted = await session.textOf(nodes[0])
    assert.match(redacted, /已遗忘记录/)
    assert.doesNotMatch(redacted, /第一问/)

    const undone = await engine.forgetRecords('session-fake', [target], { undo: true })
    assert.equal(undone.unredact.changed, 1)
    assert.equal((await engine.historyOf('session-fake')).rows[0].redacted, false)
    assert.deepEqual(engine.stateOf('session-fake').pins, pinsBefore, 'undo 后 pin 仍在')
    const restoredReceipt = await session.textOf((await session.surface.nodes)[0])
    assert.match(restoredReceipt, /摘要：/)
    const restored = await engine.restoreHistory('session-fake', { index: 0 })
    assert.equal(restored.restored, true, JSON.stringify(restored))
    assert.match(await session.textOf((await session.surface.nodes)[0]), /第一问/)
  } finally {
    await engine._waitForIdle().catch(() => {})
    engine.dispose()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})