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
import { buildWarmSummaryReference } from '../domain/compress/warm/summary-reference.mjs'
import { compileContext } from '../domain/compiler/context-compiler.mjs'
import { planRecall } from '../domain/recall/planner.mjs'
import { shadowReport, compareCompressionShadow, guardShadowPorts } from '../application/compression-shadow.mjs'

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
export async function createV3Runtime({ v3Root, dshSession, sessionKey, metricsSink, ownSourceKinds, memoryProbe, t2ProviderFactory, t2Isolated, diagnosticModules, diagnosticsEnabled } = {}) {
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
    // M8：会话清单写失败不让建库失败，但必须可见（原名丢失会影响对账/恢复定位）。
    await writeFile(manifestFile, JSON.stringify({ originalId: hashedFrom, directoryKey: key, hashed: true }) + '\n', 'utf8')
      .catch((error) => metrics.counter('v3.sessionManifest.writeFailed:' + String(error?.code ?? 'EINTERNAL'), 1))
  }
  const clock = { now: () => Date.now() }
  const random = { uuid: () => randomUUID() }
  // 摘要/提案需要来源 hash 与稳定指纹：域层禁 node:crypto，hash 只在装配点构造并注入。
  const hash = { sha256: (text) => createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex') }
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
    : async (described, { t1, capabilities }) => {
      if (described?.handle === undefined || described.handle === null) {
        throw new Error('隔离 T2 探测没有交回已握手的 MCP client')
      }
      return createT2IsolatedProvider({
        t1,
        client: described.handle,
        sessionKey: key,
        metrics,
        root: isolatedRoot,
        capabilities,
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
  // G6b（可见片段去重）**未接线**——这是 2026-11-06 用户确认的现状，不是遗漏。
  //
  // `createRecall` 支持 `visibility` + `dedupeVisible` 两个入参，但本处**故意不传**：
  // 仓库里没有 `snapshotOf` 的生产方，也没有 `dedupeVisible` 设置项，整链在真实会话
  // 中不可达（A-06/A-07/A-11）。用户裁定保留代码、登记为候选，等有数据集再决定是否开发。
  //
  // 因此下面这行**不要**加 dedupeVisible —— `test/v3-g6b-unwired.test.mjs` 会钉住这一点。
  const recall = createRecall({ provider, metrics, sessionKey: key })
  const executor = createSurfaceExecutor({ host, clock, metrics })
  const diagnostics = createDiagnostics({
    diagnosticModules,
    enabled: typeof diagnosticsEnabled === 'function' ? diagnosticsEnabled : () => true,
  })

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
      if (normalizedEvent.atReason !== undefined) {
        // B3-1：事件时间非法/缺失如实计数（时间不伪造进记录，原因可观测）
        metrics.counter(normalizedEvent.atReason === 'invalid' ? 'v3.ingest.eventAtInvalid' : 'v3.ingest.eventAtMissing', 1)
      }
      normalized.push({ index, event: normalizedEvent.event, text: item.text, meta: item.meta })
    }
    if (normalized.length === 0) return results
    // M-03（0.15.4，P2）**事件级幂等**：同一 sourceEventId 不得落库两次。
    // 判据只用宿主事件 ID（不按正文——正文相同可能是两次真实发生的相同操作）。
    // 读不到来源表时不阻止摄入（失败开放于「不误拦」方向）：幂等是省重复，不是安全门。
    let seenEventIds = null
    try {
      if (typeof store.sourceEventIds === 'function' && typeof store.recordIdOfSourceEvent === 'function') {
        seenEventIds = new Map()
        for (const eventId of await store.sourceEventIds()) {
          const recordId = await store.recordIdOfSourceEvent(eventId)
          if (typeof recordId === 'string') seenEventIds.set(eventId, recordId)
        }
      }
    } catch {
      seenEventIds = null // 来源表不可读：不做幂等（不因此拒绝摄入）
    }
    const outcomes = await processTurn.many({ items: normalized, seenEventIds })
    for (let i = 0; i < outcomes.length; i += 1) {
      results[normalized[i].index] = outcomes[i]
    }
    // T2 镜像（beta.35）：已提交记录交给 provider 的后台队列；失败只计数，
    // 不回滚本地事务。放在 composition 而不是某个调用方，保证命令面/入口/测试
    // 走同一条路径（否则「直接调 runtime」会绕过镜像）。
    if (typeof provider.mirrorRecord === 'function') {
      for (const outcome of outcomes) {
        // M-03：duplicate 没有新记录（record 为 null），镜像无事可做——已有记录早已镜像。
        if (outcome.status !== 'applied' || outcome.record === undefined || outcome.record === null) continue
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
    diagnostics,
    host, store: port, provider, providerDecision,
    t2: isolatedRoot === null ? null : { isolated: true, root: isolatedRoot, python: t2Isolated.python, version: t2Isolated.version },
    processTurn, lifecycle, recall, executor,
    random,
    clock,
    hash,
    handleDshEvent,
    handleDshEventBatch,
    metrics: metrics.snapshot,
    /**
     * 关闭运行时（P8，2026-11-01 资源收敛）。
     *
     * provider.close 是**异步**的（T2 要 flush 镜像队列、关 Python 子进程，上限可达数秒）。
     * 旧实现 `void provider.close?.()` 丢掉这个 Promise：
     * - provider.close 拒绝 → 未处理拒绝（Node 默认会终止进程）；
     * - 调用方无法等待子进程真正退出（dispose 落定时子进程可能还活着）；
     * - store 在 provider 还在跑的时候就被关掉。
     * 现在：同步关闭路径行为不变；异步关闭返回 Promise，在 provider 结束后再关 store，
     * 拒绝被吞掉（资源释放失败不制造未处理拒绝；失败事实由调用方的告警面承担）。
     */
    close() {
      const finish = () => {
        try { store.close() } catch { /* 关闭失败不改变已释放的事实 */ }
      }
      let closing
      try {
        closing = provider.close?.()
      } catch {
        finish()
        return Promise.resolve()
      }
      if (closing === null || closing === undefined || typeof closing.then !== 'function') {
        finish()
        return Promise.resolve()
      }
      return Promise.resolve(closing).catch(() => {}).then(finish)
    },
  }
}

/**
 * 静态导入的诊断模块只在显式调用对应函数时计算；缺导出或注入失败逐项隔离。
 *
 * 2026-11-04（独立审计 H7）三处收紧：
 * - **运行时开关**：`enabled()` 由装配方给出（读设置页），关闭时任何诊断函数都抛
 *   `EDIAGNOSTICS_DISABLED`，不再依赖「生产路径恰好没调用」这条纪律；
 * - **调用计数只读**：旧 `calls` 是普通对象（外层 Object.freeze 是浅冻结），任何持有者
 *   都能 `calls.warm = 0` 伪造「零调用」断言。现在计数在闭包里，`calls` 只暴露 getter；
 * - **dsh-ops 诊断项移除**：0.15.1 的 dsh-ops 是独立组件行（patch + vendored 依赖），
 *   不经过本插件的 I3 adapter；对应 adapter 与诊断入口仍删除，避免把组件事实混进引擎诊断。
 */
function createDiagnostics({ diagnosticModules = {}, enabled = () => true } = {}) {
  const pick = (key, fallback) => Object.hasOwn(diagnosticModules, key) ? diagnosticModules[key] : fallback
  const modules = {
    warm: pick('warm', { buildWarmSummaryReference }),
    compiler: pick('compiler', { compileContext }),
    recall: pick('recall', { planRecall }),
    shadow: pick('shadow', { shadowReport, compareCompressionShadow, guardShadowPorts }),
  }
  const specs = {
    warm: ['buildWarmSummaryReference'],
    compiler: ['compileContext'],
    recall: ['planRecall'],
    shadow: ['shadowReport', 'compareCompressionShadow', 'guardShadowPorts'],
  }
  const available = {}
  const reasons = {}
  for (const [key, names] of Object.entries(specs)) {
    try {
      const mod = modules[key]
      const ok = mod && names.every((name) => typeof mod[name] === 'function')
      available[key] = Boolean(ok)
      reasons[key] = ok ? null : key + ' 诊断模块缺少所需导出'
    } catch (error) {
      available[key] = false
      reasons[key] = error instanceof Error ? error.message : String(error)
    }
  }
  const { buildWarmSummaryReference: warm } = modules.warm ?? {}
  const { compileContext: compiler } = modules.compiler ?? {}
  const { planRecall: recall } = modules.recall ?? {}
  const { shadowReport: report, compareCompressionShadow: compare, guardShadowPorts: guard } = modules.shadow ?? {}
  const counts = { warm: 0, compiler: 0, recall: 0, shadow: 0 }
  // 只读计分板：getter 读闭包，外部赋值/改写不生效（严格模式下抛 TypeError）。
  const calls = Object.defineProperties({}, Object.fromEntries(
    Object.keys(counts).map((key) => [key, { enumerable: true, get: () => counts[key] }]),
  ))
  const requireEnabled = () => {
    if (enabled() === true) return
    const error = new Error('离线诊断已关闭（设置页 offlineDiagnostics=false）')
    error.code = 'EDIAGNOSTICS_DISABLED'
    throw error
  }
  return Object.freeze({
    calls: Object.freeze(calls),
    warm: available.warm ? (input) => { requireEnabled(); counts.warm += 1; return warm(input) } : null,
    compiler: available.compiler ? (input) => { requireEnabled(); counts.compiler += 1; return compiler(input) } : null,
    recall: available.recall ? (input) => { requireEnabled(); counts.recall += 1; return recall(input) } : null,
    shadow: available.shadow ? (input = {}) => {
      requireEnabled()
      counts.shadow += 1
      return {
        report: report(input.report ?? { enabled: false }),
        comparison: compare(input.comparison ?? {}),
        ports: guard(input.ports ?? {}),
      }
    } : null,
    available: Object.freeze(available),
    reasons: Object.freeze(reasons),
  })
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
