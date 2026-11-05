/**
 * 归档调度候选（G5）的**纯策略**：要不要"现在"调度一次，以及在什么理由下调度。
 *
 * ## 它不做什么（边界比功能更重要）
 * - **不选候选**：安全闭包、保护洞、工具闭包、当前回合/工作集、H=200 全部由
 *   `domain/archive/steps.mjs` 决定，本模块在它**之后**才被调用；
 * - **不做净收益判断**：回执 vs 原文的正净字符收益仍只有 `application/archive.mjs`
 *   的 `makePlan` 一处；
 * - **不提交任何东西**：不碰 intent/voucher/宿主面，不写盘、不读盘；
 * - **不读诊断日志**：只用调用方按 `contracts/observation-policy-port.mjs`（G3 的
 *   `POLICY_INPUT_PORT`）校验过的**汇总**形状，以及调用方给的可解释请求序号。
 *
 * ## 时间语义（为什么不用墙钟）
 * 「请求间隔」用**可解释请求序号**（`state.attemptOrdinal`，一次真实逻辑请求 +1，
 * 对齐 G3 的 attempt 语义）而不是 `Date.now()`：墙钟会回拨、重启会跳变，而请求序号
 * 的单调性由调用方按"每次真实请求"推进，重试/取消不额外触发。序号回退（重启/回拨）
 * 按**基线重置**处理：允许本次调度并重建基线，绝不用一个变小的间隔去判 defer。
 *
 * ## 状态与污染
 * 状态由调用方按会话持有（`{contractVersion, attemptOrdinal, lastCommit}`），
 * 本模块只读不写；提交成功后用 `nextSchedulePolicyState` 产出新状态交给调用方持久化。
 * - 不同会话各自持有一份（本模块不存全局变量，天然不串会话）；
 * - 配置切换：`lastCommit.configFingerprint` 与当前配置指纹不符 → 基线重置；
 * - 重启：状态丢失 ⇒ 基线为 null ⇒ 允许一次调度并重建基线（安全方向）。
 *
 * ## 失败方向
 * 拿不到可信输入（请求序号缺失、端口 `messages.count` 为 null、调用方没给事实）时
 * **回退原策略**（= 允许，走 0.15.0 既有行为）并在 `reason` 里写明原因：
 * 观测缺失不能让归档停摆，也不能反过来"因为观测缺失就更激进"。
 * 配置非法时同样回退原策略（候选保持关闭），并把 `configError` 如实带出。
 */
import { SCHEDULE_POLICY_VERSION, normalizeSchedulePolicyConfig } from '../../contracts/archive-schedule-policy.mjs'
import { deepFreeze } from '../../shared/deep-freeze.mjs'

/** 每个原因码一句中文说明（命令面/证据直接引用，不在这里拼文案）。 */
const REASON_NOTES = Object.freeze({
  'policy-disabled': '调度候选已关闭（默认），按 0.15.0 原有节奏归档',
  'policy-config-invalid': '调度候选配置非法：候选保持关闭，按原策略归档（失败关闭）',
  'manual-bypass': '显式 now/compact：可绕候选节奏门，仍不绕安全与正净收益',
  'policy-baseline': '没有可比基线（首次启用/配置切换/重启），本次按原策略调度并重建基线',
  'policy-growth-reset': '活动面消息数比基线更小（归档后变短/宿主压缩）：重建基线，本次仍按节奏门判定，不当作「已达增长门槛」',
  'policy-ordinal-regressed': '请求序号回退（重启或计数回拨），重建基线，不用变小的时间隔判等待',
  'policy-ordinal-unavailable': '拿不到可解释的请求序号，回退原策略',
  'policy-input-unavailable': 'policy 端口没有可信的 messages.count，回退原策略',
  'policy-facts-unavailable': '调用方没有给出候选/积压事实，回退原策略',
  'rhythm-satisfied': '增长量与请求间隔都达到门槛，允许调度',
  'backlog-coalesce': '积压达到合并门槛：合并**调度意图**（段/回执/事件不合并）',
  'request-gap-max': '请求间隔达到硬上限，允许调度（防小步持续增长饥饿）',
  'rhythm-deferred': '增长量或请求间隔未达门槛，本次不调度（数据与安全候选原样保留）',
})

/**
 * 非负整数或 null（null = 未知，不是 0）。
 *
 * @param {unknown} value
 * @returns {number|null}
 */
function integerOrNull(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null
}

/**
 * 端口里的"活动面消息条数"（`components.messages.count`）；缺失即 null。
 *
 * @param {object|null} input 已由 POLICY_INPUT_PORT 校验过的汇总
 * @returns {number|null}
 */
function messagesCountOf(input) {
  if (input === null || typeof input !== 'object') return null
  return integerOrNull(input.components?.messages?.count)
}

/**
 * 归一化后的上一次提交基线。配置指纹不符（配置切换）或字段缺失 → null（基线重置）。
 *
 * @param {object|null} state 调用方持有的策略状态
 * @param {string} fingerprint 当前配置指纹
 * @returns {{attemptOrdinal:number, messagesCount:number|null}|null}
 */
function baselineOf(state, fingerprint) {
  const last = state?.lastCommit
  if (last === null || typeof last !== 'object' || Array.isArray(last)) return null
  const ordinal = integerOrNull(last.attemptOrdinal)
  if (ordinal === null) return null
  if (typeof last.configFingerprint !== 'string' || last.configFingerprint !== fingerprint) return null
  return { attemptOrdinal: ordinal, messagesCount: integerOrNull(last.messagesCount) }
}

/**
 * 显式策略检查：安全候选已经选出、还没做回执/净收益之前调用。
 *
 * @param {object} params
 * @param {unknown} params.config 原始配置（本函数内做归一化，调用方不必先校验）
 * @param {object|null} [params.state] 调用方持有的策略状态
 * @param {object|null} [params.input] 已校验的 policy 端口输入（G3）
 * @param {'auto'|'preview'|'manual'} [params.lane] 调用通道
 * @param {{pendingUnits:number|null, batchSteps:number|null, safeSegments:number|null}|null} [params.facts]
 * @returns {object} 确定性决策对象（无时间戳；同输入同输出）
 */
export function evaluateSchedulePolicy({ config, state = null, input = null, lane = 'auto', facts = null } = {}) {
  const normalized = normalizeSchedulePolicyConfig(config)
  const decision = {
    version: SCHEDULE_POLICY_VERSION,
    lane: lane === 'manual' ? 'manual' : (lane === 'preview' ? 'preview' : 'auto'),
    enabled: false,
    decision: 'allow',
    reason: 'policy-baseline',
    note: '',
    configFingerprint: null,
    configError: null,
    thresholds: null,
    attemptOrdinal: null,
    requestsSinceCommit: null,
    growthMessages: null,
    growthObserved: null,
    pendingUnits: null,
    batchSteps: null,
    safeSegments: null,
    baselineReset: false,
  }
  /** @param {'allow'|'defer'|'fallback'|'disabled'} kind @param {string} reason @returns {object} */
  const verdict = (kind, reason) => ({ ...decision, decision: kind, reason, note: REASON_NOTES[reason] ?? '' })
  if (normalized.ok !== true) {
    return { ...verdict('fallback', 'policy-config-invalid'), configError: normalized.reason }
  }
  const settings = normalized.config
  decision.configFingerprint = normalized.fingerprint
  decision.thresholds = {
    minGrowthMessages: settings.minGrowthMessages,
    minRequestGap: settings.minRequestGap,
    maxRequestGap: settings.maxRequestGap,
    backlogCoalesceUnits: settings.backlogCoalesceUnits,
  }
  if (settings.enabled !== true) return verdict('disabled', 'policy-disabled')
  decision.enabled = true
  // 显式 now/compact：绕的是**节奏门**，安全/净收益/上限一律不绕（由调用方保证其余判据不变）。
  if (decision.lane === 'manual') return verdict('allow', 'manual-bypass')
  if (facts === null || typeof facts !== 'object' || integerOrNull(facts.pendingUnits) === null) {
    return verdict('allow', 'policy-facts-unavailable')
  }
  decision.pendingUnits = integerOrNull(facts.pendingUnits)
  decision.batchSteps = integerOrNull(facts.batchSteps)
  decision.safeSegments = integerOrNull(facts.safeSegments)
  const ordinal = integerOrNull(state?.attemptOrdinal)
  decision.attemptOrdinal = ordinal
  if (ordinal === null) return verdict('allow', 'policy-ordinal-unavailable')
  const baseline = baselineOf(state, decision.configFingerprint)
  if (baseline === null) return { ...verdict('allow', 'policy-baseline'), baselineReset: true }
  const requestsSinceCommit = ordinal - baseline.attemptOrdinal
  decision.requestsSinceCommit = requestsSinceCommit
  if (requestsSinceCommit < 0) {
    return { ...verdict('allow', 'policy-ordinal-regressed'), baselineReset: true }
  }
  const currentCount = messagesCountOf(input)
  if (currentCount === null) return verdict('allow', 'policy-input-unavailable')
  if (baseline.messagesCount === null) return { ...verdict('allow', 'policy-baseline'), baselineReset: true }
  const observedGrowth = currentCount - baseline.messagesCount
  // P3-05（0.15.1 §3.3）：负增长**不是**「已达增长门槛」。
  // 活动面变小有两个来源：宿主压缩/替换（旧基线不可比），以及**归档自己把消息摘走了**。
  // 旧实现把两种情况都当成 reason='allow' + 基线重置直接放行：归档刚摘掉一批消息，
  // 下一次评估就看见 growth<0 → 立刻允许再归档，minGrowthMessages / minRequestGap
  // 这对节奏门被完全绕过（等于「越归档越容易继续归档」）。
  // 现在：仍然重建基线（旧计数确实不可比），但把**本次**增长按 0 计，继续走原有门序——
  // maxRequestGap 的防饥饿与积压合并照旧生效，节奏门不再被负增长短路。
  const growthReset = observedGrowth < 0
  const growthMessages = growthReset ? 0 : observedGrowth
  decision.growthMessages = growthMessages
  // 观测值单独保留（证据面要能看出「这次是因为变短才按 0 计」，不是凭空少了增长）。
  decision.growthObserved = observedGrowth
  decision.baselineReset = growthReset
  // 顺序固定（证据可重放）：硬上限防饥饿 → 积压合并 → 双门同时满足才放行。
  if (requestsSinceCommit >= settings.maxRequestGap) return verdict('allow', 'request-gap-max')
  if (decision.pendingUnits >= settings.backlogCoalesceUnits) return verdict('allow', 'backlog-coalesce')
  if (growthMessages >= settings.minGrowthMessages && requestsSinceCommit >= settings.minRequestGap) {
    return verdict('allow', 'rhythm-satisfied')
  }
  // 负增长导致的 defer 要报**自己的原因码**：否则证据面只看到「增长不够」，
  // 看不出「活动面变短、本次按 0 计」这一事实（会被误读成真的没增长）。
  if (growthReset) {
    return {
      ...verdict('defer', 'policy-growth-reset'),
      needed: {
        growthMessages: Math.max(0, settings.minGrowthMessages - growthMessages),
        requests: Math.max(0, settings.minRequestGap - requestsSinceCommit),
      },
    }
  }
  // 等待也要如实说明差多少：两个门槛各自的距离（不是"暂时不压"一句）。
  return {
    ...verdict('defer', 'rhythm-deferred'),
    needed: {
      growthMessages: Math.max(0, settings.minGrowthMessages - growthMessages),
      requests: Math.max(0, settings.minRequestGap - requestsSinceCommit),
    },
  }
}

/**
 * 提交成功后产出的新策略状态（交给调用方按会话持久化；本模块不写盘）。
 *
 * 只有「候选已启用且配置合法」才产出状态：关闭时不产生任何状态，避免把未启用候选的
 * 计数写进会话存储（off 路径零副作用）。请求序号由调用方推进（一次真实请求 +1）。
 *
 * @param {object} params
 * @param {unknown} params.config 原始配置
 * @param {object|null} [params.state] 调用方持有的策略状态
 * @param {object|null} [params.input] 已校验的 policy 端口输入（G3）
 * @returns {object|null}
 */
export function nextSchedulePolicyState({ config, state = null, input = null } = {}) {
  const normalized = normalizeSchedulePolicyConfig(config)
  if (normalized.ok !== true || normalized.config.enabled !== true) return null
  const ordinal = integerOrNull(state?.attemptOrdinal)
  if (ordinal === null) return null
  return deepFreeze({
    contractVersion: SCHEDULE_POLICY_VERSION,
    attemptOrdinal: ordinal,
    lastCommit: {
      attemptOrdinal: ordinal,
      messagesCount: messagesCountOf(input),
      configFingerprint: normalized.fingerprint,
    },
  })
}
