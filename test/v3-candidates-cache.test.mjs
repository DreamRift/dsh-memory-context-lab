/**
 * B3-8（AUD50-04-03）归档选择不再每步全量扫事件——append-only 日志按「数组身份+长度」
 * 增量缓存（bySeq/turnAt）。判据用结构断言（缓存画像），不用脆弱计时：
 * - 功能等价：缓存路径与全量重建路径的分组/选择结果一致；
 * - 同数组连续调用：builds 不增、只 merge 新增段（mergedEvents 增量 = 新增事件数，
 *   而不是全量长度——「不随历史线性变慢」的结构口径）；
 * - 数组变短（替身复用）全量重建且结果正确。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { groupSurfaceOperations, selectArchiveSpan, _candidatesCacheStats, _resetCandidatesCacheStats } from '../src/v3/domain/archive/candidates.mjs'

function makeEvents(count) {
  const events = [
    { seq: 0, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'do' }] } },
    { seq: 1, type: 'step/start', data: { turn: 1, step: 1 } },
  ]
  for (let i = 2; i < count; i += 1) {
    events.push(i % 2 === 0
      ? { seq: i, type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } } }
      : { seq: i, type: 'tool/result', data: { message: { role: 'tool', toolCallId: 'c', content: [{ type: 'text', text: 'r' }] } } }
    )
  }
  return events
}

const SURFACE = [0, 2, 3, 4, 5, 6, 7];

test('B3-8 功能等价：缓存路径与全量重建结果一致（human 与 dsh）', () => {
  _resetCandidatesCacheStats()
  const events = makeEvents(50)
  const cachedHuman = groupSurfaceOperations({ surfaceNodes: SURFACE, events })
  const freshHuman = groupSurfaceOperations({ surfaceNodes: SURFACE, events: [...events] })
  assert.deepEqual(cachedHuman, freshHuman, 'human 分组一致')
  const cachedDsh = groupSurfaceOperations({ surfaceNodes: SURFACE, events, turnBasis: 'dsh' })
  const freshDsh = groupSurfaceOperations({ surfaceNodes: SURFACE, events: [...events], turnBasis: 'dsh' })
  assert.deepEqual(cachedDsh, freshDsh, 'dsh 分组一致（含 turn 投影）')
  const spanA = selectArchiveSpan({ surfaceNodes: SURFACE, events, hasRecord: () => true, mode: 'full-history' })
  const spanB = selectArchiveSpan({ surfaceNodes: SURFACE, events: [...events], hasRecord: () => true, mode: 'full-history' })
  assert.deepEqual(spanA, spanB, '选择结果一致')
})

test('B3-8 结构断言：同数组命中缓存，新增只合并增量段', () => {
  _resetCandidatesCacheStats()
  const events = makeEvents(200)
  groupSurfaceOperations({ surfaceNodes: SURFACE, events })
  const afterFirst = _candidatesCacheStats()
  assert.equal(afterFirst.builds, 1)
  // 同数组第二次调用：命中，零重建零合并
  groupSurfaceOperations({ surfaceNodes: SURFACE, events })
  const afterSecond = _candidatesCacheStats()
  assert.equal(afterSecond.builds, afterFirst.builds, '同数组不重建')
  assert.equal(afterSecond.hits, afterFirst.hits + 1)
  assert.equal(afterSecond.mergedEvents, afterFirst.mergedEvents)
  // append 100 条：只合并 100 条（不随历史长度线性重扫）
  const grown = makeEvents(300)
  events.push(...grown.slice(200))
  groupSurfaceOperations({ surfaceNodes: SURFACE, events })
  const afterThird = _candidatesCacheStats()
  assert.equal(afterThird.mergedEvents, afterSecond.mergedEvents + 100, '只合并新增段')
  // 缓存路径下的选择结果与全量重建仍一致
  assert.deepEqual(
    selectArchiveSpan({ surfaceNodes: SURFACE, events, hasRecord: () => true, mode: 'full-history' }),
    selectArchiveSpan({ surfaceNodes: SURFACE, events: [...events], hasRecord: () => true, mode: 'full-history' }),
  )
})

test('B3-8 数组变短（替身复用）：全量重建且结果正确', () => {
  _resetCandidatesCacheStats()
  const events = makeEvents(60)
  groupSurfaceOperations({ surfaceNodes: SURFACE, events })
  events.splice(30)
  const groups = groupSurfaceOperations({ surfaceNodes: [0, 2, 3], events })
  const fresh = groupSurfaceOperations({ surfaceNodes: [0, 2, 3], events: [...events] })
  assert.deepEqual(groups, fresh, '重建后结果正确')
  assert.ok(_candidatesCacheStats().builds >= 2, '变短触发重建')
})

test('B3-8 大会话基准（证据用）：35k 事件两次调用只重建一次', () => {
  _resetCandidatesCacheStats()
  const events = makeEvents(35000)
  const surface = [];
  for (let i = 0; i < events.length; i += 7) surface.push(i);
  const t0 = process.hrtime.bigint()
  groupSurfaceOperations({ surfaceNodes: surface, events })
  groupSurfaceOperations({ surfaceNodes: surface, events })
  const ms = Number(process.hrtime.bigint() - t0) / 1e6
  const stats = _candidatesCacheStats()
  assert.equal(stats.builds, 1, '第二次调用命中缓存（结构断言为主，计时仅佐证）')
  assert.ok(ms < 500, '两次调用总耗时应远小于旧全量×2（实测 ' + ms.toFixed(1) + 'ms）')
})
