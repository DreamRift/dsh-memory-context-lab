/**
 * P2-10（0.15.1）：单条摘录实际可达 `2×maxChars+3`，而合同写的是「单条摘录的码点预算」。
 *
 * ## 缺陷
 * `SEARCH_EXCERPT_MAX_CHARS = 160` 的注释是「**单条摘录**的码点预算」，读起来像总预算；
 * 但 `selectExcerpt` 一直是「**每个窗口**各给一份，最多 `MAX_SPANS=2` 个窗口」。于是单条
 * 摘录的真实长度可达 160×2+3 = **323**（实测吻合）。后果不是丢数据，而是**语义漂移**：
 * 任何按 160 估算「一条命中占多少上下文」的地方都会低估近一倍（回注预算减半）。
 *
 * ## 判据来源
 * docs/dev-0.15.1/记忆上下文-0.15.1-独立排查报告.md §3.2 P2-10（复现）；台账该项标
 * 「需口径裁定」。用户裁定「全部按顺序修、根因修复」。
 *
 * ## 修法（口径裁定：把合同改成与实测一致，不收窄实现）
 * 收紧成总预算会让「两个远处事实都可见」这个**已被 G1/P5 明确保护的产品行为**消失
 * （实测两个用例会红）。P2-10 的判定是「语义漂移」而不是「超额」，所以真源应当改名：
 * - `SEARCH_EXCERPT_MAX_CHARS` 的语义改为「**每窗口**预算」（注释写明历史误读）；
 * - 新增 `SEARCH_EXCERPT_MAX_TOTAL_CHARS`（= 每窗口 × 窗口数 + 连接符）作为唯一真实上界，
 *   预算推算必须用它；
 * - `selectExcerpt` 内部按「maxChars × maxSpans + 连接符」计算**本次调用**的真实上界并断言，
 *   默认参数下必须等于合同常量（常量被真实消费，且不会把更大的 maxChars 误判越界）。
 *
 * ## 断言组
 * 1. 单条摘录长度 ≤ `SEARCH_EXCERPT_MAX_TOTAL_CHARS`，且两个远处事实都可见（不牺牲产品行为）；
 * 2. 默认参数下实现算出的上界等于合同常量 323（消费点存在，不是死常量）；
 * 3. 上界常量与实测一致：`MAX_TOTAL_CHARS === 160×2+3 = 323`（数字对不上就说明语义又漂了）；
 * 4. 单窗口场景长度 ≤ 每窗口预算（不因为引入上界而放宽单窗口）。
 *
 * ## 不适用条件与已知边界
 * - 只修「语义/观测」，不改变任何正文取法（G1/P5 的窗口选择行为逐字节不变）。
 * - 引用页与分页预算另有各自上界，不在本条。
 *
 * ## 定点变异自证
 * 把 `MAX_TOTAL_CHARS` 退回 `= MAX_CHARS`（假装是总预算）→ 组 1/3 红。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { selectExcerpt } from '../src/v3/domain/retrieval/excerpt.mjs'
import {
  SEARCH_EXCERPT_JOINER,
  SEARCH_EXCERPT_MAX_CHARS,
  SEARCH_EXCERPT_MAX_SPANS,
  SEARCH_EXCERPT_MAX_TOTAL_CHARS,
} from '../src/v3/contracts/tools.mjs'

const cp = (s) => [...s].length

test('P2-10 上界常量与实测一致：160×2+3=323（旧注释把它当总预算）', () => {
  assert.equal(SEARCH_EXCERPT_MAX_CHARS, 160)
  assert.equal(SEARCH_EXCERPT_MAX_SPANS, 2)
  assert.equal(cp(SEARCH_EXCERPT_JOINER), 3)
  assert.equal(SEARCH_EXCERPT_MAX_TOTAL_CHARS, 323, '真实上界必须是每窗口×窗口数+连接符')
})

test('P2-10 两个远处事实都可见，且总长不超过真实上界', () => {
  // 两个远处标识符 + 中段填充：必然需要两个窗口。
  const text = 'ERR_ONE_X1 ' + '填充'.repeat(400) + ' ERR_TWO_X2 ' + '尾部'.repeat(200)
  const excerpt = selectExcerpt(text, 'ERR_ONE_X1 ERR_TWO_X2', { maxChars: SEARCH_EXCERPT_MAX_CHARS, maxSpans: SEARCH_EXCERPT_MAX_SPANS })
  assert.ok(excerpt.text.includes('ERR_ONE_X1'), '第一个远处事实必须可见：' + excerpt.text.slice(0, 80))
  assert.ok(excerpt.text.includes('ERR_TWO_X2'), '第二个远处事实必须可见（不能被总预算裁掉）：' + excerpt.text.slice(-80))
  const length = cp(excerpt.text)
  assert.ok(length <= SEARCH_EXCERPT_MAX_TOTAL_CHARS, '单条摘录不得超过真实上界：' + length)
  assert.ok(length > SEARCH_EXCERPT_MAX_CHARS, '两窗口场景本来就允许超过每窗口预算（这正是语义漂移的来源）')
})

test('P2-10 单窗口场景仍不超过每窗口预算（未放宽既有约束）', () => {
  const text = '唯一命中 ERR_ONLY_X9 ' + '填充'.repeat(400)
  const excerpt = selectExcerpt(text, 'ERR_ONLY_X9', { maxChars: SEARCH_EXCERPT_MAX_CHARS, maxSpans: SEARCH_EXCERPT_MAX_SPANS })
  assert.equal(excerpt.spans.length, 1)
  assert.ok(cp(excerpt.text) <= SEARCH_EXCERPT_MAX_CHARS, '单窗口必须 ≤ 每窗口预算：' + cp(excerpt.text))
})
