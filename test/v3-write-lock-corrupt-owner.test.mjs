/**
 * P1-05（0.15.1）：写锁 `owner.json` 损坏 = 永久 `ELOCKED`，没有 stale 接管出口。
 *
 * ## 缺陷
 * `readOwner` 对「JSON 解析失败 / 形状非法」直接 `throw v3Error('ELOCKED')`。于是 owner.json
 * 半截、空文件或字段缺失时：该会话目录的**所有写**（事务 / state / control / intent / usage /
 * 索引）全部失败关闭，且把锁目录 mtime 改到 24h 前（远超 60s TTL）**仍然 ELOCKED**——没有任何
 * 自愈路径。一次被中断的两阶段写（磁盘满/掉电/杀进程）就足以让整库变只读，用户只能手工删目录。
 *
 * ## 判据来源
 * docs/dev-0.15.1/记忆上下文-0.15.1-独立排查报告.md §1★7 / §3.1 P1-05；
 * 用户裁定（2026-11-04）：全部按顺序修，根因修复。
 *
 * ## 修法
 * 把「损坏」从「失败关闭」里拆出来，作为第三种读结局（`corruptOwner`）：
 * - 接管判据与「owner 缺失」同源（B3-6）：锁目录 mtime + TTL 到期才接管，**不是**见损坏就抢；
 * - 接管前写一行 repair-log 审计（source=write-lock），接管失败重试时不重复记账；
 * - 心跳/释放仍认不出损坏凭证的 token → 不会误删新持有者的锁（失败方向仍是严格）；
 * - 真正读不到（EACCES 等）依旧失败关闭：那是权限/介质问题，不是「凭证坏了」。
 *
 * ## 断言组
 * 1. 损坏 + 锁目录已过 TTL：能取得锁，repair-log 留下审计行，release 正常；
 * 2. 损坏 + 锁目录未过 TTL：仍在 deadline 内 ELOCKED（不因损坏就无条件抢占）；
 * 3. 接管后新持有者写下的 owner.json 形状正确（可被下一次正常读取）。
 *
 * ## 不适用条件与已知边界
 * - 损坏期间**未过 TTL** 的写仍然失败关闭：这是有意的（活持有者可能只是写入中断），
 *   文案点明「到期后自动接管」，不再让用户以为要手工删目录；
 * - 不探测 pid（沿用既有设计），持有者已死也要等满 TTL。
 *
 * ## 定点变异自证
 * 把 `corruptOwner` 的返回改回 `throw v3Error('ELOCKED', …)` → 第 1、3 条必红；
 * 把 stale 判据里的 `|| ownerCorrupt` 去掉 → 第 1、3 条必红（永久 ELOCKED 复现）。读数见台账 R1。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { acquireWriteLock } from '../src/v3/adapters/storage/write-lock.mjs'

const HOUR = 3600 * 1000

async function corruptLockDir(tag, ageMs) {
  const dir = await mkdtemp(path.join(tmpdir(), 'mcl-p105-' + tag + '-'))
  const lockDir = path.join(dir, '.write-lock')
  await mkdir(lockDir, { recursive: true })
  // 半截 JSON：两阶段写在 writeFile 中途被杀的真实形状。
  await writeFile(path.join(lockDir, 'owner.json'), '{"token":"deadbeef","pid":', 'utf8')
  const stamp = new Date(Date.now() - ageMs)
  await utimes(lockDir, stamp, stamp)
  return { dir, lockDir }
}

test('P1-05 损坏 owner + 锁目录过 TTL：可接管，repair-log 有审计，release 正常', async () => {
  const { dir, lockDir } = await corruptLockDir('stale', 24 * HOUR)
  try {
    const lock = await acquireWriteLock(dir, { ttlMs: 60000, waitMs: 3000 })
    assert.equal(typeof lock.token, 'string', '必须取得锁')
    assert.equal(lock.lockDir, lockDir)
    const audit = (await readFile(path.join(dir, 'repair-log.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
    assert.equal(audit.length, 1, '每次 acquire 只记一条审计')
    assert.equal(audit[0].source, 'write-lock')
    assert.match(audit[0].reason, /owner\.json 损坏/, '审计必须说清是凭证损坏接管')
    const owner = JSON.parse(await readFile(path.join(lockDir, 'owner.json'), 'utf8'))
    assert.equal(owner.token, lock.token, '接管后锁目录里必须是新持有者的凭证')
    assert.equal(await lock.release(), 'ok')
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

test('P1-05 损坏 owner + 锁目录未过 TTL：仍失败关闭（不无条件抢占）', async () => {
  const { dir } = await corruptLockDir('fresh', 0)
  try {
    await assert.rejects(
      () => acquireWriteLock(dir, { ttlMs: 60000, waitMs: 400 }),
      (error) => {
        assert.equal(error.code, 'ELOCKED')
        assert.match(error.message, /损坏且锁目录未超过 TTL/, '文案要点明 TTL 到期会自动接管：' + error.message)
        return true
      },
    )
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

test('P1-05 损坏文件为空 / 形状非法：同样按 TTL 接管', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mcl-p105-shape-'))
  try {
    const lockDir = path.join(dir, '.write-lock')
    await mkdir(lockDir, { recursive: true })
    await writeFile(path.join(lockDir, 'owner.json'), '', 'utf8')
    const stamp = new Date(Date.now() - 24 * HOUR)
    await utimes(lockDir, stamp, stamp)
    const lock = await acquireWriteLock(dir, { ttlMs: 60000, waitMs: 3000 })
    assert.equal((await stat(path.join(lockDir, 'owner.json'))).isFile(), true)
    assert.equal(await lock.release(), 'ok')
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})
