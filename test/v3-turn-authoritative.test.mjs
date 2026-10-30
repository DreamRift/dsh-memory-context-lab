/**
 * B3-12（AUD50-05-02）按轮归档不再晚一个 step——turn/start 在日志里时日志是权威：
 * 当前轮 = max(payload.turn, lastTurn)。新轮首步宿主 payload.turn 滞后也立即归档上一轮；
 * payload 超前一轮（当前轮刚开）照旧立即归档；超前两轮以上 / 无 payload.turn 保守回退；
 * 滞后不得误压（beta.49 守卫）不回退。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { groupSurfaceOperations } from '../src/v3/domain/archive/candidates.mjs'

function turnEvents() {
  const events = [];
  let seq = 0;
  const push = (type, data) => events.push({ seq: seq++, type, data });
  const turn = (n, seqs) => {
    push('turn/start', { turn: n });
    for (const s of seqs) push(s.type, s.data);
    push('turn/end', { turn: n });
  };
  return { events, push, turn };
}

function surfaceOf(events, types = ['user/message', 'assistant/message']) {
  return events.filter((e) => types.includes(e.type)).map((e) => e.seq);
}

test('B3-12 新轮首步：payload.turn 滞后也立即把上一轮判为已完成', () => {
  const { events, turn } = turnEvents();
  turn(1, [{ type: 'user/message', data: { source: { kind: 'user' } } }, { type: 'assistant/message', data: {} }]);
  turn(2, [{ type: 'user/message', data: { source: { kind: 'user' } } }, { type: 'assistant/message', data: {} }]);
  turn(3, [{ type: 'user/message', data: { source: { kind: 'user' } } }]);
  const groups = groupSurfaceOperations({ surfaceNodes: surfaceOf(events), events, turnBasis: 'dsh', currentTurn: 2 });
  const byTurn = new Map(groups.map((g) => [g.turn, g.current]));
  assert.equal(byTurn.get(1), false, '第 1 轮已完成可归档')
  assert.equal(byTurn.get(2), false, '滞后不拖：日志已在第 3 轮，第 2 轮立即完成（旧口径晚一步）')
  assert.equal(byTurn.get(3), true, '第 3 轮是当前轮（日志权威）')
})

test('B3-12 守卫不回退：payload 超前一轮照旧；超前两轮以上与无 payload 保守回退', () => {
  const { events, turn } = turnEvents();
  turn(1, [{ type: 'user/message', data: { source: { kind: 'user' } } }, { type: 'assistant/message', data: {} }]);
  turn(2, [{ type: 'user/message', data: { source: { kind: 'user' } } }, { type: 'assistant/message', data: {} }]);
  const surface = surfaceOf(events)
  // 超前一轮（当前轮刚开、turn/start 未落日志）：全部已完成，立即可归档
  const ahead = groupSurfaceOperations({ surfaceNodes: surface, events, turnBasis: 'dsh', currentTurn: 3 });
  assert.ok(ahead.every((g) => g.current === false), '超前一轮：没有任何当前轮节点')
  // 超前两轮以上：保守回退（最后一组 = 当前轮）
  const wayAhead = groupSurfaceOperations({ surfaceNodes: surface, events, turnBasis: 'dsh', currentTurn: 5 });
  assert.equal(wayAhead[wayAhead.length - 1].current, true, '脱节保守回退（滞后不得误压）')
  assert.equal(wayAhead[0].current, false)
  // 无 payload.turn：保守按最后一组
  const noTurn = groupSurfaceOperations({ surfaceNodes: surface, events, turnBasis: 'dsh' });
  assert.equal(noTurn[noTurn.length - 1].current, true)
  assert.equal(noTurn[0].current, false)
})

test('B3-12 同步：payload 与日志同轮时当前轮不误压', () => {
  const { events, turn } = turnEvents();
  turn(1, [{ type: 'user/message', data: { source: { kind: 'user' } } }, { type: 'assistant/message', data: {} }]);
  turn(2, [{ type: 'user/message', data: { source: { kind: 'user' } } }, { type: 'assistant/message', data: {} }]);
  const groups = groupSurfaceOperations({ surfaceNodes: surfaceOf(events), events, turnBasis: 'dsh', currentTurn: 2 });
  assert.equal(groups[0].current, false, '第 1 轮已完成')
  assert.equal(groups[1].current, true, '第 2 轮当前')
})
