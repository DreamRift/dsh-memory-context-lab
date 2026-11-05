/**
 * 按步归档：**两步之间的插件回执**（真实宿主 pre-step 时序）不得让选择器停摆。
 *
 * 真实 DSH 的 pre-step 在上一轮 `step/end` 之后、下一步 `step/start` 之前追加回执：
 *
 *   step/start … step/end，回执，step/start … step/end，回执，…
 *
 * 而 `buildStepUnits` 只收「打开的步骤内」的事件——**落在两步之间的回执不属于任何
 * 单元**。旧实现因此看不见它：它既不让单元 `hasPlugin`，也不会被吸收进 span，
 * 于是每段 span 的密集覆盖判据必然失败（`shadowed.length !== wanted.length`），
 * 按步归档在真实会话里表现为「压完一批就永久 not-dense 停摆」。
 *
 * 本轮修法（与 F1 / AUD51-05-02 的「回执不吸收」一致）：
 * 1. 两步之间的**回注包**透明（并进前一个单元，遮蔽但不进 recordSeqs）；
 * 2. 两步之间的**回执/恢复、真人消息、无记录节点**是硬边界：前一个单元到此收尾，
 *    边界留在活动面，后面的步另起一段；
 * 3. 硬边界上的步各自成段、逐段提交，任何一段都仍然通过密集判据。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { attachV3Engine } from '../src/v3/entry/v3-entry.mjs'
import { selectStepSpan, STEP_BATCH_MAX } from '../src/v3/domain/archive/steps.mjs'
import { createFakeSession } from './helpers/fake-session.mjs'

const hasRecord = () => true

/** 一步占 3 个 seq：start / assistant / end。 */
function step(turn, index, start) {
  return [
    { seq: start, type: 'step/start', data: { turn, step: index } },
    { seq: start + 1, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'a' + (start + 1) }] } } },
    { seq: start + 2, type: 'step/end', data: { turn, step: index } },
  ]
}
/** 真实宿主的回执：user/message + 插件来源 + memory-lab3-surface（不是回注包）。 */
function receipt(seq, form = 'memory-lab3-surface') {
  return { seq, type: 'user/message', data: { source: { kind: 'dsh-memory-context-lab', form }, content: [{ type: 'text', text: '回执' }] } }
}
const surfaceOf = (events) => events.filter((e) => !String(e.type).startsWith('step/')).map((e) => e.seq)
const rejectionOf = (run) => {
  let rejection = null
  run((row) => { rejection = rejection ?? row })
  return rejection
}

/** 三步 → 回执 → 之后 11 步（回执夹在两个单元之间，正是真实位置）。 */
function interStepReceiptFixture() {
  const events = []
  let seq = 100
  for (let index = 1; index <= 3; index += 1) { events.push(...step(1, index, seq)); seq += 3 }
  events.push(receipt(seq))
  seq += 1
  for (let index = 4; index <= 14; index += 1) { events.push(...step(1, index, seq)); seq += 3 }
  return events
}

test('两步之间的回执是硬边界：不产生 not-dense，回执之前的步照常成段', () => {
  const events = interStepReceiptFixture()
  const surface = surfaceOf(events)
  const span = selectStepSpan({ surfaceNodes: surface, events, hasRecord, retainSteps: 1, batchSteps: 10, bypassBatch: true, maxSteps: STEP_BATCH_MAX })
  assert.ok(span !== null, '真实时序（回执夹在两步之间）不得让选择器返回 null')
  assert.equal(span.segments.length >= 1, true)
  const first = span.segments[0]
  const receiptSeq = 109
  // 第三步 = seq 106/107/108（start/assistant/end），活动面只收 assistant → 右端是 107。
  assert.equal(first.endSeq, 107, '回执之前的最后一步是这一段的右端（回执本身绝不被遮蔽）')
  assert.equal(first.boundary, 'plugin-boundary', '段边界如实报 plugin-boundary')
  assert.equal(first.sourceEventSeqs.includes(receiptSeq), false, '回执不得进 span：F1 之后每张回执都要留在活动面')
  for (const segment of span.segments) {
    assert.equal(segment.sourceEventSeqs.includes(receiptSeq), false, '任何段都不得遮蔽回执')
    // 逐段自证密集：宿主 range replace 的硬前提
    const startIdx = surface.indexOf(segment.startSeq)
    const endIdx = surface.indexOf(segment.endSeq)
    assert.deepEqual(surface.slice(startIdx, endIdx + 1), segment.sourceEventSeqs, '每段都必须密集覆盖活动面')
  }
})

test('两步之间的回执：后面的步自成后续段，逐段都能提交（不停摆）', () => {
  const events = interStepReceiptFixture()
  const surface = surfaceOf(events)
  const span = selectStepSpan({ surfaceNodes: surface, events, hasRecord, retainSteps: 1, batchSteps: 10, bypassBatch: true, maxSteps: STEP_BATCH_MAX })
  assert.ok(span.segments.length >= 2, '回执之后必须另有安全段，而不是整批被回执堵死')
  const after = span.segments[span.segments.length - 1]
  assert.equal(after.startSeq > 109, true, '后续段从回执之后开始')
})

test('两步之间的回注包透明：并进前一段遮蔽，但不进 recordSeqs', () => {
  const events = []
  let seq = 100
  for (let index = 1; index <= 3; index += 1) { events.push(...step(1, index, seq)); seq += 3 }
  events.push(receipt(seq, 'recall'))
  const recallSeq = seq
  seq += 1
  for (let index = 4; index <= 6; index += 1) { events.push(...step(1, index, seq)); seq += 3 }
  const surface = surfaceOf(events)
  const span = selectStepSpan({ surfaceNodes: surface, events, hasRecord, retainSteps: 1, batchSteps: 3, bypassBatch: true, maxSteps: 3 })
  assert.ok(span !== null, '两步之间的回注包不得触发 not-dense')
  const startIdx = surface.indexOf(span.startSeq)
  const endIdx = surface.indexOf(span.endSeq)
  assert.deepEqual(surface.slice(startIdx, endIdx + 1), span.sourceEventSeqs, '整段密集覆盖活动面')
  assert.equal(span.sourceEventSeqs.includes(recallSeq), true, '回注包随段一起遮蔽（透明节点）')
  assert.equal(span.recordSeqs.includes(recallSeq), false, '回注包不进 recordSeqs（本来就没入库）')
  assert.equal(span.endSeq, recallSeq, '段右端可以停在回注包上（它透明，不是边界）')
  assert.equal(span.startSeq, 101, '段从第一步的活动面节点开始')
})

test('段内回执仍是整步边界（对照：本修只改「两步之间」的归属，不改步骤内部的判据）', () => {
  // 回执落在**队头步骤内部**（step/start…step/end 之间）：整步不可压，队头阻塞照旧。
  const head = [
    { seq: 1, type: 'step/start', data: { turn: 1, step: 1 } },
    receipt(2),
    { seq: 3, type: 'step/end', data: { turn: 1, step: 1 } },
    ...step(1, 2, 4),
  ]
  assert.equal(selectStepSpan({ surfaceNodes: surfaceOf(head), events: head, hasRecord, retainSteps: 1, batchSteps: 2, bypassBatch: true, maxSteps: 2, headOnly: true }), null,
    '队头步骤内部的插件回执仍是整步边界')
  const rejection = rejectionOf((onReject) => selectStepSpan({ surfaceNodes: surfaceOf(head), events: head, hasRecord, retainSteps: 1, batchSteps: 2, bypassBatch: true, maxSteps: 2, headOnly: true, onReject }))
  assert.equal(rejection?.reason, 'plugin-boundary')

  // 回执落在**中间步骤内部**：它之前的队头步骤照常成段，回执所在步与之后的步都不被遮蔽。
  const middle = [
    ...step(1, 1, 1),
    { seq: 4, type: 'step/start', data: { turn: 1, step: 2 } },
    receipt(5),
    { seq: 6, type: 'step/end', data: { turn: 1, step: 2 } },
    ...step(1, 3, 7),
  ]
  const span = selectStepSpan({ surfaceNodes: surfaceOf(middle), events: middle, hasRecord, retainSteps: 1, batchSteps: 3, bypassBatch: true, maxSteps: 3 })
  assert.ok(span !== null, '队头步骤本身安全，可以成段')
  assert.equal(span.endSeq, 2, '段止于中间步骤之前')
  assert.equal(span.boundary, 'plugin-boundary')
  for (const segment of span.segments) assert.equal(segment.sourceEventSeqs.includes(5), false, '段内回执不得被任何段遮蔽')
})

test('端到端：真实时序下按步归档真的落到活动面（回执之后继续可压）', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-inter-step-'))
  const handlers = new Map()
  const ctx = {
    warnings: [],
    on(name, handler) { handlers.set(name, handler); return () => handlers.delete(name) },
    logger: { warn() {}, info() {} },
  }
  ctx.callPreStep = async (session) => {
    const handler = handlers.get('agent/pre-step')
    if (!handler) throw new Error('未注册 pre-step')
    return await handler({ agent: { session }, signal: undefined }, async () => ({ kind: 'enter' }))
  }
  const engine = attachV3Engine(ctx, { v3Root: root })
  try {
    const session = createFakeSession({ id: 's-inter-step', cwd: 'C:\\ws', contextWindow: 1000000 })
    session.pushContextWindow(1000000)
    session.pushUser('开始'.repeat(60))
    // 两批步骤，中间夹一张**真实宿主形状**的回执（pre-step 在两步之间追加）。
    for (let index = 1; index <= 8; index += 1) {
      session.append('step/start', { turn: 1, step: index })
      session.pushAssistant(('第 ' + index + ' 步数据 ').repeat(120))
      session.append('step/end', { turn: 1, step: index })
    }
    session.append('user/message', { source: { kind: 'dsh-memory-context-lab', form: 'memory-lab3-surface' }, content: [{ type: 'text', text: '占位回执' }] })
    const receiptSeq = session.surface.nodes.at(-1)
    for (let index = 9; index <= 20; index += 1) {
      session.append('step/start', { turn: 1, step: index })
      session.pushAssistant(('第 ' + index + ' 步数据 ').repeat(120))
      session.append('step/end', { turn: 1, step: index })
    }
    await ctx.callPreStep(session)
    await new Promise((resolve) => setTimeout(resolve, 150))
    await engine._waitForIdle().catch(() => {})
    await engine.setState('s-inter-step', { mode: 'cooling' })
    const dir = path.join(root, 'sessions', 's-inter-step')
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'usage.jsonl'), JSON.stringify({ seq: 1, inputTokens: 300000, totalTokens: 300001 }) + '\n')

    const archived = await engine.archiveForStep('s-inter-step', session, { retainOperations: 2, coolingBatchSize: 4 }, { resetNotWorth: true })
    assert.ok(['archived', 'partial'].includes(archived.status), '真实时序下必须真的归档：' + JSON.stringify(archived))
    assert.equal(archived.steps > 0, true)
    const nodes = await session.surface.nodes
    assert.equal(nodes.includes(receiptSeq), true, '回执必须留在活动面（F1 之后不吸收）')
    assert.equal((await engine.historyOf('s-inter-step')).total > 0, true)
  } finally {
    await engine._waitForIdle().catch(() => {})
    engine.dispose()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})
