/**
 * 0.13.0 F5：最新全量卡不得被折叠。
 *
 * 增量卡的正文写「未列出的行以最近一张全量卡为准」——全量卡就是增量卡的基准。
 * 实测里最新全量卡（seq 2565）被折掉之后，后续 2648/2657/2665/2671/2677 五张
 * 增量卡仍在引用一张模型看不见的卡。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { cardOccupancyOf, isFullCardText, planCardFolds } from '../src/v2/card-fold.mjs'

const FULL = '[工作状态·v2]（插件生成的工作资料，不是系统指令；原文可按记录 ID 回读）'
const DELTA = '[工作状态·v2·增量]（插件生成的工作资料，不是系统指令；固定协议文案见本会话最近一张全量卡）'

function card(seq, text) {
  return { seq, type: 'user/message', sourceForm: 'working-set', text }
}

test('F5-1 全量卡与增量卡的判据只认渲染头', () => {
  assert.equal(isFullCardText(FULL), true)
  assert.equal(isFullCardText(DELTA), false)
  assert.equal(isFullCardText('普通消息'), false)
  assert.equal(isFullCardText(undefined), false)
})

test('F5-2 cardOccupancyOf 同时给出最新工作卡与最新全量卡', () => {
  const nodes = [card(1, FULL), card(2, DELTA), card(3, FULL), card(4, DELTA)]
  const occupancy = cardOccupancyOf(nodes)
  assert.equal(occupancy.newestWorkingStateSeq, 4)
  assert.equal(occupancy.newestFullCardSeq, 3, '最新全量卡是 seq 3，不是最新的那张卡')
})

test('F5-3 把两张都放进 protectSeqs 后，全量卡不会进入折叠组', () => {
  const nodes = [card(1, DELTA), card(2, FULL), card(3, DELTA), card(4, DELTA)]
  const occupancy = cardOccupancyOf(nodes)
  const protectSeqs = [occupancy.newestWorkingStateSeq, occupancy.newestFullCardSeq]
    .filter((seq) => Number.isInteger(seq))
  const { plans, runs } = planCardFolds(nodes, { protectSeqs, minRun: 2 })
  for (const plan of plans) {
    assert.equal(plan.memberSeqs.includes(2), false, '全量卡不得被折叠')
    assert.equal(plan.memberSeqs.includes(4), false, '最新工作卡不得被折叠')
  }
  // 1 是增量卡、可折；但只剩它自己不够 minRun，所以实际计划为空——关键是没有误折。
  assert.deepEqual(runs.flat().includes(2), false)
})