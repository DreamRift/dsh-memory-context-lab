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

    // 读租约（AUD-09，0.14.0-beta.45）：租约只保护**工作集**——按轮归档只压已完成回合，
    // 当前回合本就被排除，所以租约不得再把上一轮钉住（旧行为会钉最长 5 分钟）。
    // 显式 pin 仍是硬边界，见 test/v3-archive-lease.test.mjs。
    const beforeLease = await engine.workingSet('session-fake')
    const assistantRow = beforeLease.rows.find((row) => row.seq === 1)
    assert.ok(assistantRow, '第一答应有记录')
    await engine.setState('session-fake', { readLease: [{ recordId: assistantRow.recordId, expiresAt: Date.now() + 60000 }] })

    // 直接调 engine.archiveForStep（index.mjs 的 pre-step 只是这个用例的调度壳）。
    const archived = await engine.archiveForStep('session-fake', session, {})
    assert.equal(archived.status, 'archived', '读租约不得钉住已完成回合：' + JSON.stringify(archived))
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

/**
 * 0.14.0-beta.47：轮次判定可在设置页切换。
 * 这条用例复现真实形状——一条真人指令 + 一次目标自动继续：真人判定下两者是同一个
 * 当前回合（永远不压），DSH 轮次判定下第 1 轮已完成、可立即归档。
 */
test('按轮归档：切到 DSH 轮次判定后，目标自动继续前的上一轮可归档（真人判定仍不压）', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-pre-turn-basis-'))
  const ctx = fakeCtx()
  const engine = attachV3Engine(ctx, { v3Root: root })
  try {
    const session = createFakeSession({ cwd: 'C:\\ws', contextWindow: 100000 })
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.pushUser('真人指令'.repeat(50))
    session.pushAssistant('第一轮输出'.repeat(50))
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/start', { turn: 2 })
    session.append('step/start', { turn: 2, step: 1 })
    session.append('user/message', { source: { kind: 'goal' }, content: [{ type: 'text', text: '目标自动继续'.repeat(20) }] })
    session.pushAssistant('第二轮输出'.repeat(50))
    session.append('step/end', { turn: 2, step: 1 })
    await ctx.callPreStep(session)
    await settle(engine)

    // 真人判定（默认）：唯一真人回合就是当前回合 → 没有候选。
    const human = await engine.dryRunArchive('session-fake', session, { turnBasis: 'human' })
    assert.equal(human.status, 'no-candidate', JSON.stringify(human))

    // DSH 轮次判定：第 1 轮已完成；预览与执行必须给出同一个 span。
    const planned = await engine.dryRunArchive('session-fake', session, { turnBasis: 'dsh' })
    assert.equal(planned.status, 'planned', JSON.stringify(planned))
    const archived = await engine.archiveForStep('session-fake', session, { turnBasis: 'dsh' })
    assert.equal(archived.status, 'archived', JSON.stringify(archived))
    assert.deepEqual([archived.startSeq, archived.endSeq], [planned.startSeq, planned.endSeq],
      '预览与执行不得各说各话')
    assert.equal((await engine.historyOf('session-fake')).total, 1)
    assert.equal(engine.stateOf('session-fake').surface.lastArchiveEndSeq, 3,
      '归档只覆盖第 1 轮（seq 2–3），当前第 2 轮不得被压')

    const nodes = await session.surface.nodes
    assert.ok(nodes.includes(7) && nodes.includes(8), '当前轮（目标自动继续）必须留在活动面：' + JSON.stringify(nodes))
    assert.ok(!nodes.includes(2) && !nodes.includes(3), '第 1 轮已被回执替换：' + JSON.stringify(nodes))

    // 当前轮再压一次仍是 no-candidate（不是静默重复归档）。
    const again = await engine.archiveForStep('session-fake', session, { turnBasis: 'dsh' })
    assert.equal(again.status, 'no-candidate', JSON.stringify(again))
    assert.deepEqual(ctx.warnings, [], '归档不得告警失败')
  } finally {
    await engine._waitForIdle().catch(() => {})
    engine.dispose()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})

/**
 * 0.14.0-beta.49：滞后的 payload.turn 不得把所有已完成轮都标成当前轮。
 *
 * 触发形状：日志已经到第 3 轮，但宿主交回的 currentTurn 仍是 1（目标自动继续、
 * 子代理或旧宿主都可能这样）。旧判据只挡「超前」，'group.turn >= 1' 于是把第 1/2 轮
 * 也标成 current，按轮归档对整段历史返回 no-candidate；本用例在修前必红。
 */
test('按轮归档：currentTurn 滞后于日志最大轮时，仍按最后一组为当前轮归档', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-stale-turn'))
  const ctx = fakeCtx()
  const engine = attachV3Engine(ctx, { v3Root: root })
  try {
    const session = createFakeSession({ cwd: 'C:\\ws', contextWindow: 100000 })
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.pushUser('第一轮真人'.repeat(50))
    session.pushAssistant('第一轮输出'.repeat(50))
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/start', { turn: 2 })
    session.append('step/start', { turn: 2, step: 1 })
    session.append('user/message', { source: { kind: 'goal' }, content: [{ type: 'text', text: '自动继续二'.repeat(30) }] })
    session.pushAssistant('第二轮输出'.repeat(50))
    session.append('step/end', { turn: 2, step: 1 })
    session.append('turn/start', { turn: 3 })
    session.append('step/start', { turn: 3, step: 1 })
    session.append('user/message', { source: { kind: 'goal' }, content: [{ type: 'text', text: '自动继续三'.repeat(30) }] })
    session.pushAssistant('第三轮输出'.repeat(50))
    session.append('step/end', { turn: 3, step: 1 })
    // 先 recall-only 建库，避免 pre-step 用 human 判定抢先归档。
    await engine.setState('session-fake', { mode: 'recall-only' })
    await ctx.callPreStep(session)
    await settle(engine)
    await engine.setState('session-fake', { mode: 'full-history' })
    const stale = await engine.archiveForStep('session-fake', session, { turnBasis: 'dsh' }, { turn: 1 })
    assert.equal(stale.status, 'archived', '滞后 turn 不得让全部轮都变 current：' + JSON.stringify(stale))
    assert.deepEqual([stale.startSeq, stale.endSeq], [2, 3], '只压第 1 轮，最后一组仍是当前轮')
    const nodes = await session.surface.nodes
    assert.ok(nodes.includes(7) && nodes.includes(8), '第 2 轮必须保留：' + JSON.stringify(nodes))
    assert.ok(nodes.includes(12) && nodes.includes(13), '第 3 轮必须保留：' + JSON.stringify(nodes))
    assert.equal(engine.stateOf('session-fake').surface.lastArchiveEndSeq, 3)
  } finally {
    await engine._waitForIdle().catch(() => {})
    engine.dispose()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})

/**
 * AUD48-04-04：真实宿主的系统提示是 surface node 0，且插件摄入封闭集不含
 * system/message（没有 v3 记录）；宿主还拒绝 user 回执覆盖 node 0。旧分组把它算进
 * 第 1 轮 → missing-record 队头 break，按轮归档整体失效（真实 25 会话命中）。
 * 修法：system/developer 不纳入轮组，作为边界留在活动面，档从它之后开始。
 */
test('按轮归档：首节点系统提示不阻塞归档，系统提示保留在活动面（AUD48-04-04）', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-system-head-'))
  const ctx = fakeCtx()
  const engine = attachV3Engine(ctx, { v3Root: root })
  try {
    const session = createFakeSession({ cwd: 'C:\\ws', contextWindow: 100000 })
    const system = session.pushSystem('系统提示：你是 DSH 代理。')
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.pushUser('第一轮真人'.repeat(50))
    session.pushAssistant('第一轮输出'.repeat(50))
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/start', { turn: 2 })
    session.append('step/start', { turn: 2, step: 1 })
    session.pushUser('第二轮真人'.repeat(50))
    session.pushAssistant('第二轮输出'.repeat(50))
    session.append('step/end', { turn: 2, step: 1 })
    // 先 recall-only 建库，避免 pre-step 用 human 判定抢先归档。
    await engine.setState('session-fake', { mode: 'recall-only' })
    await ctx.callPreStep(session)
    await settle(engine)
    await engine.setState('session-fake', { mode: 'full-history' })
    const archived = await engine.archiveForStep('session-fake', session, { turnBasis: 'dsh' }, { turn: 2 })
    assert.equal(archived.status, 'archived', '系统提示不得堵死首轮：' + JSON.stringify(archived))
    assert.ok(archived.startSeq > system.seq, 'span 必须从系统提示之后开始：' + JSON.stringify(archived))
    assert.equal(archived.receiptText.includes('回合数：1'), true, '回执按轮应写回合数：' + archived.receiptText)
    assert.equal(archived.receiptText.includes('操作数：'), false)
    const nodes = await session.surface.nodes
    assert.ok(nodes.includes(system.seq), '系统提示必须仍在活动面：' + JSON.stringify(nodes))
    assert.ok(nodes.includes(archived.receiptSeq), '回执应落面：' + JSON.stringify(nodes))
  } finally {
    await engine._waitForIdle().catch(() => {})
    engine.dispose()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})

/**
 * 回执边界：归档产生的回执是「上一段」的替代物，但它的事件 seq 落在下一轮开头
 * （turn/start 已把它的 seq 归到下一轮）。旧分组把回执算进下一轮 → hasPlugin →
 * 下一轮永远不能归档，归档只成功一次。修法：非回注插件节点不参与轮组。
 */
test('按轮归档：上一轮回执不得把下一轮当插件边界', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-receipt-boundary-'))
  const ctx = fakeCtx()
  const engine = attachV3Engine(ctx, { v3Root: root })
  try {
    const session = createFakeSession({ cwd: 'C:\\ws', contextWindow: 100000 })
    const system = session.pushSystem('系统提示')
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.pushUser('第一轮真人'.repeat(50))
    session.pushAssistant('第一轮输出'.repeat(50))
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/start', { turn: 2 })
    session.append('step/start', { turn: 2, step: 1 })
    session.pushUser('第二轮真人'.repeat(50))
    session.pushAssistant('第二轮输出'.repeat(50))
    session.append('step/end', { turn: 2, step: 1 })
    await engine.setState('session-fake', { mode: 'recall-only' })
    await ctx.callPreStep(session)
    await settle(engine)
    await engine.setState('session-fake', { mode: 'full-history' })
    const first = await engine.archiveForStep('session-fake', session, { turnBasis: 'dsh' }, { turn: 2 })
    assert.equal(first.status, 'archived', JSON.stringify(first))

    // 第三轮：让第 2 轮成为已完成轮；回执现在位于第 2 轮节点之前。
    session.append('turn/start', { turn: 3 })
    session.append('step/start', { turn: 3, step: 1 })
    session.pushUser('第三轮真人'.repeat(50))
    session.pushAssistant('第三轮输出'.repeat(50))
    session.append('step/end', { turn: 3, step: 1 })
    await engine.setState('session-fake', { mode: 'recall-only' })
    await ctx.callPreStep(session)
    await settle(engine)
    await engine.setState('session-fake', { mode: 'full-history' })
    const second = await engine.archiveForStep('session-fake', session, { turnBasis: 'dsh' }, { turn: 3 })
    assert.equal(second.status, 'archived', '上一轮回执不得挡住下一轮：' + JSON.stringify(second))
    assert.ok(second.startSeq > first.endSeq, '第二段必须接在回执之后：' + JSON.stringify(second))
    assert.equal((await engine.historyOf('session-fake')).total, 2)
    const nodes = await session.surface.nodes
    assert.ok(nodes.includes(system.seq), '系统提示必须仍在活动面：' + JSON.stringify(nodes))
  } finally {
    await engine._waitForIdle().catch(() => {})
    engine.dispose()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})
