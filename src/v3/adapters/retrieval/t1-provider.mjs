/**
 * T1 检索提供者（adapters/retrieval，M4 第二批）——MemoryProvider 端口的本地实现。
 *
 * - BM25（k1=1.2 / b=0.75）：打分只用索引里的 df/tf/docLengths（同一把尺子，beta.7 F 组）；
 * - OOV 词（df=0）不进 relevance 分母且单独披露（retrieval-contract 保留判据 F3）；
 * - 索引陈化：search 前查 staleness，陈化即经端口重建（P9 派生物可重建，不挡检索）；
 * - capabilities 报「当前实际生效」的后端与覆盖面（retrieval-provider 保留判据 D1：
 *   available ≠ 已启动——这里报的就是本 provider 自身，不存在虚报空间）；
 * - read 的返回顶层 text 恒为非空字符串（recall-ptc 保留判据：PTC 形态可读）。
 */
import { assertPort } from '../../ports/index.mjs'
import { applyMinScore, rankResults, tokenizeQuery } from '../../domain/retrieval/query.mjs'
import { isIndexStale, readLexicalIndex } from '../storage/lexical-index.mjs'
import { v3Error, V3ContractViolation } from '../../contracts/index.mjs'

const K1 = 1.2
const B = 0.75
export const T1_BACKEND_NAME = 'local-lexical-v3'

/**
 * 创建 T1 提供者。
 * @param {object} deps { port: SessionStore 端口, store: session-store 句柄（读索引用）, metrics? }
 */
export function createT1Provider({ port, store, metrics } = {}) {
  if (port !== undefined) assertPort('SessionStore', port)
  if (store === null || typeof store !== 'object' || typeof store.directory !== 'string') {
    throw new V3ContractViolation('v3 t1-provider: 需要 session-store 句柄（读索引与陈化重建）')
  }

  async function freshIndex() {
    let index = await readLexicalIndex(store)
    if (await isIndexStale(store, index)) {
      await port.rebuildIndex() // P9：派生物陈化就重建，不挡检索也不掩盖
      metrics?.counter?.('v3.t1.indexRebuilt', 1)
      index = await readLexicalIndex(store)
    }
    return index
  }

  /** BM25 打分：OOV 词不进分母、单独披露；同时统计每文档命中的不同查询词数。 */
  function scoreIndex(index, terms) {
    const N = index.indexedCount
    const scores = new Map()
    const hitCounts = new Map()
    const oovTerms = []
    for (const term of terms) {
      const postings = index.terms[term]
      if (postings === undefined) {
        oovTerms.push(term)
        continue
      }
      const df = Object.keys(postings).length
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5))
      for (const [id, tf] of Object.entries(postings)) {
        const dl = index.docLengths[id] ?? 0
        const norm = index.avgDocLength > 0 ? dl / index.avgDocLength : 1
        const score = idf * (tf * (K1 + 1)) / (tf + K1 * (1 - B + B * norm))
        scores.set(id, (scores.get(id) ?? 0) + score)
        hitCounts.set(id, (hitCounts.get(id) ?? 0) + 1)
      }
    }
    return { scores, hitCounts, oovTerms }
  }

  const impl = {
    /**
     * 检索：tokenize → BM25 → 双面门槛。
     * @returns {{ display, pack, dropped, oovTerms }}（display/pack 经 rankResults 确定性排序）
     */
    async search(query, { limit = 10, resultMinScore = 0, packMinScore = 0 } = {}) {
      if (typeof query !== 'string' || query.length === 0) {
        throw new V3ContractViolation('v3 t1-provider: 查询必须是非空字符串（空查询失败关闭）')
      }
      const index = await freshIndex()
      const terms = tokenizeQuery(query)
      if (terms.length === 0) {
        return { display: [], pack: [], dropped: [], oovTerms: [] } // 纯符号查询不造通配
      }
      const { scores, hitCounts, oovTerms } = scoreIndex(index, terms)
      // 查询覆盖门槛（2026-10-25 拍板）：至少命中半数查询词才进结果面——
      // 绝对分数阈值对 BM25 分数量纲不设防，OOV 查询靠单个高频低质词（如「面」「机」）
      // 也能攒出十几分垃圾；覆盖门槛按「命中的不同查询词数」判相关性，量纲无关。
      const minHits = Math.max(1, Math.ceil(terms.length / 2))
      const ranked = rankResults([...scores].map(([id, score]) => ({ id, score })))
        .filter((r) => (hitCounts.get(r.id) ?? 0) >= minHits)
        .slice(0, limit)
      const gated = applyMinScore(ranked, { resultMinScore, packMinScore })
      metrics?.counter?.('v3.t1.search', 1)
      return { ...gated, oovTerms }
    },

    /** 精确回读：顶层 text 恒非空（PTC 形态可读）。 */
    async read(recordId) {
      if (typeof recordId !== 'string' || recordId.length === 0) {
        throw new V3ContractViolation('v3 t1-provider: recordId 必须是非空字符串')
      }
      const record = await port.readRecord(recordId)
      const text = typeof record?.payload?.text === 'string' ? record.payload.text : ''
      if (text.length === 0) {
        throw v3Error('EFORGOTTEN', '记录 ' + recordId + ' 正文为空或不可读（失败关闭，不返回空壳）')
      }
      return { text, record }
    },

    async health() {
      const index = await readLexicalIndex(store)
      const stale = await isIndexStale(store, index)
      return { healthy: !stale, indexStale: stale, indexedCount: index?.indexedCount ?? 0 }
    },

    capabilities() {
      return { name: T1_BACKEND_NAME, tier: 'T1', live: true }
    },
  }

  return assertPort('MemoryProvider', impl)
}
