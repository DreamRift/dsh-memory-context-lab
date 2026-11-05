/**
 * P3 按步批量归档：**同一批多个安全 run 逐段提交**（0.15.0 候选，未升号）。
 *
 * 缺陷（beta 批次候选）：达到阈值后只提交**第一段**安全 run；保护洞之后的 run
 * 要等下一次调用，而剩余候选可能又回到 < 阈值 → 长期「攒不够」等待。
 * 本套件钉住修复后的合同：
 * 1. 一批候选（最旧 T 个）按 pin/插件/缺记录切成多个 run，逐段各自 intent/voucher；
 * 2. E<T 时（含 pin）不提前短批，surface/voucher 都不变；
 * 3. 跨步工具闭包在批尾只向后扩展（closure-extension），不拆调用；声明/结果被
 *    保护洞隔开时失败关闭，两侧都留在活动面；
 * 4. 段间部分失败如实会计（已提交/失败段/未提交），失败段保留 intent 供对账；
 *    下一次（显式 now 绕节奏门）继续提交剩余段，不重复、不回滚已提交段；
 * 5. 预览/自动/手动共用同一 planner（同一段边界），manual 只绕节奏门，不绕安全、
 *    闭包与 H=200 上限。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { attachV3Engine } from '../src/v3/entry/v3-entry.mjs'
import { archiveLine } from '../src/index.mjs'
import { archiveIntentPath } from '../src/v3/adapters/storage/archive-intent.mjs'
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

function pushBigStep(session, index, turn = 1) {
  session.append('step/start', { turn, step: index })
  session.pushAssistant(('第 ' + index + ' 步数据 ').repeat(120))
  session.append('step/end', { turn, step: index })
}

async function openGate(root, id) {
  const dir = path.join(root, 'sessions', id)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'usage.jsonl'), JSON.stringify({ seq: 1, inputTokens: 300000, totalTokens: 300001 }) + '\n')
}

/**
 * 建会话 → （可选）自定义步骤 → 首次 pre-step 摄入 → 切 cooling → 打开闸门 →
 * （可选）给指定记录加读租约（pinnedSeqs 来源）。body 拿到 ctx/session/engine/root/id。
 */
async function withSession(build, body, { id = 's-multirun', contextWindow = 1000000 } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-multirun-'))
  const ctx = fakeCtx()
  const engine = attachV3Engine(ctx, { v3Root: root })
  try {
    const session = createFakeSession({ id, contextWindow })
    session.pushContextWindow(contextWindow)
    session.pushUser('开始')
    build(session)
    await ctx.callPreStep(session)
    await settle(engine)
    await engine.setState(id, { mode: 'cooling' })
    await openGate(root, id)
    const pinRecord = async (seq) => {
      const rows = (await engine.workingSet(id)).rows
      const row = rows.find((item) => item.seq === seq)
      if (row === undefined) throw new Error('pin 目标记录不存在：seq ' + seq + '，现有 ' + JSON.stringify(rows.map((item) => item.seq)))
      await engine.setState(id, { readLease: [{ recordId: row.recordId, expiresAt: Date.now() + 5 * 60 * 1000 }] })
    }
    return await body({ ctx, engine, session, root, id, pinRecord })
  } finally {
    await engine._waitForIdle().catch(() => {})
    engine.dispose()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
}

const bigSteps = (session, from, to) => { for (let index = from; index <= to; index += 1) pushBigStep(session, index) }
/** 步骤 i 的 assistant 记录 seq：contextWindow(0) + user(1) 之后，一步 3 个 seq（start/assistant/end）。 */
const assistantSeqOfStep = (i) => i * 3

test('历史批次多 run：pin 把一批切成两段，逐段 intent/voucher 提交且 pin 留在活动面', async () => {
  await withSession((session) => bigSteps(session, 1, 13), async ({ ctx, engine, session, id, pinRecord }) => {
    await pinRecord(assistantSeqOfStep(4))
    const settings = { retainOperations: 1, coolingBatchSize: 10 }
    const preview = await engine.dryRunArchive(id, session, settings)
    assert.equal(preview.status, 'planned', JSON.stringify(preview))
    assert.equal(preview.segments.length, 2, '预览必须列出同批两段')
    assert.deepEqual(preview.segments.map((segment) => segment.steps), [3, 6])
    assert.equal(preview.blocked, null, '两段都安全时不应有阻塞原因')

    const archived = await engine.archiveForStep(id, session, settings)
    assert.equal(archived.status, 'archived', JSON.stringify(archived))
    assert.equal(archived.committedCount, 2, '两段各自提交')
    assert.equal(archived.steps, 9)
    assert.equal(archived.receiptSeqs.length, 2)
    assert.equal(new Set(archived.receiptSeqs).size, 2, '两张回执必须各有自己的 seq')
    assert.deepEqual([archived.startSeq, archived.endSeq], [preview.segments[0].startSeq, preview.segments[1].endSeq],
      '预览与执行同一批边界')
    assert.equal((await engine.historyOf(id)).total, 2, '逐段各记一张 voucher')

    const nodes = await session.surface.nodes
    assert.ok(nodes.includes(assistantSeqOfStep(4)), 'pin 节点必须留在活动面')
    assert.ok(!nodes.includes(assistantSeqOfStep(1)), 'run1 已被遮蔽')
    assert.ok(!nodes.includes(assistantSeqOfStep(5)), 'run2 已被遮蔽')
    assert.ok(nodes.includes(assistantSeqOfStep(11)), '窗口外候选 step11–12 留给后续批次')
    assert.ok(nodes.includes(assistantSeqOfStep(13)), '工作集 step13 不得被压')

    // 回执各自可恢复（每段一张，不做旧回执吸收）。
    for (let index = 0; index < 2; index += 1) {
      const restore = await engine.restoreHistory(id, { index })
      assert.equal(restore.restored, true, JSON.stringify(restore))
    }
    assert.deepEqual(ctx.warnings, [], '归档不得产生失败告警：' + ctx.warnings.join(' | '))
  })
})

test('E<T + pin 等待：候选总量不足阈值时不提前短批，surface/voucher 不变', async () => {
  await withSession((session) => bigSteps(session, 1, 10), async ({ engine, session, id, pinRecord }) => {
    await pinRecord(assistantSeqOfStep(4))
    const settings = { retainOperations: 1, coolingBatchSize: 10 }
    const before = await session.surface.nodes
    const waiting = await engine.archiveForStep(id, session, settings)
    assert.equal(waiting.status, 'no-candidate', JSON.stringify(waiting))
    assert.equal(waiting.reason, 'waiting-batch')
    assert.equal(waiting.batch, 9, '闸门分子 = 已落出窗口的候选数')
    assert.equal(waiting.closedSteps, 8, '其中可安全归档 8 步（pin 占 1 个候选）')
    assert.equal(waiting.needed, 1)
    assert.deepEqual(await session.surface.nodes, before, '未满阈值不得改 surface')
    assert.equal((await engine.historyOf(id)).total, 0, '未满阈值不得产生 voucher')
    const preview = await engine.dryRunArchive(id, session, settings)
    assert.equal(preview.reason, 'waiting-batch', '预览与执行同一判据')
    assert.equal(preview.boundary, 'pinned', '保护洞事实必须报出来')
  })
})

test('跨步闭包在批尾：结果落在阈值之后 → 整段扩展到闭合点，不拆调用', async () => {
  // step10 声明工具调用、step11 的结果收口；阈值 10 的窗口本该停在 step10，
  // 但调用未闭合 → 向后扩到 step11（closure-extension，共 11 步），仍是一段。
  await withSession((session) => {
    bigSteps(session, 1, 9)
    session.append('step/start', { turn: 1, step: 10 })
    session.pushAssistantWithToolCall(('第 10 步数据 ').repeat(120), 'cross-boundary', 'read', {})
    session.append('step/end', { turn: 1, step: 10 })
    session.append('step/start', { turn: 1, step: 11 })
    session.pushToolResult('cross-boundary', ('跨步结果 ').repeat(80))
    session.append('step/end', { turn: 1, step: 11 })
    bigSteps(session, 12, 13)
  }, async ({ engine, session, id }) => {
    const settings = { retainOperations: 1, coolingBatchSize: 10 }
    const archived = await engine.archiveForStep(id, session, settings)
    assert.equal(archived.status, 'archived', JSON.stringify(archived))
    assert.equal(archived.committedCount, 1, '跨步闭包必须是同一段')
    assert.equal(archived.steps, 11, '阈值 10 + 闭包扩展 1 步')
    const nodes = await session.surface.nodes
    assert.ok(!nodes.includes(assistantSeqOfStep(10)), '声明节点已被遮蔽（与结果一起）')
    assert.ok(!nodes.includes(assistantSeqOfStep(11)), '结果节点已被遮蔽（与声明一起）')
    assert.ok(nodes.includes(assistantSeqOfStep(12)), '扩展外的步骤不得被卷进本批')
  })
})

test('跨步闭包被保护洞隔开：失败关闭，声明与结果两侧都留在活动面', async () => {
  // step3 声明、step4 结果；pin step4。run1 的闭合前缀只到 step2（声明不能单边遮蔽），
  // run2（step5 起）照常成段——但 step3 的声明与 step4 的结果都必须在面上。
  await withSession((session) => {
    bigSteps(session, 1, 2)
    session.append('step/start', { turn: 1, step: 3 })
    session.pushAssistantWithToolCall(('第 3 步数据 ').repeat(120), 'split-by-pin', 'read', {})
    session.append('step/end', { turn: 1, step: 3 })
    session.append('step/start', { turn: 1, step: 4 })
    session.pushToolResult('split-by-pin', ('被保护的结果 ').repeat(80))
    session.pushAssistant(('第 4 步数据 ').repeat(120))
    session.append('step/end', { turn: 1, step: 4 })
    bigSteps(session, 5, 13)
  }, async ({ engine, session, id, pinRecord }) => {
    await pinRecord(assistantSeqOfStep(4))
    const settings = { retainOperations: 1, coolingBatchSize: 10 }
    const archived = await engine.archiveForStep(id, session, settings)
    assert.equal(archived.status, 'archived', JSON.stringify(archived))
    assert.equal(archived.committedCount, 2)
    assert.deepEqual(archived.segments.map((segment) => segment.steps), [2, 6])
    const nodes = await session.surface.nodes
    assert.ok(nodes.includes(assistantSeqOfStep(3)), '声明侧必须留在活动面（不得单边遮蔽）')
    assert.ok(nodes.includes(assistantSeqOfStep(4)), '结果侧（pin）必须留在活动面')
    for (const segment of archived.segments) {
      assert.ok(!segment.recordIds.includes('v3r-' + assistantSeqOfStep(3)), '任何段都不得包含声明节点')
    }
  })
})

test('部分提交失败：已提交段如实入账，失败段保留 intent，下一次继续且不重复', async () => {
  await withSession((session) => bigSteps(session, 1, 13), async ({ engine, session, root, id, pinRecord }) => {
    await pinRecord(assistantSeqOfStep(4))
    const settings = { retainOperations: 1, coolingBatchSize: 10 }
    // 第 2 次 range replace（第二段）抛错：模拟宿主改面失败。
    const originalAppend = session.append
    let replaceCount = 0
    session.append = (type, data, options) => {
      if (options?.surfaceOp !== undefined) {
        replaceCount += 1
        if (replaceCount === 2) throw new Error('injected surface failure')
      }
      return originalAppend(type, data, options)
    }
    const partial = await engine.archiveForStep(id, session, settings)
    session.append = originalAppend
    assert.equal(partial.status, 'partial', JSON.stringify(partial))
    assert.equal(partial.committedCount, 1, '第一段已落面')
    assert.equal(partial.steps, 3)
    assert.equal(partial.failed?.phase, 'surface', '失败阶段必须如实')
    assert.equal(partial.remaining.length, 1, '未提交段必须列出')
    assert.equal((await engine.historyOf(id)).total, 1, '只有已提交段有 voucher')
    // 失败段的 intent 保留，等待下一次对账（不冒充成功、也不丢线索）。
    const intentRaw = await readFile(archiveIntentPath(root, id), 'utf8')
    assert.equal(JSON.parse(intentRaw).startSeq, partial.remaining[0].startSeq, '保留的 intent 指向失败段')

    // 下一次显式 now：先对账清掉失败段的旧 intent，再绕节奏门提交剩余段。
    const recovered = await engine.archiveForStep(id, session, settings, { resetNotWorth: true })
    assert.equal(recovered.status, 'archived', JSON.stringify(recovered))
    assert.equal(recovered.committedCount, 1)
    assert.equal(recovered.steps, 8, '剩余 8 步（含窗口外候选）在同一次手动动作里成段')
    assert.equal((await engine.historyOf(id)).total, 2)
    let intentExists = true
    try { await readFile(archiveIntentPath(root, id), 'utf8') } catch { intentExists = false }
    assert.equal(intentExists, false, '收敛后 intent 必须清掉')
    assert.ok((await session.surface.nodes).includes(assistantSeqOfStep(4)), 'pin 仍在活动面')
    // 第三次不再重复归档同一段。
    const again = await engine.archiveForStep(id, session, settings)
    assert.notEqual(again.status, 'archived', '不得重复归档：' + JSON.stringify(again))
  })
})



test('同批判负：首段不划算被跳过，后段照常提交，游标推进而不堵后续', async () => {
  // step1–3 正文只有 1 字（判负），step4 起是大步骤；pin step4 把窗口切成
  // run1=step1–3（判负）、run2=step5–10（划算）。判负段留在活动面，后段同批提交。
  await withSession((session) => {
    for (let index = 1; index <= 3; index += 1) {
      session.append('step/start', { turn: 1, step: index })
      session.pushAssistant('x')
      session.append('step/end', { turn: 1, step: index })
    }
    bigSteps(session, 4, 13)
  }, async ({ engine, session, id, pinRecord }) => {
    await pinRecord(assistantSeqOfStep(4))
    const archived = await engine.archiveForStep(id, session, { retainOperations: 1, coolingBatchSize: 10 })
    assert.equal(archived.status, 'archived', JSON.stringify(archived))
    assert.equal(archived.committedCount, 1, '只提交划算的第二段')
    assert.equal(archived.steps, 6)
    assert.equal(archived.skipped.length, 1, '判负段必须如实记账')
    assert.equal(archived.notWorthThroughSeq, assistantSeqOfStep(3), '游标推进到判负段末尾')
    assert.equal((await engine.historyOf(id)).total, 1)
    const nodes = await session.surface.nodes
    for (const seq of [assistantSeqOfStep(1), assistantSeqOfStep(2), assistantSeqOfStep(3)]) {
      assert.ok(nodes.includes(seq), '判负段不得被遮蔽：seq ' + seq)
    }
    assert.ok(!nodes.includes(assistantSeqOfStep(5)), '第二段已提交')
  })
})
test('提交前重验证：段间活动面漂移 → 后续段不提交（partial/revalidate）', async () => {
  await withSession((session) => bigSteps(session, 1, 13), async ({ engine, session, id, pinRecord }) => {
    await pinRecord(assistantSeqOfStep(4))
    const settings = { retainOperations: 1, coolingBatchSize: 10 }
    const preview = await engine.dryRunArchive(id, session, settings)
    assert.equal(preview.segments.length, 2)
    const secondStart = preview.segments[1].startSeq
    // 第一段 replace 成功后伪装一次外部改面：把第二段的起始节点移出活动面。
    const originalAppend = session.append
    let replaced = 0
    session.append = (type, data, options) => {
      const result = originalAppend(type, data, options)
      if (options?.surfaceOp !== undefined) {
        replaced += 1
        if (replaced === 1) {
          const index = session.surface.nodes.indexOf(secondStart)
          if (index !== -1) session.surface.nodes.splice(index, 1)
        }
      }
      return result
    }
    const result = await engine.archiveForStep(id, session, settings)
    session.append = originalAppend
    assert.equal(result.status, 'partial', JSON.stringify(result))
    assert.equal(result.committedCount, 1, '漂移前的段已提交，不回滚')
    assert.equal(result.failed?.phase, 'revalidate', '后一段必须被重验证挡下')
    assert.equal(result.failed?.reason, 'surface-changed')
    assert.equal(result.remaining.length, 1)
    assert.equal((await engine.historyOf(id)).total, 1, '漂移段不得产生 voucher')
  })
})

test('命令面：多段/部分提交/判负跳过不把部分成功说成整批成功', () => {
  const archived = archiveLine({
    status: 'archived', committedCount: 2, steps: 9, startSeq: 2, endSeq: 20,
    recordIds: ['a', 'b', 'c'], receiptSeqs: [30, 32],
  })
  assert.match(archived, /已归档 2 段/)
  assert.match(archived, /回执 seq 30\/32/)
  const partial = archiveLine({
    status: 'partial', committedCount: 1, steps: 3, startSeq: 2, endSeq: 8, recordIds: ['a'],
    segments: [{ startSeq: 2, endSeq: 8 }], remaining: [{ startSeq: 9, endSeq: 20 }, { startSeq: 21, endSeq: 30 }],
    failed: { index: 1, phase: 'surface', reason: 'surface-changed' },
  })
  assert.match(partial, /部分归档/)
  assert.match(partial, /已提交 1 段/)
  assert.match(partial, /失败段 #1（surface\/surface-changed）/)
  assert.match(partial, /其余 2 段未提交/)
  const planned = archiveLine({
    status: 'planned', startSeq: 2, endSeq: 20, recordIds: ['a', 'b', 'c'],
    items: [{}, {}], segments: [{}, {}, {}], skipped: [{}],
  })
  assert.match(planned, /分 2 段提交/)
  assert.match(planned, /1 段判负跳过/)
})
test('manual 与 auto 共用 planner：E<T 时 manual 只绕节奏门，段边界仍按安全判据', async () => {
  await withSession((session) => bigSteps(session, 1, 10), async ({ engine, session, id, pinRecord }) => {
    await pinRecord(assistantSeqOfStep(4))
    const settings = { retainOperations: 1, coolingBatchSize: 10 }
    const auto = await engine.archiveForStep(id, session, settings)
    assert.equal(auto.status, 'no-candidate', '自动路径受阈值约束：' + JSON.stringify(auto))
    const preview = await engine.dryRunArchive(id, session, settings)
    assert.equal(preview.reason, 'waiting-batch')

    const manual = await engine.archiveForStep(id, session, settings, { resetNotWorth: true })
    assert.equal(manual.status, 'archived', JSON.stringify(manual))
    assert.equal(manual.committedCount, 2, '同一批两段（pin 两侧）在手动动作里一起提交')
    assert.deepEqual(manual.segments.map((segment) => segment.steps), [3, 5])
    assert.ok((await session.surface.nodes).includes(assistantSeqOfStep(4)), 'manual 不绕 pin')
  })
})
