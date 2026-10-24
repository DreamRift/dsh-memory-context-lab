/**
 * apply-restore.mjs —— apply 拆分块①：恢复/孤儿重建域（beta.9 P1-1，
 * 纯搬移；语义零改动）。
 *
 * 循环安全性：对 apply.mjs 符号的引用全部在函数体（调用时求值），无顶层
 * 求值依赖，import 循环不产生 TDZ。
 */
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
  RECEIPT_TEMPLATES,
} from './core.mjs'

const escapeReForTemplates = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
import {
  archiveMac,
  messageOf,
} from './apply.mjs'
import { spanLabelOf } from './v2/history.mjs'

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
  const head = new RegExp(escapeReForTemplates(RECEIPT_TEMPLATES.batchHead) + ' (\\d+)\\/(\\d+) 个操作(' + escapeReForTemplates(RECEIPT_TEMPLATES.cappedSuffix) + ')?').exec(source)
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
export function receiptReconstructionCandidates({ receipt, receiptMarker, formatVersion, surfaceText = null }) {
  const out = []
  const push = (text, migrated = null) => {
    if (typeof text === 'string' && text.length > 0) out.push({ text, migrated })
  }
  const spanKind = typeof receipt.spanKind === 'string' && receipt.spanKind !== '' ? receipt.spanKind : null
  const spanLike = formatVersion === RECEIPT_FORMAT_SPAN
    || formatVersion === RECEIPT_FORMAT_SPAN_V2
    || formatVersion === RECEIPT_FORMAT_SPAN_SLIM
    // BUG-001 的旧行把 span 正文记成了 format 4；spanKind 非 operation 时按 span 重建。
    || (formatVersion === RECEIPT_FORMAT_VERSION && spanKind !== null && spanKind !== 'operation')
  if (spanLike) {
    // N-11（beta.4）：候选格式**只能**是 buildSpanReceipt 接受的版本（5/7）。
    // 行内的 formatVersion 可能是 4（BUG-001 的旧 span 行把 span 正文记成了
    // 操作格式），把它塞进候选会让**第一个**候选就抛「未知的片段回执格式版本：
    // 4」——一条坏行连坐整批恢复。
    const formats = []
    for (const candidate of [formatVersion, RECEIPT_FORMAT_SPAN_SLIM, RECEIPT_FORMAT_SPAN_V2, RECEIPT_FORMAT_SPAN]) {
      if (candidate !== RECEIPT_FORMAT_SPAN && candidate !== RECEIPT_FORMAT_SPAN_V2 && candidate !== RECEIPT_FORMAT_SPAN_SLIM) continue
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
  if (formatVersion === RECEIPT_FORMAT_BATCH || formatVersion === RECEIPT_FORMAT_BATCH_V2 || formatVersion === RECEIPT_FORMAT_BATCH_SLIM) {
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

export async function restoreLegacyReceipt({ session, client, receipts, receiptMarker }) {
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
      RECEIPT_FORMAT_LEGACY, 2, RECEIPT_FORMAT_VERSION, RECEIPT_FORMAT_OPERATION, RECEIPT_FORMAT_OPERATION_SLIM,
      RECEIPT_FORMAT_SPAN, RECEIPT_FORMAT_SPAN_V2, RECEIPT_FORMAT_SPAN_SLIM,
      RECEIPT_FORMAT_BATCH, RECEIPT_FORMAT_BATCH_V2, RECEIPT_FORMAT_BATCH_SLIM,
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
        reason: (formatVersion === RECEIPT_FORMAT_BATCH || formatVersion === RECEIPT_FORMAT_BATCH_V2 || formatVersion === RECEIPT_FORMAT_BATCH_SLIM)
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
  const declared = new RegExp(escapeReForTemplates(RECEIPT_TEMPLATES.batchHead) + '(?:\\s*(\\d+)\\s*\\/\\s*(\\d+)|(\\d+)\\s*个相邻操作)').exec(text)
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

