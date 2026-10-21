/**
 * 0.13.2-beta.2 守卫（W-02）：接管持续失败必须退避并在 deadline 内抛 ELOCKED。
 *
 * ## 缺陷
 * D-10 把 `takeOver` 的瞬态失败从「抛 ELOCKIO」改成「静默 return，交给外层重试」，
 * 但外层 `continue` 之前**既没有 sleep、也没有重查 deadline**：
 *
 *   if (isWriteLockStale(current, …)) { await takeOver(lockDir); continue }
 *
 * 只要接管持续失败（Windows 上 owner.json 有打开的句柄、杀软在扫、另一进程在
 * readdir），`acquireWriteLock` 就是纯微任务空转：不返回、不抛错、CPU 打满，
 * 连 `AbortSignal` 都插不进去。这是修复引入的回归——旧行为「抛 ELOCKIO」难看，
 * 但**会返回**。
 *
 * ## 判据（改回去必红）
 * - `io.rename` 持续 EPERM + `waitMs: 0` → 有限时间内**抛** `ELOCKED`
 *   （`details.reason === 'takeover-failed'`），不是 ELOCKIO、不是挂住；
 * - `io.rename` 正常时接管成功（证明注入缝本身没把正常路径改坏）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import path from 'node:path'

import {
  acquireWriteLock,
  readWriteLockOwner,
  writeLockDirectoryFor,
  WRITE_LOCK_KIND,
  WRITE_LOCK_OWNER_FILE,
} from '../src/v2/write-lock.mjs'

async function withTempDir(body) {
  const dir = await mkdtemp(path.join(tmpdir(), 'mcl-lock-takeover-'))
  try {
    return await body(dir)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/** 装一把确实 stale 的锁：死 pid + 过期心跳。 */
async function installStaleLock(dir) {
  const lockDir = writeLockDirectoryFor(dir)
  await mkdir(lockDir, { recursive: true })
  await writeFile(path.join(lockDir, WRITE_LOCK_OWNER_FILE), JSON.stringify({
    kind: WRITE_LOCK_KIND,
    token: 'dead-holder',
    pid: 999999,
    host: hostname(),
    acquiredAt: new Date(Date.now() - 600_000).toISOString(),
    heartbeatAt: Date.now() - 600_000,
  }, null, 2) + '\n', 'utf8')
  return lockDir
}

/** 在有限时间内必须 settle；超时视为「挂住」（正是本缺陷的形态）。 */
async function settleWithin(promise, ms) {
  let timer
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve({ timedOut: true }), ms) })
  try {
    return await Promise.race([
      promise.then((value) => ({ value, timedOut: false }), (error) => ({ error, timedOut: false })),
      timeout,
    ])
  } finally {
    clearTimeout(timer)
  }
}

test('W-02：接管持续失败时必须在 deadline 内抛 ELOCKED（不得无界自旋）', async () => {
  await withTempDir(async (dir) => {
    await installStaleLock(dir)
    // 注入缝：rename 恒 EPERM——复刻「目录里有打开的句柄 / 杀软在扫」。
    const io = {
      rename: async () => {
        const error = new Error('EPERM: operation not permitted, rename')
        error.code = 'EPERM'
        throw error
      },
    }
    const settled = await settleWithin(acquireWriteLock(dir, { waitMs: 0, io }), 4000)
    assert.equal(settled.timedOut, false, '4s 内未返回、未抛错 = 无界自旋，调用方永远挂住')
    assert.ok(settled.error, '接管失败必须失败关闭，绝不能返回一个「假装拿到」的句柄')
    assert.equal(settled.error.code, 'ELOCKED', `必须是可重试的 ELOCKED，实际 ${settled.error.code}`)
    assert.equal(settled.error.details?.reason, 'takeover-failed', '错误必须说清是接管失败')
  })
})

test('W-02：接管正常时照旧成功（注入缝不得改坏正常路径）', async () => {
  await withTempDir(async (dir) => {
    await installStaleLock(dir)
    const handle = await acquireWriteLock(dir, { waitMs: 0 })
    try {
      assert.ok(handle.token, 'stale 锁必须能被接管')
      assert.equal(handle.reentrant, false)
      assert.equal((await readWriteLockOwner(dir))?.token, handle.token)
    } finally {
      handle.release()
    }
    assert.equal(await readWriteLockOwner(dir), null)
  })
})

test('W-02：接管先失败后成功时，重试路径仍然拿到锁（不是一失败就放弃）', async () => {
  await withTempDir(async (dir) => {
    await installStaleLock(dir)
    let calls = 0
    const io = {
      rename: async (from, to) => {
        calls += 1
        if (calls === 1) {
          const error = new Error('EBUSY: resource busy or locked')
          error.code = 'EBUSY'
          throw error
        }
        const { rename } = await import('node:fs/promises')
        return rename(from, to)
      },
    }
    const handle = await acquireWriteLock(dir, { waitMs: 200, io })
    try {
      assert.ok(handle.token, '一次瞬态失败之后必须重试成功')
      assert.ok(calls >= 2, '必须真的重试过')
    } finally {
      handle.release()
    }
  })
})
