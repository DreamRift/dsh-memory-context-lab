/**
 * S3 卡片组折叠（0.10.1）：把活动面上**连续的插件工作卡组**合并成单条折叠回执。
 *
 * H0 裁定后的 surface replace 路线：宿主没有 request-local 投影 seam，有界治理
 * 走既有表层替换通道。插件自己的工作卡（working-set/recall/回执凭证）在 pre-step
 * 尾部追加，天然形成连续卡组——把它们折叠成一条恒定大小的回执，是卡节点数的
 * 局部收益优化（不作全局硬上界证明，方案 §6 原文裁决保持不变）。
 *
 * 两条铁律（红例锁死）：
 * 1. 身份判定只认 source.form / 回执标记——不看内容前缀，人类手打的相似文本
 *    绝不入组（S3-F5）。
 * 2. 任何非卡节点都是断组边界。折叠区间两端必须是卡节点，区间内不得含
 *    assistant / tool-result / 人类 user / system 节点——「跨非卡区间整段
 *    replace 会吞助手消息」被方案 §6 明确禁止（S3-F2/F3）。
 *
 * 本模块纯函数、无 IO：输入是活动面节点视图（{ seq, type, sourceForm, text }），
 * 输出是确定性折叠计划，提交由调用方走 appendVoucherMessage 同款 surfaceOp.replace。
 */
import { V2_RECEIPT_MARKER } from '../core.mjs'

/** 折叠卡身份的来源形态：插件注入的工作资料（与 PLUGIN_SOURCE_FORMS 写入端一致）。 */
export const CARD_FOLD_FORMS = Object.freeze(['working-set', 'working-state', 'recall'])

export const CARD_FOLD_DEFAULTS = Object.freeze({
  /** 组长下限：单卡不折叠（折叠一张卡没有净收益，还多一次 replace 事件）。 */
  minRun: 2,
  /** 组长上限：一次 replace 的 sourceEventSeqs 与回执行数保持有界。 */
  maxRun: 8,
})

/**
 * 一个节点是不是插件工作卡。只认身份标记：sourceForm ∈ CARD_FOLD_FORMS，
 * 或正文以 V2_RECEIPT_MARKER 开头的归档回执/凭证（与 agg-voucher 的判定同源，
 * 但那里收窄到 memory-lab2-surface 形态；这里收窄到卡形态集）。
 */
export function isCardNode(node) {
  if (!node || node.type !== 'user/message') return false
  if (typeof node.sourceForm === 'string' && CARD_FOLD_FORMS.includes(node.sourceForm)) return true
  return typeof node.text === 'string' && node.text.startsWith(V2_RECEIPT_MARKER)
}

/**
 * 规划折叠。返回 { plans, runs }：
 * - runs 是全部连续卡组（含太短的），供诊断与计数；
 * - plans 是可提交计划：组长 ≥ minRun 才折叠，超长按 maxRun 切片，
 *   **尾片低于 minRun 时整片丢弃**——残片折叠一次的回执开销不小于残片本身，
 *   且切出的残片会让「卡节点数有界」多一个例外档。
 *
 * 切片策略保证计划不重叠且保序：每片是组的连续前缀切片，按 seq 升序输出。
 */
export function planCardFolds(nodes, { minRun = CARD_FOLD_DEFAULTS.minRun, maxRun = CARD_FOLD_DEFAULTS.maxRun } = {}) {
  const ordered = [...(nodes ?? [])].filter((node) => Number.isInteger(node?.seq)).sort((a, b) => a.seq - b.seq)
  const min = Number.isInteger(minRun) && minRun >= 1 ? minRun : CARD_FOLD_DEFAULTS.minRun
  const max = Number.isInteger(maxRun) && maxRun >= min ? maxRun : CARD_FOLD_DEFAULTS.maxRun

  const runs = []
  let current = []
  for (const node of ordered) {
    if (isCardNode(node)) {
      current.push(node)
    } else {
      // 任何非卡节点都是断组边界：assistant、tool/result、人类 user、system、
      // 以及任何未知类型。折叠区间绝不允许跨过它们。
      if (current.length > 0) runs.push(current)
      current = []
    }
  }
  if (current.length > 0) runs.push(current)

  const plans = []
  for (const run of runs) {
    if (run.length < min) continue
    for (let offset = 0; offset + min <= run.length; offset += max) {
      const chunk = run.slice(offset, Math.min(offset + max, run.length))
      // 尾片低于 minRun：整片丢弃，不出残片计划。
      if (chunk.length < min) continue
      const memberSeqs = chunk.map((node) => node.seq)
      const startSeq = memberSeqs[0]
      const endSeq = memberSeqs[memberSeqs.length - 1]
      const forms = chunk.map((node) => node.sourceForm ?? 'receipt')
      plans.push({
        startSeq,
        endSeq,
        memberSeqs,
        forms,
        text: renderFoldReceipt({ startSeq, endSeq, memberSeqs, forms }),
      })
    }
  }
  return { plans, runs: runs.map((run) => run.map((node) => node.seq)) }
}

/**
 * 折叠回执文本：纯函数、逐字节确定、无时间戳（前缀缓存安全）。
 *
 * 只报结构事实：成员范围、张数、形态分布、原文去向。不宣称「内容已理解」，
 * 不复述卡片正文——模型需要时可按记录 ID 回读，那是回读路径的事。
 */
export function renderFoldReceipt({ startSeq, endSeq, memberSeqs, forms = [] }) {
  const members = Array.isArray(memberSeqs) ? memberSeqs : []
  const counts = new Map()
  for (const form of Array.isArray(forms) ? forms : []) {
    const label = form === 'receipt' ? '回执凭证' : form === 'working-set' || form === 'working-state' ? '工作状态卡' : '回注包'
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }
  const parts = [...counts.entries()].map(([label, count]) => `${label} ${count} 张`).join('、')
  return [
    '[已折叠工作卡·v2]',
    `折叠卡 ${members.length} 张（${parts || '插件工作卡'}）：seq ${startSeq}–${endSeq}。本条为程序折叠回执，成员原文在 append-only 日志，可按记录 ID 回读。`,
  ].join('\n')
}
