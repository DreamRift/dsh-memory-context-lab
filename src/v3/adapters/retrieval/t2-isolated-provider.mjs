/**
 * T2 隔离记忆提供者（adapters/retrieval，0.14.0-beta.35）。
 *
 * 形态：**T1 本地词法索引 + 隔离灵枢** 的复合 provider。
 * - `search`：T1 结果 + 隔离根 `cg(read, query)` 结果融合；外部失败只损失外部，
 *   T1 永远照常返回（不因 T2 挂掉而回注全灭）；
 * - `read`：本地记录以本地为准（含遗忘/会话归属错误一律原样抛出，绝不从镜像复活）；
 *   本地不存在时才按 ID 读隔离根；
 * - `mirrorRecord`：把已提交记录镜像到隔离根（同 ID、带 CCG 六要素），
 *   串行后台队列，失败只计数不回滚本地；
 * - `forgetRecords`：本地遗忘后同步遗忘镜像（尽力而为，失败可见）。
 *
 * 隔离不变量：镜像只写 `MDCG_ROOT=<会话>/t2-mdcg`，不写正式灵枢根。
 */
import { assertPort } from '../../ports/index.mjs'
import { T2_MIRROR_NODE_RE, T2_SMOKE_NODE_ID, v3Error, V3ContractViolation } from '../../contracts/index.mjs'

/** 镜像节点 ID 与本地记录 ID 同形；recall 的精确 ID 判据可直接识别（契约单一真源）。 */
const RECORD_ID_RE = T2_MIRROR_NODE_RE

/** 队列上限：回填时镜像落后于摄入，但不能无界吃内存。 */
export const T2_MIRROR_QUEUE_LIMIT = 5000

/** 单次外部检索最多接受的条数（防止远端返回超长列表撑爆回注预算）。 */
const T2_EXTERNAL_LIMIT = 50

function numberOf(value, fallback) {
  return Number.isFinite(value) ? value : fallback
}

/**
 * 融合本地/外部命中。
 *
 * 分数尺度问题：本地是 BM25（量纲大），隔离根是 RRF（0–1）。直接相加会让外部
 * 命中永远排在本地之后且无法过装包阈。这里按**各自第一名归一化**到 0–1，
 * 保持「同一来源内部相对次序」不变，同时让外部命中真正参与装包。
 * 归一化只发生在 T2 复合 provider 内，T1 单独使用时尺度不变。
 *
 * @param {object} local T1 search 结果
 * @param {Array<{id:string, score:number}>} external 外部命中（已按分数降序）
 * @param {object} opts { limit, packMinScore }
 * @returns {object} 与 T1 同形 + sourceLabel + externalHits
 */
export function mergeHits(local, external, { limit = 10, packMinScore = 0 } = {}) {
  const localDisplay = Array.isArray(local?.display) ? local.display : []
  const localPack = Array.isArray(local?.pack) ? local.pack : []
  const maxLocal = Math.max(0, ...localDisplay.map((hit) => numberOf(hit?.score, 0)))
  const byId = new Map()
  for (const hit of localDisplay) {
    if (typeof hit?.id !== 'string' || hit.id.length === 0) continue
    byId.set(hit.id, {
      ...hit,
      score: maxLocal > 0 ? numberOf(hit.score, 0) / maxLocal : 0,
      rawScore: numberOf(hit.score, 0),
      source: 'local',
    })
  }
  const packIds = new Set(localPack.map((hit) => hit?.id).filter((id) => typeof id === 'string'))
  let externalHits = 0
  for (let index = 0; index < external.length; index += 1) {
    const hit = external[index]
    if (typeof hit?.id !== 'string' || !RECORD_ID_RE.test(hit.id)) continue
    externalHits += 1
    if (byId.has(hit.id)) {
      // 两路都命中：本地有正文与精确分，保留本地分，仅标记交叉命中（不重复计分）。
      const existing = byId.get(hit.id)
      byId.set(hit.id, { ...existing, alsoExternal: true })
      continue
    }
    // 外部独有：按名次给分，第 1 名 = 1.0，末名 > 0；这只是融合用的相对量，不是 BM25。
    const score = Math.max(0.01, 1 - index / Math.max(1, external.length))
    byId.set(hit.id, { id: hit.id, score, external: true, source: 't2' })
  }
  const merged = [...byId.values()]
    .sort((a, b) => (b.score - a.score) || String(a.id).localeCompare(String(b.id)))
    .slice(0, Math.max(0, limit))
  const pack = merged.filter((hit) => hit.score >= packMinScore || packIds.has(hit.id))
  return {
    ...local,
    display: merged,
    pack,
    sourceLabel: externalHits > 0 ? '本地词法索引 + 隔离灵枢（T2）' : '本地词法索引（T2 无新增命中）',
    externalHits,
  }
}

/** 镜像正文：六要素各占一行，保住 dsh-memory 的 text 写入闸。 */
export function mirrorContentOf(record) {
  const text = typeof record?.payload?.text === 'string' ? record.payload.text : ''
  const session = typeof record?.sessionKey === 'string' ? record.sessionKey : 'unknown'
  const kind = typeof record?.kind === 'string' ? record.kind : 'unknown'
  const source = typeof record?.provenance?.sourceEventId === 'string' ? record.provenance.sourceEventId : 'unknown'
  return [
    '# 功能名：v3 会话记录镜像 ' + String(record?.id ?? ''),
    '# 生效条件：会话 ' + session + ' 的 ' + kind + ' 记录（来源事件 ' + source + '）已提交到 v3 本地库',
    '# 子功能：原文镜像；可按 ID 精确回读；供隔离灵枢检索补充',
    '# 执行：' + text,
    '# 验证方式：镜像源 ' + String(record?.id ?? '') + '；本地 v3 记录为权威，镜像只作检索副本',
    '# 不适用条件：不是正式灵枢知识；仅隔离 MDCG_ROOT；不作为事实来源，删除以本地为准',
  ].join('\n')
}

/**
 * 创建 T2 隔离提供者。
 *
 * @param {object} deps
 * @param {object} deps.t1 T1 provider（必须）
 * @param {object} deps.client 已握手的 MCP 客户端（probe 交回）
 * @param {string} deps.sessionKey 会话隔离键（镜像归因）
 * @param {object} [deps.metrics]
 * @param {string} [deps.root] 诊断用隔离根
 */
export function createT2IsolatedProvider({ t1, client, sessionKey, metrics, root = '' } = {}) {
  assertPort('MemoryProvider', t1)
  if (client === null || typeof client !== 'object' || typeof client.callTool !== 'function') {
    throw new V3ContractViolation('v3 t2-provider: 需要已握手的 MCP client')
  }
  if (typeof sessionKey !== 'string' || sessionKey.length === 0) {
    throw new V3ContractViolation('v3 t2-provider: sessionKey 必须是非空字符串')
  }

  const queue = []
  let draining = false
  let closed = false
  let drainPromise = null
  let mirrored = 0
  let mirrorFailed = 0
  let mirrorDropped = 0
  let forgetFailed = 0
  let lastError = null
  // 已遗忘 ID：本地遗忘先于镜像队列落定时，晚到的写不得把正文重新写回隔离根。
  const forgottenIds = new Set()

  function noteFailure(prefix, error) {
    lastError = prefix + ': ' + (error instanceof Error ? error.message : String(error))
    metrics?.counter?.('v3.t2.' + prefix, 1)
  }

  async function drain() {
    if (draining) return
    draining = true
    drainPromise = (async () => {
      while (queue.length > 0) {
        const record = queue.shift()
        if (forgottenIds.has(record.id)) {
          // 本地已遗忘：即使写请求还在队列里也不得落到隔离根。
          mirrorDropped += 1
          metrics?.counter?.('v3.t2.mirrorSkippedForgotten', 1)
          continue
        }
        try {
          await client.callTool('cg', {
            op: 'write',
            node_id: record.id,
            content: mirrorContentOf(record),
            content_kind: 'text',
            session: sessionKey,
            tags: ['mcl-v3', 'mcl-session-' + String(sessionKey).slice(0, 16)],
            importance: 0.2,
            consistency: false,
          }, { timeoutMs: 10000 })
          mirrored += 1
          metrics?.counter?.('v3.t2.mirrorOk', 1)
        } catch (error) {
          mirrorFailed += 1
          noteFailure('mirrorFailed', error)
        }
      }
    })().finally(() => {
      draining = false
      drainPromise = null
    })
    await drainPromise
  }

  /** 入队镜像；同步返回，不阻塞摄入。`undo:true` 用于撤销遗忘后的重建。 */
  function mirrorRecord(record, { undo = false } = {}) {
    if (closed) return
    if (record === null || typeof record !== 'object' || typeof record.id !== 'string' || !RECORD_ID_RE.test(record.id)) {
      mirrorDropped += 1
      metrics?.counter?.('v3.t2.mirrorSkipped', 1)
      return
    }
    if (forgottenIds.has(record.id)) {
      if (undo !== true) {
        mirrorDropped += 1
        metrics?.counter?.('v3.t2.mirrorSkippedForgotten', 1)
        return
      }
      forgottenIds.delete(record.id)
    }
    // metadata-only 记录没有正文：镜像一个空壳没有检索价值，只浪费一次进程往返。
    if (typeof record?.payload?.text !== 'string' || record.payload.text.length === 0) {
      mirrorDropped += 1
      metrics?.counter?.('v3.t2.mirrorSkipped', 1)
      return
    }
    if (queue.length >= T2_MIRROR_QUEUE_LIMIT) {
      mirrorDropped += 1
      noteFailure('mirrorDropped', new Error('镜像队列已满（' + T2_MIRROR_QUEUE_LIMIT + '），本批只记本地'))
      return
    }
    queue.push(record)
    // 延后一个微任务再 drain：同一同步批里紧接着的 forget 可以先标记，
    // 避免「刚入队就遗忘」时先写后删的白跑一次。
    queueMicrotask(() => { void drain() })
  }

  async function externalSearch(query, { limit, allowRebuild }) {
    try {
      const result = await client.callTool('cg', {
        op: 'read',
        query,
        session: sessionKey,
        limit: Math.min(T2_EXTERNAL_LIMIT, Math.max(1, limit)),
      }, { timeoutMs: 10000 })
      const rows = Array.isArray(result?.results) ? result.results : []
      const hits = []
      for (const row of rows) {
        const id = row?.node?.id ?? row?.id
        const score = numberOf(row?.score, 0)
        if (typeof id === 'string' && RECORD_ID_RE.test(id)) hits.push({ id, score })
      }
      return hits.sort((a, b) => b.score - a.score)
    } catch (error) {
      // 外部失败只损失外部：计数后回空表，T1 结果原样返回。
      noteFailure('searchFailed', error)
      return []
    }
  }

  async function search(query, { limit = 10, resultMinScore = 0, packMinScore = 0, allowRebuild = true } = {}) {
    if (typeof query !== 'string' || query.length === 0) {
      throw new V3ContractViolation('v3 t2-provider: 查询必须是非空字符串')
    }
    const local = await t1.search(query, { limit, resultMinScore, packMinScore, allowRebuild })
    // 索引还没就绪时外部仍可检索；但此时本地为空不能把 T1 的 indexAbsent 标记丢掉。
    const external = await externalSearch(query, { limit, allowRebuild })
    if (external.length === 0) {
      // 外部无新增（或失败）：保持 T1 原分数尺度，不因为装了 T2 就改变本地结果。
      metrics?.counter?.('v3.t2.searchNoExternal', 1)
      return { ...local, sourceLabel: '本地词法索引（T2 无新增命中）', externalHits: 0 }
    }
    const merged = mergeHits(local, external, { limit, packMinScore })
    metrics?.counter?.('v3.t2.search', 1)
    return merged
  }

  async function read(recordId) {
    if (typeof recordId !== 'string' || recordId.length === 0) {
      throw new V3ContractViolation('v3 t2-provider: recordId 必须是非空字符串')
    }
    let localError = null
    try {
      return await t1.read(recordId)
    } catch (error) {
      localError = error
    }
    // 隐私/隔离错误不得被镜像绕过：已遗忘、跨会话、损坏一律原样抛出。
    if (localError?.code === 'EFORGOTTEN' || localError?.code === 'ESTORE_SESSION_MISMATCH') throw localError
    if (localError?.code !== 'ESTORE_CORRUPT' || !String(localError.message).includes('记录不存在')) {
      throw localError
    }
    const result = await client.callTool('cg', { op: 'read', node_id: recordId }, { timeoutMs: 10000 })
    const text = typeof result?.content === 'string' ? result.content : ''
    if (text.length === 0) {
      throw v3Error('ESTORE_CORRUPT', '记录不存在：' + recordId + '（本地与隔离根都没有）')
    }
    const createdAt = Date.parse(result?.frontmatter?.created ?? '')
    return {
      text,
      record: {
        id: recordId,
        sessionKey,
        createdAt: Number.isFinite(createdAt) ? createdAt : 0,
        payload: { text },
        provenance: { sourceForm: 't2-mirror' },
      },
    }
  }

  /** 本地遗忘后同步遗忘镜像；失败只计数（本地隐私面已生效，镜像失败可见）。 */
  async function forgetRecords(recordIds) {
    if (!Array.isArray(recordIds) || recordIds.length === 0) return { forgotten: 0, failed: 0 }
    const ids = recordIds.filter((id) => typeof id === 'string' && RECORD_ID_RE.test(id))
    // 先标记、再等队列排空：晚到的写会被 drain 跳过，不会在 forget 之后把正文写回。
    for (const id of ids) forgottenIds.add(id)
    await flush()
    let forgotten = 0
    let failed = 0
    for (const id of ids) {
      try {
        await client.callTool('cg', { op: 'forget', node_id: id, override: true }, { timeoutMs: 10000 })
        forgotten += 1
      } catch (error) {
        failed += 1
        forgetFailed += 1
        noteFailure('forgetFailed', error)
      }
    }
    return { forgotten, failed }
  }

  /**
   * 索引统计（命令/诊断路径）：直接复用 T1 的索引解析缓存，不在这里再读一遍 22MB JSON。
   * 失败如实回 error/absent——「读不到」不得写成 0（0 会让「可检索」看起来像空库）。
   */
  async function indexStats() {
    if (typeof t1.indexStats !== 'function') return { state: 'unavailable', reason: 'T1 未提供索引统计' }
    return await t1.indexStats()
  }

  /**
   * 清理冒烟节点（P2，2026-10-28）：探测四步写过的 mcl-smoke 可能因清理失败残留在隔离根。
   * 它不属于任何真实会话，也不计入覆盖率；这里显式 forget 一次，失败如实回报。
   */
  async function cleanupSmoke() {
    try {
      await client.callTool('cg', { op: 'forget', node_id: T2_SMOKE_NODE_ID, override: true }, { timeoutMs: 10000 })
      return { ok: true, nodeId: T2_SMOKE_NODE_ID }
    } catch (error) {
      noteFailure('smokeCleanupFailed', error)
      return { ok: false, nodeId: T2_SMOKE_NODE_ID, error: error instanceof Error ? error.message : String(error) }
    }
  }

  async function health() {
    const local = await t1.health()
    return {
      ...local,
      t2: {
        isolated: true,
        root,
        mirrored,
        mirrorFailed,
        mirrorDropped,
        pending: queue.length,
        draining,
        forgetFailed,
        lastError,
      },
    }
  }

  function capabilities() {
    return {
      name: 'local-lexical-v3+t2-isolated',
      tier: 'T2',
      live: true,
      isolated: true,
      root,
      mirrorQueueLimit: T2_MIRROR_QUEUE_LIMIT,
    }
  }

  async function flush(timeoutMs = 5000) {
    if (queue.length === 0 && !draining) return
    await Promise.race([
      (async () => {
        while (draining || queue.length > 0) {
          if (drainPromise !== null) await drainPromise.catch(() => {})
          else if (queue.length > 0) await drain()
          else break
        }
      })(),
      new Promise((resolve) => setTimeout(resolve, timeoutMs)),
    ])
  }

  async function close() {
    if (closed) return
    await flush()
    closed = true
    try { await client.close?.() } catch { /* 关闭失败不改变已 flush 的事实 */ }
  }

  return assertPort('MemoryProvider', {
    search,
    read,
    health,
    indexStats,
    capabilities,
    cleanupSmoke,
    mirrorRecord,
    forgetRecords,
    flush,
    close,
    mirrorStats() {
      return { mirrored, mirrorFailed, mirrorDropped, pending: queue.length, forgetFailed, lastError }
    },
  })
}