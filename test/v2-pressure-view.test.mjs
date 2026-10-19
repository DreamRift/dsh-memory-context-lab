/**
 * 0.13.1：投影 → 视图契约（排查报告 A2 的回归）。
 *
 * 缺陷：`viewOf()` 不输出 `pressureGate`，而面板用 `view.pressureGate` 推 `pressureOn`。
 * 于是开关永远画成「关」、阈值框永远 disabled、状态行永远「未启用」——
 * 但点击时命令确实发出并写入会话设置，用户感知为「点了没反应」。
 *
 * 为什么 0.13.0 的 83 套没挡住：`client.test.mjs` 手造了含 `pressureGate: 20` 的 view，
 * 只测「开关 → 命令」映射，从未测「投影 → 视图」这一段契约。
 * 本文件补的正是那一段：命令折叠进 state 之后，视图必须如实带上闸门。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { applyEvent, initProjectionState, viewOf } from '../src/projection.mjs'
import { DEFAULT_SETTINGS } from '../src/core.mjs'

function fold(state, name, args) {
  return applyEvent(state, { type: 'command/run', data: { name, args } })
}

test('压力闸门 P1：v2 会话 set pressure 30 后视图读到 30', () => {
  let state = initProjectionState()
  state = fold(state, 'memory-lab2', 'on')
  state = fold(state, 'memory-lab2', 'set pressure 30')
  assert.equal(state.pressureGate, 30, '状态里必须先有值')
  assert.equal(viewOf(state).pressureGate, 30, '视图必须把状态里的值带出去')
})

test('压力闸门 P2：v1 会话同样读得到（闸门是两代共用判据）', () => {
  let state = initProjectionState()
  state = fold(state, 'memory-lab', 'on')
  state = fold(state, 'memory-lab', 'set pressure 0')
  assert.equal(state.engine, 'v1')
  assert.equal(viewOf(state).pressureGate, 0, '0 是合法值（无压力也降温），不能被当成缺省')
})

test('压力闸门 P3：越界或非整数回落默认，不把脏值传给面板', () => {
  const base = initProjectionState()
  for (const bad of [96, -1, 2.5, '30', null, undefined]) {
    const view = viewOf({ ...base, pressureGate: bad })
    assert.equal(
      view.pressureGate,
      DEFAULT_SETTINGS.pressureGate,
      `pressureGate=${JSON.stringify(bad)} 必须回落 ${DEFAULT_SETTINGS.pressureGate}`,
    )
  }
  assert.equal(viewOf({ ...base, pressureGate: 0 }).pressureGate, 0, '0 不得回落')
  assert.equal(viewOf({ ...base, pressureGate: 95 }).pressureGate, 95, '上界 95 合法')
})

test('压力闸门 P4：视图恒定携带该键（缺键即显示死锁）', () => {
  const view = viewOf(initProjectionState())
  assert.ok(Object.hasOwn(view, 'pressureGate'), '没有这个键，面板 pressureOn 恒 false')
  assert.equal(view.pressureGate, DEFAULT_SETTINGS.pressureGate)
})