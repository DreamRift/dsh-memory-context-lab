/**
 * H6（2026-11-04 独立审计）：凭证 ID 唯一性必须在**锁内 + 磁盘视图**上判定。
 *
 * 旧实现：调用方在锁外用本句柄打开期解析的内存数组 `.some()` 判重。另一个进程/句柄
 * 刚追加的凭证它看不到，于是两边各写一条 `v-<seq>`；`restore(<序号>)` 靠下标定位，
 * 遇到重复凭证就会错位恢复。
 *
 * 现在：`appendVoucher` 在会话跨进程写锁内先刷新磁盘账本再判重，重复抛
 * `ESTORE_DUPLICATE_VOUCHER`；调用方（recoverIntent）把该冲突翻译成幂等跳过。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createSessionStorePort } from '../src/v3/adapters/storage/session-store-port.mjs'

const voucher = (voucherId) => ({
  schemaVersion: 2,
  voucherId,
  kind: 'span',
  recordIds: [],
  sourceEventSeqs: [1],
  startSeq: 1,
  endSeq: 1,
  targetEventId: 2,
  receiptText: '回执正文',
  txn: 1,
})

test('H6 两个句柄对同一凭证 ID 追加：第二个被拒，账本只有一行', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-voucher-dedupe-'))
  const a = await createSessionStorePort(root, 's-dedupe')
  const b = await createSessionStorePort(root, 's-dedupe')
  try {
    await a.port.appendVoucher(voucher('v-2'))
    // b 的打开期视图里没有这条；旧实现会放过第二条。
    await assert.rejects(() => b.port.appendVoucher(voucher('v-2')), (error) => error.code === 'ESTORE_DUPLICATE_VOUCHER')
    assert.equal(a.port.listVouchers().length, 1)
    assert.equal(b.port.listVouchers().length, 1)
  } finally {
    a.port.close()
    b.port.close()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})

test('H6 不同 ID 仍可正常追加（唯一约束不误伤）', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-voucher-dedupe-ok-'))
  const a = await createSessionStorePort(root, 's-dedupe-ok')
  try {
    await a.port.appendVoucher(voucher('v-2'))
    await a.port.appendVoucher(voucher('v-4'))
    assert.deepEqual(a.port.listVouchers().map((row) => row.voucherId), ['v-2', 'v-4'])
  } finally {
    a.port.close()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})
