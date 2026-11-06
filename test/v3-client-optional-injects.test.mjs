/**
 * DSH 0.2.2 动态客户端命令通道守卫。
 *
 * 缺陷：旧实现把 remote.commands 移到可选 ctx.inject。新版 dynamicCordisContext 的
 * CTX_VERBS 不转发 inject，且声明集合来自父插件 fiber.inject，所以命令读取永远被拒绝，
 * 弹层显示「命令通道不可用」。
 *
 * 判据来源：本机 DSH 0.2.2-rc.1 app.asar（2026-11-06）：
 * dsh-cordis-client-runner/lib/client.js 的 dynamicCordisContext / CTX_VERBS；
 * 官方 dsh-client-ui-commands/lib/client.js 的 inject = [..., 'remote', 'remote.commands']。
 *
 * 断言组：核心命令服务正式声明；缺失时宿主保持 waiting 而非假可用；正常服务下正常装配；
 * 只有非核心的 uiWorkspace 与 configForms 保留可选接入。
 *
 * 边界：这里模拟宿主 waitingFor 与服务门面，不替代真实浏览器点击验收。
 * 定点变异自证：把 remote.commands 移出 inject 或恢复可选 ctx.inject → 三组全红。
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

/** 模拟宿主：只有 available 里列出的服务存在；其余 ctx.get 返回 undefined。 */
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
      if (deps.every((name) => available.includes(name))) callback(ctx)
    },
  }
  ctx.remote = available.includes('remote')
    ? { commands: available.includes('remote.commands') ? { execute: async () => ({}) } : undefined }
    : undefined
  ctx.uiWorkspace = available.includes('uiWorkspace') ? { forkSession: async () => ({}) } : undefined
  ctx.configForms = available.includes('configForms')
    ? { get: () => ({}), whileServed: () => () => {} }
    : undefined
  return { ctx, registered, available }
}

function applyOnce(entry, host) {
  const module = entry.factory((name) => {
    if (name === 'react') return { createElement: () => null, Fragment: 'Fragment', useState: (v) => [v, () => {}], useEffect: () => {}, useMemo: (f) => f(), useCallback: (f) => f, useRef: (v) => ({ current: v }) }
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return { Button: function Button() {}, Switch: function Switch() {} }
    throw new Error('unexpected require: ' + name)
  })
  // 与宿主 waitingFor 一致：正式依赖缺任一项时不调用 apply。
  if (!module.inject.every((name) => host.available.includes(name))) return { module, applied: false }
  module.apply(host.ctx)
  return { module, applied: true }
}

test('remote.commands 是正式依赖，不再通过新版门面无法转发的可选 inject 取得', async () => {
  const entry = await loadClient()
  const host = hostCtx({ available: ['slots', 'locale', 'remote', 'remote.commands'] })
  const { module } = applyOnce(entry, host)
  assert.deepEqual(module.inject, ['slots', 'locale', 'remote', 'remote.commands'])
  assert.equal(module.OPTIONAL_INJECTS.some((names) => names.includes('remote.commands')), false)
  assert.ok(module.OPTIONAL_INJECTS.some((names) => names.includes('uiWorkspace')))
})

test('宿主缺少 remote.commands 时保持 waiting，不渲染全部控制都禁用的面板', async () => {
  const entry = await loadClient()
  const host = hostCtx({ available: ['slots', 'locale', 'remote'] })
  const { applied } = applyOnce(entry, host)
  assert.equal(applied, false)
  assert.equal(host.registered.dictionaries.length, 0)
  assert.equal(host.registered.slots.length, 0)
})

test('正常宿主服务齐全时 chip 与面板装配，命令和可选工作区可用', async () => {
  const entry = await loadClient()
  const host = hostCtx({ available: ['slots', 'locale', 'remote', 'remote.commands', 'uiWorkspace', 'configForms'] })
  const { applied } = applyOnce(entry, host)
  assert.equal(applied, true)
  const slotNames = host.registered.slots.map((row) => row.name).filter(Boolean)
  assert.ok(slotNames.includes('conversation.input.left'))
  assert.ok(slotNames.includes('sidebar.panellist'))
  assert.ok(slotNames.includes('main'))
  assert.equal(host.registered.dictionaries.length, 1)
  const optionalNames = host.registered.optional.map((names) => names.join(','))
  assert.ok(optionalNames.includes('uiWorkspace'))
  assert.ok(optionalNames.includes('configForms'))
  assert.equal(optionalNames.includes('remote.commands'), false)
})
