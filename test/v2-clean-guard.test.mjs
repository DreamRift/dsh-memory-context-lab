/**
 * 0.13.2 守卫：`clean confirm delete-session` 的「引擎仍启用」守卫（D-02）。
 *
 * ## 缺陷
 * 守卫只查**进程内**的 `records`。DSH 重启后 `records` 为空，而磁盘上
 * `v2/sessions/<key>/state.json` 仍 `enabled: true`、`engine.json` 仍
 * `disabled: null`（active）、会话日志里的 v2 回执仍指向这批记录——三者都在，
 * 守卫却看不到任何一个，于是 `rm -rf` 整个隔离根：原文永久不可读，
 * 连「这里曾经启用过」都查不出来。
 *
 * ## 判据（改回去必红）
 * - 模拟重启（新 ctx、records 空、磁盘 enabled=true）后执行 clean → `kind=error`；
 * - 冷库目录与 state.json 仍在；
 * - 三源都清干净之后（正式 off）才允许删除，并且删前把 state/engine 备份到会话根**之外**。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { apply as applyPlugin } from '../src/index.mjs'
import { buildSession, fakeMeter } from './helpers/fake-host.mjs'
import { readV2SessionState, v2SessionDirectoryFor } from '../src/v2/state.mjs'

const COMMAND = 'memory-lab'

function createStubContext() {
  const listeners = new Map()
  const commands = []
  const agents = new Map()
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    get(name) {
      if (name === 'tokenMeter') return fakeMeter
      if (name === 'llm') return { resolveModelInfo: async () => ({ context: { contextWindow: 100000 }, defaultMaxTokens: 4096 }) }
      if (name === 'agents') return { get: (id) => agents.get(id) }
      return undefined
    },
    on(event, handler) {
      const rows = listeners.get(event) ?? []
      rows.push(handler)
      listeners.set(event, rows)
      return () => listeners.set(event, (listeners.get(event) ?? []).filter((row) => row !== handler))
    },
    effect(fn) {
      const result = fn()
      const local = []
      if (result && typeof result.next === 'function') {
        let step = result.next()
        while (!step.done) {
          local.push(step.value)
          step = result.next()
        }
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
  return ctx
}

function agentFor(session) {
  return {
    session,
    ctx: { tools: { schemas: () => [], restrict: () => () => {}, guard: () => () => {}, register: () => () => {} } },
    async runMaintenance(action) { return action(new AbortController().signal) },
  }
}

async function boot() {
  const ctx = createStubContext()
  await applyPlugin(ctx)
  return ctx
}

function run(ctx, agent, rawInput) {
  const definition = ctx._commands.find((row) => row.name === COMMAND)
  assert.ok(definition, '命令必须已注册')
  return definition.handler({ agent, rawInput, signal: new AbortController().signal })
}

async function withTempLab(name, body) {
  const root = await mkdtemp(path.join(tmpdir(), `mcl-cleanguard-${name}-`))
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

const exists = (target) => stat(target).then(() => true, () => false)

test('重启后（进程内无记录、磁盘仍 enabled）执行 clean → 拒绝删除，冷库与账本都在', async () => {
  await withTempLab('restart', async (labRoot) => {
    const sessionId = 'session-clean-guard-restart'
    const session = buildSession({ operations: 1, id: sessionId })
    const first = await boot()
    const enabled = await run(first, agentFor(session), 'on')
    assert.equal(enabled.kind, 'success', enabled.text)
    await first._dispose()

    // 模拟 DSH 重启：新 ctx（records 为空），磁盘上 enabled 仍是 true。
    const second = await boot()
    const directory = v2SessionDirectoryFor(labRoot, sessionId)
    assert.equal((await readV2SessionState(labRoot, sessionId))?.state?.enabled, true, '前提：磁盘上仍启用')

    const refused = await run(second, agentFor(session), 'clean confirm delete-session')
    assert.equal(refused.kind, 'error', `引擎仍启用时必须拒绝，实际：${refused.kind} / ${refused.text}`)
    assert.match(refused.text, /仍处于启用状态/)
    assert.ok(await exists(directory), '守卫拒绝时冷库目录必须仍在')
    assert.equal((await readV2SessionState(labRoot, sessionId))?.state?.enabled, true, '账本不得被删')
    await second._dispose()
  })
})

test('正式 off 之后才允许删除，且删前把 state/engine 备份到会话根之外', async () => {
  await withTempLab('after-off', async (labRoot) => {
    const sessionId = 'session-clean-guard-off'
    const session = buildSession({ operations: 1, id: sessionId })
    const ctx = await boot()
    const agent = agentFor(session)
    assert.equal((await run(ctx, agent, 'on')).kind, 'success')
    const off = await run(ctx, agent, 'off')
    assert.equal(off.kind, 'success', off.text)

    const directory = v2SessionDirectoryFor(labRoot, sessionId)
    const removed = await run(ctx, agent, 'clean confirm delete-session')
    assert.equal(removed.kind, 'success', removed.text)
    assert.equal(await exists(directory), false, '停用后清理必须真的删掉隔离根')

    // 取证痕迹留在会话根之外：v2/quarantine/deleted-session-<key>-<ts>/
    const quarantine = path.join(labRoot, 'v2', 'quarantine')
    const rows = await readdir(quarantine).catch(() => [])
    const backup = rows.find((name) => name.startsWith('deleted-session-'))
    assert.ok(backup, `必须留下删除前的状态备份：${rows.join(', ')}`)
    const files = await readdir(path.join(quarantine, backup))
    assert.ok(files.includes('state.json'), `备份必须含 state.json：${files.join(', ')}`)
    await ctx._dispose()
  })
})
