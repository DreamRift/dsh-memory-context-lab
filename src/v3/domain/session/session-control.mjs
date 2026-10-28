/**
 * 会话级控制（domain/session，纯函数）。
 *
 * 产品口径（2026-10-27 用户反馈）：
 * - **插件设置页**负责全局默认（Config 的五个字段）；
 * - **composer 弹层**只改**本对话**：是否启用、自动回注开关、以及回注条数；
 *   未设置的项跟随全局默认，面板里显示为空（placeholder「跟随全局」）。
 *   底层参数（装包阈 / 首部长度 / 查询上限）只留在插件设置页，不进对话弹层。
 *
 * 控制文件是每会话 `sessions/<key>/control.json`，与 v3 冷库同目录；它是用户意图，
 * 不是会话语义数据，因此不进记录/索引，也不参与 append-only 账本。
 */
import { V3ContractViolation, v3Error } from '../../contracts/errors.mjs'

export const SESSION_CONTROL_SCHEMA_VERSION = 1

/** 每个可覆盖数值的取值域；与入口 Config 的 schema 同域（由测试交叉核对）。 */
export const SESSION_OVERRIDE_BOUNDS = Object.freeze({
  limit: Object.freeze({ min: 1, max: 20, integer: true }),
  // 按步归档闸门（占用百分比）。0 = 每步都判断（最省 token、最费前缀缓存），95 = 几乎不开闸。
  gate: Object.freeze({ min: 0, max: 95, integer: true }),
})

export const SESSION_OVERRIDE_KEYS = Object.freeze(Object.keys(SESSION_OVERRIDE_BOUNDS))

/** 默认控制：全开、无覆盖。 */
export function emptySessionControl() {
  return {
    schemaVersion: SESSION_CONTROL_SCHEMA_VERSION,
    enabled: true,
    recall: true,
    overrides: {},
    updatedAt: 0,
  }
}

function validNumber(value, bounds) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return false
  if (bounds.integer === true && !Number.isInteger(value)) return false
  return value >= bounds.min && value <= bounds.max
}

/**
 * 把控制文件的原始 JSON 收敛成安全形状。非法字段被丢弃并记 error——
 * 读路径不抛错（pre-step 每步都会读），但绝不把非法值当成生效值。
 * @param {unknown} raw 文件内容
 * @param {{defaultEnabled?: boolean}} [options] 缺省/损坏时的 enabled；新会话默认关
 * @returns {{ control: object, error: string|null }}
 */
export function normalizeSessionControl(raw, { defaultEnabled = true } = {}) {
  const control = emptySessionControl()
  // 缺省 enabled 不是无条件 true：新对话 defaultEnabled=false，控制文件缺字段/损坏
  // 时若回落 true，就是「失败开放」（隐私面意外开始摄入）。
  control.enabled = defaultEnabled !== false
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { control, error: 'ECONTROL_SHAPE' }
  }
  let error = null
  if (raw.schemaVersion !== undefined && raw.schemaVersion !== SESSION_CONTROL_SCHEMA_VERSION) {
    error = 'ECONTROL_VERSION'
  }
  for (const key of ['enabled', 'recall']) {
    if (raw[key] === undefined) continue
    if (typeof raw[key] !== 'boolean') { error = error ?? 'ECONTROL_BOOLEAN'; continue }
    control[key] = raw[key]
  }
  if (raw.overrides !== undefined) {
    if (raw.overrides === null || typeof raw.overrides !== 'object' || Array.isArray(raw.overrides)) {
      error = error ?? 'ECONTROL_OVERRIDES'
    } else {
      for (const [key, value] of Object.entries(raw.overrides)) {
        const bounds = SESSION_OVERRIDE_BOUNDS[key]
        if (bounds === undefined) { error = error ?? 'ECONTROL_UNKNOWN_KEY'; continue }
        if (!validNumber(value, bounds)) { error = error ?? 'ECONTROL_RANGE'; continue }
        control.overrides[key] = value
      }
    }
  }
  if (raw.updatedAt !== undefined) {
    if (typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt)) control.updatedAt = raw.updatedAt
    else error = error ?? 'ECONTROL_UPDATED_AT'
  }
  return { control, error }
}

/**
 * 生成新控制（写路径）：对非法 patch 失败关闭，不静默丢弃。
 * @param {object} current 已归一化的当前控制
 * @param {object} patch { enabled?, recall?, overrides?: { limit: number|null } }
 * @returns {object} 新的控制
 */
export function patchSessionControl(current, patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new V3ContractViolation('session control: patch 必须是对象')
  }
  const next = {
    ...emptySessionControl(),
    enabled: current.enabled,
    recall: current.recall,
    overrides: { ...current.overrides },
    updatedAt: Date.now(),
  }
  for (const key of ['enabled', 'recall']) {
    if (patch[key] === undefined) continue
    if (typeof patch[key] !== 'boolean') throw new V3ContractViolation('session control: ' + key + ' 必须是布尔值')
    next[key] = patch[key]
  }
  if (patch.overrides !== undefined) {
    if (patch.overrides === null || typeof patch.overrides !== 'object' || Array.isArray(patch.overrides)) {
      throw new V3ContractViolation('session control: overrides 必须是对象')
    }
    for (const [key, value] of Object.entries(patch.overrides)) {
      const bounds = SESSION_OVERRIDE_BOUNDS[key]
      if (bounds === undefined) throw new V3ContractViolation('session control: 未知覆盖项 ' + key)
      if (value === null) { delete next.overrides[key]; continue }
      if (!validNumber(value, bounds)) {
        throw v3Error('ECONTROL_RANGE', 'session control: ' + key + ' 必须在 ' + bounds.min + '–' + bounds.max + ' 之间（得到 ' + JSON.stringify(value) + '）')
      }
      next.overrides[key] = value
    }
  }
  return next
}

/**
 * 合并「全局设置 + 会话控制」得到本次实际生效值。
 * @param {object} globalSettings 入口 readSettings 的结果
 * @param {object} control 会话控制
 */
export function mergeSessionSettings(globalSettings, control) {
  const overrides = control !== null && typeof control === 'object' && control.overrides !== null && typeof control.overrides === 'object'
    ? control.overrides
    : {}
  const enabled = globalSettings.enabled !== false
    && (control === null || control === undefined || control.enabled !== false)
    && (control === null || control === undefined || control.recall !== false)
  return {
    enabled,
    limit: overrides.limit ?? globalSettings.limit,
    gate: overrides.gate ?? (Number.isFinite(globalSettings.coolingGate) ? globalSettings.coolingGate : 20),
    packMinScore: globalSettings.packMinScore,
    previewChars: globalSettings.previewChars,
    queryMaxChars: globalSettings.queryMaxChars,
  }
}
