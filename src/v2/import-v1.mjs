/**
 * v1 → v2 迁移导入（只做指针级导入，不复制大文本）。
 *
 * v1 维护版把已完成操作的原文存在 v1 冷库（lingshu-lab），state.archive 里是
 * 指针条目（nodeId/hash/chars/callIds）。v2 导入遵循两条原则：
 * 1. 不重写 v1 数据、不删 v1 冷库——v1 回执里的 nodeId 仍可回源；
 * 2. v2 侧以 fidelity='synthesized' 的 projection.span 指针记录收编条目，
 *    内容字段是条目描述符本身（可审计），不冒充 verbatim 原文。
 *
 * 陌生/畸形条目按 schema 拒写：整批先校验、后入事务，绝不半批入库。
 */
import { createHash } from 'node:crypto'
import { RECORD_KINDS, draftRecord } from './records.mjs'
import { EngineV2Error } from './errors.mjs'

const V1_ARCHIVE_ENTRY_KEYS = [
  'rangeStart', 'rangeEnd', 'callIds', 'tools', 'nodeId', 'hash',
  'chars', 'originalTokens', 'replacementSeq', 'chunkCount', 'appliedAt', 'status',
]

function isSafeInt(value, { min = 0 } = {}) {
  return Number.isSafeInteger(value) && value >= min
}

function isIsoTimestamp(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value))
}

/**
 * 严格校验一条 v1 archive 条目。返回 null 表示合法；返回字符串表示问题清单。
 * 故意比 v1 写入端更严格：宁可拒收，不猜字段含义。
 */
export function validateV1ArchiveEntry(entry) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    return '条目不是对象'
  }
  const problems = []
  for (const key of V1_ARCHIVE_ENTRY_KEYS) {
    if (!(key in entry)) problems.push(`缺少 ${key}`)
  }
  if (problems.length) return problems.join('；')
  if (entry.status !== 'applied') problems.push(`status 必须是 applied，实际 ${JSON.stringify(entry.status)}`)
  if (!isSafeInt(entry.rangeStart, { min: 1 })) problems.push('rangeStart 非法')
  if (!isSafeInt(entry.rangeEnd, { min: 1 })) problems.push('rangeEnd 非法')
  if (isSafeInt(entry.rangeStart, { min: 1 }) && isSafeInt(entry.rangeEnd, { min: 1 })
    && entry.rangeEnd < entry.rangeStart) problems.push('rangeEnd < rangeStart')
  if (!Array.isArray(entry.callIds) || entry.callIds.length === 0
    || !entry.callIds.every((id) => typeof id === 'string' && id.length > 0)) {
    problems.push('callIds 必须是非空字符串数组')
  }
  if (entry.tools !== undefined && entry.tools !== null
    && !(Array.isArray(entry.tools) && entry.tools.every((t) => typeof t === 'string'))) {
    problems.push('tools 必须是字符串数组')
  }
  if (typeof entry.nodeId !== 'string' || entry.nodeId.length === 0) problems.push('nodeId 非法')
  if (typeof entry.hash !== 'string' || entry.hash.length === 0) problems.push('hash 非法')
  if (!isSafeInt(entry.chars)) problems.push('chars 非法')
  if (!isSafeInt(entry.originalTokens)) problems.push('originalTokens 非法')
  if (!isSafeInt(entry.replacementSeq, { min: 1 })) problems.push('replacementSeq 非法')
  if (!isSafeInt(entry.chunkCount, { min: 1 })) problems.push('chunkCount 非法')
  if (!isIsoTimestamp(entry.appliedAt)) problems.push('appliedAt 非法')
  if (entry.chunkIds !== undefined && entry.chunkIds !== null
    && !(Array.isArray(entry.chunkIds) && entry.chunkIds.every((c) => typeof c === 'string'))) {
    problems.push('chunkIds 必须是字符串数组')
  }
  return problems.length ? problems.join('；') : null
}

/** v1 条目 → v2 指针记录草案（synthesized，内容为条目描述符 JSON）。 */
export function draftFromV1ArchiveEntry(entry, seq) {
  const content = JSON.stringify({
    source: 'v1-archive',
    nodeId: entry.nodeId,
    hash: entry.hash,
    chars: entry.chars,
    originalTokens: entry.originalTokens,
    replacementSeq: entry.replacementSeq,
    rangeStart: entry.rangeStart,
    rangeEnd: entry.rangeEnd,
    callIds: [...entry.callIds],
    tools: Array.isArray(entry.tools) ? [...entry.tools] : null,
    chunkCount: entry.chunkCount,
    chunkIds: Array.isArray(entry.chunkIds) ? [...entry.chunkIds] : null,
    appliedAt: entry.appliedAt,
  })
  return draftRecord({
    kind: RECORD_KINDS.PROJECTION_SPAN,
    seq,
    fidelity: 'synthesized',
    inline: { spanKind: 'v1-archive-import' },
    refs: { sourceKinds: ['archive.entry'], sourceSeqs: [entry.rangeStart], spanKind: 'v1-archive-import' },
    content,
  })
}

/**
 * 把 v1 archive 条目导入 v2 库。整批先校验，任何一条非法则整批拒绝（半批不入库）。
 * 幂等：载荷内容寻址去重——同一 v1 条目重复导入不再产生新记录。
 * 返回 { committedTxn, recordIds, skipped }。
 */
export async function importV1ArchiveEntries(store, entries) {
  if (!Array.isArray(entries)) {
    throw new EngineV2Error('v1 archive 导入入参必须是条目数组', { code: 'ESCHEMA' })
  }
  const problems = []
  entries.forEach((entry, index) => {
    const problem = validateV1ArchiveEntry(entry)
    if (problem) problems.push(`条目 #${index}：${problem}`)
  })
  if (problems.length) {
    const error = new EngineV2Error(`v1 archive 导入校验失败，整批拒绝：${problems.join('；')}`, {
      code: 'ESCHEMA',
    })
    error.problems = problems
    throw error
  }

  // 幂等：按内容寻址找已有指针记录（同一条目 → 同一描述符 JSON → 同一载荷哈希）。
  const drafts = entries.map((entry, index) => draftFromV1ArchiveEntry(entry, entry.rangeStart + index))
  const existingHashes = new Set()
  for (const entry of store.listEntries({ limit: Number.MAX_SAFE_INTEGER, kinds: [RECORD_KINDS.PROJECTION_SPAN] }).entries) {
    if (entry.inline?.spanKind === 'v1-archive-import' && entry.payload?.hash) {
      existingHashes.add(entry.payload.hash)
    }
  }

  const pending = drafts.filter((draft) => {
    const bytes = Buffer.from(draft.content, 'utf8')
    const hash = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
    return !existingHashes.has(hash)
  })

  const recordIds = []
  let committedTxn = null
  if (pending.length > 0) {
    const txn = await store.openTransaction()
    for (const draft of pending) {
      const staged = await store.stageRecord(txn, draft)
      recordIds.push(staged.id)
    }
    const committed = await store.commitTransaction(txn)
    committedTxn = committed.committedTxn
  }
  return { committedTxn, recordIds, skipped: drafts.length - pending.length }
}
