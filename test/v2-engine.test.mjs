/**
 * v2 引擎互斥测试：v1 目录收养、v2 声明互斥、v1 拒绝在 v2 会话上启动。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { ensureLabRoot, sessionKeyFor } from '../src/storage.mjs'
import { v2SessionDirectoryFor } from '../src/v2/store.mjs'
import {
  claimV2Engine,
  releaseV2Engine,
  getEngineRegistry,
  assertV2AllowsV1,
} from '../src/v2/engine.mjs'

const SESSION_ID = 'a1b2c3d4e5f6a7b8c9d0e1f2'
const OTHER_SESSION = 'b1b2c3d4e5f6a7b8c9d0e1f2'

async function makeLabRoot(name, { withV1State = false } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), `mclv2eng-${name}-`))
  await ensureLabRoot(root)
  if (withV1State) {
    const sessionDir = path.join(root, 'sessions', sessionKeyFor(SESSION_ID))
    await mkdir(sessionDir, { recursive: true })
    await writeFile(path.join(sessionDir, 'state.json'), JSON.stringify({
      kind: 'dsh-memory-context-lab/session',
      schemaVersion: 1,
      sessionId: SESSION_ID,
      createdAt: '2026-10-11T12:00:00.000Z',
      enabled: true,
      archive: [],
    }), 'utf8')
  }
  return root
}

const cleanup = (root) => rm(root, { recursive: true, force: true })

test('v1 会话存在 → v2 拒绝声明（不得双引擎同时接管同一投影）', async () => {
  const root = await makeLabRoot('v1-block', { withV1State: true })
  try {
    await assert.rejects(
      () => claimV2Engine(root, SESSION_ID),
      (error) => error.code === 'EV1ACTIVE',
    )
    // 拒绝后不得留下声明文件
    const key = path.join(v2SessionDirectoryFor(root, SESSION_ID), 'engine.json')
    await assert.rejects(() => import('node:fs/promises').then((fs) => fs.readFile(key)), { code: 'ENOENT' })
  } finally {
    await cleanup(root)
  }
})

test('无 v1 状态 → v2 声明成功、重复声明互斥、释放后可再声明', async () => {
  const root = await makeLabRoot('v2-claim')
  try {
    const claimed = await claimV2Engine(root, SESSION_ID)
    assert.equal(claimed.claimed, true)
    assert.deepEqual(getEngineRegistry(root, SESSION_ID).holder, 'v2')

    await assert.rejects(
      () => claimV2Engine(root, SESSION_ID),
      (error) => error.code === 'EENGINEACTIVE',
    )

    await assert.rejects(
      () => assertV2AllowsV1(root, SESSION_ID),
      (error) => error.code === 'EV2ACTIVE',
    )

    await releaseV2Engine(root, SESSION_ID)
    assert.equal(getEngineRegistry(root, SESSION_ID).holder, null)
    const again = await claimV2Engine(root, SESSION_ID)
    assert.equal(again.claimed, true)
    await releaseV2Engine(root, SESSION_ID)
  } finally {
    await cleanup(root)
  }
})

test('互斥按会话隔离：不同会话互不影响', async () => {
  const root = await makeLabRoot('isolation')
  try {
    await claimV2Engine(root, SESSION_ID)
    // 另一会话无 v1 状态，可以声明
    const other = await claimV2Engine(root, OTHER_SESSION)
    assert.equal(other.claimed, true)
    // v1 在其他会话仍允许
    await assert.doesNotReject(() => assertV2AllowsV1(root, 'c1b2c3d4e5f6a7b8c9d0e1f2'))
    await releaseV2Engine(root, SESSION_ID)
    await releaseV2Engine(root, OTHER_SESSION)
  } finally {
    await cleanup(root)
  }
})
