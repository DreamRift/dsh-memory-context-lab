/**
 * 归档回执（domain/archive，纯函数，M2）。
 *
 * 回执是模型在活动面看到的唯一替代物：不含原文、不含 reasoning、不含绝对路径；
 * 只给数量、序号区间、少量记录 ID 和恢复/检索入口。硬上界 400 字符，避免回执本身
 * 变成新的上下文税。
 *
 * 0.15.0 P4（三层摘要）：摘要行只占**剩余预算**——基础身份（数量/序号区间/记录 ID/
 * 恢复入口）先占位，剩余不够就整条摘要不写，绝不让摘要把「哪些记录、怎么恢复」
 * 挤出回执（验收：回执基础身份不会被截断挤掉）。
 *
 * 0.15.0 P5（摘要不得破坏归档）：摘要预算还要受**原文长度**约束——
 * available = sourceChars - 基础回执字数 - 安全余量。小步骤（原文约 200 字）的
 * 基础身份已接近原文，固定 220 字摘要会让回执 ≥ 原文 → 永远 not-worth、按步攒批失效。
 * 预算 < 40 字时整条省略摘要（保留基础身份与恢复入口），归档仍按正净收益判定；
 * 预算够时按实际可用长度裁剪（保留「摘要：」行，超出以省略号标示）。净收益判据
 * 仍用完整回执字数（含摘要）与原文比较，不剔除摘要计费。
 */
import { V3ContractViolation } from '../../contracts/errors.mjs'
import { clampSummaryTextByUnits } from '../compress/summary-artifact.mjs'

/**
 * 回执**总长**硬上界，单位 = **UTF-16 码元**（`String#length`）。
 *
 * P3-03（0.15.1 §3.3）：净收益判据 `receiptText.length < sourceChars` 两端都是码元，
 * 预算却按码点算——星平面字符（emoji 等）每个码点占 2 个码元，预算 N 码点可能产出
 * 2N 码元的摘要，回执被推过原文。现在**预算、裁剪、总长判定、净收益比较全部用码元**，
 * 只有一个单位，不存在混用。BMP 文本下与码点完全等价（无行为变化）。
 */
export const RECEIPT_MAX_CHARS = 400

/** 摘要行前缀（预算计算与渲染共用，避免两处各写一遍）。 */
const RECEIPT_SUMMARY_PREFIX = '摘要：'

/**
 * 摘要行至少要有这么多字符的正文才值得写（否则只剩「摘要：…」，不如不写）。
 * P5：预算不足 40 字时整条省略——小步骤宁可没有摘要，也不能拿摘要挤掉归档。
 */
export const RECEIPT_MIN_SUMMARY_CHARS = 40

/**
 * 摘要预算的安全余量：保证「基础身份 + 换行 + 前缀 + 摘要」严格小于原文，
 * 给净收益判据留出余量（判据本身仍是回执总字数 < 原文，不剔除摘要）。
 * 换行 + 「摘要：」占 4 个码点，余量 12 留出 8 个码点的缓冲。
 */
export const RECEIPT_SUMMARY_SAFETY_MARGIN = 12

function sampleIds(recordIds, limit) {
  const ids = recordIds.filter((id) => typeof id === 'string' && id.length > 0)
  if (limit === undefined) return ids.length <= 3 ? ids : ids.slice(0, 3)
  return ids.slice(0, limit)
}

/**
 * 基础身份行（摘要之外的全部内容）。
 * @param {object} input
 * @param {number} input.sampleCount 记录 ID 抽样条数（预算不足时降到 1）
 * @returns {string[]}
 */
function baseLines({ startSeq, endSeq, recordIds, operations, unitLabel, sampleCount }) {
  const ids = sampleIds(recordIds, sampleCount)
  const count = recordIds.length
  const lines = [
    '[记忆上下文] 已把 ' + count + ' 条已完成历史（seq ' + startSeq + '–' + endSeq + '）归档为可恢复回执。',
  ]
  const label = typeof unitLabel === 'string' && unitLabel.length > 0 ? unitLabel : '操作数'
  if (Number.isInteger(operations) && operations > 0) lines.push(label + '：' + operations + '。')
  lines.push('记录 ID：' + ids.join('、') + (ids.length < count ? '…' : ''))
  lines.push('恢复：/memory-lab restore；检索：/memory-lab recall <词>；原文仍在会话日志，可按 ID 回读。')
  return lines
}

/**
 * 生成回执正文。
 *
 * 顺序固定：基础身份 → 摘要 → 操作数 → 记录 ID → 恢复入口（摘要紧跟首行，便于模型先读）。
 * 预算不足时：先降 ID 抽样数，再省略摘要；**不截断任何基础身份行**。
 *
 * 传入 `sourceChars`（原文总字数）时，摘要预算再受原文净收益约束：
 * `min(400 字硬上界, sourceChars - 基础回执字数 - 安全余量)`。预算 < 40 字整条省略摘要。
 * 不传 `sourceChars` 的调用点保持旧的「只受 400 字硬上界」行为（纯渲染单测/兼容）。
 *
 * @param {{startSeq:number,endSeq:number,recordIds:string[],operations?:number,unitLabel?:string,summary?:string,sourceChars?:number|null,summarySafetyMargin?:number}} input
 * @returns {string}
 */
export function renderArchiveReceipt({ startSeq, endSeq, recordIds, operations = 0, unitLabel = '操作数', summary = '', sourceChars = null, summarySafetyMargin = RECEIPT_SUMMARY_SAFETY_MARGIN } = {}) {
  if (!Number.isInteger(startSeq) || startSeq < 0 || !Number.isInteger(endSeq) || endSeq < startSeq) {
    throw new V3ContractViolation('v3 archive/receipt: startSeq/endSeq 非法')
  }
  if (!Array.isArray(recordIds) || recordIds.length === 0) {
    throw new V3ContractViolation('v3 archive/receipt: recordIds 必须是非空数组')
  }
  if (sourceChars !== null && (!Number.isInteger(sourceChars) || sourceChars < 0)) {
    throw new V3ContractViolation('v3 archive/receipt: sourceChars 必须是非负整数或 null')
  }
  if (!Number.isInteger(summarySafetyMargin) || summarySafetyMargin < 0) {
    throw new V3ContractViolation('v3 archive/receipt: summarySafetyMargin 必须是非负整数')
  }
  const summaryAvailable = typeof summary === 'string' && summary.length > 0
  // P3-06：基础身份行（数量/区间/操作数/记录 ID/恢复入口）**不得被静默截断或丢弃**。
  // 旧实现超预算时把 operations 置 0，等于无声删掉「操作数：N。」这一行——注释写着
  // 「不截断任何基础身份行」，代码却在删行。现在只降 ID 抽样数（3 → 1），操作数照旧保留；
  // 真的连 1 个 ID 都装不下时抛合同错误（数据异常，不是可以静默糊过去的情形）。
  let lines = baseLines({ startSeq, endSeq, recordIds, operations, unitLabel, sampleCount: 3 })
  if (lines.join('\n').length > RECEIPT_MAX_CHARS) {
    lines = baseLines({ startSeq, endSeq, recordIds, operations, unitLabel, sampleCount: 1 })
  }
  const baseText = lines.join('\n')
  if (baseText.length > RECEIPT_MAX_CHARS) {
    throw new V3ContractViolation('v3 archive/receipt: 基础身份超出回执预算（不应发生；请检查 recordIds）')
  }
  if (!summaryAvailable) return baseText
  // 摘要行 = '摘要：' + 正文，另需一个换行；预算按码元算（与净收益判据同一单位）。
  const baseUnits = baseText.length
  const reserve = baseUnits + 1 + RECEIPT_SUMMARY_PREFIX.length
  let budget = RECEIPT_MAX_CHARS - reserve
  // P5：摘要只花「仍能保持正净收益」的那部分预算。sourceChars 是原文总字数
  // （UTF-16 码元，与 not-worth 判据同一口径）；基础身份先占位，再扣安全余量。
  if (Number.isInteger(sourceChars)) {
    const available = sourceChars - baseUnits - summarySafetyMargin
    budget = Math.min(budget, Math.max(0, available))
  }
  if (budget < RECEIPT_MIN_SUMMARY_CHARS) return baseText
  const clamped = clampSummaryTextByUnits(summary, budget)
  // 阈值只约束「可用预算」，不约束摘要正文本身：预算 40 而摘要只有 27 字时，
  // 完整写出这 27 字仍然可读（P4 模型短摘要不能因为短而被无声丢弃）。
  if (clamped.length === 0) return baseText
  // 摘要插在首行之后（模型先看到「归档了什么」，再看到摘要）。
  lines.splice(1, 0, RECEIPT_SUMMARY_PREFIX + clamped)
  const text = lines.join('\n')
  // 兜底与预算同单位（P3-03）：裁剪已按码元，这里再按码元复核一次；超了才退回基础身份。
  return text.length <= RECEIPT_MAX_CHARS ? text : baseText
}
