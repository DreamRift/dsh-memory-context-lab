/**
 * 显式 T2 回填的引擎级集成测试（0.14.0-beta.38）。
 *
 * 用**真实 session store + 真实 composition**（T2 provider 用假实现，避免依赖 Python），
 * 钉住：
 * - 历史记录（T2 启用前已落库）可以显式回填，命令立即返回计划量；
 * - 回填只镜像 payload.text 非空的记录（metadata-only 跳过）；
 * - 重复执行幂等：同一记录不产生第二个节点、第二批计划量为 0；
 * - 覆盖率排除冒烟/拒绝节点；
 * - T2 不可用时明确报错，不回退 T1 假装成功；
 * - 索引缺失/损坏 → 可检索显示未知（不是 0）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { attachV3Engine } from '../src/v3/entry/v3-entry.mjs'
import { createV3Runtime } from '../src/v3/composition/composition.mjs'
import { T2_SMOKE_NODE_ID } from '../src/v3/contracts/t2.mjs'

const DESCRIBED = {
  name: '@furongjun1999/dsh-memory',
  version: '0.9.10',
  tools: ['cg'],
  smokePassed: true,
  isolated: true,
}

function fakeSession(id) {
  let seq = 0
  const events = []
  const store = new Map()
  const session = {
    id,
    log: events,
    events: () => events,
    surface: { nodes: [] },
    append(type, data) {
      seq += 1
      store.set(seq, { seq, type, data })
      session.surface.nodes = [...session.surface.nodes, seq]
      return { seq }
    },
    eventAt(s) { return store.get(s) },
    deriveMessages() { return [] },
    push(type, extra = {}) {
      const s = events.length
      events.push({ seq: s, type, at: s, data: extra.data ?? {}, ...extra })
      return events.at(-1)
    },
  }
  return session
}

function fakeCtx() {
  const handlers = new Map()
  const warnings = []
  return {
    warnings,
    on(name, handler) { handlers.set(name, handler); return () => handlers.delete(name) },
    logger: { warn: (message) => warnings.push(message), info() {} },
    async callPreStep(agent, decision = { kind: 'enter' }) {
      const handler = handlers.get('agent/pre-step')
      if (!handler) throw new Error('未注册 pre-step')
      return await handler({ agent, signal: undefined }, async () => decision)
    },
  }
}

/**
 * 假 T2 provider：真实写 md 节点文件（覆盖率扫描读磁盘），其余面最小实现。
 * mirrorStats.mirrored 是「已镜像集合的大小」，重复写同一 ID 不会增长——与 dsh-memory
 * 按 node_id 覆盖的语义一致，也让幂等断言有意义。
 */
function createFakeT2(directory) {
  const root = path.join(directory, 't2-mdcg')
  const mirrored = new Set()
  let failed = 0
  let dropped = 0
  const calls = []
  function writeNode(id) {
    const orphan = path.join(root, 'knowledge', 'orphan')
    mkdirSync(orphan, { recursive: true })
    writeFileSync(path.join(orphan, id + '.md'), '# fake node ' + id + '\n')
  }
  const provider = {
    async search() { return { display: [], pack: [], oovTerms: [] } },
    async read() { return { text: '' } },
    async health() { return { healthy: true } },
    async indexStats() { return { state: 'ok', indexedCount: mirrored.size } },
    capabilities() { return { name: 'fake-t2', tier: 'T2', isolated: true, root } },
    mirrorRecord(record_) {
      if (typeof record_?.payload?.text !== 'string' || record_.payload.text.length === 0) { dropped += 1; return }
      calls.push(record_.id)
      mirrored.add(record_.id)
      writeNode(record_.id)
    },
    async flush() {},
    mirrorStats() {
      return { mirrored: mirrored.size, mirrorFailed: failed, mirrorDropped: dropped, pending: 0, forgetFailed: 0, lastError: null }
    },
    async cleanupSmoke() { return { ok: true, nodeId: T2_SMOKE_NODE_ID } },
    async close() {},
  }
  return {
    provider,
    root,
    calls,
    mirrored,
    failOne() { failed += 1 },
    reset() { mirrored.clear(); calls.length = 0; failed = 0; dropped = 0 },
  }
}

async function listMd(root) {
  const out = []
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.name.endsWith('.md')) out.push(entry.name.slice(0, -3))
    }
  }
  try { await walk(root) } catch (error) { if (error?.code !== 'ENOENT') throw error }
  return out
}

test('历史记录显式回填：计划量 → 后台完成 → 幂等重跑 → 覆盖率排除冒烟节点', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-backfill-'))
  const ctx = fakeCtx()
  let t2 = null
  const engine = attachV3Engine(ctx, {
    v3Root: root,
    runtimeFactory: async (dshSession, sessionId) => {
      if (sessionId === 's-t1') {
        return await createV3Runtime({ v3Root: root, dshSession, sessionKey: sessionId, memoryProbe: async () => null })
      }
      t2 = createFakeT2(path.join(root, 'sessions', sessionId))
      return await createV3Runtime({
        v3Root: root,
        dshSession,
        sessionKey: sessionId,
        memoryProbe: async () => ({ ...DESCRIBED }),
        t2ProviderFactory: async () => t2.provider,
      })
    },
  })
  try {
    const session = fakeSession('s-backfill')
    session.push('user/message', { data: { text: '第一条可镜像正文' } })
    session.push('assistant/message', { data: { message: { content: [{ type: 'reasoning', text: '只有推理，没有可见文本' }] } } })
    session.push('user/message', { data: { text: '第二条可镜像正文' } })
    session.push('assistant/message', { data: { message: { content: [{ type: 'tool-call', id: 'c1', name: 'read', arguments: '{}' }] } } })
    session.push('user/message', { data: { text: '第三条可镜像正文' } })
    await ctx.callPreStep({ session })
    await engine._waitForIdle()
    assert.equal(t2.mirrored.size, 3, '正常摄入的正文会即时镜像（composition 单一入口）')
    await t2.provider.flush()

    // 模拟「T2 启用前的历史」：清掉隔离根与内存计数，但本地记录保留。
    await rm(t2.root, { recursive: true, force: true })
    t2.reset()

    const first = await engine.startT2Backfill('s-backfill', '2')
    assert.equal(first.error, undefined, JSON.stringify(first))
    assert.equal(first.planned, 2, '命令立即返回计划量')
    assert.equal(first.records.mirrorable, 3, '分母只算 payload.text 非空的记录')
    assert.equal(first.records.metaOnly, 2, 'metadata-only 不进分母')
    await engine._waitForIdle()

    let state = await engine.t2BackfillState('s-backfill')
    assert.equal(state.state.status, 'done')
    assert.equal(state.state.planned, 2)
    assert.equal(state.state.mirrored, 2)
    assert.equal(state.state.failed, 0)
    assert.equal((await listMd(t2.root)).length, 2)

    // 第二批：只剩 1 条待回填。
    const second = await engine.startT2Backfill('s-backfill', '2')
    assert.equal(second.planned, 1)
    await engine._waitForIdle()
    assert.equal((await listMd(t2.root)).length, 3)
    assert.equal(new Set(await listMd(t2.root)).size, 3, '同一记录不得产生重复节点')

    // 第三批：全部已镜像 → 计划 0，重复执行不改磁盘。
    const third = await engine.startT2Backfill('s-backfill', '2')
    assert.equal(third.planned, 0, '幂等：重复执行不重复写')
    assert.equal(third.pendingTotal, 0)
    await engine._waitForIdle()
    assert.equal((await listMd(t2.root)).length, 3)

    // 冒烟/拒绝节点存在时，覆盖率必须排除它们。
    mkdirSync(path.join(t2.root, 'knowledge', 'orphan'), { recursive: true })
    writeFileSync(path.join(t2.root, 'knowledge', 'orphan', T2_SMOKE_NODE_ID + '.md'), 'x')
    writeFileSync(path.join(t2.root, 'knowledge', 'orphan', 'rej_1234567890.md'), 'x')
    const info = await engine.t2Info('s-backfill')
    assert.equal(info.coverage.records.mirrorable, 3)
    assert.equal(info.coverage.records.metaOnly, 2)
    assert.equal(info.coverage.mirrored.mirrored, 3, '冒烟/拒绝节点不计入真实覆盖')
    assert.equal(info.coverage.mirrored.smoke, 1)
    assert.equal(info.coverage.mirrored.rejected, 1)
    assert.equal(info.backfill.state.status, 'done')
    assert.equal(info.backfill.running, false)

    // 非法参数：回用法错误，不夹值、不启动任务。
    for (const bad of ['0', '2001', 'abc']) {
      const result = await engine.startT2Backfill('s-backfill', bad)
      assert.equal(result.error, 'invalid-limit', bad)
      assert.match(result.message, /1–2000/)
    }

    const cleaned = await engine.cleanupSmokeNode('s-backfill')
    assert.deepEqual(cleaned, { ok: true, nodeId: T2_SMOKE_NODE_ID })
  } finally {
    await engine._waitForIdle().catch(() => {})
    engine.dispose()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})

test('T2 不可用时回填明确报错；索引缺失/损坏时可检索显示未知', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-backfill-t1-'))
  const ctx = fakeCtx()
  const engine = attachV3Engine(ctx, {
    v3Root: root,
    runtimeFactory: async (dshSession, sessionId) => createV3Runtime({
      v3Root: root,
      dshSession,
      sessionKey: sessionId,
      memoryProbe: async () => null,
    }),
  })
  try {
    const session = fakeSession('s-t1')
    session.push('user/message', { data: { text: 'T1 会话正文' } })
    await ctx.callPreStep({ session })
    await engine._waitForIdle()

    const result = await engine.startT2Backfill('s-t1', '20')
    assert.equal(result.error, 't2-unavailable', 'T2 未启用必须明确失败')
    assert.match(result.reason, /T1|未配置|探测/, '失败原因要可判读')

    const indexPath = path.join(root, 'sessions', 's-t1', 'lexical-index.json')
    await rm(indexPath, { force: true })
    let inspected = await engine.inspect('s-t1')
    assert.equal(inspected.searchable.state, 'absent', '索引缺失必须显示未知，不是 0')

    await writeFile(indexPath, '{ not json')
    inspected = await engine.inspect('s-t1')
    assert.equal(inspected.searchable.state, 'error', '索引损坏必须显示错误，不是 0')
    assert.ok(inspected.records >= 1, '已摄入条数仍可读')
  } finally {
    await engine._waitForIdle().catch(() => {})
    engine.dispose()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})
