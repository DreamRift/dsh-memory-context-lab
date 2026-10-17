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
import { appendFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { applyRecordToPairingLedger, compareRecordIds, openCallsOf, parseRecordId, RECORD_KINDS } from './records.mjs'

export const DISPOSITION_FILE = 'disposition.jsonl'
export const FORGET_PLANS_FILE = 'forget-plans.json'
export const DISPOSITION_HEADER_KIND = 'dsh-memory-context-lab/v2/disposition'
export const DISPOSITION_SCHEMA_VERSION = 1
export const DISPOSITION_ENTRY_FORGET = 'disposition/forget'
export const DISPOSITION_ENTRY_UNDO = 'disposition/undo'
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

/**
 * 键排序的规范 JSON（整个值递归排序）。账本与计划文件落盘一律用它，
 * 保证同一逻辑内容字节稳定，便于逐字节比对与审计。
 */
export function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson)
  if (value !== null && typeof value === 'object') {
    const out = {}
    for (const key of Object.keys(value).sort()) out[key] = canonicalJson(value[key])
    return out
  }
  return value
}

export function canonicalLine(value) {
  return JSON.stringify(canonicalJson(value))
}

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

function parseLedgerText(text) {
  const lines = text.split('\n')
  // 文本以 \n 结尾时 split 会留一个空尾元素；非空的最后一行＝半行（崩溃残留）。
  const trailingNewline = /\n$/.test(text)
  const completeLines = trailingNewline ? lines.slice(0, -1) : lines.slice(0, -1)
  const partialLine = trailingNewline ? '' : lines[lines.length - 1]
  const entries = []
  let damaged = false
  let damageDetail = null
  let header = null
  let headerProblems = []
  for (let index = 0; index < completeLines.length; index += 1) {
    const raw = completeLines[index]
    if (raw.length === 0) continue
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      damaged = true
      damageDetail = { line: index + 1, message: error.message }
      break
    }
    if (index === 0 || header === null) {
      if (parsed?.kind !== DISPOSITION_HEADER_KIND || parsed?.schemaVersion !== DISPOSITION_SCHEMA_VERSION) {
        damaged = true
        damageDetail = { line: index + 1, message: '首行不是合法 disposition header' }
        break
      }
      header = parsed
      continue
    }
    if (parsed?.kind !== DISPOSITION_ENTRY_FORGET && parsed?.kind !== DISPOSITION_ENTRY_UNDO) {
      damaged = true
      damageDetail = { line: index + 1, message: `未知条目 kind：${JSON.stringify(parsed?.kind)}` }
      break
    }
    entries.push(parsed)
  }
  return { header, entries, damaged, damageDetail, partialLine, rawByteLength: Buffer.byteLength(text, 'utf8') }
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
  const file = dispositionPath(sessionDir)
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return { state: 'absent', entries: [], revision: 0, damaged: false, repairedBytes: 0 }
    throw error
  }
  if (text.length === 0) {
    return { state: 'absent', entries: [], revision: 0, damaged: false, repairedBytes: 0 }
  }
  const parsed = parseLedgerText(text)
  let repairedBytes = 0
  if (parsed.partialLine && parsed.partialLine.length > 0) {
    // 崩溃注入点①：半行截断修复——只保留完整行，被截掉的字节数如实上报。
    const keepBytes = Buffer.byteLength(text, 'utf8') - Buffer.byteLength(parsed.partialLine, 'utf8')
    await writeFile(file, Buffer.from(text.slice(0, text.length - parsed.partialLine.length), 'utf8'))
    repairedBytes = Buffer.byteLength(parsed.partialLine, 'utf8')
    void keepBytes
  }
  const revision = parsed.entries.length
  return {
    // BUG-013：损坏优先于 absent。首行坏 JSON 时 entries=[]、header=null，
    // 先判 absent 会把「账本损坏」报成「全新会话」（旁路 damaged 字段才看得到）。
    state: parsed.damaged ? 'damaged' : (parsed.entries.length === 0 && parsed.header === null ? 'absent' : 'ok'),
    entries: parsed.entries,
    revision,
    damaged: parsed.damaged,
    damageDetail: parsed.damageDetail,
    repairedBytes,
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
  } catch {
    return { revision: 0, forgotten: new Map(), damaged: false, absent: true, size: -1, mtimeMs: 0, repairedBytes: 0 }
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
  let info = await stat(dispositionPath(sessionDir)).catch(() => null)
  const size = info?.size ?? -1
  const mtimeMs = info?.mtimeMs ?? 0
  const cached = forgetIndexCache.get(key)
  if (cached && cached.size === size && cached.mtimeMs === mtimeMs) return cached
  const fresh = await refreshForgetIndex(sessionDir)
  forgetIndexCache.set(key, fresh)
  return fresh
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

async function ensureLedgerHeader(sessionDir) {
  const file = dispositionPath(sessionDir)
  await mkdir(sessionDir, { recursive: true })
  try {
    await readFile(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') {
      const header = canonicalLine({ kind: DISPOSITION_HEADER_KIND, schemaVersion: DISPOSITION_SCHEMA_VERSION })
      await writeFile(file, header + '\n', { encoding: 'utf8' })
      return
    }
    throw error
  }
}

/**
 * 追加一条 disposition 条目（崩溃注入点⑥：追加本身原子——单次 appendFile
 * 一行 + LF，进程在半行处中断时下次打开按半行截断修复）。
 */
async function appendEntry(sessionDir, entry) {
  const problems = validateEntryShape(entry)
  if (problems.length) throw new DispositionError(`disposition 条目非法：${problems.join('；')}`, { code: 'EINVAL' })
  await ensureLedgerHeader(sessionDir)
  await appendFile(dispositionPath(sessionDir), canonicalLine(entry) + '\n', 'utf8')
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
export async function applyForget({ sessionDir, targetIds, actor, reason, expectedRevision = null, withdrawals = [] }) {
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
    return { appended: false, alreadyForgotten: already, entry: null, revision: ledger.revision }
  }
  const operationId = nextOperationId(ledger.entries, 'f')
  const entry = {
    kind: DISPOSITION_ENTRY_FORGET,
    operationId,
    entrySeq: ledger.entries.length + 1,
    actor: String(actor ?? 'user'),
    reason: String(reason ?? ''),
    targetIds: effective,
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
  return { appended: true, alreadyForgotten: already, entry, revision: ledger.revision + 1 }
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
export async function applyUndo({ sessionDir, operationId, actor, reason }) {
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
  const payload = canonicalLine({ plans: next }) + '\n'
  await mkdir(sessionDir, { recursive: true })
  const temp = file + '.tmp'
  await writeFile(temp, payload, 'utf8')
  await rename(temp, file)
  return { planId: plan.planId, kept: next.length }
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
 * 账本级预览：解析目标 → 硬保护 → 分类（unknown/blocked/already/toForget）。
 * 回执/索引层面的级联影响由 runtime 层补充（那里才有归档行与索引状态）。
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
