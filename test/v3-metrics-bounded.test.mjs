/**
 * v3 计量槽有界性守卫（H-14，2026-10-26 缺陷排查批）。
 *
 * ## 缺陷
 * composition 的 createMetrics 把每条 observe 都 push 进数组且永不裁剪。
 * processTurn 对**每个事件**都 observe('v3.processTurn.turn', turn)，于是常驻内存随会话
 * 历史线性增长（实测 3000 事件 → 3000 个对象；5 万事件的长会话即 5 万个对象永不释放）。
 * snapshot() 每次还整表复制，输出面也随历史变长。
 *
 * ## 判据
 * - observe 条数有上界（窗口 64），不随事件数增长；
 * - 「实际发生过多少次」必须仍可读（observedTotal），不得因有界而丢失事实；
 * - 按名字聚合的 count/last/min/max 正确（回合号这类单调量的 last/max 有意义）；
 * - 外部 sink 仍然收到每一次 observe（有界只作用于内存快照）。
 *
 * ## 不适用条件与已知边界
 * 只覆盖 v3 composition 的计量槽；v2 的计量不在本判据。
 * 环形窗口只保留最近 64 条明细，历史明细按设计丢弃（聚合量保留）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { createV3Runtime } from '../src/v3/composition/composition.mjs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

function sessionOf(id) {
  const events = []
  return {
    id,
    log: events,
    surface: { nodes: [] },
    append() { return { seq: events.length } },
    eventAt() { return undefined },
    deriveMessages() { return [] },
  }
}

async function withRuntime(body) {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-v3-metrics-'))
  try {
    return await body(root)
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
}

test('H-14 observe 有界：300 事件后明细不超过窗口（旧：300 条全留）', async () => {
  await withRuntime(async (root) => {
    const session = sessionOf('s-metrics')
    const runtime = await createV3Runtime({ v3Root: root, dshSession: session, sessionKey: 's-metrics' })
    try {
      for (let i = 0; i < 300; i += 1) {
        const event = { seq: i, type: 'user/message', at: i, data: { content: [{ type: 'text', text: '正文' + i }] } }
        session.log.push(event)
        await runtime.handleDshEvent(event, '正文' + i)
      }
      const snapshot = runtime.metrics()
      assert.ok(snapshot.observes.length <= 64, '明细必须有界（实测 ' + snapshot.observes.length + '）')
      assert.equal(snapshot.observedTotal, 300, '实际观测次数必须如实保留')
      assert.equal(snapshot.observeWindow, 64)
    } finally {
      runtime.close()
    }
  })
})

test('H-14 按名字聚合正确：count/last/min/max', async () => {
  await withRuntime(async (root) => {
    const session = sessionOf('s-metrics-2')
    const runtime = await createV3Runtime({ v3Root: root, dshSession: session, sessionKey: 's-metrics-2' })
    try {
      for (let i = 0; i < 5; i += 1) {
        const event = { seq: i, type: 'user/message', at: i, data: { content: [{ type: 'text', text: '正文' + i }] } }
        session.log.push(event)
        await runtime.handleDshEvent(event, '正文' + i)
      }
      // 回合号由 nextTurnState 推进，首个真实用户事件即回合 1（不是 0）
      const turn = runtime.metrics().observesByName['v3.processTurn.turn']
      assert.equal(turn.count, 5)
      assert.equal(turn.min, 1)
      assert.equal(turn.max, 5)
      assert.equal(turn.last, 5)
    } finally {
      runtime.close()
    }
  })
})

test('H-14 外部 sink 仍收到每一次 observe（有界只作用于内存快照）', async () => {
  await withRuntime(async (root) => {
    const seen = []
    const session = sessionOf('s-metrics-3')
    const runtime = await createV3Runtime({
      v3Root: root,
      dshSession: session,
      sessionKey: 's-metrics-3',
      metricsSink: { counter() {}, observe(name, value) { seen.push({ name, value }) } },
    })
    try {
      for (let i = 0; i < 200; i += 1) {
        const event = { seq: i, type: 'user/message', at: i, data: { content: [{ type: 'text', text: '正文' + i }] } }
        session.log.push(event)
        await runtime.handleDshEvent(event, '正文' + i)
      }
      assert.equal(seen.length, 200, 'sink 不得因内存有界而丢事件')
    } finally {
      runtime.close()
    }
  })
})
