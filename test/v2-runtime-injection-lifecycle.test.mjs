/**
 * S3 注入生命周期（prepare→宿主确认→commit）红例先行套件（0.10.1 第二批）。
 *
 * 方案 §6「缺失的提交确认」：runtime 在宿主实际追加前已推进卡状态和计费，
 * 「确定要注入」≠「已经持久化」。本套件锁死三态计数分离：
 * - workingSetInjection 返回 prepared 载荷（kind:'prepared'、preparedId、text、form），
 *   **不**推进 workingSetCard / dedupKey 历史 / 成本计数；
 * - confirmInjection(sessionId, preparedId) 只在宿主确认后推进状态与计数
 *   （workingStatePrepared / workingStateCommitted / workingStateSent）；
 * - 未确认的 prepared 不产生任何 committed/sent 计数，也不被下一张卡的去重
 *   逻辑误认为「已注入」。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createV2Runtime } from '../src/v2/runtime.mjs'
import { createV2SessionState, writeV2SessionState } from '../src/v2/state.mjs'
import { buildSession } from './helpers/fake-host.mjs'
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
  const root = await mkdtemp(path.join(tmpdir(), `mcl2lc-${name}-`))
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

/** 预置启用态 + 一条已应用回执（等价于「本会话确实有历史退出了热上下文」）。 */
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

test('S3-L1 prepare 不计数：workingSetInjection 返回 prepared 载荷，账本三态计数全为 0', async () => {
  await withTempLab('l1', async (labRoot) => {
    const sessionId = 'session-s3-l1'
    await seedEnabledWithReceipt(labRoot, sessionId)
    const runtime = runtimeWithMeter(labRoot)
    try {
      const session = buildSession({ operations: 1, id: sessionId })
      const prepared = await runtime.workingSetInjection(agentFor(session))
      // prepared 载荷形状：kind 必须标明「这是已准备、未确认」的状态。
      assert.ok(prepared, '有退热回执时必须能 prepare 出一张卡')
      assert.equal(prepared.kind, 'prepared')
      assert.equal(typeof prepared.preparedId, 'string')
      assert.ok(prepared.preparedId.length > 0)
      assert.equal(typeof prepared.text, 'string')
      assert.ok(prepared.text.length > 0)
      assert.equal(prepared.form, 'full', '会话首卡必须是全量卡')

      const snapshot = runtime.records.get(sessionId)?.cost.snapshot()
      assert.ok(snapshot, '注入后 record 必须在册')
      // prepared 计数器语义：如实记录每次 prepare（这是「跑过 prepare」的可观测
      // 事实）；未确认的残差 = prepared − committed，报表三态行据此对账。
      assert.equal(snapshot.workingStatePrepared, 1, 'prepare 如实计数（未确认残差的分子）')
      assert.equal(snapshot.workingStateCommitted, 0, '确认前不得 commit')
      assert.equal(snapshot.workingStateSent, 0)
      assert.equal(snapshot.workingStateInjections, 0, '确认前不得计入「已注入」')
      assert.equal(snapshot.workingStateTokens, 0)
    } finally {
      await runtime.shutdown()
    }
  })
})

test('S3-L2 确认才 commit：confirmInjection 后三态计数对账（prepared=1, committed=1, sent 含 meter token）', async () => {
  await withTempLab('l2', async (labRoot) => {
    const sessionId = 'session-s3-l2'
    await seedEnabledWithReceipt(labRoot, sessionId)
    const runtime = runtimeWithMeter(labRoot)
    try {
      const session = buildSession({ operations: 1, id: sessionId })
      const agent = agentFor(session)
      const prepared = await runtime.workingSetInjection(agent)
      assert.equal(prepared.kind, 'prepared')

      // 宿主确认：模拟 index.mjs 拿到 decision 后实际 append 的动作。
      const confirmed = runtime.confirmInjection(sessionId, prepared.preparedId)
      assert.equal(confirmed, true, '合法 preparedId 必须确认成功')

      const snapshot = runtime.records.get(sessionId).cost.snapshot()
      assert.equal(snapshot.workingStatePrepared, 1)
      assert.equal(snapshot.workingStateCommitted, 1)
      assert.equal(snapshot.workingStateInjections, 1, '确认后按既有口径计入注入次数（报表连续性）')
      assert.equal(snapshot.workingStateFullInjections, 1)
      assert.ok(snapshot.workingStateTokens > 0, '宿主 meter 可用时 sent token 必须入账')
      const expected = fakeMeter.estimateMessage({ role: 'user', content: [{ type: 'text', text: prepared.text }] })
      assert.equal(snapshot.workingStateTokens, expected, 'sent 入账 = 宿主 meter 口径')

      // 已确认的 preparedId 不得重复确认（幂等保护：二次确认返回 false，不重复计数）。
      assert.equal(runtime.confirmInjection(sessionId, prepared.preparedId), false)
      const after = runtime.records.get(sessionId).cost.snapshot()
      assert.equal(after.workingStateCommitted, 1)
    } finally {
      await runtime.shutdown()
    }
  })
})

test('S3-L3 abort 不残留：prepared 未确认就放弃，下一张卡不受去重历史污染', async () => {
  await withTempLab('l3', async (labRoot) => {
    const sessionId = 'session-s3-l3'
    await seedEnabledWithReceipt(labRoot, sessionId)
    const runtime = runtimeWithMeter(labRoot)
    try {
      const session = buildSession({ operations: 1, id: sessionId })
      const agent = agentFor(session)
      const prepared = await runtime.workingSetInjection(agent)
      assert.equal(prepared.kind, 'prepared')
      // 不确认（模拟宿主拒绝了这一步 / signal aborted / decision 不是 enter）。

      // 下一次 prepare：workingSetCard 未推进（上一张是 prepared 未确认），
      // 所以下一张仍是全量卡，dedup 键历史不包含被放弃的卡。
      const second = await runtime.workingSetInjection(agent)
      assert.equal(second.kind, 'prepared')
      assert.equal(second.form, 'full', '放弃的 prepared 不推进注入状态，下一张仍是首卡语义')
      assert.notEqual(second.preparedId, prepared.preparedId)

      const snapshot = runtime.records.get(sessionId).cost.snapshot()
      assert.equal(snapshot.workingStateCommitted, 0)
      assert.equal(snapshot.workingStateInjections, 0)
    } finally {
      await runtime.shutdown()
    }
  })
})

test('S3-L4 未 meter 场景：confirm 后 sent 缺口单独计数，不折算混记（D5 纪律延续）', async () => {
  await withTempLab('l4', async (labRoot) => {
    const sessionId = 'session-s3-l4'
    await seedEnabledWithReceipt(labRoot, sessionId)
    const runtime = createV2Runtime({
      labRoot,
      services: { get: () => undefined },
      logger: { info() {}, warn() {}, error() {} },
      hostVersion: 'test-host',
      sessionIdOf: (session) => session.id,
      recallQueryFrom: () => null,
    })
    try {
      const session = buildSession({ operations: 1, id: sessionId })
      const prepared = await runtime.workingSetInjection(agentFor(session))
      assert.equal(prepared.kind, 'prepared')
      assert.equal(runtime.confirmInjection(sessionId, prepared.preparedId), true)
      const snapshot = runtime.records.get(sessionId).cost.snapshot()
      assert.equal(snapshot.workingStateCommitted, 1)
      assert.equal(snapshot.workingStateTokens, 0, 'meter 不可用不折算')
      assert.equal(snapshot.workingStateTokensUnmetered, 1, '缺口单独计数')
    } finally {
      await runtime.shutdown()
    }
  })
})
