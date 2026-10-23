/**
 * 停摆区间的**唯一解除入口**（Y-05，beta.7）。
 *
 * 问题：apply-engine 在重试达上界后把区间写进 `state.parkedRanges`，而
 * `selectCandidates` 用它做硬过滤。全仓没有任何地方删这个键，于是「停摆」实际等于
 * 「永久退出候选」；而回执又提示「解除用 /memory-lab now」——那条命令根本不看
 * parkedRanges，是**假出路**。
 *
 * 结构原因：解除动作被当成「某个调用点顺手清一下」，而不是协议的一部分。
 * 现在把解除收成一个函数，任何「重试 / 手动触发」路径都必须走它；
 * 新增第二条触发路径时，不会再有「忘了清」这种可能。
 */
export function unparkRanges(record) {
  const parked = record?.state?.parkedRanges
  if (!parked || typeof parked !== 'object') return 0
  const count = Object.keys(parked).length
  if (count === 0) return 0
  record.state.parkedRanges = {}
  return count
}
