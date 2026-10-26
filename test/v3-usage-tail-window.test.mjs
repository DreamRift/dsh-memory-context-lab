/**
 * v3 usage 通道「seq 严格递增」幂等判据的守卫（H-39，2026-10-26 缺陷排查批）。
 *
 * ## 缺陷
 * `tailStateOf` 只读尾部 64KiB 就下结论：尾块里一条可解析行都没有时返回 `lastSeq = -1`。
 * 但 `-1` 是一个**断言**——「文件里不存在更大的 seq」——而「我这个窗口里没找到」并不等价。
 *
 * 触发形态不需要垃圾文件：只要**最后一条 usage 行本身 > 64KiB**（宿主多给字段就会），
 * 尾块就从该行中间开始 → 解析失败 → 往前也没有行 → -1 → 下一条同 seq 的记录被重复写入。
 * 实测：先写 seq=1、seq=2（第二条 70KiB），再追加 seq=2，文件变成 3 行且 seq=2 出现两次
 * ——统计样本被污染，且**没有任何告警**。
 *
 * ## 判据
 * - 正常情况（每条几百字节）一次 64KiB 读完，不多读；
 * - 尾块解析不出任何行时，窗口倍增直到覆盖全文件；只有**覆盖全文件仍无可解析行**才返回 -1；
 * - 追加路径的幂等（seq 非递增不追加）、粘行修复（半行残留先补换行）、坏行容错语义不变。
 *
 * ## 不适用条件与已知边界
 * 判据仍是「文件里最后一条可解析行的 seq」，不是「已见过的所有 seq 的集合」——账本假定
 * seq 单调追加（宿主 append-only 序号的真实语义）。并发乱序写入不在承诺范围内。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { appendUsageLine, readUsageSummary } from '../src/v3/adapters/storage/usage-log.mjs'

async function withDir(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'mcl-h39-'))
  try { return await fn(dir) } finally { await rm(dir, { recursive: true, force: true }).catch(() => {}) }
}

const seqsIn = async (dir) => {
  const text = await readFile(path.join(dir, 'usage.jsonl'), 'utf8')
  const out = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try { out.push(JSON.parse(line).seq) } catch { /* 坏行不计 */ }
  }
  return out
}

test('H-39 单条 usage 行 > 64KiB 时幂等仍成立（旧：seq=2 写两次）', async () => {
  await withDir(async (dir) => {
    await appendUsageLine(dir, 1, { inputTokens: 10 })
    await appendUsageLine(dir, 2, { inputTokens: 20, note: 'y'.repeat(70 * 1024) })
    assert.deepEqual(await seqsIn(dir), [1, 2], '前置：两行正常写入')
    await appendUsageLine(dir, 2, { inputTokens: 20, note: 'DUPLICATE' })
    assert.deepEqual(await seqsIn(dir), [1, 2], '重复 seq 不得追加')
  })
})

test('H-39 尾块被无关垃圾填满时幂等仍成立（旧：lastSeq 误判 -1）', async () => {
  await withDir(async (dir) => {
    await appendUsageLine(dir, 1, { inputTokens: 10 })
    await appendUsageLine(dir, 5, { inputTokens: 50 })
    const file = path.join(dir, 'usage.jsonl')
    await writeFile(file, (await readFile(file, 'utf8')) + 'X'.repeat(100 * 1024) + '\n', 'utf8')
    await appendUsageLine(dir, 3, { inputTokens: 30 }) // 旧 seq，必须被拒
    const seqs = await seqsIn(dir)
    assert.ok(!seqs.includes(3), 'seq=3 小于已知的 5，不得写入，得到 ' + JSON.stringify(seqs))
  })
})

test('H-39 窗口倍增不影响正常路径：小文件一次读完、聚合语义不变', async () => {
  await withDir(async (dir) => {
    for (const seq of [1, 2, 3]) await appendUsageLine(dir, seq, { inputTokens: seq * 10 })
    const summary = await readUsageSummary(dir)
    assert.equal(summary.samples, 3)
    assert.equal(summary.occupancy.max, 30)
    assert.equal(summary.occupancy.latest, 30)
    // 重复与乱序都不追加
    await appendUsageLine(dir, 2, { inputTokens: 999 })
    await appendUsageLine(dir, 3, { inputTokens: 999 })
    assert.deepEqual(await seqsIn(dir), [1, 2, 3])
  })
})

test('H-39 半行残留仍先补换行（不把新行粘在坏行尾部）', async () => {
  await withDir(async (dir) => {
    const file = path.join(dir, 'usage.jsonl')
    await appendUsageLine(dir, 1, { inputTokens: 10 })
    await writeFile(file, (await readFile(file, 'utf8')) + '{"seq":2,"inputTok', 'utf8') // 半行
    await appendUsageLine(dir, 3, { inputTokens: 30 })
    const summary = await readUsageSummary(dir)
    assert.equal(summary.badLines, 1, '半行应被如实计为坏行')
    assert.ok((await seqsIn(dir)).includes(3), '新行必须可解析')
  })
})
