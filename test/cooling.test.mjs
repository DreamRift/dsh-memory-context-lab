import test from 'node:test'
import assert from 'node:assert/strict'

import {
  applyOneOperation,
  cacheStatsOf,
  cleanDecision,
  collectOperationCandidates,
  computeOccupancy,
  formatBatchReport,
  lastUsageOf,
  recallQueryFrom,
  openTurnOf,
  planCooling,
  resolveWindow,
  restoreReceipts,
} from '../src/apply.mjs'
import {
  archiveChunkNodeId,
  coldRecordBody,
  MAX_OPERATION_BYTES,
  MIN_OPERATION_CHARS,
} from '../src/core.mjs'
import { buildSession, FakeColdStore, fakeMeter, operation, SurfaceError } from './helpers/fake-host.mjs'

function viewOf(session, { retainOperations = 0 } = {}) {
  const measured = fakeMeter.measure(session)
  return collectOperationCandidates({
    surfaceNodes: session.surface.nodes,
    eventAt: (seq) => session.eventAt(seq),
    measuredNodes: measured.nodes,
    retainOperations,
    openTurn: openTurnOf(session),
    archivedRanges: [],
    minimumChars: MIN_OPERATION_CHARS,
  })
}

function planFor(session, { retainOperations = 0, batchSize = 1, archivedRanges = [] } = {}) {
  const measured = fakeMeter.measure(session)
  const view = collectOperationCandidates({
    surfaceNodes: session.surface.nodes,
    eventAt: (seq) => session.eventAt(seq),
    measuredNodes: measured.nodes,
    retainOperations,
    openTurn: openTurnOf(session),
    archivedRanges,
    minimumChars: MIN_OPERATION_CHARS,
  })
  const plan = planCooling({
    candidates: view.candidates,
    meter: fakeMeter,
    nodeIdFor: (candidate) => `node-${candidate.rangeStart}`,
    retainOperations,
    batchSize,
    maxOperations: 64,
    minNetReleaseTokens: 128,
  })
  return { view, plan }
}

test('collects one candidate per completed operation and skips short ones', () => {
  const session = buildSession({ operations: 3, resultChars: 4000 })
  const { candidates } = viewOf(session)
  assert.equal(candidates.length, 3)
  assert.deepEqual(candidates.map((candidate) => candidate.tools), [['read'], ['edit'], ['read']])
  // The range covers the assistant node plus its single result.
  for (const candidate of candidates) {
    assert.equal(candidate.shadowedSeqs.length, 2)
    assert.equal(candidate.shadowedSeqs[0], candidate.rangeStart)
    assert.equal(candidate.shadowedSeqs[1], candidate.rangeEnd)
  }
})

test('never archives the system head or the user message', () => {
  const session = buildSession({ operations: 2, resultChars: 4000 })
  const { candidates } = viewOf(session)
  const archivedSeqs = new Set(candidates.flatMap((candidate) => candidate.shadowedSeqs))
  assert.equal(archivedSeqs.has(0), false, 'system head must be protected')
  assert.equal(archivedSeqs.has(1), false, 'user message must be protected')
})

test('retention is always on: out-of-window operations are archived in strict batchSize batches', () => {
  // Strict batch cap: the retention pass submits the OLDEST `batchSize`
  // out-of-window operations per batch and leaves the rest as candidates for
  // the next measure. The user-visible contract is "N per batch"; a backlog is
  // drained over successive batches, one full batch at a time.
  const session = buildSession({ operations: 5, resultChars: 4000 })
  const { view, plan } = planFor(session, { retainOperations: 2, batchSize: 1 })
  assert.equal(view.candidates.length, 5, 'the retained window must not be excluded from candidacy')
  assert.equal(view.candidates.filter((candidate) => candidate.withinRetention).length, 2)
  assert.equal(view.candidates.filter((candidate) => candidate.withinRetention).map((candidate) => candidate.tools[0]).join(','), 'edit,read')
  assert.equal(plan.batchSize, 1)
  assert.equal(plan.baselineReady, true)
  assert.equal(plan.outOfWindowCount, 3, 'three operations wait outside the window')
  assert.equal(plan.units.length, 1, 'only the oldest operation is submitted in this batch')
  assert.equal(plan.baselineUnits, 1)
  assert.equal(plan.archivedFromRetained, 0, 'the retained window must not be touched')
  assert.equal(plan.effectiveRetention, 2)

  // A whole batch (batchSize 3) submits all three at once — that is the
  // batching mode the cost model is written against.
  const full = planFor(buildSession({ operations: 5, resultChars: 4000 }), { retainOperations: 2, batchSize: 3 })
  assert.equal(full.plan.units.length, 3)
  assert.equal(full.plan.baselineUnits, 3)
  assert.equal(full.plan.archivedFromRetained, 0)
})

test('the batch threshold holds the retention pass back until enough has piled up', () => {
  const session = buildSession({ operations: 5, resultChars: 4000 })
  const { plan } = planFor(session, { retainOperations: 2, batchSize: 5 })
  // Only 3 operations have left the window, which is below the threshold of 5.
  assert.equal(plan.outOfWindowCount, 3)
  assert.equal(plan.baselineReady, false)
  assert.equal(plan.units.length, 0, 'the batch must wait rather than submit three operations')
  assert.equal(plan.batchSize, 5)
})

test('the strict cap submits only the oldest batchSize operations and leaves the rest pending', () => {
  // 8 operations, keep the newest 2: 6 are out of the window. batchSize 4 means
  // exactly the four OLDEST out-of-window operations submit; the other two wait
  // for the next measure, even though the whole backlog is archivable.
  const session = buildSession({ operations: 8, resultChars: 4000 })
  const { view, plan } = planFor(session, { retainOperations: 2, batchSize: 4 })
  const outside = view.candidates.filter((candidate) => !candidate.withinRetention)
  assert.equal(outside.length, 6)
  assert.equal(plan.baselineReady, true)
  assert.equal(plan.outOfWindowCount, 6)
  assert.equal(plan.batchSize, 4)
  assert.equal(plan.units.length, 4, 'the strict cap holds the batch to four units')
  assert.equal(plan.baselineUnits, 4)
  assert.deepEqual(
    plan.units.map((unit) => unit.rangeStart),
    outside.slice(0, 4).map((candidate) => candidate.rangeStart),
    'only the oldest four are submitted; the rest stay candidates',
  )
  assert.equal(plan.archivedFromRetained, 0, 'the retention window is never descended into')
  assert.equal(plan.effectiveRetention, 2)
  assert.equal(plan.archivedFromOpenTurn, 0)
})

test('an under-filled batch never archives, no matter how large the operations are', () => {
  // Retention is the ONLY trigger: there is no occupancy escape hatch any more.
  // A backlog below the threshold waits, full stop — nothing about token counts
  // or window pressure can bring the batch forward.
  const session = buildSession({ operations: 5, resultChars: 4000 })
  const { plan } = planFor(session, { retainOperations: 2, batchSize: 5 })
  assert.equal(plan.baselineReady, false)
  assert.equal(plan.outOfWindowCount, 3)
  assert.equal(plan.units.length, 0, 'below the threshold the plan is empty, end of story')
  assert.equal(plan.plannedReleaseTokens, 0)
  assert.equal(plan.baselineUnits, 0)
})

test('retained-window operations are candidates but never planned', () => {
  // Candidates at or inside the retention boundary are labelled
  // `withinRetention` so the report can account for them, but the planner only
  // ever submits the out-of-window tail.
  const session = buildSession({ operations: 6, resultChars: 4000 })
  const { view, plan } = planFor(session, { retainOperations: 4, batchSize: 1 })
  const inside = view.candidates.filter((candidate) => candidate.withinRetention)
  assert.equal(inside.length, 4)
  assert.equal(plan.outOfWindowCount, 2)
  assert.equal(plan.baselineReady, true)
  assert.equal(plan.units.length, 1, 'batchSize 1 submits exactly the oldest out-of-window unit')
  assert.equal(plan.archivedFromRetained, 0)
  assert.equal(plan.effectiveRetention, 4, 'the retention baseline is never lowered')
})

test('with nothing retained every candidate is out of window and the strict cap still holds', () => {
  const session = buildSession({ operations: 6, resultChars: 4000 })
  const { plan } = planFor(session, { retainOperations: 0 })
  // `retain 0` means "keep nothing verbatim". With the default batchSize 1 the
  // retention pass submits exactly one unit per batch; the backlog drains over
  // successive measures.
  assert.equal(plan.batchSize, 1)
  assert.equal(plan.baselineReady, true)
  assert.equal(plan.outOfWindowCount, 6)
  assert.equal(plan.units.length, 1)
  assert.equal(plan.baselineUnits, 1)
  assert.equal(plan.archivedFromRetained, 0)
})

test('a batch sized to the whole backlog submits every out-of-window operation at once', () => {
  const session = buildSession({ operations: 6, resultChars: 4000 })
  const { plan } = planFor(session, { retainOperations: 0, batchSize: 6 })
  assert.equal(plan.units.length, 6)
  assert.equal(plan.baselineUnits, 6)
  assert.equal(plan.outOfWindowCount, 6)
  assert.equal(plan.baselineReady, true)
})

test('the per-batch ceiling caps a filled batch, oldest-first', () => {
  const session = buildSession({ operations: 6, resultChars: 4000 })
  const measured = fakeMeter.measure(session)
  const view = collectOperationCandidates({
    surfaceNodes: session.surface.nodes,
    eventAt: (seq) => session.eventAt(seq),
    measuredNodes: measured.nodes,
    retainOperations: 0,
    openTurn: openTurnOf(session),
    archivedRanges: [],
    minimumChars: MIN_OPERATION_CHARS,
  })
  const plan = planCooling({
    candidates: view.candidates,
    meter: fakeMeter,
    nodeIdFor: (candidate) => `node-${candidate.rangeStart}`,
    retainOperations: 0,
    batchSize: 6,
    maxOperations: 2,
    minNetReleaseTokens: 128,
  })
  assert.equal(plan.units.length, 2, 'maxOperations caps the batch')
  assert.deepEqual(
    plan.units.map((unit) => unit.rangeStart),
    view.candidates.slice(0, 2).map((candidate) => candidate.rangeStart),
    'the cap keeps the oldest units, not a random subset',
  )
})

test('open-turn operations stay candidates and are labelled as such', () => {
  const session = buildSession({ operations: 2, resultChars: 4000 })
  session.append('turn/start', { turn: 3 })
  operation({ session, callId: 'call-open', toolName: 'write', result: '开'.repeat(4000), turn: 3, step: 1 })
  const { candidates } = viewOf(session)
  const open = candidates.filter((candidate) => candidate.inOpenTurn)
  assert.equal(open.length, 1, 'a completed operation inside the open turn is archivable')
  assert.deepEqual(open[0].tools, ['write'])
  assert.equal(candidates.filter((candidate) => !candidate.inOpenTurn).length, 2)
})

test('an operation whose result has not landed yet is never a candidate', () => {
  // This is what makes cooling the open turn safe: pair completeness, not a
  // turn-level fence, keeps in-flight work out of the candidate set.
  const session = buildSession({ operations: 1, resultChars: 4000 })
  session.append('turn/start', { turn: 2 })
  session.append('assistant/message', {
    turn: 2,
    step: 1,
    message: {
      id: 'm-inflight',
      role: 'assistant',
      content: [{ type: 'tool-call', id: 'call-inflight', name: 'read', arguments: '{}' }],
      source: { kind: 'model' },
    },
  }, { surfaceOp: 'append' })
  const { candidates } = viewOf(session)
  assert.equal(candidates.some((candidate) => candidate.callIds.includes('call-inflight')), false)
})

test('a failed tool result blocks archiving of its operation', () => {
  const session = buildSession({ operations: 1, resultChars: 4000 })
  session.append('turn/start', { turn: 2 })
  session.append('assistant/message', {
    turn: 2,
    step: 1,
    message: {
      id: 'm-fail',
      role: 'assistant',
      content: [{ type: 'tool-call', id: 'call-fail', name: 'read', arguments: '{}' }],
      source: { kind: 'model' },
    },
  }, { surfaceOp: 'append' })
  session.append('tool/result', {
    turn: 2,
    step: 1,
    message: {
      id: 'r-fail',
      role: 'tool',
      content: [{ type: 'text', text: '失败'.repeat(2000) }],
      source: { kind: 'tool', callId: 'call-fail' },
      toolCallId: 'call-fail',
      isError: true,
    },
    error: { name: 'ToolError', code: 'E_FAIL' },
  }, { surfaceOp: 'append' })
  session.append('turn/end', { turn: 2, reason: { kind: 'complete' } })
  const { candidates } = viewOf(session)
  assert.equal(candidates.flatMap((candidate) => candidate.tools).includes('read') && candidates.length, 1)
  assert.equal(candidates.length, 1, 'only the healthy operation is a candidate')
  assert.equal(candidates[0].callIds[0], 'call-1')
})

test('planCooling builds a receipt whose cost is subtracted from the release', () => {
  const session = buildSession({ operations: 3, resultChars: 4000 })
  const { plan } = planFor(session, { batchSize: 3 })
  assert.equal(plan.units.length, 3)
  for (const unit of plan.units) {
    assert.ok(unit.receipt.startsWith('[已归档操作]'))
    assert.ok(unit.netReleaseTokens > 0)
    assert.equal(unit.netReleaseTokens, unit.originalTokens - unit.receiptTokens)
  }
  assert.equal(plan.plannedReleaseTokens, plan.units.reduce((sum, unit) => sum + unit.netReleaseTokens, 0))
})

test('a filled batch drains a large session one strict batch at a time, never touching the retention window', async () => {
  // What replaced the occupancy convergence loop: retention is the only
  // trigger, so a long session is drained in `batchSize` chunks per measure
  // until the out-of-window backlog no longer fills a batch, at which point
  // cooling waits — regardless of what the occupancy meter says.
  const session = buildSession({ operations: 21, resultChars: 12000 })
  const store = new FakeColdStore()
  const baseline = 15
  const batchSize = 3

  let rounds = 0
  let applied = 0
  const outOfWindowCounts = []
  while (rounds < 20) {
    rounds += 1
    const measured = fakeMeter.measure(session)
    const view = collectOperationCandidates({
      surfaceNodes: session.surface.nodes,
      eventAt: (seq) => session.eventAt(seq),
      measuredNodes: measured.nodes,
      retainOperations: baseline,
      openTurn: undefined,
      archivedRanges: [],
      minimumChars: MIN_OPERATION_CHARS,
    })
    const plan = planCooling({
      candidates: view.candidates,
      meter: fakeMeter,
      nodeIdFor: (candidate) => `node-${candidate.rangeStart}`,
      retainOperations: baseline,
      batchSize,
      maxOperations: 64,
      minNetReleaseTokens: 128,
    })
    outOfWindowCounts.push(plan.outOfWindowCount)
    assert.ok(plan.units.length <= batchSize, 'the strict cap binds every round')
    assert.equal(plan.archivedFromRetained, 0, 'the retained window is never descended into')
    assert.equal(plan.effectiveRetention, baseline)
    if (!plan.units.length) break
    assert.equal(plan.baselineReady, true)
    for (const unit of plan.units) {
      const outcome = await applyOneOperation({ session, client: store, unit, meter: fakeMeter, hostVersion: 'test' })
      if (outcome.state === 'applied') applied += 1
    }
  }

  // 6 operations start outside the window; batchSize 3 drains them in 3+3,
  // then the loop stops because nothing out-of-window is left to fill a batch.
  assert.equal(applied, 6, 'the whole out-of-window backlog is archived')
  assert.deepEqual(outOfWindowCounts, [6, 3, 0], 'the backlog drains strictly, then the loop stops')
  const operationsLeft = session.surface.nodes.filter((seq) => session.eventAt(seq)?.type === 'assistant/message').length
  assert.equal(operationsLeft, baseline, 'exactly the retained window remains verbatim')
})

test('a backlog of large, split bodies drains under the same retention rule, chunks intact', async () => {
  // The reported fixture shape: a long session of large operations, a baseline
  // of 16, every operation bigger than one cold node. Nothing here consults
  // occupancy: the batch threshold alone drives the drain, and every stored
  // node must still fit the read-back limit.
  const session = buildSession({ operations: 40, resultChars: 30000 })
  const store = new FakeColdStore()
  const batchSize = 8

  let rounds = 0
  let applied = 0
  let chunksWritten = 0
  while (rounds < 20) {
    rounds += 1
    const measured = fakeMeter.measure(session)
    const view = collectOperationCandidates({
      surfaceNodes: session.surface.nodes,
      eventAt: (seq) => session.eventAt(seq),
      measuredNodes: measured.nodes,
      retainOperations: 16,
      openTurn: undefined,
      archivedRanges: [],
      minimumChars: MIN_OPERATION_CHARS,
    })
    assert.ok(view.skipped.every((row) => row.reason !== 'too-large'), 'large bodies must not be refused')
    const plan = planCooling({
      candidates: view.candidates,
      meter: fakeMeter,
      nodeIdFor: (candidate) => `node-${candidate.rangeStart}`,
      retainOperations: 16,
      batchSize,
      maxOperations: 64,
      minNetReleaseTokens: 128,
    })
    assert.ok(plan.units.length <= batchSize, 'the strict cap binds every round')
    assert.equal(plan.archivedFromRetained, 0)
    assert.equal(plan.effectiveRetention, 16, 'the baseline never moves')
    if (!plan.units.length) break
    for (const unit of plan.units) {
      const outcome = await applyOneOperation({ session, client: store, unit, meter: fakeMeter, hostVersion: 'test' })
      assert.equal(outcome.state, 'applied', outcome.reason)
      applied += 1
      chunksWritten += outcome.chunkCount
    }
  }

  assert.equal(applied, 24, '40 operations minus the retained 16')
  assert.ok(chunksWritten > applied, 'these bodies are large enough to need splitting')
  // Every stored node must be readable whole.
  for (const [, node] of store.nodes) {
    assert.ok(Buffer.byteLength(node.content, 'utf8') <= 50 * 1024, 'each stored node must fit the read-back limit')
  }
  const operationsLeft = session.surface.nodes.filter((seq) => session.eventAt(seq)?.type === 'assistant/message').length
  assert.equal(operationsLeft, 16, 'exactly the retained window remains verbatim')
})

test('committing a batch replaces each operation with one user receipt the surface accepts', async () => {
  const session = buildSession({ operations: 3, resultChars: 4000 })
  const { plan } = planFor(session, { batchSize: 3 })
  const store = new FakeColdStore()
  const before = session.surface.nodes.length

  const outcomes = []
  for (const unit of plan.units) {
    outcomes.push(await applyOneOperation({ session, client: store, unit, meter: fakeMeter, hostVersion: 'test' }))
  }

  assert.deepEqual(outcomes.map((outcome) => outcome.state), ['applied', 'applied', 'applied'])
  // Three operations, each two nodes, collapse to three receipt nodes.
  assert.equal(session.surface.nodes.length, before - 3)
  assert.equal(store.writes, 3)

  const receipts = session.surface.nodes
    .map((seq) => session.eventAt(seq))
    .filter((event) => event.type === 'user/message')
  assert.equal(receipts.length, 4, 'the original user message plus three receipts')
  for (const receipt of receipts.slice(1)) {
    assert.ok(receipt.data.content[0].text.startsWith('[已归档操作]'))
    assert.equal(receipt.surfaceOp.op, 'replace')
  }
  // The archived assistant nodes and tool results are gone from the surface.
  for (const unit of plan.units) {
    for (const seq of unit.shadowedSeqs) assert.equal(session.surface.nodes.includes(seq), false)
  }
  // The next request can still be assembled.
  assert.ok(session.deriveMessages().length > 0)
})

test('the archived body keeps the tool arguments and the result text for restore', async () => {
  const session = buildSession({ operations: 1, resultChars: 4000 })
  const { plan } = planFor(session)
  const store = new FakeColdStore()
  const outcome = await applyOneOperation({ session, client: store, unit: plan.units[0], meter: fakeMeter, hostVersion: 'test' })
  assert.equal(outcome.state, 'applied')
  const stored = store.nodes.get(archiveChunkNodeId(plan.units[0].nodeId, 0)).content
  assert.ok(stored.includes('"file":"file-1.md"'), 'tool arguments must be archived')
  assert.ok(stored.includes('内容'), 'tool result text must be archived')
  assert.ok(stored.includes('先读第一个文件。'), 'assistant prose must be archived')
})

test('the archived body keeps the assistant reasoning, so restore is not lossy', async () => {
  // A thinking-heavy session puts most of its occupancy in reasoning blocks, and
  // the host prices them as surface tokens. Eligibility accepts such a node, so
  // the cold body must carry the reasoning too: the receipt replaces the whole
  // node, and `restore` can only put back what the cold store actually holds.
  const reasoning = '我先确认调用点，再决定是否替换整段区间。'.repeat(40)
  const session = buildSession({ operations: 1, resultChars: 4000 })
  session.append('turn/start', { turn: 2 })
  operation({ session, callId: 'call-think', toolName: 'read', args: '{"file":"think.md"}', result: '结果正文'.repeat(400), turn: 2, step: 1, assistantText: '先看这个文件。', assistantReasoning: reasoning })
  session.append('turn/end', { turn: 2, reason: { kind: 'complete' } })

  const measured = fakeMeter.measure(session)
  const view = collectOperationCandidates({
    surfaceNodes: session.surface.nodes,
    eventAt: (seq) => session.eventAt(seq),
    measuredNodes: measured.nodes,
    retainOperations: 0,
    openTurn: openTurnOf(session),
    archivedRanges: [],
    minimumChars: MIN_OPERATION_CHARS,
  })
  const candidate = view.candidates.find((row) => row.callIds.includes('call-think'))
  assert.ok(candidate, 'a node carrying reasoning must stay a candidate')
  assert.ok(candidate.body.includes(reasoning), 'the planned body must include the reasoning')

  const store = new FakeColdStore()
  const plan = planCooling({
    candidates: [candidate],
    meter: fakeMeter,
    nodeIdFor: () => 'think-node',
    retainOperations: 0,
    minNetReleaseTokens: 128,
  })
  const outcome = await applyOneOperation({ session, client: store, unit: plan.units[0], meter: fakeMeter, hostVersion: 'test' })
  assert.equal(outcome.state, 'applied')
  const stored = store.nodes.get(archiveChunkNodeId('think-node', 0)).content
  assert.ok(stored.includes(reasoning), 'the cold record must carry the reasoning')
  assert.ok(stored.includes('先看这个文件。'), 'the prose must still be archived beside it')

  // And the restored text is byte-complete, not a prefix that merely hashes equal.
  const restored = await restoreReceipts({ session, client: store, receipts: [{
    rangeStart: plan.units[0].rangeStart,
    rangeEnd: plan.units[0].rangeEnd,
    nodeId: 'think-node',
    replacementSeq: outcome.replacementSeq,
    hash: plan.units[0].hash,
    tools: plan.units[0].tools,
    callIds: plan.units[0].callIds,
    chars: plan.units[0].chars,
    originalTokens: plan.units[0].originalTokens,
    chunkCount: 1,
  }] })
  assert.equal(restored[0].state, 'restored')
  const restoredText = session.eventAt(restored[0].restoredSeq).data.content.map((block) => block.text).join('')
  assert.ok(restoredText.includes(reasoning), 'restore must bring the reasoning back')
})

test('a body far larger than one cold node is split, verified per chunk, and restores whole', async () => {
  // The reported failure mode: any operation over the read-back limit was
  // refused outright, so a session full of large reads could never be cooled.
  const bigResult = '很长的内容'.repeat(6000) // ~30k chars, ~90 KB in UTF-8
  const session = buildSession({ operations: 1, resultChars: 100 })
  session.append('turn/start', { turn: 2 })
  operation({ session, callId: 'call-big', toolName: 'read', args: '{"file":"big.md"}', result: bigResult, turn: 2, step: 1 })
  session.append('turn/end', { turn: 2, reason: { kind: 'complete' } })

  const measured = fakeMeter.measure(session)
  const view = collectOperationCandidates({
    surfaceNodes: session.surface.nodes,
    eventAt: (seq) => session.eventAt(seq),
    measuredNodes: measured.nodes,
    retainOperations: 0,
    openTurn: openTurnOf(session),
    archivedRanges: [],
    minimumChars: MIN_OPERATION_CHARS,
  })
  const big = view.candidates.find((candidate) => candidate.callIds.includes('call-big'))
  assert.ok(big, 'a large operation must still be a candidate')
  assert.ok(Buffer.byteLength(big.body, 'utf8') > MAX_OPERATION_BYTES, 'the fixture must exceed one node')
  assert.ok(big.chunkCount > 1, `the body must be split, got ${big.chunkCount} chunk(s)`)

  const store = new FakeColdStore()
  const plan = planCooling({
    candidates: [big],
    meter: fakeMeter,
    nodeIdFor: () => 'big-node',
    retainOperations: 0,
    minNetReleaseTokens: 128,
  })
  const outcome = await applyOneOperation({ session, client: store, unit: plan.units[0], meter: fakeMeter, hostVersion: 'test' })
  assert.equal(outcome.state, 'applied', outcome.reason)
  assert.equal(outcome.chunkCount, big.chunkCount)
  assert.equal(store.writes, big.chunkCount, 'one cold write per chunk')
  // The real constraint is that `mdcg_get` can return the whole node: it clips
  // at 2000 lines / 50 KiB, so the *stored* content (header plus payload) must
  // fit, not just the payload.
  const READ_BACK_LIMIT_BYTES = 50 * 1024
  for (const nodeId of outcome.chunkIds) {
    const stored = store.nodes.get(nodeId).content
    assert.ok(
      Buffer.byteLength(stored, 'utf8') <= READ_BACK_LIMIT_BYTES,
      `${nodeId} stored ${Buffer.byteLength(stored, 'utf8')} bytes, over the ${READ_BACK_LIMIT_BYTES} read-back limit`,
    )
    assert.ok(stored.split('\n').length <= 2000, `${nodeId} exceeds the read-back line limit`)
  }

  // Restore must reassemble every byte.
  const restored = await restoreReceipts({
    session,
    client: store,
    receipts: [{
      rangeStart: outcome.rangeStart,
      rangeEnd: outcome.rangeEnd,
      callIds: outcome.callIds,
      tools: outcome.tools,
      nodeId: outcome.nodeId,
      hash: outcome.hash,
      chars: outcome.chars,
      originalTokens: outcome.originalTokens,
      replacementSeq: outcome.replacementSeq,
      chunkCount: outcome.chunkCount,
      status: 'applied',
    }],
  })
  assert.equal(restored[0].state, 'restored', restored[0].reason)
  const body = session.eventAt(restored[0].restoredSeq).data.content[0].text
  assert.equal(body, big.body, 'the reassembled body must match the archived body byte for byte')
  assert.ok(body.includes(bigResult.slice(0, 200)), 'the large result text must survive intact')
})

test('a missing chunk refuses the restore instead of writing a partial body', async () => {
  const bigResult = '内容块'.repeat(8000)
  const session = buildSession({ operations: 1, resultChars: 100 })
  session.append('turn/start', { turn: 2 })
  operation({ session, callId: 'call-big2', toolName: 'read', args: '{}', result: bigResult, turn: 2, step: 1 })
  session.append('turn/end', { turn: 2, reason: { kind: 'complete' } })

  const measured = fakeMeter.measure(session)
  const view = collectOperationCandidates({
    surfaceNodes: session.surface.nodes,
    eventAt: (seq) => session.eventAt(seq),
    measuredNodes: measured.nodes,
    retainOperations: 0,
    openTurn: openTurnOf(session),
    archivedRanges: [],
    minimumChars: MIN_OPERATION_CHARS,
  })
  const big = view.candidates.find((candidate) => candidate.callIds.includes('call-big2'))
  const store = new FakeColdStore()
  const plan = planCooling({
    candidates: [big], meter: fakeMeter, nodeIdFor: () => 'big2', retainOperations: 0, minNetReleaseTokens: 128,
  })
  const outcome = await applyOneOperation({ session, client: store, unit: plan.units[0], meter: fakeMeter, hostVersion: 'test' })
  assert.equal(outcome.state, 'applied')
  assert.ok(outcome.chunkCount > 1)

  // Delete a middle chunk, as an out-of-band store change would.
  store.nodes.delete(archiveChunkNodeId('big2', 1))
  const before = session.surface.nodes.length
  const restored = await restoreReceipts({
    session,
    client: store,
    receipts: [{
      rangeStart: outcome.rangeStart, rangeEnd: outcome.rangeEnd, callIds: outcome.callIds, tools: outcome.tools,
      nodeId: outcome.nodeId, hash: outcome.hash, chars: outcome.chars, originalTokens: outcome.originalTokens,
      replacementSeq: outcome.replacementSeq, chunkCount: outcome.chunkCount, status: 'applied',
    }],
  })
  assert.equal(restored[0].state, 'skipped')
  assert.ok(restored[0].reason.includes('第 2/'), restored[0].reason)
  assert.equal(session.surface.nodes.length, before, 'a refused restore must not touch the surface')
})

test('a cold write failing on a later chunk keeps the original messages', async () => {
  const session = buildSession({ operations: 1, resultChars: 100 })
  session.append('turn/start', { turn: 2 })
  operation({ session, callId: 'call-big3', toolName: 'read', args: '{}', result: '内容块'.repeat(8000), turn: 2, step: 1 })
  session.append('turn/end', { turn: 2, reason: { kind: 'complete' } })
  const measured = fakeMeter.measure(session)
  const view = collectOperationCandidates({
    surfaceNodes: session.surface.nodes,
    eventAt: (seq) => session.eventAt(seq),
    measuredNodes: measured.nodes,
    retainOperations: 0,
    openTurn: openTurnOf(session),
    archivedRanges: [],
    minimumChars: MIN_OPERATION_CHARS,
  })
  const big = view.candidates.find((candidate) => candidate.callIds.includes('call-big3'))
  const store = new FakeColdStore()
  const plan = planCooling({
    candidates: [big], meter: fakeMeter, nodeIdFor: () => 'big3', retainOperations: 0, minNetReleaseTokens: 128,
  })
  // Fail the second chunk write.
  let writes = 0
  const original = store.rememberArchived.bind(store)
  store.rememberArchived = async (args) => {
    writes += 1
    if (writes === 2) throw new Error('chunk write failed')
    return original(args)
  }
  const before = session.surface.nodes.length
  const outcome = await applyOneOperation({ session, client: store, unit: plan.units[0], meter: fakeMeter, hostVersion: 'test' })
  assert.equal(outcome.state, 'cold-write-failed')
  assert.ok(outcome.reason.includes('第 2/'), outcome.reason)
  assert.equal(session.surface.nodes.length, before, 'nothing may be replaced when a chunk write fails')
})

test('a body with CRLF round-trips the store byte-identically', async () => {
  // The production bug (session-e943ef19): pwsh output contains CRLF; the
  // store's markdown codec normalizes CRLF→LF on write, so the planned body
  // (CRLF) and the stored body (LF) hashed differently and every archive of a
  // CRLF-containing operation failed as 'cold-write-failed'/'orphaned'. The
  // fix canonicalizes the body before it is hashed and written, so the
  // round-trip is byte-identical and the unit applies.
  const crlfResult = '第一行\r\n第二行\r\n第三行 with trailing spaces   \r\n'.repeat(400)
  const session = buildSession({ operations: 1, resultChars: 100 })
  session.append('turn/start', { turn: 2 })
  operation({ session, callId: 'call-crlf', toolName: 'pwsh', args: '{"command":"ls"}', result: crlfResult, turn: 2, step: 1 })
  session.append('turn/end', { turn: 2, reason: { kind: 'complete' } })

  const measured = fakeMeter.measure(session)
  const view = collectOperationCandidates({
    surfaceNodes: session.surface.nodes,
    eventAt: (seq) => session.eventAt(seq),
    measuredNodes: measured.nodes,
    retainOperations: 0,
    openTurn: openTurnOf(session),
    archivedRanges: [],
    minimumChars: MIN_OPERATION_CHARS,
  })
  const candidate = view.candidates.find((row) => row.callIds.includes('call-crlf'))
  assert.ok(candidate, 'the CRLF fixture must be an archivable candidate')
  assert.ok(candidate.body.includes('\r\n'), 'the fixture body really carries CRLF')

  const plan = planCooling({
    candidates: [candidate],
    meter: fakeMeter,
    nodeIdFor: () => 'crlf-node',
    retainOperations: 0,
    maxOperations: 64,
    minNetReleaseTokens: 128,
  })
  const store = new FakeColdStore()
  const outcome = await applyOneOperation({ session, client: store, unit: plan.units[0], meter: fakeMeter, hostVersion: 'test' })
  assert.equal(outcome.state, 'applied', outcome.reason)

  // Restore returns the canonical body (line endings normalized by the store);
  // the MAC comparison accepts it, so the restore succeeds instead of being
  // refused as a hash mismatch.
  const receipt = {
    rangeStart: outcome.rangeStart,
    rangeEnd: outcome.rangeEnd,
    callIds: outcome.callIds,
    tools: outcome.tools,
    nodeId: outcome.nodeId,
    hash: outcome.hash,
    chars: outcome.chars,
    originalTokens: outcome.originalTokens,
    replacementSeq: outcome.replacementSeq,
    chunkCount: outcome.chunkCount,
    status: 'applied',
  }
  const [restored] = await restoreReceipts({ session, client: store, receipts: [receipt] })
  assert.equal(restored.state, 'restored', restored.reason)
})

test('a retried CRLF unit reuses a node written before the fix', async () => {
  // A node written by the OLD code path holds CRLF in its cold record. After
  // the fix the same range plans a canonical (LF) body. The probe must
  // recognize them as the same content under canonicalization and reuse the
  // node, not refuse it as 'cold-write-failed' — that refusal loop is what
  // froze the archive count at 5 in production.
  const crlfResult = 'alpha\r\nbeta\r\ngamma\r\n'.repeat(500)
  const session = buildSession({ operations: 1, resultChars: 100 })
  session.append('turn/start', { turn: 2 })
  operation({ session, callId: 'call-legacy', toolName: 'pwsh', args: '{}', result: crlfResult, turn: 2, step: 1 })
  session.append('turn/end', { turn: 2, reason: { kind: 'complete' } })

  const measured = fakeMeter.measure(session)
  const view = collectOperationCandidates({
    surfaceNodes: session.surface.nodes,
    eventAt: (seq) => session.eventAt(seq),
    measuredNodes: measured.nodes,
    retainOperations: 0,
    openTurn: openTurnOf(session),
    archivedRanges: [],
    minimumChars: MIN_OPERATION_CHARS,
  })
  const candidate = view.candidates.find((row) => row.callIds.includes('call-legacy'))
  const plan = planCooling({
    candidates: [candidate],
    meter: fakeMeter,
    nodeIdFor: () => 'legacy-node',
    retainOperations: 0,
    maxOperations: 64,
    minNetReleaseTokens: 128,
  })
  const unit = plan.units[0]
  assert.equal(unit.chunkCount, 1, 'single-chunk fixture keeps the assertion simple')

  // Pre-populate the store the way the pre-fix code did: the raw CRLF body.
  const legacyHeader = [
    '# header',
    `- range: ${unit.rangeStart}-${unit.rangeEnd}`,
    `- tools: ${unit.tools.join(',')}`,
    `- calls: ${unit.callIds.join(',')}`,
    `- hash: legacy`,
  ].join('\n')
  const store = new FakeColdStore()
  store.nodes.set(archiveChunkNodeId('legacy-node', 0), { content: `${legacyHeader}\n\n${candidate.body}\n` })
  const writesBefore = store.writes

  const outcome = await applyOneOperation({ session, client: store, unit, meter: fakeMeter, hostVersion: 'test' })
  assert.equal(outcome.state, 'applied', outcome.reason)
  assert.equal(store.writes, writesBefore, 'the legacy CRLF node was reused, not re-written')
})

test('restore returns the archived body and the surface accepts the replacement', async () => {
  const session = buildSession({ operations: 2, resultChars: 4000 })
  const { plan } = planFor(session, { batchSize: 2 })
  const store = new FakeColdStore()
  const applied = []
  for (const unit of plan.units) {
    const outcome = await applyOneOperation({ session, client: store, unit, meter: fakeMeter, hostVersion: 'test' })
    applied.push({
      rangeStart: outcome.rangeStart,
      rangeEnd: outcome.rangeEnd,
      callIds: outcome.callIds,
      tools: outcome.tools,
      nodeId: outcome.nodeId,
      hash: outcome.hash,
      chars: outcome.chars,
      originalTokens: outcome.originalTokens,
      replacementSeq: outcome.replacementSeq,
      status: 'applied',
    })
  }
  const result = await restoreReceipts({ session, client: store, receipts: applied })
  assert.equal(result.filter((outcome) => outcome.state === 'restored').length, 2)
  // The two restored nodes carry the archived bodies; the original user message
  // is still there untouched and is not one of them.
  const restoredTexts = session.surface.nodes
    .map((seq) => session.eventAt(seq))
    .filter((event) => event.type === 'user/message' && event.data.content[0].text.includes('"file":'))
    .map((event) => event.data.content[0].text)
  assert.equal(restoredTexts.length, 2)
  assert.ok(restoredTexts.every((text) => text.includes('## 调用 1')))
})

test('a cold-store write failure keeps the original messages', async () => {
  const session = buildSession({ operations: 1, resultChars: 4000 })
  const { plan } = planFor(session)
  const store = new FakeColdStore()
  store.failNextWrite = true
  const before = session.surface.nodes.length
  const outcome = await applyOneOperation({ session, client: store, unit: plan.units[0], meter: fakeMeter, hostVersion: 'test' })
  assert.equal(outcome.state, 'cold-write-failed')
  assert.equal(session.surface.nodes.length, before)
  assert.equal(session.surface.nodes.includes(plan.units[0].rangeStart), true)
})

test('a clipped read-back is reported as unverifiable, not as success', async () => {
  const session = buildSession({ operations: 1, resultChars: 4000 })
  const { plan } = planFor(session)
  const store = new FakeColdStore()
  store.clipReads = true
  const before = session.surface.nodes.length
  const outcome = await applyOneOperation({ session, client: store, unit: plan.units[0], meter: fakeMeter, hostVersion: 'test' })
  assert.equal(outcome.state, 'orphaned')
  assert.equal(session.surface.nodes.length, before)
})

test('a changed range is refused as stale', async () => {
  // The drift check compares the live surface body against the planned body,
  // both canonicalized. Mutating the planned body — not the stored hash — is
  // what simulates the surface having moved under the plan.
  const session = buildSession({ operations: 1, resultChars: 4000 })
  const { plan } = planFor(session)
  const store = new FakeColdStore()
  const unit = { ...plan.units[0], body: `${plan.units[0].body}\n有人改动了来源正文` }
  const outcome = await applyOneOperation({ session, client: store, unit, meter: fakeMeter, hostVersion: 'test' })
  assert.equal(outcome.state, 'stale')
  assert.ok(outcome.reason.includes('hash'), outcome.reason)
})

test('the fake surface rejects an assistant-node replacement, which is why ranges use user messages', () => {
  const session = buildSession({ operations: 1, resultChars: 4000 })
  const assistantSeq = session.surface.nodes.find((seq) => session.eventAt(seq)?.type === 'assistant/message')
  const resultSeq = session.surface.nodes.find((seq) => session.eventAt(seq)?.type === 'tool/result')
  assert.throws(() => session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: { id: 'x', role: 'assistant', content: [{ type: 'text', text: 'x' }], source: { kind: 'model' } },
  }, {
    surfaceOp: { op: 'replace', startSeq: assistantSeq, endSeq: resultSeq },
    sourceEventSeqs: [assistantSeq, resultSeq],
  }), SurfaceError)
})

test('a tool/result replacement may only rewrite exactly one node', () => {
  const session = buildSession({ operations: 1, resultChars: 4000 })
  const assistantSeq = session.surface.nodes.find((seq) => session.eventAt(seq)?.type === 'assistant/message')
  const resultSeq = session.surface.nodes.find((seq) => session.eventAt(seq)?.type === 'tool/result')
  const original = session.eventAt(resultSeq)
  assert.throws(() => session.append('tool/result', {
    ...original.data,
    message: { ...original.data.message, content: [{ type: 'text', text: 'x' }] },
  }, {
    surfaceOp: { op: 'replace', startSeq: assistantSeq, endSeq: resultSeq },
    sourceEventSeqs: [assistantSeq, resultSeq],
  }), SurfaceError)
})

test('resolveWindow fails closed on an unconfirmed window', () => {
  assert.throws(() => resolveWindow({ contextWindow: undefined }))
  assert.throws(() => resolveWindow({ contextWindow: 1000, reservedCompletionTokens: -1 }))
  assert.throws(() => resolveWindow({ contextWindow: null }))
  assert.throws(() => resolveWindow({ contextWindow: 0 }))
  assert.throws(() => resolveWindow({ contextWindow: 1000, reservedCompletionTokens: 1.5 }))
  // resolveWindow only confirms the window bookkeeping; there is no budget or
  // target to derive any more — the retention count alone gates a plan.
  const window = resolveWindow({ contextWindow: 100000, reservedCompletionTokens: 8000 })
  assert.deepEqual(window, { contextWindow: 100000, reservedCompletionTokens: 8000 })
  const bare = resolveWindow({ contextWindow: 100000 })
  assert.deepEqual(bare, { contextWindow: 100000, reservedCompletionTokens: 0 })
})

test('occupancy, cache stats, and the batch report render without throwing', () => {
  assert.equal(computeOccupancy(500, 1000), 0.5)
  assert.equal(computeOccupancy(500, 0), null)
  const stats = cacheStatsOf({ inputTokens: 100, cacheReadTokens: 900 })
  assert.equal(stats.hitRatio, 0.9)
  assert.equal(cacheStatsOf({}), null)
  const report = formatBatchReport({
    applied: 1,
    releasedTokens: 500,
    outcomes: [{ state: 'applied', rangeStart: 3, rangeEnd: 4, tools: ['read'], reason: '' }],
    failed: [],
  })
  assert.ok(report.includes('已归档 1 个操作'))
})

test('lastUsageOf reads the newest reported usage', () => {
  const session = buildSession({ operations: 1, resultChars: 4000 })
  session.append('assistant/message', {
    turn: 1,
    step: 2,
    message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'done' }], source: { kind: 'model' } },
    usage: { inputTokens: 10, cacheReadTokens: 90, outputTokens: 5 },
  }, { surfaceOp: 'append' })
  assert.equal(lastUsageOf(session).cacheReadTokens, 90)
})

test('recallQueryFrom reads the claimed batch, skipping our own injections', () => {
  const batch = [
    { id: 'm1', role: 'user', content: [{ type: 'text', text: '第一条' }], source: { kind: 'user' } },
    { id: 'm2', role: 'user', content: [{ type: 'text', text: '当前问题' }], source: { kind: 'user' } },
  ]
  assert.deepEqual(recallQueryFrom(batch), { id: 'm2', text: '当前问题' })

  // Our own recall message must never become the next query.
  const withRecall = [...batch, {
    id: 'm3',
    role: 'user',
    content: [{ type: 'text', text: '归档节选' }],
    source: { kind: 'dsh-memory-context-lab', form: 'recall' },
  }]
  assert.equal(recallQueryFrom(withRecall).id, 'm2')

  // Assistant and tool messages are not queries.
  assert.equal(recallQueryFrom([{ id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'x' }] }]), null)
  assert.equal(recallQueryFrom([]), null)
  assert.equal(recallQueryFrom(undefined), null)

  // A first-party prompt under another source kind is a last-resort fallback.
  assert.equal(recallQueryFrom([{ id: 'm9', role: 'user', content: [{ type: 'text', text: '间接' }], source: { kind: 'some-plugin' } }]).id, 'm9')
  // An empty batch entry is skipped rather than returned as an empty query.
  assert.equal(recallQueryFrom([{ id: 'm8', role: 'user', content: [], source: { kind: 'user' } }]), null)
})

test('cleanDecision refuses while receipts still shadow the surface', () => {
  assert.equal(cleanDecision({ pendingReceipts: 2, confirmDelete: false }).refuse, true)
  assert.equal(cleanDecision({ pendingReceipts: 2, confirmDelete: true }).refuse, false)
  assert.equal(cleanDecision({ pendingReceipts: 0, confirmDelete: false }).refuse, false)
})

/**
 * Cold-store wrapper whose SECOND write of its lifetime fails, then keeps
 * going. Used to model a partial cold write: chunk 1 lands, chunk 2 dies, and a
 * retry must REUSE chunk 1 instead of writing it again.
 */
class FailingAfterWriteStore {
  constructor(inner) {
    this.inner = inner
    this.calls = 0
  }

  async rememberArchived(args) {
    this.calls += 1
    if (this.calls === 2) throw new Error('fake cold write dies after the first chunk')
    return this.inner.rememberArchived(args)
  }

  async getNode(nodeId) {
    return this.inner.getNode(nodeId)
  }

  async recall(...args) {
    return this.inner.recall(...args)
  }

  async close() {}
}

test('a retried unit reuses cold nodes that already hold its exact bytes', async () => {
  // The 317fd313 bug, replayed: a unit died mid-batch after some of its chunks
  // were already written; the retry then re-targeted shifted node ids and
  // failed the read-back hash deterministically. With the probe-and-reuse fix
  // the retry reads its own earlier bytes back, writes only what is missing,
  // and the unit applies.
  const bigResult = '很长的内容'.repeat(9000)
  const session = buildSession({ operations: 1, resultChars: 100 })
  session.append('turn/start', { turn: 2 })
  operation({ session, callId: 'call-retry', toolName: 'read', args: '{"file":"retry.md"}', result: bigResult, turn: 2, step: 1 })
  session.append('turn/end', { turn: 2, reason: { kind: 'complete' } })

  const measured = fakeMeter.measure(session)
  const view = collectOperationCandidates({
    surfaceNodes: session.surface.nodes,
    eventAt: (seq) => session.eventAt(seq),
    measuredNodes: measured.nodes,
    retainOperations: 0,
    openTurn: openTurnOf(session),
    archivedRanges: [],
    minimumChars: MIN_OPERATION_CHARS,
  })
  const candidate = view.candidates.find((row) => row.callIds.includes('call-retry'))
  assert.ok(candidate.chunkCount > 1, 'the fixture must need more than one cold node')
  const plan = planCooling({
    candidates: [candidate],
    meter: fakeMeter,
    nodeIdFor: () => 'retry-node',
    retainOperations: 0,
    maxOperations: 64,
    minNetReleaseTokens: 128,
  })
  const unit = plan.units[0]
  assert.equal(unit.chunkCount, candidate.chunkCount)
  const store = new FakeColdStore()
  const flaky = new FailingAfterWriteStore(store)

  const first = await applyOneOperation({ session, client: flaky, unit, meter: fakeMeter, hostVersion: 'test' })
  assert.equal(first.state, 'cold-write-failed', first.reason)
  const writesAfterFirst = store.writes
  assert.equal(writesAfterFirst, 1, 'exactly the first chunk landed before the failure')
  const chunkOneBefore = store.nodes.get(archiveChunkNodeId('retry-node', 0)).content

  // The retry re-reads chunk 1 from the store and skips its write entirely.
  const second = await applyOneOperation({ session, client: flaky, unit, meter: fakeMeter, hostVersion: 'test' })
  assert.equal(second.state, 'applied', second.reason)
  assert.equal(store.writes, unit.chunkCount, 'every chunk except the reused one was written once')
  assert.equal(store.nodes.get(archiveChunkNodeId('retry-node', 0)).content, chunkOneBefore, 'the reused chunk is byte-identical')
})

test('a node held by different content refuses the write with an explicit reason', async () => {
  // The isolated store is write-once per node id. When a probe answers with OUR
  // id but SOMEONE ELSE'S body, the honest move is to refuse loudly and keep the
  // originals — not to proceed into a doomed read-back hash mismatch.
  const session = buildSession({ operations: 1, resultChars: 4000 })
  const { plan } = planFor(session, { retainOperations: 0 })
  const unit = plan.units[0]
  assert.ok(unit, 'the fixture needs one unit')
  const store = new FakeColdStore()
  const foreignChunkId = archiveChunkNodeId(unit.nodeId, 0)
  store.nodes.set(foreignChunkId, { content: '# header\n\n- thief: other-unit\n\n别人的正文，绝不许被插件覆写\n' })

  const outcome = await applyOneOperation({ session, client: store, unit, meter: fakeMeter, hostVersion: 'test' })
  assert.equal(outcome.state, 'cold-write-failed')
  assert.ok(outcome.reason.includes('已被不同正文占用'), outcome.reason)
  assert.ok(outcome.reason.includes('拒绝覆写'), outcome.reason)
  assert.equal(store.writes, 0, 'nothing was written over the foreign body')
  // The originals stay untouched: the replacement never happened.
  for (const seq of unit.shadowedSeqs) {
    assert.ok(session.surface.nodes.includes(seq), `seq ${seq} must still be on the surface`)
  }
})
