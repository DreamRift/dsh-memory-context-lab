/**
 * v3 composition root（composition，M5 第二批）——唯一允许看见全部层的装配点。
 *
 * 装配顺序（fail-closed：任一端口缺方法即装配失败）：
 * DSH session → HostSurface 适配器；数据根 → SessionStore 端口（事务/锁/索引）；
 * → T1 提供者；→ processTurn / lifecycle / recall / surfaceExecutor 用例。
 * 入口 handleDshEvent：归一化（system/head 不进管线）→ processTurn（顺序固化）。
 * 时间/随机经端口注入（Date.now/randomUUID 只出现在这里）。
 */
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'

import { createDshHostAdapter, normalizeDshEvent, V3_PLUGIN_SOURCE_KIND } from '../adapters/host/dsh-host.mjs'
import { createSessionStorePort } from '../adapters/storage/session-store-port.mjs'
import { negotiateMemoryBackend } from '../adapters/retrieval/backend-negotiation.mjs'
import { probeT2Isolated } from '../adapters/retrieval/t2-probe.mjs'
import { createT2IsolatedProvider } from '../adapters/retrieval/t2-isolated-provider.mjs'
import { createProcessTurn } from '../application/process-turn.mjs'
import { createSessionLifecycle } from '../application/session-lifecycle.mjs'
import { createRecall } from '../application/recall.mjs'
import { createSurfaceExecutor } from '../application/surface-executor.mjs'
import { sessionIsolationKey } from '../domain/session/isolation-key.mjs'

/**
 * 创建 v3 运行时。
 * @param {object} deps
 * @param {string} deps.v3Root v3 数据根（如 $DSH_HOME/.memory-context-lab/v3）
 * @param {object} deps.dshSession DSH session 对象（真实契约见 adapters/host/dsh-host.mjs）
 * @param {string} [deps.sessionKey] 会话隔离键；缺省由 dshSession 派生（M6 接宿主真实键源）
 * @param {object} [deps.metricsSink] { counter(name,value), observe(name,value) } 外部计量槽
 * @param {object} [deps.t2Isolated] { repoRoot, python, version } 隔离 MCP 环境事实；
 *   缺省不启用 T2（fail-closed 走 T1）。只有会话已启用才会创建 runtime，因此
 *   新对话默认关闭时不会启动任何 Python 子进程。
 * @param {Function} [deps.t2ProviderFactory] 测试注入；缺省用隔离 provider
 */
export async function createV3Runtime({ v3Root, dshSession, sessionKey, metricsSink, ownSourceKinds, memoryProbe, t2ProviderFactory, t2Isolated } = {}) {
  if (typeof v3Root !== 'string' || v3Root.length === 0) {
    throw new V3ContractViolationOfRoot()
  }
  // 自有来源集合：装配期定死，摄入跳过与回合判定共用同一份（不得各写一遍）。
  const ownKinds = Array.isArray(ownSourceKinds) && ownSourceKinds.length > 0 ? Object.freeze([...ownSourceKinds]) : Object.freeze([V3_PLUGIN_SOURCE_KIND])
  // 隔离键必须**一律**过校验：旧实现只在缺省时调 sessionIsolationKey，
  // 显式传入的 sessionKey（v3-entry 就是这样传的）绕过整道闸（H-08 路径穿越）。
  const originalId = String(sessionKey ?? dshSession?.id ?? 'unknown')
  let key
  let hashedFrom = null
  try {
    key = sessionIsolationKey(originalId)
  } catch (error) {
    if (error?.code !== 'ESESSION_INVALID_ID') throw error
    // H-08（2026-10-26 清单处置）：非常规 id 不再整仓拒绝装配，改为哈希目录名。
    // 隔离不变量不降：同一 id 稳定同一目录、不同 id 概率上必不同；目录名恒为安全段。
    key = 'hash-' + createHash('sha256').update(originalId.normalize('NFC')).digest('hex').slice(0, 16)
    hashedFrom = originalId
  }
  const metrics = createMetrics(metricsSink)

  const host = createDshHostAdapter({ session: dshSession, sessionKey: key })
  const { port, store } = await createSessionStorePort(v3Root, key)
  if (hashedFrom !== null) {
    // manifest 存原名（对账/恢复用；目录名是哈希后安全段）
    const { writeFile } = await import('node:fs/promises')
    const manifestFile = store.directory + '/session-manifest.json'
    await writeFile(manifestFile, JSON.stringify({ originalId: hashedFrom, directoryKey: key, hashed: true }) + '\n', 'utf8').catch(() => {})
  }
  const clock = { now: () => Date.now() }
  const random = { uuid: () => randomUUID() }
  // 隔离 T2：每会话独立 MDCG_ROOT（不共享、不落正式灵枢根）；探测失败只回落 T1。
  // root 放在 store.directory 下——会话目录已被隔离键校验，天然不越根。
  const isolatedRoot = t2Isolated === undefined || t2Isolated === null
    ? null
    : join(store.directory, 't2-mdcg')
  const probe = isolatedRoot === null
    ? memoryProbe
    : async () => probeT2Isolated({
      root: isolatedRoot,
      repoRoot: t2Isolated.repoRoot,
      python: t2Isolated.python,
      version: t2Isolated.version,
      env: t2Isolated.env,
    })
  const factory = isolatedRoot === null
    ? t2ProviderFactory
    : async (described, { t1 }) => {
      if (described?.handle === undefined || described.handle === null) {
        throw new Error('隔离 T2 探测没有交回已握手的 MCP client')
      }
      return createT2IsolatedProvider({
        t1,
        client: described.handle,
        sessionKey: key,
        metrics,
        root: isolatedRoot,
      })
    }
  // M6 T2 能力门：默认 T1；只有探测通过且宿主注入 T2 工厂才升 T2，否则如实回落。
  const { provider, decision: providerDecision } = await negotiateMemoryBackend({
    port,
    store,
    metrics,
    probe,
    t2ProviderFactory: factory,
  })
  const processTurn = createProcessTurn({ store: port, clock, random, metrics, ownSourceKinds: ownKinds })
  const lifecycle = createSessionLifecycle({ store: port, clock, random, metrics })
  const recall = createRecall({ provider, metrics, sessionKey: key })
  const executor = createSurfaceExecutor({ host, clock, metrics })

  /**
   * 批量摄入：一段事件 → 一笔存储事务。
   *
   * 逐事件事务在回填时是 O(N) 次取锁/同步日志/原子写（实测 1500 条约 45 秒），
   * 期间 `inflight` 一直非空、回注被 busy 挡住。批量化后同一批共用一笔事务，
   * 记录仍是一事件一条，own-source / 非记忆事件在这里一并裁决。
   *
   * @param {Array<{event: object, text?: string, meta?: object}>} items
   * @returns {Promise<Array<object>>} 与入参同序的 status 列表
   */
  async function handleDshEventBatch(items) {
    if (!Array.isArray(items)) {
      throw new V3ContractViolationOfRoot('v3 composition: handleDshEventBatch 需要数组')
    }
    const results = new Array(items.length)
    const normalized = []
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index]
      const raw = item?.event
      const sourceKind = raw?.data?.source?.kind
      if (typeof sourceKind === 'string' && ownKinds.includes(sourceKind)) {
        results[index] = { status: 'own-source', sourceKind }
        continue
      }
      const normalizedEvent = normalizeDshEvent(raw, key)
      if (!normalizedEvent.ok) {
        results[index] = { status: 'not-memory-event', errors: normalizedEvent.errors }
        continue
      }
      normalized.push({ index, event: normalizedEvent.event, text: item.text, meta: item.meta })
    }
    if (normalized.length === 0) return results
    const outcomes = await processTurn.many({ items: normalized })
    for (let i = 0; i < outcomes.length; i += 1) {
      results[normalized[i].index] = outcomes[i]
    }
    // T2 镜像（beta.35）：已提交记录交给 provider 的后台队列；失败只计数，
    // 不回滚本地事务。放在 composition 而不是某个调用方，保证命令面/入口/测试
    // 走同一条路径（否则「直接调 runtime」会绕过镜像）。
    if (typeof provider.mirrorRecord === 'function') {
      for (const outcome of outcomes) {
        if (outcome.status !== 'applied' || outcome.record === undefined) continue
        try {
          provider.mirrorRecord(outcome.record)
        } catch {
          metrics.counter('v3.t2.mirrorEnqueueFailed', 1)
        }
      }
    }
    return results
  }

  async function handleDshEvent(dshEvent, text, meta = {}) {
    const [result] = await handleDshEventBatch([{ event: dshEvent, text, meta }])
    return result
  }

  return {
    sessionKey: key,
    ownSourceKinds: ownKinds,
    host, store: port, provider, providerDecision,
    t2: isolatedRoot === null ? null : { isolated: true, root: isolatedRoot, python: t2Isolated.python, version: t2Isolated.version },
    processTurn, lifecycle, recall, executor,
    handleDshEvent,
    handleDshEventBatch,
    metrics: metrics.snapshot,
    close() {
      try { void provider.close?.() } catch { /* 关闭失败不改变 store 关闭 */ }
      store.close()
    },
  }
}

function V3ContractViolationOfRoot(message = 'v3 composition: v3Root 必须是非空字符串') {
  const e = new Error(message)
  e.name = 'V3ContractViolation'
  return e
}

/**
 * 计量槽（H-14）：observe 必须**有界**。
 *
 * 旧实现把每条 observe 都 push 进数组且永不裁剪——processTurn 每个事件都 observe 一次
 * 回合号，于是内存随会话历史线性增长（3000 事件 = 3000 个对象，长会话无上限）。
 * 现在：环形缓冲保留最近 OBSERVE_WINDOW 条 + 按名字聚合（count/last/min/max），
 * 另给 observedTotal 说明「实际发生过多少次」——**丢弃不等于不存在**。
 */
const OBSERVE_WINDOW = 64

function createMetrics(sink) {
  const counters = new Map()
  const observes = []
  const byName = new Map()
  let observedTotal = 0
  const impl = {
    counter(name, value) {
      counters.set(name, (counters.get(name) ?? 0) + value)
      sink?.counter?.(name, value)
    },
    observe(name, value) {
      observedTotal += 1
      const prev = byName.get(name)
      byName.set(name, {
        count: (prev?.count ?? 0) + 1,
        last: value,
        min: prev === undefined ? value : Math.min(prev.min, value),
        max: prev === undefined ? value : Math.max(prev.max, value),
      })
      observes.push({ name, value })
      if (observes.length > OBSERVE_WINDOW) observes.shift()
      sink?.observe?.(name, value)
    },
    snapshot() {
      return {
        counters: Object.fromEntries(counters),
        observes: [...observes],
        observedTotal,
        observeWindow: OBSERVE_WINDOW,
        observesByName: Object.fromEntries(byName),
      }
    },
  }
  return impl
}
