import { createHash } from 'node:crypto'
import { mkdir, open, readFile, readdir, lstat, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  isSessionDirectoryName,
  isStrictDescendant,
  LAB_ROOT_MARKER_FILE,
  LAB_ROOT_MARKER_KIND,
  LAB_ROOT_NAME,
  SCHEMA_VERSION,
  SESSIONS_DIRECTORY,
  STATE_FILE,
  STATE_KIND,
} from './core.mjs'

export function defaultDshHome(env = process.env) {
  const configured = typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : ''
  return configured ? path.resolve(configured) : path.join(homedir(), '.dsh')
}

export function labRootFor(env = process.env) {
  return path.join(defaultDshHome(env), LAB_ROOT_NAME)
}

export function sessionsRootFor(labRoot) {
  return path.join(path.resolve(labRoot), SESSIONS_DIRECTORY)
}

/** Stable, filesystem-safe directory name for one session id. */
export function sessionKeyFor(sessionId) {
  return createHash('sha256').update(String(sessionId), 'utf8').digest('hex').slice(0, 24)
}

export function sessionDirectoryFor(labRoot, sessionId) {
  return path.join(sessionsRootFor(labRoot), sessionKeyFor(sessionId))
}

function rootMarker() {
  return {
    kind: LAB_ROOT_MARKER_KIND,
    schemaVersion: SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
  }
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return null
  }
}

/**
 * Read a JSON file distinguishing "absent" from "present but unreadable"
 * (C-11). Returns null only for a missing file; a parse failure or a read
 * failure (permissions, IO) throws with `code: 'EDAMAGED'` so callers can fail
 * closed instead of mistaking damage for "never enabled".
 */
export async function readJsonStrict(file) {
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    const wrapped = new Error(`状态文件不可读：${error instanceof Error ? error.message : String(error)}`)
    wrapped.code = 'EDAMAGED'
    throw wrapped
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    const wrapped = new Error(`状态文件不是有效的 JSON：${error instanceof Error ? error.message : String(error)}`)
    wrapped.code = 'EDAMAGED'
    throw wrapped
  }
}

/** Thrown when a session's state file exists but cannot be trusted (C-11). */
export class SessionStateDamagedError extends Error {
  constructor(message, { directory, reason }) {
    super(message)
    this.name = 'SessionStateDamagedError'
    this.directory = directory
    this.reason = reason
  }
}

/**
 * Flush a directory entry so a completed rename survives a crash.
 *
 * The rename itself is atomic for the NAME; making the new name durable needs
 * the directory synced too. Windows cannot open a directory for reading, so
 * there it is a deliberate no-op rather than a failure.
 */
async function syncDirectory(directory) {
  if (process.platform === 'win32') return
  let handle
  try {
    handle = await open(directory, 'r')
    await handle.sync()
  } catch {
    // Directory fsync is unavailable on some filesystems; the write is still
    // atomic, only the post-crash durability of the new name is weaker.
  } finally {
    await handle?.close().catch(() => {})
  }
}

export async function writeJsonAtomic(file, value) {
  const parent = path.dirname(file)
  await mkdir(parent, { recursive: true })
  const temp = path.join(parent, `.${path.basename(file)}.${randomUUID()}.tmp`)
  try {
    const handle = await open(temp, 'w')
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
      // rename() is atomic for the NAME, not for the bytes. Without this sync a
      // crash right after the rename can leave an empty or half-written file
      // where the previous state used to be -- and that state is already gone.
      // Flushing before the rename is what makes the swap safe.
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temp, file)
    await syncDirectory(parent)
  } finally {
    await rm(temp, { force: true }).catch(() => {})
  }
}

/**
 * Read the lab-root marker, distinguishing absent from damaged.
 *
 * The lenient reader returned null for BOTH, and every caller read null as
 * "this root was never initialised" -- so a marker whose bytes were damaged was
 * silently overwritten by ensureLabRoot, and a session under it was reported as
 * never enabled. That is the same mistake C-11 already fixed one level down for
 * the session state file, and it is worse here: the root marker is what makes
 * the archive directories ours.
 *
 * @returns the marker, or null only when the file is genuinely absent.
 * @throws {Error} with code 'EDAMAGED' when present but unreadable/invalid.
 */
async function readLabRootMarker(root) {
  const file = path.join(root, LAB_ROOT_MARKER_FILE)
  let marker
  try {
    marker = await readJsonStrict(file)
  } catch (error) {
    if (error?.code === 'EDAMAGED') {
      const wrapped = new Error(
        `上下文降温根目录的标记文件已损坏，无法判断历史归档事实（${error.message}）。不会将其当作「从未启用」，也不会覆盖它。`,
      )
      wrapped.code = 'EDAMAGED'
      throw wrapped
    }
    throw error
  }
  if (marker === null) return null
  if (marker.kind !== LAB_ROOT_MARKER_KIND || marker.schemaVersion !== SCHEMA_VERSION) {
    const wrapped = new Error('上下文降温根目录的标记无效（kind/schema 不匹配），已拒绝读取。')
    wrapped.code = 'EDAMAGED'
    throw wrapped
  }
  return marker
}

export async function ensureLabRoot(labRoot) {
  const root = path.resolve(labRoot)
  await mkdir(root, { recursive: true })
  const markerPath = path.join(root, LAB_ROOT_MARKER_FILE)
  const current = await readLabRootMarker(root)
  if (current === null) await writeJsonAtomic(markerPath, rootMarker())
  await mkdir(sessionsRootFor(root), { recursive: true })
  return root
}

export function isSessionState(value) {
  return !!value
    && typeof value === 'object'
    && value.kind === STATE_KIND
    && value.schemaVersion === SCHEMA_VERSION
    && typeof value.sessionId === 'string'
}

/** Create the per-session directory and return its state skeleton. */
export async function createSessionState(labRoot, sessionId, settings) {
  const root = await ensureLabRoot(labRoot)
  const directory = sessionDirectoryFor(root, sessionId)
  await mkdir(directory, { recursive: true })
  const state = {
    kind: STATE_KIND,
    schemaVersion: SCHEMA_VERSION,
    sessionId,
    key: sessionKeyFor(sessionId),
    createdAt: new Date().toISOString(),
    enabled: true,
    settings,
    archive: [],
  }
  await writeJsonAtomic(path.join(directory, STATE_FILE), state)
  return { directory, state }
}

/**
 * Read the durable state for one session, or null when it was never enabled.
 *
 * A present-but-invalid state file (broken JSON, wrong kind/schema, foreign
 * session id) throws {@link SessionStateDamagedError} instead of returning
 * null: callers must not treat damage as "never enabled", or an `on` would
 * silently overwrite the archive ledger that receipts still depend on (C-11).
 */
export async function readSessionState(labRoot, sessionId) {
  const root = path.resolve(labRoot)
  let marker
  try {
    marker = await readLabRootMarker(root)
  } catch (error) {
    // A damaged root marker makes this session's archive facts unknowable, so
    // it is reported as session damage rather than as never-enabled: an enable
    // command must not treat it as a fresh session and overwrite the ledger.
    if (error?.code === 'EDAMAGED') {
      throw new SessionStateDamagedError(
        `上下文降温根目录的标记文件已损坏，无法判断本会话的归档事实（${error.message}）。`,
        { directory: root, reason: error.message },
      )
    }
    throw error
  }
  if (marker === null) return null
  const directory = sessionDirectoryFor(root, sessionId)
  let state
  try {
    state = await readJsonStrict(path.join(directory, STATE_FILE))
  } catch (error) {
    if (error?.code === 'EDAMAGED') {
      throw new SessionStateDamagedError(
        `本会话的降温状态文件已损坏，无法判断历史归档事实（${error.message}）。不会将其当作「从未启用」，也不会覆盖它。`,
        { directory, reason: error.message },
      )
    }
    throw error
  }
  if (state !== null && (!isSessionState(state) || state.sessionId !== sessionId)) {
    throw new SessionStateDamagedError(
      '本会话的降温状态文件内容无效（kind/schema/sessionId 不匹配），已拒绝读取。',
      { directory, reason: 'invalid-state' },
    )
  }
  if (state === null) return null
  return { directory, state }
}

export async function writeSessionState(directory, state) {
  if (!isSessionState(state)) throw new Error('拒绝写入无效的会话状态文件。')
  await writeJsonAtomic(path.join(directory, STATE_FILE), state)
}

async function assertNoLinks(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    const child = path.join(directory, entry.name)
    const stat = await lstat(child)
    if (stat.isSymbolicLink()) throw new Error(`拒绝删除含链接的会话目录：${entry.name}`)
    if (stat.isDirectory()) await assertNoLinks(child)
  }
}

async function assertOwnedSessionDirectory(labRoot, directory) {
  const root = path.resolve(labRoot)
  const sessions = sessionsRootFor(root)
  const candidate = path.resolve(directory)
  if (path.dirname(candidate) !== path.resolve(sessions) || !isStrictDescendant(sessions, candidate)) {
    throw new Error('拒绝删除会话根目录之外的路径。')
  }
  if (!isSessionDirectoryName(path.basename(candidate))) {
    throw new Error('拒绝删除未按本插件格式生成的目录。')
  }
  const rootReal = await realpath(root)
  const candidateReal = await realpath(candidate)
  if (!isStrictDescendant(rootReal, candidateReal)) {
    throw new Error('拒绝删除解析后脱离降温根目录的路径。')
  }
  const stat = await lstat(candidate)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('拒绝删除非普通会话目录。')
  await assertNoLinks(candidate)
}

/** Remove only a generated, marker-owned session directory. */
export async function removeSessionDirectory(labRoot, directory) {
  await assertOwnedSessionDirectory(labRoot, directory)
  await rm(directory, { recursive: true, force: false, maxRetries: 3, retryDelay: 200 })
}

/**
 * List every session state this plugin owns.
 *
 * A session whose state file cannot be read is reported in damaged instead of
 * being skipped. Skipping it silently is how it disappears from every status
 * view while its receipts are still on the surface -- the user sees one row
 * fewer and has no way to learn that a session needs attention.
 *
 * 并发删除：目录可能在 `readdir` 与逐项检查之间被删掉（`/memory-lab clean`、
 * 另一个会话的清理、用户手动删）。这不是损坏，也不该掀掉整次扫描——否则一个
 * 正在被清理的会话会让整个状态视图报错。目录类型优先取 `readdir` 的 dirent
 * 快照（同一次扫描的结果，不存在这个窗口）；只有在文件系统不返回类型
 * （DT_UNKNOWN）时才回落 `lstat`，并单独容忍 ENOENT。
 *
 * @returns { rows, damaged }; damaged rows carry the reason.
 * @throws {Error} with code 'EDAMAGED' when the root marker is damaged.
 */
export async function listSessionStates(labRoot) {
  const root = path.resolve(labRoot)
  const marker = await readLabRootMarker(root)
  if (marker === null) return { rows: [], damaged: [] }
  let entries
  try {
    entries = await readdir(sessionsRootFor(root), { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return { rows: [], damaged: [] }
    throw error
  }
  const rows = []
  const damaged = []
  for (const entry of entries) {
    if (!isSessionDirectoryName(entry.name)) continue
    const directory = path.join(sessionsRootFor(root), entry.name)
    let isDirectory = entry.isDirectory()
    let isSymbolicLink = entry.isSymbolicLink()
    if (!isDirectory && !isSymbolicLink && !entry.isFile()) {
      // dirent 没有给出类型：回落 lstat，并容忍目录已被并发删除。
      try {
        const stat = await lstat(directory)
        isDirectory = stat.isDirectory()
        isSymbolicLink = stat.isSymbolicLink()
      } catch (error) {
        if (error?.code === 'ENOENT') continue
        throw error
      }
    }
    if (isSymbolicLink) continue
    // A directory can disappear after lstat (DT_UNKNOWN fallback) or on a file
    // system whose dirent type is unreliable. `readJsonStrict` maps ENOENT to
    // null, but a directory path produces ENOTDIR for the state file instead;
    // that is the same concurrent-removal race, not damaged state.
    if (!isDirectory) {
      try {
        const stat = await lstat(directory)
        if (!stat.isDirectory() || stat.isSymbolicLink()) continue
      } catch (error) {
        if (error?.code === 'ENOENT') continue
        throw error
      }
    }
    let state
    try {
      state = await readJsonStrict(path.join(directory, STATE_FILE))
    } catch (error) {
      if (error?.code === 'EDAMAGED') {
        damaged.push({ directory, reason: error.message })
        continue
      }
      throw error
    }
    // 目录在这里被删掉时 `readJsonStrict` 返回 null（ENOENT 不是损坏），跳过。
    if (state === null) continue
    if (!isSessionState(state)) {
      damaged.push({ directory, reason: 'invalid-state' })
      continue
    }
    rows.push({ directory, state })
  }
  return { rows, damaged }
}
