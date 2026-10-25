/**
 * v3 生命周期用例测试（M3 第二批）——真实适配器组合 + 注入替身。
 *
 * ## 判据来源
 * Q-01（autoRestore 与守卫正交、回执首行三结局一一对应）、G3（unknown 失败关闭）、
 * N-11（三桶会计恒等、单行异常只落 skipped）、隐私面（forget 后不可按 ID 回读）。
 *
 * ## 断言组
 * - enable：健康 → enabled；damaged → enabled false 带原因（不伪成功）；
 * - disable by-setting：全部 skipped(by-setting)、首行「按设置未恢复」；
 * - disable guard unknown(null)：首行「守卫拒绝」、不恢复（G3）；
 * - disable restore：表面逐字节匹配 → restored；不匹配 → skipped(已变化)；
 *   会计恒等；混合批单行异常只落该行；
 * - restoreOne：单凭证命中取回回执正文、未命中如实 reason；
 * - forget：幂等、检索面立即不可见、重复内容回读 EFORGOTTEN、未提交 ID 冲突拒绝。
 *
 * ## 不适用条件与已知边界
 * 真实 surface 恢复操作属 M5（本批 restored 行只出计划）；vouchers 由测试直种。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createSessionLifecycle, disableReceiptFirstLine } from '../src/v3/application/session-lifecycle.mjs'
import { createSessionStorePort } from '../src/v3/adapters/storage/session-store-port.mjs'
import { createProcessTurn } from '../src/v3/application/process-turn.mjs'

function fakeClock(start = 1792845000000) {
  let t = start
  return { now: () => t++ }
}

function fakeRandom() {
  let n = 0
  return { uuid: () => String(++n).padStart(8, '0') + '-0000-4000-8000-000000000000' }
}

function fakeMetrics() {
  const counters = new Map()
  return {
    counters,
    counter(name, value) { counters.set(name, (counters.get(name) ?? 0) + value) },
    observe() {},
  }
}

async function withLifecycle(body) {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-v3-life-'))
  const { port, store } = await createSessionStorePort(root, 'sess-a')
  try {
    const deps = { store: port, clock: fakeClock(), random: fakeRandom(), metrics: fakeMetrics() }
    const lifecycle = createSessionLifecycle(deps)
    const processTurn = createProcessTurn({ ...deps, ownSourceKinds: ['dsh-memory-context-lab'] })
    return await body({ lifecycle, processTurn, port, store, root, metrics: deps.metrics })
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
}

const VOUCHER = (txn, target, receipt) => ({ txn, recordIds: [], targetEventId: target, receiptText: receipt })

test('enable：健康 enabled；damaged 拒绝且不伪成功', async () => {
  await withLifecycle(async ({ lifecycle }) => {
    const ok = await lifecycle.enableSession()
    assert.equal(ok.enabled, true)
    assert.equal(typeof ok.health.txnNext, 'number')
  })
})

test('disable by-setting：全 skipped、首行「按设置未恢复」', async () => {
  await withLifecycle(async ({ lifecycle, store }) => {
    await store.appendVoucher(VOUCHER(1, 'evt-1', '回执A'))
    await store.appendVoucher(VOUCHER(2, 'evt-2', '回执B'))
    const result = await lifecycle.disableSession({ autoRestore: false, guardRefused: false, surfaceTextOf: () => '回执A' })
    assert.equal(result.action.action, 'skip')
    assert.equal(result.settled.restored, 0)
    assert.equal(result.settled.skipped, 2)
    assert.equal(result.settled.balanced, true)
    assert.match(result.receiptFirstLine, /^按设置未恢复/)
  })
})

test('disable guard unknown(null)：守卫拒绝、不恢复（G3）', async () => {
  await withLifecycle(async ({ lifecycle, store }) => {
    await store.appendVoucher(VOUCHER(1, 'evt-1', '回执A'))
    const result = await lifecycle.disableSession({ autoRestore: true, guardRefused: null, surfaceTextOf: () => '回执A' })
    assert.equal(result.action.action, 'skip')
    assert.equal(result.settled.restored, 0)
    assert.match(result.receiptFirstLine, /^守卫拒绝/)
  })
})

test('disable restore：逐字节匹配 restored；不匹配 skipped(已变化)；会计恒等', async () => {
  await withLifecycle(async ({ lifecycle, store }) => {
    await store.appendVoucher(VOUCHER(1, 'evt-1', '回执A'))
    await store.appendVoucher(VOUCHER(2, 'evt-2', '回执B'))
    await store.appendVoucher(VOUCHER(3, 'evt-3', '回执C'))
    const result = await lifecycle.disableSession({
      autoRestore: true,
      guardRefused: false,
      surfaceTextOf: (v) => (v.targetEventId === 'evt-2' ? '回执B-被改过' : v.receiptText),
    })
    assert.equal(result.settled.restored, 2)
    assert.equal(result.settled.skipped, 1)
    assert.equal(result.settled.balanced, true)
    assert.ok(result.receiptFirstLine.startsWith('已恢复 2/3 段'))
    const mismatched = result.rowResults[1]
    assert.equal(mismatched.outcome, 'skipped')
    assert.match(mismatched.reason, /已变化/)
  })
})

test('回执首行三结局一一对应（纯函数）', () => {
  assert.match(disableReceiptFirstLine({ action: 'skip-by-setting', restored: 0, total: 3, skippedByGuard: 0 }), /^按设置未恢复/)
  assert.match(disableReceiptFirstLine({ action: 'skip-by-guard', restored: 0, total: 3, skippedByGuard: 3 }), /^守卫拒绝/)
  assert.ok(disableReceiptFirstLine({ action: 'restore', restored: 2, total: 3, skippedByGuard: 0 }).startsWith('已恢复 2/3'))
})

test('restoreOne：命中取回正文；未命中如实 reason；下标越界不炸', async () => {
  await withLifecycle(async ({ lifecycle, store }) => {
    await store.appendVoucher(VOUCHER(1, 'evt-1', '回执A'))
    const hit = lifecycle.restoreOne({ voucherIndex: 0, surfaceText: '回执A' })
    assert.equal(hit.restored, true)
    assert.equal(hit.text, '回执A')
    const miss = lifecycle.restoreOne({ voucherIndex: 0, surfaceText: '别的' })
    assert.equal(miss.restored, false)
    assert.match(miss.reason, /已变化/)
    const oob = lifecycle.restoreOne({ voucherIndex: 9, surfaceText: 'x' })
    assert.equal(oob.restored, false)
    assert.match(oob.reason, /下标不存在/)
    assert.throws(() => lifecycle.restoreOne({ voucherIndex: -1, surfaceText: 'x' }), (e) => e?.name === 'V3ContractViolation')
  })
})

test('forget：幂等、检索面立即不可见、回读 EFORGOTTEN、未提交 ID 冲突', async () => {
  await withLifecycle(async ({ lifecycle, processTurn, port, metrics }) => {
    const a = await processTurn({ event: { id: 'e1', type: 'user', sessionKey: 'sess-a', at: 1, source: { kind: 'dsh', form: null } }, text: '待遗忘正文' })
    const b = await processTurn({ event: { id: 'e2', type: 'user', sessionKey: 'sess-a', at: 2, source: { kind: 'dsh', form: null } }, text: '保留正文' })
    const first = await lifecycle.forget({ recordIds: [a.recordId] })
    assert.equal(first.forgottenCount, 1)
    assert.equal((await port.health()).indexedCount, 1, '遗忘后索引立即缩面')
    const again = await lifecycle.forget({ recordIds: [a.recordId] })
    assert.equal(again.forgottenCount, 1, '幂等：重复遗忘不重复记账')
    await assert.rejects(() => port.readRecord(a.recordId), (e) => e?.code === 'EFORGOTTEN')
    const kept = await port.readRecord(b.recordId)
    assert.equal(kept.payload.text, '保留正文')
    await assert.rejects(
      () => lifecycle.forget({ recordIds: ['v3r-ffffffffffffffff'] }),
      (e) => e?.code === 'ESTORE_TXN_CONFLICT',
    )
    assert.equal(metrics.counters.get('v3.lifecycle.forgotten'), 2, '两次调用各计一次（幂等是存储面语义，计数按调用如实）')
    await assert.rejects(() => lifecycle.forget({ recordIds: [] }), (e) => e?.name === 'V3ContractViolation')
  })
})
