/**
 * R06 共享归档保护：assistant 结构里的调用全集（0.15.0，未升号候选）。
 *
 * 缺陷（P0 宿主取证已实测）：assistant/message 的 content 块可以同时声明多个
 * `tool-call`；宿主用 executeToolCalls 并发执行，结果按模型顺序追加，取消时由
 * appendSkippedToolCall 补 call/result 对，步骤异常时由 ToolCallRecovery 按
 * assistant 顺序补合成结果。而 tool/call 在真实宿主是 **log-only**（活动面不含它）。
 *
 * 插件旧判据只认独立的 tool/call 与 tool/result 事件：还没写出 tool/call 的调用
 * 在插件眼里不存在 → 只收到部分结果的回合/步骤被判「已完成」并归档，之后结果
 * 到达时活动面已经被改过（不可恢复的操作闭包）。
 *
 * 修法：从 assistant/message 的结构块取**声明的 callId 全集**，与 tool/result 的
 * 键做集合比较；回合级（candidates）与步骤级（steps）共用同一个判据。
 * 结果到达顺序无关（乱序仍闭合），取消补的合成结果也算闭合。
 *
 * 边界：本套件是纯函数级判据守卫，不是真实宿主集成证据；合成夹具，非真实会话数据。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { groupSurfaceOperations, selectArchiveSpan } from '../src/v3/domain/archive/candidates.mjs'
import { buildStepUnits, selectStepSpan as selectStepSpanRaw, STEP_BATCH_MAX } from '../src/v3/domain/archive/steps.mjs'

/**
 * 本套件只钉 R06 闭包判据；攒批阈值关掉（由 v3-step-batch 专测），maxSteps 仍是唯一上限。
 * headOnly：这些用例钉的是**队头单段**判据（队头不可闭合 → null），保护洞之后的同批
 * 安全段由 P3 多段提交负责，不在本套件的断言面内（见 v3-step-batch 多 run 用例）。
 */
const selectStepSpan = (args) => selectStepSpanRaw({ batchSteps: STEP_BATCH_MAX, bypassBatch: true, headOnly: true, ...args })

// —— 夹具构造（合成） ——

function human(seq) {
  return { seq, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'u' + seq }] } }
}

/** 真实宿主形状：assistant content 块用 {type,id,name,arguments}（id 才是调用标识）。 */
function assistantCalls(seq, ids, text = 'thinking') {
  const content = [{ type: 'text', text }]
  for (const id of ids) content.push({ type: 'tool-call', id, name: 'read', arguments: '{}' })
  return { seq, type: 'assistant/message', data: { message: { role: 'assistant', content } } }
}

function assistantText(seq, text) {
  return { seq, type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text }] } } }
}

/** log-only 调度事件：真实活动面不含它。 */
function toolCall(seq, callId) {
  return { seq, type: 'tool/call', data: { callId, name: 'read', arguments: '{}' } }
}

function toolResult(seq, callId, { text = 'r', isError = false } = {}) {
  return {
    seq,
    type: 'tool/result',
    data: { callId, isError, message: { role: 'tool', toolCallId: callId, source: { kind: 'tool', callId }, content: [{ type: 'text', text }] } },
  }
}

function stepStart(seq, turn, step) {
  return { seq, type: 'step/start', data: { turn, step } }
}

function stepEnd(seq, turn, step) {
  return { seq, type: 'step/end', data: { turn, step } }
}

function rejectionOf(fn) {
  const seen = []
  fn((row) => seen.push(row))
  return seen[0] ?? null
}

// —— 红色用例：assistant 声明全集必须进入闭包 ——

test('R06 按轮：assistant 声明 c1,c2 而只收到 c1 结果 → 整回合不可归档', () => {
  // 事件形状取自 P0 宿主探针的 red 夹具（synthetic）：c2 只存在于 assistant content。
  const events = [
    human(0),
    assistantCalls(1, ['c1', 'c2']),
    toolCall(2, 'c1'),
    toolResult(3, 'c1'),
    human(4),
  ]
  const surfaceNodes = [0, 1, 3, 4]
  let rejection = null
  const span = selectArchiveSpan({
    surfaceNodes,
    events,
    hasRecord: () => true,
    mode: 'full-history',
    maxOperations: 1,
    onReject: (row) => { rejection = rejection ?? row },
  })
  assert.equal(span, null, '部分结果的回合不得归档（c2 没有结果）')
  assert.equal(rejection?.reason, 'unfinished-tool', '拒绝原因必须如实指向未完成调用')
})

test('R06 按步：同一步内 assistant 声明 c1,c2 只收到 c1 → 整步不可归档', () => {
  const events = [
    stepStart(0, 1, 1),
    assistantCalls(1, ['c1', 'c2']),
    toolCall(2, 'c1'),
    toolResult(3, 'c1'),
    stepEnd(4, 1, 1),
    stepStart(5, 1, 2),
    assistantText(6, 'a2'),
    stepEnd(7, 1, 2),
    stepStart(8, 1, 3),
    assistantText(9, 'a3'),
    stepEnd(10, 1, 3),
    stepStart(11, 1, 4),
    assistantText(12, 'a4'),
    stepEnd(13, 1, 4),
  ]
  const surfaceNodes = [1, 3, 6, 9, 12]
  const units = buildStepUnits(events)
  assert.equal(units[0].hasUnfinished, true, '步骤级闭包同样要按 assistant 声明全集判')
  const span = selectStepSpan({ surfaceNodes, events, hasRecord: () => true, retainSteps: 3, maxSteps: 3 })
  assert.equal(span, null, '部分结果的步骤不得归档')
  const rejection = rejectionOf((cb) => selectStepSpan({ surfaceNodes, events, hasRecord: () => true, retainSteps: 3, maxSteps: 3, onReject: cb }))
  assert.equal(rejection?.reason, 'unfinished-tool')
})

test('R06 跨步：单元级判据把 step1 标未完成，选择器只在范围够不到结果时拒绝', () => {
  // 真实形状：step1 assistant 声明 c1,c2；c1 在 step1 完成；c2 的 tool/call 与
  // tool/result 直到 step2 才落盘。若只看「本步内的 call/result」，step1 会被判完成。
  const events = [
    stepStart(0, 1, 1),
    assistantCalls(1, ['c1', 'c2']),
    toolCall(2, 'c1'),
    toolResult(3, 'c1'),
    stepEnd(4, 1, 1),
    stepStart(5, 1, 2),
    toolCall(6, 'c2'),
    toolResult(7, 'c2'),
    stepEnd(8, 1, 2),
    stepStart(9, 1, 3),
    assistantText(10, 'a3'),
    stepEnd(11, 1, 3),
    stepStart(12, 1, 4),
    assistantText(13, 'a4'),
    stepEnd(14, 1, 4),
  ]
  const surfaceNodes = [1, 3, 7, 10, 13]
  const units = buildStepUnits(events)
  // 单元级 hasUnfinished 只是**诊断**：step1 自己看不到 c2 的结果，但它不是终局。
  // 选择判据是按「候选范围」验证（见 R06-B）：范围够得到结果那一步就整体闭合。
  assert.equal(units[0].hasUnfinished, true, 'step1 单元级：c2 结果在 step2')
  assert.equal(units[1].hasUnfinished, false, 'step2 单元级：c2 的 call+result 成对')
  // 风险断言（保留）：retainSteps=3 只剩 step1 可选 → 无法闭合，必须拒，不得单边遮蔽。
  assert.equal(
    selectStepSpan({ surfaceNodes, events, hasRecord: () => true, retainSteps: 3, maxSteps: 3 }),
    null,
    '只允许选 step1 时拒绝（结果仍在工作集，不得拆两侧）',
  )
  // 正对照：范围够得到 step2（retainSteps=1）→ step1+step2 作为一个闭合区间归档。
  const span = selectStepSpan({ surfaceNodes, events, hasRecord: () => true, retainSteps: 1, maxSteps: 2 })
  assert.ok(span, '范围覆盖声明与结果两端时必须可归档（不是永久未完成）')
  assert.deepEqual(span.sourceEventSeqs, [1, 3, 7], '遮蔽 step1 的声明+c1 结果与 step2 的 c2 结果（tool/call 为 log-only）')
  // 同一形状下 maxSteps=3 只是多带一个独立完成步骤，不改变「两端都在范围内」的判据。
  assert.deepEqual(
    selectStepSpan({ surfaceNodes, events, hasRecord: () => true, retainSteps: 1, maxSteps: 3 }).sourceEventSeqs,
    [1, 3, 7, 10],
  )
})

// —— 对照：正常路径必须继续可归档 ——

test('R06 对照：完整配对（乱序到达）仍构成闭包 → 回合可归档', () => {
  const events = [
    human(0),
    assistantCalls(1, ['c1', 'c2']),
    toolCall(2, 'c2'),
    toolResult(3, 'c2'),
    toolCall(4, 'c1'),
    toolResult(5, 'c1'),
    human(6),
  ]
  const surfaceNodes = [0, 1, 3, 5, 6]
  const span = selectArchiveSpan({ surfaceNodes, events, hasRecord: () => true, mode: 'full-history', maxOperations: 1 })
  assert.ok(span, '乱序结果仍是完整闭包，必须可归档')
  assert.deepEqual(span.sourceEventSeqs, [0, 1, 3, 5], 'sourceEventSeqs 只覆盖真实 surface，不含 log-only 的 tool/call')
  assert.deepEqual(span.recordSeqs, [0, 1, 3, 5])
})

test('R06 对照：取消时宿主补的合成结果（无独立 tool/call）也算闭合', () => {
  // appendSkippedToolCall 补 call+result 对；这里取更弱的形状：只有合成 result。
  const events = [
    human(0),
    assistantCalls(1, ['c1', 'c2']),
    toolCall(2, 'c1'),
    toolResult(3, 'c1'),
    toolResult(4, 'c2', { text: 'aborted before dispatch', isError: true }),
    human(5),
  ]
  const surfaceNodes = [0, 1, 3, 4, 5]
  const span = selectArchiveSpan({ surfaceNodes, events, hasRecord: () => true, mode: 'full-history', maxOperations: 1 })
  assert.ok(span, '取消已由宿主收口：调用闭包成立')
  assert.deepEqual(span.sourceEventSeqs, [0, 1, 3, 4])
})

test('R06 对照：调用未声明也未收口（旧形状 tool/call 无 result）仍保护整组', () => {
  const events = [
    human(0),
    assistantText(1, 'a1'),
    toolCall(2, 'c1'),
    human(3),
  ]
  assert.equal(selectArchiveSpan({ surfaceNodes: [0, 1, 2, 3], events, hasRecord: () => true, mode: 'full-history' }), null,
    '已见 tool/call 无 result 必须整组保护（既有语义不变）')
})

test('R06 结构块：callId 同时兼容 {id} 与旧夹具 {callId} 两种块形状', () => {
  const events = [
    human(0),
    { seq: 1, type: 'assistant/message', data: { message: { content: [
      { type: 'tool-call', callId: 'legacy1', name: 'read', arguments: '{}' },
      { type: 'tool-call', id: 'real2', name: 'grep', arguments: '{}' },
    ] } } },
    toolResult(2, 'legacy1'),
    human(3),
  ]
  const groups = groupSurfaceOperations({ surfaceNodes: [0, 1, 2, 3], events })
  assert.equal(groups[0].hasUnfinished, true, 'real2（id 形状）没有结果：整回合保护')
  assert.equal(selectArchiveSpan({ surfaceNodes: [0, 1, 2, 3], events, hasRecord: () => true, mode: 'full-history' }), null)
})

test('R06 拒绝面可观测：未闭合的调用 id 随分组结果带出（不只有布尔值）', () => {
  const events = [
    human(0),
    assistantCalls(1, ['c1', 'c2']),
    toolResult(2, 'c1'),
    human(3),
  ]
  const groups = groupSurfaceOperations({ surfaceNodes: [0, 1, 2, 3], events })
  assert.deepEqual(groups[0].missingCallIds, ['c2'], '保护原因能指出具体 callId（诊断面不靠猜）')
})

test('R06 判据同源：同一批事件在按轮与按步下对同一调用得出同一结论', () => {
  const events = [
    stepStart(0, 1, 1),
    human(1),
    assistantCalls(2, ['c1', 'c2']),
    toolCall(3, 'c1'),
    toolResult(4, 'c1'),
    stepEnd(5, 1, 1),
    stepStart(6, 1, 2),
    human(7),
    assistantText(8, 'next'),
    stepEnd(9, 1, 2),
  ]
  const groups = groupSurfaceOperations({ surfaceNodes: [1, 2, 4, 7, 8], events })
  const units = buildStepUnits(events)
  assert.equal(groups[0].hasUnfinished, true)
  assert.equal(units[0].hasUnfinished, true, '回合级与步骤级共用同一调用闭包判据')
})

// —— 主验收补丁（2026-10-31）：畸形/歧义声明 + 跨步范围闭包 ——

/** 缺 id 的 tool-call 块：不能当成「没有调用」（未知 ≠ 空集）。 */
function assistantMalformedCall(seq) {
  return { seq, type: 'assistant/message', data: { message: { content: [
    { type: 'text', text: 'broken' },
    { type: 'tool-call', name: 'read', arguments: '{}' },
  ] } } }
}

/** 冲突形状：真实宿主的 id 与旧夹具的 callId 同时存在且不同。 */
function assistantConflictingCall(seq, id, callId) {
  return { seq, type: 'assistant/message', data: { message: { content: [
    { type: 'text', text: 'conflict' },
    { type: 'tool-call', id, callId, name: 'read', arguments: '{}' },
  ] } } }
}

test('R06-A 畸形声明：tool-call 块既无 id 也无 callId → 整回合保守保护（不得当空集）', () => {
  const events = [human(0), assistantMalformedCall(1), human(2)]
  let rejection = null
  const span = selectArchiveSpan({
    surfaceNodes: [0, 1, 2], events, hasRecord: () => true, mode: 'full-history', maxOperations: 1,
    onReject: (row) => { rejection = rejection ?? row },
  })
  assert.equal(span, null, '身份不可证明的调用不得遮蔽')
  assert.equal(rejection?.reason, 'unfinished-tool')
})

test('R06-A 歧义声明：id 与 callId 冲突且只有 legacy 结果 → 整回合保护（不静默偏爱 legacy）', () => {
  const events = [
    human(0),
    assistantConflictingCall(1, 'actual', 'legacy'),
    toolResult(2, 'legacy'),
    human(3),
  ]
  let rejection = null
  const span = selectArchiveSpan({
    surfaceNodes: [0, 1, 2, 3], events, hasRecord: () => true, mode: 'full-history', maxOperations: 1,
    onReject: (row) => { rejection = rejection ?? row },
  })
  assert.equal(span, null, '实际调用身份未证明（actual 无结果）→ 不得遮蔽')
  assert.equal(rejection?.reason, 'unfinished-tool')
  assert.deepEqual(rejection?.callIds, ['actual'], '诊断面指出缺哪个 id')
})

test('R06-A 歧义声明：两个候选 id 都有结果 → 身份不再影响完整性，可归档', () => {
  const events = [
    human(0),
    assistantConflictingCall(1, 'actual', 'legacy'),
    toolResult(2, 'legacy'),
    toolResult(3, 'actual'),
    human(4),
  ]
  const span = selectArchiveSpan({ surfaceNodes: [0, 1, 2, 3, 4], events, hasRecord: () => true, mode: 'full-history', maxOperations: 1 })
  assert.ok(span, '两种身份都能闭合：遮蔽不拆任何一侧')
  assert.deepEqual(span.sourceEventSeqs, [0, 1, 2, 3])
})

test('R06-A 正常文本无调用块：照旧可归档（防误杀对照）', () => {
  const events = [human(0), assistantText(1, '没有工具调用'), human(2)]
  const span = selectArchiveSpan({ surfaceNodes: [0, 1, 2], events, hasRecord: () => true, mode: 'full-history' })
  assert.deepEqual(span?.sourceEventSeqs, [0, 1])
})

/** 步骤级夹具：step1 声明 cross，step2 收口 cross，其余为普通完成步骤。 */
function crossStepEvents({ withResult = true, steps = 6 } = {}) {
  const events = [stepStart(0, 1, 1), assistantCalls(1, ['cross'])]
  let seq = 2
  // 活动面桶按**真实宿主合同**只放 surface 节点：step1 只有声明；step2 只有 cross 的
  // tool/result（tool/call 是 log-only，进日志但不进活动面）。
  const buckets = [[1], []]
  for (let index = 1; index <= steps; index += 1) {
    if (index === 2 && withResult) {
      events.push(toolCall(seq, 'cross')); seq += 1
      events.push(toolResult(seq, 'cross')); buckets[1].push(seq); seq += 1
    } else if (index > 1) {
      events.push(assistantText(seq, 'a' + index)); buckets.push([seq]); seq += 1
    }
    events.push(stepEnd(seq, 1, index)); seq += 1
    if (index < steps) {
      events.push(stepStart(seq, 1, index + 1)); seq += 1
    }
  }
  return { events, surfaceNodes: buckets.flat() }
}

test('R06-B 跨步闭包：两端都在候选范围内且连续、同 turn → 合并成一个闭合区间归档', () => {
  const { events, surfaceNodes } = crossStepEvents({ steps: 6 })
  // maxSteps=2：唯一闭合前缀就是 step1+step2（再多加一步属于批量选择，另外覆盖）。
  const span = selectStepSpan({ surfaceNodes, events, hasRecord: () => true, retainSteps: 1, maxSteps: 2 })
  assert.ok(span, 'step1+step2 形成闭合区间，不得永久卡在第一步')
  // 真实活动面不含 tool/call：span 只由声明（step1）与 result（step2）组成。
  assert.deepEqual(span.sourceEventSeqs, [surfaceNodes[0], surfaceNodes[1]], 'span 只遮蔽声明与结果，不含 log-only 的 tool/call')
  assert.equal(span.steps, 2, '合并两个步骤为一个原子范围')
  // 批量选择保留：maxSteps=3 时把紧随其后的独立完成步骤一起压，仍只遮蔽闭合范围。
  const batched = selectStepSpan({ surfaceNodes, events, hasRecord: () => true, retainSteps: 1, maxSteps: 3 })
  assert.equal(batched?.steps, 3, '独立完成的后续步骤照旧按 maxSteps 批量压')
  assert.deepEqual(batched.sourceEventSeqs, surfaceNodes.slice(0, 3))
})

test('R06-B 跨步闭包被 maxSteps 切开 → 拒绝（不放行单边遮蔽）', () => {
  const { events, surfaceNodes } = crossStepEvents({ steps: 6 })
  const span = selectStepSpan({ surfaceNodes, events, hasRecord: () => true, retainSteps: 1, maxSteps: 1 })
  assert.equal(span, null, '只允许选 step1 时（maxSteps=1）无法闭合 → 必须拒')
})

test('R06-B 跨步闭包被保留窗口切开 → 拒绝', () => {
  const { events, surfaceNodes } = crossStepEvents({ steps: 4 })
  // 4 步 + retainSteps=3 → 只有 step1 可选；step2（含 cross 结果）在工作集里。
  const span = selectStepSpan({ surfaceNodes, events, hasRecord: () => true, retainSteps: 3, maxSteps: 3 })
  assert.equal(span, null, '结果所在步骤仍属工作集：整段拒，不拆两侧')
})

test('R06-B 跨步闭包：结果侧被 pin → 拒绝（不越保护洞）', () => {
  const { events, surfaceNodes } = crossStepEvents({ steps: 6 })
  const span = selectStepSpan({
    surfaceNodes, events, hasRecord: () => true, retainSteps: 1, maxSteps: 3,
    pinnedSeqs: new Set([surfaceNodes[1]]),
  })
  assert.equal(span, null, '含 pin 的步骤不得被当作闭合范围的右端')
})

test('R06-B 声明永无结果（缺失结果）→ 拒绝，且不会跳过硬边界去选后面的步骤', () => {
  const { events, surfaceNodes } = crossStepEvents({ steps: 6, withResult: false })
  let rejection = null
  const span = selectStepSpan({
    surfaceNodes, events, hasRecord: () => true, retainSteps: 1, maxSteps: 3,
    onReject: (row) => { rejection = rejection ?? row },
  })
  assert.equal(span, null)
  assert.equal(rejection?.reason, 'unfinished-tool')
})

test('R06-B 只含结果（声明在候选范围之外）→ 拒绝（孤立 result 不得单独遮蔽）', () => {
  // step1 缺少 step/end（不构成完整步骤，声明因此落在候选范围之外）；step2 只含结果。
  const events = [
    stepStart(0, 1, 1),
    assistantCalls(1, ['x']),
    stepStart(2, 1, 2),
    toolCall(3, 'x'),
    toolResult(4, 'x'),
    stepEnd(5, 1, 2),
    stepStart(6, 1, 3),
    assistantText(7, 'a3'),
    stepEnd(8, 1, 3),
    stepStart(9, 1, 4),
    assistantText(10, 'a4'),
    stepEnd(11, 1, 4),
    stepStart(12, 1, 5),
    assistantText(13, 'a5'),
    stepEnd(14, 1, 5),
  ]
  const surfaceNodes = [1, 4, 7, 10, 13]
  let rejection = null
  const span = selectStepSpan({
    surfaceNodes, events, hasRecord: () => true, retainSteps: 1, maxSteps: 3,
    onReject: (row) => { rejection = rejection ?? row },
  })
  assert.equal(span, null, '范围内的 result 找不到范围内的声明：不得遮蔽')
  assert.equal(rejection?.reason, 'unfinished-tool')
  assert.deepEqual(rejection?.splitCallIds, ['x'], '步骤级拒绝出口同样透传拆分诊断（与回合级同口径）')
})

test('R06-B 按轮：声明留在候选范围之外、结果在范围内 → 拒绝（同一判据覆盖回合级）', () => {
  // 第 1 回合只声明 x（无结果）；第 2 回合只有 x 的 call/result。第 1 回合已被
  // lastArchiveEndSeq 排除出候选，若只看第 2 回合内部就会把 x 的结果单边遮蔽。
  const events = [
    human(0),
    assistantCalls(1, ['x']),
    human(2),
    toolCall(3, 'x'),
    toolResult(4, 'x'),
    human(5),
    assistantText(6, 'tail'),
  ]
  // tool/call 在旧形状里也可能落在活动面（onSurface），这里显式包含它，
  // 才能构造「范围内 call+result 自洽、但声明留在范围外」的拆分形态。
  const surfaceNodes = [0, 1, 2, 3, 4, 5, 6]
  let rejection = null
  const span = selectArchiveSpan({
    surfaceNodes, events, hasRecord: () => true, mode: 'full-history', maxOperations: 5,
    lastArchiveEndSeq: 1,
    onReject: (row) => { rejection = rejection ?? row },
  })
  assert.equal(span, null, '结果在范围内、声明在范围外：不得遮蔽')
  assert.equal(rejection?.reason, 'unfinished-tool')
  assert.deepEqual(rejection?.splitCallIds, ['x'], '诊断面指出被拆到范围外的 id')
})

test('R06-B 重复 ID：同一消息重复声明同 id → 去重后一个结果即可闭合', () => {
  const events = [
    human(0),
    { seq: 1, type: 'assistant/message', data: { message: { content: [
      { type: 'tool-call', id: 'dup', name: 'read', arguments: '{}' },
      { type: 'tool-call', id: 'dup', name: 'read', arguments: '{}' },
    ] } } },
    toolResult(2, 'dup'),
    human(3),
  ]
  const span = selectArchiveSpan({ surfaceNodes: [0, 1, 2, 3], events, hasRecord: () => true, mode: 'full-history', maxOperations: 1 })
  assert.ok(span, '重复声明不放大要求')
})

test('R06-B 无 turn/step 计数时 turnBasis=dsh 等价回退 human（不得抛错）', () => {
  // 旧宿主/旧夹具没有 turn 计数：dsh 判定必须退回真人判定，而不是解构不存在的
  // entry/bySeq（主验收实测到的 Cannot destructure property 'bySeq'）。
  const events = [human(0), assistantText(1, 'a1'), human(2)]
  const args = { surfaceNodes: [0, 1, 2], events, hasRecord: () => true, mode: 'full-history', maxOperations: 1 }
  const viaHuman = selectArchiveSpan(args)
  const viaDsh = selectArchiveSpan({ ...args, turnBasis: 'dsh' })
  assert.deepEqual(viaDsh, viaHuman, 'dsh 回退必须与 human 逐字段等价')
  assert.deepEqual(viaDsh?.sourceEventSeqs, [0, 1])
  const groupsHuman = groupSurfaceOperations({ surfaceNodes: [0, 1, 2], events })
  const groupsDsh = groupSurfaceOperations({ surfaceNodes: [0, 1, 2], events, turnBasis: 'dsh' })
  assert.deepEqual(groupsDsh, groupsHuman, '分组层同样等价')
})

test('R06-B human 与 dsh 两条按轮路径对畸形/歧义声明取同一结论', () => {
  const malformed = [stepStart(0, 1, 1), human(1), assistantMalformedCall(2), stepEnd(3, 1, 1), stepStart(4, 2, 1), human(5), assistantText(6, 'next'), stepEnd(7, 2, 1)]
  const surface = [1, 2, 5, 6]
  assert.equal(selectArchiveSpan({ surfaceNodes: surface, events: malformed, hasRecord: () => true, mode: 'full-history' }), null, 'human 判定：保护')
  const dsh = selectArchiveSpan({ surfaceNodes: surface, events: malformed, hasRecord: () => true, mode: 'full-history', turnBasis: 'dsh', currentTurn: 2 })
  assert.equal(dsh, null, 'dsh 判定：同样保护')

  const conflicting = [
    stepStart(0, 1, 1), human(1), assistantConflictingCall(2, 'actual', 'legacy'), toolResult(3, 'legacy'), stepEnd(4, 1, 1),
    stepStart(5, 2, 1), human(6), assistantText(7, 'next'), stepEnd(8, 2, 1),
  ]
  const surface2 = [1, 2, 3, 6, 7]
  assert.equal(selectArchiveSpan({ surfaceNodes: surface2, events: conflicting, hasRecord: () => true, mode: 'full-history' }), null)
  assert.equal(selectArchiveSpan({ surfaceNodes: surface2, events: conflicting, hasRecord: () => true, mode: 'full-history', turnBasis: 'dsh', currentTurn: 2 }), null)
})
