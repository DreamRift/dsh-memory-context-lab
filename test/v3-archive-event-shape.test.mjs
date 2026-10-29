/**
 * 0.14.0-beta.44 事件形状根因守卫。
 *
 * 0.14.0-beta.43 的真实故障：candidates/steps 各抄一份 callIdOf，只认
 * data.callId / message.content[].callId；真实宿主 0.2.1-rc.3 的 tool/result
 * 把 callId 放在 data.message.toolCallId（以及 data.message.source.callId）。
 * 结果每个工具调用都「未完成」，按轮与按步归档同时失效（真实会话 76/76 步）。
 *
 * 这些用例故意使用**真实宿主形状**，不是旧夹具的 data.callId 简写。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { callIdOf, isHumanUserEvent, isRecallPackEvent, sourceFormOf, sourceKindOf } from '../src/v3/domain/archive/event-shape.mjs'
import { groupSurfaceOperations, selectArchiveSpan } from '../src/v3/domain/archive/candidates.mjs'
import { buildStepUnits } from '../src/v3/domain/archive/steps.mjs'

test('callIdOf：真实 tool/call 与 tool/result 形状都能取到同一个 callId', () => {
  const call = { seq: 2, type: 'tool/call', data: { callId: 'c1', name: 'read' } }
  const result = { seq: 3, type: 'tool/result', data: { message: { role: 'tool', toolCallId: 'c1', source: { kind: 'tool', callId: 'c1' }, content: [] } } }
  assert.equal(callIdOf(call), 'c1')
  assert.equal(callIdOf(result), 'c1')
  assert.equal(callIdOf({ data: { toolCallId: 'c2' } }), 'c2')
  assert.equal(callIdOf({ data: { message: { source: { callId: 'c3' } } } }), 'c3')
  assert.equal(callIdOf({ data: { message: { content: [{ callId: 'c4' }] } } }), 'c4', '旧夹具形状保留兼容')
  assert.equal(callIdOf({ data: {} }), null, '取不到就返回 null，不猜')
})

test('sourceKindOf / isRecallPackEvent：data.source 是真实落点', () => {
  const human = { type: 'user/message', data: { source: { kind: 'user' } } }
  const recall = { type: 'user/message', data: { source: { kind: 'dsh-memory-context-lab', form: 'recall' } } }
  assert.equal(sourceKindOf(human), 'user')
  assert.equal(sourceFormOf(recall), 'recall')
  assert.equal(isHumanUserEvent(human), true)
  assert.equal(isRecallPackEvent(recall), true)
  assert.equal(isRecallPackEvent(human), false)
})

test('按轮：真实 matched tool pair 不再被判「未完成」，整回合可选', () => {
  const events = [
    { seq: 0, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'do' }] } },
    { seq: 1, type: 'step/start', data: { turn: 1, step: 1 } },
    { seq: 2, type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{}' } },
    { seq: 3, type: 'tool/result', data: { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'c1', source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'text', text: 'result' }] } } },
    { seq: 4, type: 'step/end', data: { turn: 1, step: 1 } },
    { seq: 5, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'next' }] } },
    { seq: 6, type: 'step/start', data: { turn: 2, step: 1 } },
    { seq: 7, type: 'assistant/message', data: { turn: 2, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } } },
  ]
  const groups = groupSurfaceOperations({ surfaceNodes: [0, 2, 3, 5, 7], events })
  assert.equal(groups[0].hasUnfinished, false, 'result 必须闭合 call')
  const span = selectArchiveSpan({
    surfaceNodes: [0, 2, 3, 5, 7],
    events,
    hasRecord: () => true,
    mode: 'full-history',
    retainOperations: 5,
    lastArchiveEndSeq: -1,
    maxOperations: 1,
    pinnedSeqs: new Set(),
    minStartSeq: -1,
  })
  assert.ok(span, '完成的工具回合必须可归档')
  assert.equal(span.startSeq, 0)
  assert.equal(span.endSeq, 3)
  assert.deepEqual(span.recordSeqs, [0, 2, 3])
})

test('buildStepUnits：真实 tool/result 闭合后 hasUnfinished=false', () => {
  const events = [
    { seq: 1, type: 'step/start', data: { turn: 1, step: 1 } },
    { seq: 2, type: 'tool/call', data: { callId: 'c1' } },
    { seq: 3, type: 'tool/result', data: { message: { toolCallId: 'c1' } } },
    { seq: 4, type: 'step/end', data: { turn: 1, step: 1 } },
  ]
  const [unit] = buildStepUnits(events)
  assert.equal(unit.hasUnfinished, false)
})

/**
 * 0.14.0-beta.47：按轮归档的轮次判定可在「真人消息」与「DSH 轮次」之间切换。
 * 真实故障形状（会话 9513ac70）：一条真人指令 + 10 次目标自动继续，界面显示
 * 「14 轮 281 步」，但真人判定把 10 轮自动继续全部算进同一个当前回合 → 只压到 2 轮。
 */
test('按轮：DSH 轮次判定把目标自动继续的每一轮当一轮，真人判定只剩当前回合', () => {
  const events = [
    { seq: 0, type: 'turn/start', data: { turn: 1 } },
    { seq: 1, type: 'step/start', data: { turn: 1, step: 1 } },
    { seq: 2, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '真人指令' }] } },
    { seq: 3, type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: '第一轮分析' }] } } },
    { seq: 4, type: 'step/end', data: { turn: 1, step: 1 } },
    { seq: 5, type: 'turn/start', data: { turn: 2 } },
    { seq: 6, type: 'step/start', data: { turn: 2, step: 1 } },
    { seq: 7, type: 'user/message', data: { source: { kind: 'goal' }, content: [{ type: 'text', text: '目标自动继续' }] } },
    { seq: 8, type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: '第二轮分析' }] } } },
    { seq: 9, type: 'step/end', data: { turn: 2, step: 1 } },
  ]
  const surfaceNodes = [2, 3, 7, 8]
  const humanGroups = groupSurfaceOperations({ surfaceNodes, events })
  assert.equal(humanGroups.length, 1, '真人判定：goal 继续不是新回合')
  assert.equal(humanGroups[0].current, true)
  assert.equal(selectArchiveSpan({ surfaceNodes, events, hasRecord: () => true, mode: 'full-history' }), null,
    '真人判定下唯一回合就是当前回合，没有可归档内容')

  const dshGroups = groupSurfaceOperations({ surfaceNodes, events, turnBasis: 'dsh' })
  assert.deepEqual(dshGroups.map((group) => [group.turn, group.current]), [[1, false], [2, true]],
    'DSH 判定：两轮，只有第 2 轮是当前轮')
  const span = selectArchiveSpan({
    surfaceNodes, events, hasRecord: () => true, mode: 'full-history', turnBasis: 'dsh', maxOperations: 2,
  })
  assert.ok(span, '第 1 轮已完成，必须可归档')
  assert.deepEqual([span.startSeq, span.endSeq], [2, 3])
  assert.deepEqual(span.recordSeqs, [2, 3])
})

test('按轮：DSH 当前轮刚开、活动面还没有它的节点时，上一轮仍判为已完成', () => {
  const events = [
    { seq: 0, type: 'turn/start', data: { turn: 1 } },
    { seq: 1, type: 'step/start', data: { turn: 1, step: 1 } },
    { seq: 2, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '真人指令' }] } },
    { seq: 3, type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: '第一轮分析' }] } } },
    { seq: 4, type: 'step/end', data: { turn: 1, step: 1 } },
    { seq: 5, type: 'turn/start', data: { turn: 2 } },
    { seq: 6, type: 'step/start', data: { turn: 2, step: 1 } },
  ]
  const surfaceNodes = [2, 3]
  // 没有 payload.turn 时保守：最后一组算当前轮，先不压。
  assert.equal(groupSurfaceOperations({ surfaceNodes, events, turnBasis: 'dsh' })[0].current, true)
  // pre-step 明确告知「当前是第 2 轮」：第 1 轮已完成，可立即归档（不等第 2 轮产出节点）。
  const groups = groupSurfaceOperations({ surfaceNodes, events, turnBasis: 'dsh', currentTurn: 2 })
  assert.equal(groups[0].current, false)
  const span = selectArchiveSpan({ surfaceNodes, events, hasRecord: () => true, mode: 'full-history', turnBasis: 'dsh', currentTurn: 2 })
  assert.ok(span)
  assert.deepEqual([span.startSeq, span.endSeq], [2, 3])
})
