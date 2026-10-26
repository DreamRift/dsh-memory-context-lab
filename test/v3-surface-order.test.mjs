/**
 * v3 投影执行顺序守卫（H-17，2026-10-26 缺陷排查批）。
 *
 * ## 缺陷
 * planSlots 的 full 计划里占位 op 排在卡片 op 之前（人读顺序「旧增量 → 全量」）。
 * executePlan 原样按序执行：占位 replace 先把增量槽覆盖成占位行，随后卡片 replace 与
 * 降级 append 双双失败 → newCardSeq === null → 抛「新卡未落面」。此时调用方拿不到新的
 * surfaceState，仍持有「增量槽 = 原 seq」，而那个 seq 上现在躺着占位行——下一步增量步
 * 会 replace 掉占位行，**唯一的活动面指针就此丢失**（占位行替代的批次再也无法按面回读）。
 *
 * ## 判据
 * - 卡片未落面时，占位 op 一律不执行（增量槽不被覆盖），旧 surfaceState 仍然有效；
 * - 占位失败但卡片已落面 → outcome 如实记 partial（失败可见，不伪装成功）；
 * - 正常路径（卡片与占位都成功）行为不变：占位行内容、一行形态、槽位推进都对。
 *
 * ## 不适用条件与已知边界
 * 只调整**执行顺序**与「卡片未落面」的跳过规则；不改 planSlots 的计划内容与顺序语义
 * （计划仍是决策层的可读产物）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { createSurfaceExecutor, placeholderReceipt } from '../src/v3/application/surface-executor.mjs'
import { planSlots } from '../src/v3/domain/context/slot-planner.mjs'

function hostOf({ refuse } = {}) {
  const ops = []
  return {
    ops,
    async events() { return [] },
    async sessionInfo() { return { sessionKey: 'sess-a' } },
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
      return { seq: 100 + ops.length }
    },
  }
}

const clock = { now: () => 1792845000000 }

test('H-17 卡片未落面时占位不执行：增量槽不被覆盖，旧 state 仍有效（旧：18 被占位行吃掉）', async () => {
  // 全量槽 replace 与一切 append 都失败；占位 replace（target 18）本来会成功
  const host = hostOf({ refuse: (op) => !(op.op === 'replace' && op.targetEventId === 18) })
  const executor = createSurfaceExecutor({ host, clock })
  const state = { fullSlotSeq: 10, deltaSlotSeq: 18 }
  const plan = planSlots({ step: 20, surfaceState: state, fullEvery: 20 })

  await assert.rejects(
    () => executor.executePlan({ plan, surfaceState: state, cardText: '新全量卡', decisionId: 'd1', sessionKey: 's1', placeholderCount: 2 }),
    (error) => error?.name === 'V3ContractViolation' && /新卡未落面/.test(error.message),
  )
  const touchedDelta = host.ops.some((op) => op.op === 'replace' && op.targetEventId === 18)
  assert.equal(touchedDelta, false, '增量槽不得被占位行覆盖（否则旧 state 失真）')
  // 旧 state 仍然有效：下一步增量步仍然指向真正的增量卡
  const nextPlan = planSlots({ step: 21, surfaceState: state, fullEvery: 20 })
  assert.deepEqual(nextPlan.ops, [{ op: 'replace', targetEventId: 18, role: 'delta-slot' }])
})

test('H-17 卡片已落面、占位 replace 与降级 append 都失败 → outcome 如实记 partial（不伪装成功）', async () => {
  // 占位的 replace 被拒后按 R4 会降级 append；这里把降级 append 也拒掉，才算真失败
  const host = hostOf({ refuse: (op) => (op.op === 'replace' && op.targetEventId === 18) || (op.op === 'append' && /占位/.test(op.text ?? '')) })
  const executor = createSurfaceExecutor({ host, clock })
  const state = { fullSlotSeq: 10, deltaSlotSeq: 18 }
  const plan = planSlots({ step: 20, surfaceState: state, fullEvery: 20 })
  const result = await executor.executePlan({ plan, surfaceState: state, cardText: '新全量卡', decisionId: 'd2', sessionKey: 's1', placeholderCount: 2 })
  assert.equal(result.outcome.status, 'partial')
  assert.equal(result.outcome.failures.length, 1)
  assert.equal(result.outcome.failures[0].effectIndex, 0, 'effectIndex 必须是计划里的真实下标')
  // 占位没落面 → 旧增量卡（seq 18）仍在活动面上，指针必须保留（H-43）：
  // 旧断言写的是 deltaSlotSeq: null，等于把这个泄漏固化成期望值。
  assert.deepEqual(result.surfaceState, { fullSlotSeq: result.appliedOps.find((op) => op.role === 'full-slot').seq, deltaSlotSeq: 18 })
})

test('H-17 正常路径不回归：占位一行、内容含张数、槽位推进正确', async () => {
  const host = hostOf()
  const executor = createSurfaceExecutor({ host, clock })
  const state = { fullSlotSeq: 10, deltaSlotSeq: 18 }
  const plan = planSlots({ step: 20, surfaceState: state, fullEvery: 20 })
  const result = await executor.executePlan({ plan, surfaceState: state, cardText: '新全量卡', decisionId: 'd3', sessionKey: 's1', placeholderCount: 3 })
  assert.equal(result.outcome.status, 'applied')
  assert.equal(result.outcome.appliedEffects, 2)
  const placeholderOp = host.ops.find((op) => op.targetEventId === 18)
  assert.match(placeholderOp.text, /占位/)
  assert.equal(placeholderOp.text.split('\n').length, 1, '占位回执一行')
  assert.match(placeholderOp.text, /此前 3 张卡/)
  assert.deepEqual(result.surfaceState.deltaSlotSeq, null, '全量刷新后增量槽清空')
  assert.equal(placeholderReceipt({ kind: '增量', count: 4 }).includes('此前 4 张卡'), true)
})
