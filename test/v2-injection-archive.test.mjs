/**
 * P0-4 注入物降温：从「能归档」到「有上界」（0.12.0）。
 *
 * 现实（必须一起处理）：
 * - G2：现有折叠在真实「每步一卡」形态下几乎不触发（minRun=2 + 每步一卡被
 *   assistant 消息断开），所以上界**不能**靠放宽折叠阈值实现——那会跨非卡节点
 *   吞掉助手消息（card-fold.mjs 红线）；
 * - G3：MIN_OPERATION_CHARS=1200 对 span 同样生效，短卡永远进不了候选，
 *   所以净占用按**字符**算，不按条数算。
 *
 * 不变量：人类消息永不进候选（0.11.0 BUG-002 红线）；替换点只增不减、不重排
 * （前缀缓存）；成员 ID 必须可解析回读；最新一张工作卡永远保护。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'

import {
  CARD_NET_CHAR_CAP,
  cardOccupancyOf,
  planCardFolds,
  renderFoldReceipt,
} from '../src/v2/card-fold.mjs'
import { createV2Runtime } from '../src/v2/runtime.mjs'
import { createV2SessionState, writeV2SessionState } from '../src/v2/state.mjs'
import { buildSession, fakeMeter } from './helpers/fake-host.mjs'

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
  const root = await mkdtemp(path.join(tmpdir(), `mcl2ia-${name}-`))
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

function runtimeFor(labRoot) {
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
  return session.append('user/message', {
    id: 'card-' + Math.random().toString(36).slice(2, 8),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'memory-context-lab', form: 'working-set' },
  }, { surfaceOp: 'append' }).seq
}

function cardNode(seq, chars = 200) {
  return { seq, type: 'user/message', sourceForm: 'working-set', text: '卡'.repeat(chars) }
}

test('P0-4a 净占用按字符算（不是条数）：超过 8000 字符即判超上限，且字符来自真实文本长度', () => {
  // 0.13.2-beta.8：Q3-A 一进一出后双槽不变量构造性保证净占用有界（全量 ≤4.8k +
  // 增量 ≤1.6k + 回执），本上限降级为「双槽被破坏」的兜底告警线，4000 → 8000
  // （重校准依据见 card-fold.mjs 注释与修复计划-beta.8）。
  assert.equal(CARD_NET_CHAR_CAP, 8000)
  const nodes = [cardNode(2, 4000), cardNode(3, 3000), cardNode(4, 2000)]
  const occupancy = cardOccupancyOf(nodes)
  assert.equal(occupancy.count, 3)
  assert.equal(occupancy.chars, 9000)
  assert.equal(occupancy.overCap, true)
  assert.equal(occupancy.newestWorkingStateSeq, 4)
  // 短卡也要计入：3 张 300 字的卡只有 900 字符，不该判超限（G3 的反面）。
  assert.equal(cardOccupancyOf([cardNode(5, 300), cardNode(6, 300), cardNode(7, 300)]).overCap, false)
})

test('P0-4b 超上限时折叠**同一段连续卡组**（哪怕只有 2 张），不靠放宽 minRun', () => {
  const nodes = [cardNode(2, 2500), cardNode(3, 2500)]
  const { plans } = planCardFolds(nodes, { minRun: 2 })
  assert.equal(plans.length, 1, '两张卡也能折：触发时机由净占用决定，卡组边界不变')
  assert.deepEqual(plans[0].memberSeqs, [2, 3])
})

test('P0-4c 最新一张工作卡永远保护：不进成员列表，并作为断组边界', () => {
  const nodes = [cardNode(2, 900), cardNode(3, 900), cardNode(4, 900)]
  const occupancy = cardOccupancyOf(nodes)
  const { plans } = planCardFolds(nodes, { minRun: 2, protectSeqs: [occupancy.newestWorkingStateSeq] })
  assert.equal(plans.length, 1)
  assert.deepEqual(plans[0].memberSeqs, [2, 3])
  assert.equal(plans[0].memberSeqs.includes(4), false, '最新工作卡不得被折叠')
})

test('P0-4d 折叠回执保留全部成员 ID（替换不是删除）', () => {
  const text = renderFoldReceipt({ startSeq: 2, endSeq: 5, memberSeqs: [2, 3, 4, 5], forms: ['working-set', 'working-set', 'working-set', 'working-set'], chars: 800, tokens: 200 })
  for (const seq of [2, 3, 4, 5]) assert.ok(text.includes('seq:' + seq), '回执必须点名成员 seq ' + seq)
  assert.match(text, /^成员：seq:2、seq:3、seq:4、seq:5$/m)
})

test('P0-4e 人类消息 0 选中：连续卡组里的真实人类消息永远不进替换区间', () => {
  const human = (seq) => ({ seq, type: 'user/message', sourceForm: null, text: '这是用户手打的请求' })
  const nodes = [cardNode(2), cardNode(3), human(4), cardNode(5), cardNode(6)]
  const { plans } = planCardFolds(nodes, { minRun: 2 })
  const members = plans.flatMap((plan) => plan.memberSeqs)
  assert.equal(members.includes(4), false, '人类消息不得进入折叠区间')
  assert.deepEqual(plans.map((plan) => plan.memberSeqs), [[2, 3], [5, 6]])
})

test('P0-4f 端到端：多轮注卡后折叠，替换点只增不减、成员 ID 可解析，非卡节点一个不动', async () => {
  await withTempLab('f', async (labRoot) => {
    const sessionId = 'session-p04f'
    await seedEnabled(labRoot, sessionId)
    const runtime = runtimeFor(labRoot)
    try {
      const session = buildSession({ operations: 1, id: sessionId })
      const agent = agentFor(session)
      await runtime.adopt(agent)
      const nonCardBefore = session.surface.nodes.filter((seq) => {
        const event = session.eventAt(seq)
        return event?.type !== 'user/message' || (event?.data?.source?.form ?? null) === null
      })
      const replacementSeqs = []
      for (let round = 0; round < 4; round += 1) {
        injectCard(session, '[工作状态·v2] 轮' + round + ' A')
        injectCard(session, '[工作状态·v2] 轮' + round + ' B')
        const outcome = await runtime.foldWorkingCards(agent)
        for (const receipt of outcome.receipts) replacementSeqs.push(receipt.seq)
        assert.ok(outcome.occupancy, '折叠结果必须带净占用读数')
      }
      assert.ok(replacementSeqs.length > 0, '至少发生一次折叠')
      // 替换点只增不减（新 replace 事件的 seq 一定大于已存在的替换点）。
      for (let index = 1; index < replacementSeqs.length; index += 1) {
        assert.ok(replacementSeqs[index] > replacementSeqs[index - 1], '替换点必须单调递增')
      }
      // 非卡节点一个不动（人类/助手/工具结果）。
      const nonCardAfter = session.surface.nodes.filter((seq) => {
        const event = session.eventAt(seq)
        return event?.type !== 'user/message' || (event?.data?.source?.form ?? null) === null
      })
      for (const seq of nonCardBefore) assert.ok(nonCardAfter.includes(seq), '非卡节点必须原样保留：seq ' + seq)
      // 折叠回执必须点名成员 seq，且这些 seq 已不在活动面上。
      const foldNodes = session.surface.nodes.filter((seq) => {
        const first = session.eventAt(seq)?.data?.content?.[0]
        return typeof first?.text === 'string' && first.text.startsWith('[已折叠工作卡')
      })
      assert.ok(foldNodes.length > 0)
      const foldText = session.eventAt(foldNodes.at(-1)).data.content[0].text
      assert.match(foldText, /^成员：seq:\d+/m)
    } finally {
      await runtime.shutdown()
    }
  })
})
