/**
 * usage.jsonl 读侧样本归一（H-48/H-49/H-50，2026-10-26 缺陷排查批）。
 *
 * ## 缺陷（三条，同一处）
 * `readUsageSummary` 只 catch `JSON.parse` 的语法错，**合法 JSON 一律当样本**：
 * - **H-48**：行内容 `null` → `(r.inputTokens ?? 0)` 抛 `TypeError: Cannot read
 *   properties of null`，整个聚合打挂（usage 面完全不可读，不是「少一行」）；
 * - **H-49**：`{"inputTokens":-100}` → 总额求和成 `-70` 并被当事实报出；
 * - **H-50**：`{"inputTokens":"abc"}` → `0 + 'abc'` = 字符串 `"0abc"`，
 *   `samples` 也照算，聚合里混进字符串。
 *
 * ## 判据
 * 读侧按**非负有限数**白名单归一，与写入侧 `normalizeUsage`（≥2 字段才算 usage）
 * 同源口径：
 * - 非对象（null / 数组 / 字符串 / 数字）→ 计入 `badLines`；
 * - 字段值不是非负有限数 → 该字段按缺失处理；
 * - 一个可用数值都没有的行 → 计入 `badLines`（不构成样本）；
 * - `badLines` 仍如实计数，坏行不影响好行。
 *
 * ## 不适用条件
 * 只做读侧归一，不改写历史文件（append-only 语义不变）。写入侧继续由
 * `normalizeUsage` 把关，两边不是同一函数但口径一致。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { readUsageSummary } from '../src/v3/adapters/storage/usage-log.mjs'

async function dirWith(lines) {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-usage-'))
  const dir = path.join(root, 's')
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'usage.jsonl'), lines.join('\n') + '\n', 'utf8')
  return dir
}

test('H-48 合法 JSON 的 null 行：计入 badLines，不打挂聚合', async () => {
  const dir = await dirWith([
    JSON.stringify({ seq: 1, inputTokens: 10, outputTokens: 1 }),
    'null',
    JSON.stringify({ seq: 2, inputTokens: 20, outputTokens: 2 }),
  ])
  const summary = await readUsageSummary(dir)
  assert.equal(summary.samples, 2)
  assert.equal(summary.badLines, 1)
  assert.equal(summary.totals.inputTokens, 30)
})

test('H-48 数组/字符串/数字行：同样计入 badLines', async () => {
  const dir = await dirWith(['[1,2,3]', '"字符串"', '42', JSON.stringify({ seq: 2, inputTokens: 30, outputTokens: 3 })])
  const summary = await readUsageSummary(dir)
  assert.equal(summary.samples, 1)
  assert.equal(summary.badLines, 3)
  assert.equal(summary.totals.inputTokens, 30)
})

test('H-49 负值 token：按缺失处理，总额不被污染成负数', async () => {
  const dir = await dirWith([
    JSON.stringify({ seq: 1, inputTokens: -100, outputTokens: -5 }),
    JSON.stringify({ seq: 2, inputTokens: 30, outputTokens: 3 }),
  ])
  const summary = await readUsageSummary(dir)
  assert.equal(summary.totals.inputTokens, 30)
  assert.equal(summary.totals.outputTokens, 3)
  assert.ok(summary.totals.inputTokens >= 0)
})

test('H-50 字符串 token：不产生 "0abc" 之类的拼接', async () => {
  const dir = await dirWith([JSON.stringify({ seq: 1, inputTokens: 'abc', outputTokens: 3 })])
  const summary = await readUsageSummary(dir)
  assert.equal(summary.totals.inputTokens, 0)
  assert.equal(typeof summary.totals.inputTokens, 'number')
  assert.equal(summary.totals.outputTokens, 3)
})

test('H-50 一个可用数值都没有的行不构成样本', async () => {
  const dir = await dirWith([JSON.stringify({ seq: 1 }), JSON.stringify({ seq: 2, inputTokens: 5 })])
  const summary = await readUsageSummary(dir)
  assert.equal(summary.samples, 1)
  assert.equal(summary.badLines, 1)
})

test('H-48 全坏行 / 空文件 / 文件不存在：仍返回 null（语义不变）', async () => {
  assert.equal(await readUsageSummary(await dirWith(['{坏', 'null'])), null)
  assert.equal(await readUsageSummary(await dirWith([])), null)
  assert.equal(await readUsageSummary(path.join(tmpdir(), 'mcl-不存在-' + Date.now())), null)
})

test('H-48 正常样本：聚合口径不回归', async () => {
  const lines = []
  for (let i = 1; i <= 10; i += 1) lines.push(JSON.stringify({ seq: i, inputTokens: i * 10, outputTokens: i }))
  const summary = await readUsageSummary(await dirWith(lines))
  assert.equal(summary.samples, 10)
  assert.equal(summary.badLines, 0)
  assert.equal(summary.occupancy.max, 100)
  assert.equal(summary.occupancy.latest, 100)
  assert.equal(summary.totals.inputTokens, 550)
})
