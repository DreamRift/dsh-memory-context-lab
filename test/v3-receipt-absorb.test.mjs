/**
 * B3-11（AUD50-05-01）回执一进一出——选中 span 前紧邻的连续回执被吸收进本次
 * replace（transient：进 sourceEventSeqs、不进 recordSeqs），活动面恒只留最新一张
 * 回执；pin/回注包不吸收；凭证记账不变，被吸收回执的恢复如实记 skipped。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { selectArchiveSpan, absorbPrecedingReceipts } from '../src/v3/domain/archive/candidates.mjs'
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

test('B3-11 回合级：连续前驱回执被吸收（不进 recordSeqs、起点前移）', () => {
  // 真实形状：回执替换了上一段后落在下一轮第一个节点之前；human 分组里最后一组恒为
  // 当前轮，所以可归档的是倒数第二个回合（第一轮）。
  const events = [
    receiptEvent(0, 'r1'),
    humanEvent(1, '第一轮'),
    assistantEvent(2, '第一轮输出'),
    humanEvent(3, '第二轮'),
    assistantEvent(4, '第二轮输出'),
  ]
  const surfaceNodes = [0, 1, 2, 3, 4]
  const span = selectArchiveSpan({ surfaceNodes, events, hasRecord: (seq) => seq >= 1, mode: 'full-history', lastArchiveEndSeq: 0 })
  assert.equal(span.startSeq, 0, '起点前移吸收旧回执')
  assert.deepEqual(span.sourceEventSeqs, [0, 1, 2])
  assert.deepEqual(span.recordSeqs, [1, 2], '吸收的回执不进 recordSeqs')
  assert.equal(span.endSeq, 2, 'maxOperations=1：只选第一组')
})

test('B3-11 边界：非回执前驱不吸收；pin 回执停在 pin；回注包不吸收', () => {
  // 前驱是普通用户消息 → 不吸收（两组完成轮，选第一组）
  const plain = [humanEvent(0, '第一轮'), assistantEvent(1, '输出'), humanEvent(2, '第二轮'), assistantEvent(3, '输出2')]
  const spanPlain = selectArchiveSpan({ surfaceNodes: [0, 1, 2, 3], events: plain, hasRecord: () => true, mode: 'full-history', lastArchiveEndSeq: -1 })
  assert.equal(spanPlain.startSeq, 0, '无回执可吸收')
  assert.deepEqual(spanPlain.sourceEventSeqs, [0, 1])
  // pin 住紧邻回执 → 吸收在 pin 处停（被 pin 的回执不被吸收，span 从它之后开始）
  const withPin = [receiptEvent(0, 'r1'), receiptEvent(1, 'r2'), humanEvent(2, '第一轮'), assistantEvent(3, '输出'), humanEvent(4, '第二轮'), assistantEvent(5, '输出2')]
  const base = { hasRecord: (seq) => seq >= 2, mode: 'full-history', lastArchiveEndSeq: 1 }
  const spanPin = selectArchiveSpan({ surfaceNodes: [0, 1, 2, 3, 4, 5], events: withPin, pinnedSeqs: new Set([1]), ...base })
  assert.equal(spanPin.startSeq, 2, '被 pin 的回执不被吸收')
  assert.deepEqual(spanPin.sourceEventSeqs, [2, 3])
  const spanNoPin = selectArchiveSpan({ surfaceNodes: [0, 1, 2, 3, 4, 5], events: withPin, ...base })
  assert.equal(spanNoPin.startSeq, 0, '无 pin 时两张回执全吸收')
  // 回注包不吸收
  const recall = { seq: 0, type: 'user/message', data: { source: { kind: OWN_KIND, form: 'recall' }, content: [{ type: 'text', text: '回注包' }] } }
  const eventsRecall = [recall, humanEvent(1, '第一轮'), assistantEvent(2, '输出'), humanEvent(3, '第二轮'), assistantEvent(4, '输出2')]
  const spanRecall = selectArchiveSpan({ surfaceNodes: [0, 1, 2, 3, 4], events: eventsRecall, hasRecord: (seq) => seq >= 1, mode: 'full-history', lastArchiveEndSeq: -1 })
  assert.equal(spanRecall.startSeq, 1, '回注包不吸收（一次性注入，不进 span）')
})

test('B3-11 步骤级：上一张回执吸收进下一次 span', () => {
  // 真实形状：按步归档的回执落在上一段 step/end 与下一个 step/start 之间（步间），
  // 不属于任何步骤单元；下一次选择从下一个完整步骤拼 span，回执是它的紧邻前驱。
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
  const surfaceNodes = [6, 8, 11]
  const span = selectStepSpan({ surfaceNodes, events, hasRecord: (seq) => seq !== 6, retainSteps: 1, maxSteps: 3 })
  assert.ok(span, '可选到步骤 3')
  assert.equal(span.startSeq, 6, '吸收上一张回执后起点=回执')
  assert.deepEqual(span.sourceEventSeqs, [6, 8])
  assert.deepEqual(span.recordSeqs, [8], '回执不进 recordSeqs')
})

test('B3-11 e2e：连续 4 轮归档后活动面只有 1 张回执；历史 3 条；恢复路径可用', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-v3-receipt-absorb-'))
  const handlers = new Map()
  const ctx = {
    warnings: [],
    on(name, handler) { handlers.set(name, handler); return () => handlers.delete(name) },
    logger: { warn() {}, info() {} },
  }
  ctx.preStep = async (session) => handlers.get('agent/pre-step')({ agent: { session }, signal: undefined }, async () => ({ kind: 'enter' }))
  const engine = attachV3Engine(ctx, { v3Root: root })
  const id = 's-absorb'
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
    for (let i = 0; i < 6; i += 1) {
      const result = await engine.archiveForStep(id, session, {})
      if (result?.status === 'archived') archived += 1
    }
    assert.equal(archived, 3, '三个已完成轮各归档一次（实测 ' + archived + '）')
    const receiptNodes = session.surface.nodes.filter((seq) => session.eventAt(seq)?.data?.source?.form === SURFACE_FORM)
    assert.equal(receiptNodes.length, 1, '一进一出：活动面恒 1 张回执（实测 ' + receiptNodes.length + ' 张）')
    assert.equal((await engine.historyOf(id)).total, 3, '凭证 3 条（记账语义不变）')
    // 恢复路径可用：最新凭证的回执正文在面上逐字节可查（restore 的锚点判据）
    const history = await engine.historyOf(id)
    const newest = history.rows?.[history.rows.length - 1] ?? history.rows?.[0]
    const newestText = typeof newest?.receiptText === 'string' ? newest.receiptText : null
    if (newestText !== null) {
      const onSurface = session.surface.nodes.some((seq) => session.textOf(seq) === newestText)
      assert.equal(onSurface, true, '最新回执正文在活动面上（恢复锚点在）')
    }
  } finally {
    await engine._waitForIdle().catch(() => {})
    engine.dispose()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})
