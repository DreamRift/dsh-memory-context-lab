/**
 * 长尾 S-06 / S-07 / S-08 / S-15 守卫（0.15.4）。
 *
 * 这四条同属「脱敏看得见的漏」：值太短、分隔符不认、键名同形、键名有毒。
 * 前三条靠「改对正则」就能过，因此每条都配**反向**用例（该保留的正文必须保留），
 * 防止把「多脱敏」当成修好。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { redactText, redactValue } from '../src/v3/domain/security/redact.mjs'

test('S-06 短值不再漏：>=1 字符即替换（旧实现要求 >=4）', () => {
  // 缺陷：值下限 4 字符 → password=abc / 密码=abc 全明文出境。
  for (const text of ['password=abc', '密码=abc', '密码: ab', 'secret=ab']) {
    const out = redactText(text)
    assert.ok(out.includes('[REDACTED]'), text + ' 的短值必须被替换，实际：' + out)
    assert.ok(!/abc|ab\b/.test(out), text + ' 的值不得残留，实际：' + out)
  }
  // 同键的对象面本来就是无条件替换；这里只钉文本面两端一致。
  assert.equal(redactValue({ password: 'abc' }).password, '[REDACTED]')
})

test('S-06 与 B3-3 的交界：ASCII token 弱键的形态收敛不回退', () => {
  // `token: oauth` / `the token: appears` 这类其后跟普通词的写法必须保留——
  // B3-3 的收敛是既有裁定，S-06 只负责「短」不是「纯字母」。
  // 但 token 的值只要像凭据（混合字符 / 够长 / 有前缀），仍须替换。
  assert.equal(redactText('token: oauth'), 'token: oauth')
  assert.ok(redactText('token: abc123XYZdef').includes('[REDACTED]'), '混合形态的 token 值必须替换')
  assert.ok(redactText('token=sk-abcdefgh1234').includes('[REDACTED]'), '带前缀的 token 值必须替换')
})

test('S-07 中文系词与全角等号：密码为/是/设为 X、密码＝X 都算凭据', () => {
  // 缺陷：分隔符只认 `:`/`=`/`：`，中文用户写「密码为 abc」完全不命中。
  const cases = [
    ['密码为 abc', 'abc'],
    ['密钥是 xyz', 'xyz'],
    ['口令设为 secret9', 'secret9'],
    ['密码设置为 hunter2', 'hunter2'],
    ['密码＝abc', 'abc'],
  ]
  for (const [text, secret] of cases) {
    const out = redactText(text)
    assert.ok(!out.includes(secret), text + ' 的值泄漏了：' + out)
    assert.ok(out.includes('[REDACTED]'), text + ' 未被脱敏：' + out)
  }
})

test('S-07 反向：不是凭据的中文句子不得被误伤', () => {
  // 「密码为」是系词，但「密码学：…」是技术名词——键名判据仍按 SECRET_KEY_CJK，不放宽。
  const keep = '这段说明讲的是密码学：对称与非对称'
  assert.equal(redactText(keep), keep, '技术名词不得被当成凭据键')
})

test('S-08 同形键：全角 ASCII 与零宽字符插入都要认', () => {
  // 缺陷：`ｐａｓｓｗｏｒｄ＝abc`（输入法全角）与 `pass\u200bword=abc`（网页复制带零宽）
  // 在正则上都「不是凭据键」，明文直接通过。
  const fullwidth = 'ｐａｓｓｗｏｒｄ＝abc'
  const outFw = redactText(fullwidth)
  assert.ok(!outFw.includes('abc'), '全角同形键泄漏：' + outFw)
  assert.ok(outFw.includes('ｐａｓｓｗｏｒｄ'), '键名必须原样保留（不得顺手规范化）：' + outFw)
  assert.ok(outFw.includes('＝'), '全角等号必须原样保留：' + outFw)

  const zeroWidth = 'pass\u200bword=abc'
  const outZw = redactText(zeroWidth)
  assert.ok(!outZw.includes('abc'), '零宽同形键泄漏：' + outZw)
})

test('S-08 反向：归一化只用于匹配，不得改写原文其余字符', () => {
  // 关键合同：脱敏只准替换敏感值，不准顺手把全角字符折成半角。
  // 注意用**空格**分隔值——全角逗号不是空白，会被当成值的一部分（这一步由两步法的
  // 值边界决定，与归一化无关）。
  const text = '账号 ｕｓｅｒ 的密码＝abc 其余全角字符ｘｙｚ应原样'
  const out = redactText(text)
  assert.ok(out.includes('账号 ｕｓｅｒ 的'), '与凭据无关的全角字符被改写了：' + out)
  assert.ok(out.includes('其余全角字符ｘｙｚ应原样'), '凭据之后的全角字符被改写了：' + out)
  assert.ok(!out.includes('abc '), '值仍须替换：' + out)
  assert.ok(out.includes('[REDACTED]'), '值必须被替换：' + out)
})

test('S-15 __proto__ 不得污染原型，且数据不得静默丢失', () => {
  const payload = JSON.parse('{"__proto__":{"polluted":true},"safe":1}')
  const out = redactValue(payload)
  // ① 原型不被改写。
  assert.equal({}.polluted, undefined, '全局原型被污染')
  assert.equal(out.polluted, undefined, '返回对象继承了被污染成员')
  // ② 键不丢：旧实现里 `out['__proto__'] = x` 走 setter，该键在 Object.keys 里消失。
  assert.ok(Object.keys(out).includes('__proto__'), '自有键 __proto__ 丢失：' + JSON.stringify(Object.keys(out)))
  // ③ 序列化仍完整（脱敏不得丢载荷）。
  const round = JSON.parse(JSON.stringify(out))
  assert.equal(round.safe, 1)
})
