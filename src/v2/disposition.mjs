/**
 * 软遗忘处置账本（disposition sidecar，P2）。
 *
 * 「遗忘」不改写任何已提交数据：冷库记录、事务文件、隔离灵枢数据与活动面
 * 事件全部保持原样，可见性只由本模块的 append-only 账本
 * `disposition.jsonl` 决定。账本条目两类：
 *
 * - `disposition/forget`：给一组记录 ID 加一个 cause（操作 id）。
 * - `disposition/undo`：移除一个 cause；仍有其余 cause 的记录保持遗忘。
 *
 * 读面（recall/read/history/working-set/card/自动回注）统一按
 * `getForgetIndex` 过滤；写命令在账本损坏时失败关闭（拒绝 forget/undo/
 * status），读面带着告警继续用已解析前缀过滤——与 verification.mjs 同款
 * 「失败关闭、读侧告警」的口径。
 *
 * 崩溃安全（计划 §3 注入点①⑥）：
 * - 半行（无换行结尾）：按截断修复，物理截掉并记账 `repairedBytes`；
 * - 提交边界：forget/undo 都带 revision CAS，过期即拒绝并要求重新 preview；
 * - 全部写入都是追加（append）或原子替换（plan 文件），绝不原地改写。
 */

import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { withWriteLock } from './write-lock.mjs'
import { isAbsent } from './fail-closed.mjs'
import { parseAppendableLedger } from './appendable-ledger.mjs'
import { canonicalJson, canonicalLine, createAppendableLedger, writeFileAtomic } from './appendable-ledger.mjs'

// 规范序列化的唯一实现在 appendable-ledger.mjs（三份账本共用）。这里重新导出，
// 是因为 hierarchy-store / agg-voucher 历史上从这里 import —— 保留出口不制造
// 「同一个函数有两个来源」的漂移机会。
export { canonicalJson, canonicalLine }

import { applyRecordToPairingLedger, compareRecordIds, openCallsOf, parseRecordId, RECORD_KINDS } from './records.mjs'
import { dependentsOf, foldProvenance, loadProvenance, propagateInvalidations } from './provenance-index.mjs'

export const DISPOSITION_FILE = 'disposition.jsonl'
export const FORGET_PLANS_FILE = 'forget-plans.json'
export const DISPOSITION_HEADER_KIND = 'dsh-memory-context-lab/v2/disposition'
export const DISPOSITION_SCHEMA_VERSION = 1

export const DISPOSITION_ENTRY_FORGET = 'disposition/forget'
export const DISPOSITION_ENTRY_UNDO = 'disposition/undo'

const DISPOSITION_LEDGER_SCHEMA = Object.freeze({
  ledgerName: 'disposition',
  headerKind: DISPOSITION_HEADER_KIND,
  schemaVersion: DISPOSITION_SCHEMA_VERSION,
  entryKinds: Object.freeze([DISPOSITION_ENTRY_FORGET, DISPOSITION_ENTRY_UNDO]),
})
/** 计划文件最多保留条数：两段式宽条件的重放窗口，超限丢最旧。 */
export const FORGET_PLAN_LIMIT = 32

export class DispositionError extends Error {
  constructor(message, { code = 'EDISPOSITION', ...details } = {}) {
    super(message)
    this.name = 'DispositionError'
    this.code = code
    for (const [key, value] of Object.entries(details)) this[key] = value
  }
}

// ---------------------------------------------------------------- 基础工具

export function dispositionPath(sessionDir) {
  return path.join(sessionDir, DISPOSITION_FILE)
}

export function forgetPlansPath(sessionDir) {
  return path.join(sessionDir, FORGET_PLANS_FILE)
}

/**
 * 冷节点 id 的单元基：`<base>_pN` 分块形式去掉块号后缀。v2 基名
 * （`mcl2-<key>-<序号>`）本身不含 `_p` 尾缀，剥离只对分块 id 生效。
 */
export function nodeUnitBase(nodeId) {
  if (typeof nodeId !== 'string') return null
  const match = nodeId.match(/^(.+)_p\d+$/)
  return match ? match[1] : nodeId
}

function nowIso() {
  return new Date().toISOString()
}

function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

// ---------------------------------------------------------------- 账本读取

// 读侧协议只有一份实现（appendable-ledger.mjs 的 parseAppendableLedger）。
// 本文件只声明自己的 schema：header 的 kind/schemaVersion 与条目 kind 白名单。
// 新增账本请照此绑定，不要在这里再写一遍 split/partialLine/header 校验——
// provenance 当年少抄一段 D-01，就是因为「读侧」被抄了三遍（L-1）。
function parseLedgerText(text) {
  return parseAppendableLedger(text, DISPOSITION_LEDGER_SCHEMA)
}

/**
 * disposition 账本的句柄（0.13.2-beta.6 G1）。
 *
 * 「建 header / 补末尾 LF / 截半行 / 锁内重读 / 追加 + fsync」这一整段协议
 * 只在 `appendable-ledger.mjs` 里实现一次。本文件只提供两样本账本特有的东西：
 * 首行 header 的内容、以及「一行长什么样」（`parseLedgerText`）。
 *
 * 收口前这里的问题：`ensureLedgerHeader` 只在 `readFile` 抛 ENOENT 时写 header，
 * 而 0 字节文件 `readFile` 是成功的——于是「文件存在但空」的账本永远没有 header，
 * 第一条条目成为第 1 行，下次解析判「首行不是 header」→ 整本作废、已遗忘的
 * 记录全部重新可见。同一个缺陷在 hierarchy-store 里逐字重复了一遍。
 */
/** 按会话目录取（或新建）本账本的句柄。 */
function ledgerFor(sessionDir) {
  return createAppendableLedger({
    file: dispositionPath(sessionDir),
    sessionDir,
    header: { kind: DISPOSITION_HEADER_KIND, schemaVersion: DISPOSITION_SCHEMA_VERSION },
    parse: parseLedgerText,
  })
}

/**
 * 读取账本。返回值不抛错（除 I/O 异常）：
 * - `state: 'absent'`：尚无账本（全新会话）。
 * - `state: 'ok' | 'damaged'`：`entries` 为已解析前缀；`repairedBytes`
 *   记录本次截断掉的半行字节数（只对能修复的情况物理截断）。
 *
 * 损坏语义：中部损坏（JSON 解析失败 / header 非法）→ `damaged: true`，
 * 条目停在前缀；调用方按「写侧拒绝、读侧告警」处理。尾部半行 → 截断修复，
 * 不算损坏，只记 `repairedBytes`。
 */
export async function loadDisposition(sessionDir) {
  // 崩溃注入点①：半行截断修复——只保留完整行，被截掉的字节数如实上报。
  // 只有**解析失败**的尾巴会走修复路径（见 parseLedgerText）；修复在写锁内重读后
  // 再截断，避免「读到的旧内容」把并发追加的新条目一起截掉。修复失败不阻断读取：
  // 读面仍按已解析前缀返回，下一次可写打开再修。协议本体在 appendable-ledger.mjs。
  const ledger = await ledgerFor(sessionDir).load()
  return {
    // BUG-013：损坏优先于 absent。首行坏 JSON 时 entries=[]、header=null，
    // 先判 absent 会把「账本损坏」报成「全新会话」（旁路 damaged 字段才看得到）。
    state: ledger.state,
    entries: ledger.entries,
    revision: ledger.entries.length,
    damaged: ledger.damaged,
    damageDetail: ledger.damageDetail,
    repairedBytes: ledger.repairedBytes,
  }
}

function assertWritable(ledger, action) {
  if (ledger.damaged) {
    throw new DispositionError(
      `disposition 账本损坏（${ledger.damageDetail?.line ? '第 ' + ledger.damageDetail.line + ' 行' : '未知位置'}：${ledger.damageDetail?.message ?? ''}），${action} 已拒绝；请人工核查 ${DISPOSITION_FILE}`,
      { code: 'EDISPOSITIONDAMAGED' },
    )
  }
}

// ---------------------------------------------------------------- 折叠可见性

/**
 * 纯函数：把条目流折叠成「记录 ID → 活跃 cause 集」。undo 只移除自己的
 * cause；多 cause 记录在移除一个后仍保持遗忘。
 */
export function foldVisibility(entries) {
  const byId = new Map()
  const forgetOps = new Map()
  for (const entry of entries) {
    if (entry?.kind === DISPOSITION_ENTRY_FORGET) forgetOps.set(entry.operationId, entry)
  }
  for (const entry of entries) {
    if (entry?.kind === DISPOSITION_ENTRY_FORGET) {
      for (const id of entry.targetIds ?? []) {
        const slot = byId.get(id) ?? { causes: [], forgottenAt: entry.at, reasons: [] }
        if (!slot.causes.includes(entry.operationId)) {
          slot.causes.push(entry.operationId)
          slot.reasons.push(entry.reason ?? '')
        }
        byId.set(id, slot)
      }
    } else if (entry?.kind === DISPOSITION_ENTRY_UNDO) {
      // undo 移除的是 cause 本身：凡持有该 cause 的记录（含多 cause 的
      // keptIds 成员）都要摘除；只剩零 cause 的记录恢复可见。这里取
      // restoredIds ∪ keptIds ∪ 原 forget 目标 的并集，兼容旧式只写
      // restoredIds 的条目。
      const origin = forgetOps.get(entry.undoOf)?.targetIds ?? []
      const targetIds = [...new Set([...(entry.restoredIds ?? []), ...(entry.keptIds ?? []), ...origin])]
      for (const id of targetIds) {
        const slot = byId.get(id)
        if (!slot) continue
        slot.causes = slot.causes.filter((cause) => cause !== entry.undoOf)
        slot.reasons = slot.causes.map((cause) => forgetOps.get(cause)?.reason ?? '')
        if (slot.causes.length === 0) byId.delete(id)
      }
    }
  }
  return byId
}

// ---------------------------------------------------------------- 进程内索引

const forgetIndexCache = new Map()

function cacheKey(sessionDir) {
  return path.resolve(sessionDir)
}

async function refreshForgetIndex(sessionDir) {
  const file = dispositionPath(sessionDir)
  let size = -1
  let mtimeMs = 0
  try {
    const info = await stat(file)
    size = info.size
    mtimeMs = info.mtimeMs
  } catch (error) {
    // Y-01（beta.7 B 组）：**「读不到」不是「没有」**。
    //
    // 旧实现在这里 catch 一切并返回 absent:true —— 于是 EACCES / EMFILE / ELOOP /
    // EIO 与「全新会话没有账本」得到同一个结论：遗忘索引为空。读面据此判定
    // 「没有任何记录被遗忘」，**已遗忘的记录重新可见、被索引、被回注**——
    // 这是隐私回退，不是可用性问题。
    //
    // 只有 ENOENT/ENOTDIR 才是真的没有账本；其余一律失败关闭：damaged:true +
    // damageDetail，让读面按「无法判定遗忘状态」拒绝，而不是放行。
    if (isAbsent(error)) {
      return { revision: 0, forgotten: new Map(), damaged: false, absent: true, size: -1, mtimeMs: 0, repairedBytes: 0 }
    }
    return {
      revision: 0,
      forgotten: new Map(),
      damaged: true,
      damageDetail: {
        line: 0,
        message: `遗忘账本无法读取（${error?.code ?? 'unknown'}：${error instanceof Error ? error.message : String(error)}）——不是「没有账本」`,
      },
      absent: false,
      size: -1,
      mtimeMs: 0,
      repairedBytes: 0,
      entries: [],
      unreadable: true,
    }
  }
  const ledger = await loadDisposition(sessionDir)
  return {
    revision: ledger.revision,
    forgotten: foldVisibility(ledger.entries),
    damaged: ledger.damaged,
    damageDetail: ledger.damageDetail ?? null,
    absent: ledger.state === 'absent',
    size,
    mtimeMs,
    repairedBytes: ledger.repairedBytes,
    entries: ledger.entries,
  }
}

/**
 * 读面共用的遗忘索引（带缓存）。缓存按 (size, mtimeMs) 失效；forget/undo
 * 提交后由调用方 `invalidateForgetIndex` 立即失效。返回的 `forgotten` 是
 * `Map<recordId, { causes, reasons }>`；`isForgotten(id)` 是便捷判定。
 */
export async function getForgetIndex(sessionDir) {
  const key = cacheKey(sessionDir)
  // 同 Y-01：这里只用于缓存键（size/mtime），读不到时键退化为 -1/0 是可以的
  // （下次一定重算），但**不能**因此让上层以为账本不存在——是否 absent 由
  // refreshForgetIndex 判定，它区分 ENOENT 与其余 errno。
  let info = await stat(dispositionPath(sessionDir)).catch(() => null)
  const size = info?.size ?? -1
  const mtimeMs = info?.mtimeMs ?? 0
  const cached = forgetIndexCache.get(key)
  if (cached && cached.size === size && cached.mtimeMs === mtimeMs) return cached
  const fresh = await refreshForgetIndex(sessionDir)
  // 「读不到」不进缓存：否则一次 EMFILE/ELOOP 会被 (size:-1, mtimeMs:0) 这个键
  // 长期钉住，直到账本尺寸恰好变化才重算——那等于把瞬时 IO 故障升级成永久遗忘失效。
  if (!fresh.unreadable) forgetIndexCache.set(key, fresh)
  return fresh
}

/**
 * 读面统一入口：遗忘索引 + **失败关闭**。
 *
 * 这是 Y-01 的结构性收口。旧形态是每个读面各自 `await getForgetIndex(...)`
 * 然后 `isForgotten(index, id)`——索引损坏/读不到时 `forgotten` 是空表，
 * 于是「已遗忘」被判成「未遗忘」，记录重新可见。逐个调用点加判断是调用点修补：
 * 下一个读面照样会忘。
 *
 * 现在分两个函数，语义按**用途**分开（这是唯一的判据分流点）：
 * - `getForgetIndexOrThrow`：**会返回正文/结果**的读面用。损坏或读不到一律抛
 *   `EDISPOSITIONDAMAGED`（失败关闭：宁可不给，也不把遗忘的记录还回去）。
 * - `getForgetIndexForStatus`：**只读状态面**用。返回索引并带 `damaged`/`unreadable`，
 *   由渲染层如实写「无法判定」，不得渲染成「无」。
 */
export async function getForgetIndexOrThrow(sessionDir, { what = '读取遗忘账本' } = {}) {
  const index = await getForgetIndex(sessionDir)
  if (index.damaged || index.unreadable) {
    throw new DispositionError(
      `${what}失败：遗忘账本${index.unreadable ? '不可读' : '已损坏'}（${index.damageDetail?.message ?? '未知原因'}）。`
      + '无法判定哪些记录已被遗忘，按失败关闭拒绝读取——这不等于「没有记录被遗忘」。',
      { code: 'EDISPOSITIONDAMAGED', details: { damageDetail: index.damageDetail ?? null } },
    )
  }
  return index
}

export function invalidateForgetIndex(sessionDir) {
  forgetIndexCache.delete(cacheKey(sessionDir))
}

export function resetForgetIndexCache() {
  forgetIndexCache.clear()
}

export function isForgotten(index, recordId) {
  return index?.forgotten?.has(recordId) === true
}

// ---------------------------------------------------------------- 追加条目

function nextOperationId(entries, prefix) {
  let max = 0
  for (const entry of entries) {
    const match = /^(f|u)(\d{6})$/.exec(entry?.operationId ?? '')
    if (match && match[1] === prefix) max = Math.max(max, Number(match[2]))
  }
  return prefix + String(max + 1).padStart(6, '0')
}

function validateEntryShape(entry) {
  const problems = []
  if (typeof entry.operationId !== 'string' || !/^[fu]\d{6}$/.test(entry.operationId)) problems.push('operationId 非法')
  if (typeof entry.at !== 'string' || Number.isNaN(Date.parse(entry.at))) problems.push('at 非法')
  if (typeof entry.actor !== 'string') problems.push('actor 非法')
  if (typeof entry.reason !== 'string') problems.push('reason 非法')
  if (!Array.isArray(entry.targetIds) || entry.targetIds.some((id) => typeof id !== 'string')) problems.push('targetIds 非法')
  return problems
}

/**
 * 追加一条 disposition 条目（崩溃注入点⑥）。
 *
 * 「先整理账本再追加」这件事现在由 `appendable-ledger.mjs` 的 `appendLines` 做：
 * 锁内重读 → 0 字节补 header → 截坏尾巴 → 末尾补 LF → 追加 + fsync。
 * 可见性账本必须先于表面墓碑持久化：这行丢了，已遗忘的记录会在重启后重新可见
 * （隐私回退），所以它与冷库载荷同口径付一次 fsync，不跟派生缓存合并。
 */
async function appendEntry(sessionDir, entry) {
  return withWriteLock(sessionDir, () => appendEntryUnlocked(sessionDir, entry))
}

async function appendEntryUnlocked(sessionDir, entry) {
  const problems = validateEntryShape(entry)
  if (problems.length) throw new DispositionError(`disposition 条目非法：${problems.join('；')}`, { code: 'EINVAL' })
  await ledgerFor(sessionDir).appendLines([entry])
  invalidateForgetIndex(sessionDir)
}

/**
 * 提交一次 forget。revision CAS：`expectedRevision` 是 preview 时读到的
 * revision，不一致即拒绝（EREVISION），要求重新 preview。
 *
 * 幂等：目标里已经带活跃 cause 的记录不算「新增」，只对零 cause 记录写
 * 条目；全部已遗忘时不追加任何条目，返回 `alreadyForgotten`。多 cause
 * 状态不由本命令产生（记录级幂等），但折叠与 undo 对它保持兼容：外部
 * 合并账本（如 P3 批量通道）带来的多 cause 记录按同一语义处理。
 */
export async function applyForget(options) {
  return withWriteLock(options.sessionDir, () => applyForgetUnlocked(options))
}

/**
 * P0-1（beta.9）遗忘传播：以本次实际生效的显式目标为种子，沿来源图做有界 BFS，
 * 找出「依赖它们」的记录级派生物（fork 摘要等）。
 *
 * 失败关闭口径（与 Y-01 同款）：来源图缺席 → state 'absent'；损坏或读不到 →
 * state 'damaged'——两种情况都**只忘显式目标**，不把「算不出级联」冒充成
 * 「没有级联」，由调用方在回执里如实披露未传播。
 *
 * 并入选择（二选一已定，不选逐个 invalidateProvenance 的理由）：
 * ① undo 按 operationId 摘 cause——并入同一条 forget 条目，一次 undo 就能还原
 *   全部级联；传播另记第二个 operationId 会打破「撤销用 undo <op>」的回执承诺；
 * ② 检索命中闸门（searchRecords 的 push）与索引同步差集只读 forgetIndex，
 *   逐个失效只写 provenance 账本、不过闸门——还得给每个读面再加一条 provenance
 *   失效表的读路径；
 * ③ 并入后回执「新增 N 条」即真实级联总量，不产生双条目的状态行噪音。
 *
 * 非记录级派生 id（index-doc:/surface: 前缀的检索文档与表面回执）不进可见性
 * 账本：它们的可见性由源记录决定（索引同步差集清除 + 命中侧闸门按记录 id 拦），
 * 用调用方注入的 knownRecordIds（store 全量记录 id 集）把它们挡在外面。
 * 返回值始终携带 state 与截断标记，调用方据此披露；knownRecordIds 未提供时返回
 * null（传播跳过，行为与 beta.8 一致——生产调用点 forgetCommand 恒传入）。
 */
async function forgetPropagationOf(sessionDir, seeds, knownRecordIds) {
  if (!Array.isArray(seeds) || seeds.length === 0 || !(knownRecordIds instanceof Set)) return null
  try {
    const loaded = await loadProvenance(sessionDir)
    if (loaded.state === 'absent') {
      return { state: 'absent', affected: [], recordIds: [], truncated: false, layers: 0 }
    }
    if (loaded.state !== 'ok') {
      return { state: 'damaged', affected: [], recordIds: [], truncated: false, layers: 0, message: loaded.damageDetail?.message ?? null }
    }
    const report = propagateInvalidations(seeds, foldProvenance(loaded.entries))
    return {
      state: 'ok',
      affected: report.affected,
      recordIds: report.affected.filter((id) => knownRecordIds.has(id)),
      truncated: report.truncated === true,
      layers: report.layers.length,
      maxNodes: report.maxNodes,
      maxDepth: report.maxDepth,
    }
  } catch (error) {
    return { state: 'damaged', affected: [], recordIds: [], truncated: false, layers: 0, message: error instanceof Error ? error.message : String(error) }
  }
}

async function applyForgetUnlocked({ sessionDir, targetIds, actor, reason, expectedRevision = null, withdrawals = [], knownRecordIds = null }) {
  const ledger = await loadDisposition(sessionDir)
  assertWritable(ledger, 'forget apply')
  if (expectedRevision !== null && ledger.revision !== expectedRevision) {
    throw new DispositionError(
      `disposition revision 已变化（期望 ${expectedRevision}，实际 ${ledger.revision}），请重新 forget preview`,
      { code: 'EREVISION' },
    )
  }
  const visibility = foldVisibility(ledger.entries)
  const unique = [...new Set(targetIds)].sort(compareRecordIds)
  const effective = unique.filter((id) => !visibility.has(id))
  const already = unique.filter((id) => visibility.has(id))
  if (effective.length === 0) {
    return { appended: false, alreadyForgotten: already, entry: null, revision: ledger.revision, propagation: null }
  }
  // P0-1：传播在本条目落账前算（同一把会话写锁内；provenance 读不加锁、互不冲突）。
  const propagation = await forgetPropagationOf(sessionDir, effective, knownRecordIds)
  const propagatedIds = (propagation?.recordIds ?? []).filter((id) => !visibility.has(id))
  const operationId = nextOperationId(ledger.entries, 'f')
  const entry = {
    kind: DISPOSITION_ENTRY_FORGET,
    operationId,
    entrySeq: ledger.entries.length + 1,
    actor: String(actor ?? 'user'),
    reason: String(reason ?? ''),
    targetIds: [...effective, ...propagatedIds].sort(compareRecordIds),
    // 传播子集单列（审计口径）：条目的 targetIds = 显式目标 ∪ propagatedIds。
    ...(propagatedIds.length > 0 ? { propagatedIds } : {}),
    undoOf: null,
    // 表面撤回快照（P2-5）：[{replacementSeq, nodeIds, receiptText}]，由 runtime
    // 在提交前从活动面读出。undo 按它逐字节还原回执；账本不解释其语义。
    ...(Array.isArray(withdrawals) && withdrawals.length
      ? { withdrawals: normalizeWithdrawals(withdrawals) }
      : {}),
    visibilityRevisionBefore: ledger.revision,
    visibilityRevisionAfter: ledger.revision + 1,
    at: nowIso(),
  }
  await appendEntry(sessionDir, entry)
  return { appended: true, alreadyForgotten: already, entry, revision: ledger.revision + 1, propagation }
}

function normalizeWithdrawals(withdrawals) {
  return withdrawals
    .filter((w) => w && Number.isInteger(w.replacementSeq))
    .map((w) => ({
      nodeIds: (Array.isArray(w.nodeIds) ? w.nodeIds : [w.nodeId]).filter((id) => typeof id === 'string' && id).sort(),
      receiptText: typeof w.receiptText === 'string' ? w.receiptText : '',
      replacementSeq: w.replacementSeq,
    }))
    .sort((a, b) => a.replacementSeq - b.replacementSeq)
}

/**
 * 撤销一次 forget。语义（计划 §5 P2-4）：
 * - 只移除该 operationId 的 cause；
 * - 仅剩这一个 cause 的记录恢复可见（`restoredIds`），写回可见回执由
 *   runtime 层完成；多 cause 记录保持遗忘（`keptIds`）并逐条给出剩余 cause；
 * - 对同一操作重复 undo、或 undo 不存在的操作 → 明确报错，不静默成功。
 */
export async function applyUndo(options) {
  return withWriteLock(options.sessionDir, () => applyUndoUnlocked(options))
}

async function applyUndoUnlocked({ sessionDir, operationId, actor, reason }) {
  const ledger = await loadDisposition(sessionDir)
  assertWritable(ledger, 'forget undo')
  const target = ledger.entries.find((entry) => entry.kind === DISPOSITION_ENTRY_FORGET && entry.operationId === operationId)
  if (!target) {
    throw new DispositionError(`forget 操作不存在：${operationId}`, { code: 'ENOOP' })
  }
  const undone = ledger.entries.find((entry) => entry.kind === DISPOSITION_ENTRY_UNDO && entry.undoOf === operationId)
  if (undone) {
    throw new DispositionError(`操作 ${operationId} 已被 ${undone.operationId} 撤销过`, { code: 'EALREADYUNDONE' })
  }
  const visibility = foldVisibility(ledger.entries)
  const restoredIds = []
  const keptIds = []
  for (const id of target.targetIds ?? []) {
    const slot = visibility.get(id)
    const causes = slot?.causes ?? []
    if (causes.includes(operationId) && causes.length === 1) restoredIds.push(id)
    else keptIds.push(id)
  }
  const entry = {
    kind: DISPOSITION_ENTRY_UNDO,
    operationId: nextOperationId(ledger.entries, 'u'),
    undoOf: operationId,
    entrySeq: ledger.entries.length + 1,
    actor: String(actor ?? 'user'),
    reason: String(reason ?? ''),
    targetIds: restoredIds,
    restoredIds,
    keptIds,
    visibilityRevisionBefore: ledger.revision,
    visibilityRevisionAfter: ledger.revision + 1,
    at: nowIso(),
  }
  await appendEntry(sessionDir, entry)
  return {
    entry,
    restoredIds,
    keptIds,
    // 被 undo 的 forget 条目自带的表面撤回快照：runtime 按它把墓碑换回原回执。
    withdrawals: Array.isArray(target.withdrawals) ? normalizeWithdrawals(target.withdrawals) : [],
    revision: ledger.revision + 1,
  }
}

// ---------------------------------------------------------------- 目标解析

/**
 * 宽条件 kind= 映射：跨度种类（SPAN_KINDS 值）与 record kind 原值都接受，
 * 统一映射到 record kind 集合。'operation' 只点到 call 记录——别名闭包
 * 随后会展开到配对结果与 span 记录，与逐字点名同一条闭包规则。
 */
const WIDE_KIND_TO_RECORD_KINDS = Object.freeze({
  'turn.user': ['turn.user'],
  'user/message': ['turn.user'],
  'assistant.text': ['assistant.text'],
  'assistant.reasoning': ['assistant.reasoning'],
  'assistant.message': ['assistant.text'],
  'tool.result': ['operation.result'],
  'tool/result': ['operation.result'],
  'operation.call': ['operation.call'],
  'call': ['operation.call'],
  'operation': ['operation.call'],
  'head.system': ['head.system'],
  'system/message': ['head.system'],
  'head.developer': ['head.developer'],
  'developer/message': ['head.developer'],
  'command.run': ['command.run'],
  'projection.span': ['projection.span'],
  'surface-replacement': ['projection.span'],
})

/**
 * 目标形态（forget preview/apply 的实参）：
 * - 记录 ID（`tXXXXXXXX-rYYYY`）：精确目标，不扩大。
 * - 冷节点 id（基名或分块名）：整单元闭包＝该单元全部分块 span 记录＋
 *   配对记录（OPERATION_CALL/OPERATION_RESULT）。
 * - `callId`：先命中配对记录，再并入其单元闭包。
 * - `kind=<spanKind>` / `before=<记录ID>`：宽条件，必须走两段式计划。
 * - v1 导入指针记录（`inline.spanKind === 'v1-archive-import'`）：按内容
 *   JSON 里的 nodeId 尽力匹配（需要 readRecord 读正文）。
 */
export async function resolveForgetTargets({ targets, entries, readRecord = null }) {
  const byId = new Map(entries.map((entry) => [entry.id, entry]))
  const byNodeId = new Map()
  const byCallId = new Map()
  const importCandidates = []
  for (const entry of entries) {
    const nodeId = entry.inline?.nodeId
    if (typeof nodeId === 'string' && nodeId.length > 0) {
      const base = nodeUnitBase(nodeId)
      if (!byNodeId.has(base)) byNodeId.set(base, new Set())
      byNodeId.get(base).add(entry.id)
    }
    const callId = entry.refs?.callId
    if (typeof callId === 'string' && callId.length > 0) {
      if (!byCallId.has(callId)) byCallId.set(callId, new Set())
      byCallId.get(callId).add(entry.id)
    }
    if (entry.inline?.spanKind === 'v1-archive-import') importCandidates.push(entry)
  }
  const byImportNodeId = new Map()
  if (readRecord) {
    for (const entry of importCandidates) {
      try {
        const result = await readRecord(entry.id)
        const body = result?.ok ? result.text ?? null : null
        if (typeof body !== 'string') continue
        const parsed = JSON.parse(body)
        if (typeof parsed?.nodeId === 'string') {
          if (!byImportNodeId.has(parsed.nodeId)) byImportNodeId.set(parsed.nodeId, new Set())
          byImportNodeId.get(parsed.nodeId).add(entry.id)
        }
      } catch {
        // v1 导入指针的内容不是合法 JSON 时按「尽力解析失败」处理：不命中别名。
      }
    }
  }
  const expansions = []
  const unknown = []
  const recordIds = new Set()
  let wide = false
  const sortedEntries = [...entries].sort((a, b) => compareRecordIds(a.id, b.id))
  for (const target of targets) {
    if (typeof target !== 'string' || target.length === 0) {
      unknown.push(target)
      continue
    }
    if (parseRecordId(target)) {
      const entry = byId.get(target)
      if (!entry) unknown.push(target)
      else recordIds.add(target)
      continue
    }
    if (target.startsWith('kind=')) {
      const spanKind = target.slice(5)
      // 宽条件按「跨度种类」表述，但账本与 store 条目按 record kind 键控；这里
      // 做显式映射（SPAN_KINDS 值 + record kind 原值都接受），operation 只需
      // 点到 call 记录——别名闭包随后会展开到配对结果与 span 记录。
      const kindMatches = WIDE_KIND_TO_RECORD_KINDS[spanKind]
      if (!kindMatches) {
        unknown.push(target)
        continue
      }
      const hits = sortedEntries.filter((entry) => kindMatches.includes(entry.kind)
        // PROJECTION_SPAN 条目按 refs.spanKind 说话（正文跨度记录的跨度种类），
        // 仓储 kind 与跨度种类是两个键控面，都得认。
        || (entry.kind === 'projection.span' && entry.refs?.spanKind === spanKind))
      if (hits.length === 0) unknown.push(target)
      else {
        wide = true
        expansions.push({ from: target, to: hits.map((entry) => entry.id), note: '宽条件：kind 匹配' })
        for (const entry of hits) recordIds.add(entry.id)
      }
      continue
    }
    if (target.startsWith('before=')) {
      const boundary = target.slice(7)
      if (!parseRecordId(boundary)) {
        unknown.push(target)
        continue
      }
      const hits = sortedEntries.filter((entry) => compareRecordIds(entry.id, boundary) < 0)
      if (hits.length === 0) unknown.push(target)
      else {
        wide = true
        expansions.push({ from: target, to: hits.map((entry) => entry.id), note: '宽条件：before 边界' })
        for (const entry of hits) recordIds.add(entry.id)
      }
      continue
    }
    // 其余一律按冷节点 id 处理：基名/分块名/callId 各自命中后并入单元闭包。
    const callHits = byCallId.get(target)
    const nodeIdHits = byNodeId.get(target) ?? byNodeId.get(nodeUnitBase(target))
    const importHits = byImportNodeId.get(target)
    const merged = new Set([...(nodeIdHits ?? []), ...(callHits ?? []), ...(importHits ?? [])])
    // callId 命中的配对记录属于某单元：把该单元整份闭包也并进来。
    for (const id of callHits ?? []) {
      const entry = byId.get(id)
      const base = nodeUnitBase(entry?.inline?.nodeId)
      if (base && byNodeId.has(base)) for (const unitId of byNodeId.get(base)) merged.add(unitId)
    }
    if (merged.size === 0) {
      unknown.push(target)
      continue
    }
    expansions.push({ from: target, to: [...merged].sort(compareRecordIds), note: '别名闭包（nodeId/callId → 单元）' })
    for (const id of merged) recordIds.add(id)
  }
  return { recordIds: [...recordIds].sort(compareRecordIds), expansions, unknown, wide }
}

// ---------------------------------------------------------------- 硬保护

/**
 * 硬保护集判定（计划 §5 P2-3）：
 * - `in-flight`：OPERATION_CALL 的 callId 仍在未闭合配对账本里——宽条件与
 *   显式一律拒绝（丢掉在途动作＝凭空出现无回执调用）。
 * - `human-user`：人类用户消息（spanKind turn.user 且非 pluginAuthored）——
 *   宽条件拒绝；显式目标允许但带警告（用户点名即显式授权）。
 *
 * `mode`：`wide`（kind=/before= 展开的结果）或 `explicit`。
 */
export function evaluateForgetProtection({ recordIds, entries, index, mode = 'explicit' }) {
  const byId = new Map(entries.map((entry) => [entry.id, entry]))
  let ledger = new Map()
  for (const entry of entries) {
    if (entry.kind === RECORD_KINDS.OPERATION_CALL || entry.kind === RECORD_KINDS.OPERATION_RESULT) {
      ledger = applyRecordToPairingLedger(ledger, { kind: entry.kind, refs: entry.refs, id: entry.id, seq: entry.seq }).ledger
    }
  }
  const openCalls = new Set(openCallsOf(ledger).map((call) => call.callId))
  const blocked = []
  const warnings = []
  for (const id of recordIds) {
    const entry = byId.get(id)
    if (!entry) continue
    if (entry.kind === RECORD_KINDS.OPERATION_CALL && openCalls.has(entry.refs?.callId)) {
      blocked.push({ id, rule: 'in-flight', detail: `在途工具调用（callId ${entry.refs?.callId}）尚未闭合` })
      continue
    }
    // BUG-002：人类消息正文同时存在于两种记录形态里——
    // ① verbatim 的 TURN_USER 记录（人类输入原文）；
    // ② 投影跨度 PROJECTION_SPAN（spanKind=turn.user）。
    // 只拦 ② 会让 `kind=turn.user` 宽条件把全部人类消息从读面抹掉。
    // 两种形态按同一规则保护；pluginAuthored 的插件卡片不算人类消息。
    if (
      entry.inline?.pluginAuthored !== true
      && (
        entry.kind === RECORD_KINDS.TURN_USER
        || (entry.kind === RECORD_KINDS.PROJECTION_SPAN && entry.refs?.spanKind === 'turn.user')
      )
    ) {
      const finding = { id, rule: 'human-user', detail: '人类用户消息' }
      if (mode === 'wide') blocked.push(finding)
      else warnings.push(finding)
    }
  }
  void index
  return { blocked, warnings, openCallIds: [...openCalls] }
}

// ---------------------------------------------------------------- 两段式计划

/**
 * 宽条件（kind=/before=）必须先 preview 后 apply：plan 存储确定性集合，
 * apply 按计划提交**确切集合**（不重新扩大查询）；revision 变化即拒绝。
 * planId = sha256(排序 targetIds + '@' + revision) 前 16 位 hex。
 */
export function computePlanId(recordIds, revision) {
  return sha256Hex([...recordIds].sort(compareRecordIds).join('\n') + '@' + revision).slice(0, 16)
}

export async function saveForgetPlan(sessionDir, plan) {
  const file = forgetPlansPath(sessionDir)
  // 读-改-写必须整段在写锁内：否则两个并发的 preview 各自读到同一份旧计划、
  // 各自写回自己那份，后写者覆盖先写者——被覆盖的那条计划就再也 apply 不了
  // （0.13.2-beta.6 G8；agg-voucher 的计划文件是同款缺陷）。
  return withWriteLock(sessionDir, async () => {
    let current = { plans: [] }
    try {
      current = JSON.parse(await readFile(file, 'utf8'))
    } catch {
      // 计划文件损坏时重建（它只是重放窗口，不是权威账本）。
    }
    if (!Array.isArray(current.plans)) current.plans = []
    const next = [...current.plans.filter((item) => item?.planId !== plan.planId), plan]
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .slice(0, FORGET_PLAN_LIMIT)
    // 临时名必须唯一：固定 `file + '.tmp'` 在并发写者之间是同一个名字。
    await writeFileAtomic(file, canonicalLine({ plans: next }) + '\n')
    return { planId: plan.planId, kept: next.length }
  })
}

export async function loadForgetPlans(sessionDir) {
  try {
    const parsed = JSON.parse(await readFile(forgetPlansPath(sessionDir), 'utf8'))
    return Array.isArray(parsed?.plans) ? parsed.plans : []
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    // 损坏时视为无计划（拒绝 apply 的口径由「找不到 planId」承担）。
    return []
  }
}

export async function getForgetPlan(sessionDir, planId) {
  const plans = await loadForgetPlans(sessionDir)
  return plans.find((plan) => plan?.planId === planId) ?? null
}

// ---------------------------------------------------------------- 预览与状态

/**
 * 账本级预览：解析目标 → 硬保护 → 分类（unknown/blocked/already/toForget），
 * 并按来源图反向边报告级联影响（cascade）；表面回执层面的级联仍由 runtime 补充。
 */
export async function buildForgetPreview({ sessionDir, targets, entries, readRecord = null }) {
  const index = await getForgetIndex(sessionDir)
  if (index.damaged) {
    throw new DispositionError(
      `disposition 账本损坏（${index.damageDetail?.message ?? ''}），forget preview 已拒绝`,
      { code: 'EDISPOSITIONDAMAGED' },
    )
  }
  const resolved = await resolveForgetTargets({ targets, entries, readRecord })
  const visibility = index.forgotten
  const protection = evaluateForgetProtection({
    recordIds: resolved.recordIds,
    entries,
    index,
    mode: resolved.wide ? 'wide' : 'explicit',
  })
  const blockedIds = new Set(protection.blocked.map((item) => item.id))
  const already = []
  const toForget = []
  for (const id of resolved.recordIds) {
    if (blockedIds.has(id)) continue
    if (visibility.has(id)) already.push({ id, causes: visibility.get(id).causes })
    else toForget.push(id)
  }
  // 计划只对「宽条件且有有效新增集合」生成；显式目标直接 apply（preview
  // 仍给出全部信息）；全被拦截或全部已遗忘时不生成空计划。
  const plan = resolved.wide && toForget.length > 0
    ? {
        planId: computePlanId(toForget, index.revision),
        targets: resolved.expansions.map((item) => item.from),
        resolvedIds: toForget,
        blockedIds: [...blockedIds],
        unknown: resolved.unknown,
        revision: index.revision,
        createdAt: nowIso(),
      }
    : null
  // P0-4（beta.9）接线 dependentsOf：以「将遗忘集合」为种子查来源图反向边，
  // preview 如实报告级联影响（apply 时这些派生记录会经遗忘传播一并入账）。
  // provenance 缺席/损坏不阻断 preview：cascade.state 如实带出，调用方披露。
  // 还原点（revert-probe forget-preview-cascade）：把 dependents 置空即断开接线。
  let cascade = null
  try {
    const provenance = await loadProvenance(sessionDir)
    if (provenance.state === 'ok') {
      const folded = foldProvenance(provenance.entries)
      // 传递闭包与 apply 侧同用 propagateInvalidations：preview 预告 == apply 行为。
      // dependentsOf 只补直接层的「经由」信息（它是单层反向边查询）。
      const report = propagateInvalidations(toForget, folded)
      const direct = new Map(dependentsOf(toForget, folded).map((item) => [item.derivedId, item]))
      // 还原点（revert-probe forget-preview-cascade）：affected 置空即断开级联预告。
      const dependents = report.affected.filter((id) => !visibility.has(id))
        .map((id) => ({ derivedId: id, derivedKind: direct.get(id)?.derivedKind ?? '', viaSources: direct.get(id)?.viaSources ?? [] }))
      cascade = { state: 'ok', dependents, truncated: report.truncated === true }
    } else {
      cascade = { state: provenance.state === 'absent' ? 'absent' : 'damaged', dependents: [] }
    }
  } catch (error) {
    cascade = { state: 'damaged', dependents: [], message: error instanceof Error ? error.message : String(error) }
  }
  return {
    revision: index.revision,
    wide: resolved.wide,
    expansions: resolved.expansions,
    unknown: resolved.unknown,
    blocked: protection.blocked,
    warnings: protection.warnings,
    already,
    toForget,
    plan,
    cascade,
    damaged: index.damaged,
    repairedBytes: index.repairedBytes,
  }
}

/** 账本级状态：操作流水 + 当前遗忘计数 + revision。 */
export async function describeForgetStatus(sessionDir) {
  const ledger = await loadDisposition(sessionDir)
  if (ledger.damaged) {
    throw new DispositionError(
      `disposition 账本损坏（${ledger.damageDetail?.message ?? ''}），forget status 已拒绝`,
      { code: 'EDISPOSITIONDAMAGED' },
    )
  }
  const visibility = foldVisibility(ledger.entries)
  const undoneOps = new Set(
    ledger.entries.filter((entry) => entry.kind === DISPOSITION_ENTRY_UNDO).map((entry) => entry.undoOf),
  )
  const operations = ledger.entries
    .filter((entry) => entry.kind === DISPOSITION_ENTRY_FORGET)
    .map((entry) => ({
      operationId: entry.operationId,
      kind: 'forget',
      reason: entry.reason ?? '',
      actor: entry.actor ?? '',
      targetCount: (entry.targetIds ?? []).length,
      at: entry.at ?? null,
      undone: undoneOps.has(entry.operationId),
    }))
  const undos = ledger.entries
    .filter((entry) => entry.kind === DISPOSITION_ENTRY_UNDO)
    .map((entry) => ({
      operationId: entry.operationId,
      kind: 'undo',
      undoOf: entry.undoOf,
      restoredCount: (entry.restoredIds ?? []).length,
      keptCount: (entry.keptIds ?? []).length,
      at: entry.at ?? null,
    }))
  return {
    state: ledger.state,
    revision: ledger.revision,
    forgottenCount: visibility.size,
    operations: [...operations, ...undos].sort((a, b) => String(a.at).localeCompare(String(b.at))),
    repairedBytes: ledger.repairedBytes,
  }
}