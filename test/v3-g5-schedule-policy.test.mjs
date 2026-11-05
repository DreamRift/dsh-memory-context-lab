/**
 * G5 纯策略与配置合同（0.15.0 候选，**默认关闭**）。
 *
 * 本套件只钉三件事，不碰归档事务：
 * 1. 门槛集中在**一处**配置、**默认关闭**、**非法值失败关闭**（不回退成"看不懂就启用"，
 *    也不静默夹取一个近似阈值）；
 * 2. 显式策略检查的判据与顺序（增长量 / 请求间隔 / 积压合并 / 硬上限防饥饿 / 回退原策略）；
 * 3. 决策是**确定性**的：同输入同输出、无时间戳、不修改调用方状态、不跨会话共享任何东西。
 *
 * 反例在这里逐条给：小步持续增长饥饿、请求序号回拨、配置切换、观测缺失、积压合并、
 * 显式 now 绕节奏门。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  SCHEDULE_POLICY_VERSION,
  normalizeSchedulePolicyConfig,
} from '../src/v3/contracts/archive-schedule-policy.mjs'
import { evaluateSchedulePolicy, nextSchedulePolicyState } from '../src/v3/domain/archive/schedule-policy.mjs'

const CONFIG = Object.freeze({
  enabled: true,
  minGrowthMessages: 5,
  minRequestGap: 3,
  maxRequestGap: 10,
  backlogCoalesceUnits: 20,
})
const FINGERPRINT = normalizeSchedulePolicyConfig(CONFIG).fingerprint

/** 端口形状（已校验）的最小合法输入：只用到 components.messages.count。 */
const inputOf = (count) => ({
  contractVersion: 1,
  session: null,
  window: { fromSeq: 1, toSeq: 2, rows: 2, legacyRows: 0, skippedRows: 0 },
  projection: { epoch: 1, lastPhase: 'append', lastMessageChange: 'appended', phaseCounts: { initial: 0, steady: 0, append: 2, 'epoch-start': 0 } },
  components: { messages: { digest: 'a'.repeat(16), count, generation: 1 }, system: { coverage: 'unobservable' }, tools: { coverage: 'unobservable' } },
  usage: {
    counted: 1, duplicates: 0, late: 0, unknownArrival: 0, unsampledLegacy: 0,
    totals: { inputTokens: null, outputTokens: null, totalTokens: null, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null },
    availability: { inputTokens: 'missing', outputTokens: 'missing', totalTokens: 'missing', cacheReadTokens: 'missing', cacheWriteTokens: 'missing', reasoningTokens: 'missing' },
    cacheReadRatio: null,
    additivity: { provider: null, cacheFieldsAddable: null, reasoningExtraTokens: null, verified: 'unknown' },
  },
  layers: null,
})

const stateOf = ({ ordinal = 7, baseline = 5, baselineCount = 100, fingerprint = FINGERPRINT } = {}) => ({
  contractVersion: 1,
  attemptOrdinal: ordinal,
  lastCommit: { attemptOrdinal: baseline, messagesCount: baselineCount, configFingerprint: fingerprint },
})
const factsOf = ({ pendingUnits = 12, batchSteps = 10, safeSegments = 2 } = {}) => ({ pendingUnits, batchSteps, safeSegments })
const decide = (overrides = {}) => evaluateSchedulePolicy({
  config: CONFIG,
  state: stateOf({ ordinal: 9, baseline: 5, baselineCount: 100 }), // 4 个请求间隔、5 条消息增长
  input: inputOf(105),
  lane: 'auto',
  facts: factsOf(),
  ...overrides,
})

// ---------------------------------------------------------------- 配置合同

test('默认关闭：没有配置 = 候选关闭，决策 disabled 且不改任何判据', () => {
  const normalized = normalizeSchedulePolicyConfig(undefined)
  assert.equal(normalized.ok, true)
  assert.equal(normalized.config.enabled, false, '默认必须关闭（候选不默认上线）')
  assert.equal(SCHEDULE_POLICY_VERSION, 1)
  const decision = evaluateSchedulePolicy({ config: undefined, state: stateOf(), input: inputOf(105), facts: factsOf() })
  assert.equal(decision.decision, 'disabled')
  assert.equal(decision.reason, 'policy-disabled')
  assert.equal(decision.enabled, false)
  // 关闭时不产出策略状态（off 路径零副作用：不往会话存储写计数）
  assert.equal(nextSchedulePolicyState({ config: undefined, state: stateOf(), input: inputOf(105) }), null)
})

test('门槛只有一处：默认值/取值域/指纹都在同一模块，非法值一律 {ok:false}', () => {
  const defaults = normalizeSchedulePolicyConfig(null).config
  assert.deepEqual({ ...defaults }, {
    enabled: false, minGrowthMessages: 8, minRequestGap: 4, maxRequestGap: 40, backlogCoalesceUnits: 30,
  })
  const invalid = [
    { enabled: 'yes' },
    { minGrowthMessages: 0.5 },
    { minGrowthMessages: 401 },
    { minRequestGap: -1 },
    { maxRequestGap: 0 },
    { backlogCoalesceUnits: 0 },
    { minRequestGap: 10, maxRequestGap: 5 },
    { unknownKnob: 1 },
  ]
  for (const raw of invalid) {
    const normalized = normalizeSchedulePolicyConfig(raw)
    assert.equal(normalized.ok, false, '非法配置必须被拒绝：' + JSON.stringify(raw))
    assert.equal(typeof normalized.reason, 'string')
    assert.equal(normalized.config, undefined, '非法配置不得返回"夹取后的配置"')
  }
  assert.equal(normalizeSchedulePolicyConfig([]).ok, false, '数组不是配置对象')
  assert.equal(normalizeSchedulePolicyConfig('on').ok, false)
  // 指纹随任一门槛变化：配置切换能被状态层感知（不会拿旧基线继续判节奏）
  const base = normalizeSchedulePolicyConfig(CONFIG).fingerprint
  for (const change of [{ minGrowthMessages: 6 }, { minRequestGap: 4 }, { maxRequestGap: 11 }, { backlogCoalesceUnits: 21 }]) {
    assert.notEqual(normalizeSchedulePolicyConfig({ ...CONFIG, ...change }).fingerprint, base)
  }
  assert.equal(normalizeSchedulePolicyConfig({ ...CONFIG }).fingerprint, base, '同值同指纹（确定性）')
})

test('非法配置失败关闭：决策 fallback（回退原策略）+ 带出 configError，绝不因此启用候选', () => {
  const decision = evaluateSchedulePolicy({ config: { enabled: 'yes' }, state: stateOf(), input: inputOf(105), facts: factsOf() })
  assert.equal(decision.decision, 'fallback')
  assert.equal(decision.reason, 'policy-config-invalid')
  assert.equal(decision.enabled, false)
  assert.match(decision.configError, /enabled/)
  assert.equal(decision.thresholds, null, '配置非法时不得伪造一套阈值')
  assert.equal(nextSchedulePolicyState({ config: { enabled: 'yes' }, state: stateOf(), input: inputOf(105) }), null)
})

// ---------------------------------------------------------------- 双门判据

test('双门都要满足：增长不足或间隔不足 → defer，并给出各自还差多少', () => {
  // 增长 2 < 5，间隔 4 >= 3 → 仍需等待增长
  const growthShort = decide({ input: inputOf(102) })
  assert.equal(growthShort.decision, 'defer')
  assert.equal(growthShort.reason, 'rhythm-deferred')
  assert.deepEqual(growthShort.needed, { growthMessages: 3, requests: 0 })
  assert.equal(growthShort.scheduled, undefined, '纯策略不冒充"已调度"（由 application 补事实）')
  // 间隔 1 < 3，增长 5 >= 5 → 仍需等待间隔
  const gapShort = decide({ state: stateOf({ ordinal: 6, baseline: 5, baselineCount: 100 }) })
  assert.equal(gapShort.decision, 'defer')
  assert.deepEqual(gapShort.needed, { growthMessages: 0, requests: 2 })
  // 两门都满足 → allow
  const both = decide()
  assert.equal(both.decision, 'allow')
  assert.equal(both.reason, 'rhythm-satisfied')
  assert.equal(both.growthMessages, 5)
  assert.equal(both.requestsSinceCommit, 4)
})

test('请求间隔硬上限：小步持续增长（增长永远差一截）也必须到点调度（防饥饿）', () => {
  // 每步只长 0 条消息、增长门永远差 5，但请求数已到 10（= maxRequestGap）
  const starved = decide({ input: inputOf(100), state: stateOf({ ordinal: 15, baseline: 5, baselineCount: 100 }) })
  assert.equal(starved.decision, 'allow')
  assert.equal(starved.reason, 'request-gap-max')
  assert.equal(starved.requestsSinceCommit, 10)
  assert.equal(starved.growthMessages, 0)
})

test('积压合并：积压达到门槛就合并"调度意图"，判据面里没有任何合并事件/回执的字段', () => {
  const coalesced = decide({ input: inputOf(100), state: stateOf({ ordinal: 6, baseline: 5 }), facts: factsOf({ pendingUnits: 20 }) })
  assert.equal(coalesced.decision, 'allow')
  assert.equal(coalesced.reason, 'backlog-coalesce')
  assert.equal(coalesced.pendingUnits, 20)
  // 只合并"要不要现在调度"：决策对象里不允许出现事件/回执/记录层面的合并动作
  for (const forbidden of ['mergeEvents', 'mergeReceipts', 'mergeRecords', 'receipts', 'events']) {
    assert.equal(Object.prototype.hasOwnProperty.call(coalesced, forbidden), false, '调度决策不得携带内容合并字段：' + forbidden)
  }
})

test('显式 now/compact 绕候选节奏门：manual 通道即使两门都不满足也放行（安全/净收益仍由别处判）', () => {
  const manual = decide({ lane: 'manual', input: inputOf(100), state: stateOf({ ordinal: 5, baseline: 5 }), facts: factsOf() })
  assert.equal(manual.decision, 'allow')
  assert.equal(manual.reason, 'manual-bypass')
  // 预览通道不冒充手动：同样条件仍然 defer
  const preview = decide({ lane: 'preview', input: inputOf(100), state: stateOf({ ordinal: 5, baseline: 5 }), facts: factsOf() })
  assert.equal(preview.decision, 'defer')
})

// ---------------------------------------------------------------- 回退原策略

test('拿不到可信 policy 输入 → 回退原策略并说明原因（观测缺失不让归档停摆）', () => {
  const noCount = decide({ input: inputOf(null) })
  assert.equal(noCount.decision, 'allow')
  assert.equal(noCount.reason, 'policy-input-unavailable')
  const noInput = decide({ input: null })
  assert.equal(noInput.reason, 'policy-input-unavailable')
  const noOrdinal = decide({ state: { contractVersion: 1, attemptOrdinal: null, lastCommit: null } })
  assert.equal(noOrdinal.reason, 'policy-ordinal-unavailable')
  const noFacts = decide({ facts: null })
  assert.equal(noFacts.reason, 'policy-facts-unavailable')
  // 旧行/未接线：整段观察为 null 也不能把"未知"读成"零增长"
  assert.equal(decide({ input: { ...inputOf(1), components: { messages: { digest: null, count: null, generation: null }, system: { coverage: 'unobservable' }, tools: { coverage: 'unobservable' } } } }).reason, 'policy-input-unavailable')
})

// ---------------------------------------------------------------- 状态与污染

test('基线：首次/配置切换/请求序号回拨/活动面变小都按基线重置处理（允许一次并重建）', () => {
  assert.equal(decide({ state: { contractVersion: 1, attemptOrdinal: 7 } }).reason, 'policy-baseline')
  assert.equal(decide({ state: { contractVersion: 1, attemptOrdinal: 7 } }).baselineReset, true)
  // 连请求序号都没有 → 如实报 unavailable（回退原策略），不冒充"首轮基线"
  assert.equal(decide({ state: null }).reason, 'policy-ordinal-unavailable')
  // 配置切换：旧基线按别的指纹记的，不能拿来判新配置的节奏
  const switched = decide({ state: stateOf({ fingerprint: 'ffffffffffffffff' }) })
  assert.equal(switched.reason, 'policy-baseline')
  assert.equal(switched.baselineReset, true)
  // 请求序号回拨（重启/计数回退）：不得用"变小的间隔"判 defer
  const regressed = decide({ state: stateOf({ ordinal: 3, baseline: 5 }) })
  assert.equal(regressed.reason, 'policy-ordinal-regressed')
  assert.equal(regressed.baselineReset, true)
  // 活动面变小（宿主压缩/替换）：旧基线不再可比
  const shrank = decide({ input: inputOf(90) })
  assert.equal(shrank.reason, 'policy-growth-reset')
  assert.equal(shrank.baselineReset, true)
})

test('绝对确定性 + 不修改调用方状态 + 不串会话：同输入同字节、无时间戳', () => {
  const state = stateOf()
  const frozen = JSON.stringify(state)
  const first = JSON.stringify(decide({ state }))
  const second = JSON.stringify(decide({ state }))
  assert.equal(first, second, '同输入必须逐字节相同（证据可重放）')
  assert.equal(JSON.stringify(state), frozen, '纯策略不得修改调用方状态')
  for (const key of ['at', 'now', 'time', 'timestamp', 'Date']) {
    assert.equal(first.includes('"' + key + '"'), false, '决策不得携带时间戳字段：' + key)
  }
  // 两个会话各自的状态互不影响：换一个基线更大的会话，结论跟着它自己走
  const other = decide({ state: stateOf({ ordinal: 100, baseline: 99, baselineCount: 100 }), input: inputOf(101) })
  assert.equal(other.decision, 'defer', '别的会话的计数不能被借来提前调度')
  assert.equal(decide().decision, 'allow')
})

test('提交成功后的新状态：带配置指纹、请求序号与消息数；关闭/缺序号不产出状态', () => {
  const next = nextSchedulePolicyState({ config: CONFIG, state: stateOf(), input: inputOf(105) })
  assert.deepEqual({ ...next }, {
    contractVersion: 1,
    attemptOrdinal: 7,
    lastCommit: { attemptOrdinal: 7, messagesCount: 105, configFingerprint: FINGERPRINT },
  })
  assert.equal(nextSchedulePolicyState({ config: { ...CONFIG, enabled: false }, state: stateOf(), input: inputOf(105) }), null)
  assert.equal(nextSchedulePolicyState({ config: CONFIG, state: { attemptOrdinal: null }, input: inputOf(105) }), null)
  // 产出的状态能被下一次决策当作基线（闭环：commit → baseline → 下一次按节奏判）
  const replay = evaluateSchedulePolicy({
    config: CONFIG,
    state: { ...next, attemptOrdinal: 8 },
    input: inputOf(105),
    facts: factsOf(),
  })
  assert.equal(replay.decision, 'defer', '刚提交过：增长 0、间隔 1，必须等')
  assert.equal(replay.growthMessages, 0)
  assert.equal(replay.requestsSinceCommit, 1)
})
