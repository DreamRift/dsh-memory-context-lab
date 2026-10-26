/**
 * v3 检索 limit 的取值域守卫（H-38，2026-10-26 缺陷排查批）。
 *
 * ## 缺陷
 * `search(query, { limit })` 只校验 query，不校验 limit，随后 `slice(0, limit)`：
 * - `limit = -1` → 返回 11/12 条（`slice` 对负数是**从尾部切**）；
 * - `limit = -3` → 9/12；`limit = Infinity` → 12/12（全部）；
 * - `limit = "5"` → 隐式转换成功；`limit = null` → 0 条（看起来像「正常空结果」）。
 *
 * 负值既不是「拒绝」也不是「默认」——它把「有界热上下文」这条硬不变量变成失败开放：
 * 调用方以为在取 10 条，实际拿到了整个库。
 *
 * ## 判据
 * - limit 必须是 ≥0 的安全整数；否则 `V3ContractViolation`（失败关闭，不静默夹值）；
 * - `undefined` 仍走默认 10；
 * - `0` 是合法值（明确要空结果），不得被当成「未指定」。
 *
 * ## 不适用条件与已知边界
 * 只管「条数上界」；单条命中的**体积**上界由装包面（packWorkingSet / 预算器）负责，
 * 两者是不同的不变量。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createV3Runtime } from '../src/v3/composition/composition.mjs'

async function withRuntime(fn) {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-h38-'))
  const dshSession = { id: 'k', append() { return { seq: 1 } }, eventAt() { return undefined }, surface: { nodes: [] } }
  const runtime = await createV3Runtime({ v3Root: root, dshSession, sessionKey: 'k' })
  try {
    for (let i = 0; i < 12; i += 1) {
      await runtime.handleDshEvent(
        { seq: i, at: 1000 + i, type: 'user/message', data: { content: [{ type: 'text', text: '记忆 上下文 记录 ' + i }] } },
        '记忆 上下文 记录 ' + i,
        {},
      )
    }
    return await fn(runtime)
  } finally {
    try { runtime.close() } catch {}
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
}

test('H-38 负数 limit 不得变成「几乎全量」（旧：-1 → 11/12 条）', async () => {
  await withRuntime(async (runtime) => {
    for (const limit of [-1, -3, -1000]) {
      await assert.rejects(
        () => runtime.provider.search('记忆', { limit }),
        (error) => error?.name === 'V3ContractViolation' && /limit/.test(error.message),
        '负数 limit 必须拒绝：' + limit,
      )
    }
  })
})

test('H-38 非安全整数 limit 一律拒绝（Infinity / 小数 / 字符串 / NaN / null）', async () => {
  await withRuntime(async (runtime) => {
    for (const limit of [Infinity, -Infinity, 1.5, '5', NaN, null]) {
      await assert.rejects(
        () => runtime.provider.search('记忆', { limit }),
        (error) => error?.name === 'V3ContractViolation' && /limit/.test(error.message),
        '非法 limit 必须拒绝：' + String(limit),
      )
    }
  })
})

test('H-38 合法 limit 语义不变：默认 10、显式 0 是空结果、正数照切', async () => {
  await withRuntime(async (runtime) => {
    const dflt = await runtime.provider.search('记忆', {})
    assert.ok(dflt.display.length > 0 && dflt.display.length <= 10, '默认应返回不超过 10 条，得到 ' + dflt.display.length)
    const zero = await runtime.provider.search('记忆', { limit: 0 })
    assert.equal(zero.display.length, 0, 'limit=0 是合法值，必须真的返回空')
    const three = await runtime.provider.search('记忆', { limit: 3 })
    assert.equal(three.display.length, 3)
  })
})
