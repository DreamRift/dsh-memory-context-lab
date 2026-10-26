/**
 * 停用路径的逐行隔离守卫（H-42，2026-10-26 缺陷排查批）。
 *
 * ## 缺陷
 * `disableSession` 的循环里直接调 `surfaceTextOf(voucher)`，**没有 try**。
 * 该函数由调用方注入（真实场景是「按 targetEventId 取宿主表面正文」），
 * 凭证指向的事件可能已不存在、宿主可能拒绝访问——一个抛错就让**整批恢复**打挂，
 * 会计恒等式根本没机会结算。这正是 `restore.mjs` 头注释里写的
 * 「beta.3 曾把整批恢复打挂」那条，在 v3 里又回来了。
 *
 * ## 判据（N-11）
 * - restored + skipped + forgotten === total 恒成立；
 * - 单行异常只落该行 skipped（reason 以 `internal-failure` 开头），其余行照常裁决；
 * - 回执首行必须反映**真实**结算结果，不得在部分失败时印「已恢复 N/N」。
 *
 * ## 顺带修正
 * 旧实现用 `vouchers.indexOf(voucher)` 取下标——按引用比较，重复引用会取到第一个下标
 * （同一对象出现两次时，第二行实际用的是第一行的下标）。改为 `entries()` 的迭代下标。
 *
 * ## 不适用条件
 * 只保证「单行失败不扩散」；「同一凭证被并发恢复两次」不在承诺范围（由写锁负责）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { createSessionLifecycle } from '../src/v3/application/session-lifecycle.mjs'

const clock = { now: () => 1 }
const random = { uuid: () => '00000000-0000-0000-0000-000000000000' }

function makeStore(vouchers) {
  return {
    async health() { return { healthy: true } },
    async transaction() { throw new Error('未使用') },
    async readRecord() { throw new Error('未使用') },
    async rebuildIndex() { return { indexedCount: 0 } },
    async sourceEventIds() { return [] },
    listVouchers() { return [...vouchers] },
    restore(index, surfaceText) {
      const voucher = vouchers[index]
      if (voucher === undefined) return { voucher: null, eligibility: { eligible: false, reason: '凭证下标不存在' } }
      const eligible = voucher.receiptText === surfaceText
      return { voucher, eligibility: { eligible, reason: eligible ? '逐字节相等' : '回执正文已变化，拒绝覆盖' } }
    },
    async forget() { return { forgottenCount: 0, indexedCount: 0 } },
  }
}

const threeVouchers = () => [
  { recordIds: ['a'], targetEventId: 'e1', receiptText: '回执一', txn: 1 },
  { recordIds: ['b'], targetEventId: 'e2', receiptText: '回执二', txn: 1 },
  { recordIds: ['c'], targetEventId: 'e3', receiptText: '回执三', txn: 1 },
]

test('H-42 单行取表面正文抛错 → 只该行 skipped，整批仍结算（旧：整批 THROW）', async () => {
  const lifecycle = createSessionLifecycle({ store: makeStore(threeVouchers()), clock, random })
  const result = await lifecycle.disableSession({
    autoRestore: true,
    guardRefused: false,
    surfaceTextOf: (voucher) => {
      if (voucher.targetEventId === 'e2') throw new Error('宿主拒绝访问该事件')
      return voucher.receiptText
    },
  })
  assert.equal(result.settled.total, 3)
  assert.equal(result.settled.restored, 2)
  assert.equal(result.settled.skipped, 1)
  assert.equal(result.settled.balanced, true, 'N-11 会计恒等式必须成立')
  assert.match(result.settled.rowResults[1].reason, /^internal-failure/)
  assert.equal(result.receiptFirstLine, '已恢复 2/3 段', '首行必须如实反映部分失败')
})

test('H-42 全部行都抛错 → 全 skipped、零 restored，仍不抛', async () => {
  const lifecycle = createSessionLifecycle({ store: makeStore(threeVouchers()), clock, random })
  const result = await lifecycle.disableSession({
    autoRestore: true,
    guardRefused: false,
    surfaceTextOf: () => { throw new Error('宿主整体不可用') },
  })
  assert.equal(result.settled.restored, 0)
  assert.equal(result.settled.skipped, 3)
  assert.equal(result.settled.balanced, true)
  assert.equal(result.receiptFirstLine, '已恢复 0/3 段')
})

test('H-42 正常路径与「一条对不上」语义不变', async () => {
  const lifecycle = createSessionLifecycle({ store: makeStore(threeVouchers()), clock, random })
  const all = await lifecycle.disableSession({ autoRestore: true, guardRefused: false, surfaceTextOf: (v) => v.receiptText })
  assert.equal(all.settled.restored, 3)
  assert.equal(all.receiptFirstLine, '已恢复 3/3 段')

  const oneOff = await lifecycle.disableSession({
    autoRestore: true, guardRefused: false,
    surfaceTextOf: (v) => (v.targetEventId === 'e2' ? '被改过' : v.receiptText),
  })
  assert.equal(oneOff.settled.restored, 2)
  assert.equal(oneOff.settled.rowResults[1].reason, '回执正文已变化，拒绝覆盖')
})

test('H-42 重复引用按位置取下标（旧：indexOf 取到第一个下标）', async () => {
  const shared = { recordIds: ['a'], targetEventId: 'e1', receiptText: '回执一', txn: 1 }
  const seen = []
  const store = makeStore([shared, shared])
  const original = store.restore
  store.restore = (index, text) => { seen.push(index); return original(index, text) }
  const lifecycle = createSessionLifecycle({ store, clock, random })
  await lifecycle.disableSession({ autoRestore: true, guardRefused: false, surfaceTextOf: (v) => v.receiptText })
  assert.deepEqual(seen, [0, 1], '两行必须各用各的下标')
})

test('H-42 按设置未恢复 / 守卫拒绝时不读表面正文', async () => {
  let calls = 0
  const lifecycle = createSessionLifecycle({ store: makeStore(threeVouchers()), clock, random })
  const bySetting = await lifecycle.disableSession({
    autoRestore: false, guardRefused: false,
    surfaceTextOf: () => { calls += 1; return 'x' },
  })
  assert.equal(calls, 0, '按设置不恢复时不得读表面正文')
  assert.equal(bySetting.settled.skipped, 3)
  assert.match(bySetting.receiptFirstLine, /按设置未恢复/)

  const byGuard = await lifecycle.disableSession({
    autoRestore: true, guardRefused: null, // unknown → 失败关闭
    surfaceTextOf: () => { calls += 1; return 'x' },
  })
  assert.equal(calls, 0, '守卫拒绝时不得读表面正文')
  assert.match(byGuard.receiptFirstLine, /守卫拒绝/)
})
