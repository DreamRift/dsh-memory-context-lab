/**
 * 验证跟踪（PR #4 接口落地）。
 *
 * 口径（如实声明，不夸大）：check 回答「记录引用的文件**现在**与**归档时**是否一致」，
 * 不承诺「与工具当初读取时一致」——归档时刻与读取时刻之间可能已有后续写入。
 *
 * 设计边界：
 * - 旁证存储与会话记录分离：`verification.json` 是可变旁证（markStale 会改它），
 *   记录本体保持不可变（store.mjs 的 append-only 纪律不被绕过）。
 * - 只对 `operation.call` 记录的参数 JSON 做白名单字段提取（file_path / path / workdir），
 *   且仅取绝对路径；相对路径、命令文本内的路径一律不提取——宁少勿错，取不到就 unverified。
 * - 失败关闭：旁证文件损坏、指纹读不全 → 该记录判 unverified 并告警，绝不静默当 valid。
 * - v1 引擎不接入（span 正文为拼接文本，路径提取不可靠；v1 是维护线）。
 */
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'

import { EngineV2Error } from './errors.mjs'
import { writeJsonFileAtomic } from './store.mjs'

// 错误码风格与 store.mjs / retrieval.mjs 保持一致：内联字符串，不建集中常量表。
const EVERIFICATIONSTALE = 'EVERIFICATIONSTALE'
const EBADINPUT = 'EBADINPUT'

const VERIFICATION_KIND = 'dsh-memory-context-lab/v2/verification'
const VERIFICATION_SCHEMA_VERSION = 1
const VERIFICATION_FILE = 'verification.json'

/** 参数 JSON 只读前 64KiB：路径字段通常在开头，超限截断导致 JSON.parse 失败时按无指纹处理。 */
const PARAMS_MAX_BYTES = 64 * 1024

/** 白名单字段：DSH 文件工具（read/edit/write/glob/grep）与 pwsh 的 workdir。 */
const PATH_FIELDS = ['file_path', 'path', 'workdir']

function verificationFilePath(sessionDir) {
  return path.join(sessionDir, VERIFICATION_FILE)
}

function isAbsoluteWindowsOrPosix(value) {
  return typeof value === 'string' && value.length > 0 && path.isAbsolute(value)
}

/**
 * 从 operation.call 的参数 JSON 提取候选文件路径。
 *
 * 纯函数（测试直接覆盖）：非 JSON、非对象、字段缺失、相对路径都返回空数组。
 * 嵌套对象不递归（工具参数是一层平铺 JSON；深挖会开始猜语义）。
 */
export function extractFilePaths(paramsText) {
  if (typeof paramsText !== 'string' || paramsText.length === 0) return []
  let parsed
  try {
    parsed = JSON.parse(paramsText)
  } catch {
    return []
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return []
  const found = []
  for (const field of PATH_FIELDS) {
    if (isAbsoluteWindowsOrPosix(parsed[field])) found.push(parsed[field])
  }
  return found
}

async function sha256Of(file) {
  const data = await readFile(file)
  return `sha256:${createHash('sha256').update(data).digest('hex')}`
}

/**
 * 归档批次落库后采集指纹（调用点：runtime 的 autoCooling / store 命令路径）。
 *
 * - 只处理 `operation.call` 记录；其余 kind 直接跳过（保持旁证文件最小）。
 * - 文件不存在或不可读 → 该记录不写入旁证（之后 check 判 unverified，不猜）。
 * - 单条记录指纹采集失败只跳过该记录并告警，不拖垮整批归档（归档是主事务，验证是旁证）。
 */
export async function captureFingerprints({ store, sessionDir, recordIds, warn = () => {} }) {
  if (!sessionDir || !Array.isArray(recordIds) || recordIds.length === 0) return
  const additions = {}
  for (const id of recordIds) {
    try {
      const loaded = await store.readRecord(id, { verifyHash: false, maxBytes: PARAMS_MAX_BYTES })
      // 非 operation.call、参数无候选路径、候选文件当前不可读：统一记「看管过、无指纹」
      // （files: []）。必须记账，否则差集永不收敛、每批归档都重扫全部旧记录。
      const recordable = { files: [], stale: null, capturedAt: new Date().toISOString() }
      if (loaded?.ok && loaded.record?.kind === 'operation.call') {
        const paramsText = loaded.payloadText ?? ''
        for (const candidate of extractFilePaths(paramsText)) {
          const info = await stat(candidate).catch(() => null)
          if (!info || !info.isFile()) continue
          recordable.files.push({ path: candidate, hash: await sha256Of(candidate) })
        }
      }
      additions[id] = recordable
    } catch (error) {
      warn(`verification: 记录 ${id} 指纹采集失败（跳过，该记录按未验证处理）：${error?.message ?? error}`)
    }
  }
  const keys = Object.keys(additions)
  if (keys.length === 0) return
  await updateSidecar(sessionDir, (current) => {
    for (const key of keys) current[key] = additions[key]
    return current
  })
}

/**
 * 归档后增量采集：只处理「已落库但旁证里还没有指纹」的记录（对齐 syncRetrievalIndex 的差集模式）。
 *
 * 每批归档后调用；已采集过的记录绝不重采（重采会把「事后改动」洗成 valid——正好毁掉验证的意义）。
 * 0.9.0 升级前的旧记录在升级后首次归档时补采：口径仍是「现在 vs 首采时」，文档如实写。
 */
export async function syncVerification({ store, sessionDir, warn = () => {} }) {
  if (!sessionDir) return { captured: 0 }
  const existing = await readSidecar(sessionDir)
  if (!existing.ok) {
    warn('verification: 旁证文件损坏，本次跳过增量采集（check 将按未验证处理，不伪造 valid）')
    return { captured: 0 }
  }
  const known = new Set(Object.keys(existing.data))
  const entries = store.listEntries({ limit: Number.MAX_SAFE_INTEGER }).entries
  const pending = entries.map((entry) => entry.id).filter((id) => !known.has(id))
  if (pending.length === 0) return { captured: 0 }
  await captureFingerprints({ store, sessionDir, recordIds: pending, warn })
  return { captured: pending.length }
}

async function readSidecar(sessionDir) {
  const file = verificationFilePath(sessionDir)
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: true, data: {} }
    throw new EngineV2Error(`验证旁证文件不可读（${file}）`, { code: EVERIFICATIONSTALE })
  }
  try {
    const parsed = JSON.parse(text)
    if (parsed?.kind !== VERIFICATION_KIND || parsed?.schemaVersion !== VERIFICATION_SCHEMA_VERSION) {
      throw new Error('kind/schemaVersion 不匹配')
    }
    if (parsed?.records === null || typeof parsed?.records !== 'object' || Array.isArray(parsed?.records)) {
      throw new Error('records 字段形态不对')
    }
    return { ok: true, data: parsed.records }
  } catch {
    // 失败关闭：损坏旁证按「什么都没验过」处理，由调用方决定要不要告警，绝不当 valid。
    return { ok: false, data: {} }
  }
}

async function updateSidecar(sessionDir, mutate) {
  const file = verificationFilePath(sessionDir)
  const current = await readSidecarRawForUpdate(sessionDir)
  const next = mutate(current)
  await writeJsonFileAtomic(file, {
    kind: VERIFICATION_KIND,
    schemaVersion: VERIFICATION_SCHEMA_VERSION,
    records: next,
  })
}

async function readSidecarRawForUpdate(sessionDir) {
  const loaded = await readSidecar(sessionDir)
  // 更新路径遇到损坏旁证：以空表重建（markStale 不应因为旁证坏了而永远失败）。
  // 重建会丢掉旧指纹——可接受：指纹丢了退化成 unverified，不会伪造 valid。
  return loaded.data
}

/**
 * check：三态裁决。
 * - stale：任一文件 hash 不匹配，或曾被 markStale，或文件已不存在（曾经有指纹）。
 * - unverified：无指纹记录、参数不可解析、旁证损坏。
 * - valid：全部指纹匹配。
 */
export async function checkRecords({ sessionDir, recordIds, warn = () => {} }) {
  const loaded = await readSidecar(sessionDir)
  const results = []
  for (const id of recordIds) {
    if (!loaded.ok) {
      warn('verification: 旁证文件损坏，所有记录按未验证处理（不伪造 valid）')
      results.push({ recordId: id, verdict: 'unverified', reason: '旁证文件损坏（失败关闭）' })
      continue
    }
    const entry = loaded.data[id]
    // 人工标记优先于指纹有无：被 markStale 的记录即使无指纹也是 stale（用户判断高于一切）。
    if (entry?.stale) {
      results.push({
        recordId: id,
        verdict: 'stale',
        reason: `人工标记：${entry.stale.reason ?? '（未给出原因）'}`,
        code: EVERIFICATIONSTALE,
      })
      continue
    }
    if (!entry || !Array.isArray(entry.files) || entry.files.length === 0) {
      results.push({ recordId: id, verdict: 'unverified', reason: '无指纹（记录非文件类操作，或采集时文件不可用）' })
      continue
    }
    let mismatch = null
    for (const fingerprint of entry.files) {
      const info = await stat(fingerprint.path).catch(() => null)
      if (!info || !info.isFile()) {
        mismatch = { path: fingerprint.path, detail: '文件已不存在' }
        break
      }
      const current = await sha256Of(fingerprint.path)
      if (current !== fingerprint.hash) {
        mismatch = { path: fingerprint.path, detail: '内容与归档时不一致' }
        break
      }
    }
    if (mismatch) {
      results.push({
        recordId: id,
        verdict: 'stale',
        reason: `${mismatch.path}：${mismatch.detail}`,
        code: EVERIFICATIONSTALE,
      })
    } else {
      results.push({ recordId: id, verdict: 'valid', matchedFiles: entry.files.length })
    }
  }
  return { ok: true, results }
}

/**
 * 回读注记：只查人工 markStale 标记（读旁证，零 hash 计算）。
 * 文件内容级失效不在此处判定——每次回读都算 sha256 会把读路径变慢，
 * 内容核对是 `verify` 命令的职责。旁证损坏时返回空表（退化成无注记，不报假失效）。
 */
export async function annotateStale({ sessionDir, recordIds }) {
  const empty = new Map()
  if (!sessionDir || !Array.isArray(recordIds) || recordIds.length === 0) return empty
  const loaded = await readSidecar(sessionDir)
  if (!loaded.ok) return empty
  const marked = new Map()
  for (const id of recordIds) {
    const entry = loaded.data[id]
    if (entry?.stale) marked.set(id, entry.stale.reason ?? '（未给出原因）')
  }
  return marked
}

/**
 * markStale：只写旁证，不改记录本体（append-only 红线）。
 * 对无指纹记录也允许标记（用户判断优先于指纹有无）。
 */
export async function markRecordsStale({ sessionDir, recordIds, reason, warn = () => {} }) {
  if (!Array.isArray(recordIds) || recordIds.length === 0) {
    throw new EngineV2Error('mark-stale 需要至少一个记录 ID', { code: EBADINPUT })
  }
  if (typeof reason !== 'string' || reason.trim().length === 0) {
    throw new EngineV2Error('mark-stale 需要人工说明原因（审计要求）', { code: EBADINPUT })
  }
  const markedAt = new Date().toISOString()
  await updateSidecar(sessionDir, (current) => {
    for (const id of recordIds) {
      current[id] = current[id] ?? { files: [], stale: null, capturedAt: null }
      current[id].stale = { reason: reason.trim(), markedAt }
    }
    return current
  })
  return { ok: true, marked: recordIds.length, markedAt }
}
