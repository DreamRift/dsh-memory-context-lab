/**
 * 0.13.2-beta.2 守卫（W-03）：两阶段建锁的中间物不得永久泄漏。
 *
 * ## 缺陷
 * `createLockDirectory` 先 `mkdir(\`${lockDir}.<token>.tmp\`)`、写 owner.json、再 rename；
 * 只有 rename **抛错**时才 rm 临时目录。进程在两者之间崩溃 → 会话根下永久留下
 * `.write-lock.<uuid>.tmp/owner.json`（不阻塞加锁，但每崩一次堆一个）。
 * 接管用的 `.write-lock.stale.<uuid>` 墓碑同理：rm 失败即留。
 *
 * ## 判据（改回去必红）
 * - 获取前就存在的 stage 目录 / 墓碑 → 拿到锁之后被清掉；
 * - 本次获取开始**之后**才出现的同类目录 → 保留（那是正在建锁的竞争者，不归本次清扫）；
 * - 清扫不阻塞加锁（拿锁本身必须成功）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import path from 'node:path'

import {
  acquireWriteLock,
  writeLockDirectoryFor,
  WRITE_LOCK_KIND,
} from '../src/v2/write-lock.mjs'

async function withTempDir(body) {
  const dir = await mkdtemp(path.join(tmpdir(), 'mcl-lock-sweep-'))
  try {
    return await body(dir)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/** 崩溃残留：stage 目录已建、owner.json 已写、rename 没发生。 */
async function installCrashDebris(sessionDir, token) {
  const lockDir = writeLockDirectoryFor(sessionDir)
  const stage = `${lockDir}.${token}.tmp`
  await mkdir(stage, { recursive: true })
  await writeFile(path.join(stage, 'owner.json'), JSON.stringify({
    kind: WRITE_LOCK_KIND,
    token: 'dead',
    pid: 1,
    host: hostname(),
    heartbeatAt: 0,
  }), 'utf8')
  return stage
}

/** 会话根下的建锁残留：`.write-lock.<token>.tmp` 与 `.write-lock.stale.<token>`（不含锁目录本身）。 */
async function debrisOf(sessionDir) {
  const names = await readdir(sessionDir)
  return names.filter((name) => name.startsWith('.write-lock.')).sort()
}

test('W-03：获取前存在的 stage / 墓碑在拿到锁后被清扫，且不阻塞加锁', async () => {
  await withTempDir(async (sessionDir) => {
    const stage = await installCrashDebris(sessionDir, '00000000-deadbeef')
    const tombstone = `${writeLockDirectoryFor(sessionDir)}.stale.11111111-cafebabe`
    await mkdir(tombstone, { recursive: true })
    // 残留的时间戳必须早于本次获取开始时刻（真实崩溃残留天然如此）。
    const past = new Date(Date.now() - 60_000)
    await utimes(stage, past, past)
    await utimes(tombstone, past, past)

    const handle = await acquireWriteLock(sessionDir, { waitMs: 300 })
    try {
      assert.ok(handle.token, '残留不得阻塞加锁')
      assert.deepEqual(await debrisOf(sessionDir), [], '残留的 stage/墓碑必须被清掉')
    } finally {
      handle.release()
    }
  })
})

test('W-03：本次获取开始之后出现的同类目录必须保留（那是竞争者，不是残留）', async () => {
  await withTempDir(async (sessionDir) => {
    const handle = await acquireWriteLock(sessionDir, { waitMs: 300 })
    try {
      // 拿到锁之后再出现的 stage：属于别的进程正在建锁的中间态。
      const late = await installCrashDebris(sessionDir, '22222222-ffffffff')
      const info = await stat(late)
      assert.ok(info.isDirectory())
      const names = await debrisOf(sessionDir)
      assert.ok(names.some((name) => name.endsWith('.tmp')), `迟到的 stage 不得被本次清扫删掉：${JSON.stringify(names)}`)
      await rm(late, { recursive: true, force: true })
    } finally {
      handle.release()
    }
  })
})

test('W-03：清扫是尽力而为，不改变加锁结果（第二次获取照常成功）', async () => {
  await withTempDir(async (sessionDir) => {
    await installCrashDebris(sessionDir, '33333333-abcdef01')
    const first = await acquireWriteLock(sessionDir, { waitMs: 300 })
    first.release()
    const second = await acquireWriteLock(sessionDir, { waitMs: 300 })
    try {
      assert.ok(second.token)
      assert.deepEqual(await debrisOf(sessionDir), [], '第二次获取同样会清掉残留')
    } finally {
      second.release()
    }
  })
})
