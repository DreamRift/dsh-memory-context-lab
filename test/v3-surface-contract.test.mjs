/**
 * 表面契约守卫（0.14.0-beta.10 转正批的 P0 回归）。
 *
 * 这一批在真机上炸了两次，两次都不是「功能不对」而是**宿主契约被破坏**：
 *
 * 1. **输入框消失**：`package.json` 还声明着 `dsh.client` 与 `exports["./client"]`，
 *    而 `src/client.js` 已随 v2 退场删掉。宿主的 `ClientModuleRegistry` 在**构造期**
 *    扫描每个包的客户端面，读不到 bundle 就抛 `ClientPackageCompositionError`——
 *    整个 web 客户端装配失败，`__DSH_BOOT__` 不注入，界面连输入框都不渲染。
 *    这类悬空引用**不报插件错误**，只表现为「界面没了」，所以必须有静态守卫。
 * 2. **插件加载失败**：入口用 `ctx.inject('commands', null)` 取服务句柄。宿主的
 *    `inject()` 语义是「启动一个子插件」，实现里直接取 `callback.name`——传 null
 *    在 apply 期抛 TypeError，插件 fiber 直接 FAILED。
 *
 * 本文件把这几个契约钉在测试里：**改回去必红**。它不是「实现说明书」，
 * 是「宿主契约的可执行副本」：断言形式尽量贴宿主源码（dsh-commands 的
 * `{kind,text}`、cordis 的 `inject(deps, callback)` 签名）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { attachV3Engine } from '../src/v3/entry/v3-entry.mjs'
import { createV3Runtime } from '../src/v3/composition/composition.mjs'
import { userInputTextOf } from '../src/v3/domain/session/user-input.mjs'
import { PLUGIN_SOURCE_KIND } from '../src/v3/contracts/sources.mjs'
import { readFile as readJsonFile } from 'node:fs/promises'

const SRC = path.dirname(fileURLToPath(import.meta.url))
const PKG = path.join(SRC, '..', 'package.json')
const ENTRY = path.join(SRC, '..', 'src', 'index.mjs')

/** 临时 DSH home：入口的 apply() 会解析 $DSH_HOME/.memory-context-lab/v3。 */
async function withTempHome(body) {
  const home = await mkdtemp(path.join(tmpdir(), 'mcl-surface-home-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    return await body(home)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * 宿主 ctx 替身：**故意把契约做严**。
 * - `inject(deps, callback)` 复刻 cordis：callback 不是函数就抛（这正是 beta.10 的崩溃点）；
 * - `commands.register` 是唯一命令入口（没有 `.command()` 方法）；
 * - `effect(fn)` 立刻执行并收集返回的 disposer（真实 cordis 亦然）。
 */
function createHostStub() {
  const listeners = []
  const effects = []
  const warnings = []
  const stub = {
    listeners,
    effects,
    warnings,
    logger: {
      warn: (message) => warnings.push(String(message)),
      info() {},
      error: (message) => warnings.push(String(message)),
    },
    on(event, handler, options) {
      listeners.push({ event, handler, prepend: options?.prepend === true })
      return () => {}
    },
    effect(fn) {
      const disposer = fn()
      if (typeof disposer === 'function') effects.push(disposer)
      return () => {}
    },
    inject(deps, callback) {
      // 真实实现：`this.plugin({ inject, apply: callback, name: callback.name })`
      // → callback 为 null 时在 `callback.name` 处抛 TypeError。
      if (typeof callback !== 'function') throw new TypeError("Cannot read properties of null (reading 'name')")
      if (!Array.isArray(deps)) throw new TypeError('deps.every is not a function')
      return { dispose() {} }
    },
  }
  return stub
}

/** 把 commands 服务装到 stub 上（真实宿主里由 inject 声明后自动挂载）。 */
function installCommands(stub) {
  const registered = []
  stub.commands = {
    register(definition) {
      registered.push(definition)
      return () => {}
    },
  }
  stub.registered = registered
  return registered
}

test('manifest 的客户端面必须成对存在：dsh.client 与 exports["./client"] 同时声明', async () => {
  // **0.14.0-beta.13 翻转了这条断言的方向**，理由是真机事实 + 宿主源码：
  // beta.11 的 P0-A 只证明了「声明在、文件不在 → 装配期抛 ClientPackageCompositionError」，
  // 却被当成「声明该删」的依据；删掉之后设置页彻底没有入口（beta.12 补了 Config 也没用，
  // 因为 dsh-settings 的 describe() 只产出数据行，页面要靠 ui-plugin-manager 的槽位注册）。
  // 正确修复是补齐 src/client.js。于是这里的守卫变成：**声明与文件必须成对**。
  const manifest = JSON.parse(await readFile(PKG, 'utf8'))
  assert.equal(manifest.dsh?.client?.platform, 'web',
    'dsh.client 缺席 → 宿主 client-modules 的 resolveMeta 直接跳过这个包，浏览器半永不加载，设置界面无从出现')
  assert.equal(manifest.exports?.['./client'], './src/client.js',
    'exports["./client"] 是宿主定位 bundle 的唯一入口；缺席时 resolveMeta 会抛「declares dsh.client but exports no ./client bundle」')
  const clientPath = path.join(SRC, '..', manifest.exports['./client'])
  const client = await readFile(clientPath, 'utf8')
  assert.ok(client.includes('__ModuleLoader__.load'), '浏览器半必须自注册')
  assert.equal(manifest.exports?.['.'], './src/index.mjs', '宿主半入口必须保留')
  assert.equal(manifest.main, 'src/index.mjs')
})

test('入口 apply：严格宿主替身下不抛错，注册一个命令 + 两个 pre-step 监听', async () => {
  await withTempHome(async () => {
    const stub = createHostStub()
    installCommands(stub)
    const module = await import(pathToFileURL(ENTRY).href)
    assert.equal(module.name, 'memory-context-lab')
    assert.deepEqual(module.inject, ['commands'], '只声明真正使用的服务')

    await module.apply(stub, {})

    assert.equal(stub.registered.length, 1)
    assert.equal(stub.registered[0].name, 'memory-lab')
    assert.equal(stub.registered[0].definitionId, 'dsh-memory-context-lab/control')
    assert.equal(typeof stub.registered[0].description, 'string')
    assert.ok(stub.registered[0].description.trim().length > 0, '宿主强制 description 非空')

    const preStep = stub.listeners.filter((row) => row.event === 'agent/pre-step')
    assert.equal(preStep.length, 2, '摄入 + 回注：两个监听')
    assert.equal(preStep.filter((row) => row.prepend).length, 1, '只有回注 prepend')
    assert.equal(stub.effects.length, 1, '引擎回收必须登记为 effect（崩溃路径也要生效）')
  })
})

test('命令 handler 必须返回 CommandResult（裸字符串会被宿主 normalizeResult 抛 TypeError）', async () => {
  await withTempHome(async () => {
    const stub = createHostStub()
    installCommands(stub)
    const module = await import(pathToFileURL(ENTRY).href)
    await module.apply(stub, {})
    const command = stub.registered[0]

    const invocation = (rawInput) => ({ agent: { session: { id: 's-contract' } }, rawInput })
    const status = await command.handler(invocation('status'))
    assert.equal(status.kind, 'success', 'JSON: ' + JSON.stringify(status))
    assert.equal(typeof status.text, 'string')
    assert.ok(status.text.length > 0)
    // 设置页与命令面必须说同一件事：生效值要能在 status 里读到
    assert.match(status.text, /回注设置/, 'status 必须打印当前回注设置：' + status.text)

    // rawInput 是「命令名之后、含前导空格」的原文：首 token 才是子命令。
    const help = await command.handler(invocation(''))
    assert.equal(help.kind, 'success')
    assert.ok(help.text.includes('用法'), '缺子命令应回用法：' + help.text)

    const unknown = await command.handler(invocation('bogus'))
    assert.equal(unknown.kind, 'success')
    assert.ok(unknown.text.includes('用法'))

    const recallNoArg = await command.handler(invocation('recall'))
    assert.equal(recallNoArg.kind, 'error', '缺参数必须是 error 结果（宿主要求 text 非空）')
    assert.ok(recallNoArg.text.trim().length > 0)

    const readNoArg = await command.handler(invocation('read'))
    assert.equal(readNoArg.kind, 'error')

    // 拿不到会话 id 时必须给 error，而不是「尚未摄入」这种似是而非的成功。
    const noSession = await command.handler({ rawInput: 'status' })
    assert.equal(noSession.kind, 'error')
  })
})

test('回注查询词只取人类输入：runtime-context / 自家回注包不得当查询词', () => {
  const human = { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '真实问题：部署脚本' }] }
  const runtimeContext = { role: 'user', source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'Current runtime context: ...' }] }
  const ownRecall = { role: 'user', source: { kind: PLUGIN_SOURCE_KIND, form: 'recall' }, content: [{ type: 'text', text: '回注包（命中 3 条）' }] }

  assert.equal(userInputTextOf([human, runtimeContext]), '真实问题：部署脚本', '末尾的 runtime-context 不得覆盖人类输入')
  assert.equal(userInputTextOf([runtimeContext, ownRecall]), '', '没有人类输入时返回空串（调用方跳过本步，不猜）')
  assert.equal(userInputTextOf([]), '')
  assert.throws(() => userInputTextOf(undefined), (error) => error?.name === 'V3ContractViolation', '缺字段与空数组是两种事实')
})

function fakeSession(id) {
  let seq = 0
  const events = []
  const store = new Map()
  const session = {
    id,
    log: events,
    surface: { nodes: [] },
    append(type, data) {
      seq += 1
      store.set(seq, { seq, type, data })
      session.surface.nodes = [...session.surface.nodes, seq]
      return { seq }
    },
    eventAt(s) { return store.get(s) },
    deriveMessages() { return [] },
  }
  return session
}

test('recallForInjection：入参是对象且必须带 turn（旧实现传字符串 → query 恒 undefined → 回注 100% 失败）', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-recall-args-'))
  const calls = []
  const handlers = new Map()
  const ctx = {
    on(name, handler) { handlers.set(name, handler); return () => {} },
    logger: { warn() {}, info() {} },
  }
  const fakeRuntime = {
    recall: async (args) => {
      calls.push(args)
      return { injected: true, text: '回注包（命中 1 条）', hits: [{ id: 'v3r-0123456789abcdef', score: 1 }] }
    },
    handleDshEvent: async () => ({ status: 'applied' }),
    handleDshEventBatch: async (items) => items.map(() => ({ status: 'applied' })),
    // 建库路径要读断点（H-01）：替身给空清单，等价于「新会话」。
    store: { directory: root, sourceEventIds: async () => [], health: async () => ({ healthy: true, recordCount: 0 }) },
    close() {},
    metrics: () => ({}),
  }
  const engine = attachV3Engine(ctx, { v3Root: root, runtimeFactory: async () => fakeRuntime })
  try {
    const session = fakeSession('s-recall')
    await handlers.get('agent/pre-step')({ agent: { session }, messages: [], turn: 1, signal: undefined }, async () => ({ kind: 'enter', messages: [] }))
    await engine._waitForIdle()

    const outcome = await engine.recallForInjection('s-recall', '部署 脚本', { turn: 3 })
    assert.equal(outcome.status, 'injected', JSON.stringify(outcome))
    assert.deepEqual(calls.at(-1), { query: '部署 脚本', turn: 3, allowRebuild: false },
      '必须按 recall 用例的对象契约调用（字符串会被解构成 query=undefined）')

    const missingTurn = await engine.recallForInjection('s-recall', '部署', {})
    assert.equal(missingTurn.status, 'invalid-turn', '缺 turn 是可判读的失败，不是静默跳过')
    assert.equal(missingTurn.error.code, 'EINVALID_TURN')

    const stats = engine.stats().injection
    assert.equal(stats.attempted, 2)
    assert.equal(stats.injected, 1)
    assert.equal(stats.failed, 1, '失败必须计数——「回注 0 次没人发现」就是只 warn 的后果')
  } finally {
    engine.dispose()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})

test('自家生成物不入库：装配层裁决 own-source，且不消耗回合', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-own-source-'))
  const runtime = await createV3Runtime({ v3Root: root, dshSession: fakeSession('s-own') })
  try {
    const skipped = await runtime.handleDshEvent(
      { seq: 0, type: 'user/message', at: 1, data: { source: { kind: PLUGIN_SOURCE_KIND, form: 'recall' } } },
      '回注包（命中 3 条）：这些是插件自己写进来的检索结果',
    )
    assert.equal(skipped.status, 'own-source', '来源判据必须在装配层生效，不能只写在某条摄入循环里')

    const health = await runtime.store.health()
    assert.equal(health.recordCount, 0, '自家回注包不得落库（否则自我污染检索面）')

    const applied = await runtime.handleDshEvent(
      { seq: 1, type: 'user/message', at: 2, data: { source: { kind: 'user', form: null } } },
      '真实用户消息',
    )
    assert.equal(applied.status, 'applied')
    assert.equal(applied.turn, 1, '被跳过的自家事件不推进回合计数')
  } finally {
    runtime.close()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})

test('回注不被本步摄入饿死：两个真实钩子串联后仍能注入（beta.11 的 busy 死锁回归）', async () => {
  await withTempHome(async () => {
    const stub = createHostStub()
    installCommands(stub)
    const module = await import(pathToFileURL(ENTRY).href)
    await module.apply(stub, {})

    // 真实 waterfall 次序：prepend 在前（回注）、push 在后（摄入）。
    const ordered = stub.listeners
      .filter((row) => row.event === 'agent/pre-step')
      .sort((a, b) => (b.prepend === true ? 1 : 0) - (a.prepend === true ? 1 : 0))
    assert.equal(ordered.length, 2)

    let seq = 0
    const events = []
    const session = {
      id: 'sess-order',
      log: events,
      surface: { nodes: [] },
      append(type, data) {
        seq += 1
        const event = { seq, type, time: Date.now(), data }
        events.push(event)
        return event
      },
      eventAt(s) { return events.find((event) => event.seq === s) },
      deriveMessages() { return [] },
    }
    // beta.33：新对话默认关闭；本用例测回注顺序，先显式开启本对话。
    const enabled = await stub.registered[0].handler({ agent: { session }, rawInput: 'on' })
    assert.equal(enabled.kind, 'success', JSON.stringify(enabled))
    const push = (type, data) => { const event = { seq: events.length, type, time: Date.now(), data }; events.push(event) }
    const payload = (turn) => ({
      agent: { session },
      messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '部署脚本依赖哪个 node 版本' }] }],
      turn,
      step: 1,
      signal: { aborted: false },
    })
    const chain = async (index, p) => (index >= ordered.length
      ? { kind: 'enter', messages: [...p.messages] }
      : ordered[index].handler(p, () => chain(index + 1, p)))

    push('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: '部署脚本依赖 node 版本 18' }] })
    await chain(0, payload(1))
    await new Promise((resolve) => setTimeout(resolve, 300)) // 等后台建库 + 摄入

    // 这一步必然有新事件（上一轮的 assistant 回复）——旧实现正因此每步都判 busy。
    push('assistant/message', { message: { content: [{ type: 'text', text: '需要 node 18 以上' }] } })
    const decision = await chain(0, payload(2))

    const injected = decision.messages.filter((message) => message.source?.kind === PLUGIN_SOURCE_KIND)
    assert.equal(injected.length, 1, '本步必须注入一条回注包（旧实现：busy，0 条）')
    const status = await stub.registered[0].handler({ agent: { session }, rawInput: 'status' })
    assert.match(status.text, /注入 1/, 'status 必须如实显示注入次数：' + status.text)
  })
})

test('回注包上界：超长 OOV 词表必须有界，且不得带“已超限”的包注入', async () => {
  const { createRecall } = await import('../src/v3/application/recall.mjs')
  const provider = {
    async search() {
      return {
        display: [{ id: 'v3r-0123456789abcdef', score: 1 }],
        pack: [{ id: 'v3r-0123456789abcdef', score: 1 }],
        dropped: [],
        oovTerms: Array.from({ length: 3000 }, (_, i) => '未登录词' + i),
      }
    },
    async read() { return { text: '正文', record: { createdAt: 1 } } },
    async health() { return { healthy: true } },
    async capabilities() { return { name: 'fake', tier: 'T1' } },
  }
  const recall = createRecall({ provider, sessionKey: 's-cap', metrics: { counter() {}, observe() {} } })
  const out = await recall({ query: '正文', turn: 1 })
  assert.equal(out.injected, true)
  assert.ok(out.text.length <= 4000, '回注包不得超过硬顶，实际 ' + out.text.length)
  assert.match(out.text, /等 3000 个/, 'OOV 词表必须去重且有界，总数如实')
})

test('首部切片用码点尺度：代理对短文本不得被误判超长', async () => {
  const { createRecall } = await import('../src/v3/application/recall.mjs')
  const provider = {
    async search() {
      return { display: [{ id: 'v3r-0123456789abcdef', score: 1 }], pack: [{ id: 'v3r-0123456789abcdef', score: 1 }], dropped: [], oovTerms: [] }
    },
    async read() { return { text: '😀'.repeat(100), record: { createdAt: 1 } } }, // 100 码点 / 200 UTF-16
    async health() { return { healthy: true } },
    async capabilities() { return { name: 'fake', tier: 'T1' } },
  }
  const recall = createRecall({ provider, sessionKey: 's-emoji', metrics: { counter() {}, observe() {} } })
  const out = await recall({ query: '表情', turn: 1 })
  assert.equal(out.injected, true)
  assert.equal(out.text.includes('…'), false, '100 码点 < previewChars(160)，不得加省略号')
})

test('来源常量必须等于包名：own-source 判据不得与宿主看到的 kind 漂移', async () => {
  const manifest = JSON.parse(await readJsonFile(PKG, 'utf8'))
  assert.equal(PLUGIN_SOURCE_KIND, manifest.name,
    'source.kind 必须等于包名：摄入跳过判据、回注写入、宿主日志三处依赖同一个值')
})

test('批量事务失败必须回滚回合号：0 条落库不得推进 turn', async () => {
  const { createProcessTurn } = await import('../src/v3/application/process-turn.mjs')
  const seen = []
  const failingStore = {
    async transaction() { throw Object.assign(new Error('磁盘满'), { code: 'ESTORE_IO' }) },
    async readRecord() { throw new Error('unused') },
    async restore() { throw new Error('unused') },
    async forget() { throw new Error('unused') },
    async health() { return { healthy: true } },
    async rebuildIndex() {},
    async listVouchers() { return [] },
    async sourceEventIds() { return [] },
  }
  const processTurn = createProcessTurn({
    store: failingStore,
    clock: { now: () => 1 },
    random: { uuid: () => 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' },
    metrics: { counter() {}, observe: (name, value) => seen.push(value) },
    ownSourceKinds: ['dsh-memory-context-lab'],
  })
  const event = (seq) => ({ id: 'dsh-' + seq, type: 'user', sessionKey: 's', at: 1, source: { kind: 'user', form: null } })
  const failed = await processTurn({ event: event(0), text: '甲' })
  assert.equal(failed.status, 'failed')
  // 重放同一批：turn 必须仍是 1（旧实现会变成 2，批量下放大到每批 100）
  const replay = await processTurn({ event: event(1), text: '乙' })
  assert.equal(replay.turn, 1, '失败批不得推进回合号')
})

test('零命中纯壳不得注入：pack 为空时 injected 必须为 false', async () => {
  const { createRecall } = await import('../src/v3/application/recall.mjs')
  const provider = {
    // 真正的「纯壳」：检索没有任何命中（不是「命中了但放不下」——那是两回事，
    // 后者由下面的 previewChars 上界用例钉住）。
    async search() { return { display: [], pack: [], dropped: [], oovTerms: ['生僻词'] } },
    async read() { throw new Error('不该被调用') },
    async health() { return { healthy: true } },
    async capabilities() { return { name: 'fake', tier: 'T1' } },
  }
  const recall = createRecall({ provider, sessionKey: 's-shell', metrics: { counter() {}, observe() {} } })
  const out = await recall({ query: '正文', turn: 1 })
  assert.equal(out.injected, false, '不允许注入一条命中都没有的壳包')
  assert.match(out.reason, /无命中/)
})

test('previewChars 到达设置页上界仍必须注入：单条放不下时缩首部，不得退化成纯壳', async () => {
  const { createRecall, RECALL_PACK_MAX_CHARS, RECALL_PREVIEW_CHARS } = await import('../src/v3/application/recall.mjs')
  const longId = 'v3r-0123456789abcdef'
  const provider = {
    async search() { return { display: [{ id: longId, score: 1 }], pack: [{ id: longId, score: 1 }], dropped: [], oovTerms: [] } },
    async read() { return { text: 'x'.repeat(20000), record: { createdAt: 1 } } },
    async health() { return { healthy: true } },
    async capabilities() { return { name: 'fake', tier: 'T1' } },
  }
  const counters = new Map()
  const metrics = { counter: (name, n) => counters.set(name, (counters.get(name) ?? 0) + n), observe() {} }
  const recall = createRecall({ provider, sessionKey: 's-preview-edge', metrics })
  // 设置页 previewChars 的上界就是硬顶：一条命中行（含前缀）单独必然超预算。
  // 旧实现只会整条丢弃 → keep 收敛到 0 → 整包退化成「纯壳」被拒绝注入，
  // 于是一个合法设置让回注 100% 失效（观察面只显示「预算被固定行占满」）。
  const out = await recall({ query: '正文', turn: 1, previewChars: RECALL_PACK_MAX_CHARS })
  assert.equal(out.injected, true, 'previewChars 处于合法上界时回注不得整体失效')
  assert.ok(out.text.length <= RECALL_PACK_MAX_CHARS, '缩首部后总长仍不得超硬顶：' + out.text.length)
  assert.match(out.text, /…/, '被压短的行必须以省略号明示截断')
  // 首部必须真的短于请求值（否则等于没缩，只是恰好装下了）：
  // 用「包长 == 硬顶」之外的证据——原文 20000 字符，若首部没被压短，行内会带满 4000 个 x。
  const longestRun = Math.max(...(out.text.match(/x+/g) ?? []).map((s) => s.length))
  assert.ok(longestRun < RECALL_PACK_MAX_CHARS, '首部未被压短：行内仍有 ' + longestRun + ' 个连续原文')
  assert.equal(counters.get('v3.recall.preview-shrunk'), 1, '缩首部必须计数（可观测）')
  // 默认值不受影响：常规设置下仍按 previewChars 原样切片
  const normal = await recall({ query: '正文', turn: 2, previewChars: RECALL_PREVIEW_CHARS })
  assert.equal(normal.injected, true)
  assert.ok(normal.text.length <= RECALL_PACK_MAX_CHARS)
})

test('设置面：入口导出 Config，字段全部 volatile（宿主设置页的唯一来源）', async () => {
  const module = await import(pathToFileURL(ENTRY).href)
  assert.ok(module.Config, '缺 Config = 宿主 dsh-settings 没有可渲染的 schema，设置页整块消失')
  assert.equal(typeof module.Config.toJSON, 'function', '宿主用 toJSON() 取表单结构')
  const json = module.Config.toJSON()
  // toJSON 是引用图：顶层 {uid, refs}，根节点是 refs[uid]
  const root = json.refs?.[json.uid] ?? json
  const dict = root.dict ?? {}
  const refs = json.refs ?? {}
  const fields = Object.keys(dict)
  assert.deepEqual(fields.sort(), ['autoRestore', 'coolingGate', 'enabled', 'fullHistory', 'limit', 'packMinScore', 'planFirst', 'previewChars', 'queryMaxChars'])
  // volatileForm 只渲染 meta.volatile 的字段；少一个就少一个控件
  for (const [name, ref] of Object.entries(dict)) {
    const node = refs[ref] ?? ref
    assert.equal(node?.meta?.volatile, true, name + ' 必须 volatile，否则设置页不显示该字段')
  }
  // 默认值必须能被标准校验器补齐（cordis 用 ~standard.validate 解析配置）
  const parsed = module.Config['~standard'].validate({})
  assert.equal(parsed.issues, undefined)
  assert.deepEqual(module.readSettings(parsed.value), module.SETTINGS_DEFAULTS)
})

test('设置生效：enabled=false 不注入；查询词按 queryMaxChars 截断后交给检索', async () => {
  const module = await import(pathToFileURL(ENTRY).href)
  const disabled = await runChainWithConfig(module, { enabled: false })
  assert.equal(disabled.injected, 0, '关掉回注后不得追加回注消息')

  const settings = module.readSettings(module.Config['—invalid—'] ?? undefined)
  assert.deepEqual(settings, module.SETTINGS_DEFAULTS, '配置缺失/非法一律回落默认值，不猜')

  // 查询截断 + 参数透传：用替身 runtime 观察 recallForInjection 的实参
  await withTempHome(async () => {
    const calls = []
    const handlers = new Map()
    const ctx = {
      on(name, handler) { handlers.set(name, handler); return () => {} },
      logger: { warn() {}, info() {} },
    }
    const fakeRuntime = {
      recall: async (args) => { calls.push(args); return { injected: false, reason: '测试占位' } },
      handleDshEvent: async () => ({ status: 'applied' }),
      handleDshEventBatch: async (items) => items.map(() => ({ status: 'applied' })),
      store: { directory: process.env.DSH_HOME, sourceEventIds: async () => [], health: async () => ({ healthy: true }) },
      close() {},
      metrics: () => ({}),
    }
    const engine = attachV3Engine(ctx, { v3Root: process.env.DSH_HOME, runtimeFactory: async () => fakeRuntime })
    try {
      await handlers.get('agent/pre-step')({ agent: { session: fakeSession('s-settings') }, messages: [], turn: 1, signal: undefined }, async () => ({ kind: 'enter', messages: [] }))
      await engine._waitForIdle()
      await engine.recallForInjection('s-settings', '一二三四五六七八九十', {
        turn: 1, queryMaxChars: 4, limit: 3, packMinScore: 0.2, previewChars: 50,
      })
      const sent = calls.at(-1)
      assert.equal(sent.query, '一二三四', '查询词按码点截断到 queryMaxChars')
      assert.equal(sent.limit, 3)
      assert.equal(sent.packMinScore, 0.2)
      assert.equal(sent.previewChars, 50)
      assert.equal(sent.allowRebuild, false, '热路径仍不允许重建')
    } finally {
      engine.dispose()
    }
  })
})

/** 用给定配置跑一次「两个真实钩子串联」，返回追加的回注消息数。 */
async function runChainWithConfig(module, config) {
  return await withTempHome(async () => {
    const stub = createHostStub()
    installCommands(stub)
    await module.apply(stub, config)
    const ordered = stub.listeners
      .filter((row) => row.event === 'agent/pre-step')
      .sort((a, b) => (b.prepend === true ? 1 : 0) - (a.prepend === true ? 1 : 0))
    const events = []
    const session = {
      id: 'sess-settings',
      log: events,
      surface: { nodes: [] },
      append(type, data) { const event = { seq: events.length, type, time: Date.now(), data }; events.push(event); return event },
      eventAt(s) { return events.find((event) => event.seq === s) },
      deriveMessages() { return [] },
    }
    const payload = (turn) => ({
      agent: { session },
      messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '部署脚本依赖哪个 node 版本' }] }],
      turn, step: 1, signal: { aborted: false },
    })
    const chain = async (index, p) => (index >= ordered.length
      ? { kind: 'enter', messages: [...p.messages] }
      : ordered[index].handler(p, () => chain(index + 1, p)))
    events.push({ seq: 0, type: 'user/message', time: Date.now(), data: { source: { kind: 'user' }, content: [{ type: 'text', text: '部署脚本依赖 node 版本 18' }] } })
    await chain(0, payload(1))
    await new Promise((resolve) => setTimeout(resolve, 300))
    events.push({ seq: 1, type: 'assistant/message', time: Date.now(), data: { message: { content: [{ type: 'text', text: '需要 node 18 以上' }] } } })
    const decision = await chain(0, payload(2))
    return { injected: decision.messages.filter((message) => message.source?.kind === PLUGIN_SOURCE_KIND).length }
  })
}
