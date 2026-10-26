/**
 * 占位回执失败时的槽位指针守卫（H-43，2026-10-26 缺陷排查批）。
 *
 * ## 缺陷
 * 全量步的计划是「增量槽 → 占位 replace」「全量槽 → 新卡 replace」。若占位 op 失败
 * （宿主拒绝 replace，降级 append 也失败），`nextSurfaceState(plan.kind='full')` 仍返回
 * `deltaSlotSeq = null`——**但那张旧增量卡还在活动面上**（占位没落地，它没被折掉）。
 * 指针一清，就没有任何后续计划能再 replace 它：
 * - 下一步增量步看到 `deltaSlotSeq === null` → 走 append（而不是 replace 旧卡）；
 * - 活动面从此是 3 张卡，且每失败一次多泄漏一张，直接违反
 *   「稳态活动面恒为 [全量基准卡][最新增量卡] 两个卡节点」。
 *
 * ## 判据
 * - 占位没落面 → 保留旧的 `deltaSlotSeq`（失败留在可重试的位置，下一步全量步再试折叠）；
 * - 占位落面 → 照旧清空（正常语义不变）；
 * - 卡片没落面 → 仍然抛错、不推进槽位（H-17 语义不变）。
 *
 * ## 不适用条件
 * 只保证「指针不丢」；宿主永久拒绝 replace 该节点时，每次全量步都会记一次失败
 * （fail-visible，`v3.surface.cardReplaceFallbacks` 与 outcome.failures 都能看到），
 * 这是有意的：宁可一直报错，也不静默丢卡。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { createSurfaceExecutor } from '../src/v3/application/surface-executor.mjs'
import { planSlots } from '../src/v3/domain/context/slot-planner.mjs'

const clock = { now: () => 1 }

function hostOf(fn) {
  return {
    async surfaceOp(op) { return fn(op) },
    eventAt() { return undefined },
    events() { return [] },
    sessionInfo() { return { id: 'k' } },
    tools() { return [] },
    commands() { return [] },
    settings() { return {} },
    surface: { nodes: [] },
  }
}

test('H-43 占位 replace + 降级 append 都失败 → 保留 deltaSlotSeq（旧：清成 null，旧卡永久泄漏）', async () => {
  let seq = 100
  const executor = createSurfaceExecutor({
    host: hostOf((op) => {
      if (op.op === 'replace' && op.targetEventId === 7) throw new Error('宿主拒绝 replace 该节点')
      if (op.op === 'append' && op.text.includes('卡占位')) throw new Error('宿主拒绝 append 占位')
      seq += 1
      return { seq }
    }),
    clock,
  })
  const surfaceState = { fullSlotSeq: 18, deltaSlotSeq: 7 }
  const plan = planSlots({ step: 20, surfaceState })
  const result = await executor.executePlan({ plan, surfaceState, cardText: '全量卡', decisionId: 'd', sessionKey: 's', placeholderCount: 1 })

  assert.equal(result.outcome.status, 'partial')
  assert.equal(result.outcome.failures.length, 1)
  assert.equal(result.surfaceState.deltaSlotSeq, 7, '占位没落面时增量槽指针必须保留（否则旧卡永久泄漏）')
  assert.ok(Number.isInteger(result.surfaceState.fullSlotSeq))

  // 下一步增量步必须 replace 旧卡（而不是 append 新卡）
  const nextPlan = planSlots({ step: 21, surfaceState: result.surfaceState })
  assert.equal(nextPlan.ops.length, 1)
  assert.equal(nextPlan.ops[0].op, 'replace')
  assert.equal(nextPlan.ops[0].targetEventId, 7, '下一步必须折叠那张旧增量卡')
})

test('H-43 占位落面 → deltaSlotSeq 照旧清空（正常语义不变）', async () => {
  let seq = 100
  const executor = createSurfaceExecutor({
    host: hostOf(() => { seq += 1; return { seq } }),
    clock,
  })
  const surfaceState = { fullSlotSeq: 18, deltaSlotSeq: 7 }
  const plan = planSlots({ step: 20, surfaceState })
  const result = await executor.executePlan({ plan, surfaceState, cardText: '全量卡', decisionId: 'd', sessionKey: 's', placeholderCount: 1 })
  assert.equal(result.outcome.status, 'applied')
  assert.equal(result.surfaceState.deltaSlotSeq, null, '占位已落面 → 增量槽确实空了')
  // 执行顺序是「先落卡、后落占位」（H-17）：卡片拿到 101，占位拿到 102，
  // 全量槽指向的是**卡片**的 seq（101），不是占位那一行。
  assert.equal(result.surfaceState.fullSlotSeq, 101)
})

test('H-43 卡片没落面 → 仍抛错不推进槽位，且占位不执行（H-17 语义不变）', async () => {
  const executor = createSurfaceExecutor({
    host: hostOf(() => { throw new Error('宿主全拒') }),
    clock,
  })
  const surfaceState = { fullSlotSeq: 18, deltaSlotSeq: 7 }
  const plan = planSlots({ step: 20, surfaceState })
  await assert.rejects(
    () => executor.executePlan({ plan, surfaceState, cardText: '全量卡', decisionId: 'd', sessionKey: 's', placeholderCount: 1 }),
    (error) => /新卡未落面/.test(error.message),
  )
})

test('H-43 增量步无占位：失败语义不受影响', async () => {
  let seq = 200
  const executor = createSurfaceExecutor({
    host: hostOf(() => { seq += 1; return { seq } }),
    clock,
  })
  const surfaceState = { fullSlotSeq: 18, deltaSlotSeq: 7 }
  const plan = planSlots({ step: 21, surfaceState })
  const result = await executor.executePlan({ plan, surfaceState, cardText: '增量卡', decisionId: 'd', sessionKey: 's' })
  assert.equal(result.outcome.status, 'applied')
  assert.deepEqual(result.surfaceState, { fullSlotSeq: 18, deltaSlotSeq: 201 })
})
