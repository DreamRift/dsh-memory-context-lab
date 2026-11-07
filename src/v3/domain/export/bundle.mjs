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
import { summaryIntegrityOf } from '../compress/summary-artifact.mjs'
import { redactText, redactValue } from '../security/redact.mjs'

export const EXPORT_SCHEMA_VERSION = 1

/**
 * 摘要工件的自由文本字段（S-09，0.15.4）。
 *
 * 与 `domain/compress/summary-artifact.mjs` 的 `DRAFT_FIELDS` 同源：
 * - 单值字段：`shortText` / `detail` / `goal`；
 * - 列表字段：`changes` / `decisions` / `openItems` / `evidenceRefs`；
 * - **不是**自由文本：`outcome`（枚举，`SUMMARY_OUTCOMES` 之一）、`sourceSpans`（数值区间）。
 *
 * 旧导出实现手写枚举了六项，漏了 `evidenceRefs`（明文出境）与 `outcome`。
 * `outcome` 本身是枚举不泄密，但仍按「清单之外一律过脱敏」兜底——
 * 这样将来把 `outcome` 改成自由文本时不会静默开口子。
 */
const SUMMARY_FREE_TEXT_FIELDS = Object.freeze(['shortText', 'detail', 'goal'])
const SUMMARY_FREE_TEXT_LIST_FIELDS = Object.freeze(['changes', 'decisions', 'openItems', 'evidenceRefs'])

export function buildExportBundle({ sessionKey, exportedAt = Date.now(), records = [], forgotten = [], vouchers = [], redactedVoucherIds = [], summaries = [], state = null, sha256 = null } = {}) {
  if (typeof sessionKey !== 'string' || sessionKey.trim().length === 0) {
    throw new V3ContractViolation('v3 export: sessionKey 必填')
  }
  if (!Array.isArray(records) || !Array.isArray(forgotten) || !Array.isArray(vouchers) || !Array.isArray(summaries)) {
    throw new V3ContractViolation('v3 export: records/forgotten/vouchers/summaries 必须是数组')
  }
  const forgottenSet = new Set(forgotten.filter((id) => typeof id === 'string'))
  const redactedSet = new Set(redactedVoucherIds.filter((id) => typeof id === 'string'))
  const exportedRecords = []
  // S-12（0.15.4）：分别精确计数，不再用「输入数 − 导出数」倒推。
  //
  // 旧实现只有 `omittedForgotten: records.length - exportedRecords.length` 一个数，
  // 而这个差值把**两类完全不同的原因**混在一起：
  // - 真的被 forgot 掉的记录（隐私面，应当如实计入 forgotten）；
  // - 形状非法、根本不该导出的记录（数据损坏，不是「已遗忘」）。
  // 实测 4 条输入里 2 条非法 → 报「2 条已遗忘」，把损坏伪装成了遗忘——
  // 用户据此会以为「这些内容是我主动删的」，而实际是数据坏了、需要修。
  let invalidRecords = 0
  let forgottenOmitted = 0
  for (const record of records) {
    if (record === null || typeof record !== 'object' || typeof record.id !== 'string') {
      invalidRecords += 1
      continue
    }
    if (forgottenSet.has(record.id)) {
      forgottenOmitted += 1
      continue
    }
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
  // P4（§7.4 R10）：详细摘要也是自有出口。来源含已忘记录的摘要**整条隐藏**
  // （只留 ID 与原因），可见摘要的正文再脱敏一次——与记录同一道分享闸。
  const exportedSummaries = summaries.map((artifact) => {
    const sources = Array.isArray(artifact?.sources) ? artifact.sources : []
    // 损坏/篡改的摘要行无法判定来源：整条隐藏（失败关闭，不让未知来源的正文进分享包）。
    if (artifact === null || typeof artifact !== 'object' || !Array.isArray(artifact.sources)
      || typeof artifact.shortText !== 'string' || typeof artifact.detail !== 'string') {
      return { summaryId: typeof artifact?.summaryId === 'string' ? artifact.summaryId : null, hidden: true, reason: 'summary-invalid' }
    }
    // P2-4：导出路径必须用 sources 重算指纹并与落盘值对账。hash 不可用（未注入）
    // 同样按不可信隐藏——失败关闭，不把「验不了」当成「没问题」。
    const integrity = summaryIntegrityOf(artifact, sha256)
    if (integrity.ok !== true) return { summaryId: artifact?.summaryId ?? null, hidden: true, reason: integrity.reason }
    const hidden = sources.some((source) => forgottenSet.has(source?.recordId))
    if (hidden) return { summaryId: artifact?.summaryId ?? null, hidden: true, reason: 'forgotten-source' }
    // S-09（0.15.4）：自由文本字段**按清单统一脱敏**，不再逐个手写。
    //
    // 缺陷：旧实现列了 shortText/detail/goal/changes/decisions/openItems 六项，
    // 漏掉 `outcome` 与 `evidenceRefs` 两个同样自由的文本字段——它们直接明文出境。
    // 手写枚举的失败模式就是「加字段的人不知道这里还有一处要改」，
    // 所以改成「清单 + 派生」：新增自由文本字段时只改清单。
    const copy = { ...artifact }
    for (const key of SUMMARY_FREE_TEXT_FIELDS) {
      copy[key] = redactText(typeof artifact?.[key] === 'string' ? artifact[key] : '')
    }
    for (const key of SUMMARY_FREE_TEXT_LIST_FIELDS) {
      copy[key] = Array.isArray(artifact?.[key]) ? artifact[key].map((item) => redactText(String(item))) : []
    }
    // 其余未被清单覆盖的字符串字段（未来新增的）也要保全：**失败关闭**——
    // 宁可多脱敏，也不让一个没登记的自由文本字段悄悄明文出境。
    for (const [key, value] of Object.entries(artifact)) {
      if (SUMMARY_FREE_TEXT_FIELDS.includes(key)) continue
      if (SUMMARY_FREE_TEXT_LIST_FIELDS.includes(key)) continue
      if (typeof value === 'string') copy[key] = redactText(value)
      else if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
        copy[key] = value.map((item) => redactText(item))
      }
    }
    return { ...copy, hidden: false }
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
      // S-12：`omittedForgotten` 只算真的被 forgot 掉的；损坏/形状非法的单独计数。
      omittedForgotten: forgottenOmitted,
      invalidRecords,
      summaries: exportedSummaries.length,
      hiddenSummaries: exportedSummaries.filter((summary) => summary.hidden === true).length,
    },
    records: exportedRecords,
    forgotten: [...forgottenSet],
    vouchers: exportedVouchers,
    summaries: exportedSummaries,
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