/**
 * 工作状态卡 / 工作集一次装包的 token 上限。
 *
 * 有界是硬要求：没有上限时调用方一个巨大数字就能把卡撑成全文，
 * 「有界热上下文」这条不变量当场失效。
 */
export const WORKING_SET_MAX_BUDGET_TOKENS = 16_000

/** 只读召回（命令面与模型可见工具共用）的默认/上限 token 预算。 */
export const RECALL_DEFAULT_BUDGET_TOKENS = 6000
export const RECALL_MAX_BUDGET_TOKENS = 32_000

/** 字面检索一次最多返回多少条索引命中（正文仍要按 ID 单独回读）。 */
export const RECALL_MAX_QUERY_HITS = 20

/**
 * v2 估算工具。
 *
 * 只做「字节 → token 估算」，不引入模型、不做分词。之所以单独成模块：
 * 预算装包（working-state）与回读装包（readback）必须用同一把尺子，
 * 否则两处预算不可比。
 */

/**
 * 粗估口径：4 字节 ≈ 1 token，向上取整后至少 1。
 *
 * 注意与 v1 的差别：v1 用 `String(text).length / 4`（**字符**口径），中文场景下
 * 同一段文本 v1 估 1、这里估 3。两者不可直接比较，跨版本对账时要标明用的是哪把尺子。
 */
export const BYTES_PER_TOKEN = 4

export function estimateTokensOf(text) {
  const bytes = Buffer.byteLength(String(text ?? ''), 'utf8')
  return Math.max(1, Math.ceil(bytes / BYTES_PER_TOKEN))
}

/**
 * 已经是**字节数**时用这个，别再喂给 `estimateTokensOf`。
 *
 * 两者分开是有原因的：`estimateTokensOf` 内部会自己做一次 `Buffer.byteLength`，
 * 把字节数当文本传进去会被再编码一次（纯 ASCII 数字串长度不变，于是看起来
 * 「能用」，实际口径完全不同）——那会让 12 000 字节的载荷被记成 ≈2 token。
 */
export function estimateTokensOfBytes(bytes) {
  const value = Number(bytes)
  if (!Number.isFinite(value) || value <= 0) return 0
  return Math.ceil(value / BYTES_PER_TOKEN)
}

/** 召回预算口径：默认值与硬上限（超过上限按上限执行并如实告知）。 */
export const RECALL_BUDGET = Object.freeze({ defaultTokens: 6000, maxTokens: 32_000 })

/**
 * 校验调用方给的 `budget_tokens`。
 *
 * 以前这里是「不是正整数就静默回落默认值」——那等于把 `0`、`-1`、`12.5`、
 * `"6000"`、`NaN` 全都当成「没说」。用户以为预算生效了，实际拿的是默认值，
 * 而且没有任何提示。现在区分三种结果：
 * - 未提供（undefined/null）→ 用默认值，`source: 'default'`；
 * - 提供了但不是正整数 → 显式报错，调用方必须回一条错误，不能偷偷换值；
 * - 提供了且超过上限 → 同样显式报错（规范 §6.1 把「超限」与负数、类型错误并列，
 *   要求返回结构化错误）。夹到上限虽然「不放大」，但它会让调用方以为自己的预算
 *   生效了——报错并告知上限，调用方才可能给出一个真的会被执行的预算。
 */
export function parseBudgetTokens(raw, { fallback = RECALL_BUDGET.defaultTokens, max = RECALL_BUDGET.maxTokens, label = 'budget_tokens' } = {}) {
  if (raw === undefined || raw === null) {
    return { ok: true, value: fallback, source: 'default', clamped: false }
  }
  if (typeof raw !== 'number' || !Number.isFinite(raw) || !Number.isInteger(raw) || raw <= 0) {
    return {
      ok: false,
      error: `${label} 必须是正整数（收到 ${JSON.stringify(raw)}）；0/负数/小数/字符串/NaN 都不接受，请给 1..${max} 之间的整数，或省略以使用默认 ${fallback}`,
    }
  }
  if (raw > max) {
    return {
      ok: false,
      error: `${label}=${raw} 超过上限 ${max}；请改到 1..${max} 之间，或省略以使用默认 ${fallback}（本次未执行，也不会替你改成上限）`,
    }
  }
  return { ok: true, value: raw, source: 'requested', clamped: false }
}
