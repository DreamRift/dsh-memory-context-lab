/**
 * P1 摄入合同测试（2026-10-25 决策文档 §4.1）：宿主真实事件形状映射。
 *
 * ## 判据来源
 * 宿主 dsh-agent-loop/lib/index.js 核验（2026-10-25，0.2.1-rc.3）：
 * - assistant/message 正文在 data.message.content（createAssistantMessage）；
 * - tool/result 正文在 data.message.content（createToolResultMessage），错误态带 data.error；
 * - tool/call 是结构事件（callId/name/arguments 在顶层，无正文）。
 *
 * ## 断言组
 * - 四类事件正文/结构提取正确；reasoning 块不进正文；
 * - arguments 敏感字段脱敏（token/secret/password/credential/api-key/authorization）；
 * - 空正文 → metadata-only：落库可回读、payload.metaOnly+原因、不进检索索引；
 * - 旧路径（data.content/data.text）不回归。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { extractEventBody } from '../src/v3/entry/v3-entry.mjs'
import { attachV3Engine } from '../src/v3/entry/v3-entry.mjs'

test('P1 提取：assistant/tool-result 正文在 data.message.content；reasoning 块不进正文', () => {
  const a = extractEventBody({ type: 'assistant/message', data: { turn: 1, step: 2, message: { content: [{ type: 'reasoning', text: '内部推理不应入库' }, { type: 'text', text: '面向用户的回答' }] } } })
  assert.equal(a.text, '面向用户的回答')
  assert.ok(!a.metaOnly)
  const tr = extractEventBody({ type: 'tool/result', data: { message: { content: [{ type: 'text', text: '工具输出正文' }] }, error: { info: 'boom' } } })
  assert.ok(tr.text.includes('工具输出正文'))
  assert.ok(tr.text.includes('错误态'), '错误结果如实标注')
})

test('P1 提取：tool/call 结构文本 + 敏感参数脱敏', () => {
  const c = extractEventBody({ type: 'tool/call', data: { callId: 'call-1', name: 'pwsh', arguments: { command: 'echo hi', apiToken: 'sk-secret', nested: { password: 'p', ok: 1 } } } })
  assert.ok(c.text.startsWith('工具调用 pwsh(call-1)：'))
  assert.ok(!c.text.includes('sk-secret'), '敏感值不得入库')
  assert.ok(c.text.includes('[REDACTED]'))
  assert.equal(c.structure.callId, 'call-1')
  assert.equal(c.structure.arguments.nested.password, '[REDACTED]')
  assert.equal(c.structure.arguments.nested.ok, 1)
})

test('P1 提取：空正文 → metadata-only；旧 data.content/data.text 路径保持', () => {
  const empty = extractEventBody({ type: 'assistant/message', data: { message: { content: [{ type: 'image', url: 'x' }] } } })
  assert.equal(empty.metaOnly, true)
  assert.ok(empty.reason.length > 0, '原因可对账')
  const legacy = extractEventBody({ type: 'user/message', data: { content: [{ type: 'text', text: '旧路径' }] } })
  assert.equal(legacy.text, '旧路径')
  const plain = extractEventBody({ type: 'user/message', data: { text: '纯文本路径' } })
  assert.equal(plain.text, '纯文本路径')
})


test('P1 端到端：metadata-only 落库可回读、不进检索索引', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-v3p1-'))
  const events = []
  const session = { id: 's-p1', log: events, surface: { nodes: [] }, append() { return { seq: 0 } }, eventAt() { return null }, deriveMessages() { return [] } }
  // 一条 metadata-only（无可读正文）+ 一条正常 assistant 正文
  events.push({ seq: 0, type: 'assistant/message', data: { message: { content: [{ type: 'image', url: 'x' }] } } })
  events.push({ seq: 1, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'P1 修复后的真实正文' }] } } })
  const handlers = new Map()
  const ctx = { on(n, h) { handlers.set(n, h); return () => {} }, logger: { warn() {}, info() {} } }
  const engine = attachV3Engine(ctx, { v3Root: root })
  try {
    await handlers.get('agent/pre-step')({ agent: { session }, signal: undefined }, async () => ({ kind: 'enter' }))
    await engine._waitForIdle()
    const s = await engine.inspect('s-p1')
    assert.equal(s.health.recordCount, 2, '两类都落库（可对账）')
    // 触发懒重建后：indexedCount 只算可检索的 1 条；metadata-only 可精确回读
    const r = await engine.search('s-p1', 'P1 修复', { limit: 3 })
    assert.ok(r.display.length >= 1)
    const s2 = await engine.inspect('s-p1')
    assert.equal(s2.health.indexedCount, 1, 'metadata-only 不进检索索引')
    const stats = engine.stats()
    assert.ok((stats.ingestMetrics?.['v3.ingest.metadataOnly'] ?? 0) >= 1, 'metadata-only 计数可对账')
  } finally {
    engine.dispose()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})

test('P1 提取：错误态以 message.isError 为准（data.error 可缺省）', () => {
  // 宿主真实形态：非 HarnessError 的普通异常 → isError=true 且 **没有** data.error。
  // 旧实现只看 data.error，于是这类失败被记成成功正文。
  const tr = extractEventBody({ type: 'tool/result', data: { message: { isError: true, content: [{ type: 'text', text: 'Error: boom' }] } } })
  assert.ok(tr.text.includes('Error: boom'))
  assert.ok(tr.text.includes('错误态'), 'isError=true 必须标注错误态')
  const ok = extractEventBody({ type: 'tool/result', data: { message: { isError: false, content: [{ type: 'text', text: 'fine' }] } } })
  assert.equal(ok.text.includes('错误态'), false, '成功结果不得误标错误')
})

test('P1 提取：tool/result 正文过脱敏（凭据不得随工具输出入库）', () => {
  // 工具输出是外部数据：env / curl 头 / 配置文件里的凭据最常见的落点就是正文。
  const tr = extractEventBody({ type: 'tool/result', data: { message: { content: [{ type: 'text', text: 'OPENAI_KEY=sk-live-abcdef123456\nAuthorization: Bearer abcdefghijklmnop' }] } } })
  assert.equal(tr.text.includes('sk-live-abcdef123456'), false, 'sk- 形态必须脱敏')
  assert.equal(tr.text.toLowerCase().includes('bearer abcdefghijklmnop'), false, 'Authorization 头必须脱敏')
  assert.ok(tr.text.includes('[REDACTED]'))
})
