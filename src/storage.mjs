import { createHash } from 'node:crypto'
import { mkdir, open, readFile, readdir, lstat, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import {
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
