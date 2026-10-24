/**
 * 读取账本（0.12.0 P0-2）：把「同键重读」变成可见的账。
 *
 * 问题：真实会话 303 步里同键重读 55 次（占读入 42.4%），插件**完全看不见**——
 * 成本账本里只有一个 `evidenceReReads`，它统计的是「按 ID 回读」，与「重读同一个
 * 文件区间」混在一起，于是插件以为自己「回读 0 次」。
 *
 * 本模块只做记账，**不拦截、不改写工具行为**（见方案第 5 节「不做」）：
 * - 归档一条含 read/grep 结果的操作时登记它的键 `<path>|<offset>`；
 * - 同一个键再次被归档时计一次重读，回执/卡片可以据此标「该区间已于 seq N 归档」；
 * - 键只记路径与偏移，**不记正文**（正文在冷库，这里再存一份等于撤销归档）。
 *
 * 失败语义（I1）：账本损坏时**失败关闭**——返回 ok:false 并拒绝写入，绝不静默
 * 重建为空。空账本会被读成「没有重读」，那是我们无权断言的事实。
 *
 * 生命周期：账本在 `restore` 后失效（原文已回活动面，再记「已归档」就是谎报）；
 * 进程重启**不清零**（与 `runtime.mjs` 的 `lastAction` 既有口径一致）。
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { withWriteLock } from './write-lock.mjs'
import { writeFileAtomic } from './appendable-ledger.mjs'

export const READ_LEDGER_FILE = 'read-ledger.json'
export const READ_LEDGER_KIND = 'dsh-memory-context-lab/v2/read-ledger'
/**
 * 账本格式版本。2 起键是 JSON 数组（见 `readKeyOf`）。
 *
 * 旧版本（1）的键用 `|` 拼接，而 pattern/path 都可能含 `|`：
 * `grep(pattern="TODO|FIXME", path="src/a.mjs")` 与
 * `grep(pattern="TODO", path="FIXME|src/a.mjs")` 会得到同一个键（0.13.2 D-14），
 * 于是「假重读」被记进成本账本，回执还会谎报「该区间已于 seq N 归档」，
 * 回读指向别的区间。v1 账本一律按 schema 不符失败关闭（不静默重建为空）。
 */
export const READ_LEDGER_VERSION = 2
/** 单会话上限：只记键不记正文，4,000 条足够覆盖长会话，超出按 lastReadStep 淘汰。 */
export const READ_LEDGER_MAX_ENTRIES = 4000

/**
 * 会产出「可重读区间」的工具。
 *
 * 只收文件读取类：`read`（path|offset）、`grep`/`glob`（工具名|模式|路径）。
 * 不把 `pwsh` 之类算进来——同一命令跑两次往往是要看新的输出，不是重读旧内容。
 */
export const READ_KEY_TOOLS = Object.freeze(['read', 'grep', 'glob', 'list', 'list_dir', 'ls'])

function parseArgs(raw) {
  if (raw && typeof raw === 'object') return raw
  if (typeof raw !== 'string' || raw.trim() === '') return null
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function stringOf(value) {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

/**
 * 一次工具调用的「读取键」；不是读取类工具时返回 null。
 *
 * 键一律是 **JSON 数组**（`read` 为 `[tool, path, offset]`，其余为
 * `[tool, pattern, where]`），不做字符串拼接：分隔符拼接在字段本身含分隔符时会
 * 撞键（0.13.2 D-14），JSON 编码让每个字段的边界无歧义。
 *
 * 路径只保留原样字符串，不做规范化——规范化会把两个真实不同的路径合成一个键，
 * 那是在编造重读。
 */
export function readKeyOf(toolName, rawArguments) {
  const name = typeof toolName === 'string' ? toolName.trim().toLowerCase() : ''
  if (!READ_KEY_TOOLS.includes(name)) return null
  const args = parseArgs(rawArguments)
  if (!args) return null
  if (name === 'read') {
    const file = stringOf(args.file_path) || stringOf(args.path) || stringOf(args.file)
    if (!file) return null
    const offset = Number.isFinite(Number(args.offset)) ? Math.max(0, Math.trunc(Number(args.offset))) : 0
    return JSON.stringify([name, file, offset])
  }
  const pattern = stringOf(args.pattern) || stringOf(args.query) || stringOf(args.glob) || ''
  const where = stringOf(args.path) || stringOf(args.file_path) || ''
  if (!pattern && !where) return null
  return JSON.stringify([name, pattern, where])
}

export function readLedgerPath(sessionDir) {
  return path.join(sessionDir, READ_LEDGER_FILE)
}

function normalizeEntry(raw) {
  if (!raw || typeof raw !== 'object') return null
  const key = typeof raw.key === 'string' ? raw.key : ''
  if (!key) return null
  return {
    key,
    seq: Number.isInteger(raw.seq) ? raw.seq : null,
    coldRecordId: typeof raw.coldRecordId === 'string' ? raw.coldRecordId : null,
    hash: typeof raw.hash === 'string' ? raw.hash : null,
    chars: Number.isFinite(Number(raw.chars)) && Number(raw.chars) > 0 ? Math.trunc(Number(raw.chars)) : 0,
    firstSeenAt: Number.isFinite(Number(raw.firstSeenAt)) ? Math.trunc(Number(raw.firstSeenAt)) : null,
    reads: Number.isFinite(Number(raw.reads)) && Number(raw.reads) > 0 ? Math.trunc(Number(raw.reads)) : 1,
    /** 其中「内容与上次完全相同」的重读次数（口径 B 的分子）；hash 不可比时不计。 */
    unchangedReads: Number.isFinite(Number(raw.unchangedReads)) && Number(raw.unchangedReads) > 0
      ? Math.trunc(Number(raw.unchangedReads))
      : 0,
    lastReadStep: Number.isFinite(Number(raw.lastReadStep)) ? Math.trunc(Number(raw.lastReadStep)) : null,
  }
}

/**
 * 读账本。文件不存在 = 空账本（ok:true）；文件存在但不可解析/schema 不符 =
 * **失败关闭**（ok:false + error），调用方不得把它当成「没有重读」。
 */
export async function loadReadLedger(sessionDir) {
  const file = readLedgerPath(sessionDir)
  let raw
  try {
    raw = await readFile(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { ok: true, exists: false, file, entries: [], error: null }
    }
    return { ok: false, exists: true, file, entries: [], error: '账本不可读：' + (error?.message ?? String(error)) }
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return { ok: false, exists: true, file, entries: [], error: '账本不是合法 JSON：' + (error?.message ?? String(error)) }
  }
  if (!parsed || parsed.kind !== READ_LEDGER_KIND || parsed.version !== READ_LEDGER_VERSION
    || !Array.isArray(parsed.entries)) {
    return { ok: false, exists: true, file, entries: [], error: '账本 schema 不符（kind/version/entries）' }
  }
  const normalized = parsed.entries.map(normalizeEntry)
  const entries = normalized.filter((entry) => entry !== null)
  // 失败关闭（0.12.0 P0-2，蜂巢复审 F1）：**部分或全部条目不可解析也是损坏**。
  // 此前把坏条目 filter 掉后照样返回 ok:true，下一次 registerReads 就会用残缺账本
  // 覆盖原文件——原坏条目被静默丢弃，正是「不静默重建为空」要禁止的行为。
  if (entries.length !== normalized.length) {
    const bad = normalized.length - entries.length
    return {
      ok: false,
      exists: true,
      file,
      entries: [],
      error: '账本有 ' + bad + ' 条条目不可解析（共 ' + normalized.length + ' 条）；按损坏处理，不覆盖原文件',
    }
  }
  return { ok: true, exists: true, file, entries, error: null }
}

/**
 * 落盘读取账本。
 *
 * 临时名必须唯一：此前用 `file + '.' + process.pid + '.tmp'`——同进程的并发写者
 * **共享同一个临时名**，后写者把先写者正在写的临时文件截断，rename 之后账本只剩
 * 后一个写者的条目（store/p-15 X36：3 路并发登记，最终只剩 1 条，静默丢 2 条）。
 * 现在统一走 appendable-ledger.mjs 的 writeFileAtomic（randomUUID）。
 *
 * 但**唯一临时名只解决「不互相截断」**：读-改-写本身仍然要串行，否则两个写者
 * 各自读到同一份旧账本、各自写回自己那份，后写者覆盖先写者——所以调用方
 * 必须整段持写锁（见 registerReads / invalidateReadLedger）。
 */
async function writeLedger(file, entries) {
  const payload = JSON.stringify({ kind: READ_LEDGER_KIND, version: READ_LEDGER_VERSION, entries }, null, 0) + '\n'
  await writeFileAtomic(file, payload)
}

/**
 * 登记一批已归档的读取。
 *
 * 返回 `{ ok, registered, repeats, repeatChars, entries }`：
 * - 新键登记为 1 次读取；
 * - 已存在的键 reads+1，并如实报 `repeats` / `repeatChars`（本次重读的字符数）；
 * - 账本损坏时 `ok:false` 且**不写盘**（失败关闭，不静默重建为空）。
 */
export async function registerReads(sessionDir, { reads = [], step = null, now = Date.now() } = {}) {
  const wanted = (Array.isArray(reads) ? reads : [])
    .filter((read) => read && typeof read.key === 'string' && read.key !== '')
  if (wanted.length === 0) return { ok: true, registered: 0, repeats: 0, repeatChars: 0, entries: [] }
  // 读-改-写整段进锁：否则并发登记各自基于同一份旧账本写回，后写者覆盖先写者
  // （store/p-15 X36）。锁只覆盖本模块的读改写，不涉及冷库写路径。
  return withWriteLock(sessionDir, () => registerReadsUnlocked(sessionDir, { wanted, step, now }))
}

async function registerReadsUnlocked(sessionDir, { wanted, step, now }) {
  const ledger = await loadReadLedger(sessionDir)
  if (!ledger.ok) return { ok: false, registered: 0, repeats: 0, repeatChars: 0, entries: [], error: ledger.error }
  const byKey = new Map(ledger.entries.map((entry) => [entry.key, entry]))
  let registered = 0
  let repeats = 0
  let repeatChars = 0
  const touched = []
  for (const read of wanted) {
    const existing = byKey.get(read.key)
    if (existing) {
      existing.reads += 1
      // 口径 B 只认「内容完全未变」：两次都有 hash 且相等才算，缺 hash 时不计——
      // 猜一个「大概没变」会把合法复读记成浪费。
      const sameHash = typeof read.hash === 'string' && read.hash !== ''
        && typeof existing.hash === 'string' && existing.hash !== '' && read.hash === existing.hash
      if (sameHash) existing.unchangedReads = (existing.unchangedReads ?? 0) + 1
      existing.lastReadStep = Number.isInteger(step) ? step : existing.lastReadStep
      // 冷记录指针与 hash 以**最近一次**归档为准：模型下次按它回读要拿到最新那份。
      if (typeof read.coldRecordId === 'string' && read.coldRecordId) existing.coldRecordId = read.coldRecordId
      if (typeof read.hash === 'string' && read.hash) existing.hash = read.hash
      if (Number(read.chars) > 0) existing.chars = Math.trunc(Number(read.chars))
      repeats += 1
      repeatChars += Number(read.chars) > 0 ? Math.trunc(Number(read.chars)) : 0
      touched.push({ ...existing, repeat: true })
    } else {
      const entry = normalizeEntry({
        key: read.key,
        seq: read.seq,
        coldRecordId: read.coldRecordId,
        hash: read.hash,
        chars: read.chars,
        firstSeenAt: now,
        reads: 1,
        lastReadStep: step,
      })
      if (!entry) continue
      byKey.set(entry.key, entry)
      registered += 1
      touched.push({ ...entry, repeat: false })
    }
  }
  // 有界：超出上限按 lastReadStep 升序淘汰（null 视为最旧），保持确定性。
  let entries = [...byKey.values()]
  if (entries.length > READ_LEDGER_MAX_ENTRIES) {
    entries = entries
      .sort((a, b) => (a.lastReadStep ?? -1) - (b.lastReadStep ?? -1))
      .slice(entries.length - READ_LEDGER_MAX_ENTRIES)
  }
  await writeLedger(ledger.file, entries)
  return { ok: true, registered, repeats, repeatChars, entries: touched }
}

/**
 * restore 后让账本失效：被恢复的记录已回活动面，再标「已于 seq N 归档」就是谎报。
 * 只删命中条目，其余保留（其它区间仍在冷库）。
 */
export async function invalidateReadLedger(sessionDir, { recordIds = [], nodeIds = [], seqs = [] } = {}) {
  return withWriteLock(sessionDir, () => invalidateReadLedgerUnlocked(sessionDir, { recordIds, nodeIds, seqs }))
}

async function invalidateReadLedgerUnlocked(sessionDir, { recordIds = [], nodeIds = [], seqs = [] } = {}) {
  const ledger = await loadReadLedger(sessionDir)
  if (!ledger.ok) return { ok: false, removed: 0, error: ledger.error }
  const ids = new Set((Array.isArray(recordIds) ? recordIds : []).filter((id) => typeof id === 'string' && id))
  const nodes = new Set((Array.isArray(nodeIds) ? nodeIds : []).filter((id) => typeof id === 'string' && id))
  const wantedSeqs = new Set((Array.isArray(seqs) ? seqs : []).filter((seq) => Number.isInteger(seq)))
  if (ids.size === 0 && nodes.size === 0 && wantedSeqs.size === 0) return { ok: true, removed: 0, error: null }
  const kept = ledger.entries.filter((entry) => {
    if (entry.coldRecordId && (ids.has(entry.coldRecordId) || nodes.has(entry.coldRecordId))) return false
    if (Number.isInteger(entry.seq) && wantedSeqs.has(entry.seq)) return false
    return true
  })
  const removed = ledger.entries.length - kept.length
  if (removed > 0) await writeLedger(ledger.file, kept)
  return { ok: true, removed, error: null }
}

/**
 * 账本摘要。两个口径分开报，绝不混用（方案 P0-2）：
 * - 口径 A = 重读字符 / 全部内容字符（同一区间被重复读，含文件已变的复读）；
 * - 口径 B = 内容完全未变的重读 / 全部内容字符（hash 与上次相同的重读）。
 *
 * 两个数都只是**本账本能看见的部分**：账本从 0.12.0 起才存在，历史重读不在里面。
 */
export function summarizeReadLedger(ledger, { totalChars = 0 } = {}) {
  const entries = Array.isArray(ledger?.entries) ? ledger.entries : []
  let reads = 0
  let repeats = 0
  let repeatChars = 0
  let unchangedRepeatChars = 0
  for (const entry of entries) {
    reads += Number(entry.reads ?? 1)
    const extra = Math.max(0, Number(entry.reads ?? 1) - 1)
    if (extra > 0) {
      repeats += extra
      repeatChars += extra * Number(entry.chars ?? 0)
      unchangedRepeatChars += Number(entry.unchangedReads ?? 0) * Number(entry.chars ?? 0)
    }
  }
  const total = Number(totalChars) > 0 ? Number(totalChars) : 0
  const ratioOf = (chars) => (total > 0 ? chars / total : null)
  return {
    keys: entries.length,
    reads,
    repeats,
    repeatChars,
    unchangedRepeatChars,
    ratioA: ratioOf(repeatChars),
    ratioB: ratioOf(unchangedRepeatChars),
    totalChars: total,
  }
}
