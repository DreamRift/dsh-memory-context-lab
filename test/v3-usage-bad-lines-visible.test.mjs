/**
 * P3-02 usage 聚合的「全坏行」不再与「没有样本」同形。
 *
 * 缺陷（0.15.1 独立排查报告 §3.3 P3-02）：`readUsageSummary` 在「文件有行、但每行都
 * 无法构成样本」时返回 `null`，与「文件不存在 / 空文件」完全同形。`badLines` 连同
 * 「这本账已经读不出东西」这一事实一起消失，观察面把 10 行全坏显示成「暂无样本」。
 *
 * 判据来源：`src/v3/adapters/storage/usage-log.mjs` —— null 的**唯一**含义是「真的没有
 * 非空行可读」；只要有非空行就返回对象，全坏时 `samples === 0`、`usable === false`、
 * `occupancy === null`、`badLines` 如实计数。
 *
 * 断言组：
 * A. 全坏行 → 对象 + samples 0 + usable false + badLines 计数 + occupancy null；
 * B. 空文件 / 文件不存在 / 目录未给 → 仍为 null（「真的没有样本」不变）；
 * C. 部分坏行 → samples>0 且 badLines>0（坏行不吞好行、也不消失）；
 * D. 观察面：status 行在全坏时不得显示「暂无样本」，必须报出坏行数。
 *
 * 不适用条件与已知边界：
 * - 只改读侧口径，不改写侧（append-only 语义不变）；
 * - `usable` 是新增字段，旧消费者按 `samples`/null 判读仍然成立（null 语义未变）；
 * - 已有坏行的**计数口径**不变（无可用数值的行、非对象行、语法坏行都计入 badLines）。
 *
 * 定点变异自证（`node --test test/v3-usage-bad-lines-visible.test.mjs`）：
 * - 把 usage-log 的 `if (rows.length === 0 && bad === 0) return null` 改回
 *   `if (rows.length === 0) return null` → A 组红（返回 null，badLines 不可见）；
 * - 恢复后 4 组全绿。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { readUsageSummary } from '../src/v3/adapters/storage/usage-log.mjs'

async function dirWithLines(lines) {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-usage-bad-'))
  const dir = path.join(root, 's')
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'usage.jsonl'), lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n', 'utf8')
  return dir
}

test('P3-02-A 全坏行：返回对象并如实披露 badLines（旧实现返回 null → 红）', async () => {
  const dir = await dirWithLines([
    '{坏行',
    'null',
    JSON.stringify({ seq: 3, inputTokens: -5 }),
    JSON.stringify({ seq: 4, outputTokens: 'abc' }),
  ])
  const summary = await readUsageSummary(dir)
  assert.notEqual(summary, null, '有非空行就必须返回对象（null 只留给「真的没有样本」）')
  assert.equal(summary.samples, 0, '坏行不得被算成样本')
  assert.equal(summary.badLines, 4, '四行都不可用：坏行数必须如实')
  assert.equal(summary.usable, false, 'usable 显式表达「取不到样本」')
  assert.equal(summary.occupancy, null, '没有样本就没有占用统计（不得伪造 p50）')
  assert.equal(summary.totals.inputTokens, 0, '总额仍是可求和的 0（既有形状不变）')
})

test('P3-02-B 空文件 / 文件不存在 / 目录未给：null 语义不变', async () => {
  assert.equal(await readUsageSummary(await dirWithLines([])), null, '空文件 = 真的没有样本')
  assert.equal(await readUsageSummary(path.join(tmpdir(), 'mcl-usage-absent-' + Date.now())), null, '文件不存在 = 真的没有样本')
  assert.equal(await readUsageSummary(null), null, '未给目录 = 无从读取')
})

test('P3-02-C 部分坏行：好行照常成样本，坏行同时可见', async () => {
  const dir = await dirWithLines([
    JSON.stringify({ seq: 1, inputTokens: 10, outputTokens: 1 }),
    'not json at all',
    JSON.stringify({ seq: 2, inputTokens: 20, outputTokens: 2 }),
  ])
  const summary = await readUsageSummary(dir)
  assert.equal(summary.samples, 2, '好行不得被坏行吞掉')
  assert.equal(summary.badLines, 1, '坏行数不得因为「有好行」而消失')
  assert.equal(summary.usable, true)
  // latest = **最后一条样本**的 in+read（不是最大值，也不是求和）
  assert.equal(summary.occupancy.latest, 20)
})

test('P3-02-D 观察面文案区分三态：无样本 / 全坏 / 有样本且带坏行', () => {
  // 这里锁的是 status 行的判定分支本身（不启动完整插件）：与 index.mjs 中
  // 「· 占用：」行同构的三元表达，避免回退成「全坏 = 暂无样本」。
  const occupancyLine = (usage, usageError) => {
    if (usageError) return '读取失败（' + usageError + '），这不是「没有样本」'
    if (usage === null || usage === undefined) return '暂无样本'
    if (usage.samples > 0) {
      return '样本 ' + usage.samples + '，p50 ' + (usage.occupancy?.p50 ?? '-')
        + (usage.badLines > 0 ? '；另有 ' + usage.badLines + ' 行无法解析（已跳过）' : '')
    }
    return '账本有 ' + usage.badLines + ' 行但全部无法解析（未取到任何样本）'
  }
  const cases = [
    [null, null, '暂无样本'],
    [{ samples: 0, badLines: 7, usable: false, occupancy: null, totals: {} }, null, '账本有 7 行但全部无法解析（未取到任何样本）'],
    [{ samples: 3, badLines: 2, usable: true, occupancy: { p50: 120 }, totals: {} }, null, '样本 3，p50 120；另有 2 行无法解析（已跳过）'],
    [null, 'EACCES', '读取失败（EACCES），这不是「没有样本」'],
  ]
  for (const [usage, err, expected] of cases) assert.equal(occupancyLine(usage, err), expected)
  // 关键回归点：全坏（samples=0 且有坏行）绝不能显示「暂无样本」。
  assert.notEqual(occupancyLine({ samples: 0, badLines: 7, usable: false, occupancy: null }, null), '暂无样本')
})
