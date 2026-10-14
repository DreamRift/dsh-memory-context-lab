/**
 * v1/v2 引擎互斥：同一会话的模型可见投影同一时刻只能由一种引擎负责。
 *
 * 判定以各自权威文件为准，注册表只是观测台账：
 * - v1 是否持有投影：v1 state.json（enabled === true）；
 * - v2 是否持有投影：v2 engine.json（存在且 disabled === null）。
 * 台账（engines.json）损坏不阻塞互斥判定，但与权威文件不一致时记录告警。
 *
 * 声明顺序：先写 engine.json（所有权标记），再写台账。两者之间崩溃时
 * engine.json 是权威，重入 claim 会得到 EENGINEACTIVE，恢复路径先 release。
 *
 * 不把本文件当作安全隔离：它防止的是「双引擎同时替换同一会话投影」这一
 * 产品级错误状态，而不是任何安全边界。
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { STATE_FILE } from '../core.mjs'
import { readSessionState, sessionDirectoryFor, sessionKeyFor } from '../storage.mjs'
import {
  ENGINE_FILE,
  ENGINE_V2_NAME,
  EngineV2Error,
  v2SessionDirectoryFor,
} from './store.mjs'
import { RECORDS_SCHEMA_VERSION } from './records.mjs'

const REGISTRY_KIND = 'dsh-memory-context-lab/v2/engines'
const REGISTRY_FILE = 'engines.json'
const MANIFEST_FILE = 'manifest.json'
const V1_SESSION_KIND = 'dsh-memory-context-lab/session'
const V2_ENGINE_KIND = 'dsh-memory-context-lab/v2/engine'

function registryFileFor(labRoot) {
  return path.join(path.resolve(labRoot), 'v2', REGISTRY_FILE)
}

async function readRegistry(labRoot) {
  const file = registryFileFor(labRoot)
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    if (parsed?.kind !== REGISTRY_KIND || parsed?.schemaVersion !== RECORDS_SCHEMA_VERSION) {
      return { file, claims: null, damaged: true }
    }
    return { file, claims: parsed.engines ?? {}, damaged: false }
  } catch (error) {
    if (error?.code === 'ENOENT') return { file, claims: null, damaged: false }
    return { file, claims: null, damaged: true }
  }
}

function writeRegistrySync(file, claims) {
  mkdirSync(path.dirname(file), { recursive: true })
  const payload = `${JSON.stringify({ kind: REGISTRY_KIND, schemaVersion: RECORDS_SCHEMA_VERSION, engines: claims }, null, 2)}\n`
  // 台账是互斥裁决的权威文件：同目录临时文件 + 原子 rename，读到半个 JSON 的
  // 进程会把它当 damaged 拒绝 v2 启用，比留下截断文件好不了多少；但写穿一半
  // 的旧文件在 rename 下不可能出现。
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(temp, payload, 'utf8')
  renameSync(temp, file)
}

function writeRegistry(file, claims) {
  return Promise.resolve().then(() => writeRegistrySync(file, claims))
}

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

/** 读取 v1 state.json；文件缺失按未持有处理，损坏向上抛（fail-closed）。 */
async function readV1State(labRoot, sessionId) {
  const loaded = await readSessionState(labRoot, sessionId)
  const state = loaded?.state ?? null
  const holds = !!state
    && state.kind === V1_SESSION_KIND
    && state.schemaVersion === 1
    && state.enabled === true
  return { state, holds }
}

/**
 * v2 激活前检查：v1 若仍持有本会话投影则拒绝。
 * v1 的权威状态是 state.json；v1 状态文件损坏时 readSessionState 抛错，本函数不吞。
 */
export async function assertV1AvailableForV2(labRoot, sessionId) {
  const { holds } = await readV1State(labRoot, sessionId)
  if (holds) {
    throw new EngineV2Error(
      'v1 引擎（维护版降温）仍持有本会话的模型可见投影。先用 /memory-lab off 退出 v1，再启用 v2；两种引擎不得同时替换同一会话投影。',
      { code: 'EV1ACTIVE', details: { holder: 'v1' } },
    )
  }
  return { v1Active: false }
}

/**
 * v2 激活：检查互斥、写 engine.json（disabled:null）并在台账登记。
 * 声明后、init 前崩溃：重入 claim 得 EENGINEACTIVE，先 releaseV2Engine 清理。
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
  await assertV1AvailableForV2(labRoot, sessionId)

  const registry = await readRegistry(labRoot)
  const claims = registry.claims ? { ...registry.claims } : {}
  const key = sessionKeyFor(sessionId)
  const warnings = []
  const existing = claims[key]
  if (existing?.engine === ENGINE_V2_NAME) {
    // 陈旧 v2 声明：权威文件（engine.json）说未激活，台账让位于权威，自动清理。
    delete claims[key]
    warnings.push('清理了台账中的陈旧 v2 声明（engine.json 未激活）')
  } else if (existing) {
    warnings.push(`覆盖台账中的旧声明（${existing.engine}）；互斥已按 v1 权威状态复核通过`)
  }
  if (registry.damaged) warnings.push('engines.json 不可读或不符合 schema，互斥判定已按各引擎权威文件执行')

  // 所有权标记先行：此后任何时刻 engine.json 都反映 v2 是否持有投影。
  const sessionDir = v2SessionDirectoryFor(labRoot, sessionId)
  await mkdir(sessionDir, { recursive: true })
  await writeFile(
    path.join(sessionDir, ENGINE_FILE),
    `${JSON.stringify({
      kind: V2_ENGINE_KIND,
      schemaVersion: RECORDS_SCHEMA_VERSION,
      engine: ENGINE_V2_NAME,
      sessionId,
      key,
      claimedAt: new Date().toISOString(),
      disabled: null,
    }, null, 2)}\n`,
    'utf8',
  )
  claims[key] = { engine: ENGINE_V2_NAME, sessionId, since: new Date().toISOString() }
  await writeRegistry(registry.file, claims)
  return { claimed: true, warnings, v2AlreadyInitialized: v2State.exists }
}

/**
 * v2 退出声明：
 * - 已初始化且仍激活的 v2 会话：拒绝，必须先走正式停用（V2Store.disableSession）。
 * - 从未初始化（无 manifest）的声明残留：删除 engine.json 并清台账。
 */
export async function releaseV2Engine(labRoot, sessionId) {
  const key = sessionKeyFor(sessionId)
  const v2State = await readV2EngineState(labRoot, sessionId)
  const warnings = []
  if (v2State.exists && !v2State.damaged && v2State.active) {
    const initialized = await readManifestExists(labRoot, sessionId)
    if (initialized) {
      throw new EngineV2Error(
        'v2 会话已初始化且处于激活状态；退出须先执行正式停用流程（写 disabled），再 release 台账。',
        { code: 'EENGINEACTIVE', details: { holder: 'v2' } },
      )
    }
    // 未初始化的声明残留：清理所有权标记。
    await rm(path.join(v2SessionDirectoryFor(labRoot, sessionId), ENGINE_FILE), { force: true })
  }
  if (v2State.damaged) warnings.push('v2 engine.json 不可读；仅清理台账，文件保留待人工处理')
  const registry = await readRegistry(labRoot)
  let released = false
  if (registry.claims?.[key]) {
    const claims = { ...registry.claims }
    delete claims[key]
    await writeRegistry(registry.file, claims)
    released = true
  }
  return { released, warnings }
}

/**
 * v2 正式停用：把 engine.json 的 `disabled` 置位（所有权标记转为「已停用」），
 * 同时清掉台账声明。停用后数据只读保留，旧记录 ID 仍可回读。
 *
 * 这是 `releaseV2Engine` 的前置：已初始化的会话必须先停用，再 release 台账。
 */
export async function disableV2Engine(labRoot, sessionId, reason) {
  const key = sessionKeyFor(sessionId)
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
    await writeFile(
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
    warnings.push('v2 engine.json 已处于停用状态，仅清理台账声明')
  }
  const registry = await readRegistry(labRoot)
  if (registry.claims?.[key]) {
    const claims = { ...registry.claims }
    delete claims[key]
    await writeRegistry(registry.file, claims)
  }
  return { disabled: true, warnings }
}

/**
 * v1 `on` 前检查：v2 若仍持有本会话投影则拒绝。
 * 权威判定直接读 v2 engine.json（台账损坏不构成放行理由）。
 */
export async function assertV2AllowsV1(labRoot, sessionId) {
  const v2State = await readV2EngineState(labRoot, sessionId)
  if (v2State.damaged) {
    // 「无法确认 v2 是否仍持有投影」不能当作「v2 没持有」。放行 v1 会让两个引擎
    // 同时改写同一会话投影，且 v2 侧同场景是拒绝的——方向必须对称，一律 fail-closed。
    throw new EngineV2Error(
      'v2 引擎状态文件损坏，无法确认本会话投影归属；拒绝 v1 接管。先修复或清理 v2 隔离根（v2 状态损坏不会被当作未启用）。',
      { code: 'EENGINEDAMAGED', details: { holder: 'unknown' } },
    )
  }
  if (v2State.active) {
    throw new EngineV2Error(
      'v2 引擎（全历史按需记忆化）仍持有本会话的模型可见投影。先用 v2 停用入口退出，再 /memory-lab on；两种引擎不得同时替换同一会话投影。',
      { code: 'EV2ACTIVE', details: { holder: 'v2' } },
    )
  }
  const registry = await readRegistry(labRoot)
  const key = sessionKeyFor(sessionId)
  let warning
  if (registry.claims?.[key]?.engine === ENGINE_V2_NAME && !v2State.active) {
    warning = '台账仍有 v2 声明但 engine.json 未激活，按无持有处理；建议先 release 清理台账'
  }
  return { allowed: true, warning }
}

/**
 * 同步互斥快照（供 index.mjs 热路径 guard 使用）：
 * holder = 'v2'：v2 engine.json 激活中；holder = 'v1'：v1 state enabled 且 v2 未激活。
 * 文件损坏一律按「无法确认」报 damaged，调用方 fail-closed。
 */
export function getEngineRegistry(labRoot, sessionId) {
  const v2File = path.join(v2SessionDirectoryFor(labRoot, sessionId), ENGINE_FILE)
  let v2Active = false
  let v2Damaged = false
  try {
    const parsed = JSON.parse(readFileSync(v2File, 'utf8'))
    if (parsed?.kind === V2_ENGINE_KIND && parsed?.schemaVersion === RECORDS_SCHEMA_VERSION) {
      v2Active = parsed.disabled === null
    } else {
      v2Damaged = true
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') v2Damaged = true
  }
  const v1File = path.join(sessionDirectoryFor(labRoot, sessionId), STATE_FILE)
  let v1Active = false
  let v1Damaged = false
  try {
    const parsed = JSON.parse(readFileSync(v1File, 'utf8'))
    if (parsed?.kind === V1_SESSION_KIND && parsed?.schemaVersion === 1) {
      v1Active = parsed.enabled === true
    } else {
      v1Damaged = true
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') v1Damaged = true
  }
  if (v2Active) return { holder: 'v2', v1Active, v2Active, damaged: v1Damaged || v2Damaged }
  if (v1Active) return { holder: 'v1', v1Active, v2Active, damaged: v1Damaged || v2Damaged }
  // 两边都未激活：若任一文件损坏，视作无法确认（fail-closed）。
  return { holder: null, v1Active, v2Active, damaged: v1Damaged || v2Damaged }
}
