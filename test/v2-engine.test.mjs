/**
 * 引擎所有权测试（0.13.1 单引擎）。
 *
 * 0.13.1 起 v1 引擎已移除，本文件只验证 v2 的所有权语义：
 * - 声明写入 engine.json（`disabled: null`）；
 * - 重复声明互斥（EENGINEACTIVE）；
 * - 释放后 holder 归 null，可再次声明；
 * - 所有权按会话隔离。
 *
 * 历史用例「v1 会话存在 → v2 拒绝声明」随 v1 一起删除：v1 账本不再被读取，
 * 一份遗留的 `sessions/<key>/state.json` 不构成任何阻断。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { ensureLabRoot } from '../src/storage.mjs'
import { v2SessionDirectoryFor } from '../src/v2/store.mjs'
import {
  claimV2Engine,
  releaseV2Engine,
  disableV2Engine,
  getEngineRegistry,
} from '../src/v2/engine.mjs'

const SESSION_ID = 'a1b2c3d4e5f6a7b8c9d0e1f2'
const OTHER_SESSION = 'b1b2c3d4e5f6a7b8c9d0e1f2'

async function makeLabRoot(name) {
  const root = await mkdtemp(path.join(tmpdir(), `mclv2eng-${name}-`))
  await ensureLabRoot(root)
  return root
}

const cleanup = (root) => rm(root, { recursive: true, force: true })

test('未声明时 holder 为 null（未启用不等于已启用）', async () => {
  const root = await makeLabRoot('absent')
  try {
    const registry = getEngineRegistry(root, SESSION_ID)
    assert.equal(registry.holder, null)
    assert.equal(registry.v2Active, false)
    assert.equal(registry.damaged, false)
  } finally {
    await cleanup(root)
  }
})

test('声明成功、重复声明互斥、释放后可再声明', async () => {
  const root = await makeLabRoot('claim')
  try {
    const claimed = await claimV2Engine(root, SESSION_ID)
    assert.equal(claimed.claimed, true)
    assert.equal(getEngineRegistry(root, SESSION_ID).holder, 'v2')

    await assert.rejects(
      () => claimV2Engine(root, SESSION_ID),
      (error) => error.code === 'EENGINEACTIVE',
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

test('停用后 holder 归 null（数据保留、所有权释放）', async () => {
  const root = await makeLabRoot('disable')
  try {
    await claimV2Engine(root, SESSION_ID)
    const outcome = await disableV2Engine(root, SESSION_ID, 'test')
    assert.equal(outcome.disabled, true)
    assert.equal(getEngineRegistry(root, SESSION_ID).holder, null)
  } finally {
    await cleanup(root)
  }
})

test('所有权按会话隔离：不同会话互不影响', async () => {
  const root = await makeLabRoot('isolation')
  try {
    await claimV2Engine(root, SESSION_ID)
    assert.equal(getEngineRegistry(root, SESSION_ID).holder, 'v2')
    assert.equal(getEngineRegistry(root, OTHER_SESSION).holder, null)

    const other = await claimV2Engine(root, OTHER_SESSION)
    assert.equal(other.claimed, true)
    assert.equal(getEngineRegistry(root, OTHER_SESSION).holder, 'v2')

    await releaseV2Engine(root, SESSION_ID)
    await releaseV2Engine(root, OTHER_SESSION)
  } finally {
    await cleanup(root)
  }
})

test('所有权只由 engine.json 表达：目录里不存在 engines.json 台账', async () => {
  const root = await makeLabRoot('no-registry')
  try {
    await claimV2Engine(root, SESSION_ID)
    const registryFile = path.join(root, 'v2', 'engines.json')
    await assert.rejects(
      () => import('node:fs/promises').then((fs) => fs.readFile(registryFile)),
      { code: 'ENOENT' },
      '0.13.1 已删除 engines.json 台账，所有权只由 engine.json 表达',
    )
    const engineFile = path.join(v2SessionDirectoryFor(root, SESSION_ID), 'engine.json')
    const parsed = JSON.parse(await (await import('node:fs/promises')).readFile(engineFile, 'utf8'))
    assert.equal(parsed.disabled, null)
  } finally {
    await cleanup(root)
  }
})
