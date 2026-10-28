/**
 * 确定性压缩摘要（M5）：只做首部切片，不做模型摘要、不引入新事实。
 * 只用于「显式 compact」；默认归档回执仍不含正文。
 */
import { V3ContractViolation } from '../../contracts/errors.mjs'

export const SUMMARY_MAX_CHARS = 220

function excerpt(text, max) {
  const chars = [...String(text ?? '')]
  return chars.length <= max ? chars.join('') : chars.slice(0, max).join('') + '…'
}

/** 记录列表 → 单行摘要；总量有界；不读额外来源。 */
export function summarizeRecords(records, { maxChars = SUMMARY_MAX_CHARS } = {}) {
  if (!Array.isArray(records)) throw new V3ContractViolation('v3 compress: records 必须是数组')
  if (!Number.isInteger(maxChars) || maxChars < 1) throw new V3ContractViolation('v3 compress: maxChars 必须是正整数')
  const parts = []
  for (const record of records) {
    const text = excerpt(record?.payload?.text ?? '', 60)
    if (text.length === 0) continue
    const label = record?.kind === 'message-user' ? '用户' : (record?.kind === 'message-assistant' ? '助手' : '操作')
    parts.push(label + '：' + text)
  }
  const joined = parts.join('；')
  return [...joined].length <= maxChars ? joined : [...joined].slice(0, maxChars - 1).join('') + '…'
}