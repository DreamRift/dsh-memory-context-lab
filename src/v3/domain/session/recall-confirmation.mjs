/**
 * 宿主呈现确认（domain/session，0.15.0 R04）。
 *
 * ## 三个边界必须分开（不得混同）
 * 1. `session.append` 提交 ＝ 宿主**事件**已存在（append-only 日志 + 同步 `session/event`）；
 * 2. JSONL **耐久** ＝ 另一条异步批路径（`dsh-session-persistence-jsonl` 的 flush）；
 * 3. 本文件只回答第 1 条：**观察到这条事件**。不声称已持久化。
 *
 * ## 正向证据（可立即确认，不必等 step/end）
 * 宿主 0.2.1-rc.5 源码（`dsh-agent-loop` 1043–1075）把 `decision.messages` 逐条
 * `session.append('user/message', message, {surfaceOp:'append'})`，且 `dsh-session` 在
 * `log.push` 之后**同步**发出 `session/event`。真实 user/message 的形状是
 * **`event.data` 本身就是消息**（`data.id` / `data.source` / `data.content`），
 * 没有 `data.message` 外壳；消息本身不带 turn/step。
 *
 * 因此一条登记被确认必须同时满足：
 * 1. `event.type === 'user/message'`；
 * 2. `event.data.source.kind === 本插件包名` 且 `event.data.source.form === 'recall'`；
 * 3. `event.data.id` 精确等于登记的消息 ID（宿主已核证保留该 id，§2.9）；若同时保留
 *    `data.source.messageId` 必须与 `data.id` 一致，冲突即判不可确认；
 * 4. `event.seq` 是合法非负安全整数且**严格大于**登记时记录的 `seqBase`
 *    （旧事件/继承事件不能把过去的交付认成这一次）。
 *
 * bodyId 仍是包头部里的**内容身份**（诊断/审计），**不参与确认**：另一条合法 recall
 * 引用相同 bodyId 时不能被当成本次交付。
 *
 * 反例（实测必须不确认）：普通用户消息、`tool/result`、其它插件/其它 form 的事件、
 * id 冲突的事件、登记之前就已存在的同 id 事件。
 *
 * ## 负向收敛（只由宿主终止事件驱动）
 * 「没有证据」不能靠时间或窗口推断——判断必须来自结构：
 * - `step/end`（带 turn/step）到达且本登记该 step 已终结、仍未见事件 → 判未交付并释放；
 * - `turn/end` 兜底「preStep 交出后没进入 step」的路径；
 * - `turn/end.reason === 'error'` **不能**推出未交付（可能 append 已成功、只是请求失败）。
 * 超时/窗口淘汰**不得**释放仍在飞的占位（那会把「慢」误判成「失败」）。
 */

/** 插件回注落库形态（宿主 `decision.messages` → user/message）。 */
export const RECALL_EVENT_TYPE = 'user/message'

/** 未收敛登记的防御性上限：只用于告警，**不**用超窗淘汰来释放仍在飞的占位。 */
export const RECALL_CONFIRM_CAP = 256

/**
 * 事件是否「本插件写下的回注包」。
 * @param {object} event 宿主事件（{type, seq, data}）
 * @param {{sourceKind: string, sourceForm: string}} source 期望的来源标识
 */
export function isPluginRecallEvent(event, { sourceKind, sourceForm } = {}) {
  if (event === null || typeof event !== 'object') return false
  if (event.type !== RECALL_EVENT_TYPE) return false
  const data = event.data
  if (data === null || typeof data !== 'object') return false
  const source = data.source
  if (source === null || typeof source !== 'object') return false
  return source.kind === sourceKind && source.form === sourceForm
}

/**
 * 从**已判定为插件回注**的事件里取来源身份。
 *
 * 宿主已核证保留消息 id（P0 宿主合同 §2.9）：以 `data.id` 为准；`data.source.messageId`
 * 若同时保留，必须与 `data.id` **一致**，不一致即视为来源冲突、不得确认（不做「任取其一」）。
 * 不再扫描正文里的 bodyId：另一条合法 recall 引用相同 bodyId 时会被误当成本次交付。
 * bodyId 仍作为**内容身份**保留在包头部（诊断/审计用），但不参与确认。
 *
 * @returns {{ok:true, messageId:string|null} | {ok:false, reason:string}}
 */
export function recallIdentityOfEvent(event) {
  // 已核宿主合同 + 主裁决：身份**必须** data.id。旧外壳（data.message.id）与
  // source.messageId 都只是**一致性**校验，不能代替 data.id——缺 data.id 的事件不确认。
  const direct = typeof event?.data?.id === 'string' && event.data.id.length > 0 ? event.data.id : null
  if (direct === null) return { ok: true, messageId: null }
  const nested = typeof event?.data?.message?.id === 'string' && event.data.message.id.length > 0 ? event.data.message.id : null
  const sourceId = typeof event?.data?.source?.messageId === 'string' && event.data.source.messageId.length > 0
    ? event.data.source.messageId
    : null
  for (const other of [nested, sourceId]) {
    if (other !== null && other !== direct) return { ok: false, reason: 'id-conflict' }
  }
  return { ok: true, messageId: direct }
}

/** 宿主终止事件（turn/step）。 */
export function isStepEndEvent(event) {
  return event?.type === 'step/end'
}

export function isTurnEndEvent(event) {
  return event?.type === 'turn/end'
}

/**
 * 创建确认登记（进程内）。只存 ID 与计数，**不存正文**。
 */
export function createRecallConfirmations({ cap = RECALL_CONFIRM_CAP, now = () => Date.now() } = {}) {
  const rows = []
  let seq = 0
  let confirmed = 0
  let released = 0
  let overflow = 0

  /**
   * 是否有容量再登记一条（同会话进入新回合时，旧回合的登记已不可能再被交付）。
   * 容量满 → 调用方必须**拒绝交接**（不把消息交给宿主），而不是淘汰在飞登记。
   */
  function canAccept({ sessionId = null, turn = null } = {}) {
    pruneOldTurns(sessionId, turn)
    return rows.length < cap
  }

  /** 同会话新回合：旧回合的 pending 结构上已不可能再交付，清掉。 */
  function pruneOldTurns(sessionId, turn) {
    if (sessionId === null || !Number.isInteger(turn)) return 0
    let pruned = 0
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const row = rows[i]
      if (row.sessionId !== String(sessionId)) continue
      if (Number.isInteger(row.turn) && row.turn < turn) {
        rows.splice(i, 1)
        pruned += 1
      }
    }
    if (pruned > 0) released += pruned
    return pruned
  }

  /**
   * 登记一次「已交给宿主、等待事件确认」。
   * @returns {object|null} null = 容量满（调用方必须放弃本次交接）
   */
  function record({ sessionId, turn = null, step = null, messageId = null, bodyId = null, recordIds = [], owner = null, seqBase = null, now: at = now() } = {}) {
    if (!canAccept({ sessionId, turn })) {
      overflow += 1
      return null
    }
    seq += 1
    const row = {
      seq,
      sessionId: String(sessionId ?? ''),
      turn: Number.isInteger(turn) ? turn : null,
      step: Number.isInteger(step) ? step : null,
      messageId: typeof messageId === 'string' ? messageId : null,
      bodyId: typeof bodyId === 'string' ? bodyId : null,
      recordIds: Array.isArray(recordIds) ? recordIds.filter((id) => typeof id === 'string') : [],
      owner,
      seqBase: Number.isInteger(seqBase) ? seqBase : -1,
      at,
    }
    rows.push(row)
    return row
  }

  /** 撤回一条登记（失败路径；按 session+turn 或 bodyId 精确命中）。 */
  function drop({ sessionId = null, turn = null, bodyId = null, messageId = null } = {}) {
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const row = rows[i]
      if (sessionId !== null && row.sessionId !== String(sessionId)) continue
      if (turn !== null && row.turn !== turn) continue
      if (bodyId !== null && row.bodyId !== bodyId) continue
      if (messageId !== null && row.messageId !== messageId) continue
      rows.splice(i, 1)
      return true
    }
    return false
  }

  /**
   * 观察一个宿主事件（正向确认 / 负向收敛）。
   *
   * 新鲜度：只有 `event.seq` 为**合法非负安全整数**且**严格大于**登记时记录的
   * `seqBase` 才算数——否则旧事件（含继承来的同 id 事件）能把「过去的交付」认成这一次。
   * 收敛也只能由**精确匹配**的终止事件驱动：step/end 必须给出合法整数 turn+step 且与登记
   * 完全一致；turn/end 必须给出合法整数 turn。缺字段一律**不放行**（不做通配）。
   *
   * @returns {{confirmed:Array<object>, released:Array<object>}}
   */
  function observe({ sessionId = null, event, sourceKind, sourceForm } = {}) {
    const out = { confirmed: [], released: [] }
    if (event === null || typeof event !== 'object') return out
    const inSession = (row) => sessionId === null || row.sessionId === String(sessionId)
    const eventSeq = event.seq
    const seqValid = Number.isSafeInteger(eventSeq) && eventSeq >= 0
    const fresh = (row) => seqValid && eventSeq > row.seqBase

    if (isPluginRecallEvent(event, { sourceKind, sourceForm })) {
      const identity = recallIdentityOfEvent(event)
      // 来源内部 id 冲突 = 无法判定这条是谁：既不确认也不据此释放。
      if (identity.ok === false) return out
      if (identity.messageId === null) return out
      for (let i = rows.length - 1; i >= 0; i -= 1) {
        const row = rows[i]
        if (!inSession(row)) continue
        if (row.messageId === null || row.messageId !== identity.messageId) continue
        if (!fresh(row)) continue
        rows.splice(i, 1)
        confirmed += 1
        out.confirmed.push(row)
      }
      return out
    }

    if (isStepEndEvent(event)) {
      const data = event.data
      if (data === null || typeof data !== 'object') return out
      const { turn, step } = data
      if (!Number.isInteger(turn) || !Number.isInteger(step)) return out // 缺字段不通配
      for (let i = rows.length - 1; i >= 0; i -= 1) {
        const row = rows[i]
        if (!inSession(row)) continue
        if (row.turn !== turn || row.step !== step) continue
        if (!fresh(row)) continue
        rows.splice(i, 1)
        released += 1
        out.released.push({ ...row, reason: 'step-ended' })
      }
      return out
    }
    if (isTurnEndEvent(event)) {
      const data = event.data
      if (data === null || typeof data !== 'object') return out
      const { turn } = data
      if (!Number.isInteger(turn)) return out
      // reason.kind=error 既不是「未交付」的证明，也不是禁止收敛的理由：
      // 已确认的登记早已移出本表（不会回退）；仍在 pending 的登记在 turn 结束后
      // 不可能再被交付，按未交付释放。
      for (let i = rows.length - 1; i >= 0; i -= 1) {
        const row = rows[i]
        if (!inSession(row)) continue
        if (row.turn !== turn) continue
        if (!fresh(row)) continue
        rows.splice(i, 1)
        released += 1
        out.released.push({ ...row, reason: 'turn-ended' })
      }
    }
    return out
  }

  function snapshot() {
    return rows.map((row) => ({
      sessionId: row.sessionId,
      turn: row.turn,
      step: row.step,
      messageId: row.messageId,
      bodyId: row.bodyId,
      recordIds: [...row.recordIds],
      seqBase: row.seqBase,
      // 刻意不含正文：诊断面只需要 ID/计数（隐私纪律）。
    }))
  }

  function stats() {
    return { confirmed, released, overflow, pending: rows.length }
  }

  return { record, drop, observe, canAccept, pruneOldTurns, snapshot, stats }
}
