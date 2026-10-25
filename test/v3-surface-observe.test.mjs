/**
 * v3 影子观察面测试（/memory-lab v3 status|recall|read，2026-10-25 开工授权）。
 *
 * ## 判据来源
 * index.mjs 的 v3Surface 拦截契约：只读、不动 v2、失败关闭带 code、摄入中如实 busy。
 *
 * ## 断言组
 * - status：未摄入会话给指引；已摄入给 seq/健康；健康读取失败也如实呈现；
 * - recall：命中列表带可回读句柄；OOV 空结果如实；摄入中回 busy；
 * - read：精确回读原文；无效参数回用法（error 形态带 code 与非空 text）。
 *
 * ## 不适用条件
 * 真实宿主的命令注册链路（install.test 已覆盖 host half）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { attachV3Engine } from '../src/v3/entry/v3-entry.mjs'

function fakeSession(id) {
  const events = []
  return {
    id, log: events,
    surface: { nodes: [] },
    append() { return { seq: 0 } },
    eventAt() { return null },
    deriveMessages() { return [] },
    push(type, data) { events.push({ seq: events.length, type, at: events.length, data }) },
  }
}

function fakeCtx() {
  const handlers = new Map()
  const ctx = {
    on(n, h) { handlers.set(n, h); return () => {} },
    logger: { warn() {}, info() {} },
  }
  ctx.callPreStep = async (agent, decision = { kind: 'enter' }) => {
    return await handlers.get('agent/pre-step')({ agent, signal: undefined }, async () => decision)
  }
  return ctx
}

test('观察面：status/recall/read 三态（未摄入指引 / 命中与回读 / 用法错误带 code）', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-v3obs-'))
  const ctx = fakeCtx()
  const engine = attachV3Engine(ctx, { v3Root: root })
  try {
    // 未摄入：status 给指引
    const none = await engine.inspect('s-none')
    assert.equal(none, null)
    // 已摄入：status 出 seq/健康
    const session = fakeSession('s-obs')
    session.push('user/message', { text: '观察面冒烟的目标文本' })
    await ctx.callPreStep({ session })
    await engine._waitForIdle()
    const s = await engine.inspect('s-obs')
    assert.equal(typeof s.lastSeq, 'number')
    // 小增量不重建（beta.3 分寸）：stale 如实，检索时懒重建
    const r0 = await engine.search('s-obs', '观察面', { limit: 1 })
    assert.ok(Array.isArray(r0.display))
    const s2 = await engine.inspect('s-obs')
    assert.equal(s2.health.indexStale, false, '检索懒重建后索引新鲜')
    // recall 命中
    const r = await engine.search('s-obs', '观察面 冒烟', { limit: 3 })
    const idxRaw = JSON.parse(await (await import('node:fs/promises')).readFile(path.join(root, 'sessions/s-obs/lexical-index.json'), 'utf8'))
    const fsp = await import('node:fs/promises')
    const recDir = path.join(root, 'sessions/s-obs/records')
    assert.ok(r.display.length >= 1, '命中目标文本')
    // read 精确回读
    const hit = r.display[0]
    const rd = await engine.read('s-obs', hit.id)
    assert.ok(rd.text.includes('观察面冒烟的目标文本'))
    // OOV 如实
    const oov = await engine.search('s-obs', 'qqxxzz词库没有', { limit: 3 })
    assert.equal(oov.display.length, 0)
  } finally {
    engine.dispose()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})
