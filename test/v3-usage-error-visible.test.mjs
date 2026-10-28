/**
 * 观察面 usage 读失败必须可区分于「没有样本」（H-51，2026-10-26 缺陷排查批）。
 *
 * ## 缺陷
 * `inspect()` 旧实现是 `const usage = await usageSummary(entry).catch(() => null)`。
 * 于是「usage.jsonl 聚合抛错」与「usage.jsonl 不存在」在观察面上**完全同形**：
 * 两者都只是 `usage: null`，`/memory-lab v3 status` 一个字都不显示。
 * 这正是 H-48（null 行打挂聚合）能长期潜伏的原因——聚合已经崩了，
 * 观察面却显示一切正常。失败关闭纪律要求：读不到 ≠ 没有。
 *
 * ## 判据
 * - 读成功：`usage` 有值、`usageError` 为 null；
 * - 读失败：`usage` 为 null、`usageError` 带原因，且 `/memory-lab v3 status`
 *   输出「读取失败（…）——这不是「没有样本」」；
 * - 文件不存在（ENOENT）：`usage` 与 `usageError` 都为 null（真的没有样本）。
 *
 * ## 不适用条件
 * 只覆盖观察面的披露；聚合本身的正确性由 `v3-usage-row-normalize.test.mjs` 与
 * `v3-usage-log.test.mjs` 负责。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { readFile } from 'node:fs/promises'

const ENTRY = new URL('../src/v3/entry/v3-entry.mjs', import.meta.url)
const INDEX = new URL('../src/index.mjs', import.meta.url)

test('H-51 inspect 不再把 usage 读失败吞成 null', async () => {
  const source = await readFile(ENTRY, 'utf8')
  assert.equal(/usageSummary\(entry\)\.catch\(\(\) => null\)/.test(source), false, '旧写法必须消失')
  assert.match(source, /usageError/, 'inspect 必须返回 usageError')
  // 返回值是对象字面量，字段增减（如 beta.10 追加的 injection 观测）不该让守卫变红；
  // 判据是「这次 return 里带着 usageError」，而不是字段顺序或整行逐字相等。
  assert.match(source, /return \{[^}]*\busageError\b[^}]*\}/s, 'inspect 的返回值必须把 usageError 交给观察面')
})

test('H-51 status 面把 usageError 如实说出来', async () => {
  const source = await readFile(INDEX, 'utf8')
  assert.match(source, /state\.usageError/, 'status 必须真的读 inspect 返回的 usageError（不是注释里提一句）')
  assert.match(source, /这不是「没有样本」/, '必须区分「读失败」与「没有样本」')
  assert.match(source, /读取失败/, '读失败要有明确措辞')
})
