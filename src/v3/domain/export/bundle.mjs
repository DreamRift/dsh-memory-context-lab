/**
 * 本地红导出（M5 分享面，纯函数）。
 *
 * 只导出**已摄入的正文与凭证**，不导出工具参数原文以外的宿主事件；
 * 正文在摄入时已过脱敏。遗忘记录不导出正文，只保留 ID（隐私面）；
 * 已遗忘/已清除凭证的 receiptText/summaryText 同样剥离（AUD48-08-02），
 * metaOnly/metaReason/structure 随记录保留（AUD48-08-03）。
 */
import { V3ContractViolation } from '../../contracts/errors.mjs'

export const EXPORT_SCHEMA_VERSION = 1

export function buildExportBundle({ sessionKey, exportedAt = Date.now(), records = [], forgotten = [], vouchers = [], redactedVoucherIds = [], state = null } = {}) {
  if (typeof sessionKey !== 'string' || sessionKey.trim().length === 0) {
    throw new V3ContractViolation('v3 export: sessionKey 必填')
  }
  if (!Array.isArray(records) || !Array.isArray(forgotten) || !Array.isArray(vouchers)) {
    throw new V3ContractViolation('v3 export: records/forgotten/vouchers 必须是数组')
  }
  const forgottenSet = new Set(forgotten.filter((id) => typeof id === 'string'))
  const redactedSet = new Set(redactedVoucherIds.filter((id) => typeof id === 'string'))
  const exportedRecords = []
  for (const record of records) {
    if (record === null || typeof record !== 'object') continue
    if (typeof record.id !== 'string') continue
    if (forgottenSet.has(record.id)) continue // 已遗忘正文一律不导出
    // AUD48-08-03：metaOnly / structure 是记录可读性与工具调用恢复的一部分，
    // 旧导出只留 text/bytes，导入后 metaOnly 变「空正文损坏」、工具参数丢失。
    const payload = { text: record.payload?.text ?? '', bytes: record.payload?.bytes ?? 0 }
    if (record.payload?.metaOnly === true) payload.metaOnly = true
    if (typeof record.payload?.metaReason === 'string') payload.metaReason = record.payload.metaReason
    if (record.payload?.structure !== null && typeof record.payload?.structure === 'object') {
      payload.structure = structuredClone(record.payload.structure)
    }
    exportedRecords.push({
      id: record.id,
      kind: record.kind,
      createdAt: record.createdAt,
      payload,
      provenance: {
        sourceEventId: record.provenance?.sourceEventId ?? null,
        sourceForm: record.provenance?.sourceForm ?? null,
        transactionId: record.provenance?.transactionId ?? null,
      },
    })
  }
  // AUD48-08-02：凭证的 receiptText/summaryText 可能含 compact 摘要（原文首部 ≤220 字）。
  // 记录被遗忘、或该凭证已在 redactions.jsonl 里清除时，导出包不得再带这些明文——
  // 只留 ID/序号，与 history 的「正文已清除」口径一致。
  const exportedVouchers = vouchers.map((voucher) => {
    const copy = { ...voucher }
    const recordIds = Array.isArray(voucher?.recordIds) ? voucher.recordIds : []
    const redacted = redactedSet.has(voucher?.voucherId) || recordIds.some((id) => forgottenSet.has(id))
    if (redacted) {
      copy.redacted = true
      copy.receiptText = ''
      copy.summaryText = ''
    }
    return copy
  })
  return {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    sessionKey,
    exportedAt,
    counts: {
      records: exportedRecords.length,
      forgotten: forgottenSet.size,
      vouchers: vouchers.length,
      redactedVouchers: exportedVouchers.filter((voucher) => voucher.redacted === true).length,
      omittedForgotten: records.length - exportedRecords.length,
    },
    records: exportedRecords,
    forgotten: [...forgottenSet],
    vouchers: exportedVouchers,
    state: state === null ? null : structuredClone(state),
  }
}

export function exportFilenameOf(sessionKey, exportedAt = Date.now()) {
  const safe = String(sessionKey).replace(/[^\w.-]/g, '_').slice(0, 80)
  return safe + '-' + exportedAt + '.json'
}