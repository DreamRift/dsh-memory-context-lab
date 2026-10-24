/**
 * Cooling core: operation-range selection, the archive transaction, restore,
 * and cold-store recall.
 *
 * This module is deliberately host-agnostic. It receives a *surface view*
 * (surface node order, event lookup, measured node prices, and the token meter)
 * so every rule below is unit-testable without a live DSH session, and so
 * `index.mjs` stays the only place that touches DSH services.
 *
 * Archive unit = one **operation**: the assistant node that requested the tool
 * calls plus the tool results answering exactly those calls. Both halves are
 * shadowed by a single replacement node, because the tool-call arguments (an
 * `edit`'s old/new strings, a `write`'s body) are frequently larger than the
 * result. Tool definitions themselves are never touched: they live in the
 * request prefix, and changing the tool set would invalidate the whole prefix
 * cache.
 *
 * Safety posture: every failure path keeps the original messages. A range is
 * only replaced after its cold record is persisted and explicitly read back
 * with a matching content hash.
 */

import { createHash } from 'node:crypto'
import { createHmac } from 'node:crypto'
import { randomUUID } from 'node:crypto'
import {
  archiveChunkNodeId,
  buildBatchReceipt,
  buildReceipt,
  buildSpanReceipt,
  chunkArchiveBody,
  coldRecordBody,
  extractCallLocator,
  formatRecallDigest,
  isHumanAuthoredMessage,
  isPluginAuthoredMessage,
  MAX_OPERATION_BYTES,
  MAX_OPERATION_LINES,
  MAX_OPERATION_TOTAL_BYTES,
  MAX_RECALL_DIGEST_CHARS,
  MIN_OPERATION_CHARS,
  normalizeColdBody,
  normalizeRecallPayload,
  PACKAGE_NAME,
  PLUGIN_SOURCE_FORMS,
  PLUGIN_SOURCE_KIND,
  RECALL_STATUS,
  RECEIPT_FORMAT_BATCH,
  RECEIPT_FORMAT_BATCH_V2,
  RECEIPT_FORMAT_BATCH_SLIM,
  batchReleaseCeilingOf,
  MAX_BATCH_RELEASE_WINDOW_RATIO,
  RECEIPT_FORMAT_LEGACY,
  RECEIPT_FORMAT_OPERATION,
  RECEIPT_FORMAT_OPERATION_SLIM,
  RECEIPT_FORMAT_SPAN,
  RECEIPT_FORMAT_SPAN_V2,
  RECEIPT_FORMAT_SPAN_SLIM,
  RECEIPT_FORMAT_VERSION,
  RECEIPT_MARKER,
  resultStatusOf,
  textFromContent,
} from './core.mjs'
import {
  rangeStillCurrent,
  bodyFromSurface,
  unitBaseOf,
  resultTextOf,
  writeUnitColdChunks,
  verifyUnitColdChunks,
  commitSurfaceRun,
  assistantTextOf,
  assistantReasoningOf,
} from './apply-commit.mjs'

export {
  rangeStillCurrent,
  bodyFromSurface,
  unitBaseOf,
  resultTextOf,
  writeUnitColdChunks,
  verifyUnitColdChunks,
  resolveCommitSpan,
  commitSurfaceRun,
  applyOneOperation,
  sumShadowedTokens,
  tokenAccountingOf,
  lastUsageOf,
  lastUsageWithSeqOf,
  cacheStatsOf,
  formatCacheLine,
  summarizeOutcomes,
  occupancyLines,
  formatBatchReport,
  formatRestoreReport,
  describeRestoreSkipReasons,
} from './apply-commit.mjs'

import {
  restoreReceipts,
  restoreLegacyReceipt,
} from './apply-restore.mjs'

export {
  restoreReceipts,
  parseBatchHeaderNumbers,
  receiptReconstructionCandidates,
} from './apply-restore.mjs'

import { contentHasPlanToolCall } from './plan-first.mjs'
// N-06 旧行迁移：缺 spanLabel 的归档行按行内 spanKind 反推标签，与生产侧同一张表。
import { spanLabelOf } from './v2/history.mjs'

/** Human-readable reasons a surface node or range is not archivable, keyed by code. */
export const SKIP_REASONS = Object.freeze({
  'not-an-operation': '不是「助手调用 + 工具结果」的完整操作',
  'already-archived': '该操作已归档',
  'assistant-not-eligible': '助手节点含非文本、非工具调用的内容块',
  'failed-result': '操作中存在失败或带错误的工具结果',
  'no-content': '工具结果没有可读正文',
  'non-text-content': '工具结果含非文本块（图片／二进制／结构化），无法保真',
  'no-call-id': '工具结果缺少可配对的 callId',
  'duplicate-call-id': '同一操作内出现重复的 callId，无法证明哪个结果答复哪次调用',
  'unpaired': '未找到与调用一一对应且紧邻的工具结果',
  'parked-retry-exhausted': '重试达上界已停摆（原文保留，原因见 status）',
  'too-short': '正文短于最小归档阈值',
  'too-large': '正文超出可回读校验的上限（写入后无法整体回读）',
  'protected-system-head': 'system 指令节点',
  'protected-latest-user': '最新用户消息',
  'protected-plan-artifact': '计划工件（exit_plan_mode 调用与计划全文）全程保留',
  'not-yet-exposed': '属于模型尚未发送完证据的当前轮次',
  'below-min-release': '净释放低于最小阈值',
})

/** Fail-closed reasons that must never be papered over with a guess. */
export class OccupancyUnavailableError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'OccupancyUnavailableError'
    this.code = code
  }
}

function describeSkip(code) {
  return SKIP_REASONS[code] ?? code
}

/** Full sha256 of the archived body; the receipt carries only its short form. */
export function hashText(text) {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex')
}

/**
 * The isolated store normalizes CRLF to LF on write (its markdown codec opens
 * the node file with `newline="\n"`, so `"\r\n"` becomes `"\n"` on the way out
 * and `"\n"` on the way back in). Rebuilding a body from live events therefore
 * cannot reproduce a CRLF byte-for-byte after one store round-trip. That is
 * fine for restore fidelity — the model reads either line ending identically —
 * but it makes a byte-hash comparison across the store boundary meaningless.
 *
 * Both the drift check and the read-back check now compare canonical bodies:
 * CRLF (and any lone CR) folded to LF on both sides, so a pure line-ending
 * difference is not reported as drift, while any real content change still is.
 */
export function canonicalizeBody(text) {
  return String(text ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

export function canonicalHash(text) {
  return hashText(canonicalizeBody(text))
}

/**
 * MAC used for receipts and archive rows: keyed so the receipt's hash is not a
 * reusable oracle for anyone who can guess the body, and cheap to verify.
 */
export function archiveMac(text) {
  return createHmac('sha256', 'dsh-memory-context-lab/archive')
    .update(canonicalizeBody(text), 'utf8')
    .digest('hex')
}

/**
 * Window bookkeeping for display: the context window and the completion
 * reservation, both confirmed values. There is no occupancy budget anymore —
 * the retention count alone decides when a batch is ready — so this exists
 * only to render the report, never to gate a plan. Either number being
 * unconfirmed fails closed, because a guessed window should never reach a
 * destructive rewrite either.
 */
export function resolveWindow({ contextWindow, reservedCompletionTokens = 0 }) {
  if (!Number.isInteger(contextWindow) || contextWindow <= 0) {
    throw new OccupancyUnavailableError(
      'window',
      `宿主未提供可确认的模型上下文窗口（contextWindow=${String(contextWindow)}），已失败关闭：不替换任何会话内容。`,
    )
  }
  if (!Number.isInteger(reservedCompletionTokens) || reservedCompletionTokens < 0) {
    throw new OccupancyUnavailableError(
      'reservation',
      `宿主返回的完成 token 预留不可信（maxTokens=${String(reservedCompletionTokens)}），已失败关闭。`,
    )
  }
  return { contextWindow, reservedCompletionTokens }
}

/** Current occupancy as a fraction of the context window, or null when unmeasurable. */
export function computeOccupancy(assembledTokens, contextWindow) {
  if (!Number.isFinite(assembledTokens) || !Number.isFinite(contextWindow) || contextWindow <= 0) return null
  return assembledTokens / contextWindow
}

/**
 * Find the turn left open by the log tail, or `undefined` when the last turn
 * already ended. Used to keep the current turn out of every candidate set.
 */
export function openTurnOf(session) {
  for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
    const event = session.eventAt(seq)
    if (event?.type === 'turn/start') return Number.isInteger(event.data?.turn) ? event.data.turn : undefined
    if (event?.type === 'turn/end') return undefined
  }
  return undefined
}

/** True for an assistant node that requests at least one tool call, i.e. an operation head. */
function isOperationAssistant(event) {
  return event?.type === 'assistant/message'
    && Array.isArray(event.data?.message?.content)
    && event.data.message.content.some((block) => block?.type === 'tool-call')
}

/** Build the archived body stored in the cold store; restoring it recovers every byte. */
export function buildArchiveBody({ assistantReasoning, assistantText, entries }) {
  const parts = []
  // Reasoning is archived too. In a thinking-heavy session it is the bulk of the
  // occupancy, so leaving it out would both cap the cooler far below its target
  // and make the replacement lossy: the cold body is the only copy left.
  if (assistantReasoning) parts.push(`## 助手思考\n${assistantReasoning}`)
  if (assistantText) parts.push(`## 助手说明\n${assistantText}`)
  for (const [index, entry] of entries.entries()) {
    parts.push([
      `## 调用 ${index + 1}：${entry.name}`,
      '参数：',
      entry.arguments || '(无参数)',
      '',
      '结果：',
      entry.text,
    ].join('\n'))
  }
  return parts.join('\n\n')
}

/**
 * Select archivable operations from one surface view, oldest first.
 *
 * Only two things are hard-protected: the system head, and the latest user
 * message. Everything else is an archivable candidate, including operations
 * inside the retention window and inside the currently open turn — the planner
 * decides how far to go.
 *
 * The retention window is therefore a *baseline*, not a fence. Normally the
 * newest `retainOperations` operations stay verbatim, because the planner stops
 * as soon as occupancy is back under the target. Under sustained pressure it
 * consumes them from their oldest end, which is exactly the "16 → 15 → 14 …
 * until it fits" behaviour: each step removes one more of the newest
 * operations, and the setting itself is never mutated.
 *
 * Same-turn operations are candidates for a reason: a long agentic turn is one
 * user message followed by dozens of tool calls, so fencing off the open turn
 * would make the plugin a no-op in precisely the sessions that need it. What
 * keeps in-flight work safe is pair completeness below — an assistant node
 * whose results have not all arrived is never a candidate.
 */
export function collectOperationCandidates(view) {
  const {
    surfaceNodes = [],
    eventAt,
    measuredNodes = [],
    retainOperations = 0,
    openTurn,
    archivedRanges = [],
    // Ranges that already spent their retry budget (P0-1). They are removed from
    // the candidate set — a permanently failing range must not loop forever — but
    // the removal is *reported* (status lists them with their attempt count), so
    // "not archived" is never confused with "nothing left to do".
    parkedRanges = [],
    // 插件自己写下的活动面序号（归档替换点、`restore` 出来的正文）。老日志里的
    // 恢复正文没有 `form`、正文又是原文，形状上与人类输入无法区分；这份账本由插件
    // 自己的状态文件提供，是唯一能覆盖老日志的判据（P1-4）。
    pluginWrittenSeqs = [],
    minimumChars = MIN_OPERATION_CHARS,
    // Surface seq of the newest assistant message. Everything from here on is
    // still part of the turn the model is living in right now: it may send new
    // evidence at any moment, so these nodes are never batched away (C-12).
    lastAssistantSeq = null,
  } = view
  const total = surfaceNodes.length
  const nodeAt = (index) => eventAt(surfaceNodes[index])
  const skip = new Map()
  const protectedIdx = new Set()
  const protect = (index, reason) => {
    protectedIdx.add(index)
    skip.set(surfaceNodes[index], reason)
  }

  if (total > 0 && nodeAt(0)?.type === 'system/message') protect(0, 'protected-system-head')

  // The user's own request is never archived: it is the task statement, and a
  // receipt in its place would leave the model without the question. The
  // newest user message is protected explicitly, and everything after the last
  // assistant message is fenced by `not-yet-exposed` below (C-12) — so an
  // older user message may only be consumed together with the whole turn that
  // already answered it, never alone and never while the turn is open.
  //
  // "User message" means human-authored here: the plugin injects its own
  // receipts/cards/recall packs as `user/message` too, and letting one of them
  // own this slot is exactly how the working-state card ended up reporting the
  // plugin's own receipt as "the current human request" (audit P0-3).
  // `pluginWrittenSeqs` 额外覆盖老日志里那些没有 form 的恢复正文（P1-4）。
  const writtenSeqs = new Set(pluginWrittenSeqs)
  const latestUserIndex = (() => {
    for (let index = total - 1; index >= 0; index -= 1) {
      if (writtenSeqs.has(surfaceNodes[index])) continue
      const node = nodeAt(index)
      if (node?.type === 'user/message' && isHumanAuthoredMessage(node)) return index
    }
    return -1
  })()
  if (latestUserIndex >= 0) protect(latestUserIndex, 'protected-latest-user')

  // Baseline retention boundary: surface index at which the newest N operations
  // begin. Candidates at or after it are marked `withinRetention` so the planner
  // can report how far below the baseline it had to go.
  let retentionFromIndex = total
  if (retainOperations > 0) {
    let seen = 0
    retentionFromIndex = 0
    for (let index = total - 1; index >= 0; index -= 1) {
      if (!isOperationAssistant(nodeAt(index))) continue
      if (seen >= retainOperations) {
        retentionFromIndex = index + 1
        break
      }
      seen += 1
    }
  }

  const archivedStarts = new Set((archivedRanges ?? []).map((range) => range.start))
  const parkedStarts = new Set((parkedRanges ?? []).map((range) => (typeof range === 'number' ? range : range?.start)))
  const candidates = []
  const bySurfaceIndex = new Map()
  for (let index = 0; index < total; index += 1) bySurfaceIndex.set(index, nodeAt(index))

  for (let index = 0; index < total; index += 1) {
    const assistant = bySurfaceIndex.get(index)
    if (assistant?.type !== 'assistant/message') continue
    const content = assistant.data?.message?.content
    if (!Array.isArray(content) || content.length === 0) continue
    const calls = content.filter((block) => block?.type === 'tool-call')
    if (calls.length === 0) continue
    const seq = surfaceNodes[index]

    if (protectedIdx.has(index)) continue
    if (archivedStarts.has(seq)) {
      skip.set(seq, 'already-archived')
      continue
    }
    if (parkedStarts.has(seq)) {
      skip.set(seq, 'parked-retry-exhausted')
      continue
    }
    // The open turn's own operations stay visible: the model is producing them
    // and may still send evidence (C-12). archiveNow re-selects this range on
    // the next turn's first ask, when the evidence has actually been sent.
    if (lastAssistantSeq !== null && seq >= lastAssistantSeq) {
      skip.set(seq, 'not-yet-exposed')
      continue
    }
    // Reasoning is archivable: it is this node's own text, and in a thinking-heavy
    // session it is where most of the occupancy sits. Anything else — images,
    // attachments, provider-specific blocks — still disqualifies the whole
    // operation, because the cold body could not reproduce it faithfully.
    if (content.some((block) => block?.type !== 'tool-call' && block?.type !== 'text' && block?.type !== 'reasoning')) {
      skip.set(seq, 'assistant-not-eligible')
      continue
    }
    // 计划工件：exit_plan_mode 的调用参数就是计划全文，按需求全程保留在热上下文。
    // 这里跳过的是「操作头」，其配对结果随后由 orphan-result 规则跳过（仍可见）。
    if (contentHasPlanToolCall(content)) {
      skip.set(seq, 'protected-plan-artifact')
      continue
    }
    const callIds = calls.map((block) => (typeof block.id === 'string' ? block.id : ''))
    if (callIds.some((id) => !id)) {
      skip.set(seq, 'no-call-id')
      continue
    }
    // 重复 callId：宿主契约要求同一条助手消息内 id 唯一。这里按位置配对，重复 id
    // 会让"哪个结果答复哪次调用"无法证明，冷记录头部也会写成 calls: dup,dup。
    // 宁可整段不归档，也不留下无法核验的配对。
    if (new Set(callIds).size !== callIds.length) {
      skip.set(seq, 'duplicate-call-id')
      continue
    }
    if (calls.some((block) => typeof block.name !== 'string' || !block.name)) {
      skip.set(seq, 'not-an-operation')
      continue
    }
    // Source coordinates for the cold store's pairing index. They are read off
    // the live host events here — the only place that still has them — and
    // carried through the plan so the adapter can write schema-legal
    // `operation.call` / `operation.result` refs. Deriving them later, or
    // inventing them in the adapter, would be fabrication.
    const callBlockIndexes = []
    for (const [blockIndex, block] of content.entries()) {
      if (block?.type === 'tool-call') callBlockIndexes.push(blockIndex)
    }
    const assistantMessageId = assistant.data?.message?.id ?? null

    // The results must answer exactly these calls, in order, immediately after
    // the assistant node. Anything else means this is not one clean operation.
    const entries = []
    let cursor = index + 1
    let failed = null
    for (const [callIndex, callId] of callIds.entries()) {
      const resultNode = bySurfaceIndex.get(cursor)
      if (resultNode?.type !== 'tool/result') {
        failed = 'unpaired'
        break
      }
      if (resultNode.surfaceOp !== 'append') {
        failed = 'already-archived'
        break
      }
      if (resultNode.data?.error !== undefined || resultNode.data?.message?.isError === true) {
        failed = 'failed-result'
        break
      }
      const source = resultNode.data?.message?.source
      if (!source || source.kind !== 'tool' || source.callId !== callId) {
        failed = 'unpaired'
        break
      }
      const blocks = resultNode.data?.message?.content
      if (!Array.isArray(blocks) || blocks.length === 0) {
        failed = 'no-content'
        break
      }
      if (blocks.some((block) => !block || block.type !== 'text' || typeof block.text !== 'string')) {
        failed = 'non-text-content'
        break
      }
      entries.push({
        name: calls[callIndex].name,
        arguments: typeof calls[callIndex].arguments === 'string' ? calls[callIndex].arguments : '',
        text: resultTextOf(blocks),
        callId,
        blockIndex: callBlockIndexes[callIndex] ?? null,
        resultMessageId: resultNode.data?.message?.id ?? null,
      })
      cursor += 1
    }
    if (failed) {
      skip.set(seq, failed)
      continue
    }
    if (cursor - 1 >= total) {
      skip.set(seq, 'unpaired')
      continue
    }

    const endIndex = cursor - 1
    if (endIndex > index) {
      // Never archive across another assistant node: a nested run would make the
      // range ambiguous and could shadow content that is not part of this operation.
      let nested = false
      for (let scan = index + 1; scan <= endIndex; scan += 1) {
        if (bySurfaceIndex.get(scan)?.type === 'assistant/message') nested = true
      }
      if (nested) {
        skip.set(seq, 'unpaired')
        continue
      }
    }

    const turn = assistant.data?.turn
    // Labelled, not fenced: the planner may cool the current turn, and the
    // report says so rather than hiding it.
    const inOpenTurn = Number.isInteger(openTurn) && Number.isInteger(turn) && turn >= openTurn

    const assistantText = assistantTextOf(content)
    const assistantReasoning = assistantReasoningOf(content)
    const body = buildArchiveBody({ assistantReasoning, assistantText, entries })
    if (body.length < minimumChars) {
      skip.set(seq, 'too-short')
      continue
    }
    // Size is no longer a reason to refuse: a large body is split into
    // read-back-sized chunks instead. Only a pathological total is refused.
    const bodyBytes = Buffer.byteLength(body, 'utf8')
    if (bodyBytes > MAX_OPERATION_TOTAL_BYTES) {
      skip.set(seq, 'too-large')
      continue
    }

    let originalTokens = 0
    for (let scan = index; scan <= endIndex; scan += 1) {
      originalTokens += measuredNodes[scan]?.heuristicTokens ?? measuredNodes[scan]?.tokens ?? 0
    }

    // Deterministic receipt metadata (C-13). Both are read straight off the
    // call arguments and the result text — no model call, no summary — and they
    // are computed here, once, so the receipt written at commit time and the
    // receipt rebuilt at restore time are byte-identical.
    const locators = calls.map((block) => extractCallLocator(block))
    const statuses = entries.map((entry) => resultStatusOf(entry.text))

    candidates.push({
      rangeStart: seq,
      rangeEnd: surfaceNodes[endIndex],
      surfaceStartIndex: index,
      surfaceEndIndex: endIndex,
      shadowedSeqs: surfaceNodes.slice(index, endIndex + 1),
      callIds,
      tools: entries.map((entry) => entry.name),
      locators,
      statuses,
      /**
       * 真实来源坐标（与 callIds 同序）：冷库配对索引只照抄这些字段，
       * 缺失时如实标 null，由适配器决定跳过而不是伪造。
       */
      sources: entries.map((entry) => ({
        callId: entry.callId,
        toolName: entry.name,
        blockIndex: entry.blockIndex,
        messageId: assistantMessageId,
        resultMessageId: entry.resultMessageId,
      })),
      body,
      chars: body.length,
      originalTokens,
      turn,
      step: assistant.data?.step,
      /** Cold nodes this operation will occupy; 1 unless the body is large.
       * 与应用端同口径（canonicalizeBody 后再分块），避免正文需要规范化时
       * 计划期计数与实际占用漂移。 */
      chunkCount: chunkArchiveBody(canonicalizeBody(body)).length,
      /** Inside the newest `retainOperations` operations: the baseline, not a fence. */
      withinRetention: index >= retentionFromIndex,
      inOpenTurn,
    })
  }

  candidates.sort((a, b) => a.rangeStart - b.rangeStart)
  const skipped = [...skip.entries()]
    .map(([seq, reason]) => ({ seq, reason, description: describeSkip(reason) }))
    .sort((a, b) => a.seq - b.seq)
  return { candidates, skipped, lastAssistantSeq }
}

/**
 * Choose the operations to archive in one batch.
 *
 * Retention is the only trigger: every candidate older than the newest
 * `retainOperations` operations is archived once the batch threshold is met.
 * There is no occupancy safety net — the retention count is the entire budget.
 * The batch waits until `batchSize` operations have piled up, because each
 * submitted batch invalidates the prefix cache from its oldest touched node
 * onward, so batch *count* is the cost driver. Measured on a real 1M-window
 * session: batching 10 costs 0.16× the do-nothing baseline, batching 1 costs
 * 0.57×.
 *
 * Ordering is by source event seq, never by size, tool name, or randomness, and
 * the receipt's own estimated cost is subtracted.
 *
 * @param batchSize - how many out-of-window candidates must accumulate before
 *   a batch submits.
 * @returns the plan.
 */
export function planCooling({
  candidates = [],
  meter,
  nodeIdFor,
  retainOperations = 0,
  batchSize = 1,
  maxOperations = 64,
  minNetReleaseTokens = 128,
  // C-12 fence, enforced here too in case a caller hands in stale candidates:
  // operations at or after this surface seq belong to the model's current turn.
  archiveFromSeq = null,
  // One-batch release ceiling in estimated tokens: a burst of huge operations
  // must not empty the whole backlog in a single step (C-07 sizing).
  maxReleaseTokens = Number.POSITIVE_INFINITY,
  // Receipt identity marker: v1 uses the default, v2 passes its own so the two
  // engines' receipts never impersonate each other in the log.
  receiptMarker = RECEIPT_MARKER,
  // Optional per-candidate gate. v2 passes the exposure/pairing guard here so a
  // guarded range is rejected before a node id is rented — the same discipline
  // as `not-yet-exposed`: rejection must leave no claim behind. v1 passes
  // nothing and keeps its behaviour unchanged.
  guard = null,
  // Optional receipt renderer. v1's receipt names tools and callIds; v2 also
  // archives spans that have neither (plain user/assistant text, old receipts,
  // old cards), and a tool-shaped receipt would misdescribe them. The default
  // keeps v1 byte-identical.
  receiptOf = null,
}) {
  const units = []
  const rejected = []
  let plannedReleaseTokens = 0
  let releaseCapped = false

  /**
   * 尺寸／净释放预判 + 组装单元（**有副作用**：会租用冷节点 id）。
   *
   * 只对已经通过保护门禁的候选调用；调用者必须先确认"可能凑够一批"，否则
   * 等待期里每个候选都会被白租一个节点 id。v2 的跨度回执走 `receiptOf` 缝，
   * 缺省保持 v1 的逐字节形态。
   */
  function prepare(candidate) {
    const nodeId = nodeIdFor(candidate)
    const hash = archiveMac(candidate.body)
    const receipt = typeof receiptOf === 'function'
      ? receiptOf(candidate, {
        nodeId,
        hash,
        chars: candidate.chars,
        tokens: candidate.originalTokens,
        chunks: candidate.chunkCount ?? 1,
        marker: receiptMarker,
      })
      : buildReceipt({
        tools: candidate.tools,
        range: { start: candidate.rangeStart, end: candidate.rangeEnd },
        callIds: candidate.callIds,
        nodeId,
        hash,
        chars: candidate.chars,
        tokens: candidate.originalTokens,
        chunks: candidate.chunkCount ?? 1,
        marker: receiptMarker,
        locators: candidate.locators ?? [],
        statuses: candidate.statuses ?? [],
      })
    const receiptTokens = meter.estimateMessage({
      role: 'user',
      content: [{ type: 'text', text: receipt }],
    })
    const netReleaseTokens = candidate.originalTokens - receiptTokens
    if (netReleaseTokens < minNetReleaseTokens) {
      rejected.push({ rangeStart: candidate.rangeStart, reason: 'below-min-release', description: describeSkip('below-min-release') })
      return null
    }
    return { ...candidate, nodeId, hash, receipt, receiptTokens, netReleaseTokens }
  }

  // ── 阶段 1：保护门禁（无副作用）────────────────────────────────────────────
  //
  // 顺序按契约固定：结构合格 → 排除硬保护／有效额外保护 → 排除最近 N 个操作
  // → 检查尺寸／净释放 → **对剩余合格候选计数** → 攒够 B 个才提交。
  //
  // 上一版把"窗口外数量"当成够批依据，于是"10 个窗口外、8 个受保护、B=5"这种
  // 情况会立即提交只剩 2 段的短批——既违背 B 的语义，又在受保护比例高时频繁
  // 替换历史（每次替换都要重算前缀缓存）。现在门槛只数**过滤后**仍合格的候选。
  const outOfWindow = candidates.filter((candidate) => !candidate.withinRetention)
  const threshold = Math.max(1, batchSize)
  const admissible = []
  for (const candidate of outOfWindow) {
    if (archiveFromSeq !== null && candidate.rangeStart >= archiveFromSeq) {
      rejected.push({ rangeStart: candidate.rangeStart, reason: 'not-yet-exposed', description: describeSkip('not-yet-exposed') })
      continue
    }
    if (typeof guard === 'function') {
      // 门禁先于任何副作用（不发节点 id、不写声明）：被拒的候选不得留下痕迹。
      const verdict = guard(candidate)
      if (verdict && verdict.safe !== true) {
        rejected.push({
          rangeStart: candidate.rangeStart,
          reason: verdict.code ?? 'guard-rejected',
          description: verdict.reason || '守卫层拒绝降温',
        })
        continue
      }
    }
    admissible.push(candidate)
  }

  // ── 够批门槛只数「插件自己造的」以外的候选（countable）──────────────────────
  //
  // 插件注入的工作状态卡/回注包也是合法候选（否则旧卡永远退不了热），但它们**不能
  // 计入够批门槛**：卡片由插件自己产生，替换掉旧卡会立刻注入新卡，新卡再凑满下一批，
  // 于是插件把自己写进了自激循环。实测会话 181 个批次里 484 条 turn.user 全是插件卡片，
  // 4 条真实人类消息一条都没被归档——批次完全由插件自激撑起。
  //
  // 拆成两堆：`countable` 决定是否够批；`piggyback` 只在批次已经因为 countable 够批时
  // 搭车替换（它们本来就在候选里，不搭车就会一直占着常驻窗口）。这样卡片的常驻上限
  // 天然是「到下一次够批为止」，不需要另加注入侧机制。
  const countable = admissible.filter((candidate) => candidate.pluginAuthored !== true)
  const piggyback = admissible.filter((candidate) => candidate.pluginAuthored === true)

  // ── 阶段 2：尺寸／净释放预判（有副作用，但只在可能够批时执行）──────────────
  //
  // 找到 `threshold` 个合格候选就停：够批与否已经确定，没必要为整条积压租节点。
  // 搭车的卡片不占门槛名额，所以先取 countable，再补 piggyback。
  const ready = []
  // 搭车单元的身份必须单独记：它们**不占门槛名额**（注释里的语义），但提交循环
  // 曾用同一个计数器数它们，于是「countable 刚好填满 threshold」时循环在第一句
  // 就 break，piggyback 一条都进不了 units（gate/p-12 X30）。用集合记住身份，
  // 计数与上限仍共用同一个循环体，避免出现第二份提交逻辑。
  const piggybackUnits = new Set()
  if (countable.length >= threshold) {
    for (const candidate of countable) {
      if (ready.length >= threshold) break
      const unit = prepare(candidate)
      if (unit) ready.push(unit)
    }
    for (const candidate of piggyback) {
      const unit = prepare(candidate)
      if (unit) {
        piggybackUnits.add(unit)
        ready.push(unit)
      }
    }
  }

  // ── 阶段 3：提交（严格批上限 + 单批释放软上限）────────────────────────────
  const baselineReady = ready.length >= threshold
  let baselineUnits = 0
  if (baselineReady) {
    for (const unit of ready) {
      // 门槛只数 countable：搭车单元不占名额（与阶段 2 的选取口径一致）。
      if (!piggybackUnits.has(unit) && baselineUnits >= threshold) break
      if (units.length >= maxOperations) break
      if (plannedReleaseTokens > 0 && plannedReleaseTokens + unit.netReleaseTokens > maxReleaseTokens) {
        // Soft ceiling (C-07/C-12): once the batch holds work, stop before
        // exceeding it; the rest waits for the next batch. A batch's first
        // candidate is always admitted — hard-rejecting a lone oversized
        // operation would livelock it as an eternal candidate instead of
        // archiving and parking it.
        releaseCapped = true
        break
      }
      units.push(unit)
      plannedReleaseTokens += unit.netReleaseTokens
      if (!piggybackUnits.has(unit)) baselineUnits += 1
    }
  }

  const archivedFromRetained = units.filter((unit) => unit.withinRetention).length
  // Y-16：prepare() 会为候选租一个冷节点 id（有副作用）。批上限／释放上限在提交
  // 阶段截断时，被截掉的那些单元**已经租了号**却永远不会落盘，声明永久残留——
  // 下一个周期它们既不在 units 里、也不会被任何路径清理。这里如实报出「租了但没用」
  // 的区间，由调用方按同一份事实回收声明（判据只有一处，不在调用点各判一遍）。
  const usedRangeStarts = new Set(units.map((unit) => unit.rangeStart))
  const discardedRangeStarts = ready
    .map((unit) => unit.rangeStart)
    .filter((rangeStart) => !usedRangeStarts.has(rangeStart))
  return {
    units,
    rejected,
    discardedRangeStarts,
    plannedReleaseTokens,
    /** True when the released-token ceiling stopped this batch early (C-07/C-12). */
    releaseCapped,
    archivedFromRetained,
    archivedFromOpenTurn: units.filter((unit) => unit.inOpenTurn).length,
    baselineRetention: retainOperations,
    /** Protected operations remaining after this batch. */
    effectiveRetention: Math.max(0, retainOperations - archivedFromRetained),
    /** Retention bookkeeping, so callers can say "waiting for the batch to fill". */
    batchSize: threshold,
    /** 结构合格且在保留窗口之外——**保护判定前**的数量（不是够批依据）。 */
    outOfWindowCount: outOfWindow.length,
    /** 排除硬保护／有效额外保护后仍合格的候选数：B 的门槛只数这个。 */
    admissibleCount: admissible.length,
    /** 再排除尺寸／净释放不合格后的数量（未够批时不会为整条积压租节点，故可能小于 admissibleCount）。 */
    readyCount: ready.length,
    /**
     * 未够批时还差几个合格候选。区分两种情况：
     * - 保护过滤后就不够：还差 `threshold - admissible.length` 个（这才是用户该知道的数）；
     * - 保护过滤后够、但尺寸／净释放被刷掉：还差 `threshold - ready.length` 个。
     * 用 `ready.length` 一种口径会在高保护比例下报出虚高的差额，把"被保护挡下"说成"攒批中"。
     */
    shortfall: admissible.length >= threshold
      ? Math.max(0, threshold - ready.length)
      : threshold - admissible.length,
    baselineReady,
    baselineUnits,
  }
}

export function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

export function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('操作已取消。')
}

/**
 * Commit one planned batch.
 *
 * `guard` is re-evaluated **immediately before each write**, not just at plan
 * time. The plan is a snapshot: protection is derived from the surface and from
 * durable state, and both can move between planning and committing (a user
 * `/memory-lab pin`, a new recall delivery, a freshly closed tool call). Without
 * the re-check a range that became protected after planning would still be
 * replaced — the exact "stale plan still commits" failure. A revoked unit is
 * skipped with its own state, is never counted as applied, and keeps its cold
 * node claim so the next measurement reuses the same id (idempotent).
 */
export async function applyOperations({ session, client, units, meter, hostVersion, signal, onOutcome, guard = null, bodyOf = null, receiptMarker = RECEIPT_MARKER, batchThreshold = null, batchMembers = null, releaseCapped = false }) {
  const outcomes = []

  // ── 阶段 1：逐单元门禁复核 + 冷写（不替换表面）────────────────────────────
  //
  // P1-5 把「写冷库」与「替换表面」拆开：替换要等一批里全部冷写就绪后按相邻
  // run 合并提交。规划只是快照，保护集合可能在这之后变化（用户 pin、新的回注
  // 投递、刚闭合的调用），守卫仍在**每次写入前**重新判定——被撤销的单元原文
  // 保留、不计入成功、不留冷写痕迹。
  const written = []
  for (const unit of units) {
    if (typeof guard === 'function') {
      const verdict = guard(unit)
      if (verdict && verdict.safe !== true) {
        const revoked = {
          ...unitBaseOf(unit),
          state: 'guard-revoked',
          reason: `提交前复核：规划后新增保护，原文保留。${verdict.reason ?? ''}`,
        }
        outcomes.push(revoked)
        if (onOutcome) await onOutcome(revoked)
        continue
      }
    }
    let outcome
    try {
      throwIfAborted(signal)
      const shadowed = rangeStillCurrent(session, unit)
      if (!shadowed) {
        outcome = { ...unitBaseOf(unit), state: 'stale', reason: '目标区间已不在活动面（surface 已变化）' }
      } else {
        // Re-derive the body from the live events and require it to equal the
        // planned one up to line endings (drift check; the store normalizes
        // CRLF→LF, so the comparison is canonical).
        const liveBody = typeof bodyOf === 'function' ? bodyOf(session, unit) : bodyFromSurface(session, unit)
        if (liveBody === null || canonicalHash(liveBody) !== canonicalHash(unit.body)) {
          outcome = { ...unitBaseOf(unit), state: 'stale', reason: '来源正文已变化（hash 不符）' }
        } else {
          const writtenChunks = await writeUnitColdChunks({ client, unit, signal })
          if (writtenChunks.ok) {
            const verified = await verifyUnitColdChunks({
              client,
              unit,
              chunkIds: writtenChunks.chunkIds,
              chunks: writtenChunks.chunks,
              signal,
            })
            if (verified.ok) written.push({ unit, chunkIds: writtenChunks.chunkIds })
            else outcome = { ...unitBaseOf(unit), ...verified.outcome }
          } else {
            outcome = { ...unitBaseOf(unit), ...writtenChunks.outcome }
          }
        }
      }
    } catch (error) {
      if (signal?.aborted) throw error
      outcome = {
        ...unitBaseOf(unit),
        state: 'orphaned',
        reason: `事务异常，原文保留：${messageOf(error)}`,
      }
    }
    if (outcome) {
      outcomes.push(outcome)
      if (onOutcome) await onOutcome(outcome)
    }
  }

  // ── 阶段 2：相邻成功单元组成连续 run，逐 run 提交一条回执──────────────────
  //
  // 相邻判定以**活动面节点**为准：两个单元之间只要不存在任何活动面节点就相邻
  // （`turn/start`、`turn/end` 这类非表面事件夹在中间不算间隔——表面替换本来就
  // 不会遮蔽它们）。中间隔了不归档的活动面节点（受保护、未够格、或本批冷写失败
  // 的单元）就断开成两条回执——绝不把没有归档的节点卷进替换范围。run 长度为 1
  // 时回执与逐条替换字节一致（旧行为）。
  const surfaceSeqs = new Set(session.surface.nodes)
  const adjacentOnSurface = (left, right) => {
    if (!(left.rangeEnd < right.rangeStart)) return false
    for (const seq of surfaceSeqs) {
      if (seq > left.rangeEnd && seq < right.rangeStart) return false
    }
    return true
  }
  let index = 0
  while (index < written.length) {
    let end = index + 1
    while (end < written.length && adjacentOnSurface(written[end - 1].unit, written[end].unit)) end += 1
    const run = written.slice(index, end)
    index = end
    let committed
    try {
      // 0.13.1（F2）：一条回执只覆盖**本 run**（相邻段）。整批成员数由
      // `batchMembers` 单独携带，段内成员数由 run.length 决定——两个数在回执里
      // 分别出现，否则「本批 3/3」会被误印到只含 2 个成员的段上。
      committed = commitSurfaceRun({
        session,
        meter,
        run,
        receiptMarker,
        hostVersion,
        batchThreshold: Number.isInteger(batchThreshold) ? batchThreshold : units.length,
        batchMembers: Number.isInteger(batchMembers) ? batchMembers : units.length,
        releaseCapped: releaseCapped === true,
      })
    } catch (error) {
      if (signal?.aborted) throw error
      committed = {
        outcomes: run.map(({ unit, chunkIds }) => ({
          ...unitBaseOf(unit),
          state: 'orphaned',
          reason: `事务异常，原文保留：${messageOf(error)}`,
          orphanNodeIds: [...chunkIds],
        })),
      }
    }
    for (const outcome of committed.outcomes) {
      outcomes.push(outcome)
      if (onOutcome) await onOutcome(outcome)
    }
  }
  return outcomes
}

/**
 * The newest user-authored message in one claimed batch, which is the recall query.
 *
 * This reads the *entering batch*, not the surface: `agent/pre-step` runs before
 * the loop appends the accepted batch to history, so the current turn's prompt
 * is not on the surface yet. Messages this plugin injected carry their own
 * source kind and are never used as a query.
 *
 * @returns `{ id, text }` or null when the batch holds no user-authored prompt.
 */
export function recallQueryFrom(messages) {
  if (!Array.isArray(messages)) return null
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!message || message.role !== 'user') continue
    // 插件自己注入的卡片 / 回注包 / 回执一律不作为查询：它们不是人类提问，
    // 拿它们当查询只会让回注内容自己触发自己（审计 P0-3 的「召回触发」）。
    if (message.source?.kind === PACKAGE_NAME) continue
    if (isPluginAuthoredMessage(message)) continue
    // 只接受人类本人写的提示。此前这里有一条「别的 source kind 也先留着当兜底」
    // 的分支，实测（session-7c6b98e7）里它 15 次回注中有 12 次选中了宿主的
    // `time-context` 环境快照：快照 id 每步都新，`recallQueryId` 去重因此永远
    // 失效，每个新快照都触发一次回注，且命中的是与本步无关的历史 read/pwsh 记录。
    // 拿不到人类提示就返回 null —— 失败关闭，宁可不回注，也不拿环境快照当查询。
    if (!isHumanAuthoredMessage(message)) continue
    const text = textFromContent(message.content)
    if (!text) continue
    return { id: typeof message.id === 'string' ? message.id : `index-${index}`, text }
  }
  return null
}
