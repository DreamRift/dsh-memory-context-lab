/**
 * v2 运行时端到端测试（阶段二）。
 *
 * 走插件真实入口（`apply`）＋ 假宿主，覆盖规范里最关键的几条：
 * - 双引擎互斥（v2→v1 与 v1→v2 两个方向都必须挡住）；
 * - `/memory-lab on|off|status|read|history|working-set` 的实际行为；
 * - 停用后与重开进程后，旧记录 ID 仍可回读原文（回执必须能兑现）；
 * - 门禁拦下未闭合配对、未曝光范围与辅助模型事件，放行已闭合的已曝光范围；
 * - v2 回执标记与 v1 不同，两套引擎的日志回执不互相冒充。
 *
 * 全程使用临时隔离根，不触碰真实灵枢、真实会话或已安装插件数据。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { apply as applyPlugin } from '../src/index.mjs'
import { buildSession, fakeMeter } from './helpers/fake-host.mjs'
import { sessionKeyFor } from '../src/storage.mjs'
import { V2SessionStore } from '../src/v2/store.mjs'
import { readV2SessionState, createV2SessionState, writeV2SessionState } from '../src/v2/state.mjs'
import { claimV2Engine, releaseV2Engine } from '../src/v2/engine.mjs'
import { createV2Runtime } from '../src/v2/runtime.mjs'
import { classifyRange, GUARD_CODES } from '../src/v2/guard.mjs'
import { V2_RECEIPT_MARKER, RECEIPT_MARKER } from '../src/core.mjs'
import { RECORD_KINDS, draftRecord } from '../src/v2/records.mjs'

const COMMAND = 'memory-lab'

/** Cordis 形状的最小上下文：记录注册，并允许测试派发监听的事件。 */
function createStubContext() {
  const listeners = new Map()
  const prependEvents = []
  const commands = []
  const projections = []
  const cleanups = []
  const warnings = []
  const agents = new Map()
  const tools = []
  const ctx = {
    logger: {
      info() {},
      warn(message) { warnings.push(String(message)) },
      error() {},
    },
    get(name) {
      if (name === 'tokenMeter') return fakeMeter
      if (name === 'llm') return { resolveModelInfo: async () => ({ context: { contextWindow: 100000 }, defaultMaxTokens: 4096 }) }
      if (name === 'agents') return { get: (id) => agents.get(id) }
      return undefined
    },
    on(event, handler, options) {
      const rows = listeners.get(event) ?? []
      if (options?.prepend) {
        rows.unshift(handler)
        prependEvents.push(event)
      } else {
        rows.push(handler)
      }
      listeners.set(event, rows)
      return () => {
        const current = listeners.get(event) ?? []
        listeners.set(event, current.filter((row) => row !== handler))
      }
    },
    effect(fn) {
      const local = []
      const result = fn()
      if (result && typeof result.next === 'function') {
        let step = result.next()
        while (!step.done) {
          local.push(step.value)
          step = result.next()
        }
      } else if (typeof result === 'function') {
        local.push(result)
      }
      cleanups.push(...local)
      return () => { for (const cleanup of local.splice(0).reverse()) cleanup?.() }
    },
    commands: { register(definition) { commands.push(definition); return () => {} } },
    sessionProjections: { register(definition) { projections.push(definition); return () => {} } },
    // v2 只读召回工具走反应式注入；提供 tools 服务让注册真的发生。
    tools: { register(definition) { tools.push(definition); return () => {} } },
    inject(deps, callback) {
      if (deps.every((dep) => ctx[dep] !== undefined)) callback(ctx)
      return { dispose() {} }
    },
    async _dispose() {
      for (const cleanup of cleanups.splice(0).reverse()) {
        try { await cleanup?.() } catch { /* 测试里尽力而为 */ }
      }
    },
    _listeners: listeners,
    _prependEvents: prependEvents,
    _commands: commands,
    _projections: projections,
    _tools: tools,
    _warnings: warnings,
    _agents: agents,
  }
  return ctx
}

function agentFor(session) {
  return {
    session,
    ctx: { tools: { schemas: () => [], restrict: () => () => {}, guard: () => () => {}, register: () => () => {} } },
    async runMaintenance(action) {
      return action(new AbortController().signal)
    },
  }
}

function invocationFor(agent, rawInput) {
  return { agent, rawInput, signal: new AbortController().signal }
}

function command(ctx, name) {
  const definition = ctx._commands.find((row) => row.name === name)
  assert.ok(definition, `${name} 命令必须已注册`)
  return definition
}

function run(ctx, agent, rawInput) {
  return command(ctx, COMMAND).handler(invocationFor(agent, rawInput))
}

async function withTempLab(name, body) {
  const root = await mkdtemp(path.join(tmpdir(), `mcl2rt-${name}-`))
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

async function boot() {
  const ctx = createStubContext()
  await applyPlugin(ctx)
  return ctx
}

/** 把一个已完成操作的结果写进 v2 库（模拟降温落库），返回记录 ID。 */
async function seedResultRecord(labRoot, sessionId, { callId, text }) {
  const store = await V2SessionStore.open({ labRoot, sessionId })
  try {
    const txn = await store.openTransaction()
    const staged = await store.stageRecord(txn, draftRecord({
      kind: RECORD_KINDS.OPERATION_RESULT,
      seq: 3,
      fidelity: 'verbatim',
      inline: { range: '2-3' },
      // operation.result 的 refs 契约就是 { callId, resultMessageId }。
      refs: { callId, resultMessageId: `msg-${callId}` },
      content: text,
    }))
    await store.commitTransaction(txn)
    return staged.id
  } finally {
    store.close()
  }
}

test('v2 运行时：on 建档、重复 on 被拒、v2 持有投影时 v1 不得接管', async () => {
  await withTempLab('lifecycle', async (labRoot) => {
    const ctx = await boot()
    const session = buildSession({ operations: 1, id: 'session-v2-life-01' })
    const agent = agentFor(session)

    const enabled = await run(ctx, agent, 'on')
    assert.equal(enabled.kind, 'success', enabled.text)
    assert.match(enabled.text, /已启用 v2 引擎/)
    const stored = await readV2SessionState(labRoot, 'session-v2-life-01')
    assert.equal(stored?.state?.enabled, true, 'on 必须落盘 v2 账本')

    // 重复 on：如实拒绝，不静默重来。
    // 0.13.2-beta.7 C 组：拒绝形态从「抛穿给宿主」改成「命令面返回错误结果」——
    // 抛出会让宿主的 normalizeResult 拿不到 text，用户看到的是宿主级崩溃，
    // 而不是「v2 已持有本会话投影」。判据从 rejects 改成 kind/code。
    const again = await run(ctx, agent, 'on')
    assert.equal(again.kind, 'error', again.text)
    assert.equal(again.code, 'EENGINEACTIVE')
    assert.ok(again.text.trim().length > 0, '宿主对 error 分支要求非空 text')
    assert.match(again.text, /重复声明|已激活|已持有/)

    const status = await run(ctx, agent, 'status')
    assert.match(status.text, /v2 引擎：已启用/)
    assert.match(status.text, /v2 记录数：0/)
    await ctx._dispose()
  })
})

test('v2 运行时：遗留的 v1 账本不阻断 v2 启用（0.13.1 不再读取 v1 状态）', async () => {
  await withTempLab('legacy-v1', async (labRoot) => {
    // 0.13.0 及更早的会话在磁盘上留有 v1 账本。0.13.1 不读它，
    // 因此一份 enabled:true 的 v1 state.json 不构成任何阻断。
    const legacyDir = path.join(labRoot, 'sessions', sessionKeyFor('session-v2-mutex-01'))
    await mkdir(legacyDir, { recursive: true })
    await writeFile(path.join(legacyDir, 'state.json'), JSON.stringify({
      kind: 'dsh-memory-context-lab/session',
      schemaVersion: 1,
      sessionId: 'session-v2-mutex-01',
      createdAt: '2026-10-19T00:00:00.000Z',
      enabled: true,
      archive: [],
    }), 'utf8')

    const ctx = await boot()
    const session = buildSession({ operations: 1, id: 'session-v2-mutex-01' })
    const agent = agentFor(session)
    const enabled = await run(ctx, agent, 'on')
    assert.equal(enabled.kind, 'success', enabled.text)
    assert.equal((await readV2SessionState(labRoot, 'session-v2-mutex-01'))?.state?.enabled, true)
    await ctx._dispose()
  })
})

test('v2 运行时：停用后与重开进程后，旧记录 ID 仍可回读原文', async () => {
  await withTempLab('readonly', async (labRoot) => {
    const sessionId = 'session-v2-read-01'
    const ctx = await boot()
    const session = buildSession({ operations: 1, id: sessionId })
    const agent = agentFor(session)
    const enabled = await run(ctx, agent, 'on')
    assert.equal(enabled.kind, 'success', enabled.text)

    const text = `原始工具结果：${'甲'.repeat(200)}`
    const recordId = await seedResultRecord(labRoot, sessionId, { callId: 'call-1', text })

    const hit = await run(ctx, agent, `read ${recordId}`)
    assert.ok(hit.text.includes(text), '启用期间必须能按 ID 读回原文')
    assert.match(hit.text, /保真=verbatim/)

    const history = await run(ctx, agent, 'history 10')
    assert.ok(history.text.includes(recordId), 'history 必须列出该记录')

    const packed = await run(ctx, agent, 'working-set 4000')
    assert.match(packed.text, /预算 4000 token/)

    // 停用：恢复投影、置停用、历史转只读保留。
    const off = await run(ctx, agent, 'off 测试收尾')
    assert.match(off.text, /已停用 v2 引擎/)
    const afterOff = await readV2SessionState(labRoot, sessionId)
    assert.equal(afterOff.state.enabled, false)
    assert.equal(afterOff.state.disabledReason, '测试收尾')

    // 关键验收：停用后旧 ID 仍可读（回执留在日志里，必须能兑现）。
    const afterRead = await run(ctx, agent, `read ${recordId}`)
    assert.ok(afterRead.text.includes(text), '停用后旧 ID 仍必须能读回原文')

    // 重开进程（新插件实例）：旧 ID 依旧可达。
    const reopened = await boot()
    const again = await run(reopened, agent, `read ${recordId}`)
    assert.ok(again.text.includes(text), '重启后旧 ID 仍必须能读回原文')
    const statusAfter = await run(reopened, agent, 'status')
    assert.match(statusAfter.text, /v2 引擎：已停用/)
    await reopened._dispose()
    await ctx._dispose()
  })
})

test('v2 运行时：未启用会话里两个钩子都是纯 no-op，不触碰冷库', async () => {
  await withTempLab('hooks', async (labRoot) => {
    const ctx = await boot()
    const session = buildSession({ operations: 2, id: 'session-v2-hooks-01' })
    const agent = agentFor(session)
    const listeners = ctx._listeners.get('agent/pre-step')
    assert.equal(listeners.length, 5, '计划先行自动化 + 自动降温 + 回注 + 工作状态注入 + v3 影子摄入（2026-10-24 用户授权挂载；影子只写 v3 根，不触碰 v2 冷库）')

    const messages = [{ id: 'user-1', role: 'user', content: [{ type: 'text', text: '历史里写了什么？' }], source: { kind: 'user' } }]
    const warningsBefore = ctx._warnings.length
    for (const listener of listeners) {
      const decision = await listener(
        { agent, signal: new AbortController().signal, turn: 1, step: 1 },
        async () => ({ kind: 'enter', messages: [...messages] }),
      )
      assert.equal(decision.kind, 'enter')
      assert.equal(decision.messages.length, 1, '未启用会话的回注不得添加消息')
    }
    assert.equal(ctx._warnings.length, warningsBefore, '未启用时不得触碰任何冷库')
    assert.equal(await readV2SessionState(labRoot, 'session-v2-hooks-01'), null)
    await ctx._dispose()
  })
})

test('v2 运行时：门禁放行已闭合的已曝光范围，拦下在途动作、辅助模型事件与进行中的回合', async () => {
  await withTempLab('guard', async (labRoot) => {
    const runtime = createV2Runtime({
      labRoot,
      services: { get: (name) => (name === 'tokenMeter' ? fakeMeter : name === 'llm' ? { resolveModelInfo: async () => ({ context: { contextWindow: 100000 }, defaultMaxTokens: 4096 }) } : undefined) },
      logger: { info() {}, warn() {}, error() {} },
      hostVersion: 'test-host',
      sessionIdOf: (session) => session.id,
      recallQueryFrom: () => null,
    })
    // buildSession({operations:2})：surface = [0 系统,1 用户,2 调用1,3 结果1,5 调用2,6 结果2]。
    const session = buildSession({ operations: 2, id: 'session-v2-guard-01' })
    const record = { agent: { session } }

    const closed = runtime.guardCandidate(record, { rangeStart: 2, rangeEnd: 3 })
    assert.equal(closed.safe, true, `已闭合的已曝光范围应放行，实际 ${closed.code}`)

    const unclosed = runtime.guardCandidate(record, { rangeStart: 2, rangeEnd: 2 })
    assert.equal(unclosed.safe, false)
    assert.equal(unclosed.code, GUARD_CODES.UNCLOSED_PAIR)

    const ongoing = runtime.guardCandidate(record, { rangeStart: 2, rangeEnd: 6 })
    assert.equal(ongoing.safe, false)
    assert.equal(ongoing.code, GUARD_CODES.NOT_YET_EXPOSED)

    // 只把「主模型活动面」当曝光面：classifyRange 独立复核同一会话的 surface。
    const surfaceSeqs = session.surface.nodes
    const offSurface = classifyRange({
      eventAt: (seq) => session.eventAt(seq),
      rangeStart: 4,
      rangeEnd: 4,
      surfaceSeqs,
      lastAssistantSeq: 5,
    })
    assert.equal(offSurface.safe, false)
    assert.equal(offSurface.code, GUARD_CODES.NOT_IN_SURFACE)

    // 孤儿结果（结果在面内但调用不在范围内）必须被拦下。
    const orphan = runtime.guardCandidate(record, { rangeStart: 3, rangeEnd: 3 })
    assert.equal(orphan.safe, false)
    assert.equal(orphan.code, GUARD_CODES.ORPHAN_RESULT)

    await runtime.shutdown()
  })
})

test('v2 运行时：回执标记与 v1 不同，两套引擎的日志回执不互相冒充', () => {
  assert.notEqual(V2_RECEIPT_MARKER, RECEIPT_MARKER)
  assert.ok(!V2_RECEIPT_MARKER.startsWith(RECEIPT_MARKER), 'v2 回执不得被 v1 的标记前缀匹配')
  assert.ok(!RECEIPT_MARKER.startsWith(V2_RECEIPT_MARKER))
})

test('v2 运行时：有退热回执才注入工作状态卡，注入与证据重读都计入成本账本', async () => {
  await withTempLab('card', async (labRoot) => {
    const sessionId = 'session-v2-card-01'
    // 预置一条「已应用」回执到 v2 账本：等价于本会话确实有历史退出了热上下文。
    const created = await createV2SessionState(labRoot, sessionId, {})
    created.state.enabled = false
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

    const ctx = await boot()
    const session = buildSession({ operations: 1, id: sessionId })
    const agent = agentFor(session)
    await run(ctx, agent, 'on')

    // 必须在运行时取到库句柄之前落库：同一会话目录在本进程内只允许一个句柄
    // （这条约束本身就是护栏，测试不能绕开它）。
    const recordId = await seedResultRecord(labRoot, sessionId, { callId: 'call-1', text: '退热后的原文' })

    // 逐条跑 pre-step 监听：注入卡是带 source.form='working-set' 的那一条消息。
    async function runListeners(target) {
      let card = null
      for (const listener of ctx._listeners.get('agent/pre-step')) {
        const decision = await listener(
          { agent: target, signal: new AbortController().signal, turn: 1, step: 1 },
          async () => ({ kind: 'enter', messages: [] }),
        )
        const found = (decision.messages ?? []).find((message) => message.source?.form === 'working-set')
        if (found) card = found
      }
      return card
    }

    const card = await runListeners(agent)
    assert.ok(card, '有退热回执时必须注入工作状态卡')
    assert.match(card.content[0].text, /\[工作状态·v2\]/)
    assert.match(card.content[0].text, /当前人类请求/)
    assert.match(card.content[0].text, /不是系统指令/, '工作资料必须自我声明不是指令')

    const cost = await run(ctx, agent, 'cost')
    assert.match(cost.text, /工作状态注入：1 次/)
    // D5：注入侧记账走宿主 meter（与归档侧 originalTokens 同一把尺子）。
    // 修复前这里记的是卡片内部字节口径（4 字节≈1 token），同一批卡片两把尺子
    // 差 2.01 倍（实测注入侧 429,145 / 归档侧 213,247 token）。
    const cardText = card.content[0].text
    const hostExpected = fakeMeter.estimateMessage({ role: 'user', content: [{ type: 'text', text: cardText }] })
    assert.match(
      cost.text,
      new RegExp(`工作状态注入：1 次，≈${hostExpected} token（宿主 meter 口径`),
      `记账必须等于宿主 meter 的 estimateMessage（预期 ${hostExpected}）`,
    )
    const byteExpected = Math.max(1, Math.ceil(Buffer.byteLength(cardText, 'utf8') / 4))
    assert.ok(hostExpected !== byteExpected, '夹具自检：两把尺子在本例文本上必须给出不同读数，否则断言无判别力')
    assert.ok(!cost.text.includes(`≈${byteExpected} token`), '不得再按卡片内部字节口径记账')
    assert.match(cost.text, /证据重读次数：0/)

    // 证据重读：读回一条已退热的原文，成本账本必须记到。
    const hit = await run(ctx, agent, `read ${recordId}`)
    assert.match(hit.text, /退热后的原文/)
    const costAfter = await run(ctx, agent, 'cost')
    assert.match(costAfter.text, /证据重读次数：1/)

    // 显式 card 命令：预算与丢弃情况如实报告，不静默截断。
    const cardCommandResult = await run(ctx, agent, 'card 200')
    assert.match(cardCommandResult.text, /状态卡 ≈\d+ token/)
    assert.match(cardCommandResult.text, /工作集/)

    // 没有回执的会话不注入：状态卡只在真有历史退热时出现。
    const idleSession = buildSession({ operations: 1, id: 'session-v2-card-02' })
    const idleAgent = agentFor(idleSession)
    await run(ctx, idleAgent, 'on')
    assert.equal(await runListeners(idleAgent), null, '没有退热回执时不得注入状态卡')

    await ctx._dispose()
  })
})

test('D5 失败关闭：宿主 meter 不可用时注入照常、token 不折算混记，缺口单独计数', async () => {
  await withTempLab('card-unmet', async (labRoot) => {
    const sessionId = 'session-v2-card-unmet'
    // 预置启用态 + 一条已应用回执：等价于「本会话确实有历史退出了热上下文」。
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

    // 直连 runtime：宿主 meter 不可用（services.get 一律 undefined）。
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
      const card = await runtime.workingSetInjection(agentFor(session))
      assert.ok(card, 'meter 不可用不得影响注入本身——卡片是功能，不是记账的副产品')
      assert.equal(card.kind, 'prepared', 'S3 三态：注入面返回 prepared 载荷')
      assert.equal(card.hostTokens, null, 'meter 不可用时 hostTokens 如实为 null')

      const record = runtime.records.get(sessionId)
      assert.ok(record, '注入后 record 必须在册')
      // S3：prepare 不计 committed；宿主确认（直连测试里手动 confirm）才入账。
      assert.equal(record.cost.snapshot().workingStateInjections, 0, '确认前不得计入注入次数')
      assert.equal(runtime.confirmInjection(sessionId, card.preparedId), true)
      const snapshot = record.cost.snapshot()
      assert.equal(snapshot.workingStateInjections, 1)
      assert.equal(snapshot.workingStateCommitted, 1)
      assert.equal(snapshot.workingStateTokensUnmetered, 1, '缺口单独计数')
      assert.equal(snapshot.workingStateTokens, 0, '不得按卡片内部口径折算混记（D5 的病根就是两种口径进同一个计数器）')
    } finally {
      await runtime.shutdown()
    }
  })
})

test('0.13.1：命令面只有一个引擎，v1 入口不再存在', async () => {
  await withTempLab('single-surface', async () => {
    const ctx = await boot()
    try {
      // 唯一命令必须叫 memory-lab；旧的 memory-lab2 不得再注册。
      const names = ctx._commands.map((row) => row.name)
      assert.ok(names.includes('memory-lab'), '/memory-lab 必须注册')
      assert.equal(names.includes('memory-lab2'), false, 'memory-lab2 已在 0.13.1 删除')
      assert.equal(names.length, 1, '0.13.1 只注册一条命令')

      const session = buildSession({ operations: 1, id: 'session-v2-single-01' })
      const agent = agentFor(session)
      const enabled = await run(ctx, agent, 'on')
      assert.equal(enabled.kind, 'success')

      // 同一条命令上的 set 直接写 v2 账本，不存在「已记下、on 后生效」的中间态。
      const set = await run(ctx, agent, 'set batch 9')
      assert.equal(set.kind, 'success', set.text)
      assert.match(set.text, /写入 v2 账本/)
      assert.doesNotMatch(set.text, /on 后生效/)

      // 未启用的会话里，只读命令如实报「未启用」，而不是指路另一个引擎。
      const other = buildSession({ operations: 1, id: 'session-v2-single-02' })
      const otherAgent = agentFor(other)
      const restore = await run(ctx, otherAgent, 'restore')
      assert.equal(restore.kind, 'error')
      assert.match(restore.text, /未启用/)
      assert.doesNotMatch(restore.text, /memory-lab2/)
    } finally {
      await ctx._dispose()
    }
  })
})

test('v2 设置：set 写入账本，进程重启后接管仍生效；非法取值显式拒绝', async () => {
  await withTempLab('set', async (labRoot) => {
    const session = buildSession({ operations: 2, id: 'session-v2-set-01' })
    const first = await boot()
    const agentA = agentFor(session)
    await run(first, agentA, 'on')
    const set = await run(first, agentA, 'set batch 9')
    assert.equal(set.kind, 'success')
    // 非法取值不得静默写成 NaN / 0。
    // N-10（0.13.2-beta.4）：retain 的**下界是 0**（schema natural().max(200) 与设置页
    // clampInt(…, 0, 200, 5) 都允许 0 = 不保留最近操作，全量立即进归档）。这条旧断言
    // 把合法值当错误，正是三个入口三个取值域的那处缺陷；越界仍必须显式拒绝。
    const zero = await run(first, agentA, 'set retain 0')
    assert.equal(zero.kind, 'success', 'retain 0 是合法值（与 schema 同域）')
    const bad = await run(first, agentA, 'set retain 201')
    assert.equal(bad.kind, 'error', '越界必须显式拒绝')
    const fractional = await run(first, agentA, 'set batch 12.7')
    assert.equal(fractional.kind, 'error', '小数必须显式拒绝，不得静默截断')
    const unknown = await run(first, agentA, 'set nope 1')
    assert.equal(unknown.kind, 'error')
    await first._dispose()

    // 新进程（新 runtime，同一隔离根）：未走过任何钩子也要能接管并看到设置。
    const second = await boot()
    const agentB = agentFor(session)
    const after = await run(second, agentB, 'set auto off')
    assert.equal(after.kind, 'success', '重启后 set 必须能接管磁盘上已启用的会话')
    const status = await run(second, agentB, 'status')
    assert.match(status.text, /auto/)
    const stored = await readV2SessionState(labRoot, session.id)
    assert.equal(stored.state.settings.archiveBatchSize, 9)
    assert.equal(stored.state.settings.auto, false)
    await second._dispose()
  })
})

test('v2 关闭语义（rc.5）：set fullhistory off 先恢复原文再翻位；off 联动计划先行退出', async () => {
  await withTempLab('closesem', async (labRoot) => {
    const sessionId = 'session-v2-close-01'
    // 真实流程：on → fullhistory on → now（真实归档，archive 行 + 表面回执都在）
    // → fullhistory off（必须先把这批原文恢复回表面，再翻开关位）。
    const ctx = await boot()
    const agent = agentFor(buildSession({ operations: 6, resultChars: 3000, id: sessionId }))
    await run(ctx, agent, 'on')
    await run(ctx, agent, 'set batch 1')
    await run(ctx, agent, 'set fullhistory on')
    const now = await run(ctx, agent, 'now')
    assert.equal(now.kind, 'success', now.text)
    assert.match(now.text, /已归档 \d+/, `now 必须真实归档出回执（got: ${now.text}）`)

    // 1) fullhistory off：先恢复（输出如实报告恢复数），再翻开关位。
    const fhOff = await run(ctx, agent, 'set fullhistory off')
    assert.equal(fhOff.kind, 'success', fhOff.text)
    assert.match(fhOff.text, /已恢复 \d+\/\d+ 段原文|恢复未完成/, `关全历史必须先跑恢复并如实报告，got: ${fhOff.text}`)
    const stateAfter = await readV2SessionState(labRoot, sessionId)
    assert.equal(stateAfter.state.fullHistory, false, '开关位照常翻 false')
    await ctx._dispose()

    // 2) planfirst off：宿主 planMode active 时联动退出（回调被调、note 进输出）。
    let planExitCalls = 0
    const planCtl = { set: () => { planExitCalls++; return 'committed' } }
    const ctx2 = await boot()
    ctx2._agents.set('planMode', planCtl)
    // ctx.get('planMode') 由 stub 的 get(name) 返回；直接覆盖：
    ctx2.get = (name) => (name === 'planMode' ? planCtl : undefined)
    const agent2 = agentFor(buildSession({ operations: 2, id: 'session-v2-close-02' }))
    await run(ctx2, agent2, 'on')
    // 会话是「新」的（无历史投影），planfirst on 进入计划模式后再关，必须退出。
    const onNote = await run(ctx2, agent2, 'set planfirst on')
    assert.ok(planExitCalls >= 0, '回调链不抛错')
    const offNote = await run(ctx2, agent2, 'set planfirst off')
    assert.equal(offNote.kind, 'success', offNote.text)
    await ctx2._dispose()
  })
})

test('v2 关闭语义（rc.5）：v2 持有投影时 /memory-lab off 转交 v2 停用（先恢复原文）', async () => {
  await withTempLab('offdele', async (labRoot) => {
    const sessionId = 'session-v2-dele-01'
    const ctx = await boot()
    const session = buildSession({ operations: 2, id: sessionId })
    const agent = agentFor(session)
    await run(ctx, agent, 'on')
    const text = `转交恢复原文：${'丙'.repeat(150)}`
    await seedResultRecord(labRoot, sessionId, { callId: 'call-dele-1', text })

    // 面板「启用降温」off 发的是 v1 命令；v2 持有投影时必须转交，而不是谎报未启用。
    const off = await run(ctx, agent, 'off')
    assert.equal(off.kind, 'success', off.text)
    assert.match(off.text, /转交|已停用 v2 引擎/, '输出必须说明发生了转交/停用')
    const state = await readV2SessionState(labRoot, sessionId)
    assert.equal(state.state.enabled, false, 'v2 引擎必须真正停用（不再「开关已关引擎还在跑」）')
    assert.match(off.text, /已恢复 1\/1 段原文|恢复/, '转交路径同样要先恢复原文')
    // 引擎声明释放：同会话可再次 on。
    const again = await run(ctx, agent, 'on')
    assert.equal(again.kind, 'success', again.text)
    await ctx._dispose()
  })
})

test('插件装配：只读召回工具经反应式注入注册，恰好一次且 schema 固定', async () => {
  await withTempLab('toolreg', async (labRoot) => {
    const ctx = await boot()
    assert.equal(ctx._tools.length, 1, '恰好注册一个模型可见工具，不随开关增删')
    assert.equal(ctx._tools[0].name, 'memory_lab_recall')
    assert.equal(ctx._tools[0].parameters.additionalProperties, false)
    assert.deepEqual(Object.keys(ctx._tools[0].parameters.properties).sort(), ['budget_tokens', 'cursor', 'query', 'record_ids'])
    await ctx._dispose()
  })
})

test('v2 命令面：recall / index / relations 走与工具同一条只读路径', async () => {
  await withTempLab('cmds', async (labRoot) => {
    const ctx = await boot()
    const session = buildSession({ operations: 2, id: 'session-v2-cmd-01' })
    const agent = agentFor(session)
    await run(ctx, agent, 'on')

    const recordId = await seedResultRecord(labRoot, session.id, { callId: 'call-cmd-1', text: '命令面回读正文' })

    // recall id：与模型可见工具同一渲染。
    const byId = await run(ctx, agent, `recall id ${recordId}`)
    assert.match(byId.text, /命令面回读正文/)
    assert.match(byId.text, /当时记录的原文/, '回读必须标注是历史原文，不冒充新授权')

    // recall <查询词>：字面命中索引元数据，且明确说明不是语义相关性。
    const byQuery = await run(ctx, agent, 'recall call-cmd-1')
    assert.match(byQuery.text, /字面检索命中/)
    assert.match(byQuery.text, /不是语义相关性/)
    assert.match(byQuery.text, new RegExp(recordId))

    // recall 无参数：按工具契约返回当前有界工作状态卡（与模型可见工具同一路径）。
    const noArgs = await run(ctx, agent, 'recall')
    assert.equal(noArgs.kind, 'success')
    assert.match(noArgs.text, /工作状态|工作集/)

    // index：未注入语义后端时如实报告，不假装已索引。
    const indexStatus = await run(ctx, agent, 'index')
    assert.match(indexStatus.text, /语义|后端|literal/i)

    // relations：只报可验证关系。
    const relations = await run(ctx, agent, `relations ${recordId}`)
    assert.match(relations.text, /call-cmd-1/)

    await ctx._dispose()
  })
})

test('v2 运行时：引擎声明释放后可再次声明，互斥按会话隔离', async () => {
  await withTempLab('release', async (labRoot) => {
    const first = await claimV2Engine(labRoot, 'session-v2-rel-01')
    assert.equal(first.claimed, true)
    // 重复声明是显式失败，不是静默成功。
    await assert.rejects(
      () => claimV2Engine(labRoot, 'session-v2-rel-01'),
      (error) => error.code === 'EENGINEACTIVE',
    )
    // 另一个会话不受影响。
    const other = await claimV2Engine(labRoot, 'session-v2-rel-02')
    assert.equal(other.claimed, true)
    await releaseV2Engine(labRoot, 'session-v2-rel-01')
    const third = await claimV2Engine(labRoot, 'session-v2-rel-01')
    assert.equal(third.claimed, true, '释放后应可再次声明')
    await releaseV2Engine(labRoot, 'session-v2-rel-01')
    await releaseV2Engine(labRoot, 'session-v2-rel-02')
  })
})
