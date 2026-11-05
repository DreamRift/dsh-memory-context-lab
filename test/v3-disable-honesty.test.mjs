/**
 * P2-06（0.15.1）：`disableSession` 只做资格裁决，却把 eligible 记成 restored 并印「已恢复 N/M」。
 *
 * ## 缺陷
 * `disableSession` 的循环里对 eligible 行直接 `rows.push({outcome:'restored'})`，注释写着
 * 「M5 在此执行真实 surface 恢复」——而 M5 从未接上。于是 `settled.restored` 统计的是
 * **资格通过数**，回执首行印「已恢复 N/M 段」：用户以为「关掉 = 自动还原」，实际原文
 * 仍在冷库。与 ★8（/memory-lab off 把恢复失败伪装成无需恢复）同族：观察面与事实分叉。
 *
 * ## 判据来源
 * docs/dev-0.15.1/记忆上下文-0.15.1-独立排查报告.md §1★8 同族 / §3.2 P2-06；用户裁定
 * （2026-04-11 之前的会话已定「全部按顺序修」）与台账「待复核后定」——本次取**诚实口径**：
 * 不接线恢复，但把「未执行恢复」如实暴露，而不是继续谎报。
 *
 * ## 修法
 * `disableSession` 返回值新增 `wired:false` 与 `eligibleNotRestored`（资格通过但未恢复的
 * 行数）；`disableReceiptFirstLine` 增加 `wired` 参数（默认 true 保持接线后的旧文案）：
 * `wired=false` 时首行为「可恢复 N/M 段（本次未执行恢复…）」，绝不出现「已恢复」。
 * 会计三桶与逐行结果不变（资格语义不动）。
 *
 * ## 断言组
 * 1. 未接线路径：`wired===false`、`eligibleNotRestored === settled.restored`、首行以
 *    「可恢复 N/M 段」开头且**不含**「已恢复」；
 * 2. 纯函数：`wired:true` 仍是「已恢复 N/M 段」（接线后语气自然回正），`wired:false` 不是；
 * 3. 三种结局仍一一对应（skip-by-setting / skip-by-guard 不受 wiring 影响）。
 *
 * ## 不适用条件与已知边界
 * - 只改**文案与观测面**，不执行真实 surface 恢复（接线属 M5，另立条目）；
 * - 生产路径当前没有 `disableSession` 调用方（grep 仅测试），所以本修法不影响线上行为，
 *   只为「将来接线时不会带着假账」。
 *
 * ## 定点变异自证
 * 把 `wired` 恒置 true（退回旧文案）→ 组 1/2 红。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { createSessionLifecycle, disableReceiptFirstLine } from '../src/v3/application/session-lifecycle.mjs'

const clock = { now: () => 1 }
const random = { uuid: () => '00000000-0000-0000-0000-000000000000' }

function makeStore(vouchers) {
  return {
    async health() { return { healthy: true } },
    // 端口方法面完整（assertPort 要求）：未用到的用最小实现。
    async transaction() { throw new Error('未使用') },
    async readRecord() { throw new Error('未使用') },
    async rebuildIndex() { return { indexedCount: 0 } },
    async sourceEventIds() { return [] },
    listVouchers() { return [...vouchers] },
    restore(index, surfaceText) {
      const voucher = vouchers[index]
      if (voucher === undefined) return { voucher: null, eligibility: { eligible: false, reason: '凭证下标不存在' } }
      const eligible = voucher.receiptText === surfaceText
      return { voucher, eligibility: { eligible, reason: eligible ? '逐字节相等' : '回执正文已变化，拒绝覆盖' } }
    },
    async forget() { return { forgottenCount: 0, indexedCount: 0 } },
  }
}

const three = () => [
  { recordIds: ['a'], targetEventId: 'e1', receiptText: '回执一', txn: 1 },
  { recordIds: ['b'], targetEventId: 'e2', receiptText: '回执二', txn: 1 },
  { recordIds: ['c'], targetEventId: 'e3', receiptText: '回执三', txn: 1 },
]

test('P2-06 未接线路径：首行说「可恢复」，且不出现「已恢复」', async () => {
  const lifecycle = createSessionLifecycle({ store: makeStore(three()), clock, random })
  const result = await lifecycle.disableSession({
    autoRestore: true,
    guardRefused: false,
    surfaceTextOf: (v) => v.receiptText,
  })
  assert.equal(result.wired, false, '必须显式暴露「未接线」：' + JSON.stringify(result.wired))
  assert.equal(result.eligibleNotRestored, result.settled.restored, '资格通过但未恢复的行数 = restored 桶')
  assert.equal(result.eligibleNotRestored, 3)
  assert.equal(result.receiptFirstLine.includes('已恢复'), false, '未接线时不得印「已恢复」：' + result.receiptFirstLine)
  assert.ok(result.receiptFirstLine.startsWith('可恢复 3/3 段'), '首行必须如实：' + result.receiptFirstLine)
  assert.equal(result.settled.balanced, true, 'N-11 会计恒等不被破坏')
})

test('P2-06 纯函数口径：wired=true 仍是「已恢复」，wired=false 不是', () => {
  assert.ok(disableReceiptFirstLine({ action: 'restore', restored: 2, total: 3, skippedByGuard: 0 }).startsWith('已恢复 2/3 段'))
  const honest = disableReceiptFirstLine({ action: 'restore', restored: 2, total: 3, skippedByGuard: 0, wired: false })
  assert.ok(honest.startsWith('可恢复 2/3 段'))
  assert.equal(honest.includes('已恢复'), false)
})

test('P2-06 另两种结局不受 wiring 影响', () => {
  assert.match(disableReceiptFirstLine({ action: 'skip-by-setting', restored: 0, total: 3, skippedByGuard: 0, wired: false }), /^按设置未恢复/)
  assert.match(disableReceiptFirstLine({ action: 'skip-by-guard', restored: 0, total: 3, skippedByGuard: 3, wired: false }), /^守卫拒绝/)
})
