/**
 * 归档保护集守卫（M3）：
 * - 当前回合永不归档；
 * - pin / 未完成 tool 对 / 插件回执作为整组硬边界，不能切半个操作；
 * - cooling 保留最近 N 个完成操作。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { selectArchiveSpan } from '../src/v3/domain/archive/candidates.mjs'

function human(seq) {
  return { seq, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'u' + seq }] } }
}
function assistant(seq) {
  return { seq, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'a' + seq }] } } }
}
function toolCall(seq, callId) {
  return { seq, type: 'tool/call', data: { callId, name: 'read', arguments: '{}' } }
}
function plugin(seq) {
  return { seq, type: 'user/message', data: { source: { kind: 'dsh-memory-context-lab' }, content: [{ type: 'text', text: 'r' }] } }
}
function recall(seq) {
  return { seq, type: 'user/message', data: { source: { kind: 'dsh-memory-context-lab', form: 'recall' }, content: [{ type: 'text', text: 'p' }] } }
}

const hasRecord = () => true

test('当前回合不归档；默认最多一个完成操作', () => {
  const events = [human(0), assistant(1), human(2), assistant(3), human(4)]
  const span = selectArchiveSpan({
    surfaceNodes: [0, 1, 2, 3, 4], events, hasRecord, mode: 'full-history', maxOperations: 1,
  })
  assert.deepEqual(span.sourceEventSeqs, [0, 1])
  assert.equal(span.endSeq, 1)
})

test('pin 是整组硬边界：pin 组内任一节点 → 该组及之后都不归档（不切半个操作）', () => {
  const events = [human(0), assistant(1), human(2), assistant(3), human(4)]
  const span = selectArchiveSpan({
    surfaceNodes: [0, 1, 2, 3, 4], events, hasRecord, mode: 'full-history', maxOperations: 2,
  })
  assert.equal(span.endSeq, 3, '先确认两个完成操作都可选')
  const pinned = selectArchiveSpan({
    surfaceNodes: [0, 1, 2, 3, 4], events, hasRecord, mode: 'full-history', maxOperations: 2, pinnedSeqs: new Set([1]),
  })
  assert.equal(pinned, null, '第一组含 pin → 不返回半组')
})

test('未完成 tool 对是硬边界；插件回执也是硬边界', () => {
  const unfinished = [human(0), toolCall(1, 'c1'), human(2)]
  assert.equal(selectArchiveSpan({
    surfaceNodes: [0, 1, 2], events: unfinished, hasRecord, mode: 'full-history', maxOperations: 2,
  }), null, 'tool/call 无 result：整组不归档')

  const withPlugin = [human(0), plugin(1), human(2)]
  assert.equal(selectArchiveSpan({
    surfaceNodes: [0, 1, 2], events: withPlugin, hasRecord, mode: 'full-history', maxOperations: 2,
  }), null, '插件回执所在组不归档')
})

test('回注包不是归档边界：随 span 一起遮蔽，但不进 recordSeqs', () => {
  // 真实会话 e43c4864 的形态：每个有命中的回合开头都有回注包（无 v3 记录）。
  // 旧实现把它当插件硬边界 + 要求记录 → 第一次回注之后归档永久停摆。
  const events = [human(0), recall(1), assistant(2), human(3)]
  const span = selectArchiveSpan({
    surfaceNodes: [0, 1, 2, 3],
    events,
    hasRecord: (seq) => seq !== 1,
    mode: 'full-history',
    maxOperations: 2,
  })
  assert.ok(span, '含回注包的完成回合必须还能归档')
  assert.deepEqual(span.sourceEventSeqs, [0, 1, 2], '遮蔽区间仍是连续的整组（宿主 range replace 的硬前提）')
  assert.deepEqual(span.recordSeqs, [0, 2], '回注包没有记录：不能进 recordSeqs（否则回执/恢复会对不上）')
})

test('整组扣掉回注包后没有记录 → 仍不归档（不做不可恢复的遮蔽）', () => {
  const events = [human(0), recall(1), human(2)]
  assert.equal(selectArchiveSpan({
    surfaceNodes: [0, 1, 2],
    events,
    hasRecord: () => false,
    mode: 'full-history',
    maxOperations: 2,
  }), null)
})

test('cooling 保留最近 N 个完成操作', () => {
  const events = [human(0), assistant(1), human(2), assistant(3), human(4), assistant(5), human(6)]
  const all = selectArchiveSpan({
    surfaceNodes: [0, 1, 2, 3, 4, 5, 6], events, hasRecord, mode: 'cooling', retainOperations: 1, maxOperations: 10,
  })
  assert.deepEqual(all.sourceEventSeqs, [0, 1, 2, 3], '三个完成操作保留最后一个，归档前两个')
})