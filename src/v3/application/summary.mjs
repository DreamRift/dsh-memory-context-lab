/**
 * 摘要用例（application/summary，0.15.0 P4）。
 *
 * 职责：来源绑定 → 生成（确定性/模型草稿）→ 不可变物化 → 读/搜/可见性。
 * 不碰宿主表面、不改 voucher、不做任务状态机（§6.5：本版不建独立 TaskSnapshot 系统）。
 *
 * 依赖方向：只 import contracts/domain；存储与随机/时钟/hash 全部注入。
 * 摘要读取永远重算可见性（forget 级联的唯一判据在 domain），不在创建时冻结
 * 「当时可见」——否则 forget 后旧摘要会变成泄露面。
 */
import { V3ContractViolation } from '../contracts/index.mjs'
import { SUMMARY_LIMITS } from '../contracts/summaries.mjs'
import {
  buildSummaryArtifact,
  canonicalSummaryMaterial,
  normalizeSummaryDraft,
  sourceSetMaterial,
  summaryIntegrityOf,
  summaryVisibilityOf,
  validateSummaryArtifact,
} from '../domain/compress/summary-artifact.mjs'
import {
  CANDIDATE_GENERATOR_VERSION,
  EXTRACTIVE_GENERATOR_VERSION,
  MODEL_GENERATOR_VERSION,
  resolveSummaryGenerator,
  summarizeRecordsCandidate,
  summarizeRecordsStructured,
} from '../domain/compress/summary.mjs'

export { MODEL_GENERATOR_VERSION }

const HEX_OF_UUID = (uuid) => String(uuid).replace(/-/g, '').toLowerCase()

/**
 * 来源记录的不可变字节指纹材料：只覆盖「按 ID 回读会拿到什么」。
 * 不含 transactionId/createdAt——它们是审计线索，不改变来源正文；把它们算进来
 * 会让同一份记录的等价副本（导入/重建）被误判漂移。
 */
export function recordHashMaterial(record) {
  if (record === null || typeof record !== 'object') throw new V3ContractViolation('v3 summary: 来源记录必须是对象')
  return JSON.stringify({
    id: record.id,
    kind: record.kind,
    text: record.payload?.text ?? '',
    bytes: record.payload?.bytes ?? null,
    structure: record.payload?.structure ?? null,
    metaOnly: record.payload?.metaOnly === true,
  })
}

/**
 * @param {object} deps
 * @param {object} deps.store SessionStore 端口（readRecord/listForgotten）
 * @param {{now:()=>number}} deps.clock
 * @param {{uuid:()=>string}} deps.random
 * @param {{sha256:(text:string)=>string}} deps.hash
 * @param {object} deps.summaries summary-store 适配器 {append,list}
 */
export function createSummaryService({ store, clock, random, hash, summaries } = {}) {
  if (store === null || typeof store !== 'object') throw new V3ContractViolation('v3 summary: 需要 store')
  if (clock === null || typeof clock?.now !== 'function') throw new V3ContractViolation('v3 summary: 需要 clock.now')
  if (random === null || typeof random?.uuid !== 'function') throw new V3ContractViolation('v3 summary: 需要 random.uuid')
  if (hash === null || typeof hash?.sha256 !== 'function') throw new V3ContractViolation('v3 summary: 需要 hash.sha256（来源 hash 不得由 domain 自算）')
  if (summaries === null || typeof summaries?.append !== 'function' || typeof summaries?.list !== 'function') {
    throw new V3ContractViolation('v3 summary: 需要 summaries 适配器 {append,list}')
  }

  function directoryOf(entry) {
    const directory = entry?.runtime?.store?.directory
    if (typeof directory !== 'string' || directory.length === 0) throw new V3ContractViolation('v3 summary: 会话目录不可用')
    return directory
  }

  /** 来源 hash 表（按 ID 排序，稳定）。 */
  async function sourceFactsOf(entry, recordIds) {
    if (!Array.isArray(recordIds) || recordIds.length === 0) return { ok: false, reason: 'no-sources' }
    if (recordIds.length > SUMMARY_LIMITS.sources) return { ok: false, reason: 'too-many-sources' }
    const seen = new Set()
    const sources = []
    const records = []
    for (const id of recordIds) {
      if (typeof id !== 'string' || seen.has(id)) return { ok: false, reason: 'invalid-source-id' }
      seen.add(id)
      let record
      try {
        record = await store.readRecord(id)
      } catch (error) {
        return { ok: false, reason: error?.code === 'EFORGOTTEN' ? 'source-forgotten' : 'source-unreadable', error, recordId: id }
      }
      if (record === null || typeof record !== 'object' || record.id !== id) return { ok: false, reason: 'source-not-found', recordId: id }
      sources.push({ recordId: id, hash: hash.sha256(recordHashMaterial(record)) })
      records.push(record)
    }
    sources.sort((a, b) => (a.recordId < b.recordId ? -1 : a.recordId > b.recordId ? 1 : 0))
    return { ok: true, sources, records }
  }

  /** 来源集合指纹（同集合同顺序 → 同指纹；hash 变化 → 指纹变化）。 */
  function sourceSetFingerprintOf(sources) {
    return hash.sha256(sourceSetMaterial(sources))
  }

  /**
   * 读路径的完整性判定（P2-4，唯一入口）：sources 重算指纹必须等于落盘值。
   * 返回原因；ok=false 一律按「不可信/隐藏」处理，不退回只看 sources 的宽松路径。
   */
  function integrityOf(artifact) {
    return summaryIntegrityOf(artifact, hash.sha256)
  }

  /**
   * 物化一条新摘要（唯一写入口）。
   *
   * @param {object} input
   * @param {object} input.entry 运行时 entry（目录/存储）
   * @param {string} input.sessionKey 会话隔离键（必须与 entry 一致）
   * @param {string[]} input.recordIds 来源记录（本会话）
   * @param {'extractive'|'model'} [input.generator]
   * @param {object} [input.draft] 模型草稿（generator=model 时必填）
   * @param {string|null} [input.idempotencyKey]
   * @param {string|null} [input.supersedes]
   * @param {string|null} [input.baseSummaryId]
   * @param {number} [input.baseRevision]
   * @param {null|{enabled?:boolean, version?:string}} [input.summaryGenerator]
   *   G6a 生成器开关（默认 null = 现行 extractive-v1）。非法配置失败关闭回 v1，
   *   候选只在 {enabled:true, version:'extractive-v2-candidate'} 时启用。
   * @param {object|null} [input.summaryOptions] 候选生成器的预算/选材优先级（仅候选路径消费）
   * @returns {Promise<object>} {ok:true,artifact,appended} | {ok:false,reason,errors?}
   *   候选路径预算不足时返回 {ok:false, reason:'summary-omitted', omitted:true}：调用方应
   *   **省略摘要**继续归档，不得据此判归档失败（§12.1）。
   */
  async function materialize({ entry, sessionKey, recordIds, generator = 'extractive', draft = null, idempotencyKey = null, supersedes = null, baseSummaryId = null, baseRevision = 0, summaryGenerator = null, summaryOptions = null } = {}) {
    const directory = directoryOf(entry)
    const facts = await sourceFactsOf(entry, recordIds)
    if (!facts.ok) return facts
    let effectiveDraft = draft
    let effectiveGenerator = generator === 'model' ? 'model' : 'extractive'
    let effectiveVersion = MODEL_GENERATOR_VERSION
    let candidateDecision = null
    if (effectiveGenerator === 'model') {
      const normalized = normalizeSummaryDraft(draft)
      if (!normalized.ok) return { ok: false, reason: 'draft-invalid', errors: normalized.errors }
      // 逐项来源不存在/越界 = 跨来源引用：拒绝，不进入物化。
      const allowed = new Set(facts.sources.map((source) => source.recordId))
      const outside = normalized.value.evidenceRefs.filter((ref) => !allowed.has(ref))
      if (outside.length > 0) return { ok: false, reason: 'evidence-ref-outside-sources', errors: outside }
      effectiveDraft = normalized.value
    } else {
      // G6a：默认（不传开关 / 配置非法）走现行 extractive-v1，输出与 HEAD 逐字节一致。
      const decision = resolveSummaryGenerator(summaryGenerator)
      if (decision.candidate === true && decision.version === CANDIDATE_GENERATOR_VERSION) {
        const candidate = summarizeRecordsCandidate(facts.records, summaryOptions ?? {})
        if (candidate.ok !== true) {
          // 没有可摘引片段 / 预算放不下整段：**省略摘要**，不抛错、不让归档失败。
          return { ok: false, reason: 'summary-omitted', omitted: true, detail: candidate.reason, generator: decision }
        }
        candidateDecision = decision
        effectiveDraft = candidate.draft
        effectiveVersion = candidate.generatorVersion
      } else {
        effectiveDraft = summarizeRecordsStructured(facts.records)
        effectiveVersion = EXTRACTIVE_GENERATOR_VERSION
      }
    }
    const artifact = buildSummaryArtifact({
      summaryId: 'v3s-' + HEX_OF_UUID(random.uuid()).slice(0, 16),
      sessionKey,
      sources: facts.sources,
      generator: effectiveGenerator,
      generatorVersion: effectiveVersion,
      draft: effectiveDraft,
      createdAt: clock.now(),
      sourceSetFingerprint: sourceSetFingerprintOf(facts.sources),
      baseSummaryId,
      baseRevision,
      supersedes,
      redactionVersion: 1,
      idempotencyKey: typeof idempotencyKey === 'string' && idempotencyKey.length > 0 ? idempotencyKey : null,
    })
    const written = await summaries.append(directory, artifact, {
      // 锁内复核：来源仍可读、hash 未变、会话绑定未变。锁外检查会被 forget 抢先。
      guard: async () => {
        const forgotten = new Set(typeof store.listForgotten === 'function' ? store.listForgotten() : [])
        for (const source of facts.sources) {
          if (forgotten.has(source.recordId)) return { ok: false, reason: 'source-forgotten' }
          let current
          try {
            current = await store.readRecord(source.recordId)
          } catch (error) {
            return { ok: false, reason: error?.code === 'EFORGOTTEN' ? 'source-forgotten' : 'source-unreadable' }
          }
          if (current === null || hash.sha256(recordHashMaterial(current)) !== source.hash) return { ok: false, reason: 'source-drift' }
        }
        return { ok: true }
      },
    })
    if (written?.ok === false) return written
    if (written?.appended === false) return { ok: true, artifact: written.existing, appended: false }
    // 返回对象在 off 路径上与 HEAD 完全一致（不新增字段）；只有候选路径多带一份只读开关决策。
    return candidateDecision === null
      ? { ok: true, artifact, appended: true }
      : { ok: true, artifact, appended: true, generator: candidateDecision }
  }

  /** 读一条摘要（含可见性；不存在返回 null，损坏抛错由调用方处理）。 */
  async function read({ entry, summaryId } = {}) {
    const listed = await summaries.list(directoryOf(entry))
    if (!listed.ok) return { ok: false, reason: 'summaries-damaged', detail: listed.reason }
    const artifact = listed.rows.find((row) => row?.summaryId === summaryId)
    if (artifact === undefined) return { ok: false, reason: 'summary-not-found' }
    const checked = validateSummaryArtifact(artifact, { sha256: hash.sha256 })
    if (!checked.ok) {
      // 形状合法但来源指纹对不上：按「不可信/隐藏」回报具体原因，让工具面
      // 读得到 visible=false + reason（而不是含混的 summary-invalid）。
      const integrity = integrityOf(artifact)
      if (integrity.reason === 'source-set-mismatch') {
        return { ok: true, artifact, visibility: { visible: false, reason: 'source-set-mismatch' } }
      }
      return { ok: false, reason: 'summary-invalid', errors: checked.errors }
    }
    const forgotten = new Set(typeof store.listForgotten === 'function' ? store.listForgotten() : [])
    const visibility = summaryVisibilityOf(artifact, forgotten, { sha256: hash.sha256 })
    return { ok: true, artifact, visibility }
  }

  /** 列摘要：可见的返回正文；不可见的只留身份与原因（不返回正文）。 */
  async function list({ entry, limit = 20 } = {}) {
    const listed = await summaries.list(directoryOf(entry))
    if (!listed.ok) return { ok: false, reason: 'summaries-damaged', detail: listed.reason }
    const forgotten = new Set(typeof store.listForgotten === 'function' ? store.listForgotten() : [])
    const rows = []
    for (const artifact of listed.rows) {
      const checked = validateSummaryArtifact(artifact, { sha256: hash.sha256 })
      if (!checked.ok) {
        const reason = integrityOf(artifact).reason === 'source-set-mismatch' ? 'source-set-mismatch' : 'summary-invalid'
        rows.push({ summaryId: typeof artifact?.summaryId === 'string' ? artifact.summaryId : null, valid: false, visible: false, reason })
        continue
      }
      const visibility = summaryVisibilityOf(artifact, forgotten, { sha256: hash.sha256 })
      rows.push(visibility.visible
        ? {
          summaryId: artifact.summaryId, valid: true, visible: true,
          generator: artifact.generator, verification: artifact.verification,
          createdAt: artifact.createdAt, shortText: artifact.shortText,
          sourceCount: artifact.sources.length, supersedes: artifact.supersedes,
        }
        : { summaryId: artifact.summaryId, valid: true, visible: false, reason: visibility.reason, generator: artifact.generator, verification: artifact.verification, createdAt: artifact.createdAt })
    }
    rows.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
    return { ok: true, total: rows.length, rows: rows.slice(0, Math.max(1, Math.min(50, limit))) }
  }

  /** 字面检索摘要（不看模型语义；不返回分数，避免把名次当置信度）。 */
  async function search({ entry, query, limit = 10 } = {}) {
    const needle = typeof query === 'string' ? query.trim().toLowerCase() : ''
    if (needle.length === 0) return { ok: false, reason: 'empty-query' }
    const listed = await summaries.list(directoryOf(entry))
    if (!listed.ok) return { ok: false, reason: 'summaries-damaged', detail: listed.reason }
    const forgotten = new Set(typeof store.listForgotten === 'function' ? store.listForgotten() : [])
    const hits = []
    for (const artifact of listed.rows) {
      if (!validateSummaryArtifact(artifact, { sha256: hash.sha256 }).ok) continue
      if (!summaryVisibilityOf(artifact, forgotten, { sha256: hash.sha256 }).visible) continue
      const haystack = [artifact.summaryId, artifact.shortText, artifact.detail, artifact.goal, ...(artifact.decisions ?? []), ...(artifact.openItems ?? [])].join('\n').toLowerCase()
      if (!haystack.includes(needle)) continue
      hits.push({
        summaryId: artifact.summaryId,
        createdAt: artifact.createdAt,
        generator: artifact.generator,
        verification: artifact.verification,
        excerpt: artifact.shortText,
        sourceCount: artifact.sources.length,
      })
    }
    hits.sort((a, b) => b.createdAt - a.createdAt)
    return { ok: true, total: hits.length, items: hits.slice(0, Math.max(1, Math.min(50, limit))) }
  }

  /** forget 影响面：返回会被本次遗忘隐藏的摘要 ID（只读，不写）。 */
  async function affectedByForget({ entry, recordIds } = {}) {
    const listed = await summaries.list(directoryOf(entry))
    if (!listed.ok) return { ok: false, reason: 'summaries-damaged' }
    const targets = new Set(Array.isArray(recordIds) ? recordIds : [])
    const ids = []
    for (const artifact of listed.rows) {
      if (!Array.isArray(artifact?.sources)) continue
      if (artifact.sources.some((source) => targets.has(source?.recordId))) ids.push(artifact.summaryId)
    }
    return { ok: true, summaryIds: ids }
  }

  /** 物化指纹（voucher.summaryRef.hash 的唯一来源）。 */
  function fingerprintOf(artifact) {
    return hash.sha256(canonicalSummaryMaterial(artifact))
  }

  return { materialize, read, list, search, affectedByForget, fingerprintOf }
}
