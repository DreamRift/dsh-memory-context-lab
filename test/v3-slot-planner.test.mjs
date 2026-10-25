/**
 * v3 双槽规划器测试（M4 第一批）。
 *
 * ## 判据来源
 * Q3-A/B（注入即替换、稳态双槽、占位回执）、P3（一次性内容命中只出现一步）、
 * P0-6（回注不进卡形态/不占槽）。
 *
 * ## 断言组
 * - 全量步：占位旧增量槽 + 替换/新建全量槽；截断兜底与首步（无全量槽）都触发全量；
 * - 增量步：替换增量槽；无增量槽时 append；
 * - nextSurfaceState 推进后稳态恒双槽（全量在、增量最新、null 只出现在刚全量刷新后）；
 * - 回注闸：同回合第二次拒、新回合放行、turn 0 拒。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { gateRecallInjection, nextSurfaceState, planSlots } from '../src/v3/domain/context/slot-planner.mjs'

test('全量步：占位旧增量槽 + 替换全量槽', () => {
  const plan = planSlots({ step: 20, surfaceState: { fullSlotSeq: 5, deltaSlotSeq: 18 } })
  assert.equal(plan.kind, 'full')
  assert.deepEqual(plan.ops, [
    { op: 'replace', targetEventId: 18, role: 'placeholder' },
    { op: 'replace', targetEventId: 5, role: 'full-slot' },
  ])
})

test('首步无全量槽 → 全量 append；截断兜底触发全量', () => {
  const first = planSlots({ step: 1, surfaceState: { fullSlotSeq: null, deltaSlotSeq: null } })
  assert.equal(first.kind, 'full')
  assert.deepEqual(first.ops, [{ op: 'append', role: 'full-slot' }])
  const truncated = planSlots({ step: 7, surfaceState: { fullSlotSeq: 5, deltaSlotSeq: 6 }, truncated: true })
  assert.equal(truncated.kind, 'full')
  assert.ok(truncated.ops.some((o) => o.role === 'placeholder'))
})

test('增量步：替换增量槽；无增量槽 append', () => {
  const plan = planSlots({ step: 7, surfaceState: { fullSlotSeq: 5, deltaSlotSeq: 6 } })
  assert.equal(plan.kind, 'delta')
  assert.deepEqual(plan.ops, [{ op: 'replace', targetEventId: 6, role: 'delta-slot' }])
  const noDelta = planSlots({ step: 8, surfaceState: { fullSlotSeq: 5, deltaSlotSeq: null } })
  assert.deepEqual(noDelta.ops, [{ op: 'append', role: 'delta-slot' }])
})

test('状态推进：稳态恒双槽；全量刷新后增量槽置空待新卡', () => {
  let state = { fullSlotSeq: null, deltaSlotSeq: null }
  state = nextSurfaceState(state, planSlots({ step: 1, surfaceState: state }), 10)
  assert.deepEqual(state, { fullSlotSeq: 10, deltaSlotSeq: null })
  state = nextSurfaceState(state, planSlots({ step: 2, surfaceState: state }), 11)
  assert.deepEqual(state, { fullSlotSeq: 10, deltaSlotSeq: 11 })
  state = nextSurfaceState(state, planSlots({ step: 20, surfaceState: state }), 30)
  assert.deepEqual(state, { fullSlotSeq: 30, deltaSlotSeq: null }, '全量后增量槽转占位待新卡')
})

test('回注闸（P3）：同回合一次、新回合放行、turn 0 拒', () => {
  const first = gateRecallInjection({ seen: new Set(), sessionKey: 's1', turn: 1 })
  assert.equal(first.emit, true)
  const again = gateRecallInjection({ seen: first.seen, sessionKey: 's1', turn: 1 })
  assert.equal(again.emit, false, '命中只出现一步')
  const nextTurn = gateRecallInjection({ seen: first.seen, sessionKey: 's1', turn: 2 })
  assert.equal(nextTurn.emit, true)
  assert.throws(() => gateRecallInjection({ seen: new Set(), sessionKey: 's1', turn: 0 }), (e) => e?.name === 'V3ContractViolation')
})

test('非法输入失败关闭', () => {
  assert.throws(() => planSlots({ step: 0, surfaceState: { fullSlotSeq: null, deltaSlotSeq: null } }), (e) => e?.name === 'V3ContractViolation')
  assert.throws(() => planSlots({ step: 1, surfaceState: {} }), (e) => e?.name === 'V3ContractViolation')
  assert.throws(() => planSlots({ step: 1, surfaceState: { fullSlotSeq: 1, deltaSlotSeq: 1 }, fullEvery: 0 }), (e) => e?.name === 'V3ContractViolation')
})
