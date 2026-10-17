/**
 * v2 检索层：多路检索、增量索引与来源关系。
 *
 * 设计约束（来自规范，逐条落到代码）：
 * - **复用而非重写**：精确 ID 回源、预算装包、分页由 readback.mjs 负责；本模块只管
 *   「怎么找到该读哪些 ID」。灵枢侧的多路检索/工作记录视图通过注入的 backend 复用，
 *   v2 不复制一套检索算法。
 * - **不把 session 筛选当安全隔离**：backend 的会话隔离靠独立隔离根与独立子进程，
 *   query 里带 session 只是过滤条件，代码不把它当权限边界（见 assertBackendContract）。
 * - **不把检索分数当置信度**：命中只带来源与序号，分数一律不透出；排序只影响顺序。
 * - **增量索引**：已索引的记录 ID 记账在会话目录，重复同步只处理新增，避免每次全量。
 */

import { readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { EngineV2Error } from './errors.mjs'
import { isForgotten } from './disposition.mjs'
import { registerProvenanceEdges } from './provenance-index.mjs'
import { RECEIPT_MARKER, V2_RECEIPT_MARKER } from '../core.mjs'
import { CARD_HEADER } from './working-state.mjs'

/** 命中来源：内置索引（确定性）与语义后端（灵枢）。 */
export const RETRIEVAL_SOURCES = Object.freeze({
  INDEX: 'index',
  SEMANTIC: 'semantic',
})

export const RETRIEVAL_INDEX_FILE = 'retrieval-index.json'
export const RETRIEVAL_INDEX_KIND = 'dsh-memory-context-lab/v2/retrieval-index'
export const RETRIEVAL_INDEX_SCHEMA_VERSION = 1

/**
 * 插件来源记录判定（D4）。
 *
 * 覆盖两类写入：ingest 的 `turn.user` 记录（卡片/回注包/回执，ingest 时按
 * `isPluginAuthoredMessage` 落 `inline.pluginAuthored`），以及归档 span 记录
 * （候选的 `pluginAuthored` 随单元写入 inline）。命中侧与索引同步侧共用这一
 * 个判据：插件自己的卡片沉入冷库是**原始历史**（可精确回读、可 restore），
 * 但不得进检索索引、不得作为「用户消息」回注——那会让模型把插件工作资料
 * 读成「用户说过这句话」（实测：回注包把卡片描述成已归档用户消息）。
 *
 * 诚实边界：本判定只认 inline 标记，**不读正文**。修复前已提交的记录没有该
 * 标记，索引同步侧对它们另有正文前缀兜底（`pluginAuthoredBody`，只在已读到
 * 正文的地方用）；命中侧无正文可读，旧记录只能靠换后端/重建索引清出。
 */
export function isPluginAuthoredEntry(entry) {
  return entry?.inline?.pluginAuthored === true
}

/** 回注块（`renderRecallBlock` 产物）的第一行前缀，与卡片/回执标记同表维护。 */
const RECALL_BLOCK_PREFIX = '以下是本会话隔离冷库中的【已归档操作】节选'

/**
 * 正文前缀兜底：修复前写入的插件形态（回执 / v2 回执 / 工作状态卡 / 回注块）。
 *
 * 只在**已经读到正文**的地方用（索引同步逐条读了有界正文；回注兜底列表取的
 * 是候选集子集）。canonicalize 后再比，防止行尾差异让前缀判定失效。
 */
export function pluginAuthoredBody(text) {
  const body = String(text ?? '').replace(/\r\n/g, '\n')
  return body.startsWith(RECEIPT_MARKER)
    || body.startsWith(V2_RECEIPT_MARKER)
    || body.startsWith(CARD_HEADER)
    || body.startsWith(RECALL_BLOCK_PREFIX)
}

function indexFileFor(directory) {
  return path.join(directory, RETRIEVAL_INDEX_FILE)
}

/**
 * 校验注入的 backend 是否符合契约。
 *
 * 契约刻意很小：`name`、`index(records)`、`query(text, { limit })`。
 * 不校验「它内部怎么隔离」——那是 backend 自己的责任，v2 不假装能验证别人的隔离。
 */
export function assertBackendContract(backend) {
  if (!backend || typeof backend !== 'object') {
    throw new EngineV2Error('检索后端必须是对象。', { code: 'ERETRIEVALBACKEND' })
  }
  if (typeof backend.name !== 'string' || backend.name.length === 0) {
    throw new EngineV2Error('检索后端必须提供非空 name（用于索引记账，区分后端）。', { code: 'ERETRIEVALBACKEND' })
  }
  if (typeof backend.index !== 'function') {
    throw new EngineV2Error('检索后端必须实现 index(records)。', { code: 'ERETRIEVALBACKEND' })
  }
  if (typeof backend.query !== 'function') {
    throw new EngineV2Error('检索后端必须实现 query(text, options)。', { code: 'ERETRIEVALBACKEND' })
  }
  return backend
}

/** 记录的元数据检索面（与 client-adapter 的 haystack 同口径的有界拼接）。 */
function literalHaystackOf(store, entry) {
  const parts = [entry.id, entry.kind, entry.fidelity ?? '']
  const callId = entry.refs?.callId
  if (typeof callId === 'string') parts.push(callId)
  const nodeId = entry.inline?.nodeId
  if (typeof nodeId === 'string') parts.push(nodeId)
  const spanKind = entry.refs?.spanKind
  if (typeof spanKind === 'string') parts.push(spanKind)
  return parts.join(' ')
}

/** 读索引记账；文件缺失或 schema 陌生时按「未索引」处理，不采信陌生内容。 */
export async function readRetrievalIndex(directory) {
  try {
    const raw = JSON.parse(await readFile(indexFileFor(directory), 'utf8'))
    if (raw?.kind !== RETRIEVAL_INDEX_KIND) return null
    if (raw?.schemaVersion !== RETRIEVAL_INDEX_SCHEMA_VERSION) return null
    if (typeof raw?.backend !== 'string' || typeof raw?.indexed !== 'object' || raw.indexed === null) return null
    return raw
  } catch {
    return null
  }
}

/**
 * 原子写索引记账。
 *
 * 直接 `writeFile` 到目标路径意味着「写到一半崩溃 = 索引文件半截 JSON」，
 * 下次读只会被当作「未索引」从头重建——记账白丢。先写临时文件再 rename，
 * 保证读到的要么是旧版本、要么是新版本。
 */
export async function writeRetrievalIndex(directory, { backend, indexed, generation = 1, watermark = null, visibilityRevision = null }) {
  const payload = {
    kind: RETRIEVAL_INDEX_KIND,
    schemaVersion: RETRIEVAL_INDEX_SCHEMA_VERSION,
    backend,
    updatedAt: new Date().toISOString(),
    indexed,
    // P1-4 索引代际：generation 单调递增标识一次完整同步；watermark 是本次同步
    // 时点 store 里最大记录 seq。读面据此判断「索引落后于库」并如实报 lag，
    // 而不是把索引建成时点当成现在。
    generation,
    watermark,
    // P2：本次同步时点的软遗忘账本 revision（null = 旧格式/未知）。它只是
    // 观测值：权威过滤在命中侧（searchRecords 的 push 闸门），不依赖它。
    visibilityRevision,
  }
  const target = indexFileFor(directory)
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`
  await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  await rename(temporary, target)
  return payload
}

/**
 * 交给检索后端的单条正文上限。
 *
 * 后端要索引的是**派生表示**（有界摘录 + 元数据 + 权威记录 ID），不是原文本身：
 * 原文的唯一权威来源是本会话 ArchiveStore。索引里放摘录是为了让检索能命中正文词，
 * 命中后一律按记录 ID 回源读权威原文，而不是把索引副本当原文用。
 */
export const INDEX_TEXT_MAX_BYTES = 8 * 1024

/**
 * 增量同步：只把「本后端尚未索引」的记录交给 backend.index。
 *
 * 换后端（name 不同）时记账作废，从头索引——不同后端的外部 ID 不可混用。
 *
 * **每条记录必须带上有界正文**：只给 `payload`（那是 {hash,size,encoding} 描述符）
 * 会让后端无内容可索引，于是「语义检索」永远搜不到库里真实存在的正文词，却仍报告
 * `semanticUsed: true` —— 那是把空索引冒充成语义召回。
 */
export async function syncRetrievalIndex({ directory, backend, store, batchSize = 200, textMaxBytes = INDEX_TEXT_MAX_BYTES, maxChunks = 4, forgetIndex = null }) {
  assertBackendContract(backend)
  const previous = await readRetrievalIndex(directory)
  const indexed = previous && previous.backend === backend.name ? { ...previous.indexed } : {}
  const entries = store.listEntries({ limit: Number.MAX_SAFE_INTEGER }).entries
  const candidates = entries.filter((entry) => typeof indexed[entry.id] !== 'string')
  // P2：软遗忘在同步侧的差集——待索引条目先剔除遗忘记录（与插件来源排除同款：
  // 不进索引、也不记成「已索引」）；已记进 indexed 的遗忘条目除名，T1（索引在
  // 文件里）还要物理清除（removeDocs），否则词法命中仍会回来。T2 没有主动清除
  // 原语（服务端语义未探针），如实报 unsupported，命中侧闸门照常拦截，换后端
  // 重建时账面除名兜底。
  const excludedForgottenIds = []
  let purgeReport = null
  if (forgetIndex) {
    for (const entry of candidates) {
      if (isForgotten(forgetIndex, entry.id)) excludedForgottenIds.push(entry.id)
    }
    const staleForgotten = []
    for (const id of Object.keys(indexed)) {
      if (isForgotten(forgetIndex, id)) {
        staleForgotten.push(id)
        delete indexed[id]
      }
    }
    if (staleForgotten.length > 0) {
      if (typeof backend.removeDocs === 'function') {
        try {
          const purge = await backend.removeDocs(staleForgotten)
          purgeReport = {
            removed: Array.isArray(purge?.removed) ? purge.removed : [],
            absent: Array.isArray(purge?.absent) ? purge.absent : [],
          }
        } catch (error) {
          purgeReport = { error: error instanceof Error ? error.message : String(error) }
        }
      } else {
        purgeReport = { unsupported: true }
      }
    }
  }
  const pending = forgetIndex
    ? candidates.filter((entry) => !isForgotten(forgetIndex, entry.id))
    : candidates
  const indexedNow = []
  const skippedNow = []
  // D4：插件来源记录（卡片/回注包/回执的 ingest 记录、插件卡片的归档 span）不进
  // 检索索引。它们仍是原始历史（可精确回读、可 restore），但被语义后端命中后回注
  // 会把插件工作资料冒充成「用户消息」。旧记录没有 inline 标记，这里读了有界正文，
  // 用正文前缀兜底（`pluginAuthoredBody`）；两个判定都不中的才交给后端。
  // 被排除的记录**不写进 indexed 记账**（从未打算索引，不是「已索引」）。
  const excludedPluginAuthored = []
  const admissible = []
  for (const entry of pending) {
    if (isPluginAuthoredEntry(entry)) {
      excludedPluginAuthored.push(entry.id)
      continue
    }
    admissible.push(entry)
  }
  const pluginAuthoredByBody = new Set()
  for (let offset = 0; offset < admissible.length; offset += batchSize) {
    const slice = admissible.slice(offset, offset + batchSize)
    const records = []
    for (const entry of slice) {
      // 有界读取：索引是派生面，不该为了建索引把整库正文全量载入内存。
      // `verifyHash: false` 因为这里不做完整性裁决（readRecord 自己会如实报 integrity）。
      //
      // 字段名是 `payloadText`（`store.readRecord` 的契约），不是 `text`：读错字段会拿到
      // `undefined`，于是后端收到一条没有正文的记录，仍然报告 `semanticUsed: true` ——
      // 那等于用空索引冒充语义召回，而且没有任何报错。
      const loaded = await store.readRecord(entry.id, { verifyHash: false, maxBytes: textMaxBytes })
      const text = loaded.ok === false || typeof loaded.payloadText !== 'string' ? null : loaded.payloadText
      // P1-7 分块索引：正文超过单块上限时继续读后续块（有界：maxChunks 块）。
      // 覆盖字节如实披露（textCoveredBytes / textFullBytes），超上限部分不算已索引。
      let textParts = null
      let coveredBytes = typeof text === 'string' ? Buffer.byteLength(text) : 0
      const fullBytes = Number.isFinite(loaded.fullBytes) ? loaded.fullBytes : 0
      if (loaded.truncated === true && text !== null) {
        textParts = [text]
        for (let chunk = 1; chunk < maxChunks && coveredBytes < fullBytes; chunk += 1) {
          const more = await store.readRecord(entry.id, { verifyHash: false, maxBytes: textMaxBytes, offsetBytes: coveredBytes })
          if (more.ok === false || typeof more.payloadText !== 'string' || more.payloadText.length === 0) break
          textParts.push(more.payloadText)
          coveredBytes += Buffer.byteLength(more.payloadText)
          if (more.truncated !== true) break
        }
      }
      // 旧记录兜底：正文命中插件形态（回执/卡片/回注块前缀）的不索引。截断的前缀
      // 仍足以判定（这些标记都在首行）；`text: null`（读失败）时**不**据正文排除——
      // 判定不出就按原行为交给后端，由后端如实报拒收，不能静默扩大排除面。
      if (text !== null && pluginAuthoredBody(text)) {
        pluginAuthoredByBody.add(entry.id)
        excludedPluginAuthored.push(entry.id)
        continue
      }
      records.push({
        id: entry.id,
        kind: entry.kind,
        fidelity: entry.fidelity,
        createdAt: entry.createdAt ?? null,
        seq: entry.seq ?? null,
        refs: entry.refs ?? {},
        inline: entry.inline ?? {},
        payload: entry.payload ?? null,
        // 派生索引用的有界正文。`textTruncated` 为 true 时后端必须知道它只拿到片段。
        text,
        textTruncated: loaded.truncated === true && coveredBytes < fullBytes,
        textIntegrity: loaded.ok === false ? loaded.error : loaded.integrity,
        textMaxBytes,
        // P1-7：分块后的正文块列表（单块内为 null）；后端逐块分词计入同一文档。
        textParts,
        // 覆盖披露：索引实际看到了多少字节 / 全文多少字节。
        textCoveredBytes: coveredBytes,
        textFullBytes: fullBytes,
      })
    }
    const result = await backend.index(records)
    // backend 可以返回它自己的外部 ID 映射；没有就记自身 ID（表示「已交给后端」）。
    const external = result && typeof result === 'object' ? result.externalIds ?? {} : {}
    // 后端如实报出「没写进去」的条目时，**绝不能**把它们记成已索引：
    // 记账谎称完整，之后每一次召回都会缺这一段，而且没有任何地方会报错。
    const rejected = new Set()
    if (result && typeof result === 'object') {
      for (const item of Array.isArray(result.skipped) ? result.skipped : []) {
        if (typeof item?.id === 'string') rejected.add(item.id)
      }
      for (const item of Array.isArray(result.conflicts) ? result.conflicts : []) {
        if (typeof item?.id === 'string') rejected.add(item.id)
      }
    }
    for (const entry of slice) {
      if (pluginAuthoredByBody.has(entry.id)) continue
      if (rejected.has(entry.id)) {
        skippedNow.push(entry.id)
        continue
      }
      indexed[entry.id] = typeof external[entry.id] === 'string' ? external[entry.id] : entry.id
      indexedNow.push(entry.id)
    }
  }
  // P2：本批新进索引的派生文档登记来源边（derived ← 自身记录）。批量一次落盘，
  // 注册失败不阻断索引同步（provenance 是审计旁证，记账权威在索引文件本身）。
  if (indexedNow.length > 0 && typeof registerProvenanceEdges === 'function') {
    try {
      await registerProvenanceEdges({
        sessionDir: directory,
        edges: indexedNow.map((id) => ({ derivedId: 'index-doc:' + id, derivedKind: 'retrieval-index', sourceIds: [id] })),
      })
    } catch { /* 只读/损坏时跳过注册 */ }
  }
  // P1-4：水位取本次同步时点 store 的最大记录 seq（含被排除的插件来源记录——
  // 它们也是 store 状态的一部分；水位是「看到了哪」，不是「索引了哪」）。
  const watermark = entries.reduce((max, entry) => (Number.isFinite(entry?.seq) && entry.seq > max ? entry.seq : max), 0)
  const generation = (Number.isFinite(previous?.generation) ? previous.generation : 0) + 1
  const payload = await writeRetrievalIndex(directory, { backend: backend.name, indexed, generation, watermark, visibilityRevision: forgetIndex ? forgetIndex.revision : null })
  return {
    backend: backend.name,
    indexedNow: indexedNow.length,
    indexedTotal: Object.keys(indexed).length,
    total: entries.length,
    // 后端明确拒收的条目：如实报出，让「索引完整」这句话有据可依。
    skippedNow,
    // D4：因插件来源被排除出索引的记录数（inline 标记 + 旧记录正文前缀兜底）。
    excludedPluginAuthored: excludedPluginAuthored.length,
    excludedPluginAuthoredIds: excludedPluginAuthored,
    // P2：因软遗忘被排除出索引的记录数 + T1/T2 的物理清除结果。
    excludedForgotten: excludedForgottenIds.length,
    excludedForgottenIds,
    purgeReport,
    visibilityRevision: forgetIndex ? forgetIndex.revision : null,
    // 换后端时如实报告重建，避免把「从零索引」说成「增量」。
    rebuilt: !(previous && previous.backend === backend.name),
    externalIds: indexed,
    payload,
  }
}

/**
 * 多路检索：内置字面索引 + 可选语义后端，合并去重并标注来源。
 *
 * 返回的命中**不带分数**：只带 `source` 与 `order`。排序是排序，不是置信度。
 */
export async function searchRecords({ store, backend = null, text, exact = [], limit = 20, literalMatcher, excluded = [], forgetIndex = null }) {
  const needle = String(text ?? '').trim()
  const exactTokens = (Array.isArray(exact) ? exact : [])
    .map((token) => (typeof token === 'string' ? token.trim() : ''))
    .filter((token) => token.length > 0)
  if (needle.length === 0 && exactTokens.length === 0) {
    throw new EngineV2Error('检索词不能为空。', { code: 'EINVAL' })
  }
  if (typeof literalMatcher !== 'function') {
    throw new EngineV2Error('内置字面检索需要 literalMatcher(entry, needle)。', { code: 'EINVAL' })
  }
  const byId = new Map()
  // P1-3：排除集（遗忘/会话过滤）在字面与语义两路都生效。
  const excludedIds = new Set((Array.isArray(excluded) ? excluded : []).filter((x) => typeof x === 'string'))
  const forgottenHitIds = new Set()
  const push = (id, source) => {
    // D4：插件来源记录不进命中面（索引同步侧已排除新写入，这里再挡一次语义后端
    // 里残留的旧索引命中——「索引同步与命中两处都过滤」）。判定不出（无标记的
    // 旧记录）按原行为保留，不静默扩大过滤面。
    if (isPluginAuthoredEntry(store.getEntry(id))) return
    // P1-3：排除集在 push 前生效（字面与语义两路共用此闸门）。
    if (excludedIds.has(id)) return
    // P2 遗忘复验：excluded 是调用方时点快照，这里再对账本查一次，拦下
    // ①T1 旧索引/字面已拦但语义后端残留的命中 ②T2 服务端无过滤的原始
    // 命中。拦下的命中按 id 计数披露（forgottenFiltered），不静默吞。
    if (forgetIndex && isForgotten(forgetIndex, id)) {
      forgottenHitIds.add(id)
      return
    }
    const existing = byId.get(id)
    if (existing) {
      if (!existing.sources.includes(source)) existing.sources.push(source)
      return
    }
    byId.set(id, { id, sources: [source] })
  }
  const entries = store.listEntries({ limit: Number.MAX_SAFE_INTEGER }).entries
  // 字面探针（0.10.1 R1-F2 修复）：自由词按 some（OR 召回），exact 约束按 every
  // （AND 语义）——此前 probes.some 让「只命中一个 exact 约束」的文档进命中面，
  // 与 T1 通道对同一 exact 数组的闸门口径不一致。
  const probes = [...new Set([needle, ...exactTokens])].filter((probe) => probe.length > 0)
  for (const entry of entries) {
    if (isPluginAuthoredEntry(entry)) continue
    const needleHit = needle.length > 0 ? literalMatcher(entry, needle) : false
    const exactHit = exactTokens.length > 0
      ? exactTokens.every((token) => literalMatcher(entry, token))
      : false
    if (needleHit || exactHit) push(entry.id, RETRIEVAL_SOURCES.INDEX)
  }
  let semanticUsed = false
  let semanticError = null
  let staleDropped = 0
  // P1-4 索引代际握手：读索引的 generation/watermark，对照当前 store 的最大 seq。
  // 索引落后时如实报 lag（滞后多少条记录），不把同步时点冒充现在；旧格式索引
  // 无水位（watermark 非Finite）时 lag 记 null——覆盖范围未知，不猜。
  const index = backend ? await readRetrievalIndex(store.directory) : null
  const indexGeneration = index && Number.isFinite(index.generation) ? index.generation : null
  const indexWatermark = index && Number.isFinite(index.watermark) ? index.watermark : null
  const laggedRecords = indexWatermark === null ? null : entries.reduce((count, entry) => (Number.isFinite(entry?.seq) && entry.seq > indexWatermark ? count + 1 : count), 0)
  if (backend) {
    assertBackendContract(backend)
    try {
      // P1-3 过滤前移 + 有界补取：排除集（遗忘/会话过滤）在 top-k 前就传给后端，
      // T1 直接跳过这些文档；T2 服务端过滤不了，就按 limit+补取量超量取回、
      // 客户端复验后再截断。渲染前 push() 仍会逐条复验（不信任后端过滤）。
      // P2：遗忘集合同样计入超量取回（T2 服务端不知道遗忘，只能客户端拦）。
      const fetchLimit = Math.max(1, limit) + excludedIds.size + (forgetIndex ? forgetIndex.forgotten.size : 0)
      const hits = await backend.query(needle, { limit: fetchLimit, exact: exactTokens, exclude: [...excludedIds] })
      // 只有查询真的成功返回才把这一路记成「用过」：抛错时标 true 会让上层
      // 把一次失败的语义调用渲染成 `literal+semantic`，等于给降级结果贴上语义标签。
      semanticUsed = true
      // backend 返回外部 ID 时用记账表换回本会话记录 ID；换不回来的丢弃（不猜）。
      const reverse = new Map()
      if (index && index.backend === backend.name) {
        for (const [recordId, externalId] of Object.entries(index.indexed)) {
          reverse.set(externalId, recordId)
        }
      }
      for (const hit of Array.isArray(hits) ? hits : []) {
        const externalId = typeof hit === 'string' ? hit : hit?.id
        if (typeof externalId !== 'string') continue
        const recordId = store.getEntry(externalId) ? externalId : reverse.get(externalId)
        if (!recordId || !store.getEntry(recordId)) continue
        push(recordId, RETRIEVAL_SOURCES.SEMANTIC)
      }
    } catch (error) {
      // 语义后端失败不拖垮检索：如实降级到内置索引，并把原因带出去。
      semanticUsed = false
      semanticError = error instanceof Error ? error.message : String(error)
    }
  }
  // 0.10.1 统一 exact 后验（R1-F1）：所有通道（字面/T1/T2）合并后的候选在 top-k
  // 前统一验证——每个 exact token 必须作为**子串**出现在记录正文（引号短语即连续
  // 顺序；路径/ID 按字面边界）。T1 的词元闸门只保证「词都出现过」，不保证顺序；
  // 短语语义在唯一有正文可读的这一层收口。读不到正文的候选如实丢弃（不猜）。
  if (exactTokens.length > 0) {
    const verified = new Map()
    for (const [id, hit] of byId) {
      const entry = store.getEntry(id)
      if (!entry) continue
      let body = null
      try {
        const loaded = await store.readRecord(id, { verifyHash: false, maxBytes: INDEX_TEXT_MAX_BYTES })
        if (loaded.ok !== false) body = typeof loaded.payloadText === 'string' ? loaded.payloadText : null
      } catch { body = null }
      const hay = ((body ?? '') + ' ' + literalHaystackOf(store, entry)).toLowerCase()
      const ok = exactTokens.every((token) => hay.includes(String(token).toLowerCase()))
      if (ok) verified.set(id, hit)
    }
    byId.clear()
    for (const [id, hit] of verified) byId.set(id, hit)
  }
  // P1-3 渲染前复验：命中的 id 在索引异步变更（遗忘、会话退出、并发同步）
  // 后可能已不在 store 里。返回前逐条重取，取不到的如实丢弃并计数，
  // 绝不把陈旧命中当有效结果渲染。
  const ordered = [...byId.values()].slice(0, Math.max(1, limit))
  const records = ordered.flatMap((hit, order) => {
    const entry = store.getEntry(hit.id)
    if (!entry) {
      staleDropped += 1
      return []
    }
    return [{ ...hit, order, entry }]
  })
  return {
    query: needle,
    records,
    totalMatched: byId.size,
    truncated: byId.size > records.length,
    semanticUsed,
    semanticError,
    // P1-3：复验时丢弃的陈旧命中数（渲染前从 store 取不到的 id）。
    staleDropped,
    // P1-4：索引代际观测——generation/watermark/lag（null = 旧格式索引无水位，覆盖未知）。
    indexGeneration,
    indexWatermark,
    laggedRecords,
    // P2：遗忘观测——push 闸门拦下的遗忘命中（0 = 无遗忘或遗忘集为空），
    // 以及查询时点的账本 revision 与索引文件记录的 revision（旧格式无值）。
    forgottenFiltered: forgottenHitIds.size,
    forgottenFilteredIds: [...forgottenHitIds].sort(),
    visibilityRevision: forgetIndex ? forgetIndex.revision : null,
    indexVisibilityRevision: index && Number.isFinite(index.visibilityRevision) ? index.visibilityRevision : null,
    sources: [...new Set(records.flatMap((record) => record.sources))],
  }
}

/**
 * 来源关系：一条记录的「来源」与「去向」。
 *
 * 只报可验证的结构关系（配对 callId、fork 映射、索引外部 ID），
 * 不做语义推断——「相关」是检索的事，不是来源关系。
 */
export function describeRecordRelations({ store, recordId, forkMap = null, retrievalIndex = null, backendName = null, forgetIndex = null }) {
  const entry = store.getEntry(recordId)
  if (!entry) {
    throw new EngineV2Error(`未知记录 ID：${recordId}`, { code: 'EREADNOTFOUND', details: { recordId } })
  }
  const relations = []
  // 未解析的引用单独如实报告：refs 里写着 callId，但对应记录不在本库时，
  // 说「无结构关系」会误导——正确说法是「有引用，但目标记录不在本库」。
  const unresolved = []
  const callId = entry.refs?.callId
  if (typeof callId === 'string') {
    let matched = 0
    for (const other of store.listEntries({ limit: Number.MAX_SAFE_INTEGER }).entries) {
      if (other.id === recordId) continue
      if (other.refs?.callId !== callId) continue
      // 已遗忘的配对伙伴不进关系面（安全审计 2026-10-17）：存在性也不泄露。
      if (forgetIndex && isForgotten(forgetIndex, other.id)) continue
      matched += 1
      relations.push({ kind: 'pairing', relation: other.kind === entry.kind ? 'same-kind' : 'call/result', recordId: other.id, callId })
    }
    if (matched === 0) {
      unresolved.push({ ref: 'callId', value: callId, note: '配对记录不在本库（可能属于其他会话或尚未写入）' })
    }
  }
  if (forkMap?.mapping) {
    // fork 映射的方向是「父记录 ID → 子记录 ID」（readback 用它按父 ID 回源）。
    const childId = forkMap.mapping[recordId]
    if (typeof childId === 'string') {
      relations.push({ kind: 'fork', relation: 'migrated-to-child', recordId: childId })
    }
    for (const [parentId, mapped] of Object.entries(forkMap.mapping)) {
      if (mapped === recordId && parentId !== recordId) {
        relations.push({ kind: 'fork', relation: 'inherited-from-parent', recordId: parentId })
      }
    }
  }
  if (retrievalIndex && backendName && retrievalIndex.backend === backendName) {
    const externalId = retrievalIndex.indexed?.[recordId]
    if (typeof externalId === 'string') {
      relations.push({ kind: 'index', relation: 'indexed-as', backend: backendName, externalId })
    }
  }
  return { recordId, kind: entry.kind, relations, unresolved }
}
