/**
 * 摘要对象存储（adapters/storage，0.15.0 P4）。
 *
 * 形状：<会话目录>/summaries.jsonl，**append-only**；每一行是一个不可变的
 * SummaryArtifact。更新语义 = 追加新对象 + supersedes，旧行字节永不动。
 *
 * 纪律：
 * - 追加进跨进程写锁（与 store 同一锁域），并在**锁内**执行调用方给的 guard
 *   （来源可读/遗忘代际/sessionKey 绑定）——锁外检查等于没检查；
 * - 幂等：同 summaryId 不重复追加；同 idempotencyKey 同载荷返回既有对象，
 *   不同载荷明确冲突（不静默覆盖、不静默新建第二份）；
 * - 损坏（中段/完整行不可解析）返回结构化失败，读面按「不可用」处理，
 *   不把损坏说成「没有摘要」。
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { canonicalSummaryMaterial } from '../../domain/compress/summary-artifact.mjs'
import { withCrossProcessWriteLock } from './write-lock.mjs'

export const SUMMARIES_LOG = 'summaries.jsonl'
const REPAIR_LOG = 'repair-log.jsonl'

/** 会话目录下的摘要日志路径。 */
export function summariesPath(directory) {
  return join(directory, SUMMARIES_LOG)
}

/**
 * 读全部摘要行。
 * @returns {Promise<{ok:true,rows:object[]}|{ok:false,reason:string,line:number|null}>}
 */
export async function listSummaries(directory) {
  let text
  try {
    text = await readFile(summariesPath(directory), 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: true, rows: [] }
    return { ok: false, reason: error?.code ?? String(error), line: null }
  }
  const rows = []
  const rawLines = text.split('\n')
  for (let index = 0; index < rawLines.length; index += 1) {
    const raw = rawLines[index]
    if (raw.length === 0) continue
    try {
      rows.push(JSON.parse(raw))
    } catch {
      return { ok: false, reason: 'summaries.jsonl 第 ' + (index + 1) + ' 行不可解析', line: index + 1 }
    }
  }
  return { ok: true, rows }
}

/** 追加一行（JSONL，fsync；锁内完成）。 */
async function appendSummaryLine(directory, artifact) {
  const { open } = await import('node:fs/promises')
  const handle = await open(summariesPath(directory), 'a')
  try {
    await handle.write(JSON.stringify(artifact) + '\n')
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/**
 * 追加摘要（不可变）。
 *
 * @param {string} directory 会话目录
 * @param {object} artifact 已校验的 SummaryArtifact
 * @param {object} [options]
 * @param {(context:{existing:object[]}) => Promise<{ok:boolean,reason?:string}>} [options.guard]
 *   **锁内**复核（来源仍可读、遗忘代际、会话绑定）。返回 ok=false 时拒绝追加。
 * @returns {Promise<{appended:true,artifact:object}|{appended:false,existing:object}
 *   |{ok:false,reason:'idempotency-conflict'|'damaged'|string,error?:Error}>}
 */
export async function appendSummary(directory, artifact, { guard } = {}) {
  if (artifact === null || typeof artifact !== 'object' || typeof artifact.summaryId !== 'string') {
    return { ok: false, reason: 'invalid-artifact' }
  }
  return withCrossProcessWriteLock(directory, async (ownership) => {
    const listed = await listSummaries(directory)
    if (!listed.ok) {
      const error = new Error(listed.reason)
      error.code = 'ESUMMARIES_DAMAGED'
      return { ok: false, reason: 'damaged', error }
    }
    const existing = listed.rows.find((row) => row?.summaryId === artifact.summaryId)
    if (existing !== undefined) {
      // 同 ID 二次追加：只有当载荷逐字段相同才算幂等；否则是身份撞车，失败关闭。
      if (canonicalSummaryMaterial(existing) !== canonicalSummaryMaterial(artifact)) {
        return { ok: false, reason: 'idempotency-conflict' }
      }
      return { appended: false, existing }
    }
    if (typeof artifact.idempotencyKey === 'string' && artifact.idempotencyKey.length > 0) {
      const same = listed.rows.find((row) => row?.idempotencyKey === artifact.idempotencyKey)
      if (same !== undefined) {
        if (canonicalSummaryMaterial(same) === canonicalSummaryMaterial(artifact)) return { appended: false, existing: same }
        return { ok: false, reason: 'idempotency-conflict' }
      }
    }
    if (typeof guard === 'function') {
      const verdict = await guard({ existing: listed.rows })
      if (verdict?.ok !== true) return { ok: false, reason: verdict?.reason ?? 'guard-rejected' }
    }
    ownership.assertOwned()
    await appendSummaryLine(directory, artifact)
    return { appended: true, artifact }
  })
}


/**
 * H4 物理清除：删除**来源含指定记录**的摘要工件（只用于 purge，不用于普通遗忘）。
 *
 * 常规遗忘保留摘要行、靠可见性现场隐藏（append-only 合同）；purge 是用户要求的
 * 不可恢复删除，派生物不得留着来源正文的转述。重写走临时文件 + rename（原子），
 * 锁内执行，且只删匹配行——不重建、不改其它行字节。
 *
 * @returns {Promise<{ok:true, removed:number, kept:number}|{ok:false, reason:string}>}
 */
export async function purgeSummariesForRecords(directory, recordIds) {
  if (!Array.isArray(recordIds) || recordIds.length === 0) return { ok: true, removed: 0, kept: 0 }
  const targets = new Set(recordIds.filter((id) => typeof id === 'string'))
  return withCrossProcessWriteLock(directory, async (ownership) => {
    const listed = await listSummaries(directory)
    if (listed.ok !== true) return { ok: false, reason: listed.reason }
    const keep = []
    let removed = 0
    for (const artifact of listed.rows) {
      const sources = Array.isArray(artifact?.sources) ? artifact.sources : []
      if (sources.some((source) => targets.has(source?.recordId))) { removed += 1; continue }
      keep.push(artifact)
    }
    if (removed === 0) return { ok: true, removed: 0, kept: keep.length }
    ownership.assertOwned()
    const { rename, writeFile } = await import('node:fs/promises')
    const temporary = summariesPath(directory) + '.purge-' + process.pid + '-' + Date.now()
    await writeFile(temporary, keep.map((row) => JSON.stringify(row)).join('\n') + (keep.length > 0 ? '\n' : ''), 'utf8')
    await rename(temporary, summariesPath(directory))
    return { ok: true, removed, kept: keep.length }
  })
}

/**
 * H4 物理清除：把 repair-log 里历史遗留的 `removedPreview`（尾部半行原文）抹掉。
 * 新写入已不再含原文；这里只清理旧行，保留审计的其它字段。
 */
export async function scrubRepairLogPreviews(directory) {
  const file = join(directory, REPAIR_LOG)
  let text
  try { text = await readFile(file, 'utf8') } catch (error) {
    if (error?.code === 'ENOENT') return { ok: true, changed: 0 }
    return { ok: false, reason: error?.code ?? String(error) }
  }
  const rows = text.split('\n').filter((line) => line.trim().length > 0)
  let changed = 0
  const next = rows.map((line) => {
    let row
    try { row = JSON.parse(line) } catch { return line }
    if (row === null || typeof row !== 'object' || !('removedPreview' in row)) return line
    const { removedPreview, ...rest } = row
    void removedPreview
    changed += 1
    return JSON.stringify({ ...rest, removedPreviewScrubbed: true })
  })
  if (changed === 0) return { ok: true, changed: 0 }
  return withCrossProcessWriteLock(directory, async (ownership) => {
    ownership.assertOwned()
    const { rename, writeFile } = await import('node:fs/promises')
    const temporary = file + '.scrub-' + process.pid + '-' + Date.now()
    await writeFile(temporary, next.join('\n') + (next.length > 0 ? '\n' : ''), 'utf8')
    await rename(temporary, file)
    return { ok: true, changed }
  })
}