/**
 * v3 domain/context 预算器测试（M1）。
 *
 * ## 判据来源
 * 行为规格映射 card 族：P8（先保结构段、裁空教训）、D-12（非法预算不归一）、
 * D-13（丢最旧保最新）、workingset-wiring（无生产方整类摘除且可见）。
 *
 * ## 断言组
 * - 无生产类目进 excluded(no-producer)，不占预算；
 * - structural 无条件保留，超预算标 structuralOverflow（不静默裁空）；
 * - protected 在结构段之后优先；装不下如实 excluded(over-budget)；
 * - soft 超额丢最旧保最新；总用量不超预算（structuralOverflow 除外）；
 * - 预算 null/NaN/负数/小数、类目重复、优先级未知 → V3ContractViolation（fail-fast）。
 *
 * ## 不适用条件与已知边界
 * 字符预算（token 口径 M4 计量另行接入）；双槽/卡片形态属 M4 投影渲染。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { allocateBudget, isReadLeaseActive, SECTION_PRIORITIES } from '../src/v3/domain/context/budget.mjs'

function section(category, priority, chars, producer = true) {
  return { category, priority, chars, producer }
}

test('无生产方的类目整类摘除且可见（不静默）', () => {
  const result = allocateBudget({
    sections: [
      section('anchor', 'structural', 100),
      section('pins', 'soft', 50, false),
    ],
    budgetChars: 1000,
  })
  assert.deepEqual(result.included, ['anchor'])
  assert.deepEqual(result.excluded, [{ category: 'pins', reason: 'no-producer' }])
  assert.equal(result.usedChars, 100)
})

test('structural 无条件保留；超预算如实标 structuralOverflow（P8 裁空教训）', () => {
  const small = allocateBudget({
    sections: [section('anchor', 'structural', 1200)],
    budgetChars: 1000,
  })
  assert.deepEqual(small.included, ['anchor'], '结构段不因预算小而消失')
  assert.equal(small.structuralOverflow, true)
  assert.equal(small.usedChars, 1200)

  const fits = allocateBudget({
    sections: [section('anchor', 'structural', 200)],
    budgetChars: 1000,
  })
  assert.equal(fits.structuralOverflow, false)
})

test('protected 优先于 soft；装不下如实拒绝', () => {
  const result = allocateBudget({
    sections: [
      section('anchor', 'structural', 100),
      section('task-evidence', 'protected', 600),
      section('progress', 'soft', 600),
    ],
    budgetChars: 1000,
  })
  assert.deepEqual(result.included, ['anchor', 'task-evidence'])
  assert.ok(result.excluded.some((x) => JSON.stringify(x) === JSON.stringify({ category: 'progress', reason: 'over-budget' })), '装不下如实拒绝')
  assert.equal(result.usedChars, 700)
})

test('soft 超额丢最旧保最新（D-13）', () => {
  const result = allocateBudget({
    sections: [
      section('claim-old', 'soft', 400),
      section('claim-mid', 'soft', 400),
      section('claim-new', 'soft', 400),
    ],
    budgetChars: 900,
  })
  assert.ok(result.included.includes('claim-new'), '最新必保')
  assert.ok(result.included.includes('claim-mid'))
  assert.ok(!result.included.includes('claim-old'), '最旧先丢')
  assert.equal(result.usedChars, 800)
})

test('非法预算与形状 fail-fast（D-12：null/NaN 不静默归一）', () => {
  for (const bad of [null, NaN, -1, 1.5, '10', undefined]) {
    assert.throws(
      () => allocateBudget({ sections: [], budgetChars: bad }),
      (e) => e?.name === 'V3ContractViolation' && /budgetChars/.test(e.message),
      'bad budget ' + String(bad),
    )
  }
  assert.throws(() => allocateBudget({ sections: [section('a', 'weird', 10)], budgetChars: 100 }), /priority/)
  assert.throws(
    () => allocateBudget({ sections: [section('a', 'soft', 10), section('a', 'soft', 10)], budgetChars: 100 }),
    /category .*重复/,
  )
  assert.ok(Object.isFrozen(SECTION_PRIORITIES))
})

test('空输入与零预算边界', () => {
  const empty = allocateBudget({ sections: [], budgetChars: 100 })
  assert.deepEqual(empty, { included: [], excluded: [], usedChars: 0, budgetChars: 100, structuralOverflow: false, promotedByLease: [] })
  const zero = allocateBudget({ sections: [section('anchor', 'structural', 50)], budgetChars: 0 })
  assert.deepEqual(zero.included, ['anchor'])
  assert.equal(zero.structuralOverflow, true)
})

test('⑥ 租约（retainReads，2026-10-25 用户拍板移植）：活跃租约的 soft 段晋升 protected，不随丢最旧被挤出', () => {
  const now = 1000
  const sections = [
    section('anchor', 'structural', 50),
    { ...section('old-evidence', 'soft', 100), leaseUntil: now - 1 }, // 租约过期
    { ...section('recent-read', 'soft', 100), leaseUntil: now + 5000 }, // 活跃租约
    section('newest', 'soft', 100),
  ]
  // 预算只够 structural + 一个 100：无租约时丢最旧保最新（newest 留）
  const withoutLease = allocateBudget({ sections, budgetChars: 160 })
  assert.deepEqual(withoutLease.included, ['anchor', 'newest'])
  // 有租约（now 注入）：recent-read 晋升 protected 优先装填，newest 填余量被挤
  const withLease = allocateBudget({ sections, budgetChars: 160, now })
  assert.deepEqual(withLease.promotedByLease, ['recent-read'])
  assert.deepEqual(withLease.included, ['anchor', 'recent-read'])
  assert.ok(withLease.excluded.some((e) => e.category === 'newest' && e.reason === 'over-budget'), '被挤出可见')
  // 租约判据失败关闭：参数非法一律不活跃
  assert.equal(isReadLeaseActive({ lastReadAt: NaN, now, ttlMs: 1000 }), false)
  assert.equal(isReadLeaseActive({ lastReadAt: now - 100, now, ttlMs: -1 }), false)
  assert.equal(isReadLeaseActive({ lastReadAt: now - 100, now, ttlMs: 1000 }), true)
  assert.equal(isReadLeaseActive({ lastReadAt: now + 1, now, ttlMs: 1000 }), false, '未来时间戳不算刚读过')
})
