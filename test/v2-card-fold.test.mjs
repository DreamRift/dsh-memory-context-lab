/**
 * S3 卡片组折叠（card-fold.mjs）的红例先行套件（0.10.1 第二批）。
 *
 * 被测面（G1-S3 冻结接口第 2 条）：
 * - planCardFolds：从活动面节点扫描**连续的插件工作卡组**，产出 surface replace
 *   折叠计划。纯函数：身份判定只认 source.form / 回执标记，绝不按文字前缀吞消息；
 *   任何非卡节点（assistant、tool/result、人类 user、system）都是断组边界。
 * - renderFoldReceipt：折叠回执文本是纯函数（成员 seq/范围/计数，无时间戳），
 *   同输入同字节，且自报「成员原文在 append-only 日志」。
 *
 * 红例背景（方案 §6 + H0 裁定）：C,A,T,C,A,T 交错时连续组折叠永不触发，但
 * 插件自身的 working-set/recall 消息在 pre-step 尾部追加，实际形成连续卡组——
 * 折叠它们有真实收益；而「跨非卡区间整段 replace」会吞掉助手/工具消息，被
 * 明确禁止。这些断言锁死这两条边界。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { planCardFolds, renderFoldReceipt, CARD_FOLD_DEFAULTS } from '../src/v2/card-fold.mjs'
import { V2_RECEIPT_MARKER } from '../src/core.mjs'

// ---- 测试夹具：活动面节点视图 ------------------------------------------------
// 与 runtime.surfaceVoucherNodesOf 同构的最小视图：{ seq, type, sourceForm, text }。

function cardNode(seq, { form = 'working-set', text = '[工作状态·v2] 某张卡' } = {}) {
  return { seq, type: 'user/message', sourceForm: form, text }
}
function receiptNode(seq, text = V2_RECEIPT_MARKER + '\n工具：read') {
  return { seq, type: 'user/message', sourceForm: 'memory-lab2-surface', text }
}
function humanNode(seq, text = '用户的真实请求') {
  return { seq, type: 'user/message', sourceForm: null, text }
}
function assistantNode(seq) {
  return { seq, type: 'assistant/message', sourceForm: null, text: '助手正文' }
}
function toolResultNode(seq) {
  return { seq, type: 'tool/result', sourceForm: null, text: '工具结果' }
}
function systemNode(seq) {
  return { seq, type: 'system/message', sourceForm: null, text: 'system prompt' }
}

// ---- planCardFolds：连续组与断组边界 -----------------------------------------

test('S3-F1 连续插件卡组（≥minRun）产出折叠计划：范围/成员/文本齐全', () => {
  const nodes = [
    systemNode(0),
    humanNode(1),
    cardNode(2),
    cardNode(3, { form: 'recall' }),
    receiptNode(4),
    humanNode(5),
  ]
  const { plans } = planCardFolds(nodes, { minRun: 2 })
  assert.equal(plans.length, 1, '2,3,4 是一个连续卡组（working-set+recall+回执凭证）')
  const plan = plans[0]
  assert.equal(plan.startSeq, 2)
  assert.equal(plan.endSeq, 4)
  assert.deepEqual(plan.memberSeqs, [2, 3, 4])
  assert.equal(typeof plan.text, 'string')
  assert.ok(plan.text.length > 0)
})

test('S3-F2 断组边界：assistant / tool-result / 人类 user 节点都切断卡组，绝不跨非卡区间', () => {
  // 组1: [2] 单卡；assistant 断组；组2: [4,5]；人类断组；组3: [7] 单卡。
  const nodes = [
    systemNode(0),
    humanNode(1),
    cardNode(2),
    assistantNode(3),
    cardNode(4),
    cardNode(5, { form: 'recall' }),
    humanNode(6),
    cardNode(7),
  ]
  const { plans } = planCardFolds(nodes, { minRun: 2 })
  assert.equal(plans.length, 1, '只有 [4,5] 够组长；单卡组 [2] 与 [7] 不折叠')
  assert.equal(plans[0].startSeq, 4)
  assert.equal(plans[0].endSeq, 5)
})

test('S3-F3 吞卡不吞消息：折叠区间两端必须是卡节点，被吞区间内不得含非卡节点（对计划做端到端复核）', () => {
  const nodes = [
    systemNode(0),
    humanNode(1),
    cardNode(2),
    receiptNode(3),
    cardNode(4),
    humanNode(5),
  ]
  const { plans } = planCardFolds(nodes, { minRun: 2 })
  assert.equal(plans.length, 1)
  const plan = plans[0]
  // 对每个成员复核身份：区间内所有节点都必须是卡（按同一判定函数）。
  for (const seq of plan.memberSeqs) {
    const node = nodes.find((n) => n.seq === seq)
    assert.ok(node, '成员必须是真实节点')
    assert.notEqual(node.type, 'assistant/message')
    assert.notEqual(node.type, 'tool/result')
    assert.notEqual(node.type, 'system/message')
    if (node.type === 'user/message') {
      const isCard = node.sourceForm === 'working-set' || node.sourceForm === 'working-state'
        || node.sourceForm === 'recall' || (node.text ?? '').startsWith(V2_RECEIPT_MARKER)
      assert.equal(isCard, true, 'user 节点入组必须满足卡身份判定')
    }
  }
})

test('S3-F4 长于 maxRun 的组按上限切片，切片间不重叠且保序', () => {
  const nodes = [systemNode(0), humanNode(1)]
  for (let i = 0; i < 7; i += 1) nodes.push(cardNode(2 + i))
  const { plans } = planCardFolds(nodes, { minRun: 2, maxRun: 3 })
  assert.equal(plans.length, 2, '7 张卡按 3/3/1 切片；尾片 1 张低于 minRun 应整组丢弃，不允许残片')
  assert.deepEqual(plans.map((p) => p.memberSeqs), [[2, 3, 4], [5, 6, 7]])
})

test('S3-F5 文字上像卡但来源是人类的 user 消息绝不入组（身份判定不看内容前缀）', () => {
  const lookalike = (seq) => ({ seq, type: 'user/message', sourceForm: null, text: '[工作状态·v2] 用户手打的相似文本' })
  const nodes = [
    systemNode(0),
    humanNode(1),
    cardNode(2),
    lookalike(3),
    cardNode(4),
  ]
  const { plans } = planCardFolds(nodes, { minRun: 2 })
  assert.equal(plans.length, 0, '人类消息断组：[2] 与 [4] 各自成单卡组，不够 minRun')
})

test('S3-F6 低于 minRun 的组不折叠；无卡会话返回空计划', () => {
  const few = [systemNode(0), humanNode(1), cardNode(2)]
  assert.equal(planCardFolds(few, { minRun: 2 }).plans.length, 0)
  const none = [systemNode(0), humanNode(1), assistantNode(2), toolResultNode(3)]
  const result = planCardFolds(none, { minRun: 2 })
  assert.equal(result.plans.length, 0)
  assert.ok(Array.isArray(result.runs))
})

// ---- renderFoldReceipt：确定性渲染 -------------------------------------------

test('S3-F7 折叠回执是纯函数：同输入逐字节一致，含成员范围与计数，无时间戳', () => {
  const a = renderFoldReceipt({ startSeq: 2, endSeq: 4, memberSeqs: [2, 3, 4], forms: ['working-set', 'recall', 'receipt'] })
  const b = renderFoldReceipt({ startSeq: 2, endSeq: 4, memberSeqs: [2, 3, 4], forms: ['working-set', 'recall', 'receipt'] })
  assert.equal(a, b)
  assert.ok(a.includes('seq 2–4'))
  assert.ok(a.includes('3'), '必须报告成员数')
  assert.ok(/append-only 日志/.test(a), '必须自报成员原文位置')
  assert.ok(!/20\d{2}-\d{2}-\d{2}/.test(a), '不得含时间戳（前缀缓存安全）')
})

test('S3-F8 CARD_FOLD_DEFAULTS 提供有界默认（minRun≥2、maxRun 有上限），且为冻结对象', () => {
  assert.ok(CARD_FOLD_DEFAULTS.minRun >= 2)
  assert.ok(Number.isInteger(CARD_FOLD_DEFAULTS.maxRun) && CARD_FOLD_DEFAULTS.maxRun >= 2)
  assert.ok(Object.isFrozen(CARD_FOLD_DEFAULTS))
})
