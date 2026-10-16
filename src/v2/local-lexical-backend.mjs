/**
 * T1 本地词法检索后端 —— 纯 Node、零外部进程（设计文档 v1.2 §4/§5）。
 *
 * 定位：灵枢后端（lingshu-mdcg-receipt）不可用时的**默认**检索实现。能力自述与
 * 灵枢后端同级（lexical-structural，无向量语义）——不冒充语义召回。
 *
 * 索引结构：CJK 连续段二元组 + ASCII 词元的倒排表，按记录 ID 记账；持久化在
 * 会话目录 lexical-index.json（tmp+rename 原子写）。文件缺失或半截 ⇒ 从空索引
 * 重建，与 retrieval-index.json 的记账语义一致，不引入第三种恢复路径。
 *
 * 边界（capabilities.note 原样交给状态面，不夸大）：
 * - 只做词法命中：不做语义向量、模糊匹配、拼音、跨会话；
 * - 命中只返回记录 ID，正文一律回本会话冷库读（原文权威唯一）；
 * - 词条总量有上限（默认 200k，对应常用上下文量级）：超限后停止增量并**如实报
 *   skipped**——绝不让记账把「没索引」当成「已索引」（盲区 61 的工程回应之一）。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { EngineV2Error } from './errors.mjs'

export const LOCAL_LEXICAL_BACKEND_NAME = 'local-lexical-v1'
export const LOCAL_LEXICAL_INDEX_FILE = 'lexical-index.json'
export const LOCAL_LEXICAL_INDEX_KIND = 'dsh-memory-context-lab/v2/lexical-index'
export const LOCAL_LEXICAL_SCHEMA_VERSION = 1
export const DEFAULT_LEXICAL_MAX_TERMS = 200000

export const LOCAL_LEXICAL_CAPABILITIES = Object.freeze({
  kind: 'lexical-structural',
  semanticVectors: false,
  note: '本进程内 CJK 二元组 + ASCII 词元倒排（无外部进程）；命中只给记录 ID，正文一律回本会话冷库读。不做语义向量、模糊匹配与跨会话检索。',
})

/**
 * 词条化：ASCII 连续段按小写词元；CJK 连续段按二元组（单字 run 保留整字）。
 * 中文没有可靠的空格分词边界，二元组是召回率与实现复杂度的最优交点，
 * 且与灵枢后端的词法行为同量级——两者都不做语义。
 */
export function tokenizeForLexicalIndex(text) {
  const out = []
  const lower = String(text ?? '').toLowerCase()
  for (const match of lower.matchAll(/[a-z0-9_][a-z0-9_\-]*/g)) out.push(match[0])
  for (const match of lower.matchAll(/[\u3400-\u4dbf\u4e00-\u9fff]+/g)) {
    const run = match[0]
    if (run.length === 1) {
      out.push(run)
      continue
    }
    for (let i = 0; i + 1 < run.length; i += 1) out.push(run.slice(i, i + 2))
  }
  return out
}

function emptyState() {
  return { docs: new Map(), postings: new Map(), limitReached: false }
}

export function createLocalLexicalBackend({ directory, logger = null, maxTerms = DEFAULT_LEXICAL_MAX_TERMS } = {}) {
  if (typeof directory !== 'string' || directory.length === 0) {
    throw new EngineV2Error('本地词法后端需要会话目录。', { code: 'EINVAL' })
  }
  if (!Number.isInteger(maxTerms) || maxTerms <= 0) {
    throw new EngineV2Error('本地词法后端的词条上限必须是正整数。', { code: 'EINVAL' })
  }
  const indexFile = path.join(directory, LOCAL_LEXICAL_INDEX_FILE)
  let state = null

  async function load() {
    if (state) return state
    try {
      const raw = JSON.parse(await readFile(indexFile, 'utf8'))
      if (raw && raw.kind === LOCAL_LEXICAL_INDEX_KIND && raw.schemaVersion === LOCAL_LEXICAL_SCHEMA_VERSION) {
        state = {
          docs: new Map(Object.entries(raw.docs ?? {})),
          postings: new Map(Object.entries(raw.postings ?? {}).map(([term, posting]) => [term, { d: posting.d ?? [], f: posting.f ?? [] }])),
          limitReached: raw.limitReached === true,
        }
        return state
      }
    } catch {
      // 文件缺失/半截：从零重建。记账（retrieval-index.json）由调用方管理，
      // 这里只保证自己的状态要么完整要么为空。
    }
    state = emptyState()
    return state
  }

  async function persist(current) {
    const payload = {
      kind: LOCAL_LEXICAL_INDEX_KIND,
      schemaVersion: LOCAL_LEXICAL_SCHEMA_VERSION,
      backend: LOCAL_LEXICAL_BACKEND_NAME,
      updatedAt: new Date().toISOString(),
      limitReached: current.limitReached,
      docs: Object.fromEntries(current.docs),
      postings: Object.fromEntries([...current.postings].map(([term, posting]) => [term, posting])),
    }
    await mkdir(directory, { recursive: true })
    const temporary = path.join(directory, LOCAL_LEXICAL_INDEX_FILE + '.tmp-' + process.pid + '-' + Date.now())
    await writeFile(temporary, JSON.stringify(payload) + '\n', 'utf8')
    await rename(temporary, indexFile)
  }

  return {
    name: LOCAL_LEXICAL_BACKEND_NAME,
    capabilities: LOCAL_LEXICAL_CAPABILITIES,

    /**
     * 增量索引：调用方（syncRetrievalIndex）只送未记账的记录。这里再按自身 docs
     * 去重一次——同一记录重复送达时跳过，避免词频被重复计一次。返回值与灵枢后端
     * 同形：skipped 里的记录不会被记账标成已索引。
     */
    async index(records) {
      const current = await load()
      const externalIds = {}
      const skipped = []
      const conflicts = []
      let dirty = false
      for (const record of Array.isArray(records) ? records : []) {
        const id = typeof record?.id === 'string' ? record.id : null
        if (!id) {
          skipped.push({ id: record?.id ?? null, reason: 'missing-id' })
          continue
        }
        if (typeof record.text !== 'string' || record.text.length === 0) {
          // 没有正文的记录不索引：索引进去的只能是元数据，对词法检索毫无用处，
          // 却会让记账把它当成「已索引」。
          skipped.push({ id, reason: 'text-' + (record.textIntegrity ?? 'missing') })
          continue
        }
        if (current.docs.has(id)) {
          externalIds[id] = id
          continue
        }
        if (current.limitReached) {
          skipped.push({ id, reason: 'term-limit-reached' })
          continue
        }
        // P1-7 分块：长正文按块送达（textParts），逐块分词、词频累加进同一文档。
        const parts = Array.isArray(record.textParts) && record.textParts.length > 0
          ? record.textParts.filter((part) => typeof part === 'string' && part.length > 0)
          : [record.text]
        const unique = new Map()
        for (const part of parts) {
          for (const term of tokenizeForLexicalIndex(part)) {
            unique.set(term, (unique.get(term) ?? 0) + 1)
          }
        }
        const freshTerms = [...unique.keys()].filter((term) => !current.postings.has(term))
        if (current.postings.size + freshTerms.length > maxTerms) {
          // 上限只挡「新词条」：已达上限后停止增量，并在状态面如实标注覆盖边界。
          current.limitReached = true
          skipped.push({ id, reason: 'term-limit-reached' })
          logger?.warn?.('本地词法索引已达词条上限 ' + maxTerms + '，停止增量；检索覆盖以已索引记录为准。')
          continue
        }
        for (const [term, count] of unique) {
          let posting = current.postings.get(term)
          if (!posting) {
            posting = { d: [], f: [] }
            current.postings.set(term, posting)
          }
          posting.d.push(id)
          posting.f.push(count)
        }
        current.docs.set(id, {
          seq: record.seq ?? null,
          kind: record.kind ?? null,
          bytes: Buffer.byteLength(record.text, 'utf8'),
          // 覆盖披露（P1-7）：该文档词频来自多少字节的正文片段。
          coveredBytes: Number.isFinite(record.textCoveredBytes) ? record.textCoveredBytes : null,
          fullBytes: Number.isFinite(record.textFullBytes) ? record.textFullBytes : null,
        })
        externalIds[id] = id
        dirty = true
      }
      if (dirty) await persist(current)
      return { externalIds, skipped, conflicts }
    },

    /**
     * P2 主动遗忘：确定性清除文档与倒排项。
     *
     * docs 里没有逐文档词表，删除按「反向过滤」做：扫全部 postings，把命中的
     * id 从 d/f 平行数组里剔除，清空的词条整条删除。代价是 O(全部倒排项)——
     * 会话索引有 maxTerms 上界，一次全扫可接受；换来的是**确定性**：不依赖
     * 重建（重建会把未遗忘记录重新分词，词频可能有微差）。
     * 未在 docs 里的 id 如实报 absent，不谎称已清除。
     */
    async removeDocs(ids) {
      const current = await load()
      const removeSet = new Set((Array.isArray(ids) ? ids : []).filter((x) => typeof x === 'string'))
      if (removeSet.size === 0) return { removed: [], absent: [] }
      const removed = []
      const absent = []
      for (const id of removeSet) {
        if (current.docs.has(id)) {
          current.docs.delete(id)
          removed.push(id)
        } else {
          absent.push(id)
        }
      }
      if (removed.length > 0) {
        for (const [term, posting] of [...current.postings]) {
          const keepIds = []
          const keepFreqs = []
          for (let i = 0; i < posting.d.length; i += 1) {
            if (removeSet.has(posting.d[i])) continue
            keepIds.push(posting.d[i])
            keepFreqs.push(posting.f[i])
          }
          if (keepIds.length === 0) current.postings.delete(term)
          else {
            posting.d = keepIds
            posting.f = keepFreqs
          }
        }
        await persist(current)
      }
      return { removed, absent }
    },

    /**
     * 查询（P1-2 重写）：OR 召回 + BM25 排序 + 最小相关门槛；精确标识符/引号
     * 短语走 AND 显式通道（无门槛）。
     *
     * 选型理由（计划 §5 P1-2 的二选一，选 BM25 而非「IDF 加权 + 字段权重」）：
     * postings 已带词频、docs 已带字节长度，BM25 的 tf 饱和与长度归一是词法排序
     * 的标准解，无需另造字段权重。门槛不用 BM25 分数（其尺度随语料大小漂移，
     * 校准后会悄悄失效），而用无量纲量：
     *   rel(d) = Σ_{t∈命中词元} idf(t) / Σ_{t∈查询词元} idf(t)
     * 即「查询的信息质量被该文档覆盖的比例」。放行规则见函数体内联注释
     * （P1 dev 集校准，test/v2-local-lexical.test.mjs）：OR 放宽的是召回，
     * 不是相关性——主题词全中而连接词未中的改写记录放行；只碰一两个通用
     * 词元的无关记录按「无关」处理，零正文。
     *
     * 精确通道（options.exact，由 query-plan 产出）：这些词元全部必须命中
     * （AND 语义），不设门槛；自由词元仍参与 BM25 排序。
     */
    async query(text, { limit = 20, exact = [], exclude = [] } = {}) {
      const current = await load()
      const requiredTerms = [...new Set(tokenizeForLexicalIndex(Array.isArray(exact) ? exact.join(' ') : ''))]
      const freeTerms = [...new Set(tokenizeForLexicalIndex(text))].filter((term) => !requiredTerms.includes(term))
      const terms = [...requiredTerms, ...freeTerms]
      if (terms.length === 0) return []
      // P1-3：排除集在 top-k 前生效（遗忘/会话过滤等命中面策略），
      // 排除文档不进候选、不占 top-k 名额。
      const excludedIds = new Set(Array.isArray(exclude) ? exclude.filter((x) => typeof x === 'string') : [])
      const docCount = current.docs.size
      if (docCount === 0) return []

      // idf(t) = ln(1 + (N - df + 0.5)/(df + 0.5))，恒正；语料外词元 df=0 → 最大 idf。
      const idfOf = new Map(terms.map((term) => {
        const df = current.postings.get(term)?.d.length ?? 0
        return [term, Math.log(1 + (docCount - df + 0.5) / (df + 0.5))]
      }))
      const totalIdf = [...idfOf.values()].reduce((sum, value) => sum + value, 0) || 1

      // OR 召回：任一词元命中即入候选集（不再要求全部词元同时命中）。
      const candidates = new Map() // id -> Map<term, tf>
      for (const term of terms) {
        const posting = current.postings.get(term)
        if (!posting) continue
        for (let i = 0; i < posting.d.length; i += 1) {
          if (excludedIds.has(posting.d[i])) continue
          let tfByTerm = candidates.get(posting.d[i])
          if (!tfByTerm) {
            tfByTerm = new Map()
            candidates.set(posting.d[i], tfByTerm)
          }
          tfByTerm.set(term, posting.f[i])
        }
      }
      // 精确通道闸门：required 词元任一缺失即出局。
      if (requiredTerms.length > 0) {
        for (const [id, tfByTerm] of [...candidates]) {
          if (requiredTerms.some((term) => !tfByTerm.has(term))) candidates.delete(id)
        }
      }
      if (candidates.size === 0) return []

      // BM25 排序：k1=1.5、b=0.75（标准缺省）。文档长度用 bytes 近似——索引不存
      // 词元总数，字节与词元数在同语料内近似线性，归一目的（长文不加权）达成即可。
      const K1 = 1.5
      const B = 0.75
      let totalBytes = 0
      // 文档长度按覆盖字节计：P1-7 分块索引后 doc.bytes 只是首块长度，
      // 归一化用实际索引到的字节数才不自欺（超限未覆盖的部分本来就没进索引）。
      for (const doc of current.docs.values()) totalBytes += doc?.coveredBytes ?? doc?.bytes ?? 0
      const avgBytes = totalBytes / docCount || 1
      // 门槛（P1 dev 集校准，见 test/v2-local-lexical.test.mjs）二选一放行：
      // ① rel ≥ 0.5：过半 idf 质量——单词命中但那是查询的稀缺主题词（如「做饭」）
      //    时成立，是 OR 召回放宽的本意（改写/换序仍可命中）；
      // ② 命中 ≥2 词元且 rel ≥ 0.25：CJK 二元组查询里连接词（「复失」「试路」）
      //    的 idf 常高于主题词，纯分数门槛会把「四个主题词全中、四个连接词未中」
      //    的改写记录误杀；≥2 词元防单点误配，0.25 下限挡住只共享两个通用词的
      //    无关记录（其低 idf 使 rel 远低于 0.25）。
      const REL_FLOOR = 0.5
      const MULTI_TERM_FLOOR = 0.25
      const ranked = []
      for (const [id, tfByTerm] of candidates) {
        const len = current.docs.get(id)?.bytes ?? 0
        const norm = K1 * (1 - B + (B * len) / avgBytes)
        let bm25 = 0
        let matchedIdf = 0
        for (const [term, tf] of tfByTerm) {
          const weight = idfOf.get(term) ?? 0
          matchedIdf += weight
          bm25 += weight * ((tf * (K1 + 1)) / (tf + norm))
        }
        if (requiredTerms.length === 0) {
          const relevance = matchedIdf / totalIdf
          const paraphrase = tfByTerm.size >= 2 && relevance + 1e-9 >= MULTI_TERM_FLOOR
          if (relevance + 1e-9 < REL_FLOOR && !paraphrase) continue // 无关：不进候选
        }
        const seq = current.docs.get(id)?.seq ?? 0
        ranked.push({ id, score: bm25, seq })
      }
      ranked.sort((a, b) => (b.score !== a.score ? b.score - a.score : b.seq - a.seq))
      return ranked.slice(0, Math.max(1, limit)).map((entry) => entry.id)
    },

    /** 本后端无进程、无外部连接：就绪恒真（装配期选择不依赖它）。 */
    async ping() {
      return true
    },

    /** 无需刷新：每次 index 后已原子落盘。保留挂点与契约对齐。 */
    async dispose() {},
  }
}
