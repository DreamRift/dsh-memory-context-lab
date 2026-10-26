/**
 * v3 预算器 soft 段「丢最旧保最新」的守卫（H-22，2026-10-26 缺陷排查批）。
 *
 * ## 缺陷
 * allocateBudget 的 soft 段反向扫描时，遇到装不下的段只是 `continue` 跳过，继续往前
 * 装更旧的段。于是「最新段太大」时结果恰好相反：**丢掉刚发出的、保住最旧的**——
 * 正是 D-13 记录过的 v2 老毛病（「被丢的恰好是刚发出的」）。
 * 实测：soft = [old-small(10), mid-small(10), new-huge(100)]，预算 25
 * → included = [old-small, mid-small]，new-huge 被丢。
 *
 * ## 判据
 * - soft 段只保留**后缀**：某段装不下，比它更旧的段一律丢弃（不得「跳过后回填更旧的」）；
 * - 最新段装得下时必保（原有用例语义不变）；
 * - excluded 如实列出每个未装包类目（丢弃可见，不静默）；
 * - usedChars 与实际装包字符一致。
 *
 * ## 不适用条件与已知边界
 * 「最新段本身超过预算」时 soft 段可能一个都装不下（预算有剩也不回填更旧的段）——
 * 这是**刻意**的：保最新优先于占满预算。宁可卡片上空、页脚如实说明「X 类未装包」，
 * 也不给模型一张「只有旧信息、看起来最新信息不存在」的卡。
 * 只覆盖 soft 段的淘汰顺序；structural/protected 的语义不在本判据。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { allocateBudget } from '../src/v3/domain/context/budget.mjs'

const section = (category, priority, chars) => ({ category, priority, chars, producer: true })

test('H-22 最新段装不下时不得回填更旧的段（旧：丢掉最新的、保住最旧的）', () => {
  const result = allocateBudget({
    sections: [section('old-small', 'soft', 10), section('mid-small', 'soft', 10), section('new-huge', 'soft', 100)],
    budgetChars: 25,
  })
  assert.deepEqual(result.included, [], '保最新优先：最新装不下就一个都不回填')
  assert.equal(result.usedChars, 0)
  assert.ok(result.excluded.some((x) => x.category === 'new-huge' && x.reason === 'over-budget'), '最新段必须如实列在 excluded')
  assert.ok(result.excluded.some((x) => x.category === 'old-small' && x.reason === 'over-budget'), '更旧的段同样列在 excluded')
})

test('H-22 中间段装不下时其后（更旧）的段一并丢弃，保留的是后缀', () => {
  const result = allocateBudget({
    sections: [section('a', 'soft', 10), section('b', 'soft', 100), section('c', 'soft', 10)],
    budgetChars: 30,
  })
  // c 装得下（10），b 装不下（100）→ a 也不得回填
  assert.deepEqual(result.included, ['c'], '只保留后缀 [c]')
  assert.equal(result.usedChars, 10)
})

test('H-22 最新段装得下时必保（原有用例语义不变）', () => {
  const result = allocateBudget({
    sections: [section('old', 'soft', 400), section('mid', 'soft', 400), section('new', 'soft', 400)],
    budgetChars: 900,
  })
  assert.deepEqual(result.included, ['mid', 'new'], '丢最旧保最新')
  assert.equal(result.usedChars, 800)
})

test('H-22 soft 与 protected 共存时仍按后缀装填', () => {
  const result = allocateBudget({
    sections: [
      section('anchor', 'structural', 100),
      section('evidence', 'protected', 200),
      section('old', 'soft', 50),
      section('new', 'soft', 50),
    ],
    budgetChars: 400,
  })
  // 300 已用，剩 100 → new(50) 装得下、old(50) 也装得下，两者都保留
  // （included 的 soft 段按原顺序追加，故为 old, new——顺序是渲染顺序，不是优先级）
  assert.deepEqual(result.included, ['anchor', 'evidence', 'old', 'new'])
  assert.equal(result.usedChars, 400)
})
