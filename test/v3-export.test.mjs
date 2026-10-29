/**
 * M5 分享面（本地红导出）：已遗忘正文不导出；导出包可读、可审计。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { buildExportBundle } from '../src/v3/domain/export/bundle.mjs'
import { openV3SessionStore } from '../src/v3/adapters/storage/session-store.mjs'
import { attachV3Engine } from '../src/v3/entry/v3-entry.mjs'
import { createFakeSession } from './helpers/fake-session.mjs'

function fakeCtx() {
  const handlers = new Map()
  const ctx = {
    on(name, handler) { handlers.set(name, handler); return () => handlers.delete(name) },
    logger: { warn() {}, info() {} },
  }
  ctx.callPreStep = async (session) => {
    const handler = handlers.get('agent/pre-step')
    return await handler({ agent: { session }, signal: undefined }, async () => ({ kind: 'enter' }))
  }
  return ctx
}

test('buildExportBundle：遗忘记录只留 ID，正文不导出', () => {
  const bundle = buildExportBundle({
    sessionKey: 's',
    records: [
      { id: 'v3r-1', kind: 'message-user', createdAt: 1, payload: { text: 'keep', bytes: 4 }, provenance: { sourceEventId: 'dsh-0', sourceForm: null, transactionId: 't1' } },
      { id: 'v3r-2', kind: 'message-assistant', createdAt: 2, payload: { text: 'secret', bytes: 6 }, provenance: { sourceEventId: 'dsh-1', sourceForm: null, transactionId: 't1' } },
    ],
    forgotten: ['v3r-2'],
  })
  assert.equal(bundle.counts.records, 1)
  assert.equal(bundle.records[0].id, 'v3r-1')
  assert.deepEqual(bundle.forgotten, ['v3r-2'])
  assert.equal(JSON.stringify(bundle).includes('secret'), false)
})

test('engine.exportSession：写文件；遗忘正文不进包', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-export-'))
  const ctx = fakeCtx()
  const engine = attachV3Engine(ctx, { v3Root: root })
  try {
    const session = createFakeSession()
    session.pushUser('可导出')
    session.pushAssistant('可导出答')
    await ctx.callPreStep(session)
    await new Promise((resolve) => setTimeout(resolve, 150))
    await engine._waitForIdle().catch(() => {})
    await new Promise((resolve) => setTimeout(resolve, 50))
    const working = await engine.workingSet('session-fake')
    await engine.forgetRecords('session-fake', [working.rows[1].recordId])
    const result = await engine.exportSession('session-fake')
    assert.equal(result.error, undefined)
    assert.equal(result.counts.records, 1)
    assert.equal(result.counts.forgotten, 1)
    const parsed = JSON.parse(await readFile(result.file, 'utf8'))
    assert.equal(parsed.records.length, 1)
    assert.equal(JSON.stringify(parsed).includes('可导出答'), false)
  } finally {
    await engine._waitForIdle().catch(() => {})
    engine.dispose()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})

/**
 * AUD48-08-02：导出旧实现原样复制 vouchers，compact 摘要（原文首部 ≤220 字）在
 * forget/redact 之后仍随包导出；修法：redactions 命中或 recordIds 与 forgotten
 * 相交的凭证剥掉 receiptText/summaryText。
 * AUD48-08-03：导出/导入保留 metaOnly / structure，否则导入后「仅元数据」记录
 * 被当成空正文损坏、工具调用参数丢失。
 */
test('buildExportBundle：已遗忘/已清除凭证不带走摘要；metaOnly/structure 保留', () => {
  const bundle = buildExportBundle({
    sessionKey: 's',
    records: [
      {
        id: 'v3r-keep',
        kind: 'message-assistant',
        createdAt: 1,
        payload: {
          text: '',
          bytes: 0,
          metaOnly: true,
          metaReason: 'empty',
          structure: { toolCalls: [{ name: 'run', arguments: '{"x":1}' }] },
        },
        provenance: { sourceEventId: null, sourceForm: null, transactionId: null },
      },
      { id: 'v3r-gone', kind: 'message-user', createdAt: 2, payload: { text: 'secret body', bytes: 11 }, provenance: {} },
    ],
    forgotten: ['v3r-gone'],
    vouchers: [
      { voucherId: 'v1', recordIds: ['v3r-gone'], receiptText: '摘要 secret body', summaryText: '摘要 secret body' },
      { voucherId: 'v2', recordIds: ['v3r-keep'], receiptText: '待清除回执', summaryText: '' },
    ],
    redactedVoucherIds: ['v2'],
  })
  assert.equal(bundle.records.length, 1)
  assert.equal(bundle.records[0].payload.metaOnly, true)
  assert.equal(bundle.records[0].payload.metaReason, 'empty')
  assert.equal(bundle.records[0].payload.structure.toolCalls[0].name, 'run')
  const v1 = bundle.vouchers.find((row) => row.voucherId === 'v1')
  const v2 = bundle.vouchers.find((row) => row.voucherId === 'v2')
  assert.equal(v1.receiptText, '', '遗忘记录的摘要不得导出')
  assert.equal(v1.summaryText, '', '遗忘记录的摘要不得导出')
  assert.equal(v1.redacted, true)
  assert.equal(v2.receiptText, '', '已清除凭证的回执不得导出')
  assert.equal(v2.redacted, true)
  assert.equal(bundle.counts.redactedVouchers, 2)
  assert.equal(JSON.stringify(bundle).includes('secret body'), false)
})

test('importRecords：导入保留 metaOnly / structure（AUD48-08-03）', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-import-fields-'))
  const store = await openV3SessionStore(root, 'sess-import')
  try {
    const result = await store.importRecords([{
      kind: 'message-assistant',
      payload: {
        text: '',
        metaOnly: true,
        metaReason: 'empty',
        structure: { toolCalls: [{ name: 'run', callId: 'c1', arguments: '{"x":1}' }] },
      },
    }])
    assert.equal(result.recordIds.length, 1)
    const record = await store.readRecord(result.recordIds[0])
    assert.equal(record.payload.metaOnly, true, 'metaOnly 必须保留：' + JSON.stringify(record.payload))
    assert.equal(record.payload.metaReason, 'empty')
    assert.equal(record.payload.structure.toolCalls[0].name, 'run')
    assert.equal(record.payload.structure.toolCalls[0].arguments, '{"x":1}')
  } finally {
    store.close?.()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})