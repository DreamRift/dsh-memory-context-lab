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
import { readArchiveIntent, writeArchiveIntent, clearArchiveIntent } from '../src/v3/adapters/storage/archive-intent.mjs'
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
/**
 * 审计 C-A（beta.46 排查）：surface replace 的失败不一定等于「surface 没变」。
 * dsh-host 的 surfaceOp 先 appendReceipt、再校验 eventAt/被遮蔽节点，失败时抛错——
 * 此时活动面已有回执、凭证还没写。旧实现把这个 catch 当成「没变」并清掉 intent，
 * 于是回执永远没有凭证（history=0），连对账线索也没了。修法：保留 intent。
 */
test('commit 表面失败（宿主 append 后抛错）保留 intent，恢复面对账补 voucher', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-archive-intent-'))
  const session = createFakeSession({ cwd: 'C:\\ws', contextWindow: 100000 })
  session.pushUser('第一问'.repeat(60))
  session.pushAssistant('第一答'.repeat(60))
  session.pushUser('第二问'.repeat(60))
  session.pushAssistant('第二答'.repeat(60))
  session.pushUser('当前问题'.repeat(10))
  const runtime = await createV3Runtime({ v3Root: root, dshSession: session, sessionKey: 's-intent' })
  try {
    await ingest(session, runtime)
    const journal = {
      write: (data) => writeArchiveIntent(root, 's-intent', data),
      read: () => readArchiveIntent(root, 's-intent'),
      clear: () => clearArchiveIntent(root, 's-intent'),
    }
    // 宿主行为：replace 已经生效，随后确认面失败 → 抛错（真实 dsh-host 的失败路径之一）。
    const hostAfterAppendFailure = {
      ...runtime.host,
      surfaceOp: async (args) => {
        await runtime.host.surfaceOp(args)
        throw new Error('模拟宿主确认面失败（append 已生效）')
      },
    }
    const archive = createArchiveService({ store: runtime.store, host: hostAfterAppendFailure, clock: { now: () => 1 }, intent: journal })
    const seqToRecordId = await seqMapOf(runtime.store)
    const result = await archive.archiveOnce({
      sessionId: 's-intent', events: session.log, surfaceNodes: await runtime.host.surfaceNodes(), seqToRecordId, mode: 'full-history', maxOperations: 1,
    })
    assert.equal(result.status, 'failed', JSON.stringify(result))
    assert.equal(result.phase, 'surface')
    assert.equal(result.intentKept, true, 'surface 失败必须保留 intent（不得假设 surface 没变）')
    assert.equal((await runtime.store.listVouchers()).length, 0, '凭证还没写')
    const nodes = await runtime.host.surfaceNodes()
    assert.notDeepEqual(nodes, [0, 1, 2, 3, 4], '宿主已把 span 替换成回执')
    const retained = await readArchiveIntent(root, 's-intent')
    assert.equal(retained?.receiptText, result.span.receiptText, 'intent 必须能定位那条回执')
    const recovered = await archive.recoverIntent({
      sessionId: 's-intent', surfaceNodes: nodes, surfaceTextOf: (seq) => runtime.host.surfaceTextAt(seq),
    })
    assert.equal(recovered.recovered, true, JSON.stringify(recovered))
    assert.equal((await runtime.store.listVouchers()).length, 1, '对账必须补上凭证，回执才可恢复')
    assert.equal(await readArchiveIntent(root, 's-intent'), null, '补成功后清 intent')
    assert.equal((await archive.history()).total, 1)
  } finally {
    runtime.close()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})

/**
 * 审计 C-C：崩溃窗口「voucher 已追加、intent 未清」会重新进入 recoverIntent。
 * 旧实现无条件再追加一条同 ID 凭证（v-9 / v-9），history 与 restoreAll 的下标全部失真。
 */
test('崩溃窗口：voucher 已追加、intent 未清 → 恢复不产生重复凭证', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-archive-dup-'))
  const session = createFakeSession()
  const runtime = await createV3Runtime({ v3Root: root, dshSession: session, sessionKey: 's-dup' })
  try {
    const journal = {
      write: (data) => writeArchiveIntent(root, 's-dup', data),
      read: () => readArchiveIntent(root, 's-dup'),
      clear: () => clearArchiveIntent(root, 's-dup'),
    }
    const receiptText = '[记忆上下文] 已把 2 条已完成历史（seq 0–1）归档为可恢复回执。'
    await journal.write({ schemaVersion: 1, sessionId: 's-dup', startSeq: 0, endSeq: 1, sourceEventSeqs: [0, 1], recordIds: [], receiptText, createdAt: 1 })
    await runtime.store.appendVoucher({ schemaVersion: 2, voucherId: 'v-9', kind: 'span', recordIds: [], sourceEventSeqs: [0, 1], startSeq: 0, endSeq: 1, targetEventId: 9, receiptText, txn: 5 })
    const host = { async surfaceNodes() { return [9] }, async surfaceTextAt() { return receiptText }, async surfaceOp() { return { seq: 10 } } }
    const archive = createArchiveService({ store: runtime.store, host, clock: { now: () => 1 }, intent: journal })
    const recovered = await archive.recoverIntent({ sessionId: 's-dup', surfaceNodes: [9], surfaceTextOf: async () => receiptText })
    assert.equal(recovered.recovered, true, JSON.stringify(recovered))
    assert.equal(recovered.duplicateSkipped, true)
    assert.equal((await runtime.store.listVouchers()).length, 1, '同 ID 凭证不得重复追加')
    assert.equal(await readArchiveIntent(root, 's-dup'), null)
  } finally {
    runtime.close()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})
/**
 * C-D / C-E（0.14.0-beta.48）：崩溃恢复必须按 intent 的模式分流，并沿用 intent 的事务号。
 * 旧实现无条件写回合级 lastArchiveEndSeq（按步归档也写，切回按轮后早于该 seq 的回合被跳过），
 * 恢复凭证还硬编码 txn:1（与真实事务号脱节，按 txn 回溯对不上）。
 */
test('崩溃恢复：intent.mode=cooling 时不写回合位点；凭证沿用 intent.txn', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-archive-mode-'))
  const session = createFakeSession()
  const runtime = await createV3Runtime({ v3Root: root, dshSession: session, sessionKey: 's-mode' })
  try {
    const journal = {
      write: (data) => writeArchiveIntent(root, 's-mode', data),
      read: () => readArchiveIntent(root, 's-mode'),
      clear: () => clearArchiveIntent(root, 's-mode'),
    }
    const receiptText = '[记忆上下文] 已把 2 条已完成历史（seq 0–1）归档为可恢复回执。'
    await journal.write({
      schemaVersion: 1, sessionId: 's-mode', mode: 'cooling', txn: 7,
      startSeq: 0, endSeq: 1, sourceEventSeqs: [0, 1], recordIds: [], receiptText, createdAt: 1,
    })
    const host = {
      async surfaceNodes() { return [9] },
      async surfaceTextAt() { return receiptText },
      async surfaceOp() { return { seq: 10 } },
    }
    const archive = createArchiveService({ store: runtime.store, host, clock: { now: () => 1 }, intent: journal })
    const recovered = await archive.recoverIntent({ sessionId: 's-mode', surfaceNodes: [9], surfaceTextOf: async () => receiptText })
    assert.equal(recovered.recovered, true, JSON.stringify(recovered))
    assert.equal(recovered.mode, 'cooling', '恢复结果必须带出模式，供入口决定写哪个位点')
    const voucher = (await runtime.store.listVouchers())[0]
    assert.equal(voucher.txn, 7, '凭证事务号必须沿用 intent.txn（不再硬编码 1）')
    assert.equal(await readArchiveIntent(root, 's-mode'), null)
  } finally {
    runtime.close()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})
