/** 导出包落盘（adapters/storage）：路径与原子写只在这里出现。 */
import { chmod, mkdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'

import { writeFileAtomic } from './session-store.mjs'
import { exportFilenameOf } from '../../domain/export/bundle.mjs'

export async function writeExportBundle(v3Root, sessionKey, bundle) {
  if (typeof v3Root !== 'string' || v3Root.length === 0) throw new Error('v3 export-writer: v3Root 必填')
  if (typeof sessionKey !== 'string' || sessionKey.length === 0) throw new Error('v3 export-writer: sessionKey 必填')
  const directory = path.join(v3Root, 'exports')
  await mkdir(directory, { recursive: true })
  const file = path.join(directory, exportFilenameOf(sessionKey, bundle.exportedAt))
  await writeFileAtomic(file, JSON.stringify(bundle, null, 2) + '\n')
  // B3-21（AUD50-07-03）：分享包默认不 world-readable；只收紧导出路径，不改
  // writeFileAtomic 的全局行为。Windows 的 chmod 只作用于只读位（受限 no-op），
  // 语义由 POSIX 断言守卫（v3-export 套件，win32 skip 并注明）。
  await chmod(file, 0o600)
  return file
}

/**
 * M9（2026-11-04 审计）：导入包的硬上限。旧实现只做 basename 白名单，没有体积/条数
 * 校验——一个超大 JSON 可以在 JSON.parse 时吃光内存，或把上万条伪造正文灌进空会话再
 * 被回注给模型（提示注入面）。
 */
export const EXPORT_IMPORT_LIMITS = Object.freeze({ maxBytes: 64 * 1024 * 1024, maxRecords: 5000, maxRecordChars: 1024 * 1024 })

/** 读取本会话数据根 exports/ 下的导出包；只认文件名，不接受路径成分。 */
export async function readExportBundle(v3Root, fileName) {
  if (typeof v3Root !== 'string' || v3Root.length === 0) throw new Error('v3 export-writer: v3Root 必填')
  if (typeof fileName !== 'string' || fileName.length === 0) throw new Error('v3 export-writer: 文件名必填')
  if (path.basename(fileName) !== fileName) throw new Error('v3 export-writer: 只接受 exports/ 下的文件名')
  const file = path.join(v3Root, 'exports', fileName)
  const info = await stat(file)
  if (info.size > EXPORT_IMPORT_LIMITS.maxBytes) throw new Error('导出包过大（' + info.size + ' B > ' + EXPORT_IMPORT_LIMITS.maxBytes + ' B），拒绝导入')
  const text = await readFile(file, 'utf8')
  let bundle
  try { bundle = JSON.parse(text) } catch { throw new Error('导出包不是合法 JSON') }
  if (bundle === null || typeof bundle !== 'object' || !Array.isArray(bundle.records)) {
    throw new Error('导出包缺 records 数组')
  }
  if (bundle.schemaVersion !== 1) throw new Error('导出包版本不支持：' + String(bundle.schemaVersion))
  if (bundle.records.length > EXPORT_IMPORT_LIMITS.maxRecords) throw new Error('导出包记录过多（' + bundle.records.length + ' > ' + EXPORT_IMPORT_LIMITS.maxRecords + '），拒绝导入')
  for (const record of bundle.records) {
    const text = record?.payload?.text
    if (text === undefined) continue // 结构性校验交给 store.importRecords（会整包拒绝）
    if (typeof text !== 'string') throw new Error('导出包记录 payload.text 必须是字符串')
    if (text.length > EXPORT_IMPORT_LIMITS.maxRecordChars) throw new Error('导出包单条正文过大（' + text.length + ' 字符），拒绝导入')
  }
  return bundle
}