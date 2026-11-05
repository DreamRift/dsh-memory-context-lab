/**
 * I6-3 迁移/回滚失败关闭合同守卫。
 * 边界：本守卫验证 state/control 的结构化拒绝与源字节保护，不证明真实宿主迁移或用户回滚完成。
 * 缺失 schemaVersion 按 P2 裁决以 legacy-v1 语义兼容读取，并返回非持久化诊断；读取不改原字节，显式非 1 仍失败关闭。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { normalizeSessionState } from '../src/v3/domain/session/mode.mjs'
import { normalizeSessionControl } from '../src/v3/domain/session/session-control.mjs'
import { readSessionState, sessionStatePath, updateSessionState, writeSessionState } from '../src/v3/adapters/storage/session-state.mjs'
import { readSessionControl, sessionControlPath, updateSessionControl, writeSessionControl } from '../src/v3/adapters/storage/session-control.mjs'
import { createStatusProjectionDefinition, STATUS_PROJECTION_VERSION } from '../src/v3/adapters/host/status-projection.mjs'

const state = () => ({ schemaVersion: 1, mode: 'recall-only', modeSource: 'default', planFirst: false, autoRestore: true, pins: [], readLease: [], surface: { lastArchiveEndSeq: -1, lastArchiveAt: null }, planFloorSeq: null, cooling: { open: false, lastOccupancy: null, lastRunAt: null, lastReason: null }, provider: { tier: 'T1', reason: 'local' }, updatedAt: 1 })
const control = () => ({ schemaVersion: 1, enabled: true, recall: true, overrides: { limit: 4 }, updatedAt: 1 })

async function withRoot(fn) {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-i6-'))
  try { await fn(root) } finally { await rm(root, { recursive: true, force: true }) }
}

async function assertStateReject(root, raw, id = 's') {
  const file = sessionStatePath(root, id)
  await mkdir(path.dirname(file), { recursive: true })
  const bytes = JSON.stringify(raw) + '\n'
  await writeFile(file, bytes, 'utf8')
  const out = await updateSessionState(root, id, { planFirst: true })
  assert.match(out.error ?? '', /^ESTATE_/)
  assert.equal(await readFile(file, 'utf8'), bytes)
}

async function assertControlReject(root, raw, id = 'c') {
  const file = sessionControlPath(root, id)
  await mkdir(path.dirname(file), { recursive: true })
  const bytes = JSON.stringify(raw) + '\n'
  await writeFile(file, bytes, 'utf8')
  const out = await updateSessionControl(root, id, { enabled: false })
  assert.match(out.error ?? '', /^ECONTROL_/)
  assert.equal(await readFile(file, 'utf8'), bytes)
}

test('§2-1 state futureField：更新与直接写入都拒绝且原字节不变', async () => withRoot(async (root) => {
  await assertStateReject(root, { ...state(), futureField: 'opaque' })
  const file = sessionStatePath(root, 'direct-state')
  await mkdir(path.dirname(file), { recursive: true })
  const bytes = JSON.stringify(state()) + '\n'
  await writeFile(file, bytes, 'utf8')
  await assert.rejects(writeSessionState(root, 'direct-state', { ...state(), futureField: true }), { code: 'ESTATE_UNKNOWN_KEY' })
  assert.equal(await readFile(file, 'utf8'), bytes)
}))

test('state direct write：识别 readSessionState wrapper 并仅剥离包装键', async () => withRoot(async (root) => {
  const id = 'read-wrapper'
  const file = sessionStatePath(root, id)
  await mkdir(path.dirname(file), { recursive: true })
  const known = state()
  // 本测试固定 wrapper 剥离行为；若将来 schema 把 path/exists/error 定义为真实字段，必须同步调整剥离逻辑，否则会静默丢弃。
  const returned = { ...known, path: file, exists: true, error: 'ESTATE_CORRUPT' }
  await writeSessionState(root, id, returned)
  const persisted = JSON.parse(await readFile(file, 'utf8'))
  assert.deepEqual(persisted, known)
  for (const key of ['path', 'exists', 'error']) assert.equal(Object.hasOwn(persisted, key), false)

  const before = await readFile(file, 'utf8')
  await assert.rejects(writeSessionState(root, id, { ...known, path: 'not-the-state-path', exists: true, error: 'ESTATE_CORRUPT' }), { code: 'ESTATE_UNKNOWN_KEY' })
  assert.equal(await readFile(file, 'utf8'), before)
}))

test('read wrapper 回写剥离 schemaVersionMissing；非 wrapper 仍拒绝', async () => withRoot(async (root) => {
  const stateId = 'diagnostic-state'
  const stateFile = sessionStatePath(root, stateId)
  const legacyState = Object.fromEntries(Object.entries(state()).filter(([key]) => key !== 'schemaVersion'))
  await mkdir(path.dirname(stateFile), { recursive: true })
  await writeFile(stateFile, JSON.stringify(legacyState) + '\n', 'utf8')
  const stateRead = readSessionState(root, stateId)
  assert.equal(stateRead.schemaVersionMissing, true)
  await writeSessionState(root, stateId, stateRead)
  assert.equal((await readFile(stateFile, 'utf8')).includes('schemaVersionMissing'), false)
  await assert.rejects(writeSessionState(root, 'plain-state', { ...state(), schemaVersionMissing: true }), { code: 'ESTATE_UNKNOWN_KEY' })

  const controlId = 'diagnostic-control'
  const controlFile = sessionControlPath(root, controlId)
  const legacyControl = Object.fromEntries(Object.entries(control()).filter(([key]) => key !== 'schemaVersion'))
  await mkdir(path.dirname(controlFile), { recursive: true })
  await writeFile(controlFile, JSON.stringify(legacyControl) + '\n', 'utf8')
  const controlRead = readSessionControl(root, controlId)
  assert.equal(controlRead.schemaVersionMissing, true)
  await writeSessionControl(root, controlId, controlRead)
  assert.equal((await readFile(controlFile, 'utf8')).includes('schemaVersionMissing'), false)
  await assert.rejects(writeSessionControl(root, 'plain-control', { ...control(), schemaVersionMissing: true }), { code: 'ECONTROL_UNKNOWN_KEY' })
}))

test('§2-2 control 未知顶层键：更新与直接写入都拒绝且原字节不变', async () => withRoot(async (root) => {
  await assertControlReject(root, { ...control(), futureField: true })
  const file = sessionControlPath(root, 'direct-control')
  await mkdir(path.dirname(file), { recursive: true })
  const bytes = JSON.stringify(control()) + '\n'
  await writeFile(file, bytes, 'utf8')
  await assert.rejects(writeSessionControl(root, 'direct-control', { ...control(), futureField: true }), { code: 'ECONTROL_UNKNOWN_KEY' })
  assert.equal(await readFile(file, 'utf8'), bytes)
}))
test('§2-3 control.overrides 未知键：更新拒绝且原字节不变', async () => withRoot((root) => assertControlReject(root, { ...control(), overrides: { ...control().overrides, futureOverride: 2 } })))
test('§2-4 state surface/cooling/provider/readLease 未知嵌套键：逐类拒绝且字节不变', async () => withRoot(async (root) => {
  const cases = [{ ...state(), surface: { ...state().surface, futureSurface: 1 } }, { ...state(), cooling: { ...state().cooling, futureCooling: 1 } }, { ...state(), provider: { ...state().provider, futureProvider: 1 } }, { ...state(), readLease: [{ recordId: 'r', expiresAt: 10, futureLeaseField: true }] }]
  for (const [index, raw] of cases.entries()) await assertStateReject(root, raw, 'nested-' + index)
}))
test('§2-5 非1 schemaVersion 拒绝；缺版本保留既有兼容并提 CR', async () => withRoot(async (root) => {
  await assertStateReject(root, { ...state(), schemaVersion: 99 }, 'future-state')
  await assertControlReject(root, { ...control(), schemaVersion: 99 }, 'future-control')
  assert.equal(readSessionState(root, 'future-state').error, 'ESTATE_VERSION')
  assert.equal(readSessionControl(root, 'future-control').error, 'ECONTROL_VERSION')
  const oldState = Object.fromEntries(Object.entries(state()).filter(([key]) => key !== 'schemaVersion'))
  const oldControl = Object.fromEntries(Object.entries(control()).filter(([key]) => key !== 'schemaVersion'))
  const stateFile = sessionStatePath(root, 'missing-state')
  const controlFile = sessionControlPath(root, 'missing-control')
  await mkdir(path.dirname(stateFile), { recursive: true })
  await mkdir(path.dirname(controlFile), { recursive: true })
  const stateBytes = JSON.stringify(oldState) + '\n'
  const controlBytes = JSON.stringify(oldControl) + '\n'
  await writeFile(stateFile, stateBytes, 'utf8')
  await writeFile(controlFile, controlBytes, 'utf8')
  const missingStateRead = readSessionState(root, 'missing-state')
  const missingControlRead = readSessionControl(root, 'missing-control')
  assert.equal(missingStateRead.error, undefined)
  assert.equal(missingStateRead.schemaVersionMissing, true)
  assert.equal(missingControlRead.error, undefined)
  assert.equal(missingControlRead.schemaVersionMissing, true)
  assert.equal(await readFile(stateFile, 'utf8'), stateBytes)
  assert.equal(await readFile(controlFile, 'utf8'), controlBytes)

  const versionedStateFile = sessionStatePath(root, 'versioned-state')
  const versionedControlFile = sessionControlPath(root, 'versioned-control')
  await mkdir(path.dirname(versionedStateFile), { recursive: true })
  await mkdir(path.dirname(versionedControlFile), { recursive: true })
  await writeFile(versionedStateFile, JSON.stringify(state()) + '\n', 'utf8')
  await writeFile(versionedControlFile, JSON.stringify(control()) + '\n', 'utf8')
  assert.equal(readSessionState(root, 'versioned-state').schemaVersionMissing, false)
  assert.equal(readSessionControl(root, 'versioned-control').schemaVersionMissing, false)
}))
test('§2-6 损坏/非对象/不可读：更新或初始化不得覆写', async () => withRoot(async (root) => {
  const file = sessionStatePath(root, 'broken')
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, '{broken bytes', 'utf8')
  const prior = await readFile(file, 'utf8')
  const out = await updateSessionState(root, 'broken', { planFirst: true })
  assert.equal(out.error, 'ESTATE_CORRUPT')
  assert.equal(await readFile(file, 'utf8'), prior)
  const badStateShape = normalizeSessionState([])
  const badControlShape = normalizeSessionControl([])
  assert.equal(badStateShape.error, 'ESTATE_SHAPE')
  assert.equal(badControlShape.error, 'ECONTROL_SHAPE')
  assert.equal(Object.hasOwn(badStateShape, 'schemaVersionMissing'), false)
  assert.equal(Object.hasOwn(badControlShape, 'schemaVersionMissing'), false)
}))
test('§2-7 未知 mode：拒绝更新并保留原件', async () => withRoot(async (root) => {
  const raw = { ...state(), mode: 'future-mode' }
  assert.equal(normalizeSessionState(raw).error, 'ESTATE_MODE')
  await assertStateReject(root, raw, 'future-mode')
}))
test('§2-8 未知 modeSource/provider tier：拒绝更新且保留原件', async () => withRoot(async (root) => {
  const unknownSource = { ...state(), modeSource: 'future-source' }
  const unknownTier = { ...state(), provider: { tier: 'T9', reason: 'x' } }
  assert.equal(normalizeSessionState(unknownSource).error, 'ESTATE_MODE_SOURCE')
  assert.equal(normalizeSessionState(unknownTier).error, 'ESTATE_PROVIDER')
  await assertStateReject(root, unknownSource, 'future-source')
  await assertStateReject(root, unknownTier, 'future-tier')
}))
test('§2-9 stateVersion 99 不适配旧检查点；未知视图状态 failed', () => {
  const definition = createStatusProjectionDefinition({ statusOf: () => ({ state: 'future-state' }) })
  assert.equal(definition.stateVersion, STATUS_PROJECTION_VERSION)
  assert.equal(STATUS_PROJECTION_VERSION, 3)
  const view = definition.wire.view({ sessionId: 's', tick: 99 })
  assert.equal(view.state, 'failed')
  assert.equal(view.errorCode, 'ESTATUS_STATE')
  assert.notEqual(view.state, 'ready')
})
test('§3 回滚判据：失败禁止继续写且字节不变', async () => withRoot(async (root) => {
  const raw = { ...state(), futureField: true }
  await assertStateReject(root, raw, 'rollback-stop')
  const file = sessionStatePath(root, 'rollback-stop')
  const before = await readFile(file, 'utf8')
  const out = readSessionState(root, 'rollback-stop')
  assert.equal(out.error, 'ESTATE_UNKNOWN_KEY')
  assert.equal(await readFile(file, 'utf8'), before)
}))
test('§4 停止条件：未知版本拒绝更新，原件保留诊断码', async () => withRoot(async (root) => {
  await assertControlReject(root, { ...control(), schemaVersion: 99 }, 'stop-unknown-version')
  assert.equal(readSessionControl(root, 'stop-unknown-version').error, 'ECONTROL_VERSION')
}))
// ─────────────────────────────────────────────────────────────────────────────
// I6 合同 §2 规则 5.3「写入时机受限」：成功的普通业务更新可以在其正常原子写入中写出
// schemaVersion: 1；不得在读取、启动或初始化路径单独自动修复/重写缺版本文件。
//
// 口径说明（诚实交代）：updateSessionState / updateSessionControl 的「落盘带版本」在改前
// 就已成立——patchSessionState / patchSessionControl 从 emptySessionState / emptySessionControl
// 摊开对象，而这两个 empty* **本身含 schemaVersion: 1**。所以只断言 update* 会得到「改前也绿」
// 的假绿。下面每条都另配一条**写原语级**断言（writeSessionState / writeSessionControl 直写
// 缺版本 payload）——那一条在改前必红，是真正的判别式。
// ─────────────────────────────────────────────────────────────────────────────

const withoutVersion = (obj) => Object.fromEntries(Object.entries(obj).filter(([key]) => key !== 'schemaVersion'))

test('§2 规则 5.3-1 state：缺版本文件经普通业务更新落盘含 schemaVersion: 1；读路径不触发修复', async () => withRoot(async (root) => {
  const id = 'rule53-state-update'
  const file = sessionStatePath(root, id)
  await mkdir(path.dirname(file), { recursive: true })
  const legacyBytes = JSON.stringify({ mode: 'recall-only' }) + '\n'
  await writeFile(file, legacyBytes, 'utf8')

  // 读：带诊断、不写盘。连读两次证明「读不修复」不是一次性偶然。
  const firstRead = readSessionState(root, id)
  assert.equal(firstRead.error, undefined)
  assert.equal(firstRead.schemaVersionMissing, true)
  readSessionState(root, id)
  assert.equal(await readFile(file, 'utf8'), legacyBytes, '读取路径不得重写缺版本文件')

  // 普通业务更新：正常原子写里补上版本。
  const updated = await updateSessionState(root, id, { planFirst: true })
  assert.equal(updated.error, undefined)
  assert.equal(updated.exists, true)
  const persistedText = await readFile(file, 'utf8')
  const persisted = JSON.parse(persistedText)
  assert.equal(persisted.schemaVersion, 1)
  assert.equal(persisted.mode, 'recall-only', '更新不得改变既有 mode')
  assert.equal(persisted.planFirst, true, '普通业务字段必须真的落盘')
  assert.equal(persistedText.includes('schemaVersionMissing'), false, '诊断不得进磁盘')
  assert.equal(readSessionState(root, id).schemaVersionMissing, false)
}))

test('§2 规则 5.3-2 state 写原语：缺版本 payload 直写也落 schemaVersion: 1（改前落盘缺版本）', async () => withRoot(async (root) => {
  const id = 'rule53-state-direct'
  const file = sessionStatePath(root, id)
  await mkdir(path.dirname(file), { recursive: true })
  const payload = withoutVersion({ ...state(), mode: 'cooling', provider: { tier: 'T2', reason: 'isolated' }, updatedAt: 5 })
  assert.equal(Object.hasOwn(payload, 'schemaVersion'), false)
  await writeSessionState(root, id, payload)
  const persistedText = await readFile(file, 'utf8')
  assert.equal(JSON.parse(persistedText).schemaVersion, 1, '写路径必须补版本，任调用方手写 payload 都不例外')
  assert.equal(persistedText.includes('schemaVersionMissing'), false)
  assert.equal(readSessionState(root, id).schemaVersionMissing, false)
  assert.equal(JSON.parse(persistedText).provider.tier, 'T2', '补版本不得覆盖业务字段')
}))

test('§2 规则 5.3-3 control：缺版本文件经普通业务更新落盘含 schemaVersion: 1；读路径不触发修复', async () => withRoot(async (root) => {
  const id = 'rule53-control-update'
  const file = sessionControlPath(root, id)
  await mkdir(path.dirname(file), { recursive: true })
  const legacyBytes = JSON.stringify({ enabled: true, recall: true }) + '\n'
  await writeFile(file, legacyBytes, 'utf8')

  const firstRead = readSessionControl(root, id)
  assert.equal(firstRead.error, undefined)
  assert.equal(firstRead.schemaVersionMissing, true)
  readSessionControl(root, id)
  assert.equal(await readFile(file, 'utf8'), legacyBytes, '读取路径不得重写缺版本控制文件')

  const updated = await updateSessionControl(root, id, { enabled: false })
  assert.equal(updated.error, undefined)
  const persistedText = await readFile(file, 'utf8')
  const persisted = JSON.parse(persistedText)
  assert.equal(persisted.schemaVersion, 1)
  assert.equal(persisted.enabled, false, '普通业务字段必须真的落盘')
  assert.equal(persisted.recall, true, '更新不得改变既有 recall')
  assert.equal(persistedText.includes('schemaVersionMissing'), false, '诊断不得进磁盘')
  assert.equal(readSessionControl(root, id).schemaVersionMissing, false)
}))

test('§2 规则 5.3-4 control 写原语：缺版本 payload 直写也落 schemaVersion: 1（改前落盘缺版本）', async () => withRoot(async (root) => {
  const id = 'rule53-control-direct'
  const file = sessionControlPath(root, id)
  await mkdir(path.dirname(file), { recursive: true })
  const payload = withoutVersion({ ...control(), enabled: false, overrides: { limit: 7 }, updatedAt: 5 })
  assert.equal(Object.hasOwn(payload, 'schemaVersion'), false)
  await writeSessionControl(root, id, payload)
  const persistedText = await readFile(file, 'utf8')
  assert.equal(JSON.parse(persistedText).schemaVersion, 1)
  assert.equal(persistedText.includes('schemaVersionMissing'), false)
  assert.equal(readSessionControl(root, id).schemaVersionMissing, false)
  const persisted = JSON.parse(persistedText)
  assert.equal(persisted.overrides.limit, 7, '补版本不得覆盖 overrides')
  assert.equal(persisted.enabled, false)
}))

test('§2 规则 5.3-5 已是版本 1：更新后仍为 1，业务字段正确且幂等', async () => withRoot(async (root) => {
  const stateId = 'rule53-versioned-state'
  const stateFile = sessionStatePath(root, stateId)
  await mkdir(path.dirname(stateFile), { recursive: true })
  const seeded = {
    ...state(),
    mode: 'cooling',
    modeSource: 'explicit',
    pins: ['v3r-keep'],
    surface: { lastArchiveEndSeq: 7, lastArchiveAt: 1000 },
    planFloorSeq: 3,
    provider: { tier: 'T2', reason: 'isolated' },
    updatedAt: 1,
  }
  await writeFile(stateFile, JSON.stringify(seeded) + '\n', 'utf8')
  assert.equal(readSessionState(root, stateId).schemaVersionMissing, false)

  await updateSessionState(root, stateId, { planFirst: true })
  const once = JSON.parse(await readFile(stateFile, 'utf8'))
  assert.equal(once.schemaVersion, 1, '已版本 1 的文件更新后仍是 1')
  assert.equal(once.planFirst, true)
  assert.equal(once.mode, 'cooling')
  assert.equal(once.modeSource, 'explicit')
  assert.deepEqual(once.pins, ['v3r-keep'])
  assert.deepEqual(once.surface, { lastArchiveEndSeq: 7, lastArchiveAt: 1000 })
  assert.equal(once.planFloorSeq, 3)
  assert.deepEqual(once.provider, { tier: 'T2', reason: 'isolated' })

  // 幂等：第二次同样 patch 只应体现 updatedAt 变化，版本不重复包装、不退化。
  await updateSessionState(root, stateId, { planFirst: true })
  const twice = JSON.parse(await readFile(stateFile, 'utf8'))
  assert.equal(twice.schemaVersion, 1)
  const strip = (obj) => { const { updatedAt: _updatedAt, ...rest } = obj; return rest }
  assert.deepEqual(strip(twice), strip(once), '重复更新除 updatedAt 外不得产生字节差')
  assert.equal(typeof twice.updatedAt, 'number')

  const controlId = 'rule53-versioned-control'
  const controlFile = sessionControlPath(root, controlId)
  await mkdir(path.dirname(controlFile), { recursive: true })
  await writeFile(controlFile, JSON.stringify({ ...control(), overrides: { limit: 4 } }) + '\n', 'utf8')
  await updateSessionControl(root, controlId, { enabled: false })
  const controlOnce = JSON.parse(await readFile(controlFile, 'utf8'))
  assert.equal(controlOnce.schemaVersion, 1)
  assert.equal(controlOnce.enabled, false)
  assert.deepEqual(controlOnce.overrides, { limit: 4 }, '更新不得丢 overrides')
  await updateSessionControl(root, controlId, { recall: false })
  const controlTwice = JSON.parse(await readFile(controlFile, 'utf8'))
  assert.equal(controlTwice.schemaVersion, 1)
  assert.equal(controlTwice.enabled, false)
  assert.equal(controlTwice.recall, false)
  assert.deepEqual(controlTwice.overrides, { limit: 4 })
}))

test('§2 规则 5.3-6 显式非 1 版本仍然拒绝：补版本不得把 99 洗成 1', async () => withRoot(async (root) => {
  // 写路径注入只在 schemaVersion === undefined 时生效；显式非 1 必须原样进入校验并失败关闭。
  const stateFile = sessionStatePath(root, 'rule53-explicit-99-state')
  await mkdir(path.dirname(stateFile), { recursive: true })
  const bytes = JSON.stringify({ ...state(), schemaVersion: 99 }) + '\n'
  await writeFile(stateFile, bytes, 'utf8')
  await assert.rejects(writeSessionState(root, 'rule53-explicit-99-state', { ...state(), schemaVersion: 99 }), { code: 'ESTATE_VERSION' })
  assert.equal(await readFile(stateFile, 'utf8'), bytes)
  assert.equal(readSessionState(root, 'rule53-explicit-99-state').error, 'ESTATE_VERSION')

  const controlFile = sessionControlPath(root, 'rule53-explicit-99-control')
  await mkdir(path.dirname(controlFile), { recursive: true })
  const controlBytes = JSON.stringify({ ...control(), schemaVersion: 99 }) + '\n'
  await writeFile(controlFile, controlBytes, 'utf8')
  await assert.rejects(writeSessionControl(root, 'rule53-explicit-99-control', { ...control(), schemaVersion: 99 }), { code: 'ECONTROL_VERSION' })
  assert.equal(await readFile(controlFile, 'utf8'), controlBytes)
  assert.equal(readSessionControl(root, 'rule53-explicit-99-control').error, 'ECONTROL_VERSION')
}))

