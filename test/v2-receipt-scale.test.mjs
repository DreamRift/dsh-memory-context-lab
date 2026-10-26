/**
 * v2 明细回执解析的规模健壮性守卫（H-16，2026-10-26 缺陷排查批）。
 *
 * ## 缺陷
 * parseDetailReceipt 用 `Math.min(...spans.map(...))` / `Math.max(...)` 求 seq 范围。
 * 回执正文规模不受控（明细回执逐条列 seq；正文也可能来自工具输出/用户文本），
 * 20 万段即抛 `RangeError: Maximum call stack size exceeded`，整条回执解析失败。
 *
 * ## 判据
 * - 20 万段正文仍能解析出正确的 seqStart/seqEnd（不 RangeError）；
 * - 常规规模结果与旧实现一致（不回归）；
 * - 空正文/无 seq 时返回 null（不造 0）。
 *
 * ## 不适用条件与已知边界
 * 只覆盖 parseDetailReceipt 的聚合口径；回执正文本身的生成上限不在本判据。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { parseDetailReceipt } from '../src/v2/receipt-lifecycle.mjs'

function bodyWith(n) {
  const parts = ['批次归档：本批 ' + n + '/' + n + ' 个操作；本条回执覆盖其中相邻的 1 个。']
  for (let i = 0; i < n; i += 1) {
    parts.push('- #' + (i + 1) + ' run_code：seq ' + i + '–' + (i + 1) + '（1 次调用，原 ≈10 token / 40 字） 冷记录 mcl2-x-' + i)
  }
  return parts.join('\n')
}

test('H-16 20 万段 seq 仍可解析（旧：RangeError: Maximum call stack size exceeded）', () => {
  const parsed = parseDetailReceipt(bodyWith(200000))
  assert.equal(parsed.seqStart, 0)
  assert.equal(parsed.seqEnd, 200000)
  assert.equal(parsed.members, 200000)
})

test('H-16 常规规模不回归：范围取最小起点与最大终点', () => {
  const text = [
    '批次归档：本批 3/3 个操作；本条回执覆盖其中相邻的 1 个。',
    '- #1 a：seq 40–44（1 次调用，原 ≈10 token / 40 字） 冷记录 mcl2-a',
    '- #2 b：seq 33–37（1 次调用，原 ≈20 token / 80 字） 冷记录 mcl2-b',
    '- #3 c：seq 47–54（1 次调用，原 ≈30 token / 120 字） 冷记录 mcl2-c',
  ].join('\n')
  const parsed = parseDetailReceipt(text)
  assert.equal(parsed.seqStart, 33)
  assert.equal(parsed.seqEnd, 54)
  assert.equal(parsed.releasedTokens, 60)
  assert.deepEqual(parsed.nodeIds, ['mcl2-a', 'mcl2-b', 'mcl2-c'])
})

test('H-16 无 seq / 空正文 → null（不造 0）', () => {
  assert.equal(parseDetailReceipt('批次归档：本批 1/1 个操作。').seqStart, null)
  assert.equal(parseDetailReceipt('').seqEnd, null)
  assert.equal(parseDetailReceipt(undefined).seqStart, null)
})
