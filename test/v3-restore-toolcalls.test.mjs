/**
 * B-1（0.14.0-beta.48）：归档恢复必须带回工具调用参数。
 *
 * 真实宿主把工具调用放在 assistant/message 的 content 块（type='tool-call'），
 * 而 tool/call 事件本身不在活动面。旧实现只取 text 块：27/27 凭证、81 次调用、
 * 105,975 字参数在 restore 后不可恢复。修法 A：摄入侧把调用块（脱敏后）写进
 * payload.structure.toolCalls，text 不变；restore 依据 structure 渲染确定性块。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createV3Runtime } from '../src/v3/composition/composition.mjs'
import { createArchiveService } from '../src/v3/application/archive.mjs'
import { extractEventBody, textOfDshEvent } from '../src/v3/entry/v3-entry.mjs'
import { createFakeSession } from './helpers/fake-session.mjs'
import { seqOfDshEventId } from '../src/v3/adapters/host/dsh-host.mjs'

async function ingest(session, runtime) {
  // 走与引擎摄入相同的事件正文/结构映射（structure 由 extractEventBody 产出）。
  await runtime.handleDshEventBatch(session.log.map((event) => {
    const body = extractEventBody(event)
    return {
      event,
      text: body.text,
      meta: {
        metaOnly: body.metaOnly === true,
        metaReason: body.reason ?? '',
        structure: body.structure,
      },
    }
  }))
}

async function seqMapOf(store) {
  const map = new Map()
  for (const recordId of await store.listRecordIds()) {
    const provenance = await store.readProvenance(recordId)
    const seq = seqOfDshEventId(provenance?.sourceEventId)
    if (seq !== null) map.set(seq, recordId)
  }
  return map
}

test('assistant 工具调用块：structure.toolCalls 落库（脱敏、同 callId 去重），text 不变', () => {
  const body = extractEventBody({
    type: 'assistant/message',
    data: {
      message: {
        content: [
          { type: 'text', text: '准备读取' },
          { type: 'tool-call', callId: 'c1', name: 'read', arguments: JSON.stringify({ path: 'a.txt', token: 'sk-abcdefghijklmnop' }) },
          { type: 'tool-call', callId: 'c1', name: 'read', arguments: '{"path":"dup"}' },
        ],
      },
    },
  })
  assert.equal(body.text, '准备读取', 'text 只含可见文本（索引/净收益判据不变）')
  assert.equal(body.metaOnly, undefined)
  assert.equal(body.structure.toolCalls.length, 1, '同 callId 只留一条')
  assert.equal(body.structure.toolCalls[0].name, 'read')
  assert.equal(body.structure.toolCalls[0].arguments.path, 'a.txt')
  assert.equal(body.structure.toolCalls[0].arguments.token, '[REDACTED]', '参数与 tool/call 同一套脱敏口径')

  const onlyCall = extractEventBody({
    type: 'assistant/message',
    data: { message: { content: [{ type: 'tool-call', callId: 'c2', name: 'bash', arguments: '{"cmd":"ls"}' }] } },
  })
  assert.equal(onlyCall.text, '')
  assert.equal(onlyCall.metaOnly, true)
  assert.equal(onlyCall.structure.toolCalls[0].arguments.cmd, 'ls', 'metaOnly 仍需保留结构（恢复面要用）')
})

test('归档恢复：restore 带回工具名与参数，且不把参数混进 text/sourceChars', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-toolcall-'))
  const session = createFakeSession({ cwd: 'C:\\ws', contextWindow: 100000 })
  session.pushUser('帮我读文件'.repeat(20))
  session.pushAssistantWithToolCall('好的，读取 a.txt', 'c1', 'read', { path: 'a.txt', token: 'sk-abcdefghijklmnop' })
  session.pushToolResult('c1', '文件内容'.repeat(80))
  session.pushUser('当前问题'.repeat(5))
  const runtime = await createV3Runtime({ v3Root: root, dshSession: session, sessionKey: 's-toolcall' })
  try {
    await ingest(session, runtime)
    const ids = await runtime.store.listRecordIds()
    let callRecord = null
    for (const id of ids) {
      const record = await runtime.store.readRecord(id)
      if (record.payload?.structure?.toolCalls !== undefined) callRecord = record
    }
    assert.ok(callRecord, 'assistant 工具调用记录必须带 structure.toolCalls')
    assert.equal(callRecord.payload.text, '好的，读取 a.txt', 'text 不含参数')
    assert.equal(callRecord.payload.structure.toolCalls[0].arguments.token, '[REDACTED]')

    const archive = createArchiveService({ store: runtime.store, host: runtime.host, clock: { now: () => 1 } })
    const seqToRecordId = await seqMapOf(runtime.store)
    const result = await archive.archiveOnce({
      sessionId: 's-toolcall',
      events: session.log,
      surfaceNodes: await runtime.host.surfaceNodes(),
      seqToRecordId,
      mode: 'full-history',
      maxOperations: 1,
    })
    assert.equal(result.status, 'archived', JSON.stringify(result))
    assert.equal(result.receiptText.includes('111'), false)
    const restored = await archive.restoreVoucher(0)
    assert.equal(restored.restored, true, JSON.stringify(restored))
    const text = await runtime.host.surfaceTextAt((await runtime.host.surfaceNodes())[0])
    assert.match(text, /好的，读取 a.txt/)
    assert.match(text, /\[工具调用\]/, '恢复正文必须含确定性工具调用块')
    assert.match(text, /read\(c1\)/, '必须带回工具名与 callId')
    assert.match(text, /a\.txt/, '必须带回参数')
    assert.doesNotMatch(text, /sk-abcdefghijklmnop/, '恢复正文不得出现未脱敏凭据')
  } finally {
    runtime.close()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})
