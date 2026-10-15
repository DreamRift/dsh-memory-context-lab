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
 */
import { createLocalLexicalBackend, LOCAL_LEXICAL_BACKEND_NAME, LOCAL_LEXICAL_CAPABILITIES } from './local-lexical-backend.mjs'

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0
}

export function createCompositeRetrievalBackendProvider({ lingshu = null, logger = null, maxTerms = undefined } = {}) {
  const localEntries = new Map()

  function localBackendFor({ sessionId, storeRoot }) {
    let entry = localEntries.get(sessionId)
    if (!entry) {
      entry = { backend: createLocalLexicalBackend({ directory: storeRoot, logger, maxTerms }) }
      localEntries.set(sessionId, entry)
    }
    return entry.backend
  }

  function describe() {
    const lingshuDescribe = lingshu?.describe?.() ?? null
    const lingshuAvailable = lingshuDescribe?.available === true
    return {
      available: true,
      // 状态面照抄当前生效后端；本地后端始终可用，所以 available 恒为 true。
      name: lingshuAvailable ? lingshuDescribe.name : LOCAL_LEXICAL_BACKEND_NAME,
      capabilities: lingshuAvailable ? lingshuDescribe.capabilities : LOCAL_LEXICAL_CAPABILITIES,
      defaultBackend: LOCAL_LEXICAL_BACKEND_NAME,
      lingshu: lingshuDescribe,
      local: { name: LOCAL_LEXICAL_BACKEND_NAME, capabilities: LOCAL_LEXICAL_CAPABILITIES, sessions: localEntries.size },
      sessions: (lingshuDescribe?.sessions ?? 0) + localEntries.size,
    }
  }

  return {
    /** 同步取用：T2 已启动则用 T2；否则 T1（惰性创建，无进程）。 */
    backendFor({ sessionId, storeRoot }) {
      const t2 = lingshu?.backendFor?.({ sessionId, storeRoot }) ?? null
      if (t2) return t2
      if (!nonEmptyString(sessionId) || !nonEmptyString(storeRoot)) return null
      return localBackendFor({ sessionId, storeRoot })
    },

    /** 显式启动：T2 握手成功则用 T2；否则如实降级 T1 并带出 T2 失败原因。 */
    async ensureBackend({ sessionId, storeRoot, signal }) {
      if (lingshu) {
        const attempted = await lingshu.ensureBackend({ sessionId, storeRoot, signal })
        if (attempted.ok) return attempted
        const backend = localBackendFor({ sessionId, storeRoot })
        logger?.warn?.('检索后端降级：灵枢后端不可用（' + (attempted.reason ?? 'unknown') + '），改用本地词法索引。')
        return { ok: true, backend, reason: attempted.reason ?? null, fallback: LOCAL_LEXICAL_BACKEND_NAME }
      }
      return { ok: true, backend: localBackendFor({ sessionId, storeRoot }), reason: null }
    },

    /** 只读：T2 的失败原因原样透出（T1 无失败态——构造即就绪）。 */
    failureReason({ sessionId }) {
      return lingshu?.failureReason?.(sessionId) ?? null
    },

    async close(sessionId) {
      localEntries.delete(sessionId)
      await lingshu?.close?.(sessionId)
    },

    async closeAll() {
      localEntries.clear()
      await lingshu?.closeAll?.()
    },

    describe,
  }
}