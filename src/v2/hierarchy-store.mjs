/**
 * 程序层级账本（hierarchy sidecar，P3）。
 *
 * L0 是事实真源：冷库记录（records.mjs）与活动面事件，永不因压缩消失。
 * L1/L2/L3 全部是**可替换的派生缓存**，落在本模块的 append-only 账本
 * `hierarchy.jsonl` 里：
 *
 * - `hierarchy/l1-card`：单条记录的证据卡（evidence card）缓存；
 * - `hierarchy/l2-phase`：阶段卡（一个 phaseKey 的事实要点 + 引用清单）；
 * - `hierarchy/l3-task`：任务级索引快照（引用阶段卡，不再引用正文）；
 * - `hierarchy/run`：一次压缩调度的审计行（committed / no-safe-gain /
 *   skipped-*），重复调度据此去重；
 * - `hierarchy/agg-voucher`：聚合凭证的登记行（成员 seq、替代 seq、
 *   凭证文本），expand 按它分页还原。
 *
 * 层级纪律（计划 §5 P3-7）：L2/L3 只允许引用 **L0 记录 id 或更低一层的
 * 卡片 id**，禁止「摘要再摘要」——L2 的 sourceRecordIds 里出现任何账本内
 * 已有卡片 id 即拒绝（EHIERARCHYNOSUMMARY）。同一 phaseKey 的 L2 卡可
 * 追加多条，折叠态取最新一条：这就是「摘要只是可替换派生缓存」的机械
 * 形式，重建永远从 L0 出发。
 *
 * 崩溃安全与 disposition.mjs 同款：半行截断修复（repairedBytes）、中部
 * 损坏写侧失败关闭、追加走 revision CAS（EREVISION）、canonicalLine 落盘。
 */

import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { withWriteLock } from './write-lock.mjs'

import { canonicalLine, createAppendableLedger, parseAppendableLedger } from './appendable-ledger.mjs'

export const HIERARCHY_FILE = 'hierarchy.jsonl'
export const HIERARCHY_HEADER_KIND = 'dsh-memory-context-lab/v2/hierarchy'
export const HIERARCHY_SCHEMA_VERSION = 1

export const HIERARCHY_ENTRY_L1 = 'hierarchy/l1-card'
export const HIERARCHY_ENTRY_L2 = 'hierarchy/l2-phase'
export const HIERARCHY_ENTRY_L3 = 'hierarchy/l3-task'
export const HIERARCHY_ENTRY_RUN = 'hierarchy/run'
export const HIERARCHY_ENTRY_VOUCHER = 'hierarchy/agg-voucher'

const HIERARCHY_LEDGER_SCHEMA = Object.freeze({
  ledgerName: 'hierarchy',
  headerKind: HIERARCHY_HEADER_KIND,
  schemaVersion: HIERARCHY_SCHEMA_VERSION,
  entryKinds: Object.freeze([
    HIERARCHY_ENTRY_L1, HIERARCHY_ENTRY_L2, HIERARCHY_ENTRY_L3,
    HIERARCHY_ENTRY_RUN, HIERARCHY_ENTRY_VOUCHER,
  ]),
})

/** run 审计行允许的 outcome 闭集（写侧校验，防手写账本引入新语义）。 */
export const HIERARCHY_RUN_OUTCOMES = Object.freeze(['committed', 'no-safe-gain', 'skipped-batch-empty', 'skipped-llm-unavailable', 'skipped-damaged'])

export class HierarchyStoreError extends Error {
  constructor(message, { code = 'EHIERARCHY', ...details } = {}) {
    super(message)
    this.name = 'HierarchyStoreError'
    this.code = code
    for (const [key, value] of Object.entries(details)) this[key] = value
  }
}

// ---------------------------------------------------------------- 路径与读取

export function hierarchyPath(sessionDir) {
  return path.join(sessionDir, HIERARCHY_FILE)
}

// 读侧协议只有一份实现（appendable-ledger.mjs 的 parseAppendableLedger）。
// 本文件只声明自己的 schema。L-1：provenance 当年少抄一段 D-01，就是读侧被抄了三遍。
function parseLedgerText(text) {
  return parseAppendableLedger(text, HIERARCHY_LEDGER_SCHEMA)
}

/**
 * 截掉账本尾部那条解析失败的半行（崩溃残留）。
 *
 * 必须在写锁内做：读-改-写不是原子的，而账本的并发追加者是别的进程。锁内重读一次、
 * 以锁内内容为准，才能保证「只截掉坏尾巴」而不是把别人刚追加的完整条目一起丢掉。
 * 返回被截掉的字节数。
 */
async function repairHierarchyTail(sessionDir) {
  // 协议本体在 appendable-ledger.mjs：写锁内重读 → 只截解析失败的尾巴 →
  // temp+rename 落盘（不原地 writeFile）。
  return ledgerFor(sessionDir).repairTail()
}

/**
 * 读取账本。语义与 loadDisposition 一致：absent / ok / damaged 三态，
 * 尾部半行物理截断修复（repairedBytes），中部损坏只报不修。
 */
export async function loadHierarchy(sessionDir) {
  // 崩溃注入点：半行截断修复。必须在写锁内重读后再截断——读-改-写不是原子的，
  // 而账本的并发追加者是别的进程/别的 async 分支；拿读到的旧内容去截，会把别人
  // 刚追加的完整条目一起丢掉（0.13.2-beta.2 W-01b）。修复失败不阻断读取：读面仍按
  // 已解析前缀返回，下一次可写打开再修。协议本体在 appendable-ledger.mjs。
  const ledger = await ledgerFor(sessionDir).load()
  return {
    // BUG-013：损坏优先于 absent（首行坏 JSON 时 entries=[]、header=null）。
    state: ledger.state,
    entries: ledger.entries,
    revision: ledger.entries.length,
    damaged: ledger.damaged,
    damageDetail: ledger.damageDetail,
    repairedBytes: ledger.repairedBytes,
    ...foldHierarchy(ledger.entries),
  }
}

function emptyFold() {
  return {
    cardsById: new Map(),
    l1ByRecord: new Map(),
    l2ByPhase: new Map(),
    l3Latest: null,
    vouchers: new Map(),
    runs: [],
    cardIds: new Set(),
  }
}

/**
 * 纯函数折叠：卡片按 id 收集；同一 phaseKey 的 L2 取**最后一条**（后写
 * 覆盖，旧条目仍留在账本里供审计）；L3 同理取最后一条。run 审计行按
 * 出现顺序保留。
 */
export function foldHierarchy(entries) {
  const cardsById = new Map()
  const l1ByRecord = new Map()
  const l2ByPhase = new Map()
  let l3Latest = null
  const vouchers = new Map()
  const runs = []
  for (const entry of entries ?? []) {
    switch (entry?.kind) {
      case HIERARCHY_ENTRY_L1:
        cardsById.set(entry.cardId, entry)
        l1ByRecord.set(entry.recordId, entry.cardId)
        break
      case HIERARCHY_ENTRY_L2:
        cardsById.set(entry.cardId, entry)
        l2ByPhase.set(entry.phaseKey, entry)
        break
      case HIERARCHY_ENTRY_L3:
        l3Latest = entry
        break
      case HIERARCHY_ENTRY_VOUCHER:
        vouchers.set(entry.voucherId, entry)
        break
      case HIERARCHY_ENTRY_RUN:
        runs.push(entry)
        break
      default:
        break
    }
  }
  const cardIds = new Set([...cardsById.keys()])
  return { cardsById, l1ByRecord, l2ByPhase, l3Latest, vouchers, runs, cardIds }
}

function assertWritable(ledger, action) {
  if (ledger.damaged) {
    throw new HierarchyStoreError(
      `hierarchy 账本损坏（${ledger.damageDetail?.line ? '第 ' + ledger.damageDetail.line + ' 行' : '未知位置'}：${ledger.damageDetail?.message ?? ''}），${action} 已拒绝；请人工核查 ${HIERARCHY_FILE}`,
      { code: 'EHIERARCHYDAMAGED' },
    )
  }
}

// ---------------------------------------------------------------- 条目校验

function isIso(text) {
  return typeof text === 'string' && !Number.isNaN(Date.parse(text))
}

function isIdList(value) {
  return Array.isArray(value) && value.length > 0 && value.every((id) => typeof id === 'string' && id.length > 0)
}

function validateEntryShape(entry) {
  const problems = []
  if (!isIso(entry.at)) problems.push('at 非法')
  switch (entry?.kind) {
    case HIERARCHY_ENTRY_L1:
      if (typeof entry.cardId !== 'string' || !/^l1-/.test(entry.cardId)) problems.push('cardId 非法（l1- 前缀）')
      if (typeof entry.recordId !== 'string' || !entry.recordId) problems.push('recordId 非法')
      if (typeof entry.text !== 'string' || entry.text.length === 0) problems.push('text 非法')
      if (!Number.isInteger(entry.tokens) || entry.tokens < 0) problems.push('tokens 非法')
      break
    case HIERARCHY_ENTRY_L2:
      if (typeof entry.cardId !== 'string' || !/^l2-/.test(entry.cardId)) problems.push('cardId 非法（l2- 前缀）')
      if (typeof entry.phaseKey !== 'string' || !entry.phaseKey) problems.push('phaseKey 非法')
      if (typeof entry.phaseLabel !== 'string' || !entry.phaseLabel) problems.push('phaseLabel 非法')
      if (!isIdList(entry.sourceRecordIds)) problems.push('sourceRecordIds 非法（非空 id 列表）')
      if (typeof entry.text !== 'string' || entry.text.length === 0) problems.push('text 非法')
      if (!Number.isInteger(entry.tokens) || entry.tokens < 0) problems.push('tokens 非法')
      if (!Array.isArray(entry.blocks)) problems.push('blocks 非法')
      break
    case HIERARCHY_ENTRY_L3:
      if (typeof entry.indexId !== 'string' || !/^l3-/.test(entry.indexId)) problems.push('indexId 非法（l3- 前缀）')
      if (!Array.isArray(entry.phases) || entry.phases.length === 0) problems.push('phases 非法')
      if (typeof entry.text !== 'string' || entry.text.length === 0) problems.push('text 非法')
      break
    case HIERARCHY_ENTRY_RUN:
      if (typeof entry.runId !== 'string' || !entry.runId) problems.push('runId 非法')
      if (!HIERARCHY_RUN_OUTCOMES.includes(entry.outcome)) problems.push('outcome 非法')
      if (typeof entry.phaseKey !== 'string' || !entry.phaseKey) problems.push('phaseKey 非法')
      if (!Number.isInteger(entry.sourceRevision) || entry.sourceRevision < 0) problems.push('sourceRevision 非法')
      break
    case HIERARCHY_ENTRY_VOUCHER:
      if (typeof entry.voucherId !== 'string' || !/^agg-/.test(entry.voucherId)) problems.push('voucherId 非法（agg- 前缀）')
      if (!Array.isArray(entry.memberSeqs) || entry.memberSeqs.length === 0 || entry.memberSeqs.some((n) => !Number.isInteger(n) || n <= 0)) problems.push('memberSeqs 非法')
      if (!Number.isInteger(entry.replacementSeq) || entry.replacementSeq <= 0) problems.push('replacementSeq 非法')
      if (typeof entry.text !== 'string' || entry.text.length === 0) problems.push('text 非法')
      if (entry.startSeq !== entry.memberSeqs[0] || entry.endSeq !== entry.memberSeqs[entry.memberSeqs.length - 1]) problems.push('start/end 与 memberSeqs 不一致')
      break
    default:
      problems.push('kind 非法')
  }
  return problems
}

/**
 * 层级纪律守卫：L2 的 sourceRecordIds 只允许 L0 记录 id——账本里已有
 * 任何卡片 id（l1/l2/l3）出现在清单里即拒绝。聚合凭证不受本守卫约束
 * （它引用的是表面 seq 与冷记录，不是摘要文本）。
 */
function assertNoSummaryOfSummary(ledger, entry) {
  if (entry?.kind !== HIERARCHY_ENTRY_L2) return
  const offending = (entry.sourceRecordIds ?? []).filter((id) => ledger.cardIds.has(id))
  if (offending.length > 0) {
    throw new HierarchyStoreError(
      `L2 阶段卡 ${entry.cardId} 引用了账本内卡片 id（${offending.join(', ')}）：禁止摘要再摘要，sourceRecordIds 只允许 L0 记录 id`,
      { code: 'EHIERARCHYNOSUMMARY', offending },
    )
  }
}

/**
 * hierarchy 账本的句柄（0.13.2-beta.6 G1）。
 *
 * 与 disposition 逐字同构的那份 `ensureLedgerHeader` 已删除：「文件存在但 0 字节」
 * 时 `readFile` 成功、不写 header，于是第一条条目成为第 1 行，下次解析判
 * 「首行不是合法 hierarchy header」→ 整本层级账 damaged，卡片全部重建。
 * 现在建 header / 补 LF / 截半行 / 锁内重读全部由 appendable-ledger.mjs 负责。
 */
function ledgerFor(sessionDir) {
  return createAppendableLedger({
    file: hierarchyPath(sessionDir),
    sessionDir,
    header: { kind: HIERARCHY_HEADER_KIND, schemaVersion: HIERARCHY_SCHEMA_VERSION },
    parse: parseLedgerText,
  })
}

/**
 * 追加一条 hierarchy 条目（崩溃注入点：单次 appendFile 一行 + LF）。
 * revision CAS：expectedRevision 与账本实际 revision 不一致即拒绝，
 * 要求调用方重读重算（preview 结果过期）。
 */
export async function appendHierarchyEntry(sessionDir, entry, options = {}) {
  return withWriteLock(sessionDir, () => appendHierarchyEntryUnlocked(sessionDir, entry, options))
}

async function appendHierarchyEntryUnlocked(sessionDir, entry, { expectedRevision = null } = {}) {
  const problems = validateEntryShape(entry)
  if (problems.length) throw new HierarchyStoreError(`hierarchy 条目非法：${problems.join('；')}`, { code: 'EINVAL' })
  const ledger = await loadHierarchy(sessionDir)
  assertWritable(ledger, 'hierarchy append')
  assertNoSummaryOfSummary(ledger, entry)
  if (expectedRevision !== null && ledger.revision !== expectedRevision) {
    throw new HierarchyStoreError(
      `hierarchy revision 已变化（期望 ${expectedRevision}，实际 ${ledger.revision}），请重新 preview`,
      { code: 'EREVISION' },
    )
  }
  const withSeq = { ...entry, entrySeq: ledger.entries.length + 1 }
  await ledgerFor(sessionDir).appendLines([withSeq])
  invalidateHierarchyIndex(sessionDir)
  return { appended: true, entry: withSeq, revision: ledger.revision + 1 }
}

/**
 * 批量原子追加：要么全部写入（一次 appendFile 拼接所有行），要么一行都
 * 不写。批次内部保持给定顺序。同样受 revision CAS 与守卫约束。
 */
export async function appendHierarchyEntries(sessionDir, entries, options = {}) {
  return withWriteLock(sessionDir, () => appendHierarchyEntriesUnlocked(sessionDir, entries, options))
}

async function appendHierarchyEntriesUnlocked(sessionDir, entries, { expectedRevision = null } = {}) {
  if (!Array.isArray(entries) || entries.length === 0) return { appended: false, entries: [], revision: null }
  for (const entry of entries) {
    const problems = validateEntryShape(entry)
    if (problems.length) throw new HierarchyStoreError(`hierarchy 条目非法：${problems.join('；')}`, { code: 'EINVAL' })
  }
  const ledger = await loadHierarchy(sessionDir)
  assertWritable(ledger, 'hierarchy append')
  let running = ledger
  for (const entry of entries) {
    assertNoSummaryOfSummary(running, entry)
    running = {
      ...running,
      revision: running.revision + 1,
      cardIds: new Set([...running.cardIds, ...(entry.cardId ? [entry.cardId] : [])]),
    }
  }
  if (expectedRevision !== null && ledger.revision !== expectedRevision) {
    throw new HierarchyStoreError(
      `hierarchy revision 已变化（期望 ${expectedRevision}，实际 ${ledger.revision}），请重新 preview`,
      { code: 'EREVISION' },
    )
  }
  // 批量原子追加：一次 appendLines（单次 write + 单次 fsync），要么全部落盘、
  // 要么一行都不写——中途崩溃不会留下半个批次。
  await ledgerFor(sessionDir).appendLines(
    entries.map((entry, index) => ({ ...entry, entrySeq: ledger.entries.length + 1 + index })),
  )
  invalidateHierarchyIndex(sessionDir)
  return { appended: true, entries: entries.map((entry, index) => ({ ...entry, entrySeq: ledger.entries.length + 1 + index })), revision: ledger.revision + entries.length }
}

// ---------------------------------------------------------------- 进程内索引

const hierarchyIndexCache = new Map()

function cacheKey(sessionDir) {
  return path.resolve(sessionDir)
}

export async function getHierarchyIndex(sessionDir) {
  const key = cacheKey(sessionDir)
  const info = await stat(hierarchyPath(sessionDir)).catch(() => null)
  const size = info?.size ?? -1
  const mtimeMs = info?.mtimeMs ?? 0
  const cached = hierarchyIndexCache.get(key)
  if (cached && cached.size === size && cached.mtimeMs === mtimeMs) return cached
  const ledger = await loadHierarchy(sessionDir)
  const fresh = {
    state: ledger.state,
    revision: ledger.revision,
    damaged: ledger.damaged,
    damageDetail: ledger.damageDetail,
    absent: ledger.state === 'absent',
    size,
    mtimeMs,
    repairedBytes: ledger.repairedBytes,
    entries: ledger.entries,
    ...foldHierarchy(ledger.entries),
  }
  hierarchyIndexCache.set(key, fresh)
  return fresh
}

export function invalidateHierarchyIndex(sessionDir) {
  hierarchyIndexCache.delete(cacheKey(sessionDir))
}

// ---------------------------------------------------------------- 查询助手

/**
 * L3 → L2 → L0 的叶子解析：任务索引引用的每张阶段卡的 sourceRecordIds
 * 汇总（阶段卡被新版本替换时按折叠态最新版解析）。缺卡（账本被人工裁剪）
 * 如实报 missing，不静默跳过。
 */
export function resolveLeafRecordIds(index, cardsById) {
  const leaves = []
  const missing = []
  const seen = new Set()
  for (const phase of index?.phases ?? []) {
    const card = cardsById.get(phase.cardId)
    if (!card || card.kind !== HIERARCHY_ENTRY_L2) {
      missing.push(phase.cardId)
      continue
    }
    for (const id of card.sourceRecordIds ?? []) {
      if (!seen.has(id)) {
        seen.add(id)
        leaves.push(id)
      }
    }
  }
  return { leaves, missing }
}

/** 状态摘要：压缩命令 status / hierarchy 报表用。 */
export async function hierarchyStatus(sessionDir) {
  const index = await getHierarchyIndex(sessionDir)
  return {
    state: index.state,
    revision: index.revision,
    damaged: index.damaged,
    damageDetail: index.damageDetail,
    repairedBytes: index.repairedBytes,
    l1Count: [...index.cardsById.values()].filter((e) => e.kind === HIERARCHY_ENTRY_L1).length,
    l2Phases: [...index.l2ByPhase.values()].map((e) => ({ phaseKey: e.phaseKey, cardId: e.cardId, tokens: e.tokens, members: (e.sourceRecordIds ?? []).length })),
    l3: index.l3Latest ? { indexId: index.l3Latest.indexId, phases: (index.l3Latest.phases ?? []).length } : null,
    vouchers: [...index.vouchers.values()].map((v) => ({ voucherId: v.voucherId, startSeq: v.startSeq, endSeq: v.endSeq, members: v.memberSeqs.length })),
    runs: index.runs.slice(-20),
  }
}