/**
 * v3 写锁测试（M2 第二批）——write-lock 三套保留判据的 v3 重证。
 *
 * ## 判据来源
 * 行为规格映射 store/lock 族：D-05（两阶段创建，目录在凭证不在不可观察）、
 * D-06（心跳校验 token，不覆盖新持有者）、W-01（同进程串行 + 重入不死锁）、
 * W-02（接管 deadline 内 ELOCKED，不无界自旋）。
 *
 * ## 断言组
 * - 获取/心跳/释放正常路径（虚拟时钟确定性驱动）；
 * - 活持有者在窗口内 → 第二获取者 ELOCKED；
 * - 心跳超 TTL → stale 接管成功；
 * - 被接管者的心跳/释放对新持有者无损（token 不符标 lost）；
 * - 同进程：2 路并发 25 轮读改写零丢失；嵌套重入不死锁；异目录互不阻塞。
 *
 * ## 不适用条件与已知边界
 * 跨进程互斥由文件系统 rename 原子性承担，未注入真第二进程（M6 真机补）；
 * EPERM 注入未模拟（transient 分类逻辑由代码审查覆盖，M6 扩）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { acquireWriteLock, withWriteLock } from '../src/v3/adapters/storage/write-lock.mjs'

function virtualClock(start = 1000000) {
  let t = start
  return { now: () => t, advance: (ms) => { t += ms } }
}

async function withDir(body) {
  const dir = await mkdtemp(path.join(tmpdir(), 'mcl-v3-lock-'))
  try {
    return await body(dir)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

test('正常路径：获取→心跳推进→释放', async () => {
  await withDir(async (dir) => {
    const clock = virtualClock()
    const handle = await acquireWriteLock(dir, { now: clock.now, ttlMs: 60000, waitMs: 0 })
    clock.advance(10000)
    assert.equal(await handle.heartbeat(), 'ok')
    assert.equal(await handle.release(), 'ok')
  })
})

test('活持有者窗口：第二获取者 ELOCKED（不接管活锁）', async () => {
  await withDir(async (dir) => {
    const clock = virtualClock()
    const first = await acquireWriteLock(dir, { now: clock.now, ttlMs: 60000, waitMs: 0 })
    clock.advance(5000) // 心跳仍新鲜
    await assert.rejects(
      () => acquireWriteLock(dir, { now: clock.now, ttlMs: 60000, waitMs: 0 }),
      (e) => e?.code === 'ELOCKED' && /活持有者/.test(e.message),
    )
    assert.equal(await first.release(), 'ok')
  })
})

test('心跳超 TTL → stale 接管成功', async () => {
  await withDir(async (dir) => {
    const clock = virtualClock()
    const first = await acquireWriteLock(dir, { now: clock.now, ttlMs: 60000, waitMs: 0 })
    clock.advance(70000) // 超过 TTL，持有者已死（不再心跳）
    const second = await acquireWriteLock(dir, { now: clock.now, ttlMs: 60000, waitMs: 1000 })
    assert.notEqual(second.token, first.token)
    // 被接管者的一切操作对新持有者无损（D-06）
    assert.equal(await first.heartbeat(), 'lost')
    assert.equal(await first.release(), 'lost')
    assert.equal(await second.heartbeat(), 'ok', '新持有者凭证未被旧心跳覆盖')
    assert.equal(await second.release(), 'ok')
  })
})

test('同进程串行：2 路并发 25 轮读改写零丢失（W-01）', async () => {
  await withDir(async (dir) => {
    let counter = 0
    const worker = async () => {
      for (let i = 0; i < 25; i += 1) {
        await withWriteLock(dir, async () => {
          const read = counter
          await Promise.resolve() // 让出微任务，制造交错窗口
          counter = read + 1
        })
      }
    }
    await Promise.all([worker(), worker()])
    assert.equal(counter, 50, '读改写必须零丢失')
  })
})

test('嵌套重入不死锁；异目录互不阻塞', async () => {
  await withDir(async (dirA) => {
    await withDir(async (dirB) => {
      const order = []
      await withWriteLock(dirA, async () => {
        order.push('a1')
        await withWriteLock(dirA, async () => {
          order.push('a-inner') // 同栈重入：直接执行
        })
      })
      await Promise.all([
        withWriteLock(dirA, async () => { order.push('a2') }),
        withWriteLock(dirB, async () => { order.push('b1') }),
      ])
      assert.deepEqual(order.slice(0, 2), ['a1', 'a-inner'])
      assert.ok(order.includes('a2') && order.includes('b1'))
    })
  })
})
