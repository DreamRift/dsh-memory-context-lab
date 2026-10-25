/**
 * v3 投影结果合同测试（M1）。
 *
 * ## 判据来源
 * 《开发计划-v3》§2.4（最后记录 projection outcome；表面投影失败不得伪装成已完成）、P7。
 *
 * ## 断言组
 * - applied 三条件（计数相等、failures 空）；partial/failed 必须 failures 非空；
 * - 「applied 但计数不符」「partial 但 failures 空」「applied 超额」均非法；
 * - 失败条目字段封闭、每字段类型把关；数据非法返回结构化结果不抛错。
 *
 * ## 不适用条件与已知边界
 * 只验结构一致性；效果执行与 metrics 记录属 M3/M4。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { OUTCOME_STATUSES, validateOutcome } from '../src/v3/contracts/outcomes.mjs'

function goodOutcome(overrides = {}) {
  return {
    decisionId: 'dec-1',
    sessionKey: 'sess-1',
    at: 1792845000000,
    status: 'applied',
    totalEffects: 2,
    appliedEffects: 2,
    failures: [],
    ...overrides,
  }
}

test('applied 合法；partial/failed 带 failures 合法', () => {
  assert.equal(validateOutcome(goodOutcome()).ok, true)
  const partial = goodOutcome({ status: 'partial', appliedEffects: 1, failures: [{ effectIndex: 1, code: 'EHOST_SURFACE_UNAVAILABLE', message: '宿主拒绝 replace' }] })
  assert.equal(validateOutcome(partial).ok, true)
  const failed = goodOutcome({ status: 'failed', appliedEffects: 0, failures: [{ effectIndex: 0, code: 'EINTERNAL', message: '事务失败' }] })
  assert.equal(validateOutcome(failed).ok, true)
})

test('诚实边界：伪装与瞒报都非法', () => {
  const cases = [
    [goodOutcome({ appliedEffects: 1 }), /applied 必须 appliedEffects === totalEffects/],
    [goodOutcome({ failures: [{ effectIndex: 0, code: 'X', message: 'm' }] }), /applied 必须 failures 为空/],
    [goodOutcome({ status: 'partial', appliedEffects: 1, failures: [] }), /partial 必须列 failures/],
    [goodOutcome({ status: 'failed', appliedEffects: 0, failures: [] }), /failed 必须列 failures/],
    [goodOutcome({ appliedEffects: 3 }), /appliedEffects 不得大于 totalEffects/],
  ]
  for (const [candidate, pattern] of cases) {
    const result = validateOutcome(candidate)
    assert.equal(result.ok, false, JSON.stringify(candidate))
    assert.ok(result.errors.some((e) => pattern.test(e)), JSON.stringify(result.errors))
  }
})

test('结构与类型把关：字段封闭、每类非法各有独立 error', () => {
  const cases = [
    [goodOutcome({ ghost: 1 }), /未知字段：ghost/],
    [goodOutcome({ status: 'pending' }), /status 必须是封闭集/],
    [goodOutcome({ totalEffects: -1 }), /totalEffects 必须是非负整数/],
    [goodOutcome({ failures: [{}] }), /effectIndex 必须是非负整数/],
    [goodOutcome({ failures: [{ effectIndex: 0, code: '', message: 'm' }] }), /code 必须是非空字符串/],
    [goodOutcome({ failures: [{ effectIndex: 0, code: 'X', message: 'm', extra: 1 }] }), /不允许字段：extra/],
    ['x', /outcome 必须是对象/],
  ]
  for (const [candidate, pattern] of cases) {
    const result = validateOutcome(candidate)
    assert.equal(result.ok, false, JSON.stringify(candidate))
    assert.ok(result.errors.some((e) => pattern.test(e)), JSON.stringify(result.errors))
  }
  assert.doesNotThrow(() => validateOutcome(goodOutcome({ status: 'nope' })))
  assert.ok(Object.isFrozen(OUTCOME_STATUSES))
})
