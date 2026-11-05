/**
 * 文件戳（adapters/storage，0.15.0 P5 抽出；P3-01 收敛为唯一实现）。
 *
 * 两个用途共用同一判据：
 * 1. 派生索引（词法索引 / chunk 索引）判「磁盘上的派生物是不是我上次解析的那份」；
 * 2. 会话状态面（`state.json` / `control.json` / 事务与隐私账本）判「别的句柄/进程
 *    有没有改过这个文件」。
 *
 * 判据 = `mtimeNs + size + 头 64 字节 sha1`。为什么不能只比 `mtimeMs + size`（P3-01）：
 * - Windows 内核计时粒度 1–15ms，同一粒度内的**同大小**替换判等 → 替换不可见；
 * - 与会话状态缓存同源的隐私面（forgotten/purged/redactions 账本）一旦漏看一次替换，
 *   就是「已遗忘记录重新可见」这种失败开放的方向；
 * - 历史上这里同时存在两套判据（本文件 + `session-store.mjs` 的私有副本），
 *   `session-state/control` 又是第三套毫秒戳——三套判据必然漂移。
 *
 * 读路径（pre-step 热路径）要同步能力，故提供 `fileStampOfSync`；两者共用
 * `stampOfStat` 与 `STAMP_HEAD_BYTES`，格式与残缺语义完全一致。
 */
import { createHash } from 'node:crypto'
import { open, stat } from 'node:fs/promises'
import { closeSync, openSync, readSync, statSync } from 'node:fs'

/** 头部摘要读取的字节数（覆盖索引 JSON 的首部计数字段）。 */
export const STAMP_HEAD_BYTES = 64

/** 文件不存在时的稳定哨兵（与「读失败」区分：读失败一律抛错，不伪装成 changed）。 */
export const STAMP_ABSENT = 'absent'

/** 戳的格式版本前缀：跨版本比对时旧戳（无前缀）必然判异，不必依赖字段宽度巧合。 */
const STAMP_VERSION = 'v2'

function digestOf(buffer, bytesRead) {
  return createHash('sha1').update(buffer.subarray(0, bytesRead)).digest('hex').slice(0, 8)
}

/** 单一戳格式（同步/异步共用，避免两处各写一遍字符串拼接）。 */
function stampOfStat(info, head) {
  return STAMP_VERSION + ':' + info.mtimeNs.toString() + ':' + info.size.toString() + ':' + head
}

/**
 * @param {string} filePath 被戳的文件
 * @returns {Promise<string>} 不存在返回 {@link STAMP_ABSENT}（与读失败区分）
 */
export async function fileStampOf(filePath) {
  try {
    const info = await stat(filePath, { bigint: true })
    const handle = await open(filePath, 'r')
    let head = ''
    try {
      const buffer = Buffer.alloc(STAMP_HEAD_BYTES)
      const read = await handle.read(buffer, 0, STAMP_HEAD_BYTES, 0)
      head = digestOf(buffer, read.bytesRead)
    } finally {
      await handle.close()
    }
    return stampOfStat(info, head)
  } catch (error) {
    if (error?.code === 'ENOENT') return STAMP_ABSENT
    throw error
  }
}

/**
 * 同步戳（pre-step 热路径用；判据与 {@link fileStampOf} 完全相同）。
 *
 * 大文件头部读取在 Windows 上仍是一次 open+read+close，成本与一次 stat 同量级；
 * 这个函数只服务于「每步都要问一次」的状态/控制文件（几 KB）。
 * @param {string} filePath 被戳的文件
 * @returns {string} 不存在返回 {@link STAMP_ABSENT}
 */
export function fileStampOfSync(filePath) {
  let info
  try {
    info = statSync(filePath, { bigint: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return STAMP_ABSENT
    throw error
  }
  const buffer = Buffer.alloc(STAMP_HEAD_BYTES)
  const fd = openSync(filePath, 'r')
  try {
    const bytesRead = readSync(fd, buffer, 0, STAMP_HEAD_BYTES, 0)
    return stampOfStat(info, digestOf(buffer, bytesRead))
  } finally {
    closeSync(fd)
  }
}
