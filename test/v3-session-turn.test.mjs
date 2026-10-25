/**
 * v3 domain/session 回合判定测试（M1，P3 地基）。
 *
 * ## 判据来源
 * 《开发计划-v3》P3（一次性内容按真实用户回合计数 + 会话分桶，命中只出现一步）、
 * §1.1（插件注入的 user/message 不是真实用户回合）。
 *
 * ## 断言组
 * - 插件自有 source.kind 的 user 事件不推进回合；真实用户事件推进；
 * - turn 0（用户未发声前）不允许任何注入；
 * - 同回合同 category 二次注入被 oncePerTurnGate 拒，异回合放行；seen 不可变。
 *
 * ## 不适用条件与已知边界
 * 纯函数折叠；事件到达顺序与时序属 M3 事件流水线。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { isRealUserEvent, nextTurnState, oncePerTurnGate } from '../src/v3/domain/session/turn.mjs'

const OWN = ['dsh-memory-context-lab']

function userEvent(sourceKind = 'dsh') {
  return { id: 'e1', type: 'user', sessionKey: 's1', at: 1, source: { kind: sourceKind, form: null } }
}

test('真实用户 = type user 且非插件自有来源；插件注入不算', () => {
  assert.equal(isRealUserEvent(userEvent('dsh'), OWN), true)
  assert.equal(isRealUserEvent(userEvent('dsh-memory-context-lab'), OWN), false)
  assert.equal(isRealUserEvent({ ...userEvent(), type: 'assistant' }, OWN), false)
})

test('回合折叠：真实用户开新回合，其余计入当前回合；不修改入参', () => {
  let state = { turn: 0, eventsInTurn: 0 }
  state = nextTurnState(state, userEvent(), OWN)
  assert.deepEqual(state, { turn: 1, eventsInTurn: 1 })
  state = nextTurnState(state, { type: 'tool-call', source: { kind: 'dsh' } }, OWN)
  assert.deepEqual(state, { turn: 1, eventsInTurn: 2 })
  state = nextTurnState(state, userEvent('dsh-memory-context-lab'), OWN)
  assert.deepEqual(state, { turn: 1, eventsInTurn: 3 }, '插件注入不推进回合')
  state = nextTurnState(state, userEvent(), OWN)
  assert.deepEqual(state, { turn: 2, eventsInTurn: 1 })
})

test('一次性闸门：同回合同 category 只放行一次；异回合放行；seen 不可变', () => {
  let g = oncePerTurnGate(new Set(), 's1', 1, 'turn-reminder')
  assert.equal(g.emit, true)
  const again = oncePerTurnGate(g.seen, 's1', 1, 'turn-reminder')
  assert.equal(again.emit, false, '同回合同类别第二次必须拒（P3 命中只出现一步）')
  const otherTurn = oncePerTurnGate(g.seen, 's1', 2, 'turn-reminder')
  assert.equal(otherTurn.emit, true, '新回合放行')
  const otherCategory = oncePerTurnGate(g.seen, 's1', 1, 'recall-injection')
  assert.equal(otherCategory.emit, true, '同回合异类别放行')
  assert.equal(g.seen.size, 1, '原 seen 不被修改')
})

test('turn 0 不允许注入；非法输入失败关闭', () => {
  assert.throws(() => oncePerTurnGate(new Set(), 's1', 0, 'x'), (e) => e?.name === 'V3ContractViolation' && /turn 必须 ≥1/.test(e.message))
  assert.throws(() => isRealUserEvent(null, OWN), (e) => e?.name === 'V3ContractViolation')
  assert.throws(() => isRealUserEvent(userEvent(), 'not-array'), (e) => e?.name === 'V3ContractViolation')
})
