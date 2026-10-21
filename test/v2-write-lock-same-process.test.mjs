/**
 * 0.13.2-beta.2 守卫（W-01）：同进程 withWriteLock 必须**串行**，不是重入放行。
 *
 * ## 缺陷（GitHub issue #9 的同进程那一半）
 * 0.13.2-beta.1 加了 `acquiringLocks` 排队，但排的是「**获取**」不是「**持有**」：
 * 后来者在前一个 `withWriteLock` 的回调执行期间就拿到了重入句柄（`refs += 1`），
 * 两个 async 分支同时处于临界区。于是「读 → 算 → 写回」互相覆盖：
 * 2 路并发 × 25 轮只落 25 条，8 路并发 × 25 轮只落 25 条（丢 87.5%）。
 *
 * ## 判据（改回去必红）
 * - 锁内读改写：`final === ok`（成功写入次数 == 最终计数），2 路与 8 路都成立；
 * - 同调用栈的嵌套调用不死锁（重入语义必须保留，否则从「不互斥」变成「自锁」）；
 * - 不同目录互不阻塞（串行化只作用于同一目录）。
 *
 * 把 `withWriteLock` 改回「直接 acquireWriteLock + run」即红。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  readWriteLockOwner,
  withWriteLock,
} from '../src/v2/write-lock.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function withTempDir(body) {
  const dir = await mkdtemp(path.join(tmpdir(), 'mcl-lock-same-process-'))
  try {
    return await body(dir)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/** 锁内「读 → 等 2ms → 写回 +1」，返回成功次数与最终计数。 */
async function counterRun(dir, { lanes, rounds }) {
  const counter = path.join(dir, 'counter.json')
  await writeFile(counter, '{"n":0}', 'utf8')
  let ok = 0
  const errors = []
  const worker = async () => {
    for (let index = 0; index < rounds; index += 1) {
      try {
        await withWriteLock(dir, async () => {
          const current = JSON.parse(await readFile(counter, 'utf8'))
          await sleep(2) // 真实读改写里的处理时间
          await writeFile(counter, JSON.stringify({ n: current.n + 1 }), 'utf8')
        })
        ok += 1
      } catch (error) {
        errors.push(error?.code ?? String(error))
      }
    }
  }
  await Promise.all(Array.from({ length: lanes }, worker))
  const final = JSON.parse(await readFile(counter, 'utf8')).n
  return { ok, final, errors }
}

test('W-01：2 路并发 × 25 轮锁内读改写不丢更新', async () => {
  await withTempDir(async (dir) => {
    const { ok, final, errors } = await counterRun(dir, { lanes: 2, rounds: 25 })
    assert.deepEqual(errors, [], `并发写入不得报错：${errors.join(',')}`)
    assert.equal(ok, 50, '每一次调用都必须成功返回')
    assert.equal(final, ok, `丢更新：ok=${ok} final=${final}`)
  })
})

test('W-01：8 路并发 × 25 轮锁内读改写不丢更新（issue #9 的原始判据）', async () => {
  await withTempDir(async (dir) => {
    const { ok, final, errors } = await counterRun(dir, { lanes: 8, rounds: 25 })
    assert.deepEqual(errors, [], `并发写入不得报错：${errors.join(',')}`)
    assert.equal(ok, 200, '每一次调用都必须成功返回')
    assert.equal(final, ok, `丢更新：ok=${ok} final=${final}（旧实现 8 路只落 25 条）`)
  })
})

test('W-01：同调用栈的嵌套 withWriteLock 必须重入（不得自锁）', async () => {
  await withTempDir(async (dir) => {
    const seen = []
    const result = await withWriteLock(dir, async () => {
      seen.push(await readWriteLockOwner(dir))
      // 真实形态：applyForgetUnlocked → loadDisposition → repairLedgerTail，
      // 以及 applyForgetUnlocked → appendEntry，都是同栈二次取锁。
      const inner = await withWriteLock(dir, async () => {
        seen.push(await readWriteLockOwner(dir))
        return 'inner-ok'
      })
      seen.push(await readWriteLockOwner(dir))
      return inner
    })
    assert.equal(result, 'inner-ok', '内层调用必须真的执行，而不是被排队等死')
    assert.equal(seen.length, 3)
    for (const owner of seen) assert.ok(owner?.token, '嵌套期间锁必须一直在自己手里')
    assert.equal(new Set(seen.map((owner) => owner.token)).size, 1, '内层不得另建一把锁')
    assert.equal(await readWriteLockOwner(dir), null, '最外层结束后必须释放')
  })
})

test('W-01：串行化只作用于同一目录，不同目录互不阻塞', async () => {
  await withTempDir(async (root) => {
    const first = path.join(root, 'a')
    const second = path.join(root, 'b')
    const order = []
    let releaseFirst
    const firstHolds = new Promise((resolve) => { releaseFirst = resolve })
    const firstRun = withWriteLock(first, async () => {
      order.push('a:enter')
      await firstHolds
      order.push('a:exit')
    })
    // 等第一个真的进了临界区，再让另一个目录的调用开始：它必须能立刻完成。
    while (!order.includes('a:enter')) await sleep(5)
    await withWriteLock(second, async () => { order.push('b:run') })
    assert.deepEqual(order, ['a:enter', 'b:run'], '不同目录不得互相排队')
    releaseFirst()
    await firstRun
    assert.deepEqual(order, ['a:enter', 'b:run', 'a:exit'])
  })
})
