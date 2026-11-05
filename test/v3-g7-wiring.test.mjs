/**
 * G7 集成批接线守卫（0.15.0 上下文与缓存改进 · 集成态）。
 *
 * 本套件只钉**接线**（不是新机制）：把已经收口的 G3 / G5 交付接进入口与装配后，
 * 必须同时成立的三件事：
 *
 * 1. **off 等价仍是硬约束**（§7.1）：默认配置下结果面**不出现** policy 键，
 *    显式传 enabled:false 与完全不传逐字节相同；
 * 2. **候选可达且默认关闭**：同一夹具上开启候选后，策略轨迹 / 状态写回 / 节奏等待
 *    都真的出现在**入口**（不是只在 application 层单测里）；
 * 3. **G3 生命周期真的进账本**：观测行带 lifecycle（paired / attempt / usageArrival），
 *    同 attempt 的重复 chunk 记 duplicate 且不计数；forget 把诊断账本整体清掉。
 *
 * 另外钉一条 G5 审查 P3-3：策略**放行**但整批无正收益段时，结果面仍带策略轨迹
 * （否则 status 无法解释"允许调度却没有候选"）。
 *
 * ## 不适用条件
 * - 不验真实宿主时序/真实 usage（G3 的 wire=no-seam，G8 才碰）；
 * - 不验收益（G5/G6b 的候选默认关闭，收益属 G8）；
 * - 不覆盖 G6b 的装配接线（本批只做口径核对，见证据 G7-实现.md §A4）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { attachV3Engine, textOfDshEvent } from '../src/v3/entry/v3-entry.mjs'
import { createV3Runtime } from '../src/v3/composition/composition.mjs'
import { createArchiveService } from '../src/v3/application/archive.mjs'
import { createFakeSession } from './helpers/fake-session.mjs'
import { seqOfDshEventId } from '../src/v3/adapters/host/dsh-host.mjs'
import { archiveLine, readSchedulePolicyConfig, readSettings, SETTINGS_DEFAULTS } from '../src/index.mjs'
import { readArchiveIntent } from '../src/v3/adapters/storage/archive-intent.mjs'
import { sessionStatePath } from '../src/v3/adapters/storage/session-state.mjs'
import {
  SCHEDULE_POLICY_BOUNDS,
  SCHEDULE_POLICY_DEFAULTS,
  normalizeSchedulePolicyConfig,
} from '../src/v3/contracts/archive-schedule-policy.mjs'

const SESSION_ID = 'session-fake'
const LEDGER = 'cache-observations.jsonl'
/** 门槛都放小：本套件只验"接线通"，不是标定。 */
const POLICY_CONFIG = Object.freeze({
  enabled: true,
  minGrowthMessages: 2,
  minRequestGap: 2,
  maxRequestGap: 40,
  backlogCoalesceUnits: 200,
})

function fakeCtx() {
  const handlers = new Map()
  const warnings = []
  const ctx = {
    warnings,
    on(name, handler) { handlers.set(name, handler); return () => handlers.delete(name) },
    logger: { warn: (m) => warnings.push(m), info() {} },
  }
  // 真实宿主 payload 带 turn/step；本套件必须给，否则 pending 快照与 attempt 游标不成立。
  ctx.callPreStep = async (session, position = {}) => {
    const handler = handlers.get('agent/pre-step')
    if (!handler) throw new Error('未注册 pre-step')
    return await handler({ agent: { session }, signal: undefined, turn: position.turn, step: position.step }, async () => ({ kind: 'enter' }))
  }
  return ctx
}

async function settle(engine) {
  await new Promise((resolve) => setTimeout(resolve, 120))
  await engine._waitForIdle().catch(() => {})
  await new Promise((resolve) => setTimeout(resolve, 40))
}

/** 段身份（seq 是确定值，不需要归一）：用于比两次选择是否选中同一段。 */
const spanOf = (segment) => ({ startSeq: segment.startSeq, endSeq: segment.endSeq, steps: segment.steps })

/** 记录 ID 归一（两次运行的事务/记录 ID 不同，行为必须相同）。 */
const normalizeIds = (value) => JSON.parse(JSON.stringify(value, (key, inner) => (
  typeof inner === 'string' ? inner.replace(/v3r-[0-9a-f]+/g, '<rid>').replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>') : inner
)))

/** 冷却夹具：6 个完整步骤（每步一条大正文 assistant），窗口外候选足够凑一批。 */
function pushSteps(session, count) {
  session.pushContextWindow(1000000)
  session.pushUser('开始')
  for (let step = 1; step <= count; step += 1) {
    session.append('step/start', { turn: 1, step })
    session.pushAssistant(('第 ' + step + ' 步数据 ').repeat(120))
    session.append('step/end', { turn: 1, step })
  }
}

async function withEngine(body) {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-g7-wiring-'))
  const ctx = fakeCtx()
  const engine = attachV3Engine(ctx, { v3Root: root })
  try {
    return await body({ root, ctx, engine })
  } finally {
    await engine._waitForIdle().catch(() => {})
    engine.dispose()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
}

const COOLING_SETTINGS = Object.freeze({ retainOperations: 1, coolingBatchSize: 3, coolingGate: 0 })

/**
 * 冷却闸门的占用率来源是 usage 账本（最近 input+cacheRead / contextWindow）：
 * 没有 usage 行时占用未知 → 闸门失败关闭（这是既有语义，本套件不绕），
 * 因此夹具显式写一条 usage 行把占用抬到闸门之上。
 */
async function writeOccupancy(root, sessionId) {
  const dir = path.join(root, 'sessions', sessionId)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'usage.jsonl'), JSON.stringify({ seq: 1, inputTokens: 300000, totalTokens: 300001 }) + '\n')
}

// ------------------------------------------------- W1 配置通道（P3-5 / 单一真源）

test('G7-W1 调度候选配置通道：缺键回落默认、非法值原样下发（pick 不再把非法值吃掉）', () => {
  // P3-5：readSettings 的 pick() 会把 9999 回落成默认，normalize 就永远看不到非法值。
  const rawDefaults = readSchedulePolicyConfig(undefined)
  assert.deepEqual(rawDefaults, {
    enabled: SCHEDULE_POLICY_DEFAULTS.enabled,
    minGrowthMessages: SCHEDULE_POLICY_DEFAULTS.minGrowthMessages,
    minRequestGap: SCHEDULE_POLICY_DEFAULTS.minRequestGap,
    maxRequestGap: SCHEDULE_POLICY_DEFAULTS.maxRequestGap,
    backlogCoalesceUnits: SCHEDULE_POLICY_DEFAULTS.backlogCoalesceUnits,
  })
  const normalizedDefaults = normalizeSchedulePolicyConfig(rawDefaults)
  assert.equal(normalizedDefaults.ok, true)
  assert.equal(normalizedDefaults.config.enabled, false, '默认必须关闭（候选不得默认上线）')

  const rawInvalid = readSchedulePolicyConfig({ scheduleMinGrowthMessages: 9999 })
  const normalizedInvalid = normalizeSchedulePolicyConfig(rawInvalid)
  assert.equal(normalizedInvalid.ok, false, '非法值必须由合同判死，而不是被入口静默回落')
  assert.match(normalizedInvalid.reason, /minGrowthMessages/)

  // readSettings 仍是「生效值」语义：非法值回落默认，且与 SETTINGS_DEFAULTS 逐键一致。
  assert.deepEqual(readSettings(undefined), SETTINGS_DEFAULTS)
  assert.equal(readSettings({ scheduleMinGrowthMessages: 9999 }).scheduleMinGrowthMessages, SETTINGS_DEFAULTS.scheduleMinGrowthMessages)
  // 边界只有一处真源：合同的 BOUNDS 就是 schema 用的那一份（此处断言形态，字段集由 surface-contract 钉）。
  assert.deepEqual(Object.keys(SCHEDULE_POLICY_BOUNDS).sort(), ['backlogCoalesceUnits', 'maxRequestGap', 'minGrowthMessages', 'minRequestGap'])
})

// ------------------------------------------------- W2 off 等价（默认配置零激活）

test('G7-W2 默认配置零激活：不传 schedulePolicyConfig 与传 enabled:false 的结果逐字节相同且都无 policy', async () => {
  const runOf = async (extra) => await withEngine(async ({ root, engine, ctx }) => {
    const session = createFakeSession({ cwd: 'C:\\ws', contextWindow: 1000000 })
    pushSteps(session, 6)
    await ctx.callPreStep(session, { turn: 1, step: 7 })
    await settle(engine)
    await writeOccupancy(root, SESSION_ID)
    await engine.setState(SESSION_ID, { mode: 'cooling' })
    const result = await engine.archiveForStep(SESSION_ID, session, { ...COOLING_SETTINGS, ...extra })
    return result
  })
  const absent = await runOf({})
  const disabled = await runOf({ schedulePolicyConfig: { ...SCHEDULE_POLICY_DEFAULTS } })
  assert.equal('policy' in absent, false, '默认配置不得在结果面出现 policy 轨迹')
  assert.equal('policy' in disabled, false, '显式 enabled:false 同样不得出现 policy')
  assert.equal(absent.status, 'archived', JSON.stringify(absent))
  assert.deepEqual(normalizeIds(absent), normalizeIds(disabled), 'off 路径必须逐字节等价（含字段集合与顺序）')
})

// ------------------------------------------------- W3 候选可达（接线真的通了）

test('G7-W3 候选开启后入口可达：轨迹带出、提交成功写回策略状态、请求序号真的推进', async () => {
  await withEngine(async ({ root, engine, ctx }) => {
    const session = createFakeSession({ cwd: 'C:\\ws', contextWindow: 1000000 })
    pushSteps(session, 6)
    // 第一次 pre-step 只建库（entry 未就绪，请求序号不推进）；第二次才是真实请求。
    await ctx.callPreStep(session, { turn: 1, step: 7 })
    await settle(engine)
    await ctx.callPreStep(session, { turn: 1, step: 8 })
    await settle(engine)
    await writeOccupancy(root, SESSION_ID)
    await engine.setState(SESSION_ID, { mode: 'cooling' })
    const settings = { ...COOLING_SETTINGS, schedulePolicyConfig: { ...POLICY_CONFIG } }

    // ① 预览 lane 也走策略闸门：首次没有基线 → policy-baseline（allow），带触发理由。
    const preview = await engine.dryRunArchive(SESSION_ID, session, settings)
    assert.equal(preview.status, 'planned', JSON.stringify(preview))
    assert.ok(preview.policy, '预览必须带策略轨迹（与执行同一份输入）')
    assert.equal(preview.policy.decision, 'allow')
    assert.equal(preview.policy.reason, 'policy-baseline')
    assert.equal(preview.policy.scheduled, true)
    assert.equal(preview.policy.attemptOrdinal >= 1, true, '请求序号来自真实 pre-step，不是从 0 起的伪序号')

    // ② 执行：提交成功后 application 产出 nextState，入口写回（partial 同样写回，见实现注释）。
    const archived = await engine.archiveForStep(SESSION_ID, session, settings)
    assert.equal(archived.status, 'archived', JSON.stringify(archived))
    assert.ok(archived.policy, '执行结果必须带策略轨迹')
    assert.ok(archived.policy.nextState, '提交成功后必须产出 nextState（否则节奏门永远没有基线）')
    assert.equal(archived.policy.nextState.attemptOrdinal, preview.policy.attemptOrdinal, '基线与本次请求同序号')
    assert.equal(archived.policy.nextState.lastCommit.attemptOrdinal, preview.policy.attemptOrdinal)

    // ③ 下一次真实请求：请求序号 +1、基线来自上一次提交（requestsSinceCommit=1）。
    await ctx.callPreStep(session, { turn: 1, step: 9 })
    await settle(engine)
    const next = await engine.archiveForStep(SESSION_ID, session, settings)
    assert.ok(next.policy, '后续请求仍须带轨迹（否则等于候选只在第一步生效）')
    assert.equal(next.policy.attemptOrdinal, preview.policy.attemptOrdinal + 1, '请求序号必须每次真实请求 +1')
    assert.equal(next.policy.requestsSinceCommit, 1, '基线来自提交成功后的写回（不是每次重新基线）')
    // 本夹具没有观测行 → policy 端口没有可信 messages.count → 回退原策略（allow），不阻塞归档。
    assert.equal(next.policy.reason, 'policy-input-unavailable', JSON.stringify(next.policy))
    assert.equal(next.policy.decision, 'allow')

    // ④ 回退是"照旧归档"，不是"因为观测缺失就不压"：凭证数只增不减。
    assert.equal((await engine.historyOf(SESSION_ID)).total >= 1, true)
  })
})

/**
 * G7 审查 P3-1：入口层的 `policy-deferred` 必须**只等待**。
 *
 * W3 走到 `policy-baseline` / `policy-input-unavailable` 就停了——这两条都**放行**，
 * 所以入口若把 defer 错接成「not-worth 并推进判负游标」，既有用例一条都不会红
 * （defer 只在 application 层与纯策略层有覆盖，入口层没有）。本条夹具补上触发条件：
 * 真的落一条 usage 观测行（`components.messages.count` 才有值）、真的提交过一次基线
 * （`lastCommit` 存在），然后只推进一次请求序号——增长量 0、间隔 1，双门都不满足。
 *
 * 「判负游标没被推进」的观察方式：游标是入口的进程内字段
 * （`entry.notWorthThroughSeq`），attachV3Engine 的门面不导出它；但它是**选择器的输入**，
 * 所以可以用同一游标的只读重规划钉住——defer 之后关掉候选再 dry-run 一次，选中的必须
 * 仍是同一段（游标被推进 → 只剩 retention-window/no-candidate，或换成更后面的一段）。
 * 最后再用 manual 通道真的提交同一段，证明候选从头到尾没被吃掉。
 */
test('G7-W3b 入口层 policy-deferred：只等待——不改活动面、不写凭证、不推进判负游标', async () => {
  await withEngine(async ({ root, engine, ctx }) => {
    const session = createFakeSession({ cwd: 'C:\\ws', contextWindow: 1000000 })
    pushSteps(session, 6)
    // 第一次 pre-step 只建库；第二次才是真实请求（请求序号 1）并留下本步的投影快照。
    await ctx.callPreStep(session, { turn: 1, step: 7 })
    await settle(engine)
    await ctx.callPreStep(session, { turn: 1, step: 7 })
    await settle(engine)
    // 第 7 步里带一条真实 usage（assistant/message.data.usage）：下次 pre-step 摄入时
    // 与上一步快照配对，落一行带 components.messages.count 的观测行（W4 同一形状）。
    session.append('step/start', { turn: 1, step: 7 })
    session.append('assistant/message', {
      turn: 1,
      step: 7,
      usage: { inputTokens: 10, outputTokens: 2 },
      message: { role: 'assistant', content: [{ type: 'text', text: '带 usage 的第 7 步数据 ' }] },
      source: { kind: 'assistant' },
    })
    session.append('step/end', { turn: 1, step: 7 })
    await ctx.callPreStep(session, { turn: 1, step: 8 })
    await settle(engine)
    // 冷却闸门要看到占用（usage 账本），否则失败关闭、进不到策略闸门。
    await writeOccupancy(root, SESSION_ID)
    await engine.setState(SESSION_ID, { mode: 'cooling' })
    const settings = { ...COOLING_SETTINGS, schedulePolicyConfig: { ...POLICY_CONFIG } }

    // ① 先真实提交一次，建立基线：policy-baseline 放行，lastCommit 记住观测到的消息数。
    const baseline = await engine.archiveForStep(SESSION_ID, session, settings)
    assert.equal(baseline.status, 'archived', JSON.stringify(baseline))
    assert.equal(baseline.policy.reason, 'policy-baseline')
    assert.equal(baseline.policy.nextState.lastCommit.messagesCount, 7, '基线消息数必须来自 usage 观测行的投影快照')
    const vouchersAfterBaseline = (await engine.historyOf(SESSION_ID)).total
    assert.equal(vouchersAfterBaseline, 1, '夹具前提：基线提交恰好一段')

    // ② 只推进一次请求序号（间隔 1 < minRequestGap 2）；消息数没有增长（0 < minGrowthMessages 2）。
    await ctx.callPreStep(session, { turn: 1, step: 9 })
    await settle(engine)
    const surfaceBefore = [...session.surface.nodes]
    const logBefore = session.log.length
    // ②b（G8-T1 增强批 P3-1）：持久化面夹具——defer 前后要比的是同一份 state.json 的原始字节。
    const statePath = sessionStatePath(root, SESSION_ID)
    const stateBytesBefore = await readFile(statePath)

    // ③ 入口必须给出 policy-deferred，而不是 not-worth / no-candidate / 已归档。
    const deferred = await engine.archiveForStep(SESSION_ID, session, settings)
    assert.equal(deferred.status, 'policy-deferred', JSON.stringify(deferred))
    assert.equal(deferred.reason, 'rhythm-deferred')
    assert.equal(deferred.policy.decision, 'defer')
    assert.equal(deferred.policy.scheduled, false, 'defer 不得把候选说成已调度')
    assert.equal(deferred.policy.attemptOrdinal, 3, '请求序号来自真实 pre-step')
    assert.equal(deferred.policy.requestsSinceCommit, 1)
    assert.equal(deferred.policy.growthMessages, 0)
    assert.deepEqual(deferred.policy.needed, { growthMessages: 2, requests: 1 })
    assert.equal(deferred.policy.safeCandidates, 1, '安全候选已经选出来了（闸门在安全闭包之后）')
    assert.equal(deferred.eligible, 3, '整批候选三步都在')
    assert.equal('notWorthThroughSeq' in deferred, false, 'defer 不得伪装成判负（没有游标事实）')
    assert.equal('span' in deferred, false, 'defer 不产出回执段')
    assert.match(archiveLine(deferred), /按缓存友好的节奏等待/, '命令面必须把等待说成等待：' + archiveLine(deferred))
    assert.equal(archiveLine(deferred).includes('已归档'), false, '等待不得说成已归档')

    // ④ 什么都不动：活动面逐节点不变、会话日志不追加、凭证数不变、intent 槽不占。
    assert.deepEqual([...session.surface.nodes], surfaceBefore, 'defer 不得改活动面（错接成归档会换掉节点）')
    assert.equal(session.log.length, logBefore, 'defer 不得向会话日志追加任何东西')
    assert.equal((await engine.historyOf(SESSION_ID)).total, vouchersAfterBaseline, 'defer 不得写凭证')
    assert.equal(await readArchiveIntent(root, SESSION_ID), null, 'defer 不得占 intent 槽')

    // ④b（G8-T1 增强批 P3-1）：defer 连**持久化面**都不能碰——state.json 原始字节必须逐字节相同
    // （不在断言里解析 JSON：任何改写都算「动了」，包括把 lastArchiveAt 刷成新时间）。
    assert.deepEqual(await readFile(statePath), stateBytesBefore, 'defer 不得改写 sessions/<id>/state.json（持久化面逐字节相同）')

    // ④c（G8-T1 增强批 P3-2 + P3-1 尾部）：defer 之后的**下一次 auto 请求**必须还是同一个等待。
    // - 复跑不消费请求、不重置/伪造基线：entry.policyState 若被 defer 当「一次提交成功」写过，
    //   这里会变成 requestsSinceCommit=0（或 policy-baseline/allow），不是 1/defer；
    // - 复跑同样不得写 state.json。
    const rerun = await engine.archiveForStep(SESSION_ID, session, settings)
    assert.equal(rerun.status, 'policy-deferred', JSON.stringify(rerun))
    assert.equal(rerun.policy.reason, 'rhythm-deferred')
    assert.equal(rerun.policy.decision, 'defer')
    assert.equal(rerun.policy.scheduled, false)
    assert.equal(rerun.policy.attemptOrdinal, 3, 'auto 复跑不是一次新请求：请求序号不得被 defer 消费/重置')
    assert.equal(rerun.policy.requestsSinceCommit, 1, '复跑不得把上一次 defer 当成一次提交（间隔不累计）')
    assert.equal(rerun.policy.growthMessages, 0)
    assert.deepEqual(rerun.policy.needed, deferred.policy.needed)
    assert.deepEqual(rerun.segments.map(spanOf), deferred.segments.map(spanOf), '复跑仍从同一段队头重规划')
    assert.deepEqual(await readFile(statePath), stateBytesBefore, 'auto 复跑同样不得写 state.json')

    // ④d（G8-T1 增强批 P3-3）：诊断面必须把 defer 说成「等」，不得说成「跳过 N 段不划算」
    // （status/now 的第二次调用走这条只读路径）。
    const diagnostic = await engine.dryRunArchive(SESSION_ID, session, settings)
    assert.equal(diagnostic.status, 'policy-deferred', JSON.stringify(diagnostic))
    assert.equal(diagnostic.policy.reason, 'rhythm-deferred')
    assert.equal('skipped' in diagnostic, false, '等待不得带判负汇总（skipped）')
    assert.equal('skippedSegments' in diagnostic, false, '等待不得带 skippedSegments')
    assert.equal(archiveLine(diagnostic).includes('不划算'), false, '等待不得显示成「跳过 N 段不划算」：' + archiveLine(diagnostic))
    assert.deepEqual(await readFile(statePath), stateBytesBefore, '只读诊断不得写 state.json')

    // ⑤ 判负游标没被推进：同一游标的只读重规划仍选中同一段候选。
    const probe = await engine.dryRunArchive(SESSION_ID, session, { ...COOLING_SETTINGS, schedulePolicyConfig: { ...SCHEDULE_POLICY_DEFAULTS } })
    assert.equal('policy' in probe, false, '关掉候选之后结果面不得带 policy')
    assert.equal(probe.status, 'planned', '判负游标被推进时这里只剩 retention-window/no-candidate：' + JSON.stringify(probe))
    assert.deepEqual(probe.segments.map(spanOf), deferred.segments.map(spanOf), 'defer 之后必须仍从同一段队头重规划')

    // ⑥ 候选真的还在：manual 通道（绕节奏门、不绕安全）提交的就是被 defer 的那一段。
    const manual = await engine.archiveForStep(SESSION_ID, session, settings, { compact: true })
    assert.equal(manual.status, 'archived', JSON.stringify(manual))
    assert.equal(manual.policy.reason, 'manual-bypass')
    assert.equal(manual.startSeq, deferred.segments[0].startSeq, 'defer 之后同一候选仍可提交（游标没被吃掉）')
    assert.equal((await engine.historyOf(SESSION_ID)).total, vouchersAfterBaseline + 1)
  })
})

// ------------------------------------------------- W4 G3 生命周期进账本

test('G7-W4 G3 接线：观测行带 lifecycle（paired/attempt/arrival），重复 chunk 记 duplicate 不计数，forget 清空诊断账本', async () => {
  await withEngine(async ({ root, engine, ctx }) => {
    const session = createFakeSession({ cwd: 'C:\\ws', contextWindow: 100000 })
    session.pushUser('问一句')
    session.pushAssistant('答一句')

    // 第一次 pre-step 只建库（entry 尚未就绪 → 该步没有快照/游标）。
    await ctx.callPreStep(session, { turn: 1, step: 1 })
    await settle(engine)
    // 建库后的第一次真实请求（turn 1 / step 1）→ 该 (turn,step) 的 attempt=1 进游标 + 快照。
    await ctx.callPreStep(session, { turn: 1, step: 1 })
    await settle(engine)

    // 同一步到达的 usage（真实形状：assistant/message.data.usage）
    const pushWithUsage = (text) => session.append('assistant/message', {
      turn: 1,
      step: 1,
      usage: { inputTokens: 10, outputTokens: 2 },
      message: { role: 'assistant', content: [{ type: 'text', text }] },
      source: { kind: 'assistant' },
    })
    const first = pushWithUsage('带 usage 的第一条')
    await ctx.callPreStep(session, { turn: 1, step: 2 })
    await settle(engine)

    const ledgerPath = path.join(root, 'sessions', SESSION_ID, LEDGER)
    const rowsOf = async () => (await readFile(ledgerPath, 'utf8')).split('\n').filter((line) => line.trim().length > 0).map((line) => JSON.parse(line))
    let rows = await rowsOf()
    const row = rows.find((item) => item.seq === first.seq)
    assert.ok(row, '带 usage 的 assistant 事件必须落观测行：' + JSON.stringify(rows.map((item) => item.seq)))
    assert.equal(row.lifecycle.contractVersion, 1)
    assert.equal(row.lifecycle.correlation.status, 'paired', 'session+turn/step+attempt 都在 → paired')
    assert.equal(row.lifecycle.attempt.index, 1, 'attempt = 该 turn:step 的第 1 次真实请求')
    assert.equal(row.lifecycle.usageArrival.state, 'first')
    assert.equal(row.lifecycle.usageArrival.counted, true)
    assert.match(row.lifecycle.session.id, /^sess-local-[0-9a-f]{16}$/, '只落会话摘要，不落原始会话键')

    // 同一 attempt 的第二份 usage（流式重复 chunk）：duplicate 且不计数（one-sample-per-attempt）。
    const second = pushWithUsage('带 usage 的第二条')
    await ctx.callPreStep(session, { turn: 1, step: 3 })
    await settle(engine)
    rows = await rowsOf()
    const dupRow = rows.find((item) => item.seq === second.seq)
    assert.ok(dupRow, '第二条也必须落行（否则"重复"不可见）')
    assert.equal(dupRow.lifecycle.attempt.index, 1, '没有新请求 → 仍属同一 attempt')
    assert.equal(dupRow.lifecycle.usageArrival.state, 'duplicate')
    assert.equal(dupRow.lifecycle.usageArrival.counted, false)

    // forget：诊断账本整体清掉（keepRows:0），且不因清理失败而让 forget 失败。
    const working = await engine.workingSet(SESSION_ID)
    const recordId = working.rows[0]?.recordId
    assert.equal(typeof recordId, 'string', '夹具必须有可遗忘的记录')
    const forgotten = await engine.forgetRecords(SESSION_ID, [recordId])
    assert.equal(forgotten.undone, false)
    let gone = false
    try { await access(ledgerPath) } catch { gone = true }
    assert.equal(gone, true, 'forget 必须清空本会话诊断账本（keepRows:0）')
  })
})

// ------------------------------------------------- W5 P3-3 放行但无正收益段仍带轨迹

test('G7-W5 G5 审查 P3-3：策略放行但整批无正收益段时，结果面仍带策略轨迹', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-g7-p33-'))
  const session = createFakeSession({ cwd: 'C:\\ws', contextWindow: 1000000, id: 's-g7-p33' })
  session.pushContextWindow(1000000)
  session.pushUser('开始')
  // mini 步：正文只有工具调用参数（metaOnly）→ 回执比原文长 → 全批判负
  for (let index = 1; index <= 12; index += 1) {
    session.append('step/start', { turn: 1, step: index })
    session.append('assistant/message', {
      message: { role: 'assistant', content: [{ type: 'tool-call', callId: 'c' + index, name: 'run', arguments: '{"code":"1"}' }] },
    })
    session.append('tool/result', { message: { role: 'tool', toolCallId: 'c' + index, content: [{ type: 'text', text: 'ok' }] } })
    session.append('step/end', { turn: 1, step: index })
  }
  const runtime = await createV3Runtime({ v3Root: root, dshSession: session, sessionKey: 's-g7-p33' })
  try {
    await runtime.handleDshEventBatch(session.log.map((event) => ({ event, text: textOfDshEvent(event), meta: {} })))
    const seqToRecordId = new Map()
    for (const recordId of await runtime.store.listRecordIds()) {
      const provenance = await runtime.store.readProvenance(recordId)
      const seq = seqOfDshEventId(provenance?.sourceEventId)
      if (seq !== null) seqToRecordId.set(seq, recordId)
    }
    const archive = createArchiveService({ random: { uuid: () => randomUUID() }, store: runtime.store, host: runtime.host, clock: { now: () => 1 } })
    const policy = {
      config: { ...POLICY_CONFIG },
      state: { contractVersion: 1, attemptOrdinal: 9, lastCommit: { attemptOrdinal: 5, messagesCount: 100, configFingerprint: normalizeSchedulePolicyConfig(POLICY_CONFIG).fingerprint } },
      input: {
        contractVersion: 1,
        session: { id: 'sess-local-' + 'a'.repeat(16), source: 'local-diagnostic' },
        window: { fromSeq: 1, toSeq: 2, rows: 2, legacyRows: 0, skippedRows: 0 },
        projection: { epoch: 1, lastPhase: 'append', lastMessageChange: 'appended', phaseCounts: { initial: 0, steady: 0, append: 2, 'epoch-start': 0 } },
        components: { messages: { digest: 'a'.repeat(16), count: 110, generation: 1 }, system: { coverage: 'unobservable' }, tools: { coverage: 'unobservable' } },
        usage: {
          counted: 1, duplicates: 0, late: 0, unknownArrival: 0, unsampledLegacy: 0,
          totals: { inputTokens: 10, outputTokens: 2, totalTokens: null, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null },
          availability: { inputTokens: 'present', outputTokens: 'present', totalTokens: 'missing', cacheReadTokens: 'missing', cacheWriteTokens: 'missing', reasoningTokens: 'missing' },
          cacheReadRatio: null,
          additivity: { provider: 'deepseek', cacheFieldsAddable: true, reasoningExtraTokens: null, verified: 'source-read' },
        },
        layers: null,
      },
    }
    const args = {
      sessionId: 's-g7-p33',
      events: session.log,
      surfaceNodes: await runtime.host.surfaceNodes(),
      seqToRecordId,
      retainSteps: 1,
      batchSteps: 10,
      summary: true,
      lane: 'auto',
      policy,
    }
    const planned = await archive.planSteps(args)
    // mini 步的回执 ≥ 原文 → 整批判负（这正是 P3-3 指的那条路径）。
    assert.equal(planned.status, 'not-worth', JSON.stringify(planned).slice(0, 400))
    assert.ok(planned.policy, 'P3-3：放行但无正收益段时也必须带出策略轨迹（off 路径仍不带）')
    assert.equal(planned.policy.decision, 'allow')
    assert.equal(planned.policy.scheduled, true)
    const line = archiveLine(planned)
    assert.match(line, /调度候选：/, '命令面必须能解释"允许调度但没有正收益段"：' + line)

    // off 路径对照：不传 policy 时同一夹具的结果面**没有** policy 键（字节等价不受影响）。
    const offPlanned = await archive.planSteps({ ...args, policy: null })
    assert.equal(planned.status, offPlanned.status)
    assert.equal('policy' in offPlanned, false)
  } finally {
    runtime.close()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})
