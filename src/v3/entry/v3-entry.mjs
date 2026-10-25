/**
 * v3 引擎入口（v3/entry，M5 第三批）——影子模式挂载。
 *
 * 与 v2 并行、互不干扰：只**摄入**事件（归一化→processTurn 落库），不做任何表面
 * 操作、不注册命令、不改设置——先让 v3 在真实宿主上积累数据与计量，M6 再开表面。
 *
 * 挂载形状（2026-10-24 对 src/index.mjs 核验）：

 * - 数据根 v3Root 必传（v3 不 import v2 的 storage 模块——根路径由主入口给，装配解耦）。
 * 事件源：每次 pre-step 拉取 session.events，按 seq 增量摄入（断点续传，不重复落库）。
 */

import { createV3Runtime } from '../composition/composition.mjs'
import { V3ContractViolation } from '../contracts/index.mjs'

const MEMORY_EVENT_TYPES = new Set(['user/message', 'assistant/message', 'tool/call', 'tool/result'])

/** 从 DSH 事件取正文（content[].text 连接；无正文返回空串）。 */
export function textOfDshEvent(raw) {
  const content = raw?.data?.content
  if (!Array.isArray(content)) return typeof raw?.data?.text === 'string' ? raw.data.text : ''
  return content.filter((c) => c?.type === 'text').map((c) => c.text ?? '').join('\n')
}

/**
 * 挂载 v3 引擎（影子模式）。
 * @param {object} ctx DSH 插件 ctx（含 on/logger）
 * @param {object} options { v3Root（必传）、runtimeFactory?（测试注入） }
 * @returns {{ dispose(): void, stats(): object }}
 */
export function attachV3Engine(ctx, options = {}) {
  if (ctx === null || typeof ctx !== 'object' || typeof ctx.on !== 'function') {
    throw new V3ContractViolation('v3 entry: 需要 DSH 插件 ctx（含 on）')
  }
  if (typeof options.v3Root !== 'string' || options.v3Root.length === 0) {
    throw new V3ContractViolation('v3 entry: v3Root 必传（由主入口解析数据根，v3 不依赖 v2 模块）')
  }
  const v3Root = options.v3Root
  const runtimes = new Map() // sessionId → { runtime, lastSeq }
  const makeRuntime = options.runtimeFactory ?? (async (dshSession, sessionId) => createV3Runtime({
    v3Root,
    dshSession,
    sessionKey: sessionId,
  }))
  const disposed = { value: false }

  // 摄入批大小：回填按批走事务；新事件通常 1-3 条一批
  const INGEST_BATCH = 100

  async function ingestAll(entry, log) {
    let batch = []
    let batchFirstSeq = null
    let ingested = 0
    for (const raw of log) {
      if (disposed.value) return
      if (!MEMORY_EVENT_TYPES.has(raw?.type)) continue
      if (Number.isInteger(entry.lastSeq) && raw.seq <= entry.lastSeq) continue
      batch.push(raw)
      batchFirstSeq = batchFirstSeq ?? raw.seq
      if (batch.length >= INGEST_BATCH) {
        await ingestBatch(entry, batch, batchFirstSeq)
        ingested += batch.length
        batch = []
        batchFirstSeq = null
      }
    }
    if (batch.length > 0 && !disposed.value) {
      await ingestBatch(entry, batch, batchFirstSeq)
      ingested += batch.length
    }
    // 只有回填（大批量）才在这里重建索引；每步 1-3 条的小增量留 stale，
    // 检索时懒重建——否则每步全量重建 11.5MB 索引会卡住宿主事件循环（首字慢）。
    if (!disposed.value && ingested >= INGEST_BATCH) {
      try { await entry.runtime.store.rebuildIndex() } catch (error) {
        ctx.logger?.warn?.('memory-context-lab-v3: 索引重建失败（检索时会自动重试）：' + (error?.message ?? String(error)))
      }
    }
  }

  async function ingestBatch(entry, batch, firstSeq) {
    try {
      let applied = 0
      for (const raw of batch) {
        const result = await entry.runtime.handleDshEvent(raw, textOfDshEvent(raw))
        if (result?.status === 'applied' || result?.status === 'rejected') entry.lastSeq = raw.seq
        if (result?.status === 'applied') applied += 1
        if (result?.status === 'rejected') {
          ctx.logger?.warn?.('memory-context-lab-v3: 事件被拒绝 seq=' + raw.seq + '：' + (result.errors ?? []).join('；'))
        }
      }
      ctx.logger?.info?.('memory-context-lab-v3: 摄入批完成（起 seq=' + firstSeq + '，' + applied + '/' + batch.length + ' 条）')
    } catch (error) {
      // 影子模式不干扰宿主：摄入失败只告警，断点停在已完成处，下一步续传
      ctx.logger?.warn?.('memory-context-lab-v3: 影子摄入失败（seq 起 ' + firstSeq + '）：' + (error?.message ?? String(error)))
    }
  }

  const off = ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next()
    if (decision?.kind !== 'enter' || signal?.aborted) return decision
    if (disposed.value) return decision
    try {
      const session = agent?.session
      const sessionId = String(session?.id ?? '')
      if (!sessionId) return decision
      // 真实宿主：session.log 数组（dsh-session 源码核验 2026-10-24）；替身：events() 函数
      const log = Array.isArray(session?.log) ? session.log : (typeof session?.events === 'function' ? session.events() : null)
      if (log === null) return decision
      let entry = runtimes.get(sessionId)
      if (entry === undefined) {
        // 宿主 seq 从 0 起（SessionSeq 源码核验 2026-10-24），断点初值 -1 才不漏首事件
        entry = { runtime: await makeRuntime(session, sessionId), lastSeq: -1, inflight: null }
        runtimes.set(sessionId, entry)
      }
      // 2026-10-25 事故修正：摄入**后台异步**执行（历史大会话回填实测 10 分钟），
      // 钩子立即返回 decision，绝不阻塞首字；单飞行防重入，新事件由下一次 pre-step 续传。
      if (entry.inflight === null) {
        entry.inflight = ingestAll(entry, log)
          .catch((error) => ctx.logger?.warn?.('memory-context-lab-v3: 摄入任务异常：' + (error?.message ?? String(error))))
          .finally(() => { entry.inflight = null })
      }
    } catch (error) {
      ctx.logger?.warn?.('memory-context-lab-v3: 影子调度失败：' + (error?.message ?? String(error)))
    }
    return decision
  })

  return {
    dispose() {
      disposed.value = true
      for (const { runtime } of runtimes.values()) {
        try { runtime.close() } catch {}
      }
      runtimes.clear()
      if (typeof off === 'function') off()
    },
    stats() {
      const out = {}
      for (const [sessionId, { runtime, lastSeq, inflight }] of runtimes) {
        out[sessionId] = { lastSeq, ingesting: inflight !== null, metrics: runtime.metrics() }
      }
      return out
    },
    /** 测试/诊断用：等待所有在飞摄入完成（生产不调用）。 */
    async _waitForIdle() {
      for (;;) {
        const busy = [...runtimes.values()].filter((e) => e.inflight !== null)
        if (busy.length === 0) return
        await Promise.all(busy.map((e) => e.inflight))
      }
    },
  }
}
