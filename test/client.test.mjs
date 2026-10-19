/**
 * Tests for the browser half.
 *
 * The client bundle is plain JS with no build step, so it can be loaded and
 * exercised in Node against a minimal React shim. What matters here is not
 * pixel output but the contract: the loader id, the declared inject list, the
 * two slot registrations, the locale dictionary, and that neither component
 * throws when the host hands it nothing.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { TemporaryLingshuClient } from '../src/lingshu-lab-client.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const clientPath = path.join(here, '..', 'src', 'client.js')

/**
 * A minimal hook runtime: enough for the component subset the plugin uses
 * (`useState`, `useEffect`, `useRef`, `useMemo`, `useCallback`).
 *
 * It renders function components recursively the way React does, with a hook
 * scope per component type, so a popover nested inside the chip is exercised for
 * real instead of appearing as an opaque element. Effects run on first render of
 * their own component, which is what a mount does.
 */
function createReactShim() {
  const scopes = new Map()
  let current = null
  let pendingRerender = null

  function scopeFor(type) {
    let scope = scopes.get(type)
    if (!scope) {
      scope = { hooks: [], cursor: 0 }
      scopes.set(type, scope)
    }
    return scope
  }

  /** Allocate the next hook slot for the component currently rendering. */
  function hookSlot(initial) {
    const scope = current
    const index = scope.cursor++
    if (scope.hooks.length <= index) scope.hooks[index] = initial()
    return scope.hooks[index]
  }

  const React = {
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children: children.length ? children : undefined }
    },
    useState(initial) {
      const slot = hookSlot(() => ({ value: typeof initial === 'function' ? initial() : initial }))
      const set = (next) => {
        const value = typeof next === 'function' ? next(slot.value) : next
        if (Object.is(value, slot.value)) return
        slot.value = value
        if (pendingRerender) pendingRerender()
      }
      return [slot.value, set]
    },
    useEffect(fn) {
      const slot = hookSlot(() => ({ ran: false, cleanup: undefined }))
      if (!slot.ran) {
        slot.ran = true
        slot.cleanup = fn()
      }
      return slot.cleanup
    },
    useRef(initial) {
      return hookSlot(() => ({ current: initial }))
    },
    useMemo(fn) {
      return hookSlot(() => ({ value: fn() })).value
    },
    useCallback(fn) {
      return hookSlot(() => ({ value: fn })).value
    },
  }

  /**
   * Render one element tree. Function components are invoked with their own hook
   * scope; host elements keep their children under `children` only, so traversal
   * never double-counts.
   */
  function render(node) {
    if (node == null || typeof node !== 'object') return node
    if (Array.isArray(node)) return node.map(render)
    const props = { ...node.props }
    if (node.children !== undefined) {
      props.children = node.children.length === 1 ? node.children[0] : node.children
    }
    if (typeof node.type !== 'function') {
      return {
        type: node.type,
        props: node.props,
        children: node.children === undefined ? undefined : render(node.children),
      }
    }
    const previous = current
    const scope = scopeFor(node.type)
    scope.cursor = 0
    current = scope
    let output
    try {
      output = node.type(props)
    } finally {
      current = previous
    }
    return render(output)
  }

  return {
    React,
    /** Render a component, resetting hook order the way a fresh mount does. */
    mount(component, props) {
      const run = () => render({ type: component, props: props ?? {}, children: undefined })
      pendingRerender = run
      const tree = run()
      pendingRerender = null
      return tree
    },
  }
}

/** Load the client bundle exactly the way the browser module loader does. */
async function loadClient() {
  const source = await readFile(clientPath, 'utf8')
  const shim = createReactShim()
  let loaded = null
  const window = {
    __ModuleLoader__: {
      load(entry) {
        loaded = entry
        loaded.exports = entry.factory((name) => {
          if (name === 'react') return shim.React
          throw new Error(`unexpected require: ${name}`)
        })
      },
    },
  }
  // The bundle is an IIFE-style script that touches `window` only.
  const run = new Function('window', 'document', `${source}\n`)
  run(window, undefined)
  assert.ok(loaded, 'the bundle must call window.__ModuleLoader__.load')
  return { entry: loaded, shim, window }
}

/** Walk a rendered tree and collect every node whose type is a string. */
function collect(tree, predicate, out = []) {
  if (tree == null || typeof tree !== 'object') return out
  if (Array.isArray(tree)) {
    for (const item of tree) collect(item, predicate, out)
    return out
  }
  if (predicate(tree)) out.push(tree)
  collect(tree.children, predicate, out)
  if (tree.props && tree.props.children) collect(tree.props.children, predicate, out)
  return out
}

/** Text content of a rendered subtree. */
function textOf(tree) {
  if (tree == null) return ''
  if (typeof tree === 'string' || typeof tree === 'number') return String(tree)
  if (Array.isArray(tree)) return tree.map(textOf).join('')
  let text = ''
  if (tree.children) text += textOf(tree.children)
  if (tree.props && tree.props.children) text += textOf(tree.props.children)
  return text
}

/** A stub client context that records what the plugin registers. */
function createClientContext(options) {
  const slots = []
  const locales = []
  const listeners = []
  const configForms = options?.configForms ?? null
  // One shared face: the plugin prefers `ctx.get('remote')`, so a per-call object
  // would ignore anything a test installs on `ctx.remote`.
  const execute = options?.execute ?? (async () => ({ ok: true, value: { kind: 'success', text: 'ok' } }))
  const remote = { commands: { execute } }
  const context = {
    slots: {
      inject(name, register) {
        return register()
      },
      register(options, component) {
        slots.push({ options, component })
        return () => {}
      },
    },
    locale: {
      register(namespace, dictionaries) {
        locales.push({ namespace, dictionaries })
        return () => {}
      },
    },
    on(event, handler) {
      listeners.push({ event, handler })
      return () => {}
    },
    effect(fn) {
      const result = fn()
      return typeof result === 'function' ? result : () => {}
    },
    logger: { info() {}, warn() {}, error() {} },
    get(name) {
      if (name === 'remote') return remote
      if (name === 'configForms') return configForms
      return undefined
    },
    remote,
  }
  return { context, slots, locales, listeners, remote }
}

test('the bundle registers under the package name and declares its dependencies', async () => {
  const { entry } = await loadClient()
  assert.equal(entry.id, 'dsh-memory-context-lab')
  assert.equal(typeof entry.factory, 'function')
  assert.equal(typeof entry.exports.apply, 'function')
  assert.deepEqual(entry.exports.inject, ['slots', 'locale', 'remote', 'remote.commands', 'configForms'])
})

test('applying registers the settings-page card only while the namespace is served', async () => {
  const { entry, shim } = await loadClient()
  const served = []
  let registered = null
  const configForms = {
    whileServed(namespaces, fn) {
      served.push([...namespaces])
      // Registration happens only when the host serves the namespace.
      return fn()
    },
    get(id) {
      return {
        getSnapshot() {
          return { value: { defaults: {}, presets: [] }, revision: 0 }
        },
      }
    },
  }
  const first = createClientContext()
  first.context.slots.register = (options, component) => {
    if (options.name === 'plugins.row.config') registered = { options, component }
    return () => {}
  }
  entry.exports.apply(first.context)
  assert.equal(registered, null, 'no configForms -> no settings card')

  const second = createClientContext({ configForms })
  const rows = []
  second.context.slots.register = (options, component) => {
    rows.push({ options, component })
    return () => {}
  }
  entry.exports.apply(second.context)
  assert.deepEqual(served, [['memory-context-lab']])
  const card = rows.find((row) => row.options.name === 'plugins.row.config')
  assert.ok(card, 'served namespace -> plugins.row.config card registered')
  // Keyed-seat contract (plugins.row.config spec): `key` is `<package>#<rowId>`;
  // the plugin-list row is clickable only while this key exists, and the detail
  // page renderer passes { view: 'page', form } as props.
  assert.equal(card.options.key, 'dsh-memory-context-lab#memory-context-lab')
  assert.equal(typeof card.component, 'function')
  // The card component renders a summary line when no form prop is provided.
  // mount()（而非直调）提供 hook 作用域：卡片组件现在无条件调用 hooks（H1 修复），
  // 直接 component() 调用会在真实 React 与本 shim 下同样缺作用域。
  const summary = shim.mount(card.component, { view: 'summary' })
  const summaryText = textOf(summary)
  assert.ok(summaryText.length > 0)
  // 0.13.1（报告 B）：宿主描述行刻意不传 form，这是**正常形态**而不是
  // 「命名空间未服务」。原来的断言只要求文本非空，而误报文案恰好非空，
  // 于是这条用例在缺陷存在时也是绿的。现在改成否定断言。
  // 两条都要断言：**必须**走到摘要分支，且**不得**落到任何「未就绪」兜底。
  // 只断言「没有配置加载中」是不够的——把分支关掉后会落到另一句兜底文案，
  // 同样不含那句话，用例就会假绿（本用例第一次就是这么被骗过的）。
  assert.match(summaryText, /全局默认与预设/, `summary 必须渲染摘要行，实际：${summaryText}`)
  assert.equal(
    /配置加载中|Loading|尚未服务|尚未就绪/.test(summaryText),
    false,
    `summary 视图不得渲染加载/未就绪文案，实际：${summaryText}`,
  )
})

test('the settings card renders fields from both raw controllers and the thin form face', async () => {
  const { entry, shim } = await loadClient()
  const value = {
    defaults: { enabled: true, triggerLines: 10, batchThreshold: 3, autoRestore: true },
    presets: [{ id: 'p', name: '省流', triggerLines: 6, batchThreshold: 4, autoRestore: true }],
  }
  let registered = null
  const configForms = {
    whileServed(namespaces, fn) { return fn() },
    get(id) {
      return {
        getSnapshot() { return { value, revision: 3 } },
      }
    },
  }
  const ctxWrap = createClientContext({ configForms })
  ctxWrap.context.slots.register = (options, component) => {
    if (options.name === 'plugins.row.config') registered = { options, component }
    return () => {}
  }
  entry.exports.apply(ctxWrap.context)
  assert.ok(registered, 'card registered')

  // v0.6.0 插件管理页薄面：{ state: { value, revision }, mutate }（无 getSnapshot/subscribe）。
  let mutated = null
  const thin = { state: { value, revision: 3 }, mutate: (ops, rev) => { mutated = { ops, rev }; return Promise.resolve() } }
  const page = shim.mount(registered.component, { view: 'page', form: thin })
  const text = textOf(page)
  assert.ok(text.length > 0, 'thin face renders content')
  assert.ok(text.includes('默认') || text.includes('预设'), 'thin face shows settings sections')

  // 原始控制器形态（弹层/旧渲染器）同样能渲染：FakeForm 的 presets 为空数组，
  // 这里只断言不崩且有渲染内容，预设行由薄面用例覆盖。
  const rawPage = shim.mount(registered.component, { view: 'page', form: configForms.get('memory-context-lab') })
  assert.ok(textOf(rawPage).length > 0, 'raw controller renders without crashing')
})

test('applying registers exactly one composer seat, plus both dictionaries', async () => {
  const { entry } = await loadClient()
  const { context, slots, locales } = createClientContext()
  entry.exports.apply(context)

  assert.equal(slots.length, 1)
  const row = slots[0]
  assert.equal(row.options.name, 'conversation.input.left')
  // The loader id must be the package name; a slot id only has to be a stable,
  // unique label for the entry inside that slot.
  assert.equal(typeof row.options.id, 'string')
  assert.ok(row.options.id.length > 0)
  assert.equal(row.options.locale, 'memoryContextLab')
  assert.equal(typeof row.options.inject, 'function')
  assert.equal(typeof row.component, 'function')
  // The chip must sit next to the permission control, which is order 0-19.
  assert.ok(row.options.order >= 1)
  // Regression: the settings used to live in `conversation.composer.dock`, which
  // the host renders only in the composer variant. On a brand-new conversation
  // (hero variant) the chip was clickable but the panel never appeared, because
  // that seat does not exist there. Nothing may depend on it again.
  assert.equal(
    slots.some((entry2) => entry2.options.name === 'conversation.composer.dock'),
    false,
    'the panel must not depend on composer.dock, which hero variant does not render',
  )

  assert.equal(locales.length, 1)
  assert.equal(locales[0].namespace, 'memoryContextLab')
  const { zh, en } = locales[0].dictionaries
  assert.ok(zh && en, 'both dictionaries must be registered')
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort(), 'the dictionaries must share one key set')
  assert.ok(Object.keys(zh).length > 10)
  for (const [key, value] of Object.entries(zh)) assert.equal(typeof value, 'string', `${key} must be a string`)
})

test('the injected face exposes run() and reports a missing remote instead of throwing', async () => {
  const { entry } = await loadClient()
  const { context, slots } = createClientContext()
  entry.exports.apply(context)
  const face = slots[0].options.inject('session-1')
  assert.equal(typeof face.run, 'function')
  const result = await face.run('/memory-lab on')
  assert.equal(result.ok, true)
  assert.equal(result.text, 'ok')

  const bare = createClientContext()
  bare.context.remote = undefined
  bare.context.get = () => undefined
  entry.exports.apply(bare.context)
  const noRemote = await bare.slots[0].options.inject('session-1').run('/memory-lab on')
  assert.equal(noRemote.ok, false)
  assert.equal(noRemote.code, 'no-remote')
})

test('the injected face rejects an absent session and an empty line', async () => {
  const { entry } = await loadClient()
  const { context, slots } = createClientContext()
  entry.exports.apply(context)
  const face = slots[0].options.inject('session-1')
  assert.equal((await face.run('')).code, 'unknown-command')
  const noSession = await slots[0].options.inject(undefined).run('/memory-lab on')
  assert.equal(noSession.code, 'no-session')
})

test('the chip renders with no projection at all and never throws', async () => {
  const { entry, shim } = await loadClient()
  const { context, slots } = createClientContext()
  entry.exports.apply(context)
  const chip = slots.find((row) => row.options.name === 'conversation.input.left')
  const tree = shim.mount(chip.component, { useProjection: () => undefined, sessionId: 's1' })
  assert.ok(tree, 'the chip must render something')
  const buttons = collect(tree, (node) => node.type === 'button')
  assert.equal(buttons.length, 1, 'the chip is one button')
  assert.equal(buttons[0].props['aria-expanded'], false)
  assert.ok(textOf(tree).length > 0, 'the chip must carry a label')
})

test('the chip renders with a hostile projection and still produces valid values', async () => {
  const { entry, shim } = await loadClient()
  const { context, slots } = createClientContext()
  entry.exports.apply(context)
  const chip = slots.find((row) => row.options.name === 'conversation.input.left')
  const hostile = {
    enabled: 'yes',
    targetOccupancy: 'x',
    retainOperations: -5,
    releaseMarginRatio: 7,
    auto: 'on',
    autoRecall: null,
    archived: 'many',
    restored: undefined,
    revision: {},
  }
  const tree = shim.mount(chip.component, { useProjection: () => hostile, sessionId: 's1' })
  const button = collect(tree, (node) => node.type === 'button')[0]
  assert.ok(button)
  assert.equal(button.props['aria-expanded'], false, 'a hostile projection must not read as enabled')
  assert.equal(typeof button.props['aria-label'], 'string')
})

test('the chip reflects an enabled projection and a numeric archive count', async () => {
  const { entry, shim } = await loadClient()
  const { context, slots } = createClientContext()
  entry.exports.apply(context)
  const chip = slots[0]
  const view = { enabled: true, targetOccupancy: 0.6, retainOperations: 10, releaseMarginRatio: 0.05, auto: true, autoRecall: true, archived: 7, restored: 0, revision: 3 }
  const tree = shim.mount(chip.component, chipProps(view))
  const button = collect(tree, (node) => node.type === 'button')[0]
  assert.ok(textOf(tree).includes('7'), `the chip must show the archive count, got: ${textOf(tree)}`)
  assert.equal(button.props['aria-expanded'], false)
  // Enabled is expressed through colour, and the affordance is a rotating chevron.
  assert.equal(button.props['data-on'], 'true')
  assert.equal(collect(tree, (node) => node.type === 'svg').length, 1, 'the trigger carries one chevron')
  assert.ok(collect(tree, (node) => node.props && node.props.className === 'mcl-chip-chevron').length === 1)
})

/** Props a real seat receives: the projection hook plus the injected command face. */
function chipProps(view, overrides = {}) {
  return {
    useProjection: () => view,
    sessionId: 's1',
    run: async () => ({ ok: true, text: 'ok' }),
    ...overrides,
  }
}

/** The chip's own button, which toggles the popover. */
function chipButton(tree) {
  return collect(tree, (node) => node.type === 'button' && node.props && node.props.className === 'mcl-chip')[0]
}

function popovers(tree) {
  return collect(tree, (node) => node.props && node.props.className === 'mcl-pop')
}

test('clicking the chip opens the settings popover from the chip itself', async () => {
  const { entry, shim } = await loadClient()
  const { context, slots } = createClientContext()
  entry.exports.apply(context)
  const chip = slots[0]
  const view = { enabled: false, targetOccupancy: 0.6, retainOperations: 10, releaseMarginRatio: 0.05, auto: true, autoRecall: true, archived: 0, restored: 0, revision: 0 }

  // Closed: the popover is not mounted at all, so it holds no draft state.
  const closed = shim.mount(chip.component, chipProps(view))
  assert.equal(popovers(closed).length, 0, 'the popover must start closed')
  assert.equal(chipButton(closed).props['aria-expanded'], false)

  chipButton(closed).props.onClick({ preventDefault() {}, stopPropagation() {} })

  // After the click the same component renders the settings — with no dock seat
  // involved, which is what makes this work on a brand-new conversation too.
  const opened = shim.mount(chip.component, chipProps(view))
  assert.equal(popovers(opened).length, 1, 'the popover must open from the chip')
  assert.equal(chipButton(opened).props['aria-expanded'], true)

  const switches = collect(opened, (node) => node.props && node.props.role === 'switch')
  assert.ok(switches.length >= 3, `expected the enable and mode switches, got ${switches.length}`)
  for (const node of switches) {
    assert.ok(node.props['aria-label'], 'every switch needs an accessible name')
    assert.equal(typeof node.props['aria-checked'], 'boolean')
  }
  const inputs = collect(opened, (node) => node.type === 'input')
  assert.ok(inputs.length >= 2, 'the numeric settings must have inputs')
  for (const node of inputs) assert.ok(node.props['aria-label'], 'every input needs an accessible name')

  // Escape closes it again.
  const wrap = collect(opened, (node) => node.props && node.props.className === 'mcl-wrap')[0]
  assert.equal(typeof wrap.props.onKeyDown, 'function')
  wrap.props.onKeyDown({ key: 'Escape', preventDefault() {} })
  const afterEscape = shim.mount(chip.component, chipProps(view))
  assert.equal(popovers(afterEscape).length, 0, 'Escape must close the popover')
})

test('the stop-time restore switch is exposed, reflects the view, and sends its command', async () => {
  const { entry, shim } = await loadClient()
  const sent = []
  const { context, slots } = createClientContext()
  entry.exports.apply(context)
  const chip = slots[0]
  // The seat renders with the `run` prop the host injects; capture that line.
  const run = async (line) => { sent.push(line); return { ok: true, text: 'ok' } }
  const base = { enabled: true, targetOccupancy: 0.6, retainOperations: 10, releaseMarginRatio: 0.05, auto: true, autoRecall: true, restored: 0, revision: 1 }

  // On by default: a session that stops cooling should come back whole.
  const onView = { ...base, autoRestore: true, archived: 0 }
  chipButton(shim.mount(chip.component, chipProps(onView, { run }))).props.onClick({ preventDefault() {}, stopPropagation() {} })
  const opened = shim.mount(chip.component, chipProps(onView, { run }))
  // Either dictionary may be active in the shim, so accept both spellings.
  const labels = ['停用时恢复原文', 'Restore text when stopping']
  const node = collect(opened, (row) => row.props && labels.includes(row.props['aria-label']))[0]
  assert.ok(node, 'the panel must expose the stop-time restore switch')
  assert.equal(node.props['aria-checked'], true, 'the switch must reflect the projection')

  node.props.onClick({ preventDefault() {}, stopPropagation() {} })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.ok(
    sent.includes('/memory-lab set autorestore off'),
    `toggling off must send the command, sent: ${JSON.stringify(sent)}`,
  )

  // Off must render as off, not silently fall back to the default. The popover is
  // already open (the shim keeps hook state across mounts), so mounting is enough.
  const offView = { ...base, autoRestore: false, archived: 0 }
  const reopened = shim.mount(chip.component, chipProps(offView, { run }))
  const offNode = collect(reopened, (row) => row.props && labels.includes(row.props['aria-label']))[0]
  assert.ok(offNode, 'the switch must still render with an explicit false')
  assert.equal(offNode.props['aria-checked'], false, 'an explicit false must not read as the default')
})

test('0.13.0: the pressure gate switch sends 0 when off and the threshold when on', async () => {
  // 取代已删除的「全历史记忆上下文」开关：全历史现在是唯一模式，不再有开关。
  // 新的等价契约是压力闸门——关 = 写 0（无压力也降温），开 = 写阈值。
  const { entry, shim } = await loadClient()
  const sent = []
  const { context, slots } = createClientContext()
  entry.exports.apply(context)
  const chip = slots[0]
  const run = async (line) => { sent.push(line); return { ok: true, text: 'ok' } }
  const labels = ['压力闸门', 'Pressure gate']
  const base = { enabled: true, engine: 'v2', pressureGate: 20, archiveBatchSize: 10, autoRestore: true, archived: 0, restored: 0, revision: 1 }

  // 闸门开着（20%）：点「关」必须写 0，而不是删掉这一行。
  chipButton(shim.mount(chip.component, chipProps(base, { run }))).props.onClick({ preventDefault() {}, stopPropagation() {} })
  let opened = shim.mount(chip.component, chipProps(base, { run }))
  const onSwitch = collect(opened, (row) => row.props && labels.includes(row.props['aria-label']))[0]
  assert.ok(onSwitch, 'the panel must expose the pressure gate switch')
  assert.equal(onSwitch.props['aria-checked'], true, 'gate at 20% reads as on')
  onSwitch.props.onClick({ preventDefault() {}, stopPropagation() {} })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.ok(
    sent.includes('/memory-lab2 set pressure 0'),
    `turning the gate off must write 0, sent: ${JSON.stringify(sent)}`,
  )

  // 闸门关着（0）：点「开」必须写回默认阈值 20。
  sent.length = 0
  const offView = { ...base, pressureGate: 0 }
  opened = shim.mount(chip.component, chipProps(offView, { run }))
  const offSwitch = collect(opened, (row) => row.props && labels.includes(row.props['aria-label']))[0]
  assert.equal(offSwitch.props['aria-checked'], false, 'gate at 0 reads as off')
  offSwitch.props.onClick({ preventDefault() {}, stopPropagation() {} })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.ok(
    sent.includes('/memory-lab2 set pressure 20'),
    `turning the gate on must restore the default threshold, sent: ${JSON.stringify(sent)}`,
  )
})

test('0.13.1: v1 会话的闸门命令走 /memory-lab 前缀', async () => {
  // 报告 D：闸门是 v1/v2 共用的引擎判据（apply-engine.runAutoCooling），
  // 硬编码 /memory-lab2 会让 v1 会话的闸门开关必然失败。
  const { entry, shim } = await loadClient()
  const sent = []
  const { context, slots } = createClientContext()
  entry.exports.apply(context)
  const chip = slots[0]
  const run = async (line) => { sent.push(line); return { ok: true, text: 'ok' } }
  const labels = ['压力闸门', 'Pressure gate']
  const base = { enabled: true, engine: 'v1', pressureGate: 0, archiveBatchSize: 10, autoRestore: true, archived: 0, restored: 0, revision: 1 }
  chipButton(shim.mount(chip.component, chipProps(base, { run }))).props.onClick({ preventDefault() {}, stopPropagation() {} })
  const opened = shim.mount(chip.component, chipProps(base, { run }))
  const gateSwitch = collect(opened, (row) => row.props && labels.includes(row.props['aria-label']))[0]
  assert.ok(gateSwitch, 'v1 会话也必须渲染闸门开关')
  gateSwitch.props.onClick({ preventDefault() {}, stopPropagation() {} })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.ok(
    sent.includes('/memory-lab set pressure 20'),
    `v1 必须用 /memory-lab 前缀，实际发出：${JSON.stringify(sent)}`,
  )
  assert.equal(
    sent.some((line) => line.startsWith('/memory-lab2')),
    false,
    'v1 会话不得发出 v2 命令',
  )
})

test('B2: maintenance actions route to the v2 engine when it owns the projection', async () => {
  const { entry, shim } = await loadClient()
  const sent = []
  const { context, slots } = createClientContext()
  entry.exports.apply(context)
  const chip = slots[0]
  const run = async (line) => { sent.push(line); return { ok: true, text: 'ok' } }
  const base = { targetOccupancy: 0.6, retainOperations: 10, releaseMarginRatio: 0.05, auto: true, autoRecall: true, archived: 3, restored: 0, revision: 2 }

  // v2 会话：恢复/立即归档/预演改发 v2 同名命令，不再硬编码 v1（B2，c896f803）。
  const v2View = { ...base, enabled: true, engine: 'v2', fullHistory: true }
  chipButton(shim.mount(chip.component, chipProps(v2View, { run }))).props.onClick({ preventDefault() {}, stopPropagation() {} })
  const opened = shim.mount(chip.component, chipProps(v2View, { run }))
  // The action buttons carry no aria-label (only switches do); match by text.
  const byText = (labels) => collect(opened, (row) => row.type === 'button' && labels.includes(textOf(row)))[0]
  const restoreLabels = ['恢复原文', 'Restore text']
  const nowLabels = ['立即降温', 'Cool now']
  const dryRunLabels = ['预演', 'Dry run']
  for (const [labels, line] of [[restoreLabels, '/memory-lab2 restore'], [nowLabels, '/memory-lab2 now'], [dryRunLabels, '/memory-lab2 dry-run']]) {
    const node = byText(labels)
    assert.ok(node, `the panel must expose ${labels[0]}`)
    node.props.onClick({ preventDefault() {}, stopPropagation() {} })
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.ok(sent.includes(line), `${labels[0]} in a v2 session must send ${line}, sent: ${JSON.stringify(sent)}`)
  }

  // v1 会话照旧发 v1 命令（防误杀对照）。
  sent.length = 0
  const v1View = { ...base, enabled: true, engine: 'v1', fullHistory: false }
  const reopened = shim.mount(chip.component, chipProps(v1View, { run }))
  const restoreNode = collect(reopened, (row) => row.type === 'button' && restoreLabels.includes(textOf(row)))[0]
  restoreNode.props.onClick({ preventDefault() {}, stopPropagation() {} })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.ok(sent.includes('/memory-lab restore'), `a v1 session keeps the v1 command, sent: ${JSON.stringify(sent)}`)
})

test('the popover closes via the veil, not on inner focus loss or busy controls', async () => {
  const { entry, shim } = await loadClient()
  const { context, slots } = createClientContext()
  entry.exports.apply(context)
  const chip = slots[0]
  const view = { enabled: true, targetOccupancy: 0.6, retainOperations: 10, releaseMarginRatio: 0.05, auto: true, autoRecall: true, archived: 1, restored: 0, revision: 1 }
  chipButton(shim.mount(chip.component, chipProps(view))).props.onClick({ preventDefault() {}, stopPropagation() {} })
  const opened = shim.mount(chip.component, chipProps(view))
  const wrap = collect(opened, (node) => node.props && node.props.className === 'mcl-wrap')[0]

  // No blur-based collapse: controls disabling themselves mid-command must not
  // close the popover (the original "one click, one collapse" bug).
  assert.equal(wrap.props.onBlur, undefined, 'the wrap must not close on blur')
  assert.equal(popovers(shim.mount(chip.component, chipProps(view))).length, 1, 'no blur handler means it stays open')

  // The outside-click veil exists only while open and clicking it closes.
  const veils = (mount) => collect(mount, (node) => node.props && node.props.className === 'mcl-veil')
  assert.equal(veils(opened).length, 1, 'an open popover renders exactly one veil')
  veils(opened)[0].props.onClick({ preventDefault() {}, stopPropagation() {} })
  const closed = shim.mount(chip.component, chipProps(view))
  assert.equal(veils(closed).length, 0, 'closing unmounts the veil')
  assert.equal(popovers(closed).length, 0, 'closing via the veil collapses the popover')
})

test('every control in the popover is wired and does not throw', async () => {
  const { entry, shim } = await loadClient()
  const { context, slots } = createClientContext()
  entry.exports.apply(context)
  const chip = slots[0]
  const view = { enabled: true, targetOccupancy: 0.6, retainOperations: 10, releaseMarginRatio: 0.05, auto: true, autoRecall: true, archived: 1, restored: 0, revision: 1 }
  chipButton(shim.mount(chip.component, chipProps(view))).props.onClick({ preventDefault() {}, stopPropagation() {} })
  const opened = shim.mount(chip.component, chipProps(view))
  assert.equal(popovers(opened).length, 1)
  // Every interactive control must be wired; a broken handler would surface here.
  const clickables = collect(opened, (node) => typeof node.props?.onClick === 'function'
    && node.props.className !== 'mcl-chip')
  assert.ok(clickables.length >= 4, 'the action row must be wired')
  for (const node of clickables) {
    assert.doesNotThrow(() => node.props.onClick({ preventDefault() {}, stopPropagation() {} }))
  }
})

test('the batch threshold is a first-class panel control', async () => {
  const { entry, shim } = await loadClient()
  const { context, slots } = createClientContext()
  entry.exports.apply(context)
  const chip = slots[0]
  const sent = []
  const run = async (line) => { sent.push(line); return { ok: true, text: 'ok' } }
  const view = { enabled: true, targetOccupancy: 0.6, retainOperations: 10, archiveBatchSize: 10, releaseMarginRatio: 0.05, auto: true, autoRecall: true, archived: 1, restored: 0, revision: 1 }

  chipButton(shim.mount(chip.component, chipProps(view, { run }))).props.onClick({ preventDefault() {}, stopPropagation() {} })
  const opened = shim.mount(chip.component, chipProps(view, { run }))
  const labels = ['攒够几个再归档', 'Archive after N pile up']
  const node = collect(opened, (row) => row.props && labels.includes(row.props['aria-label']))[0]
  assert.ok(node, 'the panel must expose the batch threshold')
  assert.equal(node.props.value, '10', 'the field must show the projected value')

  // Editing and committing must send exactly one command with the parsed count.
  node.props.onChange({ target: { value: '25' } })
  const after = shim.mount(chip.component, chipProps(view, { run }))
  const edited = collect(after, (row) => row.props && labels.includes(row.props['aria-label']))[0]
  edited.props.onBlur({ target: { value: '25' } })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.ok(sent.includes('/memory-lab set batch 25'), `committing must send the command, sent: ${JSON.stringify(sent)}`)

  // A missing field must not blank the panel: the view default is 10.
  const noBatch = { ...view }
  delete noBatch.archiveBatchSize
  assert.doesNotThrow(() => shim.mount(chip.component, chipProps(noBatch, { run })))
})

test('the chip tolerates a missing useProjection and a throwing one', async () => {
  const { entry, shim } = await loadClient()
  const { context, slots } = createClientContext()
  entry.exports.apply(context)
  const chip = slots[0]
  const view = { enabled: false, targetOccupancy: null, retainOperations: 0, releaseMarginRatio: 0, auto: false, autoRecall: false, archived: 0, restored: 0, revision: 0 }
  chipButton(shim.mount(chip.component, chipProps(view))).props.onClick({ preventDefault() {}, stopPropagation() {} })

  assert.doesNotThrow(() => shim.mount(chip.component, chipProps(null, { useProjection: () => { throw new Error('boom') } })))
  assert.doesNotThrow(() => shim.mount(chip.component, { sessionId: 's1', run: async () => ({ ok: true, text: 'ok' }) }))
})

test('the trigger is borderless and matches the permission selector trigger', async () => {
  // The permission selector next door is a transparent, borderless 28px trigger;
  // an added frame around our chip reads as a different kind of control.
  const raw = await readFile(clientPath, 'utf8')
  const rule = /\.mcl-chip\{([^}]*)\}/.exec(raw)
  assert.ok(rule, 'the chip rule must exist')
  const body = rule[1]
  assert.ok(/background:0 0/.test(body), 'the trigger must not paint a box')
  assert.ok(/border:none/.test(body), 'the trigger must be borderless')
  assert.ok(/outline:none/.test(body), 'the trigger must not draw an outline box')
  assert.ok(/height:28px/.test(body), 'same height as the permission trigger')
  assert.ok(/var\(--dsw-alias-label-secondary\)/.test(body), 'same label colour as the permission trigger')
  assert.ok(/var\(--dsw-radius-sm\)/.test(body), 'same radius as the permission trigger')
  assert.ok(/var\(--dsw-alias-interactive-bg-hover\)/.test(raw), 'hover must use the shared hover token')
  assert.ok(/box-shadow:0 0 0 2px var\(--dsw-focus-ring-color/.test(raw), 'focus must use the ring, not an outline')

  // Enabled state is expressed by colour only; no filled or framed state returns.
  assert.ok(/\.mcl-chip\[data-on='true'\]\{color:/.test(raw), 'enabled must be colour-only')
  assert.equal(/mcl-chip\[data-on='true'\]\{[^}]*background/.test(raw), false, 'enabled must not add a fill')
  assert.equal(/mcl-chip\[data-open='true'\]\{[^}]*box-shadow/.test(raw), false, 'open must not add a frame')

  // The popover is anchored to the chip, not laid out in the composer flow.
  const pop = /\.mcl-pop\{([^}]*)\}/.exec(raw)
  assert.ok(pop, 'the popover rule must exist')
  assert.ok(/position:absolute/.test(pop[1]), 'the popover must be anchored')
  assert.ok(/bottom:calc\(100% \+ 8px\)/.test(pop[1]), 'the popover must open upward from the trigger')
})

test('the client bundle never touches the DOM or globals it should not', async () => {
  const raw = await readFile(clientPath, 'utf8')
  // Strip comments: the file documents these rules in prose, and prose is not a
  // violation.
  const source = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  assert.equal(/\bdocument\s*\./.test(source), false, 'no direct DOM access')
  assert.equal(/setInterval\s*\(/.test(source), false, 'no timers')
  assert.equal(/window\s*\.\s*addEventListener/.test(source), false, 'no window listeners')
  assert.equal(/require\(\s*['"]@deepseek-ai/.test(source), false, 'no host client package requires')
  // Only the allowed token prefixes may appear in styles.
  const tokens = [...source.matchAll(/var\((--dsw-[a-z0-9-]+)/g)].map((match) => match[1])
  assert.ok(tokens.length > 0, 'the styles must use theme tokens')
  for (const token of tokens) {
    assert.ok(/^--dsw-(alias|radius|focus-ring)/.test(token), `disallowed token ${token}`)
  }
})

// ── TemporaryLingshuClient commit semantics ────────────────────────────────
// The isolated daemon answers a plain ok:false or an
// `ok:true, committed:false, moved_to:'review_queue'` as result FIELDS, not as
// MCP error text. A lenient client would sail into the read-back step and
// report a confusing hash mismatch for a write that never landed (the 317fd313
// forensics failure). The client must surface both as explicit write failures.

class StubBridge {
  constructor(answer) {
    this.answer = answer
    this.calls = []
  }

  async request(method, params) {
    this.calls.push({ method, params })
    return { content: [{ type: 'text', text: JSON.stringify(this.answer) }], isError: false }
  }
}

test('rememberArchived treats ok:false as an explicit cold-write failure', async () => {
  const bridge = new StubBridge({ ok: false, error: 'write_limit', hint: 'не写' })
  const client = new TemporaryLingshuClient({ bridge, sessionId: 'session-test-1' })
  await assert.rejects(
    client.rememberArchived({ nodeId: 'n', text: 'x', range: { start: 1, end: 2 }, tools: ['read'], callIds: ['c'] }),
    /冷库拒收写入/,
  )
})

test('rememberArchived treats committed:false (queued, not stored) as a failure', async () => {
  // The observed daemon behavior: an existing node id receiving a different
  // body answers ok:true but moved_to review_queue with committed:false.
  const bridge = new StubBridge({ ok: true, committed: false, moved_to: 'review_queue', pid: 'prop_x', mutation: { action: 'C' } })
  const client = new TemporaryLingshuClient({ bridge, sessionId: 'session-test-2' })
  await assert.rejects(
    client.rememberArchived({ nodeId: 'n', text: 'x', range: { start: 1, end: 2 }, tools: ['read'], callIds: ['c'] }),
    /冷库未提交写入/,
  )
})

test('rememberArchived passes a committed write through', async () => {
  const bridge = new StubBridge({ ok: true, committed: true, id: 'n' })
  const client = new TemporaryLingshuClient({ bridge, sessionId: 'session-test-3' })
  const result = await client.rememberArchived({ nodeId: 'n', text: 'x', range: { start: 1, end: 2 }, tools: ['read'], callIds: ['c'] })
  assert.deepEqual(result, { ok: true, committed: true, id: 'n' })
})
