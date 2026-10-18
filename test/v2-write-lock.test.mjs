import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { hostname } from 'node:os'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

import {
  acquireWriteLock,
  isWriteLockStale,
  readWriteLockOwner,
  writeLockDirectoryFor,
  WRITE_LOCK_KIND,
  WRITE_LOCK_OWNER_FILE,
} from '../src/v2/write-lock.mjs'

const execFileAsync = promisify(execFile)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const CHILD = path.join(HERE, 'helpers', 'lock-child.mjs')

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'mcl-lock-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

async function writeOwner(dir, owner) {
  const lockDir = writeLockDirectoryFor(dir)
  await mkdir(lockDir, { recursive: true })
  await writeFile(path.join(lockDir, WRITE_LOCK_OWNER_FILE), JSON.stringify(owner, null, 2), 'utf8')
}

test('同进程重入：两次 acquire 只加引用，最后一次 release 才删锁', async () => {
  await withTempDir(async (dir) => {
    const first = await acquireWriteLock(dir)
    const second = await acquireWriteLock(dir)
    assert.equal(second.reentrant, true)
    await first.release()
    assert.ok(await readWriteLockOwner(dir), '还有一层引用，锁必须仍在')
    await second.release()
    assert.equal(await readWriteLockOwner(dir), null)
  })
})

test('跨进程独占：另一进程持锁时本进程失败关闭为 ELOCKED', async () => {
  await withTempDir(async (dir) => {
    const holder = acquireWriteLock(dir)
    const handle = await holder
    try {
      await assert.rejects(
        () => execFileAsync(process.execPath, [CHILD, dir, '300'], { timeout: 10_000 }),
        (error) => {
          assert.equal(error.code, 3)
          assert.match(String(error.stdout), /ERROR:ELOCKED/)
          return true
        },
      )
    } finally {
      await handle.release()
    }
    const { stdout } = await execFileAsync(process.execPath, [CHILD, dir, '10'], { timeout: 10_000 })
    assert.match(stdout, /ACQUIRED/)
    assert.equal(await readWriteLockOwner(dir), null, '子进程释放后锁应消失')
  })
})

test('stale 接管：进程已死或心跳过期时可接管', async () => {
  await withTempDir(async (dir) => {
    const now = Date.now()
    await writeOwner(dir, {
      kind: WRITE_LOCK_KIND,
      token: 'dead-owner',
      pid: 999999,
      host: hostname(),
      acquiredAt: new Date(now - 120_000).toISOString(),
      heartbeatAt: now - 120_000,
    })
    assert.equal(isWriteLockStale({ kind: WRITE_LOCK_KIND, token: 'x', pid: 999999, host: hostname(), heartbeatAt: now - 120_000 }, { now }), true)
    const handle = await acquireWriteLock(dir, { waitMs: 0 })
    assert.ok(handle.token && handle.token !== 'dead-owner')
    await handle.release()
    assert.equal(await readWriteLockOwner(dir), null)
  })
})

test('release 不误删新持有者的锁（token 不符时不删）', async () => {
  await withTempDir(async (dir) => {
    const handle = await acquireWriteLock(dir)
    const lockDir = writeLockDirectoryFor(dir)
    const ownerFile = path.join(lockDir, WRITE_LOCK_OWNER_FILE)
    const stolen = JSON.parse(await readFile(ownerFile, 'utf8'))
    stolen.token = 'someone-else'
    stolen.pid = 999999
    stolen.host = 'other-host'
    await writeFile(ownerFile, JSON.stringify(stolen), 'utf8')
    await handle.release()
    const after = await readWriteLockOwner(dir)
    assert.equal(after?.token, 'someone-else', '不得删除别人的锁')
    await rm(lockDir, { recursive: true, force: true })
  })
})

test('心跳：持有期间 heartbeatAt 会被续租推进', async () => {
  await withTempDir(async (dir) => {
    const handle = await acquireWriteLock(dir, { heartbeatMs: 40 })
    try {
      const first = (await readWriteLockOwner(dir)).heartbeatAt
      await new Promise((resolve) => setTimeout(resolve, 140))
      const second = (await readWriteLockOwner(dir)).heartbeatAt
      assert.ok(second > first, '心跳应推进 heartbeatAt')
    } finally {
      await handle.release()
    }
  })
})
