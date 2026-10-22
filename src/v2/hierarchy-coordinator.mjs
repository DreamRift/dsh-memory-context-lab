import { randomUUID } from 'node:crypto'

import { V2_RECEIPT_MARKER, parseStrictInteger } from '../core.mjs'
import { estimateTokensOf } from './budget.mjs'
import {
  AGG_VOUCHER_MARKER,
  AGG_VOUCHER_MAX_RUN,
  AGG_VOUCHER_MIN_RUN,
  AGG_VOUCHER_PAGE_SIZE,
  AGG_VOUCHER_PLAN_LIMIT,
  dropVoucherPlan,
  getVoucherPlan,
  loadVoucherPlans,
  parseAggVoucherText,
  parseReceiptRecordIds,
  planAggregateVouchers,
  renderExpansionPage,
  saveVoucherPlan,
  voucherIdOf,
  withMemberExclusions,
} from './agg-voucher.mjs'
import { extractAtoms, mergeFacts, groupAtoms } from './evidence-atoms.mjs'
import { runModelPhase } from './compressor-model.mjs'
import {
  PHASE_CARD_MAX_TOKENS,
  buildBlocks,
  budgetSelect,
  noSafeGainCheck,
  renderPhaseCard,
  renderEvidenceCard,
  shareModeNote,
  renderTaskIndex,
} from './compressor-program.mjs'
import {
  HIERARCHY_ENTRY_L1,
  HIERARCHY_ENTRY_L2,
  HIERARCHY_ENTRY_L3,
  HIERARCHY_ENTRY_RUN,
  HIERARCHY_ENTRY_VOUCHER,
  HIERARCHY_RUN_OUTCOMES,
  HierarchyStoreError,
  appendHierarchyEntries,
  foldHierarchy,
  loadHierarchy,
} from './hierarchy-store.mjs'

/**
 * P3-10 阶段调度与事务协调：聚合凭证的编排器。
 *
 * 命令面（两段式，只读 preview 与落账 run）：
 * - `compress preview`：只算不写。列出候选凭证组（连续已完成回执、无人类消息
 *   穿插、成员可解析）、逐组的 token 收支与 no-safe-gain 判定。
 * - `compress run`：对每个可收益组执行事务序：先存凭证计划（可重放窗口）→
 *   表面替换（聚合凭证消息，host 分配 replacementSeq）→ hierarchy 账本一批原子
 *   追加（L1 证据卡缓存 / L2 相位卡 / L3 任务索引 / 凭证条目 / run 审计）。
 *   任何一步失败都停在失败前状态：计划孤儿可被下次 run 覆盖，表面已替换但账本
 *   未写的窗口由 `reconcileVouchers` 从计划文件重放补账。
 * - `expand <凭证ID> [页码]`：恒定只读面分页回读成员回执原文。
 *
 * 无 LLM 依赖：证据提取、归组、预算覆盖、相位卡渲染全部是确定性程序；LLM 模式
 * 属 P4，不在本模块。
 */

export const COMPRESS_SUBCOMMANDS = Object.freeze(['preview', 'run', 'status'])

const RUN_OUTCOME_COMMITTED = 'committed'
const RUN_OUTCOME_NO_SAFE_GAIN = 'no-safe-gain'
// 账本允许的 skipped 细目只有 skipped-damaged：表面失败与对账重放都落这档。
const RUN_OUTCOME_SKIPPED = 'skipped-damaged'

/**
 * 计算一个候选组的完整方案（纯函数，preview 与 run 共用）。
 * members 为冷库记录视图：{ recordId, kind, body, receiptText, receiptTokens }。
 * 净收益门槛走 P3-7 的 noSafeGainCheck：不净缩短或必需事实装不下都拒绝替换。
 */
function evaluateCandidate(plan, membersById, { shareContent = false } = {}) {
  const members = []
  for (const recordId of plan.recordIds) {
    const member = membersById.get(recordId)
    if (!member) return { plan, ok: false, reason: 'member-unresolved' }
    members.push(member)
  }
  if (members.length !== plan.recordIds.length) {
    return { plan, ok: false, reason: 'member-count-mismatch' }
  }
  const atoms = []
  for (const member of members) atoms.push(...extractAtoms(member))
  const facts = mergeFacts(atoms)
  const grouping = groupAtoms(facts)
  const blocks = buildBlocks(facts, grouping.groups, { shareContent })
  const summary = budgetSelect(blocks, { budgetTokens: PHASE_CARD_MAX_TOKENS })
  const summaryId = 'ph-' + plan.voucherId.slice(-10)
  const toolNames = Object.entries(plan.toolHistogram ?? {})
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([tool]) => tool)
  const phaseCard = renderPhaseCard({
    summaryId,
    phaseLabel: `阶段 ${plan.startSeq}-${plan.endSeq}`,
    memberCount: members.length,
    tools: toolNames,
    blocks: summary.selected,
    manifestId: 'mf-' + plan.voucherId.slice(-10),
    voucherId: plan.voucherId,
    dropped: summary.dropped,
    truncated: grouping.truncated,
    modeNote: shareModeNote(shareContent),
  })
  // 凭证正文用计划里的恒定渲染（与 preview/run 逐字节一致），相位卡只进层级账本。
  const voucherText = plan.voucherText
  const memberTokens = members.reduce((sum, m) => sum + m.receiptTokens, 0)
  const gainCheck = noSafeGainCheck({
    memberTokens,
    voucherText,
    requiredOverflow: summary.requiredOverflow,
  })
  return {
    plan,
    ok: gainCheck.ok,
    reason: gainCheck.ok ? null : gainCheck.reason,
    gainCheck,
    members,
    // BUG-007：L1 证据卡按成员自己的事实原子渲染。块（blocks）是预算选择后的
    // 渲染单元，不带记录来源，拿它反查成员永远为空；事实列表才是权威映射。
    factList: facts,
    facts: facts.length,
    groups: grouping.groups.length,
    blocks: summary.selected,
    summaryId,
    tools: toolNames,
    phaseCard,
    voucherText,
    memberTokens,
    voucherTokens: gainCheck.voucherTokens,
    net: gainCheck.net,
  }
}

/**
 * 按组解析成员回执原文与 token：回执仍在日志里（被聚合替换前 surfaceNodes 就有，
 * 替换后也能从 eventAt 读回），凭证计划的 memberTexts 之外这是第二来源。
 */
/**
 * 从回执文本反查某条冷库记录所在的成员 seq（T2：账本要能回答「哪一段被排除」）。
 * 反查不到返回 null——不猜 seq，也不编一个占位号。
 */
function seqOfRecordId(receiptTextBySeq, recordId) {
  for (const [seq, text] of receiptTextBySeq) {
    if (parseReceiptRecordIds(text).includes(recordId)) return seq
  }
  return null
}

async function memberViewOf(deps, plan) {
  const receiptTexts = []
  const receiptByRecordId = new Map()
  const receiptTextBySeq = new Map()
  for (const seq of plan.memberSeqs) {
    const event = typeof deps.eventAt === 'function' ? deps.eventAt(seq) : null
    const text = receiptTextOf(event)
    if (text === null) return { blocked: 'member-unreadable' }
    receiptTexts.push(text)
    receiptTextBySeq.set(seq, text)
    // 一条回执可以覆盖多条冷库记录（v1 批量回执）：文中列到的每个 id 都对到该回执。
    for (const recordId of parseReceiptRecordIds(text)) {
      if (!receiptByRecordId.has(recordId)) receiptByRecordId.set(recordId, text)
    }
  }
  const members = []
  const excludedMembers = []
  for (const recordId of plan.recordIds) {
    // 遗忘完整性（0.11.0，外部审计 P0）：候选阶段就查账本，绝不读取已遗忘成员的
    // 冷库正文。展开页的 isRecordVisible 只管渲染已产出的卡，管不住
    // extractAtoms → L1/L2 → 凭证计划这条蒸馏链。
    //
    // T2/F-15：粒度收窄到成员级——被遗忘的成员**排除出参与集**（不读正文、不进
    // L1/L2/sourceRecordIds/leafIds），其余成员照常蒸馏。全部被排除时下面按
    // member-forgotten 整组失败关闭（没有安全子集）。
    if (typeof deps.isRecordVisible === 'function' && !deps.isRecordVisible(recordId)) {
      excludedMembers.push({ recordId, seq: seqOfRecordId(receiptTextBySeq, recordId), reason: 'forgotten' })
      continue
    }
    const receiptText = receiptByRecordId.get(recordId)
    if (receiptText === undefined) return { blocked: 'member-unreadable' }
    const body = await deps.getRecordBody(recordId)
    // 冷库正文不可读（已清理/隔离根缺失）不是阻断：回执文本本身就是本段操作的
    // 权威摘要（P3 无 LLM 管线），退化用它作证据基底，保来源不丢组。
    members.push({
      recordId,
      // kind 只用于渲染标签。拿不到就如实标「未知」，不冒充某个具体类别
      // （0.13.2-beta.2）：旧兜底 'tool-output' 会让「读不到」与「确实是工具输出」
      // 在卡片上完全同形，排查时分不清。
      kind: typeof deps.getRecordKind === 'function' ? (deps.getRecordKind(recordId) ?? 'unknown') : 'unknown',
      body: body ?? receiptText,
      receiptText,
      receiptTokens: estimateTokensOf(receiptText),
    })
  }
  if (members.length === 0) return { blocked: 'member-forgotten', excludedMembers }
  return { members, receiptTexts, excludedMembers }
}

function receiptTextOf(event) {
  if (!event || event.type !== 'user/message') return null
  const content = event.data?.content
  if (!Array.isArray(content)) return null
  const first = content.find((part) => part?.type === 'text')
  const text = first?.text
  if (typeof text !== 'string' || !text.startsWith(V2_RECEIPT_MARKER)) return null
  return text
}

/** 读表面节点（须为聚合凭证消息本身）的文本。 */
function voucherTextOf(event) {
  if (!event || event.type !== 'user/message') return null
  const content = event.data?.content
  if (!Array.isArray(content)) return null
  const first = content.find((part) => part?.type === 'text')
  const text = first?.text
  if (typeof text !== 'string' || !text.startsWith(AGG_VOUCHER_MARKER)) return null
  return text
}

/** surfaceNodes 可以是数组或惰性函数（runtime 传函数避免快照竞态），统一展开为 seq 数组。 */
function surfaceSeqs(deps) {
  const nodes = typeof deps.surfaceNodes === 'function' ? deps.surfaceNodes() : deps.surfaceNodes
  return Array.isArray(nodes) ? nodes : []
}

/**
 * 汇总表面凭证消息：返回 Map<voucherId, { seq, text }>。
 * runtime 注入 surfaceVoucherNodes（[{seq, text}]）更直接；eventAt 路径只是兜底。
 */
function collectSurfaceVouchers(deps) {
  const found = new Map()
  const voucherNodes = typeof deps.surfaceVoucherNodes === 'function' ? deps.surfaceVoucherNodes() : deps.surfaceVoucherNodes
  if (Array.isArray(voucherNodes)) {
    for (const node of voucherNodes) {
      const parsed = parseAggVoucherText(node.text)
      if (parsed) found.set(parsed.voucherId, { seq: node.seq, text: node.text })
    }
    return found
  }
  if (typeof deps.eventAt !== 'function') return found
  for (const seq of surfaceSeqs(deps)) {
    const text = voucherTextOf(deps.eventAt(seq))
    if (text === null) continue
    const parsed = parseAggVoucherText(text)
    if (parsed) found.set(parsed.voucherId, { seq, text })
  }
  return found
}

/** 组装表面节点快照：[{seq, text}]，只保留 user/message 的文本事件。 */
export function surfaceNodeTexts(deps) {
  const nodes = []
  for (const seq of surfaceSeqs(deps)) {
    const event = typeof deps.eventAt === 'function' ? deps.eventAt(seq) : null
    if (!event || event.type !== 'user/message') continue
    const content = event.data?.content
    if (!Array.isArray(content)) continue
    const first = content.find((part) => part?.type === 'text')
    if (typeof first?.text !== 'string') continue
    nodes.push({ seq, text: first.text, sourceForm: event.data?.source?.form })
  }
  return nodes
}

/** preview / run 共用的候选计算。 */
async function computeCandidates(deps) {
  const ledger = await loadHierarchy(deps.sessionDir)
  const nodes = surfaceNodeTexts(deps)
  const { plans } = planAggregateVouchers(nodes)
  const candidates = []
  for (const plan of plans) {
    if (ledger.vouchers.has(plan.voucherId)) {
      candidates.push({ plan, status: 'already-applied' })
      continue
    }
    const view = await memberViewOf(deps, plan)
    if (!view || view.blocked) {
      candidates.push({ plan, status: 'blocked', reason: view?.blocked ?? 'member-unreadable' })
      continue
    }
    // T2/F-15：被遗忘的成员排除出参与集（recordIds 收窄），memberSeqs/memberTexts
    // 保持表面全集——区间身份与 voucherId 不变。无排除时 withMemberExclusions 原样
    // 返回计划，渲染与 0.10.x 逐字节一致。
    const effectivePlan = withMemberExclusions(plan, { excludedMembers: view.excludedMembers })
    const membersById = new Map(view.members.map((member) => [member.recordId, member]))
    const evaluation = evaluateCandidate(effectivePlan, membersById, { shareContent: deps?.shareL2Content === true })
    candidates.push({
      plan: effectivePlan,
      status: evaluation.ok ? 'ready' : evaluation.reason === RUN_OUTCOME_NO_SAFE_GAIN ? RUN_OUTCOME_NO_SAFE_GAIN : 'blocked',
      reason: evaluation.reason,
      detail: evaluation.ok
        ? {
            facts: evaluation.facts,
            groups: evaluation.groups,
            blocks: evaluation.blocks,
            memberTokens: evaluation.memberTokens,
            voucherTokens: evaluation.voucherTokens,
            net: evaluation.net,
          }
        : null,
      evaluation,
      memberTexts: view.receiptTexts,
    })
  }
  return { ledger, plans, candidates }
}

/**
 * 模型相位（P4）：对 ready 候选在事务前跑一次模型摘要。宿主契约风险全部
 * 收敛在 deps.modelPhase（依赖注入：stream、model、缓存与落账钩子、signal），
 * 缺失即整体程序档；失败关闭阶梯由 runModelPhase 负责，这里只分三种走向：
 * 模型卡 / 取消（任务撤销）/ 落回程序卡。
 * readOnly=true 用于 preview：不传观察钩子，只读预览不产生 LLM 调用与落账。
 */
async function modelPhaseOutcome(deps, candidate, { readOnly = false } = {}) {
  const cfg = deps?.modelPhase
  if (!cfg || typeof cfg !== 'object' || typeof cfg.stream !== 'function') return null
  const { plan, evaluation } = candidate
  const outcome = await runModelPhase({
    stream: cfg.stream,
    model: cfg.model,
    signal: cfg.signal,
    timeoutMs: cfg.timeoutMs,
    selected: evaluation.blocks,
    programCardTokens: estimateTokensOf(evaluation.phaseCard),
    summaryId: evaluation.summaryId,
    phaseLabel: `阶段 ${plan.startSeq}-${plan.endSeq}`,
    memberCount: plan.memberCount,
    tools: evaluation.tools,
    manifestId: 'mf-' + plan.voucherId.slice(-10),
    voucherId: plan.voucherId,
    ...(readOnly ? {} : {
      cacheLookup: cfg.cacheLookup,
      cacheSave: cfg.cacheSave,
      onUsage: cfg.onUsage,
    }),
  })
  return outcome
}

export async function compressPreview(deps) {
  const { ledger, candidates } = await computeCandidates(deps)
  const lines = ['压缩预览（只读，不落账）：']
  // 模型模式标注（轻量）：只看注入与中止状态，不真调 LLM——只读预览不烧费用。
  // run 才真正生成模型卡；取消是任务撤销，如实标注。
  const modelNote = (() => {
    const cfg = deps?.modelPhase
    if (!cfg || typeof cfg.stream !== 'function') return ''
    if (cfg.signal?.aborted) return '模型阶段已取消（任务撤销）；原状态保留。'
    return '模型摘要模式已启用（run 时生成并逐条对回 L0 校验）。'
  })()
  if (modelNote) lines.push(modelNote)
  const ready = candidates.filter((c) => c.status === 'ready')
  const blocked = candidates.filter((c) => c.status === 'blocked')
  const gains = candidates.filter((c) => c.status === RUN_OUTCOME_NO_SAFE_GAIN)
  const applied = candidates.filter((c) => c.status === 'already-applied')
  if (candidates.length === 0) {
    lines.push('没有候选凭证组：表面没有满足最短长度（' + AGG_VOUCHER_MIN_RUN + ' 条）的连续已完成回执。')
  }
  for (const c of ready) {
    lines.push(
      `可替换 seq ${c.plan.startSeq}–${c.plan.endSeq}：${c.plan.memberCount} 条回执 → 1 张凭证；` +
        `成员 ${c.detail.memberTokens} token → 凭证 ${c.detail.voucherTokens} token（净省 ${c.detail.net}）。`,
    )
  }
  for (const c of gains) {
    const detail = c.evaluation?.gainCheck
    lines.push(
      `拒绝 seq ${c.plan.startSeq}–${c.plan.endSeq}：no-safe-gain（${detail?.detail ?? '不净缩短'}，成员 ${detail?.memberTokens} token → 凭证 ${detail?.voucherTokens} token），保留原回执。`,
    )
  }
  for (const c of blocked) {
    const reasonText = c.reason === 'member-forgotten'
      ? '成员已按遗忘账本隐藏，整组跳过（失败关闭）'
      : c.reason === 'member-unreadable'
        ? '成员回执或冷库不可读'
        : c.reason
    lines.push(`跳过 seq ${c.plan.startSeq}–${c.plan.endSeq}：${reasonText}。`)
  }
  for (const c of applied) {
    lines.push(`已应用 ${c.plan.voucherId}（seq ${c.plan.startSeq}–${c.plan.endSeq}），不重复替换。`)
  }
  lines.push(`层级账本：${ledger.revision} 个折叠步；凭证 ${ledger.vouchers.size} 张。`)
  return { text: lines.join('\n'), ledger, candidates }
}

export async function compressRun(deps) {
  const { candidates } = await computeCandidates(deps)
  const applied = []
  const rejected = []
  const failures = []
  // 模型相位统计（P4）：用户可见「几组走模型卡、几组落回程序卡」。
  const modelStats = { model: 0, fallback: 0 }
  let modelNote = null
  for (const candidate of candidates) {
    if (candidate.status !== 'ready') {
      if (candidate.status === RUN_OUTCOME_NO_SAFE_GAIN) rejected.push(candidate.plan.voucherId)
      continue
    }
    const { plan, evaluation, memberTexts } = candidate
    // 模型相位（依赖注入，宿主契约风险全部收敛在 deps.modelPhase）：产出已过
    // 机械校验的模型卡；失败关闭落程序卡；取消是任务撤销——停止本次 run，
    // 已完成的组保留，本组原状态保留，不借兜底继续。
    let l2CardText
    if (deps.modelPhase && typeof deps.modelPhase.stream === 'function') {
      const outcome = await modelPhaseOutcome(deps, candidate)
      if (outcome.cancelled) {
        return {
          text: `模型阶段取消（${outcome.reason ?? 'user-cancel'}，任务撤销）：原状态保留，未提交任何替换。`,
          applied, rejected, failures,
          cancelled: true,
          modelCancelled: outcome.reason ?? 'user-cancel',
        }
      }
      if (outcome.mode === 'model') {
        l2CardText = outcome.card
        modelStats.model += 1
      } else if (outcome.mode === 'program') {
        modelStats.fallback += 1
        modelNote = outcome.reason
      }
    }
    try {
      const result = await applyVoucher(deps, { plan, evaluation, memberTexts, l2CardText })
      applied.push(result)
    } catch (error) {
      failures.push({ voucherId: plan.voucherId, message: error?.message ?? String(error) })
    }
  }
  // 已应用的组把挂起计划清掉：run 是唯一出口，reconcile 只兜崩溃窗口。
  for (const a of applied) await dropVoucherPlan(deps.sessionDir, a.voucherId).catch(() => {})
  await auditRun(deps, {
    applied: applied.map((a) => a.voucherId),
    rejected,
    failures,
  }).catch(() => {})
  const lines = ['压缩执行：']
  for (const a of applied) {
    lines.push(`已替换 seq ${a.startSeq}–${a.endSeq}：${a.memberCount} 条回执 → 凭证 ${a.voucherId}（expand 分页回读）。`)
  }
  if (rejected.length > 0) lines.push(`no-safe-gain 拒绝 ${rejected.length} 组，保留原回执。`)
  if (deps.modelPhase && typeof deps.modelPhase.stream === 'function') {
    lines.push(`模型摘要：${modelStats.model} 组走模型卡，${modelStats.fallback} 组落回程序卡。`)
    if (modelStats.fallback > 0 && modelNote) lines.push(`落回原因（末组）：${modelNote}。`)
  }
  if (failures.length > 0) {
    lines.push(`失败 ${failures.length} 组（原状态保留）：${failures.map((f) => `${f.voucherId}(${f.message})`).join('、')}。`)
  }
  if (applied.length === 0 && rejected.length === 0 && failures.length === 0) {
    lines.push('没有可替换的候选组（已应用的组不重复替换）。')
  }
  return { text: lines.join('\n'), applied, rejected, failures }
}

/** 事务序：计划 → 表面替换 → 账本原子批。失败停在失败前状态。 */
async function applyVoucher(deps, { plan, evaluation, memberTexts, l2CardText }) {
  // 模型模式（P4）：l2CardText 是 runModelPhase 产出并已通过机械校验的模型卡；
  // 计划文件与 L2 账本必须同值，崩溃后 reconcile 重放才不会回写程序卡。
  const phaseCard = typeof l2CardText === 'string' && l2CardText ? l2CardText : evaluation.phaseCard
  await saveVoucherPlan(deps.sessionDir, {
    ...plan,
    voucherText: evaluation.voucherText,
    phaseCard,
    memberTexts,
    savedAt: new Date().toISOString(),
  })
  const replacement = await deps.appendVoucherMessage({
    startSeq: plan.startSeq,
    endSeq: plan.endSeq,
    memberSeqs: plan.memberSeqs,
    // 宿主 replace 约定：成员 seq 即本次替换的来源事件，供审计与回滚定位。
    sourceEventSeqs: plan.memberSeqs,
    text: evaluation.voucherText,
  })
  if (!replacement || typeof replacement.seq !== 'number' || !Number.isFinite(replacement.seq)) {
    throw new Error('表面替换未返回事件 seq')
  }
  const ledger = await loadHierarchy(deps.sessionDir)
  if (ledger.vouchers.has(plan.voucherId)) {
    return { voucherId: plan.voucherId, startSeq: plan.startSeq, endSeq: plan.endSeq, memberCount: plan.memberCount, replacementSeq: replacement.seq, deduplicated: true }
  }
  const entries = ledgerEntryBatch({
    deps,
    plan,
    evaluation,
    memberTexts,
    l2CardText: phaseCard,
    replacementSeq: replacement.seq,
    sourceRevision: ledger.revision,
    at: new Date().toISOString(),
  })
  await appendHierarchyEntries(deps.sessionDir, entries, { expectedRevision: ledger.revision })
  return {
    voucherId: plan.voucherId,
    startSeq: plan.startSeq,
    endSeq: plan.endSeq,
    memberCount: plan.memberCount,
    replacementSeq: replacement.seq,
  }
}

/** 组装一次凭证应用产生的整批账本条目（L1 缓存 + L2 相位卡 + L3 索引 + 凭证 + 审计）。 */
function ledgerEntryBatch({ plan, evaluation, memberTexts, l2CardText, replacementSeq, sourceRevision, at, deps }) {
  const entries = []
  const l1Ids = []
  for (const member of evaluation.members) {
    const cardId = 'l1-' + member.recordId
    l1Ids.push(cardId)
    // BUG-007：从该成员自己的事实原子取 entity/attribute/value（sourceRefs 的
    // recordId 是来源映射的权威）。用 blocks 反查永远是空卡——buildBlocks 的
    // 输出是「预算选择后的渲染块」，不是按记录索引。
    const evidenceAtoms = (evaluation.factList ?? [])
      .filter((fact) => (fact.sourceRefs ?? []).some((ref) => ref?.recordId === member.recordId))
      .map((fact) => ({ entity: fact.entity, attribute: fact.attribute, value: fact.value }))
    const cardText = renderEvidenceCard({
      recordId: member.recordId,
      spanLabel: `seq ${plan.startSeq}-${plan.endSeq}`,
      atoms: evidenceAtoms,
      // T1/F-03：默认不把成员正文复制进 L1 卡；开关为真才放摘录。
      shareContent: deps?.shareL2Content === true,
    })
    entries.push({
      kind: HIERARCHY_ENTRY_L1,
      cardId,
      recordId: member.recordId,
      text: cardText,
      tokens: estimateTokensOf(cardText),
      at,
    })
  }
  const l2CardId = 'l2-' + plan.voucherId
  entries.push({
    kind: HIERARCHY_ENTRY_L2,
    cardId: l2CardId,
    phaseKey: plan.voucherId,
    phaseLabel: `阶段 ${plan.startSeq}-${plan.endSeq}`,
    // 纪律守卫：sourceRecordIds 只允许 L0 记录 id（禁「摘要再摘要」由账本强制）。
    sourceRecordIds: [...plan.recordIds],
    text: l2CardText ?? evaluation.phaseCard,
    tokens: estimateTokensOf(l2CardText ?? evaluation.phaseCard),
    blocks: evaluation.blocks,
    templateShared: true,
    at,
  })
  const l3IndexId = 'l3-' + plan.voucherId
  entries.push({
    kind: HIERARCHY_ENTRY_L3,
    indexId: l3IndexId,
    phases: [{ phaseKey: plan.voucherId, cardId: l2CardId, leafCount: plan.memberCount }],
    leafIds: [...plan.recordIds],
    text: renderTaskIndex({ summaryId: l3IndexId, phases: [{ phaseKey: plan.voucherId, cardId: l2CardId, leafCount: plan.memberCount }] }),
    at,
  })
  entries.push({
    kind: HIERARCHY_ENTRY_VOUCHER,
    voucherId: plan.voucherId,
    startSeq: plan.startSeq,
    endSeq: plan.endSeq,
    replacementSeq,
    memberSeqs: [...plan.memberSeqs],
    recordIds: [...plan.recordIds],
    memberTexts: [...memberTexts],
    templateShared: true,
    // 凭证正文落账：expand 与 reconcile 都以账本里的 text 为权威渲染源。
    text: evaluation.voucherText,
    at,
  })
  entries.push({
    kind: HIERARCHY_ENTRY_RUN,
    runId: 'compress-run:' + randomUUID().slice(0, 8),
    phaseKey: plan.voucherId,
    outcome: RUN_OUTCOME_COMMITTED,
    evidenceIds: [...plan.recordIds],
    // 本批写入前的账本修订号；重放/对账时用于判断这次 run 看到的世界。
    sourceRevision,
    text: `压缩提交 ${plan.voucherId}：${plan.memberCount} 成员 → 凭证。`,
    at,
  })
  return entries
}

/** run 审计：一次 compress run 的汇总行（包含失败与拒绝，保持账本可审计）。 */
async function auditRun(deps, { applied, rejected, failures }) {
  if (applied.length === 0 && rejected.length === 0 && failures.length === 0) return null
  const ledger = await loadHierarchy(deps.sessionDir)
  const at = new Date().toISOString()
  const entries = []
  if (applied.length > 0) {
    const runId = 'compress-run:' + randomUUID().slice(0, 8)
    entries.push({
      kind: HIERARCHY_ENTRY_RUN,
      runId,
      // phaseKey 必须是**非空字符串**（hierarchy-store 的写入校验）：旧值 null 会让
      // 整批审计条目被 EINVAL 拒绝，而 compressRun 又用 .catch 吞掉了这个错误，
      // 于是「成功压缩」永远没有 run 审计行——账本看上去像从没跑过。
      phaseKey: runId,
      outcome: RUN_OUTCOME_COMMITTED,
      evidenceIds: [...applied],
      sourceRevision: ledger.revision,
      note: `applied=${applied.length} rejected=${rejected.length} failures=${failures.length}`,
      at,
    })
  }
  for (const voucherId of rejected) {
    entries.push({
      kind: HIERARCHY_ENTRY_RUN,
      runId: 'no-safe-gain:' + voucherId,
      phaseKey: voucherId,
      outcome: RUN_OUTCOME_NO_SAFE_GAIN,
      evidenceIds: [],
      sourceRevision: ledger.revision,
      at,
    })
  }
  for (const failure of failures) {
    entries.push({
      kind: HIERARCHY_ENTRY_RUN,
      runId: 'skipped:' + failure.voucherId,
      phaseKey: failure.voucherId,
      evidenceIds: [],
      outcome: RUN_OUTCOME_SKIPPED,
      sourceRevision: ledger.revision,
      note: failure.message.slice(0, 200),
      at,
    })
  }
  if (entries.length === 0) return null
  await appendHierarchyEntries(deps.sessionDir, entries, { expectedRevision: ledger.revision })
  return entries.length
}

export async function compressStatus(deps) {
  const ledger = await loadHierarchy(deps.sessionDir)
  const surface = collectSurfaceVouchers(deps)
  const plans = await loadVoucherPlans(deps.sessionDir)
  const lines = ['层级压缩状态：']
  lines.push(`账本折叠步 ${ledger.revision}；条目 ${ledger.entries.length}（L1 ${ledger.entries.filter((e) => e.kind === HIERARCHY_ENTRY_L1).length}、L2 ${ledger.entries.filter((e) => e.kind === HIERARCHY_ENTRY_L2).length}、L3 ${ledger.entries.filter((e) => e.kind === HIERARCHY_ENTRY_L3).length}、凭证 ${ledger.vouchers.size}、run ${ledger.entries.filter((e) => e.kind === HIERARCHY_ENTRY_RUN).length}）。`)
  let pending = 0
  for (const [voucherId, entry] of ledger.vouchers) {
    if (!surface.has(voucherId)) pending++
  }
  lines.push(`表面凭证消息 ${surface.size} 张；账本凭证未上表面（pending，成员回执仍在表面）${pending} 张。`)
  let orphans = 0
  for (const [voucherId] of surface) {
    if (!ledger.vouchers.has(voucherId)) orphans++
  }
  lines.push(`表面有而账本缺失（孤儿，需 reconcile 补账）${orphans} 张。`)
  lines.push(`计划文件存留 ${plans.length} 条（重放窗口，条目上限 ${AGG_VOUCHER_PLAN_LIMIT}）。`)
  if (ledger.vouchers.size > 0) {
    lines.push(`凭证：${[...ledger.vouchers.keys()].slice(0, 5).join('、')}${ledger.vouchers.size > 5 ? '（等）' : ''}`)
  }
  const damaged = ledger.damaged ? 1 : 0
  // loadHierarchy 不返回 repairNotes（那是早期草稿的字段名），只有 damageDetail：
  // 旧代码在账本损坏时必然抛 TypeError，把「带损坏的 status」变成一条崩溃。
  if (ledger.damaged) {
    const detail = typeof ledger.damageDetail === 'string' && ledger.damageDetail !== ''
      ? ledger.damageDetail
      : '（详见账本）'
    lines.push(`账本带损坏修复记录 ${damaged} 次：${detail}`)
  }
  return { text: lines.join('\n'), ledger, surface, plans }
}

export async function expandVoucher(deps, voucherId, pageArg) {
  const ledger = await loadHierarchy(deps.sessionDir)
  const entry = ledger.vouchers.get(voucherId)
  // R-02 同族（beta.4）：页码参数只认严格十进制整数——`3.7` 曾被 parseInt 悄悄读成
  // 3，用户以为换了页，实际拿到的是被改过的页码。越界仍按页数钳制（那是展示策略，
  // 不是取值域），非法则如实回一句用法。
  const rawPage = pageArg === undefined || pageArg === null || String(pageArg).trim() === '' ? null : pageArg
  const parsedPage = rawPage === null ? 1 : parseStrictInteger(rawPage)
  if (parsedPage === null) {
    return { text: `页码必须是正整数（收到 ${JSON.stringify(String(rawPage))}）；不接受小数或非数字。用法：/memory-lab expand ${voucherId} [页码]` }
  }
  const page = Math.max(1, parsedPage)
  if (!entry) {
    const plan = await getVoucherPlan(deps.sessionDir, voucherId)
    if (!plan) return { text: `凭证 ${voucherId} 不存在（账本与计划文件都没有）。可用 compress status 查看现有凭证。` }
    return {
      text:
        `凭证 ${voucherId} 的账本条目缺失，但计划文件仍在：` +
        `seq ${plan.startSeq}–${plan.endSeq}、成员 ${plan.memberCount} 条。` +
        `运行 compress status 后由 reconcile 补账，或直接 restore 原回执。`,
    }
  }
  const memberTexts = Array.isArray(entry.memberTexts) ? entry.memberTexts : []
  if (memberTexts.length !== entry.memberSeqs.length) {
    return { text: `凭证 ${voucherId} 成员原文不完整（${memberTexts.length}/${entry.memberSeqs.length}），拒绝分页渲染。` }
  }
  // 成员级遗忘过滤：recordIds 是去重后的扁平清单，与 memberSeqs 不对位；
  // 对位关系只能回到每条成员回执原文里解析出的冷记录 id。
  const visibleTexts = []
  const hiddenSeqs = []
  const hiddenRecordIds = []
  for (let i = 0; i < memberTexts.length; i += 1) {
    const seq = entry.memberSeqs[i]
    const memberRecordIds = parseReceiptRecordIds(memberTexts[i])
    const hidden = typeof deps.isRecordVisible === 'function'
      ? memberRecordIds.filter((recordId) => !deps.isRecordVisible(recordId))
      : []
    if (hidden.length > 0) {
      hiddenSeqs.push(seq)
      hiddenRecordIds.push(...hidden)
      visibleTexts.push(undefined)
    } else {
      visibleTexts.push(memberTexts[i])
    }
  }
  // renderExpansionPage 自己按页切片：receiptTexts 传全量数组（隐藏槽位为 undefined）。
  const pageSize = AGG_VOUCHER_PAGE_SIZE
  const pageCount = Math.max(1, Math.ceil(entry.memberSeqs.length / pageSize))
  const clampedPage = Math.min(Math.max(1, page), pageCount)
  const rendered = renderExpansionPage({
    voucher: entry,
    receiptTexts: visibleTexts,
    forgottenMemberSeqs: hiddenSeqs,
    page: clampedPage,
    pageSize,
  })
  const lines = [rendered]
  if (hiddenRecordIds.length > 0) {
    lines.push(`另有 ${hiddenRecordIds.length} 条成员已按遗忘账本隐藏（${hiddenRecordIds.slice(0, 3).join('、')}${hiddenRecordIds.length > 3 ? '…' : ''}）。`)
  }
  return { text: lines.join('\n'), entry, page: clampedPage, hidden: hiddenRecordIds }
}

/**
 * 重启对账：账本凭证未上表面 → pending（不动表面，安全）；表面凭证无账本条目 →
 * 从计划文件重放补账（计划里带有 voucherText/成员原文/相位卡）；计划也缺失 → 报
 * 损坏（expand 会拒绝分页渲染）。幂等：对齐过的不再动。
 */
export async function reconcileVouchers(deps) {
  const ledger = await loadHierarchy(deps.sessionDir)
  const surface = collectSurfaceVouchers(deps)
  const report = { pending: [], replayed: [], damaged: [], dropped: [], forgotten: [] }
  for (const [voucherId, entry] of ledger.vouchers) {
    if (!surface.has(voucherId)) report.pending.push(voucherId)
  }
  // 崩溃窗口 A：计划已存但表面替换未发生（凭证不在账本也不在表面）→ 替换从未
  // 完成，成员回执原样在表面；丢弃陈旧计划，用户重跑 compress 即可。
  for (const plan of await loadVoucherPlans(deps.sessionDir)) {
    if (!ledger.vouchers.has(plan.voucherId) && !surface.has(plan.voucherId)) {
      await dropVoucherPlan(deps.sessionDir, plan.voucherId)
      report.dropped.push(plan.voucherId)
    }
  }
  let revision = ledger.revision
  for (const [voucherId, node] of surface) {
    if (ledger.vouchers.has(voucherId)) continue
    const plan = await getVoucherPlan(deps.sessionDir, voucherId)
    if (!plan) {
      report.damaged.push(voucherId)
      continue
    }
    // 重放前再验一次可见性（F-01 配套）：计划保存到重放之间可能发生遗忘。
    // 已遗忘成员的 fast/slow 路径都不得被重新写成 L1/L2；整条计划作废。
    const invisible = typeof deps.isRecordVisible === 'function'
      ? (Array.isArray(plan.recordIds) ? plan.recordIds : []).filter((recordId) => !deps.isRecordVisible(recordId))
      : []
    if (invisible.length > 0) {
      await dropVoucherPlan(deps.sessionDir, voucherId)
      report.forgotten.push({ voucherId, recordIds: invisible })
      continue
    }
    const entries = replayEntriesFromPlan({ plan, replacementSeq: node.seq, sourceRevision: revision, at: new Date().toISOString(), deps })
    const appended = await appendHierarchyEntries(deps.sessionDir, entries, { expectedRevision: revision })
    revision = appended.revision
    report.replayed.push(voucherId)
  }
  return report
}

/**
 * 从计划文件重放的账本批（复用 ledgerEntryBatch 的结构，证据来自计划快照）。
 *
 * 导出供测试直接钉住「重放同样受 shareL2Content 约束」：未共享正文时 L1 只写
 * 占位，绝不把计划快照里的成员原文搬进账本。
 */
export function replayEntriesFromPlan({ plan, replacementSeq, sourceRevision, at, deps }) {
  const memberTexts = Array.isArray(plan.memberTexts) ? plan.memberTexts : []
  // T1/F-03：重放同样受开关约束——未共享正文时 L1 只写占位，绝不把成员原文
  // 从计划快照搬进账本卡（否则「默认不复制正文」在崩溃重放路径上被绕过）。
  const shareContent = deps?.shareL2Content === true
  const l1Entries = (plan.recordIds ?? []).map((recordId, i) => {
    const placeholder = `（L1 占位：${recordId} 的正文未共享；用 expand/read 显式展开）`
    const text = shareContent
      ? (memberTexts[i] ?? `（重放占位：${recordId} 的原文不在计划快照里）`)
      : placeholder
    return {
      kind: HIERARCHY_ENTRY_L1,
      cardId: 'l1-' + recordId,
      recordId,
      text,
      tokens: estimateTokensOf(text),
      at,
    }
  })
  const l2Text = typeof plan.phaseCard === 'string' && plan.phaseCard
    ? plan.phaseCard
    : (shareContent && memberTexts.length > 0
      ? memberTexts.join('\n')
      : `（重放占位：凭证 ${plan.voucherId} 的阶段卡不在计划快照里）`)
  const entries = [
    ...l1Entries,
    {
      kind: HIERARCHY_ENTRY_L2,
      cardId: 'l2-' + plan.voucherId,
      phaseKey: plan.voucherId,
      phaseLabel: `阶段 ${plan.startSeq}-${plan.endSeq}`,
      sourceRecordIds: [...plan.recordIds],
      text: l2Text,
      tokens: estimateTokensOf(l2Text),
      blocks: [],
      templateShared: true,
      at,
    },
    {
      kind: HIERARCHY_ENTRY_L3,
      indexId: 'l3-' + plan.voucherId,
      phases: [{ phaseKey: plan.voucherId, cardId: 'l2-' + plan.voucherId, leafCount: plan.memberCount }],
      leafIds: [...plan.recordIds],
      text: renderTaskIndex({ summaryId: 'l3-' + plan.voucherId, phases: [{ phaseKey: plan.voucherId, cardId: 'l2-' + plan.voucherId, leafCount: plan.memberCount }] }),
      at,
    },
    {
      kind: HIERARCHY_ENTRY_VOUCHER,
      voucherId: plan.voucherId,
      startSeq: plan.startSeq,
      endSeq: plan.endSeq,
      replacementSeq,
      memberSeqs: [...plan.memberSeqs],
      recordIds: [...plan.recordIds],
      memberTexts: [...memberTexts],
      templateShared: true,
      // 计划快照必带 voucherText；缺（旧版计划/手工构造）时退回成员原文拼接，
      // 仍为空则给确定性占位——账本 text 校验要求非空字符串。
      text: typeof plan.voucherText === 'string' && plan.voucherText
        ? plan.voucherText
        : (memberTexts.filter((t) => typeof t === 'string' && t).join('\n') || `（聚合凭证 ${plan.voucherId}，正文从计划快照缺失）`),
      at,
    },
    {
      kind: HIERARCHY_ENTRY_RUN,
      runId: 'reconcile-replay:' + plan.voucherId,
      phaseKey: plan.voucherId,
      outcome: RUN_OUTCOME_SKIPPED,
      sourceRevision: Number.isInteger(sourceRevision) ? sourceRevision : 0,
      text: `对账重放 ${plan.voucherId}：表面凭证已存在，按计划补账。`,
      note: 'reconcile-replay: ledger entry missing after surface replacement',
      at,
    },
  ]
  return entries
}

/**
 * 阶段调度：宿主没有可靠的阶段接口（P0 探针结论），压缩阶段挂在插件自己的事
 * 务点上——归档批次提交之后调用本函数。默认关闭；开启时只在出现未应用且可收
 * 益的候选时执行一次 run（与手动 compress run 同一条事务路径）。
 */
export async function maybeStageCompress(deps, { enabled } = { enabled: false }) {
  if (!enabled) return { triggered: false, reason: 'disabled' }
  const { candidates } = await computeCandidates(deps)
  const ready = candidates.filter((c) => c.status === 'ready')
  if (ready.length === 0) return { triggered: false, reason: 'no-candidate' }
  const result = await compressRun(deps)
  return { triggered: true, applied: result.applied.length, rejected: result.rejected.length, failures: result.failures.length }
}

/** 测试与状态面共用的辅助：把 hierarchy-store 的 fold 错误转成可读消息。 */
export function describeHierarchyError(error) {
  if (error instanceof HierarchyStoreError) return `层级账本错误：${error.message}`
  return error?.message ?? String(error)
}

export { foldHierarchy, loadHierarchy, AGG_VOUCHER_MARKER, AGG_VOUCHER_MIN_RUN, AGG_VOUCHER_MAX_RUN, AGG_VOUCHER_PAGE_SIZE, voucherIdOf, HIERARCHY_RUN_OUTCOMES, dropVoucherPlan }