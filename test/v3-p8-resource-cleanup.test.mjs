/**
 * P8 §5.4 / §9：资源释放（listener / 子进程 / 计时器）与 dispose 的确定性。
 *
 * ## 缺陷（修前）
 * composition.close 用 void provider.close?.() 丢掉异步关闭：
 * - provider.close 拒绝 → 未处理拒绝（Node 默认终止进程）；
 * - store 在 provider 还在 flush/关子进程时就被关；
 * - 调用方（entry.dispose / 淘汰）无法等待子进程真正退出，宿主 effect 也无从 await。
 *
 * ## 判据
 * - runtime.close 返回 Promise：先等 provider.close 落定，再关 store（顺序可观测）；
 * - provider.close 拒绝时 close 仍 resolve，且不产生未处理拒绝；
 * - engine.dispose 返回 Promise（异步 close 被 await），资源表清空，事件处理器注销；
 * - dispose 之后不得再触发防抖重建（计时器清理；与 chunk 体检用例互补）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createV3Runtime } from '../src/v3/composition/composition.mjs'
import { attachV3Engine } from '../src/v3/entry/v3-entry.mjs'

async function withRuntime(body) {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-p8-cleanup-'))
  // 最小 DSH session 形状：host 适配器只要求 append；事件面留空（本用例不归档/不落面）。
  const dshSession = {
    id: 'sess-cleanup',
    log: [],
    surface: { nodes: [] },
    append() { return { seq: 1 } },
    eventAt() { return undefined },
    deriveMessages() { return [] },
  }
  const runtime = await createV3Runtime({ v3Root: root, dshSession })
  try {
    return await body(runtime, root)
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
}

test('P8 runtime.close：先等 provider 关闭，再关 store（返回 Promise）', async () => {
  await withRuntime(async (runtime) => {
    const order = []
    let releaseProvider
    runtime.provider.close = () => {
      order.push('provider:start')
      return new Promise((resolve) => { releaseProvider = () => { order.push('provider:done'); resolve() } })
    }
    const closing = runtime.close()
    assert.equal(typeof closing?.then, 'function', 'close 必须返回可等待的 Promise')
    let settled = false
    closing.then(() => { settled = true })
    await new Promise((r) => setTimeout(r, 10))
    assert.deepEqual(order, ['provider:start'], 'provider 未落定时 close 不得落定')
    assert.equal(settled, false)
    releaseProvider()
    await closing
    assert.deepEqual(order, ['provider:start', 'provider:done'], 'close 在 provider 结束后落定')
    // store 在 provider 之后才关：写原语失败关闭即证据
    await assert.rejects(() => runtime.store.transaction([{ id: 'v3r-0000000000000d01' }]), (error) => error?.code === 'ESTORE_CLOSED')
  })
})

test('P8 runtime.close：provider 关闭拒绝不制造未处理拒绝，store 仍被关闭', async () => {
  await withRuntime(async (runtime) => {
    const rejections = []
    const onRejection = (reason) => rejections.push(reason)
    process.on('unhandledRejection', onRejection)
    try {
      runtime.provider.close = async () => { throw new Error('close failed（夹具）') }
      await runtime.close()
      await new Promise((r) => setTimeout(r, 20))
      assert.deepEqual(rejections, [], '关闭期拒绝不得变成未处理拒绝')
      await assert.rejects(() => runtime.store.transaction([{ id: 'v3r-0000000000000d02' }]), (error) => error?.code === 'ESTORE_CLOSED')
    } finally {
      process.off('unhandledRejection', onRejection)
    }
  })
})

const sessionOf = (id) => ({ id, log: [] })

test('P8 engine.dispose：返回 Promise 等待异步 close，资源表清空、处理器注销', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-p8-cleanup-engine-'))
  try {
    let closeResolved = false
    const handlers = new Map()
    const ctx = {
      on(name, handler) { handlers.set(name, handler); return () => handlers.delete(name) },
      logger: { warn() {}, info() {} },
    }
    const factory = async () => ({
      store: {
        directory: path.join(root, 'session'),
        sourceEventIds: async () => [],
        health: async () => ({ healthy: true }),
        rebuildIndex: async () => {},
        recordCount: () => 0,
        listVouchers: () => [],
      },
      provider: { search: async () => [], read: async () => null },
      handleDshEventBatch: async (items) => items.map(() => ({ status: 'applied' })),
      metrics: () => ({}),
      close: () => new Promise((resolve) => setTimeout(() => { closeResolved = true; resolve() }, 30)),
    })
    const engine = attachV3Engine(ctx, { v3Root: root, runtimeFactory: factory })
    const preStep = handlers.get('agent/pre-step')
    await preStep({ agent: { session: sessionOf('sess-dispose') }, signal: null }, async () => ({ kind: 'enter' }))
    for (let i = 0; i < 100 && engine._pendingResources().runtimes === 0; i += 1) await new Promise((r) => setTimeout(r, 5))
    assert.equal(engine._pendingResources().runtimes, 1, '前置：runtime 已建')
    const disposing = engine.dispose()
    assert.equal(typeof disposing?.then, 'function', 'dispose 必须返回可等待的 Promise')
    await disposing
    assert.equal(closeResolved, true, 'dispose 必须等到异步 close 落定')
    assert.deepEqual(engine._pendingResources(), { rebuildTimers: 0, backfills: 0, runtimes: 0, pendingEntries: 0 })
    assert.equal(handlers.has('agent/pre-step'), false, 'dispose 必须注销事件处理器')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
