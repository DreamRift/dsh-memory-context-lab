/**
 * 会话模式/引擎状态守卫（M1）：
 * - 新会话 full-history、旧会话 recall-only 的迁移口径；
 * - state 读路径坏形状不抛但 error 可见；
 * - 写路径非法值失败关闭；
 * - 原子读写/损坏可见/路径键与 control 一致。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  SESSION_MODES,
  emptySessionState,
  modeForMigratedSession,
  modeForNewSession,
  normalizeSessionState,
  patchSessionState,
} from '../src/v3/domain/session/mode.mjs'
import { readSessionState, sessionStatePath, writeSessionState } from '../src/v3/adapters/storage/session-state.mjs'

test('模式：新会话默认 full-history，关 fullHistory 回 cooling；旧会话迁移 recall-only', () => {
  assert.deepEqual([...SESSION_MODES], ['full-history', 'cooling', 'recall-only'])
  assert.equal(modeForNewSession(true), 'full-history')
  assert.equal(modeForNewSession(false), 'cooling')
  assert.equal(modeForMigratedSession(), 'recall-only')
  assert.equal(emptySessionState('full-history').mode, 'full-history')
  assert.throws(() => emptySessionState('done'), /未知 mode/)
})

test('state 归一化：坏形状不抛、error 可见、非法 mode 回落默认', () => {
  const missing = normalizeSessionState(null, { defaultMode: 'full-history' })
  assert.equal(missing.state.mode, 'full-history')
  assert.equal(missing.error, 'ESTATE_SHAPE')

  const badMode = normalizeSessionState({ mode: 'done' }, { defaultMode: 'cooling' })
  assert.equal(badMode.state.mode, 'cooling')
  assert.equal(badMode.error, 'ESTATE_MODE')

  const good = normalizeSessionState({
    schemaVersion: 1,
    mode: 'full-history',
    modeSource: 'explicit',
    planFirst: true,
    autoRestore: false,
    pins: ['r1', 'r1', 'r2'],
    surface: { lastArchiveEndSeq: 8, lastArchiveAt: 1700000000000 },
    cooling: { open: true, lastOccupancy: 0.4, lastRunAt: 1, lastReason: 'at-or-above-enter' },
    provider: { tier: 'T1', reason: 'local' },
  })
  assert.equal(good.error, null)
  assert.equal(good.state.mode, 'full-history')
  assert.equal(good.state.modeSource, 'explicit')
  assert.equal(good.state.planFirst, true)
  assert.equal(good.state.autoRestore, false)
  assert.deepEqual(good.state.pins, ['r1', 'r2'])
  assert.equal(good.state.surface.lastArchiveEndSeq, 8)
  assert.equal(good.state.surface.lastArchiveAt, 1700000000000)
  assert.equal(good.state.cooling.open, true)
})

test('state patch：非法值失败关闭，不静默归一', () => {
  const base = emptySessionState('recall-only')
  assert.throws(() => patchSessionState(base, { mode: 'done' }), /mode/)
  assert.throws(() => patchSessionState(base, { planFirst: 'yes' }), /planFirst/)
  assert.throws(() => patchSessionState(base, { pins: [''] }), /pins/)
  assert.throws(() => patchSessionState(base, { surface: { lastArchiveEndSeq: -2 } }), /lastArchiveEndSeq/)
  assert.throws(() => patchSessionState(base, { surface: { lastArchiveAt: -1 } }), /lastArchiveAt/)
  assert.throws(() => patchSessionState(base, { surface: { lastArchiveAt: 'now' } }), /lastArchiveAt/)
  assert.throws(() => patchSessionState(base, { provider: { tier: 'T3' } }), /provider.tier/)

  const next = patchSessionState(base, { mode: 'full-history', planFirst: true, autoRestore: false, pins: ['a'] })
  assert.equal(next.mode, 'full-history')
  assert.equal(next.modeSource, 'explicit')
  assert.equal(next.planFirst, true)
  assert.equal(next.autoRestore, false)
  assert.deepEqual(next.pins, ['a'])
  const patched = patchSessionState(base, { surface: { lastArchiveEndSeq: 12, lastArchiveAt: 1700000000000 } })
  assert.equal(patched.surface.lastArchiveEndSeq, 12)
  assert.equal(patched.surface.lastArchiveAt, 1700000000000)
  assert.ok(next.updatedAt > 0)
})

test('state 存储：默认/原子写/损坏可见/路径键与 control 同算法', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-state-'))
  try {
    const initial = readSessionState(root, 's-state', { defaultMode: 'full-history' })
    assert.equal(initial.mode, 'full-history')
    assert.equal(initial.error, undefined)

    const next = patchSessionState(initial, { mode: 'cooling', planFirst: true })
    await writeSessionState(root, 's-state', next)
    const read = readSessionState(root, 's-state')
    assert.equal(read.mode, 'cooling')
    assert.equal(read.planFirst, true)

    const file = sessionStatePath(root, 's-state')
    await writeFile(file, '{not json', 'utf8')
    const broken = readSessionState(root, 's-state', { defaultMode: 'recall-only' })
    assert.equal(broken.error, 'ESTATE_CORRUPT')
    assert.equal(broken.mode, 'recall-only')

    const unusual = sessionStatePath(root, 'a/b')
    assert.match(unusual, /hash-[0-9a-f]{16}/, '非常规 id 与冷库同样哈希兜底，不越根')
    assert.equal((await readFile(sessionStatePath(root, 'a/b'), 'utf8').catch(() => '')), '', '不存在时不创建文件')
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})