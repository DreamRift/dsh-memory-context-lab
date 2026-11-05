/**
 * P2-19（0.15.1）：`archiveStepBatch` 顶层 `receiptText` 只取第一段、`receiptChars` 却是各段之和。
 *
 * ## 缺陷
 * 多段批量归档的返回里：
 * - `receiptText` = `committed[0].receiptText`（**只有第一段**）；
 * - `receiptChars` = 各段 `receiptText.length` 之**和**。
 *
 * 同一份结果里两个字段量的是两件不同的事：拿到 `receiptText` 的调用方以为它是本批
 * 全部回执（实际只有第一段），任何「按回执长度/内容判断」的用法都会算错；而
 * `receiptChars` 说的大小在这份正文里根本不存在。多段批（pin 切段、阈值切段）必然踩到。
 *
 * ## 判据来源
 * docs/dev-0.15.1/记忆上下文-0.15.1-独立排查报告.md §3.2 P2-19（审读）；
 * 逐段回执见 src/v3/application/archive.mjs 的 committed 段账目。
 *
 * ## 修法
 * 顶层 `receiptText` 改为**按段序拼接**，`receiptChars` 直接取拼接正文的长度（同源）。
 * 逐段原文仍在 `segments[i].receiptText`。单段批拼出来与旧值逐字节相同。
 *
 * ## 断言组
 * 1. 多段批：顶层 `receiptText` 必须包含**每一段**的回执正文（旧实现只有第一段）；
 * 2. `receiptChars` 必须等于顶层 `receiptText` 的长度（两字段同源）；
 * 3. 逐段原文仍可从 `segments` 取到，且按序拼接与顶层一致；
 * 4. 单段批：顶层值与 `segments[0].receiptText` 完全相同（旧行为不变）。
 *
 * ## 不适用条件与已知边界
 * - 不改任何**提交/账本**行为，只改结果面两个字段的口径。
 * - G5 的 off 路径 `archived` 指纹随之有意重抓（多段场景的字节确实变了）。
 *
 * ## 定点变异自证
 * 退回 `committed[0].receiptText` → 组 1/2 红。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

import { createV3Runtime } from '../src/v3/composition/composition.mjs'
import { createArchiveService } from '../src/v3/application/archive.mjs'
import { createFakeSession } from './helpers/fake-session.mjs'
import { textOfDshEvent } from '../src/v3/entry/v3-entry.mjs'
import { clearArchiveIntentIfMatches, readArchiveIntent, writeArchiveIntent } from '../src/v3/adapters/storage/archive-intent.mjs'
import { seqOfDshEventId } from '../src/v3/adapters/host/dsh-host.mjs'

const SESSION_ID = 'p2-19'

function pushBigStep(session, index) {
  session.append('step/start', { turn: 1, step: index })
  session.pushAssistant(('第 ' + index + ' 步数据 ').repeat(120))
  session.append('step/end', { turn: 1, step: index })
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

/** 夹具：pin 切出两段（retain 1 / batchSteps 10 / pin 第 4 步）。 */
async function withArchive({ steps = 13, pinStep = 4 } = {}, body) {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-p2-19-'))
  const session = createFakeSession({ cwd: 'C:\\ws', contextWindow: 1000000, id: SESSION_ID })
  session.pushContextWindow(1000000)
  session.pushUser('开始')
  for (let index = 1; index <= steps; index += 1) pushBigStep(session, index)
  const runtime = await createV3Runtime({ v3Root: root, dshSession: session, sessionKey: SESSION_ID })
  try {
    const rows = session.log.map((event) => ({ event, text: textOfDshEvent(event), meta: {} }))
    await runtime.handleDshEventBatch(rows)
    const journal = {
      write: (data) => writeArchiveIntent(root, SESSION_ID, data),
      read: () => readArchiveIntent(root, SESSION_ID),
      clear: (expected) => clearArchiveIntentIfMatches(root, SESSION_ID, expected),
    }
    const archive = createArchiveService({
      random: { uuid: () => randomUUID() },
      store: runtime.store,
      host: runtime.host,
      clock: { now: () => 1 },
      intent: journal,
    })
    const seqToRecordId = await seqMapOf(runtime.store)
    const surfaceNodes = await runtime.host.surfaceNodes()
    const pinned = pinStep === null ? new Set() : new Set([pinStep * 3])
    const args = { sessionId: SESSION_ID, events: session.log, surfaceNodes, seqToRecordId, retainSteps: 1, batchSteps: 10, pinnedSeqs: pinned }
    return await body({ archive, args })
  } finally {
    runtime.close()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
}

test('P2-19 多段批：顶层 receiptText 必须包含每一段，且 receiptChars 与其同源', async () => {
  await withArchive({ steps: 13, pinStep: 4 }, async ({ archive, args }) => {
    const archived = await archive.archiveStepBatch(args)
    assert.equal(archived.committedCount, 2, '前置：这个夹具必须切出两段')
    const joined = archived.segments.map((row) => row.receiptText).join('')
    assert.equal(archived.receiptText, joined, '顶层 receiptText 必须按段序拼接（旧实现只有第一段）')
    for (const row of archived.segments) {
      assert.ok(archived.receiptText.includes(row.receiptText), '每一段的回执正文都必须出现在顶层正文里')
    }
    assert.equal(archived.receiptChars, archived.receiptText.length, 'receiptChars 必须与顶层正文同源（旧实现是各段之和而正文只有一段）')
  })
})

test('P2-19 单段批：顶层值与 segments[0] 完全相同（旧行为不变）', async () => {
  // steps 必须 ≥ batchSteps(10)，否则选择器回 waiting-batch（攒批阈值），测不到单段批。
  await withArchive({ steps: 11, pinStep: null }, async ({ archive, args }) => {
    const archived = await archive.archiveStepBatch(args)
    assert.equal(archived.committedCount, 1, '前置：这个夹具必须只有一段')
    assert.equal(archived.receiptText, archived.segments[0].receiptText, '单段批必须逐字节等于该段回执')
    assert.equal(archived.receiptChars, archived.receiptText.length)
  })
})
