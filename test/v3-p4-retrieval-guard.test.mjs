/**
 * P4 检索守卫（0.15.0）：本插件管理工具自己的 call/result 必须「可回读、不进检索」。
 *
 * 判据两条且互不依赖：
 * - 摄入期按工具名登记 callId，把配对 tool/result 标 metaOnly；
 * - 结果首行带 OWN_TOOL_RESULT_MARKER，跨重启（内存表丢失）也能识别。
 *
 * 反例即管理循环：工具结果被索引 → 下次检索/回注又把它当用户记忆召回 → 越管越多。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { attachV3Engine } from '../src/v3/entry/v3-entry.mjs'
import { OWN_TOOL_RESULT_MARKER } from '../src/v3/contracts/tools.mjs'
import { createFakeSession } from './helpers/fake-session.mjs'

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
  await new Promise((resolve) => setTimeout(resolve, 150))
  await engine._waitForIdle().catch(() => {})
  await new Promise((resolve) => setTimeout(resolve, 80))
}

const SECRET = '本插件管理结果唯一串-ZQ7'

test('工具 call/result 标 metaOnly：不进检索，但可按 ID 精确回读', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-p4-own-'))
  const ctx = fakeCtx()
  const engine = attachV3Engine(ctx, { v3Root: root })
  try {
    const session = createFakeSession({ id: 'session-own' })
    session.pushUser('普通问题：独一无二答案在答一'.repeat(3))
    session.pushAssistant('普通回答：答一正文'.repeat(3))
    session.pushToolCall('call-own-1', 'memory_context_search', { query: 'SECRET' })
    session.pushToolResult('call-own-1', OWN_TOOL_RESULT_MARKER + ' 检索结果 ' + SECRET)
    session.pushUser('当前问题'.repeat(5))
    await ctx.callPreStep(session)
    await settle(engine)

    const { ids } = await engine.recordIdsOf('session-own')
    let ownRecordId = null
    for (const id of ids) {
      const read = await engine.toolRead('session-own', id, { detail: 'full' })
      if (read.status === 'ok' && typeof read.text === 'string' && read.text.includes(SECRET)) ownRecordId = id
    }
    assert.ok(ownRecordId !== null, '工具结果必须仍可按 ID 回读（metaOnly 不是删除）')
    // G2：metaOnly 记录的引用区同样有界；记录侧没有链 B 的 sources（那只有摘要工件才有）
    const ownRead = await engine.toolRead('session-own', ownRecordId, { detail: 'full' })
    assert.equal(ownRead.status, 'ok')
    assert.deepEqual(ownRead.sources, [])
    assert.ok(ownRead.refs_total <= 8, '单条记录的引用条数有界（得到 ' + ownRead.refs_total + '）')
    assert.ok(Array.isArray(ownRead.related))
    for (const ref of ownRead.related) {
      assert.equal(typeof ref.id === 'string' && ref.id.length > 0, true, '每条引用必须有稳定 ID')
      assert.equal(typeof ref.relation === 'string' && ref.relation.length > 0, true, '每条引用必须有关系类型')
      assert.equal(typeof ref.status === 'string' && ref.status.length > 0, true, '每条引用必须有核验状态')
    }

    // 检索面：同一唯一串不得命中（metaOnly 记录不进索引）
    const found = await engine.toolSearch('session-own', session, { query: 'ZQ7', scope: 'all', limit: 5 })
    assert.equal(found.status, 'ok')
    assert.equal(found.items.length, 0, '管理工具结果不得回灌检索')
    // 普通正文仍可检索（守卫不能误杀整个索引）
    const normal = await engine.toolSearch('session-own', session, { query: '答一正文', scope: 'records', limit: 5 })
    assert.ok(normal.items.some((item) => item.id !== ownRecordId), '普通助手正文必须仍可检索')
    // 工具调用记录同样不进检索
    const callHit = await engine.toolSearch('session-own', session, { query: 'memory_context_search', scope: 'records', limit: 5 })
    assert.equal(callHit.items.length, 0)
    assert.equal((await engine.summaryList('session-own')).total, 0)
  } finally {
    engine.dispose()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})

test('P3-3：标记前带换行/空白仍识别为管理结果；正文中间提到标记不误杀', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-p4-own-marker-prefix-'))
  const ctx = fakeCtx()
  const engine = attachV3Engine(ctx, { v3Root: root })
  try {
    const session = createFakeSession({ id: 'session-marker-prefix' })
    session.pushUser('先有一条普通历史'.repeat(3))
    // 真实宿主的结果正文常以换行开头；旧判据 startsWith 会失效。
    session.pushToolResult('call-lost-prefix', '\n\n' + OWN_TOOL_RESULT_MARKER + ' 旧工具结果 ' + SECRET)
    // 防误杀：普通正文中间提到标记不应被当成管理结果。
    session.pushAssistant('普通回答：文中引用 ' + OWN_TOOL_RESULT_MARKER + ' 只是说明，不是首行标记。可检索串-KEEP9')
    session.pushUser('当前问题'.repeat(5))
    await ctx.callPreStep(session)
    await settle(engine)

    const leaked = await engine.toolSearch('session-marker-prefix', session, { query: 'ZQ7', scope: 'all', limit: 5 })
    assert.equal(leaked.items.length, 0, '换行前缀+标记的管理结果仍不得回灌检索')
    const normal = await engine.toolSearch('session-marker-prefix', session, { query: 'KEEP9', scope: 'records', limit: 5 })
    assert.equal(normal.items.length, 1, '正文中间提到标记的普通记录必须仍可检索（防误杀）')
  } finally {
    engine.dispose()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})

test('跨重启兜底：没有 callId 表时，结果首行标记仍阻止回灌检索', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-p4-own-marker-'))
  const ctx = fakeCtx()
  const engine = attachV3Engine(ctx, { v3Root: root })
  try {
    const session = createFakeSession({ id: 'session-marker' })
    session.pushUser('先有一条普通历史'.repeat(3))
    // 只给结果不给配对 call（模拟进程重启后内存表丢失 / 旧日志回放）
    session.pushToolResult('call-lost', OWN_TOOL_RESULT_MARKER + ' 旧工具结果 ' + SECRET)
    session.pushUser('当前问题'.repeat(5))
    await ctx.callPreStep(session)
    await settle(engine)

    const found = await engine.toolSearch('session-marker', session, { query: 'ZQ7', scope: 'all', limit: 5 })
    assert.equal(found.items.length, 0, '标记兜底必须生效（不依赖内存 callId 表）')
    const { ids } = await engine.recordIdsOf('session-marker')
    let readable = false
    for (const id of ids) {
      const read = await engine.toolRead('session-marker', id, {})
      if (read.status === 'ok' && typeof read.text === 'string' && read.text.includes(SECRET)) readable = true
    }
    assert.equal(readable, true, '标记兜底只影响检索，不影响精确回读')
  } finally {
    engine.dispose()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})
