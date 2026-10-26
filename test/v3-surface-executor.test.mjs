/**
 * v3 投影执行器测试（M4 第三批）——假 HostSurface 端口（六方法齐全），
 * 可配置拒绝特定 targetEventId 的 replace（模拟宿主拒绝注入点，beta.8 探针同思路）。
 *
 * ## 判据来源
 * R4（card-replace 保留：宿主拒绝 replace → 降级 append + cardReplaceFallbacks +
 * 一步恢复）、R2（全量刷新：占位回执一行）、outcomes 诚实边界。
 *
 * ## 断言组
 * - 全量步：占位(replace) + 全量(replace) 都 applied；槽位推进；
 * - 增量步：replace delta 槽 applied；
 * - R4：拒绝 delta replace → append-fallback、计数 ≥1、fallback 后槽位 seq =
 *   append 的 seq（下一步 replace 落在它上面——一步恢复）；
 * - replace 与降级 append 都失败 → failures 如实、状态不推进（新卡未落面）；
 * - 宿主确认缺 seq → 装配/执行失败关闭。
 *
 * ## 不适用条件与已知边界
 * 真实宿主 surfaceOp 语义（append/replace 参数面）在 M5 对 dsh 源码核验后收紧。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { createSurfaceExecutor, placeholderReceipt } from '../src/v3/application/surface-executor.mjs'
import { planSlots } from '../src/v3/domain/context/slot-planner.mjs'

function fakeHost({ refuseReplaceOf = [], omitSeq = false } = {}) {
  let seq = 100
  const ops = []
  const host = {
    ops,
    refuseReplaceOf,
    async events() { return [] },
    async surfaceOp(op) {
      if (op.op === 'replace' && refuseReplaceOf.includes(op.targetEventId)) {
        const e = new Error('宿主拒绝 replace：目标事件不在可替换范围'); e.code = 'EHOST_REPLACE_REFUSED'; throw e
      }
      seq += 1
      ops.push({ ...op, seq })
      if (omitSeq) return {}
      return { seq }
    },
    async sessionInfo() { return { sessionKey: 'sess-a' } },
    async tools() { return [] },
    async commands() { return [] },
    async settings() { return {} },
  }
  return host
}

function fakeClock(start = 1792845000000) {
  let t = start
  return { now: () => t++ }
}

function fakeMetrics() {
  const counters = new Map()
  return { counters, counter(n, v) { counters.set(n, (counters.get(n) ?? 0) + v) }, observe() {} }
}

test('全量步：占位 + 全量 replace 都 applied；槽位推进', async () => {
  const host = fakeHost()
  const metrics = fakeMetrics()
  const executor = createSurfaceExecutor({ host, clock: fakeClock(), metrics })
  const plan = planSlots({ step: 20, surfaceState: { fullSlotSeq: 5, deltaSlotSeq: 18 } })
  const result = await executor.executePlan({
    plan, surfaceState: { fullSlotSeq: 5, deltaSlotSeq: 18 },
    cardText: '全量卡正文', decisionId: 'dec-1', sessionKey: 'sess-a', placeholderCount: 3,
  })
  assert.equal(result.outcome.status, 'applied')
  assert.equal(result.outcome.totalEffects, 2)
  // H-17：执行顺序改为「先落卡、后落占位」，所以卡片拿到 101（旧实现按计划顺序先落占位 → 102）。
  // 槽位只认卡片的 seq，与宿主分配顺序无关；这样卡片失败时面上零变化，旧 surfaceState 仍有效。
  assert.deepEqual(result.surfaceState, { fullSlotSeq: 101, deltaSlotSeq: null })
  assert.equal(result.fallbacks.length, 0)
  const placeholderOp = host.ops.find((o) => o.targetEventId === 18)
  assert.match(placeholderOp.text, /占位/)
  assert.equal(placeholderOp.text.split('\n').length, 1, '占位回执一行')
})

test('增量步：replace delta 槽 applied', async () => {
  const host = fakeHost()
  const executor = createSurfaceExecutor({ host, clock: fakeClock(), metrics: fakeMetrics() })
  const state = { fullSlotSeq: 30, deltaSlotSeq: 31 }
  const plan = planSlots({ step: 21, surfaceState: state })
  const result = await executor.executePlan({ plan, surfaceState: state, cardText: '增量卡', decisionId: 'dec-2', sessionKey: 'sess-a' })
  assert.equal(result.outcome.status, 'applied')
  assert.deepEqual(result.surfaceState, { fullSlotSeq: 30, deltaSlotSeq: 101 })
})

test('R4：拒绝 replace → 降级 append + 计数 + 一步恢复', async () => {
  const host = fakeHost({ refuseReplaceOf: [31] })
  const metrics = fakeMetrics()
  const executor = createSurfaceExecutor({ host, clock: fakeClock(), metrics })
  const state = { fullSlotSeq: 30, deltaSlotSeq: 31 }
  const plan = planSlots({ step: 21, surfaceState: state })
  const result = await executor.executePlan({ plan, surfaceState: state, cardText: '增量卡', decisionId: 'dec-3', sessionKey: 'sess-a' })
  assert.equal(result.outcome.status, 'applied')
  assert.equal(metrics.counters.get('v3.surface.cardReplaceFallbacks'), 1)
  assert.equal(result.fallbacks.length, 1)
  assert.deepEqual(result.surfaceState, { fullSlotSeq: 30, deltaSlotSeq: 101 }, 'fallback 的 append seq 记入槽位')
  // 一步恢复：下一步 replace 落在 fallback append 的 seq 上，不再累积
  const nextPlan = planSlots({ step: 22, surfaceState: result.surfaceState })
  assert.deepEqual(nextPlan.ops, [{ op: 'replace', targetEventId: 101, role: 'delta-slot' }])
})

test('replace 与降级 append 都失败 → failures 如实、不推进槽位', async () => {
  const host = fakeHost({ refuseReplaceOf: [31] })
  // 让 append 也失败：surfaceOp 对 append 抛错
  host.surfaceOp = async (op) => {
    if (op.op === 'replace') { const e = new Error('refused'); e.code = 'EHOST_REPLACE_REFUSED'; throw e }
    const e = new Error('宿主面不可写'); e.code = 'EHOST_UNAVAILABLE'; throw e
  }
  const executor = createSurfaceExecutor({ host, clock: fakeClock(), metrics: fakeMetrics() })
  const state = { fullSlotSeq: 30, deltaSlotSeq: 31 }
  const plan = planSlots({ step: 21, surfaceState: state })
  await assert.rejects(
    () => executor.executePlan({ plan, surfaceState: state, cardText: 'x', decisionId: 'dec-4', sessionKey: 'sess-a' }),
    (e) => e?.name === 'V3ContractViolation' && /新卡未落面/.test(e.message),
  )
})

test('宿主确认缺 seq → 失败关闭；非法入参拒绝', async () => {
  const badHost = fakeHost({ omitSeq: true })
  const executor = createSurfaceExecutor({ host: badHost, clock: fakeClock(), metrics: fakeMetrics() })
  const state = { fullSlotSeq: 30, deltaSlotSeq: 31 }
  const plan = planSlots({ step: 21, surfaceState: state })
  await assert.rejects(
    () => executor.executePlan({ plan, surfaceState: state, cardText: 'x', decisionId: 'd', sessionKey: 's' }),
    (e) => e?.name === 'V3ContractViolation' && /seq/.test(e.message),
  )
  await assert.rejects(
    () => executor.executePlan({ plan, surfaceState: state, cardText: '', decisionId: 'd', sessionKey: 's' }),
    (e) => e?.name === 'V3ContractViolation',
  )
  assert.match(placeholderReceipt({ kind: '增量', count: 4 }), /此前 4 张卡/)
})
