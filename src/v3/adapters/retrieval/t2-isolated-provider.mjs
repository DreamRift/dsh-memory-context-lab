/**
 * T2 隔离记忆提供者（adapters/retrieval，0.14.0-beta.35）。
 *
 * 形态：**T1 本地词法索引 + 隔离灵枢** 的复合 provider。
 * - `search`：T1 结果 + 隔离根 `cg(read, query)` 结果融合；外部失败只损失外部，
 *   T1 永远照常返回（不因 T2 挂掉而回注全灭）；
 * - `read`：本地记录以本地为准（含遗忘/会话归属错误一律原样抛出，绝不从镜像复活）；
 *   本地不存在时才按 ID 读隔离根；
 * - `mirrorRecord`：把已提交记录镜像到隔离根（同 ID、带 CCG 六要素），
 *   串行后台队列，失败只计数不回滚本地；
 * - `forgetRecords`：本地遗忘后同步遗忘镜像（尽力而为，失败可见）。
 *
 * 隔离不变量：镜像只写 `MDCG_ROOT=<会话>/t2-mdcg`，不写正式灵枢根。
 */
import { assertPort } from '../../ports/index.mjs'
import { T2_MIRROR_NODE_RE, T2_SMOKE_NODE_ID, v3Error, V3ContractViolation } from '../../contracts/index.mjs'
import { t2ContractOf } from '../../contracts/t2-contract.mjs'

/** 镜像节点 ID 与本地记录 ID 同形；recall 的精确 ID 判据可直接识别（契约单一真源）。 */
const RECORD_ID_RE = T2_MIRROR_NODE_RE

/** 队列上限：回填时镜像落后于摄入，但不能无界吃内存。 */
export const T2_MIRROR_QUEUE_LIMIT = 5000

/** P2-16：最近失败保留条数（有界；状态面据此展示「不同原因」而不是只剩最后一条）。 */
export const T2_MIRROR_FAILURE_KEEP = 5

/** 单次外部检索最多接受的条数（防止远端返回超长列表撑爆回注预算）。 */
const T2_EXTERNAL_LIMIT = 50

function numberOf(value, fallback) {
  return Number.isFinite(value) ? value : fallback
}

/** 外部检索默认上限（毫秒）：只在调用方没有给统一截止时间时兜底。 */
export const T2_EXTERNAL_SEARCH_DEFAULT_TIMEOUT_MS = 10000

/**
 * 单次外部检索的**硬顶**（毫秒）：显式 deadline 可以比默认值更大，但不得超过它。
 *
 * P2 修复（2026-11-01）：旧实现无条件 `Math.min(10000, remaining)`，把调用方给的
 * 显式截止时间**静默夹到 10 秒**——文档却说「尊重统一 deadline」。现在只保留这里的
 * 文档化硬顶（MCP 请求本身不能被硬取消，超过一分钟的等待对回注没有意义），
 * 10 秒退化为「没有 deadline 时的默认值」。详见 docs/dev-0.15.0/P5-T1命中窗口与灵枢基础兼容.md §4.3。
 */
export const T2_EXTERNAL_SEARCH_MAX_TIMEOUT_MS = 60000

/**
 * 按版本合同构造 `cg read(query)` 参数（P5 / R09）。
 *
 * - 合同已验证的版本只发合同参数（0.9.17：read 分支读 `k`，`limit` 只影响 recent）；
 * - 未验证的版本同时带 `k` 与 `limit`（两者都在 schema 内），并在能力面标 contract，
 *   不假装已验证；
 * - k 同时受外部条数上限与合同 maxK 约束，超界由版本自身返回 warning（partial）。
 */
export function externalSearchArgsOf(contract, query, { session, limit }) {
  const wanted = Math.min(T2_EXTERNAL_LIMIT, Math.max(1, Number.isInteger(limit) && limit > 0 ? limit : 10))
  const maxK = Number.isInteger(contract?.readSearchLimitMax) ? contract.readSearchLimitMax : T2_EXTERNAL_LIMIT
  const k = Math.min(wanted, maxK)
  const args = { op: 'read', query, session, k }
  if (contract?.readQueryVerified !== true) args.limit = k
  return args
}

/**
 * 协作式取消 + 截止时间：任一先到就停止等待，晚到的外部结果丢弃。
 * MCP 请求本身无法硬取消（客户端只做到超时拒绝），因此这里只保证**调用方不被拖住**，
 * 不宣称远端已停止执行。
 */
function raceWithSignal(promise, signal, timeoutMs) {
  const hasSignal = signal !== null && signal !== undefined && typeof signal.addEventListener === 'function'
  const hasTimer = Number.isFinite(timeoutMs) && timeoutMs > 0
  if (!hasSignal && !hasTimer) return promise.then((value) => ({ value }), (error) => ({ error }))
  if (hasSignal && signal.aborted === true) {
    promise.catch(() => {})
    return Promise.resolve({ aborted: true })
  }
  return new Promise((resolve) => {
    let settled = false
    let timer = null
    const finish = (value) => {
      if (settled) return
      settled = true
      if (timer !== null) clearTimeout(timer)
      if (hasSignal) signal.removeEventListener('abort', onAbort)
      resolve(value)
    }
    const onAbort = () => {
      promise.catch(() => {})
      finish({ aborted: true })
    }
    if (hasSignal) signal.addEventListener('abort', onAbort, { once: true })
    if (hasTimer) {
      timer = setTimeout(() => {
        promise.catch(() => {})
        finish({ timedOut: true })
      }, timeoutMs)
      // 不 unref：超时定时器必须**自己保证**事件循环还活着，否则等超时的调用方在
      // 没有其它活跃句柄时会被运行时判成「事件循环已空」而取消/提前结算
      // （node --test 22.x 实测 5 个取消/超时用例被 cancelled）。定时器在结算时
      // 一定 clearTimeout，最长存活时间就是 timeoutMs（有硬顶 60s）。
    }
    promise.then((value) => finish({ value }), (error) => finish({ error }))
  })
}

function sourceLabelFor(status) {
  if (status === 'partial') return '本地词法索引 + 隔离灵枢（T2，部分结果）'
  if (status === 'cancelled') return '本地词法索引（T2 已取消，回退 T1）'
  if (status === 'failed') return '本地词法索引（T2 失败，回退 T1）'
  if (status === 'unsupported') return '本地词法索引（T2 检索未启用）'
  return '本地词法索引（T2 无新增命中）'
}

/** 资格四态归一（T2 行字段 state → 装包资格；缺失/未知一律 unknown，失败关闭）。 */
export function eligibilityOfState(state) {
  if (typeof state !== 'string') return 'unknown'
  const normalized = state.toUpperCase()
  if (normalized === 'ACCEPT') return 'eligible'
  if (normalized === 'DEFER' || normalized === 'BLINDSPOT') return 'deferred'
  if (normalized === 'REJECT') return 'rejected'
  return 'unknown'
}

/**
 * 融合本地/外部命中。
 *
 * 分数尺度（P5 / R03）：本地是 BM25（量纲大），隔离根是 RRF（0–1）。直接相加会让外部
 * 命中永远排在本地之后，所以**展示面**按各自第一名归一化到 0–1 仅用于排序。
 * 但**归一化分不得跨过装包阈**：RRF 第 1 名恒为 1.0 是名次量，不是相关强度——
 * 弱候选不能因为「外部只有它一条」就穿 pack 门。自动装包只收本地 pack 命中；
 * 外部命中只有在 packExternal 能力显式开启、且资格为 eligible 时才允许进包。
 *
 * 装包面是**本地 pack 与展示面的并集**：旧实现只从 mergedAll（= display + external）里
 * 筛 localPackIds，本地 pack 里不在 display 的命中会被静默丢掉（P3 回归）。
 * 这里不再接收 `packMinScore`：本地 pack 已由 T1 按 BM25 原分过阈，重复判断只会
 * 产生第二个阈值真源。
 *
 * @param {object} local T1 search 结果
 * @param {Array<{id:string, score:number, state?:string|null, reason?:string|null, eligibility?:string}>} external
 * @param {object} opts { limit, packExternal }
 * @returns {object} 与 T1 同形 + sourceLabel + externalHits + externalEligibility
 */
export function mergeHits(local, external, { limit = 10, packExternal = false } = {}) {
  const localDisplay = Array.isArray(local?.display) ? local.display : []
  const localPack = Array.isArray(local?.pack) ? local.pack : []
  const maxLocal = Math.max(0, ...localDisplay.map((hit) => numberOf(hit?.score, 0)))
  const byId = new Map()
  for (const hit of localDisplay) {
    if (typeof hit?.id !== 'string' || hit.id.length === 0) continue
    byId.set(hit.id, {
      ...hit,
      score: maxLocal > 0 ? numberOf(hit.score, 0) / maxLocal : 0,
      rawScore: numberOf(hit.score, 0),
      source: 'local',
      eligibility: 'eligible',
    })
  }
  const localPackIds = new Set(localPack.map((hit) => hit?.id).filter((id) => typeof id === 'string'))
  let externalHits = 0
  const counts = { eligible: 0, deferred: 0, rejected: 0, unknown: 0 }
  for (let index = 0; index < external.length; index += 1) {
    const hit = external[index]
    if (typeof hit?.id !== 'string' || !RECORD_ID_RE.test(hit.id)) continue
    externalHits += 1
    const eligibility = ['eligible', 'deferred', 'rejected', 'unknown'].includes(hit.eligibility)
      ? hit.eligibility
      : eligibilityOfState(hit.state)
    counts[eligibility] += 1
    if (byId.has(hit.id)) {
      // 两路都命中：本地有正文与精确分，保留本地分，仅标记交叉命中（不重复计分）。
      const existing = byId.get(hit.id)
      byId.set(hit.id, { ...existing, alsoExternal: true, externalEligibility: eligibility, externalReason: hit.reason ?? null })
      continue
    }
    // 外部独有：rankScore 只是展示排序量（第 1 名 = 1.0），不是 BM25，也不参与装包阈值。
    const rankScore = Math.max(0.01, 1 - index / Math.max(1, external.length))
    byId.set(hit.id, {
      id: hit.id,
      score: rankScore,
      rankScore,
      rawScore: numberOf(hit.score, 0),
      external: true,
      source: 't2',
      eligibility,
      state: typeof hit.state === 'string' ? hit.state : null,
      reason: typeof hit.reason === 'string' ? hit.reason : null,
    })
  }
  const mergedAll = [...byId.values()]
    .sort((a, b) => (b.score - a.score) || String(a.id).localeCompare(String(b.id)))
  const display = mergedAll.slice(0, Math.max(0, limit))
  // 装包面：本地 pack（T1 已按 BM25 原分过阈）+ 仅在能力开启时收 eligible 外部命中。
  // 并集口径：本地 pack 里若有 display 之外的条目，也必须留在装包面（fail-visible，不静默丢）。
  const packById = new Map()
  for (const hit of mergedAll) {
    if (localPackIds.has(hit.id)) packById.set(hit.id, hit)
  }
  for (const hit of localPack) {
    if (typeof hit?.id !== 'string' || hit.id.length === 0 || packById.has(hit.id)) continue
    packById.set(hit.id, {
      ...hit,
      score: maxLocal > 0 ? numberOf(hit.score, 0) / maxLocal : 0,
      rawScore: numberOf(hit.score, 0),
      source: 'local',
      eligibility: 'eligible',
      packOnly: true,
    })
  }
  if (packExternal === true) {
    for (const hit of mergedAll) {
      if (hit.source === 't2' && hit.eligibility === 'eligible') packById.set(hit.id, hit)
    }
  }
  const pack = [...packById.values()].sort((a, b) => (b.score - a.score) || String(a.id).localeCompare(String(b.id)))
  return {
    ...local,
    display,
    pack,
    sourceLabel: externalHits > 0 ? '本地词法索引 + 隔离灵枢（T2）' : '本地词法索引（T2 无新增命中）',
    externalHits,
    externalEligibility: counts,
  }
}

/** 镜像正文：六要素各占一行，保住 dsh-memory 的 text 写入闸。 */
export function mirrorContentOf(record) {
  const text = typeof record?.payload?.text === 'string' ? record.payload.text : ''
  const session = typeof record?.sessionKey === 'string' ? record.sessionKey : 'unknown'
  const kind = typeof record?.kind === 'string' ? record.kind : 'unknown'
  const source = typeof record?.provenance?.sourceEventId === 'string' ? record.provenance.sourceEventId : 'unknown'
  return [
    '# 功能名：v3 会话记录镜像 ' + String(record?.id ?? ''),
    '# 生效条件：会话 ' + session + ' 的 ' + kind + ' 记录（来源事件 ' + source + '）已提交到 v3 本地库',
    '# 子功能：原文镜像；可按 ID 精确回读；供隔离灵枢检索补充',
    '# 执行：' + text,
    '# 验证方式：镜像源 ' + String(record?.id ?? '') + '；本地 v3 记录为权威，镜像只作检索副本',
    '# 不适用条件：不是正式灵枢知识；仅隔离 MDCG_ROOT；不作为事实来源，删除以本地为准',
  ].join('\n')
}

/**
 * 创建 T2 隔离提供者。
 *
 * @param {object} deps
 * @param {object} deps.t1 T1 provider（必须）
 * @param {object} deps.client 已握手的 MCP 客户端（probe 交回）
 * @param {string} deps.sessionKey 会话隔离键（镜像归因）
 * @param {object} [deps.metrics]
 * @param {string} [deps.root] 诊断用隔离根
 * @param {object} [deps.capabilities] 能力协商报告（contracts/t2-contract.t2CapabilitiesOf）；
 *   缺省按「合同面但未验证」处理：检索可用、自动装包一律关闭
 * @param {Function} [deps.now] 时钟注入（截止时间测试用）
 */
export function createT2IsolatedProvider({ t1, client, sessionKey, metrics, root = '', capabilities: capabilityReport = null, now = () => Date.now() } = {}) {
  assertPort('MemoryProvider', t1)
  if (client === null || typeof client !== 'object' || typeof client.callTool !== 'function') {
    throw new V3ContractViolation('v3 t2-provider: 需要已握手的 MCP client')
  }
  if (typeof sessionKey !== 'string' || sessionKey.length === 0) {
    throw new V3ContractViolation('v3 t2-provider: sessionKey 必须是非空字符串')
  }

  // P5 能力门：searchQuery=off（探针失败/合同不支持）→ 不发起外部检索，直接 T1。
  // packExternal 默认关闭：RRF 名次分不得穿本地 pack 阈（R03）。
  const providerVersion = typeof capabilityReport?.providerVersion === 'string' ? capabilityReport.providerVersion : ''
  const contract = t2ContractOf(providerVersion)
  const searchFeatureState = capabilityReport?.features?.searchQuery?.state === 'on'
    ? 'on'
    : capabilityReport?.features?.searchQuery?.state === 'off'
      ? 'off'
      : 'contract'
  const searchEnabled = searchFeatureState !== 'off'
  const packExternalEnabled = capabilityReport?.packExternal?.state === 'on'

  const queue = []
  let draining = false
  let closed = false
  let drainPromise = null
  let mirrored = 0
  let mirrorFailed = 0
  let mirrorUnverified = 0
  let mirrorRejected = 0
  let mirrorDropped = 0
  let forgetFailed = 0
  let lastError = null
  // 已遗忘 ID：本地遗忘先于镜像队列落定时，晚到的写不得把正文重新写回隔离根。
  const forgottenIds = new Set()

  /**
   * P2-16：最近失败**不是一个槽**。旧实现 `lastError` 单槽，后一次失败覆盖前一次，
   * 于是「镜像被拒」紧接着「队列满」之后，状态面只剩队列满——不同原因的失败被静默折叠，
   * 排障时看不到真正的第一现场。这里保留**最近 N 条**（环形、有界，避免无限增长），
   * 并维持 `lastError`（最新一条的文本）向后兼容。
   */
  const recentFailures = []
  const noteFailureText = (text) => {
    lastError = text
    recentFailures.push(text)
    if (recentFailures.length > T2_MIRROR_FAILURE_KEEP) recentFailures.shift()
  }
  function noteFailure(prefix, error) {
    noteFailureText(prefix + ': ' + (error instanceof Error ? error.message : String(error)))
    metrics?.counter?.('v3.t2.' + prefix, 1)
  }

  async function drain() {
    if (draining) return
    draining = true
    drainPromise = (async () => {
      while (queue.length > 0) {
        const record = queue.shift()
        if (forgottenIds.has(record.id)) {
          // 本地已遗忘：即使写请求还在队列里也不得落到隔离根。
          mirrorDropped += 1
          metrics?.counter?.('v3.t2.mirrorSkippedForgotten', 1)
          continue
        }
        try {
          const writeResult = await client.callTool('cg', {
            op: 'write',
            node_id: record.id,
            content: mirrorContentOf(record),
            content_kind: 'text',
            session: sessionKey,
            tags: ['mcl-v3', 'mcl-session-' + String(sessionKey).slice(0, 16)],
            importance: 0.2,
            consistency: false,
          }, { timeoutMs: 10000 })
          // callTool 已将 MCP text 中的 JSON 解码为顶层对象；只接受合同中的精确状态，
          // 不从 structuredContent、大小写变体或其它形状推断 ACCEPT。
          const auditState = typeof writeResult?.state === 'string' ? writeResult.state : ''
          if (auditState === 'ACCEPT') {
            mirrored += 1
            metrics?.counter?.('v3.t2.mirrorOk', 1)
          } else if (['DEFER', 'REJECT', 'BLINDSPOT'].includes(auditState)) {
            mirrorRejected += 1
            noteFailureText('mirrorRejected: 审核态 ' + auditState + '（本地提交保留；不重试）')
            metrics?.counter?.('v3.t2.mirrorRejected', 1)
          } else {
            mirrorUnverified += 1
            noteFailureText('mirrorUnverified: 写入后未取得可识别 ACCEPT 审核态（本地提交保留；不重试）')
            metrics?.counter?.('v3.t2.mirrorUnverified', 1)
          }
        } catch (error) {
          mirrorFailed += 1
          noteFailure('mirrorFailed', error)
        }
      }
    })().finally(() => {
      draining = false
      drainPromise = null
    })
    await drainPromise
  }

  /**
   * 入队镜像；同步返回，不阻塞摄入。`undo:true` 用于撤销遗忘后的重建。
   *
   * P2-16：返回值必须**说清这次请求发生了什么**。旧实现恒返回 `undefined`，调用方只能
   * 事后从 `mirrorStats()` 的计数里倒推「刚才那次到底进没进队」，而计数还会被并发任务
   * 掺和。现在返回 `{ enqueued, reason, label }`：`enqueued=true` 表示已入队（异步落盘），
   * 其余情况给出**具体**原因（closed / invalid-record / forgotten / metadata-only / queue-full）。
   */
  function mirrorRecord(record, { undo = false } = {}) {
    if (closed) {
      mirrorDropped += 1
      noteFailureText('mirrorDropped: provider closed（请求静默丢弃）')
      metrics?.counter?.('v3.t2.mirrorDropped', 1)
      return { enqueued: false, reason: 'closed', label: 'mirrorDropped' }
    }
    if (record === null || typeof record !== 'object' || typeof record.id !== 'string' || !RECORD_ID_RE.test(record.id)) {
      mirrorDropped += 1
      metrics?.counter?.('v3.t2.mirrorSkipped', 1)
      return { enqueued: false, reason: 'invalid-record', label: 'mirrorSkipped' }
    }
    if (forgottenIds.has(record.id)) {
      if (undo !== true) {
        mirrorDropped += 1
        metrics?.counter?.('v3.t2.mirrorSkippedForgotten', 1)
        return { enqueued: false, reason: 'forgotten', label: 'mirrorSkippedForgotten' }
      }
      forgottenIds.delete(record.id)
    }
    // metadata-only 记录没有正文：镜像一个空壳没有检索价值，只浪费一次进程往返。
    if (typeof record?.payload?.text !== 'string' || record.payload.text.length === 0) {
      mirrorDropped += 1
      metrics?.counter?.('v3.t2.mirrorSkipped', 1)
      return { enqueued: false, reason: 'metadata-only', label: 'mirrorSkipped' }
    }
    if (queue.length >= T2_MIRROR_QUEUE_LIMIT) {
      mirrorDropped += 1
      noteFailure('mirrorDropped', new Error('镜像队列已满（' + T2_MIRROR_QUEUE_LIMIT + '），本批只记本地'))
      return { enqueued: false, reason: 'queue-full', label: 'mirrorDropped' }
    }
    queue.push(record)
    // 延后一个微任务再 drain：同一同步批里紧接着的 forget 可以先标记，
    // 避免「刚入队就遗忘」时先写后删的白跑一次。
    queueMicrotask(() => { void drain() })
    return { enqueued: true, reason: null, label: 'mirrorOk', id: record.id }
  }

  async function externalSearch(query, { limit, deadline, signal }) {
    const counts = { eligible: 0, deferred: 0, rejected: 0, unknown: 0 }
    if (signal?.aborted === true) {
      return { hits: [], counts, status: 'cancelled', warning: null, reason: '外部检索已取消（未发出请求）' }
    }
    // 显式 deadline 优先（只受文档化硬顶约束）；没有 deadline 才用默认值。
    // 旧实现把两者都夹到 10 秒，等于调用方设的 30 秒预算被静默缩水（P2）。
    const remaining = Number.isFinite(deadline) ? deadline - now() : T2_EXTERNAL_SEARCH_DEFAULT_TIMEOUT_MS
    if (remaining <= 0) {
      metrics?.counter?.('v3.t2.searchDeadlineMissed', 1)
      return { hits: [], counts, status: 'cancelled', warning: null, reason: '外部检索截止时间已到（T1 结果照常返回）' }
    }
    const timeoutMs = Math.max(1, Math.min(T2_EXTERNAL_SEARCH_MAX_TIMEOUT_MS, remaining))
    try {
      const args = externalSearchArgsOf(contract, query, { session: sessionKey, limit })
      const outcome = await raceWithSignal(client.callTool('cg', args, { timeoutMs }), signal, timeoutMs)
      if (outcome.aborted === true) {
        metrics?.counter?.('v3.t2.searchCancelled', 1)
        return { hits: [], counts, status: 'cancelled', warning: null, reason: '外部检索在截止时间内未返回（已取消，晚到结果丢弃）' }
      }
      if (outcome.timedOut === true) {
        metrics?.counter?.('v3.t2.searchTimeout', 1)
        return { hits: [], counts, status: 'partial', warning: null, reason: '外部检索超时（已回退 T1，晚到结果丢弃）' }
      }
      if (outcome.error !== undefined) throw outcome.error
      const result = outcome.value
      const rows = Array.isArray(result?.results) ? result.results : []
      const hits = []
      for (const row of rows) {
        const id = row?.node?.id ?? row?.id
        if (typeof id !== 'string' || !RECORD_ID_RE.test(id)) continue
        const eligibility = eligibilityOfState(row?.state)
        counts[eligibility] += 1
        hits.push({
          id,
          score: numberOf(row?.score, 0),
          state: typeof row?.state === 'string' ? row.state : null,
          reason: typeof row?.reason === 'string' ? row.reason : null,
          eligibility,
        })
      }
      hits.sort((a, b) => (b.score - a.score) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      // partial 判据：版本 warning（k 越界/夹紧）或返回体显式 truncated。
      const warning = result?.warning
      const truncated = result?.truncated === true || result?.meta?.truncated === true
      const partial = (warning !== null && typeof warning === 'object' && typeof warning.code === 'string') || truncated
      return {
        hits,
        counts,
        status: partial ? 'partial' : 'success',
        warning: partial && typeof warning?.code === 'string' ? warning.code : null,
        reason: partial
          ? (typeof warning?.hint === 'string' ? warning.hint : '外部结果被截断（partial）')
          : null,
      }
    } catch (error) {
      // 超时按 partial（时间预算用尽，不是「后端没有数据」）；其他错误按 failed。
      const timeout = /超时|timed out|timeout/i.test(error instanceof Error ? error.message : String(error))
      noteFailure(timeout ? 'searchTimeout' : 'searchFailed', error)
      return {
        hits: [],
        counts,
        status: timeout ? 'partial' : 'failed',
        warning: null,
        reason: (timeout ? '外部检索超时（已回退 T1）' : '外部检索失败（已回退 T1）：') + (error instanceof Error ? error.message : String(error)),
      }
    }
  }

  async function search(query, { limit = 10, resultMinScore = 0, packMinScore = 0, allowRebuild = true, deadline = null, signal = null } = {}) {
    if (typeof query !== 'string' || query.length === 0) {
      throw new V3ContractViolation('v3 t2-provider: 查询必须是非空字符串')
    }
    const local = await t1.search(query, { limit, resultMinScore, packMinScore, allowRebuild })
    if (!searchEnabled) {
      // 能力未协商通过：不发起外部查询，T1 结果原样返回（fail-closed，且不付外部等待）。
      metrics?.counter?.('v3.t2.searchUnsupported', 1)
      return {
        ...local,
        status: 'unsupported',
        partial: false,
        t1Fallback: true,
        reason: capabilityReport?.features?.searchQuery?.reason ?? 'T2 检索能力未协商通过',
        sourceLabel: sourceLabelFor('unsupported'),
        externalHits: 0,
        externalEligibility: { eligible: 0, deferred: 0, rejected: 0, unknown: 0 },
      }
    }
    // 索引还没就绪时外部仍可检索；但此时本地为空不能把 T1 的 indexAbsent 标记丢掉。
    const external = await externalSearch(query, { limit, deadline, signal })
    if (external.hits.length === 0) {
      // 外部无新增（或失败/取消）：保持 T1 原分数尺度，不因为装了 T2 就改变本地结果。
      metrics?.counter?.('v3.t2.searchNoExternal', 1)
      return {
        ...local,
        sourceLabel: sourceLabelFor(external.status),
        externalHits: 0,
        externalEligibility: external.counts,
        status: external.status,
        partial: external.status === 'partial',
        t1Fallback: external.status !== 'success',
        reason: external.reason,
      }
    }
    // packMinScore 只交给 T1（本地阈值单一真源），融合面不再重复判一次。
    const merged = mergeHits(local, external.hits, { limit, packExternal: packExternalEnabled })
    metrics?.counter?.('v3.t2.search', 1)
    return {
      ...merged,
      status: external.status,
      partial: external.status === 'partial',
      // 已经有外部命中参与展示：这不是「完全回退 T1」，但 partial 仍如实为 true。
      t1Fallback: false,
      reason: external.reason,
      warning: external.warning,
    }
  }

  async function read(recordId) {
    if (typeof recordId !== 'string' || recordId.length === 0) {
      throw new V3ContractViolation('v3 t2-provider: recordId 必须是非空字符串')
    }
    let localError = null
    try {
      return await t1.read(recordId)
    } catch (error) {
      localError = error
    }
    // 隐私/隔离错误不得被镜像绕过：已遗忘、跨会话、损坏一律原样抛出。
    if (localError?.code === 'EFORGOTTEN' || localError?.code === 'ESTORE_SESSION_MISMATCH') throw localError
    const notFoundLocally = localError?.code === 'ERECORD_NOT_FOUND'
    if (!notFoundLocally) {
      throw localError
    }
    const result = await client.callTool('cg', { op: 'read', node_id: recordId }, { timeoutMs: 10000 })
    const text = typeof result?.content === 'string' ? result.content : ''
    if (text.length === 0) {
      throw v3Error('ERECORD_NOT_FOUND', '记录不存在：' + recordId + '（本地与隔离根都没有）')
    }
    const mirrorText = '[T2 六要素包装镜像副本；非本地原始正文]\n' + text
    const createdAt = Date.parse(result?.frontmatter?.created ?? '')
    return {
      text: mirrorText,
      record: {
        id: recordId,
        sessionKey,
        createdAt: Number.isFinite(createdAt) ? createdAt : 0,
        payload: { text: mirrorText },
        provenance: { sourceForm: 't2-mirror' },
      },
    }
  }

  /** 本地遗忘后同步遗忘镜像；失败只计数（本地隐私面已生效，镜像失败可见）。 */
  async function forgetRecords(recordIds) {
    if (!Array.isArray(recordIds) || recordIds.length === 0) return { forgotten: 0, failed: 0 }
    const ids = recordIds.filter((id) => typeof id === 'string' && RECORD_ID_RE.test(id))
    // 先标记、再等队列排空：晚到的写会被 drain 跳过，不会在 forget 之后把正文写回。
    for (const id of ids) forgottenIds.add(id)
    await flush()
    let forgotten = 0
    let failed = 0
    for (const id of ids) {
      try {
        await client.callTool('cg', { op: 'forget', node_id: id, override: true }, { timeoutMs: 10000 })
        forgotten += 1
      } catch (error) {
        failed += 1
        forgetFailed += 1
        noteFailure('forgetFailed', error)
      }
    }
    return { forgotten, failed }
  }

  /**
   * 索引统计（命令/诊断路径）：直接复用 T1 的索引解析缓存，不在这里再读一遍 22MB JSON。
   * 失败如实回 error/absent——「读不到」不得写成 0（0 会让「可检索」看起来像空库）。
   */
  async function indexStats() {
    if (typeof t1.indexStats !== 'function') return { state: 'unavailable', reason: 'T1 未提供索引统计' }
    return await t1.indexStats()
  }

  /**
   * 清理冒烟节点（P2，2026-10-28）：探测四步写过的 mcl-smoke 可能因清理失败残留在隔离根。
   * 它不属于任何真实会话，也不计入覆盖率；这里显式 forget 一次，失败如实回报。
   */
  async function cleanupSmoke() {
    try {
      await client.callTool('cg', { op: 'forget', node_id: T2_SMOKE_NODE_ID, override: true }, { timeoutMs: 10000 })
      return { ok: true, nodeId: T2_SMOKE_NODE_ID }
    } catch (error) {
      noteFailure('smokeCleanupFailed', error)
      return { ok: false, nodeId: T2_SMOKE_NODE_ID, error: error instanceof Error ? error.message : String(error) }
    }
  }

  async function health() {
    const local = await t1.health()
    return {
      ...local,
      t2: {
        isolated: true,
        root,
        mirrored,
        mirrorFailed,
        mirrorUnverified,
        mirrorRejected,
        mirrorDropped,
        pending: queue.length,
        draining,
        forgetFailed,
        lastError,
        recentFailures: [...recentFailures],
        providerVersion,
        contractId: capabilityReport?.contractId ?? null,
        schemaDigest: capabilityReport?.schemaDigest ?? null,
        searchQuery: searchFeatureState,
        packExternal: packExternalEnabled ? 'on' : 'off',
      },
    }
  }

  /**
   * 记录 chunk 窗口（G1 / C-G1-08）：T2 的**展示摘录仍以本地源为准**，这里只把本地
   * T1 的 chunk span 透出来。镜像正文是六要素包装，其偏移不得回切本地 payload.text
   * （P5 §4.1 queryExcerpt=off 的同一理由）。
   */
  async function chunksOf(recordId) {
    if (typeof t1.chunksOf !== 'function') return { state: 'absent', spans: [], truncated: false }
    return await t1.chunksOf(recordId)
  }

  /**
   * 分页快照（0.15.0 G1 / C-G1-10、U4）：T2 **没有**穷尽信号。
   *
   * 证据：`mergeHits` 只拿得到本地 top-k 与外部 k 条（`cg read(query,k)`），
   * 外部返回体没有 total/EOF 字段；融合排序还依赖外部名次分。因此这里显式
   * `exhaustive=false`：调用方不得给精确 total、不得铸造 cursor、不得假装「查全了」。
   * generation 仍报本地索引戳，供诊断「本地覆盖集合」与外部覆盖的差别，但不用于分页。
   */
  async function retrievalSnapshot() {
    const local = typeof t1.retrievalSnapshot === 'function' ? await t1.retrievalSnapshot() : null
    return {
      tier: 'T2',
      exhaustive: false,
      generation: typeof local?.generation === 'string' ? local.generation : null,
      localExhaustive: local?.exhaustive === true,
      reason: 'T2 只有 top-k（本地 top-k + 外部 k 条），没有可靠的穷尽信号',
    }
  }

  function capabilities() {
    return {
      name: 'local-lexical-v3+t2-isolated',
      tier: 'T2',
      live: true,
      isolated: true,
      root,
      mirrorQueueLimit: T2_MIRROR_QUEUE_LIMIT,
      // P5：报「实际生效」的能力状态（不是期望）；未提供协商报告时如实标 contract。
      providerVersion,
      contractId: capabilityReport?.contractId ?? null,
      schemaDigest: capabilityReport?.schemaDigest ?? null,
      searchQuery: searchFeatureState,
      packExternal: packExternalEnabled ? 'on' : 'off',
      features: capabilityReport?.features ?? null,
    }
  }

  async function flush(timeoutMs = 5000) {
    if (queue.length === 0 && !draining) return
    await Promise.race([
      (async () => {
        while (draining || queue.length > 0) {
          if (drainPromise !== null) await drainPromise.catch(() => {})
          else if (queue.length > 0) await drain()
          else break
        }
      })(),
      new Promise((resolve) => setTimeout(resolve, timeoutMs)),
    ])
  }

  async function close() {
    if (closed) return
    await flush()
    closed = true
    try { await client.close?.() } catch { /* 关闭失败不改变已 flush 的事实 */ }
  }

  return assertPort('MemoryProvider', {
    search,
    read,
    health,
    indexStats,
    capabilities,
    chunksOf,
    retrievalSnapshot,
    cleanupSmoke,
    mirrorRecord,
    forgetRecords,
    flush,
    close,
    mirrorStats() {
      return { mirrored, mirrorFailed, mirrorUnverified, mirrorRejected, mirrorDropped, pending: queue.length, forgetFailed, lastError, recentFailures: [...recentFailures] }
    },
  })
}
