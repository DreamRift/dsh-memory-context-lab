import { appendCacheObservation, appendUsageLine, pruneCacheObservationLedger, readCacheProjectionState, readObservationPolicyInput, readUsageSummary } from '../adapters/storage/usage-log.mjs'
import { messageDigestOf, normalizeUsageObservation } from '../contracts/cache-observation.mjs'
import { EXPORT_IMPORT_LIMITS, readExportBundle, writeExportBundle } from '../adapters/storage/export-writer.mjs'
// 问题 8（0.15.4）：quarantine / exports 残留的统计与清理（A+D：给出口 + 如实报告）。
import { cleanResidue, formatBytes, scanResidue } from '../adapters/storage/storage-residue.mjs'
import { adoptConsentPath, readAdoptConsent, readAdoptConsentBySessionKey, writeAdoptConsent } from '../adapters/storage/adopt-consent.mjs'
import { buildExportBundle } from '../domain/export/bundle.mjs'
import { READBACK_CURSOR_VERSION, READBACK_MAX_CHARS, READBACK_OFFSET_UNIT } from '../contracts/readback.mjs'
import { READ_REFS_LIMITS } from '../contracts/citations.mjs'
import {
  READ_CURSOR_ERRORS,
  decodeReadCursor,
  encodeReadCursor,
  objectDigestOf,
  objectVersionDigestOf,
  sessionDigestOfRead,
} from '../domain/readback/read-cursor.mjs'
import { capCitations, citationOf, dedupeCitations, paginateCitations, splitCitationPage } from '../domain/readback/citations.mjs'
import { callIdOf } from '../domain/archive/event-shape.mjs'
import { textOfBlocks as sharedTextOfBlocks } from '../domain/text/blocks.mjs'
/**
 * v3 引擎入口（v3/entry，M5 第三批）——影子模式挂载。
 *
 * 与 v2 并行、互不干扰：只**摄入**事件（归一化→processTurn 落库），不做任何表面
 * 操作、不注册命令、不改设置——先让 v3 在真实宿主上积累数据与计量，M6 再开表面。
 *
 * 挂载形状（2026-10-24 对 src/index.mjs 核验）：

 * - 数据根 v3Root 必传（v3 不 import v2 的 storage 模块——根路径由主入口给，装配解耦）。
 * 事件源：每次 pre-step 拉取 session.events，按 seq 增量摄入（断点续传，不重复落库）。
 */




import { createV3Runtime } from '../composition/composition.mjs'
import { V3ContractViolation } from '../contracts/index.mjs'
import { TOOL_RESULT_ERROR_MARKER } from '../contracts/records.mjs'
import { PLUGIN_SOURCE_KIND, RECALL_SOURCE_FORM } from '../contracts/sources.mjs'
import { seqOfDshEventId } from '../adapters/host/dsh-host.mjs'
import { RECALL_RESULT_MIN_SCORE } from '../application/recall.mjs'
import { createRecallLeaseRegistry, normalizeReleaseReason } from '../domain/session/recall-counters.mjs'
import { createRecallConfirmations } from '../domain/session/recall-confirmation.mjs'
import { boundQuery, selectExcerpt } from '../domain/retrieval/excerpt.mjs'
import {
  SEARCH_CURSOR_ERRORS,
  SEARCH_PAGE_MAX_OFFSET,
  allocatePageSlots,
  decodeSearchCursor,
  encodeSearchCursor,
  orderIdOf,
  queryDigestOf,
  sessionDigestOf,
} from '../domain/retrieval/paging.mjs'
import { readSessionControl, updateSessionControl } from '../adapters/storage/session-control.mjs'
import { isChunkIndexCompatible, readChunkIndex } from '../adapters/storage/chunk-index.mjs'
import { ensureInitialSessionState, readSessionState, updateSessionState } from '../adapters/storage/session-state.mjs'
// R3-01：state/control 的 patch 合并移进 adapters 的锁内读改写原语（updateSession*），
// 入口不再自己「读旧快照 → 整对象写回」。
import { emptySessionControl } from '../domain/session/session-control.mjs'
import { emptySessionState, modeForMigratedSession, modeForNewSession } from '../domain/session/mode.mjs'
import { evaluatePressureGate } from '../domain/session/pressure-gate.mjs'
import { mergeReadLeaseRows } from '../domain/session/read-lease.mjs'
import { createArchiveService } from '../application/archive.mjs'
import { createFirstIngressCandidate } from '../application/first-ingress.mjs'
import { SCHEDULE_POLICY_VERSION } from '../contracts/archive-schedule-policy.mjs'
import { STEP_BATCH_MAX, normalizeStepBatch } from '../domain/archive/steps.mjs'
import { createSummaryService, recordHashMaterial } from '../application/summary.mjs'
import { candidateIdOf, createCompactService } from '../application/compact.mjs'
import { appendSummary, listSummaries, purgeSummariesForRecords, scrubRepairLogPreviews } from '../adapters/storage/summary-store.mjs'
import { appendProposalEvent, readProposals } from '../adapters/storage/compact-proposals.mjs'
import { ARCHIVE_POLICY_VERSION } from '../domain/archive/plan-fingerprints.mjs'
import { renderArchiveReceipt } from '../domain/archive/receipt.mjs'
import { summarizeRecords } from '../domain/compress/summary.mjs'
import { isSummaryId } from '../contracts/summaries.mjs'
import {
  MEMORY_CONTEXT_TOOL_LIST,
  OWN_TOOL_RESULT_MARKER,
  SEARCH_EXCERPT_CONTEXT_CHARS,
  SEARCH_EXCERPT_MAX_CHARS,
  SEARCH_EXCERPT_MAX_SPANS,
  SEARCH_EXCERPT_VERSION,
  SEARCH_OFFSET_UNIT,
} from '../contracts/tools.mjs'
import { readBackfillState, writeBackfillState } from '../adapters/storage/t2-backfill-state.mjs'
import { mirrorRootOf, scanMirrorableRecords, scanMirroredNodes } from '../adapters/storage/mirror-inventory.mjs'
import { parseBackfillLimit, planBackfill, runBackfill } from '../application/t2-backfill.mjs'
import { clearArchiveIntentIfMatches, peekArchiveIntent, readArchiveIntent, reserveArchiveIntent, writeArchiveIntent } from '../adapters/storage/archive-intent.mjs'
import { parseJsonishArguments, redactText, redactValue } from '../domain/security/redact.mjs'
import {
  captureFileReference,
  isStaleFileReference,
  readFileReferences,
  verifyFileReference,
  writeFileReferences,
} from '../adapters/storage/file-references.mjs'

const MEMORY_EVENT_TYPES = new Set(['user/message', 'assistant/message', 'tool/call', 'tool/result'])

/** 宿主 usage（dsh-llm：inputTokens/outputTokens/totalTokens/cacheReadTokens/reasoningTokens）。全字段缺省/非数字返回 null（不可观测不猜）。 */
function usageOf(u) {
  if (u === null || typeof u !== 'object') return null
  const out = {}
  for (const k of ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'reasoningTokens']) {
    if (typeof u[k] === 'number' && Number.isFinite(u[k]) && u[k] >= 0) out[k] = u[k]
  }
  return Object.keys(out).length >= 2 ? out : null
}

/**
 * usage 独立通道（P2 占用侧采集，2026-10-26）：sessions/<id>/usage.jsonl，append-only 聚合。
 * 不进记录、不进索引、不影响记录对账；写入失败只告警（采集是观测，不阻塞摄入）。
 */
async function appendUsage(entry, raw, usage) {
  try {
    await appendUsageLine(entry.runtime.store.directory, raw?.seq, usage)
  } catch {
    // 静默失败可接受：usage 是聚合观测，缺几行不产生错误事实
  }
}
async function usageSummary(entry) {
  return readUsageSummary(entry.runtime.store.directory)
}

/** content 候块数组取可见文本（type=text；reasoning/thinking/图片等非文本块不进正文）。 */
// T3：与 first-ingress 共用唯一实现；事件正文保留「逐块换行」的连接方式。
const textOfBlocks = (content) => sharedTextOfBlocks(content, { separator: '\n' })

/**
 * assistant 消息里的工具调用块（B-1 A，0.14.0-beta.48）。
 *
 * 真实宿主把工具调用放在 assistant/message 的 content 块（type='tool-call'），
 * 而 tool/call 事件本身不在活动面——旧实现只取 text 块，于是归档恢复只恢复了
 * 工具输出、没有恢复「当时调用了什么、参数是什么」（27/27 凭证、81 次调用、
 * 105,975 字参数不可恢复）。这里把调用块提取成 structure.toolCalls：
 * - **不改 text**：索引、净收益判据、sourceChars 全部不受影响；
 * - 参数与 tool/call 记录同一套脱敏口径（redactValue + parseJsonishArguments）；
 * - 同 callId 只留一条（重复块不放大恢复正文）。
 */
function toolCallsOfBlocks(content) {
  if (!Array.isArray(content)) return []
  const out = []
  const seen = new Set()
  for (const block of content) {
    if (block?.type !== 'tool-call') continue
    // AUD50-02-04（B2-2）：真实宿主的调用块是 {type,id,name,arguments}（dsh-agent-loop），
    // 没有 callId 字段——id 才是调用标识。callId 与 id 同时存在时优先 callId；空串按缺失。
    const callId = typeof block.callId === 'string' && block.callId.length > 0
      ? block.callId
      : (typeof block.id === 'string' && block.id.length > 0 ? block.id : '')
    if (callId.length > 0) {
      if (seen.has(callId)) continue
      seen.add(callId)
    }
    out.push({
      name: typeof block.name === 'string' ? block.name : '',
      callId,
      arguments: redactValue(parseJsonishArguments(block.arguments ?? block.args ?? {})),
    })
  }
  return out
}

/**
 * 从 DSH 事件提取正文与结构（2026-10-25 P1 修正：按宿主源码核验的真实形状）。
 * - user/message：data.content[].text / data.text（原有路径）；
 * - assistant/message：正文在 data.message.content（dsh-agent-loop createAssistantMessage）；
 * - tool/result：正文在 data.message.content（createToolResultMessage），错误态标注；
 * - tool/call：无正文，确定性结构文本（工具名/callId/脱敏参数）+ structure 字段；
 * - 提取不到正文 → metaOnly（记录原因；计数可对账；不进全文检索）。
 */
export function extractEventBody(raw) {
  const data = raw?.data ?? {}
  const type = raw?.type ?? ''
  if (type === 'assistant/message') {
    const content = data.message?.content ?? data.content
    const text = textOfBlocks(content) || (typeof data.text === 'string' ? data.text : '')
    const body = text ? { text } : { text: '', metaOnly: true, reason: 'assistant 无可见文本块' }
    // B-1 A：工具调用参数随记录结构落库（text 不变），restore 按 structure 渲染。
    const toolCalls = toolCallsOfBlocks(content)
    if (toolCalls.length > 0) {
      body.structure = { toolCalls }
      if (!text) body.reason = 'assistant 仅工具调用（无可见文本）'
    }
    const usage = usageOf(data.usage)
    if (usage) body.usage = usage
    return body
  }
  if (type === 'tool/result') {
    // 正文走脱敏：工具输出是**外部数据**（env、curl 头、配置文件内容），
    // 凭据泄漏最常见的落点就在正文里；只有 tool/call 参数过脱敏等于只挡了一半。
    const text = redactText(textOfBlocks(data.message?.content) || textOfBlocks(data.content))
    // 错误态的权威标志是 `message.isError === true`（dsh-session 校验：error 字段可缺省）。
    // 旧实现只看 `data.error !== undefined`，于是「非 HarnessError 的普通异常」
    // 产生 isError=true 且无 error 的结果时，失败被记成成功正文。
    const failed = data?.message?.isError === true || data?.error !== undefined
    if (failed && text) return { text: text + '\n' + TOOL_RESULT_ERROR_MARKER }
    if (failed) return { text: '[工具结果：错误态，无可读正文]', metaOnly: true, reason: 'tool/result 错误态且无可读正文' }
    return text ? { text } : { text: '', metaOnly: true, reason: 'tool/result 无可读正文' }
  }
  if (type === 'tool/call') {
    // 字符串形态（真实宿主）先解析再脱敏；对象形态（旧夹具/未来宿主）直接脱敏
    const structure = {
      name: typeof data.name === 'string' ? data.name : '',
      callId: typeof data.callId === 'string' ? data.callId : '',
      arguments: redactValue(parseJsonishArguments(data.arguments)),
    }
    let argsText = ''
    try {
      // 字符串形态（非法 JSON，解析不了）也要过一遍值脱敏（H-27）：
      // parseJsonishArguments 对非 JSON 原样返回，旧实现于是把整串明文写进记录。
      // AUD50-02-01：序列化文本（含 redactValue 之后的对象再序列化）统一再过一次
      // redactText，兜住「非敏感键的字符串值里内嵌 JSON 引号键」的形态。
      // AUD50-02-03（B2-1）：arguments 缺失时 JSON.stringify 返回 undefined（不是字符串），
      // 旧实现直接对它取 .length 当场抛错，整批摄入卡死。空参数按 '' 处理，记录仍可 metaOnly。
      argsText = redactText(
        typeof structure.arguments === 'string'
          ? structure.arguments
          : (structure.arguments === undefined ? '' : (JSON.stringify(structure.arguments) ?? '')),
      ) ?? ''
    } catch { argsText = '[不可序列化参数]' }
    if (typeof argsText !== 'string') argsText = '[不可序列化参数]'
    if (argsText.length > 400) argsText = [...argsText].slice(0, 400).join('') + '…'
    return { text: '工具调用 ' + structure.name + '(' + structure.callId + ')：' + argsText, structure }
  }
  const text = textOfBlocks(data.content) || (typeof data.text === 'string' ? data.text : '')
  return text ? { text } : { text: '', metaOnly: true, reason: type + ' 无可提取正文' }
}

/** 从 DSH 事件取正文（兼容旧签名：只返回文本）。 */
export function textOfDshEvent(raw) {
  return extractEventBody(raw).text
}

/**
 * 挂载 v3 引擎（影子模式）。
 * @param {object} ctx DSH 插件 ctx（含 on/logger）
 * @param {object} options { v3Root（必传）、runtimeFactory?（测试注入） }
 * @returns {{ dispose(): void, stats(): object }}
 */
export function attachV3Engine(ctx, options = {}) {
  if (ctx === null || typeof ctx !== 'object' || typeof ctx.on !== 'function') {
    throw new V3ContractViolation('v3 entry: 需要 DSH 插件 ctx（含 on）')
  }
  if (typeof options.v3Root !== 'string' || options.v3Root.length === 0) {
    throw new V3ContractViolation('v3 entry: v3Root 必传（由主入口解析数据根，v3 不依赖 v2 模块）')
  }
  const v3Root = options.v3Root
  // P3-04：判负游标的失效判据要能确定性复现（守卫会把时钟拨到 TTL 之后再看行为），
  // 因此时钟从 options 注入；默认 Date.now()，生产路径行为不变。
  const cursorClockNow = typeof options.clock?.now === 'function' ? () => options.clock.now() : () => Date.now()
  // 全局设置的同步读取器（由 index.mjs 注入）。没有注入时按产品默认 full-history。
  const settingsNow = typeof options.settingsNow === 'function' ? options.settingsNow : () => ({})
  const defaultModeNow = () => modeForNewSession(settingsNow().fullHistory !== false)
  // G4（0.15.0，默认关闭）：首次呈现外置候选的**装配可达性**接线。只构造句柄——零 I/O、
  // 零监听、不写任何路径；pre-step 钩子**不引用它**（真实入模时序与合作者的 wire 可见性
  // 留 G8，G3 判定 logical-request=not-wired / wire=no-seam）。开关独立且缺省关闭：
  // 设置里的 firstIngress.enabled，与 cooling / recall / fullHistory 无耦合。
  // 装配可达 ≠ 候选已生效：本条接线不派发任何一次外置。
  const firstIngressCandidate = createFirstIngressCandidate({ settingsNow })
  const runtimes = new Map()
  // 首次挂载的建库任务（H-19）：建 runtime + 断点反推是 O(记录数) 磁盘活
  // （open 读全部日志、resumeCheckpointOf 逐条读 provenance）。旧实现把它 await 在
  // pre-step 里，会话越长首个 pre-step 越慢（实测 5000 条 = 450ms），正是 beta.1
  // 「钩子阻塞首字」的形态。现在改为后台建库、钩子立即返回，下一步/建好后续传摄入。
  const pendingEntries = new Map() // sessionId → Promise<entry>
  const entryMetrics = new Map() // sessionId → { runtime, lastSeq }
  /** 显式 T2 回填任务：sessionId → { controller, state, promise }。空表 = 没有在跑的回填。 */
  const backfillJobs = new Map()
  /**
   * 建库失败存档（beta.11）：失败必须可判读，而不是伪装成「本会话尚未摄入」。
   * 旧实现把 ensureEntry 的拒绝吞成 null，`/memory-lab status` 于是对**确定性失败**
   * （目录不可写、manifest 损坏）也回「先发一条消息试试」——用户永远等不到库。
   */
  const entryFailures = new Map() // sessionId → { code, message, at, count }
  const failureWarnAt = new Map() // sessionId → 上次告警时刻（同会话 60s 一条）
  function noteEntryFailure(sessionId, error) {
    const previous = entryFailures.get(sessionId)
    entryFailures.set(sessionId, {
      code: error?.code ?? 'EINTERNAL',
      message: error instanceof Error ? error.message : String(error),
      at: Date.now(),
      count: (previous?.count ?? 0) + 1,
    })
    const now = Date.now()
    if (now - (failureWarnAt.get(sessionId) ?? 0) < 60000) return
    failureWarnAt.set(sessionId, now)
    ctx.logger?.warn?.('memory-context-lab-v3: 建库失败（' + (error?.code ?? 'EINTERNAL') + '）：'
      + (error instanceof Error ? error.message : String(error)) + '（同会话每分钟最多一条）')
  }

  // AUD50-04-01（B2-7）：runtime 淘汰（空闲 TTL + 存量上限）。
  // 22.57MB 索引 parse 后堆 +78MB，而 runtimes 只在引擎整体 dispose 清空——依次打开
  // 10 个大会话即数百 MB 常驻。淘汰 = 关 store + 清 provider 索引缓存 + 清定时器；
  // 数据都在盘上（断点从记录反推 H-01、索引可全量重建），下次打开照常恢复。
  // 可配置走 attachV3Engine options（不进设置页：这是资源治理，不是产品行为开关）。
  const runtimeLimits = {
    maxLiveSessions: Number.isInteger(options.maxLiveSessions) && options.maxLiveSessions >= 1 ? options.maxLiveSessions : 8,
    idleTtlMs: Number.isFinite(options.idleTtlMs) && options.idleTtlMs > 0 ? options.idleTtlMs : 10 * 60 * 1000,
  }
  // 上限淘汰的宽限期：刚被使用的 runtime（几秒内的活动步骤/命令）不淘汰——
  // 淘汰正在被引用的 runtime 会让在飞操作拿到 ESTORECLOSED（任务书风险条款）。
  const EVICT_GRACE_MS = 5000
  const evictedSessions = []

  function closeRuntime(key, reason) {
    const entry = runtimes.get(key)
    if (entry === undefined) return
    const timer = rebuildTimers.get(entry)
    if (timer !== undefined) {
      clearTimeout(timer)
      rebuildTimers.delete(entry)
    }
    // P8：close 可能是异步的（T2 flush + 关子进程）。异步拒绝不得变成未处理拒绝。
    try {
      const closing = entry.runtime.close?.()
      if (closing !== null && closing !== undefined && typeof closing.then === 'function') closing.catch(() => {})
    } catch { /* 关闭失败不改变淘汰事实 */ }
    runtimes.delete(key)
    evictedSessions.push({ sessionId: key, reason, at: Date.now() })
    if (evictedSessions.length > 50) evictedSessions.shift()
    ctx.logger?.info?.('memory-context-lab-v3: runtime 已淘汰（' + key + '，' + reason + '）；下次打开按需重建')
  }

  /** 淘汰扫描：空闲超 TTL 的先走；仍超上限时按最久未用补足（宽限期内与在飞不碰）。 */
  function evictIdleRuntimes(now = Date.now()) {
    if (disposed.value) return
    // T-12（0.15.4）：在飞**归档**同样是忙，必须被淘汰判据看见。
    //
    // 缺陷：`busy` 只看 `inflight`（摄入）/ 回填 / 待建，**不含 `archiveInflight`**。
    // 归档可能跑好几秒（真实会话首选段全量扫描 3 s+），这段时间里
    // 淘汰扫描完全可以判它「空闲」→ `close()` → 归档中途拿到 `ESTORE_CLOSED`。
    // 两个机制各自都对，只是互不相识。
    const busy = (key, entry) => entry.inflight !== null
      || entry.archiveInflight !== null
      || backfillJobs.has(key)
      || pendingEntries.has(key)
    const victims = new Set()
    for (const [key, entry] of runtimes) {
      if (busy(key, entry)) continue
      if (now - (entry.lastUsedAt ?? 0) >= runtimeLimits.idleTtlMs) victims.add(key)
    }
    let overflow = runtimes.size - victims.size - runtimeLimits.maxLiveSessions
    if (overflow > 0) {
      const candidates = [...runtimes.entries()]
        .filter(([key, entry]) => !victims.has(key) && !busy(key, entry)
          && now - (entry.lastUsedAt ?? 0) >= EVICT_GRACE_MS)
        .sort((a, b) => (a[1].lastUsedAt ?? 0) - (b[1].lastUsedAt ?? 0))
      for (const [key] of candidates) {
        if (overflow <= 0) break
        victims.add(key)
        overflow -= 1
      }
    }
    for (const key of victims) closeRuntime(key, '空闲淘汰/存量上限')
  }

  const evictTimer = setInterval(
    () => evictIdleRuntimes(),
    Math.min(60000, Math.max(1000, Math.floor(runtimeLimits.idleTtlMs / 4))),
  )
  evictTimer.unref?.()
  /**
   * 回注观测（beta.10）：每种结局都计数。
   * 「回注 0 次却没人发现」正是旧实现只 dispatch 一条 warn 的直接后果——
   * 失败必须能被 /memory-lab status 读到，而不是只留在日志里。
   */
  //
  // 按会话分桶：计数是「本会话的回注观测」，不是进程级合计——否则 A 会话的失败会
  // 出现在 B 会话的 /memory-lab status 里，归因完全错位。
  const injectionBySession = new Map()
  const emptyInjection = () => ({
    attempted: 0,
    injected: 0,
    skipped: 0,
    failed: 0,
    lastStatus: null,
    lastReason: null,
    lastError: null,
    lastInjectedAt: null,
    lastHits: null,
    // R02：候选数（装包阈内的命中总数）与**实际呈现**数分开，面板不再用一个数字冒充两个事实。
    lastCandidates: null,
    // R04：最近一次「没呈现」的具体原因（读取暂败 / 非 enter / 纯壳 / 本回合已呈现…）。
    lastNotPresented: null,
    // R04 确认面：handedOff = 已交给宿主（等证据）；unconfirmed = 窗口内无证据而放弃；
    // injected 只在宿主事件确认后 +1（不再在「交给宿主」时 +1）。
    handedOff: 0,
    unconfirmed: 0,
    lastHandoffAt: null,
    lastConfirmedAt: null,
    lastLease: null,
  })
  function countersOf(sessionId) {
    const key = String(sessionId ?? '')
    let counters = injectionBySession.get(key)
    if (counters === undefined) {
      counters = emptyInjection()
      injectionBySession.set(key, counters)
    }
    return counters
  }
  // R04：入口侧的租约与**确认登记**。
  // - 租约（进程内状态机 absent/pending/handed-off/confirmed）只防并发双占；
  // - 确认登记保存「已交给宿主、尚未看到宿主事件」的来源 ID（**不含正文**），
  //   由宿主 session/event 确认：命中才计入「已呈现」；未命中由 step/end、turn/end 收敛释放。
  const injectionLeases = createRecallLeaseRegistry()
  const confirmations = createRecallConfirmations()
  // 读租约写入按**会话**排队（宿主 session/event 监听器不被 await）。归档前必须等待
  // 本会话的写入落定；promise 保留到 settle 才移除——不能靠「截断数组」丢在飞写。
  const pendingLeaseWrites = new Map() // sessionKey → Set<Promise<void>>
  // 写失败的**持久事实**（按会话）：promise settle 后仍保留，直到针对同一批 recordIds
  // 有成功写入（明确恢复）才清除。否则「写失败 → settle 被删 → 下一次 flush 看不到」
  // 会把失败吞掉，归档在空租约上继续。
  const leaseWriteFailures = new Map() // sessionKey → { recordIds:Set<string>, error:string }
  // 生命周期观测（只读、有界）：flush/archive 的先后顺序可被测试与诊断读到。
  const lifecycleTrace = []
  const noteLifecycle = (name) => {
    lifecycleTrace.push(name)
    if (lifecycleTrace.length > 32) lifecycleTrace.shift()
  }
  let reservationOwner = 0 // 占位令牌计数（进程内单调；只用于区分并发的两次调用）

  /**
   * 等待**本会话**已排队的读租约写入落定。
   *
   * - promise 只在 settle 后从集合移除；不做「超长截断」——那会把仍在飞的写丢掉，
   *   并发 flush 便绕过它，归档看不到刚确认的租约。
   * - 任一写失败 → 返回 ok:false（调用方失败关闭：本步不归档），并把错误留在计数器里。
   * @returns {{ok:boolean, flushed:number, failed:number, error?:string}}
   */
  /** 记录一次持久失败（按会话 + 该次实际呈现的 recordIds）。 */
  function noteLeaseFailure(sessionKey, recordIds, error) {
    const key = String(sessionKey)
    const failure = leaseWriteFailures.get(key) ?? { recordIds: new Set(), error: null }
    for (const id of Array.isArray(recordIds) ? recordIds : []) {
      if (typeof id === 'string') failure.recordIds.add(id)
    }
    failure.error = error ?? 'EINTERNAL'
    leaseWriteFailures.set(key, failure)
  }

  /** 成功写入覆盖到的 recordIds 从失败集合移除；全部覆盖才清除（明确恢复）。 */
  function clearLeaseFailureCoverage(sessionKey, recordIds) {
    const key = String(sessionKey)
    const failure = leaseWriteFailures.get(key)
    if (failure === undefined) return
    for (const id of Array.isArray(recordIds) ? recordIds : []) failure.recordIds.delete(id)
    if (failure.recordIds.size === 0) leaseWriteFailures.delete(key)
  }

    async function flushInjectionConfirmation(sessionId) {
    const key = String(sessionId ?? '')
    const set = pendingLeaseWrites.get(key)
    let flushed = 0
    if (set !== undefined && set.size > 0) {
      const writes = [...set]
      flushed = writes.length
      await Promise.allSettled(writes) // 失败事实由 catch 写入 leaseWriteFailures，不靠这里数
    }
    // 失败是**持久阻断**：promise 已 settle 也不能当恢复；只有成功写入覆盖同一批
    // recordIds 才算恢复（见 observeSessionEvent 的成功分支）。
    const failure = leaseWriteFailures.get(key)
    if (failure !== undefined && failure.recordIds.size > 0) {
      return { ok: false, flushed, failed: failure.recordIds.size, error: failure.error }
    }
    return { ok: true, flushed, failed: 0 }
  }
  function injectionSnapshot(sessionId) {
    if (sessionId !== undefined && sessionId !== null) return { ...countersOf(sessionId) }
    const total = emptyInjection()
    for (const counters of injectionBySession.values()) {
      total.attempted += counters.attempted
      total.injected += counters.injected
      total.skipped += counters.skipped
      total.failed += counters.failed
      if (counters.lastInjectedAt !== null && (total.lastInjectedAt === null || counters.lastInjectedAt > total.lastInjectedAt)) {
        total.lastInjectedAt = counters.lastInjectedAt
        total.lastStatus = counters.lastStatus
        total.lastReason = counters.lastReason
        total.lastHits = counters.lastHits
        total.lastCandidates = counters.lastCandidates
        total.lastNotPresented = counters.lastNotPresented
      }
      if (counters.lastError !== null && (total.lastError === null || counters.lastError.at > total.lastError.at)) total.lastError = counters.lastError
    }
    return total
  }
  /**
   * 只读回注计数（不创建桶）。statusOf 会被会话投影对**每个已挂载会话**调用；
   * 旧写法走 countersOf 会顺手为每个会话建一个空桶，等于把读模型变成无界增长的内存表。
   */
  function injectionOf(sessionId) {
    const counters = injectionBySession.get(String(sessionId ?? ''))
    return counters === undefined ? emptyInjection() : { ...counters }
  }

  function diagnosticsOf(sessionId) {
    return runtimes.get(String(sessionId ?? ''))?.diagnostics ?? null
  }

  const makeRuntime = options.runtimeFactory ?? (async (dshSession, sessionId) => createV3Runtime({
    v3Root,
    dshSession,
    sessionKey: sessionId,
    memoryProbe: options.memoryProbe,
    t2ProviderFactory: options.t2ProviderFactory,
    t2Isolated: options.t2Isolated,
    // 诊断的运行时门（H7）：设置页关闭时，诊断函数本身抛 EDIAGNOSTICS_DISABLED，
    // 不再只靠「调用方记得先判断开关」。这里注入同步读取器，改设置后下一次取值即生效。
    diagnosticsEnabled: () => settingsNow().offlineDiagnostics === true,
  }))
  const disposed = { value: false }

  /**
   * 会话级控制（2026-10-27 用户口径）：插件设置页管全局默认，本对话只看这里。
   * 同步读（pre-step 每步调用）；文件损坏时按默认继续，但把 error 带进状态面。
   */
  function controlOf(sessionId) {
    const defaultEnabled = options.defaultEnabled !== false
    try {
      return readSessionControl(v3Root, String(sessionId ?? ''), { defaultEnabled })
    } catch (error) {
      return { ...emptySessionControl(), enabled: defaultEnabled, error: error?.code ?? 'ECONTROL_UNREADABLE' }
    }
  }

  /**
   * 写会话控制（命令面专用；原子写 + 校验失败关闭）。
   * @param {string} sessionId 会话 id
   * @param {object} patch { enabled?, recall?, overrides?: { limit: number|null } }
   */
  async function setControl(sessionId, patch) {
    // R3-01（2026-10-30）：锁内读改写原语——patch 在会话跨进程写锁内对磁盘最新值合并，
    // 不再用「读旧快照 → 整对象写回」（并发丢更新的根因）。非法 patch 失败关闭。
    return await updateSessionControl(v3Root, String(sessionId ?? ''), patch, { defaultEnabled: options.defaultEnabled !== false })
  }

  /**
   * 会话引擎状态（同步读；state.json 不存在时返回默认 mode）。
   * 注意：默认 mode 只是「还没建 state」时的占位；ensureEntry 会在建库时把旧会话迁移成
   * recall-only、新会话按 fullHistory 默认落盘，之后这里读到的就是快照。
   */
  function stateOf(sessionId) {
    return readSessionState(v3Root, String(sessionId ?? ''), { defaultMode: defaultModeNow() })
  }

  /** 写会话引擎状态（命令面/归档/恢复共用；patch 校验失败关闭）。 */
  async function setState(sessionId, patch) {
    // R3-01：锁内读改写——surface/pins/cooling/provider 等并发写不再互相覆盖；
    // state.json 损坏/不可读时不按空状态覆盖（原样返回带 error 的现值）。
    return await updateSessionState(v3Root, String(sessionId ?? ''), patch, { defaultMode: defaultModeNow() })
  }

  /**
   * 每步归档评估（M2）：只做一次有界 span，失败只告警、不阻塞用户回合。
   * recall-only / plan-first / cooling 未开闸 → no-op。
   */
  /**
   * 归档保护集。两种保护语义不同，**不得混用**（0.14.0-beta.45，AUD-09）：
   *
   * - **显式 pin**（`/memory-lab pin`）= 用户意图，永久硬边界，两种归档都挡；
   * - **读租约**（回注/显式 read 写的 TTL 租约）= 「刚读过，先别折叠」，只对
   *   **当前工作集**有意义。按轮归档只压已完成回合，当前回合本就被排除，
   *   把租约当整组硬边界会让上一轮被钉住最长 5 分钟——这正是 AUD-09 的
   *   「新一轮开头占用不降、过几分钟突然掉一大截」。
   *
   * 因此 `includeLease` 由调用方按模式给：按轮归档 `false`，按步归档 `true`
   * （步骤级会压当前回合内的旧步骤，刚读过的记录确实不能撤）。
   */
  function pinnedSeqsOf(entry, state, { includeLease = true } = {}) {
    const pinned = new Set()
    const now = Date.now()
    const protectedIds = new Set(Array.isArray(state?.pins) ? state.pins : [])
    if (includeLease) {
      for (const lease of state?.readLease ?? []) {
        if (typeof lease?.recordId === 'string' && Number.isFinite(lease?.expiresAt) && lease.expiresAt > now) protectedIds.add(lease.recordId)
      }
    }
    if (protectedIds.size === 0) return pinned
    for (const [seq, recordId] of entry.seqToRecordId) {
      if (protectedIds.has(recordId)) pinned.add(seq)
    }
    return pinned
  }

  /**
   * 读租约的锁内合并（R08）：**不**在锁外拼整数组再整份写回。
   *
   * 旧实现是「stateOf 读快照 → 合并本地数组 → setState 整数组」：两个并发读各自基于同一
   * 旧快照，后写把先写的整份覆盖（P0 红色基线 R08 实测并发两条租约只剩一条）。
   * 现在把「读—合并」搬进 updateSessionState 的 updater：锁内强制磁盘重读之后才计算。
   *
   * 合并规则（纯函数，见 mergeReadLeaseRows）：
   * - 只**延长**到期时间，绝不缩短并发方已写入的更晚到期时间；
   * - 只追加本次**实际呈现**的 recordId（R02：没进正文的候选不加租约）；
   * - 过期行在合并时清掉，条数仍有上界。
   *
   * @returns {Promise<{markReadLease:'ok'|'noop'|'unreadable'|'unsupported'}>}
   */
  async function markReadLease(sessionId, recordIds, ttlMs = 5 * 60 * 1000) {
    const ids = Array.isArray(recordIds) ? recordIds.filter((id) => typeof id === 'string' && id.length > 0) : []
    if (ids.length === 0) return { markReadLease: 'noop' }
    const key = String(sessionId ?? '')
    try {
      const written = await updateSessionState(v3Root, key, (snapshot) => {
        const now = Date.now()
        const merged = mergeReadLeaseRows(snapshot?.readLease, ids, { now, ttlMs })
        // 无变化 → undefined = 显式 no-op（不写盘、不推进 mtime）。
        if (merged.changed === false) return undefined
        return { readLease: merged.rows }
      }, { defaultMode: defaultModeNow() })
      // 状态文件损坏/不可读时适配器不写盘、原样返回带 error 的现值：**不能当成功**
      // （否则归档会把「没加上的租约」当成保护，失败被静默吞掉）。
      if (written?.error !== undefined) {
        metricsNote('v3.recall.lease-state-unreadable')
        return { markReadLease: 'unreadable', error: written.error }
      }
      return { markReadLease: 'ok' }
    } catch (error) {
      // 适配器还不支持 updater（R08 分支尚未集成）时不得静默退化成整数组覆盖：
      // 如实记 unsupported，观察面可查；宁可本步不加租约，也不制造并发丢更新。
      const unsupported = error instanceof TypeError || /不是对象|patch/i.test(String(error?.message ?? ''))
      metricsNote(unsupported ? 'v3.recall.lease-updater-unsupported' : 'v3.recall.lease-write-failed')
      ctx.logger?.warn?.('memory-context-lab-v3: 读租约写入失败（本步不延长租约）：' + (error?.message ?? String(error)))
      return { markReadLease: unsupported ? 'unsupported' : 'unreadable' }
    }
  }

  /**
   * 按步归档的选择参数——自动 pre-step、status 预览、now / compact 共用这一份，
   * 避免「预览说能压、执行却按另一套参数压」的漂移（与 beta.44 闸门同源的教训）。
   * retention（工作集）与 batch（批量阈值）严格分开：前者决定哪些不能压，后者决定攒够多少才压。
   *
   * 单次提交上限 = 批量阈值（1–200），不再有独立的 3 步硬上限：旧的 3 步上限会让 10 步阈值
   * 永远达不到（P3 审阅裁定）。选择器另用 scanLimit H=200 防御无界扫描；调用方显式传
   * maxSteps 时才进一步收紧单次提交。显式 now/compact 由调用点传 bypassBatch（§3.3：
   * 可绕普通节奏门，不绕安全/净收益）。
   */
  function stepSelectArgs(settings, minStartSeq = null) {
    return {
      retainSteps: Number.isInteger(settings.retainOperations) ? settings.retainOperations : 4,
      batchSteps: normalizeStepBatch(settings.coolingBatchSize),
      // P3 policy 合同 H=200：单次扫描窗口上限（选择器内另有同值钳制）。
      scanLimit: STEP_BATCH_MAX,
      // P3-04：判负游标（可能已失效 → 重新从 -1 评估）作为扫描起点；由调用方给出，
      // 不在这里读 entry（本函数是纯参数装配，预览与执行必须共用同一份参数）。
      ...(Number.isInteger(minStartSeq) ? { minStartSeq } : {}),
    }
  }

  /**
   * 冷却闸门事实（只读计算，不落盘）。archiveForStep 负责按需持久化；
   * dryRunArchive 用它保证 status 的「下一次归档」与真实执行同一判据。
   * 读不到占用 = 不可判定 → 失败关闭（不开闸）。
   */
  async function coolingGateOf(entry, state, settings) {
    let opened = state.cooling?.open === true
    let occupancy = null
    try {
      const info = await entry.runtime.host.sessionInfo()
      const usage = await usageSummary(entry)
      const latest = usage?.occupancy?.latest
      if (Number.isFinite(info?.contextWindow) && info.contextWindow > 0 && Number.isFinite(latest) && latest >= 0) {
        occupancy = latest / info.contextWindow
        // 闸门可配（/memory-lab set gate N，0–95，0 = 每步都判断）；非法值回落 20%。
        const gatePercent = Number.isFinite(settings.coolingGate) ? settings.coolingGate : 20
        const enterThreshold = Math.min(0.95, Math.max(0, gatePercent / 100))
        opened = evaluatePressureGate({ occupancy, enterThreshold, currentlyOpen: opened }).open
      }
    } catch { /* 读不到占用 = 不可判定 → 不开闸 */ }
    return { opened, occupancy, gate: Number.isFinite(settings.coolingGate) ? settings.coolingGate : 20 }
  }

  /**
   * 「净收益为负」的步骤 span 不是安全边界，不能把队头之后的归档全部堵死
   * （0.14.0-beta.46，真实会话 55cc43c5：seq 930–946 的记录正文仅 105 字、回执 186 字，
   * 被判 not-worth 后 119 步 / 50 个请求零归档）。判负的 span 记进进程内游标，
   * 下一次从它之后继续选；游标只跳过「不划算」的 span，pin / 未完成工具对 / 无记录
   * 仍由选择器照常 break。进程重建后游标归零，最多重扫一次判负队头。
   */
  const MAX_NOT_WORTH_SKIPS = 16

  /**
   * 连续跳过判负 span（单步最多扫 MAX_NOT_WORTH_SKIPS 段）；返回最终结果与最新游标。
   * 游标按模式分开存：按步 span 与回合 span 的判负结论互不蕴含，共用一个游标会让
   * 一次模式切换把「没评估过」的回合当成「判负过」跳过（静默不归档，安全但无效）。
   */
  async function skipNotWorthSpans(entry, run, cursorField = 'notWorthThroughSeq', { startCursor = null, fallback = null } = {}) {
    let cursor = Number.isInteger(startCursor)
      ? startCursor
      : (Number.isInteger(entry[cursorField]) ? entry[cursorField] : -1)
    let result = null
    let lastNotWorth = fallback
    let encountered = false
    // 判负段汇总（沿用 application 的 skipped 形状：startSeq/endSeq/recordIds/sourceChars/
    // receiptChars/reason）。跨轮累计并按 span 去重，供「窗口外全不划算」时如实报段数。
    const skippedRows = []
    const seenRows = new Set()
    const rememberSkipped = (candidate) => {
      const rows = Array.isArray(candidate?.skipped) && candidate.skipped.length > 0
        ? candidate.skipped
        : (Number.isInteger(candidate?.span?.endSeq)
          ? [{
            index: 0,
            startSeq: candidate.span.startSeq ?? null,
            endSeq: candidate.span.endSeq ?? null,
            recordIds: Array.isArray(candidate.recordIds) ? candidate.recordIds : [],
            sourceChars: Number.isInteger(candidate.sourceChars) ? candidate.sourceChars : null,
            receiptChars: Number.isInteger(candidate.receiptChars) ? candidate.receiptChars : null,
            reason: 'not-worth',
          }]
          : [])
      for (const row of rows) {
        const key = String(row?.startSeq ?? '?') + '-' + String(row?.endSeq ?? '?')
        if (seenRows.has(key)) continue
        seenRows.add(key)
        skippedRows.push(row)
      }
    }
    // fallback 是上一次判负事实（status 在游标已越过队头后重算时只拿到 retention-window，
    // 这里必须把已有汇总带上，否则 status 会把「已跳过 5 段」说成「0 段」）。
    if (lastNotWorth !== null) rememberSkipped(lastNotWorth)
    for (let round = 0; round < MAX_NOT_WORTH_SKIPS; round += 1) {
      result = await run(cursor)
      if (result?.status !== 'not-worth') break
      lastNotWorth = result
      encountered = true
      rememberSkipped(result)
      const endSeq = result.span?.endSeq
      if (!Number.isInteger(endSeq)) break
      cursor = endSeq
    }
    // AUD48-11-01：判负 span 之后已经没有任何可归档候选时，最后一次结果是
    // no-candidate / no-completed-group——旧实现把「不划算」掩成「只有当前回合」，
    // status 与第二次 now 都看不出真实原因。保留最近一次判负事实（带 span 与游标），
    // 仍然不冲掉真正的安全边界原因（pinned / missing-record / plugin-boundary 等）。
    if (lastNotWorth !== null && result?.status === 'not-worth') {
      // 已经返回判负本身，无需替换；保留 lastNotWorth 供调用方记账。
    } else if (lastNotWorth !== null && result?.status === 'no-candidate' && result.reason === 'no-completed-group') {
      result = { ...lastNotWorth, skippedToSeq: cursor, cached: encountered === false }
    } else if (lastNotWorth !== null && result?.status === 'no-candidate' && result.reason === 'retention-window' && skippedRows.length > 0) {
      // P5：游标已越过所有窗口外候选，选择器只剩「retention-window」这一句——但真实
      // 原因不是「还在保留窗口内」，而是「窗口外这些段全部不划算」。按 not-worth 回来，
      // 带跳过段数与最近一次的 span/字数事实；真正仍在窗口内的场景（从没跳过任何段）
      // 不会进入本分支，继续如实报 retention-window。
      result = {
        ...lastNotWorth,
        status: 'not-worth',
        reason: 'not-worth',
        windowReason: 'retention-window',
        skipped: skippedRows,
        skippedSegments: skippedRows.length,
        skippedToSeq: cursor,
        cached: false,
      }
    }
    return { result, cursor }
  }

  /** 记住最近一次判负事实（AUD48-11-01）：供 status/第二次 now 显示真实原因；归档成功后清。 */
  function rememberNotWorth(entry, field, result) {
    if (entry.lastNotWorth === undefined || entry.lastNotWorth === null) entry.lastNotWorth = {}
    if (result?.status === 'not-worth') entry.lastNotWorth[field] = result
    else if (result?.status === 'archived' || result?.status === 'partial') delete entry.lastNotWorth[field]
  }

  /**
   * P3-04（0.15.1 独立排查报告 §3.3）：判负（not-worth）游标**必须有失效条件**。
   *
   * 旧形状是「进程内单调只进不退」的整数（`entry.notWorthThroughSeq` 及其两个回合级兄弟）：
   * 一个段只要被判负过一次，此后**永远**排在扫描起点之前——即便判负的理由早已消失。
   * 判负不是永久属性，它随输入变化，且变化有两个方向：
   * - **回执侧**（设置）：`retainOperations` 被调小、批阈值被调小 → 同一段被切成更小的段，
   *   回执变短、源字数不变 → 净收益可以从负转正。这类输入**不在记录正文里**，
   *   任何「按记录算的指纹」都抓不到它；
   * - **源侧**（数据）：同一段记录被 restore/重摄/补内容 → 源正文变长 → 净收益转正。
   *   这类变化没有廉价判据（要么重新规划一次，要么读记录），只能靠时间兜底。
   *
   * 因此两条失效条件（任一成立即整条游标作废、回落 -1 从头评估）：
   * 1. **设置指纹**：判负时记下影响回执形状的选择参数（保留集合 / 批阈值 / 摘要开关）；
   *    与本轮不一致 → 口径变了 → 立刻重新评估（不需要等待，覆盖回执侧这个方向）；
   * 2. **TTL**：`NOT_WORTH_CURSOR_TTL_MS`（30 分钟）到期 → 重新评估（覆盖源侧方向）。
   *
   * 为什么不干脆每轮都从 -1 重扫：`MAX_NOT_WORTH_SKIPS` 段连续判负时，每轮都要重跑
   * 那么多次规划（最长 16 段），而 pre-step 每步都会走这条路径——这正是 beta.46 加游标
   * 要避免的成本。失效条件把「永久」压成「有界」，同时保住正常路径的零重扫。
   *
   * 不变量（失败关闭方向）：失效 = 回落到「没有游标」，即**重新评估**。最坏结果是
   * 把已经判过的段再判负一次（多花一次规划），绝不会跳过任何本来可归档的段。
   */
  const NOT_WORTH_CURSOR_TTL_MS = 30 * 60 * 1000

  /** 归一化一条游标记录：兼容旧形状（裸整数 = 无指纹、无时刻 → 按「永不过期」处理，行为不变）。 */
  function notWorthCursorOf(entry, field) {
    const raw = entry?.[field]
    if (Number.isInteger(raw)) return { cursor: raw, settingsKey: null, at: null, legacy: true }
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
    if (!Number.isInteger(raw.cursor)) return null
    return {
      cursor: raw.cursor,
      settingsKey: typeof raw.settingsKey === 'string' ? raw.settingsKey : null,
      at: Number.isFinite(raw.at) ? raw.at : null,
      legacy: false,
    }
  }

  /** 影响回执形状的选择参数指纹（只收真正改变分段/回执长度的输入；未给的按 null，不猜）。 */
  function notWorthSettingsKeyOf(selectArgs, summary) {
    const retain = Number.isInteger(selectArgs?.retainSteps) ? selectArgs.retainSteps : null
    const batch = Number.isInteger(selectArgs?.batchSteps) ? selectArgs.batchSteps : null
    const sum = summary === true
    return 'r' + String(retain) + ':b' + String(batch) + ':s' + (sum ? '1' : '0')
  }

  /** 游标当前是否还有效（设置指纹 + TTL 两条失效条件；legacy 裸整数保持不变）。 */
  function notWorthCursorLive(cursor, settingsKey, now) {
    if (cursor === null) return false
    if (cursor.legacy === true) return true
    if (typeof cursor.settingsKey === 'string' && typeof settingsKey === 'string' && cursor.settingsKey !== settingsKey) return false
    if (Number.isFinite(cursor.at) && Number.isFinite(now) && now - cursor.at >= NOT_WORTH_CURSOR_TTL_MS) return false
    return true
  }

  /**
   * 读该游标的当前有效起点（-1 = 从头评估）。
   * 失效时**就地清掉**并记一条 warn：观察面必须能看出「这里重新评估了」，不能静默。
   */
  function notWorthCursorStart(entry, field, settingsKey, now) {
    const cursor = notWorthCursorOf(entry, field)
    if (cursor === null) return -1
    if (notWorthCursorLive(cursor, settingsKey, now)) return cursor.cursor
    entry[field] = -1
    ctx.logger?.warn?.('memory-context-lab-v3: 判负游标失效（重新评估该会话的队头段）：' + field
      + '；判负时选择参数 ' + String(cursor.settingsKey) + '，当前 ' + String(settingsKey)
      + '；记于 ' + String(cursor.at) + '，当前 ' + String(now))
    return -1
  }

  /** 推进游标（判负事实 + 失效条件一起存在 entry 上；「只进不退」由调用方比较保证）。 */
  function advanceNotWorthCursor(entry, field, cursor, settingsKey, now) {
    if (!Number.isInteger(cursor) || cursor < 0) return
    entry[field] = { cursor, settingsKey: typeof settingsKey === 'string' ? settingsKey : null, at: now }
  }

  /**
   * 归档单飞（B-1，2026-10-31 审计）：同一进程内同一会话的归档同时只允许一个在跑，
   * 第二个立刻被拒（archive-busy，不排队——pre-step 每步自然重试，now 是显式动作，
   * 「拒绝 + 可重试文案」比静默排队诚实）。entry.inflight 只挡摄入，挡不住
   * /memory-lab now 与 pre-step 同时进入；两路并跑会在占槽层撞出一条
   * intent-pending 失败（无数据损坏，但用户看到一条 failed 噪音）。
   * 语义边界：单飞只覆盖**本进程**；跨进程并发仍由 commitPlanned 的锁内占槽
   * （intent-pending）兜底，单飞不越权替代占槽。dryRunArchive 不加单飞——
   * status 是只读，必须永远能答，加了会让「归档进行中」时 status 报忙，属倒退。
   */
  async function archiveForStep(sessionId, session, settings = {}, options = {}) {
    const entry = runtimes.get(String(sessionId ?? ''))
    if (entry === undefined || entry.inflight !== null) return { status: 'busy-or-not-ready' }
    if (entry.archiveInflight !== null) return { status: 'archive-busy' }
    // **顺序即正确性**（0.15.0 验收 A）：确认后的读租约写入必须先落定，再归档。
    // 旧顺序是先归档后 flush：本步刚确认的呈现还没进 readLease，归档于是把它们当
    // 「没有保护」的普通记录——既可能被压掉，也让租约语义撒谎。
    // 写入失败按失败关闭处理：本步不归档（宁可晚一步，不拿空租约当成功）。
    //
    // 顺序在**单飞闸之内**完成：闸必须先落下（并发第二路仍得到 archive-busy），
    // 否则两个并发调用会同时通过闸检查，第二个退化成占槽层的 failed 噪音。
    entry.archiveInflight = (async () => {
      noteLifecycle('flush')
      const flush = await flushInjectionConfirmation(sessionId)
      if (flush.ok === false) {
        ctx.logger?.warn?.('memory-context-lab-v3: 读租约写入失败（本步不归档，失败关闭）：' + String(flush.error ?? ''))
        return { status: 'lease-write-failed', failed: flush.failed }
      }
      noteLifecycle('archive')
      return await runArchiveForStep(sessionId, session, settings, options)
    })()
    // try/finally 必须包住：runArchiveForStep 抛错时清闸，否则本会话永久 busy。
    try { return await entry.archiveInflight } finally { entry.archiveInflight = null }
  }

  // —— 0.15.0 P4：工具/提案共享的候选身份与安全边界提交 ——
  // 关键纪律：候选**只能用现有 planner**（dryRunArchive 与 archiveForStep 同一选择器/保护
  // 判据）；本段不引入第二套候选选择或保护逻辑，只把「候选身份 + 漂移判据」物化。
  const PROPOSAL_COMMIT_LIMIT = 3
  const TOOL_SEARCH_MAX = 10
  // P7-20：回读上限的唯一真源在 contracts/readback.mjs，此处不得再写死数字。
  const TOOL_READ_MAX_CHARS = READBACK_MAX_CHARS

  function hashOf(entry) {
    return typeof entry?.runtime?.hash?.sha256 === 'function' ? entry.runtime.hash.sha256 : null
  }

  /**
   * 候选区间的 surface 指纹：只覆盖 [startSeq,endSeq] 内的活动面节点。
   * 尾部追加不改变这些节点 → 不失效（§3.3 第 7 条）；候选内改写/遮蔽 → 失效。
   */
  async function surfaceFingerprintOf(entry, surfaceNodes, startSeq, endSeq) {
    const hash = hashOf(entry)
    if (hash === null) return null
    const events = await entry.runtime.host.events()
    const bySeq = new Map(events.map((event) => [event.seq, event]))
    const rows = []
    for (const seq of surfaceNodes) {
      if (seq < startSeq || seq > endSeq) continue
      const event = bySeq.get(seq)
      const text = await entry.runtime.host.surfaceTextAt(seq)
      rows.push({ seq, type: event?.type ?? 'unknown', text: hash(String(text ?? '')) })
    }
    return hash(JSON.stringify(rows))
  }

  /** 相关保护指纹：只算落在候选区间内的 pin/读租约（无关 pin 变化不失效候选）。 */
  function protectionFingerprintOf(entry, state, startSeq, endSeq) {
    const hash = hashOf(entry)
    if (hash === null) return null
    const seqs = [...pinnedSeqsOf(entry, state, { includeLease: true })]
      .filter((seq) => Number.isInteger(seq) && seq >= startSeq && seq <= endSeq)
      .sort((a, b) => a - b)
    return hash('protection:' + JSON.stringify(seqs))
  }

  /** 遗忘代际指纹：forget/undo 都改变它，旧提案据此失效（不拿旧计划压已忘内容）。 */
  function forgetFingerprintOf(entry) {
    const hash = hashOf(entry)
    if (hash === null) return null
    const ids = (typeof entry.runtime.store.listForgotten === 'function' ? entry.runtime.store.listForgotten() : [])
      .filter((id) => typeof id === 'string').sort()
    return hash('forget:' + JSON.stringify(ids))
  }

  /** 来源记录不可变字节 hash（读失败一律 null：失败关闭，不拿缺项充当身份）。 */
  async function sourceHashesOf(entry, recordIds) {
    const hash = hashOf(entry)
    if (hash === null) return null
    const rows = []
    for (const id of recordIds) {
      let record
      try { record = await entry.runtime.store.readRecord(id) } catch { return null }
      if (record === null || record.id !== id) return null
      rows.push({ recordId: id, hash: hash(recordHashMaterial(record)) })
    }
    return rows
  }

  /** 由统一 planner 的计划构造候选身份（不含正文；receipt 文本不参与身份）。 */
  async function candidateIdentityOf(entry, state, surfaceNodes, planned) {
    const sourceHashes = await sourceHashesOf(entry, planned.recordIds)
    if (sourceHashes === null) return null
    const surfaceFingerprint = await surfaceFingerprintOf(entry, surfaceNodes, planned.startSeq, planned.endSeq)
    const protectionFingerprint = protectionFingerprintOf(entry, state, planned.startSeq, planned.endSeq)
    const forgetFingerprint = forgetFingerprintOf(entry)
    if (typeof surfaceFingerprint !== 'string' || typeof protectionFingerprint !== 'string' || typeof forgetFingerprint !== 'string') return null
    return {
      policyVersion: ARCHIVE_POLICY_VERSION,
      startSeq: planned.startSeq,
      endSeq: planned.endSeq,
      sourceEventSeqs: [...planned.sourceEventSeqs],
      recordIds: [...planned.recordIds],
      sourceHashes,
      surfaceFingerprint,
      protectionFingerprint,
      forgetFingerprint,
      operations: Number.isInteger(planned.operations) ? planned.operations : 0,
      unitLabel: typeof planned.unitLabel === 'string' ? planned.unitLabel : '操作数',
      restoreChars: Number.isInteger(planned.restoreChars) ? planned.restoreChars : null,
    }
  }

  /** 提交边界重算同一候选的身份（同一区间/同一 recordIds，只重算事实）。 */
  async function currentIdentityOf(entry, state, surfaceNodes, identity) {
    const sourceHashes = await sourceHashesOf(entry, identity.recordIds)
    if (sourceHashes === null) return null
    const surfaceFingerprint = await surfaceFingerprintOf(entry, surfaceNodes, identity.startSeq, identity.endSeq)
    const protectionFingerprint = protectionFingerprintOf(entry, state, identity.startSeq, identity.endSeq)
    const forgetFingerprint = forgetFingerprintOf(entry)
    if (typeof surfaceFingerprint !== 'string' || typeof protectionFingerprint !== 'string' || typeof forgetFingerprint !== 'string') return null
    return {
      policyVersion: ARCHIVE_POLICY_VERSION,
      startSeq: identity.startSeq,
      endSeq: identity.endSeq,
      sourceEventSeqs: Array.isArray(identity.sourceEventSeqs) ? [...identity.sourceEventSeqs] : [],
      recordIds: [...identity.recordIds],
      sourceHashes,
      surfaceFingerprint,
      protectionFingerprint,
      forgetFingerprint,
    }
  }

  /**
   * 回执渲染 + 净收益判断（P2-3 唯一实现）。
   *
   * inspect / prepare / 边界提交必须共用这一份：同一 summaryText、同一 sourceChars、
   * 同一比较口径（UTF-16 length，与 sourceChars 同单位）。只差调用点会把「带摘要的
   * 回执」在预览阶段算少、到提交才判负，于是工具说可执行、边界却标 stale。
   * @returns {{receiptText:string,receiptChars:number,sourceChars:number,executable:boolean,reasons:string[]}}
   */
  function receiptAssessmentOf({ startSeq, endSeq, recordIds, operations = 0, unitLabel = '操作数', summaryText = '', sourceChars }) {
    const source = Number.isFinite(sourceChars) ? sourceChars : 0
    const receiptText = renderArchiveReceipt({
      startSeq,
      endSeq,
      recordIds,
      operations,
      unitLabel,
      summary: typeof summaryText === 'string' ? summaryText : '',
      // P5：与 makePlan 同一自适应预算——摘要不能把提案回执推过原文，
      // 否则普通归档能省略摘要、提案路径却永远 not-worth（两条路径口径必须同源）。
      sourceChars: Number.isFinite(sourceChars) ? sourceChars : null,
    })
    const receiptChars = receiptText.length
    const executable = receiptChars < source
    return { receiptText, receiptChars, sourceChars: source, executable, reasons: executable ? [] : ['net-gain-negative'] }
  }

  /** 读候选来源正文并算 sourceChars（inspect/prepare/提交同口径；失败关闭）。 */
  async function receiptRecordsOf(entry, recordIds) {
    const loaded = []
    for (const id of recordIds) {
      try {
        const record = await entry.runtime.store.readRecord(id)
        if (record === null || record.id !== id) return { ok: false, reason: 'source-unreadable' }
        loaded.push(record)
      } catch (error) {
        return { ok: false, reason: error?.code === 'EFORGOTTEN' ? 'source-forgotten' : 'source-unreadable' }
      }
    }
    const sourceChars = loaded.reduce((sum, row) => sum + (typeof row.payload?.text === 'string' ? row.payload.text.length : 0), 0)
    return { ok: true, loaded, sourceChars }
  }

  function inspectUnavailable(stage, reason) {
    return { status: 'disabled', stage, executable: false, candidate_id: null, reasons: [], committed: false, accepted: false, error: reason }
  }

  /** inspect：只读；候选与真实提交同源（dryRunArchive = 现有 planner 的只读路径）。 */
  async function inspectCandidate(entry, sessionId, session) {
    if (entry === undefined || entry === null) return null
    if (entry.compact === null || entry.summaries === null) return inspectUnavailable('inspect', 'engine-unavailable')
    if (entry.inflight !== null) return { ...inspectUnavailable('inspect', 'ingesting'), status: 'busy' }
    const state = stateOf(String(sessionId))
    // P2-3：预览与提交同口径——预览也带摘要渲染回执（无草稿时用确定性提取摘要，
    // 与提交边界的回落摘要同一函数）。否则 inspect 少算摘要预算、边界才判 not-worth。
    const planned = await dryRunArchive(String(sessionId), session, settingsNow(), { compact: true })
    const base = {
      status: planned.status === 'planned' ? 'ok' : planned.status,
      stage: 'inspect',
      executable: planned.status === 'planned',
      candidate_id: null,
      reasons: typeof planned.reason === 'string'
        ? [planned.reason]
        : (planned.status === 'not-worth' ? ['net-gain-negative'] : []),
      receipt_chars: Number.isInteger(planned.receiptChars) ? planned.receiptChars : null,
      source_chars: Number.isInteger(planned.sourceChars) ? planned.sourceChars : null,
      committed: false,
      accepted: false,
    }
    if (planned.status !== 'planned') return base
    const assessment = receiptAssessmentOf({
      startSeq: planned.startSeq,
      endSeq: planned.endSeq,
      recordIds: planned.recordIds,
      operations: planned.operations,
      unitLabel: planned.unitLabel,
      summaryText: planned.summaryText ?? '',
      sourceChars: planned.sourceChars,
    })
    if (!assessment.executable) {
      return { ...base, status: 'not-worth', executable: false, reasons: assessment.reasons, receipt_chars: assessment.receiptChars, source_chars: assessment.sourceChars }
    }
    const identity = await candidateIdentityOf(entry, state, await entry.runtime.host.surfaceNodes(), planned)
    if (identity === null) return { ...base, status: 'failed', executable: false, reasons: ['source-unreadable'] }
    return {
      ...base,
      candidate_id: candidateIdOf(identity, entry.runtime.hash),
      identity,
      receipt_chars: assessment.receiptChars,
      source_chars: assessment.sourceChars,
    }
  }

  async function inspectCompact(sessionId, session) {
    const entry = runtimes.get(String(sessionId ?? ''))
    if (entry === undefined) return inspectUnavailable('inspect', 'not-ready')
    const inspected = await inspectCandidate(entry, sessionId, session)
    if (inspected === null) return inspectUnavailable('inspect', 'not-ready')
    return inspected
  }

  /** prepare：固定候选 + 物化摘要（不改活动面、不占 intent 槽）。 */
  async function prepareCompact(sessionId, session, args = {}) {
    const entry = runtimes.get(String(sessionId ?? ''))
    if (entry === undefined) return inspectUnavailable('prepare', 'not-ready')
    const inspected = await inspectCandidate(entry, sessionId, session)
    if (inspected === null) return inspectUnavailable('prepare', 'not-ready')
    if (inspected.status !== 'ok' || inspected.identity === undefined) {
      return { ...inspected, stage: 'prepare', executable: false }
    }
    if (typeof args?.candidate_id === 'string' && args.candidate_id.length > 0 && args.candidate_id !== inspected.candidate_id) {
      return { ...inspected, stage: 'prepare', status: 'drift', executable: false, reasons: ['candidate-changed'] }
    }
    const prepared = await entry.compact.prepare({
      entry,
      sessionKey: entry.runtime.sessionKey,
      candidate: inspected.identity,
      draft: args?.summary ?? null,
      idempotencyKey: typeof args?.idempotency_key === 'string' ? args.idempotency_key : null,
    })
    if (prepared.ok !== true) {
      return { ...inspected, stage: 'prepare', status: prepared.status ?? 'rejected', executable: false, reasons: [prepared.reason ?? 'prepare-failed'], error: prepared.reason }
    }
    // P2-3：prepare 必须用**实际物化的摘要**（可能是更长的模型草稿）重算回执与净收益。
    // inspect 的确定性摘要只是保守预览；草稿把回执推过原文时，prepare 阶段就报不可执行，
    // 不等边界提交才标 stale。
    const facts = await receiptRecordsOf(entry, inspected.identity.recordIds)
    if (facts.ok !== true) {
      return { ...inspected, stage: 'prepare', status: 'failed', executable: false, reasons: [facts.reason], receipt_chars: null, source_chars: null, error: facts.reason }
    }
    let summaryText = summarizeRecords(facts.loaded)
    try {
      const read = await entry.summaries.read({ entry, summaryId: prepared.summaryId })
      if (read.ok === true && read.visibility.visible === true) summaryText = read.artifact.shortText
    } catch { /* 摘要不可读 → 与提交边界同一回落：确定性摘要 */ }
    const assessment = receiptAssessmentOf({
      startSeq: inspected.identity.startSeq,
      endSeq: inspected.identity.endSeq,
      recordIds: inspected.identity.recordIds,
      operations: inspected.identity.operations,
      unitLabel: inspected.identity.unitLabel,
      summaryText,
      sourceChars: facts.sourceChars,
    })
    if (!assessment.executable) {
      await entry.compact.markStale({ entry, proposalId: prepared.proposalId, reason: 'not-worth', reasons: ['net-gain-negative'] })
        .catch((error) => ctx.logger?.warn?.('memory-context-lab-v3: 提案失效标记失败（提交边界仍会重验证）：' + (error?.message ?? String(error))))
      return {
        stage: 'prepare',
        status: 'not-worth',
        executable: false,
        candidate_id: inspected.candidate_id,
        proposal_id: prepared.proposalId,
        summary_id: prepared.summaryId,
        summary_hash: prepared.summaryHash,
        expires_at: prepared.expiresAt,
        receipt_chars: assessment.receiptChars,
        source_chars: assessment.sourceChars,
        reasons: assessment.reasons,
        committed: false,
        accepted: false,
        error: 'net-gain-negative',
      }
    }
    return {
      stage: 'prepare',
      status: 'prepared',
      executable: true,
      candidate_id: inspected.candidate_id,
      proposal_id: prepared.proposalId,
      summary_id: prepared.summaryId,
      summary_hash: prepared.summaryHash,
      expires_at: prepared.expiresAt,
      receipt_chars: assessment.receiptChars,
      source_chars: assessment.sourceChars,
      reasons: [],
      committed: false,
      accepted: false,
    }
  }

  /** submit：只落 accepted（待执行），不改活动面；committed 只能由真实凭证确认。 */
  async function submitCompact(sessionId, session, args = {}) {
    const entry = runtimes.get(String(sessionId ?? ''))
    if (entry === undefined) return inspectUnavailable('submit', 'not-ready')
    if (entry.compact === null) return inspectUnavailable('submit', 'engine-unavailable')
    const state = stateOf(String(sessionId))
    const surfaceNodes = await entry.runtime.host.surfaceNodes()
    const revalidate = async (candidate) => {
      const current = await currentIdentityOf(entry, state, surfaceNodes, candidate)
      if (current === null) return { ok: false, reasons: ['source-unreadable'] }
      return entry.compact.verifySnapshot(candidate, current)
    }
    let submitted
    if (typeof args?.proposal_id === 'string' && args.proposal_id.length > 0) {
      submitted = await entry.compact.submit({ entry, sessionKey: entry.runtime.sessionKey, proposalId: args.proposal_id, revalidate })
    } else {
      // P2-3：直接带候选 submit 也必须先走 prepare（同一回执/净收益判断），
      // 否则会绕过「摘要导致负收益时不可执行」而直接 accepted。
      const prepared = await prepareCompact(sessionId, session, args)
      if (prepared === null) return inspectUnavailable('submit', 'not-ready')
      if (prepared.executable !== true) return { ...prepared, stage: 'submit', executable: false }
      submitted = await entry.compact.submit({
        entry,
        sessionKey: entry.runtime.sessionKey,
        proposalId: prepared.proposal_id,
        revalidate,
      })
    }
    if (submitted?.ok !== true) {
      return { stage: 'submit', status: submitted?.status ?? 'rejected', reasons: [submitted?.reason ?? 'submit-failed'], executable: false, committed: false, accepted: false, error: submitted?.reason }
    }
    return {
      stage: 'submit',
      status: submitted.status,
      candidate_id: submitted.candidateId ?? null,
      proposal_id: submitted.proposalId ?? null,
      executable: submitted.status !== 'stale',
      committed: submitted.committed === true,
      accepted: submitted.status === 'accepted',
      receipt_seq: Number.isInteger(submitted.receiptSeq) ? submitted.receiptSeq : null,
      summary_id: submitted.summaryId ?? null,
      expires_at: Number.isFinite(submitted.expiresAt) ? submitted.expiresAt : null,
      reasons: Array.isArray(submitted.reasons) ? submitted.reasons : [],
    }
  }

  async function compactStatus(sessionId, proposalId) {
    const entry = runtimes.get(String(sessionId ?? ''))
    if (entry === undefined) return inspectUnavailable('status', 'not-ready')
    if (entry.compact === null) return inspectUnavailable('status', 'engine-unavailable')
    if (typeof proposalId !== 'string' || proposalId.length === 0) return { ...inspectUnavailable('status', 'proposal_id-required'), status: 'rejected', reasons: ['proposal-id-required'] }
    const result = await entry.compact.status({ entry, proposalId })
    if (result.ok !== true) return { ...inspectUnavailable('status', result.reason), status: 'not-found' }
    return {
      stage: 'status',
      status: result.status,
      candidate_id: result.candidateId,
      proposal_id: result.proposalId,
      summary_id: result.summaryId,
      committed: result.committed === true,
      accepted: result.status === 'accepted',
      receipt_seq: result.receiptSeq,
      expires_at: result.expiresAt,
      reasons: result.reasons ?? [],
      executable: result.status === 'accepted' || result.status === 'committed',
    }
  }

  /**
   * 下一安全边界：先尝试提交 pending 提案（逐项重验证 → 既有 intent/voucher 事务）。
   * 任一提案不可执行/漂移 → 标记 stale，绝不改面；之后由普通自动归档接管。
   */
  async function commitPendingProposals(entry, sessionId, state, surfaceNodes) {
    if (entry === null || entry === undefined || entry.compact === null) return null
    let pending
    try {
      pending = await entry.compact.pending({ entry })
    } catch (error) {
      ctx.logger?.warn?.('memory-context-lab-v3: 提案台账不可读（本轮跳过提案，不影响普通归档）：' + (error?.message ?? String(error)))
      return null
    }
    for (const proposal of pending.slice(0, PROPOSAL_COMMIT_LIMIT)) {
      // 台账只校验事件类型/ID；候选身份是外部可写数据，缺字段时失败关闭（标 stale，不改面）。
      if (proposal.candidate === null || typeof proposal.candidate !== 'object'
        || !Array.isArray(proposal.candidate.recordIds) || proposal.candidate.recordIds.length === 0
        || !Number.isInteger(proposal.candidate.startSeq) || !Number.isInteger(proposal.candidate.endSeq)) {
        await entry.compact.markStale({ entry, proposalId: proposal.proposalId, reason: 'candidate-invalid', reasons: ['candidate-invalid'] })
          .catch((error) => ctx.logger?.warn?.('memory-context-lab-v3: 提案失效标记失败（提交边界仍会重验证）：' + (error?.message ?? String(error))))
        continue
      }
      const current = await currentIdentityOf(entry, state, surfaceNodes, proposal.candidate ?? {})
      const verdict = current === null
        ? { ok: false, reasons: ['source-unreadable'] }
        : entry.compact.verifySnapshot(proposal.candidate, current)
      if (verdict.ok !== true) {
        await entry.compact.markStale({ entry, proposalId: proposal.proposalId, reason: 'drift', reasons: verdict.reasons })
          .catch((error) => ctx.logger?.warn?.('memory-context-lab-v3: 提案失效标记失败（提交边界仍会重验证）：' + (error?.message ?? String(error))))
        continue
      }
      let summaryArtifact = null
      if (typeof proposal.summaryId === 'string') {
        try {
          const read = await entry.summaries.read({ entry, summaryId: proposal.summaryId })
          if (read.ok === true && read.visibility.visible === true && entry.summaries.fingerprintOf(read.artifact) === proposal.summaryHash) {
            summaryArtifact = read.artifact
          }
        } catch { summaryArtifact = null }
      }
      const facts = await receiptRecordsOf(entry, proposal.candidate.recordIds)
      if (facts.ok !== true) {
        await entry.compact.markStale({ entry, proposalId: proposal.proposalId, reason: facts.reason, reasons: [facts.reason] })
          .catch((error) => ctx.logger?.warn?.('memory-context-lab-v3: 提案失效标记失败（提交边界仍会重验证）：' + (error?.message ?? String(error))))
        continue
      }
      // 摘要失败不阻塞归档：artifact 不可读时回落确定性摘要（仍不带未经校验的模型文本）。
      const summaryText = summaryArtifact === null ? summarizeRecords(facts.loaded) : summaryArtifact.shortText
      // P2-3：与 inspect/prepare 同一回执渲染与净收益函数（同一 summaryText/sourceChars 口径）。
      const assessment = receiptAssessmentOf({
        startSeq: proposal.candidate.startSeq,
        endSeq: proposal.candidate.endSeq,
        recordIds: proposal.candidate.recordIds,
        operations: proposal.display?.operations ?? 0,
        unitLabel: proposal.display?.unitLabel ?? '操作数',
        summaryText,
        sourceChars: facts.sourceChars,
      })
      if (!assessment.executable) {
        await entry.compact.markStale({ entry, proposalId: proposal.proposalId, reason: 'not-worth', reasons: assessment.reasons })
          .catch((error) => ctx.logger?.warn?.('memory-context-lab-v3: 提案失效标记失败（提交边界仍会重验证）：' + (error?.message ?? String(error))))
        continue
      }
      const summaryRef = summaryArtifact === null
        ? null
        : {
          summaryId: summaryArtifact.summaryId,
          hash: proposal.summaryHash,
          sourceSetFingerprint: summaryArtifact.sourceSetFingerprint,
        }
      const committed = await entry.archive.commitPrepared({
        sessionId,
        plan: {
          startSeq: proposal.candidate.startSeq,
          endSeq: proposal.candidate.endSeq,
          sourceEventSeqs: proposal.candidate.sourceEventSeqs,
          recordIds: proposal.candidate.recordIds,
          receiptText: assessment.receiptText,
          summaryText,
          restoreChars: Number.isInteger(proposal.display?.restoreChars) ? proposal.display.restoreChars : facts.sourceChars,
          sourceChars: facts.sourceChars,
        },
        txn: 1,
        mode: state.mode === 'cooling' ? 'cooling' : 'full-history',
        summaryRef,
        proposalId: proposal.proposalId,
      })
      if (committed.status === 'archived') {
        try {
          await entry.compact.markCommitted({
            entry,
            proposalId: proposal.proposalId,
            result: { candidateId: proposal.candidateId, summaryId: summaryRef?.summaryId ?? null, voucherId: committed.voucherId, receiptSeq: committed.receiptSeq },
          })
        } catch { /* 状态台账追加失败不影响已落账凭证：status 会显示 accepted，由对账/下次预步补记 */ }
        try { entry.vouchers = entry.runtime.store.listVouchers().length } catch { /* 保持旧值 */ }
        try {
          await setState(sessionId, state.mode === 'cooling'
            ? { surface: { lastArchiveAt: Date.now() } }
            : { surface: { lastArchiveEndSeq: committed.endSeq, lastArchiveAt: Date.now() } })
        } catch (error) {
          ctx.logger?.warn?.('memory-context-lab-v3: 提案归档后 state 写入失败（voucher 已落盘）：' + (error?.message ?? String(error)))
        }
        return { ...committed, viaProposal: true, proposalId: proposal.proposalId }
      }
      // intent 失败（未对账槽位/不可读）要阻断本轮提交；surface/voucher 失败保留 accepted，
      // 由下一次对账补凭证（intent 内含 proposalId，补账后同样记 committed）。
      if (committed.status === 'failed' && committed.phase === 'intent') return committed
      return { ...committed, proposalId: proposal.proposalId }
    }
    return null
  }

  /**
   * G5 接线（G7 集成批）：把「配置 + 策略状态 + 只读 policy 输入」装成 application 层要的形状。
   *
   * - 候选**关闭/缺配置**时返回 {config, state, input:null}：application 的
   *   schedulePolicyRuntimeOf 会把「配置合法且未启用」判成 null，于是结果面不出现 policy 键，
   *   off 路径与 0.15.0 逐字节等价；此分支**不读账本**（默认配置下 pre-step 热路径零额外 I/O）。
   * - 配置**非法**时原样下发（如 enabled: 999），由 normalizeSchedulePolicyConfig 判失败关闭，
   *   并把 configError 带到结果面——P3-5：不得在这里静默回落成「没启用」。
   * - 输入读失败/没有观测 → input=null：策略自动回退原策略并写明原因，绝不阻塞归档。
   */
  async function schedulePolicyInputOf(entry, sessionId, settings) {
    const config = settings?.schedulePolicyConfig
    if (config === null || config === undefined) return null
    // **请求序号必须每次请求刷新**（P3-6 的接线补全）：策略状态的 attemptOrdinal 是「当前
    // 请求序号」，不是「上次提交的序号」——若只在提交后写回，冷启动后 state 一直是 null，
    // evaluateSchedulePolicy 会永远走 policy-ordinal-unavailable（候选形同未接线）。
    // lastCommit 只有存在时才带上：它的存在性由 application 产出（提交成功才写）。
    const state = {
      contractVersion: SCHEDULE_POLICY_VERSION,
      attemptOrdinal: Number.isSafeInteger(entry.requestOrdinal) ? entry.requestOrdinal : null,
      ...(entry.policyState?.lastCommit === undefined || entry.policyState?.lastCommit === null
        ? {}
        : { lastCommit: entry.policyState.lastCommit }),
    }
    if (config.enabled !== true) return { config, state, input: null }
    let input = null
    try {
      const read = await readObservationPolicyInput(entry.runtime.store.directory, { sessionKey: String(sessionId ?? '') })
      if (read?.ok === true && read.input !== undefined) input = read.input
    } catch (error) {
      ctx.logger?.warn?.('memory-context-lab-v3: 调度策略输入不可读（自动回退原策略）：' + (error?.code ?? error?.message ?? String(error)))
    }
    return { config, state, input }
  }

  async function runArchiveForStep(sessionId, session, settings = {}, options = {}) {
    const entry = runtimes.get(String(sessionId ?? ''))
    if (entry === undefined || entry.inflight !== null) return { status: 'busy-or-not-ready' }
    if (entry.archive === null) return { status: 'host-no-surface' }
    // C-F：每个 pre-step 先尝试对账旧 intent（失败保留 intent，只告警不阻塞）。
    // 对账本身抛错（如宿主面读取失败）不等于「槽位被占」——真正的硬闸在
    // commitPlanned 的锁内占槽（reserve），这里只是快速路径。
    let reconciliation
    try {
      reconciliation = await recoverArchiveIntent(entry, sessionId)
    } catch (error) {
      ctx.logger?.warn?.('memory-context-lab-v3: 归档意图对账失败（保留 intent）：' + (error?.message ?? String(error)))
      reconciliation = { recovered: false }
    }
    // R2-01（2026-10-30）：槽位仍被未对账意图占着（补凭证失败/清理冲突）或意图
    // 不可读 → 暂停本会话新的归档提交，不选 span、不碰宿主面；正常对话与只读
    // 能力不受影响。对账已在上一步重试补账/清理，能收敛的不会走到这里。
    if (reconciliation?.keptIntent === true) {
      return {
        status: 'failed',
        phase: 'intent',
        reason: reconciliation.unreadable === true ? 'intent-unreadable' : 'intent-pending',
      }
    }
    let state = stateOf(sessionId)
    if (state.mode === 'recall-only' || state.planFirst === true) return { status: 'paused' }
    // §3.3：显式 now/compact 保持及时——绕普通节奏门（cooling 占用闸门 + 攒批阈值），
    // 但仍必须过保护闭包、完整性与正净收益；安全边界绝不因手动而放宽。
    const manual = options?.resetNotWorth === true || options?.compact === true
    if (state.mode === 'cooling') {
      // 压力闸门：occupancy = 最近 input+cacheRead / contextWindow；未知一律失败关闭。
      const gate = await coolingGateOf(entry, state, settings)
      const { opened, occupancy } = gate
      if (state.cooling?.open !== opened || state.cooling?.lastOccupancy !== occupancy) {
        state = await setState(sessionId, { cooling: { open: opened, lastOccupancy: occupancy, lastRunAt: Date.now(), lastReason: opened ? 'gate-open' : 'gate-closed' } })
      }
      if (!opened && manual !== true) return { status: 'cooling-closed', occupancy, gate: gate.gate }
    }
    const host = entry.runtime.host
    if (typeof host.surfaceNodes !== 'function') return { status: 'host-no-surface' }
    const surfaceNodes = await host.surfaceNodes()
    const events = Array.isArray(session?.log) ? session.log : (typeof session?.events === 'function' ? session.events() : null)
    if (!Array.isArray(events) || surfaceNodes.length === 0) return { status: 'no-surface' }
    // P4：安全边界优先提交 pending 提案（逐项重验证；漂移只标 stale，不改面）。
    // 提案执行与普通自动归档共用同一 intent/voucher 事务与同一保护判据。
    const proposalCommit = await commitPendingProposals(entry, sessionId, state, surfaceNodes)
    if (proposalCommit !== null) return proposalCommit
    // 轮次判定（0.14.0-beta.47）：默认按真人消息（历史行为），可切到 DSH 自己的轮次计数。
    // 只影响按轮归档的「什么算一轮」；按步归档与回执/恢复语义完全不变。
    const turnBasis = settings.turnBasis === 'dsh' ? 'dsh' : 'human'
    const turnCursorField = turnBasis === 'dsh' ? 'notWorthThroughSeqTurnDsh' : 'notWorthThroughSeqTurn'
    // 两种模式的分工（beta.40）：
    // - full-history：回合级，只压已完成回合（当前回合永不归档）——长程多轮；
    // - cooling：步骤级，在当前回合内实时压掉不再需要的旧步骤——长步数少轮，
    //   retainOperations 在这里当「工作集保留的步骤数」（模型刚用过的结果不能撤）。
    // G5 接线（G7）：真到「要归档」这一步才装策略输入——前面的 busy/paused/冷却未开闸/
    // 提案提交/pending intent 早退都不读账本（关闭时也不读，见 schedulePolicyInputOf）。
    const schedulePolicy = await schedulePolicyInputOf(entry, sessionId, settings)
    let result
    if (state.mode === 'cooling') {
      const stepArgs = {
        sessionId,
        events,
        surfaceNodes,
        seqToRecordId: entry.seqToRecordId,
        ...stepSelectArgs(settings),
        // G5：策略闸门只存在于按步批量路径（回合级选择器与 maxOperations=1 本轮未接）。
        policy: schedulePolicy,
        // P3：自动/预览/手动共用同一个 planner，lane 只决定是否绕普通节奏门。
        lane: manual ? 'manual' : 'auto',
        // §3.3：显式 now/compact 保持及时，可绕普通节奏门（攒批阈值）；安全边界与
        // 净收益判据不变——选择器照旧逐条切断 pin/未完成工具对/插件/无记录。
        bypassBatch: manual,
        // 按步归档在**当前回合内**压缩：刚读过的记录必须留在工作集里（租约生效）。
        pinnedSeqs: pinnedSeqsOf(entry, state, { includeLease: true }),
        summary: true,
        txn: 1,
      }
      const notWorthField = 'notWorthThroughSeq'
      const priorNotWorth = entry.lastNotWorth?.[notWorthField] ?? null
      // P3-04：起点不再无条件沿用整数游标——**选择参数指纹变了或 TTL 到期就作废重评**
      // （判负不是永久属性；见 notWorthCursorStart 的失效条件）。
      const coolingKey = notWorthSettingsKeyOf(stepArgs, stepArgs.summary)
      const coolingStart = options?.resetNotWorth === true
        ? -1
        : notWorthCursorStart(entry, notWorthField, coolingKey, cursorClockNow())
      const skipped = await skipNotWorthSpans(
        entry,
        (minStartSeq) => entry.archive.archiveStepBatch({ ...stepArgs, minStartSeq }),
        notWorthField,
        { startCursor: coolingStart, fallback: priorNotWorth },
      )
      result = skipped.result
      // 同批里「判负段被跳过、后面的段提交成功」时结果不是 not-worth：游标必须
      // 由结果里的 notWorthThroughSeq 推进，否则下一轮会从同一段队头重读。
      let coolingNext = skipped.cursor
      if (Number.isInteger(result?.notWorthThroughSeq) && result.notWorthThroughSeq > coolingNext) {
        coolingNext = result.notWorthThroughSeq
      }
      if (coolingNext > coolingStart) advanceNotWorthCursor(entry, notWorthField, coolingNext, coolingKey, cursorClockNow())
      rememberNotWorth(entry, notWorthField, result)
    } else {
      // 回合级判负同样是**非安全边界**：不回执、不遮蔽、留在活动面，但也不能把队头
      // 之后的已完成回合永久堵死（与按步 beta.46 同一判据，游标分开存）。
      const planFloor = Number.isInteger(state.planFloorSeq) ? state.planFloorSeq : -1
      const turnArgs = {
        sessionId,
        events,
        surfaceNodes,
        seqToRecordId: entry.seqToRecordId,
        mode: state.mode,
        retainOperations: Number.isInteger(settings.retainOperations) ? settings.retainOperations : 5,
        lastArchiveEndSeq: Number.isInteger(state.surface?.lastArchiveEndSeq) ? state.surface.lastArchiveEndSeq : -1,
        maxOperations: 1,
        // 按轮归档只压已完成回合（当前回合已排除）：读租约不再钉住上一轮（AUD-09）。
        pinnedSeqs: pinnedSeqsOf(entry, state, { includeLease: false }),
        // 轮次判定与当前轮：DSH 轮次下，目标自动继续开的新轮就是「当前轮」，
        // 上一轮因此成为已完成——这正是「14 轮只压 2 轮」的修复点。
        turnBasis,
        currentTurn: Number.isInteger(options?.turn) ? options.turn : null,
        summary: true,
        txn: 1,
      }
      const priorNotWorth = entry.lastNotWorth?.[turnCursorField] ?? null
      // P3-04：与按步分支同一条失效判据（参数指纹 + TTL）。回合级的「选择参数」是
      // 保留回合数与摘要开关——它们同样决定回执长度。
      const turnKey = notWorthSettingsKeyOf({ retainSteps: turnArgs.retainOperations, batchSteps: 1 }, turnArgs.summary)
      const turnStart = options?.resetNotWorth === true
        ? -1
        : notWorthCursorStart(entry, turnCursorField, turnKey, cursorClockNow())
      const skipped = await skipNotWorthSpans(
        entry,
        (cursor) => entry.archive.archiveOnce({ ...turnArgs, minStartSeq: Math.max(planFloor, cursor) }),
        turnCursorField,
        { startCursor: turnStart, fallback: priorNotWorth },
      )
      result = skipped.result
      if (skipped.cursor > turnStart) advanceNotWorthCursor(entry, turnCursorField, skipped.cursor, turnKey, cursorClockNow())
      rememberNotWorth(entry, turnCursorField, result)
    }
    // P3：archived 与 partial 都代表「已落面并记了 voucher」，状态必须推进；
    // partial 额外把失败段与未提交段如实告警，不能把部分成功说成整批成功。
    if (result.status === 'archived' || result.status === 'partial') {
      if (result.status === 'partial') {
        ctx.logger?.warn?.('memory-context-lab-v3: 按步批量归档部分完成（已提交 ' + (result.committedCount ?? 0) + ' 段，'
          + '失败：' + String(result.failed?.phase ?? 'unknown') + '/' + String(result.failed?.reason ?? 'unknown') + '）')
      }
      // 面板「已归档 N 段」：每段成功归档各追加一张凭证，这里刷新一次缓存计数
      // （投影每事件都读 statusOf，那里绝不能碰 vouchers.jsonl）。
      try { entry.vouchers = entry.runtime.store.listVouchers().length } catch { /* 保持旧值：面板显示上一轮已知数，不伪造 0 */ }
      // 两种模式都记 lastArchiveAt（供状态行与切模式确认）；lastArchiveEndSeq 只给
      // 回合级选择器用，按步归档绝不能写它——否则会成为 full-history 的永久下限。
      const surface = state.mode === 'cooling'
        ? { lastArchiveAt: Date.now() }
        : { lastArchiveEndSeq: result.endSeq, lastArchiveAt: Date.now() }
      try {
        await setState(sessionId, { surface })
      } catch (error) {
        ctx.logger?.warn?.('memory-context-lab-v3: 归档后 state 写入失败（voucher 已落盘）：' + (error?.message ?? String(error)))
      }
      // G5 接线（G7，P3-6b）：**partial 也要写回**——只要有一段真的提交成功，基线就必须推进
      // （漏写会让节奏门偏松：方向安全但无效）。只有 application 给了 nextState 才写
      // （候选关闭/配置非法时永远没有 nextState，因此 off 路径零状态）。
      if (result?.policy?.nextState !== undefined && result.policy.nextState !== null) {
        entry.policyState = result.policy.nextState
      }
    }
    return result
  }

  async function dryRunArchive(sessionId, session, settings = {}, options = {}) {
    const entry = runtimes.get(String(sessionId ?? ''))
    if (entry === undefined) return { status: 'not-ready' }
    if (entry.archive === null) return { status: 'host-no-surface' }
    const state = stateOf(sessionId)
    if (state.mode === 'recall-only' || state.planFirst === true) return { status: 'paused' }
    // B-2（2026-10-31 审计）：预览与真实提交同一道闸。槽位压着未对账意图（或内容
    // 不是合法意图）时，真实提交会被锁内占槽挡下（intent-pending），预览先照实说，
    // 不再自相矛盾地显示「下一次归档：seq X–Y（可归档）」。peek 只读、无副作用；
    // 顺序理由：paused 是用户显式关闭（意图更强）先显示，占槽次之。
    const peek = await peekArchiveIntent(v3Root, String(sessionId))
    if (peek.state === 'pending' || peek.state === 'invalid') return { status: 'intent-pending' }
    if (peek.state === 'unreadable') return { status: 'intent-unreadable' }
    const host = entry.runtime.host
    if (typeof host.surfaceNodes !== 'function') return { status: 'host-no-surface' }
    const surfaceNodes = await host.surfaceNodes()
    const events = Array.isArray(session?.log) ? session.log : (typeof session?.events === 'function' ? session.events() : null)
    if (!Array.isArray(events)) return { status: 'no-surface' }
    // G5 接线（G7）：预览与执行用**同一份**策略输入与状态，否则 status 的「下一次归档」
    // 会显示一个真实执行时会被节奏门挡下的候选（预览 lane 不绕门）。
    const schedulePolicyDryRun = await schedulePolicyInputOf(entry, sessionId, settings)
    if (state.mode === 'cooling') {
      // 预览必须与真正会执行的选择器**和闸门**一致，否则 status 会骗人。
      const gate = await coolingGateOf(entry, state, settings)
      // F-C：预览结果带上同一时刻的闸门事实，status 的「按步归档闸门」行与
      // 「下一次归档」行因此同源（不再一行读 state.cooling、一行现场重算）。
      if (!gate.opened) return { status: 'cooling-closed', occupancy: gate.occupancy, gate: gate.gate, opened: false }
      const stepArgs = {
        sessionId,
        events,
        surfaceNodes,
        seqToRecordId: entry.seqToRecordId,
        ...stepSelectArgs(settings),
        // 自动预览与自动归档同一道攒批阈值与同一个 planner（§3.3：普通提交受增长/
        // 节奏门）；显式 now/compact 才绕过阈值，预览不冒充手动动作（lane=preview）。
        lane: 'preview',
        // G5：预览走同一条策略闸门（defer 会以 policy-deferred 显示，而不是伪称有候选）。
        policy: schedulePolicyDryRun,
        pinnedSeqs: pinnedSeqsOf(entry, state, { includeLease: true }),
        // 0.15.0：预览与执行同口径，且普通归档默认带确定性摘要（用户要求回执可读）；
        // compact 仍可覆盖摘要来源，但默认值一致。
        summary: true,
      }
      // 预览与执行同一游标：判负的队头 span 不参与「下一次归档」，否则 status 会显示一个永远执行不了的候选。
      // P3-04：预览同样走失效判据（只读判断，失效时**不改 entry**——status 是只读动作；
      // 真正的清理由执行路径完成，两边的起点判据同源）。
      const priorNotWorth = entry.lastNotWorth?.['notWorthThroughSeq'] ?? null
      const coolingPreviewKey = notWorthSettingsKeyOf(stepArgs, stepArgs.summary)
      const coolingPreviewCursor = notWorthCursorOf(entry, 'notWorthThroughSeq')
      const coolingPreviewStart = notWorthCursorLive(coolingPreviewCursor, coolingPreviewKey, cursorClockNow())
        ? coolingPreviewCursor.cursor
        : -1
      const { result: planned } = await skipNotWorthSpans(
        entry,
        (minStartSeq) => entry.archive.planSteps({ ...stepArgs, minStartSeq }),
        'notWorthThroughSeq',
        { startCursor: coolingPreviewStart, fallback: priorNotWorth },
      )
      // 预期与真实执行同一份判据：no-candidate 的 reason 由选择器给出，原样透出。
      return { status: planned.status ?? 'planned', ...planned, gate: gate.gate, occupancy: gate.occupancy, opened: gate.opened }
    }
    // 预览与执行同一游标（只读、不推进）：否则 status 会报一个永远压不了的判负回合。
    // 轮次判定与游标也必须同源：切到 DSH 轮次后，按真人消息判负过的 span 不能拿来跳过。
    const turnBasis = settings.turnBasis === 'dsh' ? 'dsh' : 'human'
    const turnCursorField = turnBasis === 'dsh' ? 'notWorthThroughSeqTurnDsh' : 'notWorthThroughSeqTurn'
    const planFloor = Number.isInteger(state.planFloorSeq) ? state.planFloorSeq : -1
    const turnArgs = {
      sessionId,
      events,
      surfaceNodes,
      seqToRecordId: entry.seqToRecordId,
      mode: state.mode,
      retainOperations: Number.isInteger(settings.retainOperations) ? settings.retainOperations : 5,
      lastArchiveEndSeq: Number.isInteger(state.surface?.lastArchiveEndSeq) ? state.surface.lastArchiveEndSeq : -1,
      maxOperations: 1,
      // 与 archiveForStep 的按轮分支同口径（AUD-09）：租约只保护工作集，不挡已完成回合。
      pinnedSeqs: pinnedSeqsOf(entry, state, { includeLease: false }),
      turnBasis,
      currentTurn: Number.isInteger(options?.turn) ? options.turn : null,
      // 0.15.0：与按步分支同口径，普通归档默认带摘要。
      summary: true,
    }
    const priorNotWorth = entry.lastNotWorth?.[turnCursorField] ?? null
    // P3-04：与执行路径同一条失效判据（只读；不改 entry）。
    const turnPreviewKey = notWorthSettingsKeyOf({ retainSteps: turnArgs.retainOperations, batchSteps: 1 }, turnArgs.summary)
    const turnPreviewCursor = notWorthCursorOf(entry, turnCursorField)
    const turnPreviewStart = notWorthCursorLive(turnPreviewCursor, turnPreviewKey, cursorClockNow())
      ? turnPreviewCursor.cursor
      : -1
    const { result: planned } = await skipNotWorthSpans(
      entry,
      (cursor) => entry.archive.dryRun({ ...turnArgs, minStartSeq: Math.max(planFloor, cursor) }),
      turnCursorField,
      { startCursor: turnPreviewStart, fallback: priorNotWorth },
    )
    return { status: planned.status ?? 'planned', ...planned }
  }

  /** 历史凭证（只读；供 /memory-lab history 与面板）。 */
  async function historyOf(sessionId) {
    const entry = runtimes.get(String(sessionId ?? ''))
    if (entry === undefined) return { total: 0, rows: [], busy: pendingEntries.has(String(sessionId ?? '')) }
    if (entry.archive === null) return { total: 0, rows: [], error: { code: 'EHOST_NO_SURFACE' } }
    return await entry.archive.history()
  }

  /** 恢复一个/全部凭证（M2）。 */
  async function restoreHistory(sessionId, { index = null } = {}) {
    const entry = runtimes.get(String(sessionId ?? ''))
    if (entry === undefined) return { error: 'not-ready' }
    if (entry.archive === null) return { error: 'host-no-surface' }
    if (index === null) return await entry.archive.restoreAll()
    return await entry.archive.restoreVoucher(index)
  }

  /**
   * 日志尾部半行修复（G-A，0.14.0-beta.48）：dryRun 只报告，不写任何字节。
   * apply 成功后关闭旧句柄并丢弃入口缓存——下一次 pre-step 会重新建库/重开，
   * 让 writable 与内存视图都回到修复后的真实状态（不伪造「已可写」）。
   */
  async function repairStore(sessionId, { dryRun = false, rebuildPurged = false } = {}) {
    const key = String(sessionId ?? '')
    const entry = runtimes.get(key)
    if (entry === undefined) return { error: 'not-ready' }
    const store = entry.runtime.store
    // T-10（0.15.4）：purged 中段损坏的显式出口。它**不改**通用 repair 的判据
    // （那条红线是「只动尾部、绝不丢行」），而是另一条明确的人工裁决路径。
    if (rebuildPurged === true) {
      if (typeof store.rebuildPurged !== 'function') return { error: 'store-no-rebuild' }
      const report = await store.rebuildPurged({ dryRun })
      if (dryRun !== true && report?.changed === true) {
        try { entry.runtime.close?.() } catch { /* 关闭失败不改变修复事实 */ }
        runtimes.delete(key)
        entryFailures.delete(key)
      }
      return report
    }
    if (typeof store.repairJournals !== 'function') return { error: 'store-no-repair' }
    const report = await store.repairJournals({ dryRun })
    if (dryRun !== true && report?.changed === true) {
      try { entry.runtime.close?.() } catch { /* 关闭失败不改变修复事实 */ }
      runtimes.delete(key)
      entryFailures.delete(key)
    }
    return report
  }

  /**
   * 显式 pin：这些记录所在的 surface 节点作为归档硬边界（pin 记录本身不归档）。
   *
   * R08：**校验仍在锁外**（读记录、判断是不是本会话），但**合并必须锁内**。
   * 旧实现把 `new Set(stateOf(...).pins)` 在锁外算好再整份写回：两个并发 pin 各自基于
   * 同一旧快照时，后写覆盖先写，后者加的那条永久丢失（P0 红色基线 R08 实测）。
   * 现在锁内 updater 拿磁盘最新行，只增删本次请求涉及的 ID——并发方新增的 pin 不受影响。
   */
  async function pinRecords(sessionId, recordIds, { remove = false } = {}) {
    if (!Array.isArray(recordIds) || recordIds.length === 0) throw new V3ContractViolation('v3 entry: pin 需要非空 recordIds')
    const entry = runtimes.get(String(sessionId ?? ''))
    if (entry === undefined) return { error: 'not-ready' }
    const wanted = []
    for (const id of recordIds) {
      if (remove) { wanted.push(id); continue }
      const record = await entry.runtime.store.readRecord(id) // 不存在/已遗忘 → 失败关闭
      if (record?.id !== id) throw new V3ContractViolation('v3 entry: pin 目标不是本会话记录')
      wanted.push(id)
    }
    const requested = [...new Set(wanted)]
    // removed / added 都以**锁内**的实际变化数计（锁外快照算出来的数字在并发下会撒谎）。
    let removed = 0
    let added = 0
    const next = await updateSessionState(v3Root, String(sessionId ?? ''), (snapshot) => {
      const pins = new Set(Array.isArray(snapshot?.pins) ? snapshot.pins : [])
      removed = 0
      added = 0
      let changed = false
      for (const id of requested) {
        if (remove) {
          if (pins.delete(id)) { removed += 1; changed = true }
          continue
        }
        // P2-15：`added` 只数**真正新增**的（已 pin 的再 pin 不算），与 unpin 的 removed 对称。
        if (!pins.has(id)) { pins.add(id); added += 1; changed = true }
      }
      return changed ? { pins: [...pins] } : undefined
    }, { defaultMode: defaultModeNow() })
    if (next?.error !== undefined) {
      // 状态文件损坏/不可读：不得当成「pin 成功」。失败关闭并如实回报。
      return { error: next.error, pins: Array.isArray(next.pins) ? next.pins : [], removed: 0, added: 0, unchanged: recordIds.length }
    }
    // B3-16 / P2-15：removed = 实际删除数（unpin 口径）；added = 实际新增数（pin 口径），
    // unchanged = 请求里既没新增也没删除的条数。两条路径同一把尺：**回报实际发生的变化**。
    return { pins: next.pins, removed, added, unchanged: recordIds.length - removed - added }
  }

  /** 遗忘预览：只读检查与已遗忘状态，不写账本。 */
  async function forgetPreview(sessionId, recordIds) {
    const entry = runtimes.get(String(sessionId ?? ''))
    if (entry === undefined) return { error: 'not-ready' }
    const forgotten = new Set(typeof entry.runtime.store.listForgotten === 'function' ? entry.runtime.store.listForgotten() : [])
    const rows = []
    for (const id of recordIds) {
      let status = 'committed'
      try { await entry.runtime.store.readRecord(id) } catch (error) {
        status = error?.code === 'EFORGOTTEN' ? 'forgotten' : (error?.code ?? 'unreadable')
      }
      if (forgotten.has(id)) status = 'forgotten'
      rows.push({ id, status })
    }
    return { rows }
  }

  /**
   * 遗忘 / 物理清除 / 撤销遗忘：走端口批量预检 + 索引重建。
   *
   * 语义（H4，2026-11-04 审计后显式化）：
   * - `{undo:true}`：撤销逻辑遗忘（purge 过的 ID 明确拒绝，不可能恢复正文）；
   * - 默认：逻辑遗忘——读面/检索/回执/导出都看不到，冷库正文保留；
   * - `{purge:true}`：物理清除——删除正文文件与派生物，不可撤销。
   */
  async function forgetRecords(sessionId, recordIds, { undo = false, purge = false } = {}) {
    const entry = runtimes.get(String(sessionId ?? ''))
    if (entry === undefined) return { error: 'not-ready' }
    if (undo) {
      if (typeof entry.runtime.store.revokeForget !== 'function') return { error: 'store-no-undo' }
      const purged = new Set(typeof entry.runtime.store.listPurged === 'function' ? entry.runtime.store.listPurged() : [])
      const blocked = recordIds.filter((id) => purged.has(id))
      if (blocked.length > 0) return { error: 'purged', ids: blocked }
      const result = await entry.runtime.store.revokeForget(recordIds)
      await refreshSearchable(entry)
      // 恢复本地记录后重建镜像：遗忘时镜像已被删，不重建会让 T2 检索永久少这些记录。
      if (typeof entry.runtime.provider?.mirrorRecord === 'function') {
        for (const id of recordIds) {
          try {
            const record = await entry.runtime.store.readRecord(id)
            if (record !== null) entry.runtime.provider.mirrorRecord(record, { undo: true })
          } catch (error) {
            ctx.logger?.warn?.('memory-context-lab-v3: 撤销遗忘后镜像失败（本地已恢复）：' + (error?.message ?? String(error)))
          }
        }
      }
      const vouchers = entry.runtime.store.listVouchers()
      const unredact = { attempted: 0, changed: 0, failed: [] }
      for (let index = 0; index < vouchers.length; index += 1) {
        if (!(vouchers[index].recordIds ?? []).some((id) => recordIds.includes(id))) continue
        unredact.attempted += 1
        const row = await entry.archive.unredactVoucher(index).catch((error) => ({ changed: false, reason: 'internal-failure', error }))
        if (row.changed === true) unredact.changed += 1
        else if (row.reason !== 'voucher-not-found') {
          unredact.failed.push({ index, reason: row.reason ?? 'unknown' })
          ctx.logger?.warn?.('memory-context-lab-v3: 撤销遗忘后回执还原失败（#' + index + '：' + (row.reason ?? 'unknown') + '）')
        }
      }
      return { ...result, undone: true, unredact }
    }
    if (purge && typeof entry.runtime.store.purge !== 'function') return { error: 'store-no-purge' }
    // P2-07（根因·顺序）：物理清除**先删正文、后清回执**，中间任一步失败就会在
    // vouchers.jsonl 里留下 ≤400 字原文首部——而正文已经删了，用户以为「全清了」。
    // 修法把顺序倒过来：purge 之前先把受影响回执清干净；清不掉就**中止 purge**
    // （正文还在，可以先 undo/修复再重试），绝不带着残留首部完成物理清除。
    let preRedact = null
    if (purge) {
      const pendingVouchers = entry.runtime.store.listVouchers()
      const blocking = []
      let changed = 0
      for (let index = 0; index < pendingVouchers.length; index += 1) {
        if (!(pendingVouchers[index].recordIds ?? []).some((id) => recordIds.includes(id))) continue
        const row = await entry.archive.redactVoucher(index).catch((error) => ({ changed: false, reason: 'internal-failure', error }))
        // 判据是「回执正文此刻是否已不可见且账本已记」——`already-redacted`（表面已是常量、
        // 本次只补标记）同样是成功：changed 为 false 但 marked 为 true，不能当失败。
        if (row.marked === true) changed += 1
        else blocking.push({ index, reason: row.marked === false ? 'redaction-mark-failed' : (row.reason ?? 'unknown') })
      }
      preRedact = { changed, blocking }
      if (blocking.length > 0) {
        // 失败关闭：不删任何正文，把「哪几段回执清不掉」如实带回。
        ctx.logger?.warn?.('memory-context-lab-v3: purge 前置清除未完成，已中止（不会留下回执正文残留）：' + JSON.stringify(blocking))
        return { error: 'purge-redaction-incomplete', purge: false, preRedact, blocked: blocking }
      }
    }
    // A-05（0.15.4）：孤儿回执**也在遗忘级联里**。
    //
    // 旧缺陷：orphan-receipts.jsonl 里的 receiptText 是明文，却完全不在遗忘/清除级联中。
    // 结果是 forget/purge 之后这段明文永久留盘，且因为没有对应凭证，restore 恒
    // receipt-changed——既不可恢复也不可清除。与上面 preRedact 同一口径：先清、清不掉就如实报告。
    let orphanRedact = null
    if (typeof entry.runtime.store.redactOrphansFor === 'function') {
      try {
        orphanRedact = await entry.runtime.store.redactOrphansFor(recordIds)
        if ((orphanRedact?.failed ?? []).length > 0) {
          ctx.logger?.warn?.('memory-context-lab-v3: 孤儿回执清除未全部成功（正文可能残留）：' + JSON.stringify(orphanRedact.failed))
        }
      } catch (error) {
        orphanRedact = { changed: 0, ids: [], failed: [{ id: '*', reason: error?.code ?? error?.message ?? String(error) }] }
        ctx.logger?.warn?.('memory-context-lab-v3: 孤儿回执清除异常（正文可能残留）：' + (error?.code ?? error?.message ?? String(error)))
      }
    }
    const result = purge
      ? await entry.runtime.store.purge(recordIds)
      : await entry.runtime.store.forget(recordIds)
    await refreshSearchable(entry)
    // G3 接线（G7，接线清单 ②）：遗忘把本会话诊断行整体删掉（keepRows:0）——诊断行不是
    // 「历史」，忘掉的内容不该继续在观测账本里留 token/指纹残影。**失败只告警**：
    // 诊断清理绝不能成为 forget 失败的理由（隐私面以 store.forget 为准，已先落盘）。
    try {
      const pruned = await pruneCacheObservationLedger(entry.runtime.store.directory, { keepRows: 0 })
      if (pruned?.ok !== true) {
        ctx.logger?.warn?.('memory-context-lab-v3: 遗忘后诊断账本清理未完成（不影响遗忘）：' + String(pruned?.error ?? 'unknown'))
      }
    } catch (error) {
      ctx.logger?.warn?.('memory-context-lab-v3: 遗忘后诊断账本清理异常（不影响遗忘）：' + (error?.code ?? error?.message ?? String(error)))
    }
    // 本地隐私面先生效；镜像遗忘失败只告警（不回滚本地、也不谎报已全忘）。
    if (typeof entry.runtime.provider?.forgetRecords === 'function') {
      try {
        const mirror = await entry.runtime.provider.forgetRecords(recordIds)
        if (mirror.failed > 0) {
          ctx.logger?.warn?.('memory-context-lab-v3: T2 镜像遗忘部分失败（本地已遗忘）：' + mirror.failed + ' 条')
        }
      } catch (error) {
        ctx.logger?.warn?.('memory-context-lab-v3: T2 镜像遗忘失败（本地已遗忘）：' + (error?.message ?? String(error)))
      }
    }
    const vouchers = entry.runtime.store.listVouchers()
    // D-C：隐私面级联失败必须可见（旧实现 .catch(() => {}) 把 receipt-changed 吞掉，
    // 观察面以为回执仍可恢复）。
    const redact = { attempted: 0, changed: 0, failed: [] }
    for (let index = 0; index < vouchers.length; index += 1) {
      if (!(vouchers[index].recordIds ?? []).some((id) => recordIds.includes(id))) continue
      redact.attempted += 1
      const row = await entry.archive.redactVoucher(index).catch((error) => ({ changed: false, reason: 'internal-failure', error }))
      // H4：只有「活动面替换成功 **且** redactions 标记落盘」才算清除成功。旧实现把
      // 标记失败吞掉仍计 changed，命令面谎报「已清除」，导出却因读不到标记带出正文。
      if (row.changed === true && row.marked === true) redact.changed += 1
      else if (row.changed === true) {
        redact.failed.push({ index, reason: 'redaction-mark-failed', error: row.markError ?? null })
        ctx.logger?.warn?.('memory-context-lab-v3: 回执已在活动面清除但持久标记失败（#' + index + '：' + (row.markError ?? 'unknown') + '）——history/导出可能仍显示正文')
      } else if (row.reason !== 'voucher-not-found') {
        redact.failed.push({ index, reason: row.reason ?? 'unknown' })
        ctx.logger?.warn?.('memory-context-lab-v3: 隐私面回执清除失败（#' + index + '：' + (row.reason ?? 'unknown') + '）——历史里该段已不可恢复')
      }
    }
    // P2-07：purge 的回执清除已在删正文之前完成（preRedact）。下面这个循环对 purge 情况
    // 只剩幂等补标记作用（already-redacted 分支），不会再出现「正文已删、回执还在」。
    // H4：purge 额外清派生物（摘要转述 + repair-log 历史半行原文）。普通忘记保留摘要行，
    // 靠可见性现场隐藏（append-only 合同），只有不可恢复的 purge 才物理删。
    let derived = null
    if (purge) {
      const summariesPurged = await purgeSummariesForRecords(entry.runtime.store.directory, recordIds).catch((error) => ({ ok: false, reason: error?.code ?? String(error) }))
      const repairScrubbed = await scrubRepairLogPreviews(entry.runtime.store.directory).catch((error) => ({ ok: false, reason: error?.code ?? String(error) }))
      derived = { summaries: summariesPurged, repairLog: repairScrubbed }
      if (summariesPurged.ok !== true) ctx.logger?.warn?.('memory-context-lab-v3: purge 后摘要清除失败（读面仍按来源隐藏）：' + String(summariesPurged.reason))
      if (repairScrubbed.ok !== true) ctx.logger?.warn?.('memory-context-lab-v3: purge 后 repair-log 清理失败：' + String(repairScrubbed.reason))
    }
    // M6：文件引用账本同样含「读过什么路径」，遗忘必须级联删除这些行（旧实现只清
    // cache-observations，file-references.json 永久留盘且 file-status 原样打印）。
    let fileRefsRemoved = 0
    if (entry.fileRefs.length > 0) {
      const before = entry.fileRefs.length
      entry.fileRefs = entry.fileRefs.filter((ref) => !recordIds.includes(ref.recordId))
      fileRefsRemoved = before - entry.fileRefs.length
      if (fileRefsRemoved > 0) {
        try {
          // T-11：遗忘是**权威删除**，必须整本替换（merge:false）——
          // 用「按路径合并」会把刚摘掉的引用按磁盘旧值加回来（隐私回退）。
          // 整本替换仍在跨进程写锁内执行，不会与并发追加互相覆盖到写坏文件。
          await writeFileReferences(entry.runtime.store.directory, entry.fileRefs, { merge: false })
        } catch (error) {
          ctx.logger?.warn?.('memory-context-lab-v3: 遗忘后文件引用账本清理失败（读取面已隐藏）：' + (error?.message ?? String(error)))
        }
      }
    }
    // P4（§7.4 R10）：摘要与待执行提案同样受遗忘级联约束。
    // - 摘要：可见性由 (来源集合 ∩ 遗忘集) 现场判定，read/search/export 三处同源；
    //   这里只统计影响面（不写盘），混合多源摘要整条隐藏，不做「删一个引用保留文本」。
    // - 待执行提案：来源被忘的 accepted 提案立即标 stale，防止下一安全边界把它提交。
    let summariesAffected = 0
    if (entry.summaries !== null) {
      try {
        const affected = await entry.summaries.affectedByForget({ entry, recordIds })
        if (affected.ok === true) summariesAffected = affected.summaryIds.length
      } catch (error) {
        ctx.logger?.warn?.('memory-context-lab-v3: 摘要遗忘影响面不可读（读面仍会现场隐藏）：' + (error?.message ?? String(error)))
      }
    }
    const proposalsStale = []
    if (entry.compact !== null) {
      try {
        const pendingRows = await entry.compact.pending({ entry })
        for (const proposal of pendingRows) {
          const hit = (proposal.candidate?.recordIds ?? []).filter((id) => recordIds.includes(id))
          if (hit.length === 0) continue
          await entry.compact.markStale({ entry, proposalId: proposal.proposalId, reason: 'source-forgotten', reasons: ['source-forgotten'] })
          proposalsStale.push(proposal.proposalId)
        }
      } catch (error) {
        ctx.logger?.warn?.('memory-context-lab-v3: 遗忘后提案失效标记失败（提交边界仍会重验证）：' + (error?.message ?? String(error)))
      }
    }
    // D-D：遗忘不再删除 pin。pin 是用户意图，一次 forget 不该永久丢失它；
    // 保留后 undo 自然恢复保护（旧实现删了 pins、undo 却不恢复）。
    // T-06（0.15.4）：purge 之后必须让 `seqToRecordId` 里对应的 seq 失效。
    //
    // 缺陷：`entry.seqToRecordId` 是打开期由 checkpoint 重建的映射（seq → recordId）。
    // purge 删掉了 payload，却没删映射，于是下一次归档取到那个 seq 仍会去读记录 →
    // `record-read-failed` → 整个归档批次失败；而失败不会清理映射，**每一步都重复同一次失败**。
    // 用户看到的现象是「归档不动了」，根因却是一次已经完成的 purge。
    //
    // 修法：把被清除记录对应的 seq 一并从映射里删掉，让归档侧看不见它们（等价于从未入档）。
    if (purge && recordIds.length > 0) {
      const purgedSet = new Set(recordIds)
      for (const [seq, recordId] of [...entry.seqToRecordId]) {
        if (purgedSet.has(recordId)) entry.seqToRecordId.delete(seq)
      }
    }
    // T-05（0.15.4）：purge 的 rm 失败要如实上报，不能因为「账已生效」就把残留说成成功。
    // `result.residue` 由 store.purge 在删除失败时给出（逻辑已清除、字节仍在盘上）。
    return { ...result, undone: false, purged: purge, redact, orphans: orphanRedact, summariesAffected, proposalsStale, fileRefsRemoved, derived }
  }

  /**
 * 当前工作集：当前回合（最后一个真人 user 起）的 surface 节点 → v3 记录。
 * 只读；不触发归档，不改变 surface。
 */
async function workingSet(sessionId) {
    const entry = runtimes.get(String(sessionId ?? ''))
    if (entry === undefined) return { error: 'not-ready' }
    if (typeof entry.runtime.host.surfaceNodes !== 'function') return { error: 'host-no-surface' }
    const surfaceNodes = await entry.runtime.host.surfaceNodes()
    const events = await entry.runtime.host.events()
    const bySeq = new Map(events.map((event) => [event.seq, event]))
    let start = 0
    for (const seq of surfaceNodes) {
      const event = bySeq.get(seq)
      if (event?.type === 'user/message' && (event?.data?.source?.kind ?? event?.source?.kind) === 'user') start = seq
    }
    const rows = []
    for (const seq of surfaceNodes) {
      if (seq < start) continue
      const recordId = entry.seqToRecordId.get(seq)
      if (typeof recordId === 'string') rows.push({ seq, recordId })
    }
    return { startSeq: start, rows }
  }

  /** 本地红导出：写入 v3Root/exports/；已遗忘正文不导出。 */
async function exportSession(sessionId) {
    const entry = runtimes.get(String(sessionId ?? ''))
    if (entry === undefined) return { error: 'not-ready' }
    const ids = await entry.runtime.store.listRecordIds()
    const forgotten = typeof entry.runtime.store.listForgotten === 'function' ? entry.runtime.store.listForgotten() : []
    const records = []
    for (const id of ids) {
      try {
        const record = await entry.runtime.store.readRecord(id)
        if (record !== null) records.push(record)
      } catch (error) {
        if (error?.code !== 'EFORGOTTEN') return { error: error?.code ?? 'record-read-failed' }
      }
    }
    const exportedAt = Date.now()
    // AUD48-08-02：清除账本读不到 = 无法判定哪些回执该剥正文，导出必须失败关闭，
    // 不能把可能已清除的 receiptText/summaryText 照常打包。
    let redactedVoucherIds = []
    try {
      redactedVoucherIds = typeof entry.runtime.store.redactedVoucherIds === 'function'
        // T-03：端口层「按戳刷新后读」，必须 await——否则导出会漏掉别的句柄刚清除的回执。
        ? await entry.runtime.store.redactedVoucherIds()
        : []
    } catch (error) {
      return { error: error?.code ?? 'redactions-unreadable' }
    }
    // P4：详细摘要随包导出（隐藏判定与正文脱敏在 domain/export/bundle 内统一做）。
    // 读不到摘要日志 = 无法判定哪些该隐藏：与清除账本同口径，失败关闭。
    let summaries = []
    try {
      const listed = await listSummaries(entry.runtime.store.directory)
      if (listed.ok !== true) return { error: 'summaries-unreadable: ' + listed.reason }
      summaries = listed.rows
    } catch (error) {
      return { error: error?.code ?? 'summaries-unreadable' }
    }
    const bundle = buildExportBundle({
      sessionKey: String(sessionId),
      exportedAt,
      records,
      forgotten,
      vouchers: entry.runtime.store.listVouchers(),
      redactedVoucherIds,
      summaries,
      state: stateOf(sessionId),
      // P2-4：导出路径重算来源指纹（hash 不可用时由 bundle 按 integrity-unavailable 隐藏）。
      sha256: hashOf(entry),
    })
    const file = await writeExportBundle(v3Root, String(sessionId), bundle)
    return { file, counts: bundle.counts }
  }

/** 导入导出包到**空会话**（fork/share 的落地）；不覆盖已有记录。 */
async function importSession(sessionId, fileName, session = null) {
    let entry = runtimes.get(String(sessionId ?? ''))
    if (entry === undefined) {
      if (session === null) return { error: 'not-ready' }
      entry = await ensureEntry(session, String(sessionId ?? ''))
    }
    const existing = await entry.runtime.store.listRecordIds()
    if (existing.length > 0) return { error: 'session-not-empty' }
    if (typeof entry.runtime.store.importRecords !== 'function') return { error: 'store-no-import' }
    const bundle = await readExportBundle(v3Root, fileName)
    // S-13（0.15.4）：`adopt <文件名>` 必须与 `adopt-from` 服从**同一道父会话同意门**。
    //
    // 缺陷：`adopt-from` 会查 `adopt-allow`、会比对 `bundle.sessionKey`，而 `adopt <文件名>`
    // 一个都不查——它从**全局共享**的 `exports/` 目录直接读包，于是任何会话都能凭一个
    // 文件名把别人的记忆搬进来。同意门因此形同虚设（只要绕过命令面用文件名）。
    //
    // 修法：打包在导出时就写入了 `sessionKey`，这里拿它当来源身份，
    // 按与 `adopt-from` 相同的同意判据校验；来源不可判定时同样失败关闭。
    const guard = await adoptGateFor(bundle.sessionKey, session)
    if (guard !== null) return { error: guard }
    const inputs = bundle.records.filter((record) => record !== null && typeof record === 'object' && typeof record.payload?.text === 'string')
    if (inputs.length === 0) return { error: 'bundle-empty' }
    const result = await entry.runtime.store.importRecords(inputs)
    await refreshSearchable(entry)
    // P3-4：导出包含 summaries，但本版 adopt 只导入正文记录。不得静默丢弃：
    // 把「有几条摘要没进来、为什么」作为结果的一部分返回（命令面据此显示）。
    const summaryRows = Array.isArray(bundle.summaries) ? bundle.summaries : []
    return {
      imported: result.recordIds?.length ?? inputs.length,
      sessionKey: bundle.sessionKey,
      summaries: { available: summaryRows.length, imported: 0, skipped: summaryRows.length, reason: 'summaries-not-imported' },
    }
  }

/**
 * `adopt-allow` 的会话级同意（H5）。默认拒绝；用户在**父会话**里显式打开，
 * 才有资格被别的空会话复制。写失败不静默成功。
 */
async function setAdoptAllow(sessionId, allow) {
  const entry = runtimes.get(String(sessionId ?? ''))
  if (entry === undefined) return { error: 'not-ready' }
  try {
    const written = await writeAdoptConsent(entry.runtime.store.directory, {
      allow,
      sessionKey: entry.runtime.sessionKey,
    })
    return { allow: written.allow, path: adoptConsentPath(entry.runtime.store.directory) }
  } catch (error) {
    return { error: error?.code ?? error?.message ?? 'consent-write-failed' }
  }
}

/** 当前会话的 adopt 同意状态（只读；损坏按「不允许」显示并带 error）。 */
async function adoptStatus(sessionId) {
  const entry = runtimes.get(String(sessionId ?? ''))
  if (entry === undefined) return { error: 'not-ready' }
  return await readAdoptConsent(entry.runtime.store.directory)
}

/** 子会话若暴露原生 fork 关系，就用它做归属校验（未知则返回 null，交给同意门）。 */
function forkParentOf(session) {
  const raw = session?.header?.parentSessionId
    ?? session?.header?.parentId
    ?? session?.meta?.parentSessionId
    ?? session?.parentSessionId
    ?? null
  return typeof raw === 'string' && raw.length > 0 ? raw : null
}

/**
 * S-13（0.15.4）：`adopt <文件名>` 与 `adopt-from` 共用的同意门。
 *
 * `adopt-from` 有两道校验：fork 归属 + 父会话显式同意。`adopt <文件名>` 走的是
 * **全局共享**的 `exports/` 目录，身份只能来自包内 `sessionKey`，因此：
 * - 包能给出 `sessionKey`，且该会话正被本进程打开 → 按同一 consent 判据校验；
 * - 包给不出身份、或来源会话未打开 → **失败关闭**（不因为「查不到就放行」）；
 * - 包内 `sessionKey` 就是目标会话自己 → 允许（等价于「恢复自己的导出」，
 *   没有跨会话搬运，也没有第三方内容进入）。
 *
 * 返回 `null` 表示放行，否则返回错误码。
 */
async function adoptGateFor(sourceSessionKey, session = null) {
  const source = typeof sourceSessionKey === 'string' && sourceSessionKey.length > 0 ? sourceSessionKey : null
  if (source === null) return 'bundle-identity-missing'
  const selfKey = session?.header?.sessionId ?? session?.sessionKey ?? null
  if (typeof selfKey === 'string' && selfKey === source) return null
  // 按 sessionKey 反查已打开的会话（runtimes 以 sessionId 为键；sessionKey 是运行期身份）。
  let holder = null
  for (const entry of runtimes.values()) {
    if (entry?.runtime?.sessionKey === source) {
      holder = entry
      break
    }
  }
  if (holder === null) {
    // 来源会话没有在本进程打开：它的隔离根里可能留着自己的 `control.json` /
    // 同意状态，但**没有持有者就不能读它的会话状态**（会话根按 sessionKey 派生，
    // 我们需要的是「那个会话的目录」，而这正由 `v3Root/sessions/<key>` 决定）。
    //
    // 这里不猜「没打开就等于同意」——那是失败开放。但也不能一律拒绝：
    // 同一份 `v3Root` 上「先导出、后导入」是合法用法（导出方会话已关闭）。
    //
    // 判据取**导出包自身的来源同意快照**：导出时若来源会话已授权，包里保留
    // `adoptConsent` 事实；没有这个事实就按拒绝处理。
    const consentDir = await readAdoptConsentBySessionKey(v3Root, source)
    const snapshot = consentDir
    if (snapshot.allow !== true) return 'parent-consent-required'
    return null
  }
  const consent = await readAdoptConsent(holder.runtime.store.directory)
  if (consent.allow !== true) return 'parent-consent-required'
  return null
}

/** 原生 fork 后把父会话正文复制到当前空子会话（不复制父 surface/凭证）。 */
async function adoptFrom(sessionId, parentSessionId, session = null) {
    if (String(sessionId) === String(parentSessionId)) return { error: 'same-session' }
    let child = runtimes.get(String(sessionId ?? ''))
    if (child === undefined) {
      if (session === null) return { error: 'not-ready' }
      child = await ensureEntry(session, String(sessionId ?? ''))
    }
    const parent = runtimes.get(String(parentSessionId ?? ''))
    if (parent === undefined) return { error: 'parent-not-ready' }
    if (typeof child.runtime.store.importRecords !== 'function') return { error: 'store-no-import' }
    const existing = await child.runtime.store.listRecordIds()
    if (existing.length > 0) return { error: 'session-not-empty' }
    // H5 归属校验①：原生 fork 关系可判读时必须一致（读到就比对，读不到不猜）。
    const forkParent = forkParentOf(session)
    if (forkParent !== null && String(forkParent) !== String(parentSessionId) && String(forkParent) !== String(sessionId)) {
      return { error: 'parent-lineage-mismatch', forkParent }
    }
    // H5 归属校验②：父会话必须显式同意被复制（默认拒绝）。这是用户动作、可撤销、可审计。
    const consent = await readAdoptConsent(parent.runtime.store.directory)
    if (consent.allow !== true) {
      return { error: 'parent-consent-required', reason: consent.error ?? null }
    }
    const ids = await parent.runtime.store.listRecordIds()
    // M9：父会话过大时拒绝，避免一次复制把内存/磁盘打满（与导入包同一上限）。
    if (ids.length > EXPORT_IMPORT_LIMITS.maxRecords) return { error: 'parent-too-large', count: ids.length, limit: EXPORT_IMPORT_LIMITS.maxRecords }
    const records = []
    for (const id of ids) {
      try {
        const record = await parent.runtime.store.readRecord(id)
        if (record !== null) records.push(record)
      } catch (error) {
        if (error?.code !== 'EFORGOTTEN') return { error: error?.code ?? 'record-read-failed' }
      }
    }
    if (records.length === 0) return { error: 'parent-empty' }
    const result = await child.runtime.store.importRecords(records)
    await refreshSearchable(child)
    // P3-4：父会话的摘要同样不在 adopt-from 的复制面内；显式报告而不是静默丢失。
    let summaryReport
    try {
      const listed = await listSummaries(parent.runtime.store.directory)
      summaryReport = listed.ok === true
        ? { available: listed.rows.length, imported: 0, skipped: listed.rows.length, reason: 'summaries-not-imported' }
        : { available: null, imported: 0, skipped: null, reason: 'summaries-unreadable: ' + listed.reason }
    } catch (error) {
      summaryReport = { available: null, imported: 0, skipped: null, reason: 'summaries-unreadable: ' + (error?.code ?? String(error)) }
    }
    return { imported: result.recordIds?.length ?? records.length, parentSessionId, summaries: summaryReport }
  }

/** 文件引用清单（只读；账本损坏时 error 如实返回）。 */
async function fileStatus(sessionId) {
    const entry = runtimes.get(String(sessionId ?? ''))
    if (entry === undefined) return { error: 'not-ready' }
    if (entry.fileRefsError !== null) return { error: entry.fileRefsError, refs: [] }
    return { refs: entry.fileRefs.map((ref) => ({ ...ref })) }
  }

/** 显式核验：只核选中的引用；不后台扫描、不改记录正文。 */
  async function verifyFiles(sessionId, { all = false, id = null, recordId = null } = {}) {
    const entry = runtimes.get(String(sessionId ?? ''))
    if (entry === undefined) return { error: 'not-ready' }
    if (entry.fileRefsError !== null) return { error: entry.fileRefsError }
    const targets = entry.fileRefs.filter((ref) => all || (id !== null && ref.id === id) || (recordId !== null && ref.recordId === recordId))
    if (targets.length === 0) return { error: 'no-matching-reference', refs: [] }
    // M6：重开后账本里只有 workspaceId（不含绝对路径），核验要拿当前会话 cwd 重新比对。
    let workspaceRoot = null
    try { workspaceRoot = (await entry.runtime.host.sessionInfo())?.cwd ?? null } catch { workspaceRoot = null }
    const rows = []
    for (const ref of targets) {
      const verified = await verifyFileReference(ref, { workspaceRoot })
      const index = entry.fileRefs.findIndex((item) => item.id === ref.id)
      if (index >= 0) entry.fileRefs[index] = verified
      rows.push({ id: verified.id, recordId: verified.recordId, path: verified.path, status: verified.status, reason: verified.reason ?? null })
    }
    try {
      await writeFileReferences(entry.runtime.store.directory, entry.fileRefs)
    } catch (error) {
      return { error: 'write-failed: ' + (error?.message ?? String(error)), rows }
    }
    return { rows }
  }

  /**
   * 显式 T2 回填（P1，0.14.0-beta.38）。
   *
   * 同步只做「计划 + 落状态 + 启动后台任务」，命令立即返回计划量；镜像走 provider 的
   * 串行队列，不占 pre-step。幂等判据是隔离根里真实存在的 v3r-* 节点（不是内存游标），
   * 因此进程重启后重复执行也不会重复写、重复计数。
   */
  async function startT2Backfill(sessionId, rawLimit) {
    const key = String(sessionId ?? '')
    const parsed = parseBackfillLimit(rawLimit)
    if (parsed.ok !== true) return { error: 'invalid-limit', message: parsed.message }
    const entry = await entryOf(key)
    if (entry === null) return { error: 'not-ready' }
    const provider = entry.runtime.provider
    let tier = null
    try { tier = provider?.capabilities?.()?.tier ?? null } catch { tier = null }
    if (tier !== 'T2' || typeof provider.mirrorRecord !== 'function') {
      // 明确失败：T2 不可用时不偷偷回 T1 假装成功（T1 没有镜像面）。
      return {
        error: 't2-unavailable',
        reason: String(entry.runtime.providerDecision?.reason ?? '当前后端不是 T2（隔离 MCP）'),
      }
    }
    const existing = backfillJobs.get(key)
    if (existing !== undefined) return { alreadyRunning: true, planned: existing.state.planned, state: existing.state }
    const inventory = await scanMirrorableRecords(entry.runtime.store)
    const root = t2RootOf(entry)
    const mirrored = await scanMirroredNodes(root)
    const plan = planBackfill({ records: inventory.records, mirroredIds: mirrored.nodes, limit: parsed.limit })
    const facts = {
      records: {
        total: inventory.total,
        mirrorable: inventory.mirrorable,
        metaOnly: inventory.metaOnly,
        emptyText: inventory.emptyText,
        forgotten: inventory.forgotten,
      },
      mirrored: {
        state: mirrored.state,
        mirrored: mirrored.mirrored,
        smoke: mirrored.smoke,
        rejected: mirrored.rejected,
        other: mirrored.other,
      },
    }
    if (plan.pending.length === 0) {
      const state = {
        status: 'done', limit: parsed.limit, planned: 0, pendingTotal: plan.pendingTotal,
        processed: 0, mirrored: 0, failed: 0, dropped: 0,
        startedAt: Date.now(), finishedAt: Date.now(), reason: 'nothing-to-do',
      }
      await writeBackfillState(entry.runtime.store.directory, state)
      return { planned: 0, pendingTotal: plan.pendingTotal, ...facts }
    }
    const directory = entry.runtime.store.directory
    const controller = { aborted: false }
    const job = {
      controller,
      state: {
        status: 'running', limit: parsed.limit, planned: plan.pending.length, pendingTotal: plan.pendingTotal,
        processed: 0, mirrored: 0, failed: 0, dropped: 0, startedAt: Date.now(),
      },
      promise: null,
    }
    await writeBackfillState(directory, job.state)
    backfillJobs.set(key, job)
    job.promise = (async () => {
      try {
        const result = await runBackfill({
          provider,
          records: plan.pending,
          signal: controller,
          onProgress: async (progress) => {
            job.state = {
              ...job.state,
              processed: progress.processed,
              mirrored: progress.mirrored,
              failed: progress.failed,
              dropped: progress.dropped,
            }
            await writeBackfillState(directory, job.state)
              .catch((error) => ctx.logger?.warn?.('memory-context-lab-v3: 回填状态落盘失败（进度仍以隔离根为准）：' + (error?.message ?? String(error))))
          },
        })
        // 收尾对账：以磁盘上真实存在的节点为准（计数器只用于进度）。
        let present = null
        try {
          const after = await scanMirroredNodes(root)
          present = plan.pending.filter((record) => after.nodes.has(record.id)).length
        } catch {
          present = null
        }
        job.state = {
          ...job.state,
          status: result.status === 'cancelled' ? 'cancelled' : 'done',
          processed: plan.pending.length,
          mirrored: present === null ? result.mirrored : present,
          failed: present === null ? result.failed : plan.pending.length - present,
          dropped: result.dropped,
          finishedAt: Date.now(),
        }
        await writeBackfillState(directory, job.state)
      } catch (error) {
        job.state = {
          ...job.state,
          status: 'failed',
          lastError: (error?.code ?? 'EBACKFILL') + ' ' + (error instanceof Error ? error.message : String(error)),
          finishedAt: Date.now(),
        }
        await writeBackfillState(directory, job.state)
          .catch((error) => ctx.logger?.warn?.('memory-context-lab-v3: 回填状态落盘失败（进度仍以隔离根为准）：' + (error?.message ?? String(error))))
      } finally {
        backfillJobs.delete(key)
      }
    })()
    return { planned: plan.pending.length, pendingTotal: plan.pendingTotal, ...facts, state: job.state }
  }

  /** 请求中断回填：只在批间生效，不杀在飞的单条写。 */
  function cancelT2Backfill(sessionId) {
    const key = String(sessionId ?? '')
    const job = backfillJobs.get(key)
    if (job === undefined) return { cancelled: false, reason: 'not-running' }
    job.controller.aborted = true
    return { cancelled: true }
  }

  /** 清理冒烟节点（P2）：不是回填，不影响真实镜像计数。 */
  async function cleanupSmokeNode(sessionId) {
    const entry = await entryOf(String(sessionId ?? ''))
    if (entry === null) return { error: 'not-ready' }
    const provider = entry.runtime.provider
    if (typeof provider.cleanupSmoke !== 'function') return { error: 't2-unavailable' }
    return await provider.cleanupSmoke()
  }

  /** 已遗忘 ID 列表（forget status）。 */
  async function listForgotten(sessionId) {
    const entry = runtimes.get(String(sessionId ?? ''))
    if (entry === undefined) return { error: 'not-ready' }
    if (typeof entry.runtime.store.listForgotten !== 'function') return { error: 'store-no-list' }
    return { ids: entry.runtime.store.listForgotten() }
  }

  /**
   * 首次建库时落 mode 快照（D-15）：
   * - 已有记录但没有 state → recall-only（旧会话不静默接管）；
   * - 无记录的新会话 → fullHistory 默认（full-history / cooling）。
   * 写失败只告警：stateOf 仍能按默认工作，但不把失败伪装成已落盘。
   */
  async function ensureStateSnapshot(sessionId, lastSeq) {
    const current = stateOf(sessionId)
    if (current.exists === true) return current
    const mode = lastSeq >= 0 ? modeForMigratedSession() : defaultModeNow()
    const settings = settingsNow()
    const initial = {
      ...emptySessionState(mode),
      modeSource: lastSeq >= 0 ? 'migration' : 'default',
      // 计划先行只作用于新会话；停用恢复是**全局设置**，不得在 state 里冻结（
      // 旧实现把 lastSeq>=0 的会话强制成 true，设置页关掉后 off 仍恢复原文）。
      planFirst: lastSeq >= 0 ? false : settings.planFirst === true,
      autoRestore: settings.autoRestore !== false,
      updatedAt: Date.now(),
    }
    try {
      // R3-01：初始化走 create-if-absent（锁内重读）——与更新区分；两进程同时初始化
      // 只有一个落盘，已有 state（含损坏）不被默认值覆盖。
      return await ensureInitialSessionState(v3Root, String(sessionId ?? ''), initial)
    } catch (error) {
      ctx.logger?.warn?.('memory-context-lab-v3: state.json 初始化失败（继续按默认模式）：' + (error?.message ?? String(error)))
      return current
    }
  }

  // 摄入批大小：回填按批走事务；新事件通常 1-3 条一批
  const INGEST_BATCH = 100

  async function ingestAll(entry, log) {
    let batch = []
    let batchFirstSeq = null
    let ingested = 0
    // M-04（0.15.4）：本次摄入新增的可检索文档（{id, text}），供增量索引并入。
    // 不收集「移除」——摄入路径只新增；遗忘走 forgetRecords 自己的索引路径。
    const ingestedRecords = []
    // B3-4（AUD50-02-09）：非记忆/坏 seq 事件不在断点账上——队尾残留时每次 pre-step
    // 都重扫同一段。非记忆事件（合法 seq）在**本轮全部记忆事件处理完后**推进断点
    // （不写记录）；坏 seq 无法推进（不伪造 lastSeq），warn 一次并在内存记「已见」。
    let lastSkippedSeq = null
    const batchState = { failedUpTo: -1 }
    let failedUpTo = -1
    for (const raw of log) {
      if (disposed.value) return
      if (!Number.isSafeInteger(raw?.seq) || raw.seq < 0) {
        // 只有记忆类型事件才值得告警（非记忆坏 seq 本来就不进管线）；warn 一次，不逐步刷屏
        if (raw !== null && typeof raw === 'object' && MEMORY_EVENT_TYPES.has(raw?.type)) {
          const key = String(raw.seq)
          if (!entry.badSeqs.has(key)) {
            entry.badSeqs.add(key)
            metricsNote('v3.ingest.badSeq')
            ctx.logger?.warn?.('memory-context-lab-v3: 记忆事件 seq 非法（不推进断点、不入库）：' + key + '（type=' + String(raw.type) + '）')
          }
        }
        continue
      }
      if (!MEMORY_EVENT_TYPES.has(raw.type)) {
        lastSkippedSeq = lastSkippedSeq === null ? raw.seq : Math.max(lastSkippedSeq, raw.seq)
        continue
      }
      if (Number.isInteger(entry.lastSeq) && raw.seq <= entry.lastSeq) continue
      batch.push(raw)
      batchFirstSeq = batchFirstSeq ?? raw.seq
      if (batch.length >= INGEST_BATCH) {
        ingested += await ingestBatch(entry, batch, batchFirstSeq, batchState, ingestedRecords)
        failedUpTo = Math.max(failedUpTo, batchState.failedUpTo)
        batchState.failedUpTo = -1
        batch = []
        batchFirstSeq = null
      }
    }
    if (batch.length > 0 && !disposed.value) {
      ingested += await ingestBatch(entry, batch, batchFirstSeq, batchState, ingestedRecords)
      failedUpTo = Math.max(failedUpTo, batchState.failedUpTo)
    }
    // B3-4：非记忆事件推进断点——仅当本轮没有失败的存储事务（事务级失败的记忆事件
    // 还没入库，推进断点会把它们永久跳过；下轮摄入成功后自然吸收）。
    if (!disposed.value && lastSkippedSeq !== null && failedUpTo === -1
      && (!Number.isInteger(entry.lastSeq) || lastSkippedSeq > entry.lastSeq)) {
      entry.lastSeq = lastSkippedSeq
      metricsNote('v3.ingest.nonMemorySkipped')
    }
    // 只有回填（大批量）才在这里重建索引；每步 1-3 条的小增量留 stale，
    // 检索时懒重建——否则每步全量重建二十几 MB 索引会卡住宿主事件循环（首字慢）。
    if (!disposed.value && ingested >= INGEST_BATCH) {
      // M-04（0.15.4）：大批量也先试增量；不可信（索引缺失/基线漂移）才退回全量重建。
      const incremental = await applyIncrementalIndex(entry, ingestedRecords)
      if (incremental !== true) {
        try {
          await entry.runtime.store.rebuildIndex()
          await refreshSearchable(entry)
        } catch (error) {
          ctx.logger?.warn?.('memory-context-lab-v3: 索引重建失败（检索时会自动重试）：' + (error?.message ?? String(error)))
        }
      }
    } else if (!disposed.value && ingested > 0) {
      // 小增量：回注路径不允许重建（会在 pre-step 里做 O(N) 全量活），
      // 因此改为摄入后**延迟后台重建**——空闲时做，索引在下一回合前追上。
      //
      // 例外：**索引根本不存在**时不能等防抖。那样新会话的头几步（用户发第一条消息、
      // 模型刚回第一个回合）会落在「索引还没生成」的窗口里，而回注热路径已禁止重建，
      // 只能回 skipped——首屏回注必然失效，直到 1.5s 后防抖任务跑过。
      // 这里仍在**摄入任务**里（不是 pre-step 钩子），重建不挡首字，只是把
      // 「首次可检索」提前到第一次摄入完成时。
      if (await isIndexAbsent(entry)) {
        try {
          await entry.runtime.store.rebuildIndex()
          await refreshSearchable(entry)
        } catch (error) {
          ctx.logger?.warn?.('memory-context-lab-v3: 首次索引重建失败（检索会回 skipped）：' + (error?.message ?? String(error)))
        }
      } else if (await applyIncrementalIndex(entry, ingestedRecords)) {
        // M-04（0.15.4）：增量已落盘 → **不再**排队全量重建。
        // 旧实现在这里无条件 `scheduleIndexRebuild`（1.5s 后全量重扫），正是「每步
        // 全量重建」的来源：3,044 ms / 26 MB 写、约 4.5 s 一轮、约 340 MB/分钟，
        // 67% 占主线程，直接顶住首字与宿主事件循环。
      } else {
        // 增量不可信（索引基线漂移/损坏）→ 必须全量追上，否则检索面会永久陈旧。
        scheduleIndexRebuild(entry)
      }
    }
  }

  /**
   * 持久断点（H-01）：已提交记录里出现过的最大宿主 seq。
   * 无记录 → -1（首事件 seq=0 不漏）；读失败 → 抛出，由调度层告警后保持 -1（不静默当作没有）。
   */
  async function resumeCheckpointOf(runtime) {
    // AUD50-04-02（B2-8）：优先读检查点（checkpoint.jsonl 与提交同锁追加的事件→记录
    // 映射），一次文件读恢复 lastSeq / seqToRecordId；缺失/损坏/落后于事务日志时
    // 回退全量 provenance 扫描（失败关闭，不用旧检查点掩盖新记录），并在扫描后把
    // 基线写回——迁移旧库只付一次全量扫描的钱。
    if (typeof runtime.store.readCheckpoint === 'function') {
      try {
        const checkpoint = await runtime.store.readCheckpoint()
        if (checkpoint?.usable === true) {
          let last = -1
          const seqToRecordId = new Map()
          for (const [sourceEventId, recordId] of checkpoint.pairs) {
            const seq = seqOfDshEventId(sourceEventId)
            if (seq === null) continue
            if (seq > last) last = seq
            seqToRecordId.set(seq, recordId)
          }
          return { lastSeq: last, seqToRecordId, checkpoint: 'hit' }
        }
      } catch (error) {
        ctx.logger?.warn?.('memory-context-lab-v3: 检查点读取失败（回退全量扫描）：' + (error?.message ?? String(error)))
      }
    }
    let last = -1
    const seqToRecordId = new Map()
    // 归档需要「宿主 seq → v3 记录 ID」；sourceEventIds 只给来源 ID，不能直接当记录 ID。
    // listRecordIds + readProvenance 是现有端口的最小组合，只在建库后台任务里跑一次。
    if (typeof runtime.store.listRecordIds === 'function' && typeof runtime.store.readProvenance === 'function') {
      // 检查点基线口径是「宿主事件 ID → 记录 ID」（与提交侧增量行同键）；
      // seqToRecordId（seq 数字键）只是入口运行期视图，两者不能混用。
      const eventToRecordId = new Map()
      for (const recordId of await runtime.store.listRecordIds()) {
        const provenance = await runtime.store.readProvenance(recordId)
        const sourceEventId = provenance?.sourceEventId
        const seq = seqOfDshEventId(sourceEventId)
        if (seq === null) continue
        if (seq > last) last = seq
        seqToRecordId.set(seq, recordId)
        eventToRecordId.set(sourceEventId, recordId)
      }
      // B2-8：迁移/回退扫完即写检查点基线（best-effort；扫描结果已过期时端口内部拒绝）。
      if (eventToRecordId.size > 0 && typeof runtime.store.saveCheckpointBaseline === 'function' && typeof runtime.store.health === 'function') {
        try {
          const health = await runtime.store.health()
          await runtime.store.saveCheckpointBaseline(health.maxTxn, eventToRecordId)
        } catch (error) {
          ctx.logger?.warn?.('memory-context-lab-v3: 检查点基线写入失败（下次打开再扫一次）：' + (error?.message ?? String(error)))
        }
      }
      if (seqToRecordId.size > 0) {
        ctx.logger?.warn?.('memory-context-lab-v3: 检查点不可用，回退全量扫描（' + seqToRecordId.size + ' 条）')
      }
      return { lastSeq: last, seqToRecordId, checkpoint: 'fallback' }
    }
    for (const sourceEventId of await runtime.store.sourceEventIds()) {
      const seq = seqOfDshEventId(sourceEventId)
      if (seq === null) continue
      if (seq > last) last = seq
    }
    return { lastSeq: last, seqToRecordId }
  }

  /**
   * 隔离根（t2-mdcg）：优先用 runtime 记录的隔离根，其次 provider 能力面声明的根，
   * 最后回落到会话目录下的 t2-mdcg。三条都是同一目录，用于覆盖率/回填扫描。
   */
  function t2RootOf(entry) {
    if (typeof entry?.runtime?.t2?.root === 'string' && entry.runtime.t2.root.length > 0) return entry.runtime.t2.root
    try {
      const declared = entry?.runtime?.provider?.capabilities?.()?.root
      if (typeof declared === 'string' && declared.length > 0) return declared
    } catch { /* 能力面不可读就回落默认目录 */ }
    return mirrorRootOf(entry?.runtime?.store?.directory)
  }

  /**
   * 索引统计（命令/诊断路径）：复用 provider 的索引解析缓存；失败返回三态，
   * 由调用方显示「未知」，绝不用 0 冒充可检索数。
   */
  async function indexStatsOf(entry) {
    try {
      if (typeof entry?.runtime?.provider?.indexStats === 'function') return await entry.runtime.provider.indexStats()
      return { state: 'unavailable', reason: 'provider 未提供索引统计' }
    } catch (error) {
      return { state: 'error', code: error?.code ?? 'EINDEX', message: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * 覆盖率事实：可镜像（payload.text 非空、未遗忘）与隔离根里真实存在的镜像节点。
   * 只在命令/诊断路径调用；失败时抛错，由命令面显示「未知」（不拿 0 冒充）。
   */
  async function coverageOf(entry, { collectRecords = false } = {}) {
    const records = await scanMirrorableRecords(entry.runtime.store, { collectRecords })
    const mirrored = await scanMirroredNodes(t2RootOf(entry))
    return {
      records: {
        total: records.total,
        mirrorable: records.mirrorable,
        metaOnly: records.metaOnly,
        emptyText: records.emptyText,
        forgotten: records.forgotten,
      },
      mirrored: {
        state: mirrored.state,
        files: mirrored.files,
        mirrored: mirrored.mirrored,
        smoke: mirrored.smoke,
        rejected: mirrored.rejected,
        other: mirrored.other,
      },
      recordsList: collectRecords ? records.records : null,
      nodes: mirrored.nodes,
    }
  }

  /**
   * 把「可检索」数字刷新进 entry（同步投影 statusOf 的唯一来源）。
   * 只在后台任务/命令路径调用——投影每个事件都会读 statusOf，那里不能碰磁盘。
   * 读不到保持 null（未知），不把 failure 说成 0。
   */
  async function refreshSearchable(entry) {
    try {
      const stats = await indexStatsOf(entry)
      if (stats.state === 'ok' && Number.isInteger(stats.indexedCount)) entry.searchable = stats.indexedCount
      else if (stats.state === 'absent') entry.searchable = null
    } catch {
      // 保留旧值：索引统计失败不等同于「可检索归零」
    }
  }

  /** 回填状态（只读；坏文件如实回 error，不拿 0 冒充）。 */
  /**
   * 归档意图对账（C-D / C-F，0.14.0-beta.48）：建库时与每个 pre-step 都尝试。
   *
   * 旧实现只在 ensureEntry 跑一次——voucher 失败后要等进程重启才自愈。pre-step 每次
   * 先读一次 intent（文件不存在就返回，成本一次 readFile），有 intent 才读活动面。
   * 恢复落 state 时按 intent.mode 分流：按步归档只写 lastArchiveAt，绝不写
   * lastArchiveEndSeq（那会成为回合级选择的永久下限）。
   */
  async function recoverArchiveIntent(entry, sessionId) {
    if (entry === null || entry === undefined || entry.archive === null) return { recovered: false }
    if (typeof entry.runtime?.host?.surfaceNodes !== 'function') return { recovered: false }
    let intent = null
    try {
      intent = await readArchiveIntent(v3Root, String(sessionId))
    } catch (error) {
      // R2-01：意图不可读不是「没有」——盲清等于放弃对账线索，盲占等于覆盖未知事务。
      // 报告 keptIntent+unreadable，让归档面阻断新提交（失败关闭），对账下步再试。
      ctx.logger?.warn?.('memory-context-lab-v3: 归档意图不可读（阻断新归档，本步跳过对账）：' + (error?.message ?? String(error)))
      return { recovered: false, keptIntent: true, unreadable: true, error }
    }
    if (intent === null || typeof intent !== 'object') return { recovered: false }
    const nodes = await entry.runtime.host.surfaceNodes()
    const recovered = await entry.archive.recoverIntent({
      sessionId: String(sessionId),
      surfaceNodes: nodes,
      surfaceTextOf: (seq) => entry.runtime.host.surfaceTextAt(seq),
    })
    if (recovered.recovered === true) {
      const at = Date.now()
      const surface = recovered.mode === 'cooling'
        ? { lastArchiveAt: at }
        : { lastArchiveEndSeq: recovered.endSeq, lastArchiveAt: at }
      // R3-01：走锁内 patch 更新（不再「读旧快照 → 整对象写回」）。
      await setState(String(sessionId), { surface })
      // P4：提案归档在 surface 后失败时，intent 会带着 proposalId 被对账补账；
      // 补账成功即真实凭证已落账，这里同步把提案标 committed（不靠内存状态）。
      if (typeof intent.proposalId === 'string' && entry.compact !== null) {
        try {
          await entry.compact.markCommitted({
            entry,
            proposalId: intent.proposalId,
            result: {
              candidateId: null,
              summaryId: typeof intent.summaryRef?.summaryId === 'string' ? intent.summaryRef.summaryId : null,
              voucherId: 'v-' + recovered.receiptSeq,
              receiptSeq: recovered.receiptSeq,
            },
          })
        } catch (error) {
          ctx.logger?.warn?.('memory-context-lab-v3: 提案补账后状态标记失败（凭证已补齐）：' + (error?.message ?? String(error)))
        }
      }
    }
    // P1-07：放弃是**有界**结局，必须在观察面留痕（否则用户只看到「不再阻塞」，不知道
    // 原文已改走孤儿回执）。孤儿回执由 /memory-lab restore 一并恢复。
    if (recovered.abandoned === true) {
      ctx.logger?.warn?.('memory-context-lab-v3: 归档意图已放弃（补凭证连续失败 ' + (recovered.attempts ?? '?')
        + ' 次，错误码 ' + (recovered.error ?? 'unknown') + '）：回执正文与记录 ID 已记入 orphan-receipts.jsonl'
        + '（' + (recovered.orphanId ?? '未返回 ID') + '），/memory-lab restore 会一并恢复')
    } else if (typeof recovered.abandonFailed === 'string') {
      ctx.logger?.warn?.('memory-context-lab-v3: 补凭证已到放弃阈值，但孤儿回执记账失败（' + recovered.abandonFailed
        + '）：继续保留 intent 并阻断新归档（宁可挡，也不丢恢复线索）')
    }
    // R2-01：意图仍在（补凭证失败 kept / 按身份清理冲突 clearStatus）→ 上报 keptIntent，
    // archiveForStep 据此阻断新归档，直到对账收敛。
    //
    // R2-01b（2026-10-31 审计）：判据改成**读槽位现状**，不再由 recovered/cleared 两个
    // 布尔推演。旧写法有两处不精确：
    // ① 对账成功但清理冲突（recovered=true, cleared=false）→ 旧式算出 keptIntent=false，
    //    而槽位上确实还压着别人的意图，与「意图仍在就上报」的口径相反（虽然提交边界的
    //    占槽仍会挡住，但入口不再提前暂停，一次归档会被走到 commit 才失败）；
    // ② 意图在两次读取之间消失（另一进程刚清完）→ recovered=false/cleared 缺省 → 旧式
    //    算出 keptIntent=true，白挡一步。
    // 读不到（unreadable）按「仍在」处理：失败关闭，不把不可读说成已收敛。
    let keptIntent = false
    try {
      keptIntent = (await readArchiveIntent(v3Root, String(sessionId))) !== null
    } catch {
      keptIntent = true
    }
    return { ...recovered, keptIntent }
  }

  async function backfillStateOf(sessionId) {
    const key = String(sessionId ?? '')
    const entry = runtimes.get(key)
    const running = backfillJobs.has(key)
    if (entry === undefined) return { running, state: null, error: null }
    try {
      return { running, state: await readBackfillState(entry.runtime.store.directory), error: null }
    } catch (error) {
      return { running, state: null, error: error?.code ?? error?.message ?? String(error) }
    }
  }

  /**
   * 建库（可 await 一次，也可由钩子后台触发）：宿主 seq 从 0 起，无库时断点初值 -1 才不漏
   * 首事件；有库时断点从已提交记录的来源事件 ID 反推（H-01：断点只活在内存里会让重载后全量重放）。
   * 同一会话并发调用共享同一个 Promise（不重复建库）。
   */
  function ensureEntry(session, sessionId) {
    let promise = pendingEntries.get(sessionId)
    if (promise !== undefined) return promise
    promise = (async () => {
      const runtime = await makeRuntime(session, sessionId)
      // H-57：建库在飞时被 dispose —— 不得把 runtime 塞回已清空的表里。
      // 旧实现无条件 runtimes.set：dispose 之后落定的建库任务会把 runtime 重新入表，
      // 它既不 close、也不再被任何路径使用（entryOf 只查表不建库），等于永久泄漏。
      // 注意检查点必须**在 await resumeCheckpointOf 之后**再来一次：断点反推是
      // O(记录数) 的磁盘活（H-19 起因），dispose 完全可能在这段窗口内发生。
      const discard = () => {
        try {
          const closing = runtime.close()
          if (closing !== null && closing !== undefined && typeof closing.then === 'function') closing.catch(() => {})
        } catch {}
        pendingEntries.delete(sessionId)
        throw new V3ContractViolation('v3 entry 在 dispose 之后完成建库，已丢弃')
      }
      if (disposed.value) discard()
      const checkpoint = await resumeCheckpointOf(runtime)
      if (disposed.value) discard()
      await ensureStateSnapshot(sessionId, checkpoint.lastSeq)
      if (runtime?.providerDecision !== undefined && typeof runtime.providerDecision?.tier === 'string') {
        try {
          await setState(sessionId, {
            provider: { tier: runtime.providerDecision.tier, reason: String(runtime.providerDecision.reason ?? '') },
          })
        } catch (error) {
          ctx.logger?.warn?.('memory-context-lab-v3: provider 决策落盘失败（继续按实际后端）：' + (error?.message ?? String(error)))
        }
      }
      if (disposed.value) discard()
      // 状态条需要「已摄入 N 条」（0.14.0-beta.15）。优先用端口的同步 recordCount()
      // （零 I/O、不读二十几 MB 索引）；旧端口/测试替身没有它时回落 health()。
      // 仍在**建库后台任务**里，不进 pre-step 热路径。读不到就记 null——
      // 「条数未知」必须与「0 条」区分开，不能把失败说成空库。
      let records = null
      try {
        const count = typeof runtime.store.recordCount === 'function'
          ? await runtime.store.recordCount()
          : (await runtime.store.health())?.recordCount
        if (Number.isInteger(count) && count >= 0) records = count
      } catch (error) {
        ctx.logger?.warn?.('memory-context-lab-v3: 记录计数不可读（状态条显示未知）：' + (error?.message ?? String(error)))
      }
      // 可检索数（P0，0.14.0-beta.38）：建库后台任务里读一次索引统计，供同步投影显示
      // 「已摄入 N · 可检索 M」。投影每事件都会读 statusOf，那里不能碰 22MB 索引；
      // 这里读不到就保持 null（未知），不把失败写成 0。
      let searchable = null
      try {
        const stats = await indexStatsOf({ runtime })
        if (stats.state === 'ok' && Number.isInteger(stats.indexedCount)) searchable = stats.indexedCount
      } catch (error) {
        ctx.logger?.warn?.('memory-context-lab-v3: 索引统计不可读（可检索显示未知）：' + (error?.message ?? String(error)))
      }
      // 归档段数（= 凭证数）：状态面板要显示「已归档 N 段」。与 records 同口径——
      // 只在建库/归档/对账这些**非逐事件**路径刷新，投影读的是缓存值（不碰磁盘）。
      let vouchers = null
      try {
        const list = runtime.store.listVouchers()
        if (Array.isArray(list)) vouchers = list.length
      } catch (error) {
        ctx.logger?.warn?.('memory-context-lab-v3: 凭证数不可读（面板显示未知）：' + (error?.message ?? String(error)))
      }
      const archive = runtime.store !== undefined && runtime.host !== undefined
        ? createArchiveService({
          random: runtime.random,
          store: runtime.store,
          host: runtime.host,
          clock: { now: () => Date.now() },
          // A-01（0.15.4）：恢复正文指纹要 sha256——application 层禁 node:crypto，
          // 由装配点注入（与摘要/提案同一先例）。缺失时该路径自动失败关闭。
          sha256: typeof runtime.hash?.sha256 === 'function' ? runtime.hash.sha256 : null,
          intent: {
            write: (data) => writeArchiveIntent(v3Root, sessionId, data),
            // R2-01：占槽 = 锁内重读校验后写入；槽位非空且身份不同即拒绝。
            reserve: (data) => reserveArchiveIntent(v3Root, sessionId, data),
            read: () => readArchiveIntent(v3Root, sessionId),
            // R3-02：清理按身份比对（intentId；旧格式载荷指纹），不匹配返回 conflict。
            clear: (expected) => clearArchiveIntentIfMatches(v3Root, sessionId, expected),
          },
        })
        : null
      // P4：摘要与提案服务。hash/clock 由 composition 注入（域层禁 node:crypto）；
      // 老测试替身缺端口时保持 null——工具与提案路径如实回报 unavailable，不影响归档。
      let summaries = null
      if (archive !== null && typeof runtime.hash?.sha256 === 'function' && typeof runtime.clock?.now === 'function') {
        summaries = createSummaryService({
          store: runtime.store,
          clock: runtime.clock,
          random: runtime.random,
          hash: runtime.hash,
          summaries: {
            append: (directory, artifact, options) => appendSummary(directory, artifact, options),
            list: (directory) => listSummaries(directory),
          },
        })
      }
      const compact = summaries === null ? null : createCompactService({
        proposals: {
          append: (directory, event, options) => appendProposalEvent(directory, event, options),
          read: (directory) => readProposals(directory),
        },
        summary: summaries,
        clock: runtime.clock,
        random: runtime.random,
        hash: runtime.hash,
      })
      let fileRefs = []
      let fileRefsError = null
      try {
        const ledger = await readFileReferences(runtime.store.directory)
        fileRefs = ledger.refs
      } catch (error) {
        fileRefsError = error?.message ?? String(error)
        ctx.logger?.warn?.('memory-context-lab-v3: file-references 不可读（文件核证失败关闭）：' + fileRefsError)
      }
      // P2-b：跨进程代际链的种子（账本最后一条带 surface 的行）。
      // 只恢复 epoch/指纹/消息链；逐消息摘要不落盘，重启后的第一次比较只能靠链前缀，
      // 定不出 firstDivergence 时记 null（不猜）。
      let cacheProjection = null
      try {
        cacheProjection = await readCacheProjectionState(runtime.store.directory)
      } catch (error) {
        ctx.logger?.warn?.('memory-context-lab-v3: 投影种子不可读（本进程从无前值起算）：' + (error?.code ?? error?.message ?? String(error)))
      }
      const entry = {
        runtime,
        // G3 接线（G7）：观测行 lifecycle 的会话键来源（隔离根按它派生，写进账本的是摘要不是原文）。
        sessionId,
        lastSeq: checkpoint.lastSeq,
        records,
        // 已归档段数（凭证数）——面板「已归档 N 段」的唯一来源，只在写路径刷新。
        vouchers,
        // AUD50-02-03（B2-1）：摄入拒绝计数（正文提取失败 + store 校验拒绝）。
        // 只增不清（进程生命周期内累计）；重放同批因断点已推进不会重复计数。
        rejectedEvents: 0,
        // B3-4：已告警过的坏 seq（内存去重，warn 一次不逐步刷屏）；不持久化——重启后
        // 最多再 warn 一次，断点语义不受影响。
        badSeqs: new Set(),
        // P2-a：观测账本失败告警的限流时间（每会话 5 分钟一次；只含错误码，不含正文）
        observationWarnAt: 0,
        // P2-b：上一次**已落账**观测的投影前值（epoch/指纹/摘要链），下一次比较只用它。
        // null = 本进程与账本都没有前值 → 首次观测 phase=initial（epoch 0）。
        cacheProjection,
        // P2-b：pre-step 局部投影快照（按 turn:step 存，最多 8 条；摄入是异步的）。
        pendingSurfaces: new Map(),
        // G3 接线（G7 集成批）：生命周期关联的**进程内**游标（turn:step → {attempt, used, maxAttemptSeen}）。
        // 真实宿主不提供 attempt 号（P0 §2.9），attempt 只能由本进程按「该 turn:step 被第几次
        // pre-step 开启」推导；去重键 (session, turn, step, attempt) 的会话段由「每会话一份游标 +
        // 每会话一个观测账本目录」共同保证。上界与 pendingSurfaces 同口径（8 条）。
        attemptCursors: new Map(),
        // G5 接线（G7）：可解释请求序号（一次真实 pre-step = 一次真实请求；重试 = 新请求 = +1）
        // 与调度策略状态 {contractVersion, attemptOrdinal, lastCommit}。
        // 二者都**不落盘**：重启/空闲淘汰即归零（= 基线重置，最多多调度一次，安全方向）。
        requestOrdinal: 0,
        policyState: null,
        // P2-b：逐消息摘要缓存（宿主 deriveMessages 返回共享的冻结 message 对象）。
        messageDigestCache: new WeakMap(),
        // AUD50-04-01（B2-7）：最近使用时刻（淘汰判据）；所有取用路径都要 touch。
        lastUsedAt: Date.now(),
        inflight: null,
        // B-1 归档单飞闸：本进程内同一会话同时只跑一个归档（archiveForStep 写，finally 清）。
        archiveInflight: null,
        seqToRecordId: checkpoint.seqToRecordId,
        // 按步归档的「判负跳过」游标（0.14.0-beta.46；P3-04 起带失效条件）：
        // 只跳过净收益为负的 span，不是持久化位点——进程重建后归零，最多重扫一次判负队头。
        // 形状为 { cursor, settingsKey, at }（见 notWorthCursorStart）；-1 = 从没判负过。
        notWorthThroughSeq: -1,
        // 按轮归档的同一游标（回合级 span 与按步 span 不共享：判负结论不可跨模式复用）。
        notWorthThroughSeqTurn: -1,
        // 按轮归档切到「DSH 轮次」判定时的独立游标（0.14.0-beta.47）：
        // 真人回合的判负结论不能拿来跳过别的分组口径，否则切换后静默不归档。
        notWorthThroughSeqTurnDsh: -1,
        searchable,
        archive,
        summaries,
        compact,
        // P4：本插件管理工具的 callId（摄入期把对应 tool/call 与 tool/result 标成 metaOnly）。
        // 跨重启由 render 首行标记兜底（OWN_TOOL_RESULT_MARKER），不依赖内存表。
        ownToolCallIds: new Set(),
        cwd: session?.header?.cwd ?? session?.cwd ?? null,
        fileRefs,
        fileRefsError,
      }
      runtimes.set(sessionId, entry)
      pendingEntries.delete(sessionId)
      evictIdleRuntimes() // B2-7：新 runtime 入表后执行一次存量上限扫描
      // P8：派生 chunk 索引损坏/换代时安排后台重建（建库任务内，不进 pre-step 热路径）。
      // 失败只告警：窗口回退现扫，检索与恢复语义不变。
      try {
        await repairDerivedChunkIndex(entry)
      } catch (error) {
        ctx.logger?.warn?.('memory-context-lab-v3: chunk 索引体检失败（窗口回退现扫）：' + (error?.message ?? String(error)))
      }
      if (archive !== null) {
        try {
          await recoverArchiveIntent(entry, sessionId)
        } catch (error) {
          ctx.logger?.warn?.('memory-context-lab-v3: 归档意图对账失败（保留 intent）：' + (error?.message ?? String(error)))
        }
      }
      return entry
    })()
    promise.catch(() => { pendingEntries.delete(sessionId) })
    pendingEntries.set(sessionId, promise)
    return promise
  }

  /**
   * 小增量后的延迟后台重建（防抖）。回注路径禁止重建（O(N) 全量活不得进 pre-step），
   * 但索引必须能在下一回合前追上，否则检索面会越来越旧。
   */
  const INDEX_REBUILD_DELAY_MS = 1500
  const rebuildTimers = new Map() // entry → timer

  /**
   * 索引文件是否**尚不存在**（与「陈化」是两种事实）。
   *
   * 陈化可以等防抖——旧索引仍可用，只是不含最新几条。**不存在则完全没得检索**：
   * 回注热路径已禁止重建（见 t1-provider 的 allowRebuild 分支），若不在摄入侧补上，
   * 新会话的头几步（用户刚发第一条消息、模型刚回第一个回合）必然回 skipped，
   * 首屏回注永远拿不到东西。这里仍在**后台摄入任务**里，不进 pre-step 钩子，
   * 因此不阻塞首字，只是把「首次可检索」提前到第一次摄入完成时。
   *
   * @returns {Promise<boolean>} 读戳失败按「不存在」处理（重建一次无害；失败另有告警）
   */
  async function isIndexAbsent(entry) {
    try {
      const { indexStampOf } = await import('../adapters/storage/lexical-index.mjs')
      return (await indexStampOf(entry.runtime.store)) === 'absent'
    } catch {
      return true
    }
  }

  /**
   * P8（2026-11-01）：派生 chunk 索引损坏/换代的自愈入口。
   *
   * 修前「损坏派生索引可后台重建」只对词法索引成立：chunk 索引损坏时读取侧永远回退现扫
   * （窗口能力下降，检索本身不失败），却没有任何维护点会重写它——只能等下一次 ≥INGEST_BATCH
   * 的批量摄入。这里在**建库后台任务**（不在 pre-step 热路径）判一次：
   * - 缺失（首次建库）：交给摄入路径创建，不算损坏；
   * - 损坏/换代/不可读：安排既有防抖重建（O(N) 活留给后台），重建后读取侧自然回到 ok；
   * - 重建失败仍回退现扫，不改变任何恢复语义（chunk 只是窗口选择，不是恢复真源）。
   *
   * @returns {Promise<'ok'|'absent'|'corrupt'|'incompatible'|'unreadable'>}
   */
  async function repairDerivedChunkIndex(entry) {
    let state = 'ok'
    try {
      const index = await readChunkIndex(entry.runtime.store)
      if (index === null) return 'absent'
      if (!isChunkIndexCompatible(index)) state = 'incompatible'
    } catch (error) {
      state = error?.code === 'ESTORE_CORRUPT' ? 'corrupt' : 'unreadable'
    }
    if (state === 'ok') return 'ok'
    metricsNote('v3.index.chunk.' + state)
    ctx.logger?.warn?.('memory-context-lab-v3: chunk 索引不可用（' + state + '），已安排后台重建；窗口暂回退现扫')
    scheduleIndexRebuild(entry)
    return state
  }

  /**
   * M-04（0.15.4，P1）：把本次摄入的记录**增量**并入词法索引。
   *
   * 返回 `true` 表示增量已落盘（调用方不必再全量重建）；`false` 表示不可信，
   * 调用方应退回 `rebuildIndex()`。**永不抛**——索引是派生物，不得挡权威链路；
   * 失败只记日志，检索面按既有 stale 语义降级。
   *
   * 为什么能增量：记录提交后不可变，本路径只新增；增量原语内部还会复核
   * `sourceCount`/`forgottenCount` 基线，不符即 `applied:false`（不猜）。
   */
  async function applyIncrementalIndex(entry, recordIds) {
    if (disposed.value) return false
    if (!Array.isArray(recordIds) || recordIds.length === 0) return false
    const incremental = entry.runtime?.store?.updateIndexIncrementally
    if (typeof incremental !== 'function') return false
    try {
      // 正文口径与全量重建同源：`record.payload.text`，空正文（metaOnly）不进索引。
      const added = []
      for (const id of recordIds) {
        const record = await entry.runtime.store.readRecord(id)
        const text = record?.payload?.text
        if (typeof text === 'string' && text.length > 0) added.push({ id, text })
      }
      if (added.length === 0) {
        // 本批全是 metadata-only：索引无需变化，但**基线也没变**，不算失败。
        return true
      }
      const result = await incremental.call(entry.runtime.store, { added })
      if (result?.applied !== true) return false
      await refreshSearchable(entry)
      return true
    } catch (error) {
      ctx.logger?.warn?.('memory-context-lab-v3: 增量索引失败（退回全量重建）：' + (error?.message ?? String(error)))
      return false
    }
  }

  function scheduleIndexRebuild(entry) {
    if (disposed.value || rebuildTimers.has(entry)) return
    const timer = setTimeout(() => {
      rebuildTimers.delete(entry)
      if (disposed.value) return
      const rebuild = entry.runtime?.store?.rebuildIndex
      if (typeof rebuild !== 'function') return
      Promise.resolve(rebuild.call(entry.runtime.store))
        .then(() => refreshSearchable(entry))
        .catch((error) => ctx.logger?.warn?.('memory-context-lab-v3: 后台索引重建失败（检索回退旧索引）：' + (error?.message ?? String(error))))
    }, INDEX_REBUILD_DELAY_MS)
    timer.unref?.()
    rebuildTimers.set(entry, timer)
  }

  /** 后台摄入（单飞行防重入；新事件由下一次 pre-step 续传）。 */
  function startIngest(entry, session) {
    if (disposed.value || entry.inflight !== null) return
    const log = Array.isArray(session?.log) ? session.log : (typeof session?.events === 'function' ? session.events() : null)
    if (log === null) return
    entry.inflight = ingestAll(entry, log)
      .catch((error) => ctx.logger?.warn?.('memory-context-lab-v3: 摄入任务异常：' + (error?.message ?? String(error))))
      .finally(() => { entry.inflight = null })
  }

  /** 观察面/检索面等待建库完成（这些是命令路径，不在首字热路径上）。 */
  async function entryOf(sessionId) {
    const ready = runtimes.get(String(sessionId ?? ''))
    if (ready !== undefined) {
      ready.lastUsedAt = Date.now() // B2-7：命令/回注路径取用即视为活跃
      return ready
    }
    const pending = pendingEntries.get(String(sessionId ?? ''))
    if (pending === undefined) return null
    try { return await pending } catch { return null }
  }

  const bodyOf = (raw) => extractEventBody(raw)
  function metricsNote(name) { entryMetrics.set(name, (entryMetrics.get(name) ?? 0) + 1) }

  /** pre-step 快照槽上限：摄入是后台异步的，槽位太小会让配对退化（surface=null），
   * 但设得再大也只是给**本进程**多留几步；超过窗口就丢弃，绝不把上一步的指纹安到这一步。 */
  const PENDING_SURFACE_LIMIT = 8

  /**
   * G3 接线（G7 集成批）：(turn, step) 的 attempt 游标（**进程内**、与 pendingSurfaces 同界 8 条）。
   *
   * - `attempt`：该 turn:step 被第几次真实请求（pre-step）开启过——重试是新 attempt（G3 §4.2）；
   * - `maxAttemptSeen`：同一 (turn, step) 组内已见的最大 attempt（**严格按 turn:step 分组**，
   *   绝不跨步比较，否则后开步的 attempt 1 会被误判成迟到）；
   * - `used`：该 attempt 是否已产出过 usage 行（去重键 (session,turn,step,attempt) 的 duplicate 判据；
   *   会话段由「每会话一份游标 + 每会话一个观测账本目录」保证）。
   *
   * 上界只丢最旧的 turn:step 游标：丢掉之后该组退回 attempt 未知（lifecycle unpaired），
   * 方向是「不猜」而不是编造关联。
   */
  function attemptCursorOf(entry, pairKey) {
    let cursor = entry.attemptCursors.get(pairKey)
    if (cursor === undefined) {
      cursor = { attempt: 0, maxAttemptSeen: 0, used: new Set() }
      entry.attemptCursors.set(pairKey, cursor)
      if (entry.attemptCursors.size > PENDING_SURFACE_LIMIT) {
        const oldest = entry.attemptCursors.keys().next().value
        entry.attemptCursors.delete(oldest)
      }
    }
    return cursor
  }

  /**
   * P2-b：pre-step 局部投影快照（**只读、只留摘要**）。
   *
   * 宿主在 `agent/pre-step` 交出 `{messages: claimed, turn, step, signal}`（P0 §2.8/§2.9）。
   * 系统提示与工具 schema 的组装发生在随后 `step()` 内部（`systemPrompt.project` /
   * `buildRequest`），本钩子看不到——所以这里只能快照**插件可见的消息投影**
   * （`session.deriveMessages()`，与宿主 `buildRequest` 的 `boundaryMessages` 同源），
   * 覆盖度把 system/tools 标 unobservable。**不得**把这份局部面说成最终请求。
   *
   * 快照按 `turn:step` 暂存：usage 要等 `assistant/message` 摄入才到，不能在 pre-step 时就配。
   * 配不上（overwrite/超窗/非法 turn·step）→ 调用方 surface=null，不猜。
   */
  function capturePreStepSurface(entry, session, position) {
    try {
      const turn = position?.turn
      const step = position?.step
      if (!Number.isSafeInteger(turn) || turn < 0 || !Number.isSafeInteger(step) || step < 0) return
      if (typeof session?.deriveMessages !== 'function') return
      const messages = session.deriveMessages()
      if (!Array.isArray(messages)) return
      const digests = new Array(messages.length)
      for (let index = 0; index < messages.length; index += 1) {
        const message = messages[index]
        let digest
        if (message !== null && typeof message === 'object') {
          digest = entry.messageDigestCache.get(message)
          if (digest === undefined) {
            digest = messageDigestOf(message)
            entry.messageDigestCache.set(message, digest)
          }
        } else {
          digest = messageDigestOf(message)
        }
        digests[index] = digest
      }
      // G3 接线：同一 (turn,step) 的每次 pre-step 都是一个新 attempt（重试 = 新请求）。
      // attempt 随快照一起存：usage 到达时按「开启它的那次请求」归属，而不是按到达时刻。
      const pairKey = turn + ':' + step
      const cursor = attemptCursorOf(entry, pairKey)
      cursor.attempt += 1
      cursor.maxAttemptSeen = cursor.attempt
      entry.pendingSurfaces.set(pairKey, { turn, step, attempt: cursor.attempt, messages, digests, capturedAt: Date.now() })
      if (entry.pendingSurfaces.size > PENDING_SURFACE_LIMIT) {
        const oldest = entry.pendingSurfaces.keys().next().value
        entry.pendingSurfaces.delete(oldest)
      }
    } catch (error) {
      // 快照失败只让本条观测的 surface 记未知，不影响摄入/usage 通道
      ctx.logger?.warn?.('memory-context-lab-v3: pre-step 投影快照失败（surface 记未知）：' + (error?.code ?? error?.message ?? String(error)))
    }
  }

  /**
   * P2-a 缓存观测接线（0.15.0）——**独立于旧 usage 通道**。
   *
   * 为什么不能用 `body.usage` / `if (body.usage !== undefined)`：`usageOf` 是五字段白名单
   * 且要求 ≥2 个有效字段（entry L51），于是「只报一个字段」和「只报 cacheWriteTokens」
   * 的宿主样本会被旧条件直接挡掉。这里只看**原始** `raw.data.usage`，并交给合同归一。
   *
   * P2-b 增补（**请求/步骤配对**）：turn/step 直接取宿主 `assistant/message` 载荷
   * （P0 §2.9：宿主已给，不需要插件快照）；同一 `turn:step` 的 pre-step 快照存在时，
   * 才把投影指纹一并写进记录。配对不上或宿主没给 turn/step → `request/surface` 为 null
   * （未知就是未知，绝不拿别步的指纹或推算的 step 冒充）。
   *
   * 失败域：本函数从不抛出；账本失败只做**限流告警**（错误码，不含正文），
   * 不改变 `entry.lastSeq` / applied 计数 / 摄入断点。
   * `at` 取宿主事件时间（`at` 优先、其次 `time`，与 `adapters/host/dsh-host.mjs` 同源）；
   * 不合法或缺失一律 null——绝不用 `Date.now()` 伪造发生时间。
   */
  async function appendObservation(entry, raw) {
    if (raw === null || typeof raw !== 'object' || raw.type !== 'assistant/message') return
    if (!Number.isSafeInteger(raw.seq) || raw.seq < 0) return
    const normalized = normalizeUsageObservation(raw?.data?.usage)
    if (normalized.ok !== true) return // 缺/空/没有任何合法 token 值 → 不写、不告警
    const rawTime = Number.isFinite(raw?.at) ? raw.at : raw?.time
    const at = typeof rawTime === 'number' && Number.isFinite(rawTime) && rawTime >= 0 ? rawTime : null
    const data = raw?.data
    const turn = Number.isSafeInteger(data?.turn) && data.turn >= 0 ? data.turn : null
    const step = Number.isSafeInteger(data?.step) && data.step >= 0 ? data.step : null
    const source = data?.message?.source
    const pairKey = turn !== null && step !== null ? turn + ':' + step : null
    const pending = pairKey !== null ? (entry.pendingSurfaces.get(pairKey) ?? null) : null
    // 用掉即删：同一步的后续 assistant 事件（重试）不得复用上一份快照
    if (pairKey !== null) entry.pendingSurfaces.delete(pairKey)
    // G3 接线（G7 集成批）：生命周期关联（contracts/observation-lifecycle.mjs）。
    //
    // attempt 归属（真实宿主不提供 attempt 号，只能由本进程推导）：
    // ① 本次消费的 pre-step 快照携带的 attempt（= 开启这次响应的那次请求，最准）；
    // ② 否则取该 (turn,step) 游标的当前 attempt（快照被重试覆盖/超窗淘汰后的保守归属）；
    // ② 的代价已登记：被重试覆盖**之后**才到达的旧 attempt 样本会被归到新 attempt
    // （多计 ≤1 份/次重试，方向=多计），由 one-sample-per-attempt 与 maxAttemptSeen 兜住。
    // 两者都没有 → attempt=null：lifecycle.correlation=unpaired(attempt-missing)，不猜关联。
    const cursor = pairKey !== null ? (entry.attemptCursors.get(pairKey) ?? null) : null
    let attempt = Number.isSafeInteger(pending?.attempt) && pending.attempt >= 1 ? pending.attempt : null
    if (attempt === null && Number.isSafeInteger(cursor?.attempt) && cursor.attempt >= 1) attempt = cursor.attempt
    // duplicate = 同一 (session, turn, step, attempt) 是否已产出过 usage 行（流式重复 chunk 只认第一份）。
    const duplicate = cursor !== null && attempt !== null && cursor.used.has(attempt)
    if (attempt !== null && cursor !== null && duplicate === false) {
      cursor.used.add(attempt)
      if (attempt > cursor.maxAttemptSeen) cursor.maxAttemptSeen = attempt
      // used 只用来判重复，务必有界：同一 turn:step 的 attempt 数不可能无限（超界丢最旧）。
      if (cursor.used.size > PENDING_SURFACE_LIMIT) {
        const oldest = cursor.used.values().next().value
        cursor.used.delete(oldest)
      }
    }
    const input = {
      usage: normalized,
      at,
      request: { turn, step, provider: source?.provider, model: source?.model },
      // 生命周期段：只写本地诊断 ID（不落原始会话键）；attemptState=completed 表示
      // 「这条 usage 随一次已完成的 assistant 消息到达」——失败/取消的 attempt 没有 usage 行，
      // 因此本接线不需要（也无法）伪造 failed/cancelled。
      lifecycle: {
        sessionKey: entry.sessionId,
        attempt,
        attemptState: attempt === null ? 'unknown' : 'completed',
        arrival: {
          duplicate,
          maxAttemptSeen: cursor !== null && Number.isSafeInteger(cursor.maxAttemptSeen) ? cursor.maxAttemptSeen : null,
        },
      },
    }
    if (pending !== null) {
      input.surface = { messages: pending.messages }
      input.messageDigests = pending.digests
      input.surfaceCoverage = { system: false, tools: false }
      input.surfaceSnapshot = 'pre-step'
      input.previousSurface = entry.cacheProjection
    }
    let result
    try {
      result = await appendCacheObservation(entry.runtime.store.directory, raw.seq, input)
    } catch (error) {
      result = { ok: false, error: error?.code ?? error?.message ?? String(error) }
    }
    if (result?.ok === true) {
      // 只有**真正落账**的观测才推进前值：失败/跳过的行不得让内存 epoch 跑到账本前面。
      // 跳过（appended:false，seq 回退/重放）分支按设计不带 projection；这里再判一次
      // 是因为调用方不应依赖「适配器恰好没回传」这一隐含约定（P2-2）。
      if (result.appended !== false && result.projection !== null && result.projection !== undefined) {
        entry.cacheProjection = result.projection
      }
      return
    }
    // 限流 + 可见：错误码进日志，正文永不进；不因旁路失败中断摄入
    const now = Date.now()
    if (now - (entry.observationWarnAt ?? 0) < 5 * 60 * 1000) return
    entry.observationWarnAt = now
    metricsNote('v3.observation.failed')
    ctx.logger?.warn?.('memory-context-lab-v3: 缓存观测未落盘（不影响摄入）：' + String(result?.error ?? 'unknown'))
  }

  async function ingestBatch(entry, batch, firstSeq, batchState = { failedUpTo: -1 }, sink = null) {
    let applied = 0
    let rejected = 0
    let refsChanged = false
    // AUD50-02-03（B2-1）：正文提取逐事件 try/catch——坏事件（如缺 arguments 的 tool/call）
    // 记 rejected、断点推进到它自身、后续事件继续入库。旧实现 batch.map 在大 try 里
    // 一坏全批崩，断点永远停在同一处，摄入从此卡死（探针 AFTER_BAD.lastSeq=-1 不再前进）。
    const bodies = new Array(batch.length)
    const usable = []
    for (let index = 0; index < batch.length; index += 1) {
      const raw = batch[index]
      try {
        const body = bodyOf(raw)
        // P4：本插件管理工具自己的 call/result 标 metaOnly（可回读、不进检索），
        // 避免「搜索/读取结果又变成新记忆被召回」的管理循环。来源类别与原因都可见。
        bodies[index] = isOwnToolEvent(entry, raw, body.text)
          ? { ...body, metaOnly: true, reason: body.reason ?? 'own-tool-result', ownTool: true }
          : body
        usable.push(index)
      } catch (error) {
        rejected += 1
        entry.rejectedEvents += 1
        metricsNote('v3.ingest.rejected')
        // 断点推进保证幂等：重放同一批时该事件被 seq<=lastSeq 跳过，不重复计数/告警
        entry.lastSeq = raw.seq
        ctx.logger?.warn?.('memory-context-lab-v3: 事件正文提取失败已跳过 seq=' + raw.seq + '：' + (error?.message ?? String(error)))
      }
    }
    try {
      // 一批一笔事务（beta.11）：逐事件事务在回填时是 10+ 次 fs/条 + 每笔同步全量事务日志，
      // 实测 1500 条约 45 秒、5000 条约 8 分钟；这段时间 inflight 恒非空，回注被 busy 挡住。
      // 事务里只进正文提取成功的事件；store 层校验拒绝的事件单独标 rejected、不进事务
      // （processTurn.many 的既定语义），同批好事件照常提交。
      const results = usable.length > 0 ? await entry.runtime.handleDshEventBatch(usable.map((index) => ({
        event: batch[index],
        text: bodies[index].text,
        meta: { metaOnly: bodies[index].metaOnly === true, metaReason: bodies[index].reason ?? '', structure: bodies[index].structure ?? undefined },
      }))) : []
      for (let position = 0; position < usable.length; position += 1) {
        // dispose 落在批内：store 已 close，本批取消，断点停在上一批（下一批失败关闭并告警）
        if (disposed.value) break
        const index = usable[position]
        const raw = batch[index]
        const body = bodies[index]
        const result = results[position] ?? { status: 'not-memory-event' }
        try {
          if (body.metaOnly === true) metricsNote(body.ownTool === true ? 'v3.ingest.ownToolMetadataOnly' : 'v3.ingest.metadataOnly')
          if (body.usage !== undefined) await appendUsage(entry, raw, body.usage)
          // P2-a：独立观测（失败域与上一行隔离；不读 body.usage，不看 body.usage 条件）
          try { await appendObservation(entry, raw) } catch (error) {
            ctx.logger?.warn?.('memory-context-lab-v3: 观测接线异常（不影响摄入）seq=' + raw.seq + '：' + (error?.code ?? error?.message ?? String(error)))
          }
          // own-source 也推进断点：否则尾部注入事件每次重启都被重扫（断点语义不完整）
          // M-03：duplicate 同样推进——事件已入库，不推进就会每次重启重扫同一事件。
          if (result.status === 'applied' || result.status === 'rejected' || result.status === 'own-source' || result.status === 'duplicate') entry.lastSeq = raw.seq
          if (result.status === 'applied') {
            applied += 1
            // 只有真正提交的记录才计入「已摄入」；own-source / rejected / not-memory-event 不计。
            // records 为 null 表示建库时计数不可读，保持未知而不是从 0 重来。
            if (Number.isInteger(entry.records)) entry.records += 1
            if (typeof result.recordId === 'string' && result.recordId.length > 0) entry.seqToRecordId.set(raw.seq, result.recordId)
            // M-04：把本批**真正提交**的记录 ID 交给增量索引（不收集 = 老调用方行为不变）。
            // 只收 ID：正文由增量路径按 `record.payload.text` 现读，与全量重建的取值口径
            // 完全同源（不在这里另造一份「正文」判断，避免两处口径漂移）。
            if (sink !== null && typeof result.recordId === 'string' && result.recordId.length > 0) {
              sink.push(result.recordId)
            }
            if (raw?.type === 'tool/call' && typeof result.recordId === 'string' && entry.cwd !== null && entry.fileRefsError === null) {
              try {
                const ref = await captureFileReference({ event: raw, recordId: result.recordId, cwd: entry.cwd })
                if (ref !== null) {
                  const refIndex = entry.fileRefs.findIndex((item) => item.id === ref.id)
                  if (refIndex >= 0) entry.fileRefs[refIndex] = ref
                  else entry.fileRefs.push(ref)
                  if (entry.fileRefs.length > 500) entry.fileRefs = entry.fileRefs.slice(-500)
                  refsChanged = true
                }
              } catch (error) {
                ctx.logger?.warn?.('memory-context-lab-v3: 文件引用采集失败（不影响摄入）：' + (error?.message ?? String(error)))
              }
            }
          }
          if (result.status === 'own-source') metricsNote('v3.ingest.ownSourceSkipped')
          if (result.status === 'rejected') {
            rejected += 1
            entry.rejectedEvents += 1
            metricsNote('v3.ingest.rejected')
            ctx.logger?.warn?.('memory-context-lab-v3: 事件被拒绝 seq=' + raw.seq + '：' + (result.errors ?? []).join('；'))
          }
        } catch (error) {
          // 单事件后处理失败不拖垮整批：记录该提交的已提交，断点语义保持
          ctx.logger?.warn?.('memory-context-lab-v3: 事件后处理失败 seq=' + raw.seq + '：' + (error?.message ?? String(error)))
        }
      }
      if (refsChanged) {
        try {
          await writeFileReferences(entry.runtime.store.directory, entry.fileRefs)
        } catch (error) {
          ctx.logger?.warn?.('memory-context-lab-v3: file-references 写入失败（核证面暂不可用）：' + (error?.message ?? String(error)))
        }
      }
      ctx.logger?.info?.('memory-context-lab-v3: 摄入批完成（起 seq=' + firstSeq + '，' + applied + '/' + batch.length + ' 条'
        + (rejected > 0 ? '，拒绝 ' + rejected + ' 条' : '') + '）')
    } catch (error) {
      // 存储事务级失败（全有或全无）：断点停在已完成处，下一步续传（影子模式不干扰宿主）。
      // B3-4：失败批的 seq 上界回报给 ingestAll——本轮不得把非记忆事件推进到它之后。
      batchState.failedUpTo = Math.max(batchState.failedUpTo, batch[batch.length - 1]?.seq ?? -1)
      ctx.logger?.warn?.('memory-context-lab-v3: 影子摄入失败（seq 起 ' + firstSeq + '）：' + (error?.message ?? String(error)))
    }
    // 返回真正落库的条数：own-source / not-memory-event 不算「摄入」
    return applied
  }

  const off = ctx.on('agent/pre-step', async ({ agent, signal, turn, step }, next) => {
    const decision = await next()
    if (decision?.kind !== 'enter' || signal?.aborted) return decision
    if (disposed.value) return decision
    try {
      const session = agent?.session
      const sessionId = String(session?.id ?? '')
      if (!sessionId) return decision
      // 会话级总开关：停用时本对话不再摄入（已有记录/索引不动）。
      const control = controlOf(sessionId)
      if (control.enabled === false) return decision
      // 真实宿主：session.log 数组（dsh-session 源码核验 2026-10-24）；替身：events() 函数
      const log = Array.isArray(session?.log) ? session.log : (typeof session?.events === 'function' ? session.events() : null)
      if (log === null) return decision
      const entry = runtimes.get(sessionId)
      if (entry === undefined) {
        // 首次挂载：建库在后台跑，**本步不 await**（H-19：钩子必须毫秒级返回）。
        ensureEntry(session, sessionId)
          .then((created) => {
            entryFailures.delete(sessionId)
            startIngest(created, session)
          })
          .catch((error) => noteEntryFailure(sessionId, error))
        return decision
      }
      // 2026-10-25 事故修正：摄入**后台异步**执行（历史大会话回填实测 10 分钟），
      // 钩子立即返回 decision，绝不阻塞首字；单飞行防重入，新事件由下一次 pre-step 续传。
      entry.lastUsedAt = Date.now() // B2-7：活动会话不淘汰
      // G5 接线（G7，P3-6a）：可解释请求序号——**每次真实请求 +1**。位置刻意放在本钩子的
      // 一切早退（非 enter/已 abort/已 dispose/无会话/停用/无日志/建库中）之后：只有真正会
      // 走到请求面的那一次才推进，于是「请求间隔」等于真实请求数，重试/宿主重发同样 +1。
      entry.requestOrdinal = (Number.isSafeInteger(entry.requestOrdinal) ? entry.requestOrdinal : 0) + 1
      // P2-b：先留本步的局部投影快照（只算摘要、不写盘），usage 到达时按 turn/step 配对。
      // 建库中的第一步没有 entry（后台任务未完成）→ 该步 surface 记 null，不猜。
      capturePreStepSurface(entry, session, { turn, step })
      startIngest(entry, session)
    } catch (error) {
      ctx.logger?.warn?.('memory-context-lab-v3: 影子调度失败：' + (error?.message ?? String(error)))
    }
    return decision
  })

  /** 观察面（2026-10-25 开工授权）：只读；摄入进行中如实回 busy，不抢写锁。 */
  async function inspect(sessionId) {
    const entry = await entryOf(sessionId)
    if (!entry) return null
    let health = null
    try { health = await entry.runtime.store.health() } catch (error) {
      health = { healthy: false, damaged: true, error: error?.code ?? error?.message ?? String(error) }
    }
    // H-51：usage 读失败不得伪装成「没有样本」。旧实现 `.catch(() => null)` 让
    // 「聚合打挂」与「文件不存在」在观察面上完全同形——而这正是 H-48 能长期潜伏
    // 的原因（聚合抛 TypeError，观察面只显示 usage: null，health 照旧 healthy）。
    let usage = null
    let usageError = null
    try { usage = await usageSummary(entry) } catch (error) {
      usageError = error?.code ?? error?.message ?? String(error)
    }
    const rawControl = controlOf(sessionId)
    const control = {
      enabled: rawControl.enabled !== false,
      recall: rawControl.recall !== false,
      overrides: rawControl.overrides ?? {},
      error: rawControl.error ?? null,
    }
    // 覆盖事实（P0）：命令面异步路径，失败如实回 error，由 /memory-lab status 显示「未知」。
    let coverage = null
    let coverageError = null
    try {
      const facts = await coverageOf(entry)
      coverage = { records: facts.records, mirrored: facts.mirrored }
    } catch (error) {
      coverageError = error?.code ?? error?.message ?? String(error)
    }
    const searchable = await indexStatsOf(entry)
    return {
      lastSeq: entry.lastSeq,
      ingesting: entry.inflight !== null,
      health,
      usage,
      usageError,
      injection: injectionSnapshot(sessionId),
      control,
      records: Number.isInteger(entry.records) ? entry.records : null,
      rejectedEvents: entry.rejectedEvents,
      searchable,
      coverage,
      coverageError,
    }
  }

  /**
   * 同步状态（0.14.0-beta.15，composer 状态条的数据源）。
   *
   * 客户端读不到宿主进程里的对象；投影的 wire.view 需要一个**同步、绝不抛错**的读取器，
   * 否则每步都要等文件系统。I/O 事实（B3-9 目录闸门后）：一次 view 的 control+state
   * 共享 **1 次目录 stat**（同同步批次），缓存命中时 0 次文件 I/O；内容仍有 mtime:size
   * 逐文件戳校验兜底。其余走内存表：
   * - 已建库：lastSeq / records / ingesting / 本会话回注计数；
   * - 建库中：pending；
   * - 建库失败：failed + code（与 /memory-lab status 的失败关闭口径一致，不伪装成「尚未摄入」）；
   * - 未触发过：absent。
   *
   * 注意：这里**不**返回 health/usage（那两条要读盘，属于 /memory-lab status 的职责）。
   * @param {string} sessionId 会话 id
   * @returns {object} 固定形状的只读状态（未知字段用 null，不用 0 冒充实测值）
   */
  function statusOf(sessionId) {
    const key = String(sessionId ?? '')
    const injection = injectionOf(key)
    const rawControl = controlOf(key)
    const control = {
      enabled: rawControl.enabled !== false,
      recall: rawControl.recall !== false,
      overrides: rawControl.overrides ?? {},
      error: rawControl.error ?? null,
    }
    const engineState = stateOf(key)
    const lifecycle = {
      mode: engineState.mode,
      modeSource: engineState.modeSource,
      planFirst: engineState.planFirst === true,
      // 停用恢复是全局设置：投影必须报告当前生效值，不能报告建库时冻结的 state 值。
      autoRestore: settingsNow().autoRestore !== false,
      surface: {
        lastArchiveEndSeq: Number.isInteger(engineState.surface?.lastArchiveEndSeq) ? engineState.surface.lastArchiveEndSeq : -1,
        lastArchiveAt: Number.isFinite(engineState.surface?.lastArchiveAt) ? engineState.surface.lastArchiveAt : null,
      },
      cooling: {
        open: engineState.cooling?.open === true,
        lastOccupancy: typeof engineState.cooling?.lastOccupancy === 'number' ? engineState.cooling.lastOccupancy : null,
        lastRunAt: typeof engineState.cooling?.lastRunAt === 'number' ? engineState.cooling.lastRunAt : null,
        lastReason: typeof engineState.cooling?.lastReason === 'string' ? engineState.cooling.lastReason : null,
      },
      provider: {
        tier: engineState.provider?.tier === 'T2' ? 'T2' : 'T1',
        reason: typeof engineState.provider?.reason === 'string' ? engineState.provider.reason : null,
      },
      stateError: engineState.error ?? null,
    }
    const counts = {
      attempted: injection.attempted,
      injected: injection.injected,
      skipped: injection.skipped,
      failed: injection.failed,
      lastStatus: injection.lastStatus,
      lastReason: injection.lastReason,
      lastInjectedAt: injection.lastInjectedAt,
      lastErrorCode: injection.lastError?.code ?? null,
    }
    const entry = runtimes.get(key)
    if (entry !== undefined) {
      entry.lastUsedAt = Date.now() // B2-7：投影每事件都读，活动会话不淘汰
      return {
        state: 'ready',
        ingested: Number.isInteger(entry.records) ? entry.records : null,
        searchable: Number.isInteger(entry.searchable) ? entry.searchable : null,
        archived: Number.isInteger(entry.vouchers) ? entry.vouchers : null,
        lastSeq: Number.isInteger(entry.lastSeq) ? entry.lastSeq : null,
        ingesting: entry.inflight !== null,
        control,
        ...lifecycle,
        ...counts,
      }
    }
    const failure = entryFailures.get(key)
    if (failure !== undefined) {
      return {
        state: 'failed',
        ingested: null,
        searchable: null,
        lastSeq: null,
        ingesting: false,
        errorCode: failure.code,
        errorMessage: failure.message,
        control,
        ...lifecycle,
        ...counts,
      }
    }
    if (pendingEntries.has(key)) {
      return { state: 'pending', ingested: null, searchable: null, lastSeq: null, ingesting: true, control, ...lifecycle, ...counts }
    }
    return { state: 'absent', ingested: null, searchable: null, lastSeq: null, ingesting: false, control, ...lifecycle, ...counts }
  }

  /**
   * 固定工具专用只读面（P4）：检索（记录 + 摘要）/精确读取。
   * 与命令面 search/read 共用 provider/store，不额外落库、不改活动面。
   * 工具结果自身在摄入侧标 metaOnly（见 isOwnToolEvent），不会回灌检索。
   */
  // G2（C-M-04）：原来的 `cursorOffsetOf`（裸十进制偏移，任何非法值**返回 0**）已删除。
  // 读侧游标改由 `domain/readback/read-cursor.mjs` 铸造/解析：绑定对象 ID、对象版本、
  // 偏移单位与会话，非法/旧格式/换对象/内容已变都返回**具体错误码**而不是静默回第一页。

  /**
   * 检索后端的分页能力事实（G1 / C-G1-02、C-G1-10）。
   * - T1：本地词法索引全量打分 + 确定性排序（score 降序、同分 id 升序，见
   *   domain/retrieval/query.mjs 的 rankResults）→ **可穷尽枚举**，能给精确 total 与 cursor；
   * - T2：只有 top-k（本地 top-k + 外部 k 条），外部返回体没有 total/EOF（U4 已读
   *   adapters/retrieval/t2-isolated-provider.mjs 与 P5 合同核实）→ total=null、
   *   completeness=partial、has_more=null、不给 cursor（明确「不支持继续」）。
   * 只认 capabilities().tier（实际生效值），不认 providerDecision（期望值）。
   */
  function searchBackendOf(entry) {
    let capabilities = null
    try {
      capabilities = typeof entry?.runtime?.provider?.capabilities === 'function' ? entry.runtime.provider.capabilities() : null
    } catch {
      capabilities = null
    }
    const tier = typeof capabilities?.tier === 'string' ? capabilities.tier : 'unknown'
    return { tier, enumerable: tier === 'T1' }
  }

  /** 检索快照（索引代际）；不支持或读失败一律 null（失败关闭，不铸造游标）。 */
  async function searchSnapshotOf(entry) {
    const provider = entry?.runtime?.provider
    if (typeof provider?.retrievalSnapshot !== 'function') return null
    try {
      return await provider.retrievalSnapshot()
    } catch {
      return null
    }
  }

  /**
   * 记录 chunk 窗口（派生索引）。非 ok（absent/corrupt/incompatible/stale）或单记录
   * chunk 被硬顶截断时返回 null → selectExcerpt 现扫，**不误报「全文已展示」**（C-G1-08）。
   */
  async function chunkSpansOf(entry, recordId) {
    const provider = entry?.runtime?.provider
    if (typeof provider?.chunksOf !== 'function') return null
    try {
      const info = await provider.chunksOf(recordId)
      if (info?.state !== 'ok' || info.truncated === true) return null
      return Array.isArray(info.spans) && info.spans.length > 0 ? info.spans : null
    } catch {
      return null
    }
  }

  /** selectExcerpt 包装：选窗失败如实降级为空摘录 + truncated，不把异常当「没有命中」。 */
  function excerptOf(text, needle, chunkSpans) {
    try {
      return selectExcerpt(text, needle, {
        maxChars: SEARCH_EXCERPT_MAX_CHARS,
        maxSpans: SEARCH_EXCERPT_MAX_SPANS,
        contextChars: SEARCH_EXCERPT_CONTEXT_CHARS,
        chunkSpans,
      })
    } catch {
      return { text: '', spans: [], strategy: 'unavailable', truncated: true }
    }
  }

  /** 记录命中项：摘录窗口在**本地脱敏正文**（payload.text）上选，span 是码点半开区间。 */
  function searchRecordItemOf(entry, needle, record, chunkSpans) {
    const text = typeof record.payload?.text === 'string' ? record.payload.text : ''
    const hash = hashOf(entry)
    const selected = excerptOf(text, needle, chunkSpans)
    return {
      id: record.id,
      kind: typeof record.kind === 'string' ? record.kind : 'unknown',
      title: record.payload?.metaOnly === true ? '仅元数据' : null,
      excerpt: selected.text,
      source_hash: hash === null ? null : hash(recordHashMaterial(record)),
      text_hash: hash === null ? null : hash(text),
      excerpt_spans: selected.spans,
      excerpt_strategy: selected.strategy,
      excerpt_truncated: selected.truncated === true,
      excerpt_source: 'record-text',
    }
  }

  /** 摘要命中项：摘录基准是该摘要的 shortText（可用 memory_context_read detail=short 复核）。 */
  function searchSummaryItemOf(needle, item, hash) {
    const shortText = typeof item.excerpt === 'string' ? item.excerpt : ''
    const selected = excerptOf(shortText, needle, null)
    return {
      id: String(item.summaryId ?? ''),
      kind: 'summary',
      title: String(item.generator ?? 'unknown') + '/' + String(item.verification ?? 'unknown') + '（未验证草稿/确定性提取）',
      excerpt: selected.text,
      source_hash: null,
      text_hash: hash === null ? null : hash(shortText),
      excerpt_spans: selected.spans,
      excerpt_strategy: selected.strategy,
      excerpt_truncated: selected.truncated === true,
      excerpt_source: 'summary-short-text',
    }
  }

  /** T2 不可分页的原因码：把后端侧真实降级状态带出来，不笼统写「未知」。 */
  function t2ReasonOf(window) {
    const status = window?.providerStatus
    if (status === 'partial') return 't2-partial'
    if (status === 'failed') return 't2-failed'
    if (status === 'cancelled') return 't2-cancelled'
    if (status === 'unsupported') return 't2-unsupported'
    return 't2-no-exhaustion-signal'
  }

  async function toolSearch(sessionId, session, { query, scope = 'all', limit = 5, cursor = null } = {}) {
    const entry = await entryOf(sessionId)
    const effectiveScope = scope === 'records' || scope === 'summaries' || scope === 'all' ? scope : 'all'
    const empty = {
      status: 'ok',
      scope: effectiveScope,
      returned_count: 0,
      total_match_count: null,
      completeness: 'complete',
      reason: null,
      has_more: false,
      offset_unit: SEARCH_OFFSET_UNIT,
      excerpt_version: SEARCH_EXCERPT_VERSION,
      skipped_count: 0,
      next_cursor: null,
      items: [],
      error: null,
    }
    // 「这次没有给出可用结果」的统一信封：完整性是 unavailable（不是 partial=还有更多，
    // 也不是 complete=查全了）。游标被拒同样走这里——绝不静默回第一页（C-G1-05）。
    const refused = (status, reason, errorCode = reason) => ({
      ...empty,
      status,
      completeness: 'unavailable',
      reason,
      has_more: null,
      error: errorCode,
    })
    if (entry === null) return refused('disabled', 'not-ready')
    if (entry.inflight !== null) return refused('busy', 'ingesting')
    const needle = typeof query === 'string' ? query.trim() : ''
    if (needle.length === 0) return refused('rejected', 'empty-query')
    // P2-12：越界的 `limit` 必须**失败关闭**，不得静默夹取。
    // 夹取会让模型以为「拿到 10 条就是全部」，实际请求的 999 条被悄悄改成 10 条——
    // 这是「有界热上下文」上的失败开放（与 H-38 在 provider 层确立的口径不一致）。
    // 合法域：未指定 → 默认 5；整数 0..TOOL_SEARCH_MAX 原样生效。
    if (limit !== null && limit !== undefined) {
      if (!Number.isInteger(limit) || limit < 1 || limit > TOOL_SEARCH_MAX) {
        return refused('rejected', 'invalid-limit', 'invalid-limit')
      }
    }
    const bounded = Number.isInteger(limit) ? limit : 5
    const hash = hashOf(entry)
    const backend = searchBackendOf(entry)
    const recordsInScope = effectiveScope !== 'summaries'
    const summariesInScope = effectiveScope !== 'records'
    const cursorGiven = cursor !== null && cursor !== undefined
    /**
     * 分集合判定可穷尽性（P3-1 修复批）：
     * - records 依赖 provider 能力（T1 可枚举、T2 只有 top-k）；
     * - summaries 来自**本地 summary-store**（total 精确、顺序确定、与 T2 外部融合无关），
     *   因此恒可枚举——T2 会话里摘要超过一页也能翻页（旧实现用 tier 一刀切，摘要永远只给第一页）。
     * order id 必须与这个判定一致：T1 铸的 records cursor 拿到 T2 上续读仍要显式不匹配（C-G1-07/C-G1-10）。
     */
    const scopeEnumerable = effectiveScope === 'summaries' ? true : backend.enumerable
    const orderExpected = orderIdOf(effectiveScope, scopeEnumerable)
    let offsets = { records: 0, summaries: 0 }
    let cursorGeneration = null
    if (cursorGiven) {
      if (hash === null) return refused('rejected', SEARCH_CURSOR_ERRORS.invalid, 'cursor-hash-unavailable')
      const parsed = decodeSearchCursor(cursor, { hash })
      if (parsed.ok !== true) return refused('rejected', parsed.error)
      if (parsed.value.scope !== effectiveScope) return refused('rejected', SEARCH_CURSOR_ERRORS.scope)
      if (parsed.value.query !== queryDigestOf(hash, needle)) return refused('rejected', SEARCH_CURSOR_ERRORS.query)
      if (parsed.value.session !== sessionDigestOf(hash, sessionId)) return refused('rejected', SEARCH_CURSOR_ERRORS.session)
      if (parsed.value.order !== orderExpected) return refused('rejected', SEARCH_CURSOR_ERRORS.order)
      offsets = { records: parsed.value.recordsOffset, summaries: parsed.value.summariesOffset }
      cursorGeneration = parsed.value.generation
    }
    // —— 取窗口。records 取「偏移 + 本页额度」；summaries 取固定大窗口（服务端自身有上限），
    //    这样摘要代际摘要不受本页额度影响。**绝不拿窗口长度当 total**（F01 的根因）。
    let recordsWindow = null
    if (recordsInScope) {
      const wanted = backend.enumerable ? Math.min(SEARCH_PAGE_MAX_OFFSET, offsets.records + bounded) : bounded
      let result = null
      try {
        result = await entry.runtime.provider.search(needle, { limit: wanted })
      } catch (error) {
        return {
          ...empty,
          status: 'failed',
          completeness: 'failed',
          reason: 'search-failed',
          has_more: null,
          error: String(error?.code ?? error?.message ?? 'search-failed'),
        }
      }
      const display = Array.isArray(result?.display) ? result.display : []
      const matched = Number.isInteger(result?.matchedCount) ? result.matchedCount : null
      recordsWindow = {
        hits: display,
        // total 只认「可穷尽枚举 + 可信计数」；indexAbsent 时是未知，不是 0。
        total: backend.enumerable && result?.indexAbsent !== true && matched !== null ? matched : null,
        indexAbsent: result?.indexAbsent === true,
        providerStatus: typeof result?.status === 'string' ? result.status : null,
      }
    }
    let summaryWindow = null
    if (summariesInScope) {
      if (entry.summaries === null) {
        summaryWindow = { unavailable: 'summaries-unavailable' }
      } else {
        const wanted = scopeEnumerable ? SEARCH_PAGE_MAX_OFFSET : bounded
        try {
          const found = await entry.summaries.search({ entry, query: needle, limit: wanted })
          summaryWindow = found.ok === true
            ? { items: Array.isArray(found.items) ? found.items : [], total: Number.isInteger(found.total) ? found.total : null }
            : { unavailable: String(found.reason ?? 'summaries-unavailable') }
        } catch (error) {
          summaryWindow = { unavailable: String(error?.code ?? error?.message ?? 'summaries-failed') }
        }
      }
    }
    const recordsKnown = !recordsInScope || (recordsWindow !== null && recordsWindow.indexAbsent !== true && recordsWindow.total !== null)
    const summariesKnown = !summariesInScope || (summaryWindow !== null && summaryWindow.unavailable === undefined && summaryWindow.total !== null)
    // —— 快照代际（C-G1-05）：records 用索引文件戳（原子替换 → 戳变）；summaries 用
    //    「命中总数 + 可见窗口 id 序列」。两者之一变化 → 旧 cursor 显式 stale。
    const snapshot = recordsInScope ? await searchSnapshotOf(entry) : null
    const summaryIds = summaryWindow !== null && summaryWindow.unavailable === undefined
      ? summaryWindow.items.map((item) => String(item.summaryId ?? ''))
      : []
    const summaryDigest = hash === null
      ? null
      : String(hash('search-summary-page:' + String(summaryWindow?.total ?? 'null') + '|' + summaryIds.join(','))).slice(0, 16)
    const generationParts = []
    if (recordsInScope) generationParts.push('records=' + String(snapshot?.generation ?? 'absent'))
    if (summariesInScope) generationParts.push('summaries=' + String(summaryDigest ?? 'absent'))
    const generation = hash === null ? null : String(hash('search-generation:' + generationParts.join(';'))).slice(0, 16)
    const canPage = scopeEnumerable
      && recordsKnown
      && summariesKnown
      && (recordsInScope ? snapshot?.exhaustive === true && typeof snapshot?.generation === 'string' : true)
      && generation !== null
    if (cursorGeneration !== null && (generation === null || cursorGeneration !== generation)) {
      return refused('rejected', SEARCH_CURSOR_ERRORS.stale)
    }
    const recordsRemaining = recordsInScope && recordsWindow !== null && recordsWindow.total !== null
      ? Math.max(0, recordsWindow.total - offsets.records)
      : null
    /**
     * 摘要剩余额度必须按**实际可取窗口**收敛（P2-2 修复批）：
     * summary 服务单次只返回前缀窗口（capacity = items.length），offset 到窗口尾巴后
     * 再「按 total 算还有剩余」会让额度分给一个取不到东西的集合，于是本页 0 条、
     * has_more=true、cursor 原地踏步（自指死循环）。这里取 min(total-offset, capacity-offset)，
     * 封顶集合的额度自然让给另一边；若两边都推不动，下面的 no-progress 守卫兜底。
     */
    const summaryCapacity = summariesInScope && summaryWindow !== null && summaryWindow.unavailable === undefined
      ? summaryWindow.items.length
      : null
    const summariesRemaining = summariesInScope && summaryWindow !== null && summaryWindow.total !== null && summaryWindow.total !== undefined && summaryCapacity !== null
      ? Math.max(0, Math.min(summaryWindow.total - offsets.summaries, summaryCapacity - offsets.summaries))
      : null
    const slots = allocatePageSlots({
      scope: effectiveScope,
      limit: bounded,
      recordsOffset: offsets.records,
      summariesOffset: offsets.summaries,
      recordsRemaining,
      summariesRemaining,
    })
    const recordItems = []
    let skipped = 0
    let consumedRecords = 0
    if (recordsInScope && recordsWindow !== null) {
      const available = Math.max(0, recordsWindow.hits.length - offsets.records)
      consumedRecords = Math.min(slots.records, available)
      for (let index = 0; index < consumedRecords; index += 1) {
        const hit = recordsWindow.hits[offsets.records + index]
        const id = typeof hit?.id === 'string' ? hit.id : null
        let record = null
        if (id !== null) {
          try { record = await entry.runtime.store.readRecord(id) } catch { record = null }
        }
        if (record === null || typeof record !== 'object') {
          // 命中但正文读不出来（并发遗忘/删除）：计数并继续，不把整页判失败。
          skipped += 1
          continue
        }
        recordItems.push(searchRecordItemOf(entry, needle, record, await chunkSpansOf(entry, id)))
      }
    }
    const summaryItems = []
    let consumedSummaries = 0
    if (summariesInScope && summaryWindow !== null && summaryWindow.unavailable === undefined) {
      const available = Math.max(0, summaryWindow.items.length - offsets.summaries)
      consumedSummaries = Math.min(slots.summaries, available)
      for (let index = 0; index < consumedSummaries; index += 1) {
        const item = summaryWindow.items[offsets.summaries + index]
        if (typeof item?.summaryId !== 'string' || item.summaryId.length === 0) {
          skipped += 1
          continue
        }
        summaryItems.push(searchSummaryItemOf(needle, item, hash))
      }
    }
    // 确定性交织（C-G1-06）：records[i]、summaries[i] 交替、先 records；ID 空间不同，
    // 这里仍按 id 去重（重复 ID 不得在同一页出现两次）。
    const items = []
    const seenIds = new Set()
    const maxLen = Math.max(recordItems.length, summaryItems.length)
    for (let index = 0; index < maxLen; index += 1) {
      for (const item of [recordItems[index], summaryItems[index]]) {
        if (item === undefined || seenIds.has(item.id)) continue
        seenIds.add(item.id)
        items.push(item)
      }
    }
    const nextRecordsOffset = offsets.records + consumedRecords
    const nextSummariesOffset = offsets.summaries + consumedSummaries
    const recordsMore = recordsInScope && recordsWindow !== null && recordsWindow.total !== null
      ? nextRecordsOffset < recordsWindow.total
      : false
    const summariesMore = summariesInScope && summaryWindow !== null && summaryWindow.total !== null && summaryWindow.total !== undefined
      ? nextSummariesOffset < summaryWindow.total
      : false
    // 摘要服务单次只给固定前缀窗口：还有命中但窗口够不到 → 不能给「假的下一页」。
    const summariesCapped = summariesMore && summaryWindow !== null && nextSummariesOffset >= summaryWindow.items.length
    let hasMore = null
    let nextCursor = null
    let reason = null
    if (recordsInScope && recordsWindow?.indexAbsent === true) reason = 't1-index-not-ready'
    else if (summariesInScope && summaryWindow?.unavailable !== undefined) reason = summaryWindow.unavailable
    // 本页是否真的消费了至少一槽；没有推进就绝不能发 cursor（P2-2 自指死循环的兜底）。
    const progressed = nextRecordsOffset !== offsets.records || nextSummariesOffset !== offsets.summaries
    const summariesPageable = summariesMore && !summariesCapped
    if (canPage) {
      if ((recordsMore || summariesPageable) && progressed) {
        hasMore = true
        nextCursor = encodeSearchCursor({
          hash,
          sessionId,
          query: needle,
          scope: effectiveScope,
          generation,
          recordsOffset: nextRecordsOffset,
          summariesOffset: nextSummariesOffset,
        })
      } else if (recordsMore || summariesMore) {
        // 还有命中但没有可推进的额度（典型：摘要面封顶、records 已耗尽）：
        // 不给「下一页」假信号，也不声称已查全——has_more=null + 原因码。
        hasMore = null
        reason = 'summary-window-capped'
      } else {
        hasMore = false
      }
      if (summariesCapped) reason = 'summary-window-capped'
    } else if (reason === null) {
      reason = backend.tier === 'T2' ? t2ReasonOf(recordsWindow) : 'provider-not-enumerable'
    }
    if (skipped > 0 && reason === null) reason = 'some-hits-unreadable'
    let totalCount = 0
    let totalKnown = true
    if (recordsInScope) {
      if (recordsWindow === null || recordsWindow.total === null) totalKnown = false
      else totalCount += recordsWindow.total
    }
    if (summariesInScope) {
      if (summaryWindow === null || summaryWindow.total === null || summaryWindow.total === undefined) totalKnown = false
      else totalCount += summaryWindow.total
    }
    /**
     * P2-1（修复批）：complete 的合同语义是「该 scope 已穷尽，**且没有不可读命中被跳过**」。
     * 末页 skipped>0 时枚举确实已穷尽（has_more=false），但结果并不完整 → partial；
     * 否则同一页会同时出现「已查全」和「另有 N 条未列入」，与 schema/文档自相矛盾。
     */
    let completeness = hasMore === false && skipped === 0 ? 'complete' : 'partial'
    if (items.length === 0 && (reason === 't1-index-not-ready' || reason === 'summaries-unavailable')) completeness = 'unavailable'
    return {
      status: 'ok',
      scope: effectiveScope,
      returned_count: items.length,
      total_match_count: totalKnown ? totalCount : null,
      completeness,
      reason,
      has_more: hasMore,
      offset_unit: SEARCH_OFFSET_UNIT,
      excerpt_version: SEARCH_EXCERPT_VERSION,
      skipped_count: skipped,
      next_cursor: nextCursor,
      items,
      error: null,
    }
  }
  /**
   * 读取信封（G2）：成功 / 失败 / 隐藏 / 游标被拒都回**同一组字段**。
   *
   * 旧实现每个分支各写一份对象字面量，新增字段必然漏一处——漏字段会让宿主按
   * output.schema 校验失败，表现成「工具坏了」，而不是「这次读不可用」。
   * 字段语义见 contracts/tools.mjs 的 READ_TOOL_OUTPUT_SCHEMA 与 contracts/citations.mjs。
   */
  function readEnvelopeOf(overrides = {}) {
    return {
      status: 'disabled', id: '', type: 'unknown',
      source_hash: null, text_hash: null, text: null,
      truncated: false, next_cursor: null,
      offset_unit: READBACK_OFFSET_UNIT, cursor_version: READBACK_CURSOR_VERSION,
      object_version: null, object_version_kind: 'unknown',
      offset: 0, returned_chars: 0,
      visible: false, error: null,
      sources: [], related: [], evidence_refs: [],
      refs_total: 0, refs_truncated: false, refs_capped: false, next_refs_cursor: null,
      ...overrides,
    }
  }

  /** 调用/结果配对窗口（事件条数）：跨多步足够；窗口外如实报 unpaired，不猜。 */
  const READ_PAIR_WINDOW = 64

  /**
   * 记录侧逐跳核验（G2 / C-G2-06）：存在性 → 会话 → 遗忘代际 → 来源字节 hash。
   *
   * 每一跳都重来一遍：引用区里的 ID 可能来自旧回执/旧摘要，读取时状态早已变化；
   * 「当时可读」不等于「现在可读」。任何失败都返回状态而不是抛错，且**不返回正文**。
   */
  async function verifyRecordReference(entry, hash, recordId, expectedHash = null) {
    if (typeof recordId !== 'string' || recordId.length === 0) return { status: 'unreadable', hash: null, reason: 'record-id-missing' }
    if (hash === null) return { status: 'unknown', hash: null, reason: 'hash-unavailable' }
    let record
    try {
      record = await entry.runtime.store.readRecord(recordId)
    } catch (error) {
      if (error?.code === 'EFORGOTTEN') return { status: 'forgotten', hash: null, reason: 'record-forgotten' }
      if (error?.code === 'ESTORE_SESSION_MISMATCH') return { status: 'session-mismatch', hash: null, reason: 'session-mismatch' }
      if (error?.code === 'ERECORD_NOT_FOUND') return { status: 'missing', hash: null, reason: 'record-not-found' }
      if (error?.code === 'EINVALID_ID') return { status: 'unreadable', hash: null, reason: 'record-id-invalid' }
      return { status: 'unreadable', hash: null, reason: String(error?.code ?? 'record-read-failed') }
    }
    if (record === null || typeof record !== 'object' || record.id !== recordId) {
      return { status: 'missing', hash: null, reason: 'record-not-found' }
    }
    if (record.sessionKey !== entry.runtime.sessionKey) return { status: 'session-mismatch', hash: null, reason: 'session-mismatch' }
    const forgotten = new Set(typeof entry.runtime.store.listForgotten === 'function' ? entry.runtime.store.listForgotten() : [])
    if (forgotten.has(recordId)) return { status: 'forgotten', hash: null, reason: 'record-forgotten' }
    const actual = hash(recordHashMaterial(record))
    if (typeof expectedHash === 'string' && expectedHash.length > 0 && actual !== expectedHash) {
      return { status: 'hash-mismatch', hash: actual, reason: 'record-hash-changed' }
    }
    return { status: 'ok', hash: actual, reason: null }
  }

  /**
   * 摘要侧逐跳核验：对象存在 → 会话 → 可见性（来源集合 ∩ 遗忘集，与 read/list/export 同源）
   * → 工件指纹（C-G2-07 的第三种 hash）。
   */
  async function verifySummaryReference(entry, hash, summaryId, expectedHash = null) {
    if (isSummaryId(summaryId) !== true) return { status: 'unreadable', hash: null, reason: 'summary-id-invalid' }
    if (entry.summaries === null) return { status: 'unreadable', hash: null, reason: 'summaries-unavailable' }
    let read
    try {
      read = await entry.summaries.read({ entry, summaryId })
    } catch (error) {
      return { status: 'unreadable', hash: null, reason: String(error?.code ?? 'summary-read-failed') }
    }
    if (read.ok !== true) return { status: read.reason === 'summary-not-found' ? 'missing' : 'unreadable', hash: null, reason: read.reason }
    if (read.artifact.sessionKey !== entry.runtime.sessionKey) return { status: 'session-mismatch', hash: null, reason: 'session-mismatch' }
    let fingerprint = null
    try { fingerprint = entry.summaries.fingerprintOf(read.artifact) } catch { fingerprint = null }
    if (read.visibility?.visible !== true) return { status: 'hidden', hash: fingerprint, reason: read.visibility?.reason ?? 'hidden' }
    if (typeof expectedHash === 'string' && expectedHash.length > 0 && fingerprint !== null && fingerprint !== expectedHash) {
      return { status: 'hash-mismatch', hash: fingerprint, reason: 'summary-hash-changed' }
    }
    return { status: 'ok', hash: fingerprint, reason: null }
  }

  /**
   * 链 A 编目：记录 → 覆盖它的归档回执（凭 voucher，不凭序号猜）。
   *
   * 两条链在这里分开（C-G2-03）：voucher 里有 `summaryRef/summaryId` 才是**协作 compact**
   * 的段落摘要工件（relation 'segment-summary'）；普通自动归档只有回执正文里的内联短摘要
   * （summarizeRecords 的结果），**不产生**任何 summary 引用——不把内联摘要冒充成工件。
   */
  function voucherDescriptorRows(entry, recordId) {
    let vouchers
    try {
      vouchers = entry.runtime.store.listVouchers()
    } catch {
      return {
        receipts: [{ id: 'vouchers', kind: 'voucher', relation: 'archive-receipt', status: 'unreadable', detail: '凭证账本不可读：本条所属回执未知（未知 ≠ 没有回执）' }],
        summaries: [],
      }
    }
    const matched = []
    for (let index = 0; index < vouchers.length; index += 1) {
      const voucher = vouchers[index]
      if (!Array.isArray(voucher?.recordIds) || !voucher.recordIds.includes(recordId)) continue
      matched.push({ index: index + 1, voucher })
    }
    const bounded = matched.slice(-READ_REFS_LIMITS.receipts)
    const receipts = []
    const summaries = []
    for (const { index, voucher } of bounded) {
      const summaryId = typeof voucher?.summaryRef?.summaryId === 'string'
        ? voucher.summaryRef.summaryId
        : (isSummaryId(voucher?.summaryId) ? voucher.summaryId : null)
      const voucherId = typeof voucher?.voucherId === 'string' ? voucher.voucherId : 'v-' + String(voucher?.targetEventId ?? '?')
      const seq = Number.isInteger(voucher?.targetEventId) ? voucher.targetEventId : null
      const start = Number.isInteger(voucher?.startSeq) ? voucher.startSeq : null
      const end = Number.isInteger(voucher?.endSeq) ? voucher.endSeq : null
      const count = Array.isArray(voucher?.recordIds) ? voucher.recordIds.length : 0
      receipts.push({
        id: voucherId,
        kind: 'voucher',
        relation: 'archive-receipt',
        status: 'ok',
        seq,
        start_seq: start,
        end_seq: end,
        detail: '凭证第 ' + index + ' 张（回执 seq ' + (seq ?? '未知') + '；覆盖 seq ' + (start ?? '?') + '–' + (end ?? '?') + '，' + count + ' 条记录）'
          + (summaryId === null
            ? '；普通自动归档回执：没有 SummaryArtifact，只有回执内联短摘要'
            : '；该段有协作摘要工件 ' + summaryId + '（链 B）'),
      })
      if (summaryId !== null) {
        summaries.push({
          id: summaryId,
          kind: 'summary',
          relation: 'segment-summary',
          status: 'ok',
          detail: '该段落的 SummaryArtifact（协作 compact；不是回执正文）；expected hash 见凭证 summaryRef',
          expected_hash: typeof voucher?.summaryRef?.hash === 'string' ? voucher.summaryRef.hash : null,
        })
      }
    }
    if (matched.length > bounded.length) {
      receipts.push({
        id: 'vouchers',
        kind: 'voucher',
        relation: 'archive-receipt',
        status: 'unknown',
        detail: '另有 ' + (matched.length - bounded.length) + ' 张覆盖凭证未列出（单次上界 ' + READ_REFS_LIMITS.receipts + '）',
      })
    }
    return { receipts, summaries }
  }

  /**
   * 工具调用/结果配对（真实配对，不是「相邻序号」）。
   *
   * 事件形状只从 domain/archive/event-shape.mjs 的 callIdOf 取（唯一读取点，AUD-01）；
   * 只在 ±READ_PAIR_WINDOW 条事件内找同 callId 的另一半：相隔多步也能配上，
   * 窗口外找不到就如实报 unpaired（未完成对不等于没发生），绝不拿相邻记录冒充。
   *
   * 已知残余（F7，已登记未修）：`host.events()` 每次返回**整份**宿主事件表，本函数在
   * 其中线性找自己与配对项，是每次 toolRead 的 O(N)（N=会话事件数）。上下文无影响，
   * 但大会话的拷贝成本**未实测**；是否改成 seq 邻域切片或宿主编排索引，等 G8 真机量化。
   * 判据不变：只在有界窗口内做配对判定，绝不因性能改动放宽配对语义。
   */
  async function callPairDescriptorOf(entry, seq) {
    if (!Number.isInteger(seq)) return null
    if (typeof entry.runtime.host?.events !== 'function') {
      return { id: 'dsh-' + String(seq), kind: 'event', relation: 'call-pair', status: 'unknown', seq, detail: '宿主不提供事件流：调用配对未知（不是「没有配对」）' }
    }
    let events
    try {
      events = await entry.runtime.host.events()
    } catch {
      return { id: 'dsh-' + String(seq), kind: 'event', relation: 'call-pair', status: 'unreadable', seq, detail: '事件流不可读：调用配对未知' }
    }
    if (!Array.isArray(events)) return null
    const own = events.find((event) => event?.seq === seq) ?? null
    if (own === null) return null
    const callId = callIdOf(own)
    if (callId === null) return null
    const isResult = own.type === 'tool/result'
    const isCallSide = own.type === 'tool/call' || own.type === 'assistant/message'
    if (!isResult && !isCallSide) return null
    const from = seq - READ_PAIR_WINDOW
    const to = seq + READ_PAIR_WINDOW
    let paired = null
    for (const event of events) {
      if (!Number.isInteger(event?.seq) || event.seq < from || event.seq > to || event.seq === seq) continue
      if (callIdOf(event) !== callId) continue
      if (isResult ? event.type !== 'tool/call' : event.type !== 'tool/result') continue
      if (isResult ? event.seq > seq : event.seq < seq) continue
      if (paired === null) { paired = event; continue }
      if (isResult ? event.seq > paired.seq : event.seq < paired.seq) paired = event
    }
    const pairedRecordId = paired === null ? null : (entry.seqToRecordId.get(paired.seq) ?? null)
    if (paired === null) {
      return {
        id: callId,
        kind: 'event',
        relation: 'call-pair',
        status: 'unpaired',
        call_id: callId,
        seq,
        detail: (isResult ? '没有找到同 callId 的调用事件' : '没有找到同 callId 的结果事件')
          + '（±' + READ_PAIR_WINDOW + ' 条窗口内）；未完成对不等于没发生',
      }
    }
    return {
      id: pairedRecordId ?? ('dsh-' + String(paired.seq)),
      kind: pairedRecordId === null ? 'event' : 'record',
      relation: 'call-pair',
      status: 'ok',
      call_id: callId,
      seq: paired.seq,
      detail: (isResult ? '配对的调用' : '配对的结果') + '在 seq ' + paired.seq
        + (pairedRecordId === null ? '（该事件没有 v3 记录，不能按记录 ID 回读）' : ''),
    }
  }

  /**
   * 相邻记录（relation 'adjacent'）：**只**表示日志前后相邻。
   * 不推断因果、不推断从属；渲染文案自带「非因果」，测试断言该措辞。
   */
  function adjacentDescriptorRows(entry, seq) {
    if (!Number.isInteger(seq)) return []
    const rows = []
    for (const [label, neighbor] of [['上一条', seq - 1], ['下一条', seq + 1]]) {
      if (!Number.isInteger(neighbor) || neighbor < 0) continue
      const recordId = entry.seqToRecordId.get(neighbor) ?? null
      rows.push(recordId === null
        ? { id: 'dsh-' + String(neighbor), kind: 'event', relation: 'adjacent', status: 'unknown', seq: neighbor, detail: label + '相邻事件不是本会话记忆记录（仅日志相邻，非因果）' }
        : { id: recordId, kind: 'record', relation: 'adjacent', status: 'ok', seq: neighbor, detail: label + '相邻记录（仅日志相邻，非因果）' })
    }
    return rows
  }

  /** 记录侧引用编目（顺序确定：所属回执 → 段落摘要 → 调用配对 → 相邻）。 */
  async function recordReferenceDescriptors(entry, record) {
    const seq = seqOfDshEventId(record?.provenance?.sourceEventId)
    const vouchers = voucherDescriptorRows(entry, record.id)
    const rows = [...vouchers.receipts, ...vouchers.summaries]
    const pair = await callPairDescriptorOf(entry, seq)
    if (pair !== null) rows.push(pair)
    rows.push(...adjacentDescriptorRows(entry, seq))
    return rows
  }

  /**
   * 摘要侧引用编目（链 B：SummaryArtifact → 来源记录 / 证据 / 取代 / 基准）。
   *
   * 顺序固定：sources（工件里按 recordId 排序）→ evidenceRefs → supersedes → base。
   * 旧摘要没有 sources/evidenceRefs 时**不补造关系**：编目为空，render 明说「未知」。
   */
  function summaryReferenceDescriptors(artifact) {
    const rows = []
    const byId = new Map()
    for (const source of Array.isArray(artifact?.sources) ? artifact.sources : []) {
      if (typeof source?.recordId !== 'string' || source.recordId.length === 0) continue
      const expected = typeof source.hash === 'string' ? source.hash : null
      byId.set(source.recordId, expected)
      rows.push({ id: source.recordId, kind: 'record', relation: 'source', status: 'unknown', hash_kind: 'record-source', expected_hash: expected, detail: '摘要来源记录（核验后给出该记录字节 hash）' })
    }
    for (const ref of Array.isArray(artifact?.evidenceRefs) ? artifact.evidenceRefs : []) {
      if (typeof ref !== 'string' || ref.length === 0) continue
      rows.push({ id: ref, kind: 'record', relation: 'evidence', status: 'unknown', hash_kind: 'record-source', expected_hash: byId.get(ref) ?? null, detail: '被本条摘要当作证据引用（C-G2-02：证据必须在来源集合内）' })
    }
    // supersedes：不可变对象的派生关系。**只列一跳**，不沿链展开——环（A↔B）因此必然终止；
    // 自指（A→A）在写侧与读侧校验里就被拒绝（validateSummaryArtifact：supersedes 不得指向自身），
    // 走到这里的 supersedes 一定满足「非自指」，所以这里不需要额外的循环检测。
    const supersedes = typeof artifact?.supersedes === 'string' ? artifact.supersedes : null
    if (supersedes !== null) {
      rows.push({ id: supersedes, kind: 'summary', relation: 'supersedes', status: 'unknown', detail: '被本条摘要取代的旧摘要（不可变对象的派生关系；只展开一跳）' })
    }
    const base = typeof artifact?.baseSummaryId === 'string' ? artifact.baseSummaryId : null
    if (base !== null && base !== artifact.summaryId) {
      rows.push({ id: base, kind: 'summary', relation: 'base', status: 'unknown', detail: '派生基准摘要（baseSummaryId）' })
    }
    return rows
  }

  /** 对一页引用逐条核验（只核验**本页**：每次 read 的记录读次数有界，见 READ_REFS_LIMITS）。 */
  async function verifyReferenceDescriptor(entry, hash, descriptor) {
    const base = citationOf(descriptor)
    if (base.kind !== 'record' && base.kind !== 'summary') return base
    const verified = base.kind === 'record'
      ? await verifyRecordReference(entry, hash, base.id, descriptor?.expected_hash ?? null)
      : await verifySummaryReference(entry, hash, base.id, descriptor?.expected_hash ?? null)
    const hashKind = verified.hash === null ? 'none' : (base.kind === 'record' ? 'record-source' : 'summary-artifact')
    const reason = verified.reason
    return citationOf({
      ...base,
      status: verified.status,
      hash: verified.hash ?? base.hash,
      hash_kind: hashKind,
      detail: reason === null || verified.status === 'ok'
        ? base.detail
        : (base.detail === null ? '核验：' + reason : base.detail + '；核验：' + reason),
    })
  }

  /**
   * 组装一页读取结果（正文页 + 引用页；G2 / C-G2-04）。
   *
   * 两条分页**共用**同一套版本化游标：正文游标（page='object'，偏移=码点）、
   * 引用游标（page='refs'，偏移=引用序号）。摘要 detail 续读与引用续读因此不是两套语义，
   * 而是同一套判据（对象 ID + 对象版本 + 单位 + 会话 + 校验和）的两个偏移空间。
   * 游标被拒时返回**具体错误码**，且不返回任何一页内容（不静默回第一页）。
   *
   * 已知残余（F6，已登记未修）：引用游标绑定的是**对象**版本，不是**引用目录**指纹。
   * 记录侧的引用目录还依赖 voucher 账本与宿主事件流（相邻/配对）；若两次 refs 续读之间
   * 该记录的覆盖凭证变多（restore 后重归档）或事件流改变，目录会变而游标仍然有效 →
   * 页间可能重复或漏条且**不报错**。现实概率低（摘要工件不可变；记录正常只被一张凭证
   * 覆盖；adjacent 只依赖 seq）。彻底修法 = 把目录指纹纳入 refs 游标绑定（届时游标
   * 版本 +1）；本轮按 §8 的上界口径登记为残余，不静默宣称已覆盖。
   */
  async function readPageOf({ entry, sessionId, id, type, text, sourceHash, objectVersion, objectVersionKind, detail = 'auto', textSelector = null, hash, cursor, offset, pageLength, refsCursor, refsLimit, descriptors }) {
    const chars = [...text]
    const total = chars.length
    // P2-09：`detail`（short/full）决定返回**哪一套正文**，是游标的绑定维度之一。
    // 旧实现只绑「对象版本」：同一个 cursor 在 short 铸出、拿到 full 上照样通过校验，
    // 于是偏移量被套到另一套正文字典上——错读而不报错（截断位置、甚至读到另一段）。
    // 现在把 detail 并进版本材料：换 detail ⇒ 版本摘要不同 ⇒ `read-cursor-object-changed`，
    // 失败关闭；不带 detail 的旧游标同样失配（同样失败关闭，不会静默沿用）。
    // R23（QC 复核误杀）：绑定维度必须是**真正决定正文的那一维**，不是入参原样。
    // 记录侧正文与 detail 无关（short/full 返回同一段文本），摘要侧 auto ≡ full
    // （见 toolRead：只有 detail==='short' 才切 shortText）。若按入参原样绑定，
    // 「省略 detail 铸游标 → 续读时显式写 full」这种**同正文**的续读会被误判成换对象。
    // 因此这里由调用方传入已解析的 textSelector（摘要：'short' | 'full'；记录：'record'）。
    const versionMaterial = (textSelector === null || textSelector === undefined ? 'auto' : String(textSelector)) + '|' + String(objectVersion)
    const mint = (page, nextOffset) => {
      try {
        return encodeReadCursor({ hash, sessionId, id, page, objectVersion: versionMaterial, offset: nextOffset })
      } catch {
        return null // 失败关闭：绝不发一条未绑定对象/版本的假游标
      }
    }
    const refuse = (error) => readEnvelopeOf({
      status: 'rejected',
      id,
      type,
      source_hash: sourceHash,
      object_version: objectVersion,
      object_version_kind: objectVersionKind,
      visible: true,
      error,
    })
    const matchCursor = (parsed) => {
      if (parsed.value.object !== objectDigestOf(hash, id)) return READ_CURSOR_ERRORS.id
      if (parsed.value.session !== sessionDigestOfRead(hash, sessionId)) return READ_CURSOR_ERRORS.session
      if (parsed.value.version !== objectVersionDigestOf(hash, versionMaterial)) return READ_CURSOR_ERRORS.object
      return null
    }
    // —— 正文页：版本化游标优先，其次旧的 offset 参数（两者都给时游标为准，旧行为）——
    let start = 0
    if (typeof cursor === 'string' && cursor.length > 0) {
      const parsed = decodeReadCursor(cursor, { hash })
      if (parsed.ok !== true) return refuse(parsed.error)
      if (parsed.value.page !== 'object') return refuse(READ_CURSOR_ERRORS.invalid)
      const mismatch = matchCursor(parsed)
      if (mismatch !== null) return refuse(mismatch)
      start = parsed.value.offset
    } else if (offset > 0) {
      start = offset
    }
    if (start > total) start = total // 越过末尾：空页 + 没有更多（不猜、不跳页）
    const truncated = start + pageLength < total
    const pageText = chars.slice(start, start + pageLength).join('')
    const nextCursor = truncated ? mint('object', start + pageLength) : null
    // —— 引用页（与正文页独立分页；同样绑定对象版本）——
    const capped = capCitations(dedupeCitations(descriptors))
    let refsOffset = 0
    if (typeof refsCursor === 'string' && refsCursor.length > 0) {
      const parsed = decodeReadCursor(refsCursor, { hash })
      if (parsed.ok !== true) return refuse(parsed.error)
      if (parsed.value.page !== 'refs') return refuse(READ_CURSOR_ERRORS.invalid)
      const mismatch = matchCursor(parsed)
      if (mismatch !== null) return refuse(mismatch)
      refsOffset = parsed.value.offset
    }
    // P2-12：`refs_limit` 越界失败关闭（旧实现夹取到 pageMax，模型以为拿到了全部引用）。
    if (refsLimit !== null && refsLimit !== undefined && (!Number.isInteger(refsLimit) || refsLimit < 1 || refsLimit > READ_REFS_LIMITS.pageMax)) {
      return refuse('invalid-refs-limit')
    }
    const refsPage = paginateCitations(capped.items, {
      offset: refsOffset,
      pageSize: Number.isInteger(refsLimit) ? refsLimit : READ_REFS_LIMITS.page,
    })
    const verified = []
    for (const descriptor of refsPage.items) verified.push(await verifyReferenceDescriptor(entry, hash, descriptor))
    const split = splitCitationPage(verified)
    const nextRefsCursor = refsPage.nextOffset === null ? null : mint('refs', refsPage.nextOffset)
    return readEnvelopeOf({
      status: 'ok',
      id,
      type,
      source_hash: sourceHash,
      text_hash: hash === null ? null : hash(text),
      text: pageText,
      truncated,
      next_cursor: nextCursor,
      // P2-09：回显本次分页用的正文选择器，便于观察面确认游标绑定的是哪一套。
      detail: detail === null || detail === undefined ? 'auto' : String(detail),
      object_version: objectVersion,
      object_version_kind: objectVersionKind,
      offset: start,
      returned_chars: [...pageText].length,
      visible: true,
      error: truncated && nextCursor === null ? 'cursor-unavailable' : null,
      sources: split.sources,
      related: split.related,
      evidence_refs: split.evidence_refs,
      refs_total: refsPage.total,
      refs_truncated: refsPage.nextOffset !== null,
      refs_capped: capped.capped,
      next_refs_cursor: nextRefsCursor,
    })
  }

  /**
   * 固定工具 memory_context_read（P4 + G2 引用区与可靠回读）。
   *
   * G2 之前的两个缺口（F03 的直接表现）：
   * 1) 响应只有正文页，**没有下一跳引用**——回执给了记录 ID，读回之后链就断了；
   * 2) 读侧游标是裸十进制偏移（`cursorOffsetOf` 对任何非法值返回 0）：错误游标静默回
   *    第一页，换对象续读也不会报错（C-M-04）。
   *
   * 现在：正文分页与引用分页各有一条**版本化游标**（v1.*，绑定对象 ID/对象版本/单位/会话）；
   * 响应带 sources/related/evidence_refs 有界引用区（记录侧＝所属回执/段落摘要/调用配对/相邻，
   * 摘要侧＝来源/证据/取代/基准），每条逐跳重新核验；隐藏/失败对象一律不带引用区
   * （身份与来源元数据也可能是隐私面）。
   */
  async function toolRead(sessionId, id, { detail = 'auto', cursor = null, offset = 0, length = null, refsCursor = null, refsLimit = null } = {}) {
    const entry = await entryOf(sessionId)
    if (entry === null) return readEnvelopeOf({ status: 'disabled', id: String(id ?? ''), error: 'not-ready' })
    if (entry.inflight !== null) return readEnvelopeOf({ status: 'busy', id: String(id ?? ''), error: 'ingesting' })
    if (!Number.isInteger(offset) || offset < 0) {
      return readEnvelopeOf({ id: String(id ?? ''), type: isSummaryId(id) ? 'summary' : 'record', error: 'invalid-offset' })
    }
    const hash = hashOf(entry)
    const sessionKey = entry.runtime.sessionKey
    // P2-12：`length` 越界同样失败关闭（旧实现 `Math.min` 夹取，模型以为拿到了想要的页长）。
    if (length !== null && length !== undefined && (!Number.isInteger(length) || length < 1 || length > TOOL_READ_MAX_CHARS)) {
      return readEnvelopeOf({ id: String(id ?? ''), type: isSummaryId(id) ? 'summary' : 'record', error: 'invalid-length' })
    }
    const pageLength = Number.isInteger(length) ? length : TOOL_READ_MAX_CHARS
    if (isSummaryId(id)) {
      if (entry.summaries === null) return readEnvelopeOf({ status: 'disabled', id, type: 'summary', error: 'engine-unavailable' })
      let read
      try {
        read = await entry.summaries.read({ entry, summaryId: id })
      } catch (error) {
        return readEnvelopeOf({ status: 'failed', id, type: 'summary', error: String(error?.code ?? 'summary-read-failed') })
      }
      if (read.ok !== true) {
        return readEnvelopeOf({ status: read.reason === 'summary-not-found' ? 'not-found' : 'failed', id, type: 'summary', error: read.reason })
      }
      // 跨会话副本（导入/拷贝 summaries.jsonl）不得在这里泄露：会话键必须逐跳复核。
      if (read.artifact.sessionKey !== sessionKey) {
        return readEnvelopeOf({ status: 'hidden', id, type: 'summary', error: 'session-mismatch' })
      }
      if (read.visibility.visible !== true) {
        return readEnvelopeOf({ status: 'hidden', id, type: 'summary', error: read.visibility.reason })
      }
      const artifact = read.artifact
      // 摘要侧：只有 short 是可区分的正文选择器，其余（auto/full/省略）都走 artifact.detail。
      const textSelector = detail === 'short' ? 'short' : 'full'
      const text = textSelector === 'short' ? artifact.shortText : artifact.detail
      let objectVersion = null
      try { objectVersion = entry.summaries.fingerprintOf(artifact) } catch { objectVersion = null }
      return await readPageOf({
        entry, sessionId, id, type: 'summary', text,
        sourceHash: objectVersion,
        objectVersion,
        detail,
        textSelector,
        objectVersionKind: objectVersion === null ? 'unknown' : 'summary-artifact-hash',
        hash, cursor, offset, pageLength, refsCursor, refsLimit,
        descriptors: summaryReferenceDescriptors(artifact),
      })
    }
    let record
    try {
      record = await entry.runtime.store.readRecord(String(id))
    } catch (error) {
      const reason = error?.code === 'EFORGOTTEN' ? 'record-forgotten'
        : error?.code === 'ESTORE_SESSION_MISMATCH' ? 'session-mismatch'
          : error?.code === 'ERECORD_NOT_FOUND' ? 'record-not-found'
            : error?.code === 'EINVALID_ID' ? 'record-id-invalid' : 'record-read-failed'
      const status = reason === 'record-forgotten' || reason === 'session-mismatch'
        ? 'hidden'
        : (reason === 'record-not-found' ? 'not-found' : 'failed')
      return readEnvelopeOf({ status, id: String(id ?? ''), type: 'record', error: reason })
    }
    if (record === null || typeof record !== 'object') {
      return readEnvelopeOf({ status: 'not-found', id: String(id ?? ''), type: 'record', error: 'record-not-found' })
    }
    if (record.sessionKey !== sessionKey) {
      return readEnvelopeOf({ status: 'hidden', id: record.id, type: 'record', error: 'session-mismatch' })
    }
    const forgotten = new Set(typeof entry.runtime.store.listForgotten === 'function' ? entry.runtime.store.listForgotten() : [])
    if (forgotten.has(record.id)) {
      return readEnvelopeOf({ status: 'hidden', id: record.id, type: 'record', error: 'record-forgotten' })
    }
    const sourceHash = hash === null ? null : hash(recordHashMaterial(record))
    const text = typeof record.payload?.text === 'string' ? record.payload.text : ''
    return await readPageOf({
      entry, sessionId, id: record.id, type: 'record', text,
      sourceHash,
      objectVersion: sourceHash,
      detail,
      // 记录侧正文与 detail 无关（两套 detail 返回同一段文本），因此只绑一个常量选择器：
      // 不把「用户这次写了 full」当成换了对象（那是误杀，R23 已实测复现）。
      textSelector: 'record',
      objectVersionKind: sourceHash === null ? 'unknown' : 'record-source-hash',
      hash, cursor, offset, pageLength, refsCursor, refsLimit,
      descriptors: await recordReferenceDescriptors(entry, record),
    })
  }

  /** 工具执行时登记自己的 callId：摄入期据此把 call/result 标成 metaOnly（不回灌检索）。 */
  function noteOwnToolCall(sessionId, callId) {
    if (typeof callId !== 'string' || callId.length === 0) return { recorded: false }
    const entry = runtimes.get(String(sessionId ?? ''))
    if (entry === undefined) return { recorded: false }
    entry.ownToolCallIds.add(callId)
    return { recorded: true }
  }

  /**
   * 结果正文是否带本插件来源标记（P3-3）。真实宿主的 tool/result 文本常以换行/空白
   * 开头，严格 `startsWith` 会让「换行 + 标记」失效。判据：**首部若干字符内**去掉前导
   * 空白后以标记开头；不扫描全文，避免正文中偶然提到标记就被误判成管理结果。
   */
  const OWN_MARKER_SCAN_CHARS = 64

  function hasOwnToolMarker(text) {
    if (typeof text !== 'string' || text.length === 0) return false
    const head = text.slice(0, OWN_MARKER_SCAN_CHARS)
    return head.replace(/^\s+/u, '').startsWith(OWN_TOOL_RESULT_MARKER)
  }

  /** 是否本插件管理工具的事件（callId 表 + 结果首部标记双判据；跨重启也成立）。 */
  function isOwnToolEvent(entry, raw, text) {
    if (raw?.type === 'tool/call' && MEMORY_CONTEXT_TOOL_LIST.includes(raw?.data?.name)) {
      const callId = raw?.data?.callId
      if (typeof callId === 'string' && callId.length > 0) entry.ownToolCallIds.add(callId)
      return true
    }
    if (raw?.type === 'tool/result') {
      const message = raw?.data?.message ?? {}
      const callId = message?.source?.callId ?? message?.toolCallId ?? raw?.data?.callId
      if (typeof callId === 'string' && entry.ownToolCallIds.has(callId)) return true
      return hasOwnToolMarker(text)
    }
    return false
  }

  async function searchReadOnly(sessionId, query, opts = {}) {
    const entry = await entryOf(sessionId)
    if (!entry) return null
    if (entry.inflight !== null) return { busy: true }
    return await entry.runtime.provider.search(String(query), opts)
  }

  async function readReadOnly(sessionId, recordId) {
    const entry = await entryOf(sessionId)
    if (!entry) return null
    if (entry.inflight !== null) return { busy: true }
    const result = await entry.runtime.provider.read(String(recordId))
    await markReadLease(sessionId, [String(recordId)])
    return result
  }

  return {
    inspect,
    statusOf,
    diagnosticsOf,
    // G4：首次呈现外置候选句柄（装配可达、默认关闭、零激活）。诊断面只暴露状态与开关，
    // 不在 pre-step 里派发；真实入模时序留 G8。
    firstIngress: firstIngressCandidate,
    controlOf,
    setControl,
    stateOf,
    setState,
    archiveForStep,
    dryRunArchive,
    historyOf,
    restoreHistory,
    repairStore,
    pinRecords,
    forgetPreview,
    forgetRecords,
    listForgotten,
    workingSet,
    exportSession,
    // 问题 8（0.15.4，用户裁定 A+D）：残留统计只读、清理显式。
    // 两者必须同源（都由 adapters/storage/storage-residue 的同一趟扫描算出来），
    // 否则会出现「status 报 3 个、clean 删 5 个」这种自相矛盾的账。
    storageResidue: (sessionId) => scanResidue(v3Root, String(sessionId ?? '')),
    cleanStorage: (sessionId, options) => cleanResidue(v3Root, String(sessionId ?? ''), options),
    importSession,
    adoptFrom,
    setAdoptAllow,
    adoptStatus,
    fileStatus,
    verifyFiles,
    startT2Backfill,
    cancelT2Backfill,
    t2BackfillState: backfillStateOf,
    cleanupSmokeNode,
    /**
     * T2 隔离诊断（/memory-lab t2 用）：只报环境事实与实际决策，不返回令牌。
     * configured=false 表示未找到 dsh-memory/MDcg 环境；active=false 时 decision.reason
     * 就是真实的回落原因（探测失败/版本未实测/冒烟未过），不是「没试」。
     */
    async t2Info(sessionId) {
      const key = String(sessionId ?? '')
      const entry = runtimes.get(key)
      const base = {
        configured: options.t2Isolated !== undefined && options.t2Isolated !== null,
        repoRoot: options.t2Isolated?.repoRoot ?? null,
        python: options.t2Isolated?.python ?? null,
        version: options.t2Isolated?.version ?? null,
        active: entry?.runtime.providerDecision?.tier === 'T2',
        decision: entry?.runtime.providerDecision ?? null,
        isolatedRoot: entry === undefined ? null : t2RootOf(entry),
        mirror: typeof entry?.runtime.provider?.mirrorStats === 'function'
          ? entry.runtime.provider.mirrorStats()
          : null,
      }
      if (entry === undefined) {
        return { ...base, coverage: null, coverageError: null, backfill: await backfillStateOf(key) }
      }
      let coverage = null
      let coverageError = null
      try {
        const facts = await coverageOf(entry)
        coverage = { records: facts.records, mirrored: facts.mirrored }
      } catch (error) {
        coverageError = error?.code ?? error?.message ?? String(error)
      }
      return { ...base, coverage, coverageError, backfill: await backfillStateOf(key) }
    },
    failureOf(sessionId) {
      return entryFailures.get(String(sessionId ?? '')) ?? null
    },
    search: searchReadOnly,
    read: readReadOnly,
    // P4 固定工具面（工具定义在 entry/tools.mjs；这里只提供用例）。
    toolSearch,
    toolRead,
    inspectCompact,
    prepareCompact,
    submitCompact,
    compactStatus,
    noteOwnToolCall,
    /** 诊断：本会话已提交记录 ID（只读；metaOnly 也在内，测试用它验证「可回读但不进检索」）。 */
    async recordIdsOf(sessionId) {
      const entry = runtimes.get(String(sessionId ?? ''))
      if (entry === undefined) return { error: 'not-ready' }
      return { ids: await entry.runtime.store.listRecordIds() }
    },
    /** 只读摘要清单（测试/诊断用；隐藏项不带正文）。 */
    async summaryList(sessionId) {
      const entry = runtimes.get(String(sessionId ?? ''))
      if (entry === undefined) return { error: 'not-ready' }
      if (entry.summaries === null) return { error: 'engine-unavailable' }
      return await entry.summaries.list({ entry, limit: 50 })
    },
    /** B2-7 测试钩子：手动驱动一次淘汰扫描（now 可注入未来时刻测 TTL）。 */
    _evictNow: evictIdleRuntimes,
    /** P8 测试钩子：资源计数（计时器/在飞任务/常驻 runtime），生产不调用。 */
    _pendingResources() {
      return {
        rebuildTimers: rebuildTimers.size,
        backfills: backfillJobs.size,
        runtimes: runtimes.size,
        pendingEntries: pendingEntries.size,
      }
    },
    /** B2-7 测试钩子：把会话的 lastUsedAt 拨到指定时刻（构造「最久未用」排序）。 */
    _touchRuntime(sessionId, at) {
      const entry = runtimes.get(String(sessionId ?? ''))
      if (entry !== undefined) entry.lastUsedAt = at
    },
    /**
     * T-12 测试钩子：取会话 runtime 条目（生产不调用）。
     * 用于验证「在飞归档 / 在飞摄入」与淘汰判据的关系——这两件事必须能被
     * 同一个判据看见，否则归档跑到一半会被淘汰成 ESTORE_CLOSED。
     */
    _runtimeEntryForTest(sessionId) {
      return runtimes.get(String(sessionId ?? '')) ?? null
    },
    _runtimeLimits: runtimeLimits,
    dispose() {
      disposed.value = true
      clearInterval(evictTimer)
      // 在飞回填：置中断位（批间生效），不再等待；已写入的节点在磁盘上仍然幂等。
      for (const job of backfillJobs.values()) job.controller.aborted = true
      backfillJobs.clear()
      for (const timer of rebuildTimers.values()) clearTimeout(timer)
      rebuildTimers.clear()
      // P8：异步 close（T2 flush + 关子进程）改为可等待——dispose 返回 Promise，
      // 宿主 effect 可 await；同步调用方忽略返回值时行为不变（拒绝一律吞掉）。
      const closings = []
      for (const { runtime } of runtimes.values()) {
        try {
          const closing = runtime.close()
          if (closing !== null && closing !== undefined && typeof closing.then === 'function') {
            closings.push(closing.then(() => undefined, () => undefined))
          }
        } catch { /* 同步关闭失败不改变已释放的事实 */ }
      }
      runtimes.clear()
      // H-57：在飞建库也要作废——否则落定时会重新入表（见 ensureEntry 的 disposed 分支）
      pendingEntries.clear()
      if (typeof off === 'function') off()
      return Promise.allSettled(closings)
    },
    /**
     * 转正回注（beta.10）：走 composition.recall——每回合一次门、上界装包、失败关闭。
     *
     * 契约（beta.10 修复）：`recall` 用例的入参是**一个对象**且 `turn` 必填（≥1）。
     * 旧实现写成 `recall(String(query), opts)`——字符串被对象解构后 query 恒为
     * undefined，回注 100% 抛 V3ContractViolation，再被入口 catch 成一条 warn：
     * 功能 0 生效而观察面全绿。这里把 `{ query, turn }` 拼装收在入口这一层，
     * 并且**把每种结局都变成可判读的 status**，不再用 `null` / `busy:true` /
     * `injected:false` 三种形状让调用方猜。
     *
     * @returns {{status:'injected'|'skipped'|'busy'|'no-session'|'empty-query'|'invalid-turn'|'failed', ...}}
     */
    async recallForInjection(sessionId, query, opts = {}) {
      const injection = countersOf(sessionId)
      injection.attempted += 1
      // R04：这些「什么都没呈现」的早退**不再消耗**本回合唯一一次回注机会——
      // recall 用例只在真正装包成功时才 commit 租约。这里把原因记进
      // lastNotPresented，与「已呈现过（skipped）」在观察面分开。
      const notPresented = (status, reason) => {
        injection.skipped += 1
        injection.lastStatus = status
        injection.lastNotPresented = reason
        return { status, releaseReason: reason }
      }
      if (typeof query !== 'string' || query.trim().length === 0) {
        return notPresented('empty-query', 'empty-query')
      }
      const turn = opts?.turn
      if (!Number.isInteger(turn) || turn < 1) {
        // 宿主 turn 从 1 起（dsh-agent-loop 核验）；拿不到 turn 是调用方契约破坏，
        // 不是「本回合不注入」——如实记失败，不静默当作没命中。
        injection.failed += 1
        injection.lastStatus = 'invalid-turn'
        injection.lastError = { code: 'EINVALID_TURN', message: 'turn 必须是 ≥1 的整数（得到 ' + String(turn) + '）', at: Date.now() }
        return { status: 'invalid-turn', error: injection.lastError }
      }
      const entry = await entryOf(sessionId)
      if (!entry) return notPresented('no-session', 'no-session')
      if (entry.inflight !== null) return notPresented('busy', 'busy')
      // R04 入口租约：**取数之前**占位（防两个并发 pre-step 各注入一份），
      // 但占位本身不是成功——调用方（index.mjs 的 pre-step 钩子）只在真的把消息
      // 追加进 decision.messages 之后 commit；非 enter / 取消 / 未追加一律 release。
      // owner 令牌：只有**占位的那一次调用**能提交/释放它。并发第二路拿到 busy 之后
      // 如果顺手 release，会把第一路的占位撤掉（同回合又可能注入第二份）。
      reservationOwner += 1
      const owner = 'inj-' + reservationOwner
      const lease = injectionLeases.reserve(String(sessionId), turn, { owner })
      if (!lease.reserved) {
        if (lease.reason === 'committed') {
          injection.skipped += 1
          injection.lastStatus = 'skipped'
          injection.lastReason = '本回合已注入过同类回注（P3 命中只出现一步）'
          injection.lastNotPresented = 'already-presented'
          return { status: 'skipped', reason: injection.lastReason, releaseReason: 'already-presented' }
        }
        return notPresented('busy', 'concurrent-inflight')
      }
      let outcome
      try {
        // 热路径不重建索引：全量重建是 O(N) 次 readFile + 11MB 写，实测 200ms–2s，
        // 而这里就在 pre-step 的 awaited 路径上。索引陈化时用旧索引（历史检索不受影响），
        // 由摄入后的后台重建把新记录补进去。
        //
        // 检索参数来自设置页（回注条数/装包阈/首部长度/查询上限）。查询词按**码点**截断：
        // 用户贴一整篇日志当消息时，整条当查询会把覆盖门槛抬到「必须命中整句」。
        const queryMaxChars = Number.isInteger(opts?.queryMaxChars) && opts.queryMaxChars > 0 ? opts.queryMaxChars : null
        // P5：长查询保留首部与尾部（唯一错误码/路径常在尾部），不再只裁前缀。
        const boundedQuery = queryMaxChars === null ? query : boundQuery(query, queryMaxChars)
        // 两面阈值必须成对给：applyMinScore 的不变量是「装包面 ⊆ 结果面」
        // （packMinScore ≥ resultMinScore），而设置页只暴露装包阈且允许 0
        // （文案「0 表示不过滤」）。只透传 packMinScore 会让 0.05 / 0 这类**合法配置**
        // 每步都抛 V3ContractViolation，被记成 failed——功能整体失效而观察面只显示失败计数。
        // 因此结果面下限跟着用户设置一起降：用户说「不过滤」，两面都不过滤。
        const packMin = Number.isFinite(opts?.packMinScore) && opts.packMinScore >= 0 ? opts.packMinScore : null
        const staleRecordIds = new Set((entry.fileRefs ?? []).filter(isStaleFileReference).map((ref) => ref.recordId))
        outcome = await entry.runtime.recall({
          query: boundedQuery,
          turn,
          allowRebuild: false,
          ...(staleRecordIds.size > 0 ? { excludeRecordIds: staleRecordIds } : {}),
          ...(Number.isInteger(opts?.limit) && opts.limit >= 1 ? { limit: opts.limit } : {}),
          ...(packMin === null ? {} : { packMinScore: packMin, resultMinScore: Math.min(RECALL_RESULT_MIN_SCORE, packMin) }),
          ...(Number.isInteger(opts?.previewChars) && opts.previewChars >= 0 ? { previewChars: opts.previewChars } : {}),
        })
      } catch (error) {
        // 边界记录点，不是吞错：错误原样放进 outcome 返回，由入口限流告警 + status 暴露。
        // 回注失败不得打断用户这一回合（宿主契约：钩子抛错会中止本步）。
        // R04：用例内部已按 reserve/release 归还占位，这里只记账——同回合可以再试。
        injection.failed += 1
        injection.lastStatus = 'failed'
        injection.lastError = { code: error?.code ?? 'EINTERNAL', message: error?.message ?? String(error), at: Date.now() }
        injectionLeases.forget(String(sessionId), turn, { owner }) // 取数失败不得占着本回合（R04）
        return { status: 'failed', error: injection.lastError, releaseReason: 'search-failed', released: true, reservation: owner }
      }
      if (outcome?.injected === true && typeof outcome.text === 'string' && outcome.text.length > 0) {
        // **不在这里计数、不在这里加租约**（0.15.0 验收退回的第一个阻断）。
        // 走到这里只表示「装包成功、准备交给宿主」：宿主是否把它写成会话事件还没发生，
        // 更没有 JSONL 耐久。计数与读租约一律等到宿主 session/event 确认（observeSessionEvent）。
        const presentedIds = (outcome.presentedIds ?? (outcome.hits ?? []).map((hit) => hit.id)).filter((id) => typeof id === 'string')
        const bodyId = typeof outcome.bodyId === 'string' ? outcome.bodyId : null
        injection.lastStatus = 'pending-confirm'
        injection.lastHits = outcome.hits?.length ?? null
        injection.lastCandidates = Number.isInteger(outcome.displayedCandidates) ? outcome.displayedCandidates : null
        return {
          status: 'injected',
          confirmed: false,
          reservation: owner,
          // 消息 ID 由 bodyId 确定性派生：宿主提交失败后同轮重试拿同一个身份，
          // 不会因为重试而变成「第二份呈现」。
          messageId: bodyId === null ? null : 'mcl-v3-recall-' + bodyId.replace(/^v3rl-/, ''),
          text: outcome.text,
          hits: outcome.hits,
          presentedIds,
          displayedCandidates: outcome.displayedCandidates ?? null,
          omittedHits: outcome.omittedHits,
          bodyId,
        }
      }
      // R04：没呈现的每一种结局都带 releaseReason（用例已归还占位）。旧实现把「本回合已
      // 注入过」与「这次读取暂败」都压成 skipped，观察面无法区分，用户看到的是
      // 「本回合命中只出现一步」——把一个可重试的失败说成了设计行为。
      // status 仍是既有的 'skipped'（命令/投影/审计面都在读这个词表，语义不变＝「本步没有回注」）；
      // 细分原因放进 releaseReason / lastNotPresented，让「本回合已注入过」与「这次没装出来」
      // 在观察面可分。旧实现只有一句 reason 文案，用户看到的永远是「只出现一步」。
      injection.skipped += 1
      injection.lastStatus = 'skipped'
      injection.lastReason = outcome?.reason ?? 'unknown'
      injection.lastNotPresented = outcome?.releaseReason ?? null
      // 用例层已归还自己的占位；入口租约也必须归还，否则同回合的重试会被自己挡住。
      injectionLeases.forget(String(sessionId), turn, { owner })
      return {
        status: 'skipped',
        reservation: owner,
        reason: injection.lastReason,
        released: outcome?.released === true,
        releaseReason: outcome?.releaseReason ?? null,
      }
    },
    /**
     * R04 的 reserve / commit / release（入口侧，进程内）。
     *
     * 分工必须清楚：
     * - **用例层**（recall.mjs）负责「同一次取数里」的占位与归还——读取暂败、纯壳、超顶
     *   都在这一层释放，因此同回合重试能重新装包；
     * - **入口层**（这里）负责「取数成功之后到消息交给宿主之间」的租约：取数时先占位
     *   （防两个并发 pre-step 各注入一份），钩子在非 enter / 取消 / 未追加时释放，
     *   真的追加进 decision.messages 才提交。
     *
     * 为什么两层都需要：只靠用例层，两个并发钩子会各自「成功装包」，然后都返回一条消息；
     * 只靠入口层，读取暂败时租约已经占住，同回合的重试被自己的占位挡住（P0 R04 的形态）。
     */
    /**
    /**
     * 交给宿主（消息已进 decision.messages）。**不是成功**：只把 pending 变成 handed-off，
     * 并登记一条待确认来源（messageId + bodyId + 实际呈现的 recordIds，不存正文）。
     * 真正的 confirmed 只能来自宿主 session/event 证据（observeSessionEvent）。
     */
    handoffInjection(sessionId, turn, { reservation = null, messageId = null, bodyId = null, recordIds = [], step = null, seqBase = -1 } = {}) {
      if (!Number.isInteger(turn) || turn < 1) return { handedOff: false, reason: 'invalid-turn' }
      const key = String(sessionId)
      const ids = Array.isArray(recordIds) ? recordIds.filter((id) => typeof id === 'string') : []
      // 无法做负向收敛的交接必须失败关闭：step 不是合法整数时，step/end 永远匹配不到，
      // 这条登记会永久占位；宁可本次不呈现（调用方尚未追加消息，可同轮重试）。
      if (!Number.isInteger(step) || step < 1) {
        metricsNote('v3.recall.handoff-invalid-step')
        return { handedOff: false, reason: 'invalid-step' }
      }
      // 容量必须在**改租约之前**判：拒绝时调用方还没把消息交给宿主，直接放弃本次并归还占位。
      if (!confirmations.canAccept({ sessionId: key, turn })) {
        metricsNote('v3.recall.capacity-rejected')
        return { handedOff: false, reason: 'capacity' }
      }
      const lease = injectionLeases.handoff(key, turn, { owner: reservation, messageId, bodyId, recordIds: ids })
      if (lease.handedOff === false) return { handedOff: false, reason: lease.reason }
      const row = confirmations.record({ sessionId: key, turn, step, messageId, bodyId, recordIds: ids, owner: reservation, seqBase })
      if (row === null) {
        // 竞态下仍可能满：把刚改成的 handed-off 撤回，保持「同一身份」两表生命周期一致。
        injectionLeases.forget(key, turn, { owner: reservation })
        metricsNote('v3.recall.capacity-rejected')
        return { handedOff: false, reason: 'capacity' }
      }
      const counters = countersOf(key)
      counters.handedOff += 1
      counters.lastStatus = 'pending-confirm'
      counters.lastHandoffAt = Date.now()
      metricsNote('v3.recall.handed-off')
      return { handedOff: true }
    },
    /**
     * 释放「取数成功但消息没交给宿主」的记账（R04）。
     *
     * 单靠 `injectionLeases.release` 不够：装包成功时用例层已经 **commit** 了租约，
     * 入口这一层再 release 只会得到 `not-reserved`——同回合依旧注入不了，正是 P0 R04
     * 的另一半。所以这里同时做三件事，且都只动进程内记账：
     * 1. 清入口租约（pending 或 committed）；
     * 2. 调用例的 `releasePresentedTurn`，撤销「本回合已呈现」；
     * 3. 撤掉消费登记里那条尚未被宿主事件确认的 pending（它不算呈现）。
     * 宿主**事件确认**不走这条路径（见 observeSessionEvent）。
     */
    releaseInjectionReservation(sessionId, turn, reason = 'not-presented', { bodyId = null, reservation = null } = {}) {
      if (!Number.isInteger(turn) || turn < 1) return { released: false, reason: 'invalid-turn' }
      const key = String(sessionId)
      const lease = injectionLeases.forget(key, turn, { owner: reservation })
      if (lease.forgotten === false) {
        // 并发败方（本来就没占到）不得撤别人的占位；owner 不匹配一律不动任何状态。
        return { released: false, lease: lease.reason, withdrawn: false, dropped: false, reason: normalizeReleaseReason(reason) }
      }
      const dropped = confirmations.drop({ sessionId: key, turn, bodyId })
      let withdrawn = false
      try {
        const entry = runtimes.get(key)
        const recall = entry?.runtime?.recall
        if (typeof recall?.releasePresentedTurn === 'function') withdrawn = recall.releasePresentedTurn(turn)?.forgotten === true
      } catch { withdrawn = false }
      metricsNote('v3.recall.reservation-released')
      return {
        released: lease.forgotten,
        lease: lease.reason,
        withdrawn,
        dropped,
        reason: normalizeReleaseReason(reason),
      }
    },
    /**
     * 写进宿主**失败**时撤销一条已提交的呈现（宿主拒绝 append / 提交抛错）。
     * 与 releaseInjectionReservation 的区别：这条明确对应「我们已经 commit 过」，
     * 语义是撤回，不是归还排队。
     */
    withdrawInjection(sessionId, turn, { bodyId = null, reason = 'host-commit-failed', reservation = null } = {}) {
      const key = String(sessionId)
      if (!Number.isInteger(turn) || turn < 1) return { released: false, reason: 'invalid-turn' }
      const lease = injectionLeases.forget(key, turn, { owner: reservation })
      if (lease.forgotten === false) {
        // owner 不匹配（并发败方 / 旧令牌）一律不撤：撤回必须由**发起这次呈现**的调用方执行。
        return { released: false, lease: lease.reason, withdrawn: false, reason: normalizeReleaseReason(reason) }
      }
      confirmations.drop({ sessionId: key, turn, bodyId })
      let withdrawn = false
      try {
        const recall = runtimes.get(key)?.runtime?.recall
        if (typeof recall?.releasePresentedTurn === 'function') withdrawn = recall.releasePresentedTurn(turn)?.forgotten === true
      } catch { withdrawn = false }
      metricsNote('v3.recall.presentation-withdrawn')
      return { released: true, lease: lease.state, withdrawn, reason: normalizeReleaseReason(reason) }
    },
    /** 只读：本回合是否已确认呈现过一次回注。 */
    injectionPresentedInTurn(sessionId, turn) {
      return injectionLeases.stateOf(String(sessionId), turn) === 'confirmed'
    },
    /** 只读：本回合的租约状态（absent / pending / handed-off / confirmed）。 */
    injectionLeaseState(sessionId, turn) {
      return injectionLeases.stateOf(String(sessionId), turn)
    },
    /**
     * 宿主事件对账（R04 的确认面）：
     * - 命中**插件 recall 来源**的 user/message 事件（messageId 或该事件正文里的 bodyId）
     *   → 租约 confirmed、计数 injected++、按实际呈现条目写读租约、撤掉待确认登记；
     * - 未命中 → 判**未确认**：撤销租约与登记，计数 unconfirmed++，同回合可重试。
     *
     * 注意口径：`confirmed` 只表示「宿主事件已存在」，**不**表示 JSONL 已 flush 耐久。
     * 也不把普通用户消息 / 工具结果 / 日志里出现同一串当证据（isPluginRecallEvent 把关）。
     */
    observeSessionEvent(sessionId, event) {
      const key = String(sessionId)
      // 宿主每个事件都会广播：本会话既没有待确认登记、也没有回注计数桶时直接返回，
      // 不为「与本插件无关的会话」创建内存表（读模型不得变成无界增长）。
      if (!injectionBySession.has(key) && !confirmations.snapshot().some((row) => row.sessionId === key)) {
        return { confirmed: 0, released: 0, pending: confirmations.stats().pending }
      }
      // 终止事件同时让租约侧清掉旧回合的 confirmed 去重键（宿主 turn 单调，结构上过期）。
      if (event?.type === 'step/end' || event?.type === 'turn/end') {
        const eventTurn = event?.data?.turn
        if (Number.isInteger(eventTurn)) injectionLeases.pruneConfirmed(key, eventTurn)
      }
      const result = confirmations.observe({
        sessionId: key,
        event,
        sourceKind: PLUGIN_SOURCE_KIND,
        sourceForm: RECALL_SOURCE_FORM,
      })
      const counters = countersOf(key)
      for (const row of result.confirmed) {
        const lease = injectionLeases.confirm(key, row.turn, { owner: row.owner })
        if (lease.confirmed === false) {
          // 租约已被撤回（例如该 step 已判未交付），迟到事件不重复记账。
          metricsNote('v3.recall.late-confirm')
          continue
        }
        counters.injected += 1
        counters.lastInjectedAt = Date.now()
        counters.lastStatus = 'injected'
        counters.lastHits = row.recordIds.length
        counters.lastConfirmedAt = Date.now()
        counters.lastNotPresented = null
        metricsNote('v3.recall.confirmed')
        // 租约写入是异步的（宿主 session/event 监听器不会被 await），但下一次归档必须
        // 看到它：这里把 promise 记进 pendingLeaseWrites，入口在 pre-step 开头 await 一次。
        const write = markReadLease(key, row.recordIds)
          .then((leaseWrite) => {
            const ok = leaseWrite.markReadLease === 'ok' || leaseWrite.markReadLease === 'noop'
            counters.lastLease = ok ? null : leaseWrite.markReadLease
            if (!ok) {
              // 写不进去 = 确认过的呈现没有保护：必须让 flush 失败（本步不归档），
              // 不能把空租约当成功继续压历史。
              const failure = new Error('租约写入失败：' + String(leaseWrite.markReadLease))
              failure.code = leaseWrite.error ?? 'ELEASE_WRITE'
              throw failure
            }
            // 明确恢复：成功写入覆盖了同一批 recordIds，才解除该会话的持久失败事实。
            clearLeaseFailureCoverage(key, row.recordIds)
          })
          .catch((error) => {
            counters.lastLease = error?.code ?? 'EINTERNAL'
            // 失败事实必须在 promise settle 之后仍然存在：只删除 settle 的 promise
            // 会让「写先失败、下一步才归档」的时序看不到阻断。
            noteLeaseFailure(key, row.recordIds, error?.code ?? 'EINTERNAL')
            throw error
          })
        let set = pendingLeaseWrites.get(key)
        if (set === undefined) { set = new Set(); pendingLeaseWrites.set(key, set) }
        set.add(write)
        // 标记为已处理（避免未 await 时的 unhandledRejection）；flush 仍能看到 reject。
        void write.catch(() => {})
        write.then(() => set.delete(write), () => set.delete(write))
      }
      for (const row of result.released) {
        injectionLeases.forget(key, row.turn, { owner: row.owner })
        // 用例层也记过「本回合已装包」：不撤销它，同回合重试会被自己的占位挡住。
        try {
          const recall = runtimes.get(key)?.runtime?.recall
          if (typeof recall?.releasePresentedTurn === 'function') recall.releasePresentedTurn(row.turn)
        } catch { /* 撤销失败只影响同回合重试，不影响计数 */ }
        counters.unconfirmed += 1
        counters.lastStatus = 'unconfirmed'
        counters.lastNotPresented = row.reason
        metricsNote('v3.recall.unconfirmed')
      }
      return {
        confirmed: result.confirmed.length,
        released: result.released.length,
        pending: confirmations.stats().pending,
      }
    },
    /** 等待已排队的读租约写入落定（archiveForStep 开头调用一次；按会话协调）。 */
    async flushInjectionConfirmation(sessionId) {
      return await flushInjectionConfirmation(sessionId)
    },
    /** 只读：flush/archive 的先后顺序（诊断与测试；有界环形）。 */
    lifecycleTrace() {
      return [...lifecycleTrace]
    },
    /** 诊断：注入侧未收敛的 pending（有界；不含正文）。 */
    injectionPending() {
      return confirmations.snapshot()
    },
    /** 诊断：待确认/已确认计数（不含正文）。 */
    injectionConfirmationStats() {
      return confirmations.stats()
    },
    stats() {
      const out = { ingestMetrics: Object.fromEntries(entryMetrics), injection: injectionSnapshot() }
      for (const [sessionId, { runtime, lastSeq, records, inflight }] of runtimes) {
        out[sessionId] = { lastSeq, records, ingesting: inflight !== null, metrics: runtime.metrics() }
      }
      return out
    },
    /**
     * 测试/诊断用：判负游标的当前形状（只读、不含正文；P3-04 守卫要能核对失效条件）。
     * 生产路径不读它——游标的真正判据在 notWorthCursorStart / advanceNotWorthCursor。
     */
    _notWorthCursorOf(sessionId, field = 'notWorthThroughSeq') {
      const entry = runtimes.get(String(sessionId ?? ''))
      if (entry === undefined) return null
      return notWorthCursorOf(entry, field)
    },
    /** 测试/诊断用：等待所有在飞摄入完成（生产不调用）。 */
    async _waitForIdle() {
      for (;;) {
        // 先等所有建库任务落定（H-19 之后建库在后台跑，测试必须能看到它）
        const creating = [...pendingEntries.values()]
        if (creating.length > 0) {
          await Promise.allSettled(creating)
          continue
        }
        const backfills = [...backfillJobs.values()].map((job) => job.promise).filter((promise) => promise !== null)
        if (backfills.length > 0) {
          await Promise.allSettled(backfills)
          continue
        }
        const busy = [...runtimes.values()].filter((e) => e.inflight !== null)
        if (busy.length === 0) return
        await Promise.all(busy.map((e) => e.inflight))
      }
    },
  }
}
