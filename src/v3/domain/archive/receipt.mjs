/**
 * 归档回执（domain/archive，纯函数，M2）。
 *
 * 回执是模型在活动面看到的唯一替代物：不含原文、不含 reasoning、不含绝对路径；
 * 只给数量、序号区间、少量记录 ID 和恢复/检索入口。硬上界 400 字符，避免回执本身
 * 变成新的上下文税。
 */
import { V3ContractViolation } from '../../contracts/errors.mjs'

export const RECEIPT_MAX_CHARS = 400

function sampleIds(recordIds) {
  const ids = recordIds.filter((id) => typeof id === 'string' && id.length > 0)
  if (ids.length <= 3) return ids
  return ids.slice(0, 3)
}

/**
 * 生成回执正文。
 * @param {{startSeq:number,endSeq:number,recordIds:string[],operations?:number,unitLabel?:string}} input
 * @returns {string}
 */
export function renderArchiveReceipt({ startSeq, endSeq, recordIds, operations = 0, unitLabel = '操作数', summary = '' } = {}) {
  if (!Number.isInteger(startSeq) || startSeq < 0 || !Number.isInteger(endSeq) || endSeq < startSeq) {
    throw new V3ContractViolation('v3 archive/receipt: startSeq/endSeq 非法')
  }
  if (!Array.isArray(recordIds) || recordIds.length === 0) {
    throw new V3ContractViolation('v3 archive/receipt: recordIds 必须是非空数组')
  }
  const ids = sampleIds(recordIds)
  const count = recordIds.length
  const lines = [
    '[记忆上下文] 已把 ' + count + ' 条已完成历史（seq ' + startSeq + '–' + endSeq + '）归档为可恢复回执。',
    '记录 ID：' + ids.join('、') + (ids.length < count ? '…' : ''),
    '恢复：/memory-lab restore；检索：/memory-lab recall <词>；原文仍在会话日志，可按 ID 回读。',
  ]
  // AUD48-04-02：按轮归档的 operations 是「回合数」、按步归档是「步骤数」；旧文案恒写
  // 「操作数」会让用户把 1 个回合误读成 1 次操作（真实凭证 54/14/74 条全是「操作数：1」）。
  const label = typeof unitLabel === 'string' && unitLabel.length > 0 ? unitLabel : '操作数'
  if (Number.isInteger(operations) && operations > 0) lines.splice(1, 0, label + '：' + operations + '。')
  if (typeof summary === 'string' && summary.length > 0) lines.splice(1, 0, '摘要：' + summary)
  const text = lines.join('\n')
  return text.length <= RECEIPT_MAX_CHARS ? text : text.slice(0, RECEIPT_MAX_CHARS - 1) + '…'
}