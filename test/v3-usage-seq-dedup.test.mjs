/**
 * P2-03（0.15.1）：`usage.jsonl` 无整数 seq 的行互相覆盖 → 样本静默少计。
 *
 * ## 缺陷
 * `readUsageSummary` 的按 seq 去重对「没有整数 seq」的行用 `'row-' + rows.length` 作键，
 * 而 `rows` 在循环里恒为 `[]`（真正赋值发生在循环之后）→ 所有无 seq 行都得到同一个键
 * `row-0`，互相覆盖。实测 1000 行无 seq 样本只报 500（每两条折成一条），占用分位数与
 * totals 全部随之偏小，而 `samples` 看不出来是「折叠」还是「真的只有 500」。
 *
 * ## 判据来源
 * docs/dev-0.15.1/记忆上下文-0.15.1-独立排查报告.md §3.2 P2-03（复现）；用户裁定
 * （2026-11-04）：全部按顺序修、根因修复。
 *
 * ## 修法
 * 无 seq 行改用**逐行递增的行序号**作键：与 seq 前缀不同（不冲突）、同进程稳定、
 * 且不改变「有 seq 按 seq 去重」的既有语义。无 seq 行本身无法判定重复，因此不再折叠。
 *
 * ## 断言组
 * 1. 1000 行无整数 seq（字段各不同）→ `samples === 1000`，totals 求和 = 全部行之和；
 * 2. 混合夹具：有 seq 的重复行仍按 seq 去重（后写覆盖先写）且 `duplicateRows` 计数不变，
 *    无 seq 行各自成样本——两条口径并存不互相污染；
 * 3. 全坏行仍返回 null（回归：修法不把「没有样本」变成「有 0 个样本」）。
 *
 * ## 不适用条件与已知边界
 * - 无 seq 行的「重复」无法判定（没有身份），因此同一内容出现两次算两个样本；这是
 *   行级事实，不是去重缺陷。
 * - 不改变 usage 写入侧的字段白名单与归一化口径。
 *
 * ## 定点变异自证
 * 把键退回 `'row-' + rows.length` → 组 1 红（500 vs 1000）；恢复后全绿。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { readUsageSummary } from '../src/v3/adapters/storage/usage-log.mjs'

const LF = String.fromCharCode(10)

async function withDir(rows, body) {
  const dir = await mkdtemp(path.join(tmpdir(), 'mcl-p203-'))
  try {
    await writeFile(path.join(dir, 'usage.jsonl'), rows.map((row) => JSON.stringify(row)).join(LF) + LF)
    return await body(dir)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

test('P2-03 1000 行无整数 seq：样本数必须等于行数（旧实现只报 500）', async () => {
  const rows = Array.from({ length: 1000 }, (_, i) => ({ inputTokens: 100 + i, outputTokens: 1 }))
  await withDir(rows, async (dir) => {
    const summary = await readUsageSummary(dir)
    assert.equal(summary.samples, 1000, '无 seq 行不得互相覆盖（旧实现 500）')
    assert.equal(summary.totals.inputTokens, rows.reduce((s, r) => s + r.inputTokens, 0))
    assert.equal(summary.totals.outputTokens, 1000)
    assert.equal(summary.badLines, 0)
  })
})

test('P2-03 混合夹具：有 seq 仍按 seq 去重，无 seq 各自成样本', async () => {
  const rows = [
    { seq: 1, inputTokens: 10 },
    { seq: 1, inputTokens: 99 },   // 同 seq → 后写覆盖先写（既有语义）
    { seq: 2, inputTokens: 20 },
    { inputTokens: 5 },            // 无 seq → 独立样本
    { inputTokens: 7 },            // 无 seq → 独立样本（旧实现与上一条折叠）
    { inputTokens: 9 },            // 无 seq → 独立样本
  ]
  await withDir(rows, async (dir) => {
    const summary = await readUsageSummary(dir)
    assert.equal(summary.samples, 5, '2 个 seq 样本 + 3 个无 seq 样本：' + JSON.stringify(summary.samples))
    assert.equal(summary.duplicateRows, 1, '同 seq 覆盖必须仍被计数')
    assert.equal(summary.totals.inputTokens, 99 + 20 + 5 + 7 + 9, '后写覆盖先写 + 无 seq 全计：' + JSON.stringify(summary.totals))
  })
})

test('P2-03 / P3-02 全坏行：samples 为 0 且 badLines 如实计数（不伪造样本，也不再与「没有样本」同形）', async () => {
  // P3-02（0.15.1 §3.3）改口径：旧断言「全坏行返回 null」把「账本读不出东西」和
  // 「账本不存在」压成同一个返回值，坏行数随之消失。现在只要有非空行就返回对象，
  // 由 samples===0 / usable===false 表达「有行但取不到样本」。
  await withDir([{ inputTokens: -1 }, { seq: 'x', outputTokens: -5 }], async (dir) => {
    const summary = await readUsageSummary(dir)
    assert.notEqual(summary, null, '有行就必须返回对象（否则 badLines 不可见）')
    assert.equal(summary.samples, 0, '坏行不得被算成样本')
    assert.equal(summary.badLines, 2, '坏行数必须如实')
    assert.equal(summary.usable, false, 'usable 明确表达「取不到样本」')
    assert.equal(summary.occupancy, null, '没有样本就没有占用统计')
  })
})
