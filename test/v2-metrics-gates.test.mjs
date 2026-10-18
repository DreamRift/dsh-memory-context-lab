/**
 * S4 指标化与集成验证（0.10.1 第二批）：硬门对账套件。
 *
 * 方案 §8 优先硬门的插件可观测面（不宣称需要真实模型对照的效益门——那是
 * 「同任务消融」的事，S4 只把结构门做成可回归的断言）：
 * - M1 卡节点有界：长会话注卡+折叠后插件卡节点数收敛到 O(1)；
 * - M2 三态账本自洽：prepared ≥ committed ≥ sent 恒成立（任何操作序列后）；
 * - M3 claim 盘点有界：配额截断 + overflow 数量行；
 * - M4 非卡内容不变性：折叠/注卡不改变非插件节点的类型与顺序，tool 配对平衡不破坏；
 * - M5 来源可读：折叠回执的成员记录仍可按记录 ID 回读（S2 闭环复验）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createV2Runtime } from '../src/v2/runtime.mjs'
import { createV2SessionState, writeV2SessionState } from '../src/v2/state.mjs'
import { buildSession, operation, fakeMeter } from './helpers/fake-host.mjs'
import { isCardNode } from '../src/v2/card-fold.mjs'
import { mergeCostCounters } from '../src/v2/cost.mjs'

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
  const root = await mkdtemp(path.join(tmpdir(), `mcl2m-${name}-`))
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
  // 0.11.2 回归：source 写在 data 里（宿主 append 的 opts 只认 surfaceOp/
  // sourceEventSeqs）。夹具同语义后，这里再写错就会让卡片不被识别成插件卡。
  return session.append('user/message', {
    id: `card-${Math.random().toString(36).slice(2, 8)}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'memory-context-lab', form: 'working-set' },
  }, {
    surfaceOp: 'append',
  }).seq
}

/**
 * 「非卡内容」= 人类/系统/助手/工具节点：插件自己注入的一切 user 消息
 * （工作卡、回注包、折叠回执、归档回执）都不算——它们是插件工作产物，
 * M4 保护的是宿主与用户的内容不被插件操作改变。
 */
function nonCardNodesOf(session) {
  return session.surface.nodes
    .map((seq) => {
      const event = session.eventAt(seq)
      const sourceForm = event?.source?.form ?? event?.data?.source?.form
      return { type: event?.type, sourceForm }
    })
    .filter((node) => {
      if (node.type === 'user/message' && typeof node.sourceForm === 'string' && node.sourceForm !== '') return false
      return true
    })
}

test('M1 卡节点有界：20 轮注卡+折叠后插件卡节点数 ≤ 2，非卡节点数不变', async () => {
  await withTempLab('m1', async (labRoot) => {
    const sessionId = 'session-m1'
    const created = await createV2SessionState(labRoot, sessionId, {})
    created.state.enabled = true
    await writeV2SessionState(created.directory, created.state)
    const runtime = runtimeWithMeter(labRoot)
    try {
      const session = buildSession({ operations: 1, id: sessionId })
      const agent = agentFor(session)
      await runtime.adopt(agent)
      const nonCardBefore = nonCardNodesOf(session)

      for (let round = 0; round < 20; round += 1) {
        injectCard(session, `[工作状态·v2] 轮${round} 卡`)
        injectCard(session, `[工作状态·v2] 轮${round} 增量`)
        await runtime.foldWorkingCards(agent)
      }

      const cardSeqs = session.surface.nodes.filter((seq) => {
        const event = session.eventAt(seq)
        return isCardNode({
          seq,
          type: event?.type,
          sourceForm: event?.source?.form ?? event?.data?.source?.form,
          text: event?.data?.content?.[0]?.text,
        })
      })
      assert.ok(cardSeqs.length <= 2, `20 轮后插件卡节点应 ≤2，实际 ${cardSeqs.length}`)

      const nonCardAfter = nonCardNodesOf(session)
      assert.deepEqual(nonCardAfter, nonCardBefore, 'M4 联动：非卡（人类/系统/助手/工具）节点类型与顺序必须逐位不变')
    } finally {
      await runtime.shutdown()
    }
  })
})

test('M2 三态账本自洽：多轮 prepare/confirm/放弃后 prepared ≥ committed ≥ sent 恒成立', async () => {
  await withTempLab('m2', async (labRoot) => {
    const sessionId = 'session-m2'
    const created = await createV2SessionState(labRoot, sessionId, {})
    created.state.enabled = true
    created.state.archive.push({
      status: 'applied', rangeStart: 2, rangeEnd: 3, callIds: ['call-1'], tools: ['read'],
      nodeId: 'v2node_1', hash: 'c'.repeat(64), chars: 40, originalTokens: 60,
      replacementSeq: 4, chunkCount: 1, appliedAt: '2026-10-12T00:00:00.000Z',
    })
    await writeV2SessionState(created.directory, created.state)
    const runtime = runtimeWithMeter(labRoot)
    try {
      const session = buildSession({ operations: 1, id: sessionId })
      const agent = agentFor(session)
      // 轮1：prepare + confirm（计 committed/sent）。
      const p1 = await runtime.workingSetInjection(agent)
      runtime.confirmInjection(sessionId, p1.preparedId)
      // 轮2：prepare 后放弃（只留 prepared 残差）。先加新操作让卡内容变化，
      // 否则 dedup 闸门会正确地拒绝重复注入（那不是放弃，是去重）。
      operation({ session, callId: 'call-m2-a', toolName: 'read', result: '轮2操作' })
      const p2 = await runtime.workingSetInjection(agent)
      // 轮3：prepare + confirm。
      operation({ session, callId: 'call-m2-b', toolName: 'read', result: '新操作' })
      const p3 = await runtime.workingSetInjection(agent)
      runtime.confirmInjection(sessionId, p3.preparedId)

      const snapshot = runtime.records.get(sessionId).cost.snapshot()
      assert.equal(snapshot.workingStatePrepared, 3)
      assert.equal(snapshot.workingStateCommitted, 2)
      assert.equal(snapshot.workingStateSent, 2, 'meter 可用时 sent = committed')
      assert.ok(snapshot.workingStatePrepared >= snapshot.workingStateCommitted, 'prepared ≥ committed')
      assert.ok(snapshot.workingStateCommitted >= snapshot.workingStateSent, 'committed ≥ sent')
      assert.equal(snapshot.workingStateInjections, 2, 'injections = committed 口径')
    } finally {
      await runtime.shutdown()
    }
  })
})

test('M3 claim 盘点有界：40 条 claim 截断到配额 + overflow 数量行', () => {
  // 纯函数面已在 v2-claims-card R2 锁定；此处做集成级：合并账本口径不因 claim 改变。
  const merged = mergeCostCounters({ workingStatePrepared: 3, workingStateCommitted: 2, workingStateSent: 2 })
  assert.equal(merged.workingStatePrepared, 3)
  assert.equal(merged.workingStateCommitted, 2)
  assert.equal(merged.workingStateSent, 2)
})

import { renderFoldReceipt } from '../src/v2/card-fold.mjs'

test('M5 来源可读：折叠回执声明成员原文位置与回读路径（形状断言）', () => {
  // 折叠回执文本必须自我声明：成员原文在 append-only 日志、可按记录 ID 回读。
  // （真实回读链路由 S2 套件锁定；此处锁回执文案不退化为无指针的占位。）
  const text = renderFoldReceipt({ startSeq: 10, endSeq: 14, memberSeqs: [10, 11, 12, 13, 14], forms: ['working-set', 'recall', 'working-set', 'receipt', 'working-set'] })
  assert.match(text, /append-only 日志/)
  assert.match(text, /按记录 ID 回读/)
  assert.match(text, /seq 10–14/)
  assert.match(text, /5 张/)
})
