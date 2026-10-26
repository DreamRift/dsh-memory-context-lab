/**
 * memory-context-lab 入口（v3 单引擎，0.14.0-beta.10 转正重构）。
 *
 * 0.14.0-beta.10 起删除 v2 全部运行时（引擎/设置/命令/客户端面）：
 * - 摄入：attachV3Engine 内置 agent/pre-step 钩子（后台异步、可中断）；
 * - 回注：本入口唯一的钩子——decision 命中时追加 recall 消息（宿主消息契约与
 *   v2 相同：role user + content text + source kind 本插件 / form recall）；
 * - 命令面：status / recall / read / help（只读观察面，v3 数据根）；
 * - 设置面：无。v3 参数在代码内定稿（见 docs/dev-0.14.0 参数表），宿主不再
 *   serve 设置命名空间；
 * - 数据：v3 独立数据根（$DSH_HOME/.memory-context-lab/v3），v2 数据根不动。
 */
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

import { attachV3Engine } from './v3/entry/v3-entry.mjs'
import { labRootFor } from './storage.mjs'

export const name = 'memory-context-lab'

// 命令面必需；sessionProjections 用于会话 id 解析（回注与观察命令）。
export const inject = ['commands', 'sessionProjections']

const USAGE = [
  '用法：/memory-lab status —— 本会话摄入位点与库健康（含 usage 聚合）',
  '　　　/memory-lab recall <查询词> —— 检索影子库，命中带分数与回读句柄',
  '　　　/memory-lab read <记录ID> —— 精确回读原文',
  '　　　/memory-lab help —— 本清单',
].join('\n')

function sessionTextOf(decision) {
  const messages = Array.isArray(decision?.messages) ? decision.messages : []
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]
    if (m?.role !== 'user') continue
    const c = Array.isArray(m.content) ? m.content : []
    const text = c.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join(' ').trim()
    if (text.length > 0) return text
  }
  return ''
}

export async function apply(ctx, config) {
  // config：宿主 0.9.0 契约要求第二参数存在；v3 单引擎无 v2 时代设置面，当前未消费。
  void config
  const labRoot = labRootFor()
  const disposers = []

  // v3 引擎（摄入内建；失败关闭：装载失败不阻塞插件命令面）。
  let engine = null
  try {
    engine = attachV3Engine(ctx, { v3Root: join(labRoot, 'v3') })
  } catch (error) {
    ctx.logger.warn('memory-context-lab: v3 引擎装载失败（观察面与回注停用）：' + (error instanceof Error ? error.message : String(error)))
  }

  const sessionIdOf = (payload) => {
    const s = payload?.agent?.session ?? payload?.session
    return typeof s?.id === 'string' ? s.id : null
  }

  // 回注钩子：唯一的 surface 动作。每回合由 composition.recall 的 once-per-turn
  // 门把闸；失败关闭（回注失败不阻塞本步，只告警）。
  if (engine !== null) {
    disposers.push(ctx.on('agent/pre-step', async (payload, next) => {
      const decision = await next()
      if (decision?.kind !== 'enter' || payload?.signal?.aborted) return decision
      const sessionId = sessionIdOf(payload)
      const query = sessionTextOf(decision)
      if (sessionId === null || query.length === 0) return decision
      try {
        const outcome = await engine.recallForInjection(sessionId, query)
        if (outcome?.injected !== true || typeof outcome?.text !== 'string' || outcome.text.length === 0) return decision
        return {
          ...decision,
          messages: [...decision.messages, {
            id: 'mcl-v3-recall-' + randomUUID(),
            role: 'user',
            content: [{ type: 'text', text: outcome.text }],
            source: { kind: name, form: 'recall' },
          }],
        }
      } catch (error) {
        ctx.logger.warn('memory-context-lab: v3 回注失败（本步跳过）：' + (error instanceof Error ? error.message : String(error)))
        return decision
      }
    }, { prepend: true }))
  }

  // 命令面（只读观察 + help）。
  const command = ctx.inject('commands', null)
  const disposeCommand = command.command('memory-lab', { authority: 0 }, async (invocation) => {
    const words = String(invocation?.rawInput ?? invocation?.input ?? '').trim().split(/\s+/)
    const sub = (words[1] ?? 'help').toLowerCase()
    const arg = words.slice(2).join(' ')
    if (engine === null) return 'v3 引擎未装载（见加载日志）；命令面不可用。'
    const sessionId = sessionIdOf(invocation?.payload) ?? invocation?.payload?.session?.id ?? null
    if (sub === 'status') {
      const s = await engine.inspect(sessionId)
      if (s === null) return '本会话尚未摄入：先发出任意一条消息触发一次步骤，影子库会在后台建库。'
      const usage = s.usageError ? '\n- 占用：读取失败（' + s.usageError + '），这不是「没有样本」' : s.usage ? '（usage 样本 ' + s.usage.samples + '，p50 ' + (s.usage.occupancy?.p50 ?? '-') + '）' : ''
    }
    if (sub === 'recall') {
      if (arg.length === 0) return '用法：/memory-lab recall <查询词>'
      const r = await engine.search(sessionId, arg)
      if (r === null) return '本会话尚未摄入。'
      if (r.busy === true) return '后台摄入进行中，稍后再查。'
      const lines = (r.display ?? []).slice(0, 10)
      if (lines.length === 0) return `无命中（OOV 词：${(r.oovTerms ?? []).join('、') || '无'}）`
      return lines.join('\n')
    }
    if (sub === 'read') {
      if (arg.length === 0) return '用法：/memory-lab read <记录ID>'
      const rec = await engine.read(sessionId, arg)
      if (rec === null) return '记录不存在或本会话未摄入。'
      return typeof rec.text === 'string' ? rec.text : JSON.stringify(rec)
    }
    return USAGE
  })
  disposers.push(disposeCommand)

  return () => {
    for (const dispose of disposers) {
      try { dispose?.() } catch {}
    }
    try { engine?.dispose?.() } catch {}
  }
}
