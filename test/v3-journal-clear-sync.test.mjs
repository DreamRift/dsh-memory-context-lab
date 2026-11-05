/**
 * AUD51-05-03（0.14.0-beta.53）：`journal.clear()` 的同步实现不得把成功归档变成异常。
 *
 * ## 缺陷
 * `commitPlanned` 旧写法是 `await journal.clear().catch(() => {})`。它假设 clear 一定
 * 返回 Promise；当 intent 日志的实现是**同步**的（返回 undefined，或用例里常见的
 * 同步桩），`undefined.catch` 直接抛 TypeError——归档已经落面、凭证已经写好，
 * 却因为一个「收尾清场」动作把整个调用变成失败，调用方会误以为没归档。
 *
 * ## 修法
 * 同一处实现改成分支判 await：只有真 Promise 才 await；同步返回/同步抛错都吞掉
 * （清 intent 是 best-effort，下一次 pre-step 对账会再清一次）。
 *
 * ## 断言组
 * 1. 同步 clear（返回 undefined）+ 正常归档 → status 仍是 archived（不因收尾抛错变 failed）；
 * 2. 同步 clear 抛错 → 仍 archived（best-effort 语义：清不掉不等于归档没发生）；
 * 3. Promise clear（reject）→ 仍 archived；
 * 4. Promise clear（resolve）→ archived，且 clear 真的被调用过一次（不漏清）。
 *
 * ## 定点变异自证
 * 把 clearIntentOf 换回 `journal.clear().catch(() => {})` → 第 1 组红（TypeError）。
 */
import { randomUUID } from 'node:crypto'
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

async function withArchive(body) {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-v3-journal-clear-'))
  const session = createFakeSession({ cwd: 'C:\\ws', contextWindow: 100000 })
  session.pushUser('第一问'.repeat(60))
  session.pushAssistant('第一答'.repeat(60))
  session.pushUser('第二问'.repeat(60))
  session.pushAssistant('第二答'.repeat(60))
  session.pushUser('当前问题'.repeat(10))
  const runtime = await createV3Runtime({ v3Root: root, dshSession: session, sessionKey: 's-journal' })
  try {
    const rows = session.log.map((event) => ({ event, text: textOfDshEvent(event), meta: {} }))
    await runtime.handleDshEventBatch(rows)
    const seqToRecordId = new Map()
    for (const recordId of await runtime.store.listRecordIds()) {
      const provenance = await runtime.store.readProvenance(recordId)
      const seq = seqOfDshEventId(provenance?.sourceEventId)
      if (seq !== null) seqToRecordId.set(seq, recordId)
    }
    const archiveOnce = async (journal) => {
      const archive = createArchiveService({ random: { uuid: () => randomUUID() }, store: runtime.store, host: runtime.host, clock: { now: () => 1 }, intent: journal })
      return await archive.archiveOnce({
        sessionId: 's-journal',
        events: session.log,
        surfaceNodes: await runtime.host.surfaceNodes(),
        seqToRecordId,
        mode: 'full-history',
        maxOperations: 1,
      })
    }
    return await body({ archiveOnce, session, runtime })
  } finally {
    runtime.close()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
}

test('AUD51-05-03 同步 clear（返回 undefined）不把归档变成异常', async () => {
  await withArchive(async ({ archiveOnce }) => {
    const journal = { write: () => undefined, read: () => null, clear: () => undefined }
    const result = await archiveOnce(journal)
    assert.equal(result.status, 'archived', '同步 clear 不得让已落面的归档变失败：' + JSON.stringify(result))
    assert.ok(Number.isInteger(result.receiptSeq), '回执 seq 必须回传')
  })
})

test('AUD51-05-03 同步 clear 抛错仍是 archived（best-effort）', async () => {
  await withArchive(async ({ archiveOnce }) => {
    const journal = { write: () => undefined, read: () => null, clear: () => { throw new Error('同步 clear 失败') } }
    const result = await archiveOnce(journal)
    assert.equal(result.status, 'archived', '清 intent 失败不得改写归档结论：' + JSON.stringify(result))
  })
})

test('AUD51-05-03 Promise clear 的 reject / resolve 两态都归档且只清一次', async () => {
  await withArchive(async ({ archiveOnce }) => {
    const rejecting = { write: () => undefined, read: () => null, clear: () => Promise.reject(new Error('异步 clear 失败')) }
    assert.equal((await archiveOnce(rejecting)).status, 'archived', 'reject 也必须吞掉')

    let calls = 0
    const resolving = { write: () => undefined, read: () => null, clear: () => { calls += 1; return Promise.resolve() } }
    const result = await archiveOnce(resolving)
    assert.equal(result.status, 'archived')
    assert.equal(calls, 1, '成功路径必须真的清一次 intent（不漏清）')
  })
})
