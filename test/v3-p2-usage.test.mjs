/**
 * P2 usage 采集通道测试（2026-10-26，占用侧数据源）。
 *
 * ## 判据来源
 * 宿主 dsh-agent-loop settle 段源码核验：assistant/message 事件 data 带 usage
 * （dsh-llm 字段集 inputTokens/outputTokens/totalTokens/cacheReadTokens/reasoningTokens）。
 *
 * ## 断言组
 * - 带 usage 的 assistant 事件 → sessions/<id>/usage.jsonl 落盘、seq 对账、聚合含占用分位；
 * - 无 usage / 字段残缺（<2 个有效数字）→ 不写行（不可观测不猜）；
 * - 坏行读取跳过并计数，不抛错；
 * - usage 通道不影响记录计数与索引。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { attachV3Engine } from '../src/v3/entry/v3-entry.mjs'

function fakeSession(id) {
  const events = []
  return {
    id, log: events,
    surface: { nodes: [] }, append() { return { seq: 0 } }, eventAt() { return null }, deriveMessages() { return [] },
    push(type, data) { events.push({ seq: events.length, type, at: events.length, data }) },
  }
}

function fakeCtx() {
  const handlers = new Map()
  const ctx = { on(n, h) { handlers.set(n, h); return () => {} }, logger: { warn() {}, info() {} } }
  ctx.callPreStep = async (agent) => await handlers.get('agent/pre-step')({ agent, signal: undefined }, async () => ({ kind: 'enter' }))
  return ctx
}

test('P2 usage 通道：落盘、聚合、坏行容错、缺 usage 不写', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-v3usage-'))
  const ctx = fakeCtx()
  const engine = attachV3Engine(ctx, { v3Root: root })
  try {
    const session = fakeSession('s-usage')
    session.push('user/message', { text: '问个问题' })
    session.push('assistant/message', { message: { content: [{ type: 'text', text: '回答一' }] }, usage: { inputTokens: 1000, cacheReadTokens: 24000, outputTokens: 500, totalTokens: 25500 } })
    session.push('assistant/message', { message: { content: [{ type: 'text', text: '回答二' }] }, usage: { inputTokens: 1100, cacheReadTokens: 60000, outputTokens: 600, totalTokens: 61700 } })
    // 残缺 usage（只有 1 个数字字段）→ 不写
    session.push('assistant/message', { message: { content: [{ type: 'text', text: '回答三' }] }, usage: { inputTokens: 5 } })
    // 无 usage → 不写
    session.push('assistant/message', { message: { content: [{ type: 'text', text: '回答四' }] } })
    await ctx.callPreStep({ session })
    await engine._waitForIdle()
    // 记录侧不受 usage 通道影响
    const s = await engine.inspect('s-usage')
    assert.equal(s.health.recordCount, 5, '五条事件照常入库')
    // usage.jsonl：两行
    const file = path.join(root, 'sessions/s-usage/usage.jsonl')
    const lines = (await readFile(file, 'utf8')).split('\n').filter(Boolean)
    assert.equal(lines.length, 2, '残缺/缺失 usage 不写行')
    const rows = lines.map((l) => JSON.parse(l))
    assert.equal(rows[0].seq, 1)
    assert.equal(rows[1].seq, 2)
    // 聚合：占用 = input+cacheRead
    assert.ok(s.usage, 'inspect 返回 usage 聚合')
    assert.equal(s.usage.samples, 2)
    assert.equal(s.usage.occupancy.p50, 43050, '偶数样本 p50 取中间两值平均')
    assert.equal(s.usage.occupancy.max, 61100)
    assert.equal(s.usage.occupancy.latest, 61100)
    assert.equal(s.usage.totals.cacheReadTokens, 84000)
    // 坏行容错：追加半行后重开 engine 读取
    await writeFile(file, (await readFile(file, 'utf8')) + '{broken', 'utf8')
    const ctx2 = fakeCtx()
    const engine2 = attachV3Engine(ctx2, { v3Root: root })
    // 重放（重开 engine 场景）：usage 不双写——幂等由行内 seq 查重保证
    await ctx2.callPreStep({ session })
    await engine2._waitForIdle()
    const s2 = await engine2.inspect('s-usage')
    assert.equal(s2.usage.samples, 2, '坏行跳过不丢好行')
    assert.equal(s2.usage.badLines, 1, '坏行计数如实')
    engine2.dispose()
  } finally {
    engine.dispose()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})
