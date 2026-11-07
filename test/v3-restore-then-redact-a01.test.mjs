/**
 * A-01 守卫（0.15.4，P1）：restore 之后，那张凭证必须**仍然能被 redact**。
 *
 * ## 缺陷（真机可复现）
 *
 * `restore` 把回执节点**原地替换**成原文，宿主分配新 seq、旧 seq 作废。
 * 而 `redactVoucher` 过去靠「正文逐字节扫描」定位回执节点：
 *   firstEligibleSeq(surfaceNodes(), voucher.receiptText)
 * restore 之后面上已经没有那段回执正文了 → 恒返回 null → `receipt-changed`
 * → **这张凭证永久清洗不掉**。
 *
 * 叠加后果（这才是 P1 的原因）：
 * - `forget purge` 无法把该段从面上清除（隐私缺口）；
 * - 用户在 UI 上会看到「已清除 0/N」，而实际上什么都没发生。
 *
 * ## 修法（0.15.4）
 *
 * 把「凭证 → 当前节点 seq」这条**派生映射**持久化（`redactions.jsonl` 的
 * `action:'restored'` 行，与 P1-08 的 `seq` 字段同一先例），定位顺序改为
 * 「先账本 seq（并复核表面正文）→ 再正文扫描」。老账本没有记录时行为不变。
 *
 * ## 钉住的判据
 *
 * 1. restore 之后 redact **必须成功**（核心回归）；
 * 2. 清除后账本记下该凭证已 redacted；
 * 3. undo 仍能把正文还原（新增映射不得破坏 undo）；
 * 4. **失败关闭**：账本 seq 指向的节点正文已变（被宿主改写/压缩）时不得覆盖；
 * 5. 老账本（无 `restored` 行）+ 回执正文仍在面上 → 走旧路径照常成功（不回归）。
 *
 * ## 不适用条件
 *
 * - 不测跨进程并发（同一映射的写锁由 `v3-lock-*` 覆盖）；
 * - 不测真实 DSH 宿主的 seq 分配策略，用 `fake-session` 的等价规则；
 * - 不测 `purge` 删除 `records/` 的部分（`v3-forget*` 既有职责）。
 *
 * ## 变异自证
 *
 * 把 `replaceVoucherReceipt` 的「账本 seq 优先」整段去掉 → 用例 1、2 红；恢复 → 全绿。
 */
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createV3Runtime } from '../src/v3/composition/composition.mjs'
import { createArchiveService } from '../src/v3/application/archive.mjs'
import { createFakeSession } from './helpers/fake-session.mjs'
import { textOfDshEvent } from '../src/v3/entry/v3-entry.mjs'
import { seqOfDshEventId } from '../src/v3/adapters/host/dsh-host.mjs'

const RECEIPT = '这是归档回执正文：覆盖 seq 10–20，共 3 条记录，可按 ID 恢复。'

/**
 * 起一套真实 runtime（真 store + 真 host 适配器 + 假 DSH 会话）。
 * 然后手工追加一张「回执已落面」的凭证，模拟归档完成后的状态。
 */
async function setup(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-a01-'))
  const session = createFakeSession({ cwd: 'C:\\ws', contextWindow: 100000 })
  const runtime = await createV3Runtime({ v3Root: root, dshSession: session, sessionKey: 's-a01' })
  t.after(async () => {
    runtime.close()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  })
  const archive = createArchiveService({
    random: { uuid: () => randomUUID() },
    store: runtime.store,
    host: runtime.host,
    clock: { now: () => 1 },
    v3Root: root,
    // A-01：恢复正文指纹用装配点注入的 sha256（与生产 entry 同源）。
    sha256: runtime.hash.sha256,
  })
  return { root, session, runtime, archive }
}

/**
 * 把一段活动面替换成回执并登记一张凭证，返回 `{ voucherId, receiptSeq }`。
 *
 * 走真实的 host.surfaceOp（不是假手工），所以 seq 规则与生产一致。
 */
async function seedReceiptVoucher({ session, runtime, receiptText = RECEIPT }) {
  const pushed = session.pushUser('要被归档的原始内容' + 'x'.repeat(40))
  const startSeq = pushed.seq
  // 走真实摄入，让 store 里有对应记录（restore 要读记录正文）。
  await runtime.handleDshEventBatch(
    session.log.map((event) => ({ event, text: textOfDshEvent(event), meta: {} })),
  )
  // 找到 seq 对应的 recordId（与 e2e 的 seqMapOf 同口径：从 sourceEventId 反解 seq）
  const seqToRecordId = new Map()
  for (const rid of await runtime.store.listRecordIds()) {
    const provenance = await runtime.store.readProvenance(rid)
    const seq = seqOfDshEventId(provenance?.sourceEventId)
    if (seq !== null) seqToRecordId.set(seq, rid)
  }
  const recordId = seqToRecordId.get(startSeq)
  assert.ok(recordId, 'seq ' + startSeq + ' 必须有对应记录才能 restore，现有 ' + [...seqToRecordId.keys()].join(','))
  // 把这段活动面替换成回执（真实 host.surfaceOp 契约）。
  const confirmation = await runtime.host.surfaceOp({
    op: 'replace',
    startSeq,
    endSeq: startSeq,
    sourceEventSeqs: [startSeq],
    text: receiptText,
  })
  const receiptSeq = confirmation.seq
  const voucherId = 'v-' + receiptSeq
  await runtime.store.appendVoucher({
    schemaVersion: 3,
    voucherId,
    kind: 'span',
    recordIds: [recordId],
    sourceEventSeqs: [startSeq],
    startSeq,
    endSeq: startSeq,
    targetEventId: receiptSeq,
    receiptText,
    summaryText: '',
    restoreChars: 40,
    txn: 1,
  })
  return { voucherId, receiptSeq, startSeq }
}

test('A-01：restore 之后 redact 仍必须成功（核心回归）', async (t) => {
  const { session, runtime, archive } = await setup(t)
  const { receiptSeq } = await seedReceiptVoucher({ session, runtime })

  // restore 会把回执节点换成原文（seq 变化）
  const vouchers = await runtime.store.listVouchers()
  const index = vouchers.findIndex((v) => v.targetEventId === receiptSeq)
  assert.ok(index >= 0, '凭证必须存在')

  const restored = await archive.restoreVoucher(index)
  assert.equal(restored.restored, true, 'restore 应成功，实际：' + JSON.stringify(restored))

  const redacted = await archive.redactVoucher(index)
  assert.equal(
    redacted.changed, true,
    'restore 之后 redact 必须成功（旧实现在这里永久 receipt-changed），实际：' + JSON.stringify(redacted),
  )
})

test('A-01：redact 之后账本必须记下该凭证已清除', async (t) => {
  const { session, runtime, archive } = await setup(t)
  const { voucherId, receiptSeq } = await seedReceiptVoucher({ session, runtime })
  const index = (await runtime.store.listVouchers()).findIndex((v) => v.targetEventId === receiptSeq)
  await archive.restoreVoucher(index)
  const redacted = await archive.redactVoucher(index)
  assert.equal(redacted.changed, true)
  assert.ok(
    (await runtime.store.redactedVoucherIds()).includes(voucherId),
    '账本必须记下该凭证已清除，实际：' + JSON.stringify(await runtime.store.redactedVoucherIds()),
  )
})

test('A-01：undo 仍能把正文还原（新增映射不得破坏 undo）', async (t) => {
  const { session, runtime, archive } = await setup(t)
  const { voucherId, receiptSeq } = await seedReceiptVoucher({ session, runtime })
  const index = (await runtime.store.listVouchers()).findIndex((v) => v.targetEventId === receiptSeq)
  await archive.restoreVoucher(index)
  const redacted = await archive.redactVoucher(index)
  assert.equal(redacted.changed, true)

  const undone = await archive.unredactVoucher(index)
  assert.equal(undone.changed, true, 'undo 必须成功，实际：' + JSON.stringify(undone))
  assert.ok(
    !(await runtime.store.redactedVoucherIds()).includes(voucherId),
    'undo 后账本必须撤销清除标记',
  )
})

test('A-01 失败关闭：账本 seq 指向的正文已被宿主改写 → 不得覆盖', async (t) => {
  const { session, runtime, archive } = await setup(t)
  const { receiptSeq } = await seedReceiptVoucher({ session, runtime })
  const index = (await runtime.store.listVouchers()).findIndex((v) => v.targetEventId === receiptSeq)
  const restored = await archive.restoreVoucher(index)
  assert.equal(restored.restored, true)

  // 模拟宿主压缩：把恢复节点的正文换成别的（seq 仍在面上，但内容不符）
  const restoredSeq = restored.seq
  session.log.find((e) => e.seq === restoredSeq).data.content[0].text = '宿主压缩后的别的内容'

  const redacted = await archive.redactVoucher(index)
  assert.equal(redacted.changed, false, '正文不符时必须失败关闭，不得覆盖错节点')
})

test('A-01 不回归：未 restore 时走正文扫描，行为不变', async (t) => {
  const { session, runtime, archive } = await setup(t)
  const { receiptSeq } = await seedReceiptVoucher({ session, runtime })
  const index = (await runtime.store.listVouchers()).findIndex((v) => v.targetEventId === receiptSeq)
  const redacted = await archive.redactVoucher(index)
  assert.equal(redacted.changed, true, '未 restore 过时 redact 行为不得回归')
})
