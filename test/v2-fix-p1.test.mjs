/**
 * 0.10.1 fix-brief P1 regressions (BUG-004 ... BUG-010).
 * Each test is revert-red; all state is temporary.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { FakeSession, FakeColdStore, buildSession, fakeMeter, operation } from './helpers/fake-host.mjs'
import { apply as applyPlugin } from '../src/index.mjs'
import { createV2Runtime } from '../src/v2/runtime.mjs'
import { readV2SessionState } from '../src/v2/state.mjs'
import { V2_RECEIPT_MARKER, RECEIPT_FORMAT_BATCH, RECEIPT_FORMAT_BATCH_V2, RECEIPT_FORMAT_SPAN, buildForgetTombstone, buildSpanReceipt } from '../src/core.mjs'
import { applyOperations, planCooling, collectOperationCandidates, restoreReceipts } from '../src/apply.mjs'
import { bodyOfSpan, collectHistoryCandidates, spanLabelOf } from '../src/v2/history.mjs'
import { COMPRESS_SUBCOMMANDS, compressRun } from '../src/v2/hierarchy-coordinator.mjs'
import { loadHierarchy, HIERARCHY_ENTRY_L1, hierarchyPath } from '../src/v2/hierarchy-store.mjs'
import { renderExpansionPage } from '../src/v2/agg-voucher.mjs'
import { createMemoryContextLabProjection, initProjectionState } from '../src/projection.mjs'

async function withTemp(name, body) {
  const root = await mkdtemp(path.join(tmpdir(), `mcl-fixp1-${name}-`))
  try {
    await body(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

function makeRuntime(labRoot, { stageCompress = null } = {}) {
  const logs = { info: [], warn: [], error: [] }
  const rt = createV2Runtime({
    labRoot,
    services: {
      get: (name) => {
        if (name === 'tokenMeter') return fakeMeter
        if (name === 'llm') return { resolveModelInfo: async () => ({ context: { contextWindow: 100000 }, defaultMaxTokens: 4096 }) }
        return undefined
      },
    },
    logger: {
      info: (message) => logs.info.push(String(message)),
      warn: (message) => logs.warn.push(String(message)),
      error: (message) => logs.error.push(String(message)),
    },
    hostVersion: 'test-host',
    sessionIdOf: (session) => session.id,
    recallQueryFrom: () => null,
    defaultSettings: () => ({}),
    defaultFullHistory: () => false,
    defaultCompressModel: () => false,
    modelPhaseResolver: () => null,
    stageCompress,
  })
  return { rt, logs }
}

function agentFor(session) {
  return { session, ctx: {}, runMaintenance: async (action) => action(new AbortController().signal) }
}

function invoke(rt, agent, raw) {
  return rt.commandHandler({ agent, rawInput: raw, signal: new AbortController().signal })
}

function appendLongAssistant(session, text, id) {
  return session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: { id: `m-${id}`, role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model' } },
  }, { surfaceOp: 'append' }).seq
}

function seedAutoCoolingSession(session) {
  session.append('user/message', {
    id: 'u1',
    role: 'user',
    content: [{ type: 'text', text: '请总结' }],
    source: { kind: 'user', rpcId: 'rpc-1' },
  }, { surfaceOp: 'append' })
  appendLongAssistant(session, 'long assistant body. '.repeat(800), 'long')
  operation({ session, callId: 'call-last', toolName: 'read', args: '{"file":"x"}', result: 'short', turn: 2, step: 1 })
}

function outcomeRow(outcome) {
  return {
    rangeStart: outcome.rangeStart,
    rangeEnd: outcome.rangeEnd,
    callIds: outcome.callIds,
    tools: outcome.tools,
    nodeId: outcome.nodeId,
    hash: outcome.hash,
    chars: outcome.chars,
    originalTokens: outcome.originalTokens,
    replacementSeq: outcome.replacementSeq,
    receiptFormat: outcome.receiptFormat,
    batchSize: outcome.batchSize,
    batchThreshold: outcome.batchThreshold,
    batchMembers: outcome.batchMembers,
    releaseCapped: outcome.releaseCapped,
    spanKind: outcome.spanKind,
    spanLabel: outcome.spanLabel,
    locators: outcome.locators ?? [],
    statuses: outcome.statuses ?? [],
    chunkCount: outcome.chunkCount ?? 1,
  }
}

// ---------------------------------------------------------------- BUG-004

test('BUG-004: automatic compression hook is really called after an applied batch', async () => {
  await withTemp('bug004', async (root) => {
    let called = 0
    const { rt, logs } = makeRuntime(root, {
      stageCompress: async () => {
        called += 1
        return { triggered: true, applied: 1, rejected: 0, failures: 0 }
      },
    })
    const session = new FakeSession({ id: 'session-bug004' })
    const agent = agentFor(session)
    assert.equal((await invoke(rt, agent, 'on')).kind, 'success')
    assert.equal((await invoke(rt, agent, 'set compress on')).kind, 'success')
    assert.equal((await invoke(rt, agent, 'set batch 1')).kind, 'success')
    // 0.13.0：本用例验证的是「批归档之后的压缩钩子」，与压力无关。
    // 夹具占用只有约 4%，默认闸门（20%）会正确地拒绝归档，所以这里显式关闸门。
    assert.equal((await invoke(rt, agent, 'set pressure 0')).kind, 'success')
    seedAutoCoolingSession(session)
    const outcome = await rt.autoCooling(agent)
    assert.ok(Number(outcome.applied) > 0, JSON.stringify(outcome))
    assert.equal(called, 1)
    assert.ok(logs.info.some((line) => /层级压缩/.test(line)))
  })
})

test('BUG-004: missing stage import does not surface as ReferenceError-only warning', async () => {
  await withTemp('bug004b', async (root) => {
    const { rt, logs } = makeRuntime(root)
    const session = new FakeSession({ id: 'session-bug004b' })
    const agent = agentFor(session)
    assert.equal((await invoke(rt, agent, 'on')).kind, 'success')
    assert.equal((await invoke(rt, agent, 'set compress on')).kind, 'success')
    assert.equal((await invoke(rt, agent, 'set batch 1')).kind, 'success')
    assert.equal((await invoke(rt, agent, 'set pressure 0')).kind, 'success')
    seedAutoCoolingSession(session)
    const outcome = await rt.autoCooling(agent)
    assert.ok(Number(outcome.applied) > 0, JSON.stringify(outcome))
    assert.ok(!logs.warn.some((line) => /maybeStageCompress is not defined|ReferenceError/.test(line)), logs.warn.join(' | '))
  })
})

// ---------------------------------------------------------------- BUG-005

test('BUG-005: forget preview/undo/apply on a not-enabled session return structured errors', async () => {
  await withTemp('bug005', async (root) => {
    const { rt } = makeRuntime(root)
    const session = new FakeSession({ id: 'session-bug005' })
    const agent = agentFor(session)
    for (const [raw, code] of [
      ['forget preview kind=turn.user', 'ENOTENABLED'],
      ['forget apply t00000001-r0001', 'ENOTENABLED'],
      ['forget undo f0000001', 'ENOOP'],
    ]) {
      let result
      await assert.doesNotReject(async () => { result = await invoke(rt, agent, raw) })
      assert.equal(result.kind, 'error', JSON.stringify(result))
      assert.equal(result.code, code, raw)
      assert.ok(!/Cannot read|TypeError/.test(result.message))
    }
  })
})

// ---------------------------------------------------------------- BUG-006

test('BUG-006: expansion page 2 shows the right member texts and placeholders', () => {
  const voucher = { voucherId: 'agg-20261017-0001-abcdef', memberSeqs: [10, 11, 12, 13, 14, 15, 16], startSeq: 10, endSeq: 16 }
  const texts = ['R10', 'R11', 'R12', 'R13', 'R14', 'R15', 'R16']
  const page2 = String(renderExpansionPage({ voucher, receiptTexts: texts, page: 2, pageSize: 3 }))
  assert.ok(page2.includes('R13') && page2.includes('R14') && page2.includes('R15'), page2)
  assert.ok(!page2.includes('R10') && !page2.includes('R11') && !page2.includes('R12'), page2)
  const holey = ['R10', 'R11', 'R12', undefined, 'R14', 'R15', 'R16']
  const page2Holey = String(renderExpansionPage({ voucher, receiptTexts: holey, page: 2, pageSize: 3 }))
  assert.match(page2Holey, /seq:13 已软遗忘或不可读/)
  assert.ok(page2Holey.includes('R14') && page2Holey.includes('R15'))
})

// ---------------------------------------------------------------- BUG-007

test('BUG-007: compress run writes L1 evidence cards with member atoms', async () => {
  await withTemp('bug007', async (root) => {
    const session = new FakeSession({ id: 'session-bug007' })
    const dir = path.join(root, 'hierarchy')
    await mkdir(dir, { recursive: true })
    const ids = [1, 2, 3].map((n) => `mcl2-abc000-${String(n).padStart(6, '0')}`)
    const bodies = new Map(ids.map((id) => [id, `[工具] read\n参数：{"file_path":"C:\\\\tmp\\\\f.md","command":"cat f.md"}\n[结果]\nexit code: 0\nread ok\n`]))
    session.append('user/message', { id: 'bootstrap', role: 'user', content: [{ type: 'text', text: '会话开始' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
    for (const id of ids) {
      session.append('user/message', {
        id: `surface-${id}`,
        role: 'user',
        content: [{ type: 'text', text: [
          V2_RECEIPT_MARKER,
          '工具：read',
          '来源：seq 1–2（1 次调用，原 ≈500 token / 2000 字）',
          `冷记录：${id}`,
          'hash：deadbeef',
          'x'.repeat(3000),
        ].join('\n') }],
        source: { kind: 'user', form: 'memory-lab2-surface' },
      }, { surfaceOp: 'append' })
    }
    const deps = {
      sessionDir: dir,
      eventAt: (seq) => session.eventAt(seq),
      surfaceNodes: () => [...session.surface.nodes],
      surfaceVoucherNodes: () => [],
      getRecordBody: async (recordId) => bodies.get(recordId) ?? null,
      getRecordKind: () => 'operation.result',
      isRecordVisible: () => true,
      appendVoucherMessage: async ({ startSeq, endSeq, memberSeqs, text }) => {
        const event = session.append('user/message', { content: [{ type: 'text', text }] }, {
          surfaceOp: { op: 'replace', startSeq, endSeq },
          sourceEventSeqs: memberSeqs,
          source: { kind: 'user', form: 'memory-lab2-surface' },
        })
        return { seq: event.seq }
      },
    }
    const result = await compressRun(deps)
    assert.equal(result.applied.length, 1, JSON.stringify(result))
    const ledger = await loadHierarchy(dir)
    const l1 = [...ledger.cardsById.values()].filter((entry) => entry.kind === HIERARCHY_ENTRY_L1)
    assert.ok(l1.length >= 1)
    assert.ok(l1.some((entry) => entry.text.includes('· ')), l1.map((e) => e.text).join('---'))
  })
})

// ---------------------------------------------------------------- BUG-008

function createStubContext() {
  const commands = []
  const tools = []
  const projections = []
  const cleanups = []
  const listeners = new Map()
  const agents = new Map()
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    get(name) {
      if (name === 'tokenMeter') return fakeMeter
      if (name === 'llm') return { resolveModelInfo: async () => ({ context: { contextWindow: 100000 }, defaultMaxTokens: 4096 }) }
      if (name === 'agents') return { get: (id) => agents.get(id) }
      return undefined
    },
    on(event, handler) {
      const rows = listeners.get(event) ?? []
      rows.push(handler)
      listeners.set(event, rows)
      return () => {}
    },
    effect(fn) {
      const result = fn()
      if (result && typeof result.next === 'function') {
        let step = result.next()
        while (!step.done) { cleanups.push(step.value); step = result.next() }
      } else if (typeof result === 'function') cleanups.push(result)
      return () => {}
    },
    commands: { register(definition) { commands.push(definition); return () => {} } },
    sessionProjections: { register(definition) { projections.push(definition); return () => {} } },
    tools: { register(definition) { tools.push(definition); return () => {} } },
    inject(deps, callback) { if (deps.every((dep) => ctx[dep] !== undefined)) callback(ctx); return { dispose() {} } },
    async _dispose() { for (const fn of cleanups.splice(0).reverse()) { try { await fn?.() } catch { /* ignore */ } } },
    _commands: commands,
    _projections: projections,
    _tools: tools,
    _agents: agents,
  }
  return ctx
}

test('BUG-008: defaults.compressModelDefault=true seeds a new v2 ledger', async () => {
  await withTemp('bug008', async (root) => {
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = root
    try {
      const ctx = createStubContext()
      await applyPlugin(ctx, { defaults: { compressModelDefault: true } })
      const session = buildSession({ operations: 0, id: 'session-bug008' })
      const command = ctx._commands.find((row) => row.name === 'memory-lab')
      assert.ok(command)
      const result = await command.handler({ agent: agentFor(session), rawInput: 'on', signal: new AbortController().signal })
      assert.equal(result.kind, 'success', result.text)
      const stored = await readV2SessionState(path.join(root, '.memory-context-lab'), 'session-bug008')
      assert.equal(stored?.state?.compressModel, true)
      await ctx._dispose()
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
  })
})

// ---------------------------------------------------------------- BUG-009

test('BUG-009: projection fold resolves getter context (resume replay matches command)', () => {
  const preset = {
    id: 'custom-fold',
    name: '自定义折叠预设',
    settings: { retainOperations: 42, archiveBatchSize: 7, auto: false, autoRecall: true, autoRestore: true },
  }
  const projection = createMemoryContextLabProjection({
    getPresets: () => [preset],
    getDefaults: () => ({ retainOperations: 9, archiveBatchSize: 3, auto: true, autoRecall: true, autoRestore: true }),
    planFirstDefault: () => false,
  })
  const state = projection.apply(initProjectionState(), {
    type: 'command/run',
    data: { name: 'memory-lab', args: 'preset 自定义折叠预设' },
  })
  assert.equal(state.retainOperations, 42)
  assert.equal(state.archiveBatchSize, 7)
  assert.equal(state.auto, false)
  assert.equal(state.presetId, 'custom-fold')
})

// ---------------------------------------------------------------- BUG-010

test('BUG-010: a 2-member batch with one member missing restores the other without throwing', async () => {
  await withTemp('bug010', async () => {
    const session = buildSession({ operations: 2, resultChars: 4000 })
    const measured = fakeMeter.measure(session)
    const candidates = collectOperationCandidates({
      surfaceNodes: session.surface.nodes,
      eventAt: (seq) => session.eventAt(seq),
      measuredNodes: measured.nodes,
      retainOperations: 0,
      openTurn: null,
      archivedRanges: [],
    }).candidates
    assert.equal(candidates.length, 2)
    let ordinal = 0
    const plan = planCooling({
      candidates,
      meter: fakeMeter,
      nodeIdFor: () => `mcl2-batch-${String(++ordinal).padStart(6, '0')}`,
      retainOperations: 0,
      batchSize: 2,
      minNetReleaseTokens: 1,
    })
    assert.equal(plan.units.length, 2, JSON.stringify(plan.rejected))
    const store = new FakeColdStore()
    const outcomes = await applyOperations({ session, client: store, units: plan.units, meter: fakeMeter, hostVersion: 'test' })
    for (const outcome of outcomes) assert.equal(outcome.state, 'applied', outcome.reason)
    assert.equal(outcomes[0].replacementSeq, outcomes[1].replacementSeq)
    assert.equal(outcomes[0].receiptFormat, RECEIPT_FORMAT_BATCH_V2)
    const rows = outcomes.map(outcomeRow)
    // 模拟 forget 一组中的 1 个成员：表面摘要被换成墓碑（新 seq），归档行仍
    // 指向旧摘要 seq。可见成员必须仍能恢复原文（BUG-010 的真实 forget 形态）。
    const summarySeq = outcomes[0].replacementSeq
    const tombstone = buildForgetTombstone({
      range: { start: summarySeq, end: summarySeq },
      nodeId: rows[0].nodeId,
      hash: null,
      reason: 'test-forget-one-member',
    })
    session.append('user/message', { content: [{ type: 'text', text: tombstone }] }, {
      surfaceOp: { op: 'replace', startSeq: summarySeq, endSeq: summarySeq },
      sourceEventSeqs: [summarySeq],
      source: { kind: 'user', form: 'memory-lab2-surface' },
    })
    assert.ok(!session.surface.nodes.includes(summarySeq), '前置：摘要已被墓碑替换')
    const [restored] = await restoreReceipts({ session, client: store, receipts: [rows[0]] })
    assert.equal(restored.state, 'restored', JSON.stringify(restored))
    const body = session.eventAt(restored.restoredSeq).data.content.map((block) => block.text).join('')
    assert.ok(body.length > 100)
    assert.ok(!body.includes('软遗忘'), '恢复的是成员原文，不是墓碑')
  })
})
