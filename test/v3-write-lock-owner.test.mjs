/**
 * B3-6（AUD50-03-05）写锁凭证失败关闭——owner.json 读错误/损坏/形状非法一律 ELOCKED，
 * 不当作 stale 接管（EISDIR 双写者事故形态）；owner 缺失按锁目录 mtime 计龄，
 * 超过 TTL 才接管（活锁不被误接管）；正常抢锁/超 TTL 接管不回退。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { acquireWriteLock } from '../src/v3/adapters/storage/write-lock.mjs'

async function withDir(body) {
  const dir = await mkdtemp(path.join(tmpdir(), 'mcl-v3-lock-owner-'))
  try {
    return await body(dir)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

function lockDirOf(dir) { return path.join(dir, '.write-lock') }

test('B3-6 owner.json 是目录（EISDIR）：失败关闭 ELOCKED，不接管', async () => {
  await withDir(async (dir) => {
    await mkdir(path.join(lockDirOf(dir), 'owner.json'), { recursive: true })
    await assert.rejects(
      () => acquireWriteLock(dir, { ttlMs: 60000, waitMs: 0 }),
      (e) => e?.code === 'ELOCKED' && /owner\.json 读取失败/.test(e.message),
    )
  })
})

test('B3-6 owner.json 损坏（非 JSON）与形状非法：失败关闭，不接管', async () => {
  await withDir(async (dir) => {
    await mkdir(lockDirOf(dir), { recursive: true })
    await writeFile(path.join(lockDirOf(dir), 'owner.json'), '{broken json', 'utf8')
    await assert.rejects(
      () => acquireWriteLock(dir, { ttlMs: 60000, waitMs: 0 }),
      (e) => e?.code === 'ELOCKED' && /损坏/.test(e.message),
    )
    await writeFile(path.join(lockDirOf(dir), 'owner.json'), JSON.stringify({ heartbeatAt: 1 }) + '\n', 'utf8')
    await assert.rejects(
      () => acquireWriteLock(dir, { ttlMs: 60000, waitMs: 0 }),
      (e) => e?.code === 'ELOCKED' && /形状非法/.test(e.message),
    )
  })
})

test('B3-6 owner 缺失且锁目录新鲜：不立即接管（ELOCKED）', async () => {
  await withDir(async (dir) => {
    await mkdir(lockDirOf(dir), { recursive: true })
    await assert.rejects(
      () => acquireWriteLock(dir, { ttlMs: 60000, waitMs: 0 }),
      (e) => e?.code === 'ELOCKED' && /活持有者/.test(e.message),
    )
  })
})

test('B3-6 owner 缺失且超 TTL：接管成功（正常抢锁不回退）', async () => {
  await withDir(async (dir) => {
    await mkdir(lockDirOf(dir), { recursive: true })
    const stale = new Date(Date.now() - 120000)
    await utimes(lockDirOf(dir), stale, stale)
    const handle = await acquireWriteLock(dir, { ttlMs: 60000, waitMs: 2000 })
    assert.equal(typeof handle.token, 'string')
    assert.equal(await handle.release(), 'ok')
  })
})
