/**
 * v3 影子入口测试（M5 第三批）——假 ctx/agent/session，验证挂载形状与摄入语义。
 *
 * ## 判据来源
 * 2026-10-24 对 src/index.mjs 的钩子形状核验；影子模式边界（不动表面、失败只告警）；
 * 增量摄入（断点续传不重复落库）。
 *
 * ## 断言组
 * - pre-step 后事件增量入库（user/assistant/tool-result；system 跳过）；
 * - 同一事件重复出现不重复落库（lastSeq 断点）；
 * - next() 的 decision 原样返回（影子不改宿主决策）；
 * - 摄入抛错只告警不炸钩子；dispose 后不再摄入且 runtime 关闭。
 *
 * ## 不适用条件与已知边界
 * 真实 ctx.on 注销语义与并发步进 M6 真机验证；表面操作在此模式恒不发生。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, access as fs_access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { attachV3Engine, textOfDshEvent } from '../src/v3/entry/v3-entry.mjs'
import { createV3Runtime } from '../src/v3/composition/composition.mjs'

function fakeSession(id) {
  let seq = 0
  const events = []
  // 宿主契约面（append/eventAt/surface/deriveMessages）：composition 装配 DSH 适配器要用
  const store = new Map()
  const session = {
    id,
    log: events, // 真实宿主形态（dsh-session：log 数组，无 events() 方法）
    events: () => events,
    surface: { nodes: [] },
    append(type, data) {
      seq += 1
      store.set(seq, { seq, type, data })
      session.surface.nodes = [...session.surface.nodes, seq]
      return { seq }
    },
    eventAt(s) { return store.get(s) },
    deriveMessages() { return [] },
    push(type, extra = {}) {
      // 对齐真实宿主：seq 从 0 起（SessionSeq 核验 2026-10-24）
      const s = events.length
      events.push({ seq: s, type, at: s, data: extra.data ?? {}, ...extra })
      return events.at(-1)
    },
  }
  return session
}

function fakeCtx() {
  const handlers = new Map()
  const warnings = []
  const ctx = {
    warnings,
    on(name, handler) { handlers.set(name, handler); return () => handlers.delete(name) },
    logger: { warn: (m) => warnings.push(m), info() {} },
  }
  ctx.callPreStep = async (agent, decision = { kind: 'enter' }) => {
    const handler = handlers.get('agent/pre-step')
    if (!handler) throw new Error('未注册 pre-step')
    return await handler({ agent, signal: undefined }, async () => decision)
  }
  return ctx
}

async function withEngine(body) {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-v3-entry-'))
  const ctx = fakeCtx()
  const engine = attachV3Engine(ctx, { v3Root: root })
  try {
    return await body({ ctx, engine, root })
  } finally {
    await engine._waitForIdle().catch(() => {})
    engine.dispose()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
}

test('增量摄入：三类入库、system 跳过、不重复', async () => {
  await withEngine(async ({ ctx, engine }) => {
    const session = fakeSession('s1')
    const agent = { session }
    session.push('user/message', { data: { source: { kind: 'user' }, content: [{ type: 'text', text: '用户第一句' }] } })
    await ctx.callPreStep(agent)
    await engine._waitForIdle()
    let stats = engine.stats()
    assert.equal(stats.s1.lastSeq, 0, '首事件 seq=0 已摄入')

    session.push('system/message')
    session.push('assistant/message', { data: { content: [{ type: 'text', text: '助手回复' }] } })
    await ctx.callPreStep(agent)
    await engine._waitForIdle()
    stats = engine.stats()
    assert.equal(stats.s1.lastSeq, 2, 'system 跳过但断点推进到最新已见事件')

    // 再触发一次（无新事件）：lastSeq 不变，不重复落库
    await ctx.callPreStep(agent)
    await engine._waitForIdle()
    const metricsA = engine.stats().s1.metrics.counters['v3.processTurn.applied']
    session.push('tool/result', { data: { content: [{ type: 'text', text: '工具输出' }] } })
    await ctx.callPreStep(agent)
    await engine._waitForIdle()
    assert.equal(engine.stats().s1.metrics.counters['v3.processTurn.applied'], (metricsA ?? 0) + 1, '只有新事件落库')
  })
})

test('decision 原样返回；摄入抛错只告警', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-v3-entry2-'))
  try {
    const ctx = fakeCtx()
    let boom = true
    const engine = attachV3Engine(ctx, {
      v3Root: root,
      runtimeFactory: async () => { if (boom) throw new Error('装配失败'); return createV3Runtime({ v3Root: root, dshSession: fakeSession('s1'), sessionKey: 's1' }) },
    })
    const session = fakeSession('s1')
    session.push('user/message')
    const decision = await ctx.callPreStep({ session }, { kind: 'enter', step: 42 })
    assert.deepEqual(decision, { kind: 'enter', step: 42 }, '影子不改宿主决策')
    assert.ok(ctx.warnings.some((w) => /影子(摄入|调度)失败/.test(w)), '失败只告警（摄入批或调度层）')
    boom = false
    await ctx.callPreStep({ session })
    await engine._waitForIdle()
    assert.ok(engine.stats().s1, '恢复后可装配')
    engine.dispose()
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})

test('索引重建分寸：小增量不重建（首字不受 11.5MB 重建拖累），回填才重建', async () => {
  await withEngine(async ({ ctx, engine, root }) => {
    const session = fakeSession('s-idx')
    // 1) 小增量（2 条 < 100）：摄入但不建索引文件
    session.push('user/message', { data: { text: '第一条' } })
    session.push('user/message', { data: { text: '第二条' } })
    await ctx.callPreStep({ session }, { kind: 'enter' })
    await engine._waitForIdle()
    const sessionDir = path.join(root, 'sessions', 's-idx')
    const idxSmall = path.join(sessionDir, 'lexical-index.json')
    assert.equal(await fs_access(idxSmall).then(() => true, () => false), false, '小增量不得触发全量索引重建')
    // 2) 回填（≥100 条）：批量化摄入后重建一次
    for (let i = 0; i < 150; i += 1) session.push('user/message', { data: { text: '回填' + i } })
    await ctx.callPreStep({ session }, { kind: 'enter' })
    await engine._waitForIdle()
    assert.equal(await fs_access(idxSmall).then(() => true, () => false), true, '回填完成后应重建一次索引')
  })
})

test('真实宿主形态：session.log 数组（无 events() 方法）同样摄入', async () => {
  await withEngine(async ({ ctx, engine }) => {
    const session = fakeSession('log-shaped')
    delete session.events // 只留 log 数组——对齐 dsh-session 真实形态（2026-10-24 核验）
    const agent = { session }
    session.push('user/message', { data: { source: { kind: 'user' }, content: [{ type: 'text', text: '真实形态' }] } })
    await ctx.callPreStep(agent)
    await engine._waitForIdle()
    assert.ok(engine.stats()['log-shaped'], 'log 数组形态必须可摄入')
    assert.equal(engine.stats()['log-shaped'].lastSeq, 0)
  })
})

test('textOfDshEvent：content 数组与 data.text 两种形态', () => {
  assert.equal(textOfDshEvent({ data: { content: [{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }] } }), 'a\nb')
  assert.equal(textOfDshEvent({ data: { text: '裸文本' } }), '裸文本')
  assert.equal(textOfDshEvent({}), '')
})

test('dispose 后不再摄入；非法 ctx 拒绝', async () => {
  await withEngine(async ({ ctx, engine }) => {
    const session = fakeSession('s1')
    session.push('user/message', { data: { content: [{ type: 'text', text: 'x' }] } })
    await ctx.callPreStep({ session })
    await engine._waitForIdle()
    engine.dispose()
    session.push('user/message', { data: { content: [{ type: 'text', text: 'y' }] } })
    await assert.rejects(() => ctx.callPreStep({ session }), /未注册/, 'dispose 注销钩子')
    assert.equal(engine.stats().s1, undefined, 'dispose 后登记清空')
  })
  assert.throws(() => attachV3Engine(null), (e) => e?.name === 'V3ContractViolation')
  assert.throws(() => attachV3Engine(fakeCtx(), {}), (e) => /v3Root 必传/.test(e.message))
})

test('事故修正（2026-10-25）：钩子不阻塞——大回填时 decision 立即返回', async () => {
  await withEngine(async ({ ctx, engine }) => {
    const session = fakeSession('big')
    const agent = { session }
    for (let i = 0; i < 350; i += 1) {
      session.push('user/message', { data: { source: { kind: 'user' }, content: [{ type: 'text', text: '消息' + i }] } })
    }
    const t0 = Date.now()
    const decision = await ctx.callPreStep(agent, { kind: 'enter', step: 1 })
    const hookMs = Date.now() - t0
    assert.equal(decision.kind, 'enter', 'decision 立即可用')
    assert.ok(hookMs < 200, '钩子本身必须毫秒级返回（实测 ' + hookMs + 'ms）——摄入在后台')
    assert.ok(engine.stats().big.ingesting === true || engine.stats().big.lastSeq >= 0, '后台摄入已启动或已完成')
    await engine._waitForIdle()
    assert.equal(engine.stats().big.lastSeq, 349, '350 条全部摄入（批 100）')
    assert.equal((await engine.stats().big.metrics.counters['v3.processTurn.applied']), 350)
  })
})
