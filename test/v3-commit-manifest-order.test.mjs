/**
 * P2-01（0.15.1）：提交点已落盘、manifest 推进失败 → 报失败但**事实已提交**。
 *
 * ## 缺陷
 * `submitTransaction` 的顺序是 payload → commit 行（fsync）→ 写 manifest。最后一步抛错时
 * 异常一路向上，调用方看到「失败」，于是换新 ID 重试——同一段内容进库两次（重复摄入），
 * 而账本里说不出哪一条该在。反过来，若沿用旧 manifest 分配号，就会**复用事务号**
 * （号不复用是对账的前提）。
 *
 * ## 判据来源
 * docs/dev-0.15.1/记忆上下文-0.15.1-独立排查报告.md §3.2 P2-01（复现）；用户裁定
 * （2026-11-04）：全部按顺序修、根因修复。
 *
 * ## 修法（以日志为真源，manifest 只是分配器缓存）
 * 1. commit 行落盘即推进本句柄的 `maxTxn`；manifest 写失败**不再**把整笔事务算失败，
 *    而是返回 `{txn, recordIds, manifestAdvanceFailed:true}`；
 * 2. `rereadManifestTxnNext` 发现盘上 `txnNext <= maxTxn`（推进失败的残留、或另一句柄
 *    回退）时**自愈**为 `maxTxn+1`（与打开期同一判据），修不动则失败关闭——绝不带着
 *    可能复用的号继续写。
 *
 * ## 断言组
 * 1. 只读 manifest（写必失败）：提交**不抛**、返回 manifestAdvanceFailed、commit 行已落盘、
 *    记录可读（事实已提交）；
 * 2. 落后现场（盘上 txnNext 回退）时再提交：**不复用**事务号，且 manifest 自愈到 maxTxn+1；
 * 3. 重开库：打开期自愈后 `txnNext === maxTxn+1`，账实一致、无 commit-lost。
 *
 * ## 不适用条件与已知边界
 * - `manifestAdvanceFailed` 只表示分配器缓存没写成功；日志已提交，后续由自愈接手。
 * - Windows 的只读位能阻止 rename 覆盖（实测 EPERM），这使夹具无需伪造 fs 模块；
 *   非 Windows 上用 chmod 0444 得到同一效果。
 * - 不覆盖「manifest 损坏不可解析」：那条路径一直失败关闭（ESTORE_CORRUPT）。
 *
 * ## 定点变异自证
 * 把 manifest 写失败改回抛出 → 组 1 红；去掉 reread 的 `txnNext <= maxTxn` 自愈 →
 * 组 2 红（事务号复用）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { openV3SessionStore } from '../src/v3/adapters/storage/session-store.mjs'

const KEY = 's-p201'
const hex16 = (n) => n.toString(16).padStart(16, '0')

function recordOf(n, text = '正文' + n) {
  return {
    id: 'v3r-' + hex16(n),
    kind: 'message-user',
    sessionKey: KEY,
    createdAt: 1,
    payload: { text, bytes: Buffer.byteLength(text, 'utf8') },
    provenance: { sourceEventId: 'evt-' + n, sourceForm: 'live', transactionId: 'tx-' + n },
  }
}

const manifestOf = (root) => path.join(root, 'sessions', KEY, 'manifest.json')
const commitLinesOf = async (root) => (await readFile(path.join(root, 'sessions', KEY, 'transactions.jsonl'), 'utf8'))
  .split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)).filter((l) => l.action === 'commit')

test('P2-01 manifest 写失败：提交算成功（事实已落盘），并标记分配器未推进', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-p201-'))
  const store = await openV3SessionStore(root, KEY)
  try {
    await store.submitTransaction([recordOf(1)])
    const manifestPath = manifestOf(root)
    await chmod(manifestPath, 0o444) // 只读：rename/writeFileAtomic 覆盖会 EPERM
    const result = await store.submitTransaction([recordOf(2)])
    assert.equal(result.txn, 2, 'commit 行已落盘 → 事务号必须如实返回：' + JSON.stringify(result))
    assert.equal(result.manifestAdvanceFailed, true, '分配器未推进必须可见：' + JSON.stringify(result))
    const commits = await commitLinesOf(root)
    assert.equal(commits.length, 2, 'commit 行必须已落盘（事实已提交）')
    // 记录真的可读：调用方若因「失败」重试，会得到第二条同一内容——这正是要消灭的重复摄入
    const read = await store.readRecord('v3r-' + hex16(2))
    assert.equal(read.id, 'v3r-' + hex16(2))
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    assert.equal(manifest.txnNext, 2, '盘上 manifest 仍落后（这就是要自愈的现场）')
  } finally {
    await chmod(manifestOf(root), 0o666).catch(() => {})
    store.close()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})

test('P2-01 落后现场下继续提交：不复用事务号，manifest 自愈到 maxTxn+1', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-p201b-'))
  const store = await openV3SessionStore(root, KEY)
  try {
    await store.submitTransaction([recordOf(1)])
    await store.submitTransaction([recordOf(2)])
    const manifestPath = manifestOf(root)
    // 模拟「推进失败」留下的现场：盘上分配器回退到 1（commit 行仍在）
    await writeFile(manifestPath, JSON.stringify({ schemaVersion: 1, sessionKey: KEY, txnNext: 1 }) + '\n')
    const third = await store.submitTransaction([recordOf(3)])
    assert.equal(third.txn, 3, '事务号绝不复用（旧实现会拿 1）：' + JSON.stringify(third))
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    assert.equal(manifest.txnNext, 4, '分配器必须自愈到 maxTxn+1：' + JSON.stringify(manifest))
    const commits = await commitLinesOf(root)
    assert.deepEqual(commits.map((c) => c.txn), [1, 2, 3], '提交行事务号唯一且递进')
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})

test('P2-01 重开库：打开期自愈，账实一致且无 commit-lost', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-p201c-'))
  let store = await openV3SessionStore(root, KEY)
  try {
    await store.submitTransaction([recordOf(1)])
    await writeFile(manifestOf(root), JSON.stringify({ schemaVersion: 1, sessionKey: KEY, txnNext: 1 }) + '\n')
  } finally {
    store.close()
  }
  store = await openV3SessionStore(root, KEY)
  try {
    const health = store.health()
    assert.equal(health.healthy, true, JSON.stringify(health))
    assert.equal(health.txnNext, 2, '打开期必须把分配器自愈到 maxTxn+1：' + JSON.stringify(health.txnNext))
    assert.ok(health.commitLostAtOpen === null || health.commitLostAtOpen === undefined, '日志与 manifest 对齐后不该报 commit-lost：' + JSON.stringify(health.commitLostAtOpen))
    assert.equal(health.recordCount, 1)
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})
