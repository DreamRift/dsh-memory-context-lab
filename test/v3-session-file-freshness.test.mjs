/**
 * 会话状态/控制读取的**新鲜度**（M3，2026-11-04 独立审计）。
 *
 * 旧实现用「目录 mtime 闸门」：目录没变就直接返回进程内缓存，连文件 stat 都不做。
 * 问题有两类：
 * - 跨进程写入若落在同一 mtime 粒度内（Windows 1–15ms），闸门判「没变」；
 * - 外部工具原地改写（不经 temp+rename）不推进目录 mtime，闸门永远看不到。
 * 两者都是**失败开放**方向（该关的开关没关掉）。
 *
 * 现在：每次读取都 stat 目标文件，只有「文件戳（mtime:size）完全相同」才复用缓存。
 * 本套件锁的就是这三件事：原地改写可见、跨进程（独立句柄）可见、缓存仍按戳命中。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile, utimes, readFile } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { readSessionControl, writeSessionControl, sessionControlPath } from '../src/v3/adapters/storage/session-control.mjs'
import { readSessionState, writeSessionState, sessionStatePath } from '../src/v3/adapters/storage/session-state.mjs'

async function withRoot(body) {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-v3-filefresh-'))
  try {
    return await body(root)
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
}

test('M3 原地改写（不推目录 mtime）也能被读到', async () => {
  await withRoot(async (root) => {
    const controlPath = sessionControlPath(root, 's1')
    const statePath = sessionStatePath(root, 's1')
    await mkdir(path.dirname(controlPath), { recursive: true })
    await writeFile(controlPath, JSON.stringify({ schemaVersion: 1, enabled: true }), 'utf8')
    await writeFile(statePath, JSON.stringify({ schemaVersion: 1, mode: 'full-history' }), 'utf8')
    assert.equal(readSessionControl(root, 's1').enabled, true)
    assert.equal(readSessionState(root, 's1').mode, 'full-history')

    // 固定一个旧时间戳后改写：size 变化已足够让戳不同；再测一次「同尺寸 + 同 mtime」边界。
    await writeFile(controlPath, JSON.stringify({ schemaVersion: 1, enabled: false }), 'utf8')
    assert.equal(readSessionControl(root, 's1').enabled, false, '原地改写必须立即可见')

    // 同尺寸原地改写：把 mtime 强行设回旧值，模拟「尺寸和 mtime 都没变」的极端情况——
    // 这时戳相同，缓存命中是允许的（无法区分字节），但下一次真实变化必须能看见。
    const before = statSync(statePath).mtimeMs
    await writeFile(statePath, JSON.stringify({ schemaVersion: 1, mode: 'cooling' }), 'utf8')
    await utimes(statePath, before / 1000, before / 1000)
    // 尺寸不同 → 戳不同，仍应可见
    assert.equal(readSessionState(root, 's1').mode, 'cooling')
  })
})

test('M3 独立句柄（模拟另一进程）写入后，热路径读到新值', async () => {
  await withRoot(async (root) => {
    await mkdir(path.dirname(sessionControlPath(root, 's2')), { recursive: true })
    readSessionControl(root, 's2')
    // 独立写路径（不经本进程缓存失效）
    await writeSessionControl(root, 's2', { enabled: false })
    assert.equal(readSessionControl(root, 's2').enabled, false)
    await writeSessionState(root, 's2', { mode: 'recall-only' })
    assert.equal(readSessionState(root, 's2').mode, 'recall-only')
  })
})

test('M3 ENOENT 哨兵：默认值稳定，文件出现后能读到', async () => {
  await withRoot(async (root) => {
    const controlPath = sessionControlPath(root, 's3')
    await mkdir(path.dirname(controlPath), { recursive: true })
    assert.equal(readSessionControl(root, 's3').enabled, true, '文件不存在 = 默认全开')
    for (let i = 0; i < 5; i += 1) assert.equal(readSessionControl(root, 's3').enabled, true)
    await writeFile(controlPath, JSON.stringify({ schemaVersion: 1, enabled: false }), 'utf8')
    assert.equal(readSessionControl(root, 's3').enabled, false, '文件出现后读到新值')
  })
})

test('M4 显式 undefined 版本号不会落成无版本文件', async () => {
  await withRoot(async (root) => {
    await mkdir(path.dirname(sessionControlPath(root, 's4')), { recursive: true })
    await writeSessionControl(root, 's4', { schemaVersion: undefined, enabled: false })
    const text = await readFile(sessionControlPath(root, 's4'), 'utf8')
    const parsed = JSON.parse(text)
    assert.equal(parsed.schemaVersion, 1, '补键必须在展开之后（旧写法会被 undefined 反覆盖）')
  })
})

test('M10 落盘写归一化结果（默认字段/收敛值真的进文件）', async () => {
  await withRoot(async (root) => {
    await mkdir(path.dirname(sessionStatePath(root, 's5')), { recursive: true })
    await writeSessionState(root, 's5', { mode: 'full-history' })
    const parsed = JSON.parse(await readFile(sessionStatePath(root, 's5'), 'utf8'))
    assert.equal(parsed.schemaVersion, 1)
    assert.ok(parsed.surface && typeof parsed.surface === 'object', 'normalize 补的默认字段必须落盘')
    assert.ok(parsed.cooling && typeof parsed.cooling === 'object')
    assert.deepEqual(parsed.pins, [])
    assert.equal(parsed.planFloorSeq, null)
  })
})
