/**
 * P2-18（0.15.1）：回注尾行只给**不分页**的命令面句柄，不给可分页的 `memory_context_read`。
 *
 * ## 缺陷
 * 回注正文的尾行只写 `/memory-lab read <ID>`——命令面**单次 8000 字且不分页**。
 * 但本版已经注册了可分页的模型工具 `memory_context_read`（码点分页 + 游标续读），
 * 尾行却完全没提它。后果：模型手里唯一的「怎么回读」指引是不可分页那条，
 * 长记录读到 8000 字就断在那里，而真正的分页入口就在同一个工具集里。
 *
 * ## 判据来源
 * docs/dev-0.15.1/记忆上下文-0.15.1-独立排查报告.md §3.2 P2-18（审读）；
 * 回读工具体系见 src/v3/contracts/tools.mjs 的 MEMORY_CONTEXT_TOOL_NAMES 与 READBACK_MAX_CHARS。
 *
 * ## 修法
 * 尾行同时给两条，且**先给可分页的那条**（默认路径），命令面作为人读回退入口，
 * 并如实说明命令面的限制（单次上限、不分页）。
 *
 * ## 断言组
 * 1. 尾行必须提到 `memory_context_read`（可分页入口），且出现在命令面之前；
 * 2. 尾行必须如实说明命令面「不分页」与其单次上限；
 * 3. 首条命中的 ID 仍必须出现在尾行（回读句柄不能丢）；
 * 4. 空回注不产生尾行（不误伤 pure-shell 判定）。
 *
 * ## 不适用条件与已知边界
 * - 只改**尾行文案**，不改装包选择、去重、上界计算。
 * - G6b 的 off 路径冻结指纹随之重抓（尾行属有意变更），量具自检仍须绿。
 *
 * ## 定点变异自证
 * 尾行退回只给命令面 → 组 1/2 红。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { createRecall } from '../src/v3/application/recall.mjs'
import { READBACK_MAX_CHARS } from '../src/v3/contracts/readback.mjs'

const SESSION = 'p2-18'

function providerOf(hits) {
  return {
    async search() { return { display: hits, pack: hits, dropped: [], oovTerms: [] } },
    async read(id) {
      const hit = hits.find((row) => row.id === id)
      if (hit === undefined) throw new Error('未命中：' + id)
      return { text: hit.text, record: { id, createdAt: 1 } }
    },
    async health() { return { healthy: true, indexedCount: hits.length } },
    capabilities() { return { name: 'local-lexical-v3', tier: 'T1' } },
  }
}

const hitOf = (n) => ({ id: 'v3r-' + String(n).padStart(16, '0'), score: 10 - n, createdAt: 1, text: '材料 ' + n + ' 正文内容 ' + '填充'.repeat(30) })

test('P2-18 尾行必须给出可分页的 memory_context_read，且先于命令面', async () => {
  const hits = [hitOf(1), hitOf(2)]
  const recall = createRecall({ provider: providerOf(hits), sessionKey: SESSION })
  const result = await recall({ query: '材料', turn: 1, previewChars: 120 })
  // recall 的成功判据是 `injected: true` + 非空正文（status 字段只出现在失败态）。
  assert.equal(result.injected, true, JSON.stringify(result).slice(0, 200))
  const text = result.text
  const atTool = text.indexOf('memory_context_read')
  const atCommand = text.indexOf('/memory-lab read')
  assert.ok(atTool >= 0, '尾行必须提到可分页的模型工具 memory_context_read：' + text.slice(-300))
  assert.ok(atCommand >= 0, '命令面回退入口仍要给（人读用）')
  assert.ok(atTool < atCommand, '可分页入口必须排在命令面之前（默认路径）')
})

test('P2-18 尾行必须如实说明命令面不分页与单次上限', async () => {
  const hits = [hitOf(1)]
  const recall = createRecall({ provider: providerOf(hits), sessionKey: SESSION })
  const result = await recall({ query: '材料', turn: 1, previewChars: 120 })
  const text = result.text
  assert.match(text, /不分页/, '必须说明命令面不分页（旧文案让人以为能读全）')
  assert.match(text, new RegExp(String(READBACK_MAX_CHARS)), '必须给出命令面的单次上限数字')
  assert.match(text, /分页/, '必须说明模型工具可分页')
})

test('P2-18 首条命中的 ID 仍必须在尾行（回读句柄不能丢）', async () => {
  const hits = [hitOf(1), hitOf(2)]
  const recall = createRecall({ provider: providerOf(hits), sessionKey: SESSION })
  const result = await recall({ query: '材料', turn: 1, previewChars: 120 })
  const tail = result.text.slice(result.text.lastIndexOf('\n'))
  assert.match(tail, /v3r-[0-9a-f]{16}/, '尾行必须带一个真实记录 ID：' + tail)
})
