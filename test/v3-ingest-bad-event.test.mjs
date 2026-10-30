/**
 * AUD50-02-03（B2-1）：坏事件不得卡死摄入。
 *
 * 修前：tool/call 缺 arguments 时 JSON.stringify(undefined) 结果不是字符串，
 * extractEventBody 对它取 .length 当场抛错；ingestBatch 的 batch.map 在大 try 里
 * 一坏全批崩，断点永远停在同一处（探针 AFTER_BAD.lastSeq=-1 不再前进），
 * 后续全部有效事件永久不入库。
 *
 * 修法：argsText 空参数回落空串；正文提取逐事件 try/catch——坏事件记 rejected、
 * 断点推进到它自身（重放幂等）、同批后续好事件照常入库；拒绝计数进 inspect()，
 * /memory-lab status 显示「摄入拒绝」行。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { attachV3Engine, extractEventBody } from '../src/v3/entry/v3-entry.mjs'

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
  const warnings = []
  const ctx = {
    warnings,
    on(name, handler) { handlers.set(name, handler); return () => handlers.delete(name) },
    logger: { warn: (m) => warnings.push(m), info() {} },
  }
  ctx.callPreStep = async (agent, decision = { kind: "enter" }) => {
    const handler = handlers.get('agent/pre-step')
    if (!handler) throw new Error('未注册 pre-step')
    return await handler({ agent, signal: undefined }, async () => decision)
  }
  return ctx
}

async function withRoot(body) {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-v3-bad-event-'))
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

async function countsOf(root, sessionId) {
  const dir = path.join(root, 'sessions', sessionId)
  const records = (await readdir(path.join(dir, 'records')).catch(() => [])).filter((f) => f.endsWith('.json'))
  const txn = (await readFile(path.join(dir, 'transactions.jsonl'), 'utf8').catch(() => ''))
    .split('\n').filter((line) => line.trim().length > 0)
  return { records: records.length, txn: txn.length }
}

/** 让 redactValue 触发 getter 抛错的最小坏事件（正文提取必然抛错）。 */
function badToolCallEvent() {
  return {
    type: 'tool/call',
    data: {
      name: 'zero',
      callId: 'c-bad',
      get arguments() { throw new Error('boom-arguments') },
    },
  }
}

test('B2-1 修法 1：缺 arguments 的 tool/call 不再抛错，照常入库（审计原始形态）', () => {
  const body = extractEventBody({ type: 'tool/call', data: { name: 'zero', callId: 'c0' } })
  assert.equal(body.text, '工具调用 zero(c0)：', 'argsText 回落空串，记录仍可落')
  assert.equal(body.structure.arguments, undefined)
})

test('B2-1 前坏后好：坏事件跳过，后续有效事件入库、断点前进', async () => {
  await withRoot(async (root) => {
    const session = fakeSession('s-wedge')
    session.push('user/message', { data: { source: { kind: 'user' }, content: [{ type: 'text', text: '先来一条' }] } })
    const bad = badToolCallEvent()
    session.push(bad.type, { data: bad.data })
    session.push('tool/result', { data: { content: [{ type: 'text', text: 'ok' }] } })
    session.push('assistant/message', { data: { content: [{ type: 'text', text: '完成' }] } })
    session.push('user/message', { data: { source: { kind: 'user' }, content: [{ type: 'text', text: '再来一条' }] } })
    const { engine, ctx } = await mountAndIngest(root, session)
    try {
      const stats = engine.stats()['s-wedge']
      assert.ok(stats.lastSeq >= 1, '断点推进到坏事件之后（实测 ' + stats.lastSeq + '）')
      const counts = await countsOf(root, 's-wedge')
      assert.equal(counts.records, 4, '同批 4 条好事件全部入库（坏事件不进事务，不拖垮同批）')
      const inspect = await engine.inspect('s-wedge')
      assert.equal(inspect.rejectedEvents, 1, '拒绝计数可见')
      assert.ok(ctx.warnings.some((w) => w.includes('正文提取失败已跳过 seq=1')), '坏事件有 warn（不静默丢弃）')
    } finally {
      engine.dispose()
    }
  })
})

test('B2-1 只有坏事件：断点前进、记录 0、不抛', async () => {
  await withRoot(async (root) => {
    const session = fakeSession('s-only-bad')
    const bad = badToolCallEvent()
    session.push(bad.type, { data: bad.data })
    const { engine } = await mountAndIngest(root, session)
    try {
      const stats = engine.stats()['s-only-bad']
      assert.equal(stats.lastSeq, 0, '断点推进到坏事件自身 seq')
      const counts = await countsOf(root, 's-only-bad')
      assert.equal(counts.records, 0)
      const inspect = await engine.inspect('s-only-bad')
      assert.equal(inspect.rejectedEvents, 1)
    } finally {
      engine.dispose()
    }
  })
})

test('B2-1 重放幂等：同一批重放不重复记录、拒绝不累加', async () => {
  await withRoot(async (root) => {
    const session = fakeSession('s-replay')
    session.push('user/message', { data: { source: { kind: 'user' }, content: [{ type: 'text', text: '甲' }] } })
    const bad = badToolCallEvent()
    session.push(bad.type, { data: bad.data })
    session.push('user/message', { data: { source: { kind: 'user' }, content: [{ type: 'text', text: '乙' }] } })
    const first = await mountAndIngest(root, session)
    try {
      const firstCounts = await countsOf(root, 's-replay')
      const firstRejected = (await first.engine.inspect('s-replay')).rejectedEvents
      // 同进程内再次触发摄入（断点已在坏事件之后）：不重复计数
      await first.ctx.callPreStep({ session }, { kind: 'enter' })
      await first.engine._waitForIdle()
      assert.deepEqual(await countsOf(root, 's-replay'), firstCounts, '重放不重复落库')
      assert.equal((await first.engine.inspect('s-replay')).rejectedEvents, firstRejected, '拒绝计数不累加')
    } finally {
      first.engine.dispose()
    }
  })
})

test('B2-1 事务语义：坏事件不影响同批好事件的提交（一批一笔事务）', async () => {
  await withRoot(async (root) => {
    const session = fakeSession('s-txn')
    session.push('user/message', { data: { source: { kind: 'user' }, content: [{ type: 'text', text: '好一' }] } })
    const bad = badToolCallEvent()
    session.push(bad.type, { data: bad.data })
    session.push('user/message', { data: { source: { kind: 'user' }, content: [{ type: 'text', text: '好二' }] } })
    const { engine } = await mountAndIngest(root, session)
    try {
      const counts = await countsOf(root, 's-txn')
      assert.equal(counts.records, 2, '好事件全部提交')
      assert.equal(counts.txn, 1, '好事件共用一笔事务（整批事务只提交成功记录）')
    } finally {
      engine.dispose()
    }
  })
})
