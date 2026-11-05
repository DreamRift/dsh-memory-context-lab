/**
 * P3-A Warm 中间表示构造器：纯函数、原文摘引、对象身份引用。
 * 不持久化、不调用模型、不生成关系或 cursor，也不参与 I2 压缩决策。
 */
const INPUT_KEYS = Object.freeze(['sessionKey', 'activeSurfaceNodes', 'archiveCandidate', 'summaryBudgetCodePoints'])
const NODE_KEYS = Object.freeze(['seq', 'eventId', 'text', 'recordId', 'sessionKey'])
const CANDIDATE_KEYS = Object.freeze(['startSeq', 'endSeq', 'sourceEventSeqs', 'recordIds', 'sessionKey'])
const RECORD_ID = /^v3r-[0-9a-f]{16}$/u
const P2_SHORT_TEXT_LIMIT = 240
const P2_DETAIL_LIMIT = 4000
const P2_EVIDENCE_REFS_LIMIT = 50
const P2_SOURCES_LIMIT = 200
const CLOSE_QUOTES = new Set(['”', '’', '」', '』', '》', '〉', '〕', '］', '｝', '）', ')', '】', '〕', '〗', '〙', '〛', '"', "'"])
const SENTENCE_END = new Set(['。', '！', '？', '.', '!', '?'])

function plainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function hasOnlyKeys(value, keys) {
  return plainObject(value) && Object.keys(value).every((key) => keys.includes(key))
}

function nonNegativeSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0
}

function fail(status, reason) {
  return { status, capped: false, reason }
}

function sentences(text) {
  const chars = [...text]
  const result = []
  let start = 0
  let cursor = 0
  const emit = (end) => {
    const part = chars.slice(start, end).join('')
    if (/\S/u.test(part)) result.push(part)
    start = end
  }
  while (cursor < chars.length) {
    if (chars[cursor] === '\n' || chars[cursor] === '\r') {
      emit(cursor + 1)
      cursor += 1
      while (cursor < chars.length && (chars[cursor] === '\n' || chars[cursor] === '\r')) {
        emit(cursor + 1)
        cursor += 1
      }
      start = cursor
      continue
    }
    if (!SENTENCE_END.has(chars[cursor])) {
      cursor += 1
      continue
    }
    let end = cursor + 1
    while (end < chars.length && (SENTENCE_END.has(chars[end]) || CLOSE_QUOTES.has(chars[end]))) end += 1
    emit(end)
    cursor = end
    start = end
  }
  if (start < chars.length) emit(chars.length)
  return result
}

/** 按合同封闭模型校验快照并构造可重算的 Warm IR。 */
export function buildWarmSummaryReference(input) {
  if (!hasOnlyKeys(input, INPUT_KEYS) || INPUT_KEYS.some((key) => !Object.hasOwn(input, key))) {
    return fail('rejected', 'input 字段非法或缺失')
  }
  const { sessionKey, activeSurfaceNodes, archiveCandidate, summaryBudgetCodePoints } = input
  if (typeof sessionKey !== 'string' || sessionKey.length === 0 || !Array.isArray(activeSurfaceNodes) ||
      !nonNegativeSafeInteger(summaryBudgetCodePoints) || !hasOnlyKeys(archiveCandidate, CANDIDATE_KEYS) ||
      CANDIDATE_KEYS.some((key) => !Object.hasOwn(archiveCandidate, key))) {
    return fail('rejected', 'input 类型非法')
  }
  if (!nonNegativeSafeInteger(archiveCandidate.startSeq) || !nonNegativeSafeInteger(archiveCandidate.endSeq) ||
      archiveCandidate.startSeq > archiveCandidate.endSeq || archiveCandidate.sessionKey !== sessionKey ||
      !Array.isArray(archiveCandidate.sourceEventSeqs) || archiveCandidate.sourceEventSeqs.length === 0 ||
      !Array.isArray(archiveCandidate.recordIds) || archiveCandidate.recordIds.length === 0) {
    return fail(archiveCandidate.sessionKey !== sessionKey ? 'conflict' : 'rejected', 'archiveCandidate 不合法或会话冲突')
  }
  let previousSeq = -1
  for (const seq of archiveCandidate.sourceEventSeqs) {
    if (!nonNegativeSafeInteger(seq) || seq <= previousSeq || seq < archiveCandidate.startSeq || seq > archiveCandidate.endSeq) {
      return fail('rejected', 'sourceEventSeqs 必须严格递增且位于候选闭区间')
    }
    previousSeq = seq
  }
  for (const id of archiveCandidate.recordIds) {
    if (typeof id !== 'string' || !RECORD_ID.test(id)) return fail('rejected', 'recordIds 含非法 P2 record ID')
  }
  for (const node of activeSurfaceNodes) {
    if (!hasOnlyKeys(node, NODE_KEYS) || NODE_KEYS.some((key) => !Object.hasOwn(node, key)) ||
        !nonNegativeSafeInteger(node.seq) || !(node.text === null || typeof node.text === 'string') ||
        !(node.eventId === null || typeof node.eventId === 'string') || !(node.recordId === null || typeof node.recordId === 'string') ||
        typeof node.sessionKey !== 'string') return fail('rejected', 'ActiveNode 字段或类型非法')
    if (node.sessionKey !== sessionKey) return fail('conflict', 'ActiveNode 会话归属冲突')
    if (node.eventId === '' || node.recordId === '' || (node.recordId !== null && !RECORD_ID.test(node.recordId))) {
      return fail('rejected', 'ActiveNode 对象身份非法')
    }
  }
  for (let index = 1; index < activeSurfaceNodes.length; index += 1) {
    if (activeSurfaceNodes[index].seq <= activeSurfaceNodes[index - 1].seq) return fail('rejected', 'ActiveNode.seq 必须严格递增')
  }
  const refsCapped = archiveCandidate.recordIds.length > P2_SOURCES_LIMIT

  const nodesBySeq = new Map(activeSurfaceNodes.map((node) => [node.seq, node]))
  const candidateNodes = []
  for (const seq of archiveCandidate.sourceEventSeqs) {
    const node = nodesBySeq.get(seq)
    if (!node) return fail('unavailable', '候选来源在活动面快照中不可完整对应')
    candidateNodes.push(node)
  }
  const knownIds = candidateNodes.filter((node) => node.recordId !== null).map((node) => node.recordId)
  if (knownIds.length !== archiveCandidate.recordIds.length || knownIds.some((id, index) => id !== archiveCandidate.recordIds[index])) {
    return fail('unavailable', '候选记录身份与活动面来源不能逐项核验')
  }
  if (candidateNodes.some((node) => node.text === null)) return fail('unavailable', '候选正文不可读')

  const budget = Math.min(summaryBudgetCodePoints, P2_SHORT_TEXT_LIMIT)
  const selected = []
  let used = 0
  let capped = false
  const seen = new Set()
  for (const node of candidateNodes) {
    for (const text of sentences(node.text)) {
      const key = node.seq + '\u0000' + text
      if (seen.has(key)) continue
      const length = [...text].length
      if (used + length > budget) {
        capped = true
        break
      }
      seen.add(key)
      selected.push({ text, seq: node.seq })
      used += length
    }
    if (capped) break
  }
  const summary = selected.map((part) => part.text).join('')
  if ([...summary].length > P2_DETAIL_LIMIT) return fail('failed', '摘要超出 P2 detail 上限')
  capped = capped || refsCapped
  return {
    status: capped ? 'partial' : 'ok',
    capped,
    shortText: summary,
    detail: summary,
    evidenceRefs: archiveCandidate.recordIds.slice(0, P2_EVIDENCE_REFS_LIMIT),
    sources: archiveCandidate.recordIds.slice(0, P2_SOURCES_LIMIT),
    omittedRefs: archiveCandidate.recordIds.length - Math.min(archiveCandidate.recordIds.length, P2_SOURCES_LIMIT),
    omittedAfterSeq: capped && selected.length > 0 ? selected.at(-1).seq : null,
  }
}
