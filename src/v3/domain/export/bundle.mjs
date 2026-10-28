/**
 * 本地红导出（M5 分享面，纯函数）。
 *
 * 只导出**已摄入的正文与凭证**，不导出工具参数原文以外的宿主事件；
 * 正文在摄入时已过脱敏。遗忘记录不导出正文，只保留 ID（隐私面）。
 */
import { V3ContractViolation } from '../../contracts/errors.mjs'

export const EXPORT_SCHEMA_VERSION = 1

export function buildExportBundle({ sessionKey, exportedAt = Date.now(), records = [], forgotten = [], vouchers = [], state = null } = {}) {
  if (typeof sessionKey !== 'string' || sessionKey.trim().length === 0) {
    throw new V3ContractViolation('v3 export: sessionKey 必填')
  }
  if (!Array.isArray(records) || !Array.isArray(forgotten) || !Array.isArray(vouchers)) {
    throw new V3ContractViolation('v3 export: records/forgotten/vouchers 必须是数组')
  }
  const forgottenSet = new Set(forgotten.filter((id) => typeof id === 'string'))
  const exportedRecords = []
  for (const record of records) {
    if (record === null || typeof record !== 'object') continue
    if (typeof record.id !== 'string') continue
    if (forgottenSet.has(record.id)) continue // 已遗忘正文一律不导出
    exportedRecords.push({
      id: record.id,
      kind: record.kind,
      createdAt: record.createdAt,
      payload: { text: record.payload?.text ?? '', bytes: record.payload?.bytes ?? 0 },
      provenance: {
        sourceEventId: record.provenance?.sourceEventId ?? null,
        sourceForm: record.provenance?.sourceForm ?? null,
        transactionId: record.provenance?.transactionId ?? null,
      },
    })
  }
  return {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    sessionKey,
    exportedAt,
    counts: {
      records: exportedRecords.length,
      forgotten: forgottenSet.size,
      vouchers: vouchers.length,
      omittedForgotten: records.length - exportedRecords.length,
    },
    records: exportedRecords,
    forgotten: [...forgottenSet],
    vouchers: vouchers.map((voucher) => ({ ...voucher })),
    state: state === null ? null : structuredClone(state),
  }
}

export function exportFilenameOf(sessionKey, exportedAt = Date.now()) {
  const safe = String(sessionKey).replace(/[^\w.-]/g, '_').slice(0, 80)
  return safe + '-' + exportedAt + '.json'
}