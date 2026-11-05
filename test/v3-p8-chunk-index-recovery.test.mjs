/**
 * P8 §9.3 / §5.4：派生 chunk 索引的损坏、换代中断与后台自愈。
 *
 * ## 判据
 * - 损坏（半截 JSON）不影响检索与回注：窗口回退现扫（scan-fallback），不抛错、不误用旧窗口；
 * - 重建中断（词法索引已落、chunk 索引还没落）只表现为 stale：读取侧降级现扫，
 *   不把旧尺子当新索引用；
 * - **修复点**：既有索引维护（rebuildIndex）一次同时重写词法索引与 chunk 索引，
 *   之后 chunksOf 回到 ok；会话重开时建库任务发现 chunk 索引损坏/换代 → 安排一次
 *   防抖后台重建（不进 pre-step 热路径）；
 * - dispose 必须清掉该防抖计时器：dispose 之后不得再触发重建。
 *
 * ## 不适用条件与已知边界
 * 本用例不证明「损坏期间窗口质量等同 ok」——损坏期间只有现扫回退，如实标注策略。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createSessionStorePort } from '../src/v3/adapters/storage/session-store-port.mjs'
import { createT1Provider } from '../src/v3/adapters/retrieval/t1-provider.mjs'
import { createRecall } from '../src/v3/application/recall.mjs'
import { attachV3Engine } from '../src/v3/entry/v3-entry.mjs'

const SESSION_KEY = 'sess-p8-chunk'
const LONG_ID = 'v3r-0000000000000c01'
const LONG_TEXT = '开头无关。'.repeat(120) + ' 结论 ERR_TAIL_P8'

function record(id, text) {
  return {
    id,
    kind: 'operation',
    sessionKey: SESSION_KEY,
    createdAt: 1792845000000,
    payload: { text, bytes: Buffer.byteLength(text, 'utf8') },
    provenance: { sourceEventId: 'evt-' + id, sourceForm: 'tool/result', transactionId: 'tx-' + id },
  }
}

async function withStack(body) {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-p8-chunk-'))
  const { port, store } = await createSessionStorePort(root, SESSION_KEY)
  const metrics = { counter() {}, observe() {} }
  try {
    const provider = createT1Provider({ port, store, metrics })
    const recall = createRecall({ provider, metrics, sessionKey: SESSION_KEY })
    return await body({ provider, recall, port, store, root, metrics })
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
}

test('P8 损坏 chunk 索引：回注回退现扫；维护点重建后恢复 ok', async () => {
  await withStack(async ({ provider, recall, port, store }) => {
    await port.transaction([record(LONG_ID, LONG_TEXT)])
    await port.rebuildIndex()
    assert.equal((await provider.chunksOf(LONG_ID)).state, 'ok')

    const chunkPath = path.join(store.directory, 'chunk-index.json')
    await writeFile(chunkPath, '{broken', 'utf8')
    assert.equal((await provider.chunksOf(LONG_ID)).state, 'corrupt')
    const degraded = await recall({ query: 'ERR_TAIL_P8', turn: 1, previewChars: 120 })
    assert.equal(degraded.injected, true, '损坏不得挡回注：' + JSON.stringify(degraded))
    assert.equal(degraded.text.includes('ERR_TAIL_P8'), true)
    assert.equal(degraded.excerpts[0].strategy, 'scan-fallback')

    // 维护点（索引重建）一次重写两份派生物：chunk 索引自愈
    await port.rebuildIndex()
    const healed = await provider.chunksOf(LONG_ID)
    assert.equal(healed.state, 'ok', '重建后 chunk 索引必须可用')
    assert.ok(healed.spans.length >= 2, JSON.stringify(healed.spans))
    const healthy = await recall({ query: 'ERR_TAIL_P8', turn: 2, previewChars: 120 })
    assert.equal(healthy.injected, true)
    assert.notEqual(healthy.excerpts[0].strategy, 'scan-fallback', '重建后窗口应来自 chunk 索引')
  })
})

test('P8 重建中断（词法已落、chunk 未落）：stale 降级现扫，重建后恢复', async () => {
  await withStack(async ({ provider, recall, port, store }) => {
    const chunkPath = path.join(store.directory, 'chunk-index.json')
    await port.transaction([record(LONG_ID, LONG_TEXT)])
    await port.rebuildIndex()
    const oldChunk = await readFile(chunkPath, 'utf8')

    // 新记录提交并完成重建（两份派生物都新）
    await port.transaction([record('v3r-0000000000000c02', '第二条记录')])
    await port.rebuildIndex()
    // 模拟「词法索引写成功、chunk 索引写之前崩溃」：把 chunk 索引退回上一代
    await writeFile(chunkPath, oldChunk, 'utf8')
    const stale = await provider.chunksOf(LONG_ID)
    assert.equal(stale.state, 'stale', '旧 chunk 索引必须判 stale，不拿旧窗口')
    assert.deepEqual(stale.spans, [])
    const degraded = await recall({ query: 'ERR_TAIL_P8', turn: 1, previewChars: 120 })
    assert.equal(degraded.injected, true, 'stale 不得挡回注')
    assert.equal(degraded.excerpts[0].strategy, 'scan-fallback')

    await port.rebuildIndex()
    assert.equal((await provider.chunksOf(LONG_ID)).state, 'ok')
  })
})

function fakeCtx(logs) {
  const handlers = new Map()
  const ctx = {
    on(name, handler) { handlers.set(name, handler); return () => handlers.delete(name) },
    logger: { warn: (m) => logs.push('warn:' + m), info: () => {} },
  }
  ctx.callPreStep = async (session, decision = { kind: 'enter' }) => {
    const handler = handlers.get('agent/pre-step')
    return await handler({ agent: { session }, signal: undefined }, async () => decision)
  }
  ctx.hasHandler = (name) => handlers.has(name)
  return ctx
}

const sessionOf = (id) => ({ id, log: [{ seq: 0, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] } }] })

function fakeRuntimeFactory({ directory, state }) {
  return async () => {
    state.opened += 1
    return {
      store: {
        directory,
        sourceEventIds: async () => [],
        health: async () => ({ healthy: true }),
        rebuildIndex: async () => { state.rebuilds += 1 },
        recordCount: () => 1,
        listVouchers: () => [],
      },
      provider: { search: async () => [], read: async () => null },
      handleDshEventBatch: async (items) => items.map(() => ({ status: 'applied' })),
      handleDshEvent: async () => ({ status: 'applied' }),
      metrics: () => ({}),
      close: () => { state.closed += 1 },
    }
  }
}

test('P8 建库体检：chunk 索引损坏 → 安排一次后台重建（走防抖，不在热路径）', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-p8-chunk-heal-'))
  try {
    const directory = path.join(root, 'session')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(directory, { recursive: true })
    await writeFile(path.join(directory, 'chunk-index.json'), '{broken', 'utf8')
    // 词法索引存在（摄入路径据此走「小增量 + 防抖」，不再走首次建库的同步重建），
    // 于是本用例观察到的重建只来自 chunk 索引体检——判据才不混入别的路径。
    await writeFile(path.join(directory, 'lexical-index.json'), '{"schemaVersion":1}\n', 'utf8')
    const logs = []
    const state = { opened: 0, closed: 0, rebuilds: 0 }
    const ctx = fakeCtx(logs)
    const engine = attachV3Engine(ctx, { v3Root: root, runtimeFactory: fakeRuntimeFactory({ directory, state }) })
    try {
      await ctx.callPreStep(sessionOf('sess-heal'))
      // 建库任务同步排定防抖计时器（1.5s）；这里先确认资源表里有它
      for (let i = 0; i < 100 && engine._pendingResources().rebuildTimers === 0; i += 1) {
        await new Promise((r) => setTimeout(r, 10))
      }
      assert.ok(logs.some((m) => m.includes('chunk 索引不可用')), '损坏事实必须留告警：' + JSON.stringify(logs))
      await new Promise((r) => setTimeout(r, 1700))
      assert.equal(state.rebuilds, 1, '防抖重建恰好一次')
    } finally {
      await engine.dispose()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('P8 体检计时器在 dispose 时清理：dispose 之后不得再触发重建', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-p8-chunk-cancel-'))
  try {
    const directory = path.join(root, 'session')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(directory, { recursive: true })
    await writeFile(path.join(directory, 'chunk-index.json'), '{broken', 'utf8')
    await writeFile(path.join(directory, 'lexical-index.json'), '{"schemaVersion":1}\n', 'utf8')
    const logs = []
    const state = { opened: 0, closed: 0, rebuilds: 0 }
    const ctx = fakeCtx(logs)
    const engine = attachV3Engine(ctx, { v3Root: root, runtimeFactory: fakeRuntimeFactory({ directory, state }) })
    await ctx.callPreStep(sessionOf('sess-cancel'))
    for (let i = 0; i < 100 && engine._pendingResources().rebuildTimers === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 10))
    }
    assert.equal(engine._pendingResources().rebuildTimers, 1, '前置：防抖计时器已排定')
    await engine.dispose()
    assert.equal(engine._pendingResources().rebuildTimers, 0, 'dispose 必须清计时器')
    assert.equal(engine._pendingResources().runtimes, 0)
    await new Promise((r) => setTimeout(r, 1700))
    assert.equal(state.rebuilds, 0, 'dispose 之后计时器不得再跑')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
