/**
 * v3 usage 通道健壮性守卫（H-04，2026-10-26 缺陷排查批）。
 *
 * ## 缺陷
 * (a) appendUsageLine 每次追加都 readFile 整个 usage.jsonl 求 max seq —— 成本随文件大小线性增长
 *     （实测：10 MiB 文件上 200 次追加 9016ms，50 KiB 文件上 139ms，比值 65×）；
 * (b) readUsageSummary 用 `Math.max(...occupancy)` 展开参数 —— 20 万样本直接
 *     RangeError: Maximum call stack size exceeded，上层 catch 成 null 后「读不到」被伪装成「没有」。
 *
 * ## 判据
 * - 追加成本与文件大小无关（大/小耗时比 < 5）；
 * - 20 万行样本可读出 p50/p90/p95/max；
 * - 幂等语义不变：seq 非递增不追加、重放不双写、坏尾行不误判。
 *
 * ## 不适用条件与已知边界
 * 只覆盖单进程顺序追加；跨进程并发追加仍可能双写（usage 是观测通道，不承担事务语义）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { appendUsageLine, readUsageSummary } from '../src/v3/adapters/storage/usage-log.mjs'

async function withDir(body) {
  const dir = await mkdtemp(path.join(tmpdir(), 'mcl-v3-usage-'))
  try {
    return await body(dir)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

function seedLines(count) {
  const lines = []
  for (let i = 0; i < count; i += 1) lines.push(JSON.stringify({ seq: i, inputTokens: 1000 + (i % 97), cacheReadTokens: 7 }))
  return lines.join('\n') + '\n'
}

test('H-04a 追加成本与文件大小无关（旧：10 MiB 文件上慢 65×）', async () => {
  async function bench(lineCount) {
    const dir = await mkdtemp(path.join(tmpdir(), 'mcl-v3-usage-bench-'))
    try {
      const file = path.join(dir, 'usage.jsonl')
      await writeFile(file, seedLines(lineCount), 'utf8')
      const started = process.hrtime.bigint()
      for (let i = 0; i < 100; i += 1) await appendUsageLine(dir, lineCount + i, { inputTokens: 1200, outputTokens: 9 })
      return Number(process.hrtime.bigint() - started) / 1e6
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  }
  const small = await bench(1000)
  const large = await bench(200000)
  assert.ok(large / Math.max(small, 0.5) < 5, '大/小文件追加耗时比必须接近 1（实测 ' + (large / Math.max(small, 0.5)).toFixed(1) + '）')
})

test('H-04b 20 万行样本可读：不得 RangeError（Math.max 展开）', async () => {
  await withDir(async (dir) => {
    await writeFile(path.join(dir, 'usage.jsonl'), seedLines(200000), 'utf8')
    const summary = await readUsageSummary(dir)
    assert.equal(summary.samples, 200000)
    assert.ok(Number.isFinite(summary.occupancy.max), 'max 必须是有限数')
    assert.ok(summary.occupancy.p50 <= summary.occupancy.p90)
    assert.ok(summary.occupancy.p90 <= summary.occupancy.p95)
    assert.ok(summary.occupancy.p95 <= summary.occupancy.max)
    assert.equal(summary.occupancy.latest, 1000 + (199999 % 97) + 7, 'latest 是最后一条的占用')
  })
})

test('H-04 幂等与坏行语义不变：seq 非递增不追加、坏行计数、缺文件返回 null', async () => {
  await withDir(async (dir) => {
    assert.equal(await readUsageSummary(dir), null, '无文件返回 null')
    await appendUsageLine(dir, 5, { inputTokens: 100 })
    await appendUsageLine(dir, 5, { inputTokens: 999 })
    await appendUsageLine(dir, 3, { inputTokens: 999 })
    await appendUsageLine(dir, 6, { inputTokens: 200 })
    const text = await readFile(path.join(dir, 'usage.jsonl'), 'utf8')
    const rows = text.split('\n').filter(Boolean).map((line) => JSON.parse(line))
    assert.deepEqual(rows.map((r) => r.seq), [5, 6], '只有严格递增的 seq 落盘')
    assert.deepEqual(rows.map((r) => r.inputTokens), [100, 200], '重复/回退的 seq 不覆盖既有行')

    const summary = await readUsageSummary(dir)
    assert.equal(summary.samples, 2)
    assert.equal(summary.badLines, 0)
  })
})

test('H-04 尾部半行不使断点误判（崩溃残留），也不阻断后续追加', async () => {
  await withDir(async (dir) => {
    const file = path.join(dir, 'usage.jsonl')
    await writeFile(file, JSON.stringify({ seq: 7, inputTokens: 100 }) + '\n' + '{"seq":8,"input', 'utf8')
    await appendUsageLine(dir, 9, { inputTokens: 300 })
    const text = await readFile(file, 'utf8')
    assert.ok(text.trimEnd().endsWith('}'), '追加成功')
    const lines = text.split('\n').filter(Boolean)
    assert.equal(JSON.parse(lines.at(-1)).seq, 9)
    const summary = await readUsageSummary(dir)
    assert.equal(summary.badLines, 1, '半行如实计入坏行')
  })
})

test('H-04 读失败不伪装成「没有样本」：非 ENOENT 必须抛出', async () => {
  await withDir(async (dir) => {
    // 用目录顶替文件制造 EISDIR（不是 ENOENT）
    await (await import('node:fs/promises')).mkdir(path.join(dir, 'usage.jsonl'), { recursive: true })
    await assert.rejects(() => readUsageSummary(dir), (e) => e?.code === 'EISDIR')
  })
})

test('H-04 追加目录不存在时自动创建（不因缺目录静默丢样本）', async () => {
  await withDir(async (dir) => {
    const nested = path.join(dir, 'sessions', 's1')
    await appendUsageLine(nested, 1, { inputTokens: 42 })
    assert.equal((await stat(path.join(nested, 'usage.jsonl'))).isFile(), true)
    assert.equal((await readUsageSummary(nested)).samples, 1)
  })
})
