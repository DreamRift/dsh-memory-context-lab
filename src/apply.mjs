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
  batchReleaseCeilingOf,
  MAX_BATCH_RELEASE_WINDOW_RATIO,
  RECEIPT_FORMAT_LEGACY,
  RECEIPT_FORMAT_OPERATION,
  RECEIPT_FORMAT_SPAN,
  RECEIPT_FORMAT_SPAN_V2,
  RECEIPT_FORMAT_VERSION,
  RECEIPT_MARKER,
  resultStatusOf,
  textFromContent,
} from './core.mjs'
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

/** First 12 hex characters, enough to detect drift without carrying the body. */
export function shortHash(hash) {
  return String(hash ?? '').slice(0, 12)
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

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('操作已取消。')
}

/** Confirm a candidate range is still exactly the current surface range it was planned against. */
export function rangeStillCurrent(session, unit) {
  const nodes = session.surface.nodes
  const startIdx = nodes.indexOf(unit.rangeStart)
  const endIdx = nodes.indexOf(unit.rangeEnd)
  if (startIdx === -1 || endIdx === -1 || startIdx > endIdx) return null
  const current = nodes.slice(startIdx, endIdx + 1)
  if (current.length !== unit.shadowedSeqs.length) return null
  for (const [offset, seq] of current.entries()) {
    if (seq !== unit.shadowedSeqs[offset]) return null
  }
  return current
}

/** One canonical reader for a tool result's text, shared by planning and commit. */
function resultTextOf(blocks) {
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

/** One canonical reader of an assistant node's own prose, if any. */
function assistantTextOf(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

/**
 * One canonical reader of an assistant node's reasoning, if any.
 *
 * Reasoning is part of the archived operation for two reasons. It is eligible
 * (see the block-type check above), so a node carrying it is archived whole;
 * and the host prices it as surface tokens exactly like text, so leaving it out
 * of the cold body would silently drop occupancy the release estimate had
 * already counted. Both call sites must read it the same way, or the drift
 * check in `bodyFromSurface` would compare a body against itself and pass while
 * the cold store held less than the original.
 */
function assistantReasoningOf(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block?.type === 'reasoning' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

/**
 * Rebuild the archived body for one unit from the live surface events.
 *
 * @returns the body, or null when the range no longer matches the unit's shape.
 */
export function bodyFromSurface(session, unit) {
  const assistant = session.eventAt(unit.rangeStart)
  if (assistant?.type !== 'assistant/message') return null
  const content = assistant.data?.message?.content
  if (!Array.isArray(content)) return null
  const calls = content.filter((block) => block?.type === 'tool-call')
  if (calls.length !== unit.callIds.length) return null
  for (const [index, callId] of unit.callIds.entries()) {
    if (calls[index]?.id !== callId) return null
  }
  const entries = []
  for (const [index, callId] of unit.callIds.entries()) {
    const result = session.eventAt(unit.shadowedSeqs[index + 1])
    if (result?.type !== 'tool/result') return null
    if (result.data?.message?.source?.callId !== callId) return null
    if (result.data?.error !== undefined || result.data?.message?.isError === true) return null
    entries.push({
      name: typeof calls[index].name === 'string' ? calls[index].name : 'tool',
      arguments: typeof calls[index].arguments === 'string' ? calls[index].arguments : '',
      text: resultTextOf(result.data?.message?.content),
    })
  }
  return buildArchiveBody({
    assistantReasoning: assistantReasoningOf(content),
    assistantText: assistantTextOf(content),
    entries,
  })
}

/**
 * Commit one archive unit.
 *
 * Order is fixed and durable: verify the range is unchanged, persist the cold
 * record, read it back and verify the hash, append the log-only prune record,
 * then the single replacement node, then verify the resulting surface.
 */
/** Outcome fields every per-unit row carries, independent of how the batch commits. */
function unitBaseOf(unit) {
  return {
    rangeStart: unit.rangeStart,
    rangeEnd: unit.rangeEnd,
    callIds: unit.callIds,
    tools: unit.tools,
    // 被替换对象的种类（工具操作 / 普通历史段）随 outcome 一路带到冷写与归档行：
    // 归档行只记 range 与工具名，审计时 67 条 span 记录全被读成 `operation`，
    // 非工具跨度（用户/助手正文、旧回执）在账本里无法与工具操作区分（P2-5(h)）。
    // 非字符串一律归一成 null，避免把 `undefined` 写进持久状态。
    spanKind: typeof unit.spanKind === 'string' && unit.spanKind ? unit.spanKind : null,
    nodeId: unit.nodeId,
    hash: unit.hash,
    chars: unit.chars,
    originalTokens: unit.originalTokens,
    receiptTokens: unit.receiptTokens,
    netReleaseTokens: unit.netReleaseTokens,
    // Receipt metadata travels with the outcome so the durable row can rebuild
    // the exact same receipt text at restore time (see `restoreReceipts`).
    locators: unit.locators ?? [],
    statuses: unit.statuses ?? [],
    // BUG-001：普通历史段用专用格式（buildSpanReceipt），操作段仍是 4
    // （buildReceipt）。规划期候选带着格式与标签一路传到归档行；恢复侧按行
    // 内版本 dispatch，绝不拿另一种渲染器去猜。
    receiptFormat: Number.isInteger(unit.receiptFormat) ? unit.receiptFormat : RECEIPT_FORMAT_VERSION,
    spanLabel: typeof unit.spanLabel === 'string' && unit.spanLabel ? unit.spanLabel : null,
    // 0.12.0：读取账本键与首错行随归档行落盘。前者让「同键重读」在重启后仍可对账，
    // 后者让 format 6/7 的回执能被逐字节重建（status 行依赖它）。
    readKeys: Array.isArray(unit.readKeys) ? [...unit.readKeys] : [],
    firstErrorLine: typeof unit.firstErrorLine === 'string' && unit.firstErrorLine ? unit.firstErrorLine : null,
  }
}

/**
 * Persist one unit's body as cold chunks (with probe-reuse) and verify read-back.
 *
 * 提取自 `applyOneOperation` 的冷写段（P1-5）：批次合并提交需要「先写冷库、
 * 后统一替换表面」，所以冷写必须能脱离表面替换独立执行。失败语义与原实现一致，
 * 调用方把它并进自己的 base 字段：
 *
 * - 正文为空 → `orphaned`（不可重试，无节点残留）；
 * - 目标 ordinal 被他人占用 → `cold-write-failed`（不可重试，残留如实上报，
 *   绝不删除别人的节点）；
 * - 写入失败 → `cold-write-failed`（可重试；已落地分块保留，重试按 hash 复用）；
 * - 回读不符 → `orphaned`（可重试；先删后写语义由重试在同一 ordinal 上完成）。
 *
 * @returns `{ ok: true, chunkIds }` 或 `{ ok: false, outcome }`。
 */
async function writeUnitColdChunks({ client, unit, signal }) {
  // A body larger than one node's read-back limit is split on line boundaries;
  // every chunk is verified on its own, so read-back fidelity is preserved no
  // matter how large the operation is. This is what keeps a big `read` or
  // `edit` archivable at all. Chunks are canonicalized before they are hashed
  // and written: the store normalizes CRLF→LF, so writing the canonical form
  // makes the round-trip byte-identical and the read-back comparison exact,
  // not just equivalent.
  const chunks = chunkArchiveBody(canonicalizeBody(unit.body))
  if (chunks.length === 0) {
    // 没有正文可写，也没有节点可删；重试不会改变结论，交给 runBatch 的上界收敛。
    return { ok: false, outcome: { state: 'orphaned', retryable: false, reason: '归档正文为空，原文保留' } }
  }
  const chunkIds = chunks.map((_, index) => archiveChunkNodeId(unit.nodeId, index))
  // Probe before writing. A unit that already wrote some chunks on an earlier
  // attempt must REUSE those nodes instead of re-writing: the isolated store is
  // write-once per node id, so a repeat write of the same id with the same body
  // would be queued for review (not committed) and a repeat write with a
  // different body would collide with whoever owns the node first. Reusing the
  // exact bytes that are already there is what makes a failed unit's retry
  // succeed instead of deterministically failing the read-back hash again.
  const reusableChunks = new Set()
  const writableChunks = []
  for (const [index, text] of chunks.entries()) {
    let existing = null
    try {
      existing = await client.getNode(chunkIds[index], signal)
    } catch {
      // The read-ahead failure is not fatal: the write path re-verifies every
      // chunk anyway, and a probe misfire must not block a first-time write.
      existing = null
    }
    if (existing && existing.ok) {
      const existingBody = normalizeColdBody(coldRecordBody(existing.content))
      // Canonical compare on both sides: a node written before this fix may
      // hold CRLF while the planned chunk is already canonical (or vice
      // versa). Same content under canonicalization is the same archive.
      if (canonicalHash(existingBody) === canonicalHash(text)) {
        reusableChunks.add(index)
        continue
      }
      return {
        ok: false,
        outcome: {
          state: 'cold-write-failed',
          // 换号是唯一出路：这个 ordinal 已被别人的正文占住，既不能复用也不能覆写。
          // `retryable: false` 让 runBatch 丢掉声明并把它记成 remint 占用（见 P0-1）。
          // 绝不删这个节点——无法证明它是我们自己写坏的孤儿，宁可留作残留并如实上报。
          retryable: false,
          // 残留（不是我们的可删孤儿）：无法证明这个 id 上的正文是自己写坏的，
          // 因此绝不删，只在 status 里如实上报，让占用率不被悄悄污染。
          residueNodeIds: [...chunkIds],
          reason: `冷节点 ${chunkIds[index]} 已被不同正文占用，拒绝覆写（保护既有内容），换号重试`,
        },
      }
    }
    writableChunks.push([index, text])
  }
  const writeFailures = []
  for (const [index, text] of writableChunks) {
    try {
      await client.rememberArchived({
        nodeId: chunkIds[index],
        text,
        range: { start: unit.rangeStart, end: unit.rangeEnd },
        tools: unit.tools,
        callIds: unit.callIds,
        // Real host coordinates for the cold store's pairing index; only the
        // v2 client consumes them. v1's client ignores unknown keys.
        sources: unit.sources ?? null,
        // v2 用跨度种类区分「工具操作」与普通历史段，回执文案与冷库记录都按它分支。
        spanKind: unit.spanKind ?? null,
        // D4：插件来源跨度（工作状态卡/回注包/回执）的作者事实随冷记录落库，
        // 检索索引同步、命中过滤与回注文案按它区分插件工作资料与人类消息。
        pluginAuthored: unit.pluginAuthored === true,
        contentHash: index === 0 ? unit.hash : archiveMac(text),
        chunk: index + 1,
        chunkCount: chunks.length,
        signal,
      })
    } catch (error) {
      writeFailures.push(`第 ${index + 1}/${chunks.length} 段：${messageOf(error)}`)
      break
    }
  }
  if (writeFailures.length) {
    // Nothing was replaced, so the originals are intact. The chunks that did land
    // stay under this unit's own ordinal and are deliberately NOT deleted: the
    // retry's probe finds them by canonical hash and reuses them, so the same
    // ordinal is re-used instead of minting a new id and leaving the bytes behind
    // unreferenced (审计 P0-1). The count of cold nodes therefore still matches the
    // count of receipts after the retry succeeds.
    return {
      ok: false,
      outcome: { state: 'cold-write-failed', retryable: true, reason: `冷库写入失败：${writeFailures.join('；')}` },
    }
  }
  return { ok: true, chunkIds, chunks }
}

/** Read every written chunk back and verify it against the planned body. */
async function verifyUnitColdChunks({ client, unit, chunkIds, chunks, signal }) {
  // Read every chunk back and verify it. The whole-body hash is checked too, so
  // a mis-ordered or truncated reassembly cannot pass.
  const readBackProblems = []
  const reassembled = []
  for (const [index, nodeId] of chunkIds.entries()) {
    let readBack
    try {
      readBack = await client.getNode(nodeId, signal)
    } catch (error) {
      readBackProblems.push(`第 ${index + 1} 段回读失败：${messageOf(error)}`)
      break
    }
    if (!readBack || readBack.ok === false) {
      readBackProblems.push(`第 ${index + 1} 段回读不存在（${readBack?.error ?? 'unknown'}）`)
      break
    }
    const body = normalizeColdBody(coldRecordBody(readBack.content))
    // Chunks were written in canonical form, so the read-back must match the
    // canonical bytes exactly; a leftover pre-fix node with CRLF still
    // matches under canonicalization and is reused rather than re-written.
    if (canonicalHash(body) !== canonicalHash(chunks[index])) {
      readBackProblems.push(`第 ${index + 1} 段回读正文与写入内容 hash 不符`)
      break
    }
    reassembled.push(body)
  }
  if (readBackProblems.length) {
    // 先删后写（P0-1）：回读对不上说明这个 ordinal 上的字节已经不可信，留着只会
    // 在每次重试里继续 mismatch。删掉它们、**保留同一个 ordinal**，下一次重试把
    // 同一批 id 重新写一遍——区间数、回执数、冷库条目数因此重新对齐。
    return {
      ok: false,
      outcome: {
        state: 'orphaned',
        retryable: true,
        orphanNodeIds: [...chunkIds],
        reason: `${readBackProblems.join('；')}，原文保留`,
      },
    }
  }
  if (canonicalHash(reassembled.join('')) !== canonicalHash(unit.body)) {
    return {
      ok: false,
      outcome: {
        state: 'orphaned',
        retryable: true,
        orphanNodeIds: [...chunkIds],
        reason: '分块回读拼接后与原文 hash 不符，原文保留并标记 orphaned',
      },
    }
  }
  return { ok: true }
}

/**
 * Commit one contiguous run of already-written units as a single surface replacement.
 *
 * P1-5：一批里**区间相邻**的单元共用一条回执消息——逐条模板回执每批重复同一批
 * 样板（实测 ≈185k token/会话的重复注入），合并后样板头尾只付一次。语义约束：
 *
 * - run 内单元的宿主 seq 必须严格相邻（`prev.rangeEnd + 1 === next.rangeStart`），
 *   由调用方分组保证；中间隔了不归档的节点（受保护/未够格）就分成两条回执，
 *   绝不把别人的节点卷进替换范围。
 * - run 长度为 1 时**字节兼容旧行为**：回执用规划期算好的 `unit.receipt`
 *   （含 locators/statuses 的 format-2 逐条回执），restore 的旧路径原样可用。
 * - run 长度 > 1 时用 `buildBatchReceipt`（format-3 批次摘要，`receiptMarker`
 *   必须由调用方传入——规划期不知道 run 的形状，摘要只能在提交期渲染）；
 *   每个成员行都带冷记录与 hash，恢复侧按归档行分组重建同一文本后整组还原。
 * - prune 事件每个 run 一条（shadowedRange 覆盖整段 run）；per-unit 的
 *   `shadowedTokenCount` 仍逐单元实测并随各自归档行落盘（P0-2 对账口径不变）。
 *
 * 失败关闭：替换失败时 run 内**全部**单元按 `orphaned`（可重试）处理——冷节点
 * 已写好且校验通过，重试在各自 ordinal 上重写；同一 run 同生共死，避免出现
 * 「半条摘要回执」这种不可归因的状态。
 */
/**
 * P0-2：宿主校验的是**位置切片**，不是规划期名单。
 *
 * `compaction/prune.shadowedSeqs` 必须逐项等于
 * `surface.slice(surface.indexOf(start), surface.indexOf(end) + 1)`（宿主
 * `dsh-compaction/lib/types/invariant.js`）。规划期按单元算出的
 * `unit.shadowedSeqs` 只覆盖单元自己的节点：区间里若夹着插件自己的回执
 * （seq 数值比区间末尾小/大都可能，位置却落在区间内），它不会进名单 →
 * prune 落盘即非法 → 下次冷加载 `SessionFormatError`，紧随的 replace 也被
 * 宿主拒（`sourceEventSeqs must include every shadowed surface node`），
 * 该区间从此永远归档不掉。
 *
 * 所以在**提交点**按活动面重新取位置切片，并自检：
 * - 两端都还在活动面上、且 start 不晚于 end；
 * - 每个单元自己的节点仍按序出现在切片里（单元没被换掉内容）。
 * 任何一条不满足就失败关闭：不写 prune、不做替换，原文保留。
 *
 * @returns {{ok: true, seqs: number[]} | {ok: false, reason: string}}
 */
function resolveCommitSpan(session, run) {
  const liveNodes = Array.isArray(session.surface?.nodes) ? session.surface.nodes : []
  const startSeq = run[0].unit.rangeStart
  const endSeq = run[run.length - 1].unit.rangeEnd
  const liveStart = liveNodes.indexOf(startSeq)
  const liveEnd = liveNodes.indexOf(endSeq)
  if (liveStart < 0 || liveEnd < 0 || liveEnd < liveStart) {
    return { ok: false, reason: '提交前复核：目标区间已不在活动面（surface 已变化）' }
  }
  const seqs = liveNodes.slice(liveStart, liveEnd + 1)
  if (seqs.length === 0 || seqs[0] !== startSeq || seqs.at(-1) !== endSeq) {
    return { ok: false, reason: '提交前复核：位置切片与规划区间两端不一致' }
  }
  // 单元自己的节点必须仍按序出现在切片里；夹在中间的外来节点（插件回执等）
  // 允许存在——它们正是本修复要覆盖的情形。
  let cursor = 0
  for (const { unit } of run) {
    for (const seq of unit.shadowedSeqs ?? []) {
      const at = seqs.indexOf(seq, cursor)
      if (at < 0) return { ok: false, reason: `提交前复核：单元 seq ${seq} 已不在区间切片内（surface 已变化）` }
      cursor = at + 1
    }
  }
  return { ok: true, seqs }
}

function commitSurfaceRun({ session, meter, run, receiptMarker = RECEIPT_MARKER, hostVersion, batchThreshold = null, batchMembers = null, releaseCapped = false }) {
  const span = resolveCommitSpan(session, run)
  if (!span.ok) {
    return {
      outcomes: run.map(({ unit, chunkIds }) => ({
        ...unitBaseOf(unit),
        state: 'stale',
        reason: span.reason,
        orphanNodeIds: [...chunkIds],
      })),
    }
  }
  const shadowedSeqs = span.seqs
  const startSeq = run[0].unit.rangeStart
  const endSeq = run[run.length - 1].unit.rangeEnd
  // P0-2 对账口径：回执里的「原 ≈N token」与 `compaction/prune.shadowedTokenCount`
  // 量的是同一个对象、取的都是宿主 meter 的**启发式**那一份（回执 = 规划期
  // Σ heuristicTokens，prune = 提交期 Σ meter.estimateMessage）。合并提交后
  // prune 记整段位置切片的总和，归档行仍逐单元记自己的那份；切片里夹着的
  // 外来节点（插件回执）不属于任何单元，其份额单独记在 run 首单元行上，
  // 对账时相减（`tokenAccountingOf`），既不丢口径也不虚报差额。
  const perUnitTokens = new Map()
  let unitTokens = 0
  for (const { unit } of run) {
    const tokens = sumShadowedTokens(session, meter, unit.shadowedSeqs)
    perUnitTokens.set(unit.nodeId, tokens)
    unitTokens += tokens
  }
  const shadowedTokens = sumShadowedTokens(session, meter, shadowedSeqs)
  const spanExtraTokens = Math.max(0, shadowedTokens - unitTokens)
  const receipt = run.length === 1
    ? run[0].unit.receipt
    : buildBatchReceipt({
      marker: receiptMarker,
      formatVersion: RECEIPT_FORMAT_BATCH_V2,
      runLength: run.length,
      batchThreshold,
      batchMembers,
      releaseCapped,
      members: run.map(({ unit, chunkIds }) => ({
        tools: unit.tools,
        range: { start: unit.rangeStart, end: unit.rangeEnd },
        callIds: unit.callIds,
        nodeId: unit.nodeId,
        hash: unit.hash,
        chars: unit.chars,
        tokens: unit.originalTokens,
        chunks: chunkIds.length,
      })),
    })

  let replacement
  try {
    const prune = session.append('compaction/prune', {
      shadowedRange: { start: startSeq, end: endSeq },
      shadowedSeqs: [...shadowedSeqs],
      shadowedTokenCount: shadowedTokens,
    })
    replacement = session.append('user/message', {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: receipt }],
      source: { kind: PLUGIN_SOURCE_KIND, form: PLUGIN_SOURCE_FORMS.ARCHIVE_RECEIPT },
    }, {
      surfaceOp: { op: 'replace', startSeq, endSeq },
      sourceEventSeqs: [prune.seq, ...shadowedSeqs],
    })
  } catch (error) {
    // 活动面替换失败时冷节点已经写好且校验通过，但回执从未提交——这些字节属于
    // 我们自己的 ordinal 且无人引用。统一按 orphaned 处理：先删后写，下次重试在
    // 同一个 ordinal 上重写，避免「区间数 / 回执数 / 冷库条目数」三者继续漂移。
    // 合并 run 的成员同生共死：摘要回执是原子的，半条摘要不可归因。
    return {
      outcomes: run.map(({ unit, chunkIds }) => ({
        ...unitBaseOf(unit),
        state: 'orphaned',
        retryable: true,
        orphanNodeIds: [...chunkIds],
        reason: `活动面替换失败，原文保留：${messageOf(error)}`,
      })),
    }
  }

  const problems = []
  const after = session.eventAt(replacement.seq)
  if (!session.surface.nodes.includes(replacement.seq)) problems.push('替换事件未进入活动面')
  for (const seq of shadowedSeqs) {
    if (session.surface.nodes.includes(seq)) problems.push(`原节点 seq ${seq} 仍在活动面`)
  }
  if (after?.type !== 'user/message') problems.push('替换事件类型不是 user/message')
  if (textFromContent(after?.data?.content) !== receipt) problems.push('回执正文未保持')
  try {
    session.deriveMessages()
  } catch (error) {
    problems.push(`活动面无法构建下一次请求：${messageOf(error)}`)
  }
  // 这些字段描述的是「已经提交到活动面的那次替换」，与校验是否通过无关：
  // 原文已经被回执遮蔽，冷库里的分块是它唯一的副本。恢复路径（`restoreReceipts`
  // 的批次分组、`restoreLegacyReceipt` 重建回执正文）必须能读到与实际写入一致
  // 的 `receiptFormat`/`chunkCount`/`chunkIds`，否则 `verify-failed` 行会被重建
  // 成另一种格式而比对失败（「回执正文已变化，拒绝覆盖」），原文永久不可恢复。
  // 只有 `state` 与 `reason` 随校验结果分叉。
  return {
    outcomes: run.map(({ unit, chunkIds }, index) => ({
      ...unitBaseOf(unit),
      replacementSeq: replacement.seq,
      /** Cold nodes this operation occupies; restore reads them back in order. */
      chunkCount: chunkIds.length,
      chunkIds: [...chunkIds],
      /** This unit's own share of `compaction/prune.shadowedTokenCount`; carried for P0-2 对账. */
      shadowedTokenCount: perUnitTokens.get(unit.nodeId) ?? 0,
      surfaceGeneration: session.surface.replaceGeneration,
      hostVersion: hostVersion ?? 'unknown',
      /**
       * 位置切片里不属于任何单元的那部分 token（插件回执等）。它进了
       * `compaction/prune.shadowedTokenCount`，但不该算到任何一个单元头上：
       * 记在 run 首单元行，对账时减掉（见 `tokenAccountingOf`）。
       */
      ...(index === 0 && spanExtraTokens > 0 ? { spanExtraTokens } : {}),
      ...(run.length > 1
        ? {
            receiptFormat: RECEIPT_FORMAT_BATCH_V2,
            // 0.13.1（F2）：batchSize 保留为「本段相邻数」以兼容既有账本读取，
            // 新增三个字段把口径写清楚——restore 重建回执时按同一组值渲染。
            batchSize: run.length,
            ...(Number.isInteger(batchThreshold) ? { batchThreshold } : {}),
            ...(Number.isInteger(batchMembers) ? { batchMembers } : {}),
            ...(releaseCapped === true ? { releaseCapped: true } : {}),
          }
        : {}),
      ...(problems.length
        ? { state: 'verify-failed', reason: problems.join('；') }
        : { state: 'applied', reason: '' }),
    })),
  }
}

export async function applyOneOperation({ session, client, unit, meter, hostVersion, signal, bodyOf = null }) {
  const base = unitBaseOf(unit)
  throwIfAborted(signal)

  const shadowed = rangeStillCurrent(session, unit)
  if (!shadowed) return { ...base, state: 'stale', reason: '目标区间已不在活动面（surface 已变化）' }
  // Re-derive the body from the live events and require it to equal the planned
  // one up to line endings. This is the drift check: the surface range being
  // present is not enough, because a same-shaped range could hold different
  // content. The store normalizes CRLF→LF, so the comparison is canonical.
  const liveBody = typeof bodyOf === 'function' ? bodyOf(session, unit) : bodyFromSurface(session, unit)
  if (liveBody === null || canonicalHash(liveBody) !== canonicalHash(unit.body)) {
    return { ...base, state: 'stale', reason: '来源正文已变化（hash 不符）' }
  }

  const written = await writeUnitColdChunks({ client, unit, signal })
  if (!written.ok) return { ...base, ...written.outcome }
  const verified = await verifyUnitColdChunks({ client, unit, chunkIds: written.chunkIds, chunks: written.chunks, signal })
  if (!verified.ok) return { ...base, ...verified.outcome }

  const committed = commitSurfaceRun({
    session,
    meter,
    run: [{ unit, chunkIds: written.chunkIds }],
    hostVersion,
  })
  return committed.outcomes[0]
}

/**
 * Σ of the host meter's estimate over the messages this operation shadows.
 *
 * This is exactly what lands in `compaction/prune.shadowedTokenCount`, kept in one
 * place so the archive row can carry the same number for reconciliation (P0-2).
 * A meter that cannot measure one event contributes 0 rather than aborting the
 * archive: the replacement is still correct, only the accounting is degraded.
 */
function sumShadowedTokens(session, meter, shadowedSeqs) {
  let total = 0
  for (const seq of shadowedSeqs ?? []) {
    try {
      total += meter.estimateMessage(session.deriveEventMessage(session.eventAt(seq))) ?? 0
    } catch {
      // 单条测不了不影响归档；缺口由 status 的对账行如实体现。
    }
  }
  return total
}

/**
 * Reconcile the receipt figure with `compaction/prune.shadowedTokenCount` (P0-2).
 *
 * Returns `null` when nothing is comparable (no archived row carries both
 * numbers). `ratio` is `|receipt − prune| / max(prune, 1)`; callers decide the
 * threshold — the point is that a gap is *reported*, never silently averaged away.
 */
export function tokenAccountingOf(rows) {
  let receipt = 0
  let prune = 0
  let compared = 0
  for (const row of rows ?? []) {
    // Applied-only on purpose: this compares the receipt figure against
    // `compaction/prune.shadowedTokenCount`, and a verify-failed row never wrote
    // that prune event, so including it would invent a mismatch.
    if (row?.status !== 'applied') continue
    const r = Number(row.originalTokens)
    const p = Number(row.shadowedTokenCount)
    if (!Number.isFinite(r) || !Number.isFinite(p)) continue
    // 合并提交的 prune 记的是整段位置切片，切片里夹着的插件回执不属于任何单元；
    // 它的份额单独挂在 run 首单元行上，这里减掉才和回执 Σ 比的是同一对象。
    const extra = Number(row.spanExtraTokens)
    receipt += r
    prune += p - (Number.isFinite(extra) ? extra : 0)
    compared += 1
  }
  if (!compared) return null
  return { receipt, prune, compared, ratio: Math.abs(receipt - prune) / Math.max(prune, 1) }
}

/**
 * Read the newest provider-reported usage from the session log, or `undefined`.
 *
 * Only a completed request reports usage, so this describes the *previous*
 * request. That is still the right signal for judging a rewrite: it is the most
 * recent evidence of whether this route is currently serving the prefix from
 * cache.
 */
export function lastUsageOf(session) {
  for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
    const event = session.eventAt(seq)
    if (event?.type === 'assistant/message' && event.data?.usage !== undefined) return event.data.usage
  }
  return undefined
}

/**
 * Same as `lastUsageOf`, but also returns the event seq that carried it.
 *
 * C3/O3（usage 观测）：批提交前后各取一次 usage、把差额记成
 * `observedInvalidationTokens` 的口径需要**幂等结算**——同一个 usage 样本不得
 * 结算两次。usage 对象本身没有稳定标识，携带它的 `assistant/message` seq 单调
 * 递增，正好当标识用：`sample.seq > pending.seq` 才说明「批后出现了新完成的请求」。
 *
 * @returns `{ seq, usage }` or `undefined` when no completed request reported usage.
 */
export function lastUsageWithSeqOf(session) {
  for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
    const event = session.eventAt(seq)
    if (event?.type === 'assistant/message' && event.data?.usage !== undefined) {
      return { seq, usage: event.data.usage }
    }
  }
  return undefined
}

/**
 * Summarize prefix-cache behavior for one usage sample.
 *
 * `cacheReadTokens` is what the provider served from its prefix cache;
 * `inputTokens` is what it had to process as a miss.
 */
export function cacheStatsOf(usage) {
  if (!usage || typeof usage !== 'object') return null
  const uncached = Number(usage.inputTokens)
  const cached = Number(usage.cacheReadTokens ?? 0)
  if (!Number.isFinite(uncached) || !Number.isFinite(cached)) return null
  const total = uncached + cached
  if (total <= 0) return null
  return { uncached, cached, total, hitRatio: cached / total }
}

/** Render the cache line for `status` and `dry-run`. */
export function formatCacheLine(stats) {
  if (!stats) return '前缀缓存：尚无 provider usage 记录（本会话还没有完成的请求）。'
  return `前缀缓存：最近一次请求命中 ${(stats.hitRatio * 100).toFixed(1)}%（缓存 ${stats.cached} / 未命中 ${stats.uncached} token）`
}

/** One-line tally of a batch's per-unit states. */
export function summarizeOutcomes(outcomes) {
  const counts = new Map()
  for (const outcome of outcomes) counts.set(outcome.state, (counts.get(outcome.state) ?? 0) + 1)
  return [...counts.entries()].map(([state, count]) => `${state} ${count}`).join('，') || '无单元'
}

/** Render the occupancy report shown by `status` and `dry-run`. */
export function occupancyLines(occupancy) {
  const {
    host,
    view,
    plan,
    archivedCount = 0,
    cacheStats = null,
  } = occupancy
  // Same denominator the host context meter uses, so this line and the meter agree.
  const current = computeOccupancy(host.assembledTokens, host.contextWindow)
  const lines = [
    `当前模型：${host.provider}/${host.model}`,
    `上下文窗口：${host.contextWindow} token（占用率口径与界面一致：组装输入 ÷ 窗口）`,
    `组装输入估算：≈${host.assembledTokens} token（来源：${host.baselineKind === 'usage' ? '提供方 usage 锚点 + 增量估算' : '宿主 estimator 纯估算'}）`,
    `当前占用率：${current === null ? '无法计算' : `${(current * 100).toFixed(1)}%`}`,
    formatCacheLine(cacheStats),
    // 0.13.1（F3）：单批释放上限过去是隐藏常量，用户只看到「没按 10 个归档」。
    // 现在把它算出来摆在状态里，短批才有可解释的原因。
    `单批释放上限：≈${batchReleaseCeilingOf(host.contextWindow)} token（窗口的 ${(MAX_BATCH_RELEASE_WINDOW_RATIO * 100).toFixed(2)}%）`,
    `候选：${view.candidates.length} 个完整操作可归档（已保护／不合格 ${view.skipped.length} 条）；本批计划释放 ≈${plan.plannedReleaseTokens} token（含回执成本）`,
    `保留最近 ${plan.baselineRetention} 个操作（一直生效）：窗口外待归档 ${plan.outOfWindowCount} 个，`
    + `其中合格 ${plan.admissibleCount ?? plan.outOfWindowCount} 个，`
    + (plan.baselineReady
      ? `已攒够 ${plan.batchSize} 个，本批提交`
      : `未攒够 ${plan.batchSize} 个（还差 ${plan.shortfall ?? 0} 个），暂不提交（攒够即归档，与占用率无关）`),
  ]
  // 够批门槛只数过滤后的合格候选。当保护挡下的比窗口外总数还多时，"窗口外 10 个
  // 却不够 5 个"必须被解释清楚，否则报告看起来像自相矛盾。
  if (!plan.baselineReady && plan.outOfWindowCount > (plan.admissibleCount ?? 0)) {
    const held = plan.outOfWindowCount - (plan.admissibleCount ?? 0)
    const sized = (plan.admissibleCount ?? 0) - (plan.readyCount ?? plan.admissibleCount ?? 0)
    lines.push(`本批暂不提交的原因：窗口外 ${plan.outOfWindowCount} 个里有 ${held} 个被硬保护／有效额外保护挡下`
      + (sized > 0 ? `，另有 ${sized} 个不合格（尺寸／净释放）` : '')
      + `，过滤后只剩 ${plan.readyCount ?? plan.admissibleCount ?? 0} 个，不到批量阈值 ${plan.batchSize}。`)
  }
  if (plan.units.length) {
    lines.push(
      `本批构成：保留窗口外 ${plan.baselineUnits} 个（保留基线 ${plan.baselineRetention} 个未被动用）`,
    )
    if (plan.archivedFromOpenTurn > 0) {
      lines.push(`其中 ${plan.archivedFromOpenTurn} 个属于当前尚未结束的回合。`)
    }
  }
  if (plan.releaseCapped) {
    lines.push(`本批释放达到单批上限，其余候选留到下一批（防止证据一次性大面积退出上下文）。`)
  }
  // C-08: when nothing is archivable the report must say why, not just "0".
  if (!view.candidates.length && view.skipped.length) {
    const tally = new Map()
    for (const entry of view.skipped) tally.set(entry.description ?? entry.reason, (tally.get(entry.description ?? entry.reason) ?? 0) + 1)
    const parts = [...tally.entries()].map(([label, count]) => `${label} ${count} 条`)
    lines.push(`暂无候选：${parts.join('；')}。新证据发送完、离开保留窗口后自动进入下一批。`)
  }
  // 候选存在但一个都没通过门禁时，「计划释放 ≈0」必须带原因：否则用户只看到 0，
  // 无法区分「还没攒够」和「每次都被门禁拒掉」（后者在真实宿主上曾是永久 no-op）。
  if (!plan.units.length && Array.isArray(plan.rejected) && plan.rejected.length) {
    const tally = new Map()
    for (const entry of plan.rejected) {
      const label = entry.description ?? entry.reason ?? '未说明'
      tally.set(label, (tally.get(label) ?? 0) + 1)
    }
    const parts = [...tally.entries()].map(([label, count]) => `${label} ${count} 条`)
    const sample = plan.rejected.slice(0, 4).map((entry) => `seq ${entry.rangeStart}`).join('、')
    lines.push(`候选被门禁拒绝 ${plan.rejected.length} 个（${sample}${plan.rejected.length > 4 ? ' …' : ''}）：${parts.join('；')}。`)
  }
  // 活跃证据保护：为什么某段留下、何时解除、成本多少。由保护集渲染后传进来，
  // 本模块不认识保护来源的语义，只负责按顺序展示。
  if (Array.isArray(occupancy.protectionLines) && occupancy.protectionLines.length) {
    lines.push(...occupancy.protectionLines)
  }
  const held = (plan.rejected ?? []).filter((row) => row.reason === 'protected-evidence'
    || row.reason === 'protected-range-overlap'
    || row.reason === 'stale-protection')
  if (held.length) {
    lines.push(`本批有 ${held.length} 个候选被活跃证据保护挡下（未为凑批量而跨越受保护节点）：`)
    for (const row of held.slice(0, 6)) lines.push(`- seq ${row.rangeStart}：${row.description}`)
    if (held.length > 6) lines.push(`- …其余 ${held.length - 6} 个见保护集明细。`)
  }
  lines.push(`已归档操作：${archivedCount} 个`)
  return lines
}

/** Report one batch: what landed, what did not, and why. */
export function formatBatchReport(result) {
  const lines = [`已归档 ${result.applied} 个操作，释放 ≈${result.releasedTokens} token（估算）。`]
  // `verify-failed` 不等于「未归档」：回执已经提交、原文已被遮蔽，只是替换后的
  // 活动面没通过校验。把它说成「未归档」会让用户以为原文还在表层而错过恢复，
  // 因此单独措辞，并在汇总里提示原文只在冷库。
  const verifyFailed = result.outcomes.filter((outcome) => outcome.state === 'verify-failed').length
  for (const outcome of result.outcomes) {
    const label = outcome.state === 'applied'
      ? '成功'
      : outcome.state === 'verify-failed'
        ? '已归档但校验未通过(verify-failed)'
        : `未归档(${outcome.state})`
    lines.push(`- seq ${outcome.rangeStart}–${outcome.rangeEnd} / ${outcome.tools.join('、')}：${label}${outcome.reason ? ` — ${outcome.reason}` : ''}`)
  }
  if (verifyFailed) {
    lines.push(`本批有 ${verifyFailed} 个单元的原文已被回执遮蔽但校验未通过；原文只在冷库，请用 /memory-lab restore 取回。`)
  }
  if (result.failed.length) lines.push('失败或跳过的单元保留了原文；已归档单元的回执仍然有效。')
  if (result.releaseCapped) lines.push('本批释放达到单批上限，其余候选留到下一批。')
  return lines.join('\n')
}

/** Report one restore pass. */
export function formatRestoreReport(result) {
  const lines = [`已恢复 ${result.restored} 个操作的原文。`]
  for (const outcome of result.outcomes) {
    if (outcome.state === 'forgotten') {
      lines.push(`- seq ${outcome.rangeStart}：未恢复(软遗忘)${outcome.reason ? ` — ${outcome.reason}` : ''}`)
      continue
    }
    const label = outcome.state === 'restored' ? '已恢复' : `跳过(${outcome.state})`
    lines.push(`- seq ${outcome.rangeStart}：${label}${outcome.reason ? ` — ${outcome.reason}` : ''}`)
  }
  if (result.restored) lines.push('恢复以一条 user 消息承载原文正文，内容完整但不还原原来的节点结构。')
  // P2：被软遗忘拦下的行要单独给出可见结局——「没恢复」与「被遗忘拦下」
  // 不能看起来一样，且必须指路 undo 而不是让用户反复重试 restore。
  const forgotten = Number(result.forgotten ?? 0)
  if (forgotten > 0) {
    lines.push(`${forgotten} 个回执因软遗忘未恢复：先用 /memory-lab forget undo 撤销遗忘，再运行 restore。`)
  }
  // P0-2：重试的跳过行必须有可见的结局——「重试后仍跳过」与「从未跳过」不能
  // 看起来一样。仍跳过的行原文依旧只在冷库（依赖未解除），不能让成功计数
  // 把这一点盖掉。
  const retried = Number(result.retriedSkipped ?? 0)
  const still = Number(result.stillSkipped ?? 0)
  if (retried > 0 && still > 0) {
    lines.push(`本次重试了 ${retried} 个上次跳过的回执，其中 ${still} 个仍无法恢复：它们的原文仍只在冷库，回执保持跳过状态，下一次 restore 会再次尝试。`)
  } else if (retried > 0 && forgotten === 0) {
    // G5：`still === 0` 不足以支持「全部取回」——`forgotten` 的行同样没被恢复，
    // 只是它们被软遗忘挡在 aliveRows 之外、根本没进重试集（restore/p-13 X33 的
    // 全遗忘早退就是这种形状）。判据必须是「既没有仍跳过、也没有被遗忘」。
    lines.push(`本次重试了 ${retried} 个上次跳过的回执，全部取回。`)
  }
  return lines.join('\n')
}

/**
 * 把「跳过的逐行原因」压成「N 段：原因」的短清单（0.13.2-beta.3 N-07）。
 *
 * `off` 回执曾经写「仍有 58 段原文未恢复（restore 跳过，原因见上）」，而上面
 * **没有任何原因**——`engine.runRestore()` 的逐行报告整段被丢掉了。字段缺失被
 * 说成用户改了正文，用户唯一能看到的解释就是「原因见上」。
 */
export function describeRestoreSkipReasons(skippedReasons, { maxReasons = 3 } = {}) {
  const rows = Array.isArray(skippedReasons) ? skippedReasons : []
  const items = rows
    .filter((row) => row && typeof row.reason === 'string' && row.reason !== '')
    .map((row) => `${Number(row.count) || 0} 段：${row.reason}`)
  if (items.length === 0) return ''
  const shown = items.slice(0, Math.max(1, maxReasons))
  const more = items.length - shown.length
  return `${shown.join('；')}${more > 0 ? `；另有 ${more} 类原因未列出（见 /memory-lab restore）` : ''}。`
}

/**
 * Decide whether `clean` may delete a session directory.
 *
 * A directory holding receipts that still shadow the active surface must
 * survive a plain clean: deleting it would leave receipts pointing at a cold
 * store that no longer exists.
 */
export function cleanDecision({ pendingReceipts, confirmDelete }) {
  if (pendingReceipts > 0 && confirmDelete !== true) return { refuse: true, pending: pendingReceipts }
  return { refuse: false, pending: pendingReceipts }
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
 * Restore receipts whose replacement is still the current surface node and
 * whose cold body still matches the recorded hash. Anything else is skipped
 * with a reason; no new event is overwritten.
 *
 * P1-5：批次摘要回执（format-3）按 `replacementSeq` 分组整组恢复——同一摘要的
 * 成员行必须连续出现在行列表里且共享同一个替换 seq；摘要正文按归档行重建并
 * 逐字节比对后，一次性替换为**全部成员原文按序拼接**的单条消息。任何成员的
 * 冷节点缺失/hash 不符都让**整组**跳过（fail-closed）：半组恢复会让摘要指向
 * 已经不在冷库里的成员，比全部不恢复更糟。逐条回执（format 1/2）走原路径不变。
 */
export async function restoreReceipts({ session, client, receipts, onOutcome, receiptMarker = RECEIPT_MARKER, rebuildOrphan = false }) {
  const outcomes = []
  const groups = []
  for (const receipt of receipts ?? []) {
    // 0.13.1（F2）：format 3 与 8 都是批次摘要，必须走同一条分组路径。
    // 只认 3 会让新写入的 format 8 行被当成单条回执，永远对不上摘要正文。
    const batch = receipt?.receiptFormat === RECEIPT_FORMAT_BATCH || receipt?.receiptFormat === RECEIPT_FORMAT_BATCH_V2
    const last = groups[groups.length - 1]
    if (batch && last?.batch && last.rows[0].replacementSeq === receipt.replacementSeq) last.rows.push(receipt)
    else groups.push({ batch, rows: [receipt] })
  }
  /**
   * 单行异常兜底（N-11，beta.4）。
   *
   * 恢复的会计不变量是「每一行都有结局」：restored + skipped + forgotten 必须
   * 等于输入行数。一条行的格式/字段问题只该让这一行落 skipped，不能把整批的
   * 结局一起带走——beta.3 的候选集对 format 4 的旧 span 行抛错，就是整批一条不
   * 落地中止（探针里同批的正常 format 6 行也一条没恢复）。
   *
   * 已经报过结局的行不再重复上报（onOutcome 抛错时组路径可能已经写了一半）。
   */
  const reportInternalFailure = async (receipt, error) => {
    const failed = {
      rangeStart: receipt?.rangeStart,
      rangeEnd: receipt?.rangeEnd,
      nodeId: receipt?.nodeId,
      replacementSeq: receipt?.replacementSeq,
      hash: receipt?.hash,
    }
    const already = outcomes.some((row) => row.nodeId === failed.nodeId && row.rangeStart === failed.rangeStart)
    if (already) return
    const skipped = {
      ...failed,
      state: 'skipped',
      reason: '恢复时发生内部错误：' + messageOf(error) + '；原文仍在冷库，可用 /memory-lab read '
        + failed.nodeId + ' 回读',
    }
    outcomes.push(skipped)
    if (onOutcome) await onOutcome(skipped)
  }
  for (const group of groups) {
    const receiptsInGroup = group.rows
    // BUG-010：批摘要组无论剩下几个成员都走组路径。成员被 forget 逐条剔除后，
    // 单成员残余若落进 restoreLegacyReceipt 会拿 buildReceipt(3) 抛错；组路径
    // 至少能「部分恢复」或如实 skip，不会中止整次 restore。
    if (group.batch) {
      try {
        await restoreBatchGroup({ session, client, receipts: receiptsInGroup, onOutcome, receiptMarker, outcomes })
      } catch (error) {
        for (const receipt of receiptsInGroup) await reportInternalFailure(receipt, error)
      }
      continue
    }
    for (const receipt of receiptsInGroup) {
      try {
        await restoreSingleReceipt({ session, client, receipt, onOutcome, receiptMarker, outcomes })
      } catch (error) {
        await reportInternalFailure(receipt, error)
      }
    }
  }
  // 0.13.0 F0 第二通道：回执节点已不在活动面时，上面两条路径都会 skip。
  // 历史缺陷（221/230 不可恢复）的根因是折叠把回执换成了只留 seq 的折叠回执，
  // 于是「回执不在面」不再是异常，而是**被我们自己的折叠制造出来的常态**。
  // 既然原文与 hash 都在账本里、冷库也在，就没有理由把这段历史判为不可恢复：
  // 在当前位置重建一条恢复消息，让原文回到活动面。
  if (rebuildOrphan) {
    const orphan = outcomes.filter((outcome) => outcome.state === 'skipped'
      && /回执节点已不在活动面/.test(outcome.reason ?? ''))
    for (const outcome of orphan) {
      const receipt = (receipts ?? []).find((row) => row.nodeId === outcome.nodeId
        && row.rangeStart === outcome.rangeStart)
      if (!receipt) continue
      const rebuilt = await rebuildOrphanReceipt({ session, client, receipt })
      outcomes[outcomes.indexOf(outcome)] = rebuilt
      if (onOutcome) await onOutcome(rebuilt)
    }
  }
  return outcomes
}

/**
 * 第二通道：回执节点已不在活动面时，把冷库原文重新写回活动面。
 *
 * 与「替换回执」的区别：没有回执可以核对，所以**不做逐字节回执比对**，改为
 * 冷库正文 hash 校验（与账本记录一致才放行）。校验不过仍然失败关闭——绝不
 * 把来历不明的正文塞回上下文。
 *
 * 位置语义：回执不在面上时原位置已经丢了，这里 append 到尾部（append 不改变
 * 已有节点的 seq，因此不破坏任何其它回执的定位）。`restoredSeq` 记下来，供
 * 后续 restore 幂等判定与「恢复完整性」审计使用。
 */
async function rebuildOrphanReceipt({ session, client, receipt }) {
  const base = {
    rangeStart: receipt.rangeStart,
    rangeEnd: receipt.rangeEnd,
    nodeId: receipt.nodeId,
    replacementSeq: receipt.replacementSeq,
    hash: receipt.hash,
  }
  const chunkCount = Number.isInteger(receipt.chunkCount) && receipt.chunkCount > 0 ? receipt.chunkCount : 1
  const parts = []
  for (let index = 0; index < chunkCount; index += 1) {
    const nodeId = archiveChunkNodeId(receipt.nodeId, index)
    let readBack
    try {
      readBack = await client.getNode(nodeId)
    } catch (error) {
      return { ...base, state: 'skipped', reason: '冷库重建失败：' + nodeId + ' 不可读（' + messageOf(error) + '）；原文仍在冷库，可用 /memory-lab read ' + receipt.nodeId + ' 回读' }
    }
    if (!readBack || readBack.ok === false || typeof readBack.content !== 'string') {
      return { ...base, state: 'skipped', reason: '冷库重建失败：' + nodeId + ' 缺失；原文仍在冷库，可用 /memory-lab read ' + receipt.nodeId + ' 回读' }
    }
    parts.push(normalizeColdBody(coldRecordBody(readBack.content)))
  }
  const body = parts.join('')
  if (archiveMac(body) !== receipt.hash) {
    return { ...base, state: 'skipped', reason: '冷库重建被拒：' + receipt.nodeId + ' 正文 hash 与账本不符（冷库可能被外部改写），不做恢复' }
  }
  try {
    const restored = session.append('user/message', {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: body }],
      source: { kind: PLUGIN_SOURCE_KIND, form: PLUGIN_SOURCE_FORMS.ARCHIVE_RESTORE },
    }, { surfaceOp: 'append' })
    return {
      ...base,
      state: 'restored',
      reason: '回执节点已被折叠移除，按冷库 hash 校验后在活动面重建原文',
      restoredSeq: restored.seq,
      rebuilt: true,
    }
  } catch (error) {
    return { ...base, state: 'skipped', reason: '冷库重建写回失败：' + messageOf(error) + '；原文仍在冷库，可用 /memory-lab read ' + receipt.nodeId + ' 回读' }
  }
}

/** Restore one format-1/2 per-unit receipt (legacy path, byte-identical behavior). */
async function restoreSingleReceipt({ session, client, receipt, onOutcome, receiptMarker, outcomes }) {
  const local = await restoreLegacyReceipt({ session, client, receipts: [receipt], receiptMarker })
  outcomes.push(...local)
  if (onOutcome) for (const outcome of local) await onOutcome(outcome)
}

/**
 * 从表面批次回执里读回「本批 N/M 个操作」与「相邻的 K 个」（0.13.2-beta.3 N-06 迁移）。
 *
 * 只解析**回执自己**写下的结构化数字，解析不到就返回 null（不猜）。采用条件是
 * 用这些数字重建出的正文与表面**逐字节相等**——迁移不是放宽校验，而是把行内
 * 缺失的字段从唯一权威副本（表面回执）里找回来。
 */
export function parseBatchHeaderNumbers(text) {
  const source = typeof text === 'string' ? text : ''
  const head = /批次归档：本批 (\d+)\/(\d+) 个操作(（单批释放上限截断，其余留待下批）)?/.exec(source)
  if (!head) return null
  const batchMembers = Number(head[1])
  const batchThreshold = Number(head[2])
  if (!Number.isInteger(batchMembers) || batchMembers <= 0) return null
  if (!Number.isInteger(batchThreshold) || batchThreshold <= 0) return null
  const adjacent = /本条回执覆盖其中相邻的 (\d+) 个/.exec(source)
  const runLength = adjacent ? Number(adjacent[1]) : null
  return {
    batchMembers,
    batchThreshold,
    releaseCapped: typeof head[3] === 'string' && head[3] !== '',
    runLength: Number.isInteger(runLength) && runLength > 0 ? runLength : null,
  }
}

/**
 * 归档行的**重建候选**（0.13.2-beta.3 N-06）。
 *
 * 恢复的判据是「按行内字段重建出的正文 == 表面正文」。旧行缺字段时重建必然不等，
 * 于是 58/60 段被判成「回执正文已变化，拒绝覆盖」——把**字段缺失**说成**用户改了
 * 正文**，并把责任指向用户。这里给出有界的候选集合：先用行内值（严格），
 * 再用「行内信息可反推的值」兜底；只有逐字节相等的那一个被采用，且采用的
 * 差异会作为 `migrated` 写回归档行，下一次恢复不必再迁移。
 */
function receiptReconstructionCandidates({ receipt, receiptMarker, formatVersion, surfaceText = null }) {
  const out = []
  const push = (text, migrated = null) => {
    if (typeof text === 'string' && text.length > 0) out.push({ text, migrated })
  }
  const spanKind = typeof receipt.spanKind === 'string' && receipt.spanKind !== '' ? receipt.spanKind : null
  const spanLike = formatVersion === RECEIPT_FORMAT_SPAN
    || formatVersion === RECEIPT_FORMAT_SPAN_V2
    // BUG-001 的旧行把 span 正文记成了 format 4；spanKind 非 operation 时按 span 重建。
    || (formatVersion === RECEIPT_FORMAT_VERSION && spanKind !== null && spanKind !== 'operation')
  if (spanLike) {
    // N-11（beta.4）：候选格式**只能**是 buildSpanReceipt 接受的版本（5/7）。
    // 行内的 formatVersion 可能是 4（BUG-001 的旧 span 行把 span 正文记成了
    // 操作格式），把它塞进候选会让**第一个**候选就抛「未知的片段回执格式版本：
    // 4」——一条坏行连坐整批恢复。
    const formats = []
    for (const candidate of [formatVersion, RECEIPT_FORMAT_SPAN_V2, RECEIPT_FORMAT_SPAN]) {
      if (candidate !== RECEIPT_FORMAT_SPAN && candidate !== RECEIPT_FORMAT_SPAN_V2) continue
      if (!formats.includes(candidate)) formats.push(candidate)
    }
    const labels = []
    if (typeof receipt.spanLabel === 'string' && receipt.spanLabel !== '') {
      labels.push(receipt.spanLabel)
    } else {
      // 迁移：行里没有标签 → 按 spanKind 反推（生产侧就是这张表）；插件自己注入的
      // 跨度标签是固定文案，也作为候选，但只有逐字节相等才被采用。
      if (spanKind !== null) labels.push(spanLabelOf(spanKind))
      labels.push('插件工作资料', '历史片段')
    }
    for (const candidateFormat of formats) {
      for (const label of labels) {
        const migrated = {}
        if (candidateFormat !== formatVersion) migrated.receiptFormat = candidateFormat
        if (label !== receipt.spanLabel) migrated.spanLabel = label
        push(buildSpanReceipt({
          label,
          range: { start: receipt.rangeStart, end: receipt.rangeEnd },
          nodeId: receipt.nodeId,
          hash: receipt.hash,
          chars: receipt.chars ?? 0,
          tokens: receipt.originalTokens ?? 0,
          chunks: receipt.chunkCount ?? 1,
          marker: receiptMarker,
          formatVersion: candidateFormat,
          releasedTokens: Number.isFinite(Number(receipt.releasedTokens)) ? Number(receipt.releasedTokens) : null,
          errorLine: typeof receipt.firstErrorLine === 'string' ? receipt.firstErrorLine : null,
        }), Object.keys(migrated).length > 0 ? migrated : null)
      }
    }
    return out
  }
  if (formatVersion === RECEIPT_FORMAT_BATCH || formatVersion === RECEIPT_FORMAT_BATCH_V2) {
    const build = ({ batchThreshold, batchMembers, releaseCapped, runLength }) => buildBatchReceipt({
      marker: receiptMarker,
      formatVersion,
      runLength: Number.isInteger(runLength) ? runLength : (Number.isInteger(receipt.batchSize) ? receipt.batchSize : 1),
      batchThreshold,
      batchMembers,
      releaseCapped,
      members: [batchMemberOf(receipt)],
    })
    // 新行：行内字段齐全，直接重建。
    push(build({
      batchThreshold: Number.isInteger(receipt.batchThreshold) ? receipt.batchThreshold : null,
      batchMembers: Number.isInteger(receipt.batchMembers) ? receipt.batchMembers : null,
      releaseCapped: receipt.releaseCapped === true,
      runLength: Number.isInteger(receipt.batchSize) ? receipt.batchSize : null,
    }))
    // 旧行：缺批次口径 → 从表面回执自己的数字反推，仅在逐字节相等时采用。
    if (formatVersion === RECEIPT_FORMAT_BATCH_V2
      && (!Number.isInteger(receipt.batchThreshold) || !Number.isInteger(receipt.batchMembers))) {
      const parsed = parseBatchHeaderNumbers(surfaceText)
      if (parsed) {
        push(build({
          batchThreshold: parsed.batchThreshold,
          batchMembers: parsed.batchMembers,
          releaseCapped: parsed.releaseCapped,
          runLength: parsed.runLength ?? (Number.isInteger(receipt.batchSize) ? receipt.batchSize : null),
        }), {
          batchThreshold: parsed.batchThreshold,
          batchMembers: parsed.batchMembers,
          ...(parsed.releaseCapped ? { releaseCapped: true } : {}),
          ...(parsed.runLength ? { batchSize: parsed.runLength } : {}),
        })
      }
    }
    return out
  }
  push(buildReceipt({
    tools: receipt.tools ?? [],
    range: { start: receipt.rangeStart, end: receipt.rangeEnd },
    callIds: receipt.callIds ?? [],
    nodeId: receipt.nodeId,
    hash: receipt.hash,
    chars: receipt.chars ?? 0,
    tokens: receipt.originalTokens ?? 0,
    chunks: receipt.chunkCount ?? 1,
    marker: receiptMarker,
    formatVersion,
    locators: Array.isArray(receipt.locators) ? receipt.locators : [],
    statuses: Array.isArray(receipt.statuses) ? receipt.statuses : [],
    // format 6 的投影头与 status 行依赖这两个**已落盘**的字段；缺了就按行内
    // 值重建，绝不拿默认值猜一个「释放 ≈0」。
    releasedTokens: Number.isFinite(Number(receipt.releasedTokens)) ? Number(receipt.releasedTokens) : null,
    errorLine: typeof receipt.firstErrorLine === 'string' ? receipt.firstErrorLine : null,
  }))
  return out
}

async function restoreLegacyReceipt({ session, client, receipts, receiptMarker }) {
  const outcomes = []
  for (const receipt of receipts) {
    const base = {
      rangeStart: receipt.rangeStart,
      rangeEnd: receipt.rangeEnd,
      nodeId: receipt.nodeId,
      replacementSeq: receipt.replacementSeq,
      hash: receipt.hash,
    }
    const nodes = session.surface.nodes
    if (!nodes.includes(receipt.replacementSeq)) {
      outcomes.push({ ...base, state: 'skipped', reason: '回执节点已不在活动面' })
      continue
    }
    const current = session.eventAt(receipt.replacementSeq)
    if (current?.type !== 'user/message') {
      outcomes.push({ ...base, state: 'skipped', reason: '回执节点不再是预期类型（surface 冲突）' })
      continue
    }
    // Rebuild the receipt with the format the row was actually written in.
    // Rows written before the locator/status lines existed carry no
    // `receiptFormat`; defaulting them to the legacy format keeps their receipt
    // byte-reproducible, so an old receipt still restores instead of being
    // rejected as "changed".
    const formatVersion = Number.isInteger(receipt.receiptFormat) ? receipt.receiptFormat : RECEIPT_FORMAT_LEGACY
    const knownFormats = new Set([
      RECEIPT_FORMAT_LEGACY, 2, RECEIPT_FORMAT_VERSION, RECEIPT_FORMAT_OPERATION,
      RECEIPT_FORMAT_SPAN, RECEIPT_FORMAT_SPAN_V2, RECEIPT_FORMAT_BATCH, RECEIPT_FORMAT_BATCH_V2,
    ])
    if (!knownFormats.has(formatVersion)) {
      outcomes.push({
        ...base,
        state: 'skipped',
        reason: `未知回执格式 ${formatVersion}（行内 receiptFormat）；原文仍在冷库，可用 /memory-lab read ${receipt.nodeId} 回读`,
      })
      continue
    }
    // N-11（beta.4）：0.10.1 的旧 span 行把 span 正文记成了 format 4（见
    // apply.mjs 里 BUG-001 的注释），而 buildSpanReceipt 只认 5/7。这类行既
    // 没有可信的格式号、也没有 spanLabel 可核对，任何「重建出来正好相等」都只能
    // 是巧合——如实跳过，并给出**专属**原因（不能落进通用的「回执正文已变化」，
    // 那正是 N-06 要消灭的误报：把字段缺失说成用户改了正文）。
    const legacySpanKind = typeof receipt.spanKind === 'string' && receipt.spanKind !== '' ? receipt.spanKind : null
    if (formatVersion === RECEIPT_FORMAT_VERSION && legacySpanKind !== null && legacySpanKind !== 'operation') {
      outcomes.push({
        ...base,
        state: 'skipped',
        reason: '旧 span 回执（format 4）没有可重建的标签，无法逐字节核对；原文仍在冷库，可用 /memory-lab read '
          + receipt.nodeId + ' 回读',
      })
      continue
    }
    // 0.13.2-beta.3（N-06）：期望正文改为**有界候选集**。第一候选严格按行内字段
    // 重建（新行的行为逐字不变）；旧行缺字段时按行内可反推的信息兜底（span 标签
    // 由 spanKind 反推、批次口径由表面回执自己的数字反推）。只有**逐字节相等**的
    // 候选被采用，采用后把差异写回归档行——迁移不放宽校验，只是把行内缺失的字段
    // 从唯一权威副本里找回来。
    const surfaceText = textFromContent(current.data?.content)
    const candidates = receiptReconstructionCandidates({ receipt, receiptMarker, formatVersion, surfaceText })
    const matched = candidates.find((candidate) => candidate.text === surfaceText) ?? null
    if (matched === null) {
      outcomes.push({
        ...base,
        state: 'skipped',
        reason: (formatVersion === RECEIPT_FORMAT_BATCH || formatVersion === RECEIPT_FORMAT_BATCH_V2)
          ? '批摘要成员不完整（部分成员可能已软遗忘或已被清理），无法逐字节重建摘要；该成员原文仍在冷库，可用 /memory-lab read ' + receipt.nodeId + ' 回读'
          : '回执正文已变化，拒绝覆盖',
      })
      continue
    }
    if (matched.migrated !== null) {
      // 迁移痕迹随结局上抛，由 restoreAll 写回持久行：下次恢复不必再走兜底候选。
      base.migrated = matched.migrated
    }
    // Read every chunk in order and reassemble. The whole-body hash is checked
    // after joining, so a missing or reordered chunk cannot be mistaken for the
    // original body.
    const chunkCount = Number.isInteger(receipt.chunkCount) && receipt.chunkCount > 0 ? receipt.chunkCount : 1
    const parts = []
    let readProblem = null
    for (let index = 0; index < chunkCount; index += 1) {
      const nodeId = archiveChunkNodeId(receipt.nodeId, index)
      let readBack
      try {
        readBack = await client.getNode(nodeId)
      } catch (error) {
        readProblem = `冷节点不可读（第 ${index + 1}/${chunkCount} 段）：${messageOf(error)}`
        break
      }
      if (!readBack || readBack.ok === false || typeof readBack.content !== 'string') {
        readProblem = `冷节点缺失（第 ${index + 1}/${chunkCount} 段），拒绝伪造恢复`
        break
      }
      // The store appends exactly one trailing newline; removing exactly one
      // keeps a body that legitimately ends with a blank line intact.
      parts.push(normalizeColdBody(coldRecordBody(readBack.content)))
    }
    if (readProblem) {
      outcomes.push({ ...base, state: 'skipped', reason: readProblem })
      continue
    }
    const body = parts.join('')
    // Canonical compare against the same MAC the archive used, so a body that
    // only differs in line endings (store normalization) restores cleanly.
    if (archiveMac(body) !== receipt.hash) {
      outcomes.push({ ...base, state: 'skipped', reason: '冷节点 hash 与回执不符' })
      continue
    }
    try {
      const restored = session.append('user/message', {
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: body }],
        source: { kind: PLUGIN_SOURCE_KIND, form: PLUGIN_SOURCE_FORMS.ARCHIVE_RESTORE },
      }, {
        surfaceOp: { op: 'replace', startSeq: receipt.replacementSeq, endSeq: receipt.replacementSeq },
        sourceEventSeqs: [receipt.replacementSeq],
      })
      outcomes.push({ ...base, state: 'restored', reason: '', restoredSeq: restored.seq })
    } catch (error) {
      outcomes.push({ ...base, state: 'skipped', reason: `恢复替换失败：${messageOf(error)}` })
    }
  }
  return outcomes
}

/**
 * 找到软遗忘替换后的墓碑节点（BUG-010）。
 *
 * forget 会把整条批摘要换成一个新 seq 的墓碑，归档行仍指向旧摘要 seq。墓碑正文
 * 以「来源：seq <旧 seq>–<旧 seq>」保留了组身份；据此认领当前表面节点，才能把
 * 组内仍可见成员的原文恢复回去，而不是永远报「回执节点已不在活动面」。
 */
function forgetTombstoneSeqFor(session, replacementSeq) {
  if (!Number.isInteger(replacementSeq)) return null
  for (const seq of session.surface.nodes) {
    const event = session.eventAt(seq)
    if (event?.type !== 'user/message') continue
    const text = textFromContent(event.data?.content)
    if (typeof text !== 'string' || !text.includes('本段已按用户指令软遗忘')) continue
    if (text.includes(`来源：seq ${replacementSeq}–${replacementSeq}`)) return seq
  }
  return null
}

/**
 * 部分批组的可恢复性判定（BUG-010）。
 *
 * 批摘要的成员被软遗忘后会从恢复集合里剔除，剩余成员无法重建出原来那条
 * 完整摘要（缺成员行）。这里不退化成「整组永久拒绝」，而是核对表面摘要里
 * **确实逐条列出了这些剩余成员**的冷记录与 hash，然后只恢复它们的原文——
 * 已遗忘成员的内容不会回来。任何一条标识对不上就返回 false，保持 fail-closed。
 */
function partialBatchMatches(text, receipts) {
  if (typeof text !== 'string') return false
  // Y-15：批摘要的两种头形态都要认——format 3 是「批次归档：N 个相邻操作」，
  // format 8 是「批次归档：本批 N/M 个操作」。只认前者会让 format 8 的部分批组
  // 永远落进「整组永久拒绝」，与 partial 分支存在的理由相反。
  const declared = /批次归档：(?:本批\s*(\d+)\s*\/\s*(\d+)|(\d+)\s*个相邻操作)/.exec(text)
  if (!declared) return false
  const covered = Number(declared[1] ?? declared[3])
  if (!Number.isInteger(covered) || covered < receipts.length) return false
  for (const receipt of receipts) {
    const hash = String(receipt.hash ?? '').slice(0, 12)
    if (!text.includes(`冷记录 ${receipt.nodeId} hash ${hash}`)) return false
  }
  return true
}

/** One member line's render inputs (归档行 → buildBatchReceipt 的成员形状). */
function batchMemberOf(receipt) {
  return {
    tools: receipt.tools ?? [],
    range: { start: receipt.rangeStart, end: receipt.rangeEnd },
    callIds: receipt.callIds ?? [],
    nodeId: receipt.nodeId,
    hash: receipt.hash,
    chars: receipt.chars ?? 0,
    tokens: receipt.originalTokens ?? 0,
    chunks: receipt.chunkCount ?? 1,
  }
}

/**
 * Restore one batch-summary group: rebuild the summary text from the member
 * rows, verify it byte-for-byte against the surface, then replace it once with
 * all member bodies joined in order.
 *
 * 整组同生共死（fail-closed）：任何一个成员的冷节点缺失或 hash 不符，整组跳过
 * 并逐行给出同一个原因——半组恢复会让摘要指向已经不在冷库里的成员。
 */
async function restoreBatchGroup({ session, client, receipts, onOutcome, receiptMarker, outcomes }) {
  const baseOf = (receipt) => ({
    rangeStart: receipt.rangeStart,
    rangeEnd: receipt.rangeEnd,
    nodeId: receipt.nodeId,
    replacementSeq: receipt.replacementSeq,
    hash: receipt.hash,
  })
  const skipAll = (reason) => {
    const skipped = receipts.map((receipt) => ({ ...baseOf(receipt), state: 'skipped', reason }))
    outcomes.push(...skipped)
    if (onOutcome) return Promise.all(skipped.map((outcome) => onOutcome(outcome)))
    return undefined
  }

  let replacementSeq = receipts[0].replacementSeq
  const nodes = session.surface.nodes
  let current = session.eventAt(replacementSeq)
  let partialTombstone = false
  if (!nodes.includes(replacementSeq)) {
    // 组内部分成员被 forget 后，表面摘要已换成墓碑（新 seq）。认领墓碑后按
    // 「只恢复可见成员」处理；找不到墓碑仍按节点已不在活动面 skip。
    const tombstoneSeq = forgetTombstoneSeqFor(session, replacementSeq)
    if (tombstoneSeq === null) return skipAll('回执节点已不在活动面')
    replacementSeq = tombstoneSeq
    current = session.eventAt(replacementSeq)
    partialTombstone = true
  }
  if (current?.type !== 'user/message') return skipAll('回执节点不再是预期类型（surface 冲突）')

  // 0.13.1（F2）：按归档行里记下的同一组批次口径重建，否则改过文案的回执
  // 永远对不上（「回执正文已变化，拒绝覆盖」），原文永久不可恢复。
  const batchFormat = receipts[0]?.receiptFormat === RECEIPT_FORMAT_BATCH ? RECEIPT_FORMAT_BATCH : RECEIPT_FORMAT_BATCH_V2
  const buildExpectedBatch = ({ batchThreshold = null, batchMembers = null, releaseCapped = false, runLength = null } = {}) => buildBatchReceipt({
    marker: receiptMarker,
    formatVersion: batchFormat,
    // 段长取**原文写入时的值**（batchSize），不是当前恢复集合的长度——
    // 部分恢复时后者会小于原文，直接渲染必然对不上。
    runLength: Number.isInteger(runLength)
      ? runLength
      : (Number.isInteger(receipts[0]?.batchSize) ? receipts[0].batchSize : receipts.length),
    batchThreshold,
    batchMembers,
    releaseCapped,
    members: receipts.map(batchMemberOf),
  })
  const rowThreshold = receipts.find((row) => Number.isInteger(row.batchThreshold))?.batchThreshold ?? null
  const rowMembers = receipts.find((row) => Number.isInteger(row.batchMembers))?.batchMembers ?? null
  const rowCapped = receipts.some((row) => row.releaseCapped === true)
  const expected = buildExpectedBatch({ batchThreshold: rowThreshold, batchMembers: rowMembers, releaseCapped: rowCapped })
  const currentText = textFromContent(current.data?.content)
  // 0.13.2-beta.3（N-06c 迁移）：旧行缺批次口径时重建只能回落成「N 个相邻操作
  // 已合并替换」，与表面（「本批 10/10 个操作；本条回执覆盖其中相邻的 8 个」）
  // 逐字节不同 → 整组被判「回执正文已变化」。这里从**表面回执自己**的数字反推
  // 口径重试一次；只有逐字节相等才采用，并把反推值写回行。
  let batchMigrated = null
  if (currentText !== expected && batchFormat === RECEIPT_FORMAT_BATCH_V2
    && (!Number.isInteger(rowThreshold) || !Number.isInteger(rowMembers))) {
    const parsed = parseBatchHeaderNumbers(currentText)
    if (parsed !== null) {
      const retried = buildExpectedBatch({
        batchThreshold: parsed.batchThreshold,
        batchMembers: parsed.batchMembers,
        releaseCapped: parsed.releaseCapped,
        runLength: parsed.runLength ?? undefined,
      })
      if (retried === currentText) {
        batchMigrated = {
          batchThreshold: parsed.batchThreshold,
          batchMembers: parsed.batchMembers,
          ...(parsed.releaseCapped ? { releaseCapped: true } : {}),
          ...(parsed.runLength ? { batchSize: parsed.runLength } : {}),
        }
      }
    }
  }
  // BUG-010：完整重建对不上时，检查表面是否仍是这条批摘要、且逐条列出了
  // 当前恢复集合里的成员（其余成员可能已被软遗忘剔除）。只恢复能核对上的
  // 成员正文；遗忘成员的内容绝不回来。对不上仍 fail-closed。
  const partial = partialTombstone || (currentText !== expected && partialBatchMatches(currentText, receipts))
  if (currentText !== expected && batchMigrated === null && !partial) return skipAll('回执正文已变化，拒绝覆盖')

  // 逐成员读冷节点并核对各自 hash；任何成员失败整组跳过。
  const bodies = []
  for (const receipt of receipts) {
    const chunkCount = Number.isInteger(receipt.chunkCount) && receipt.chunkCount > 0 ? receipt.chunkCount : 1
    const parts = []
    let readProblem = null
    for (let index = 0; index < chunkCount; index += 1) {
      const nodeId = archiveChunkNodeId(receipt.nodeId, index)
      let readBack
      try {
        readBack = await client.getNode(nodeId)
      } catch (error) {
        readProblem = `${receipt.nodeId} 冷节点不可读（第 ${index + 1}/${chunkCount} 段）：${messageOf(error)}`
        break
      }
      if (!readBack || readBack.ok === false || typeof readBack.content !== 'string') {
        readProblem = `${receipt.nodeId} 冷节点缺失（第 ${index + 1}/${chunkCount} 段），拒绝伪造恢复`
        break
      }
      parts.push(normalizeColdBody(coldRecordBody(readBack.content)))
    }
    if (readProblem) return skipAll(readProblem)
    const body = parts.join('')
    if (archiveMac(body) !== receipt.hash) return skipAll(`${receipt.nodeId} 冷节点 hash 与回执不符`)
    bodies.push(body)
  }

  try {
    // 成员原文按序拼成一条恢复消息（与逐条恢复一样「一条 user 消息承载原文正文，
    // 不还原原节点结构」）；空行分隔各成员，边界仍可按冷记录 ID 逐条回读。
    const restored = session.append('user/message', {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: bodies.join('\n') }],
      source: { kind: PLUGIN_SOURCE_KIND, form: PLUGIN_SOURCE_FORMS.ARCHIVE_RESTORE },
    }, {
      surfaceOp: { op: 'replace', startSeq: replacementSeq, endSeq: replacementSeq },
      sourceEventSeqs: [replacementSeq],
    })
    const reason = partial
      ? '批摘要中有成员不在本次恢复集合（已软遗忘或已清理），只恢复可见成员的原文'
      : ''
    const restoredRows = receipts.map((receipt) => ({
      ...baseOf(receipt),
      state: 'restored',
      reason,
      restoredSeq: restored.seq,
      // 迁移痕迹随结局上抛（N-06c）：restoreAll 把它写回持久行。
      ...(batchMigrated !== null ? { migrated: batchMigrated } : {}),
    }))
    outcomes.push(...restoredRows)
    if (onOutcome) for (const outcome of restoredRows) await onOutcome(outcome)
  } catch (error) {
    await skipAll(`恢复替换失败：${messageOf(error)}`)
  }
}

/**
 * Search the isolated cold store and return the bounded digest for tail injection.
 *
 * 失败必须能被上层区分出来，不能吞成一个空串（审计 P2-5(c)）：空串在下游与
 * 「确实没有匹配」完全同形，模型会以为这段工作从未存在过并重做。所以这里用
 * `normalizeRecallPayload` 作为唯一规范化入口，并把状态原样带出去：
 *
 * - `ok` 且没有命中 → `text` 为空（真的没有匹配，不注入）；
 * - `unsupported`   → `text` 为空，但 `status`/`reason` 非空，调用方据此记日志、
 *   记状态，而不是把它当成「没有相关信息」。
 *
 * @returns `{ status, text, reason, entries }`；`entries` 是本轮摘要对应的原始
 *   命中行（调用方要按 id 记账时用，不去反解析文本）。
 */
export async function recallDigest({ client, query, signal, limit = 5 }) {
  const payload = await client.recall(query, signal, limit)
  const normalized = normalizeRecallPayload(payload, limit)
  // P1-8（v1 收窄）：服务端自报 recency 兜底时零正文注入——与 v2 的 no-match
  // 语义一致（双引擎语义一致，2026-10-16 拍板）。
  if (normalized.status === RECALL_STATUS.NO_MATCH) {
    return { status: RECALL_STATUS.NO_MATCH, text: '', reason: normalized.reason ?? '', entries: [] }
  }
  if (normalized.status !== RECALL_STATUS.OK) {
    return { status: normalized.status, text: '', reason: normalized.reason ?? '', entries: [] }
  }
  const summaries = normalized.summaries
  return { status: RECALL_STATUS.OK, text: formatRecallDigest(summaries, MAX_RECALL_DIGEST_CHARS), reason: '', entries: summaries }
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
