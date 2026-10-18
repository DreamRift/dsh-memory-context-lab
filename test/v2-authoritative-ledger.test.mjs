/**
 * 回归：权威状态记录不得把「账本没有的开关位」按默认 false 落账（0.12.0 补丁）。
 *
 * 现场（2026-10-18 新会话实测，session-e57de9c9 / session-fa40b380）：
 * 新会话里先手动开「全历史记忆上下文」、再点「启用降温」，
 * `/memory-lab2 set fullhistory on` 的 command/done 明明写着「已设为 开」，
 * 紧跟其后的 `plugin:dsh-memory-context-lab/state` 却是 `fullHistory:false`、
 * `planFirst:false`、`retainOperations:0`——面板开关闪一下又回到关。
 *
 * 两个原因，各一条断言：
 * 1. `recordAuthoritativeState` 只读 v1 的 `records`，v2 会话永远读到空账本；
 * 2. `stateRecordDataOf` 把账本缺席的位按默认值补齐（v2 账本没有 planFirst、
 *    v1 账本没有 fullHistory），于是每写一条记录就压回关。
 *
 * 走插件真实入口（apply → 命令 → 投影），不是复述实现。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { apply as applyPlugin } from '../src/index.mjs'
import { stateRecordDataOf, STATE_RECORD_TYPE, __setHostSessionModuleForTest } from '../src/authoritative-state.mjs'
import { readV2SessionState } from '../src/v2/state.mjs'
import { FakeSession, fakeMeter } from './helpers/fake-host.mjs'

/** 宿主 appendPluginRecord 的替身：与真实宿主同形状（ignorable 事件）。 */
function fakeAppendPluginRecord(session, type, data) {
  const seq = session.events.length
  session.events.push({ type, seq, time: seq, data: JSON.parse(JSON.stringify(data)), ignorable: true })
  return seq
}

function fakePluginRecordOf(event) {
  if (event?.ignorable !== true) return undefined
  return { type: event.type, seq: event.seq, time: event.time, data: event.data }
}

/** 最小 Cordis 形状的 context：只提供插件实际用到的服务。 */
function createStubContext() {
  const commands = []
  const projections = []
  const tools = []
  const cleanups = []
  const warnings = []
  const context = {
    logger: {
      info() {},
      warn(message) { warnings.push(String(message)) },
      error() {},
    },
    get(name) {
      if (name === 'tokenMeter') return fakeMeter
      if (name === 'llm') return { resolveModelInfo: async () => ({ context: { contextWindow: 100000 }, defaultMaxTokens: 4096 }) }
      return undefined
    },
    on() { return () => {} },
    effect(fn) {
      const result = fn()
      if (result && typeof result.next === 'function') {
        let step = result.next()
        while (!step.done) {
          cleanups.push(step.value)
          step = result.next()
        }
      } else if (typeof result === 'function') {
        cleanups.push(result)
      }
      return () => {}
    },
    commands: { register(definition) { commands.push(definition); return () => {} } },
    sessionProjections: { register(definition) { projections.push(definition); return () => {} } },
    tools: { register(definition) { tools.push(definition); return () => {} } },
    inject(deps, callback) {
      if (deps.every((dep) => context[dep] !== undefined)) callback(context)
      return { dispose() {} }
    },
    async _dispose() {
      for (const cleanup of cleanups.splice(0).reverse()) {
        try { await cleanup?.() } catch { /* 收尾尽力而为 */ }
      }
    },
    _commands: commands,
    _projections: projections,
    _warnings: warnings,
  }
  return context
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

async function withTempLab(name, body) {
  const root = await mkdtemp(path.join(tmpdir(), `mcl-${name}-`))
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

function runCommand(ctx, name, agent, rawInput) {
  const definition = ctx._commands.find((command) => command.name === name)
  assert.ok(definition, `${name} 必须已注册`)
  return definition.handler(invocationFor(agent, rawInput))
}

function stateRecordsOf(session) {
  return session.events.filter((event) => event.type === STATE_RECORD_TYPE)
}

/** 用注册的投影重放整段事件，得到面板看到的视图。 */
function viewAfterReplay(ctx, session) {
  const projection = ctx._projections[0]
  let state = projection.init()
  for (const event of session.events) state = projection.apply(state, event)
  return projection.wire.view(state)
}

test('v2 会话的权威状态记录取 v2 账本，且不把账本没有的开关位按默认 false 落账', async () => {
  await withTempLab('auth-v2', async (labRoot) => {
    __setHostSessionModuleForTest({ appendPluginRecord: fakeAppendPluginRecord, pluginRecordOf: fakePluginRecordOf })
    const ctx = createStubContext()
    // 设置页默认「计划先行」为开：新会话的折叠位从它播种。
    await applyPlugin(ctx, { defaults: { planFirst: true } })

    const session = new FakeSession({ id: 'session-auth-v2' })
    const agent = agentFor(session)

    const enabled = await runCommand(ctx, 'memory-lab2', agent, ' on')
    assert.equal(enabled.kind, 'success', enabled.text)

    const fullHistory = await runCommand(ctx, 'memory-lab2', agent, ' set fullhistory on')
    assert.equal(fullHistory.kind, 'success', fullHistory.text)

    const afterFullHistory = stateRecordsOf(session).at(-1)
    assert.equal(afterFullHistory.data.fullHistory, true, 'v2 账本里 fullHistory 已开，权威记录必须写开，实际 ' + JSON.stringify(afterFullHistory.data))
    assert.equal(afterFullHistory.data.retainOperations, 5, '保留数必须取 v2 账本（5），不是空账本默认值 0，实际 ' + JSON.stringify(afterFullHistory.data))
    assert.equal(afterFullHistory.data.engine, 'v2')

    // v2 账本此刻还没有 planFirst：权威记录不表态，投影保留折叠值（播种的 true）。
    assert.equal('planFirst' in afterFullHistory.data, false, '账本没有的开关位不得被写成 false，实际 ' + JSON.stringify(afterFullHistory.data))

    // 面板此刻：全历史开、计划先行开——这正是现场闪烁后丢掉的两格。
    const view = viewAfterReplay(ctx, session)
    assert.equal(view.enabled, true)
    assert.equal(view.engine, 'v2')
    assert.equal(view.fullHistory, true, '全历史开关不得被权威记录压回关')
    assert.equal(view.planFirst, true, '计划先行开关不得被权威记录压回关')
    assert.equal(view.retainOperations, 5, '保留数不得被压回 0')

    await ctx._dispose()
    void labRoot
  })
})

test('v2 会话里 /memory-lab set planfirst 落到 v2 账本，不再误报「尚未启用降温」', async () => {
  await withTempLab('auth-planfirst', async (labRoot) => {
    __setHostSessionModuleForTest({ appendPluginRecord: fakeAppendPluginRecord, pluginRecordOf: fakePluginRecordOf })
    const ctx = createStubContext()
    await applyPlugin(ctx, { defaults: { planFirst: false } })

    const session = new FakeSession({ id: 'session-auth-planfirst' })
    const agent = agentFor(session)
    await runCommand(ctx, 'memory-lab2', agent, ' on')

    const result = await runCommand(ctx, 'memory-lab', agent, ' set planfirst on')
    assert.equal(result.kind, 'success', result.text)
    assert.equal(result.text.includes('本会话尚未启用降温'), false, 'v2 会话已启用，不得误报未启用：' + result.text)

    const stored = await readV2SessionState(labRoot, session.id)
    assert.equal(stored?.state.planFirst, true, 'v2 账本必须记住计划先行开关位')

    const last = stateRecordsOf(session).at(-1)
    assert.equal(last.data.planFirst, true, '权威记录必须跟随 v2 账本写开，实际 ' + JSON.stringify(last.data))

    const view = viewAfterReplay(ctx, session)
    assert.equal(view.planFirst, true, '重放后计划先行仍为开')

    await ctx._dispose()
  })
})

test('stateRecordDataOf：只表态账本真的持有的字段（v1 账本不写 v2 专属位）', () => {
  const v1 = stateRecordDataOf({
    enabled: true,
    engine: 'v1',
    state: { enabled: true, settings: { retainOperations: 5, archiveBatchSize: 10, auto: true, autoRecall: true, autoRestore: true } },
  })
  // v2 专属位：v1 持有时确定是关（v1 没有这些模式），必须写出来。
  assert.equal(v1.fullHistory, false, 'v1 持有投影时全历史确定为关')
  assert.equal(v1.hierarchyCompress, false)
  // 插件级开关：v1 账本没记就不表态，交给日志折叠。
  assert.equal(v1.planFirst, undefined, '账本没记的插件级开关不得被写成 false')
  assert.equal(v1.retainOperations, 5)
  assert.equal(v1.enabled, true)
  assert.equal(v1.engine, 'v1')

  const v2 = stateRecordDataOf({
    enabled: true,
    engine: 'v2',
    state: {
      enabled: true,
      fullHistory: true,
      shareL2Content: true,
      settings: { retainOperations: 0, archiveBatchSize: 10, auto: true, autoRecall: true, autoRestore: true },
    },
  })
  assert.equal(v2.fullHistory, true)
  assert.equal(v2.shareL2Content, true, 'shareL2Content 必须在权威字段表里')
  assert.equal(v2.planFirst, undefined)

  const none = stateRecordDataOf({ enabled: false, engine: '' })
  assert.equal(none.enabled, false)
  assert.equal(none.engine, '')
  assert.equal(none.fullHistory, false, '没有任何引擎时全历史确定为关')
  assert.equal('planFirst' in none, false, '没有任何账本时不表态计划先行')
})

test('完整往返：默认计划先行关 → 会话内开/关两个开关都跟随面板，且再点「启用降温」不回退', async () => {
  await withTempLab('auth-roundtrip', async (labRoot) => {
    __setHostSessionModuleForTest({ appendPluginRecord: fakeAppendPluginRecord, pluginRecordOf: fakePluginRecordOf })
    const ctx = createStubContext()
    // 现场第二轮复现的配置：设置页默认「计划先行」是关的。
    await applyPlugin(ctx, { defaults: { planFirst: false } })

    const session = new FakeSession({ id: 'session-auth-roundtrip' })
    const agent = agentFor(session)
    await runCommand(ctx, 'memory-lab2', agent, ' on')

    const viewNow = () => viewAfterReplay(ctx, session)
    assert.equal(viewNow().planFirst, false, '默认关时新会话应为关')

    // 1) 会话内开计划先行：命令成功、账本记住、面板显示开（现场是「标出现但开关还是关」）。
    const on = await runCommand(ctx, 'memory-lab', agent, ' set planfirst on')
    assert.equal(on.kind, 'success', on.text)
    assert.equal(viewNow().planFirst, true, '开之后面板必须显示开：' + JSON.stringify(stateRecordsOf(session).at(-1)?.data))

    // 2) 再关：必须能关掉（现场是「关不了」）。
    const off = await runCommand(ctx, 'memory-lab', agent, ' set planfirst off')
    assert.equal(off.kind, 'success', off.text)
    assert.equal(viewNow().planFirst, false, '关之后面板必须显示关')
    assert.equal((await readV2SessionState(labRoot, session.id))?.state.planFirst, false, 'v2 账本必须记住关')

    // 3) 全历史：开 → 关，两次都要落到面板与账本。
    await runCommand(ctx, 'memory-lab2', agent, ' set fullhistory on')
    assert.equal(viewNow().fullHistory, true, '全历史开之后面板必须显示开')
    assert.equal((await readV2SessionState(labRoot, session.id))?.state.fullHistory, true)

    // 4) 面板「启用降温」开关的真实路径：先 /memory-lab off（v2 转交停用），
    //    再 /memory-lab on（v1 接管）。停用清掉全历史位（B1 文档语义），但
    //    计划先行的折叠位不得被权威记录顺手压回关。
    await runCommand(ctx, 'memory-lab', agent, ' set planfirst on')
    assert.equal(viewNow().planFirst, true)

    const stop = await runCommand(ctx, 'memory-lab', agent, ' off')
    assert.equal(stop.kind, 'success', stop.text)
    const stopped = viewNow()
    assert.equal(stopped.enabled, false, '关掉启用降温后面板必须显示已停用')
    assert.equal(stopped.fullHistory, false, '停用后全历史位随引擎退出清掉（B1 语义）')
    assert.equal(stopped.planFirst, true, '停用不得把计划先行开关一起清掉')

    const start = await runCommand(ctx, 'memory-lab', agent, ' on')
    assert.equal(start.kind, 'success', start.text)
    const started = viewNow()
    assert.equal(started.enabled, true, '再打开后必须显示已启用')
    assert.equal(started.planFirst, true, '再打开启用降温不得把计划先行打回关')
    assert.equal(started.retainOperations, 5, '再打开后保留数必须来自账本，不是 0')

    // 5) 关全历史：面板路径（v1 持有 → 停 v1 → 启 v2 → set），面板与账本同步。
    await runCommand(ctx, 'memory-lab', agent, ' off')
    await runCommand(ctx, 'memory-lab2', agent, ' on')
    await runCommand(ctx, 'memory-lab2', agent, ' set fullhistory on')
    assert.equal(viewNow().fullHistory, true)
    await runCommand(ctx, 'memory-lab2', agent, ' set fullhistory off')
    assert.equal(viewNow().fullHistory, false, '全历史关之后面板必须显示关')
    assert.equal((await readV2SessionState(labRoot, session.id))?.state.fullHistory, false)

    await ctx._dispose()
  })
})
