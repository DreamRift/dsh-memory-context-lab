/**
 * 会话生命周期用例（application，M3 第二批）：enable / disable / restore / forget。
 *
 * disable 的裁决口径（beta.5 Q-01 的 v3 重证）：
 * - autoRestore 只决定「要不要恢复」，不决定「要不要做窗口守卫」；
 * - guardRefused 三态（true/false/null=unknown），unknown 失败关闭当作拒绝（G3）；
 * - 回执首行与三种结局一一对应：按设置未恢复 / 守卫拒绝 / 已恢复 N/M。
 * 会计（beta.4 N-11）：restored + skipped + forgotten === 凭证行数恒成立；
 * 单行异常只落该行 skipped（internal-failure），不打挂整批。
 */
import { V3ContractViolation } from '../contracts/index.mjs'
import { restoreActionOf, settleRestore } from '../domain/archive/restore.mjs'
import { assertPort } from '../ports/index.mjs'

/** 回执首行：与 disable 的三种结局一一对应（不得在未恢复时印「已恢复 N/M」）。 */
export function disableReceiptFirstLine({ action, restored, total, skippedByGuard }) {
  if (action === 'skip-by-setting') return '按设置未恢复：原文已沉入冷库（' + total + ' 段可随时恢复）'
  if (action === 'skip-by-guard') return '守卫拒绝：恢复会超出安全窗口（' + skippedByGuard + '/' + total + ' 段保留回执）'
  return '已恢复 ' + restored + '/' + total + ' 段'
}

/**
 * 创建生命周期用例集。
 * @param {object} deps { store: SessionStore 端口, clock: Clock, random: Random, metrics?: Metrics }
 */
export function createSessionLifecycle({ store, clock, random, metrics }) {
  assertPort('SessionStore', store)
  assertPort('Clock', clock)
  assertPort('Random', random)

  async function enableSession() {
    const health = await store.health()
    if (!health.healthy) {
      metrics?.counter?.('v3.lifecycle.enable.refused', 1)
      return { enabled: false, reason: health.damagedReason ?? 'storage-damaged', health }
    }
    metrics?.counter?.('v3.lifecycle.enabled', 1)
    return { enabled: true, health }
  }

  /**
   * 停用：逐凭证裁决 → 会计结算 → 回执首行。
   * @param {object} input { autoRestore: boolean, guardRefused: boolean|null, surfaceTextOf: (voucher) => string }
   */
  async function disableSession({ autoRestore, guardRefused, surfaceTextOf }) {
    if (typeof surfaceTextOf !== 'function') {
      throw new V3ContractViolation('v3 lifecycle: surfaceTextOf 必须是函数（取凭证当前表面正文）')
    }
    const action = restoreActionOf(autoRestore, guardRefused) // Q-01 正交 + G3 unknown fail-closed
    const vouchers = store.listVouchers()
    const rows = []
    for (const [index, voucher] of vouchers.entries()) {
      if (action.action === 'skip') {
        rows.push({ outcome: 'skipped', reason: action.reason })
        continue
      }
      // 单行异常只落该行 skipped（N-11，H-42）：surfaceTextOf 是调用方注入的，
      // 凭证指向的事件可能已不存在、宿主可能拒绝访问——旧实现没有 try，一个抛错
      // 就把整批恢复打挂（正是文档里写的「beta.3 曾把整批恢复打挂」那条又回来了）。
      // 恢复是逐行独立的裁决：某一行取不到表面正文，不代表其余行不能恢复。
      try {
        const { eligibility } = store.restore(index, surfaceTextOf(voucher))
        rows.push(
          eligibility.eligible
            ? { outcome: 'restored' } // M5 在此执行真实 surface 恢复
            : { outcome: 'skipped', reason: eligibility.reason },
        )
      } catch (error) {
        metrics?.counter?.('v3.lifecycle.restoreRowFailed', 1)
        rows.push({ outcome: 'skipped', reason: 'internal-failure: ' + (error?.message ?? String(error)) })
      }
    }
    const settled = settleRestore(rows) // N-11：三桶恒等，异常行只落 skipped
    const skippedByGuard = rows.filter((r) => r.reason === 'guard-refused').length
    const receiptFirstLine = disableReceiptFirstLine({
      action: action.action === 'restore' ? 'restore' : (action.reason === 'by-setting' ? 'skip-by-setting' : 'skip-by-guard'),
      restored: settled.restored,
      total: settled.total,
      skippedByGuard,
    })
    metrics?.counter?.('v3.lifecycle.disabled', 1)
    metrics?.observe?.('v3.lifecycle.restoreRatio', settled.total === 0 ? 0 : settled.restored / settled.total)
    return { action, settled, receiptFirstLine, rowResults: settled.rowResults }
  }

  /** 单凭证恢复（供 /memory-lab restore 单段语义，M5 接宿主）。 */
  function restoreOne({ voucherIndex, surfaceText }) {
    if (!Number.isInteger(voucherIndex) || voucherIndex < 0) {
      throw new V3ContractViolation('v3 lifecycle: voucherIndex 必须是非负整数')
    }
    const { voucher, eligibility } = store.restore(voucherIndex, surfaceText)
    if (voucher === null) {
      return { restored: false, reason: eligibility.reason }
    }
    return { restored: eligibility.eligible, voucher, reason: eligibility.reason, text: eligibility.eligible ? voucher.receiptText : null }
  }

  /** 主动遗忘：幂等；未提交过的 ID 冲突拒绝（fail-closed）。 */
  async function forget({ recordIds }) {
    if (!Array.isArray(recordIds) || recordIds.length === 0 || recordIds.some((id) => typeof id !== 'string' || id.length === 0)) {
      throw new V3ContractViolation('v3 lifecycle: recordIds 必须是非空字符串数组')
    }
    const result = await store.forget(recordIds)
    metrics?.counter?.('v3.lifecycle.forgotten', recordIds.length)
    return result
  }

  return { enableSession, disableSession, restoreOne, forget }
}
