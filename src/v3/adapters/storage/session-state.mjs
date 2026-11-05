/**
 * 会话引擎状态文件（adapters/storage）：`<v3Root>/sessions/<sessionKey>/state.json`。
 *
 * 与 control.json 分开：control 是用户意图，state 是引擎状态（mode/surface/cooling/provider）。
 * 读路径在 pre-step/statusOf 热路径调用：同步 stat + 小缓存；文件不存在 = 默认，
 * 损坏 = 默认 + error（状态面可见，不静默当成默认成功）。
 *
 * 目录键与 session-store/control 完全一致：正常 id 用 isolation key；非常规 id 用
 * `hash-<sha256 前 16>` 兜底。
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { sessionIsolationKey } from '../../domain/session/isolation-key.mjs'
import { emptySessionState, normalizeSessionState, patchSessionState, SESSION_STATE_SCHEMA_VERSION } from '../../domain/session/mode.mjs'
import { fileStampOfSync, STAMP_ABSENT } from './file-stamp.mjs'
import { writeFileAtomic } from './session-store.mjs'
import { withCrossProcessWriteLock } from './write-lock.mjs'

const FILE = 'state.json'
const READ_WRAPPER_ERRORS = new Set([
  'ESTATE_SHAPE', 'ESTATE_CORRUPT', 'ESTATE_UNREADABLE', 'ESTATE_UNKNOWN_KEY', 'ESTATE_UNKNOWN_FIELD',
  'ESTATE_VERSION', 'ESTATE_MODE', 'ESTATE_MODE_SOURCE', 'ESTATE_BOOLEAN', 'ESTATE_PINS',
  'ESTATE_READ_LEASE', 'ESTATE_SURFACE', 'ESTATE_SURFACE_SEQ', 'ESTATE_SURFACE_AT',
  'ESTATE_PLAN_FLOOR', 'ESTATE_COOLING', 'ESTATE_PROVIDER', 'ESTATE_UPDATED_AT',
])
const cache = new Map() // path → { stamp, state }

function sessionKeyOf(sessionId) {
  const original = String(sessionId ?? 'unknown')
  try {
    return sessionIsolationKey(original)
  } catch (error) {
    if (error?.code !== 'ESESSION_INVALID_ID') throw error
    return 'hash-' + createHash('sha256').update(original.normalize('NFC')).digest('hex').slice(0, 16)
  }
}

export function sessionStatePath(v3Root, sessionId) {
  return join(v3Root, 'sessions', sessionKeyOf(sessionId), FILE)
}

/**
 * 同步读会话状态（pre-step/statusOf 热路径）。
 * @param {string} v3Root
 * @param {string} sessionId
 * @param {{defaultMode?: string}} [options] 文件不存在时的模式（新会话 full-history / 旧会话 recall-only）
 * @returns {object} state + 可选 error/path
 */
export function readSessionState(v3Root, sessionId, { defaultMode = 'recall-only' } = {}) {
  const path = sessionStatePath(v3Root, sessionId)
  const fallback = () => ({ ...emptySessionState(defaultMode), path, exists: false })
  // M3（2026-11-04 审计）：**每 tick 都 stat 目标文件**，不再用目录 mtime 闸门短路。
  // 旧实现目录未变就直接返回进程内缓存，连文件 stat 都不做——跨进程写入若落在同一
  // mtime 粒度内、或外部工具原地改写（不推目录 mtime），热路径会读到旧的 enabled/mode。
  // 这是失败开放的方向（该关的没关），代价只是一次 stat，远小于一次错读。
  const cached = cache.get(path)
  let stamp
  try {
    // P3-01：戳口径统一到 file-stamp.mjs（mtimeNs:size:头 sha1），不再是 mtimeMs:size。
    // 毫秒戳在同一计时粒度内的**同大小**替换会判等，热路径就会拿旧的 enabled/mode——
    // 与会话状态缓存同源的隐私面（forgotten/purged）用的是纳秒+摘要戳，两套判据必然漂移。
    stamp = fileStampOfSync(path)
  } catch {
    // 戳不出来（EACCES/EBUSY 等）：文件存在但读不了 → 失败关闭，不返回可能过期的缓存值。
    return { ...emptySessionState(defaultMode), error: 'ESTATE_UNREADABLE', path, exists: true }
  }
  if (stamp === STAMP_ABSENT) {
    // B3-9：ENOENT 哨兵缓存（不享受戳闸门；见函数头）——每次都仍付一次 stat。
    cache.set(path, { stamp: STAMP_ABSENT, state: fallback() })
    return fallback()
  }
  if (cached !== undefined && cached.stamp === stamp) return cached.state
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    const state = { ...emptySessionState(defaultMode), error: 'ESTATE_CORRUPT', path, exists: true }
    cache.set(path, { stamp, state })
    return state
  }
  const { state, error, schemaVersionMissing } = normalizeSessionState(parsed, { defaultMode })
  const out = { ...state, ...(error === null ? {} : { error }), schemaVersionMissing, path, exists: true }
  cache.set(path, { stamp, state: out })
  return out
}

/**
 * 原子写会话状态，并返回归一化后的最新值。
 * @param {string} v3Root
 * @param {string} sessionId
 * @param {object} state 已由 patchSessionState 生成的状态
 */
export async function writeSessionState(v3Root, sessionId, state) {
  const path = sessionStatePath(v3Root, sessionId)
  await mkdir(dirname(path), { recursive: true })
  // 只有路径与本会话 state.json 一致、exists 为布尔值、error 属于读取器错误码时，
  // 才把这三项认作 readSessionState 包装元数据；普通同名未知字段不剥离。
  const hasReadWrapper = state?.path === path
    && typeof state?.exists === 'boolean'
    && (state.error === undefined || READ_WRAPPER_ERRORS.has(state.error))
  let payload = state
  if (hasReadWrapper) {
    const { path: _path, exists: _exists, error: _error, schemaVersionMissing: _schemaVersionMissing, ...statePayload } = state
    payload = statePayload
  }
  // 合同规则 5.3（写入时机受限）：版本号只在**成功的普通业务写入**的正常原子写里落盘。
  // 读路径（readSessionState）既不写盘也不补键——缺版本文件的修复只随下一次业务写入发生，
  // 启动/只读诊断路径不会单独触发重写。
  // M4：补键必须**在展开之后**再赋值。旧写法 `{ schemaVersion: 1, ...payload }` 在
  // payload 含显式 `schemaVersion: undefined` 时会被反覆盖成 undefined，落盘出「无版本
  // 文件」；显式非 1 值仍原样交给校验（ESTATE_VERSION 拒绝），不静默改写。
  if (payload !== null && typeof payload === 'object' && !Array.isArray(payload)) {
    payload = { ...payload, schemaVersion: payload.schemaVersion === undefined ? SESSION_STATE_SCHEMA_VERSION : payload.schemaVersion }
  }
  const validation = normalizeSessionState(payload)
  if (validation.error) {
    const error = new TypeError('会话状态写入拒绝：' + validation.error)
    error.code = validation.error
    throw error
  }
  // M10：落盘用**归一化后的 state**，不是原始 payload。旧实现写 payload，normalize 的
  // 收敛结果（去重 pins、补默认、剔除非法条目）只存在于返回值里，磁盘与内存分叉。
  await writeFileAtomic(path, JSON.stringify(validation.state) + '\n')
  cache.delete(path)
  return readSessionState(v3Root, sessionId, { defaultMode: validation.state.mode })
}

/** 现存状态损坏/不可读：更新与初始化都不得按空状态覆盖它（失败关闭）。 */
function unreadableState(state) {
  return state?.exists === true && typeof state?.error === 'string'
}

/** 锁内 updater 的入参快照：state 是普通对象 + 数组行，structuredClone 一次深拷贝即可
 * （不引第三方库）。必须深拷贝——updater 直接改入参（push/set）不得污染进程内读缓存或落盘。 */
function snapshotOfSessionState(state) {
  return structuredClone(state)
}

/**
 * 锁内读改写（R3-01，2026-10-30）：在会话跨进程写锁内**强制磁盘重读** → 合并 patch
 * → 原子写回。旧 setState 是「读旧快照 → 整对象写回」，temp+rename 只防半文件：
 * 两个请求从同一旧快照各改不同字段，后写整份覆盖先前已成功的字段（并发丢更新）。
 *
 * R08（0.15.0 §7.2，2026-10-31）：第三参也可以是 **updater 函数**——
 * `(snapshot) => patch | undefined`，在锁内、强制磁盘重读**之后**调用。锁内重读只能
 * 救「不同字段」；`pins`/`readLease` 这类**整数组**由调用方在锁外拼好后传入时，后写
 * 会整份覆盖并发新增（P0 实测：并发租约只剩一条）。updater 让「读—合并」也发生在锁内。
 *
 * - 锁域与 store 一致（会话目录），复用现有锁重入机制，不新增锁目录；
 * - updater 拿到的是**快照副本**（改入参不落盘、不污染缓存），返回 undefined = **显式
 *   no-op**（不写盘、不推进 updatedAt，返回锁内现值）；返回其它值一律按 patchSessionState
 *   的既有归一/校验处理——非法结果抛 V3ContractViolation，磁盘不变；
 * - updater 抛错原样上抛（锁由 finally 释放），磁盘不变；
 * - 损坏/不可读的现存状态不覆盖也不执行 updater：原样返回带 error 的现值，磁盘不变；
 * - 非法 patch 抛 V3ContractViolation 且磁盘不变（失败关闭）；
 * - 提交前复核所有权（R3-03b），失锁抛 ELOCK_LOST 且不落盘。
 * @param {object|((state: object) => object|undefined|Promise<object|undefined>)} patchOrUpdater
 * @returns 归一化后的最新状态（与 writeSessionState 同形状）
 */
export async function updateSessionState(v3Root, sessionId, patchOrUpdater, options = {}) {
  const path = sessionStatePath(v3Root, sessionId)
  return withCrossProcessWriteLock(dirname(path), async (ownership) => {
    cache.delete(path) // 锁内强制磁盘重读，不看进程内旧快照（另一进程可能刚写盘）
    const fresh = readSessionState(v3Root, sessionId, { defaultMode: options.defaultMode ?? 'recall-only' })
    if (unreadableState(fresh)) return fresh
    const isUpdater = typeof patchOrUpdater === 'function'
    const patch = isUpdater ? await patchOrUpdater(snapshotOfSessionState(fresh)) : patchOrUpdater
    // 显式 no-op：updater 明确表示「无需变更」时不写盘（调用方可据此避免每步刷新 mtime）。
    if (isUpdater && patch === undefined) return fresh
    const next = patchSessionState(fresh, patch)
    // R3-03b（2026-10-31 审计）：提交前复核所有权——与 store 写原语同口径。
    // 锁在本事务期间被接管（或续约失败）后，再写 state 就是往别人的会话目录里写。
    ownership.assertOwned()
    return await writeSessionState(v3Root, sessionId, next)
  })
}

/**
 * 初始化（create-if-absent，R3-01）：与更新区分——锁内重读，已有 state（含损坏）
 * 一律返回现值，绝不用 initial 覆盖；两进程同时初始化只有一个落盘。
 */
export async function ensureInitialSessionState(v3Root, sessionId, initial, options = {}) {
  const path = sessionStatePath(v3Root, sessionId)
  return withCrossProcessWriteLock(dirname(path), async (ownership) => {
    cache.delete(path)
    const fresh = readSessionState(v3Root, sessionId, { defaultMode: initial?.mode ?? options.defaultMode ?? 'recall-only' })
    if (fresh.exists === true) return fresh
    ownership.assertOwned() // R3-03b：提交前复核（失锁后不得落盘新会话状态）
    return await writeSessionState(v3Root, sessionId, initial)
  })
}