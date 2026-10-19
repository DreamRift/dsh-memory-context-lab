/**
 * 程序压缩选择层（P3-4/5/6/7，纯函数、零 IO）。
 *
 * 输入是 evidence-atoms 的去重事实集，输出是层级卡（L1 证据卡 / L2 阶段卡 /
 * L3 任务索引）的确定性渲染文本与选择决策。这一层**没有任何模型调用**：
 * 模板共享、预算覆盖选择、查询相关摘录、no-safe-gain 全是确定性程序。
 *
 * 保真纪律（计划 §5 P3-4/5）：数值/否定/版本差异与约束类事实必选（required），
 * 覆盖相似性裁剪（MMR）只能对已过必选硬门的候选重排，永不裁掉差异事实；
 * 每条事实保留可展开的来源索引；摘要只是可替换的派生缓存，L2 的输入永远是
 * L0 原子（禁「摘要再摘要」由构造保证，见 hierarchy-store 的 manifest 约束）。
 */

import { createHash } from 'node:crypto'

import { estimateTokensOf } from './budget.mjs'
import { ATOM_ATTRIBUTES } from './evidence-atoms.mjs'

const EXCERPT_MAX_CHARS_DEFAULT = 240

/**
 * T1/F-03：默认不把成员正文复制进卡片。
 *
 * 自由文本类原子（摘录 / 跨度摘录 / 结论行）的 value 就是正文切片；默认渲染
 * 成固定标记，只保留 entity、属性标签、极性/关系标签与来源 ID——模型仍能
 * 判断「哪一步、什么性质、去哪展开」，但卡片本身不再是正文的副本。
 *
 * 恒定文本：模式说明行随开关变字节，同模式下的卡片逐字节稳定（可做前缀缓存）。
 */
const WITHHELD_EXCERPT_MARK = '（正文摘录未共享）'
const SHARE_MODE_NOTE = '摘录已按 shareL2Content 共享正文片段'
const WITHHOLD_MODE_NOTE = '摘录未共享正文（只给属性与来源；需要原文请用 expand/read 显式展开）'

/** 脱敏标记（导出供测试与文档引用，避免两处字面量漂移）。 */
export const WITHHELD_EXCERPT_MARK_FOR_TEST = WITHHELD_EXCERPT_MARK

/** 自由文本属性：默认脱敏的那几类。 */
const FREETEXT_ATTRIBUTES = new Set([
  ATOM_ATTRIBUTES.EXCERPT,
  ATOM_ATTRIBUTES.SPAN_EXCERPT,
  ATOM_ATTRIBUTES.CLAIM,
])

/** 该原子的 value 是否属于「正文摘录」这一类（默认真身不外泄）。 */
export function isFreetextAtom(atom) {
  return FREETEXT_ATTRIBUTES.has(String(atom?.attribute ?? ATOM_ATTRIBUTES.EXCERPT))
}

/** 按开关给出该原子上屏的 value：关闭时换成固定标记，不保留任何正文片段。 */
export function disclosedValue(atom, shareContent) {
  if (shareContent === true) return String(atom?.value ?? '')
  return isFreetextAtom(atom) ? WITHHELD_EXCERPT_MARK : String(atom?.value ?? '')
}

/** 模式说明行（恒定文本；两种模式各自字节稳定）。 */
export function shareModeNote(shareContent) {
  return shareContent === true ? SHARE_MODE_NOTE : WITHHOLD_MODE_NOTE
}

function hash16(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex').slice(0, 16)
}

/** 试验起点常量（计划 §5 P3-7；P4 末标定，不在运行时自适应）。 */
export const COMPRESS_BATCH_SOURCE_TOKENS = 8192
export const COMPRESS_BATCH_SOURCE_TOKENS_MAX = 12288
export const PHASE_CARD_MAX_TOKENS = 1024
export const COMPRESS_TASK_TIMEOUT_MS = 60_000
/** 阶段压缩并发恒为 1（pre-step 串行天然满足；此常量仅作声明与文档锚点）。 */
export const COMPRESS_CONCURRENCY = 1
/** MMR 多样性权重（计划 §3：0.7 起步，只影响已过必选硬门的候选次序）。 */
export const MMR_LAMBDA = 0.7
/** 预算覆盖选择的贪心批步长：候选一次评分后逐块装包，不做回溯。 */
export const GROUP_MIN_MEMBERS_FOR_TEMPLATE = 2

/** 必选属性族：冲突/更正/否定/约束之外，错误证据与测试失败也永不因冗余被裁。 */
const REQUIRED_ATTRIBUTES = new Set([
  ATOM_ATTRIBUTES.ERROR_SIGNATURE,
])

function factRequired(fact) {
  return (
    fact?.required === true ||
    fact?.polarity === 'negative' ||
    fact?.relation === 'conflict' ||
    fact?.relation === 'correction' ||
    REQUIRED_ATTRIBUTES.has(fact?.attribute)
  )
}

function refLabel(ref) {
  const recordId = typeof ref?.recordId === 'string' ? ref.recordId : null
  const callId = typeof ref?.callId === 'string' ? ref.callId : null
  if (recordId && callId) return recordId + '/' + callId
  if (recordId) return recordId
  return callId ?? 'unknown-source'
}

function refTime(ref) {
  const at = ref?.at
  if (typeof at !== 'string' || at.length === 0) return null
  return at
}

function clipTokens(text, maxTokens, marker) {
  const tokens = estimateTokensOf(text)
  if (tokens <= maxTokens) return { text, tokens, clipped: false }
  const bytes = Math.max(1, maxTokens * 4)
  const sliced = codePointSliceBytes(text, bytes)
  return { text: sliced + marker, tokens: estimateTokensOf(sliced + marker), clipped: true }
}

/** 纯字符串裁剪：卡渲染返回文本本身，token 计量由调用方按需进行。 */
function clipText(text, maxTokens, marker) {
  return clipTokens(text, maxTokens, marker).text
}

function codePointSliceBytes(text, maxBytes) {
  const chars = Array.from(text)
  let used = 0
  const out = []
  for (const ch of chars) {
    const size = Buffer.byteLength(ch, 'utf8')
    if (used + size > maxBytes) break
    used += size
    out.push(ch)
  }
  return out.join('')
}

function tokensSet(text) {
  return new Set(
    String(text ?? '')
      .toLowerCase()
      .split(/[\s/:;,.\-()\[\]{}"'、，。；：']+/)
      .filter((token) => token.length > 1),
  )
}

function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0
  let hit = 0
  for (const token of a) if (b.has(token)) hit += 1
  return hit / (a.size + b.size - hit)
}

// ---------------------------------------------------------------- 渲染（P3-4）

function attributeLabel(attribute) {
  switch (attribute) {
    case ATOM_ATTRIBUTES.EXIT_CODE: return '退出码'
    case ATOM_ATTRIBUTES.COMMAND: return '命令'
    case ATOM_ATTRIBUTES.TEST_SUMMARY: return '测试'
    case ATOM_ATTRIBUTES.ERROR_SIGNATURE: return '错误签名'
    case ATOM_ATTRIBUTES.VERSION: return '版本'
    case ATOM_ATTRIBUTES.TIME: return '时间'
    case ATOM_ATTRIBUTES.SPAN_EXCERPT: return '摘录'
    default: return '摘录'
  }
}

function relationTag(fact) {
  if (fact.relation === 'conflict') return '（冲突）'
  if (fact.relation === 'correction') return '（更正）'
  if (fact.polarity === 'negative') return '（否定/失败）'
  return ''
}

function renderFactLine(fact, shareContent) {
  const label = attributeLabel(fact.attribute)
  const tag = relationTag(fact)
  const refs = fact.sourceRefs.slice(0, 3).map(refLabel).join('、')
  const refSuffix = fact.sourceRefs.length > 3 ? '等 ' + fact.sourceRefs.length + ' 处' : ''
  return (
    '· ' + fact.entity + ' ' + label + ' ' + disclosedValue(fact, shareContent) + tag +
    (refs ? '｜来源 ' + refs + refSuffix : '')
  )
}

function renderTemplateLine(groupFacts, shareContent) {
  // 模板共享（P3-4）：重复操作骨架只展示一次——骨架 + 变化值列表 + 次数 +
  // 首末时间 + 来源索引；成员按 seq 排序保序（失败→复验通过两行都在，顺序不换）。
  const sorted = [...groupFacts].sort((a, b) => firstSeqOfFact(a) - firstSeqOfFact(b) || a.key.localeCompare(b.key))
  const base = sorted[0]
  const label = attributeLabel(base.attribute)
  const values = sorted.map((fact) => disclosedValue(fact, shareContent) + relationTag(fact)).join('、')
  const firstTime = firstNonNull(sorted.map(refTimeOfFact))
  const lastTime = lastNonNull(sorted.map(refTimeOfFact))
  const allRefs = []
  for (const fact of sorted) for (const ref of fact.sourceRefs) allRefs.push(refLabel(ref))
  const refSample = allRefs.slice(0, 4).join('、')
  const refSuffix = allRefs.length > 4 ? '等 ' + allRefs.length + ' 处' : ''
  const timePart =
    firstTime && lastTime && firstTime !== lastTime
      ? '（首 ' + firstTime + '，末 ' + lastTime + '）'
      : firstTime
        ? '（' + firstTime + '）'
        : ''
  return (
    '· ' + base.entity + ' ' + label + ' 重复 ' + sorted.length + ' 次：' + values + timePart +
    (refSample ? '｜来源 ' + refSample + refSuffix : '')
  )
}

function firstSeqOfFact(fact) {
  let min = Number.POSITIVE_INFINITY
  for (const ref of fact?.sourceRefs ?? []) {
    if (Number.isFinite(ref?.seq)) min = Math.min(min, ref.seq)
  }
  return Number.isFinite(min) ? min : Number.POSITIVE_INFINITY
}

function refTimeOfFact(fact) {
  for (const ref of fact?.sourceRefs ?? []) {
    const at = refTime(ref)
    if (at) return at
  }
  return null
}

function lastRefTimeOfFact(fact) {
  let out = null
  for (const ref of fact?.sourceRefs ?? []) {
    const at = refTime(ref)
    if (at) out = at
  }
  return out
}

function firstNonNull(values) {
  for (const value of values) if (value !== null) return value
  return null
}

function lastNonNull(values) {
  let out = null
  for (const value of values) if (value !== null) out = value
  return out
}

/**
 * 把事实集组织成渲染块。同组（模板共享组）合一块；单事实一块。
 * 每块带 token 计量、覆盖的原子键集、required 标志（组内任一成员必选即整块必选）。
 */
export function buildBlocks(facts, groups, { shareContent = false } = {}) {
  const groupByKey = new Map()
  for (const group of groups?.groups ?? []) {
    for (const key of group.keys) groupByKey.set(key, group)
  }
  const consumed = new Set()
  const blocks = []
  const byKey = new Map(facts.map((fact) => [fact.key, fact]))
  for (const group of groups?.groups ?? []) {
    const members = group.keys.map((key) => byKey.get(key)).filter(Boolean)
    if (members.length < GROUP_MIN_MEMBERS_FOR_TEMPLATE) continue
    for (const key of group.keys) consumed.add(key)
    const line = renderTemplateLine(members, shareContent)
    const required = members.some(factRequired)
    blocks.push({
      blockId: 'blk-' + hash16('template|' + group.keys.join(',')),
      line,
      tokens: estimateTokensOf(line),
      coverage: [...group.keys],
      required,
    })
  }
  for (const fact of facts) {
    if (consumed.has(fact.key)) continue
    const line = renderFactLine(fact, shareContent)
    blocks.push({
      blockId: 'blk-' + hash16('fact|' + fact.key),
      line,
      tokens: estimateTokensOf(line),
      coverage: [fact.key],
      required: factRequired(fact),
    })
  }
  blocks.sort((a, b) => a.blockId.localeCompare(b.blockId))
  return blocks
}

// ---------------------------------------------------------------- 预算覆盖选择（P3-5）

/**
 * 预算覆盖选择（P3-5）：
 * 1. required 块（冲突/更正/否定/约束/错误证据）先选——必需事实永不裁；
 * 2. 其余按「新增原子覆盖 ÷ token 成本」贪心装包（无回溯）；
 * 3. mmr=true 时对非必选候选做 MMR 重排（λ 起步 0.7）——只影响次序，
 *    数值/否定/版本差异已在必选集，相似性裁剪永远碰不到它们。
 *
 * @returns {selected, dropped, usedTokens, coverageCount, totalAtoms}
 */
export function budgetSelect(blocks, { budgetTokens = PHASE_CARD_MAX_TOKENS, mmr = false } = {}) {
  const selected = []
  const dropped = []
  const covered = new Set()
  let usedTokens = 0
  let requiredOverflow = false

  const requiredBlocks = blocks.filter((block) => block.required)
  for (const block of requiredBlocks) {
    if (usedTokens + block.tokens > budgetTokens) {
      // 必需事实装不下：整卡判 no-safe-gain（由调用层处理），此处如实报 overflow。
      requiredOverflow = true
      dropped.push({ blockId: block.blockId, reason: 'required-overflow' })
      continue
    }
    selected.push(block)
    usedTokens += block.tokens
    for (const key of block.coverage) covered.add(key)
  }

  let candidates = blocks.filter((block) => !block.required)
  if (mmr) candidates = mmrReorder(candidates, selected)

  while (candidates.length > 0 && usedTokens < budgetTokens) {
    let bestIndex = -1
    let bestScore = 0
    for (const [index, block] of candidates.entries()) {
      if (usedTokens + block.tokens > budgetTokens) continue
      let gain = 0
      for (const key of block.coverage) if (!covered.has(key)) gain += 1
      const score = gain / Math.max(1, block.tokens)
      if (score > bestScore) {
        bestScore = score
        bestIndex = index
      }
    }
    if (bestIndex < 0) break
    const block = candidates.splice(bestIndex, 1)[0]
    selected.push(block)
    usedTokens += block.tokens
    for (const key of block.coverage) covered.add(key)
  }
  for (const block of candidates) dropped.push({ blockId: block.blockId, reason: 'budget' })

  return {
    selected,
    dropped,
    usedTokens,
    coverageCount: covered.size,
    totalAtoms: blocks.reduce((sum, block) => sum + block.coverage.length, 0),
    requiredOverflow,
  }
}

function mmrReorder(candidates, selected) {
  if (candidates.length === 0) return candidates
  const remaining = [...candidates]
  const out = []
  const selectedTokens = selected.map((block) => tokensSet(block.line))
  while (remaining.length > 0) {
    let bestIndex = 0
    let bestScore = -Infinity
    for (const [index, block] of remaining.entries()) {
      const blockTokens = tokensSet(block.line)
      let maxSim = 0
      for (const set of selectedTokens) maxSim = Math.max(maxSim, jaccard(blockTokens, set))
      const coverage = Math.max(1, block.coverage.length)
      const score = MMR_LAMBDA * coverage - (1 - MMR_LAMBDA) * maxSim * coverage
      if (score > bestScore) {
        bestScore = score
        bestIndex = index
      }
    }
    const block = remaining.splice(bestIndex, 1)[0]
    out.push(block)
    selectedTokens.push(tokensSet(block.line))
  }
  return out
}

// ---------------------------------------------------------------- 查询相关摘录（P3-6）

/**
 * 查询相关摘录：含命中词的行 + 尾部限制条件行（末行非命中也保留——限制条件
 * 常在结尾），不固定取开头。确定性：按（命中数降序、行序升序）选行，再按行序
 * 拼接；总长封顶 maxChars。
 */
export function excerptLinesFor(queryTerms, body, { maxLines = 3, maxChars = EXCERPT_MAX_CHARS_DEFAULT } = {}) {
  const text = String(body ?? '')
  if (text.length === 0) return ''
  const rows = text.split('\n')
  const normalized = rows.map((row, index) => ({ row, index }))
  const nonEmpty = normalized.filter((entry) => entry.row.trim().length > 0)
  if (nonEmpty.length === 0) return ''
  const terms = (Array.isArray(queryTerms) ? queryTerms : [])
    .map((term) => String(term ?? '').trim().toLowerCase())
    .filter((term) => term.length > 0)
  if (terms.length === 0) {
    const picked = nonEmpty.slice(0, maxLines)
    return clipChars(picked.map((entry) => entry.row.trim()).join('\n'), maxChars)
  }
  const scored = nonEmpty.map((entry) => {
    const lower = entry.row.toLowerCase()
    let hits = 0
    for (const term of terms) if (lower.includes(term)) hits += 1
    return { ...entry, hits }
  })
  const hitRows = scored.filter((entry) => entry.hits > 0)
  if (hitRows.length === 0) {
    // 没有命中：退化为保守首尾行，不硬造相关性。
    const first = nonEmpty[0]
    const last = nonEmpty[nonEmpty.length - 1]
    const picks = nonEmpty.length > 1 ? [first, last] : [first]
    return clipChars(picks.map((entry) => entry.row.trim()).join('\n'), maxChars)
  }
  const ordered = [...hitRows].sort((a, b) => b.hits - a.hits || a.index - b.index)
  const chosen = ordered.slice(0, maxLines).map((entry) => entry.index)
  // 尾部限制条件行：末个非空行若无命中也保留（不占 maxLines 名额之外的第三行截断）。
  const lastIndex = nonEmpty[nonEmpty.length - 1].index
  if (!chosen.includes(lastIndex) && chosen.length < maxLines + 1) chosen.push(lastIndex)
  chosen.sort((a, b) => a - b)
  const parts = []
  let previous = -2
  for (const index of chosen) {
    const row = rows[index].trim()
    parts.push(index - previous > 1 && parts.length > 0 ? '…' + row : row)
    previous = index
  }
  return clipChars(parts.join('\n'), maxChars)
}

function clipChars(text, maxChars) {
  const value = String(text ?? '')
  if (maxChars <= 0) return ''
  const chars = Array.from(value)
  return chars.length <= maxChars ? value : chars.slice(0, maxChars).join('') + '…'
}

// ---------------------------------------------------------------- 层级卡渲染

/**
 * L2 阶段卡（纯函数、字节稳定、无时间戳）：渲染选定块 + 例外披露 + 展开入口。
 * 摘要只是可替换派生缓存——本卡内容来自 L0 原子（构造上不可能来自其他 L2）。
 */
export function renderPhaseCard({ summaryId, phaseLabel, memberCount, tools, blocks, manifestId, voucherId, dropped, truncated, modeNote }) {
  const header =
    '【阶段卡 ' + String(summaryId ?? '') + '】' + String(phaseLabel ?? '未命名阶段') +
    '（' + String(memberCount ?? 0) + ' 个已完成操作；工具 ' + (Array.isArray(tools) && tools.length > 0 ? tools.join('、') : '未记录') + '）'
  const lines = [header]
  for (const block of blocks) lines.push(block.line)
  if (Array.isArray(dropped) && dropped.length > 0) {
    lines.push('（预算内未收入 ' + dropped.length + ' 块非必需事实；逐条可展开）')
  }
  if (truncated === true) lines.push('（归组候选截断：桶过大，近似归组不完整）')
  if (modeNote) lines.push('（' + String(modeNote) + '）')
  lines.push('来源清单 manifest ' + String(manifestId ?? '') + '；逐条展开：/memory-lab expand ' + String(voucherId ?? '') + ' --page 1')
  return clipText(lines.join('\n'), PHASE_CARD_MAX_TOKENS, '\n（卡超界截断）')
}

/** L3 任务索引：阶段列表 + 各阶段入口（阶段卡 ID / 凭证 ID），不复制正文。 */
export function renderTaskIndex({ summaryId, phases }) {
  const lines = ['【任务索引 ' + String(summaryId ?? '') + '】']
  for (const phase of phases ?? []) {
    lines.push(
      '- ' + String(phase.phaseLabel ?? '未命名阶段') +
      '（' + String(phase.memberCount ?? 0) + ' 操作；阶段卡 ' + String(phase.summaryId ?? '无') +
      '；凭证 ' + String(phase.voucherId ?? '无') + '）',
    )
  }
  return lines.join('\n')
}

/** L1 证据卡（按需，单记录）：成员原子逐行，供 expand 的单条深挖。 */
export function renderEvidenceCard({ recordId, spanLabel, atoms, shareContent = false }) {
  const lines = [
    '【证据卡 ' + String(recordId ?? '') + '】' + String(spanLabel ?? 'span'),
  ]
  for (const atom of atoms ?? []) {
    lines.push('· ' + atom.entity + ' ' + attributeLabel(atom.attribute) + ' ' + disclosedValue(atom, shareContent))
  }
  // 模式说明行恒定：切换开关才变字节，同模式下逐字节稳定。
  lines.push('（' + shareModeNote(shareContent) + '）')
  return clipText(lines.join('\n'), PHASE_CARD_MAX_TOKENS, '\n（卡超界截断）')
}

// ---------------------------------------------------------------- no-safe-gain（P3-7）

/**
 * 无安全收益判定：按**最终渲染文本**（凭证含摘要与元数据）对比成员回执文本
 * 合计。不净缩短，或必需事实装不下（requiredOverflow），都判 no-safe-gain——
 * 保持原投影，不替换。
 */
export function noSafeGainCheck({ memberTokens, voucherText, requiredOverflow = false }) {
  const voucherTokens = estimateTokensOf(String(voucherText ?? ''))
  const net = memberTokens - voucherTokens
  if (requiredOverflow) {
    return { ok: false, reason: 'no-safe-gain', detail: '必需事实装不下（requiredOverflow）', memberTokens, voucherTokens, net }
  }
  if (net <= 0) {
    return { ok: false, reason: 'no-safe-gain', detail: '聚合不净缩短', memberTokens, voucherTokens, net }
  }
  return { ok: true, memberTokens, voucherTokens, net }
}