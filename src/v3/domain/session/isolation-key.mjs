/**
 * 会话隔离键（domain/session 首个纯函数，M1 种子）。
 *
 * 不变量（M1 将以契约测试重证）：跨会话不串数据的第一道闸——
 * 隔离键对同一 session id 稳定、对不同 id 必不同、非法输入失败关闭而非静默归一。
 *
 * 路径安全（H-08，2026-10-26）：隔离键会被直接拼成
 * `<v3Root>/sessions/<sessionKey>`（session-store 的 sessionDirOf），所以它必须是
 * **单个安全路径段**——含分隔符/点段/控制字符/冒号/尾点尾空格/Windows 保留名/超长的键
 * 一律失败关闭。旧实现只做 trim+NFC，`'../../escape'` 会把数据写到数据根之外。
 */
import { v3Error } from '../../contracts/errors.mjs'

/** 单段上限：宿主 session id 是 `session-<uuid>`（约 45 字符），200 足够且远低于路径长度上限。 */
export const SESSION_KEY_MAX_LENGTH = 200

/** 路径分隔符、控制字符、冒号（盘符与 NTFS 备用数据流）。 */
const UNSAFE_CHARS = /[\\/\u0000-\u001f\u007f:]/

/** Windows 保留设备名（不区分大小写；带扩展名同样保留）。 */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

/**
 * 归一化会话隔离键：trim + NFC（编码纪律：路径与标识归一到 NFC）。
 * 非字符串、归一后为空、或不是单个安全路径段 → 抛 ESESSION_INVALID_ID，不得返回兜底值。
 */
export function sessionIsolationKey(sessionId) {
  if (typeof sessionId !== 'string') {
    throw v3Error('ESESSION_INVALID_ID', `session id 必须是字符串，得到 ${sessionId === null ? 'null' : typeof sessionId}`)
  }
  const key = sessionId.trim().normalize('NFC')
  if (key.length === 0) {
    throw v3Error('ESESSION_INVALID_ID', 'session id 归一后为空')
  }
  if (key.length > SESSION_KEY_MAX_LENGTH) {
    throw v3Error('ESESSION_INVALID_ID', 'session id 过长（' + key.length + ' > ' + SESSION_KEY_MAX_LENGTH + '）：隔离键要当目录名用')
  }
  if (UNSAFE_CHARS.test(key)) {
    throw v3Error('ESESSION_INVALID_ID', 'session id 含路径分隔符/控制字符/冒号，不能当目录段用：' + JSON.stringify(key))
  }
  if (key === '.' || key === '..') {
    throw v3Error('ESESSION_INVALID_ID', 'session id 不得是点段（会越出会话目录）：' + JSON.stringify(key))
  }
  if (/[. ]$/.test(key)) {
    throw v3Error('ESESSION_INVALID_ID', 'session id 不得以点或空格结尾（Windows 会静默归一，跨平台不一致）：' + JSON.stringify(key))
  }
  if (WINDOWS_RESERVED.test(key)) {
    throw v3Error('ESESSION_INVALID_ID', 'session id 是 Windows 保留设备名，不能当目录名：' + JSON.stringify(key))
  }
  return key
}
