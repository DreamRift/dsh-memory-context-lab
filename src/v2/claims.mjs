/**
 * S1 assistant-claim 保留（0.10.1，方案 §7）：从 assistant 正文确定性提取
 * 「结论性陈述行」为 claim 原子。
 *
 * 铁律：
 * 1. claim ≠ 事实：全部默认 unverified。抽到原句只证明「助手当时这么说过」，
 *    hash 校验通过不是事实验证，exit 0 推不出任务完成。升级路径只有独立验证
 *    （指纹/对照），那不在本模块。
 * 2. 反例不升级：否定（尚未/没有/未通过/仍未）、条件（如果/待/若…才）、
 *    引用（用户说/据报告/文档称/上文提到）、撤回（更正：/撤回先前/先前的…不成立）
 *    各自携带极性标记，绝不因出现「完成」「通过」等关键词被判为已完成。
 * 3. 原句保留：value 是原行文本（只去首尾空白与列表符号），不改写、不摘要、
 *    不翻译。sourceRef 由调用方（extractAtoms）挂。
 *
 * 纯函数、零 IO、确定性：无时间读数、无随机、无环境依赖。
 */

/** claim 极性（封闭集；扩集须同步升 hierarchy schema 语义）。 */
export const CLAIM_POLARITIES = Object.freeze({
  POSITIVE: 'positive',
  NEGATED: 'negated',
  CONDITIONAL: 'conditional',
  CITED: 'cited',
  RETRACTED: 'retracted',
})

/** 单次提取的行数上限：长正文按行截断（红例 S1-C7 有界性）。 */
export const CLAIM_MAX_LINES = 200

/** 结论行判定的起点词/结构（肯定式）。标定补例（S1-C8）：「全绿」「0 失败」是完成句常用变体。 */
const POSITIVE_MARKERS = ['已完成', '已完成：', '已经完成', '实现完成', '全部完成', '已修复', '已实现', '已通过', '完成：', '结论：', '验收通过', '全绿', '0 失败', '零失败']

/** 否定/条件/引用/撤回标记（优先级从高到低：先匹配到的极性生效）。 */
const RETRACT_MARKERS = ['更正：', '更正:', '撤回先前', '撤回之前的', '的结论不成立', '此前结论不成立', '先前的结论不成立']
const NEGATED_MARKERS = ['尚未', '仍未', '还没有', '未通过', '没有通过', '并未完成', '未完成', '不通过', '尚未通过', '还没完成', '没有证据表明', '并无证据', '找不到证据']
const CONDITIONAL_MARKERS = ['如果', '若', '待确认', '待验证', '待复核', '在确认后', '之后才能', '前提是']
const CITED_MARKERS = ['用户说', '用户表示', '据报告', '文档称', '上文提到', '有人称', '作者说', '他说', '她说', '据报道']

/** 非结论行的结构排除：疑问句、祈使句、标题、代码行、列表纯符号行。 */
function isStructurallyExcluded(line) {
  const trimmed = line.trim()
  if (trimmed === '') return true
  if (trimmed.endsWith('？') || trimmed.endsWith('?')) return true
  if (/^#{1,6}\s/.test(trimmed)) return true
  if (/^(    |\t|\u00a0)/.test(line)) return true
  if (/^[-*+]$/.test(trimmed) || /^[-*+]\s*$/.test(trimmed)) return true
  // 祈使句（请/继续/来/好）：没有结论标记时不算 claim。
  return false
}

/** 行内是否含任一标记。 */
function hasAnyMarker(line, markers) {
  for (const marker of markers) {
    if (line.includes(marker)) return true
  }
  return false
}

/** 判定一行是不是结论性陈述（公开判定面，供测试直测）。 */
export function isClaimLine(line) {
  if (typeof line !== 'string') return false
  if (isStructurallyExcluded(line)) return false
  const trimmed = line.trim()
  // 祈使/请求句排除：以这些开头且不含任何肯定/否定结论标记。
  const imperative = /^(请|来|去|继续|好的?|好嘞|明白|懂了)/.test(trimmed)
  const hasPositive = hasAnyMarker(trimmed, POSITIVE_MARKERS)
  const hasNegative = hasAnyMarker(trimmed, [...RETRACT_MARKERS, ...NEGATED_MARKERS, ...CONDITIONAL_MARKERS, ...CITED_MARKERS])
  if (imperative && !hasPositive && !hasNegative) return false
  return hasPositive || hasNegative
}

/** 行级极性判定：反例标记优先于肯定标记（「已完成但尚未通过」按否定）。 */
function polarityOf(line) {
  const trimmed = line.trim()
  if (hasAnyMarker(trimmed, RETRACT_MARKERS)) return CLAIM_POLARITIES.RETRACTED
  if (hasAnyMarker(trimmed, NEGATED_MARKERS)) return CLAIM_POLARITIES.NEGATED
  if (hasAnyMarker(trimmed, CONDITIONAL_MARKERS)) return CLAIM_POLARITIES.CONDITIONAL
  if (hasAnyMarker(trimmed, CITED_MARKERS)) return CLAIM_POLARITIES.CITED
  return CLAIM_POLARITIES.POSITIVE
}

/** 去掉行首列表符号与空白，保留原句。 */
function cleanClaimText(line) {
  return line.trim().replace(/^[-*+]\s+/, '').trim()
}

/**
 * 从一段 assistant 正文提取 claim 行。
 *
 * 返回 [{ value, polarity, verified: false, lineNumber }]：
 * - value = 原行文本（去首尾空白与列表符号）；
 * - lineNumber = 正文内 1 基行号；
 * - verified 恒 false（铁律 1：claim 不是事实）。
 *
 * 围栏代码块（\`\`\`）与引用行（>）不参与提取：那是代码或别人的话，
 * 不是 assistant 自己的结论。maxLines 上限按输入行数截断（有界性）。
 */
export function extractClaims(text, { maxLines = CLAIM_MAX_LINES } = {}) {
  if (typeof text !== 'string' || text === '') return []
  const limit = Number.isInteger(maxLines) && maxLines >= 1 ? maxLines : CLAIM_MAX_LINES
  const sourceLines = text.split('\n').slice(0, limit)
  const claims = []
  let inFence = false
  for (const [index, line] of sourceLines.entries()) {
    const trimmed = line.trim()
    if (trimmed.startsWith('\u0060\u0060\u0060')) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    if (trimmed.startsWith('>')) continue
    if (!isClaimLine(line)) continue
    const value = cleanClaimText(line)
    if (value === '') continue
    claims.push({
      value,
      polarity: polarityOf(line),
      verified: false,
      lineNumber: index + 1,
    })
  }
  return claims
}
