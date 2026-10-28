/**
 * 历史归档用例（application/archive，M2）。
 *
 * 顺序（安全优先）：
 * 1. 纯函数选连续 span（当前回合/插件节点/无记录节点不选）；
 * 2. 读记录，生成回执；
 * 3. 写 archive-intent；
 * 4. 宿主 range replace（失败 → 清 intent、surface 不变）；
 * 5. 追加 voucher；成功后清 intent / 推进 state。
 *
 * 这里不做压力/保留策略的“决定”，只执行已选 span；策略在 domain/archive/candidates。
 */
import { V3ContractViolation } from '../contracts/index.mjs'
import { renderArchiveReceipt } from '../domain/archive/receipt.mjs'
import { selectArchiveSpan } from '../domain/archive/candidates.mjs'
import { selectStepSpan } from '../domain/archive/steps.mjs'
import { summarizeRecords } from '../domain/compress/summary.mjs'

function textOfRecord(record) {
  if (record === null || typeof record !== 'object') return ''
  const text = record.payload?.text ?? record.text
  return typeof text === 'string' ? text : ''
}

export function createArchiveService({ store, host, clock, intent = null } = {}) {
  if (store === null || typeof store !== 'object') throw new V3ContractViolation('v3 archive: 需要 store')
  if (host === null || typeof host !== 'object') throw new V3ContractViolation('v3 archive: 需要 host')
  const journal = intent !== null && typeof intent === 'object' ? intent : null

  async function recordsOf(recordIds) {
    const rows = []
    for (const id of recordIds) {
      try {
        rows.push(await store.readRecord(id))
      } catch (error) {
        return { ok: false, error }
      }
    }
    return { ok: true, rows }
  }

  async function plan({ sessionId, events, surfaceNodes, seqToRecordId, mode, retainOperations = 5, lastArchiveEndSeq = -1, maxOperations = 1, pinnedSeqs = new Set(), minStartSeq = -1, summary = false }) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) throw new V3ContractViolation('v3 archive: sessionId 必填')
    if (!(seqToRecordId instanceof Map)) throw new V3ContractViolation('v3 archive: seqToRecordId 必须是 Map')
    const span = selectArchiveSpan({
      surfaceNodes,
      events,
      mode,
      retainOperations,
      lastArchiveEndSeq,
      maxOperations,
      pinnedSeqs,
      minStartSeq,
      hasRecord: (seq) => seqToRecordId.has(seq),
    })
    if (span === null) return null
    return await makePlan(span, { summary, seqToRecordId })
  }

  /**
   * span → 回执计划（回合级与步骤级共用）。
   * 净收益门槛在这里只有一处：回执本身也是上下文税，小段（回执比原文长）归档会让占用变大。
   */
  async function makePlan(span, { summary = false, seqToRecordId } = {}) {
    const recordIds = span.recordSeqs.map((seq) => seqToRecordId.get(seq))
    if (recordIds.some((id) => typeof id !== 'string' || id.length === 0)) return null
    const loaded = await recordsOf(recordIds)
    if (!loaded.ok) return { status: 'failed', reason: 'record-read-failed', error: loaded.error, span, recordIds }
    const summaryText = summary === true ? summarizeRecords(loaded.rows) : ''
    const receiptText = renderArchiveReceipt({ startSeq: span.startSeq, endSeq: span.endSeq, recordIds, operations: span.operations, summary: summaryText })
    const sourceChars = loaded.rows.reduce((sum, row) => sum + textOfRecord(row).length, 0)
    if (sourceChars > 0 && receiptText.length >= sourceChars) {
      return { status: 'not-worth', span, recordIds, receiptText, sourceChars, receiptChars: receiptText.length }
    }
    return { ...span, recordIds, receiptText, summaryText }
  }

  /**
   * 步骤级计划（普通降温 / 实时压缩）：在当前回合内压已完成步骤。
   * 与回合级共用回执与净收益口径，只是候选选择换成 steps.mjs。
   */
  async function planSteps({ sessionId, events, surfaceNodes, seqToRecordId, retainSteps = 4, maxSteps = 3, pinnedSeqs = new Set(), summary = false } = {}) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) throw new V3ContractViolation('v3 archive: sessionId 必填')
    if (!(seqToRecordId instanceof Map)) throw new V3ContractViolation('v3 archive: seqToRecordId 必须是 Map')
    const span = selectStepSpan({
      surfaceNodes,
      events,
      retainSteps,
      maxSteps,
      pinnedSeqs,
      hasRecord: (seq) => seqToRecordId.has(seq),
    })
    if (span === null) return null
    return await makePlan(span, { summary, seqToRecordId })
  }

  /** 只预览，不触碰 surface/store。 */
  async function dryRun(input) {
    const planned = await plan(input)
    if (planned === null) return { status: 'no-candidate' }
    return { status: planned.status ?? 'planned', ...planned }
  }

  /** 执行一次归档；失败绝不推进 state。 */
  async function archiveOnce({ sessionId, events, surfaceNodes, seqToRecordId, mode, retainOperations = 5, lastArchiveEndSeq = -1, maxOperations = 1, pinnedSeqs = new Set(), minStartSeq = -1, summary = false, txn = 1 }) {
    const planned = await plan({ sessionId, events, surfaceNodes, seqToRecordId, mode, retainOperations, lastArchiveEndSeq, maxOperations, pinnedSeqs, minStartSeq, summary })
    return await commitPlanned({ sessionId, planned, txn })
  }

  /**
   * 执行一次**步骤级**归档（普通降温 / 实时压缩）：当前回合内已完成步骤。
   * 与回合级共用宿主 range replace、voucher 与失败语义；不推进 lastArchiveEndSeq
   * （那是回合级位点，步骤级用磁盘上的真实节点判幂等，重复压缩不会重复计费）。
   */
  async function archiveStepOnce({ sessionId, events, surfaceNodes, seqToRecordId, retainSteps = 4, maxSteps = 3, pinnedSeqs = new Set(), summary = false, txn = 1 } = {}) {
    const planned = await planSteps({ sessionId, events, surfaceNodes, seqToRecordId, retainSteps, maxSteps, pinnedSeqs, summary })
    return await commitPlanned({ sessionId, planned, txn })
  }

  /** 落面 + 记 voucher（失败保留 intent，绝不假装成功）。 */
  async function commitPlanned({ sessionId, planned, txn = 1 }) {
    if (planned === null) return { status: 'no-candidate' }
    if (planned.status === 'failed' || planned.status === 'not-worth') return planned
    const intent = {
      schemaVersion: 1,
      sessionId,
      startSeq: planned.startSeq,
      endSeq: planned.endSeq,
      sourceEventSeqs: [...planned.sourceEventSeqs],
      recordIds: [...planned.recordIds],
      receiptText: planned.receiptText,
      createdAt: clock.now(),
    }
    if (journal?.write !== undefined) await journal.write(intent)
    let receiptSeq
    try {
      const confirmation = await host.surfaceOp({
        op: 'replace',
        startSeq: planned.startSeq,
        endSeq: planned.endSeq,
        sourceEventSeqs: planned.sourceEventSeqs,
        text: planned.receiptText,
      })
      receiptSeq = confirmation?.seq
      if (!Number.isInteger(receiptSeq) || receiptSeq < 1) throw new V3ContractViolation('v3 archive: 宿主未返回 receipt seq')
    } catch (error) {
      if (journal?.clear !== undefined) await journal.clear().catch(() => {})
      return { status: 'failed', phase: 'surface', error, span: planned }
    }
    try {
      await store.appendVoucher({
        schemaVersion: 2,
        voucherId: 'v-' + receiptSeq,
        kind: 'span',
        recordIds: planned.recordIds,
        sourceEventSeqs: planned.sourceEventSeqs,
        startSeq: planned.startSeq,
        endSeq: planned.endSeq,
        targetEventId: receiptSeq,
        receiptText: planned.receiptText,
        summaryText: planned.summaryText ?? '',
        txn: Number.isInteger(txn) && txn >= 1 ? txn : 1,
      })
    } catch (error) {
      // 保留 intent：下个 pre-step 可按 receiptText 找到 surface 节点补 voucher。
      return { status: 'failed', phase: 'voucher', error, receiptSeq, span: planned }
    }
    if (journal?.clear !== undefined) await journal.clear().catch(() => {})
    return {
      status: 'archived',
      receiptSeq,
      startSeq: planned.startSeq,
      endSeq: planned.endSeq,
      recordIds: planned.recordIds,
      receiptText: planned.receiptText,
      operations: planned.operations,
      steps: Number.isInteger(planned.steps) ? planned.steps : undefined,
    }
  }

  /**
   * 崩溃对账：intent 在、surface 上能找到同正文节点 → 补 voucher；
   * 找不到 → 清 intent（不推进 state）。返回是否做了修复。
   */
  async function recoverIntent({ sessionId, surfaceNodes, surfaceTextOf } = {}) {
    if (typeof surfaceTextOf !== 'function') return { recovered: false }
    const intent = journal?.read === undefined ? null : await journal.read().catch(() => null)
    if (intent === null || typeof intent !== 'object') return { recovered: false }
    let receiptSeq = null
    for (const seq of surfaceNodes ?? []) {
      if (!Number.isInteger(seq) || seq <= intent.endSeq) continue
      const text = await surfaceTextOf(seq)
      if (text === intent.receiptText) { receiptSeq = seq; break }
    }
    if (receiptSeq === null) {
      if (journal?.clear !== undefined) await journal.clear().catch(() => {})
      return { recovered: false, cleared: true }
    }
    try {
      await store.appendVoucher({
        schemaVersion: 2,
        voucherId: 'v-' + receiptSeq,
        kind: 'span',
        recordIds: intent.recordIds,
        sourceEventSeqs: intent.sourceEventSeqs,
        startSeq: intent.startSeq,
        endSeq: intent.endSeq,
        targetEventId: receiptSeq,
        receiptText: intent.receiptText,
        txn: 1,
      })
    } catch {
      return { recovered: false, kept: true, receiptSeq }
    }
    if (journal?.clear !== undefined) await journal.clear().catch(() => {})
    return { recovered: true, receiptSeq, endSeq: intent.endSeq }
  }

  const REDACTED_RECEIPT = '[记忆上下文] 该回执涉及已遗忘记录，摘要已清除；原文不可恢复。'

async function replaceVoucherReceipt(index, expected, next) {
    const vouchers = store.listVouchers()
    const voucher = vouchers[index]
    if (voucher === undefined) return { changed: false, reason: 'voucher-not-found' }
    if (typeof host.surfaceNodes !== 'function' || typeof host.surfaceTextAt !== 'function') {
      return { changed: false, reason: 'host-no-surface-text' }
    }
    // 单节点 replace 会生成新 seq；凭证里的 targetEventId 只在首次落面时有效。
    // 以「表面正文逐字节相等」定位当前节点，避免用过期 seq 覆盖错节点。
    let targetSeq = null
    for (const seq of await host.surfaceNodes()) {
      if (await host.surfaceTextAt(seq) === expected) { targetSeq = seq; break }
    }
    if (targetSeq === null) return { changed: false, reason: 'receipt-changed' }
    try {
      await host.surfaceOp({ op: 'replace', targetEventId: targetSeq, text: next })
      return { changed: true }
    } catch (error) {
      return { changed: false, reason: 'surface-rejected', error }
    }
  }

  /** 遗忘级联：把含已遗忘记录的回执替换成不含正文的标记（可 undo 还原）。 */
  async function redactVoucher(index) {
    const voucher = store.listVouchers()[index]
    if (voucher === undefined) return { changed: false, reason: 'voucher-not-found' }
    return await replaceVoucherReceipt(index, voucher.receiptText, REDACTED_RECEIPT)
  }

  async function unredactVoucher(index) {
    const voucher = store.listVouchers()[index]
    if (voucher === undefined) return { changed: false, reason: 'voucher-not-found' }
    return await replaceVoucherReceipt(index, REDACTED_RECEIPT, voucher.receiptText)
  }

  /** 恢复一个凭证：正文逐字节相等 + 限制长度，失败关闭。 */
  async function restoreVoucher(index, { maxChars = 16000 } = {}) {
    let vouchers
    try { vouchers = store.listVouchers() } catch (error) { return { restored: false, reason: 'vouchers-unreadable', error } }
    const voucher = vouchers[index]
    if (voucher === undefined) return { restored: false, reason: 'voucher-not-found' }
    if (!Number.isInteger(voucher.targetEventId) || voucher.targetEventId < 1) {
      return { restored: false, reason: 'not-a-span-voucher' }
    }
    if (typeof host.surfaceNodes !== 'function' || typeof host.surfaceTextAt !== 'function') {
      return { restored: false, reason: 'host-no-surface-text' }
    }
    let targetSeq = null
    for (const seq of await host.surfaceNodes()) {
      if (await host.surfaceTextAt(seq) === voucher.receiptText) { targetSeq = seq; break }
    }
    if (targetSeq === null) return { restored: false, reason: 'receipt-changed' }
    const loaded = await recordsOf(voucher.recordIds)
    if (!loaded.ok) return { restored: false, reason: 'record-read-failed', error: loaded.error }
    const text = loaded.rows.map(textOfRecord).filter((part) => part.length > 0).join('\n\n')
    if (text.length === 0) return { restored: false, reason: 'no-restorable-text' }
    if (text.length > maxChars) return { restored: false, reason: 'restore-too-large', chars: text.length, maxChars }
    try {
      const confirmation = await host.surfaceOp({ op: 'replace', targetEventId: targetSeq, text })
      return { restored: true, seq: confirmation?.seq, chars: text.length, voucherIndex: index }
    } catch (error) {
      return { restored: false, reason: 'surface-rejected', error }
    }
  }

  async function restoreAll({ maxChars = 16000 } = {}) {
    let vouchers
    try { vouchers = store.listVouchers() } catch (error) { return { restored: 0, skipped: 0, total: 0, rows: [], error } }
    const rows = []
    for (let index = 0; index < vouchers.length; index += 1) {
      const result = await restoreVoucher(index, { maxChars })
      rows.push({ index, ...result })
    }
    return {
      total: rows.length,
      restored: rows.filter((row) => row.restored === true).length,
      skipped: rows.filter((row) => row.restored !== true).length,
      rows,
    }
  }

  function history() {
    let vouchers
    try { vouchers = store.listVouchers() } catch (error) { return { error } }
    return {
      total: vouchers.length,
      rows: vouchers.map((voucher, index) => ({
        index,
        targetEventId: voucher.targetEventId,
        startSeq: voucher.startSeq ?? null,
        endSeq: voucher.endSeq ?? null,
        recordIds: Array.isArray(voucher.recordIds) ? [...voucher.recordIds] : [],
        chars: typeof voucher.receiptText === 'string' ? voucher.receiptText.length : 0,
        summary: typeof voucher.summaryText === 'string' && voucher.summaryText.length > 0,
      })),
    }
  }

  return { plan, planSteps, dryRun, archiveOnce, archiveStepOnce, recoverIntent, redactVoucher, unredactVoucher, restoreVoucher, restoreAll, history }
}