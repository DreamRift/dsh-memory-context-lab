/**
 * append-only 日志的**尾部检查**（P3-07，0.15.1 独立排查报告 §3.3）。
 *
 * ## 缺陷
 * `appendCheckpoint` / `appendCheckpointBaseline` 在追加前用 `parseTxnLog` **整本解析**
 * 检查点账本，只为回答「现在能不能安全地再追加一行」。检查点是一笔事务一行：
 * 长会话累积到 2 万行时，每次提交都要读+解析 1.4 MB（实测 12.1 ms/次，而一次追加本身
 * 只要 0.6 ms）——成本随台账长度线性增长，且这段代码在**提交路径**上。
 *
 * ## 根因
 * 判据放错了问题：追加只接触文件**尾部**，「尾部是否处于可追加状态」与「整本是否每一行
 * 都可解析」是两个不同的问题，却被同一个全量解析同时回答。
 *
 * ## 修法（判据边界，不是放宽）
 * - **追加门**（本模块）：只看尾部窗口（默认 64 KiB）。够回答「上一行完整吗、
 *   结尾有换行吗」；窗口内出现坏行仍失败关闭。
 * - **读门**（`readCheckpoint` / `parseTxnLog`）：**不变**，仍整本解析、首个坏行即
 *   `damaged`、检查点判 `usable:false` 并回退全量扫描。整本中段损坏因此仍然失败关闭，
 *   只是**追加**不再为读面的判据付钱（它与磁盘账本的字节状态无关）。
 *
 * 为什么可以这样切：尾部完好的追加**只会**在文件末尾增长，不会让任何既有坏行变得更坏，
 * 也不会让读面「看起来可用」——读面判据没有变。反过来，尾部半行（崩溃在 append 中途）
 * 是**唯一**会让「新行粘在坏行后面、两行一起不可解析」的形态，也是本模块唯一的硬拒绝条件。
 *
 * ## 已知边界
 * 窗口之外的**中段**损坏不在这里被检出（那是读面的职责，它在 `readCheckpoint` 里
 * 失败关闭并触发全量重扫）。本模块不声称能证明整本账本健康。
 */
import { open } from 'node:fs/promises'
import path from 'node:path'

/** 尾部窗口默认大小：足够覆盖「最后一行 + 若干行」，与 usage/观测账本的尾部窗口同量级。 */
export const APPEND_TAIL_BYTES = 64 * 1024

/**
 * 检查文件尾部是否处于「可以安全追加一行」的状态。
 *
 * @param {string} filePath 目标日志
 * @param {string} [label] 诊断用标签（错误文案里出现）
 * @param {{bytes?: number}} [options] 覆盖窗口大小（测试用）
 * @returns {Promise<{
 *   appendable: boolean, damaged: boolean, reason: string|null, exists: boolean,
 *   endsWithNewline: boolean, scannedBytes: number, size: number
 * }>}
 */
export async function inspectAppendTail(filePath, label = path.basename(filePath), options = {}) {
  const window = Number.isSafeInteger(options.bytes) && options.bytes > 0 ? options.bytes : APPEND_TAIL_BYTES
  let handle
  try {
    handle = await open(filePath, 'r')
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { appendable: true, damaged: false, reason: null, exists: false, endsWithNewline: true, scannedBytes: 0, size: 0 }
    }
    throw error // 读不到 ≠ 可以追加：EACCES/EMFILE 必须向上抛（失败关闭）
  }
  try {
    const { size } = await handle.stat()
    if (size === 0) {
      return { appendable: true, damaged: false, reason: null, exists: true, endsWithNewline: true, scannedBytes: 0, size: 0 }
    }
    const readBytes = Math.min(size, window)
    const buffer = Buffer.alloc(readBytes)
    const { bytesRead } = await handle.read(buffer, 0, readBytes, size - readBytes)
    const text = buffer.subarray(0, bytesRead).toString('utf8')
    const endsWithNewline = text.endsWith('\n')
    // 窗口没覆盖整个文件时，第一段是**从行中间切开**的残片：它不是「坏行」，必须丢掉。
    const body = readBytes < size ? text.slice(text.indexOf('\n') + 1) : text
    if (readBytes < size && text.indexOf('\n') < 0) {
      // 整个窗口都在同一行里（单行 > 64 KiB 的病态文件）：无法判定，交读面处理。
      return {
        appendable: false, damaged: true, reason: label + ' 尾部窗口内找不到行边界（单行超过窗口，无法判定可追加）',
        exists: true, endsWithNewline, scannedBytes: bytesRead, size,
      }
    }
    // 完整行 = 结尾换行之前的每一段；结尾换行之后若还有内容，那是**尾行**（可能半写）。
    const parts = body.split('\n')
    const trailing = parts.pop() ?? ''
    for (let index = 0; index < parts.length; index += 1) {
      if (parts[index].length === 0) continue
      try {
        JSON.parse(parts[index])
      } catch {
        return {
          appendable: false, damaged: true, reason: label + ' 尾部窗口内第 ' + (index + 1) + ' 段不可解析（中段损坏，不自动截断）',
          exists: true, endsWithNewline, scannedBytes: bytesRead, size,
        }
      }
    }
    if (trailing.length > 0) {
      // 文件末尾没有换行却还有内容：可解析 = 已写完整的最后一行（只是缺换行）；
      // 不可解析 = append 中途崩溃留下的半行——**唯一**必须拒绝追加的形态。
      try {
        JSON.parse(trailing)
      } catch {
        return {
          appendable: false, damaged: true, reason: label + ' 尾部半行（无结尾换行且不可解析），请先 /memory-lab repair',
          exists: true, endsWithNewline, scannedBytes: bytesRead, size,
        }
      }
    }
    return { appendable: true, damaged: false, reason: null, exists: true, endsWithNewline, scannedBytes: bytesRead, size }
  } finally {
    await handle.close().catch(() => {})
  }
}
