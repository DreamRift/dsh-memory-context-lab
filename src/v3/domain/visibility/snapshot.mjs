/**
 * 活动面快照归一化（domain/visibility，G6b）。
 *
 * ## 输入形状（**接线清单**即此形状，见证据文件 §接线清单）
 * ```text
 * {
 *   sessionKey,                       活动面所属会话（跨会话片段落 unknown/session-mismatch）
 *   nodes: [seq...],                  当前活动面节点（**不是** seq 升序：宿主 replace 是
 *                                     位置 splice、只有 append 才 push，归档后的活动面可以
 *                                     是 [5,2,3,4]；顺序不是判定输入，只要求唯一非负整数）
 *   events: [{seq, type, sourceForm, sourceKind, sourceEventSeqs, text}],
 *                                     宿主**原始**事件流（**不得**用 normalizeDshEvent 归一化：
 *                                     它拒 system/message、丢 sourceEventSeqs、把 type 换成
 *                                     v3 名）。覆盖范围 = 全部活动面节点 + 全部遮蔽目标
 *                                     （两跳恢复链要读 shadow(receiptSeq)，回执常已不在
 *                                     活动面上）——最省事的正确做法是直接传全量日志
 *   recordSeq: { [recordId]: seq|null },  记录来源事件 seq（凭证 provenance.sourceEventId → seq）
 *   vouchers: [{voucherId, recordIds, startSeq, endSeq, targetEventId}],
 *   forgotten: [recordId...],
 *   redactedVoucherIds: [voucherId...],
 *   archiveIntent: 'absent'|'pending'|'invalid'|'unreadable',
 *   recallRegistry: [{seq|null, bodyId|null, recordIds[]}] | null,   回注包登记（R-10 a）
 *   generations: {contentGeneration, replaceGeneration},             R-2 的可见性代际
 * }
 * ```
 *
 * ## 判定与拒绝的边界
 * 形状坏（活动面缺事件、节点 seq 重复、非整数 seq……）**不猜**：整份快照标
 * `unreadable`，判定全部落 `unknown`（R-1：unknown 按可见处理）。这样宿主面异常
 * 只会让去重失效（多注入），不会让去重误挡（少注入）。
 *
 * ## 两条结构纪律（R-7）
 * - `shadow(seq) = events()[seq].sourceEventSeqs ?? []`；
 * - `assistant/message` 不允许携带 `sourceEventSeqs`（P0 §2.2）：它的「遮蔽」一律
 *   忽略并计数——复述文本只能靠**直接节点命中**，不能当覆盖证据。
 */
/** 快照归一化失败的唯一原因（判定统一落 unknown）。 */
export const SURFACE_UNREADABLE = 'surface-unreadable'

/** 归档意图四态（与 adapters/storage/archive-intent.mjs 的 peekArchiveIntent 同名词）。 */
export const ARCHIVE_INTENT_STATES = Object.freeze(['absent', 'pending', 'invalid', 'unreadable'])

function isNonNegativeInt(value) {
  return Number.isSafeInteger(value) && value >= 0
}

/** 归一化结果：只有形状完全可读才 ok（否则调用方把片段全部判 unknown）。 */
export function normalizeVisibilitySnapshot(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: SURFACE_UNREADABLE }
  }
  if (!Array.isArray(raw.nodes) || !Array.isArray(raw.events)) {
    return { ok: false, reason: SURFACE_UNREADABLE }
  }
  const nodes = []
  const seenNodes = new Set()
  for (const seq of raw.nodes) {
    if (!isNonNegativeInt(seq)) return { ok: false, reason: SURFACE_UNREADABLE }
    // 重复 seq 不是合法活动面（同一节点不可能出现两次）→ 失败关闭。
    if (seenNodes.has(seq)) return { ok: false, reason: SURFACE_UNREADABLE }
    seenNodes.add(seq)
    nodes.push(seq)
  }
  // P1-1：顺序**不是**判定输入。真实宿主的活动面是位置语义——replace 用
  // nodes.splice(startIdx, len, seq) 在原位置插入、只有 append 才 push，归档后的活动面
  // 可以是 [5,2,3,4]（test/v3-archive-e2e.test.mjs:68 实测；P0 §2.2「数值可以倒序」；
  // dsh-host.mjs B3-11 同口径）。这里只归一成升序**规范形**（仅为摘要确定性）。
  const events = new Map()
  let ignoredShadows = 0
  for (const item of raw.events) {
    if (item === null || typeof item !== 'object' || !isNonNegativeInt(item.seq)) {
      return { ok: false, reason: SURFACE_UNREADABLE }
    }
    if (events.has(item.seq)) return { ok: false, reason: SURFACE_UNREADABLE }
    const type = typeof item.type === 'string' ? item.type : null
    let shadow = []
    if (Array.isArray(item.sourceEventSeqs)) {
      if (type === 'assistant/message') {
        ignoredShadows += 1
      } else {
        for (const source of item.sourceEventSeqs) {
          if (!isNonNegativeInt(source)) return { ok: false, reason: SURFACE_UNREADABLE }
          if (!shadow.includes(source)) shadow.push(source)
        }
      }
    } else if (item.sourceEventSeqs !== undefined && item.sourceEventSeqs !== null) {
      return { ok: false, reason: SURFACE_UNREADABLE }
    }
    events.set(item.seq, {
      seq: item.seq,
      type,
      sourceForm: typeof item.sourceForm === 'string' ? item.sourceForm : null,
      sourceKind: typeof item.sourceKind === 'string' ? item.sourceKind : null,
      shadow,
      text: typeof item.text === 'string' ? item.text : null,
    })
  }
  nodes.sort((a, b) => a - b)
  // 活动面节点必须有事件可读：读不到它的遮蔽链接就不能声称「未被覆盖」。
  const nodeSet = new Set(nodes)
  for (const seq of nodes) {
    if (!events.has(seq)) return { ok: false, reason: SURFACE_UNREADABLE }
  }
  const recordSeq = new Map()
  if (raw.recordSeq !== undefined && raw.recordSeq !== null) {
    if (typeof raw.recordSeq !== 'object' || Array.isArray(raw.recordSeq)) {
      return { ok: false, reason: SURFACE_UNREADABLE }
    }
    for (const [id, seq] of Object.entries(raw.recordSeq)) {
      if (seq === null) { recordSeq.set(id, null); continue }
      if (!isNonNegativeInt(seq)) return { ok: false, reason: SURFACE_UNREADABLE }
      recordSeq.set(id, seq)
    }
  }
  const forgotten = new Set()
  for (const id of Array.isArray(raw.forgotten) ? raw.forgotten : []) {
    if (typeof id !== 'string' || id.length === 0) return { ok: false, reason: SURFACE_UNREADABLE }
    forgotten.add(id)
  }
  const redacted = new Set()
  for (const id of Array.isArray(raw.redactedVoucherIds) ? raw.redactedVoucherIds : []) {
    if (typeof id !== 'string' || id.length === 0) return { ok: false, reason: SURFACE_UNREADABLE }
    redacted.add(id)
  }
  const vouchers = []
  const voucherByReceipt = new Map()
  for (const item of Array.isArray(raw.vouchers) ? raw.vouchers : []) {
    if (item === null || typeof item !== 'object' || typeof item.voucherId !== 'string') {
      return { ok: false, reason: SURFACE_UNREADABLE }
    }
    const recordIds = Array.isArray(item.recordIds)
      ? item.recordIds.filter((value) => typeof value === 'string')
      : []
    const voucher = {
      voucherId: item.voucherId,
      recordIds,
      startSeq: isNonNegativeInt(item.startSeq) ? item.startSeq : null,
      endSeq: isNonNegativeInt(item.endSeq) ? item.endSeq : null,
      targetEventId: isNonNegativeInt(item.targetEventId) ? item.targetEventId : null,
    }
    vouchers.push(voucher)
    if (voucher.targetEventId !== null) {
      // 同一 receiptSeq 只认第一张凭证（账本顺序即事实顺序；重复不叠加）。
      if (!voucherByReceipt.has(voucher.targetEventId)) voucherByReceipt.set(voucher.targetEventId, voucher)
    }
  }
  let registry = null
  if (raw.recallRegistry !== null && raw.recallRegistry !== undefined) {
    if (!Array.isArray(raw.recallRegistry)) return { ok: false, reason: SURFACE_UNREADABLE }
    registry = []
    for (const item of raw.recallRegistry) {
      if (item === null || typeof item !== 'object') return { ok: false, reason: SURFACE_UNREADABLE }
      const recordIds = Array.isArray(item.recordIds) ? item.recordIds.filter((value) => typeof value === 'string') : null
      if (recordIds === null) return { ok: false, reason: SURFACE_UNREADABLE }
      registry.push({
        seq: isNonNegativeInt(item.seq) ? item.seq : null,
        bodyId: typeof item.bodyId === 'string' && item.bodyId.length > 0 ? item.bodyId : null,
        recordIds,
      })
    }
  }
  // 归档意图：缺省/null 一律按「不可读」失败关闭（R-6）——不能把「没观测到」当成 absent。
  const rawIntent = raw.archiveIntent
  const archiveIntent = ARCHIVE_INTENT_STATES.includes(rawIntent) ? rawIntent : 'unreadable'
  const generations = {
    contentGeneration: isNonNegativeInt(raw.generations?.contentGeneration) ? raw.generations.contentGeneration : null,
    replaceGeneration: isNonNegativeInt(raw.generations?.replaceGeneration) ? raw.generations.replaceGeneration : null,
  }
  return {
    ok: true,
    snapshot: {
      normalized: true,
      sessionKey: typeof raw.sessionKey === 'string' && raw.sessionKey.length > 0 ? raw.sessionKey : null,
      nodes,
      nodeSet,
      events,
      recordSeq,
      forgotten,
      redacted,
      vouchers,
      voucherByReceipt,
      registry,
      archiveIntent,
      generations,
      ignoredShadows,
    },
  }
}

/** 已归一化的快照直接复用（判定函数可被多条路径调用，避免重复归一化）。 */
export function resolveVisibilitySnapshot(raw) {
  if (raw !== null && typeof raw === 'object' && raw.normalized === true) {
    return { ok: true, snapshot: raw }
  }
  return normalizeVisibilitySnapshot(raw)
}
