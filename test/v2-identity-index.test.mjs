/**
 * v2 只读身份索引测试（0.10.1 S2a）。
 *
 * 缺陷：0.9.1/0.10.0 的 recall record_ids 只认精确 t…-r… 记录 ID，回执/工具面
 * 只暴露 mcl2-… nodeId 与 callId——按回执上唯一可见的 ID 回读必然全部落进
 * warnings（取证 R0 问题 1；五会话 8e1b seq 1238 实测形状）。判据：S2a 别名解析
 * 落地后，nodeId 基名/分块名/callId 三种形态都能解析到单元闭包的记录 ID。
 *
 * 判据来源：docs/0.10.1-方案复核与改进-20261016.md §5；G1 冻结接口
 * （docs/dev-0.10.1/README.md）。本守卫绿不等于回读链路端到端可用（runtime 接线
 * 由 v2-readback/v2-runtime 套件覆盖），勿据此推定。
 *
 * 不适用条件：宽条件（kind=/before=）与 v1 导入指针的读正文匹配属 forget 语义
 * （disposition.mjs），刻意不在本模块——回读不扩大读取范围；fork 映射解析在
 * readback 层（readRecordById 的 fork-map 回退），本模块不知道 fork。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ALIAS_EXPANSION_LIMIT,
  buildIdentityIndex,
  nodeUnitBaseOf,
  resolveReadTargets,
} from '../src/v2/identity-index.mjs'
import { RECORD_KINDS } from '../src/v2/records.mjs'

// ---------------------------------------------------------------- 条目工厂

function spanEntry(id, nodeId, { chunk = 1, spanKind = 'operation', pluginAuthored } = {}) {
  return {
    id,
    kind: RECORD_KINDS.PROJECTION_SPAN,
    refs: { spanKind },
    inline: { nodeId, chunk, ...(pluginAuthored === undefined ? {} : { pluginAuthored }) },
  }
}

function callEntry(id, callId, nodeId) {
  return { id, kind: RECORD_KINDS.OPERATION_CALL, refs: { callId, toolName: 'run_code' }, inline: { nodeId } }
}

function resultEntry(id, callId, nodeId) {
  return { id, kind: RECORD_KINDS.OPERATION_RESULT, refs: { callId }, inline: { nodeId } }
}

function userEntry(id) {
  return { id, kind: RECORD_KINDS.TURN_USER, refs: { messageId: 'm1' }, inline: {} }
}

// 单元闭包：2 分块 span + 1 call + 1 result。
const UNIT = [
  spanEntry('t00000001-r0001', 'mcl2-key-001_p1', { chunk: 1 }),
  spanEntry('t00000001-r0002', 'mcl2-key-001_p2', { chunk: 2 }),
  callEntry('t00000001-r0003', 'call_a', 'mcl2-key-001_p1'),
  resultEntry('t00000001-r0004', 'call_a', 'mcl2-key-001_p1'),
]

test('nodeUnitBaseOf：分块名归一到基名，基名与非分块名原样', () => {
  assert.equal(nodeUnitBaseOf('mcl2-key-001_p2'), 'mcl2-key-001')
  assert.equal(nodeUnitBaseOf('mcl2-key-001'), 'mcl2-key-001')
  assert.equal(nodeUnitBaseOf(null), null)
  assert.equal(nodeUnitBaseOf(123), null)
})

test('buildIdentityIndex：单元闭包 span 按 chunk 序、pair 单独成组', () => {
  const index = buildIdentityIndex(UNIT)
  assert.deepEqual(index.unitSpans.get('mcl2-key-001'), ['t00000001-r0001', 't00000001-r0002'])
  assert.deepEqual([...(index.unitPairs.get('mcl2-key-001') ?? new Set())].sort(), ['t00000001-r0003', 't00000001-r0004'])
  assert.ok(index.byCallId.has('call_a'))
})

test('buildIdentityIndex：chunk 缺省/非法按 1 处理，排序仍确定性', () => {
  const entries = [
    spanEntry('t00000001-r0002', 'mcl2-x_p1', { chunk: 'bogus' }),
    spanEntry('t00000001-r0001', 'mcl2-x_p2', {}),
  ]
  const index = buildIdentityIndex(entries)
  // 两个 chunk 都按 1 处理时，回退按记录 ID 全序 → r0001 在前。
  assert.deepEqual(index.unitSpans.get('mcl2-x'), ['t00000001-r0001', 't00000001-r0002'])
})

test('resolveReadTargets：精确记录 ID 直通', () => {
  const { resolved, unresolved } = resolveReadTargets({ targets: ['t00000001-r0003'], entries: UNIT })
  assert.equal(unresolved.length, 0)
  assert.equal(resolved.length, 1)
  assert.equal(resolved[0].resolvedVia, 'record-id')
  assert.deepEqual(resolved[0].recordIds, ['t00000001-r0003'])
})

test('resolveReadTargets：nodeId 基名展开单元闭包（span 前、pair 后）', () => {
  const { resolved, unresolved } = resolveReadTargets({ targets: ['mcl2-key-001'], entries: UNIT })
  assert.equal(unresolved.length, 0)
  assert.equal(resolved[0].resolvedVia, 'node-alias')
  assert.deepEqual(resolved[0].recordIds, ['t00000001-r0001', 't00000001-r0002', 't00000001-r0003', 't00000001-r0004'])
})

test('resolveReadTargets：分块名与基名解析到同一闭包', () => {
  const byBase = resolveReadTargets({ targets: ['mcl2-key-001'], entries: UNIT })
  const byChunk = resolveReadTargets({ targets: ['mcl2-key-001_p2'], entries: UNIT })
  assert.deepEqual(byBase.resolved[0].recordIds, byChunk.resolved[0].recordIds)
  assert.equal(byChunk.resolved[0].resolvedVia, 'node-alias')
})

test('resolveReadTargets：callId 解析到配对记录 + 单元 span 闭包', () => {
  const { resolved, unresolved } = resolveReadTargets({ targets: ['call_a'], entries: UNIT })
  assert.equal(unresolved.length, 0)
  assert.equal(resolved[0].resolvedVia, 'call-id')
  assert.ok(resolved[0].recordIds.includes('t00000001-r0003'))
  assert.ok(resolved[0].recordIds.includes('t00000001-r0004'))
  assert.ok(resolved[0].recordIds.includes('t00000001-r0001'))
  assert.ok(resolved[0].recordIds.includes('t00000001-r0002'))
})

test('resolveReadTargets：未解析目标进 unresolved（含非字符串）', () => {
  const { resolved, unresolved } = resolveReadTargets({ targets: ['mcl2-nope', '', null, 'call_none'], entries: UNIT })
  assert.equal(resolved.length, 0)
  assert.deepEqual(unresolved, ['mcl2-nope', '', null, 'call_none'])
})

test('resolveReadTargets：精确 ID 形态但库中不存在 → unresolved', () => {
  const { resolved, unresolved } = resolveReadTargets({ targets: ['t99999999-r9999'], entries: UNIT })
  assert.equal(resolved.length, 0)
  assert.deepEqual(unresolved, ['t99999999-r9999'])
})

test('resolveReadTargets：别名存在但闭包只有 pair → 空不误报 unresolved', () => {
  const entries = [callEntry('t00000001-r0003', 'call_a', 'mcl2-key-001_p1')]
  const { resolved } = resolveReadTargets({ targets: ['mcl2-key-001'], entries })
  assert.equal(resolved[0].resolvedVia, 'node-alias')
  assert.deepEqual(resolved[0].recordIds, ['t00000001-r0003'])
})

test('resolveReadTargets：展开超上限抛 EALIASEXPANDLIMIT，不静默截断', () => {
  const many = []
  for (let i = 0; i < ALIAS_EXPANSION_LIMIT + 1; i += 1) {
    many.push(spanEntry('t00000001-r' + String(i + 1).padStart(4, '0'), 'mcl2-big_p1', { chunk: 1 }))
  }
  assert.throws(
    () => resolveReadTargets({ targets: ['mcl2-big'], entries: many }),
    (error) => error?.code === 'EALIASEXPANDLIMIT',
  )
})

test('resolveReadTargets：不带 nodeId/callId 的记录不进闭包（不扩大读取面）', () => {
  const entries = [...UNIT, userEntry('t00000001-r0009')]
  const { resolved } = resolveReadTargets({ targets: ['mcl2-key-001'], entries })
  assert.ok(!resolved[0].recordIds.includes('t00000001-r0009'))
})

test('resolveReadTargets：多目标各得独立闭包，不互相合并', () => {
  const entries = [
    ...UNIT,
    spanEntry('t00000002-r0001', 'mcl2-key-002_p1', { chunk: 1 }),
    callEntry('t00000002-r0002', 'call_b', 'mcl2-key-002_p1'),
  ]
  const { resolved, unresolved } = resolveReadTargets({
    targets: ['t00000001-r0001', 'mcl2-key-002', 'call_b'],
    entries,
  })
  assert.equal(unresolved.length, 0)
  assert.equal(resolved.length, 3)
  assert.deepEqual(resolved[0].recordIds, ['t00000001-r0001'])
  assert.ok(resolved[1].recordIds.includes('t00000002-r0001'))
  assert.ok(resolved[2].recordIds.includes('t00000002-r0002'))
})
