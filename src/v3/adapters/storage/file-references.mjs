/**
 * 文件引用账本（M4）：记录「读文件工具调用」对应的路径与内容指纹。
 *
 * 边界：
 * - 只记录**工作区内、体积有界**的文件；工作区外/过大/不可读一律 unverifiable，不读正文；
 * - 读文件发生在摄入后台任务里，最多 1 MiB，不阻塞 pre-step 首字；
 * - 账本损坏 → read 抛错（调用方展示 error），不静默当成空表。
 */
import { mkdir, readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'

import { writeFileAtomic } from './session-store.mjs'
import { withCrossProcessWriteLock } from './write-lock.mjs'

export const FILE_REFERENCES_SCHEMA_VERSION = 1
export const FILE_REFERENCE_MAX_BYTES = 1024 * 1024
const LEDGER = 'file-references.json'

const READ_TOOL_NAMES = new Set([
  'read', 'read_file', 'readfile', 'readFile',
  'workspaceFiles_read', 'workspace_files_read', 'file_read',
  // 0.15.1：bundle 内的定制 dsh-ops 默认替换官方 read/glob/grep；
  // 它的读文件工具也必须进核证账本，否则启用替换后文件引用面恒空。
  'ops_inspect_local_file',
])

export function fileReferencesPath(directory) {
  return path.join(directory, LEDGER)
}

export async function readFileReferences(directory) {
  if (typeof directory !== 'string' || directory.length === 0) {
    throw new Error('v3 file-references: directory 必填')
  }
  let text
  try {
    text = await readFile(fileReferencesPath(directory), 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false, refs: [] }
    throw error
  }
  let parsed
  try { parsed = JSON.parse(text) } catch { throw new Error('file-references.json 损坏（非法 JSON）') }
  if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.refs)) {
    throw new Error('file-references.json 损坏（缺 refs 数组）')
  }
  return { exists: true, refs: parsed.refs }
}

/**
 * M6（2026-11-04 审计）：绝对路径（含用户名/目录结构）**不落盘**。
 * `workspaceRoot` 只活在进程内，用于本次核验；持久化时换成不可逆的 `workspaceId`
 * （路径的 sha256 前 16 字符）。重开后核验按当前会话 cwd 重新计算 id 比对，
 * 不一致即 `workspace-changed`（不猜旧路径）。
 */
function workspaceIdOf(root) {
  return 'ws-' + createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 16)
}

export async function writeFileReferences(directory, refs, { merge = true } = {}) {
  if (!Array.isArray(refs)) throw new Error('v3 file-references: refs 必须是数组')
  await mkdir(directory, { recursive: true })
  const sanitized = refs.map((ref) => {
    if (ref === null || typeof ref !== 'object') return ref
    const { workspaceRoot: _workspaceRoot, ...rest } = ref
    return rest
  })
  // T-11（0.15.4）：写入必须与其他写者串行，且**锁内重读后合并**。
  //
  // 缺陷：旧实现直接 `writeFileAtomic(整本覆盖)`。调用方写的是**自己内存里**的
  // `entry.fileRefs` 快照，两个句柄/进程各持一份 → 后写的整本覆盖先写的，
  // 先写的那些文件引用凭空消失（核证面「这文件没读过」→ 误判 unverifiable）。
  // 这与事务日志有跨进程写锁保护形成对照：同一目录里的账本却裸写。
  //
  // 现在：进会话写锁 → 锁内重读磁盘现值 → 按 `path` 合并（本次的引用覆盖同路径旧值）
  // → 再原子落盘。`merge:false` 保留「整本替换」能力（导入/显式重置用），
  // 但它同样在锁内执行，不会与并发追加互相覆盖。
  const write = async (ownership) => {
    let base = []
    if (merge === true) {
      try {
        const current = await readFileReferences(directory)
        base = current.refs
      } catch (error) {
        // 账本损坏时不能静默当成空表去覆盖——那会把「坏」变成「丢」。
        // 交给调用方：它自己的 catch 会记 warn，且不会写入。
        throw error
      }
    }
    const byPath = new Map()
    for (const ref of base) {
      if (ref !== null && typeof ref === 'object' && typeof ref.path === 'string') byPath.set(ref.path, ref)
    }
    for (const ref of sanitized) {
      if (ref !== null && typeof ref === 'object' && typeof ref.path === 'string') byPath.set(ref.path, ref)
      else base.push(ref)
    }
    const merged = [...byPath.values(), ...base.filter((ref) => !(ref !== null && typeof ref === 'object' && typeof ref.path === 'string'))]
    const body = JSON.stringify({ schemaVersion: FILE_REFERENCES_SCHEMA_VERSION, refs: merged }, null, 2) + '\n'
    ownership?.assertOwned?.()
    await writeFileAtomic(fileReferencesPath(directory), body)
    return merged.length
  }
  if (typeof withCrossProcessWriteLock === 'function') {
    return await withCrossProcessWriteLock(directory, write)
  }
  return await write(null)
}

function parseArguments(raw) {
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) return raw
  if (typeof raw !== 'string' || raw.length === 0) return null
  try { return JSON.parse(raw) } catch { return null }
}

/** 从 tool/call 事件提取「读文件」引用；不是读文件工具返回 null。 */
export function fileTargetOf(event) {
  if (event?.type !== 'tool/call') return null
  const data = event.data ?? {}
  const name = typeof data.name === 'string' ? data.name : ''
  if (!READ_TOOL_NAMES.has(name)) return null
  const args = parseArguments(data.arguments)
  const raw = args?.path ?? args?.file_path ?? args?.filePath ?? args?.file ?? null
  if (typeof raw !== 'string' || raw.trim().length === 0) return null
  return { tool: name, path: raw.trim() }
}

function within(root, target) {
  const rel = path.relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

function refIdOf(recordId, relPath) {
  return 'f-' + createHash('sha256').update(recordId + '\0' + relPath).digest('hex').slice(0, 16)
}

/** 计算文件引用并读取指纹；调用方负责持久化。 */
export async function captureFileReference({ event, recordId, cwd, maxBytes = FILE_REFERENCE_MAX_BYTES } = {}) {
  if (typeof recordId !== 'string' || recordId.length === 0) return null
  const target = fileTargetOf(event)
  if (target === null) return null
  if (typeof cwd !== 'string' || cwd.length === 0) return null
  const root = path.resolve(cwd)
  const absolute = path.resolve(root, target.path)
  if (!within(root, absolute)) {
    // 工作区外引用不保留用户原始路径（可能含主目录/用户名），只留文件名。
    return { id: refIdOf(recordId, target.path), recordId, tool: target.tool, path: path.basename(target.path), outsideWorkspace: true, status: 'unverifiable', reason: 'outside-workspace', capturedAt: Date.now() }
  }
  const relPath = path.relative(root, absolute) || '.'
  const base = { id: refIdOf(recordId, relPath), recordId, tool: target.tool, path: relPath, workspaceId: workspaceIdOf(root), workspaceRoot: root, capturedAt: Date.now() }
  try {
    const real = await realpath(absolute)
    if (!within(root, real)) return { ...base, status: 'unverifiable', reason: 'symlink-outside-workspace' }
    const info = await stat(real)
    if (!info.isFile()) return { ...base, status: 'unverifiable', reason: 'not-a-file' }
    if (info.size > maxBytes) return { ...base, status: 'unverifiable', reason: 'too-large', bytes: info.size }
    const buffer = await readFile(real)
    return {
      ...base,
      status: 'unverified',
      sha256: createHash('sha256').update(buffer).digest('hex'),
      bytes: buffer.length,
      mtimeMs: Math.floor(info.mtimeMs),
    }
  } catch (error) {
    if (error?.code === 'ENOENT') return { ...base, status: 'missing', reason: 'not-found' }
    return { ...base, status: 'unverifiable', reason: error?.code ?? 'read-failed' }
  }
}

/** 重新核验一个引用；不改入参。 */
export async function verifyFileReference(ref, { maxBytes = FILE_REFERENCE_MAX_BYTES, workspaceRoot = null } = {}) {
  if (ref === null || typeof ref !== 'object' || typeof ref.path !== 'string') {
    return { ...ref, status: 'unverifiable', reason: 'bad-reference' }
  }
  // 根来源优先级：调用方给的当前 cwd → 进程内 ref.workspaceRoot → 旧账本里的绝对路径。
  // 只有 workspaceId 对得上才用当前 cwd，避免「换工作区后拿新根去核旧引用」。
  const candidate = typeof workspaceRoot === 'string' && workspaceRoot.length > 0
    ? workspaceRoot
    : (typeof ref.workspaceRoot === 'string' && ref.workspaceRoot.length > 0 ? ref.workspaceRoot : null)
  if (candidate === null) return { ...ref, status: 'unverifiable', reason: 'no-workspace-root' }
  if (typeof ref.workspaceRoot !== 'string' && typeof ref.workspaceId === 'string' && ref.workspaceId !== workspaceIdOf(candidate)) {
    return { ...ref, status: 'unverifiable', reason: 'workspace-changed' }
  }
  const root = path.resolve(candidate)
  const absolute = path.resolve(root, ref.path)
  if (!within(root, absolute)) return { ...ref, status: 'unverifiable', reason: 'outside-workspace' }
  try {
    const real = await realpath(absolute)
    if (!within(root, real)) return { ...ref, status: 'unverifiable', reason: 'symlink-outside-workspace' }
    const info = await stat(real)
    if (!info.isFile()) return { ...ref, status: 'unverifiable', reason: 'not-a-file' }
    if (info.size > maxBytes) return { ...ref, status: 'unverifiable', reason: 'too-large', bytes: info.size }
    const buffer = await readFile(real)
    const sha256 = createHash('sha256').update(buffer).digest('hex')
    const same = typeof ref.sha256 === 'string' && ref.sha256 === sha256
    return {
      ...ref,
      status: same ? 'verified' : 'stale',
      reason: same ? null : 'content-changed',
      sha256,
      bytes: buffer.length,
      mtimeMs: Math.floor(info.mtimeMs),
      verifiedAt: Date.now(),
    }
  } catch (error) {
    if (error?.code === 'ENOENT') return { ...ref, status: 'missing', reason: 'not-found', verifiedAt: Date.now() }
    return { ...ref, status: 'unverifiable', reason: error?.code ?? 'read-failed', verifiedAt: Date.now() }
  }
}

/** stale/missing/unverifiable 不自动回注；unverified 尚未核验，允许回注。 */
export function isStaleFileReference(ref) {
  return ref?.status === 'stale' || ref?.status === 'missing' || ref?.status === 'unverifiable'
}