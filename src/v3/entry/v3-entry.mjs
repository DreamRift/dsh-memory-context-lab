import { appendUsageLine, readUsageSummary } from '../adapters/storage/usage-log.mjs'
import { readExportBundle, writeExportBundle } from '../adapters/storage/export-writer.mjs'
import { buildExportBundle } from '../domain/export/bundle.mjs'
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
import { seqOfDshEventId } from '../adapters/host/dsh-host.mjs'
import { RECALL_RESULT_MIN_SCORE } from '../application/recall.mjs'
import { readSessionControl, writeSessionControl } from '../adapters/storage/session-control.mjs'
import { readSessionState, writeSessionState } from '../adapters/storage/session-state.mjs'
import { emptySessionControl, patchSessionControl } from '../domain/session/session-control.mjs'
import { emptySessionState, modeForMigratedSession, modeForNewSession, patchSessionState } from '../domain/session/mode.mjs'
import { evaluatePressureGate } from '../domain/session/pressure-gate.mjs'
import { createArchiveService } from '../application/archive.mjs'
import { readBackfillState, writeBackfillState } from '../adapters/storage/t2-backfill-state.mjs'
import { mirrorRootOf, scanMirrorableRecords, scanMirroredNodes } from '../adapters/storage/mirror-inventory.mjs'
import { parseBackfillLimit, planBackfill, runBackfill } from '../application/t2-backfill.mjs'
import { clearArchiveIntent, readArchiveIntent, writeArchiveIntent } from '../adapters/storage/archive-intent.mjs'
import {
  captureFileReference,
  isStaleFileReference,
  readFileReferences,
  verifyFileReference,
  writeFileReferences,
} from '../adapters/storage/file-references.mjs'

const MEMORY_EVENT_TYPES = new Set(['user/message', 'assistant/message', 'tool/call', 'tool/result'])

/** 敏感字段脱敏（P1 摄入合同 4.1.3：凭据/令牌不静默入库）。 */
const SENSITIVE_KEY = /token|secret|pass(word|wd)?|credential|api[-_]?key|auth|cookie|session[-_]?id|bearer|密钥|密码|令牌|凭据|凭证/i

/**
 * 真实宿主的 tool/call 参数是 **JSON 字符串**（dsh-agent-loop appendToolCall：
 * `arguments: block.arguments`，content 块里是序列化后的字符串）。只对 object 递归的
 * 脱敏会整体漏掉这种形态（H-06：apiKey/password 明文入库）。这里先尝试解析成对象再脱敏；
 * 不是 JSON 的普通字符串原样返回（不猜、不改写用户文本）。
 */
function parseJsonishArguments(value) {
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  if (trimmed.length < 2 || (trimmed[0] !== '{' && trimmed[0] !== '[')) return value
  try {
    const parsed = JSON.parse(trimmed)
    return parsed !== null && typeof parsed === 'object' ? parsed : value
  } catch {
    return value
  }
}

/**
 * 值里出现凭据形态的**文本**也要脱敏（H-27）：只按 key 名匹配会漏掉
 * `{headers: 'Authorization: Bearer sk-…'}`、`{url: '…?token=sk-…'}`、
 * `{args: ['--password=hunter2']}` 这类「凭据写在普通字段的值里」的形态。
 * 只改匹配到的凭据片段，不整段吞掉用户正文（保持可读性与对账价值）。
 */
const SENSITIVE_VALUE_PATTERNS = Object.freeze([
  // PEM 私钥（RSA/EC/OPENSSH/PKCS8 等）：整段替换，避免 base64 段被当成普通文本。
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, '[REDACTED]'],
  // Authorization: Bearer xxx / Basic xxx
  [/\b(authorization\s*[:=]\s*)(bearer|basic|token)?\s*([A-Za-z0-9._~+/=-]{8,})/gi, '$1[REDACTED]'],
  // key=value / key: value / key：value / key%3Dvalue 形态的常见凭据名。
  // AUD48-02-04：旧式的 \b 边界在 AWS_SECRET_ACCESS_KEY / MY_API_KEY 这类**前缀/后缀键**
  // 上不成立（_ 是词字符），全角冒号与 URL 编码分隔符也不认；键名允许由 . _ - 连接，
  // 保留键名本身、只替换值（可读性与对账价值不丢）。
  [/\b([A-Za-z0-9_.-]*(?:api[-_]?key|access[-_]?token|refresh[-_]?token|secret|password|passwd|credential|token)[A-Za-z0-9_.-]*)(\s*[:=：]\s*|%3[dDaA])(["']?)([^\s"',&;]{4,})\3/gi, '$1$2$3[REDACTED]$3'],
  // sk- 开头的常见密钥前缀（OpenAI/Anthropic 等）
  [/\bsk-[A-Za-z0-9_-]{8,}/g, '[REDACTED]'],
  // AWS access key ID（AKIA/ASIA/AIDA/AROA/... + 16 位大写字母数字）
  [/\b(?:AKIA|ASIA|AIDA|AROA|AIPA|ANPA|ANVA|ASCA)[0-9A-Z]{16}\b/g, '[REDACTED]'],
  // GitHub token（ghp_/gho_/ghu_/ghs_/ghr_ 与细粒度 github_pat_）
  [/\bgh[pousr]_[A-Za-z0-9]{36,}\b/g, '[REDACTED]'],
  [/\bgithub_pat_[A-Za-z0-9_]{22,}\b/g, '[REDACTED]'],
  // Slack token
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, '[REDACTED]'],
  // Google API key
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, '[REDACTED]'],
  // Stripe secret/restricted key
  [/\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,}\b/g, '[REDACTED]'],
  // JWT（三段式；只匹配足够长的段，避免误伤普通点号文本）
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED]'],
  // CLI 形态 --password=xxx
  [/(--?(?:password|passwd|token|secret|api[-_]?key)\s*[= ]\s*)([^\s"']{4,})/gi, '$1[REDACTED]'],
])

function redactText(text) {
  if (typeof text !== 'string' || text.length === 0) return text
  let out = text
  for (const [pattern, replacement] of SENSITIVE_VALUE_PATTERNS) out = out.replace(pattern, replacement)
  return out
}

function redactValue(value, depth = 0) {
  // 深度超限**不是**「放行原值」（H-27）：旧实现 depth > 6 直接 return value，
  // 于是第 7 层以下的凭据完全不脱敏——脱敏函数的失败模式必须是「更严」而不是「更松」。
  if (depth > 6) return '[REDACTED:depth]'
  if (value === null) return value
  if (typeof value === 'string') return redactText(value)
  if (typeof value !== 'object') return value
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redactValue(v, depth + 1))
  const out = {}
  for (const [k, v] of Object.entries(value).slice(0, 50)) {
    out[k] = SENSITIVE_KEY.test(k) ? '[REDACTED]' : redactValue(v, depth + 1)
  }
  return out
}

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
function textOfBlocks(content) {
  if (!Array.isArray(content)) return ''
  return content.filter((c) => c?.type === 'text').map((c) => c.text ?? '').join('\n')
}

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
    const callId = typeof block.callId === 'string' ? block.callId : ''
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
    if (failed && text) return { text: text + '\n[工具结果：错误态]' }
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
      argsText = typeof structure.arguments === 'string' ? redactText(structure.arguments) : JSON.stringify(structure.arguments)
    } catch { argsText = '[不可序列化参数]' }
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
  // 全局设置的同步读取器（由 index.mjs 注入）。没有注入时按产品默认 full-history。
  const settingsNow = typeof options.settingsNow === 'function' ? options.settingsNow : () => ({})
  const defaultModeNow = () => modeForNewSession(settingsNow().fullHistory !== false)
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

  const makeRuntime = options.runtimeFactory ?? (async (dshSession, sessionId) => createV3Runtime({
    v3Root,
    dshSession,
    sessionKey: sessionId,
    memoryProbe: options.memoryProbe,
    t2ProviderFactory: options.t2ProviderFactory,
    t2Isolated: options.t2Isolated,
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
    const current = controlOf(sessionId)
    const base = {
      schemaVersion: 1,
      enabled: current.enabled !== false,
      recall: current.recall !== false,
      overrides: current.overrides ?? {},
    }
    const next = patchSessionControl(base, patch)
    return await writeSessionControl(v3Root, String(sessionId ?? ''), next)
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
    const current = stateOf(sessionId)
    const next = patchSessionState(current, patch)
    return await writeSessionState(v3Root, String(sessionId ?? ''), next)
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

  /** 读租约：最近读过的记录在 TTL 内作为归档软边界（不是永久 pin）。 */
  async function markReadLease(sessionId, recordIds, ttlMs = 5 * 60 * 1000) {
    if (!Array.isArray(recordIds) || recordIds.length === 0) return
    const state = stateOf(sessionId)
    const now = Date.now()
    const map = new Map((state.readLease ?? []).filter((row) => Number.isFinite(row?.expiresAt) && row.expiresAt > now).map((row) => [row.recordId, row.expiresAt]))
    for (const id of recordIds) if (typeof id === 'string' && id.length > 0) map.set(id, now + ttlMs)
    const readLease = [...map.entries()].slice(-200).map(([recordId, expiresAt]) => ({ recordId, expiresAt }))
    await setState(sessionId, { readLease }).catch(() => {})
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
    for (let round = 0; round < MAX_NOT_WORTH_SKIPS; round += 1) {
      result = await run(cursor)
      if (result?.status !== 'not-worth') break
      lastNotWorth = result
      encountered = true
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
    }
    return { result, cursor }
  }

  /** 记住最近一次判负事实（AUD48-11-01）：供 status/第二次 now 显示真实原因；归档成功后清。 */
  function rememberNotWorth(entry, field, result) {
    if (entry.lastNotWorth === undefined || entry.lastNotWorth === null) entry.lastNotWorth = {}
    if (result?.status === 'not-worth') entry.lastNotWorth[field] = result
    else if (result?.status === 'archived') delete entry.lastNotWorth[field]
  }

  async function archiveForStep(sessionId, session, settings = {}, options = {}) {
    const entry = runtimes.get(String(sessionId ?? ''))
    if (entry === undefined || entry.inflight !== null) return { status: 'busy-or-not-ready' }
    if (entry.archive === null) return { status: 'host-no-surface' }
    // C-F：每个 pre-step 先尝试对账旧 intent（失败保留 intent，只告警不阻塞）。
    try {
      await recoverArchiveIntent(entry, sessionId)
    } catch (error) {
      ctx.logger?.warn?.('memory-context-lab-v3: 归档意图对账失败（保留 intent）：' + (error?.message ?? String(error)))
    }
    let state = stateOf(sessionId)
    if (state.mode === 'recall-only' || state.planFirst === true) return { status: 'paused' }
    if (state.mode === 'cooling') {
      // 压力闸门：occupancy = 最近 input+cacheRead / contextWindow；未知一律失败关闭。
      const gate = await coolingGateOf(entry, state, settings)
      const { opened, occupancy } = gate
      if (state.cooling?.open !== opened || state.cooling?.lastOccupancy !== occupancy) {
        state = await setState(sessionId, { cooling: { open: opened, lastOccupancy: occupancy, lastRunAt: Date.now(), lastReason: opened ? 'gate-open' : 'gate-closed' } })
      }
      if (!opened) return { status: 'cooling-closed', occupancy, gate: gate.gate }
    }
    const host = entry.runtime.host
    if (typeof host.surfaceNodes !== 'function') return { status: 'host-no-surface' }
    const surfaceNodes = await host.surfaceNodes()
    const events = Array.isArray(session?.log) ? session.log : (typeof session?.events === 'function' ? session.events() : null)
    if (!Array.isArray(events) || surfaceNodes.length === 0) return { status: 'no-surface' }
    // 轮次判定（0.14.0-beta.47）：默认按真人消息（历史行为），可切到 DSH 自己的轮次计数。
    // 只影响按轮归档的「什么算一轮」；按步归档与回执/恢复语义完全不变。
    const turnBasis = settings.turnBasis === 'dsh' ? 'dsh' : 'human'
    const turnCursorField = turnBasis === 'dsh' ? 'notWorthThroughSeqTurnDsh' : 'notWorthThroughSeqTurn'
    // 两种模式的分工（beta.40）：
    // - full-history：回合级，只压已完成回合（当前回合永不归档）——长程多轮；
    // - cooling：步骤级，在当前回合内实时压掉不再需要的旧步骤——长步数少轮，
    //   retainOperations 在这里当「工作集保留的步骤数」（模型刚用过的结果不能撤）。
    let result
    if (state.mode === 'cooling') {
      const stepArgs = {
        sessionId,
        events,
        surfaceNodes,
        seqToRecordId: entry.seqToRecordId,
        retainSteps: Number.isInteger(settings.retainOperations) ? settings.retainOperations : 4,
        maxSteps: 3,
        // 按步归档在**当前回合内**压缩：刚读过的记录必须留在工作集里（租约生效）。
        pinnedSeqs: pinnedSeqsOf(entry, state, { includeLease: true }),
        summary: options?.compact === true,
        txn: 1,
      }
      const notWorthField = 'notWorthThroughSeq'
      const priorNotWorth = entry.lastNotWorth?.[notWorthField] ?? null
      const skipped = await skipNotWorthSpans(
        entry,
        (minStartSeq) => entry.archive.archiveStepOnce({ ...stepArgs, minStartSeq }),
        notWorthField,
        { startCursor: options?.resetNotWorth === true ? -1 : null, fallback: priorNotWorth },
      )
      result = skipped.result
      if (skipped.cursor > (Number.isInteger(entry.notWorthThroughSeq) ? entry.notWorthThroughSeq : -1)) {
        entry.notWorthThroughSeq = skipped.cursor
      }
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
        summary: options?.compact === true,
        txn: 1,
      }
      const priorNotWorth = entry.lastNotWorth?.[turnCursorField] ?? null
      const skipped = await skipNotWorthSpans(
        entry,
        (cursor) => entry.archive.archiveOnce({ ...turnArgs, minStartSeq: Math.max(planFloor, cursor) }),
        turnCursorField,
        { startCursor: options?.resetNotWorth === true ? -1 : null, fallback: priorNotWorth },
      )
      result = skipped.result
      if (skipped.cursor > (Number.isInteger(entry[turnCursorField]) ? entry[turnCursorField] : -1)) {
        entry[turnCursorField] = skipped.cursor
      }
      rememberNotWorth(entry, turnCursorField, result)
    }
    if (result.status === 'archived') {
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
    }
    return result
  }

  async function dryRunArchive(sessionId, session, settings = {}, options = {}) {
    const entry = runtimes.get(String(sessionId ?? ''))
    if (entry === undefined) return { status: 'not-ready' }
    if (entry.archive === null) return { status: 'host-no-surface' }
    const state = stateOf(sessionId)
    if (state.mode === 'recall-only' || state.planFirst === true) return { status: 'paused' }
    const host = entry.runtime.host
    if (typeof host.surfaceNodes !== 'function') return { status: 'host-no-surface' }
    const surfaceNodes = await host.surfaceNodes()
    const events = Array.isArray(session?.log) ? session.log : (typeof session?.events === 'function' ? session.events() : null)
    if (!Array.isArray(events)) return { status: 'no-surface' }
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
        retainSteps: Number.isInteger(settings.retainOperations) ? settings.retainOperations : 4,
        maxSteps: 3,
        pinnedSeqs: pinnedSeqsOf(entry, state, { includeLease: true }),
      }
      // 预览与执行同一游标：判负的队头 span 不参与「下一次归档」，否则 status 会显示一个永远执行不了的候选。
      const priorNotWorth = entry.lastNotWorth?.['notWorthThroughSeq'] ?? null
      const { result: planned } = await skipNotWorthSpans(
        entry,
        (minStartSeq) => entry.archive.planSteps({ ...stepArgs, minStartSeq }),
        'notWorthThroughSeq',
        { fallback: priorNotWorth },
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
    }
    const priorNotWorth = entry.lastNotWorth?.[turnCursorField] ?? null
    const { result: planned } = await skipNotWorthSpans(
      entry,
      (cursor) => entry.archive.dryRun({ ...turnArgs, minStartSeq: Math.max(planFloor, cursor) }),
      turnCursorField,
      { fallback: priorNotWorth },
    )
    return { status: planned.status ?? 'planned', ...planned }
  }

  /** 历史凭证（只读；供 /memory-lab history 与面板）。 */
  async function historyOf(sessionId) {
    const entry = runtimes.get(String(sessionId ?? ''))
    if (entry === undefined) return { total: 0, rows: [], busy: pendingEntries.has(String(sessionId ?? '')) }
    if (entry.archive === null) return { total: 0, rows: [], error: { code: 'EHOST_NO_SURFACE' } }
    return entry.archive.history()
  }

  /** 恢复一个/全部凭证（M2）。 */
  async function restoreHistory(sessionId, { index = null, maxChars = 16000 } = {}) {
    const entry = runtimes.get(String(sessionId ?? ''))
    if (entry === undefined) return { error: 'not-ready' }
    if (entry.archive === null) return { error: 'host-no-surface' }
    if (index === null) return await entry.archive.restoreAll({ maxChars })
    return await entry.archive.restoreVoucher(index, { maxChars })
  }

  /**
   * 日志尾部半行修复（G-A，0.14.0-beta.48）：dryRun 只报告，不写任何字节。
   * apply 成功后关闭旧句柄并丢弃入口缓存——下一次 pre-step 会重新建库/重开，
   * 让 writable 与内存视图都回到修复后的真实状态（不伪造「已可写」）。
   */
  async function repairStore(sessionId, { dryRun = false } = {}) {
    const key = String(sessionId ?? '')
    const entry = runtimes.get(key)
    if (entry === undefined) return { error: 'not-ready' }
    const store = entry.runtime.store
    if (typeof store.repairJournals !== 'function') return { error: 'store-no-repair' }
    const report = await store.repairJournals({ dryRun })
    if (dryRun !== true && report?.changed === true) {
      try { entry.runtime.close?.() } catch { /* 关闭失败不改变修复事实 */ }
      runtimes.delete(key)
      entryFailures.delete(key)
    }
    return report
  }

  /** 显式 pin：这些记录所在的 surface 节点作为归档硬边界（pin 记录本身不归档）。 */
  async function pinRecords(sessionId, recordIds, { remove = false } = {}) {
    if (!Array.isArray(recordIds) || recordIds.length === 0) throw new V3ContractViolation('v3 entry: pin 需要非空 recordIds')
    const entry = runtimes.get(String(sessionId ?? ''))
    if (entry === undefined) return { error: 'not-ready' }
    const state = stateOf(sessionId)
    const pins = new Set(state.pins)
    for (const id of recordIds) {
      if (remove) { pins.delete(id); continue }
      const record = await entry.runtime.store.readRecord(id) // 不存在/已遗忘 → 失败关闭
      if (record?.id !== id) throw new V3ContractViolation('v3 entry: pin 目标不是本会话记录')
      pins.add(id)
    }
    const next = await setState(sessionId, { pins: [...pins] })
    return { pins: next.pins }
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

  /** 遗忘/撤销遗忘：走端口批量预检 + 索引重建。 */
  async function forgetRecords(sessionId, recordIds, { undo = false } = {}) {
    const entry = runtimes.get(String(sessionId ?? ''))
    if (entry === undefined) return { error: 'not-ready' }
    if (undo) {
      if (typeof entry.runtime.store.revokeForget !== 'function') return { error: 'store-no-undo' }
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
    const result = await entry.runtime.store.forget(recordIds)
    await refreshSearchable(entry)
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
      if (row.changed === true) redact.changed += 1
      else if (row.reason !== 'voucher-not-found') {
        redact.failed.push({ index, reason: row.reason ?? 'unknown' })
        ctx.logger?.warn?.('memory-context-lab-v3: 隐私面回执清除失败（#' + index + '：' + (row.reason ?? 'unknown') + '）——历史里该段已不可恢复')
      }
    }
    // D-D：遗忘不再删除 pin。pin 是用户意图，一次 forget 不该永久丢失它；
    // 保留后 undo 自然恢复保护（旧实现删了 pins、undo 却不恢复）。
    return { ...result, undone: false, redact }
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
        ? entry.runtime.store.redactedVoucherIds()
        : []
    } catch (error) {
      return { error: error?.code ?? 'redactions-unreadable' }
    }
    const bundle = buildExportBundle({
      sessionKey: String(sessionId),
      exportedAt,
      records,
      forgotten,
      vouchers: entry.runtime.store.listVouchers(),
      redactedVoucherIds,
      state: stateOf(sessionId),
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
    const inputs = bundle.records.filter((record) => record !== null && typeof record === 'object' && typeof record.payload?.text === 'string')
    if (inputs.length === 0) return { error: 'bundle-empty' }
    const result = await entry.runtime.store.importRecords(inputs)
    await refreshSearchable(entry)
    return { imported: result.recordIds?.length ?? inputs.length, sessionKey: bundle.sessionKey }
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
    const ids = await parent.runtime.store.listRecordIds()
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
    return { imported: result.recordIds?.length ?? records.length, parentSessionId }
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
    const rows = []
    for (const ref of targets) {
      const verified = await verifyFileReference(ref)
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
            await writeBackfillState(directory, job.state).catch(() => {})
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
        await writeBackfillState(directory, job.state).catch(() => {})
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
      return await writeSessionState(v3Root, String(sessionId ?? ''), initial)
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
    for (const raw of log) {
      if (disposed.value) return
      if (!MEMORY_EVENT_TYPES.has(raw?.type)) continue
      if (Number.isInteger(entry.lastSeq) && raw.seq <= entry.lastSeq) continue
      batch.push(raw)
      batchFirstSeq = batchFirstSeq ?? raw.seq
      if (batch.length >= INGEST_BATCH) {
        ingested += await ingestBatch(entry, batch, batchFirstSeq)
        batch = []
        batchFirstSeq = null
      }
    }
    if (batch.length > 0 && !disposed.value) {
      ingested += await ingestBatch(entry, batch, batchFirstSeq)
    }
    // 只有回填（大批量）才在这里重建索引；每步 1-3 条的小增量留 stale，
    // 检索时懒重建——否则每步全量重建二十几 MB 索引会卡住宿主事件循环（首字慢）。
    if (!disposed.value && ingested >= INGEST_BATCH) {
      try {
        await entry.runtime.store.rebuildIndex()
        await refreshSearchable(entry)
      } catch (error) {
        ctx.logger?.warn?.('memory-context-lab-v3: 索引重建失败（检索时会自动重试）：' + (error?.message ?? String(error)))
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
      } else {
        scheduleIndexRebuild(entry)
      }
    }
  }

  /**
   * 持久断点（H-01）：已提交记录里出现过的最大宿主 seq。
   * 无记录 → -1（首事件 seq=0 不漏）；读失败 → 抛出，由调度层告警后保持 -1（不静默当作没有）。
   */
  async function resumeCheckpointOf(runtime) {
    let last = -1
    const seqToRecordId = new Map()
    // 归档需要「宿主 seq → v3 记录 ID」；sourceEventIds 只给来源 ID，不能直接当记录 ID。
    // listRecordIds + readProvenance 是现有端口的最小组合，只在建库后台任务里跑一次。
    if (typeof runtime.store.listRecordIds === 'function' && typeof runtime.store.readProvenance === 'function') {
      for (const recordId of await runtime.store.listRecordIds()) {
        const provenance = await runtime.store.readProvenance(recordId)
        const sourceEventId = provenance?.sourceEventId
        const seq = seqOfDshEventId(sourceEventId)
        if (seq === null) continue
        if (seq > last) last = seq
        seqToRecordId.set(seq, recordId)
      }
      return { lastSeq: last, seqToRecordId }
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
    const intent = await readArchiveIntent(v3Root, String(sessionId)).catch((error) => {
      ctx.logger?.warn?.('memory-context-lab-v3: 归档意图不可读（本步跳过对账）：' + (error?.message ?? String(error)))
      return null
    })
    if (intent === null || typeof intent !== 'object') return { recovered: false }
    const nodes = await entry.runtime.host.surfaceNodes()
    const recovered = await entry.archive.recoverIntent({
      sessionId: String(sessionId),
      surfaceNodes: nodes,
      surfaceTextOf: (seq) => entry.runtime.host.surfaceTextAt(seq),
    })
    if (recovered.recovered === true) {
      const current = stateOf(String(sessionId))
      const at = Date.now()
      const surface = recovered.mode === 'cooling'
        ? { lastArchiveAt: at }
        : { lastArchiveEndSeq: recovered.endSeq, lastArchiveAt: at }
      await writeSessionState(v3Root, String(sessionId), patchSessionState(current, { surface }))
    }
    return recovered
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
        try { runtime.close() } catch {}
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
      const archive = runtime.store !== undefined && runtime.host !== undefined
        ? createArchiveService({
          store: runtime.store,
          host: runtime.host,
          clock: { now: () => Date.now() },
          intent: {
            write: (data) => writeArchiveIntent(v3Root, sessionId, data),
            read: () => readArchiveIntent(v3Root, sessionId),
            clear: () => clearArchiveIntent(v3Root, sessionId),
          },
        })
        : null
      let fileRefs = []
      let fileRefsError = null
      try {
        const ledger = await readFileReferences(runtime.store.directory)
        fileRefs = ledger.refs
      } catch (error) {
        fileRefsError = error?.message ?? String(error)
        ctx.logger?.warn?.('memory-context-lab-v3: file-references 不可读（文件核证失败关闭）：' + fileRefsError)
      }
      const entry = {
        runtime,
        lastSeq: checkpoint.lastSeq,
        records,
        inflight: null,
        seqToRecordId: checkpoint.seqToRecordId,
        // 按步归档的「判负跳过」游标（0.14.0-beta.46）：只跳过净收益为负的 span，
        // 不是持久化位点——进程重建后归零，最多重扫一次判负队头。
        notWorthThroughSeq: -1,
        // 按轮归档的同一游标（回合级 span 与按步 span 不共享：判负结论不可跨模式复用）。
        notWorthThroughSeqTurn: -1,
        // 按轮归档切到「DSH 轮次」判定时的独立游标（0.14.0-beta.47）：
        // 真人回合的判负结论不能拿来跳过别的分组口径，否则切换后静默不归档。
        notWorthThroughSeqTurnDsh: -1,
        searchable,
        archive,
        cwd: session?.header?.cwd ?? session?.cwd ?? null,
        fileRefs,
        fileRefsError,
      }
      runtimes.set(sessionId, entry)
      pendingEntries.delete(sessionId)
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
    if (ready !== undefined) return ready
    const pending = pendingEntries.get(String(sessionId ?? ''))
    if (pending === undefined) return null
    try { return await pending } catch { return null }
  }

  const bodyOf = (raw) => extractEventBody(raw)
  function metricsNote(name) { entryMetrics.set(name, (entryMetrics.get(name) ?? 0) + 1) }

  async function ingestBatch(entry, batch, firstSeq) {
    let applied = 0
    let refsChanged = false
    try {
      // 一批一笔事务（beta.11）：逐事件事务在回填时是 10+ 次 fs/条 + 每笔同步全量事务日志，
      // 实测 1500 条约 45 秒、5000 条约 8 分钟；这段时间 inflight 恒非空，回注被 busy 挡住。
      const bodies = batch.map((raw) => bodyOf(raw))
      const results = await entry.runtime.handleDshEventBatch(batch.map((raw, index) => ({
        event: raw,
        text: bodies[index].text,
        meta: { metaOnly: bodies[index].metaOnly === true, metaReason: bodies[index].reason ?? '', structure: bodies[index].structure ?? undefined },
      })))
      for (let index = 0; index < batch.length; index += 1) {
        // dispose 落在批内：store 已 close，本批取消，断点停在上一批（下一批失败关闭并告警）
        if (disposed.value) break
        const raw = batch[index]
        const body = bodies[index]
        const result = results[index] ?? { status: 'not-memory-event' }
        if (body.metaOnly === true) metricsNote('v3.ingest.metadataOnly')
        if (body.usage !== undefined) await appendUsage(entry, raw, body.usage)
        // own-source 也推进断点：否则尾部注入事件每次重启都被重扫（断点语义不完整）
        if (result.status === 'applied' || result.status === 'rejected' || result.status === 'own-source') entry.lastSeq = raw.seq
        if (result.status === 'applied') {
          applied += 1
          // 只有真正提交的记录才计入「已摄入」；own-source / rejected / not-memory-event 不计。
          // records 为 null 表示建库时计数不可读，保持未知而不是从 0 重来。
          if (Number.isInteger(entry.records)) entry.records += 1
          if (typeof result.recordId === 'string' && result.recordId.length > 0) entry.seqToRecordId.set(raw.seq, result.recordId)
          if (raw?.type === 'tool/call' && typeof result.recordId === 'string' && entry.cwd !== null && entry.fileRefsError === null) {
            try {
              const ref = await captureFileReference({ event: raw, recordId: result.recordId, cwd: entry.cwd })
              if (ref !== null) {
                const index = entry.fileRefs.findIndex((item) => item.id === ref.id)
                if (index >= 0) entry.fileRefs[index] = ref
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
          ctx.logger?.warn?.('memory-context-lab-v3: 事件被拒绝 seq=' + raw.seq + '：' + (result.errors ?? []).join('；'))
        }
      }
      if (refsChanged) {
        try {
          await writeFileReferences(entry.runtime.store.directory, entry.fileRefs)
        } catch (error) {
          ctx.logger?.warn?.('memory-context-lab-v3: file-references 写入失败（核证面暂不可用）：' + (error?.message ?? String(error)))
        }
      }
      ctx.logger?.info?.('memory-context-lab-v3: 摄入批完成（起 seq=' + firstSeq + '，' + applied + '/' + batch.length + ' 条）')
    } catch (error) {
      // 影子模式不干扰宿主：摄入失败只告警，断点停在已完成处，下一步续传
      ctx.logger?.warn?.('memory-context-lab-v3: 影子摄入失败（seq 起 ' + firstSeq + '）：' + (error?.message ?? String(error)))
    }
    // 返回真正落库的条数：own-source / not-memory-event 不算「摄入」
    return applied
  }

  const off = ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
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
      searchable,
      coverage,
      coverageError,
    }
  }

  /**
   * 同步状态（0.14.0-beta.15，composer 状态条的数据源）。
   *
   * 客户端读不到宿主进程里的对象；投影的 wire.view 需要一个**同步、绝不抛错**的读取器，
   * 否则每步都要等文件系统。实测它并不零 I/O：controlOf/stateOf 各一次 statSync（F-B，
   * 内容有 mtime:size 缓存）——这里如实描述，不再宣称「零 I/O」。其余走内存表：
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
      return {
        state: 'ready',
        ingested: Number.isInteger(entry.records) ? entry.records : null,
        searchable: Number.isInteger(entry.searchable) ? entry.searchable : null,
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
    importSession,
    adoptFrom,
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
    dispose() {
      disposed.value = true
      // 在飞回填：置中断位（批间生效），不再等待；已写入的节点在磁盘上仍然幂等。
      for (const job of backfillJobs.values()) job.controller.aborted = true
      backfillJobs.clear()
      for (const timer of rebuildTimers.values()) clearTimeout(timer)
      rebuildTimers.clear()
      for (const { runtime } of runtimes.values()) {
        try { runtime.close() } catch {}
      }
      runtimes.clear()
      // H-57：在飞建库也要作废——否则落定时会重新入表（见 ensureEntry 的 disposed 分支）
      pendingEntries.clear()
      if (typeof off === 'function') off()
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
      if (typeof query !== 'string' || query.trim().length === 0) {
        injection.skipped += 1
        injection.lastStatus = 'empty-query'
        return { status: 'empty-query' }
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
      if (!entry) {
        injection.skipped += 1
        injection.lastStatus = 'no-session'
        return { status: 'no-session' }
      }
      if (entry.inflight !== null) {
        injection.skipped += 1
        injection.lastStatus = 'busy'
        return { status: 'busy' }
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
        const chars = [...query]
        const boundedQuery = queryMaxChars !== null && chars.length > queryMaxChars ? chars.slice(0, queryMaxChars).join('') : query
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
        injection.failed += 1
        injection.lastStatus = 'failed'
        injection.lastError = { code: error?.code ?? 'EINTERNAL', message: error?.message ?? String(error), at: Date.now() }
        return { status: 'failed', error: injection.lastError }
      }
      if (outcome?.injected === true && typeof outcome.text === 'string' && outcome.text.length > 0) {
        injection.injected += 1
        injection.lastInjectedAt = Date.now()
        injection.lastStatus = 'injected'
        injection.lastHits = outcome.hits?.length ?? null
        await markReadLease(sessionId, (outcome.hits ?? []).map((hit) => hit.id))
        return { status: 'injected', text: outcome.text, hits: outcome.hits, omittedHits: outcome.omittedHits }
      }
      injection.skipped += 1
      injection.lastStatus = 'skipped'
      injection.lastReason = outcome?.reason ?? 'unknown'
      return { status: 'skipped', reason: injection.lastReason }
    },
    stats() {
      const out = { ingestMetrics: Object.fromEntries(entryMetrics), injection: injectionSnapshot() }
      for (const [sessionId, { runtime, lastSeq, records, inflight }] of runtimes) {
        out[sessionId] = { lastSeq, records, ingesting: inflight !== null, metrics: runtime.metrics() }
      }
      return out
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
