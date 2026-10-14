/**
 * Session-level cooling orchestration: occupancy measurement, one-batch commit,
 * restore, recall, and the `/memory-lab` subcommands.
 *
 * Everything host- or plugin-specific arrives through `dependencies`, so the
 * command surface is unit-testable with a synthetic record and no process
 * spawn. `index.mjs` supplies the real bindings.
 */

import {
  applyOperations,
  cacheStatsOf,
  collectOperationCandidates,
  formatBatchReport,
  formatCacheLine,
  formatRestoreReport,
  lastUsageOf,
  lastUsageWithSeqOf,
  OccupancyUnavailableError,
  occupancyLines,
  openTurnOf,
  planCooling,
  resolveWindow,
  restoreReceipts,
  summarizeOutcomes,
  tokenAccountingOf,
} from './apply.mjs'
import {
  digestRecall,
  isHumanAuthoredMessage,
  MAX_BATCH_RELEASE_TOKENS,
  MAX_OPERATIONS_PER_BATCH,
  MAX_RECALL_HITS,
  MIN_NET_RELEASE_TOKENS,
  MIN_OPERATION_CHARS,
  isReceiptMessage,
  normalizeProtectionSettings,
  normalizeRecallPayload,
  PACKAGE_NAME,
  RECALL_STATUS,
  RECEIPT_MARKER,
  textFromContent,
} from './core.mjs'
import {
  ProtectionRegistry,
  PROTECTION_SOURCE,
  collectStructuralProtections,
  collectTaskLinkProtections,
  coldDependencyEntries,
  makeEntry,
  recallProtectionEntries,
} from './protection.mjs'

/**
 * Resolve the authoritative context window and the assembled-input estimate.
 *
 * Window precedence is adapter metadata first (the value the provider actually
 * enforces), then the durable `request/context` record the host wrote for the
 * latest request. The estimator is always the host token meter — the same
 * service `dsh-compaction-basic` uses for pressure. Anything unconfirmed fails
 * closed rather than being guessed.
 */
export async function resolveHostOccupancy(record, signal, services) {
  const session = record.agent.session
  const config = session.requestHeader()?.config
  const provider = typeof config?.provider === 'string' ? config.provider : ''
  const model = typeof config?.model === 'string' ? config.model : ''
  if (!provider || !model) {
    throw new OccupancyUnavailableError('route', '宿主尚未记录本会话的 provider/model（request/header 缺失），已失败关闭：不替换任何会话内容。')
  }
  const meter = services.get('tokenMeter')
  if (!meter || typeof meter.measure !== 'function') {
    throw new OccupancyUnavailableError('estimator', '宿主未提供 tokenMeter 计量服务，已失败关闭：无法可靠估算组装输入。')
  }
  const llm = services.get('llm')
  if (!llm || typeof llm.resolveModelInfo !== 'function') {
    throw new OccupancyUnavailableError('window', '宿主未提供 llm.resolveModelInfo，无法确认模型可用上下文窗口，已失败关闭。')
  }
  const info = await llm.resolveModelInfo(provider, model, signal)
  const logged = session.requestContext()
  const measurement = meter.measure(session)
  return {
    meter,
    host: {
      provider,
      model,
      contextWindow: info?.context?.contextWindow ?? logged?.contextWindow,
      loggedWindow: logged?.contextWindow,
      reservedCompletionTokens: config?.maxTokens ?? info?.defaultMaxTokens ?? 0,
      assembledTokens: measurement.totalTokens,
      baselineKind: measurement.baseline?.kind ?? 'estimated',
      surfaceNodes: measurement.nodes,
    },
  }
}

/**
 * Render the newest durable measurement, for a session whose in-memory one is
 * gone (a fresh process, or a session that has not stepped yet).
 *
 * This is what makes "never reached the trigger" distinguishable from "could
 * not measure" after the fact; both used to leave nothing behind.
 */
export function formatStoredMeasurement(stored) {
  const at = typeof stored?.at === 'string' ? stored.at : ''
  const stamp = at ? `（${at.replace('T', ' ').slice(0, 19)}）` : ''
  if (stored?.kind === 'unavailable') {
    return `最近一次测量：失败关闭${stamp}——${stored.reason || '原因未记录'}`
  }
  const assembled = Number.isFinite(stored?.assembledTokens) ? stored.assembledTokens : null
  if (assembled === null) {
    return `最近一次测量${stamp}：记录不完整（占用缺失）。`
  }
  const action = stored?.kind === 'applied'
    ? '已归档一批'
    : (stored?.kind === 'failed'
      ? `归档失败（0 段成功）——${stored.reason || '原因未记录'}`
      : (stored?.reason === 'waiting-for-batch'
        ? '未触发归档（等待批量攒满）'
        : (stored?.reason === 'waiting-batch-protected'
          ? '未触发归档（够条件的操作被保护挡住，等待解除）'
          : '未触发归档')))
  return `最近一次测量：${action}${stamp}——占用 ≈${assembled} token。`
}

/**
 * Build the session-level cooling engine.
 *
 * @param dependencies - plugin bindings: durable persist, node-id naming, the
 *   host version recorded on receipts, service lookup, and the plugin logger.
 */
/** Durable claim lookup: a retried unit keeps the node id it was first planned for. */
export function nodeClaimOf(record, rangeStart) {
  const claims = record.state.nodeClaims && typeof record.state.nodeClaims === 'object'
    ? record.state.nodeClaims
    : null
  return claims?.[rangeStart] ?? null
}

/** The durable claims map for one record, creating it when absent. */
export function claimsOfRecord(record) {
  if (!record.state.nodeClaims || typeof record.state.nodeClaims !== 'object') {
    record.state.nodeClaims = {}
  }
  return record.state.nodeClaims
}

/**
 * How many automatic attempts one operation gets before it is parked (P0-1).
 *
 * A failed unit keeps its ordinal and stays a candidate, so a transient store
 * failure heals on the next `/memory-lab now` or auto round. Without a ceiling a
 * permanently failing range would retry forever and never be reported; at the
 * ceiling the range is parked — removed from the candidate set and listed in
 * status with its attempt count — instead of silently looping.
 */
export const MAX_UNIT_RETRY_ATTEMPTS = 3

/**
 * 回执 Σ 与 `compaction/prune.shadowedTokenCount` 的容许差额（P0-2）。
 *
 * 两条路径取的都是宿主 meter 的启发式价，实测样本逐条严格相等；一旦超过这个比例，
 * 说明规划期与提交期的测量对不上（meter 有一次没测到、或活动面在两者之间变了），
 * status 必须如实报出差额，而不是让它看起来「本来就该差」。
 */
export const TOKEN_ACCOUNTING_TOLERANCE = 0.05

/** Per-range attempt book: `{ [rangeStart]: { attempts, lastState, lastReason, at } }`. */
export function retryBookOf(record) {
  if (!record.state.unitRetries || typeof record.state.unitRetries !== 'object') {
    record.state.unitRetries = {}
  }
  return record.state.unitRetries
}

/** Ranges that exhausted their retry budget: excluded from candidates, reported in status. */
export function parkedRangesOf(record) {
  if (!record.state.parkedRanges || typeof record.state.parkedRanges !== 'object') {
    record.state.parkedRanges = {}
  }
  return record.state.parkedRanges
}

/**
 * Issue fresh node ordinals that never collide with a claim or an applied
 * receipt, no matter which process wrote them: reuse shifts with pending counts,
 * these ids are owned for the session's lifetime.
 *
 * **Occupancy is claims + receipts + a monotone high-water mark — never the
 * failure ledger.** Reading `state.lastFailures` here was a bug (审计 P0-1):
 * the ledger keeps every failed attempt forever, so a range that failed once
 * could never reuse its own ordinal again; each retry minted a new id, left the
 * previous attempt's bytes behind as an unreferenced cold node, and the count of
 * cold nodes drifted away from the count of receipts. A failed attempt is
 * exactly the case where the *same* ordinal must be reused (the body is
 * unchanged, the probe sees matching bytes and skips the write), and when the
 * body really did change the id is re-minted explicitly by dropping the claim.
 * The high-water mark replaces the ledger as the anti-collision floor, so an id
 * that was ever minted is never minted again even after its claim is gone.
 */
export function makeOrdinalAllocator(record) {
  const used = new Set()
  const mark = (nodeId) => {
    const match = /_(\d+)(?:_p\d+)?$/.exec(String(nodeId ?? ''))
    if (match) used.add(Number(match[1]))
  }
  for (const row of Object.values(claimsOfRecord(record))) {
    const ordinal = Number(row?.ordinal)
    if (Number.isSafeInteger(ordinal) && ordinal >= 1) used.add(ordinal)
  }
  for (const row of record.state.archive) {
    mark(row?.nodeId)
    if (Array.isArray(row?.chunkIds)) for (const chunkId of row.chunkIds) mark(chunkId)
  }
  for (const row of Array.isArray(record.state.lastFailures) ? record.state.lastFailures : []) {
    // 只为 **换号**（remint）留下的旧 id 记占用：那种情况确实可能已写进冷库。
    // 普通失败留在同一个 ordinal 上，不能再把账本整本当占用（P0-1）。
    if (row?.lastAction === 'remint') mark(row?.nodeId)
  }
  const highWater = Number(record.state.ordinalHighWater)
  const hasHighWater = Number.isSafeInteger(highWater) && highWater >= 1
  if (hasHighWater) {
    used.add(highWater)
  } else {
    // 旧状态没有高水位线（0.8 前的账本）：唯一能防「重发已写坏的 ordinal」的
    // 判据就是失败账本本身，此时保守地把账本里出现过的节点都记为占用。
    for (const row of Array.isArray(record.state.lastFailures) ? record.state.lastFailures : []) {
      if (row?.lastAction !== 'remint') mark(row?.nodeId)
    }
  }
  let max = 0
  for (const ordinal of used) if (ordinal > max) max = ordinal
  let next = max + 1
  return {
    next: () => {
      const ordinal = next
      next += 1
      if (!Number.isSafeInteger(record.state.ordinalHighWater) || record.state.ordinalHighWater < ordinal) {
        record.state.ordinalHighWater = ordinal
      }
      return ordinal
    },
  }
}

/**
 * Durable per-range cold-node claims.
 *
 * See `nodeClaimOf`.
 */
/**
 * Receipts still shadowing the active surface.
 *
 * A verify-failed row counts. The replacement WAS appended -- that is why the
 * original text is no longer on the surface -- and only the post-commit checks
 * disagreed. Treating it as not-pending left the shadowed original with no row
 * for restore to read back, so that text could never be recovered.
 */
export function pendingReceipts(record) {
  const archive = Array.isArray(record?.state?.archive) ? record.state.archive : []
  return archive.filter((row) => row.status === 'applied' || row.status === 'verify-failed')
}

export function createEngine(dependencies) {
  const { persist, nodeIdFor, hostVersion, services, logger } = dependencies

  /** The live settings for one record, normalized. */
  function settingsOf(record) {
    const settings = normalizeProtectionSettings(record.state.settings)
    record.state.settings = settings
    return settings
  }

  /**
   * Per-session protection registry.
   *
   * Hard protections are re-derived from the surface on every measure (they are
   * facts, not memories), so only the soft half is restored from durable state.
   * The registry is cached per session id because a dry-run must not leak its
   * scratch decisions into the committed one.
   */
  const registries = new Map()

  function registryOf(record, { fresh = false } = {}) {
    const key = record.sessionId
    if (fresh) {
      return new ProtectionRegistry({ soft: record.state.protections })
    }
    let registry = registries.get(key)
    if (!registry) {
      registry = new ProtectionRegistry({ soft: record.state.protections })
      registries.set(key, registry)
    }
    return registry
  }

  /**
   * 本插件自己写进活动面的序号：归档替换点与 `restore` 出来的正文。
   *
   * `source.form` 只对新日志有效——0.6.2 之前写下的恢复正文**没有 form**，正文又是
   * 原文（不带回执标记），因此仅凭消息形状无法与人类输入区分。好在这些序号由插件
   * 自己的状态文件记着（`archive[].replacementSeq` / `archive[].restoredSeq`），
   * 拿它对一遍就能覆盖老日志。
   *
   * 实测证据（2026-10-13，逐帧解压两个真实会话）：S1 有 961 条回执 + 961 条恢复正文，
   * 最靠后的 `source.kind: 'user'` 事件是 seq 9992 的恢复正文，而真实人类输入最靠后
   * 只到 seq 8858；S2 对应 1008 / 11655 / 10311。也就是说**只按 `role` 判定时，
   * 保护位从 8858（S1）／10311（S2）起就被插件自己的恢复正文占住了**。
   *
   * 残余缺口（诚实边界）：这份账本只覆盖隔离根还在的会话。若隔离根被删而 append-only
   * 日志保留着恢复正文，插件已失去全部记账（回执、认领、恢复点），此时那些正文无法与
   * 人类输入区分，保护位会再次落到它们身上。不做正文形状启发式：归档正文的
   * `## 助手思考 / ## 助手说明 / ## 调用 N：` 头部同样可能出现在人类粘贴的引用里，
   * 误判会把真实约束挤出保护位，代价比这个残余缺口更大。
   */
  function pluginWrittenSeqs(record) {
    const seqs = new Set()
    for (const row of record.state.archive ?? []) {
      if (Number.isInteger(row?.replacementSeq)) seqs.add(row.replacementSeq)
      if (Number.isInteger(row?.restoredSeq)) seqs.add(row.restoredSeq)
    }
    return seqs
  }

  /**
   * The newest human-authored message on the surface, or null.
   *
   * Uses the same positive identification as the recall query: `role === 'user'`
   * is not enough, because the host appends its own `user/message` runtime-context
   * snapshots (`source.kind === 'runtime-context'`). Treating one of those as a
   * prompt would mint task-link soft protections from host boilerplate — a false
   * protection source, which is worse than no protection source at all.
   */
  function latestUserSurface(session, record) {
    const written = pluginWrittenSeqs(record)
    const nodes = session.surface.nodes
    for (let index = nodes.length - 1; index >= 0; index -= 1) {
      const seq = nodes[index]
      if (written.has(seq)) continue
      const event = session.eventAt(seq)
      if (event?.type !== 'user/message') continue
      const data = event.data ?? {}
      const message = { ...data, content: data?.content ?? data?.message?.content, source: data?.source ?? data?.message?.source }
      // 复用 core 的单一权威判据：`source.kind === 'user'` 且不带插件 form、正文
      // 不是回执标记。回执／恢复／召回包都带 `source.kind: 'user'`，只看类型就会
      // 让插件自己的消息占住「最新用户消息」这个保护位（P1-4）。
      if (!isHumanAuthoredMessage(message)) continue
      const text = textFromContent(message.content)
      if (!text) continue
      return { seq, text }
    }
    return null
  }

  /**
   * Build this round's protection set and return the registry plus its report.
   *
   * Order matters and is deliberate:
   *   1. 到期复核 — 上一轮建立的软保护先按解除条件释放；
   *   2. 硬保护重推 — 未闭合调用、未曝光结果、后台 job、待确认副作用、冷库依赖；
   *   3. 任务关联线索 — 每个新的用户消息只建立一次（避免"释放→重建"永久空转）；
   *   4. 预算复核 — 超预算只释放最弱软保护，硬保护一段不动。
   */
  function refreshProtections(record, view, { settings, persistState }) {
    const session = record.agent.session
    const registry = registryOf(record, { fresh: persistState !== true })
    registry.budgetTokens = settings.protectBudgetTokens
    // 操作纪元：已归档 + 仍可归档的操作总数。只增不减（restore 会让它暂时变小，
    // 但软保护的到期必须按时间前进，不能被一次 restore 倒退）。
    const epoch = Math.max(
      Number(record.state.protectionEpoch) || 0,
      pendingReceipts(record).length + view.candidates.length,
    )
    registry.setEpoch(epoch)
    const released = registry.refreshSoft()
    registry.setHard([
      ...collectStructuralProtections({
        view,
        surfaceNodes: [...session.surface.nodes],
        eventAt: (seq) => session.eventAt(seq),
        operationEpoch: epoch,
      }),
      ...coldDependencyEntries({ archiveRows: pendingReceipts(record), operationEpoch: epoch }),
    ])
    const latestUser = latestUserSurface(session, record)
    // 记下"是否识别到过人类提示"：没识别到时回注**永远不会触发**，这是能力边界，
    // status 必须说出来，而不是让静默的"没有回注"被读成"没有需要回注的东西"。
    if (latestUser) record.humanPromptSeen = true
    // 无法判定的条件要显式列出，不能把"没识别到"当成"已证明不需要"。
    const unknowns = []
    if (!latestUser) {
      unknowns.push({
        code: 'no-human-prompt-recognized',
        reason: '活动面上没有可识别的人类提示（要求 `role==="user"` ∧ `source.kind==="user"` ∧ 非本插件回执）',
        conservative: '不建立任务关联线索软保留；自动回注也不会触发（两者都只认人类提示）',
      })
    }
    if (!Array.isArray(session?.surface?.nodes) || typeof session?.eventAt !== 'function') {
      unknowns.push({
        code: 'surface-unreadable',
        reason: '宿主未提供可读的活动面（`session.surface.nodes` / `session.eventAt`）',
        conservative: '不归档任何操作（结构证据无法判定时失败关闭，绝不放宽校验）',
      })
    }
    registry.setUnknowns(unknowns)
    let taskLinkAdded = 0
    if (latestUser && record.state.taskLinkSourceSeq !== latestUser.seq) {
      for (const entry of collectTaskLinkProtections({
        candidates: view.candidates,
        latestUserText: latestUser.text,
        operationEpoch: epoch,
      })) {
        registry.addSoft(entry)
        taskLinkAdded += 1
      }
      if (persistState === true) record.state.taskLinkSourceSeq = latestUser.seq
    }
    const budget = registry.enforceBudget()
    if (persistState === true) {
      record.state.protectionEpoch = epoch
      record.state.protections = registry.snapshot()
    }
    return {
      registry,
      epoch,
      report: registry.report(),
      released,
      budget,
      taskLinkAdded,
    }
  }

  /**
   * 显式 pin：用户点名的操作不因离开保留窗口而退出。
   *
   * 沿用现有命令面（`/memory-lab pin <seq>`），不新增模型可见工具——工具集一变
   * 就作废整段前缀缓存。pin 是软保护里最强的一档：预算降级时最后才动，也不受
   * 兜底寿命约束；但上限之外的新增会被**拒绝并报告**，不会静默丢弃。
   */
  function pinOperation(record, seq) {
    const registry = registryOf(record)
    registry.setEpoch(Math.max(Number(record.state.protectionEpoch) || 0, pendingReceipts(record).length))
    const entry = makeEntry({
      source: PROTECTION_SOURCE.PIN,
      strength: 'soft',
      target: { kind: 'seq', seq },
      reason: `用户显式 pin（/memory-lab pin ${seq}）`,
      release: { kind: 'manual', description: `用户 /memory-lab unpin ${seq}` },
      operationEpoch: registry.operationEpoch,
    })
    const outcome = registry.addPin(entry)
    if (outcome.refused) {
      return { ok: false, text: `pin 已达上限 ${outcome.limit} 条，本次未新增（未静默丢弃）。先 unpin 一条再试。` }
    }
    record.state.protections = registry.snapshot()
    return { ok: true, text: `已 pin seq ${seq}：它不会因超过保留窗口而退出；解除用 /memory-lab unpin ${seq}。` }
  }

  /** 解除一条显式 pin（或任何一条保护）。 */
  function unpinOperation(record, key) {
    const registry = registryOf(record)
    const removed = registry.releaseByTarget(key)
    record.state.protections = registry.snapshot()
    return {
      ok: removed.removed > 0,
      text: removed.removed > 0
        ? `已解除 ${removed.removed} 条保护（${key}）。`
        : `没有找到匹配 ${key} 的保护条目；硬保护来自真实结构，不能用命令解除。`,
    }
  }

  /** Receipts still shadowing the active surface. */
  /**
   * Durable per-range cold-node claims.
   *
   * A unit's node id must NOT be re-derived from `pendingReceipts + candidate
   * index` on every measure: that mapping shifts whenever other units are
   * archived or new candidates appear, so a failed unit's retry landed on a
   * different node id — collided with a node that already held someone else's
   * body — and failed deterministically, batch after batch (observed in a real
   * session, 42 orphaned cold nodes for 31 retries). A claim is instead recorded
   * in the durable state the first time a range is planned, and every retry
   * reuses the same node id; combined with the write-once probe-and-reuse in
   * `applyOneOperation`, the same attempt then re-reads its own already-written
   * bytes and proceeds.
   */
  function surfaceViewOf(record, measuredNodes, settings) {
    const session = record.agent.session
    // Surface seq of the newest assistant message (C-12): the model is still
    // producing this turn and may send evidence at any time, so operations at
    // or after this seq are fenced out of every candidate set.
    //
    // `session.surface.nodes` 是 seq 列表（不是事件对象）。此前这里按对象读
    // `node.type`／`node.seq`，两者恒为 undefined，于是 `lastAssistantSeq` 永远是
    // null —— C-12 围栏在引擎路径上从未生效，`not-yet-exposed` 既不出现在候选
    // 跳过表里，也不产生对应的硬保护（保护集少了一整类真实结构证据）。
    let lastAssistantSeq = null
    for (const seq of session.surface.nodes) {
      if (!Number.isInteger(seq)) continue
      if (session.eventAt(seq)?.type !== 'assistant/message') continue
      lastAssistantSeq = Math.max(lastAssistantSeq ?? -1, seq)
    }
    // 候选收集器：默认是 v1 的「助手工具调用 + 紧邻结果」；v2 换成自己的全历史
    // 收集器（普通 user/assistant 正文、旧回执、旧卡、旧召回包也进候选），
    // 这样「全历史按需记忆化」不是把只支持工具操作的 v1 引擎改个名字。
    const collect = dependencies.collectCandidates ?? collectOperationCandidates
    // 全历史记忆上下文模式（仅 v2 账本会置位）：保留窗口整体失效，留下与否交给
    // 收集器里的不可压缩凭证规则 + 守卫 + 保护层。v1 账本不会置位，行为不变。
    const fullHistory = record.state?.fullHistory === true
    return collect({
      surfaceNodes: [...session.surface.nodes],
      eventAt: (seq) => session.eventAt(seq),
      nodeAt: (index) => session.eventAt(session.surface.nodes[index]),
      measuredNodes,
      retainOperations: fullHistory ? 0 : settings.retainOperations,
      retainSpans: fullHistory ? 0 : settings.retainOperations,
      fullHistory,
      openTurn: openTurnOf(session),
      archivedRanges: pendingReceipts(record).map((row) => ({ start: row.rangeStart, end: row.rangeEnd })),
      // 重试到上界的区间不再进候选（否则永久失败会无限循环），但仍会在 status 里
      // 带次数如实列出，绝不静默消失（P0-1）。
      parkedRanges: Object.keys(parkedRangesOf(record)).map(Number).filter(Number.isSafeInteger),
      // 插件自己写下的替换点／恢复正文序号：老日志里的恢复正文没有 `form`，
      // 正文又是原文，只能靠这份账本把它们从「人类请求」里剔出去（P1-4）。
      pluginWrittenSeqs: [...pluginWrittenSeqs(record)],
      minimumChars: MIN_OPERATION_CHARS,
      lastAssistantSeq,
    })
  }

  /** Measure occupancy and select the oldest-safe candidates. Pure: no side effects. */
  async function measureOccupancy(record, signal, { persistClaims = true } = {}) {
    const settings = settingsOf(record)
    const { meter, host } = await resolveHostOccupancy(record, signal, services)
    const window = resolveWindow({
      contextWindow: host.contextWindow,
      reservedCompletionTokens: host.reservedCompletionTokens,
    })
    const view = surfaceViewOf(record, host.surfaceNodes, settings)
    // 活跃证据保护先于候选规划：先把"哪些证据还不能退出"定下来，再让规划器在
    // 剩余候选里挑。守卫在 `planCooling` 里先于任何副作用执行（不发节点 id、
    // 不写声明），所以被保护的候选不会留下痕迹。
    const protection = refreshProtections(record, view, { settings, persistState: persistClaims })
    const ordinalOf = new Map(view.candidates.map((candidate, index) => [candidate.rangeStart, index]))
    // Retention is the only trigger: the batch waits for the threshold to fill,
    // and batch *count* is what costs money, because each submitted batch
    // re-bills the prefix cache from its earliest touched node.
    const allocator = makeOrdinalAllocator(record)
    const claims = claimsOfRecord(record)
    const freshClaims = []
    const plan = planCooling({
      candidates: view.candidates,
      meter,
      // C-12 double fence: even callers handing stale candidates cannot plan
      // the model's current turn away.
      archiveFromSeq: view.lastAssistantSeq,
      nodeIdFor: (candidate) => {
        const rangeStart = candidate.rangeStart
        const existing = nodeClaimOf(record, rangeStart)
        const ordinal = existing && Number.isSafeInteger(Number(existing.ordinal)) && Number(existing.ordinal) >= 1
          ? Number(existing.ordinal)
          : null
        if (ordinal !== null) return nodeIdFor(record, ordinal)
        const fresh = allocator.next()
        if (persistClaims) {
          claims[rangeStart] = { ordinal: fresh, at: new Date().toISOString() }
          freshClaims.push(rangeStart)
        }
        return nodeIdFor(record, fresh)
      },
      // 全历史模式下保留窗口失效：retention 传 0，规划器不再按「最近 N 个操作」
      // 放行候选（面板上的「保留最近操作」同步变灰）。
      retainOperations: record.state?.fullHistory === true ? 0 : settings.retainOperations,
      batchSize: settings.archiveBatchSize,
      maxOperations: MAX_OPERATIONS_PER_BATCH,
      minNetReleaseTokens: MIN_NET_RELEASE_TOKENS,
      // C-12/C-07 sizing: one batch cannot release more than this many
      // estimated tokens; the rest waits for the next measure.
      maxReleaseTokens: MAX_BATCH_RELEASE_TOKENS,
      receiptMarker: dependencies.receiptMarker ?? RECEIPT_MARKER,
      // 活跃证据保护守卫：被保护的候选在租用冷节点 id 之前就被拒，绝不留下声明。
      // v2 传入曝光/配对守卫（guardUnit）时两道门都要过：保护层挡「证据能否安全
      // 退出投影」，guardUnit 挡「跨度结构与配对是否成立」。
      guard: (candidate) => {
        const verdict = protection.registry.guard(candidate)
        if (verdict.safe !== true) return verdict
        if (typeof dependencies.guardUnit === 'function') {
          return dependencies.guardUnit(record, candidate)
        }
        return verdict
      },
      // v2 的跨度回执缝：普通历史段的回执不冒充工具操作；缺省保持 v1 逐字节形态。
      receiptOf: dependencies.receiptOf ?? null,
    })
    // A dry-run must leave no claims behind: it writes nothing and its idea of
    // "the plan" is disposable. A committed measure keeps them so the batch (and
    // any retry after a partial failure) reuses the same node ids.
    if (!persistClaims) {
      for (const rangeStart of freshClaims) delete claims[rangeStart]
    }
    // 报告在规划**之后**生成：规划过程中守卫可能因证据修订变化释放软保护，
    // 这些释放必须出现在同一轮的 dry-run／status 里，而不是等到下一轮。
    const protectionReport = protection.registry.report()
    return {
      host,
      meter,
      window,
      view,
      plan,
      settings,
      cacheStats: cacheStatsOf(lastUsageOf(record.agent.session)),
      archivedCount: pendingReceipts(record).length,
      // 可解释性：保护集报告（成本、来源、原因、解除条件）与超预算降级记录，
      // dry-run／status 直接引用同一份事实，不另算一套。
      protection: protectionReport,
      // `formatOccupancy` 只按顺序展示这一行组（它不认识保护来源的语义）。
      protectionLines: protectionReport.lines,
      protectionReleased: protection.released,
      protectionBudget: protection.budget,
    }
  }

  /**
   * C3/O3：批提交前后的 usage 观测（只观测，不宣称因果）。
   *
   * 口径：批提交时刻取「最近完成请求」的 usage 作基线（pending）；下一次批提交
   * 时若日志里出现了**更新的** usage（携带它的 assistant/message seq 单调，作幂等
   * 标识），差额（后 input − 前 input，负数记 0）累计进 `observedInvalidationTokens`，
   * 并把前后命中率存进 `state.usageWatch.settled` 供 status/cost 展示。
   *
   * 诚实边界（O3 原文）：前后 usage 差额包含宿主自身压缩、其他注入等并发因素，
   * 只是量级参考与回归对比基线，不是「插件造成的失效」的因果断言。观测不到
   * （无 usage / 无新请求 / 本引擎无成本账本——v1 无 cost 面）时静默不记，
   * 不把「没有样本」冒充「没有失效」。
   */
  function observeUsageAroundBatch(record) {
    if (!record?.cost || typeof record.cost.bump !== 'function') return false
    const sample = lastUsageWithSeqOf(record.agent?.session)
    if (!sample) return false
    const usage = sample.usage ?? {}
    const inputTokens = Number(usage.inputTokens)
    const cacheReadTokens = Number(usage.cacheReadTokens ?? 0)
    if (!Number.isFinite(inputTokens) || !Number.isFinite(cacheReadTokens)) return false
    const current = { seq: sample.seq, inputTokens, cacheReadTokens }
    const watch = record.state.usageWatch ?? null
    const pending = watch?.pending ?? null

    // 结算上一批：pending 之后出现了新完成的请求 → 差额入账（seq 单调保证幂等，
    // 同一个 usage 样本不会被结算两次）。
    if (pending && Number.isFinite(pending.inputTokens) && current.seq > pending.seq) {
      const delta = Math.max(0, Math.floor(current.inputTokens - pending.inputTokens))
      record.cost.bump('observedInvalidationTokens', delta)
      const beforeStats = cacheStatsOf({ inputTokens: pending.inputTokens, cacheReadTokens: pending.cacheReadTokens ?? 0 })
      const afterStats = cacheStatsOf({ inputTokens: current.inputTokens, cacheReadTokens: current.cacheReadTokens })
      record.state.usageWatch = {
        pending: current,
        settled: {
          batchReplacements: watch.batchReplacements ?? null,
          before: pending,
          after: current,
          beforeHitRatio: beforeStats ? beforeStats.hitRatio : null,
          afterHitRatio: afterStats ? afterStats.hitRatio : null,
          deltaTokens: delta,
          at: new Date().toISOString(),
        },
      }
      return true
    }

    // 挂本批基线：批提交时刻的最近 usage。`batchReplacements` 在本批提交完成后回填。
    record.state.usageWatch = {
      pending: current,
      batchReplacements: null,
      settled: watch?.settled ?? null,
    }
    return true
  }

  /** Commit one batch. Each unit is independently durable. */
  async function runBatch(record, occupancy, signal) {
    const units = occupancy.plan.units
    if (!units.length) return { outcomes: [], releasedTokens: 0, applied: 0, failed: [], releaseCapped: occupancy.plan.releaseCapped === true }
    // C3/O3：先结算上一批的 usage 差额、再挂本批基线（提交时刻快照）。观测写进
    // state.usageWatch 随批事务一并落盘；结算计数由调用方的 persistCost 落盘——
    // 批全失败时该笔观测计数可能丢（尽力而为的观测，不冒充精确账目）。
    if (observeUsageAroundBatch(record)) {
      try {
        await persist(record)
      } catch {
        // 观测落盘失败不阻塞归档：usageWatch 留在内存，本批的 persist 还有机会。
      }
    }
    const client = await ensureClient(record)
    // 提交前复核：规划只是快照，保护集合可能在这之后变化（用户 pin、新的回注
    // 投递、刚闭合的调用）。守卫在每次写入前重新判定，被撤销的单元原文保留、
    // 不计入成功。
    const protection = refreshProtections(record, occupancy.view, { settings: settingsOf(record), persistState: true })
    const outcomes = await applyOperations({
      session: record.agent.session,
      client,
      units,
      meter: occupancy.meter,
      hostVersion,
      signal,
      guard: (unit) => protection.registry.guard(unit),
      // v2 用跨度种类各自的正文重建做漂移检查；v1 不传，保持原行为。
      bodyOf: dependencies.spanBodyOf ?? null,
      // P1-5：批次摘要回执的 marker 必须与本引擎其他回执一致（v1/v2 各有 marker）。
      receiptMarker: dependencies.receiptMarker ?? RECEIPT_MARKER,
      onOutcome: async (outcome) => {
        // verify-failed must reach the ledger too. The replacement was appended
        // and the original text is shadowed, so the cold record is the ONLY copy
        // left -- dropping the row made a failed commit indistinguishable from one
        // that never happened, and left no handle for restore.
        if (outcome.state !== 'applied' && outcome.state !== 'verify-failed') return
        // 成功即清账：这个区间的尝试计数、停摆记录都作废，否则一次成功之后
        // 它还会因为旧计数被当成"快停摆了"（P0-1）。
        if (Number.isInteger(outcome.rangeStart)) {
          delete retryBookOf(record)[outcome.rangeStart]
          delete parkedRangesOf(record)[outcome.rangeStart]
        }
        record.state.archive.push({
          rangeStart: outcome.rangeStart,
          rangeEnd: outcome.rangeEnd,
          callIds: outcome.callIds,
          tools: outcome.tools,
          // 归档行如实记下被替换对象的种类：只记 range/tools 会让「用户正文、
          // 旧回执」这类非工具跨度在账本里和工具操作长得一模一样（审计 P2-5(h)）。
          // 种类来自候选的 spanKind，经 unit → outcome 原样传到这里；
          // v1 工具操作没有这个字段，缺省不写，行形状保持不变。
          ...(typeof outcome.spanKind === 'string' && outcome.spanKind ? { spanKind: outcome.spanKind } : {}),
          nodeId: outcome.nodeId,
          hash: outcome.hash,
          chars: outcome.chars,
          originalTokens: outcome.originalTokens,
          // Kept so the restore guard can compute the real growth of restoring
          // (original minus receipt): the receipt tokens are already inside the
          // measured assembly, so adding the full original double-counts them.
          receiptTokens: Number.isFinite(Number(outcome.receiptTokens)) ? Number(outcome.receiptTokens) : undefined,
          // P0-2 对账：prune 里那份同一个数，落盘才能事后解释「回执 Σ 和
          // shadowedTokenCount 为什么不等」。
          shadowedTokenCount: Number.isFinite(Number(outcome.shadowedTokenCount)) ? Number(outcome.shadowedTokenCount) : undefined,
          replacementSeq: outcome.replacementSeq,
          chunkCount: outcome.chunkCount ?? 1,
          chunkIds: Array.isArray(outcome.chunkIds) ? [...outcome.chunkIds] : undefined,
          // Receipt-rebuild metadata must be durable: restore re-renders the
          // expected receipt from this row and compares it byte-for-byte with
          // the surface text. Leaving these out of the row would make every
          // restore after a restart render the legacy receipt and be rejected
          // as a conflict — the row, not the in-memory outcome, is what a later
          // process actually has.
          locators: Array.isArray(outcome.locators) ? [...outcome.locators] : [],
          statuses: Array.isArray(outcome.statuses) ? [...outcome.statuses] : [],
          receiptFormat: Number.isInteger(outcome.receiptFormat) ? outcome.receiptFormat : undefined,
          // P1-5：批次摘要回执的成员数随行落盘——恢复分组与对账都靠它。
          batchSize: Number.isInteger(outcome.batchSize) && outcome.batchSize > 1 ? outcome.batchSize : undefined,
          appliedAt: new Date().toISOString(),
          // The row records how the commit actually ended, not the happy path.
          status: outcome.state,
        })
        await persist(record)
      },
    })
    const releasedTokens = outcomes.reduce((sum, outcome) => sum + (outcome.state === 'applied' ? outcome.netReleaseTokens : 0), 0)
    const applied = outcomes.filter((outcome) => outcome.state === 'applied').length
    // C3/O3：本批实际替换段数回填进 usage 观测的基线（status 展示「这批之后
    // 观测到的差额」时才知道对应多大的批）。写 state 不另落盘：本批的
    // onOutcome / persistCost 路径会带上它。
    if (applied > 0 && record.state.usageWatch?.pending) {
      record.state.usageWatch.batchReplacements = applied
    }
    // verify-failed is NOT a cold-write failure: its chunks were written and
    // verified, so it must stay out of the orphan-cleanup and retry-ledger paths
    // below. Deleting its cold nodes would destroy the only copy of the original.
    const failed = outcomes.filter((outcome) => outcome.state !== 'applied' && outcome.state !== 'verify-failed')
    // 实际写入的记录数：一段可能分多块，账本按真实记录数记，不用替换段数顶替。
    const recordsWritten = outcomes.reduce(
      (sum, outcome) => sum + (outcome.state === 'applied' ? (outcome.chunkCount ?? 1) : 0),
      0,
    )
    // The failure ledger is DURABLE. The reason strings used to live only on the
    // in-memory record (`record.lastAction`), so a crash or a restart erased the
    // only trace of why a unit died — the sole reason a batch of six failures
    // had to be reconstructed from cold-store file timestamps in the first
    // forensics pass. State now carries both the summary and the per-unit rows.
    const failureRows = failed.map((outcome) => ({
      at: new Date().toISOString(),
      rangeStart: outcome.rangeStart,
      rangeEnd: outcome.rangeEnd,
      nodeId: outcome.nodeId,
      state: outcome.state,
      reason: outcome.reason,
    }))
    if (failureRows.length) {
      const log = Array.isArray(record.state.lastFailures) ? record.state.lastFailures : []
      record.state.lastFailures = [...log, ...failureRows].slice(-20)
      const claims = claimsOfRecord(record)
      const retryBook = retryBookOf(record)
      const parked = parkedRangesOf(record)
      const store = record.client
      const deletedOrphans = []
      const residue = []
      for (const outcome of failed) {
        const rangeStart = outcome.rangeStart
        // 尝试账：每个区间记「试了几次、最近一次为什么死」。到上界就进 parked，
        // 不再出现在候选里，但**必须**在 status 里如实列出——绝不静默丢弃。
        if (Number.isInteger(rangeStart)) {
          const row = retryBook[rangeStart] ?? { attempts: 0 }
          row.attempts = Number(row.attempts ?? 0) + 1
          row.lastState = outcome.state
          row.lastReason = outcome.reason
          row.at = new Date().toISOString()
          retryBook[rangeStart] = row
          if (row.attempts >= MAX_UNIT_RETRY_ATTEMPTS) {
            parked[rangeStart] = { ...row, parkedAt: new Date().toISOString() }
            delete retryBook[rangeStart]
          }
        }
        // 先删后写：`orphaned` 是我们自己 ordinal 上不可信的字节，重试前先删掉，
        // 下一次在同一 ordinal 上重写。删不掉不算致命——节点会退回探针路径，只是
        // 把「孤儿」升级成「残留」，照实上报。
        for (const nodeId of Array.isArray(outcome.orphanNodeIds) ? outcome.orphanNodeIds : []) {
          if (!store?.forgetNode) break
          let result
          try {
            result = await store.forgetNode(nodeId, signal, `上下文降温：P0-1 先删后写（seq ${outcome.rangeStart}–${outcome.rangeEnd}，${outcome.state}）`)
          } catch (error) {
            result = { ok: false, reason: error instanceof Error ? error.message : String(error) }
          }
          if (result?.ok) deletedOrphans.push(nodeId)
          else residue.push(`${nodeId}（${result?.reason ?? '冷库拒绝删除'}）`)
        }
        // 被别人的正文占住的 id 是**残留**而不是可删孤儿：插件无法证明那是自己写坏的
        // 字节，删掉有覆写他人内容的风险。它必须出现在 status 的残留行里，否则冷库
        // 条目数会悄悄大于回执数，而没人知道多出来的东西是什么（P0-1）。
        for (const nodeId of Array.isArray(outcome.residueNodeIds) ? outcome.residueNodeIds : []) {
          residue.push(`${nodeId}（已被其他正文占用，插件不覆写、不删除）`)
        }
        // 换号（remint）：只有「这个 ordinal 被别人的正文占住」才值得换号，因为覆写
        // 别人的内容绝不允许、复用又必然 hash 不符。换号前把旧 ordinal 记进失败账本
        // 的 `lastAction: 'remint'`，allocator 只认这一种记录为占用。
        if (outcome.retryable === false && Number.isInteger(rangeStart) && claims[rangeStart]) {
          record.state.lastFailures = [
            ...(Array.isArray(record.state.lastFailures) ? record.state.lastFailures : []),
            {
              at: new Date().toISOString(),
              rangeStart,
              rangeEnd: outcome.rangeEnd,
              nodeId: outcome.nodeId,
              state: outcome.state,
              reason: outcome.reason,
              lastAction: 'remint',
            },
          ].slice(-20)
          delete claims[rangeStart]
        }
      }
      if (deletedOrphans.length) {
        record.state.orphanCleanup = {
          at: new Date().toISOString(),
          deleted: deletedOrphans.slice(-40),
          count: Number(record.state.orphanCleanup?.count ?? 0) + deletedOrphans.length,
        }
      }
      if (residue.length) {
        record.state.coldResidue = {
          at: new Date().toISOString(),
          nodes: residue.slice(-40),
          count: Number(record.state.coldResidue?.count ?? 0) + residue.length,
        }
      }
    }
    record.state.lastAction = `${new Date().toISOString()}：尝试 ${outcomes.length}，成功 ${applied}，释放 ≈${releasedTokens} token；${summarizeOutcomes(outcomes)}`
    await persist(record)
    // The committed replacements changed the surface, so the pre-batch
    // measurement is stale. Re-measure so `status` reports the surface that now
    // exists rather than the one the batch started from.
    if (applied > 0) {
      try {
        record.occupancy = await measureOccupancy(record, signal)
        record.occupancyError = null
      } catch (error) {
        record.occupancy = null
        record.occupancyError = error instanceof Error ? error.message : String(error)
      }
    }
    return {
      outcomes,
      releasedTokens,
      applied,
      failed,
      // 实际写入冷库的记录数（含分块）：账本按它记账，不用「替换段数」冒充。
      recordsWritten,
      // 「一个都没成功」时给调用方一个可用的原因，别让它去猜（或谎报成功）。
      failureReason: applied === 0 && failed.length > 0 ? summarizeOutcomes(outcomes) : null,
      // Surfaced so the batch report can explain a short batch (C-08).
      releaseCapped: occupancy.plan.releaseCapped === true,
    }
  }

  /** Lazily open the isolated cold store for one session. */
  async function ensureClient(record) {
    if (record.client) return record.client
    if (record.clientError) throw record.clientError
    if (!dependencies.createClient) throw new Error('宿主未提供隔离冷库工厂。')
    try {
      record.client = await dependencies.createClient(record)
      return record.client
    } catch (error) {
      record.clientError = error
      throw error
    }
  }

  /** Restore every receipt whose cold record and surface are still exact. */
  async function restoreAll(record) {
    const rows = pendingReceipts(record)
    if (!rows.length) return { outcomes: [], restored: 0 }
    const client = await ensureClient(record)
    const outcomes = await restoreReceipts({
      session: record.agent.session,
      client,
      receipts: rows,
      receiptMarker: dependencies.receiptMarker ?? RECEIPT_MARKER,
    })
    for (const outcome of outcomes) {
      const stored = record.state.archive.find((row) => row.rangeStart === outcome.rangeStart
        && (row.status === 'applied' || row.status === 'verify-failed'))
      if (!stored) continue
      stored.status = outcome.state === 'restored' ? 'restored' : `restore-skipped: ${outcome.reason}`
      if (outcome.state === 'restored') stored.restoredSeq = outcome.restoredSeq
    }
    await persist(record)
    return { outcomes, restored: outcomes.filter((outcome) => outcome.state === 'restored').length }
  }

  /**
   * Record the newest measurement on the durable state, throttled.
   *
   * Without this, "the trigger was never reached" and "the measurement failed"
   * are indistinguishable once the session ends: `record.occupancy` lives only
   * in memory, and a no-op batch persists nothing. A real session reported zero
   * archives with no way to tell which of the two had happened.
   *
   * The write is throttled because this runs at every pre-step boundary. It
   * persists when there is nothing stored yet, when the decision changed, or
   * when the assembled estimate moved by at least 1% of the window — a movement
   * smaller than that cannot cross a trigger line the user set in whole
   * percent, so skipping it loses no diagnosis.
   */
  async function rememberMeasurement(record, occupancy, decision) {
    const previous = record.state.lastMeasurement ?? null
    const assembled = occupancy?.host?.assembledTokens ?? null
    const window = occupancy?.host?.contextWindow ?? null
    const kind = decision?.action ?? 'unknown'
    const reason = decision?.reason ?? ''
    const moved = previous === null
      || !Number.isFinite(previous.assembledTokens)
      || assembled === null
      || Math.abs(assembled - previous.assembledTokens) >= Math.max(1, Math.floor((window ?? 0) * 0.01))
    if (!moved && previous.kind === kind && previous.reason === reason) return
    record.state.lastMeasurement = {
      at: new Date().toISOString(),
      kind,
      reason,
      assembledTokens: assembled,
      contextWindow: window,
    }
    try {
      await persist(record)
    } catch (error) {
      logger.warn(`memory-context-lab: measurement not persisted: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * One automatic-cooling attempt at the stable pre-step boundary.
   *
   * Every precondition is re-checked on each call. A measurement failure pauses
   * automatic mode and keeps the originals. Returns a decision object instead
   * of throwing so the caller only has to log it.
   */
  async function runAutoCooling(record, signal) {
    const settings = settingsOf(record)
    if (!settings.auto) return { action: 'skip' }
    let occupancy
    try {
      occupancy = await measureOccupancy(record, signal)
    } catch (error) {
      record.occupancyError = error instanceof Error ? error.message : String(error)
      await rememberMeasurement(record, null, { action: 'unavailable', reason: record.occupancyError })
      return { action: 'unavailable', reason: record.occupancyError }
    }
    record.occupancy = occupancy
    record.occupancyError = null
    if (!occupancy.plan.units.length) {
      // Two distinct steady states must not be conflated: "fewer than batchSize
      // admissible operations have left the window" (normal waiting) versus
      // "enough left the window but protection holds them back" (protected).
      const held = occupancy.plan.outOfWindowCount - occupancy.plan.admissibleCount
      const reason = held > 0 ? 'waiting-batch-protected' : 'waiting-for-batch'
      await rememberMeasurement(record, occupancy, { action: 'noop', reason })
      return { action: 'noop', reason, held, shortfall: occupancy.plan.shortfall }
    }
    const result = await runBatch(record, occupancy, signal)
    if (!result.applied) {
      // 全失败必须如实报告：此前这里无条件记 `applied`，于是一次都没成功的批次
      // 会在 status／面板里显示成"已归档一批"，而实际正文仍在上下文里。
      const reason = result.failureReason ?? 'no-unit-applied'
      await rememberMeasurement(record, occupancy, { action: 'failed', reason })
      return { action: 'failed', applied: 0, reason, releasedTokens: 0, cacheStats: occupancy.cacheStats }
    }
    // The occupancy captured before the batch describes a surface that no longer
    // exists: the batch archived units and put receipts in their place. Recording
    // that stale value made status report an assembled-token count the user could
    // no longer see. Re-measure once so the stored number matches the surface.
    let afterBatch = occupancy
    try {
      afterBatch = await measureOccupancy(record, signal)
      record.occupancy = afterBatch
      record.occupancyError = null
    } catch (error) {
      record.occupancyError = error instanceof Error ? error.message : String(error)
    }
    await rememberMeasurement(record, afterBatch, { action: 'applied', reason: '' })
    return {
      action: 'applied',
      applied: result.applied,
      failed: result.failed?.length ?? 0,
      recordsWritten: result.recordsWritten,
      releasedTokens: result.releasedTokens,
      cacheStats: occupancy.cacheStats,
    }
  }

  /**
   * 当前仍在活动面上的回注投递，按**稳定消息 id** 判定。
   *
   * 「当前可见集合」与「历史注入记录」必须分开：只有上次注入的那条回注消息仍
   * 在活动面上，它带的冷节点才算"证据仍可见"。一旦该消息退出（被归档、被宿主
   * 压缩或会话回滚），同一冷节点就允许再次读回——否则历史投递记录会永久阻止
   * 模型重新取回它真正需要的证据。
   *
   * 用消息 id 匹配，不用文本前缀或相似度：文本可能被截断、改写或转义。
   */
  function pruneRecallDeliveries(record) {
    const session = record.agent?.session
    const live = new Set()
    if (session && Array.isArray(session.surface?.nodes)) {
      for (const seq of session.surface.nodes) {
        const id = session.eventAt(seq)?.data?.message?.id
        if (typeof id === 'string' && id) live.add(id)
      }
    }
    const rows = Array.isArray(record.recallDeliveries) ? record.recallDeliveries : []
    record.recallDeliveries = rows.filter((row) => live.has(row.messageId))
    return new Set(record.recallDeliveries.flatMap((row) => row.nodeIds))
  }

  /**
   * Build the recall digest for the newest user message.
   *
   * Returns the rendered text **and** the hits it was rendered from: the recall
   * protection needs the cold node ids, and re-deriving them from the digest
   * text would mean parsing back what we just formatted.
   *
   * `status` distinguishes the three ways a search can end. A refused or broken
   * store must never render as "no matching archive": the model would read an
   * empty digest as "this work was never done" and redo it.
   */
  async function buildRecall(record, query, signal) {
    const client = await ensureClient(record)
    const payload = await client.recall(query, signal, MAX_RECALL_HITS)
    const normalized = normalizeRecallPayload(payload, MAX_RECALL_HITS)
    if (normalized.status !== RECALL_STATUS.OK) {
      return { text: '', hits: [], status: normalized.status, reason: normalized.reason ?? '', skippedVisible: 0 }
    }
    const stillVisible = pruneRecallDeliveries(record)
    const fresh = normalized.summaries.filter((hit) => !stillVisible.has(hit.id))
    const digest = digestRecall(fresh)
    return {
      text: digest.text,
      hits: fresh,
      status: RECALL_STATUS.OK,
      reason: '',
      // 预算不足时如实标记：部分片段不得冒充完整证据。
      truncated: digest.truncated,
      omitted: digest.omitted,
      // 因为"同一证据仍在可见面上"而跳过的命中数：可观测，且用于说明为什么
      // 这一轮没有新内容注入。
      skippedVisible: normalized.summaries.length - fresh.length,
    }
  }

  /** 记录一次回注投递（供下一次判断"证据是否仍可见"）与一次尝试结果（供观测）。 */
  function rememberRecall(record, { messageId = '', nodeIds = [], queryId = '', status, reason = '', hits = 0, skippedVisible = 0, truncated = false, omitted = 0 }) {
    if (messageId && nodeIds.length) {
      const rows = Array.isArray(record.recallDeliveries) ? record.recallDeliveries : []
      record.recallDeliveries = [...rows, { messageId, nodeIds: [...nodeIds], queryId }].slice(-20)
    }
    const attempts = Array.isArray(record.recallAttempts) ? record.recallAttempts : []
    record.recallAttempts = [...attempts, {
      queryId,
      status,
      reason,
      hits,
      skippedVisible,
      truncated,
      omitted,
      at: new Date().toISOString(),
    }].slice(-5)
    record.lastRecall = record.recallAttempts[record.recallAttempts.length - 1]
  }

  /**
   * 召回结果临时保护（软）。
   *
   * 召回把冷记录重新注入到模型可见投影里；如果同一稳定边界上紧接着又把这批
   * 内容归档回去，"刚读回又归档"就白做一次，而且会再烧一次前缀缓存。所以这里
   * 给刚注入的冷记录、以及本次注入时仍在待归档计划里的操作建立**短期**软保护，
   * 带来源、原因、建立序号与解除条件；曝光不等于理解，到期即释放，绝不因此
   * 变成硬保护，也绝不阻止硬保护集合的正常判定。
   */
  function protectRecall(record, { hits = [], queryId = '', ranges = [] }) {
    const entries = recallProtectionEntries({
      nodeIds: hits.map((hit) => hit?.id).filter(Boolean),
      ranges,
      queryId,
      operationEpoch: Math.max(Number(record.state.protectionEpoch) || 0, pendingReceipts(record).length),
    })
    if (!entries.length) return { added: 0 }
    const registry = registryOf(record)
    let added = 0
    for (const entry of entries) {
      if (registry.addSoft(entry)) added += 1
    }
    registry.enforceBudget()
    record.state.protections = registry.snapshot()
    return { added }
  }

  /** `/memory-lab now` and `/memory-lab dry-run`. */
  async function runOnce(record, signal, { dryRun }) {
    let occupancy
    try {
      // A dry-run plans but commits nothing, so it must not rent cold-node ids.
      occupancy = await measureOccupancy(record, signal, { persistClaims: !dryRun })
    } catch (error) {
      record.occupancyError = error instanceof Error ? error.message : String(error)
      record.occupancy = null
      return { kind: 'error', text: `${dryRun ? '预演' : '降温'}失败关闭：${record.occupancyError}` }
    }
    record.occupancy = occupancy
    record.occupancyError = null
    if (dryRun) {
      const lines = ['预演（零副作用）：未写入冷库，未替换任何会话事件。', ...occupancyLines(occupancy)]
      if (!occupancy.plan.units.length) {
        lines.push(`保留窗口外 ${occupancy.plan.outOfWindowCount} 个操作里只有 ${occupancy.plan.readyCount ?? occupancy.plan.admissibleCount ?? 0} 个合格，未攒够 ${occupancy.plan.batchSize} 个；等合格候选攒够就会自动归档，与占用率无关。`)
      } else {
        lines.push(`将在单批内按 seq 从旧到新处理：${occupancy.plan.units.map((unit) => `${unit.rangeStart}–${unit.rangeEnd}`).join(', ')}`)
        lines.push('单批提交：替换最旧节点会让其后整段上下文的前缀缓存失效一次，批次数越多代价越大，因此一批做够而不是分批。')
      }
      if (occupancy.view.skipped.length) {
        const shown = occupancy.view.skipped.slice(0, 8).map((item) => `seq ${item.seq}（${item.description}）`)
        lines.push(`受保护／不合格：${shown.join('；')}${occupancy.view.skipped.length > shown.length ? ' …' : ''}`)
      }
      return { kind: 'success', text: lines.join('\n') }
    }
    if (!occupancy.plan.units.length) {
      // `/memory-lab now` is not the dry run: it may record what it measured, so
      // a session that is still filling its first batch leaves evidence behind.
      const held = occupancy.plan.outOfWindowCount - occupancy.plan.admissibleCount
      const reason = held > 0 ? 'waiting-batch-protected' : 'waiting-for-batch'
      await rememberMeasurement(record, occupancy, { action: 'noop', reason })
      // 两种"没归档"必须说清：合格候选不够，还是够条件但被保护挡住。
      const explanation = held > 0
        ? `无需归档：窗口外有 ${occupancy.plan.outOfWindowCount} 个操作，其中 ${held} 个受保护，过滤后只剩 ${occupancy.plan.admissibleCount} 个合格候选，未攒够 ${occupancy.plan.batchSize} 个。`
        : `无需归档：保留窗口外只有 ${occupancy.plan.outOfWindowCount} 个操作，未攒够 ${occupancy.plan.batchSize} 个。`
      return {
        kind: 'success',
        text: `${explanation}当前 ≈${occupancy.host.assembledTokens} token。`,
      }
    }
    const result = await runBatch(record, occupancy, signal)
    const released = {
      ...occupancy,
      plan: { ...occupancy.plan, plannedReleaseTokens: result.releasedTokens },
      archivedCount: pendingReceipts(record).length,
    }
    return {
      kind: 'success',
      text: `${formatBatchReport(result)}\n\n${occupancyLines(released)}`,
      // 计数随结果返回：调用方据此记账，不去解析人类可读文本。
      applied: result.applied,
      failed: result.failed?.length ?? 0,
      recordsWritten: result.recordsWritten,
    }
  }

  /** `/memory-lab restore`. */
  async function runRestore(record) {
    const result = await restoreAll(record)
    return {
      kind: 'success',
      text: formatRestoreReport(result),
      // 计数一并返回：调用方（v2 的 off 路径）要如实报告「恢复了几段／共几段」，
      // 不该去解析人类可读文本。
      restored: result.restored,
      before: result.outcomes.length,
    }
  }

  /** Human-readable status for the panel's log area and `/memory-lab status`. */
  /**
   * 回注的观测行（C-04）。
   *
   * 四种结局必须能被区分，绝不能都显示成"没有相关信息"：
   * `ok` 且命中 0 条 = 真的没命中；`ok` 且被裁剪 = 预算不足（部分证据）；
   * `unsupported` = 冷库拒绝了这次读取；`unavailable` = 调用本身失败。
   * 后两种都不代表"这段历史不存在"。
   */
  function recallStatusLines(record) {
    const last = record.lastRecall ?? (Array.isArray(record.recallAttempts) ? record.recallAttempts.at(-1) : null)
    if (!last) {
      // 没识别到人类提示时，回注**永远不会触发**。这是能力边界，必须说出来：
      // 静默的"没有回注"会被误读成"没有需要回注的东西"。
      return [record.humanPromptSeen === true
        ? '自动回注：已识别到人类提示，但本次运行还没有发生过检索尝试。'
        : '自动回注：尚未识别到人类提示（判定要求 `role==="user"` 且 `source.kind==="user"` 且不是本插件回执），因此回注不会触发；历史注入记录也不持久化。']
    }
    const head = `自动回注：最近一次 ${last.at}（query=${last.queryId || 'n/a'}）`
    if (last.status === RECALL_STATUS.OK) {
      const parts = [`命中 ${last.hits} 条并注入`]
      if (last.skippedVisible) parts.push(`跳过 ${last.skippedVisible} 条（同一证据仍在可见面上，避免重复注入）`)
      if (last.truncated) parts.push(`受回注预算裁剪，省略 ${last.omitted} 条——注入内容不是完整证据`)
      if (!last.hits && !last.skippedVisible) parts.push('冷库正常应答但没有匹配记录（这是"未命中"，不是读取失败）')
      return [`${head}：${parts.join('；')}。`]
    }
    const label = last.status === RECALL_STATUS.UNAVAILABLE ? '冷库不可用（调用失败）' : '冷库拒绝读取（不支持该视图）'
    return [`${head}：${label}——${last.reason || '原因未记录'}。这不等于"没有相关信息"。`]
  }

  function formatStatus(record) {
    if (!record) return '当前会话未启用上下文降温。使用 /memory-lab on 启用。'
    const settings = settingsOf(record)
    const pending = pendingReceipts(record).length
    const restored = record.state.archive.filter((row) => row.status === 'restored').length
    const suppression = record.suppressionLease?.stats?.() ?? { write: 0, read: 0 }
    const lines = [
      `上下文降温：已启用（session=${record.sessionId}）`,
      `保留最近操作：${settings.retainOperations} 个（唯一触发线，一直生效）`,
      `归档节奏：保留窗口外攒够 ${settings.archiveBatchSize} 个操作提交一批`,
      `自动降温：${settings.auto ? '开' : '关'}；自动回注：${settings.autoRecall ? '开' : '关'}`,
      `已归档操作：${pending} 个；已恢复：${restored} 个`,
      `真实灵枢抑制：本会话已拦截自动 ${suppression.write} 写 / ${suppression.read} 读调用。`,
      '工具集不变：插件从不增删模型可见的工具，因此不会因工具变化作废前缀缓存。',
    ]
    if (record.occupancyError) lines.push(`占用率：已失败关闭（${record.occupancyError}）`)
    else if (record.occupancy) lines.push(...occupancyLines(record.occupancy))
    else {
      lines.push('占用率：尚未测量（下一次请求前的稳定边界会自动测量）。', formatCacheLine(cacheStatsOf(lastUsageOf(record.agent.session))))
      const stored = record.state.lastMeasurement
      if (stored) lines.push(formatStoredMeasurement(stored))
    }
    // C-01/C-08 visibility: the receipt-view probe result is decided once at
    // enablement and every recall depends on it, so surface it instead of
    // letting an unsupported store degrade recall into an empty digest.
    if (record.client?.receiptView) {
      const probe = record.client.receiptView
      if (probe.supported === true) lines.push('冷库读取：receipt 视图可用（回执可召回）。')
      else if (probe.supported === false) lines.push(`冷库读取：receipt 视图不受支持——回注将失败而不是回退正式灵枢（${probe.reason ?? 'store 拒绝 view 参数'}）。`)
      else lines.push('冷库读取：receipt 视图未确认（探测暂不可达）；召回仍会携带 view 参数，被拒时按失败处理。')
    }
    const lastAction = record.state.lastAction ?? record.lastAction
    if (lastAction) lines.push(`最近一次：${lastAction}`)
    lines.push(...recallStatusLines(record))
    const failures = Array.isArray(record.state.lastFailures) ? record.state.lastFailures.slice(-20) : []
    if (failures.length) {
      lines.push('最近失败（原因已持久化；重试沿用同一冷节点）：')
      for (const row of failures.slice(-3).reverse()) {
        lines.push(`- ${row.at} seq ${row.rangeStart}–${row.rangeEnd}（${row.nodeId}）：${row.state}——${row.reason}`)
      }
    }
    // P0-1 如实上报：重试账、停摆区间、删掉的孤儿、删不掉的残留。四者都必须可见，
    // 否则「区间没被归档」看起来和「没有可归档的东西」一模一样。
    const retryBook = record.state.unitRetries && typeof record.state.unitRetries === 'object' ? record.state.unitRetries : {}
    const retrying = Object.entries(retryBook).filter(([, row]) => Number(row?.attempts) > 0)
    if (retrying.length) {
      lines.push(`重试中（沿用同一 ordinal，上界 ${MAX_UNIT_RETRY_ATTEMPTS} 次）：`)
      for (const [rangeStart, row] of retrying.slice(-5)) {
        lines.push(`- seq ${rangeStart} 起：已试 ${row.attempts} 次，最近 ${row.lastState}——${row.lastReason}`)
      }
    }
    const parked = record.state.parkedRanges && typeof record.state.parkedRanges === 'object' ? record.state.parkedRanges : {}
    const parkedRows = Object.entries(parked)
    if (parkedRows.length) {
      lines.push(`已停摆（重试达上界，不再自动重试；原文仍在活动面）：${parkedRows.length} 个区间`)
      for (const [rangeStart, row] of parkedRows.slice(-5)) {
        lines.push(`- seq ${rangeStart} 起：共试 ${row.attempts} 次，最近 ${row.lastState}——${row.lastReason}；解除用 /memory-lab now 前先排查冷库`)
      }
    }
    const cleanup = record.state.orphanCleanup
    if (cleanup?.count) lines.push(`先删后写：已删除自身写坏的冷节点 ${cleanup.count} 个（最近 ${cleanup.at}）。`)
    const residue = record.state.coldResidue
    if (residue?.count) {
      lines.push(`冷库残留：${residue.count} 个节点无法确认归属，未删除（不静默污染占用率）：`)
      for (const row of (residue.nodes ?? []).slice(-3)) lines.push(`- ${row}`)
    }
    // P0-2：回执 Σ 与 prune.shadowedTokenCount 量的是同一对象、取的都是宿主 meter 的
    // 启发式价（见 docs/降温模式.md「token 口径与对账」）。实测样本逐条严格相等；一旦
    // 差额超过阈值就必须报出来，不能让它看起来像"两个数本来就该差"。
    const accounting = tokenAccountingOf(record.state.archive)
    if (accounting && accounting.ratio > TOKEN_ACCOUNTING_TOLERANCE) {
      lines.push(
        `token 对账：回执 Σ${accounting.receipt} vs compaction/prune.shadowedTokenCount Σ${accounting.prune}`
        + `（${accounting.compared} 条，差 ${(accounting.ratio * 100).toFixed(1)}% > ${(TOKEN_ACCOUNTING_TOLERANCE * 100).toFixed(0)}%）`
        + '——两条路径都是宿主 meter 的启发式价，差额只可能来自测量缺口或活动面变化；两者都不含 inputTokens。',
      )
    }
    return lines.join('\n')
  }

  /**
   * `/memory-lab protect`：保护集明细。
   *
   * 输入是一次**无副作用**测量（`persistClaims:false`），所以查询本身不会改动
   * 任何状态。只报告确定性元数据：段位置、来源、原因、建立序号、解除条件、成本。
   */
  function formatProtection(occupancy) {
    if (!occupancy?.protection) return '活跃证据保护：尚未测量（先执行 /memory-lab status 或 dry-run）。'
    const lines = [...occupancy.protection.lines]
    const budget = occupancy.protectionBudget
    if (budget) {
      lines.push(`保护成本：软保留 ≈${budget.softTokens} token（预算 ${budget.budgetTokens} token）；硬保护 ≈${budget.hardTokens} token，不占软预算。`)
      if (budget.overBudget) {
        lines.push(`软保护超预算：本轮按合法降级释放 ${budget.released?.length ?? 0} 段最弱软保留；硬保护一段未动（到期不是删除硬保护的授权）。`)
      }
    }
    const released = Array.isArray(occupancy.protectionReleased) ? occupancy.protectionReleased : []
    if (released.length) {
      lines.push('本轮解除的软保留：')
      for (const entry of released.slice(0, 5)) lines.push(`- ${entry.target?.seq ?? entry.target?.rangeStart ?? entry.target?.nodeId}：${entry.releasedBecause}`)
    }
    lines.push(
      '硬保护来自真实结构与宿主状态（未返回调用、未曝光结果、待确认副作用、运行中的 job、系统／人类约束），命令不能解除；',
      '软保留（召回刚读回、任务关联线索、显式 pin）受预算约束，到期或 /memory-lab unpin 后释放。',
      '路径相同只作关联线索，不证明语义依赖或版本相同——插件不假装能自动理解任务关系。',
    )
    return lines.join('\n')
  }

  return {
    settingsOf,
    pendingReceipts,
    measureOccupancy,
    runBatch,
    runAutoCooling,
    runOnce,
    runRestore,
    buildRecall,
    rememberRecall,
    protectRecall,
    formatStatus,
    formatProtection,
    pinOperation,
    unpinOperation,
    ensureClient,
  }
}
