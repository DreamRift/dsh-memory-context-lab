/**
 * v3 跨进程写锁（adapters/storage，M2 第二批）——write-lock 三套保留判据的 v3 重证。
 *
 * - **两阶段创建**：临时目录写好 owner.json 再 rename——「锁目录在、凭证不在」
 *   不是可观察状态（D-05：该窗口曾被当场判 stale 并接管，双写者同时持锁）；
 * - **心跳校验 token**：心跳先读回比对 token，不符即停表标 lost——被接管者的
 *   心跳不得覆盖新持有者的凭证（D-06）；
 * - **stale 接管**：心跳超 TTL → 把旧锁目录改名墓碑后重取（**不探测 pid**；
 *   持有进程已死也同样要等满 TTL，G-C 文档漂移已按实现更正）；
 *   接管/加锁的瞬态 EPERM/EBUSY/ENOENT 按退避重试，deadline 内用尽抛 ELOCKED
 *   （不无界自旋，W-02）；
 * - **同进程串行 + 重入**：同目录 withWriteLock 排队成链；同调用栈嵌套直接执行
 *   （不死锁）；不同目录互不阻塞（W-01）。
 * 时间经注入（now 函数），测试用虚拟时钟确定性驱动。
 */
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { hostname } from 'node:os'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { AsyncLocalStorage } from 'node:async_hooks'

import { v3Error, V3ContractViolation } from '../../contracts/errors.mjs'

const LOCK_DIR = '.write-lock'
const OWNER_FILE = 'owner.json'
const DEFAULT_TTL_MS = 60000
const DEFAULT_WAIT_MS = 5000
const RETRY_BACKOFF_MS = 25
/** 续约间隔：TTL 的三分之一（60s TTL → 20s 一次），足以在两次续约之间容忍一次抖动。 */
const HEARTBEAT_INTERVAL_MS = Math.max(1000, Math.floor(DEFAULT_TTL_MS / 3))

function lockDirOf(dir) {
  return path.join(dir, LOCK_DIR)
}

/**
 * 读锁凭证。B3-6（AUD50-03-05）：只把 ENOENT 当「没有」（与 fileExists 的 G-B 口径
 * 一致）——旧实现 catch-all 返回 null，owner.json 是目录（EISDIR）或读不到（EACCES）
 * 时被当 stale **直接接管**，等于双写者同时进临界区。其它读错误/凭证损坏一律失败关闭。
 */
async function readOwner(lockDir, now) {
  let raw
  try {
    raw = await readFile(path.join(lockDir, OWNER_FILE), 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw v3Error('ELOCKED', 'owner.json 读取失败（失败关闭，不当作 stale 接管）：' + (error?.code ?? 'EINTERNAL') + ' ' + (error?.message ?? String(error)))
  }
  let owner
  try {
    owner = JSON.parse(raw)
  } catch (error) {
    throw v3Error('ELOCKED', 'owner.json 损坏（两阶段创建后不该发生；接管被拒绝，失败关闭）：' + (error?.message ?? String(error)))
  }
  if (owner === null || typeof owner !== 'object' || typeof owner.token !== 'string' || !Number.isFinite(owner.heartbeatAt)) {
    throw v3Error('ELOCKED', 'owner.json 形状非法（接管被拒绝，失败关闭）')
  }
  return owner
}

/** B3-6：owner 缺失不立即 stale——按锁目录 mtime 计龄，超过 TTL 才接管。 */
async function lockDirStaleWithoutOwner(lockDir, now, ttlMs) {
  try {
    const info = await stat(lockDir)
    return now() - info.mtimeMs > ttlMs
  } catch (error) {
    if (error?.code === 'ENOENT') return true // 锁目录没了：下一轮 rename 直接成功
    throw error
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 获取写锁。成功返回 { token, lockDir, release(), heartbeat() }。
 * @param {object} options { ttlMs, waitMs, now, token }
 */
export async function acquireWriteLock(dir, options = {}) {
  if (typeof dir !== 'string' || dir.length === 0) {
    throw new V3ContractViolation('v3 lock: dir 必须是非空字符串')
  }
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
  const waitMs = options.waitMs ?? DEFAULT_WAIT_MS
  const now = options.now ?? (() => Date.now())
  const token = options.token ?? randomUUID()
  if (!Number.isFinite(ttlMs) || ttlMs <= 0 || !Number.isFinite(waitMs) || waitMs < 0) {
    throw new V3ContractViolation('v3 lock: ttlMs/waitMs 非法')
  }
  const lockDir = lockDirOf(dir)
  const deadline = now() + waitMs

  for (;;) {
    // 两阶段：临时目录（含 owner.json）→ rename 成锁目录
    const staging = lockDir + '.' + randomUUID() + '.tmp'
    await mkdir(staging, { recursive: true })
    const owner = {
      token, pid: process.pid, host: hostname(),
      acquiredAt: now(), heartbeatAt: now(),
    }
    await rm(path.join(staging, OWNER_FILE), { force: true }).catch(() => {})
    const { writeFile } = await import('node:fs/promises')
    await writeFile(path.join(staging, OWNER_FILE), JSON.stringify(owner) + '\n', 'utf8')
    try {
      await rename(staging, lockDir)
      return buildHandle({ dir, lockDir, token, now, ttlMs })
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => {})
      if (!isTransient(error)) throw error
    }

    // 锁目录已存在：读凭证判 stale（owner 缺失按锁目录 mtime 计龄，B3-6）
    const current = await readOwner(lockDir, now)
    const stale = current === null
      ? await lockDirStaleWithoutOwner(lockDir, now, ttlMs)
      : now() - current.heartbeatAt > ttlMs
    if (!stale) {
      if (now() >= deadline) {
        throw v3Error('ELOCKED', '写锁被活持有者持有（token ' + String(current?.token).slice(0, 8) + '…，心跳 ' + (now() - (current?.heartbeatAt ?? 0)) + 'ms 前）')
      }
      await sleep(RETRY_BACKOFF_MS)
      continue
    }
    // stale → 墓碑改名后重试（EPERM/EBUSY 等瞬态也走重试）
    const tombstone = lockDir + '.stale.' + randomUUID()
    try {
      await rename(lockDir, tombstone)
      await rm(tombstone, { recursive: true, force: true }).catch(() => {})
    } catch (error) {
      if (!isTransient(error) && error?.code !== 'ENOENT') throw error
    }
    if (now() >= deadline) {
      throw v3Error('ELOCKED', '接管失败：deadline 内未取得写锁（不无界自旋，W-02）')
    }
    await sleep(RETRY_BACKOFF_MS)
  }
}

function isTransient(error) {
  return ['EPERM', 'EBUSY', 'ENOENT', 'EACCES'].includes(error?.code) || error?.code === undefined
}

function buildHandle({ dir, lockDir, token, now, ttlMs }) {
  let lost = false
  return {
    token,
    lockDir,
    async heartbeat() {
      if (lost) return 'lost'
      const current = await readOwner(lockDir, now)
      if (current === null || current.token !== token) {
        lost = true // 不覆盖新持有者的凭证（D-06）
        return 'lost'
      }
      const { writeFileAtomic } = await import('./session-store.mjs')
      await writeFileAtomic(path.join(lockDir, OWNER_FILE), JSON.stringify({ ...current, heartbeatAt: now() }) + '\n')
      return 'ok'
    },
    async release() {
      if (lost) return 'lost'
      const current = await readOwner(lockDir, now)
      if (current === null || current.token !== token) {
        lost = true
        return 'lost' // token 不符不删新持有者的锁
      }
      await rm(lockDir, { recursive: true, force: true }).catch(() => {})
      return 'ok'
    },
  }
}

// —— 同进程串行 + 重入（W-01）——
const dirChains = new Map()
const reentry = new AsyncLocalStorage()

/**
 * 同目录串行执行；同调用栈嵌套直接执行（重入）；不同目录互不阻塞。
 */
export async function withWriteLock(dir, body) {
  const inner = reentry.getStore()
  if (inner !== undefined && inner.has(dir)) return body()
  let chain = dirChains.get(dir) ?? Promise.resolve()
  // 帧必须**继承上层已持有的目录**：旧实现只放当前 dir（`new Set([dir])`），
  // A 锁 → B 锁 → 再 A 锁时 `has(A)` 为假，于是在同一条队列上等自己（自死锁）。
  const run = chain.then(async () => reentry.run(new Set([...(inner ?? []), dir]), body))
  const next = run.then(() => {}, () => {})
  dirChains.set(dir, next)
  next.then(() => {
    // 队列排空且没有新排队者时清理登记（防 Map 无界增长）
    if (dirChains.get(dir) === next) dirChains.delete(dir)
  })
  return run
}


/**
 * 跨进程写锁组合（H-10-a 接入，2026-10-26 拍板方案 A：每次事务取锁）：
 * 进程内队列（同进程串行 + 重入）→ 跨进程文件锁（acquireWriteLock）→ body → release。
 * 两 DSH 进程同写一会话目录时事务号与凭证不再相撞；锁等待 5s 内未取得抛 ELOCKED 失败关闭。
 */
export async function withCrossProcessWriteLock(dir, body, options = {}) {
  // B2-4（AUD50-03-01）锁重入：同一异步上下文已持同目录锁时（端口/repair 持锁期间
  // 再 open）跳过二次取文件锁——acquireWriteLock 不重入，嵌套会与自己互等 5s 后
  // ELOCKED（实测最小复现）。进程内串行/重入语义由 withWriteLock 的 ALS 保证。
  const held = reentry.getStore()
  const reentrant = held !== undefined && held.has(dir)
  return withWriteLock(dir, async () => {
    if (reentrant) return body()
    const lock = await acquireWriteLock(dir, options)
    // 事务期间必须**续约**：TTL 默认 60s，而一次回填批或索引重建可能更久。
    // 旧实现从不调用 heartbeat，`owner.heartbeatAt` 恒等于 acquiredAt——超过 TTL 的
    // 事务会被另一进程判定 stale 并接管，两个写者同时进临界区（且旧持有者不会停）。
    const renew = setInterval(() => { lock.heartbeat().catch(() => {}) }, HEARTBEAT_INTERVAL_MS)
    renew.unref?.()
    try {
      return await body()
    } finally {
      clearInterval(renew)
      await lock.release().catch(() => {})
    }
  })
}
