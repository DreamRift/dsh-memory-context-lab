/**
 * 会话隔离键（domain/session 首个纯函数，M1 种子）。
 *
 * 不变量（M1 将以契约测试重证）：跨会话不串数据的第一道闸——
 * 隔离键对同一 session id 稳定、对不同 id 必不同、非法输入失败关闭而非静默归一。
 */
import { v3Error } from '../../contracts/errors.mjs'

/**
 * 归一化会话隔离键：trim + NFC（编码纪律：路径与标识归一到 NFC）。
 * 非字符串或归一后为空 → 抛 ESESSION_INVALID_ID，不得返回兜底值。
 */
export function sessionIsolationKey(sessionId) {
  if (typeof sessionId !== 'string') {
    throw v3Error('ESESSION_INVALID_ID', `session id 必须是字符串，得到 ${sessionId === null ? 'null' : typeof sessionId}`)
  }
  const key = sessionId.trim().normalize('NFC')
  if (key.length === 0) {
    throw v3Error('ESESSION_INVALID_ID', 'session id 归一后为空')
  }
  return key
}
