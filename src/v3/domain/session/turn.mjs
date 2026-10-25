/**
 * 回合判定（domain/session 纯函数，M1）：真实用户回合计数 + 会话分桶（P3——
 * 提醒、回注包、槽位更新按真实用户回合计数，命中只出现一步）。
 *
 * 「真实用户」判据：type === 'user' 且 source.kind 不在插件自有来源集合内——
 * 插件自己注入的 user/message（source.kind = 包名）不推进回合（v2 实证：注入
 * 累积的成因之一就是把插件注入当成了新回合）。
 */
import { V3ContractViolation } from '../../contracts/errors.mjs'

/**
 * 判定事件是否真实用户事件。
 * @param {object} event 归一化事件（形状见 contracts/events.mjs）
 * @param {string[]} ownSourceKinds 插件自有 source.kind 集合（注入方身份，调用方注入）
 */
export function isRealUserEvent(event, ownSourceKinds) {
  if (event === null || typeof event !== 'object') {
    throw new V3ContractViolation('v3 session/turn: event 必须是对象')
  }
  if (!Array.isArray(ownSourceKinds) || ownSourceKinds.some((k) => typeof k !== 'string')) {
    throw new V3ContractViolation('v3 session/turn: ownSourceKinds 必须是字符串数组')
  }
  const kind = event?.source?.kind
  return event.type === 'user' && typeof kind === 'string' && !ownSourceKinds.includes(kind)
}

/**
 * 回合状态折叠：逐事件推进 { turn, eventsInTurn }。
 * 真实用户事件开新回合（turn + 1、eventsInTurn 归 1）；其余事件计入当前回合。
 * 初始状态 turn = 0（尚未出现任何真实用户事件——一切注入都不得在 turn 0 发生，
 * 否则模型在见到用户之前就被塞了内容）。
 *
 * @returns {{ turn: number, eventsInTurn: number }} 新状态（不修改入参）
 */
export function nextTurnState(state, event, ownSourceKinds) {
  const base = state ?? { turn: 0, eventsInTurn: 0 }
  if (typeof base.turn !== 'number' || typeof base.eventsInTurn !== 'number') {
    throw new V3ContractViolation('v3 session/turn: state 必须含 turn/eventsInTurn 数值')
  }
  if (isRealUserEvent(event, ownSourceKinds)) {
    return { turn: base.turn + 1, eventsInTurn: 1 }
  }
  return { turn: base.turn, eventsInTurn: base.eventsInTurn + 1 }
}

/**
 * P3 一次性闸门：同一 (sessionKey, turn, category) 只放行一次。
 * 「命中只出现一步」的结构保证——同一回合内第二次同类注入被拒。
 *
 * @param {Set<string>} seen 已放行键集合（不可变使用：返回新 Set）
 * @returns {{ emit: boolean, seen: Set<string> }}
 */
export function oncePerTurnGate(seen, sessionKey, turn, category) {
  if (!(seen instanceof Set)) {
    throw new V3ContractViolation('v3 session/turn: seen 必须是 Set')
  }
  if (typeof sessionKey !== 'string' || sessionKey.length === 0) {
    throw new V3ContractViolation('v3 session/turn: sessionKey 必须是非空字符串')
  }
  if (!Number.isInteger(turn) || turn < 1) {
    throw new V3ContractViolation('v3 session/turn: turn 必须 ≥1（turn 0 不允许注入）')
  }
  if (typeof category !== 'string' || category.length === 0) {
    throw new V3ContractViolation('v3 session/turn: category 必须是非空字符串')
  }
  const key = JSON.stringify([sessionKey, turn, category])
  if (seen.has(key)) return { emit: false, seen }
  const next = new Set(seen)
  next.add(key)
  return { emit: true, seen: next }
}
