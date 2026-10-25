/**
 * v3 裁决合同（单一真源）：domain 输出的不可变 decision（计划 §2.4——
 * application 调用 domain 生成不可变 decision；提交成功后才执行活动面操作）。
 *
 * effects 是裁决的全部可观测后果：store 事务提交的记录、活动面 replace/append。
 * basis 必填：每条裁决自带依据（P7 投影诚实 / 来源可追溯）。
 */
import { V3ContractViolation } from './errors.mjs'
import { deepFreeze } from '../shared/deep-freeze.mjs'

/** 裁决种类封闭集。 */
export const DECISION_KINDS = Object.freeze(['archive', 'retain', 'restore', 'forget', 'inject'])

/** 裁决顶层字段封闭集。 */
export const DECISION_FIELDS = Object.freeze(['id', 'kind', 'sessionKey', 'createdAt', 'effects', 'basis'])

/** 效果种类封闭集（store-record / surface-replace / surface-append）。 */
export const EFFECT_KINDS = Object.freeze(['store-record', 'surface-replace', 'surface-append'])

/** 各效果种类的必填附加字段（缺即非法；surface-append 无附加字段）。 */
const EFFECT_REQUIRED_FIELDS = Object.freeze({
  'store-record': ['recordId'],
  'surface-replace': ['targetEventId'],
  'surface-append': [],
})

/** 效果允许的字段（附加字段 + 通用 text）。 */
const EFFECT_ALLOWED_FIELDS = Object.freeze({
  'store-record': ['recordId', 'text'],
  'surface-replace': ['targetEventId', 'text'],
  'surface-append': ['text'],
})

/**
 * 结构校验：外部/跨层数据返回结构化结果不抛错。
 *
 * @returns {{ ok: true, decision: object } | { ok: false, errors: string[] }}
 */
export function validateDecision(candidate) {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return { ok: false, errors: ['decision 必须是对象'] }
  }
  const errors = []
  const known = new Set(DECISION_FIELDS)
  for (const key of Object.keys(candidate)) {
    if (!known.has(key)) errors.push('未知字段：' + key)
  }
  if (typeof candidate.id !== 'string' || candidate.id.length === 0) {
    errors.push('id 必须是非空字符串')
  }
  if (!DECISION_KINDS.includes(candidate.kind)) {
    errors.push('kind 必须是封闭集 ' + DECISION_KINDS.join('/') + ' 之一，得到：' + JSON.stringify(candidate.kind))
  }
  if (typeof candidate.sessionKey !== 'string' || candidate.sessionKey.trim().length === 0) {
    errors.push('sessionKey 必须是非空白字符串')
  }
  if (!Number.isFinite(candidate.createdAt) || candidate.createdAt < 0) {
    errors.push('createdAt 必须是有限非负数')
  }
  if (typeof candidate.basis !== 'string' || candidate.basis.trim().length === 0) {
    errors.push('basis 必须是非空字符串（裁决依据必填，P7 投影诚实）')
  }
  if (!Array.isArray(candidate.effects)) {
    errors.push('effects 必须是数组（无效果裁决用空数组，不是省略）')
  } else {
    candidate.effects.forEach((effect, index) => {
      const where = 'effects[' + index + ']'
      if (effect === null || typeof effect !== 'object' || Array.isArray(effect)) {
        errors.push(where + ' 必须是对象')
        return
      }
      if (!EFFECT_KINDS.includes(effect.kind)) {
        errors.push(where + '.kind 必须是封闭集 ' + EFFECT_KINDS.join('/') + ' 之一')
        return
      }
      const allowed = EFFECT_ALLOWED_FIELDS[effect.kind]
      for (const key of Object.keys(effect)) {
        if (key !== 'kind' && !allowed.includes(key)) errors.push(where + ' 不允许字段：' + key)
      }
      for (const required of EFFECT_REQUIRED_FIELDS[effect.kind]) {
        if (typeof effect[required] !== 'string' || effect[required].length === 0) {
          errors.push(where + ' 缺必填字段：' + required)
        }
      }
      if (effect.text !== undefined && typeof effect.text !== 'string') {
        errors.push(where + '.text 必须是字符串')
      }
    })
  }
  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, decision: candidate }
}

/**
 * 验证并封印：deepFreeze 后返回。domain 工厂出口统一走这里——经手即不可变，
 * 下游改不动也就不存在「裁决被悄悄改写」的缺陷类。
 * @throws {V3ContractViolation} 形状非法（编程错误：domain 工厂产出了坏裁决）。
 */
export function sealDecision(candidate) {
  const result = validateDecision(candidate)
  if (!result.ok) {
    throw new V3ContractViolation('v3 decisions: 裁决非法——' + result.errors.join('；'))
  }
  return deepFreeze(result.decision)
}
