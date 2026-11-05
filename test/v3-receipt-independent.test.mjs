/**
 * 回执独立（AUD51-05-02，0.14.0-beta.53）——停用「回执吸收」后每张凭证都能 restore。
 *
 * ## 缺陷
 * beta.51 的 B3-11 让新归档吃掉紧邻的旧回执（一进一出），活动面恒只留最新一张回执。
 * 而 restore 定位节点的判据是「回执正文在活动面**逐字节相等**」——旧回执正文已经
 * 从模型可见面消失，于是 restore <旧序号> 恒回 receipt-changed、restore all 只恢复
 * 最新一轮（审计实测 1/5；本会话样本 v-3454 被 v-3473 吸收）。
 *
 * ## 修法（用户拍板 A）
 * 停用吸收：每轮归档各留一张独立回执，span 严格等于本次选中的组。
 *
 * ## 断言组
 * - 单元：前驱回执不进 span（起点不前移）、pin/回注包行为不变；
 * - 步骤级：span 从回执之后开始，回执不进 recordSeqs；
 * - e2e：连续归档 3 轮 → 活动面 3 张回执、3 张凭证，**每张凭证都能 restore**
 *   （这是本缺陷的正向判据，不是「最新一张能恢复」）；
 * - 回执独立后依然不破坏边界：pin 住的节点仍挡住归档。
 *
 * ## 不适用条件与已知边界
 * 活动面会随归档轮数累积回执（每张约 200 字，且不会被再次归档）。这是方案 A 的
 * 已知成本，不是缺陷：换回来的是「凭证 ↔ 可恢复」一一对应。
 *
 * ## 定点变异自证
 * 把 absorbPrecedingReceipts 加回 selectArchiveSpan → 第 1 轮用例必红（startSeq 前移）；
 * 把 restore 的正文定位改回「只认最新一张」→ e2e 的两张旧凭证必红。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { selectArchiveSpan } from '../src/v3/domain/archive/candidates.mjs'
import { selectStepSpan } from '../src/v3/domain/archive/steps.mjs'
import { attachV3Engine } from '../src/v3/entry/v3-entry.mjs'
import { createFakeSession } from './helpers/fake-session.mjs'

const SURFACE_FORM = 'memory-lab3-surface'
const OWN_KIND = 'dsh-memory-context-lab'

function receiptEvent(seq, tag) {
  return { seq, type: 'user/message', data: { source: { kind: OWN_KIND, form: SURFACE_FORM }, content: [{ type: 'text', text: '回执' + tag }] } }
}

function humanEvent(seq, text) {
  return { seq, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } }
}

function assistantEvent(seq, text) {
  return { seq, type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text }] } } }
}

test('回合级：前驱回执不进 span（起点不前移）', () => {
  // 真实形状：回执替换了上一段后落在下一轮第一个节点之前。
  const events = [
    receiptEvent(0, 'r1'),
    humanEvent(1, '第一轮'),
    assistantEvent(2, '第一轮输出'),
    humanEvent(3, '第二轮'),
    assistantEvent(4, '第二轮输出'),
  ]
  const span = selectArchiveSpan({ surfaceNodes: [0, 1, 2, 3, 4], events, hasRecord: (seq) => seq >= 1, mode: 'full-history', lastArchiveEndSeq: 0 })
  assert.equal(span.startSeq, 1, '起点是本轮第一个节点，不回吞前一张回执')
  assert.deepEqual(span.sourceEventSeqs, [1, 2])
  assert.deepEqual(span.recordSeqs, [1, 2])
  assert.equal(span.endSeq, 2, 'maxOperations=1：只选第一组')
  assert.equal(span.operations, 1, '回合数按选中的组计数')
})

test('边界：pin 仍挡住归档；回注包不进 span 也不需要记录', () => {
  const plain = [humanEvent(0, '第一轮'), assistantEvent(1, '输出'), humanEvent(2, '第二轮'), assistantEvent(3, '输出2')]
  const spanPlain = selectArchiveSpan({ surfaceNodes: [0, 1, 2, 3], events: plain, hasRecord: () => true, mode: 'full-history', lastArchiveEndSeq: -1 })
  assert.deepEqual(spanPlain.sourceEventSeqs, [0, 1])
  // pin 掉本轮第一个节点 → 整组挡死（不做切半个操作）
  const pinned = selectArchiveSpan({ surfaceNodes: [0, 1, 2, 3], events: plain, hasRecord: () => true, pinnedSeqs: new Set([0]), mode: 'full-history', lastArchiveEndSeq: -1 })
  assert.equal(pinned, null, '被 pin 的组不能被归档')
  // 回注包：透明节点，不进 span、不需要记录
  const recall = { seq: 0, type: 'user/message', data: { source: { kind: OWN_KIND, form: 'recall' }, content: [{ type: 'text', text: '回注包' }] } }
  const eventsRecall = [recall, humanEvent(1, '第一轮'), assistantEvent(2, '输出'), humanEvent(3, '第二轮'), assistantEvent(4, '输出2')]
  const spanRecall = selectArchiveSpan({ surfaceNodes: [0, 1, 2, 3, 4], events: eventsRecall, hasRecord: (seq) => seq >= 1, mode: 'full-history', lastArchiveEndSeq: -1 })
  assert.equal(spanRecall.startSeq, 1, '回注包不进 span')
})

test('步骤级：上一张回执不再被吸收，span 从它之后开始', () => {
  const events = [
    { seq: 0, type: 'step/start', data: { turn: 1, step: 1 } },
    assistantEvent(1, '步骤1'),
    { seq: 2, type: 'step/end', data: { turn: 1, step: 1 } },
    { seq: 3, type: 'step/start', data: { turn: 1, step: 2 } },
    assistantEvent(4, '步骤2'),
    { seq: 5, type: 'step/end', data: { turn: 1, step: 2 } },
    receiptEvent(6, 'r1'),
    { seq: 7, type: 'step/start', data: { turn: 1, step: 3 } },
    assistantEvent(8, '步骤3'),
    { seq: 9, type: 'step/end', data: { turn: 1, step: 3 } },
    { seq: 10, type: 'step/start', data: { turn: 1, step: 4 } },
    assistantEvent(11, '步骤4'),
    { seq: 12, type: 'step/end', data: { turn: 1, step: 4 } },
  ]
  // 本用例钉回执边界，不测攒批节奏：批量阈值取 1，避免默认 10 的等待掩盖边界断言。
  const span = selectStepSpan({ surfaceNodes: [6, 8, 11], events, hasRecord: (seq) => seq !== 6, retainSteps: 1, maxSteps: 3, batchSteps: 1 })
  assert.ok(span, '可选到步骤 3')
  assert.equal(span.startSeq, 8, '起点是步骤 3 的记录节点，不含上一张回执')
  assert.deepEqual(span.sourceEventSeqs, [8])
  assert.deepEqual(span.recordSeqs, [8])
})

test('e2e：连续归档 3 轮后活动面 3 张回执，且每张凭证都能 restore', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-v3-receipt-independent-'))
  const handlers = new Map()
  const ctx = {
    warnings: [],
    on(name, handler) { handlers.set(name, handler); return () => handlers.delete(name) },
    logger: { warn() {}, info() {} },
  }
  ctx.preStep = async (session) => handlers.get('agent/pre-step')({ agent: { session }, signal: undefined }, async () => ({ kind: 'enter' }))
  const engine = attachV3Engine(ctx, { v3Root: root })
  const id = 's-independent'
  try {
    const session = createFakeSession({ id })
    session.pushContextWindow(1000000)
    for (let round = 1; round <= 4; round += 1) {
      session.pushUser('第 ' + round + ' 轮指令 ' + '内容'.repeat(120) + ' #' + round)
      session.pushAssistant('第 ' + round + ' 轮输出 ' + '结果'.repeat(120) + ' #' + round)
    }
    await ctx.preStep(session)
    await engine._waitForIdle()
    let archived = 0
    for (let i = 0; i < 8; i += 1) {
      const result = await engine.archiveForStep(id, session, {})
      if (result?.status === 'archived') archived += 1
    }
    assert.equal(archived, 3, '三个已完成轮各归档一次（实测 ' + archived + '）')
    const receiptNodes = session.surface.nodes.filter((seq) => session.eventAt(seq)?.data?.source?.form === SURFACE_FORM)
    assert.equal(receiptNodes.length, 3, '每轮一张独立回执（实测 ' + receiptNodes.length + ' 张）')
    const history = await engine.historyOf(id)
    assert.equal(history.total, 3, '凭证 3 条')

    // 正判据：逐张恢复都要成功。旧实现（吸收）在这里恒回 receipt-changed，
    // 只有最新一张能过——这条断言就是本缺陷的反向证据。
    for (let index = 0; index < history.rows.length; index += 1) {
      const restored = await engine.restoreHistory(id, { index })
      assert.equal(restored.restored, true, '第 ' + index + ' 张凭证必须可恢复：' + JSON.stringify(restored))
      assert.notEqual(restored.reason, 'receipt-changed', '第 ' + index + ' 张不得报 receipt-changed')
    }
    // 恢复后活动面已被原文替换，restore all 对已恢复的段会跳；这里换一个新会话验证「全部」。
    const all = await engine.restoreHistory(id, { index: null })
    assert.equal(all.restored + all.skipped + all.forgotten, all.total, '三桶必须配平：' + JSON.stringify(all))
    assert.equal(all.total, 3)
  } finally {
    await engine._waitForIdle().catch(() => {})
    engine.dispose()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})

test('守卫：连续归档两张凭证，第二张回执必须带「回合数：N。」（AUD51-09-01）', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-v3-receipt-turns-'))
  const handlers = new Map()
  const ctx = {
    warnings: [],
    on(name, handler) { handlers.set(name, handler); return () => handlers.delete(name) },
    logger: { warn() {}, info() {} },
  }
  ctx.preStep = async (session) => handlers.get('agent/pre-step')({ agent: { session }, signal: undefined }, async () => ({ kind: 'enter' }))
  const engine = attachV3Engine(ctx, { v3Root: root })
  const id = 's-turns'
  try {
    const session = createFakeSession({ id })
    session.pushContextWindow(1000000)
    for (let round = 1; round <= 4; round += 1) {
      session.pushUser('第 ' + round + ' 轮指令 ' + '内容'.repeat(120) + ' #' + round)
      session.pushAssistant('第 ' + round + ' 轮输出 ' + '结果'.repeat(120) + ' #' + round)
    }
    await ctx.preStep(session)
    await engine._waitForIdle()
    const rows = []
    for (let i = 0; i < 6 && rows.length < 2; i += 1) {
      const result = await engine.archiveForStep(id, session, {})
      if (result?.status === 'archived') rows.push(result)
    }
    assert.equal(rows.length, 2, '两次归档都要成功（实测 ' + rows.length + '）')
    for (const row of rows) {
      assert.match(row.receiptText, /回合数：\d+。/, '回执必须写回合数：' + row.receiptText)
    }
    assert.equal(rows[1].receiptText.includes('回合数：0'), false, '回合数不得是 0')
  } finally {
    await engine._waitForIdle().catch(() => {})
    engine.dispose()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})
