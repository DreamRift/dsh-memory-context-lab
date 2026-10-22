/**
 * 0.13.2-beta.4 守卫：第 3 轮真机排查的 3 条缺陷（N-09 / N-10 / N-11）与 3 条改进（R-01…R-03）。
 *
 * 每条断言都对应一个**用户能看到的后果**，而不是实现细节：
 *   N-09 设置页保存后，schema 里有、设置页没显示的字段必须原样保留（旧：静默重置成默认值）
 *   N-10 `/memory-lab set` 的数字参数必须是严格十进制整数，且 retain 0 合法（旧：parseInt 截断）
 *   N-11 format 4 的旧 span 行只让**这一行**落 skipped，不得让整批恢复抛异常
 *   R-01 删掉 recall 里的死分支（clamped 从未为真）
 *   R-02 history 页码与 set 同一把尺子（严格整数）
 *   R-03 status 行印出 autoRestore（三个开关都在面板上）
 *
 * 夹具一律走**产品真实入口**（真实设置卡组件、restoreReceipts、createSettingsDomain），
 * 不自己拼一个「与生产同口径」的近似物——那正是 N-06a 让测试恒真的原因。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  RECEIPT_FORMAT_BATCH_V2,
  RECEIPT_FORMAT_OPERATION,
  RECEIPT_FORMAT_SPAN,
  RECEIPT_FORMAT_SPAN_V2,
  buildBatchReceipt,
  buildReceipt,
  buildSpanReceipt,
  parseStrictInteger,
} from '../src/core.mjs'
import { archiveMac, restoreReceipts } from '../src/apply.mjs'
import { renderV2Status } from '../src/v2/runtime-render.mjs'

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src')

// ---------------------------------------------------------------- 夹具

const BODY = '一段足够长的旧历史正文，用来让回执重建有意义。'.repeat(6)
const HASH = archiveMac(BODY)

/** 冷库记录形态：头块 + 空行 + 正文 + 一个尾换行（coldRecordBody 只认这个形状）。 */
function coldRecord(body) {
  return ['# header', '- range: 1-2', '- tools: read', '- calls: call_1', '- hash: ' + HASH].join('\n')
    + '\n\n' + body + '\n'
}

function sessionWith(texts) {
  const nodes = [...texts.keys()]
  return {
    surface: { nodes },
    eventAt(seq) {
      const text = texts.get(seq)
      return text === undefined ? null : { type: 'user/message', data: { content: [{ type: 'text', text }] } }
    },
    append(type, data) {
      const seq = Math.max(...nodes) + 1
      nodes.push(seq)
      texts.set(seq, data.content[0].text)
      return { seq }
    },
  }
}

const client = {
  async getNode() { return { ok: true, content: coldRecord(BODY) } },
  async putNode() { return { ok: true } },
}

function operationReceiptText(nodeId, range) {
  return buildReceipt({
    tools: ['read'],
    range,
    callIds: ['call_1'],
    nodeId,
    hash: HASH,
    chars: BODY.length,
    tokens: 40,
    formatVersion: RECEIPT_FORMAT_OPERATION,
  })
}

function operationRow(nodeId, range, replacementSeq) {
  return {
    rangeStart: range.start,
    rangeEnd: range.end,
    nodeId,
    hash: HASH,
    chars: BODY.length,
    originalTokens: 40,
    chunkCount: 1,
    receiptFormat: RECEIPT_FORMAT_OPERATION,
    tools: ['read'],
    callIds: ['call_1'],
    replacementSeq,
  }
}

// ---------------------------------------------------------------- N-11

test('N-11 format 4 的旧 span 行：不抛异常、如实 skip、不连坐同批其它行', async () => {
  const spanText = buildSpanReceipt({
    label: '历史片段',
    range: { start: 3, end: 5 },
    nodeId: 'mcl2-aaaa-000001',
    hash: HASH,
    chars: BODY.length,
    tokens: 40,
    formatVersion: RECEIPT_FORMAT_SPAN,
  })
  const texts = new Map([[7, spanText], [8, operationReceiptText('mcl2-bbbb-000002', { start: 9, end: 10 })]])
  const session = sessionWith(texts)

  const receipts = [
    {
      rangeStart: 3, rangeEnd: 5, nodeId: 'mcl2-aaaa-000001', hash: HASH,
      chars: BODY.length, originalTokens: 40, chunkCount: 1,
      // BUG-001 的旧行形态：span 正文被记成了操作格式 4。
      receiptFormat: 4, spanKind: 'span', replacementSeq: 7,
    },
    operationRow('mcl2-bbbb-000002', { start: 9, end: 10 }, 8),
  ]

  const outcomes = await restoreReceipts({ session, client, receipts })
  assert.equal(outcomes.length, receipts.length, '每一行都必须有结局（会计不变量）')

  const span = outcomes.find((row) => row.rangeStart === 3)
  assert.equal(span.state, 'skipped')
  assert.match(span.reason, /format 4/, '必须给出专属原因，不能落进通用的「回执正文已变化」')
  assert.equal(/回执正文已变化/.test(span.reason), false, '字段缺失不得说成用户改了正文（N-06 的误报）')
  assert.match(span.reason, /memory-lab read mcl2-aaaa-000001/, '必须给出回读出路')

  const op = outcomes.find((row) => row.rangeStart === 9)
  assert.equal(op.state, 'restored', '一条旧行不得连坐整批')
})

test('N-11 单行内部异常只让该行落 skipped，同批其它行照常处理', async () => {
  const texts = new Map([
    [8, operationReceiptText('mcl2-bbbb-000002', { start: 1, end: 2 })],
    [9, operationReceiptText('mcl2-cccc-000003', { start: 3, end: 4 })],
  ])
  const session = sessionWith(texts)
  // 让第一行的表面节点读取抛错：这条异常只能影响这一行。
  const flaky = {
    ...session,
    eventAt(seq) {
      if (seq === 8) throw new Error('surface read exploded')
      return session.eventAt(seq)
    },
  }
  const receipts = [
    operationRow('mcl2-bbbb-000002', { start: 1, end: 2 }, 8),
    operationRow('mcl2-cccc-000003', { start: 3, end: 4 }, 9),
  ]
  const outcomes = await restoreReceipts({ session: flaky, client, receipts })
  assert.equal(outcomes.length, 2, '两行都必须有结局')
  const failed = outcomes.find((row) => row.rangeStart === 1)
  assert.equal(failed.state, 'skipped')
  assert.match(failed.reason, /内部错误/)
  assert.match(failed.reason, /memory-lab read/, '内部错误也必须给出回读出路')
  assert.equal(outcomes.find((row) => row.rangeStart === 3).state, 'restored')
})

test('N-11 批摘要组抛异常时整组落 skipped，后续行不受影响', async () => {
  const batchText = buildBatchReceipt({
    marker: 'MCL2',
    formatVersion: RECEIPT_FORMAT_BATCH_V2,
    runLength: 2,
    batchThreshold: 2,
    batchMembers: 2,
    members: [
      { tools: ['read'], range: { start: 1, end: 1 }, callIds: ['call_1'], nodeId: 'mcl2-dddd-000004', hash: HASH, chars: BODY.length, tokens: 40, chunks: 1 },
      { tools: ['read'], range: { start: 2, end: 2 }, callIds: ['call_2'], nodeId: 'mcl2-eeee-000005', hash: HASH, chars: BODY.length, tokens: 40, chunks: 1 },
    ],
  })
  const texts = new Map([
    [7, batchText],
    [9, operationReceiptText('mcl2-ffff-000006', { start: 5, end: 6 })],
  ])
  const session = sessionWith(texts)
  const flaky = {
    ...session,
    eventAt(seq) {
      if (seq === 7) throw new Error('batch surface read exploded')
      return session.eventAt(seq)
    },
  }
  const batchRow = (nodeId, start, callId) => ({
    rangeStart: start, rangeEnd: start, nodeId, hash: HASH, chars: BODY.length,
    originalTokens: 40, chunkCount: 1, receiptFormat: RECEIPT_FORMAT_BATCH_V2,
    tools: ['read'], callIds: [callId], replacementSeq: 7,
    batchSize: 2, batchThreshold: 2, batchMembers: 2, releaseCapped: false,
  })
  const receipts = [
    batchRow('mcl2-dddd-000004', 1, 'call_1'),
    batchRow('mcl2-eeee-000005', 2, 'call_2'),
    operationRow('mcl2-ffff-000006', { start: 5, end: 6 }, 9),
  ]
  const outcomes = await restoreReceipts({ session: flaky, client, receipts })
  assert.equal(outcomes.length, 3, '三行都必须有结局')
  for (const row of outcomes.filter((outcome) => outcome.replacementSeq === 7)) {
    assert.equal(row.state, 'skipped')
    assert.match(row.reason, /内部错误/)
  }
  assert.equal(outcomes.find((row) => row.rangeStart === 5).state, 'restored', '组异常不得连坐后续行')
})

// ---------------------------------------------------------------- N-10

test('N-10 parseStrictInteger 只接受严格十进制整数', () => {
  for (const good of ['0', '5', ' 12 ', 12, '2000000']) {
    assert.equal(parseStrictInteger(good), Number(String(good).trim()), '必须接受 ' + JSON.stringify(good))
  }
  for (const bad of ['12.7', '1e6', '10abc', '-1', '+1', '', '  ', '0x10', 'Infinity', 'NaN', null, undefined, {}, [], Number.NaN, 12.7, Infinity]) {
    assert.equal(parseStrictInteger(bad), null, '必须拒绝 ' + JSON.stringify(String(bad)))
  }
  assert.equal(parseStrictInteger('99999999999999999999'), null, '超出安全整数必须拒绝，不静默取近似值')
})

test('N-10 命令面：小数/指数/脏参数一律用法错误，retain 0 合法，回执照抄落盘值', async () => {
  const { createSettingsDomain } = await import('../src/v2/runtime-settings.mjs')
  const { DEFAULT_SETTINGS } = await import('../src/core.mjs')
  const { V2_STATE_KIND, V2_STATE_SCHEMA_VERSION } = await import('../src/v2/state.mjs')

  const dir = await mkdtemp(path.join(tmpdir(), 'mcl-beta4-set-'))
  try {
    const record = {
      directory: dir,
      state: {
        kind: V2_STATE_KIND,
        schemaVersion: V2_STATE_SCHEMA_VERSION,
        sessionId: 's1',
        key: 'k1',
        createdAt: new Date().toISOString(),
        enabled: true,
        settings: { ...DEFAULT_SETTINGS },
        archive: [],
        fullHistory: false,
      },
    }
    const domain = createSettingsDomain({
      records: new Map([['s1', record]]),
      engine: {},
      adopt: async () => null,
      logger: { warn() {} },
      sessionIdOf: () => 's1',
      onPlanFirstToggle: null,
    })
    const invocation = { agent: { session: { id: 's1' } } }
    const run = async (key, value) => {
      record.state.settings = { ...DEFAULT_SETTINGS }
      return { result: await domain.setSetting(invocation, [key, value]), settings: { ...record.state.settings } }
    }

    for (const [key, value] of [['batch', '12.7'], ['protect', '1e6'], ['batch', '10abc'], ['pressure', '2.5'], ['readlease', '1e1']]) {
      const { result } = await run(key, value)
      assert.equal(result.kind, 'error', key + ' ' + value + ' 必须被拒绝，实际落盘成功')
      assert.match(result.text, /不接受小数|不接受/, '错误文案必须说清为什么不接受：' + result.text)
    }
    // 越界仍然是错误，不静默夹取
    assert.equal((await run('retain', '201')).result.kind, 'error')
    assert.equal((await run('batch', '0')).result.kind, 'error')

    // retain 0 = 不保留最近操作（schema 与设置页都允许 0，命令面曾把合法值当错误拒掉）
    const zero = await run('retain', '0')
    assert.equal(zero.result.kind, 'success')
    assert.equal(zero.settings.retainOperations, 0)

    // 回执必须照抄**落盘的那个值**
    const echo = await run('batch', ' 20 ')
    assert.equal(echo.result.kind, 'success')
    assert.equal(echo.settings.archiveBatchSize, 20)
    assert.match(echo.result.text, /batch=20（/, '回执里的值必须与落盘一致：' + echo.result.text)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

/** 去掉 // 与 /* *\/ 注释：守卫只针对**代码**，不能因为注释里提到旧写法就假红。 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

test('N-10 命令面不再用 parseInt（数字键与页码同一把尺子）', async () => {
  for (const file of ['v2/runtime-settings.mjs', 'v2/runtime-read.mjs']) {
    const source = stripComments(await readFile(path.join(SRC, file), 'utf8'))
    assert.equal(/Number\.parseInt/.test(source), false, file + ' 不得再用 Number.parseInt（会静默截断）')
  }
  // 0.13.2-beta.5（O-01）：history 的尺子下沉到 readback 的 resolvePageSize（内部仍是
  // parseStrictInteger，且上下界都显式判）。所以这里钉的是「同一把尺子」，不是某个函数名。
  const readSource = stripComments(await readFile(path.join(SRC, 'v2', 'runtime-read.mjs'), 'utf8'))
  assert.match(readSource, /resolvePageSize\(/, 'history 的每页条数必须走 resolvePageSize（上下界同一把尺子）')
  const settingsSource = stripComments(await readFile(path.join(SRC, 'v2', 'runtime-settings.mjs'), 'utf8'))
  assert.match(settingsSource, /parseStrictInteger\(/, '数字设置必须走严格整数解析')
  const readbackSource = stripComments(await readFile(path.join(SRC, 'v2', 'readback.mjs'), 'utf8'))
  assert.match(readbackSource, /parseStrictInteger\(/, 'resolvePageSize 必须复用 parseStrictInteger，不得自造解析')
})

// ---------------------------------------------------------------- R-01 / R-02 / R-03

test('R-01 recall 不再保留 clamped 死分支', async () => {
  const source = stripComments(await readFile(path.join(SRC, 'v2', 'runtime-recall.mjs'), 'utf8'))
  assert.equal(/budgetPlan\.clamped/.test(source), false, 'parseBudgetTokens 从不返回 clamped:true，死分支必须删掉')
  assert.equal(/budgetPlan\.requested/.test(source), false, 'requested 字段根本不存在')
})

test('R-02 history 页码走严格整数，非法即用法错误', async () => {
  const source = await readFile(path.join(SRC, 'v2', 'runtime-read.mjs'), 'utf8')
  const start = source.indexOf('async function history(')
  assert.ok(start > 0)
  const body = source.slice(start, start + 1200)
  // 0.13.2-beta.5（O-01）：尺子下沉到 readback 的 resolvePageSize（内部仍是
  // parseStrictInteger），history 必须走它——上下界都显式判，不静默夹取。
  assert.match(body, /resolvePageSize\(/, '页码必须走 resolvePageSize（与命令面同一把尺子）')
  assert.match(body, /kind: 'error'/, '非法页码必须回用法错误，不得回落默认值')
})

test('R-02 同族：expand 页码同样只认严格整数（越界仍按页数钳制）', async () => {
  const { expandVoucher } = await import('../src/v2/hierarchy-coordinator.mjs')
  const source = stripComments(await readFile(path.join(SRC, 'v2', 'hierarchy-coordinator.mjs'), 'utf8'))
  assert.equal(/Number\.parseInt/.test(source), false, 'expand 页码不得再用 parseInt')
  // 行为面：非法页码必须给出用法，而不是悄悄换成第 1 页。
  const deps = { sessionDir: path.join(tmpdir(), 'mcl-beta4-novoucher-' + Date.now()) }
  const bad = await expandVoucher(deps, 'agg-x', '3.7')
  assert.match(bad.text, /必须是正整数/, '小数页码必须被拒绝：' + bad.text)
  const ok = await expandVoucher(deps, 'agg-x', '2')
  assert.match(ok.text, /不存在/, '合法页码照常进入查找（此处凭证不存在）')
})
test('R-03 status 行必须印出 autoRestore（三个开关都在面板上）', () => {
  const record = {
    state: {
      enabled: true,
      sessionId: 's1',
      directory: '/tmp/x',
      fullHistory: false,
      archive: [],
      settings: { auto: true, autoRecall: true, autoRestore: false, archiveBatchSize: 10, retainOperations: 5 },
    },
  }
  const off = renderV2Status(record)
  assert.match(off, /restore=off/, 'autoRestore 关时必须印 restore=off')
  record.state.settings.autoRestore = true
  assert.match(renderV2Status(record), /restore=on/)
})

// ---------------------------------------------------------------- N-09

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

test('N-09 设置页保存必须原样带回 schema 里每个字段（含设置页不显示的）', async () => {
  const { Config } = await import('../src/index.mjs')
  const resolved = Config?.['~standard']?.validate({})
  const schemaDefaults = resolved?.value?.defaults?.get?.()
  assert.ok(schemaDefaults && typeof schemaDefaults === 'object', 'schema 必须能解出 defaults')

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
  const run = new Function('window', 'document', source + '\n')
  run(window, undefined)
  assert.ok(loaded, 'client.js 必须调用 window.__ModuleLoader__.load')

  // 夹具值：schema 的每个键都给一个**非默认**值，另加一个 schema 里还没有的
  // 未来字段——保存必须把它也带回去（白名单构造会把它吃掉）。
  const userValues = { ...schemaDefaults }
  userValues.retainOperations = 9
  userValues.archiveBatchSize = 7
  userValues.pressureGate = 33
  userValues.protectBudgetTokens = 8192
  userValues.retrievalBackend = 'local-lexical-v1'
  userValues.fullHistory = false
  userValues.__futureField = { keep: 'me' }
  const value = { defaults: userValues }

  let registered = null
  const configForms = {
    whileServed(namespaces, fn) { return fn() },
    get() { return { getSnapshot() { return { value, revision: 3 } } } },
  }
  const context = {
    slots: {
      inject(name, register) { return register() },
      register(options, component) {
        if (options.name === 'plugins.row.config') registered = { options, component }
        return () => {}
      },
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

  let mutated = null
  const thin = { state: { value, revision: 3 }, mutate: (ops, rev) => { mutated = { ops, rev }; return Promise.resolve() } }
  // 走真实 onChange 制造 dirty，再点「保存更改」。
  const page = shim.mount(registered.component, { view: 'page', form: thin })
  const label = collect(page, (node) => node.type === 'label' && textOf(node).includes('全历史记忆上下文'))[0]
  assert.ok(label, '必须找到「全历史记忆上下文」开关（保存路径的触发点）')
  const checkbox = collect(label, (node) => node.type === 'input' && node.props && node.props.type === 'checkbox')[0]
  assert.ok(checkbox)
  checkbox.props.onChange({ target: { checked: true } })

  const page2 = shim.mount(registered.component, { view: 'page', form: thin })
  const save = collect(page2, (node) => node.type === 'button' && textOf(node).includes('保存更改'))[0]
  assert.ok(save, '勾选后必须出现「保存更改」')
  save.props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 30))

  const submitted = mutated?.ops?.find((op) => op.op === 'set' && Array.isArray(op.path) && op.path[0] === 'defaults')?.value
  assert.ok(submitted, '保存必须提交整块 defaults')

  // 核心判据：schema 的**每一个**键都必须活着回来（宿主用这份对象整体替换 defaults）。
  const lost = Object.keys(schemaDefaults).filter((key) => submitted[key] === undefined)
  assert.deepEqual(lost, [], '设置页保存抹掉了 schema 里的字段：' + lost.join(','))
  assert.equal(submitted.protectBudgetTokens, 8192, 'protectBudgetTokens 必须保留用户值')
  assert.equal(submitted.retrievalBackend, 'local-lexical-v1', 'retrievalBackend 必须保留用户值')
  assert.deepEqual(submitted.__futureField, { keep: 'me' }, '未来字段必须原样透传（白名单构造会吃掉它）')
  assert.equal(submitted.fullHistory, true, '对照：用户改的那一项必须真的提交')
  assert.equal(submitted.retainOperations, 9, '认识的字段仍要被收敛（不是原样照抄）')
  assert.equal(submitted.archiveBatchSize, 7)
})
