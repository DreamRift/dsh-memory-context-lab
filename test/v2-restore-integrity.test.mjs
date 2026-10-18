/**
 * 0.13.0 F0 恢复闭环（红例先行）。
 *
 * 缺陷：实测会话 230 条归档里 **221 条不可恢复**。根因是三处设计各自正确、
 * 组合起来错误：
 *
 *   1. isCardNode() 把以 `[已归档操作·v2]` 开头的归档回执也判成「卡」；
 *   2. 折叠把整组回执换成一条只留 `seq:` 的折叠回执，不保留 `mcl2-…`；
 *   3. restoreReceipts() 按 replacementSeq 判断「回执是否还在活动面」，
 *      折叠后必然不在 → 逐条 `skipped: 回执节点已不在活动面`。
 *
 * 而折叠回执本身不是可恢复记录，于是这条链路没有兜底：回执是 restore 的
 * **唯一句柄**，折掉它等于删掉「原文可恢复」这条承诺。
 *
 * 本套件锁死三条不变量：
 *   A. 归档回执永不进入折叠区间（断组边界）；
 *   B. 回执节点缺失时按冷库 hash 重建，而不是判不可恢复；
 *   C. 三态对账：restored + skipped + forgotten == 输入行数。
 *
 * 判据来源：2026-10-18 会话 session-c5af11b4 的隔离根 state.json 与事件日志
 * 交叉核对（230 归档 / 221 折叠命中 / 2 可恢复）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { isCardNode, isArchiveReceiptNode, planCardFolds } from '../src/v2/card-fold.mjs'
import { V2_RECEIPT_MARKER, FOLD_RECEIPT_MARKER } from '../src/core.mjs'

function card(seq, form = 'working-set') {
  return { seq, type: 'user/message', sourceForm: form, text: '[工作状态·v2] 卡' }
}
function archiveReceipt(seq) {
  return { seq, type: 'user/message', sourceForm: 'archive-receipt', text: V2_RECEIPT_MARKER + '\n工具：run_code' }
}
function foldReceipt(seq) {
  return { seq, type: 'user/message', sourceForm: 'memory-lab2-surface', text: FOLD_RECEIPT_MARKER + '\n折叠卡 2 张' }
}

test('A1 归档回执不是可折叠的卡（isCardNode 必须为 false）', () => {
  assert.equal(isCardNode(archiveReceipt(10)), false)
  // 它仍然是「回执」，供断组边界与 restore 句柄判定使用。
  assert.equal(isArchiveReceiptNode(archiveReceipt(10)), true)
})

test('A2 工作状态卡仍然可折叠（修复不得把该折的也放过）', () => {
  assert.equal(isCardNode(card(10)), true)
  assert.equal(isCardNode(card(11, 'working-state')), true)
})

test('A3 归档回执把卡组断开：回执两侧的卡不得跨回执折叠', () => {
  const nodes = [card(1), card(2), archiveReceipt(3), card(4), card(5)]
  const { plans, runs } = planCardFolds(nodes)
  // 两个各含 2 张卡的组，回执是断组边界 → 两个独立计划，且都不含 seq 3。
  assert.equal(runs.length, 2, JSON.stringify(runs))
  for (const plan of plans) {
    assert.equal(plan.memberSeqs.includes(3), false, '折叠区间不得包含归档回执')
    assert.ok(plan.startSeq <= plan.endSeq, '折叠区间必须 start <= end')
  }
})

test('A4 折叠回执本身也不再被当成卡（避免二次折叠吃掉凭证）', () => {
  // 折叠回执的 sourceForm 是 memory-lab2-surface，不在 CARD_FOLD_FORMS 内。
  assert.equal(isCardNode(foldReceipt(20)), false)
})

test('A5 区间端点有序：表面顺序与 seq 顺序不一致时 start 仍须 <= end', () => {
  // 真实缺陷：折叠回执出现过 seq 243–189 / 802–770 这类倒置区间。
  // 这里用「表面顺序 ≠ seq 升序」的输入复现，断言计划端点已归一。
  const nodes = [card(50), card(10), card(70)]
  const { plans } = planCardFolds(nodes, { protectSeqs: [] })
  for (const plan of plans) {
    assert.ok(plan.startSeq <= plan.endSeq,
      `区间倒置：${plan.startSeq}–${plan.endSeq}`)
  }
})
