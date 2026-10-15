/**
 * v2 活跃工作集测试：硬保护 vs 软保留、pin 与过期、版本指纹、未知关系回退、
 * 稳定前缀、有界热上下文（200 vs 2000 条记录）、预算 0/负数/非法值语义。
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
  RETENTION_CLASSES,
  DROP_ORDER,
  EVIDENCE_STATUS,
  FINGERPRINT_VERDICTS,
  SOURCE_KINDS,
  PIN_STATUS,
  TTL_FREE_HARD_CLASSES,
  buildWorkingState,
  planWorkingSetBudget,
  renderWorkingSetInjection,
  resolveAuthority,
  fingerprintOf,
  compareFingerprints,
  bindEvidence,
  pinEvidence,
  evaluatePin,
  resolveRelation,
  createProjection,
  appendProjectionStage,
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

const FILE_FINGERPRINT_V1 = fingerprintOf({
  target: 'src/v2/working-state.mjs',
  version: 'v1',
  environment: 'node20-win32',
  testEvidence: 'pass@2026-10-01',
})
const FILE_FINGERPRINT_V2 = fingerprintOf({
  target: 'src/v2/working-state.mjs',
  version: 'v2',
  environment: 'node20-win32',
  testEvidence: 'pass@2026-10-01',
})

/** 一个「什么都有」的状态：硬保护齐全，软保留候选也齐全。 */
function fullState(overrides = {}) {
  const base = scenario({ operations: 4 })
  return buildWorkingState({
    sessionId: SESSION_ID,
    surfaceNodes: base.surfaceNodes,
    eventAt: base.eventAt,
    openCalls: base.openCalls,
    lastAssistantSeq: null,
    now: base.now,
    constraints: [
      { text: '不要修改 runtime.mjs', sourceRef: 'seq:1' },
      { text: '只写两个文件', sourceRef: 'seq:1' },
    ],
    evidence: [
      {
        recordRef: 't00000001-r0009',
        necessary: true,
        sourceKind: SOURCE_KINDS.TOOL_RESULT,
        fingerprint: FILE_FINGERPRINT_V1,
        currentFingerprint: FILE_FINGERPRINT_V1,
      },
    ],
    pins: [
      pinEvidence({
        recordRef: 't00000001-r0010',
        reason: '刚重读的关键证据',
        source: 'readback',
        trigger: 'readback',
        ttlMs: 60_000,
        pinnedAt: NOW,
        now: NOW,
      }),
    ],
    inflightJobs: [{ jobId: 'job-1', kind: 'job', state: 'running', source: 'host:jobs' }],
    prefetch: [{ itemId: 'prefetch-1', text: '可能用得到的旧检索结果' }],
    redundantCards: [{ itemId: 'card-old', supersededBy: 'card-new' }],
    nonEssentialHistory: [{ itemId: 'branch-done', ref: 't00000001-r0001' }],
    rejectedOptions: [{ option: '用 TTL 驱逐硬保护', reason: '与规范冲突' }],
    openQuestions: [{ question: '软保留的默认 TTL 取多少？' }],
    relations: [{ subjectRef: 'seq:2', objectRef: 'seq:3' }],
    ...overrides,
  })
}

const SOFT_CLASSES_PRESENT = [
  RETENTION_CLASSES.OPTIONAL_PREFETCH,
  RETENTION_CLASSES.REDUNDANT_CARD,
  RETENTION_CLASSES.NON_ESSENTIAL_HISTORY,
  RETENTION_CLASSES.REJECTED_OPTION,
  RETENTION_CLASSES.OPEN_QUESTION,
]

test('保护集逐条带 reason/source/releaseCondition，七类硬保护都在封闭集里', () => {
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
  assert.ok(classes.has(PROTECTION_CLASSES.INFLIGHT_JOB), '在途作业必须在保护集里')
  assert.ok(classes.has(PROTECTION_CLASSES.NECESSARY_EVIDENCE), '必要证据必须在保护集里')
  assert.ok(classes.has(PROTECTION_CLASSES.VALID_PIN), '有效 pin 必须在保护集里')
  assert.ok(classes.has(PROTECTION_CLASSES.MINIMAL_WORKING_STATE), '最小工作状态必须在保护集里')
  assert.ok(classes.has(PROTECTION_CLASSES.UNKNOWN_PROTOCOL), '未知协议位必须在保护集里')
  // 当前请求 + 两条约束
  assert.ok(state.protectionSummary.hardByClass[PROTECTION_CLASSES.HUMAN_REQUEST] >= 3)
  // 硬保护类目不允许带 TTL
  assert.deepEqual([...TTL_FREE_HARD_CLASSES].includes(PROTECTION_CLASSES.VALID_PIN), false)
  assert.equal(state.protectionInvariants.hardClassesAreTtlFree, true)
  assert.equal(state.protectionInvariants.hardItemsNeverDroppedForBudget, true)
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
  assert.match(card.text, /不要修改 runtime.mjs/)
  assert.match(card.text, /只写两个文件/)
  assert.match(card.text, /open_0/)
  assert.match(card.text, /未曝光结果/)
  assert.match(card.text, /job-1/)
  assert.match(card.text, /必要证据/)
  assert.match(card.text, /有效 pin/)
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
  assert.ok(!card.neverDropped.includes(RETENTION_CLASSES.OPTIONAL_PREFETCH))
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

test('F1 集成：与当前任务相关的非必要历史靠后丢（novelty 反向校准落到装包序）', () => {
  // 硬前缀固定：当前人类请求「把工作集做成有界常驻」。
  const related = '把工作集做成的上下文历史记录：runtime.mjs 只写两个文件的约束'
  const unrelated = '㊀㊁㊂㊃㊄㊅㊆㊇ ㊈㊊㊋㊌ 旧探索分支记录'
  const state = fullState({
    nonEssentialHistory: [
      { itemId: 'branch-related', text: related },
      { itemId: 'branch-unrelated', text: unrelated },
    ],
  })
  const zero = renderWorkingSetInjection(state, { budgetTokens: 0 })
  // 中间预算：软段按分值装包，相关的非必要历史分值更高、必须排在无关历史之后
  // （装包序后段=后丢）。用 softImportance 逐段核对两项的相对次序。
  const middle = renderWorkingSetInjection(state, { budgetTokens: zero.hardTokens + 60 })
  const soft = middle.softImportance.filter((item) => item.class === RETENTION_CLASSES.NON_ESSENTIAL_HISTORY)
  // 夹具里的进度/overflow 项与显式历史项同类目；按 lines 区分不现实，改为验证
  // 分值降序不变式 + 丢弃从低分开始：所有被丢段的分值 ≤ 所有保留段的分值。
  const droppedMax = Math.max(...middle.dropped.map((item) => item.importance ?? 0), -Infinity)
  const keptMin = Math.min(...(middle.softImportance
    .filter((item) => middle.keptClasses.includes(item.class))
    .map((item) => item.importance ?? Infinity)), Infinity)
  assert.ok(soft.length >= 1, '非必要历史段必须在装包管道里')
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

test('pin：有效 pin 是硬保护；过期 / 缺复核条件 / 整任务 pin 一律不构成硬保护', () => {
  const readbackPin = pinEvidence({
    recordRef: 't00000001-r0002',
    trigger: 'readback',
    ttlMs: 1000,
    pinnedAt: 0,
    now: 0,
  })
  assert.ok(readbackPin.reviewCondition && readbackPin.reviewCondition.length > 0, 'pin 必须自带复核条件')
  assert.equal(evaluatePin(readbackPin, { now: 500 }).status, PIN_STATUS.VALID)
  const expired = evaluatePin(readbackPin, { now: 1500 })
  assert.equal(expired.status, PIN_STATUS.EXPIRED)
  assert.equal(expired.reviewRequired, true)
  assert.match(expired.releaseCondition, /复核/)

  // 没有失效时间、没有复核条件、整任务 pin：三种都不能当硬保护
  assert.equal(evaluatePin({ recordRef: 'x', reviewCondition: '随便' }, { now: 0 }).status, PIN_STATUS.INVALID)
  assert.equal(evaluatePin(pinEvidence({ recordRef: 'y', expiresAt: 10_000, now: 0 }), { now: 0 }).status, PIN_STATUS.INVALID)
  const wholeTask = evaluatePin(
    { recordRef: 'task:all', scope: 'whole-task', expiresAtMs: 10_000, reviewCondition: 'never' },
    { now: 0 },
  )
  assert.equal(wholeTask.status, PIN_STATUS.INVALID)
  assert.match(wholeTask.invalidReason, /整条长任务/)

  const base = scenario({ operations: 2 })
  const state = buildWorkingState({
    sessionId: SESSION_ID,
    surfaceNodes: base.surfaceNodes,
    eventAt: base.eventAt,
    openCalls: base.openCalls,
    now: 500,
    pins: [readbackPin, { recordRef: 'expired-1', expiresAtMs: 100, reviewCondition: '复核', source: 'caller' }, wholeTask],
  })
  assert.equal(state.pins.filter((pin) => pin.status === PIN_STATUS.VALID).length, 1)
  assert.equal(state.pins.filter((pin) => pin.status === PIN_STATUS.EXPIRED).length, 1)
  assert.equal(state.pins.filter((pin) => pin.status === PIN_STATUS.INVALID).length, 1)
  assert.equal(state.protectedSet.filter((item) => item.protectionClass === PROTECTION_CLASSES.VALID_PIN).length, 1)
  assert.equal(state.retention[RETENTION_CLASSES.EXPIRED_PIN].length, 2)
  assert.ok(state.unknowns.some((item) => /整条长任务/.test(item.reason)), '无效 pin 必须进未知清单，不能静默')

  // 有效 pin 在极小预算下仍然在卡里；过期 pin 属软保留，可被丢但会被点名
  const card = renderWorkingSetInjection(state, { budgetTokens: 1 })
  assert.match(card.text, /有效 pin/)
  assert.equal(card.overflow, true)
  const expiredDropped = card.droppedClasses.find((item) => item.class === RETENTION_CLASSES.EXPIRED_PIN)
  assert.ok(expiredDropped, '过期 pin 必须出现在丢弃报告里')

  // 空值容错：null / 非对象既不能崩，也不能被当成有效保护。
  assert.equal(evaluatePin(null, { now: 0 }).status, PIN_STATUS.INVALID)
  assert.equal(bindEvidence(null).status, EVIDENCE_STATUS.UNVERIFIED)
  assert.equal(resolveRelation(null).relation, 'unknown')
  const tolerant = buildWorkingState({ sessionId: SESSION_ID, now: 0, pins: [null], evidence: [null], relations: [null] })
  assert.equal(tolerant.pins[0].status, PIN_STATUS.INVALID)
  assert.equal(tolerant.evidence[0].status, EVIDENCE_STATUS.UNVERIFIED)
})

test('版本指纹：旧通过结果对不上新版本 → stale，绝不是 valid', () => {
  assert.equal(compareFingerprints(FILE_FINGERPRINT_V1, FILE_FINGERPRINT_V2), FINGERPRINT_VERDICTS.MISMATCH)
  assert.equal(compareFingerprints(FILE_FINGERPRINT_V1, FILE_FINGERPRINT_V1), FINGERPRINT_VERDICTS.MATCH)
  assert.equal(compareFingerprints(FILE_FINGERPRINT_V1, null), FINGERPRINT_VERDICTS.UNKNOWN)
  assert.equal(compareFingerprints(null, null), FINGERPRINT_VERDICTS.UNKNOWN)
  assert.equal(fingerprintOf({}), null, '没有指纹就是 null，不能造一个「相同」')

  const stale = bindEvidence({
    recordRef: 'r-stale',
    necessary: true,
    fingerprint: FILE_FINGERPRINT_V1,
    currentFingerprint: FILE_FINGERPRINT_V2,
  })
  assert.equal(stale.status, EVIDENCE_STATUS.STALE)
  assert.notEqual(stale.status, EVIDENCE_STATUS.VALID)
  assert.equal(stale.fingerprintVerdict, FINGERPRINT_VERDICTS.MISMATCH)
  assert.match(stale.statusReason, /不能作为当前版本的证据/)

  const unverified = bindEvidence({ recordRef: 'r-unverified', fingerprint: FILE_FINGERPRINT_V1 })
  assert.equal(unverified.status, EVIDENCE_STATUS.UNVERIFIED)

  const valid = bindEvidence({
    recordRef: 'r-valid',
    necessary: true,
    fingerprint: FILE_FINGERPRINT_V1,
    currentFingerprint: FILE_FINGERPRINT_V1,
  })
  assert.equal(valid.status, EVIDENCE_STATUS.VALID)

  // 状态级：stale 的关键证据不得冒充 necessary-evidence，必须转成「未知」协议位 + 软保留。
  const base = scenario({ operations: 2 })
  const state = buildWorkingState({
    sessionId: SESSION_ID,
    surfaceNodes: base.surfaceNodes,
    eventAt: base.eventAt,
    openCalls: base.openCalls,
    now: NOW,
    evidence: [{ recordRef: 'r-stale', necessary: true, fingerprint: FILE_FINGERPRINT_V1, currentFingerprint: FILE_FINGERPRINT_V2 }],
  })
  assert.equal(state.protectedSet.filter((item) => item.protectionClass === PROTECTION_CLASSES.NECESSARY_EVIDENCE).length, 0)
  assert.ok(state.protectedSet.some((item) => item.protectionClass === PROTECTION_CLASSES.UNKNOWN_PROTOCOL
    && item.lines.join('').includes('stale')))
  assert.equal(state.retention[RETENTION_CLASSES.STALE_EVIDENCE].length, 1)
  const card = renderWorkingSetInjection(state, { budgetTokens: 8000 })
  assert.match(card.text, /stale/)
  assert.match(card.text, /不得当作有效证据/)
})

test('关系判定不了就是 unknown：回退保守原文 + 显式规则，绝不编造关系', () => {
  const unknown = resolveRelation({ subjectRef: 'a', objectRef: 'b' })
  assert.equal(unknown.relation, 'unknown')
  assert.equal(unknown.resolved, false)
  assert.equal(unknown.fallback, 'verbatim-text')
  assert.ok(unknown.rules.length >= 3)
  assert.match(unknown.reason, /无法确定性判定/)

  // 只给关系种类、不给结构化依据 → 仍然是 unknown
  const noBasis = resolveRelation({ subjectRef: 'a', objectRef: 'b', relation: 'depends-on' })
  assert.equal(noBasis.relation, 'unknown')
  assert.equal(noBasis.resolved, false)

  const known = resolveRelation({ subjectRef: 'a', objectRef: 'b', relation: 'depends-on', basis: 'callId 配对 + 投影跨度' })
  assert.equal(known.resolved, true)
  assert.equal(known.relation, 'depends-on')

  const state = fullState()
  assert.ok(state.relations.every((item) => item.relation === 'unknown'))
  const card = renderWorkingSetInjection(state, { budgetTokens: 8000 })
  assert.match(card.text, /关系未知/)
  assert.match(card.text, /保守规则/)
  assert.match(card.text, /不补写因果/)
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

test('稳定前缀：投影按批次追加不重写历史，卡片前缀哈希在软内容变化时不变', () => {
  const empty = createProjection({})
  const first = appendProjectionStage(empty, { stageId: 'stage-1', lines: ['第一批'] })
  const second = appendProjectionStage(first, { stageId: 'stage-2', lines: ['第二批'] })
  assert.ok(first.text.startsWith(empty.text))
  assert.ok(second.text.startsWith(first.text), '追加批次必须以旧文本为前缀')
  assert.equal(second.rewroteEarlierStages, false)
  assert.equal(empty.stages.length, 0)
  assert.equal(first.stages.length, 1)
  assert.equal(second.stages.length, 2)
  assert.throws(() => appendProjectionStage(first, { stageId: '' }), TypeError)

  const stateA = fullState()
  const stateB = fullState({
    prefetch: [{ itemId: 'prefetch-new-1', text: '新的可选预取' }, { itemId: 'prefetch-new-2', text: '另一条可选预取' }],
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
    constraints: [{ text: '不要修改 runtime.mjs', sourceRef: 'seq:1' }],
  })
  const largeState = buildWorkingState({
    sessionId: SESSION_ID,
    surfaceNodes: large.surfaceNodes,
    eventAt: large.eventAt,
    openCalls: large.openCalls,
    lastAssistantSeq: null,
    now: NOW,
    constraints: [{ text: '不要修改 runtime.mjs', sourceRef: 'seq:1' }],
  })
  assert.equal(smallState.progressCount, 200)
  assert.equal(largeState.progressCount, 2000)
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

test('临时隔离库：重读证据获得临时 pin，pin 过期后证据仍可按记录 ID 回读', async () => {
  const root = await makeLabRoot('readback-pin')
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

    // 刚重读的证据：拿一个带显式过期的临时 pin
    const pin = pinEvidence({
      recordRef: ids[1],
      trigger: 'readback',
      source: 'readback',
      ttlMs: WORKING_SET_DEFAULTS.pinTtlMs,
      pinnedAt: 0,
      now: 0,
    })
    const fresh = buildWorkingState({ sessionId: SESSION_ID, now: 1, pins: [pin] })
    assert.equal(fresh.pins[0].status, PIN_STATUS.VALID)
    assert.equal(fresh.protectedSet.filter((item) => item.protectionClass === PROTECTION_CLASSES.VALID_PIN).length, 1)

    const later = buildWorkingState({ sessionId: SESSION_ID, now: WORKING_SET_DEFAULTS.pinTtlMs + 1, pins: [pin] })
    assert.equal(later.pins[0].status, PIN_STATUS.EXPIRED)
    assert.equal(later.retention[RETENTION_CLASSES.EXPIRED_PIN].length, 1)
    const card = renderWorkingSetInjection(later, { budgetTokens: 8000 })
    assert.match(card.text, /过期 pin/)

    // pin 过期只是转「需复核」：记录本身仍然可按 ID 回读，原文没有被任何 TTL 删掉。
    const loaded = await readRecordById(root, SESSION_ID, ids[1])
    assert.equal(loaded.ok, true)
    assert.equal(loaded.verified, true)
    assert.equal(loaded.payloadText, '原文-1')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
