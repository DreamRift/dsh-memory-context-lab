/**
 * AUD50-02-04（B2-2）：tool-call 块只认 callId → 兼容真实宿主块形状 {type,id,name,arguments}。
 *
 * 真实宿主（dsh-agent-loop）的 assistant/message 内容块没有 callId 字段，id 才是
 * 调用标识；旧实现只认 block.callId，真实快照 67/67 条 assistant 记录的
 * structure.toolCalls[].callId 为空，restore 文本丢失 (call_x) 标注。
 * 修法：callId = block.callId 或 block.id（空串按缺失；两者同时在优先 callId）；
 * 去重键用解析后的 callId；name/arguments 照旧脱敏，text 不变。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createV3Runtime } from '../src/v3/composition/composition.mjs'
import { createArchiveService } from '../src/v3/application/archive.mjs'
import { extractEventBody } from '../src/v3/entry/v3-entry.mjs'
import { createFakeSession } from './helpers/fake-session.mjs'
import { seqOfDshEventId } from '../src/v3/adapters/host/dsh-host.mjs'

const assistantWith = (blocks) => ({
  type: 'assistant/message',
  data: { message: { content: blocks }, source: { kind: "assistant" } },
})

test('B2-2 真实形状 {type,id,name,arguments}：callId 取自 id', () => {
  const body = extractEventBody(assistantWith([
    { type: 'text', text: '读取文件' },
    { type: 'tool-call', id: 'call_x', name: 'read', arguments: { path: 'a.txt' } },
  ]))
  assert.equal(body.structure.toolCalls.length, 1)
  assert.equal(body.structure.toolCalls[0].callId, 'call_x')
  assert.equal(body.structure.toolCalls[0].name, 'read')
  assert.deepEqual(body.structure.toolCalls[0].arguments, { path: 'a.txt' })
  assert.equal(body.text, '读取文件', 'text 不变')
})

test('B2-2 同 id 重复块去重；callId 与 id 同时在优先 callId；旧夹具（只有 callId）不回退', () => {
  const dedup = extractEventBody(assistantWith([
    { type: 'tool-call', id: 'call_d', name: 'read', arguments: { path: 'a' } },
    { type: 'tool-call', id: 'call_d', name: 'read', arguments: { path: 'b' } },
  ]))
  assert.equal(dedup.structure.toolCalls.length, 1, '同 id 只留一条')

  const priority = extractEventBody(assistantWith([
    { type: 'tool-call', callId: 'call_real', id: 'call_other', name: 'read', arguments: {} },
  ]))
  assert.equal(priority.structure.toolCalls[0].callId, 'call_real', 'callId 优先')

  const legacy = extractEventBody(assistantWith([
    { type: 'tool-call', callId: 'call_old', name: 'bash', arguments: '{"cmd":"ls"}' },
  ]))
  assert.equal(legacy.structure.toolCalls[0].callId, 'call_old', '旧夹具形状不回退')

  const missing = extractEventBody(assistantWith([
    { type: 'tool-call', name: 'bash', arguments: '{}' },
  ]))
  assert.equal(missing.structure.toolCalls[0].callId, '', 'id/callId 都缺时按缺失处理')
})

test('B2-2 端到端：restore 文本包含 (call_x)', async () => {
  const root = await mkdtemp(path.join(tmpdir(), "mcl-callid-"))
  const session = createFakeSession({ cwd: "C:\\ws", contextWindow: 100000 })
  session.pushUser('帮我读文件'.repeat(20))
  // 真实宿主形状：块用 id 而不是 callId
  session.append('assistant/message', {
    message: { role: 'assistant', content: [
      { type: 'text', text: '好的，读取 a.txt' },
      { type: 'tool-call', id: 'call_x', name: 'read', arguments: JSON.stringify({ path: 'a.txt' }) },
    ] },
    source: { kind: 'assistant' },
  })
  session.pushToolResult('call_x', '文件内容'.repeat(80))
  session.pushUser('当前问题'.repeat(5))
  const runtime = await createV3Runtime({ v3Root: root, dshSession: session, sessionKey: 's-callid' })
  try {
    await runtime.handleDshEventBatch(session.log.map((event) => {
      const body = extractEventBody(event)
      return {
        event,
        text: body.text,
        meta: { metaOnly: body.metaOnly === true, metaReason: body.reason ?? "", structure: body.structure },
      }
    }))
    const ids = await runtime.store.listRecordIds()
    let callRecord = null
    for (const id of ids) {
      const record = await runtime.store.readRecord(id)
      if (record.payload?.structure?.toolCalls !== undefined) callRecord = record
    }
    assert.ok(callRecord, 'assistant 记录必须带 structure.toolCalls')
    assert.equal(callRecord.payload.structure.toolCalls[0].callId, 'call_x')

    const seqMap = new Map()
    for (const recordId of await runtime.store.listRecordIds()) {
      const provenance = await runtime.store.readProvenance(recordId)
      const seq = seqOfDshEventId(provenance?.sourceEventId)
      if (seq !== null) seqMap.set(seq, recordId)
    }
    const archive = createArchiveService({ store: runtime.store, host: runtime.host, clock: { now: () => 1 } })
    const result = await archive.archiveOnce({
      sessionId: 's-callid',
      events: session.log,
      surfaceNodes: await runtime.host.surfaceNodes(),
      seqToRecordId: seqMap,
      mode: 'full-history',
      maxOperations: 1,
    })
    assert.equal(result.status, 'archived', JSON.stringify(result))
    const restored = await archive.restoreVoucher(0)
    assert.equal(restored.restored, true, JSON.stringify(restored))
    const text = await runtime.host.surfaceTextAt((await runtime.host.surfaceNodes())[0])
    assert.match(text, /read\(call_x\)/, "restore 文本必须带回 (callId) 标注")
  } finally {
    runtime.close()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})
