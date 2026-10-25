/**
 * v3 词法索引（adapters/storage，M2 第三批）——可删除、可重建的派生物。
 *
 * 权威事实源只有记录正文（P9：索引是派生物）；本模块只做：
 * - buildLexicalIndex：从 {id, text} 清单建倒排（term → {id: tf}），
 *   词元化复用 domain/retrieval 的 tokenizeQuery（CJK 单字+双字，同一把尺子）；
 * - searchLexical：词元覆盖计数打分 + rankResults 确定性排序（domain 消费者）；
 * - 读写经 writeFileAtomic / JSON；索引文件损坏 → ESTORE_CORRUPT，
 *   调用方走 rebuildLexicalIndex 从记录重建（派生物不许挡权威数据）。
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { v3Error, V3ContractViolation } from '../../contracts/errors.mjs'
import { rankResults, tokenizeQuery } from '../../domain/retrieval/query.mjs'
import { writeFileAtomic } from './session-store.mjs'

const INDEX_FILE = 'lexical-index.json'

/**
 * 从记录清单构建索引。entries: Array<{id: string, text: string}>
 * @returns {{ terms: Object<string, Object<string, number>>, indexedCount: number }}
 */
export function buildLexicalIndex(entries) {
  if (!Array.isArray(entries)) {
    throw new V3ContractViolation('v3 index: entries 必须是数组')
  }
  const terms = {}
  const docLengths = {}
  let totalTokens = 0
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object' || typeof entry.id !== 'string' || typeof entry.text !== 'string') {
      throw new V3ContractViolation('v3 index: 条目必须是 {id, text}')
    }
    // docLength 只在这里算一次（beta.7 F 组：同一个量只算一次）——BM25 的文档长度单一真源
    const tokens = tokenizeQuery(entry.text)
    docLengths[entry.id] = tokens.length
    totalTokens += tokens.length
    for (const term of tokens) {
      terms[term] = terms[term] ?? {}
      terms[term][entry.id] = (terms[term][entry.id] ?? 0) + 1
    }
  }
  return {
    terms,
    docLengths,
    avgDocLength: entries.length === 0 ? 0 : totalTokens / entries.length,
    indexedCount: entries.length,
  }
}

/**
 * 词法检索：每个词元命中记 tf，得分 = 命中词元的 tf 之和（未命中词元不计分，
 * 也不做 OOV 披露——那是 M4 BM25 合并通道的职责）。
 * @returns {Array<{id, score}>} 经 rankResults 排序的前 limit 条
 */
export function searchLexical(index, query, { limit = 10 } = {}) {
  if (index === null || typeof index !== 'object' || typeof index.terms !== 'object') {
    throw new V3ContractViolation('v3 index: index 必须是 buildLexicalIndex 产物')
  }
  if (!Number.isInteger(limit) || limit < 1) {
    throw new V3ContractViolation('v3 index: limit 必须是 ≥1 整数')
  }
  const terms = tokenizeQuery(query)
  if (terms.length === 0) return [] // 空查询不造通配（fail-closed）
  const scores = new Map()
  for (const term of terms) {
    const postings = index.terms[term]
    if (postings === undefined) continue
    for (const [id, tf] of Object.entries(postings)) {
      scores.set(id, (scores.get(id) ?? 0) + tf)
    }
  }
  return rankResults([...scores].map(([id, score]) => ({ id, score }))).slice(0, limit)
}

/** 持久化索引（派生物缓存）。 */
export async function writeLexicalIndex(store, index) {
  await writeFileAtomic(path.join(store.directory, INDEX_FILE), JSON.stringify(index) + '\n')
}

/** 读取索引；缺失返回 null（可重建），损坏抛 ESTORE_CORRUPT（不静默重建掩盖）。 */
export async function readLexicalIndex(store) {
  let text
  try {
    text = await readFile(path.join(store.directory, INDEX_FILE), 'utf8')
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
  const shapeOk = parsed !== null && typeof parsed === 'object' && typeof parsed.terms === 'object' && typeof parsed.docLengths === 'object' && Number.isFinite(parsed.avgDocLength) && Number.isInteger(parsed.indexedCount)
  if (!shapeOk) {
    throw v3Error('ESTORE_CORRUPT', 'lexical-index.json 损坏（派生物：删除后重建即可，不掩盖）')
  }
  return parsed
}

/**
 * 从存储的已提交记录重建索引并持久化。
 * @param {object} store openV3SessionStore 句柄
 * @param {Function} textOfRecord 从记录取正文的投影（默认 payload.text）
 */
export async function rebuildLexicalIndex(store, textOfRecord) {
  const pick = textOfRecord ?? ((record) => record?.payload?.text ?? '')
  const ids = await store.listRecordIds()
  const entries = []
  for (const id of ids) {
    const record = await store.readRecord(id)
    entries.push({ id, text: pick(record) })
  }
  const index = buildLexicalIndex(entries)
  await writeLexicalIndex(store, index)
  return index
}

/** 索引新鲜度：indexedCount 与已提交记录数不一致 → stale（须重建后再检索）。 */
export async function isIndexStale(store, index) {
  if (index === null) return true
  const ids = await store.listRecordIds()
  return index.indexedCount !== ids.length
}
