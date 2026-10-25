/**
 * v3 记录合同测试（M1）。
 *
 * ## 缺陷
 * v2 store-hardening #2：只校验 hash 不校验 size → 按字符数算 size 的记录提交成功
 * 后每次读都判 size-mismatch、永久不可读却仍在 catalog。v3 把 size 一致性放进
 * 结构校验，提交前就拒绝。key-and-order D-14 撞键教训 → 封闭字段集 + JSON 键。
 *
 * ## 判据来源
 * 《开发计划-v3》§2.4（权威事实源只有一份）、§2.5 SessionStore 窄接口。
 *
 * ## 断言组
 * - 合法记录通过；每类非法形状各有独立 error（未知字段/id/kind/sessionKey/createdAt/
 *   payload 类型/bytes 不符/provenance 缺 transactionId）；
 * - bytes 按字符数算（CJK 场景）必被拒——直接锁死 v2 教训；
 * - 数据非法返回结构化结果不抛错；assertValidRecord 抛 V3ContractViolation。
 *
 * ## 不适用条件与已知边界
 * 只验结构与一致性，不验内容语义（重要性/敏感性属 domain/context）；hash 校验
 * 属 M2 存储读路径（integrity 标注契约，见映射表保留项）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { assertValidRecord, RECORD_FIELDS, RECORD_KINDS, validateRecord } from '../src/v3/contracts/records.mjs'

function goodRecord(overrides = {}) {
  return {
    id: 'v3r-0123456789abcdef',
    kind: 'operation',
    sessionKey: 'sess-1',
    createdAt: 1792845000000,
    payload: { text: 'hello', bytes: 5 },
    provenance: { sourceEventId: 'evt-1', sourceForm: 'tool/result', transactionId: 'txn-1' },
    ...overrides,
  }
}

test('合法记录通过且原样返回', () => {
  const record = goodRecord()
  const result = validateRecord(record)
  assert.equal(result.ok, true)
  assert.equal(result.record, record)
})

test('每类非法形状各有独立 error（不合并成一个笼统拒绝）', () => {
  const cases = [
    [goodRecord({ extra: 1 }), /未知字段：extra/],
    [goodRecord({ id: 'x-1' }), /id 必须形如/],
    [goodRecord({ kind: 'prefetch' }), /kind 必须是封闭集/],
    [goodRecord({ sessionKey: '  ' }), /sessionKey 必须是非空白字符串/],
    [goodRecord({ createdAt: NaN }), /createdAt 必须是有限非负数/],
    [goodRecord({ payload: null }), /payload 必须是对象/],
    [goodRecord({ payload: { text: 'hello', bytes: 4 } }), /字节长度不符/],
    [goodRecord({ provenance: { sourceEventId: 'e' } }), /transactionId 必须是非空字符串/],
    [null, /record 必须是对象/],
    [[1], /record 必须是对象/],
  ]
  for (const [candidate, pattern] of cases) {
    const result = validateRecord(candidate)
    assert.equal(result.ok, false, JSON.stringify(candidate))
    assert.ok(result.errors.some((e) => pattern.test(e)), JSON.stringify(result.errors))
  }
})

test('v2 教训锁死：按字符数算 bytes 的 CJK 记录必被拒', () => {
  const cjk = '中文正文' // 4 个字符、12 个 UTF-8 字节
  const wrong = goodRecord({ payload: { text: cjk, bytes: cjk.length } })
  const right = goodRecord({ payload: { text: cjk, bytes: Buffer.byteLength(cjk, 'utf8') } })
  assert.equal(validateRecord(wrong).ok, false)
  assert.equal(validateRecord(right).ok, true)
})

test('数据非法返回结果不抛错；assertValidRecord 抛 V3ContractViolation', () => {
  const bad = goodRecord({ id: 'nope' })
  assert.doesNotThrow(() => validateRecord(bad))
  assert.throws(() => assertValidRecord(bad), (e) => e?.name === 'V3ContractViolation')
})

test('封闭集冻结：kind 与字段清单不可运行期扩张', () => {
  assert.ok(Object.isFrozen(RECORD_KINDS))
  assert.ok(Object.isFrozen(RECORD_FIELDS))
})
