/**
 * 0.10.1 fix-brief P0 regressions (BUG-001/002/003).
 *
 * Each test is revert-red: undoing the fix must turn it red.
 * All state lives under a temporary root; no real lingshu/session is touched.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { FakeSession, FakeColdStore, fakeMeter, operation } from './helpers/fake-host.mjs'
import { createV2Runtime } from '../src/v2/runtime.mjs'
import { readV2SessionState } from '../src/v2/state.mjs'
import { RECEIPT_FORMAT_SPAN, RECEIPT_FORMAT_VERSION, buildSpanReceipt, V2_RECEIPT_MARKER } from '../src/core.mjs'
import { applyOperations, planCooling, restoreReceipts } from '../src/apply.mjs'
import { bodyOfSpan, collectHistoryCandidates, spanLabelOf } from '../src/v2/history.mjs'
import { evaluateForgetProtection, resolveForgetTargets } from '../src/v2/disposition.mjs'
import { RECORD_KINDS } from '../src/v2/records.mjs'

async function withTemp(name, body) {
  const root = await mkdtemp(path.join(tmpdir(), `mcl-fix-${name}-`))
  try {
    await body(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

function makeRuntime(labRoot, { meter = fakeMeter } = {}) {
  const logs = { info: [], warn: [], error: [] }
  const logger = {
    info: (message) => logs.info.push(String(message)),
    warn: (message) => logs.warn.push(String(message)),
    error: (message) => logs.error.push(String(message)),
  }
  const rt = createV2Runtime({
    labRoot,
    services: {
      get: (name) => {
        if (name === 'tokenMeter') return meter
        if (name === 'llm') return { resolveModelInfo: async () => ({ context: { contextWindow: 100000 }, defaultMaxTokens: 4096 }) }
        return undefined
      },
    },
    logger,
    hostVersion: 'test-host',
    sessionIdOf: (session) => session.id,
    recallQueryFrom: () => null,
    defaultSettings: () => ({}),
    defaultFullHistory: () => false,
    defaultCompressModel: () => false,
    modelPhaseResolver: () => null,
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
    spanKind: outcome.spanKind,
    spanLabel: outcome.spanLabel,
    locators: outcome.locators ?? [],
    statuses: outcome.statuses ?? [],
    chunkCount: outcome.chunkCount ?? 1,
  }
}

// ---------------------------------------------------------------- BUG-003

test('BUG-003: meter.measure throws but off still completes and persists disabled', async () => {
  await withTemp('bug003', async (root) => {
    let fail = false
    const meter = {
      estimateMessage: fakeMeter.estimateMessage,
      measure(session) {
        if (fail) throw new Error('simulated meter failure')
        return fakeMeter.measure(session)
      },
    }
    const { rt, logs } = makeRuntime(root, { meter })
    const session = new FakeSession({ id: 'session-bug003' })
    const agent = agentFor(session)
    assert.equal((await invoke(rt, agent, 'on')).kind, 'success')
    const record = rt.records.get('session-bug003')
    assert.ok(record)
    record.state.archive.push({
      rangeStart: 0,
      rangeEnd: 0,
      nodeId: 'mcl2-bug003-000001',
      hash: 'deadbeef',
      status: 'applied',
      replacementSeq: null,
      receiptFormat: RECEIPT_FORMAT_VERSION,
      chunkCount: 1,
      tools: [],
      callIds: [],
      chars: 10,
      originalTokens: 3,
    })
    fail = true
    await assert.doesNotReject(() => rt.disable(record, 'session-bug003', 'test-off'))
    const stored = await readV2SessionState(root, 'session-bug003')
    assert.equal(stored?.state?.enabled, false)
    assert.ok(logs.warn.some((line) => /restore guard unavailable/.test(line)))
  })
})

// ---------------------------------------------------------------- BUG-001

test('BUG-001: archived v2 span restores byte-identically via span receipt format', async () => {
  await withTemp('bug001', async () => {
    const session = new FakeSession({ id: 'session-bug001' })
    session.append('system/message', {
      turn: 0,
      step: 0,
      message: { id: 'sys', role: 'system', content: [{ type: 'text', text: 'system prompt' }], source: { kind: 'system-prompt' } },
    }, { surfaceOp: 'append' })
    session.append('user/message', {
      id: 'u1',
      role: 'user',
      content: [{ type: 'text', text: 'read and summarize' }],
      source: { kind: 'user', rpcId: 'rpc-1' },
    }, { surfaceOp: 'append' })
    appendLongAssistant(session, 'a long assistant body. '.repeat(400), 'long')
    operation({ session, callId: 'call-last', toolName: 'read', args: '{"file":"x"}', result: 'short', turn: 2, step: 1 })

    const measured = fakeMeter.measure(session)
    const view = collectHistoryCandidates({
      surfaceNodes: session.surface.nodes,
      eventAt: (seq) => session.eventAt(seq),
      measuredNodes: measured.nodes,
      retainOperations: 0,
      openTurn: null,
      archivedRanges: [],
      minimumChars: 0,
      lastAssistantSeq: null,
      fullHistory: false,
    })
    const candidate = view.candidates.find((row) => row.spanKind !== 'operation')
    assert.ok(candidate)
    assert.equal(candidate.receiptFormat, RECEIPT_FORMAT_SPAN)
    assert.equal(candidate.spanLabel, spanLabelOf(candidate.spanKind))

    const plan = planCooling({
      candidates: [candidate],
      meter: fakeMeter,
      nodeIdFor: () => 'mcl2-span-000001',
      retainOperations: 0,
      batchSize: 1,
      minNetReleaseTokens: 1,
      receiptMarker: V2_RECEIPT_MARKER,
      receiptOf: (row, { nodeId, hash, marker }) => buildSpanReceipt({
        label: row.spanLabel,
        range: { start: row.rangeStart, end: row.rangeEnd },
        nodeId,
        hash,
        chars: row.chars,
        tokens: row.originalTokens,
        chunks: row.chunkCount ?? 1,
        marker,
      }),
    })
    assert.equal(plan.units.length, 1, JSON.stringify(plan.rejected))
    const unit = plan.units[0]
    const store = new FakeColdStore()
    const outcomes = await applyOperations({
      session,
      client: store,
      units: [unit],
      meter: fakeMeter,
      hostVersion: 'test',
      bodyOf: (liveSession, liveUnit) => bodyOfSpan(liveSession, liveUnit),
      receiptMarker: V2_RECEIPT_MARKER,
    })
    assert.equal(outcomes[0].state, 'applied', outcomes[0].reason)
    assert.equal(outcomes[0].receiptFormat, RECEIPT_FORMAT_SPAN)

    const restored = await restoreReceipts({
      session,
      client: store,
      receipts: [outcomeRow(outcomes[0])],
      receiptMarker: V2_RECEIPT_MARKER,
    })
    assert.equal(restored[0].state, 'restored', JSON.stringify(restored))
    const text = session.eventAt(restored[0].restoredSeq).data.content.map((block) => block.text).join('')
    assert.equal(text, unit.body)
  })
})

// ---------------------------------------------------------------- BUG-002

test('BUG-002: wide kind=turn.user blocks TURN_USER verbatim records; explicit only warns', async () => {
  const entries = [
    { id: 't00000001-r0001', kind: RECORD_KINDS.TURN_USER, seq: 1, refs: {}, inline: { pluginAuthored: false } },
    { id: 't00000002-r0001', kind: RECORD_KINDS.PROJECTION_SPAN, seq: 2, refs: { spanKind: 'turn.user' }, inline: { pluginAuthored: false } },
    { id: 't00000003-r0001', kind: RECORD_KINDS.TURN_USER, seq: 3, refs: {}, inline: { pluginAuthored: true } },
  ]
  const resolved = await resolveForgetTargets({ targets: ['kind=turn.user'], entries })
  assert.ok(resolved.recordIds.includes('t00000001-r0001'))
  const wide = evaluateForgetProtection({ recordIds: resolved.recordIds, entries, index: { forgotten: new Map() }, mode: 'wide' })
  assert.ok(wide.blocked.some((item) => item.id === 't00000001-r0001' && item.rule === 'human-user'))
  assert.ok(wide.blocked.some((item) => item.id === 't00000002-r0001'))
  assert.ok(!wide.blocked.some((item) => item.id === 't00000003-r0001'))

  const explicit = evaluateForgetProtection({ recordIds: ['t00000001-r0001'], entries, index: { forgotten: new Map() }, mode: 'explicit' })
  assert.ok(explicit.warnings.some((item) => item.id === 't00000001-r0001'))
  assert.ok(!explicit.blocked.some((item) => item.id === 't00000001-r0001'))
})
