/**
 * AUD-09 守卫：读租约只保护工作集，不钉住已完成回合；拒绝原因必须可观测。
 *
 * ## 缺陷（2026-10-28 审计附录 A，AUD-09 P2）
 * 按轮归档在每个 pre-step 都会评估，但回注每命中一次就把命中记录写成 5 分钟读租约
 * （`markReadLease`，TTL 300s），而选择器把租约当**整组硬边界**——组里只要有一条被钉，
 * 整组放弃。回注命中的通常正是「上一轮」的记录，于是上一轮被钉最长 5 分钟：
 * 用户看到「新一轮开头占用不降，过几分钟突然掉一大截」。
 *
 * ## 判据来源
 * `AUD-01-会话闸门覆盖不可见-20261028.md` 附录 A（§A.3 链路、§A.4 真实会话复算、
 * §A.7 方案 A「租约只保护工作集」、§A.11 关闭标准）。
 *
 * ## 断言组
 * 1. 已完成回合里的记录带**未来到期**的读租约 → 下一个 `archiveForStep` 仍必须归档。
 * 2. 显式 `pin` 仍是整组硬边界：`no-candidate` + `reason='pinned'` + 命中 seq；
 *    解除 pin 后立刻归档（保护是用户意图，不是延迟）。
 * 3. `no-completed-group`（只有当前回合）与 `pinned` 可区分——旧实现两者都是
 *    裸 `no-candidate`，线上只能反推。
 * 4. 按步归档（cooling）仍吃租约：它压的是**当前回合内**的旧步骤，刚读过的记录不能撤。
 * 5. `/memory-lab status` 的「下一次归档」把原因翻成中文（观察面落地）。
 *
 * ## 不适用条件与已知边界
 * - 不覆盖 5 分钟 TTL 的绝对值：修复不靠调 TTL（方案 B），而靠收窄租约的作用面（方案 A）。
 * - 不覆盖真实宿主的时间线（`usage.jsonl` 占用曲线）：需要重启后在真实会话复跑。
 * - `busy-or-not-ready`（摄入与归档抢同一毫秒）仍可能丢一次机会，属独立竞态，见 A.10。
 *
 * ## 定点变异自证（2026-10-29 实测）
 * 把按轮分支改回 `pinnedSeqsOf(entry, state)`（含租约）→ 第 1 组红；
 * 把选择器的 `onReject` 去掉 → 第 2/5 组红；恢复后全绿。
 *
 * ## 运行
 * `node --test-force-exit test/v3-archive-lease.test.mjs`（已接 npm test）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { selectArchiveSpan } from '../src/v3/domain/archive/candidates.mjs'
import { attachV3Engine } from '../src/v3/entry/v3-entry.mjs'
import { createFakeSession } from './helpers/fake-session.mjs'

const ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.mjs')

function fakeCtx() {
  const handlers = new Map()
  const warnings = []
  const ctx = {
    warnings,
    on(name, handler) { handlers.set(name, handler); return () => handlers.delete(name) },
    effect(fn) { const disposer = fn(); return () => { if (typeof disposer === 'function') disposer() } },
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

/** 两轮夹具：第一轮已完成（user0/assistant1），第二轮只是当前回合（user2）。 */
async function twoTurnFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-aud09-'))
  const ctx = fakeCtx()
  const engine = attachV3Engine(ctx, { v3Root: root })
  const session = createFakeSession({ cwd: 'C:\\ws', contextWindow: 100000 })
  session.pushUser('第一问'.repeat(60))
  session.pushAssistant('第一答'.repeat(60))
  session.pushUser('当前问题'.repeat(10))
  await ctx.callPreStep(session)
  await settle(engine)
  return { root, ctx, engine, session }
}

test('AUD-09：读租约不得钉住已完成回合（回注命中上一轮 → 下一个 pre-step 照常归档）', async () => {
  const { root, engine, session } = await twoTurnFixture()
  try {
    const working = await engine.workingSet('session-fake')
    assert.equal(working.error, undefined)
    const row = working.rows.find((item) => item.seq === 1)
    assert.ok(row, '第一答应有记录：' + JSON.stringify(working.rows))
    // 模拟回注命中：真源里 markReadLease 会把命中记录写成未来 5 分钟的读租约。
    await engine.setState('session-fake', {
      readLease: [{ recordId: row.recordId, expiresAt: Date.now() + 5 * 60 * 1000 }],
    })
    const result = await engine.archiveForStep('session-fake', session, {})
    assert.equal(result.status, 'archived',
      '租约内的已完成回合必须照常归档（旧行为：整组被钉 5 分钟）——实际 ' + JSON.stringify(result))
    assert.equal(result.startSeq, 0)
    assert.ok(result.endSeq >= 1)
    // 当前回合的工作集不受影响（A.9.4：保护不回退）。
    const after = await engine.workingSet('session-fake')
    assert.deepEqual(after.rows.map((item) => item.seq), [2], '当前回合的记录必须还在活动面')
  } finally {
    await engine._waitForIdle().catch(() => {})
    engine.dispose()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})

test('显式 pin 仍是硬边界，且 no-candidate 的 reason 可读（pinned + seq）', async () => {
  const { root, engine, session } = await twoTurnFixture()
  try {
    const working = await engine.workingSet('session-fake')
    const row = working.rows.find((item) => item.seq === 1)
    assert.ok(row)
    assert.deepEqual((await engine.pinRecords('session-fake', [row.recordId])).pins, [row.recordId])

    const blocked = await engine.archiveForStep('session-fake', session, {})
    assert.equal(blocked.status, 'no-candidate')
    assert.equal(blocked.reason, 'pinned', '原因必须说清是 pin，而不是笼统的「没有候选」')
    assert.equal(blocked.count, 1)
    assert.deepEqual(blocked.seqs, [1], '被保护的具体 seq 必须可见')

    // 预览与真实执行同一判据：dry-run 也报 pinned。
    const preview = await engine.dryRunArchive('session-fake', session, {})
    assert.equal(preview.status, 'no-candidate')
    assert.equal(preview.reason, 'pinned')

    await engine.pinRecords('session-fake', [row.recordId], { remove: true })
    const archived = await engine.archiveForStep('session-fake', session, {})
    assert.equal(archived.status, 'archived', '解除 pin 后必须立刻归档：' + JSON.stringify(archived))
  } finally {
    await engine._waitForIdle().catch(() => {})
    engine.dispose()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})

test('domain 层拒绝原因不丢码：missing-record 带命中 seq（裸字符串调用点也归一）', () => {
  const session = createFakeSession({ cwd: 'C:\\ws' })
  session.pushUser('第一问')
  session.pushAssistant('第一答')
  session.pushUser('当前问题')
  const rejections = []
  const span = selectArchiveSpan({
    surfaceNodes: [0, 1, 2],
    events: session.log,
    hasRecord: () => false,
    mode: 'full-history',
    onReject: (row) => rejections.push(row),
  })
  assert.equal(span, null)
  assert.equal(rejections.length, 1, '只报一次原因：' + JSON.stringify(rejections))
  assert.equal(rejections[0].reason, 'missing-record', '原因码不得变成 undefined')
  assert.deepEqual(rejections[0].seqs, [0, 1])
  assert.equal(rejections[0].count, 2)
})

test('no-completed-group 与 pinned 可区分（只有当前回合时不谎报被保护）', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-aud09-single-'))
  const ctx = fakeCtx()
  const engine = attachV3Engine(ctx, { v3Root: root })
  const session = createFakeSession({ cwd: 'C:\\ws', contextWindow: 100000 })
  session.pushUser('唯一一问'.repeat(40))
  session.pushAssistant('唯一一答'.repeat(40))
  try {
    await ctx.callPreStep(session)
    await settle(engine)
    const result = await engine.dryRunArchive('session-fake', session, {})
    assert.equal(result.status, 'no-candidate')
    assert.equal(result.reason, 'no-completed-group', '当前回合永不归档：原因不能写成 pinned/missing-record')
  } finally {
    await engine._waitForIdle().catch(() => {})
    engine.dispose()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})

test('按步归档（cooling）仍吃读租约：当前回合内刚读过的步骤不能被压', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-aud09-cooling-'))
  const ctx = fakeCtx()
  const engine = attachV3Engine(ctx, { v3Root: root })
  const session = createFakeSession({ cwd: 'C:\\ws' })
  session.pushContextWindow(1000000)
  session.pushUser('第一问'.repeat(60))
  for (let step = 1; step <= 6; step += 1) {
    session.append('step/start', { turn: 1, step })
    session.pushAssistant(('第' + step + '步输出').repeat(40))
    session.append('step/end', { turn: 1, step })
  }
  try {
    await ctx.callPreStep(session)
    await settle(engine)
    await engine.setState('session-fake', { mode: 'cooling' })
    const usageDir = path.join(root, 'sessions', 'session-fake')
    await mkdir(usageDir, { recursive: true })
    await writeFile(path.join(usageDir, 'usage.jsonl'), JSON.stringify({ seq: 1, inputTokens: 300000, totalTokens: 300001 }) + '\n')
    const working = await engine.workingSet('session-fake')
    // 夹具里用户消息在 step/start 之前（真实 DSH 在 step 1 内），故第 1 步可压；
    // 钉住它的输出，选择器必须整步放弃（步骤是硬边界，不切半个步骤）。
    const outputs = working.rows.filter((item) => item.seq !== 1)
    const pinnedStep = outputs[0]
    assert.ok(pinnedStep, '第 1 步的输出应有记录：' + JSON.stringify(working.rows))
    await engine.setState('session-fake', {
      readLease: [{ recordId: pinnedStep.recordId, expiresAt: Date.now() + 5 * 60 * 1000 }],
    })
    const blocked = await engine.archiveForStep('session-fake', session, { retainOperations: 2 })
    assert.equal(blocked.status, 'no-candidate', '按步归档压的是当前回合内旧步骤：租约必须仍然生效')
    assert.equal(blocked.reason, 'pinned')
    // 对照（防误杀）：清掉租约后同一份夹具有候选并归档。
    await engine.setState('session-fake', { readLease: [] })
    const archived = await engine.archiveForStep('session-fake', session, { retainOperations: 2 })
    assert.equal(archived.status, 'archived', JSON.stringify(archived))
  } finally {
    await engine._waitForIdle().catch(() => {})
    engine.dispose()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})

test('status 的「下一次归档」把拒绝原因翻成中文（观察面落地）', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'mcl-aud09-status-'))
  const previousHome = process.env.DSH_HOME
  const previousT2 = process.env.MEMORY_LAB_T2
  process.env.DSH_HOME = home
  process.env.MEMORY_LAB_T2 = '0'
  try {
    const module = await import(pathToFileURL(ENTRY).href + '?t=' + Date.now())
    const hooks = []
    let command = null
    const ctx = {
      on(name, handler, opts) { hooks.push({ name, handler, opts }); return () => {} },
      effect(fn) { const disposer = fn(); return () => { if (typeof disposer === 'function') disposer() } },
      logger: { warn() {}, info() {} },
      commands: { register(row) { command = row; return () => {} } },
      inject() { return { dispose() {} } },
    }
    await module.apply(ctx, {})
    assert.ok(command, '命令必须注册')
    const session = createFakeSession({ cwd: 'C:\\ws', contextWindow: 100000, id: 's-aud09-status' })
    // 新会话默认停用（defaultEnabled=false）：先显式 on，否则摄入钩子直接返回、永远 not-ready。
    assert.equal((await command.handler({ agent: { session }, rawInput: 'on' })).kind, 'success')
    session.pushUser('唯一一问'.repeat(40))
    session.pushAssistant('唯一一答'.repeat(40))
    const ingest = hooks.find((hook) => hook.name === 'agent/pre-step' && hook.opts?.prepend !== true)
    assert.ok(ingest, '摄入钩子必须注册')
    await ingest.handler({ agent: { session }, signal: undefined }, async () => ({ kind: 'enter' }))
    const run = (line) => command.handler({ agent: { session }, rawInput: line })
    let ready = false
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const status = await run('status')
      if (/已摄入 [1-9]/.test(status.text) && !/后台摄入进行中/.test(status.text)) { ready = true; break }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    assert.ok(ready, '摄入必须在超时前完成（本用例依赖真实库）')
    const status = await run('status')
    assert.match(status.text, /下一次归档：暂无可归档的完成操作（只有当前回合/,
      'status 必须直接回答「为什么没压」，而不是只印一句暂无可归档：\n' + status.text)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    if (previousT2 === undefined) delete process.env.MEMORY_LAB_T2
    else process.env.MEMORY_LAB_T2 = previousT2
    await rm(home, { recursive: true, force: true }).catch(() => {})
  }
})
