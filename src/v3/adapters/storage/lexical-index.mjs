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
export function buildLexicalIndex(entries, { sourceCount, forgottenCount } = {}) {
  if (!Array.isArray(entries)) {
    throw new V3ContractViolation('v3 index: entries 必须是数组')
  }
  // 倒排表必须是**无原型对象**（H-13）：普通 {} 上 terms['constructor'] 命中的是
  // Object.prototype.constructor（继承属性），于是 terms[term][id] = … 会把记录 ID 写进
  // 全局 Object 构造函数（原型污染），且该词元在 JSON 序列化时被丢弃（检索永久 OOV）。
  const terms = Object.create(null)
  const docLengths = Object.create(null)
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
      if (terms[term] === undefined) terms[term] = Object.create(null)
      terms[term][entry.id] = (terms[term][entry.id] ?? 0) + 1
    }
  }
  return {
    terms,
    docLengths,
    avgDocLength: entries.length === 0 ? 0 : totalTokens / entries.length,
    indexedCount: entries.length,
    // 上游规模（已提交记录数，含未进索引的 metadata-only 与已遗忘记录）：
    // 新鲜度只跟这个量比——indexedCount 是「可检索文档数」，两者口径不同，
    // 拿 indexedCount 跟已提交数比会让「有 metadata-only / 有遗忘」的库永久 stale
    // （H-03：每次检索都全量重建，O(N) 读盘）。
    sourceCount: Number.isInteger(sourceCount) && sourceCount >= 0 ? sourceCount : entries.length,
    // 建索引时的已遗忘集规模（H-41）：遗忘不改变 sourceCount，只靠它判不出「遗忘后索引没重建」。
    forgottenCount: Number.isInteger(forgottenCount) && forgottenCount >= 0 ? forgottenCount : 0,
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
/**
 * 索引文件戳（mtimeMs + size）：检索侧缓存解析结果的唯一判据。
 * 索引是派生文件，写入走原子 rename——戳变化即「有别的写入者换了内容」。
 * @returns {Promise<string>} 不存在返回 'absent'（与「读失败」区分）
 */
export async function indexStampOf(store) {
  const { stat } = await import('node:fs/promises')
  try {
    const info = await stat(path.join(store.directory, INDEX_FILE))
    return info.mtimeMs + ':' + info.size
  } catch (error) {
    if (error?.code === 'ENOENT') return 'absent'
    throw error
  }
}

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
  const shapeOk = parsed !== null && typeof parsed === 'object' && typeof parsed.terms === 'object' && parsed.terms !== null && typeof parsed.docLengths === 'object' && parsed.docLengths !== null && Number.isFinite(parsed.avgDocLength) && Number.isInteger(parsed.indexedCount)
  if (!shapeOk) {
    throw v3Error('ESTORE_CORRUPT', 'lexical-index.json 损坏（派生物：删除后重建即可，不掩盖）')
  }
  // JSON.parse 产出的对象带 Object.prototype，旧索引文件里还可能已经带着被污染的
  // 继承属性（H-13）。读入后一律换成无原型表：查询 'constructor' 必须落 OOV，不能命中原型。
  const terms = Object.create(null)
  for (const [term, postings] of Object.entries(parsed.terms)) {
    if (postings === null || typeof postings !== 'object') continue
    const own = Object.create(null)
    for (const [id, tf] of Object.entries(postings)) {
      if (typeof tf === 'number' && Number.isFinite(tf)) own[id] = tf
    }
    terms[term] = own
  }
  const docLengths = Object.create(null)
  for (const [id, length] of Object.entries(parsed.docLengths)) {
    if (typeof length === 'number' && Number.isFinite(length)) docLengths[id] = length
  }
  return { ...parsed, terms, docLengths }
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
  // sourceCount 用未过滤的已提交数（entries 可能已由 textOfRecord 过滤掉不可检索项）
  const forgottenCount = typeof store.listForgotten === 'function' ? store.listForgotten().length : 0
  const index = buildLexicalIndex(entries, { sourceCount: ids.length, forgottenCount })
  await writeLexicalIndex(store, index)
  return index
}

/**
 * 索引新鲜度：**上游规模**（sourceCount）与已提交记录数不一致 → stale（须重建后再检索）。
 * 口径必须与 rebuildIndex 的输入一致：indexedCount 是可检索文档数（已扣除 metadata-only
 * 与已遗忘），拿它跟已提交数比会永久 stale（H-03）。旧索引无 sourceCount → 按 indexedCount
 * 比较，重建一次后自愈。
 *
 * 遗忘也必须算进新鲜度（H-41）：旧判据只看「已提交记录数」，而**遗忘不改变这个数**
 * （遗忘是「不可见」，不是「从未摄入」——见 session-store-port 的 sourceEventIds 注释）。
 * 于是「遗忘已提交、索引重建没跑」（崩溃 / 进程被杀 / IO 失败 / 另一个句柄先重建）
 * 的状态下索引**不会**被判 stale，检索面永久保留已遗忘记录，recall 还会把它回注出去
 * （实测：遗忘 1 条后 health 报 indexStale=false，search 仍返回它，recall 注入 hits=2）。
 * 现在把遗忘集的**规模**一并纳入基线：只多读一次 listForgotten，成本与文件大小无关。
 */
export async function isIndexStale(store, index) {
  if (index === null) return true
  const ids = await store.listRecordIds()
  const baseline = Number.isInteger(index.sourceCount) ? index.sourceCount : index.indexedCount
  if (baseline !== ids.length) return true
  // 已遗忘集规模变了 → 索引里可能还留着已遗忘正文，必须重建
  const forgottenCount = typeof store.listForgotten === 'function' ? store.listForgotten().length : 0
  const indexForgotten = Number.isInteger(index.forgottenCount) ? index.forgottenCount : 0
  return forgottenCount !== indexForgotten
}
