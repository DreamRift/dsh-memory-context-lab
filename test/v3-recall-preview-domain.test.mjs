/**
 * 回注切片长度 previewChars 的取值域守卫（H-47，2026-10-26 缺陷排查批）。
 *
 * ## 缺陷
 * `createRecall` 的 `previewChars` 直接来自调用方，旧实现没有任何校验就用于
 * `text.length > previewChars` 与 `sliceByChars(text, previewChars)`：
 * - **负数** → `[...text].slice(0, -1)` = 「除最后一个字符外的全文」（越界**放宽**）；
 * - **NaN / Infinity / 非数字** → `text.length > NaN` 恒为 false → 直接注入**全文**。
 * 两者都绕过 N-03「定长首部切片（不是摘要不是全文）」的纪律：实测 800 字符正文
 * 被原样塞进下一步上下文（包长 938，全文泄漏 = true）。
 *
 * ## 判据
 * - `previewChars` 必须是 `≥0` 的整数；否则失败关闭（抛 V3ContractViolation）；
 * - `0` 合法（命中只剩 id + 相关度，正文为空——这是调用方的显式选择）；
 * - 超过 `RECALL_PACK_MAX_CHARS` 同样失败关闭：一条命中就撑满整包，
 *   不是「多要一点」而是配置错误，静默当成「全要」等于绕过硬顶。
 *
 * ## 不适用条件
 * 只约束**切片长度**。回注包总长的硬顶仍由 `RECALL_PACK_MAX_CHARS` 与
 * `capExceeded` 负责（H-05 的语义不变）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { createRecall, RECALL_PACK_MAX_CHARS, RECALL_PREVIEW_CHARS } from '../src/v3/application/recall.mjs'

const LONG_TEXT = '正文'.repeat(400) // 800 字符

function makeProvider() {
  return {
    async search() {
      return {
        pack: [{ id: 'v3r-00000000000000ab', score: 0.9, text: LONG_TEXT }],
        display: [{ id: 'v3r-00000000000000ab', score: 0.9 }],
        oovTerms: [],
      }
    },
    async read() { return { text: LONG_TEXT } },
    async health() { return { ok: true } },
    async capabilities() { return {} },
  }
}

const recallOnce = (previewChars) => {
  const recall = createRecall({ provider: makeProvider(), sessionKey: 's', metrics: null })
  return recall({ query: '正文', turn: 1, previewChars })
}

test('H-47 默认切片是定长首部：不注入全文', async () => {
  const recall = createRecall({ provider: makeProvider(), sessionKey: 's', metrics: null })
  const result = await recall({ query: '正文', turn: 1 })
  assert.equal(result.injected, true)
  assert.equal(result.text.includes(LONG_TEXT), false, '默认 160 字符首部，不得出现全文')
  // sliceByChars 按**码点**切：160 码点 = 80 个「正文」
  assert.equal(result.text.includes('正文'.repeat(RECALL_PREVIEW_CHARS / 2)), true)
})

test('H-47 负数切片：失败关闭（旧：slice(0,-1) 取到几乎全文）', async () => {
  for (const bad of [-1, -100]) {
    await assert.rejects(() => recallOnce(bad), (error) => /previewChars 必须是 ≥0 的整数/.test(error.message))
  }
})

test('H-47 NaN / Infinity / 小数 / 字符串：失败关闭（旧：比较恒假 → 注入全文）', async () => {
  // 注意 undefined 不在列表里：它是「未提供」，走默认值（与 D-12 的「未提供 ≠ 零」同口径）
  for (const bad of [NaN, Infinity, -Infinity, 2.7, '5', null, true]) {
    await assert.rejects(() => recallOnce(bad), (error) => /previewChars 必须是 ≥0 的整数/.test(error.message))
  }
})

test('H-47 超过包硬顶：失败关闭（旧：静默当成「全要」）', async () => {
  await assert.rejects(
    () => recallOnce(RECALL_PACK_MAX_CHARS + 1),
    (error) => /previewChars 不得超过回注包硬顶/.test(error.message),
  )
})

test('H-47 边界：0 合法（只剩 id 与相关度），等于硬顶也合法', async () => {
  const zero = await recallOnce(0)
  assert.equal(zero.injected, true)
  assert.equal(zero.text.includes('正文'), false, 'previewChars=0 → 不回注正文')
  assert.match(zero.text, /v3r-00000000000000ab/)

  const atCap = await recallOnce(RECALL_PACK_MAX_CHARS)
  assert.equal(atCap.injected, true)
  // 一条 800 字符命中 + 头尾仍在硬顶内
  assert.equal(atCap.capExceeded, false)
})
