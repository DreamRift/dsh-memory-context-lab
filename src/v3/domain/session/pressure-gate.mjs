import { V3ContractViolation } from '../../contracts/errors.mjs'

/**
 * 会话级压力闸门（domain/session，2026-10-25 用户拍板移植）——v2 G1-G4 判据的 v3 重证。
 *
 * 判据来源（v2-pressure-gate 实测教训：246 步占用 8.3%-13.5% 仍每 2.7 步替换前缀）：
 * - G1 占用低于进入阈值 → 不开闸（低占用不是压力）；
 * - G2 占用达到进入阈值 → 开闸；
 * - G3 滞回：开闸后要掉到退出阈值以下才关闸，不在进入线附近抖动；
 * - G4 占用不可判定（null/NaN/负数/超 1）→ 失败关闭（不猜）。
 * 退出阈值默认 = 进入 − max(5%, 近 30 样本 3σ)（动态死区）；所有参数经入参注入。
 */

/** 退出阈值（动态死区）：enter − max(minDrop, 3σ)，σ 由近期占用样本估计；样本不足回落 minDrop。 */
export function computeExitThreshold(enterThreshold, samples, { minDrop = 0.05 } = {}) {
  if (!Number.isFinite(enterThreshold) || enterThreshold < 0 || enterThreshold > 1) {
    throw new V3ContractViolation('v3 pressure-gate: enterThreshold 必须在 [0,1]')
  }
  if (!Array.isArray(samples)) {
    throw new V3ContractViolation('v3 pressure-gate: samples 必须是数组（可为空）')
  }
  if (!(minDrop > 0) || minDrop >= 1) {
    throw new V3ContractViolation('v3 pressure-gate: minDrop 必须在 (0,1)')
  }
  if (samples.length === 0) return Math.max(0, enterThreshold - minDrop)
  const nums = samples.filter((x) => Number.isFinite(x) && x >= 0 && x <= 1)
  if (nums.length < 2) return Math.max(0, enterThreshold - minDrop)
  const mean = nums.reduce((s, x) => s + x, 0) / nums.length
  const variance = nums.reduce((s, x) => s + (x - mean) ** 2, 0) / nums.length
  const sigma = Math.sqrt(variance)
  return Math.max(0, enterThreshold - Math.max(minDrop, 3 * sigma))
}

/** 占用是否可判定（G4 的判据：只有 [0,1] 内的有限数才可信）。 */
export function occupancyKnown(occupancy) {
  return Number.isFinite(occupancy) && occupancy >= 0 && occupancy <= 1
}

/**
 * 评估闸门状态（纯函数）。
 * @param {object} input { occupancy, enterThreshold, exitThreshold?, currentlyOpen }
 * @returns {{ open: boolean, reason: 'below-enter'|'at-or-above-enter'|'hysteresis-hold'|'below-exit'|'unknown-occupancy' }}
 */
export function evaluatePressureGate({ occupancy, enterThreshold, exitThreshold, currentlyOpen = false }) {
  if (!occupancyKnown(occupancy)) return { open: false, reason: 'unknown-occupancy' }
  if (!occupancyKnown(enterThreshold)) {
    throw new V3ContractViolation('v3 pressure-gate: enterThreshold 不可判定（编程错误，不是闸门结果）')
  }
  const exit = exitThreshold === undefined ? computeExitThreshold(enterThreshold, []) : exitThreshold
  if (!occupancyKnown(exit) || exit > enterThreshold) {
    throw new V3ContractViolation('v3 pressure-gate: exitThreshold 非法（须 ≤ enterThreshold 且在 [0,1]）')
  }
  if (occupancy >= enterThreshold) return { open: true, reason: 'at-or-above-enter' }
  if (currentlyOpen) {
    if (occupancy >= exit) return { open: true, reason: 'hysteresis-hold' }
    return { open: false, reason: 'below-exit' }
  }
  return { open: false, reason: 'below-enter' }
}
