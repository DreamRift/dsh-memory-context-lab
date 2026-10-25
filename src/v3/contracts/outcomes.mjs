/**
 * v3 投影结果合同（单一真源）：decision 执行后的可观测结局（计划 §2.4——
 * 最后记录 projection outcome 和 metrics）。
 *
 * 诚实边界（P7）编码进 schema：
 * - status 只有三种：applied（全部效果落面）/ partial（部分落面，必须列 failures）/
 *   failed（零效果落面，必须列 failures）；
 * - applied 时 appliedEffects 必须等于 totalEffects，failures 必须为空——
 *   「表面投影失败不得伪装成已完成」（计划 §2.4）在结构层锁死；
 * - partial/failed 时 failures 非空且每条带 effectIndex + code。
 */
/** 结局状态封闭集。 */
export const OUTCOME_STATUSES = Object.freeze(['applied', 'partial', 'failed'])

/** 顶层字段封闭集。 */
export const OUTCOME_FIELDS = Object.freeze([
  'decisionId', 'sessionKey', 'at', 'status', 'totalEffects', 'appliedEffects', 'failures',
])

/** 失败条目字段封闭集。 */
export const FAILURE_FIELDS = Object.freeze(['effectIndex', 'code', 'message'])

/**
 * 结构校验：外部/落盘数据返回结构化结果不抛错（与 records/events 同口径）。
 *
 * @returns {{ ok: true, outcome: object } | { ok: false, errors: string[] }}
 */
export function validateOutcome(candidate) {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return { ok: false, errors: ['outcome 必须是对象'] }
  }
  const errors = []
  const known = new Set(OUTCOME_FIELDS)
  for (const key of Object.keys(candidate)) {
    if (!known.has(key)) errors.push('未知字段：' + key)
  }
  if (typeof candidate.decisionId !== 'string' || candidate.decisionId.length === 0) {
    errors.push('decisionId 必须是非空字符串')
  }
  if (typeof candidate.sessionKey !== 'string' || candidate.sessionKey.trim().length === 0) {
    errors.push('sessionKey 必须是非空白字符串')
  }
  if (!Number.isFinite(candidate.at) || candidate.at < 0) {
    errors.push('at 必须是有限非负数')
  }
  if (!OUTCOME_STATUSES.includes(candidate.status)) {
    errors.push('status 必须是封闭集 ' + OUTCOME_STATUSES.join('/') + ' 之一，得到：' + JSON.stringify(candidate.status))
  }
  if (!Number.isInteger(candidate.totalEffects) || candidate.totalEffects < 0) {
    errors.push('totalEffects 必须是非负整数')
  }
  if (!Number.isInteger(candidate.appliedEffects) || candidate.appliedEffects < 0) {
    errors.push('appliedEffects 必须是非负整数')
  }
  if (candidate.appliedEffects > candidate.totalEffects) {
    errors.push('appliedEffects 不得大于 totalEffects')
  }
  if (!Array.isArray(candidate.failures)) {
    errors.push('failures 必须是数组')
  } else {
    candidate.failures.forEach((failure, index) => {
      const where = 'failures[' + index + ']'
      if (failure === null || typeof failure !== 'object' || Array.isArray(failure)) {
        errors.push(where + ' 必须是对象')
        return
      }
      for (const key of Object.keys(failure)) {
        if (!FAILURE_FIELDS.includes(key)) errors.push(where + ' 不允许字段：' + key)
      }
      if (!Number.isInteger(failure.effectIndex) || failure.effectIndex < 0) {
        errors.push(where + '.effectIndex 必须是非负整数')
      }
      if (typeof failure.code !== 'string' || failure.code.length === 0) {
        errors.push(where + '.code 必须是非空字符串')
      }
      if (typeof failure.message !== 'string' || failure.message.length === 0) {
        errors.push(where + '.message 必须是非空字符串')
      }
    })
  }
  // 诚实边界：status 与计数/failures 的一致性
  if (OUTCOME_STATUSES.includes(candidate.status)) {
    if (candidate.status === 'applied') {
      if (candidate.appliedEffects !== candidate.totalEffects) {
        errors.push('applied 必须 appliedEffects === totalEffects（部分落面不得伪装成已完成）')
      }
      if (Array.isArray(candidate.failures) && candidate.failures.length > 0) {
        errors.push('applied 必须 failures 为空')
      }
    } else if (Array.isArray(candidate.failures) && candidate.failures.length === 0) {
      errors.push(candidate.status + ' 必须列 failures（失败要可见，不得只写日志）')
    }
  }
  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, outcome: candidate }
}
