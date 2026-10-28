/**
 * 0.14.0-beta.44：数字参数只有一把尺子（十进制整数）。
 *
 * 0.14.0-beta.43 的命令面用 Number()，`0x10`→16、`1e1`→10 会被静默接受并写进
 * control.json；面板字段同样用 Number(text)。这里钉住解析器本身。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { parseStrictInteger } from '../src/v3/domain/session/number-input.mjs'

test('parseStrictInteger：只认十进制数字串', () => {
  assert.equal(parseStrictInteger('0'), 0)
  assert.equal(parseStrictInteger('5'), 5)
  assert.equal(parseStrictInteger('05'), 5)
  assert.equal(parseStrictInteger('95'), 95)
  assert.equal(parseStrictInteger(' 20 '), 20, '调用方分词后仍允许 trim')
  for (const bad of ['0x10', '1e1', '5.0', '+5', '-1', '５', '', ' ', 'Infinity', 'NaN', '1_0', null, 5]) {
    assert.equal(parseStrictInteger(bad), null, '必须拒绝：' + String(bad))
  }
  assert.equal(parseStrictInteger('9007199254740992'), null, '超过安全整数必须拒绝')
})
