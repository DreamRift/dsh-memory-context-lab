/**
 * R3-03（2026-10-30）：写锁续约与失锁传播。
 *
 * ## 缺陷（审计 round3 原结论 + 源码复核）
 * - 续约间隔固定按**默认** TTL 推导（Math.max(1000, 60000/3)）：自定义小 TTL 的
 *   长事务在第一次续约之前就被别的进程判 stale 接管；
 * - 心跳 lost/异常被 `catch(() => {})` 吞掉，interval 继续跑，body 继续写——
 *   失锁对写入阶段不可见。
 *
 * ## 修法
 * - 间隔按实际 ttlMs 推导（heartbeatIntervalOf：TTL 的 1/3，恒小于 TTL）；
 * - 续约单飞；heartbeat lost（token 被换）/出错（owner 不可读等失败关闭场景）
 *   立即停表并记失锁；
 * - body 收到 ownership.assertOwned()：失锁后的后续提交抛 ELOCK_LOST 失败关闭。
 *
 * ## 断言组
 * 1. 间隔推导：1/3 TTL 且恒 < TTL（含极小 TTL 与默认 60s）；
 * 2. 行为：小 TTL（150ms）下 400ms 长事务靠续约保活，外部第 250ms 抢锁必须 ELOCKED
 *    （旧固定 20s 间隔下此场景必被 stale 接管——红对照即旧缺陷）；
 * 3. 失锁传播：owner.json 被换 token → 心跳判 lost → assertOwned 抛 ELOCK_LOST，
 *    且续约已停（新持有者凭证不被旧续约覆盖）；
 * 4. 心跳出错（owner.json 损坏，失败关闭场景）→ 同样失锁；
 * 5. 重入路径：reentrant body 也拿到恒通过的 ownership（调用方无需分叉）。
 *
 * ## 已知边界
 * assertOwned 检查与真正落盘之间仍有窗口；硬性跨进程 fencing 需额外协议，
 * 本批不做（方案 §9 拍板：首批修续约与协作取消）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

import {
  acquireWriteLock,
  heartbeatIntervalOf,
  withCrossProcessWriteLock,
} from '../src/v3/adapters/storage/write-lock.mjs'

async function withDir(body) {
  const dir = await mkdtemp(path.join(tmpdir(), 'mcl-v3-renew-'))
  try {
    return await body(dir)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

test('续约间隔按实际 TTL 推导：TTL 的 1/3，恒小于 TTL', () => {
  assert.equal(heartbeatIntervalOf(60000), 20000, '默认 60s TTL → 20s（与旧默认一致）')
  // ttl=1 不进表：间隔粒度下限是 1ms，与 TTL 相等时无法再小（真实调用不会用 1ms TTL）。
  for (const ttl of [2, 7, 30, 100, 150, 600, 900, 5000, 60000, 600000]) {
    const interval = heartbeatIntervalOf(ttl)
    assert.ok(interval >= 1, '间隔至少 1ms')
    assert.ok(interval < ttl, '间隔必须小于 TTL（ttl=' + ttl + ' → ' + interval + '）')
    assert.ok(interval <= Math.max(1, Math.floor(ttl / 3)), '间隔不超过 TTL 的 1/3（防止抖动直通）')
  }
})

test('小 TTL 长事务：按实际 TTL 续约保活，外部抢锁 ELOCKED（旧固定间隔必被接管）', async () => {
  await withDir(async (dir) => {
    const ttl = 150 // interval = 50ms
    const inner = withCrossProcessWriteLock(dir, async (ownership) => {
      // 事务持续 400ms ≫ TTL；期间由 interval 续约保活
      ownership.assertOwned() // 未失锁：不抛
      await new Promise((resolve) => setTimeout(resolve, 400))
      ownership.assertOwned() // 仍持锁：不抛
      return 'inner-done'
    }, { ttlMs: ttl })
    // 等 inner 拿锁并跑过 TTL 一倍以上，再从进程外语义直接抢文件锁
    await new Promise((resolve) => setTimeout(resolve, 250))
    await assert.rejects(
      () => acquireWriteLock(dir, { ttlMs: ttl, waitMs: 0 }),
      (e) => e?.code === 'ELOCKED',
      '续约必须让锁保持新鲜（旧实现固定 20s 间隔 → 这里会被 stale 接管）',
    )
    assert.equal(await inner, 'inner-done')
  })
})

test('失锁传播：token 被换 → 心跳判 lost → assertOwned 抛 ELOCK_LOST 且续约停止', async () => {
  await withDir(async (dir) => {
    const ttl = 200 // interval ≈ 66ms
    const result = await withCrossProcessWriteLock(dir, async (ownership) => {
      ownership.assertOwned()
      // 模拟被另一进程 stale 接管：owner.json 换成别人的 token
      const takeover = { token: 'token-of-new-owner', pid: 1, host: 'other', acquiredAt: Date.now(), heartbeatAt: Date.now() }
      await writeFile(path.join(dir, '.write-lock', 'owner.json'), JSON.stringify(takeover) + '\n', 'utf8')
      // 等下一次心跳（> 2×interval）发现 token 不符
      await new Promise((resolve) => setTimeout(resolve, 200))
      assert.throws(() => ownership.assertOwned(), (e) => e?.code === 'ELOCK_LOST', '失锁后的提交判据必须失败关闭')
      assert.equal(ownership.isLost(), true)
      await new Promise((resolve) => setTimeout(resolve, 120))
      return 'body-done'
    }, { ttlMs: ttl })
    assert.equal(result, 'body-done', '失锁是协作取消：body 自己决定收尾，锁框架不硬杀')
  })
})

test('心跳出错（owner.json 损坏）同样失锁', async () => {
  await withDir(async (dir) => {
    const ttl = 200
    await withCrossProcessWriteLock(dir, async (ownership) => {
      ownership.assertOwned()
      await writeFile(path.join(dir, '.write-lock', 'owner.json'), 'not-json', 'utf8')
      await new Promise((resolve) => setTimeout(resolve, 200))
      assert.throws(() => ownership.assertOwned(), (e) => e?.code === 'ELOCK_LOST')
    }, { ttlMs: ttl })
  })
})

test('正常路径：ownership 存在且 assertOwned 不抛；body 返回值透传', async () => {
  await withDir(async (dir) => {
    const result = await withCrossProcessWriteLock(dir, async (ownership) => {
      assert.equal(typeof ownership.assertOwned, 'function')
      ownership.assertOwned()
      assert.equal(ownership.isLost(), false)
      return 42
    }, { ttlMs: 60000 })
    assert.equal(result, 42)
  })
})

test('重入路径：reentrant body 也拿到恒通过的 ownership', async () => {
  await withDir(async (dir) => {
    await withCrossProcessWriteLock(dir, async (outer) => {
      outer.assertOwned()
      await withCrossProcessWriteLock(dir, async (inner) => {
        inner.assertOwned() // 重入没有独立租约，但调用方无需分叉
        assert.equal(inner.isLost(), false)
      }, { ttlMs: 60000 })
    }, { ttlMs: 60000 })
  })
})

test('token 传递：options.token 仍生效（与既有 acquireWriteLock 合同一致）', async () => {
  await withDir(async (dir) => {
    const token = 'fixed-' + randomUUID()
    await withCrossProcessWriteLock(dir, async () => {
      const owner = JSON.parse(await (await import('node:fs/promises')).readFile(path.join(dir, '.write-lock', 'owner.json'), 'utf8'))
      assert.equal(owner.token, token)
    }, { ttlMs: 60000, token })
  })
})
