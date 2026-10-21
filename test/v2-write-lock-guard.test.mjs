/**
 * 0.13.2 守卫：写锁的三种互斥失效（D-05 / D-06 / D-10）。
 *
 * ## 缺陷
 * - **D-05**：`readOwner` 在 `ENOENT` 时返回 `null`，而 `isWriteLockStale(null)` 直接
 *   返回 true → 「锁目录刚建、owner.json 还没落盘」的窗口被当场判 stale 并接管，
 *   两个写者同时持锁（正是这把锁要防的 lost update）。
 * - **D-06**：心跳只认路径不校验 token，被接管者的心跳会把新持有者的凭证覆盖掉；
 *   新持有者 `release()` 因 token 不符静默失效，锁目录永久残留。
 * - **D-10**：Windows 上目录 rename 会被「有打开句柄 / 杀软扫描」打成 EPERM/EBUSY，
 *   旧实现把它一律变成 `ELOCKIO`（读起来像数据损坏），抢锁从「可重试」变成「硬失败」。
 *
 * ## 判据（改回去必红）
 * - 「目录在、owner 不在」且锁目录很新 → 第二个写者得 `ELOCKED`（不是拿到锁）；
 * - 两阶段创建成功后，`readOwner === null` 才可能判 stale（凭证与目录同刻出现）；
 * - 被接管者的心跳不得改写新持有者的 owner.json；
 * - 接管遇瞬态错误重试而不是 ELOCKIO。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import path from 'node:path'

import {
  acquireWriteLock,
  isWriteLockStale,
  readWriteLockOwner,
  writeLockDirectoryFor,
  WRITE_LOCK_CREATION_GRACE_MS,
  WRITE_LOCK_KIND,
  WRITE_LOCK_OWNER_FILE,
} from '../src/v2/write-lock.mjs'

async function withTempDir(body) {
  const dir = await mkdtemp(path.join(tmpdir(), 'mcl-lock-guard-'))
  try {
    return await body(dir)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

test('D-05：「目录在、owner.json 不在」的创建窗口不得被当场接管', async () => {
  await withTempDir(async (dir) => {
    const lockDir = writeLockDirectoryFor(dir)
    await mkdir(lockDir, { recursive: true }) // 复刻旧版本的创建窗口：目录已建、凭证未落
    await assert.rejects(
      () => acquireWriteLock(dir, { waitMs: 0 }),
      (error) => error?.code === 'ELOCKED',
      '活持有者的创建窗口必须得到 ELOCKED，而不是被接管',
    )
    const owner = await readWriteLockOwner(dir)
    assert.equal(owner, null, '拒绝方不得写入任何凭证')
  })
})

test('D-05：陈旧的空锁目录（超过创建宽限）仍可接管，不被一条空目录永久卡住', async () => {
  await withTempDir(async (dir) => {
    const lockDir = writeLockDirectoryFor(dir)
    await mkdir(lockDir, { recursive: true })
    const old = new Date(Date.now() - (WRITE_LOCK_CREATION_GRACE_MS + 60_000))
    await utimes(lockDir, old, old)
    const handle = await acquireWriteLock(dir, { waitMs: 0 })
    assert.ok(handle.token, '陈旧的空目录必须能被接管，否则写路径永久不可用')
    await handle.release()
    assert.equal(await readWriteLockOwner(dir), null)
  })
})

test('D-05：两阶段创建成功后凭证与目录同刻出现（不存在「目录在而 owner 不在」的中间态）', async () => {
  await withTempDir(async (dir) => {
    const handle = await acquireWriteLock(dir)
    try {
      const lockDir = writeLockDirectoryFor(dir)
      const info = await stat(path.join(lockDir, WRITE_LOCK_OWNER_FILE))
      assert.ok(info.isFile(), '拿到锁之后凭证必须已经在目录里')
      const owner = JSON.parse(await readFile(path.join(lockDir, WRITE_LOCK_OWNER_FILE), 'utf8'))
      assert.equal(owner.token, handle.token)
      assert.equal(isWriteLockStale(owner, { now: Date.now() }), false)
    } finally {
      await handle.release()
    }
  })
})

test('D-06：被接管者的心跳不得改写新持有者的 owner.json', async () => {
  await withTempDir(async (dir) => {
    const victim = await acquireWriteLock(dir, { heartbeatMs: 40 })
    const lockDir = writeLockDirectoryFor(dir)
    // 模拟「已被接管」：另一个持有者把自己的凭证写进同一把锁。
    const thief = {
      kind: WRITE_LOCK_KIND,
      token: 'thief-token',
      pid: process.pid,
      host: hostname(),
      acquiredAt: new Date().toISOString(),
      heartbeatAt: Date.now(),
    }
    await writeFile(path.join(lockDir, WRITE_LOCK_OWNER_FILE), JSON.stringify(thief, null, 2) + '\n', 'utf8')

    await new Promise((resolve) => setTimeout(resolve, 160))
    const owner = await readWriteLockOwner(dir)
    assert.equal(owner?.token, 'thief-token', '被接管者的心跳覆盖了新持有者的凭证（新持有者 release 会静默失效）')
    assert.equal(victim.lost?.(), true, '心跳自检失败必须把自己标记为 lost')

    // 被接管者的 release 不得删掉新持有者的锁。
    const released = await victim.release()
    assert.equal(released, false, 'token 不符时 release 必须如实返回 false')
    assert.equal((await readWriteLockOwner(dir))?.token, 'thief-token', '被接管者不得删别人的锁')
    await rm(lockDir, { recursive: true, force: true })
  })
})

test('同进程并发获取必须排队成重入，不得在自己进程的锁上抛 ELOCKED', async () => {
  // 回归：修掉 D-05（不再把「目录在、凭证未落盘」判 stale）之后，两个 async 分支同时
  // 要同一把锁会双双走进竞争分支，读到的是**自己进程**刚写的凭证（pid 活着、心跳新鲜），
  // 于是既不能接管也不能重入——写路径在自己的进程里自锁 500ms 后抛 ELOCKED。
  await withTempDir(async (dir) => {
    const handles = await Promise.all(Array.from({ length: 6 }, () => acquireWriteLock(dir, { waitMs: 0 })))
    assert.equal(handles.length, 6, '同进程并发获取必须全部成功（排队成重入）')
    assert.equal(new Set(handles.map((handle) => handle.token)).size, 1, '同一时刻只应有一把锁、一个 token')
    for (const handle of handles.slice(0, -1)) {
      assert.equal(await handle.release(), false, '还有引用时 release 不得删锁')
    }
    assert.equal(await handles[handles.length - 1].release(), true, '最后一次 release 才删锁')
    assert.equal(await readWriteLockOwner(dir), null)
  })
})

test('D-10：接管遇瞬态 EPERM/EBUSY 不得被打成 ELOCKIO（可重试而不是硬失败）', async () => {
  await withTempDir(async (dir) => {
    // 制造一把 stale 锁（死 pid + 过期心跳），然后让并发接管真实发生：
    // 谁先赢谁持锁，落败方必须得到 ELOCKED 而不是 ELOCKIO。
    const lockDir = writeLockDirectoryFor(dir)
    await mkdir(lockDir, { recursive: true })
    await writeFile(path.join(lockDir, WRITE_LOCK_OWNER_FILE), JSON.stringify({
      kind: WRITE_LOCK_KIND,
      token: 'dead',
      pid: 999999,
      host: hostname(),
      acquiredAt: new Date(Date.now() - 600_000).toISOString(),
      heartbeatAt: Date.now() - 600_000,
    }, null, 2) + '\n', 'utf8')

    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () => acquireWriteLock(dir, { waitMs: 60 })),
    )
    for (const result of results) {
      if (result.status === 'fulfilled') continue
      assert.notEqual(result.reason?.code, 'ELOCKIO', `瞬态竞争被打成 ELOCKIO：${result.reason?.message}`)
      assert.equal(result.reason?.code, 'ELOCKED')
    }
    for (const result of results) {
      if (result.status === 'fulfilled') await result.value.release()
    }
    assert.ok(results.some((result) => result.status === 'fulfilled'), '至少一个写者应当抢到锁')
  })
})
