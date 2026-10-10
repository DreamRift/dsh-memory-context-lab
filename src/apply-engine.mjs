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
  OccupancyUnavailableError,
  occupancyLines,
  openTurnOf,
  planCooling,
  recallDigest,
  resolveWindow,
  restoreReceipts,
  summarizeOutcomes,
} from './apply.mjs'
import {
  MAX_OPERATIONS_PER_BATCH,
  MIN_NET_RELEASE_TOKENS,
  MIN_OPERATION_CHARS,
  normalizeSettings,
} from './core.mjs'

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
  const action = stored?.kind === 'applied' ? '已归档一批' : (stored?.reason === 'waiting-for-batch' ? '未触发归档（等待批量攒满）' : '未触发归档')
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
 * Issue fresh node ordinals that never collide with a claim or an applied
 * receipt, no matter which process wrote them: reuse shifts with pending counts,
 * these ids are owned for the session's lifetime.
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
  // Orphaned writes: a `cold-write-failed`/`orphaned` row names a node id that
  // already holds bytes in this session's store, so it must never be re-issued
  // for a different body. Reading the durable failure ledger (not the live
  // claims, which self-heal deletes) is what keeps a re-minted ordinal from
  // colliding with the orphan its predecessor left behind.
  for (const row of Array.isArray(record.state.lastFailures) ? record.state.lastFailures : []) {
    mark(row?.nodeId)
  }
  let next = used.size ? 1 + Math.max(...used) : 1
  return { next: () => next++ }
}

/**
 * Durable per-range cold-node claims.
 *
 * See `nodeClaimOf`.
 */
export function createEngine(dependencies) {
  const { persist, nodeIdFor, hostVersion, services, logger } = dependencies

  /** The live settings for one record, normalized. */
  function settingsOf(record) {
    const settings = normalizeSettings(record.state.settings)
    record.state.settings = settings
    return settings
  }

  /** Receipts still shadowing the active surface. */
  function pendingReceipts(record) {
    return record.state.archive.filter((row) => row.status === 'applied')
  }

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
    return collectOperationCandidates({
      surfaceNodes: [...session.surface.nodes],
      eventAt: (seq) => session.eventAt(seq),
      measuredNodes,
      retainOperations: settings.retainOperations,
      openTurn: openTurnOf(session),
      archivedRanges: pendingReceipts(record).map((row) => ({ start: row.rangeStart, end: row.rangeEnd })),
      minimumChars: MIN_OPERATION_CHARS,
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
      retainOperations: settings.retainOperations,
      batchSize: settings.archiveBatchSize,
      maxOperations: MAX_OPERATIONS_PER_BATCH,
      minNetReleaseTokens: MIN_NET_RELEASE_TOKENS,
    })
    // A dry-run must leave no claims behind: it writes nothing and its idea of
    // "the plan" is disposable. A committed measure keeps them so the batch (and
    // any retry after a partial failure) reuses the same node ids.
    if (!persistClaims) {
      for (const rangeStart of freshClaims) delete claims[rangeStart]
    }
    return {
      host,
      meter,
      window,
      view,
      plan,
      settings,
      cacheStats: cacheStatsOf(lastUsageOf(record.agent.session)),
      archivedCount: pendingReceipts(record).length,
    }
  }

  /** Commit one batch. Each unit is independently durable. */
  async function runBatch(record, occupancy, signal) {
    const units = occupancy.plan.units
    if (!units.length) return { outcomes: [], releasedTokens: 0, applied: 0, failed: [] }
    const client = await ensureClient(record)
    const outcomes = await applyOperations({
      session: record.agent.session,
      client,
      units,
      meter: occupancy.meter,
      hostVersion,
      signal,
      onOutcome: async (outcome) => {
        if (outcome.state !== 'applied') return
        record.state.archive.push({
          rangeStart: outcome.rangeStart,
          rangeEnd: outcome.rangeEnd,
          callIds: outcome.callIds,
          tools: outcome.tools,
          nodeId: outcome.nodeId,
          hash: outcome.hash,
          chars: outcome.chars,
          originalTokens: outcome.originalTokens,
          replacementSeq: outcome.replacementSeq,
          chunkCount: outcome.chunkCount ?? 1,
          chunkIds: Array.isArray(outcome.chunkIds) ? [...outcome.chunkIds] : undefined,
          appliedAt: new Date().toISOString(),
          status: 'applied',
        })
        await persist(record)
      },
    })
    const releasedTokens = outcomes.reduce((sum, outcome) => sum + (outcome.state === 'applied' ? outcome.netReleaseTokens : 0), 0)
    const applied = outcomes.filter((outcome) => outcome.state === 'applied').length
    const failed = outcomes.filter((outcome) => outcome.state !== 'applied')
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
      // Self-heal a poisoned claim: `cold-write-failed` means this unit's cold
      // node id already holds a *different* body — an orphaned write from an
      // earlier attempt whose replacement never landed. Reusing that claim on
      // every retry makes the unit fail deterministically forever (this is the
      // exact loop observed in production: 10 attempted, 0 applied, all
      // `cold-write-failed`, archive count frozen). Dropping the claim lets the
      // next measurement mint a fresh ordinal for the same range, so the unit
      // gets a clean node id instead of colliding with its own orphan. The
      // orphan stays in the isolated store, unreferenced and never re-read.
      const claims = claimsOfRecord(record)
      for (const outcome of failed) {
        if (outcome.state === 'cold-write-failed' && Number.isInteger(outcome.rangeStart)) {
          delete claims[outcome.rangeStart]
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
    return { outcomes, releasedTokens, applied, failed }
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
    const outcomes = await restoreReceipts({ session: record.agent.session, client, receipts: rows })
    for (const outcome of outcomes) {
      const stored = record.state.archive.find((row) => row.rangeStart === outcome.rangeStart && row.status === 'applied')
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
      // The normal steady state: fewer than `batchSize` operations have left
      // the retention window yet, so the plugin is deliberately holding them
      // verbatim until the batch fills.
      await rememberMeasurement(record, occupancy, { action: 'noop', reason: 'waiting-for-batch' })
      return { action: 'noop', reason: 'waiting-for-batch' }
    }
    const result = await runBatch(record, occupancy, signal)
    await rememberMeasurement(record, occupancy, { action: 'applied', reason: '' })
    return {
      action: 'applied',
      applied: result.applied,
      releasedTokens: result.releasedTokens,
      cacheStats: occupancy.cacheStats,
    }
  }

  /** Build the recall digest for the newest user message, or '' when there is none. */
  async function buildRecall(record, query, signal) {
    const client = await ensureClient(record)
    return recallDigest({ client, query, signal })
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
        lines.push(`保留窗口外只有 ${occupancy.plan.outOfWindowCount} 个操作，未攒够 ${occupancy.plan.batchSize} 个；等它攒够就会自动归档，与占用率无关。`)
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
      await rememberMeasurement(record, occupancy, { action: 'noop', reason: 'waiting-for-batch' })
      return {
        kind: 'success',
        text: `无需归档：保留窗口外只有 ${occupancy.plan.outOfWindowCount} 个操作，未攒够 ${occupancy.plan.batchSize} 个；当前 ≈${occupancy.host.assembledTokens} token。`,
      }
    }
    const result = await runBatch(record, occupancy, signal)
    const released = {
      ...occupancy,
      plan: { ...occupancy.plan, plannedReleaseTokens: result.releasedTokens },
      archivedCount: pendingReceipts(record).length,
    }
    return { kind: 'success', text: `${formatBatchReport(result)}\n\n${occupancyLines(released)}` }
  }

  /** `/memory-lab restore`. */
  async function runRestore(record) {
    const result = await restoreAll(record)
    return { kind: 'success', text: formatRestoreReport(result) }
  }

  /** Human-readable status for the panel's log area and `/memory-lab status`. */
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
    const lastAction = record.state.lastAction ?? record.lastAction
    if (lastAction) lines.push(`最近一次：${lastAction}`)
    const failures = Array.isArray(record.state.lastFailures) ? record.state.lastFailures.slice(-20) : []
    if (failures.length) {
      lines.push('最近失败（原因已持久化；重试沿用同一冷节点）：')
      for (const row of failures.slice(-3).reverse()) {
        lines.push(`- ${row.at} seq ${row.rangeStart}–${row.rangeEnd}（${row.nodeId}）：${row.state}——${row.reason}`)
      }
    }
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
    formatStatus,
    ensureClient,
  }
}
