/**
 * 读租约的纯合并规则（domain/session，0.15.0 R08 在入口侧的消费方）。
 *
 * ## 为什么单独成文件
 * 租约有两个**必须同时成立**的约束，而它们都不是「写一个数组」那么简单：
 * 1. **只加实际呈现的记录**（R02）——搜索到 10 条、真正进了正文的 2 条，租约也只能是这 2 条；
 *    旧实现给全部候选加租约，按步归档的软边界被没进过上下文的记录钉住。
 * 2. **合并而不是覆盖**（R08）——并发两次读各自基于旧快照时，后者不得把前者刚加的行整份冲掉；
 *    已经存在的行也不得被缩短到期时间（T 并发写入更晚的 TTL，后到的短 TTL 不能把它拉早）。
 *
 * 合并必须发生在会话跨进程写锁**内**（由 updateSessionState 的 updater 提供），本文件只负责
 * 「给定当前行 + 本次新增 → 下一组行」，不做 IO、不读时钟（now/ttlMs 由调用方给）。
 *
 * ## 已知边界
 * - 租约是**软边界与观测**，不是并发安全的分布式锁；真正的互斥由写锁提供。
 * - 条数上界（READ_LEASE_MAX）沿用旧实现；被裁掉的是最快要过期的行——过期的本来就不再生效。
 */

/** 租约行数上界（与旧实现一致）。 */
export const READ_LEASE_MAX = 200

/**
 * 合并读租约行。
 *
 * @param {Array<{recordId?: string, expiresAt?: number}>|null|undefined} rows 锁内读到的当前行
 * @param {string[]} recordIds 本次**实际呈现**的记录 ID
 * @param {{now?: number, ttlMs?: number, max?: number}} [options]
 * @returns {{rows: Array<{recordId: string, expiresAt: number}>, changed: boolean}}
 */
export function mergeReadLeaseRows(rows, recordIds, { now = Date.now(), ttlMs = 5 * 60 * 1000, max = READ_LEASE_MAX } = {}) {
  const wanted = Array.isArray(recordIds) ? recordIds.filter((id) => typeof id === 'string' && id.length > 0) : []
  const live = []
  const byId = new Map()
  for (const row of Array.isArray(rows) ? rows : []) {
    const id = row?.recordId
    const at = row?.expiresAt
    if (typeof id !== 'string' || id.length === 0) continue
    if (!Number.isFinite(at) || at <= now) continue // 过期行不再生效，顺带清掉
    const prev = byId.get(id)
    if (prev !== undefined && prev >= at) continue // 同 ID 多行：留最晚的一条
    byId.set(id, at)
  }
  let changed = false
  const target = now + ttlMs
  for (const id of wanted) {
    const prev = byId.get(id)
    // **只延长不缩短**：并发方写入了更晚的到期时间时，本次保留更晚的那个。
    if (prev === undefined || target > prev) {
      byId.set(id, target)
      changed = true
    }
  }
  // 当前行里被清掉的过期行也算一次变化（否则过期行会永远留在文件里）。
  const before = (Array.isArray(rows) ? rows : []).filter((row) => typeof row?.recordId === 'string').length
  if (byId.size !== before) changed = true
  for (const [recordId, expiresAt] of byId) live.push({ recordId, expiresAt })
  // 超上界裁掉最快要过期的行（过期的本来就不再生效，丢它们不影响保护面）。
  live.sort((a, b) => a.expiresAt - b.expiresAt)
  const bounded = live.length > max ? live.slice(live.length - max) : live
  if (bounded.length !== live.length) changed = true
  // 输出顺序固定：先按到期时间再按 ID 排序，保证同一状态两次写入逐字节相同（确定性纪律）。
  bounded.sort((a, b) => (a.expiresAt - b.expiresAt) || (a.recordId < b.recordId ? -1 : (a.recordId > b.recordId ? 1 : 0)))
  return { rows: bounded, changed }
}
