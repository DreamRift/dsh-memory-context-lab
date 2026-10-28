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
