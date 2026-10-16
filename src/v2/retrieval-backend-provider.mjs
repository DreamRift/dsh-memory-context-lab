/**
 * 复合检索后端提供者（设计文档 v1.2 §4）：T2（灵枢，可选）优先，T1（本地词法，默认）兜底。
 *
 * 对外暴露与 lingshu-backend provider **同一方法面**（backendFor / ensureBackend /
 * failureReason / close / closeAll / describe），因此 index.mjs 的装配只需把提供者
 * 换成本复合层，v2 runtime 与 v1 命令面都不必感知选择逻辑。
 *
 * 选择规则（装配期/ensure 期决定，运行期不换）：
 * - backendFor（同步热路径）：T2 已启动则用 T2；否则用 T1。T1 构造廉价、无进程，
 *   允许在取用路径惰性创建（每会话一个小对象；索引文件在首次 index/query 时才读）。
 * - ensureBackend（显式启动，/memory-lab2 index）：先试 T2（其 createClient 本就
 *   要求完成 tools/list 握手——即 D4 要求的「探到握手成功」）；T2 不可用则降级 T1，
 *   并把 T2 的失败原因原样带出（状态面如实展示，不静默）。
 *
 * 显式指定（PR #4 接口设计 §端口二，retrievalBackend 配置）：
 * - 'local-lexical-v1'：不尝试 T2，只走 T1（describe 如实标注被指定）。
 * - 'lingshu-mdcg-receipt'：强制 T2。ensureBackend 握手失败不降级，返回
 *   ok:false + code EBACKENDPINGFAIL；启动预检（T2 根本不在场）由调用方用
 *   EBACKENDUNAVAILABLE 拒绝。'auto'（默认）行为与上面的一般规则完全一致。
 */
import { createLocalLexicalBackend, LOCAL_LEXICAL_BACKEND_NAME, LOCAL_LEXICAL_CAPABILITIES } from './local-lexical-backend.mjs'

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0
}

export function createCompositeRetrievalBackendProvider({ lingshu = null, logger = null, maxTerms = undefined, forcedMode = 'auto' } = {}) {
  const localEntries = new Map()
  const forceLocal = forcedMode === 'local-lexical-v1'
  const forceLingshu = forcedMode === 'lingshu-mdcg-receipt'

  function localBackendFor({ sessionId, storeRoot }) {
    let entry = localEntries.get(sessionId)
    if (!entry) {
      entry = { backend: createLocalLexicalBackend({ directory: storeRoot, logger, maxTerms }) }
      localEntries.set(sessionId, entry)
    }
    return entry.backend
  }

  const probeCache = new Map()

  async function resolveBackend({ sessionId, storeRoot, signal }) {
    if (forceLingshu) {
      if (!lingshu) {
        return { ok: false, code: 'EBACKENDUNAVAILABLE', reason: '已显式指定 lingshu-mdcg-receipt，但灵枢后端不可用（dsh-memory 不在场或模块加载失败）' }
      }
      const attempted = await lingshu.ensureBackend({ sessionId, storeRoot, signal })
      if (attempted.ok) return attempted
      return { ok: false, code: 'EBACKENDPINGFAIL', reason: `已显式指定 lingshu-mdcg-receipt，灵枢后端握手失败：${attempted.reason ?? 'unknown'}` }
    }
    if (!forceLocal && lingshu) {
      const attempted = await lingshu.ensureBackend({ sessionId, storeRoot, signal })
      if (attempted.ok) return attempted
      const backend = localBackendFor({ sessionId, storeRoot })
      logger?.warn?.('检索后端降级：灵枢后端不可用（' + (attempted.reason ?? 'unknown') + '），改用本地词法索引。')
      return { ok: true, backend, reason: attempted.reason ?? null, fallback: LOCAL_LEXICAL_BACKEND_NAME }
    }
    return { ok: true, backend: localBackendFor({ sessionId, storeRoot }), reason: forceLocal ? '已显式指定 local-lexical-v1，不尝试灵枢后端' : null }
  }

  function describe() {
    const lingshuDescribe = lingshu?.describe?.() ?? null
    // D1（0.9.0-rc.6）：顶层 name/capabilities 必须报「当前实际生效」的后端。
    // 灵枢 root 在场（available）≠ 已为某会话启动（sessions>0）：backendFor 只在
    // 灵枢为该会话启动过时才返回 T2，其余会话与未启用期都实际走 T1。用
    // available 当判据会在未启动时虚报灵枢生效（诚实边界）。
    const lingshuActive = !forceLocal && (lingshuDescribe?.sessions ?? 0) > 0
    return {
      available: forceLingshu && !lingshu ? false : true,
      // 状态面照抄当前生效后端；本地后端始终可用，所以 available 恒为 true。
      name: lingshuActive ? lingshuDescribe.name : LOCAL_LEXICAL_BACKEND_NAME,
      capabilities: lingshuActive ? lingshuDescribe.capabilities : LOCAL_LEXICAL_CAPABILITIES,
      defaultBackend: LOCAL_LEXICAL_BACKEND_NAME,
      forcedMode,
      lingshu: lingshuDescribe,
      local: { name: LOCAL_LEXICAL_BACKEND_NAME, capabilities: LOCAL_LEXICAL_CAPABILITIES, sessions: localEntries.size },
      sessions: (lingshuDescribe?.sessions ?? 0) + localEntries.size,
    }
  }

  return {
    /** 同步取用：T2 已启动则用 T2；否则 T1（惰性创建，无进程）。显式指定 T1 时不试 T2；强制 T2 未启动期不隐式起 T1（失败关闭）。 */
    backendFor({ sessionId, storeRoot }) {
      if (forceLocal) {
        if (!nonEmptyString(sessionId) || !nonEmptyString(storeRoot)) return null
        return localBackendFor({ sessionId, storeRoot })
      }
      const t2 = lingshu?.backendFor?.({ sessionId, storeRoot }) ?? null
      if (t2) return t2
      if (forceLingshu) return null
      if (!nonEmptyString(sessionId) || !nonEmptyString(storeRoot)) return null
      return localBackendFor({ sessionId, storeRoot })
    },

    /** 显式启动：auto 先试 T2、失败降级 T1；强制 T2 时握手失败返回 ok:false + EBACKENDPINGFAIL，不降级。
     *
     * P1-5 探测一次固定：auto/forced 的探测结果（成功或失败）按会话缓存，
     * 后续 ensure 不再重复起 T2 握手——失败每轮重试会让回注路径反复付握手
     * 成本并打满日志。缓存随 close(sessionId) 失效；重启会话或重新 /memory-lab2
     * index（close 后）即重新探测。代价是瞬断会被记住到会话结束，这在状态面
     * 上有 failureReason 如实可见，不算静默。 */
    async ensureBackend({ sessionId, storeRoot, signal }) {
      const cached = probeCache.get(sessionId)
      if (cached) return cached
      const outcome = await resolveBackend({ sessionId, storeRoot, signal })
      probeCache.set(sessionId, outcome)
      return outcome
    },

    /** 只读：T2 的失败原因原样透出（T1 无失败态——构造即就绪）。 */
    failureReason({ sessionId }) {
      return lingshu?.failureReason?.(sessionId) ?? null
    },

    async close(sessionId) {
      localEntries.delete(sessionId)
      probeCache.delete(sessionId)
      await lingshu?.close?.(sessionId)
    },

    async closeAll() {
      localEntries.clear()
      await lingshu?.closeAll?.()
    },

    /** 启用前预检（只读，不起进程）：强制 T2 而 T2 根本不在场 → EBACKENDUNAVAILABLE。 */
    precheck() {
      if (forceLingshu && !lingshu) {
        return { ok: false, code: 'EBACKENDUNAVAILABLE', reason: '已显式指定 lingshu-mdcg-receipt，但灵枢后端不可用（dsh-memory 不在场或模块加载失败）' }
      }
      return { ok: true }
    },

    describe,
  }
}
