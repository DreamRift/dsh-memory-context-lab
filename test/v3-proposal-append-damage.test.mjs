/**
 * P1-06（0.15.1）：`appendProposalEvent` 不查台账健康 → 假成功 + 台账永久不可读。
 *
 * ## 缺陷
 * 追加前既不判 `compact-proposals.jsonl` 是否损坏，也不补尾换行：
 * - 尾半行（写到一半掉电）→ 新事件与半行拼成同一行，**两条**一起变成不可解析行；
 * - 中段/完整行损坏 → 追加返回 `{ok:true}`，而 `readProposals` 之后一直抛
 *   `EPROPOSALS_DAMAGED`，提案从此全部卡在「不可用」，命令面却报成功。
 *
 * ## 判据来源
 * docs/dev-0.15.1/记忆上下文-0.15.1-独立排查报告.md §3.1 P1-06；
 * 用户裁定（2026-11-04）：全部按顺序修，根因修复。
 *
 * ## 修法（锁内，追加前）
 * 1. 尾字节不是 `\n` 时先补一个换行（否则两条一起坏）；
 * 2. 补完重读台账：仍损坏 → **拒绝追加**并返回结构化失败（`reason:'proposals-damaged'`），
 *    一个字节都不改。读面与写面共用 `listProposalEvents` 这唯一判据。
 *
 * ## 断言组
 * 1. 中段完整行损坏：追加被拒，文件逐字节不变；
 * 2. 尾半行：追加被拒，且**不会**把新事件粘到半行后面（文件只多了补的那个换行）；
 * 3. 末行是合法事件但缺换行（掉电边界）：补换行后追加成功，两条都能读回；
 * 4. 正常台账：追加成功、事件可折叠（不回归）。
 *
 * ## 不适用条件与已知边界
 * - 损坏台账不自动修复：中段损坏需要人工裁决（与 repair 只处理尾部半行的既有口径一致）；
 * - 追加仍不是事务：写成功后立刻读是可见的（fsync 后 return），但没有跨文件原子性。
 *
 * ## 定点变异自证
 * 删掉 `prepareAppendTarget` 的调用（回到直接 append）→ 第 1、2 条必红；
 * 删掉补换行那段（保留健康检查）→ 第 3 条必红。读数见台账 R1。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { appendProposalEvent, listProposalEvents, readProposals, proposalsPath } from '../src/v3/adapters/storage/compact-proposals.mjs'

const PID_A = 'v3p-0123456789abcdef'
const PID_B = 'v3p-fedcba9876543210'

function eventOf(proposalId, type = 'proposal/prepared') {
  return { type, proposalId, at: 1, summaryId: null }
}

async function tempDir() {
  return mkdtemp(path.join(tmpdir(), 'mcl-p106-'))
}

test('P1-06 台账中段损坏：追加被拒（不假成功），文件一字节不变', async () => {
  const dir = await tempDir()
  try {
    const damaged = JSON.stringify(eventOf(PID_A)) + '\n{not json}\n'
    await writeFile(proposalsPath(dir), damaged, 'utf8')
    const result = await appendProposalEvent(dir, eventOf(PID_B))
    assert.equal(result.ok, false, '损坏台账必须拒绝追加：' + JSON.stringify(result))
    assert.equal(result.reason, 'proposals-damaged')
    assert.equal(await readFile(proposalsPath(dir), 'utf8'), damaged, '拒绝时不得改动任何字节')
    await assert.rejects(() => readProposals(dir), '读面仍然失败关闭（这是事实，不是新问题）')
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

test('P1-06 尾半行：追加被拒，且新事件不会粘在半行后面', async () => {
  const dir = await tempDir()
  try {
    const good = JSON.stringify(eventOf(PID_A)) + '\n'
    const half = '{"type":"proposal/prepared","proposalId":"' + PID_B + '"'
    await writeFile(proposalsPath(dir), good + half, 'utf8')
    const result = await appendProposalEvent(dir, eventOf(PID_B, 'proposal/accepted'))
    assert.equal(result.ok, false, '半行台账必须拒绝追加：' + JSON.stringify(result))
    const after = await readFile(proposalsPath(dir), 'utf8')
    assert.equal(after, good + half + '\n', '只补了换行，没有把新事件写进去（否则两条一起坏）')
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

test('P1-06 末行合法但缺换行：补换行后追加成功，两条都能读回', async () => {
  const dir = await tempDir()
  try {
    // 掉电边界：事件完整落盘，只有结尾换行没写出去。读面能解析，追加却会拼行。
    await writeFile(proposalsPath(dir), JSON.stringify(eventOf(PID_A)), 'utf8')
    const result = await appendProposalEvent(dir, eventOf(PID_A, 'proposal/accepted'))
    assert.equal(result.ok, true, '合法末行不得被误判为损坏：' + JSON.stringify(result))
    const listed = await listProposalEvents(dir)
    assert.equal(listed.ok, true, '补换行后台账必须仍然可解析')
    assert.equal(listed.rows.length, 2, '两条事件都要在（旧实现会拼成一行变坏）')
    const folded = await readProposals(dir)
    assert.equal(folded.get(PID_A).status, 'accepted', '折叠结果必须是最后一条事件')
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

test('P1-06 正常台账：追加不回归', async () => {
  const dir = await tempDir()
  try {
    assert.equal((await appendProposalEvent(dir, eventOf(PID_A))).ok, true)
    assert.equal((await appendProposalEvent(dir, eventOf(PID_A, 'proposal/committed'))).ok, true)
    const folded = await readProposals(dir)
    assert.equal(folded.get(PID_A).status, 'committed')
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})
