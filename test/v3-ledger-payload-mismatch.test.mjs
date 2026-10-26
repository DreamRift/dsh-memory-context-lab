/**
 * 崩溃对账的反方向：**有 commit 行、无 payload**（H-55，2026-10-26）。
 *
 * ## 缺陷
 * 打开时的对账只做「盘上多出来的」（有 payload 无 commit → 移入 quarantine），
 * 不做「日志里有而盘上没有的」。后果（实测）：
 * - 3 条提交后删掉 1 个记录文件 → `health.healthy === true`、`recordCount === 3`
 *   （声称 3 条，实际只读得到 2 条）；
 * - `rebuildIndex()` 遍历 `listRecordIds()` 时读不到那条 → 抛 `ESTORE_CORRUPT`，
 *   **整个索引重建面被一条缺失字节打挂**；
 * - 写入照常成功，缺口被固化（recordCount 继续涨）。
 * 这是 H-21 的镜像：H-21 是「日志丢了、记录还在」被当崩溃残留而静默全丢，
 * H-55 是「日志在、记录丢了」被当健康而静默不报。两个方向都得查。
 *
 * ## 判据
 * 账实不符即 damaged：读允许、写拒绝，交人工裁决；**不伪造、不删除任何字节**。
 * 理由里点名缺了哪几条（超过 5 条只列前 5 条 + 「等」）。
 *
 * ## 不适用条件
 * 只覆盖「commit 行在、payload 文件不在」。反过来（payload 在、无 commit 行）仍是
 * quarantine 隔离语义，不受本修复影响。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, unlink, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { openV3SessionStore } from '../src/v3/adapters/storage/session-store.mjs'

function recordOf(n) {
  const text = '正文' + n
  return {
    id: 'v3r-' + String(n).padStart(16, '0'),
    kind: 'message-user',
    sessionKey: 's',
    createdAt: 1700000000000 + n,
    payload: { text, bytes: Buffer.byteLength(text, 'utf8') },
    provenance: { sourceEventId: 'dsh-' + n, sourceForm: 'text', transactionId: 'txn-' + n },
  }
}

async function seeded(n = 3) {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-ledger-'))
  const store = await openV3SessionStore(root, 's')
  for (let i = 1; i <= n; i++) await store.submitTransaction([recordOf(i)])
  store.close()
  return { root, recDir: path.join(root, 'sessions', 's', 'records') }
}

test('H-55 commit 行在、payload 缺失 → health 不再报 healthy', async () => {
  const { root, recDir } = await seeded()
  const files = (await readdir(recDir)).sort()
  await unlink(path.join(recDir, files[1]))

  const store = await openV3SessionStore(root, 's')
  const health = store.health()
  assert.equal(health.healthy, false, '账实不符必须报不健康（旧：healthy=true）')
  assert.match(health.damagedReason, /commit 但记录文件缺失/, '理由必须点名账实不符')
  assert.match(health.damagedReason, /v3r-0000000000000002/, '理由必须点名缺哪一条')
  store.close()
})

test('H-55 damaged 后写入失败关闭（旧：照常成功并固化缺口）', async () => {
  const { root, recDir } = await seeded()
  const files = (await readdir(recDir)).sort()
  await unlink(path.join(recDir, files[1]))

  const store = await openV3SessionStore(root, 's')
  await assert.rejects(
    () => store.submitTransaction([recordOf(4)]),
    (error) => error.code === 'ESTORE_DAMAGED',
  )
  store.close()
})

test('H-55 读路径仍允许：完好记录照旧可读（不因一条缺失封死全部）', async () => {
  const { root, recDir } = await seeded()
  const files = (await readdir(recDir)).sort()
  await unlink(path.join(recDir, files[1]))

  const store = await openV3SessionStore(root, 's')
  const ok = await store.readRecord('v3r-0000000000000001')
  assert.equal(ok.payload.text, '正文1')
  await assert.rejects(
    () => store.readRecord('v3r-0000000000000002'),
    (error) => error.code === 'ESTORE_CORRUPT',
  )
  store.close()
})

test('H-55 不销毁字节：缺失判定后记录文件与事务日志原样保留', async () => {
  const { root, recDir } = await seeded()
  const files = (await readdir(recDir)).sort()
  await unlink(path.join(recDir, files[1]))
  const logBefore = await readFile(path.join(root, 'sessions', 's', 'transactions.jsonl'), 'utf8')

  const store = await openV3SessionStore(root, 's')
  store.health()
  store.close()

  const after = (await readdir(recDir)).sort()
  assert.deepEqual(after, files.filter((f) => f !== files[1]), '不得挪走或删除剩余记录')
  assert.equal(await readFile(path.join(root, 'sessions', 's', 'transactions.jsonl'), 'utf8'), logBefore)
})

test('H-55 反方向不回归：有 payload 无 commit 仍走 quarantine 隔离', async () => {
  const { root, recDir } = await seeded()
  // 手工塞一个「未提交」的记录文件
  const stray = recordOf(99)
  await (await import('node:fs/promises')).writeFile(
    path.join(recDir, stray.id + '.json'),
    JSON.stringify(stray) + '\n',
    'utf8',
  )

  const store = await openV3SessionStore(root, 's')
  const health = store.health()
  assert.equal(health.healthy, true, '多余 payload 是崩溃残留，不是账实不符')
  assert.deepEqual(health.orphanedAtOpen, [stray.id], '必须被隔离')
  const quarantined = await readdir(path.join(root, 'sessions', 's', 'quarantine'))
  assert.ok(quarantined.includes(stray.id + '.json'))
  store.close()
})

test('H-55 正常库不受影响：全绿库仍 healthy 且可写', async () => {
  const { root } = await seeded()
  const store = await openV3SessionStore(root, 's')
  const health = store.health()
  assert.equal(health.healthy, true)
  assert.equal(health.recordCount, 3)
  await store.submitTransaction([recordOf(4)])
  assert.equal(store.health().recordCount, 4)
  store.close()
})
