/**
 * v3 DSH 宿主适配器测试（M5 第一批）——假 DSH session 按 apply-commit.mjs 核验过的
 * 真实契约实现（append/eventAt/surface.nodes/deriveMessages），surfaceOp 形状逐字对齐。
 *
 * ## 判据来源
 * 2026-10-24 对 plugin/src/apply-commit.mjs 与 v2/history.mjs 的宿主契约核验；
 * P1（谁注入谁回收：source.kind=插件自有）；v1-residue（memory-lab3 新号）。
 *
 * ## 断言组
 * - append：source.kind 自有、form=memory-lab3-surface、返回 seq；
 * - replace：surfaceOp{op,startSeq,endSeq}+sourceEventSeqs 逐字对齐；确认面失败关闭
 *   （未进面/目标仍出面都拒绝）；
 * - 归一化：四类 DSH 事件映射 v3 封闭集；system/head 拒绝；缺 seq 拒绝；
 * - 与 surface-executor 组合：真实形状下 R4 全链路成立。
 *
 * ## 不适用条件与已知边界
 * 真 DSH runtime 的并发/重放语义在 M6 真机验证；events() 全量拉取的分页面 M6 核验。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { createDshHostAdapter, normalizeDshEvent, V3_PLUGIN_SOURCE_KIND, V3_SURFACE_FORM } from '../src/v3/adapters/host/dsh-host.mjs'
import { createSurfaceExecutor } from '../src/v3/application/surface-executor.mjs'
import { planSlots } from '../src/v3/domain/context/slot-planner.mjs'

/** 假 DSH session：按真实契约（append 签名/确认面）。 */
function fakeDshSession({ replaceBroken = false } = {}) {
  let seq = 100
  // replaceBroken 挂到实例上：测试中途可切换（闭包变量改不到）
  const events = new Map()
  const surfaceNodes = new Set()
  const appended = []
  const session = {
    appended,
    replaceBroken,
    surface: { nodes: [...surfaceNodes] },
    append(type, data, options) {
      if (session.replaceBroken && options?.surfaceOp?.op === 'replace') {
        throw new Error('DSH: replace 目标不可用')
      }
      seq += 1
      events.set(seq, { seq, type, data, options })
      const shadows = options?.surfaceOp?.op === 'replace'
        ? rangeOf(options.surfaceOp)
        : []
      for (const s of shadows) surfaceNodes.delete(s)
      surfaceNodes.add(seq)
      session.surface.nodes = [...surfaceNodes]
      appended.push({ seq, type, data, options })
      return { seq }
    },
    eventAt(s) { return events.get(s) },
    deriveMessages() { return [] },
    events: [],
  }
  // 预置两个面上节点（5=全量槽 18=增量槽）
  for (const s of [5, 18]) { events.set(s, { seq: s, type: 'user/message', data: {} }); surfaceNodes.add(s) }
  session.surface.nodes = [...surfaceNodes]
  return session
}

function rangeOf({ startSeq, endSeq }) {
  const out = []
  for (let s = startSeq; s <= endSeq; s += 1) out.push(s)
  return out
}

function fakeClock(start = 1792845000000) {
  let t = start
  return { now: () => t++ }
}

function fakeMetrics() {
  const counters = new Map()
  return { counters, counter(n, v) { counters.set(n, (counters.get(n) ?? 0) + v) }, observe() {} }
}

test('append：source.kind 自有 + form 新号 + seq 返回', async () => {
  const session = fakeDshSession()
  const host = createDshHostAdapter({ session, sessionKey: 'sess-a' })
  const { seq } = await host.surfaceOp({ op: 'append', text: '卡片正文' })
  assert.ok(Number.isInteger(seq) && seq >= 1)
  const last = session.appended.at(-1)
  assert.equal(last.type, 'user/message')
  assert.equal(last.data.source.kind, V3_PLUGIN_SOURCE_KIND, 'P1 谁注入谁回收')
  assert.equal(last.data.source.form, V3_SURFACE_FORM)
  assert.equal(last.data.content[0].text, '卡片正文')
})

test('replace：surfaceOp/sourceEventSeqs 逐字对齐；确认面失败关闭', async () => {
  const session = fakeDshSession()
  const host = createDshHostAdapter({ session, sessionKey: 'sess-a' })
  const { seq } = await host.surfaceOp({ op: 'replace', targetEventId: 18, text: '新卡' })
  assert.ok(seq >= 1)
  const last = session.appended.at(-1)
  assert.deepEqual(last.options.surfaceOp, { op: 'replace', startSeq: 18, endSeq: 18 })
  assert.deepEqual(last.options.sourceEventSeqs, [18], '遮蔽区间可审计')
  assert.equal(session.surface.nodes.includes(18), false, '目标出面')
  assert.equal(session.surface.nodes.includes(seq), true, '新事件进面')
  // 确认面失败关闭：破坏 eventAt 后 replace 拒绝
  const broken = fakeDshSession()
  broken.eventAt = () => undefined
  const brokenHost = createDshHostAdapter({ session: broken, sessionKey: 'sess-a' })
  await assert.rejects(() => brokenHost.surfaceOp({ op: 'replace', targetEventId: 18, text: 'x' }), (e) => /未进入活动面/.test(e.message))
})

test('归一化：四类映射；system/head 拒绝；非法入参拒绝', () => {
  const good = normalizeDshEvent({ seq: 7, type: 'user/message', at: 1792845000000, data: { source: { kind: 'user', form: null } } }, 'sess-a')
  assert.equal(good.ok, true)
  assert.equal(good.event.type, 'user')
  assert.equal(good.event.id, 'dsh-7')
  const tool = normalizeDshEvent({ seq: 8, type: 'tool/result', data: {} }, 'sess-a')
  assert.equal(tool.ok, true)
  assert.equal(tool.event.type, 'tool-result')
  assert.equal(tool.event.source.kind, 'dsh', '缺 source.kind 归一为 dsh')
  const sys = normalizeDshEvent({ seq: 9, type: 'system/message', data: {} }, 'sess-a')
  assert.equal(sys.ok, false)
  const noSeq = normalizeDshEvent({ type: 'user/message', data: {} }, 'sess-a')
  assert.equal(noSeq.ok, false)
  // 宿主真实形状用 `time` 而不是 `at`（dsh-session append：{type, seq, time, data}）。
  // 只读 `at` 会让每条归一化事件的 at 恒为 0——事件时间在入口就丢了。
  const realShape = normalizeDshEvent({ seq: 10, type: 'user/message', time: 1792845000123, data: { source: { kind: 'user' } } }, 'sess-a')
  assert.equal(realShape.ok, true)
  assert.equal(realShape.event.at, 1792845000123, '真实宿主形状（time）必须被读取')
  const legacyAt = normalizeDshEvent({ seq: 11, type: 'user/message', at: 42, data: { source: { kind: 'user' } } }, 'sess-a')
  assert.equal(legacyAt.event.at, 42, 'at 保留为兼容旧夹具/旧格式')
  const noTime = normalizeDshEvent({ seq: 12, type: 'user/message', data: { source: { kind: 'user' } } }, 'sess-a')
  assert.equal(noTime.ok, true)
  assert.equal(noTime.event.at, undefined, 'B3-1：时间缺失如实缺失，不回落 0 伪造')
  assert.equal(noTime.atReason, 'missing')
  const badTime = normalizeDshEvent({ seq: 13, type: 'user/message', time: 'not-a-number', data: { source: { kind: 'user' } } }, 'sess-a')
  assert.equal(badTime.ok, true)
  assert.equal(badTime.event.at, undefined, 'B3-1：非法时间丢弃，不伪造')
  assert.equal(badTime.atReason, 'invalid')
})

test('组合：真实形状下 surface-executor R4 全链路成立', async () => {
  const session = fakeDshSession({ replaceBroken: true })
  const host = createDshHostAdapter({ session, sessionKey: 'sess-a' })
  const metrics = fakeMetrics()
  const executor = createSurfaceExecutor({ host, clock: fakeClock(), metrics })
  const state = { fullSlotSeq: 5, deltaSlotSeq: 18 }
  const plan = planSlots({ step: 7, surfaceState: state })
  const result = await executor.executePlan({ plan, surfaceState: state, cardText: '增量卡', decisionId: 'dec-1', sessionKey: 'sess-a' })
  assert.equal(result.outcome.status, 'applied')
  assert.equal(metrics.counters.get('v3.surface.cardReplaceFallbacks'), 1, 'R4 降级')
  assert.equal(session.surface.nodes.includes(result.surfaceState.deltaSlotSeq), true, 'fallback 卡在面上')
  // 一步恢复：下一步 replace 落在 fallback 卡上且这次能成功
  session.replaceBroken = false // 现在真的生效（属性读取）
  const nextPlan = planSlots({ step: 8, surfaceState: result.surfaceState })
  const next = await executor.executePlan({ plan: nextPlan, surfaceState: result.surfaceState, cardText: '新增量卡', decisionId: 'dec-2', sessionKey: 'sess-a' })
  assert.equal(next.fallbacks.length, 0)
  assert.equal(session.surface.nodes.includes(result.surfaceState.deltaSlotSeq), false, '多余槽位一步回收')
})
