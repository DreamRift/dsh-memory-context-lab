/**
 * v2 门禁（`src/v2/guard.mjs`）回归测试。
 *
 * 这套用例的来源是一次只读审计的复现脚本：真实宿主布局下**每一次**退热都被门禁
 * 拒掉（仓库 fake-host 布局没有 `tool/call`，所以旧测试全绿），中断的回合被当成
 * 已曝光，重复 callId 被 Set 去重判成闭合。每条用例都对应一条产品要求，并且是
 * 「修前失败、修后通过」的形状。
 *
 * 越界说明：要求 5（全失败不得报成成功）与要求 6（注入消息必须带 id）的修复点在
 * `src/apply-engine.mjs` 与 `src/index.mjs`，不在门禁文件里。那两条用 `t.todo()`
 * 如实标出，断言真实要求，不写成假通过。
 *
 * 全程使用临时隔离根，不触碰真实会话、真实灵枢或已安装插件数据。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { apply as applyPlugin } from '../src/index.mjs'
import { FakeColdStore, FakeSession, buildSession, fakeMeter, operation } from './helpers/fake-host.mjs'
import { classifyRange, GUARD_CODES, auditPairingRecords, resolveExposureBoundary } from '../src/v2/guard.mjs'
import { createV2Runtime } from '../src/v2/runtime.mjs'
import { createEngine } from '../src/apply-engine.mjs'
import { planCooling } from '../src/apply.mjs'
import { createV2SessionState, writeV2SessionState } from '../src/v2/state.mjs'
import { RECORD_KINDS } from '../src/v2/records.mjs'

const COMMAND = 'memory-lab'

// ── 夹具 ────────────────────────────────────────────────────────────────────

/** 合成事件表读取器：`{ seq: event }` → `(seq) => event | null`。 */
function readerOf(events) {
  return (seq) => events[seq] ?? null
}

/** 一条主模型结算的助手消息（带宿主契约要求的 id / source / turn / step）。 */
function assistantMessage({ ids = [], text = null, id = 'm-1', turn = 1, step = 1, source = { kind: 'model', provider: 'fake', model: 'fake-model' } } = {}) {
  const content = ids.map((callId) => ({ type: 'tool-call', id: callId, name: 'read', arguments: '{}' }))
  if (text !== null) content.push({ type: 'text', text })
  return { type: 'assistant/message', data: { turn, step, message: { id, role: 'assistant', content, source } } }
}

/** 一条工具结果。`callId === null` 表示读不到 callId 的结果。 */
function toolResult(callId) {
  return {
    type: 'tool/result',
    data: {
      turn: 1,
      step: 1,
      message: {
        id: `r-${callId ?? 'unknown'}`,
        role: 'tool',
        content: [{ type: 'text', text: 'x' }],
        source: callId === null ? { kind: 'tool' } : { kind: 'tool', callId },
        toolCallId: callId ?? undefined,
      },
    },
  }
}

/**
 * 真实宿主布局：助手 → `tool/call`（日志专用，非 surface）→ 工具结果 → `turn/end`。
 *
 * 这正是 asar 内 `dsh-agent-loop` 的落盘顺序（appendToolCall / appendToolResult），
 * 也是审计里唯一能让生产退热 100% 失败的形状。
 */
function realisticSession({ id = 'guard-real-01', operations = 2, resultChars = 4000 } = {}) {
  const session = new FakeSession({ id })
  session.append('system/message', {
    turn: 0, step: 0,
    message: { id: 'sys', role: 'system', content: [{ type: 'text', text: 'system prompt' }], source: { kind: 'system-prompt' } },
  }, { surfaceOp: 'append' })
  session.append('user/message', {
    id: 'u1', role: 'user', content: [{ type: 'text', text: '请读文件并总结' }], source: { kind: 'user', rpcId: 'rpc-1' },
  }, { surfaceOp: 'append' })
  for (let index = 0; index < operations; index += 1) {
    const callId = `call-${index + 1}`
    session.append('assistant/message', {
      turn: index + 1, step: 1,
      message: {
        id: `m-${callId}`, role: 'assistant',
        content: [{ type: 'tool-call', id: callId, name: 'read', arguments: `{"file":"f${index + 1}.md"}` }],
        source: { kind: 'model', provider: 'fake', model: 'fake-model' },
      },
    }, { surfaceOp: 'append' })
    session.append('tool/call', { turn: index + 1, step: 1, callId, name: 'read', arguments: `{"file":"f${index + 1}.md"}` })
    session.append('tool/result', {
      turn: index + 1, step: 1,
      message: {
        id: `r-${callId}`, role: 'tool',
        content: [{ type: 'text', text: '内容'.repeat(Math.ceil(resultChars / 2)) }],
        source: { kind: 'tool', callId },
        toolCallId: callId,
      },
    }, { surfaceOp: 'append' })
    session.append('turn/end', { turn: index + 1, reason: { kind: 'complete' } })
  }
  return session
}

/** 与 `runtime.mjs` 的 `lastAssistantSeqOf` 同形的边界取数（调用方原样交给门禁）。 */
function lastAssistantSeqOf(session) {
  const nodes = session?.surface?.nodes ?? []
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    if (session.eventAt(nodes[index])?.type === 'assistant/message') return nodes[index]
  }
  return null
}

/** 门禁接线与 `runtime.mjs:217/240-253` 完全一致。 */
function guardOf(session) {
  return (record, candidate) => classifyRange({
    eventAt: (seq) => session.eventAt(seq),
    rangeStart: candidate.rangeStart,
    rangeEnd: candidate.rangeEnd,
    surfaceSeqs: session.surface.nodes,
    lastAssistantSeq: lastAssistantSeqOf(session),
  })
}

function judge(events, { rangeStart = 0, rangeEnd = Object.keys(events).length - 1, surfaceSeqs = null, lastAssistantSeq = null } = {}) {
  return classifyRange({
    eventAt: readerOf(events),
    rangeStart,
    rangeEnd,
    surfaceSeqs: surfaceSeqs ?? Object.keys(events).map(Number),
    lastAssistantSeq,
  })
}

// ── 要求 1：seq 区间 ≠ surface 节点集合 ─────────────────────────────────────

test('要求1：区间里穿插合法非 surface 审计事件必须放行，并如实记录穿插', () => {
  // 真实布局：surface = [0,1,2,4,6,8]，seq 3/5/7/9 是 tool/call 与 turn/end。
  const session = realisticSession({ operations: 2 })
  assert.deepEqual(session.surface.nodes, [0, 1, 2, 4, 6, 8], '前提：tool/call 与 turn/end 不在活动面上')

  // 第 1 个完整操作：助手调用（2）+ 结果（4），区间里夹着 seq 3 的 tool/call。
  const verdict = judge(
    Object.fromEntries(session.snapshotEvents().map((event) => [event.seq, event])),
    { rangeStart: 2, rangeEnd: 4, surfaceSeqs: session.surface.nodes, lastAssistantSeq: 6 },
  )
  assert.equal(verdict.safe, true, `真实布局的闭合已曝光操作必须放行，实际 ${verdict.code}`)
  assert.deepEqual(verdict.scan.offSurface, [], '日志专用事件不得算成「不在活动面」')
  assert.deepEqual(verdict.scan.interleaved, [3], '穿插事件必须如实记录，不得静默当成 surface 节点')
  assert.deepEqual(verdict.scan.surfaceNodes, [2, 4], 'shadow 集合只包含真正的活动面节点')
  assert.equal(verdict.exposure.verified, true, '曝光边界必须由活动面上的主模型结算证实')

  // 对照：仓库 fake-host 布局（区间内没有 tool/call）同样放行。
  const clean = buildSession({ operations: 2, id: 'guard-clean-01' })
  assert.equal(classifyRange({
    eventAt: (seq) => clean.eventAt(seq),
    rangeStart: 2,
    rangeEnd: 3,
    surfaceSeqs: clean.surface.nodes,
    lastAssistantSeq: lastAssistantSeqOf(clean),
  }).safe, true)
})

test('要求1：区间内不在活动面上的模型可见事件仍然拒绝（辅助模型请求／已被替换的旧节点）', () => {
  // seq 3 是 tool/result 却不在活动面上：主模型没有收到它，退热会把它抹掉。
  const events = {
    1: assistantMessage({ ids: ['X'] }),
    2: toolResult('X'),
    3: toolResult('Y'),
    4: assistantMessage({ text: '完成', id: 'm-2', turn: 2 }),
  }
  const verdict = judge(events, { rangeStart: 1, rangeEnd: 3, surfaceSeqs: [1, 2, 4], lastAssistantSeq: 4 })
  assert.equal(verdict.safe, false)
  assert.equal(verdict.code, GUARD_CODES.NOT_IN_SURFACE)
  assert.deepEqual(verdict.scan.offSurface, [3])

  // system/message 与 developer/message 同样是模型可见事件：漏曝光一律拒绝。
  const withSystem = {
    1: assistantMessage({ ids: ['X'] }),
    2: toolResult('X'),
    3: { type: 'system/message', data: { message: { id: 's2', role: 'system', content: [{ type: 'text', text: '注入' }], source: { kind: 'system-prompt' } } } },
    4: assistantMessage({ text: '完成', id: 'm-2', turn: 2 }),
  }
  const systemVerdict = judge(withSystem, { rangeStart: 1, rangeEnd: 3, surfaceSeqs: [1, 2, 4], lastAssistantSeq: 4 })
  assert.equal(systemVerdict.code, GUARD_CODES.NOT_IN_SURFACE)
})

test('要求1：无法归类的事件类型按未知处理并拒绝，不静默当成日志专用', () => {
  const events = {
    1: assistantMessage({ ids: ['X'] }),
    2: { type: 'someone-else/unknown-projection', data: { note: '未知类型' } },
    3: toolResult('X'),
    4: assistantMessage({ text: '完成', id: 'm-2', turn: 2 }),
  }
  const unknown = judge(events, { rangeStart: 1, rangeEnd: 3, surfaceSeqs: [1, 3, 4], lastAssistantSeq: 4 })
  assert.equal(unknown.safe, false, '未知事件类型不得当成安全')
  assert.equal(unknown.code, GUARD_CODES.UNKNOWN_EVENT_TYPE)
  assert.deepEqual(unknown.scan.unknownTypes, [{ seq: 2, type: 'someone-else/unknown-projection' }])

  // 带 ignorable 标记的外部事件是宿主明确的「可安全跳过」，允许穿插。
  const ignorable = judge(
    { ...events, 2: { type: 'someone-else/unknown-projection', ignorable: true, data: {} } },
    { rangeStart: 1, rangeEnd: 3, surfaceSeqs: [1, 3, 4], lastAssistantSeq: 4 },
  )
  assert.equal(ignorable.safe, true, `ignorable 事件应放行，实际 ${ignorable.code}`)
  assert.deepEqual(ignorable.scan.interleaved, [2])
})

test('要求1：范围端点必须在活动面上（替换按活动面下标做，端点不在面上没有替换目标）', () => {
  const events = {
    1: assistantMessage({ ids: ['X'] }),
    2: { type: 'tool/call', data: { callId: 'X' } },
    3: toolResult('X'),
    4: assistantMessage({ text: '完成', id: 'm-2', turn: 2 }),
  }
  // 端点 2 是日志专用事件：既不是 EMPTY_RANGE，也不是「放行」。
  const verdict = judge(events, { rangeStart: 2, rangeEnd: 2, surfaceSeqs: [1, 3, 4], lastAssistantSeq: 4 })
  assert.equal(verdict.safe, false)
  assert.equal(verdict.code, GUARD_CODES.NOT_IN_SURFACE)
})

// ── 要求 2：重复／孤儿／未闭合／不明确的工具调用组 ──────────────────────────

test('要求2：重复、孤儿、未闭合、乱序、嵌套的调用组一律拒绝，合法穿插仍放行', () => {
  // 边界声明取 100（区间之外）：这些合成事件不是真实结算，这里只看配对判定。
  const cases = [
    ['闭合：调用 + 同范围结果', { 0: assistantMessage({ ids: ['X'] }), 1: toolResult('X') }, true, null],
    ['未闭合：调用没有结果', { 0: assistantMessage({ ids: ['X'] }) }, false, GUARD_CODES.UNCLOSED_PAIR],
    ['孤儿结果：结果没有调用', { 0: toolResult('X') }, false, GUARD_CODES.ORPHAN_RESULT],
    ['结果读不到 callId', { 0: assistantMessage({ ids: ['X'] }), 1: toolResult(null) }, false, GUARD_CODES.UNCLOSED_PAIR],
    ['重复 callId：两次调用 X，只有一个结果', { 0: assistantMessage({ ids: ['X'] }), 1: toolResult('X'), 2: assistantMessage({ ids: ['X'] }) }, false, GUARD_CODES.DUPLICATE_CALL],
    ['重复结果：一次调用 X，两个结果都叫 X', { 0: assistantMessage({ ids: ['X'] }), 1: toolResult('X'), 2: toolResult('X') }, false, GUARD_CODES.DUPLICATE_RESULT],
    ['乱序：结果在前、调用在后', { 0: toolResult('X'), 1: assistantMessage({ ids: ['X'] }) }, false, GUARD_CODES.AMBIGUOUS_PAIR],
    ['并行结果乱序：X 的结果在 Y 之后', { 0: assistantMessage({ ids: ['X', 'Y'] }), 1: toolResult('Y'), 2: toolResult('X') }, false, GUARD_CODES.AMBIGUOUS_PAIR],
    ['嵌套：区间里还有第二个助手决策', { 0: assistantMessage({ ids: ['X'] }), 1: toolResult('X'), 2: assistantMessage({ ids: ['Y'], id: 'm-2' }), 3: toolResult('Y') }, false, GUARD_CODES.AMBIGUOUS_PAIR],
    ['读不到 callId 的调用', { 0: { type: 'assistant/message', data: { turn: 1, step: 1, message: { id: 'm', role: 'assistant', content: [{ type: 'tool-call', name: 'read' }], source: { kind: 'model' } } } }, 1: toolResult('X') }, false, GUARD_CODES.AMBIGUOUS_PAIR],
    ['并行：两个调用两个结果（合法）', { 0: assistantMessage({ ids: ['X', 'Y'] }), 1: toolResult('X'), 2: toolResult('Y') }, true, null],
  ]
  for (const [label, events, safe, code] of cases) {
    const verdict = judge(events, { rangeStart: 0, rangeEnd: Object.keys(events).length - 1, lastAssistantSeq: 100 })
    assert.equal(verdict.safe, safe, `${label}：期望 safe=${safe}，实际 ${verdict.code}`)
    if (!safe) assert.equal(verdict.code, code, `${label}：拒绝原因`)
  }
})

test('要求2：scan 保留重复计数，绝不因为 Set 去重把重复判成闭合', () => {
  const verdict = judge(
    { 0: assistantMessage({ ids: ['X'] }), 1: toolResult('X'), 2: assistantMessage({ ids: ['X'] }) },
    { rangeStart: 0, rangeEnd: 2, lastAssistantSeq: 100 },
  )
  assert.deepEqual(verdict.scan.calls, ['X', 'X'], '两次声明都要留在 scan 里')
  assert.deepEqual(verdict.scan.duplicateCalls, ['X'])
  assert.deepEqual(verdict.scan.unclosed, [], '重复声明不产生额外的未闭合调用')
})

// ── 要求 3：真实生产提交路径必须过门禁 ──────────────────────────────────────

/** Cordis 形状的最小上下文（与 test/v2-runtime.test.mjs 的 createStubContext 同形）。 */
function createStubContext({ withMeter = true } = {}) {
  const listeners = new Map()
  const commands = []
  const cleanups = []
  const warnings = []
  const agents = new Map()
  const tools = []
  const ctx = {
    logger: { info() {}, warn(message) { warnings.push(String(message)) }, error() {} },
    get(name) {
      if (name === 'tokenMeter') return withMeter ? fakeMeter : undefined
      if (name === 'llm') return { resolveModelInfo: async () => ({ context: { contextWindow: 100000 }, defaultMaxTokens: 4096 }) }
      if (name === 'agents') return { get: (id) => agents.get(id) }
      return undefined
    },
    on(event, handler, options) {
      const rows = listeners.get(event) ?? []
      if (options?.prepend) rows.unshift(handler)
      else rows.push(handler)
      listeners.set(event, rows)
      return () => listeners.set(event, (listeners.get(event) ?? []).filter((row) => row !== handler))
    },
    effect(fn) {
      const local = []
      const result = fn()
      if (result && typeof result.next === 'function') {
        let step = result.next()
        while (!step.done) { local.push(step.value); step = result.next() }
      } else if (typeof result === 'function') local.push(result)
      cleanups.push(...local)
      return () => { for (const cleanup of local.splice(0).reverse()) cleanup?.() }
    },
    commands: { register(definition) { commands.push(definition); return () => {} } },
    sessionProjections: { register() { return () => {} } },
    tools: { register(definition) { tools.push(definition); return () => {} } },
    inject(deps, callback) {
      if (deps.every((dep) => ctx[dep] !== undefined)) callback(ctx)
      return { dispose() {} }
    },
    async _dispose() { for (const cleanup of cleanups.splice(0).reverse()) { try { await cleanup?.() } catch { /* 测试里尽力而为 */ } } },
    _listeners: listeners,
    _commands: commands,
    _tools: tools,
    _warnings: warnings,
  }
  return ctx
}

function agentFor(session) {
  return {
    session,
    ctx: { tools: { schemas: () => [], restrict: () => () => {}, guard: () => () => {}, register: () => () => {} } },
    async runMaintenance(action) { return action(new AbortController().signal) },
  }
}

function run(ctx, agent, rawInput) {
  const definition = ctx._commands.find((row) => row.name === COMMAND)
  assert.ok(definition, `${COMMAND} 命令必须已注册`)
  return definition.handler({ agent, rawInput, signal: new AbortController().signal })
}

async function withTempLab(name, body) {
  const root = await mkdtemp(path.join(tmpdir(), `mcl2guard-${name}-`))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = root
  try {
    await body(path.join(root, '.memory-context-lab'))
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
}

test('要求3：插件真实入口在真实宿主布局下必须选出可退热候选（dry-run 与自动降温共用同一规划）', async () => {
  await withTempLab('dryrun', async () => {
    const ctx = createStubContext()
    await applyPlugin(ctx)
    const session = realisticSession({ operations: 2 })
    const agent = agentFor(session)
    await run(ctx, agent, 'on')
    await run(ctx, agent, 'set retain 1')
    await run(ctx, agent, 'set batch 1')
    const dry = await run(ctx, agent, 'dry-run')
    assert.match(dry.text, /已攒够 1 个，本批提交/, `真实布局必须攒够一批，实际：\n${dry.text}`)
    assert.match(dry.text, /将在单批内按 seq 从旧到新处理：2–4/, `真实布局必须选出 2–4，实际：\n${dry.text}`)
    await ctx._dispose()
  })
})

test('要求3：生产提交路径（measureOccupancy → planCooling(guard) → runBatch）在真实布局下真的归档，在途操作被拦下', async () => {
  const engine = createEngine({
    persist: async () => {},
    nodeIdFor: (record, ordinal) => `guard-node-${ordinal}`,
    hostVersion: 'guard-test',
    services: {
      get(name) {
        if (name === 'tokenMeter') return fakeMeter
        if (name === 'llm') return { resolveModelInfo: async () => ({ context: { contextWindow: 100000 }, defaultMaxTokens: 4096 }) }
        return undefined
      },
    },
    logger: { info() {}, warn() {}, error() {} },
    createClient: async () => new FakeColdStore(),
    guardUnit: (record, candidate) => guardOf(record.agent.session)(record, candidate),
  })

  function makeRecord(session) {
    return {
      agent: { session },
      state: {
        enabled: true,
        settings: { auto: true, autoRecall: true, retainOperations: 1, archiveBatchSize: 1 },
        archive: [],
        lastMeasurement: null,
        lastFailures: [],
      },
      lastAction: null,
      occupancy: null,
      occupancyError: null,
      client: null,
      clientError: null,
      cost: null,
    }
  }

  // 1) 真实布局：第 1 个操作（2–4）闭合且已曝光，必须真的提交。
  const session = realisticSession({ operations: 2 })
  const record = makeRecord(session)
  const outcome = await engine.runOnce(record, new AbortController().signal, { dryRun: false })
  assert.match(outcome.text, /已归档 1 个操作/, `真实布局必须真的归档，实际：\n${outcome.text}`)
  assert.equal(record.state.archive.filter((row) => row.status === 'applied').length, 1)
  const applied = record.state.archive.find((row) => row.status === 'applied')
  assert.equal(applied.rangeStart, 2)
  assert.equal(applied.rangeEnd, 4)
  // 活动面上确实出现了回执（替换真的发生）。
  assert.equal(session.surface.nodes.includes(applied.replacementSeq), true)

  // 2) 在途动作（调用已发出、结果未到）必须被门禁拦下，绝不进冷库。
  //    会话：两个完整操作之后，又发了一次调用但结果还没到。
  const inFlight = realisticSession({ operations: 2, id: 'guard-inflight-01' })
  inFlight.append('assistant/message', {
    turn: 3, step: 1,
    message: {
      id: 'm-call-open', role: 'assistant',
      content: [{ type: 'tool-call', id: 'call-open', name: 'read', arguments: '{}' }],
      source: { kind: 'model', provider: 'fake', model: 'fake-model' },
    },
  }, { surfaceOp: 'append' })
  inFlight.append('tool/call', { turn: 3, step: 1, callId: 'call-open', name: 'read', arguments: '{}' })
  const openSeq = inFlight.surface.nodes[inFlight.surface.nodes.length - 1]
  assert.equal(inFlight.eventAt(openSeq)?.type, 'assistant/message', '前提：在途调用的助手节点在活动面上')

  // 门禁对在途区间：未闭合配对，必须拒绝。
  const openVerdict = classifyRange({
    eventAt: (seq) => inFlight.eventAt(seq),
    rangeStart: openSeq,
    rangeEnd: openSeq,
    surfaceSeqs: inFlight.surface.nodes,
    lastAssistantSeq: openSeq,
  })
  assert.equal(openVerdict.safe, false)
  assert.equal(openVerdict.code, GUARD_CODES.NOT_YET_EXPOSED, '当前回合的助手节点首先被曝光边界挡下')

  const inFlightRecord = makeRecord(inFlight)
  const inFlightOutcome = await engine.runOnce(inFlightRecord, new AbortController().signal, { dryRun: false })
  const appliedRanges = inFlightRecord.state.archive
    .filter((row) => row.status === 'applied')
    .map((row) => row.rangeStart)
  assert.equal(
    appliedRanges.includes(openSeq),
    false,
    `在途动作不得归档，实际归档了 ${JSON.stringify(appliedRanges)}：\n${inFlightOutcome.text}`,
  )
})

test('要求3：被门禁拒绝的候选不租用节点 ID（校验先于任何副作用）', () => {
  const rented = []
  const candidate = {
    rangeStart: 2,
    rangeEnd: 3,
    shadowedSeqs: [2, 3],
    callIds: ['X'],
    tools: ['read'],
    body: 'x'.repeat(600),
    chars: 600,
    originalTokens: 900,
    chunkCount: 1,
    withinRetention: false,
  }
  const plan = planCooling({
    candidates: [candidate],
    meter: fakeMeter,
    nodeIdFor: (item) => { rented.push(item.rangeStart); return `node-${item.rangeStart}` },
    retainOperations: 0,
    batchSize: 1,
    minNetReleaseTokens: 128,
    guard: () => ({ safe: false, code: GUARD_CODES.NOT_IN_SURFACE, reason: '审计注入的拒绝' }),
  })
  assert.equal(plan.units.length, 0)
  assert.deepEqual(rented, [], '被拒候选不得留下节点声明')
  assert.equal(plan.rejected[0].reason, GUARD_CODES.NOT_IN_SURFACE)
})

// ── 要求 4：只有真主模型真的曝光过才解除保护 ────────────────────────────────

function runtimeFor() {
  return createV2Runtime({
    labRoot: 'C:/nonexistent-guard-test-lab',
    services: {
      get: (name) => (name === 'tokenMeter'
        ? fakeMeter
        : name === 'llm' ? { resolveModelInfo: async () => ({ context: { contextWindow: 100000 }, defaultMaxTokens: 4096 }) } : undefined),
    },
    logger: { info() {}, warn() {}, error() {} },
    hostVersion: 'guard-test',
    sessionIdOf: (session) => session.id,
    recallQueryFrom: () => null,
  })
}

/** 一个完整操作（2–3）+ 一条尾部助手消息；尾部形状由 `tail` 决定。 */
function sessionWithTail(tail, id) {
  const session = new FakeSession({ id })
  session.append('system/message', { turn: 0, step: 0, message: { id: 'sys', role: 'system', content: [{ type: 'text', text: 'sys' }], source: { kind: 'system-prompt' } } }, { surfaceOp: 'append' })
  session.append('user/message', { id: 'u1', role: 'user', content: [{ type: 'text', text: '做点事' }], source: { kind: 'user', rpcId: 'r' } }, { surfaceOp: 'append' })
  session.append('assistant/message', {
    turn: 1, step: 1,
    message: { id: 'm1', role: 'assistant', content: [{ type: 'tool-call', id: 'X', name: 'read', arguments: '{}' }], source: { kind: 'model', provider: 'f', model: 'f' } },
  }, { surfaceOp: 'append' })
  session.append('tool/result', {
    turn: 1, step: 1,
    message: { id: 'r1', role: 'tool', content: [{ type: 'text', text: '结果'.repeat(300) }], source: { kind: 'tool', callId: 'X' }, toolCallId: 'X' },
  }, { surfaceOp: 'append' })

  if (tail === 'completed') {
    session.append('assistant/message', {
      turn: 2, step: 1,
      message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: '我读完了，继续。' }], source: { kind: 'model', provider: 'f', model: 'f' } },
    }, { surfaceOp: 'append' })
  } else if (tail === 'interrupted') {
    // 宿主中断时的真实形状：活动面上的 assistant/message + interrupted: true。
    session.append('assistant/message', {
      turn: 2, step: 1, interrupted: true,
      message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: '（流式中断' }], source: { kind: 'model', provider: 'f', model: 'f' } },
    }, { surfaceOp: 'append' })
  } else if (tail === 'empty-content') {
    session.append('assistant/message', {
      turn: 2, step: 1,
      message: { id: 'm2', role: 'assistant', content: [], source: { kind: 'model', provider: 'f', model: 'f' } },
    }, { surfaceOp: 'append' })
  } else if (tail === 'auxiliary') {
    // 辅助模型产物：类型是 assistant/message，但不是主任务模型结算（缺 id / source / 坐标）。
    session.append('assistant/message', {
      message: { content: [{ type: 'text', text: '（标题：读文件并总结）' }] },
    }, { surfaceOp: 'append' })
  } else if (tail === 'attempt-error') {
    // 请求失败／超时：宿主落的是非 surface 的 assistant/attempt。
    session.append('assistant/attempt', { turn: 2, step: 1, stream: [] })
  }
  session.append('turn/end', { turn: 2, reason: { kind: 'complete' } })
  return session
}

test('要求4：中断与空内容的尾部不解除保护，只有完成的结算才解除', async () => {
  const runtime = runtimeFor()
  const verdicts = {}
  for (const tail of ['completed', 'interrupted', 'empty-content', 'attempt-error']) {
    const session = sessionWithTail(tail, `guard-tail-${tail}`)
    verdicts[tail] = runtime.guardCandidate({ agent: { session } }, { rangeStart: 2, rangeEnd: 3 })
  }
  assert.equal(verdicts.completed.safe, true, '完成的结算之后，该操作已曝光，可以退热')
  assert.equal(verdicts.interrupted.safe, false, '中断不产生曝光：不得解除保护')
  assert.equal(verdicts.interrupted.code, GUARD_CODES.NOT_YET_EXPOSED)
  assert.equal(verdicts['empty-content'].safe, false, '空内容消息不产生曝光：不得解除保护')
  assert.equal(verdicts['empty-content'].code, GUARD_CODES.NOT_YET_EXPOSED)
  assert.equal(verdicts['attempt-error'].safe, false, '失败／超时不产生曝光')
  // 中断与空内容的边界被下移到上一条站得住脚的结算（seq 2）。
  assert.equal(verdicts.interrupted.exposure.boundarySeq, 2)
  assert.equal(verdicts.interrupted.exposure.vetoed[0].seq, 4)
  assert.equal(verdicts.interrupted.exposure.vetoed[0].reason, 'interrupted-stream')
  assert.equal(verdicts['empty-content'].exposure.vetoed[0].reason, 'no-model-visible-message')
  await runtime.shutdown()
})

test('要求4：辅助模型产物不能当曝光边界（缺 id／source／结算坐标一律不算证据）', async () => {
  const runtime = runtimeFor()
  const session = sessionWithTail('auxiliary', 'guard-tail-aux')
  const verdict = runtime.guardCandidate({ agent: { session } }, { rangeStart: 2, rangeEnd: 3 })
  assert.equal(verdict.safe, false, '辅助模型消息不得解除保护')
  assert.equal(verdict.code, GUARD_CODES.NOT_YET_EXPOSED)
  assert.equal(verdict.exposure.vetoed[0].reason, 'no-message-id')
  assert.equal(verdict.exposure.boundarySeq, 2, '边界必须下移到真正的结算')
  await runtime.shutdown()
})

test('要求4：曝光边界缺省时按活动面自己推，绝不解释成「无边界 = 都能退」', () => {
  const events = {
    0: assistantMessage({ ids: ['X'] }),
    1: toolResult('X'),
    2: assistantMessage({ text: '完成', id: 'm-2', turn: 2 }),
  }
  const eventAt = readerOf(events)
  // 不给边界：最新助手消息（2）自己那一轮还在进行 → 2–1 之外的区间才可能已曝光。
  const derived = resolveExposureBoundary({ eventAt, surfaceSeqs: [0, 1, 2], claimedSeq: null })
  assert.equal(derived.boundarySeq, 2)
  assert.equal(derived.verified, true)
  assert.deepEqual(derived.evidence, { seq: 2, turn: 2, step: 1, messageId: 'm-2', provider: 'fake', model: 'fake-model' })
  const verdict = classifyRange({ eventAt, rangeStart: 0, rangeEnd: 1, surfaceSeqs: [0, 1, 2], lastAssistantSeq: null })
  assert.equal(verdict.safe, true, '边界之前的闭合操作已曝光，可以退热')
  // 含当前助手决策（seq 2）的区间绝不放行：那正是边界要挡的东西。
  const currentTurn = classifyRange({ eventAt, rangeStart: 0, rangeEnd: 2, surfaceSeqs: [0, 1, 2], lastAssistantSeq: null })
  assert.equal(currentTurn.safe, false, '包含最新助手决策的回合不得退热')
  assert.equal(currentTurn.code, GUARD_CODES.NOT_YET_EXPOSED)

  // 活动面上没有任何站得住脚的结算 → fenceAll：一条完成的请求都没有，什么都不许退。
  const noEvidence = resolveExposureBoundary({
    eventAt: readerOf({ 0: { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'x' }] } } } }),
    surfaceSeqs: [0],
    claimedSeq: null,
  })
  assert.equal(noEvidence.fenceAll, true)
})

// ── 要求 5：全失败不得报成成功 ──────────────────────────────────────────────

test('要求5：配对自检不得把「读不到 callId 的索引记录」当成闭合', () => {
  // 冷写成功但索引缺字段：判不出来就必须报出来，不能报 closed。
  const audit = auditPairingRecords([
    { id: 't00000001-r0001', kind: RECORD_KINDS.OPERATION_CALL, refs: { callId: 'call-1' }, inline: {} },
    { id: 't00000001-r0002', kind: RECORD_KINDS.OPERATION_RESULT, refs: {}, inline: {} },
    { id: 't00000001-r0003', kind: RECORD_KINDS.PROJECTION_SPAN, refs: {}, inline: {} },
  ])
  assert.deepEqual(audit.malformed, [{ id: 't00000001-r0002', kind: RECORD_KINDS.OPERATION_RESULT, reason: 'missing-call-id' }])
  assert.equal(audit.closed, false, '索引缺字段不得算成配对闭合')
  // 与配对无关的记录（投影跨度）不算异常。
  assert.equal(audit.malformed.some((row) => row.kind === RECORD_KINDS.PROJECTION_SPAN), false)

  const clean = auditPairingRecords([
    { id: 't00000001-r0001', kind: RECORD_KINDS.OPERATION_CALL, refs: { callId: 'call-1' }, inline: {} },
    { id: 't00000001-r0002', kind: RECORD_KINDS.OPERATION_RESULT, refs: { callId: 'call-1' }, inline: {} },
  ])
  assert.deepEqual(clean, { calls: 1, results: 1, unclosed: [], orphans: [], malformed: [], closed: true })
})

test('要求5：范围不成立时绝不放行（空区间、读不到事件、端点颠倒）', () => {
  const events = { 1: assistantMessage({ ids: ['X'] }), 2: toolResult('X'), 3: assistantMessage({ text: '完成', id: 'm-2', turn: 2 }) }
  // 没有任何调用／结果的区间：两端都在活动面上、事件都读得到、且**不在**当前回合内
  // （lastAssistantSeq 在区间之后），这样才落到 EMPTY_RANGE 而不是更靠前的
  // NOT_YET_EXPOSED（那个判定本身是对的：区间含当前助手决策时必然未曝光）。
  const empty = judge({
    1: { type: 'user/message', data: { id: 'u', role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } } },
    2: { type: 'user/message', data: { id: 'u2', role: 'user', content: [{ type: 'text', text: 'again' }], source: { kind: 'user' } } },
    3: events[3],
  }, { rangeStart: 1, rangeEnd: 2, surfaceSeqs: [1, 2, 3], lastAssistantSeq: 3 })
  assert.equal(empty.safe, false)
  assert.equal(empty.code, GUARD_CODES.EMPTY_RANGE)
  // 含当前助手决策的区间同样绝不放行（更靠前的保守判定）。
  const currentTurn = judge(events, { rangeStart: 1, rangeEnd: 3, surfaceSeqs: [1, 3], lastAssistantSeq: 3 })
  assert.equal(currentTurn.safe, false)
  assert.equal(currentTurn.code, GUARD_CODES.NOT_YET_EXPOSED)
  // 读不到事件：绝不当成「没有事件 = 安全」。
  const unreadable = classifyRange({ eventAt: () => null, rangeStart: 1, rangeEnd: 2, surfaceSeqs: [1, 2], lastAssistantSeq: 3 })
  assert.equal(unreadable.safe, false)
  assert.equal(unreadable.code, GUARD_CODES.UNKNOWN_EVENTS)
  // 端点颠倒。
  assert.equal(classifyRange({ eventAt: readerOf(events), rangeStart: 3, rangeEnd: 1, surfaceSeqs: [1, 2, 3], lastAssistantSeq: 3 }).code, GUARD_CODES.MALFORMED_RANGE)
})

test('要求5：全部单元失败时不得报成「已归档一批」（零成功不是成功）', async () => {
  const engine = createEngine({
    persist: async () => {},
    nodeIdFor: (record, ordinal) => `guard-node-${ordinal}`,
    hostVersion: 'guard-test',
    services: {
      get(name) {
        if (name === 'tokenMeter') return fakeMeter
        if (name === 'llm') return { resolveModelInfo: async () => ({ context: { contextWindow: 100000 }, defaultMaxTokens: 4096 }) }
        return undefined
      },
    },
    logger: { info() {}, warn() {}, error() {} },
    createClient: async () => ({
      async getNode() { return { ok: false, error: 'not_found' } },
      async rememberArchived() { throw new Error('冷库写入失败（测试注入）') },
      async close() {},
    }),
    guardUnit: null,
  })
  const session = realisticSession({ operations: 3, id: 'guard-allfail-01' })
  const record = {
    agent: { session },
    state: {
      enabled: true,
      // 0.13.0：验证的是「全失败不得报成已归档」，需要真的进入批次；
      // 夹具占用远低于默认闸门（20%），故显式关闸门。
      settings: { auto: true, autoRecall: true, retainOperations: 0, archiveBatchSize: 1, pressureGate: 0 },
      archive: [],
      lastMeasurement: null,
      lastFailures: [],
    },
    occupancy: null,
    occupancyError: null,
    client: null,
    clientError: null,
  }
  const outcome = await engine.runAutoCooling(record, new AbortController().signal)
  assert.notEqual(
    outcome.action,
    'applied',
    `一个单元都没成功时不得报成 applied（实际 ${JSON.stringify(outcome)}）`,
  )
  assert.equal(outcome.applied ?? 0, 0)
  // 落盘的状态也不得说成「已归档一批」：状态面与账本必须和真实结果一致。
  assert.notEqual(record.state.lastMeasurement?.kind, 'applied')
  assert.equal(record.state.lastMeasurement?.kind, 'failed')
})

test('要求5：`/memory-lab now` 的失败关闭不得被包装成 success', async () => {
  await withTempLab('nowfail', async (labRoot) => {
    const sessionId = 'guard-nowfail-01'
    const ctx = createStubContext({ withMeter: false })
    await applyPlugin(ctx)
    const session = realisticSession({ operations: 2, id: sessionId })
    const agent = agentFor(session)
    await run(ctx, agent, 'on')

    // 宿主没提供 tokenMeter ⇒ 占用测量失败关闭（apply-engine.mjs 抛 OccupancyUnavailableError）。
    // 命令面必须跟随 runOnce 的 kind:'error'，不能把「降温根本没执行」渲染成执行成功。
    const result = await run(ctx, agent, 'now')
    assert.notEqual(result.kind, 'success', `失败关闭时命令面不得报 success：${JSON.stringify(result)}`)
    assert.match(String(result.text), /失败关闭/, '失败原因要出现在命令输出里')
  })
})

// ── 要求 6：注入消息必须满足宿主消息契约 ────────────────────────────────────

test('要求6：工作状态注入消息必须带真实 id 并满足宿主消息契约', async () => {
  await withTempLab('inject', async (labRoot) => {
    const sessionId = 'guard-inject-01'
    // 预置一条 applied 回执：注入条件（本会话确实有退热历史）成立。
    const created = await createV2SessionState(labRoot, sessionId, {})
    created.state.enabled = false
    created.state.archive.push({
      status: 'applied', rangeStart: 2, rangeEnd: 3, callIds: ['call-1'], tools: ['read'],
      nodeId: 'v2node_1', hash: 'c'.repeat(64), chars: 40, originalTokens: 60,
      replacementSeq: 4, chunkCount: 1, appliedAt: '2026-10-12T00:00:00.000Z',
    })
    await writeV2SessionState(created.directory, created.state)

    const ctx = createStubContext()
    await applyPlugin(ctx)
    const session = buildSession({ operations: 2, id: sessionId })
    const agent = agentFor(session)
    await run(ctx, agent, 'on')

    /** 跑一遍 pre-step 监听，取回本次注入的工作状态卡消息。 */
    async function collectInjected() {
      let card = null
      for (const listener of ctx._listeners.get('agent/pre-step') ?? []) {
        const decision = await listener(
          { agent, signal: new AbortController().signal, turn: 1, step: 1 },
          async () => ({ kind: 'enter', messages: [{ id: 'user-1', role: 'user', content: [{ type: 'text', text: '历史里写了什么？' }], source: { kind: 'user' } }] }),
        )
        card = (decision.messages ?? []).find((message) => message.source?.form === 'working-set') ?? card
      }
      return card
    }

    const injected = await collectInjected()
    assert.ok(injected, '有退热回执时必须注入工作状态卡')

    // 宿主消息契约（dsh-session `assertMessageEventShape` / `assertSessionEventEnvelope`）：
    // append 路径不校验 id，但 `Session.create`（= resume/replay）会以
    // 「lacks an identified message」拒绝整条日志，会话就恢复不了。
    const problems = []
    if (typeof injected.id !== 'string' || injected.id === '') problems.push('missing-id')
    if (injected.role !== 'user') problems.push('wrong-role')
    if (typeof injected.source?.kind !== 'string' || injected.source.kind === '') problems.push('missing-source-kind')
    if (!Array.isArray(injected.content) || injected.content.length === 0) problems.push('missing-content')
    assert.deepEqual(problems, [], '注入消息必须满足宿主 user/message 契约')

    // 有界性：同一代投影只注入一次。pre-step 每步都跑，而状态卡自身不参与退热，
    // 每步追加一张就等于「旧状态卡无限累积」。
    const second = await collectInjected()
    assert.equal(second, null, '同一代投影的第二次 pre-step 不得重复注入同一张卡')

    // 换代后必须重新注入，且 id 必须新（复用 id 会被宿主当成同一条消息）。
    // 卡片内容来自活动面（当前请求 + 在途状态），所以换代 = 面上真的多了一条人类输入。
    session.append('user/message', {
      id: 'u2',
      role: 'user',
      content: [{ type: 'text', text: '换个任务：把这些结果整理成表格' }],
      source: { kind: 'user', rpcId: 'rpc-2' },
    }, { surfaceOp: 'append' })
    const third = await collectInjected()
    assert.ok(third, '投影换代后必须重新注入状态卡')
    assert.notEqual(third.id, injected.id, '两次注入不得复用同一个 id')
    await ctx._dispose()
  })
})
