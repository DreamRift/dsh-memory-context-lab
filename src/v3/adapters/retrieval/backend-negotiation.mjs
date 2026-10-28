/**
 * 记忆后端协商（adapters/retrieval，M5 尾批 + beta.35 隔离 T2）。
 *
 * - 探测结果由外部注入（composition 用隔离 MCP 探测；或主入口的 dsh-memory 工具面探测）；
 *   缺省探测 = 不可用（fail-closed，绝不当「可用」）；
 * - 协商经 contracts/negotiateMemoryProvider（D3：未知/缺工具/冒烟未过一律回 T1）；
 * - T2 被选中但工厂缺位 → 如实回落 T1 并说明（不静默降级也不炸装配）；
 * - **探测抛错不得炸装配**：旧实现直接 `await probe()`，一次 Python 启动失败会让
 *   整个会话建库失败；现在捕获并回落 T1，reason 带上探测错误；
 * - 探测成功时可能携带已握手的 `handle`（隔离 MCP client）：只有 T2 工厂接管它，
 *   其余路径必须关闭，避免泄漏子进程；
 * - 决策记录（tier/provider/reason）随 provider 一起返回：status 类面板要报
 *   「当前实际生效」，不是「期望」（retrieval-provider 保留判据 D1）。
 */
import { negotiateMemoryProvider } from '../../contracts/index.mjs'
import { createT1Provider } from './t1-provider.mjs'
import { V3ContractViolation } from '../../contracts/index.mjs'

async function closeHandle(described) {
  try { await described?.handle?.close?.() } catch { /* 关闭尽力而为，不覆盖协商结论 */ }
}

/**
 * 组装最终记忆后端。
 * @param {object} deps
 * @param {object} deps.port SessionStore 端口
 * @param {object} deps.store session-store 句柄（T1 读索引）
 * @param {object} [deps.metrics]
 * @param {Function} [deps.probe] async () => { name, version, tools, smokePassed, isolated?, handle? } | null
 * @param {Function} [deps.t2ProviderFactory] async (described, { t1, port, store }) => MemoryProvider
 */
export async function negotiateMemoryBackend({ port, store, metrics, probe, t2ProviderFactory } = {}) {
  if (store === null || typeof store !== 'object') {
    throw new V3ContractViolation('v3 backend: 需要 session-store 句柄')
  }
  const t1 = createT1Provider({ port, store, metrics })

  let described = null
  if (typeof probe === 'function') {
    try {
      described = await probe()
    } catch (error) {
      return {
        provider: t1,
        decision: { tier: 'T1', provider: 'local', reason: '探测抛错回落 T1：' + (error?.message ?? String(error)) },
      }
    }
  }
  if (described === null || described === undefined) {
    return { provider: t1, decision: { tier: 'T1', provider: 'local', reason: '探测不可用或未配置（fail-closed 回 T1）' } }
  }
  let decision
  try {
    decision = negotiateMemoryProvider(described)
  } catch (error) {
    await closeHandle(described)
    return {
      provider: t1,
      decision: { tier: 'T1', provider: 'local', reason: '探测结果形状非法回落 T1：' + (error?.message ?? String(error)) },
    }
  }
  if (decision.tier === 'T2') {
    if (typeof t2ProviderFactory !== 'function') {
      await closeHandle(described)
      return { provider: t1, decision: { ...decision, tier: 'T1', provider: 'local', reason: 'T2 被选中但工厂缺位，如实回落 T1：' + decision.reason } }
    }
    try {
      const t2 = await t2ProviderFactory(described, { t1, port, store })
      return { provider: t2, decision }
    } catch (error) {
      await closeHandle(described)
      return { provider: t1, decision: { tier: 'T1', provider: 'local', reason: 'T2 工厂失败回落 T1：' + (error?.message ?? String(error)) } }
    }
  }
  await closeHandle(described)
  return { provider: t1, decision }
}