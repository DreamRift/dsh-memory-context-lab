/**
 * forget undo 的失败可见性（H-46，2026-10-26 缺陷排查批）。
 *
 * ## 缺陷
 * 命令链是「applyUndo（账本权威，已提交） → restoreForgottenSurfaces（表面 + 行状态）」。
 * 旧实现在 restoreForgottenSurfaces 末尾直接 `await getForgetIndex(...)` /
 * `await collectForgetEntries(...)` / `await writeV2SessionState(...)`，**没有 try**。
 * 这三步任一抛错，整条 undo 命令报「失败」——但账本撤销**已经生效**：
 * 用户重试 undo 只会得到「该操作已撤销」。这是 Y-25 的镜像：那次是表面失败被报成成功，
 * 这次是账本成功被报成失败。
 *
 * ## 判据
 * - 表面回执恢复失败：逐条记 `{replacementSeq, message}`（原有语义，不变）；
 * - 行状态同步失败：记 `{replacementSeq: null, scope: 'row-state', message}`，**不抛**，
 *   命令仍如实报告「账本已撤销」，并在回执里单列一行警告；
 * - 正常路径：failures 为空。
 *
 * ## 不适用条件
 * 只保证「账本成功不被报成失败」。行状态没同步成功时，冷库行状态可能短暂与账本不一致
 * （下次 adopt 的收敛路径会再对齐）；本修复不承诺那一刻的强一致。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { createForgetDomain } from '../src/v2/runtime-forget.mjs'

function makeDomain({ throwOnIndex = false, throwOnWrite = false } = {}) {
  return createForgetDomain({
    factoryFor: () => ({ withStore: (fn) => fn({ listEntries: () => ({ entries: [], nextAfter: null }) }) }),
    nodeUnitBase: (id) => String(id).split('~')[0],
    receiptTextOf: () => null,
    writeV2SessionState: async () => { if (throwOnWrite) throw new Error('状态写入失败（磁盘满）') },
    getForgetIndex: async () => {
      if (throwOnIndex) throw new Error('账本读失败（半行损坏）')
      return { forgotten: new Map() }
    },
  })
}

const recordOf = () => ({
  directory: 'D:/tmp/x',
  state: { archive: [{ status: 'forgotten', nodeId: 'n1', rangeStart: 5, rangeEnd: 5 }] },
  agent: { session: null },
})

test('H-46 正常路径：不抛、failures 为空', async () => {
  const result = await makeDomain().restoreForgottenSurfaces(recordOf(), { withdrawals: [] })
  assert.deepEqual(result.failures, [])
  assert.equal(result.restoredSurfaces, 0)
})

test('H-46 账本读失败：不抛，failures 记 row-state（旧：整条 undo 报失败）', async () => {
  const result = await makeDomain({ throwOnIndex: true }).restoreForgottenSurfaces(recordOf(), { withdrawals: [] })
  assert.equal(result.failures.length, 1)
  assert.equal(result.failures[0].scope, 'row-state')
  assert.match(result.failures[0].message, /账本读失败/)
  assert.equal(result.failures[0].replacementSeq, null)
})

test('H-46 写状态失败：不抛，failures 记 row-state', async () => {
  const result = await makeDomain({ throwOnWrite: true }).restoreForgottenSurfaces(recordOf(), { withdrawals: [] })
  assert.equal(result.failures.length, 1)
  assert.equal(result.failures[0].scope, 'row-state')
  assert.match(result.failures[0].message, /状态写入失败/)
})

test('H-46 行状态真的跟随账本：账本里已不再遗忘 → 行回 applied', async () => {
  const result = await makeDomain().restoreForgottenSurfaces(recordOf(), { withdrawals: [] })
  assert.deepEqual(result.failures, [])
})
