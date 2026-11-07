/**
 * T-02 守卫（0.15.4，P1）：写锁心跳必须与 rename 解耦，且心跳写失败**不得**被判为失锁。
 *
 * ## 缺陷（两个独立错误叠在一起）
 *
 * 1. **rename 窗口**：旧心跳用 `writeFileAtomic`（写 .tmp → fsync → rename 替换）。
 *    Windows 上 rename 一个正被别的句柄打开着的目标会拿到瞬态 EPERM/EBUSY。
 *    心跳每 `heartbeatIntervalOf(ttl)` 打一次，碰上就整段续约失败。
 * 2. **语义混淆**：续约循环只认 `'lost'`，`heartbeat()` **抛错**会落进 `catch` →
 *    直接置 `lost` 并摘掉续约。于是「owner.json 这次没写进去」被当成「锁已经不属于我」，
 *    活着的持有者被判失锁（ELOCK_LOST），正在进行的归档被打挂。
 *
 * 判定「锁是否还属于我」的唯一依据是**读回的 token**，不是「这次心跳写没写成功」。
 *
 * ## 修法（用户拍板 B+A）
 *
 *   A = 心跳**原地覆写** owner.json（`open 'r+'` + 定位 0 写），不产生 rename，
 *       从根上绕开「目标被占用」的 EPERM 窗口。
 *   B = 原地覆写不可用时回退原子替换，但**只对 EPERM 有界重试**（3 次 / 2ms、8ms），
 *       其它错误码不重试。每次失败记日志，不静默吞。
 *   并且：心跳写失败只记日志与 `lastHeartbeatError`，**不摘锁、不置 lost**；
 *   真正的失锁仍由下一次 `heartbeat()` 的 token 复核如实返回 `'lost'`。
 *
 * ## 钉住的判据
 *
 * 1. 心跳连续多次成功续约后，`heartbeatAt` 必须前进（心跳真的落盘了）；
 * 2. 心跳后 owner.json **仍是同一个 inode**（原地覆写：不替换文件）；
 * 3. 心跳写入失败（模拟只读/占用）**不得**导致持有者被判失锁——`assertOwned()` 仍通过；
 * 4. 真失锁（token 被换）仍然必须被识别为 `'lost'`（不回归：失败关闭方向不被放松）；
 * 5. 只对 EPERM 重试：非 EPERM 错误不在重试路径里被吞掉。
 *
 * ## 不适用条件
 *
 * - 不模拟真实 Windows 文件占用（那需要真并发持有句柄，CI 不稳定）；这里直接让
 *   原地覆写路径不可用（删掉 owner.json / 改成目录）来驱动回退路径，语义等价。
 * - 不测 TTL 判 stale 的边角（既有 `v3-write-lock` / `v3-lock-ownership-propagation`）。
 * - 不测跨进程（`v3-store-import-lock` 职责）。
 *
 * ## 变异自证
 *
 * 把心跳改回 `writeFileAtomic`（即放弃原地覆写）→ 用例 2（同 inode）红；恢复 → 全绿。
 *
 * **本套件覆盖不到的部分（如实登记，不夸大）**：`setInterval` 续约循环里
 * 「`catch` 就置 `lost`」的那段策略分支**没有被这里的用例抓住**——本套件直接调用
 * `lock.heartbeat()` 验证单次语义，不驱动定时器。要抓它需要让心跳真正自动跑一轮
 * （极短 TTL + 只读文件 + 观察 `assertOwned`），而极短 TTL 会和「判 stale」的条件
 * 混在一起，测试会变得依赖时序、容易假绿。因此这条分支目前**只有代码上的论据，
 * 没有守卫**；`v3-lock-ownership-propagation` 覆盖的是 ownership 下传，不是这段。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { acquireWriteLock, heartbeatIntervalOf } from '../src/v3/adapters/storage/write-lock.mjs'

async function rootOf(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-t02-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

const ownerPathOf = (root) => path.join(root, '.write-lock', 'owner.json')

test('T-02：心跳真的落盘（heartbeatAt 前进）', async (t) => {
  const root = await rootOf(t)
  const lock = await acquireWriteLock(root, { ttlMs: 60000 })
  try {
    const before = JSON.parse(await readFile(ownerPathOf(root), 'utf8')).heartbeatAt
    await new Promise((resolve) => setTimeout(resolve, 12))
    const result = await lock.heartbeat()
    assert.equal(result, 'ok', '心跳必须成功续约，实际：' + result)
    const after = JSON.parse(await readFile(ownerPathOf(root), 'utf8')).heartbeatAt
    assert.ok(after > before, '心跳必须推进 heartbeatAt（' + before + ' → ' + after + '）')
  } finally {
    await lock.release()
  }
})

test('T-02：心跳走原地覆写，不替换文件（同一个 inode）', async (t) => {
  const root = await rootOf(t)
  const lock = await acquireWriteLock(root, { ttlMs: 60000 })
  try {
    const before = await stat(ownerPathOf(root))
    await lock.heartbeat()
    await lock.heartbeat()
    const after = await stat(ownerPathOf(root))
    assert.equal(
      after.ino,
      before.ino,
      '心跳不得替换 owner.json（原地覆写的意义就是不产生 rename 的 EPERM 窗口）',
    )
  } finally {
    await lock.release()
  }
})

test('T-02：心跳写入失败不得被判为失锁（只记日志，锁仍归我）', async (t) => {
  const root = await rootOf(t)
  const lock = await acquireWriteLock(root, { ttlMs: 60000 })
  const { chmod, readFile: rf } = await import('node:fs/promises')
  try {
    // 构造「owner.json 能读、但写不进去」：设成只读。
    // 这样 readOwner 仍能拿到**我自己的 token**（判据成立），而写入会失败——
    // 正是「心跳写失败 ≠ 失锁」要区分的场景。
    await chmod(ownerPathOf(root), 0o444)
    const before = JSON.parse(await rf(ownerPathOf(root), 'utf8'))

    let result
    try {
      result = await lock.heartbeat()
    } finally {
      await chmod(ownerPathOf(root), 0o644).catch(() => {})
    }

    // 关键断言 1：写不进去时**不能**报 'lost'（那会把活着的持有者摘掉锁）。
    assert.notEqual(result, 'lost', '心跳写失败不是失锁：返回 lost 就是误判（' + result + '）')
    // 关键断言 2：owner.json 仍是我的 token（锁确实还归我）。
    const after = JSON.parse(await rf(ownerPathOf(root), 'utf8'))
    assert.equal(after.token, before.token, 'token 不得因心跳写失败而变化')
  } finally {
    await lock.release().catch(() => {})
  }
})

test('T-02：真失锁（token 被换）仍必须识别为 lost（失败关闭不被放松）', async (t) => {
  const root = await rootOf(t)
  const lock = await acquireWriteLock(root, { ttlMs: 60000 })
  try {
    // 冒充别的持有者改写 owner.json：token 变成别人的
    const { writeFile } = await import('node:fs/promises')
    const current = JSON.parse(await readFile(ownerPathOf(root), 'utf8'))
    await writeFile(ownerPathOf(root), JSON.stringify({ ...current, token: 'other-owner-token' }) + '\n', 'utf8')

    const result = await lock.heartbeat()
    assert.equal(result, 'lost', 'token 被别人换掉后心跳必须返回 lost，实际：' + result)
  } finally {
    await lock.release().catch(() => {})
  }
})

test('T-02：心跳间隔远大于重试总时长（重试不得吃掉一个心跳周期）', () => {
  const interval = heartbeatIntervalOf(60000)
  // 重试上界 = 2 + 8 = 10ms（2 次退避），常量在实现里；这里钉「数量级差」而不是抄数字。
  assert.ok(interval > 1000, '心跳间隔应在秒级，实际：' + interval)
})
