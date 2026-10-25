/**
 * v3 卡片渲染器测试（M4 第一批）。
 *
 * ## 判据来源
 * P8（先保结构段/裁空教训）、D-11/12/13（经 allocateBudget 继承）、
 * card-delta-cap（尾行计入上界）、workingset（丢弃可见）。
 *
 * ## 断言组
 * - 预算内全装、页脚为空串不出现在文本里；
 * - 超预算：soft 丢最旧保最新、页脚如实列未装包类目与原因；
 * - 严格上界：无溢出时 text.length ≤ budgetChars（含页脚）恒成立；
 * - structuralOverflow：结构段保留 + 显式标注行；
 * - 无生产方类目：可见摘除；字符数由渲染器自算（调用方谎报无效）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { renderWorkingCard } from '../src/v3/projection/card-renderer.mjs'

function section(category, priority, lines, producer = true) {
  return { category, priority, producer, lines }
}

test('预算内全装；页脚空不占行', () => {
  const card = renderWorkingCard({
    sections: [
      section('anchor', 'structural', ['当前任务：开发计划 v3']),
      section('task-evidence', 'protected', ['- 测试全绿']),
      section('progress', 'soft', ['v3 M4 渲染器已写']),
    ],
    budgetChars: 200,
  })
  assert.deepEqual(card.included, ['anchor', 'task-evidence', 'progress'])
  assert.ok(card.text.includes('当前任务'))
  assert.ok(!card.text.includes('未装包'))
  assert.ok(card.text.length <= 200)
  assert.equal(card.structuralOverflow, false)
})

test('超预算：soft 丢最旧保最新；页脚如实列出（丢弃可见）', () => {
  const card = renderWorkingCard({
    sections: [
      section('anchor', 'structural', ['锚'.repeat(10)]),
      section('old-claims', 'soft', ['旧1'.repeat(10)]),
      section('new-claims', 'soft', ['新1'.repeat(10)]),
    ],
    budgetChars: 120, // 正文预算 120-80=40：锚(11) + 最新软类(21) 恰可装，最旧(21) 装不下
  })
  assert.ok(card.included.includes('anchor'))
  assert.ok(card.included.includes('new-claims'), '最新保留')
  assert.ok(!card.included.includes('old-claims'), '最旧先丢')
  assert.ok(card.text.includes('未装包'))
  assert.ok(card.text.includes('old-claims(over-budget)'))
  assert.ok(card.text.length <= 120, '严格上界含页脚：' + card.text.length)
})

test('structuralOverflow：结构段保留并显式标注，不静默裁空', () => {
  const card = renderWorkingCard({
    sections: [
      section('anchor', 'structural', ['锚'.repeat(100)]),
      section('progress', 'soft', ['软']),
    ],
    budgetChars: 50,
  })
  assert.deepEqual(card.included, ['anchor'])
  assert.equal(card.structuralOverflow, true)
  assert.ok(card.text.includes('结构段超出预算'))
  assert.ok(card.text.includes('未装包'), '丢弃的软类仍如实列出')
})

test('无生产方类目可见摘除；字符数由渲染器自算', () => {
  const card = renderWorkingCard({
    sections: [
      section('anchor', 'structural', ['锚']),
      section('ghost', 'soft', ['不应出现'.repeat(5)], false),
    ],
    budgetChars: 100,
  })
  assert.ok(!card.text.includes('不应出现'))
  assert.ok(card.text.includes('ghost(no-producer)'))
})

test('非法输入失败关闭', () => {
  assert.throws(() => renderWorkingCard({ sections: [], budgetChars: null }), (e) => e?.name === 'V3ContractViolation')
  assert.throws(() => renderWorkingCard({ sections: 'x', budgetChars: 10 }), (e) => e?.name === 'V3ContractViolation')
  assert.throws(() => renderWorkingCard({ sections: [{ category: 'a', priority: 'soft', producer: true, lines: [1] }], budgetChars: 10 }), (e) => e?.name === 'V3ContractViolation')
})
