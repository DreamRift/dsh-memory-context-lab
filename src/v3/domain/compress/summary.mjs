/**
 * 确定性压缩摘要（M5）：只做首部切片，不做模型摘要、不引入新事实。
 * 普通归档默认使用（0.15.0 起：回执带摘要，原文与逐张恢复不变）；显式 compact 也复用。
 *
 * 0.15.0 P4 扩展（`summarizeRecordsStructured`）：把同一份确定性提取升为
 * 结构化草稿（goal/changes/outcome/openItems/evidenceRefs），供 SummaryArtifact
 * 的 extractive 生成路径使用。**不推断成功**：无法从记录确定结果时 outcome=unknown，
 * 正文写「结果待查」；「运行过测试」与「测试通过」仍必须是两个事实，本模块不做归因。
 *
 * 0.15.0 G6a 候选（`summarizeRecordsCandidate` / `extractive-v2-candidate`）：
 * 首部切片会把**后部更正与失败结论**切掉（F07）。候选改为「确定性选材 + 逐字摘引」：
 * 先按透明优先级选段（后部更正 / 失败原因 / 最终结果 / 未决事项 / 冲突 / 目标 / 进展 / 上下文），
 * 再把选中的**整段原文**按预算拼进摘要，并给每条片段留下 source ID 与码点半开区间。
 * 不调用模型、不改写正文、不推断结论；**默认关闭**（开关见 `resolveSummaryGenerator`）。
 */
import { V3ContractViolation } from '../../contracts/errors.mjs'
import { SUMMARY_LIMITS } from '../../contracts/summaries.mjs'

export const SUMMARY_MAX_CHARS = 220

/** 结构化提取的版本（独立版本化；升级不迫使旧摘要迁移）。 */
export const EXTRACTIVE_GENERATOR_VERSION = 'extractive-v1'

function excerpt(text, max) {
  const chars = [...String(text ?? '')]
  return chars.length <= max ? chars.join('') : chars.slice(0, max).join('') + '…'
}

/** 记录列表 → 单行摘要；总量有界；不读额外来源。 */
export function summarizeRecords(records, { maxChars = SUMMARY_MAX_CHARS } = {}) {
  if (!Array.isArray(records)) throw new V3ContractViolation('v3 compress: records 必须是数组')
  if (!Number.isInteger(maxChars) || maxChars < 1) throw new V3ContractViolation('v3 compress: maxChars 必须是正整数')
  const parts = []
  for (const record of records) {
    const text = excerpt(record?.payload?.text ?? '', 60)
    if (text.length === 0) continue
    const label = record?.kind === 'message-user' ? '用户' : (record?.kind === 'message-assistant' ? '助手' : '操作')
    parts.push(label + '：' + text)
  }
  const joined = parts.join('；')
  return [...joined].length <= maxChars ? joined : [...joined].slice(0, maxChars - 1).join('') + '…'
}

function labelOf(record) {
  if (record?.kind === 'message-user') return '用户'
  if (record?.kind === 'message-assistant') return '助手'
  return '操作'
}

/**
 * 确定性结构化摘要（不调用模型、不猜结果）。
 *
 * 字段与 SummaryArtifact 对齐（不要求全部非空，§6.4「可选字段」）：
 * - goal：第一条 user 消息的首部（没有则空）；
 * - changes：assistant/operation 的首部（最多 3 条）；
 * - outcome：恒 'unknown'——本函数没有判断完成度的证据来源；
 * - openItems：固定写「结果待查」，显式暴露未知而不是留空让人误读成「无遗留」；
 * - evidenceRefs：来源记录 ID 的前 3 条（真实记录 ID 才收）。
 *
 * @param {object[]} records 已读出正文的记录（只读 payload.text）
 * @param {{maxShortChars?:number, maxDetailChars?:number}} [options]
 */
export function summarizeRecordsStructured(records, { maxShortChars = 200, maxDetailChars = 3200 } = {}) {
  if (!Array.isArray(records)) throw new V3ContractViolation('v3 compress: records 必须是数组')
  if (!Number.isInteger(maxShortChars) || maxShortChars < 1) throw new V3ContractViolation('v3 compress: maxShortChars 必须是正整数')
  if (!Number.isInteger(maxDetailChars) || maxDetailChars < 1) throw new V3ContractViolation('v3 compress: maxDetailChars 必须是正整数')
  const lines = []
  const changes = []
  const evidenceRefs = []
  let goal = ''
  for (const record of records) {
    if (record === null || typeof record !== 'object') continue
    const text = excerpt(record?.payload?.text ?? '', 100)
    if (typeof record?.id === 'string' && evidenceRefs.length < 3 && !evidenceRefs.includes(record.id)) {
      evidenceRefs.push(record.id)
    }
    if (text.length === 0) continue
    if (goal.length === 0 && record.kind === 'message-user') goal = excerpt(text, 80)
    if (record.kind !== 'message-user' && changes.length < 3) changes.push(excerpt(text, 100))
    if (lines.length < 6) lines.push(labelOf(record) + '：' + text)
  }
  const shortParts = []
  if (goal.length > 0) shortParts.push('目标：' + goal)
  if (changes.length > 0) shortParts.push('进展：' + changes[0])
  shortParts.push('结果待查。')
  const shortRaw = shortParts.join('；')
  const shortText = [...shortRaw].length <= maxShortChars ? shortRaw : [...shortRaw].slice(0, maxShortChars - 1).join('') + '…'
  const detailRaw = lines.join('\n')
  const detail = [...detailRaw].length <= maxDetailChars ? detailRaw : [...detailRaw].slice(0, maxDetailChars - 1).join('') + '…'
  return {
    shortText,
    detail,
    goal,
    changes,
    outcome: 'unknown',
    decisions: [],
    openItems: ['结果待查（未能从记录确定完成/失败）'],
    evidenceRefs,
  }
}

// ============================================================================
// G6a：候选确定性摘要生成器（extractive-v2-candidate，默认关闭）
// ============================================================================
//
// 边界（开发流程 §12.1）：
// - **不调用模型**：只做确定性选材 + 逐字摘引，不推断任务结论（outcome 恒 unknown）；
// - **原文即事实**：摘要正文只包含来源记录的**整段**副本，因此「准备跑测试」不可能变成
//   「测试通过」、否定句不可能被反转——本模块没有改写与归因逻辑（字段型 goal/changes/
//   openItems 沿用既有「单项有上限」口径，只在超限时以省略号裁剪，不重写语义）；
// - **可追溯**：每条入选片段都带 source ID 与码点半开区间 [start,end)，随摘要工件落盘
//   （sourceSpans），可按「ID + 区间」回跳原文；
// - **默认关闭**：只有开关显式给出 {enabled:true, version:'extractive-v2-candidate'} 才启用；
//   非法配置一律失败关闭（回 extractive-v1），归档路径不因配置看不懂而失败。

/** 候选生成器版本：与 extractive-v1 并存，**升级不重写**已有回执/旧摘要（C-M-01）。 */
export const CANDIDATE_GENERATOR_VERSION = 'extractive-v2-candidate'

/** 模型草稿摘要生成器版本；application 负责生成流程，版本归 domain 契约管理。 */
export const MODEL_GENERATOR_VERSION = 'model-draft-v1'

/** 生成器版本封闭集（集合外的版本只读兼容，不重算、不回填历史）。 */
export const SUMMARY_GENERATOR_VERSIONS = Object.freeze([EXTRACTIVE_GENERATOR_VERSION, CANDIDATE_GENERATOR_VERSION])

/** 选材类别封闭集（顺序即默认优先级）。 */
const CANDIDATE_CATEGORIES = Object.freeze(['correction', 'failure', 'result', 'open', 'conflict', 'goal', 'progress', 'context'])

/** 段内顺序：latest-first 表达「后写的覆盖先写的」，earliest-first 表达「首因」。 */
const CANDIDATE_ORDERS = Object.freeze(['earliest-first', 'latest-first'])

/**
 * 默认选材优先级（**透明、可配置、稳定**）：
 * 类别顺序 = 预算先给谁；order = 同类内先取哪一端；maxItems = 该类最多几条。
 * 配置只能在这 8 个类别里挑选/重排（见 summarizeRecordsCandidate 的 priority 参数）。
 */
export const SUMMARY_SELECTION_PRIORITY = Object.freeze([
  Object.freeze({ category: 'correction', label: '后部更正', order: 'latest-first', maxItems: 2 }),
  Object.freeze({ category: 'failure', label: '失败原因', order: 'earliest-first', maxItems: 3 }),
  Object.freeze({ category: 'result', label: '最终结果', order: 'latest-first', maxItems: 2 }),
  Object.freeze({ category: 'open', label: '未决事项', order: 'earliest-first', maxItems: 2 }),
  Object.freeze({ category: 'conflict', label: '冲突表述', order: 'earliest-first', maxItems: 1 }),
  Object.freeze({ category: 'goal', label: '目标', order: 'earliest-first', maxItems: 1 }),
  Object.freeze({ category: 'progress', label: '进展', order: 'latest-first', maxItems: 2 }),
  Object.freeze({ category: 'context', label: '上下文', order: 'earliest-first', maxItems: 1 }),
])

/**
 * 类别标记（**只用于选材，不用于下结论**）：标记法只能说明「这一段像什么」，
 * 不能说明「任务成了没有」。appearance 顺序即匹配顺序（长标记同时出现时取优先级）
 */
const CANDIDATE_MARKERS = Object.freeze({
  correction: Object.freeze(['更正', '修正', '纠正', '应为', '实际是', '其实是', '而不是', '以最新为准', '作废', '推翻', '之前那条', '前面那条']),
  failure: Object.freeze(['失败', '报错', '错误', '异常', '未通过', '不通过', '没有通过', '超时', '拒绝', '崩溃', '阻塞', '失败原因', '根因']),
  result: Object.freeze(['最终结果', '结果：', '结论：', '最终', '已通过', '完成', '成功', '输出：', '返回：']),
  open: Object.freeze(['未决', '待办', '待查', '待确认', '尚未', '还没有', '仍需', '下一步', '遗留', '未验证', '未覆盖', 'TODO']),
  conflict: Object.freeze(['但是', '然而', '不过', '相反', '矛盾', '冲突', '另一方面']),
})

/** 句读边界（含换行）；命中即成段，段内不再切分。 */
const CANDIDATE_TERMINATORS = Object.freeze(['。', '！', '？', '；', '!', '?', ';', '\n', '…'])

/**
 * 多字符否定标记（长词优先）：硬切长段时**切点不得落在这些词内部**——否则「未通过」会被切成
 * 「未」+「通过」，读起来就像反转了结论。只做切点回退，不改写任何字符。
 *
 * R2（审查 2026-11-01）：单字条目（不/未/没/非）在这里是**死条目**（`maxPrefix` 恒为 0），
 * 且 `非` 没有任何多字标记以它开头 → 原先切点可以落在 `非` 之后（「甲乙丙非」+「常重要的」）。
 * 现在单字否定走独立规则 CANDIDATE_SINGLE_NEGATIONS，不再靠多字表间接覆盖。
 */
const CANDIDATE_NEGATIONS = Object.freeze([
  '不允许', '不代表', '不通过', '未通过', '没有通过', '不是', '并非', '无法', '不能', '不会', '不得',
  '尚未', '并未', '未被', '不再', '未验证', '未决', '禁止', '不要', '没有',
])

/** 单字否定：切点落在它**之后**时让它随下一段（保留「非」+「常」这类词的完整字形）。 */
const CANDIDATE_SINGLE_NEGATIONS = Object.freeze(['不', '未', '没', '非', '无', '别', '勿', '莫'])

function isPlainSummaryObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 开关归一化（唯一判据）。
 *
 * 默认（不传 / null）→ extractive-v1；非法配置一律**失败关闭**：回 extractive-v1 并给出
 * 原因码，绝不因为「配置看不懂」而启用候选，也**不抛错**（归档不因配置抖动失败）。
 * 候选只在 enabled === true **且** version === 'extractive-v2-candidate' 时启用。
 *
 * @param {null|{enabled?:boolean, version?:string}} [config]
 * @returns {{enabled:boolean, version:string, candidate:boolean, reason:string, detail?:string}}
 */
export function resolveSummaryGenerator(config = null) {
  const fallback = (reason, detail) => {
    const row = { enabled: false, version: EXTRACTIVE_GENERATOR_VERSION, candidate: false, reason }
    if (detail !== undefined) row.detail = detail
    return row
  }
  if (config === null || config === undefined) return fallback('default-off')
  if (!isPlainSummaryObject(config)) return fallback('config-invalid', 'summaryGenerator 必须是对象')
  for (const key of Object.keys(config)) {
    if (key !== 'enabled' && key !== 'version') return fallback('config-unknown-key', '未知键：' + key)
  }
  if (typeof config.enabled !== 'boolean') return fallback('config-invalid-enabled', 'enabled 必须是布尔值')
  if (config.enabled !== true) return fallback('disabled')
  if (typeof config.version !== 'string' || config.version.length === 0) {
    return fallback('config-invalid-version', '启用候选必须写明版本')
  }
  if (!SUMMARY_GENERATOR_VERSIONS.includes(config.version)) return fallback('config-invalid-version', '未知版本：' + config.version)
  if (config.version === CANDIDATE_GENERATOR_VERSION) {
    return { enabled: true, version: CANDIDATE_GENERATOR_VERSION, candidate: true, reason: 'candidate-enabled' }
  }
  return { enabled: true, version: EXTRACTIVE_GENERATOR_VERSION, candidate: false, reason: 'v1-selected' }
}

/** 段内硬切点的否定词回退（纯函数；只在切点落在否定词内部时回退到词首）。 */
function candidateSafeCut(chars, start, cut) {
  const span = cut - start
  if (span <= 1) return cut
  for (const marker of CANDIDATE_NEGATIONS) {
    const maxPrefix = Math.min(marker.length - 1, span - 1)
    for (let width = maxPrefix; width >= 1; width -= 1) {
      if (chars.slice(cut - width, cut).join('') === marker.slice(0, width)) {
        return cut - width > start ? cut - width : cut
      }
    }
  }
  // R2：单字否定让位——切点紧跟在单个否定字之后时回退 1，把该字带去下一段。
  if (cut - 1 > start && CANDIDATE_SINGLE_NEGATIONS.includes(chars[cut - 1])) return cut - 1
  return cut
}

/** 片段类别：标记优先（按优先级顺序），其次首段按记录类型落 goal/progress，其余是 context。 */
function candidateCategoryOf(text, record, isFirstSegment) {
  for (const rule of SUMMARY_SELECTION_PRIORITY) {
    const markers = CANDIDATE_MARKERS[rule.category]
    if (markers === undefined) continue
    for (const marker of markers) if (text.includes(marker)) return rule.category
  }
  if (isFirstSegment !== true) return 'context'
  if (record?.kind === 'message-user') return 'goal'
  // 只有助手正文的首段算「进展」；工具结果/系统消息的首段仍是上下文（不把日志当进展）。
  if (record?.kind === 'message-assistant') return 'progress'
  return 'context'
}

/**
 * 记录 → 片段（码点区间）。切分只发生在句读处；超长段在 maxSegmentChars 处硬切，
 * 且切点经过否定词回退——**片段边界不会把否定词切开**。
 * 没有稳定记录 ID 的正文不进摘要（可追溯是硬要求）。
 */
function candidateSegmentsOf(records, maxSegmentChars) {
  const segments = []
  for (let recordIndex = 0; recordIndex < records.length; recordIndex += 1) {
    const record = records[recordIndex]
    if (record === null || typeof record !== 'object') continue
    const recordId = typeof record.id === 'string' ? record.id : ''
    if (recordId.length === 0) continue
    const text = typeof record?.payload?.text === 'string' ? record.payload.text : ''
    if (text.length === 0) continue
    const chars = [...text]
    let first = true
    const emit = (from, to) => {
      let begin = from
      let end = to
      while (begin < end && /\s/u.test(chars[begin])) begin += 1
      while (end > begin && /\s/u.test(chars[end - 1])) end -= 1
      if (end <= begin) return
      const body = chars.slice(begin, end).join('')
      segments.push({
        recordIndex,
        recordId,
        kind: record.kind,
        start: begin,
        end,
        text: body,
        category: candidateCategoryOf(body, record, first),
      })
      first = false
    }
    let start = 0
    let cursor = 0
    while (cursor < chars.length) {
      if (CANDIDATE_TERMINATORS.includes(chars[cursor])) {
        emit(start, cursor + 1)
        start = cursor + 1
        cursor += 1
        continue
      }
      if (cursor - start + 1 >= maxSegmentChars) {
        const cut = candidateSafeCut(chars, start, cursor + 1)
        emit(start, cut)
        start = cut
        cursor = cut
        continue
      }
      cursor += 1
    }
    emit(start, chars.length)
  }
  return segments
}

/**
 * 同类候选排序：**以记录为单位**排序（latest-first = 后写的消息在前），记录内部仍按
 * 文档顺序——一条消息是一个判断单元，「后写覆盖先写」说的是消息，不是分句。
 */
function candidateOrderGroups(rows, order) {
  const byRecord = new Map()
  const recordOrder = []
  for (const row of rows) {
    if (!byRecord.has(row.recordIndex)) {
      byRecord.set(row.recordIndex, [])
      recordOrder.push(row.recordIndex)
    }
    byRecord.get(row.recordIndex).push(row)
  }
  const ordered = order === 'latest-first' ? recordOrder.slice().reverse() : recordOrder
  const out = []
  for (const key of ordered) out.push(...byRecord.get(key))
  return out
}

/** 选材优先级归一化（非法配置抛契约违规：选材规则看不懂就不产出摘要，不猜）。 */
function candidatePriorityOf(priority) {
  if (priority === null || priority === undefined) return SUMMARY_SELECTION_PRIORITY
  if (!Array.isArray(priority) || priority.length === 0) throw new V3ContractViolation('v3 compress: priority 必须是非空数组')
  const seen = new Set()
  const rows = []
  for (const entry of priority) {
    if (!isPlainSummaryObject(entry)) throw new V3ContractViolation('v3 compress: priority 每一项必须是对象')
    for (const key of Object.keys(entry)) {
      if (!['category', 'label', 'order', 'maxItems'].includes(key)) {
        throw new V3ContractViolation('v3 compress: priority 含未知字段：' + key)
      }
    }
    if (!CANDIDATE_CATEGORIES.includes(entry.category)) {
      throw new V3ContractViolation('v3 compress: priority 含未知类别：' + String(entry.category))
    }
    if (seen.has(entry.category)) throw new V3ContractViolation('v3 compress: priority 类别重复：' + entry.category)
    seen.add(entry.category)
    const order = entry.order === undefined ? 'earliest-first' : entry.order
    if (!CANDIDATE_ORDERS.includes(order)) throw new V3ContractViolation('v3 compress: priority.order 非法：' + String(entry.order))
    const maxItems = entry.maxItems === undefined ? 1 : entry.maxItems
    if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > SUMMARY_LIMITS.items) {
      throw new V3ContractViolation('v3 compress: priority.maxItems 必须是 1–' + SUMMARY_LIMITS.items + ' 的整数')
    }
    rows.push({
      category: entry.category,
      label: typeof entry.label === 'string' && entry.label.length > 0 ? entry.label : entry.category,
      order,
      maxItems,
    })
  }
  return rows
}

function candidateAssertBudget(value, name, limit) {
  if (!Number.isInteger(value) || value < 1 || value > limit) {
    throw new V3ContractViolation('v3 compress: ' + name + ' 必须是 1–' + limit + ' 的整数')
  }
}

/** 字段型摘引（有硬上限的字段）：只裁超限尾巴，不改写语义。 */
function candidateItemText(text) {
  const chars = [...String(text ?? '')]
  if (chars.length <= SUMMARY_LIMITS.item) return chars.join('')
  return chars.slice(0, SUMMARY_LIMITS.item - 1).join('') + '…'
}

/** 拼两段之间是否需要分隔符：上一段已以句读结尾就不再补「；」（省预算，也不出「。；」）。 */
function candidateNeedsSeparator(previous) {
  if (previous === undefined) return false
  return !CANDIDATE_TERMINATORS.includes(previous[previous.length - 1])
}

/** 整段装箱：**不切段**——放不下就跳过（宁缺不切），因此片段语义永远完整。 */
function candidatePack(rows, maxChars) {
  const pieces = []
  const packed = []
  let used = 0
  let previous = ''
  for (const row of rows) {
    const separator = candidateNeedsSeparator(pieces.length === 0 ? undefined : previous) ? '；' : ''
    const cost = separator.length + [...row.text].length
    if (used + cost > maxChars) continue
    if (separator.length > 0) pieces.push(separator)
    pieces.push(row.text)
    packed.push(row)
    used += cost
    previous = row.text
  }
  return { text: pieces.join(''), rows: packed, used }
}

function candidateDetailLineOf(row) {
  return labelOf(row) + '：' + row.text + '〔来源 ' + row.recordId + ' 第 ' + row.start + '–' + row.end + ' 码点〕'
}

/**
 * 呈现序（R1，审查 2026-11-01）：按（记录序号，段起点）升序——摘要正文必须**按时间顺序**读。
 * 选片与装箱按优先级（先给高价值类别预算），但**呈现**必须回到文档序：
 * 否则「后写的失败」会排到「更早的最终结果：全部通过」之后，整段读起来像「最终通过了」，
 * 与 §12.1「保持原文语义」相悖（这是 v1「看不见尾部」的镜像缺陷）。
 */
function candidateDocumentOrder(rows) {
  return rows.slice().sort((a, b) => (a.recordIndex - b.recordIndex) || (a.start - b.start))
}

/** 文档序拼接（分隔符规则与 candidatePack 相同）。 */
function candidateRenderParagraph(rows) {
  const pieces = []
  let previous = ''
  for (const row of rows) {
    const separator = candidateNeedsSeparator(pieces.length === 0 ? undefined : previous) ? '；' : ''
    if (separator.length > 0) pieces.push(separator)
    pieces.push(row.text)
    previous = row.text
  }
  return pieces.join('')
}

/**
 * 文档序渲染 + 预算收敛：重排可能改变分隔符数量，因此重排后**复算长度**；超预算时
 * **按优先级剥离**（rank 越大越先让预算），不砍末尾——末尾恰是后部更正与最终状态。
 */
function candidateFitParagraph(rows, maxChars) {
  let ordered = candidateDocumentOrder(rows)
  while (ordered.length > 0) {
    const text = candidateRenderParagraph(ordered)
    if ([...text].length <= maxChars) return { rows: ordered, text }
    let victim = 0
    for (let index = 1; index < ordered.length; index += 1) {
      if (ordered[index].rank > ordered[victim].rank) victim = index
    }
    ordered = ordered.slice(0, victim).concat(ordered.slice(victim + 1))
  }
  return { rows: [], text: '' }
}

/** 详细摘要的文档序渲染（每行带来源，行间以换行分隔）。 */
function candidateFitLines(entries, maxChars) {
  let ordered = entries.slice().sort((a, b) => (a.row.recordIndex - b.row.recordIndex) || (a.row.start - b.row.start))
  while (ordered.length > 0) {
    const text = ordered.map((entry) => entry.line).join('\n')
    if ([...text].length <= maxChars) return { rows: ordered.map((entry) => entry.row), text }
    let victim = 0
    for (let index = 1; index < ordered.length; index += 1) {
      if (ordered[index].row.rank > ordered[victim].row.rank) victim = index
    }
    ordered = ordered.slice(0, victim).concat(ordered.slice(victim + 1))
  }
  return { rows: [], text: '' }
}

/**
 * 候选确定性摘要（extractive-v2-candidate）：**不调用模型、不引入新事实**。
 *
 * 返回结构（成功时）：
 *   { ok:true, generatorVersion, draft:{shortText,detail,goal,changes,outcome:'unknown',
 *     decisions,openItems,evidenceRefs,sourceSpans:[{recordId,start,end}]}, selection:{...} }
 * 失败时（调用方按「省略摘要」处理，不得据此判归档失败）：
 *   { ok:false, reason:'no-selection'|'budget-too-small', detail }
 *
 * @param {object[]} records 已读出正文的记录（只读 id/kind/payload.text）
 * @param {object} [options]
 * @param {number} [options.maxShortChars] 短摘要预算（码点，≤ 合同上限）
 * @param {number} [options.maxDetailChars] 详细摘要预算（码点，≤ 合同上限）
 * @param {number} [options.maxSegmentChars] 单段硬切上限（码点）
 * @param {Array} [options.priority] 选材优先级（默认 SUMMARY_SELECTION_PRIORITY）
 */
export function summarizeRecordsCandidate(records, {
  maxShortChars = 200,
  maxDetailChars = 3200,
  maxSegmentChars = 120,
  priority = null,
} = {}) {
  if (!Array.isArray(records)) throw new V3ContractViolation('v3 compress: records 必须是数组')
  candidateAssertBudget(maxShortChars, 'maxShortChars', SUMMARY_LIMITS.shortText)
  candidateAssertBudget(maxDetailChars, 'maxDetailChars', SUMMARY_LIMITS.detail)
  candidateAssertBudget(maxSegmentChars, 'maxSegmentChars', SUMMARY_LIMITS.detail)
  const rules = candidatePriorityOf(priority)
  const segments = candidateSegmentsOf(records, maxSegmentChars)
  if (segments.length === 0) return { ok: false, reason: 'no-selection', detail: '没有任何可摘引的正文片段' }

  const picked = []
  const seen = new Set()
  for (const rule of rules) {
    const rows = segments.filter((segment) => segment.category === rule.category)
    const ordered = candidateOrderGroups(rows, rule.order)
    let taken = 0
    for (const row of ordered) {
      if (taken >= rule.maxItems || picked.length >= SUMMARY_LIMITS.items) break
      const key = row.recordId + '#' + row.start
      if (seen.has(key)) continue
      seen.add(key)
      // rank = 优先级位次（0 最高）：预算收敛时**先剥离 rank 大的**，让高价值类别留下。
      picked.push({ ...row, rank: picked.length })
      taken += 1
    }
    if (picked.length >= SUMMARY_LIMITS.items) break
  }
  if (picked.length === 0) return { ok: false, reason: 'no-selection', detail: '选材结果为空' }

  // ① 选片 + 定预算：按**优先级**顺序装箱（先给高价值类别预算，放不下就跳过，绝不切段）。
  const shortPacked = candidatePack(picked, maxShortChars)
  const detailPacked = []
  let detailChars = 0
  for (const row of picked) {
    const line = candidateDetailLineOf(row)
    const cost = [...line].length + (detailPacked.length === 0 ? 0 : 1)
    if (detailChars + cost > maxDetailChars) continue
    detailPacked.push({ row, line })
    detailChars += cost
  }
  // ② 呈现序：装箱完成后按（记录序号，段起点）重排为**文档序**（时间顺序），并在重排后
  //    复算长度、超预算时按优先级剥离。选材与呈现分开，是为了「预算优先给高价值类别」
  //    与「读者按时间顺序理解」两件事都不牺牲。
  const short = candidateFitParagraph(shortPacked.rows, maxShortChars)
  const detail = candidateFitLines(detailPacked, maxDetailChars)
  if (short.text.length === 0 && detail.text.length === 0) {
    return { ok: false, reason: 'budget-too-small', detail: '预算放不下任何整段（按合同省略摘要，不切段）' }
  }

  const goalRow = picked.find((row) => row.category === 'goal') ?? segments.find((row) => row.category === 'goal') ?? null
  const changes = picked.filter((row) => row.category === 'progress').map((row) => candidateItemText(row.text))
  const openRows = picked.filter((row) => row.category === 'open')
  const openItems = openRows.length > 0
    ? openRows.map((row) => candidateItemText(row.text))
    : ['结果待查（未能从记录确定完成/失败）']
  const evidenceRefs = []
  for (const row of picked) {
    if (evidenceRefs.length >= 3) break
    if (!evidenceRefs.includes(row.recordId)) evidenceRefs.push(row.recordId)
  }

  // sourceSpans 只覆盖真正进了摘要正文的片段（详细摘要 ⊇ 短摘要；取并集防预算差异），
  // 且**与正文同序**（文档序）：定位信息与读者看到的顺序一致。
  const spanKeys = new Set()
  const spanRows = []
  for (const row of [...short.rows, ...detail.rows]) {
    const key = row.recordId + '#' + row.start + '#' + row.end
    if (spanKeys.has(key)) continue
    spanKeys.add(key)
    spanRows.push(row)
  }
  spanRows.sort((a, b) => (a.recordIndex - b.recordIndex) || (a.start - b.start))
  const spans = spanRows.map((row) => ({ recordId: row.recordId, start: row.start, end: row.end }))

  return {
    ok: true,
    generatorVersion: CANDIDATE_GENERATOR_VERSION,
    draft: {
      shortText: short.text,
      detail: detail.text,
      goal: goalRow === null ? '' : candidateItemText(goalRow.text),
      changes,
      outcome: 'unknown',
      decisions: [],
      openItems,
      evidenceRefs,
      sourceSpans: spans,
    },
    selection: {
      priority: rules.map((rule) => rule.category),
      picked: picked.length,
      packedShort: short.rows.length,
      packedDetail: detail.rows.length,
      omitted: picked.length - detail.rows.length,
      renderOrder: 'document',
    },
  }
}
