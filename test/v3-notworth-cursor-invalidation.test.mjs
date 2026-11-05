/**
 * P3-04 判负游标必须**有失效条件**（0.15.1 独立排查报告 §3.3）。
 *
 * ## 缺陷
 * `entry.notWorthThroughSeq` / `…Turn` / `…TurnDsh` 是**进程内单调只进不退**的整数：
 * 一个段只要被判负（净收益为负）过一次，此后永远排在扫描起点之前——即便判负的理由
 * 已经消失。判负不是永久属性，它随输入变化，且变化有两个方向：
 * - **回执侧**：`retainOperations` / 批阈值被调小 → 同一段被切成更小的段、回执变短，
 *   而源字数不变 → 净收益可以从负转正。这类输入**不在记录正文里**；
 * - **源侧**：同一段记录被 restore / 重摄 / 补内容 → 源正文变长 → 净收益转正。
 *   这类变化没有廉价指纹，只能靠时间兜底。
 * 旧实现让「一次判负」变成「永久不评估」，用户只能重启 DSH（进程内游标随之归零）。
 *
 * ## 判据来源
 * `src/v3/entry/v3-entry.mjs` 的 `notWorthCursorOf / notWorthCursorLive /
 * notWorthCursorStart / advanceNotWorthCursor`（两条失效条件：设置指纹 + TTL）。
 * 判负本身仍由 `application/archive.mjs:makePlan` 的唯一判据
 * `receiptText.length >= sourceChars` 决定——本修复不动那个判据。
 *
 * ## 断言组
 * A. 设置指纹变了 → 游标作废并**真的重新评估队头**（归档起点回到被判负过的那一段；
 *    旧实现从游标之后起算 → 红）；
 * B. 设置没变 → 游标仍然有效，**不重扫**（不得退化成每轮都重新评估）；
 * C. TTL 到期 → 游标作废（执行路径给出可见的失效告警）；
 * D. 失效不改安全边界：判负段仍留在活动面，不会被为了「重评」而遮蔽。
 *
 * ## 不适用条件与已知边界
 * - TTL 只覆盖「源侧」变化：源正文变长但设置与时间都没变时，最多等 30 分钟才重评；
 *   这是**有界**而非即时，刻意选择——即时判据要么读记录、要么每轮重扫 N 段规划。
 * - legacy 形状（裸整数，写于本版之前）按「永不过期」处理：不改变既有会话行为。
 * - 失效方向**失败关闭**（重新评估）：最坏结果是多花一次规划，绝不会跳过可归档段。
 *
 * ## 定点变异自证（`node --test test/v3-notworth-cursor-invalidation.test.mjs`）
 * - 把 `notWorthCursorLive` 的设置指纹比较删掉 → A 组红（仍从旧游标之后起算）；
 * - 把 TTL 比较删掉 → C 组红（不告警、不重评）；
 * - 恢复后全绿。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { attachV3Engine } from '../src/v3/entry/v3-entry.mjs'
import { createFakeSession } from './helpers/fake-session.mjs'

const TTL_MS = 30 * 60 * 1000
const STEP_CHARS = 50

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

/**
 * 造 10 个「小步骤」（每步 50 字）。判负条件 `receiptText.length >= sourceChars`：
 * 单个 50 字步骤 < 回执（约 200 字）→ 判负；10 个叠在一个段里 500 字 → 划算。
 * 于是「保留几步」直接决定同一段是划算还是判负——正是回执侧输入变化的形态。
 */
function pushSteps(session, count) {
  const seqs = []
  for (let index = 1; index <= count; index += 1) {
    session.append('step/start', { turn: 1, step: index })
    seqs.push(session.pushAssistant(('步' + index + ' ').padEnd(STEP_CHARS, '·')).seq)
    session.append('step/end', { turn: 1, step: index })
  }
  return seqs
}

async function withSession(body) {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-notworth-cursor-'))
  const ctx = fakeCtx()
  let offset = 0
  const engine = attachV3Engine(ctx, { v3Root: root, clock: { now: () => Date.now() + offset } })
  const id = 's-notworth-cursor'
  try {
    const session = createFakeSession({ id })
    session.pushContextWindow(1000000)
    session.pushUser('开始')
    const seqs = pushSteps(session, 11)
    await ctx.callPreStep(session)
    await settle(engine)
    await engine.setState(id, { mode: 'cooling' })
    const usageDir = path.join(root, 'sessions', id)
    await mkdir(usageDir, { recursive: true })
    await writeFile(path.join(usageDir, 'usage.jsonl'), JSON.stringify({ seq: 1, inputTokens: 300000, totalTokens: 300001 }) + '\n')
    const advanceClock = (ms) => { offset += ms }
    return await body({ engine, session, id, seqs, ctx, advanceClock })
  } finally {
    await engine._waitForIdle().catch(() => {})
    engine.dispose()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * 首轮（设置 X = 保留 10 步 / 批阈值 1）：只有第 1 步进入候选，单步 50 字 < 回执 → 判负。
 * 游标因此记在第 1 步末尾，指纹 = 设置 X。
 */
const SETTINGS_JUDGE = { retainOperations: 10, coolingBatchSize: 1 }
/** 次轮（设置 Y = 保留 1 步 / 批阈值 10）：10 步进同一批，500 字 >> 回执 → 划算。 */
const SETTINGS_WORTH = { retainOperations: 1, coolingBatchSize: 10 }

async function judgeHead(engine, session, id, seqs) {
  const first = await engine.archiveForStep(id, session, SETTINGS_JUDGE)
  assert.equal(first.status, 'not-worth', '单步 50 字 vs 约 200 字回执必须判负：' + JSON.stringify(first))
  const cursor = engine._notWorthCursorOf(id, 'notWorthThroughSeq')
  assert.equal(cursor.cursor, seqs[0], '游标必须记在判负段末尾：' + JSON.stringify(cursor))
  assert.ok(typeof cursor.settingsKey === 'string' && cursor.settingsKey.length > 0, '游标必须带设置指纹：' + JSON.stringify(cursor))
  return cursor
}

test('P3-04-A 设置指纹变了 → 游标作废，队头被重新评估（旧实现跳过它 → 红）', async () => {
  await withSession(async ({ engine, session, id, seqs }) => {
    const judged = await judgeHead(engine, session, id, seqs)
    // 保留 1 步：那 10 个小步骤现在整段进候选 → 500 字 >> 回执，划算。
    // 旧实现从游标（第 1 步末尾）之后起算，第 1 步永远进不了段 → 归档起点在 seqs[1] 之后。
    const second = await engine.archiveForStep(id, session, SETTINGS_WORTH)
    assert.equal(second.status, 'archived', '设置变了以后同一段必须变成可归档：' + JSON.stringify(second))
    assert.ok(second.startSeq <= seqs[0], '必须把被判负过的队头重新纳入候选（得到 startSeq=' + second.startSeq + '，队头 ' + seqs[0] + '）')
    const after = engine._notWorthCursorOf(id, 'notWorthThroughSeq')
    assert.notEqual(after?.settingsKey, judged.settingsKey, '重新评估后游标指纹必须换成新参数')
  })
})

test('P3-04-B 设置没变 → 游标仍然有效，不重扫队头', async () => {
  await withSession(async ({ engine, session, id, seqs, ctx }) => {
    const judged = await judgeHead(engine, session, id, seqs)
    const warningsBefore = ctx.warnings.length
    const again = await engine.archiveForStep(id, session, SETTINGS_JUDGE)
    assert.equal(again.status, 'not-worth', JSON.stringify(again))
    const after = engine._notWorthCursorOf(id, 'notWorthThroughSeq')
    assert.deepEqual(after, judged, '同参数下不得无谓作废游标：' + JSON.stringify(after))
    assert.equal(ctx.warnings.length, warningsBefore, '不得发出「游标失效」告警：' + ctx.warnings.join(' | '))
  })
})

test('P3-04-C TTL 到期 → 游标作废并留下可见告警', async () => {
  await withSession(async ({ engine, session, id, seqs, ctx, advanceClock }) => {
    await judgeHead(engine, session, id, seqs)
    advanceClock(TTL_MS + 1000)
    const again = await engine.archiveForStep(id, session, SETTINGS_JUDGE)
    assert.equal(again.status, 'not-worth', '源仍是 50 字，重评结论必须如实：' + JSON.stringify(again))
    assert.ok(ctx.warnings.some((line) => line.includes('判负游标失效')), '过期必须留下可见告警（不得静默重评）：' + ctx.warnings.join(' | '))
  })
})

test('P3-04-D 失效不改安全边界：判负段仍在活动面', async () => {
  await withSession(async ({ engine, session, id, seqs, advanceClock }) => {
    await judgeHead(engine, session, id, seqs)
    advanceClock(TTL_MS + 1000)
    await engine.archiveForStep(id, session, SETTINGS_JUDGE)
    const nodes = await session.surface.nodes
    assert.ok(nodes.includes(seqs[0]), '被判负的段不得被遮蔽（seq ' + seqs[0] + '）')
  })
})
