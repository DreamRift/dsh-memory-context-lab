/**
 * v2 活跃工作集（有界工作状态）—— 规范 §5。
 *
 * 目标：让「工作状态有界常驻」成为可验证的事实，而不是口号。
 * 本模块只做确定性提取与有界渲染：
 *
 * - 只从宿主事件的**结构化字段**（role/source/callId/toolCallId/seq）取证，
 *   不从正文里猜目标、约束或完成度；
 * - 不调用任何模型，不生成有损摘要；原文一律保留 `sourceRef` 供按 ID 回读；
 * - 渲染按优先级装包，预算不够时**从软保留开始丢并如实报告**，
 *   绝不静默截断后假装完整（规范 §5.5）。
 *
 * 三条不可越过的边界（本模块把它们编码成数据，而不只是注释）：
 *
 * 1. **硬保护 vs 软保留**：`PROTECTION_CLASSES` 里的七类内容（当前人类请求与
 *    有效约束、未闭合调用、未曝光结果、在途作业与未确认副作用、当前必要证据、
 *    有效 pin、最小工作状态）加上「未知」这一协议位，是**硬保护**：任何预算下
 *    都不从保护集里丢弃，只如实报溢出。可丢的只有软保留（可选预取、冗余卡片、
 *    非必要历史、stale/未验证证据、过期 pin、已否决选项、未决问题）。
 * 2. **硬保护不用朴素 TTL 驱逐**：`TTL_FREE_HARD_CLASSES` 列出的硬类目不携带
 *    任何 TTL；唯一带显式过期的是 pin，而 pin 的过期**本身就是它的保护契约**
 *    （必须同时给出失效时间与复核条件），过期只是转成「需复核」，不静默消失。
 *    软保留（如重读产生的临时 pin、进度）才允许按 recency/TTL 处理。
 * 3. **来源不可提升**：摘要不是原文、模型推断不是授权、状态卡不是系统消息。
 *    `resolveAuthority` 只回显来源本身，声称自己是 system/developer/user 一律拒绝。
 *
 * 首版确定性参数（规范里明确写着「不是已批准默认值」，这里只作为可覆盖的保守起点）。
 */

import { createHash } from 'node:crypto'
import { isHumanAuthoredMessage } from '../core.mjs'
import { estimateTokensOf } from './budget.mjs'
import { formatImportanceReason, scoreSoftRetention } from './importance.mjs'

export const WORKING_STATE_SCHEMA_VERSION = 3

/**
 * 卡片语义版本。
 *
 * 语义去重键（`workingSetDedupKeyOf`）把它编进键里：整卡渲染的**语义**（字段、
 * 顺序、口径）一变，旧键必须全部失效，否则一张按新口径渲染的卡会被旧键当成
 * 「同一张卡」而不注入。因此**改卡片渲染口径或去重键口径时必须手动 +1**。
 *
 * v3（2026-10-14）：D1 升级——去重键从「只取硬前缀」改为「整卡归一化后取哈希」。
 * 只取硬前缀时，软保留区的进度行每步都在变、键却不变，进度更新被去重吞掉；
 * 同时注入形态引入增量卡（`workingStateCardDelta`），注入语义整体变化，
 * 旧键必须全部失效。
 *
 * v4（2026-10-15，F1）：软保留按灵枢重要度分值装包（每项一段，分值降序、
 * 低分先丢；丢弃报告带分量）。软段的次序与结构语义变化，旧键全部失效。
 */
export const CARD_SEMANTIC_VERSION = 4

/** 每个会话最多记住多少个已注入的语义键：有界集合，防会话内无限增长。 */
export const WORKING_SET_DEDUP_HISTORY_LIMIT = 32

export const WORKING_SET_DEFAULTS = Object.freeze({
  /** 状态卡目标 token（规范 §5.5 的 1–3k 取下界）。 */
  cardTokens: 1200,
  maxOpenActions: 8,
  maxUnseenResults: 6,
  maxProgressItems: 12,
  maxConstraints: 6,
  /** 单条摘录的字符上限：够模型定位，又不把原文搬回来。 */
  excerptChars: 240,
  // --- 以下为活跃工作集新增上限；都有默认值，老调用方不传也成立。---
  maxUnknowns: 6,
  maxEvidence: 8,
  maxPins: 8,
  maxInflightJobs: 6,
  /** 最小依赖集上限：绝不因为「任务很长」就整体 pin。 */
  maxMinimalDependencies: 8,
  maxPrefetch: 6,
  maxRedundantCards: 6,
  maxNonEssentialHistory: 6,
  maxRejectedOptions: 6,
  maxOpenQuestions: 6,
  /** S1：助手结论（claim）盘点配额——全局有界，不是每单元无限兜底（方案 §7）。 */
  maxAssistantClaims: 8,
  /** 最近重读证据的临时 pin 默认有效期（软保留口径，不是硬保护的驱逐手段）。 */
  pinTtlMs: 30 * 60 * 1000,
})

// ---------------------------------------------------------------------------
// 保护集：类目、硬/软、释放或复核条件
// ---------------------------------------------------------------------------

/** 保护类目（封闭集）。 */
export const PROTECTION_CLASSES = Object.freeze({
  HUMAN_REQUEST: 'human-request',
  UNCLOSED_CALL: 'unclosed-call',
  UNEXPOSED_RESULT: 'unexposed-result',
  INFLIGHT_JOB: 'inflight-job',
  NECESSARY_EVIDENCE: 'necessary-evidence',
  VALID_PIN: 'valid-pin',
  MINIMAL_WORKING_STATE: 'minimal-working-state',
  UNKNOWN_PROTOCOL: 'unknown-protocol',
})

export const PROTECTION_STRENGTH = Object.freeze({ HARD: 'hard', SOFT: 'soft' })

/**
 * 每个保护类目的固定语义：为什么受保护 + 何时可以释放/复核。
 * 每个保护项都会带上 reason / source / releaseCondition 三个字段（见 protectedItem）。
 */
export const PROTECTION_RULES = Object.freeze({
  [PROTECTION_CLASSES.HUMAN_REQUEST]: Object.freeze({
    strength: PROTECTION_STRENGTH.HARD,
    reason: '当前真实人类请求与仍然有效的约束就是本次工作的目标本身；丢掉它等于换了任务。',
    releaseCondition: '只在出现更新的人类请求、或用户显式撤销该约束时释放；不因预算、超时或摘要释放。',
  }),
  [PROTECTION_CLASSES.UNCLOSED_CALL]: Object.freeze({
    strength: PROTECTION_STRENGTH.HARD,
    reason: '未闭合的工具调用是「已经发出、还没有回执」的在途动作；丢掉会让模型看到没有回执的调用，或凭空出现的结果。',
    releaseCondition: '只在配对账本给出对应结果、或用户显式中止该动作时释放。',
  }),
  [PROTECTION_CLASSES.UNEXPOSED_RESULT]: Object.freeze({
    strength: PROTECTION_STRENGTH.HARD,
    reason: '结果已落库但还没进入主模型活动面；丢掉等于替主模型扔掉它尚未收到的证据。',
    releaseCondition: '只在该结果的 seq 进入主模型活动面（后续回合已曝光）后释放。',
  }),
  [PROTECTION_CLASSES.INFLIGHT_JOB]: Object.freeze({
    strength: PROTECTION_STRENGTH.HARD,
    reason: '在途作业与未确认副作用的状态未知；丢掉会让「可能已经发生的写操作」变成无人认领的事实。',
    releaseCondition: '只在作业到达终态、且副作用被显式确认或显式否认后释放。',
  }),
  [PROTECTION_CLASSES.NECESSARY_EVIDENCE]: Object.freeze({
    strength: PROTECTION_STRENGTH.HARD,
    reason: '当前决策直接依赖的证据；丢掉会让后续步骤建立在猜测上。',
    releaseCondition: '只在依赖它的未决问题/在途动作结束后、或出现同指纹的更新证据时释放。',
  }),
  [PROTECTION_CLASSES.VALID_PIN]: Object.freeze({
    strength: PROTECTION_STRENGTH.HARD,
    reason: '带明确失效时间与复核条件的 pin；在有效期内是硬保护，避免刚重读的证据立刻又掉出。',
    releaseCondition: '到达 pin 自带的过期时间，或满足它自带的复核条件时转为「需复核」；不因预算释放。',
  }),
  [PROTECTION_CLASSES.MINIMAL_WORKING_STATE]: Object.freeze({
    strength: PROTECTION_STRENGTH.HARD,
    reason: '当前最小依赖集：让工作可以继续所需的最小对象集合，不是整条长任务。',
    releaseCondition: '只在依赖对象本身结束后释放；任何情况下都不整体 pin 长任务。',
  }),
  [PROTECTION_CLASSES.UNKNOWN_PROTOCOL]: Object.freeze({
    strength: PROTECTION_STRENGTH.HARD,
    reason: '「不知道」本身是必须常驻的协议信息：丢掉未知会把它伪装成已知。',
    releaseCondition: '只在未知被结构化事实消除、或用户显式裁定后释放。',
  }),
})

/**
 * 不允许携带 TTL 的硬保护类目。
 *
 * 硬保护只能按各自的结构性释放条件退出，不能因为「放了很久」被驱逐。
 * pin 不在这个列表里：pin 的显式过期是它自己的保护契约（见 evaluatePin），
 * 过期后转「需复核」而不是静默消失。
 */
export const TTL_FREE_HARD_CLASSES = Object.freeze([
  PROTECTION_CLASSES.HUMAN_REQUEST,
  PROTECTION_CLASSES.UNCLOSED_CALL,
  PROTECTION_CLASSES.UNEXPOSED_RESULT,
  PROTECTION_CLASSES.INFLIGHT_JOB,
  PROTECTION_CLASSES.NECESSARY_EVIDENCE,
  PROTECTION_CLASSES.MINIMAL_WORKING_STATE,
  PROTECTION_CLASSES.UNKNOWN_PROTOCOL,
])

/** 硬保护类目的渲染顺序（也是「永不丢弃」的报告顺序）。 */
export const PROTECTION_ORDER = Object.freeze([
  PROTECTION_CLASSES.HUMAN_REQUEST,
  PROTECTION_CLASSES.UNCLOSED_CALL,
  PROTECTION_CLASSES.UNEXPOSED_RESULT,
  PROTECTION_CLASSES.INFLIGHT_JOB,
  PROTECTION_CLASSES.NECESSARY_EVIDENCE,
  PROTECTION_CLASSES.VALID_PIN,
  PROTECTION_CLASSES.MINIMAL_WORKING_STATE,
  PROTECTION_CLASSES.UNKNOWN_PROTOCOL,
])

const PROTECTION_TITLES = Object.freeze({
  [PROTECTION_CLASSES.HUMAN_REQUEST]: '保护集·当前人类请求与仍然有效的约束',
  [PROTECTION_CLASSES.UNCLOSED_CALL]: '保护集·在途动作与未闭合配对',
  [PROTECTION_CLASSES.UNEXPOSED_RESULT]: '保护集·尚未被主模型看到的结果',
  [PROTECTION_CLASSES.INFLIGHT_JOB]: '保护集·在途作业与未确认副作用',
  [PROTECTION_CLASSES.NECESSARY_EVIDENCE]: '保护集·当前必要证据',
  [PROTECTION_CLASSES.VALID_PIN]: '保护集·有效 pin（临时硬保护）',
  [PROTECTION_CLASSES.MINIMAL_WORKING_STATE]: '保护集·最小工作状态',
  [PROTECTION_CLASSES.UNKNOWN_PROTOCOL]: '保护集·未知与保守回退规则',
})

/** 即使为空也渲染的硬段：让「没有在途动作」也是一条明确事实，而不是留白。 */
const ALWAYS_RENDERED_PROTECTION = Object.freeze([
  PROTECTION_CLASSES.HUMAN_REQUEST,
  PROTECTION_CLASSES.UNCLOSED_CALL,
  // 未曝光结果也必须常渲染：只有它出场，才能把「判定不可用（不知道）」和
  // 「确认没有未曝光结果」写成两句不同的话，而不是都留白。
  PROTECTION_CLASSES.UNEXPOSED_RESULT,
  PROTECTION_CLASSES.MINIMAL_WORKING_STATE,
  PROTECTION_CLASSES.UNKNOWN_PROTOCOL,
])

// ---------------------------------------------------------------------------
// 软保留：类目与丢弃顺序
// ---------------------------------------------------------------------------

export const RETENTION_CLASSES = Object.freeze({
  OPTIONAL_PREFETCH: 'optional-prefetch',
  REDUNDANT_CARD: 'redundant-card',
  NON_ESSENTIAL_HISTORY: 'non-essential-history',
  STALE_EVIDENCE: 'stale-evidence',
  UNVERIFIED_EVIDENCE: 'unverified-evidence',
  EXPIRED_PIN: 'expired-pin',
  REJECTED_OPTION: 'rejected-option',
  OPEN_QUESTION: 'open-question',
})

export const RETENTION_RULES = Object.freeze({
  [RETENTION_CLASSES.OPTIONAL_PREFETCH]: Object.freeze({
    reason: '可选预取：可能有用，但当前没有任何动作依赖它。',
    releaseCondition: '随时可丢；需要时按记录 ID 重新取回。',
  }),
  [RETENTION_CLASSES.REDUNDANT_CARD]: Object.freeze({
    reason: '冗余卡片：同一事实的旧版本卡片，已被更新版本取代。',
    releaseCondition: '被取代即可丢；回读仍可达。',
  }),
  [RETENTION_CLASSES.NON_ESSENTIAL_HISTORY]: Object.freeze({
    reason: '非必要历史：已完成探索分支的进度、不再被依赖的旧内容。',
    releaseCondition: '分支结束即可丢；出处仍可按记录 ID 回读。',
  }),
  [RETENTION_CLASSES.STALE_EVIDENCE]: Object.freeze({
    reason: '版本/环境/测试指纹与当前不一致：旧结论不能作为新版本的证据。',
    releaseCondition: '在对应版本上重新取证后释放；丢弃前必须显式标注 stale。',
  }),
  [RETENTION_CLASSES.UNVERIFIED_EVIDENCE]: Object.freeze({
    reason: '未绑定版本/环境/测试指纹：既不能当作有效证据，也不能当作已否证。',
    releaseCondition: '补上指纹并复核后释放。',
  }),
  [RETENTION_CLASSES.EXPIRED_PIN]: Object.freeze({
    reason: 'pin 已过期，或缺少明确的失效时间/复核条件。',
    releaseCondition: '复核后重新 pin，或确认不再需要。',
  }),
  [RETENTION_CLASSES.REJECTED_OPTION]: Object.freeze({
    reason: '已否决/负向选项：避免重复走死路，尽量保留到预算真的不够。',
    releaseCondition: '预算不足时最后才丢；丢弃后仍可按记录 ID 回读。',
  }),
  [RETENTION_CLASSES.OPEN_QUESTION]: Object.freeze({
    reason: '未决问题：工作未完成的标记，尽量保留到预算真的不够。',
    releaseCondition: '问题被回答或显式作废后释放。',
  }),
})

/**
 * 丢弃顺序（从最先丢到最后丢）。
 *
 * 与规范一致：先丢可选预取、冗余卡片、非必要历史（含已完成探索分支），
 * 再丢 stale/未验证证据与过期 pin，最后才动已否决选项与未决问题。
 * 协议项、关键约束、在途状态**不在这个列表里**——它们属于硬保护，永不丢弃。
 */
export const DROP_ORDER = Object.freeze([
  RETENTION_CLASSES.OPTIONAL_PREFETCH,
  RETENTION_CLASSES.REDUNDANT_CARD,
  RETENTION_CLASSES.NON_ESSENTIAL_HISTORY,
  RETENTION_CLASSES.STALE_EVIDENCE,
  RETENTION_CLASSES.UNVERIFIED_EVIDENCE,
  RETENTION_CLASSES.EXPIRED_PIN,
  RETENTION_CLASSES.REJECTED_OPTION,
  RETENTION_CLASSES.OPEN_QUESTION,
])

const RETENTION_TITLES = Object.freeze({
  [RETENTION_CLASSES.OPTIONAL_PREFETCH]: '软保留·可选预取（最先丢弃）',
  [RETENTION_CLASSES.REDUNDANT_CARD]: '软保留·冗余卡片（可丢弃）',
  [RETENTION_CLASSES.NON_ESSENTIAL_HISTORY]: '软保留·非必要历史（可丢弃）',
  [RETENTION_CLASSES.STALE_EVIDENCE]: '软保留·版本不匹配证据（stale，不得当作有效证据）',
  [RETENTION_CLASSES.UNVERIFIED_EVIDENCE]: '软保留·未绑定指纹证据（unverified）',
  [RETENTION_CLASSES.EXPIRED_PIN]: '软保留·过期 pin（需复核）',
  [RETENTION_CLASSES.REJECTED_OPTION]: '软保留·已否决/负向选项（尽量保留）',
  [RETENTION_CLASSES.OPEN_QUESTION]: '软保留·未决问题（尽量保留）',
})

// ---------------------------------------------------------------------------
// 来源与权威：不可提升
// ---------------------------------------------------------------------------

export const SOURCE_KINDS = Object.freeze({
  SYSTEM: 'system',
  DEVELOPER: 'developer',
  USER: 'user',
  TOOL_RESULT: 'tool-result',
  MODEL_INFERENCE: 'model-inference',
  SUMMARY: 'summary',
  STATUS_CARD: 'status-card',
  UNKNOWN: 'unknown',
})

const SOURCE_KIND_SET = new Set(Object.values(SOURCE_KINDS))

/** 三条不变量 + 一条总则；作为数据随每个 authority 结果一起给出。 */
export const AUTHORITY_INVARIANTS = Object.freeze([
  '摘要不是原文：sourceKind=summary 不携带原文保真，要原文必须按记录 ID 回读。',
  '模型推断不是授权：sourceKind=model-inference 不构成用户授权，也不能扩大许可范围。',
  '状态卡不是系统消息：sourceKind=status-card 只走工作资料通道。',
  '任何来源都不能被提升为 system/developer/user：authority 只能等于来源本身。',
])

/**
 * 解析一个来源的权威等级。
 *
 * `authority` 恒等于归一化后的来源本身；`claimedAuthority` 只作为**被拒绝的声明**
 * 记录下来，绝不参与判定。这样「摘要/推断/状态卡冒充系统消息」在数据层就不可能成立。
 */
export function resolveAuthority({ sourceKind, claimedAuthority = null } = {}) {
  const raw = String(sourceKind ?? '').trim().toLowerCase()
  const known = SOURCE_KIND_SET.has(raw)
  const kind = known ? raw : SOURCE_KINDS.UNKNOWN
  const reasons = []
  if (!known) {
    reasons.push(`未知来源 ${JSON.stringify(sourceKind ?? null)}：按 unknown 处理，不继承任何更高权限。`)
  }
  const claimed = claimedAuthority === null || claimedAuthority === undefined
    ? null
    : String(claimedAuthority).trim().toLowerCase()
  const promotionRejected = claimed !== null && claimed !== kind
  if (promotionRejected) {
    reasons.push(`来源 ${kind} 声称自己是 ${claimed}：拒绝提升，authority 只能等于来源本身。`)
  }
  const isOriginalText = kind !== SOURCE_KINDS.SUMMARY
  if (!isOriginalText) reasons.push('摘要不是原文：需要原文时按记录 ID 回读。')
  const authorizes = kind === SOURCE_KINDS.USER
  if (kind === SOURCE_KINDS.MODEL_INFERENCE) reasons.push('模型推断不是授权：不能扩大许可范围。')
  const canBeSystemMessage = kind === SOURCE_KINDS.SYSTEM
  if (kind === SOURCE_KINDS.STATUS_CARD) reasons.push('状态卡不是系统消息：只走工作资料通道。')
  return {
    sourceKind: kind,
    authority: kind,
    claimedAuthority: claimed,
    promotionRejected,
    isOriginalText,
    authorizes,
    canBeSystemMessage,
    channel: canBeSystemMessage ? 'system' : 'working-material',
    reasons,
    invariants: AUTHORITY_INVARIANTS,
  }
}

// ---------------------------------------------------------------------------
// 证据：版本/环境/测试指纹
// ---------------------------------------------------------------------------

export const EVIDENCE_STATUS = Object.freeze({
  VALID: 'valid',
  STALE: 'stale',
  UNVERIFIED: 'unverified',
})

export const FINGERPRINT_VERDICTS = Object.freeze({
  MATCH: 'match',
  MISMATCH: 'mismatch',
  UNKNOWN: 'unknown',
})

/**
 * 构造版本/环境/测试指纹。
 *
 * 三样东西都要能被绑上：目标（文件/模块）、版本（内容哈希/版本号）、
 * 执行环境（运行时/平台/配置），以及测试证据（哪次运行、什么结果）。
 * 一样都没有时返回 null——「没有指纹」不等于「指纹相同」。
 */
export function fingerprintOf({ target = null, version = null, environment = null, testEvidence = null } = {}) {
  const parts = []
  if (target !== null && target !== undefined && String(target).trim() !== '') parts.push(`target=${String(target).trim()}`)
  if (version !== null && version !== undefined && String(version).trim() !== '') parts.push(`version=${String(version).trim()}`)
  if (environment !== null && environment !== undefined && String(environment).trim() !== '') parts.push(`env=${String(environment).trim()}`)
  if (testEvidence !== null && testEvidence !== undefined && String(testEvidence).trim() !== '') parts.push(`test=${String(testEvidence).trim()}`)
  return parts.length > 0 ? parts.join('|') : null
}

function normalizeFingerprint(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed === '' ? null : trimmed
  }
  if (value && typeof value === 'object') return fingerprintOf(value)
  return null
}

/**
 * 比较指纹。只有两侧都存在且逐字符相等才算 match；
 * 任一侧缺失一律 unknown——绝不用「没记录」推断「没变化」。
 */
export function compareFingerprints(recorded, current) {
  const left = normalizeFingerprint(recorded)
  const right = normalizeFingerprint(current)
  if (left === null || right === null) return FINGERPRINT_VERDICTS.UNKNOWN
  return left === right ? FINGERPRINT_VERDICTS.MATCH : FINGERPRINT_VERDICTS.MISMATCH
}

/**
 * 把一条证据绑定到当前版本/环境/测试指纹上。
 *
 * 结论只有三种，且**不可能**从 stale/unverified 升格成 valid：
 * - match → valid；
 * - mismatch → stale（旧通过结果不能当作新版本的证据）；
 * - 任一侧缺指纹 → unverified。
 */
export function bindEvidence(item, { now = Date.now() } = {}) {
  const source = item && typeof item === 'object' ? item : {}
  const recordRef = String(source.recordRef ?? source.id ?? '')
  const sourceKind = String(source.sourceKind ?? SOURCE_KINDS.TOOL_RESULT)
  const authority = resolveAuthority({ sourceKind, claimedAuthority: source.claimedAuthority ?? null })
  const recorded = normalizeFingerprint(source.fingerprint)
  const current = normalizeFingerprint(source.currentFingerprint ?? source.current)
  const verdict = compareFingerprints(recorded, current)
  const status = verdict === FINGERPRINT_VERDICTS.MATCH
    ? EVIDENCE_STATUS.VALID
    : verdict === FINGERPRINT_VERDICTS.MISMATCH
      ? EVIDENCE_STATUS.STALE
      : EVIDENCE_STATUS.UNVERIFIED
  const statusReason = status === EVIDENCE_STATUS.VALID
    ? '记录指纹与当前指纹一致。'
    : status === EVIDENCE_STATUS.STALE
      ? `记录指纹 ${recorded} 与当前指纹 ${current} 不一致：旧结论（例如曾经通过的测试）不能作为当前版本的证据。`
      : '缺少可比的版本/环境/测试指纹（记录侧或当前侧为空）：既不能当作有效证据，也不能当作已否证。'
  const necessary = source.necessary === true
  return {
    itemId: `evidence:${recordRef}`,
    recordRef,
    callId: source.callId ?? null,
    kind: source.kind ?? null,
    sourceKind: authority.sourceKind,
    authority,
    fingerprint: recorded,
    currentFingerprint: current,
    fingerprintVerdict: verdict,
    status,
    statusReason,
    necessary,
    provenance: source.provenance ?? { sourceRef: recordRef, sourceKind: authority.sourceKind },
    reason: source.reason ?? (necessary
      ? '当前决策依赖这条证据。'
      : '曾经取回的观察结果。'),
    source: source.source ?? `evidence:${authority.sourceKind}`,
    releaseCondition: source.releaseCondition
      ?? PROTECTION_RULES[PROTECTION_CLASSES.NECESSARY_EVIDENCE].releaseCondition,
    boundAt: new Date(Number.isFinite(Number(now)) ? Number(now) : Date.now()).toISOString(),
  }
}

// ---------------------------------------------------------------------------
// pin：显式过期 + 复核条件
// ---------------------------------------------------------------------------

export const PIN_STATUS = Object.freeze({
  VALID: 'valid',
  EXPIRED: 'expired',
  INVALID: 'invalid',
})

/**
 * 数值归一化：null/undefined/非有限值一律回 null。
 * 注意 `Number(null) === 0`：不加这层判断会把「没给过期时间」当成「1970 年就过期」。
 */
function toFiniteOrNull(value) {
  if (value === undefined || value === null) return null
  const num = Number(value)
  return Number.isFinite(num) ? num : null
}

/**
 * 造一个 pin。**必须**同时给出失效时间与复核条件，否则它不会被当作硬保护。
 *
 * `trigger: 'readback'` 用于「最近重读的证据」：拿到临时 pin，不至于刚回到
 * 工作集就立刻又掉出去；到期后转「需复核」，而不是静默消失（规范 §5）。
 */
export function pinEvidence({
  recordRef,
  reason = null,
  source = null,
  reviewCondition = null,
  ttlMs = null,
  expiresAt = null,
  pinnedAt = null,
  scope = 'item',
  trigger = 'manual',
  now = Date.now(),
} = {}) {
  const clock = Number.isFinite(Number(now)) ? Number(now) : Date.now()
  const at = toFiniteOrNull(pinnedAt) ?? clock
  const ttl = toFiniteOrNull(ttlMs)
  const explicitExpiry = toFiniteOrNull(expiresAt)
  const expiry = explicitExpiry ?? (ttl !== null ? at + ttl : null)
  return {
    itemId: `pin:${String(recordRef ?? '')}`,
    recordRef: String(recordRef ?? ''),
    scope,
    trigger,
    pinnedAt: new Date(at).toISOString(),
    expiresAt: expiry === null ? null : new Date(expiry).toISOString(),
    expiresAtMs: expiry,
    reviewCondition: reviewCondition
      ?? (trigger === 'readback'
        ? '重读产生的临时 pin：到期即转「需复核」；再次引用该证据、或其目标版本/环境指纹发生变化时立即复核。'
        : null),
    reason: reason ?? (trigger === 'readback' ? '最近重读的证据需要临时留在工作集里。' : '调用方要求保护该对象。'),
    source: source ?? (trigger === 'readback' ? 'readback' : 'caller'),
  }
}

/** 评估一个 pin：valid（硬保护）/ expired（需复核，转软保留）/ invalid（不构成保护）。 */
export function evaluatePin(pin, { now = Date.now(), step = null } = {}) {
  const source = pin && typeof pin === 'object' ? pin : {}
  const clock = Number.isFinite(Number(now)) ? Number(now) : Date.now()
  const recordRef = String(source.recordRef ?? '')
  const base = {
    itemId: source.itemId ?? `pin:${recordRef}`,
    recordRef,
    scope: source.scope ?? 'item',
    trigger: source.trigger ?? 'manual',
    reason: source.reason ?? '未说明',
    source: source.source ?? 'unknown',
    reviewCondition: source.reviewCondition ?? null,
    expiresAt: source.expiresAt ?? null,
    expiresAtMs: toFiniteOrNull(source.expiresAtMs),
    step,
  }
  if (base.scope === 'whole-task') {
    return {
      ...base,
      status: PIN_STATUS.INVALID,
      reviewRequired: true,
      remainingMs: null,
      releaseCondition: '不允许把整条长任务整体 pin 住；请改为 pin 当前最小依赖集里的具体对象。',
      invalidReason: '不允许把整条长任务整体 pin 住（规范 §5：只保护当前最小依赖集）。',
    }
  }
  if (base.expiresAtMs === null) {
    return {
      ...base,
      status: PIN_STATUS.INVALID,
      reviewRequired: true,
      remainingMs: null,
      releaseCondition: '补上明确的失效时间与复核条件后重新 pin。',
      invalidReason: 'pin 缺少明确的失效时间：硬保护不允许没有到期条件的 pin。',
    }
  }
  if (typeof base.reviewCondition !== 'string' || base.reviewCondition.trim() === '') {
    return {
      ...base,
      status: PIN_STATUS.INVALID,
      reviewRequired: true,
      remainingMs: base.expiresAtMs - clock,
      releaseCondition: '补上明确的复核条件后重新 pin。',
      invalidReason: 'pin 缺少明确的复核条件：过期后无法判断该不该续 pin。',
    }
  }
  const remainingMs = base.expiresAtMs - clock
  if (remainingMs <= 0) {
    return {
      ...base,
      status: PIN_STATUS.EXPIRED,
      reviewRequired: true,
      remainingMs,
      releaseCondition: `已过期：按复核条件复核（${base.reviewCondition}）；复核后可重新 pin，或确认不再需要。`,
      invalidReason: null,
    }
  }
  return {
    ...base,
    status: PIN_STATUS.VALID,
    reviewRequired: false,
    remainingMs,
    releaseCondition: `到期时间 ${base.expiresAt}；到期或复核条件命中（${base.reviewCondition}）时转「需复核」。`,
    invalidReason: null,
  }
}

// ---------------------------------------------------------------------------
// 关系：判定不了就是 unknown，回退到保守原文 + 显式规则
// ---------------------------------------------------------------------------

export const RELATION_KINDS = Object.freeze({
  DEPENDS_ON: 'depends-on',
  PRODUCED: 'produced',
  SUPERSEDES: 'supersedes',
  CONTRADICTS: 'contradicts',
  UNKNOWN: 'unknown',
})

const RELATION_KIND_SET = new Set([
  RELATION_KINDS.DEPENDS_ON,
  RELATION_KINDS.PRODUCED,
  RELATION_KINDS.SUPERSEDES,
  RELATION_KINDS.CONTRADICTS,
])

/** 关系未知时的保守规则：这些是渲染进卡片的显式条文，不是隐式默认。 */
export const UNKNOWN_RELATION_RULES = Object.freeze([
  '关系未知时按原文并列呈现，不补写因果、依赖或取代边。',
  '关系未知不得用于降温判定：不因「看起来无关」而把对象退役。',
  '要确定关系必须回到结构化事实（调用/结果配对、投影跨度、显式声明），或由用户显式给出。',
])

/**
 * 判定两个对象之间的关系。
 *
 * 只有「已知关系种类 + 非空依据」才算判定成功；其余一律 unknown，
 * 并回退到保守原文与显式规则——绝不编造一条关系。
 */
export function resolveRelation(input) {
  const source = input && typeof input === 'object' ? input : {}
  const { subjectRef = null, objectRef = null, relation = null, basis = null, evidenceRefs = [] } = source
  const subject = subjectRef === null || subjectRef === undefined ? null : String(subjectRef)
  const object = objectRef === null || objectRef === undefined ? null : String(objectRef)
  const claimed = relation === null || relation === undefined ? null : String(relation).trim().toLowerCase()
  const hasBasis = typeof basis === 'string' && basis.trim() !== ''
  const known = claimed !== null && RELATION_KIND_SET.has(claimed)
  if (known && hasBasis) {
    return {
      subjectRef: subject,
      objectRef: object,
      relation: claimed,
      basis: basis.trim(),
      evidenceRefs: [...evidenceRefs],
      resolved: true,
      fallback: null,
      rules: [],
      reason: '关系由结构化事实判定。',
    }
  }
  const missing = []
  if (!known) missing.push(claimed === null ? '未给出关系种类' : `关系种类不可信（${claimed}）`)
  if (!hasBasis) missing.push('缺少结构化依据')
  return {
    subjectRef: subject,
    objectRef: object,
    relation: RELATION_KINDS.UNKNOWN,
    basis: hasBasis ? basis.trim() : null,
    evidenceRefs: [...evidenceRefs],
    resolved: false,
    fallback: 'verbatim-text',
    rules: UNKNOWN_RELATION_RULES,
    reason: `关系无法确定性判定（${missing.join('、')}）：按未知处理，保留原文并适用保守规则。`,
  }
}

// ---------------------------------------------------------------------------
// 投影：按批次追加，稳定前缀
// ---------------------------------------------------------------------------

/** 新建一个空投影（stage 序列 + 已渲染文本）。 */
export function createProjection({ stageId = null, batchSize = 64, at = null } = {}) {
  return {
    schemaVersion: 1,
    stages: [],
    text: '',
    chars: 0,
    batchSize: Number.isFinite(Number(batchSize)) ? Math.max(1, Math.floor(Number(batchSize))) : 64,
    rewroteEarlierStages: false,
    updatedAt: at,
    lastStageId: stageId,
  }
}

function stageTextOf(stageId, lines) {
  const head = `[投影批次 ${stageId}]`
  if (!Array.isArray(lines) || lines.length === 0) return head
  return [head, ...lines.map((line) => `- ${line}`)].join('\n')
}

/**
 * 追加一个投影批次。
 *
 * 只追加、不重写：新文本以旧文本为前缀（`startsWith` 恒真），
 * `rewroteEarlierStages` 恒为 false。这样历史前缀缓存不会被逐步更新打散。
 */
export function appendProjectionStage(projection, { stageId, lines = [], reason = null, at = null } = {}) {
  if (typeof stageId !== 'string' || stageId.trim() === '') {
    throw new TypeError('appendProjectionStage 需要非空 stageId')
  }
  const base = projection && typeof projection === 'object' && Array.isArray(projection.stages)
    ? projection
    : createProjection({})
  const duplicateStageId = base.stages.some((stage) => stage.stageId === stageId)
  const stageText = stageTextOf(stageId, lines)
  const text = base.text === '' ? stageText : `${base.text}\n${stageText}`
  const stages = [...base.stages, {
    stageId,
    lines: [...lines],
    chars: stageText.length,
    reason,
    at,
    duplicateStageId,
  }]
  return {
    ...base,
    stages,
    text,
    chars: text.length,
    rewroteEarlierStages: false,
    updatedAt: at,
    lastStageId: stageId,
  }
}

// ---------------------------------------------------------------------------
// 预算分解
// ---------------------------------------------------------------------------

/**
 * token 数量归一化。
 *
 * 这里是「字节 vs token」口径的闸口：所有预算参数都必须先是 token 数。
 * 非有限值（NaN / 字符串 / 对象）不会被当成 0 静默吞掉，而是记进 invalidParts，
 * 以免出现 `available = NaN` → `overflow = false` 这种把溢出藏起来的组合。
 */
function toTokenCount(value, fallback) {
  if (value === undefined || value === null) return { value: fallback, invalid: false }
  const num = Number(value)
  if (!Number.isFinite(num)) return { value: fallback, invalid: true }
  return { value: Math.max(0, Math.floor(num)), invalid: false }
}

/**
 * 工作集预算分解：A = W - O - B - M - P（规范 §5.5）。
 *
 * A≤0 时不通过丢弃保护对象来凑预算，而是明确报告溢出。
 * 所有入参都是 **token** 数；非法入参不会静默变成 NaN，而是在 invalidParts 里点名。
 */
export function planWorkingSetBudget({
  contextWindow,
  reservedCompletionTokens = 4096,
  fixedBaseTokens = 0,
  protocolMarginTokens = 512,
  protectedTokens = 0,
} = {}) {
  const invalidParts = []
  const read = (name, value, fallback) => {
    const { value: normalized, invalid } = toTokenCount(value, fallback)
    if (invalid) invalidParts.push(name)
    return normalized
  }
  const parts = {
    contextWindow: read('contextWindow', contextWindow, 0),
    reservedCompletionTokens: read('reservedCompletionTokens', reservedCompletionTokens, 4096),
    fixedBaseTokens: read('fixedBaseTokens', fixedBaseTokens, 0),
    protocolMarginTokens: read('protocolMarginTokens', protocolMarginTokens, 512),
    protectedTokens: read('protectedTokens', protectedTokens, 0),
  }
  const available = parts.contextWindow
    - parts.reservedCompletionTokens
    - parts.fixedBaseTokens
    - parts.protocolMarginTokens
    - parts.protectedTokens
  const overflow = available <= 0
  const reason = overflow
    ? '可用动态预算 A≤0：保护内容与固定开销已占满窗口，不能用丢弃保护对象来凑预算。'
    : null
  return {
    parts,
    available,
    overflow,
    reason,
    overflowReason: reason,
    shortfall: overflow ? -available : 0,
    invalidParts,
    unit: 'token',
    protectedSetIsHard: true,
  }
}

// ---------------------------------------------------------------------------
// 确定性提取
// ---------------------------------------------------------------------------

function textOfBlocks(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

/**
 * 按**码点**截断（0.13.2 D-20）。
 *
 * `String#length`/`slice` 是 UTF-16 单元口径：emoji 之类代理对跨在边界上会被切成
 * 两半，产出孤立代理，落盘再读就变成 U+FFFD——模型看到的是一段被写坏的正文。
 * `core.mjs` 的 `chunkArchiveBody` 早就按码点切（「never inside a multi-byte
 * character」），这里对齐同一口径。
 */
function truncateAtCodePoints(text, limit, ellipsis = '…') {
  const source = String(text ?? '')
  const points = Array.from(source)
  if (points.length <= limit) return { text: source, truncated: false }
  const keep = Math.max(0, limit - ellipsis.length)
  return { text: points.slice(0, keep).join('') + ellipsis, truncated: true }
}

function excerpt(text, limit) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  return truncateAtCodePoints(flat, limit)
}

/** 造一个保护项：reason / source / releaseCondition 三项永远有值。 */
function protectedItem({
  protectionClass,
  itemId,
  lines = [],
  reason = null,
  source = null,
  releaseCondition = null,
  sourceRef = null,
  detail = null,
}) {
  const rule = PROTECTION_RULES[protectionClass] ?? null
  return {
    itemId,
    protectionClass,
    strength: PROTECTION_STRENGTH.HARD,
    lines: [...lines],
    reason: reason ?? rule?.reason ?? '未说明',
    source: source ?? 'unknown',
    releaseCondition: releaseCondition ?? rule?.releaseCondition ?? '未给出释放条件（按不可释放处理）',
    sourceRef,
    detail,
  }
}

/** 造一个软保留项：同样带 reason / source / releaseCondition。 */
function retentionItem({ retentionClass, itemId, lines = [], reason = null, source = null, releaseCondition = null, sourceRef = null, required = null }) {
  const rule = RETENTION_RULES[retentionClass] ?? null
  return {
    itemId,
    retentionClass,
    strength: PROTECTION_STRENGTH.SOFT,
    lines: [...lines],
    reason: reason ?? rule?.reason ?? '未说明',
    source: source ?? 'unknown',
    releaseCondition: releaseCondition ?? rule?.releaseCondition ?? '未给出释放条件。',
    sourceRef,
    // S1：required=true 的软条目在预算覆盖选择时必选（否定/更正可见）；
    // 其余条目缺省 undefined（不改变既有消费方对「无 required 字段」的读取）。
    ...(required === true ? { required: true } : {}),
  }
}

/**
 * claim 配额选择：**否定/撤回优先**，再按原顺序补 positive。
 *
 * 按列表顺序截断会让「最新」永远落选：`surfaceClaimsOf` 按 seq 升序产出（最旧在前），
 * 于是超过配额的永远是最近的更正/撤回——而那正是 1498 行承诺必须可见的东西。
 * 模型看不到「上一条结论作废」，就会按已撤回的结论继续行动。
 *
 * 返回 `{ raw, index }`：index 仍是**原列表下标**，用于 `claim:<index>` 之类的稳定引用
 * （换成筛选后下标会让同一 claim 在不同步之间换 ID）。
 */
function selectClaims(claims, cap) {
  const items = Array.isArray(claims) ? claims : []
  const limit = Number.isFinite(Number(cap)) ? Math.max(0, Math.floor(Number(cap))) : items.length
  // `slice(-0)` 等价于 `slice(0)`：配额 0 会把**整张表**留下（0.13.2 D-11）。
  // 「一条都不要」必须真的一条都不给，否则「全局有界」的声明在 maxAssistantClaims=0
  // 时直接失效，页脚还会写「另有 N 条未展开」与正文自相矛盾。
  if (limit === 0) return []
  const indexed = items.map((raw, index) => ({ raw, index }))
  const negative = (entry) => {
    const polarity = (typeof entry.raw === 'string' ? 'positive' : (entry.raw?.polarity ?? 'positive'))
    return polarity === 'negated' || polarity === 'retracted'
  }
  if (limit >= items.length) return indexed
  const negatives = indexed.filter(negative)
  const positives = indexed.filter((entry) => !negative(entry))
  return [...negatives.slice(-limit), ...positives.slice(0, Math.max(0, limit - Math.min(negatives.length, limit)))]
    .sort((a, b) => a.index - b.index)
}

function take(list, cap) {
  const items = Array.isArray(list) ? list : []
  const limit = capLimitOf(cap, items.length)
  return { items: items.slice(0, limit), total: items.length, dropped: Math.max(0, items.length - limit) }
}

/**
 * 保留**最新**的 cap 条，输出仍按时间升序（从旧到新，读起来不跳序）。
 *
 * `slice(0, cap)` 留下的是最早的 cap 条、丢掉最新的——对进度列表正好丢反了
 * （审计 P2-5(d)）。`cap <= 0` 时显式返回空数组：`slice(-0)` 等价于 `slice(0)`，
 * 会把整表都留下。
 */
function newestTake(list, cap) {
  const items = Array.isArray(list) ? list : []
  const limit = capLimitOf(cap, items.length)
  if (limit === 0) return []
  return items.slice(-limit)
}

/**
 * 配额归一化：非有限/缺失一律回落到**全量**，不是 0。
 *
 * 旧实现里 `take()` 用 `slice(0, undefined)`（= 全量）而 `newestTake()` 把非有限夹成 0
 * （= 一条不留），两套兜底方向相反。调用方从可选配置拼 `limits` 时很容易传进
 * undefined，于是进度整段消失、连「另有 N 条」也不印（`length > undefined` 恒 false）。
 * 「没设上限」的正确含义是「不截断」，不是「全丢」。
 */
function capLimitOf(cap, total) {
  if (cap === undefined || cap === null) return total
  const numeric = Number(cap)
  if (!Number.isFinite(numeric)) return total
  return Math.max(0, Math.floor(numeric))
}

/**
 * 确定性提取工作状态。
 *
 * 输入只依赖宿主事实与 v2 配对账本；没有数据就留空并在 `unknowns` 里说明，
 * 不用推测补齐（规范 §5.1：未知不补猜成已完成）。
 *
 * 除原有参数外，新增的都是**可选**入参（evidence / pins / constraints /
 * inflightJobs / 各类软保留候选 / relations / projection），老调用方不传也成立。
 */
export function buildWorkingState({
  sessionId,
  surfaceNodes = [],
  eventAt,
  openCalls = [],
  lastAssistantSeq = null,
  limits = {},
  now = Date.now(),
  step = null,
  constraints = [],
  evidence = [],
  pins = [],
  inflightJobs = [],
  prefetch = [],
  redundantCards = [],
  nonEssentialHistory = [],
  rejectedOptions = [],
  openQuestions = [],
  // S1：助手结论盘点（方案 §7）——{ value, polarity, verified, recordRef }。
  // 默认 unverified；否定/撤回标 required（可见性不靠关键词升级）。
  claims = [],
  relations = [],
  projection = null,
  recordIdsForSeq = null,
  // callId → { callRecordId, resultRecordId } | null：v2 配对账本的精确对位。
  // 并行调用共享宿主 seq 时这是**唯一**可靠来源（见 `recordOfCall` 注释）。
  recordIdsForCallId = null,
  /**
   * 0.12.0 P0-1：「本步可回读」候选。
   *
   * 每项 `{ recordId, tools, range, locator, status, tokens }`，由运行时从**已归档行**
   * 组装（最多 3 条，见 `readbackSectionOf`）。卡片只描述结构，不复述正文——
   * 复述正文等于撤销归档。
   */
  readback = [],
} = {}) {
  const config = { ...WORKING_SET_DEFAULTS, ...limits }
  const nodes = Array.isArray(surfaceNodes) ? [...surfaceNodes] : []
  const clock = Number.isFinite(Number(now)) ? Number(now) : Date.now()

  /**
   * 把宿主 seq 翻译成**模型真能读的稳定记录 ID**。
   *
   * `seq:N` 只是宿主事件序号，不是记录 ID：把它当 ID 写进卡片，模型照着回读会得到
   * 「非法记录 ID」。有映射时一律用真实 ID；没有映射时如实标 `host-seq`（`readable:false`），
   * 让卡片自己说明这一条要怎么看，而不是给一个看起来能读、实际读不了的句柄。
   */
  const refOf = (seq, occurrence = 0) => {
    let ids = null
    if (typeof recordIdsForSeq === 'function') {
      try {
        const got = recordIdsForSeq(seq)
        if (Array.isArray(got) && got.length > 0) ids = got.filter((id) => typeof id === 'string' && id !== '')
      } catch {
        ids = null
      }
    }
    // 「按第 n 条取号」只对**无歧义**的桶成立：一条宿主事件承载多个块时（助手消息
    // 同时带 text/reasoning 与多个 tool-call），`idsBySeq(seq)` 的数组里混着所有块的
    // 记录，与「共享该 seq 的调用序列」不同构——`ids[occurrence]` 对不上就是**错位
    // 句柄**，模型照抄会回读到别人的正文（实测：并行调用 + 前置 text 块时，第一个
    // 调用拿到 text 块的记录、第二个拿到第一个调用的记录）。所以这里只在「该 seq
    // 恰好一条记录且是第一次出现」时给可读 ID；其余情况退回 host-seq 如实标注。
    // 精确对位走 `recordOfCall`（按 callId 查配对账本），见下。
    if (ids && ids.length === 1 && occurrence === 0) {
      return { ref: ids[0], refKind: 'record-id', readable: true, allIds: ids }
    }
    // 退回 `host-seq`（readable:false）。**必须带上出现次序**：同一 seq 的第 2、3 个
    // 并行调用如果都退回裸 `seq:N`，卡片里就会出现多行同句柄的进度，看起来像重复
    // 记账，实际是几条不同调用。第 0 个保持裸 `seq:N`（最常见、也最像原样）。
    const hostRef = occurrence === 0 ? `seq:${seq}` : `seq:${seq}+${occurrence}`
    return { ref: hostRef, refKind: 'host-seq', readable: false, allIds: ids ?? [] }
  }

  /**
   * callId 精确对位：v2 配对账本（callId → 调用/结果记录 ID）。
   *
   * 这是并行调用共享宿主 seq 时的**唯一**可靠来源：ingest 给消息里每个 content 块
   * 各写一条记录并全部挂在消息 seq 的倒排桶里（见 `refOf` 注释），seq 侧无论怎么
   * 取号都可能与调用序列错位；而配对账本按 callId 记账，天然指向该调用自己的正文。
   * 查不到（账本未提供 / 该 callId 尚无记录）返回 null，调用方退回 `refOf` 兜底；
   * 查询抛错同样退回兜底，不让卡片因此失败。
   */
  const recordOfCall = (callId) => {
    if (typeof recordIdsForCallId !== 'function' || typeof callId !== 'string' || callId === '') return null
    try {
      const got = recordIdsForCallId(callId)
      if (got && typeof got === 'object') {
        const callRecordId = typeof got.callRecordId === 'string' && got.callRecordId !== '' ? got.callRecordId : null
        const resultRecordId = typeof got.resultRecordId === 'string' && got.resultRecordId !== '' ? got.resultRecordId : null
        if (callRecordId !== null || resultRecordId !== null) return { callRecordId, resultRecordId }
      }
    } catch {
      // 账本查询失败：退回 seq 兜底，不吞掉整个卡片构建。
    }
    return null
  }

  let activeHumanRequest = null
  const progress = []
  const unseenResults = []
  const unknowns = []
  const callsById = new Map()
  const resultsById = new Map()
  let lastAssistant = Number.isSafeInteger(lastAssistantSeq) ? lastAssistantSeq : null

  for (const seq of nodes) {
    const event = eventAt?.(seq)
    if (!event) {
      unknowns.push({ key: `seq:${seq}`, reason: '表面节点取不到事件内容' })
      continue
    }
    const data = event.data ?? {}

    if (event.type === 'user/message' && isHumanAuthoredMessage(event)) {
      // 最后一条人类输入才是「当前请求」；更早的人类输入属于历史。
      // 插件自己的归档回执/恢复回执/状态卡/回注包同样是 user/message，但作者不是
      // 人类，绝不能占据这个位置（审计 P0-3：卡片曾指向插件自己的回执）。
      const body = excerpt(textOfBlocks(data.content), config.excerptChars)
      const ref = refOf(seq)
      activeHumanRequest = {
        sourceId: ref.ref,
        sourceRefKind: ref.refKind,
        sourceReadable: ref.readable,
        messageId: data.id ?? null,
        excerpt: body.text,
        truncated: body.truncated,
      }
      continue
    }

    if (event.type === 'assistant/message') {
      if (typeof data.turn === 'number' || typeof data.step === 'number') {
        lastAssistant = lastAssistant === null ? seq : Math.max(lastAssistant, seq)
      }
      for (const block of data.message?.content ?? []) {
        if (block?.type !== 'tool-call') continue
        callsById.set(block.id, { seq, callId: block.id, toolName: block.name ?? null })
      }
      continue
    }

    if (event.type === 'tool/result') {
      const callId = data.message?.toolCallId ?? data.message?.source?.callId ?? null
      if (callId !== null) resultsById.set(callId, { seq, callId })
    }
  }

  // 进度：每个「调用 + 结果」都进了当前表面，就记为已在主模型可见面出现。
  //
  // 记录句柄优先按 callId 精确对位（配对账本），共享同一宿主 seq 的并行调用各拿
  // 各的；账本没有该 callId 时才退回 `refOf`（seq+出现次序，只保无歧义场景）。
  const callSeenPerSeq = new Map()
  for (const call of callsById.values()) {
    const result = resultsById.get(call.callId) ?? null
    const occurrence = callSeenPerSeq.get(call.seq) ?? 0
    callSeenPerSeq.set(call.seq, occurrence + 1)
    const callRecord = recordOfCall(call.callId)
    const callRef = callRecord?.callRecordId
      ? { ref: callRecord.callRecordId, refKind: 'record-id', readable: true }
      : refOf(call.seq, occurrence)
    const resultRef = result
      ? (callRecord?.resultRecordId
        ? { ref: callRecord.resultRecordId, refKind: 'record-id', readable: true }
        : refOf(result.seq))
      : null
    progress.push({
      itemId: callRef.ref,
      itemIdKind: callRef.refKind,
      itemIdReadable: callRef.readable,
      callId: call.callId,
      tool: call.toolName,
      // 只声明宿主事实：结果是否在可见面里，不声称模型理解了它。
      status: result ? 'result-visible' : 'call-only',
      evidenceRefs: resultRef ? [resultRef.ref] : [],
      evidenceRefsReadable: resultRef ? resultRef.readable : null,
    })
  }

  // 未曝光结果：出现在最后一次助手决策之后的结果，主模型还没有机会看到。
  //
  // `lastAssistant === null` 时**不能**把阈值当作 +Infinity 然后宣布「没有未曝光
  // 结果」——那是把「不知道」渲染成「都已曝光」。此时判定不可用，如实标 unknown。
  const exposureDecidable = lastAssistant !== null
  const threshold = exposureDecidable ? lastAssistant : Number.POSITIVE_INFINITY
  for (const result of resultsById.values()) {
    if (exposureDecidable && result.seq > threshold) {
      // 结果句柄同样优先按 callId 精确对位（多块结果的记录也不与 seq 一一同构）。
      const resultRecord = recordOfCall(result.callId)
      const ref = resultRecord?.resultRecordId
        ? { ref: resultRecord.resultRecordId, refKind: 'record-id', readable: true }
        : refOf(result.seq)
      unseenResults.push({
        recordRef: ref.ref,
        recordRefKind: ref.refKind,
        recordRefReadable: ref.readable,
        callId: result.callId,
        reason: 'last-assistant-decision',
      })
    }
  }

  // 未闭合调用 = **活动面上「有调用、没有结果」的调用** ∪ 冷库配对账本里未闭合的调用。
  //
  // 只从冷库 `openCalls()` 推断是错的：当前正在跑的那个调用还没进冷库（要等它结算、
  // 归档之后才进），于是卡片会显示「在途动作：无」，而事实是有一个调用正在途中。
  // 活动面才是权威来源（宿主事实），冷库账本是补充——它还能覆盖「调用已归档、
  // 结果尚未归档」的中间态。
  const surfaceOpenCalls = []
  // 在途调用同样按 callId 精确对位；兜底路径带出现次序，避免并行在途调用共用句柄。
  const openSeenPerSeq = new Map()
  for (const call of callsById.values()) {
    if (resultsById.has(call.callId)) continue
    const occurrence = openSeenPerSeq.get(call.seq) ?? 0
    openSeenPerSeq.set(call.seq, occurrence + 1)
    const callRecord = recordOfCall(call.callId)
    const ref = callRecord?.callRecordId
      ? { ref: callRecord.callRecordId, refKind: 'record-id', readable: true }
      : refOf(call.seq, occurrence)
    surfaceOpenCalls.push({
      callId: call.callId,
      callRecordId: ref.readable ? ref.ref : null,
      recordRefKind: ref.refKind,
      recordRefReadable: ref.readable,
      toolName: call.toolName ?? null,
      source: 'surface:unpaired-tool-call',
    })
  }
  const ledgerOpenCalls = (Array.isArray(openCalls) ? openCalls : [])
    .map((entry) => ({ ...entry, source: 'cold-ledger' }))
  const mergedOpenCalls = []
  const seenOpenCallIds = new Set()
  for (const entry of [...surfaceOpenCalls, ...ledgerOpenCalls]) {
    const key = entry.callId ?? `record:${entry.callRecordId ?? 'unknown'}`
    if (seenOpenCallIds.has(key)) continue
    seenOpenCallIds.add(key)
    mergedOpenCalls.push(entry)
  }

  // 保留**最新**的在途调用（0.13.2 D-13）：列表按出现次序旧在前，`take` 留头部等于
  // 丢掉「我刚发出的那个调用」——那恰恰是模型最需要知道「我在等哪个结果」的一行。
  const openActions = newestTake(mergedOpenCalls, config.maxOpenActions).map((entry) => ({
    callId: entry.callId ?? null,
    recordRef: entry.callRecordId ?? null,
    recordRefKind: entry.recordRefKind ?? (entry.callRecordId ? 'record-id' : 'host-seq'),
    recordRefReadable: entry.recordRefReadable ?? entry.callRecordId !== null,
    actionState: 'awaiting-result',
    sourceRef: entry.callRecordId ?? null,
    toolName: entry.toolName ?? null,
    // 来源必须逐条如实：活动面未配对的调用与冷库账本里的未闭合配对不是一回事。
    source: entry.source ?? 'cold-ledger',
  }))

  if (callsById.size > 0 && progress.length === 0) {
    unknowns.push({ key: 'progress', reason: '表面有工具调用但未能确定性提取进度' })
  }
  if (lastAssistant === null && nodes.length > 0) {
    unknowns.push({ key: 'exposure', reason: '没有可判定的助手决策节点，未曝光判定按保守处理' })
  }

  // --- 保护集 ---
  const protectedSet = []

  // (a) 当前真实人类请求 + 仍然有效的约束
  if (activeHumanRequest) {
    protectedSet.push(protectedItem({
      protectionClass: PROTECTION_CLASSES.HUMAN_REQUEST,
      itemId: `human-request:${activeHumanRequest.sourceId}`,
      lines: [`当前人类请求（${activeHumanRequest.sourceId}）：${activeHumanRequest.excerpt}`
        + `${activeHumanRequest.truncated ? '（已截断，原文按记录 ID 回读）' : ''}`],
      source: `surface:${activeHumanRequest.sourceId}`,
      sourceRef: activeHumanRequest.sourceId,
      detail: { truncated: activeHumanRequest.truncated, messageId: activeHumanRequest.messageId },
    }))
  } else {
    protectedSet.push(protectedItem({
      protectionClass: PROTECTION_CLASSES.HUMAN_REQUEST,
      itemId: 'human-request:missing',
      lines: ['当前人类请求：未能从表面确定性提取（不猜；该保护位保留，不得当作「没有请求」）。'],
      reason: '当前人类请求是本次工作的目标本身；提取不到也要保留这个位置，并如实标注为未知。',
      source: 'surface:none',
    }))
  }

  const constraintList = Array.isArray(constraints) ? constraints : []
  const validConstraints = []
  const revokedConstraints = []
  for (const [index, raw] of constraintList.entries()) {
    const item = typeof raw === 'string' ? { text: raw } : (raw ?? {})
    const text = String(item.text ?? '').trim()
    if (text === '') continue
    const entry = {
      text,
      sourceRef: item.sourceRef ?? `constraint:${index}`,
      stillValid: item.stillValid !== false,
    }
    if (entry.stillValid) validConstraints.push(entry)
    else revokedConstraints.push(entry)
  }
  // 约束同样旧在前：超配额时必须留**最新**的（0.13.2 D-13）。
  const constraintCap = capLimitOf(config.maxConstraints, validConstraints.length)
  for (const item of newestTake(validConstraints, config.maxConstraints)) {
    protectedSet.push(protectedItem({
      protectionClass: PROTECTION_CLASSES.HUMAN_REQUEST,
      itemId: `constraint:${item.sourceRef}`,
      lines: [`仍然有效的约束（${item.sourceRef}）：${item.text}`],
      source: `constraint:${item.sourceRef}`,
      sourceRef: item.sourceRef,
    }))
  }
  if (validConstraints.length > constraintCap) {
    protectedSet.push(protectedItem({
      protectionClass: PROTECTION_CLASSES.HUMAN_REQUEST,
      itemId: 'constraint:overflow',
      lines: [`另有 ${validConstraints.length - constraintCap} 条有效约束未展开（同样不可丢弃，需按记录 ID 回读）`],
      source: 'constraint:overflow',
    }))
  }

  // (b) 未闭合调用
  for (const action of openActions) {
    protectedSet.push(protectedItem({
      protectionClass: PROTECTION_CLASSES.UNCLOSED_CALL,
      itemId: `open-call:${action.callId ?? action.recordRef ?? 'unknown'}`,
      lines: [
        `在途动作 ${action.callId ?? '（无 callId）'}${action.toolName ? `（${action.toolName}）` : ''}：`
        + `${action.actionState}，来源 ${action.source === 'surface:unpaired-tool-call' ? '活动面未配对调用' : '冷库配对账本'}`
        + `${action.recordRef ? `，记录 ${action.recordRef}` : ''}`,
      ],
      source: action.source === 'surface:unpaired-tool-call'
        ? '活动面（宿主事实：有调用、无结果）'
        : 'v2 配对账本（store.openCalls()）',
      sourceRef: action.sourceRef,
      detail: action,
    }))
  }
  if (mergedOpenCalls.length > openActions.length) {
    protectedSet.push(protectedItem({
      protectionClass: PROTECTION_CLASSES.UNCLOSED_CALL,
      itemId: 'open-call:overflow',
      lines: [`另有 ${mergedOpenCalls.length - openActions.length} 个未闭合配对未展开（同样不可丢弃）`],
      source: '活动面未配对调用 + v2 配对账本',
    }))
  }

  // (c) 未曝光结果
  // 未曝光结果按 seq 升序到达：`take` 留最旧的 6 条，最新结果只报数量并掉出
  // minimalWorkingState.dependencyRefs——与进度列表（P2-5(d)）完全同一类「丢反了」。
  const unseenItems = newestTake(unseenResults, config.maxUnseenResults)
  const unseenDropped = Math.max(0, (Array.isArray(unseenResults) ? unseenResults.length : 0) - unseenItems.length)
  for (const item of unseenItems) {
    protectedSet.push(protectedItem({
      protectionClass: PROTECTION_CLASSES.UNEXPOSED_RESULT,
      itemId: `unexposed:${item.recordRef}`,
      lines: [`未曝光结果 ${item.recordRef}（callId ${item.callId ?? '未知'}，依据 ${item.reason}）`],
      source: 'surface:tool/result',
      sourceRef: item.recordRef,
    }))
  }
  if (unseenDropped > 0) {
    protectedSet.push(protectedItem({
      protectionClass: PROTECTION_CLASSES.UNEXPOSED_RESULT,
      itemId: 'unexposed:overflow',
      lines: [`另有 ${unseenDropped} 条未曝光结果未展开（同样不可丢弃）`],
      source: 'surface:tool/result',
    }))
  }

  // (d) 在途作业与未确认副作用
  const jobList = Array.isArray(inflightJobs) ? inflightJobs : []
  const openJobs = []
  const settledJobs = []
  for (const [index, raw] of jobList.entries()) {
    const job = raw ?? {}
    const terminal = job.state === 'done' || job.state === 'failed' || job.state === 'cancelled'
    const confirmed = job.confirmed === true
    if (terminal && confirmed) settledJobs.push({ ...job, index })
    else openJobs.push({ ...job, index })
  }
  for (const job of take(openJobs, config.maxInflightJobs).items) {
    const label = job.jobId ?? job.id ?? `job#${job.index}`
    const kind = job.kind === 'side-effect' ? '未确认副作用' : '在途作业'
    protectedSet.push(protectedItem({
      protectionClass: PROTECTION_CLASSES.INFLIGHT_JOB,
      itemId: `inflight:${label}`,
      lines: [`${kind} ${label}：状态 ${job.state ?? '未知'}，副作用确认=${job.confirmed === true}`],
      source: job.source ?? 'host:jobs',
      sourceRef: String(label),
      detail: { state: job.state ?? null, confirmed: job.confirmed === true },
    }))
  }
  if (openJobs.length > config.maxInflightJobs) {
    protectedSet.push(protectedItem({
      protectionClass: PROTECTION_CLASSES.INFLIGHT_JOB,
      itemId: 'inflight:overflow',
      lines: [`另有 ${openJobs.length - config.maxInflightJobs} 个在途作业未展开（同样不可丢弃）`],
      source: 'host:jobs',
    }))
  }

  // (e)(f) 证据与 pin
  const boundEvidence = (Array.isArray(evidence) ? evidence : [])
    .slice(0, Math.max(config.maxEvidence, 0))
    .map((item) => bindEvidence(item, { now: clock }))
  const necessaryEvidence = boundEvidence.filter((item) => item.status === EVIDENCE_STATUS.VALID && item.necessary)
  const staleNecessary = boundEvidence.filter((item) => item.status === EVIDENCE_STATUS.STALE && item.necessary)
  const unverifiedNecessary = boundEvidence.filter((item) => item.status === EVIDENCE_STATUS.UNVERIFIED && item.necessary)

  for (const item of necessaryEvidence) {
    protectedSet.push(protectedItem({
      protectionClass: PROTECTION_CLASSES.NECESSARY_EVIDENCE,
      itemId: `necessary-evidence:${item.recordRef}`,
      lines: [`必要证据 ${item.recordRef}：状态 valid，指纹 ${item.fingerprint}，来源 ${item.sourceKind}`],
      source: item.source,
      sourceRef: item.recordRef,
      detail: item,
    }))
  }
  // 关键证据一旦 stale/未验证，就必须以「未知」这一协议位常驻，而不是冒充有效证据。
  for (const item of staleNecessary) {
    protectedSet.push(protectedItem({
      protectionClass: PROTECTION_CLASSES.UNKNOWN_PROTOCOL,
      itemId: `stale-necessary-evidence:${item.recordRef}`,
      lines: [`关键证据 ${item.recordRef} 状态=stale：${item.statusReason}`],
      reason: '关键证据的版本指纹与当前不一致：必须重新取证，不能沿用旧结论。',
      source: item.source,
      sourceRef: item.recordRef,
      detail: item,
    }))
  }
  for (const item of unverifiedNecessary) {
    protectedSet.push(protectedItem({
      protectionClass: PROTECTION_CLASSES.UNKNOWN_PROTOCOL,
      itemId: `unverified-necessary-evidence:${item.recordRef}`,
      lines: [`关键证据 ${item.recordRef} 状态=unverified：${item.statusReason}`],
      reason: '关键证据没有可比的版本指纹：不能当作有效证据，需要补指纹后复核。',
      source: item.source,
      sourceRef: item.recordRef,
      detail: item,
    }))
  }

  const evaluatedPins = (Array.isArray(pins) ? pins : [])
    .slice(0, Math.max(config.maxPins, 0))
    .map((pin) => evaluatePin(pin, { now: clock, step }))
  const validPins = evaluatedPins.filter((pin) => pin.status === PIN_STATUS.VALID)
  const expiredPins = evaluatedPins.filter((pin) => pin.status === PIN_STATUS.EXPIRED)
  const invalidPins = evaluatedPins.filter((pin) => pin.status === PIN_STATUS.INVALID)

  for (const pin of validPins) {
    protectedSet.push(protectedItem({
      protectionClass: PROTECTION_CLASSES.VALID_PIN,
      itemId: pin.itemId,
      lines: [`有效 pin ${pin.recordRef}：到期 ${pin.expiresAt}，复核条件 ${pin.reviewCondition}`],
      source: `pin:${pin.source}`,
      sourceRef: pin.recordRef,
      releaseCondition: pin.releaseCondition,
      detail: pin,
    }))
  }
  for (const pin of invalidPins) {
    unknowns.push({
      key: pin.itemId,
      reason: pin.invalidReason ?? 'pin 不构成保护（缺少失效时间或复核条件）',
    })
  }

  // (g) 最小工作状态：只保护当前最小依赖集，绝不整体 pin 长任务
  const dependencyRefs = []
  const pushDep = (ref) => {
    if (typeof ref === 'string' && ref !== '' && !dependencyRefs.includes(ref)) dependencyRefs.push(ref)
  }
  if (activeHumanRequest) pushDep(activeHumanRequest.sourceId)
  for (const action of openActions) pushDep(action.recordRef)
  for (const item of unseenItems) pushDep(item.recordRef)
  for (const item of necessaryEvidence) pushDep(item.recordRef)
  for (const pin of validPins) pushDep(pin.recordRef)
  const minimalRefs = dependencyRefs.slice(0, config.maxMinimalDependencies)
  // 「整条长任务 pin」不是一句写死的常量，而是从**真正进入保护集的条目**里算出来的：
  // 只有有效 pin（VALID_PIN）才可能构成 pin，而 evaluatePin 对 scope='whole-task'
  // 一律判 invalid（见上），所以这里正常恒为 false。把常量当观察结果渲染，等于把
  // 「规范不允许」冒充成「我们检查过确实没有」（审计 P2-5(e)）。
  const wholeTaskPinItems = protectedSet.filter((item) => item.protectionClass === PROTECTION_CLASSES.VALID_PIN
    && (item.detail?.scope === 'whole-task' || item.detail?.wholeTask === true))
  const wholeTaskPinned = wholeTaskPinItems.length > 0
  const wholeTaskPinRejected = evaluatedPins.filter((pin) => pin.scope === 'whole-task').length
  const minimalWorkingState = {
    dependencyRefs: minimalRefs,
    cap: config.maxMinimalDependencies,
    total: dependencyRefs.length,
    truncated: dependencyRefs.length > minimalRefs.length,
    excludedCount: Math.max(0, dependencyRefs.length - minimalRefs.length),
    wholeTaskPinned,
    // 如实记下「本步请求过整任务 pin、被规范拒绝了几条」，与上面的实际检查分开报。
    wholeTaskPinRejected,
    wholeTaskPinBasis: `${validPins.length} 条有效 pin（scope=whole-task 的一律不进保护集）`,
    source: '确定性提取：当前请求 + 未闭合配对 + 未曝光结果 + 必要证据 + 有效 pin',
    reason: PROTECTION_RULES[PROTECTION_CLASSES.MINIMAL_WORKING_STATE].reason,
    releaseCondition: PROTECTION_RULES[PROTECTION_CLASSES.MINIMAL_WORKING_STATE].releaseCondition,
  }
  protectedSet.push(protectedItem({
    protectionClass: PROTECTION_CLASSES.MINIMAL_WORKING_STATE,
    itemId: 'minimal-working-state',
    lines: [
      `最小依赖集（${minimalRefs.length}/${minimalWorkingState.cap}）：${minimalRefs.length > 0 ? minimalRefs.join('、') : '无'}`,
      `整条长任务 pin：${wholeTaskPinned ? '存在（与规范冲突，必须复核）' : '不存在'}`
      + `（wholeTaskPinned=${wholeTaskPinned}；依据 ${wholeTaskPinItems.length}/${validPins.length} 条有效 pin 带整任务范围，本步另有 ${wholeTaskPinRejected} 条整任务 pin 请求被拒绝）`,
    ],
    source: minimalWorkingState.source,
    releaseCondition: minimalWorkingState.releaseCondition,
    detail: minimalWorkingState,
  }))

  // 关系：判定不了就 unknown + 保守回退
  const resolvedRelations = (Array.isArray(relations) ? relations : []).map((raw) => resolveRelation(raw ?? {}))
  const unknownRelations = resolvedRelations.filter((item) => !item.resolved)
  for (const item of unknownRelations.slice(0, config.maxUnknowns)) {
    protectedSet.push(protectedItem({
      protectionClass: PROTECTION_CLASSES.UNKNOWN_PROTOCOL,
      itemId: `unknown-relation:${item.subjectRef ?? '?'}->${item.objectRef ?? '?'}`,
      lines: [`关系未知 ${item.subjectRef ?? '?'} → ${item.objectRef ?? '?'}：按原文并列呈现，不补写依赖边`],
      reason: item.reason,
      source: 'relation:unknown',
      sourceRef: item.subjectRef,
      detail: item,
    }))
  }
  for (const rule of UNKNOWN_RELATION_RULES) {
    protectedSet.push(protectedItem({
      protectionClass: PROTECTION_CLASSES.UNKNOWN_PROTOCOL,
      itemId: `relation-rule:${rule.slice(0, 12)}`,
      lines: [`保守规则：${rule}`],
      reason: '关系不可判定时的显式条文：宁可保守，也不编造关系。',
      source: 'relation:unknown-rules',
    }))
  }

  const unknownTake = take(unknowns, config.maxUnknowns)
  for (const item of unknownTake.items) {
    protectedSet.push(protectedItem({
      protectionClass: PROTECTION_CLASSES.UNKNOWN_PROTOCOL,
      itemId: `unknown:${item.key}`,
      lines: [`未知 ${item.key}：${item.reason}`],
      source: 'extraction:unknown',
      sourceRef: item.key,
    }))
  }
  if (unknownTake.dropped > 0) {
    protectedSet.push(protectedItem({
      protectionClass: PROTECTION_CLASSES.UNKNOWN_PROTOCOL,
      itemId: 'unknown:overflow',
      lines: [`另有 ${unknownTake.dropped} 条未知未展开（同样不可丢弃）`],
      source: 'extraction:unknown',
    }))
  }

  // --- 软保留 ---
  // claim 配额只算一次：正文（selectClaims）与页脚（溢出计数）必须用同一把尺子。
  const claimCap = capLimitOf(config.maxAssistantClaims, Array.isArray(claims) ? claims.length : 0)
  const retention = {
    [RETENTION_CLASSES.OPTIONAL_PREFETCH]: take(prefetch, config.maxPrefetch).items.map((raw, index) => {
      const item = typeof raw === 'string' ? { text: raw } : (raw ?? {})
      return retentionItem({
        retentionClass: RETENTION_CLASSES.OPTIONAL_PREFETCH,
        itemId: item.itemId ?? `prefetch:${index}`,
        lines: [`可选预取 ${item.itemId ?? index}：${String(item.text ?? item.summary ?? '').slice(0, config.excerptChars)}`],
        source: item.source ?? 'prefetch',
        sourceRef: item.sourceRef ?? null,
      })
    }),
    [RETENTION_CLASSES.REDUNDANT_CARD]: take(redundantCards, config.maxRedundantCards).items.map((raw, index) => {
      const item = typeof raw === 'string' ? { itemId: raw } : (raw ?? {})
      return retentionItem({
        retentionClass: RETENTION_CLASSES.REDUNDANT_CARD,
        itemId: item.itemId ?? `redundant:${index}`,
        lines: [`冗余卡片 ${item.itemId ?? index}${item.supersededBy ? `（已被 ${item.supersededBy} 取代）` : ''}`],
        source: item.source ?? 'cards',
        sourceRef: item.supersededBy ?? null,
      })
    }),
    [RETENTION_CLASSES.NON_ESSENTIAL_HISTORY]: [
      ...take(nonEssentialHistory, config.maxNonEssentialHistory).items.map((raw, index) => {
        const item = typeof raw === 'string' ? { itemId: raw } : (raw ?? {})
        return retentionItem({
          retentionClass: RETENTION_CLASSES.NON_ESSENTIAL_HISTORY,
          itemId: item.itemId ?? `history:${index}`,
          lines: [`非必要历史 ${item.itemId ?? index}${item.ref ? `（出处 ${item.ref}）` : ''}`],
          source: item.source ?? 'history',
          sourceRef: item.ref ?? null,
        })
      }),
      // 已完成探索分支的进度也属于非必要历史：先退役，再谈别的。
      // 保留**最新**的若干条（旧条目先退役）：`slice(0, n)` 会把最新进度丢掉，
      // 卡片就永远停在最早的几步上（审计 P2-5(d)）。
      ...newestTake(progress, config.maxProgressItems).map((item) => retentionItem({
        retentionClass: RETENTION_CLASSES.NON_ESSENTIAL_HISTORY,
        itemId: `progress:${item.itemId}`,
        lines: [`进度 ${item.itemId} 工具 ${item.tool ?? '未知'} 状态 ${item.status}`],
        reason: '进度是宿主事实，但已经进入可见面、且不构成当前依赖：属于可先退役的非必要历史。',
        source: 'surface:progress',
        sourceRef: item.itemId,
      })),
      ...(progress.length > capLimitOf(config.maxProgressItems, progress.length)
        ? [retentionItem({
            retentionClass: RETENTION_CLASSES.NON_ESSENTIAL_HISTORY,
            itemId: 'progress:overflow',
            lines: [`另有 ${progress.length - capLimitOf(config.maxProgressItems, progress.length)} 条进度未展开（只报数量，正文按记录 ID 回读）`],
            reason: '进度超出单卡上限：属于可退役的非必要历史，超出部分只报数量，不静默丢。',
            source: 'surface:progress',
          })]
        : []),
      ...revokedConstraints.map((item) => retentionItem({
        retentionClass: RETENTION_CLASSES.NON_ESSENTIAL_HISTORY,
        itemId: `revoked-constraint:${item.sourceRef}`,
        lines: [`已撤销/失效的约束（${item.sourceRef}）：${item.text}`],
        reason: '该约束已被显式标记为不再有效：保留出处，但不再作为保护对象。',
        source: `constraint:${item.sourceRef}`,
        sourceRef: item.sourceRef,
      })),
      ...settledJobs.map((job) => retentionItem({
        retentionClass: RETENTION_CLASSES.NON_ESSENTIAL_HISTORY,
        itemId: `settled-job:${job.jobId ?? job.id ?? job.index}`,
        lines: [`已终态且副作用已确认的作业 ${job.jobId ?? job.id ?? job.index}（状态 ${job.state}）`],
        reason: '作业已到终态且副作用已确认：不再属于在途状态。',
        source: job.source ?? 'host:jobs',
      })),
    ],
    [RETENTION_CLASSES.STALE_EVIDENCE]: boundEvidence
      .filter((item) => item.status === EVIDENCE_STATUS.STALE)
      .map((item) => retentionItem({
        retentionClass: RETENTION_CLASSES.STALE_EVIDENCE,
        itemId: item.itemId,
        lines: [`stale 证据 ${item.recordRef}：${item.statusReason}`],
        source: item.source,
        sourceRef: item.recordRef,
      })),
    [RETENTION_CLASSES.UNVERIFIED_EVIDENCE]: [
      ...boundEvidence
        .filter((item) => item.status === EVIDENCE_STATUS.UNVERIFIED)
        .map((item) => retentionItem({
          retentionClass: RETENTION_CLASSES.UNVERIFIED_EVIDENCE,
          itemId: item.itemId,
          lines: [`unverified 证据 ${item.recordRef}：${item.statusReason}`],
          source: item.source,
          sourceRef: item.recordRef,
        })),
      // S1 助手结论盘点（方案 §7）：claim 默认 unverified，进同一软保留段；
      // 否定/撤回标 required（否定/更正可见），positive 不标 required（不冒充已完成）。
      // 配额 maxAssistantClaims 全局有界；超出只报数量（不静默丢）。
      ...selectClaims(claims, config.maxAssistantClaims).map(({ raw, index }) => {
        const item = typeof raw === 'string' ? { value: raw } : (raw ?? {})
        const recordRef = item.recordRef ?? `claim:${index}`
        const polarity = item.polarity ?? 'positive'
        const negativeVisible = polarity === 'negated' || polarity === 'retracted'
        return retentionItem({
          retentionClass: RETENTION_CLASSES.UNVERIFIED_EVIDENCE,
          itemId: `assistant-claim:${item.recordRef ?? index}`,
          lines: [`助手结论（${polarity}，unverified，此前助手判断，不是事实）：${item.value}`],
          source: `claim:${item.sourceRef ?? item.recordRef ?? index}`,
          sourceRef: recordRef,
          required: negativeVisible === true,
        })
      }),
      ...(Array.isArray(claims) && claims.length > claimCap
        ? [retentionItem({
          retentionClass: RETENTION_CLASSES.UNVERIFIED_EVIDENCE,
          itemId: 'assistant-claim:overflow',
          // 与 selectClaims 同一把尺子（capLimitOf + floor），差值必为整数：
          // 直接用原始配额做减法会把 `另有 1.2999999999999998 条` 印进模型可见卡片
          // （0.13.2 D-19），而正文只列了 floor 后的条数——页脚与正文自相矛盾。
          lines: [`另有 ${claims.length - claimCap} 条助手结论未展开（只报数量，unverified）`],
          source: 'claim:overflow',
        })]
        : []),
    ],
    [RETENTION_CLASSES.EXPIRED_PIN]: [...expiredPins, ...invalidPins].map((pin) => retentionItem({
      retentionClass: RETENTION_CLASSES.EXPIRED_PIN,
      itemId: pin.itemId,
      lines: [`${pin.status === PIN_STATUS.EXPIRED ? '过期' : '无效'} pin ${pin.recordRef}：${pin.invalidReason ?? pin.releaseCondition}`],
      source: `pin:${pin.source}`,
      sourceRef: pin.recordRef,
      releaseCondition: pin.releaseCondition,
    })),
    [RETENTION_CLASSES.REJECTED_OPTION]: take(rejectedOptions, config.maxRejectedOptions).items.map((raw, index) => {
      const item = typeof raw === 'string' ? { option: raw } : (raw ?? {})
      return retentionItem({
        retentionClass: RETENTION_CLASSES.REJECTED_OPTION,
        itemId: item.itemId ?? `rejected:${index}`,
        lines: [`已否决选项 ${item.option ?? item.itemId ?? index}${item.reason ? `：${item.reason}` : ''}`],
        source: item.source ?? 'decision',
      })
    }),
    [RETENTION_CLASSES.OPEN_QUESTION]: take(openQuestions, config.maxOpenQuestions).items.map((raw, index) => {
      const item = typeof raw === 'string' ? { question: raw } : (raw ?? {})
      return retentionItem({
        retentionClass: RETENTION_CLASSES.OPEN_QUESTION,
        itemId: item.itemId ?? `question:${index}`,
        lines: [`未决问题 ${item.question ?? item.itemId ?? index}`],
        source: item.source ?? 'open-question',
      })
    }),
  }

  // P1-4：硬保护项的角色/编号一致性（同 seq 不得同时出现在两类硬保护）。
  const identity = resolveProtectionIdentity(protectedSet)
  const byClass = {}
  for (const item of protectedSet) {
    byClass[item.protectionClass] = (byClass[item.protectionClass] ?? 0) + 1
  }
  const softByClass = {}
  for (const [retentionClass, items] of Object.entries(retention)) {
    if (items.length > 0) softByClass[retentionClass] = items.length
  }

  const activeProjection = projection && typeof projection === 'object' && Array.isArray(projection.stages)
    ? projection
    : createProjection({})

  return {
    schemaVersion: WORKING_STATE_SCHEMA_VERSION,
    sessionId,
    generatedAt: new Date(clock).toISOString(),
    // --- 原有字段（保持形状，消费方不用改）---
    activeHumanRequest,
    essentialConstraints: newestTake(validConstraints, config.maxConstraints).map((item) => ({
      text: item.text,
      sourceRef: item.sourceRef,
      stillValid: true,
    })),
    openActions,
    unclosedPairCount: mergedOpenCalls.length,
    unseenResults: unseenItems,
    unseenResultCount: unseenResults.length,
    // 「不知道有没有未曝光结果」必须与「确认没有」分开报，否则卡片会把未知说成零。
    exposureDecidable,
    exposureNote: exposureDecidable
      ? null
      : '没有可判定的助手决策节点：未曝光结果无法判定，按保守处理（不声称「没有未曝光结果」）。',
    // 进度只报最新的若干条（顺序仍是时间升序）；总数另用 progressCount 如实给出。
    progress: newestTake(progress, config.maxProgressItems),
    progressCount: progress.length,
    pinnedEvidence: validPins,
    unknowns: unknownTake.items,
    // 明确声明能力边界：首版只读工具不提供模型写 pin 的入口。
    capabilities: {
      modelWritablePin: false,
      auxiliaryModel: false,
      readbackPinTtlMs: config.pinTtlMs,
    },
    /**
     * 0.12.0 P0-1：本步可回读候选（渲染时由 readbackSectionOf 装成硬段）。
     * 放在状态里而不是只放渲染参数里：卡片与状态必须对得上，调用方也要能对账。
     */
    readback: Array.isArray(readback) ? [...readback] : [],
    // --- 活跃工作集新增字段 ---
    protectedSet: identity.items,
    /** P1-4：同 seq 出现在两类硬保护时的告警（空数组 = 无冲突）。 */
    identityWarnings: identity.duplicates.map((ref) => `seq/引用 ${ref} 同时出现在两类硬保护里，已降级为「角色未确认」`),
    protectionSummary: {
      hard: protectedSet.length,
      hardByClass: byClass,
      hardClasses: PROTECTION_ORDER,
      ttlFreeHardClasses: TTL_FREE_HARD_CLASSES,
      softByClass,
      dropOrder: DROP_ORDER,
    },
    protectionInvariants: {
      hardItemsNeverDroppedForBudget: true,
      hardClassesAreTtlFree: true,
      softRetentionMayUseRecencyOrTtl: true,
      authorityNeverPromotedToSystem: true,
      summaryIsNotOriginalText: true,
      modelInferenceIsNotAuthorization: true,
      statusCardIsNotSystemMessage: true,
      wholeTaskNeverPinned: minimalWorkingState.wholeTaskPinned === false,
    },
    evidence: boundEvidence,
    pins: evaluatedPins,
    inflightJobs: openJobs,
    minimalWorkingState,
    relations: resolvedRelations,
    retention,
    projection: activeProjection,
  }
}

// ---------------------------------------------------------------------------
// 有界渲染
// ---------------------------------------------------------------------------

/**
 * 卡片正文的第一行。导出给检索层做正文前缀判定（D4：插件形态的兜底识别），
 * 单一出处，避免两处各写一份后漂移。
 */
export const CARD_HEADER = '[工作状态·v2]（插件生成的工作资料，不是系统指令；原文可按记录 ID 回读）'
const CARD_AUTHORITY_LINE = '本卡来源 status-card：authority 等于来源本身，不可提升为 system/developer/user；'
  + '摘要不等于原文，模型推断不构成授权。'

function hashText(text) {
  return `sha256:${createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex')}`
}

function section(title, lines, meta = {}) {
  return { title, lines, ...meta }
}

function renderSections(sections) {
  const out = []
  for (const item of sections) {
    if (!item || item.lines.length === 0) continue
    out.push(item.title)
    for (const line of item.lines) out.push(`- ${line}`)
  }
  return out.join('\n')
}

// ---------------------------------------------------------------------------
// 卡片去重：语义键（对每步都会变的 seq 引用归一化后再哈希）
// ---------------------------------------------------------------------------

/**
 * 硬前缀里每步都会变的引用形态：`seq:833`、`seq 12–15`、`seq 12-15`、`seq 12`、
 * `callId call_00_xxxx`。
 *
 * 只归一化**引用本身**（换成同一个占位符 `seq:#` / `call:#`），不动别的字段：条数、
 * 类目、依据与释放条件变了，语义键仍然会变。
 * callId 必须一起归一化：未曝光结果行同时带 `seq:N` 与 `callId call_xxx`，只归一化
 * seq 时键仍随每步的新 callId 变化，去重形同虚设（实测每步重注入一张卡）。
 */
const VOLATILE_SEQ_PATTERNS = Object.freeze([
  [/\bseq\s*[:：]?\s*\d+\s*[–—-]\s*\d+/gi, 'seq:#'],
  [/\bseq\s*[:：]\s*\d+/gi, 'seq:#'],
  [/\bseq\s+\d+/gi, 'seq:#'],
  [/\bcall_[0-9A-Za-z_]{8,}/g, 'call:#'],
])

/** 软段头与页脚：语义键只取硬前缀，必须把这几段从整卡文本里切掉。 */
const CARD_SOFT_HEADER_PREFIX = '■ 软保留'
/** 页脚文案随 F1 改成「按重要度分值升序」，切分按公共前缀匹配，两边不耦合。 */
const CARD_DROP_FOOTER_PREFIX = '因预算丢弃'
const CARD_HARD_OVERFLOW_PREFIX = '⚠ 硬保护内容'

/** 把每步都会变的 seq 引用归一化成 `seq:#`；其余文本逐字保留。 */
export function normalizeVolatileRefs(text) {
  let out = String(text ?? '')
  for (const [pattern, placeholder] of VOLATILE_SEQ_PATTERNS) out = out.replace(pattern, placeholder)
  return out
}

/**
 * 从整卡文本里取硬前缀：软保留段、丢弃页脚、硬溢出告警都不属于「保护集语义」。
 *
 * 边界按整行前缀判定（软段头与各软段标题都以 `■ 软保留` 开头，页脚有固定开头），
 * 硬段正文行一律带 `- ` 前缀，不会误判。
 */
export function hardPortionOfCard(text) {
  const kept = []
  for (const line of String(text ?? '').split('\n')) {
    if (line.startsWith(CARD_SOFT_HEADER_PREFIX)
      || line.startsWith(CARD_DROP_FOOTER_PREFIX)
      || line.startsWith(CARD_HARD_OVERFLOW_PREFIX)) break
    kept.push(line)
  }
  // 段与段之间用空行分隔：切掉后半段后会留下尾随空行，必须去掉，
  // 否则 chars 会比真实硬前缀多出换行符的字节数。
  return kept.join('\n').replace(/\n+$/, '')
}

/**
 * 卡片语义去重键。
 *
 * 键口径 = **整卡**（硬前缀 + 软保留段）对 seq/callId 引用归一化后取哈希。
 * v2 只取硬前缀是错的：软保留区的进度行每步都在变，键却不变，进度更新被去重
 * 静默吞掉（实测 c896f803：每步卡里真正变化的 4 行里就有进度行）。整卡口径下
 * 「语义没变、只是 seq 号变了」不会重新注入；任何一行真实变化，键一定变。
 * `CARD_SEMANTIC_VERSION` 编进键里，渲染口径升级时旧键自动失效。
 */
export function workingSetDedupKeyOf(cardText) {
  return `ws-card:v${CARD_SEMANTIC_VERSION}:${hashText(normalizeVolatileRefs(String(cardText ?? '')))}`
}

/**
 * 去重裁决（纯函数，无状态）：给定某会话**已注入过的语义键历史**，判断这一步要不要注入。
 *
 * 与「只跟上一个键比」的差别：历史是一个**有界集合**（默认最近
 * `WORKING_SET_DEDUP_HISTORY_LIMIT` 个），于是键回到某个更早的值（例如软内容抖
 * 回去、或状态回到几步前的样子）时不会被重复注入；`inject=false` 只表示「这张卡
 * 本会话已经注入过」，不表示卡的内容有问题。
 *
 * 拿不到会话键（`sessionId` 为空）时没有可用的去重范围：按原行为注入且不记账。
 */
export function decideWorkingSetInjection({
  dedupKey = null,
  sessionId = null,
  injectedKeys = [],
  limit = WORKING_SET_DEDUP_HISTORY_LIMIT,
} = {}) {
  const history = (Array.isArray(injectedKeys) ? injectedKeys : [])
    .filter((key) => typeof key === 'string' && key !== '')
  const cap = Number.isFinite(Number(limit))
    ? Math.max(0, Math.floor(Number(limit)))
    : WORKING_SET_DEDUP_HISTORY_LIMIT
  const bounded = cap === 0 ? [] : history.slice(-cap)
  if (sessionId === null || sessionId === undefined || typeof dedupKey !== 'string' || dedupKey === '') {
    return { inject: true, reason: 'no-session-or-key', dedupKey: typeof dedupKey === 'string' ? dedupKey : null, keys: bounded, evicted: 0 }
  }
  if (bounded.includes(dedupKey)) {
    return { inject: false, reason: 'already-injected', dedupKey, keys: bounded, evicted: 0 }
  }
  const next = [...bounded, dedupKey]
  const keys = cap === 0 ? [] : next.slice(-cap)
  return { inject: true, reason: 'new-key', dedupKey, keys, evicted: Math.max(0, next.length - keys.length) }
}

/** 「本步可回读」小节的行上限与单行字符上限（P0-1 不变量）。 */
export const CARD_READBACK_MAX_LINES = 3
export const CARD_READBACK_MAX_LINE_CHARS = 80

/**
 * 「本步可回读」小节（0.12.0 P0-1）。
 *
 * 一行 = 记录 ID + 一句话结构摘要（工具名 + 范围 + 对象）+ 取回代价。**只描述结构**：
 * 摘要里不出现正文片段，否则「归档」被自己撤销，下一次归档又会把它吃掉。
 * 超过 3 条只报计数，不逐条列（卡片是每步固定税）。
 */
export function readbackSectionOf(readback) {
  const items = (Array.isArray(readback) ? readback : [])
    .filter((item) => item && typeof item.recordId === 'string' && item.recordId !== '')
  if (items.length === 0) return null
  const lines = []
  for (const item of items.slice(0, CARD_READBACK_MAX_LINES)) {
    const tools = Array.isArray(item.tools) && item.tools.length > 0
      ? item.tools.join('/')
      : (typeof item.kind === 'string' && item.kind !== '' ? item.kind : '历史片段')
    const range = item.range && Number.isInteger(item.range.start) && Number.isInteger(item.range.end)
      ? 'seq ' + item.range.start + '–' + item.range.end
      : '范围未知'
    const locator = typeof item.locator === 'string' && item.locator !== '' ? '｜' + item.locator : ''
    // 只认**有限数字**：tokens 为 null / '' 时 Number() 会给出 0，把「代价未知」
    // 印成「取回 ≈0 token」——一个假的可执行结论（模型会以为回读免费）。
    const tokenCount = typeof item.tokens === 'number' && Number.isFinite(item.tokens) ? item.tokens : null
    const cost = tokenCount !== null ? '｜取回 ≈' + Math.trunc(tokenCount) + ' token' : ''
    const line = item.recordId + '｜' + tools + '｜' + range + locator + cost
    lines.push(truncateAtCodePoints(line, CARD_READBACK_MAX_LINE_CHARS).text)
  }
  if (items.length > CARD_READBACK_MAX_LINES) {
    lines.push('另有 ' + (items.length - CARD_READBACK_MAX_LINES) + ' 条可回读未列出')
  }
  return section('■ 本步可回读（memory_lab_recall(record_ids=[…]) 按 ID 精确取回；只给结构，不复述正文）', lines, {
    protectionClass: 'readback',
    strength: PROTECTION_STRENGTH.HARD,
  })
}

/**
 * 硬保护项的角色/编号一致性（0.12.0 P1-4，降级版）。
 *
 * 旧提案的「同 seq 冲突」在 107 张卡里 0 次复现（human 取 user seq、unexposed 取
 * tool/result seq，结构上不可能相同），所以**不引入 req:/evt: 双命名空间**。
 * 真实问题只有两个，这里各给一条可执行断言：
 * - 同一 seq 不得同时出现在两类硬保护；违反时两边都降级为「角色未确认」；
 * - 「当前人类请求」取**本轮** user 事件，取不到标 unknown，不回落上一轮。
 */
export function resolveProtectionIdentity(protectedSet) {
  const items = Array.isArray(protectedSet) ? protectedSet : []
  const byRef = new Map()
  for (const item of items) {
    const ref = typeof item?.sourceRef === 'string' || Number.isInteger(item?.sourceRef) ? String(item.sourceRef) : null
    if (ref === null || ref.startsWith('constraint:') || ref === 'none') continue
    const classes = byRef.get(ref) ?? new Set()
    classes.add(item.protectionClass)
    byRef.set(ref, classes)
  }
  const duplicates = [...byRef.entries()].filter(([, classes]) => classes.size > 1).map(([ref]) => ref)
  const duplicateSet = new Set(duplicates)
  const resolved = items.map((item) => {
    const ref = typeof item?.sourceRef === 'string' || Number.isInteger(item?.sourceRef) ? String(item.sourceRef) : null
    const conflicted = ref !== null && duplicateSet.has(ref)
    return {
      ...item,
      // 角色与种类是**声明**，不是推断：冲突时如实降级，不猜哪一类才对。
      role: conflicted ? 'unknown' : (item.protectionClass === PROTECTION_CLASSES.HUMAN_REQUEST ? 'user' : 'tool'),
      kind: conflicted ? 'unconfirmed' : item.protectionClass,
    }
  })
  return { items: resolved, duplicates, degraded: duplicates.length > 0 }
}

/** 按保护类目把 protectedSet 归组，产出硬段（每个类目一段）。 */
function hardSectionsOf(state) {
  const protectedSet = Array.isArray(state.protectedSet) ? state.protectedSet : []
  const sections = []
  for (const protectionClass of PROTECTION_ORDER) {
    const items = protectedSet.filter((item) => item.protectionClass === protectionClass)
    const rule = PROTECTION_RULES[protectionClass]
    const always = ALWAYS_RENDERED_PROTECTION.includes(protectionClass)
    if (items.length === 0 && !always) continue
    const lines = []
    for (const item of items) lines.push(...item.lines)
    if (lines.length === 0) {
      lines.push(protectionClass === PROTECTION_CLASSES.UNEXPOSED_RESULT && state.exposureDecidable === false
        ? '判定不可用：没有可判定的助手决策节点，无法判断是否存在未曝光结果（不等于「没有」）。'
        : '（无）')
    }
    // 依据与释放条件按类目各出现一次：保护项本身在 state.protectedSet 里逐条携带。
    lines.push(`依据/释放：${rule.reason}｜${rule.releaseCondition}`)
    sections.push(section(
      `■ ${PROTECTION_TITLES[protectionClass]}（hard/${protectionClass}）`,
      lines,
      { protectionClass, strength: PROTECTION_STRENGTH.HARD },
    ))
  }
  return sections
}

/**
 * 按 F1 重要度把软保留装成**每项一段**：装包顺序 = 分值降序（高分先装、
 * 等价于低分先丢），同分维持 DROP_ORDER 类目次序与项原次序（确定性兜底）。
 *
 * 打分在装包前完成（scoreSoftRetention，纯函数；分量见 importance.mjs 的
 * 权重与出处注释）。相关性的查询文本就是**硬前缀**——它天然包含「当前人类
 * 请求」与「最小工作状态」段，即「当前工作状态卡硬前缀 + 当前人类请求」的
 * 统一口径。`retrievalHits` 由调用方注入（当前 v2 无 per-record 回读记账，
 * 如实传空，见 importance.mjs 的诚实边界）。
 *
 * 每段的 `importanceText` 带分量描述：丢弃报告据此如实写
 * 「因重要度分值 X（分量…）被丢弃」，不给黑盒分。
 */
function softSectionsOf(state, { hardPrefixText = '', retrievalHits = null } = {}) {
  const retention = state?.retention ?? {}
  const context = {
    hardPrefixText: typeof hardPrefixText === 'string' ? hardPrefixText : '',
    currentRequestText: '',
    retrievalHits: retrievalHits && typeof retrievalHits === 'object' ? retrievalHits : {},
  }
  const scored = []
  for (const retentionClass of DROP_ORDER) {
    const items = Array.isArray(retention[retentionClass]) ? retention[retentionClass] : []
    for (const item of items) {
      const result = scoreSoftRetention({
        lines: item.lines,
        source: item.source,
        retentionClass,
        evidenceStatus: retentionClass === RETENTION_CLASSES.STALE_EVIDENCE
          ? EVIDENCE_STATUS.STALE
          : retentionClass === RETENTION_CLASSES.UNVERIFIED_EVIDENCE
            ? EVIDENCE_STATUS.UNVERIFIED
            : null,
        recordId: item.sourceRef,
      }, context)
      scored.push({
        score: result.score,
        importanceText: formatImportanceReason(result),
        section: section(
          `■ ${RETENTION_TITLES[retentionClass]}（soft/${retentionClass}）`,
          [...item.lines],
          {
            retentionClass,
            strength: PROTECTION_STRENGTH.SOFT,
            importance: result.score,
            importanceText: formatImportanceReason(result),
            // required 必须随段传下去：预算装包只看段上的 required，丢了它
            // 「否定/更正必选」就只是 retentionItem 里的一句注释。
            ...(item.required === true ? { required: true } : {}),
          },
        ),
      })
    }
  }
  // 稳定排序：先按 DROP_ORDER 生成（同分兜底序），再按分值降序——
  // Array#sort 在本模块支持的 Node 版本（>=22）里保证稳定。
  scored.sort((a, b) => b.score - a.score)
  return scored.map((entry) => entry.section)
}

/**
 * 有界渲染：硬保护段永远渲染，软保留按丢弃顺序从最先丢的开始装包，
 * 并如实报告丢了哪些类目、为什么。
 *
 * 预算语义（0 / 负数 / 非法值都有明确结果，不静默截断）：
 * - `budgetTokens <= 0`：只渲染硬保护，`overflow` 为 true（硬内容必然 > 0）；
 * - 负数：先夹到 0，并在 `budgetFloorApplied` 里说明；
 * - 非有限值：回落到 `WORKING_SET_DEFAULTS.cardTokens`，并在 `budgetInvalid` 里说明。
 *
 * 返回值里的 `usedTokens` / `budgetTokens` / `overflow` / `dropped` 永远是真实值，
 * 不因为「丢得多」而被吞掉（这是调用方判断是否扩窗的唯一依据）。
 */
export function renderWorkingStateCard(state, {
  budgetTokens = WORKING_SET_DEFAULTS.cardTokens,
  previousPrefixHash = null,
  /** F1：软保留打分的回读记账（`{ recordId: 次数 }`），调用方注入、只读。 */
  retrievalHits = null,
} = {}) {
  const input = state ?? {}
  // 「未提供」与「零」必须分开（0.13.2 D-12）：`Number(null)===0`、`Number('')===0`、
  // `Number([])===0`，于是 `null`/`''`/`[]` 被归一成预算 0 → hardOverflow=true、
  // 软保留一条不装、卡片尾部写「已超过预算 0 token」——把「没设预算」呈现成
  // 「预算严重不足」。同子系统的 budget.mjs 明确把 null 当「未提供 → 默认值」，
  // 两个预算入口必须同源。
  // 「提供了什么」只认数字与非空字符串：`[]`、`true`、`{}` 之类都不是预算声明，
  // `Number([]) === 0` 会把它们变成「预算 0」（同上一条缺陷）。
  const budgetProvided = typeof budgetTokens === 'number'
    || (typeof budgetTokens === 'string' && budgetTokens.trim() !== '')
  const rawBudget = budgetProvided ? Number(budgetTokens) : Number.NaN
  const budgetInvalid = !budgetProvided || !Number.isFinite(rawBudget)
  const budgetFloorApplied = budgetProvided && Number.isFinite(rawBudget) && rawBudget < 0
  const budget = budgetInvalid ? WORKING_SET_DEFAULTS.cardTokens : Math.max(0, Math.floor(rawBudget))

  const hardSections = hardSectionsOf(input)
  // P0-1：可回读小节排在最前（紧跟权威声明），因为它是「取回路径」的入口；
  // 最多 3 条、每条 ≤80 字符，超出的只报计数。
  const readbackSection = readbackSectionOf(input.readback)
  const hardText = [CARD_HEADER, CARD_AUTHORITY_LINE, renderSections([readbackSection, ...hardSections].filter(Boolean))]
    .filter((line) => line !== '').join('\n')
  // F1：先渲染硬前缀、再对软保留打分——相关性的查询文本就是硬前缀（含当前
  // 人类请求与最小工作状态段），分值决定装包顺序（低分先丢，见 softSectionsOf）。
  const softSections = softSectionsOf(input, { hardPrefixText: hardText, retrievalHits })
  // estimateTokensOf 收的是**文本**、返回 token；这里绝不传 byteLength，
  // 否则预算会按 4 倍口径失真（budget.mjs 的 4 字节≈1 token 只在内层用一次）。
  const hardTokens = estimateTokensOf(hardText)
  const prefix = {
    // chars / tokenEstimate 描述的是**真实渲染出来的硬前缀**，不是归一化后的文本。
    chars: hardText.length,
    // hash 仍是「逐字节硬前缀哈希」：它含每步都会变的 seq 引用，因此**不能**当去重键
    // 用（审计 P1-4）。要判「是不是同一张卡」请用下面的 dedupKey。
    hash: hashText(hardText),
    tokenEstimate: hardTokens,
    /**
     * 语义去重键：整卡（含软保留段）对 seq 引用归一化后取哈希。
     * 此处先占位，最终值在整卡文本装配完成后按 `text` 重算（见下）——
     * 只取硬前缀会让软保留区的进度更新被去重静默吞掉。
     */
    dedupKey: null,
    semanticVersion: CARD_SEMANTIC_VERSION,
  }
  const hardOverflow = hardTokens > budget

  const dropped = []
  const kept = []
  // 0.12.0 P1-6：软段头只留「怎么装包」一句话，不再重复整条类目次序——类目次序
  // 由 DROP_ORDER 常量定义，写进每张卡只是每步固定税。
  const softHeader = '■ 软保留（按重要度分值降序装包，低分先丢；类目兜底次序见全量卡）'

  const composeSoft = (sections) => {
    if (sections.length === 0) return ''
    return `${softHeader}\n${renderSections(sections)}`
  }

  const footerFor = (droppedItems) => {
    const lines = []
    if (droppedItems.length > 0) {
      const grouped = new Map()
      for (const item of droppedItems) {
        const key = item.class
        const entry = grouped.get(key) ?? { class: key, sections: 0, lines: 0, reasons: new Set() }
        entry.sections += 1
        entry.lines += item.lines
        // 戒律：丢弃报告如实带分量——「因重要度分值 X（分量…）被丢弃」，
        // 不给黑盒分；无分量（如 hard-overflow）时只写原因。
        entry.reasons.add(item.importanceText ? `${item.reason}｜${item.importanceText}` : item.reason)
        grouped.set(key, entry)
      }
      // 0.12.0 P1-6：只报**类别 × 段/行数**，不再逐条列「因重要度分值 X（分量…）」。
      // 逐条打分算式是每步固定税里最贵的一段，而它对「要不要回读」没有决策价值；
      // 算式仍可在 /memory-lab status --verbose 里查（见 renderCardDetail）。
      const described = [...grouped.values()]
        .map((entry) => `${entry.class}×${entry.sections}段/${entry.lines}行`)
        .join('；')
      lines.push(`因预算丢弃（按重要度分值升序）：${described}。丢弃不等于不存在，可按记录 ID 回读。`)
    }
    if (hardOverflow) {
      lines.push(`⚠ 硬保护内容 ≈${hardTokens} token 已超过预算 ${budget} token（缺口 ≈${hardTokens - budget}）：`
        + '不从保护集丢弃，请扩窗或压缩原文。')
    }
    return lines
  }

  let text = ''
  let usedTokens = hardTokens

  if (hardOverflow) {
    // 硬保护已经超预算：软保留一条都不装，但必须报告「哪些软类目因此没进卡」。
    for (const item of softSections) {
      dropped.push({
        class: item.retentionClass,
        title: item.title,
        lines: item.lines.length,
        reason: 'hard-overflow',
        classReason: RETENTION_RULES[item.retentionClass]?.reason ?? null,
        importance: item.importance ?? null,
        importanceText: item.importanceText ?? null,
        reReadable: true,
        readbackHint: '按记录 ID 回读',
      })
    }
    const footer = footerFor(dropped).join('\n')
    text = footer === '' ? hardText : `${hardText}\n\n${footer}`
    usedTokens = estimateTokensOf(text)
  } else {
    for (const item of softSections) {
      // required 段（否定/更正可见）**必选**：预算不够也留下，并在页脚如实报超支。
      // 旧实现把它当普通软条目按分值丢弃，826 行「预算覆盖选择时必选」从不生效。
      if (item.required === true) {
        kept.push(item)
        continue
      }
      const candidate = composeSoft([...kept, item])
      const tokens = estimateTokensOf(`${hardText}\n\n${candidate}`)
      if (tokens > budget) {
        dropped.push({
          class: item.retentionClass,
          title: item.title,
          lines: item.lines.length,
          reason: 'budget',
          classReason: RETENTION_RULES[item.retentionClass]?.reason ?? null,
          importance: item.importance ?? null,
          importanceText: item.importanceText ?? null,
          reReadable: true,
          readbackHint: '按记录 ID 回读',
        })
        continue
      }
      kept.push(item)
    }

    // 报告页脚本身也占预算：装上页脚后若超了，从最低优先级的已保留段开始退，直到装得下。
    for (;;) {
      const body = composeSoft(kept)
      const footer = footerFor(dropped).join('\n')
      const parts = [hardText]
      if (body !== '') parts.push(body)
      if (footer !== '') parts.push(footer)
      text = parts.join('\n\n')
      usedTokens = estimateTokensOf(text)
      if (usedTokens <= budget || kept.length === 0) break
      // 退让只能退**非必选**段：required（否定/更正）是「宁可超预算也要可见」的
      // 内容，被这条退让链从尾部弹掉就等于必选从未生效。全是必选时停手，
      // 超支如实体现在 usedTokens > budget 与 overflow 上。
      let index = kept.length - 1
      while (index >= 0 && kept[index].required === true) index -= 1
      if (index < 0) break
      const [removed] = kept.splice(index, 1)
      dropped.push({
        class: removed.retentionClass,
        title: removed.title,
        lines: removed.lines.length,
        reason: 'budget',
        classReason: RETENTION_RULES[removed.retentionClass]?.reason ?? null,
        importance: removed.importance ?? null,
        importanceText: removed.importanceText ?? null,
        reReadable: true,
        readbackHint: '按记录 ID 回读',
      })
    }
  }

  // 整卡文本装配完成后按最终 `text` 取语义键（整卡口径，含软保留段）：
  // 软保留区的进度行每步都在真实变化，键必须跟着变，否则进度更新被去重吞掉。
  prefix.dedupKey = workingSetDedupKeyOf(text)

  // 丢弃报告按真实丢弃时序排：分值升序（低分先丢），同分维持类目次序。
  dropped.sort((a, b) => {
    const left = a.importance ?? 0
    const right = b.importance ?? 0
    if (left !== right) return left - right
    return DROP_ORDER.indexOf(a.class) - DROP_ORDER.indexOf(b.class)
  })
  const droppedClasses = []
  for (const item of dropped) {
    const entry = droppedClasses.find((candidate) => candidate.class === item.class)
    if (entry) {
      entry.sections += 1
      entry.lines += item.lines
    } else {
      droppedClasses.push({ class: item.class, sections: 1, lines: item.lines, reason: item.reason, classReason: item.classReason })
    }
  }
  const keptClasses = [...new Set(kept.map((item) => item.retentionClass))]

  const openActions = Array.isArray(input.openActions) ? input.openActions : []
  const overflow = usedTokens > budget
  const overflowReason = !overflow
    ? null
    : hardOverflow
      ? `硬保护内容 ≈${hardTokens} token 超过预算 ${budget} token（缺口 ≈${hardTokens - budget}）；按规范不从保护集里丢弃，请扩窗或压缩。`
      : `软保留已全部丢弃，硬保护内容 ≈${hardTokens} token 加上必报的丢弃说明仍超过预算 ${budget} token：没有更多可丢的东西了，请扩窗。`
  return {
    text,
    header: CARD_HEADER,
    /** 0.12.0 P0-1：本步可回读候选（已进硬前缀；随状态一并返回，便于调用方对账）。 */
    readback: Array.isArray(input.readback) ? [...input.readback] : [],
    budgetTokens: budget,
    usedTokens,
    hardTokens,
    softTokens: Math.max(0, usedTokens - hardTokens),
    /** overflow：整张卡（含必报的丢弃说明）放不进预算——调用方据此决定是否扩窗。 */
    overflow,
    overflowReason,
    /** hardOverflow：硬保护内容本身就超预算（此时软保留一条都没装）。 */
    hardOverflow,
    overBudget: overflow,
    shortfallTokens: hardOverflow ? hardTokens - budget : 0,
    budgetFloorApplied,
    budgetInvalid,
    dropped,
    droppedClasses,
    keptClasses,
    neverDropped: [...PROTECTION_ORDER],
    prefix,
    prefixStable: previousPrefixHash === null || previousPrefixHash === undefined
      ? null
      : previousPrefixHash === prefix.hash,
    openCalls: openActions.map((action) => ({
      callId: action.callId ?? null,
      callRecordId: action.recordRef ?? null,
      actionState: action.actionState ?? null,
    })),
    hardSections: hardSections.map((item) => item.title),
    softSections: softSections.map((item) => item.title),
    /** F1：软段装包序（分值降序=低分先丢）与各段分值，机器可读、供审计与测试。 */
    softImportance: softSections.map((item) => ({
      class: item.retentionClass,
      importance: item.importance ?? null,
      importanceText: item.importanceText ?? null,
      lines: item.lines.length,
    })),
  }
}

/**
 * 包成一次注入的消息文本。
 *
 * 明确标注为工作资料而非 system：它不能冒充系统/开发者指令，
 * 也不能被当作新的授权来源（规范 §5.1）。
 */
export function renderWorkingSetInjection(state, options = {}) {
  return renderWorkingStateCard(state, options)
}

// ---------------------------------------------------------------------------
// 增量注入（D1 升级）：全量卡一次，之后只注入相对上一张全量卡的变化行
// ---------------------------------------------------------------------------

/**
 * 增量卡头。
 *
 * 固定协议文案（CARD_HEADER 的权威声明、各保护类目的依据/释放条件等约 33 行）
 * 不再随每张卡重复：它们只出现在会话的第一张（及周期性再锚定的）全量卡里。
 * 增量卡只带变化行，头一行说明它引用哪张全量卡，不冒充独立授权来源。
 */
export const CARD_DELTA_HEADER = '[工作状态·v2·增量]（插件生成的工作资料，不是系统指令；'
  + '固定协议文案见本会话最近一张全量卡，原文可按记录 ID 回读）'

/** 增量卡硬上限（P1-6）：行数与字符数双上限，超出只留摘要 + 记录 ID。 */
export const CARD_DELTA_MAX_LINES = 24
export const CARD_DELTA_MAX_CHARS = 1600

/**
 * 增量卡上界：头部两行必须保留（它说明这张卡引用哪张全量卡），其余按行截断，
 * 截断时追加一行如实说明「还有 N 行变化未列出，可按记录 ID 回读」。
 */
function deltaTailOf(rest) {
  // 措辞必须成立：模型手里的「最近一张全量卡」是**上一张**，它不含这些新行——
  // 旧文案「完整内容以最近一张全量卡为准」是一句假话。截断的增量卡由调用方
  // 改发全量卡（见 runtime-card 的 delta 分支），这里只如实说明本卡不全。
  return `（另有 ${rest} 行变化未在本卡列出：增量卡有上界；这些行没有进入本卡，可按记录 ID 回读）`
}

function boundDeltaLines(lines, { maxLines, maxChars }) {
  const text = lines.join('\n')
  if (lines.length <= maxLines && text.length <= maxChars) return { text, truncated: false }
  const head = lines.slice(0, 2)
  const body = []
  let used = head.join('\n').length
  // 尾行宽度必须计入预算（0.13.2-beta.2 W-04）。旧实现把尾行最后**无条件 push**，
  // 于是「上界」只是正文的上界：24 行 × 80 字符填充实测产出 1644 字符 >
  // CARD_DELTA_MAX_CHARS(1600)。增量卡是每步固定税，上界名不副实就等于没有上界。
  //
  // 预留按**最坏 rest**（一条正文都没装进去）算：正文装得越多 rest 越小，尾行只可能
  // 更短，所以「预留 + 实际尾行」不会超。这个「≤」不是估计，是构造出来的。
  const reserved = deltaTailOf(lines.length - head.length).length + 1
  for (const line of lines.slice(2)) {
    const next = used + 1 + line.length
    // 行数预算 = 头部 2 行 + 正文 + 尾行 1 行；越界即停（尾行必须留得出位置）。
    if (body.length + 3 >= maxLines || next > maxChars - reserved) break
    body.push(line)
    used = next
  }
  // 兜底：头部两行本身异常宽时，逐行回退到装得下为止。正常情况下不会触发。
  // 唯一例外是 head + tail 单独就超 maxChars（配置荒谬），此时如实返回并保留
  // truncated=true，不假装装下了。
  while (body.length > 0
    && [...head, ...body, deltaTailOf(lines.length - head.length - body.length)].join('\n').length > maxChars) {
    body.pop()
  }
  const rest = lines.length - head.length - body.length
  return { text: [...head, ...body, deltaTailOf(rest)].join('\n'), truncated: true }
}

const CARD_DELTA_CHANGE_TITLE = '■ 相对上一张全量卡的变化（只列变化行；未列出的行以最近一张全量卡为准）'
const CARD_DELTA_REMOVED_PREFIX = '- 已不再列出 '

/**
 * 每注入多少张卡后回注一次全量卡（再锚定）。
 *
 * 增量卡假设模型仍记得最近一张全量卡的框架；周期性全量卡让这个假设不必无限期
 * 成立。20 ≈ 一个长任务段：按 c896f803 的形态（几乎每步注入一张）约每 20 步付
 * 一次全量开销，其余步只付变化行的钱（实测全量卡 ≈1.8k token，增量卡 ≈百级）。
 */
export const WORKING_SET_FULL_REFRESH_EVERY = 20

/**
 * 注入形态裁决：这一步该注入全量卡还是增量卡。
 *
 * - 没有上一张全量卡（会话首次注入、或进程重启后内存态丢失）：全量。重启丢的
 *   只是「上卡文本」这份内存态，回落全量是**诚实降级**——宁可多付一次全量的钱，
 *   也不注入一张引用了模型从未见过的全量卡的增量卡。
 * - 注入计数到达 `fullEvery` 的整数倍：全量（再锚定）。
 * - 其余：增量。
 *
 * `injectionCount` 是**本会话已注入过的卡片总数**（全量 + 增量都算），
 * 由调用方随注入成功递增；拿不到就按 0 处理（回到全量，不猜）。
 */
export function shouldInjectFullWorkingStateCard({
  previousText = null,
  injectionCount = 0,
  fullEvery = WORKING_SET_FULL_REFRESH_EVERY,
} = {}) {
  const previous = typeof previousText === 'string' && previousText !== '' ? previousText : null
  if (previous === null) return true
  const count = Number.isFinite(Number(injectionCount)) ? Math.max(0, Math.floor(Number(injectionCount))) : 0
  const every = Number.isFinite(Number(fullEvery)) && Number(fullEvery) >= 1
    ? Math.floor(Number(fullEvery))
    : WORKING_SET_FULL_REFRESH_EVERY
  return count % every === 0
}

function lineCountsOf(text) {
  const counts = new Map()
  for (const line of String(text ?? '').split('\n')) counts.set(line, (counts.get(line) ?? 0) + 1)
  return counts
}

/**
 * 行级多集差异：上一张全量卡 → 本步全量卡。
 *
 * 用**多集**计数而不是集合：同一行文本在卡里可能出现多次（并行工具调用共享
 * 同一宿主 seq 时，进度行可以同形不同次），按集合算会把真实的重复行当成
 * 「没变」。判定规则：
 *
 * - 新增行：next 里某行的出现次数超过 previous 里的次数，多出的每次出现各记一行；
 * - 消失行：previous 里某行的次数超过 next，差额只**计数**不逐行复述——
 *   上一张卡还留在上下文里，模型看得到旧行，只需要知道它已不再有效。
 *
 * 两边都是空、或没有任何差异时返回 null（调用方跳过本次注入）。
 * 输入不是字符串时同样返回 null：拿不到可靠的上一张卡就不发增量卡。
 */
export function workingStateCardDelta({ previousText, nextText } = {}) {
  const previous = typeof previousText === 'string' ? previousText : ''
  const next = typeof nextText === 'string' ? nextText : ''
  if (previous === '' || next === '') return null
  const prevCounts = lineCountsOf(previous)
  const nextLines = next.split('\n')
  const running = new Map()
  const addedTotalOfLine = new Map()
  let addedTotal = 0
  for (const line of nextLines) {
    const seen = (running.get(line) ?? 0) + 1
    running.set(line, seen)
    const extra = Math.max(0, seen - (prevCounts.get(line) ?? 0))
    if (extra > 0) {
      addedTotalOfLine.set(line, extra)
      addedTotal += 1
    }
  }
  let removedCount = 0
  for (const [line, count] of prevCounts) {
    removedCount += Math.max(0, count - (running.get(line) ?? 0))
  }
  if (addedTotal === 0 && removedCount === 0) return null
  // 组段：每个新增行都带上它在全量卡里所属的段标题（最近的前导 `■ ` 行），
  // **即使标题本身没有变化**——增量行脱离段上下文就读不出「这是哪类信息」。
  // 同一段标题只带一次；全量卡头部（CARD_HEADER/权威声明）不是段标题，不产生标题。
  // 0.12.0 P1-6：增量卡硬上限（行数 + 字节）。超出只留「变化摘要 + 记录 ID」，
  // 不再无限追加变化行——增量卡是每步固定税，没有上界就等于没有降噪。
  const out = [CARD_DELTA_HEADER, CARD_DELTA_CHANGE_TITLE]
  const emittedTitle = new Set()
  const emittedOfLine = new Map()
  for (const [index, line] of nextLines.entries()) {
    const extra = addedTotalOfLine.get(line) ?? 0
    if (extra === 0) continue
    const alreadyEmitted = emittedOfLine.get(line) ?? 0
    if (alreadyEmitted >= extra) continue
    let title = null
    for (let back = index - 1; back >= 0; back -= 1) {
      if (nextLines[back].startsWith('■ ')) { title = nextLines[back]; break }
    }
    if (title !== null && !emittedTitle.has(title)) {
      out.push(title)
      emittedTitle.add(title)
    }
    out.push(line)
    emittedOfLine.set(line, alreadyEmitted + 1)
  }
  if (removedCount > 0) {
    out.push(`${CARD_DELTA_REMOVED_PREFIX}${removedCount} 行（上一张全量卡有、本步无；丢弃不等于不存在，可按记录 ID 回读）`)
  }
  const bounded = boundDeltaLines(out, { maxLines: CARD_DELTA_MAX_LINES, maxChars: CARD_DELTA_MAX_CHARS })
  return { text: bounded.text, addedLines: addedTotal, removedLines: removedCount, truncated: bounded.truncated }
}
