/**
 * 遗忘/撤销（M3）：账本追加 revoke、读路径恢复、索引重建后可见。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createV3Runtime } from '../src/v3/composition/composition.mjs'
import { createFakeSession } from './helpers/fake-session.mjs'
import { textOfDshEvent } from '../src/v3/entry/v3-entry.mjs'

test('forget → EFORGOTTEN；revoke → 可读且索引重建可见', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-forget-'))
  const session = createFakeSession()
  session.pushUser('可遗忘的第一句')
  session.pushAssistant('可遗忘的第一答')
  const runtime = await createV3Runtime({ v3Root: root, dshSession: session, sessionKey: 's-forget' })
  try {
    await runtime.handleDshEventBatch(session.log.map((event) => ({ event, text: textOfDshEvent(event), meta: {} })))
    const ids = await runtime.store.listRecordIds()
    assert.equal(ids.length, 2)
    const target = ids[0]

    await runtime.store.forget([target])
    assert.ok((await runtime.store.listForgotten()).includes(target))
    await assert.rejects(() => runtime.store.readRecord(target), (error) => error.code === 'EFORGOTTEN')
    const hit = await runtime.provider.search('可遗忘', { allowRebuild: true })
    assert.equal(hit.display.some((row) => row.id === target), false, '遗忘后检索面不可见')

    await runtime.store.revokeForget([target])
    assert.equal((await runtime.store.listForgotten()).includes(target), false)
    const record = await runtime.store.readRecord(target)
    assert.match(record.payload.text, /可遗忘/)
    const hit2 = await runtime.provider.search('可遗忘', { allowRebuild: true })
    assert.equal(hit2.display.some((row) => row.id === target), true, '撤销后索引重建可见')

    await assert.rejects(() => runtime.store.forget(['v3r-not-exist']), (error) => error.code === 'ESTORE_TXN_CONFLICT')
    await assert.rejects(() => runtime.store.revokeForget(['v3r-not-exist']), (error) => error.code === 'ESTORE_TXN_CONFLICT')
  } finally {
    runtime.close()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})