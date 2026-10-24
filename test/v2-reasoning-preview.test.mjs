/**
 * P0-2（beta.9）推理段不回灌回归（N-5）。
 *
 * 缺陷形态（beta.8 树）：buildOperationBody 把助手推理块以 `[推理]` 段头写进
 * 操作正文，回注预览从正文头部取样——beta.6 会话实测回注预览开头是旧推理摘录。
 * 预览两处入口都必须过滤：v2 适配器（client-adapter 的 previewById）与
 * normalizeRecallPayload 的 displayPreview（v1/灵枢 T2 服务端 content）。
 *
 * 边界（任务书 P0-2）：按 record id 的精确回读**不滤**——推理段随原文保留，
 * 只是预览面不再展示。全部使用临时隔离目录。
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createV2ClientFactory } from '../src/v2/client-adapter.mjs'
import { createLocalLexicalBackend } from '../src/v2/local-lexical-backend.mjs'
import { syncRetrievalIndex } from '../src/v2/retrieval.mjs'
import { v2SessionDirectoryFor } from '../src/v2/store.mjs'
import { readRecordById } from '../src/v2/readback.mjs'
import { displayPreview, normalizeRecallPayload } from '../src/core.mjs'

const REASONING_MARK = '内部推演密语：先验证 A 的极性再校准 B 的相位'
const OMITTED_NOTE = '（推理段已省略，原文可按 id 回读）'

/** 与 buildOperationBody（v2/history.mjs）同形的操作正文夹具。 */
const OPERATION_BODY = [
  '已完成配置检查，结论是安全。',
  '[推理]',
  REASONING_MARK,
  '[工具] fs.read',
  '参数：{"path":"config.yaml"}',
  '[结果]',
  '读取成功：42 字节。',
].join('\n\n')

test('displayPreview：含 [推理] 段的正文，预览无推理正文且有一行省略说明', () => {
  const preview = displayPreview(OPERATION_BODY)
  assert.ok(!preview.includes(REASONING_MARK), '推理正文不得进预览：' + preview)
  assert.ok(preview.includes(OMITTED_NOTE), '省略说明必须出现：' + preview)
  assert.ok(preview.includes('已完成配置检查'), '非推理正文照常进预览：' + preview)
})

test('displayPreview：无 [推理] 段头的文本原样预览（assistant 正文不误伤）', () => {
  const body = '普通助手正文，没有段头标记。'
  assert.equal(displayPreview(body), '普通助手正文，没有段头标记。')
})

test('normalizeRecallPayload：v1/灵枢 T2 服务端 content 的预览同样过滤', () => {
  const payload = { ok: true, results: [{ id: 'x1', content: OPERATION_BODY }] }
  const normalized = normalizeRecallPayload(payload)
  assert.equal(normalized.status, 'ok')
  assert.equal(normalized.summaries.length, 1)
  const preview = normalized.summaries[0].preview
  assert.ok(!preview.includes(REASONING_MARK), '推理正文不得进预览：' + preview)
  assert.ok(preview.includes(OMITTED_NOTE), '省略说明必须出现：' + preview)
})

test('v2 适配器：recall 命中项的 preview/content 无推理正文，精确回读仍有', async (t) => {
  const labRoot = await mkdtemp(path.join(tmpdir(), 'mcl-reasoning-'))
  const sessionId = 'sess-' + path.basename(labRoot).slice(-12)
  const directory = v2SessionDirectoryFor(labRoot, sessionId)
  const backend = createLocalLexicalBackend({ directory })
  const factory = createV2ClientFactory({ labRoot, sessionId, logger: null, backendFor: () => backend })
  const client = await factory.createClient()
  t.after(async () => {
    await client.close()
    await rm(labRoot, { recursive: true, force: true })
  })
  await client.rememberArchived({ nodeId: 'node-op-1', text: OPERATION_BODY, range: { start: 20, end: 24 }, tools: ['fs.read'], callIds: ['call_1'], contentHash: 'h-op-1' })
  await factory.withStore(async (store) => {
    const stats = await syncRetrievalIndex({ directory: store.directory, backend, store })
    assert.equal(stats.indexedNow, 1)
  })

  const call = await client.recall('配置检查', null, 5)
  assert.ok(call.hits.length >= 1, '命中面必须非空：' + JSON.stringify(call.matchedBy))
  for (const hit of call.hits) {
    assert.ok(!hit.preview.includes(REASONING_MARK), '推理正文不得进命中 preview：' + hit.preview)
    assert.ok(!hit.content.includes(REASONING_MARK), '推理正文不得进命中 content：' + hit.content)
  }
  assert.ok(
    call.hits.some((hit) => hit.preview.includes(OMITTED_NOTE) || hit.content.includes(OMITTED_NOTE)),
    '命中项必须携带省略说明，模型才知道推理段存在且可回读：' + JSON.stringify(call.hits.map((hit) => hit.preview)),
  )

  // 精确回读不滤：按 record id 回读原文，推理段仍在。
  // 客户端已持有本目录句柄，readRecordById 必须借同一句柄（EOPEN 失败关闭）。
  const exactRead = await factory.withStore(async (store) => {
    const { entries } = store.listEntries({ limit: 10 })
    const recordId = entries[0]?.id ?? null
    if (!recordId) return null
    return readRecordById(labRoot, sessionId, recordId, { verifyHash: false, store })
  })
  assert.ok(exactRead && exactRead.ok !== false, '精确回读必须成功')
  assert.ok(exactRead.payloadText.includes(REASONING_MARK), '精确回读不得过滤推理段')
})
