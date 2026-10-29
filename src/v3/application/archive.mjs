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
import { restoreEligibilityOf, settleRestore } from '../domain/archive/restore.mjs'
import { selectArchiveSpan } from '../domain/archive/candidates.mjs'
import { selectStepSpan } from '../domain/archive/steps.mjs'
import { summarizeRecords } from '../domain/compress/summary.mjs'

function textOfRecord(record) {
  if (record === null || typeof record !== 'object') return ''
  const text = record.payload?.text ?? record.text
  return typeof text === 'string' ? text : ''
}

/**
 * 恢复正文渲染（B-1 A，0.14.0-beta.48）：正文 + 确定性「工具调用」块。
 *
 * 归档恢复的承诺是「可按 ID 回读」，而 assistant 的工具调用参数不在 text 里
 * （旧实现 27/27 凭证、81 次调用、105,975 字参数不可恢复）。摄入侧已把调用块
 * 脱敏后写进 payload.structure.toolCalls；这里只渲染，不重新解释、不二次脱敏。
 * textOfRecord 本身保持原样——sourceChars 与 not-worth 判据不变。
 */
function toolCallsTextOf(structure) {
  const calls = structure?.toolCalls
  if (!Array.isArray(calls) || calls.length === 0) return ''
  const lines = []
  for (const call of calls) {
    const name = typeof call?.name === 'string' && call.name.length > 0 ? call.name : 'unknown'
    const callId = typeof call?.callId === 'string' ? call.callId : ''
    let argsText = ''
    try {
      argsText = typeof call?.arguments === 'string' ? call.arguments : JSON.stringify(call?.arguments ?? {})
    } catch {
      argsText = '[不可序列化参数]'
    }
    lines.push('· ' + name + (callId.length > 0 ? '(' + callId + ')' : '') + ' ' + argsText)
  }
  return '[工具调用]\n' + lines.join('\n')
}

function restoreTextOfRecord(record) {
  const text = textOfRecord(record)
  const calls = toolCallsTextOf(record?.payload?.structure)
  if (calls.length === 0) return text
  return text.length > 0 ? text + '\n\n' + calls : calls
}

/**
 * 「没有候选」也是一个**结果**，不是空值（0.14.0-beta.45，AUD-09 附带项）：
 * 带上选择器给的 reason，status 才能说清是当前回合 / 工作集 / pin / 无记录 / 未完成工具对，
 * 而不是只印一句「暂无可归档」，让用户只能靠反推。
 */
function noCandidate(rejection) {
  const reason = typeof rejection?.reason === 'string' && rejection.reason.length > 0 ? rejection.reason : 'no-candidate'
  return { ...(rejection ?? {}), status: 'no-candidate', reason }
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

  async function plan({ sessionId, events, surfaceNodes, seqToRecordId, mode, retainOperations = 5, lastArchiveEndSeq = -1, maxOperations = 1, pinnedSeqs = new Set(), minStartSeq = -1, turnBasis = 'human', currentTurn = null, summary = false }) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) throw new V3ContractViolation('v3 archive: sessionId 必填')
    if (!(seqToRecordId instanceof Map)) throw new V3ContractViolation('v3 archive: seqToRecordId 必须是 Map')
    // 拒绝原因（AUD-09 附带项）：选择器只回 null，原因经 onReject 带出，供 status 直读。
    let rejection = null
    const span = selectArchiveSpan({
      surfaceNodes,
      events,
      mode,
      retainOperations,
      lastArchiveEndSeq,
      maxOperations,
      pinnedSeqs,
      minStartSeq,
      turnBasis,
      currentTurn,
      hasRecord: (seq) => seqToRecordId.has(seq),
      onReject: (row) => { rejection = rejection ?? row },
    })
    if (span === null) return noCandidate(rejection)
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
  async function planSteps({ sessionId, events, surfaceNodes, seqToRecordId, retainSteps = 4, maxSteps = 3, pinnedSeqs = new Set(), minStartSeq = -1, summary = false } = {}) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) throw new V3ContractViolation('v3 archive: sessionId 必填')
    if (!(seqToRecordId instanceof Map)) throw new V3ContractViolation('v3 archive: seqToRecordId 必须是 Map')
    let rejection = null
    const span = selectStepSpan({
      surfaceNodes,
      events,
      retainSteps,
      maxSteps,
      pinnedSeqs,
      minStartSeq,
      hasRecord: (seq) => seqToRecordId.has(seq),
      onReject: (row) => { rejection = rejection ?? row },
    })
    if (span === null) return noCandidate(rejection)
    return await makePlan(span, { summary, seqToRecordId })
  }

  /** 只预览，不触碰 surface/store。 */
  async function dryRun(input) {
    const planned = await plan(input)
    if (planned === null) return { status: 'no-candidate', reason: 'no-candidate' }
    return { status: planned.status ?? 'planned', ...planned }
  }

  /** 执行一次归档；失败绝不推进 state。 */
  async function archiveOnce({ sessionId, events, surfaceNodes, seqToRecordId, mode, retainOperations = 5, lastArchiveEndSeq = -1, maxOperations = 1, pinnedSeqs = new Set(), minStartSeq = -1, turnBasis = 'human', currentTurn = null, summary = false, txn = 1 }) {
    const planned = await plan({ sessionId, events, surfaceNodes, seqToRecordId, mode, retainOperations, lastArchiveEndSeq, maxOperations, pinnedSeqs, minStartSeq, turnBasis, currentTurn, summary })
    return await commitPlanned({ sessionId, planned, txn, mode: mode === 'cooling' ? 'cooling' : 'full-history' })
  }

  /**
   * 执行一次**步骤级**归档（普通降温 / 实时压缩）：当前回合内已完成步骤。
   * 与回合级共用宿主 range replace、voucher 与失败语义；不推进 lastArchiveEndSeq
   * （那是回合级位点，步骤级用磁盘上的真实节点判幂等，重复压缩不会重复计费）。
   */
  async function archiveStepOnce({ sessionId, events, surfaceNodes, seqToRecordId, retainSteps = 4, maxSteps = 3, pinnedSeqs = new Set(), minStartSeq = -1, summary = false, txn = 1 } = {}) {
    const planned = await planSteps({ sessionId, events, surfaceNodes, seqToRecordId, retainSteps, maxSteps, pinnedSeqs, minStartSeq, summary })
    return await commitPlanned({ sessionId, planned, txn, mode: 'cooling' })
  }

  /** 落面 + 记 voucher（失败保留 intent，绝不假装成功）。 */
  async function commitPlanned({ sessionId, planned, txn = 1, mode = 'full-history' }) {
    if (planned === null) return { status: 'no-candidate', reason: 'no-candidate' }
    // no-candidate 现在带 reason（选择器拒绝原因），必须原样透传，不能在这里重新拼成空对象。
    if (planned.status === 'no-candidate' || planned.status === 'failed' || planned.status === 'not-worth') return planned
    const intent = {
      schemaVersion: 1,
      sessionId,
      // C-D（0.14.0-beta.48）：崩溃恢复必须知道是回合级还是步骤级——按步归档的
      // 恢复绝不能写 lastArchiveEndSeq（那会成为回合级选择的永久下限）。
      mode: mode === 'cooling' ? 'cooling' : 'full-history',
      // C-E：凭证事务号随 intent 落盘（旧实现恢复时硬编码 txn:1，对账回溯对不上）。
      txn: Number.isInteger(txn) && txn >= 1 ? txn : 1,
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
      // 宿主可能**已经 append 成功、只是确认面失败**（dsh-host 的 surfaceOp 在 appendReceipt
      // 之后才校验 eventAt/被遮蔽节点，失败就抛）。旧实现把这个 catch 当成「surface 没变」
      // 并清掉 intent，于是活动面留下一条回执、凭证账本却没有它，而对账线索也被删掉——
      // 恢复面永远找不到这条回执（审计 C-A：history=0、vouchers=0、intent 已清）。
      // 保留 intent 交给 recoverIntent：找得到同正文节点就补 voucher，找不到就清，
      // 两种结局都安全，且不需要假设「replace 失败 = surface 不变」。
      return { status: 'failed', phase: 'surface', error, span: planned, intentKept: journal?.clear !== undefined }
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
    // C-D：恢复必须按 intent 里记录的模式落 state（旧版 intent 没有 mode → 回合级）。
    const mode = intent.mode === 'cooling' ? 'cooling' : 'full-history'
    const nodes = (surfaceNodes ?? []).filter((seq) => Number.isInteger(seq) && seq > intent.endSeq)
    const receiptSeq = await firstEligibleSeq(nodes, intent.receiptText, surfaceTextOf)
    if (receiptSeq === null) {
      if (journal?.clear !== undefined) await journal.clear().catch(() => {})
      return { recovered: false, cleared: true, mode }
    }
    // 幂等（审计 C-C）：崩溃窗口「voucher 已追加、intent 未清」会重进这里。
    // 旧实现无条件再追加一次，同一 receiptSeq 产生两条同 ID 凭证（v-4 / v-4），
    // history 与 restoreAll 的条数、下标全部失真。已有同 ID 凭证就只清 intent。
    let duplicateSkipped = false
    try {
      duplicateSkipped = store.listVouchers().some((voucher) => voucher?.voucherId === 'v-' + receiptSeq)
      if (!duplicateSkipped) {
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
          // C-E：用 intent 里的事务号（旧版 intent 没有 txn → 1，与旧行为一致）。
          txn: Number.isInteger(intent.txn) && intent.txn >= 1 ? intent.txn : 1,
        })
      }
    } catch {
      return { recovered: false, kept: true, receiptSeq, mode }
    }
    if (journal?.clear !== undefined) await journal.clear().catch(() => {})
    return { recovered: true, receiptSeq, endSeq: intent.endSeq, mode, duplicateSkipped }
  }

  /**
   * 恢复资格只有一个实现（D-E）：domain 的 restoreEligibilityOf 是唯一判据，
   * 归档服务不再自己写一套「逐字节相等」的循环。返回首个合格节点的 seq。
   */
  async function firstEligibleSeq(nodes, expected, textAt) {
    for (const seq of nodes) {
      if (!Number.isInteger(seq)) continue
      const surfaceText = await textAt(seq)
      if (restoreEligibilityOf({ receiptText: expected, surfaceText }).eligible) return seq
    }
    return null
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
    const targetSeq = await firstEligibleSeq(await host.surfaceNodes(), expected, (seq) => host.surfaceTextAt(seq))
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
    const result = await replaceVoucherReceipt(index, voucher.receiptText, REDACTED_RECEIPT)
    if (result.changed === true) {
      // D-C：持久标记（history 同步读取；不依赖宿主活动面）。标记失败不影响本次清除事实。
      if (typeof store.markVoucherRedacted === 'function') {
        await store.markVoucherRedacted(voucher.voucherId, true).catch(() => {})
      }
    }
    return result
  }

  async function unredactVoucher(index) {
    const voucher = store.listVouchers()[index]
    if (voucher === undefined) return { changed: false, reason: 'voucher-not-found' }
    const result = await replaceVoucherReceipt(index, REDACTED_RECEIPT, voucher.receiptText)
    if (result.changed === true) {
      if (typeof store.markVoucherRedacted === 'function') {
        await store.markVoucherRedacted(voucher.voucherId, false).catch(() => {})
      }
    }
    return result
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
    const targetSeq = await firstEligibleSeq(await host.surfaceNodes(), voucher.receiptText, (seq) => host.surfaceTextAt(seq))
    if (targetSeq === null) return { restored: false, reason: 'receipt-changed' }
    const loaded = await recordsOf(voucher.recordIds)
    if (!loaded.ok) {
      // D-B：已遗忘与「读失败」必须分开记账（旧实现只表现为 record-read-failed）。
      const reason = loaded.error?.code === 'EFORGOTTEN' ? 'record-forgotten' : 'record-read-failed'
      return { restored: false, reason, error: loaded.error }
    }
    const text = loaded.rows.map(restoreTextOfRecord).filter((part) => part.length > 0).join('\n\n')
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
    try { vouchers = store.listVouchers() } catch (error) { return { restored: 0, skipped: 0, forgotten: 0, total: 0, rows: [], error } }
    const rows = []
    for (let index = 0; index < vouchers.length; index += 1) {
      const result = await restoreVoucher(index, { maxChars })
      rows.push({ index, ...result })
    }
    // D-B：会计走 N-11 三桶——restored + skipped + forgotten === total，
    // 已遗忘记录不再混进「跳过」，让 status/命令面能说清「为什么没恢复」。
    const settled = settleRestore(rows.map((row) => ({
      outcome: row.restored === true ? 'restored' : (row.reason === 'record-forgotten' ? 'forgotten' : 'skipped'),
      reason: row.restored === true ? undefined : row.reason,
    })))
    return {
      total: settled.total,
      restored: settled.restored,
      skipped: settled.skipped,
      forgotten: settled.forgotten,
      balanced: settled.balanced,
      rows,
    }
  }

  function history() {
    let vouchers
    try { vouchers = store.listVouchers() } catch (error) { return { error } }
    let redactedIds = new Set()
    try {
      redactedIds = new Set(typeof store.redactedVoucherIds === 'function' ? store.redactedVoucherIds() : [])
    } catch {
      // 标记账本损坏不阻断历史列表：只把 redacted 标为 null（未知），不伪造「未清除」。
      redactedIds = null
    }
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
        // D-C：隐私面已清除的回执在历史里必须看得出来（否则观察面以为它仍可恢复）。
        redacted: redactedIds === null ? null : redactedIds.has(voucher.voucherId),
      })),
    }
  }

  return { plan, planSteps, dryRun, archiveOnce, archiveStepOnce, recoverIntent, redactVoucher, unredactVoucher, restoreVoucher, restoreAll, history }
}