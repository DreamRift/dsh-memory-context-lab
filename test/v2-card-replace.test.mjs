/**
 * Q3-A 一进一出·双槽守卫（0.13.2-beta.8）。
 *
 * 缺陷来源：修复计划-beta.8 §〇 Q3——折叠的「卡节点连续 ≥2」前提在真实注入序列里
 * 永不成立（实测 512 张卡 / 306,071 字符 = 上限 76.5 倍，0 张被折叠）。beta.8 换判据：
 * 注入即替换（一进一出），稳态面上恒为 [全量基准卡][最新增量卡] 两个卡节点。
 *
 * 断言组：
 *  R1 双槽不变量（端到端）：25 步「卡-正文-工具」交替注入后，面上工作卡节点 ≤2、
 *     占位回执 ≤1、卡节点总字符 ≤ CARD_NET_CHAR_CAP——**单测模拟真实交替序列**，
 *     上一批的教训正是「单测绿但真实序列不成立」。
 *  R2 全量刷新：旧全量槽位被替换为新全量内容、旧增量槽位转一行占位回执。
 *  R3 锚点：replace 路径 confirm 后 anchorSeq = 替换事件的新 seq，且仍在面上。
 *  R4 失败降级：宿主拒绝 replace 时回落 append，cardReplaceFallbacks 计数 ≥1，
 *     卡不丢（fallback 路径的卡仍出现在 decision.messages 等价物里）。
 *  R5 增量基准：连续两张增量卡之间，第二张不得重复宣告第一张已宣告的行
 *     （基准是「上一张全量卡」，不是「上一张注入卡」）。
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
import { CARD_NET_CHAR_CAP, isFullCardText } from '../src/v2/card-fold.mjs'

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
  const root = await mkdtemp(path.join(tmpdir(), `mcl2rp-${name}-`))
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

/** index.mjs disposeWorkingSet 的等价物：replace 直连提交、append 走 decision.messages。 */
async function stepCard(runtime, agent, sessionId, { breakReplace = false } = {}) {
  const prepared = await runtime.workingSetInjection(agent)
  if (!prepared) return null
  let details = {}
  let replaced = false
  let appendedText = null
  if (prepared.mode === 'replace') {
    const session = breakReplace ? { append: () => { throw new Error('host rejected replace') } } : agent.session
    const submitted = runtime.submitCardReplace({ session }, prepared)
    if (submitted.ok) {
      replaced = true
      details = { anchorSeq: submitted.anchorSeq, receiptOk: submitted.receiptOk }
    } else {
      details = { fallback: true }
    }
  }
  runtime.confirmInjection(sessionId, prepared.preparedId, details)
  if (!replaced) appendedText = prepared.text
  return { prepared, replaced, appendedText }
}

/** 面上工作卡节点视图（form=working-set 的 user/message）。 */
function cardNodesOf(session) {
  const out = []
  for (const seq of session.nodes) {
    const event = session.eventAt(seq)
    if (event?.type !== 'user/message') continue
    const form = event?.data?.source?.form ?? event?.source?.form
    if (form !== 'working-set') continue
    const text = (event.data?.content ?? []).find((block) => block?.type === 'text')?.text ?? ''
    out.push({ seq, text, full: isFullCardText(text) })
  }
  return out
}

function receiptNodesOf(session) {
  const out = []
  for (const seq of session.nodes) {
    const event = session.eventAt(seq)
    if (event?.type !== 'user/message') continue
    const form = event?.data?.source?.form ?? event?.source?.form
    if (form === 'memory-lab2-surface') out.push({ seq, text: (event.data?.content ?? []).find((b) => b?.type === 'text')?.text ?? '' })
  }
  return out
}

test('R1+R2+R3 双槽不变量端到端：25 步交替序列后卡节点 ≤2、全量刷新转回执、锚点=新 seq', async () => {
  await withTempLab('r1', async (labRoot) => {
    const sessionId = 'session-card-replace-r1'
    await seedEnabledWithReceipt(labRoot, sessionId)
    const runtime = runtimeWithMeter(labRoot)
    try {
      const session = buildSession({ operations: 1, id: sessionId })
      const agent = agentFor(session)
      let sawFullRefresh = false
      let anchorAfterReplace = null
      for (let step = 0; step < 25; step += 1) {
        if (step > 0) operation({ session, callId: `call-r1-${step}`, toolName: 'read', result: `第 ${step} 步的操作结果，内容各不相同 ${'-'.repeat(step)}` })
        const outcome = await stepCard(runtime, agent, sessionId)
        if (!outcome) continue
        // 每一步都要把 append 路径的卡真正放上面（decision.messages 的宿主等价物）。
        if (outcome.appendedText) {
          session.append('user/message', {
            id: `card-r1-${step}`,
            role: 'user',
            content: [{ type: 'text', text: outcome.appendedText }],
            source: { kind: 'memory-context-lab', form: 'working-set' },
          }, { surfaceOp: 'append' })
        }
        // 不变量在每一步之后都成立，不是只在终点成立。
        const cards = cardNodesOf(session)
        assert.ok(cards.length <= 2, `第 ${step} 步后工作卡节点 ${cards.length} > 2（双槽被破坏）`)
        assert.ok(receiptNodesOf(session).length <= 1, `第 ${step} 步后占位回执 > 1`)
        const chars = cards.reduce((sum, card) => sum + card.text.length, 0)
        assert.ok(chars <= CARD_NET_CHAR_CAP, `第 ${step} 步后卡净占用 ${chars} > ${CARD_NET_CHAR_CAP}`)
        assert.equal(cards.filter((card) => card.full).length <= 1, true, `第 ${step} 步后全量卡超过 1 张`)
        if (outcome.prepared.form === 'full' && step > 0) sawFullRefresh = true
        const record = runtime.records.get(sessionId)
        if (record?.workingSetCard?.anchorSeq != null) anchorAfterReplace = record.workingSetCard.anchorSeq
      }
      assert.ok(sawFullRefresh, '25 步内必须发生至少一次周期性全量刷新（20 步周期）')
      const cards = cardNodesOf(session)
      assert.equal(cards.length, 2, '稳态必须恰为 [全量基准卡][最新增量卡]')
      assert.equal(cards[0].full, true, '第一槽是全量卡')
      assert.equal(cards[1].full, false, '第二槽是增量卡')
      const receipts = receiptNodesOf(session)
      assert.equal(receipts.length, 1, '全量刷新必须把旧增量槽转成恰好一行占位回执')
      assert.match(receipts[0].text, /已被本会话最新一张全量卡取代/)
      // R3：锚点 = 替换事件的新 seq，且仍在面上。
      assert.ok(Number.isInteger(anchorAfterReplace))
      assert.ok(session.nodes.includes(anchorAfterReplace), '锚点必须仍在活动面上')
      // 替换确实发生了（节点数没有随步数增长）：初始 3 节点 + 每步 2 节点（助手+结果）
      // + 卡节点 append 3 次（首张全量、首张增量、全量刷新后的首张增量）= 上界 56。
      assert.ok(session.nodes.length <= 56, `面节点总数 ${session.nodes.length} 超过一进一出的上界 56`)
    } finally {
      await runtime.shutdown()
    }
  })
})

test('R4 失败降级：宿主拒绝 replace 时回落 append，fallback 计数可见，卡不丢', async () => {
  await withTempLab('r4', async (labRoot) => {
    const sessionId = 'session-card-replace-r4'
    await seedEnabledWithReceipt(labRoot, sessionId)
    const runtime = runtimeWithMeter(labRoot)
    try {
      const session = buildSession({ operations: 1, id: sessionId })
      const agent = agentFor(session)
      // 第一张：append（无槽位）。
      const first = await stepCard(runtime, agent, sessionId)
      assert.equal(first.replaced, false, '首次注入没有槽位，必须走 append')
      session.append('user/message', {
        id: 'card-r4-0', role: 'user', content: [{ type: 'text', text: first.appendedText }],
        source: { kind: 'memory-context-lab', form: 'working-set' },
      }, { surfaceOp: 'append' })
      // 第二张：有增量卡前无 delta 槽位 → 仍 append；先补一张 delta 才有槽位。
      operation({ session, callId: 'call-r4-a', toolName: 'read', result: '操作 A 的结果内容' })
      const second = await stepCard(runtime, agent, sessionId)
      assert.equal(second.prepared.form, 'delta')
      session.append('user/message', {
        id: 'card-r4-1', role: 'user', content: [{ type: 'text', text: second.appendedText }],
        source: { kind: 'memory-context-lab', form: 'working-set' },
      }, { surfaceOp: 'append' })
      // 第三张：现在有 delta 槽位 → replace；让宿主拒绝。
      operation({ session, callId: 'call-r4-b', toolName: 'read', result: '操作 B 的结果内容，与 A 不同' })
      const third = await stepCard(runtime, agent, sessionId, { breakReplace: true })
      assert.equal(third.prepared.mode, 'replace', '第三张必须命中增量槽位（否则夹具脱节）')
      assert.equal(third.replaced, false, '宿主拒绝后必须降级')
      assert.equal(typeof third.appendedText, 'string', '降级路径的卡文本必须仍在（卡不丢）')
      const record = runtime.records.get(sessionId)
      assert.ok((record.cost.snapshot?.().cardReplaceFallbacks ?? 0) >= 1,
        'cardReplaceFallbacks 必须被计数（一进一出失效可观测）')
      // 恢复性：fallback append 留下两个增量槽，下一步必须「替换最新 + 回执其余」，
      // 双槽在一步之内收敛（否则一进一出的失败会永久退化成三槽）。
      operation({ session, callId: 'call-r4-c', toolName: 'read', result: '操作 C 的结果内容，恢复双槽' })
      const fourth = await stepCard(runtime, agent, sessionId)
      assert.equal(fourth.prepared.mode, 'replace')
      assert.equal(fourth.replaced, true, '恢复步必须成功替换')
      assert.equal(cardNodesOf(session).length, 2, '恢复步之后双槽必须收敛回 2')
    } finally {
      await runtime.shutdown()
    }
  })
})

test('R5 增量基准：连续增量卡不得重复宣告上一张增量卡已宣告的行', async () => {
  await withTempLab('r5', async (labRoot) => {
    const sessionId = 'session-card-replace-r5'
    await seedEnabledWithReceipt(labRoot, sessionId)
    const runtime = runtimeWithMeter(labRoot)
    try {
      const session = buildSession({ operations: 1, id: sessionId })
      const agent = agentFor(session)
      const first = await stepCard(runtime, agent, sessionId)
      session.append('user/message', {
        id: 'card-r5-0', role: 'user', content: [{ type: 'text', text: first.appendedText }],
        source: { kind: 'memory-context-lab', form: 'working-set' },
      }, { surfaceOp: 'append' })
      operation({ session, callId: 'call-r5-a', toolName: 'read', result: '操作 A 的结果内容 甲甲甲' })
      const second = await stepCard(runtime, agent, sessionId)
      assert.equal(second.prepared.form, 'delta')
      const deltaOneText = second.appendedText ?? second.prepared.text
      session.append('user/message', {
        id: 'card-r5-1', role: 'user', content: [{ type: 'text', text: deltaOneText }],
        source: { kind: 'memory-context-lab', form: 'working-set' },
      }, { surfaceOp: 'append' })
      operation({ session, callId: 'call-r5-b', toolName: 'read', result: '操作 B 的结果内容 乙乙乙' })
      const third = await stepCard(runtime, agent, sessionId)
      assert.equal(third.prepared.form, 'delta', '第二张增量卡（夹具脱节则失败）')
      const deltaTwoText = third.appendedText ?? third.prepared.text
      // 基准若是「上一张增量卡」而非「上一张全量卡」，delta1 的行会在 delta2 里重复宣告。
      // 「已不再列出 N 行」是计数行、不是具体行的宣告，两卡可同形，不计入。
      const repeated = deltaOneText.split('\n')
        .filter((line) => line.startsWith('- ') && !line.startsWith('- 已不再列出') && deltaTwoText.includes(line))
      assert.deepEqual(repeated, [], `增量卡不得重复宣告上一张增量卡的行：${JSON.stringify(repeated.slice(0, 3))}`)
    } finally {
      await runtime.shutdown()
    }
  })
})
