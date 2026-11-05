/**
 * 覆盖判定（domain/visibility，G6b / C-V-01 §3）。
 *
 * ## 唯一权威：活动面节点表
 * 判据只有结构证据——「某个活动面节点的 `sourceEventSeqs` 是否覆盖片段来源 seq」
 * （P0 §2.1/§2.2：下一请求的消息来自 surface 投影，replace 的 sourceEventSeqs 必须
 * 密集覆盖被遮蔽节点）。文本相等、序号邻近、时间流逝都**不是**证据（合同级反例）。
 *
 * ## 判定顺序（合同优先级，命中即返回）
 * `forgotten > not-applicable > visible-surface > visible-restored > visible-recall-pack
 *  > hidden-receipt > absent > unknown`
 *
 * ## 跳数
 * 只允许两跳（`VISIBILITY_LIMITS.proofDepth`）：恢复节点的标准形态是
 * `shadow(restore) = [receiptSeq]`，而 `receiptSeq` 的 shadow 才覆盖原记录。更深
 * 的链不加推测，落 `unknown`（`proof-depth-exceeded`）。
 *
 * ## U-V6 残余（R-8）
 * 恢复事件的 `sourceEventSeqs` 恒为 `[targetEventId]`（dsh-host 源码事实），但凭证里的
 * `targetEventId` 只在**首次落面**时有效：宿主侧若先按正文找到别的合格节点，链就闭合
 * 不上 → `unknown`（安全方向：宁可重复注入）。这里不猜「它大概是同一张回执」。
 *
 * ## 回注包（R-10）
 * - 有界登记命中（`recallRegistry` 的 seq/bodyId ↔ recordIds）→ `visible-recall-pack`
 *   / observed；
 * - 只解析插件自产包正文 → **只作 unknown 的补充证据**，永不产出 `visible: true`
 *   （混入宿主面的文本会造成假 visible）；
 * - 包在面上但登记解不出 → `unknown`（`recall-registry-miss`），不是 absent。
 */
import {
  VISIBILITY_CLAIM,
  VISIBILITY_CONTRACT_VERSION,
  VISIBILITY_LIMITS,
  VISIBILITY_LOG_ONLY_EVENT_TYPES,
  VISIBILITY_STATES,
  assertVisibilityVerdict,
} from '../../contracts/visibility.mjs'
import { PLUGIN_SOURCE_KIND, RECALL_SOURCE_FORM, RECEIPT_SOURCE_FORM, RESTORE_SOURCE_FORM } from '../../contracts/sources.mjs'
import { V3ContractViolation } from '../../contracts/errors.mjs'
import { dedupeKeyOf } from './fragments.mjs'
import { resolveVisibilitySnapshot } from './snapshot.mjs'
import { VISIBILITY_UNAVAILABLE_DIGEST, visibilityEpochOf } from './epoch.mjs'

/** 判定优先级（合同 §3.1；顺序本身是可断言的合同数据）。 */
export const VISIBILITY_PRIORITY = Object.freeze([
  'forgotten',
  'not-applicable',
  'visible-surface',
  'visible-restored',
  'visible-recall-pack',
  'hidden-receipt',
  'absent',
  'unknown',
])

function stateRank(state) {
  const index = VISIBILITY_PRIORITY.indexOf(state)
  return index < 0 ? VISIBILITY_PRIORITY.length : index
}

/**
 * 构造判定回执（唯一构造点）：状态与 visible 的对应关系在这里写死，
 * 越界/矛盾由 `assertVisibilityVerdict` 拒绝（R-1 断言）。
 */
function verdictOf({ dedupeKey, visibilityDigest, state, cause, evidence }) {
  if (!VISIBILITY_STATES.includes(state)) {
    throw new V3ContractViolation('v3 visibility: 未知判定状态 ' + JSON.stringify(state))
  }
  const visible = state === 'unknown' ? null : state.startsWith('visible-')
  const proof = state === 'unknown' ? 'unknown' : 'observed'
  return assertVisibilityVerdict({
    contractVersion: VISIBILITY_CONTRACT_VERSION,
    claim: VISIBILITY_CLAIM,
    dedupeKey,
    visibilityDigest,
    state,
    visible,
    proof,
    cause: cause ?? null,
    evidence: (evidence ?? []).slice(0, VISIBILITY_LIMITS.evidenceMax),
  })
}

/** 遮蔽节点的隐藏通道（R-7 四通道，只按可观测形状归因，不推断意图）。 */
function hiddenCauseOf(snapshot, nodeSeq) {
  const voucher = snapshot.voucherByReceipt.get(nodeSeq)
  if (voucher !== undefined) return { cause: 'plugin-archive', voucher }
  const event = snapshot.events.get(nodeSeq)
  if (event?.type === 'system/message') return { cause: 'system-message', voucher: null }
  if (event?.sourceKind === PLUGIN_SOURCE_KIND && event?.sourceForm === RECEIPT_SOURCE_FORM) {
    return { cause: 'plugin-archive', voucher: null }
  }
  return { cause: (event?.shadow.length ?? 0) >= 2 ? 'host-compaction' : 'host-prune', voucher: null }
}

function hiddenEvidence(snapshot, nodeSeq) {
  const channel = hiddenCauseOf(snapshot, nodeSeq)
  const evidence = [{ kind: 'shadow-link', seq: nodeSeq, id: null }]
  if (channel.voucher !== null) evidence.push({ kind: 'voucher', seq: null, id: channel.voucher.voucherId })
  return { cause: channel.cause, evidence }
}

/**
 * 恢复链闭合检查：`receiptSeq` 是恢复节点遮蔽的那张回执。
 * 凭证必须存在（`voucher-missing`）且包含本记录（`restore-chain-unclosed`）。
 */
function restoreChainOf(snapshot, restoreSeq, receiptSeq, recordId) {
  const voucher = snapshot.voucherByReceipt.get(receiptSeq)
  const evidence = [
    { kind: 'restore-node', seq: restoreSeq, id: null },
    { kind: 'shadow-link', seq: receiptSeq, id: null },
  ]
  if (voucher === undefined) return { ok: false, cause: 'voucher-missing', evidence }
  evidence.push({ kind: 'voucher', seq: null, id: voucher.voucherId })
  if (!voucher.recordIds.includes(recordId)) return { ok: false, cause: 'restore-chain-unclosed', evidence }
  return { ok: true, evidence }
}

/** 回注包判定：登记命中 = observed；只解析正文 = unknown 的补充证据（R-10）。 */
function recallPackVerdictOf(snapshot, recordId) {
  let parsed = null
  let unresolved = false
  for (const nodeSeq of snapshot.nodes) {
    const event = snapshot.events.get(nodeSeq)
    if (event?.sourceForm !== RECALL_SOURCE_FORM) continue
    const registered = snapshot.registry === null
      ? undefined
      : snapshot.registry.find((entry) => entry.seq === nodeSeq || (entry.bodyId !== null && event.text !== null && event.text.includes(entry.bodyId)))
    if (registered !== undefined && registered.recordIds.includes(recordId)) {
      return {
        kind: 'visible',
        evidence: [
          { kind: 'recall-pack', seq: nodeSeq, id: registered.bodyId },
          { kind: 'surface-node', seq: nodeSeq, id: null },
        ],
      }
    }
    if (registered === undefined) unresolved = true
    if (parsed === null && event.text !== null && event.text.includes(recordId)) parsed = nodeSeq
  }
  if (parsed !== null) {
    // 只作补充证据：解析自产包正文不足以支撑 visible:true（假 visible 风险）。
    return { kind: 'unknown', cause: 'recall-pack-parsed', evidence: [{ kind: 'recall-pack', seq: parsed, id: null }] }
  }
  if (unresolved) {
    return { kind: 'unknown', cause: 'recall-registry-miss', evidence: [{ kind: 'recall-pack', seq: null, id: null }] }
  }
  return null
}

/**
 * 单个片段判定（内部；所有分支都经由 `verdictOf`）。
 * @returns {object} 判定回执（未做归档意图强制）
 */
function judgeFragment(snapshot, fragment, dedupeKey, visibilityDigest) {
  const recordId = fragment.id
  if (snapshot.forgotten.has(recordId)) {
    return verdictOf({
      dedupeKey,
      visibilityDigest,
      state: 'forgotten',
      cause: 'forgotten',
      evidence: [{ kind: 'forgotten', seq: null, id: recordId }],
    })
  }
  const sourceSeq = snapshot.recordSeq.get(recordId)
  if (sourceSeq === undefined || sourceSeq === null) {
    return verdictOf({ dedupeKey, visibilityDigest, state: 'unknown', cause: 'provenance-unknown', evidence: [] })
  }
  const sourceEvent = snapshot.events.get(sourceSeq)
  if (sourceEvent !== undefined && sourceEvent.type !== null && VISIBILITY_LOG_ONLY_EVENT_TYPES.includes(sourceEvent.type)) {
    return verdictOf({
      dedupeKey,
      visibilityDigest,
      state: 'not-applicable',
      cause: 'not-applicable',
      evidence: [{ kind: 'surface-node', seq: sourceSeq, id: null }],
    })
  }
  if (snapshot.nodeSet.has(sourceSeq)) {
    return verdictOf({
      dedupeKey,
      visibilityDigest,
      state: 'visible-surface',
      cause: null,
      evidence: [{ kind: 'surface-node', seq: sourceSeq, id: null }],
    })
  }

  // 收集覆盖候选（跳数 ≤ proofDepth）。
  const directCover = []
  const nestedCover = []
  for (const nodeSeq of snapshot.nodes) {
    const event = snapshot.events.get(nodeSeq)
    if (event === undefined || event.shadow.length === 0) continue
    if (event.shadow.includes(sourceSeq)) {
      directCover.push(nodeSeq)
      continue
    }
    // 两跳只对恢复节点成立（合同 §3.2 步骤 4）：恢复节点遮蔽回执，回执的 shadow 才
    // 覆盖原记录。宿主侧的其它两层遮蔽不是「内容可见」的证据，按未覆盖处理（V5）。
    if (VISIBILITY_LIMITS.proofDepth < 2) continue
    if (event.sourceForm !== RESTORE_SOURCE_FORM) continue
    for (const inner of event.shadow) {
      const innerEvent = snapshot.events.get(inner)
      if (innerEvent === undefined) continue
      if (innerEvent.shadow.includes(sourceSeq)) {
        nestedCover.push({ node: nodeSeq, inner })
        break
      }
    }
  }
  // 证明跳数上界（VISIBILITY_LIMITS.proofDepth = 2）：更深的遮蔽链**不推测**——
  // 链上全是遮蔽节点时内容一定不可见（absent），只是我们不再追层；若深层可能藏着
  // 「恢复」节点，本实现会选择多注入一次而不是猜可见（安全方向，见证据 §已知偏差）。
  const candidates = []
  const pack = recallPackVerdictOf(snapshot, recordId)
  if (pack !== null && pack.kind === 'visible') {
    candidates.push({ state: 'visible-recall-pack', cause: 'recall-registry-hit', evidence: pack.evidence })
  } else if (pack !== null) {
    candidates.push({ state: 'unknown', cause: pack.cause, evidence: pack.evidence })
  }
  for (const nodeSeq of directCover) {
    const event = snapshot.events.get(nodeSeq)
    if (event.sourceForm === RESTORE_SOURCE_FORM) {
      if (event.shadow.length !== 1) {
        candidates.push({ state: 'unknown', cause: 'restore-chain-unclosed', evidence: [{ kind: 'shadow-link', seq: nodeSeq, id: null }] })
        continue
      }
      const chain = restoreChainOf(snapshot, nodeSeq, event.shadow[0], recordId)
      if (chain.ok) candidates.push({ state: 'visible-restored', cause: null, evidence: chain.evidence })
      else candidates.push({ state: 'unknown', cause: chain.cause, evidence: chain.evidence })
      continue
    }
    candidates.push({ state: 'hidden-receipt', ...hiddenEvidence(snapshot, nodeSeq) })
  }
  for (const { node, inner } of nestedCover) {
    const event = snapshot.events.get(node)
    if (event.sourceForm === RESTORE_SOURCE_FORM && event.shadow.length === 1) {
      // 恢复节点遮蔽的是回执；回执自己的 shadow 才覆盖原记录（两跳标准形态）。
      const chain = restoreChainOf(snapshot, node, inner, recordId)
      if (chain.ok) candidates.push({ state: 'visible-restored', cause: null, evidence: chain.evidence })
      else candidates.push({ state: 'unknown', cause: chain.cause, evidence: chain.evidence })
      continue
    }
    candidates.push({ state: 'hidden-receipt', ...hiddenEvidence(snapshot, node) })
  }

  if (candidates.length > 0) {
    // 合同优先级：visible-* > hidden-receipt > unknown（absent 只在无候选时成立）。
    candidates.sort((a, b) => stateRank(a.state) - stateRank(b.state))
    const best = candidates[0]
    return verdictOf({ dedupeKey, visibilityDigest, state: best.state, cause: best.cause, evidence: best.evidence })
  }
  return verdictOf({ dedupeKey, visibilityDigest, state: 'absent', cause: 'not-covered', evidence: [] })
}

/**
 * 归档意图强制（R-6）：pending/invalid/unreadable 时，**不可见类**结论（absent /
 * hidden-receipt）一律改判 unknown——不得把「可能正在变」写成确定的「不可见」。
 * 结构性强证据（visible-surface / visible-restored / not-applicable）与 forgotten 不受影响。
 */
function coerceByArchiveIntent(snapshot, verdict) {
  const intent = snapshot.archiveIntent
  if (intent === 'absent') return verdict
  if (verdict.state !== 'absent' && verdict.state !== 'hidden-receipt') return verdict
  const cause = intent === 'pending' ? 'archive-intent-pending'
    : intent === 'invalid' ? 'archive-intent-invalid'
      : 'archive-intent-unreadable'
  return verdictOf({
    dedupeKey: verdict.dedupeKey,
    visibilityDigest: verdict.visibilityDigest,
    state: 'unknown',
    cause,
    evidence: [...verdict.evidence, { kind: 'archive-intent', seq: null, id: null }],
  })
}

/**
 * 批量判定（只读；顺序与入参一致）。
 * @param {object} input {snapshot, fragments, sessionKey?}
 * @returns {{ok:boolean, degraded:boolean, reason:string|null, digest:string, verdicts:object[]}}
 */
export function visibilityOf({ snapshot, fragments = [], sessionKey = null } = {}) {
  if (!Array.isArray(fragments)) {
    throw new V3ContractViolation('v3 visibility: fragments 必须是数组')
  }
  if (fragments.length > VISIBILITY_LIMITS.fragmentBatch) {
    throw new V3ContractViolation('v3 visibility: 单批片段不得超过 ' + VISIBILITY_LIMITS.fragmentBatch + ' 条（批量接口有界，不做游标）')
  }
  const resolved = resolveVisibilitySnapshot(snapshot)
  const keySession = typeof sessionKey === 'string' && sessionKey.length > 0
    ? sessionKey
    : (resolved.ok ? resolved.snapshot.sessionKey : null)
  if (typeof keySession !== 'string' || keySession.length === 0) {
    throw new V3ContractViolation('v3 visibility: 判定需要非空 sessionKey（跨会话不共享去重键）')
  }
  const normal = resolved.ok ? resolved.snapshot : null
  // P2-1：**快照所属会话也参与跨会话判定**。只看片段上的 sessionKey 不够——recall 路径
  // 的片段不带会话字段，一旦 snapshot 来自别的会话（接线错、跨会话复用端口），
  // 单看片段会把 B 的活动面当成 A 的证据。整批落 unknown（宁可多注入，不误判可见）。
  const crossSession = normal !== null && normal.sessionKey !== null && normal.sessionKey !== keySession
  const epoch = visibilityEpochOf(normal)
  const digest = epoch.digest
  const verdicts = []
  for (const fragment of fragments) {
    const key = dedupeKeyOf(keySession, fragment)
    if (!resolved.ok) {
      verdicts.push(verdictOf({ dedupeKey: key, visibilityDigest: VISIBILITY_UNAVAILABLE_DIGEST, state: 'unknown', cause: 'surface-unreadable', evidence: [] }))
      continue
    }
    if (crossSession || (typeof fragment?.sessionKey === 'string' && normal.sessionKey !== null && fragment.sessionKey !== normal.sessionKey)) {
      verdicts.push(verdictOf({ dedupeKey: key, visibilityDigest: digest, state: 'unknown', cause: 'session-mismatch', evidence: [] }))
      continue
    }
    const judged = judgeFragment(normal, fragment, key, digest)
    verdicts.push(coerceByArchiveIntent(normal, judged))
  }
  return {
    ok: resolved.ok,
    degraded: !resolved.ok || crossSession,
    crossSession,
    reason: resolved.ok ? (crossSession ? 'session-mismatch' : null) : 'surface-unreadable',
    digest,
    verdicts,
  }
}
