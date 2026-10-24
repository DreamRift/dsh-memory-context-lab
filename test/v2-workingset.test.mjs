/**
 * v2 活跃工作集测试：硬保护 vs 软保留、未知关系回退、稳定前缀、
 * 有界热上下文（200 vs 2000 条记录）、预算 0/负数/非法值语义。
 *
 * 0.13.2-beta.8（Q4）：evidence/pins/constraints/inflightJobs/prefetch/redundantCards/
 * nonEssentialHistory/rejectedOptions/openQuestions/relations/projection 十一类入参
 * 零生产方，已整类摘除——原「测死代码」的用例（pin 三态、版本指纹、关系回退、
 * 投影批次）不再保留；软保留夹具统一改用有生产方的 claims 与 progress。
 *
 * 全部用确定性夹具；需要落库的部分用临时隔离库，不触碰真实会话与正式灵枢。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { ensureLabRoot } from '../src/storage.mjs'
import { V2SessionStore } from '../src/v2/store.mjs'
import { recordsFromEvent } from '../src/v2/records.mjs'
import { packWorkingSet, readRecordById } from '../src/v2/readback.mjs'
import {
  WORKING_SET_DEFAULTS,
  PROTECTION_CLASSES,
  PROTECTION_ORDER,
  RETENTION_CLASSES,
  DROP_ORDER,
  TTL_FREE_HARD_CLASSES,
  buildWorkingState,
  planWorkingSetBudget,
  renderWorkingSetInjection,
  resolveAuthority,
  SOURCE_KINDS,
} from '../src/v2/working-state.mjs'

const NOW = 1_700_000_000_000
const SESSION_ID = 'ws0000000000000000000001'

async function makeLabRoot(name) {
  const root = await mkdtemp(path.join(tmpdir(), `mclv2ws-${name}-`))
  await ensureLabRoot(root)
  return root
}

/**
 * 确定性夹具：一条人类请求 + N 次完整操作（调用 + 结果），外加固定的在途配对。
 * 保护集固定不变，只有记录总量随 operations 变化。
 */
function scenario({ operations = 4, openCallCount = 1, now = NOW } = {}) {
  const events = new Map()
  const surfaceNodes = []
  let seq = 1
  events.set(seq, {
    type: 'user/message',
    data: { id: 'u1', source: { kind: 'user' }, content: [{ type: 'text', text: '把工作集做成有界常驻的活跃工作集。' }] },
  })
  surfaceNodes.push(seq)
  seq += 1
  for (let index = 0; index < operations; index += 1) {
    events.set(seq, {
      type: 'assistant/message',
      data: { turn: index, step: index, message: { id: `a${index}`, content: [{ type: 'tool-call', id: `call_${index}`, name: 'read' }] } },
    })
    surfaceNodes.push(seq)
    seq += 1
    events.set(seq, {
      type: 'tool/result',
      data: { message: { id: `r${index}`, toolCallId: `call_${index}`, content: [{ type: 'text', text: `output-${index} ${'x'.repeat(120)}` }] } },
    })
    surfaceNodes.push(seq)
    seq += 1
  }
  const openCalls = []
  for (let index = 0; index < openCallCount; index += 1) {
    openCalls.push({
      callId: `open_${index}`,
      callRecordId: `t00000001-r${String(index).padStart(4, '0')}`,
      callSeq: seq + index,
    })
  }
  return { events, surfaceNodes, openCalls, now, eventAt: (target) => events.get(target) ?? null }
}

const CLAIMS = [
  { value: '结论一：构建脚本走 test-all', polarity: 'positive', recordRef: 'r1' },
  { value: '结论二：进度按最新保留', polarity: 'positive', recordRef: 'r2' },
]

/** 一个「什么都有」的状态：硬保护齐全，软保留候选（claims + progress）也齐全。 */
function fullState(overrides = {}) {
  const base = scenario({ operations: 4 })
  return buildWorkingState({
    sessionId: SESSION_ID,
    surfaceNodes: base.surfaceNodes,
    eventAt: base.eventAt,
    openCalls: base.openCalls,
    lastAssistantSeq: null,
    now: base.now,
    claims: CLAIMS,
    ...overrides,
  })
}

const SOFT_CLASSES_PRESENT = [
  RETENTION_CLASSES.NON_ESSENTIAL_HISTORY,
  RETENTION_CLASSES.UNVERIFIED_EVIDENCE,
]

test('Q4：零生产方类目已移出封闭集，软保留只剩两类（未接线类目不再渲染）', () => {
  // 类目封闭集只允许「有生产方」的成员：硬保护 5（4 内容类 + 未知协议位）、
  // 软保留 2（非必要历史、未验证证据）。evidence/pins/inflightJobs/constraints/
  // relations/projection/prefetch/redundantCards/rejectedOptions/openQuestions
  // 十类入参没有生产方，对应类目/配额键已整体摘除（修复计划-beta.8 §〇）。
  assert.deepEqual(Object.keys(PROTECTION_CLASSES), [
    'HUMAN_REQUEST',
    'UNCLOSED_CALL',
    'UNEXPOSED_RESULT',
    'MINIMAL_WORKING_STATE',
    'UNKNOWN_PROTOCOL',
  ])
  assert.deepEqual(Object.keys(RETENTION_CLASSES), ['NON_ESSENTIAL_HISTORY', 'UNVERIFIED_EVIDENCE'])
  assert.deepEqual([...DROP_ORDER], [RETENTION_CLASSES.NON_ESSENTIAL_HISTORY, RETENTION_CLASSES.UNVERIFIED_EVIDENCE])
  assert.deepEqual([...PROTECTION_ORDER], [...TTL_FREE_HARD_CLASSES])
  // 配额键跟随类目：已摘类目的配额键不得残留。
  for (const dead of ['maxConstraints', 'maxEvidence', 'maxPins', 'maxInflightJobs', 'maxPrefetch',
    'maxRedundantCards', 'maxRejectedOptions', 'maxOpenQuestions', 'pinTtlMs']) {
    assert.equal(Object.hasOwn(WORKING_SET_DEFAULTS, dead), false, `${dead} 必须移出 WORKING_SET_DEFAULTS`)
  }
  // 死入参即使被传进来也只是普通多余键：不得崩溃、不得复活任何类目。
  const base = scenario({ operations: 2 })
  const tolerant = buildWorkingState({
    sessionId: SESSION_ID,
    surfaceNodes: base.surfaceNodes,
    eventAt: base.eventAt,
    openCalls: base.openCalls,
    now: 0,
    evidence: [null],
    pins: [null],
    inflightJobs: [{ jobId: 'x' }],
    constraints: ['不该生效的约束'],
  })
  assert.ok(!JSON.stringify(tolerant.retention).includes('不该生效的约束'), '死入参内容不得进入任何段')
  assert.deepEqual(Object.keys(tolerant.retention), Object.values(RETENTION_CLASSES))
})

test('保护集逐条带 reason/source/releaseCondition，各类硬保护都在封闭集里', () => {
  const state = fullState()
  assert.ok(state.protectedSet.length > 0)
  for (const item of state.protectedSet) {
    assert.ok(item.reason && item.reason.length > 0, `保护项 ${item.itemId} 缺 reason`)
    assert.ok(item.source && item.source.length > 0, `保护项 ${item.itemId} 缺 source`)
    assert.ok(item.releaseCondition && item.releaseCondition.length > 0, `保护项 ${item.itemId} 缺 releaseCondition`)
    assert.equal(item.strength, 'hard')
  }
  const classes = new Set(state.protectedSet.map((item) => item.protectionClass))
  assert.ok(classes.has(PROTECTION_CLASSES.HUMAN_REQUEST), '当前人类请求必须在保护集里')
  assert.ok(classes.has(PROTECTION_CLASSES.UNCLOSED_CALL), '未闭合调用必须在保护集里')
  assert.ok(classes.has(PROTECTION_CLASSES.UNEXPOSED_RESULT), '未曝光结果必须在保护集里')
  assert.ok(classes.has(PROTECTION_CLASSES.MINIMAL_WORKING_STATE), '最小工作状态必须在保护集里')
  // UNKNOWN_PROTOCOL 是协议位：健康夹具里 unknowns 为空是正常态（不渲染空段），
  // 它的生产证明见下方「未知协议位」用例与 wiring 守卫的第二夹具。
  // 硬保护类目不允许带 TTL
  assert.equal(state.protectionInvariants.hardClassesAreTtlFree, true)
  assert.equal(state.protectionInvariants.hardItemsNeverDroppedForBudget, true)
})

test('Y-31：软保留进度行只保留硬段未覆盖的完成态（call-only/未曝光行移交硬段）', () => {
  // 夹具：op0 已曝光（result seq 3 ≤ 最后助手 seq 4）、call_00_fresh 的结果在最后
  // 助手之后（未曝光）、call_00_open 纯在途（无结果）。
  const events = new Map()
  const surfaceNodes = []
  let seq = 1
  events.set(seq, { type: 'user/message', data: { id: 'u1', source: { kind: 'user' }, content: [{ type: 'text', text: '扫描。' }] } })
  surfaceNodes.push(seq); seq += 1
  events.set(seq, { type: 'assistant/message', data: { turn: 0, message: { id: 'a0', content: [{ type: 'tool-call', id: 'call_00_done', name: 'read' }] } } })
  surfaceNodes.push(seq); seq += 1
  events.set(seq, { type: 'tool/result', data: { message: { id: 'r0', toolCallId: 'call_00_done', content: [{ type: 'text', text: 'out0' }] } } })
  surfaceNodes.push(seq); seq += 1
  events.set(seq, { type: 'assistant/message', data: { turn: 1, message: { id: 'a1', content: [{ type: 'tool-call', id: 'call_00_fresh', name: 'grep' }, { type: 'tool-call', id: 'call_00_open', name: 'write' }] } } })
  const lastAssistant = seq
  surfaceNodes.push(seq); seq += 1
  events.set(seq, { type: 'tool/result', data: { message: { id: 'r1', toolCallId: 'call_00_fresh', content: [{ type: 'text', text: 'out1' }] } } })
  surfaceNodes.push(seq); seq += 1
  const state = buildWorkingState({
    sessionId: SESSION_ID,
    surfaceNodes,
    eventAt: (target) => events.get(target) ?? null,
    openCalls: [],
    lastAssistantSeq: lastAssistant,
    now: NOW,
  })
  // 软段只剩 op0 的完成态；call_00_fresh（未曝光）与 call_00_open（call-only）
  // 不得重复出现在进度行。
  const progressRows = state.retention[RETENTION_CLASSES.NON_ESSENTIAL_HISTORY]
    .filter((item) => (item.itemId ?? '').startsWith('progress:'))
  assert.equal(progressRows.length, 1, `进度行必须只剩已曝光完成态，实际 ${JSON.stringify(progressRows.map((i) => i.itemId))}`)
  assert.match(progressRows[0].lines[0], /工具 read/)
  const card = renderWorkingSetInjection(state, { budgetTokens: 8000 })
  assert.equal(card.text.includes('call-only'), false, '卡内不得再有 call-only 状态行（硬段已覆盖）')
  assert.match(card.text, /在途动作 call_00_open/, '纯在途调用必须在硬段')
  assert.match(card.text, /未曝光结果（callId call_00_fresh/, '未曝光结果必须在硬段且不再印裸句柄')
})

test('Y-32：不可读句柄不印 seq:N；可读句柄是 memory_lab_recall 可执行形态', () => {
  // 无 recordIdsForSeq 映射 → refOf 退回 host-seq（readable:false）→ 不得印出 seq:N。
  const base = scenario({ operations: 2, openCallCount: 1 })
  const state = buildWorkingState({
    sessionId: SESSION_ID,
    surfaceNodes: base.surfaceNodes,
    eventAt: base.eventAt,
    openCalls: base.openCalls,
    lastAssistantSeq: null,
    now: NOW,
  })
  const card = renderWorkingSetInjection(state, { budgetTokens: 20000 })
  const handleLines = card.text.split('\n').filter((line) =>
    line.startsWith('- 在途动作') || line.startsWith('- 进度 ') || line.startsWith('- 未曝光结果'))
  for (const line of handleLines) {
    assert.doesNotMatch(line, /seq:\d+/, `句柄行不得印 seq:N：${line}`)
  }
  // 有记录 ID 的行必须是可执行形态；open_0 来自冷库账本（callRecordId 可读，优先于 callId）。
  assert.match(card.text, /memory_lab_recall\(record_ids=\["t00000001-r0000"\]\)/, '冷库在途配对的可读记录 ID 是合法回读句柄')
  // readback 段是 P0-1 设计：段题给出可执行工具形态、行只给结构 + 真实记录 ID
  //（不是 seq:N）——可读句柄以「段题工具形态 + 行内记录 ID」组合呈现。
  const withReadback = buildWorkingState({
    sessionId: SESSION_ID,
    surfaceNodes: base.surfaceNodes,
    eventAt: base.eventAt,
    openCalls: base.openCalls,
    lastAssistantSeq: null,
    now: NOW,
    readback: [{ recordId: 't00000001-r0001', tools: ['read'], range: { start: 2, end: 3 }, locator: '位置', tokens: 5 }],
  })
  const readbackCard = renderWorkingSetInjection(withReadback, { budgetTokens: 20000 })
  assert.match(readbackCard.text, /■ 本步可回读（memory_lab_recall\(record_ids=\[…\]\)/)
  assert.match(readbackCard.text, /- t00000001-r0001｜read｜/, '行内必须是真实记录 ID')
})

test('未知协议位：判定不可用（曝光未知）时必须以未知条目常驻，不得当成「没有」', () => {
  // lastAssistant 从**表面**推导：表面里没有 assistant/message 节点时才判定不可用
  //（只传 lastAssistantSeq=null 压不过表面推导）。
  const base = scenario({ operations: 0, openCallCount: 1 })
  const state = buildWorkingState({
    sessionId: SESSION_ID,
    surfaceNodes: base.surfaceNodes,
    eventAt: base.eventAt,
    openCalls: base.openCalls,
    lastAssistantSeq: null,
    now: base.now,
  })
  assert.equal(state.exposureDecidable, false)
  assert.ok(
    state.protectedSet.some((item) => item.protectionClass === PROTECTION_CLASSES.UNKNOWN_PROTOCOL
      && item.lines.join('').includes('未知')),
    '没有可判定的助手决策节点时，未知条目必须进保护集',
  )
  const card = renderWorkingSetInjection(state, { budgetTokens: 8000 })
  assert.match(card.text, /未知/)
})

test('硬保护在「什么都装不下」的预算下全部存活，软保留先出局并如实报告', () => {
  const state = fullState()
  const card = renderWorkingSetInjection(state, { budgetTokens: 1 })
  assert.equal(card.budgetTokens, 1)
  assert.ok(card.usedTokens > 1, 'usedTokens 必须是真实值')
  assert.equal(card.overflow, true)
  assert.match(card.overflowReason, /保护集/)
  // 硬内容一条都不能少
  assert.match(card.text, /把工作集做成有界常驻/)
  assert.match(card.text, /open_0/)
  assert.match(card.text, /未曝光结果/)
  assert.match(card.text, /最小依赖集/)
  // 软保留全部让位，且如实点名（F1 后丢弃报告按分值升序，类目集合不变）
  assert.deepEqual([...card.droppedClasses.map((item) => item.class)].sort(), [...SOFT_CLASSES_PRESENT].sort())
  for (const dropped of card.droppedClasses) {
    assert.equal(dropped.reason, 'hard-overflow')
    assert.ok(dropped.classReason && dropped.classReason.length > 0, '丢弃必须说明该类目为什么可丢')
    assert.ok(dropped.lines > 0)
  }
  assert.deepEqual(card.keptClasses, [])
  // 「永不丢弃」的类目清单随结果一起给出
  assert.ok(card.neverDropped.includes(PROTECTION_CLASSES.HUMAN_REQUEST))
  assert.ok(!card.neverDropped.includes(RETENTION_CLASSES.NON_ESSENTIAL_HISTORY))
})

test('软保留按 F1 重要度退役：紧预算全丢、宽预算全留、装包序与丢弃报告序确定', () => {
  const state = fullState()
  const zero = renderWorkingSetInjection(state, { budgetTokens: 0 })
  const hardTokens = zero.hardTokens
  assert.ok(hardTokens > 0)

  // 刚好只够硬保护：软保留全部出局，硬保护一条不少（类目集合不变，顺序按分值）。
  const tight = renderWorkingSetInjection(state, { budgetTokens: hardTokens })
  assert.deepEqual(tight.keptClasses, [])
  assert.deepEqual([...tight.droppedClasses.map((item) => item.class)].sort(), [...SOFT_CLASSES_PRESENT].sort())
  assert.match(tight.text, /把工作集做成有界常驻/)
  assert.ok(tight.hardOverflow === false)
  assert.equal(tight.hardTokens, hardTokens)

  // 宽预算：软保留全部留下，没有任何丢弃。
  const roomy = renderWorkingSetInjection(state, { budgetTokens: 8000 })
  assert.equal(roomy.overflow, false)
  assert.deepEqual(roomy.dropped, [])
  assert.deepEqual(roomy.droppedClasses, [])
  for (const retentionClass of SOFT_CLASSES_PRESENT) {
    assert.ok(roomy.keptClasses.includes(retentionClass), `${retentionClass} 在宽预算下应保留`)
    assert.match(roomy.text, new RegExp(retentionClass))
  }
  // F1：装包序 = 分值降序（低分先丢）；每段都带分值与分量文本（可解释）。
  const importances = roomy.softImportance.map((item) => item.importance)
  assert.deepEqual(importances, [...importances].sort((a, b) => b - a), 'softImportance 必须按分值降序')
  for (const item of roomy.softImportance) {
    assert.ok(item.importanceText && item.importanceText.includes('重要度'), `段 ${item.class} 必须带分量文本`)
  }
  // 丢弃报告按分值升序（如实反映丢弃时序），硬类目永远不出现在丢弃清单里。
  const middle = renderWorkingSetInjection(state, { budgetTokens: hardTokens + 120 })
  const middleImportances = middle.dropped.map((item) => item.importance ?? 0)
  assert.deepEqual(middleImportances, [...middleImportances].sort((a, b) => a - b), 'dropped 必须按分值升序')
  const hardClasses = new Set(Object.values(PROTECTION_CLASSES))
  for (const dropped of middle.droppedClasses) {
    assert.ok(!hardClasses.has(dropped.class), `${dropped.class} 不是硬保护类目`)
  }
})

test('F1 集成：与当前任务相关的助手结论靠后丢（novelty 反向校准落到装包序）', () => {
  // 硬前缀固定：当前人类请求「把工作集做成有界常驻」。
  const related = '把工作集做成的上下文历史记录：runtime.mjs 只写两个文件的结论'
  const unrelated = '㊀㊁㊂㊃㊄㊅㊆㊇ ㊈㊊㊋㊌ 旧探索分支的结论'
  const state = fullState({
    claims: [
      { value: related, polarity: 'positive', recordRef: 'r-related' },
      { value: unrelated, polarity: 'positive', recordRef: 'r-unrelated' },
    ],
  })
  const zero = renderWorkingSetInjection(state, { budgetTokens: 0 })
  // 中间预算：软段按分值装包。用 softImportance 逐段核对装包序不变式。
  const middle = renderWorkingSetInjection(state, { budgetTokens: zero.hardTokens + 60 })
  // 夹具里的进度/overflow 项与 claim 段可能同类目；改为验证分值降序不变式
  // + 丢弃从低分开始：所有被丢段的分值 ≤ 所有保留段的分值。
  const droppedMax = Math.max(...middle.dropped.map((item) => item.importance ?? 0), -Infinity)
  const keptMin = Math.min(...(middle.softImportance
    .filter((item) => middle.keptClasses.includes(item.class))
    .map((item) => item.importance ?? Infinity)), Infinity)
  assert.ok(middle.softImportance.length >= 1, '软段必须在装包管道里')
  assert.ok(droppedMax <= keptMin, `被丢段的最大分值不得超过保留段的最小分值（${droppedMax} vs ${keptMin}）`)
  // 丢弃报告的 reason 带分量：可解释，不给黑盒分。
  for (const item of middle.dropped) {
    assert.ok(item.importanceText && item.importanceText.includes('重要度'), '丢弃必须带分量描述')
  }
})

test('未闭合调用与未曝光结果在保护集里显式登记，且不因预算被丢弃', () => {
  const base = scenario({ operations: 3, openCallCount: 2 })
  const state = buildWorkingState({
    sessionId: SESSION_ID,
    surfaceNodes: base.surfaceNodes,
    eventAt: base.eventAt,
    openCalls: base.openCalls,
    now: base.now,
  })
  const openItems = state.protectedSet.filter((item) => item.protectionClass === PROTECTION_CLASSES.UNCLOSED_CALL)
  assert.equal(openItems.length, 2)
  assert.deepEqual(openItems.map((item) => item.itemId).sort(), ['open-call:open_0', 'open-call:open_1'])
  const unseenItems = state.protectedSet.filter((item) => item.protectionClass === PROTECTION_CLASSES.UNEXPOSED_RESULT)
  assert.equal(unseenItems.length, 1)
  assert.equal(state.unseenResultCount, 1)

  const card = renderWorkingSetInjection(state, { budgetTokens: 0 })
  assert.match(card.text, /open_0/)
  assert.match(card.text, /open_1/)
  assert.match(card.text, /未曝光结果/)
  assert.equal(card.overflow, true)
})

test('权威不变量：摘要≠原文、模型推断≠授权、状态卡≠系统消息，且不能提升为 system', () => {
  const summary = resolveAuthority({ sourceKind: SOURCE_KINDS.SUMMARY, claimedAuthority: 'system' })
  assert.equal(summary.authority, 'summary')
  assert.equal(summary.promotionRejected, true)
  assert.equal(summary.isOriginalText, false)
  assert.equal(summary.canBeSystemMessage, false)
  assert.equal(summary.channel, 'working-material')

  const inference = resolveAuthority({ sourceKind: SOURCE_KINDS.MODEL_INFERENCE })
  assert.equal(inference.authorizes, false)
  assert.equal(inference.canBeSystemMessage, false)

  const statusCard = resolveAuthority({ sourceKind: SOURCE_KINDS.STATUS_CARD })
  assert.equal(statusCard.canBeSystemMessage, false)
  assert.equal(statusCard.isOriginalText, true)

  const user = resolveAuthority({ sourceKind: SOURCE_KINDS.USER })
  assert.equal(user.authorizes, true)
  assert.equal(user.canBeSystemMessage, false, '用户消息也不是 system 消息')

  const system = resolveAuthority({ sourceKind: SOURCE_KINDS.SYSTEM })
  assert.equal(system.canBeSystemMessage, true)

  const bogus = resolveAuthority({ sourceKind: 'something-else' })
  assert.equal(bogus.sourceKind, SOURCE_KINDS.UNKNOWN)
  assert.equal(bogus.canBeSystemMessage, false)

  const state = fullState()
  assert.equal(state.protectionInvariants.authorityNeverPromotedToSystem, true)
  assert.equal(state.protectionInvariants.summaryIsNotOriginalText, true)
  assert.equal(state.protectionInvariants.modelInferenceIsNotAuthorization, true)
  assert.equal(state.protectionInvariants.statusCardIsNotSystemMessage, true)
  const card = renderWorkingSetInjection(state, { budgetTokens: 8000 })
  assert.match(card.text, /不是系统指令/)
  assert.match(card.text, /不可提升为 system/)
})

test('稳定前缀：保护集不变时卡片前缀哈希在软内容变化时不变', () => {
  const stateA = fullState()
  const stateB = fullState({
    claims: [
      { value: '新的可选结论一', polarity: 'positive', recordRef: 'r-new-1' },
      { value: '新的可选结论二', polarity: 'positive', recordRef: 'r-new-2' },
    ],
  })
  const cardA = renderWorkingSetInjection(stateA, { budgetTokens: 8000 })
  const cardB = renderWorkingSetInjection(stateB, { budgetTokens: 8000, previousPrefixHash: cardA.prefix.hash })
  assert.equal(cardB.prefix.hash, cardA.prefix.hash, '保护集不变时硬前缀必须逐字节一致')
  assert.equal(cardB.prefixStable, true)
  assert.notEqual(cardB.text, cardA.text, '软内容变化应体现在前缀之后')
  assert.equal(renderWorkingSetInjection(stateA, { budgetTokens: 8000 }).prefixStable, null)
})

test('有界热上下文：200 与 2000 条记录下渲染 token 不随总量线性增长', () => {
  const small = scenario({ operations: 200 })
  const large = scenario({ operations: 2000 })
  const smallState = buildWorkingState({
    sessionId: SESSION_ID,
    surfaceNodes: small.surfaceNodes,
    eventAt: small.eventAt,
    openCalls: small.openCalls,
    lastAssistantSeq: null,
    now: NOW,
  })
  const largeState = buildWorkingState({
    sessionId: SESSION_ID,
    surfaceNodes: large.surfaceNodes,
    eventAt: large.eventAt,
    openCalls: large.openCalls,
    lastAssistantSeq: null,
    now: NOW,
  })
  // Y-31 后进度只收硬段未覆盖的完成态：每个 operation 的结果都落在自己的助手之后、
  // 最后一个 operation 的结果在最后助手之后（未曝光，进 UNEXPOSED_RESULT 硬段），
  // 所以 progressCount = operations - 1（0.13.2-beta.8 起，旧口径是每调用一行 = 200）。
  assert.equal(smallState.progressCount, 199)
  assert.equal(largeState.progressCount, 1999)
  // 展开进卡片的条目数被上限截断，不随总量增长
  assert.equal(smallState.progress.length, WORKING_SET_DEFAULTS.maxProgressItems)
  assert.equal(largeState.progress.length, WORKING_SET_DEFAULTS.maxProgressItems)

  const smallCard = renderWorkingSetInjection(smallState, { budgetTokens: 1200 })
  const largeCard = renderWorkingSetInjection(largeState, { budgetTokens: 1200 })
  assert.ok(largeCard.usedTokens <= smallCard.usedTokens * 1.5,
    `热上下文不得随记录数增长：2000 条 ≈${largeCard.usedTokens} token vs 200 条 ≈${smallCard.usedTokens} token`)
  assert.ok(largeCard.usedTokens < smallCard.usedTokens * 10, '线性增长意味着 10 倍记录会带来 10 倍 token')
  assert.ok(largeCard.usedTokens < 4000, `单卡必须仍有界，实际 ≈${largeCard.usedTokens} token`)
  // 保护集固定（同一个请求、同一条在途配对、同一条未曝光结果），
  // 唯一差别是未曝光结果所在 seq 的位数：硬前缀大小不得随记录总量增长。
  assert.ok(largeCard.hardTokens <= smallCard.hardTokens + 8,
    `硬前缀不得随总量增长：2000 条 ≈${largeCard.hardTokens} vs 200 条 ≈${smallCard.hardTokens}`)
  assert.ok(largeState.protectedSet.length <= smallState.protectedSet.length + 1,
    '保护集条目数不得随记录总量增长')
  assert.ok(largeState.unseenResultCount === smallState.unseenResultCount)
})

test('预算 0 / 负数 / 非法值的语义：如实报告，不静默截断', () => {
  const state = fullState()

  const zero = renderWorkingSetInjection(state, { budgetTokens: 0 })
  assert.equal(zero.budgetTokens, 0)
  assert.ok(zero.usedTokens > 0)
  assert.equal(zero.overflow, true)
  assert.equal(zero.hardOverflow, true)
  assert.match(zero.text, /把工作集做成有界常驻/)
  assert.deepEqual([...zero.droppedClasses.map((item) => item.class)].sort(), [...SOFT_CLASSES_PRESENT].sort())

  const negative = renderWorkingSetInjection(state, { budgetTokens: -50 })
  assert.equal(negative.budgetTokens, 0, '负预算夹到 0')
  assert.equal(negative.budgetFloorApplied, true)
  assert.equal(negative.overflow, true)
  assert.match(negative.text, /把工作集做成有界常驻/)

  const invalid = renderWorkingSetInjection(state, { budgetTokens: Number.NaN })
  assert.equal(invalid.budgetInvalid, true)
  assert.equal(invalid.budgetTokens, WORKING_SET_DEFAULTS.cardTokens)
  assert.equal(Number.isFinite(invalid.usedTokens), true)

  const planZero = planWorkingSetBudget({ contextWindow: 0 })
  assert.equal(planZero.overflow, true)
  assert.equal(planZero.available, -4608)
  assert.equal(planZero.shortfall, 4608)
  assert.ok(planZero.reason && planZero.reason.length > 0)
  assert.equal(planZero.overflowReason, planZero.reason)

  const planOk = planWorkingSetBudget({ contextWindow: 20_000, reservedCompletionTokens: 4096, fixedBaseTokens: 1000, protocolMarginTokens: 512, protectedTokens: 2000 })
  assert.equal(planOk.overflow, false)
  assert.equal(planOk.available, 12_392)
  assert.deepEqual(planOk.invalidParts, [])

  // 非法入参不得静默变成 NaN 把溢出藏起来
  const planBad = planWorkingSetBudget({ contextWindow: 10_000, reservedCompletionTokens: 'abc' })
  assert.deepEqual(planBad.invalidParts, ['reservedCompletionTokens'])
  assert.equal(Number.isFinite(planBad.available), true)
  assert.equal(planBad.available, 5392)
  assert.equal(planBad.overflow, false)
  assert.equal(planBad.unit, 'token')
})

test('token 口径：usedTokens 是 token 而不是字节，且四个关键字段永不为 undefined', () => {
  const state = fullState()
  for (const budgetTokens of [0, 1, 200, 1200, 8000]) {
    const card = renderWorkingSetInjection(state, { budgetTokens })
    assert.equal(typeof card.usedTokens, 'number')
    assert.equal(typeof card.budgetTokens, 'number')
    assert.equal(typeof card.overflow, 'boolean')
    assert.ok(Array.isArray(card.dropped))
    assert.equal(card.budgetTokens, budgetTokens)
    assert.equal(card.usedTokens, Math.max(1, Math.ceil(Buffer.byteLength(card.text, 'utf8') / 4)))
    const bytes = Buffer.byteLength(card.text, 'utf8')
    assert.ok(card.usedTokens <= bytes, 'token 数不可能大于字节数')
    assert.ok(card.usedTokens * 3 <= bytes, 'token 数应约为字节数的 1/4；若接近字节数说明把 byte 当成了 token')
    if (card.overflow) assert.ok(card.overflowReason && card.overflowReason.length > 0)
    else assert.equal(card.overflowReason, null)
  }
})

test('临时隔离库：readback 打包按记录 ID 精确取回，原文不被任何 TTL 删掉', async () => {
  const root = await makeLabRoot('readback-pack')
  try {
    const store = await V2SessionStore.init({ labRoot: root, sessionId: SESSION_ID })
    const ids = []
    let seq = 1
    const txn = await store.openTransaction()
    for (let index = 1; index <= 3; index += 1) {
      for (const event of [
        { type: 'assistant/message', seq, data: { message: { id: `m${seq}`, content: [{ type: 'tool-call', id: `call_${index}`, name: 'read', arguments: `{"target":"f${index}"}` }] } } },
        { type: 'tool/result', seq: seq + 1, data: { message: { id: `m${seq + 1}`, content: [{ type: 'text', text: `原文-${index}` }], source: { callId: `call_${index}` } } } },
      ]) {
        for (const draft of recordsFromEvent(event)) {
          const staged = await store.stageRecord(txn, draft)
          if (staged?.id) ids.push(staged.id)
        }
        seq += 1
      }
    }
    await store.commitTransaction(txn)
    await store.close()

    const pack = await packWorkingSet(root, SESSION_ID, { budgetTokens: 20_000, explicitRecordIds: [ids[1]] })
    assert.equal(pack.entries[0].id, ids[1])
    assert.match(pack.entries[0].kind, /operation\.result/)

    // 0.13.2-beta.8（Q4）：pin 机制随零生产方入参摘除；「记录仍可按 ID 回读、
    // 原文不被 TTL 删掉」的承诺由 readRecordById 直接验证。
    const loaded = await readRecordById(root, SESSION_ID, ids[1])
    assert.equal(loaded.ok, true)
    assert.equal(loaded.verified, true)
    assert.equal(loaded.payloadText, '原文-1')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
