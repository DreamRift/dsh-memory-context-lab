/**
 * 会话控制文件（adapters/storage）：`<v3Root>/sessions/<sessionKey>/control.json`。
 *
 * 读路径在 `agent/pre-step` 每步都会调用，所以：
 * - 用同步戳 + 小缓存（mtimeNs:size:头 sha1，见 file-stamp.mjs）避免每步读盘；
 * - 文件不存在 = 默认全开（不是错误）；损坏/不可读 = 默认 + error（状态面可见，
 *   不把「控制文件坏了」静默成「用户关掉了」）。
 *
 * 写路径走 `writeFileAtomic`（temp+rename+fsync），与 v3 其它结构文件同一实现。
 * 目录键与 session-store 完全一致：正常 id 用 isolation key；非常规 id 用同样的
 * `hash-<sha256 前 16>` 兜底（否则控制文件会落到冷库目录之外）。
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { sessionIsolationKey } from '../../domain/session/isolation-key.mjs'
import { emptySessionControl, normalizeSessionControl, patchSessionControl, SESSION_CONTROL_SCHEMA_VERSION } from '../../domain/session/session-control.mjs'
import { fileStampOfSync, STAMP_ABSENT } from './file-stamp.mjs'
import { writeFileAtomic } from './session-store.mjs'
import { withCrossProcessWriteLock } from './write-lock.mjs'

const FILE = 'control.json'
const READ_WRAPPER_ERRORS = new Set([
  'ECONTROL_SHAPE', 'ECONTROL_CORRUPT', 'ECONTROL_UNREADABLE', 'ECONTROL_UNKNOWN_KEY',
  'ECONTROL_VERSION', 'ECONTROL_BOOLEAN', 'ECONTROL_OVERRIDES', 'ECONTROL_RANGE', 'ECONTROL_UPDATED_AT',
])
const cache = new Map() // path → { stamp, control }

/** 与 composition 的目录键算法一致（正常 id；非常规 id 哈希兜底）。 */
function sessionKeyOf(sessionId) {
  const original = String(sessionId ?? 'unknown')
  try {
    return sessionIsolationKey(original)
  } catch (error) {
    if (error?.code !== 'ESESSION_INVALID_ID') throw error
    return 'hash-' + createHash('sha256').update(original.normalize('NFC')).digest('hex').slice(0, 16)
  }
}

export function sessionControlPath(v3Root, sessionId) {
  return join(v3Root, 'sessions', sessionKeyOf(sessionId), FILE)
}

/**
 * 同步读会话控制（pre-step 热路径）。
 * @param {string} v3Root v3 数据根
 * @param {string} sessionId 会话 id
 * @returns {object} 控制对象；error 字段存在表示文件损坏/不可读，控制按默认值
 */
export function readSessionControl(v3Root, sessionId, { defaultEnabled = true } = {}) {
  const path = sessionControlPath(v3Root, sessionId)
  const fallback = () => ({ ...emptySessionControl(), enabled: defaultEnabled !== false, path })
  // M3（2026-11-04 审计）：每 tick 都 stat 文件，不再靠目录 mtime 短路。
  // 旧闸门在目录未变时直接返回进程内缓存（0 次文件 stat），跨进程写在同一 mtime 粒度内
  // 或外部原地改写时，热路径会拿到旧的 enabled/recall——这是失败开放的方向。
  // 现在缓存只在**文件戳完全相同**时命中（仍省掉 readFile + JSON.parse）。
  const cached = cache.get(path)
  let stamp
  try {
    // P3-01：与 session-state / 索引 / 账本同一戳口径（mtimeNs:size:头 sha1）。
    stamp = fileStampOfSync(path)
  } catch {
    // 戳不出来 = 读不了：按损坏回落并标明错误码，不让可能过期的缓存值继续生效。
    return { ...fallback(), error: 'ECONTROL_UNREADABLE' }
  }
  if (stamp === STAMP_ABSENT) {
    // B3-9：ENOENT 也进缓存（STAMP_ABSENT 哨兵）——「文件不存在」是稳定状态。哨兵**不**
    // 享受戳闸门（见上）：每次仍付一次 ENOENT stat，才能看见同 tick 新建的文件。
    cache.set(path, { stamp: STAMP_ABSENT, control: fallback() })
    return fallback()
  }
  if (cached !== undefined && cached.stamp === stamp) return cached.control
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    // 坏 JSON 必须按**本会话默认**回落，不能无条件 enabled=true：
    // 新对话默认关，损坏后变开会开始摄入/归档/回注（失败开放）。
    const control = { ...emptySessionControl(), enabled: defaultEnabled !== false, error: 'ECONTROL_CORRUPT', path }
    cache.set(path, { stamp, control })
    return control
  }
  const { control, error, schemaVersionMissing } = normalizeSessionControl(parsed, { defaultEnabled })
  const out = { ...control, ...(error === null ? {} : { error }), schemaVersionMissing, path }
  cache.set(path, { stamp, control: out })
  return out
}

/**
 * 原子写会话控制，并返回归一化后的最新值。
 * @param {string} v3Root v3 数据根
 * @param {string} sessionId 会话 id
 * @param {object} control 已由 patchSessionControl 生成的控制
 */
export async function writeSessionControl(v3Root, sessionId, control) {
  const path = sessionControlPath(v3Root, sessionId)
  await mkdir(dirname(path), { recursive: true })
  // 仅精确路径匹配的 readSessionControl 结果才剥离包装字段；普通对象同名键不吞掉。
  const hasReadWrapper = control?.path === path
    && (control.error === undefined || READ_WRAPPER_ERRORS.has(control.error))
  let payload = control
  if (hasReadWrapper) {
    const { path: _path, error: _error, schemaVersionMissing: _schemaVersionMissing, ...controlPayload } = control
    payload = controlPayload
  }
  // 合同规则 5.3（写入时机受限）：与 state 同口径——版本号只在成功的普通业务写入里落盘，
  // 读路径（readSessionControl）永不写盘、永不补键。control 的无 wrapper 直写同样补键，
  // 否则手写 payload 缺版本时会写出缺版本文件（与本条合同相悖）。
  // M4：补键在展开之后；显式非 1 值原样交给校验（ECONTROL_VERSION 拒绝）。
  if (payload !== null && typeof payload === 'object' && !Array.isArray(payload)) {
    payload = { ...payload, schemaVersion: payload.schemaVersion === undefined ? SESSION_CONTROL_SCHEMA_VERSION : payload.schemaVersion }
  }
  const validation = normalizeSessionControl(payload)
  if (validation.error) {
    const error = new TypeError('会话控制写入拒绝：' + validation.error)
    error.code = validation.error
    throw error
  }
  // M10：落盘归一化结果（非法 overrides 条目被丢弃后不应重新出现在文件里）。
  await writeFileAtomic(path, JSON.stringify(validation.control) + '\n')
  cache.delete(path)
  return readSessionControl(v3Root, sessionId)
}

/** 现存控制损坏/不可读/形状非法：更新不得按默认值覆盖它（失败关闭）。 */
function unreadableControl(control) {
  return typeof control?.error === 'string'
}

/**
 * 锁内读改写（R3-01，2026-10-30）：与会话状态同一把跨进程写锁（会话目录），
 * 锁内强制磁盘重读 → 合并 patch → 原子写回。整对象写回会让并发修改互相覆盖
 * （例如 recall 开关与 overrides.limit 同时落盘只剩其一）。
 *
 * 损坏/不可读/形状非法的现存控制不覆盖（原样返回带 error 的现值）；非法 patch
 * 抛错且磁盘不变。字段级归一错误（如越界 overrides 条目被丢弃）不算损坏：
 * patch 基于归一化后的合法字段合并，等价于一次收敛修复。
 */
export async function updateSessionControl(v3Root, sessionId, patch, options = {}) {
  const path = sessionControlPath(v3Root, sessionId)
  return withCrossProcessWriteLock(dirname(path), async (ownership) => {
    cache.delete(path) // 锁内强制磁盘重读，不看进程内旧快照
    const fresh = readSessionControl(v3Root, sessionId, { defaultEnabled: options.defaultEnabled ?? true })
    if (unreadableControl(fresh)) return fresh
    const next = patchSessionControl(fresh, patch)
    ownership.assertOwned() // R3-03b（2026-10-31 审计）：提交前复核所有权，与 state/store 同口径
    return await writeSessionControl(v3Root, sessionId, next)
  })
}


