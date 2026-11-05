/**
 * 检索 chunk 域（domain/retrieval，0.15.0 P5）。
 *
 * chunk 是**原记录的派生引用**（开发流程 §5.3/§7.1）：只保存 recordId → 码点半开区间，
 * 不另存正文、不成为第二份证据。术语与约束：
 * - 偏移单位 = Unicode **码点**半开区间 `[start, end)`；与本地 JS `[...text]` 同尺，
 *   不混用 UTF-16 码元/token；
 * - 窗口固定长度 + 重叠，保证跨 chunk 边界的长词仍可被一个 chunk 完整覆盖；
 * - tokenizerVersion 与 chunkSchemaVersion 一起进索引元数据：分词器换代后旧 chunk
 *   索引必须判为不可用（查询回退到现扫），不能拿新旧两把尺子混算；
 * - 单记录 chunk 数有硬顶（防御病态超长正文），超限时如实标记 truncated。
 */
import { V3ContractViolation } from '../../contracts/errors.mjs'
import { TOKENIZER_VERSION } from './query.mjs'

/** chunk 索引结构版本：字段语义变更时 +1，旧索引按不兼容降级（不静默复用）。 */
export const CHUNK_SCHEMA_VERSION = 1

/** 单个 chunk 的目标码点长度。 */
export const CHUNK_SIZE = 600

/** 相邻 chunk 的重叠码点数（必须 < CHUNK_SIZE）。 */
export const CHUNK_OVERLAP = 120

/** 单记录 chunk 数硬顶：超出部分不建 chunk 引用，标记 truncated（正文本身不受影响）。 */
export const MAX_CHUNKS_PER_RECORD = 1024

/**
 * 把正文切成码点半开区间 chunk。
 *
 * @param {string} text 原文（未转义/未脱敏来源；展示转义后的偏移不得回切原件）
 * @param {{chunkSize?: number, overlap?: number, maxChunks?: number}} [opts]
 * @returns {{spans: Array<{start: number, end: number}>, truncated: boolean}}
 */
export function chunkText(text, { chunkSize = CHUNK_SIZE, overlap = CHUNK_OVERLAP, maxChunks = MAX_CHUNKS_PER_RECORD } = {}) {
  if (typeof text !== 'string') {
    throw new V3ContractViolation('v3 chunks: text 必须是字符串')
  }
  if (!Number.isInteger(chunkSize) || chunkSize < 32) {
    throw new V3ContractViolation('v3 chunks: chunkSize 必须是 ≥32 的整数')
  }
  if (!Number.isInteger(overlap) || overlap < 0 || overlap >= chunkSize) {
    throw new V3ContractViolation('v3 chunks: overlap 必须是 [0, chunkSize) 的整数')
  }
  if (!Number.isInteger(maxChunks) || maxChunks < 1) {
    throw new V3ContractViolation('v3 chunks: maxChunks 必须是 ≥1 的整数')
  }
  const cps = Array.from(text)
  const spans = []
  let start = 0
  while (start < cps.length && spans.length < maxChunks) {
    const end = Math.min(cps.length, start + chunkSize)
    spans.push({ start, end })
    if (end >= cps.length) break
    // 重叠必须使窗口前进：overlap < chunkSize 时 start 恒增；这个守卫只防未来参数放宽。
    start = Math.max(start + 1, end - overlap)
  }
  const covered = spans.length === 0 ? 0 : spans[spans.length - 1].end
  return { spans, truncated: covered < cps.length }
}

/** 词元/结构版本（供索引元数据与诊断共用；不在这里重复定义分词器）。 */
export function tokenizerVersionOf() {
  return TOKENIZER_VERSION
}
