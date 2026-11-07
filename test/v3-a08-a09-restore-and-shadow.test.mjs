/**
 * A-08 / A-09 守卫（0.15.4 全面排查 A 类收口）。
 *
 * A-08：`receipt-changed` 一个原因码掩盖三类事实。最要命的一类：**上次已经恢复过**。
 *       旧实现把它记成 skipped，`restore all` 跑第二次就报「N 段跳过」，
 *       用户以为恢复失败了——实际是全部已经恢复。
 * A-09：`shadowReport({enabled:true})` 没有 return，诊断面打印 `undefined`。
 *
 * 两条都带反向用例：不能为了「好看」把真失败也说成成功。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { shadowReport, SHADOW_LIMITS } from '../src/v3/application/compression-shadow.mjs'
import { MCL_STATUS_VOCABULARY } from '../src/v3/contracts/status-vocabulary.mjs'

test('A-09：shadowReport 开启时必须返回可读报告，不得是 undefined', () => {
  assert.equal(shadowReport(), null, '默认关闭 → null（保持既有契约）')
  assert.equal(shadowReport({ enabled: false }), null, '显式关闭 → null')

  const report = shadowReport({ enabled: true })
  assert.notEqual(report, undefined, '开启时不得返回 undefined（A-09 的原始症状）')
  assert.equal(typeof report, 'object')
  assert.equal(report.contract, 'i2.compression-shadow/v1', '必须带契约标记')
  assert.ok(MCL_STATUS_VOCABULARY.includes(report.status), 'status 必须属于状态词表：' + report.status)
  assert.equal(report.shadowOnly, true, '必须自述只观测')
  assert.equal(report.participatesInDecision, false, '必须自述不参与压缩决策')
  // 报告本身有预算上限：诊断面不该被一份巨大报告卡住。
  assert.ok(JSON.stringify(report).length <= SHADOW_LIMITS.characters, '报告不得超过字符预算')
  // safety 面必须是「未评估」而不是伪造的通过。
  assert.equal(Object.keys(report.safety).length > 0, true, 'safety 面不得为空')
  for (const value of Object.values(report.safety)) {
    assert.equal(value, null, 'safety 值必须如实为 null（未评估），不得伪造通过')
  }
})

test('A-08：上次已恢复的凭证必须报「已恢复」，不得混进跳过', async () => {
  // 直接打**真实折算函数**（archive.restoreAll 用的就是它），不是重新实现一遍规则。
  const { outcomeOfRestore, settleRestore } = await import('../src/v3/domain/archive/restore.mjs')
  const settled = settleRestore([
    outcomeOfRestore({ restored: true }),                                        // 本次真的恢复
    outcomeOfRestore({ restored: false, alreadyRestored: true, reason: 'already-restored' }), // 上次已恢复
    outcomeOfRestore({ restored: false, reason: 'record-forgotten' }),           // 已遗忘
    outcomeOfRestore({ restored: false, reason: 'receipt-changed' }),            // 真冲突
  ])
  assert.equal(settled.total, 4)
  assert.equal(settled.restored, 2, '本次恢复 + 上次已恢复都算「已恢复」')
  assert.equal(settled.forgotten, 1)
  assert.equal(settled.skipped, 1, '只有真冲突算跳过')
  assert.equal(settled.balanced, true, '三桶必须配平')
})

test('A-08 反向：已遗忘不得被折算成已恢复，真冲突不得被折算成已恢复', async () => {
  const { outcomeOfRestore, settleRestore } = await import('../src/v3/domain/archive/restore.mjs')
  const settled = settleRestore([
    outcomeOfRestore({ restored: false, reason: 'record-forgotten' }),
    outcomeOfRestore({ restored: false, reason: 'receipt-changed' }),
    outcomeOfRestore({ restored: false, reason: 'record-purged' }),
    // 「不知道」不得折算成成功：没有 alreadyRestored 证据的一律仍按 skipped。
    outcomeOfRestore({ restored: false, reason: 'already-restored' }),
  ])
  assert.equal(settled.restored, 0, '没有任何一段被证明「已恢复」')
  assert.equal(settled.forgotten, 1)
  assert.equal(settled.skipped, 3)
  assert.equal(settled.balanced, true)
})
