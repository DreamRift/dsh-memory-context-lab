import test from 'node:test'
import assert from 'node:assert/strict'
import { RECALL_RELATIONS, planRecall } from '../src/v3/domain/recall/planner.mjs'

function candidate(overrides = {}) {
  return {
    id: 'v3r-0123456789abcdef', kind: 'record', relation: 'source', text: '正文内容', confidence: 0.9,
    generation: 3, sessionId: 'session-a', sourceVerified: true, permissionVerified: true, forgotten: false,
    ...overrides,
  }
}

function input(overrides = {}) {
  return {
    query: '查询', sessionId: 'session-a', generation: 3, completeness: 'ok', complete: true,
    truncated: false, candidateLimit: 5, maxCodePoints: 100, candidates: [candidate()], followUpHandle: null,
    ...overrides,
  }
}

test('关系封闭集精确等于 P2 §6.1 八值', () => {
  assert.equal(Object.isFrozen(RECALL_RELATIONS), true)
  assert.equal(RECALL_RELATIONS.length, 8)
  assert.deepEqual([...RECALL_RELATIONS], [
    'source', 'evidence', 'supersedes', 'base', 'archive-receipt', 'segment-summary', 'call-pair', 'adjacent',
  ])
})

test('adjacent 只保留相邻关系，不提升为来源或因果', () => {
  const result = planRecall(input({ candidates: [candidate({ id: 'adj-1', relation: 'adjacent' })] }))
  assert.equal(result.citations.length, 1)
  assert.equal(result.citations[0].relation, 'adjacent')
  assert.notEqual(result.citations[0].relation, 'source')
})

// 删除关系枚举校验后该测试必红：未知关系不得被映射或透出。
test('未知关系失败关闭且不产生引用边', () => {
  const result = planRecall(input({ candidates: [candidate({ relation: 'similar_to' })] }))
  assert.equal(result.status, 'unknown')
  assert.deepEqual(result.selected, [])
  assert.deepEqual(result.citations, [])
})

// 删除代际相等校验后该测试必红：旧代际候选不得复用。
test('未知或不匹配代际候选不进入首跳', () => {
  const result = planRecall(input({ candidates: [candidate({ generation: 2 })] }))
  assert.equal(result.status, 'unknown')
  assert.deepEqual(result.selected, [])
})

// 删除来源/权限核验后该测试必红：不可核验材料不泄露正文与来源身份。
test('权限或来源不可核验时无正文及敏感引用', () => {
  const result = planRecall(input({ candidates: [candidate({ permissionVerified: false })] }))
  assert.equal(result.status, 'unknown')
  assert.equal(JSON.stringify(result).includes('正文内容'), false)
  assert.deepEqual(result.citations, [])
})

test('来源不可核验同样失败关闭', () => {
  const result = planRecall(input({ candidates: [candidate({ sourceVerified: false })] }))
  assert.equal(result.selected.length, 0)
  assert.equal(result.status, 'unknown')
})

// 删除空候选完整性处理后该测试必红：没有 EOF 证明不得说已确认为空。
test('候选为空且无完整性证明时为 unknown 而非确认空集', () => {
  const result = planRecall(input({ candidates: [], complete: false, completeness: 'unknown' }))
  assert.equal(result.status, 'unknown')
  assert.equal(result.complete, false)
  assert.equal(result.followUp, null)
})

test('即使完整性证明齐全，空候选也不标 complete', () => {
  const result = planRecall(input({ candidates: [], complete: true, completeness: 'ok' }))
  assert.equal(result.status, 'unavailable')
  assert.equal(result.complete, false)
})

// 删除阈值门后该测试必红：0.49 拒绝、0.5 接受。
test('私有置信阈值边界为 0.5', () => {
  const below = planRecall(input({ candidates: [candidate({ confidence: 0.49 })] }))
  const boundary = planRecall(input({ candidates: [candidate({ confidence: 0.5 })] }))
  assert.equal(below.status, 'unknown')
  assert.equal(below.selected.length, 0)
  assert.equal(boundary.status, 'ok')
  assert.equal(boundary.selected.length, 1)
})

test('partial 与 truncated 独立表示，且无 handle 明确不续读', () => {
  const result = planRecall(input({ completeness: 'partial', complete: false, truncated: true }))
  assert.equal(result.status, 'partial')
  assert.equal(result.truncated, true)
  assert.equal(result.followUp, null)
})

test('超预算时显式标记截断与 partial', () => {
  const result = planRecall(input({ maxCodePoints: 2 }))
  assert.equal(result.truncated, true)
  assert.equal(result.complete, false)
})

test('匹配代际的合法 handle 原样携带；不构造或递归执行', () => {
  const handle = { cursor: 'opaque-handle', generation: 3 }
  const result = planRecall(input({ followUpHandle: handle }))
  assert.deepEqual(result.followUp, handle)
})

test('handle 代际不匹配时停止且不复用', () => {
  const result = planRecall(input({ followUpHandle: { cursor: 'old', generation: 2 } }))
  assert.equal(result.status, 'unknown')
  assert.equal(result.followUp, null)
})

test('同 ID 去重并对候选输入排列保持确定性', () => {
  const first = candidate({ id: 'b' })
  const second = candidate({ id: 'a' })
  const one = planRecall(input({ candidates: [first, second] }))
  const two = planRecall(input({ candidates: [second, first] }))
  assert.deepEqual(one.selected.map((item) => item.id), two.selected.map((item) => item.id))
  assert.equal(one.selected.length, 2)
  const duplicate = planRecall(input({ candidates: [first, { ...first }] }))
  assert.equal(duplicate.selected.length, 1)
})
