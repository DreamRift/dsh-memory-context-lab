/**
 * 0.13.2-beta.5 守卫：第 4 轮真机排查的 5 条缺陷（Q-01 / P-01 / M-01 / N-12 / O-01）。
 *
 * 每条断言都对应一个**用户能看到的后果**，不是实现细节：
 *   Q-01 `set autorestore off` 必须真的只停用不恢复，且窗口守卫照常生效
 *   P-01 「会话从未启用」时回读原语交 null / 业务错误，不得抛内部 TypeError
 *   M-01 设置页数字框不得把非法输入变成另一个合法值（清空→下界、2.5→3、0x10→16、2e1→20）
 *   N-12 archiveBatchSize 的 schema 域必须与 core 的 NUMERIC_SETTINGS 同域
 *   O-01 `history 999999` 必须报用法错误，不得静默夹到 2000
 *
 * 夹具一律走**产品真实入口**（createLifecycleDomain、真实设置卡组件、真实命令域），
 * 不自己拼一个「与生产同口径」的近似物——那正是 N-06a 让测试恒真的原因。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { Config } from '../src/index.mjs'
import { NUMERIC_SETTINGS, normalizeSettings } from '../src/core.mjs'
import { createLifecycleDomain } from '../src/v2/runtime-lifecycle.mjs'
import { MAX_PAGE_SIZE, listRecordsPage, packWorkingSet, readRecordById, resolvePageSize } from '../src/v2/readback.mjs'
import { createReadDomain } from '../src/v2/runtime-read.mjs'

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src')

// ---------------------------------------------------------------- Q-01

/**
 * 真实 `createLifecycleDomain` + 真实 `disable`：只把 engine 换成可观察的桩，
 * 其余依赖按生产形状注入。`runRestore` 的调用次数就是「有没有恢复」的判据。
 */
function lifecycleFixture({ autoRestore, overflow }) {
  const SESSION = 'session-beta5-autorestore'
  const calls = { restore: 0, occupancy: 0 }
  const record = {
    sessionId: SESSION,
    directory: '',
    client: null,
    state: {
      kind: 'dsh-memory-context-lab/v2/session',
      schemaVersion: 2,
      sessionId: SESSION,
      enabled: true,
      settings: { auto: true, autoRecall: true, autoRestore, archiveBatchSize: 10, retainOperations: 5 },
      archive: [],
    },
    cost: { bump() {}, snapshot() { return {} } },
  }
  // 待恢复行必须带 originalTokens / receiptTokens：restoreGrowth 的增量就是两者之差，
  // 缺了它们 growth 恒为 0，窗口守卫永远不会溢出（夹具自己把被测分支绕过去了）。
  const pending = [{ nodeId: 'mcl2-x-000001', rangeStart: 1, rangeEnd: 2, originalTokens: 30_000, receiptTokens: 120 }]
  const engine = {
    pendingReceipts: () => pending,
    restoreSkippedReceipts: () => [],
    settingsOf: (rec) => rec.state.settings,
    async measureOccupancy() {
      calls.occupancy += 1
      return { host: { assembledTokens: overflow ? 90_000 : 1_000, contextWindow: 100_000 } }
    },
    async runRestore() {
      calls.restore += 1
      return { kind: 'success', text: '（桩）', restored: 1, before: 1, stillSkipped: 0, skippedReasons: [] }
    },
  }
  const noop = () => {}
  const domain = createLifecycleDomain({
    records: new Map([[SESSION, record]]),
    factories: new Map(),
    activeOperations: new Set(),
    engine,
    labRoot: '',
    services: { get: () => undefined },
    logger: { warn: noop, info: noop, error: noop },
    sessionIdOf: () => SESSION,
    coordinator: null,
    suppressionUnavailableReason: '测试夹具',
    factoryFor: () => ({ withStore: async (fn) => fn({}) }),
    receiptTextOf: () => '',
    backendPrecheck: null,
    onEnabled: null,
    semanticBackend: null,
    semanticBackendFor: null,
    semanticBackendClose: null,
    defaultSettings: () => ({ auto: true, autoRecall: true, autoRestore }),
    defaultFullHistory: () => false,
    defaultCompressModel: () => false,
    defaultShareL2Content: () => false,
    collectForgetEntries: async () => [],
    forgetNodeBasesOf: () => [],
    planWithdrawals: async () => ({ touchedRows: [] }),
    withdrawForgottenSurfaces: async () => ({ withdrawn: 0, reconciledRows: 0 }),
    compressDepsOf: async () => ({}),
    invalidateLedgerForRestore: async () => {},
  })
  return { domain, record, calls }
}

test('Q-01 autorestore off：只停用、不恢复，回执不得宣称已恢复，并给出两条出路', async () => {
  const labRoot = await mkdtemp(path.join(tmpdir(), 'mcl-beta5-q01-'))
  try {
    const { domain, record, calls } = lifecycleFixture({ autoRestore: false, overflow: false })
    record.directory = path.join(labRoot, 'off')
    const result = await domain.disable({ agent: { session: { id: record.sessionId } } }, '测试')
    assert.equal(calls.restore, 0, 'autoRestore=off 时 off 不得调用 runRestore（旧实现照样全量恢复）')
    assert.equal(/恢复 \d+\/\d+ 段/.test(result.text), false, '回执不得写「恢复 N/M 段」：' + result.text.split('\n')[0])
    assert.match(result.text, /按设置未恢复原文/, '回执必须说清是「按设置」没恢复')
    assert.match(result.text, /\/memory-lab restore/, '必须给出显式恢复的出路')
    assert.match(result.text, /clean confirm delete-session/, '必须给出丢弃冷库的出路')
    assert.equal(result.restored, 0)
  } finally {
    await rm(labRoot, { recursive: true, force: true }).catch(() => {})
  }
})

test('Q-01 autorestore off 时窗口守卫仍然生效（守卫保护的是模型窗口，不是恢复策略）', async () => {
  const labRoot = await mkdtemp(path.join(tmpdir(), 'mcl-beta5-q01b-'))
  try {
    const { domain, record, calls } = lifecycleFixture({ autoRestore: false, overflow: true })
    record.directory = path.join(labRoot, 'off-overflow')
    const result = await domain.disable({ agent: { session: { id: record.sessionId } } }, '测试')
    assert.equal(calls.restore, 0, '溢出时更不得恢复')
    assert.equal(calls.occupancy, 1, '开关关掉后仍必须做一次占用测量（旧实现整个跳过守卫）')
    assert.match(result.text, /超出模型窗口/, '必须如实披露「现在恢复会溢出」：' + result.text)
  } finally {
    await rm(labRoot, { recursive: true, force: true }).catch(() => {})
  }
})

test('Q-01 对照：autorestore on 时照常恢复，且溢出时守卫拒绝', async () => {
  const labRoot = await mkdtemp(path.join(tmpdir(), 'mcl-beta5-q01c-'))
  try {
    const ok = lifecycleFixture({ autoRestore: true, overflow: false })
    ok.record.directory = path.join(labRoot, 'on')
    const restored = await ok.domain.disable({ agent: { session: { id: ok.record.sessionId } } }, '测试')
    assert.equal(ok.calls.restore, 1)
    assert.match(restored.text, /恢复 1\/1 段/)

    const blocked = lifecycleFixture({ autoRestore: true, overflow: true })
    blocked.record.directory = path.join(labRoot, 'on-overflow')
    const refused = await blocked.domain.disable({ agent: { session: { id: blocked.record.sessionId } } }, '测试')
    assert.equal(blocked.calls.restore, 0, '溢出时不得恢复')
    assert.match(refused.text, /窗口守卫拒绝/)
  } finally {
    await rm(labRoot, { recursive: true, force: true }).catch(() => {})
  }
})

// ---------------------------------------------------------------- P-01

test('P-01 未初始化会话：分页与装包交 null，精确回读抛带 code 的业务错误', async () => {
  const labRoot = await mkdtemp(path.join(tmpdir(), 'mcl-beta5-p01-'))
  const SESSION = 'session-never-enabled'
  try {
    assert.equal(await listRecordsPage(labRoot, SESSION, { pageSize: 10 }), null,
      'listRecordsPage 必须返回 null（旧实现在 finally 里 store.close() 抛 TypeError）')
    assert.equal(await packWorkingSet(labRoot, SESSION, { budgetTokens: 1000 }), null,
      'packWorkingSet 同上')
    await assert.rejects(
      () => readRecordById(labRoot, SESSION, 'mcl2-abc-000001'),
      (error) => {
        assert.notEqual(error.name, 'TypeError', '不得是内部 TypeError：' + error.message)
        assert.equal(error.code, 'ENOSTORE', '必须是可判别的业务错误码')
        return true
      },
    )
  } finally {
    await rm(labRoot, { recursive: true, force: true }).catch(() => {})
  }
})

test('P-01 对照：借入句柄时三个原语照常工作（不是「永远返回 null」）', async () => {
  const store = {
    listEntries() { return { entries: [], nextAfter: null, total: 0 } },
    openCalls() { return [] },
    close() {},
  }
  const page = await listRecordsPage('/nonexistent-lab', 's', { pageSize: 7, store })
  assert.equal(page.pageSize, 7)
  const packed = await packWorkingSet('/nonexistent-lab', 's', { budgetTokens: 100, store })
  assert.equal(packed.entries.length, 0)
})

// ---------------------------------------------------------------- M-01

function createReactShim() {
  const scopes = new Map()
  let current = null
  let pendingRerender = null
  function scopeFor(type) {
    let scope = scopes.get(type)
    if (!scope) { scope = { hooks: [], cursor: 0 }; scopes.set(type, scope) }
    return scope
  }
  function hookSlot(initial) {
    const scope = current
    const index = scope.cursor++
    if (scope.hooks.length <= index) scope.hooks[index] = initial()
    return scope.hooks[index]
  }
  const React = {
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...children) { return { type, props: props ?? {}, children: children.length ? children : undefined } },
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
    useEffect(fn) { const slot = hookSlot(() => ({ ran: false, cleanup: undefined })); if (!slot.ran) { slot.ran = true; slot.cleanup = fn() } return slot.cleanup },
    useRef(initial) { return hookSlot(() => ({ current: initial })) },
    useMemo(fn) { return hookSlot(() => ({ value: fn() })).value },
    useCallback(fn) { return hookSlot(() => ({ value: fn })).value },
  }
  function render(node) {
    if (node == null || typeof node !== 'object') return node
    if (Array.isArray(node)) return node.map(render)
    const props = { ...node.props }
    if (node.children !== undefined) props.children = node.children.length === 1 ? node.children[0] : node.children
    if (typeof node.type !== 'function') {
      return { type: node.type, props: node.props, children: node.children === undefined ? undefined : render(node.children) }
    }
    const previous = current
    const scope = scopeFor(node.type)
    scope.cursor = 0
    current = scope
    let output
    try { output = node.type(props) } finally { current = previous }
    return render(output)
  }
  return {
    React,
    mount(component, props) {
      const run = () => render({ type: component, props: props ?? {}, children: undefined })
      pendingRerender = run
      const tree = run()
      pendingRerender = null
      return tree
    },
  }
}

function collect(tree, predicate, out = []) {
  if (tree == null || typeof tree !== 'object') return out
  if (Array.isArray(tree)) { for (const item of tree) collect(item, predicate, out); return out }
  if (predicate(tree)) out.push(tree)
  collect(tree.children, predicate, out)
  if (tree.props && tree.props.children) collect(tree.props.children, predicate, out)
  return out
}

function textOf(tree) {
  if (tree == null) return ''
  if (typeof tree === 'string' || typeof tree === 'number') return String(tree)
  if (Array.isArray(tree)) return tree.map(textOf).join('')
  let text = ''
  if (tree.children) text += textOf(tree.children)
  if (tree.props && tree.props.children) text += textOf(tree.props.children)
  return text
}

/** 载入真实 client.js，取回设置卡组件。 */
async function loadSettingsCard() {
  const source = await readFile(path.join(SRC, 'client.js'), 'utf8')
  const shim = createReactShim()
  let loaded = null
  const window = {
    __ModuleLoader__: {
      load(entry) {
        loaded = entry
        loaded.exports = entry.factory((name) => {
          if (name === 'react') return shim.React
          throw new Error('unexpected require: ' + name)
        })
      },
    },
  }
  new Function('window', 'document', source + '\n')(window, undefined)
  assert.ok(loaded, 'client.js 必须调用 window.__ModuleLoader__.load')

  const value = {
    defaults: {
      retainOperations: 5, archiveBatchSize: 10, pressureGate: 20,
      auto: true, autoRecall: true, autoRestore: true,
      fullHistory: false, planFirst: false, compressModelDefault: false, shareL2Content: false,
      protectBudgetTokens: 8192, retrievalBackend: 'auto',
    },
  }
  let registered = null
  const configForms = {
    whileServed(namespaces, fn) { return fn() },
    get() { return { getSnapshot() { return { value, revision: 3 } } } },
  }
  const context = {
    slots: {
      inject(name, register) { return register() },
      register(options, component) { if (options.name === 'plugins.row.config') registered = { options, component }; return () => {} },
    },
    locale: { register() { return () => {} } },
    on() { return () => {} },
    effect(fn) { const r = fn(); return typeof r === 'function' ? r : () => {} },
    logger: { info() {}, warn() {}, error() {} },
    get(name) { return name === 'configForms' ? configForms : undefined },
    remote: { commands: { execute: async () => ({ ok: true, value: { kind: 'success', text: 'ok' } }) } },
  }
  loaded.exports.apply(context)
  assert.ok(registered, '设置卡必须注册（插件契约变了，本守卫需要跟着改）')
  return { shim, component: registered.component, value }
}

/** 把一段文本打进第 index 个数字框并失焦，再保存；返回提交的 defaults（未提交则 null）。 */
async function driveNumberInput({ shim, component, value }, index, text) {
  const form = {
    // 薄面 form：{ state: <快照>, mutate }——快照必须带 value，否则设置卡走「未就绪」分支。
    state: { value, revision: 3 },
    mutate(ops) { form.mutated = { ops }; return Promise.resolve() },
    mutated: null,
  }
  const page = shim.mount(component, { view: 'page', form })
  const inputs = collect(page, (n) => n.type === 'input' && n.props && n.props.type === 'number')
  assert.equal(inputs.length, 4, '设置卡必须有 4 个数字框（beta.9 P2.5 起含软保护预算）')
  inputs[index].props.onChange({ target: { value: text } })
  const page2 = shim.mount(component, { view: 'page', form })
  collect(page2, (n) => n.type === 'input' && n.props && n.props.type === 'number')[index].props.onBlur()
  const page3 = shim.mount(component, { view: 'page', form })
  const save = collect(page3, (n) => n.type === 'button' && textOf(n).includes('保存更改'))[0]
  if (!save) return { submitted: null, page: page3 }
  save.props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 20))
  const submitted = form.mutated?.ops?.find((op) => op.op === 'set' && Array.isArray(op.path) && op.path[0] === 'defaults')?.value ?? null
  return { submitted, page: page3 }
}

test('M-01 设置页数字框：非法输入不落盘、回落原值，且给出提示', async () => {
  const card = await loadSettingsCard()
  // 输入框顺序：0 = 保留最近操作，1 = 归档批量，2 = 压力闸门，3 = 软保护预算
  const cases = [
    [3, '', 'protectBudgetTokens', '清空「软保护预算」不得被写成下界 0'],
    [3, '2.5', 'protectBudgetTokens', '2.5 不得被静默四舍五入'],
    [1, '', 'archiveBatchSize', '清空「归档批量」不得被写成下界 1'],
    [0, '', 'retainOperations', '清空「保留最近操作」不得被写成 0'],
    [0, '2.5', 'retainOperations', '2.5 不得被静默四舍五入成 3'],
    [1, '0x10', 'archiveBatchSize', '0x10 不得被当成 16'],
    [1, '2e1', 'archiveBatchSize', '2e1 不得被当成 20（命令面拒绝指数写法）'],
  ]
  for (const [index, text, key, message] of cases) {
    const { submitted, page } = await driveNumberInput(card, index, text)
    assert.equal(submitted, null, message + '（旧实现会提交一个被改过的值；key=' + key + '）')
    assert.match(textOf(page), /只接受/, '拒绝时必须在界面上说出来，不得静默回落：' + textOf(page).slice(0, 200))
  }
})

test('M-01 对照：合法值照常写入，越界仍按既有设计夹到边界', async () => {
  const card = await loadSettingsCard()
  const seven = await driveNumberInput(card, 0, '7')
  assert.equal(seven.submitted?.retainOperations, 7, '合法值必须写入')
  const overflow = await driveNumberInput(card, 0, '999')
  assert.equal(overflow.submitted?.retainOperations, 200, '越界夹到上界是既有设计，不改成拒绝')
})

// ---------------------------------------------------------------- N-12

test('N-12 每个数字设置的 schema 域必须与 core 的 NUMERIC_SETTINGS 同域', () => {
  const fieldOf = { retain: 'retainOperations', batch: 'archiveBatchSize', protect: 'protectBudgetTokens', pressure: 'pressureGate' }
  for (const [name, spec] of Object.entries(NUMERIC_SETTINGS)) {
    const field = fieldOf[name]
    if (!field) continue
    const inside = Config['~standard'].validate({ defaults: { [field]: spec.min } })
    assert.equal(inside.issues, undefined, field + ' 的下界 ' + spec.min + ' 必须被 schema 接受（NUMERIC_SETTINGS 是唯一真源）')
    assert.equal(inside.value.defaults.get()[field], spec.min)
    const atMax = Config['~standard'].validate({ defaults: { [field]: spec.max } })
    assert.equal(atMax.issues, undefined, field + ' 的上界 ' + spec.max + ' 必须被 schema 接受')
    const below = Config['~standard'].validate({ defaults: { [field]: spec.min - 1 } })
    assert.ok(Array.isArray(below.issues) && below.issues.length > 0, field + ' 的下界之下（' + (spec.min - 1) + '）必须被 schema 拒绝')
    const above = Config['~standard'].validate({ defaults: { [field]: spec.max + 1 } })
    assert.ok(Array.isArray(above.issues) && above.issues.length > 0, field + ' 的上界之上（' + (spec.max + 1) + '）必须被 schema 拒绝')
    // schema 放行的值，归一化必须原样保留（旧实现在 batch=0 上让 schema 放行、归一化改成 10）。
    assert.equal(normalizeSettings({ [field]: spec.min })[field], spec.min,
      field + '：schema 接受的值必须被 normalizeSettings 原样保留')
  }
})

test('N-12 设置页的 clampInt 域与 NUMERIC_SETTINGS 同域（三个入口同一把尺子）', async () => {
  const source = await readFile(path.join(SRC, 'client.js'), 'utf8')
  const pairs = [
    ['retainOperations', NUMERIC_SETTINGS.retain],
    ['archiveBatchSize', NUMERIC_SETTINGS.batch],
    ['pressureGate', NUMERIC_SETTINGS.pressure],
    ['protectBudgetTokens', NUMERIC_SETTINGS.protect],
    ['retainReads', NUMERIC_SETTINGS.readlease],
  ]
  for (const [field, spec] of pairs) {
    const pattern = new RegExp('clampInt\\((?:inner|base)\\.' + field + ',\\s*(\\d+),\\s*(\\d+),')
    const match = pattern.exec(source)
    assert.ok(match, 'client.js 必须保留 ' + field + ' 的 clampInt 兜底形态（守卫与实现耦合，改动时同步）')
    assert.equal(Number(match[1]), spec.min, field + ' 的设置页下界必须等于 NUMERIC_SETTINGS（schema/命令面/设置页同一域）')
    assert.equal(Number(match[2]), spec.max, field + ' 的设置页上界必须等于 NUMERIC_SETTINGS')
  }
})

// ---------------------------------------------------------------- O-01

test('O-01 resolvePageSize：上下界都显式判，不静默夹取', () => {
  assert.deepEqual(resolvePageSize(5), { ok: true, value: 5, clamped: false })
  assert.deepEqual(resolvePageSize(undefined), { ok: true, value: 200, clamped: false })
  for (const bad of ['0', '2.5', '2e1', '0x10', '-1', 'abc']) {
    const plan = resolvePageSize(bad)
    assert.equal(plan.ok, false, '必须拒绝 ' + JSON.stringify(bad))
    assert.match(plan.error, /每页条数/, '拒绝理由必须说清是哪个参数')
  }
  const big = resolvePageSize(String(MAX_PAGE_SIZE + 1))
  assert.equal(big.ok, false, '超过上限必须显式报错（夹到上限会让调用方以为自己的参数生效了）')
  assert.match(big.error, new RegExp(String(MAX_PAGE_SIZE)), '错误必须写出真实上限')
})

test('O-01 history 命令：超上界的每页条数回用法错误，不得静默改成 2000', async () => {
  const sessionId = 's1'
  const record = {
    sessionId,
    directory: path.join(tmpdir(), 'mcl-beta5-o01-none'),
    state: { enabled: true, sessionId, settings: {}, fullHistory: false, archive: [] },
    cost: { bump() {}, snapshot() { return {} } },
  }
  // 一页有内容才能走到页脚（页脚是「每页 N 条」的披露位置）。
  const fakeStore = {
    listEntries() {
      return {
        entries: [{ id: 't00000001-r0000', kind: 'turn.user', fidelity: 'verbatim', inline: {} }],
        nextAfter: null,
        total: 1,
      }
    },
    openCalls() { return [] },
    recordCount: 1,
    close() {},
  }
  const domain = createReadDomain({
    records: new Map([[sessionId, record]]),
    engine: {},
    factoryFor: () => ({ withStore: async (fn) => fn(fakeStore) }),
    adopt: async () => record,
    persistCost: async () => {},
    cardFromStore: async () => null,
    backendFor: () => null,
    backendForSession: () => null,
    labRoot: tmpdir(),
    logger: { warn() {}, info() {} },
    sessionIdOf: () => sessionId,
    recallQueryFrom: () => null,
    semanticBackendStatus: () => null,
    semanticBackendFailure: () => null,
    RECALL_STEP_FALLBACK: 0,
    parseBudgetArg: () => ({ ok: true, value: 0 }),
  })
  const invocation = { agent: { session: { id: sessionId } } }

  const tooBig = await domain.history(invocation, ['999999'])
  assert.equal(tooBig.kind, 'error', '999999 必须回用法错误（旧实现静默改成 2000 条）：' + tooBig.text)
  assert.match(tooBig.text, new RegExp(String(MAX_PAGE_SIZE)), '错误里必须写出真实上限')

  const bad = await domain.history(invocation, ['3.7'])
  assert.equal(bad.kind, 'error', '小数页码仍是用法错误（R-02 的口径不变）')

  const ok = await domain.history(invocation, ['5'])
  assert.equal(ok.kind, 'success')
  assert.match(ok.text, /每页 5 条/, '回执必须披露实际生效的每页条数：' + ok.text)
})
