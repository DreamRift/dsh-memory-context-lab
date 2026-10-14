/**
 * v2 运行时端到端测试（阶段二）。
 *
 * 走插件真实入口（`apply`）＋ 假宿主，覆盖规范里最关键的几条：
 * - 双引擎互斥（v2→v1 与 v1→v2 两个方向都必须挡住）；
 * - `/memory-lab2 on|off|status|read|history|working-set|import-v1` 的实际行为；
 * - 停用后与重开进程后，旧记录 ID 仍可回读原文（回执必须能兑现）；
 * - 门禁拦下未闭合配对、未曝光范围与辅助模型事件，放行已闭合的已曝光范围；
 * - v2 回执标记与 v1 不同，两套引擎的日志回执不互相冒充。
 *
 * 全程使用临时隔离根，不触碰真实灵枢、真实会话或已安装插件数据。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { apply as applyPlugin } from '../src/index.mjs'
import { buildSession, fakeMeter } from './helpers/fake-host.mjs'
import { createSessionState, writeSessionState } from '../src/storage.mjs'
import { V2SessionStore } from '../src/v2/store.mjs'
import { readV2SessionState, createV2SessionState, writeV2SessionState } from '../src/v2/state.mjs'
import { claimV2Engine, releaseV2Engine } from '../src/v2/engine.mjs'
import { createV2Runtime } from '../src/v2/runtime.mjs'
import { classifyRange, GUARD_CODES } from '../src/v2/guard.mjs'
import { V2_RECEIPT_MARKER, RECEIPT_MARKER } from '../src/core.mjs'
import { RECORD_KINDS, draftRecord } from '../src/v2/records.mjs'

const COMMAND = 'memory-lab2'

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
    await assert.rejects(() => run(ctx, agent, 'on'), (error) => error.code === 'EENGINEACTIVE')

    // v2 持有投影时，v1 的 on 必须被挡下（互斥的 v1 方向）。
    const v1Blocked = await command(ctx, 'memory-lab').handler(invocationFor(agent, 'on'))
    assert.equal(v1Blocked.kind, 'error')
    assert.match(v1Blocked.text, /v2|按需记忆化/)

    const status = await run(ctx, agent, 'status')
    assert.match(status.text, /v2 引擎：已启用/)
    assert.match(status.text, /v2 记录数：0/)
    await ctx._dispose()
  })
})

test('v2 运行时：v1 已启用时 v2 拒绝接管，且不留下半成品账本', async () => {
  await withTempLab('mutex', async (labRoot) => {
    // createSessionState 落盘的 enabled 就是 true：等价于 v1 正持有投影。
    await createSessionState(labRoot, 'session-v2-mutex-01', {})

    const ctx = await boot()
    const session = buildSession({ operations: 1, id: 'session-v2-mutex-01' })
    const agent = agentFor(session)
    await assert.rejects(
      () => run(ctx, agent, 'on'),
      (error) => error.code === 'EV1ACTIVE',
    )
    assert.equal(await readV2SessionState(labRoot, 'session-v2-mutex-01'), null, '被拒后不得留下 v2 账本')
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

test('v2 运行时：import-v1 复制成不可变副本、幂等、不改写 v1 数据', async () => {
  await withTempLab('import', async (labRoot) => {
    const sessionId = 'session-v2-import-01'
    const created = await createSessionState(labRoot, sessionId, {})
    created.state.archive.push({
      rangeStart: 3,
      rangeEnd: 4,
      callIds: ['call-1'],
      tools: ['read'],
      nodeId: 'archived_session_1',
      hash: 'b'.repeat(64),
      chars: 120,
      originalTokens: 300,
      replacementSeq: 9,
      chunkCount: 1,
      appliedAt: '2026-10-11T10:00:00.000Z',
      status: 'applied',
    })
    // v1 置为已停用，否则互斥会先挡住 v2 的 on（这正是上一条测试的语义）。
    created.state.enabled = false
    await writeSessionState(created.directory, created.state)
    const v1StateBefore = await readFile(path.join(created.directory, 'state.json'), 'utf8')

    const ctx = await boot()
    const session = buildSession({ operations: 1, id: sessionId })
    const agent = agentFor(session)
    await run(ctx, agent, 'on')

    const first = await run(ctx, agent, 'import-v1')
    assert.match(first.text, /扫描 1 条，导入 1 条/)
    const second = await run(ctx, agent, 'import-v1')
    assert.match(second.text, /扫描 1 条，导入 0 条，跳过 1 条/)

    // v1 账本只读：字节不变。
    const v1StateAfter = await readFile(path.join(created.directory, 'state.json'), 'utf8')
    assert.equal(v1StateAfter, v1StateBefore, '导入不得改写 v1 账本')

    // 导入记录带来源指针、synthesized 保真，且可按 ID 回读描述符。
    const listed = await run(ctx, agent, 'history 10')
    assert.match(listed.text, /projection\.span/)
    const importedId = listed.text.split('\n')[0].split(/\s+/)[0]
    const loaded = await run(ctx, agent, `read ${importedId}`)
    assert.ok(loaded.text.includes('archived_session_1'), '回读必须能取到来源指针')
    await ctx._dispose()
  })
})

test('v2 运行时：未启用会话里两个钩子都是纯 no-op，不触碰冷库', async () => {
  await withTempLab('hooks', async (labRoot) => {
    const ctx = await boot()
    const session = buildSession({ operations: 2, id: 'session-v2-hooks-01' })
    const agent = agentFor(session)
    const listeners = ctx._listeners.get('agent/pre-step')
    assert.equal(listeners.length, 6, 'v1/v2 各一个降温 + 一个回注，v2 一个工作状态注入，外加计划先行自动化钩子')

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
      assert.equal(card.hostTokens, null, 'meter 不可用时 hostTokens 如实为 null')

      const record = runtime.records.get(sessionId)
      assert.ok(record, '注入后 record 必须在册')
      const snapshot = record.cost.snapshot()
      assert.equal(snapshot.workingStateInjections, 1)
      assert.equal(snapshot.workingStateTokensUnmetered, 1, '缺口单独计数')
      assert.equal(snapshot.workingStateTokens, 0, '不得按卡片内部口径折算混记（D5 的病根就是两种口径进同一个计数器）')
    } finally {
      await runtime.shutdown()
    }
  })
})

test('D6：v2 持有投影时 v1 的 set 明确指路，不再谎报「on 后生效」', async () => {
  await withTempLab('d6set', async () => {
    const ctx = await boot()
    try {
      const session = buildSession({ operations: 1, id: 'session-v2-d6-01' })
      const agent = agentFor(session)
      const enabled = await run(ctx, agent, 'on')
      assert.equal(enabled.kind, 'success')

      // v2 持有投影时，v1 的 set batch 不得再走「已记下、/memory-lab on 后生效」
      // ——那个 on 会被 EV2ACTIVE 拒绝，设置永远不生效且毫无提示（实测 D6）。
      const rejected = await command(ctx, 'memory-lab').handler(invocationFor(agent, 'set batch 10'))
      assert.equal(rejected.kind, 'error', `应明确报错，实际 ${JSON.stringify(rejected.text)}`)
      assert.match(rejected.text, /v2 引擎（\/memory-lab2）持有投影/)
      assert.match(rejected.text, /\/memory-lab2 set batch/)

      // 防误杀：两引擎都不持有投影的会话里，v1 set 的「已记下」分支照常。
      const other = buildSession({ operations: 1, id: 'session-v2-d6-02' })
      const otherAgent = agentFor(other)
      const plain = await command(ctx, 'memory-lab').handler(invocationFor(otherAgent, 'set batch 10'))
      assert.equal(plain.kind, 'success')
      assert.match(plain.text, /已记下设置/)
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
    const bad = await run(first, agentA, 'set retain 0')
    assert.equal(bad.kind, 'error')
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
