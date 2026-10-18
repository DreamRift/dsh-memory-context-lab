/**
 * P1-5 回执补结果语义（status，0.12.0）。
 *
 * 缺陷：回执只有 seq 范围、token、记录 ID，没有退出码/失败摘要；模型要判断上一步
 * 是否成功只能重跑。v2 侧是**接线**不是新造：`apply.mjs` 已算 `statuses`、
 * `core.mjs` 也会渲染，但 v2 的 receiptOf 不传。
 *
 * 不变量：三类 status（ok/fail/partial）；失败附首错行（≤1 行、≤200 字符，
 * 来自 stderr/异常 message，**不改写原文**）；非工具结果标 kind=message，
 * 不硬造 status；回执字节增量 ≤80。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildReceipt,
  buildSpanReceipt,
  clipErrorLine,
  receiptStatusOf,
  RECEIPT_FORMAT_OPERATION,
  RECEIPT_FORMAT_SPAN_V2,
  RECEIPT_FORMAT_VERSION,
  V2_RECEIPT_MARKER,
} from '../src/core.mjs'

const baseArgs = (extra = {}) => ({
  tools: ['pwsh'],
  range: { start: 10, end: 12 },
  callIds: ['call_1'],
  nodeId: 'mcl2-aaaabbbbcccc-000001',
  hash: 'deadbeefdeadbeef',
  chars: 4000,
  tokens: 1000,
  marker: V2_RECEIPT_MARKER,
  formatVersion: RECEIPT_FORMAT_OPERATION,
  releasedTokens: 1000,
  ...extra,
})

test('P1-5a status=ok：全部结果正常', () => {
  assert.equal(receiptStatusOf({ statuses: ['exit 0'] }), 'status=ok')
  assert.equal(receiptStatusOf({ statuses: ['ok', 'exit 0'] }), 'status=ok')
})

test('P1-5b status=fail：全部失败，并附首错行', () => {
  const status = receiptStatusOf({ statuses: ['exit 1'], errorLine: 'Error: 找不到文件 src/missing.mjs' })
  assert.equal(status, 'status=fail（首错：Error: 找不到文件 src/missing.mjs）')
  assert.equal(receiptStatusOf({ statuses: ['error'] }), 'status=fail')
})

test('P1-5c status=partial：部分失败', () => {
  assert.equal(receiptStatusOf({ statuses: ['exit 0', 'exit 1'] }), 'status=partial')
})

test('P1-5d 首错行截断：单行、≤200 字符，超长显式标出被截断', () => {
  const long = 'x'.repeat(500)
  const clipped = clipErrorLine(long)
  assert.ok(clipped.length <= 200 + '…（截断）'.length)
  assert.ok(clipped.endsWith('…（截断）'))
  // 多行只取第一行非空。
  assert.equal(clipErrorLine('\n\n第一行错误\n第二行'), '第一行错误')
})

test('P1-5e 非工具结果不硬造 status：标 kind=message', () => {
  assert.equal(receiptStatusOf({ statuses: [], spanKind: 'assistant.text' }), 'kind=message')
  assert.equal(receiptStatusOf({ statuses: [] }), null, '完全无信息时不编造任何 status 行')
})

test('P1-5f 操作回执（format 6）渲染 status 行，且不覆盖「返回状态」既有行', () => {
  const text = buildReceipt(baseArgs({ statuses: ['exit 1'], errorLine: 'Error: 命令失败' }))
  assert.match(text, /^返回状态：pwsh#call_1=exit 1（工具返回状态，不代表用户目标已完成）$/m)
  assert.match(text, /^status=fail（首错：Error: 命令失败）$/m)
})

test('P1-5g 片段回执（format 7）标 kind=message，不声称工具成败', () => {
  const text = buildSpanReceipt({
    label: '助手消息',
    range: { start: 20, end: 20 },
    nodeId: 'mcl2-aaaabbbbcccc-000002',
    hash: 'cafebabe',
    chars: 2000,
    tokens: 700,
    marker: V2_RECEIPT_MARKER,
    formatVersion: RECEIPT_FORMAT_SPAN_V2,
    releasedTokens: 700,
  })
  assert.match(text, /^kind=message$/m)
  assert.equal(/status=(ok|fail|partial)/.test(text), false, '片段不得声称工具成败')
})

test('P1-5h 旧格式（format 4）不因 status 接线而漂移', () => {
  const text = buildReceipt(baseArgs({ formatVersion: RECEIPT_FORMAT_VERSION, releasedTokens: null, statuses: ['exit 1'] }))
  assert.equal(/^status=/m.test(text), false)
})

test('P1-5i 回执字节增量 ≤80（无首错时）；有首错时行本身 ≤200 字符', () => {
  // 正常路径（ok）：新增的就是一行 status=ok，它自己必须 ≤80 字节。
  // 注意不能拿「有 statuses」与「无 statuses」两份回执相减：后者连既有的
  // 「返回状态」行也没有，差值是两行的和，测不到本轮的增量。
  const withOk = buildReceipt(baseArgs({ statuses: ['exit 0'] }))
  const okLine = withOk.split('\n').find((line) => line.startsWith('status='))
  assert.ok(Buffer.byteLength(okLine, 'utf8') <= 80, 'status=ok 行必须 ≤80 字节，实际 ' + Buffer.byteLength(okLine, 'utf8'))
  // 失败路径：首错行本身受 200 字符上限约束（中文按 3 字节算 ≈600）。
  const withError = buildReceipt(baseArgs({ statuses: ['exit 1'], errorLine: 'Error: 失败原因'.repeat(30) }))
  const statusLine = withError.split('\n').find((line) => line.startsWith('status='))
  const prefix = 'status=fail（首错：'
  const body = statusLine.slice(prefix.length, -1)
  assert.ok(body.length <= 200 + '…（截断）'.length, '首错正文 ≤200 字符，实际 ' + body.length)
  assert.ok(Buffer.byteLength(statusLine, 'utf8') <= 80 + 200 * 3 + 40, 'status 行有界')
})
