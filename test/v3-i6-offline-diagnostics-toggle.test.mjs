import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { apply, Config, offlineDiagnosticsLines, SETTINGS_DEFAULTS } from '../src/index.mjs'
import { createFakeSession } from './helpers/fake-session.mjs'

function diag() {
  return {
    available: { warm: true, compiler: true, recall: true, shadow: true },
    reasons: {},
    calls: { warm: 0, compiler: 0, recall: 0, shadow: 0 },
    shadow() { return { report: null, comparison: null, ports: { store: { write() { throw new Error('shadow-write-forbidden:store.write') } } } } },
  }
}

test('I6 offline diagnostics explicit false returns no lines', () => {
  assert.deepEqual(offlineDiagnosticsLines(diag(), false), [])
})

test('I6 offline diagnostics explicit true emits warm module line', () => {
  assert.ok(offlineDiagnosticsLines(diag(), true).some((line) => line.includes('· 离线诊断模块 warm：')))
})

test('I6 environment variable is not a backdoor: config false keeps diagnostics off', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'mcl-i6-toggle-'))
  const oldHome = process.env.DSH_HOME
  const oldFlag = process.env.MEMORY_CONTEXT_DIAGNOSTICS
  const commands = []
  const handlers = new Map()
  const disposers = []
  process.env.DSH_HOME = home
  process.env.MEMORY_CONTEXT_DIAGNOSTICS = '1'
  const ctx = {
    logger: { warn() {}, info() {}, error() {} },
    on(name, handler) { handlers.set(name, handler); return () => {} },
    effect(fn) { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); return () => {} },
    inject() { return { dispose() {} } },
    commands: { register(definition) { commands.push(definition); return () => {} } },
    get() { return undefined },
  }
  try {
    await apply(ctx, { enabled: false, offlineDiagnostics: false })
    const session = createFakeSession({ id: 'i6-toggle-env' })
    await commands[0].handler({ rawInput: 'on', agent: { session } })
    session.pushUser('i6 diagnostics runtime seed')
    await handlers.get('agent/pre-step')({ agent: { session }, messages: [], turn: 1, step: 1, signal: { aborted: false } }, async () => {})
    const result = await commands[0].handler({ rawInput: 'status', agent: { session } })
    assert.equal(result.kind, 'success')
    assert.ok(!result.text.includes('离线诊断'), '环境变量不得再覆盖设置页开关（H7：后门已移除）')
  } finally {
    for (const dispose of disposers.reverse()) await dispose()
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
    if (oldFlag === undefined) delete process.env.MEMORY_CONTEXT_DIAGNOSTICS
    else process.env.MEMORY_CONTEXT_DIAGNOSTICS = oldFlag
    await rm(home, { recursive: true, force: true })
  }
})

test('I6 Config exposes volatile offlineDiagnostics defaulting false', () => {
  const json = Config.toJSON()
  const root = json.refs?.[json.uid] ?? json
  const ref = root.dict.offlineDiagnostics
  const node = json.refs?.[ref] ?? ref
  assert.equal(node.type, 'boolean')
  assert.equal(node.meta?.default, false)
  assert.equal(node.meta?.volatile, true)
})

test('I6 SETTINGS_DEFAULTS offlineDiagnostics is false', () => {
  assert.equal(SETTINGS_DEFAULTS.offlineDiagnostics, false)
})

test('I6 null diagnostics returns one unavailable line without throwing', () => {
  assert.deepEqual(offlineDiagnosticsLines(null, true), ['· 离线诊断：不可用（会话 runtime 未就绪）'])
})
