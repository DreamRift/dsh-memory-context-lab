/**
 * 会话控制文件（adapters/storage）：`<v3Root>/sessions/<sessionKey>/control.json`。
 *
 * 读路径在 `agent/pre-step` 每步都会调用，所以：
 * - 用同步 stat + 小缓存（mtimeMs:size）避免每步读盘；
 * - 文件不存在 = 默认全开（不是错误）；损坏/不可读 = 默认 + error（状态面可见，
 *   不把「控制文件坏了」静默成「用户关掉了」）。
 *
 * 写路径走 `writeFileAtomic`（temp+rename+fsync），与 v3 其它结构文件同一实现。
 * 目录键与 session-store 完全一致：正常 id 用 isolation key；非常规 id 用同样的
 * `hash-<sha256 前 16>` 兜底（否则控制文件会落到冷库目录之外）。
 */
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { sessionIsolationKey } from '../../domain/session/isolation-key.mjs'
import { emptySessionControl, normalizeSessionControl } from '../../domain/session/session-control.mjs'
import { writeFileAtomic } from './session-store.mjs'
import { sessionDirFresh } from './session-file-gate.mjs'

const FILE = 'control.json'
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
  // B3-9（AUD50-04-04）：目录级新鲜闸门——目录 mtime 没变（本仓库写入都走 temp+rename）
  // 时直接用进程内缓存，0 次文件 stat；变了才走下面的逐文件戳校验。
  if (sessionDirFresh(dirname(path))) {
    const cached = cache.get(path)
    if (cached !== undefined) return cached.control
  }
  let stamp
  try {
    const stat = statSync(path)
    stamp = stat.mtimeMs + ':' + stat.size
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      return { ...fallback(), error: 'ECONTROL_UNREADABLE' }
    }
    // B3-9：ENOENT 也进缓存（stamp=null 哨兵）——「文件不存在」是稳定状态，闸门命中时
    // 直接返回，不再每 tick 付一次 ENOENT stat；文件之后出现时目录 mtime 变化必然触发全路径。
    cache.set(path, { stamp: null, control: fallback() })
    return fallback()
  }
  const cached = cache.get(path)
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
  const { control, error } = normalizeSessionControl(parsed, { defaultEnabled })
  const out = { ...control, ...(error === null ? {} : { error }), path }
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
  await writeFileAtomic(path, JSON.stringify(control) + '\n')
  cache.delete(path)
  return readSessionControl(v3Root, sessionId)
}


