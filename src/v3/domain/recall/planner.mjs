/**
 * P3-C 私有 DTO（不是公共 schema；字段封闭，未知字段拒绝）。
 *
 * 输入 PlanRecallInput：必填 query:string(非空)、sessionId:string(非空)、
 * generation:非负安全整数、completeness:'ok'|'partial'|'unknown'|'unavailable'、
 * complete:boolean（上游完整性证明）、truncated:boolean、candidateLimit:正整数、
 * maxCodePoints:正整数、candidates:Candidate[]、followUpHandle:null|FollowUpHandle。
 * CONFIDENCE_MIN = 0.5 是本模块私有准入阈值，依据合同第 57 行「候选低置信不提升为事实」，不代表 P2 公共置信标准；若将来要成为公共标准，须另提 P2 CR。
 * Candidate 必填 id:string、kind:'record'|'summary'|'voucher'|'event'、
 * relation:八值枚举、text:string、confidence:[0,1]、generation:非负安全整数、
 * sessionId:string、sourceVerified:boolean、permissionVerified:boolean、
 * forgotten:boolean；只有所有身份/授权/来源/代际均核验、未遗忘且置信度≥0.5 才可用。
 * FollowUpHandle 必填 cursor:string 非空、generation:非负安全整数，且代际须匹配。
 * 输出 PlanRecallResult：必填 status:'ok'|'partial'|'unknown'|'unavailable'、
 * selected:Candidate[]、citations:引用投影[]、followUp:null|{cursor,generation}、
 * complete:boolean、truncated:boolean。partial 表示不完整；截断另用 truncated。
 * 无候选且没有 complete=true 的完整性证明时，status=unknown；不将空集合当 EOF。
 */
export const RECALL_RELATIONS = Object.freeze([
  'source', 'evidence', 'supersedes', 'base', 'archive-receipt',
  'segment-summary', 'call-pair', 'adjacent',
])

const KINDS = Object.freeze(['record', 'summary', 'voucher', 'event'])
const STATUSES = Object.freeze(['ok', 'partial', 'unknown', 'unavailable'])
const INPUT_KEYS = Object.freeze(['query', 'sessionId', 'generation', 'completeness', 'complete', 'truncated', 'candidateLimit', 'maxCodePoints', 'candidates', 'followUpHandle'])
const CANDIDATE_KEYS = Object.freeze(['id', 'kind', 'relation', 'text', 'confidence', 'generation', 'sessionId', 'sourceVerified', 'permissionVerified', 'forgotten'])
const HANDLE_KEYS = Object.freeze(['cursor', 'generation'])
const CONFIDENCE_MIN = 0.5

function isObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function onlyKeys(value, keys) {
  return isObject(value) && Object.keys(value).every((key) => keys.includes(key))
}

function validCandidate(candidate) {
  return onlyKeys(candidate, CANDIDATE_KEYS) && CANDIDATE_KEYS.every((key) => Object.hasOwn(candidate, key)) &&
    typeof candidate.id === 'string' && candidate.id.length > 0 && KINDS.includes(candidate.kind) &&
    RECALL_RELATIONS.includes(candidate.relation) && typeof candidate.text === 'string' &&
    Number.isFinite(candidate.confidence) && candidate.confidence >= 0 && candidate.confidence <= 1 &&
    Number.isSafeInteger(candidate.generation) && candidate.generation >= 0 &&
    typeof candidate.sessionId === 'string' && typeof candidate.sourceVerified === 'boolean' &&
    typeof candidate.permissionVerified === 'boolean' && typeof candidate.forgotten === 'boolean'
}

function rejected() {
  return { status: 'unavailable', selected: [], citations: [], followUp: null, complete: false, truncated: false }
}

/** 按已给候选作确定性首跳规划；纯函数，无 I/O、时钟、随机或递归。 */
export function planRecall(input) {
  if (!onlyKeys(input, INPUT_KEYS) || INPUT_KEYS.some((key) => !Object.hasOwn(input, key))) return rejected()
  const { query, sessionId, generation, completeness, complete, truncated, candidateLimit, maxCodePoints, candidates, followUpHandle } = input
  if (typeof query !== 'string' || query.length === 0 || typeof sessionId !== 'string' || sessionId.length === 0 ||
      !Number.isSafeInteger(generation) || generation < 0 || !STATUSES.includes(completeness) ||
      typeof complete !== 'boolean' || typeof truncated !== 'boolean' ||
      !Number.isSafeInteger(candidateLimit) || candidateLimit < 1 ||
      !Number.isSafeInteger(maxCodePoints) || maxCodePoints < 1 || !Array.isArray(candidates)) return rejected()
  if (followUpHandle !== null && (!onlyKeys(followUpHandle, HANDLE_KEYS) ||
      !HANDLE_KEYS.every((key) => Object.hasOwn(followUpHandle, key)) ||
      typeof followUpHandle.cursor !== 'string' || followUpHandle.cursor.length === 0 ||
      !Number.isSafeInteger(followUpHandle.generation) || followUpHandle.generation !== generation)) {
    return { ...rejected(), status: 'unknown' }
  }
  if (candidates.some((candidate) => isObject(candidate) && typeof candidate.relation === 'string' && !RECALL_RELATIONS.includes(candidate.relation))) {
    return { ...rejected(), status: 'unknown' }
  }
  if (!candidates.every(validCandidate)) return rejected()

  const filtered = []
  let rejectedUnknown = false
  for (const candidate of candidates) {
    if (candidate.forgotten || candidate.sessionId !== sessionId || !candidate.permissionVerified || !candidate.sourceVerified) {
      rejectedUnknown = true
      continue
    }
    if (candidate.generation !== generation || candidate.confidence < CONFIDENCE_MIN) {
      rejectedUnknown = true
      continue
    }
    filtered.push(candidate)
  }
  // 稳定排序：已证明关系优先；adjacent 仅原样作为相邻关系，绝不提升语义。
  const relationRank = (relation) => relation === 'source' || relation === 'evidence' ? 0 : relation === 'adjacent' ? 2 : 1
  filtered.sort((a, b) => relationRank(a.relation) - relationRank(b.relation) || b.confidence - a.confidence || a.id.localeCompare(b.id))
  const selected = []
  let used = 0
  let cut = truncated || completeness !== 'ok' || rejectedUnknown
  const seen = new Set()
  for (const candidate of filtered) {
    if (seen.has(candidate.id)) continue
    seen.add(candidate.id)
    const length = [...candidate.text].length
    if (selected.length >= candidateLimit || used + length > maxCodePoints) {
      cut = true
      continue
    }
    selected.push(candidate)
    used += length
  }
  if (selected.length === 0) {
    return {
      status: complete && completeness === 'ok' && !rejectedUnknown ? 'unavailable' : 'unknown', selected: [], citations: [], followUp: null,
      complete: false, truncated: Boolean(truncated || cut),
    }
  }
  const status = cut || !complete || completeness !== 'ok' ? 'partial' : 'ok'
  const followUp = followUpHandle && followUpHandle.generation === generation
    ? { cursor: followUpHandle.cursor, generation: followUpHandle.generation }
    : null
  return {
    status,
    selected,
    citations: selected.map(({ id, kind, relation, generation: objectGeneration }) => ({ id, kind, relation, generation: objectGeneration })),
    followUp,
    complete: status === 'ok',
    truncated: Boolean(truncated || cut),
  }
}
