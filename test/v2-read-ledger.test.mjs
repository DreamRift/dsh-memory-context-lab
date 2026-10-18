/**
 * P0-2 读取账本：把重读变成可见的账（0.12.0）。
 *
 * 事实：同键重读 55 次（占读入 42.4%），插件**完全看不见**——`evidenceReReads`
 * 只统计「按 ID 回读」，与「重读同一个文件区间」混在一起，于是插件以为自己
 * 「回读 0 次」。
 *
 * 不变量：
 * - **不阻止重读**（不改写工具行为、不隐藏工具、不硬拦截）；
 * - 只记键（path|offset）不记正文；不同 offset 不合并；
 * - `restore` 后账本条目失效（原文已回活动面）；
 * - 重启**不清零**（落盘，与既有成本账本同口径）；
 * - 账本损坏时**失败关闭**，不静默重建为空。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'

import {
  invalidateReadLedger,
  loadReadLedger,
  READ_LEDGER_FILE,
  READ_LEDGER_MAX_ENTRIES,
  readKeyOf,
  readLedgerPath,
  registerReads,
  summarizeReadLedger,
} from '../src/v2/read-ledger.mjs'

async function withTempDir(body) {
  const dir = await mkdtemp(path.join(tmpdir(), 'mcl2rl-'))
  try {
    return await body(dir)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

function read(key, { seq = 10, chars = 800, hash = 'h1' } = {}) {
  return { key, seq, coldRecordId: 'mcl2-aaaabbbbcccc-000001', hash, chars }
}

test('P0-2a 首次登记：新键记 1 次读取，落盘且可重新载入（重启不清零）', async () => {
  await withTempDir(async (dir) => {
    const first = await registerReads(dir, { reads: [read('src/core.mjs|0')], step: 3 })
    assert.equal(first.ok, true)
    assert.equal(first.registered, 1)
    assert.equal(first.repeats, 0)
    // 新进程重新读文件：账本必须还在（与成本账本同口径，重启不清零）。
    const reloaded = await loadReadLedger(dir)
    assert.equal(reloaded.ok, true)
    assert.equal(reloaded.entries.length, 1)
    assert.equal(reloaded.entries[0].key, 'src/core.mjs|0')
    assert.equal(reloaded.entries[0].reads, 1)
    assert.equal(reloaded.entries[0].coldRecordId, 'mcl2-aaaabbbbcccc-000001')
  })
})

test('P0-2b 同键二次读取计数：reads=2、repeats=1，并累计重读字符', async () => {
  await withTempDir(async (dir) => {
    await registerReads(dir, { reads: [read('src/core.mjs|0', { chars: 900 })], step: 3 })
    const second = await registerReads(dir, { reads: [read('src/core.mjs|0', { chars: 900 })], step: 9 })
    assert.equal(second.repeats, 1)
    assert.equal(second.repeatChars, 900)
    const ledger = await loadReadLedger(dir)
    assert.equal(ledger.entries[0].reads, 2)
    assert.equal(ledger.entries[0].lastReadStep, 9)
    const summary = summarizeReadLedger(ledger, { totalChars: 1800 })
    assert.equal(summary.repeats, 1)
    assert.equal(summary.repeatChars, 900)
    assert.equal(summary.ratioA, 0.5)
  })
})

test('P0-2c 不同 offset 不合并：两个键各自独立', async () => {
  await withTempDir(async (dir) => {
    const keyA = readKeyOf('read', '{"file_path":"src/core.mjs","offset":0}')
    const keyB = readKeyOf('read', '{"file_path":"src/core.mjs","offset":1200}')
    await registerReads(dir, { reads: [read(keyA), read(keyB)], step: 4 })
    const ledger = await loadReadLedger(dir)
    assert.equal(ledger.entries.length, 2, '不同 offset 必须是两个键')
    const again = await registerReads(dir, { reads: [read(keyA)], step: 8 })
    assert.equal(again.repeats, 1, '只有同键才算重读')
    assert.equal(again.registered, 0)
  })
})

test('P0-2d restore 后失效：命中条目被删除，无关条目保留', async () => {
  await withTempDir(async (dir) => {
    await registerReads(dir, {
      reads: [
        read('src/core.mjs|0', { seq: 10 }),
        read('src/apply.mjs|0', { seq: 20 }),
      ],
      step: 5,
    })
    const removed = await invalidateReadLedger(dir, { nodeIds: ['mcl2-aaaabbbbcccc-000001'] })
    assert.equal(removed.ok, true)
    assert.equal(removed.removed, 2, '同一冷记录的两条键都失效')
    assert.equal((await loadReadLedger(dir)).entries.length, 0)
    // 无关的冷记录不受影响。
    await registerReads(dir, { reads: [{ ...read('src/core.mjs|0', { seq: 30 }), coldRecordId: 'mcl2-aaaabbbbcccc-000009' }], step: 6 })
    const removed2 = await invalidateReadLedger(dir, { nodeIds: ['mcl2-aaaabbbbcccc-000001'] })
    assert.equal(removed2.removed, 0)
    assert.equal((await loadReadLedger(dir)).entries.length, 1)
  })
})

test('P0-2e 账本损坏时失败关闭：返回 ok:false，且不静默重建为空', async () => {
  await withTempDir(async (dir) => {
    await writeFile(readLedgerPath(dir), '{ this is not json', 'utf8')
    const loaded = await loadReadLedger(dir)
    assert.equal(loaded.ok, false)
    assert.match(loaded.error, /不是合法 JSON/)
    const registered = await registerReads(dir, { reads: [read('src/core.mjs|0')], step: 1 })
    assert.equal(registered.ok, false, '损坏账本不得被静默覆盖')
    const raw = await readFile(readLedgerPath(dir), 'utf8')
    assert.equal(raw, '{ this is not json', '原文件必须原样保留（供诊断）')
    const invalidated = await invalidateReadLedger(dir, { nodeIds: ['x'] })
    assert.equal(invalidated.ok, false)
  })
})

test('P0-2f schema 不符同样失败关闭（kind/version 是硬契约）', async () => {
  await withTempDir(async (dir) => {
    await writeFile(readLedgerPath(dir), JSON.stringify({ kind: 'something-else', version: 1, entries: [] }), 'utf8')
    const loaded = await loadReadLedger(dir)
    assert.equal(loaded.ok, false)
    assert.match(loaded.error, /schema 不符/)
  })
})

test('P0-2g 有界：超过 4,000 条按 lastReadStep 淘汰最旧，账本不无限增长', async () => {
  await withTempDir(async (dir) => {
    const reads = []
    for (let index = 0; index < READ_LEDGER_MAX_ENTRIES + 5; index += 1) {
      reads.push(read('src/f' + index + '.mjs|0', { seq: index }))
    }
    await registerReads(dir, { reads, step: 1 })
    const ledger = await loadReadLedger(dir)
    assert.equal(ledger.entries.length, READ_LEDGER_MAX_ENTRIES)
    // 最旧的（seq 最小、lastReadStep 最小）被淘汰。
    assert.equal(ledger.entries.some((entry) => entry.key === 'src/f0.mjs|0'), false)
    assert.equal(ledger.entries.some((entry) => entry.key === 'src/f' + (READ_LEDGER_MAX_ENTRIES + 4) + '.mjs|0'), true)
  })
})

test('P0-2h 口径 A/B 分开报：B 只认「hash 相同」的重读，缺 hash 不计', async () => {
  await withTempDir(async (dir) => {
    await registerReads(dir, { reads: [read('a|0', { hash: 'same', chars: 100 })], step: 1 })
    await registerReads(dir, { reads: [read('a|0', { hash: 'same', chars: 100 })], step: 2 })
    await registerReads(dir, { reads: [read('b|0', { hash: 'old', chars: 100 })], step: 1 })
    await registerReads(dir, { reads: [read('b|0', { hash: 'new', chars: 100 })], step: 2 })
    await registerReads(dir, { reads: [read('c|0', { hash: null, chars: 100 })], step: 1 })
    await registerReads(dir, { reads: [read('c|0', { hash: null, chars: 100 })], step: 2 })
    const ledger = await loadReadLedger(dir)
    const summary = summarizeReadLedger(ledger, { totalChars: 600 })
    assert.equal(summary.repeats, 3, '三次重读都算口径 A')
    assert.equal(summary.repeatChars, 300)
    assert.equal(summary.unchangedRepeatChars, 100, '只有 hash 相同的那次算口径 B')
    assert.equal(summary.ratioA, 0.5)
    assert.equal(summary.ratioB, 100 / 600)
  })
})

test('P0-2j 部分条目不可解析也算损坏（蜂巢复审 F1）：失败关闭且不覆盖原文件', async () => {
  await withTempDir(async (dir) => {
    const good = { key: 'a|0', seq: 1, coldRecordId: 'mcl2-aaaabbbbcccc-000001', hash: 'h', chars: 10, firstSeenAt: 1, reads: 1, lastReadStep: 1 }
    await writeFile(readLedgerPath(dir), JSON.stringify({
      kind: 'dsh-memory-context-lab/v2/read-ledger',
      version: 1,
      entries: [good, { bad: 1 }, null],
    }), 'utf8')
    const loaded = await loadReadLedger(dir)
    assert.equal(loaded.ok, false, '部分坏条目也是损坏')
    assert.match(loaded.error, /不可解析/)
    const registered = await registerReads(dir, { reads: [read('b|0')], step: 2 })
    assert.equal(registered.ok, false, '损坏账本不得被覆盖')
    const raw = JSON.parse(await readFile(readLedgerPath(dir), 'utf8'))
    assert.equal(raw.entries.length, 3, '原文件必须原样保留（含坏条目，供诊断）')
  })
})
test('P0-2i 文件路径：会话隔离根下的 read-ledger.json（单一文件名）', () => {
  assert.equal(READ_LEDGER_FILE, 'read-ledger.json')
  assert.equal(readLedgerPath('C:/lab/session').endsWith('read-ledger.json'), true)
})
