/**
 * v3 槽位规划器的 seq 合法域守卫（H-23，2026-10-26 缺陷排查批）。
 *
 * ## 缺陷
 * planSlots 只校验 surfaceState「含 fullSlotSeq/deltaSlotSeq」两个键，不校验**值**。
 * 于是 `deltaSlotSeq: 0` 会生成 `replace targetEventId: 0`——而宿主把 surface 节点 0
 * 当作**系统提示**（dsh `types_surface.js` 的 assertSystemHeadRewrite：node 0 持有系统
 * 提示，只能被 system/message 覆盖）。在 seq 0 不是 system/message 的会话里，这条
 * replace 会真的把系统提示折掉；`1.5` / `"18"` 这类值则一路漂到宿主才被拒，
 * 错误现场离根因很远（实测四种非法值全部被 ACCEPT 并生成了计划）。
 *
 * ## 判据
 * - fullSlotSeq / deltaSlotSeq 只接受 null 或 ≥1 的整数；0 / 负数 / 小数 / 字符串
 *   一律在 domain 层失败关闭（V3ContractViolation）；
 * - 合法输入的计划与推进语义不变（幂等、fullEvery=1、truncated、首挂载 append）；
 * - nextSurfaceState 只接受 ≥1 的 newCardSeq（原有语义，回归）。
 *
 * ## 不适用条件与已知边界
 * 只校验**槽位 seq 的取值域**；seq 是否真的存在于活动面由执行层/宿主确认（executor 会
 * 用宿主回执核对）。domain 层不持有活动面，无法也不应判断「这个 seq 还在不在」。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { nextSurfaceState, planSlots } from '../src/v3/domain/context/slot-planner.mjs'

test('H-23 槽位 seq 非法值在 domain 层失败关闭（旧：全部 ACCEPT 并生成计划）', () => {
  const badStates = [
    { fullSlotSeq: 0, deltaSlotSeq: 18 },
    { fullSlotSeq: -3, deltaSlotSeq: 18 },
    { fullSlotSeq: 5, deltaSlotSeq: 1.5 },
    { fullSlotSeq: 5, deltaSlotSeq: '18' },
    { fullSlotSeq: 5, deltaSlotSeq: NaN },
    { fullSlotSeq: 5, deltaSlotSeq: Infinity },
  ]
  for (const state of badStates) {
    assert.throws(
      () => planSlots({ step: 21, surfaceState: state }),
      (error) => error?.name === 'V3ContractViolation' && /slot-planner/.test(error.message),
      '非法槽位必须拒绝：' + JSON.stringify(state),
    )
  }
})

test('H-23 seq 0 不得被当成「有槽」：首次挂载必须 append 而不是 replace 0', () => {
  // 旧实现里 fullSlotSeq: 0 走 replace 分支（0 !== null），会指向系统提示节点
  assert.throws(() => planSlots({ step: 1, surfaceState: { fullSlotSeq: 0, deltaSlotSeq: null } }), /slot-planner/)
  // 正确形态：null → append
  assert.deepEqual(planSlots({ step: 1, surfaceState: { fullSlotSeq: null, deltaSlotSeq: null } }).ops, [{ op: 'append', role: 'full-slot' }])
})

test('H-23 合法输入语义不回归：幂等 / fullEvery=1 / truncated / 稳态双槽', () => {
  const state = { fullSlotSeq: 5, deltaSlotSeq: 18 }
  const delta = planSlots({ step: 21, surfaceState: state })
  assert.deepEqual(delta, { kind: 'delta', ops: [{ op: 'replace', targetEventId: 18, role: 'delta-slot' }], fallbackAllowed: true })
  assert.deepEqual(planSlots({ step: 21, surfaceState: state }), delta, '同步重复规划必须幂等')
  assert.deepEqual(planSlots({ step: 7, surfaceState: state, fullEvery: 1 }).kind, 'full')
  assert.deepEqual(planSlots({ step: 3, surfaceState: state, truncated: true }).kind, 'full')
  const full = planSlots({ step: 20, surfaceState: state })
  assert.deepEqual(full.ops, [
    { op: 'replace', targetEventId: 18, role: 'placeholder' },
    { op: 'replace', targetEventId: 5, role: 'full-slot' },
  ])
})

test('H-23 nextSurfaceState 仍只接受 ≥1 的 newCardSeq', () => {
  const state = { fullSlotSeq: 5, deltaSlotSeq: 18 }
  assert.throws(() => nextSurfaceState(state, { kind: 'delta' }, 0), /newCardSeq/)
  assert.throws(() => nextSurfaceState(state, { kind: 'delta' }, 1.5), /newCardSeq/)
  assert.deepEqual(nextSurfaceState(state, { kind: 'delta' }, 42), { fullSlotSeq: 5, deltaSlotSeq: 42 })
  assert.deepEqual(nextSurfaceState(state, { kind: 'full' }, 42), { fullSlotSeq: 42, deltaSlotSeq: null })
})
