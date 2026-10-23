/**
 * v2 引擎的会话状态文件（`<labRoot>/v2/sessions/<key>/state.json`）。
 *
 * 与 v1 的 state.json 形状一致（enabled/settings/archive/nodeClaims 等字段复用
 * 同一套语义），但 kind 独立为 `dsh-memory-context-lab/v2/session`：
 * - 两种引擎的持久账本互不覆盖，谁持有投影一目了然；
 * - 两个引擎的账本互不覆盖（0.13.1 起只剩 v2，历史 v1 目录不再被读取）；
 * - engine.json 只管互斥声明，状态文件才承载归档行与设置。
 */

import path from 'node:path'
import {
  readJsonStrict,
  sessionKeyFor,
  writeJsonAtomic,
} from '../storage.mjs'
import { EngineV2Error, InvalidArgumentError } from '../errors.mjs'

export const V2_STATE_KIND = 'dsh-memory-context-lab/v2/session'
export const V2_STATE_SCHEMA_VERSION = 2
export const V2_STATE_FILE = 'state.json'

/**
 * v2 状态文件损坏。
 *
 * 0.13.2-beta.6 G2：此前它 `extends Error` 且**没有 code**——「损坏」是本仓
 * 最需要被程序判别的状态（它决定要不要失败关闭），却是唯一不带 code 的错误类型。
 * 现在继承 EngineV2Error 并带 `ESTATEDAMAGED`，同时**保留 name 与
 * directory/reason 字段**，既有 `instanceof V2SessionStateDamagedError` 与
 * 读取 `.reason` 的调用方零改动。
 */
export class V2SessionStateDamagedError extends EngineV2Error {
  constructor(message, { directory, reason, code = 'ESTATEDAMAGED' } = {}) {
    super(message, { code, details: { directory, reason } })
    this.name = 'V2SessionStateDamagedError'
    this.directory = directory
    this.reason = reason
  }
}

export function v2SessionDirectoryFor(labRoot, sessionId) {
  return path.join(path.resolve(labRoot), 'v2', 'sessions', sessionKeyFor(sessionId))
}

/**
 * v2 会话状态的**必需字段清单**——唯一真源（0.13.2-beta.6 G4）。
 *
 * 收口前这张清单存在两份：本函数只校验 4 个字段（kind/schema/sessionId/enabled），
 * 而消费者各自裸取自己需要的那几个：
 *   - `runtime-render.mjs:35` 裸取 `record.state.archive.filter(…)`
 *   - `runtime-settings.mjs:52` 裸取 `record.state.settings` 后写属性
 *   - `apply-engine.mjs:230/762/1035` 裸取 `record.state.archive`
 * 于是「通过闸门」与「能安全使用」是两件事：一个缺 `archive` 的状态文件能
 * 通过 `isV2SessionState`，随后在 `status` 渲染时抛裸 `TypeError`
 * （`code` 为 undefined，store/p-08 W10/W11、p-09 W13/W14）。
 *
 * 修法不是给每个消费者加 `?? []`（那是「堵」：下一个消费者还会忘），
 * 而是把「哪些字段必须存在」变成**一张表**，闸门按表逐项校验，
 * 消费者按同一张表取默认值（`stateFieldDefaults`）。与 N-12 的
 * `NUMERIC_SETTINGS` 是同一手法：**定义一次，双方都读它**。
 *
 * 每项是 `[字段名, 校验函数, 缺失时的默认值]`。默认值只在**读**路径用
 * （`stateWithDefaults`）；写路径仍然失败关闭（不替调用方编一个 archive）。
 */
export const REQUIRED_STATE_FIELDS = Object.freeze([
  Object.freeze({ name: 'archive', check: (value) => Array.isArray(value), empty: () => [] }),
  Object.freeze({
    name: 'settings',
    check: (value) => value !== null && typeof value === 'object' && !Array.isArray(value),
    empty: () => ({}),
  }),
])

/**
 * 校验并列出**存在但非法**的字段（空数组 = 全部合格）。
 *
 * 为什么把「缺失」与「非法」分开：这两个判定此前是同一个分支，于是
 * 字段清单一旦变长，**旧版本账本**（字段是后来才加的）就会被判成损坏——
 * 旧账本明明可以按默认值补全继续用（`stateWithDefaults` 就能补），
 * 闸门却抛 ESTATEDAMAGED，让 /memory-lab on|off|restore 从「返回结构化结果」
 * 变成「从命令处理函数抛穿」。缺字段是**版本差**，坏字段才是**损坏**。
 */
export function missingStateFields(value) {
  const missing = []
  for (const field of REQUIRED_STATE_FIELDS) {
    const present = value !== null && typeof value === 'object' && field.name in value
    if (!present) missing.push(field.name)
  }
  return missing
}

export function stateFieldProblems(value) {
  const problems = []
  for (const field of REQUIRED_STATE_FIELDS) {
    const present = value !== null && typeof value === 'object' && field.name in value
    if (!present) continue
    if (!field.check(value[field.name])) problems.push(field.name)
  }
  return problems
}

/**
 * 读取用：补齐缺失字段的**空默认值**。
 *
 * 只用于「已经确认是合法状态、但要读某个字段」的场景。它不掩盖损坏——
 * 损坏由 `readV2SessionState` 在闸门处失败关闭；这里补的是**旧版本账本**
 * （字段是后来才加的）留下的空洞。
 */
export function stateWithDefaults(state) {
  if (state === null || typeof state !== 'object') return state
  let patched = state
  for (const field of REQUIRED_STATE_FIELDS) {
    if (!field.check(patched[field.name])) {
      if (patched === state) patched = { ...state }
      patched[field.name] = field.empty()
    }
  }
  return patched
}

/**
 * 闸门：一个 v2 会话状态文件是否**可安全使用**。
 *
 * 必需字段由 `REQUIRED_STATE_FIELDS` 决定，不再由本函数自己列一遍。
 */
export function isV2SessionState(value) {
  return Boolean(value)
    && typeof value === 'object'
    && value.kind === V2_STATE_KIND
    && value.schemaVersion === V2_STATE_SCHEMA_VERSION
    && typeof value.sessionId === 'string'
    && typeof value.enabled === 'boolean'
    && stateFieldProblems(value).length === 0
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
      throw new EngineV2Error('本会话 v2 引擎已在运行中。', { code: 'EALREADYON' })
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
  if (!isV2SessionState(state)) throw new InvalidArgumentError('拒绝写入无效的 v2 会话状态文件。')
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
