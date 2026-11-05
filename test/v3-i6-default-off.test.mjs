import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { apply, offlineDiagnosticsLines } from '../src/index.mjs'
import { guardShadowPorts } from '../src/v3/application/compression-shadow.mjs'
import { MEMORY_CONTEXT_TOOL_LIST } from '../src/v3/contracts/tools.mjs'
import { createV3Runtime } from '../src/v3/composition/composition.mjs'
import { createFakeSession } from './helpers/fake-session.mjs'
import { registerMemoryContextTools } from '../src/v3/entry/tools.mjs'

const keys = ['warm', 'compiler', 'recall', 'shadow']
const previous = () => process.env.MEMORY_CONTEXT_DIAGNOSTICS
const setFlag = (value) => { if (value === undefined) delete process.env.MEMORY_CONTEXT_DIAGNOSTICS; else process.env.MEMORY_CONTEXT_DIAGNOSTICS = value }
const withFlag = async (value, body) => {
  const before = previous()
  try { setFlag(value); return await body() } finally { setFlag(before) }
}
function diagnostics() {
  const calls = { warm: 0, compiler: 0, recall: 0, shadow: 0 }
  const available = { warm: true, compiler: false, recall: true, shadow: true }
  const reasons = { warm: null, compiler: 'injected unavailable', recall: null, shadow: null }
  return {
    calls, available, reasons,
    shadow(input) { calls.shadow += 1; return { report: input.report.enabled ? { status: 'ok' } : null, comparison: null, ports: guardShadowPorts(input.ports) } },
  }
}
async function digestTree(root) {
  const rows = []
  async function walk(dir, rel = '') {
    for (const name of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = path.join(dir, name.name)
      const key = rel ? rel + '/' + name.name : name.name
      if (name.isDirectory()) await walk(child, key)
      else rows.push([key, createHash('sha256').update(await readFile(child)).digest('hex')])
    }
  }
  await walk(root)
  return rows
}

test('I6-2 default off: 固定 status 文本逐字节保持不变', async () => {
  const fixture = '会话：fixture\n· 覆盖：已摄入 0 · 可检索 未知\n· 固定工具：search/read/compact\n· 回注：未启用'
  for (const flag of [undefined, '', '0', 'true']) await withFlag(flag, async () => {
    const calls = diagnostics()
    const actual = [fixture, ...offlineDiagnosticsLines(calls, false)].join('\n')
    assert.equal(actual, fixture)
    assert.deepEqual(calls.calls, { warm: 0, compiler: 0, recall: 0, shadow: 0 })
  })
})

test('I6-2 explicit on: status diagnostic section renders all availability truthfully', async () => {
  await withFlag('1', async () => {
    const runtime = diagnostics()
    const baseline = '会话：fixture\n· 固定工具：search/read/compact'
    const output = [baseline, ...offlineDiagnosticsLines(runtime, true)].join('\n')
    for (const key of keys) assert.ok(output.includes('离线诊断模块 ' + key + '：available=' + String(runtime.available[key])))
    assert.ok(output.includes('compiler：available=false；reason=injected unavailable'))
    assert.ok(output.includes('shadow 端口守卫：ok（写入被拒绝：shadow-write-forbidden:store.write）'))
    assert.ok(output.includes('不是收益/命中率证据'))
    assert.equal(runtime.calls.shadow, 1)
  })
})

test('I6-2 explicit on: thrown diagnostic degrades to one status line', async () => {
  await withFlag('1', async () => {
    const runtime = diagnostics()
    // 这是直接注入异常（替换 runtime.shadow 抛 TypeError），不等价于真实 compiler({}) 或模块加载失败。
    runtime.shadow = () => { throw new TypeError('compiler injected failure') }
    const output = ['status fixture', ...offlineDiagnosticsLines(runtime, true)].join('\n')
    assert.match(output, /诊断不可用：compiler injected failure/)
    assert.ok(output.startsWith('status fixture\n'))
  })
})

test('I6-2 shadow diagnostic does not write files in the actual runtime store', async () => {
  const v3Root = await mkdtemp(path.join(tmpdir(), 'mcl-i6-runtime-root-'))
  const session = createFakeSession({ id: 'i6-readonly' })
  const event = session.pushUser('I6 read-only store seed')
  const runtime = await createV3Runtime({ v3Root, dshSession: session, sessionKey: session.id })
  try {
    await runtime.handleDshEvent(session.log.find((row) => row.seq === event.seq), 'I6 read-only store seed')
    const root = runtime.store.directory
    const before = await digestTree(root)
    assert.ok(before.length > 0, '先摄入一条测试事件，确保真实隔离根非空')
    await withFlag('1', async () => offlineDiagnosticsLines(runtime.diagnostics, true))
    const after = await digestTree(root)
    assert.deepEqual(after, before, '诊断执行不得改动真实隔离根任何字节')
  } finally { await runtime.close(); await rm(v3Root, { recursive: true, force: true }) }
})

test('I6-2 tool set stays invariant when flag changes', async () => {
  // 注册 sink 是 mock：验证工具定义内容，不证明宿主实际注册行为。
  const registered = []
  for (const flag of [undefined, '1']) await withFlag(flag, async () => {
    const definitions = []
    const service = { register(definition) { definitions.push(definition); return () => {} } }
    const ctx = { get(name) { return name === 'tools' ? service : undefined } }
    registerMemoryContextTools(ctx, { engine: null })
    registered.push(definitions.map(({ name, parameters, output }) => ({ name, parameters, outputSchema: output?.schema })))
  })
  assert.deepEqual(registered[0], registered[1])
  assert.deepEqual(registered[0].map((item) => item.name), [...MEMORY_CONTEXT_TOOL_LIST])
})

test('I6-2 explicit disabled argument stays off and restored after each probe', async () => {
  const before = previous()
  try {
    for (const flag of ['true', '0', '', undefined]) await withFlag(flag, async () => {
      assert.deepEqual(offlineDiagnosticsLines(diagnostics(), false), [])
    })
  } finally { setFlag(before) }
})
test('I6-2 real runtime counters stay zero while default-off status formatting runs', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-i6-runtime-'))
  const runtime = await createV3Runtime({ v3Root: root, dshSession: createFakeSession({ id: 'i6-off' }) })
  try {
    await withFlag(undefined, async () => {
      const fixture = 'status fixture\n· fixed output line'
      assert.equal([fixture, ...offlineDiagnosticsLines(runtime.diagnostics, false)].join('\n'), fixture)
      assert.deepEqual(runtime.diagnostics.calls, { warm: 0, compiler: 0, recall: 0, shadow: 0 })
    })
  } finally { await runtime.close(); await rm(root, { recursive: true, force: true }) }
})

// 本 golden 是手写快照，不是从旧实现运行时捕获的 baseline。
// 它锁定默认关闭态输出形状，防止后续改动悄悄改变；不能独立证明与原实现逐字节一致。
// 原流程保持未动，entry/composition 套件全绿仅提供间接回归支持。
test('I6-2 actual status output is byte-identical under all default-off values', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'mcl-i6-status-'))
  const oldHome = process.env.DSH_HOME
  const commands = []
  const disposers = []
  process.env.DSH_HOME = home
  const ctx = {
    logger: { warn() {}, info() {}, error() {} },
    on() { return () => {} },
    effect(fn) { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); return () => {} },
    inject() { return { dispose() {} } },
    commands: { register(definition) { commands.push(definition); return () => {} } },
    get() { return undefined },
  }
  const expected = '本会话尚未摄入：先发出任意一条消息触发一次步骤，影子库会在后台建库。\n· 本对话：已停用；回注开；覆盖 无（跟随全局设置页）\n· 模式：按轮归档（full-history）；计划先行 关；停用恢复 开\n· 生效回注设置：已关闭；条数 10；装包阈 0.5；首部 160 字符；查询上限 512 字符；全历史默认 开；轮次判定 DSH 轮次（默认）；计划先行默认 关；按步闸门 20%；按步批量 10 步；停用恢复 开\n· 固定工具：等待 tools 服务就绪（已订阅注入；就绪后注册一次）\n· 回注：尝试 0 次；注入 0；跳过 0；失败 0；上次成功：从未'
  try {
    await apply(ctx, { enabled: false })
    const session = createFakeSession({ id: 'i6-status-fixture' })
    for (const flag of [undefined, '', '0', 'true']) await withFlag(flag, async () => {
      const result = await commands[0].handler({ rawInput: 'status', agent: { session } })
      assert.equal(result.kind, 'success')
      assert.equal(result.text, expected)
      assert.ok(!/离线诊断|warm|compiler|recall|shadow/.test(result.text), '默认关闭 status 不含诊断段落或四模块标识')
    })
  } finally {
    for (const dispose of disposers.reverse()) await dispose()
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
    await rm(home, { recursive: true, force: true })
  }
})
