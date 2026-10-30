/**
 * B3-9（AUD50-04-04）状态投影的每事件 statSync——control/state 的读取走目录级新鲜
 * 闸门：同一同步批次（一次 view 的 control+state）共享 1 次目录 stat，缓存命中时
 * 0 次文件 stat；ENOENT 哨兵让「文件不存在」也稳定；写路径（temp+rename）自动失效。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { readSessionControl, writeSessionControl, sessionControlPath } from '../src/v3/adapters/storage/session-control.mjs'
import { readSessionState, sessionStatePath } from '../src/v3/adapters/storage/session-state.mjs'
import { _sessionDirGateStats } from '../src/v3/adapters/storage/session-file-gate.mjs'

async function withRoot(body) {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-v3-filegate-'))
  try {
    return await body(root)
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
}

test('B3-9 每 tick 至多 1 次目录 stat（control+state 同批次共享）', async () => {
  await withRoot(async (root) => {
    const dir = path.dirname(sessionControlPath(root, 's1'))
    await mkdir(dir, { recursive: true })
    await writeFile(sessionControlPath(root, 's1'), JSON.stringify({ enabled: true }), 'utf8')
    await writeFile(sessionStatePath(root, 's1'), JSON.stringify({ mode: 'full-history' }), 'utf8')
    readSessionControl(root, 's1')
    readSessionState(root, 's1')
    await Promise.resolve() // 结束同步批次（微任务边界清 sweep）
    const before = _sessionDirGateStats()
    for (let i = 0; i < 10; i += 1) {
      const control = readSessionControl(root, 's1')
      assert.equal(control.enabled, true)
      const state = readSessionState(root, 's1')
      assert.equal(state.path, sessionStatePath(root, 's1'))
      await Promise.resolve()
    }
    const after = _sessionDirGateStats()
    assert.equal(after.stats - before.stats, 10, '每 tick 恰 1 次目录 stat')
    assert.equal(after.hits - before.hits, 10, 'state 侧命中同批次 sweep（批次内 0 额外 stat）')
  })
})

test('B3-9 写路径自动失效：写入后下次读到新值', async () => {
  await withRoot(async (root) => {
    await mkdir(path.dirname(sessionControlPath(root, 's2')), { recursive: true })
    readSessionControl(root, 's2')
    await Promise.resolve()
    await writeSessionControl(root, 's2', { enabled: false })
    const control = readSessionControl(root, 's2')
    assert.equal(control.enabled, false, '写入后立即可见（temp+rename 推进目录 mtime）')
  })
})

test('B3-9 ENOENT 哨兵：默认值稳定、文件后来出现也能读到', async () => {
  await withRoot(async (root) => {
    const dir = path.dirname(sessionControlPath(root, 's3'))
    await mkdir(dir, { recursive: true })
    assert.equal(readSessionControl(root, 's3').enabled, true, '文件不存在=默认全开')
    await Promise.resolve()
    const before = _sessionDirGateStats()
    for (let i = 0; i < 5; i += 1) {
      assert.equal(readSessionControl(root, 's3').enabled, true, '哨兵命中：默认值稳定')
      await Promise.resolve()
    }
    const after = _sessionDirGateStats()
    assert.equal(after.stats - before.stats, 5, '哨兵路径每 tick 仍只 1 次目录 stat')
    await writeFile(sessionControlPath(root, 's3'), JSON.stringify({ enabled: false }), 'utf8')
    await Promise.resolve()
    assert.equal(readSessionControl(root, 's3').enabled, false, '文件出现后读到新值')
  })
})

test('B3-9 已知边界：原地改写（不经 rename）不推进目录 mtime，闸门不承诺', async () => {
  await withRoot(async (root) => {
    await mkdir(path.dirname(sessionControlPath(root, 's4')), { recursive: true })
    await writeFile(sessionControlPath(root, 's4'), JSON.stringify({ enabled: true }), 'utf8')
    assert.equal(readSessionControl(root, 's4').enabled, true)
    await Promise.resolve()
    // 原地改写是 fileExists 同款「外部修改」边界：闸门注释已声明，此用例钉住现状
    await writeFile(sessionControlPath(root, 's4'), JSON.stringify({ enabled: false }), 'utf8')
    await Promise.resolve()
    assert.equal(readSessionControl(root, 's4').enabled, true, '原地改写不在闸门适用面（生产代码全部走 temp+rename）')
  })
})
