/**
 * v3 摄入脱敏守卫：中文键名（密码/密钥/令牌/凭据/凭证）的文本形态。
 *
 * ## 缺陷
 * SENSITIVE_KEY 认中文键（对象面 redactValue 已脱敏），但 SENSITIVE_VALUE_PATTERNS
 * 的两条文本规则键名只允许 ASCII 标识符。tool/result 正文里的「密码：abc123」
 * 因此原样入库、导出分享包同样带明文；两面对同一键名的判定不一致。
 *
 * ## 判据
 * - 文本形态（半角/全角冒号、等号、JSON 引号键）值不落明文；
 * - 键名与其余字段保留（可对账）；JSON 形态仍可解析；
 * - 端到端：tool/result 摄入后记录正文不含明文；
 * - 负例：键名后不直接接分隔符（如「密码学：」）不误伤；
 * - 幂等：重复脱敏不改变结果。
 *
 * ## 不适用条件
 * assistant/user 正文按产品口径不脱敏（beta.48 明确不做）；本守卫只覆盖
 * tool/result 正文与 tool/call 参数。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { redactText, redactValue } from '../src/v3/domain/security/redact.mjs'
import { extractEventBody } from '../src/v3/entry/v3-entry.mjs'

const SECRET = 'abc123secret'

function toolResult(text) {
  return extractEventBody({
    type: 'tool/result',
    data: { message: { role: 'tool', content: [{ type: 'text', text }] } },
  })
}

test('中文键：半角冒号 / 全角冒号 / 等号（文本形态）', () => {
  for (const input of ['密码：' + SECRET, '密码: ' + SECRET, '密钥=' + SECRET, '令牌：' + SECRET, '凭据：' + SECRET, '凭证=' + SECRET]) {
    const out = redactText(input)
    assert.ok(!out.includes(SECRET), '不得含明文：' + input + ' -> ' + out)
  }
})

test('中文键：JSON 引号键形态（键名保留、JSON 可解析）', () => {
  const out = redactText('{"密码": "' + SECRET + '", "user": "bob"}')
  assert.ok(!out.includes(SECRET), '不得含明文：' + out)
  assert.ok(out.includes('"密码"'), '键名保留：' + out)
  const parsed = JSON.parse(out)
  assert.equal(parsed['密码'], '[REDACTED]')
  assert.equal(parsed.user, 'bob')
})

test('中文键：端到端 tool/result 摄入不含明文', () => {
  const body = toolResult('配置文件如下：\n密码：' + SECRET + '\n其余字段照常')
  assert.ok(!body.text.includes(SECRET), '记录正文不得含明文：' + body.text)
})

test('中文键：键名后不直接接分隔符时不误伤（密码学：）', () => {
  const input = '密码学：' + SECRET
  assert.equal(redactText(input), input)
})

test('中文键：对象面与文本面同口径（redactValue 仍脱敏）', () => {
  assert.equal(JSON.stringify(redactValue({ 密码: SECRET })), '{"密码":"[REDACTED]"}')
})

test('中文键：重复脱敏幂等', () => {
  for (const input of ['密码：' + SECRET, '{"密码": "' + SECRET + '"}', '令牌: ' + SECRET]) {
    const once = redactText(input)
    assert.equal(redactText(once), once, '二次脱敏应稳定：' + input)
  }
})
