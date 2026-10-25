/**
 * v3 事件合同（单一真源）：宿主适配层归一化后的真实用户事件形状（计划 §2.4：
 * 归一化并保留原始 event id/source）。
 *
 * 封闭集纪律与 records 相同：未知字段/未知类型一律非法，不允许「读得到就认」。
 * 事件类型刻意收窄为四种——回合判定（真实用户回合计数，P3）是 domain/session
 * 的职责，不在合同层做语义裁决。
 */
/** 事件类型封闭集。 */
export const EVENT_TYPES = Object.freeze(['user', 'assistant', 'tool-call', 'tool-result'])

/** 顶层字段封闭集。 */
export const EVENT_FIELDS = Object.freeze(['id', 'type', 'sessionKey', 'at', 'source'])

/**
 * 结构校验：外部数据返回结构化结果不抛错（与 records 同口径）。
 *
 * @returns {{ ok: true, event: object } | { ok: false, errors: string[] }}
 */
export function validateEvent(candidate) {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return { ok: false, errors: ['event 必须是对象'] }
  }
  const errors = []
  const known = new Set(EVENT_FIELDS)
  for (const key of Object.keys(candidate)) {
    if (!known.has(key)) errors.push('未知字段：' + key)
  }
  if (typeof candidate.id !== 'string' || candidate.id.length === 0) {
    errors.push('id 必须是非空字符串（保留宿主原始 event id）')
  }
  if (!EVENT_TYPES.includes(candidate.type)) {
    errors.push('type 必须是封闭集 ' + EVENT_TYPES.join('/') + ' 之一，得到：' + JSON.stringify(candidate.type))
  }
  if (typeof candidate.sessionKey !== 'string' || candidate.sessionKey.trim().length === 0) {
    errors.push('sessionKey 必须是非空白字符串')
  }
  if (!Number.isFinite(candidate.at) || candidate.at < 0) {
    errors.push('at 必须是有限非负数（毫秒纪元）')
  }
  const source = candidate.source
  if (source === null || typeof source !== 'object' || Array.isArray(source)) {
    errors.push('source 必须是对象')
  } else {
    const sourceKeys = Object.keys(source)
    if (sourceKeys.some((k) => !['kind', 'form'].includes(k))) errors.push('source 只允许 kind/form 字段')
    if (typeof source.kind !== 'string' || source.kind.length === 0) errors.push('source.kind 必须是非空字符串（写入者身份，P1 谁注入谁回收的认领依据）')
    if (source.form !== null && typeof source.form !== 'string') errors.push('source.form 必须是字符串或 null')
  }
  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, event: candidate }
}
