/**
 * v2 降温自动钩子域（0.13.1 P4c）。
 *
 * 从 `runtime.mjs` 摘出：自动降温的触发与执行、指纹补采、索引增量、批次记账、
 * 恢复后的读取账本失效、归档读取登记，以及进程收尾。函数体逐字搬移，语义零改动。
 *
 * ## 装配契约
 * `createCoolingDomain({...})` 收共享注册表（`records` / `factories`）与
 * 同级域入口（`adopt` / `disposeRecord` / `persistCost` / `compressDepsOf` /
 * `foldWorkingCards`）。`records` / `factories` 必须传对象本体。
 *
 * ## 失败关闭口径
 * 记账与索引都是**派生**动作：失败只记告警，绝不让降温或回读失败。唯一例外是
 * `invalidateLedgerForRestore`——恢复后读取账本必须失效，否则模型会被告知
 * 「这段你已经读过」，而原文其实刚回到活动面。
 */
import { CARD_NET_CHAR_CAP } from './card-fold.mjs'
import { maybeStageCompress } from './hierarchy-coordinator.mjs'
import { invalidateReadLedger, registerReads } from './read-ledger.mjs'
import { syncRetrievalIndex } from './retrieval.mjs'
import { getForgetIndex } from './disposition.mjs'
import { syncVerification } from './verification.mjs'
import { unparkRanges } from './parked-ranges.mjs'

export function createCoolingDomain({
  records,
  factories,
  activeOperations,
  engine,
  factoryFor,
  adopt,
  disposeRecord,
  persistCost,
  logger,
  backendForSession,
  compressDepsOf,
  foldWorkingCards,
  semanticBackendCloseAll,
  semanticBackendEnsure,
  stageCompress,
}) {
  async function autoCooling(agent, signal) {
    const record = await adopt(agent)
    if (!record) return { action: 'skip' }
    const outcome = await engine.runAutoCooling(record, signal)
    accountBatch(record, outcome)
    // 全历史模式下，灵枢临时记忆是一等回注来源：有写入就保证后端在线并增量同步。
    // 启动一次，之后 backendForSession 直接命中；启动失败不重试、不影响归档，
    // 状态面照实显示「检索当前只用字面索引」。
    if (record.state.fullHistory === true && Number(outcome.applied) > 0 && !backendForSession(record.sessionId)) {
      try {
        if (typeof semanticBackendEnsure === 'function') {
          await semanticBackendEnsure({
            sessionId: record.sessionId,
            storeRoot: record.directory,
            signal: signal ?? undefined,
          })
        }
      } catch (error) {
        logger?.warn?.(`v2 全历史模式检索后端启动失败（归档不受影响）：${error?.message ?? error}`)
      }
    }
    await indexNewRecords(record)
    await captureNewFingerprints(record)
    // P3：层级压缩默认关；显式开启后，本批归档结束时尝试对连续已完成回执组做
    // 聚合凭证替换。失败只记告警、不破坏归档结果（失败不破坏原状态）。
    if (record.state.hierarchyCompress === true && Number(outcome.applied) > 0) {
      try {
        const stage = typeof stageCompress === 'function' ? stageCompress : maybeStageCompress
        const compressOutcome = await stage(await compressDepsOf(record), { enabled: true })
        if (compressOutcome?.triggered && Number(compressOutcome.applied) > 0) {
          logger?.info?.(`v2 层级压缩：${compressOutcome.applied} 组已替换为聚合凭证（拒绝 ${compressOutcome.rejected ?? 0}，失败 ${compressOutcome.failures ?? 0}）。`)
        }
      } catch (error) {
        // 保留错误类型：ReferenceError/TypeError 与业务拒绝必须能在日志里区分。
        logger?.warn?.(`v2 层级压缩尝试失败（原回执保持原样）：${error?.name ?? 'Error'}: ${error?.message ?? error}`)
      }
    }
    // S3 卡片组折叠（有界治理）：归档批完成后顺带收敛插件卡组。失败只记告警，
    // 绝不影响归档结果；无卡组时是零开销的一次扫描。
    try {
      const foldOutcome = await foldWorkingCards(agent)
      if (foldOutcome.folded > 0) {
        logger?.info?.(`memory-context-lab: 折叠 ${foldOutcome.folded} 组插件工作卡（失败 ${foldOutcome.failed ?? 0}）。`)
      } else if (foldOutcome.occupancy?.overCap === true) {
        // P0-4：上界到了却折不动，必须说出来。真实形态下每步一卡会被 assistant
        // 消息断开（G2），这时「净占用有上界」只是愿望；如实报告比假装有界好。
        logger?.warn?.(`memory-context-lab: 卡片净占用 ≈${foldOutcome.occupancy.chars} 字符超过上限 ${CARD_NET_CHAR_CAP}，但当前没有可折叠的连续卡组（卡之间隔着非卡节点）。`)
        record.cost.bump('cardCapUnreached', 1)
        void persistCost(record)
      }
    } catch (error) {
      logger?.warn?.(`memory-context-lab: 卡组折叠跳过：${error?.message ?? error}`)
    }
    return outcome
  }

  /**
   * 归档后增量采集验证指纹（差集式，只补「已落库但旁证无条目」的记录）。
   *
   * 纪律与 indexNewRecords 一致：旁证失败不影响归档（原文已在权威事务里），
   * 只记告警；check 时这些记录按未验证处理，绝不伪造 valid。
   */
  async function captureNewFingerprints(record) {
    if (typeof record?.directory !== 'string') return
    try {
      await factoryFor(record).withStore((store) => syncVerification({
        store,
        sessionDir: record.directory,
        warn: (message) => logger?.warn?.(message),
      }))
    } catch (error) {
      logger?.warn?.(`v2 归档后指纹采集失败（原文已保存，验证按未验证处理）：${error?.message ?? error}`)
    }
  }

  /**
   * 归档之后增量更新检索索引——**只在后端已经为该会话启动时**。
   *
   * 为什么不隐式启动：起一个隔离灵枢子进程是有真实代价的动作，自动降温每批都
   * 触发它会把「按需」变成「无条件」。所以启动权留给显式的 `/memory-lab index sync`，
   * 之后新写入的记录会随归档增量进索引，不需要反复手工同步。
   *
   * 索引失败不影响归档结果（原文已经在权威事务里）：如实记一条告警，
   * 状态面的「索引记账」会显示缺口，绝不把失败说成索引完整。
   */
  async function indexNewRecords(record) {
    const backend = backendForSession(record?.sessionId ?? null)
    if (!backend || typeof record?.directory !== 'string') return
    try {
      const synced = await factoryFor(record).withStore(async (store) => syncRetrievalIndex({
        directory: record.directory,
        backend,
        store,
        // 同 sync 命令面：归档后增量同步排除软遗忘记录。
        forgetIndex: await getForgetIndex(record.directory),
      }))
      if (synced.indexedTotal < synced.total) {
        logger?.warn?.(`v2 索引未覆盖全部记录（${synced.indexedTotal}/${synced.total}），`
          + '未覆盖部分仍可按记录 ID 精确回读')
      }
    } catch (error) {
      logger?.warn?.(`v2 归档后增量索引失败（原文已保存，索引落后）：${error?.message ?? error}`)
    }
  }

  /**
   * 把一次批量结果记进成本账本。
   *
   * 计数必须挂在**真正发生提交**的地方：`recordsWritten` 用实际写入的记录数，
   * `historyReplacements` 用实际替换的段数。没有提交就一个都不加——「跑了但没写」
   * 不能算成写入，否则账本会替一个没发生的动作作证。
   */
  function accountBatch(record, outcome) {
    if (!record?.cost || !outcome) return
    const applied = Number(outcome.applied)
    if (!Number.isFinite(applied) || applied <= 0) return
    record.cost.bump('historyReplacements', applied)
    record.cost.bump('memoryWrites', 1)
    const written = Number(outcome.recordsWritten)
    record.cost.bump('recordsWritten', Number.isFinite(written) && written > 0 ? written : applied)
    void persistCost(record)
    // 0.12.0 P0-2：把本批里含读取结果的操作登记进读取账本。只记键（path|offset）、
    // 冷记录指针与 hash，**不记正文**；重读计数在这里才第一次可见。
    void registerArchivedReads(record, outcome)
  }

  /**
   * restore 后让读取账本失效（0.12.0 P0-2）。
   *
   * 被恢复的区间已回到活动面，再标「该区间已于 seq N 归档」就是谎报；失败只记
   * 告警——账本写不进去不能让恢复本身看起来失败。
   */
  async function invalidateLedgerForRestore(record, outcome) {
    // 引擎返回的是 `outcomes`（每行 `{ state, nodeId, rangeStart }`）；`rows` 是旧
    // 形状的别名，两个都认，避免恢复路径因为字段改名而静默不失效账本。
    const rows = Array.isArray(outcome?.outcomes) ? outcome.outcomes : (Array.isArray(outcome?.rows) ? outcome.rows : [])
    const restoredRows = rows.filter((row) => row && (row.state === 'restored' || row.restored === true))
    const nodeIds = restoredRows.map((row) => row.nodeId).filter((id) => typeof id === 'string' && id !== '')
    const seqs = restoredRows.map((row) => row.rangeStart).filter((seq) => Number.isInteger(seq))
    if (nodeIds.length === 0 && seqs.length === 0) return
    try {
      const removed = await invalidateReadLedger(record.directory, { nodeIds, seqs })
      if (!removed.ok) {
        logger?.warn?.('memory-context-lab: 恢复后读取账本失效失败（原文已回活动面，账本标记可能陈旧）：' + (removed.error ?? '未知原因'))
      }
    } catch (error) {
      logger?.warn?.('memory-context-lab: 恢复后读取账本失效异常：' + (error?.message ?? String(error)))
    }
  }

  /**
   * 归档后登记读取键（0.12.0 P0-2）。
   *
   * 失败只记告警：账本损坏时**不重建为空**（失败关闭在 read-ledger 里），归档本身
   * 已经成功，不能因为账本写不进去就把它说成失败。
   */
  async function registerArchivedReads(record, outcome) {
    const rows = Array.isArray(outcome?.outcomes) ? outcome.outcomes : []
    const reads = []
    for (const row of rows) {
      if (row?.state !== 'applied') continue
      const keys = Array.isArray(row.readKeys) ? row.readKeys : []
      if (keys.length === 0) continue
      for (const key of keys) {
        reads.push({
          key,
          seq: Number.isInteger(row.rangeStart) ? row.rangeStart : null,
          coldRecordId: typeof row.nodeId === 'string' ? row.nodeId : null,
          hash: typeof row.hash === 'string' ? row.hash : null,
          chars: Number.isFinite(Number(row.chars)) ? Number(row.chars) : 0,
        })
      }
    }
    if (reads.length === 0) return
    try {
      const step = rows.reduce((max, row) => (Number.isInteger(row?.rangeEnd) ? Math.max(max, row.rangeEnd) : max), 0)
      const registered = await registerReads(record.directory, { reads, step: step > 0 ? step : null })
      if (!registered.ok) {
        logger?.warn?.('memory-context-lab: 读取账本写入失败（原文与归档均已落盘，重读计数暂不可见）：' + (registered.error ?? '未知原因'))
        return
      }
      if (registered.repeats > 0) {
        record.cost.bump('fileReReads', registered.repeats)
        record.cost.bump('fileReReadChars', registered.repeatChars)
        void persistCost(record)
      }
    } catch (error) {
      logger?.warn?.('memory-context-lab: 读取账本登记失败（归档不受影响）：' + (error?.message ?? String(error)))
    }
  }

  async function shutdown() {
    await Promise.allSettled([...activeOperations])
    for (const record of records.values()) {
      try { await disposeRecord(record) } catch { /* best-effort */ }
    }
    records.clear()
    factories.clear()
    // 兜底：disposeRecord 只覆盖仍在册的会话。任何已启动但会话已不在册的
    // 隔离灵枢子进程也要收掉，否则进程退出后留下孤儿 Python。
    try {
      await semanticBackendCloseAll?.()
    } catch (error) {
      logger?.warn?.(`v2 检索后端整体释放失败：${error?.message ?? error}`)
    }
  }

  return {
    autoCooling,
    captureNewFingerprints,
    indexNewRecords,
    accountBatch,
    invalidateLedgerForRestore,
    registerArchivedReads,
    shutdown,
  }
}

/**
 * 手动触发一次降温（`/memory-lab now` / `dry-run`）。
 *
 * 与 `autoCooling` 共用同一条执行路径：差别只是绕过自动触发线，不绕过任何门禁。
 */
export function createRunNow({
  records,
  engine,
  adopt,
  sessionIdOf,
  accountBatch,
  indexNewRecords,
}) {
async function runNow(invocation, { dryRun }) {
  const record = records.get(sessionIdOf(invocation.agent.session)) ?? await adopt(invocation.agent)
  if (!record) {
    return { kind: 'error', text: 'v2 引擎在本会话未启用。先 `/memory-lab on`。' }
  }
  // Y-05：`now` 是人给的「我再试一次」——必须先解除停摆，否则被 parked 过滤掉的
  // 区间永远不会重新进候选，而回执却提示用户「用 /memory-lab now」这条假出路。
  const unparked = dryRun ? 0 : unparkRanges(record)
  const outcome = await engine.runOnce(record, undefined, { dryRun })
  // 预演零副作用：不记账（它没提交任何东西）。
  if (!dryRun) {
    accountBatch(record, outcome)
    await indexNewRecords(record)
  }
  // 全失败不能报成功：runOnce 失败关闭时返回 kind:'error'，命令面必须跟随它，
  // 否则「一段都没归档」会被渲染成「已归档一批」。
  const head = unparked > 0 ? `已解除 ${unparked} 个停摆区间，重新进入候选。\n` : ''
  return {
    kind: outcome?.kind === 'error' ? 'error' : 'success',
    text: `${head}${outcome?.text ?? JSON.stringify(outcome)}`,
  }
}

  return { runNow }
}
