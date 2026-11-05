/**
 * R3-03b（2026-10-31 审计）：失锁传播覆盖全部会话写原语（含重入路径）。
 *
 * ## 缺陷
 * R3-03 只把 `ownership.assertOwned()` 接进了 store 写原语与 repair 截断；两处仍然漏：
 * 1. `updateSessionState` / `ensureInitialSessionState` / `updateSessionControl` /
 *    `reserveArchiveIntent` / `clearArchiveIntentIfMatches` 五处写**从不复核所有权**——
 *    锁在本事务期间被接管（心跳判 lost / 续约出错）后，它们照旧把字节写进（或从）会话目录，
 *    而那个目录已经易主；
 * 2. `withCrossProcessWriteLock` 的**重入路径**返回恒通过的占位 ownership
 *    （`reentrantOwnership()`），于是「外层已失锁 → 嵌套写」这条最常见的传播链
 *    （store.forget → rebuildIndex、commitPlanned → setState 等）完全看不到失锁。
 *
 * ## 修法
 * - ownership 按目录登记进 AsyncLocalStorage 并沿异步上下文下传：重入调用拿到的是
 *   **外层那把锁**的 ownership，失锁照样抛 ELOCK_LOST；
 * - 五个写原语在提交前（写盘/删字节之前）复核所有权。
 *
 * ## 断言组
 * 1. 重入路径拿到的是外层真 ownership：失锁后 isLost() 为真、assertOwned 抛 ELOCK_LOST；
 * 2. 失锁后五个写原语全部拒绝，且磁盘字节不变（state/control 不被覆盖，意图不被占/清）；
 * 3. 正对照：同一路径未失锁时全部正常写入（不是把正常路径也挡掉）。
 *
 * ## 定点变异自证
 * 把重入路径改回 `body(reentrantOwnership())` → 组 1/2 红；把任一写原语的
 * `ownership.assertOwned()` 删掉 → 对应断言红。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { withCrossProcessWriteLock } from '../src/v3/adapters/storage/write-lock.mjs'
import {
  ensureInitialSessionState,
  sessionStatePath,
  readSessionState,
  updateSessionState,
  writeSessionState,
} from '../src/v3/adapters/storage/session-state.mjs'
import { readSessionControl, sessionControlPath, updateSessionControl } from '../src/v3/adapters/storage/session-control.mjs'
import {
  archiveIntentPath,
  clearArchiveIntentIfMatches,
  readArchiveIntent,
  reserveArchiveIntent,
} from '../src/v3/adapters/storage/archive-intent.mjs'
import { emptySessionState } from '../src/v3/domain/session/mode.mjs'

const SID = 's-lost'

async function withRoot(body) {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-v3-lost-'))
  try {
    return await body(root)
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
}

/** 把锁目录的 owner.json 换成别人的 token（模拟被另一进程 stale 接管）。 */
async function stealLock(dir) {
  const takeover = { token: 'token-of-new-owner', pid: 1, host: 'other', acquiredAt: Date.now(), heartbeatAt: Date.now() }
  await writeFile(path.join(dir, '.write-lock', 'owner.json'), JSON.stringify(takeover) + '\n', 'utf8')
}

const isLockLost = (e) => e?.code === 'ELOCK_LOST'

test('失锁后：重入路径拿到外层真 ownership，五个写原语全部拒绝且不动字节', async () => {
  await withRoot(async (root) => {
    const dir = path.dirname(sessionStatePath(root, SID))
    const initial = { ...emptySessionState('full-history'), pins: ['keep'], updatedAt: 1 }
    await writeSessionState(root, SID, initial)
    const stateBytes = await readFile(sessionStatePath(root, SID), 'utf8')
    await updateSessionControl(root, SID, { enabled: true }) // 先落一份控制
    const controlBytes = await readFile(sessionControlPath(root, SID), 'utf8')
    await reserveArchiveIntent(root, SID, { intentId: 'intent-a', schemaVersion: 1, mode: 'full-history', txn: 1, startSeq: 2, endSeq: 3, receiptText: 'r', createdAt: 1 })
    const intentBytes = await readFile(archiveIntentPath(root, SID), 'utf8')

    await withCrossProcessWriteLock(dir, async (ownership) => {
      ownership.assertOwned() // 未失锁
      // 重入路径（同目录）必须拿到**同一把** ownership，而不是恒通过的占位
      await withCrossProcessWriteLock(dir, async (inner) => {
        assert.equal(inner.isLost(), false)
      }, { ttlMs: 200 })
      await stealLock(dir)
      await new Promise((resolve) => setTimeout(resolve, 260)) // > 2×interval（ttl 200 → 66ms）
      assert.equal(ownership.isLost(), true, '心跳必须判出失锁')
      await withCrossProcessWriteLock(dir, async (inner) => {
        assert.equal(inner.isLost(), true, '重入路径必须看到外层的失锁（旧实现给恒通过占位）')
        assert.throws(() => inner.assertOwned(), isLockLost)
      }, { ttlMs: 200 })

      await assert.rejects(() => updateSessionState(root, SID, { pins: ['x'] }), isLockLost, 'state 更新必须失败关闭')
      await assert.rejects(() => updateSessionControl(root, SID, { enabled: false }), isLockLost, 'control 更新必须失败关闭')
      // 同一身份的幂等重占也要复核：这是唯一会「覆盖写」的占槽分支
      await assert.rejects(() => reserveArchiveIntent(root, SID, { intentId: 'intent-a', schemaVersion: 1, mode: 'full-history', txn: 1, startSeq: 2, endSeq: 3, receiptText: 'r', createdAt: 9 }), isLockLost, '占槽（幂等重占分支）必须失败关闭')
      // 不同身份走 pending 分支：不写盘，因此不抛（旧字节原样保留）
      const pending = await reserveArchiveIntent(root, SID, { intentId: 'intent-b', schemaVersion: 1, mode: 'full-history', txn: 2, startSeq: 4, endSeq: 5, receiptText: 'r2', createdAt: 2 })
      assert.equal(pending.status, 'pending')
      await assert.rejects(() => clearArchiveIntentIfMatches(root, SID, { intentId: 'intent-a' }), isLockLost, '按身份清理必须失败关闭')
    }, { ttlMs: 200 })

    assert.equal(await readFile(sessionStatePath(root, SID), 'utf8'), stateBytes, '失锁后 state 字节不得变化')
    assert.equal(await readFile(sessionControlPath(root, SID), 'utf8'), controlBytes, '失锁后 control 字节不得变化')
    assert.equal(await readFile(archiveIntentPath(root, SID), 'utf8'), intentBytes, '失锁后意图字节不得变化（不占也不清）')
    assert.deepEqual(readSessionState(root, SID).pins, ['keep'])
    assert.equal(readSessionControl(root, SID).enabled, true)
    assert.equal((await readArchiveIntent(root, SID))?.intentId, 'intent-a')

    // 初始化只在「不存在」时才写盘：另起一个没有 state.json 的会话目录才能验证它的提交前复核
    const absent = 's-absent'
    const dir2 = path.dirname(sessionStatePath(root, absent))
    await mkdir(dir2, { recursive: true })
    await withCrossProcessWriteLock(dir2, async () => {
      await stealLock(dir2)
      await new Promise((resolve) => setTimeout(resolve, 260))
      await assert.rejects(() => ensureInitialSessionState(root, absent, initial), isLockLost, 'state 初始化必须失败关闭')
    }, { ttlMs: 200 })
    await assert.rejects(() => readFile(sessionStatePath(root, absent), 'utf8'), '失锁后不得落盘新会话状态')
  })
})

test('正对照：未失锁时同一批写原语照常生效（不是把正常路径挡掉）', async () => {
  await withRoot(async (root) => {
    const dir = path.dirname(sessionStatePath(root, SID))
    const initial = { ...emptySessionState('full-history'), updatedAt: 1 }
    await writeSessionState(root, SID, initial)
    await withCrossProcessWriteLock(dir, async () => {
      await updateSessionState(root, SID, { pins: ['a'] })
      await updateSessionControl(root, SID, { enabled: false })
      const reserved = await reserveArchiveIntent(root, SID, { intentId: 'intent-ok', schemaVersion: 1, mode: 'full-history', txn: 1, startSeq: 2, endSeq: 3, receiptText: 'r', createdAt: 1 })
      assert.equal(reserved.ok, true)
      const cleared = await clearArchiveIntentIfMatches(root, SID, { intentId: 'intent-ok' })
      assert.equal(cleared.ok, true)
      await ensureInitialSessionState(root, SID, initial)
    })
    assert.deepEqual(readSessionState(root, SID).pins, ['a'])
    assert.equal(readSessionControl(root, SID).enabled, false)
    assert.equal(await readArchiveIntent(root, SID), null)
  })
})
