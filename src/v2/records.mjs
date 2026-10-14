/**
 * v2 记录层：全历史按需记忆化的结构化原始记录（纯函数，无 IO）。
 *
 * 与 v1（投影回执 + 单文本归档）不同，v2 把每个宿主事件规范化为带 kind、
 * 保真等级与载荷引用的不可变记录。记录一旦随事务提交即不可变；后续
 * 修正（如工具配对关闭）只追加新事实，不改写已提交记录。
 *
 * 稳定 ID：`t<txn 8位>-r<记录序号 4位>`，例如 `t00000007-r0012`。
 * 事务号单调递增、记录序号在事务内稳定，因此 ID 在崩溃对账后依然成立。
 */

import { createHash } from 'node:crypto'
import { EngineV2Error } from './errors.mjs'
import { isPluginAuthoredMessage } from '../core.mjs'

export const RECORDS_SCHEMA_VERSION = 2

/** 记录种类（封闭集；扩集必须提升 schemaVersion）。 */
export const RECORD_KINDS = Object.freeze({
  HEAD_SYSTEM: 'head.system',
  HEAD_DEVELOPER: 'head.developer',
  TURN_USER: 'turn.user',
  ASSISTANT_REASONING: 'assistant.reasoning',
  ASSISTANT_TEXT: 'assistant.text',
  OPERATION_CALL: 'operation.call',
  OPERATION_RESULT: 'operation.result',
  COMMAND_RUN: 'command.run',
  PROJECTION_SPAN: 'projection.span',
})

const KIND_SET = new Set(Object.values(RECORD_KINDS))

/**
 * 保真等级：
 * - verbatim：载荷字节与原始事件内容逐字节一致；
 * - lossy：只保留描述符，原始字节不可回源（如非文本块）；
 * - synthesized：本插件合成的记录（如投影跨度），不冒充原始历史。
 */
export const FIDELITIES = Object.freeze(['verbatim', 'lossy', 'synthesized'])

const FIDELITY_SET = new Set(FIDELITIES)

/** 每种记录允许的 refs 键（封闭集）。 */
export const REF_KEYS_BY_KIND = Object.freeze({
  [RECORD_KINDS.HEAD_SYSTEM]: ['messageId'],
  [RECORD_KINDS.HEAD_DEVELOPER]: ['messageId'],
  [RECORD_KINDS.TURN_USER]: ['messageId', 'rpcId'],
  [RECORD_KINDS.ASSISTANT_REASONING]: ['messageId', 'turn'],
  [RECORD_KINDS.ASSISTANT_TEXT]: ['messageId', 'turn'],
  [RECORD_KINDS.OPERATION_CALL]: ['callId', 'messageId', 'toolName', 'blockIndex'],
  [RECORD_KINDS.OPERATION_RESULT]: ['callId', 'resultMessageId'],
  [RECORD_KINDS.COMMAND_RUN]: ['command'],
  [RECORD_KINDS.PROJECTION_SPAN]: ['sourceKinds', 'sourceSeqs', 'spanKind'],
})

const ID_PATTERN = /^t(\d{8})-r(\d{4})$/
const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/

/** 事务号/序号 → 稳定记录 ID。 */
export function recordId(txn, index) {
  if (!Number.isSafeInteger(txn) || txn < 1 || txn > 99_999_999) {
    throw new RangeError(`txn 越界：${txn}`)
  }
  if (!Number.isSafeInteger(index) || index < 0 || index > 9999) {
    throw new RangeError(`记录序号越界：${index}`)
  }
  return `t${String(txn).padStart(8, '0')}-r${String(index).padStart(4, '0')}`
}

export function parseRecordId(id) {
  const match = ID_PATTERN.exec(String(id ?? ''))
  if (!match) return null
  return { txn: Number(match[1]), index: Number(match[2]) }
}

/** 记录 ID 全序：先事务号后序号，纯字符串比较亦成立（定宽）。 */
export function compareRecordIds(a, b) {
  const left = parseRecordId(a)
  const right = parseRecordId(b)
  if (!left || !right) throw new TypeError(`非法记录 ID：${!left ? a : b}`)
  return left.txn - right.txn || left.index - right.index
}

/** sha256 内容寻址键（不带 scheme 前缀的十六进制形式）。 */
export function payloadHash(bytes) {
  const buffer = typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes
  return `sha256:${createHash('sha256').update(buffer).digest('hex')}`
}

export function encodingFor(bytes) {
  return typeof bytes === 'string' || isProbablyUtf8(bytes) ? 'utf8' : 'base64'
}

function isProbablyUtf8(buffer) {
  const decoded = buffer.toString('utf8')
  const round = Buffer.from(decoded, 'utf8')
  return round.equals(buffer)
}

/** 记录草案：content 字段在入库时被剥离进载荷。 */
export function draftRecord({ kind, seq, fidelity = 'verbatim', inline = {}, refs = {}, content = null, contentEncoding = null }) {
  const record = {
    id: null,
    kind,
    seq,
    fidelity,
    createdAt: new Date().toISOString(),
    inline: normalizeInline(inline),
    refs: normalizeRefs(refs),
  }
  if (content !== null) {
    const buffer = typeof content === 'string' ? Buffer.from(content, 'utf8') : content
    record.content = buffer
    record.payload = {
      hash: payloadHash(buffer),
      size: buffer.byteLength,
      encoding: contentEncoding ?? encodingFor(buffer),
    }
  }
  return record
}

function normalizeInline(value) {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('inline 必须是对象')
  }
  const out = {}
  for (const key of Object.keys(value).sort()) out[key] = value[key]
  return out
}

function normalizeRefs(value) {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('refs 必须是对象')
  }
  const out = {}
  for (const key of Object.keys(value).sort()) out[key] = value[key]
  return out
}

/**
 * 提交前 schema 校验：任何不符合 v2 schema 的记录直接拒绝（拒写，不静默降级）。
 * 返回规范化的副本；载荷引用被重新校验，防止伪造哈希。
 */
export function validateRecord(candidate) {
  const problems = []
  const record = { ...candidate }

  if (typeof record.id !== 'string' || !ID_PATTERN.test(record.id)) problems.push(`id 非法：${JSON.stringify(record.id)}`)
  if (!KIND_SET.has(record.kind)) problems.push(`未知 kind：${JSON.stringify(record.kind)}`)
  if (!FIDELITY_SET.has(record.fidelity)) problems.push(`未知 fidelity：${JSON.stringify(record.fidelity)}`)
  if (!Number.isSafeInteger(record.seq) || record.seq < 0) problems.push(`seq 非法：${JSON.stringify(record.seq)}`)
  if (typeof record.createdAt !== 'string' || Number.isNaN(Date.parse(record.createdAt))) {
    problems.push(`createdAt 非法：${JSON.stringify(record.createdAt)}`)
  }

  const allowedRefs = REF_KEYS_BY_KIND[record.kind] ?? []
  const refs = record.refs ?? {}
  for (const key of Object.keys(refs)) {
    if (!allowedRefs.includes(key)) problems.push(`kind=${record.kind} 不允许 refs.${key}`)
  }
  for (const key of allowedRefs) {
    if (refs[key] === undefined) problems.push(`kind=${record.kind} 缺少 refs.${key}`)
  }

  if (record.payload !== undefined && record.payload !== null) {
    const payload = record.payload
    if (typeof payload.hash !== 'string' || !HASH_PATTERN.test(payload.hash)) problems.push('payload.hash 非法')
    if (!Number.isSafeInteger(payload.size) || payload.size < 0) problems.push('payload.size 非法')
    if (payload.encoding !== 'utf8' && payload.encoding !== 'base64') problems.push('payload.encoding 非法')
  } else {
    delete record.payload
  }

  if (problems.length) {
    const error = new EngineV2Error(`记录不符合 v2 schema，拒绝写入：${problems.join('；')}`, {
      code: 'ESCHEMA',
    })
    error.code = 'ESCHEMA'
    error.problems = problems
    throw error
  }

  delete record.content
  return { ...record, inline: { ...record.inline }, refs: { ...record.refs } }
}

/** kind → 期望的保真等级（合成记录除外）。 */
export function expectedFidelity(kind) {
  return kind === RECORD_KINDS.PROJECTION_SPAN ? 'synthesized' : 'verbatim'
}

/**
 * 把一个宿主事件规范化为记录草案（纯函数）。
 *
 * 接受 fake-host/真实宿主形状的事件：{ type, seq, data, surfaceOp?, sourceEventSeqs? }。
 * 非表面事件（如 command/run、turn/end）产生命令/无记录。
 * 表面替换事件产生 projection.span 记录（synthesized）——替换内容不冒充原始历史。
 *
 * 返回草案数组；每个草案的 content 是待入载荷的原始字节。
 */
export function recordsFromEvent(event) {
  const drafts = []
  const { type, seq, data } = event

  const pushBlocks = (blocks, kind, refs, { lossyNonText = true, inlineBase = {} } = {}) => {
    for (const block of blocks ?? []) {
      if (block?.type === 'text' && typeof block.text === 'string') {
        drafts.push(draftRecord({ kind, seq, fidelity: 'verbatim', refs, inline: { ...inlineBase }, content: block.text }))
      } else {
        drafts.push(draftRecord({
          kind,
          seq,
          fidelity: lossyNonText ? 'lossy' : 'verbatim',
          refs,
          inline: { ...inlineBase, blockDescriptor: { type: block?.type ?? 'unknown', preview: describeNonTextBlock(block) } },
        }))
      }
    }
  }

  if (type === 'system/message' || type === 'developer/message') {
    const kind = type === 'system/message' ? RECORD_KINDS.HEAD_SYSTEM : RECORD_KINDS.HEAD_DEVELOPER
    const refs = { messageId: data?.message?.id ?? null }
    pushBlocks(data?.message?.content, kind, refs)
    if (!drafts.length) {
      drafts.push(draftRecord({ kind, seq, fidelity: 'lossy', refs, inline: { blockDescriptor: { type: 'empty', preview: null } } }))
    }
    return drafts
  }

  if (type === 'user/message') {
    const refs = { messageId: data?.id ?? null, rpcId: data?.source?.rpcId ?? null }
    // 作者事实进 inline（自由字段；refs 是封闭集不能扩）：插件注入的卡片/回注包/
    // 回执与真实人类输入在 kind 与 refs 上同形，记录层不保留作者，下游（检索索引
    // 同步、命中过滤、回注文案）就无法区分「谁能被回注」（D4：插件卡片被写进检索
    // 索引又作为「已归档用户消息」回注）。判定与 `isPluginAuthoredMessage` 同口径
    // （source.form 插件标记 + 旧回执正文兜底），在 ingest 时一次性落进记录。
    const inlineBase = isPluginAuthoredMessage(event) ? { pluginAuthored: true } : {}
    pushBlocks(data?.content, RECORD_KINDS.TURN_USER, refs, { inlineBase })
    if (!drafts.length) {
      drafts.push(draftRecord({ kind: RECORD_KINDS.TURN_USER, seq, fidelity: 'lossy', refs, inline: { ...inlineBase, blockDescriptor: { type: 'empty', preview: null } } }))
    }
    return drafts
  }

  if (type === 'assistant/message') {
    // 表面替换产生的 assistant/message（如官方压缩摘要）是合成投影，不是原始历史。
    if (event.surfaceOp && event.surfaceOp !== 'append' || (event.sourceEventSeqs?.length ?? 0) > 0) {
      drafts.push(draftRecord({
        kind: RECORD_KINDS.PROJECTION_SPAN,
        seq,
        fidelity: 'synthesized',
        refs: { sourceKinds: ['assistant.message'], sourceSeqs: event.sourceEventSeqs ?? [], spanKind: 'surface-replacement' },
        content: JSON.stringify(textBlocksOf(data?.message?.content)),
      }))
      return drafts
    }
    const messageId = data?.message?.id ?? null
    const turn = data?.turn ?? null
    let blockIndex = 0
    for (const block of data?.message?.content ?? []) {
      if (block?.type === 'reasoning') {
        drafts.push(draftRecord({
          kind: RECORD_KINDS.ASSISTANT_REASONING, seq, fidelity: 'verbatim',
          refs: { messageId, turn }, inline: { blockIndex }, content: block.text ?? '',
        }))
      } else if (block?.type === 'text') {
        drafts.push(draftRecord({
          kind: RECORD_KINDS.ASSISTANT_TEXT, seq, fidelity: 'verbatim',
          refs: { messageId, turn }, inline: { blockIndex }, content: block.text ?? '',
        }))
      } else if (block?.type === 'tool-call') {
        drafts.push(draftRecord({
          kind: RECORD_KINDS.OPERATION_CALL, seq, fidelity: 'verbatim',
          refs: { callId: block.id, messageId, toolName: block.name, blockIndex },
          content: typeof block.arguments === 'string' ? block.arguments : JSON.stringify(block.arguments ?? null),
        }))
      } else {
        drafts.push(draftRecord({
          kind: RECORD_KINDS.ASSISTANT_TEXT, seq, fidelity: 'lossy',
          refs: { messageId, turn }, inline: { blockIndex, blockDescriptor: { type: block?.type ?? 'unknown', preview: describeNonTextBlock(block) } },
        }))
      }
      blockIndex += 1
    }
    return drafts
  }

  if (type === 'tool/result') {
    const callId = data?.message?.source?.callId ?? data?.message?.toolCallId ?? null
    const refs = { callId, resultMessageId: data?.message?.id ?? null }
    const blocks = data?.message?.content ?? []
    pushBlocks(blocks, RECORD_KINDS.OPERATION_RESULT, refs)
    if (!drafts.length) {
      drafts.push(draftRecord({ kind: RECORD_KINDS.OPERATION_RESULT, seq, fidelity: 'lossy', refs, inline: { blockDescriptor: { type: 'empty', preview: null } } }))
    }
    return drafts
  }

  if (type === 'command/run') {
    drafts.push(draftRecord({
      kind: RECORD_KINDS.COMMAND_RUN, seq, fidelity: 'verbatim',
      refs: { command: data?.command ?? String(data?.input ?? '') }, content: data?.input ?? '',
    }))
    return drafts
  }

  // 其他非表面事件（turn/end 等）：不生成记录；投影跨度在替换事件处统一捕捉。
  if (event.surfaceOp && event.surfaceOp !== 'append') {
    drafts.push(draftRecord({
      kind: RECORD_KINDS.PROJECTION_SPAN,
      seq,
      fidelity: 'synthesized',
      refs: { sourceKinds: [type], sourceSeqs: event.sourceEventSeqs ?? [], spanKind: 'surface-replacement' },
      content: JSON.stringify({ type }),
    }))
  }
  return drafts
}

function textBlocksOf(content) {
  return (content ?? []).filter((block) => block?.type === 'text').map((block) => block.text)
}

function describeNonTextBlock(block) {
  if (!block || typeof block !== 'object') return String(block)
  const summary = {}
  for (const key of Object.keys(block)) {
    const value = block[key]
    summary[key] = typeof value === 'string' ? value.slice(0, 200) : typeof value
  }
  return summary
}

/**
 * 工具配对账本（纯状态）：callId → { callRecordId, resultRecordId|null, callSeq }。
 * 应用新记录返回 { ledger, closed }；结果先于调用视为孤儿（记录事实，不静默配对）。
 */
export function applyRecordToPairingLedger(ledger, record) {
  const next = new Map(ledger)
  const closed = []
  if (record.kind === RECORD_KINDS.OPERATION_CALL) {
    const callId = record.refs.callId
    const existing = next.get(callId)
    if (existing && existing.resultRecordId === null) {
      // 同名重复调用未闭合：保留第一条为配对对象，后续记为 duplicate（事实保留，不覆盖）。
      next.set(callId, { ...existing, duplicateCallRecordIds: [...(existing.duplicateCallRecordIds ?? []), record.id] })
    } else if (existing) {
      next.set(callId, { ...existing, duplicateCallRecordIds: [...(existing.duplicateCallRecordIds ?? []), record.id] })
    } else {
      next.set(callId, { callRecordId: record.id, callSeq: record.seq, resultRecordId: null })
    }
  }
  if (record.kind === RECORD_KINDS.OPERATION_RESULT) {
    const callId = record.refs.callId
    const existing = next.get(callId)
    if (!existing) {
      next.set(callId, { callRecordId: null, callSeq: null, resultRecordId: record.id, orphan: true })
    } else if (existing.resultRecordId === null) {
      next.set(callId, { ...existing, resultRecordId: record.id })
      closed.push(callId)
    } else {
      next.set(callId, { ...existing, orphanResults: [...(existing.orphanResults ?? []), record.id] })
    }
  }
  return { ledger: next, closed }
}

/** 未闭合配对（在途动作）：有 call 无 result。 */
export function openCallsOf(ledger) {
  const open = []
  for (const [callId, entry] of ledger) {
    if (entry.callRecordId !== null && entry.resultRecordId === null && !entry.orphan) open.push({ callId, ...entry })
  }
  return open
}
