import { appendUsageLine, readUsageSummary } from '../adapters/storage/usage-log.mjs'
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

const MEMORY_EVENT_TYPES = new Set(['user/message', 'assistant/message', 'tool/call', 'tool/result'])

/** 插件自有来源标识（index.mjs 写入 source.kind；2026-10-25 拍板：自家生成物不入影子库）。 */
const OWN_SOURCE_KIND = 'dsh-memory-context-lab'

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
  // Authorization: Bearer xxx / Basic xxx
  [/\b(authorization\s*[:=]\s*)(bearer|basic|token)?\s*([A-Za-z0-9._~+/=-]{8,})/gi, '$1[REDACTED]'],
  // key=value / key: value 形态的常见凭据名
  [/\b(api[-_]?key|access[-_]?token|refresh[-_]?token|secret|password|passwd|credential|token)\b(\s*[:=]\s*)(["']?)([^\s"',&;]{4,})\3/gi, '$1$2$3[REDACTED]$3'],
  // sk- 开头的常见密钥前缀
  [/\bsk-[A-Za-z0-9_-]{8,}/g, '[REDACTED]'],
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
    const text = textOfBlocks(data.message?.content) || textOfBlocks(data.content) || (typeof data.text === 'string' ? data.text : '')
    const body = text ? { text } : { text: '', metaOnly: true, reason: 'assistant 无可见文本块' }
    const usage = usageOf(data.usage)
    if (usage) body.usage = usage
    return body
  }
  if (type === 'tool/result') {
    const text = textOfBlocks(data.message?.content) || textOfBlocks(data.content)
    if (data.error !== undefined && text) return { text: text + '\n[工具结果：错误态]' }
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
  const runtimes = new Map()
  // 首次挂载的建库任务（H-19）：建 runtime + 断点反推是 O(记录数) 磁盘活
  // （open 读全部日志、resumeCheckpointOf 逐条读 provenance）。旧实现把它 await 在
  // pre-step 里，会话越长首个 pre-step 越慢（实测 5000 条 = 450ms），正是 beta.1
  // 「钩子阻塞首字」的形态。现在改为后台建库、钩子立即返回，下一步/建好后续传摄入。
  const pendingEntries = new Map() // sessionId → Promise<entry>
  const entryMetrics = new Map() // sessionId → { runtime, lastSeq }
  const makeRuntime = options.runtimeFactory ?? (async (dshSession, sessionId) => createV3Runtime({
    v3Root,
    dshSession,
    sessionKey: sessionId,
  }))
  const disposed = { value: false }

  // 摄入批大小：回填按批走事务；新事件通常 1-3 条一批
  const INGEST_BATCH = 100

  async function ingestAll(entry, log) {
    let batch = []
    let batchFirstSeq = null
    let ingested = 0
    for (const raw of log) {
      if (disposed.value) return
      if (!MEMORY_EVENT_TYPES.has(raw?.type)) continue
      // 自家生成物（工作状态卡/回执/回注包）不入库：每步一张、高度重复，
      // 会以高频词霸占检索位（检索冒烟实测 31× 重复污染）。seq 照常推进。
      if (raw?.data?.source?.kind === OWN_SOURCE_KIND) continue
      if (Number.isInteger(entry.lastSeq) && raw.seq <= entry.lastSeq) continue
      batch.push(raw)
      batchFirstSeq = batchFirstSeq ?? raw.seq
      if (batch.length >= INGEST_BATCH) {
        await ingestBatch(entry, batch, batchFirstSeq)
        ingested += batch.length
        batch = []
        batchFirstSeq = null
      }
    }
    if (batch.length > 0 && !disposed.value) {
      await ingestBatch(entry, batch, batchFirstSeq)
      ingested += batch.length
    }
    // 只有回填（大批量）才在这里重建索引；每步 1-3 条的小增量留 stale，
    // 检索时懒重建——否则每步全量重建 11.5MB 索引会卡住宿主事件循环（首字慢）。
    if (!disposed.value && ingested >= INGEST_BATCH) {
      try { await entry.runtime.store.rebuildIndex() } catch (error) {
        ctx.logger?.warn?.('memory-context-lab-v3: 索引重建失败（检索时会自动重试）：' + (error?.message ?? String(error)))
      }
    }
  }

  /**
   * 持久断点（H-01）：已提交记录里出现过的最大宿主 seq。
   * 无记录 → -1（首事件 seq=0 不漏）；读失败 → 抛出，由调度层告警后保持 -1（不静默当作没有）。
   */
  async function resumeCheckpointOf(runtime) {
    let last = -1
    for (const sourceEventId of await runtime.store.sourceEventIds()) {
      const seq = seqOfDshEventId(sourceEventId)
      if (seq !== null && seq > last) last = seq
    }
    return last
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
      const lastSeq = await resumeCheckpointOf(runtime)
      if (disposed.value) discard()
      const entry = { runtime, lastSeq, inflight: null }
      runtimes.set(sessionId, entry)
      pendingEntries.delete(sessionId)
      return entry
    })()
    promise.catch(() => { pendingEntries.delete(sessionId) })
    pendingEntries.set(sessionId, promise)
    return promise
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
    try {
      let applied = 0
      for (const raw of batch) {
        const body = bodyOf(raw)
        const result = await entry.runtime.handleDshEvent(raw, body.text, { metaOnly: body.metaOnly === true, metaReason: body.reason ?? '', structure: body.structure ?? undefined })
        if (body.metaOnly === true) metricsNote('v3.ingest.metadataOnly')
        if (body.usage !== undefined) await appendUsage(entry, raw, body.usage)
        if (result?.status === 'applied' || result?.status === 'rejected') entry.lastSeq = raw.seq
        if (result?.status === 'applied') applied += 1
        if (result?.status === 'rejected') {
          ctx.logger?.warn?.('memory-context-lab-v3: 事件被拒绝 seq=' + raw.seq + '：' + (result.errors ?? []).join('；'))
        }
      }
      ctx.logger?.info?.('memory-context-lab-v3: 摄入批完成（起 seq=' + firstSeq + '，' + applied + '/' + batch.length + ' 条）')
    } catch (error) {
      // 影子模式不干扰宿主：摄入失败只告警，断点停在已完成处，下一步续传
      ctx.logger?.warn?.('memory-context-lab-v3: 影子摄入失败（seq 起 ' + firstSeq + '）：' + (error?.message ?? String(error)))
    }
  }

  const off = ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next()
    if (decision?.kind !== 'enter' || signal?.aborted) return decision
    if (disposed.value) return decision
    try {
      const session = agent?.session
      const sessionId = String(session?.id ?? '')
      if (!sessionId) return decision
      // 真实宿主：session.log 数组（dsh-session 源码核验 2026-10-24）；替身：events() 函数
      const log = Array.isArray(session?.log) ? session.log : (typeof session?.events === 'function' ? session.events() : null)
      if (log === null) return decision
      const entry = runtimes.get(sessionId)
      if (entry === undefined) {
        // 首次挂载：建库在后台跑，**本步不 await**（H-19：钩子必须毫秒级返回）。
        ensureEntry(session, sessionId)
          .then((created) => { startIngest(created, session) })
          .catch((error) => ctx.logger?.warn?.('memory-context-lab-v3: 影子调度失败（建库）：' + (error?.message ?? String(error))))
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
    return { lastSeq: entry.lastSeq, ingesting: entry.inflight !== null, health, usage, usageError }
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
    return await entry.runtime.provider.read(String(recordId))
  }

  return {
    inspect,
    search: searchReadOnly,
    read: readReadOnly,
    dispose() {
      disposed.value = true
      for (const { runtime } of runtimes.values()) {
        try { runtime.close() } catch {}
      }
      runtimes.clear()
      // H-57：在飞建库也要作废——否则落定时会重新入表（见 ensureEntry 的 disposed 分支）
      pendingEntries.clear()
      if (typeof off === 'function') off()
    },
    stats() {
      const out = { ingestMetrics: Object.fromEntries(entryMetrics) }
      for (const [sessionId, { runtime, lastSeq, inflight }] of runtimes) {
        out[sessionId] = { lastSeq, ingesting: inflight !== null, metrics: runtime.metrics() }
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
        const busy = [...runtimes.values()].filter((e) => e.inflight !== null)
        if (busy.length === 0) return
        await Promise.all(busy.map((e) => e.inflight))
      }
    },
  }
}
