/**
 * 回读分页游标。
 *
 * 为什么需要它：预算用尽时必须能**从上次停下的地方继续**，而不是让调用方
 * 重新发一次同样的请求（那会重复付同样的代价，且结果可能因新写入而漂移）。
 * 游标只承载「下次从哪里开始」，不承载任何权威状态：它不签名、不加密、
 * 不含正文，伪造一个游标最多让调用方读到别的偏移，不会绕过预算或只读边界。
 *
 * 编码格式：`v1.<base64url(JSON)>`。解析失败一律返回 null（调用方按「没有游标」
 * 处理），绝不把坏游标当成空查询——那会把「读错了」伪装成「读完了」。
 */

import { EngineV2Error } from './errors.mjs'

export const CURSOR_SCHEMA_VERSION = 1
const PREFIX = `v${CURSOR_SCHEMA_VERSION}.`

/** 游标里允许出现的模式（与 recall 的三种模式一一对应）。 */
export const CURSOR_MODES = Object.freeze({ IDS: 'ids', QUERY: 'query' })

function encodeBase64Url(text) {
  return Buffer.from(text, 'utf8').toString('base64url')
}

function decodeBase64Url(text) {
  return Buffer.from(text, 'base64url').toString('utf8')
}

/**
 * 生成游标。`next` 为空对象或 null 时返回 null（表示没有下一页）。
 */
export function encodeCursor(next) {
  if (!next || typeof next !== 'object') return null
  const payload = { v: CURSOR_SCHEMA_VERSION, ...next }
  const hasWork = (Array.isArray(payload.ids) && payload.ids.length > 0)
    || (typeof payload.after === 'string' && payload.after !== '')
  if (!hasWork) return null
  return `${PREFIX}${encodeBase64Url(JSON.stringify(payload))}`
}

/**
 * 解析游标。返回 `{ ok: true, value }` 或 `{ ok: false, error }`。
 *
 * 刻意区分「没给游标」（`ok:true, value:null`）与「给了但坏了」（`ok:false`）：
 * 坏游标必须报错，不能被当成「从头开始」——那会让调用方以为读完了全部。
 */
export function decodeCursor(raw) {
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: null }
  if (typeof raw !== 'string') {
    return { ok: false, error: `cursor 必须是字符串（收到 ${JSON.stringify(raw)}）` }
  }
  if (!raw.startsWith(PREFIX)) {
    return { ok: false, error: `cursor 版本不识别（期望前缀 ${PREFIX}）` }
  }
  let parsed = null
  try {
    parsed = JSON.parse(decodeBase64Url(raw.slice(PREFIX.length)))
  } catch {
    return { ok: false, error: 'cursor 不是合法的 base64url JSON' }
  }
  if (!parsed || typeof parsed !== 'object' || parsed.v !== CURSOR_SCHEMA_VERSION) {
    return { ok: false, error: 'cursor 载荷版本不匹配' }
  }
  if (parsed.mode !== CURSOR_MODES.IDS && parsed.mode !== CURSOR_MODES.QUERY) {
    return { ok: false, error: `cursor 模式不可识别（${JSON.stringify(parsed.mode ?? null)}）` }
  }
  const value = {
    mode: parsed.mode,
    ids: Array.isArray(parsed.ids) ? parsed.ids.filter((id) => typeof id === 'string' && id !== '') : [],
    query: typeof parsed.query === 'string' && parsed.query !== '' ? parsed.query : null,
    after: typeof parsed.after === 'string' && parsed.after !== '' ? parsed.after : null,
    skipped: Number.isSafeInteger(parsed.skipped) && parsed.skipped > 0 ? parsed.skipped : 0,
  }
  if (value.mode === CURSOR_MODES.IDS && value.ids.length === 0) {
    return { ok: false, error: 'cursor 声称有下一页但没有剩余 ID' }
  }
  if (value.mode === CURSOR_MODES.QUERY && (value.query === null || value.after === null)) {
    return { ok: false, error: 'cursor 声称有下一页但缺少查询词或起始位置' }
  }
  return { ok: true, value }
}

/** 解析失败即抛错（供 recall 使用：坏游标必须变成显式错误，不静默重来）。 */
export function requireCursor(raw) {
  const decoded = decodeCursor(raw)
  if (!decoded.ok) {
    throw new EngineV2Error(`无法使用该 cursor：${decoded.error}`, {
      code: 'EINVAL',
      details: { cursor: typeof raw === 'string' ? raw.slice(0, 64) : null },
    })
  }
  return decoded.value
}
