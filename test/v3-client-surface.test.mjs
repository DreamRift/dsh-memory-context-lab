/**
 * 浏览器半契约守卫（0.14.0-beta.13：设置界面为什么「有 Config 也没有」的回归）。
 *
 * beta.12 的结论是「入口导出 Config 就有设置页」，真机上仍然没有。宿主源码核验
 * （app.asar 内 `@deepseek-ai/dsh-settings/lib/index.js`）给出真相：
 *
 * - `describe()` 只产出 `settings.describe` 的**数据行**（ns / revision / schema /
 *   value / base / user）；没有 Config 时命名空间整行缺席，**有 Config 也只让这一行存在**。
 * - 页面由 `@deepseek-ai/dsh-client-ui-plugin-manager` 渲染，它只认三个**槽位注册**：
 *   `plugins.item` / `plugins.bundle.config`（键 = 包名）/ `plugins.row.config`
 *   （键 = `<包名>#<行 id>`）。**没有注册 = 页面上没有界面**，与 Config 无关。
 *
 * 所以本守卫钉三件事：① 声明与文件必须成对存在（beta.11 的 P0-A 是「声明在、文件不在」，
 * 反面同样是错的：文件在、声明不在 → 宿主永远不服务它）；② 浏览器半只 require 平台基线
 * 表里的模块；③ 表单字段与宿主半 `Config` 的 schema 同域，且注册键与 patch 行 id 一致。
 *
 * 「改回去必红」：删掉 `dsh.client`、删掉 `exports["./client"]`、把 require 换成相对路径、
 * 把 ROW_KEY 改成别的键、把某个字段的 max 改小——每一条都会让本文件变红。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SRC = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(SRC, '..')
const PKG = path.join(ROOT, 'package.json')
const ENTRY = path.join(ROOT, 'src', 'index.mjs')
const CLIENT = path.join(ROOT, 'src', 'client.js')
const PATCH = path.join(ROOT, 'cordis.patch.yml')

/**
 * 平台基线表（宿主 `dsh-web-frontend` 的种子表实测，2026-10-27）：
 * `dsh-client-modules` 的 require 只解析这些名字与 boot graph 行；相对路径一律不可用。
 */
const PLATFORM_MODULES = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  'zod',
  '@tanstack/react-virtual',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
])

/** 极简 React 替身：够跑 Card 的 useState / useEffect，并支持 setState 后重渲染。 */
function createFakeReact() {
  const hooks = []
  let index = 0
  let pendingEffects = []
  let rendering = false
  let depth = 0
  let rerenderRequested = false
  let target = null

  const React = {
    createElement(type, props, children) {
      return { type, props: props ?? {}, children }
    },
    useState(initial) {
      const slot = index++
      if (hooks.length <= slot) hooks[slot] = { value: typeof initial === 'function' ? initial() : initial, deps: undefined }
      const state = hooks[slot]
      const set = (next) => {
        state.value = typeof next === 'function' ? next(state.value) : next
        // 渲染/effect 期间只登记一次重渲，由 render 的循环处理；外部调用才立即重渲。
        if (depth > 0) rerenderRequested = true
        else if (target !== null) target()
      }
      return [state.value, set]
    },
    useEffect(fn, deps) {
      const slot = index++
      pendingEffects.push({ slot, fn, deps })
    },
  }

  /** 渲一轮：跑组件、处理依赖变化的 effect（effect 里的 setState 会再渲一轮，上限 20 轮）。 */
  function render(component, props) {
    let tree
    let rounds = 0
    depth += 1
    try {
      do {
        rerenderRequested = false
        index = 0
        pendingEffects = []
        rendering = true
        tree = component(props)
        rendering = false
        for (const effect of pendingEffects) {
          const previous = hooks[effect.slot]
          const same = previous !== undefined
            && previous.deps !== undefined
            && effect.deps !== undefined
            && previous.deps.length === effect.deps.length
            && previous.deps.every((value, i) => Object.is(value, effect.deps[i]))
          if (same) continue
          const cleanup = previous?.cleanup
          if (typeof cleanup === 'function') cleanup()
          hooks[effect.slot] = { ...previous, deps: effect.deps, cleanup: effect.fn() }
        }
        rounds += 1
      } while (rerenderRequested && rounds < 20)
    } finally {
      depth -= 1
    }
    return tree
  }

  /** 绑定一次渲染入口：setState 触发时用**同一份** props 重跑同一个组件。 */
  function bind(component, props) {
    let tree = null
    target = () => { tree = render(component, props) }
    tree = render(component, props)
    return { get: () => tree }
  }

  return { React, bind }
}

/** 从元素树里按条件找元素（先序遍历）。 */
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
  const hit = findElement(node.children, predicate)
  if (hit !== undefined) return hit
  return findElement(node.props?.children, predicate)
}

/** 加载浏览器半：伪造 `window.__ModuleLoader__`，取回工厂并按给定 require 执行。 */
async function loadClient() {
  const registered = []
  const previous = globalThis.window
  globalThis.window = {
    __ModuleLoader__: {
      load(entry) { registered.push(entry) },
    },
  }
  try {
    await import(pathToFileURL(CLIENT).href + '?t=' + Date.now())
  } finally {
    if (previous === undefined) delete globalThis.window
    else globalThis.window = previous
  }
  assert.equal(registered.length, 1, '浏览器半必须恰好自注册一次（window.__ModuleLoader__.load）')
  return registered[0]
}

/** 跑一次 apply，返回注册记录与配置表单替身。 */
function runApply(entry, options = {}) {
  const { React, bind } = createFakeReact()
  const Button = function Button() {}
  const Switch = function Switch() {}
  const module = entry.factory((name) => {
    if (name === 'react') return React
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return { Button, Switch }
    throw new Error('客户端不得 require 平台基线表之外的模块：' + name)
  })

  const slots = []
  const dictionaries = []
  const listeners = []
  let snapshot = options.snapshot ?? {
    status: 'ready',
    value: { ...module.DEFAULTS },
    user: {},
    base: { ...module.DEFAULTS },
    revision: 3,
    writable: true,
  }
  const writes = []
  const form = {
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.push(listener); return () => listeners.splice(listeners.indexOf(listener), 1) },
    mutate: async (ops, revision) => { writes.push({ ops, revision }); return options.acceptWrite ?? true },
  }
  const served = options.served ?? ['memory-context-lab']
  /** 本套件只负责设置面；状态条的槽位注册由 v3-client-dock 单独覆盖。这里记录 calls，不执行回调。 */
  const slotInjects = []
  const optionalInjects = []
  const ctx = {
    effect(fn) { const disposer = fn(); return () => { if (typeof disposer === 'function') disposer() } },
    locale: {
      register(ns, dict) { dictionaries.push({ ns, dict }); return () => {} },
      bind() { return (key, vars) => (vars === undefined ? key : key + JSON.stringify(vars)) },
    },
    slots: {
      inject(name, register) { slotInjects.push({ name, register }) },
      register(registration, component) { slots.push({ registration, component }); return () => {} },
    },
    inject(deps, callback) {
      optionalInjects.push([...deps])
      // 真实 cordis 在依赖可用时启动子插件；这里 configForms 总是可用（本套件的前提）。
      callback(ctx)
    },
    configForms: {
      get: () => form,
      // 复刻宿主 whileServed 的门：**没有任何被跟随的命名空间被服务时不注册**。
      whileServed(namespaces, register) {
        assert.deepEqual(namespaces, [module.NS], '只跟随自己的命名空间')
        const servedSet = new Set(served)
        if (!namespaces.some((namespace) => servedSet.has(namespace))) return () => {}
        return register(servedSet) ?? (() => {})
      },
    },
  }
  module.apply(ctx)
  return { module, slots, slotInjects, optionalInjects, dictionaries, form, writes, React, bind, Button, Switch, getSnapshot: () => snapshot, setSnapshot: (next) => { snapshot = next } }
}

test('manifest：dsh.client 与 exports["./client"] 必须成对存在，且指向真实文件', async () => {
  const manifest = JSON.parse(await readFile(PKG, 'utf8'))
  assert.equal(manifest.dsh?.client?.platform, 'web', 'dsh.client.platform 必须是 web（宿主 resolveMeta 的判据）')
  assert.deepEqual(manifest.exports?.['./client'], './src/client.js', 'exports["./client"] 是宿主定位 bundle 的唯一入口')
  assert.equal(manifest.main, 'src/index.mjs')
  assert.equal(manifest.exports?.['.'], './src/index.mjs', '宿主半入口必须保留')
  // 声明指向的文件必须真的在（beta.11 的 P0-A 就是这一对不成立）。
  const source = await readFile(CLIENT, 'utf8')
  assert.ok(source.includes('__ModuleLoader__.load'), '浏览器半必须是宿主约定的自注册格式')
  assert.ok(manifest.files.includes('src'), '打包清单必须包含 src（否则装出来的包没有 client.js）')
})

test('浏览器半只 require 平台基线表里的模块（相对路径在宿主里解析不了）', async () => {
  const source = await readFile(CLIENT, 'utf8')
  const requires = [...source.matchAll(/require\(\s*'([^']+)'\s*\)/g)].map((match) => match[1])
  assert.ok(requires.length > 0, '至少要 require react')
  for (const name of requires) {
    assert.ok(PLATFORM_MODULES.has(name), `不得 require "${name}"：平台种子表里没有它，浏览器端会抛「could not load」`)
  }
})

test('浏览器半的模块 id 必须等于包名（dsh-client-modules 用包名做浏览器模块标识）', async () => {
  const manifest = JSON.parse(await readFile(PKG, 'utf8'))
  const entry = await loadClient()
  assert.equal(entry.id, manifest.name, 'id 与包名不一致 → 图上的行与工厂对不上，bundle 永远不 materialize')
  assert.equal(typeof entry.factory, 'function')
})

test('注册键必须与宿主侧 id 对齐：命名空间 = patch 行 id，行配置键 = 包名#行 id', async () => {
  const manifest = JSON.parse(await readFile(PKG, 'utf8'))
  const patch = await readFile(PATCH, 'utf8')
  const rowId = patch.match(/-\s*id:\s*(\S+)/)?.[1]
  assert.equal(rowId, 'memory-context-lab', 'cordis.patch.yml 的行 id 就是 dsh-settings 的命名空间')

  const entry = await loadClient()
  const { module } = runApply(entry)
  assert.equal(module.NS, rowId, 'NS 必须等于 patch 行 id（否则 describe() 里永远没有这一行）')
  assert.equal(module.BUNDLE, manifest.name)
  assert.equal(module.ROW_KEY, manifest.name + '#' + rowId, 'plugins.row.config 的键是 <包名>#<行 id>')
})

test('apply：命名空间被服务时同时注册 bundle 配置与行配置两个槽位', async () => {
  const entry = await loadClient()
  const run = runApply(entry)
  assert.deepEqual(run.slots.map((row) => row.registration.name), ['plugins.bundle.config', 'plugins.row.config'])
  assert.deepEqual(run.slots.map((row) => row.registration.key), [run.module.BUNDLE, run.module.ROW_KEY])
  assert.equal(run.dictionaries.length, 1, '字典必须注册（页面按 locale 命名空间取文案）')
  assert.deepEqual(run.dictionaries[0].ns, run.module.NS)

  // 0.14.0-beta.16：同一次 apply 还必须把 chip 挂到 composer 工具行（conversation.input.left）。
  // 本套件的 slots.register 只收设置面（inject 回调不执行），但 inject 本身必须被发起。
  assert.deepEqual(run.slotInjects.map((row) => row.name), [run.module.CHIP_SLOT, 'sidebar.panellist', 'main'],
    'chip 与侧栏面板必须走 ctx.slots.inject 等槽位声明（直接 register 在页面未渲染时会落空）')
  assert.deepEqual(run.optionalInjects, [['configForms']],
    '设置服务必须是可选注入：服务缺席时 chip 仍要渲染')

  // 命名空间没被服务（插件未装载 / 宿主没给 Config）时不得注册任何槽位。
  const absent = runApply(entry, { served: [] })
  assert.deepEqual(absent.slots, [], '命名空间缺席时页面不留痕')
})

test('表单字段与宿主半 Config 同域：键、类型、上下界、步长、默认值逐项相等', async () => {
  const host = await import(pathToFileURL(ENTRY).href)
  const json = host.Config.toJSON()
  const root = json.refs?.[json.uid] ?? json
  const refs = json.refs ?? {}
  const entry = await loadClient()
  const { module } = runApply(entry)

  const schemaFields = Object.entries(root.dict ?? {}).map(([name, ref]) => {
    const node = refs[ref] ?? ref
    return {
      name,
      type: node.type,
      default: node.meta?.default,
      min: node.meta?.min,
      max: node.meta?.max,
      step: node.meta?.step,
      volatile: node.meta?.volatile,
    }
  })
  assert.deepEqual(module.FIELDS.map((field) => field.key).sort(), schemaFields.map((field) => field.name).sort(),
    '客户端表单字段必须与宿主 schema 一一对应：少一个 = 少一个控件，多一个 = 保存必被拒')

  for (const field of module.FIELDS) {
    const schema = schemaFields.find((row) => row.name === field.key)
    assert.equal(schema.type, field.kind, field.key + ' 的类型必须与 schema 一致')
    assert.equal(schema.volatile, true, field.key + ' 必须 volatile，否则宿主 describe() 不投影它')
    assert.equal(module.DEFAULTS[field.key], schema.default, field.key + ' 的默认值必须与 schema 一致')
    if (field.kind === 'number') {
      assert.equal(field.min, schema.min, field.key + ' 的下界必须与 schema 一致')
      assert.equal(field.max, schema.max, field.key + ' 的上界必须与 schema 一致')
      assert.equal(field.step, schema.step, field.key + ' 的步长必须与 schema 一致')
    }
  }
})

test('摘要视图只回一行文案：bundle 列表里的卡片不带表单', async () => {
  const entry = await loadClient()
  const run = runApply(entry)
  const tree = run.bind(run.slots[0].component, { view: 'summary', t: (key) => key })
  assert.equal(tree.get(), 'summary')
})

test('就绪态渲染出全部字段；改开关 + 保存只提交真正变化的项', async () => {
  const entry = await loadClient()
  const run = runApply(entry)
  const t = (key) => key
  const rendered = run.bind(run.slots[0].component, { view: 'page', t })
  const tree = rendered.get()
  const fields = []
  const collect = (node) => {
    if (node === null || node === undefined) return
    if (Array.isArray(node)) { node.forEach(collect); return }
    if (typeof node !== 'object') return
    if (node.props?.['data-mcl-field'] !== undefined) fields.push(node.props['data-mcl-field'])
    collect(node.children)
    collect(node.props?.children)
  }
  collect(tree)
  assert.deepEqual(fields.sort(), run.module.FIELDS.map((field) => field.key).sort(), '五个字段都要渲染出来')

  const toggle = findElement(tree, (node) => node.type === run.Switch)
  assert.ok(toggle, '回注开关必须是 Switch 控件')
  toggle.props.onChange(false)
  const save = findElement(rendered.get(), (node) => node.type === run.Button && node.props['data-mcl-save'] === true)
  assert.ok(save, '必须有保存按钮')
  save.props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(run.writes, [{ ops: [{ op: 'set', path: ['enabled'], value: false }], revision: 3 }],
    '只提交变化项，且带上宿主给的 revision（并发保护）')
})

test('越界值在本地拦下：不发写请求，字段下方给可读提示', async () => {
  const entry = await loadClient()
  const run = runApply(entry)
  const rendered = run.bind(run.slots[1].component, { view: 'page', t: (key) => key })
  const input = findElement(rendered.get(), (node) => node.type === 'input' && node.props['aria-label'] === 'limitLabel')
  assert.ok(input, '条数字段必须是可编辑的数字输入')
  input.props.onChange({ target: { value: '99' } })
  const save = findElement(rendered.get(), (node) => node.type === run.Button && node.props['data-mcl-save'] === true)
  save.props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(run.writes, [], '越界不得发写请求（宿主 schema 会拒，但那时只剩一句「保存失败」）')
  const hint = findElement(rendered.get(), (node) => typeof node.children === 'string' && node.children.startsWith('invalid'))
  assert.ok(hint, '越界提示要落在该字段下方')
})

test('行配置页用页面传入的 form（bundle 页没有 form 才自取 configForms）', async () => {
  const entry = await loadClient()
  const run = runApply(entry)
  const pageWrites = []
  const pageForm = {
    state: { status: 'ready', value: { ...run.module.DEFAULTS }, user: {}, revision: 7, writable: true },
    mutate: async (ops, revision) => { pageWrites.push({ ops, revision }); return true },
  }
  const rendered = run.bind(run.slots[1].component, { view: 'page', t: (key) => key, form: pageForm })
  const toggle = findElement(rendered.get(), (node) => node.type === run.Switch)
  toggle.props.onChange(false)
  const save = findElement(rendered.get(), (node) => node.type === run.Button && node.props['data-mcl-save'] === true)
  save.props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(pageWrites, [{ ops: [{ op: 'set', path: ['enabled'], value: false }], revision: 7 }],
    '行页必须写页面给的 form（否则两份表单会各写各的）')
  assert.deepEqual(run.writes, [], '不得同时写自取的 configForms')
})

test('不可写部署：控件禁用并给出只读说明，不谎称可保存', async () => {
  const entry = await loadClient()
  const run = runApply(entry, {
    snapshot: { status: 'ready', value: { ...runDefault() }, user: {}, revision: 1, writable: false },
  })
  function runDefault() { return { enabled: true, limit: 10, packMinScore: 0.5, previewChars: 160, queryMaxChars: 512 } }
  const rendered = run.bind(run.slots[0].component, { view: 'page', t: (key) => key })
  const save = findElement(rendered.get(), (node) => node.type === run.Button && node.props['data-mcl-save'] === true)
  assert.equal(save.props.disabled, true, '只读部署的保存按钮必须禁用')
  const toggle = findElement(rendered.get(), (node) => node.type === run.Switch)
  assert.equal(toggle.props.disabled, true)
})

test('命名空间未被服务时页面说明「插件未加载」，不渲染半个表单', async () => {
  const entry = await loadClient()
  const run = runApply(entry, { snapshot: { status: 'unavailable', writable: true } })
  const rendered = run.bind(run.slots[0].component, { view: 'page', t: (key) => key })
  const tree = rendered.get()
  assert.equal(tree.type, 'p')
  assert.equal(tree.children, 'unavailable')
})

test('轮次判定字段是下拉框：切到 DSH 轮次提交字符串值，未改动不提交', async () => {
  const entry = await loadClient()
  const run = runApply(entry)
  const rendered = run.bind(run.slots[1].component, { view: 'page', t: (key) => key })
  const select = findElement(rendered.get(), (node) => node.type === 'select' && node.props['aria-label'] === 'turnBasisLabel')
  assert.ok(select, '轮次判定必须渲染成下拉框（开关说不出哪边是默认）')
  assert.equal(select.props.value, 'human', '默认必须是真人消息')
  const options = (select.children ?? []).flat(2).filter((node) => node !== null && typeof node === 'object')
  assert.deepEqual(options.map((node) => node.props.value), ['human', 'dsh'], '两个选项都要在')

  select.props.onChange({ target: { value: 'dsh' } })
  const save = findElement(rendered.get(), (node) => node.type === run.Button && node.props['data-mcl-save'] === true)
  save.props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(run.writes, [{ ops: [{ op: 'set', path: ['turnBasis'], value: 'dsh' }], revision: 3 }],
    '只提交轮次判定的字符串值，其它字段不动')
})
