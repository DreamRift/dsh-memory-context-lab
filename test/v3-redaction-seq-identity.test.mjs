/**
 * P1-08（0.15.1）：`redact`/`unredact` 用正文定位 → 多段被清后 undo 张冠李戴。
 *
 * ## 缺陷
 * 已清除回执在活动面上都是**同一个常量串** `REDACTED_RECEIPT`。`unredact(index)` 用
 * 「正文逐字节相等」找节点——两块都被清后，undo #1 找到的是 #0 的槽位，于是把 #1 的正文
 * 写进 #0 的位置：**顺序与内容互换**，而 `history` 两行都显示 `redacted:false`，观察面
 * 看不出来。隐私面 + 恢复出错内容，是最难被发现的一类。
 *
 * ## 判据来源
 * docs/dev-0.15.1/记忆上下文-0.15.1-独立排查报告.md §1★5 / §3.1 P1-08；
 * 用户裁定（2026-11-04）：全部按顺序修，根因修复。
 *
 * ## 修法
 * 清除时把 `surfaceOp(replace)` 返回的**新节点 seq** 落进 `redactions.jsonl`（`seq` 字段）；
 * undo 按 seq 定位并复核该节点正文仍是清除标记（被宿主压缩/改写就失败关闭）。
 * 老账本没有 seq：只有「当前恰好只剩这一张已清除回执」时映射才无歧义，否则
 * 返回 `redaction-seq-missing`——宁可 undo 不成立，也不写到错位置。
 *
 * ## 断言组
 * 1. 两段都清后先 undo #1：A 的槽位仍是清除态、B 的正文落在 B 的槽位（旧实现整段互换）；
 * 2. 再 undo #0：两个槽位各自拿回**自己的**正文，历史 `redacted` 全为 false；
 * 3. 老账本（无 seq）语义：`redactionSeqOf` 返回 null；补记 seq 后返回该 seq。
 *
 * ## 不适用条件与已知边界
 * - seq 定位后仍要求正文逐字节等于清除标记：宿主压缩改写过的节点会 `receipt-changed`
 *   失败关闭（不覆盖用户的现内容）；
 * - 老账本多张同时被清时 undo 不成立（`redaction-seq-missing`），需要在补记 seq 后再用。
 *
 * ## 定点变异自证
 * 把 unredactVoucher 换回「按 REDACTED_RECEIPT 正文扫描」→ 第 1 条必红（顺序互换）；
 * 去掉 `markVoucherRedacted(..., { seq })` 的 seq → 第 1 条同样必红（走老账本歧义分支）。
 * 读数见台账 R1。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { attachV3Engine } from '../src/v3/entry/v3-entry.mjs'
import { openV3SessionStore } from '../src/v3/adapters/storage/session-store.mjs'
import { createFakeSession } from './helpers/fake-session.mjs'

const REDACTED = /该回执涉及已遗忘记录/

function fakeCtx() {
  const handlers = new Map()
  const ctx = {
    on(name, handler) { handlers.set(name, handler); return () => handlers.delete(name) },
    logger: { warn() {}, info() {} },
    effect(fn) { const disposer = fn(); return () => { if (typeof disposer === 'function') disposer() } },
    inject() { return { dispose() {} } },
  }
  ctx.callPreStep = async (session) => {
    const handler = handlers.get('agent/pre-step')
    if (!handler) throw new Error('未注册 pre-step')
    return await handler({ agent: { session }, signal: undefined }, async () => ({ kind: 'enter' }))
  }
  return ctx
}

/** 两个独立归档段（各自一张凭证、各自一块活动面回执）。 */
async function twoVouchers(engine, ctx, session) {
  session.pushUser('第一段问：甲甲甲甲'.repeat(20))
  session.pushAssistant('第一段答：乙乙乙乙'.repeat(20))
  session.pushUser('第二段问：丙丙丙丙'.repeat(20))
  session.pushAssistant('第二段答：丁丁丁丁'.repeat(20))
  await ctx.callPreStep(session)
  await engine._waitForIdle()
  const first = await engine.archiveForStep('session-fake', session, {}, {})
  assert.equal(first.status, 'archived', JSON.stringify(first))
  session.pushUser('第三段问：戊戊戊戊'.repeat(20))
  session.pushAssistant('第三段答：己己己己'.repeat(20))
  await ctx.callPreStep(session)
  await engine._waitForIdle()
  const second = await engine.archiveForStep('session-fake', session, {}, {})
  assert.equal(second.status, 'archived', JSON.stringify(second))
  return { first, second }
}

const textsOf = async (session) => {
  const nodes = await session.surface.nodes
  const out = []
  for (const seq of nodes) out.push(await session.textOf(seq))
  return out
}

test('P1-08 两段都清后先 undo #1：正文不得写进 #0 的槽位', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-p108-'))
  const ctx = fakeCtx()
  const engine = attachV3Engine(ctx, { v3Root: root })
  try {
    const session = createFakeSession()
    const { first, second } = await twoVouchers(engine, ctx, session)

    assert.equal((await engine.forgetRecords('session-fake', first.recordIds)).redact.changed, 1)
    assert.equal((await engine.forgetRecords('session-fake', second.recordIds)).redact.changed, 1)
    const redactedTexts = await textsOf(session)
    const redactedIndexes = redactedTexts.map((text, index) => (REDACTED.test(text) ? index : -1)).filter((index) => index >= 0)
    assert.equal(redactedIndexes.length, 2, '两块回执都必须被清除：' + JSON.stringify(redactedTexts.map((t) => t.slice(0, 20))))

    const undoSecond = await engine.forgetRecords('session-fake', second.recordIds, { undo: true })
    assert.equal(undoSecond.unredact.changed, 1, JSON.stringify(undoSecond.unredact))
    const afterOne = await textsOf(session)
    const stillRedacted = afterOne.findIndex((text) => REDACTED.test(text))
    const secondAt = afterOne.findIndex((text) => text === second.receiptText)
    assert.ok(stillRedacted >= 0, 'undo #1 之后仍应有一块是清除态（#0）')
    assert.ok(secondAt >= 0, 'undo #1 之后必须能看到 #1 的正文')
    assert.ok(stillRedacted < secondAt, '被清除的必须是 #0（更早的段）：旧实现把 #1 的正文写进 #0 的槽位，顺序会反过来')

    const undoFirst = await engine.forgetRecords('session-fake', first.recordIds, { undo: true })
    assert.equal(undoFirst.unredact.changed, 1)
    const finalTexts = await textsOf(session)
    assert.equal(finalTexts[stillRedacted], first.receiptText, '#0 槽位必须拿回 #0 的正文')
    assert.equal(finalTexts[secondAt], second.receiptText, '#1 槽位必须拿回 #1 的正文')
    const history = await engine.historyOf('session-fake')
    assert.deepEqual(history.rows.map((row) => row.redacted), [false, false], '两段都应显示已还原')
  } finally {
    await engine._waitForIdle().catch(() => {})
    engine.dispose()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})

test('P1-08 老账本（无 seq）：redactionSeqOf 返回 null；补记 seq 后可定位', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-p108-legacy-'))
  const store = await openV3SessionStore(root, 'legacy')
  try {
    const first = await store.markVoucherRedacted('v-3', true)
    assert.equal(first.changed, true)
    assert.equal(store.redactionSeqOf('v-3'), null, '老账本行没有 seq → 必须如实返回 null（调用方失败关闭）')
    const patched = await store.markVoucherRedacted('v-3', true, { seq: 42 })
    assert.equal(patched.changed, true, '已清除时补记 seq 必须可行（升级路径）')
    assert.equal(store.redactionSeqOf('v-3'), 42)
    await store.markVoucherRedacted('v-3', false)
    assert.equal(store.redactionSeqOf('v-3'), null, '还原后不得再报旧 seq')
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})
