/**
 * 回注租约、来源身份与宿主确认记账（domain/session，0.15.0 R04 候选）。
 *
 * ## 缺陷（P0 红色基线 R04）
 * 旧实现的「同回合同类回注只一次」是 `oncePerTurnGate(seen, ...)`：闸门在**取数之前**
 * 就把 (session, turn, category) 记进 seen。于是下面这些「其实什么都没呈现」的结局都
 * 消耗掉了本回合唯一一次机会：读取暂败、纯壳、装包超顶、next() 非 enter、取消、
 * 交给宿主后提交失败。
 *
 * ## 判据（开发流程 §7.1 / §7.2 R04）
 * - once-per-turn 拆成 **reserve / handoff / confirm / release**；
 * - 只有**宿主事件确认呈现**之后才算成功（`confirm`）；
 * - 读取/装包/取消/非 enter/宿主提交失败都可同轮重试；
 * - 并发时最多一次成功呈现；
 * - 「有限 pending 不永久吞同轮」：handoff 后一个对账窗口内没有宿主事件证据，就按
 *   **未确认**释放（计数可见），而不是永久占住本回合。
 *
 * ## 三个边界必须分开（不得混同）
 * 1. `session.append` 提交 ＝ 宿主**事件**已存在（内存 surface / append-only 日志）；
 * 2. JSONL **耐久** ＝ 另一条异步批路径（`dsh-session-persistence-jsonl` 的 flush）；
 * 3. 本文件的 `confirm` 只表示第 1 条：看到宿主事件。**不声称已落盘**。
 *
 * ## 为什么 reserve 仍然必要
 * 两个 pre-step 并发跑同一回合时，若只在「呈现成功后」才检查闸门，两边都会先注入、
 * 再各自提交——同回合会出现两份回注包。「最多一次成功呈现」需要占位：先 reserve，
 * 占不到就放弃本次；reserve 之后任何不呈现的路径都必须按 owner 令牌释放。
 *
 * ## 边界（诚实说明）
 * - 全部为**进程内**状态；跨进程并发不在本层承诺（仍由宿主 pre-step 串行语义兜底）。
 * - 来源 ID 的保留路径（`message.id` / `source.messageId`）**未经真实宿主验证**：
 *   P0 宿主合同只核到「decision.messages → user/message append」，未核到 id 保留。
 *   因此确认面同时接受「插件 recall 来源事件里的 messageId」与「同一事件正文里我们写入的
 *   bodyId」，两者都要求 `type=user/message` + `source.kind=插件` + `source.form=recall`；
 *   普通用户消息、工具结果、日志引用相同文本**一律不确认**。
 */

/** 租约表容量上界。**满时拒绝新 reserve（可见、可重试），绝不淘汰仍在飞的条目**。 */
export const RECALL_PENDING_WINDOW = 32

/** 回注租约的类别键（跨模块共用一处，不要在别处再写字面量）。 */
export const RECALL_GATE_CATEGORY = 'recall-injection'

/** (session, turn, category) 的唯一键。 */
export function recallTurnKeyOf(sessionKey, turn) {
  return JSON.stringify([sessionKey, turn, RECALL_GATE_CATEGORY])
}

/**
 * 回注租约登记（进程内）。
 *
 * 状态机（每次转移都必须携带**创建它的 owner 令牌**）：
 *
 * ```text
 * absent --reserve(owner)--> pending --handoff(owner,msg)--> handed-off --confirm(owner)--> confirmed
 *                               |                                  |
 *                               +--release(owner)--> absent         +--forget(owner)--> absent（未确认/撤回）
 * ```
 *
 * owner 为 null 时只和 null 匹配：调用方不传令牌就**不能**动别人的占位
 * （并发败方拿到 `busy` 后凭 null 清掉胜方占位，是同回合双注入的另一半）。
 */
export function createRecallLeaseRegistry({ cap = RECALL_PENDING_WINDOW } = {}) {
  const entries = new Map() // key → { state, owner, anchor, messageId, bodyId, recordIds, turn, at }

  function keyOf(sessionKey, turn) {
    return recallTurnKeyOf(sessionKey, turn)
  }

  function stateOf(sessionKey, turn) {
    if (!Number.isInteger(turn) || turn < 1) return 'absent'
    return entries.get(keyOf(sessionKey, turn))?.state ?? 'absent'
  }

  function owned(key, owner) {
    const held = entries.get(key)
    if (held === undefined) return { ok: false, reason: 'not-reserved' }
    // 严格相等：owner=null 只匹配「创建时也没给 owner」的条目。
    if (held.owner !== owner) return { ok: false, reason: 'not-owner' }
    return { ok: true, held }
  }

  /** 同一会话进入新回合后，旧回合的 confirmed 去重键不再需要（宿主 turn 单调）。 */
  function pruneConfirmed(sessionKey, turn) {
    if (!Number.isInteger(turn)) return 0
    let pruned = 0
    for (const [key, held] of entries) {
      if (held.state !== 'confirmed') continue
      // 键是 [session, turn, category] 的 JSON；**必须解析**再比会话，
      // 不能用 '["s"]' 前缀（"[\"s\",1,...]" 不以它开头，剪枝会永远不生效）。
      let parsed
      try { parsed = JSON.parse(key) } catch { continue }
      if (parsed[0] !== String(sessionKey)) continue
      if (Number.isInteger(parsed[1]) && parsed[1] < turn) {
        entries.delete(key)
        pruned += 1
      }
    }
    return pruned
  }

  function reserve(sessionKey, turn, { owner = null } = {}) {
    if (!Number.isInteger(turn) || turn < 1) return { reserved: false, reason: 'invalid-turn' }
    const key = keyOf(sessionKey, turn)
    const held = entries.get(key)
    if (held?.state === 'confirmed') return { reserved: false, reason: 'confirmed' }
    if (held !== undefined) return { reserved: false, reason: held.state }
    // 同会话进入新回合：旧回合的 confirmed 键是结构上过期的（宿主 turn 单调），可清；
    // 同回合的 confirmed 仍必须拒绝（once-per-turn），别会话的条目一律不动。
    pruneConfirmed(sessionKey, turn)
    // **容量满时拒绝新 reserve**，绝不淘汰仍在飞的条目（淘汰会把别的会话的 pending/
    // handed-off 身份抹掉，导致它的 step/end 收敛不到、confirmed 去重也丢失）。
    // 拒绝是可见、可重试的：调用方拿到 capacity 后下一步再试。
    if (entries.size >= cap) return { reserved: false, reason: 'capacity' }
    entries.set(key, { state: 'pending', owner, anchor: null, messageId: null, bodyId: null, recordIds: [], turn, at: Date.now() })
    return { reserved: true, owner }
  }

  /** 交给宿主（消息已进 decision.messages）。**不是**成功，只是进入待确认。 */
  function handoff(sessionKey, turn, { owner = null, messageId = null, bodyId = null, recordIds = [] } = {}) {
    if (!Number.isInteger(turn) || turn < 1) return { handedOff: false, reason: 'invalid-turn' }
    const key = keyOf(sessionKey, turn)
    const check = owned(key, owner)
    if (!check.ok) return { handedOff: false, reason: check.reason }
    if (check.held.state !== 'pending') return { handedOff: false, reason: 'state-' + check.held.state }
    check.held.state = 'handed-off'
    check.held.messageId = typeof messageId === 'string' ? messageId : null
    check.held.bodyId = typeof bodyId === 'string' ? bodyId : null
    check.held.recordIds = Array.isArray(recordIds) ? recordIds.filter((id) => typeof id === 'string') : []
    check.held.at = Date.now()
    return { handedOff: true }
  }

  /** 宿主事件确认呈现（唯一会进入 confirmed 的转移）。 */
  function confirm(sessionKey, turn, { owner = null } = {}) {
    if (!Number.isInteger(turn) || turn < 1) return { confirmed: false, reason: 'invalid-turn' }
    const key = keyOf(sessionKey, turn)
    const check = owned(key, owner)
    if (!check.ok) return { confirmed: false, reason: check.reason }
    if (check.held.state !== 'handed-off') return { confirmed: false, reason: 'state-' + check.held.state }
    check.held.state = 'confirmed'
    return { confirmed: true }
  }

  /** 归还占位（只对 pending；handed-off 要走 confirm/forget）。 */
  function release(sessionKey, turn, { owner = null } = {}) {
    if (!Number.isInteger(turn) || turn < 1) return { released: false, reason: 'invalid-turn' }
    const key = keyOf(sessionKey, turn)
    const check = owned(key, owner)
    if (!check.ok) return { released: false, reason: check.reason }
    if (check.held.state !== 'pending') return { released: false, reason: 'state-' + check.held.state }
    entries.delete(key)
    return { released: true }
  }

  /** 撤销（pending/handed-off/confirmed 都清，owner 必须匹配）。 */
  function forget(sessionKey, turn, { owner = null } = {}) {
    if (!Number.isInteger(turn) || turn < 1) return { forgotten: false, reason: 'invalid-turn' }
    const key = keyOf(sessionKey, turn)
    const check = owned(key, owner)
    if (!check.ok) return { forgotten: false, reason: check.reason }
    const state = check.held.state
    entries.delete(key)
    return { forgotten: true, state }
  }

  /** 待确认（handed-off）条目快照：对账窗口用。 */
  function handoffs(sessionKey = null) {
    const out = []
    for (const [key, held] of entries) {
      if (held.state !== 'handed-off') continue
      const parsed = JSON.parse(key)
      if (sessionKey !== null && parsed[0] !== String(sessionKey)) continue
      out.push({
        key,
        turn: parsed[1],
        owner: held.owner,
        messageId: held.messageId,
        bodyId: held.bodyId,
        recordIds: [...held.recordIds],
        at: held.at,
      })
    }
    return out
  }

  /** 已确认键列表（诊断/测试用；排序后返回，保证确定性）。 */
  function committedKeys() {
    return [...entries].filter(([, held]) => held.state === 'confirmed').map(([key]) => key).sort()
  }

  function stats() {
    let pending = 0
    let handedOff = 0
    let confirmed = 0
    for (const held of entries.values()) {
      if (held.state === 'pending') pending += 1
      else if (held.state === 'handed-off') handedOff += 1
      else confirmed += 1
    }
    return { pending, handedOff, confirmed, size: entries.size, cap }
  }

  return { stateOf, reserve, handoff, confirm, release, forget, handoffs, committedKeys, pruneConfirmed, stats }
}

/**
 * 一次回注包的稳定身份（同一查询 + 同一命中集合 + 同一回合 → 同一 bodyId）。
 *
 * 只依赖入参，不读时钟/随机：同输入必同输出（确定性纪律）。
 * @param {{sessionKey: string, turn: number, query: string, ids: string[]}} input
 */
export function recallBodyIdOf({ sessionKey, turn, query, ids } = {}) {
  const session = String(sessionKey ?? '')
  const text = String(query ?? '')
  const list = Array.isArray(ids) ? ids.filter((id) => typeof id === 'string') : []
  // 32 位 FNV-1a：够短、够稳定、不依赖 node:crypto（application/domain 不持有随机源）。
  let hash = 0x811c9dc5
  const feed = (s) => {
    for (let i = 0; i < s.length; i += 1) {
      hash ^= s.charCodeAt(i)
      hash = Math.imul(hash, 0x01000193) >>> 0
    }
    hash ^= 0x1f
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  feed(session)
  feed(String(Number.isInteger(turn) ? turn : 0))
  feed(text)
  for (const id of list) feed(id)
  return 'v3rl-' + hash.toString(16).padStart(8, '0')
}

/** 未呈现的释放原因（可观测口径；调用方据此计数与告警）。 */
export const RECALL_RELEASE_REASONS = Object.freeze([
  'empty-query',
  'no-session',
  'busy',
  'invalid-turn',
  'invalid-args',
  'search-failed',
  'read-failed',
  'empty-pack',
  'all-unreadable',
  'pack-over-cap',
  'not-entered',
  'next-threw',
  'recall-failed',
  'not-presented',
  'host-commit-failed',
  'unconfirmed',
])

/** 归一释放原因：未知值归 'not-presented'（不抛错——释放路径必须永远能走完）。 */
export function normalizeReleaseReason(reason) {
  return RECALL_RELEASE_REASONS.includes(reason) ? reason : 'not-presented'
}
