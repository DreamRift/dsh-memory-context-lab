/**
 * chunk 索引（adapters/storage，0.15.0 P5）——**可删除、可重建的派生物**。
 *
 * 内容只有 recordId → 码点 span + 版本元数据，不复制正文：
 * - 本地 SessionStore 记录仍是唯一恢复真源；chunk 只影响「选哪个窗口呈现」；
 * - schemaVersion/tokenizerVersion 不匹配 → 视为不可用（查询回退现扫），不混用两把尺子；
 * - sourceCount/forgottenCount 与词法索引同口径：新鲜度只跟已提交/已遗忘规模比；
 * - 缺失/损坏不挡检索：读取方按 absent/error 降级，重建只发生在索引维护点。
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { v3Error, V3ContractViolation } from '../../contracts/errors.mjs'
import {
  CHUNK_OVERLAP,
  CHUNK_SCHEMA_VERSION,
  CHUNK_SIZE,
  chunkText,
  tokenizerVersionOf,
} from '../../domain/retrieval/chunks.mjs'
import { fileStampOf } from './file-stamp.mjs'
import { writeFileAtomic } from './session-store.mjs'

const CHUNK_INDEX_FILE = 'chunk-index.json'

/**
 * 从记录清单构建 chunk 索引。
 * @param {Array<{id: string, text: string}>} entries 可检索记录（已排除 metadata-only/已遗忘/重复）
 * @param {{sourceCount?: number, forgottenCount?: number, maxChunks?: number}} [counts]
 */
export function buildChunkIndex(entries, { sourceCount, forgottenCount, maxChunks } = {}) {
  if (!Array.isArray(entries)) {
    throw new V3ContractViolation('v3 chunk-index: entries 必须是数组')
  }
  const chunks = Object.create(null)
  const truncatedIds = []
  let chunkCount = 0
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object' || typeof entry.id !== 'string' || typeof entry.text !== 'string') {
      throw new V3ContractViolation('v3 chunk-index: 条目必须是 {id, text}')
    }
    const { spans, truncated } = maxChunks === undefined
      ? chunkText(entry.text)
      : chunkText(entry.text, { maxChunks })
    chunks[entry.id] = spans.map((span) => [span.start, span.end])
    chunkCount += spans.length
    // 截断必须**逐记录留痕**：查询侧据此知道「这块记录的 chunk 覆盖不全」，
    // 不能只留一个总数（那无法判断命中记录自己是否被截断）。
    if (truncated) truncatedIds.push(entry.id)
  }
  return {
    schemaVersion: CHUNK_SCHEMA_VERSION,
    tokenizerVersion: tokenizerVersionOf(),
    chunkSize: CHUNK_SIZE,
    chunkOverlap: CHUNK_OVERLAP,
    indexedCount: entries.length,
    sourceCount: Number.isInteger(sourceCount) && sourceCount >= 0 ? sourceCount : entries.length,
    forgottenCount: Number.isInteger(forgottenCount) && forgottenCount >= 0 ? forgottenCount : 0,
    chunkCount,
    truncatedRecords: truncatedIds.length,
    truncatedIds,
    chunks,
  }
}

/** 持久化 chunk 索引（temp+rename；派生物不保证 fsync）。 */
export async function writeChunkIndex(store, index) {
  await writeFileAtomic(path.join(store.directory, CHUNK_INDEX_FILE), JSON.stringify(index) + '\n')
}

/** 读取并归一化 chunk 索引；缺失 null，损坏 ESTORE_CORRUPT（不静默重建掩盖损坏）。 */
export async function readChunkIndex(store) {
  let text
  try {
    text = await readFile(path.join(store.directory, CHUNK_INDEX_FILE), 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = null
  }
  const shapeOk = parsed !== null
    && typeof parsed === 'object'
    && Number.isInteger(parsed.schemaVersion)
    && typeof parsed.tokenizerVersion === 'string'
    && typeof parsed.chunks === 'object'
    && parsed.chunks !== null
    && Number.isInteger(parsed.indexedCount)
  if (!shapeOk) {
    throw v3Error('ESTORE_CORRUPT', 'chunk-index.json 损坏（派生物：删除后重建即可，不掩盖）')
  }
  const chunks = Object.create(null)
  for (const [id, spans] of Object.entries(parsed.chunks)) {
    if (!Array.isArray(spans)) continue
    const out = []
    for (const span of spans) {
      if (Array.isArray(span) && Number.isInteger(span[0]) && Number.isInteger(span[1]) && span[1] > span[0]) {
        out.push([span[0], span[1]])
      }
    }
    chunks[id] = out
  }
  // 旧索引没有 truncatedIds（该字段是 P3 修复新增的）：按空集处理，覆盖不全仍由
  // 查询侧的「命中是否都在 chunk 内」兜底（不依赖这个字段才不丢尾段）。
  const truncatedIds = Array.isArray(parsed.truncatedIds)
    ? parsed.truncatedIds.filter((id) => typeof id === 'string')
    : []
  return { ...parsed, chunks, truncatedIds }
}

/** 索引文件戳（与词法索引同判据）。 */
export async function chunkIndexStampOf(store) {
  return fileStampOf(path.join(store.directory, CHUNK_INDEX_FILE))
}

/** schema/tokenizer 版本是否与本进程一致（不一致 = 不可用，查询回退现扫）。 */
export function isChunkIndexCompatible(index) {
  return index !== null
    && typeof index === 'object'
    && index.schemaVersion === CHUNK_SCHEMA_VERSION
    && index.tokenizerVersion === tokenizerVersionOf()
}

/**
 * 新鲜度：已提交数 / 已遗忘数任一变化 → stale（与词法索引同口径）。
 * 热路径每次命中都会查一次：优先用端口的同步 `recordCount()`（零额外 I/O），
 * 只有端口未提供时才退回 `listRecordIds()` 全量列目录。
 */
export async function isChunkIndexStale(store, index) {
  if (index === null) return true
  let committed = null
  if (typeof store.recordCount === 'function') {
    const count = store.recordCount()
    if (Number.isInteger(count) && count >= 0) committed = count
  }
  if (committed === null) committed = (await store.listRecordIds()).length
  const baseline = Number.isInteger(index.sourceCount) ? index.sourceCount : index.indexedCount
  if (baseline !== committed) return true
  const forgottenCount = typeof store.listForgotten === 'function' ? store.listForgotten().length : 0
  const indexForgotten = Number.isInteger(index.forgottenCount) ? index.forgottenCount : 0
  return forgottenCount !== indexForgotten
}

/** 取某记录的 chunk spans（码点半开区间）；未知记录返回空数组。 */
export function chunkSpansOf(index, recordId) {
  const spans = index?.chunks?.[recordId]
  if (!Array.isArray(spans)) return []
  return spans.map(([start, end]) => ({ start, end }))
}

/** 该记录的 chunk 是否被单记录硬顶截断（覆盖不全 → 查询侧必须回退现扫）。 */
export function chunkRecordTruncated(index, recordId) {
  const ids = index?.truncatedIds
  if (!Array.isArray(ids)) return false
  return ids.includes(recordId)
}
