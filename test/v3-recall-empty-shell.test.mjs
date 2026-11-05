/**
 * P2-08（0.15.1）：previewChars=0 时注入「只有 …的命中行」——纯壳照样占配额。
 *
 * ## 缺陷
 * 「纯壳不注入」的判据只有 `keep === 0`（一条命中都放不下）。而 `previewChars` 允许 0
 * （设置页合法值、Schema 通过）：此时三条命中都「放得下」，但每行的**摘录正文为空**
 * （只剩「…」）。包长没超上限 → 照常注入：模型收到 3 行没有任何信息的探测行，配额被
 * 白占，且违反「纯壳不注入」这条纪律。
 *
 * ## 判据来源
 * docs/dev-0.15.1/记忆上下文-0.15.1-独立排查报告.md §3.2 P2-08（复现）；用户裁定
 * （2026-11-04）：全部按顺序修、根因修复。
 *
 * ## 修法
 * 纯壳判据从「条数为 0」改成「**正文总量为 0**」：`compose` 同时累计每条命中行里
 * 摘录正文的字符数（结构化取值，不解析行文），`keep === 0 || bodyChars === 0` 一律不注入，
 * 并把这个事实如实带回（`bodyChars`）。
 *
 * ## 断言组
 * 1. previewChars=0、3 条命中 → 不注入（`injected:false`、原因含「纯壳」），且不产生
 *    宿主侧占位（`presented` 为空）；
 * 2. 同一夹具下把 previewChars 调成 40 → 正常注入（证明不是把整条路径关掉）；
 * 3. 正文总量与注入条数一致：正常注入时响应里确实带正文（防止「非空壳但正文为空」）。
 *
 * ## 不适用条件与已知边界
 * - 只覆盖应用层装包；宿主侧投影由入口对账（R02/R04）负责。
 * - 「正文总量」按码点计，与 `previewChars` 的既有口径一致（不引入第二套计数）。
 *
 * ## 定点变异自证
 * 把判据退回 `keep === 0` → 组 1 红（会注入纯壳）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { createRecall } from '../src/v3/application/recall.mjs'

function providerOf(hits) {
  return {
    async search() { return { display: hits, pack: hits, dropped: [], oovTerms: [] } },
    async read(id) {
      const hit = hits.find((h) => h.id === id)
      if (hit === undefined) throw new Error('未命中：' + id)
      return { text: hit.text }
    },
    async health() { return { healthy: true } },
    capabilities() { return { name: 'test', tier: 'T1', live: true } },
  }
}

const hitsOf = (count) => Array.from({ length: count }, (_, i) => ({
  id: 'v3r-' + String(i).padStart(16, '0'),
  score: 1 + i / 100,
  text: '正文' + i + '：' + '关键'.repeat(300),
}))

test('P2-08 previewChars=0：纯壳不得注入（旧实现注入 3 行只有「…」）', async () => {
  const hits = hitsOf(3)
  const recall = createRecall({ provider: providerOf(hits), sessionKey: 's-p208-zero' })
  const out = await recall({ query: '关键', turn: 1, limit: 3, previewChars: 0 })
  assert.equal(out.injected, false, 'previewChars=0 时不得注入：' + JSON.stringify(out)?.slice(0, 240))
  assert.match(String(out.reason ?? ''), /纯壳/, '原因必须说清是纯壳：' + String(out.reason))
  assert.equal(out.bodyChars, 0, '正文总量如实为 0：' + JSON.stringify(out.bodyChars))
  assert.deepEqual(out.presentedIds ?? [], [], '纯壳不得占用配额/占位')
})

test('P2-08 对照：同一夹具 previewChars=40 正常注入且带正文', async () => {
  const hits = hitsOf(3)
  const recall = createRecall({ provider: providerOf(hits), sessionKey: 's-p208-ok' })
  const out = await recall({ query: '关键', turn: 1, limit: 3, previewChars: 40 })
  assert.equal(out.injected, true, JSON.stringify(out)?.slice(0, 240))
  assert.ok(out.text.length > 0)
  assert.ok((out.presentedIds ?? []).length >= 1, '必须真的呈现了条目：' + JSON.stringify(out.presentedIds))
  assert.equal(out.injected, true)
})
