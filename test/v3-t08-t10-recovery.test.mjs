/**
 * T-08 / T-09 / T-10 守卫（0.15.4 全面排查 P3 长尾收口）。
 *
 * 三条都是「坏了以后**再也回不来**」的同族缺陷：
 * - T-08：进程内把首次失败记成终态，磁盘修好也要重启 DSH 才恢复；
 * - T-09：同一个健康面抛不抛错，取决于「索引恰好新不新鲜」这个无关变量；
 * - T-10：purged.jsonl 中段坏一行 → 整库永久只读，而 repair 拒绝动中段，无出口可用。
 *
 * 每条都带**反向**用例：不能因为修「可恢复」就把 fail-closed 弄丢。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { openV3SessionStore, rebuildPurgedLedger, repairSessionJournals } from '../src/v3/adapters/storage/session-store.mjs'
import { isIndexStale } from '../src/v3/adapters/storage/lexical-index.mjs'

const recordOf = (id, text, sourceEventId) => ({
  id,
  kind: 'message-user',
  payload: { text, bytes: Buffer.byteLength(text, 'utf8') },
  sessionKey: 's1',
  createdAt: Date.now(),
  provenance: { sourceEventId, transactionId: 'txn-' + id, sourceForm: null },
})

test('T-08：sourceEvent 构建失败不粘住——磁盘修好后同进程内自动恢复', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 't08-'))
  try {
    const store = await openV3SessionStore(root, 's1')
    await store.submitTransaction([recordOf('v3r-1111111111111111', '正文 alpha', 'dsh:1')])
    store.close()

    // 让源事件表读不到 provenance：把记录文件改坏（不可解析），但不删。
    const dir = path.join(root, 'sessions', 's1')
    const file = path.join(dir, 'records', 'v3r-1111111111111111.json')
    const good = await readFile(file, 'utf8')
    await writeFile(file, '{ this is not json', 'utf8')

    // 走**端口层**：`sourceEventIds()` 才是把失败记成终态的那条路径。
    const { createSessionStorePort } = await import('../src/v3/adapters/storage/session-store-port.mjs')
    const { port } = await createSessionStorePort(root, 's1')
    await assert.rejects(() => port.sourceEventIds(), '坏记录必须让构建失败（fail-closed 不能退）')

    // 修好磁盘：同一端口实例、同一进程内必须自动恢复（旧实现在这里仍抛旧错误）。
    await writeFile(file, good, 'utf8')
    const ids = await port.sourceEventIds()
    assert.ok(ids.includes('dsh:1'), '修好磁盘后必须恢复，不需要重启 DSH：' + JSON.stringify(ids))

    // 反向：**新句柄**面对坏盘仍然必须失败关闭。
    //
    // 这里刻意不测「同一句柄已经缓存成功结果、外部又改坏盘」——那条属于派生物
    // 跨句柄新鲜度（T-03 同族），进程内缓存按设计只由本句柄的写入失效；
    // 拿它当 T-08 的判据会把「缓存」和「错误粘住」两件事混成一件。
    await writeFile(file, '{ broken again', 'utf8')
    const { port: port2 } = await createSessionStorePort(root, 's1')
    await assert.rejects(() => port2.sourceEventIds(), '新句柄遇到坏记录仍须拒绝，不得返回残缺表')
    port2.close()
    port.close()
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})

test('T-09：新鲜度判据恒读遗忘账本——抛不抛错不取决于索引是否新鲜', async () => {
  const calls = []
  const mkStore = (forgottenThrows) => ({
    async listRecordIds() { calls.push('listRecordIds'); return ['a', 'b'] },
    listForgotten() {
      calls.push('listForgotten')
      if (forgottenThrows) throw Object.assign(new Error('遗忘账本不可读'), { code: 'ESTORE_CORRUPT' })
      return []
    },
  })
  // 基线**相等**（旧的提前 return 分支）：仍然必须读遗忘账本，因此仍然必须抛。
  const freshIndex = { sourceCount: 2, indexedCount: 2, forgottenCount: 0 }
  await assert.rejects(
    () => isIndexStale(mkStore(true), freshIndex),
    /遗忘账本不可读/,
    '索引恰好新鲜时也必须读遗忘账本',
  )
  assert.ok(calls.includes('listForgotten'), '基线相等时也必须调用 listForgotten')

  // **关键分支**：基线不等时，旧实现会提前 `return true` 而跳过读遗忘账本 ——
  // 于是同一个健康面「抛不抛错」由无关变量决定。这里必须仍然抛。
  calls.length = 0
  await assert.rejects(
    () => isIndexStale(mkStore(true), { sourceCount: 1, indexedCount: 1, forgottenCount: 0 }),
    /遗忘账本不可读/,
    '基线不等时也必须读遗忘账本（旧实现在这里静默返回 true）',
  )
  assert.ok(calls.includes('listForgotten'), '基线不等时也必须调用 listForgotten')

  // 反向：账本正常时，两条判据各自作数。
  assert.equal(await isIndexStale(mkStore(false), freshIndex), false, '数量一致 → 不陈旧')
  assert.equal(await isIndexStale(mkStore(false), { sourceCount: 1, indexedCount: 1, forgottenCount: 0 }), true, '数量不一致 → 陈旧')
  assert.equal(await isIndexStale(mkStore(false), { sourceCount: 2, indexedCount: 2, forgottenCount: 5 }), true, '遗忘集规模变了 → 陈旧')
  assert.equal(await isIndexStale(mkStore(false), null), true, '没有索引 → 陈旧')
})

test('T-10：purged 中段损坏可从只读救回，且坏账本原样备份、不丢行', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 't10-'))
  try {
    const dir = path.join(root, 'sessions', 's1')
    const idA = 'v3r-aaaaaaaaaaaaaaaa'
    const idB = 'v3r-bbbbbbbbbbbbbbbb'
    const store = await openV3SessionStore(root, 's1')
    await store.submitTransaction([recordOf(idA, '第一条正文 alpha', 'dsh:1')])
    await store.submitTransaction([recordOf(idB, '第二条正文 beta', 'dsh:2')])
    store.close()

    // B 被 purge（记录文件真的没了），而它的 purge 行**被中段坏行吃掉**。
    await rm(path.join(dir, 'records', idB + '.json'))
    const brokenText = JSON.stringify({ action: 'purge', id: 'v3r-cccccccccccccccc', at: 1 }) + '\n'
      + 'THIS IS A BROKEN MIDDLE LINE\n'
      + JSON.stringify({ action: 'purge', id: 'v3r-deadbeefdeadbeef', at: 2 }) + '\n'
    await writeFile(path.join(dir, 'purged.jsonl'), brokenText, 'utf8')

    // ① 坏账本 → 库判 damaged（写拒绝）。这是既有红线，必须保持。
    const damagedStore = await openV3SessionStore(root, 's1')
    assert.equal(damagedStore.health().healthy, false, '中段损坏必须判不健康（不能静默放行）')
    damagedStore.close()

    // ② 通用 repair 只报告，不擅自修中段（红线：绝不丢行）。
    const generic = await repairSessionJournals(dir, { dryRun: true })
    assert.equal(generic.damaged.some((row) => row.file === 'purged.jsonl'), true, '通用 repair 必须报出中段损坏')
    assert.equal(generic.repaired.length, 0, '通用 repair 不得截断中段')

    // ③ 显式出口：预览可算，落盘可修，旧账本原样备份。
    const dry = await rebuildPurgedLedger(dir, { dryRun: true })
    assert.equal(dry.badLines, 1, '应识别出 1 行坏行')
    assert.deepEqual(dry.wouldRecord, [idB], '应算出「已提交但文件不在、账本又没记」的 ID')
    assert.equal(existsSync(path.join(dir, 'purged.jsonl.bak-'))  , false, '预览不得写备份')

    const applied = await rebuildPurgedLedger(dir, {})
    assert.deepEqual(applied.recorded, [idB], '落盘应补记同一条 ID')
    assert.ok(applied.backup, '必须返回备份路径')
    assert.equal(await readFile(applied.backup, 'utf8'), brokenText, '备份必须逐字节保留原账本（含坏行）')

    // ④ 修复后恢复可写，且已清除事实仍然成立。
    const fixed = await openV3SessionStore(root, 's1')
    const health = fixed.health()
    assert.equal(health.healthy, true, '重建后必须恢复健康：' + health.damagedReason)
    assert.ok(health.purgedCount >= 3, '原 purge 行与补记行都要在：' + health.purgedCount)
    await assert.rejects(() => fixed.readRecord(idB), '被清除的 B 不得因重建而复活')
    const recA = await fixed.readRecord(idA)
    assert.equal(recA.payload.text, '第一条正文 alpha', '未涉及的记录必须仍可读')
    fixed.close()

    // ⑤ 反向：记录文件在盘上时，绝不能凭空补记（否则会误判已清除）。
    const dir2 = path.join(root, 'sessions', 's2')
    const store2 = await openV3SessionStore(root, 's2')
    await store2.submitTransaction([{
      ...recordOf('v3r-dddddddddddddddd', '正文 gamma', 'dsh:3'), sessionKey: 's2',
    }])
    store2.close()
    const dry2 = await rebuildPurgedLedger(dir2, { dryRun: true })
    assert.deepEqual(dry2.wouldRecord, [], '记录仍在盘上时不得补记 purge')
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})

test('T-10：坏行读不出时不猜、不改写，宁可继续只读', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 't10c-'))
  try {
    const dir = path.join(root, 'sessions', 's1')
    await mkdir(dir, { recursive: true })
    // transactions 读不出来 → 无法算「已提交」，必须失败关闭。
    await writeFile(path.join(dir, 'transactions.jsonl'), 'NOT JSON AT ALL\n', 'utf8')
    await writeFile(path.join(dir, 'purged.jsonl'), '{"action":"purge","id":"v3r-cccccccccccccccc"}\n', 'utf8')
    const report = await rebuildPurgedLedger(dir, {})
    // 坏 txn 行只是读不出（跳过），committed 为空 → 没有可补记的，故不改字节。
    assert.equal(report.changed, false, '算不出已提交集合时不得改字节：' + JSON.stringify(report))
    assert.equal(await readFile(path.join(dir, 'purged.jsonl'), 'utf8'), '{"action":"purge","id":"v3r-cccccccccccccccc"}\n', '账本必须原样不动')

    // purged 不可读（权限/目录）→ 明确报错，不猜。
    await rm(path.join(dir, 'purged.jsonl'))
    await mkdir(path.join(dir, 'purged.jsonl'), { recursive: true })
    const failed = await rebuildPurgedLedger(dir, {})
    assert.equal(failed.error, 'purged-unreadable', '读不到必须报错，不得当作空账本')
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})
