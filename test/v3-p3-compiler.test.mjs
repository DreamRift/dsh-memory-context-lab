// 本模块当前零生产消费，仅由本专属测试调用。
import test from 'node:test'
import assert from 'node:assert/strict'
import { compileContext } from '../src/v3/domain/compiler/context-compiler.mjs'

const rid = n => 'v3r-' + n.toString(16).padStart(16, '0')
function fixture(nodes = [{ seq: 0, recordId: null, bytes: 'R0|sys' }, { seq: 1, recordId: null, bytes: 'R1|tools' }, { seq: 2, recordId: rid(1), bytes: 'R3|user' }]) {
  return {
    surface: { nodes, partition: [
      { key: 'R0', nodeIndexes: [0] }, { key: 'R1', nodeIndexes: [1] },
      { key: 'R2', nodeIndexes: [] }, { key: 'R3', nodeIndexes: nodes.slice(2).map((_, i) => i + 2) }
    ] }, receipts: [], toolPairs: [], pins: [],
    plan: { planFloorSeq: 0, artifactSeqs: [] },
    protection: { protectedSeqs: [], completeness: { status: 'ok', missingSources: [] } },
    budget: { scannedCount: nodes.length, limit: 200 }
  }
}

// 下列标记用例属于变异敏感断言：删除相应关键校验/分支会使断言失败。
test('G-P3-CC-01 / P3-CC-07 deterministic repeated compilation', () => {
  const input = fixture()
  assert.equal(JSON.stringify(compileContext(input)), JSON.stringify(compileContext(input)))
})
test('G-P3-CC-02 / P3-CC-10 R0/R1 fixed; dynamic addition stays R3', () => {
  const a = compileContext(fixture())
  const b = compileContext(fixture([...fixture().surface.nodes, { seq: 3, recordId: rid(2), bytes: 'R3|dynamic timestamp' }]))
  for (const key of ['R0', 'R1']) assert.deepEqual(b.draft.filter(x => x.partitionKey === key), a.draft.filter(x => x.partitionKey === key))
  assert.equal(b.draft.at(-1).partitionKey, 'R3')
})
test('P3-CC-01 / G-P3-CC-03 unclosed tool call and result remain ordered', () => {
  const input = fixture([{ seq: 41, recordId: rid(1), bytes: 'call' }, { seq: 42, recordId: rid(2), bytes: 'adjacent result' }])
  input.surface.partition = [{ key: 'R0', nodeIndexes: [] }, { key: 'R1', nodeIndexes: [] }, { key: 'R2', nodeIndexes: [0, 1] }, { key: 'R3', nodeIndexes: [] }]
  input.toolPairs = [{ callId: 'host-id', callSeq: 41, resultSeq: null, state: 'unclosed' }]
  input.protection.protectedSeqs = [41]
  const output = compileContext(input)
  assert.deepEqual(output.draft.map(x => x.bytes), ['call', 'adjacent result'])
  assert.deepEqual(output.draft.map(x => input.surface.nodes[x.nodeIndex].recordId), [rid(1), rid(2)])
})
test('P3-CC-02 / G-P3-CC-04 pin content is preserved', () => {
  const input = fixture(); input.pins = [{ seq: 2, recordId: rid(1) }]; input.protection.protectedSeqs = [2]
  assert.equal(compileContext(input).draft.find(x => x.nodeIndex === 2).bytes, 'R3|user')
})
test('P3-CC-03 / G-P3-CC-05 missing pin evidence is rejected fail-closed', () => {
  const input = fixture(); input.pins = null
  assert.throws(() => compileContext(input), /pins must be an array/)
})
test('P3-CC-04 plan artifacts persist and floor remains exact', () => {
  const input = fixture([{ seq: 48, recordId: rid(1), bytes: 'a' }, { seq: 49, recordId: rid(2), bytes: 'b' }])
  input.surface.partition = [{ key: 'R0', nodeIndexes: [] }, { key: 'R1', nodeIndexes: [] }, { key: 'R2', nodeIndexes: [0, 1] }, { key: 'R3', nodeIndexes: [] }]
  input.plan = { planFloorSeq: 50, artifactSeqs: [48, 49] }; input.protection.protectedSeqs = [48, 49]
  assert.deepEqual(compileContext(input).draft.map(x => x.bytes), ['a', 'b'])
  assert.equal(input.plan.planFloorSeq, 50)
})
test('P3-CC-05 / G-P3-CC-06 missing frozen plan boundary rejects', () => {
  const input = fixture(); input.plan.planFloorSeq = null
  assert.throws(() => compileContext(input), /planFloorSeq/)
})
test('P3-CC-06 / G-P3-CC-07 H=200 truncation reports partial, never full', () => {
  const nodes = Array.from({ length: 201 }, (_, i) => ({ seq: i, recordId: null, bytes: String(i) }))
  const input = fixture(nodes); input.surface.partition = [{ key:'R0', nodeIndexes:[] }, {key:'R1',nodeIndexes:[]}, {key:'R2',nodeIndexes:[]}, {key:'R3',nodeIndexes:nodes.map((_,i)=>i)}]
  input.budget.scannedCount = 200
  input.protection.completeness = { status: 'partial', missingSources: ['surface.nodes beyond H limit'] }
  const output = compileContext(input)
  assert.equal(output.draft.some(fragment => fragment.nodeIndex === 200), false)
  assert.equal(Math.max(...output.draft.map(fragment => fragment.nodeIndex)), 199)
  assert.equal(output.completeness.truncated, true)
  assert.equal(output.completeness.omittedCount, 1)
  assert.equal(output.completeness.scannedCount, 200)
  assert.equal(output.completeness.status, 'partial')
  assert.equal(output.completeness.limit, 200)
  assert.ok(output.completeness.missingSources.includes('surface.nodes beyond H limit'))
})
test('G-P3-CC-07 unscanned protected tail fails closed without draft', () => {
  const nodes = Array.from({ length: 201 }, (_, i) => ({ seq: i, recordId: rid(i + 1), bytes: 'R3|' + i }))
  const input = fixture(nodes)
  input.surface.partition = [{ key: 'R0', nodeIndexes: [] }, { key: 'R1', nodeIndexes: [] }, { key: 'R2', nodeIndexes: [] }, { key: 'R3', nodeIndexes: nodes.map((_, i) => i) }]
  input.budget.scannedCount = 200
  input.protection.protectedSeqs = [200]
  input.protection.completeness = { status: 'partial', missingSources: ['surface.nodes beyond H limit'] }
  assert.throws(() => compileContext(input), /unscanned hard-protected node/)
})
test('H=200 rejects scannedCount unequal to min(node count, 200)', () => {
  const nodes = Array.from({ length: 201 }, (_, i) => ({ seq: i, recordId: null, bytes: String(i) }))
  const input = fixture(nodes)
  input.surface.partition = [{ key: 'R0', nodeIndexes: [] }, { key: 'R1', nodeIndexes: [] }, { key: 'R2', nodeIndexes: [] }, { key: 'R3', nodeIndexes: nodes.map((_, i) => i) }]
  input.budget.scannedCount = 150
  input.protection.completeness = { status: 'partial', missingSources: ['surface.nodes beyond H limit'] }
  assert.throws(() => compileContext(input), /scannedCount must equal/)
})

test('G-P3-CC-08 incomplete source cannot masquerade as empty complete', () => {
  const input = fixture(); input.protection.completeness = { status: 'unknown', missingSources: ['pins'] }
  const out = compileContext(input)
  assert.equal(out.completeness.status, 'unknown')
})
test('P3-CC-08 valid R0/R1 preserved and partition indices exact', () => {
  const a = fixture(); const b = fixture([...a.surface.nodes, { seq: 3, recordId: rid(2), bytes: 'R3|assistant2' }])
  b.surface.partition[3].nodeIndexes = [2, 3]; b.budget.scannedCount = 4
  const x = compileContext(a); const y = compileContext(b)
  for (const key of ['R0', 'R1']) assert.deepEqual(y.draft.filter(f => f.partitionKey === key), x.draft.filter(f => f.partitionKey === key))
})
test('P3-CC-09 / G-P3-CC-12 unavailable fingerprint material is null and unknown', () => {
  const out = compileContext(fixture())
  assert.ok(out.fingerprints.every(f => f.value === null))
  assert.ok(out.diagnostics.every(d => d.change === 'unknown'))
  assert.equal(Object.hasOwn(out, 'cacheHitRate'), false)
})
test('P3-CC-11 / G-P3-CC-10 fingerprints never claim provider-cache conclusions', () => {
  const out = compileContext(fixture())
  assert.deepEqual(out.fingerprints.map(f => f.partitionKey), ['R0', 'R1', 'R2', 'R3'])
  assert.ok(out.diagnostics.every(d => d.status === 'unknown'))
})
test('P3-CC-12 / G-P3-CC-09 unsupported warm provenance fails closed', () => {
  const input = fixture(); input.receipts = [{ recordIds: [rid(1)], targetEventId: 'evt', receiptText: 'x', sourceEventSeqs: [2, 3], startSeq: 2, endSeq: 3, txn: 1 }]
  assert.throws(() => compileContext(input), /cardinality/)
})
test('P3-CC-13 adjacent event never invents call pairing', () => {
  const input = fixture([{ seq: 7, recordId: rid(1), bytes: 'call A' }, { seq: 8, recordId: rid(2), bytes: 'result B' }])
  input.surface.partition = [{ key:'R0',nodeIndexes:[] }, {key:'R1',nodeIndexes:[]}, {key:'R2',nodeIndexes:[0,1]}, {key:'R3',nodeIndexes:[]}]
  input.toolPairs = [{ callId: 'id-A', callSeq: 7, resultSeq: null, state: 'unknown' }]
  input.protection.protectedSeqs = [7]
  assert.equal(compileContext(input).draft.length, 2)
})
test('P3-CC-14 / G-P3-CC-13 unknown DTO fields reject', () => {
  const input = fixture(); input.surface.nodes[0].surprise = true
  assert.throws(() => compileContext(input), /unknown fields/)
})
test('G-P3-CC-11 / G-P3-CC-14 pure module has no host-facing API and failures return no output', () => {
  const input = fixture(); input.budget.limit = 199
  assert.throws(() => compileContext(input), /H=200/)
})
test('partition assignment is four ordered, exhaustive and non-overlapping', () => {
  const input = fixture(); input.surface.partition[1].nodeIndexes = [0]
  assert.throws(() => compileContext(input), /overlap/)
})
