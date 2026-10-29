/**
 * composer 面板（chip + 弹层）与会话控制守卫（0.14.0-beta.17）。
 *
 * 0.14.0-beta.16 的弹层把五项**全局**设置搬到了 composer，方向错了：
 * 全局默认应在插件设置页，composer 只改**本对话**——启用/停用、自动摄入/自动回注、
 * 以及少量数值覆盖（未填 = 跟随全局）。
 *
 * 钉住：
 * - 槽位 conversation.input.left；id/order；slots.inject；
 * - chip 文案来自投影；弹层显示 status.control；
 * - 开关走 /memory-lab on|off / inject；数字走 set limit / unset limit（带取值域校验）；
 * - 无 remote 时控件禁用并说明；坏投影不崩；
 * - 宿主侧：会话控制文件原子读写、非法值失败关闭、摄入钩子按控制短路、命令面可写。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { createStatusProjectionDefinition, STATUS_PROJECTION_KEY, STATUS_PROJECTION_VERSION } from '../src/v3/adapters/host/status-projection.mjs'
import { attachV3Engine } from '../src/v3/entry/v3-entry.mjs'
import { SESSION_OVERRIDE_BOUNDS, mergeSessionSettings, normalizeSessionControl, patchSessionControl } from '../src/v3/domain/session/session-control.mjs'
import { readSessionControl, sessionControlPath, writeSessionControl } from '../src/v3/adapters/storage/session-control.mjs'

const SRC = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(SRC, '..')
const PKG = path.join(ROOT, 'package.json')
const ENTRY = path.join(ROOT, 'src', 'index.mjs')
const CLIENT = path.join(ROOT, 'src', 'client.js')

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
  assert.equal(registered.length, 1, '浏览器半必须恰好自注册一次')
  return registered[0]
}

/** 极简 React 替身：按组件隔离 hooks；只渲染传入的顶层组件（嵌套组件由测试单独 bind）。 */
function createFakeReact() {
  const hookStore = new Map()
  let current = null
  let index = 0
  let pendingEffects = []
  let depth = 0
  let rerenderRequested = false
  let target = null
  const hooksOf = (component) => {
    if (!hookStore.has(component)) hookStore.set(component, [])
    return hookStore.get(component)
  }
  const React = {
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children: children.length === 1 ? children[0] : children }
    },
    useState(initial) {
      const hooks = hooksOf(current)
      const slot = index++
      if (hooks.length <= slot) hooks[slot] = { value: typeof initial === 'function' ? initial() : initial, deps: undefined }
      const state = hooks[slot]
      const set = (next) => {
        state.value = typeof next === 'function' ? next(state.value) : next
        if (depth > 0) rerenderRequested = true
        else if (target !== null) target()
      }
      return [state.value, set]
    },
    useEffect(fn, deps) {
      const hooks = hooksOf(current)
      const slot = index++
      pendingEffects.push({ slot, fn, deps, hooks })
    },
  }
  function render(component, props) {
    let tree
    let rounds = 0
    const previousCurrent = current
    current = component
    depth += 1
    try {
      do {
        rerenderRequested = false
        index = 0
        pendingEffects = []
        tree = component(props)
        for (const effect of pendingEffects) {
          const previous = effect.hooks[effect.slot]
          const same = previous !== undefined && previous.deps !== undefined && effect.deps !== undefined
            && previous.deps.length === effect.deps.length
            && previous.deps.every((value, i) => Object.is(value, effect.deps[i]))
          if (same) continue
          const cleanup = previous?.cleanup
          if (typeof cleanup === 'function') cleanup()
          effect.hooks[effect.slot] = { ...previous, deps: effect.deps, cleanup: effect.fn() }
        }
        rounds += 1
      } while (rerenderRequested && rounds < 20)
    } finally {
      depth -= 1
      current = previousCurrent
    }
    return tree
  }
  function bind(component, props) {
    let tree = null
    target = () => { tree = render(component, props) }
    tree = render(component, props)
    return { get: () => tree }
  }
  return { React, bind }
}

function findElement(node, predicate) {
  if (node === null || node === undefined) return undefined
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findElement(child, predicate)
      if (hit !== undefined) return hit
    }
    return undefined
  }
  if (typeof node !== 'object') return undefined
  if (predicate(node)) return node
  return findElement(node.children, predicate) ?? findElement(node.props?.children, predicate)
}

function tOf(key, vars) {
  if (vars === undefined) return key
  return key + ' ' + Object.entries(vars).map(([name, value]) => name + '=' + String(value)).join(',')
}

const READY_STATUS = {
  state: 'ready', ingested: 12, searchable: 9, lastSeq: 8, ingesting: false,
  mode: 'recall-only',
  planFirst: false,
  surface: { lastArchiveEndSeq: 120 },
  attempted: 4, injected: 3, skipped: 1, failed: 0,
  lastStatus: 'injected', lastReason: null, lastInjectedAt: 1, lastErrorCode: null, errorCode: null,
  control: {
    enabled: true, recall: true,
    // 真实投影的形状（beta.45 起 overrides 与 SESSION_OVERRIDE_KEYS 同源，恒含两键）。
    overrides: { limit: null, gate: null },
    error: null,
  },
}

function runApply(entry, options = {}) {
  const { React, bind } = createFakeReact()
  const slotInjects = []
  const slots = []
  const optionalInjects = []
  const dictionaries = []
  const commands = []
  const remote = {
    commands: {
      async execute(sessionId, line, args) {
        commands.push({ sessionId, line, args })
        // 真实 remote.commands.execute 返回 CommandExecution：{ commandId, result: { kind, text } }。
        // 旧 runLine 只读 value.text，导致面板所有按钮都显示“已更新”；此处锁真实形状。
        if (typeof options.failLine === 'string' && line === options.failLine) {
          return { commandId: 'cmd-1', result: { kind: 'error', text: 'T2 未启用（测试注入）' } }
        }
        return { commandId: 'cmd-1', result: { kind: 'success', text: 'ok' } }
      },
    },
  }
  // 模拟客户端动态门面：未声明 remote.commands 时，受保护代理的 commands
  // 读取会抛错。旧 remoteOf 把代理当有效 remote 返回，弹层 render 直接崩。
  const guardedRemote = new Proxy({}, {
    get(_target, prop) {
      if (prop === 'commands') throw new Error('cannot get property "remote.commands" without inject')
      return undefined
    },
  })
  const remoteFace = options.remoteGuard === true
    ? guardedRemote
    : (options.remote === false ? undefined : remote)
  const form = {
    getSnapshot: () => ({ status: 'ready', value: {}, user: {}, revision: 1, writable: true }),
    subscribe: () => () => {},
    mutate: async () => true,
  }
  const ctx = {
    effect(fn) { const disposer = fn(); return () => { if (typeof disposer === 'function') disposer() } },
    locale: { register(ns, dict) { dictionaries.push({ ns, dict }); return () => {} } },
    slots: {
      inject(name, register) { slotInjects.push({ name, register }); register() },
      register(registration, component) { slots.push({ registration, component }); return () => {} },
    },
    inject(deps, callback) {
      optionalInjects.push([...deps])
      if (deps.includes('configForms') && options.configForms !== false) callback(ctx)
    },
    get(name) {
      if (name === 'remote') return remoteFace
      return undefined
    },
    remote: remoteFace,
    configForms: {
      get: () => form,
      whileServed(namespaces, register) { return register(new Set(namespaces)) ?? (() => {}) },
    },
  }
  const module = entry.factory((name) => {
    if (name === 'react') return React
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return { Button() {}, Switch() {} }
    throw new Error('客户端不得 require 平台基线表之外的模块：' + name)
  })
  module.apply(ctx)
  const chip = slots.find((row) => row.registration.name === module.CHIP_SLOT)
  return { module, React, bind, slotInjects, slots, chip, optionalInjects, dictionaries, commands }
}

/** 打开 chip，返回弹层组件与其 props。 */
function openPanel(run, props = {}, status = READY_STATUS) {
  const chip = run.bind(run.chip.component, { t: tOf, useProjection: () => status, sessionId: 's-1', ...props })
  findElement(chip.get(), (node) => node.type === 'button' && node.props?.className === 'mcl-chip').props.onClick()
  const pop = findElement(chip.get(), (node) => node.props?.key === 'pop')
  assert.ok(pop, '点击 chip 必须渲染弹层')
  return pop
}

test('manifest / 常量：chip 槽位、remote 依赖与投影 key 成对', async () => {
  const manifest = JSON.parse(await readFile(PKG, 'utf8'))
  const inject = manifest.dsh?.client?.inject ?? []
  assert.ok(inject.includes('@deepseek-ai/dsh-client-ui-conversation'))
  assert.equal(inject.includes('@deepseek-ai/dsh-api-remotes'), false,
    'remote 由其它客户端包提供；api-remotes 是图依赖，不是 H-103 的解法（根因是客户端 inject 未声明 remote.commands）')
  const entry = await loadClient()
  const { module } = runApply(entry)
  assert.equal(module.CHIP_SLOT, 'conversation.input.left')
  assert.equal(module.CHIP_ID, 'memory-context-lab')
  assert.equal(module.CHIP_ORDER, 20)
  assert.equal(module.PROJECTION_KEY, STATUS_PROJECTION_KEY)
  assert.ok(module.inject.includes('remote.commands'),
    'remote.commands 必须写进客户端 inject：动态门面按 inject 判权，未声明时 ctx.remote.commands 会抛 cannot get property ... without inject')
  assert.ok(module.inject.includes('remote'), 'remote 根服务与宿主命令插件同样声明')
})

test('locale 字典：zh/en 键集必须逐键一致（缺键会让 locale.register 抛错、整个客户端半不挂）', async () => {
  const entry = await loadClient()
  const run = runApply(entry)
  const dict = run.dictionaries[0].dict
  assert.deepEqual(Object.keys(dict.zh).sort(), Object.keys(dict.en).sort())
})

test('会话覆盖项 ⊆ 全局设置页字段：limit 同域（命令改的全局项也必须能在设置页改）', async () => {
  const entry = await loadClient()
  const { module } = runApply(entry)
  assert.deepEqual(Object.keys(SESSION_OVERRIDE_BOUNDS), ['limit', 'gate'],
    'composer 只保留「本对话条数」与「按步归档闸门」两项数值；底层参数只在设置页')
  const field = module.FIELDS.find((row) => row.key === 'limit')
  assert.ok(field, '全局设置页必须能改 limit')
  assert.equal(SESSION_OVERRIDE_BOUNDS.limit.min, field.min)
  assert.equal(SESSION_OVERRIDE_BOUNDS.limit.max, field.max)
  assert.equal(SESSION_OVERRIDE_BOUNDS.limit.integer, field.kind === 'number')
  // 闸门：会话覆盖项与全局设置页字段同域；只在「按步归档」下出现在弹层。
  const gateField = module.FIELDS.find((row) => row.key === 'coolingGate')
  assert.ok(gateField, '设置页必须能改按步归档闸门')
  assert.equal(SESSION_OVERRIDE_BOUNDS.gate.min, gateField.min)
  assert.equal(SESSION_OVERRIDE_BOUNDS.gate.max, gateField.max)
  assert.equal(SESSION_OVERRIDE_BOUNDS.gate.integer, gateField.kind === 'number')
  const gateOverride = module.SESSION_OVERRIDE_FIELDS.find((row) => row.key === 'gate')
  assert.equal(gateOverride.onlyWhen, 'cooling', '闸门只在按步归档下显示')
})

test('apply：chip 走 slots.inject；configForms 仍是设置页的可选依赖', async () => {
  const entry = await loadClient()
  const run = runApply(entry)
  assert.deepEqual(run.module.inject, ['slots', 'locale', 'remote', 'remote.commands', 'uiWorkspace'])
  assert.deepEqual(run.optionalInjects, [['configForms']])
  assert.deepEqual(run.slotInjects.map((row) => row.name), ['conversation.input.left', 'sidebar.panellist', 'main'])
  const sidebar = run.slots.find((row) => row.registration.name === 'sidebar.panellist')
  assert.equal(sidebar.registration.id, 'memory-context-lab')
  const main = run.slots.find((row) => row.registration.name === 'main')
  assert.equal(main.registration.key, 'memory-context-lab')
  assert.ok(run.chip)
  assert.equal(run.chip.registration.id, 'memory-context-lab')
  assert.equal(run.chip.registration.order, 20)
})

test('chip：投影缺失/ready 的文案；点击打开弹层并带 sessionId', async () => {
  const entry = await loadClient()
  const run = runApply(entry)
  const empty = run.bind(run.chip.component, { t: tOf, useProjection: () => undefined, sessionId: 's-1' })
  assert.equal(findElement(empty.get(), (node) => node.props?.className === 'mcl-chip-label').children, 'chipLabel')
  assert.doesNotThrow(() => run.chip.component({ t: tOf, sessionId: 's-1' }))

  const ready = run.bind(run.chip.component, { t: tOf, useProjection: () => READY_STATUS, sessionId: 's-1' })
  // chip 优先显示「可检索」：9 才是真正能检索到的条数，12 是已摄入（含 metadata-only）。
  assert.equal(findElement(ready.get(), (node) => node.props?.className === 'mcl-chip-label').children, 'chipLabelCoverage count=9')
  // 索引未知时退回已摄入数（不显示 0，也不留空）。
  const noIndex = run.bind(run.chip.component, { t: tOf, useProjection: () => ({ ...READY_STATUS, searchable: null }), sessionId: 's-1' })
  assert.equal(findElement(noIndex.get(), (node) => node.props?.className === 'mcl-chip-label').children, 'chipLabelCount count=12')
  const pop = openPanel(run)
  assert.equal(pop.props.sessionId, 's-1')
  assert.equal(pop.props.status, READY_STATUS)
})

test('弹层：本对话三个开关走 /memory-lab 命令', async () => {
  const entry = await loadClient()
  const run = runApply(entry)
  const pop = openPanel(run)
  const panel = run.bind(pop.type, pop.props)
  const switchOf = (field) => {
    const row = findElement(panel.get(), (node) => node.props?.['data-mcl-field'] === field)
    return findElement(row, (node) => node.props?.role === 'switch')
  }
  const fields = []
  const collect = (node) => {
    if (node === null || node === undefined) return
    if (Array.isArray(node)) { node.forEach(collect); return }
    if (typeof node !== 'object') return
    if (node.props?.['data-mcl-field'] !== undefined) fields.push(node.props['data-mcl-field'])
    collect(node.children)
    collect(node.props?.children)
  }
  collect(panel.get())
  assert.deepEqual(fields.sort(), ['override.limit', 'session.enabled', 'session.mode', 'session.planfirst', 'session.recall'],
    'composer 保留本对话五项（模式切换入口）；底层参数（装包阈/首部/查询上限）不得出现')

  switchOf('session.enabled').props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  switchOf('session.recall').props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  switchOf('session.planfirst').props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(run.commands.map((row) => row.line), [
    '/memory-lab off',
    '/memory-lab inject off',
    '/memory-lab planfirst on',
  ])
})

test('弹层：计划先行开启时给「批准计划」，走 approve 而不是再 toggle', async () => {
  const entry = await loadClient()
  const run = runApply(entry)
  const pop = openPanel(run, {}, { ...READY_STATUS, planFirst: true })
  const panel = run.bind(pop.type, pop.props)
  const approve = findElement(panel.get(), (node) => node.type === 'button' && node.props?.className === 'mcl-btn' && node.children === 'approvePlan')
  assert.ok(approve, '计划先行开启后必须有批准按钮（approve 要写冻结边界，不能只靠开关）')
  approve.props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(run.commands.map((row) => row.line), ['/memory-lab planfirst approve'])
  assert.equal(findElement(panel.get(), (node) => node.props?.className === 'mcl-hint' && node.children === 'overrideHint'), undefined,
    '未填=... 这类说明文案应从弹层移除')
})


test('弹层：宿主计划模式（plan 投影）与插件的计划先行分开展示，且只读', async () => {
  const entry = await loadClient()
  const run = runApply(entry)
  const pop = openPanel(run, {
    useProjection: (key) => (key === 'plan' ? { active: true } : READY_STATUS),
  })
  const panel = run.bind(pop.type, pop.props)
  const hint = findElement(panel.get(), (node) => node.props?.['data-mcl-field'] === 'host.plan')
  assert.ok(hint, '宿主计划模式开着时必须说明它不是插件的计划先行（否则会被当成插件擅自开计划模式）')
  assert.equal(hint.props.role, undefined, '提示只读：计划模式归宿主，插件不替用户切换')
  assert.equal(hint.children, 'hostPlanOn')

  const run2 = runApply(entry)
  const pop2 = openPanel(run2, {
    useProjection: (key) => (key === 'plan' ? { active: false } : READY_STATUS),
  })
  const panel2 = run2.bind(pop2.type, pop2.props)
  assert.equal(findElement(panel2.get(), (node) => node.props?.['data-mcl-field'] === 'host.plan'), undefined,
    '宿主计划模式关着时不要多一行噪音')
})

test('文案：未摄入必须给出下一步动作（发一条消息后开始）', async () => {
  const entry = await loadClient()
  const run = runApply(entry)
  const dict = run.dictionaries[0].dict
  assert.match(dict.zh.statusAbsent, /消息/)
  assert.match(dict.en.statusAbsent, /send a message/i)
})

test('弹层：模式选择先确认再写 /memory-lab mode，取消不发命令', async () => {
  const entry = await loadClient()
  const run = runApply(entry)
  const pop = openPanel(run, {}, { ...READY_STATUS, mode: 'recall-only' })
  const panel = run.bind(pop.type, pop.props)
  const selectOf = () => findElement(panel.get(), (node) => node.type === 'select' && node.props?.['data-mcl-mode'] === true)
  assert.ok(selectOf(), '旧 recall-only 会话必须有切模式的入口（否则只能去敲命令）')
  assert.equal(selectOf().props.value, 'recall-only')

  selectOf().props.onChange({ target: { value: 'full-history' } })
  assert.equal(run.commands.length, 0, '选择模式后必须先确认：归档会改变模型可见表面')
  const confirm = findElement(panel.get(), (node) => node.props?.['data-mcl-mode-confirm'] === true)
  assert.ok(confirm, '确认块必须出现')
  assert.ok(findElement(panel.get(), (node) => typeof node.children === 'string' && node.children === 'modeWarning'),
    '确认块必须给出「只影响之后的归档 / restore all 仍可用」的提示')
  // 按钮靠右：动作行用 mcl-actions（justify-content:flex-end），不能退回浏览器默认排布。
  assert.ok(findElement(panel.get(), (node) => node.props?.className === 'mcl-actions'), '确认/取消必须放在靠右的动作行里')
  confirm.props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(run.commands.map((row) => row.line), ['/memory-lab mode full-history'])
  assert.equal(selectOf().props.value, 'full-history', '成功后本地保持新模式，不等投影刷新')

  // 取消：不发命令，选择器保持原模式（另开一个弹层，避免沿用已切换的本地状态）。
  const run2 = runApply(entry)
  const pop2 = openPanel(run2, {}, { ...READY_STATUS, mode: 'recall-only' })
  const panel2 = run2.bind(pop2.type, pop2.props)
  const select2 = () => findElement(panel2.get(), (node) => node.type === 'select' && node.props?.['data-mcl-mode'] === true)
  select2().props.onChange({ target: { value: 'cooling' } })
  findElement(panel2.get(), (node) => node.props?.['data-mcl-mode-cancel'] === true).props.onClick()
  assert.equal(run2.commands.length, 0, '取消不得发命令')
  assert.equal(select2().props.value, 'recall-only', '取消后选择器回到投影模式')
})

test('弹层：没有已归档历史时切模式直接生效，不弹确认', async () => {
  const entry = await loadClient()
  const run = runApply(entry)
  const pop = openPanel(run, {}, { ...READY_STATUS, mode: 'recall-only', surface: { lastArchiveEndSeq: -1 } })
  const panel = run.bind(pop.type, pop.props)
  const selectOf = () => findElement(panel.get(), (node) => node.type === 'select' && node.props?.['data-mcl-mode'] === true)
  selectOf().props.onChange({ target: { value: 'full-history' } })
  assert.equal(findElement(panel.get(), (node) => node.props?.['data-mcl-mode-confirm'] === true), undefined,
    '没有已归档历史时确认块是纯噪音：切换不撤销任何东西')
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(run.commands.map((row) => row.line), ['/memory-lab mode full-history'], '直接写命令，不经过确认')
})

test('弹层：按步归档压过历史（lastArchiveAt 有值、lastArchiveEndSeq=-1）也必须弹确认', async () => {
  const entry = await loadClient()
  const run = runApply(entry)
  const pop = openPanel(run, {}, { ...READY_STATUS, mode: 'recall-only', surface: { lastArchiveEndSeq: -1, lastArchiveAt: 1700000000000 } })
  const panel = run.bind(pop.type, pop.props)
  const selectOf = () => findElement(panel.get(), (node) => node.type === 'select' && node.props?.['data-mcl-mode'] === true)
  selectOf().props.onChange({ target: { value: 'full-history' } })
  assert.ok(findElement(panel.get(), (node) => node.props?.['data-mcl-mode-confirm'] === true),
    '按步归档不推进 lastArchiveEndSeq，不能用它单独判断「没归档过」')
})

test('弹层：模式切换失败必须回滚选择器并显示命令回执', async () => {
  const entry = await loadClient()
  const run = runApply(entry, { failLine: '/memory-lab mode full-history' })
  const pop = openPanel(run, {}, { ...READY_STATUS, mode: 'recall-only' })
  const panel = run.bind(pop.type, pop.props)
  const selectOf = () => findElement(panel.get(), (node) => node.type === 'select' && node.props?.['data-mcl-mode'] === true)
  selectOf().props.onChange({ target: { value: 'full-history' } })
  findElement(panel.get(), (node) => node.props?.['data-mcl-mode-confirm'] === true).props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(selectOf().props.value, 'recall-only', '命令失败后不得谎报已切换')
  const error = findElement(panel.get(), (node) => node.props?.className === 'mcl-error')
  assert.match(error.children, /commandFailed/, '失败必须显示命令回执文本')
  assert.match(error.children, /T2 未启用/, '回执必须带真实命令返回文本')
})

test('弹层：数值覆盖 set/unset；越界不发命令', async () => {
  const entry = await loadClient()
  const run = runApply(entry)
  const pop = openPanel(run)
  const panel = run.bind(pop.type, pop.props)
  const inputOf = () => findElement(panel.get(), (node) => node.type === 'input' && node.props?.['data-mcl-override'] === 'limit')

  inputOf().props.onChange({ target: { value: '12' } })
  inputOf().props.onBlur()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(run.commands.at(-1).line, '/memory-lab set limit 12')

  inputOf().props.onChange({ target: { value: '' } })
  inputOf().props.onBlur()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(run.commands.at(-1).line, '/memory-lab unset limit')

  const before = run.commands.length
  inputOf().props.onChange({ target: { value: '99' } })
  inputOf().props.onBlur()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(run.commands.length, before, '越界不得发命令')
  assert.match(findElement(panel.get(), (node) => node.props?.className === 'mcl-error').children, /invalid/)
})

test('弹层：按步归档下闸门覆盖值必须回显，清空即 unset（AUD-01 界面端）', async () => {
  const entry = await loadClient()
  const run = runApply(entry)
  const cooling = {
    ...READY_STATUS,
    mode: 'cooling',
    control: { enabled: true, recall: true, overrides: { limit: null, gate: 5 }, error: null },
  }
  const pop = openPanel(run, {}, cooling)
  const panel = run.bind(pop.type, pop.props)
  const inputOf = () => findElement(panel.get(), (node) => node.type === 'input' && node.props?.['data-mcl-override'] === 'gate')
  assert.ok(inputOf(), '按步归档下必须渲染闸门输入行')
  assert.equal(inputOf().props.value, '5',
    '会话级 gate 必须回显：空白 + 占位「跟随全局」= AUD-01 的用户可见症状')
  assert.equal(inputOf().props.placeholder, 'overridePlaceholder')

  inputOf().props.onChange({ target: { value: '' } })
  inputOf().props.onBlur()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(run.commands.at(-1).line, '/memory-lab unset gate', '输入框为空时失焦必须能真正清除覆盖')
})

test('弹层：无 remote 时控件禁用并说明，不抛错', async () => {
  const entry = await loadClient()
  const run = runApply(entry, { remote: false })
  const pop = openPanel(run)
  const panel = run.bind(pop.type, pop.props)
  assert.equal(findElement(panel.get(), (node) => node.props?.role === 'switch').props.disabled, true)
  assert.equal(findElement(panel.get(), (node) => node.type === 'input').props.disabled, true)
  assert.ok(findElement(panel.get(), (node) => typeof node.children === 'string' && node.children === 'remoteUnavailable'))
})

test('弹层：受保护 remote 代理拒绝 commands 时不崩（H-103 回归）', async () => {
  const entry = await loadClient()
  const run = runApply(entry, { remoteGuard: true })
  const pop = openPanel(run)
  assert.doesNotThrow(() => run.bind(pop.type, pop.props),
    '未注入 remote.commands 时，代理读取 commands 会抛错；弹层必须降级为禁用，而不是让 SlotErrorBoundary 摘掉 chip')
  const panel = run.bind(pop.type, pop.props)
  assert.equal(findElement(panel.get(), (node) => node.props?.role === 'switch').props.disabled, true)
  assert.equal(findElement(panel.get(), (node) => node.type === 'input').props.disabled, true)
})

// ---------------------------------------------------------------------------
// 宿主半：投影单元 + 引擎同步状态
// ---------------------------------------------------------------------------

/** 投影定义的基本形状与 view 的失败关闭。 */
test('投影定义：key/stateVersion/state 形状；view 读引擎状态且绝不抛错', () => {
  const statusOf = () => ({
    state: 'ready', ingested: 12, lastSeq: 8, ingesting: false,
    attempted: 3, injected: 3, skipped: 0, failed: 0,
    lastStatus: 'injected', lastReason: null, lastInjectedAt: 1234, lastErrorCode: null,
    control: { enabled: false, recall: false, overrides: { limit: 5 }, error: null },
  })
  const definition = createStatusProjectionDefinition({ statusOf })
  assert.equal(definition.key, STATUS_PROJECTION_KEY)
  assert.equal(definition.stateVersion, STATUS_PROJECTION_VERSION)
  assert.equal(typeof definition.stateSchema.parse, 'function')
  assert.equal(typeof definition.wire.view, 'function')
  assert.equal(typeof definition.wire.viewSchema.parse, 'function')

  const initial = definition.init({ id: 's-1' })
  assert.deepEqual(initial, { sessionId: 's-1', tick: -1 })
  const next = definition.apply(initial, { seq: 8 })
  assert.deepEqual(next, { sessionId: 's-1', tick: 8 })
  assert.deepEqual(Object.keys(next).sort(), ['sessionId', 'tick'],
    'state 只能有观测水位：引擎计数进 state 会被检查点持久化、冷恢复出陈旧值')

  // 多余字段必须被拒（这条就是「别把 ingested 塞进 state」的可执行约束）。
  assert.throws(() => definition.stateSchema.parse({ sessionId: 's-1', tick: 8, ingested: 12 }), /state.keys/)
  assert.throws(() => definition.stateSchema.parse({ sessionId: 's-1', tick: 'x' }), /state.tick/)

  const view = definition.wire.viewSchema.parse(definition.wire.view(next))
  assert.equal(view.state, 'ready')
  assert.equal(view.ingested, 12)
  assert.equal(view.searchable, null, '缺失的可检索数必须是 null（未知），不得回落成 0')
  assert.equal(view.lastSeq, 8)
  assert.equal(view.injected, 3)
  assert.equal(view.lastStatus, 'injected')
  assert.equal(view.errorCode, null)
  assert.equal(view.control.enabled, false)
  assert.equal(view.control.recall, false)
  assert.equal(view.control.overrides.limit, 5)
  // 旧宿主/缺 control 时按默认全开，不让客户端崩。
  const plain = createStatusProjectionDefinition({ statusOf: () => ({ state: 'absent' }) })
  const defaults = plain.wire.view(plain.init({ id: 's-2' }))
  assert.equal(defaults.control.enabled, true)
  assert.equal(defaults.control.overrides.limit, null)

  // 读取器抛错：转成 failed + code，不把异常抛进宿主的事件派发。
  const broken = createStatusProjectionDefinition({ statusOf: () => { throw Object.assign(new Error('权限'), { code: 'EACCES' }) } })
  const failed = broken.wire.view(broken.init({ id: 's-1' }))
  assert.equal(failed.state, 'failed')
  assert.equal(failed.errorCode, 'EACCES')
  assert.match(failed.errorMessage, /权限/)

  // 未知状态不得冒充 ready。
  const weird = createStatusProjectionDefinition({ statusOf: () => ({ state: 'done' }) })
  const unknown = weird.wire.view(weird.init({ id: 's-1' }))
  assert.equal(unknown.state, 'failed')
  assert.equal(unknown.errorCode, 'ESTATUS_STATE')

  // 没有 sessionId（header 缺失）→ unavailable，而不是 ready/0。
  const noId = definition.wire.view(definition.init({}))
  assert.equal(noId.state, 'unavailable')

  // view schema 分型严格：数字位不得被字符串顶替（否则「12 条」与「'12' 条」在客户端同形）。
  assert.throws(() => definition.wire.viewSchema.parse({ ...view, ingested: '12' }), /view\.ingested/)
  assert.throws(() => definition.wire.viewSchema.parse({ ...view, searchable: -1 }), /view\.searchable/)
  assert.throws(() => definition.wire.viewSchema.parse({ ...view, lastSeq: -2 }), /view\.lastSeq/)
  assert.throws(() => definition.wire.viewSchema.parse({ ...view, lastStatus: 3 }), /view\.lastStatus/)
})

/** 入口 apply：可选注入 sessionProjections 时注册同一个 key；不改变硬依赖。 */
test('入口：sessionProjections 可选注入，缺席时插件照常启动', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'mcl-dock-home-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const module = await import(pathToFileURL(ENTRY).href)
    assert.deepEqual(module.inject, ['commands'], 'sessionProjections 不得写成硬依赖（服务缺席会连命令面一起停）')

    const registrations = []
    const injects = []
    const stub = {
      on() { return () => {} },
      effect(fn) { const disposer = fn(); return () => { if (typeof disposer === 'function') disposer() } },
      logger: { warn() {}, info() {} },
      commands: { register() { return () => {} } },
      inject(deps, callback) {
        injects.push([...deps])
        if (deps.includes('sessionProjections')) callback(stub)
        return { dispose() {} }
      },
      sessionProjections: { register(definition) { registrations.push(definition); return () => {} } },
    }
    await module.apply(stub, {})
    assert.deepEqual(injects, [['sessionProjections']], '投影必须走可选注入')
    assert.equal(registrations.length, 1)
    assert.equal(registrations[0].key, STATUS_PROJECTION_KEY)
    assert.equal(registrations[0].stateVersion, STATUS_PROJECTION_VERSION)
    // 引擎已装载：未触发过摄入的会话如实回 absent（不是 ready/0）。
    const view = registrations[0].wire.view(registrations[0].init({ id: 'never-seen' }))
    assert.equal(view.state, 'absent')
    assert.equal(view.ingested, null)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true }).catch(() => {})
  }
})

/** 引擎 statusOf：同步、零 I/O、计数来自真实摄入。 */
function fakeSession(id) {
  const events = []
  const store = new Map()
  let seq = 0
  const session = {
    id,
    log: events,
    surface: { nodes: [] },
    append(type, data) { seq += 1; store.set(seq, { seq, type, data }); return { seq } },
    eventAt(s) { return store.get(s) },
    deriveMessages() { return [] },
    push(type, extra = {}) {
      const s = events.length
      events.push({ seq: s, type, at: s, data: extra.data ?? {}, ...extra })
      return events.at(-1)
    },
  }
  return session
}

test('引擎 statusOf：真实摄入后可读、未知会话不建桶、坏入参不抛错', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-dock-engine-'))
  const handlers = new Map()
  const ctx = {
    on(name, handler) { handlers.set(name, handler); return () => {} },
    logger: { warn() {}, info() {} },
  }
  const engine = attachV3Engine(ctx, { v3Root: root })
  try {
    const session = fakeSession('s-status')
    session.push('user/message', { data: { source: { kind: 'user' }, content: [{ type: 'text', text: '第一条' }] } })
    session.push('assistant/message', { data: { content: [{ type: 'text', text: '回复' }] } })
    await handlers.get('agent/pre-step')({ agent: { session }, signal: undefined }, async () => ({ kind: 'enter' }))
    await engine._waitForIdle()

    const status = engine.statusOf('s-status')
    assert.equal(status.state, 'ready')
    assert.equal(status.ingested, 2, '两条真实事件 → 两条已提交记录')
    assert.equal(status.lastSeq, 1)
    assert.equal(status.ingesting, false)
    assert.equal(status.injected, 0)
    assert.equal(engine.stats()['s-status'].records, 2, 'stats 与 statusOf 的会计必须一致')

    // 同一事件集再跑一步：断点过滤必须生效，records 不得双计。
    await handlers.get('agent/pre-step')({ agent: { session }, signal: undefined }, async () => ({ kind: 'enter' }))
    await engine._waitForIdle()
    assert.equal(engine.statusOf('s-status').ingested, 2, '重放同一批事件不得让 records 双计')

    // own-source 跳过：推进断点但不计入「已摄入」；随后一条真人消息照常计入。
    session.push('user/message', {
      data: { source: { kind: 'dsh-memory-context-lab', form: 'recall' }, content: [{ type: 'text', text: '回注包' }] },
      source: { kind: 'dsh-memory-context-lab', form: 'recall' },
    })
    session.push('user/message', { data: { source: { kind: 'user' }, content: [{ type: 'text', text: '第二条真人' }] } })
    await handlers.get('agent/pre-step')({ agent: { session }, signal: undefined }, async () => ({ kind: 'enter' }))
    await engine._waitForIdle()
    const after = engine.statusOf('s-status')
    assert.equal(after.ingested, 3, 'own-source 不计入已摄入；真人消息计入')
    assert.equal(after.lastSeq, 3, 'own-source 仍推进断点')

    const unknown = engine.statusOf('never-seen')
    assert.equal(unknown.state, 'absent', '没触发过摄入 ≠ 已建库；不得冒充 ready')
    assert.equal(unknown.ingested, null)
    assert.ok(!Object.hasOwn(engine.stats(), 'never-seen'), '只读状态查询不得把会话塞进 runtime 表')

    // 坏入参不得抛错（投影 view 每步会被宿主调用，抛错会打断 session/event 派发）。
    assert.doesNotThrow(() => engine.statusOf(undefined))
    assert.doesNotThrow(() => engine.statusOf(null))
    assert.doesNotThrow(() => engine.statusOf({ toString() { return 'obj' } }))
  } finally {
    await engine._waitForIdle().catch(() => {})
    engine.dispose()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})

test('引擎 statusOf：建库时计数不可读 → ingested 为 null（未知），不得回 0', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-dock-unknown-'))
  const handlers = new Map()
  const warnings = []
  const ctx = {
    on(name, handler) { handlers.set(name, handler); return () => {} },
    logger: { warn(message) { warnings.push(String(message)) }, info() {} },
  }
  const brokenRuntime = {
    store: {
      sourceEventIds: async () => [],
      health: async () => { throw Object.assign(new Error('索引不可读'), { code: 'EACCES' }) },
    },
    metrics: () => ({}),
    close() {},
  }
  const engine = attachV3Engine(ctx, { v3Root: root, runtimeFactory: async () => brokenRuntime })
  try {
    await handlers.get('agent/pre-step')({ agent: { session: fakeSession('s-null') }, signal: undefined }, async () => ({ kind: 'enter' }))
    await engine._waitForIdle()
    const status = engine.statusOf('s-null')
    assert.equal(status.state, 'ready')
    assert.equal(status.ingested, null, '「计数读不到」必须是 null（未知），不能回 0 冒充空库')
    assert.ok(warnings.some((message) => /记录计数不可读/.test(message)), '不可读必须留告警，不能静默')
  } finally {
    await engine._waitForIdle().catch(() => {})
    engine.dispose()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})

// ---------------------------------------------------------------------------
// 会话控制（beta.17）：文件、合并、摄入门、命令面
// ---------------------------------------------------------------------------

test('会话控制域：默认 / limit 覆盖 / 非法失败关闭', () => {
  const shape = normalizeSessionControl(undefined)
  assert.equal(shape.control.enabled, true)
  assert.equal(shape.control.recall, true)
  assert.equal(shape.error, 'ECONTROL_SHAPE')

  const base = normalizeSessionControl({}).control
  const next = patchSessionControl(base, { enabled: false, recall: false, overrides: { limit: 5 } })
  assert.equal(next.enabled, false)
  assert.equal(next.recall, false)
  assert.equal(next.overrides.limit, 5)

  assert.throws(() => patchSessionControl(base, { overrides: { limit: 99 } }), /ECONTROL_RANGE|1–20/)
  assert.throws(() => patchSessionControl(base, { overrides: { packMinScore: 1 } }), /未知覆盖项/)
  assert.throws(() => patchSessionControl(base, { enabled: 'yes' }), /必须是布尔值/)

  const merged = mergeSessionSettings(
    { enabled: true, limit: 10, packMinScore: 0.5, previewChars: 160, queryMaxChars: 512 },
    next,
  )
  assert.equal(merged.enabled, false, '会话停用/关回注 → 实际不注入')
  assert.equal(merged.limit, 5)
  assert.equal(merged.packMinScore, 0.5, '底层参数仍来自全局设置页')

  const recallOff = mergeSessionSettings(
    { enabled: true, limit: 10, packMinScore: 0.5, previewChars: 160, queryMaxChars: 512 },
    patchSessionControl(base, { recall: false }),
  )
  assert.equal(recallOff.enabled, false, '只关本对话自动回注也必须停注入（全局 enabled 仍为开）')

  const cleared = patchSessionControl(next, { overrides: { limit: null } })
  assert.equal(Object.hasOwn(cleared.overrides, 'limit'), false)
})

test('会话控制文件：默认全开 / 原子写 / 损坏可见 / 哈希键', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-control-'))
  try {
    const initial = readSessionControl(root, 's-control')
    assert.equal(initial.enabled, true)
    assert.equal(initial.recall, true)
    assert.deepEqual(initial.overrides, {})

    const next = patchSessionControl(normalizeSessionControl({}).control, {
      enabled: false,
      recall: false,
      overrides: { limit: 5 },
    })
    await writeSessionControl(root, 's-control', next)
    const read = readSessionControl(root, 's-control')
    assert.equal(read.enabled, false)
    assert.equal(read.recall, false)
    assert.equal(read.overrides.limit, 5)

    await writeFile(sessionControlPath(root, 's-control'), '{not json', 'utf8')
    const broken = readSessionControl(root, 's-control')
    assert.equal(broken.error, 'ECONTROL_CORRUPT', '损坏必须可见，不能静默说成用户关掉了')
    assert.equal(broken.enabled, true, '默认全开的调用方按默认继续')

    // 新对话 defaultEnabled=false：坏 JSON 必须回落 false（失败关闭），不能失败开放。
    const closedPath = sessionControlPath(root, 's-fail-closed')
    await mkdir(path.dirname(closedPath), { recursive: true })
    await writeFile(closedPath, '{not json', 'utf8')
    const closed = readSessionControl(root, 's-fail-closed', { defaultEnabled: false })
    assert.equal(closed.error, 'ECONTROL_CORRUPT')
    assert.equal(closed.enabled, false, '坏 JSON 在默认关的会话里不得变 enabled=true')

    const unusual = sessionControlPath(root, 'a/b')
    assert.match(unusual, /hash-[0-9a-f]{16}/, '非常规 id 与冷库同样哈希兜底，不越根')
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})

test('摄入钩子：本对话停用后不再建库/摄入；重新启用恢复', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-control-gate-'))
  const handlers = new Map()
  const ctx = {
    on(name, handler) { handlers.set(name, handler); return () => {} },
    logger: { warn() {}, info() {} },
  }
  const engine = attachV3Engine(ctx, { v3Root: root })
  try {
    await engine.setControl('s-gate', { enabled: false })
    const session = fakeSession('s-gate')
    session.push('user/message', { data: { source: { kind: 'user' }, content: [{ type: 'text', text: '第一条' }] } })
    await handlers.get('agent/pre-step')({ agent: { session }, signal: undefined }, async () => ({ kind: 'enter' }))
    await engine._waitForIdle()
    const off = engine.statusOf('s-gate')
    assert.equal(off.state, 'absent', '停用后不应建库/摄入')
    assert.equal(off.control.enabled, false)

    await engine.setControl('s-gate', { enabled: true })
    await handlers.get('agent/pre-step')({ agent: { session }, signal: undefined }, async () => ({ kind: 'enter' }))
    await engine._waitForIdle()
    const on = engine.statusOf('s-gate')
    assert.equal(on.state, 'ready')
    assert.equal(on.ingested, 1)
    assert.equal(on.control.enabled, true)
  } finally {
    await engine._waitForIdle().catch(() => {})
    engine.dispose()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})

test('命令面：on/off、inject、set limit、reset、status 都写本对话控制', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'mcl-control-cmd-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const module = await import(pathToFileURL(ENTRY).href + '?t=' + Date.now())
    let definition = null
    const stub = {
      on() { return () => {} },
      effect(fn) { const disposer = fn(); return () => { if (typeof disposer === 'function') disposer() } },
      logger: { warn() {}, info() {} },
      commands: { register(row) { definition = row; return () => {} } },
      inject() { return { dispose() {} } },
    }
    await module.apply(stub, {})
    assert.ok(definition, '命令必须注册')
    const run = (line) => definition.handler({ agent: { session: { id: 's-cmd' } }, rawInput: line })
    const root = path.join(home, '.memory-context-lab', 'v3')

    assert.equal((await run('off')).kind, 'success')
    assert.equal(readSessionControl(root, 's-cmd').enabled, false)
    assert.equal((await run('inject off')).kind, 'success')
    assert.equal(readSessionControl(root, 's-cmd').recall, false)
    assert.equal((await run('set limit 5')).kind, 'success')
    assert.equal(readSessionControl(root, 's-cmd').overrides.limit, 5)
    assert.equal((await run('set limit 99')).kind, 'error')
    // 数字参数只认十进制：Number() 会把 0x14 静默写成 20、1e1 写成 10。
    for (const bad of ['0x14', '1e1', '５', '5.0']) {
      const result = await run('set limit ' + bad)
      assert.equal(result.kind, 'error', '非严格十进制必须拒绝：' + bad)
    }
    assert.equal(readSessionControl(root, 's-cmd').overrides.limit, 5, '拒绝后不得改写原值')
    assert.equal((await run('set gate 0')).kind, 'success')
    assert.equal(readSessionControl(root, 's-cmd').overrides.gate, 0)
    assert.equal((await run('set gate 0x10')).kind, 'error')
    assert.equal((await run('set gate 96')).kind, 'error')
    assert.equal((await run('unset gate')).kind, 'success')
    assert.equal(Object.hasOwn(readSessionControl(root, 's-cmd').overrides, 'gate'), false)
    assert.equal((await run('reset')).kind, 'success')
    const reset = readSessionControl(root, 's-cmd')
    assert.equal(reset.enabled, true)
    assert.equal(reset.recall, true)
    assert.equal(Object.hasOwn(reset.overrides, 'limit'), false)

    const status = await run('status')
    assert.equal(status.kind, 'success')
    assert.match(status.text, /本对话/)

    // 模式命令：中文名是显示名，内部 id 不变（state.json 里仍是 full-history/cooling）。
    const byLabel = await run('mode 按步归档')
    assert.equal(byLabel.kind, 'success', byLabel.text)
    assert.match(byLabel.text, /按步归档（cooling）/)
    const coolingState = JSON.parse(await readFile(path.join(root, 'sessions', 's-cmd', 'state.json'), 'utf8'))
    assert.equal(coolingState.mode, 'cooling', '中文别名必须落到内部 id，不得写进 state')
    const byAlias = await run('mode 按轮')
    assert.equal(byAlias.kind, 'success')
    assert.match(byAlias.text, /按轮归档（full-history）/)
    const bad = await run('mode 全历史')
    assert.equal(bad.kind, 'error', '旧名不再是合法输入：要明确报用法，而不是猜')
    assert.match(bad.text, /按轮归档/)

    // 闸门：会话覆盖写进 control.json 的 overrides.gate，越界失败关闭。
    assert.equal((await run('set gate 10')).kind, 'success')
    assert.equal(readSessionControl(root, 's-cmd').overrides.gate, 10)
    assert.equal((await run('set gate 96')).kind, 'error', '闸门上限 95：越界必须拒绝，不静默夹取')
    assert.equal((await run('unset gate')).kind, 'success')
    assert.equal(Object.hasOwn(readSessionControl(root, 's-cmd').overrides, 'gate'), false)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true }).catch(() => {})
  }
})
