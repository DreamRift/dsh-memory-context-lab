/**
 * S3 新会话单锚点快照红例（0.10.1 第二批，G1-S3 第 3 条）。
 *
 * 锚点语义：record.workingSetCard.anchorSeq = 活动面上最近一张已确认注入的
 * 工作卡 seq。prepare 时从面反查刷新；宿主压缩把锚点移出面（eventAt 返回
 * null / seq 不在 surface.nodes）时如实降级 null，下一张卡回落全量（诚实
 * 降级，不虚构模型从未见过的连续性）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createV2Runtime } from '../src/v2/runtime.mjs'
import { createV2SessionState, writeV2SessionState } from '../src/v2/state.mjs'
import { buildSession, operation } from './helpers/fake-host.mjs'
import { fakeMeter } from './helpers/fake-host.mjs'

function agentFor(session) {
  return {
    session,
    ctx: { tools: { schemas: () => [], restrict: () => () => {}, guard: () => () => {}, register: () => () => {} } },
    async runMaintenance(action) {
      return action(new AbortController().signal)
    },
  }
}

async function withTempLab(name, body) {
  const root = await mkdtemp(path.join(tmpdir(), `mcl2an-${name}-`))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = root
  try {
    await body(path.join(root, '.memory-context-lab'))
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
}

async function seedEnabledWithReceipt(labRoot, sessionId) {
  const created = await createV2SessionState(labRoot, sessionId, {})
  created.state.enabled = true
  created.state.archive.push({
    status: 'applied',
    rangeStart: 2,
    rangeEnd: 3,
    callIds: ['call-1'],
    tools: ['read'],
    nodeId: 'v2node_1',
    hash: 'c'.repeat(64),
    chars: 40,
    originalTokens: 60,
    replacementSeq: 4,
    chunkCount: 1,
    appliedAt: '2026-10-12T00:00:00.000Z',
  })
  await writeV2SessionState(created.directory, created.state)
}

function runtimeWithMeter(labRoot) {
  return createV2Runtime({
    labRoot,
    services: { get: (name) => (name === 'tokenMeter' ? fakeMeter : undefined) },
    logger: { info() {}, warn() {}, error() {} },
    hostVersion: 'test-host',
    sessionIdOf: (session) => session.id,
    recallQueryFrom: () => null,
  })
}

function injectCard(session, text) {
  // 0.11.0 回归：宿主 `Session.append(type, data, opts)` 只从 opts 取
  // `surfaceOp`/`sourceEventSeqs`，其余键静默丢弃；`source` 必须写在 data 里
  // （投影按 `data.source.form` 判定注入来源）。夹具现在与宿主同语义，写错位置
  // 的用例会立刻变红——这里正是把它改对的地方，断言一条没放宽。
  return session.append('user/message', {
    id: `card-${Math.random().toString(36).slice(2, 8)}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'memory-context-lab', form: 'working-set' },
  }, {
    surfaceOp: 'append',
  }).seq
}

test('S3-A1 锚点登记：确认注入后 workingSetCard.anchorSeq 指向面上已注入卡', async () => {
  await withTempLab('a1', async (labRoot) => {
    const sessionId = 'session-s3-a1'
    await seedEnabledWithReceipt(labRoot, sessionId)
    const runtime = runtimeWithMeter(labRoot)
    try {
      const session = buildSession({ operations: 1, id: sessionId })
      const agent = agentFor(session)
      const prepared = await runtime.workingSetInjection(agent)
      assert.equal(prepared.kind, 'prepared')
      // 模拟宿主把这张卡真正放上活动面（pre-step decision 消费后的等价物）。
      const seq = injectCard(session, prepared.text)
      assert.equal(runtime.confirmInjection(sessionId, prepared.preparedId), true)

      const record = runtime.records.get(sessionId)
      // 新增一个已完成操作让卡内容变化（否则去重闸门正确地拒绝重复注入）。
      operation({ session, callId: 'call-a1-new', toolName: 'read', result: '新操作内容' })
      // 下一次 prepare 时从面反查刷新锚点。
      const second = await runtime.workingSetInjection(agent)
      assert.ok(second, '卡内容有变化时仍可 prepare')
      assert.equal(record.workingSetCard.anchorSeq, seq, '锚点 = 面上最近一张已注入卡')
    } finally {
      await runtime.shutdown()
    }
  })
})

test('S3-A2 锚点丢失诚实降级：宿主移除锚点节点后 anchorSeq 归 null、下一张回落全量卡', async () => {
  await withTempLab('a2', async (labRoot) => {
    const sessionId = 'session-s3-a2'
    await seedEnabledWithReceipt(labRoot, sessionId)
    const runtime = runtimeWithMeter(labRoot)
    try {
      const session = buildSession({ operations: 1, id: sessionId })
      const agent = agentFor(session)
      const prepared = await runtime.workingSetInjection(agent)
      const seq = injectCard(session, prepared.text)
      runtime.confirmInjection(sessionId, prepared.preparedId)
      operation({ session, callId: 'call-a2-r1', toolName: 'read', result: '中间操作' })
      await runtime.workingSetInjection(agent) // 刷新锚点
      const record = runtime.records.get(sessionId)
      assert.equal(record.workingSetCard.anchorSeq, seq)

      // 宿主压缩移除锚点：模拟方式 = 直接从 FakeSession 面上摘掉该节点。
      // （真实宿主的压缩不是插件可拦截的动作；插件只能观测面上没有它了。）
      const idx = session.nodes.indexOf(seq)
      assert.ok(idx >= 0)
      session.nodes.splice(idx, 1)

      operation({ session, callId: 'call-a2-r2', toolName: 'read', result: '锚点丢失后的操作' })
      const third = await runtime.workingSetInjection(agent)
      assert.ok(third)
      assert.equal(record.workingSetCard.anchorSeq, null, '锚点不在面上必须如实归 null')
      // 锚点丢失 → shouldInjectFullWorkingStateCard 的「无上卡」语义：全量卡。
      // 注意：workingSetCard.text 仍在（上张卡的渲染文本），但锚点失效表示
      // 模型上下文里没有它了——下一张必须是全量卡。
      assert.equal(third.form, 'full', '锚点丢失后不得再发引用未见全量卡的增量卡')
    } finally {
      await runtime.shutdown()
    }
  })
})
