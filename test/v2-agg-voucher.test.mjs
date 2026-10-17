/**
 * P3 聚合凭证（agg-voucher.mjs）单测。
 *
 * 覆盖：成员识别（只认 v2 回执）、连续组与边界打断、min/max 切片、
 * 计划字段保真、恒定渲染与反向解析、expand 分页与遗忘占位、
 * 计划文件（重放窗口）超限淘汰与损坏重建。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  AGG_VOUCHER_MARKER,
  AGG_VOUCHER_PAGE_SIZE,
  dropVoucherPlan,
  getVoucherPlan,
  isBoundaryNode,
  isV2ReceiptNode,
  loadVoucherPlans,
  parseAggVoucherText,
  parseReceiptRecordIds,
  parseReceiptTools,
  planAggregateVouchers,
  renderExpansionPage,
  renderVoucherText,
  saveVoucherPlan,
  voucherIdOf,
  voucherPlansPath,
} from '../src/v2/agg-voucher.mjs'

const V2_MARKER = '[已归档操作·v2]'

function receiptNode(seq, textSuffix = '默认回执') {
  return { seq, source: { kind: 'user', form: 'memory-lab2-surface' }, content: [{ type: 'text', text: V2_MARKER + '\n' + textSuffix }] }
}

function textNode(seq, text) {
  return { seq, source: { kind: 'user' }, content: [{ type: 'text', text }] }
}

async function withTempDir(name, body) {
  const dir = await mkdtemp(path.join(tmpdir(), 'mcl2agg-' + name + '-'))
  try {
    await body(dir)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

test('isV2ReceiptNode：v2 回执是成员；v1 回执/凭证/人类消息都是边界', () => {
  assert.equal(isV2ReceiptNode(receiptNode(1)), true)
  assert.equal(isV2ReceiptNode(textNode(2, '[已归档操作] 旧格式回执')), false, 'v1 回执不是成员')
  assert.equal(isV2ReceiptNode(textNode(3, AGG_VOUCHER_MARKER + '\n凭证')), false, '聚合凭证不得再被聚合')
  assert.equal(isBoundaryNode(textNode(4, '用户消息')), true)
  assert.equal(isBoundaryNode(null), true)
})

test('parseReceiptRecordIds：逐条解析冷记录 id 并去重', () => {
  const text = '冷记录：mcl2-7969193d85fc92f7e3148fd9-000001 hash：x\n冷记录：mcl2-7969193d85fc92f7e3148fd9-000001 hash：y\n冷记录：mcl2-aaaaaaaaaaaaaaaaaaaaaaaa-000002'
  assert.deepEqual(parseReceiptRecordIds(text), [
    'mcl2-7969193d85fc92f7e3148fd9-000001',
    'mcl2-aaaaaaaaaaaaaaaaaaaaaaaa-000002',
  ])
  assert.deepEqual(parseReceiptRecordIds('没有冷记录'), [])
  assert.deepEqual(parseReceiptRecordIds(null), [])
})

test('parseReceiptTools：单段工具行与批次头部按调用计入直方图', () => {
  // 真实回执格式：单段「工具：a」；批次只有头部「工具：a、b」（成员行 - #N 不带工具名）。
  const single = parseReceiptTools('工具：run_code\n来源：seq 1')
  // 直方图用 null-prototype 防原型链键；deepEqual 比较前展开为普通对象。
  assert.deepEqual({ ...single }, { run_code: 1 })
  const batch = parseReceiptTools('工具：run_code、run_code、read_file\n批次归档：3 个相邻操作已合并替换')
  assert.deepEqual({ ...batch }, { run_code: 2, read_file: 1 })
  assert.deepEqual({ ...parseReceiptTools('无工具行') }, {})
})

test('planAggregateVouchers：连续组聚合成计划；边界打断、过短跳过、超长切片', () => {
  const longRun = Array.from({ length: 4 }, (_, i) => receiptNode(i + 1))
  const human = textNode(5, '用户插话')
  const twoRun = [receiptNode(6), receiptNode(7)]
  const assistant = textNode(8, '助手正文，打断第二段与第三段')
  const tail = [receiptNode(9), receiptNode(10), receiptNode(11), receiptNode(12)]
  const { plans, runs, skippedShort } = planAggregateVouchers([...longRun, human, ...twoRun, assistant, ...tail])

  assert.equal(runs.length, 3, '三段连续组')
  assert.deepEqual(runs[0], [1, 2, 3, 4])
  assert.equal(skippedShort, 1, '长度 2 的组被跳过')
  assert.equal(plans.length, 2, '两个 ≥3 的组各得一张计划')

  const first = plans[0]
  assert.equal(first.voucherId, voucherIdOf(1, 4, [1, 2, 3, 4]))
  assert.equal(first.memberCount, 4)
  assert.ok(first.voucherText.startsWith(AGG_VOUCHER_MARKER))
  assert.ok(first.voucherText.includes('/memory-lab2 expand ' + first.voucherId))

  const big = Array.from({ length: 5 }, (_, i) => receiptNode(i + 1))
  const sliced = planAggregateVouchers(big, { maxRunLength: 2, minRunLength: 1 })
  assert.equal(sliced.plans.length, 3, '按上限切片')
  assert.deepEqual(sliced.plans[0].memberSeqs, [1, 2])
  assert.deepEqual(sliced.plans[2].memberSeqs, [5])
})

test('renderVoucherText：恒定渲染——同输入同字节，无时间戳', () => {
  const input = { voucherId: 'agg-1-4-abcdef', startSeq: 1, endSeq: 4, memberCount: 4, recordCount: 3, toolHistogram: { run_code: 3, read: 1 }, tokensEstimate: 120 }
  const text1 = renderVoucherText(input)
  const text2 = renderVoucherText(input)
  assert.equal(text1, text2)
  const parsed = parseAggVoucherText(text1)
  assert.equal(parsed.voucherId, 'agg-1-4-abcdef')
  assert.equal(parsed.startSeq, 1)
  assert.equal(parsed.endSeq, 4)
  assert.equal(parsed.memberCount, 4)
  assert.equal(parseAggVoucherText('普通文本'), null)
})

test('renderExpansionPage：分页恒定、遗忘成员占位、末页如实标记', () => {
  const voucher = { voucherId: 'agg-1-4-abcdef', startSeq: 1, endSeq: 4, memberSeqs: [1, 2, 3, 4] }
  const texts = ['回执一', '回执二', '回执三', '回执四']
  const page1 = renderExpansionPage({ voucher, receiptTexts: texts, page: 1 })
  // receiptTexts 是按成员 seq 平行的**全量**数组（隐藏槽位为 undefined）；
  // 第 2 页由渲染器按页起点偏移取原文（BUG-006）。
  const page2 = renderExpansionPage({ voucher, receiptTexts: texts, page: 2 })
  assert.ok(page1.includes('第 1/2 页'), 'pageSize=3，4 段共 2 页')
  assert.ok(page1.includes('回执三'))
  assert.ok(page1.includes('expand agg-1-4-abcdef 2'), '页脚带下一页提示')
  assert.ok(page2.includes('第 2/2 页'))
  assert.ok(page2.includes('（末页）'))
  assert.equal(page2.includes('回执四'), true)

  const forgottenPage = renderExpansionPage({ voucher, receiptTexts: texts, forgottenMemberSeqs: [1], page: 1 })
  assert.ok(forgottenPage.includes('已软遗忘或不可读'))
  assert.equal(forgottenPage.includes('回执一'), false, '遗忘成员原文不得回注')

  const overflow = renderExpansionPage({ voucher, receiptTexts: texts, page: 99 })
  assert.ok(overflow.includes('第 2/2 页'), '越界页夹取到末页')
  assert.equal(AGG_VOUCHER_PAGE_SIZE, 3, '每页 3 段（契约冻结）')
})

test('计划文件：save/load/drop 原子替换；超限丢最旧；损坏按空重建', async () => {
  await withTempDir('plans', async (dir) => {
    for (let i = 1; i <= 5; i += 1) {
      await saveVoucherPlan(dir, { voucherId: 'agg-' + i, memberSeqs: [i], createdAt: '2026-10-16T08:00:0' + i + '.000Z' })
    }
    let plans = await loadVoucherPlans(dir)
    assert.equal(plans.length, 5)

    await saveVoucherPlan(dir, { voucherId: 'agg-3', memberSeqs: [3, 4], createdAt: '2026-10-16T09:00:00.000Z' })
    plans = await loadVoucherPlans(dir)
    assert.equal(plans.length, 5, '同 id 计划被替换，总量不变')
    const replaced = await getVoucherPlan(dir, 'agg-3')
    assert.deepEqual(replaced?.memberSeqs, [3, 4], '取到的是替换后的新计划')

    for (let i = 0; i < 32; i += 1) {
      await saveVoucherPlan(dir, { voucherId: 'bulk-' + i, createdAt: '2026-10-16T10:' + String(i).padStart(2, '0') + ':00.000Z' })
    }
    plans = await loadVoucherPlans(dir)
    assert.equal(plans.length, 32, '计划上限 32，超限丢最旧')
    assert.equal(await getVoucherPlan(dir, 'agg-1'), null, '最旧的先被淘汰')

    await writeFile(voucherPlansPath(dir), '{plans: 损坏', 'utf8')
    assert.deepEqual(await loadVoucherPlans(dir), [], '损坏计划文件按空处理，不静默重建')
    assert.equal((await getVoucherPlan(dir, 'bulk-1')), null)

    await saveVoucherPlan(dir, { voucherId: 'after-corrupt', createdAt: '2026-10-16T11:00:00.000Z' })
    assert.equal((await getVoucherPlan(dir, 'after-corrupt'))?.voucherId, 'after-corrupt')

    const drop = await dropVoucherPlan(dir, 'after-corrupt')
    assert.equal(drop.dropped, true)
    assert.equal(await getVoucherPlan(dir, 'after-corrupt'), null)
  })
})