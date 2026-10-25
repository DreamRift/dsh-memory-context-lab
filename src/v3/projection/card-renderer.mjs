/**
 * 工作卡渲染器（projection，M4 第一批）。
 *
 * 卡片是派生物（P9），净占用有严格上界：
 * - 预算经 domain allocateBudget（structural > protected > soft，soft 丢最旧保最新）；
 * - 页脚行计入上界（card-delta-cap 保留项：尾行无条件 push 曾让 1600 变 1644+）——
 *   渲染先扣留页脚保留量再分配正文，最终严格断言；
 * - 页脚如实列出未装包类目与原因（workingset「该看见的看不见」的反向：丢的要可见）；
 * - structuralOverflow 时如实标注，不静默裁空（P8）。
 * 本模块纯函数、无外部依赖（projection 层允许 node:*，但渲染器用不到）。
 */
import { allocateBudget } from '../domain/context/budget.mjs'
import { V3ContractViolation } from '../contracts/index.mjs'

/** 页脚保留量（字符）：页脚最长不超过这个量，正文按预算减去它分配。 */
export const FOOTER_RESERVE_CHARS = 80

/**
 * 渲染一张工作卡。
 * @param {object} input
 * @param {Array<{category: string, priority: 'structural'|'protected'|'soft', producer: boolean, lines: string[]}>} input.sections
 * @param {number} input.budgetChars 非负整数
 * @returns {{ text: string, included: string[], excluded: Array<{category,reason}>, structuralOverflow: boolean, usedChars: number, budgetChars: number }}
 */
export function renderWorkingCard({ sections, budgetChars } = {}) {
  if (budgetChars !== undefined && (!Number.isInteger(budgetChars) || budgetChars < 0)) {
    throw new V3ContractViolation('v3 card-renderer: budgetChars 必须是非负整数')
  }
  if (!Array.isArray(sections)) {
    throw new V3ContractViolation('v3 card-renderer: sections 必须是数组')
  }
  for (const section of sections) {
    if (!Array.isArray(section.lines) || section.lines.some((l) => typeof l !== 'string')) {
      throw new V3ContractViolation('v3 card-renderer: section.lines 必须是字符串数组（类目 ' + section?.category + '）')
    }
  }
  const budget = budgetChars ?? Number.MAX_SAFE_INTEGER
  // 字符数由渲染器自算（不信调用方报数——口径单一）
  const measured = sections.map((s) => ({
    ...s,
    chars: s.lines.reduce((sum, line) => sum + line.length + 1, 0),
  }))
  const gate = allocateBudget({ sections: measured, budgetChars: Math.max(0, budget - FOOTER_RESERVE_CHARS) })

  const body = []
  for (const section of measured) {
    if (gate.included.includes(section.category)) body.push(...section.lines)
  }
  // 页脚自身有界：上限 = min(保留量, 预算剩余)——预算小于保留量时按剩余截（按码点），
  // 枚举装不下就截断加「…」，计数语义保留在截断前。
  const bodyChars = body.reduce((sum, line) => sum + line.length + 1, 0)
  // 溢出（structuralOverflow）时标注必须存活——严格断言本就豁免溢出，页脚按保留量封顶
  const footerCap = gate.structuralOverflow || !Number.isFinite(budget) || budget === Number.MAX_SAFE_INTEGER
    ? FOOTER_RESERVE_CHARS
    : Math.max(0, Math.min(FOOTER_RESERVE_CHARS, budget - bodyChars))
  let footer = buildFooter(gate.excluded, gate.structuralOverflow, budget)
  if (footer.length > footerCap) {
    footer = footerCap > 0 ? [...footer].slice(0, Math.max(0, footerCap - 1)).join('') + '…' : ''
  }
  const text = [...body, footer].filter((l) => l.length > 0).join('\n')

  // 严格上界：非溢出情形 text 不得超过预算（页脚保留量兜住了页脚自身）
  if (!gate.structuralOverflow && budget !== Number.MAX_SAFE_INTEGER && text.length > budgetChars) {
    throw new V3ContractViolation('v3 card-renderer: 卡片超预算（' + text.length + ' > ' + budgetChars + '）——上界被突破是缺陷，不是截断信号')
  }
  return {
    text,
    included: gate.included,
    excluded: gate.excluded,
    structuralOverflow: gate.structuralOverflow,
    usedChars: text.length,
    budgetChars,
  }
}

function buildFooter(excluded, structuralOverflow, budget) {
  const parts = []
  if (structuralOverflow) {
    parts.push('结构段超出预算 ' + budget + ' 字：已如实保留并标注（P8 不静默裁空）')
  }
  if (excluded.length > 0) {
    const byReason = new Map()
    for (const { category, reason } of excluded) {
      const list = byReason.get(reason) ?? []
      list.push(category)
      byReason.set(reason, list)
    }
    const summary = [...byReason.entries()].map(([reason, list]) => list.join('/') + '(' + reason + ')').join('、')
    parts.push('另有 ' + excluded.length + ' 类未装包：' + summary + '（丢弃不等于不存在）')
  }
  return parts.join('；')
}
