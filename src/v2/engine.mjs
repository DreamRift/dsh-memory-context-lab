/**
 * 引擎所有权：v2 是全插件唯一的引擎。
 *
 * 0.13.1 起 v1 引擎已移除，本文件不再做「双引擎互斥」判定——同一会话的模型
 * 可见投影只可能由 v2 持有或无人持有。判定以唯一权威文件为准：
 * `v2/sessions/<key>/engine.json`（存在且 `disabled === null`）。
 *
 * 历史遗留（0.13.0 及更早）：曾有一份 `v2/engines.json` 台账作为互斥加速索引，
 * 与 engine.json 构成两份真源。两份真源必然漂移——实测会话 c1787f24 里，v1 归档
 * 借道 v2 存储客户端时由 `V2SessionStore.init` 写入 engine.json，导致从未执行过
 * `/memory-lab` 的会话被判为 v2 持有，重启后 `/memory-lab on` 被 EV2ACTIVE 拒绝。
 * 0.13.1 删除台账，所有权只由 engine.json 表达。
 *
 * 不把本文件当作安全隔离：它防止的是「所有权标记与实际投影不一致」这一产品级
 * 错误状态，而不是任何安全边界。
 */

import { mkdir, readFile, rm } from 'node:fs/promises'
import { writeFileAtomic } from './appendable-ledger.mjs'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { sessionKeyFor } from '../storage.mjs'
import {
  ENGINE_FILE,
  ENGINE_V2_NAME,
  EngineV2Error,
  v2SessionDirectoryFor,
} from './store.mjs'
import { RECORDS_SCHEMA_VERSION } from './records.mjs'

const MANIFEST_FILE = 'manifest.json'
const V2_ENGINE_KIND = 'dsh-memory-context-lab/v2/engine'

async function readV2EngineState(labRoot, sessionId) {
  const file = path.join(v2SessionDirectoryFor(labRoot, sessionId), ENGINE_FILE)
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    if (parsed?.kind !== V2_ENGINE_KIND || parsed?.schemaVersion !== RECORDS_SCHEMA_VERSION) {
      return { file, exists: true, active: false, damaged: true }
    }
    return { file, exists: true, active: parsed.disabled === null, damaged: false }
  } catch (error) {
    if (error?.code === 'ENOENT') return { file, exists: false, active: false, damaged: false }
    return { file, exists: true, active: false, damaged: true }
  }
}

async function readManifestExists(labRoot, sessionId) {
  try {
    await readFile(path.join(v2SessionDirectoryFor(labRoot, sessionId), MANIFEST_FILE), 'utf8')
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    // 不可读按存在处理：宁可要求走完整停用流程，也不误删所有权标记。
    return true
  }
}

/**
 * 声明 v2 所有权：写 engine.json（`disabled: null`）。
 *
 * 声明后、init 前崩溃：重入 claim 得 EENGINEACTIVE，先 `releaseV2Engine` 清理。
 * 这是**唯一**写 engine.json 的启用路径——存储层 `V2SessionStore.init` 只在文件
 * 缺失时补建（用于无启用流程的裸存储访问），不再承担所有权声明语义。
 */
export async function claimV2Engine(labRoot, sessionId) {
  const v2State = await readV2EngineState(labRoot, sessionId)
  if (v2State.active) {
    throw new EngineV2Error('v2 引擎已激活本会话（engine.json active），不得重复声明。', {
      code: 'EENGINEACTIVE',
      details: { holder: 'v2' },
    })
  }
  if (v2State.damaged) {
    throw new EngineV2Error('v2 engine.json 存在但不可读或不符合 schema，无法确认所有权，拒绝声明。先修复或删除该文件。', {
      code: 'EENGINEDAMAGED',
      details: { file: v2State.file },
    })
  }

  // 所有权标记先行：此后任何时刻 engine.json 都反映 v2 是否持有投影。
  //
  // Y-03（beta.7 A 组）：这里必须走 writeFileAtomic（同仓 appendable-ledger 已实现
  // temp+rename+fsync）。旧的裸 writeFile 在崩溃时留下半截 JSON，而 readV2EngineState
  // 对解析失败报 damaged → claim/disable 双双 EENGINEDAMAGED，on/off 全废、
  // 只能手删文件才能恢复。同一份协议在仓里已有一份正确实现，就不该有第二份。
  const sessionDir = v2SessionDirectoryFor(labRoot, sessionId)
  await mkdir(sessionDir, { recursive: true })
  await writeFileAtomic(
    path.join(sessionDir, ENGINE_FILE),
    `${JSON.stringify({
      kind: V2_ENGINE_KIND,
      schemaVersion: RECORDS_SCHEMA_VERSION,
      engine: ENGINE_V2_NAME,
      sessionId,
      key: sessionKeyFor(sessionId),
      claimedAt: new Date().toISOString(),
      disabled: null,
    }, null, 2)}\n`,
    'utf8',
  )
  return { claimed: true, warnings: [], v2AlreadyInitialized: v2State.exists }
}

/**
 * 退出声明：
 * - 已初始化且仍激活的会话：拒绝，必须先走正式停用（写 disabled）。
 * - 从未初始化（无 manifest）的声明残留：删除 engine.json。
 */
export async function releaseV2Engine(labRoot, sessionId) {
  const v2State = await readV2EngineState(labRoot, sessionId)
  const warnings = []
  let released = false
  if (v2State.exists && !v2State.damaged && v2State.active) {
    const initialized = await readManifestExists(labRoot, sessionId)
    if (initialized) {
      throw new EngineV2Error(
        'v2 会话已初始化且处于激活状态；退出须先执行正式停用流程（写 disabled）。',
        { code: 'EENGINEACTIVE', details: { holder: 'v2' } },
      )
    }
    // 未初始化的声明残留：清理所有权标记。
    await rm(path.join(v2SessionDirectoryFor(labRoot, sessionId), ENGINE_FILE), { force: true })
    released = true
  }
  if (v2State.damaged) warnings.push('v2 engine.json 不可读；文件保留待人工处理')
  return { released, warnings }
}

/**
 * 正式停用：把 engine.json 的 `disabled` 置位（所有权标记转为「已停用」）。
 * 停用后数据只读保留，旧记录 ID 仍可回读。
 */
export async function disableV2Engine(labRoot, sessionId, reason) {
  const v2State = await readV2EngineState(labRoot, sessionId)
  if (!v2State.exists) {
    return { disabled: false, warnings: ['v2 引擎从未声明本会话，无需停用'] }
  }
  if (v2State.damaged) {
    throw new EngineV2Error('v2 engine.json 不可读，无法安全停用；先修复或删除该文件。', {
      code: 'EENGINEDAMAGED',
      details: { file: v2State.file },
    })
  }
  const warnings = []
  if (v2State.active) {
    const file = path.join(v2SessionDirectoryFor(labRoot, sessionId), ENGINE_FILE)
    const current = JSON.parse(await readFile(file, 'utf8'))
    await writeFileAtomic(
      file,
      `${JSON.stringify({
        ...current,
        disabled: {
          at: new Date().toISOString(),
          reason: typeof reason === 'string' && reason.trim() ? reason.trim() : null,
        },
      }, null, 2)}\n`,
      'utf8',
    )
  } else {
    warnings.push('v2 engine.json 已处于停用状态')
  }
  return { disabled: true, warnings }
}

/**
 * 同步所有权快照（供 index.mjs 热路径 guard 使用）。
 *
 * `holder` 只有两个取值：`'v2'`（engine.json 激活中）与 `null`（未持有）。
 * 文件损坏一律按「无法确认」报 `damaged`，调用方 fail-closed。
 */
export function getEngineRegistry(labRoot, sessionId) {
  const v2File = path.join(v2SessionDirectoryFor(labRoot, sessionId), ENGINE_FILE)
  let v2Active = false
  let damaged = false
  try {
    const parsed = JSON.parse(readFileSync(v2File, 'utf8'))
    if (parsed?.kind === V2_ENGINE_KIND && parsed?.schemaVersion === RECORDS_SCHEMA_VERSION) {
      v2Active = parsed.disabled === null
    } else {
      damaged = true
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') damaged = true
  }
  return { holder: v2Active ? 'v2' : null, v2Active, damaged }
}