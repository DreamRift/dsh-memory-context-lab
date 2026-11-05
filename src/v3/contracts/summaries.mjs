/**
 * 摘要派生对象合同（contracts，0.15.0 P4，单一真源）。
 *
 * 三层摘要（开发流程 §6.4）：
 * - 短回执：voucher.receiptText 里一次固化的短文本（本文件不管渲染，只给预算口径）；
 * - 详细摘要：**本文件定义的 SummaryArtifact**，独立、不可变、带来源与 hash；
 * - 原记录：SessionStore 记录，按 recordId 精确回读（摘要永远不替代恢复真源）。
 *
 * 纪律（P4 验收）：
 * - 派生物不可变：改写一律新建对象（supersedes 指向旧对象），旧回执/旧摘要字节不动；
 * - 模型草稿只证明「结构合法 + 来源可达」，verification 恒 'unverified'，
 *   不得因 schema 通过就升级成事实；
 * - 来源 = 本会话 recordId + 该记录不可变字节的 hash；跨会话/未知 ID 一律拒绝；
 * - 摘要字段只是候选表示，不是任务真源：本版不建独立 TaskSnapshot 系统。
 */
import { V3ContractViolation } from './errors.mjs'

/** 摘要 schema 版本（独立版本化：升级不迫使原记录迁移）。 */
export const SUMMARY_SCHEMA_VERSION = 1

/** 生成路径封闭集：确定性提取 / 当前模型草稿。 */
export const SUMMARY_GENERATORS = Object.freeze(['extractive', 'model'])

/**
 * 证据状态封闭集。两者都不等于「已证实」：
 * - unverified：结构/来源已校验，语义未验证；
 * - evidence-linked：每条 evidenceRef 都能解析到来源记录（本版仅模型草稿逐项来源
 *   齐全时标它，仍不代表语句被来源蕴含）。
 */
export const SUMMARY_VERIFICATIONS = Object.freeze(['unverified', 'evidence-linked'])

/** 预算上限（字符数按码点计）。超限一律拒绝，不静默截断（截断会让来源与正文脱节）。 */
export const SUMMARY_LIMITS = Object.freeze({
  shortText: 240,
  detail: 4000,
  item: 300,
  items: 20,
  evidenceRefs: 50,
  sources: 200,
})

/** outcome 封闭集（§6.4）：无法确定就写 unknown，不从日志字符串推断成功。 */
export const SUMMARY_OUTCOMES = Object.freeze(['succeeded', 'failed', 'blocked', 'partial', 'unknown'])

/** 摘要 ID 形状：v3s-<16 位小写十六进制>（路径安全判据，读路径必须先过形状）。 */
export const SUMMARY_ID_PATTERN = /^v3s-[0-9a-f]{16}$/

/** 是否为合法摘要 ID（唯一判据；读路径与工具面共用，不许各写一份）。 */
export function isSummaryId(value) {
  return typeof value === 'string' && SUMMARY_ID_PATTERN.test(value)
}

/** 合同违例（编程错误）：配置/装配期用。 */
export function assertSummaryId(value) {
  if (!isSummaryId(value)) {
    throw new V3ContractViolation('v3 summaries: summaryId 必须形如 v3s-<16 位小写十六进制>，得到：' + JSON.stringify(value))
  }
  return value
}

/**
 * 码点长度（不是 UTF-16 length）：中文/emoji 的预算必须按码点算，
 * 否则「240 字」在中文下会被算成 120。
 */
export function codePointLength(value) {
  return typeof value === 'string' ? [...value].length : 0
}
