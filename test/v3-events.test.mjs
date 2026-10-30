/**
 * v3 事件合同测试（M1）。
 *
 * ## 判据来源
 * 《开发计划-v3》§2.4（宿主适配层归一化并保留原始 event id/source）、P1（source.form
 * 是「谁注入谁回收」的认领依据）。
 *
 * ## 断言组
 * - 合法事件通过；每类非法形状各有独立 error；source 只允许 kind/form；
 * - 数据非法返回结构化结果不抛错。
 *
 * ## 不适用条件与已知边界
 * 只验结构；真实用户回合判定（P3 真实用户回合计数）在 domain/session。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { EVENT_FIELDS, EVENT_TYPES, validateEvent } from '../src/v3/contracts/events.mjs'

function goodEvent(overrides = {}) {
  return {
    id: 'evt-1',
    type: 'user',
    sessionKey: 'sess-1',
    at: 1792845000000,
    source: { kind: 'dsh', form: null },
    ...overrides,
  }
}

test('合法事件通过（四种类型都合法）', () => {
  for (const type of EVENT_TYPES) {
    const result = validateEvent(goodEvent({ type }))
    assert.equal(result.ok, true, type)
  }
})

test('每类非法形状各有独立 error', () => {
  const cases = [
    [goodEvent({ ghost: 1 }), /未知字段：ghost/],
    [goodEvent({ id: '' }), /id 必须是非空字符串/],
    [goodEvent({ type: 'system' }), /type 必须是封闭集/],
    [goodEvent({ sessionKey: ' ' }), /sessionKey 必须是非空白字符串/],
    [goodEvent({ at: -1 }), /at.*必须是有限非负数/], // B3-1 后措辞为「at 若存在必须是…」（at 可选，只有存在时才校验）
    [goodEvent({ source: null }), /source 必须是对象/],
    [goodEvent({ source: { kind: 'dsh', extra: 1 } }), /source 只允许 kind/],
    [goodEvent({ source: { kind: '', form: null } }), /source.kind 必须是非空字符串/],
    [goodEvent({ source: { kind: 'dsh', form: 5 } }), /source.form 必须是字符串或 null/],
    ['x', /event 必须是对象/],
  ]
  for (const [candidate, pattern] of cases) {
    const result = validateEvent(candidate)
    assert.equal(result.ok, false, JSON.stringify(candidate))
    assert.ok(result.errors.some((e) => pattern.test(e)), JSON.stringify(result.errors))
  }
})

test('数据非法不抛错；封闭集冻结', () => {
  assert.doesNotThrow(() => validateEvent(goodEvent({ type: 'nope' })))
  assert.ok(Object.isFrozen(EVENT_TYPES) && Object.isFrozen(EVENT_FIELDS))
})
