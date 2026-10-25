/**
 * v3 裁决合同测试（M1）。
 *
 * ## 判据来源
 * 《开发计划-v3》§2.4（不可变 decision；提交成功后才执行活动面操作）、P7（basis
 * 必填——投影诚实）、P1（surface-replace 必须指认 targetEventId，谁注入谁回收）。
 *
 * ## 断言组
 * - 合法裁决（含空 effects 的 retain 无操作裁决）通过；
 * - 各效果种类的必填附加字段缺失即非法；未知效果字段即非法；
 * - sealDecision：合法裁决 deepFreeze（嵌套 effects 也改不动）；非法裁决抛
 *   V3ContractViolation；
 * - 数据非法返回结构化结果不抛错。
 *
 * ## 不适用条件与已知边界
 * 只验结构与不可变性；效果顺序与事务边界（先持久化后投影）属 M3 用例编排。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DECISION_KINDS,
  EFFECT_KINDS,
  sealDecision,
  validateDecision,
} from '../src/v3/contracts/decisions.mjs'

function goodDecision(overrides = {}) {
  return {
    id: 'dec-1',
    kind: 'archive',
    sessionKey: 'sess-1',
    createdAt: 1792845000000,
    effects: [
      { kind: 'store-record', recordId: 'v3r-0123456789abcdef', text: '正文' },
      { kind: 'surface-replace', targetEventId: 'evt-9', text: '回执' },
    ],
    basis: '保护集外且已完整配对',
    ...overrides,
  }
}

test('合法裁决通过；retain 空 effects 是合法的无操作裁决', () => {
  assert.equal(validateDecision(goodDecision()).ok, true)
  const noop = goodDecision({ kind: 'retain', effects: [] })
  assert.equal(validateDecision(noop).ok, true)
})

test('每类非法形状各有独立 error', () => {
  const cases = [
    [goodDecision({ ghost: 1 }), /未知字段：ghost/],
    [goodDecision({ id: '' }), /id 必须是非空字符串/],
    [goodDecision({ kind: 'compress' }), /kind 必须是封闭集/],
    [goodDecision({ basis: '  ' }), /basis 必须是非空字符串/],
    [goodDecision({ effects: null }), /effects 必须是数组/],
    [goodDecision({ effects: [{ kind: 'surface-delete' }] }), /effects\[0\]\.kind 必须是封闭集/],
    [goodDecision({ effects: [{ kind: 'store-record' }] }), /effects\[0\] 缺必填字段：recordId/],
    [goodDecision({ effects: [{ kind: 'surface-replace' }] }), /effects\[0\] 缺必填字段：targetEventId/],
    [goodDecision({ effects: [{ kind: 'surface-append', recordId: 'x' }] }), /effects\[0\] 不允许字段：recordId/],
    [goodDecision({ effects: [{ kind: 'surface-append', text: 5 }] }), /effects\[0\]\.text 必须是字符串/],
    [null, /decision 必须是对象/],
  ]
  for (const [candidate, pattern] of cases) {
    const result = validateDecision(candidate)
    assert.equal(result.ok, false, JSON.stringify(candidate))
    assert.ok(result.errors.some((e) => pattern.test(e)), JSON.stringify(result.errors))
  }
})

test('sealDecision：合法裁决深冻结（嵌套改不动），非法抛 V3ContractViolation', () => {
  const sealed = sealDecision(goodDecision())
  assert.ok(Object.isFrozen(sealed))
  assert.ok(Object.isFrozen(sealed.effects))
  assert.ok(Object.isFrozen(sealed.effects[0]))
  assert.throws(() => { sealed.effects[0].text = 'x' }, TypeError)
  assert.throws(() => sealDecision(goodDecision({ basis: '' })), (e) => e?.name === 'V3ContractViolation')
})

test('数据非法返回结构化结果不抛错；封闭集冻结', () => {
  assert.doesNotThrow(() => validateDecision(goodDecision({ kind: 'nope' })))
  assert.ok(Object.isFrozen(DECISION_KINDS) && Object.isFrozen(EFFECT_KINDS))
})
