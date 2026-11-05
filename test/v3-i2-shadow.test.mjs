import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { compareCompressionShadow, guardShadowPorts, SHADOW_LIMITS } from '../src/v3/application/compression-shadow.mjs'
import { generationVersionTuple, makeGenerationRecord, GENERATION_VERSION_FIELDS } from '../src/v3/domain/compress/i2/generation-record.mjs'
import { selectStepSpan } from '../src/v3/domain/archive/steps.mjs'
import { fnv1a64Of } from '../src/v3/shared/fnv1a64.mjs'

const step = (turn, index, start) => [
  { seq: start, type: 'step/start', data: { turn, step: index } },
  { seq: start + 1, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'source-' + start }] } } },
  { seq: start + 2, type: 'step/end', data: { turn, step: index } },
]
const eventsOf = (count = 3) => Array.from({ length: count }, (_, i) => step(1, i + 1, 1 + i * 3)).flat()
const selectedOf = (events, selectorOptions = {}) => {
  const surfaceNodes = events.filter((event) => !event.type.startsWith('step/')).map((event) => event.seq)
  return { surfaceNodes, selected: selectStepSpan({ surfaceNodes, events, hasRecord: () => true, retainSteps: 1, bypassBatch: true, batchSteps: 200, ...selectorOptions }) }
}
const readyInput = (overrides = {}) => {
  const events = overrides.events ?? eventsOf()
  const { surfaceNodes, selected } = selectedOf(events, overrides.selectorOptions)
  const recordBySeq = Object.fromEntries(surfaceNodes.map((seq) => [seq, { id: 'r' + seq, sourceChars: 1000 }]))
  const segments = selected?.segments ?? []
  return {
    enabled: true,
    capabilities: { surfaceNodes: true, surfaceTextAt: true },
    snapshotChanged: false,
    surfaceReadable: true,
    indexAvailable: true,
    intentPending: false,
    argumentsValid: true,
    surfaceNodes,
    events,
    recordBySeq,
    receiptText: 'receipt',
    receiptTextBySegment: segments.map(() => 'receipt'),
    parentRangeBySegment: segments.map(() => null),
    ...overrides,
    selectorOptions: { retainSteps: 1, bypassBatch: true, batchSteps: 200, ...(overrides.selectorOptions ?? {}) },
  }
}

test('disabled is null and performs no reads or reports', () => {
  let touched = false
  const hostile = new Proxy({}, { get() { touched = true; throw new Error('read') } })
  assert.equal(compareCompressionShadow({ enabled: false, hostile }), null)
  assert.equal(touched, false)
})

test('version tuple and five-element generation record validate exact source sequence mapping', () => {
  const versions = generationVersionTuple()
  assert.deepEqual(Object.keys(versions), [...GENERATION_VERSION_FIELDS])
  assert.equal(versions.receiptBudgetIdentity, 'rb-400-40-12')
  const args = { candidateRange: { startSeq: 2, endSeq: 3, sourceEventSeqs: [2, 3] }, parentRange: null, sourceRecordIds: ['r2', 'r3'], sourceRecordSeqs: [2, 3], transientSeqs: [], reason: 'shadow-compare', restoreEntry: { kind: 'record-read', recordIds: ['r2', 'r3'], expectedReceiptChars: 4 } }
  const built = makeGenerationRecord(args)
  assert.equal(built.ok, true)
  assert.deepEqual(Object.keys(built.record), ['parentRange', 'sourceRecordIds', 'generationVersionTuple', 'reason', 'recoveryEntry'])
  assert.deepEqual(Object.keys(built.record.generationVersionTuple), ['contractVersion', 'summaryVersion', 'receiptBudgetIdentity'])
  assert.equal(makeGenerationRecord({ ...args, sourceRecordSeqs: [3, 2] }).reason, 'generation-record-incomplete')
  assert.equal(makeGenerationRecord({ ...args, sourceRecordSeqs: [2] }).reason, 'generation-record-incomplete')
  assert.equal(makeGenerationRecord({ ...args, versions: { ...versions, receiptBudgetIdentity: null } }).reason, 'generation-record-incomplete')
  assert.equal(makeGenerationRecord({ ...args, versions: { ...versions, contractVersion: 999 } }).reason, 'generation-record-incomplete')
  assert.equal(makeGenerationRecord({ ...args, versions: { ...versions, receiptBudgetIdentity: 'rb-fake' } }).reason, 'generation-record-incomplete')
})

// 合同文档只存在于源码线（不进发布包）。路径按本文件位置推导，不依赖旧 worktree 的
// 五层上溯：`plugin/test` → `plugin` → `记忆上下文`。文档缺失时用 skip，而不是 ENOENT 失败。
const CONTRACT_DOC = new URL('../../docs/dev-上下文缓存改进/证据/I2-generation-compression-contract.md', import.meta.url)
const contractDocExists = existsSync(CONTRACT_DOC)

test('contract freezes four tuple locations and canonical tuple fields', { skip: !contractDocExists ? '合同文档不在当前树（发布镜像内运行）' : false }, async () => {
  const contract = await readFile(CONTRACT_DOC, 'utf8')
  const tuple = ['contractVersion', 'summaryVersion', 'receiptBudgetIdentity']
  assert.deepEqual(Object.keys(generationVersionTuple()), tuple)
  const references = contract.slice(contract.indexOf('#### 3.2.3'), contract.indexOf('#### 3.2.4'))
  for (const position of ['§3.2 五要素第 3 项', '§3.1 报告', '§4.1 隔离表', '§4.3 指纹白名单']) assert.ok(references.includes(position), 'missing tuple position: ' + position)
  assert.ok(contract.includes('{contractVersion, summaryVersion, receiptBudgetIdentity}'))
})

test('identity hashes candidateRange and parentRange fifth, excludes recoveryEntry', () => {
  const candidateRange = { startSeq: 2, endSeq: 3, sourceEventSeqs: [2, 3] }
  const parentRange = { startSeq: 0, endSeq: 1, sourceEventSeqs: [0, 1] }
  const args = { candidateRange, parentRange, sourceRecordIds: ['r2', 'r3'], sourceRecordSeqs: [2, 3], transientSeqs: [], reason: 'shadow-compare', restoreEntry: { kind: 'record-read', recordIds: ['r2', 'r3'], expectedReceiptChars: 4 } }
  const a = makeGenerationRecord(args)
  const changedCandidate = makeGenerationRecord({ ...args, candidateRange: { startSeq: 2, endSeq: 4, sourceEventSeqs: [2, 3, 4] }, sourceRecordIds: ['r2', 'r3', 'r4'], sourceRecordSeqs: [2, 3, 4], transientSeqs: [], restoreEntry: { kind: 'record-read', recordIds: ['r2', 'r3', 'r4'], expectedReceiptChars: 4 } })
  const recoveryOnly = makeGenerationRecord({ ...args, restoreEntry: { kind: 'record-read', recordIds: ['r2', 'r3'], expectedReceiptChars: 99 } })
  const parentChanged = makeGenerationRecord({ ...args, parentRange: { startSeq: 1, endSeq: 1, sourceEventSeqs: [1] } })
  assert.notEqual(a.compressionGenerationId, changedCandidate.compressionGenerationId)
  assert.equal(a.compressionGenerationId, recoveryOnly.compressionGenerationId)
  assert.notEqual(a.compressionGenerationId, parentChanged.compressionGenerationId)
  const material = JSON.stringify({ candidateRange, sourceRecordIds: ['r2', 'r3'], generationVersionTuple: a.record.generationVersionTuple, reason: 'shadow-compare', parentRange })
  assert.equal(a.compressionGenerationId, 'i2g-' + fnv1a64Of(material))
})

test('missing, false, and stale required state gates fail closed distinctly', () => {
  const base = readyInput()
  for (const key of ['snapshotChanged', 'surfaceReadable', 'indexAvailable', 'intentPending', 'argumentsValid']) {
    const result = compareCompressionShadow({ ...base, [key]: undefined })
    assert.equal(result.status, 'unknown', key)
    assert.equal(result.decision, null, key)
  }
  assert.equal(compareCompressionShadow({ ...base, surfaceReadable: false }).status, 'unavailable')
  assert.equal(compareCompressionShadow({ ...base, indexAvailable: false }).status, 'unavailable')
  assert.equal(compareCompressionShadow({ ...base, snapshotChanged: true }).status, 'stale')
  assert.equal(compareCompressionShadow({ ...base, intentPending: true }).status, 'conflict')
  assert.equal(compareCompressionShadow({ ...base, argumentsValid: false }).status, 'rejected')
  assert.equal(compareCompressionShadow({ ...base, capabilities: { surfaceNodes: true } }).status, 'unknown')
})

test('shadow processes every selector segment with per-segment identity, decision, and blockers', () => {
  const events = eventsOf(5)
  const selectorOptions = { pinnedSeqs: new Set([5]) }
  const input = readyInput({ events, selectorOptions })
  const expected = selectStepSpan({ surfaceNodes: input.surfaceNodes, events, hasRecord: () => true, retainSteps: 1, bypassBatch: true, batchSteps: 200, ...selectorOptions })
  assert.equal(expected.segments.length, 2)
  const result = compareCompressionShadow(input)
  assert.equal(result.status, 'partial', JSON.stringify(result))
  assert.equal(result.segments.length, expected.segments.length)
  assert.deepEqual(Object.keys(result.safety), ['turnBoundary', 'turnAnchor', 'pluginBoundary', 'pinned', 'missingRecord', 'unfinishedTool', 'dense', 'emptyRecords', 'withinH200', 'surfaceChanged', 'netPositive'])
  assert.ok(result.segments.every((row) => Object.keys(row.safety).length === 11 && Object.keys(row.safetyEvidence).length === 11))
  assert.deepEqual(result.segments.map((row) => row.candidateRange.sourceEventSeqs), expected.segments.map((segment) => segment.sourceEventSeqs))
  assert.ok(result.segments.every((row) => row.decision === 'fold' && row.generation.compressionGenerationId))
  assert.ok(result.skipped.some((row) => row.reason === 'pinned'))
  assert.deepEqual(result.segments.map((row) => row.sourceRecordIds), expected.segments.map((segment) => segment.recordSeqs.map((seq) => input.recordBySeq[seq].id)))
})

test('unprovable record identity/order is rejected rather than shortened', () => {
  const input = readyInput()
  const firstSeq = input.surfaceNodes[0]
  input.recordBySeq[firstSeq].id = null
  const result = compareCompressionShadow(input)
  assert.equal(result.status, 'rejected')
  assert.equal(result.reason, 'generation-record-incomplete')
  const mapped = readyInput()
  mapped.recordBySeq[mapped.surfaceNodes[0]].id = ''
  assert.equal(compareCompressionShadow(mapped).status, 'rejected')
})

test('deep report does not insert schema-invalid depth marker and output never exceeds budget', () => {
  const tooDeep = readyInput({ selectorOptions: {} })
  tooDeep.surfaceNodes = Array.from({ length: 18 }, (_, i) => i)
  tooDeep.events = []
  tooDeep.recordBySeq = {}
  const depth = compareCompressionShadow({ ...tooDeep, reportDetail: Array.from({ length: 20 }, () => ({})) })
  assert.notEqual(depth.reason, '[depth-limit]')
  const large = compareCompressionShadow({ ...readyInput(), receiptTextBySegment: ['x'.repeat(100000)] })
  assert.ok(JSON.stringify(large).length <= SHADOW_LIMITS.characters)
  if (large.truncated) assert.equal(large.detailsOmitted, true)
})

test('reports at most 64 selected segments and records omitted spans', () => { const events = eventsOf(130); const selectorOptions = { pinnedSeqs: new Set(Array.from({ length: 65 }, (_, i) => 5 + i * 6)) }; const input = readyInput({ events, selectorOptions }); const selected = selectStepSpan({ surfaceNodes: input.surfaceNodes, events, hasRecord: () => true, retainSteps: 1, bypassBatch: true, batchSteps: 200, ...selectorOptions }); assert.equal(selected.segments.length, 65); const result = compareCompressionShadow(input); assert.ok(JSON.stringify(result).length <= SHADOW_LIMITS.characters); assert.ok((result.segments ? result.segments.length : 0) <= SHADOW_LIMITS.segments); if (result.decision === 'fold') { assert.equal(result.status, 'partial'); assert.equal(result.omittedSegments, 1); assert.equal(result.truncated, true); assert.ok(result.segments.every((segment) => segment.generation && segment.generation.compressionGenerationId)); } else { assert.equal(result.decision, null); assert.equal(result.status, 'partial'); assert.equal(result.omittedSegments, 65); assert.equal(result.detailsOmitted, true); } })

test('isolated mutation invokes an actual writer through compare execution and disabling guard makes invariant red', async () => {
  const sourceUrl = new URL('../src/v3/application/compression-shadow.mjs', import.meta.url)
  const source = await readFile(sourceUrl, 'utf8')
  const importsResolved = "import { writeFileSync } from 'node:fs'\n" + source.replace(/from '([^']+)'/g, (_match, specifier) => "from '" + new URL(specifier, sourceUrl).href + "'")
  const injectedCall = "    const mutationWriter = guardShadowPorts({ store: { appendVoucher(path) { writeFileSync(path, 'persisted') } } })\n    mutationWriter.store.appendVoucher(input.writerPath)\n"
  const insertionPoint = '    const caps = input.capabilities\n'
  const inserted = importsResolved.replace(insertionPoint, injectedCall + insertionPoint)
  assert.notEqual(inserted, importsResolved, 'mutation insertion point must exist')
  const unguarded = inserted.replace('return (..._args) => rejectShadowWrite(label + \'.\' + key)', 'return value.bind(inner)')
  assert.notEqual(unguarded, inserted, 'guard removal mutation must exist')
  const deepCall = "    let deepDetail = {}; for (let depth = 0; depth < 20; depth += 1) deepDetail = { nested: deepDetail }; return report('ok', 'fold', null, deepDetail)\n"
  const deepMutant = importsResolved.replace(insertionPoint, deepCall + insertionPoint)
  const largeCall = "    return report('ok', 'fold', null, { payload: 'x'.repeat(40000) })\n"
  const largeMutant = importsResolved.replace(insertionPoint, largeCall + insertionPoint)
  const temp = await mkdtemp(join(tmpdir(), 'i2-shadow-mutant-'))
  try {
    const sourceFile = join(temp, 'shadow-mutant.mjs')
    const unguardedFile = join(temp, 'shadow-unguarded.mjs')
    const deepFile = join(temp, 'shadow-deep-report.mjs')
    const largeFile = join(temp, 'shadow-large-report.mjs')
    await writeFile(sourceFile, inserted, 'utf8')
    await writeFile(unguardedFile, unguarded, 'utf8')
    await writeFile(deepFile, deepMutant, 'utf8')
    await writeFile(largeFile, largeMutant, 'utf8')
    const guardedModule = await import(pathToFileURL(sourceFile).href + '?mutation=' + Date.now())
    const unguardedModule = await import(pathToFileURL(unguardedFile).href + '?mutation=' + Date.now())
    const deepModule = await import(pathToFileURL(deepFile).href + '?mutation=' + Date.now())
    const largeModule = await import(pathToFileURL(largeFile).href + '?mutation=' + Date.now())
    const guardedPath = join(temp, 'guarded-write.txt')
    const unguardedPath = join(temp, 'unguarded-write.txt')
    const guardedResult = guardedModule.compareCompressionShadow(readyInput({ writerPath: guardedPath }))
    const unguardedResult = unguardedModule.compareCompressionShadow(readyInput({ writerPath: unguardedPath }))
    const deepResult = deepModule.compareCompressionShadow(readyInput())
    const largeResult = largeModule.compareCompressionShadow(readyInput())
    assert.equal(guardedResult.status, 'failed')
    assert.equal(guardedResult.reason, 'shadow-error')
    assert.equal(existsSync(guardedPath), false, 'guarded compare path must have no persistence side effect')
    assert.notEqual(unguardedResult.reason, 'shadow-error')
    assert.equal(existsSync(unguardedPath), true, 'removing the guard must invoke the real writer')
    assert.equal(readFileSync(unguardedPath, 'utf8'), 'persisted')
    assert.throws(() => assert.equal(existsSync(unguardedPath), false), assert.AssertionError, 'mutant must violate the no-write invariant')
    assert.equal(deepResult.status, 'failed')
    assert.equal(deepResult.reason, 'shadow-report-depth-exceeded')
    assert.equal(largeResult.truncated, true)
    assert.ok(JSON.stringify(largeResult).length <= SHADOW_LIMITS.characters)
  } finally { await rm(temp, { recursive: true, force: true }) }
})

test('H3 端口守卫：白名单读方法放行，未知写方法/赋值/删除全部拒绝', () => {
  const port = {
    get(id) { return 'row:' + id },
    list() { return [] },
    set() { return 'written' },
    persist() { return 'written' },
    add() { return 'written' },
    store() { return 'written' },
    merge() { return 'written' },
    nested: { forget() { return 'written' }, read() { return 'nested-read' } },
    rows: [1, 2, 3],
    name: 'port',
  }
  const guarded = guardShadowPorts({ store: port })
  // 读方法照常可用（且 this 绑定到原对象）
  assert.equal(guarded.store.get('a'), 'row:a')
  assert.deepEqual(guarded.store.list(), [])
  assert.equal(guarded.store.name, 'port', '数据属性可读')
  // 旧实现漏过的非黑名单写方法
  for (const method of ['set', 'persist', 'add', 'store', 'merge']) {
    assert.throws(() => guarded.store[method](), new RegExp('shadow-write-forbidden:store\\.' + method), method)
  }
  // 二级对象同样受管
  assert.equal(guarded.store.nested.read(), 'nested-read')
  assert.throws(() => guarded.store.nested.forget(), /shadow-write-forbidden:store\.nested\.forget/)
  // 赋值 / 定义 / 删除
  assert.throws(() => { guarded.store.set = 'x' }, /shadow-write-forbidden/)
  assert.throws(() => { guarded.store.rows.push(4) }, /shadow-write-forbidden/)
  assert.throws(() => Object.defineProperty(guarded.store, 'injected', { value: 1 }), /shadow-write-forbidden/)
  assert.throws(() => { delete guarded.store.name }, /shadow-write-forbidden/)
  // 真实 port 未被改动
  assert.deepEqual(port.rows, [1, 2, 3])
  assert.equal(port.name, 'port')
})

test('H3 端口守卫：then 不被当成写方法（不会把 port 变成 thenable）', async () => {
  const guarded = guardShadowPorts({ store: { read: () => 'ok' } })
  assert.equal(guarded.store.then, undefined)
  const awaited = await Promise.resolve(guarded.store)
  assert.equal(typeof awaited.read, 'function')
})
