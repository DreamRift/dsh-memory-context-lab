/**
 * v3 一次性闸门的规模守卫（H-18，2026-10-26 缺陷排查批）。
 *
 * ## 缺陷
 * oncePerTurnGate 每次返回「全部历史键 + 新键」的新 Set：
 * - 键数随回合数线性增长（2 万回合 = 2 万个键常驻）；
 * - 每次复制 O(历史键数)，累计 O(回合数²)——实测 2 万回合累计 2.0 秒，
 *   而 recall 每次注入都要过这道闸（长会话里逐步变慢）。
 *
 * ## 判据
 * - seen 键数有上界（GATE_WINDOW），不随回合数增长；
 * - 「同回合同类只一次、异回合放行」的语义不变；
 * - 返回新 Set（不可变使用）不变——调用方 `seen = gate.seen` 的写法继续成立；
 * - 大量回合后累计耗时是线性的（不出现平方增长）。
 *
 * ## 不适用条件与已知边界
 * 只覆盖 v3 domain 的一次性闸门；v2 的同名闸门不在本判据。
 * 窗口之外的旧回合键会被裁掉——回合号在会话内单调递增，旧回合不会重来，
 * 因此不影响「同回合只一次」；这条边界写在测试里，避免被误读成「可以重复注入」。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { GATE_WINDOW, oncePerTurnGate } from '../src/v3/domain/session/turn.mjs'

test('H-18 seen 有界：2 万回合后键数不超过窗口（旧：2 万个键）', () => {
  let seen = new Set()
  for (let turn = 1; turn <= 20000; turn += 1) {
    seen = oncePerTurnGate(seen, 'sess-a', turn, 'recall-injection').seen
  }
  assert.ok(seen.size <= GATE_WINDOW, 'seen 必须有界（实测 ' + seen.size + '）')
  assert.equal(seen.size, GATE_WINDOW)
})

test('H-18 语义不变：同回合同类只放行一次，异回合/异类目放行', () => {
  const first = oncePerTurnGate(new Set(), 's1', 7, 'recall-injection')
  assert.equal(first.emit, true)
  assert.equal(oncePerTurnGate(first.seen, 's1', 7, 'recall-injection').emit, false, '同回合同类必须被拒')
  assert.equal(oncePerTurnGate(first.seen, 's1', 8, 'recall-injection').emit, true, '异回合放行')
  assert.equal(oncePerTurnGate(first.seen, 's1', 7, 'turn-reminder').emit, true, '同类异类目放行')
  assert.equal(oncePerTurnGate(first.seen, 's2', 7, 'recall-injection').emit, true, '异会话放行')
})

test('H-18 不可变使用：返回新 Set，入参不被修改', () => {
  const seen = new Set()
  const gate = oncePerTurnGate(seen, 's1', 1, 'x')
  assert.equal(seen.size, 0, '入参不得被修改')
  assert.notEqual(gate.seen, seen, '必须返回新 Set')
  assert.equal(gate.seen.size, 1)
})

test('H-18 裁剪只影响旧回合：窗口内的本回合键仍然生效', () => {
  let seen = new Set()
  for (let turn = 1; turn <= GATE_WINDOW * 3; turn += 1) {
    seen = oncePerTurnGate(seen, 's1', turn, 'recall-injection').seen
  }
  const current = GATE_WINDOW * 3
  assert.equal(oncePerTurnGate(seen, 's1', current, 'recall-injection').emit, false, '本回合仍必须被拒')
  assert.equal(oncePerTurnGate(seen, 's1', current + 1, 'recall-injection').emit, true, '下一回合放行')
})

test('H-18 累计耗时不呈平方增长（2 万回合 < 1 秒）', () => {
  let seen = new Set()
  const started = process.hrtime.bigint()
  for (let turn = 1; turn <= 20000; turn += 1) {
    seen = oncePerTurnGate(seen, 'sess-a', turn, 'recall-injection').seen
  }
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6
  assert.ok(elapsedMs < 1000, '2 万回合累计耗时必须 < 1s（实测 ' + elapsedMs.toFixed(1) + 'ms；旧实现约 2000ms）')
})
