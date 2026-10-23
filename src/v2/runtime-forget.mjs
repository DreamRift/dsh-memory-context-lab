/**
 * v2 软遗忘域（0.13.1 P4b）。
 *
 * 从 `runtime.mjs` 摘出：这一域只依赖**五个**闭包能力，不碰 `records` 注册表，
 * 也不碰 engine。摘出后 `runtime.mjs` 少约 157 行，遗忘的表面撤回逻辑可以脱离
 * 运行时单测。
 *
 * ## 装配契约
 * `createForgetDomain({ factoryFor, nodeUnitBase, receiptTextOf, writeV2SessionState, getForgetIndex })`
 * 返回该域的全部函数；调用方负责解构使用。
 *
 * ## 依赖方向
 * 本域**不**依赖 engine，也**不**依赖 records：engine 的 `isForgottenRow` 回调由
 * runtime 直接组合 `getForgetIndex` 实现，不需要本域参与。命令分发
 * （`forgetCommand`）留在 runtime，因为要查 records 注册表。
 *
 * ## 不适用条件
 * 本模块不持有任何跨会话状态；每个函数都必须显式传入 `record`。
 * 表面撤回只作用于 `record.state.archive` 里带 `replacementSeq` 的行，
 * 没有这些行的会话（未归档过）在本域里是空操作。
 */
import { randomUUID } from 'node:crypto'

import { buildForgetTombstone, PLUGIN_SOURCE_KIND } from '../core.mjs'
import { v2SessionDirectoryFor } from './state.mjs'
import { DispositionError, applyForget, applyUndo, buildForgetPreview, describeForgetStatus, getForgetPlan, resolveForgetTargets, saveForgetPlan } from './disposition.mjs'
import { dropVoucherPlansForRecords } from './agg-voucher.mjs'
import { invalidateProvenance, registerProvenanceEdge } from './provenance-index.mjs'
import { withHostContract } from './command-result.mjs'

export function createForgetDomain({
  factoryFor,
  nodeUnitBase,
  receiptTextOf,
  writeV2SessionState,
  getForgetIndex,
}) {
  const FORGET_TOMBSTONE_TAG = '本段已按用户指令软遗忘'

  async function collectForgetEntries(record) {
    return factoryFor(record).withStore((store) => {
      const entries = []
      let afterId = null
      for (;;) {
        const page = store.listEntries({ afterId, limit: 500 })
        if (page.entries.length === 0) break
        entries.push(...page.entries)
        if (!page.nextAfter) break
        afterId = page.nextAfter
      }
      return entries
    })
  }

  function forgetNodeBasesOf(entries, recordIds) {
    const wanted = new Set(recordIds)
    const bases = new Set()
    for (const entry of entries) {
      if (!wanted.has(entry.id)) continue
      const nodeId = entry.inline?.nodeId
      if (typeof nodeId === 'string' && nodeId) bases.add(nodeUnitBase(nodeId))
    }
    return bases
  }

  function isTombstoneText(text) {
    return typeof text === 'string' && text.includes(FORGET_TOMBSTONE_TAG)
  }

  function appendSurfaceText(session, seq, text) {
    return session.append(
      'user/message',
      {
        id: `surface-${randomUUID()}`,
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: PLUGIN_SOURCE_KIND, form: 'memory-lab2-surface' },
      },
      { surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq] },
    )
  }

  /**
   * 计算一次遗忘的表面撤回计划：行按 replacementSeq 分组（P1-5 批组共享同一
   * 表面节点），组内任一行被遗忘则整组换墓碑；换墓碑前把当前表面文本快照进
   * 账本的 withdrawals，undo 据此逐字节恢复。已经是墓碑或原文已变的节点不重
   * 复快照，如实计入 pendingWithdrawals 交由对账重放。
   */
  async function planWithdrawals(record, forgetNodeIds, targetIds) {
    const session = record.agent?.session
    const rows = Array.isArray(record.state?.archive) ? record.state.archive : []
    const bySeq = new Map()
    for (const row of rows) {
      if (!row?.replacementSeq || !row?.nodeId) continue
      const list = bySeq.get(row.replacementSeq) ?? []
      list.push(row)
      bySeq.set(row.replacementSeq, list)
    }
    const withdrawals = []
    const pendingWithdrawals = []
    const touchedRows = []
    for (const [seq, group] of bySeq) {
      const affected = group.filter((row) => forgetNodeIds.has(nodeUnitBase(row.nodeId)))
      if (affected.length === 0) continue
      touchedRows.push(...affected)
      const current = receiptTextOf(typeof session?.eventAt === 'function' ? session.eventAt(seq) : null)
      if (current === null || isTombstoneText(current)) {
        // 表面已经是墓碑（先前撤回过）或文本已不存在：不重复快照。
        if (current === null) pendingWithdrawals.push({ nodeIds: [...new Set(group.map((row) => row.nodeId))], replacementSeq: seq, reason: 'surface-missing' })
        continue
      }
      withdrawals.push({
        nodeIds: [...new Set(group.map((row) => row.nodeId))].sort(),
        recordIds: targetIds.slice().sort(),
        replacementSeq: seq,
        receiptText: current,
      })
    }
    return { withdrawals, pendingWithdrawals, touchedRows }
  }

  async function withdrawForgottenSurfaces(record, result, precomputed = null) {
    const session = record.agent?.session
    const plan = precomputed
      ?? await planWithdrawals(record, forgetNodeBasesOf(await collectForgetEntries(record), result.targetIds ?? []), result.targetIds ?? [])
    const failures = []
    for (const withdrawal of plan.withdrawals) {
      try {
        appendSurfaceText(session, withdrawal.replacementSeq, buildForgetTombstone({
          range: { start: withdrawal.replacementSeq, end: withdrawal.replacementSeq },
          nodeId: withdrawal.nodeIds[0] ?? '(unknown)',
          hash: null,
          reason: result.entry?.reason ?? null,
        }))
      } catch (error) {
        failures.push({ replacementSeq: withdrawal.replacementSeq, message: error?.message ?? String(error) })
      }
    }
    // Y-25（beta.7 B 组）：**撤回失败不是撤回成功**。
    //
    // 旧实现无论表面替换成不成功，都把所有 touchedRows 写成 status='forgotten'。
    // 后果是：账本说「已遗忘」，表面却还留着原文回执（替换抛错那一行）——
    // 读面按账本过滤、投影按表面渲染，两个答案并存，而 restore 会认为这段
    // 「已经不在表面」而跳过它。用户看到「已遗忘」，原文仍在模型可见面上。
    //
    // 现在只有**表面替换成功**的那些区间对应的行才落 forgotten；失败的区间
    // 保持原状态（applied），并在回执里逐条列出，由用户重试或 forget undo。
    const failedSeqs = new Set(failures.map((item) => item.replacementSeq))
    const pendingSeqs = new Set(plan.pendingWithdrawals.map((item) => item.replacementSeq))
    const rows = []
    for (const row of plan.touchedRows) {
      const seq = Number.isInteger(row.rangeStart) ? row.rangeStart : null
      if (seq !== null && (failedSeqs.has(seq) || pendingSeqs.has(seq))) {
        rows.push({ row, outcome: failedSeqs.has(seq) ? 'withdraw-failed' : 'surface-missing' })
        continue
      }
      row.status = 'forgotten'
      row.forgottenBy = result.entry?.operationId ?? null
      rows.push({ row, outcome: 'forgotten' })
    }
    const forgottenRows = rows.filter((item) => item.outcome === 'forgotten').map((item) => item.row)
    if (forgottenRows.length > 0) await writeV2SessionState(record.directory, record.state)
    return {
      failures,
      pendingWithdrawals: plan.pendingWithdrawals,
      withdrawn: plan.withdrawals.length,
      reconciledRows: forgottenRows.length,
      // 未落 forgotten 的行：调用方据此如实报告「这些区间仍然可见」。
      stillVisibleRows: rows.filter((item) => item.outcome !== 'forgotten').map((item) => ({
        rangeStart: item.row.rangeStart,
        rangeEnd: item.row.rangeEnd,
        nodeId: item.row.nodeId,
        outcome: item.outcome,
      })),
    }
  }

  /**
   * undo 侧：账本已把可见性放回，这里按撤销条目携带的撤回快照恢复可见回执。
   * 快照缺失或表面已再次变化时不动表面、如实报告（账本仍是权威）。
   */
  async function restoreForgottenSurfaces(record, undoResult) {
    const session = record.agent?.session
    const rows = Array.isArray(record.state?.archive) ? record.state.archive : []
    const failures = []
    let restoredSurfaces = 0
    for (const withdrawal of undoResult.withdrawals ?? []) {
      try {
        const current = receiptTextOf(typeof session?.eventAt === 'function' ? session.eventAt(withdrawal.replacementSeq) : null)
        if (current === null) {
          failures.push({ replacementSeq: withdrawal.replacementSeq, message: 'surface-missing' })
          continue
        }
        if (!isTombstoneText(current)) continue
        appendSurfaceText(session, withdrawal.replacementSeq, withdrawal.receiptText)
        restoredSurfaces += 1
      } catch (error) {
        failures.push({ replacementSeq: withdrawal.replacementSeq, message: error?.message ?? String(error) })
      }
    }
    // 行状态跟随账本（权威）：forgotten 行的 node 基名若已不再遗忘，放回 applied。
    const forgetIndex = await getForgetIndex(record.directory)
    let changed = false
    let bases = new Set()
    if (forgetIndex.forgotten && forgetIndex.forgotten.size > 0) {
      const entries = await collectForgetEntries(record)
      bases = forgetNodeBasesOf(entries, [...forgetIndex.forgotten.keys()])
    }
    for (const row of rows) {
      if (row?.status !== 'forgotten' || !row.nodeId) continue
      if (!bases.has(nodeUnitBase(row.nodeId))) {
        row.status = 'applied'
        row.forgottenBy = null
        changed = true
      }
    }
    if (changed) await writeV2SessionState(record.directory, record.state)
    return { failures, restoredSurfaces }
  }
  return {
    FORGET_TOMBSTONE_TAG,
    collectForgetEntries,
    forgetNodeBasesOf,
    isTombstoneText,
    appendSurfaceText,
    planWithdrawals,
    withdrawForgottenSurfaces,
    restoreForgottenSurfaces,
  }
}


/**
 * 遗忘命令面（P4c 迁入）。
 *
 * 与 `createForgetDomain` 分开是因为**装配顺序**：命令面要 `records` / `adopt`，
 * 那是 lifecycle 域的产物，而 lifecycle 域又要本域的表面撤回函数。所以表面撤回
 * 先装配，命令面在 lifecycle 之后装配，两者共用同一批函数实例。
 *
 * ## 不适用条件
 * 本工厂只返回 `forgetCommand`；命令分发（`commandHandler`）留在 runtime。
 */
export function createForgetCommand({
  records,
  adopt,
  backendForSession,
  factoryFor,
  labRoot,
  sessionIdOf,
  collectForgetEntries,
  forgetNodeBasesOf,
  planWithdrawals,
  withdrawForgottenSurfaces,
  restoreForgottenSurfaces,
}) {
async function forgetCommand(invocation, args) {
  const subcommand = (args[0] ?? '').toLowerCase()
  const targets = args.slice(1)
  const sessionId = sessionIdOf(invocation.agent.session)
  const sessionDir = v2SessionDirectoryFor(labRoot, sessionId)
  if (!['preview', 'apply', 'undo', 'status'].includes(subcommand)) {
    return { kind: 'error', code: 'EFORGETUSAGE', message: '用法：/memory-lab forget preview|apply|undo|status <目标…>' }
  }
  if (subcommand === 'status') {
    try {
      const report = await describeForgetStatus(sessionDir)
      const lines = ['账本状态 ' + report.state + '（revision ' + report.revision + '，当前遗忘 ' + report.forgottenCount + ' 条）。']
      for (const op of report.operations.slice(-40).reverse()) {
        if (op.kind === 'undo') {
          lines.push(op.operationId + ' undo ' + op.undoOf + '（恢复 ' + op.restoredCount + '，保持 ' + op.keptCount + '）')
        } else {
          lines.push(op.operationId + ' forget ' + op.targetCount + ' 条（' + (op.reason || '无备注') + '）' + (op.undone ? ' — 已撤销' : ''))
        }
      }
      if (report.operations.length > 40) lines.push('（仅显示最近 40 条操作，共 ' + report.operations.length + ' 条）')
      if (report.repairedBytes > 0) lines.push('本次读取截断了 ' + report.repairedBytes + ' 字节的账本半行（崩溃残留，已修复）。')
      // 诚实边界（计划 §8）：T2 派生索引在服务端，插件没有探针过的删除原语；
      // 权威过滤在读面拦截，但残留计数要如实说，不假装已清除。
      const statusBackend = backendForSession(sessionId)
      if (statusBackend?.kind === 'lingshu' && report.forgottenCount > 0) {
        lines.push('隔离灵枢侧派生索引仍可能残留已遗忘内容的命中（读面已拦截，服务端未清除）。')
      }
      return { kind: 'success', text: lines.join('\n') }
    } catch (error) {
      if (error instanceof DispositionError) {
        return { kind: 'error', code: error.code, message: error.message }
      }
      throw error
    }
  }
  if (subcommand === 'preview') {
    if (targets.length === 0) {
      return { kind: 'error', code: 'EFORGETUSAGE', message: 'preview 需要至少一个目标：记录ID | nodeId | callId | kind=<片段> | before=<记录ID>' }
    }
    const record = await adopt(invocation.agent)
    // BUG-005：未启用会话 adopt() 返回 null。判空后给结构化错误信封，
    // 绝不能把 null 传进 collectForgetEntries（那里读 record.sessionId 会 TypeError）。
    if (!record) return { kind: 'error', code: 'ENOTENABLED', message: '本会话尚未启用记忆上下文（/memory-lab on）。' }
    const entries = await collectForgetEntries(record)
    const reader = async (id) => {
      const result = await factoryFor(record).withStore((store) => store.readRecord(id))
      return { ok: result.ok, text: result.ok ? result.payloadText ?? null : null }
    }
    const preview = await buildForgetPreview({ sessionDir, targets, entries, readRecord: reader })
    const lines = ['当前 revision ' + preview.revision + '。']
    for (const expansion of preview.expansions) {
      lines.push(expansion.from + ' → ' + expansion.to.length + ' 条记录（' + expansion.note + '）')
    }
    if (preview.unknown.length > 0) lines.push('未命中目标（不在本会话冷库）：' + preview.unknown.join('、'))
    if (preview.blocked.length > 0) {
      lines.push('硬保护拦截：' + preview.blocked.map((item) => item.id + '（' + item.rule + '）').join('、'))
    }
    if (preview.warnings.length > 0) {
      lines.push('警告（显式目标已放行）：' + preview.warnings.map((item) => item.id + '（' + item.detail + '）').join('、'))
    }
    if (preview.already.length > 0) lines.push('已遗忘（幂等跳过）：' + preview.already.map((item) => item.id).join('、'))
    lines.push('本次将遗忘 ' + preview.toForget.length + ' 条记录。')
    if (preview.plan) {
      await saveForgetPlan(sessionDir, preview.plan)
      lines.push('宽条件目标已生成计划 ' + preview.plan.planId + '（revision ' + preview.plan.revision + '）；apply 用：/memory-lab forget apply ' + preview.plan.planId)
    } else if (preview.wide) {
      lines.push('宽条件无可遗忘集合，未生成计划。')
    }
    if (preview.repairedBytes > 0) lines.push('账本读取截断 ' + preview.repairedBytes + ' 字节半行（崩溃残留，已修复）。')
    return { kind: 'success', text: lines.join('\n') }
  }
  if (subcommand === 'undo') {
    const operationId = targets[0]
    if (!operationId) {
      return { kind: 'error', code: 'EFORGETUSAGE', message: 'undo 需要操作ID，先用 /memory-lab forget status 查看' }
    }
    const record = await adopt(invocation.agent)
    // 账本权威：先提交 undo，再做表面回执重建（幂等、失败如实报告）。
    let result
    try {
      result = await applyUndo({ sessionDir, operationId })
    } catch (error) {
      if (error instanceof DispositionError) {
        return { kind: 'error', code: error.code, message: error.message }
      }
      throw error
    }
    // BUG-005：undo 的账本侧只依赖 sessionDir，record 仅在表面回执重建时用。
    // 未启用会话（record=null）仍可完成账本级 undo；此时没有活动面可重建，
    // 如实说明而不是 TypeError，也不是假成功。
    const surface = record ? await restoreForgottenSurfaces(record, result) : null
    const lines = [
      `已撤销遗忘操作 ${result.entry.operationId}（恢复可见 ${result.restoredIds.length} 条；其余 ${result.keptIds.length} 条保持遗忘——多原因命中，逐条列出剩余 cause）。`,
      surface
        ? `可见性已由账本放回；被撤销对象里的表面回执恢复 ${surface.restoredSurfaces} 个。`
        : '本会话的 v2 引擎未启用：只提交了账本级 undo，没有表面回执需要重建。',
    ]
    if (result.keptIds.length > 0) lines.push(`保持遗忘：${result.keptIds.join('、')}`)
    if (surface?.failures.length > 0) lines.push(`表面恢复失败（可重试）：${surface.failures.map((f) => `seq${f.replacementSeq}(${f.message})`).join('、')}`)
    lines.push('原文回注（把内容重新注入热上下文）仍需显式 /memory-lab restore。')
    return { kind: 'success', text: lines.join('\n') }
  }
  // apply
  if (targets.length === 0) {
    return { kind: 'error', code: 'EFORGETUSAGE', message: 'apply 需要 <计划ID>（宽条件）或显式记录ID列表' }
  }
  const record = await adopt(invocation.agent)
  // BUG-005：同 preview，未启用会话给结构化错误而不是 TypeError。
  if (!record) return { kind: 'error', code: 'ENOTENABLED', message: '本会话尚未启用记忆上下文（/memory-lab on）。' }
  const entries = await collectForgetEntries(record)
  let plan = null
  let targetIds = null
  let reason = null
  if (targets.length === 1 && /^[0-9a-f]{16}$/.test(targets[0])) {
    plan = await getForgetPlan(sessionDir, targets[0])
    if (!plan) {
      return { kind: 'error', code: 'EFORGETPLAN', message: `计划 ${targets[0]} 不存在或已被消费；请重新 /memory-lab forget preview` }
    }
    targetIds = plan.resolvedIds
    reason = `plan:${plan.planId}`
  } else {
    // 显式目标也先解析再提交：别名（nodeId/callId/导入指针）按单元闭包展开；
    // 宽条件（kind=/before=）拒绝直通——计划通道是宽条件的唯一提交路径；
    // 未知目标如实报错，不把字符串当记录 ID 写进账本。
    const resolved = await resolveForgetTargets({
      targets,
      entries,
      readRecord: (id) => factoryFor(record).withStore((store) => {
        try {
          return store.readRecord(id, { verifyHash: false, maxBytes: 64 * 1024 })
        } catch {
          return { ok: false }
        }
      }),
    })
    if (resolved.wide) {
      return { kind: 'error', code: 'EFORGETWIDE', message: '宽条件目标必须先 /memory-lab forget preview，再用计划 ID apply；apply 不接受宽条件直通' }
    }
    if (resolved.unknown.length > 0) {
      return { kind: 'error', code: 'EFORGETTARGET', message: '未知目标：' + resolved.unknown.join('、') }
    }
    if (resolved.recordIds.length === 0) {
      return { kind: 'error', code: 'EFORGETTARGET', message: '目标解析后为空集合' }
    }
    targetIds = resolved.recordIds
    reason = 'explicit'
  }
  // 先快照再提交：账本条目携带 undo 所需的回执原文（崩溃窗口内不丢快照）。
  const forgetNodeIds = forgetNodeBasesOf(entries, targetIds)
  const withdrawalPlan = await planWithdrawals(record, forgetNodeIds, targetIds)
  let result
  try {
    result = await applyForget({
      sessionDir,
      targetIds,
      actor: 'user',
      reason,
      expectedRevision: plan ? plan.revision : null,
      withdrawals: withdrawalPlan.withdrawals,
    })
  } catch (error) {
    if (error instanceof DispositionError) {
      return { kind: 'error', code: error.code, message: error.message }
    }
    throw error
  }
  // 计划文件失效（F-01）：已遗忘成员不得再被崩溃窗口重放成 L1/L2。
  // 这是派生缓存清理，不改变遗忘账本与冷库原文；失败只披露，不阻断遗忘本体。
  let planCleanup = { dropped: [], kept: 0 }
  try {
    planCleanup = await dropVoucherPlansForRecords(sessionDir, result.appended ? result.entry.targetIds : targetIds)
  } catch { /* 计划文件不可写时由 compress/reconcile 的可见性检查兜底 */ }
  if (!result.appended) {
    const idempotentLines = ['目标已全部处于遗忘状态（幂等，未追加条目）；当前 revision ' + result.revision + '。']
    if (planCleanup.dropped.length > 0) {
      idempotentLines.push('作废层级压缩计划 ' + planCleanup.dropped.length + ' 条（含已遗忘成员）：' + planCleanup.dropped.join('、') + '。')
    }
    return { kind: 'success', text: idempotentLines.join('\n') }
  }
  const withdrawal = await withdrawForgottenSurfaces(record, result, withdrawalPlan)
  // provenance：先注册「表面回执 ← 遗忘记录」来源边，再标记失效（undo 后复验
  // 有结构可查）。注册/失效都失败不阻断遗忘本体——账本才是权威，status 披露。
  for (const withdrawalItem of withdrawalPlan.withdrawals) {
    try {
      await registerProvenanceEdge({
        sessionDir,
        derivedId: 'surface:' + withdrawalItem.replacementSeq,
        derivedKind: 'surface-receipt',
        sourceIds: withdrawalItem.recordIds,
      })
    } catch { /* 已注册或只读时跳过 */ }
    try {
      await invalidateProvenance({ sessionDir, derivedId: 'surface:' + withdrawalItem.replacementSeq, cause: result.entry.operationId })
    } catch { /* 失效标记失败不阻断遗忘 */ }
  }
  const lines = [
    '软遗忘已生效（操作 ' + result.entry.operationId + '）：新增 ' + result.entry.targetIds.length + ' 条，已遗忘 ' + result.alreadyForgotten.length + ' 条幂等跳过。',
    '表面回执撤回 ' + withdrawal.withdrawn + ' 个节点' + (withdrawal.failures.length ? '，失败 ' + withdrawal.failures.length + ' 个（forget status 待收口清单可重放）' : '') + '。',
  ]
  if (planCleanup.dropped.length > 0) {
    lines.push('作废层级压缩计划 ' + planCleanup.dropped.length + ' 条（含已遗忘成员）：' + planCleanup.dropped.join('、') + '。')
  }
  if (withdrawal.pendingWithdrawals.length > 0) {
    lines.push('表面缺失待对账 ' + withdrawal.pendingWithdrawals.length + ' 组（下次 adopt 时收敛）。')
  }
  // Y-25：撤回失败/表面缺失的行**没有**落 forgotten——它们仍在模型可见面上。
  // 回执必须如实说，否则用户以为「已遗忘」，原文却还挂在投影里。
  if (Array.isArray(withdrawal.stillVisibleRows) && withdrawal.stillVisibleRows.length > 0) {
    const sample = withdrawal.stillVisibleRows.slice(0, 5)
      .map((row) => `seq ${row.rangeStart}–${row.rangeEnd}`)
      .join('、')
    lines.push(
      `⚠ ${withdrawal.stillVisibleRows.length} 段表面回执未能撤回（${sample}${withdrawal.stillVisibleRows.length > 5 ? ' 等' : ''}）：`
      + '这些区间**仍然对模型可见**，账本已记遗忘但投影未收口。用 /memory-lab forget status 看重放清单，'
      + '或先 /memory-lab forget undo ' + result.entry.operationId + ' 回到一致状态再重试。',
    )
  }
  lines.push('冷库原文与审计日志保留；撤销用 /memory-lab forget undo ' + result.entry.operationId + '。')
  return { kind: 'success', text: lines.join('\n') }
}

  // G5：命令域工厂返回时统一套上宿主契约（`{kind:'error',code,message}` 补 `text`）。
  // 包在工厂出口而不是逐处补 text：域内部继续用 code/message，新加的错误分支自动合规。
  return withHostContract({ forgetCommand })
}
