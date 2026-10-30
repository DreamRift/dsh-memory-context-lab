/**
 * 本地红导出（M5 分享面，纯函数）。
 *
 * 只导出**已摄入的正文与凭证**，不导出工具参数原文以外的宿主事件；
 * 正文与结构在导出时**再过一次脱敏**（AUD50-07-01，B2-10）：摄入只对 tool/result、
 * tool/call 脱敏，assistant/user 正文带明文入库是产品口径，导出是分享前的最后一道
 * 闸门，与摄入共用 domain/security/redact.mjs；导出文本因此可能与原文不同。
 * 遗忘记录不导出正文，只保留 ID（隐私面）；
 * 已遗忘/已清除凭证的 receiptText/summaryText 同样剥离（AUD48-08-02），
 * metaOnly/metaReason/structure 随记录保留（AUD48-08-03）。
 */
import { V3ContractViolation } from '../../contracts/errors.mjs'
import { redactText, redactValue } from '../security/redact.mjs'

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
    // AUD50-07-01：文本再脱敏；bytes 按导出文本重算（记录合同 bytes==UTF-8 字节长，
    // 导入侧 importRecords 也会按导入文本重建，两边保持同一口径）。
    const text = redactText(record.payload?.text ?? '')
    const payload = { text, bytes: Buffer.byteLength(text, 'utf8') }
    if (record.payload?.metaOnly === true) payload.metaOnly = true
    if (typeof record.payload?.metaReason === 'string') payload.metaReason = record.payload.metaReason
    if (record.payload?.structure !== null && typeof record.payload?.structure === 'object') {
      // 结构（toolCalls 参数）同样再脱敏；redactValue 递归文本值，键名不匹配敏感词时
      // 字符串值仍过 redactText（内嵌 JSON 引号键凭据的兜底，B1-1 同函数）。
      payload.structure = redactValue(structuredClone(record.payload.structure))
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
    // B2-10：明确「分享包已再脱敏」——文本可能与原文不同，不能当原文包用。
    exportPolicy: 'redacted',
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
    state: exportStateOf(state),
  }
}

/**
 * B3-22（AUD50-07-04）：导出 state 白名单——只留可解释的归档事实。
 * stateOf 透传的 path/exists/pins/readLease/provider 是本机运行态（audit-export-state
 * 实测导出 state 键含这些），分享包不携带；导入侧不消费 state（恢复凭证语义按
 * voucher index/recordIds 走，不依赖这份快照）。导入要恢复控制状态时另立白名单并
 * 在文档写明「包含控制状态」，默认最小化。
 */
function exportStateOf(state) {
  if (state === null || typeof state !== 'object') return null
  const surface = state.surface ?? null
  return {
    surface: {
      lastArchiveEndSeq: Number.isFinite(surface?.lastArchiveEndSeq) ? surface.lastArchiveEndSeq : null,
      lastArchiveAt: Number.isFinite(surface?.lastArchiveAt) ? surface.lastArchiveAt : null,
    },
  }
}


export function exportFilenameOf(sessionKey, exportedAt = Date.now()) {
  const safe = String(sessionKey).replace(/[^\w.-]/g, '_').slice(0, 80)
  return safe + '-' + exportedAt + '.json'
}