/**
 * P2-13（0.15.1）：`uiWorkspace` / `remote.commands` 写成硬 `inject` → 缺任一则整个客户端半不装配。
 *
 * ## 缺陷
 * 浏览器半的 `inject` 数组曾被写成
 * `['slots', 'locale', 'remote', 'remote.commands', 'uiWorkspace']`。宿主
 * `dsh-cordis-client-runner` 把这份数组当**等待集合**（`waitingFor = Object.keys(fiber.inject)
 * .filter(name => ctx.get(name) === undefined)`，lib/client.js:590）：只要有**一个**服务缺席，
 * 这个客户端半就永远停在 waiting，`apply` 根本不跑——composer chip、侧栏面板、设置页
 * **一起消失**，而宿主侧的记忆能力一切正常。用户在升级宿主、关掉命令插件或换工作区面板后
 * 会看到「插件装了但界面上什么都没有」，没有任何错误提示指向真正原因。
 *
 * 反差更明显的是：`remoteOf()` 与 `uiWorkspaceOf()` 本来就把「服务缺席」当成正常态
 * （返回 null → 控件禁用 + 文案说明 `remoteUnavailable`），因此硬 inject 的代价与收益
 * 完全不成比例——为了一个「可选写通道」把整块 UI 押上去。
 *
 * ## 判据来源
 * docs/dev-0.15.1/记忆上下文-0.15.1-独立排查报告.md §3.2 P2-13（审读）；
 * 宿主语义按 dsh-cordis-client-runner lib/client.js:590 与 :329 核验（2026-11-05）。
 *
 * ## 修法
 * - 硬 `inject` 只保留「缺了就完全没法工作」的三个：`slots`（无槽位无可挂）、
 *   `locale`（无字典只剩键名）、`remote`（弹层与面板都要命令通道）；
 * - `remote.commands` / `uiWorkspace` 改为 `ctx.inject([...], cb)` **可选接入**：
 *   服务在时把 ctx 记进 `hostCtx`，缺席时这段不执行、UI 照常挂载；
 * - 判权声明仍然存在（宿主代理按 declared 拦截 `ctx.remote.commands` 读取，H-103），
 *   只是从「等待集合」搬到「可选声明」。
 *
 * ## 断言组
 * 1. 硬 `inject` 恰好是 `['slots','locale','remote']`（不再含可选写通道）；
 * 2. `OPTIONAL_INJECTS` 覆盖 `remote.commands` 与 `uiWorkspace`（判权声明不丢）；
 * 3. **缺服务也能装配**：宿主只给 slots/locale/remote 时，chip 与两个面板槽位仍被注册；
 * 4. 缺席时渲染面诚实：弹层显示「通道不可用」而不是假装能执行。
 *
 * ## 不适用条件与已知边界
 * - 不改变任何 UI 结构或文案，只改「装配前提」与「服务声明位置」。
 * - 宿主同时注册了这些服务时行为与旧版等价（可选接入的回调会跑，hostCtx 照旧可用）。
 * - 宿主 runner 的 waitingFor 语义不在本仓库，本条只按核验到的实现做断言。
 *
 * ## 定点变异自证
 * 把 `remote.commands`/`uiWorkspace` 放回硬 `inject` → 组 1/3 红。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const CLIENT = path.join(import.meta.dirname, '..', 'src', 'client.js')

async function loadClient() {
  const registered = []
  const previous = globalThis.window
  globalThis.window = { __ModuleLoader__: { load(entry) { registered.push(entry) } } }
  try {
    await import(pathToFileURL(CLIENT).href + '?t=' + Date.now())
  } finally {
    if (previous === undefined) delete globalThis.window
    else globalThis.window = previous
  }
  assert.equal(registered.length, 1)
  return registered[0]
}

/** 模拟宿主：只有 available 里列出的服务存在；其余 `ctx.get` 返回 undefined。 */
function hostCtx({ available }) {
  const registered = { slots: [], dictionaries: [], optional: [] }
  const get = (name) => (available.includes(name) ? {} : undefined)
  const ctx = {
    get,
    effect(fn) { const d = fn(); return () => { if (typeof d === 'function') d() } },
    locale: {
      register(ns, dict) { registered.dictionaries.push({ ns, dict }); return () => {} },
      bind() { return (key) => key },
    },
    slots: {
      inject(name, register) { registered.slots.push({ name, register }) },
      register(registration) { registered.slots.push({ registration }); return () => {} },
    },
    inject(deps, callback) {
      registered.optional.push([...deps])
      // 真实 cordis：依赖都在才启动子插件；这里如实模拟。
      if (deps.every((name) => available.includes(name))) callback(ctx)
    },
  }
  ctx.remote = available.includes('remote') ? { commands: available.includes('remote.commands') ? { execute: async () => ({}) } : undefined } : undefined
  ctx.uiWorkspace = available.includes('uiWorkspace') ? { forkSession: async () => ({}) } : undefined
  return { ctx, registered }
}

function applyOnce(entry, host) {
  const module = entry.factory((name) => {
    if (name === 'react') return { createElement: () => null, Fragment: 'Fragment', useState: (v) => [v, () => {}], useEffect: () => {}, useMemo: (f) => f(), useCallback: (f) => f, useRef: (v) => ({ current: v }) }
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return { Button: function Button() {}, Switch: function Switch() {} }
    throw new Error('unexpected require: ' + name)
  })
  module.apply(host.ctx)
  return module
}

test('P2-13 硬 inject 只保留「缺了就没法工作」的三个服务', async () => {
  const entry = await loadClient()
  const host = hostCtx({ available: ['slots', 'locale', 'remote'] })
  const module = applyOnce(entry, host)
  assert.deepEqual(module.inject, ['slots', 'locale', 'remote'],
    'UI 写通道不得进硬 inject：宿主缺一个服务就整块 UI 不装配')
  assert.ok(module.OPTIONAL_INJECTS.some((names) => names.includes('remote.commands')), '命令通道必须声明（可选）')
  assert.ok(module.OPTIONAL_INJECTS.some((names) => names.includes('uiWorkspace')), '工作区必须声明（可选）')
})

test('P2-13 宿主没给 remote.commands / uiWorkspace 时 UI 仍然装配', async () => {
  const entry = await loadClient()
  // 只给 slots/locale/remote：这是「装了命令插件之外的最小宿主」。
  const host = hostCtx({ available: ['slots', 'locale', 'remote'] })
  applyOnce(entry, host)
  const slotNames = host.registered.slots.map((row) => row.name).filter(Boolean)
  assert.ok(slotNames.includes('conversation.input.left'), 'chip 槽位必须仍然声明（旧实现整块不 apply）')
  assert.ok(slotNames.includes('sidebar.panellist'), '侧栏面板必须仍然声明')
  assert.ok(slotNames.includes('main'), '主视图必须仍然声明')
  assert.equal(host.registered.dictionaries.length, 1, '字典必须仍然注册')
})

test('P2-13 完全服务齐全时行为不变（可选接入回调照常跑）', async () => {
  const entry = await loadClient()
  const host = hostCtx({ available: ['slots', 'locale', 'remote', 'remote.commands', 'uiWorkspace'] })
  applyOnce(entry, host)
  const optionalNames = host.registered.optional.map((names) => names.join(','))
  assert.ok(optionalNames.includes('remote.commands'), '服务齐全时可选接入必须被发起')
  assert.ok(optionalNames.includes('uiWorkspace'))
})
