/**
 * 压力闸门域函数测试（2026-10-25 用户拍板移植 ③）。
 *
 * ## 判据来源
 * v2 G1-G4：低占用不开 / 达阈开 / 滞回不抖 / 不可判定失败关闭；
 * 退出阈值动态死区 enter − max(5%, 3σ₃₀)。
 *
 * ## 断言组
 * - G1：0.13 < 0.20 → 不开（v2 真实事故：246 步占用 8.3-13.5% 仍被反复替换）；
 * - G2：≥ 进入阈值 → 开；0 边界：0 阈值下任何占用都开（0=无压力也降温的 v2 语义保留）；
 * - G3：开闸后 0.17（exit 0.15 与 enter 0.20 之间）→ 保持开（hysteresis-hold）；
 *   掉到 0.14 → 关；关后回到 0.17 → 仍关（未达 enter）；
 * - G4：null/NaN/-0.1/1.2 → 失败关闭（unknown-occupancy），不猜；
 * - 动态死区：样本波动大 → 3σ > 5% 时退出阈更低；样本不足回落 5%；
 * - 编程错误（enter 不可判定 / exit > enter）抛 V3ContractViolation，不是闸门结果。
 *
 * ## 不适用条件与已知边界
 * 闸门只判状态；触发后的动作（退热/恢复）属策略面（①②④缓议项）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { computeExitThreshold, evaluatePressureGate, occupancyKnown } from '../src/v3/domain/session/pressure-gate.mjs'

test('G1/G2：低占用不开、达阈开、0 阈值语义保留', () => {
  assert.deepEqual(evaluatePressureGate({ occupancy: 0.13, enterThreshold: 0.2 }), { open: false, reason: 'below-enter' })
  assert.equal(evaluatePressureGate({ occupancy: 0.2, enterThreshold: 0.2 }).open, true)
  assert.equal(evaluatePressureGate({ occupancy: 0.13, enterThreshold: 0 }).open, true, '0 阈值=无压力也开（v2 语义）')
})

test('G3：滞回不抖动——开闸后掉到 exit 前保持开', () => {
  const held = evaluatePressureGate({ occupancy: 0.17, enterThreshold: 0.2, exitThreshold: 0.15, currentlyOpen: true })
  assert.deepEqual(held, { open: true, reason: 'hysteresis-hold' })
  const closed = evaluatePressureGate({ occupancy: 0.14, enterThreshold: 0.2, exitThreshold: 0.15, currentlyOpen: true })
  assert.deepEqual(closed, { open: false, reason: 'below-exit' })
  const stillClosed = evaluatePressureGate({ occupancy: 0.17, enterThreshold: 0.2, exitThreshold: 0.15, currentlyOpen: false })
  assert.equal(stillClosed.open, false, '关闸后未达 enter 不重开')
})

test('G4：占用不可判定失败关闭', () => {
  for (const bad of [null, NaN, -0.1, 1.2, undefined]) {
    assert.deepEqual(evaluatePressureGate({ occupancy: bad, enterThreshold: 0.2 }), { open: false, reason: 'unknown-occupancy' })
  }
  assert.equal(occupancyKnown(0), true)
  assert.equal(occupancyKnown(1), true)
})

test('动态死区：enter − max(5%, 3σ)；样本不足回落 5%', () => {
  const near = (a, b) => Math.abs(a - b) < 1e-9
  assert.ok(near(computeExitThreshold(0.2, []), 0.15))
  assert.ok(near(computeExitThreshold(0.2, [0.1]), 0.15), '单样本 σ 不可估')
  const volatile = Array.from({ length: 30 }, (_, i) => (i % 2 ? 0.5 : 0.0))
  const exit = computeExitThreshold(0.2, volatile)
  assert.ok(exit < 0.15, '高波动 3σ≈0.75 > 5% → 死区更宽（exit 更低）：' + exit)
  const calm = Array.from({ length: 30 }, () => 0.199)
  assert.ok(near(computeExitThreshold(0.2, calm), 0.15), '低波动回落 minDrop=5%')
})

test('编程错误：非法阈值抛 V3ContractViolation', () => {
  // 契约违规是编程错误（V3ContractViolation），与业务错误（isV3Error）分流——按 name 断言
  assert.throws(() => evaluatePressureGate({ occupancy: 0.5, enterThreshold: NaN }), (e) => e.name === 'V3ContractViolation')
  assert.throws(() => evaluatePressureGate({ occupancy: 0.5, enterThreshold: 0.3, exitThreshold: 0.35 }), (e) => e.name === 'V3ContractViolation')
})
