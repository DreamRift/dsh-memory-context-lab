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
  buildReceipt,
  chunkArchiveBody,
  coldRecordBody,
  formatRecallDigest,
  MAX_OPERATION_BYTES,
  MAX_OPERATION_LINES,
  MAX_OPERATION_TOTAL_BYTES,
  MIN_OPERATION_CHARS,
  normalizeColdBody,
  PACKAGE_NAME,
  recallSummaries,
  textFromContent,
} from './core.mjs'

/** Human-readable reasons a surface node or range is not archivable, keyed by code. */
export const SKIP_REASONS = Object.freeze({
  'not-an-operation': '不是「助手调用 + 工具结果」的完整操作',
  'already-archived': '该操作已归档',
  'assistant-not-eligible': '助手节点含非文本、非工具调用的内容块',
  'failed-result': '操作中存在失败或带错误的工具结果',
  'no-content': '工具结果没有可读正文',
  'non-text-content': '工具结果含非文本块（图片／二进制／结构化），无法保真',
  'no-call-id': '工具结果缺少可配对的 callId',
  'unpaired': '未找到与调用一一对应且紧邻的工具结果',
  'too-short': '正文短于最小归档阈值',
  'too-large': '正文超出可回读校验的上限（写入后无法整体回读）',
  'protected-system-head': 'system 指令节点',
  'protected-latest-user': '最新用户消息',
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
 * Resolve the input budget the target occupancy applies to.
 *
 * The target is measured against the **full context window**, not against the
 * window minus the output reservation, because that is the number the host's
 * own context meter shows (`projectedTokens / contextWindow`, and
 * `projectedTokens` is prompt-side only). If the plugin divided by
 * `contextWindow - maxTokens` instead, "40%" would mean a different, silently
 * stricter number than the one on screen, and the panel would report a target
 * the user never set.
 *
 * The window must be a positive integer supplied by the host and the output
 * reservation must be a non-negative integer; anything else fails closed so a
 * guessed window can never drive a destructive rewrite.
 */
export function resolveOccupancyBudget({ contextWindow, reservedCompletionTokens = 0, targetOccupancy }) {
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
  if (typeof targetOccupancy !== 'number' || !(targetOccupancy > 0 && targetOccupancy < 1)) {
    throw new OccupancyUnavailableError('target', '触发占用率未设置或不在 (0, 1) 区间，请在面板中设置。')
  }
  const usableWindowTokens = contextWindow - reservedCompletionTokens
  if (usableWindowTokens <= 0) {
    throw new OccupancyUnavailableError(
      'window',
      `模型上下文窗口 ${contextWindow} 减去预留完成 token ${reservedCompletionTokens} 后没有可用输入预算，已失败关闭。`,
    )
  }
  return {
    contextWindow,
    reservedCompletionTokens,
    usableWindowTokens,
    // Same denominator as the host context meter, so the panel and the screen agree.
    targetTokens: Math.floor(contextWindow * targetOccupancy),
    /** True when the target leaves less room for output than the route reserves. */
    reservationExceedsTarget: contextWindow - Math.floor(contextWindow * targetOccupancy) < reservedCompletionTokens,
  }
}

/** Current occupancy as a fraction of the usable input window, or null when unmeasurable. */
export function computeOccupancy(assembledTokens, usableWindowTokens) {
  if (!Number.isFinite(assembledTokens) || !Number.isFinite(usableWindowTokens) || usableWindowTokens <= 0) return null
  return assembledTokens / usableWindowTokens
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
    minimumChars = MIN_OPERATION_CHARS,
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
  // receipt in its place would leave the model without the question.
  const latestUserIndex = (() => {
    for (let index = total - 1; index >= 0; index -= 1) {
      if (nodeAt(index)?.type === 'user/message') return index
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
    // Reasoning is archivable: it is this node's own text, and in a thinking-heavy
    // session it is where most of the occupancy sits. Anything else — images,
    // attachments, provider-specific blocks — still disqualifies the whole
    // operation, because the cold body could not reproduce it faithfully.
    if (content.some((block) => block?.type !== 'tool-call' && block?.type !== 'text' && block?.type !== 'reasoning')) {
      skip.set(seq, 'assistant-not-eligible')
      continue
    }
    const callIds = calls.map((block) => (typeof block.id === 'string' ? block.id : ''))
    if (callIds.some((id) => !id)) {
      skip.set(seq, 'no-call-id')
      continue
    }
    if (calls.some((block) => typeof block.name !== 'string' || !block.name)) {
      skip.set(seq, 'not-an-operation')
      continue
    }

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

    candidates.push({
      rangeStart: seq,
      rangeEnd: surfaceNodes[endIndex],
      surfaceStartIndex: index,
      surfaceEndIndex: endIndex,
      shadowedSeqs: surfaceNodes.slice(index, endIndex + 1),
      callIds,
      tools: entries.map((entry) => entry.name),
      body,
      chars: body.length,
      originalTokens,
      turn,
      step: assistant.data?.step,
      /** Cold nodes this operation will occupy; 1 unless the body is large. */
      chunkCount: chunkArchiveBody(body).length,
      /** Inside the newest `retainOperations` operations: the baseline, not a fence. */
      withinRetention: index >= retentionFromIndex,
      inOpenTurn,
    })
  }

  candidates.sort((a, b) => a.rangeStart - b.rangeStart)
  const skipped = [...skip.entries()]
    .map(([seq, reason]) => ({ seq, reason, description: describeSkip(reason) }))
    .sort((a, b) => a.seq - b.seq)
  return { candidates, skipped }
}

/**
 * Choose the operations to archive in one batch.
 *
 * Two passes, in this order, because they answer two different questions:
 *
 *  1. **Retention (always on).** Every candidate older than the newest
 *     `retainOperations` operations is archived, whether or not the occupancy
 *     target has been reached — that is what makes the plugin continuously
 *     useful rather than a last-resort valve. The batch waits until
 *     `batchSize` operations have piled up, because each submitted batch
 *     invalidates the prefix cache from its oldest touched node onward, so
 *     batch *count* is the cost driver. Measured on a real 1M-window session:
 *     batching 10 costs 0.16× the do-nothing baseline, batching 1 costs 0.57×.
 *
 *  2. **Occupancy target (safety net).** If the assembled input still exceeds
 *     the target, the planner keeps going — oldest-first, into the retention
 *     window if it must — until the target is met or nothing safe is left. This
 *     pass ignores the batch threshold: the target exists precisely for the case
 *     where the retention window alone is not enough to keep the session under
 *     control.
 *
 * Ordering is by source event seq, never by size, tool name, or randomness, and
 * the receipt's own estimated cost is subtracted.
 *
 * @param batchSize - how many out-of-window candidates must accumulate before
 *   pass 1 submits. The target pass is not gated by it.
 * @returns the plan, including how far below the retention baseline it had to go.
 */
export function planCooling({
  candidates = [],
  excessTokens = 0,
  meter,
  nodeIdFor,
  retainOperations = 0,
  batchSize = 1,
  maxOperations = 64,
  minNetReleaseTokens = 128,
  releaseMarginTokens = 0,
}) {
  const units = []
  const rejected = []
  const targetRelease = excessTokens > 0 ? excessTokens + Math.max(0, releaseMarginTokens) : 0
  let plannedReleaseTokens = 0
  const admitted = new Set()

  function admit(candidate) {
    if (units.length >= maxOperations) return false
    const nodeId = nodeIdFor(candidate)
    const hash = archiveMac(candidate.body)
    const receipt = buildReceipt({
      tools: candidate.tools,
      range: { start: candidate.rangeStart, end: candidate.rangeEnd },
      callIds: candidate.callIds,
      nodeId,
      hash,
      chars: candidate.chars,
      tokens: candidate.originalTokens,
      chunks: candidate.chunkCount ?? 1,
    })
    const receiptTokens = meter.estimateMessage({
      role: 'user',
      content: [{ type: 'text', text: receipt }],
    })
    const netReleaseTokens = candidate.originalTokens - receiptTokens
    if (netReleaseTokens < minNetReleaseTokens) {
      rejected.push({ rangeStart: candidate.rangeStart, reason: 'below-min-release', description: describeSkip('below-min-release') })
      return false
    }
    units.push({ ...candidate, nodeId, hash, receipt, receiptTokens, netReleaseTokens })
    plannedReleaseTokens += netReleaseTokens
    admitted.add(candidate)
    return true
  }

  // ── Pass 1: retention, always on ─────────────────────────────────────────
  const outOfWindow = candidates.filter((candidate) => !candidate.withinRetention)
  const threshold = Math.max(1, batchSize)
  const baselineReady = outOfWindow.length >= threshold
  let baselineUnits = 0
  if (baselineReady) {
    for (const candidate of outOfWindow) {
      // Strict batch cap: submit the OLDEST `batchSize` operations, never the
      // whole backlog. Each submitted batch re-bills the prefix cache from its
      // earliest touched node, and the user-visible contract is "N per batch";
      // the remainder simply stays candidates for the next measure.
      if (baselineUnits >= threshold) break
      if (units.length >= maxOperations) break
      if (admit(candidate)) baselineUnits += 1
    }
  }

  // ── Pass 2: the occupancy target, a safety net that may enter the window ──
  let safetyNetUnits = 0
  if (targetRelease > 0) {
    for (const candidate of candidates) {
      if (units.length >= maxOperations) break
      if (plannedReleaseTokens >= targetRelease) break
      if (admitted.has(candidate)) continue
      if (admit(candidate)) safetyNetUnits += 1
    }
  }

  const archivedFromRetained = units.filter((unit) => unit.withinRetention).length
  const shortfall = Math.max(0, targetRelease - plannedReleaseTokens)
  return {
    units,
    rejected,
    plannedReleaseTokens,
    targetRelease,
    shortfall,
    /** False when this batch could not free the target by itself. */
    reachable: shortfall === 0,
    /** True when the per-batch ceiling stopped it, so the next step continues. */
    limitedByCap: units.length >= maxOperations && shortfall > 0,
    archivedFromRetained,
    archivedFromOpenTurn: units.filter((unit) => unit.inOpenTurn).length,
    baselineRetention: retainOperations,
    /** Protected operations remaining after this batch; each consumed one lowers it by one. */
    effectiveRetention: Math.max(0, retainOperations - archivedFromRetained),
    /** Retention pass bookkeeping, so callers can say "waiting for the batch to fill". */
    batchSize: threshold,
    outOfWindowCount: outOfWindow.length,
    baselineReady,
    baselineUnits,
    safetyNetUnits,
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
export async function applyOneOperation({ session, client, unit, meter, hostVersion, signal }) {
  const base = {
    rangeStart: unit.rangeStart,
    rangeEnd: unit.rangeEnd,
    callIds: unit.callIds,
    tools: unit.tools,
    nodeId: unit.nodeId,
    hash: unit.hash,
    chars: unit.chars,
    originalTokens: unit.originalTokens,
    receiptTokens: unit.receiptTokens,
    netReleaseTokens: unit.netReleaseTokens,
  }
  throwIfAborted(signal)

  const shadowed = rangeStillCurrent(session, unit)
  if (!shadowed) return { ...base, state: 'stale', reason: '目标区间已不在活动面（surface 已变化）' }
  // Re-derive the body from the live events and require it to equal the planned
  // one up to line endings. This is the drift check: the surface range being
  // present is not enough, because a same-shaped range could hold different
  // content. The store normalizes CRLF→LF, so the comparison is canonical.
  const liveBody = bodyFromSurface(session, unit)
  if (liveBody === null || canonicalHash(liveBody) !== canonicalHash(unit.body)) {
    return { ...base, state: 'stale', reason: '来源正文已变化（hash 不符）' }
  }

  // Persist the body as one or more cold nodes. A body larger than one node's
  // read-back limit is split on line boundaries; every chunk is verified on its
  // own, so read-back fidelity is preserved no matter how large the operation
  // is. This is what keeps a big `read` or `edit` archivable at all.
  // Chunks are canonicalized before they are hashed and written: the store
  // normalizes CRLF→LF, so writing the canonical form makes the round-trip
  // byte-identical and the read-back comparison exact, not just equivalent.
  const chunks = chunkArchiveBody(canonicalizeBody(unit.body))
  if (chunks.length === 0) {
    return { ...base, state: 'orphaned', reason: '归档正文为空，原文保留' }
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
        ...base,
        state: 'cold-write-failed',
        reason: `冷节点 ${chunkIds[index]} 已被不同正文占用，拒绝覆写（保护既有内容），单元保留待重试`,
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
    // Nothing was replaced, so the originals are intact; the nodes already
    // written are unreferenced leftovers in this session's own store.
    return { ...base, state: 'cold-write-failed', reason: `冷库写入失败：${writeFailures.join('；')}` }
  }

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
    return { ...base, state: 'orphaned', reason: `${readBackProblems.join('；')}，原文保留` }
  }
  if (canonicalHash(reassembled.join('')) !== canonicalHash(unit.body)) {
    return { ...base, state: 'orphaned', reason: '分块回读拼接后与原文 hash 不符，原文保留并标记 orphaned' }
  }

  let replacement
  try {
    let shadowedTokenCount = 0
    for (const seq of unit.shadowedSeqs) {
      shadowedTokenCount += meter.estimateMessage(session.deriveEventMessage(session.eventAt(seq))) ?? 0
    }
    const prune = session.append('compaction/prune', {
      shadowedRange: { start: unit.rangeStart, end: unit.rangeEnd },
      shadowedSeqs: [...unit.shadowedSeqs],
      shadowedTokenCount,
    })
    replacement = session.append('user/message', {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: unit.receipt }],
      source: { kind: 'user' },
    }, {
      surfaceOp: { op: 'replace', startSeq: unit.rangeStart, endSeq: unit.rangeEnd },
      sourceEventSeqs: [prune.seq, ...unit.shadowedSeqs],
    })
  } catch (error) {
    return { ...base, state: 'orphaned', reason: `活动面替换失败，原文保留：${messageOf(error)}` }
  }

  const problems = []
  const after = session.eventAt(replacement.seq)
  if (!session.surface.nodes.includes(replacement.seq)) problems.push('替换事件未进入活动面')
  for (const seq of unit.shadowedSeqs) {
    if (session.surface.nodes.includes(seq)) problems.push(`原节点 seq ${seq} 仍在活动面`)
  }
  if (after?.type !== 'user/message') problems.push('替换事件类型不是 user/message')
  if (textFromContent(after?.data?.content) !== unit.receipt) problems.push('回执正文未保持')
  try {
    session.deriveMessages()
  } catch (error) {
    problems.push(`活动面无法构建下一次请求：${messageOf(error)}`)
  }
  if (problems.length) {
    return { ...base, replacementSeq: replacement.seq, state: 'verify-failed', reason: problems.join('；') }
  }
  return {
    ...base,
    replacementSeq: replacement.seq,
    state: 'applied',
    reason: '',
    /** Cold nodes this operation occupies; restore reads them back in order. */
    chunkCount: chunks.length,
    chunkIds: [...chunkIds],
    surfaceGeneration: session.surface.replaceGeneration,
    hostVersion: hostVersion ?? 'unknown',
  }
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
    budget,
    view,
    excessTokens,
    plan,
    targetOccupancy,
    archivedCount = 0,
    cacheStats = null,
  } = occupancy
  // Same denominator the host context meter uses, so this line and the meter agree.
  const current = computeOccupancy(host.assembledTokens, budget.contextWindow)
  const lines = [
    `当前模型：${host.provider}/${host.model}`,
    `上下文窗口：${host.contextWindow} token（占用率口径与界面一致：组装输入 ÷ 窗口）`,
    `组装输入估算：≈${host.assembledTokens} token（来源：${host.baselineKind === 'usage' ? '提供方 usage 锚点 + 增量估算' : '宿主 estimator 纯估算'}）`,
    `当前占用率：${current === null ? '无法计算' : `${(current * 100).toFixed(1)}%`}（安全网触发线 ${(targetOccupancy * 100).toFixed(0)}%，仅在保留数不够用时才启用）`,
    `目标预算：${budget.targetTokens} token；超出：${excessTokens} token`,
    formatCacheLine(cacheStats),
    `候选：${view.candidates.length} 个完整操作可归档（已保护／不合格 ${view.skipped.length} 条）；本批计划释放 ≈${plan.plannedReleaseTokens} token（含回执成本）`,
    `保留最近 ${plan.baselineRetention} 个操作（一直生效）：窗口外待归档 ${plan.outOfWindowCount} 个，`
    + (plan.baselineReady
      ? `已攒够 ${plan.batchSize} 个，本批提交`
      : `未攒够 ${plan.batchSize} 个，暂不提交（攒够即归档，与占用率无关）`),
  ]
  if (budget.reservationExceedsTarget) {
    lines.push(
      `注意：目标 ${(targetOccupancy * 100).toFixed(0)}% 之后的剩余空间小于本路由预留的完成 token ${host.reservedCompletionTokens}，`
      + '长回答仍可能触顶；要留出输出余量请下调目标。',
    )
  }
  if (plan.units.length) {
    lines.push(
      `本批构成：保留窗口外 ${plan.baselineUnits} 个`
      + (plan.safetyNetUnits > 0
        ? ` + 为满足安全网额外动用保留窗口内 ${plan.safetyNetUnits} 个（保留基线 ${plan.baselineRetention} → ${plan.effectiveRetention}）`
        : `（保留基线 ${plan.baselineRetention} 个未被动用）`),
    )
    if (plan.archivedFromOpenTurn > 0) {
      lines.push(`其中 ${plan.archivedFromOpenTurn} 个属于当前尚未结束的回合。`)
    }
    if (plan.shortfall > 0) {
      lines.push(plan.limitedByCap
        ? `本批受单批上限约束，仍差 ≈${plan.shortfall} token，下一步会继续。`
        : `已无可归档操作，仍超出 ≈${plan.shortfall} token：剩余的是受保护的系统头／最新用户消息，或不合格（失败、含非文本块、过短、超出可回读上限）的操作。`)
    }
  } else if (excessTokens > 0) {
    lines.push('安全网已触发，但已无可归档操作：剩余的是受保护的系统头／最新用户消息，或不合格的操作。')
  }
  lines.push(`已归档操作：${archivedCount} 个`)
  return lines
}

/** Report one batch: what landed, what did not, and why. */
export function formatBatchReport(result) {
  const lines = [`已归档 ${result.applied} 个操作，释放 ≈${result.releasedTokens} token（估算）。`]
  for (const outcome of result.outcomes) {
    const label = outcome.state === 'applied' ? '成功' : `未归档(${outcome.state})`
    lines.push(`- seq ${outcome.rangeStart}–${outcome.rangeEnd} / ${outcome.tools.join('、')}：${label}${outcome.reason ? ` — ${outcome.reason}` : ''}`)
  }
  if (result.failed.length) lines.push('失败或跳过的单元保留了原文；已归档单元的回执仍然有效。')
  return lines.join('\n')
}

/** Report one restore pass. */
export function formatRestoreReport(result) {
  const lines = [`已恢复 ${result.restored} 个操作的原文。`]
  for (const outcome of result.outcomes) {
    const label = outcome.state === 'restored' ? '已恢复' : `跳过(${outcome.state})`
    lines.push(`- seq ${outcome.rangeStart}：${label}${outcome.reason ? ` — ${outcome.reason}` : ''}`)
  }
  if (result.restored) lines.push('恢复以一条 user 消息承载原文正文，内容完整但不还原原来的节点结构。')
  return lines.join('\n')
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

/** Run one batch, committing each unit independently and reporting every outcome. */
export async function applyOperations({ session, client, units, meter, hostVersion, signal, onOutcome }) {
  const outcomes = []
  for (const unit of units) {
    let outcome
    try {
      outcome = await applyOneOperation({ session, client, unit, meter, hostVersion, signal })
    } catch (error) {
      if (signal?.aborted) throw error
      outcome = {
        rangeStart: unit.rangeStart,
        rangeEnd: unit.rangeEnd,
        callIds: unit.callIds,
        tools: unit.tools,
        nodeId: unit.nodeId,
        hash: unit.hash,
        chars: unit.chars,
        originalTokens: unit.originalTokens,
        receiptTokens: unit.receiptTokens,
        netReleaseTokens: unit.netReleaseTokens,
        state: 'orphaned',
        reason: `事务异常，原文保留：${messageOf(error)}`,
      }
    }
    outcomes.push(outcome)
    if (onOutcome) await onOutcome(outcome)
  }
  return outcomes
}

/**
 * Restore receipts whose replacement is still the current surface node and
 * whose cold body still matches the recorded hash. Anything else is skipped
 * with a reason; no new event is overwritten.
 */
export async function restoreReceipts({ session, client, receipts, onOutcome }) {
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
    const expected = buildReceipt({
      tools: receipt.tools ?? [],
      range: { start: receipt.rangeStart, end: receipt.rangeEnd },
      callIds: receipt.callIds ?? [],
      nodeId: receipt.nodeId,
      hash: receipt.hash,
      chars: receipt.chars ?? 0,
      tokens: receipt.originalTokens ?? 0,
      chunks: receipt.chunkCount ?? 1,
    })
    if (textFromContent(current.data?.content) !== expected) {
      outcomes.push({ ...base, state: 'skipped', reason: '回执正文已变化，拒绝覆盖' })
      continue
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
        source: { kind: 'user' },
      }, {
        surfaceOp: { op: 'replace', startSeq: receipt.replacementSeq, endSeq: receipt.replacementSeq },
        sourceEventSeqs: [receipt.replacementSeq],
      })
      outcomes.push({ ...base, state: 'restored', reason: '', restoredSeq: restored.seq })
    } catch (error) {
      outcomes.push({ ...base, state: 'skipped', reason: `恢复替换失败：${messageOf(error)}` })
    }
  }
  if (onOutcome) for (const outcome of outcomes) await onOutcome(outcome)
  return outcomes
}

/** Search the isolated cold store and return the bounded digest for tail injection. */
export async function recallDigest({ client, query, signal, limit = 5 }) {
  const payload = await client.recall(query, signal, limit)
  return formatRecallDigest(recallSummaries(payload, limit))
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
  let fallback = null
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!message || message.role !== 'user') continue
    const kind = message.source?.kind
    if (kind === PACKAGE_NAME) continue
    const text = textFromContent(message.content)
    if (!text) continue
    const candidate = { id: typeof message.id === 'string' ? message.id : `index-${index}`, text }
    if (kind === 'user') return candidate
    // A first-party prompt under another source kind is still a better query
    // than nothing, so it is kept only as a fallback.
    if (!fallback) fallback = candidate
  }
  return fallback
}
