/**
 * v3 记录合同（单一真源）：追加式正文记录及来源/事务元数据是唯一权威事实源
 * （计划 §2.4）；工作卡、摘要、索引、缓存都是可删除、可重建的派生物。
 *
 * 编码进 schema 的 v2 教训：
 * - 「只校验 hash 不校验 size」让按字符数算 size 的记录永久不可读（store-hardening #2）
 *   → payload.bytes 必须等于 payload.text 的 UTF-8 字节长度，结构层直接拒绝；
 * - 键拼接撞键（key-and-order D-14）→ v3 一律 JSON 键，record 无拼接键；
 * - 封闭 schema：未知字段即非法，不允许「读得到就认」。
 */
import { V3ContractViolation } from './errors.mjs'

/** 记录种类（封闭集；新增须走 ADR 并有生产方）。 */
export const RECORD_KINDS = Object.freeze(['operation', 'message-user', 'message-assistant'])

/** 顶层字段封闭集（M2 存储守卫与序列化共用）。 */
export const RECORD_FIELDS = Object.freeze(['id', 'kind', 'sessionKey', 'createdAt', 'payload', 'provenance'])

/** 记录 ID 形状：v3r-<16 位小写十六进制>（生成经 Random 端口，此处只验形状）。 */
const RECORD_ID_PATTERN = /^v3r-[0-9a-f]{16}$/

/**
 * 结构校验：输入是外部/落盘数据，返回结构化结果而不抛错（与编程错误的
 * V3ContractViolation 分开——「数据坏」是业务事实，不是 bug）。
 *
 * @returns {{ ok: true, record: object } | { ok: false, errors: string[] }}
 */
export function validateRecord(candidate) {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return { ok: false, errors: ['record 必须是对象'] }
  }
  const errors = []
  const known = new Set(RECORD_FIELDS)
  for (const key of Object.keys(candidate)) {
    if (!known.has(key)) errors.push('未知字段：' + key)
  }
  if (typeof candidate.id !== 'string' || !RECORD_ID_PATTERN.test(candidate.id)) {
    errors.push('id 必须形如 v3r-<16 位小写十六进制>，得到：' + JSON.stringify(candidate.id))
  }
  if (!RECORD_KINDS.includes(candidate.kind)) {
    errors.push('kind 必须是封闭集 ' + RECORD_KINDS.join('/') + ' 之一，得到：' + JSON.stringify(candidate.kind))
  }
  if (typeof candidate.sessionKey !== 'string' || candidate.sessionKey.trim().length === 0) {
    errors.push('sessionKey 必须是非空白字符串')
  }
  if (!Number.isFinite(candidate.createdAt) || candidate.createdAt < 0) {
    errors.push('createdAt 必须是有限非负数（毫秒纪元）')
  }
  const payload = candidate.payload
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    errors.push('payload 必须是对象')
  } else {
    if (typeof payload.text !== 'string') errors.push('payload.text 必须是字符串')
    if (!Number.isInteger(payload.bytes) || payload.bytes < 0) {
      errors.push('payload.bytes 必须是非负整数')
    } else if (typeof payload.text === 'string' && payload.bytes !== Buffer.byteLength(payload.text, 'utf8')) {
      errors.push('payload.bytes 与 text 的 UTF-8 字节长度不符（' + payload.bytes + ' ≠ ' + Buffer.byteLength(payload.text, 'utf8') + '）——按字符数算 size 的记录一律拒绝')
    }
  }
  const provenance = candidate.provenance
  if (provenance === null || typeof provenance !== 'object' || Array.isArray(provenance)) {
    errors.push('provenance 必须是对象')
  } else if (typeof provenance.transactionId !== 'string' || provenance.transactionId.length === 0) {
    errors.push('provenance.transactionId 必须是非空字符串（原子提交审计线索）')
  } else {
    for (const key of ['sourceEventId', 'sourceForm']) {
      const value = provenance[key]
      if (value !== null && typeof value !== 'string') errors.push('provenance.' + key + ' 必须是字符串或 null')
    }
  }
  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, record: candidate }
}

/** 便捷断言版：给 M2 存储事务入口用（非法即拒绝提交，fail-closed）。 */
export function assertValidRecord(candidate) {
  const result = validateRecord(candidate)
  if (!result.ok) {
    throw new V3ContractViolation('v3 records: 记录非法——' + result.errors.join('；'))
  }
  return result.record
}
