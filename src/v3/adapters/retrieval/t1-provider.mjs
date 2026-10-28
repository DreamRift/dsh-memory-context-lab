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
import { indexStampOf, isIndexStale, readLexicalIndex } from '../storage/lexical-index.mjs'
import { v3Error, V3ContractViolation } from '../../contracts/index.mjs'

const K1 = 1.2
const B = 0.75
export const T1_BACKEND_NAME = 'local-lexical-v3'

/**
 * 查询覆盖门槛：至少命中多少个**不同**查询词才进结果面。
 *
 * 旧口径是 `ceil(词元数/2)`，前提是「查询很短」（它诞生于 v2 的 `recall <词>` 命令）。
 * 转正后查询变成**整条用户消息**：CJK 分词给每个字产出「单字 + 双字」，一句 20 字的话
 * 有 ~39 个词元，门槛随之涨到 ~20——一篇文档必须包含几乎整句原文才够格。
 * 结果是「回注结构性不发生」，而观察面只显示「无命中」。
 *
 * 现在仍按「不同词元」计半数（短查询语义不变），但设上限：长查询要求命中 3 个不同词
 * 即视为相关。上限压住的是「门槛随查询长度膨胀」，不是「把相关文档放进来」——
 * 分数面（packMinScore）仍然独立把关。
 */
export const COVERAGE_MIN_HITS_CAP = 3

/**
 * 创建 T1 提供者。
 * @param {object} deps { port: SessionStore 端口, store: session-store 句柄（读索引用）, metrics? }
 */
export function createT1Provider({ port, store, metrics } = {}) {
  if (port !== undefined) assertPort('SessionStore', port)
  if (store === null || typeof store !== 'object' || typeof store.directory !== 'string') {
    throw new V3ContractViolation('v3 t1-provider: 需要 session-store 句柄（读索引与陈化重建）')
  }

  // 索引解析缓存（按文件戳失效）。索引是只读派生物，缓存不会让「读不到」伪装成「没有」：
  // 戳读失败会抛出；文件被替换则戳必变。
  let cachedIndex = null
  let cachedStamp = null

  async function freshIndex(allowRebuild = true) {
    // 解析缓存：索引是十几–二十几 MB 的 JSON（本机 4014 文档实测 22.6MB），每次检索 parse 约 250ms——
    // 而回注在 pre-step 的 awaited 路径上，这 200ms 直接变成首字延迟。
    // 判据用文件戳（原子 rename → 戳变即内容变），未变时零解析。
    const stamp = await indexStampOf(store)
    if (cachedIndex !== null && cachedStamp === stamp && !(await isIndexStale(store, cachedIndex))) {
      return cachedIndex
    }
    let index = cachedIndex !== null && cachedStamp === stamp ? cachedIndex : null
    if (index === null) {
      try {
        index = await readLexicalIndex(store)
      } catch (error) {
        // 派生物损坏不得挡检索：索引是纯派生物，删掉重建即可（模块头的承诺）。
        // 旧实现让 ESTORE_CORRUPT 一路抛到回注，永久 failed 且重启不自愈。
        if (error?.code !== 'ESTORE_CORRUPT') throw error
        metrics?.counter?.('v3.t1.indexCorrupt', 1)
        index = null
      }
    }
    if (await isIndexStale(store, index)) {
      // 热路径（回注）**一律**不得做全量重建：N 条记录 = N 次 readFile + 全量 tokenize
      // + 十几 MB 写。实测 5869 条记录的会话单次 645ms，而这段就在 pre-step 的 awaited
      // 路径上（首字延迟）。
      //
      // 旧实现把「不得重建」写成 `!allowRebuild && index !== null`——那个 `index !== null`
      // 让**索引根本不存在**的情况从后门漏回重建路径。而「索引不存在」不是罕见状态：
      // 小增量摄入刻意不重建（只挂 1.5s 防抖），新会话首次回注、崩溃后索引被删、
      // 索引损坏后按「视为缺失」处理，全都落在这个窗口里。于是热路径最贵的分支
      // 恰好是它本应绝对禁止的那一条。
      //
      // 正确处置是**如实报告「现在没有可检索的索引」**，而不是偷偷把 O(N) 搬进钩子：
      // 防抖重建会在一秒多内把索引补上，调用方据此回一个可判读的 skipped。
      if (!allowRebuild) {
        metrics?.counter?.(index === null ? 'v3.t1.indexMissingHotPath' : 'v3.t1.indexStaleUsed', 1)
        if (index === null) return null
        cachedIndex = index
        cachedStamp = stamp
        return index
      }
      await port.rebuildIndex() // P9：派生物陈化就重建，不挡检索也不掩盖
      metrics?.counter?.('v3.t1.indexRebuilt', 1)
      index = await readLexicalIndex(store)
      cachedStamp = await indexStampOf(store)
      cachedIndex = index
      return index
    }
    cachedIndex = index
    cachedStamp = stamp
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
    async search(query, { limit = 10, resultMinScore = 0, packMinScore = 0, allowRebuild = true } = {}) {
      if (typeof query !== 'string' || query.length === 0) {
        throw new V3ContractViolation('v3 t1-provider: 查询必须是非空字符串（空查询失败关闭）')
      }
      // limit 必须校验（H-38）：`slice(0, limit)` 对负数是从尾部切——limit=-1 实测返回
      // 11/12 条（「几乎全量」），Infinity 返回全部。负数是「拒绝」还是「默认」都不成立，
      // 它把「有界热上下文」这条硬不变量变成失败开放。这里失败关闭，不静默夹值
      // （夹值会让调用方以为自己的数字生效了，与 N-10 同一条教训）。
      if (!Number.isSafeInteger(limit) || limit < 0) {
        // 用 String 而非 JSON.stringify：后者把 NaN/Infinity 都渲染成 "null"，诊断时分不清是哪个。
        throw new V3ContractViolation('v3 t1-provider: limit 必须是 ≥0 的安全整数，得到 ' + String(limit))
      }
      // 先分词再读索引：纯符号查询（词元为空）不该付一次全量索引解析，更不该触发重建。
      // 查询词去重：CJK 分词对同一处文本同时产出单字与双字（「机械」→ 机/械/机械），
      // 不去重会让同一处出现被重复计分，也让覆盖门槛把「重复词元」当成「多个不同的词」。
      const terms = [...new Set(tokenizeQuery(query))]
      if (terms.length === 0) {
        return { display: [], pack: [], dropped: [], oovTerms: [] } // 纯符号查询不造通配
      }
      const index = await freshIndex(allowRebuild)
      // 热路径可能拿不到索引（见 freshIndex 的 allowRebuild 分支）：此时**如实回空**，
      // 由调用方按「索引尚未追上」处置。不得在这里回退成一次重建——那正是要禁止的事。
      if (index === null) {
        metrics?.counter?.('v3.t1.indexAbsent', 1)
        return { display: [], pack: [], dropped: [], oovTerms: [], indexAbsent: true }
      }
      const { scores, hitCounts, oovTerms } = scoreIndex(index, terms)
      // 查询覆盖门槛（2026-10-25 拍板；beta.11 修正单位）：按**不同**词元计半数，
      // 且上限 COVERAGE_MIN_HITS_CAP——查询是整条用户消息时，门槛不得随字数膨胀。
      const minHits = Math.max(1, Math.min(COVERAGE_MIN_HITS_CAP, Math.ceil(terms.length / 2)))
      const ranked = rankResults([...scores].map(([id, score]) => ({ id, score })))
        .filter((r) => (hitCounts.get(r.id) ?? 0) >= minHits)
        .slice(0, limit)
      const gated = applyMinScore(ranked, { resultMinScore, packMinScore })
      metrics?.counter?.('v3.t1.search', 1)
      return { ...gated, oovTerms }
    },

    /**
     * 精确回读：顶层 text 恒非空（PTC 形态可读）。
     *
     * metadata-only 记录（P1 摄入合同 4.1.5：「可回读、可对账，不占检索位」）正文本来就是空的，
     * 旧实现把它当成「不可读」并抛 EFORGOTTEN——**把非隐私条件伪装成隐私错误**，而且让
     * 「可回读」的承诺落空（H-15）。现在按 payload.metaOnly 如实给占位正文（说明原因），
     * 真正的数据异常（非 metaOnly 却空正文）报 ESTORE_CORRUPT，与遗忘彻底分开。
     */
    async read(recordId) {
      if (typeof recordId !== 'string' || recordId.length === 0) {
        throw new V3ContractViolation('v3 t1-provider: recordId 必须是非空字符串')
      }
      const record = await port.readRecord(recordId)
      const text = typeof record?.payload?.text === 'string' ? record.payload.text : ''
      if (text.length > 0) return { text, record }
      if (record?.payload?.metaOnly === true) {
        const reason = typeof record.payload.metaReason === 'string' && record.payload.metaReason.length > 0
          ? record.payload.metaReason
          : 'unknown'
        return { text: '[metadata-only] 该记录无可读正文（原因：' + reason + '）；可按 ID 对账，不进全文检索。', record, metaOnly: true }
      }
      throw v3Error('ESTORE_CORRUPT', '记录 ' + recordId + ' 正文为空且未标记 metadata-only（数据异常，失败关闭）')
    },

    async health() {
      const index = await readLexicalIndex(store)
      const stale = await isIndexStale(store, index)
      return { healthy: !stale, indexStale: stale, indexedCount: index?.indexedCount ?? 0 }
    },

    /**
     * 索引统计（0.14.0-beta.38，命令/诊断专用）：复用上面的解析缓存，明确三态。
     * - ok：indexedCount = 可检索文档数（metadata-only / 已遗忘 / 重复来源已扣除）；
     * - absent：索引尚未生成（**不是 0 条可检索**，两者在观察面必须分开）；
     * - error：读戳/解析失败（code 如实带回，调用方显示「未知」）。
     * 这条路径不重建索引：重建只在检索入口与后台摄入任务里发生。
     */
    async indexStats() {
      let stamp
      try {
        stamp = await indexStampOf(store)
      } catch (error) {
        return { state: 'error', code: error?.code ?? 'EINDEX_STAMP', message: error instanceof Error ? error.message : String(error) }
      }
      if (stamp === 'absent') return { state: 'absent' }
      let index = cachedIndex !== null && cachedStamp === stamp ? cachedIndex : null
      if (index === null) {
        try {
          index = await readLexicalIndex(store)
        } catch (error) {
          return { state: 'error', code: error?.code ?? 'EINDEX_PARSE', message: error instanceof Error ? error.message : String(error) }
        }
      }
      if (index === null) return { state: 'absent' }
      cachedIndex = index
      cachedStamp = stamp
      let stale = null
      try {
        stale = await isIndexStale(store, index)
      } catch {
        stale = null
      }
      return {
        state: 'ok',
        indexedCount: index.indexedCount,
        sourceCount: Number.isInteger(index.sourceCount) ? index.sourceCount : null,
        indexStale: stale,
      }
    },

    capabilities() {
      return { name: T1_BACKEND_NAME, tier: 'T1', live: true }
    },
  }

  return assertPort('MemoryProvider', impl)
}
