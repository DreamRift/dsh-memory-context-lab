/**
 * v3 投影执行器的端口边界校验守卫（H-24，2026-10-26 缺陷排查批）。
 *
 * ## 缺陷
 * executePlan 直接按调用方递进来的 `plan.ops` 发 op，**不校验计划形状**。实测：
 * targetEventId = 0 / 1.5 / "18" / -1 全部原样发给宿主（`[0]` / `[1.5]` / `["18"]` / `[-1]`）。
 * 其中 0 是宿主 surface 节点 0（系统提示，dsh types_surface.js assertSystemHeadRewrite）。
 *
 * 更隐蔽的一半：真实宿主适配器会拒绝这类 target（抛 V3ContractViolation），而执行器把它
 * 当成「replace 被拒」走**降级 append** —— 一个编程错误被静默降级成「多追加一张卡」，
 * 槽位还照常推进，失败彻底不可见。
 *
 * domain 层（H-23）已经堵住 planSlots 产出的非法槽位；本判据是**纵深第二道**：
 * 执行层是端口边界，不能信任调用方递进来的 plan。
 *
 * ## 判据
 * - 计划形状非法（ops 非数组/空、op 不是 replace|append、role 不在封闭集、
 *   replace 的 targetEventId 不是 ≥1 整数）→ 在**发出任何宿主操作之前**失败关闭；
 * - 非法计划不进 fallback（不得被降级 append 掩盖）；
 * - 合法计划的执行语义不变（R4 降级、槽位推进、outcome 结算）。
 *
 * ## 不适用条件与已知边界
 * 只校验计划形状；targetEventId 是否**仍然存在**于活动面由宿主确认（replace 后
 * eventAt/surface.nodes 的核对在 dsh-host 适配器里），执行层不持有活动面。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { createSurfaceExecutor } from '../src/v3/application/surface-executor.mjs'
import { planSlots } from '../src/v3/domain/context/slot-planner.mjs'

function recordingHost({ refuse } = {}) {
  const ops = []
  return {
    ops,
    async events() { return [] },
    async sessionInfo() { return { sessionKey: 's1' } },
    async tools() { return [] },
    async commands() { return [] },
    async settings() { return {} },
    async surfaceOp(op) {
      ops.push(op)
      if (typeof refuse === 'function' && refuse(op)) {
        const error = new Error('宿主拒绝')
        error.code = 'EINTERNAL'
        throw error
      }
      return { seq: 500 + ops.length }
    },
  }
}

const clock = { now: () => 1792850000000 }

test('H-24 replace 的 targetEventId 非法 → 发宿主之前失败关闭（旧：0/1.5/"18"/-1 全部发出去）', async () => {
  for (const target of [0, 1.5, '18', -1, null, undefined]) {
    const host = recordingHost()
    const executor = createSurfaceExecutor({ host, clock })
    const plan = { kind: 'delta', ops: [{ op: 'replace', targetEventId: target, role: 'delta-slot' }], fallbackAllowed: true }
    await assert.rejects(
      () => executor.executePlan({ plan, surfaceState: { fullSlotSeq: 5, deltaSlotSeq: 18 }, cardText: '卡', decisionId: 'd', sessionKey: 's' }),
      (error) => error?.name === 'V3ContractViolation' && /targetEventId/.test(error.message),
      '非法 target 必须拒绝：' + JSON.stringify(target),
    )
    assert.deepEqual(host.ops, [], '非法计划不得向宿主发出任何操作（含降级 append）')
  }
})

test('H-24 非法计划不得被 R4 降级 append 掩盖', async () => {
  // 宿主一律拒绝 replace（模拟真实适配器拒绝 target=0 的形态）
  const host = recordingHost({ refuse: (op) => op.op === 'replace' })
  const executor = createSurfaceExecutor({ host, clock })
  const plan = { kind: 'delta', ops: [{ op: 'replace', targetEventId: 0, role: 'delta-slot' }], fallbackAllowed: true }
  await assert.rejects(
    () => executor.executePlan({ plan, surfaceState: { fullSlotSeq: 5, deltaSlotSeq: 18 }, cardText: '卡', decisionId: 'd', sessionKey: 's' }),
    /targetEventId/,
  )
  assert.equal(host.ops.filter((op) => op.op === 'append').length, 0, '不得降级成 append（那会把编程错误变成「多一张卡」）')
})

test('H-24 计划形状非法（ops 非数组/空、op 非法、role 非法）→ 失败关闭', async () => {
  const bad = [
    { kind: 'delta', ops: null },
    { kind: 'delta', ops: [] },
    { kind: 'delta', ops: [null] },
    { kind: 'delta', ops: [{ op: 'delete', targetEventId: 3, role: 'delta-slot' }] },
    { kind: 'delta', ops: [{ op: 'append', role: 'mystery' }] },
  ]
  for (const plan of bad) {
    const host = recordingHost()
    const executor = createSurfaceExecutor({ host, clock })
    await assert.rejects(
      () => executor.executePlan({ plan, surfaceState: { fullSlotSeq: 5, deltaSlotSeq: 18 }, cardText: '卡', decisionId: 'd', sessionKey: 's' }),
      (error) => error?.name === 'V3ContractViolation',
      '非法计划必须拒绝：' + JSON.stringify(plan),
    )
    assert.deepEqual(host.ops, [])
  }
})

test('H-24 合法计划语义不回归：增量 replace / R4 降级 / 全量双槽', async () => {
  {
    const host = recordingHost()
    const executor = createSurfaceExecutor({ host, clock })
    const state = { fullSlotSeq: 5, deltaSlotSeq: 18 }
    const result = await executor.executePlan({ plan: planSlots({ step: 21, surfaceState: state }), surfaceState: state, cardText: '增量卡', decisionId: 'd1', sessionKey: 's' })
    assert.equal(result.outcome.status, 'applied')
    assert.deepEqual(result.surfaceState, { fullSlotSeq: 5, deltaSlotSeq: 501 })
  }
  {
    const host = recordingHost({ refuse: (op) => op.op === 'replace' })
    const executor = createSurfaceExecutor({ host, clock })
    const state = { fullSlotSeq: 5, deltaSlotSeq: 18 }
    const result = await executor.executePlan({ plan: planSlots({ step: 21, surfaceState: state }), surfaceState: state, cardText: '增量卡', decisionId: 'd2', sessionKey: 's' })
    assert.equal(result.fallbacks.length, 1, 'R4 降级 append 仍然生效')
    assert.equal(result.outcome.status, 'applied')
  }
  {
    const host = recordingHost()
    const executor = createSurfaceExecutor({ host, clock })
    const state = { fullSlotSeq: 5, deltaSlotSeq: 18 }
    const result = await executor.executePlan({ plan: planSlots({ step: 20, surfaceState: state }), surfaceState: state, cardText: '全量卡', decisionId: 'd3', sessionKey: 's', placeholderCount: 2 })
    assert.equal(result.outcome.status, 'applied')
    assert.equal(result.surfaceState.deltaSlotSeq, null)
  }
})
