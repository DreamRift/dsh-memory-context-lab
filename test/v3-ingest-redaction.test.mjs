/**
 * v3 摄入脱敏守卫（H-06，2026-10-26 缺陷排查批）。
 *
 * ## 缺陷
 * 真实宿主的 tool/call 参数是 **JSON 字符串**（app.asar 内 dsh-agent-loop/lib/index.js
 * 的 appendToolCall：`arguments: block.arguments`，content 块里是序列化后的字符串），
 * 而 extractEventBody 的 redactValue 只对 object 递归 —— 字符串里的 apiKey/password/
 * authorization 原样入库（P1 摄入合同 4.1.3 破防）。
 * 既有测试只用了对象形态夹具，所以这条路径从未被覆盖。
 *
 * ## 判据
 * - 字符串形态的敏感字段必须脱敏（正文与 structure 两处都不许出现明文）；
 * - 对象形态保持原行为（不回归）；
 * - 非 JSON 的普通字符串参数原样保留（不改写用户文本，不把普通文本当 JSON 猜）；
 * - 脱敏后仍能结构化回读（structure.arguments 为对象）。
 *
 * ## 不适用条件与已知边界
 * 只覆盖「键名命中敏感词」的脱敏；值里内嵌的凭据（例如 URL 查询串里的 token=…）
 * 不在此判据内（需产品定义脱敏策略，不擅改）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { extractEventBody } from '../src/v3/entry/v3-entry.mjs'

const SECRETS = ['sk-live-SECRET-123', 'hunter2', 'Bearer TOPSECRET']

test('H-06 真实宿主形状：tool/call 的 arguments 是 JSON 字符串也必须脱敏', () => {
  const raw = {
    seq: 3,
    type: 'tool/call',
    at: 1792845000000,
    data: {
      turn: 1,
      step: 1,
      callId: 'call_abc',
      name: 'http_request',
      arguments: JSON.stringify({
        url: 'https://example.test',
        apiKey: 'sk-live-SECRET-123',
        password: 'hunter2',
        headers: { authorization: 'Bearer TOPSECRET' },
      }),
    },
  }
  const body = extractEventBody(raw)
  for (const secret of SECRETS) {
    assert.ok(!body.text.includes(secret), '正文不得含明文：' + secret)
    assert.ok(!JSON.stringify(body.structure).includes(secret), 'structure 不得含明文：' + secret)
  }
  assert.ok(body.text.includes('[REDACTED]'))
  assert.equal(typeof body.structure.arguments, 'object', '解析后按对象保存（可结构化回读）')
  assert.equal(body.structure.arguments.url, 'https://example.test', '非敏感字段保留')
  assert.equal(body.structure.arguments.headers.authorization, '[REDACTED]')
})

test('H-06 对象形态不回归：嵌套敏感字段仍脱敏', () => {
  const body = extractEventBody({
    type: 'tool/call',
    data: { callId: 'c2', name: 'x', arguments: { command: 'echo hi', nested: { password: 'p', ok: 1 } } },
  })
  assert.equal(body.structure.arguments.nested.password, '[REDACTED]')
  assert.equal(body.structure.arguments.nested.ok, 1)
  assert.ok(!body.text.includes('"password":"p"'))
})

test('H-06 非 JSON 字符串参数原样保留（不把普通文本当 JSON 猜）', () => {
  const body = extractEventBody({ type: 'tool/call', data: { callId: 'c3', name: 'echo', arguments: 'raw text with { brace' } })
  assert.equal(body.structure.arguments, 'raw text with { brace')
  assert.ok(body.text.includes('raw text with { brace'))
})

test('H-06 JSON 数组形态参数同样脱敏', () => {
  const body = extractEventBody({
    type: 'tool/call',
    data: { callId: 'c4', name: 'batch', arguments: JSON.stringify([{ token: 'T0P' }, { ok: 1 }]) },
  })
  assert.ok(!JSON.stringify(body.structure).includes('T0P'))
  assert.equal(body.structure.arguments[1].ok, 1)
})

test('H-06 超长参数按码点截断，不留半个代理对', () => {
  const long = '😀'.repeat(500)
  const body = extractEventBody({ type: 'tool/call', data: { callId: 'c5', name: 'x', arguments: long } })
  const tail = body.text.slice(body.text.lastIndexOf('：') + 1)
  assert.ok([...tail].length <= 401, '按码点计长（实测 ' + [...tail].length + ' 码点）')
  const withoutEllipsis = tail.endsWith('…') ? tail.slice(0, -1) : tail
  const lastUnit = withoutEllipsis.charCodeAt(withoutEllipsis.length - 1)
  assert.ok(!(lastUnit >= 0xd800 && lastUnit <= 0xdbff), '不得以孤立高位代理结尾')
  assert.equal([...withoutEllipsis].length, 400, '恰好保留 400 个码点')
})


test('0.14.0-beta.44：tool/result 的常见云/代码托管凭据也必须脱敏', () => {
  const secrets = [
    'AKIAIOSFODNN7EXAMPLE',
    'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
    'github_pat_11ABCDEFG0123456789_abcdefghijklmnop',
    'xoxb-1234567890-abcdefghij',
    'AIzaSyA1234567890abcdefghijklmnopqrstuv',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
    'sk_live_1234567890abcdef',
  ]
  const body = extractEventBody({
    type: 'tool/result',
    data: { message: { role: 'tool', content: [{ type: 'text', text: '输出：' + secrets.join(' | ') }] } },
  })
  for (const secret of secrets) assert.ok(!body.text.includes(secret), '不得原样入库：' + secret)
  assert.ok(body.text.includes('[REDACTED]'))
})
