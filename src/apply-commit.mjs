import {
  buildArchiveBody,
  canonicalizeBody,
  canonicalHash,
  archiveMac,
  computeOccupancy,
  messageOf,
  throwIfAborted,
} from './apply.mjs'
import {
  createHash } from 'node:crypto'
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
export function resultTextOf(blocks) {
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

/** One canonical reader of an assistant node's own prose, if any. */
export function assistantTextOf(content) {
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
export function assistantReasoningOf(content) {
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
export function unitBaseOf(unit) {
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
export async function writeUnitColdChunks({ client, unit, signal }) {
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
export async function verifyUnitColdChunks({ client, unit, chunkIds, chunks, signal }) {
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
export function resolveCommitSpan(session, run) {
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

export function commitSurfaceRun({ session, meter, run, receiptMarker = RECEIPT_MARKER, hostVersion, batchThreshold = null, batchMembers = null, releaseCapped = false }) {
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
export function sumShadowedTokens(session, meter, shadowedSeqs) {
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

