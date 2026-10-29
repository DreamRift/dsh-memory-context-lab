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
import { access, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'


const DSH_HOME = process.env.DSH_HOME ?? path.join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh')
const PROFILE = process.env.DSH_PROFILE ?? 'desktop'
const installedEntry = path.join(DSH_HOME, 'profiles', PROFILE, 'node_modules', 'dsh-memory-context-lab', 'src', 'index.mjs')

/**
 * 数据根隔离：`apply()` 内部按 `$DSH_HOME/.memory-context-lab/v3` 解析数据根。
 * 安装面测试只验「宿主能不能装起来」，绝不能把测试数据写进真实 DSH home——
 * 一旦某条用例真的驱动了 pre-step，它会打开真实会话库并拿写锁。
 * installedEntry 已经从**原始** env 算好，这里再改 env 只影响插件内部的运行时解析。
 */
const realDshHome = process.env.DSH_HOME
const testDshHome = await mkdtemp(path.join(tmpdir(), 'mcl-install-home-'))
process.env.DSH_HOME = testDshHome
test.after(async () => {
  if (realDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = realDshHome
  await rm(testDshHome, { recursive: true, force: true }).catch(() => {})
})

/**
 * 已安装副本与本仓源码是否同版。
 *
 * 安装面测试断言的是「profile 里那份能不能被宿主正确加载」。当 profile 装的是
 * 更早的版本（升级前）时，断言命令面/钩子数量必然与源码不符——那是**版本差异**，
 * 不是缺陷。此时跳过而不是判红：SKIP 单列计数，不冒充通过（规范 §10）。
 * 安装新版后本组会自动真正执行。
 */
// **必须用 fileURLToPath**：URL 的 pathname 是百分号编码的，本仓路径里既有空格
// （deepseek Harness）又有中文（Harness插件 / 记忆上下文），手工去掉前导斜杠之后
// 仍然带着 %20、%E8%AE%B0…，readFile 必然 ENOENT → 判「不同版本」→ 三条安装面
// 断言**永远 SKIP**。这正是 SKIP 冒充通过的典型形态（规范 §10）。
const SOURCE_ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.mjs')

/**
 * 换行归一：**必须**做，否则本判据在 Windows 上永远为假。
 *
 * profile 里的副本是 git checkout 出来的（autocrlf 转成 CRLF），工作树源码是 LF；
 * 直接比字节会把「同版但换行不同」判成「不同版本」，于是三条安装面断言**永远
 * SKIP**——而 SKIP 不是通过（规范 §10）。实测：0.13.1 装进 profile 后仍是 3 SKIP，
 * 归一换行后三条立刻真正执行，并立刻暴露出 0.13.0 遗留的过期断言。
 */
async function installedMatchesSource() {
  try {
    // 版本号先比：只比 src/index.mjs 是不够的（beta.4 实测踩过）——安装副本的
    // index.mjs 没变、其它 src 文件变了时，判据仍然为真，于是「安装面」断言拿着
    // 新源码的期望去验旧副本，红得莫名其妙。版本不同 = 升级前，按设计 SKIP。
    const [installedManifest, sourceManifest] = await Promise.all([
      readFile(path.join(path.dirname(installedEntry), '..', 'package.json'), 'utf8'),
      readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ])
    const versionOf = (text) => JSON.parse(text)?.version
    if (versionOf(installedManifest) !== versionOf(sourceManifest)) return false
    const [installed, source] = await Promise.all([
      readFile(installedEntry, 'utf8'),
      readFile(SOURCE_ENTRY, 'utf8'),
    ])
    const normalize = (text) => text.split(String.fromCharCode(13)).join('')
    return normalize(installed) === normalize(source)
  } catch {
    return false
  }
}

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
  // 0.14.0-beta.15：宿主提供 sessionProjections 时，插件注册只读状态投影。
  // 这里把服务同时挂成可注入依赖（get）——安装面测试要真的走到注册回调，
  // 否则「投影注册」这条新面在安装副本上完全没有覆盖。
  const projectionService = { register: (definition) => { projections.push(definition); return () => {} } }
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
      if (name === 'sessionProjections') return projectionService
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
    sessionProjections: projectionService,
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

test('test/ 与 src/ 不得用 URL.pathname 拼文件路径（本仓路径含空格与中文）', async () => {
  const roots = [path.join(path.dirname(SOURCE_ENTRY), '..', 'test'), path.join(path.dirname(SOURCE_ENTRY), '..', 'src')]
  const offenders = []
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) { await walk(full); continue }
      if (!/\.(mjs|js)$/.test(entry.name)) continue
      const body = await readFile(full, 'utf8')
      // 只挡「把 pathname 当文件路径」这一种误用；注释里提到不算。
      for (const line of body.split('\n')) {
        if (line.trimStart().startsWith('*') || line.trimStart().startsWith('//')) continue
        if (/\.pathname\b/.test(line) && /import\.meta\.url/.test(line)) {
          offenders.push(path.relative(path.dirname(SOURCE_ENTRY), full) + ': ' + line.trim())
        }
      }
    }
  }
  for (const root of roots) await walk(root)
  assert.deepEqual(offenders, [], '用 URL.pathname 拼路径会在含空格/中文的路径下 ENOENT，请改用 fileURLToPath：\n' + offenders.join('\n'))
})

test('the installed host half loads, registers its surface, and finds dsh-memory', async (t) => {
  if (!(await exists(installedEntry))) {
    return t.skip(`the plugin is not installed at ${installedEntry}`)
  }
  if (!(await installedMatchesSource())) {
    return t.skip('profile 安装的版本与本仓源码不同（升级前），安装面断言留待安装后验证')
  }
  const module = await import(pathToFileURL(installedEntry).href)
  assert.equal(module.name, 'memory-context-lab')
  assert.deepEqual(module.inject, ['commands'], '只声明真正使用的服务：多一个硬依赖就多一条「服务缺席→插件不启动」的路')

  const ctx = createStubContext()
  await module.apply(ctx, {})

  assert.deepEqual(ctx._commands.map((command) => command.name), ['memory-lab'])
  assert.equal(ctx._projections.length, 1, '宿主提供 sessionProjections 时必须注册只读状态投影')
  assert.equal(ctx._projections[0].key, 'memoryContextLabStatus', '客户端 dock 读的就是这个 key')
  // beta.45 起投影视图多一个覆盖键（limit + gate），stateVersion 1→2 让宿主的旧检查点
  // 一并丢弃重折；state 仍只有 {sessionId, tick}，重折没有成本。
  assert.equal(ctx._projections[0].stateVersion, 2)
  assert.equal(typeof ctx._projections[0].wire?.view, 'function')
  assert.equal(typeof ctx._projections[0].wire?.viewSchema?.parse, 'function')
  // Both features ride `agent/pre-step`: the cooler delegates then cools, and
  // recall is prepended so it can fold into the downstream enter decision —
  // the same seam the shipped `time-context` plugin uses. Nothing listens on
  // `system-prompt/assemble`, which has no way to reach a session.
  //
  // `domain/changed` is the archive signal: the archive set is the `workspace`
  // domain's global singleton, so watching it catches every archive — including an
  // idle session, which never dispatches `workspace/session-stop`.
  assert.deepEqual([...ctx._listeners.keys()].sort(), ['agent/pre-step'])
  // v3 单引擎：两个 pre-step 监听——引擎摄入（push，最内）与回注（prepend，最外）。
  assert.equal(ctx._listeners.get('agent/pre-step').length, 2,
    '摄入 + 回注：两个监听，缺一个都意味着 v3 少了半条链路')
  assert.deepEqual(ctx._prependEvents, ['agent/pre-step'], '只有回注需要 prepend（先于内层拿到 decision 再追加）')

  // v3 不注册模型可见工具（工具集恒定是缓存纪律，不是「暂时没做」）。
  assert.equal(ctx._tools.length, 0, 'v3 单引擎不增删模型可见工具')

  // The whole point of the DSH-home fallback: no compatibility warning here.
  assert.deepEqual(ctx._warnings, [], `the installed load must resolve cleanly, got: ${ctx._warnings.join(' | ')}`)

  // 命令结果必须是宿主 CommandResult：返回裸字符串会被 normalizeResult 抛 TypeError。
  const result = await ctx._commands[0].handler({
    agent: { session: { id: 'install-test-session' } },
    rawInput: 'status',
  })
  assert.equal(result.kind, 'success', `status 必须返回 CommandResult，实际：${JSON.stringify(result)}`)
  assert.equal(typeof result.text, 'string')
  assert.ok(result.text.length > 0)
})

test('不依赖 tools：拿不到 tools 服务时插件照常加载', async (t) => {
  if (!(await installedMatchesSource())) {
    return t.skip('profile 安装的版本与本仓源码不同（升级前），安装面断言留待安装后验证')
  }
  if (!(await exists(installedEntry))) return t.skip('not installed')
  const module = await import(pathToFileURL(installedEntry).href)
  const ctx = createStubContext({ withTools: false })
  await module.apply(ctx, {})

  // v3 根本不碰 tools：唯一命令与两个钩子必须在，且不应产生任何告警。
  assert.deepEqual(ctx._commands.map((command) => command.name), ['memory-lab'])
  assert.equal(ctx._projections.length, 1, '不依赖 tools 不影响状态投影注册')
  assert.equal(ctx._listeners.get('agent/pre-step').length, 2)
  assert.equal(ctx._tools.length, 0, 'v3 不注册工具')
  assert.deepEqual(ctx._warnings, [], `v3 不依赖 tools，不应有告警：${ctx._warnings.join(' | ')}`)
})

test('不得读 ctx.config：config 只走 apply 的第二参数（0.9.0 加载失败回归）', async (t) => {
  if (!(await installedMatchesSource())) {
    return t.skip('profile 安装的版本与本仓源码不同（升级前），安装面断言留待安装后验证')
  }
  if (!(await exists(installedEntry))) return t.skip('not installed')

  // 静态面：源码里任何 `ctx.config` 读取都是缺陷。宿主 cordis 的 context 代理对
  // 未注入属性抛错（`cannot get property "config" without inject`），而本插件
  // `inject` 只有 commands——读它等于让整个插件加载失败，插件页显示「异常」。
  // `?.` 拦不住代理抛错，所以这条只能靠不写来保证。
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
  await module.apply(ctx, {})
  assert.deepEqual(ctx._commands.map((command) => command.name), ['memory-lab'])
})

test('the installed host half registers a command that records its input', async (t) => {
  // 与 test 2/3/4 同一道版本闸：安装副本落后于源码时，断言的是**另一个版本**的形态，
  // 判红只会掩盖真正的回归（本组 0.13.1 就因为这道闸缺失，拿旧副本跑了新断言）。
  if (!(await installedMatchesSource())) {
    return t.skip('profile 安装的版本与本仓源码不同（升级前），安装面断言留待安装后验证')
  }
  if (!(await exists(installedEntry))) return t.skip('not installed')
  const module = await import(pathToFileURL(installedEntry).href)
  const ctx = createStubContext()
  await module.apply(ctx)
  const command = ctx._commands[0]
  assert.equal(command.definitionId, 'dsh-memory-context-lab/control')
  // `recordInput` 保持未设：默认行为会把整行写进 `command/run`。
  assert.equal(command.recordInput, undefined)
  // hint 必须反映**现存**命令面（v2 的 on/off/restore 已随单引擎退场；
  // 旧断言写的是 includes('on')，在 hint 里出现 'on' 纯属 'status' 里没有——
  // 它当年能过，只是因为断言对象是 v2 的 hint）。
  assert.ok(typeof command.input?.hint === 'string' && command.input.hint.includes('status'))
  assert.equal(typeof command.handler, 'function')
  assert.equal(typeof command.description, 'string')
  assert.ok(command.description.trim().length > 0, '宿主强制 description 非空')
})
