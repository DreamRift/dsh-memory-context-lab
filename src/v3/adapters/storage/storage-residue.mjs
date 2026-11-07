/**
 * 存储残留统计与清理（adapters/storage，0.15.4 问题 8）。
 *
 * ## 缺陷
 *
 * 插件会替用户长期保管两类「不再有用、但不会被自动清掉」的东西：
 *
 * - `v3/sessions/<key>/quarantine/`——打开期发现的非记录残留（半截 JSON 等）。
 *   设计上「只进不出，人工审计」，但**没有任何出口**告诉用户它有多大、怎么清。
 * - `v3/exports/`——本地导出包（含已归档正文、凭证正文首部），**无 TTL**。
 *
 * 用户拍板 **A + D**：给命令出口（能清）+ `status` 如实报告（知道有多少）。
 * **不做 TTL 自动删**——自动删正文与「可恢复」的承诺相冲。
 *
 * ## 为什么统计要单独成一个模块
 *
 * 「有多少残留」必须**同源**于清理判据（计划 §10：期望值与实测值同源采集）。
 * 如果 status 用一套 glob、清理用另一套，就会出现「报告 3 个、清了 5 个」这种
 * 自相矛盾的账。所以 `scanResidue` 与 `cleanResidue` 共用同一个 `collectResidue`。
 *
 * ## 边界
 *
 * - **只删这两处**，绝不碰 `records/` / 账本 / 索引。
 * - 只删**普通文件**；符号链接、目录、reparse point 一律跳过（防越界删除）。
 * - 清理失败逐条如实上报，不假装成功。
 * - 不自动执行：`cleanResidue` 只有命令面会调。
 */
import { readdir, rm, lstat } from 'node:fs/promises'
import path from 'node:path'

/** quarantine 与 exports 的相对位置（唯一真源）。 */
const RESIDUE_KINDS = Object.freeze([
  { kind: 'quarantine', at: (v3Root, sessionKey) => path.join(v3Root, 'sessions', String(sessionKey), 'quarantine') },
  { kind: 'exports', at: (v3Root) => path.join(v3Root, 'exports') },
])

/** 递归收集某目录下的普通文件（不跟随符号链接）。 */
async function collectFiles(directory, out, depth = 0) {
  if (depth > 8) return // 防病态深树；残留不可能这么深
  let names
  try {
    names = await readdir(directory)
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }
  for (const name of names) {
    const full = path.join(directory, name)
    let info
    try {
      info = await lstat(full)
    } catch {
      continue // 竞态消失：不计入（不猜）
    }
    if (info.isSymbolicLink()) continue // 不跟随、不删符号链接（越界面）
    if (info.isDirectory()) {
      await collectFiles(full, out, depth + 1)
      continue
    }
    if (!info.isFile()) continue // reparse point / 设备等一律跳过
    out.push({ path: full, bytes: info.size })
  }
}

/**
 * 统计残留。**只读**，可在 `status` 里随便调。
 *
 * @returns {Promise<{items: Array<{kind: string, path: string, bytes: number}>,
 *   byKind: Record<string, {files: number, bytes: number}>, totalBytes: number,
 *   errors: Array<{kind: string, code: string}>}>}
 */
export async function scanResidue(v3Root, sessionKey) {
  if (typeof v3Root !== 'string' || v3Root.length === 0) throw new Error('v3 storage-residue: v3Root 必填')
  const items = []
  const byKind = {}
  const errors = []
  for (const spec of RESIDUE_KINDS) {
    // exports 是**全局**的（不分会话），quarantine 是每会话的
    const directory = spec.kind === 'exports' ? spec.at(v3Root) : spec.at(v3Root, sessionKey)
    const own = []
    try {
      await collectFiles(directory, own)
    } catch (error) {
      errors.push({ kind: spec.kind, code: error?.code ?? 'EINTERNAL' })
      continue
    }
    for (const file of own) items.push({ kind: spec.kind, ...file })
    byKind[spec.kind] = {
      files: own.length,
      bytes: own.reduce((sum, file) => sum + file.bytes, 0),
    }
  }
  return {
    items,
    byKind,
    totalBytes: items.reduce((sum, file) => sum + file.bytes, 0),
    errors,
  }
}

/**
 * 清理残留。**有副作用**，只由命令面调用。
 *
 * 判据与 `scanResidue` 同源（同一个 `collectResidue` 路径）：先扫再删，
 * 不按通配符 `rm -rf` 整目录——避免把用户自己放进 exports/ 的东西一起删掉。
 *
 * @param {object} options `{ kinds?: string[], dryRun?: boolean }`
 * @returns {Promise<{removed: number, bytes: number, failed: Array<{path, code}>}>}
 */
export async function cleanResidue(v3Root, sessionKey, options = {}) {
  const wanted = Array.isArray(options.kinds) && options.kinds.length > 0
    ? new Set(options.kinds)
    : null
  const scan = await scanResidue(v3Root, sessionKey)
  const targets = scan.items.filter((file) => wanted === null || wanted.has(file.kind))
  let removed = 0
  let bytes = 0
  const failed = []
  for (const file of targets) {
    if (options.dryRun === true) {
      removed += 1
      bytes += file.bytes
      continue
    }
    try {
      await rm(file.path, { force: false })
      removed += 1
      bytes += file.bytes
    } catch (error) {
      failed.push({ path: file.path, code: error?.code ?? 'EINTERNAL' })
    }
  }
  return { removed, bytes, failed }
}

/** 人话体积（status 用；单位与面板同口径）。 */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '未知'
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}
