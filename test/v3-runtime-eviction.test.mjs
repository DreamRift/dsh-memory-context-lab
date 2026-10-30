/**
 * AUD50-04-01（B2-7）：会话 runtime 无淘汰 → LRU + 空闲 TTL。
 *
 * 修前：runtimes 只在引擎整体 dispose 清空——22.57MB 索引 parse 后堆 +78MB，
 * 依次打开 10 个大会话（>3MB 索引的就有 10 个）即数百 MB 常驻。
 * 修法：maxLiveSessions（默认 8）/ idleTtlMs（默认 10 分钟，attachV3Engine options
 * 可配）；淘汰 = 关 store + 清 provider 索引缓存（close 新增）+ 清定时器；
 * 数据在盘上（断点从记录反推 H-01、索引可重建），下次打开照常恢复。
 * 引用保护：摄入在飞（inflight）、回填在飞、建库中不淘汰；上限淘汰有 5s 宽限期，
 * 刚被使用的 runtime（活动步骤/命令，pre-step 与 statusOf 都 touch lastUsedAt）不碰。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { attachV3Engine } from '../src/v3/entry/v3-entry.mjs'

// stats() 里除会话键外还有 ingestMetrics / injection 两个进程级键
const liveKeys = (engine) => Object.keys(engine.stats()).filter((k) => k !== 'ingestMetrics' && k !== 'injection')

function fakeSession(id) {
  const events = []
  return {
    id,
    log: events,
    surface: { nodes: [] },
    append() { return { seq: events.length } },
    eventAt() { return undefined },
    deriveMessages() { return [] },
    push(type, extra = {}) {
      const seq = events.length
      events.push({ seq, type, at: seq, data: extra.data ?? {}, ...extra })
      return events.at(-1)
    },
  }
}

function fakeCtx() {
  const handlers = new Map()
  const ctx = {
    on(name, handler) { handlers.set(name, handler); return () => handlers.delete(name) },
    logger: { warn() {}, info() {} },
  }
  ctx.callPreStep = async (session, decision = { kind: "enter" }) => {
    const handler = handlers.get('agent/pre-step')
    return await handler({ agent: { session }, signal: undefined }, async () => decision)
  }
  return ctx
}

async function withRoot(body) {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-v3-eviction-'))
  try {
    return await body(root)
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
}

test('B2-7 存量上限：第 maxLiveSessions+1 个会话入表后，最久未用的被淘汰', async () => {
  await withRoot(async (root) => {
    const ctx = fakeCtx()
    const engine = attachV3Engine(ctx, { v3Root: root, maxLiveSessions: 2, idleTtlMs: 60000 })
    try {
      for (const id of ['s1', 's2', 's3']) {
        const session = fakeSession(id)
        session.push("user/message", { data: { source: { kind: "user" }, content: [{ type: "text", text: id + " 的消息" }] } })
        await ctx.callPreStep(session)
        await engine._waitForIdle()
      }
      assert.equal(liveKeys(engine).length, 3, "夹具：三个都活着")
      // s1 最久未用（超出宽限期）；s2 次之；s3 刚用（宽限期内，绝不淘汰）
      const now = Date.now()
      engine._touchRuntime("s1", now - 10000)
      engine._touchRuntime("s2", now - 9000)
      engine._touchRuntime("s3", now)
      engine._evictNow()
      assert.deepEqual(liveKeys(engine).sort(), ['s2', 's3'], 's1（最久未用）被淘汰，s3（宽限期内）保留')
      // 淘汰不丢数据：重开 s1 照常恢复
      const session1 = fakeSession('s1')
        session1.push("user/message", { data: { source: { kind: "user" }, content: [{ type: "text", text: "s1 的消息" }] } })
        await ctx.callPreStep(session1)
        await engine._waitForIdle()
      const stats = engine.stats()["s1"]
      assert.equal(stats.lastSeq, 0, "断点从库反推（不是 -1）")
      const recordsDir = path.join(root, "sessions", "s1", "records")
      assert.equal((await readdir(recordsDir)).filter((n) => n.endsWith('.json')).length, 1, '淘汰期间记录字节原样保留')
    } finally {
      engine.dispose()
    }
  })
})

test('B2-7 空闲 TTL：超时的 runtime 被 dispose，重开 healthy', async () => {
  await withRoot(async (root) => {
    const ctx = fakeCtx()
    const engine = attachV3Engine(ctx, { v3Root: root, maxLiveSessions: 8, idleTtlMs: 60000 })
    try {
      const session = fakeSession('s-ttl')
        session.push("user/message", { data: { source: { kind: "user" }, content: [{ type: "text", text: "内容" }] } })
        await ctx.callPreStep(session)
        await engine._waitForIdle()
      assert.equal(liveKeys(engine).length, 1)
      // 注入「已空闲超过 TTL」的时刻：TTL 淘汰不看宽限期，直接生效
      engine._touchRuntime("s-ttl", Date.now() - 60001)
      engine._evictNow()
      assert.equal(liveKeys(engine).length, 0, "超 TTL 的 runtime 已被淘汰")
      // 重开照常恢复
        await ctx.callPreStep(session)
        await engine._waitForIdle()
      const inspect = await engine.inspect("s-ttl")
      assert.equal(inspect.health.healthy, true, JSON.stringify(inspect.health))
      assert.equal(inspect.records, 1)
    } finally {
      engine.dispose()
    }
  })
})

test('B2-7 当前/活跃会话不被淘汰：刚 touch 的 runtime 在上限淘汰下保留', async () => {
  await withRoot(async (root) => {
    const ctx = fakeCtx()
    const engine = attachV3Engine(ctx, { v3Root: root, maxLiveSessions: 1, idleTtlMs: 60000 })
    try {
      for (const id of ["a", "b"]) {
        const session = fakeSession(id)
        session.push("user/message", { data: { source: { kind: "user" }, content: [{ type: "text", text: id }] } })
        await ctx.callPreStep(session)
        await engine._waitForIdle()
      }
      // b 刚被 pre-step touch（= 当前活跃会话）；a 超出宽限期 → 只淘汰 a
      const now = Date.now()
      engine._touchRuntime("a", now - 10000)
      engine._touchRuntime("b", now)
      engine._evictNow()
      assert.deepEqual(liveKeys(engine).sort(), ["b"], "活跃会话保留")
    } finally {
      engine.dispose()
    }
  })
})
