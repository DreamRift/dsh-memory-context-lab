/**
 * H-57 守卫：建库在飞时 dispose，不得把 runtime 塞回表里（泄漏一个打开的库）。
 *
 * ## 缺陷（修前）
 * ensureEntry 落定时无条件 runtimes.set(sessionId, entry)。dispose 只清表 + 关已存在的
 * runtime，于是：在飞的建库任务落定后重新入表 -> stats() 里出现已 dispose 的会话；
 * 该 runtime 永不 close()（entryOf 只查表不建库，没有任何路径再碰它）；
 * inspect() 还能读到它，等于 dispose 后观察面仍在工作。
 *
 * ## 判据
 * - dispose 后 runtime.close() 恰好 1 次（既不 0 次泄漏，也不 2 次重复关）；
 * - stats() 不含该会话；inspect() 返回 null；
 * - 正常路径（建库完成后再 dispose）仍是 1 次，不回归。
 *
 * 关键时序：断点反推 resumeCheckpointOf 是 O(记录数) 的磁盘活，dispose 完全可能落在
 * 「makeRuntime 已返回、runtimes.set 还没执行」这段窗口里——所以 disposed 检查必须在
 * await 之后再来一次，只在 await 之前检查是不够的。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { attachV3Engine } from '../src/v3/entry/v3-entry.mjs'

function harness({ resumeDelayMs = 30 } = {}) {
  const logs = []
  const state = { closed: 0, opened: 0 }
  const handlers = {}
  const ctx = {
    on: (name, fn) => { handlers[name] = fn; return () => { delete handlers[name] } },
    logger: { warn: (m) => logs.push('warn:' + m), info: () => {} },
  }
  const factory = async () => {
    state.opened += 1
    return {
      store: {
        sourceEventIds: async () => { await new Promise((r) => setTimeout(r, resumeDelayMs)); return [] },
        health: async () => ({ healthy: true }),
        rebuildIndex: async () => {},
      },
      handleDshEvent: async () => ({ status: 'applied' }),
      provider: { search: async () => [], read: async () => null },
      metrics: () => ({}),
      close: () => { state.closed += 1 },
    }
  }
  return { state, logs, handlers, ctx, factory }
}

const sessionOf = (id = 'sess-1') => ({
  id,
  log: [{ seq: 0, type: 'user/message', data: { text: 'hi' } }],
})

test('H-57 dispose 落在建库窗口内：runtime 被 close 一次、不入表、inspect 为 null', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'v3-dispose-race-'))
  try {
    const h = harness({ resumeDelayMs: 30 })
    const engine = attachV3Engine(h.ctx, { v3Root: root, runtimeFactory: h.factory })
    const session = sessionOf()
    await h.handlers['agent/pre-step']({ agent: { session }, signal: null }, async () => ({ kind: 'enter' }))
    engine.dispose()
    await new Promise((r) => setTimeout(r, 120))

    assert.equal(h.state.closed, 1, '泄漏的 runtime 必须被关掉（旧实现为 0）')
    // stats() 里恒有两个**引擎级**键（ingestMetrics / injection），除此之外只能是会话条目。
    assert.deepEqual(Object.keys(engine.stats()).sort(), ['ingestMetrics', 'injection'], 'dispose 后不得有会话残留在表里')
    assert.equal(await engine.inspect('sess-1'), null, 'dispose 后观察面不得再读到已关闭的 runtime')
    assert.ok(h.logs.some((m) => m.includes('dispose 之后完成建库')), '丢弃事实要留告警，不静默')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('H-57 不回归：建库完成后再 dispose，仍是恰好一次 close', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'v3-dispose-normal-'))
  try {
    const h = harness({ resumeDelayMs: 0 })
    const engine = attachV3Engine(h.ctx, { v3Root: root, runtimeFactory: h.factory })
    const session = sessionOf()
    await h.handlers['agent/pre-step']({ agent: { session }, signal: null }, async () => ({ kind: 'enter' }))
    for (let i = 0; i < 50; i += 1) {
      if (Object.keys(engine.stats()).includes('sess-1')) break
      await new Promise((r) => setTimeout(r, 5))
    }
    assert.ok(Object.keys(engine.stats()).includes('sess-1'), '前置：建库应已完成')
    engine.dispose()
    await new Promise((r) => setTimeout(r, 30))
    assert.equal(h.state.closed, 1, '正常路径只关一次（重复 close 同样是缺陷）')
    assert.equal(await engine.inspect('sess-1'), null)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('H-57 dispose 之后 pre-step 不再建库（不复活）', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'v3-dispose-after-'))
  try {
    const h = harness({ resumeDelayMs: 0 })
    const engine = attachV3Engine(h.ctx, { v3Root: root, runtimeFactory: h.factory })
    // dispose 会 off() 注销处理器，所以先抓住引用，才能真正压到 disposed 守卫上
    const preStep = h.handlers['agent/pre-step']
    engine.dispose()
    assert.equal(h.handlers['agent/pre-step'], undefined, 'dispose 必须注销 pre-step 处理器')
    const session = sessionOf('sess-2')
    const decision = await preStep({ agent: { session }, signal: null }, async () => ({ kind: 'enter' }))
    await new Promise((r) => setTimeout(r, 40))
    assert.deepEqual(decision, { kind: 'enter' }, '影子线不得改写宿主决策')
    assert.equal(h.state.opened, 0, 'dispose 之后不得再建库')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
