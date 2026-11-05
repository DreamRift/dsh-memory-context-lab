/**
 * 按步归档的**批量阈值**（0.15 候选，未升号）。
 *
 * 权威口径（v2 退场前的 core-settings.mjs）：
 * - `NUMERIC_SETTINGS.batch = { key: 'archiveBatchSize', min: 1, max: 200, integer: true }`；
 * - `DEFAULT_SETTINGS.archiveBatchSize = 10`（内置预设 3 / 10 / 16）；
 * - 语义：「窗口外有多少候选之后才提交一批」——不足阈值等待，达到阈值只取最旧一批，
 *   阈值外候选留给后续批次；活动面保护/非合格单元切断连续 run。
 *
 * v3 按步归档（cooling）把单位改成**完整步骤**，与两个邻近参数严格分开：
 * - retainSteps（工作集，最近 4 步不压）决定「哪些不能压」；
 * - batchSteps/coolingBatchSize 决定「攒够多少才压」；
 * - maxSteps 只是调用方可选的硬上限；产品默认不传，因此提交上限 = 批量阈值。
 *
 * 合同（P3 审阅）：
 * 1. 自动 cooling / 自动预览：闭合前缀 B >= T 才提交，一次最多提交 T 步（积压 12 → 压 10 留 2）；
 * 2. 硬边界把 run 切断、B < T → short-run-flush（边界不可跨越，等整批会永久停摆）；
 * 3. 无边界且 B < T → waiting-batch；surface 与 voucher 都不变；
 * 4. 显式 now/compact 绕普通节奏门（gate + 阈值），但不绕安全边界与正净收益；
 * 5. 全局 volatile 设置，无会话覆盖；0/越界/小数回落默认 10（1–200）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { attachV3Engine } from '../src/v3/entry/v3-entry.mjs'
import { selectStepSpan, STEP_BATCH_DEFAULT, STEP_BATCH_MAX, STEP_BATCH_MIN, normalizeStepBatch } from '../src/v3/domain/archive/steps.mjs'
import { readSettings, settingsLine, SETTINGS_DEFAULTS, Config } from '../src/index.mjs'
import { SESSION_OVERRIDE_KEYS } from '../src/v3/domain/session/session-control.mjs'
import { createFakeSession } from './helpers/fake-session.mjs'

const hasRecord = () => true

/** 一步占 3 个 seq：start / 一个活动面 assistant / end。 */
function step(turn, index, start) {
  return [
    { seq: start, type: 'step/start', data: { turn, step: index } },
    { seq: start + 1, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'a' + (start + 1) }] } } },
    { seq: start + 2, type: 'step/end', data: { turn, step: index } },
  ]
}
const surfaceOf = (events) => events.filter((e) => !String(e.type).startsWith('step/')).map((e) => e.seq)
const rejectionOf = (run) => {
  let rejection = null
  run((row) => { rejection = rejection ?? row })
  return rejection
}
function stepsFixture(count) {
  const events = []
  for (let index = 1; index <= count; index += 1) events.push(...step(1, index, (index - 1) * 3 + 1))
  return events
}

// —— 判定层：阈值/积压/边界/等待 ——

test('阈值下方等待：窗口外 9 步、阈值 10 → waiting-batch，不产生 span', () => {
  const events = stepsFixture(10) // retainSteps=1 → 窗口外 9 步
  const selection = rejectionOf((onReject) => selectStepSpan({ surfaceNodes: surfaceOf(events), events, hasRecord, retainSteps: 1, batchSteps: 10, onReject }))
  assert.equal(selection?.reason, 'waiting-batch')
  assert.equal(selection.threshold, 10, 'threshold 才是配置阈值')
  assert.equal(selection.batch, 9, 'batch 是当前闭合步数（P3 合同）')
  assert.equal(selection.needed, 1)
  assert.equal(selection.eligible, 9)
  assert.equal(selection.scanned, 9)
  assert.equal(selectStepSpan({ surfaceNodes: surfaceOf(events), events, hasRecord, retainSteps: 1, batchSteps: 10 }), null)
})

test('阈值达成：窗口外 10 步、阈值 10 → 一次提交最旧 10 步（提交上限=阈值）', () => {
  const events = stepsFixture(11) // retainSteps=1 → 窗口外 10 步
  const surface = surfaceOf(events)
  const span = selectStepSpan({ surfaceNodes: surface, events, hasRecord, retainSteps: 1, batchSteps: 10 })
  assert.ok(span)
  assert.equal(span.steps, 10, '阈值 10 必须能一次压 10 步（旧的 maxSteps=3 硬上限已退役）')
  assert.equal(span.closedPrefix, 10)
  assert.equal(span.steps, span.closedPrefix, 'policy 要求 steps === closedPrefix')
  assert.equal(span.closedEndSeq, span.endSeq, 'policy 用 closedEndSeq 计算前缀末端')
  assert.equal(span.threshold, 10)
  assert.equal(span.boundary, null)
  assert.equal(span.shortRunFlush, false)
  assert.equal(span.startSeq, surface[0])
  assert.equal(span.endSeq, surface[9], '只取最旧 10 步，第 11 步留在工作集')
})

test('积压 12：本批只取最旧 10 步，余 2 步留给后续批次', () => {
  const events = stepsFixture(13) // retainSteps=1 → 窗口外 12 步
  const surface = surfaceOf(events)
  const span = selectStepSpan({ surfaceNodes: surface, events, hasRecord, retainSteps: 1, batchSteps: 10 })
  assert.equal(span.steps, 10)
  assert.equal(span.endSeq, surface[9], '第 11/12 步不得被卷进本批')
  assert.ok(surface.slice(0, 10).every((seq) => span.sourceEventSeqs.includes(seq)))
  assert.equal(span.sourceEventSeqs.includes(surface[10]), false)
  // 后续批次：把已提交的前 10 步从活动面移除后，余 2 步 + 新步骤继续按阈值攒批。
  const restEvents = stepsFixture(13).filter((event) => !surface.slice(0, 10).includes(event.seq))
  const restSurface = surfaceOf(restEvents)
  const waiting = rejectionOf((onReject) => selectStepSpan({ surfaceNodes: restSurface, events: restEvents, hasRecord, retainSteps: 1, batchSteps: 10, onReject }))
  assert.equal(waiting?.reason, 'waiting-batch', '余 2 步未满阈值，等待后续批次')
  assert.equal(waiting.eligible, 2)
})

test('批内保护洞：候选 12 步达标后 pin 切断 → 同批两段一起提交（多 run，P3）', () => {
  const events = stepsFixture(13) // 窗口外 12 步 >= 阈值 10
  const surface = surfaceOf(events)
  const span = selectStepSpan({ surfaceNodes: surface, events, hasRecord, retainSteps: 1, batchSteps: 10, pinnedSeqs: new Set([surface[3]]) })
  assert.ok(span, '候选总量达标后，批内被保护洞切断的段仍要提交（v2 按相邻性拆 run）')
  // 窗口 = 最旧 10 个候选（step1–10）；pin 在 step4 → run1=step1–3、run2=step5–10，
  // 两段同批提交（逐段 intent/voucher），不再等下一批凑够阈值（P3 多 run）。
  assert.equal(span.segments.length, 2, '保护洞两侧各成一个安全段')
  assert.deepEqual(span.segments.map((segment) => segment.steps), [3, 6])
  assert.equal(span.totalSteps, 9)
  assert.equal(span.steps, 3, '顶层是首段（兼容单 span 消费者）')
  assert.equal(span.boundary, 'pinned')
  assert.equal(span.shortRunFlush, true)
  assert.equal(span.sourceEventSeqs.includes(surface[3]), false, 'pin 节点绝不能被遮蔽')
  assert.equal(span.segments[1].sourceEventSeqs.includes(surface[3]), false, '第二段同样不碰 pin')
  assert.equal(span.segments[1].startSeq, surface[4], '第二段从 pin 之后的第一步开始')
  assert.equal(span.segments[1].endSeq, surface[9], '第二段吃满窗口内的剩余候选，step11–12 留给后续批次')
})

test('候选总量不足阈值时，即使有硬边界也等待（闸门只判 eligible，不提前短批）', () => {
  const events = stepsFixture(10) // retainSteps=1 → 窗口外 9 步 < 阈值 10
  const surface = surfaceOf(events)
  const selection = rejectionOf((onReject) => selectStepSpan({ surfaceNodes: surface, events, hasRecord, retainSteps: 1, batchSteps: 10, pinnedSeqs: new Set([surface[3]]), onReject }))
  assert.equal(selection?.reason, 'waiting-batch', 'v2 §40：先攒够 N 个 eligible，再谈批内分段')
  assert.equal(selection.eligible, 9, '候选总量 9 < 阈值 10')
  assert.equal(selection.batch, 9, 'batch 是闸门分子：已落出窗口的候选数')
  assert.equal(selection.closedSteps, 8, '其中可安全归档 8 步（pin 占 1 个候选）')
  assert.equal(selection.needed, 1, '还差 1 个候选才过闸')
  assert.equal(selection.threshold, 10)
  assert.equal(selection.boundary, 'pinned', '边界事实仍要上报给 policy')
})

test('候选总量不足阈值 → waiting（scanLimit 截断同样等待，不短批）', () => {
  const events = stepsFixture(13) // 窗口外 12 步
  const surface = surfaceOf(events)
  const selection = rejectionOf((onReject) => selectStepSpan({ surfaceNodes: surface, events, hasRecord, retainSteps: 1, batchSteps: 10, scanLimit: 5, onReject }))
  assert.equal(selection?.reason, 'waiting-batch')
  assert.equal(selection.scanned, 5, 'scanLimit（H=200 合同）限制单次扫描量')
  assert.equal(selection.eligible, 5)
  assert.equal(selection.batch, 5)
  assert.equal(selection.threshold, 10)
  assert.equal(selection.boundary, null)
})

test('阈值小于 maxSteps 时一次只提交阈值步数；显式 bypassBatch 可提交不满阈值的安全 run', () => {
  const events = stepsFixture(6) // retainSteps=1 → 窗口外 5 步
  const surface = surfaceOf(events)
  const batched = selectStepSpan({ surfaceNodes: surface, events, hasRecord, retainSteps: 1, batchSteps: 2, maxSteps: 3 })
  assert.equal(batched.steps, 2, '阈值 2：一次只压最旧 2 步（maxSteps 是上限，不是目标）')
  const explicit = selectStepSpan({ surfaceNodes: surface, events, hasRecord, retainSteps: 1, batchSteps: 10, bypassBatch: true })
  assert.equal(explicit.steps, 5, 'now/compact 显式动作可绕阈值，提交安全可用的整段')
  assert.equal(explicit.shortRunFlush, true)
})

test('阈值与工作集分离：同一批步骤，retainSteps 只改变窗口外候选数', () => {
  const events = stepsFixture(12) // 12 步
  const surface = surfaceOf(events)
  assert.equal(selectStepSpan({ surfaceNodes: surface, events, hasRecord, retainSteps: 1, batchSteps: 10 })?.steps, 10)
  const waiting = rejectionOf((onReject) => selectStepSpan({ surfaceNodes: surface, events, hasRecord, retainSteps: 3, batchSteps: 10, onReject }))
  assert.equal(waiting?.reason, 'waiting-batch', '工作集更大 → 窗口外只剩 9 步 → 等待')
  assert.equal(waiting.eligible, 9)
  assert.equal(waiting.batch, 9)
  assert.equal(waiting.needed, 1)
})

test('scanLimit 合同 H=200：超长积压也只扫描并提交最旧 200 步', () => {
  const events = stepsFixture(260) // retainSteps=1 → 窗口外 259 步
  const span = selectStepSpan({ surfaceNodes: surfaceOf(events), events, hasRecord, retainSteps: 1, batchSteps: 200 })
  assert.ok(span)
  assert.equal(span.steps, 200, '单次扫描/提交上限 H=200')
  assert.equal(span.sourceEventSeqs.length, 200)
})

test('显式动作也受 H=200 安全上限：bypassBatch 一次最多 200 步', () => {
  const events = stepsFixture(260) // retainSteps=1 → 窗口外 259 步
  const span = selectStepSpan({ surfaceNodes: surfaceOf(events), events, hasRecord, retainSteps: 1, batchSteps: 10, bypassBatch: true })
  assert.ok(span, '显式动作绕的是阈值，不是扫描/提交上限')
  assert.equal(span.scanLimit, 200)
  assert.equal(span.segments.length, 1)
  assert.equal(span.totalSteps, 200, 'manual 一次也只提交 H=200 步')
  assert.equal(span.steps, 200)
})

test('扫描上限耗尽且无硬边界：提交闭合前缀，并把 reachedLimit 如实报在 blocked 上', () => {
  const events = stepsFixture(260) // retainSteps=1 → 候选 259 步，scanLimit H=200 截断
  // 第 150 步声明一个永无结果的调用：闭合前缀停在 149，且扫描窗口内没有硬边界。
  const assistantSeq = (150 - 1) * 3 + 2
  const index = events.findIndex((event) => event.seq === assistantSeq)
  events[index] = {
    seq: assistantSeq,
    type: 'assistant/message',
    data: { message: { content: [{ type: 'tool-call', id: 'x', name: 'run', arguments: '{}' }] } },
  }
  // 旧行为：整批拒绝（连 149 步安全前缀也不压）→ 队头永久停摆。P3 改为提交闭合
  // 前缀，把未闭合开尾用 blocked/reachedLimit 报出来（不把上限截断冒充整批成功）。
  const span = selectStepSpan({ surfaceNodes: surfaceOf(events), events, hasRecord, retainSteps: 1, batchSteps: 200 })
  assert.ok(span, '149 步安全闭合前缀必须可提交')
  assert.equal(span.steps, 149, '闭合前缀只到未闭合调用之前')
  assert.equal(span.totalSteps, 149)
  assert.equal(span.reachedLimit, true)
  assert.equal(span.truncated, true)
  assert.equal(span.blocked?.reason, 'tool-closure-exceeds-limit')
  assert.equal(span.blocked?.reachedLimit, true)
})

// —— 设置层：单一真源 + 校验（全局 volatile，无 session override） ——

test('设置单一真源：Config/默认值/回落都引用 domain 常量（1–200，默认 10，0 非法）', () => {
  assert.equal(STEP_BATCH_DEFAULT, 10)
  assert.equal(STEP_BATCH_MIN, 1)
  assert.equal(STEP_BATCH_MAX, 200)
  assert.equal(SETTINGS_DEFAULTS.coolingBatchSize, STEP_BATCH_DEFAULT)
  const json = Config.toJSON()
  const root = json.refs?.[json.uid] ?? json
  const refs = json.refs ?? {}
  const node = refs[root.dict.coolingBatchSize] ?? root.dict.coolingBatchSize
  assert.equal(node.meta?.default, STEP_BATCH_DEFAULT)
  assert.equal(node.meta?.min, STEP_BATCH_MIN)
  assert.equal(node.meta?.max, STEP_BATCH_MAX)
  assert.equal(node.meta?.volatile, true)
  assert.equal(node.type, 'number')
})

test('不做会话覆盖：批量阈值只有全局 Config，覆盖项仍是 limit/gate', () => {
  assert.deepEqual([...SESSION_OVERRIDE_KEYS], ['limit', 'gate'])
  assert.equal(SESSION_OVERRIDE_KEYS.includes('coolingBatchSize'), false)
})

test('非法批量阈值回落默认 10：0 / 负数 / 小数 / 超上界都不静默夹取', () => {
  assert.equal(normalizeStepBatch(0), 10, '0 非法（v2 CLI/schema 同口径）')
  assert.equal(normalizeStepBatch(201), 10)
  assert.equal(normalizeStepBatch(2.5), 10)
  assert.equal(normalizeStepBatch('10'), 10)
  assert.equal(normalizeStepBatch(undefined), 10)
  assert.equal(normalizeStepBatch(1), 1)
  assert.equal(normalizeStepBatch(200), 200)
  assert.equal(readSettings({}).coolingBatchSize, 10)
  assert.equal(readSettings({ coolingBatchSize: 0 }).coolingBatchSize, 10)
  assert.equal(readSettings({ coolingBatchSize: 99 }).coolingBatchSize, 99)
  assert.equal(readSettings({ coolingBatchSize: '99' }).coolingBatchSize, 10)
  assert.match(settingsLine(SETTINGS_DEFAULTS), /按步批量 10 步/)
})

// —— 引擎层：自动 / 预览一致；显式 now/compact 绕节奏门但不绕安全 ——

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

/** 大步骤：正文远大于回执，保证净收益为正。 */
function pushBigStep(session, index) {
  session.append('step/start', { turn: 1, step: index })
  session.pushAssistant(('第 ' + index + ' 步数据 ').repeat(120))
  session.append('step/end', { turn: 1, step: index })
}

async function withCoolingEngine(body, { steps = 0, id = 's-step-batch', contextWindow = 1000000 } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-step-batch-'))
  const ctx = fakeCtx()
  const engine = attachV3Engine(ctx, { v3Root: root })
  try {
    const session = createFakeSession({ id, contextWindow })
    session.pushContextWindow(contextWindow)
    session.pushUser('开始')
    for (let index = 1; index <= steps; index += 1) pushBigStep(session, index)
    await ctx.callPreStep(session)
    await settle(engine)
    await engine.setState(id, { mode: 'cooling' })
    return await body({ ctx, engine, session, root, id })
  } finally {
    await engine._waitForIdle().catch(() => {})
    engine.dispose()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
}

async function openGate(root, id) {
  const dir = path.join(root, 'sessions', id)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'usage.jsonl'), JSON.stringify({ seq: 1, inputTokens: 300000, totalTokens: 300001 }) + '\n')
}

test('自动 cooling：阈值 10 时 9 个窗口外步骤 waiting-batch（surface/voucher 不变），第 10 步才归档一批', async () => {
  await withCoolingEngine(async ({ ctx, engine, session, root, id }) => {
    await openGate(root, id)
    // retainOperations=1 → 现有 10 步里窗口外 9 步。
    const waitingSettings = { retainOperations: 1, coolingBatchSize: 10 }
    const before = await session.surface.nodes
    const preview = await engine.dryRunArchive(id, session, waitingSettings)
    assert.equal(preview.status, 'no-candidate')
    assert.equal(preview.reason, 'waiting-batch')
    assert.equal(preview.eligible, 9)
    assert.equal(preview.batch, 9)
    assert.equal(preview.needed, 1)
    const auto = await engine.archiveForStep(id, session, waitingSettings)
    assert.equal(auto.status, 'no-candidate')
    assert.equal(auto.reason, 'waiting-batch')
    assert.deepEqual(await session.surface.nodes, before, '未满阈值不得改 surface')
    assert.equal((await engine.historyOf(id)).total, 0, '未满阈值不得产生 voucher')

    // 第 11 步落盘 → 窗口外 10 步；预览与执行必须给出同一批。
    // 先走一次 pre-step 摄入新步骤（其自动归档用默认工作集 4 步 → 窗口外 7 步，仍在等批）。
    pushBigStep(session, 11)
    await ctx.callPreStep(session)
    await settle(engine)
    const planned = await engine.dryRunArchive(id, session, waitingSettings)
    assert.equal(planned.status, 'planned', JSON.stringify(planned))
    assert.equal(planned.steps, 10)
    const archived = await engine.archiveForStep(id, session, waitingSettings)
    assert.equal(archived.status, 'archived', JSON.stringify(archived))
    assert.equal(archived.steps, 10, '自动路径按阈值成批提交，不再被 3 步上限截断')
    assert.deepEqual([archived.startSeq, archived.endSeq], [planned.startSeq, planned.endSeq], '预览与执行同一批')
    assert.equal((await engine.historyOf(id)).total, 1)
  }, { steps: 10 })
})

test('显式 now 绕 gate 与阈值但仍走安全/净收益：pin 全挡时拒绝，pin 头只跳过该步', async () => {
  await withCoolingEngine(async ({ engine, session, root, id }) => {
    await openGate(root, id)
    // gate 95：占用约 30% < 95% → 自动路径被闸门挡住。
    const closedSettings = { retainOperations: 1, coolingBatchSize: 10, coolingGate: 95 }
    const closed = await engine.archiveForStep(id, session, closedSettings)
    assert.equal(closed.status, 'cooling-closed', JSON.stringify(closed))
    const rows = (await engine.workingSet(id)).rows
    // retainOperations=1 保留最近一步；其余（user 之外的 3 步）是窗口外候选。
    const stepRows = rows.filter((row) => row.seq !== 1)
    const outside = stepRows.slice(0, stepRows.length - 1)
    assert.equal(outside.length, 3, '夹具应有 3 个窗口外步骤记录：' + JSON.stringify(rows.map((row) => row.seq)))
    const leaseOf = (items) => items.map((row) => ({ recordId: row.recordId, expiresAt: Date.now() + 5 * 60 * 1000 }))

    // 1) 手动也不能越 pin：全部窗口外步骤被读租约保护（pinnedSeqs 来源）→ now 必须拒绝。
    await engine.setState(id, { readLease: leaseOf(outside) })
    const blocked = await engine.archiveForStep(id, session, closedSettings, { resetNotWorth: true })
    assert.equal(blocked.status, 'no-candidate', JSON.stringify(blocked))
    assert.equal(blocked.reason, 'pinned', '显式动作绕节奏门，但绝不绕安全边界')
    assert.equal((await engine.historyOf(id)).total, 0, '被 pin 挡住时不得产生 voucher')

    // 2) 只 pin 队头一步：P3 多 run 只跳过该步，pin 之后的 2 步安全段照常提交；
    //    pin 节点必须仍在活动面（保护洞不被遮蔽）。
    await engine.setState(id, { readLease: leaseOf([outside[0]]) })
    const pinnedHead = await engine.archiveForStep(id, session, closedSettings, { resetNotWorth: true })
    assert.equal(pinnedHead.status, 'archived', JSON.stringify(pinnedHead))
    assert.equal(pinnedHead.steps, 2, '只提交 pin 之后的安全段')
    assert.ok((await session.surface.nodes).includes(outside[0].seq), 'pin 节点必须留在活动面')
    assert.equal((await engine.historyOf(id)).total, 1)

    // 3) 清租约后 now 绕闸门 + 阈值：剩下的 1 步安全可用 → short-run-flush。
    await engine.setState(id, { readLease: [] })
    const now = await engine.archiveForStep(id, session, closedSettings, { resetNotWorth: true })
    assert.equal(now.status, 'archived', JSON.stringify(now))
    assert.equal(now.steps, 1, '显式动作可提交不满阈值的整段（§3.3）')
    assert.equal((await engine.historyOf(id)).total, 2)
  }, { steps: 4 })
})

test('显式 compact 也绕节奏门（gate + 阈值）并带确定性摘要', async () => {
  await withCoolingEngine(async ({ engine, session, root, id }) => {
    await openGate(root, id)
    const settings = { retainOperations: 1, coolingBatchSize: 10, coolingGate: 95 }
    const compact = await engine.archiveForStep(id, session, settings, { compact: true })
    assert.equal(compact.status, 'archived', JSON.stringify(compact))
    assert.equal(compact.steps, 3, '显式 compact 提交安全可用的整段')
    assert.match(compact.receiptText, /摘要：/, 'compact 必须带确定性摘要')
  }, { steps: 4 })
})

/** 记录正文极小的步骤：assistant 只有工具调用块（metaOnly），工具结果 2 字。 */
function pushTinyStep(session, index) {
  session.append('step/start', { turn: 1, step: index })
  session.append('assistant/message', {
    message: { role: 'assistant', content: [{ type: 'tool-call', callId: 'c' + index, name: 'run', arguments: '{"code":"1"}' }] },
  })
  session.append('tool/result', { message: { role: 'tool', toolCallId: 'c' + index, content: [{ type: 'text', text: 'ok' }] } })
  session.append('step/end', { turn: 1, step: index })
}

test('显式 now 也不绕正净收益：全 mini 步骤仍不归档（surface 不变、无 voucher）', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-step-batch-not-worth-'))
  const ctx = fakeCtx()
  const engine = attachV3Engine(ctx, { v3Root: root })
  const id = 's-step-batch-not-worth'
  try {
    const session = createFakeSession({ id, contextWindow: 1000000 })
    session.pushContextWindow(1000000)
    session.pushUser('开始')
    for (let index = 1; index <= 12; index += 1) pushTinyStep(session, index)
    await ctx.callPreStep(session)
    await settle(engine)
    await engine.setState(id, { mode: 'cooling' })
    await openGate(root, id)
    const before = await session.surface.nodes
    const manual = await engine.archiveForStep(id, session, { retainOperations: 1, coolingBatchSize: 10, coolingGate: 95 }, { resetNotWorth: true })
    assert.notEqual(manual.status, 'archived', '回执比原文长的步骤不得因显式动作被压：' + JSON.stringify(manual))
    assert.deepEqual(await session.surface.nodes, before, '净收益为负时不得改 surface')
    assert.equal((await engine.historyOf(id)).total, 0, '净收益为负时不得产生 voucher')
  } finally {
    await engine._waitForIdle().catch(() => {})
    engine.dispose()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})

test('按轮归档不受批量阈值影响（阈值只作用于 cooling）', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-step-batch-turn-'))
  const ctx = fakeCtx()
  const engine = attachV3Engine(ctx, { v3Root: root })
  try {
    const session = createFakeSession({ id: 's-step-batch-turn', contextWindow: 100000 })
    session.pushUser('第一问'.repeat(60))
    session.pushAssistant('第一答'.repeat(60))
    session.pushUser('当前问题'.repeat(10))
    await ctx.callPreStep(session)
    await settle(engine)
    const archived = await engine.archiveForStep('s-step-batch-turn', session, { coolingBatchSize: 200 })
    assert.equal(archived.status, 'archived', JSON.stringify(archived))
  } finally {
    await engine._waitForIdle().catch(() => {})
    engine.dispose()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})
