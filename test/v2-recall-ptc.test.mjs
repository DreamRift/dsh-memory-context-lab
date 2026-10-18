
/**
 * 0.13.0 F1：memory_lab_recall 在 PTC 形态下必须可读。
 *
 * 实测缺陷：run_code 里 await tools.memory_lab_recall({record_ids}) 拿到原始 value，
 * 而 ids/query 模式此前不填顶层 text，模型 r.text?.slice() 得到 undefined，
 * 判定回读失败并放弃。246 步里唯一一次回读就这样失败了（冷库其实返回了 779 token）。
 *
 * 不变量：**任何模式下顶层 text 都是非空字符串**，且正文仍在 records[].text
 * （不复制正文——一次回读只应付一遍 token）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { toToolValue } from '../src/v2/tool.mjs'

test('F1-1 ids 模式：顶层 text 非空，且是指向 records 的摘要', () => {
  const value = toToolValue('s-1', {
    engineEnabled: true,
    mode: 'ids',
    entries: [
      { id: 'mcl2-a', kind: 'operation', fidelity: 'A', integrity: 'full', tokens: 120, text: '正文甲' },
      { id: 'mcl2-b', kind: 'operation', fidelity: 'A', integrity: 'full', tokens: 80, text: '正文乙' },
    ],
    usedTokens: 200,
    budgetTokens: 6000,
    matchedBy: 'record-id',
    nextCursor: null,
    warnings: [],
  })
  assert.equal(typeof value.text, 'string')
  assert.ok(value.text.length > 0, '顶层 text 不得为空')
  assert.match(value.text, /已按记录 ID 回读 2 条/)
  assert.match(value.text, /records\[\]\.text/)
  // 正文只出现在 records 里，不复制到 text（避免一次回读付两遍 token）
  assert.equal(value.text.includes('正文甲'), false)
  assert.equal(value.records[0].text, '正文甲')
})

test('F1-2 ids 模式零命中：明确说「不是读取失败」', () => {
  const value = toToolValue('s-1', {
    engineEnabled: true, mode: 'ids', entries: [], usedTokens: 0, budgetTokens: 6000,
    matchedBy: 'record-id', nextCursor: null, warnings: [],
  })
  assert.ok(value.text.length > 0)
  assert.match(value.text, /不是读取失败/)
})

test('F1-3 query 模式：顶层 text 给出命中数与 ID 清单', () => {
  const value = toToolValue('s-1', {
    engineEnabled: true, mode: 'query', entries: [{ id: 'mcl2-a', kind: 'operation', text: null }],
    totalMatched: 7, usedTokens: 30, budgetTokens: 6000, matchedBy: 'literal', nextCursor: null, warnings: [],
  })
  assert.match(value.text, /命中 7 条/)
  assert.match(value.text, /mcl2-a/)
})

test('F1-4 未启用引擎：顶层 text 仍非空（不得是 null）', () => {
  const value = toToolValue('s-1', {
    engineEnabled: false, mode: 'none', entries: [], usedTokens: 0, budgetTokens: null,
    matchedBy: null, nextCursor: null, warnings: [],
  })
  assert.equal(typeof value.text, 'string')
  assert.ok(value.text.length > 0)
})

test('F1-5 参数错误：text 如实说「本次未执行」，不冒充「查了没有」', () => {
  const value = toToolValue('s-1', {
    engineEnabled: true, mode: 'none', entries: [], error: 'budget_tokens 必须是正整数',
    usedTokens: 0, budgetTokens: null, matchedBy: null, nextCursor: null, warnings: [],
  })
  assert.match(value.text, /本次回读未执行/)
  assert.match(value.text, /budget_tokens 必须是正整数/)
})
