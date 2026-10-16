/**
 * v2 的灵枢（lingshu / mdcg）检索后端 —— 真实实现，不是占位。
 *
 * 职责划分（每类事实只有一个权威来源）：
 * - **原文权威 = 本会话 ArchiveStore**（v2 冷库）。灵枢里放的只是**派生检索表示**：
 *   有界摘录 + 权威记录 ID + 少量元数据，用于让检索命中正文词。
 * - 命中后一律按**记录 ID 回 v2 冷库读权威原文**；绝不用灵枢里的摘录副本当原文，
 *   因此不存在「两个可互相覆盖的原文真相」。
 * - 灵枢侧节点 ID 直接复用 v2 记录 ID（`t00000001-r0000`），字符集落在
 *   `mdcg_remember` 的 `node_id` 允许范围内，且天然满足「同 ID 幂等」。
 *
 * 隔离：客户端由 `TemporaryLingshuClient` 起独立 Python 子进程，环境里
 * `MDCG_ROOT`/`STATE_ROOT`/`DATA_ROOT` 全部指向本会话隔离根（`buildIsolatedMdcgEnvironment`
 * 先剔除父进程全部 `MDCG_*`/`HIVE_*`/`PYTHON*`）。本模块**不**读取正式灵枢根：
 * 隔离客户端不可用时如实报不可用，绝不回退到正式库。
 *
 * 能力边界（照 0.8.1 真实契约，不按函数名猜）：
 * - `query` 走 `cg(op=read, query, k, session, view='receipt')`。条数参数是 **`k`**，
 *   不是 `limit`（`limit` 是 goal/recent/edges 的条数）。`view:'receipt'` 必须显式带，
 *   否则默认候选池把 `role:'tool-output'` 整类剔除，归档记录永远搜不到。
 * - 灵枢**没有向量语义检索**：`op=read` 是词法/结构阶梯 + 可选的白箱条件结构路
 *   （默认关，且只读节点声明的条件结构，不读查询词面）。因此本后端在状态面自称
 *   **「灵枢词法/结构检索」**，不冒充向量语义召回。
 */
import { RECEIPT_VIEW, TemporaryLingshuClient } from '../lingshu-lab-client.mjs'

export const LINGSHU_BACKEND_NAME = 'lingshu-mdcg-receipt'

/** 后端自称的能力描述：状态面照抄，不夸大。 */
export const LINGSHU_BACKEND_CAPABILITIES = Object.freeze({
  kind: 'lexical-structural',
  semanticVectors: false,
  view: RECEIPT_VIEW,
  note: '灵枢 op=read 的词法/结构阶梯；不含向量语义检索。命中只给记录 ID，正文一律回本会话冷库读。',
})

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * 交给灵枢的索引正文（派生表示，非原文）。
 *
 * 必须带上真实正文摘录：只送元数据会让「检索」永远搜不到库里确实存在的正文词，
 * 却仍报告命中可用 —— 那是把空索引冒充成召回。
 * `textTruncated` 时前缀进索引，并在正文里显式标注，避免把前缀当全文。
 */
export function indexBodyOf(record) {
  const lines = [
    `[v2 派生索引] 记录 ${record.id}`,
    `kind=${record.kind} fidelity=${record.fidelity} seq=${record.seq ?? 'unknown'}`,
  ]
  const spanKind = nonEmptyString(record.refs?.spanKind)
  if (spanKind) lines.push(`spanKind=${spanKind}`)
  const tools = Array.isArray(record.inline?.tools) ? record.inline.tools.filter(Boolean) : []
  if (tools.length > 0) lines.push(`tools=${tools.join(',')}`)
  const nodeId = nonEmptyString(record.inline?.nodeId)
  if (nodeId) lines.push(`nodeId=${nodeId}`)
  if (record.textTruncated === true) {
    lines.push(`（以下为前 ${record.textMaxBytes} 字节摘录，非全文；原文按记录 ID 回读）`)
  }
  lines.push('', record.text ?? '')
  return lines.join('\n')
}

/** 灵枢返回的命中形状 → 记录 ID 数组。形状不认识就抛，不静默当成「没有命中」。 */
export function recordIdsFromRecall(view) {
  if (!view || typeof view !== 'object') {
    throw new Error(`灵枢检索返回了非对象结果：${typeof view}`)
  }
  const results = view.results
  if (!Array.isArray(results)) {
    const reason = view.meta?.reason ?? view.error ?? 'unknown'
    throw new Error(`灵枢检索返回缺少 results 数组（reason=${reason}）`)
  }
  const ids = []
  for (const item of results) {
    const id = nonEmptyString(item?.node?.id) ?? nonEmptyString(item?.id)
    if (id) ids.push(id)
  }
  return ids
}

/**
 * 用已启动的隔离灵枢客户端构造检索后端。
 *
 * `index()` 逐条写入并**如实返回没写进去的条目**：调用方（`syncRetrievalIndex`）
 * 据此决定哪些记录**不能**标记为已索引 —— 把写失败的记录记成「已索引」，
 * 等于谎称索引完整，之后所有召回都会缺这一段且无人知晓。
 */
export function createLingshuSemanticBackend({ client, logger = null, name = LINGSHU_BACKEND_NAME }) {
  if (!client || typeof client.callTool !== 'function') {
    throw new Error('灵枢后端需要已启动的隔离客户端（提供 callTool）。')
  }

  async function rememberOne(record) {
    const body = indexBodyOf(record)
    const result = await client.callTool('mdcg_remember', {
      node_id: record.id,
      content: body,
      // 与 v1 同一套落点：不进门禁、上下文层、工具输出角色、按会话归因。
      gated: false,
      layer: 'contextual',
      role: 'tool-output',
      tags: ['dsh-memory-context-lab', 'v2', 'derived-index'],
      importance: 0.5,
      session: client.sessionId,
      // 关掉跨节点一致性检查：派生索引条目之间没有语义冲突可言，
      // 开着会让「条件不满足」的节点整批不落盘。
      consistency: false,
      on_conflict: 'record',
    })
    if (result && typeof result === 'object' && result.ok === false) {
      throw new Error(`灵枢拒收派生索引（${result.error ?? 'unknown'}）：${result.hint ?? 'no hint'}`)
    }
    if (result && typeof result === 'object' && result.committed === false) {
      // 同 ID 已存在不同正文时灵枢排入复核队列而非覆写。派生索引是幂等重写，
      // 所以必须回读核对：内容一致 = 重试成功；不一致 = 真实冲突，绝不放过。
      const existing = await client.getNode(record.id)
      const same = existing?.ok !== false && typeof existing?.text === 'string'
        && existing.text.includes(record.id)
      if (!same) {
        throw new Error(`灵枢未提交派生索引且回读不符（${record.id}）：同 ID 已持有不同正文`)
      }
      return { reused: true }
    }
    return { reused: false }
  }

  return {
    name,
    capabilities: LINGSHU_BACKEND_CAPABILITIES,
    async index(records) {
      const externalIds = {}
      const skipped = []
      const conflicts = []
      for (const record of Array.isArray(records) ? records : []) {
        // 没有正文的记录不索引：索引进去的只能是元数据，那对检索毫无用处，
        // 却会让记账把它当成「已索引」。
        if (typeof record?.text !== 'string' || record.text.length === 0) {
          skipped.push({ id: record?.id ?? null, reason: `text-${record?.textIntegrity ?? 'missing'}` })
          continue
        }
        try {
          await rememberOne(record)
          externalIds[record.id] = record.id
        } catch (error) {
          // 单条失败不连坐整批：记进 conflicts 让调用方如实报告，绝不假装成功。
          conflicts.push({ id: record.id, reason: error instanceof Error ? error.message : String(error) })
          logger?.warn?.(`v2 灵枢索引失败 ${record.id}：${error?.message ?? error}`)
        }
      }
      return { externalIds, skipped, conflicts }
    },
    async query(text, { limit = 20, exact = [], exclude = [] } = {}) {
      // exclude（P1-3）：灵枢服务端口径不接受本地排除集，客户端侧以
      // 「limit + 排除数」超量取回后复验（见 retrieval.mjs searchRecords）。
      // 精确通道（query-plan 产出）折叠回查询串：灵枢的词法检索在服务端整串
      // 进行，标识符/引号短语原样并入与用户手工输入同一形态，不改变服务端口径。
      const needleParts = [typeof text === 'string' ? text.trim() : '']
      for (const token of Array.isArray(exact) ? exact : []) {
        if (typeof token === 'string' && token.trim()) needleParts.push(token.trim())
      }
      const needle = needleParts.filter(Boolean).join(' ')
      const view = await client.callTool('cg', {
        op: 'read',
        query: needle,
        // 条数参数是 `k`：写成 `limit` 会静默失效（那是 goal/recent/edges 的条数）。
        k: Number.isInteger(limit) && limit > 0 ? limit : 5,
        session: client.sessionId,
        // 不带 receipt 视图，默认候选池会把 role:'tool-output' 整类剔除。
        view: RECEIPT_VIEW,
      })
      return recordIdsFromRecall(view)
    },
  }
}

/**
 * 按会话惰性创建/复用灵枢后端，并在会话停用时释放子进程。
 *
 * 每个会话一个隔离根（`storeRoot` = 该会话 v2 目录），因此后端天然按会话隔离；
 * `session` 参数只是归因过滤，**不作为权限边界**——真正的边界是独立 Python 进程
 * 与独立 root。
 */
export function createLingshuBackendProvider({
  lingshuPackageRoot,
  logger = null,
  python = undefined,
  createClient = TemporaryLingshuClient.create,
  name = LINGSHU_BACKEND_NAME,
}) {
  const entries = new Map()
  const rootMissingReason = lingshuPackageRoot
    ? null
    : '未定位到 @furongjun1999/dsh-memory，隔离灵枢不可用（不会回退到正式灵枢根）。'

  function describe() {
    return {
      available: rootMissingReason === null,
      reason: rootMissingReason,
      name,
      capabilities: LINGSHU_BACKEND_CAPABILITIES,
      sessions: entries.size,
    }
  }

  /**
   * 同步取用已启动的后端；**纯查询，不分配也不启动**。
   *
   * 这里刻意不「顺手建个 entry」：取用发生在每次检索的热路径上，若为未启动的会话
   * 建条目，长期运行会把每个见过的会话永久留在 Map 里——一个只读查询不该有
   * 任何内存副作用。真正要启动请走 `ensureBackend`。
   */
  function backendFor({ sessionId, storeRoot }) {
    if (rootMissingReason !== null) return null
    if (!nonEmptyString(sessionId) || !nonEmptyString(storeRoot)) return null
    const entry = entries.get(sessionId)
    if (!entry) return null
    // 已经失败过就不再每次重试：每次检索都去 spawn 一个必然失败的 Python
    // 只会拖慢热路径。失败原因由 `failureReason()` 如实带出去。
    if (entry.failure) return null
    return entry.backend ?? null
  }

  /**
   * 启动（或复用）某会话的隔离灵枢客户端并返回后端。
   *
   * 与 `backendFor` 分开：`backendFor` 是**同步、零副作用**的取用（给检索热路径），
   * 真正的启动只在 `/memory-lab2 index` 这类显式动作里发生。这样只读检索不会
   * 隐式起进程、隐式建库。
   */
  async function ensureBackend({ sessionId, storeRoot, signal }) {
    if (rootMissingReason !== null) {
      return { ok: false, backend: null, reason: rootMissingReason }
    }
    let entry = entries.get(sessionId)
    if (!entry) {
      entry = { sessionId, storeRoot, backend: null, failure: null, starting: null, capabilities: null }
      entries.set(sessionId, entry)
    }
    if (entry.backend) return { ok: true, backend: entry.backend, reason: null }
    if (entry.starting) return entry.starting
    entry.starting = (async () => {
      try {
        const client = await createClient({
          python,
          storeRoot,
          lingshuPackageRoot,
          sessionId,
          signal,
        })
        entry.backend = createLingshuSemanticBackend({ client, logger, name })
        entry.client = client
        entry.failure = null
        return { ok: true, backend: entry.backend, reason: null }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        entry.failure = reason
        entry.backend = null
        logger?.warn?.(`v2 隔离灵枢启动失败（会话 ${sessionId}）：${reason}`)
        return { ok: false, backend: null, reason }
      } finally {
        entry.starting = null
      }
    })()
    return entry.starting
  }

  /** 该会话当前的失败原因（没有失败则 null）；只读，不触发启动。 */
  function failureReason(sessionId) {
    return entries.get(sessionId)?.failure ?? null
  }

  async function close(sessionId) {
    const entry = entries.get(sessionId)
    if (!entry) return
    entries.delete(sessionId)
    try {
      await entry.client?.close?.()
    } catch (error) {
      logger?.warn?.(`v2 隔离灵枢关闭失败（会话 ${sessionId}）：${error?.message ?? error}`)
    }
  }

  async function closeAll() {
    for (const sessionId of [...entries.keys()]) await close(sessionId)
  }

  return { describe, backendFor, ensureBackend, failureReason, close, closeAll }
}
