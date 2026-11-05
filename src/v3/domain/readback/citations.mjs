/**
 * 读取侧引用区的纯函数域（domain/readback，0.15.0 G2 / C-G2-01、C-G2-05）。
 *
 * 这里只做「把一条真实关系变成一条有身份的引用」所需的确定性工作：
 * 归一 / 去重 / 分页 / 文案标签。**不做 IO**——来源是否可读、hash 对不对、
 * 是不是别的会话，都由调用方（entry）逐跳核验后把 status 传进来。
 * 这样「有界」与「终止」是纯函数性质，可以单独断言：
 * - 去重键 = (relation, id)：同一关系下重复 ID 只留第一条（顺序稳定）；
 *   跨关系**不去重**——「这条记录既是来源又被当证据」是两个事实，不是重复。
 * - 分页 = 对确定性排序后的列表切片；越界偏移返回空页 + 显式「没有更多」。
 * - 展开跳数恒为 1（READ_REFS_LIMITS.hops）：本模块从不递归；循环因此不可能发生，
 *   自指关系（supersedes 指向自己）也只是**一条**被标 unknown 的引用。
 */
import { V3ContractViolation } from '../../contracts/errors.mjs'
import {
  READ_REFERENCE_HASH_KINDS,
  READ_REFERENCE_KINDS,
  READ_REFERENCE_RELATIONS,
  READ_REFERENCE_STATUSES,
  READ_REFS_LIMITS,
} from '../../contracts/citations.mjs'

/**
 * 关系文案（render 层唯一取词处）。
 * 'adjacent' 的文案必须自带「非因果」——这是 §8 明写的反例（把序号邻近包装成因果）。
 */
export const READ_RELATION_LABELS = Object.freeze({
  source: '来源记录',
  evidence: '证据引用',
  supersedes: '取代（旧摘要）',
  base: '派生基准',
  'archive-receipt': '所属归档回执',
  'segment-summary': '该段摘要工件',
  'call-pair': '工具调用配对',
  adjacent: '相邻记录（仅日志相邻，非因果）',
})

/** 核验状态文案（模型读得懂的措辞；新增状态必须同时在这里给说明）。 */
export const READ_STATUS_LABELS = Object.freeze({
  ok: '可读',
  unknown: '未知（旧数据未记录，不补造）',
  missing: '不存在',
  forgotten: '已遗忘（正文不可读）',
  hidden: '已隐藏（不可读）',
  'hash-mismatch': '哈希不符（来源已漂移）',
  'session-mismatch': '属于其它会话（拒绝）',
  unpaired: '没有配对',
  unreadable: '账本不可读（未知≠不存在）',
})

function textOf(value, fallback) {
  return typeof value === 'string' ? value : fallback
}

/** 按码点截断（定位信息是给人/模型看的，不承载正文；C-G2-05 的 detail 上界）。 */
function clampDetail(value) {
  if (typeof value !== 'string' || value.length === 0) return null
  const chars = [...value]
  if (chars.length <= READ_REFS_LIMITS.detail) return value
  return chars.slice(0, READ_REFS_LIMITS.detail - 1).join('') + '…'
}

/**
 * 构造一条引用（唯一构造点）。
 *
 * 未知/越界的枚举值**失败关闭**为 `unknown` 而不是原样透出：
 * 引用区是模型可见面，一个自造的 relation 会让「两条链分开」这条合同失效。
 *
 * @param {object} input {id, kind, relation, status, hash, hash_kind, seq, start_seq, end_seq, call_id, detail}
 * @returns {object} 只含合同字段的引用
 */
export function citationOf(input = {}) {
  const relation = READ_REFERENCE_RELATIONS.includes(input.relation) ? input.relation : null
  if (relation === null) throw new V3ContractViolation('v3 citations: relation 不在封闭集：' + JSON.stringify(input.relation))
  const kind = READ_REFERENCE_KINDS.includes(input.kind) ? input.kind : 'event'
  const status = READ_REFERENCE_STATUSES.includes(input.status) ? input.status : 'unknown'
  const hashKind = READ_REFERENCE_HASH_KINDS.includes(input.hash_kind) ? input.hash_kind : 'none'
  return {
    id: textOf(input.id, ''),
    kind,
    relation,
    status,
    hash: typeof input.hash === 'string' && input.hash.length > 0 ? input.hash : null,
    hash_kind: hashKind,
    seq: Number.isInteger(input.seq) ? input.seq : null,
    start_seq: Number.isInteger(input.start_seq) ? input.start_seq : null,
    end_seq: Number.isInteger(input.end_seq) ? input.end_seq : null,
    call_id: typeof input.call_id === 'string' && input.call_id.length > 0 ? input.call_id : null,
    detail: clampDetail(input.detail),
  }
}

/** 去重键：同一关系下的同一对象只留一条（跨关系不去重，见文件头）。 */
export function citationKeyOf(citation) {
  return String(citation?.relation ?? '') + '\u0000' + String(citation?.id ?? '')
}

/**
 * 确定性去重：保留**首次出现**的那条，顺序不变（顺序由调用方按关系序给出）。
 * @param {object[]} list
 * @returns {object[]}
 */
export function dedupeCitations(list) {
  const out = []
  const seen = new Set()
  for (const citation of Array.isArray(list) ? list : []) {
    const key = citationKeyOf(citation)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(citation)
  }
  return out
}

/**
 * 编目上界（C-G2-05）：超过 `READ_REFS_LIMITS.total` 的引用不再列出，`capped` 为真。
 * 调用方据此在 render 里明说「更深的关系请按 ID 逐个回读」——不静默遗失，也不假装列全。
 *
 * @param {object[]} list 已去重的引用
 * @returns {{items: object[], capped: boolean}}
 */
export function capCitations(list) {
  const rows = Array.isArray(list) ? list : []
  return rows.length > READ_REFS_LIMITS.total
    ? { items: rows.slice(0, READ_REFS_LIMITS.total), capped: true }
    : { items: rows, capped: false }
}

/**
 * 引用分页（与正文分页共用同一套「可验证游标」语义；偏移是引用序号，不是码点）。
 *
 * @param {object[]} list 已去重、已封顶的引用
 * @param {object} [options]
 * @param {number} [options.offset] 本页起点（引用序号）
 * @param {number} [options.pageSize] 本页条数（夹到 1..READ_REFS_LIMITS.pageMax）
 * @returns {{items: object[], total: number, nextOffset: number|null, pageSize: number, offset: number}}
 */
export function paginateCitations(list, { offset = 0, pageSize = READ_REFS_LIMITS.page } = {}) {
  const rows = Array.isArray(list) ? list : []
  const bounded = Number.isInteger(pageSize)
    ? Math.min(READ_REFS_LIMITS.pageMax, Math.max(1, pageSize))
    : READ_REFS_LIMITS.page
  const start = Number.isInteger(offset) && offset > 0 ? Math.min(offset, rows.length) : 0
  const items = rows.slice(start, start + bounded)
  const nextOffset = start + items.length < rows.length ? start + items.length : null
  return { items, total: rows.length, nextOffset, pageSize: bounded, offset: start }
}

/**
 * 引用页的种类标记：把一页引用拆成合同里的三个字段。
 *
 * - `sources`：relation = source（链 B 的第二跳）
 * - `evidence_refs`：本页里 relation = evidence 的 ID（C-G2-02：evidenceRefs ⊆ sources）
 * - `related`：其余关系（回执/段落摘要/调用配对/相邻/取代/基准）
 *
 * 拆字段而不是把关系都塞进一个数组，是为了让模型一眼分清「来源」与「其它真实关系」；
 * 也让「普通回执没有被当成摘要工件」这条反例在字段层面可断言（普通回执只会出现在 related）。
 *
 * @param {object[]} page 本页引用
 * @returns {{sources: object[], related: object[], evidence_refs: string[]}}
 */
export function splitCitationPage(page) {
  const sources = []
  const related = []
  const evidence = []
  for (const citation of Array.isArray(page) ? page : []) {
    if (citation.relation === 'source') sources.push(citation)
    else related.push(citation)
    if (citation.relation === 'evidence' && typeof citation.id === 'string' && citation.id.length > 0) evidence.push(citation.id)
  }
  return { sources, related, evidence_refs: [...new Set(evidence)] }
}
