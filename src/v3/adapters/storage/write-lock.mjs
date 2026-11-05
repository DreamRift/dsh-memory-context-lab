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
import { appendFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
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
/**
 * 获取尝试上限（M2，2026-11-04 审计）：deadline 用墙钟算，时钟回拨时 `now() >= deadline`
 * 可能长时间不成立，旧实现就无界自旋。这里再给一个与时钟无关的硬上限；
 * 按 25ms 退避约等于 25s，远大于默认 5s 等待。
 */
const MAX_ACQUIRE_ATTEMPTS = 1000
/** owner.json 读取的瞬态错误（Windows 上 rename/rm 期间的 EPERM/EBUSY 常见）。 */
const TRANSIENT_READ_CODES = new Set(['EPERM', 'EACCES', 'EBUSY'])
const OWNER_READ_RETRIES = 3
/**
 * 续约间隔按**实际 TTL** 推导（R3-03）：TTL 的三分之一，且必须小于 TTL——
 * 旧实现固定按默认 60s 推导（Math.max(1000, 20000)），自定义小 TTL 的长事务
 * 会在第一次续约之前就被别的进程判 stale 接管。导出供测试断言推导规则。
 */
export function heartbeatIntervalOf(ttlMs) {
  const third = Math.max(1, Math.floor(ttlMs / 3))
  const half = Math.max(1, Math.floor(ttlMs / 2))
  return Math.max(1, Math.min(third, half, ttlMs - 1))
}

function lockDirOf(dir) {
  return path.join(dir, LOCK_DIR)
}

/**
 * 读锁凭证。B3-6（AUD50-03-05）：只把 ENOENT 当「没有」（与 fileExists 的 G-B 口径
 * 一致）——旧实现 catch-all 返回 null，owner.json 是目录（EISDIR）或读不到（EACCES）
 * 时被当 stale **直接接管**，等于双写者同时进临界区。其它读错误/凭证损坏一律失败关闭。
 */
async function readOwner(lockDir, now) {
  let raw = null
  for (let attempt = 0; attempt <= OWNER_READ_RETRIES; attempt += 1) {
    try {
      raw = await readFile(path.join(lockDir, OWNER_FILE), 'utf8')
      break
    } catch (error) {
      if (error?.code === 'ENOENT') return null
      // C2（0.15.0 审计：v3-store-import-lock 偶发 EPERM 根因）：Windows 上另一个进程
      // 正在 rename/删除 owner.json 时，读会拿到瞬态 EPERM/EBUSY。旧实现把它直接当
      // 「锁不可读」失败关闭，全量连跑时表现为随机失败。只对瞬态错误做**有界**重试；
      // 重试用尽或非瞬态错误仍然失败关闭（绝不当作 stale 接管）。
      if (TRANSIENT_READ_CODES.has(error?.code) && attempt < OWNER_READ_RETRIES) {
        await sleep(5 * (attempt + 1))
        continue
      }
      throw v3Error('ELOCKED', 'owner.json 读取失败（失败关闭，不当作 stale 接管）：' + (error?.code ?? 'EINTERNAL') + ' ' + (error?.message ?? String(error)))
    }
  }
  let owner
  try {
    owner = JSON.parse(raw)
  } catch (error) {
    // P1-05：损坏不再是「失败关闭」的终点。旧实现直接 throw ELOCKED，于是 owner.json 半截/
    // 空/形状非法时该会话目录**所有写永久失败**（连 stale 接管都没有出口），一个被中断的
    // 写就能把整库变成只读。损坏交给调用方按「锁目录 mtime + TTL」判 stale 后接管；
    // 心跳/释放仍然认不出 token，不会误删新持有者的锁。
    return corruptOwner(error)
  }
  if (owner === null || typeof owner !== 'object' || typeof owner.token !== 'string' || !Number.isFinite(owner.heartbeatAt)) {
    return corruptOwner('shape-invalid')
  }
  return owner
}

/** owner.json 损坏的读结局（P1-05）：既不是「没有锁」，也不是「活持有者」。 */
function corruptOwner(error) {
  return { corrupt: true, error: error?.message ?? String(error) }
}

/** 损坏接管的审计行（repair-log 是既有观测面；写不进去不阻断接管，见调用处）。 */
async function appendRepairAudit(dir, audit) {
  try {
    await appendFile(path.join(dir, 'repair-log.jsonl'), JSON.stringify({ schemaVersion: 1, source: 'write-lock', ...audit }) + '\n', 'utf8')
  } catch {
    // 审计尽力而为：拒绝接管 = 永久只读（更坏）。损坏事实本身仍可见（锁被接管 + TTL）。
  }
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
  let repairAudited = false

  for (let attempt = 0; ; attempt += 1) {
    if (attempt >= MAX_ACQUIRE_ATTEMPTS) {
      throw v3Error('ELOCKED', '写锁获取超过尝试上限（' + MAX_ACQUIRE_ATTEMPTS + ' 次）：时钟异常或持续争用，失败关闭')
    }
    // 两阶段：临时目录（含 owner.json）→ rename 成锁目录。
    // staging 的创建与写入都在 try 内（M2）：旧实现 writeFile 在 try 外，磁盘满/权限错时
    // staging 目录会永久残留（孤儿 .tmp，且没有任何路径清理它）。
    const staging = lockDir + '.' + randomUUID() + '.tmp'
    const owner = {
      token, pid: process.pid, host: hostname(),
      acquiredAt: now(), heartbeatAt: now(),
    }
    try {
      await mkdir(staging, { recursive: true })
      await writeFile(path.join(staging, OWNER_FILE), JSON.stringify(owner) + '\n', 'utf8')
      await rename(staging, lockDir)
      // fencing（M2）：rename 成功后再读回凭证，确认落到锁目录的是**自己**的 token。
      // 理论上 rename 原子，但「判 stale → 改名墓碑 → 释放墓碑」与另一进程的
      // 「新建锁目录」交错时，旧实现没有复核点；复核失败即视为本次未取得，继续排队。
      const confirmed = await readOwner(lockDir, now).catch(() => null)
      if (confirmed === null || confirmed.token !== token) {
        if (now() >= deadline) throw v3Error('ELOCKED', '写锁复核失败：目录内凭证不是本进程（deadline 已到）')
        await sleep(RETRY_BACKOFF_MS)
        continue
      }
      return buildHandle({ dir, lockDir, token, now, ttlMs })
    } catch (error) {
      if (!isTransient(error)) throw error
    } finally {
      // rename 成功后 staging 已不存在；失败/复核中途退出时清掉残留。
      await rm(staging, { recursive: true, force: true }).catch(() => {})
    }

    // 锁目录已存在：读凭证判 stale（owner 缺失按锁目录 mtime 计龄，B3-6；
    // owner 损坏同样按 mtime 计龄，P1-05——否则一条半截 owner.json 就是永久 ELOCKED）
    const current = await readOwner(lockDir, now)
    const ownerCorrupt = current !== null && current.corrupt === true
    const stale = current === null || ownerCorrupt
      ? await lockDirStaleWithoutOwner(lockDir, now, ttlMs)
      : now() - current.heartbeatAt > ttlMs
    if (!stale) {
      if (now() >= deadline) {
        throw v3Error('ELOCKED', ownerCorrupt
          ? '写锁 owner.json 损坏且锁目录未超过 TTL（' + ttlMs + 'ms）：到期后按 mtime 自动接管，当前失败关闭'
          : '写锁被活持有者持有（token ' + String(current?.token).slice(0, 8) + '…，心跳 ' + (now() - (current?.heartbeatAt ?? 0)) + 'ms 前）')
      }
      await sleep(RETRY_BACKOFF_MS)
      continue
    }
    if (ownerCorrupt && !repairAudited) {
      // 每次 acquire 只记一条：接管失败重试时不重复写审计行。
      repairAudited = true
      await appendRepairAudit(dir, { at: now(), file: path.join(LOCK_DIR, OWNER_FILE), reason: 'owner.json 损坏（按锁目录 mtime + TTL 接管）', error: current.error })
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
  // EEXIST/ENOTEMPTY 是 Windows/POSIX 上「目标锁目录已存在」的正常信号（rename 失败），
  // 不应被当成致命错误；其余瞬态按既有清单处理。
  return ['EPERM', 'EBUSY', 'ENOENT', 'EACCES', 'EEXIST', 'ENOTEMPTY'].includes(error?.code) || error?.code === undefined
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
      let current
      try {
        current = await readOwner(lockDir, now)
      } catch (error) {
        // 读不到凭证：无法确认锁归属，不能删（可能是别人的锁）。失败可见，不静默吞。
        lost = true
        return 'error'
      }
      if (current === null || current.token !== token) {
        lost = true
        return 'lost' // token 不符不删新持有者的锁
      }
      try {
        await rm(lockDir, { recursive: true, force: true })
        return 'ok'
      } catch (error) {
        // M2：删除失败被 `.catch(() => {})` 吞掉时，锁会残留到 TTL 之后才被接管，
        // 期间所有写者都在等一个已经没人持有的锁。现在如实返回 'error'（调用方可见）。
        return 'error'
      }
    },
  }
}

// —— 同进程串行 + 重入（W-01）——
const dirChains = new Map()
const reentry = new AsyncLocalStorage()
// R3-03b（2026-10-31 审计）：重入路径的 ownership 传递面。
// 旧实现给重入 body 一个**恒通过**的占位 context——可外层锁失锁（被接管/心跳失败）后，
// 嵌套写（store.forget → rebuildIndex、archiveForCommit → setState 等）拿到的仍是
// 「一切正常」，失锁对它们完全不可见。这里按目录登记真实 ownership 并沿异步上下文下传，
// 重入调用拿到的是**外层那把锁**的 ownership，失锁照样抛 ELOCK_LOST。
const ownerships = new AsyncLocalStorage()

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
    if (reentrant) return body(ownerships.getStore()?.get(dir) ?? reentrantOwnership())
    const lock = await acquireWriteLock(dir, options)
    // 事务期间必须**续约**：TTL 默认 60s，而一次回填批或索引重建可能更久。
    // 旧实现从不调用 heartbeat，`owner.heartbeatAt` 恒等于 acquiredAt——超过 TTL 的
    // 事务会被另一进程判定 stale 并接管，两个写者同时进临界区（且旧持有者不会停）。
    //
    // R3-03（2026-10-30）：间隔按实际 TTL 推导（不再固定按默认 60s）；续约**单飞**；
    // 心跳 lost（token 被换）/出错（owner 不可读等失败关闭场景）立即停表并记失锁，
    // 经 ownership.assertOwned() 暴露给 body——失锁后的后续提交失败关闭。
    // 边界：提交前检查与真正落盘之间仍有窗口，这不是硬性跨进程 fencing。
    const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
    let lost = null
    let renewing = false
    const renew = setInterval(() => {
      if (renewing || lost !== null) return // 单飞：上一次心跳未结算不重入；失锁即停
      renewing = true
      Promise.resolve()
        .then(() => lock.heartbeat())
        .then((result) => {
          renewing = false
          if (result === 'lost') {
            lost = { reason: 'lost' }
            clearInterval(renew)
          }
        })
        .catch((error) => {
          renewing = false
          lost = { reason: 'error', error }
          clearInterval(renew)
        })
    }, heartbeatIntervalOf(ttlMs))
    renew.unref?.()
    const ownership = {
      /** 失锁判据：heartbeat lost（被接管）或续约出错（失败关闭）。失锁即抛。 */
      assertOwned() {
        if (lost !== null) {
          throw v3Error('ELOCK_LOST', '写锁在事务期间丢失（' + lost.reason + '），失败关闭拒绝后续提交'
            + (lost.error?.message ? '：' + lost.error.message : ''))
        }
      },
      isLost: () => lost !== null,
    }
    try {
      const inherited = ownerships.getStore()
      return await ownerships.run(new Map([...(inherited ?? []), [dir, ownership]]), () => body(ownership))
    } finally {
      clearInterval(renew)
      await lock.release().catch(() => {})
    }
  })
}

/**
 * 重入路径的兜底占位：只有「外层用裸 withWriteLock 持锁、没有跨进程 ownership」时才会走到。
 * 有外层 ownership 时一律用真实那把（见 ownerships 的登记与下传）。
 */
function reentrantOwnership() {
  return { assertOwned() {}, isLost: () => false }
}