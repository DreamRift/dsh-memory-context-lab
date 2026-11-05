/**
 * 片段身份与去重键（domain/visibility，G6b）。
 *
 * ## 身份语义（复用，不新建）
 * - `kind`：`record`（记录）/ `summary`（摘要工件）——与 G2 引用区同一套 ID；
 * - `version`：**正文版本**。记录正文（脱敏后的本地副本）的 FNV-1a 64 指纹，
 *   前缀 `vtext-` 标明哈希族。它**不是** G2 的 `source_hash`（记录字节材料的
 *   sha256）：两者族不同、不可比、也不得互相顶替（R-4：缓存键统一 FNV-1a 64，
 *   需要跨进程稳定标识时另行显式声明）。
 * - `span`：码点半开区间 `[start, end)`（C-G1-09），对**本地脱敏正文**偏移；
 *   `null` = 整段。
 *
 * ## 去重键（R-4）
 * `dedupeKey = FNV-1a64(canonical([keyVersion, sessionKey, kind, id, version, span]))`，
 * 16 位小写十六进制。材料里**同时**带会话与正文版本：跨会话不共享、正文一变就是
 * 另一个片段（旧可见性不继承）。
 *
 * ## 可见代际为什么不进键
 * 代际（`visibilityDigest`）是**判定时**的事实：进键会让跨 epoch 的重复计数失效
 * （R-11 要求同一个键在代际变化时重置计数，而不是换一个新键重来）。所以键稳定、
 * 代际随判定回执走（`visibilityDigest` 字段）。
 */
import { VISIBILITY_DEDUPE_KEY_VERSION } from '../../contracts/visibility.mjs'
import { V3ContractViolation } from '../../contracts/errors.mjs'
import { fnv1a64Of } from '../../shared/fnv1a64.mjs'

/** 片段种类封闭集（新增须有生产方与消费者）。 */
export const FRAGMENT_KINDS = Object.freeze(['record', 'summary'])

/** 正文版本哈希族前缀（禁止把 16 位裸 hex 当无族标识使用）。 */
export const FRAGMENT_VERSION_PREFIX = 'vtext-'

/**
 * 归一 span：必须是 `{unit:'code-point', start, end}` 的半开区间，或 null。
 * 非法 span 抛违规（不静默截断——错偏移会让去重静默跳过错的片段）。
 */
export function normalizeFragmentSpan(span) {
  if (span === null || span === undefined) return null
  if (typeof span !== 'object' || Array.isArray(span)) {
    throw new V3ContractViolation('v3 visibility: span 必须是对象或 null')
  }
  const { unit, start, end } = span
  if (unit !== 'code-point') {
    throw new V3ContractViolation('v3 visibility: span.unit 必须是 code-point（得到 ' + JSON.stringify(unit) + '）')
  }
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) {
    throw new V3ContractViolation('v3 visibility: span 必须是 0 ≤ start ≤ end 的整数区间')
  }
  return { unit: 'code-point', start, end }
}

/** 正文版本：FNV-1a 64（带族前缀）。文本只能是字符串（调用方负责已脱敏）。 */
export function fragmentVersionOf(text) {
  if (typeof text !== 'string') {
    throw new V3ContractViolation('v3 visibility: 正文版本需要字符串正文（得到 ' + typeof text + '）')
  }
  return FRAGMENT_VERSION_PREFIX + fnv1a64Of('visibility-text-v1:' + text)
}

/**
 * 构造一个记录片段（唯一构造点）。`span` 缺省 = 整段。
 * @returns {{kind:'record', id:string, version:string, span:object|null}}
 */
export function recordFragmentOf({ id, text, span = null } = {}) {
  if (typeof id !== 'string' || id.length === 0) {
    throw new V3ContractViolation('v3 visibility: 片段 id 必须是非空字符串')
  }
  return { kind: 'record', id, version: fragmentVersionOf(text), span: normalizeFragmentSpan(span) }
}

/** 校验片段形状（判定入口用；确保 kind/id/version 都有确定值）。 */
export function normalizeFragment(fragment) {
  if (fragment === null || typeof fragment !== 'object' || Array.isArray(fragment)) {
    throw new V3ContractViolation('v3 visibility: 片段必须是对象')
  }
  if (!FRAGMENT_KINDS.includes(fragment.kind)) {
    throw new V3ContractViolation('v3 visibility: 片段 kind 不在封闭集：' + JSON.stringify(fragment.kind))
  }
  if (typeof fragment.id !== 'string' || fragment.id.length === 0) {
    throw new V3ContractViolation('v3 visibility: 片段 id 必须是非空字符串')
  }
  if (typeof fragment.version !== 'string' || fragment.version.length === 0) {
    throw new V3ContractViolation('v3 visibility: 片段 version 必须是非空字符串（正文版本不得缺省）')
  }
  return {
    kind: fragment.kind,
    id: fragment.id,
    version: fragment.version,
    span: normalizeFragmentSpan(fragment.span ?? null),
  }
}

/**
 * 去重键：16 位小写十六进制。
 * 材料顺序固定（JSON.stringify 数组），不得依赖对象键序。
 */
export function dedupeKeyOf(sessionKey, fragment) {
  if (typeof sessionKey !== 'string' || sessionKey.length === 0) {
    throw new V3ContractViolation('v3 visibility: 去重键需要非空 sessionKey（跨会话不共享键）')
  }
  const shape = normalizeFragment(fragment)
  const material = JSON.stringify([
    VISIBILITY_DEDUPE_KEY_VERSION,
    sessionKey,
    shape.kind,
    shape.id,
    shape.version,
    shape.span,
  ])
  return fnv1a64Of(material)
}
