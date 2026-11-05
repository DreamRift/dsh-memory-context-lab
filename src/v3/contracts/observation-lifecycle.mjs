/**
 * G3 生命周期关联合同（0.15.0，关联合同 v1）——**纯函数、零外部依赖**。
 *
 * ## 要解决的事
 * 开发流程 §9.4：用 **session / provider / model / logical request / attempt** 关联一次请求的
 * 生命周期，并覆盖 retry、取消、流式完成、usage 迟到/乱序。三个硬约束：
 *
 * 1. **宿主没有原生请求 ID**（P0 §2.9：`assistant/message` 只有 turn/step/usage/source；
 *    `llm/stream` 的 options 也没有 requestId）。因此本合同的每个引用都标
 *    `source: 'local-diagnostic'`——它是**本地诊断 ID**，由 (会话, turn, step, attempt,
 *    provider, model) 纯函数派生，可重算、不含正文，**不得**被说成宿主原生关联。
 * 2. **不能时间相近强配**。配对键只有语义键（turn/step/attempt）；时间戳只作为观测值
 *    `at` 出现在行里，**不参与**任何配对判定。usage 迟到时仍归它自己的 attempt，
 *    绝不并入「当时正在进行的那个 attempt」。
 * 3. **工具重试不是一次请求**：同一步内每次 llm 调用 = 一个新 attempt（index 严格递增、
 *    不复用）。因此「同一 turn:step 的两条 usage 观测」是两次尝试，不是一次请求的重复计数。
 *
 * ## usage 只数一次（one-sample-per-attempt）
 * 流式响应可能分多个 chunk 各带一份 usage。合同不改写供应商语义，只定一条**保守**规则：
 * 同一个 attempt 的 usage 只认**一份**样本（第一条到达的），后续 chunk 标
 * `usageArrival.state='duplicate'` 且 `counted:false`；**绝不累加**。
 * 迟到的样本仍 `counted:true`（它是该 attempt 唯一的样本），只是 `state='late'`。
 * 汇总方（如 `readObservationPolicyInput`）只对 `counted:true` 求和，因此不会双计。
 *
 * ## 不适用条件
 * - 不产供应商语义（不判断"这次调用是否命中缓存"）；
 * - 不推断重试原因、不做退避策略、不改任何调度；
 * - 不读宿主对象、不读盘；本地 ID 的输入来自调用方（entry / fake port）。
 */
import { deepFreeze } from '../shared/deep-freeze.mjs'
import { fnv1a64Of } from '../shared/fnv1a64.mjs'

/** 关联合同版本（字段/枚举有变动才动它）。 */
export const LIFECYCLE_CONTRACT_VERSION = 1

/** attempt 的终态（`unknown` 是**未给**，不是「成功」；usage 行默认未知，等宿主/接线方给）。 */
export const ATTEMPT_STATES = Object.freeze(['completed', 'failed', 'cancelled', 'unknown'])

/** usage 样本的到达性质（`duplicate` 不计数；`late` 仍属于它自己的 attempt）。 */
export const USAGE_ARRIVAL_STATES = Object.freeze(['first', 'duplicate', 'late', 'unknown'])

/** 配对结论：只有「会话 + turn/step + attempt 都在」才算 paired。 */
export const OBSERVATION_CORRELATION_STATES = Object.freeze(['paired', 'unpaired'])

/** 记 unpaired 的**具体**原因（不写"配对失败"这种含糊话）。 */
export const CORRELATION_REASONS = Object.freeze(['session-missing', 'turn-step-missing', 'attempt-missing'])

/** usage 计数的唯一规则：每个 attempt 至多一份样本（不累加）。 */
export const USAGE_SAMPLE_POLICY = 'one-sample-per-attempt'

/** 本地诊断 ID 的来源标签（**不假称宿主原生**）。 */
export const DIAGNOSTIC_ID_SOURCE = 'local-diagnostic'

/** 本地诊断 ID 的形状（前缀 + 16 位十六进制）。 */
const SESSION_ID_RE = /^sess-local-[0-9a-f]{16}$/
const LOGICAL_REQUEST_ID_RE = /^lr-local-[0-9a-f]{16}$/
const ATTEMPT_ID_RE = /^at-local-[0-9a-f]{16}$/
const REF_FIELDS = Object.freeze(['id', 'source'])

/** 稳定拼接（字段顺序固定；缺值写成 `-` 而不是省略，避免两段短串拼接歧义）。 */
function identityOf(parts) {
  return parts.map((part) => (part === null || part === undefined ? '-' : String(part))).join('|')
}

/**
 * 会话引用：**不落原始会话键**（只落 16 位诊断摘要）。会话键本身是宿主给的
 * `session.id`，写进诊断日志没有必要；摘要足以在单会话目录内做自检与去重。
 *
 * @param {unknown} sessionKey 会话隔离键（字符串）
 * @returns {{id:string, source:string}|null} 非法输入 → null（不伪造）
 */
export function sessionRefOf(sessionKey) {
  if (typeof sessionKey !== 'string' || sessionKey.length === 0) return null
  return deepFreeze({ id: 'sess-local-' + fnv1a64Of(sessionKey), source: DIAGNOSTIC_ID_SOURCE })
}

/**
 * 逻辑请求引用：由 (会话摘要, turn, step, attempt, provider, model) 派生。
 * **provider/model 进身份**：换模型就是换了一个逻辑请求，不能沿用旧 attempt 的关联。
 * 缺 turn/step/attempt 或会话时返回 null——「算不出来」不许拿别的字段凑一个 ID。
 *
 * @param {{session?:object|null, turn?:number|null, step?:number|null, attempt?:number|null, provider?:string|null, model?:string|null}} input
 */
export function logicalRequestRefOf(input) {
  const sessionId = input?.session?.id
  const turn = input?.turn
  const step = input?.step
  const attempt = input?.attempt
  if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) return null
  if (!Number.isSafeInteger(turn) || turn < 0) return null
  if (!Number.isSafeInteger(step) || step < 0) return null
  if (!Number.isSafeInteger(attempt) || attempt < 1) return null
  const material = identityOf([sessionId, turn, step, attempt, input?.provider ?? null, input?.model ?? null])
  return deepFreeze({ id: 'lr-local-' + fnv1a64Of(material), source: DIAGNOSTIC_ID_SOURCE })
}

/**
 * attempt 引用：逻辑请求 + attempt 序号。attempt 序号是**本地**观察到的次序
 * （同一步第几次 llm 调用），不是宿主字段——来源如实标 `local-diagnostic`。
 *
 * @param {{logicalRequest?:object|null, attempt?:number|null, state?:string}} input
 */
export function attemptRefOf(input) {
  const requestId = input?.logicalRequest?.id
  const index = input?.attempt
  if (typeof requestId !== 'string' || !LOGICAL_REQUEST_ID_RE.test(requestId)) return null
  if (!Number.isSafeInteger(index) || index < 1) return null
  const state = ATTEMPT_STATES.includes(input?.state) ? input.state : 'unknown'
  return deepFreeze({
    id: 'at-local-' + fnv1a64Of(identityOf([requestId, index])),
    source: DIAGNOSTIC_ID_SOURCE,
    index,
    state,
  })
}

/**
 * usage 到达性质 + 是否计数。
 *
 * @param {{attempt?:number|null, duplicate?:boolean, maxAttemptSeen?:number|null}} input
 *   `maxAttemptSeen` = **同一 (turn, step) 组内**此前已见过的最大 attempt 序号（调用方维护的
 *   进程内游标）。**不能跨 step 比较**：不同步的 attempt 序号互不相干，跨步比较会把
 *   后开步的 attempt 1 误判成"迟到"。
 * @returns {{state:string, counted:boolean, policy:string}}
 */
export function usageArrivalOf(input) {
  const attempt = input?.attempt
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    return deepFreeze({ state: 'unknown', counted: false, policy: USAGE_SAMPLE_POLICY })
  }
  if (input?.duplicate === true) {
    return deepFreeze({ state: 'duplicate', counted: false, policy: USAGE_SAMPLE_POLICY })
  }
  const seen = input?.maxAttemptSeen
  if (Number.isSafeInteger(seen) && seen >= 1 && attempt < seen) {
    // 迟到但仍属于它自己的 attempt：计数一次，绝不再并到更大的 attempt 上
    return deepFreeze({ state: 'late', counted: true, policy: USAGE_SAMPLE_POLICY })
  }
  return deepFreeze({ state: 'first', counted: true, policy: USAGE_SAMPLE_POLICY })
}

/**
 * 构造观测行的 `lifecycle` 段。
 *
 * @param {{
 *   request?: {turn:number, step:number, provider?:string|null, model?:string|null}|null,
 *   sessionKey?: string|null,
 *   attempt?: number|null,
 *   attemptState?: string,
 *   arrival?: {duplicate?: boolean, maxAttemptSeen?: number|null},
 * }} input
 * @returns {object} 冻结的 lifecycle 段（**从不抛**；缺什么就 null/unpaired）
 */
export function lifecycleSectionOf(input) {
  const request = input?.request ?? null
  const turn = Number.isSafeInteger(request?.turn) ? request.turn : null
  const step = Number.isSafeInteger(request?.step) ? request.step : null
  const provider = typeof request?.provider === 'string' ? request.provider : null
  const model = typeof request?.model === 'string' ? request.model : null
  const session = sessionRefOf(input?.sessionKey)
  const attemptIndex = Number.isSafeInteger(input?.attempt) && input.attempt >= 1 ? input.attempt : null
  const logicalRequest = logicalRequestRefOf({
    session, turn, step, attempt: attemptIndex, provider, model,
  })
  const attempt = attemptRefOf({ logicalRequest, attempt: attemptIndex, state: input?.attemptState })
  let status = 'paired'
  let reason = null
  if (session === null) { status = 'unpaired'; reason = 'session-missing' }
  else if (turn === null || step === null) { status = 'unpaired'; reason = 'turn-step-missing' }
  else if (attemptIndex === null) { status = 'unpaired'; reason = 'attempt-missing' }
  return deepFreeze({
    contractVersion: LIFECYCLE_CONTRACT_VERSION,
    // provider/model 与同行 request 段同源（都来自 assistant/message.data.message.source）；
    // 这里再写一次是为了「request 为 null（宿主没给 turn/step）」时仍能读出模型身份。
    provider,
    model,
    session,
    logicalRequest,
    attempt,
    correlation: { status, reason },
    usageArrival: usageArrivalOf({
      attempt: attemptIndex,
      duplicate: input?.arrival?.duplicate === true,
      maxAttemptSeen: input?.arrival?.maxAttemptSeen ?? null,
    }),
  })
}

/** lifecycle 段字段封闭集（sanitize 与构造共用）。 */
const LIFECYCLE_FIELDS = Object.freeze([
  'contractVersion', 'provider', 'model', 'session', 'logicalRequest', 'attempt', 'correlation', 'usageArrival',
])
const CORRELATION_FIELDS = Object.freeze(['status', 'reason'])
const ARRIVAL_FIELDS = Object.freeze(['state', 'counted', 'policy'])
const ATTEMPT_FIELDS = Object.freeze(['id', 'source', 'index', 'state'])
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@+/-]{0,127}$/

/** 引用对象（id + source）的严格校验：id 形状与来源标签都必须对得上。 */
function sanitizeRef(candidate, shapeRe, label) {
  if (candidate === null || candidate === undefined) return { ok: true, ref: null }
  if (typeof candidate !== 'object' || Array.isArray(candidate)) return { ok: false, reason: label + ' 必须是对象或 null' }
  for (const key of Object.keys(candidate)) {
    if (!REF_FIELDS.includes(key)) return { ok: false, reason: label + ' 未知字段：' + key }
  }
  if (typeof candidate.id !== 'string' || !shapeRe.test(candidate.id)) {
    return { ok: false, reason: label + '.id 形状非法（必须是本地诊断 ID）' }
  }
  if (candidate.source !== DIAGNOSTIC_ID_SOURCE) {
    return { ok: false, reason: label + '.source 必须是 ' + DIAGNOSTIC_ID_SOURCE + '（不得假称宿主原生）' }
  }
  return { ok: true, ref: { id: candidate.id, source: DIAGNOSTIC_ID_SOURCE } }
}

/**
 * lifecycle 段严格校验：字段封闭、枚举封闭、引用形状封闭。
 * **不重算**派生 ID（记录里没有会话键/请求对象，重算不了），但校验其形状与来源标签，
 * 且要求 provider/model 与 attempt 的存在性跟 correlation.status 自洽——
 * 避免「标了 paired 却缺 attempt」这类自相矛盾的记录。
 *
 * @returns {{ok:true, lifecycle:object} | {ok:false, reason:string}}
 */
export function sanitizeLifecycleSection(candidate) {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return { ok: false, reason: 'lifecycle 必须是对象' }
  }
  for (const key of Object.keys(candidate)) {
    if (!LIFECYCLE_FIELDS.includes(key)) return { ok: false, reason: 'lifecycle 未知字段：' + key }
  }
  if (candidate.contractVersion !== LIFECYCLE_CONTRACT_VERSION) {
    return { ok: false, reason: 'lifecycle.contractVersion 不符：' + JSON.stringify(candidate.contractVersion) }
  }
  const provider = candidate.provider === null || candidate.provider === undefined ? null : candidate.provider
  if (provider !== null && (typeof provider !== 'string' || !MODEL_ID_RE.test(provider))) {
    return { ok: false, reason: 'lifecycle.provider 只允许标识符字符集（不得夹带正文）' }
  }
  const model = candidate.model === null || candidate.model === undefined ? null : candidate.model
  if (model !== null && (typeof model !== 'string' || !MODEL_ID_RE.test(model))) {
    return { ok: false, reason: 'lifecycle.model 只允许标识符字符集（不得夹带正文）' }
  }
  const session = sanitizeRef(candidate.session, SESSION_ID_RE, 'lifecycle.session')
  if (session.ok !== true) return session
  const logicalRequest = sanitizeRef(candidate.logicalRequest, LOGICAL_REQUEST_ID_RE, 'lifecycle.logicalRequest')
  if (logicalRequest.ok !== true) return logicalRequest
  let attempt = null
  if (candidate.attempt !== null && candidate.attempt !== undefined) {
    const raw = candidate.attempt
    if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'lifecycle.attempt 必须是对象或 null' }
    for (const key of Object.keys(raw)) {
      if (!ATTEMPT_FIELDS.includes(key)) return { ok: false, reason: 'lifecycle.attempt 未知字段：' + key }
    }
    if (typeof raw.id !== 'string' || !ATTEMPT_ID_RE.test(raw.id)) {
      return { ok: false, reason: 'lifecycle.attempt.id 形状非法（必须是本地诊断 ID）' }
    }
    if (raw.source !== DIAGNOSTIC_ID_SOURCE) {
      return { ok: false, reason: 'lifecycle.attempt.source 必须是 ' + DIAGNOSTIC_ID_SOURCE }
    }
    if (!Number.isSafeInteger(raw.index) || raw.index < 1) {
      return { ok: false, reason: 'lifecycle.attempt.index 必须是 ≥1 的安全整数' }
    }
    if (!ATTEMPT_STATES.includes(raw.state)) {
      return { ok: false, reason: 'lifecycle.attempt.state 非法：' + JSON.stringify(raw.state) }
    }
    attempt = { id: raw.id, source: DIAGNOSTIC_ID_SOURCE, index: raw.index, state: raw.state }
  }
  const correlation = candidate.correlation
  if (correlation === null || typeof correlation !== 'object' || Array.isArray(correlation)) {
    return { ok: false, reason: 'lifecycle.correlation 必须是对象' }
  }
  for (const key of Object.keys(correlation)) {
    if (!CORRELATION_FIELDS.includes(key)) return { ok: false, reason: 'lifecycle.correlation 未知字段：' + key }
  }
  if (!OBSERVATION_CORRELATION_STATES.includes(correlation.status)) {
    return { ok: false, reason: 'lifecycle.correlation.status 非法：' + JSON.stringify(correlation.status) }
  }
  const reason = correlation.reason === null || correlation.reason === undefined ? null : correlation.reason
  if (correlation.status === 'unpaired') {
    if (!CORRELATION_REASONS.includes(reason)) {
      return { ok: false, reason: 'lifecycle.correlation.reason 非法：' + JSON.stringify(reason) }
    }
  } else if (reason !== null) {
    return { ok: false, reason: 'lifecycle.correlation.status=paired 时 reason 必须为 null' }
  }
  if (correlation.status === 'paired' && (session.ref === null || logicalRequest.ref === null || attempt === null)) {
    return { ok: false, reason: 'lifecycle.correlation.status=paired 但缺 session/logicalRequest/attempt（不得自相矛盾）' }
  }
  const arrival = candidate.usageArrival
  if (arrival === null || typeof arrival !== 'object' || Array.isArray(arrival)) {
    return { ok: false, reason: 'lifecycle.usageArrival 必须是对象' }
  }
  for (const key of Object.keys(arrival)) {
    if (!ARRIVAL_FIELDS.includes(key)) return { ok: false, reason: 'lifecycle.usageArrival 未知字段：' + key }
  }
  if (!USAGE_ARRIVAL_STATES.includes(arrival.state)) {
    return { ok: false, reason: 'lifecycle.usageArrival.state 非法：' + JSON.stringify(arrival.state) }
  }
  if (arrival.counted !== true && arrival.counted !== false) {
    return { ok: false, reason: 'lifecycle.usageArrival.counted 必须是布尔' }
  }
  if (arrival.policy !== USAGE_SAMPLE_POLICY) {
    return { ok: false, reason: 'lifecycle.usageArrival.policy 非法：' + JSON.stringify(arrival.policy) }
  }
  // counted 与 state 必须自洽：duplicate/unknown 不计数，first/late 计数
  const shouldCount = arrival.state === 'first' || arrival.state === 'late'
  if (arrival.counted !== shouldCount) {
    return { ok: false, reason: 'lifecycle.usageArrival.counted 与 state 不自洽（' + arrival.state + ' / ' + arrival.counted + '）' }
  }
  return {
    ok: true,
    lifecycle: {
      contractVersion: LIFECYCLE_CONTRACT_VERSION,
      provider,
      model,
      session: session.ref,
      logicalRequest: logicalRequest.ref,
      attempt,
      correlation: { status: correlation.status, reason },
      usageArrival: { state: arrival.state, counted: arrival.counted, policy: USAGE_SAMPLE_POLICY },
    },
  }
}
