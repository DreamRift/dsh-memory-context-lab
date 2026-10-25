/**
 * 恢复资格与会计（domain/archive 纯函数，M1）。
 *
 * 编码进判据的三条 v2 保留结论（见 docs/dev-0.14.0/行为规格映射-草案.md）：
 * - **N-11 会计不变量**：restored + skipped + forgotten === 输入行数恒成立；
 *   任何一条行的异常只让这一行落 skipped，不打挂整批（beta.3 曾把整批恢复打挂）。
 * - **N-11b 逐字节重建**：恢复资格 = 按行内字段重建的回执正文与表面正文逐字节相等；
 *   缺字段/不相等 → 该行 skipped（专属文案），禁止模糊匹配或「猜一个能过的值」。
 * - **Q-01 正交性**：autoRestore 只决定「要不要恢复」，不决定「要不要做窗口守卫」；
 *   守卫是三态（true/false/unknown），unknown 失败关闭当作拒绝（G3）。
 */
import { V3ContractViolation } from '../../contracts/errors.mjs'

/** 行结局封闭集（会计恒等式的三个桶）。 */
export const ROW_OUTCOMES = Object.freeze(['restored', 'skipped', 'forgotten'])

/**
 * 单行恢复资格：行内重建的回执正文必须与表面正文逐字节相等才可恢复。
 *
 * @param {{ receiptText: string, surfaceText: string }} row
 * @returns {{ eligible: boolean, reason: string }}
 */
export function restoreEligibilityOf(row) {
  if (row === null || typeof row !== 'object') {
    throw new V3ContractViolation('v3 archive/restore: row 必须是对象')
  }
  if (typeof row.receiptText !== 'string' || row.receiptText.length === 0) {
    return { eligible: false, reason: '行内无重建回执（缺字段），拒绝覆盖' }
  }
  if (typeof row.surfaceText !== 'string' || row.surfaceText.length === 0) {
    return { eligible: false, reason: '表面正文缺失，拒绝恢复' }
  }
  if (row.receiptText !== row.surfaceText) {
    return { eligible: false, reason: '回执正文已变化，拒绝覆盖' }
  }
  return { eligible: true, reason: '逐字节相等' }
}

/**
 * 停用路径的恢复动作裁决（Q-01 正交性）。
 *
 * @param {boolean} autoRestore 用户设置：停用时是否恢复原文
 * @param {boolean|null} guardRefused 窗口守卫三态；unknown(null) 失败关闭当作拒绝
 * @returns {{ action: 'restore' | 'skip', reason: string }}
 *   reason 与回执首行三种结局一一对应：by-setting / guard-refused / proceed。
 */
export function restoreActionOf(autoRestore, guardRefused) {
  if (typeof autoRestore !== 'boolean') {
    throw new V3ContractViolation('v3 archive/restore: autoRestore 必须是布尔值')
  }
  if (guardRefused !== true && guardRefused !== false && guardRefused !== null) {
    throw new V3ContractViolation('v3 archive/restore: guardRefused 必须是 true/false/null(unknown)')
  }
  if (!autoRestore) return { action: 'skip', reason: 'by-setting' }
  if (guardRefused === true) return { action: 'skip', reason: 'guard-refused' }
  if (guardRefused === null) return { action: 'skip', reason: 'guard-refused' }
  return { action: 'restore', reason: 'proceed' }
}

/**
 * 会计结算：逐行结局汇总并验证 N-11 恒等式。
 * 行异常（未知结局值）只让该行落 skipped（原因 internal-failure），不打挂整批。
 *
 * @param {Array<{outcome: string}>} rows
 * @returns {{ restored: number, skipped: number, forgotten: number, total: number, balanced: boolean, rowResults: Array<{outcome: string, reason?: string}> }}
 */
export function settleRestore(rows) {
  if (!Array.isArray(rows)) {
    throw new V3ContractViolation('v3 archive/restore: rows 必须是数组')
  }
  const rowResults = []
  let restored = 0
  let skipped = 0
  let forgotten = 0
  for (const row of rows) {
    const outcome = row?.outcome
    if (ROW_OUTCOMES.includes(outcome)) {
      rowResults.push(row.reason !== undefined ? { outcome, reason: row.reason } : { outcome })
      if (outcome === 'restored') restored += 1
      else if (outcome === 'skipped') skipped += 1
      else forgotten += 1
    } else {
      rowResults.push({ outcome: 'skipped', reason: 'internal-failure' })
      skipped += 1
    }
  }
  const total = rows.length
  return {
    restored, skipped, forgotten, total,
    balanced: restored + skipped + forgotten === total,
    rowResults,
  }
}
