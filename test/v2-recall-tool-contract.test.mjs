/**
 * P1-7 检索口径文案如实（0.12.0）。
 *
 * 缺陷（G4）：工具与告警说「不含正文词」，实际索引 ≤8 KiB 正文 + CJK 二元组。
 * **模型被劝退不敢用 `query`，于是退回 `tools.read`**——这条文案直接加剧了
 * 「回读 0 次、重读 55 次」。
 *
 * 不变量：描述含「正文词元」且不含「不含正文词」；描述与索引范围引用**同一常量**。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { INDEX_TEXT_MAX_BYTES as RETRIEVAL_LIMIT } from '../src/v2/retrieval.mjs'
import {
  INDEX_TEXT_MAX_BYTES,
  V2_RECALL_TOOL_DESCRIPTION,
  V2_RECALL_TOOL_NAME,
  V2_RECALL_TOOL_PARAMETERS,
} from '../src/v2/tool.mjs'

test('P1-7a 工具描述如实写「正文词元」与「中文二元组」', () => {
  assert.ok(V2_RECALL_TOOL_DESCRIPTION.includes('正文词元'), V2_RECALL_TOOL_DESCRIPTION)
  assert.ok(V2_RECALL_TOOL_DESCRIPTION.includes('中文二元组'))
  assert.ok(V2_RECALL_TOOL_DESCRIPTION.includes('不返回相关性分数'))
})

test('P1-7b 不再出现「不含正文词」这种与实现相反的劝退文案', () => {
  assert.equal(V2_RECALL_TOOL_DESCRIPTION.includes('不含正文词'), false)
  assert.equal(V2_RECALL_TOOL_DESCRIPTION.includes('正文里的词不会因此被搜到'), false)
})

test('P1-7c 描述与索引范围引用同一常量（改一处即两处同步）', () => {
  assert.equal(INDEX_TEXT_MAX_BYTES, RETRIEVAL_LIMIT)
  assert.equal(INDEX_TEXT_MAX_BYTES, 8 * 1024)
  assert.ok(V2_RECALL_TOOL_DESCRIPTION.includes(String(INDEX_TEXT_MAX_BYTES / 1024) + ' KiB'))
})

test('P1-7d 工具名与参数契约不变（工具集恒定，前缀缓存纪律）', () => {
  assert.equal(V2_RECALL_TOOL_NAME, 'memory_lab_recall')
  assert.deepEqual(Object.keys(V2_RECALL_TOOL_PARAMETERS.properties), ['record_ids', 'query', 'budget_tokens', 'cursor'])
  assert.equal(V2_RECALL_TOOL_PARAMETERS.additionalProperties, false)
})
