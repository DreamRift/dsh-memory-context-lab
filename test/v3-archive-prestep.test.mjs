/**
 * pre-step 归档接线（M2）：真实 attachV3Engine + 真实 composition + 假 DSH session。
 * - 新会话默认 full-history，第二次 pre-step 归档第一个完成操作；
 * - 当前回合/无记录不归档；
 * - state 记录归档位点；recall-only 模式不再归档。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { attachV3Engine } from '../src/v3/entry/v3-entry.mjs'
import { createFakeSession } from './helpers/fake-session.mjs'

function fakeCtx() {
  const handlers = new Map()
  const warnings = []
  const ctx = {
    warnings,
    on(name, handler) { handlers.set(name, handler); return () => handlers.delete(name) },
    logger: { warn: (m) => warnings.push(m), info() {} },
  }
  ctx.callPreStep = async (session) => {
    const handler = handlers.get('agent/pre-step')
    if (!handler) throw new Error('未注册 pre-step')
    return await handler({ agent: { session }, signal: undefined }, async () => ({ kind: 'enter' }))
  }
  return ctx
}

async function settle(engine) {
  await new Promise((resolve) => setTimeout(resolve, 150))
  await engine._waitForIdle().catch(() => {})
  await new Promise((resolve) => setTimeout(resolve, 50))
}

test('pre-step：full-history 新会话归档第一个完成操作并推进 state', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-pre-archive-'))
  const ctx = fakeCtx()
  const engine = attachV3Engine(ctx, { v3Root: root })
  try {
    const session = createFakeSession({ cwd: 'C:\\ws', contextWindow: 100000 })
    session.pushUser('第一问'.repeat(60))
    session.pushAssistant('第一答'.repeat(60))
    session.pushUser('当前问题'.repeat(10))
    await ctx.callPreStep(session)
    await settle(engine)
    assert.equal(engine.statusOf('session-fake').mode, 'full-history')
    assert.deepEqual(await session.surface.nodes, [0, 1, 2], '首次 pre-step 不归档（entry 尚未就绪）')

    // 读租约：最近读过 assistant1 的记录在 TTL 内保护整个完成操作。
    const beforeLease = await engine.workingSet('session-fake')
    const assistantRow = beforeLease.rows.find((row) => row.seq === 1)
    assert.ok(assistantRow, '第一答应有记录')
    await engine.setState('session-fake', { readLease: [{ recordId: assistantRow.recordId, expiresAt: Date.now() + 60000 }] })
    const leased = await engine.archiveForStep('session-fake', session, {})
    assert.equal(leased.status, 'no-candidate', '读租约内的操作不得归档')
    await engine.setState('session-fake', { readLease: [] })

    // 直接调 engine.archiveForStep（index.mjs 的 pre-step 只是这个用例的调度壳）。
    const archived = await engine.archiveForStep('session-fake', session, {})
    assert.equal(archived.status, 'archived', JSON.stringify(archived))
    const nodes = await session.surface.nodes
    assert.deepEqual(ctx.warnings, [], '归档不得告警失败')
    assert.equal(nodes.length, 2, '回执替换了第一个完成操作的两个节点；nodes=' + JSON.stringify(nodes))
    assert.equal(nodes[0] >= 3, true, 'nodes=' + JSON.stringify(nodes))
    const vouchers = await engine.historyOf('session-fake')
    assert.equal(vouchers.total, 1)
    const working = await engine.workingSet('session-fake')
    assert.equal(working.error, undefined)
    assert.equal(working.rows.length, 1, '当前回合只有 user3 可读')
    const state = engine.stateOf('session-fake')
    assert.equal(state.surface.lastArchiveEndSeq, 1)
    assert.equal(engine.statusOf('session-fake').surface.lastArchiveEndSeq, 1)

    // 切到 recall-only 后不再归档；当前回合也不应被归档。
    await engine.setState('session-fake', { mode: 'recall-only' })
    session.pushUser('第三问')
    await ctx.callPreStep(session)
    await settle(engine)
    assert.equal((await engine.historyOf('session-fake')).total, 1, 'recall-only 不再产生新凭证')
  } finally {
    await engine._waitForIdle().catch(() => {})
    engine.dispose()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})

test('cooling：占用达到 0.2 才开闸；未知占用失败关闭', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-pre-cooling-'))
  const ctx = fakeCtx()
  const engine = attachV3Engine(ctx, { v3Root: root })
  try {
    const session = createFakeSession({ cwd: 'C:\\ws' })
    session.pushContextWindow(1000000)
    // 一个回合内的多个步骤：cooling 是**步骤级**，只压完整步骤、保留工作集。
    session.pushUser('第一问'.repeat(60))
    for (let step = 1; step <= 6; step += 1) {
      session.append('step/start', { turn: 1, step })
      session.pushAssistant(('第' + step + '步输出').repeat(40))
      session.append('step/end', { turn: 1, step })
    }
    await ctx.callPreStep(session)
    await settle(engine)
    await engine.setState('session-fake', { mode: 'cooling' })
    const usageDir = path.join(root, 'sessions', 'session-fake')
    await mkdir(usageDir, { recursive: true })
    await writeFile(path.join(usageDir, 'usage.jsonl'), JSON.stringify({ seq: 1, inputTokens: 300000, totalTokens: 300001 }) + '\n')

    const result = await engine.archiveForStep('session-fake', session, { retainOperations: 2 })
    assert.equal(result.status, 'archived', JSON.stringify(result))
    assert.equal(result.steps, 3, '六个完整步骤里保留最近两步；单次上限 3 步（减少前缀抖动）')
    assert.equal(engine.stateOf('session-fake').cooling.open, true)
    assert.equal((await engine.historyOf('session-fake')).total, 1)
  } finally {
    await engine._waitForIdle().catch(() => {})
    engine.dispose()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})

test('planfirst approve：计划工件冻结在活动面，批准后只归档新回合', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-plan-floor-'))
  const ctx = fakeCtx()
  const engine = attachV3Engine(ctx, { v3Root: root })
  try {
    const session = createFakeSession({ cwd: 'C:\\ws' })
    session.pushUser('计划前'.repeat(60))
    session.pushAssistant('计划前答'.repeat(60))
    await ctx.callPreStep(session)
    await settle(engine)
    await engine.archiveForStep('session-fake', session, {})

    await engine.setState('session-fake', { planFirst: true })
    session.pushUser('计划正文'.repeat(60))
    session.pushAssistant('计划确认'.repeat(60))
    await ctx.callPreStep(session)
    await settle(engine)
    const paused = await engine.archiveForStep('session-fake', session, {})
    assert.equal(paused.status, 'paused', JSON.stringify(paused))

    const frozenNodes = await session.surface.nodes
    const floor = Math.max(...frozenNodes)
    await engine.setState('session-fake', { planFirst: false, planFloorSeq: floor })

    session.pushUser('批准后新回合'.repeat(60))
    session.pushAssistant('批准后新答'.repeat(60))
    await ctx.callPreStep(session)
    await settle(engine)
    // 再开一个回合，让「批准后新回合」成为已完成操作（当前回合永不归档）。
    session.pushUser('再下一回合'.repeat(60))
    session.pushAssistant('再下一答'.repeat(60))
    await ctx.callPreStep(session)
    await settle(engine)
    const archived = await engine.archiveForStep('session-fake', session, {})
    assert.equal(archived.status, 'archived', JSON.stringify(archived))
    assert.ok(archived.startSeq > floor, '只归档冻结边界之后的新回合')
    const after = await session.surface.nodes
    for (const seq of frozenNodes) assert.ok(after.includes(seq), '计划工件 seq ' + seq + ' 必须仍在活动面')
  } finally {
    await engine._waitForIdle().catch(() => {})
    engine.dispose()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})

test('新会话 defaultEnabled=false：默认不摄入，/on 后才摄入', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-default-off-'))
  const ctx = fakeCtx()
  const engine = attachV3Engine(ctx, { v3Root: root, defaultEnabled: false })
  try {
    const session = createFakeSession({ cwd: 'C:\\ws' })
    session.pushUser('默认关闭'.repeat(30))
    await ctx.callPreStep(session)
    await settle(engine)
    assert.equal(engine.statusOf('session-fake').control.enabled, false, '新会话默认关闭')
    assert.equal(engine.statusOf('session-fake').ingested, null, '关闭时不建库/不摄入（未知而不是 0）')

    await engine.setControl('session-fake', { enabled: true })
    await ctx.callPreStep(session)
    await settle(engine)
    assert.equal(engine.statusOf('session-fake').control.enabled, true)
    assert.ok(engine.statusOf('session-fake').ingested >= 1, '开启后正常摄入')
  } finally {
    await engine._waitForIdle().catch(() => {})
    engine.dispose()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})