/**
 * v3 domain/archive 恢复资格测试（M1）。
 *
 * ## 判据来源
 * 行为规格映射保留项：N-11 会计不变量、N-11b 逐字节重建、Q-01 正交性、G3 三态
 * unknown 失败关闭（docs/dev-0.14.0/行为规格映射-草案.md archive 域）。
 *
 * ## 断言组
 * - 资格：逐字节相等才 eligible；缺字段/表面缺失/不一致各有专属 reason；
 * - 动作：by-setting / guard-refused(含 unknown) / proceed 三种结局一一对应；
 * - 会计：三桶之和恒等于输入行数；未知结局只落该行 skipped 不打挂整批。
 *
 * ## 不适用条件与已知边界
 * 纯函数裁决；span/batch 旧格式迁移与真实存储读取属 M2/M3。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { restoreActionOf, restoreEligibilityOf, settleRestore } from '../src/v3/domain/archive/restore.mjs'

test('资格：逐字节相等才 eligible，不一致有专属 reason', () => {
  assert.deepEqual(restoreEligibilityOf({ receiptText: 'A', surfaceText: 'A' }), { eligible: true, reason: '逐字节相等' })
  assert.equal(restoreEligibilityOf({ receiptText: 'A', surfaceText: 'A ' }).eligible, false)
  assert.match(restoreEligibilityOf({ receiptText: 'A', surfaceText: 'B' }).reason, /已变化/)
  assert.match(restoreEligibilityOf({ receiptText: '', surfaceText: 'A' }).reason, /无重建回执/)
  assert.match(restoreEligibilityOf({ receiptText: 'A', surfaceText: '' }).reason, /表面正文缺失/)
})

test('动作（Q-01）：三种结局一一对应，unknown 失败关闭当拒绝', () => {
  assert.deepEqual(restoreActionOf(false, false), { action: 'skip', reason: 'by-setting' })
  assert.deepEqual(restoreActionOf(true, true), { action: 'skip', reason: 'guard-refused' })
  assert.deepEqual(restoreActionOf(true, null), { action: 'skip', reason: 'guard-refused' }, 'unknown 当作可能超窗（G3）')
  assert.deepEqual(restoreActionOf(true, false), { action: 'restore', reason: 'proceed' })
})

test('会计（N-11）：三桶之和恒等于输入行数', () => {
  const rows = [
    { outcome: 'restored' }, { outcome: 'skipped' }, { outcome: 'forgotten' },
    { outcome: 'restored' }, { outcome: 'weird' },
  ]
  const settled = settleRestore(rows)
  assert.equal(settled.total, 5)
  assert.equal(settled.restored + settled.skipped + settled.forgotten, 5)
  assert.equal(settled.balanced, true)
  assert.deepEqual(settled.rowResults[4], { outcome: 'skipped', reason: 'internal-failure' }, '未知结局只落该行 skipped')
  assert.deepEqual(settled.rowResults.slice(0, 4), rows.slice(0, 4).map((r) => ({ outcome: r.outcome })))
})

test('空批与非法输入', () => {
  assert.deepEqual(settleRestore([]), { restored: 0, skipped: 0, forgotten: 0, total: 0, balanced: true, rowResults: [] })
  assert.throws(() => restoreActionOf('yes', false), (e) => e?.name === 'V3ContractViolation')
  assert.throws(() => restoreActionOf(true, 'unknown'), (e) => e?.name === 'V3ContractViolation')
  assert.throws(() => restoreEligibilityOf(null), (e) => e?.name === 'V3ContractViolation')
  assert.throws(() => settleRestore('x'), (e) => e?.name === 'V3ContractViolation')
})
