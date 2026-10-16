import test from 'node:test'
import assert from 'node:assert/strict'
import { planQuery } from '../src/v2/query-plan.mjs'

test('记录 ID / 调用 ID / 文件名 / 路径进精确通道，自然语言留自由通道', () => {
  const plan = planQuery('读一下 t00000037-r0000 与 call_4f43aa65cec64d9dabdf86aa，然后改 src/v2/retrieval.mjs')
  assert.deepEqual(plan.exact.sort(), ['call_4f43aa65cec64d9dabdf86aa', 'src/v2/retrieval.mjs', 't00000037-r0000'])
  assert.equal(plan.text, '读一下 与 然后改')
  assert.equal(plan.hasQuery, true)
})

test('Windows 路径与 CJK 混合路径整段进精确通道', () => {
  const plan = planQuery('检查 C:\\Users\\cty05\\documents\\report.txt 和 记忆上下文/plugin/package.json')
  assert.deepEqual(plan.exact, ['C:\\Users\\cty05\\documents\\report.txt', '记忆上下文/plugin/package.json'])
  assert.equal(plan.text, '检查 和')
})

test('引号短语整段进精确通道且引号本身不留在自由文本', () => {
  const plan = planQuery('“已归档操作”的原文以及「冷库」的位置')
  assert.deepEqual(plan.exact, ['已归档操作', '冷库'])
  assert.equal(plan.text, '的原文以及 的位置')
})

test('普通词与纯数字/纯字母不进精确通道', () => {
  const plan = planQuery('恢复 失败 1234 abcd 重试')
  assert.deepEqual(plan.exact, [])
  assert.equal(plan.text, '恢复 失败 1234 abcd 重试')
})

test('十六进制指纹（≥12 位）进精确通道', () => {
  const plan = planQuery('基线 hash 525fe51d7352 的来源')
  assert.deepEqual(plan.exact, ['525fe51d7352'])
  assert.equal(plan.text, '基线 hash 的来源')
})

test('整串是一个标识符时自由文本为空但 hasQuery 为真', () => {
  const plan = planQuery('t00000037-r0000')
  assert.deepEqual(plan.exact, ['t00000037-r0000'])
  assert.equal(plan.text, '')
  assert.equal(plan.hasQuery, true)
})

test('空串 / 非字符串输入：全空且 hasQuery 为假，不抛错', () => {
  assert.deepEqual(planQuery(''), { text: '', exact: [], hasQuery: false })
  assert.deepEqual(planQuery(null), { text: '', exact: [], hasQuery: false })
  assert.deepEqual(planQuery(undefined), { text: '', exact: [], hasQuery: false })
  assert.deepEqual(planQuery(12345), { text: '', exact: [], hasQuery: false })
})

test('重复标识符去重（大小写不敏感），超上限截断到 16 个', () => {
  const many = Array.from({ length: 20 }, (_unused, index) => `id-${index}-token`).join(' ')
  const plan = planQuery(many)
  assert.equal(plan.exact.length, 16)
  const duplicated = planQuery('file.mjs FILE.MJS file.mjs')
  assert.deepEqual(duplicated.exact, ['file.mjs'])
})
