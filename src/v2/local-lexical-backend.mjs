/**
 * T1 本地词法检索后端 —— 纯 Node、零外部进程（设计文档 v1.2 §4/§5）。
 *
 * 定位：灵枢后端（lingshu-mdcg-receipt）不可用时的**默认**检索实现。能力自述与
 * 灵枢后端同级（lexical-structural，无向量语义）——不冒充语义召回。
 *
 * 索引结构：CJK 连续段二元组 + ASCII 词元的倒排表，按记录 ID 记账。持久化分两文件：
 * - lexical-index.json = base 快照（tmp+rename 原子写，schema 与旧单文件完全一致），
 *   只在 compaction 时写；缺失/半截 ⇒ 该层视为空（旧格式单文件是同一 schema，直接命中）；
 * - lexical-index.log = 追加式 JSONL delta，每次 index 有增量时只 append 一行，
 *   不再每次全量重写数 MB 索引（旧的 JSON.stringify 同步阻塞事件循环）。
 * 读取时 base + 日志逐行重放合并；日志里损坏/半截的行跳过，只影响该行。
 *
 * 边界（capabilities.note 原样交给状态面，不夸大）：
 * - 只做词法命中：不做语义向量、模糊匹配、拼音、跨会话；
 * - 命中只返回记录 ID，正文一律回本会话冷库读（原文权威唯一）；
 * - 词条总量有上限（默认 200k，对应常用上下文量级）：超限后停止增量并**如实报
 *   skipped**——绝不让记账把「没索引」当成「已索引」（盲区 61 的工程回应之一）。
 */
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { EngineV2Error } from './errors.mjs'

export const LOCAL_LEXICAL_BACKEND_NAME = 'local-lexical-v1'
export const LOCAL_LEXICAL_INDEX_FILE = 'lexical-index.json'
export const LOCAL_LEXICAL_INDEX_KIND = 'dsh-memory-context-lab/v2/lexical-index'
export const LOCAL_LEXICAL_SCHEMA_VERSION = 1
export const DEFAULT_LEXICAL_MAX_TERMS = 200000

// 内部常量（不新增导出面）：增量日志文件名、compaction 阈值。
const LOCAL_LEXICAL_LOG_FILE = 'lexical-index.log'
const DEFAULT_COMPACTION_LOG_BYTES = 1000000
const DEFAULT_COMPACTION_NEW_DOCS = 512

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

/**
 * 重放一行日志 delta 到内存状态。语义与 index() 的去重/合并规则一致：
 * - docs：已存在的 id 跳过（同一记录不重复记账）；
 * - postings：同一 term 跨多个 delta 出现时合并（d 追加、f 追加），绝不覆盖；只补该
 *   delta 真实新增的 id——base 已含该 id 时（compaction 写 base 与截断日志之间的崩溃
 *   窗口会重放旧行）不会把词频重复计一次；
 * - limitReached：只置真，不回滚。
 * 返回本行真实新增的 docs 数。损坏/半截行由调用方在 JSON.parse 处跳过。
 */
function applyDelta(target, delta) {
  const added = new Set()
  const docs = delta.docs
  if (docs && typeof docs === 'object') {
    for (const [id, meta] of Object.entries(docs)) {
      if (target.docs.has(id)) continue
      target.docs.set(id, meta)
      added.add(id)
    }
  }
  const postings = delta.postings
  if (added.size > 0 && postings && typeof postings === 'object') {
    for (const [term, pairs] of Object.entries(postings)) {
      if (!Array.isArray(pairs) || pairs.length === 0) continue
      let posting = target.postings.get(term)
      if (!posting) {
        posting = { d: [], f: [] }
        target.postings.set(term, posting)
      }
      for (const pair of pairs) {
        if (!Array.isArray(pair) || typeof pair[0] !== 'string' || !added.has(pair[0])) continue
        posting.d.push(pair[0])
        posting.f.push(pair[1])
      }
    }
  }
  if (delta.limitReached === true) target.limitReached = true
  return added.size
}

export function createLocalLexicalBackend({
  directory,
  logger = null,
  maxTerms = DEFAULT_LEXICAL_MAX_TERMS,
  // 可选注入（默认即规格阈值，仅调优/测试用；不改变既有导出与返回接口）。
  compactionBytes = DEFAULT_COMPACTION_LOG_BYTES,
  compactionDocs = DEFAULT_COMPACTION_NEW_DOCS,
} = {}) {
  if (typeof directory !== 'string' || directory.length === 0) {
    throw new EngineV2Error('本地词法后端需要会话目录。', { code: 'EINVAL' })
  }
  if (!Number.isInteger(maxTerms) || maxTerms <= 0) {
    throw new EngineV2Error('本地词法后端的词条上限必须是正整数。', { code: 'EINVAL' })
  }
  const compactionLogBytes = Number.isFinite(compactionBytes) && compactionBytes > 0 ? compactionBytes : DEFAULT_COMPACTION_LOG_BYTES
  const compactionNewDocs = Number.isInteger(compactionDocs) && compactionDocs > 0 ? compactionDocs : DEFAULT_COMPACTION_NEW_DOCS
  const indexFile = path.join(directory, LOCAL_LEXICAL_INDEX_FILE)
  const logFile = path.join(directory, LOCAL_LEXICAL_LOG_FILE)
  let state = null
  // 增量记账：自上次写 base 起的日志字节数与新增 docs 数（compaction 判据）、日志末尾
  // 是否为半截行（下次 append 前补一个换行，避免新行与残行粘成一行）。
  let logBytes = 0
  let docsSinceBase = 0
  let logNeedsNewline = false
  let storeInitialized = false
  let writeChain = Promise.resolve()

  /** 串行化「append 日志 / compaction」尾段：避免 append 与截断交错。 */
  function enqueue(task) {
    const next = writeChain.then(task, task)
    writeChain = next.then(() => {}, () => {})
    return next
  }

  async function load() {
    if (state) return state
    const fresh = emptyState()
    let baseExists = false
    try {
      const raw = JSON.parse(await readFile(indexFile, 'utf8'))
      if (raw && raw.kind === LOCAL_LEXICAL_INDEX_KIND && raw.schemaVersion === LOCAL_LEXICAL_SCHEMA_VERSION) {
        fresh.docs = new Map(Object.entries(raw.docs ?? {}))
        fresh.postings = new Map(Object.entries(raw.postings ?? {}).map(([term, posting]) => [term, { d: posting.d ?? [], f: posting.f ?? [] }]))
        fresh.limitReached = raw.limitReached === true
        baseExists = true
      }
    } catch {
      // base 缺失/半截：该层视为空（旧格式单文件是同一 schema，直接走上面分支，
      // 无需单独兼容路径）。base 坏了不影响日志层——两文件彼此独立。
    }
    let logText = ''
    let logExists = false
    try {
      logText = await readFile(logFile, 'utf8')
      logExists = true
    } catch {
      logText = ''
    }
    let loggedDocs = 0
    for (const line of logText.split('\n')) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      let delta = null
      try {
        delta = JSON.parse(trimmed)
      } catch {
        continue // 半截/损坏行：只丢这一行，base 与其他行照常生效
      }
      if (!delta || typeof delta !== 'object') continue
      loggedDocs += applyDelta(fresh, delta)
    }
    logBytes = Buffer.byteLength(logText, 'utf8')
    docsSinceBase = loggedDocs
    logNeedsNewline = logText.length > 0 && !logText.endsWith('\n')
    storeInitialized = baseExists || logExists
    state = fresh
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

  /** compaction：全量写 base（tmp+rename 原子写），随后原子清空日志。 */
  async function compact(current) {
    await persist(current)
    const temporary = path.join(directory, LOCAL_LEXICAL_LOG_FILE + '.tmp-' + process.pid + '-' + Date.now())
    await writeFile(temporary, '', 'utf8')
    await rename(temporary, logFile)
    logBytes = 0
    docsSinceBase = 0
    logNeedsNewline = false
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
      // 本批的增量 delta（null 原型：避免把 __proto__ 之类的词元/记录 ID 当原型赋值）。
      const deltaDocs = Object.create(null)
      const deltaPostings = Object.create(null)
      let addedDocs = 0
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
          if (!deltaPostings[term]) deltaPostings[term] = []
          deltaPostings[term].push([id, count])
        }
        const meta = { seq: record.seq ?? null, kind: record.kind ?? null, bytes: Buffer.byteLength(record.text, 'utf8') }
        current.docs.set(id, meta)
        deltaDocs[id] = meta
        externalIds[id] = id
        addedDocs += 1
      }
      if (addedDocs > 0) {
        const payload = JSON.stringify({ docs: deltaDocs, postings: deltaPostings, limitReached: current.limitReached }) + '\n'
        await enqueue(async () => {
          await mkdir(directory, { recursive: true })
          if (!storeInitialized) {
            // 首批（base 与日志都不存在）：直接建立 base 快照，不建日志。这样既保住
            // 旧有的「index 过后 lexical-index.json 必存在」语义（既有测试「崩溃/文件
            // 缺失」要求删掉 base 后查不到东西），也不留下一个空 base。
            await persist(current)
            storeInitialized = true
            return
          }
          const prefix = logNeedsNewline ? '\n' : '' // 残行结尾：先补换行，别把新行粘上去
          await appendFile(logFile, prefix + payload, 'utf8')
          logNeedsNewline = false
          logBytes += Buffer.byteLength(prefix + payload, 'utf8')
          docsSinceBase += addedDocs
          if (logBytes >= compactionLogBytes || docsSinceBase >= compactionNewDocs) await compact(current)
        })
      }
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

    /**
     * 正常停机：把日志并入 base 并清空日志（磁盘不留悬空日志），随后清空内存 state。
     * 无悬空日志时不写盘（避免无谓的全量重写），重复调用不抛。仍返回 Promise。
     */
    async dispose() {
      try {
        const current = state ?? (await load())
        await enqueue(() => (logBytes > 0 || docsSinceBase > 0 ? compact(current) : undefined))
      } finally {
        state = null
      }
    },
  }
}
