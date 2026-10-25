/**
 * v3 composition root（composition，M5 第二批）——唯一允许看见全部层的装配点。
 *
 * 装配顺序（fail-closed：任一端口缺方法即装配失败）：
 * DSH session → HostSurface 适配器；数据根 → SessionStore 端口（事务/锁/索引）；
 * → T1 提供者；→ processTurn / lifecycle / recall / surfaceExecutor 用例。
 * 入口 handleDshEvent：归一化（system/head 不进管线）→ processTurn（顺序固化）。
 * 时间/随机经端口注入（Date.now/randomUUID 只出现在这里）。
 */
import { randomUUID } from 'node:crypto'

import { createDshHostAdapter, normalizeDshEvent, V3_PLUGIN_SOURCE_KIND } from '../adapters/host/dsh-host.mjs'
import { createSessionStorePort } from '../adapters/storage/session-store-port.mjs'
import { createT1Provider } from '../adapters/retrieval/t1-provider.mjs'
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
 */
export async function createV3Runtime({ v3Root, dshSession, sessionKey, metricsSink } = {}) {
  if (typeof v3Root !== 'string' || v3Root.length === 0) {
    throw new V3ContractViolationOfRoot()
  }
  const key = sessionKey ?? sessionIsolationKey(String(dshSession?.id ?? 'unknown'))
  const metrics = createMetrics(metricsSink)

  const host = createDshHostAdapter({ session: dshSession, sessionKey: key })
  const { port, store } = await createSessionStorePort(v3Root, key)
  const clock = { now: () => Date.now() }
  const random = { uuid: () => randomUUID() }
  const provider = createT1Provider({ port, store, metrics })
  const processTurn = createProcessTurn({ store: port, clock, random, metrics, ownSourceKinds: [V3_PLUGIN_SOURCE_KIND] })
  const lifecycle = createSessionLifecycle({ store: port, clock, random, metrics })
  const recall = createRecall({ provider, metrics, sessionKey: key })
  const executor = createSurfaceExecutor({ host, clock, metrics })

  async function handleDshEvent(dshEvent, text) {
    const normalized = normalizeDshEvent(dshEvent, key)
    if (!normalized.ok) {
      return { status: 'not-memory-event', errors: normalized.errors }
    }
    return processTurn({ event: normalized.event, text })
  }

  return {
    sessionKey: key,
    host, store: port, provider,
    processTurn, lifecycle, recall, executor,
    handleDshEvent,
    metrics: metrics.snapshot,
    close() { store.close() },
  }
}

function V3ContractViolationOfRoot() {
  const e = new Error('v3 composition: v3Root 必须是非空字符串')
  e.name = 'V3ContractViolation'
  return e
}

function createMetrics(sink) {
  const counters = new Map()
  const observes = []
  const impl = {
    counter(name, value) {
      counters.set(name, (counters.get(name) ?? 0) + value)
      sink?.counter?.(name, value)
    },
    observe(name, value) {
      observes.push({ name, value })
      sink?.observe?.(name, value)
    },
    snapshot() {
      return { counters: Object.fromEntries(counters), observes: [...observes] }
    },
  }
  return impl
}
