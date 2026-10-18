/**
 * P0-5 投影头：率与失真必须同时声明（0.12.0）。
 *
 * 灵枢统一架构 v1.2 P5-3：**率与失真同时声明**，缺一即违规。修复前所有回执/卡片
 * 只声明「省了多少」（`原 ≈N token`、`释放 ≈M token`），从不声明失真等级与取回
 * 代价——模型收到「省了 3968 token」却不知道这段是 A 类（可完整重建）、取回要花多少。
 *
 * 三类回执都必须有投影头：操作回执（format 6）、片段回执（format 7）、折叠回执、
 * 聚合凭证。失真等级只有 A 类；构造 B 类必须被拒。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildProjectionHeader,
  buildReceipt,
  buildSpanReceipt,
  PROJECTION_HEADER_MAX_CHARS,
  PROJECTION_KIND,
  RECEIPT_FORMAT_LEGACY,
  RECEIPT_FORMAT_OPERATION,
  RECEIPT_FORMAT_SPAN,
  RECEIPT_FORMAT_SPAN_V2,
  RECEIPT_FORMAT_VERSION,
  V2_RECEIPT_MARKER,
} from '../src/core.mjs'
import { renderFoldReceipt } from '../src/v2/card-fold.mjs'
import { renderVoucherText } from '../src/v2/agg-voucher.mjs'

const operationArgs = () => ({
  tools: ['read'],
  range: { start: 10, end: 12 },
  callIds: ['call_1'],
  nodeId: 'mcl2-aaaabbbbcccc-000001',
  hash: 'deadbeefdeadbeef',
  chars: 15805,
  tokens: 3968,
  marker: V2_RECEIPT_MARKER,
  formatVersion: RECEIPT_FORMAT_OPERATION,
  releasedTokens: 3968,
})

const spanArgs = () => ({
  label: '助手消息',
  range: { start: 20, end: 20 },
  nodeId: 'mcl2-aaaabbbbcccc-000002',
  hash: 'cafebabecafebabe',
  chars: 2400,
  tokens: 800,
  marker: V2_RECEIPT_MARKER,
  formatVersion: RECEIPT_FORMAT_SPAN_V2,
  releasedTokens: 800,
})

test('P0-5a 投影头形状：A 类 + 释放 token/字 + 取回代价，单行且不超过上限', () => {
  const line = buildProjectionHeader({ releasedTokens: 3968, releasedChars: 15805, readbackTokens: 1200 })
  assert.match(line, /^投影：A 类（可完整重建）｜释放 ≈3968 token \/ 15805 字｜取回 ≈1200 token$/)
  assert.ok(line.length <= PROJECTION_HEADER_MAX_CHARS, '投影头 ≤120 字符')
  assert.equal(line.includes('\n'), false, '投影头必须单行')
})

test('P0-5b 构造 B 类必须被拒（本项目不做有损投影）', () => {
  assert.equal(PROJECTION_KIND.EXACT, 'A')
  assert.throws(() => buildProjectionHeader({ kind: 'B', releasedTokens: 1, releasedChars: 1 }), /B 类有损投影被禁止/)
  assert.throws(() => buildProjectionHeader({ kind: 'A-lossy' }), /B 类有损投影被禁止/)
})

test('P0-5c 取回代价缺失时如实省略，不猜一个数', () => {
  const line = buildProjectionHeader({ releasedTokens: 100, releasedChars: 400 })
  assert.equal(line.includes('取回'), false)
  assert.match(line, /释放 ≈100 token \/ 400 字/)
})

test('P0-5d 操作回执（format 6）带投影头与可回读动作行', () => {
  const text = buildReceipt(operationArgs())
  const lines = text.split('\n')
  assert.equal(lines[0], V2_RECEIPT_MARKER)
  assert.match(lines[1], /^投影：A 类（可完整重建）｜释放 ≈3968 token \/ 15805 字｜取回 ≈3968 token$/)
  assert.ok(text.includes('可回读：memory_lab_recall(record_ids=["mcl2-aaaabbbbcccc-000001"])｜A 类可完整重建'), text)
  assert.ok(text.includes('命令面：/memory-lab2 read mcl2-aaaabbbbcccc-000001'), '命令形式仍在（给人看）')
  // 旧文案「相关提问会自动回注要点」在真实会话里一次都没兑现，新格式不再重复声明。
  assert.equal(text.includes('自动回注要点'), false)
})

test('P0-5e 片段回执（format 7）同样带投影头与可回读行', () => {
  const text = buildSpanReceipt(spanArgs())
  assert.match(text.split('\n')[1], /^投影：A 类（可完整重建）｜释放 ≈800 token \/ 2400 字｜取回 ≈800 token$/)
  assert.ok(text.includes('memory_lab_recall(record_ids=["mcl2-aaaabbbbcccc-000002"])'))
})

test('P0-5f 折叠回执与聚合凭证也有投影头（三类回执都要声明率与失真）', () => {
  const fold = renderFoldReceipt({ startSeq: 2, endSeq: 4, memberSeqs: [2, 3, 4], forms: ['working-set', 'working-set'], chars: 900, tokens: 300 })
  assert.match(fold.split('\n')[1], /^投影：A 类（可完整重建）｜释放 ≈300 token \/ 900 字/)
  const voucher = renderVoucherText({
    voucherId: 'agg-1-3-abcdef',
    startSeq: 1,
    endSeq: 3,
    memberCount: 3,
    recordCount: 2,
    toolHistogram: { read: 2 },
    tokensEstimate: 1500,
    chars: 4200,
  })
  assert.match(voucher.split('\n')[1], /^投影：A 类（可完整重建）｜释放 ≈1500 token \/ 4200 字/)
})

test('P0-5g 旧格式（format 1/2/4 与片段 5）**不**因新格式而漂移（恢复必须逐字节相等）', () => {
  const legacy = buildReceipt({ ...operationArgs(), formatVersion: RECEIPT_FORMAT_LEGACY, releasedTokens: null })
  assert.equal(legacy.includes('投影：'), false, 'format 1 不得出现投影头')
  assert.equal(legacy.includes('可回读：'), false)
  const v4 = buildReceipt({ ...operationArgs(), formatVersion: RECEIPT_FORMAT_VERSION, releasedTokens: null })
  assert.equal(v4.includes('投影：'), false, 'format 4 不得出现投影头')
  assert.ok(v4.includes('记录 ID：'), 'format 4 仍用旧的「记录 ID：」行')
  const span5 = buildSpanReceipt({ ...spanArgs(), formatVersion: RECEIPT_FORMAT_SPAN, releasedTokens: null })
  assert.equal(span5.includes('投影：'), false)
  assert.ok(span5.includes('正文已沉入本会话隔离冷库；相关提问会自动回注要点。'), '旧片段回执字节不变')
})

test('P0-5h 投影头字节上限生效：超长输入时先丢取回段，再丢字数列', () => {
  const huge = buildProjectionHeader({ releasedTokens: 123456789, releasedChars: 987654321, readbackTokens: 555555555 })
  assert.ok(huge.length <= PROJECTION_HEADER_MAX_CHARS, '仍必须 ≤120 字符：' + huge)
  const noChars = buildProjectionHeader({ releasedTokens: 1e15, releasedChars: 1e15, readbackTokens: 1e15 })
  assert.ok(noChars.length <= PROJECTION_HEADER_MAX_CHARS)
})
