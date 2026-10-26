/**
 * 恢复凭证账本的读写边界（H-53/H-54，2026-10-26 缺陷排查批）。
 *
 * ## 缺陷
 * - **H-53**：`listVouchers()` 返回 `[...voucherLines]`——只浅拷贝数组，元素仍是内部
 *   对象、`recordIds` 仍是内部数组。调用方（恢复命令面）改一下就**污染内存态**，
 *   磁盘上却还是旧值：内存与账本分叉。后果具体到恢复路径上：
 *   `store.restore(index, surfaceText)` 用 `voucher.receiptText` 做逐字节比对，
 *   而那个 receiptText 可能是**从没落过盘**的值，于是恢复资格判定用的是假正文。
 * - **H-54**：`appendVoucher` 只校验 `typeof id === 'string'`，空串能进账本。
 *   一条指向空 ID 的凭证在恢复面上永远不可能有资格，却照样占一个 `voucherIndex`
 *   ——下标是恢复的唯一定位方式，占位即错位。
 *
 * ## 判据
 * - `listVouchers()` 返回的元素与 `recordIds` 数组都是**副本**：外部改动不回流；
 * - `recordIds` 的元素必须是**非空字符串**（与 `forget` 同口径）；数组本身可以为空——
 *   surface 恢复凭证就只绑 `targetEventId` 而不绑任何 v3 记录；
 * - 账本损坏仍 `ESTORE_DAMAGED` 失败关闭（语义不变）。
 *
 * ## 不适用条件
 * 只保证「内存态不被调用方误改」。凭证一经落盘仍是 append-only：本修复不提供
 * 凭证编辑/删除能力，也不改 `voucherIndex` 的下标语义。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { openV3SessionStore } from '../src/v3/adapters/storage/session-store.mjs'
import { createSessionStorePort } from '../src/v3/adapters/storage/session-store-port.mjs'

async function freshStore() {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-voucher-'))
  return openV3SessionStore(path.join(root, 's'), 's')
}

const voucherOf = (over = {}) => ({
  recordIds: ['v3r-0000000000000001'],
  targetEventId: 'dsh-5',
  receiptText: '回执正文',
  txn: 1,
  ...over,
})

test('H-53 listVouchers 返回副本：改 receiptText 不回流', async () => {
  const store = await freshStore()
  await store.appendVoucher(voucherOf())
  const view = store.listVouchers()
  view[0].receiptText = '被外部改掉'
  assert.equal(store.listVouchers()[0].receiptText, '回执正文')
  store.close()
})

test('H-53 listVouchers 的 recordIds 也是副本：push 不回流', async () => {
  const store = await freshStore()
  await store.appendVoucher(voucherOf())
  const view = store.listVouchers()
  view[0].recordIds.push('注入的假ID')
  assert.deepEqual(store.listVouchers()[0].recordIds, ['v3r-0000000000000001'])
  store.close()
})

test('H-53 外部改动不影响恢复资格判定（比对的是落盘正文）', async () => {
  // restore 在 port 层（store.restore 不存在），它内部调 listVouchers 取凭证——
  // 正是这条路径会吃到 H-53 的引用泄漏。
  const { port, store } = await createSessionStorePort(path.join(await mkdtemp(path.join(tmpdir(), 'mcl-voucher-port-')), 's'), 's')
  await store.appendVoucher(voucherOf())
  port.listVouchers()[0].receiptText = '假正文'
  assert.equal(port.restore(0, '回执正文').eligibility.eligible, true, '必须按落盘正文比对')
  assert.equal(port.restore(0, '假正文').eligibility.eligible, false, '假正文不得获得恢复资格')
  store.close()
})

test('H-54 recordIds 里的空串被拒绝（旧：接受并占下标）', async () => {
  const store = await freshStore()
  await assert.rejects(
    () => store.appendVoucher(voucherOf({ recordIds: [''] })),
    (error) => /recordIds 必须是非空字符串组成的数组/.test(error.message),
  )
  assert.equal(store.listVouchers().length, 0)
  store.close()
})

test('H-54 recordIds 空数组仍然合法（surface 恢复凭证的形状，不回归）', async () => {
  const store = await freshStore()
  const result = await store.appendVoucher(voucherOf({ recordIds: [] }))
  assert.equal(result.voucherCount, 1)
  store.close()
})

test('H-54 正常凭证照旧可追加（不回归）', async () => {
  const store = await freshStore()
  const result = await store.appendVoucher(voucherOf())
  assert.equal(result.voucherCount, 1)
  assert.equal(store.listVouchers()[0].receiptText, '回执正文')
  store.close()
})
