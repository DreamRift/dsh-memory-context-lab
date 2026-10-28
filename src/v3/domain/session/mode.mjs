/**
 * 会话模式与每会话引擎状态（domain/session，纯函数）。
 *
 * 为什么需要独立 state（而不是塞进 control.json）：
 * - control.json 是**用户意图**（本对话启用/回注/条数覆盖），客户端可直接改；
 * - mode / surface / cooling / provider 是**引擎状态**，由归档、恢复、能力协商推进，
 *   不能让一次设置写入覆盖归档断点，也不能让归档写坏用户开关。
 *
 * 默认迁移（D-15 / full-history 默认）：
 * - 新会话（库内没有已提交记录）→ full-history；
 * - 已存在会话首次见到 state → recall-only，**不静默改变运行中的旧会话**；
 * - 用户显式 `/memory-lab mode …` 后才写 modeSource='explicit'。
 */
import { V3ContractViolation } from '../../contracts/errors.mjs'

export const SESSION_STATE_SCHEMA_VERSION = 1

/** 模式封闭集。full-history 是产品默认；cooling 是压力驱动的普通模式；recall-only 是旧会话迁移/安全回退。 */
export const SESSION_MODES = Object.freeze(['full-history', 'cooling', 'recall-only'])

/** 空状态：调用方必须显式给 mode（新会话/迁移的口径不同，不能猜）。 */
export function emptySessionState(mode = 'recall-only') {
  if (!SESSION_MODES.includes(mode)) throw new V3ContractViolation('v3 session state: 未知 mode')
  return {
    schemaVersion: SESSION_STATE_SCHEMA_VERSION,
    mode,
    modeSource: 'default',
    planFirst: false,
    autoRestore: true,
    pins: [],
    readLease: [],
    // 两套位点：lastArchiveEndSeq 是**回合级**选择器的断点（只有 full-history 推进）；
    // lastArchiveAt 是「本会话压过历史」的通用事实（两种模式都推进），供状态行与
    // 切模式确认使用。不要把前者复用到按步归档：它会成为回合级选择的永久下限。
    surface: { lastArchiveEndSeq: -1, lastArchiveAt: null },
    // 计划批准时的冻结边界：该 seq 及之前的计划工件终生留在活动面，不归档。
    planFloorSeq: null,
    cooling: { open: false, lastOccupancy: null, lastRunAt: null, lastReason: null },
    provider: { tier: 'T1', reason: '本地词法索引（T1）' },
    updatedAt: 0,
  }
}

function invalid(label, value) {
  throw new V3ContractViolation('v3 session state: ' + label + ' 非法：' + JSON.stringify(value))
}

function normalizePins(raw, errorRef) {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) { errorRef.value = 'ESTATE_PINS'; return [] }
  const out = []
  for (const id of raw) {
    if (typeof id !== 'string' || id.length === 0) { errorRef.value = 'ESTATE_PINS'; continue }
    if (!out.includes(id)) out.push(id)
  }
  return out.slice(0, 200)
}

/** 读租约：最近读过（命令/回注）的记录在 TTL 内不归档；过期由引擎清理。 */
function normalizeReadLease(raw, errorRef) {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) { errorRef.value = 'ESTATE_READ_LEASE'; return [] }
  const out = []
  for (const item of raw) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) { errorRef.value = 'ESTATE_READ_LEASE'; continue }
    if (typeof item.recordId !== 'string' || item.recordId.length === 0) { errorRef.value = 'ESTATE_READ_LEASE'; continue }
    if (typeof item.expiresAt !== 'number' || !Number.isFinite(item.expiresAt)) { errorRef.value = 'ESTATE_READ_LEASE'; continue }
    if (!out.some((row) => row.recordId === item.recordId)) out.push({ recordId: item.recordId, expiresAt: item.expiresAt })
  }
  return out.slice(0, 200)
}

/**
 * 读路径归一化：任何坏形状都不抛（pre-step 每步会读），但把 error 带进状态面。
 * @param {unknown} raw
 * @param {{defaultMode?: string}} [options]
 */
export function normalizeSessionState(raw, { defaultMode = 'recall-only' } = {}) {
  const base = emptySessionState(defaultMode)
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { state: base, error: 'ESTATE_SHAPE' }
  }
  const errorRef = { value: null }
  let mode = base.mode
  if (raw.mode !== undefined) {
    if (SESSION_MODES.includes(raw.mode)) mode = raw.mode
    else errorRef.value = 'ESTATE_MODE'
  }
  const state = emptySessionState(mode)
  if (raw.schemaVersion !== undefined && raw.schemaVersion !== SESSION_STATE_SCHEMA_VERSION) errorRef.value = 'ESTATE_VERSION'
  if (raw.modeSource === 'default' || raw.modeSource === 'migration' || raw.modeSource === 'explicit') state.modeSource = raw.modeSource
  else if (raw.modeSource !== undefined) errorRef.value = 'ESTATE_MODE_SOURCE'
  for (const key of ['planFirst', 'autoRestore']) {
    if (raw[key] === undefined) continue
    if (typeof raw[key] !== 'boolean') { errorRef.value = errorRef.value ?? 'ESTATE_BOOLEAN'; continue }
    state[key] = raw[key]
  }
  state.pins = normalizePins(raw.pins, errorRef)
  state.readLease = normalizeReadLease(raw.readLease, errorRef)
  if (raw.surface !== undefined) {
    const surface = raw.surface
    if (surface === null || typeof surface !== 'object' || Array.isArray(surface)) errorRef.value = 'ESTATE_SURFACE'
    else if (surface.lastArchiveEndSeq !== undefined
      && (!Number.isInteger(surface.lastArchiveEndSeq) || surface.lastArchiveEndSeq < -1)) errorRef.value = 'ESTATE_SURFACE_SEQ'
    else if (surface.lastArchiveEndSeq !== undefined) state.surface.lastArchiveEndSeq = surface.lastArchiveEndSeq
    if (surface.lastArchiveAt !== undefined) {
      if (surface.lastArchiveAt === null || (typeof surface.lastArchiveAt === 'number' && Number.isFinite(surface.lastArchiveAt) && surface.lastArchiveAt >= 0)) {
        state.surface.lastArchiveAt = surface.lastArchiveAt
      } else errorRef.value = errorRef.value ?? 'ESTATE_SURFACE_AT'
    }
  }
  if (raw.planFloorSeq !== undefined && raw.planFloorSeq !== null) {
    if (Number.isInteger(raw.planFloorSeq) && raw.planFloorSeq >= -1) state.planFloorSeq = raw.planFloorSeq
    else errorRef.value = 'ESTATE_PLAN_FLOOR'
  }
  if (raw.cooling !== undefined) {
    const cooling = raw.cooling
    if (cooling === null || typeof cooling !== 'object' || Array.isArray(cooling)) errorRef.value = 'ESTATE_COOLING'
    else {
      if (typeof cooling.open === 'boolean') state.cooling.open = cooling.open
      else if (cooling.open !== undefined) errorRef.value = 'ESTATE_COOLING'
      if (cooling.lastOccupancy === null || (typeof cooling.lastOccupancy === 'number' && Number.isFinite(cooling.lastOccupancy))) state.cooling.lastOccupancy = cooling.lastOccupancy
      else if (cooling.lastOccupancy !== undefined) errorRef.value = 'ESTATE_COOLING'
      if (cooling.lastRunAt === null || (typeof cooling.lastRunAt === 'number' && Number.isFinite(cooling.lastRunAt))) state.cooling.lastRunAt = cooling.lastRunAt
      else if (cooling.lastRunAt !== undefined) errorRef.value = 'ESTATE_COOLING'
      if (cooling.lastReason === null || typeof cooling.lastReason === 'string') state.cooling.lastReason = cooling.lastReason
      else if (cooling.lastReason !== undefined) errorRef.value = 'ESTATE_COOLING'
    }
  }
  if (raw.provider !== undefined) {
    const provider = raw.provider
    if (provider === null || typeof provider !== 'object' || Array.isArray(provider)) errorRef.value = 'ESTATE_PROVIDER'
    else {
      if (provider.tier !== 'T1' && provider.tier !== 'T2') errorRef.value = 'ESTATE_PROVIDER'
      else state.provider.tier = provider.tier
      if (typeof provider.reason === 'string') state.provider.reason = provider.reason
      else if (provider.reason !== undefined) errorRef.value = 'ESTATE_PROVIDER'
    }
  }
  if (raw.updatedAt !== undefined) {
    if (typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt)) state.updatedAt = raw.updatedAt
    else errorRef.value = errorRef.value ?? 'ESTATE_UPDATED_AT'
  }
  return { state, error: errorRef.value }
}

/**
 * 写路径 patch：对非法值失败关闭，不静默归一。
 * 只允许用户/引擎显式控制的字段；surface/cooling/provider 由引擎内部 patch。
 */
export function patchSessionState(current, patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new V3ContractViolation('v3 session state: patch 必须是对象')
  }
  const next = {
    ...emptySessionState(current.mode),
    modeSource: current.modeSource,
    planFirst: current.planFirst,
    autoRestore: current.autoRestore,
    pins: [...current.pins],
    readLease: (current.readLease ?? []).map((row) => ({ ...row })),
    surface: { ...current.surface },
    planFloorSeq: current.planFloorSeq ?? null,
    cooling: { ...current.cooling },
    provider: { ...current.provider },
    updatedAt: Date.now(),
  }
  if (patch.mode !== undefined) {
    if (!SESSION_MODES.includes(patch.mode)) invalid('mode', patch.mode)
    next.mode = patch.mode
    next.modeSource = 'explicit'
  }
  for (const key of ['planFirst', 'autoRestore']) {
    if (patch[key] === undefined) continue
    if (typeof patch[key] !== 'boolean') invalid(key, patch[key])
    next[key] = patch[key]
  }
  if (patch.pins !== undefined) {
    if (!Array.isArray(patch.pins)) invalid('pins', patch.pins)
    const pins = []
    for (const id of patch.pins) {
      if (typeof id !== 'string' || id.length === 0) invalid('pins', patch.pins)
      if (!pins.includes(id)) pins.push(id)
    }
    next.pins = pins.slice(0, 200)
  }
  if (patch.readLease !== undefined) {
    if (!Array.isArray(patch.readLease)) invalid('readLease', patch.readLease)
    const lease = []
    for (const item of patch.readLease) {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) invalid('readLease', patch.readLease)
      if (typeof item.recordId !== 'string' || item.recordId.length === 0) invalid('readLease', patch.readLease)
      if (typeof item.expiresAt !== 'number' || !Number.isFinite(item.expiresAt)) invalid('readLease', patch.readLease)
      if (!lease.some((row) => row.recordId === item.recordId)) lease.push({ recordId: item.recordId, expiresAt: item.expiresAt })
    }
    next.readLease = lease.slice(0, 200)
  }
  if (patch.planFloorSeq !== undefined) {
    if (patch.planFloorSeq !== null && (!Number.isInteger(patch.planFloorSeq) || patch.planFloorSeq < -1)) invalid('planFloorSeq', patch.planFloorSeq)
    next.planFloorSeq = patch.planFloorSeq
  }
  if (patch.surface !== undefined) {
    const surface = patch.surface
    if (surface === null || typeof surface !== 'object' || Array.isArray(surface)) invalid('surface', surface)
    if (surface.lastArchiveEndSeq !== undefined) {
      if (!Number.isInteger(surface.lastArchiveEndSeq) || surface.lastArchiveEndSeq < -1) invalid('surface.lastArchiveEndSeq', surface.lastArchiveEndSeq)
      next.surface.lastArchiveEndSeq = surface.lastArchiveEndSeq
    }
    if (surface.lastArchiveAt !== undefined) {
      if (surface.lastArchiveAt !== null && (typeof surface.lastArchiveAt !== 'number' || !Number.isFinite(surface.lastArchiveAt) || surface.lastArchiveAt < 0)) invalid('surface.lastArchiveAt', surface.lastArchiveAt)
      next.surface.lastArchiveAt = surface.lastArchiveAt
    }
  }
  if (patch.cooling !== undefined) {
    const cooling = patch.cooling
    if (cooling === null || typeof cooling !== 'object' || Array.isArray(cooling)) invalid('cooling', cooling)
    for (const key of ['open', 'lastOccupancy', 'lastRunAt', 'lastReason']) {
      if (cooling[key] === undefined) continue
      next.cooling[key] = cooling[key]
    }
  }
  if (patch.provider !== undefined) {
    const provider = patch.provider
    if (provider === null || typeof provider !== 'object' || Array.isArray(provider)) invalid('provider', provider)
    if (provider.tier !== 'T1' && provider.tier !== 'T2') invalid('provider.tier', provider.tier)
    next.provider.tier = provider.tier
    if (provider.reason !== undefined) {
      if (typeof provider.reason !== 'string') invalid('provider.reason', provider.reason)
      next.provider.reason = provider.reason
    }
  }
  return next
}

/** 新会话模式：全局 fullHistory 开 → full-history；关 → cooling。 */
export function modeForNewSession(fullHistory = true) {
  return fullHistory === false ? 'cooling' : 'full-history'
}

/** 已有记录、但没有 state 的旧会话：安全迁移到 recall-only，不静默接管。 */
export function modeForMigratedSession() {
  return 'recall-only'
}