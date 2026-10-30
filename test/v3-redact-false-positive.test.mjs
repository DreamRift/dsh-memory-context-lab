/**
 * B3-3（AUD50-02-08）过度脱敏收敛——author/authMode 不是凭据键；
 * token 类键与文本规则的值仅在像凭据时替换（纯字母词/纯数字放行，已知前缀/数字混排/标点仍替换）。
 * 安全底线不回退：真实密钥、短口令（password 类键）一律照旧脱敏。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { redactText, redactValue, isSensitiveKey, credentialShapedValue } from '../src/v3/domain/security/redact.mjs'

test('文本：普通词形态不再误伤', () => {
  assert.equal(redactText('the token: appears'), 'the token: appears')
  assert.equal(redactText('token: oauth'), 'token: oauth')
  assert.equal(redactText('{"author":"张三"}'), '{"author":"张三"}')
  assert.equal(redactText('password: 密码错误'), 'password: 密码错误', '纯中文普通词不误伤')
  assert.equal(redactText('token: 12345'), 'token: 12345', '纯数字不误伤')
})

test('文本：真实凭据形态照旧替换', () => {
  assert.equal(redactText('token: hunter2'), 'token: [REDACTED]', '字母+数字按凭据')
  assert.equal(redactText('SERVICE_TOKEN=TOPSECRET123'), 'SERVICE_TOKEN=[REDACTED]')
  assert.equal(redactText('token: sk-abcdefgh12'), 'token: [REDACTED]', '已知前缀')
  assert.equal(redactText('token：秘密口令1234'), 'token：[REDACTED]', '中文+数字按凭据')
  assert.equal(redactText('secret="a;b,c"'), 'secret="[REDACTED]"', '标点混排按凭据')
  assert.ok(!redactText('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789').includes('ghp_'), 'GitHub token 照旧')
})

test('对象键：author/authMode 白名单；token 类键看值形态；password 类键无条件', () => {
  assert.equal(isSensitiveKey('author'), false)
  assert.equal(isSensitiveKey('authMode'), false)
  assert.equal(isSensitiveKey('authToken'), true, '白名单不外溢')
  assert.deepEqual(redactValue({ author: '张三' }), { author: '张三' })
  assert.deepEqual(redactValue({ authMode: 'oauth' }), { authMode: 'oauth' })
  assert.deepEqual(redactValue({ token: 'oauth' }), { token: 'oauth' }, 'token 键 + 普通词值放行')
  assert.equal(redactValue({ token: 'sk-abcdefgh12' }).token, '[REDACTED]')
  assert.equal(redactValue({ token: 'hunter2' }).token, '[REDACTED]', 'token 键 + 数字混排仍替换')
  assert.equal(redactValue({ password: 'p' }).password, '[REDACTED]', 'password 类键无条件（钉子不回退）')
  assert.equal(redactValue({ apiKey: 'abcd1234' }).apiKey, '[REDACTED]')
  assert.equal(redactValue({ nested: { author: '李四' } }).nested.author, '李四', '白名单递归生效')
})

test('值形态判据：边界值', () => {
  assert.equal(credentialShapedValue('appears'), false)
  assert.equal(credentialShapedValue('张三'), false)
  assert.equal(credentialShapedValue('"oauth"'), false, '引号外壳剥掉后判定')
  assert.equal(credentialShapedValue('hunter2'), true)
  assert.equal(credentialShapedValue('sk-abcdefgh12'), true)
  assert.equal(credentialShapedValue('aB3xK9mP2qR7'), true, '长随机串')
  assert.equal(credentialShapedValue(42), true, '非字符串按凭据处理（宁可误伤）')
  assert.equal(credentialShapedValue(''), false)
})
