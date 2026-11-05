/**
 * P1-02（0.15.1）：回注预算收敛退化 O(千次) 重扫描 → pre-step 秒级阻塞。
 *
 * ## 缺陷
 * `recallForInjection` 的「连一条都放不下」兜底每轮只减 `ceil(over/命中数)`，贴近边界后
 * 退化为**每次减 1**；且每轮 `compose()` 对**每条**命中重跑 `selectExcerpt`（O(正文) 扫描）
 * 并重算全部 needle 位置。设置页**合法**的 `previewChars=4000` + 8k 正文 + 10 条命中实测
 * **8.3 秒**（5 万字符正文 39 秒）。这条路径挂在 `await` 的 pre-step 上 → 每一次带人类输入的
 * 步骤都先卡这么久，即「首字延迟」。
 *
 * ## 判据来源
 * docs/dev-0.15.1/记忆上下文-0.15.1-独立排查报告.md §1★2 / §3.1 P1-02；
 * 用户裁定（2026-11-04）：全部按顺序修，根因修复（不是调参数）。
 *
 * ## 修法
 * 收敛改成对 cap 的**二分**：轮数 `ceil(log2(previewChars+1))`，与正文长度无关；取装得下的
 * 最大 cap（尽量少截断），二分结果复核（非单调时放弃压缩而不是带超限包注入）。硬顶、
 * 省略会计、`preview-shrunk` 计数器等既有合同全部不变。
 *
 * ## 断言组
 * 1. 成本：8k 正文 × 10 条命中、previewChars=4000 的调用在 **1500ms** 内完成（旧实现 8.3s）；
 * 2. 合同不回退：注入成功、正文长度 ≤ 硬顶、省略 + 注入 === 总命中、每条 ID 都在；
 * 3. 预算用满：收缩后的正文继续接近硬顶（不是过度压缩成迷你包）；
 * 4. 小规模路径不变：默认 previewChars 下不触发收缩计数器（不虚报截断）。
 *
 * ## 不适用条件与已知边界
 * - 时间断言是**数量级守卫**（8.3s → 毫秒级），阈值给到 1500ms 以容忍 CI 抖动；
 *   它不是性能基准，不锁死具体毫秒数；
 * - 二分假设「长度随 cap 近似单调」；非单调来自窗口合并，已用复核兜底（不装就不注入）。
 *
 * ## 定点变异自证
 * 把收敛换回「每次减 1」的旧循环 → 第 1 条必红（8s 级），且第 2、3 条仍绿（说明这条
 * 守卫抓的是成本而不是结果形状）；删掉复核 → 该夹具下不触发（记录边界）。读数见台账 R1。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'

import { createRecall, RECALL_PACK_MAX_CHARS } from '../src/v3/application/recall.mjs'

function providerOf(hits) {
  return {
    async search() { return { display: hits, pack: hits, dropped: [], oovTerms: [] } },
    async read(id) {
      const hit = hits.find((row) => row.id === id)
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

const omittedOf = (text) => {
  const match = text.match(/超出 \d+ 字符的 (\d+) 条已省略/)
  return match === null ? 0 : Number(match[1])
}
const injectedLinesOf = (text) => (text.match(/^· /gm) ?? []).length

test('P1-02 合法上限配置：预算收敛必须在毫秒级完成（旧实现 8.3 秒）', async () => {
  const hits = hitsOf(10, 8000)
  const counters = new Map()
  const recall = createRecall({ provider: providerOf(hits), sessionKey: 's-p102', metrics: { counter: (name, n) => counters.set(name, (counters.get(name) ?? 0) + n) } })
  const started = performance.now()
  const out = await recall({ query: '正文', limit: 10, turn: 1, previewChars: 4000 })
  const elapsed = performance.now() - started
  assert.equal(out.injected, true, JSON.stringify(out).slice(0, 200))
  assert.ok(out.text.length <= RECALL_PACK_MAX_CHARS, '硬顶必须成立（实测 ' + out.text.length + '）')
  assert.equal(omittedOf(out.text) + injectedLinesOf(out.text), hits.length, '省略 + 注入 === 总命中')
  assert.equal(injectedLinesOf(out.text), 10, '10 条都必须有行（收缩首部而不是丢条）')
  assert.ok(out.text.length > RECALL_PACK_MAX_CHARS * 0.8, '预算要用满（实测 ' + out.text.length + '）')
  assert.equal(counters.get('v3.recall.preview-shrunk'), 1, '收缩计数器必须记账（观测面不变）')
  assert.ok(elapsed < 1500, '预算收敛耗时 ' + elapsed.toFixed(0) + 'ms，必须 ≤1500ms（旧实现 8300ms 级）')
})

test('P1-02 默认预览长度不走收缩：小包保持原样、不虚报截断', async () => {
  const hits = hitsOf(3, 20)
  const counters = new Map()
  const recall = createRecall({ provider: providerOf(hits), sessionKey: 's-p102-small', metrics: { counter: (name, n) => counters.set(name, (counters.get(name) ?? 0) + n) } })
  const out = await recall({ query: '正文', limit: 3, turn: 1 })
  assert.equal(omittedOf(out.text), 0)
  assert.equal(counters.get('v3.recall.preview-shrunk'), undefined, '无需收缩时不得记账')
})
