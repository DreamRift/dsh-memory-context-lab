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
        const unique = new Map()
        for (const term of tokenizeForLexicalIndex(record.text)) {
          unique.set(term, (unique.get(term) ?? 0) + 1)
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
        current.docs.set(id, { seq: record.seq ?? null, kind: record.kind ?? null, bytes: Buffer.byteLength(record.text, 'utf8') })
        externalIds[id] = id
        dirty = true
      }
      if (dirty) await persist(current)
      return { externalIds, skipped, conflicts }
    },

    /**
     * 查询：多词 AND（全部词条都命中的记录才算命中），按 Σ词频排序、新近度破平，
     * 截断到 limit。只返回记录 ID——正文回冷库，索引副本不当原文。
     */
    async query(text, { limit = 20 } = {}) {
      const current = await load()
      const terms = [...new Set(tokenizeForLexicalIndex(text))]
      if (terms.length === 0) return []
      let candidates = null
      for (const term of terms) {
        const posting = current.postings.get(term)
        if (!posting || posting.d.length === 0) return []
        const docs = new Set(posting.d)
        candidates = candidates === null ? docs : new Set([...candidates].filter((id) => docs.has(id)))
        if (candidates.size === 0) return []
      }
      const scores = new Map([...candidates].map((id) => [id, 0]))
      for (const term of terms) {
        const posting = current.postings.get(term)
        for (let i = 0; i < posting.d.length; i += 1) {
          if (!scores.has(posting.d[i])) continue
          scores.set(posting.d[i], (scores.get(posting.d[i]) ?? 0) + posting.f[i])
        }
      }
      const ranked = [...scores.entries()].sort((a, b) => {
        if (b[1] !== a[1]) return b[1] - a[1]
        const seqA = current.docs.get(a[0])?.seq ?? 0
        const seqB = current.docs.get(b[0])?.seq ?? 0
        return seqB - seqA
      })
      return ranked.slice(0, Math.max(1, limit)).map(([id]) => id)
    },

    /** 本后端无进程、无外部连接：就绪恒真（装配期选择不依赖它）。 */
    async ping() {
      return true
    },

    /** 无需刷新：每次 index 后已原子落盘。保留挂点与契约对齐。 */
    async dispose() {},
  }
}