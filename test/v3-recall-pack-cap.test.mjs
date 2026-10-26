/**
 * v3 回注包上界守卫（H-05，2026-10-26 缺陷排查批）。
 *
 * ## 缺陷
 * recall 的注入上界 RECALL_PACK_MAX_CHARS 对**最终正文**不成立：
 * 旧实现先按命中行算长度、while 弹行，然后才 push「省略行」与「按 ID 回读」尾行——
 * 这两行不在预算内，正文必然超上限（实测 4098 > 4000）。
 * 省略条数又用 lines.length - 2 反推（把「标题 + OOV」硬编码成 2 行），
 * 无 OOV 时多算一条（声称省略 11，实际省略 12）。
 *
 * ## 判据
 * - 任意命中规模下，注入正文长度 ≤ RECALL_PACK_MAX_CHARS（头尾固定行本身超限时 capExceeded=true 如实标记）；
 * - 声称省略条数 + 实际注入条数 === 总命中数（会计恒等，不靠行数反推）；
 * - 无 OOV / 有 OOV 两种头部形态都必须成立。
 *
 * ## 不适用条件与已知边界
 * 只覆盖 recall 应用层；宿主侧投影长度不在本套件。previewChars 由调用方给，
 * 本套件用「荒谬大」的 previewChars 覆盖头尾行超限分支。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { createRecall, RECALL_PACK_MAX_CHARS } from '../src/v3/application/recall.mjs'

function providerOf(hits, oovTerms) {
  return {
    async search() { return { display: hits, pack: hits, dropped: [], oovTerms } },
    async read(id) {
      const hit = hits.find((h) => h.id === id)
      if (hit === undefined) throw new Error('未命中：' + id)
      return { text: hit.text }
    },
    async health() { return { healthy: true } },
    capabilities() { return { name: 'test', tier: 'T1', live: true } },
  }
}

function hitsOf(count, bodyLength) {
  const out = []
  for (let i = 0; i < count; i += 1) {
    out.push({ id: 'v3r-' + String(i).padStart(16, '0'), score: 1 + i / 100, text: '正文' + i + '：' + '长'.repeat(bodyLength) })
  }
  return out
}

function omittedOf(text) {
  const match = text.match(/超出 \d+ 字符的 (\d+) 条已省略/)
  return match === null ? 0 : Number(match[1])
}

function injectedLinesOf(text) {
  return (text.match(/^· /gm) ?? []).length
}

test('H-05 无 OOV：上界成立且省略会计恒等（旧：4098 字符、声称 11 实际省略 12）', async () => {
  const hits = hitsOf(30, 800)
  const recall = createRecall({ provider: providerOf(hits, []), sessionKey: 's-no-oov' })
  const out = await recall({ query: '正文', turn: 1, limit: 30 })
  assert.equal(out.injected, true)
  assert.ok(out.text.length <= RECALL_PACK_MAX_CHARS, '注入正文必须 ≤ 上限（实测 ' + out.text.length + '）')
  const omitted = omittedOf(out.text)
  assert.equal(omitted + injectedLinesOf(out.text), hits.length, '省略 + 注入 === 总命中')
  assert.equal(out.omittedHits, omitted, '返回字段与实际省略一致')
  assert.equal(out.injectedHits + out.omittedHits, hits.length)
  assert.equal(out.capExceeded, false)
})

test('H-05 有 OOV：同口径成立（旧实现只在这条路径碰巧正确）', async () => {
  const hits = hitsOf(30, 800)
  const recall = createRecall({ provider: providerOf(hits, ['词表外甲', '词表外乙']), sessionKey: 's-oov' })
  const out = await recall({ query: '正文', turn: 1, limit: 30 })
  assert.ok(out.text.length <= RECALL_PACK_MAX_CHARS)
  assert.ok(out.text.includes('词表外词'), 'OOV 行保留')
  assert.equal(omittedOf(out.text) + injectedLinesOf(out.text), hits.length)
})

test('H-05 单条命中即超限：仍不超上限，且至少保留一条（不静默清空）', async () => {
  const hits = hitsOf(1, 30000)
  const recall = createRecall({ provider: providerOf(hits, []), sessionKey: 's-single' })
  const out = await recall({ query: '正文', turn: 1, limit: 1, previewChars: 100 })
  assert.ok(out.text.length <= RECALL_PACK_MAX_CHARS)
  assert.equal(injectedLinesOf(out.text), 1, '单条命中必须保留')
})

test('H-05 头尾固定行本身超限：如实标记 capExceeded，不假装满足', async () => {
  // H-47 之后 previewChars 有了上界（超过硬顶即失败关闭），所以「头尾固定行本身超限」
  // 这条分支不能再靠荒谬的 previewChars 触发——它真实的触发路径是**超长 OOV 词表**：
  // 头部那行「词表外词（未参与打分）：…」自己就能吃掉整个硬顶。
  const hits = hitsOf(2, 100)
  const manyOov = Array.from({ length: 900 }, (_, i) => 'oov' + i + 'x'.repeat(3))
  const recall = createRecall({ provider: providerOf(hits, manyOov), sessionKey: 's-huge-preview' })
  const out = await recall({ query: '正文', turn: 1, limit: 2 })
  if (out.text.length > RECALL_PACK_MAX_CHARS) {
    assert.equal(out.capExceeded, true, '超限必须如实标记（fail-visible）')
  } else {
    assert.equal(out.capExceeded, false)
  }
  assert.equal(out.injectedHits + out.omittedHits, hits.length, '会计仍须恒等')
})

test('H-05 全量可容纳时不产生省略行（不虚报截断）', async () => {
  const hits = hitsOf(3, 20)
  const recall = createRecall({ provider: providerOf(hits, []), sessionKey: 's-small' })
  const out = await recall({ query: '正文', turn: 1, limit: 3 })
  assert.equal(omittedOf(out.text), 0)
  assert.equal(out.omittedHits, 0)
  assert.equal(injectedLinesOf(out.text), 3)
  assert.equal(out.capExceeded, false)
})
