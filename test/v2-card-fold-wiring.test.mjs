/**
 * S3 卡片组折叠接线红例（0.10.1 第二批）：runtime.foldWorkingCards 在真实
 * FakeSession 表面上的端到端行为。
 *
 * 依赖 G1-S3 第 2/3 条：
 * - 折叠经 surface replace 合法通道提交（surfaceOp + sourceEventSeqs 全覆盖）；
 * - 被吞区间只含插件卡；assistant/tool/人类消息一个不动；
 * - 折叠后插件卡节点数收敛（有界治理的目标 observable）。
 * - 折叠回执以 V2_RECEIPT_MARKER 开头（可被后续折叠/凭证收集器识别），
 *   且不重复折叠（二次调用幂等：无新卡组时不再产生 replace）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createV2Runtime } from '../src/v2/runtime.mjs'
import { createV2SessionState, writeV2SessionState } from '../src/v2/state.mjs'
import { buildSession, FakeSession } from './helpers/fake-host.mjs'
import { fakeMeter } from './helpers/fake-host.mjs'
import { V2_RECEIPT_MARKER } from '../src/core.mjs'
import { isCardNode } from '../src/v2/card-fold.mjs'

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
  const root = await mkdtemp(path.join(tmpdir(), `mcl2fc-${name}-`))
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

async function seedEnabled(labRoot, sessionId) {
  const created = await createV2SessionState(labRoot, sessionId, {})
  created.state.enabled = true
  await writeV2SessionState(created.directory, created.state)
}

function injectCard(session, text = '[工作状态·v2] 第几张卡', seqHint = null) {
  // 0.11.0 回归：source 属于消息体（data），不属于 append 的 opts——宿主只摊
  // surfaceOp/sourceEventSeqs。写在 opts 里会被静默丢弃，折叠器就认不出这是
  // 插件卡。夹具已收紧到宿主语义，这里必须按真实形状构造。
  const event = session.append('user/message', {
    id: `card-${Math.random().toString(36).slice(2, 8)}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'memory-context-lab', form: 'working-set' },
  }, {
    surfaceOp: 'append',
  })
  return event.seq
}

test('S3-W1 foldWorkingCards：连续卡组被折叠成单回执，非卡消息一个不动', async () => {
  await withTempLab('w1', async (labRoot) => {
    const sessionId = 'session-s3-w1'
    await seedEnabled(labRoot, sessionId)
    const runtime = createV2Runtime({
      labRoot,
      services: { get: (name) => (name === 'tokenMeter' ? fakeMeter : undefined) },
      logger: { info() {}, warn() {}, error() {} },
      hostVersion: 'test-host',
      sessionIdOf: (session) => session.id,
      recallQueryFrom: () => null,
    })
    try {
      const session = buildSession({ operations: 1, id: sessionId })
      const agent = agentFor(session)
      await runtime.adopt(agent)

      // 表面上追加 3 张连续插件卡。
      const before = session.surface.nodes.length
      injectCard(session, '[工作状态·v2] 卡1')
      injectCard(session, '[工作状态·v2] 卡2')
      injectCard(session, '[工作状态·v2] 卡3')
      const cardSeqs = [...session.surface.nodes]
      const nodesBefore = session.surface.nodes.length

      const outcome = await runtime.foldWorkingCards(agent)
      assert.equal(outcome.folded, 1, '三连卡组折叠成 1 条回执')
      assert.ok(Array.isArray(outcome.receipts))

      const nodesAfter = session.surface.nodes.length
      // 0.12.0 P0-4：最新一张工作状态卡永远保护（它是模型当前能看到的状态面），
      // 所以 3 张卡里只有前 2 张被折，净减 1 个节点。
      assert.equal(nodesAfter, nodesBefore - 1, '3 张卡（最新一张受保护）→ 折叠前 2 张成 1 条回执，净减 1 个节点')
      const newestSeq = cardSeqs.at(-1)
      assert.ok(session.surface.nodes.includes(newestSeq), '最新一张工作卡必须仍在活动面上（P0-4 保护）')

      // 折叠回执以 V2_RECEIPT_MARKER 开头（可被后续流程识别为凭证）。
      const foldNodeSeq = session.surface.nodes.find((seq) => {
        const event = session.eventAt(seq)
        const first = event?.data?.content?.[0]
        return typeof first?.text === 'string' && first.text.startsWith('[已折叠工作卡')
      })
      assert.ok(foldNodeSeq !== undefined, '折叠回执必须在活动面上')
      const foldEvent = session.eventAt(foldNodeSeq)
      assert.ok(foldEvent.sourceEventSeqs.includes(cardSeqs.at(-3)), 'sourceEventSeqs 必须覆盖被吞卡的 seq')
      assert.ok(foldEvent.sourceEventSeqs.includes(cardSeqs.at(-2)), 'sourceEventSeqs 覆盖被吞的第二张卡')
      assert.ok(!foldEvent.sourceEventSeqs.includes(cardSeqs.at(-1)), '最新一张卡受保护，不得进入替换区间')

      // 人类/系统/助手/工具消息一个不动。
      const preserved = session.surface.nodes.filter((seq) => !cardSeqs.slice(-3).includes(seq))
      for (const seq of preserved) {
        const event = session.eventAt(seq)
        assert.ok(event, '非卡节点必须原样保留在面上')
      }
    } finally {
      await runtime.shutdown()
    }
  })
})

test('S3-W2 幂等：无新卡组时二次折叠不产生新的 replace（replaceGeneration 不变）', async () => {
  await withTempLab('w2', async (labRoot) => {
    const sessionId = 'session-s3-w2'
    await seedEnabled(labRoot, sessionId)
    const runtime = createV2Runtime({
      labRoot,
      services: { get: (name) => (name === 'tokenMeter' ? fakeMeter : undefined) },
      logger: { info() {}, warn() {}, error() {} },
      hostVersion: 'test-host',
      sessionIdOf: (session) => session.id,
      recallQueryFrom: () => null,
    })
    try {
      const session = buildSession({ operations: 1, id: sessionId })
      const agent = agentFor(session)
      await runtime.adopt(agent)
      injectCard(session, '[工作状态·v2] 卡1')
      injectCard(session, '[工作状态·v2] 卡2')
      // 0.12.0 P0-4：最新一张卡受保护，所以两张卡时凑不满 minRun=2，不会折叠。
      const zero = await runtime.foldWorkingCards(agent)
      assert.equal(zero.folded, 0, '两张卡里最新一张受保护，剩 1 张不够 minRun')
      injectCard(session, '[工作状态·v2] 卡3')
      const first = await runtime.foldWorkingCards(agent)
      assert.equal(first.folded, 1)
      const genAfterFirst = session.surface.replaceGeneration

      const second = await runtime.foldWorkingCards(agent)
      assert.equal(second.folded, 0, '折叠回执本身不在卡组身份集内（marker 是折叠回执不是工作卡），无新组可折')
      assert.equal(session.surface.replaceGeneration, genAfterFirst, '没有新的 replace 事件')
    } finally {
      await runtime.shutdown()
    }
  })
})

test('S3-W3 端到端有界性：注卡 N 轮后调折叠，插件卡节点数收敛到 O(1)', async () => {
  await withTempLab('w3', async (labRoot) => {
    const sessionId = 'session-s3-w3'
    await seedEnabled(labRoot, sessionId)
    const runtime = createV2Runtime({
      labRoot,
      services: { get: (name) => (name === 'tokenMeter' ? fakeMeter : undefined) },
      logger: { info() {}, warn() {}, error() {} },
      hostVersion: 'test-host',
      sessionIdOf: (session) => session.id,
      recallQueryFrom: () => null,
    })
    try {
      const session = buildSession({ operations: 1, id: sessionId })
      const agent = agentFor(session)
      await runtime.adopt(agent)

      // 模拟 6 轮注卡（每轮 2 张）+ 折叠。
      for (let round = 0; round < 6; round += 1) {
        injectCard(session, `[工作状态·v2] 轮${round} 卡A`)
        injectCard(session, `[工作状态·v2] 轮${round} 卡B`)
        await runtime.foldWorkingCards(agent)
      }

      // 活动面上插件工作卡（form ∈ 卡集）节点数必须 ≤ 2（一轮最多留 1 张折叠回执 + 尾部新卡）。
      const cardSeqs = session.surface.nodes.filter((seq) => {
        const event = session.eventAt(seq)
        const sourceForm = event?.source?.form ?? event?.data?.source?.form
        return isCardNode({ seq, type: event?.type, sourceForm, text: event?.data?.content?.[0]?.text })
      })
      assert.ok(cardSeqs.length <= 2, `6 轮注卡后插件卡节点应收敛到 ≤2，实际 ${cardSeqs.length}`)

      // 折叠回执数也应有界：每轮一条 → 6 条折叠回执。这些回执自身以 V2_RECEIPT_MARKER
      // 开头，会被全历史模式的凭证收集器按不可压缩凭证保护（不再二次折叠，不无限增长）。
      const foldReceipts = session.surface.nodes.filter((seq) => {
        const first = session.eventAt(seq)?.data?.content?.[0]
        return typeof first?.text === 'string' && first.text.startsWith('[已折叠工作卡')
      })
      assert.ok(foldReceipts.length <= 6, `折叠回执每轮至多 1 条，实际 ${foldReceipts.length}`)
    } finally {
      await runtime.shutdown()
    }
  })
})
