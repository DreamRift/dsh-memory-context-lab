/**
 * G3 usage 逐 provider 归一化合同（0.15.0，归一合同 v1）——**纯数据 + 纯函数，零外部依赖**。
 *
 * ## 只回答两个问题，且只在有出处时回答
 * 开发流程 §9.5 要求的核对项是**两个语义问题**，不是三个指标：
 * 1. `inputTokens` 是否**已包含** cacheRead / cacheWrite？（决定这几项能不能相加）
 * 2. `reasoningTokens` 是否**已包含在** output 里？（决定它是不是额外 token）
 * 两个问题**都以 provider 为单位**给出 `true/false/null`：
 * `null = 本版本未核验`。null **不是** false，也**不许**在汇总时按 false 处理
 * （否则会把"不知道"算成"独立字段"，凭空造出 token 总额）。
 *
 * ## 出处
 * - P0 宿主合同 §2.4（DSH 0.2.1-rc.5 源码结论）：
 *   DeepSeek wire 有 `cache_read_input_tokens` / `cache_creation_input_tokens`，且该路线的
 *   `totalTokens` **由适配器算**（= input + cacheRead + cacheWrite + output，见观测合同的
 *   算术等式）——这说明 input 与两个 cache 字段是**分开报的、可相加**；
 *   pi-ai 的 cache 字段**只在 >0 时出现**，`totalTokens` 由上游给，且 reasoning 已折进 output。
 * - 未做真实调用（本机未发请求）：真实 provider 是否始终按源码给字段仍 **unknown**，
 *   因此 profile 的 `verified` 字段如实写 `source-read`（源码核对）而非 `live`。
 *
 * ## 不适用条件
 * - 不估价格/金额/TTL：价格只进 G8 外部结算表，本轮不产"真实费用"；
 * - 不判定供应商计费桶互斥（那是计费语义，不是算术）；
 * - 不做缺失补 0：缺失一律 null + availability（三态在观测合同里）。
 */
import { deepFreeze } from '../shared/deep-freeze.mjs'

/** 归一合同版本（profile 内容/字段有变动才动它）。 */
export const USAGE_NORMALIZATION_VERSION = 1

/**
 * 未知 provider 的默认 profile：**三个判定全部 null**（未核验），任何汇总都不得默认 true/false。
 * 这是失败关闭的最小形态，不是"中性值"。
 */
const UNKNOWN_PROFILE = Object.freeze({
  provider: null,
  known: false,
  inputIncludesCacheRead: null,
  inputIncludesCacheWrite: null,
  cacheFieldsAddable: null,
  reasoningIncludedInOutput: null,
  verified: 'unknown',
  evidence: '未登记的 provider：三项语义均未核验（不得按 0/false 处理）',
})

/**
 * 逐 provider 归一化声明（**唯一真源**；汇总方不得在别处再写一份判定）。
 *
 * 字段语义：
 * - `inputIncludesCacheRead/Write`：`inputTokens` 是否已把这些 cache token 算在里面；
 * - `cacheFieldsAddable`：cache 字段能否与 input/output **相加**得出总额（只表示可加性，
 *   不表示计费桶互斥）；
 * - `reasoningIncludedInOutput`：reasoning token 是否已包含在 output 里（true = 不是额外 token）；
 * - `verified`：`source-read` = 读宿主源码核对；`live` = 真实调用核对（本版本没有）。
 */
export const PROVIDER_USAGE_PROFILES = deepFreeze({
  deepseek: {
    provider: 'deepseek',
    known: true,
    inputIncludesCacheRead: false,
    inputIncludesCacheWrite: false,
    cacheFieldsAddable: true,
    reasoningIncludedInOutput: null,
    verified: 'source-read',
    evidence: 'P0 §2.4：wire 分报 cache_read_input_tokens / cache_creation_input_tokens；totalTokens 由适配器按 in+read+write+out 计算',
  },
  'pi-ai': {
    provider: 'pi-ai',
    known: true,
    inputIncludesCacheRead: false,
    inputIncludesCacheWrite: false,
    cacheFieldsAddable: null,
    reasoningIncludedInOutput: true,
    verified: 'source-read',
    evidence: 'P0 §2.4：cache 字段仅 >0 才出现；totalTokens 由上游给（可加性未核验）；reasoning 已折进 output',
  },
})

/** provider 名的匹配口径：宿主 `ModelMessageSource.provider` 原样（大小写敏感），未登记 → 未知 profile。 */
export function usageProfileOf(provider) {
  const key = typeof provider === 'string' ? provider : null
  const profile = key !== null && Object.prototype.hasOwnProperty.call(PROVIDER_USAGE_PROFILES, key)
    ? PROVIDER_USAGE_PROFILES[key]
    : UNKNOWN_PROFILE
  return deepFreeze({ ...profile, normalizationVersion: USAGE_NORMALIZATION_VERSION })
}

/** 读归一 usage 里某字段的值（非 present 一律 null；与观测合同同一口径）。 */
function valueOf(usage, field) {
  const cell = usage?.[field]
  return cell?.availability === 'present' && typeof cell.value === 'number' && Number.isFinite(cell.value) && cell.value >= 0
    ? cell.value
    : null
}

/**
 * 可加性判定（**只报「能不能加」，不报语义**）。
 *
 * - profile 说 cache 字段可加（`true`）→ `cacheFieldsAddable: true`，并给出
 *   `billedAxisSum`（input + cacheRead + cacheWrite + output）**仅当四项都 present**；
 *   缺任一项 → `billedAxisSum: null`（缺失不是 0）。
 * - profile 为 `null/false` → `cacheFieldsAddable: null/false`，`billedAxisSum: null`
 *   ——不知道就不给一个看起来像总额的数。
 * - `reasoningExtraTokens`：只有 profile 明确 `reasoningIncludedInOutput === false`
 *   且 reasoning present 时才等于 reasoning 值；`true` 表示"已含在 output 里"⇒ extra 为 0；
 *   未知 ⇒ null（不是 0！）。
 *
 * @param {object} usage `normalizeUsageObservation(...).usage`
 * @param {string|null} [provider] 宿主 source.provider
 */
export function additivityOf(usage, provider = null) {
  const profile = usageProfileOf(provider)
  const input = valueOf(usage, 'inputTokens')
  const read = valueOf(usage, 'cacheReadTokens')
  const write = valueOf(usage, 'cacheWriteTokens')
  const output = valueOf(usage, 'outputTokens')
  const reasoning = valueOf(usage, 'reasoningTokens')
  const addable = profile.cacheFieldsAddable
  const allPresent = input !== null && read !== null && write !== null && output !== null
  const billedAxisSum = addable === true && allPresent ? input + read + write + output : null
  let reasoningExtraTokens = null
  if (profile.reasoningIncludedInOutput === true) reasoningExtraTokens = 0
  else if (profile.reasoningIncludedInOutput === false) reasoningExtraTokens = reasoning
  return deepFreeze({
    provider: profile.provider,
    known: profile.known,
    normalizationVersion: USAGE_NORMALIZATION_VERSION,
    cacheFieldsAddable: addable === null || addable === undefined ? null : addable === true,
    billedAxisSum,
    inputIncludesCacheRead: profile.inputIncludesCacheRead,
    inputIncludesCacheWrite: profile.inputIncludesCacheWrite,
    reasoningIncludedInOutput: profile.reasoningIncludedInOutput,
    reasoningExtraTokens,
    verified: profile.verified,
    reason: profile.known
      ? (addable === true
        ? 'profile 声明 input 与 cache 分报、可相加（源码核对，未做真实调用）'
        : 'profile 未核验可加性：不给总额数字')
      : '未登记 provider：可加性与 reasoning 归属均未知（不给结论）',
  })
}
