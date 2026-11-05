/**
 * G1 搜索游标绑定与拒绝语义（C-G1-05、C-M-04、C-G1-06）。
 *
 * ## 缺陷（G0 §5 合同、§7 复现）
 * 旧 cursor 是**裸十进制**：不绑定 query/scope/会话/排序/快照；`cursorOffsetOf` 对任何
 * 非 `^\d+$` 的输入返回 0——非法/被改写的 cursor 静默回到第一页，模型不会知道页码错了。
 *
 * ## 判据
 * - 旧裸十进制一律**明确拒绝**（cursor-legacy-format），不回第一页；
 * - 篡改（改偏移/改校验和）、超长、错版本、空串全部拒绝，且 `returned_count=0`；
 * - 换 query / 换 scope / 换会话 → 具体错误码；
 * - 翻页期间新增记录、forget、undo 让快照变化 → `cursor-stale`（宁可重查，不得错读）；
 * - 拒绝的响应**不得**顺便返回第一页内容（禁止静默跳页）。
 *
 * ## 不适用条件
 * `memory_context_read` 的 cursor 仍走旧裸十进制（G2 负责），本文件只断言搜索面。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { attachV3Engine } from '../src/v3/entry/v3-entry.mjs'
import { decodeSearchCursor, encodeSearchCursor, orderIdOf } from '../src/v3/domain/retrieval/paging.mjs'
import { createHash } from 'node:crypto'
import { createFakeSession } from './helpers/fake-session.mjs'

const sha256 = (text) => createHash('sha256').update(String(text), 'utf8').digest('hex')

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
  await new Promise((resolve) => setTimeout(resolve, 200))
  await engine._waitForIdle().catch(() => {})
  await new Promise((resolve) => setTimeout(resolve, 100))
}

const CACHEPROBES = Array.from({ length: 9 }, (_, index) => 'CURSORPROBE-' + index + ' 游标反例记录。编号 ' + index)

async function withEngine(id, texts, fn) {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-g1-cursor-'))
  const ctx = fakeCtx()
  const engine = attachV3Engine(ctx, { v3Root: root })
  try {
    const session = createFakeSession({ id })
    for (const text of texts) session.pushUser(text)
    session.pushUser('当前问题：请总结上面的记录。')
    await ctx.callPreStep(session)
    await settle(engine)
    return await fn({ engine, session, ctx, root })
  } finally {
    try { await engine.dispose() } catch {}
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
}

async function pageOne(engine, session, overrides = {}) {
  const result = await engine.toolSearch(session.id, session, { query: 'CURSORPROBE', scope: 'records', limit: 2, ...overrides })
  assert.equal(typeof result.next_cursor, 'string', '第一页必须给出 cursor（夹具应有多页）')
  return result
}

function assertRejected(result, reason) {
  assert.equal(result.status, 'rejected', '被拒游标必须显式 rejected（本次 status=' + result.status + '）')
  assert.equal(result.reason, reason, '原因码必须具体（本次 ' + result.reason + '）')
  assert.equal(result.error, reason)
  assert.equal(result.returned_count, 0, '被拒时不得顺便返回一页内容（禁止静默回第一页）')
  assert.deepEqual(result.items, [])
  assert.equal(result.next_cursor, null)
  assert.equal(result.completeness, 'unavailable')
  assert.equal(result.has_more, null)
}

function tamper(cursor, index, value) {
  const parts = cursor.split('.')
  parts[index] = value
  return parts.join('.')
}

test('旧裸十进制 cursor 明确拒绝（C-M-04：宁可重查，不得错读）', async () => {
  await withEngine('g1-cursor-legacy', CACHEPROBES, async ({ engine, session }) => {
    for (const legacy of ['0', '2', '1000']) {
      const result = await engine.toolSearch(session.id, session, { query: 'CURSORPROBE', scope: 'records', limit: 2, cursor: legacy })
      assertRejected(result, 'cursor-legacy-format')
    }
  })
})

test('篡改/超长/错版本/空串：一律拒绝且不复位到第一页', async () => {
  await withEngine('g1-cursor-shape', CACHEPROBES, async ({ engine, session }) => {
    const first = await pageOne(engine, session)
    const cursor = first.next_cursor
    // 改偏移（index 5 = records 偏移）但不改校验和
    assertRejected(await engine.toolSearch(session.id, session, { query: 'CURSORPROBE', scope: 'records', limit: 2, cursor: tamper(cursor, 5, '1') }), 'cursor-invalid')
    // 改校验和
    assertRejected(await engine.toolSearch(session.id, session, { query: 'CURSORPROBE', scope: 'records', limit: 2, cursor: tamper(cursor, 8, '0'.repeat(16)) }), 'cursor-invalid')
    // 超长（解析资源有界）
    assertRejected(await engine.toolSearch(session.id, session, { query: 'CURSORPROBE', scope: 'records', limit: 2, cursor: 'v1.' + 'a'.repeat(600) + '.0000000000000000' }), 'cursor-invalid')
    // 不认识的版本
    assertRejected(await engine.toolSearch(session.id, session, { query: 'CURSORPROBE', scope: 'records', limit: 2, cursor: 'v2.records.abc' }), 'cursor-version-unsupported')
    // 空串与胡说八道
    assertRejected(await engine.toolSearch(session.id, session, { query: 'CURSORPROBE', scope: 'records', limit: 2, cursor: '' }), 'cursor-invalid')
    assertRejected(await engine.toolSearch(session.id, session, { query: 'CURSORPROBE', scope: 'records', limit: 2, cursor: 'not-a-cursor' }), 'cursor-invalid')
    // 数字/对象形态（参数校验之外，引擎自身也要失败关闭）
    assertRejected(await engine.toolSearch(session.id, session, { query: 'CURSORPROBE', scope: 'records', limit: 2, cursor: 42 }), 'cursor-invalid')
  })
})

test('cursor 绑定 query / scope：换一个就拒绝', async () => {
  await withEngine('g1-cursor-binding', [...CACHEPROBES, 'OTHERPROBE 另一组记录。'], async ({ engine, session }) => {
    const first = await pageOne(engine, session)
    const cursor = first.next_cursor
    assertRejected(await engine.toolSearch(session.id, session, { query: 'OTHERPROBE', scope: 'records', limit: 2, cursor }), 'cursor-query-mismatch')
    assertRejected(await engine.toolSearch(session.id, session, { query: 'CURSORPROBE', scope: 'all', limit: 2, cursor }), 'cursor-scope-mismatch')
    // 同一 query、同一 scope 的第二页必须能用
    const second = await engine.toolSearch(session.id, session, { query: 'CURSORPROBE', scope: 'records', limit: 2, cursor })
    assert.equal(second.status, 'ok')
    assert.equal(second.items.length, 2)
    assert.equal(second.returned_count, 2)
  })
})

test('cursor 绑定会话：A 会话的 cursor 不得在 B 会话使用', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-g1-cursor-session-'))
  const ctx = fakeCtx()
  const engine = attachV3Engine(ctx, { v3Root: root })
  try {
    const sessionA = createFakeSession({ id: 'g1-cursor-a' })
    const sessionB = createFakeSession({ id: 'g1-cursor-b' })
    for (const text of CACHEPROBES) { sessionA.pushUser(text); sessionB.pushUser(text) }
    sessionA.pushUser('当前问题：A')
    sessionB.pushUser('当前问题：B')
    await ctx.callPreStep(sessionA)
    await ctx.callPreStep(sessionB)
    await settle(engine)
    const first = await pageOne(engine, sessionA)
    assertRejected(await engine.toolSearch(sessionB.id, sessionB, { query: 'CURSORPROBE', scope: 'records', limit: 2, cursor: first.next_cursor }), 'cursor-session-mismatch')
    // 本会话仍可用（拒绝不是把两边的功能一起关掉）
    const ok = await engine.toolSearch(sessionA.id, sessionA, { query: 'CURSORPROBE', scope: 'records', limit: 2, cursor: first.next_cursor })
    assert.equal(ok.status, 'ok')
  } finally {
    try { await engine.dispose() } catch {}
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})

test('翻页期间新增记录：旧 cursor 显式 stale（不返回错位的一页）', async () => {
  await withEngine('g1-cursor-grow', CACHEPROBES, async ({ engine, session, ctx }) => {
    const first = await pageOne(engine, session)
    const cursor = first.next_cursor
    session.pushUser('CURSORPROBE-NEW 翻页期间新增的记录。')
    await ctx.callPreStep(session)
    await settle(engine)
    const stale = await engine.toolSearch(session.id, session, { query: 'CURSORPROBE', scope: 'records', limit: 2, cursor })
    assertRejected(stale, 'cursor-stale')
    // 不带 cursor 重新检索可拿到新快照的精确 total
    const fresh = await engine.toolSearch(session.id, session, { query: 'CURSORPROBE', scope: 'records', limit: 2 })
    assert.equal(fresh.status, 'ok')
    assert.equal(fresh.total_match_count, 10)
    assert.equal(typeof fresh.next_cursor, 'string')
  })
})

test('翻页期间 forget 与 undo：两种代际变化都让旧 cursor stale', async () => {
  await withEngine('g1-cursor-forget', CACHEPROBES, async ({ engine, session }) => {
    const first = await pageOne(engine, session)
    const target = first.items[0].id
    const forgotten = await engine.forgetRecords(session.id, [target])
    assert.notEqual(forgotten.error, 'not-ready')
    const afterForget = await engine.toolSearch(session.id, session, { query: 'CURSORPROBE', scope: 'records', limit: 2, cursor: first.next_cursor })
    assertRejected(afterForget, 'cursor-stale')
    // 遗忘后的新快照：total 少 1 且不越过 forget
    const freshAfterForget = await engine.toolSearch(session.id, session, { query: 'CURSORPROBE', scope: 'records', limit: 2 })
    assert.equal(freshAfterForget.total_match_count, 8)
    const undo = await engine.forgetRecords(session.id, [target], { undo: true })
    assert.notEqual(undo.error, 'not-ready')
    const undoPage = await engine.toolSearch(session.id, session, { query: 'CURSORPROBE', scope: 'records', limit: 2 })
    assert.equal(undoPage.total_match_count, 9, 'undo 后回到 9 条')
    const afterUndo = await engine.toolSearch(session.id, session, { query: 'CURSORPROBE', scope: 'records', limit: 2, cursor: undoPage.next_cursor })
    assert.equal(afterUndo.status, 'ok', '同一快照内新 cursor 必须可用')
  })
})

test('游标编码本身绑定版本/排序/代际（纯函数层）', async () => {
  const cursor = encodeSearchCursor({
    hash: sha256,
    sessionId: 's-1',
    query: 'q',
    scope: 'records',
    generation: '0'.repeat(16),
    recordsOffset: 4,
    summariesOffset: 0,
  })
  const parsed = decodeSearchCursor(cursor, { hash: sha256 })
  assert.equal(parsed.ok, true)
  assert.equal(parsed.value.scope, 'records')
  assert.equal(parsed.value.recordsOffset, 4)
  assert.equal(parsed.value.order, orderIdOf('records', true))
  assert.notEqual(parsed.value.order, orderIdOf('records', false), '不可分页后端必须是另一个排序 id（T1↔T2 不得续读）')
  assert.equal(parsed.value.generation, '0'.repeat(16))
  // 会话摘要不暴露原始会话 id
  assert.ok(!cursor.includes('s-1'), 'cursor 不得含明文会话 id')
  // scope 编码映射：summaries / all 各自独立
  for (const scope of ['summaries', 'all']) {
    const item = decodeSearchCursor(encodeSearchCursor({ hash: sha256, sessionId: 's-1', query: 'q', scope, generation: '1'.repeat(16) }), { hash: sha256 })
    assert.equal(item.ok, true)
    assert.equal(item.value.scope, scope)
    assert.equal(item.value.order, orderIdOf(scope, true))
  }
})
