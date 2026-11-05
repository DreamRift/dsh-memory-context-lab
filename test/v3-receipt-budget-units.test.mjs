/**
 * P3-03 / P3-06 回执预算单位与「基础身份行不得被静默删减」。
 *
 * ## 缺陷（0.15.1 独立排查报告 §3.3）
 * - **P3-03**：摘要预算按**码点**算（`[...text].length`），而净收益判据
 *   `receiptText.length < sourceChars` 两端都是 **UTF-16 码元**。星平面字符（emoji 等）
 *   每个码点占 2 码元 → 预算 N 码点能产出 2N 码元的摘要，回执被推过原文：本该归档的
 *   小步骤被判 not-worth，或者「净收益为正」被算错。
 * - **P3-06**：基础身份超 400 时把 `operations` 静默降为 0（少一行「操作数：N。」），
 *   与函数头「不截断任何基础身份行」的注释直接矛盾。
 *
 * ## 判据来源
 * `src/v3/domain/archive/receipt.mjs`（RECEIPT_MAX_CHARS 声明为码元口径）+
 * `src/v3/domain/compress/summary-artifact.mjs` 的 `clampSummaryTextByUnits`（按码元裁剪、
 * 不切断代理对）。净收益判据仍取 `receiptText.length`（码元）——现在**只有一个单位**。
 *
 * ## 断言组
 * A. 星平面摘要：总长（码元）≤ 400，且摘要不被丢弃（同一份输入在旧码点实现下会超 400）；
 * B. 裁剪不产生半个代理对；
 * C. 基础身份超预算时「操作数」行必须保留（旧实现在此把它删掉 → 红）；
 * D. 端到端同口径：用 emoji 正文的归档，`receiptChars < sourceChars` 与文案一致。
 *
 * ## 不适用条件与已知边界
 * - BMP（中文/ASCII）文本下码元与码点等价，本项对既有行为无影响；
 * - 「基础身份 + 1 个 ID + 恢复行」本身就超过 400 时仍抛合同错误（数据异常，不静默截断）；
 * - `clampSummaryText`（码点版）保留给非回执用途，回执路径不再调用它。
 *
 * ## 定点变异自证（`node --test test/v3-receipt-budget-units.test.mjs`）
 * - 把 receipt 的 `clampSummaryTextByUnits` 换回 `clampSummaryText`（码点裁剪）→ A 组红；
 * - 把基础身份的 `operations` 改回 0 → C 组红；
 * - 恢复后 4 组全绿。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { RECEIPT_MAX_CHARS, RECEIPT_MIN_SUMMARY_CHARS, RECEIPT_SUMMARY_SAFETY_MARGIN, renderArchiveReceipt } from '../src/v3/domain/archive/receipt.mjs'
import { clampSummaryTextByUnits } from '../src/v3/domain/compress/summary-artifact.mjs'

/** 旧实现的码点裁剪（就地复刻，仅用于「反证旧预算会超 400」；src 已不再导出它）。 */
function clampSummaryTextByCodePoints(text, maxChars) {
  const chars = [...String(text ?? '')]
  if (!Number.isInteger(maxChars) || maxChars <= 0) return ''
  if (chars.length <= maxChars) return chars.join('')
  if (maxChars === 1) return '…'
  return chars.slice(0, maxChars - 1).join('') + '…'
}

const ID = 'v3r-0987654789abcdef'

test('P3-03-A 星平面摘要：总长按码元 ≤ 400 且摘要仍在（旧码点预算超 400 → 红）', () => {
  const base = renderArchiveReceipt({ startSeq: 1, endSeq: 1, recordIds: [ID] })
  const emoji = '😀'.repeat(300)
  const receipt = renderArchiveReceipt({ startSeq: 1, endSeq: 1, recordIds: [ID], summary: emoji })
  assert.notEqual(receipt, base, '摘要必须出现（不得被无声丢弃）')
  assert.ok(receipt.length <= RECEIPT_MAX_CHARS, '码元总长不得超 ' + RECEIPT_MAX_CHARS + '（得到 ' + receipt.length + '）')
  // 反证：如果按码点预算裁（旧实现），同一份输入的码元总长会超 400。
  const codepointBudget = RECEIPT_MAX_CHARS - base.length - 1 - '摘要：'.length
  const codepointClamped = clampSummaryTextByCodePoints(emoji, codepointBudget)
  const wouldBe = base.length + 1 + '摘要：'.length + codepointClamped.length
  assert.ok(wouldBe > RECEIPT_MAX_CHARS, '旧码点预算确实会超 400（本用例的有效性前提）：' + wouldBe)
})

test('P3-03-B 按码元裁剪不产生半个代理对', () => {
  const emoji = '😀'.repeat(10)
  for (let units = 1; units <= emoji.length + 2; units += 1) {
    const out = clampSummaryTextByUnits(emoji, units)
    assert.ok(out.length <= units, '不得超预算：' + units)
    const body = out.endsWith('…') ? out.slice(0, -1) : out
    assert.ok(!/[\uD800-\uDBFF]$/.test(body), '不得以半个代理对结尾（units=' + units + '）')
    assert.ok(!/[\uDC00-\uDFFF]/.test(body.slice(0, 1)) || body.length === 0, '不得以孤立低位代理开头')
  }
  assert.equal(clampSummaryTextByUnits(emoji, 0), '')
  assert.equal(clampSummaryTextByUnits(emoji, 1), '…')
  assert.equal(clampSummaryTextByUnits('短', 5), '短')
})

test('P3-06-C 基础身份超预算时保留「操作数」行（旧实现把它降为 0 → 红）', () => {
  const ids = ['v3r-0987654789abcdef', 'v3r-fedcba9876543210', 'v3r-0011223344556677']
  // 构造真的会触发「3 个 ID 装不下、1 个 ID 装得下」的边界：长 unitLabel 把基础身份顶到 400 附近。
  // 实测边界：标签 110 组时 3 ID 版越界（403）、1 ID 版 361 —— 恰好触发降抽样分支。
  const label = '标签'.repeat(110)
  const threeIds = renderArchiveReceipt({ startSeq: 1, endSeq: 2, recordIds: ids, operations: 987654, unitLabel: label })
  const oneIdOnly = renderArchiveReceipt({ startSeq: 1, endSeq: 2, recordIds: [ids[0]], operations: 987654, unitLabel: label })
  // 前置条件（用例有效性）：3 ID 版必超 400、1 ID 版不超——否则测不到降抽样分支。
  assert.ok(oneIdOnly.length <= RECEIPT_MAX_CHARS, '1 ID 版必须装得下（' + oneIdOnly.length + '）')
  assert.ok(oneIdOnly.length + 40 > RECEIPT_MAX_CHARS, '1 ID 版必须接近上限，3 ID 版才会越界（' + oneIdOnly.length + '）')
  assert.ok(threeIds.length < oneIdOnly.length + 45, '确实降了抽样（3 ID 版不得比 1 ID 版长太多）')
  assert.ok(threeIds.length <= RECEIPT_MAX_CHARS, '3 ID 越界时必须降到 1 ID，而不是删行')
  // 注意：unitLabel 会替换「操作数」前缀，所以断言用 label 本身拼出整行。
  assert.ok(threeIds.includes(label + '：987654。'), '操作数行必须保留（旧实现在此把它静默降为 0 → 整行消失）')
  assert.match(threeIds, /已把 3 条已完成历史（seq 1–2）/, '首行身份不得被删')
  assert.match(threeIds, /恢复：\/memory-lab restore/, '恢复入口不得被删')
  assert.match(threeIds, /记录 ID：v3r-0987654789abcdef/, '抽样降为 1 时仍保留首个 ID')
  assert.ok(!threeIds.includes('v3r-fedcba9876543210'), '降抽样后不再列后两个 ID（这是唯一允许的收缩）')
})

test('P3-03-D 端到端：emoji 摘要下 receiptChars 与 sourceChars 同口径（码元）', () => {
  const sourceChars = 520
  const receipt = renderArchiveReceipt({
    startSeq: 1, endSeq: 1, recordIds: [ID], summary: '😀'.repeat(200),
    sourceChars,
  })
  assert.ok(receipt.length < sourceChars, '净收益判据必须成立：' + receipt.length + ' < ' + sourceChars)
  const base = renderArchiveReceipt({ startSeq: 1, endSeq: 1, recordIds: [ID] })
  const available = sourceChars - base.length - RECEIPT_SUMMARY_SAFETY_MARGIN
  assert.ok(available >= RECEIPT_MIN_SUMMARY_CHARS)
  assert.match(receipt, /摘要：/, '预算够时必须带摘要')
  assert.ok(receipt.length <= RECEIPT_MAX_CHARS)
})
