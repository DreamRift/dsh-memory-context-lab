/**
 * T-03 守卫（0.15.4，P1）：清除账本必须有**跨句柄可见性**。
 *
 * ## 缺陷（计划 §7.4「forget 级联无自有出口泄露」的直接违背）
 *
 * `redactedVouchers` 是**打开期**解析出来的内存集合，只有本句柄自己调
 * `markVoucherRedacted` 才更新。forgotten / purged 两本账本早已按文件戳刷新
 * （`refreshForgotten`），唯独 redactions 漏了。
 *
 * 后果链：
 *   1. 句柄 A 清除一张回执（`redactions.jsonl` 追加 `action:'redact'`）；
 *   2. 句柄 B（同会话，第二个实例）此刻的 `redactedVouchers` 仍是空集；
 *   3. B 走导出/历史面 → 认为「这张回执没被清除」→ 把已声明清除的回执正文
 *      原样带出。这是**隐私面泄露**，不是显示错误。
 *
 * ## 修法
 *
 * 端口层 `redactedVoucherIds()` 改为「**按戳刷新后读**」：文件未变只多一次 stat，
 * 变了就重解析账本。语义与 forgotten/purged 完全同口径（T-04 同源）。
 *
 * ## 钉住的判据
 *
 * 1. 句柄 B 必须看到句柄 A 刚写入的清除标记（跨句柄可见）；
 * 2. 撤销（unredact）也必须跨句柄可见（不能只看「有人清除过」）；
 * 3. 账本未变时不重解析（只多一次 stat）——用「读数不重复追加」间接钉住：连续两次
 *    读取结果稳定且不抛错（重解析路径若写盘会在只读句柄上炸）。
 * 4. 另一方向不回归：本句柄自己清除后立刻可见（既有行为）。
 *
 * ## 不适用条件
 *
 * - 不测真跨进程（`v3-voucher-lock` / `v3-store-import-lock` 覆盖跨进程锁与并发）；
 *   这里用同进程两个 store 实例，正是缺陷发生的最小现场（旧实现同进程就漏）。
 * - 不测账本损坏时的失败关闭（`v3-store-repair` / 既有 `ESTORE_DAMAGED` 守卫职责）。
 * - 不测导出侧的字段裁剪（S-09 系列职责）；这里只钉「标记是否看得见」。
 *
 * ## 变异自证
 *
 * 把端口层改回直接读内存集合 → 用例 1、2 红；恢复 → 全绿。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createSessionStorePort } from '../src/v3/adapters/storage/session-store-port.mjs'

async function openTwo(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-t03-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  // 两个独立端口 = 同会话的两个句柄（缺陷的最小现场）
  const a = await createSessionStorePort(root, 'session-t03')
  const b = await createSessionStorePort(root, 'session-t03')
  return { root, a: a.port, b: b.port }
}

test('T-03：句柄 B 必须看到句柄 A 刚清除的回执（跨句柄可见）', async (t) => {
  const { a, b } = await openTwo(t)
  assert.deepEqual(await b.redactedVoucherIds(), [], '初始应为空集')

  await a.markVoucherRedacted('v-100', true, { seq: 5 })

  const seenByB = await b.redactedVoucherIds()
  assert.deepEqual(
    seenByB,
    ['v-100'],
    '第二个句柄必须看到别人刚写入的清除标记；看不到就是导出泄露（计划 §7.4）',
  )
})

test('T-03：撤销也必须跨句柄可见（不能只看「有人清除过」）', async (t) => {
  const { a, b } = await openTwo(t)
  await a.markVoucherRedacted('v-200', true, { seq: 6 })
  assert.deepEqual(await b.redactedVoucherIds(), ['v-200'])

  await a.markVoucherRedacted('v-200', false)
  assert.deepEqual(
    await b.redactedVoucherIds(),
    [],
    '撤销之后第二个句柄必须看到「已不再清除」，否则导出的正文会永久被误判为已清除',
  )
})

test('T-03 不回归：本句柄自己清除后立刻可见', async (t) => {
  const { a } = await openTwo(t)
  await a.markVoucherRedacted('v-300', true, { seq: 7 })
  assert.deepEqual(await a.redactedVoucherIds(), ['v-300'])
})

test('T-03：账本未变时连续读取稳定且不抛错（刷新只在戳变化时重解析）', async (t) => {
  const { a, b } = await openTwo(t)
  await a.markVoucherRedacted('v-400', true, { seq: 8 })
  const first = await b.redactedVoucherIds()
  const second = await b.redactedVoucherIds()
  assert.deepEqual(first, second, '未变化时两次读取必须一致')
  assert.deepEqual(second, ['v-400'])
})
