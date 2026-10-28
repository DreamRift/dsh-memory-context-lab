/**
 * 离线 A/B（M7）：同一个合成会话，比较「不归档的完整历史」与「v3 归档后的活动面」。
 *
 * 这是**投影经济学**的确定性 A/B，不是真实模型质量 A/B：
 * - A 面 = 会话日志里的记忆事件全文字符数；
 * - B 面 = 当前 surface 节点正文字符数（回执 + 当前回合）；
 * - 再 restore all，核对活动面恢复到接近 A 面。
 *
 * 真实模型质量 A/B 需要两个隔离 DSH 会话与人工任务评分，不在此脚本内。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { attachV3Engine } from '../src/v3/entry/v3-entry.mjs'
import { createFakeSession } from '../test/helpers/fake-session.mjs'

function fakeCtx() {
  const handlers = new Map()
  const ctx = {
    on(name, handler) { handlers.set(name, handler); return () => handlers.delete(name) },
    logger: { warn() {}, info() {} },
  }
  ctx.callPreStep = async (session) => {
    const handler = handlers.get('agent/pre-step')
    return await handler({ agent: { session }, signal: undefined }, async () => ({ kind: 'enter' }))
  }
  return ctx
}

async function settle(engine) {
  await new Promise((resolve) => setTimeout(resolve, 120))
  await engine._waitForIdle().catch(() => {})
  await new Promise((resolve) => setTimeout(resolve, 40))
}

function textOfEvent(event) {
  // 回执本身也是 user/message（插件来源）；基线只算真实用户/助手正文，否则 A/B 会把回执算进“完整历史”。
  if (event?.data?.source?.kind === 'dsh-memory-context-lab') return ''
  const content = event?.data?.message?.content ?? event?.data?.content
  if (Array.isArray(content)) return content.filter((part) => part?.type === 'text').map((part) => part.text ?? '').join('')
  return ''
}

export async function runAb({ turns = 6, charsPerTurn = 800 } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-ab-'))
  const ctx = fakeCtx()
  const engine = attachV3Engine(ctx, { v3Root: root })
  const session = createFakeSession({ id: 'ab-session' })
  try {
    for (let turn = 1; turn <= turns; turn += 1) {
      const body = '第' + turn + '轮：' + '上下文'.repeat(Math.max(1, Math.floor(charsPerTurn / 3)))
      session.pushUser(body)
      session.pushAssistant('第' + turn + '轮回答：' + '结论'.repeat(Math.max(1, Math.floor(charsPerTurn / 6))))
      await ctx.callPreStep(session)
      await settle(engine)
      await engine.archiveForStep('ab-session', session, {})
    }
    const fullChars = session.log
      .filter((event) => event.type === 'user/message' || event.type === 'assistant/message')
      .map(textOfEvent)
      .join('').length
    const surfaceChars = (await Promise.all(session.surface.nodes.map(async (seq) => session.textOf(seq)))).join('').length
    const vouchers = await engine.historyOf('ab-session')
    const restored = await engine.restoreHistory('ab-session', { maxChars: 1_000_000 })
    const restoredChars = (await Promise.all(session.surface.nodes.map(async (seq) => session.textOf(seq)))).join('').length
    return {
      turns,
      charsPerTurn,
      fullChars,
      surfaceChars,
      reductionPct: fullChars === 0 ? 0 : Math.round((1 - surfaceChars / fullChars) * 1000) / 10,
      vouchers: vouchers.total,
      restore: { restored: restored.restored, skipped: restored.skipped, total: restored.total },
      restoredChars,
      restoredPct: fullChars === 0 ? 0 : Math.round((restoredChars / fullChars) * 1000) / 10,
    }
  } finally {
    await engine._waitForIdle().catch(() => {})
    engine.dispose()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('v3-ab.mjs')) {
  const result = await runAb()
  process.stdout.write(JSON.stringify(result, null, 2) + '\n')
}