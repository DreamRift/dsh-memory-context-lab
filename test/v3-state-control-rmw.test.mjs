/**
 * R3-01（2026-10-30）：state/control 锁内读改写，并发更新不丢失。
 *
 * ## 缺陷（审计 round3 动态复现）
 * setState/setControl 是「读旧快照 → patch → 整对象原子写回」。temp+rename 只防
 * 半文件：两个请求从同一旧快照各改不同字段，后写整份覆盖先前已成功的字段——
 * planFirst 留下而 autoRestore 更新丢失；control 的 recall 更新同类覆盖。
 *
 * ## 修法
 * updateSessionState / updateSessionControl：在**会话跨进程写锁**内强制磁盘重读 →
 * 合并 patch → 原子写回；损坏/不可读的现存状态不按空状态覆盖（失败关闭）；
 * 初始化走 ensureInitialSessionState（create-if-absent，与更新区分）。
 *
 * ## 断言组
 * 1. 同进程并发改不同顶层/嵌套字段：全部保留（旧实现必红的确定性反例）；
 * 2. 锁内磁盘重读：读缓存落后于磁盘（模拟另一进程直写）时按磁盘最新值合并；
 * 3. 损坏/不可读：不覆盖、磁盘字节不变（失败关闭）；
 * 4. 初始化 create-if-absent：已有（含损坏）不覆盖；并发初始化只有一个落盘；
 * 5. 非法 patch：抛错且磁盘不变；
 * 6. control 同构反例：enabled 与 overrides 并发更新都保留；
 * 7. 跨进程：子进程与父进程并发改不同字段，最终两个字段都在。
 *
 * ## 定点变异自证
 * 把 updateSessionState 退回「readSessionState → patch → writeSessionState」直写
 * （无锁、无重读）→ 组 1/2 红且字段确定丢失。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  ensureInitialSessionState,
  sessionStatePath,
  readSessionState,
  updateSessionState,
  writeSessionState,
} from '../src/v3/adapters/storage/session-state.mjs'
import {
  readSessionControl,
  sessionControlPath,
  updateSessionControl,
} from '../src/v3/adapters/storage/session-control.mjs'
import { emptySessionState } from '../src/v3/domain/session/mode.mjs'

const V3ContractViolation = (await import('../src/v3/contracts/errors.mjs')).V3ContractViolation

async function withRoot(body) {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-v3-rmw-'))
  try {
    return await body(root)
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
}

test('state：并发改不同顶层/嵌套字段，全部保留（旧写法确定丢字段）', async () => {
  await withRoot(async (root) => {
    await writeSessionState(root, 's1', {
      ...emptySessionState('full-history'),
      modeSource: 'explicit',
      updatedAt: 1,
    })
    // 旧实现：两个调用都在对方写盘前读旧快照，后写覆盖前写——provider 或 surface 必丢其一。
    // 新实现：同一把会话写锁串行化，锁内各自重读磁盘最新值再合并。
    await Promise.all([
      updateSessionState(root, 's1', { provider: { tier: 'T2', reason: '隔离灵枢' } }),
      updateSessionState(root, 's1', { surface: { lastArchiveEndSeq: 7, lastArchiveAt: 42 } }),
      updateSessionState(root, 's1', { pins: ['v3r-1'] }),
    ])
    const state = readSessionState(root, 's1')
    assert.equal(state.provider.tier, 'T2')
    assert.equal(state.surface.lastArchiveEndSeq, 7)
    assert.equal(state.surface.lastArchiveAt, 42)
    assert.deepEqual(state.pins, ['v3r-1'])
    assert.equal(state.mode, 'full-history', '无关字段不被并发更新抹掉')
    assert.equal(state.modeSource, 'explicit')
  })
})

test('state：嵌套字段按域合并——surface 两个子字段并发更新互不覆盖', async () => {
  await withRoot(async (root) => {
    await writeSessionState(root, 's1', { ...emptySessionState('cooling'), updatedAt: 1 })
    await Promise.all([
      updateSessionState(root, 's1', { surface: { lastArchiveEndSeq: 3 } }),
      updateSessionState(root, 's1', { surface: { lastArchiveAt: 99 } }),
    ])
    const state = readSessionState(root, 's1')
    assert.equal(state.surface.lastArchiveEndSeq, 3)
    assert.equal(state.surface.lastArchiveAt, 99)
  })
})

test('state：读缓存落后于磁盘（另一进程直写）时按磁盘最新值合并', async () => {
  await withRoot(async (root) => {
    await writeSessionState(root, 's1', { ...emptySessionState('full-history'), updatedAt: 1 })
    readSessionState(root, 's1') // 填充进程内缓存（旧快照）
    // 模拟另一进程绕过本进程缓存直写磁盘
    const diskPath = sessionStatePath(root, 's1')
    const onDisk = JSON.parse(await readFile(diskPath, 'utf8'))
    onDisk.mode = 'cooling'
    onDisk.modeSource = 'explicit'
    onDisk.planFirst = true
    await writeFile(diskPath, JSON.stringify(onDisk) + '\n', 'utf8')

    // 旧实现：setState 用缓存旧快照整对象写回 → cooling/planFirst 被抹掉。
    await updateSessionState(root, 's1', { provider: { tier: 'T2', reason: 'r' } })
    const state = readSessionState(root, 's1')
    assert.equal(state.mode, 'cooling', '锁内必须看到磁盘最新值，不能按旧快照回写')
    assert.equal(state.planFirst, true)
    assert.equal(state.provider.tier, 'T2')
  })
})

test('state：损坏/不可读的现存状态不按空状态覆盖（失败关闭）', async () => {
  await withRoot(async (root) => {
    const p = sessionStatePath(root, 's1')
    await mkdir(path.dirname(p), { recursive: true })
    await writeFile(p, '{"mode":"full-history","pins":', 'utf8') // 半截 JSON
    const result = await updateSessionState(root, 's1', { pins: ['x'] })
    assert.equal(result.error, 'ESTATE_CORRUPT')
    assert.equal(await readFile(p, 'utf8'), '{"mode":"full-history","pins":', '损坏状态字节不变')
  })
})

test('state：初始化 create-if-absent——已有/损坏不覆盖，并发初始化只落一个', async () => {
  await withRoot(async (root) => {
    const initial = { ...emptySessionState('full-history'), planFirst: true, updatedAt: 1 }
    await writeSessionState(root, 's1', { ...emptySessionState('cooling'), modeSource: 'explicit', pins: ['keep'], updatedAt: 1 })
    const existing = await ensureInitialSessionState(root, 's1', initial)
    assert.equal(existing.mode, 'cooling', '已有 state 不得被默认值覆盖')
    assert.deepEqual(existing.pins, ['keep'])

    const p = sessionStatePath(root, 's2')
    await mkdir(path.dirname(p), { recursive: true })
    await writeFile(p, 'not-json', 'utf8')
    const corrupt = await ensureInitialSessionState(root, 's2', initial)
    assert.equal(corrupt.error, 'ESTATE_CORRUPT', '损坏的现存状态同样不覆盖')
    assert.equal(await readFile(p, 'utf8'), 'not-json')

    // absent + 并发初始化：两个 initial 不同，最终只有一个整体落盘（不混合）
    const a = { ...emptySessionState('full-history'), planFirst: true, updatedAt: 1 }
    const b = { ...emptySessionState('cooling'), planFirst: false, updatedAt: 2 }
    await Promise.all([
      ensureInitialSessionState(root, 's3', a),
      ensureInitialSessionState(root, 's3', b),
    ])
    const s3 = readSessionState(root, 's3')
    const mixed = s3.mode === 'full-history' && s3.planFirst === false
    assert.ok(!mixed, '并发初始化不得产生混合状态：' + JSON.stringify({ mode: s3.mode, planFirst: s3.planFirst }))
  })
})

test('state：非法 patch 抛错且磁盘不变（失败关闭）', async () => {
  await withRoot(async (root) => {
    await writeSessionState(root, 's1', { ...emptySessionState('full-history'), updatedAt: 1 })
    const before = await readFile(sessionStatePath(root, 's1'), 'utf8')
    await assert.rejects(
      () => updateSessionState(root, 's1', { mode: 'not-a-mode' }),
      (e) => e instanceof V3ContractViolation,
    )
    assert.equal(await readFile(sessionStatePath(root, 's1'), 'utf8'), before)
  })
})

test('control：并发改 enabled 与 overrides 都保留；坏控制文件不覆盖', async () => {
  await withRoot(async (root) => {
    await Promise.all([
      updateSessionControl(root, 's1', { enabled: false }),
      updateSessionControl(root, 's1', { overrides: { limit: 7 } }),
      updateSessionControl(root, 's1', { recall: false }),
    ])
    const control = readSessionControl(root, 's1')
    assert.equal(control.enabled, false)
    assert.equal(control.recall, false)
    assert.equal(control.overrides.limit, 7, '并发更新不得互相覆盖（R3-01 的 control 面）')

    const p = sessionControlPath(root, 's2')
    await mkdir(path.dirname(p), { recursive: true })
    await writeFile(p, '{oops', 'utf8')
    const result = await updateSessionControl(root, 's2', { enabled: false })
    assert.match(String(result.error ?? ''), /ECONTROL_/, '损坏控制原样返回带 error 的现值')
    assert.equal(await readFile(p, 'utf8'), '{oops', '损坏控制字节不变（失败关闭）')
  })
})

test('跨进程并发：父/子进程各改不同字段，最终都在（真实子进程、真交错）', async () => {
  await withRoot(async (root) => {
    await writeSessionState(root, 's-cross', { ...emptySessionState('full-history'), updatedAt: 1 })
    const modUrl = pathToFileURL(fileURLToPath(new URL('../src/v3/adapters/storage/session-state.mjs', import.meta.url))).href
    // 2026-10-31 审计修正：旧写法用 spawnSync——它**阻塞**父进程直到子进程退出，
    // 两边其实一前一后串行，「跨进程并发」这一条从未被真正执行（把跨进程文件锁
    // 整个拆掉也照样绿）。现在改为 spawn + ready/go 握手：子进程就绪后父进程才开跑，
    // 两边在同一时间窗内交错写同一份 state.json。
    const ready = path.join(root, 'child-ready')
    const go = path.join(root, 'parent-go')
    const stop = path.join(root, 'parent-stop')
    const childScript = `
      const fs = await import('node:fs/promises')
      const mod = await import(process.env.MCL_MOD)
      const seen = async (p) => { try { await fs.access(p); return true } catch { return false } }
      await fs.writeFile(process.env.MCL_READY, 'ready')
      // 等父进程的 go：保证两边的写入窗口重叠，而不是一前一后
      while (!(await seen(process.env.MCL_GO))) await new Promise((r) => setTimeout(r, 2))
      // 一直写到父进程喊停（上限兜底）——父进程写 surface 的整个窗口里子进程都在写 provider，
      // 交错是构造出来的，不靠运气。
      let last = 0
      for (let i = 1; i <= 400; i += 1) {
        if (await seen(process.env.MCL_STOP)) break
        await mod.updateSessionState(process.env.MCL_ROOT, 's-cross', {
          provider: { tier: 'T2', reason: 'child-' + i },
        })
        last = i
      }
      console.log('LAST:' + last)
    `
    const child = spawn(process.execPath, ['--input-type=module', '-e', childScript], {
      env: { ...process.env, MCL_MOD: modUrl, MCL_ROOT: root, MCL_READY: ready, MCL_GO: go, MCL_STOP: stop },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let childOut = ''
    child.stdout.on('data', (d) => { childOut += d })
    child.stderr.on('data', (d) => { childOut += d })
    const exited = new Promise((resolve) => child.on('close', (code) => resolve(code)))
    // 等子进程就绪
    let readySeen = false
    for (let i = 0; i < 3000 && !readySeen; i += 1) {
      try { await access(ready); readySeen = true } catch { await new Promise((r) => setTimeout(r, 2)) }
    }
    assert.equal(readySeen, true, '子进程必须就绪（否则这一条又退化成串行）：' + childOut)
    await writeFile(go, 'go')
    // 父进程与子进程同时改 surface
    for (let i = 1; i <= 12; i += 1) {
      await updateSessionState(root, 's-cross', { surface: { lastArchiveEndSeq: i } })
    }
    await writeFile(stop, 'stop') // 父进程写完后才喊停 → 两边窗口必然重叠
    const code = await exited
    assert.equal(code, 0, '子进程正常完成：' + childOut)
    const last = Number((childOut.match(/LAST:(\d+)/) ?? [])[1])
    assert.ok(Number.isInteger(last) && last >= 1, '子进程必须真的写过（否则这一条又退化成串行）：' + childOut)
    const state = readSessionState(root, 's-cross')
    assert.equal(state.provider.tier, 'T2', '子进程的字段保留')
    assert.match(state.provider.reason, new RegExp('child-' + last + '$'), '子进程最后一次更新生效')
    assert.equal(state.surface.lastArchiveEndSeq, 12, '父进程的字段保留且最后一次更新生效')
    assert.equal(state.mode, 'full-history', '无关字段不丢')
  })
})
