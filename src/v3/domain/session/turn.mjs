/**
 * 回合判定（domain/session 纯函数，M1）：真实用户回合计数 + 会话分桶（P3——
 * 提醒、回注包、槽位更新按真实用户回合计数，命中只出现一步）。
 *
 * 「真实用户」判据是宿主对人类输入的约定 `source.kind === 'user'`（dsh-api-session-controller
 * 写入 user/message 时使用），**不是**「kind 不在本插件自有集合内」。
 *
 * 旧口径（`!ownSourceKinds.includes(kind)`）把宿主与其它插件注入的 user 消息也算成人类回合：
 * `runtime-context`（宿主每步追加的运行时上下文，role 仍是 user）、`plan-mode`、`team-message`、
 * `goal`、`subagent-settled` 等二十余种来源都会把 turn 推高。后果是**回合语义错位**：回合计数（当前喂给 metrics 观测，接闸门/槽位后即为账本依据）
 * 与真实人类轮次脱节。注：记录本身不写 turn，影响面仅在计数与将来的账本。
 */
import { V3ContractViolation } from '../../contracts/errors.mjs'
import { HUMAN_SOURCE_KIND } from '../../contracts/sources.mjs'

/** 一次性闸门记忆窗口（键数上界；H-18：见 oncePerTurnGate）。 */
export const GATE_WINDOW = 64

/**
 * 判定事件是否真实用户事件。
 * @param {object} event 归一化事件（形状见 contracts/events.mjs）
 * @param {string[]} ownSourceKinds 插件自有 source.kind 集合（保留入参：调用方仍需声明身份，
 *   但判据不再依赖「非自有即人类」这种否定式推理）
 */
export function isRealUserEvent(event, ownSourceKinds) {
  if (event === null || typeof event !== 'object') {
    throw new V3ContractViolation('v3 session/turn: event 必须是对象')
  }
  if (!Array.isArray(ownSourceKinds) || ownSourceKinds.some((k) => typeof k !== 'string')) {
    throw new V3ContractViolation('v3 session/turn: ownSourceKinds 必须是字符串数组')
  }
  return event.type === 'user' && event?.source?.kind === HUMAN_SOURCE_KIND
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
  // seen 必须**有界**（H-18）：旧实现每次返回「全部历史键 + 新键」的新 Set，键随回合数线性
  // 增长、复制量随回合数平方增长（实测 2 万回合 20000 个键 / 2.0 秒）。回合号在会话内单调
  // 递增，闸门只需要「本回合与近几个回合」的键——按 FIFO 只保留最近 GATE_WINDOW 个。
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
  // FIFO 裁剪：Set 保序，删除最老的键。窗口远大于「一个回合内的类目数」，
  // 因此「同回合同类只一次」的语义不变；被裁掉的都是早已过去的回合。
  while (next.size > GATE_WINDOW) {
    const oldest = next.values().next().value
    next.delete(oldest)
  }
  return { emit: true, seen: next }
}
