/**
 * 0.13.2-beta.2 守卫（W-04）：增量卡的字符上限不得被尾行突破。
 *
 * ## 缺陷
 * `boundDeltaLines` 在加入正文行前检查 `maxChars`，但尾行「另有 N 行变化未在本卡
 * 列出…」是最后**无条件 push** 的，长度不计入预算。实测 24 行 × 80 字符填充 →
 * 产出 1644 字符 > `CARD_DELTA_MAX_CHARS`(1600)，超 44。
 *
 * 这是 0.13.1 就有的问题，不是回归——但增量卡是**每步固定税**，稳定超限会让
 * 「上界」名不副实：说好的 1600 其实可以到 1644+。
 *
 * ## 判据（改回去必红）
 * - 各种填充宽度下 `delta.text.length <= CARD_DELTA_MAX_CHARS` **严格成立**；
 * - 截断仍如实标记，且尾行仍说明「另有 N 行变化未在本卡列出」「可按记录 ID 回读」；
 * - 行数上限同样不被突破。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  CARD_DELTA_MAX_CHARS,
  CARD_DELTA_MAX_LINES,
  workingStateCardDelta,
} from '../src/v2/working-state.mjs'

const PREVIOUS = ['[工作状态·v2]（旧卡）', '■ 段A', '- 旧行'].join('\n')

function deltaOf({ rows, pad }) {
  const next = ['[工作状态·v2]（新卡）', '■ 段A']
  for (let index = 0; index < rows; index += 1) {
    next.push('- 变化行' + String(index).padStart(2, '0') + 'X'.repeat(pad))
  }
  return workingStateCardDelta({ previousText: PREVIOUS, nextText: next.join('\n') })
}

test('W-04：任何填充宽度下增量卡都不得超出字符上限', () => {
  const worst = { pad: null, len: 0 }
  for (let pad = 40; pad <= 90; pad += 1) {
    const delta = deltaOf({ rows: 24, pad })
    if (!delta) continue
    if (delta.text.length > worst.len) {
      worst.pad = pad
      worst.len = delta.text.length
    }
    assert.ok(
      delta.text.length <= CARD_DELTA_MAX_CHARS,
      `pad=${pad} 时增量卡 ${delta.text.length} 字符 > 上限 ${CARD_DELTA_MAX_CHARS}（超 ${delta.text.length - CARD_DELTA_MAX_CHARS}）`,
    )
    assert.ok(delta.text.split('\n').length <= CARD_DELTA_MAX_LINES, `pad=${pad} 时行数超限`)
  }
  assert.ok(worst.len > 0, '必须有被截断的样本，否则这条断言没测到东西')
})

test('W-04：截断后仍如实说明「还有 N 行没进本卡」并指路回读', () => {
  const delta = deltaOf({ rows: 24, pad: 80 })
  assert.equal(delta.truncated, true, '超长增量必须被截断并显式标记')
  const tail = delta.text.split('\n').at(-1)
  assert.match(tail, /另有 \d+ 行变化未在本卡列出/, `尾行必须说明还有多少行没列：${tail}`)
  assert.match(tail, /按记录 ID 回读/, `截断后必须指路回读：${tail}`)
})

test('W-04：短增量不受影响（不截断、逐字保留变化行）', () => {
  const next = ['[工作状态·v2]（新卡）', '■ 段A', '- 一行变化'].join('\n')
  const delta = workingStateCardDelta({ previousText: PREVIOUS, nextText: next })
  assert.equal(delta.truncated, false)
  assert.ok(delta.text.includes('- 一行变化'))
  assert.ok(delta.text.length <= CARD_DELTA_MAX_CHARS)
})
