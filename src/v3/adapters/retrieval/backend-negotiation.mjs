/**
 * 记忆后端协商（adapters/retrieval，M5 尾批）——把 contracts 的裁决接成运行时后端。
 *
 * - 探测结果由外部注入（probe：主入口用 v2 的 dsh-memory 定位与版本核验，v3 不
 *   import v2 模块）；缺省探测 = 不可用（fail-closed，绝不当「可用」）；
 * - 协商经 contracts/negotiateMemoryProvider（D3：未知/缺工具/冒烟未过一律回 T1）；
 * - T2 被选中但工厂缺位 → 如实回落 T1 并说明（不静默降级也不炸装配）；
 * - 决策记录（tier/provider/reason）随 provider 一起返回：status 类面板要报
 *   「当前实际生效」，不是「期望」（retrieval-provider 保留判据 D1）。
 */
import { negotiateMemoryProvider } from '../../contracts/index.mjs'
import { createT1Provider } from './t1-provider.mjs'
import { V3ContractViolation } from '../../contracts/index.mjs'

/**
 * 组装最终记忆后端。
 * @param {object} deps
 * @param {object} deps.port SessionStore 端口
 * @param {object} deps.store session-store 句柄（T1 读索引）
 * @param {object} [deps.metrics]
 * @param {Function} [deps.probe] async () => { name, version, tools, smokePassed } | null
 * @param {Function} [deps.t2ProviderFactory] async (described) => MemoryProvider（T2 选中时用）
 */
export async function negotiateMemoryBackend({ port, store, metrics, probe, t2ProviderFactory } = {}) {
  if (store === null || typeof store !== 'object') {
    throw new V3ContractViolation('v3 backend: 需要 session-store 句柄')
  }
  const t1 = createT1Provider({ port, store, metrics })

  let described = null
  if (typeof probe === 'function') {
    described = await probe()
  }
  if (described === null || described === undefined) {
    return { provider: t1, decision: { tier: 'T1', provider: 'local', reason: '探测不可用或未配置（fail-closed 回 T1）' } }
  }
  const decision = negotiateMemoryProvider(described)
  if (decision.tier === 'T2') {
    if (typeof t2ProviderFactory !== 'function') {
      return { provider: t1, decision: { ...decision, tier: 'T1', provider: 'local', reason: 'T2 被选中但工厂缺位，如实回落 T1：' + decision.reason } }
    }
    try {
      const t2 = await t2ProviderFactory(described)
      return { provider: t2, decision }
    } catch (error) {
      return { provider: t1, decision: { tier: 'T1', provider: 'local', reason: 'T2 工厂失败回落 T1：' + (error?.message ?? String(error)) } }
    }
  }
  return { provider: t1, decision }
}
