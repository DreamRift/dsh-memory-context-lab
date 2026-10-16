/**
 * 来源图（provenance sidecar，P2）。
 *
 * 记录「派生物 ← 来源」边：检索索引文档、表面回执、（P3 起）层级摘要都以
 * 同一契约注册。遗忘一个来源时，依赖它的派生物按有界 BFS 标失效——失效
 * 只标记（invalidation 条目），不删数据；复验（revalidation）在各自读面
 * 用确定性重建完成。
 *
 * 反向边（P2-2）：从任意记录 ID 查「谁派生自它」，供 forget preview 报告
 * 级联影响。
 *
 * 崩溃安全（计划 §3 注入点①）：append-only JSONL + LF + 键排序；半行按
 * 截断修复；中部损坏 → `damaged: true`，写侧拒绝（EPROVENANCEDAMAGED）、
 * 读侧带告警继续（来源图缺失只降级级联报告的完整性，不影响权威过滤）。
 *
 * 环拒绝：注册边前检查「来源的祖先链里是否已含 derived」——含则拒绝，
 * 防止 A←B←A 的循环派生把 BFS 变成死循环。
 */

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

export const PROVENANCE_FILE = 'provenance.jsonl'
export const PROVENANCE_HEADER_KIND = 'dsh-memory-context-lab/v2/provenance'
export const PROVENANCE_SCHEMA_VERSION = 1
export const PROVENANCE_EDGE = 'provenance/edge'
export const PROVENANCE_INVALIDATION = 'provenance/invalidation'
/** 有界 BFS 上限：节点数与深度都封顶，超出如实报告截断。 */
export const PROVENANCE_BFS_MAX_NODES = 512
export const PROVENANCE_BFS_MAX_DEPTH = 8

export class ProvenanceError extends Error {
  constructor(message, { code = 'EPROVENANCE', ...details } = {}) {
    super(message)
    this.name = 'ProvenanceError'
    this.code = code
    for (const [key, value] of Object.entries(details)) this[key] = value
  }
}

export function provenancePath(sessionDir) {
  return path.join(sessionDir, PROVENANCE_FILE)
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson)
  if (value !== null && typeof value === 'object') {
    const out = {}
    for (const key of Object.keys(value).sort()) out[key] = canonicalJson(value[key])
    return out
  }
  return value
}

function canonicalLine(value) {
  return JSON.stringify(canonicalJson(value))
}

function parseProvenanceText(text) {
  const lines = text.split('\n')
  const trailingNewline = /\n$/.test(text)
  const completeLines = trailingNewline ? lines.slice(0, -1) : lines.slice(0, -1)
  const partialLine = trailingNewline ? '' : lines[lines.length - 1]
  const entries = []
  let damaged = false
  let damageDetail = null
  let sawHeader = false
  for (let index = 0; index < completeLines.length; index += 1) {
    const raw = completeLines[index]
    if (raw.length === 0) continue
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      damaged = true
      damageDetail = { line: index + 1, message: error.message }
      break
    }
    if (!sawHeader) {
      if (parsed?.kind !== PROVENANCE_HEADER_KIND || parsed?.schemaVersion !== PROVENANCE_SCHEMA_VERSION) {
        damaged = true
        damageDetail = { line: index + 1, message: '首行不是合法 provenance header' }
        break
      }
      sawHeader = true
      continue
    }
    if (parsed?.kind !== PROVENANCE_EDGE && parsed?.kind !== PROVENANCE_INVALIDATION) {
      damaged = true
      damageDetail = { line: index + 1, message: `未知条目 kind：${JSON.stringify(parsed?.kind)}` }
      break
    }
    entries.push(parsed)
  }
  return { entries, damaged, damageDetail, partialLine }
}

/**
 * 读取来源图。尾部半行截断修复（repairedBytes 记账）；中部损坏 →
 * `damaged: true` + 已解析前缀，读侧告警、写侧拒绝。
 */
export async function loadProvenance(sessionDir) {
  let text
  try {
    text = await readFile(provenancePath(sessionDir), 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return { state: 'absent', entries: [], damaged: false, repairedBytes: 0 }
    throw error
  }
  if (text.length === 0) return { state: 'absent', entries: [], damaged: false, repairedBytes: 0 }
  const parsed = parseProvenanceText(text)
  let repairedBytes = 0
  if (parsed.partialLine && parsed.partialLine.length > 0) {
    await writeFile(provenancePath(sessionDir), Buffer.from(text.slice(0, text.length - parsed.partialLine.length), 'utf8'))
    repairedBytes = Buffer.byteLength(parsed.partialLine, 'utf8')
  }
  return {
    state: parsed.damaged ? 'damaged' : 'ok',
    entries: parsed.entries,
    damaged: parsed.damaged,
    damageDetail: parsed.damageDetail ?? null,
    repairedBytes,
  }
}

/**
 * 纯函数折叠：边表（derived → {kind, sources}）+ 失效表（derived → causes）。
 * 重复注册同一条边幂等（同 derived + 同 sourceIds 集合只记一条生效）。
 */
export function foldProvenance(entries) {
  const edges = new Map()
  const invalidated = new Map()
  for (const entry of entries) {
    if (entry?.kind === PROVENANCE_EDGE) {
      const sourceIds = [...new Set(entry.sourceIds ?? [])].sort()
      const key = entry.derivedId
      const existing = edges.get(key)
      if (!existing) edges.set(key, { derivedKind: entry.derivedKind ?? null, sourceIds })
      else {
        const merged = [...new Set([...existing.sourceIds, ...sourceIds])].sort()
        edges.set(key, { derivedKind: existing.derivedKind ?? entry.derivedKind ?? null, sourceIds: merged })
      }
    } else if (entry?.kind === PROVENANCE_INVALIDATION) {
      const causes = invalidated.get(entry.derivedId) ?? []
      if (!causes.includes(entry.cause)) causes.push(entry.cause)
      invalidated.set(entry.derivedId, causes)
    }
  }
  return { edges, invalidated }
}

/** 反向边查询：这些记录分别是哪些派生物的来源（forget preview 的级联报告）。 */
export function dependentsOf(recordIds, folded) {
  const wanted = new Set(recordIds)
  const out = []
  for (const [derivedId, edge] of folded.edges) {
    const hitSources = edge.sourceIds.filter((id) => wanted.has(id))
    if (hitSources.length > 0) out.push({ derivedId, derivedKind: edge.derivedKind, viaSources: hitSources })
  }
  return out
}

function assertWritable(loaded, action) {
  if (loaded.damaged) {
    throw new ProvenanceError(
      `provenance 账本损坏（${loaded.damageDetail?.line ? '第 ' + loaded.damageDetail.line + ' 行：' : ''}${loaded.damageDetail?.message ?? ''}），${action} 已拒绝`,
      { code: 'EPROVENANCEDAMAGED' },
    )
  }
}

/**
 * 注册一条派生边。环拒绝：若任一来源的祖先链（沿边向上）已包含 derived，
 * 注册拒绝——这是结构不可能（A 派生自 B 又是 B 的祖先）而不是策略问题。
 */
export async function registerProvenanceEdge({ sessionDir, derivedId, derivedKind, sourceIds }) {
  if (typeof derivedId !== 'string' || derivedId.length === 0) {
    throw new ProvenanceError('derivedId 非法', { code: 'EINVAL' })
  }
  if (!Array.isArray(sourceIds) || sourceIds.some((id) => typeof id !== 'string')) {
    throw new ProvenanceError('sourceIds 非法', { code: 'EINVAL' })
  }
  const loaded = await loadProvenance(sessionDir)
  assertWritable(loaded, 'provenance 注册')
  const folded = foldProvenance(loaded.entries)
  // 环检测：derived 的祖先集合（含传递）不得包含任何待注册来源……反过来：
  // 任一来源不得出现在「以 derived 为起点的祖先链」上，即 source ∈ ancestors(derived∪sources)。
  const ancestors = new Set()
  const queue = [...new Set(sourceIds)]
  let steps = 0
  while (queue.length > 0 && steps < PROVENANCE_BFS_MAX_NODES) {
    const current = queue.shift()
    if (ancestors.has(current)) continue
    ancestors.add(current)
    const edge = folded.edges.get(current)
    if (edge) for (const source of edge.sourceIds) if (!ancestors.has(source)) queue.push(source)
    steps += 1
  }
  if (ancestors.has(derivedId)) {
    throw new ProvenanceError(
      `注册 ${derivedId} ← [${sourceIds.join(', ')}] 会形成派生环（${derivedId} 已在来源的祖先链上）`,
      { code: 'ECYCLE' },
    )
  }
  const entry = {
    kind: PROVENANCE_EDGE,
    derivedId,
    derivedKind: String(derivedKind ?? ''),
    sourceIds: [...new Set(sourceIds)].sort(),
    registeredAt: new Date().toISOString(),
  }
  await mkdir(sessionDir, { recursive: true })
  let hasFile = false
  try {
    await readFile(provenancePath(sessionDir), 'utf8')
    hasFile = true
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  if (!hasFile) {
    await appendFile(
      provenancePath(sessionDir),
      canonicalLine({ kind: PROVENANCE_HEADER_KIND, schemaVersion: PROVENANCE_SCHEMA_VERSION }) + '\n',
      'utf8',
    )
  }
  await appendFile(provenancePath(sessionDir), canonicalLine(entry) + '\n', 'utf8')
  return { entry, cycleCheckedNodes: steps }
}


/**
 * 批量注册（sync 场景）：一次加载、一次环检测、一次追加，避免逐条注册的
 * O(n²) 文件读。语义与逐条 registerProvenanceEdge 等价；任一条成环则整批
 * 拒绝（失败关闭），已写入内容不受影响（本调用尚未追加任何行）。
 */
export async function registerProvenanceEdges({ sessionDir, edges = [] }) {
  if (!Array.isArray(edges) || edges.length === 0) return { registered: 0 }
  const loaded = await loadProvenance(sessionDir)
  assertWritable(loaded, 'provenance 批量注册')
  const folded = foldProvenance(loaded.entries)
  const deduped = new Map()
  for (const edge of edges) {
    const { derivedId, derivedKind, sourceIds } = edge ?? {}
    if (typeof derivedId !== 'string' || derivedId.length === 0) {
      throw new ProvenanceError('derivedId 非法', { code: 'EINVAL' })
    }
    if (!Array.isArray(sourceIds) || sourceIds.some((id) => typeof id !== 'string')) {
      throw new ProvenanceError('sourceIds 非法', { code: 'EINVAL' })
    }
    deduped.set(derivedId, { derivedId, derivedKind: String(derivedKind ?? ''), sourceIds: [...new Set(sourceIds)].sort() })
  }
  // 合并既有边后做一次全局环检测：以全部待注册来源为起点跑祖先 BFS。
  const ancestors = new Set()
  const queue = []
  for (const edge of deduped.values()) queue.push(...edge.sourceIds)
  let steps = 0
  while (queue.length > 0 && steps < PROVENANCE_BFS_MAX_NODES) {
    const current = queue.shift()
    if (ancestors.has(current)) continue
    ancestors.add(current)
    const existing = folded.edges.get(current)
    if (existing) for (const source of existing.sourceIds) if (!ancestors.has(source)) queue.push(source)
    for (const edge of deduped.values()) {
      if (edge.derivedId === current) for (const source of edge.sourceIds) if (!ancestors.has(source)) queue.push(source)
    }
    steps += 1
  }
  for (const edge of deduped.values()) {
    if (ancestors.has(edge.derivedId)) {
      throw new ProvenanceError(
        '批量注册 ' + edge.derivedId + ' ← [' + edge.sourceIds.join(', ') + '] 会形成派生环',
        { code: 'ECYCLE' },
      )
    }
  }
  const lines = []
  let hasFile = false
  try {
    await readFile(provenancePath(sessionDir), 'utf8')
    hasFile = true
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  if (!hasFile) {
    lines.push(canonicalLine({ kind: PROVENANCE_HEADER_KIND, schemaVersion: PROVENANCE_SCHEMA_VERSION }))
  }
  const registeredAt = new Date().toISOString()
  for (const edge of deduped.values()) {
    lines.push(canonicalLine({
      kind: PROVENANCE_EDGE,
      derivedId: edge.derivedId,
      derivedKind: edge.derivedKind,
      sourceIds: edge.sourceIds,
      registeredAt,
    }))
  }
  if (lines.length > 0) {
    await mkdir(sessionDir, { recursive: true })
    await appendFile(provenancePath(sessionDir), lines.map((line) => line + '\n').join(''), 'utf8')
  }
  return { registered: deduped.size, cycleCheckedNodes: steps }
}

/** 追加失效标记（cause = forget 操作 id 或显式原因）。幂等：同 derived+cause 只记一条生效。 */
export async function invalidateProvenance({ sessionDir, derivedId, cause }) {
  const loaded = await loadProvenance(sessionDir)
  assertWritable(loaded, 'provenance 失效')
  const folded = foldProvenance(loaded.entries)
  const existing = folded.invalidated.get(derivedId) ?? []
  if (existing.includes(cause)) return { appended: false, derivedId, cause }
  const entry = {
    kind: PROVENANCE_INVALIDATION,
    derivedId,
    cause: String(cause ?? ''),
    at: new Date().toISOString(),
  }
  await appendFile(provenancePath(sessionDir), canonicalLine(entry) + '\n', 'utf8')
  return { appended: true, derivedId, cause }
}

/**
 * 有界失效 BFS：给定一批「已失效来源 id」，沿边向下找全部受影响派生物。
 * 返回按拓扑层展开的层列表 + 截断标记（超节点/深度上限时 truncated: true，
 * 如实报告，不静默假装完整）。
 */
export function propagateInvalidations(seedSourceIds, folded, { maxNodes = PROVENANCE_BFS_MAX_NODES, maxDepth = PROVENANCE_BFS_MAX_DEPTH } = {}) {
  const seeds = new Set(seedSourceIds)
  const visited = new Set()
  const layers = []
  let frontier = [...seeds]
  let depth = 0
  let truncated = false
  // 反向索引：source → [derived...]
  const bySource = new Map()
  for (const [derivedId, edge] of folded.edges) {
    for (const source of edge.sourceIds) {
      if (!bySource.has(source)) bySource.set(source, [])
      bySource.get(source).push(derivedId)
    }
  }
  while (frontier.length > 0 && depth < maxDepth) {
    const next = []
    for (const sourceId of frontier) {
      for (const derivedId of bySource.get(sourceId) ?? []) {
        if (visited.has(derivedId) || seeds.has(derivedId)) continue
        visited.add(derivedId)
        next.push(derivedId)
      }
    }
    if (next.length === 0) break
    layers.push({ depth: depth + 1, derivedIds: [...next].sort() })
    frontier = next
    depth += 1
    if (visited.size > maxNodes) {
      truncated = true
      break
    }
  }
  if (frontier.length > 0 && depth >= maxDepth) truncated = true
  return { affected: [...visited].sort(), layers, truncated, maxNodes, maxDepth }
}
