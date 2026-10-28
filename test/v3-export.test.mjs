/**
 * M5 分享面（本地红导出）：已遗忘正文不导出；导出包可读、可审计。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { buildExportBundle } from '../src/v3/domain/export/bundle.mjs'
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