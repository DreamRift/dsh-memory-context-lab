/**
 * 归档候选的重验证合同（domain/archive，纯函数，0.15.0 P4）。
 *
 * 为什么需要独立一层：工具面（inspect/prepare/submit）与自动归档必须**共用同一判据**——
 * 「同一快照的 inspect 可执行性 = 真正提交时的可执行性」（P4 验收）。差异只允许有
 * 一处实现，否则工具说「可提交」、提交时又被别处拒绝。
 *
 * 漂移口径（§6.2 / §3.3 第 7 条）：
 * - **允许**：尾部追加（候选范围之外新增节点、全局 epoch 变化但候选节点未变）；
 * - **拒绝**：候选范围内节点改写/遮蔽、来源记录 hash 变化、保护集合变化
 *   （相关 pin/读租约）、来源被遗忘（forget generation 变化）、策略版本变化。
 *
 * 指纹本身由调用方用注入的 sha256 算好（domain 不碰 node:crypto）；
 * 本模块只定义「哪些字段构成身份」与「怎样比较」。
 */
import { V3ContractViolation } from '../../contracts/errors.mjs'

/** 策略版本：判据/预算口径变化时递增；旧提案会因版本不符而失效（不复活旧计划）。 */
export const ARCHIVE_POLICY_VERSION = 1

/** 候选身份的字段集合（唯一真源；计划对象/提案对象都按它构造）。 */
export const CANDIDATE_IDENTITY_FIELDS = Object.freeze([
  'policyVersion', 'startSeq', 'endSeq', 'sourceEventSeqs', 'recordIds',
  'sourceHashes', 'surfaceFingerprint', 'protectionFingerprint', 'forgetFingerprint',
])

function sameStringArray(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false
  return true
}

/** 来源 hash 表：数组 [{recordId, hash}]，按 recordId 排序后比较（顺序不是身份）。 */
function normalizeHashes(list) {
  if (!Array.isArray(list)) return null
  return list
    .filter((row) => row !== null && typeof row === 'object' && typeof row.recordId === 'string' && typeof row.hash === 'string')
    .map((row) => ({ recordId: row.recordId, hash: row.hash }))
    .sort((a, b) => (a.recordId < b.recordId ? -1 : a.recordId > b.recordId ? 1 : 0))
}

/**
 * 候选身份的稳定物化（用于 hash / 台账比对）。
 * 只覆盖 CANDIDATE_IDENTITY_FIELDS——回执文本、摘要文本不参与身份（它们随后一次呈现固化）。
 */
export function canonicalPlanMaterial(plan) {
  if (plan === null || typeof plan !== 'object') throw new V3ContractViolation('v3 archive/plan: 需要候选对象')
  return JSON.stringify({
    policyVersion: plan.policyVersion,
    startSeq: plan.startSeq,
    endSeq: plan.endSeq,
    sourceEventSeqs: Array.isArray(plan.sourceEventSeqs) ? [...plan.sourceEventSeqs] : null,
    recordIds: Array.isArray(plan.recordIds) ? [...plan.recordIds] : null,
    sourceHashes: normalizeHashes(plan.sourceHashes),
    surfaceFingerprint: plan.surfaceFingerprint,
    protectionFingerprint: plan.protectionFingerprint,
    forgetFingerprint: plan.forgetFingerprint,
  })
}

/**
 * 比较「已准备候选」与「当前快照」。
 *
 * @param {object} prepared 提案里保存的候选身份
 * @param {object} current 提交边界重新计算的候选身份
 * @returns {{ok:boolean, reasons:string[]}} reasons 是机器码封闭集（不拼接正文）
 */
export function comparePlanSnapshots(prepared, current) {
  if (prepared === null || typeof prepared !== 'object' || current === null || typeof current !== 'object') {
    throw new V3ContractViolation('v3 archive/plan: 比较需要两个候选对象')
  }
  const reasons = []
  if (prepared.policyVersion !== current.policyVersion) reasons.push('policy-version-changed')
  if (prepared.startSeq !== current.startSeq || prepared.endSeq !== current.endSeq) reasons.push('candidate-range-changed')
  if (!sameStringArray(prepared.sourceEventSeqs, current.sourceEventSeqs)) reasons.push('source-events-changed')
  if (!sameStringArray(prepared.recordIds, current.recordIds)) reasons.push('record-set-changed')
  if (JSON.stringify(normalizeHashes(prepared.sourceHashes)) !== JSON.stringify(normalizeHashes(current.sourceHashes))) {
    reasons.push('source-hash-changed')
  }
  if (prepared.surfaceFingerprint !== current.surfaceFingerprint) reasons.push('surface-drift')
  if (prepared.protectionFingerprint !== current.protectionFingerprint) reasons.push('protection-changed')
  if (prepared.forgetFingerprint !== current.forgetFingerprint) reasons.push('forget-changed')
  return { ok: reasons.length === 0, reasons }
}
