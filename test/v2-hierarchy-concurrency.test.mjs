/**
 * 0.13.2-beta.2 守卫（W-01 / W-01b）：层级账本的两处数据安全缺口。
 *
 * ## 缺陷
 * - **W-01**：`withWriteLock` 同进程不互斥，`appendHierarchyEntryUnlocked` 的
 *   「读 `entries.length` → `entrySeq = length + 1` → appendFile」被两个并发调用
 *   同时执行，实测写出两条 `entrySeq: 1` 并都向调用方报 `revision: 1`——
 *   `expectedRevision` 的 CAS 保护同时失效。
 * - **W-01b**：`parseLedgerText` 仍是 D-01 修复前的口径：文件末尾缺 `\n` 即判半行，
 *   于是**完整合法条目**被 `loadHierarchy` 在读取动作里物理删除（层级卡丢失、
 *   revision 回退、entrySeq 重号），而且截断发生在写锁之外。
 *
 * ## 判据（改回去必红）
 * - 并发追加两条：`entrySeq` 必须是 1、2，两次返回的 `revision` 必须不同；
 * - 顺序对照：1、2（保证并发用例不是靠「全都失败」蒙过去的）；
 * - 末尾缺 LF 的**完整**条目：读取后仍在、`repairedBytes === 0`；
 * - 末尾是**解析失败**的半行：才截断，且如实报被截字节数。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  HIERARCHY_ENTRY_L1,
  appendHierarchyEntry,
  hierarchyPath,
  loadHierarchy,
} from '../src/v2/hierarchy-store.mjs'

const AT = '2026-10-21T08:00:00.000Z'

function l1Entry(cardId, recordId = 't00000001-r0001') {
  return { kind: HIERARCHY_ENTRY_L1, cardId, recordId, text: '并发守卫卡片', tokens: 10, at: AT }
}

async function withTempDir(body) {
  const dir = await mkdtemp(path.join(tmpdir(), 'mcl-hierarchy-concurrency-'))
  try {
    return await body(dir)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

test('W-01：并发追加两条不得写出重复 entrySeq，revision 必须递增', async () => {
  await withTempDir(async (dir) => {
    const [first, second] = await Promise.all([
      appendHierarchyEntry(dir, l1Entry('l1-concurrent-a')),
      appendHierarchyEntry(dir, l1Entry('l1-concurrent-b')),
    ])
    const ledger = await loadHierarchy(dir)
    const seqs = ledger.entries.map((entry) => entry.entrySeq)
    assert.equal(ledger.entries.length, 2, '两条并发追加都必须落盘')
    assert.deepEqual([...seqs].sort((a, b) => a - b), [1, 2], `entrySeq 必须是 1、2，实际 ${JSON.stringify(seqs)}`)
    assert.equal(new Set(seqs).size, 2, 'entrySeq 不得撞号')
    assert.notEqual(first.revision, second.revision, 'revision 必须不同，否则 expectedRevision 的 CAS 形同虚设')
  })
})

test('W-01：顺序追加的对照（entrySeq 1、2，revision 1、2）', async () => {
  await withTempDir(async (dir) => {
    const first = await appendHierarchyEntry(dir, l1Entry('l1-seq-a'))
    const second = await appendHierarchyEntry(dir, l1Entry('l1-seq-b'))
    assert.equal(first.entry.entrySeq, 1)
    assert.equal(first.revision, 1)
    assert.equal(second.entry.entrySeq, 2)
    assert.equal(second.revision, 2)
  })
})

test('W-01b：末尾缺 LF 的完整条目不得被读动作删掉', async () => {
  await withTempDir(async (dir) => {
    await appendHierarchyEntry(dir, l1Entry('l1-newline-a'))
    // 模拟「不走 appendFile('…\n')」的写入：文件末尾那条完整条目没有 LF。
    const file = hierarchyPath(dir)
    const text = await readFile(file, 'utf8')
    await writeFile(file, text.replace(/\n$/, ''), 'utf8')
    const before = await readFile(file, 'utf8')
    assert.equal(/\n$/.test(before), false, '前提：文件末尾确实没有 LF')

    const ledger = await loadHierarchy(dir)
    assert.equal(ledger.entries.length, 1, '完整条目不得被当成崩溃残尾删掉')
    assert.equal(ledger.entries[0].cardId, 'l1-newline-a')
    assert.equal(ledger.repairedBytes, 0, '没有解析失败的尾巴就不该有截断')
    assert.equal(await readFile(file, 'utf8'), before, '读一次不得改写账本字节')
  })
})

test('W-01b：末尾是解析失败的半行时才截断，并如实报被截字节数', async () => {
  await withTempDir(async (dir) => {
    await appendHierarchyEntry(dir, l1Entry('l1-broken-tail'))
    const file = hierarchyPath(dir)
    const half = '{"kind":"hierarchy/l1-card","cardId":"l1-half'
    await appendFile(file, half, 'utf8')
    const ledger = await loadHierarchy(dir)
    assert.equal(ledger.entries.length, 1, '坏尾巴不得把前面的完整条目一起丢掉')
    assert.equal(ledger.repairedBytes, Buffer.byteLength(half, 'utf8'), '截断字节数必须如实上报')
    const after = await readFile(file, 'utf8')
    assert.equal(after.includes('l1-half'), false, '坏尾巴必须被物理截掉')
    assert.equal(/\n$/.test(after), true, '截断后应回到以 LF 收尾的形态')
  })
})
