/**
 * R08（0.15.0 §7.2）：`updateSessionState` 锁内 updater —— 并发新增的 pin/读租约不丢。
 *
 * ## 缺陷
 * `updateSessionState` 只接受**调用方已算好的整份 patch**：入口的 `markReadLease` /
 * `pinRecords` 在锁**外** `stateOf` 读旧快照、合并数组、再 `setState`。temp+rename 只防
 * 半文件；两个请求从同一旧快照各改 `pins`/`readLease`，后写整份覆盖先写（P0 实测：
 * 并发租约只剩 d2、并发 pin 只剩 e2）。锁内重读救不了「锁外算出的整数组」。
 *
 * ## 判据来源
 * `记忆上下文/docs/dev-0.15.0/开发流程.md` §7.2 R08；beta.55 C-1 登记（「先让
 * `updateSessionState` 接受 updater 函数」）。P0 红基线 fixture：
 * `test/p0/r08-lost-update.test.mjs`（另一 worktree，显示缺陷；本套件锁定修复后的契约）。
 *
 * ## 契约（本套件钉死）
 * `updateSessionState(v3Root, sessionId, updater, options)`，`updater` 为函数时：
 * 1. 在**会话跨进程写锁内**、强制磁盘重读之后调用，入参是过期缓存看不到的最新状态；
 * 2. 入参是**快照副本**——改它不落盘、不污染进程内读缓存；
 * 3. 返回值与旧 patch 参数同形，交给**同一** `patchSessionState` 归一/校验后原子写；
 * 4. 返回 `undefined` = 显式 no-op：不写盘、不推进 `updatedAt`；
 * 5. 坏状态（CORRUPT/UNREADABLE）不调用 updater、不覆盖原文件；
 * 6. 非法结果抛 `V3ContractViolation`、updater 抛错原样上抛，两者都不覆盖原文件；
 * 7. 提交前仍复核所有权（失锁 → `ELOCK_LOST`，字节不变）；
 * 8. 旧 patch 参数（对象）行为不变。
 *
 * ## 断言组
 * A. updater 在锁内看到磁盘最新值；返回值按 patch 语义合并（与旧 patch 可交替使用）；
 * B. 快照副本隔离 + `undefined` no-op 不写盘；
 * C. 跨进程**交错**（spawn + ready/go 握手，非 spawnSync 串行）：双方各 12 轮
 *    updater 合并 pin 与读租约，最终双方条目全部保留。本组证明的是**交错下的合并
 *    正确性**；「DONE:12」只证明子进程写满 12 轮，**不**证明两进程的临界区不重叠；
 * C3. 临界区互斥（确定性两进程握手）：A 在锁内 updater 写 holding 标记并等待；B 明确
 *    发出 attempt 后调用 update。A 持锁期间 B 的 updater 一次都不得执行（有界负向
 *    观察窗 + 未执行证据）；释放 A 后 B 才进入 updater，且读到 A **已提交**的 pin。
 *    顺序由 trace 证明（B:updater-enter 晚于 A:updater-exit），不靠 sleep 制造重叠；
 * D. 坏状态 / 非法结果 / updater 抛错：磁盘字节逐字不变；
 * E. 失锁：updater 更新被拒（ELOCK_LOST），字节不变；正对照未失锁时照常生效。
 *
 * ## 不适用条件与已知边界
 * - 只覆盖 state.json 适配器；entry 的 `pinRecords`/`markReadLease` 是否改走 updater
 *   属回注代理接线（R08 只提供原语，本套件不判定调用方是否已接线）。
 * - 锁仍是**协作式**的：提交前检查与真正 rename 之间仍有窗口，不是硬性跨进程 fencing。
 * - 交错与互斥只针对同一会话目录的两个真实进程；不同会话、不同磁盘、第三个写者不在本口径。
 * - C3 的负向观察窗是有界 300ms 的观测面（期间同时断言 A 仍持锁、B 未退出、trace 无
 *   B:updater-enter）；它不证明调度概率或真实并发时序，只证明锁内 updater 的执行顺序。
 * - 子进程的所有等待都有上限（ready/go/holding/attempt/exit），超时即失败；子进程退出码
 *   与 stderr 向用例传播；每个用例在 finally 里强杀未退出的子进程。
 * - 本套件绿不等于 pin/租约整体语义已验收（上限 200、过期清理在 domain，另有套件）。
 *
 * ## 定点变异自证（实测记录见 docs/dev-0.15.0/R08-锁内状态更新.md）
 * - 把 updater 调用移到取锁之前（**临时副本**，不动本树）→ C / C2 / C3 红（重复两次同一
 *   结果；C3 的 trace 直接显示 A 持锁期间 B:updater-enter 且 pins 无 a-pin）；
 * - 跳过 `patchSessionState` 直接写 updater 结果 → D 红（非法结果落盘）；
 * - 删掉提交前 `ownership.assertOwned()` → E 红（失锁仍写）；
 * - 删掉 `undefined` 短路 → B 红（no-op 也写盘）。
 *
 * ## 运行命令与退出码
 * `node --test-force-exit test/v3-session-state-updater.test.mjs`（顶层文件，已由
 * `scripts/test-all.mjs` 自动发现）；0 = 全绿，1 = 契约未满足。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  readSessionState,
  sessionStatePath,
  updateSessionState,
  writeSessionState,
} from '../src/v3/adapters/storage/session-state.mjs'
import { withCrossProcessWriteLock } from '../src/v3/adapters/storage/write-lock.mjs'
import { emptySessionState } from '../src/v3/domain/session/mode.mjs'
import { V3ContractViolation } from '../src/v3/contracts/errors.mjs'

const SID = 's-r08'
const MOD_URL = pathToFileURL(fileURLToPath(new URL('../src/v3/adapters/storage/session-state.mjs', import.meta.url))).href

async function withRoot(body) {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-r08-updater-'))
  try {
    return await body(root)
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
}

/** 与 entry.markReadLease 相同的合并口径：丢过期、去重、保留最后 200。 */
function mergeLease(rows, recordId, now = Date.now(), ttlMs = 60000) {
  const map = new Map()
  for (const row of rows ?? []) {
    if (typeof row?.recordId === 'string' && Number.isFinite(row?.expiresAt) && row.expiresAt > now) map.set(row.recordId, row.expiresAt)
  }
  map.set(recordId, now + ttlMs)
  return [...map.entries()].slice(-200).map(([id, expiresAt]) => ({ recordId: id, expiresAt }))
}

/** 与 entry.pinRecords 相同的合并口径：去重、保留最后 200（cap 真源仍在 patchSessionState）。 */
function mergePins(rows, recordId) {
  const out = []
  for (const id of [...(rows ?? []), recordId]) {
    if (typeof id === 'string' && id.length > 0 && !out.includes(id)) out.push(id)
  }
  return out.slice(-200)
}

const ids = (rows) => (rows ?? []).map((row) => row.recordId ?? row).sort()

// —— 两进程测试的等待/回收工具（每个等待都有上限；子进程错误与退出码向用例传播）——

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function fileExists(file) {
  try { await access(file); return true } catch { return false }
}

/** 等一个标记文件出现；超时返回 false（由调用方带上下文断言）。 */
async function waitForFile(file, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await fileExists(file)) return true
    await sleep(10)
  }
  return false
}

/** 起一个 node 子进程（ESM 脚本），收集 stdout/stderr，暴露 close 结果。 */
function startChild(script, env) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  child.stdout.on('data', (chunk) => { out += chunk })
  child.stderr.on('data', (chunk) => { out += chunk })
  const exit = new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal })))
  return { child, output: () => out, exit }
}

/** 等子进程退出；超过上限直接抛错（不无限挂住测试进程）。 */
async function exitWithin(handle, timeoutMs, label) {
  let timer
  const timedOut = new Promise((resolve) => { timer = setTimeout(() => resolve({ timeout: true }), timeoutMs) })
  const settled = await Promise.race([handle.exit, timedOut])
  clearTimeout(timer)
  if (settled.timeout === true) throw new Error(label + ' 超时未退出：' + handle.output())
  return settled
}

/** finally 回收：还在跑就强杀，避免失败用例留下孤儿进程拖住 test runner。 */
function stopChild(handle) {
  try {
    if (handle.child.exitCode === null && handle.child.signalCode === null) handle.child.kill('SIGKILL')
  } catch { /* 已退出 */ }
}

test('A. updater 在锁内按最新值合并；可与旧 patch 参数交替使用', async () => {
  await withRoot(async (root) => {
    await writeSessionState(root, SID, { ...emptySessionState('full-history'), updatedAt: 1 })
    // 先填充进程内缓存（旧快照），再让另一侧直写磁盘——锁内 updater 必须看到磁盘值。
    readSessionState(root, SID)
    const diskPath = sessionStatePath(root, SID)
    const onDisk = JSON.parse(await readFile(diskPath, 'utf8'))
    onDisk.mode = 'cooling'
    onDisk.modeSource = 'explicit'
    onDisk.pins = ['v3r-other-process']
    await writeFile(diskPath, JSON.stringify(onDisk) + '\n', 'utf8')

    const seen = []
    const next = await updateSessionState(root, SID, (state) => {
      seen.push({ mode: state.mode, pins: [...state.pins] })
      return { planFirst: true, pins: mergePins(state.pins, 'v3r-mine') }
    })
    assert.deepEqual(seen, [{ mode: 'cooling', pins: ['v3r-other-process'] }], 'updater 必须看到锁内重读的磁盘最新值，不是进程内旧缓存')
    assert.equal(next.planFirst, true)
    assert.deepEqual([...next.pins].sort(), ['v3r-mine', 'v3r-other-process'].sort(), 'updater 的结果按 patchSessionState 同一语义合并')

    // 旧 patch 参数（对象）行为不变，且接在上一次 updater 结果之后
    const legacy = await updateSessionState(root, SID, { autoRestore: false })
    assert.equal(legacy.autoRestore, false)
    assert.equal(legacy.planFirst, true, 'legacy patch 不得抹掉并发/前序字段')
    assert.deepEqual([...legacy.pins].sort(), ['v3r-mine', 'v3r-other-process'].sort())
    const finalState = readSessionState(root, SID)
    assert.equal(finalState.mode, 'cooling')
    assert.equal(finalState.autoRestore, false)
  })
})

test('B. updater 入参是快照副本；返回 undefined = 显式 no-op 不写盘', async () => {
  await withRoot(async (root) => {
    await writeSessionState(root, SID, { ...emptySessionState('full-history'), updatedAt: 7, pins: ['v3r-keep'] })
    const p = sessionStatePath(root, SID)
    const before = await readFile(p, 'utf8')
    const result = await updateSessionState(root, SID, (state) => {
      state.pins.push('v3r-mutated-in-place') // 故意改入参：不得落盘、不得污染缓存
      state.mode = 'not-a-mode'
      return undefined // 显式 no-op
    })
    assert.equal(result.updatedAt, 7, 'no-op 不推进 updatedAt')
    assert.equal(await readFile(p, 'utf8'), before, 'no-op 不得写盘（字节逐字不变）')
    assert.deepEqual(readSessionState(root, SID).pins, ['v3r-keep'], '直接改 updater 入参不得污染进程内读缓存')
    assert.equal(readSessionState(root, SID).mode, 'full-history')
  })
})

test('C2. 同进程并发两个 updater：合并必须发生在锁内（后者看得到前者已写的条目）', async () => {
  await withRoot(async (root) => {
    const sid = 's-r08-concurrent'
    await writeSessionState(root, sid, { ...emptySessionState('full-history'), updatedAt: 1 })
    // 两个调用几乎同时进入：锁内 updater 让第二个在持锁后重读，看到第一个写入的条目；
    // 若「读—合并」被挪到取锁之前，两边都从同一旧快照起步，后写整数组覆盖先写（确定丢一条）。
    await Promise.all([
      updateSessionState(root, sid, (state) => ({ pins: mergePins(state.pins, 'v3r-concurrent-a') })),
      updateSessionState(root, sid, (state) => ({ pins: mergePins(state.pins, 'v3r-concurrent-b') })),
    ])
    const state = readSessionState(root, sid)
    console.log(JSON.stringify({ item: 'R08/updater-concurrent-same-process', pins: ids(state.pins) }))
    assert.deepEqual(ids(state.pins), ['v3r-concurrent-a', 'v3r-concurrent-b'], '并发 updater 的两次新增都必须保留（锁外合并会丢一条）')
  })
})

test('C. 跨进程交错：双方 updater 各 12 轮，pin 与读租约双方条目全部保留', async () => {
  await withRoot(async (root) => {
    await writeSessionState(root, SID, { ...emptySessionState('full-history'), updatedAt: 1 })
    const ready = path.join(root, 'child-ready')
    const go = path.join(root, 'parent-go')
    const rounds = 12
    // 子进程用真 updater 合并自己的条目：合并发生在锁内，所以双方各 12 轮都保留。
    // 旧写法（锁外 stateOf → 合并 → setState 整数组）在同一交错下会丢一侧（P0 取证）。
    // 注意：本组证明的是「交错下的合并正确性」；临界区互斥由 C3 的握手证据单独证明。
    const childScript = `
      const fs = await import('node:fs/promises')
      const mod = await import(process.env.MCL_MOD)
      const seen = async (p) => { try { await fs.access(p); return true } catch { return false } }
      const mergeLease = (rows, recordId, now = Date.now()) => {
        const map = new Map()
        for (const row of rows ?? []) {
          if (typeof row?.recordId === 'string' && Number.isFinite(row?.expiresAt) && row.expiresAt > now) map.set(row.recordId, row.expiresAt)
        }
        map.set(recordId, now + 60000)
        return [...map.entries()].slice(-200).map(([id, expiresAt]) => ({ recordId: id, expiresAt }))
      }
      const mergePins = (rows, recordId) => {
        const out = []
        for (const id of [...(rows ?? []), recordId]) if (typeof id === 'string' && id.length > 0 && !out.includes(id)) out.push(id)
        return out.slice(-200)
      }
      await fs.writeFile(process.env.MCL_READY, 'ready')
      const deadline = Date.now() + 15000
      while (!(await seen(process.env.MCL_GO))) {
        if (Date.now() > deadline) { console.error('GO-TIMEOUT'); process.exit(3) }
        await new Promise((r) => setTimeout(r, 5))
      }
      let done = 0
      for (let i = 1; i <= Number(process.env.MCL_ROUNDS); i += 1) {
        await mod.updateSessionState(process.env.MCL_ROOT, process.env.MCL_SID, (state) => ({
          pins: mergePins(state.pins, 'v3r-child-pin-' + i),
          readLease: mergeLease(state.readLease, 'v3r-child-lease-' + i),
        }))
        done = i
      }
      console.log('DONE:' + done)
    `
    const handle = startChild(childScript, {
      MCL_MOD: MOD_URL,
      MCL_ROOT: root,
      MCL_SID: SID,
      MCL_READY: ready,
      MCL_GO: go,
      MCL_ROUNDS: String(rounds),
    })
    try {
      assert.equal(await waitForFile(ready, 15000), true, '子进程必须在限时内就绪：' + handle.output())
      await writeFile(go, 'go')
      // 父进程与子进程在同一时间窗内各写 12 轮：窗口由握手构造，不靠循环次数冒充。
      for (let i = 1; i <= rounds; i += 1) {
        await updateSessionState(root, SID, (state) => ({
          pins: mergePins(state.pins, 'v3r-parent-pin-' + i),
          readLease: mergeLease(state.readLease, 'v3r-parent-lease-' + i),
        }))
      }
      const exited = await exitWithin(handle, 30000, 'C 子进程')
      assert.equal(exited.code, 0, '子进程正常完成：' + handle.output())
      const done = Number((handle.output().match(/DONE:(\d+)/) ?? [])[1])
      assert.equal(done, rounds, '子进程必须真的写满 12 轮：' + handle.output())
    } finally {
      stopChild(handle)
    }

    const finalState = readSessionState(root, SID)
    const expectPins = []
    const expectLeases = []
    for (let i = 1; i <= rounds; i += 1) {
      expectPins.push('v3r-parent-pin-' + i, 'v3r-child-pin-' + i)
      expectLeases.push('v3r-parent-lease-' + i, 'v3r-child-lease-' + i)
    }
    console.log(JSON.stringify({ item: 'R08/updater-cross-process', pins: ids(finalState.pins), leaseCount: (finalState.readLease ?? []).length }))
    assert.deepEqual(ids(finalState.pins), expectPins.sort(), '并发 pin 双方条目必须全部保留')
    assert.deepEqual(ids(finalState.readLease), expectLeases.sort(), '并发读租约双方条目全部保留')
    assert.equal(finalState.mode, 'full-history', '无关字段不被并发更新抹掉')
  })
})

test('C3. 临界区互斥（确定性两进程握手）：B 的 updater 在 A 释放锁之前不得执行，释放后读到 A 已提交的值', async () => {
  await withRoot(async (root) => {
    const sid = 's-r08-mutex'
    await writeSessionState(root, sid, { ...emptySessionState('full-history'), updatedAt: 1, pins: ['v3r-base'], readLease: [] })
    const trace = path.join(root, 'mutex-trace')
    const aReady = path.join(root, 'a-ready')
    const aStart = path.join(root, 'a-start')
    const aHolding = path.join(root, 'a-holding')
    const aRelease = path.join(root, 'a-release')
    const bReady = path.join(root, 'b-ready')
    const bStart = path.join(root, 'b-start')
    const bAttempt = path.join(root, 'b-attempt')

    // A：进入 updater（= 已持锁）后写 a-holding 并等待 a-release，返回时提交 A 的条目。
    const scriptA = `
      const fs = await import('node:fs/promises')
      const mod = await import(process.env.MCL_MOD)
      const trace = (line) => fs.appendFile(process.env.MCL_TRACE, line + '\\n')
      const seen = async (p) => { try { await fs.access(p); return true } catch { return false } }
      const waitFor = async (p, ms, label) => {
        const deadline = Date.now() + ms
        while (!(await seen(p))) {
          if (Date.now() > deadline) { console.error(label + '-TIMEOUT'); process.exit(3) }
          await new Promise((r) => setTimeout(r, 5))
        }
      }
      await fs.writeFile(process.env.MCL_A_READY, 'ready')
      await waitFor(process.env.MCL_A_START, 20000, 'A-START')
      const next = await mod.updateSessionState(process.env.MCL_ROOT, process.env.MCL_SID, async (state) => {
        await trace('A:updater-enter')
        await fs.writeFile(process.env.MCL_A_HOLDING, 'holding')
        await waitFor(process.env.MCL_A_RELEASE, 20000, 'A-HOLD')
        await trace('A:updater-exit')
        return {
          pins: [...state.pins, 'v3r-a-pin'],
          readLease: [...(state.readLease ?? []), { recordId: 'v3r-a-lease', expiresAt: Date.now() + 60000 }],
        }
      })
      await trace('A:committed')
      console.log('A-COMMITTED:' + JSON.stringify(next.pins))
    `

    // B：收到 b-start 后立刻尝试 update，并记录自己的 updater 何时真正开始执行。
    const scriptB = `
      const fs = await import('node:fs/promises')
      const mod = await import(process.env.MCL_MOD)
      const trace = (line) => fs.appendFile(process.env.MCL_TRACE, line + '\\n')
      const seen = async (p) => { try { await fs.access(p); return true } catch { return false } }
      await fs.writeFile(process.env.MCL_B_READY, 'ready')
      const deadline = Date.now() + 20000
      while (!(await seen(process.env.MCL_B_START))) {
        if (Date.now() > deadline) { console.error('B-START-TIMEOUT'); process.exit(3) }
        await new Promise((r) => setTimeout(r, 5))
      }
      await trace('B:attempt')
      await fs.writeFile(process.env.MCL_B_ATTEMPT, 'attempt')
      const startedAt = Date.now()
      const next = await mod.updateSessionState(process.env.MCL_ROOT, process.env.MCL_SID, async (state) => {
        await trace('B:updater-enter pins=' + state.pins.join(','))
        return {
          pins: [...state.pins, 'v3r-b-pin'],
          readLease: [...(state.readLease ?? []), { recordId: 'v3r-b-lease', expiresAt: Date.now() + 60000 }],
        }
      })
      await trace('B:committed')
      console.log('B-COMMITTED waited=' + (Date.now() - startedAt) + ' pins=' + JSON.stringify(next.pins))
    `

    const handleA = startChild(scriptA, { MCL_MOD: MOD_URL, MCL_ROOT: root, MCL_SID: sid, MCL_TRACE: trace, MCL_A_READY: aReady, MCL_A_START: aStart, MCL_A_HOLDING: aHolding, MCL_A_RELEASE: aRelease })
    let handleB = null
    try {
      assert.equal(await waitForFile(aReady, 20000), true, 'A 必须就绪：' + handleA.output())
      await writeFile(aStart, 'start')
      // A 已进入 updater：这一步证明它确实持有跨进程锁（不是「可能重叠」）。
      assert.equal(await waitForFile(aHolding, 20000), true, 'A 必须在锁内进入 updater 并进入等待：' + handleA.output())

      handleB = startChild(scriptB, { MCL_MOD: MOD_URL, MCL_ROOT: root, MCL_SID: sid, MCL_TRACE: trace, MCL_B_READY: bReady, MCL_B_START: bStart, MCL_B_ATTEMPT: bAttempt })
      assert.equal(await waitForFile(bReady, 20000), true, 'B 必须就绪：' + handleB.output())
      await writeFile(bStart, 'start')
      // B 已**发出** update 调用（attempt 标记先于取锁）。
      assert.equal(await waitForFile(bAttempt, 20000), true, 'B 必须已发出 update 尝试：' + handleB.output())

      // 负向窗口：A 仍持锁的这段时间里，B 的 updater 一次都不得执行。
      // 窗口是观测面（有界 300ms），重叠本身由 a-holding 握手构造，不靠睡眠制造。
      await sleep(300)
      assert.equal(await fileExists(aRelease), false, '负向窗口内 A 仍应持锁等待')
      const duringHold = await readFile(trace, 'utf8')
      assert.equal(duringHold.includes('B:updater-enter'), false, 'A 持锁期间 B 的 updater 不得执行：' + duringHold)
      assert.equal(duringHold.includes('A:updater-exit'), false, 'A 仍在 updater 内：' + duringHold)
      assert.equal(handleB.child.exitCode, null, 'B 应仍在等待锁，而不是已完成/已失败')

      // 释放 A：B 才可能进入 updater，并且必须看到 A 已提交的条目。
      await writeFile(aRelease, 'release')
      const exitedA = await exitWithin(handleA, 30000, 'C3 A 子进程')
      assert.equal(exitedA.code, 0, 'A 正常完成：' + handleA.output())
      const exitedB = await exitWithin(handleB, 30000, 'C3 B 子进程')
      assert.equal(exitedB.code, 0, 'B 正常完成：' + handleB.output())
    } finally {
      stopChild(handleA)
      if (handleB !== null) stopChild(handleB)
    }

    const log = await readFile(trace, 'utf8')
    const at = (marker) => log.indexOf(marker)
    assert.ok(at('A:updater-enter') >= 0 && at('A:updater-exit') >= 0, 'trace 必须同时记录 A 的两个边界：' + log)
    assert.ok(at('B:updater-enter') >= 0, 'B 释放后必须真的执行 updater：' + log)
    assert.ok(at('B:updater-enter') > at('A:updater-exit'), '顺序证据：B 的 updater 只能在 A 的 updater 结束之后开始：' + log)
    assert.match(log, /B:updater-enter pins=[^\n]*v3r-a-pin/, 'B 的 updater 必须读到 A 已提交的 pin（锁内重读，不是旧快照）：' + log)

    const finalState = readSessionState(root, sid)
    assert.deepEqual([...finalState.pins].sort(), ['v3r-a-pin', 'v3r-b-pin', 'v3r-base'].sort(), 'A/B 双方结果都保留')
    assert.deepEqual(ids(finalState.readLease), ['v3r-a-lease', 'v3r-b-lease'], '双方读租约都保留')
    console.log(JSON.stringify({ item: 'R08/updater-mutex', trace: log.trim().split(/\r?\n/).filter(Boolean) }))
  })
})

test('D2. updater 直接改快照后返回 undefined 或抛错：磁盘与进程内读缓存都不变', async () => {
  await withRoot(async (root) => {
    const sid = 's-r08-snapshot'
    await writeSessionState(root, sid, { ...emptySessionState('full-history'), updatedAt: 11, pins: ['v3r-keep'], readLease: [] })
    const p = sessionStatePath(root, sid)
    const bytes = await readFile(p, 'utf8')
    readSessionState(root, sid) // 填充进程内读缓存（no-op / 抛错都不得污染它）

    // ① 就地改快照（push/set/删除）后返回 undefined
    const noop = await updateSessionState(root, sid, (state) => {
      state.pins.push('v3r-inplace-noop')
      state.pins.splice(0, 1)
      state.readLease.push({ recordId: 'v3r-lease-inplace', expiresAt: Date.now() + 60000 })
      state.mode = 'cooling'
      state.surface.lastArchiveEndSeq = 999
      return undefined
    })
    assert.equal(noop.updatedAt, 11)
    assert.equal(await readFile(p, 'utf8'), bytes, 'no-op 必须不写盘（字节逐字不变）')
    const cached = readSessionState(root, sid)
    assert.deepEqual(cached.pins, ['v3r-keep'], 'no-op 就地改快照不得污染读缓存（pins）')
    assert.deepEqual(cached.readLease, [], 'no-op 就地改快照不得污染读缓存（readLease）')
    assert.equal(cached.mode, 'full-history')
    assert.equal(cached.surface.lastArchiveEndSeq, -1)

    // ② 就地改快照后抛错
    const boom = new Error('snapshot-boom')
    await assert.rejects(
      () => updateSessionState(root, sid, (state) => {
        state.pins.length = 0
        state.pins.push('v3r-inplace-throw')
        state.mode = 'recall-only'
        throw boom
      }),
      (error) => error === boom,
    )
    assert.equal(await readFile(p, 'utf8'), bytes, 'updater 抛错不得写盘（字节逐字不变）')
    const afterThrow = readSessionState(root, sid)
    assert.deepEqual(afterThrow.pins, ['v3r-keep'], '抛错路径就地改快照不得污染读缓存')
    assert.equal(afterThrow.mode, 'full-history')

    // ③ 旧对象 patch 仍受同一归一/校验（不回退）：非法 patch 抛错且字节不变
    await assert.rejects(
      () => updateSessionState(root, sid, { pins: 'not-an-array' }),
      (error) => error instanceof V3ContractViolation,
    )
    await assert.rejects(
      () => updateSessionState(root, sid, null),
      (error) => error instanceof V3ContractViolation,
    )
    assert.equal(await readFile(p, 'utf8'), bytes, '非法对象 patch 不得落盘')
    // 合法对象 patch 照旧生效，并接在当前值之后（未被上面的失败调用影响）
    const legacy = await updateSessionState(root, sid, { pins: mergePins(['v3r-keep'], 'v3r-legacy') })
    assert.deepEqual([...legacy.pins].sort(), ['v3r-keep', 'v3r-legacy'].sort())
  })
})

test('D. 坏状态 / 非法结果 / updater 抛错：都不覆盖原文件', async () => {
  await withRoot(async (root) => {
    // D1 坏状态：updater 不得被调用，字节不变，返回带 error 的现值
    const corruptPath = sessionStatePath(root, 's-corrupt')
    await mkdir(path.dirname(corruptPath), { recursive: true })
    await writeFile(corruptPath, '{"mode":"full-history","pins":', 'utf8')
    let called = false
    const corrupt = await updateSessionState(root, 's-corrupt', (state) => {
      called = true
      return { pins: mergePins(state.pins, 'v3r-x') }
    })
    assert.equal(called, false, '坏状态不得执行 updater（失败关闭，不按内存默认值覆盖）')
    assert.equal(corrupt.error, 'ESTATE_CORRUPT')
    assert.equal(await readFile(corruptPath, 'utf8'), '{"mode":"full-history","pins":', '损坏状态字节逐字不变')

    // D2 非法结果：抛 V3ContractViolation，字节不变（含 null / 数组 / 非对象 / 字段非法）
    await writeSessionState(root, SID, { ...emptySessionState('full-history'), updatedAt: 3 })
    const p = sessionStatePath(root, SID)
    const validBytes = await readFile(p, 'utf8')
    for (const bad of [null, [], 42, 'pins', { pins: 'not-an-array' }, { mode: 'not-a-mode' }, { readLease: [{ recordId: 'x' }] }]) {
      await assert.rejects(
        () => updateSessionState(root, SID, () => bad),
        (error) => error instanceof V3ContractViolation,
        '非法结果必须失败关闭：' + JSON.stringify(bad),
      )
      assert.equal(await readFile(p, 'utf8'), validBytes, '非法结果不得落盘：' + JSON.stringify(bad))
    }

    // D3 updater 抛错：原错误上抛，字节不变（锁释放后可继续写入）
    const boom = new Error('updater-boom')
    await assert.rejects(() => updateSessionState(root, SID, () => { throw boom }), (error) => error === boom)
    assert.equal(await readFile(p, 'utf8'), validBytes, 'updater 抛错不得落盘')
    const after = await updateSessionState(root, SID, (state) => ({ pins: mergePins(state.pins, 'v3r-after-boom') }))
    assert.deepEqual(after.pins, ['v3r-after-boom'], '抛错后锁必须释放，后续更新照常')

    // D4 异步 updater 支持（入口可在锁内做只读校验）
    const asyncNext = await updateSessionState(root, SID, async (state) => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      return { pins: mergePins(state.pins, 'v3r-async') }
    })
    assert.deepEqual([...asyncNext.pins].sort(), ['v3r-after-boom', 'v3r-async'].sort())
  })
})

test('E. 失锁：updater 更新被拒且字节不变；未失锁正对照照常生效', async () => {
  await withRoot(async (root) => {
    const dir = path.dirname(sessionStatePath(root, SID))
    await writeSessionState(root, SID, { ...emptySessionState('full-history'), pins: ['v3r-keep'], updatedAt: 1 })
    const p = sessionStatePath(root, SID)
    const bytes = await readFile(p, 'utf8')
    await withCrossProcessWriteLock(dir, async () => {
      await writeFile(path.join(dir, '.write-lock', 'owner.json'), JSON.stringify({ token: 'token-of-new-owner', pid: 1, host: 'other', acquiredAt: Date.now(), heartbeatAt: Date.now() }) + '\n', 'utf8')
      await new Promise((resolve) => setTimeout(resolve, 260))
      await assert.rejects(
        () => updateSessionState(root, SID, (state) => ({ pins: mergePins(state.pins, 'v3r-lost') })),
        (error) => error?.code === 'ELOCK_LOST',
        '失锁后 updater 更新必须失败关闭',
      )
    }, { ttlMs: 200 })
    assert.equal(await readFile(p, 'utf8'), bytes, '失锁后 state 字节不得变化')
    assert.deepEqual(readSessionState(root, SID).pins, ['v3r-keep'])

    // 正对照：未失锁时同一 updater 路径照常生效（不是把正常路径也挡掉）。
    // 换一个会话目录：失锁用例故意留下「别人 token 的锁目录」（release 拒绝删别人的锁），
    // 同一目录再取锁会等满 waitMs 后 ELOCKED——那是锁语义的正确行为，不是本用例的口径。
    const SID2 = 's-r08-live'
    await writeSessionState(root, SID2, { ...emptySessionState('full-history'), pins: ['v3r-keep'], updatedAt: 1 })
    const ok = await updateSessionState(root, SID2, (state) => ({ pins: mergePins(state.pins, 'v3r-live') }))
    assert.deepEqual([...ok.pins].sort(), ['v3r-keep', 'v3r-live'].sort())
  })
})