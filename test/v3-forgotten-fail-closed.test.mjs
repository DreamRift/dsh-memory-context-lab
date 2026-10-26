/**
 * v3 遗忘账本损坏时的失败关闭守卫（H-09，2026-10-26 缺陷排查批）。
 *
 * ## 缺陷
 * openV3SessionStore 对 vouchers.jsonl 损坏判 damaged（listVouchers 抛 ESTORE_DAMAGED），
 * 却对 forgotten.jsonl 损坏**不判**：parseTxnLog 只返回「已解析前缀」，前缀之外的 forget
 * 行静默丢失，于是 health 报 healthy:true、已遗忘记录重新可读（隐私面 fail-open）、
 * 写入照常进行。位翻转/人工损坏让坏行出现在日志中间时即触发。
 *
 * ## 判据
 * - forgotten.jsonl 有不可解析行 → health.healthy=false 且 damagedReason 指向该文件；
 * - 读路径（readRecord / listForgotten）一律 ESTORE_DAMAGED，不得返回「未遗忘」；
 * - 与 vouchers 的独立故障面口径一致：记录写不受影响（不因隐私账本损坏就锁死写入）；
 * - 账本完好时行为不变（EFORGOTTEN 仍按 ID 精确拒读）。
 *
 * ## 不适用条件与已知边界
 * 只覆盖「损坏即可见」的判定；不实现自动修复（修复属人工审计，隔离区只进不出）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { openV3SessionStore } from '../src/v3/adapters/storage/session-store.mjs'

function record(id, text) {
  return {
    id,
    kind: 'message-user',
    sessionKey: 's',
    createdAt: 1792845000000,
    payload: { text, bytes: Buffer.byteLength(text, 'utf8') },
    provenance: { sourceEventId: 'dsh-1', sourceForm: null, transactionId: 'tx-1' },
  }
}

async function withStore(body) {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-v3-forgotten-'))
  try {
    return await body(root)
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
}

test('H-09 遗忘账本损坏 → 读路径失败关闭（旧：health 报 healthy、已遗忘正文重新可读）', async () => {
  await withStore(async (root) => {
    const first = await openV3SessionStore(root, 's')
    await first.submitTransaction([record('v3r-0000000000000001', '秘密正文甲'), record('v3r-0000000000000002', '普通正文乙')])
    await first.forget('v3r-0000000000000001')
    await assert.rejects(() => first.readRecord('v3r-0000000000000001'), (e) => e?.code === 'EFORGOTTEN', '账本完好时仍精确拒读')
    first.close()

    // 位翻转/人工损坏：坏行出现在日志开头，后续 forget 行落在「已解析前缀」之外
    const file = path.join(root, 'sessions', 's', 'forgotten.jsonl')
    const original = await readFile(file, 'utf8')
    await writeFile(file, 'GARBAGE-NOT-JSON\n' + original, 'utf8')

    const second = await openV3SessionStore(root, 's')
    const health = second.health()
    assert.equal(health.healthy, false, '遗忘账本损坏必须反映在 health')
    assert.equal(health.forgottenDamaged, true)
    assert.match(health.damagedReason, /forgotten\.jsonl/)
    await assert.rejects(() => second.readRecord('v3r-0000000000000001'), (e) => e?.code === 'ESTORE_DAMAGED', '已遗忘正文不得重新可读')
    await assert.rejects(() => second.readRecord('v3r-0000000000000002'), (e) => e?.code === 'ESTORE_DAMAGED', '无法判定遗忘状态时一律失败关闭')
    assert.throws(() => second.listForgotten(), (e) => e?.code === 'ESTORE_DAMAGED', '不得把损坏账本当空表')
    // 独立故障面：记录写不受影响（与 vouchers 损坏同口径）
    const txn = await second.submitTransaction([record('v3r-0000000000000003', '新正文丙')])
    assert.equal(txn.recordIds.length, 1)
    second.close()
  })
})

test('H-09 损坏原因指向真实文件（旧：一律写 transactions.jsonl，误导排查）', async () => {
  await withStore(async (root) => {
    const store = await openV3SessionStore(root, 's')
    await store.submitTransaction([record('v3r-0000000000000010', '正文')])
    await store.appendVoucher({ recordIds: ['v3r-0000000000000010'], targetEventId: 'dsh-1', receiptText: '回执', txn: 1 })
    store.close()

    await writeFile(path.join(root, 'sessions', 's', 'vouchers.jsonl'), 'BROKEN\n', 'utf8')
    const reopened = await openV3SessionStore(root, 's')
    assert.match(reopened.health().damagedReason, /vouchers\.jsonl/, '原因必须指向 vouchers.jsonl')
    reopened.close()
  })
})
