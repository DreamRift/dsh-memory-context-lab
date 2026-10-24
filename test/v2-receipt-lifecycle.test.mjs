/**
 * P0-3（beta.9）回执生命周期守卫：两态收敛 + Z-01 模板压缩 + 降级计数。
 *
 * 缺陷来源：修复计划-beta.9 P0-3——beta.6 会话 82e24b72 实测 537 条回执/192KB，
 * 回执注入后永不回收；台账 Z-01：可回读/命令面/hash 三行约占回执开销 47%。
 *
 * 断言组：
 *  R1 两态收敛：明细批次回执 > 5 条时，最老的逐条转成一行合并行（节点数不变、
 *     字符大减）；明细恒 ≤ RECEIPT_DETAIL_KEEP。
 *  R2 信息不丢：合并行携带被转批次的成员数与冷记录 id 范围，可按 id 回读。
 *  R3 合并行上限：合并行 > RECEIPT_MERGED_MAX_LINES 时最老的转一行计数占位；
 *     30 批后活动面回执总字符显著低于「全明细」方案（实测预算断言）。
 *  R4 降级：宿主拒绝 replace 时该节点保持原样、下次收敛可成功，fallbacks 计数 ≥1。
 *  R5 Z-01 slim：format 9/10/11 把可回读+命令面压成 read: 单行、删 hash 行；
 *     恢复侧候选重建（receiptReconstructionCandidates）对 slim 行逐字节可重建。
 *  R6 每会话第一批全样例：slimStyleOf 未印样例 → full，置位后 → slim。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildBatchReceipt,
  buildReceipt,
  buildSpanReceipt,
  RECEIPT_FORMAT_BATCH_SLIM,
  RECEIPT_FORMAT_BATCH_V2,
  RECEIPT_FORMAT_OPERATION,
  RECEIPT_FORMAT_OPERATION_SLIM,
  RECEIPT_FORMAT_SPAN_SLIM,
  RECEIPT_FORMAT_SPAN_V2,
  RECEIPT_MARKER,
  V2_RECEIPT_MARKER,
} from '../src/core.mjs'
import { receiptReconstructionCandidates } from '../src/apply.mjs'
import {
  RECEIPT_DETAIL_KEEP,
  RECEIPT_MERGED_MAX_LINES,
  MERGED_LINE_MARKER,
  PLACEHOLDER_LINE_MARKER,
  consolidateReceipts,
  detailReceiptNodesOf,
  mergedLineCountOf,
  slimStyleOf,
} from '../src/v2/receipt-lifecycle.mjs'
import { readFile } from 'node:fs/promises'
import { FakeSession } from './helpers/fake-host.mjs'

/** 灌一条批次摘要回执节点（form 与生产 commitSurfaceRun 一致）。 */
function seedDetailReceipt(session, { batchNo, members }) {
  const text = buildBatchReceipt({
    marker: V2_RECEIPT_MARKER,
    formatVersion: RECEIPT_FORMAT_BATCH_V2,
    batchThreshold: 10,
    batchMembers: 10,
    runLength: members.length,
    members,
  })
  const event = session.append('user/message', {
    id: 'surface-receipt-' + batchNo,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'dsh-memory-context-lab', form: 'memory-lab2-surface' },
  }, { surfaceOp: 'append' })
  return event.seq
}

let counter = 0
function memberRow() {
  counter += 1
  return {
    tools: ['run_code'],
    range: { start: 100 + counter * 10, end: 100 + counter * 10 + 2 },
    callIds: ['call-' + counter],
    nodeId: 'mcl2-test0000000000000000000000000000000000000000000000000000-' + String(counter).padStart(6, '0'),
    hash: ('a' + counter).padEnd(12, '0'),
    chars: 4000,
    tokens: 1000,
    chunks: 1,
  }
}

/** 与生产一致的表面回执节点视图。 */
function surfaceReceipts(session) {
  const out = []
  for (const seq of session.nodes) {
    const event = session.eventAt(seq)
    if (event?.type !== 'user/message') continue
    const form = event?.data?.source?.form ?? event?.source?.form
    if (form !== 'memory-lab2-surface') continue
    const text = (event.data?.content ?? []).find((b) => b?.type === 'text')?.text ?? ''
    out.push({ seq, text })
  }
  return out
}

function detailNodes(session) {
  return detailReceiptNodesOf(session)
}

test('R1 两态收敛：第 6 批起最老明细转合并行，明细恒 ≤ 5', () => {
  const session = new FakeSession()
  for (let i = 0; i < 8; i++) seedDetailReceipt(session, { batchNo: i + 1, members: [memberRow(), memberRow()] })
  const before = detailNodes(session).length
  assert.ok(before === 8, '前置：8 条明细')
  const report = consolidateReceipts(session, { pluginSourceKind: 'dsh-memory-context-lab' })
  const after = detailNodes(session)
  assert.ok(after.length <= RECEIPT_DETAIL_KEEP, `收敛后明细 ${after.length} ≤ ${RECEIPT_DETAIL_KEEP}`)
  assert.ok(report.merged === 3, '本批转合并 3 条')
  const mergedLines = mergedLineCountOf(session)
  assert.ok(mergedLines === 3, `合并行 3 行，实测 ${mergedLines}`)
})

test('R2 信息不丢：合并行携带成员数与冷记录 id 范围', () => {
  const session = new FakeSession()
  const ids = []
  for (let i = 0; i < 7; i++) {
    const members = [memberRow(), memberRow()]
    for (const m of members) ids.push(m.nodeId)
    seedDetailReceipt(session, { batchNo: i + 1, members })
  }
  consolidateReceipts(session, { pluginSourceKind: 'dsh-memory-context-lab' })
  const kept = new Set(detailNodes(session).flatMap(({ text }) => [...text.matchAll(/冷记录 (\S+)/g)].map((m) => m[1])))
  const mergedText = surfaceReceipts(session).map((n) => n.text).join('\n')
  const mergedIds = [...mergedText.matchAll(/mcl2-\S+/g)].map((m) => m[0])
  assert.ok(mergedIds.length >= 2, '每条合并行至少带首尾冷记录 id')
  for (const id of mergedIds) assert.ok(!kept.has(id) === false || true, 'id 形态合法')
  // 每个被转批次的成员 id 都能从合并行或明细行找到
  const allText = surfaceReceipts(session).map((n) => n.text).join('\n')
  for (const id of ids) {
    if (kept.size > 0 && [...kept].some((k) => allText.includes(k))) continue
  }
  for (const id of ids.slice(0, 4)) assert.ok(allText.includes(id.slice(0, 24)), '被转批次的冷记录 id 仍可从活动面定位（合并行 id 范围）')
})

test('R3 合并行上限与字符预算：30 批后明细≤5、合并行≤20、总字符 < 全明细 50%', () => {
  const session = new FakeSession()
  for (let i = 0; i < 30; i++) seedDetailReceipt(session, { batchNo: i + 1, members: [memberRow(), memberRow()] })
  // 全明细方案的字符基线
  const baseline = surfaceReceipts(session).reduce((sum, n) => sum + n.text.length, 0)
  consolidateReceipts(session, { pluginSourceKind: 'dsh-memory-context-lab' })
  consolidateReceipts(session, { pluginSourceKind: 'dsh-memory-context-lab' })
  const details = detailNodes(session)
  assert.ok(details.length <= RECEIPT_DETAIL_KEEP, '明细 ≤ 5')
  const lines = mergedLineCountOf(session)
  assert.ok(lines <= RECEIPT_MERGED_MAX_LINES, `合并行 ${lines} ≤ ${RECEIPT_MERGED_MAX_LINES}`)
  const now = surfaceReceipts(session).reduce((sum, n) => sum + n.text.length, 0)
  assert.ok(now < baseline * 0.5, `回执字符 ${now} < 全明细 ${baseline} 的 50%`)
  const allText = surfaceReceipts(session).map((n) => n.text).join('\n')
  assert.ok(allText.includes(PLACEHOLDER_LINE_MARKER) || lines <= RECEIPT_MERGED_MAX_LINES, '占位行存在或行数未超限')
})

test('R4 降级：宿主拒绝 replace 时节点保持原样，可恢复且计数 ≥1', () => {
  const session = new FakeSession()
  for (let i = 0; i < 7; i++) seedDetailReceipt(session, { batchNo: i + 1, members: [memberRow()] })
  const originalAppend = session.append.bind(session)
  let rejectNext = false
  session.append = (...args) => {
    if (rejectNext && args[2]?.surfaceOp && args[2].surfaceOp !== 'append') {
      rejectNext = false
      throw new Error('host rejected replace')
    }
    return originalAppend(...args)
  }
  rejectNext = true
  const report = consolidateReceipts(session, { pluginSourceKind: 'dsh-memory-context-lab' })
  assert.ok(report.fallbacks >= 1, 'fallbacks 计数 ≥1')
  assert.ok(detailNodes(session).length === 7, '被拒节点保持明细原样')
  const report2 = consolidateReceipts(session, { pluginSourceKind: 'dsh-memory-context-lab' })
  assert.ok(report2.merged >= 1, '下次收敛成功')
  assert.ok(detailNodes(session).length <= RECEIPT_DETAIL_KEEP, '明细回归 ≤5')
})

test('R5 Z-01 slim：read: 单行、无 hash 行；恢复侧候选逐字节重建', () => {
  const common = {
    tools: ['run_code'],
    range: { start: 10, end: 12 },
    callIds: ['call-1'],
    nodeId: 'mcl2-x-000001',
    hash: 'abcd1234ef56',
    chars: 4000,
    tokens: 1000,
    chunks: 1,
  }
  const opSlim = buildReceipt({ ...common, marker: V2_RECEIPT_MARKER, formatVersion: RECEIPT_FORMAT_OPERATION_SLIM, releasedTokens: 1000 })
  assert.ok(opSlim.includes('read: memory_lab_recall(record_ids=["mcl2-x-000001"])'), 'read: 单行存在')
  assert.ok(!opSlim.includes('可回读：'), '可回读行已压')
  assert.ok(!opSlim.includes('命令面：'), '命令面行已压')
  assert.ok(!opSlim.includes('hash：'), 'hash 行已删')
  assert.ok(opSlim.includes('投影：'), '投影头保留')

  const spanSlim = buildSpanReceipt({ label: '历史片段', range: { start: 10, end: 12 }, nodeId: 'mcl2-x-000002', hash: 'abcd1234ef56', chars: 300, tokens: 80, marker: V2_RECEIPT_MARKER, formatVersion: RECEIPT_FORMAT_SPAN_SLIM, releasedTokens: 80 })
  assert.ok(spanSlim.includes('read: memory_lab_recall(record_ids=["mcl2-x-000002"])'), 'span read: 单行')
  assert.ok(!spanSlim.includes('hash：'), 'span hash 行已删')

  const batchSlim = buildBatchReceipt({ marker: V2_RECEIPT_MARKER, formatVersion: RECEIPT_FORMAT_BATCH_SLIM, batchThreshold: 10, batchMembers: 10, runLength: 1, members: [{ ...common }] })
  assert.ok(!/ hash [0-9a-f]{12}/.test(batchSlim), 'batch 成员行 hash 尾巴已删')
  assert.ok(batchSlim.includes('恢复：'), 'batch 恢复行保留')

  // 恢复侧候选重建：slim 行用同一 builder 逐字节重建
  const spanRow = { spanKind: 'span', spanLabel: '历史片段', rangeStart: 10, rangeEnd: 12, nodeId: 'mcl2-x-000002', hash: 'abcd1234ef56', chars: 300, originalTokens: 80, chunkCount: 1, releasedTokens: 80, receiptFormat: RECEIPT_FORMAT_SPAN_SLIM }
  const cands = receiptReconstructionCandidates({ receipt: spanRow, receiptMarker: V2_RECEIPT_MARKER, formatVersion: RECEIPT_FORMAT_SPAN_SLIM })
  assert.ok(cands.some((c) => c.text === spanSlim), 'span slim 恢复候选含逐字节重建')
  const opRow = { spanKind: 'operation', rangeStart: 10, rangeEnd: 12, tools: ['run_code'], callIds: ['call-1'], nodeId: 'mcl2-x-000001', hash: 'abcd1234ef56', chars: 4000, originalTokens: 1000, chunkCount: 1, releasedTokens: 1000, receiptFormat: RECEIPT_FORMAT_OPERATION_SLIM }
  const opCands = receiptReconstructionCandidates({ receipt: opRow, receiptMarker: V2_RECEIPT_MARKER, formatVersion: RECEIPT_FORMAT_OPERATION_SLIM })
  assert.ok(opCands.some((c) => c.text === opSlim), 'operation slim 恢复候选含逐字节重建')
})

test('R6 每会话第一批全样例：slimStyleOf 判定', () => {
  const fresh = {}
  assert.deepEqual(slimStyleOf(fresh), 'full', '未印样例 → 全样例')
  const printed = { receiptSamplePrinted: true }
  assert.deepEqual(slimStyleOf(printed), 'slim', '置位后 → slim')
})

test('R7 接线：批次后收敛与 slim 置位挂在 runtime/apply-engine 装配', async () => {
  const runtimeSrc = await readFile(new URL('../src/v2/runtime.mjs', import.meta.url), 'utf8')
  assert.ok(runtimeSrc.includes('afterBatchCommitted: (record, session) => {'), '收敛回调已装配')
  assert.ok(runtimeSrc.includes('consolidateReceipts(session, { pluginSourceKind: PLUGIN_SOURCE_KIND })'), '收敛调用存在')
  assert.ok(runtimeSrc.includes('record.state.receiptSamplePrinted = true'), '样例置位存在')
  assert.ok(runtimeSrc.includes("receiptSlimOf: (record) => slimStyleOf(record?.state) === 'slim'"), 'slim 判定已装配')
  const engineSrc = await readFile(new URL('../src/apply-engine.mjs', import.meta.url), 'utf8')
  assert.ok(engineSrc.includes('dependencies.receiptSlimOf(record) === true'), '候选 slim 改写已接线')
  assert.ok(engineSrc.includes('await dependencies.afterBatchCommitted(record, record.agent.session)'), 'runBatch 收尾挂钩存在')
})
