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
import { readFileSync, statSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { sessionIsolationKey } from '../../domain/session/isolation-key.mjs'
import { emptySessionState, normalizeSessionState } from '../../domain/session/mode.mjs'
import { writeFileAtomic } from './session-store.mjs'

const FILE = 'state.json'
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
  let stamp
  try {
    const stat = statSync(path)
    stamp = stat.mtimeMs + ':' + stat.size
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      return { ...emptySessionState(defaultMode), error: 'ESTATE_UNREADABLE', path, exists: true }
    }
    cache.delete(path)
    return fallback()
  }
  const cached = cache.get(path)
  if (cached !== undefined && cached.stamp === stamp) return cached.state
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    const state = { ...emptySessionState(defaultMode), error: 'ESTATE_CORRUPT', path, exists: true }
    cache.set(path, { stamp, state })
    return state
  }
  const { state, error } = normalizeSessionState(parsed, { defaultMode })
  const out = { ...state, ...(error === null ? {} : { error }), path, exists: true }
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
  await writeFileAtomic(path, JSON.stringify(state) + '\n')
  cache.delete(path)
  return readSessionState(v3Root, sessionId, { defaultMode: state.mode })
}