/**
 * 检索命中窗口（domain/retrieval，0.15.0 P5 / R01）。
 *
 * 旧行为是「每条命中拼 160 字首部」：927 字记录尾部才是答案时，首部不含答案，
 * 模型只能看到一个无关开头（开发流程 §7.2 R01）。这里改为**按查询在原文里选窗口**：
 *
 * - 同时使用 BM25 词元（CJK 单字+双字/ASCII 词）与**字面 needle**
 *   （标识符、路径、错误码、数字串），后者保住被分词切断的精确形态；
 * - 长查询先做可解释的确定性缩减：强词元优先，再取首部/尾部，避免「只裁前缀」丢掉
 *   唯一错误码（§7.1）；
 * - 窗口按**稀有命中优先**滑动选择：错误码/路径/callId/含数字或分隔符的整词
 *   （以及查询里混合大小写的词）先比「覆盖了几个不同稀有命中」，再比稀有度
 *   （同一 needle 在正文里出现越多越不值钱），最后才比覆盖词数/出现次数；
 *   高频单字与停用词不得用「数量多」把唯一标识符挤出预算（P1 回归）；
 * - 可附加最多 maxSpans 个互不重叠的窗口；窗口之间**不相连**时同样标 truncated
 *   （中间有洞必须可见，不能只看首尾）；
 * - 所有 span 都是 **Unicode 码点半开区间** `[start, end)`，与 `[...text]` 同尺；
 *   展示转义/脱敏后的偏移不得回切未转义原件（本函数只接受已呈现正文）；
 * - 有 chunk 索引时只在命中的 chunk 里选窗（跨边界由重叠覆盖）；chunk 索引缺失/
 *   版本不匹配/覆盖不全（单记录 chunk 被硬顶截断）时**退回现扫**并如实标记 strategy，
 *   不因派生索引未就绪或残缺而失去命中窗口。
 */
import { V3ContractViolation } from '../../contracts/errors.mjs'
// P2-10：`maxChars` 是**每窗口**预算，单条摘录的真实上界另由合同给出（每窗口×窗口数+连接符）。
// 这里消费它作为**不变量防线**：渲染结果越界即实现 bug（而不是靠注释约定），
// 也保证调用方不会把它当总预算误用（MAX_TOTAL 一旦被当作 maxChars 传入，防线立即红）。
import { SEARCH_EXCERPT_JOINER, SEARCH_EXCERPT_MAX_TOTAL_CHARS } from '../../contracts/tools.mjs'
import { tokenizeQuery } from './query.mjs'

/** 所有 span 的偏移单位（对外契约；调用方不得再自行推断）。 */
export const EXCERPT_OFFSET_UNIT = 'code-point'

/** 长查询缩减后的最多保留词元数（强词元优先，其余按首/尾补足）。 */
export const QUERY_MAX_TERMS = 64

/** 单个词元在一条记录里最多采集的出现次数（窗口选择只需少量锚点，避免病态全文扫描）。 */
const MAX_OCCURRENCES_PER_NEEDLE = 8

/** 字面 needle：标识符/路径/错误码/数字串（保留被分词切断的精确形态）。 */
const LITERAL_NEEDLE_RE = /[A-Za-z0-9][A-Za-z0-9_./:@\-]{2,}/g

function validateMaxChars(maxChars) {
  if (!Number.isInteger(maxChars) || maxChars < 0) {
    throw new V3ContractViolation('v3 excerpt: maxChars 必须是 ≥0 的整数（得到 ' + String(maxChars) + '）')
  }
}

/** 强词元判据：含数字、足够长、或带标识符分隔符（错误码/路径/版本号等）。 */
function isStrongTerm(term) {
  return /[0-9]/.test(term) || term.length >= 5 || /[_./:@]/.test(term)
}

/**
 * 从查询里取词元与字面 needle（确定性、可解释）。
 *
 * 缩减口径（仅在词元数超过 maxTerms 时生效）：
 * 1. 先保留全部强词元（含数字/长词/分隔符形态；超过上限时按原序截断）；
 * 2. 剩余名额按「首部一半、尾部一半」补普通词元；
 * 3. 仍有余量时按原序补中段——绝不只是裁前缀。
 *
 * @param {string} raw 查询原文
 * @param {{maxTerms?: number}} [opts]
 * @returns {{terms: string[], literals: string[], reduced: boolean, dropped: number}}
 */
export function selectExcerptTerms(raw, { maxTerms = QUERY_MAX_TERMS } = {}) {
  if (typeof raw !== 'string') {
    throw new V3ContractViolation('v3 excerpt: query 必须是字符串')
  }
  if (!Number.isInteger(maxTerms) || maxTerms < 1) {
    throw new V3ContractViolation('v3 excerpt: maxTerms 必须是 ≥1 的整数')
  }
  const unique = [...new Set(tokenizeQuery(raw))]
  const literals = []
  const seen = new Set()
  for (const match of raw.matchAll(LITERAL_NEEDLE_RE)) {
    const value = match[0].toLowerCase()
    if (value.length < 3 || seen.has(value) || unique.includes(value)) continue
    seen.add(value)
    literals.push(value)
  }
  if (unique.length <= maxTerms) {
    return { terms: unique, literals: literals.slice(0, maxTerms), reduced: false, dropped: 0 }
  }
  const picked = []
  const has = (term) => picked.includes(term)
  for (const term of unique) {
    if (isStrongTerm(term) && !has(term) && picked.length < maxTerms) picked.push(term)
  }
  const remaining = maxTerms - picked.length
  if (remaining > 0) {
    const headCount = Math.ceil(remaining / 2)
    for (const term of unique.slice(0, headCount)) if (!has(term)) picked.push(term)
    for (const term of unique.slice(-(remaining - headCount))) if (!has(term)) picked.push(term)
  }
  if (picked.length < maxTerms) {
    for (const term of unique) {
      if (picked.length >= maxTerms) break
      if (!has(term)) picked.push(term)
    }
  }
  return {
    terms: picked.slice(0, maxTerms),
    literals: literals.slice(0, maxTerms),
    reduced: true,
    dropped: unique.length - Math.min(unique.length, picked.length),
  }
}

/**
 * 尾部实体：查询最后一个「词」（ASCII 标识符/路径/错误码，或一整段 CJK 词）。
 *
 * 旧实现按码点数切尾（`maxChars=32` 时 '…ERR_TAIL_X7' 只剩 '7'），把唯一标识符
 * 切成无法识别的碎片。这里按**实体**保留：先整体保住最后一个词，再决定前面省略多少。
 */
const IDENTIFIER_ENTITY_RE = /[A-Za-z0-9][A-Za-z0-9_./:@\-]*/g

/**
 * 查询里最后一个**标识符实体**的码点区间（错误码/路径/callId/含数字或分隔符或
 * 混合大小写的 ASCII 整词；纯中文词不在此列——按字切不是「切碎标识符」）。
 */
export function tailEntityOf(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return null
  let last = null
  for (const match of raw.matchAll(IDENTIFIER_ENTITY_RE)) {
    const value = match[0]
    if (value.length < 3) continue
    const mixedCase = /[A-Z]/.test(value) && /[a-z]/.test(value)
    if (!RARE_CHARS_RE.test(value) && !mixedCase) continue
    const start = Array.from(raw.slice(0, match.index)).length
    last = { start, end: start + Array.from(value).length }
  }
  return last
}

/**
 * 长查询有界化：保留首部与尾部，不把唯一错误码裁掉。
 *
 * 尾部按**实体**保留（P3）：最后一个标识符/词整体留下，省略发生在它之前；
 * 只有「实体本身比预算还长」时才不得不截实体，并用前导 `…` 明示这件事。
 * 结果长度恒 ≤ maxChars 码点（含省略号）。
 */
export function boundQuery(raw, maxChars) {
  if (typeof raw !== 'string') return raw
  if (!Number.isInteger(maxChars) || maxChars <= 0) return raw
  const cps = Array.from(raw)
  if (cps.length <= maxChars) return raw
  if (maxChars === 1) return cps[0]
  const entity = tailEntityOf(raw)
  if (entity !== null) {
    const entityText = cps.slice(entity.start, entity.end).join('')
    const wholeTail = cps.slice(entity.start).join('')
    // 情形 A：实体 + 其后尾巴整体放得下（前导省略号占 1）。
    const headRoomA = maxChars - 1 - Array.from(wholeTail).length
    if (headRoomA >= 0) return cps.slice(0, headRoomA).join('') + '…' + wholeTail
    // 情形 B：只放得下实体本身；其后还有内容时用尾部省略号明示（不静默丢字）。
    const hasAfter = entity.end < cps.length
    const headRoomB = maxChars - 1 - Array.from(entityText).length - (hasAfter ? 1 : 0)
    if (headRoomB >= 0) {
      return cps.slice(0, headRoomB).join('') + '…' + entityText + (hasAfter ? '…' : '')
    }
    if (Array.from(entityText).length <= maxChars - 1) {
      // 情形 B2：连前文都放不下 → 省略前文，实体整体留下（省略号在前）。
      return '…' + entityText + (hasAfter && Array.from(entityText).length + 2 <= maxChars ? '…' : '')
    }
    // 情形 D：实体自身比预算还长——唯一不得不截断实体的情形，前后省略号都写明。
    return '…' + cps.slice(entity.start, entity.start + Math.max(1, maxChars - 2)).join('') + '…'
  }
  // 情形 C：无标识符实体，或实体自身超预算 → 首尾按比例（旧行为），
  // 但仍避免尾切片正好切在实体中间（能整体挪进尾部就挪）。
  const budget = maxChars - 1 // 给中间的省略号留 1 个码点
  let headCount = Math.max(1, Math.floor(budget * 0.6))
  let tailCount = budget - headCount
  if (entity !== null) {
    const tailStart = cps.length - tailCount
    if (tailStart > entity.start && tailStart < entity.end) {
      const want = cps.length - entity.start
      if (want <= budget) {
        tailCount = want
        headCount = budget - want
      }
    }
  }
  return cps.slice(0, headCount).join('') + '…' + cps.slice(cps.length - tailCount).join('')
}

/** UTF-16 offset → 码点下标（二分）；越界返回码点总数。 */
function codePointIndexAt(prefix, offset) {
  const count = prefix.length - 1
  if (offset >= prefix[count]) return count
  let lo = 0
  let hi = count - 1
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (prefix[mid] <= offset) lo = mid
    else hi = mid - 1
  }
  return lo
}

/** 采集词元/needle 在正文中的出现位置（码点）。 */
function findMatches(cps, needles) {
  const lowerCps = cps.map((ch) => ch.toLowerCase())
  const hay = lowerCps.join('')
  const prefix = new Array(cps.length + 1)
  prefix[0] = 0
  for (let i = 0; i < lowerCps.length; i += 1) prefix[i + 1] = prefix[i] + lowerCps[i].length
  const matches = []
  for (const needle of needles) {
    if (typeof needle !== 'string' || needle.length === 0) continue
    let from = 0
    let count = 0
    while (count < MAX_OCCURRENCES_PER_NEEDLE) {
      const at = hay.indexOf(needle, from)
      if (at < 0) break
      const start = codePointIndexAt(prefix, at)
      const end = codePointIndexAt(prefix, at + needle.length)
      if (end > start) matches.push({ needle, start, end })
      from = at + needle.length
      count += 1
    }
  }
  matches.sort((a, b) => (a.start - b.start) || (a.end - b.end) || (a.needle < b.needle ? -1 : a.needle > b.needle ? 1 : 0))
  return matches
}

function headExcerpt(cps, maxChars, reason) {
  const end = Math.min(cps.length, maxChars)
  return {
    text: cps.slice(0, end).join(''),
    spans: maxChars > 0 ? [{ start: 0, end }] : [],
    matchedNeedles: [],
    chunkHits: 0,
    strategy: 'head',
    reason,
    truncated: end < cps.length,
    offsetUnit: EXCERPT_OFFSET_UNIT,
  }
}

/**
 * 稀有命中判据（P1）：字面标识符、错误码、路径、callId——含数字/下划线/分隔符，
 * 或查询里混合大小写的整词（大小写在 needle 里已被小写化，故由查询原文判定）。
 */
const RARE_CHARS_RE = /[0-9_./:@\-]/

/** 查询里可判为「稀有标识符」的字面 needle（小写；含混合大小写整词）。 */
export function rareNeedlesOf(raw) {
  const rare = new Set()
  if (typeof raw !== 'string' || raw.length === 0) return rare
  for (const match of raw.matchAll(LITERAL_NEEDLE_RE)) {
    const value = match[0]
    if (value.length < 3) continue
    const mixedCase = /[A-Z]/.test(value) && /[a-z]/.test(value)
    if (RARE_CHARS_RE.test(value) || mixedCase) rare.add(value.toLowerCase())
  }
  return rare
}

/** 单条 needle 是否稀有：自身带数字/分隔符，或命中查询里的稀有字面 needle。 */
export function isRareNeedle(needle, rareSet) {
  if (typeof needle !== 'string' || needle.length === 0) return false
  if (RARE_CHARS_RE.test(needle)) return true
  return rareSet instanceof Set ? rareSet.has(needle) : false
}

/**
 * 窗口打分：先数**不同稀有命中**（错误码/路径/标识符），再按稀有度折算
 * （同一 needle 在正文出现越多次，单次命中的价值越低），最后才是覆盖词数与出现次数。
 *
 * 这样「高频单字/停用词的数量优势」无法把唯一标识符挤出预算：正文里出现 40 次的
 * '是'/'的' 在 rare 一栏是 0，而只出现一次的 ERR_TAIL_X7 是 1。
 */
function windowScore(hits, start, limit, weights) {
  const covered = new Set()
  const rareCovered = new Set()
  const rareTouched = new Set()
  let rareScore = 0
  let count = 0
  let maxEnd = start
  for (const hit of hits) {
    const inside = hit.start >= start && hit.end <= limit
    if (inside) {
      if (!covered.has(hit.needle)) {
        covered.add(hit.needle)
        if (weights.isRare(hit.needle)) {
          rareCovered.add(hit.needle)
          rareScore += 1 / Math.max(1, weights.occurrences.get(hit.needle) ?? 1)
        }
      }
      count += 1
      if (hit.end > maxEnd) maxEnd = hit.end
    } else if (hit.start < limit && hit.end > start && weights.isRare(hit.needle)) {
      // 只被窗口擦到（长于窗口的标识符）：仍算「碰到稀有命中」，不让窗口整块丢掉它。
      rareTouched.add(hit.needle)
    }
  }
  return { covered, rare: rareCovered.size, rareScore, rareTouched: rareTouched.size, count, maxEnd }
}

/** 在给定命中集里选稀有命中最多、覆盖最广、可容纳于 maxChars 的窗口。 */
function bestWindow(hits, maxChars, textLength, weights) {
  let best = null
  for (const anchor of hits) {
    const start = anchor.start
    if (start >= textLength) continue
    const limit = Math.min(textLength, start + maxChars)
    const scored = windowScore(hits, start, limit, weights)
    const candidate = {
      start,
      end: Math.min(textLength, Math.max(limit, scored.maxEnd)),
      covered: scored.covered,
      rare: scored.rare,
      rareScore: scored.rareScore,
      rareTouched: scored.rareTouched,
      count: scored.count,
      // 锚点自身是否被完整容纳：长于窗口的单个 needle 只能部分展示。
      complete: anchor.end <= limit,
    }
    if (best === null) { best = candidate; continue }
    const better = candidate.rare - best.rare
      || candidate.rareScore - best.rareScore
      || candidate.rareTouched - best.rareTouched
      || candidate.covered.size - best.covered.size
      || candidate.count - best.count
      || (candidate.complete === best.complete ? 0 : candidate.complete ? 1 : -1)
      || (best.start - candidate.start)
    if (better > 0) best = candidate
  }
  return best
}

/** 收窄/移动窗口是否切掉了原本完整覆盖的命中（吸附回文首前的守卫）。 */
function cutsCoveredMatches(hits, base, narrowed) {
  for (const hit of hits) {
    if (hit.start < base.start || hit.end > base.end) continue
    if (hit.start >= narrowed.start && hit.end <= narrowed.end) continue
    return true
  }
  return false
}

/**
 * 选命中窗口。
 *
 * @param {string} text 已呈现正文
 * @param {string} query 查询原文
 * @param {{maxChars?: number, contextChars?: number, maxSpans?: number,
 *          chunkSpans?: Array<{start:number,end:number}>|null}} [opts]
 * @returns {{text: string, spans: Array<{start:number,end:number}>, matchedNeedles: string[],
 *   chunkHits: number, strategy: string, reason: string|null, truncated: boolean,
 *   offsetUnit: string}}
 */
export function selectExcerpt(text, query, { maxChars = 160, contextChars = 24, maxSpans = 2, chunkSpans = null } = {}) {
  if (typeof text !== 'string') {
    throw new V3ContractViolation('v3 excerpt: text 必须是字符串')
  }
  validateMaxChars(maxChars)
  if (!Number.isInteger(contextChars) || contextChars < 0) {
    throw new V3ContractViolation('v3 excerpt: contextChars 必须是 ≥0 的整数')
  }
  if (!Number.isInteger(maxSpans) || maxSpans < 1) {
    throw new V3ContractViolation('v3 excerpt: maxSpans 必须是 ≥1 的整数')
  }
  const cps = Array.from(text)
  if (cps.length === 0 || maxChars === 0) return headExcerpt(cps, 0, maxChars === 0 ? 'maxChars=0' : 'empty-text')
  const selected = selectExcerptTerms(typeof query === 'string' ? query : '')
  const needles = [...new Set([...selected.literals, ...selected.terms])]
  if (needles.length === 0) return headExcerpt(cps, maxChars, 'empty-query')
  const allMatches = findMatches(cps, needles)
  if (allMatches.length === 0) return headExcerpt(cps, maxChars, 'no-match')
  // 稀有度按**整条正文**统计（不是逐窗口），否则「窗口内出现几次」会被窗口大小自证。
  const rareSet = rareNeedlesOf(typeof query === 'string' ? query : '')
  const occurrences = new Map()
  for (const hit of allMatches) occurrences.set(hit.needle, (occurrences.get(hit.needle) ?? 0) + 1)
  const weights = { isRare: (needle) => isRareNeedle(needle, rareSet), occurrences }

  // chunk 索引可用 → 只在命中的 chunk 内选窗；索引缺失/无 chunk 命中 → 现扫（策略如实标记）。
  let matches = allMatches
  let chunkHits = 0
  let strategy = 'scan-fallback'
  let reason = null
  if (Array.isArray(chunkSpans) && chunkSpans.length > 0) {
    const scoped = []
    for (const span of chunkSpans) {
      if (span === null || typeof span !== 'object' || !Number.isInteger(span.start) || !Number.isInteger(span.end) || span.end <= span.start) continue
      const inside = allMatches.filter((hit) => hit.start >= span.start && hit.end <= span.end)
      if (inside.length > 0) {
        chunkHits += 1
        scoped.push(...inside)
      }
    }
    // chunk 只是**范围提示**，不是命中集：单记录 chunk 被硬顶截断时尾段命中会落在
    // 所有 span 之外，旧实现因为「scoped 非空」就丢掉它们（尾部标识符静默消失）。
    // 覆盖不全一律回退现扫，并把原因写进 reason。
    const scopedSet = new Set(scoped)
    const uncoveredHits = allMatches.filter((hit) => !scopedSet.has(hit)).length
    if (scoped.length > 0 && uncoveredHits === 0) {
      matches = scoped
      strategy = 'chunk-window'
    } else if (uncoveredHits > 0) {
      reason = 'chunk 索引未覆盖全部命中（单记录 chunk 被硬顶截断或索引落后），回退现扫'
    }
  }
  const spans = []
  const consumed = new Set()
  // P2-10：`maxChars` 是**每个窗口**的预算（不是整条摘录的总预算）——两个互补窗口时
  // 单条摘录真实上界 = maxSpans × maxChars + (maxSpans−1) × 3（实测 160 → 323）。
  // 旧合同只写「单条摘录的码点预算」，读起来像总预算，于是「设置语义」与实测漂移，
  // 回注预算也按错的数算。修法二选一：把实现收紧成总预算（会让第二个远处事实消失，
  // 与 G1/P5 的既有产品行为冲突），或**把合同改成与实测一致**。这里取后者：
  // 合同改为「每窗口预算 + 真实上界函数」，调用方按真实上界算预算。
  for (let round = 0; round < maxSpans; round += 1) {
    const remainingHits = matches.filter((hit) => !consumed.has(hit))
    const candidateHits = round === 0 ? remainingHits : remainingHits.filter((hit) => !spans.some((span) => hit.start < span.end && hit.end > span.start))
    if (candidateHits.length === 0) break
    const chosen = bestWindow(candidateHits, maxChars, cps.length, weights)
    if (chosen === null) break
    // 窗口按 maxChars 充满：向右保到 chosen.end，再向左补上下文（不把锚点挤出窗口）。
    // 单个 needle 本身长于窗口时只能部分展示，此时以锚点为起点截断。
    let span
    if (chosen.end - chosen.start > maxChars) {
      span = { start: chosen.start, end: Math.min(cps.length, chosen.start + maxChars) }
    } else {
      const end = Math.min(cps.length, Math.max(chosen.start + maxChars, chosen.end))
      span = { start: Math.max(0, end - maxChars), end }
    }
    if (span.end - span.start > maxChars) span = { start: span.start, end: span.start + maxChars }
    // 窗口起点离文首很近时吸附到 0：保留记录自带的引导前缀（如 ID/时间行），
    // 避免「答案窗口」把可读身份行切掉。**吸附必须从同一预算里回收尾部**——
    // 旧实现只把 start 置 0 不回收 end，实测产出 161 字窗口突破 maxChars=160。
    // 若回收尾部会切掉原本完整覆盖的命中（标识符/锚点），则不吸附：预算与命中完整优先。
    if (span.start > 0 && span.start <= contextChars) {
      const snapped = { start: 0, end: Math.min(span.end, maxChars) }
      if (!cutsCoveredMatches(matches, span, snapped)) span = snapped
    }
    if (spans.some((existing) => span.start < existing.end && span.end > existing.start)) break
    spans.push(span)

    for (const hit of matches) if (hit.start >= span.start && hit.end <= span.end) consumed.add(hit)
    if (consumed.size >= matches.length) break
  }
  spans.sort((a, b) => a.start - b.start)
  const rendered = spans.map((span) => cps.slice(span.start, span.end).join('')).join(SEARCH_EXCERPT_JOINER)
  // P2-10 不变量：`maxChars` 是**每窗口**预算，所以本次调用的真实上界随参数走
  // （maxChars×maxSpans+连接符），而不是一个固定数字——`capShrink` 等路径会传更大的
  // maxChars，固定上界会把合法结果误判成越界。合同常量给的是**默认参数下**的上界。
  const totalMaxChars = maxChars * maxSpans + [...SEARCH_EXCERPT_JOINER].length * Math.max(0, maxSpans - 1)
  // 合同常量只在默认参数（160×2）下成立；两者一旦脱钩就说明常量或默认值被改坏了。
  if (maxChars === 160 && maxSpans === 2 && totalMaxChars !== SEARCH_EXCERPT_MAX_TOTAL_CHARS) {
    throw new V3ContractViolation('v3 excerpt: 合同上界与实现脱钩（' + SEARCH_EXCERPT_MAX_TOTAL_CHARS + ' vs ' + totalMaxChars + '）')
  }
  if ([...rendered].length > totalMaxChars) {
    throw new V3ContractViolation('v3 excerpt: 摘录长度突破真实上界 ' + totalMaxChars + '（得到 ' + [...rendered].length + '；maxChars=' + maxChars + ' maxSpans=' + maxSpans + '）')
  }
  // 截断判据必须覆盖**中间洞**：只看首尾时，两个互不相连的窗口（真实存在省略）会被
  // 标成 truncated=false，行内省略号随之消失（P2 回归）。
  const truncated = spans.length === 0
    || spans[0].start > 0
    || spans[spans.length - 1].end < cps.length
    || spans.some((span, index) => index > 0 && span.start > spans[index - 1].end)
  return {
    text: rendered,
    spans,
    // P2-10：把「预算怎么用的」如实带出——`perSpanMaxChars` 是**每窗口**预算，
    // `maxChars` 实际约束的是它而不是整条摘录；观察面按这两项核对，不再靠反推。
    matchedNeedles: [...new Set(matches.map((hit) => hit.needle))],
    chunkHits,
    strategy,
    reason,
    truncated,
    offsetUnit: EXCERPT_OFFSET_UNIT,
  }
}
