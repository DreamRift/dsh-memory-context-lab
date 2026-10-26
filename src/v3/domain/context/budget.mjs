/**
 * 投影预算器（domain/context 纯函数，M1）。
 *
 * 编码进判据的 v2 结论（docs/dev-0.14.0/行为规格映射-草案.md card 族）：
 * - **P8**：预算先保结构性必需段（当前任务锚、保护集指针），检索结果填余量；
 *   「预算 1200 裁空」教训 → 结构段不因预算小而静默消失，装不下就如实标
 *   structuralOverflow（P7 截断显式声明）。
 * - **D-12**：预算 null/''/[] 一律非法（Number(null)===0 教训），不做静默归一。
 * - **D-13**：软保留超额时丢最旧保最新（v2 曾相反：被丢的恰好是刚发出的）。
 * - **workingset-wiring**：类目必须先有生产方才能进渲染集——无生产方的类目
 *   整类摘除且在 excluded 里可见（不静默）。
 * - **readLease（⑥ 租约 retainReads，2026-10-25 用户拍板移植）**：刚读过的记录
 *   很可能马上要用——soft 段带活跃租约（leaseUntil > now）晋升 protected，
 *   不随「丢最旧」被挤出；租约是 TTL 判据，不是保护集扩张。
 */
import { V3ContractViolation } from '../../contracts/errors.mjs'

/** 段优先级封闭集：structural（无条件保留）> protected（结构性保护）> soft（填余量）。 */
export const SECTION_PRIORITIES = Object.freeze(['structural', 'protected', 'soft'])

/**
 * 预算分配。
 *
 * @param {object} input
 * @param {Array<{category: string, priority: string, chars: number, producer: boolean}>} input.sections
 * @param {number} input.budgetChars 非负整数预算（字符）
 * @returns {{ included: string[], excluded: Array<{category: string, reason: string}>, usedChars: number, budgetChars: number, structuralOverflow: boolean }}
 */
/** 租约是否活跃（⑥：lastReadAt + ttl 内才算「刚读过」；参数非法失败关闭返回 false）。 */
export function isReadLeaseActive({ lastReadAt, now, ttlMs } = {}) {
  if (!Number.isFinite(lastReadAt) || !Number.isFinite(now) || !Number.isFinite(ttlMs) || ttlMs <= 0) return false
  return now - lastReadAt >= 0 && now - lastReadAt <= ttlMs
}

export function allocateBudget({ sections, budgetChars, now = null } = {}) {
  if (!Array.isArray(sections)) {
    throw new V3ContractViolation('v3 context/budget: sections 必须是数组')
  }
  if (!Number.isInteger(budgetChars) || budgetChars < 0) {
    throw new V3ContractViolation('v3 context/budget: budgetChars 必须是非负整数（null/NaN/负数一律非法，不静默归一——D-12）')
  }
  const seen = new Set()
  for (const section of sections) {
    if (section === null || typeof section !== 'object') {
      throw new V3ContractViolation('v3 context/budget: section 必须是对象')
    }
    if (typeof section.category !== 'string' || section.category.length === 0) {
      throw new V3ContractViolation('v3 context/budget: section.category 必须是非空字符串')
    }
    if (seen.has(section.category)) {
      throw new V3ContractViolation('v3 context/budget: section.category 重复：' + section.category)
    }
    seen.add(section.category)
    if (!SECTION_PRIORITIES.includes(section.priority)) {
      throw new V3ContractViolation('v3 context/budget: section.priority 必须是 structural/protected/soft 之一')
    }
    if (!Number.isInteger(section.chars) || section.chars < 0) {
      throw new V3ContractViolation('v3 context/budget: section.chars 必须是非负整数')
    }
  }

  // ⑥ 租约：活跃租约的 soft 段晋升 protected（不改变优先级封闭集，只提升本段）
  const promoted = []
  const effective = sections.map((section) => {
    if (section.priority === 'soft' && now !== null && Number.isFinite(section.leaseUntil) && section.leaseUntil > now) {
      promoted.push(section.category)
      return { ...section, priority: 'protected' }
    }
    return section
  })

  const included = []
  const excluded = []
  let used = 0

  // 无生产方的类目整类摘除（可见，不静默）
  const produced = effective.filter((s) => {
    if (s.producer !== true) {
      excluded.push({ category: s.category, reason: 'no-producer' })
      return false
    }
    return true
  })

  // structural：无条件保留；装不下如实标 structuralOverflow（不静默裁空）
  for (const s of produced.filter((x) => x.priority === 'structural')) {
    included.push(s.category)
    used += s.chars
  }
  const structuralChars = used
  const structuralOverflow = structuralChars > budgetChars

  // protected：结构性保护段，在 structural 之后优先装填；装不下的如实拒绝
  for (const s of produced.filter((x) => x.priority === 'protected')) {
    if (used + s.chars <= budgetChars) {
      included.push(s.category)
      used += s.chars
    } else {
      excluded.push({ category: s.category, reason: 'over-budget' })
    }
  }

  // soft：填余量；超额时丢最旧保最新（D-13）
  const soft = produced.filter((x) => x.priority === 'soft')
  const kept = new Set()
  let softUsed = 0
  for (let i = soft.length - 1; i >= 0; i -= 1) {
    const s = soft[i]
    if (used + softUsed + s.chars <= budgetChars) {
      kept.add(s.category)
      softUsed += s.chars
      continue
    }
    // 「丢最旧保最新」= 只保留**后缀**（H-22）：一旦某段装不下，比它更旧的段也一律丢弃。
    // 旧实现只 continue 跳过装不下的段、继续往前装更旧的段，于是「最新段太大」时
    // 结果恰好相反——丢掉刚发出的、保住最旧的，正是 D-13 记录过的 v2 老毛病。
    break
  }
  for (const s of soft) {
    if (kept.has(s.category)) included.push(s.category)
    else excluded.push({ category: s.category, reason: 'over-budget' })
  }
  used += softUsed

  return { included, excluded, usedChars: used, budgetChars, structuralOverflow, promotedByLease: promoted }
}
