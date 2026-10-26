/**
 * v3 tool/call 参数脱敏的守卫（H-27，2026-10-26 缺陷排查批）。
 *
 * ## 缺陷（三处遗漏，都是「凭据明文落盘」）
 * 1. **深度超限即放行**：`redactValue` 开头 `if (depth > 6) return value` —— 第 7 层以下的
 *    凭据完全不脱敏。脱敏函数的失败模式必须是「更严」而不是「更松」。
 * 2. **只按 key 名匹配**：`{headers:'Authorization: Bearer sk-…'}`、`{url:'…?token=sk-…'}`、
 *    `{args:['--password=hunter2']}` 的 key 都是普通词，值里的凭据原样入库。
 * 3. **非 JSON 串原样返回**：`parseJsonishArguments` 解析失败就返回原串，而旧实现随后
 *    直接 `JSON.stringify`/原样使用——截断或带尾逗号的参数串整段明文落盘。
 *
 * ## 判据
 * - 深层（depth > 6）不再放行原值，而是整段 `[REDACTED:depth]`；
 * - 字符串值里出现 Authorization 头 / `key=value` 凭据 / `sk-` 前缀 / CLI `--password=` →
 *   只替换凭据片段，其余正文保留（可读性与对账价值不丢）；
 * - 非 JSON 参数串同样过值脱敏；
 * - 正常文本不被误伤（不得把普通句子里的 "token" 一词整段吞掉）。
 *
 * ## 不适用条件与已知边界
 * 基于正则的启发式：能挡住常见形态，**不保证**穷尽所有凭据书写法（例如把密钥拆成两段
 * 拼接、或用非 sk- 前缀的自定义密钥）。真正的兜底是「tool/call 参数整体不入正文、
 * 只留结构」这一设计级决定——需要拍板，见 bug-hunt 文档的「待拍板」。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { extractEventBody } from '../src/v3/entry/v3-entry.mjs'

function callText(args) {
  return extractEventBody({ type: 'tool/call', data: { name: 'x', callId: 'c1', arguments: args } }).text
}

test('H-27 深度超限不得放行原值（旧：第 7 层以下凭据明文）', () => {
  const text = callText({ a: { b: { c: { d: { e: { f: { g: { apiKey: 'sk-DEEP-SECRET-VALUE' } } } } } } } })
  assert.ok(!text.includes('sk-DEEP-SECRET-VALUE'), '深层凭据必须被截断，得到：' + text)
})

test('H-27 普通 key 的值里的凭据也要脱敏', () => {
  const cases = [
    ['Authorization 头', { headers: 'Authorization: Bearer sk-LIVE-TOKEN-123' }, 'sk-LIVE-TOKEN-123'],
    ['URL query', { url: 'https://api.example.com/v1?token=sk-URL-SECRET&x=1' }, 'sk-URL-SECRET'],
    ['CLI 参数', { args: ['--password=hunter2secret'] }, 'hunter2secret'],
    ['api_key= 形态', { note: 'config api_key=abcd1234efgh' }, 'abcd1234efgh'],
  ]
  for (const [name, args, secret] of cases) {
    const text = callText(args)
    assert.ok(!text.includes(secret), name + ' 的凭据不得明文：' + text)
    assert.ok(text.includes('[REDACTED]'), name + ' 应留下脱敏标记：' + text)
  }
})

test('H-27 非 JSON 参数串也要脱敏（旧：整串明文落盘）', () => {
  const text = callText('{"apiKey": "sk-MALFORMED-SECRET",}')
  assert.ok(!text.includes('sk-MALFORMED-SECRET'), '非法 JSON 串里的凭据不得明文：' + text)
})

test('H-27 正常文本不被误伤（不吞普通句子）', () => {
  const text = callText({ query: '记忆上下文插件的 token 预算怎么算？' })
  assert.ok(text.includes('记忆上下文插件的'), '普通正文必须保留：' + text)
  assert.ok(text.includes('预算怎么算'), '普通正文必须保留：' + text)
})
