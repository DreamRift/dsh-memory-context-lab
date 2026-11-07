/**
 * P2-05（0.15.1）：清除标记失败**不可收敛**；`unredact` 不看返回值 → 恒报成功。
 *
 * ## 缺陷
 * - `redactVoucher` 的标记写失败虽已返回 `marked:false`（H4），但「表面已是清除常量、
 *   只是账本缺行」的现场无法收敛：下次 redact 因 `replaceVoucherReceipt` 找不到可替换
 *   正文（`receipt-changed`）提前返回，redactions 行永远补不上——history/export 会一直
 *   把该回执当可导出（隐私面与事实分叉）。
 * - `unredactVoucher` 调用 `markVoucherRedacted(false)` 后**不看返回值**，`{changed:false}`
 *   的 noop 也照报 `marked:true`：命令面显示「已还原」，history 仍显示 redacted:true。
 *
 * ## 判据来源
 * docs/dev-0.15.1/记忆上下文-0.15.1-独立排查报告.md §3.2 P2-05（审读）；用户裁定
 * （2026-11-04）：全部按顺序修、根因修复。
 *
 * ## 修法
 * 1. redact：`receipt-changed` 时**再确认**表面是否已是 REDACTED 常量；是则视为「补标记」
 *    重试机会（返回 `repaired:true`），不再提前返回；
 * 2. unredact：与 redact 同一判据——`changed:false` 且状态仍为已清除 = 标记没写成功，
 *    如实返回 `marked:false/markError`。
 *
 * ## 断言组
 * 1. 标记写失败：redact 返回 `marked:false`（不谎报），history 仍 `redacted:false`；
 * 2. 再 redact 一次（无需人工介入）：`marked:true` + `repaired:true`，history 变
 *    `redacted:true`（**可收敛**）；
 * 3. unredact 遇到 noop 标记：返回 `marked:false/markError:'redaction-mark-noop'`，
 *    不冒充成功；正常路径 unredact 仍报 `marked:true` 且 history 回到 `redacted:false`。
 *
 * ## 不适用条件与已知边界
 * - 标记账本本身损坏（读失败）走 store 的 damaged 路径，不在本用例范围；
 * - 「补标记」不重写表面（正文已经是清除常量），也不推进 seq。
 *
 * ## 定点变异自证
 * 去掉 redact 的「已清除常量」确认 → 组 2 红；把 unredact 的返回值检查退回忽略 → 组 3 红。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createArchiveService } from '../src/v3/application/archive.mjs'
import { createSessionStorePort } from '../src/v3/adapters/storage/session-store-port.mjs'
import { createFakeSession } from './helpers/fake-session.mjs'

const SESSION = 's-p205'
const RECEIPT = '[记忆上下文] 已把 1 条已完成历史（seq 1–1）归档为可恢复回执。'

function hostOf(session) {
  return {
    async surfaceNodes() { return [...session.surface.nodes] },
    async surfaceTextAt(seq) { return session.textOf(seq) },
    async surfaceOp(op) {
      const { seq } = session.append('user/message', { content: [{ type: 'text', text: op.text }], source: { kind: 'plugin' } }, {
        surfaceOp: { op: 'replace', startSeq: op.targetEventId, endSeq: op.targetEventId },
        sourceEventSeqs: [op.targetEventId],
      })
      return { seq }
    },
  }
}

async function seeded() {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-p205-'))
  const { port } = await createSessionStorePort(root, SESSION)
  const session = createFakeSession({ id: SESSION })
  session.pushUser('第一段问'.repeat(20))
  // 落一段回执（正文就是 REDACTED 之前的原文回执）
  const { seq } = session.append('user/message', { content: [{ type: 'text', text: RECEIPT }], source: { kind: 'plugin' } }, {
    surfaceOp: { op: 'replace', startSeq: 0, endSeq: 0 },
    sourceEventSeqs: [0],
  })
  await port.appendVoucher({
    schemaVersion: 2,
    voucherId: 'v-' + seq,
    kind: 'span',
    recordIds: [],
    sourceEventSeqs: [0],
    startSeq: 0,
    endSeq: 0,
    targetEventId: seq,
    receiptText: RECEIPT,
    summaryText: '',
    restoreChars: 0,
    txn: 1,
  })
  return { root, port, session }
}

const serviceOf = (port, session) => createArchiveService({
  store: port,
  host: hostOf(session),
  clock: { now: () => 1 },
  random: { uuid: () => 'u' },
})

test('P2-05 标记写失败可收敛：再 redact 一次补上标记，history 才是 redacted:true', async () => {
  const { root, port, session } = await seeded()
  const original = port.markVoucherRedacted
  try {
    // 第一次：标记写失败
    port.markVoucherRedacted = async () => { throw Object.assign(new Error('EACCES: redactions.jsonl'), { code: 'EACCES' }) }
    const first = await serviceOf(port, session).redactVoucher(0)
    assert.equal(first.changed, true, '表面替换成功：' + JSON.stringify(first))
    assert.equal(first.marked, false, '标记失败必须如实上报：' + JSON.stringify(first))
    assert.equal(first.markError, 'EACCES')
    assert.equal((await serviceOf(port, session).history()).rows[0].redacted, false, '账本没写成功 → history 仍是未清除')

    // 第二次：表面已是清除常量、账本仍缺行 → 必须补标记（旧实现提前返回，永远补不上）
    port.markVoucherRedacted = original
    const second = await serviceOf(port, session).redactVoucher(0)
    assert.equal(second.marked, true, '补标记必须成功：' + JSON.stringify(second))
    assert.equal(second.repaired, true, '必须标记为「补标记」而不是假装重新替换：' + JSON.stringify(second))
    assert.equal((await serviceOf(port, session).history()).rows[0].redacted, true, '补标记后 history 必须是已清除')
  } finally {
    port.markVoucherRedacted = original
    port.close?.()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})

test('P2-05 unredact 遇到 noop 标记：如实报失败，不冒充成功', async () => {
  // 用最小替身钉住「返回值检查」本身：表面已是清除常量、账本仍记为已清除。
  const REDACTED = '[记忆上下文] 该回执涉及已遗忘记录，摘要已清除；原文不可恢复。'
  const receiptText = '[记忆上下文] 已把 1 条已完成历史（seq 1–1）归档为可恢复回执。'
  const state = { marked: true, markCalls: 0 }
  const store = {
    listVouchers: () => [{ voucherId: 'v-1', kind: 'span', receiptText, targetEventId: 1, recordIds: [] }],
    redactionSeqOf: () => 1,
    redactedVoucherIds: () => (state.marked ? ['v-1'] : []),
    async markVoucherRedacted(_id, redacted) {
      state.markCalls += 1
      // 模拟「标记写入 noop」：返回 changed:false 且状态仍是已清除
      if (state.redundant !== true) { state.marked = redacted; return { changed: true, redacted } }
      return { changed: false, redacted: true }
    },
  }
  const host = {
    async surfaceNodes() { return [1] },
    async surfaceTextAt(seq) { return seq === 1 ? REDACTED : null },
    async surfaceOp(op) { return { seq: 2, text: op.text } },
  }
  const svc = createArchiveService({ store, host, clock: { now: () => 1 }, random: { uuid: () => 'u' } })
  state.redundant = true
  const noop = await svc.unredactVoucher(0)
  assert.equal(noop.changed, true, '表面已还原：' + JSON.stringify(noop))
  assert.equal(noop.marked, false, '标记 noop 不得报成功：' + JSON.stringify(noop))
  assert.equal(noop.markError, 'redaction-mark-noop')

  // 正常路径：标记成功 → marked:true
  state.redundant = false
  const ok = await svc.unredactVoucher(0)
  assert.equal(ok.marked, true, JSON.stringify(ok))
  assert.equal(ok.changed, true)
})
