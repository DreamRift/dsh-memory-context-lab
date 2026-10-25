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
        entry = { runtime: await makeRuntime(session, sessionId), lastSeq: -1 }
        runtimes.set(sessionId, entry)
      }
      for (const raw of log) {
        if (!MEMORY_EVENT_TYPES.has(raw?.type)) continue
        if (Number.isInteger(entry.lastSeq) && raw.seq <= entry.lastSeq) continue
        const result = await entry.runtime.handleDshEvent(raw, textOfDshEvent(raw))
        if (result?.status === 'applied' || result?.status === 'rejected') entry.lastSeq = raw.seq
        if (result?.status === 'rejected') {
          ctx.logger?.warn?.('memory-context-lab-v3: 事件被拒绝 seq=' + raw.seq + '：' + (result.errors ?? []).join('；'))
        }
      }
    } catch (error) {
      // 影子模式不干扰宿主决策：摄入失败只告警
      ctx.logger?.warn?.('memory-context-lab-v3: 影子摄入失败：' + (error?.message ?? String(error)))
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
      for (const [sessionId, { runtime, lastSeq }] of runtimes) {
        out[sessionId] = { lastSeq, metrics: runtime.metrics() }
      }
      return out
    },
  }
}
