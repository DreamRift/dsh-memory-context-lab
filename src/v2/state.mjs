/**
 * v2 引擎的会话状态文件（`<labRoot>/v2/sessions/<key>/state.json`）。
 *
 * 与 v1 的 state.json 形状一致（enabled/settings/archive/nodeClaims 等字段复用
 * 同一套语义），但 kind 独立为 `dsh-memory-context-lab/v2/session`：
 * - 两种引擎的持久账本互不覆盖，谁持有投影一目了然；
 * - v1 的 readSessionState 永远不会读到 v2 目录，反之亦然；
 * - engine.json 只管互斥声明，状态文件才承载归档行与设置。
 */

import path from 'node:path'
import {
  readJsonStrict,
  sessionKeyFor,
  writeJsonAtomic,
} from '../storage.mjs'

export const V2_STATE_KIND = 'dsh-memory-context-lab/v2/session'
export const V2_STATE_SCHEMA_VERSION = 2
export const V2_STATE_FILE = 'state.json'

export class V2SessionStateDamagedError extends Error {
  constructor(message, { directory, reason } = {}) {
    super(message)
    this.name = 'V2SessionStateDamagedError'
    this.directory = directory
    this.reason = reason
  }
}

export function v2SessionDirectoryFor(labRoot, sessionId) {
  return path.join(path.resolve(labRoot), 'v2', 'sessions', sessionKeyFor(sessionId))
}

export function isV2SessionState(value) {
  return Boolean(value)
    && typeof value === 'object'
    && value.kind === V2_STATE_KIND
    && value.schemaVersion === V2_STATE_SCHEMA_VERSION
    && typeof value.sessionId === 'string'
    && typeof value.enabled === 'boolean'
}

/** 建会话目录并写状态骨架；已有账本时按 v1 语义：启用中拒绝，已停用则重新启用（不覆盖账本）。 */
export async function createV2SessionState(labRoot, sessionId, settings) {
  const directory = v2SessionDirectoryFor(labRoot, sessionId)
  const existing = await readV2SessionStateFile(directory)
  if (existing) {
    if (!isV2SessionState(existing) || existing.sessionId !== sessionId) {
      throw new V2SessionStateDamagedError(
        '本会话的 v2 状态文件内容无效，拒绝在其上启用。',
        { directory, reason: 'invalid-state' },
      )
    }
    if (existing.enabled === true) {
      const error = new Error('本会话 v2 引擎已在运行中。')
      error.code = 'EALREADYON'
      throw error
    }
    const state = {
      ...existing,
      enabled: true,
      disabledAt: undefined,
      disabledReason: undefined,
    }
    await writeV2SessionState(directory, state)
    return { directory, state }
  }
  const state = {
    kind: V2_STATE_KIND,
    schemaVersion: V2_STATE_SCHEMA_VERSION,
    sessionId,
    key: sessionKeyFor(sessionId),
    createdAt: new Date().toISOString(),
    enabled: true,
    settings,
    archive: [],
  }
  await writeV2SessionState(directory, state)
  return { directory, state }
}

async function readV2SessionStateFile(directory) {
  return readJsonStrict(path.join(directory, V2_STATE_FILE))
}

/**
 * 读 v2 会话状态；从未启用返回 null。
 * 损坏（坏 JSON / kind/schema 不符 / sessionId 不匹配）抛错而不是当 null，
 * 与 v1 的 C-11 语义一致：损坏不是「从未启用」，`on` 不得静默覆盖账本。
 */
export async function readV2SessionState(labRoot, sessionId) {
  const directory = v2SessionDirectoryFor(labRoot, sessionId)
  let state
  try {
    state = await readJsonStrict(path.join(directory, V2_STATE_FILE))
  } catch (error) {
    if (error?.code === 'EDAMAGED') {
      throw new V2SessionStateDamagedError(
        `本会话的 v2 状态文件已损坏，无法判断历史归档事实（${error.message}）。不会将其当作「从未启用」，也不会覆盖它。`,
        { directory, reason: error.message },
      )
    }
    throw error
  }
  if (state !== null && (!isV2SessionState(state) || state.sessionId !== sessionId)) {
    throw new V2SessionStateDamagedError(
      '本会话的 v2 状态文件内容无效（kind/schema/sessionId 不匹配），已拒绝读取。',
      { directory, reason: 'invalid-state' },
    )
  }
  if (state === null) return null
  return { directory, state }
}

export async function writeV2SessionState(directory, state) {
  if (!isV2SessionState(state)) throw new Error('拒绝写入无效的 v2 会话状态文件。')
  await writeJsonAtomic(path.join(directory, V2_STATE_FILE), state)
}

/**
 * v2 禁用后的状态标记：保留账本，仅将 enabled 置 false（写入走 writeV2SessionState）。
 * 这里只提供纯函数，方便测试与复用。
 */
export function disabledV2State(state, reason) {
  return {
    ...state,
    enabled: false,
    disabledAt: new Date().toISOString(),
    disabledReason: typeof reason === 'string' && reason.trim() ? reason.trim() : null,
  }
}
