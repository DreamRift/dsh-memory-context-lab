import { selectStepSpan, STEP_BATCH_MAX } from '../domain/archive/steps.mjs'
import { callIdOf, createToolCallIndex, indexToolCallEvent, isHumanUserEvent, isPluginSurfaceEvent, isRecallPackEvent, toolCallDeclarationsOf, toolClosureOfRange } from '../domain/archive/event-shape.mjs'
import { makeGenerationRecord, generationVersionTuple } from '../domain/compress/i2/generation-record.mjs'
import { assertMclStatus } from '../contracts/status-vocabulary.mjs'

export const SHADOW_LIMITS = Object.freeze({ segments: 64, characters: 32000, depth: 16, exampleIds: 8 })
const MAX_REPORT_NODES = 512
const MAX_REPORT_STRING = 512

function cloneJsonBounded(value, budget, depth = 0, ancestors = new WeakSet()) {
  if (depth > SHADOW_LIMITS.depth) throw Object.assign(new Error('shadow-report-depth-exceeded'), { code: 'shadow-report-depth-exceeded' })
  budget.nodes += 1
  if (budget.nodes > MAX_REPORT_NODES) throw Object.assign(new Error('shadow-report-node-limit'), { code: 'shadow-report-node-limit' })
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'string') {
    if (value.length > MAX_REPORT_STRING) throw Object.assign(new Error('shadow-report-string-limit'), { code: 'shadow-report-string-limit' })
    return value
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (Array.isArray(value)) {
    const rows = value.slice(0, SHADOW_LIMITS.segments)
    if (rows.length !== value.length) budget.truncated = true
    return rows.map((item) => cloneJsonBounded(item, budget, depth + 1, ancestors))
  }
  if (typeof value === 'object') {
    if (ancestors.has(value)) throw Object.assign(new Error('shadow-report-circular'), { code: 'shadow-report-circular' })
    ancestors.add(value)
    try {
      const entries = Object.entries(value).slice(0, SHADOW_LIMITS.segments)
      if (entries.length !== Object.keys(value).length) budget.truncated = true
      return Object.fromEntries(entries.map(([key, item]) => [key.slice(0, MAX_REPORT_STRING), cloneJsonBounded(item, budget, depth + 1, ancestors)]))
    } finally { ancestors.delete(value) }
  }
  return null
}

export function shadowReport({ enabled = false } = {}) {
  if (!enabled) return null
}

function report(status, decision, reason, detail = {}) {
  assertMclStatus(status)
  const fallback = (why, finalStatus = 'partial', omittedSegments) => ({ contract: 'i2.compression-shadow/v1', status: finalStatus, decision: null, reason: why, truncated: true, detailsOmitted: true, ...(Number.isInteger(omittedSegments) ? { omittedSegments } : {}) })
  const budget = { nodes: 0, truncated: false }
  let cloned
  try { cloned = cloneJsonBounded(detail, budget) } catch (error) {
    return fallback(typeof error?.code === 'string' ? error.code : 'report-details-invalid', error?.code === 'shadow-report-depth-exceeded' ? 'failed' : 'partial', detail.totalSegments)
  }
  const defaultSafety = Object.fromEntries(SAFETY_KEYS.map((key) => [key, null]))
  const defaultSafetyEvidence = Object.fromEntries(SAFETY_KEYS.map((key) => [key, { source: 'not-evaluated', anchor: null }]))
  const value = { contract: 'i2.compression-shadow/v1', status, decision, reason: reason ?? null, safety: defaultSafety, safetyEvidence: defaultSafetyEvidence, ...cloned }
  if (budget.truncated) value.truncated = true
  const text = JSON.stringify(value)
  if (text.length <= SHADOW_LIMITS.characters) return value
  const omittedSegments = Number.isInteger(value.totalSegments) ? value.totalSegments : Array.isArray(value.segments) ? value.segments.length : undefined
  const bounded = fallback('report-budget-exceeded', 'partial', omittedSegments)
  if (JSON.stringify(bounded).length <= SHADOW_LIMITS.characters) return bounded
  return { contract: 'i2.compression-shadow/v1', status: 'failed', decision: null, reason: 'report-budget-exceeded', truncated: true, detailsOmitted: true }
}

const objectLike = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const seqRange = (segment) => ({ startSeq: segment.startSeq, endSeq: segment.endSeq, sourceEventSeqs: [...segment.sourceEventSeqs] })
const reasonOf = (value, fallback) => typeof value?.reason === 'string' ? value.reason : fallback
const SAFETY_KEYS = Object.freeze(['turnBoundary', 'turnAnchor', 'pluginBoundary', 'pinned', 'missingRecord', 'unfinishedTool', 'dense', 'emptyRecords', 'withinH200', 'surfaceChanged', 'netPositive'])
function toolClosureOfSegment(events, startSeq, endSeq, index) {
  const invocationIds = new Set()
  const resultIds = new Set()
  let malformed = false
  for (const event of events) {
    if (!Number.isInteger(event?.seq) || event.seq < startSeq || event.seq > endSeq) continue
    const declarations = toolCallDeclarationsOf(event)
    if (declarations.malformed) malformed = true
    for (const id of declarations.ids) invocationIds.add(id)
    const callId = callIdOf(event)
    if (event.type === 'tool/call' && callId !== null) invocationIds.add(callId)
    if (event.type === 'tool/result' && callId !== null) resultIds.add(callId)
  }
  if (index.malformedSeqs.has(startSeq) || [...index.malformedSeqs].some((seq) => seq >= startSeq && seq <= endSeq)) malformed = true
  return toolClosureOfRange({ invocationIds: [...invocationIds], resultIds: [...resultIds], malformed, index, startSeq, endSeq })
}

/** Pure, offline-only projection. Inputs are caller-owned snapshots; no persistence ports are accepted. */
export function compareCompressionShadow(input = {}) {
  if (input.enabled !== true) return null
  try {
    const caps = input.capabilities
    if (!objectLike(caps) || caps.surfaceNodes !== true || caps.surfaceTextAt !== true) return report('unknown', null, 'capability-unknown', { missing: ['surfaceNodes', 'surfaceTextAt'].filter((key) => caps?.[key] !== true) })
    if (typeof input.snapshotChanged !== 'boolean') return report('unknown', null, 'snapshot-state-unknown', { missing: ['snapshotChanged'] })
    if (input.snapshotChanged) return report('stale', null, 'surface-changed')
    if (input.surfaceReadable === false) return report('unavailable', null, 'surface-unreadable')
    if (input.surfaceReadable !== true) return report('unknown', null, 'surface-readability-unknown', { missing: ['surfaceReadable'] })
    if (input.indexAvailable === false) return report('unavailable', null, 'index-unavailable')
    if (input.indexAvailable !== true) return report('unknown', null, 'index-availability-unknown', { missing: ['indexAvailable'] })
    if (typeof input.intentPending !== 'boolean') return report('unknown', null, 'intent-state-unknown', { missing: ['intentPending'] })
    if (input.intentPending) return report('conflict', null, 'intent-pending')
    if (input.argumentsValid === false) return report('rejected', 'rejected-incomplete', 'invalid-arguments')
    if (input.argumentsValid !== true) return report('unknown', null, 'arguments-state-unknown', { missing: ['argumentsValid'] })
    if (!Array.isArray(input.surfaceNodes) || !Array.isArray(input.events) || !objectLike(input.recordBySeq) || typeof input.receiptText !== 'string') return report('unknown', null, 'snapshot-input-unknown', { missing: ['surfaceNodes', 'events', 'recordBySeq', 'receiptText'].filter((key) => input[key] == null) })

    const observedRejects = []
    const selectorOptions = input.selectorOptions || {}
    const selected = selectStepSpan({ ...selectorOptions, surfaceNodes: input.surfaceNodes, events: input.events, hasRecord: (seq) => input.recordBySeq[seq] != null, onReject: (row) => { observedRejects.push(row); selectorOptions.onReject?.(row) } })
    const selectedSegments = selected?.segments
    if (!selected || !Array.isArray(selectedSegments) || selectedSegments.length === 0) {
      const blocked = selected?.blocks || observedRejects
      return report('ok', 'blocked-by-safety', reasonOf(blocked[0] || selected?.blocked, 'no-safe-segment'), { segments: [], skipped: blocked })
    }
    const segmentsToProcess = selectedSegments.slice(0, SHADOW_LIMITS.segments)
    const omittedSegments = Math.max(0, selectedSegments.length - segmentsToProcess.length)

    const receiptTexts = Array.isArray(input.receiptTextBySegment) ? input.receiptTextBySegment : selectedSegments.length === 1 ? [input.receiptText] : null
    const parents = Array.isArray(input.parentRangeBySegment) ? input.parentRangeBySegment : selectedSegments.length === 1 ? [input.parentRange ?? null] : null
    if (!receiptTexts || receiptTexts.length !== selectedSegments.length || !parents || parents.length !== selectedSegments.length) return report('unknown', null, 'segment-input-unknown', { missing: ['receiptTextBySegment', 'parentRangeBySegment'], expectedSegments: selectedSegments.length })

    const versions = generationVersionTuple()
    const closureIndex = createToolCallIndex()
    for (const event of input.events) indexToolCallEvent(closureIndex, event)
    const results = []
    for (let index = 0; index < segmentsToProcess.length; index += 1) {
      const segment = segmentsToProcess[index]
      const receiptText = receiptTexts[index]
      if (typeof receiptText !== 'string') return report('unknown', null, 'segment-receipt-unknown', { missing: ['receiptTextBySegment[' + index + ']'] })
      const candidateRange = seqRange(segment)
      const surfaceStart = input.surfaceNodes.indexOf(candidateRange.startSeq)
      const surfaceEnd = input.surfaceNodes.indexOf(candidateRange.endSeq)
      if (surfaceStart < 0 || surfaceEnd < surfaceStart || !Array.isArray(candidateRange.sourceEventSeqs) || JSON.stringify(input.surfaceNodes.slice(surfaceStart, surfaceEnd + 1)) !== JSON.stringify(candidateRange.sourceEventSeqs) || candidateRange.sourceEventSeqs.some((seq) => !input.events.some((event) => event.seq === seq))) return report('unknown', null, 'surface-range-inconsistent', { segmentIndex: index })
      const sourceRecordSeqs = segment.recordSeqs
      const eventBySeq = new Map(input.events.map((event) => [event.seq, event]))
      const transientSeqs = candidateRange.sourceEventSeqs.filter((seq) => isRecallPackEvent(eventBySeq.get(seq)))
      const expectedRecordSeqs = candidateRange.sourceEventSeqs.filter((seq) => !transientSeqs.includes(seq))
      if (!Array.isArray(sourceRecordSeqs) || !Array.isArray(segment.sourceEventSeqs) || sourceRecordSeqs.length === 0 || JSON.stringify(sourceRecordSeqs) !== JSON.stringify(expectedRecordSeqs)) return report('rejected', 'rejected-incomplete', 'generation-record-incomplete', { segmentIndex: index })
      const records = sourceRecordSeqs.map((seq) => input.recordBySeq[seq])
      if (records.some((record) => !objectLike(record) || typeof record.id !== 'string' || !record.id.length || !Number.isFinite(record.sourceChars) || record.sourceChars < 0)) return report('rejected', 'rejected-incomplete', 'generation-record-incomplete', { segmentIndex: index })
      const sourceRecordIds = records.map((record) => record.id)
      if (sourceRecordIds.length !== sourceRecordSeqs.length || new Set(sourceRecordIds).size !== sourceRecordIds.length) return report('rejected', 'rejected-incomplete', 'generation-record-incomplete', { segmentIndex: index })
      const sourceChars = records.reduce((sum, record) => sum + record.sourceChars, 0)
      const range = { candidateRange, sourceRecordIds, sourceRecordSeqs: [...sourceRecordSeqs], sourceChars, receiptChars: receiptText.length }
      const rangeEvents = candidateRange.sourceEventSeqs.map((seq) => eventBySeq.get(seq))
      const sourceSeqSet = new Set(candidateRange.sourceEventSeqs)
      const turns = new Set()
      let activeTurn = null
      for (const event of [...input.events].sort((a, b) => a.seq - b.seq)) {
        if (event.type === 'step/start') activeTurn = Number.isInteger(event.data?.turn) ? event.data.turn : null
        if (sourceSeqSet.has(event.seq) && Number.isInteger(activeTurn)) turns.add(activeTurn)
      }
      const pinnedSeqs = selectorOptions.pinnedSeqs instanceof Set ? selectorOptions.pinnedSeqs : new Set()
      const closure = toolClosureOfSegment(input.events, candidateRange.startSeq, candidateRange.endSeq, closureIndex)
      const safety = {
        turnBoundary: turns.size === 0 ? null : turns.size > 1,
        turnAnchor: rangeEvents.some(isHumanUserEvent),
        pluginBoundary: rangeEvents.some((event) => isPluginSurfaceEvent(event) && !isRecallPackEvent(event)),
        pinned: candidateRange.sourceEventSeqs.some((seq) => pinnedSeqs.has(seq)),
        missingRecord: false,
        unfinishedTool: closure.closed !== true,
        dense: true,
        emptyRecords: sourceRecordSeqs.length === 0,
        withinH200: Number.isInteger(selected.scanned) ? Number.isInteger(segment.steps) && segment.steps >= 1 && segment.steps <= STEP_BATCH_MAX && selected.scanned <= STEP_BATCH_MAX : null,
        surfaceChanged: false,
        netPositive: receiptText.length < sourceChars,
      }
      const safetyEvidence = Object.fromEntries(SAFETY_KEYS.map((key) => [key, { source: key === 'surfaceChanged' ? 'snapshotChanged=false' : key === 'netPositive' ? 'receiptText.length < sum(record.sourceChars)' : key === 'withinH200' ? 'selectStepSpan.scanned + segment.steps' : key === 'unfinishedTool' ? 'toolClosureOfRange' : key === 'pinned' ? 'selectorOptions.pinnedSeqs' : key === 'missingRecord' ? 'recordBySeq + record.id' : key === 'dense' ? 'surfaceNodes[start..end] === sourceEventSeqs' : key === 'turnAnchor' ? 'isHumanUserEvent' : key === 'pluginBoundary' ? 'isPluginSurfaceEvent' : key === 'emptyRecords' ? 'sourceRecordSeqs.length === 0' : key === 'turnBoundary' ? 'step/start.data.turn' : 'step/start.data.turn', anchor: { startSeq: candidateRange.startSeq, endSeq: candidateRange.endSeq } }]))
      const blocking = ['turnBoundary', 'turnAnchor', 'pluginBoundary', 'pinned', 'missingRecord', 'unfinishedTool', 'emptyRecords'].some((key) => safety[key] === true) || ['dense', 'withinH200', 'surfaceChanged'].some((key) => safety[key] !== false && safety[key] !== true ? true : (key === 'surfaceChanged' ? safety[key] : !safety[key]))
      const unknownSafety = SAFETY_KEYS.filter((key) => safety[key] == null)
      if (unknownSafety.length) {
        results.push({ ...range, status: 'unknown', decision: null, reason: 'safety-input-unknown', safety, safetyEvidence, missing: unknownSafety })
        continue
      }
      if (blocking) {
        const blockReason = !safety.withinH200 ? 'tool-closure-exceeds-limit' : safety.turnAnchor ? 'turn-anchor' : safety.turnBoundary ? 'turn-boundary' : safety.pinned ? 'pinned' : safety.pluginBoundary ? 'plugin-boundary' : safety.unfinishedTool ? 'unfinished-tool' : safety.emptyRecords ? 'empty-records' : safety.surfaceChanged ? 'surface-changed' : 'not-dense'
        results.push({ ...range, status: 'ok', decision: 'blocked-by-safety', reason: blockReason, safety, safetyEvidence })
        continue
      }
      if (!safety.netPositive) {
        results.push({ ...range, status: 'ok', decision: 'not-worth', reason: 'not-worth', safety, safetyEvidence })
        continue
      }
      const built = makeGenerationRecord({ candidateRange, parentRange: parents[index], sourceRecordIds, sourceRecordSeqs, transientSeqs, reason: 'shadow-compare', restoreEntry: { kind: 'record-read', recordIds: sourceRecordIds, expectedReceiptChars: receiptText.length }, versions })
      if (!built.ok) return report('rejected', 'rejected-incomplete', built.reason)
      results.push({ ...range, status: 'ok', decision: 'fold', reason: null, generation: { ...built.record, compressionGenerationId: built.compressionGenerationId }, safety, safetyEvidence })
    }
    const skipped = [
      ...(selected.blocks || []),
      ...(selected.blocked ? [selected.blocked] : []),
      ...segmentsToProcess.filter((segment) => typeof segment.boundary === 'string').map((segment) => ({ reason: segment.boundary, seqs: segment.sourceEventSeqs })),
      ...(omittedSegments > 0 ? [{ reason: 'segment-limit', count: omittedSegments }] : []),
      ...results.filter((row) => row.decision === 'blocked-by-safety' || row.status === 'unknown').map((row) => ({ reason: row.reason, candidateRange: row.candidateRange })),
    ]
    if (selected.truncated === true || selected.reachedLimit === true || selected.scanned > STEP_BATCH_MAX) skipped.push({ reason: 'tool-closure-exceeds-limit', reachedLimit: true })
    const anyFold = results.some((row) => row.decision === 'fold')
    const anyNotWorth = results.some((row) => row.decision === 'not-worth')
    const anyBlocked = results.some((row) => row.decision === 'blocked-by-safety')
    const anyUnknown = results.some((row) => row.status === 'unknown')
    const partial = skipped.length > 0 || (anyFold && (anyNotWorth || anyBlocked || anyUnknown))
    const decision = anyFold ? 'fold' : anyUnknown || omittedSegments > 0 ? null : anyBlocked ? 'blocked-by-safety' : 'not-worth'
    const status = (anyUnknown || omittedSegments > 0) && !anyFold ? 'unknown' : partial ? 'partial' : 'ok'
    const safety = Object.fromEntries(SAFETY_KEYS.map((key) => {
      const values = results.map((row) => row.safety?.[key])
      return [key, values.length > 0 && values.every((value) => value != null && value === values[0]) ? values[0] : null]
    }))
    return report(status, decision, omittedSegments > 0 && !anyFold ? 'segment-limit' : skipped.length ? reasonOf(skipped[0], null) : anyNotWorth ? 'not-worth' : anyBlocked ? reasonOf(results.find((row) => row.decision === 'blocked-by-safety'), 'blocked-by-safety') : null, { segments: results, skipped, safety, safetyEvidence: results.map((row, segmentIndex) => ({ segmentIndex, criteria: row.safetyEvidence ?? null })), totalSegments: selectedSegments.length, ...(omittedSegments > 0 ? { omittedSegments, truncated: true } : {}), versions })
  } catch (error) {
    return report('failed', null, typeof error?.code === 'string' ? error.code : 'shadow-error')
  }
}

/**
 * Guard injected ports against persistence through shadow execution.
 *
 * 2026-11-04（独立审计 H3）：旧实现是「方法名黑名单 + 只拦 get」——注入的 port 只要暴露
 * `set` / `persist` / `add` / `store` / `merge` 之类不在名单里的写方法，或直接
 * `guarded.store.records = x` 赋值，就能写穿到真实 port；`Object.freeze(guarded)` 只冻结
 * 外层容器，不冻结内层对象。现在改为**白名单 + 结构陷阱**：
 * - 只有 READ_METHOD 里的读方法可调用，其它一切函数一律返回拒绝桩（未知写方法不再漏过）；
 * - `set` / `defineProperty` / `deleteProperty` / `setPrototypeOf` 四个陷阱全部拒绝；
 * - 嵌套对象/数组递归包装（同一对象用 WeakMap 去重，保持引用稳定），`store.records.forget()`
 *   这类二级写也拦得住；
 * - `then` / `toJSON` 等协议属性放行，避免把 port 变成 thenable 或破坏序列化。
 *
 * 边界（诚实说明）：JS 无法阻止持有**原始对象引用**的调用方绕过代理直接写；本守卫保证的是
 * 「经 guardShadowPorts 交出去的句柄不能写」，不是「原对象绝对不可写」。
 */
const READ_METHOD = /^(get|list|read|has|is|count|health|stats|status|snapshot|capabilities|describe|probe|peek|find|query|search|indexStats|recordCount|chunksOf|retrievalSnapshot|history|mirrorStats|reasons|available)$/
const PASSTHROUGH_PROPS = new Set(['then', 'catch', 'finally', 'toJSON', 'toString', 'valueOf', 'constructor', 'inspect'])
export function rejectShadowWrite(operation = 'write') { throw new TypeError('shadow-write-forbidden:' + String(operation)) }

export function guardShadowPorts(ports = {}) {
  const guarded = {}
  const cache = new WeakMap()
  const wrap = (label, target) => {
    if (target === null || (typeof target !== 'object' && typeof target !== 'function')) return target
    if (cache.has(target)) return cache.get(target)
    const proxy = new Proxy(target, {
      get(inner, key, receiver) {
        if (typeof key === 'symbol') return Reflect.get(inner, key, receiver)
        if (PASSTHROUGH_PROPS.has(key)) {
          const value = Reflect.get(inner, key, receiver)
          return typeof value === 'function' ? value.bind(inner) : value
        }
        const value = Reflect.get(inner, key, receiver)
        if (typeof value === 'function') {
          if (READ_METHOD.test(key)) return value.bind(inner)
          return (..._args) => rejectShadowWrite(label + '.' + key)
        }
        return wrap(label + '.' + key, value)
      },
      set(_inner, key) { return rejectShadowWrite(label + '.' + String(key)) },
      defineProperty(_inner, key) { return rejectShadowWrite(label + '.define:' + String(key)) },
      deleteProperty(_inner, key) { return rejectShadowWrite(label + '.delete:' + String(key)) },
      setPrototypeOf() { return rejectShadowWrite(label + '.setPrototypeOf') },
    })
    cache.set(target, proxy)
    return proxy
  }
  for (const [portName, port] of Object.entries(ports)) {
    if (port == null) { guarded[portName] = null; continue }
    if (typeof port !== 'object' && typeof port !== 'function') throw new TypeError('shadow-port-invalid:' + portName)
    guarded[portName] = wrap(portName, port)
  }
  return Object.freeze(guarded)
}
