/**
 * 显式 T2 回填（application，0.14.0-beta.38）——纯计划/执行逻辑，零 I/O。
 *
 * 设计取舍（用户口径：显式、分批、可中断、幂等）：
 * - **显式**：只在 `/memory-lab t2 backfill` 时跑，不在 pre-step 里自动追历史；
 * - **分批**：按 chunk 入 provider 的串行镜像队列并 flush，进度落在状态文件里；
 * - **可中断**：chunk 之间检查 signal.aborted（命令面 `t2 backfill cancel` 置位）；
 * - **幂等**：判据是隔离根里**真实存在的 v3r-* 节点**（调用方先 scanMirroredNodes），
 *   已镜像的记录不再入队；即使重复写同一 ID，dsh-memory 也按 node_id 覆盖而非新建。
 *   因此不依赖内存游标，进程重启后也不会重复写。
 *
 * 分母口径与镜像写入口径必须一致：只回填 payload.text 非空且未遗忘的记录
 * （metadata-only / 空正文不产生检索价值，只会浪费一次进程往返）。
 */

/** 默认回填条数（用户口径）。 */
export const T2_BACKFILL_DEFAULT_LIMIT = 200
/** 单次回填硬上限：不允许一次把 5000 条历史全推给隔离根。 */
export const T2_BACKFILL_MAX_LIMIT = 2000
/** 每批入队条数：批间 flush 让进度可读，也给出中断点。 */
export const T2_BACKFILL_CHUNK = 25

/**
 * 解析 `t2 backfill [limit]` 的参数。
 * 只认 /^\d+$/（与命令面数字参数同一把尺子）；越界/非整数一律回用法错误，
 * **不静默夹值**——夹值会让调用方以为自己的数字生效了。
 *
 * @param {string|number|undefined|null} raw
 * @returns {{ok:true, limit:number} | {ok:false, message:string}}
 */
export function parseBackfillLimit(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return { ok: true, limit: T2_BACKFILL_DEFAULT_LIMIT }
  }
  const text = String(raw).trim()
  if (!/^\d+$/.test(text)) {
    return { ok: false, message: '用法：/memory-lab t2 backfill [1–' + T2_BACKFILL_MAX_LIMIT + ']（默认 ' + T2_BACKFILL_DEFAULT_LIMIT + '），得到 ' + JSON.stringify(text) }
  }
  const limit = Number(text)
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > T2_BACKFILL_MAX_LIMIT) {
    return { ok: false, message: '回填条数必须在 1–' + T2_BACKFILL_MAX_LIMIT + ' 之间（默认 ' + T2_BACKFILL_DEFAULT_LIMIT + '），得到 ' + limit }
  }
  return { ok: true, limit }
}

/**
 * 计划本批要镜像的记录：跳过已镜像（按 ID）、metadata-only / 空正文（双保险），
 * 按 ID 稳定排序后截到 limit。
 *
 * @param {object} deps
 * @param {object[]} deps.records 已确认可镜像的记录
 * @param {Set<string>|string[]} deps.mirroredIds 隔离根里已存在的节点 ID
 * @param {number} deps.limit
 * @returns {{pending:object[], pendingTotal:number, alreadyMirrored:number}}
 */
export function planBackfill({ records, mirroredIds, limit }) {
  const done = mirroredIds instanceof Set ? mirroredIds : new Set(mirroredIds ?? [])
  const pending = []
  let alreadyMirrored = 0
  for (const record of records ?? []) {
    if (record === null || typeof record !== 'object') continue
    if (typeof record.id !== 'string' || record.id.length === 0) continue
    if (typeof record.payload?.text !== 'string' || record.payload.text.length === 0) continue
    if (done.has(record.id)) {
      alreadyMirrored += 1
      continue
    }
    pending.push(record)
  }
  pending.sort((a, b) => String(a.id).localeCompare(String(b.id)))
  return {
    pending: pending.slice(0, Math.max(0, Number.isFinite(limit) ? limit : 0)),
    pendingTotal: pending.length,
    alreadyMirrored,
  }
}

function statsOf(provider) {
  const raw = typeof provider?.mirrorStats === 'function' ? provider.mirrorStats() : null
  return {
    mirrored: Number.isFinite(raw?.mirrored) ? raw.mirrored : 0,
    failed: Number.isFinite(raw?.mirrorFailed) ? raw.mirrorFailed : 0,
    dropped: Number.isFinite(raw?.mirrorDropped) ? raw.mirrorDropped : 0,
  }
}

/**
 * 执行回填：分批入队 + flush，失败只计数不中断。
 *
 * 返回的 mirrored/failed 是 provider 计数器的**本批增量**；调用方在收尾时会用隔离根
 * 的实际节点做一次对账（磁盘是幂等判据，计数器只用于进度）。
 *
 * @param {object} deps
 * @param {object} deps.provider T2 provider（需 mirrorRecord；flush 可选）
 * @param {object[]} deps.records 本批记录（已按计划截断）
 * @param {{aborted:boolean}} [deps.signal]
 * @param {number} [deps.chunkSize]
 * @param {(progress:object)=>Promise<void>|void} [deps.onProgress]
 * @returns {Promise<{status:'done'|'cancelled', processed:number, total:number, mirrored:number, failed:number, dropped:number}>}
 */
export async function runBackfill({ provider, records, signal, chunkSize = T2_BACKFILL_CHUNK, onProgress } = {}) {
  if (provider === null || typeof provider !== 'object' || typeof provider.mirrorRecord !== 'function') {
    throw new TypeError('v3 t2-backfill: 需要提供 mirrorRecord 的 T2 provider')
  }
  const list = Array.isArray(records) ? records : []
  const before = statsOf(provider)
  let processed = 0
  for (let offset = 0; offset < list.length; offset += chunkSize) {
    if (signal?.aborted === true) {
      const stats = statsOf(provider)
      return {
        status: 'cancelled',
        processed,
        total: list.length,
        mirrored: stats.mirrored - before.mirrored,
        failed: stats.failed - before.failed,
        dropped: stats.dropped - before.dropped,
      }
    }
    const chunk = list.slice(offset, offset + chunkSize)
    for (const record of chunk) provider.mirrorRecord(record)
    if (typeof provider.flush === 'function') await provider.flush()
    processed += chunk.length
    const stats = statsOf(provider)
    if (typeof onProgress === 'function') {
      await onProgress({
        processed,
        total: list.length,
        mirrored: stats.mirrored - before.mirrored,
        failed: stats.failed - before.failed,
        dropped: stats.dropped - before.dropped,
      })
    }
  }
  const stats = statsOf(provider)
  return {
    status: 'done',
    processed,
    total: list.length,
    mirrored: stats.mirrored - before.mirrored,
    failed: stats.failed - before.failed,
    dropped: stats.dropped - before.dropped,
  }
}
