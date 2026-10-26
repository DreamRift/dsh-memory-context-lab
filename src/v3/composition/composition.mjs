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
  const provider = createT1Provider({ port, store, metrics })
  const processTurn = createProcessTurn({ store: port, clock, random, metrics, ownSourceKinds: [V3_PLUGIN_SOURCE_KIND] })
  const lifecycle = createSessionLifecycle({ store: port, clock, random, metrics })
  const recall = createRecall({ provider, metrics, sessionKey: key })
  const executor = createSurfaceExecutor({ host, clock, metrics })

  async function handleDshEvent(dshEvent, text, meta = {}) {
    const normalized = normalizeDshEvent(dshEvent, key)
    if (!normalized.ok) {
      return { status: 'not-memory-event', errors: normalized.errors }
    }
    return processTurn({ event: normalized.event, text, meta })
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
