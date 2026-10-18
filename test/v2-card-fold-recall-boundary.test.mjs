/**
 * P0-6 折叠语义：回注包不得与工作卡同折（0.12.0）。
 *
 * 缺陷（G1）：`card-fold.mjs` 把 `recall` 算作卡形态；同一步的回注包（prepend）
 * 与工作卡（append）是两条相邻 `user/message`，正好满足 `minRun=2`，下一次归档时
 * 被折成一条回执——**刚读回的证据从投影消失**。这是自激循环的另一半：不是重复
 * 注入，而是注入即被折掉。
 *
 * 不变量：折叠区间不得包含回注包；人类消息、assistant、tool/result 仍是硬边界；
 * 折叠计划仍不重叠、保序。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { CARD_FOLD_EXCLUDED_FORMS, CARD_FOLD_FORMS, isCardNode, planCardFolds } from '../src/v2/card-fold.mjs'
import { FOLD_RECEIPT_MARKER, isReceiptMessage, V2_RECEIPT_MARKER } from '../src/core.mjs'

function node(seq, { type = 'user/message', form = null, text = '' } = {}) {
  return { seq, type, sourceForm: form, text }
}
const card = (seq) => node(seq, { form: 'working-set', text: '[工作状态·v2] 某张卡' })
const receipt = (seq) => node(seq, { form: 'memory-lab2-surface', text: V2_RECEIPT_MARKER + '\n工具：read' })
const recall = (seq) => node(seq, { form: 'recall', text: '以下是本会话隔离冷库中的节选…' })
const human = (seq) => node(seq, { form: null, text: '用户的真实请求' })
const assistant = (seq) => node(seq, { type: 'assistant/message', text: '助手正文' })
const toolResult = (seq) => node(seq, { type: 'tool/result', text: '工具结果' })

test('P0-6a 回注包不是卡形态：recall 已移出 CARD_FOLD_FORMS，并登记为排除形态', () => {
  assert.equal(CARD_FOLD_FORMS.includes('recall'), false, 'recall 不得再算卡形态')
  assert.deepEqual([...CARD_FOLD_EXCLUDED_FORMS], ['recall'])
  assert.equal(isCardNode(recall(3)), false, 'isCardNode 对回注包必须为 false')
  assert.equal(isCardNode(card(2)), true)
})

test('P0-6b 回注包与工作卡相邻时**不折叠**（真实每步形态：卡 + 回注包相邻）', () => {
  // 真实形态：同一 pre-step 里回注包 prepend、工作卡 append，两条相邻。
  const nodes = [human(1), card(2), recall(3), assistant(4)]
  const { plans, runs } = planCardFolds(nodes, { minRun: 2 })
  assert.equal(plans.length, 0, '卡 + 回注包只有一张卡，不得折叠')
  assert.deepEqual(runs, [[2]], '卡组只含真正的工作卡')
})

test('P0-6c 回注包夹在两段卡组之间：两段各自断组，回注包不在任何成员列表里', () => {
  const nodes = [human(1), card(2), card(3), recall(4), card(5), card(6), assistant(7)]
  const { plans } = planCardFolds(nodes, { minRun: 2 })
  assert.equal(plans.length, 2, '[2,3] 与 [5,6] 两段卡组')
  assert.deepEqual(plans.map((plan) => plan.memberSeqs), [[2, 3], [5, 6]])
  for (const plan of plans) assert.equal(plan.memberSeqs.includes(4), false, '回注包不得进入折叠区间')
})

test('P0-6d 仅工作卡相邻时仍然折叠（修复不得顺手关掉折叠）', () => {
  const nodes = [human(1), card(2), card(3), assistant(4)]
  const { plans } = planCardFolds(nodes, { minRun: 2 })
  assert.equal(plans.length, 1)
  assert.deepEqual(plans[0].memberSeqs, [2, 3])
})

test('P0-6e 折叠回执成员列表不含 recall 形态（按 forms 复核）', () => {
  // 0.13.0 F0：归档回执（receipt 节点）也退出折叠——它是 restore 的唯一句柄，
  // 折掉它等于删掉「原文可恢复」的承诺（实测 221/230 不可恢复）。
  // 所以这里的回执节点同时是断组边界：2 与 4 各自单卡，不足 minRun，不折叠。
  const nodes = [human(1), card(2), receipt(3), card(4), assistant(5)]
  const { plans, runs } = planCardFolds(nodes, { minRun: 2 })
  assert.equal(plans.length, 0, '回执把卡组切开，两侧单卡都不折叠')
  assert.deepEqual(runs, [[2], [4]], '回执不是卡，且不被任何组包含')
  for (const run of runs) assert.equal(run.includes(3), false, '回执不得进入任何折叠组')
})

test('P0-6f 人类 / assistant / tool-result 仍是硬边界（既有红线不变）', () => {
  const nodes = [card(1), human(2), card(3), assistant(4), card(5), toolResult(6), card(7)]
  const { plans, runs } = planCardFolds(nodes, { minRun: 2 })
  assert.equal(plans.length, 0, '全部被非卡节点切开，单卡组不折叠')
  assert.deepEqual(runs, [[1], [3], [5], [7]])
})

test('P0-6g 折叠计划不重叠且保序（活动面顺序，不按 seq 重排）', () => {
  const nodes = [human(1), card(2), card(3), card(4), card(5), assistant(6)]
  const { plans } = planCardFolds(nodes, { minRun: 2, maxRun: 2 })
  assert.deepEqual(plans.map((plan) => plan.memberSeqs), [[2, 3], [4, 5]])
  const all = plans.flatMap((plan) => plan.memberSeqs)
  assert.equal(new Set(all).size, all.length, '成员不得重复（计划不重叠）')
  assert.deepEqual(all, [...all].sort((a, b) => a - b), '计划保序')
})

test('P0-6h 折叠回执标记是单一常量，且被 isReceiptMessage 认作程序注入', () => {
  assert.equal(FOLD_RECEIPT_MARKER, '[已折叠工作卡·v2]')
  const message = { content: [{ type: 'text', text: FOLD_RECEIPT_MARKER + '\n折叠卡 2 张' }] }
  assert.equal(isReceiptMessage(message), true, '折叠回执不得被当成人类请求（P1-2 同源判定）')
  const human2 = { content: [{ type: 'text', text: '帮我看看这个报错' }] }
  assert.equal(isReceiptMessage(human2), false)
})
