/**
 * Installation tests: load the host half the way the profile does.
 *
 * A unit test that imports `../src/index.mjs` resolves from the workspace, where
 * nothing else lives. The host instead loads the *installed* path, and that
 * difference is exactly what broke `@furongjun1999/dsh-memory` lookup when the
 * plugin was linked into the profile: `createRequire` walked the workspace tree
 * and never saw the profile that installed the package.
 *
 * These tests therefore exercise the installed path when it exists, and verify
 * the lookup finds the real package rather than merely not throwing.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { dshMemoryLookupRoots, locatePinnedDshMemory } from '../src/dsh-memory-suppression.mjs'
import { memoryContextLabProjection } from '../src/projection.mjs'

const DSH_HOME = process.env.DSH_HOME ?? path.join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh')
const PROFILE = process.env.DSH_PROFILE ?? 'desktop'
const installedEntry = path.join(DSH_HOME, 'profiles', PROFILE, 'node_modules', 'dsh-memory-context-lab', 'src', 'index.mjs')

async function exists(target) {
  try {
    await access(target)
    return true
  } catch {
    return false
  }
}

/**
 * A stub context that supports both effect forms and records registrations.
 *
 * `withTools: false` 模拟 profile 作用域拿不到 agent 作用域的 `tools` 服务——
 * 这是真实存在的情况，插件必须照常加载（v1 不能跟着一起挂）。
 *
 * 替身必须忠实于宿主 cordis 的两条语义，否则会掩盖真实缺陷：
 * ① 服务读取走 `ctx.get(name)`（无注入要求，未提供时返回 undefined）；
 * ② `ctx.tools` 这类**未注入的属性读取会抛错**，不是返回 undefined
 *    （`cannot get property "tools" without inject`）。把 `tools` 建模成普通属性
 *    会让 `ctx.tools?.register` 看起来安全，而它在真实宿主里会炸掉整个插件加载。
 *    这里用 getter 复刻该行为：可用时返回值，不可用时抛错——`?.` 拦不住抛错，
 *    因此任何退回直接属性访问的改动都会被本测试挡住。
 * ③ 同样地，`config` **不是** context 上的属性（它是 apply 的第二个参数，且本插件
 *    `inject` 里没有 `config`）。0.9.0 正式版曾把一处读取写成 `ctx.config?.defaults`，
 *    在真实宿主里直接让插件加载失败、插件页显示「异常」；`?.` 同样拦不住代理抛错。
 *    这里让 `config` 与 `tools` 同形：读取即抛，逼实现走 `config` 参数。
 */
function createStubContext({ withTools = true } = {}) {
  const listeners = new Map()
  const prependEvents = []
  const commands = []
  const projections = []
  const tools = []
  const warnings = []
  const toolService = { register: (definition) => { tools.push(definition); return () => {} } }
  const ctx = {
    logger: { info() {}, warn: (m) => warnings.push(String(m)), error: (m) => warnings.push(String(m)) },
    get(name) {
      if (name === 'tools') return withTools ? toolService : undefined
      if (name === 'tokenMeter') {
        return {
          estimateMessage: (message) => Math.ceil(JSON.stringify(message).length / 4),
          measure: () => ({ totalTokens: 0, nodes: [], baseline: { kind: 'estimated' } }),
        }
      }
      if (name === 'llm') return { resolveModelInfo: async () => ({ context: { contextWindow: 100000 } }) }
      return undefined
    },
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
        listeners.set(event, (listeners.get(event) ?? []).filter((row) => row !== handler))
      }
    },
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
      return () => { for (const cleanup of local.splice(0).reverse()) cleanup?.() }
    },
    commands: { register: (definition) => { commands.push(definition); return () => {} } },
    sessionProjections: { register: (definition) => { projections.push(definition); return () => {} } },
    // 反应式注入替身：依赖齐了就立刻回调（传一个带 effect 的作用域），否则不回调。
    // 真实 cordis 是反应式的（服务后到会再回调），这里只覆盖「立即可用」这一支。
    // 回调收到的作用域**已注入 tools**，所以那一侧 `ctx.tools` 是可读的。
    inject(deps, callback) {
      const available = deps.every((dep) => ctx.get(dep) !== undefined)
      if (available) callback(ctx)
      return { dispose() {} }
    },
    _listeners: listeners,
    _prependEvents: prependEvents,
    _commands: commands,
    _projections: projections,
    _tools: tools,
    _warnings: warnings,
  }
  // `tools` 走 getter 复刻 cordis 代理：可用时返回服务，不可用时抛错（不是 undefined）。
  Object.defineProperty(ctx, 'tools', {
    get() {
      if (!withTools) throw new Error('cannot get property "tools" without inject')
      return toolService
    },
    configurable: true,
  })
  // `config` 同形：它从来不是 context 属性（是 apply 的第二参数），读取必抛。
  // 这条防线专门挡 0.9.0 那类 `ctx.config?.defaults` 回归——`?.` 拦不住抛错。
  Object.defineProperty(ctx, 'config', {
    get() {
      throw new Error('cannot get property "config" without inject')
    },
    configurable: true,
  })
  return ctx
}

test('the lookup searches the DSH home, not only this plugin\'s own tree', async () => {
  const requireFromPlugin = (await import('node:module')).createRequire(import.meta.url)
  const roots = await dshMemoryLookupRoots({
    requireFromPlugin,
    dshHome: 'C:/definitely-not-a-real-dsh-home',
    listProfiles: async () => [],
  })
  assert.ok(roots.length >= 1, 'at least one candidate root must be produced')
  assert.ok(roots.includes(path.resolve('C:/definitely-not-a-real-dsh-home', 'node_modules')))

  const withProfiles = await dshMemoryLookupRoots({
    requireFromPlugin,
    dshHome: 'C:/fake-home',
    listProfiles: async () => ['C:/fake-home/profiles/desktop'],
  })
  assert.ok(withProfiles.includes(path.resolve('C:/fake-home/profiles/desktop/node_modules')), 'the profile root must be searched')
  assert.equal(new Set(withProfiles).size, withProfiles.length, 'roots must be deduplicated')
})

test('a missing package fails with an actionable message, not a silent skip', async () => {
  // B4：本用例测「包不存在时的报错」，前提必须由测试自己钉死。真实
  // `requireFromPlugin` 的 Node 解析路径会命中原机已装的 peer（按 README 装好
  // dsh-memory 的环境），让「未找到」这条断言红。传一个没有解析路径的 stub
  // 显式屏蔽 Node 段，只剩不存在的 dshHome 可查——两种环境同一结果。
  const noNodePaths = { resolve: { paths: () => [] } }
  await assert.rejects(
    locatePinnedDshMemory(noNodePaths, { dshHome: 'C:/definitely-not-a-real-dsh-home', listProfiles: async () => [] }),
    /未找到已安装的 @furongjun1999\/dsh-memory/,
  )
})

test('a wrong version is refused rather than patched blindly', async (t) => {
  const requireFromPlugin = (await import('node:module')).createRequire(import.meta.url)
  const hasReal = await exists(path.join(DSH_HOME, 'profiles', PROFILE, 'node_modules', '@furongjun1999', 'dsh-memory', 'package.json'))
  if (!hasReal) return t.skip('the pinned dsh-memory is not installed in this profile')
  await assert.rejects(
    locatePinnedDshMemory(requireFromPlugin, { expectedVersion: '0.0.0-not-installed' }),
    /隔离只经 0\.0\.0-not-installed 核验/,
  )
})

test('the installed dsh-memory resolves to a real package root with MdcgClient', async (t) => {
  const requireFromPlugin = (await import('node:module')).createRequire(import.meta.url)
  let found
  try {
    found = await locatePinnedDshMemory(requireFromPlugin)
  } catch (error) {
    // On a machine without the plugin installed this is expected; the profile
    // check below is what matters on this machine.
    return t.skip(`dsh-memory is not resolvable here: ${error.message}`)
  }
  assert.equal(found.version, '0.8.1')
  // 不按路径子串断言：junction / 符号链接安装时 realpath 的实体目录名
  // 与包名不同（0.10.1 的 install 用例曾因此误红）。包身份以 manifest 为准。
  const manifest = JSON.parse(await readFile(path.join(found.packageRoot, 'package.json'), 'utf8'))
  assert.equal(manifest.name, '@furongjun1999/dsh-memory')
  assert.equal(typeof found.MdcgClient, 'function')
  // The cold store runs `python -m md_cg.mcp_server` with this as PYTHONPATH,
  // so the Python package must actually live at the resolved root.
  assert.ok(await exists(path.join(found.packageRoot, 'md_cg', '__init__.py')), 'md_cg must exist at the resolved root')
})

test('the installed host half loads, registers its surface, and finds dsh-memory', async (t) => {
  if (!(await exists(installedEntry))) {
    return t.skip(`the plugin is not installed at ${installedEntry}`)
  }
  const module = await import(pathToFileURL(installedEntry).href)
  assert.equal(module.name, 'memory-context-lab')
  assert.deepEqual(module.inject, ['commands', 'sessionProjections'], '不得硬依赖 tools，否则拿不到时整个插件（含 v1）会挂')

  const ctx = createStubContext()
  await module.apply(ctx)

  assert.deepEqual(ctx._commands.map((command) => command.name), ['memory-lab', 'memory-lab2'])
  assert.deepEqual(ctx._projections.map((projection) => projection.key), ['memoryContextLab'])
  // Both features ride `agent/pre-step`: the cooler delegates then cools, and
  // recall is prepended so it can fold into the downstream enter decision —
  // the same seam the shipped `time-context` plugin uses. Nothing listens on
  // `system-prompt/assemble`, which has no way to reach a session.
  //
  // `domain/changed` is the archive signal: the archive set is the `workspace`
  // domain's global singleton, so watching it catches every archive — including an
  // idle session, which never dispatches `workspace/session-stop`.
  assert.deepEqual([...ctx._listeners.keys()].sort(), ['agent/pre-step', 'domain/changed'])
  assert.equal(ctx._listeners.get('agent/pre-step').length, 6, 'v1 与 v2 各一个降温 + 一个回注，v2 一个工作状态注入，外加计划先行自动化钩子')
  assert.equal(ctx._listeners.get('domain/changed').length, 1)
  assert.deepEqual(ctx._prependEvents, ['agent/pre-step', 'agent/pre-step'], '每个引擎各挂一个 prepend 回注')

  // 固定注册的只读召回工具：恰好一个，名字与参数契约固定，不随引擎开关增删。
  assert.equal(ctx._tools.length, 1, '只注册一个模型可见工具')
  assert.equal(ctx._tools[0].name, 'memory_lab_recall')
  assert.deepEqual(Object.keys(ctx._tools[0].parameters.properties).sort(), ['budget_tokens', 'cursor', 'query', 'record_ids'])
  assert.equal(ctx._tools[0].parameters.type, 'object')
  assert.equal(ctx._tools[0].parameters.additionalProperties, false, '参数必须关死未知键')
  assert.equal(typeof ctx._tools[0].execute, 'function', '工具必须自带 execute（只读路径）')

  // The whole point of the DSH-home fallback: no compatibility warning here.
  assert.deepEqual(ctx._warnings, [], `the installed load must resolve dsh-memory cleanly, got: ${ctx._warnings.join(' | ')}`)

  // The client-facing view must be plain JSON with no undefined holes.
  const projection = ctx._projections[0]
  const view = projection.wire.view(projection.init())
  // 视图契约以**工作区源码**为准，不以「安装态当前是什么版本」为准：
  // 0.10.1 的旧用例把键清单写死在测试里，安装版一升级就必红（issue #2 同类）。
  // 安装版与源码版本一致时做精确比对；不一致时只验 JSON 安全并跳过形状比对，
  // 让开发态（安装包落后于源码）不产生假红，发布态仍能抓住字段漂移。
  const workspaceManifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const installedManifest = JSON.parse(await readFile(path.join(path.dirname(installedEntry), '..', 'package.json'), 'utf8'))
  const workspaceView = memoryContextLabProjection.wire.view(memoryContextLabProjection.init())
  for (const [key, value] of Object.entries(view)) {
    assert.notEqual(value, undefined, `${key} must not be undefined`)
  }
  assert.deepEqual(JSON.parse(JSON.stringify(view)), view)
  if (installedManifest.version === workspaceManifest.version) {
    assert.deepEqual(Object.keys(view).sort(), Object.keys(workspaceView).sort(), '安装版投影字段必须与工作区源码一致')
  } else {
    t.diagnostic(`installed ${installedManifest.version} != workspace ${workspaceManifest.version}；跳过字段清单精确比对`)
  }
})

test('拿不到 tools 服务时插件照常加载：v1 不受影响，只跳过工具注册并告警', async (t) => {
  if (!(await exists(installedEntry))) return t.skip('not installed')
  const module = await import(pathToFileURL(installedEntry).href)
  const ctx = createStubContext({ withTools: false })
  await module.apply(ctx)

  // v1 的两条命令与投影、两个引擎的钩子都必须在——插件不能因为缺 tools 整体挂掉。
  assert.deepEqual(ctx._commands.map((command) => command.name), ['memory-lab', 'memory-lab2'])
  assert.deepEqual(ctx._projections.map((projection) => projection.key), ['memoryContextLab'])
  assert.equal(ctx._listeners.get('agent/pre-step').length, 6)
  assert.equal(ctx._tools.length, 0, '拿不到 tools 时不应注册工具')
  assert.ok(
    ctx._warnings.some((warning) => warning.includes('ctx.tools.register')),
    `必须如实告警，实际告警：${ctx._warnings.join(' | ') || '(无)'}`,
  )
})

test('不得读 ctx.config：config 只走 apply 的第二参数（0.9.0 加载失败回归）', async (t) => {
  if (!(await exists(installedEntry))) return t.skip('not installed')

  // 静态面：源码里任何 `ctx.config` 读取都是缺陷。宿主 cordis 的 context 代理对
  // 未注入属性抛错（`cannot get property "config" without inject`），而本插件的
  // `inject` 只有 commands/sessionProjections——读它等于让整个插件加载失败，
  // 插件页显示「异常」。`?.` 拦不住代理抛错，所以这条只能靠不写来保证。
  const source = await readFile(path.join(path.dirname(installedEntry), 'index.mjs'), 'utf8')
  const offenders = source
    .split('\n')
    .map((line, index) => ({ line: line.trim(), number: index + 1 }))
    .filter(({ line }) => /ctx\s*\.\s*config\b/.test(line) && !line.startsWith('//') && !line.startsWith('*'))
  assert.deepEqual(offenders, [], `源码不得读 ctx.config（config 是 apply 的第二参数）：${JSON.stringify(offenders)}`)

  // 动态面：替身把 `config` 建模成「读取即抛」（与 tools 同形），因此只要实现
  // 退回到 `ctx.config`，下面的 apply 就会当场炸掉，而不是静默通过。
  const module = await import(pathToFileURL(installedEntry).href)
  const ctx = createStubContext()
  await module.apply(ctx)
  assert.deepEqual(ctx._commands.map((command) => command.name), ['memory-lab', 'memory-lab2'])
})

test('the installed host half registers a command that records its input', async (t) => {
  if (!(await exists(installedEntry))) return t.skip('not installed')
  const module = await import(pathToFileURL(installedEntry).href)
  const ctx = createStubContext()
  await module.apply(ctx)
  const command = ctx._commands[0]
  assert.equal(command.definitionId, 'dsh-memory-context-lab/control')
  // `recordInput` must stay unset: the default writes the raw line to
  // `command/run`, and the session projection folds exactly that record.
  assert.equal(command.recordInput, undefined)
  assert.ok(typeof command.input?.hint === 'string' && command.input.hint.includes('on'))
  assert.equal(typeof command.handler, 'function')
})

test('the client bundle ships beside the host half and declares its client section', async (t) => {
  const root = path.join(DSH_HOME, 'profiles', PROFILE, 'node_modules', 'dsh-memory-context-lab')
  if (!(await exists(root))) return t.skip('not installed')
  assert.ok(await exists(path.join(root, 'src', 'client.js')), 'the client bundle must be installed')
  const manifest = JSON.parse(await (await import('node:fs/promises')).readFile(path.join(root, 'package.json'), 'utf8'))
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.equal(manifest.exports['./client'], './src/client.js')
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-slots'))
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-api-remotes'))
})
