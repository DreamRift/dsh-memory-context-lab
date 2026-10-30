/**
 * AUD50-02-05（B2-3）：分隔符截断导致后半段泄露。
 *
 * 修前：裸键模式的值字符类在 ;/, 处停止——
 * "DB_PASSWORD=abcdef;ghij" 只脱敏 abcdef，分号后的 ghij 明文留在正文；
 * 带引号且含分隔符的值整段不脱敏。修法：值边界按上下文区分——
 * URL/查询串值到 &/#/空白为止（下一参数不误吞）；普通 key=value 值到行尾；
 * 引号值整段替换（含分隔符、支持转义引号）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { redactText } from '../src/v3/domain/security/redact.mjs'

test('B2-3 分号分隔：后半段不再泄露', () => {
  const out = redactText('DB_PASSWORD=abcdef;ghij')
  assert.equal(out, 'DB_PASSWORD=[REDACTED]')
  assert.ok(!out.includes('ghij'))
})

test('B2-3 逗号分隔：后半段不再泄露', () => {
  const out = redactText('DB_PASSWORD=abc,def')
  assert.equal(out, 'DB_PASSWORD=[REDACTED]')
  assert.ok(!out.includes('def'))
})

test('B2-3 引号值含分隔符：整段替换、引号保留', () => {
  assert.equal(redactText('password: "a;b,c"'), 'password: "[REDACTED]"')
  assert.equal(redactText("token='x;y'"), "token='[REDACTED]'")
  assert.equal(redactText('secret="ab\\"cd;ef"'), 'secret="[REDACTED]"', '转义引号内的值整段替换')
})

test('B2-3 URL 查询串：值脱敏且下一个参数不被误吞', () => {
  const out = redactText('https://api.example.com/v1?api_key=sk12345678&mode=json')
  assert.equal(out, 'https://api.example.com/v1?api_key=[REDACTED]&mode=json')
  assert.ok(out.includes('mode=json'), '下一参数保留')
  assert.equal(redactText('?token=abc%3Ddef&x=1'), '?token=[REDACTED]&x=1', 'URL 编码分隔符同口径')
})

test('B2-3 普通 key=value：值到行尾（宁可多脱敏不可漏）', () => {
  const out = redactText('password=abc&def')
  assert.ok(!out.includes('def'), '行内 & 后的内容一并脱敏（普通上下文值到行尾）')
})

test('B2-3 边界不回退：既有形态保持', () => {
  // 值最短 4 字的下限维持（与旧行为一致）
  assert.equal(redactText('token=abc'), 'token=abc')
  // B1-1 的 JSON 引号键形态不受影响
  assert.equal(redactText('{"api_key": "abcd1234"}'), '{"api_key": "[REDACTED]"}')
  // Authorization 头（独立模式在前）不受影响
  assert.equal(redactText('Authorization: Bearer sk-abcdefghijklmnop'), 'Authorization: [REDACTED]')
})
