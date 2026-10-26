import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createV3Runtime } from '../src/v3/composition/composition.mjs'

function fakeHostSession(id) {
  let seq = 0
  const store = new Map()
  return {
    id,
    log: [],
    events: () => [],
    surface: { nodes: [] },
    append(type, data) { seq += 1; store.set(seq, { seq, type, data }); return { seq } },
    eventAt(s) { return store.get(s) },
    deriveMessages() { return [] },
  }
}

test('H-08：非常规 session id 哈希目录名 + manifest 原名；安全 id 直用目录名', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-h08-'))
  try {
    // 1) 危险 id（旧实现整仓拒绝）：现在哈希化，数据不出根
    const evil = '../../escape'
    const rt = await createV3Runtime({ v3Root: root, sessionKey: evil, dshSession: fakeHostSession(evil) })
    assert.ok(rt.sessionKey.startsWith('hash-') && rt.sessionKey.length === 21, '哈希目录键形态')
    const manifest = JSON.parse(await readFile(path.join(root, 'sessions', rt.sessionKey, 'session-manifest.json'), 'utf8'))
    assert.equal(manifest.originalId, evil, 'manifest 存原名')
    assert.equal(manifest.hashed, true)
    await rt.dispose?.()

    // 2) 同一危险 id 再来：稳定同目录
    const rt2 = await createV3Runtime({ v3Root: root, sessionKey: evil, dshSession: fakeHostSession(evil) })
    assert.equal(rt2.sessionKey, rt.sessionKey, '同一 id 稳定同一哈希目录')
    await rt2.dispose?.()

    // 3) 安全 id：直用目录名（兼容存量库），无 manifest
    const rt3 = await createV3Runtime({ v3Root: root, sessionKey: 'session-safe-1', dshSession: fakeHostSession('session-safe-1') })
    assert.equal(rt3.sessionKey, 'session-safe-1')
    const files = await readdir(path.join(root, 'sessions', 'session-safe-1'))
    assert.ok(!files.includes('session-manifest.json'), '安全 id 不写 manifest')
    await rt3.dispose?.()

    // 4) 数据根外无副作用：sessions 目录里只有上述目录
    const dirs = await readdir(path.join(root, 'sessions'))
    assert.equal(dirs.length, 2, '只建了两个会话目录：' + dirs.join(','))
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})
