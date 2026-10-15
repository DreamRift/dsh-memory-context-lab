/**
 * Integration tests for the two behaviors the rewrite exists to fix:
 * resume survival, and tail-only recall injection.
 *
 * Both are driven through the plugin's real entry point against a stub Cordis
 * context, so what is exercised is the actual registration, projection, and
 * lifecycle code rather than a paraphrase of it.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

import { apply as applyPlugin } from '../src/index.mjs'
import { applyEvent, initProjectionState, viewOf } from '../src/projection.mjs'
import { GLOBAL_PRESET_LABEL } from '../src/core.mjs'
import { buildSession, FakeColdStore, fakeMeter, operation } from './helpers/fake-host.mjs'
import { createSessionState, readSessionState, sessionKeyFor, writeSessionState } from '../src/storage.mjs'
import { claimsOfRecord, makeOrdinalAllocator, nodeClaimOf } from '../src/apply-engine.mjs'
import { locatePinnedDshMemory } from '../src/dsh-memory-suppression.mjs'

const requireFromTest = createRequire(import.meta.url)

/**
 * B4：探测本机的 dsh-memory peer 是否可从 Node 解析路径命中。
 *
 * 几条「冷库不可用」用例过去依赖「peer 恰好不在场」这一环境巧合；按
 * release/README 装好 peer 的机器上 `apply` 内部的 locate 会成功，降级文案
 * 与失败关闭断言就红了。探测与产品同一条 locate（dshHome 用 harness 已设的
 * `$DSH_HOME` 临时根，Node 段与 `src/index.mjs` 的 createRequire 爬同一条
 * node_modules 链），据此把断言分成在场/不在场两轨。
 */
async function peerDshMemoryResolvable() {
  try {
    await locatePinnedDshMemory(requireFromTest)
    return true
  } catch {
    return false
  }
}

/**
 * A minimal Cordis-shaped context: it records the registrations the plugin
 * makes and lets the test dispatch the events the plugin listens for.
 */
function createStubContext({ labRoot, archivedIds }) {
  const listeners = new Map()
  const prependEvents = []
  const commands = []
  const projections = []
  const tools = []
  const cleanups = []
  const warnings = []
  /** Live agents by session id, as the host registry would expose them. */
  const agents = new Map()
  /** Absent unless a test supplies it: a host may not have it resolvable yet. */
  const registry = Array.isArray(archivedIds) ? { archivedSessionIds: archivedIds } : undefined
  const context = {
    logger: {
      info() {},
      warn(message) { warnings.push(String(message)) },
      error() {},
    },
    get(name) {
      if (name === 'tokenMeter') return fakeMeter
      if (name === 'llm') return { resolveModelInfo: async () => ({ context: { contextWindow: 100000 }, defaultMaxTokens: 4096 }) }
      // `workspace/session-stop` carries only a session id, so the archive path
      // resolves the live agent through this registry.
      if (name === 'agents') return { get: (id) => agents.get(id) }
      // Present only when a test asks for it, mirroring a host where the workspace
      // registry is already resolvable at plugin load.
      if (name === 'workspaceRegistry') return registry
      return undefined
    },
    // A waterfall event keeps every listener in registration order; `prepend`
    // decides whether this one runs before or after the others.
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
    // Cordis's `effect` accepts either a disposer-returning function or a
    // generator that yields disposers; the plugin uses both forms.
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
    commands: {
      register(definition) {
        commands.push(definition)
        return () => {}
      },
    },
    sessionProjections: {
      register(definition) {
        projections.push(definition)
        return () => {}
      },
    },
    // v2 的只读召回工具走反应式注入；这里提供 tools 服务让注册真的发生。
    tools: {
      register(definition) {
        tools.push(definition)
        return () => {}
      },
    },
    inject(deps, callback) {
      if (deps.every((dep) => context[dep] !== undefined)) callback(context)
      return { dispose() {} }
    },
    async _dispose() {
      for (const cleanup of cleanups.splice(0).reverse()) {
        try { await cleanup?.() } catch { /* teardown is best-effort in the stub */ }
      }
    },
    _listeners: listeners,
    _prependEvents: prependEvents,
    _commands: commands,
    _projections: projections,
    _warnings: warnings,
    _agents: agents,
  }
  return context
}

/** A plugin instance bound to one temporary lab root and one agent. */
async function harness({ labRoot, archivedIds }) {
  const ctx = createStubContext({ labRoot, archivedIds })
  process.env.DSH_HOME = path.dirname(labRoot)
  await applyPlugin(ctx)
  return ctx
}

function agentFor(session) {
  const invocations = []
  const agent = {
    session,
    ctx: { tools: { schemas: () => [], restrict: () => () => {}, guard: () => () => {}, register: () => () => {} } },
    async runMaintenance(action) {
      const controller = new AbortController()
      return action(controller.signal)
    },
  }
  return { agent, invocations }
}

function invocationFor(agent, rawInput) {
  return { agent, rawInput, signal: new AbortController().signal }
}

async function run(ctx, agent, rawInput) {
  const definition = ctx._commands.find((command) => command.name === 'memory-lab')
  assert.ok(definition, 'the memory-lab command must be registered')
  return definition.handler(invocationFor(agent, rawInput))
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

test('the plugin registers one command per engine and one projection', async () => {
  await withTempLab('register', async (labRoot) => {
    const ctx = await harness({ labRoot })
    // v1 与 v2 各注册一个命令，且工具集不随 on/off 增删。
    assert.equal(ctx._commands.length, 2)
    const names = ctx._commands.map((command) => command.name).sort()
    assert.deepEqual(names, ['memory-lab', 'memory-lab2'])
    const v1 = ctx._commands.find((command) => command.name === 'memory-lab')
    assert.equal(v1.recordInput, undefined, 'the default records the raw input, which the projection folds')
    assert.equal(ctx._projections.length, 1)
    assert.equal(ctx._projections[0].key, 'memoryContextLab')
    await ctx._dispose()
  })
})

test('on/status/off report through the command surface', async () => {
  await withTempLab('lifecycle', async (labRoot) => {
    const ctx = await harness({ labRoot })
    const session = buildSession({ operations: 2 })
    const { agent } = agentFor(session)

    const before = await run(ctx, agent, 'status')
    assert.equal(before.kind, 'success')
    assert.ok(before.text.includes('未启用'))

    const enabled = await run(ctx, agent, 'on')
    assert.equal(enabled.kind, 'success', enabled.text)
    assert.ok(enabled.text.includes('已在本会话启用'))
    // B4：降级文案只属于「冷库定位不到」的环境。探测 peer 在场与否，按轨断言，
    // 不再依赖「workspace 解析不到已安装的 dsh-memory」这个环境巧合。
    const peerResolvable = await peerDshMemoryResolvable()
    if (peerResolvable) {
      assert.ok(!enabled.text.includes('隔离冷库当前不可用'),
        `peer 在场时启用不得报降级：${enabled.text}`)
    } else {
      assert.ok(enabled.text.includes('隔离冷库当前不可用'), enabled.text)
    }

    const settings = await run(ctx, agent, 'set retain 3')
    assert.equal(settings.kind, 'success')
    assert.ok(settings.text.includes('保留最近操作数'))
    assert.ok(settings.text.includes('3'))

    // The retired occupancy keys are gone from the settings registry, so the old
    // spellings are rejected like any other unknown name.
    const bad = await run(ctx, agent, 'set target 5')
    assert.equal(bad.kind, 'error')

    // Release the retained window and drop the batch threshold to 1 so the two
    // operations are a filled batch, then prove that a missing cold store fails
    // closed instead of rewriting the surface.
    await run(ctx, agent, 'set retain 0')
    await run(ctx, agent, 'set batch 1')
    if (peerResolvable) {
      // B4：peer 在场时冷库可用，「无冷库→失败关闭」这条断言的前提不成立；
      // 真跑归档会起真实 Python 子进程（B5 的挂起源），此处不再执行 now。
      // 在场轨只验证 dry-run（纯规划，不落库、不起进程）。
      const dryPeer = await run(ctx, agent, 'dry-run')
      assert.equal(dryPeer.kind, 'success', `peer 在场时 dry-run 必须照常：${dryPeer.text}`)
    } else {
      const now = await run(ctx, agent, 'now')
      assert.equal(now.kind, 'error', `archiving without a usable cold store must fail closed, got: ${now.text}`)
      assert.ok(now.text.includes('原文未作静默删除'), now.text)
      const surfaceBefore = session.surface.nodes.length
      assert.equal(session.surface.nodes.length, surfaceBefore, 'nothing may be rewritten')
    }

    const dryRun = await run(ctx, agent, 'dry-run')
    assert.equal(dryRun.kind, 'success', dryRun.text)
    assert.ok(dryRun.text.includes('预演'))
    assert.ok(dryRun.text.includes('将在单批内'), `dry-run must find candidates, got: ${dryRun.text}`)

    const off = await run(ctx, agent, 'off')
    assert.equal(off.kind, 'success')
    await ctx._dispose()
  })
})

test('a resumed session re-adopts its durable state without re-running on', async () => {
  await withTempLab('resume', async (labRoot) => {
    const sessionId = 'session-resume-0001'
    const first = await harness({ labRoot })
    const sessionA = buildSession({ operations: 2, id: sessionId })
    const { agent: agentA } = agentFor(sessionA)
    const enabled = await run(first, agentA, 'on')
    assert.equal(enabled.kind, 'success', enabled.text)
    await run(first, agentA, 'set retain 7')
    await first._dispose()

    // Simulate a restart: a brand-new plugin instance with empty memory.
    const second = await harness({ labRoot })
    const sessionB = buildSession({ operations: 2, id: sessionId })
    const { agent: agentB } = agentFor(sessionB)

    // `status` must find the session without any `on` in this process.
    const status = await run(second, agentB, 'status')
    assert.equal(status.kind, 'success')
    assert.ok(status.text.includes('已启用'), `status should report an enabled session, got: ${status.text}`)
    assert.ok(status.text.includes('保留最近操作：7'), `durable settings must survive, got: ${status.text}`)
    await second._dispose()
  })
})

test('a set issued before on governs the engine, not only the panel', async () => {
  await withTempLab('preset', async (labRoot) => {
    const sessionId = 'session-preset-0001'
    const ctx = await harness({ labRoot })
    const session = buildSession({ operations: 2, id: sessionId })
    const { agent } = agentFor(session)

    // The host records every command it runs, so the log is written first. A `set`
    // before `on` used to be refused and therefore never reached the durable state,
    // while the projection still folded it from the log: the panel promised one
    // value and the engine kept cooling against the default, so it never fired.
    session.append('command/run', { commandId: 'c1', name: 'memory-lab', args: ' set batch 4' })
    const preset = await run(ctx, agent, 'set batch 4')
    assert.equal(preset.kind, 'success', preset.text)

    session.append('command/run', { commandId: 'c2', name: 'memory-lab', args: ' on' })
    const enabled = await run(ctx, agent, 'on')
    assert.equal(enabled.kind, 'success', enabled.text)

    // The durable file the engine reads must agree with the panel's folded view.
    const stored = await readSessionState(labRoot, sessionId)
    assert.equal(
      stored.state.settings.archiveBatchSize,
      4,
      'enabling must adopt a setting recorded before it, not reset to the default',
    )

    const status = await run(ctx, agent, 'status')
    assert.ok(status.text.includes('攒够 4 个'), `status must report the folded batch size, got: ${status.text}`)
    await ctx._dispose()
  })
})

test('a durable configuration survives when the log has no memory-lab record', async () => {
  await withTempLab('nolog', async (labRoot) => {
    const sessionId = 'session-nolog-0001'
    const seeded = await createSessionState(labRoot, sessionId, { archiveBatchSize: 7, retainOperations: 3 })
    seeded.state.enabled = true
    await writeSessionState(seeded.directory, seeded.state)

    // An empty fold must read as "no opinion". Returning the defaults here would
    // silently reset a stored configuration on every adopt.
    const ctx = await harness({ labRoot })
    const session = buildSession({ operations: 1, id: sessionId })
    const { agent } = agentFor(session)
    const status = await run(ctx, agent, 'status')
    assert.equal(status.kind, 'success')
    assert.ok(status.text.includes('攒够 7 个'), `the stored batch size must survive, got: ${status.text}`)
    assert.ok(status.text.includes('保留最近操作：3'), `the stored retention must survive, got: ${status.text}`)
    await ctx._dispose()
  })
})

test('the projection rebuilds settings from the session log, not from plugin memory', () => {
  // This is the mechanism that makes resume correct: the log alone is enough.
  let state = initProjectionState()
  const lines = ['on', 'set retain 4', 'set batch 6', 'set auto off', 'set recall off', 'set autorestore off']
  for (const [index, args] of lines.entries()) {
    state = applyEvent(state, { type: 'command/run', seq: index + 1, data: { name: 'memory-lab', args } })
  }
  const view = viewOf(state)
  assert.deepEqual(view, {
    enabled: true,
    retainOperations: 4,
    archiveBatchSize: 6,
    auto: false,
    autoRecall: false,
    autoRestore: false,
    preset: { id: '', label: GLOBAL_PRESET_LABEL, modified: false },
    // v2 引入：面板要能区分「哪个引擎持有本会话投影」。v1 会话恒为空串，
    // 字段固定存在，避免同一 slot 的 schema 随引擎切换而漂移。
    engine: 'v1',
    // 开关位：无命令记录时恒为 false（配置默认值由面板叠加显示）。
    fullHistory: false,
    planFirst: false,
    planActive: false,
    archived: 0,
    restored: 0,
    revision: lines.length,
  })
})

test('a cold session directory is written under the session key, not the raw id', async () => {
  await withTempLab('paths', async (labRoot) => {
    const sessionId = 'session-paths-0001'
    const created = await createSessionState(labRoot, sessionId, { retainOperations: 10 })
    assert.equal(path.basename(created.directory), sessionKeyFor(sessionId))
    assert.ok(!created.directory.includes(sessionId), 'the raw session id must not appear in a path')
    const read = await readSessionState(labRoot, sessionId)
    assert.equal(read.state.sessionId, sessionId)
    // A different session must not resolve to this state.
    assert.equal(await readSessionState(labRoot, 'session-other-0002'), null)
    // Disabled state is not adopted.
    created.state.enabled = false
    await writeSessionState(created.directory, created.state)
    assert.equal((await readSessionState(labRoot, sessionId)).state.enabled, false)
  })
})

test('recall is a no-op with nothing archived and fails closed once something is', async () => {
  await withTempLab('recall', async (labRoot) => {
    // ── Phase 1: nothing archived, so recall must not even open the cold store.
    const first = await harness({ labRoot })
    const idleId = 'session-recall-idle'
    const idleSession = buildSession({ operations: 1, id: idleId })
    const { agent: idleAgent } = agentFor(idleSession)
    await run(first, idleAgent, 'on')
    // 两套引擎各挂一个「回注」pre-step（都 prepend），所以这里出现两次；
    // 自动降温的两个监听不 prepend，不在这个列表里。
    assert.deepEqual(first._prependEvents, ['agent/pre-step', 'agent/pre-step'], 'each engine prepends one recall listener')
    const idleListeners = first._listeners.get('agent/pre-step')
    assert.equal(idleListeners.length, 6, 'v1 与 v2 各一个降温 + 一个回注，v2 一个有界工作状态注入，外加计划先行自动化钩子')

    const batch = [{
      id: 'user-1',
      role: 'user',
      content: [{ type: 'text', text: '之前那个文件里写了什么？' }],
      source: { kind: 'user' },
    }]
    const enter = () => ({ kind: 'enter', messages: [...batch] })
    const warningsBefore = first._warnings.length
    for (const listener of idleListeners) {
      const decision = await listener({ agent: idleAgent, signal: new AbortController().signal, turn: 1, step: 1 }, async () => enter())
      assert.equal(decision.kind, 'enter')
      assert.equal(decision.messages.length, 1, 'an idle recall must add nothing')
      assert.ok(decision.messages[0] === batch[0], 'the original batch entry must be reused, not copied')
    }
    assert.equal(first._warnings.length, warningsBefore, 'no cold store may be touched with nothing archived')
    await first._dispose()

    // ── Phase 2: seed a pending receipt, then enable so the record holds it.
    const pendingId = 'session-recall-pending'
    const seeded = await createSessionState(labRoot, pendingId, { retainOperations: 10, archiveBatchSize: 10 })
    seeded.state.enabled = true
    seeded.state.archive.push({
      rangeStart: 3,
      rangeEnd: 4,
      callIds: ['call-1'],
      tools: ['read'],
      nodeId: 'archived_x_1',
      hash: 'a'.repeat(64),
      chars: 100,
      originalTokens: 500,
      replacementSeq: 99,
      status: 'applied',
    })
    await writeSessionState(seeded.directory, seeded.state)

    const second = await harness({ labRoot })
    const pendingSession = buildSession({ operations: 1, id: pendingId })
    const { agent: pendingAgent } = agentFor(pendingSession)
    await run(second, pendingAgent, 'on')

    // B4：失败关闭轨只在「冷库定位不到」的环境成立；按探测结果分支，不再依赖
    // 「peer 恰好不在场」。在场轨跳过 listener 触发——真实冷库会起 Python 子进程
    //（B5 的挂起源），而「回注不吞决策」已由 Phase 1 的 idle 轨覆盖。
    if (await peerDshMemoryResolvable()) {
      assert.ok(true, 'peer 在场：Phase 2 的失败关闭断言不适用，跳过冷库触发（挂起源保护）')
    } else {
      // The cold store cannot open in this temp root, so recall must fail closed:
      // the decision passes through unchanged and the failure is logged.
      for (const listener of second._listeners.get('agent/pre-step')) {
        const decision = await listener({ agent: pendingAgent, signal: new AbortController().signal, turn: 1, step: 1 }, async () => enter())
        assert.equal(decision.kind, 'enter')
        assert.equal(decision.messages.length, 1, 'a failed recall must add nothing')
      }
      assert.ok(
        second._warnings.some((line) => line.includes('recall unavailable (call threw)') || line.includes('recall skipped')),
        `the failure must be logged, not swallowed silently; warnings: ${second._warnings.join(' | ')}`,
      )
    }
    await second._dispose()
  })
})

test('a rejected step never triggers cooling or recall work', async () => {
  await withTempLab('reject', async (labRoot) => {
    const ctx = await harness({ labRoot })
    const session = buildSession({ operations: 1, id: 'session-reject-0001' })
    const { agent } = agentFor(session)
    await run(ctx, agent, 'on')
    const listeners = ctx._listeners.get('agent/pre-step')
    const before = ctx._warnings.length
    for (const listener of listeners) {
      const decision = await listener({ agent, signal: new AbortController().signal, turn: 1, step: 1 }, async () => ({ kind: 'reject' }))
      assert.deepEqual(decision, { kind: 'reject' }, 'a rejected decision must pass through untouched')
    }
    assert.equal(ctx._warnings.length, before, 'nothing may be attempted for a rejected step')
    await ctx._dispose()
  })
})

test('automatic cooling delegates the waterfall and never blocks a step on failure', async () => {
  await withTempLab('auto', async (labRoot) => {
    const ctx = await harness({ labRoot })
    const session = buildSession({ operations: 2, id: 'session-auto-0001' })
    const { agent } = agentFor(session)
    await run(ctx, agent, 'on')

    const listeners = ctx._listeners.get('agent/pre-step')
    assert.equal(listeners.length, 6, 'v1 与 v2 各一个降温 + 一个回注，v2 一个有界工作状态注入，外加计划先行自动化钩子')
    let called = 0
    const decision = await listeners[0]({ agent, signal: new AbortController().signal }, async () => {
      called += 1
      return { kind: 'enter', messages: [] }
    })
    assert.equal(called, 1, 'pre-step must delegate so other listeners still run')
    assert.equal(decision.kind, 'enter', 'the decision must survive')
    await ctx._dispose()
  })
})

test('a session whose batch has not filled still records what it measured', async () => {
  // The reported gap: a real session archived nothing and left no evidence, so
  // "the batch was still filling" and "the measurement failed" were
  // indistinguishable once the session ended.
  await withTempLab('measured', async (labRoot) => {
    const ctx = await harness({ labRoot })
    const sessionId = 'session-measured-0001'
    const session = buildSession({ operations: 2, id: sessionId })
    const { agent } = agentFor(session)
    // The default retention keeps 10 operations verbatim, so with only two
    // operations on the surface nothing is ever out of the window — the batch
    // can never fill, which is exactly the steady state this test pins down.
    await run(ctx, agent, 'on')

    for (const listener of ctx._listeners.get('agent/pre-step')) {
      await listener({ agent, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [] }))
    }

    const found = await readSessionState(labRoot, sessionId)
    const stored = found?.state.lastMeasurement
    assert.ok(stored, 'an under-trigger step must persist its measurement')
    assert.equal(stored.kind, 'noop')
    assert.equal(stored.reason, 'waiting-for-batch', 'the only reason to hold is an unfilled batch')
    assert.ok(stored.assembledTokens > 0, 'the assembled estimate must be recorded')
    assert.equal(found.state.archive.length, 0, 'two operations are inside the retention window, so nothing is archived')
    await ctx._dispose()

    // The point of persisting it: a later process has no in-memory measurement,
    // so the durable one is the only thing that can explain the zero archive
    // count. This is exactly the situation the reported session was analysed in.
    const later = await harness({ labRoot })
    const status = await run(later, agent, 'status')
    assert.ok(status.text.includes('未触发归档'), `status must surface the stored measurement, got: ${status.text}`)
    assert.ok(status.text.includes('等待批量攒满'), `status must name the reason, got: ${status.text}`)
    await later._dispose()
  })
})

test('a failed measurement is recorded as a failure, not as a quiet no-op', async () => {
  await withTempLab('measuredfail', async (labRoot) => {
    const ctx = await harness({ labRoot })
    const sessionId = 'session-measuredfail-0001'
    const session = buildSession({ operations: 1, id: sessionId })
    const { agent } = agentFor(session)
    await run(ctx, agent, 'on')
    // No request header means the route is unknown, so measurement fails closed.
    session.requestHeader = () => undefined

    for (const listener of ctx._listeners.get('agent/pre-step')) {
      await listener({ agent, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [] }))
    }

    const found = await readSessionState(labRoot, sessionId)
    assert.equal(found?.state.lastMeasurement?.kind, 'unavailable', 'a failed measurement must be recorded as such')
    assert.ok(found.state.lastMeasurement.reason, 'the failure reason must be kept')
    const status = await run(ctx, agent, 'status')
    assert.ok(status.text.includes('失败关闭'), `status must report the failure, got: ${status.text}`)
    await ctx._dispose()
  })
})

test('an unconfigured lab root means adopt() finds nothing and stays inert', async () => {
  await withTempLab('inert', async (labRoot) => {
    const ctx = await harness({ labRoot })
    const session = buildSession({ operations: 1, id: 'session-inert-0001' })
    const { agent } = agentFor(session)
    const before = ctx._warnings.length
    for (const listener of ctx._listeners.get('agent/pre-step')) {
      let called = false
      await listener({ agent, signal: new AbortController().signal }, () => { called = true })
      assert.equal(called, true, 'every pre-step listener must delegate')
    }
    assert.equal(ctx._warnings.length, before, 'an inert session must not log per-step failures')
    // Nothing was enabled, so no state directory may be created as a side effect.
    await assert.rejects(readFile(path.join(labRoot, 'sessions', sessionKeyFor('session-inert-0001'), 'state.json')), /ENOENT/)
    await ctx._dispose()
  })
})

/** A receipt row shaped exactly like a committed archive entry. */
function receipt(status = 'applied') {
  return {
    rangeStart: 3,
    rangeEnd: 4,
    callIds: ['call-1'],
    tools: ['read'],
    nodeId: 'archived_x_1',
    hash: 'a'.repeat(64),
    chars: 100,
    originalTokens: 500,
    replacementSeq: 99,
    status,
  }
}

test('off reclaims the plugin data once nothing depends on the cold store', async () => {
  await withTempLab('offpurge', async (labRoot) => {
    const sessionId = 'session-offpurge-0001'
    const ctx = await harness({ labRoot })
    const session = buildSession({ operations: 1, id: sessionId })
    const { agent } = agentFor(session)

    await run(ctx, agent, 'on')
    assert.ok(await readSessionState(labRoot, sessionId), 'enabling must create the directory')

    // Nothing was archived, so no receipt depends on the cold store and stopping
    // cooling is the natural end of this session's plugin data.
    const off = await run(ctx, agent, 'off')
    assert.equal(off.kind, 'success', off.text)
    assert.ok(off.text.includes('清除了本会话的插件隔离数据'), `off must reclaim the data, got: ${off.text}`)
    assert.equal(await readSessionState(labRoot, sessionId), null, 'the directory must be gone')
    await ctx._dispose()
  })
})

test('off keeps the data only for receipts it could not restore', async () => {
  await withTempLab('offkeep', async (labRoot) => {
    const sessionId = 'session-offkeep-0001'
    const first = await harness({ labRoot })
    const session = buildSession({ operations: 1, id: sessionId })
    const { agent } = agentFor(session)
    await run(first, agent, 'on')
    const found = await readSessionState(labRoot, sessionId)
    // A receipt whose replacement node is not on this surface cannot be restored
    // (`回执节点已不在活动面`), so it keeps depending on the cold store.
    found.state.archive.push(receipt('applied'))
    await writeSessionState(found.directory, found.state)
    await first._dispose()

    // A fresh instance reads the receipt from disk, as a restart would.
    const second = await harness({ labRoot })
    const off = await run(second, agent, 'off')
    assert.equal(off.kind, 'success', off.text)
    assert.ok(off.text.includes('依赖冷库'), `off must explain why it kept the data, got: ${off.text}`)
    assert.ok(off.text.includes('/memory-lab clean confirm delete-session'), 'off must name the way to discard the store')
    assert.ok(await readSessionState(labRoot, sessionId), 'the originals must stay recoverable')
    await second._dispose()
  })
})

test('B3: a restore-skipped row keeps the cold store from being purged by off', async () => {
  await withTempLab('b3purge', async (labRoot) => {
    const sessionId = 'session-b3-purge-01'
    const first = await harness({ labRoot })
    const session = buildSession({ operations: 1, id: sessionId })
    const { agent } = agentFor(session)
    await run(first, agent, 'on')
    // 模拟 restoreAll 失败后的持久化状态（issue #2 的删除事故形态）：回执正文
    // 已变化 / 冷节点不可读 → restoreAll 把行改写为 `restore-skipped: <原因>`
    // （apply-engine.mjs 的写法），原文唯一副本仍在冷库。off 不得把
    // 「pendingReceipts=0」读成「无回执依赖冷库」而删库。
    const found = await readSessionState(labRoot, sessionId)
    found.state.archive.push(receipt('restore-skipped: 回执正文已变化'))
    await writeSessionState(found.directory, found.state)
    await first._dispose()

    const second = await harness({ labRoot })
    const off = await run(second, agent, 'off')
    assert.equal(off.kind, 'success', off.text)
    assert.ok(off.text.includes('依赖冷库'), `off must keep the store, got: ${off.text}`)
    assert.ok(off.text.includes('/memory-lab clean confirm delete-session'), 'off must hand the delete path back (B3: it was stolen by `removed`)')
    assert.equal(off.text.includes('清除了本会话的插件隔离数据'), false, 'off must not claim the store was removed')
    assert.ok(await readSessionState(labRoot, sessionId), 'the only copy of the originals must survive the stop')
    await second._dispose()
  })
})

test('B3: a restore-skipped row also gates the clean confirmation', async () => {
  await withTempLab('b3clean', async (labRoot) => {
    const sessionId = 'session-b3-clean-01'
    const first = await harness({ labRoot })
    const session = buildSession({ operations: 1, id: sessionId })
    const { agent } = agentFor(session)
    await run(first, agent, 'on')
    const found = await readSessionState(labRoot, sessionId)
    found.state.archive.push(receipt('restore-skipped: 冷节点不可读'))
    await writeSessionState(found.directory, found.state)
    await first._dispose()

    // `clean`（无 confirm）在原文仍被 restore-skipped 行指向冷库时必须拒绝，
    // 与 pending 行同一条门禁语义。
    const second = await harness({ labRoot })
    const clean = await run(second, agent, 'clean')
    assert.equal(clean.kind, 'error', `clean must refuse while the store still holds originals: ${clean.text}`)
    assert.ok(clean.text.includes('依赖隔离冷库'), `clean must explain the refusal, got: ${clean.text}`)
    assert.ok(await readSessionState(labRoot, sessionId), 'the store must survive the refusal')
    await second._dispose()
  })
})

test('off restores and reclaims when autoRestore is on and the originals are readable', async () => {
  await withTempLab('offrestore', async (labRoot) => {
    const sessionId = 'session-offrestore-0001'
    const first = await harness({ labRoot })
    const session = buildSession({ operations: 1, id: sessionId })
    const { agent } = agentFor(session)
    await run(first, agent, 'on')
    const found = await readSessionState(labRoot, sessionId)
    // Make the receipt restorable: its replacement node must be on the surface and
    // carry the receipt text the plugin rebuilds from the stored fields.
    const node = session.surface.nodes[0]
    found.state.archive.push({ ...receipt('applied'), replacementSeq: node })
    await writeSessionState(found.directory, found.state)
    await first._dispose()

    const second = await harness({ labRoot })
    const off = await run(second, agent, 'off')
    assert.equal(off.kind, 'success', off.text)
    // Either it restored and purged, or it could not restore and said so — but it
    // must never claim success while silently leaving a receipt pointing at a
    // deleted store.
    if (off.text.includes('清除了本会话的插件隔离数据')) {
      assert.equal(await readSessionState(labRoot, sessionId), null)
    } else {
      assert.ok(await readSessionState(labRoot, sessionId), 'a kept store must still exist')
      assert.ok(off.text.includes('依赖冷库'))
    }
    await second._dispose()
  })
})

test('set autorestore off stops cooling without touching the cold store', async () => {
  await withTempLab('noautorestore', async (labRoot) => {
    const sessionId = 'session-noautorestore-0001'
    const first = await harness({ labRoot })
    const session = buildSession({ operations: 1, id: sessionId })
    const { agent } = agentFor(session)
    await run(first, agent, 'on')
    await run(first, agent, 'set autorestore off')
    const found = await readSessionState(labRoot, sessionId)
    found.state.archive.push(receipt('applied'))
    await writeSessionState(found.directory, found.state)
    await first._dispose()

    const second = await harness({ labRoot })
    const off = await run(second, agent, 'off')
    assert.equal(off.kind, 'success', off.text)
    // The user asked for the originals to stay in the cold store, so the store must
    // survive even though receipts still point at it.
    assert.ok(await readSessionState(labRoot, sessionId), 'autorestore off must keep the store')
    assert.ok(off.text.includes('依赖冷库'), `off must say the store was kept, got: ${off.text}`)
    // `off` clears `enabled` and `adopt` refuses a disabled session, so `restore`
    // cannot reach these receipts again until the session is re-enabled. The user
    // must be told, or recoverable data looks lost.
    assert.ok(off.text.includes('/memory-lab on'), `off must name the way back, got: ${off.text}`)
    assert.ok(off.text.includes('/memory-lab restore'), `off must name restore, got: ${off.text}`)
    await second._dispose()
  })
})

/**
 * Wait for the fire-and-forget archive path to settle.
 *
 * `domain/changed` is an emit, so the plugin deliberately does not hold the write
 * open while it restores and purges; a test therefore has to wait for real file
 * I/O rather than a single tick.
 */
async function waitFor(check, { tries = 200 } = {}) {
  for (let index = 0; index < tries; index += 1) {
    if (await check()) return true
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return false
}

/** Give any wrongly-fired async work a fair chance to run before asserting it did not. */
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 60))
}

/** A `domain/changed` payload for the workspace archive singleton. */
function archiveChange(ids) {
  return { domain: 'workspace', table: 'workspaces', key: 'global', operation: 'put', value: { archivedSessionIds: ids } }
}

test('archiving the session returns it to normal without a window guard', async () => {
  await withTempLab('archive', async (labRoot) => {
    const sessionId = 'session-archive-0001'
    const ctx = await harness({ labRoot })
    const session = buildSession({ operations: 1, id: sessionId })
    const { agent } = agentFor(session)
    ctx._agents.set(sessionId, agent)
    await run(ctx, agent, 'on')
    assert.ok(await readSessionState(labRoot, sessionId), 'enabling must create the directory')

    const watch = ctx._listeners.get('domain/changed')
    assert.equal(watch.length, 1, 'exactly one archive listener must be registered')
    // First sighting only establishes the baseline; nothing is archived yet.
    watch[0](archiveChange([]))
    // The host writes the archive set once durability is acknowledged.
    watch[0](archiveChange([sessionId]))

    assert.ok(
      await waitFor(async () => (await readSessionState(labRoot, sessionId)) === null),
      'the archive must reclaim the data',
    )
    // Stopping means the suppression lease is released too: the real lingshu goes
    // back to normal for this session.
    const status = await run(ctx, agent, 'status')
    assert.ok(status.text.includes('未启用'), `the session must read as stopped, got: ${status.text}`)
    await ctx._dispose()
  })
})

test('an archive that happens before the plugin watches is not acted on', async () => {
  await withTempLab('archivepre', async (labRoot) => {
    const sessionId = 'session-archivepre-0001'
    const ctx = await harness({ labRoot })
    const session = buildSession({ operations: 1, id: sessionId })
    const { agent } = agentFor(session)
    ctx._agents.set(sessionId, agent)
    await run(ctx, agent, 'on')

    // The first change the plugin ever sees may already contain archives from
    // before it loaded; treating those as new would purge data for sessions the
    // user never asked about in this process.
    ctx._listeners.get('domain/changed')[0](archiveChange([sessionId, 'session-other']))
    await settle()
    assert.ok(await readSessionState(labRoot, sessionId), 'a pre-existing archive must not trigger cleanup')
    await ctx._dispose()
  })
})

test('a non-workspace domain write and a record write are both ignored', async () => {
  await withTempLab('archivenoise', async (labRoot) => {
    const sessionId = 'session-archivenoise-0001'
    const ctx = await harness({ labRoot })
    const session = buildSession({ operations: 1, id: sessionId })
    const { agent } = agentFor(session)
    ctx._agents.set(sessionId, agent)
    await run(ctx, agent, 'on')
    const watch = ctx._listeners.get('domain/changed')[0]
    watch(archiveChange([]))
    watch({ domain: 'credentials', table: 'x', key: 'y', operation: 'put', value: { archivedSessionIds: [sessionId] } })
    // A workspace *record* write carries no archive set at all.
    watch({ domain: 'workspace', table: 'workspaces', key: 'ws-1', operation: 'put', value: { id: 'ws-1' } })
    await settle()
    assert.ok(await readSessionState(labRoot, sessionId), 'unrelated writes must not purge anything')
    await ctx._dispose()
  })
})

test('archiving a session that never enabled cooling changes nothing', async () => {
  await withTempLab('archiveinert', async (labRoot) => {
    const ctx = await harness({ labRoot })
    const session = buildSession({ operations: 1, id: 'session-archiveinert-0001' })
    const { agent } = agentFor(session)
    ctx._agents.set('session-archiveinert-0001', agent)
    const before = ctx._warnings.length

    const watch = ctx._listeners.get('domain/changed')[0]
    watch(archiveChange([]))
    watch(archiveChange(['session-archiveinert-0001']))
    await settle()

    assert.equal(ctx._warnings.length, before, 'an inert archive must not log a failure')
    await ctx._dispose()
  })
})

test('archiving an unknown session id is a no-op, not a crash', async () => {
  await withTempLab('archiveunknown', async (labRoot) => {
    const ctx = await harness({ labRoot })
    const before = ctx._warnings.length
    // No live agent and no durable state: the plugin must leave other sessions
    // alone rather than deleting a store it cannot reason about.
    const watch = ctx._listeners.get('domain/changed')[0]
    watch(archiveChange([]))
    watch(archiveChange(['session-never-existed']))
    await settle()
    assert.equal(ctx._warnings.length, before, 'an unknown archive must not log a failure')
    await ctx._dispose()
  })
})

test('a resolvable registry lets the very first archive be acted on', async () => {
  await withTempLab('archiveseed', async (labRoot) => {
    const sessionId = 'session-archiveseed-0001'
    // The registry already reports one archived session at load, so the baseline is
    // known and the next archive is not mistaken for the first sighting.
    const ctx = await harness({ labRoot, archivedIds: ['session-already-gone'] })
    const session = buildSession({ operations: 1, id: sessionId })
    const { agent } = agentFor(session)
    ctx._agents.set(sessionId, agent)
    await run(ctx, agent, 'on')

    ctx._listeners.get('domain/changed')[0](archiveChange(['session-already-gone', sessionId]))

    assert.ok(
      await waitFor(async () => (await readSessionState(labRoot, sessionId)) === null),
      'a seeded baseline must not swallow the first real archive',
    )
    await ctx._dispose()
  })
})

test('clean refuses while receipts still shadow the surface, then succeeds after restore', async () => {  await withTempLab('clean', async (labRoot) => {
    const sessionId = 'session-clean-0001'
    const ctx = await harness({ labRoot })
    const session = buildSession({ operations: 1, id: sessionId })
    const { agent } = agentFor(session)
    await run(ctx, agent, 'on')

    // Forge a pending receipt in the durable state, as a real archive would.
    const found = await readSessionState(labRoot, sessionId)
    found.state.archive.push({
      rangeStart: 3,
      rangeEnd: 4,
      callIds: ['call-1'],
      tools: ['read'],
      nodeId: 'archived_x_1',
      hash: 'a'.repeat(64),
      chars: 100,
      originalTokens: 500,
      replacementSeq: 99,
      status: 'applied',
    })
    await writeSessionState(found.directory, found.state)

    const refused = await run(ctx, agent, 'clean')
    assert.equal(refused.kind, 'error')
    assert.ok(refused.text.includes('拒绝直接删除'))

    const confirmed = await run(ctx, agent, 'clean confirm delete-session')
    assert.equal(confirmed.kind, 'success', confirmed.text)
    assert.equal(await readSessionState(labRoot, sessionId), null)
    await ctx._dispose()
  })
})

test('the archived cold node carries every byte needed to rebuild the operation', async () => {
  // Guards the property restore depends on: arguments, results, and assistant
  // prose all survive into the cold record.
  const session = buildSession({ operations: 1 })
  const { collectOperationCandidates, planCooling, applyOneOperation } = await import('../src/apply.mjs')
  const { archiveChunkNodeId } = await import('../src/core.mjs')
  const measured = fakeMeter.measure(session)
  const view = collectOperationCandidates({
    surfaceNodes: session.surface.nodes,
    eventAt: (seq) => session.eventAt(seq),
    measuredNodes: measured.nodes,
    retainOperations: 0,
    openTurn: undefined,
    archivedRanges: [],
    minimumChars: 100,
  })
  const plan = planCooling({ candidates: view.candidates, meter: fakeMeter, nodeIdFor: () => 'n1', minNetReleaseTokens: 1 })
  assert.equal(plan.units.length, 1)
  const store = new FakeColdStore()
  const outcome = await applyOneOperation({ session, client: store, unit: plan.units[0], meter: fakeMeter, hostVersion: 'test' })
  assert.equal(outcome.state, 'applied')
  const stored = store.nodes.get(archiveChunkNodeId('n1', 0)).content
  assert.ok(stored.includes('## 调用 1'))
  assert.ok(stored.includes('参数：'))
  assert.ok(stored.includes('结果：'))
})

test('disposal closes the cold store and releases suppression', async () => {
  await withTempLab('dispose', async (labRoot) => {
    const ctx = await harness({ labRoot })
    const session = buildSession({ operations: 1, id: 'session-dispose-0001' })
    const { agent } = agentFor(session)
    await run(ctx, agent, 'on')
    await assert.doesNotReject(() => ctx._dispose())
  })
})

test('operation() builds ranges the fake surface accepts, proving the fixture is honest', () => {
  const session = buildSession({ operations: 2 })
  // Two operations: assistant + result each, plus the head and user message.
  assert.equal(session.surface.nodes.length, 6)
  const types = session.surface.nodes.map((seq) => session.eventAt(seq).type)
  assert.deepEqual(types, ['system/message', 'user/message', 'assistant/message', 'tool/result', 'assistant/message', 'tool/result'])
})

// ── Durable cold-node claims & the strict batch cap's plumbing ─────────────
// The 317fd313 forensics showed the fatal loop: node ids were re-derived from
// `pendingReceipts + candidate index` on every measure, so a failed unit's
// retry landed on a shifted id that already held another unit's bytes and
// failed deterministically. The fix is a durable claim map plus an ordinal
// allocator that never reissues a used id.

test('the ordinal allocator never reissues a claimed or applied id', () => {
  const record = { state: { nodeClaims: { 20: { ordinal: 3 }, 40: { ordinal: 2 } }, archive: [{ nodeId: 'archived_key_7' }] } }
  const allocator = makeOrdinalAllocator(record)
  assert.equal(allocator.next(), 8, 'one past the highest of claims and receipts')
  assert.equal(allocator.next(), 9)
})

test('nodeClaimOf returns the durable claim for a range', () => {
  const record = { state: { nodeClaims: { 20: { ordinal: 3 } } } }
  assert.deepEqual(nodeClaimOf(record, 20), { ordinal: 3 })
  assert.equal(nodeClaimOf(record, 21), null)
  // A state from an older build has no claims at all.
  assert.equal(nodeClaimOf({ state: {} }, 1), null)
})

test('claimsOfRecord initializes an empty claim map in place', () => {
  const state = {}
  const claims = claimsOfRecord({ state })
  assert.deepEqual(claims, {})
  claims[1] = { ordinal: 1 }
  assert.equal(state.nodeClaims[1].ordinal, 1, 'the map must be the state object, not a copy')
})

// The e943ef19 deadlock, replayed at the allocator level: a failed unit leaves
// an orphaned write behind under its claimed node id, and the claim is then
// deleted so the next measure re-mints. The allocator must look at the durable
// failure ledger, not just the live claims, or it hands the same poisoned id
// straight back and the unit collides with its own orphan forever.
test('the ordinal allocator skips ids named in the failure ledger', () => {
  const record = {
    state: {
      nodeClaims: { 20: { ordinal: 3 } },
      archive: [{ nodeId: 'archived_key_7', chunkIds: ['archived_key_7_p1'] }],
      lastFailures: [
        { rangeStart: 10, nodeId: 'archived_key_1', state: 'cold-write-failed' },
        { rangeStart: 12, nodeId: 'archived_key_4', state: 'orphaned' },
      ],
    },
  }
  const allocator = makeOrdinalAllocator(record)
  // Claims hold 3, the receipt holds 7, the orphans hold 1 and 4 → max is 7.
  assert.equal(allocator.next(), 8, 'one past claims, receipts, and orphaned writes alike')
})

test('a poisoned claim can be deleted so the next measure re-mints a clean ordinal', () => {
  // This is the self-heal runBatch performs after a `cold-write-failed`: the
  // claim is dropped, and the allocator — now aware of the orphan via the
  // failure ledger — issues a fresh id instead of the dead one.
  const record = {
    state: {
      nodeClaims: { 22: { ordinal: 1 } },
      archive: [],
      lastFailures: [{ rangeStart: 22, nodeId: 'archived_key_1', state: 'cold-write-failed' }],
    },
  }
  const claims = claimsOfRecord(record)
  delete claims[22]
  const allocator = makeOrdinalAllocator(record)
  assert.notEqual(allocator.next(), 1, 'the orphaned id must not be re-issued for the same range')
})

// C-11: a corrupt state file used to read as "never enabled", so the very next
// turn silently dropped every archive receipt out of the projection. The fix
// distinguishes damage from absence and refuses every mutating entry point
// except the explicitly confirmed full-session delete.
test('a corrupt state file stops intervention instead of reading as never-enabled', async () => {
  await withTempLab('damaged', async (labRoot) => {
    const sessionId = 'session-damaged-0001'
    const first = await harness({ labRoot })
    const session = buildSession({ operations: 2, id: sessionId })
    const { agent } = agentFor(session)
    const enabled = await run(first, agent, 'on')
    assert.equal(enabled.kind, 'success', enabled.text)
    await first._dispose()

    const stateFile = path.join(labRoot, 'sessions', sessionKeyFor(sessionId), 'state.json')
    await writeFile(stateFile, '{broken', 'utf8')

    // A fresh plugin instance re-adopts from disk and must see damage, not
    // absence.
    const second = await harness({ labRoot })
    const status = await run(second, agent, 'status')
    assert.equal(status.kind, 'error')
    assert.ok(status.text.includes('损坏'), status.text)
    assert.ok(status.text.includes('delete-session'), 'the escape hatch must be named')

    // Every mutating entry point refuses; nothing may rewrite the surface.
    const surfaceBefore = session.surface.nodes.length
    const on = await run(second, agent, 'on')
    assert.equal(on.kind, 'error')
    assert.ok(on.text.includes('损坏'), on.text)
    const now = await run(second, agent, 'now')
    assert.equal(now.kind, 'error')
    assert.ok(now.text.includes('损坏'), now.text)
    const off = await run(second, agent, 'off')
    assert.equal(off.kind, 'error')
    const plainClean = await run(second, agent, 'clean')
    assert.equal(plainClean.kind, 'error')
    assert.ok(plainClean.text.includes('confirm delete-session'), plainClean.text)
    assert.equal(session.surface.nodes.length, surfaceBefore, 'no turn may rewrite the surface')

    // The confirmed escape hatch deletes the whole session directory.
    const confirmed = await run(second, agent, 'clean confirm delete-session')
    assert.equal(confirmed.kind, 'success', confirmed.text)
    await rm(path.join(labRoot, 'sessions', sessionKeyFor(sessionId)), { recursive: true, force: true })
    await second._dispose()
  })
})
