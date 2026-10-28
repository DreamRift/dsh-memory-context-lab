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

export const FILE_REFERENCES_SCHEMA_VERSION = 1
export const FILE_REFERENCE_MAX_BYTES = 1024 * 1024
const LEDGER = 'file-references.json'

const READ_TOOL_NAMES = new Set([
  'read', 'read_file', 'readfile', 'readFile',
  'workspaceFiles_read', 'workspace_files_read', 'file_read',
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

export async function writeFileReferences(directory, refs) {
  if (!Array.isArray(refs)) throw new Error('v3 file-references: refs 必须是数组')
  await mkdir(directory, { recursive: true })
  const body = JSON.stringify({ schemaVersion: FILE_REFERENCES_SCHEMA_VERSION, refs }, null, 2) + '\n'
  await writeFileAtomic(fileReferencesPath(directory), body)
  return refs.length
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
    return { id: refIdOf(recordId, target.path), recordId, tool: target.tool, path: target.path, status: 'unverifiable', reason: 'outside-workspace', capturedAt: Date.now() }
  }
  const relPath = path.relative(root, absolute) || '.'
  const base = { id: refIdOf(recordId, relPath), recordId, tool: target.tool, path: relPath, workspaceRoot: root, capturedAt: Date.now() }
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
export async function verifyFileReference(ref, { maxBytes = FILE_REFERENCE_MAX_BYTES } = {}) {
  if (ref === null || typeof ref !== 'object' || typeof ref.path !== 'string') {
    return { ...ref, status: 'unverifiable', reason: 'bad-reference' }
  }
  if (typeof ref.workspaceRoot !== 'string' || ref.workspaceRoot.length === 0) {
    return { ...ref, status: 'unverifiable', reason: 'no-workspace-root' }
  }
  const root = path.resolve(ref.workspaceRoot)
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