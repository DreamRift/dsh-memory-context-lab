/**
 * 文件引用/核证（M4）：
 * - 读文件工具调用 → 路径+sha256；工作区外/过大/缺失 → unverifiable/missing；
 * - 修改文件后 verify = stale，stale 记录不自动回注；
 * - 账本损坏/不可读如实 error，不静默当空。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { captureFileReference, verifyFileReference } from '../src/v3/adapters/storage/file-references.mjs'
import { createRecall } from '../src/v3/application/recall.mjs'
import { attachV3Engine } from '../src/v3/entry/v3-entry.mjs'
import { createFakeSession } from './helpers/fake-session.mjs'

function toolCall(seq, callId, file) {
  return {
    seq,
    type: 'tool/call',
    data: { callId, name: 'read', arguments: JSON.stringify({ path: file }), message: { content: [{ type: 'tool-call', callId, name: 'read', arguments: JSON.stringify({ path: file }) }] } },
  }
}

test('capture：工作区内读文件 → unverified + sha256；修改 → stale；删除 → missing', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-file-'))
  try {
    await writeFile(path.join(root, 'alpha.txt'), 'alpha-content', 'utf8')
    const ref = await captureFileReference({ event: toolCall(1, 'c1', 'alpha.txt'), recordId: 'v3r-a', cwd: root })
    assert.equal(ref.status, 'unverified')
    assert.equal(ref.path, 'alpha.txt')
    assert.equal(ref.bytes, 13)
    assert.match(ref.sha256, /^[0-9a-f]{64}$/)

    await writeFile(path.join(root, 'alpha.txt'), 'alpha-changed', 'utf8')
    const stale = await verifyFileReference(ref)
    assert.equal(stale.status, 'stale')
    assert.equal(stale.reason, 'content-changed')

    const outside = await captureFileReference({ event: toolCall(2, 'c2', '../outside.txt'), recordId: 'v3r-b', cwd: root })
    assert.equal(outside.status, 'unverifiable')
    assert.equal(outside.reason, 'outside-workspace')

    const missing = await captureFileReference({ event: toolCall(3, 'c3', 'missing.txt'), recordId: 'v3r-c', cwd: root })
    assert.equal(missing.status, 'missing')
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})

function fakeCtx() {
  const handlers = new Map()
  const ctx = {
    on(name, handler) { handlers.set(name, handler); return () => handlers.delete(name) },
    logger: { warn() {}, info() {} },
  }
  ctx.callPreStep = async (session) => {
    const handler = handlers.get('agent/pre-step')
    if (!handler) throw new Error('未注册 pre-step')
    return await handler({ agent: { session }, signal: undefined }, async () => ({ kind: 'enter' }))
  }
  return ctx
}

async function settle(engine) {
  await new Promise((resolve) => setTimeout(resolve, 150))
  await engine._waitForIdle().catch(() => {})
  await new Promise((resolve) => setTimeout(resolve, 50))
}

test('engine：读文件工具调用产生引用；verify → stale；stale 排除后 recall 不注入', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-file-engine-'))
  const workspace = await mkdtemp(path.join(tmpdir(), 'mcl-file-ws-'))
  const ctx = fakeCtx()
  const engine = attachV3Engine(ctx, { v3Root: root })
  try {
    const session = createFakeSession({ cwd: workspace })
    await writeFile(path.join(workspace, 'alpha.txt'), 'alpha-content', 'utf8')
    session.pushUser('看看 alpha.txt')
    session.pushToolCall('c1', 'read', { path: 'alpha.txt' })
    session.pushToolResult('c1', 'alpha-content')
    await ctx.callPreStep(session)
    await settle(engine)

    const working = await engine.workingSet('session-fake')
    // B-3：真实宿主活动面不含 tool/call（log-only），工作集不应把它算进来。
    assert.equal(working.rows.find((row) => row.seq === 1), undefined, 'tool/call 不在活动面')

    const status = await engine.fileStatus('session-fake')
    assert.equal(status.error, undefined)
    assert.equal(status.refs.length, 1, 'log-only 调用也要产生文件引用（摄入不依赖活动面）')
    const toolRecordId = status.refs[0].recordId
    assert.equal(status.refs[0].status, 'unverified')

    await writeFile(path.join(workspace, 'alpha.txt'), 'alpha-changed', 'utf8')
    const verified = await engine.verifyFiles('session-fake', { recordId: toolRecordId })
    assert.equal(verified.rows[0].status, 'stale')

    const recalled = await engine.recallForInjection('session-fake', 'alpha', { turn: 2 })
    assert.notEqual(recalled.status, 'injected', 'stale 工具调用记录不得被自动回注')
  } finally {
    await engine._waitForIdle().catch(() => {})
    engine.dispose()
    await rm(root, { recursive: true, force: true }).catch(() => {})
    await rm(workspace, { recursive: true, force: true }).catch(() => {})
  }
})

test('recall excludeRecordIds：命中被排除后不注入（stale 过滤的单元面）', async () => {
  const provider = {
    health() { return { healthy: true } },
    capabilities() { return { backend: 'fake' } },
    async search() {
      return { pack: [{ id: 'r1', score: 1 }, { id: 'r2', score: 0.5 }], display: [{ id: 'r1' }, { id: 'r2' }], oovTerms: [] }
    },
    async read(id) { return { text: 'alpha text ' + id } },
  }
  const recall = createRecall({ provider, metrics: null, sessionKey: 's' })
  const result = await recall({ query: 'alpha', turn: 1, excludeRecordIds: ['r1', 'r2'] })
  assert.equal(result.injected, false)
  assert.equal((result.hits ?? []).length, 0)
})