/**
 * P2-07（0.15.1）：purge 的派生物清除覆盖不全——redact 失败时凭证仍留 ≤400 字原文首部。
 *
 * ## 缺陷
 * `forgetRecords` 的顺序是「先 `store.purge` 删正文 → 再 `archive.redactVoucher` 清回执」。
 * 中间任一步失败（回执被宿主改写 → `receipt-changed`；redactions 标记写失败）都会让
 * `vouchers.jsonl` 里继续躺着 ≤400 字的**原文首部**，而正文已经物理删除——用户以为
 * 「全都清了」，实际还能从 history/导出面读到一段原文。读面只看 redactions 标记，
 * 与 purge 事实解耦，于是这个残留永远不会被识别为「已清除」。
 *
 * ## 判据来源
 * docs/dev-0.15.1/记忆上下文-0.15.1-独立排查报告.md §3.2 P2-07（审读）；用户裁定
 * （2026-11-04）：全部按顺序修、根因修复。
 *
 * ## 修法（两处，互补）
 * 1. **读面以 purge 事实为准**：`archive.history()` 与 `restoreVoucher` 都先看
 *    `store.listPurged()`——凭证任一记录已被物理清除，该段正文一律不可见、不可恢复，
 *    与 redact 是否成功解耦（新增行字段 `purged`）；
 * 2. **写面把顺序倒过来**（entry）：purge 前先清回执，清不掉就**中止 purge**并如实返回
 *    `purge-redaction-incomplete`（正文还在，可先 undo/修复再重试），绝不带着残留首部
 *    完成物理清除。
 *
 * ## 断言组
 * 1. 读面：凭证记录已 purge、redactions 无标记 → `history()` 该行 `redacted:true` 且
 *    `purged:true`（旧实现是 `redacted:false` = 谎报可导出）；
 * 2. 恢复面：同一凭证 `restoreVoucher` 返回 `record-purged`（不去碰宿主面、不读记录）；
 * 3. 未 purge 的凭证不受影响（`purged:false`、`redacted` 仍按标记）——不误杀。
 *
 * ## 不适用条件与已知边界
 * - purge 账本不可读时按「未知」失败关闭（该列一律按已清除显示），不谎报可导出；
 * - 旧版本已留下的残留首部不会被物理抹除（append-only 合同）：本修法保证的是
 *   **不再对外可见/不可恢复**，字节级清理仍属 purge 的派生物清理面（已由前置级联挡住新残留）。
 *
 * ## 定点变异自证
 * 去掉 `purgedOf` 的兜底（只信 redactions 标记）→ 组 1/2 红；把 restore 的 purge 前置判断
 * 删掉 → 组 2 红。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { createArchiveService } from '../src/v3/application/archive.mjs'

const RECEIPT = '[记忆上下文] 已把 2 条已完成历史（seq 1–2）归档为可恢复回执。摘要：原文首部三百字…'

function storeOf({ purged = [], redacted = [], vouchers }) {
  return {
    listVouchers: () => vouchers.map((v) => ({ ...v })),
    listPurged: () => [...purged],
    redactedVoucherIds: () => [...redacted],
    async readRecord(id) {
      if (purged.includes(id)) throw Object.assign(new Error('已物理清除'), { code: 'EFORGOTTEN' })
      const text = '正文'.repeat(50)
      return { id, kind: 'message-user', sessionKey: 's', createdAt: 1, payload: { text, bytes: Buffer.byteLength(text, 'utf8') }, provenance: {} }
    },
  }
}

const hostOf = () => ({
  async surfaceNodes() { return [5] },
  async surfaceTextAt(seq) { return seq === 5 ? RECEIPT : null },
  async surfaceOp() { return { seq: 9 } },
})

const serviceOf = (store) => createArchiveService({ store, host: hostOf(), clock: { now: () => 1 }, random: { uuid: () => 'u' } })

const voucherOf = (id) => ({ voucherId: 'v-' + id, kind: 'span', recordIds: ['v3r-' + id], receiptText: RECEIPT, targetEventId: 5, startSeq: 1, endSeq: 2 })

test('P2-07 读面：记录已 purge 时即便没有 redactions 标记也不得显示可导出', async () => {
  const store = storeOf({ purged: ['v3r-aaaa'], redacted: [], vouchers: [voucherOf('aaaa')] })
  const history = await serviceOf(store).history()
  assert.equal(history.rows.length, 1)
  assert.equal(history.rows[0].purged, true, '必须标出「按 purge 事实兜底」：' + JSON.stringify(history.rows[0]))
  assert.equal(history.rows[0].redacted, true, '正文已物理删除 → 观察面不得再显示可恢复/可导出：' + JSON.stringify(history.rows[0]))
})

test('P2-07 恢复面：已 purge 的凭证直接拒绝，不去碰宿主面', async () => {
  const store = storeOf({ purged: ['v3r-bbbb'], redacted: [], vouchers: [voucherOf('bbbb')] })
  const result = await serviceOf(store).restoreVoucher(0)
  assert.equal(result.restored, false)
  assert.equal(result.reason, 'record-purged', JSON.stringify(result))
})

test('P2-07 不误杀：未 purge 的凭证仍按 redactions 标记显示', async () => {
  const store = storeOf({ purged: ['v3r-other'], redacted: [], vouchers: [voucherOf('cccc')] })
  const row = (await serviceOf(store).history()).rows[0]
  assert.equal(row.purged, false)
  assert.equal(row.redacted, false, '未 purge 且无标记 → 未清除')
  const restored = await serviceOf(store).restoreVoucher(0)
  assert.equal(restored.restored, true, JSON.stringify(restored))
})

test('P2-07 写面静态守卫：purge 前必须先做回执清除校验（顺序不得回退）', async () => {
  const { readFile } = await import('node:fs/promises')
  const { fileURLToPath } = await import('node:url')
  const src = await readFile(fileURLToPath(new URL('../src/v3/entry/v3-entry.mjs', import.meta.url)), 'utf8')
  const purgeAt = src.indexOf('await entry.runtime.store.purge(recordIds)')
  const guardAt = src.indexOf("error: 'purge-redaction-incomplete'")
  assert.ok(purgeAt > 0, '必须能找到 purge 调用')
  assert.ok(guardAt > 0, '必须存在「回执清不掉即中止」的前置校验')
  assert.ok(guardAt < purgeAt, '前置校验必须在 purge 之前（旧实现是先删正文后清回执）')
  // 守卫还要能看出「先清回执」：前置循环里出现 redactVoucher 且位于 purgeAt 之前
  const redactAt = src.lastIndexOf('entry.archive.redactVoucher(index)', purgeAt)
  assert.ok(redactAt > 0 && redactAt < purgeAt, 'purge 之前必须先清受影响回执')
})

test('P2-07 写面静态守卫：purge 前必须先做回执清除校验（顺序不得回退）', async () => {
  const { readFile } = await import('node:fs/promises')
  const { fileURLToPath } = await import('node:url')
  const src = await readFile(fileURLToPath(new URL('../src/v3/entry/v3-entry.mjs', import.meta.url)), 'utf8')
  const purgeAt = src.indexOf('await entry.runtime.store.purge(recordIds)')
  const guardAt = src.indexOf("error: 'purge-redaction-incomplete'")
  assert.ok(purgeAt > 0, '必须能找到 purge 调用')
  assert.ok(guardAt > 0, '必须存在「回执清不掉即中止」的前置校验')
  assert.ok(guardAt < purgeAt, '前置校验必须在 purge 之前（旧实现是先删正文后清回执）')
  // 守卫还要能看出「先清回执」：前置循环里出现 redactVoucher 且位于 purgeAt 之前
  const redactAt = src.lastIndexOf('entry.archive.redactVoucher(index)', purgeAt)
  assert.ok(redactAt > 0 && redactAt < purgeAt, 'purge 之前必须先清受影响回执')
})

test('P2-07 写面静态守卫：purge 前必须先做回执清除校验（顺序不得回退）', async () => {
  const { readFile } = await import('node:fs/promises')
  const { fileURLToPath } = await import('node:url')
  const src = await readFile(fileURLToPath(new URL('../src/v3/entry/v3-entry.mjs', import.meta.url)), 'utf8')
  const purgeAt = src.indexOf('await entry.runtime.store.purge(recordIds)')
  const guardAt = src.indexOf("error: 'purge-redaction-incomplete'")
  assert.ok(purgeAt > 0, '必须能找到 purge 调用')
  assert.ok(guardAt > 0, '必须存在「回执清不掉即中止」的前置校验')
  assert.ok(guardAt < purgeAt, '前置校验必须在 purge 之前（旧实现是先删正文后清回执）')
  // 守卫还要能看出「先清回执」：前置循环里出现 redactVoucher 且位于 purgeAt 之前
  const redactAt = src.lastIndexOf('entry.archive.redactVoucher(index)', purgeAt)
  assert.ok(redactAt > 0 && redactAt < purgeAt, 'purge 之前必须先清受影响回执')
})
