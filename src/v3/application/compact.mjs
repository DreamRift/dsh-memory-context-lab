/**
 * 压缩提案用例（application/compact，0.15.0 P4）。
 *
 * 生命周期（开发流程 §6.2）：
 *   inspect → 候选快照（只读，0 写）
 *   prepare → prepared（已验证形状/来源 + 摘要已物化，尚未归档）
 *   submit  → accepted（持久化待执行）——**绝不**在这里改活动面，也绝不报 committed
 *   下一安全边界 → 重验证 → 既有 intent/voucher 事务 → committed / stale
 *
 * 关键安全边界：
 * - 提案只是可过期意图，不占 archive-intent 槽；只有真正执行归档时才占槽；
 * - 同一幂等键同载荷返回同提案；不同载荷拒绝（不静默改成第二个提案）；
 * - 重验证在提交边界由调用方（entry）用**同一份 planner + domain 判据**完成；
 *   本模块只负责判定 accepted/stale 与台账持久化；
 * - 重启后 pending 由事件流折叠恢复，再逐项重验证——不把旧计划强行复活。
 */
import { V3ContractViolation } from '../contracts/index.mjs'
import { canonicalPlanMaterial, comparePlanSnapshots, ARCHIVE_POLICY_VERSION, CANDIDATE_IDENTITY_FIELDS } from '../domain/archive/plan-fingerprints.mjs'
import { normalizeSummaryDraft } from '../domain/compress/summary-artifact.mjs'

const HEX_OF_UUID = (uuid) => String(uuid).replace(/-/g, '').toLowerCase()

/** 提案默认有效期（毫秒）：过期不自动复活，只可只读查询。 */
export const PROPOSAL_TTL_MS = 15 * 60 * 1000

/** 候选身份字段（与 domain 的 CANDIDATE_IDENTITY_FIELDS 同源，构造时只取这些）。 */
function identityOf(candidate) {
  const out = {}
  for (const key of CANDIDATE_IDENTITY_FIELDS) out[key] = candidate?.[key] ?? null
  return out
}

/** 候选 ID：同快照 → 同 ID（inspect 可执行性与 commit 一致性靠它对齐）。 */
export function candidateIdOf(candidate, hash) {
  return 'cand-' + hash.sha256(canonicalPlanMaterial(candidate)).slice(0, 16)
}

/**
 * @param {object} deps
 * @param {object} deps.proposals compact-proposals 适配器 {append,read}
 * @param {object} deps.summary application/summary 服务
 * @param {{now:()=>number}} deps.clock
 * @param {{uuid:()=>string}} deps.random
 * @param {{sha256:(text:string)=>string}} deps.hash
 */
export function createCompactService({ proposals, summary, clock, random, hash } = {}) {
  if (proposals === null || typeof proposals?.append !== 'function' || typeof proposals?.read !== 'function') {
    throw new V3ContractViolation('v3 compact: 需要 proposals 适配器 {append,read}')
  }
  if (summary === null || typeof summary?.materialize !== 'function') throw new V3ContractViolation('v3 compact: 需要 summary 服务')
  if (clock === null || typeof clock?.now !== 'function') throw new V3ContractViolation('v3 compact: 需要 clock.now')
  if (random === null || typeof random?.uuid !== 'function') throw new V3ContractViolation('v3 compact: 需要 random.uuid')
  if (hash === null || typeof hash?.sha256 !== 'function') throw new V3ContractViolation('v3 compact: 需要 hash.sha256')

  function directoryOf(entry) {
    const directory = entry?.runtime?.store?.directory
    if (typeof directory !== 'string' || directory.length === 0) throw new V3ContractViolation('v3 compact: 会话目录不可用')
    return directory
  }

  function validateCandidate(candidate) {
    if (candidate === null || typeof candidate !== 'object') return { ok: false, reason: 'candidate-required' }
    if (candidate.policyVersion !== ARCHIVE_POLICY_VERSION) return { ok: false, reason: 'policy-mismatch' }
    if (!Number.isInteger(candidate.startSeq) || !Number.isInteger(candidate.endSeq) || candidate.endSeq < candidate.startSeq) {
      return { ok: false, reason: 'candidate-range-invalid' }
    }
    if (!Array.isArray(candidate.recordIds) || candidate.recordIds.length === 0) return { ok: false, reason: 'candidate-empty' }
    if (!Array.isArray(candidate.sourceEventSeqs) || candidate.sourceEventSeqs.length === 0) return { ok: false, reason: 'candidate-empty' }
    if (!Array.isArray(candidate.sourceHashes) || candidate.sourceHashes.length !== candidate.recordIds.length) {
      return { ok: false, reason: 'candidate-hashes-invalid' }
    }
    for (const field of ['surfaceFingerprint', 'protectionFingerprint', 'forgetFingerprint']) {
      if (typeof candidate[field] !== 'string' || candidate[field].length === 0) return { ok: false, reason: 'candidate-fingerprint-missing' }
    }
    return { ok: true }
  }

  async function storedState(entry) {
    const map = await proposals.read(directoryOf(entry))
    return map
  }

  /**
   * prepare：验证候选 + 物化摘要 + 落 prepared 事件（不改活动面、不占 intent 槽）。
   * @returns {Promise<object>} {ok,status,proposalId,candidateId,summaryId,summaryHash,expiresAt}
   */
  async function prepare({ entry, sessionKey, candidate, draft = null, idempotencyKey = null, ttlMs = PROPOSAL_TTL_MS } = {}) {
    const checked = validateCandidate(candidate)
    if (!checked.ok) return { ok: false, status: 'rejected', reason: checked.reason }
    const candidateId = candidateIdOf(candidate, hash)
    const key = typeof idempotencyKey === 'string' && idempotencyKey.length > 0 ? idempotencyKey : null
    // 幂等判据 = 键 + **载荷**（候选身份 + 摘要草稿规范化内容），不是只比键。
    // 只比键会让「同键不同摘要」静默复用第一份，等于把第二份草稿丢掉。
    let draftValue = null
    if (draft !== null && draft !== undefined) {
      const normalized = normalizeSummaryDraft(draft)
      if (!normalized.ok) return { ok: false, status: 'rejected', reason: 'draft-invalid', errors: normalized.errors }
      draftValue = normalized.value
    }
    const payloadFingerprint = hash.sha256(JSON.stringify({ candidateId, draft: draftValue }))
    const existing = await storedState(entry)
    for (const row of existing.values()) {
      if (key !== null && row.idempotencyKey === key) {
        if (row.candidateId === candidateId && row.payloadFingerprint === payloadFingerprint) {
          return { ok: true, status: row.status, proposalId: row.proposalId, candidateId, reused: true, summaryId: row.summaryId ?? null, expiresAt: row.expiresAt ?? null }
        }
        return { ok: false, status: 'rejected', reason: 'idempotency-conflict' }
      }
    }
    const materialized = await summary.materialize({
      entry,
      sessionKey,
      recordIds: candidate.recordIds,
      generator: draftValue === null ? 'extractive' : 'model',
      draft: draftValue,
      idempotencyKey: key === null ? null : 'summary-' + key,
    })
    if (materialized?.ok !== true) return { ok: false, status: 'rejected', reason: materialized?.reason ?? 'summary-failed', errors: materialized?.errors }
    const proposalId = 'v3p-' + HEX_OF_UUID(random.uuid()).slice(0, 16)
    const now = clock.now()
    const event = {
      type: 'proposal/prepared',
      proposalId,
      candidateId,
      idempotencyKey: key,
      payloadFingerprint,
      candidate: identityOf(candidate),
      // 回执文案要素（回合数/步骤数）随提案保存：提交边界重渲染时必须与 inspect 同源，
      // 又不能从候选身份字段推出（它们不参与身份）。
      display: {
        operations: Number.isInteger(candidate.operations) ? candidate.operations : 0,
        unitLabel: typeof candidate.unitLabel === 'string' ? candidate.unitLabel : '操作数',
        // 恢复体积取自统一 planner 的观测值（工具参数块也算恢复正文）；缺失如实 null。
        restoreChars: Number.isInteger(candidate.restoreChars) ? candidate.restoreChars : null,
      },
      summaryId: materialized.artifact.summaryId,
      summaryHash: summary.fingerprintOf(materialized.artifact),
      at: now,
      expiresAt: now + ttlMs,
    }
    const written = await proposals.append(directoryOf(entry), event, {
      guard: async () => {
        // 锁内只复核「来源仍可读」：真正的内容漂移留到提交边界重验证（有完整判据）。
        const forgotten = new Set(typeof entry.runtime.store.listForgotten === 'function' ? entry.runtime.store.listForgotten() : [])
        for (const id of candidate.recordIds) if (forgotten.has(id)) return { ok: false, reason: 'source-forgotten' }
        return { ok: true }
      },
    })
    if (written?.ok === false) return { ok: false, status: 'rejected', reason: written.reason }
    return {
      ok: true, status: 'prepared', proposalId, candidateId,
      summaryId: materialized.artifact.summaryId,
      summaryHash: event.summaryHash,
      expiresAt: event.expiresAt,
    }
  }

  /**
   * submit：把提案置为 accepted（**待执行**），不改变活动面。
   *
   * @param {object} input
   * @param {Function} [input.revalidate] async (candidate) => {ok, reasons[]}
   *   提交边界调用方提供的重验证（候选范围/来源 hash/保护/forget 代际）。
   *   submit 时先验证一次，避免把一个已经失效的计划写成 accepted；下一次 pre-step
   *   仍会用同一判据再验证（两次之间发生漂移 → stale）。
   */
  async function submit({ entry, sessionKey, candidate = null, draft = null, idempotencyKey = null, proposalId = null, ttlMs = PROPOSAL_TTL_MS, revalidate = null } = {}) {
    const state = await storedState(entry)
    let proposal = proposalId === null ? null : state.get(proposalId) ?? null
    if (proposalId !== null && proposal === null) return { ok: false, status: 'rejected', reason: 'proposal-not-found' }
    if (proposal === null) {
      // 无 proposalId：可直接带候选提交（§6.2：prepare 是可选预检）。
      const prepared = await prepare({ entry, sessionKey, candidate, draft, idempotencyKey, ttlMs })
      if (prepared.ok !== true) return prepared
      proposal = (await storedState(entry)).get(prepared.proposalId) ?? null
      if (proposal === null) return { ok: false, status: 'rejected', reason: 'proposal-not-persisted' }
    }
    if (proposal.status === 'committed') return { ok: true, status: 'committed', proposalId: proposal.proposalId, committed: true, receiptSeq: proposal.receiptSeq ?? null, alreadyCommitted: true }
    if (proposal.status === 'stale') return { ok: true, status: 'stale', proposalId: proposal.proposalId, reasons: proposal.reasons ?? [] }
    // P2-2：过期检查必须**先于** accepted 复用。旧顺序让「已 accepted 但已过期」的提案
    // 永远走幂等分支返回 accepted，过期事实只在 status 读面显示，submit 仍说可执行。
    // 过期是终态迁移（stale），不得再复用为 accepted。
    if (Number.isFinite(proposal.expiresAt) && clock.now() > proposal.expiresAt) {
      await markStale({ entry, proposalId: proposal.proposalId, reason: 'expired' })
      return { ok: true, status: 'stale', proposalId: proposal.proposalId, reasons: ['expired'] }
    }
    // 幂等：同提案重复 submit 不再追加事件（除 prepared 外没有别的 pending 事件）。
    if (proposal.status === 'accepted') {
      return { ok: true, status: 'accepted', proposalId: proposal.proposalId, candidateId: proposal.candidateId, expiresAt: proposal.expiresAt, committed: false, accepted: true, reused: true }
    }
    if (typeof revalidate === 'function') {
      const verdict = await revalidate(proposal.candidate)
      if (verdict?.ok !== true) {
        await markStale({ entry, proposalId: proposal.proposalId, reason: 'drift', reasons: verdict?.reasons ?? [] })
        return { ok: true, status: 'stale', proposalId: proposal.proposalId, reasons: verdict?.reasons ?? [] }
      }
    }
    const event = { type: 'proposal/accepted', proposalId: proposal.proposalId, candidateId: proposal.candidateId, at: clock.now(), expiresAt: proposal.expiresAt ?? clock.now() + ttlMs }
    const written = await proposals.append(directoryOf(entry), event)
    if (written?.ok === false) return { ok: false, status: 'rejected', reason: written.reason }
    return { ok: true, status: 'accepted', proposalId: proposal.proposalId, candidateId: proposal.candidateId, expiresAt: event.expiresAt, committed: false, accepted: true }
  }

  /** 只读状态：永不把 accepted 升级成 committed（committed 只能由真实凭证事件写入）。 */
  async function status({ entry, proposalId } = {}) {
    const state = await storedState(entry)
    const proposal = state.get(proposalId)
    if (proposal === undefined) return { ok: false, reason: 'proposal-not-found' }
    // 过期是**派生事实**：读面如实显示 stale，但不写台账（status 只读）；
    // 真正提交/重试时由 submit 或边界重验证落 stale 事件。
    const expired = proposal.status === 'accepted' && Number.isFinite(proposal.expiresAt) && clock.now() > proposal.expiresAt
    return {
      ok: true,
      proposalId: proposal.proposalId,
      status: expired ? 'stale' : proposal.status,
      candidateId: proposal.candidateId ?? null,
      summaryId: proposal.summaryId ?? null,
      committed: proposal.status === 'committed',
      receiptSeq: proposal.receiptSeq ?? null,
      voucherId: proposal.voucherId ?? null,
      reasons: expired ? ['expired'] : (proposal.reasons ?? []),
      expiresAt: proposal.expiresAt ?? null,
      createdAt: proposal.at ?? null,
    }
  }

  /** 待执行提案（accepted 且未过期；重启后由事件流折叠恢复）。 */
  async function pending({ entry } = {}) {
    const state = await storedState(entry)
    const now = clock.now()
    const rows = []
    for (const proposal of state.values()) {
      if (proposal.status !== 'accepted') continue
      if (Number.isFinite(proposal.expiresAt) && now > proposal.expiresAt) continue
      rows.push(proposal)
    }
    rows.sort((a, b) => (a.at ?? 0) - (b.at ?? 0))
    return rows
  }

  /** 真实凭证落账后记 committed（由归档提交路径调用）。 */
  async function markCommitted({ entry, proposalId, result } = {}) {
    const event = {
      type: 'proposal/committed',
      proposalId,
      candidateId: result?.candidateId ?? null,
      summaryId: result?.summaryId ?? null,
      voucherId: result?.voucherId ?? null,
      receiptSeq: Number.isInteger(result?.receiptSeq) ? result.receiptSeq : null,
      at: clock.now(),
    }
    return await proposals.append(directoryOf(entry), event)
  }

  /** 标记失效（漂移/过期/来源被忘）。 */
  async function markStale({ entry, proposalId, reason = 'stale', reasons = [] } = {}) {
    const event = { type: 'proposal/stale', proposalId, reason, reasons: [...reasons], at: clock.now() }
    return await proposals.append(directoryOf(entry), event)
  }

  /**
   * 迟到摘要（不在提交截止前就绪的模型草稿）：新建不可变摘要对象，
   * **不改旧回执、不改旧摘要**；只追加 late-summary 事件供检索面使用。
   */
  async function noteLateSummary({ entry, sessionKey, candidate, draft, idempotencyKey = null } = {}) {
    if (draft === null || draft === undefined) return { ok: false, reason: 'draft-required' }
    const existing = await storedState(entry)
    const candidateId = candidate === null ? null : candidateIdOf(candidate, hash)
    let base = null
    for (const proposal of existing.values()) {
      if (candidateId !== null && proposal.candidateId === candidateId) base = base ?? proposal
    }
    const materialized = await summary.materialize({
      entry,
      sessionKey,
      recordIds: candidate?.recordIds ?? [],
      generator: 'model',
      draft,
      idempotencyKey: typeof idempotencyKey === 'string' ? 'late-' + idempotencyKey : null,
      baseSummaryId: base?.summaryId ?? null,
      baseRevision: 1,
      supersedes: base?.summaryId ?? null,
    })
    if (materialized?.ok !== true) return materialized
    const proposalId = base?.proposalId ?? 'v3p-' + HEX_OF_UUID(random.uuid()).slice(0, 16)
    await proposals.append(directoryOf(entry), {
      type: 'proposal/late-summary',
      proposalId,
      candidateId,
      summaryId: materialized.artifact.summaryId,
      summaryHash: summary.fingerprintOf(materialized.artifact),
      at: clock.now(),
    })
    return { ok: true, status: 'late-recorded', proposalId, summaryId: materialized.artifact.summaryId, committed: false }
  }

  /**
   * 提交边界重验证（唯一判据入口）：调用方给出当前快照，本函数用 domain
   * comparePlanSnapshots 逐字段比较。返回 {ok,reasons}。
   */
  function verifySnapshot(prepared, current) {
    return comparePlanSnapshots(prepared, current)
  }

  return { prepare, submit, status, pending, markCommitted, markStale, noteLateSummary, verifySnapshot }
}
