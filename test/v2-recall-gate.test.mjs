/**
 * P1-3 回注信息量门槛（0.12.0）。
 *
 * 缺陷：准入只看「有没有命中」，不看「命中里有没有值得说的」。`client-adapter` 的
 * content 只有 `已归档…（范围 X；工具 Y）`——没有正文、没有摘要、没有重合词。
 *
 * 方案：命中项必须至少满足其一——有结构摘要（工具/范围/片段种类）、有可读重合词、
 * 有明确结构关系；纯壳不注入。弱候选显式标 `weak`（0.11.0 已有 weakPointer），
 * 不与强命中混列；无合格命中不注入空块。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { hasInformativeStructure } from '../src/v2/client-adapter.mjs'

function entry({ range = null, tools = null, spanKind = null, nodeId = 'mcl2-aaaabbbbcccc-000001' } = {}) {
  return {
    id: 't00000001-r0001',
    inline: { nodeId, range, tools },
    refs: spanKind === null ? {} : { spanKind },
  }
}

test('P1-3a 有范围：可注入（结构事实之一）', () => {
  assert.equal(hasInformativeStructure(entry({ range: { start: 2, end: 3 } })), true)
})

test('P1-3b 有工具名：可注入', () => {
  assert.equal(hasInformativeStructure(entry({ tools: ['read'] })), true)
})

test('P1-3c 有片段种类：可注入', () => {
  assert.equal(hasInformativeStructure(entry({ spanKind: 'assistant.text' })), true)
})

test('P1-3d 纯壳（只有 nodeId 与记录 ID）：不注入', () => {
  assert.equal(hasInformativeStructure(entry()), false, '只有取回句柄不算信息')
  assert.equal(hasInformativeStructure(entry({ range: null, tools: [], spanKind: '' })), false)
  assert.equal(hasInformativeStructure(null), false)
})

test('P1-3e 空工具数组不算信息（避免把「有字段」当成「有内容」）', () => {
  assert.equal(hasInformativeStructure(entry({ tools: [] })), false)
  assert.equal(hasInformativeStructure(entry({ tools: '' })), false)
})

test('P1-3f 过滤语义：一批命中里只留合格项，纯壳被挡掉（无合格命中 → 不注入）', () => {
  const candidates = [
    entry({ range: { start: 2, end: 3 }, tools: ['read'] }),
    entry(), // 纯壳
    entry({ spanKind: 'assistant.text' }),
  ]
  const kept = candidates.filter((candidate) => hasInformativeStructure(candidate))
  assert.equal(kept.length, 2)
  assert.equal(candidates.filter((candidate) => hasInformativeStructure(candidate)).length > 0, true)
  assert.equal([entry(), entry()].filter((candidate) => hasInformativeStructure(candidate)).length, 0, '全是壳时一条都不留')
})
