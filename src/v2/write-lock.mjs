/**
 * v2 会话写锁（0.11.0）：跨进程单写者租约。
 *
 * 背景：v0.10.1 的防并发只有**进程内**的 openDirectories 占位。两个 DSH 实例
 * （或一个实例 + 一个脚本）同时写同一个会话目录时，各自读到旧 revision 再追加，
 * 就是典型的 lost update：后写者覆盖前写者，且两边都以为成功。
 *
 * 设计：
 * - 独占锁用「目录创建」实现（mkdir 在 Windows/NTFS 与 POSIX 上都是原子的）；
 * - 锁内 owner.json 记录 pid/host/token/heartbeatAt；持有者每 15s 心跳续租；
 * - 接管：同主机 pid 不存在，或心跳超过 TTL（默认 60s）未更新，判为 stale；
 *   接管用 rename 到 tombstone 后再删除，避免两个接管者同时删同一把锁；
 * - 重入：同进程对同一目录再次 acquire 只增加引用计数（standalone 写入器常在
 *   一个已打开 store 的命令里被调用），最后一次 release 才真正删锁；
 * - 只读打开不取写锁：读取侧已经按「原子替换 + 三种读态」容忍并发写者。
 *
 * 明确不提供的保证：锁保护的是**每次写入**，不是整条命令的事务。跨文件的
 * read-modify-write 仍由各层自己的 revision CAS / fail-closed 兜底；这是有意的
 * 边界——把整条命令锁住会把宿主 UI 的读路径一起拖慢，且锁持有时间不可控。
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { readFileSync, rmSync } from 'node:fs'
import { hostname as osHostname } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

import { EngineV2Error } from './errors.mjs'

export const WRITE_LOCK_DIRECTORY = '.write-lock'
export const WRITE_LOCK_OWNER_FILE = 'owner.json'
export const WRITE_LOCK_KIND = 'dsh-memory-context-lab/v2/write-lock'
export const WRITE_LOCK_TTL_MS = 60_000
export const WRITE_LOCK_HEARTBEAT_MS = 15_000

/** 同进程、同目录的租约表：目录绝对路径 → 共享条目。 */
const heldLocks = new Map()

export function writeLockDirectoryFor(sessionDir) {
  return path.join(path.resolve(sessionDir), WRITE_LOCK_DIRECTORY)
}

function ownerPathOf(lockDir) {
  return path.join(lockDir, WRITE_LOCK_OWNER_FILE)
}

async function readOwner(lockDir) {
  let text
  try {
    text = await readFile(ownerPathOf(lockDir), 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    return { unreadable: true, error: error?.code ?? 'read' }
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return { unreadable: true, error: 'parse' }
  }
  if (parsed?.kind !== WRITE_LOCK_KIND || typeof parsed.token !== 'string') {
    return { unreadable: true, error: 'schema' }
  }
  return parsed
}

async function writeOwner(lockDir, owner) {
  const file = ownerPathOf(lockDir)
  const temp = `${file}.${randomUUID()}.tmp`
  await writeFile(temp, `${JSON.stringify(owner, null, 2)}\n`, 'utf8')
  await rename(temp, file)
}

function processAlive(pid, host) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  if (typeof host === 'string' && host.length > 0 && host !== osHostname()) {
    // 远端主机的 pid 无法在本机判定，只能靠心跳过期；保守认为活着。
    return true
  }
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

function heartbeatAge(owner, now) {
  const beat = Number(owner?.heartbeatAt)
  return Number.isFinite(beat) ? now - beat : Number.POSITIVE_INFINITY
}

/** 判定一把锁是否应当被接管；导出给测试与诊断复用。 */
export function isWriteLockStale(owner, { now = Date.now(), ttlMs = WRITE_LOCK_TTL_MS } = {}) {
  if (!owner || owner.unreadable) return true
  if (heartbeatAge(owner, now) > ttlMs) return true
  if (!processAlive(Number(owner.pid), owner.host)) return true
  return false
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function takeOver(lockDir) {
  const tomb = `${lockDir}.stale.${randomUUID()}`
  try {
    await rename(lockDir, tomb)
  } catch (error) {
    // 另一个接管者先赢了：让外层重试即可。
    if (error?.code === 'ENOENT') return
    throw new EngineV2Error(`写锁接管失败：${error.message}`, { code: 'ELOCKIO', details: { lockDir } })
  }
  await rm(tomb, { recursive: true, force: true }).catch(() => {})
}

function releaseEntry(directory, entry) {
  entry.refs -= 1
  if (entry.refs > 0) return false
  heldLocks.delete(directory)
  if (entry.timer) clearInterval(entry.timer)
  // 只在 token 仍然属于自己时删锁：stale 接管后不得误删新持有者的锁。
  // 同步删除是刻意的：close() 是同步契约；异步 release 会让「关闭后目录里还
  // 留着 .write-lock」成为可观察的瞬态（只读副作用测试会判红）。
  try {
    const owner = JSON.parse(readFileSync(path.join(entry.lockDir, WRITE_LOCK_OWNER_FILE), 'utf8'))
    if (owner?.token !== entry.token) return false
    rmSync(entry.lockDir, { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}

/**
 * 取得会话写锁。返回的 handle 只暴露 release()；release 可重复调用。
 *
 * 失败关闭：抢不到锁抛 ELOCKED（带持有者信息），绝不「先写再说」。
 */
export async function acquireWriteLock(sessionDir, {
  pid = process.pid,
  host = osHostname(),
  now = () => Date.now(),
  ttlMs = WRITE_LOCK_TTL_MS,
  heartbeatMs = WRITE_LOCK_HEARTBEAT_MS,
  waitMs = 500,
} = {}) {
  const directory = path.resolve(sessionDir)
  const existing = heldLocks.get(directory)
  if (existing) {
    existing.refs += 1
    let released = false
    return {
      lockDir: existing.lockDir,
      token: existing.token,
      reentrant: true,
      release() {
        if (released) return false
        released = true
        return releaseEntry(directory, existing)
      },
    }
  }

  const lockDir = writeLockDirectoryFor(directory)
  await mkdir(directory, { recursive: true })
  const deadline = now() + Math.max(0, waitMs)
  let attempt = 0
  while (true) {
    attempt += 1
    try {
      await mkdir(lockDir)
      const owner = {
        kind: WRITE_LOCK_KIND,
        token: randomUUID(),
        pid,
        host,
        acquiredAt: new Date(now()).toISOString(),
        heartbeatAt: now(),
      }
      await writeOwner(lockDir, owner)
      const entry = { lockDir, token: owner.token, refs: 1, timer: null, owner }
      // 心跳失败不抛给业务：锁可能已被接管，下一次写入会因 token 不符而暴露；
      // 这里只负责续租，不让 interval 的 rejection 变成 unhandledRejection。
      entry.timer = setInterval(() => {
        writeOwner(lockDir, { ...entry.owner, heartbeatAt: now() }).catch(() => {})
      }, Math.max(50, heartbeatMs))
      entry.timer.unref?.()
      heldLocks.set(directory, entry)
      let released = false
      return {
        lockDir,
        token: entry.token,
        reentrant: false,
        release() {
          if (released) return false
          released = true
          return releaseEntry(directory, entry)
        },
      }
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        throw new EngineV2Error(`写锁创建失败：${error.message}`, { code: 'ELOCKIO', details: { lockDir } })
      }
      const owner = await readOwner(lockDir)
      if (owner?.unreadable) {
        // 可能是持有者刚建目录、还没写 owner 的窗口；给一个很短的宽限再判。
        await sleep(40)
        const again = await readOwner(lockDir)
        if (again?.unreadable) {
          await takeOver(lockDir)
          continue
        }
      }
      const current = owner?.unreadable ? await readOwner(lockDir) : owner
      if (isWriteLockStale(current, { now: now(), ttlMs })) {
        await takeOver(lockDir)
        continue
      }
      if (now() < deadline) {
        await sleep(Math.min(50, Math.max(0, deadline - now())))
        continue
      }
      throw new EngineV2Error(
        `会话写锁被占用（pid ${current?.pid ?? '?'}，host ${current?.host ?? '?'}，心跳 ${heartbeatAge(current, now())}ms 前）；拒绝并发写入`,
        { code: 'ELOCKED', details: { lockDir, owner: current } },
      )
    }
  }
}

/** 在会话写锁内执行一次写入（重入安全）。 */
export async function withWriteLock(sessionDir, run) {
  const handle = await acquireWriteLock(sessionDir)
  try {
    return await run()
  } finally {
    handle.release()
  }
}

/** 只读诊断：当前锁的持有者（没有锁返回 null）。 */
export async function readWriteLockOwner(sessionDir) {
  return readOwner(writeLockDirectoryFor(sessionDir))
}
