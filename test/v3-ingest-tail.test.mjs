/**
 * B3-4（AUD50-02-09）尾部事件不推进 lastSeq——非记忆事件（合法 seq）在本轮记忆事件
 * 全部处理后推进断点（不写记录）；坏 seq 不推进（不伪造 lastSeq）、warn 一次、不阻塞
 * 后续合法事件；事务失败的本轮不吸收（避免跳过未入库记忆事件）；重启后行为一致。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { attachV3Engine } from '../src/v3/entry/v3-entry.mjs'

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
    pushRaw(event) { events.push(event); return event },
  }
}

function fakeCtx() {
  const handlers = new Map()
  const warnings = []
  const ctx = {
    warnings,
    on(name, handler) { handlers.set(name, handler); return () => handlers.delete(name) },
    logger: { warn: (m) => warnings.push(m), info() {} },
  }
  ctx.callPreStep = async (agent, decision = { kind: 'enter' }) => {
    const handler = handlers.get('agent/pre-step')
    if (!handler) throw new Error('未注册 pre-step')
    return await handler({ agent, signal: undefined }, async () => decision)
  }
  return ctx
}

async function withRoot(body) {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-v3-ingest-tail-'))
  try {
    return await body(root)
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
}

async function mountAndIngest(root, session) {
  const ctx = fakeCtx()
  const engine = attachV3Engine(ctx, { v3Root: root })
  await ctx.callPreStep({ session }, { kind: 'enter' })
  await engine._waitForIdle()
  return { ctx, engine }
}

async function recordsOf(root, sessionId) {
  const dir = path.join(root, 'sessions', sessionId)
  return (await readdir(path.join(dir, 'records')).catch(() => [])).filter((f) => f.endsWith('.json')).length
}

function userText(text) { return { data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } } }

test('B3-4 尾部非记忆事件：断点推进到队尾，重放不重复摄入', async () => {
  await withRoot(async (root) => {
    const session = fakeSession('s-tail')
    session.push('user/message', userText('唯一一条'))
    session.push('system/message', { data: {} })
    const { ctx, engine } = await mountAndIngest(root, session)
    try {
      assert.equal(engine.stats()['s-tail'].lastSeq, 1, '断点吸收尾部非记忆事件')
      assert.equal(await recordsOf(root, 's-tail'), 1)
      await ctx.callPreStep({ session }, { kind: 'enter' })
      await engine._waitForIdle()
      assert.equal(await recordsOf(root, 's-tail'), 1, '重放不重复落库')
    } finally {
      engine.dispose()
    }
  })
})

test('B3-4 中段非记忆事件：后续记忆事件照常入库、断点到队尾', async () => {
  await withRoot(async (root) => {
    const session = fakeSession('s-mid')
    session.push('user/message', userText('前一条'))
    session.push('system/message', { data: {} })
    session.push('assistant/message', { data: { content: [{ type: 'text', text: '后一条' }] } })
    const { engine } = await mountAndIngest(root, session)
    try {
      assert.equal(await recordsOf(root, 's-mid'), 2, '非记忆事件不吞掉后续记忆事件')
      assert.equal(engine.stats()['s-mid'].lastSeq, 2)
    } finally {
      engine.dispose()
    }
  })
})

test('B3-4 坏 seq：不推进断点、warn 一次、不阻塞后续合法事件', async () => {
  await withRoot(async (root) => {
    const session = fakeSession('s-badseq')
    session.push('user/message', userText('好一'))
    session.pushRaw({ seq: 'not-a-number', type: 'user/message', data: userText('坏 seq').data })
    session.push('user/message', userText('好二'))
    const { ctx, engine } = await mountAndIngest(root, session)
    try {
      assert.equal(await recordsOf(root, 's-badseq'), 2, '坏 seq 不阻塞后续合法事件')
      assert.equal(engine.stats()['s-badseq'].lastSeq, 2, '断点推进到合法队尾，不伪造坏 seq')
      const badWarns = ctx.warnings.filter((w) => w.includes('seq 非法'))
      assert.equal(badWarns.length, 1, '坏 seq warn 一次')
      await ctx.callPreStep({ session }, { kind: 'enter' })
      await engine._waitForIdle()
      assert.equal(ctx.warnings.filter((w) => w.includes('seq 非法')).length, 1, '同坏 seq 不逐步刷屏')
    } finally {
      engine.dispose()
    }
  })
})

test('B3-4 重启后行为一致：非记忆尾部重扫一次、记录不翻倍', async () => {
  await withRoot(async (root) => {
    const session = fakeSession('s-restart')
    session.push('user/message', userText('第一轮'))
    session.push('system/message', { data: {} })
    const first = await mountAndIngest(root, session)
    first.engine.dispose()
    const second = await mountAndIngest(root, session)
    try {
      assert.equal(await recordsOf(root, 's-restart'), 1, '重启不重复落库')
      assert.equal(second.engine.stats()['s-restart'].lastSeq, 1, '重启后断点同样吸收尾部')
    } finally {
      second.engine.dispose()
    }
  })
})
