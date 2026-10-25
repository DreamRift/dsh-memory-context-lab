/**
 * v3 domain/retrieval 查询域测试（M1）。
 *
 * ## 判据来源
 * P6（CJK 单字+相邻双字、双面 min_score 门槛）、P4/§2.7（确定性、可重放）、
 * recall-gate 保留判据（纯壳不注入）的域侧形态。
 *
 * ## 断言组
 * - 分词：CJK 单字+双字、ASCII 小写、混合与切断、空查询空数组；
 * - 双面门槛：display/pack/dropped 三分；pack 是 display 子集；未知阈值 fail-fast；
 *   pack 阈低于 result 阈非法；
 * - 排序：分数降序、同分 id 升序、不改入参、两次调用逐字节同序。
 *
 * ## 不适用条件与已知边界
 * BM25 打分、增量索引、query_excerpt 属 M4 provider/adapter；exact 短语顺序
 * （retrieval-contract 保留项）在 M4 合并通道重证。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { applyMinScore, rankResults, tokenizeQuery } from '../src/v3/domain/retrieval/query.mjs'

test('CJK 分词：单字 + 相邻双字', () => {
  assert.deepEqual(tokenizeQuery('中文'), ['中', '文', '中文'])
  assert.deepEqual(tokenizeQuery('检索'), ['检', '索', '检索'])
  const tokens = tokenizeQuery('记忆插件')
  assert.ok(tokens.includes('记'))
  assert.ok(tokens.includes('记忆'))
  assert.ok(tokens.includes('插件'))
  assert.equal(tokens.length, 7, '4 字 = 4 单字 + 3 双字')
})

test('ASCII 小写化与混合切断；空查询空数组', () => {
  assert.deepEqual(tokenizeQuery('Hello WORLD'), ['hello', 'world'])
  assert.deepEqual(tokenizeQuery('DSH 记忆'), ['dsh', '记', '忆', '记忆'])
  assert.deepEqual(tokenizeQuery('a-b'), ['a', 'b'])
  assert.deepEqual(tokenizeQuery('   '), [])
  assert.deepEqual(tokenizeQuery(''), [])
})

test('双面门槛：display/pack/dropped 三分，pack 是 display 子集', () => {
  const results = [
    { id: 'r1', score: 0.9 },
    { id: 'r2', score: 0.6 },
    { id: 'r3', score: 0.3 },
  ]
  const gated = applyMinScore(results, { resultMinScore: 0.5, packMinScore: 0.8 })
  assert.deepEqual(gated.display.map((r) => r.id), ['r1', 'r2'])
  assert.deepEqual(gated.pack.map((r) => r.id), ['r1'])
  assert.deepEqual(gated.dropped.map((r) => r.id), ['r3'])
  assert.ok(gated.pack.every((p) => gated.display.includes(p)))
})

test('未知/非法阈值失败关闭；pack 阈低于 result 阈非法', () => {
  const results = [{ id: 'r1', score: 1 }]
  for (const bad of [undefined, null, NaN, -0.5, '0.5']) {
    assert.throws(
      () => applyMinScore(results, { resultMinScore: bad, packMinScore: 0.5 }),
      (e) => e?.name === 'V3ContractViolation',
      'resultMinScore=' + String(bad),
    )
  }
  assert.throws(() => applyMinScore(results, { resultMinScore: 0.8, packMinScore: 0.5 }), /不得低于/)
  assert.throws(() => applyMinScore('x', { resultMinScore: 0.5, packMinScore: 0.5 }), /数组/)
  assert.throws(() => applyMinScore([{ id: 'r', score: NaN }], { resultMinScore: 0.5, packMinScore: 0.5 }), /命中项/)
})

test('确定性排序：分数降序、同分 id 升序、不改入参', () => {
  const input = [
    { id: 'b', score: 0.5 },
    { id: 'a', score: 0.5 },
    { id: 'c', score: 0.9 },
  ]
  const ranked = rankResults(input)
  assert.deepEqual(ranked.map((r) => r.id), ['c', 'a', 'b'])
  assert.deepEqual(input.map((r) => r.id), ['b', 'a', 'c'], '入参不被修改')
  assert.deepEqual(rankResults(rankResults(input)).map((r) => r.id), ['c', 'a', 'b'], '幂等')
})
