const KEYS = ['R0', 'R1', 'R2', 'R3']
const STATES = new Set(['ok', 'partial', 'unknown', 'unavailable', 'stale', 'conflict', 'failed', 'rejected'])
const RECORD_ID = /^v3r-[0-9a-f]{16}$/

function fail(message) {
  const error = new TypeError(message)
  error.code = 'COMPILER_INPUT_INVALID'
  throw error
}

function object(value, path, requiredKeys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path + ' must be an object')
  const actual = Object.keys(value).sort()
  const expected = [...requiredKeys].sort()
  if (requiredKeys.length !== actual.length || actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail(path + ' has missing or unknown fields')
}

function array(value, path) {
  if (!Array.isArray(value)) fail(path + ' must be an array')
}

function string(value, path, nonempty = false) {
  if (typeof value !== 'string' || (nonempty && value.length === 0)) fail(path + ' must be a ' + (nonempty ? 'non-empty ' : '') + 'string')
}

function seq(value, path) {
  if (!Number.isSafeInteger(value) || value < 0) fail(path + ' must be a non-negative safe integer')
}

function sortedUnique(values, path) {
  array(values, path)
  for (let i = 0; i < values.length; i++) {
    seq(values[i], path + '[' + i + ']')
    if (i && values[i] <= values[i - 1]) fail(path + ' must be strictly increasing')
  }
}

function validate(input) {
  object(input, 'input', ['surface', 'receipts', 'toolPairs', 'pins', 'plan', 'protection', 'budget'])
  object(input.surface, 'surface', ['nodes', 'partition'])
  array(input.surface.nodes, 'surface.nodes')
  const bySeq = new Map()
  const recordIds = new Set()
  input.surface.nodes.forEach((node, index) => {
    object(node, 'nodes[' + index + ']', ['seq', 'recordId', 'bytes'])
    seq(node.seq, 'nodes[' + index + '].seq')
    if (index && node.seq <= input.surface.nodes[index - 1].seq) fail('node seq order')
    if (node.recordId !== null && (typeof node.recordId !== 'string' || !RECORD_ID.test(node.recordId))) fail('invalid node recordId')
    if (node.recordId !== null) {
      if (recordIds.has(node.recordId)) fail('duplicate node recordId')
      recordIds.add(node.recordId)
    }
    string(node.bytes, 'node bytes')
    bySeq.set(node.seq, { node, index })
  })
  array(input.surface.partition, 'surface.partition')
  if (input.surface.partition.length !== 4) fail('partition must contain four entries')
  const owner = new Map()
  input.surface.partition.forEach((part, index) => {
    object(part, 'partition[' + index + ']', ['key', 'nodeIndexes'])
    if (part.key !== KEYS[index]) fail('partition order/key invalid')
    sortedUnique(part.nodeIndexes, 'partition.nodeIndexes')
    for (const nodeIndex of part.nodeIndexes) {
      if (nodeIndex >= input.surface.nodes.length || owner.has(nodeIndex)) fail('partition index out of range or overlap')
      owner.set(nodeIndex, part.key)
    }
  })
  if (owner.size !== input.surface.nodes.length) fail('partition omits node')

  array(input.receipts, 'receipts')
  const receiptKeys = new Set()
  for (const [i, receipt] of input.receipts.entries()) {
    object(receipt, 'receipt[' + i + ']', ['recordIds', 'targetEventId', 'receiptText', 'sourceEventSeqs', 'startSeq', 'endSeq', 'txn'])
    array(receipt.recordIds, 'receipt.recordIds')
    if (!receipt.recordIds.length || receipt.recordIds.some(id => typeof id !== 'string' || !RECORD_ID.test(id)) || new Set(receipt.recordIds).size !== receipt.recordIds.length) fail('invalid receipt recordIds')
    if (receipt.recordIds.length !== receipt.sourceEventSeqs.length) fail('receipt source mapping cardinality mismatch')
    if (!(typeof receipt.targetEventId === 'string' && receipt.targetEventId.length || Number.isSafeInteger(receipt.targetEventId) && receipt.targetEventId >= 0)) fail('invalid receipt targetEventId')
    string(receipt.receiptText, 'receiptText', true)
    sortedUnique(receipt.sourceEventSeqs, 'sourceEventSeqs')
    if (!receipt.sourceEventSeqs.length) fail('empty receipt sourceEventSeqs')
    seq(receipt.startSeq, 'startSeq'); seq(receipt.endSeq, 'endSeq')
    if (receipt.startSeq > receipt.endSeq || receipt.startSeq !== receipt.sourceEventSeqs[0] || receipt.endSeq !== receipt.sourceEventSeqs.at(-1)) fail('receipt bounds mismatch')
    if (!Number.isSafeInteger(receipt.txn) || receipt.txn < 1) fail('invalid receipt txn')
    const identity = JSON.stringify([receipt.recordIds, receipt.targetEventId, receipt.startSeq, receipt.endSeq, receipt.txn])
    if (receiptKeys.has(identity)) fail('duplicate receipt identity')
    receiptKeys.add(identity)
  }

  array(input.toolPairs, 'toolPairs')
  const calls = new Set()
  let previousCall = -1
  for (const [i, pair] of input.toolPairs.entries()) {
    object(pair, 'toolPair[' + i + ']', ['callId', 'callSeq', 'resultSeq', 'state'])
    string(pair.callId, 'callId', true); seq(pair.callSeq, 'callSeq')
    if (calls.has(pair.callId) || pair.callSeq <= previousCall) fail('duplicate or unordered tool pair')
    calls.add(pair.callId); previousCall = pair.callSeq
    if (!bySeq.has(pair.callSeq)) fail('callSeq does not identify node')
    if (pair.resultSeq !== null) { seq(pair.resultSeq, 'resultSeq'); if (pair.resultSeq <= pair.callSeq || !bySeq.has(pair.resultSeq)) fail('invalid resultSeq') }
    if (!['closed', 'unclosed', 'unknown'].includes(pair.state)) fail('invalid tool state')
    if (pair.state === 'closed' && pair.resultSeq === null || pair.state === 'unclosed' && pair.resultSeq !== null) fail('tool state/result mismatch')
  }
  array(input.pins, 'pins')
  let previousPin = -1
  for (const [i, pin] of input.pins.entries()) {
    object(pin, 'pin[' + i + ']', ['seq', 'recordId']); seq(pin.seq, 'pin.seq')
    const found = bySeq.get(pin.seq)
    if (pin.seq <= previousPin || !found || !RECORD_ID.test(pin.recordId) || found.node.recordId !== pin.recordId) fail('invalid pin evidence')
    previousPin = pin.seq
  }
  object(input.plan, 'plan', ['planFloorSeq', 'artifactSeqs'])
  seq(input.plan.planFloorSeq, 'planFloorSeq'); sortedUnique(input.plan.artifactSeqs, 'artifactSeqs')
  for (const value of input.plan.artifactSeqs) if (!bySeq.has(value)) fail('plan artifact absent from nodes')
  object(input.protection, 'protection', ['protectedSeqs', 'completeness'])
  sortedUnique(input.protection.protectedSeqs, 'protectedSeqs')
  for (const value of input.protection.protectedSeqs) if (!bySeq.has(value)) fail('protected seq absent')
  object(input.protection.completeness, 'completeness', ['status', 'missingSources'])
  const { status, missingSources } = input.protection.completeness
  if (!STATES.has(status)) fail('invalid completeness status')
  array(missingSources, 'missingSources')
  if (missingSources.some(x => typeof x !== 'string' || !x.length) || new Set(missingSources).size !== missingSources.length || missingSources.some((x, i) => i && x <= missingSources[i - 1])) fail('missingSources must be unique Unicode-sorted strings')
  if (status === 'ok' ? missingSources.length !== 0 : missingSources.length === 0) fail('completeness/missingSources mismatch')
  object(input.budget, 'budget', ['scannedCount', 'limit'])
  seq(input.budget.scannedCount, 'scannedCount'); seq(input.budget.limit, 'limit')
  if (input.budget.limit !== 200) fail('H=200 limit must equal 200')
  if (input.budget.scannedCount !== Math.min(input.surface.nodes.length, 200)) fail('scannedCount must equal min(nodes.length, 200)')
  for (const pin of input.pins) if (!input.protection.protectedSeqs.includes(pin.seq)) fail('pin missing from protected set')
  for (const pair of input.toolPairs) if (pair.state !== 'closed') {
    for (const value of [pair.callSeq, ...(pair.resultSeq === null ? [] : [pair.resultSeq])]) if (!input.protection.protectedSeqs.includes(value)) fail('unclosed/unknown pair missing protection')
  }
  for (const value of input.plan.artifactSeqs) if (!input.protection.protectedSeqs.includes(value)) fail('plan artifact missing from protected set')
  return { bySeq, owner }
}

/** 只把输入快照编译为诊断草案；不接入宿主或生产压缩管线。 */
export function compileContext(input) {
  const { owner } = validate(input)
  const scannedCount = Math.min(input.surface.nodes.length, 200)
  const omittedCount = input.surface.nodes.length - scannedCount
  const truncated = omittedCount > 0
  const protectedSeqs = new Set(input.protection.protectedSeqs)
  for (const pin of input.pins) protectedSeqs.add(pin.seq)
  for (const seq of input.plan.artifactSeqs) protectedSeqs.add(seq)
  for (const pair of input.toolPairs) if (pair.state !== 'closed') {
    protectedSeqs.add(pair.callSeq)
    if (pair.resultSeq !== null) protectedSeqs.add(pair.resultSeq)
  }
  if (truncated) {
    for (let index = scannedCount; index < input.surface.nodes.length; index++) {
      if (protectedSeqs.has(input.surface.nodes[index].seq)) fail('unscanned hard-protected node; refusing partial draft')
    }
  }

  const draft = []
  for (const key of KEYS) for (let index = 0; index < scannedCount; index++) {
    if (owner.get(index) !== key) continue
    const node = input.surface.nodes[index]
    draft.push({ partitionKey: key, nodeIndex: index, bytes: node.bytes })
  }
  const status = truncated ? 'partial' : input.protection.completeness.status
  const gap = 'surface.nodes beyond H limit'
  const missingSources = truncated && !input.protection.completeness.missingSources.includes(gap)
    ? [...input.protection.completeness.missingSources, gap].sort()
    : [...input.protection.completeness.missingSources]
  const fingerprints = KEYS.map(partitionKey => ({ partitionKey, value: null }))
  // 指纹算法/材料未冻结；返回 null 和 unknown，绝不冒充供应商缓存命中。
  const diagnostics = KEYS.map(partitionKey => ({ partitionKey, status: 'unknown', change: 'unknown' }))
  return {
    draft,
    fingerprints,
    completeness: { status, missingSources, scannedCount, limit: 200, truncated, omittedCount },
    diagnostics
  }
}
