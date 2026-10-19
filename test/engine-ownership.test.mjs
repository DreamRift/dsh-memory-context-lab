/**
 * 0.13.1 守卫：引擎归属只由 engine.json 表达（F1）。
 *
 * ## 缺陷（实测会话 c1787f24）
 * 该会话从未执行过 `/memory-lab2`，但 `getEngineRegistry` 返回
 * `{holder:'v2', v1Active:true}`。根因是 v1 归档借道 v2 存储客户端：
 * `ensureClient()` → `createV2ClientFactory` → `V2SessionStore.init()` 在无
 * engine.json 时**补建**了它，并写死 `engine:'full-history-v2'`。
 * 后果：重启后 `/memory-lab on` 被 EV2ACTIVE 拒绝，用户「关不掉也开不回来」。
 *
 * ## 判据来源
 * 会话 c1787f24 的 `state.json`（createdAt 04:58:40，v1 启用）与
 * `engine.json`（createdAt 05:12:11，晚 13 分钟，第一次归档时创建）。
 *
 * ## 断言组
 * 1. 未声明时 holder 为 null（未启用 ≠ 已启用）；
 * 2. 声明后 holder 为 v2；
 * 3. **v2 目录里不存在 engines.json 台账**（双真源已删除）；
 * 4. 遗留的 v1 state.json 不改变 holder。
 *
 * ## 不适用条件与已知边界
 * 本守卫不覆盖「v1 归档不得写 engine.json」这一历史路径——v1 引擎已删除，
 * 该路径不存在。它只断言**当前**归属判定不会因为遗留文件而漂移。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { ensureLabRoot, sessionKeyFor } from '../src/storage.mjs'
import { v2SessionDirectoryFor } from '../src/v2/store.mjs'
import { claimV2Engine, getEngineRegistry, releaseV2Engine } from '../src/v2/engine.mjs'

const SESSION_ID = 'f1e2d3c4b5a6978877665544'

async function withLab(fn) {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-own-'))
  await ensureLabRoot(root)
  try {
    return await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('F1a 未声明时 holder 为 null（未启用 ≠ 已启用）', async () => {
  await withLab(async (root) => {
    const registry = getEngineRegistry(root, SESSION_ID)
    assert.equal(registry.holder, null)
    assert.equal(registry.damaged, false)
  })
})

test('F1b 声明后 holder 为 v2，释放后归 null', async () => {
  await withLab(async (root) => {
    await claimV2Engine(root, SESSION_ID)
    assert.equal(getEngineRegistry(root, SESSION_ID).holder, 'v2')
    await releaseV2Engine(root, SESSION_ID)
    assert.equal(getEngineRegistry(root, SESSION_ID).holder, null)
  })
})

test('F1c 遗留的 v1 state.json 不改变归属判定', async () => {
  await withLab(async (root) => {
    // 复刻 c1787f24 的磁盘形态：v1 账本存在且 enabled:true，但没有 engine.json。
    const legacyDir = path.join(root, 'sessions', sessionKeyFor(SESSION_ID))
    await mkdir(legacyDir, { recursive: true })
    await writeFile(path.join(legacyDir, 'state.json'), JSON.stringify({
      kind: 'dsh-memory-context-lab/session',
      schemaVersion: 1,
      sessionId: SESSION_ID,
      enabled: true,
      archive: [],
    }), 'utf8')

    assert.equal(getEngineRegistry(root, SESSION_ID).holder, null, 'v1 账本不得让会话被判为已持有')
  })
})

test('F1d 不存在 engines.json 台账（双真源已删除）', async () => {
  await withLab(async (root) => {
    await claimV2Engine(root, SESSION_ID)
    const registryFile = path.join(root, 'v2', 'engines.json')
    await assert.rejects(() => readFile(registryFile, 'utf8'), { code: 'ENOENT' },
      '0.13.1 已删除台账：所有权只由 engine.json 表达')
    const engineFile = path.join(v2SessionDirectoryFor(root, SESSION_ID), 'engine.json')
    const parsed = JSON.parse(await readFile(engineFile, 'utf8'))
    assert.equal(parsed.disabled, null, '声明即 disabled:null')
  })
})
