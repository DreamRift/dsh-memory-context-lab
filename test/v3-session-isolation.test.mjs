/**
 * v3 domain/session 首个纯函数的契约测试（M1 种子，M0 随骨架落地）。
 *
 * ## 缺陷
 * 跨会话串数据是 v3 必须重证的不变量之首（计划 §1.3）；隔离键是它的第一道闸。
 *
 * ## 判据来源
 * 《开发计划-v3》§1.3 必须重证的不变量（会话隔离）；编码纪律 NFC 归一。
 *
 * ## 断言组
 * - 同一 id 稳定；trim/NFC 归一；不同 id 不同键；
 * - 非字符串与空串失败关闭（ESESSION_INVALID_ID），不返回兜底值。
 *
 * ## 不适用条件与已知边界
 * 只覆盖键归一；键到磁盘目录的映射（sha256 前 24 位沿用与否）在 M2 存储层另行裁决。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { sessionIsolationKey } from '../src/v3/domain/session/isolation-key.mjs'

test('同一 session id 稳定且 trim/NFC 归一', () => {
  assert.equal(sessionIsolationKey('abc'), 'abc')
  assert.equal(sessionIsolationKey('  abc  '), 'abc')
  assert.equal(sessionIsolationKey('cafe\u0301'), 'café'.normalize('NFC'))
})

test('不同 id 不同键', () => {
  assert.notEqual(sessionIsolationKey('abc'), sessionIsolationKey('abd'))
})

test('非法输入失败关闭：ESESSION_INVALID_ID，不给兜底值', () => {
  for (const bad of [null, undefined, 123, {}, '', '   \t  ']) {
    assert.throws(
      () => sessionIsolationKey(bad),
      (error) => error?.code === 'ESESSION_INVALID_ID' && error?.name === 'V3Error',
      '输入 ' + JSON.stringify(bad) + ' 必须抛 ESESSION_INVALID_ID',
    )
  }
})
