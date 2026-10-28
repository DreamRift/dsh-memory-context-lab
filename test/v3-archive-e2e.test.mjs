/**
 * 历史归档端到端（M2）：
 * - 真实 composition/runtime + 假 DSH session（surface fold）；
 * - 只归档已完成的第一个操作（当前回合/后续回合不动）；
 * - 回执落面、voucher 可列、restore 回原文、失败不推进。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createV3Runtime } from '../src/v3/composition/composition.mjs'
import { createArchiveService } from '../src/v3/application/archive.mjs'
import { createFakeSession } from './helpers/fake-session.mjs'
import { seqOfDshEventId } from '../src/v3/adapters/host/dsh-host.mjs'
import { textOfDshEvent } from '../src/v3/entry/v3-entry.mjs'

async function ingest(session, runtime) {
  const rows = session.log.map((event) => ({ event, text: textOfDshEvent(event), meta: {} }))
  await runtime.handleDshEventBatch(rows)
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

test('archive e2e：只归档已完成操作、回执落面、restore 回原文', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-archive-'))
  const session = createFakeSession({ cwd: 'C:\\ws', contextWindow: 100000 })
  session.pushUser('第一问'.repeat(60))
  session.pushAssistant('第一答'.repeat(60))
  session.pushUser('第二问'.repeat(60))
  session.pushAssistant('第二答'.repeat(60))
  session.pushUser('当前问题'.repeat(10))
  const runtime = await createV3Runtime({ v3Root: root, dshSession: session, sessionKey: 's-archive' })
  try {
    await ingest(session, runtime)
    const archive = createArchiveService({ store: runtime.store, host: runtime.host, clock: { now: () => 1 }, v3Root: root })
    const seqToRecordId = await seqMapOf(runtime.store)
    assert.equal(seqToRecordId.size, 5)

    const result = await archive.archiveOnce({
      sessionId: 's-archive',
      events: session.log,
      surfaceNodes: await runtime.host.surfaceNodes(),
      seqToRecordId,
      mode: 'full-history',
      maxOperations: 1,
    })
    assert.equal(result.status, 'archived', JSON.stringify(result))
    assert.equal(result.startSeq, 0)
    assert.equal(result.endSeq, 1, '只归档第一个完成操作')
    assert.equal(result.recordIds.length, 2)
    assert.ok(result.receiptText.includes('已把 2 条'))
    const nodes = await runtime.host.surfaceNodes()
    assert.deepEqual(nodes, [5, 2, 3, 4], '回执插在原位置，后续节点保留')
    assert.equal(await runtime.host.surfaceTextAt(5), result.receiptText)

    const vouchers = await runtime.store.listVouchers()
    assert.equal(vouchers.length, 1)
    assert.equal(vouchers[0].targetEventId, 5)
    assert.deepEqual(vouchers[0].sourceEventSeqs, [0, 1])
    assert.deepEqual(vouchers[0].recordIds, result.recordIds)

    const restored = await archive.restoreVoucher(0)
    assert.equal(restored.restored, true, JSON.stringify(restored))
    const after = await runtime.host.surfaceNodes()
    assert.equal(after.length, 4)
    const restoredText = await runtime.host.surfaceTextAt(after[0])
    assert.match(restoredText, /第一问/)
    assert.match(restoredText, /第一答/)
    assert.doesNotMatch(restoredText, /第二问/, '后续未归档回合不得被恢复文本吞入')
  } finally {
    runtime.close()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})

test('archive e2e：当前回合/无记录节点不归档；dry-run 不写', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-archive-'))
  const session = createFakeSession()
  session.pushUser('唯一一问')
  session.pushAssistant('唯一一答')
  const runtime = await createV3Runtime({ v3Root: root, dshSession: session, sessionKey: 's-archive' })
  try {
    await ingest(session, runtime)
    const archive = createArchiveService({ store: runtime.store, host: runtime.host, clock: { now: () => 1 }, v3Root: root })
    const seqToRecordId = await seqMapOf(runtime.store)
    const dry = await archive.dryRun({
      sessionId: 's-archive', events: session.log, surfaceNodes: await runtime.host.surfaceNodes(), seqToRecordId, mode: 'full-history',
    })
    assert.equal(dry.status, 'no-candidate')
    assert.deepEqual(await runtime.host.surfaceNodes(), [0, 1], 'dry-run 不写 surface')
    assert.equal((await runtime.store.listVouchers()).length, 0)
  } finally {
    runtime.close()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})
