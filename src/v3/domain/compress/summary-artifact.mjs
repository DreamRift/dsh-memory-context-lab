/**
 * 摘要派生对象（domain/compress，纯函数，0.15.0 P4）。
 *
 * 设计约束（开发流程 §5.3 SummaryArtifact / §6.4）：
 * - **不可变**：本模块只构造与校验新对象；任何「更新」都是新建 + supersedes；
 * - **来源齐全**：每条来源 = (recordId, sourceHash)；sourceSetFingerprint 是同一份来源
 *   集合的稳定指纹（由调用方用注入的 sha256 算好，domain 不碰 node:crypto）；
 * - **模型草稿不自动可信**：generator='model' 的 verification 恒为 'unverified' 或
 *   'evidence-linked'（逐项来源可解析），不提供「已证实」档；
 * - **预算失败关闭**：超长一律拒绝，不静默截断（正文被截而来源不变会导致引用错位）。
 *
 * 与回执的关系：本对象是**详细摘要**；短回执里的摘要行只是它 shortText 的预算内呈现，
 * 回执正文一旦落面即固化，不再随新摘要改变。
 */
import {
  SUMMARY_LIMITS,
  SUMMARY_OUTCOMES,
  SUMMARY_SCHEMA_VERSION,
  SUMMARY_VERIFICATIONS,
  SUMMARY_GENERATORS,
  assertSummaryId,
  codePointLength,
} from '../../contracts/summaries.mjs'
import { V3ContractViolation } from '../../contracts/errors.mjs'

const HASH_PATTERN = /^[0-9a-f]{32,64}$/
const DRAFT_FIELDS = Object.freeze(['shortText', 'detail', 'goal', 'changes', 'outcome', 'decisions', 'openItems', 'evidenceRefs', 'sourceSpans'])
const ARTIFACT_FIELDS = Object.freeze([
  'schemaVersion', 'summaryId', 'sessionKey', 'generator', 'generatorVersion', 'verification',
  'createdAt', 'sources', 'sourceSetFingerprint', 'baseSummaryId', 'baseRevision', 'supersedes',
  'shortText', 'detail', 'goal', 'changes', 'outcome', 'decisions', 'openItems', 'evidenceRefs',
  'redactionVersion', 'idempotencyKey',
  // G6a：确定性生成器给出的「每条片段 → 来源记录 + 码点区间」。**可选**字段：
  // 旧摘要/模型草稿没有它，读路径按缺失兼容，不自动回填（C-M-01 只加字段）。
  'sourceSpans',
])

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function textField(value) {
  return typeof value === 'string' ? value : ''
}

function trimText(value) {
  return textField(value).replace(/[ \t]+$/u, '')
}

/**
 * 来源集合的稳定材料（唯一实现）：按 recordId 排序后的 [{recordId,hash}]。
 *
 * 指纹 = 注入的 sha256(本字符串)。写路径（materialize）、读路径（read/list/search）
 * 与导出路径必须共用这一份排序/序列化，否则「同集合不同顺序」会被算成不同指纹。
 */
export function sourceSetMaterial(sources) {
  const rows = (Array.isArray(sources) ? sources : []).map((source) => ({
    recordId: source?.recordId ?? null,
    hash: source?.hash ?? null,
  }))
  rows.sort((a, b) => {
    const left = String(a.recordId ?? '')
    const right = String(b.recordId ?? '')
    return left < right ? -1 : left > right ? 1 : 0
  })
  return JSON.stringify(rows)
}

/**
 * 来源集合完整性判定（P2-4，读/导出路径的唯一对账实现）。
 *
 * 失败关闭语义：hash 不可用、形状不对、指纹缺失或与 sources 算出的值不一致，都返回
 * `{ok:false, reason}`；调用方必须按「不可信/隐藏」处理，不能退回只看 sources 的宽松路径。
 * domain 不 touch node:crypto：sha256 由调用方注入。
 * @returns {{ok:true,reason:'verified'}|{ok:false,reason:'integrity-unavailable'|'invalid-artifact'|'missing-fingerprint'|'source-set-mismatch'}}
 */
export function summaryIntegrityOf(artifact, sha256) {
  if (typeof sha256 !== 'function') return { ok: false, reason: 'integrity-unavailable' }
  if (!isPlainObject(artifact) || !Array.isArray(artifact.sources)) return { ok: false, reason: 'invalid-artifact' }
  if (typeof artifact.sourceSetFingerprint !== 'string' || artifact.sourceSetFingerprint.length === 0) {
    return { ok: false, reason: 'missing-fingerprint' }
  }
  let actual
  try {
    actual = sha256(sourceSetMaterial(artifact.sources))
  } catch {
    return { ok: false, reason: 'integrity-unavailable' }
  }
  return actual === artifact.sourceSetFingerprint
    ? { ok: true, reason: 'verified' }
    : { ok: false, reason: 'source-set-mismatch' }
}

/**
 * 规范化模型草稿（结构校验唯一实现）。
 *
 * 不做「猜测补全」：字段缺失就是缺失；未知字段直接拒绝——宿主 schema 已经挡了一层，
 * 这里是应用层最后一道（测试/非宿主调用方可能绕过 schema）。
 * sourceSpans（G6a）只允许**确定性生成器**填写：模型不可能知道码点区间，草稿里出现它就是
 * 伪造来源定位，一律拒绝。旧草稿/旧摘要没有该字段，按缺失处理，不自动回填。
 *
 * @param {object} draft
 * @param {{sourceSpans?:boolean}} [options] 是否允许 sourceSpans（仅确定性生成器为 true）
 * @returns {{ok:true,value:object}|{ok:false,errors:string[]}}
 */
export function normalizeSummaryDraft(draft, { sourceSpans = false } = {}) {
  if (!isPlainObject(draft)) return { ok: false, errors: ['summary 必须是对象'] }
  const errors = []
  const known = new Set(DRAFT_FIELDS)
  for (const key of Object.keys(draft)) {
    if (!known.has(key)) errors.push('未知字段：' + key)
  }
  const value = {
    shortText: trimText(draft.shortText),
    detail: trimText(draft.detail),
    goal: trimText(draft.goal),
    changes: [],
    outcome: 'unknown',
    decisions: [],
    openItems: [],
    evidenceRefs: [],
  }
  if (value.shortText.length === 0 && value.detail.length === 0) errors.push('shortText 与 detail 不能同时为空')
  if (codePointLength(value.shortText) > SUMMARY_LIMITS.shortText) {
    errors.push('shortText 超过 ' + SUMMARY_LIMITS.shortText + ' 字（得到 ' + codePointLength(value.shortText) + '）')
  }
  if (codePointLength(value.detail) > SUMMARY_LIMITS.detail) {
    errors.push('detail 超过 ' + SUMMARY_LIMITS.detail + ' 字（得到 ' + codePointLength(value.detail) + '）')
  }
  if (codePointLength(value.goal) > SUMMARY_LIMITS.item) errors.push('goal 超过 ' + SUMMARY_LIMITS.item + ' 字')
  for (const key of ['changes', 'decisions', 'openItems']) {
    const list = draft[key]
    if (list === undefined) continue
    if (!Array.isArray(list)) { errors.push(key + ' 必须是数组'); continue }
    if (list.length > SUMMARY_LIMITS.items) { errors.push(key + ' 超过 ' + SUMMARY_LIMITS.items + ' 项'); continue }
    for (const item of list) {
      if (typeof item !== 'string') { errors.push(key + ' 的每一项必须是字符串'); continue }
      if (codePointLength(item) > SUMMARY_LIMITS.item) { errors.push(key + ' 单项超过 ' + SUMMARY_LIMITS.item + ' 字'); continue }
      value[key].push(trimText(item))
    }
  }
  if (draft.outcome !== undefined) {
    if (!SUMMARY_OUTCOMES.includes(draft.outcome)) errors.push('outcome 必须是 ' + SUMMARY_OUTCOMES.join('/') + ' 之一')
    else value.outcome = draft.outcome
  }
  if (draft.evidenceRefs !== undefined) {
    if (!Array.isArray(draft.evidenceRefs)) errors.push('evidenceRefs 必须是数组')
    else if (draft.evidenceRefs.length > SUMMARY_LIMITS.evidenceRefs) errors.push('evidenceRefs 超过 ' + SUMMARY_LIMITS.evidenceRefs + ' 项')
    else {
      for (const ref of draft.evidenceRefs) {
        if (typeof ref !== 'string' || ref.length === 0) { errors.push('evidenceRefs 的每一项必须是非空字符串'); continue }
        value.evidenceRefs.push(ref)
      }
    }
  }
  const spans = []
  if (draft.sourceSpans !== undefined) {
    if (sourceSpans !== true) {
      errors.push('sourceSpans 只允许确定性生成器填写（模型草稿不得声明来源码点范围）')
    } else if (!Array.isArray(draft.sourceSpans)) {
      errors.push('sourceSpans 必须是数组')
    } else if (draft.sourceSpans.length > SUMMARY_LIMITS.items) {
      errors.push('sourceSpans 超过 ' + SUMMARY_LIMITS.items + ' 条')
    } else {
      for (const span of draft.sourceSpans) {
        if (!isPlainObject(span)) { errors.push('sourceSpans 的每一项必须是对象'); continue }
        for (const key of Object.keys(span)) {
          if (key !== 'recordId' && key !== 'start' && key !== 'end') errors.push('sourceSpans 未知字段：' + key)
        }
        if (typeof span.recordId !== 'string' || !/^v3r-[0-9a-f]{16}$/.test(span.recordId)) {
          errors.push('sourceSpans 的 recordId 形状非法')
        }
        if (!Number.isInteger(span.start) || span.start < 0) errors.push('sourceSpans.start 必须是非负整数')
        if (!Number.isInteger(span.end) || !Number.isInteger(span.start) || span.end <= span.start) {
          errors.push('sourceSpans 必须满足 end > start')
        }
        spans.push({ recordId: span.recordId, start: span.start, end: span.end })
      }
    }
  }
  // **只在真的给了片段时才新增这个键**：没有片段的草稿（extractive-v1 / 模型草稿）必须保持
  // 与 0.15.0 HEAD 相同的 value 形状——否则压缩提案的载荷指纹会无谓漂移（off 等价）。
  if (spans.length > 0) value.sourceSpans = spans
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value }
}

/**
 * 校验落盘/读回的摘要对象（封闭形状 + 预算 + 来源完整性）。
 * 读路径必须过这一层：坏对象不能被当成「摘要不存在」，也不能被当成合法摘要。
 *
 * 传入 `{sha256}` 时额外**对账**：用 sources 重算 sourceSetMaterial 的指纹，与落盘
 * sourceSetFingerprint 不一致即报错（P2-4：只校验十六进制形状挡不住「删掉一条来源但
 * 保留旧指纹」的篡改）。不传 sha256 时只做形状校验——domain 不碰 node:crypto，
 * 真正需要可信判定的读/导出路径必须传入注入的 hash。
 * @param {object} artifact
 * @param {{sha256?:(text:string)=>string}} [options]
 * @returns {{ok:true,artifact:object}|{ok:false,errors:string[]}}
 */
export function validateSummaryArtifact(artifact, { sha256 } = {}) {
  if (!isPlainObject(artifact)) return { ok: false, errors: ['摘要必须是对象'] }
  const errors = []
  const known = new Set(ARTIFACT_FIELDS)
  for (const key of Object.keys(artifact)) if (!known.has(key)) errors.push('未知字段：' + key)
  if (artifact.schemaVersion !== SUMMARY_SCHEMA_VERSION) errors.push('schemaVersion 必须是 ' + SUMMARY_SCHEMA_VERSION)
  if (typeof artifact.summaryId !== 'string' || !/^v3s-[0-9a-f]{16}$/.test(artifact.summaryId)) errors.push('summaryId 形状非法')
  if (typeof artifact.sessionKey !== 'string' || artifact.sessionKey.trim().length === 0) errors.push('sessionKey 必须是非空字符串')
  if (!SUMMARY_GENERATORS.includes(artifact.generator)) errors.push('generator 必须是 ' + SUMMARY_GENERATORS.join('/') + ' 之一')
  if (!SUMMARY_VERIFICATIONS.includes(artifact.verification)) errors.push('verification 必须是 ' + SUMMARY_VERIFICATIONS.join('/') + ' 之一')
  if (typeof artifact.generatorVersion !== 'string' || artifact.generatorVersion.length === 0) errors.push('generatorVersion 必须是非空字符串')
  if (!Number.isFinite(artifact.createdAt) || artifact.createdAt < 0) errors.push('createdAt 必须是有限非负数')
  if (!Array.isArray(artifact.sources) || artifact.sources.length === 0) {
    errors.push('sources 必须是非空数组')
  } else {
    if (artifact.sources.length > SUMMARY_LIMITS.sources) errors.push('sources 超过 ' + SUMMARY_LIMITS.sources + ' 条')
    const seen = new Set()
    for (const source of artifact.sources) {
      if (!isPlainObject(source) || typeof source.recordId !== 'string' || !/^v3r-[0-9a-f]{16}$/.test(source.recordId)) {
        errors.push('sources 中的 recordId 形状非法')
        continue
      }
      if (typeof source.hash !== 'string' || !HASH_PATTERN.test(source.hash)) errors.push('sources 中的 hash 非法：' + source.recordId)
      if (seen.has(source.recordId)) errors.push('sources 重复：' + source.recordId)
      seen.add(source.recordId)
    }
  }
  if (typeof artifact.sourceSetFingerprint !== 'string' || !HASH_PATTERN.test(artifact.sourceSetFingerprint)) errors.push('sourceSetFingerprint 非法')
  // P2-4：指纹必须与 sources 对账；只查形状会让「删掉/替换来源」后的旧指纹继续可信。
  if (typeof sha256 === 'function' && Array.isArray(artifact.sources) && typeof artifact.sourceSetFingerprint === 'string') {
    if (summaryIntegrityOf(artifact, sha256).reason === 'source-set-mismatch') {
      errors.push('sourceSetFingerprint 与 sources 不一致')
    }
  }
  if (artifact.baseSummaryId !== null && (typeof artifact.baseSummaryId !== 'string' || !/^v3s-[0-9a-f]{16}$/.test(artifact.baseSummaryId))) errors.push('baseSummaryId 必须是 null 或摘要 ID')
  if (!Number.isInteger(artifact.baseRevision) || artifact.baseRevision < 0) errors.push('baseRevision 必须是非负整数')
  if (artifact.supersedes !== null && (typeof artifact.supersedes !== 'string' || !/^v3s-[0-9a-f]{16}$/.test(artifact.supersedes))) errors.push('supersedes 必须是 null 或摘要 ID')
  if (artifact.supersedes !== null && artifact.supersedes === artifact.summaryId) errors.push('supersedes 不得指向自身（循环来源图）')
  for (const key of ['shortText', 'detail', 'goal']) {
    if (typeof artifact[key] !== 'string') errors.push(key + ' 必须是字符串')
  }
  if (codePointLength(artifact.shortText) > SUMMARY_LIMITS.shortText) errors.push('shortText 超预算')
  if (codePointLength(artifact.detail) > SUMMARY_LIMITS.detail) errors.push('detail 超预算')
  if (codePointLength(artifact.goal) > SUMMARY_LIMITS.item) errors.push('goal 超预算')
  if (artifact.shortText.length === 0 && artifact.detail.length === 0) errors.push('shortText 与 detail 不能同时为空')
  for (const key of ['changes', 'decisions', 'openItems']) {
    const list = artifact[key]
    if (!Array.isArray(list)) { errors.push(key + ' 必须是数组'); continue }
    if (list.length > SUMMARY_LIMITS.items) errors.push(key + ' 超预算')
    for (const item of list) if (typeof item !== 'string' || codePointLength(item) > SUMMARY_LIMITS.item) errors.push(key + ' 单项非法')
  }
  if (!SUMMARY_OUTCOMES.includes(artifact.outcome)) errors.push('outcome 非法')
  if (!Array.isArray(artifact.evidenceRefs) || artifact.evidenceRefs.length > SUMMARY_LIMITS.evidenceRefs) {
    errors.push('evidenceRefs 非法')
  } else {
    const ids = new Set((Array.isArray(artifact.sources) ? artifact.sources : []).map((source) => source?.recordId))
    for (const ref of artifact.evidenceRefs) {
      if (typeof ref !== 'string' || !ids.has(ref)) errors.push('evidenceRefs 含来源集合之外的引用：' + String(ref))
    }
  }
  // G6a：sourceSpans 是**可选**字段（旧摘要没有它）。出现时必须能回指来源集合，
  // 且区间是码点半开区间；读路径不因缺字段失败，也不补造区间。
  if (artifact.sourceSpans !== undefined) {
    if (!Array.isArray(artifact.sourceSpans)) {
      errors.push('sourceSpans 必须是数组')
    } else if (artifact.sourceSpans.length === 0) {
      errors.push('sourceSpans 不得为空数组（没有片段就省略该字段）')
    } else {
      const spanIds = new Set((Array.isArray(artifact.sources) ? artifact.sources : []).map((source) => source?.recordId))
      for (const span of artifact.sourceSpans) {
        if (!isPlainObject(span)) { errors.push('sourceSpans 的每一项必须是对象'); continue }
        for (const key of Object.keys(span)) {
          if (key !== 'recordId' && key !== 'start' && key !== 'end') errors.push('sourceSpans 未知字段：' + key)
        }
        if (typeof span.recordId !== 'string' || !spanIds.has(span.recordId)) {
          errors.push('sourceSpans 指向来源集合之外的记录：' + String(span?.recordId))
        }
        if (!Number.isInteger(span.start) || span.start < 0) errors.push('sourceSpans.start 必须是非负整数')
        if (!Number.isInteger(span.end) || !Number.isInteger(span.start) || span.end <= span.start) {
          errors.push('sourceSpans 必须满足 end > start')
        }
      }
    }
  }
  if (!Number.isInteger(artifact.redactionVersion) || artifact.redactionVersion < 0) errors.push('redactionVersion 必须是非负整数')
  if (artifact.idempotencyKey !== null && (typeof artifact.idempotencyKey !== 'string' || artifact.idempotencyKey.length === 0 || artifact.idempotencyKey.length > 200)) {
    errors.push('idempotencyKey 必须是 null 或 1–200 字符')
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, artifact }
}

/**
 * 构造摘要对象（唯一构造点）。
 *
 * verification 判定：
 * - 模型草稿且 evidenceRefs 非空且全在来源集合内 → 'evidence-linked'（仍不是「已证实」）；
 * - 其余 → 'unverified'。
 *
 * @param {object} input
 * @param {string} input.summaryId 形如 v3s-<16hex>
 * @param {string} input.sessionKey 本会话隔离键
 * @param {Array<{recordId:string,hash:string}>} input.sources 来源记录与不可变字节 hash
 * @param {string} input.generator 'extractive'|'model'
 * @param {string} input.generatorVersion 生成器版本（独立版本化）
 * @param {object} input.draft 已规范化或原始草稿（内部再过 normalizeSummaryDraft）
 * @param {number} input.createdAt 创建时刻（clock 注入）
 * @param {string} input.sourceSetFingerprint 来源集合指纹（sha256）
 * @param {string|null} [input.baseSummaryId]
 * @param {number} [input.baseRevision]
 * @param {string|null} [input.supersedes]
 * @param {number} [input.redactionVersion]
 * @param {string|null} [input.idempotencyKey]
 * @returns {object} 已校验的 SummaryArtifact
 */
export function buildSummaryArtifact({
  summaryId, sessionKey, sources, generator, generatorVersion, draft, createdAt,
  sourceSetFingerprint, baseSummaryId = null, baseRevision = 0, supersedes = null,
  redactionVersion = 1, idempotencyKey = null,
} = {}) {
  assertSummaryId(summaryId)
  if (!SUMMARY_GENERATORS.includes(generator)) throw new V3ContractViolation('v3 summaries: generator 非法：' + String(generator))
  const normalized = normalizeSummaryDraft(draft, { sourceSpans: generator !== 'model' })
  if (!normalized.ok) throw new V3ContractViolation('v3 summaries: 草稿非法——' + normalized.errors.join('；'))
  const value = normalized.value
  const seen = new Set()
  const normalizedSources = []
  for (const source of Array.isArray(sources) ? sources : []) {
    if (!isPlainObject(source)) throw new V3ContractViolation('v3 summaries: sources 每一项必须是对象')
    if (typeof source.recordId !== 'string' || !/^v3r-[0-9a-f]{16}$/.test(source.recordId)) {
      throw new V3ContractViolation('v3 summaries: 来源记录 ID 非法（跨会话/未知引用一律拒绝）：' + JSON.stringify(source.recordId))
    }
    if (typeof source.hash !== 'string' || !HASH_PATTERN.test(source.hash)) {
      throw new V3ContractViolation('v3 summaries: 来源 hash 非法：' + source.recordId)
    }
    if (seen.has(source.recordId)) throw new V3ContractViolation('v3 summaries: 来源重复：' + source.recordId)
    seen.add(source.recordId)
    normalizedSources.push({ recordId: source.recordId, hash: source.hash })
  }
  if (normalizedSources.length === 0) throw new V3ContractViolation('v3 summaries: 至少需要一条来源记录')
  // G6a：片段区间必须落在**本摘要的来源集合**里（跨来源/未知记录的码点范围一律拒绝，
  // 否则「可回跳」就成了假的）。
  const draftSpans = Array.isArray(value.sourceSpans) ? value.sourceSpans : []
  const spanSourceIds = new Set(normalizedSources.map((source) => source.recordId))
  for (const span of draftSpans) {
    if (!spanSourceIds.has(span.recordId)) {
      throw new V3ContractViolation('v3 summaries: sourceSpans 指向来源集合之外的记录：' + span.recordId)
    }
  }
  const evidenceRefs = [...new Set(value.evidenceRefs)]
  const artifact = {
    schemaVersion: SUMMARY_SCHEMA_VERSION,
    summaryId,
    sessionKey,
    generator,
    generatorVersion,
    verification: generator === 'model' && evidenceRefs.length > 0 ? 'evidence-linked' : 'unverified',
    createdAt,
    sources: normalizedSources,
    sourceSetFingerprint,
    baseSummaryId,
    baseRevision,
    supersedes,
    shortText: value.shortText,
    detail: value.detail,
    goal: value.goal,
    changes: value.changes,
    outcome: value.outcome,
    decisions: value.decisions,
    openItems: value.openItems,
    evidenceRefs,
    redactionVersion,
    idempotencyKey,
  }
  // 只有真的给出片段时才写该字段：旧路径（extractive-v1 / 模型草稿）的工件字节与字段集合
  // 必须与 0.15.0 HEAD 完全相同（off 等价的构造性保证）。
  if (draftSpans.length > 0) artifact.sourceSpans = draftSpans
  const checked = validateSummaryArtifact(artifact)
  if (!checked.ok) throw new V3ContractViolation('v3 summaries: 构造出的摘要非法——' + checked.errors.join('；'))
  return artifact
}

/**
 * 摘要可见性（forget 级联唯一判据）：任何来源已遗忘 → 整条隐藏。
 *
 * 混合多源摘要不能「只删一个引用而保留泄露文本」（§7.4），所以不是过滤来源，
 * 而是整条不可读；调用方据此在 read/search/export 三处一致处理。
 * @returns {{visible:boolean, reason:string}}
 */
export function summaryVisibilityOf(artifact, forgottenRecordIds, { sha256 } = {}) {
  const forgotten = forgottenRecordIds instanceof Set ? forgottenRecordIds : new Set(forgottenRecordIds ?? [])
  if (!isPlainObject(artifact) || !Array.isArray(artifact.sources)) return { visible: false, reason: 'invalid-artifact' }
  // P2-4：来源集合必须与落盘指纹对账；不一致 = 正文可能来自被删掉的来源 → 整条隐藏。
  // 不传 sha256 时无法判定（domain 不碰 hash），仍按旧形状判据——调用方必须在本插件
  // 的读/导出路径传入注入的 sha256（application/summary 与 domain/export 均如此）。
  if (typeof sha256 === 'function') {
    const integrity = summaryIntegrityOf(artifact, sha256)
    if (integrity.ok !== true) return { visible: false, reason: integrity.reason }
  }
  for (const source of artifact.sources) {
    if (forgotten.has(source?.recordId)) return { visible: false, reason: 'forgotten-source' }
  }
  return { visible: true, reason: 'visible' }
}

/**
 * 按码点裁剪（**保留给非回执用途**；回执路径已改用 {@link clampSummaryTextByUnits}）。
 *
 * P3-03 之后回执只有一个单位（UTF-16 码元），码点版不再被 src 消费；contract-wiring 的
 * 「导出必须被消费或进白名单」守卫会把它判成零消费。这里不删：
 * - 它是码点语义的正确实现，摘要工件的**展示层**（按「字」计）仍需要它；
 * - 删掉会让「按字裁剪」与「按码元裁剪」两个概念重新混成一团。
 * 因此改为**非导出**的内部实现 + 显式说明，而不是在白名单里堆一个无理由条目。
 * @param {string} text
 * @param {number} maxChars 码点上限（含省略号）
 */
function clampSummaryTextByCodePoints(text, maxChars) {
  const chars = [...String(text ?? '')]
  if (!Number.isInteger(maxChars) || maxChars <= 0) return ''
  if (chars.length <= maxChars) return chars.join('')
  if (maxChars === 1) return '…'
  return chars.slice(0, maxChars - 1).join('') + '…'
}

/**
 * 按 **UTF-16 码元**裁剪摘要短文本（P3-03）。
 *
 * 为什么不复用按码点裁剪（clampSummaryTextByCodePoints）：回执的**净收益判据**是
 * `receiptText.length < sourceChars`，两边都是 UTF-16 码元（`String#length` 与
 * `payload.text.length`）。用码点预算去裁、再用码元长度去比，星平面字符（emoji、部分
 * 古文字）每个码点在 UTF-16 里占 2 个码元：预算 N 个码点可能产出一个 2N 码元的摘要，
 * 回执就被推过原文——本该归档的小步骤被判 not-worth，或者反过来把「净收益为正」算错。
 *
 * 裁剪不切断代理对：落点落在高位代理上时回退一个码元，宁可少一个字也不产出半个字符。
 * @param {string} text 摘要正文
 * @param {number} maxUnits UTF-16 码元上限（含省略号）
 * @returns {string}
 */
export function clampSummaryTextByUnits(text, maxUnits) {
  const value = String(text ?? '')
  if (!Number.isInteger(maxUnits) || maxUnits <= 0) return ''
  if (value.length <= maxUnits) return value
  if (maxUnits === 1) return '…'
  let head = value.slice(0, maxUnits - 1)
  const last = head.charCodeAt(head.length - 1)
  // 0xD800–0xDBFF 是高位代理（surrogate）：单独留下它就是一个半字符，回退一位整体丢掉这个码点。
  // 用码点数字比较（不写字面量），避免源码里出现只出现一次的十六进制字面量被
  // contract-wiring 的「单点标识符」启发式误判成潜伏引用。
  const HIGH_SURROGATE_MIN = 0xd800
  const HIGH_SURROGATE_MAX = 0xdbff
  if (last >= HIGH_SURROGATE_MIN && last <= HIGH_SURROGATE_MAX) head = head.slice(0, -1)
  return head + '…'
}

/**
 * 摘要的稳定物化指纹（用于 voucher.summaryRef 里的 hash）。
 * 只覆盖会影响回执/检索内容与来源的字段；createdAt/summaryId 参与（身份不可伪装）。
 */
export function canonicalSummaryMaterial(artifact) {
  if (!isPlainObject(artifact)) throw new V3ContractViolation('v3 summaries: canonical 需要摘要对象')
  const sources = Array.isArray(artifact.sources)
    ? artifact.sources.map((source) => ({ recordId: source?.recordId ?? null, hash: source?.hash ?? null }))
    : []
  const material = {
    schemaVersion: artifact.schemaVersion,
    summaryId: artifact.summaryId,
    sessionKey: artifact.sessionKey,
    generator: artifact.generator,
    generatorVersion: artifact.generatorVersion,
    verification: artifact.verification,
    // P3-1：身份与派生关系字段也必须进指纹——只比正文会让「同载荷、不同 createdAt/
    // supersedes/baseSummaryId/baseRevision/redactionVersion/idempotencyKey」被静默当成
    // 同一对象吞掉（summary-store 的同 ID/同幂等键判据直接比这份材料）。
    createdAt: artifact.createdAt,
    baseSummaryId: artifact.baseSummaryId,
    baseRevision: artifact.baseRevision,
    supersedes: artifact.supersedes,
    redactionVersion: artifact.redactionVersion,
    idempotencyKey: artifact.idempotencyKey,
    sourceSetFingerprint: artifact.sourceSetFingerprint,
    sources,
    shortText: artifact.shortText,
    detail: artifact.detail,
    goal: artifact.goal,
    changes: artifact.changes,
    outcome: artifact.outcome,
    decisions: artifact.decisions,
    openItems: artifact.openItems,
    evidenceRefs: artifact.evidenceRefs,
  }
  // G6a：sourceSpans **只在存在时**进入指纹。旧摘要（无该字段）的材料字符串逐字节不变，
  // 因此既有 voucher.summaryRef.hash 不会被这次生成器升级改写。
  if (Array.isArray(artifact.sourceSpans) && artifact.sourceSpans.length > 0) {
    material.sourceSpans = artifact.sourceSpans.map((span) => ({
      recordId: span?.recordId ?? null,
      start: span?.start ?? null,
      end: span?.end ?? null,
    }))
  }
  return JSON.stringify(material)
}