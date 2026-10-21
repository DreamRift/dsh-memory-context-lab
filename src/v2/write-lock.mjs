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

import { AsyncLocalStorage } from 'node:async_hooks'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
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
/**
 * 「锁目录在、owner.json 不在」的宽限窗口（0.13.2 D-05）。
 *
 * 两阶段创建（写进临时目录再 rename 成锁目录）之后，这个状态只可能来自**旧版本**
 * 的崩溃残留，所以宽限按「锁目录已经存在多久」算，超过它就按 stale 接管——既不误
 * 接管一个正在落凭证的活持有者，也不会被一条空目录永久卡住。
 */
export const WRITE_LOCK_CREATION_GRACE_MS = 1_500

/** 同进程、同目录的租约表：目录绝对路径 → 共享条目。 */
const heldLocks = new Map()

/**
 * 正在获取中的锁：目录绝对路径 → 获取 Promise。
 *
 * 只用于**同进程并发**排队（见 `acquireWriteLock`）。跨进程竞争仍靠锁目录本身。
 */
const acquiringLocks = new Map()

/**
 * 同进程**持有**链：目录绝对路径 → 链尾 Promise（0.13.2-beta.2 W-01）。
 *
 * issue #9 的同进程那一半：`acquiringLocks` 只排「获取」不排「持有」，后来者在
 * 前一个 `withWriteLock` 的回调执行期间就拿到了重入句柄，两个 async 分支同时
 * 处于临界区。这里把「持有」也串起来：每个 `withWriteLock` 先排队等前一个
 * **回调执行完**，再进入临界区。
 *
 * 只用于 `withWriteLock`；`acquireWriteLock` 的重入语义（store 打开期间长期持锁、
 * 命令内再次取锁只加引用计数）保持不变——那是租约，不是互斥。
 */
const processChains = new Map()

/**
 * 当前 async 调用链上已持有的锁帧（0.13.2-beta.2 W-01）。
 *
 * 「串行化」与「重入」只能靠**调用栈**区分：`applyForgetUnlocked` → `loadDisposition`
 * → `repairLedgerTail` 这类真实嵌套如果也去排队，就会等自己已经持有的链尾——自锁。
 * 所以用 AsyncLocalStorage 记住「本调用链已经在哪些目录的临界区里」，内层直接执行。
 *
 * 帧带 `active` 标志：锁结束（含抛错）时置 false。于是锁内 `void asyncFn()` 起、
 * 锁结束后才运行的游离任务不会凭过期上下文绕过排队——它看到的帧已失效，回到正常
 * 路径。锁内并发运行的游离任务仍算重入，这是不引入任务跟踪就无法区分的边界。
 */
const lockFrames = new AsyncLocalStorage()

/** 当前调用链是否已持有该目录的临界区（且那个锁帧仍然活着）。 */
function insideHeldLock(directory) {
  const frames = lockFrames.getStore()?.frames
  if (!Array.isArray(frames)) return false
  for (let index = frames.length - 1; index >= 0; index -= 1) {
    const frame = frames[index]
    if (frame?.directory === directory && frame.active === true) return true
  }
  return false
}

export function writeLockDirectoryFor(sessionDir) {
  return path.join(path.resolve(sessionDir), WRITE_LOCK_DIRECTORY)
}

function ownerPathOf(lockDir) {
  return path.join(lockDir, WRITE_LOCK_OWNER_FILE)
}

/**
 * 读持有者凭证。
 *
 * `ENOENT` **不再**返回 `null`：目录在而 owner.json 不在，正是「持有者刚建目录、还没
 * 把凭证 rename 落盘」的窗口（0.13.2 D-05）。旧实现把 `null` 直接判成 stale 并立即
 * 接管，于是两个写者同时持锁（`store` 的 lost update 就是这把锁唯一要防的事）。
 * 现在一律返回 `unreadable`，由 `acquireWriteLock` 按「锁目录已存在多久」决定是宽限
 * 还是接管；`readWriteLockOwner` 这种只读诊断仍把缺失映射回 `null`。
 */
async function readOwner(lockDir) {
  let text
  try {
    text = await readFile(ownerPathOf(lockDir), 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return { unreadable: true, error: 'missing' }
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

/**
 * 两阶段建锁：先在临时目录里写好 owner.json，再 rename 成锁目录（0.13.2 D-05）。
 *
 * 单靠 `mkdir(lockDir)` 认领，会留下「目录已存在、凭证还没落盘」的窗口；别人此刻
 * 撞 `EEXIST`，读到没有 owner 就判 stale 并接管——两个写者同时持锁。rename 让
 * 「锁目录出现」与「凭证就位」成为同一个原子动作，这个窗口从根上不存在。
 *
 * 撞已有目录（`EEXIST`/`ENOTEMPTY`/`EPERM`/`EBUSY`/`EACCES`）一律原样抛出，由外层
 * 走竞争分支。返回 `null` 表示没拿到锁。
 */
async function createLockDirectory(lockDir, { pid, host, now }) {
  const owner = {
    kind: WRITE_LOCK_KIND,
    token: randomUUID(),
    pid,
    host,
    acquiredAt: new Date(now()).toISOString(),
    heartbeatAt: now(),
  }
  const stage = `${lockDir}.${owner.token}.tmp`
  await mkdir(stage, { recursive: true })
  try {
    await writeFile(path.join(stage, WRITE_LOCK_OWNER_FILE), `${JSON.stringify(owner, null, 2)}\n`, 'utf8')
    await rename(stage, lockDir)
  } catch (error) {
    await rm(stage, { recursive: true, force: true }).catch(() => {})
    throw error
  }
  // 自检：目录里现在必须还是自己的凭证（旧版本持有者可能刚好把 owner.json 写进
  // 它自己那个空目录）。不符就按「竞争失败」处理，绝不带着别人的锁继续写。
  const check = await readOwner(lockDir)
  if (!check || check.unreadable || check.token !== owner.token) {
    throw new EngineV2Error('写锁创建后自检失败：目录里的凭证不属于本持有者', { code: 'EEXIST', details: { lockDir } })
  }
  return { owner, token: owner.token }
}

/**
 * 心跳续租：**先读回校验 token**，不符即认定租约已丢失并停表（0.13.2 D-06）。
 *
 * 旧实现闭包捕获 owner 后按路径盲写，被接管者的心跳会把新持有者的凭证覆盖掉：
 * 新持有者 release() 因 token 不符静默失效，锁目录永久残留。
 */
async function renewHeartbeat(lockDir, entry, now) {
  if (entry.lost) return
  const current = await readOwner(lockDir)
  if (!current || current.unreadable || current.token !== entry.token) {
    entry.lost = true
    if (entry.timer) {
      clearInterval(entry.timer)
      entry.timer = null
    }
    return
  }
  try {
    await writeOwner(lockDir, { ...entry.owner, heartbeatAt: now() })
  } catch {
    // 瞬态写失败：下一次心跳再试；不把 rejection 变成 unhandledRejection。
  }
}

/** Windows 上目录 rename 会被「有打开句柄 / 杀软扫描 / 另一进程 readdir」打成瞬态错误。 */
const TRANSIENT_IO_CODES = new Set(['ENOENT', 'EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY', 'EEXIST'])

/** 判「别人先赢了」的错误码：两阶段创建的 rename 撞上已有锁目录就是这些。 */
const CONTENDED_CODES = new Set(['EEXIST', 'ENOTEMPTY', 'EPERM', 'EBUSY', 'EACCES'])

/**
 * 接管一把 stale 锁。返回**是否真的接管成功**（0.13.2-beta.2 W-02）。
 *
 * 瞬态错误（`ENOENT`/`EPERM`/`EBUSY`/`EACCES`/`ENOTEMPTY`）一律**不抛**，交给外层
 * 重试：Windows 上「目录里有打开的句柄」「杀软在扫」「另一进程在 readdir」
 * 都会让目录 rename 返回 EPERM/EBUSY，而这恰恰是并发抢锁时的常态（0.13.2 D-10）。
 * 旧实现把这类瞬态打成 `ELOCKIO`（读起来像数据损坏），`store.open()` 在真机上
 * 因此从「可重试」变成「硬失败」。
 *
 * 但「静默 return」只对了一半：调用方 `continue` 回循环头会立刻读到同一把 stale 锁，
 * 于是持续失败 = 纯微任务空转，不返回、不抛错、CPU 打满，连 `AbortSignal` 都插不进去。
 * 所以这里必须如实返回 boolean，由调用方按 deadline 退避（见 retryAfterFailedTakeOver）。
 *
 * `io` 是**测试注入缝**（与 `now` 同风格）：只允许覆盖 `rename`，生产调用不传。
 * 没有它就无法在测试里稳定制造「rename 持续 EPERM」——那正是本缺陷的触发条件。
 */
async function takeOver(lockDir, io = null) {
  const tomb = `${lockDir}.stale.${randomUUID()}`
  const doRename = typeof io?.rename === 'function' ? io.rename : rename
  try {
    await doRename(lockDir, tomb)
  } catch (error) {
    if (TRANSIENT_IO_CODES.has(error?.code)) return false
    throw new EngineV2Error(`写锁接管失败：${error.message}`, { code: 'ELOCKIO', details: { lockDir } })
  }
  await rm(tomb, { recursive: true, force: true }).catch(() => {})
  return true
}

/**
 * 接管失败后的退避：先查 deadline，再睡一小段（0.13.2-beta.2 W-02）。
 *
 * 两个接管分支（stale 锁、超宽限的空锁目录）共用。失败关闭的语义不变：用尽
 * `waitMs` 一律 `ELOCKED`（可重试），**不是** `ELOCKIO`（那读起来像数据损坏）。
 */
async function retryAfterFailedTakeOver({ lockDir, now, deadline, owner }) {
  if (now() >= deadline) {
    throw new EngineV2Error(
      '写锁接管持续失败（锁目录无法 rename：可能有打开的句柄、杀软扫描或另一进程在读目录）；拒绝继续等待',
      { code: 'ELOCKED', details: { lockDir, owner, reason: 'takeover-failed' } },
    )
  }
  await sleep(Math.min(50, Math.max(1, deadline - now())))
}

/**
 * 清扫崩溃残留的建锁中间物（0.13.2-beta.2 W-03）。
 *
 * 两阶段建锁先 `mkdir(`${lockDir}.${token}.tmp`)` 再 rename；进程在两者之间崩溃，
 * 那个临时目录就永久留在会话根下（不阻塞加锁，但会一直堆）。接管用的
 * `${lockDir}.stale.*` 墓碑同理：rm 失败即留。
 *
 * 判据是「**早于本次获取开始时刻**」，不是年龄宽限：崩溃残留完全可能与本次获取同刻
 * 出现（探针 audit/a 就是这么造的），按年龄会漏。反过来，一个在本次获取开始之后才
 * 出现的 stage 属于**正在建锁的竞争者**，不归本次清扫——即使真被误删，它的 rename
 * 也只会得到 ENOENT（瞬态）→ 重试，不会引入新的失败模式。
 *
 * 只在**已经拿到锁**之后调用，且全程尽力而为：清扫失败绝不影响加锁本身。
 */
async function sweepLockDebris(lockDir, { beforeMs } = {}) {
  if (!Number.isFinite(beforeMs)) return { removed: 0 }
  const parent = path.dirname(lockDir)
  const base = path.basename(lockDir)
  let names
  try {
    names = await readdir(parent)
  } catch {
    return { removed: 0 }
  }
  let removed = 0
  for (const name of names) {
    if (!name.startsWith(`${base}.`)) continue
    const suffix = name.slice(base.length + 1)
    const isStage = suffix.endsWith('.tmp')
    const isTombstone = suffix.startsWith('stale.')
    if (!isStage && !isTombstone) continue
    const target = path.join(parent, name)
    let info
    try {
      info = await stat(target)
    } catch {
      continue // 竞争者刚删掉它：不是错误
    }
    if (!(info.mtimeMs <= beforeMs)) continue
    try {
      await rm(target, { recursive: true, force: true })
      removed += 1
    } catch {
      // 尽力而为：删不掉就留给下一次
    }
  }
  return { removed }
}

/** 锁目录已存在多久（毫秒）；读不到按 0 处理（当作刚建，宁可宽限也不误接管）。 */
async function lockDirectoryAge(lockDir, now) {
  try {
    const info = await stat(lockDir)
    return Math.max(0, now - info.mtimeMs)
  } catch {
    return 0
  }
}

function releaseEntry(directory, entry) {
  entry.refs -= 1
  if (entry.refs > 0) return false
  heldLocks.delete(directory)
  if (entry.timer) clearInterval(entry.timer)
  entry.timer = null
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
  creationGraceMs = WRITE_LOCK_CREATION_GRACE_MS,
  io = null,
} = {}) {
  const directory = path.resolve(sessionDir)
  const existing = heldLocks.get(directory)
  if (existing) return reentrantHandle(directory, existing)

  // 同进程**并发**获取（两个 async 分支同时要同一把锁）必须排队，不能报 ELOCKED。
  //
  // `heldLocks` 的登记发生在第一次 await 之后，所以两个并发调用会双双走到竞争分支；
  // 而竞争者读到的 owner.json 正是**自己进程**刚写下的凭证（pid 活着、心跳新鲜），
  // 于是既不能接管也不能重入，只能等到 deadline 抛 ELOCKED——写路径在自己的进程里
  // 自锁。旧实现之所以看起来没这个问题，是因为它把「目录在、凭证还没落盘」判成 stale
  // 直接接管（D-05），那个缺陷恰好掩盖了这一处。这里显式排队：后来者等前一个拿到锁，
  // 再以重入语义加入（引用计数 +1），release 语义与同线程重入完全一致。
  const pendingAcquire = acquiringLocks.get(directory)
  if (pendingAcquire) {
    await pendingAcquire.catch(() => {})
    const held = heldLocks.get(directory)
    if (held) return reentrantHandle(directory, held)
    // 前一个获取失败或已经释放：继续走正常竞争。
  }
  const attempt = acquireLockDirectory(directory, { pid, host, now, ttlMs, heartbeatMs, waitMs, creationGraceMs, io })
  acquiringLocks.set(directory, attempt)
  try {
    return await attempt
  } finally {
    if (acquiringLocks.get(directory) === attempt) acquiringLocks.delete(directory)
  }
}

/** 同进程重入句柄：只加引用计数，最后一次 release 才真正删锁。 */
function reentrantHandle(directory, entry) {
  entry.refs += 1
  let released = false
  return {
    lockDir: entry.lockDir,
    token: entry.token,
    reentrant: true,
    lost() { return entry.lost === true },
    release() {
      if (released) return false
      released = true
      return releaseEntry(directory, entry)
    },
  }
}

async function acquireLockDirectory(directory, { pid, host, now, ttlMs, heartbeatMs, waitMs, creationGraceMs, io = null }) {
  const lockDir = writeLockDirectoryFor(directory)
  await mkdir(directory, { recursive: true })
  // 清扫判据的基准：本次获取**开始**的时刻。在此之前出现的 stage/墓碑一定是残留。
  const acquisitionStartedAt = now()
  const deadline = acquisitionStartedAt + Math.max(0, waitMs)
  while (true) {
    let created = null
    try {
      created = await createLockDirectory(lockDir, { pid, host, now })
    } catch (error) {
      // 两类失败必须分开：
      //  - 竞争类（EEXIST/ENOTEMPTY，以及 Windows 上「目标目录已存在」统一报的
      //    EPERM/EBUSY/EACCES）→ 落到下面的竞争分支，按持有者是否 stale 决定接管
      //    或 ELOCKED；
      //  - 真瞬态 IO（ENOENT：父目录还没建好）→ deadline 内重试；
      //  - 其余 → ELOCKIO（真正的 IO 异常）。
      if (!CONTENDED_CODES.has(error?.code) && !TRANSIENT_IO_CODES.has(error?.code)) {
        throw new EngineV2Error(`写锁创建失败：${error.message}`, { code: 'ELOCKIO', details: { lockDir } })
      }
      if (TRANSIENT_IO_CODES.has(error?.code) && !CONTENDED_CODES.has(error?.code) && now() < deadline) {
        await sleep(Math.min(50, Math.max(0, deadline - now())))
        continue
      }
    }
    if (created) {
      // 已经拿到锁：顺手清掉崩溃残留的建锁中间物（W-03）。失败不影响加锁。
      await sweepLockDebris(lockDir, { beforeMs: acquisitionStartedAt }).catch(() => {})
      const entry = { lockDir, token: created.token, refs: 1, timer: null, owner: created.owner, lost: false }
      // 心跳只续**自己的**租约：锁被接管后 lockDir 已属于别人，按路径盲写会把自己的
      // 旧凭证覆盖到新持有者头上（0.13.2 D-06）——新持有者的 release() 变成空操作、
      // 锁目录永久残留、第三个写者一路 ELOCKED。所以写之前先读回校验 token。
      // 心跳失败不抛给业务：丢失只标记，下一次写入会因 token 不符而暴露。
      entry.timer = setInterval(() => {
        void renewHeartbeat(lockDir, entry, now)
      }, Math.max(50, heartbeatMs))
      entry.timer.unref?.()
      heldLocks.set(directory, entry)
      let released = false
      return {
        lockDir,
        token: entry.token,
        reentrant: false,
        /** 只读诊断：本句柄是否已被别人接管（心跳自检失败即 true）。 */
        lost() { return entry.lost === true },
        release() {
          if (released) return false
          released = true
          return releaseEntry(directory, entry)
        },
      }
    }

    // ── 抢锁失败：判「谁在里面」─────────────────────────────────────────────
    const current = await readOwner(lockDir)
    if (current?.unreadable) {
      // 目录在、凭证不在：可能是活持有者的创建窗口（旧版本才会出现），也可能是
      // 崩溃残留。按锁目录年龄判：够老才接管，否则宽限等待，绝不当场抢。
      const age = await lockDirectoryAge(lockDir, now())
      if (age > creationGraceMs) {
        // 接管失败要退避并重查 deadline：否则同一条空目录会把调用方永久挂住
        // （与下面 stale 分支同一处理方式，W-02）。
        if (!(await takeOver(lockDir, io))) {
          await retryAfterFailedTakeOver({ lockDir, now, deadline, owner: current })
        }
        continue
      }
      if (now() < deadline) {
        await sleep(Math.min(50, Math.max(0, deadline - now())))
        continue
      }
      throw new EngineV2Error(
        `会话写锁正在建立中（锁目录已存在 ${Math.round(age)}ms，owner.json 尚未落盘）；拒绝并发写入`,
        { code: 'ELOCKED', details: { lockDir, owner: current } },
      )
    }
    if (isWriteLockStale(current, { now: now(), ttlMs })) {
      if (!(await takeOver(lockDir, io))) {
        await retryAfterFailedTakeOver({ lockDir, now, deadline, owner: current })
      }
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

/**
 * 在会话写锁内执行一次写入。
 *
 * 0.13.2-beta.2（W-01）：同进程**并发**必须串行，不是重入放行。
 *
 * 旧实现直接 `acquireWriteLock`，而它在同进程里是引用计数式的重入：两个 async
 * 分支同时进来，第二个拿到的仍是同一把锁的第二个句柄——两个分支同时在临界区，
 * 于是「读账本 → 算序号/版本 → 写回」互相覆盖。层级账本实测写出两条
 * `entrySeq: 1` 并都向调用方报 `revision: 1`，`expectedRevision` 的 CAS 保护
 * 同时失效（issue #9 同进程那一半）。
 *
 * 现在按目录串行：后来者等前一个**回调执行完**才进入临界区。同调用栈的嵌套调用
 * （`applyForgetUnlocked` → `loadDisposition` → `repairLedgerTail` 这类真实形态）
 * 直接执行，不排队——它本来就在同一个临界区里，再排队就是等自己。
 *
 * 跨进程那一半不动：锁目录、心跳、接管、释放语义逐字保持，本函数只是把
 * 「同进程谁先谁后」排好序。
 *
 * `options` 原样透传给 `acquireWriteLock`（`now`/`waitMs`/`io` 供测试注入），
 * 生产调用不传。
 */
export async function withWriteLock(sessionDir, run, options = {}) {
  const directory = path.resolve(sessionDir)
  // 已经在同一个临界区里（同一 async 调用链）：直接执行，绝不二次排队。
  if (insideHeldLock(directory)) return run()

  const previous = processChains.get(directory) ?? Promise.resolve()
  let openGate
  const gate = new Promise((resolve) => { openGate = resolve })
  // 链尾 = 「前一个回调执行完」→「本帧放行」。登记必须发生在第一个 await 之前，
  // 否则两个并发调用会双双读到同一个 previous，又变回并排执行。
  const tail = previous.catch(() => {}).then(() => gate)
  processChains.set(directory, tail)
  await previous.catch(() => {})

  const parent = lockFrames.getStore()
  const frame = { directory, active: true }
  const frames = [...(parent?.frames ?? []), frame]
  try {
    return await lockFrames.run({ frames }, async () => {
      const handle = await acquireWriteLock(directory, options)
      try {
        return await run()
      } finally {
        handle.release()
      }
    })
  } finally {
    // 顺序不能反：先让帧失效，再放行后来者。反了的话，后来者可能看到仍 active
    // 的旧帧，把「排队」误判成「重入」。
    frame.active = false
    openGate()
    if (processChains.get(directory) === tail) processChains.delete(directory)
  }
}

/** 只读诊断：当前锁的持有者（没有锁返回 null）。 */
export async function readWriteLockOwner(sessionDir) {
  const owner = await readOwner(writeLockDirectoryFor(sessionDir))
  // 诊断口语义不变：没有锁（或凭证缺失/不可读）一律 null，不外泄内部标记。
  return owner?.unreadable ? null : owner
}
