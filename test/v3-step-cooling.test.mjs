/**
 * 普通降温 = 步骤级实时压缩（beta.40）。
 *
 * 与全历史（回合级）的分工：
 * - full-history：只压已完成回合，当前回合永不归档（长程多轮）；
 * - cooling：在当前回合内压掉已完成、且不在工作集里的步骤（长步数少轮）。
 *
 * 钉住的判据（失败关闭）：
 * 1. 只压完整步骤（step/start…step/end）；
 * 2. 最近 retainSteps 步保留（模型刚用过的结果不能撤）；
 * 3. 不跨回合（用户消息是锚点，不能被卷进 span）；
 * 4. 未完成 tool 对 / 插件回执 / pin 是整步边界；回注包透明（同回合级口径）；
 * 5. span 必须在活动面上密集连续，recordSeqs 不含回注包。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { buildStepUnits, selectStepSpan } from '../src/v3/domain/archive/steps.mjs'

const hasRecord = () => true

/** 一步占 3 个 seq：start / 一个业务事件 / end。 */
function step(turn, index, start, business = null) {
  return [
    { seq: start, type: 'step/start', data: { turn, step: index } },
    business ?? { seq: start + 1, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'a' + (start + 1) }] } } },
    { seq: start + 2, type: 'step/end', data: { turn, step: index } },
  ]
}
const surfaceOf = (events) => events.filter((e) => !String(e.type).startsWith('step/')).map((e) => e.seq)

test('buildStepUnits：按 step/start…step/end 切分；半截步骤标 incomplete', () => {
  const events = [
    ...step(1, 1, 1),
    ...step(1, 2, 4),
    { seq: 7, type: 'step/start', data: { turn: 1, step: 3 } },
    { seq: 8, type: 'assistant/message', data: { message: { content: [] } } },
  ]
  const units = buildStepUnits(events)
  assert.equal(units.length, 3)
  assert.deepEqual(units.map((u) => u.complete), [true, true, false])
  assert.deepEqual(units[0].seqs, [1, 2, 3])
  assert.equal(units[2].seqs.at(-1), 8)
})

test('工作集：最近 retainSteps 步不压；更早的步骤连续成 span', () => {
  const events = [...step(1, 1, 1), ...step(1, 2, 4), ...step(1, 3, 7), ...step(1, 4, 10)]
  const span = selectStepSpan({ surfaceNodes: surfaceOf(events), events, hasRecord, retainSteps: 2, maxSteps: 3 })
  assert.ok(span)
  assert.equal(span.startSeq, 2, 'span 从第一个活动面节点开始（step/start 不是面节点）')
  assert.equal(span.endSeq, 5, '只压到工作集之前的那一步')
  assert.equal(span.steps, 2)
  assert.deepEqual(span.recordSeqs, span.sourceEventSeqs)
})

test('maxSteps 限制单次压缩的步骤数（减少前缀抖动）', () => {
  const events = [...step(1, 1, 1), ...step(1, 2, 4), ...step(1, 3, 7), ...step(1, 4, 10)]
  const span = selectStepSpan({ surfaceNodes: surfaceOf(events), events, hasRecord, retainSteps: 1, maxSteps: 1 })
  assert.equal(span.endSeq, 2, '一次只压第一步')
  assert.equal(span.steps, 1)
})

test('不跨回合：到用户消息即停，绝不把锚点卷进 span', () => {
  const events = [
    ...step(1, 1, 1),
    { seq: 4, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'next' }] } },
    ...step(2, 1, 5),
    ...step(2, 2, 8),
  ]
  const span = selectStepSpan({ surfaceNodes: surfaceOf(events), events, hasRecord, retainSteps: 1, maxSteps: 3 })
  assert.ok(span, '前一个回合的步骤仍可压')
  assert.equal(span.endSeq, 2, 'span 必须在用户消息之前结束')
  assert.equal(span.sourceEventSeqs.includes(4), false, '用户消息不可被遮蔽')
})

test('未完成 tool 对 / 插件回执 / pin 是整步边界', () => {
  const unfinished = [
    ...step(1, 1, 1, { seq: 2, type: 'tool/call', data: { callId: 'c1', name: 'read', arguments: '{}' } }),
    ...step(1, 2, 4),
    ...step(1, 3, 7),
  ]
  assert.equal(selectStepSpan({ surfaceNodes: surfaceOf(unfinished), events: unfinished, hasRecord, retainSteps: 1, maxSteps: 3 }), null,
    '第一个步骤有未完成调用 → 整组不压')

  const withReceipt = [
    ...step(1, 1, 1, { seq: 2, type: 'user/message', data: { source: { kind: 'dsh-memory-context-lab', form: 'memory-lab3-surface' }, content: [{ type: 'text', text: 'r' }] } }),
    ...step(1, 2, 4),
  ]
  assert.equal(selectStepSpan({ surfaceNodes: surfaceOf(withReceipt), events: withReceipt, hasRecord, retainSteps: 1, maxSteps: 3 }), null,
    '插件回执在步骤里 → 整组不压')

  const pinned = [...step(1, 1, 1), ...step(1, 2, 4)]
  assert.equal(selectStepSpan({ surfaceNodes: surfaceOf(pinned), events: pinned, hasRecord, retainSteps: 1, maxSteps: 3, pinnedSeqs: new Set([2]) }), null,
    'pin 是整步边界')
})

test('回注包透明：随 span 遮蔽但不进 recordSeqs；缺记录则整步不压', () => {
  const events = [
    ...step(1, 1, 1, { seq: 2, type: 'user/message', data: { source: { kind: 'dsh-memory-context-lab', form: 'recall' }, content: [{ type: 'text', text: 'p' }] } }),
    ...step(1, 2, 4),
    ...step(1, 3, 7),
  ]
  const span = selectStepSpan({ surfaceNodes: surfaceOf(events), events, hasRecord, retainSteps: 1, maxSteps: 2 })
  assert.ok(span, '含回注包的步骤仍可压缩')
  assert.deepEqual(span.sourceEventSeqs, [2, 5], '只含活动面节点')
  assert.deepEqual(span.recordSeqs, [5], '回注包 2 不进 recordSeqs')

  const missing = selectStepSpan({ surfaceNodes: surfaceOf(events), events, hasRecord: (seq) => seq !== 5, retainSteps: 1, maxSteps: 2 })
  assert.equal(missing, null, '非回注包节点缺记录 → 不做不可恢复的遮蔽')
})

// —— 0.14.0-beta.44 根因守卫：真实宿主形状（不是夹具自己的形状） ——

test('真实 tool/result 形状：data.message.toolCallId 必须完成配对，不能把整步判死', () => {
  const events = [
    { seq: 0, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'do' }] } },
    { seq: 1, type: 'step/start', data: { turn: 1, step: 1 } },
    { seq: 2, type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{}' } },
    { seq: 3, type: 'tool/result', data: { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'c1', source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'text', text: 'ok' }] } } },
    { seq: 4, type: 'step/end', data: { turn: 1, step: 1 } },
    ...step(1, 2, 5),
    ...step(1, 3, 8),
    ...step(1, 4, 11),
    ...step(1, 5, 14),
    ...step(1, 6, 17),
  ]
  const units = buildStepUnits(events)
  assert.equal(units[0].hasUnfinished, false, '真实 tool/result 的 toolCallId 必须闭合 tool/call')
  const span = selectStepSpan({ surfaceNodes: surfaceOf(events), events, hasRecord, retainSteps: 2, maxSteps: 3 })
  assert.ok(span, '含真实工具对的步骤必须可压，而不是 null')
  assert.equal(span.startSeq, 2)
})

test('真实 DSH 布局：user/message 在 step 1 内 → 跳过锚点整步，压后续步骤', () => {
  const events = [
    { seq: 1, type: 'step/start', data: { turn: 1, step: 1 } },
    { seq: 2, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '任务' }] } },
    { seq: 3, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'a1' }] } } },
    { seq: 4, type: 'step/end', data: { turn: 1, step: 1 } },
    { seq: 5, type: 'step/start', data: { turn: 1, step: 2 } },
    { seq: 6, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'a2' }] } } },
    { seq: 7, type: 'step/end', data: { turn: 1, step: 2 } },
    { seq: 8, type: 'step/start', data: { turn: 1, step: 3 } },
    { seq: 9, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'a3' }] } } },
    { seq: 10, type: 'step/end', data: { turn: 1, step: 3 } },
    { seq: 11, type: 'step/start', data: { turn: 1, step: 4 } },
    { seq: 12, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'a4' }] } } },
    { seq: 13, type: 'step/end', data: { turn: 1, step: 4 } },
    { seq: 14, type: 'step/start', data: { turn: 1, step: 5 } },
    { seq: 15, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'a5' }] } } },
    { seq: 16, type: 'step/end', data: { turn: 1, step: 5 } },
  ]
  const span = selectStepSpan({ surfaceNodes: surfaceOf(events), events, hasRecord, retainSteps: 1, maxSteps: 3 })
  assert.ok(span, '第一个步骤含用户消息不能阻断后续步骤')
  assert.equal(span.startSeq, 6, 'span 从 step 2 起，不卷进 step 1 的用户锚点')
  assert.equal(span.sourceEventSeqs.includes(2), false, '用户消息不可被遮蔽')
  assert.equal(span.steps, 3)
})

test('锚点出现在已开始选步之后仍是硬边界：不得跨过它拼接', () => {
  const events = [
    { seq: 1, type: 'step/start', data: { turn: 1, step: 1 } },
    { seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'a1' }] } } },
    { seq: 3, type: 'step/end', data: { turn: 1, step: 1 } },
    { seq: 4, type: 'step/start', data: { turn: 1, step: 2 } },
    { seq: 5, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '插入' }] } },
    { seq: 6, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'a2' }] } } },
    { seq: 7, type: 'step/end', data: { turn: 1, step: 2 } },
    { seq: 8, type: 'step/start', data: { turn: 1, step: 3 } },
    { seq: 9, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'a3' }] } } },
    { seq: 10, type: 'step/end', data: { turn: 1, step: 3 } },
  ]
  const span = selectStepSpan({ surfaceNodes: surfaceOf(events), events, hasRecord, retainSteps: 1, maxSteps: 3 })
  assert.ok(span)
  assert.equal(span.endSeq, 2, '只压锚点之前的 step 1')
})

// —— 0.14.0-beta.46 根因守卫：判负 span 不能永久挡住它后面的步骤 ——

test('minStartSeq：跳过已判负的队头 span，从它之后继续选', () => {
  const events = [...step(1, 1, 1), ...step(1, 2, 4), ...step(1, 3, 7), ...step(1, 4, 10), ...step(1, 5, 13)]
  const surface = surfaceOf(events)
  const first = selectStepSpan({ surfaceNodes: surface, events, hasRecord, retainSteps: 2, maxSteps: 1 })
  assert.ok(first)
  assert.equal(first.startSeq, 2)
  const next = selectStepSpan({ surfaceNodes: surface, events, hasRecord, retainSteps: 2, maxSteps: 1, minStartSeq: first.endSeq })
  assert.ok(next, '判负 span 之后仍有可压步骤时必须继续选，而不是 null')
  assert.equal(next.startSeq, 5, '从判负 span 的 endSeq 之后开始')
})
