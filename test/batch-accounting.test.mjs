/**
 * 0.13.1 守卫：批次口径可审计（F2/F3）。
 *
 * ## 缺陷
 * 实测会话 c1787f24：配置 `batch 10`，但回执写的是「批次归档：6 个相邻操作」。
 * 那个 6 是**相邻段长度**，既不是本批操作数，也不是配置阈值。事后审计只能
 * 看到 6/3/2/4/1，永远读不出「阈值 10 确实生效了 5 次，另有 2 次被单批释放
 * 上限截断」。
 *
 * ## 判据来源
 * 会话 c1787f24 的 `state.json` 账本（59 行归档、21 条回执、7 个批次）
 * 与 `planCooling` 的复算结果（第 1 批 6 个 / 第 2 批 3 个，均被 65,536 截断）。
 *
 * ## 断言组
 * 1. 三个数各自可辨：阈值 / 本批成员 / 本段相邻；
 * 2. 被上限截断时如实说明；
 * 3. 未截断时不出现「截断」字样（防误报）；
 * 4. format 3 的旧渲染**逐字节不变**（restore 依赖它）。
 *
 * ## 不适用条件与已知边界
 * 本守卫只断言渲染层。它绿不等于「账本行也带了这些字段」——那由
 * `cooling.test.mjs` 的归档行断言覆盖。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildBatchReceipt,
  RECEIPT_FORMAT_BATCH,
  RECEIPT_FORMAT_BATCH_V2,
} from '../src/core.mjs'

const MEMBERS = [
  { tools: ['read'], range: { start: 2, end: 3 }, callIds: ['c1'], nodeId: 'node-2', hash: 'a'.repeat(64), chars: 10, tokens: 100, chunks: 1 },
  { tools: ['edit'], range: { start: 5, end: 6 }, callIds: ['c2'], nodeId: 'node-5', hash: 'b'.repeat(64), chars: 10, tokens: 100, chunks: 1 },
]

test('F2a 三个数各自可辨：本批成员 ≠ 本段相邻', () => {
  const text = buildBatchReceipt({
    marker: 'M',
    formatVersion: RECEIPT_FORMAT_BATCH_V2,
    runLength: 2,
    batchThreshold: 10,
    batchMembers: 6,
    members: MEMBERS,
  })
  assert.match(text, /本批 6\/10 个操作/, '阈值与本批成员必须同时出现')
  assert.match(text, /本条回执覆盖其中相邻的 2 个/, '段长必须单独说明')
})

test('F2b 本批成员等于段长时省略冗余说明', () => {
  const text = buildBatchReceipt({
    marker: 'M',
    formatVersion: RECEIPT_FORMAT_BATCH_V2,
    runLength: 4,
    batchThreshold: 10,
    batchMembers: 4,
    members: MEMBERS,
  })
  assert.match(text, /本批 4\/10 个操作/)
  assert.doesNotMatch(text, /本条回执覆盖其中相邻的/, '三者一致时不该出现第三个数')
})

test('F3a 被单批释放上限截断时如实说明', () => {
  const text = buildBatchReceipt({
    marker: 'M',
    formatVersion: RECEIPT_FORMAT_BATCH_V2,
    runLength: 6,
    batchThreshold: 10,
    batchMembers: 6,
    releaseCapped: true,
    members: MEMBERS,
  })
  assert.match(text, /单批释放上限截断/, '短批必须有可解释的原因')
  assert.match(text, /其余留待下批/)
})

test('F3b 未截断时不得出现「截断」字样（防误报）', () => {
  const text = buildBatchReceipt({
    marker: 'M',
    formatVersion: RECEIPT_FORMAT_BATCH_V2,
    runLength: 10,
    batchThreshold: 10,
    batchMembers: 10,
    releaseCapped: false,
    members: MEMBERS,
  })
  assert.doesNotMatch(text, /截断/)
})

test('format 3 的旧渲染逐字节不变（restore 依赖它）', () => {
  const text = buildBatchReceipt({ marker: 'M', formatVersion: RECEIPT_FORMAT_BATCH, members: MEMBERS })
  assert.equal(
    text.split('\n')[1],
    '批次归档：2 个相邻操作已合并替换；正文已沉入本会话隔离冷库，相关提问会自动回注要点。',
    '0.13.0 及更早写下的批次回执必须仍能逐字节重建',
  )
})

test('两个批次格式的编号稳定（升号不得就地改旧格式）', () => {
  assert.equal(RECEIPT_FORMAT_BATCH, 3, 'format 3 是冻结的历史格式')
  assert.equal(RECEIPT_FORMAT_BATCH_V2, 8, '新文案必须新开编号')
})
