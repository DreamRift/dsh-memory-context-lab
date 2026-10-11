import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, lstat, realpath, rename, rm, writeFile } from 'node:fs/promises'
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
async function readJsonStrict(file) {
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

export async function writeJsonAtomic(file, value) {
  const parent = path.dirname(file)
  await mkdir(parent, { recursive: true })
  const temp = path.join(parent, `.${path.basename(file)}.${randomUUID()}.tmp`)
  try {
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await rename(temp, file)
  } finally {
    await rm(temp, { force: true }).catch(() => {})
  }
}

export async function ensureLabRoot(labRoot) {
  const root = path.resolve(labRoot)
  await mkdir(root, { recursive: true })
  const markerPath = path.join(root, LAB_ROOT_MARKER_FILE)
  const current = await readJson(markerPath)
  if (current !== null && (current.kind !== LAB_ROOT_MARKER_KIND || current.schemaVersion !== SCHEMA_VERSION)) {
    throw new Error('上下文降温根目录含有不属于本插件的标记，已拒绝使用。')
  }
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
  const marker = await readJson(path.join(root, LAB_ROOT_MARKER_FILE))
  if (marker === null || marker.kind !== LAB_ROOT_MARKER_KIND || marker.schemaVersion !== SCHEMA_VERSION) return null
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

/** List every session state this plugin owns, newest directory first is not guaranteed. */
export async function listSessionStates(labRoot) {
  const root = path.resolve(labRoot)
  const marker = await readJson(path.join(root, LAB_ROOT_MARKER_FILE))
  if (marker === null) return []
  if (marker.kind !== LAB_ROOT_MARKER_KIND || marker.schemaVersion !== SCHEMA_VERSION) {
    throw new Error('上下文降温根目录的标记无效，已拒绝扫描。')
  }
  let entries
  try {
    entries = await readdir(sessionsRootFor(root), { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  const rows = []
  for (const entry of entries) {
    if (!isSessionDirectoryName(entry.name)) continue
    const directory = path.join(sessionsRootFor(root), entry.name)
    const stat = await lstat(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink()) continue
    const state = await readJson(path.join(directory, STATE_FILE))
    if (!isSessionState(state)) continue
    rows.push({ directory, state })
  }
  return rows
}
