/**
 * 0.13.2 守卫：抑制实况必须如实出现在 `on` 回执与 `status` 里（D-04）。
 *
 * ## 缺陷
 * 版本闸门失败 → `coordinator = null` → `suppressionLease = null`（抑制根本没装上），
 * 而 `on` 回执照旧写死「本会话对真实灵枢的自动读写已抑制」；`status` 里也没有
 * 「真实灵枢抑制」这一行（0.13.1 删 v1 时一起没了）。于是「抑制 0 次」与「抑制根本
 * 没装上」在用户面前完全无法区分——0.13.1 的核心安全声明在这台机器上实际不生效，
 * 而用户以为它在生效。
 *
 * ## 判据（改回去必红）
 * - 拿不到抑制协调器时，`on` 回执**不含**「已抑制」，且写明原因与「未被拦截」；
 * - `status` 恒有一行「真实灵枢抑制」，未启用时带原因；
 * - 协调器在场且授予租约时，回执与 status 都报「已抑制」（不能矫枉过正成永远说没装）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { apply as applyPlugin } from '../src/index.mjs'
import { buildSession, fakeMeter } from './helpers/fake-host.mjs'
import { createV2Runtime } from '../src/v2/runtime.mjs'

const COMMAND = 'memory-lab'

function createStubContext() {
  const commands = []
  const agents = new Map()
  return {
    logger: { info() {}, warn() {}, error() {} },
    get(name) {
      if (name === 'tokenMeter') return fakeMeter
      if (name === 'llm') return { resolveModelInfo: async () => ({ context: { contextWindow: 100000 }, defaultMaxTokens: 4096 }) }
      if (name === 'agents') return { get: (id) => agents.get(id) }
      return undefined
    },
    on() { return () => {} },
    effect(fn) {
      const result = fn()
      const local = []
      if (result && typeof result.next === 'function') {
        let step = result.next()
        while (!step.done) { local.push(step.value); step = result.next() }
      } else if (typeof result === 'function') local.push(result)
      return () => { for (const cleanup of local.splice(0).reverse()) cleanup?.() }
    },
    commands: { register(definition) { commands.push(definition); return () => {} } },
    sessionProjections: { register() { return () => {} } },
    tools: { register() { return () => {} } },
    inject() { return { dispose() {} } },
    async _dispose() {},
    _commands: commands,
  }
}

function agentFor(session) {
  return {
    session,
    ctx: { tools: { schemas: () => [], restrict: () => () => {}, guard: () => () => {}, register: () => () => {} } },
    async runMaintenance(action) { return action(new AbortController().signal) },
  }
}

function run(ctx, agent, rawInput) {
  const definition = ctx._commands.find((row) => row.name === COMMAND)
  assert.ok(definition, '命令必须已注册')
  return definition.handler({ agent, rawInput, signal: new AbortController().signal })
}

async function withTempLab(name, body) {
  const root = await mkdtemp(path.join(tmpdir(), `mcl-suppression-${name}-`))
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

/** 只造 runtime（不走 apply）：抑制依赖由参数直接注入，专测「装没装上」的回执口径。 */
async function runtimeWith(labRoot, { coordinator, reason = null }) {
  return createV2Runtime({
    labRoot,
    services: { get: () => undefined },
    logger: { info() {}, warn() {}, error() {} },
    hostVersion: 'test',
    sessionIdOf: (session) => session.id,
    recallQueryFrom: () => null,
    coordinator,
    suppressionUnavailableReason: reason,
  })
}

test('闸门失败（无协调器）时 on 回执不得宣称「已抑制」，status 必须写不可用原因', async () => {
  await withTempLab('gate-off', async (labRoot) => {
    const runtime = await runtimeWith(labRoot, { coordinator: null, reason: 'dsh-memory 兼容性闸门未通过：版本不符' })
    const session = buildSession({ operations: 1, id: 'session-suppression-off' })
    const agent = agentFor(session)
    const enabled = await runtime.commandHandler({ agent, rawInput: 'on', signal: new AbortController().signal })
    assert.equal(enabled.kind, 'success', enabled.text)
    assert.doesNotMatch(enabled.text, /自动读写已抑制/, '抑制没装上却宣称已抑制：' + enabled.text)
    assert.match(enabled.text, /抑制未启用/)
    assert.match(enabled.text, /未被拦截/)
    assert.match(enabled.text, /版本不符/, '必须带上不可用原因，否则用户无法判断该怎么办')

    const status = await runtime.commandHandler({ agent, rawInput: 'status', signal: new AbortController().signal })
    assert.match(status.text, /真实灵枢抑制：未启用/, 'status 必须有一行抑制实况：' + status.text)
    assert.match(status.text, /版本不符/)
    await runtime.shutdown()
  })
})

test('协调器授予租约时回执与 status 都报「已抑制」（不矫枉过正）', async () => {
  await withTempLab('gate-on', async (labRoot) => {
    const released = []
    const coordinator = {
      acquire(sessionId) { return { sessionId, release: () => released.push(sessionId) } },
    }
    const runtime = await runtimeWith(labRoot, { coordinator })
    const session = buildSession({ operations: 1, id: 'session-suppression-on' })
    const agent = agentFor(session)
    const enabled = await runtime.commandHandler({ agent, rawInput: 'on', signal: new AbortController().signal })
    assert.match(enabled.text, /自动读写已抑制/)
    const status = await runtime.commandHandler({ agent, rawInput: 'status', signal: new AbortController().signal })
    assert.match(status.text, /真实灵枢抑制：已启用/)
    await runtime.commandHandler({ agent, rawInput: 'off', signal: new AbortController().signal })
    assert.deepEqual(released, ['session-suppression-on'], '停用必须释放租约')
    await runtime.shutdown()
  })
})

test('apply 入口把闸门失败原因一路传到 on 回执（不是只在 logger 里打一行）', async () => {
  await withTempLab('apply-wiring', async () => {
    const ctx = createStubContext()
    await applyPlugin(ctx)
    const session = buildSession({ operations: 1, id: 'session-apply-wiring' })
    const enabled = await run(ctx, agentFor(session), 'on')
    assert.equal(enabled.kind, 'success', enabled.text)
    // 本机若闸门通过（dsh-memory 在已核验范围内），回执应当是「已抑制」；
    // 无论哪一支，都**必须**有一句实况，不得两者都没有。
    assert.match(enabled.text, /自动读写已抑制|抑制未启用/, '回执必须声明抑制实况：' + enabled.text)
    await ctx._dispose()
  })
})
