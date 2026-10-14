/**
 * 活跃证据保护（active evidence protection）的行为测试。
 *
 * 这一层要证明的命题是：**历史年龄不能单独决定证据退出**。工具调用已返回不等于
 * 模型已看过结果，也不等于当前工作不再需要结果。所以这里的每个用例都在验证一个
 * 可核验的判定来源，而不是"策略看起来合理"：
 *
 *   - 硬保护只来自真实结构与宿主状态（未闭合调用、未曝光结果、待确认副作用、
 *     运行中的后台 job、系统／人类约束、冷库依赖）；
 *   - 软保留（召回刚读回、任务关联线索、显式 pin）有预算、有到期、有解除条件；
 *   - 被保护的候选在租用冷节点 id **之前**就被拒，绝不留痕；
 *   - 保护集超预算时不丢硬保护，并如实报告；
 *   - 非连续的保护节点不会被范围替换跨越。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  MAX_PINNED_RANGES,
  PROTECTION_CODES,
  PROTECTION_SOURCE,
  ProtectionRegistry,
  collectStructuralProtections,
  collectTaskLinkProtections,
  coldDependencyEntries,
  hasConfirmedEffect,
  hasPendingEffect,
  identifiersOf,
  jobReferencesOf,
  makeEntry,
  recallProtectionEntries,
} from '../src/protection.mjs'
import { applyOperations, archiveMac, collectOperationCandidates, openTurnOf, planCooling } from '../src/apply.mjs'
import { MIN_OPERATION_CHARS } from '../src/core.mjs'
import { buildSession, FakeColdStore, fakeMeter, operation } from './helpers/fake-host.mjs'

/** 用真实候选选择逻辑收集一次视图（保护判定必须在同一份事实上工作）。 */
function viewOf(session, { retainOperations = 0 } = {}) {
  return collectOperationCandidates({
    surfaceNodes: session.surface.nodes,
    eventAt: (seq) => session.eventAt(seq),
    measuredNodes: fakeMeter.measure(session).nodes,
    retainOperations,
    openTurn: openTurnOf(session),
    archivedRanges: [],
    minimumChars: MIN_OPERATION_CHARS,
  })
}

/** A view with no candidates and the given skip rows, as the collector reports them. */
function viewWithSkips(rows) {
  return {
    candidates: [],
    skipped: rows.map(([seq, reason]) => ({ seq, reason, description: reason })),
    lastAssistantSeq: null,
  }
}

/**
 * 正文必须超过最小归档阈值，这段操作才会成为**真正的候选**。
 *
 * 低于阈值的操作本来就不会被归档，所以它也不需要保护——保护集只处理"够大、
 * 随时可能被归档"的证据。测试若用短正文，就会测到一个永远不会发生的场景。
 */
function pad(text) {
  return `${text}\n${'内容'.repeat(700)}`
}

function registryFor({ soft = [], budgetTokens = 32768 } = {}) {
  return new ProtectionRegistry({ soft, budgetTokens, ttlMs: 60_000 })
}

// ---------------------------------------------------------------------------
// 判定来源：只认确定性信号
// ---------------------------------------------------------------------------

test('jobReferencesOf reads explicit job ids, including CJK unit names', () => {
  assert.deepEqual(
    jobReferencesOf('已提交：job_id=h_zcode端_灵枢迭代_记录单元_0001'),
    ['h_zcode端_灵枢迭代_记录单元_0001'],
  )
  assert.deepEqual(jobReferencesOf('job id: "h_lead_alpha_verify_0007"'), ['h_lead_alpha_verify_0007'])
  // 没有 job 标识的散文不产生引用，避免把句子当成 id。
  assert.deepEqual(jobReferencesOf('这个任务还没结束，等一会儿再看'), [])
})

test('hasPendingEffect only accepts explicit waiting language, not bare "uncommitted"', () => {
  assert.equal(hasPendingEffect('已 queued for review，等待确认'), true)
  assert.equal(hasPendingEffect('该改动尚未提交到主干，待人工处理'), true)
  // 刻意排除裸的"未提交"：`git status` 的"未提交的更改"会让每个读仓库状态的
  // 操作都变成永不解除的硬保护。
  assert.equal(hasPendingEffect('当前有 3 个未提交的更改'), false)
  assert.equal(hasConfirmedEffect('已提交并通过校验'), true)
  assert.equal(hasConfirmedEffect('nothing to report'), false)
})

test('identifiersOf extracts deterministic paths and identifiers, never prose words', () => {
  const found = identifiersOf('请检查 `记忆上下文/plugin-v1/src/protection.mjs` 和 README.md 里的说明')
  assert.ok(found.has('记忆上下文/plugin-v1/src/protection.mjs'))
  assert.ok(found.has('readme.md'))
  assert.ok(found.has('记忆上下文/plugin-v1/src/protection.mjs'))
  assert.equal(found.has('说明'), false, '普通词不是线索')
  assert.equal(found.has('请检查'), false)
})

// ---------------------------------------------------------------------------
// 硬保护：结构与宿主状态
// ---------------------------------------------------------------------------

test('structural skips map to hard protections, and non-protective skips do not', () => {
  const entries = collectStructuralProtections({
    view: viewWithSkips([
      [0, 'protected-system-head'],
      [1, 'protected-latest-user'],
      [7, 'not-yet-exposed'],
      [9, 'unpaired'],
      [11, 'no-call-id'],
      [13, 'failed-result'],
      // 这些只是"不合格"，不构成保护：
      [15, 'too-short'],
      [17, 'already-archived'],
      [19, 'below-min-release'],
    ]),
    surfaceNodes: [],
    eventAt: () => null,
  })
  const bySeq = new Map(entries.map((entry) => [entry.target.seq, entry]))
  assert.equal(entries.length, 6, '只有六条真实结构证据变成硬保护')
  assert.equal(bySeq.get(0).source, PROTECTION_SOURCE.INSTRUCTION)
  assert.equal(bySeq.get(1).source, PROTECTION_SOURCE.INSTRUCTION)
  assert.equal(bySeq.get(7).source, PROTECTION_SOURCE.EXPOSURE)
  assert.equal(bySeq.get(9).source, PROTECTION_SOURCE.STRUCTURE)
  assert.equal(bySeq.get(11).source, PROTECTION_SOURCE.STRUCTURE)
  assert.equal(bySeq.get(13).source, PROTECTION_SOURCE.STRUCTURE)
  for (const entry of entries) {
    assert.equal(entry.strength, 'hard')
    assert.ok(entry.release?.description, '每条保护都要写明解除条件')
  }
  assert.equal(bySeq.has(15), false)
  assert.equal(bySeq.has(17), false)
  assert.equal(bySeq.has(19), false)
})

test('an unclosed call is hard-protected even though it is not even a candidate', () => {
  // 结果还没落地的操作根本不会成为候选——而它恰恰是最需要保护的证据。
  const session = buildSession({ operations: 1, resultChars: 4000 })
  operation({ session, callId: 'call-open', toolName: 'read', args: '{"file":"x"}', result: 'y'.repeat(4000), turn: 9, step: 1 })
  // 去掉最后一条结果，制造未闭合调用。
  session.nodes.pop()
  const view = collectOperationCandidates({
    surfaceNodes: session.surface.nodes,
    eventAt: (seq) => session.eventAt(seq),
    measuredNodes: fakeMeter.measure(session).nodes,
    retainOperations: 0,
    openTurn: openTurnOf(session),
    archivedRanges: [],
    minimumChars: MIN_OPERATION_CHARS,
  })
  assert.ok(view.skipped.some((row) => row.reason === 'unpaired'))
  const entries = collectStructuralProtections({
    view,
    surfaceNodes: [...session.surface.nodes],
    eventAt: (seq) => session.eventAt(seq),
  })
  const unpaired = entries.find((entry) => entry.reason.includes('调用未闭合'))
  assert.ok(unpaired, '未闭合调用必须被硬保护')
  assert.equal(unpaired.strength, 'hard')
  assert.equal(unpaired.release.kind, 'on-pairing')
})

test('a running background job is hard-protected; a terminal result releases it', () => {
  const running = buildSession({ operations: 1, resultChars: 4000 })
  operation({
    session: running,
    callId: 'call-job',
    toolName: 'pwsh',
    args: '{"command":"hive submit ..."}',
    result: pad(`已提交：job_id=h_zcode端_灵枢迭代_记录单元_0001（后台执行，不阻塞）`),
    turn: 5,
    step: 1,
  })
  const viewOf = (session) => collectOperationCandidates({
    surfaceNodes: session.surface.nodes,
    eventAt: (seq) => session.eventAt(seq),
    measuredNodes: fakeMeter.measure(session).nodes,
    retainOperations: 0,
    openTurn: openTurnOf(session),
    archivedRanges: [],
    minimumChars: MIN_OPERATION_CHARS,
  })
  const hardOf = (session) => collectStructuralProtections({
    view: viewOf(session),
    surfaceNodes: [...session.surface.nodes],
    eventAt: (seq) => session.eventAt(seq),
  })

  const before = hardOf(running).filter((entry) => entry.source === PROTECTION_SOURCE.BACKGROUND_JOB)
  assert.equal(before.length, 1, '启动成功不等于 job 已完成')
  assert.match(before[0].reason, /h_zcode端_灵枢迭代_记录单元_0001/)
  assert.equal(before[0].release.kind, 'on-evidence')

  // 后续轮次里出现同一 job 的终态证据 → 保护解除（下一轮重推时不再出现）。
  operation({
    session: running,
    callId: 'call-poll',
    toolName: 'pwsh',
    args: '{"command":"hive poll"}',
    result: 'job_id=h_zcode端_灵枢迭代_记录单元_0001 已完成，退出码 0',
    turn: 6,
    step: 1,
  })
  const after = hardOf(running).filter((entry) => entry.source === PROTECTION_SOURCE.BACKGROUND_JOB)
  assert.equal(after.length, 0, '终态证据出现后不再硬保护')
})

test('the poll operation that reports the terminal state is not protected by itself', () => {
  // 每轮 poll 都新增一段引用 job_id 的操作。如果"自己的终态结果"也被当成待解除的
  // 证据，长会话里的保护集就会只增不减，把整条任务历史钉死在投影里。
  const session = buildSession({ operations: 0 })
  operation({
    session,
    callId: 'call-poll',
    toolName: 'pwsh',
    args: '{"command":"hive poll h_lead_alpha_record_0001"}',
    result: pad('job_id=h_lead_alpha_record_0001 已完成，退出码 0'),
    turn: 6,
    step: 1,
  })
  const entries = collectStructuralProtections({
    view: collectOperationCandidates({
      surfaceNodes: session.surface.nodes,
      eventAt: (seq) => session.eventAt(seq),
      measuredNodes: fakeMeter.measure(session).nodes,
      retainOperations: 0,
      openTurn: openTurnOf(session),
      archivedRanges: [],
      minimumChars: MIN_OPERATION_CHARS,
    }),
    surfaceNodes: [...session.surface.nodes],
    eventAt: (seq) => session.eventAt(seq),
  })
  assert.equal(entries.filter((entry) => entry.source === PROTECTION_SOURCE.BACKGROUND_JOB).length, 0)
})

test('a job whose state is unknown after a restart stays protected (conservative)', () => {
  // 插件重启后拿不到 job 的运行态，也没有终态证据：只能保守继续保护，
  // 不能因为"看不到它"就当作它已经结束。
  const session = buildSession({ operations: 1, resultChars: 4000 })
  operation({
    session,
    callId: 'call-job',
    toolName: 'pwsh',
    args: '{"command":"hive submit ..."}',
    result: pad('已提交：job_id=h_lead_alpha_sustain_0009'),
    turn: 5,
    step: 1,
  })
  operation({
    session,
    callId: 'call-note',
    toolName: 'read',
    args: '{"file":"unrelated.md"}',
    result: '与那个 job 无关的其它内容，状态未知',
    turn: 6,
    step: 1,
  })
  const entries = collectStructuralProtections({
    view: collectOperationCandidates({
      surfaceNodes: session.surface.nodes,
      eventAt: (seq) => session.eventAt(seq),
      measuredNodes: fakeMeter.measure(session).nodes,
      retainOperations: 0,
      openTurn: openTurnOf(session),
      archivedRanges: [],
      minimumChars: MIN_OPERATION_CHARS,
    }),
    surfaceNodes: [...session.surface.nodes],
    eventAt: (seq) => session.eventAt(seq),
  })
  assert.equal(entries.filter((entry) => entry.source === PROTECTION_SOURCE.BACKGROUND_JOB).length, 1)
})

test('interleaved tasks A and B: finishing A does not release B evidence', () => {
  const session = buildSession({ operations: 1, resultChars: 4000 })
  operation({
    session,
    callId: 'call-a',
    toolName: 'pwsh',
    args: '{"command":"hive submit A"}',
    result: pad('已提交：job_id=h_lead_alpha_record_0001'),
    turn: 5,
    step: 1,
  })
  operation({
    session,
    callId: 'call-b',
    toolName: 'pwsh',
    args: '{"command":"hive submit B"}',
    result: pad('已提交：job_id=h_lead_beta_record_0002'),
    turn: 5,
    step: 2,
  })
  operation({
    session,
    callId: 'call-a-poll',
    toolName: 'pwsh',
    args: '{"command":"hive poll A"}',
    result: 'job_id=h_lead_alpha_record_0001 已完成，退出码 0',
    turn: 6,
    step: 1,
  })
  const entries = collectStructuralProtections({
    view: collectOperationCandidates({
      surfaceNodes: session.surface.nodes,
      eventAt: (seq) => session.eventAt(seq),
      measuredNodes: fakeMeter.measure(session).nodes,
      retainOperations: 0,
      openTurn: openTurnOf(session),
      archivedRanges: [],
      minimumChars: MIN_OPERATION_CHARS,
    }),
    surfaceNodes: [...session.surface.nodes],
    eventAt: (seq) => session.eventAt(seq),
  })
  const jobs = entries.filter((entry) => entry.source === PROTECTION_SOURCE.BACKGROUND_JOB)
  assert.equal(jobs.length, 1, '结束 A 只释放 A，B 的证据仍在')
  assert.match(jobs[0].reason, /h_lead_beta_record_0002/)
})

test('a result claiming a pending effect is hard-protected until the same tool confirms it', () => {
  const session = buildSession({ operations: 1, resultChars: 4000 })
  operation({
    session,
    callId: 'call-write',
    toolName: 'edit',
    args: '{"file":"a.md"}',
    result: pad('改动已 queued for review，等待确认后才会生效。'),
    turn: 5,
    step: 1,
  })
  const hardOf = () => collectStructuralProtections({
    view: collectOperationCandidates({
      surfaceNodes: session.surface.nodes,
      eventAt: (seq) => session.eventAt(seq),
      measuredNodes: fakeMeter.measure(session).nodes,
      retainOperations: 0,
      openTurn: openTurnOf(session),
      archivedRanges: [],
      minimumChars: MIN_OPERATION_CHARS,
    }),
    surfaceNodes: [...session.surface.nodes],
    eventAt: (seq) => session.eventAt(seq),
  })
  const pending = hardOf().filter((entry) => entry.source === PROTECTION_SOURCE.PENDING_EFFECT)
  assert.equal(pending.length, 1)
  assert.equal(pending[0].strength, 'hard')
  assert.match(pending[0].reason, /待确认/)

  operation({
    session,
    callId: 'call-write-2',
    toolName: 'edit',
    args: '{"file":"a.md"}',
    result: '该改动已确认并生效。',
    turn: 6,
    step: 1,
  })
  assert.equal(
    hardOf().filter((entry) => entry.source === PROTECTION_SOURCE.PENDING_EFFECT).length,
    0,
    '同一工具的后续结果报告已确认后解除',
  )
})

test('cold dependency on an applied receipt is hard protection', () => {
  const entries = coldDependencyEntries({
    archiveRows: [
      { nodeId: 'archived_abc_1', status: 'applied', rangeStart: 3, rangeEnd: 4, originalTokens: 900 },
      { nodeId: 'archived_abc_2', status: 'restored', rangeStart: 5, rangeEnd: 6 },
    ],
    operationEpoch: 4,
  })
  assert.equal(entries.length, 1, '只有仍在投影里的回执才产生冷库依赖')
  assert.equal(entries[0].source, PROTECTION_SOURCE.COLD_DEPENDENCY)
  assert.equal(entries[0].strength, 'hard')
  assert.equal(entries[0].target.nodeId, 'archived_abc_1')
})

// ---------------------------------------------------------------------------
// 软保留：任务关联线索、召回、pin
// ---------------------------------------------------------------------------

test('task-link soft protection needs a shared identifier and says it is only a clue', () => {
  const candidates = [{
    rangeStart: 11,
    rangeEnd: 12,
    body: '读取了 记忆上下文/plugin-v1/src/protection.mjs 的内容',
    originalTokens: 700,
  }, {
    rangeStart: 21,
    rangeEnd: 22,
    body: '读取了完全无关的另一个文件',
    originalTokens: 800,
  }]
  const entries = collectTaskLinkProtections({
    candidates,
    latestUserText: '请继续修改 记忆上下文/plugin-v1/src/protection.mjs',
    operationEpoch: 3,
  })
  assert.equal(entries.length, 1, '只有共享标识的候选才建立线索')
  assert.equal(entries[0].target.rangeStart, 11)
  assert.equal(entries[0].strength, 'soft', '线索永远不是硬保护')
  assert.match(entries[0].reason, /仅关联线索/)
  assert.match(entries[0].reason, /不构成语义依赖或版本相同的证明/)
  assert.equal(entries[0].release.kind, 'after-operations')
  assert.equal(entries[0].costTokens, 700)

  // 没有共享标识就不建立保护——不假装能自动理解任务关系。
  assert.deepEqual(
    collectTaskLinkProtections({ candidates, latestUserText: '继续吧', operationEpoch: 3 }),
    [],
  )
})

test('recall protection is soft, bounded, and expires by operation epoch', () => {
  const entries = recallProtectionEntries({
    nodeIds: ['archived_x_1'],
    ranges: [{ rangeStart: 31, rangeEnd: 32, body: 'body-31', costTokens: 500 }],
    queryId: 'q1',
    operationEpoch: 10,
    operations: 3,
  })
  assert.equal(entries.length, 3)
  for (const entry of entries) assert.equal(entry.strength, 'soft')

  const registry = registryFor()
  registry.setHard([])
  registry.setEpoch(10)
  for (const entry of entries) registry.addSoft(entry)
  assert.equal(registry.softCount(), 3)

  // 刚建立：还没到期。
  registry.setEpoch(12)
  assert.equal(registry.refreshSoft().length, 0, '过了 2 个操作仍在上限内')

  // 再过 3 个操作：全部按解除条件释放，并如实记账。
  registry.setEpoch(13)
  const released = registry.refreshSoft()
  assert.equal(released.length, 3)
  assert.equal(registry.softCount(), 0)
  assert.match(released[0].releasedBecause, /已过 3 个操作/)
})

test('a recall-protected range is not archived on the very next stable boundary', () => {
  const session = buildSession({ operations: 3, resultChars: 4000 })
  const view = collectOperationCandidates({
    surfaceNodes: session.surface.nodes,
    eventAt: (seq) => session.eventAt(seq),
    measuredNodes: fakeMeter.measure(session).nodes,
    retainOperations: 0,
    openTurn: openTurnOf(session),
    archivedRanges: [],
    minimumChars: MIN_OPERATION_CHARS,
  })
  const target = view.candidates[0]
  const registry = registryFor()
  for (const entry of recallProtectionEntries({
    ranges: [{ rangeStart: target.rangeStart, rangeEnd: target.rangeEnd, body: target.body, costTokens: target.originalTokens }],
    operationEpoch: 1,
    operations: 3,
  })) registry.addSoft(entry)

  const plan = planCooling({
    candidates: view.candidates,
    meter: fakeMeter,
    nodeIdFor: (candidate) => `node-${candidate.rangeStart}`,
    retainOperations: 0,
    batchSize: 3,
    maxOperations: 64,
    minNetReleaseTokens: 128,
    guard: (candidate) => registry.guard(candidate),
  })
  assert.equal(
    plan.units.some((unit) => unit.rangeStart === target.rangeStart),
    false,
    '刚被召回的段落不得在同一稳定边界上又被归档',
  )
  assert.ok(plan.rejected.some((row) => row.reason === PROTECTION_CODES.PROTECTED))

  // 到期后（再过 3 个操作）同一段重新可归档：保护不会变成永久拒绝。
  registry.setEpoch(4)
  registry.refreshSoft()
  const later = planCooling({
    candidates: view.candidates,
    meter: fakeMeter,
    nodeIdFor: (candidate) => `node-${candidate.rangeStart}`,
    retainOperations: 0,
    batchSize: 3,
    maxOperations: 64,
    minNetReleaseTokens: 128,
    guard: (candidate) => registry.guard(candidate),
  })
  assert.ok(later.units.some((unit) => unit.rangeStart === target.rangeStart), '到期后重新可归档')
})

test('an explicit pin outlives the retention window and survives budget degradation', () => {
  const session = buildSession({ operations: 3, resultChars: 4000 })
  const view = collectOperationCandidates({
    surfaceNodes: session.surface.nodes,
    eventAt: (seq) => session.eventAt(seq),
    measuredNodes: fakeMeter.measure(session).nodes,
    retainOperations: 0,
    openTurn: openTurnOf(session),
    archivedRanges: [],
    minimumChars: MIN_OPERATION_CHARS,
  })
  const pinned = view.candidates[1]
  const registry = registryFor({ budgetTokens: 100 })
  registry.addPin(makeEntry({
    source: PROTECTION_SOURCE.PIN,
    strength: 'soft',
    target: { kind: 'seq', seq: pinned.rangeStart },
    reason: '用户显式 pin',
    release: { kind: 'manual', description: '用户 /memory-lab unpin' },
    operationEpoch: 1,
  }))
  registry.addSoft(makeEntry({
    source: PROTECTION_SOURCE.TASK_LINK,
    strength: 'soft',
    target: { kind: 'range', rangeStart: view.candidates[0].rangeStart, rangeEnd: view.candidates[0].rangeEnd, seq: view.candidates[0].rangeStart },
    reason: '弱线索',
    release: { kind: 'after-operations', n: 2, description: '再过 2 个操作' },
    operationEpoch: 1,
    costTokens: 900,
  }))

  // 超预算：先释放最弱来源（task-link），pin 不动，硬保护也不动。
  registry.setHard([makeEntry({
    source: PROTECTION_SOURCE.STRUCTURE,
    strength: 'hard',
    target: { kind: 'seq', seq: 1 },
    reason: '结构证据',
    release: { kind: 'manual', description: '仅用户显式解除' },
  })])
  const budget = registry.enforceBudget()
  assert.equal(budget.overBudget, true)
  assert.equal(budget.released.length, 1)
  assert.equal(budget.released[0].source, PROTECTION_SOURCE.TASK_LINK)
  assert.equal(registry.softCount(), 1, 'pin 保留')
  assert.equal(registry.hard.length, 1, '硬保护一段未动')

  const plan = planCooling({
    candidates: view.candidates,
    meter: fakeMeter,
    nodeIdFor: (candidate) => `node-${candidate.rangeStart}`,
    retainOperations: 0,
    batchSize: 3,
    maxOperations: 64,
    minNetReleaseTokens: 128,
    guard: (candidate) => registry.guard(candidate),
  })
  assert.equal(
    plan.units.some((unit) => unit.rangeStart === pinned.rangeStart),
    false,
    '超过 N 个操作仍需使用的证据不会因年龄退出',
  )
})

test('pins are capped, and a refused pin is reported instead of dropped silently', () => {
  const registry = registryFor()
  for (let index = 0; index < MAX_PINNED_RANGES; index += 1) {
    const outcome = registry.addPin(makeEntry({
      source: PROTECTION_SOURCE.PIN,
      strength: 'soft',
      target: { kind: 'seq', seq: index + 10 },
      reason: 'pin',
      release: { kind: 'manual', description: 'unpin' },
    }))
    assert.equal(outcome.refused, false)
  }
  const refused = registry.addPin(makeEntry({
    source: PROTECTION_SOURCE.PIN,
    strength: 'soft',
    target: { kind: 'seq', seq: 999 },
    reason: 'pin',
    release: { kind: 'manual', description: 'unpin' },
  }))
  assert.equal(refused.refused, true)
  assert.equal(registry.refusedPins, 1)
  const report = registry.report()
  assert.ok(report.lines.some((line) => line.includes(`pin 已达上限 ${MAX_PINNED_RANGES}`)))
})

// ---------------------------------------------------------------------------
// 证据修订：旧验证不冒充新验证
// ---------------------------------------------------------------------------

test('a soft protection bound to changed evidence is released, not silently reused', () => {
  const body = 'v1 的正文'
  const changed = 'v2 的正文（文件已经改过）'
  const registry = registryFor()
  registry.setEpoch(5)
  registry.addSoft(makeEntry({
    source: PROTECTION_SOURCE.TASK_LINK,
    strength: 'soft',
    target: { kind: 'range', rangeStart: 41, rangeEnd: 42, seq: 41 },
    reason: '线索',
    release: { kind: 'after-operations', n: 5, description: '再过 5 个操作' },
    operationEpoch: 5,
    evidenceHash: archiveMac(body),
  }))

  // 同一段正文：保护成立。
  const same = registry.guard({ rangeStart: 41, rangeEnd: 42, shadowedSeqs: [41, 42], body })
  assert.equal(same.safe, false)
  assert.equal(same.code, PROTECTION_CODES.PROTECTED)

  // 正文变了：旧保护失效释放（旧验证不冒充新验证），并留下可审计的释放原因。
  const stale = registry.guard({ rangeStart: 41, rangeEnd: 42, shadowedSeqs: [41, 42], body: changed })
  assert.equal(stale.safe, true, '针对旧正文的保护不得继续拦截新正文')
  assert.equal(registry.softCount(), 0)
  const staleRow = registry.lastReleased.find((entry) => entry.code === PROTECTION_CODES.STALE)
  assert.ok(staleRow, '失效释放要进释放账')
  assert.match(staleRow.releasedBecause, /证据修订已变化/)
  assert.ok(registry.report().lines.some((line) => line.includes('证据修订已变化')))
})

test('hard structural protection is not released by an evidence revision', () => {
  const registry = registryFor()
  registry.setHard([makeEntry({
    source: PROTECTION_SOURCE.EXPOSURE,
    strength: 'hard',
    target: { kind: 'seq', seq: 51 },
    reason: '结果尚未曝光',
    release: { kind: 'next-assistant-message', description: '下一次助手消息产生' },
    evidenceHash: archiveMac('old body'),
  })])
  // 硬保护带 evidenceHash 时按同一规则失效释放；但纯结构保护（无 evidenceHash）
  // 由下一轮 surface 重推决定，命令与证据修订都不能解除它。
  registry.setHard([makeEntry({
    source: PROTECTION_SOURCE.STRUCTURE,
    strength: 'hard',
    target: { kind: 'seq', seq: 53 },
    reason: '调用未闭合',
    release: { kind: 'on-pairing', description: '调用与结果重新配对闭合' },
  })])
  const verdict = registry.guard({ rangeStart: 53, rangeEnd: 54, shadowedSeqs: [53, 54], body: '任意正文' })
  assert.equal(verdict.safe, false)
  assert.equal(verdict.entry.strength, 'hard')
})

// ---------------------------------------------------------------------------
// 守卫与规划器的接线：先于副作用，且不跨越受保护节点
// ---------------------------------------------------------------------------

test('the guard rejects before any node id is rented', () => {
  // 4 个操作、B=3、保护 1 个 → 过滤后仍有 3 个合格候选，正好够一批。
  const session = buildSession({ operations: 4, resultChars: 4000 })
  const view = collectOperationCandidates({
    surfaceNodes: session.surface.nodes,
    eventAt: (seq) => session.eventAt(seq),
    measuredNodes: fakeMeter.measure(session).nodes,
    retainOperations: 0,
    openTurn: openTurnOf(session),
    archivedRanges: [],
    minimumChars: MIN_OPERATION_CHARS,
  })
  const blocked = view.candidates[0].rangeStart
  const rented = []
  const plan = planCooling({
    candidates: view.candidates,
    meter: fakeMeter,
    nodeIdFor: (candidate) => {
      rented.push(candidate.rangeStart)
      return `node-${candidate.rangeStart}`
    },
    retainOperations: 0,
    batchSize: 3,
    maxOperations: 64,
    minNetReleaseTokens: 128,
    guard: (candidate) => (candidate.rangeStart === blocked
      ? { safe: false, code: PROTECTION_CODES.PROTECTED, reason: '活跃证据保护：受保护' }
      : { safe: true }),
  })
  assert.equal(rented.includes(blocked), false, '被拒的候选不得留下任何痕迹')
  assert.equal(plan.units.some((unit) => unit.rangeStart === blocked), false)
  assert.ok(plan.rejected.some((row) => row.rangeStart === blocked && row.reason === PROTECTION_CODES.PROTECTED))
  // 其余候选照常成批：过滤后的合格候选仍够 B，就不会因为一段受保护而永久空转。
  assert.equal(plan.admissibleCount, 3, '4 段里保护 1 段，剩下 3 段合格')
  assert.equal(plan.units.length, 3, '批量机制继续工作，不永久空转')
})

test('a protection that appears after planning revokes the unit at commit time', async () => {
  const session = buildSession({ operations: 3, resultChars: 4000 })
  const view = collectOperationCandidates({
    surfaceNodes: session.surface.nodes,
    eventAt: (seq) => session.eventAt(seq),
    measuredNodes: fakeMeter.measure(session).nodes,
    retainOperations: 0,
    openTurn: openTurnOf(session),
    archivedRanges: [],
    minimumChars: MIN_OPERATION_CHARS,
  })
  const plan = planCooling({
    candidates: view.candidates,
    meter: fakeMeter,
    nodeIdFor: (candidate) => `node-${candidate.rangeStart}`,
    retainOperations: 0,
    batchSize: 3,
    maxOperations: 64,
    minNetReleaseTokens: 128,
  })
  assert.equal(plan.units.length, 3, '规划时三段都合格')

  // 规划之后、写入之前出现新保护（用户刚 pin、刚回注、调用刚闭合）。
  const store = new FakeColdStore()
  const revoked = new Set(plan.units.map((unit) => unit.rangeStart))
  const before = session.surface.nodes.length
  const outcomes = await applyOperations({
    session,
    client: store,
    units: plan.units,
    meter: fakeMeter,
    hostVersion: 'test',
    guard: (unit) => (revoked.has(unit.rangeStart)
      ? { safe: false, code: PROTECTION_CODES.PROTECTED, reason: '活跃证据保护：规划后新增' }
      : { safe: true }),
  })

  assert.equal(outcomes.every((row) => row.state === 'guard-revoked'), true, '旧计划必须失效，不能带着过期判定写入')
  assert.equal(session.surface.nodes.length, before, '被撤销的单元原文保留')
  assert.equal(store.writes, 0, '被撤销的单元连冷写都不发生')
})

test('模型自称"任务已完成"不能解除硬保护：终态证据只认工具结果', () => {
  const session = buildSession({ operations: 1, resultChars: 4000 })
  operation({
    session,
    toolName: 'hive_spawn',
    callId: 'call-submit',
    args: '{"identity":"zcode端"}',
    result: pad('已提交：job_id=h_lead_gamma_record_0007（后台执行，不阻塞）'),
    turn: 2,
    step: 1,
  })
  const submitSeq = session.surface.nodes.find((seq) => session.eventAt(seq)?.data?.message?.id === 'm-call-submit')
  assert.ok(submitSeq, '前置：提交那次调用在活动面上')

  // 之后模型在正文里断言这个 job 已经完成 —— 这是模型的陈述，不是宿主状态。
  session.append('assistant/message', {
    turn: 3,
    step: 1,
    message: {
      id: 'a-claim',
      role: 'assistant',
      content: [{ type: 'text', text: 'h_lead_gamma_record_0007 已完成，退出码 0。' }],
    },
  }, { surfaceOp: 'append' })
  // 之后还有一段无关操作，确保"之后"确实存在别的事件。
  operation({ session, toolName: 'read', callId: 'call-tail', args: '{"file":"x"}', result: pad('无关内容'), turn: 4, step: 1 })

  const view = viewOf(session, { retainOperations: 1 })
  const entries = collectStructuralProtections({
    view,
    surfaceNodes: session.surface.nodes,
    eventAt: (seq) => session.eventAt(seq),
  })
  const job = entries.find((entry) => entry.source === PROTECTION_SOURCE.BACKGROUND_JOB)
  assert.ok(job, '模型自称完成不能解除：job 仍受硬保护')
  assert.equal(job.target.rangeStart, submitSeq, '保护范围锚在提交那次调用上')

  // 对照：宿主的工具结果报告终态时，同一保护才解除。
  operation({ session, toolName: 'hive_poll', callId: 'call-poll', args: '{"job_id":"h_lead_gamma_record_0007"}', result: pad('h_lead_gamma_record_0007 已完成，退出码 0'), turn: 5, step: 1 })
  const after = collectStructuralProtections({
    view: viewOf(session, { retainOperations: 1 }),
    surfaceNodes: session.surface.nodes,
    eventAt: (seq) => session.eventAt(seq),
  })
  assert.equal(after.some((entry) => entry.source === PROTECTION_SOURCE.BACKGROUND_JOB), false, '宿主给出终态后解除')
})

test('a non-contiguous protected node is never crossed by a range replacement', () => {
  const session = buildSession({ operations: 4, resultChars: 4000 })
  const view = collectOperationCandidates({
    surfaceNodes: session.surface.nodes,
    eventAt: (seq) => session.eventAt(seq),
    measuredNodes: fakeMeter.measure(session).nodes,
    retainOperations: 0,
    openTurn: openTurnOf(session),
    archivedRanges: [],
    minimumChars: MIN_OPERATION_CHARS,
  })
  const middle = view.candidates[1]
  const registry = registryFor()
  registry.setHard([makeEntry({
    source: PROTECTION_SOURCE.STRUCTURE,
    strength: 'hard',
    target: { kind: 'seq', seq: middle.rangeStart },
    reason: '中间这段调用未闭合',
    release: { kind: 'on-pairing', description: '调用与结果重新配对闭合' },
  })])

  // 受保护节点落在候选覆盖范围里（而不是候选起点）时，同样必须拦下。
  const crossing = registry.guard({
    rangeStart: middle.rangeStart - 1,
    rangeEnd: middle.rangeEnd,
    shadowedSeqs: [middle.rangeStart - 1, middle.rangeStart, middle.rangeEnd],
    body: '把中间那段一起吞掉的更大范围',
  })
  assert.equal(crossing.safe, false)
  assert.equal(crossing.code, PROTECTION_CODES.OVERLAP)

  // 真实批量里：中间受保护，前后两段仍可归档，且绝不为凑批量跨越它。
  const plan = planCooling({
    candidates: view.candidates,
    meter: fakeMeter,
    nodeIdFor: (candidate) => `node-${candidate.rangeStart}`,
    retainOperations: 0,
    batchSize: 2,
    maxOperations: 64,
    minNetReleaseTokens: 128,
    guard: (candidate) => registry.guard(candidate),
  })
  assert.equal(plan.units.some((unit) => unit.rangeStart === middle.rangeStart), false)
  assert.equal(plan.units.length, 2, '不为凑批量而跨越受保护节点')
  for (const unit of plan.units) {
    assert.equal(unit.shadowedSeqs.includes(middle.rangeStart), false, '受保护节点不被任何提交范围覆盖')
  }
})

test('an over-budget protection set keeps every hard protection and reports the cost', () => {
  const registry = registryFor({ budgetTokens: 500 })
  registry.setHard([
    makeEntry({
      source: PROTECTION_SOURCE.BACKGROUND_JOB,
      strength: 'hard',
      target: { kind: 'range', rangeStart: 61, rangeEnd: 62, seq: 61 },
      reason: '后台 job 尚无终态',
      release: { kind: 'on-evidence', description: '出现终态结果' },
      costTokens: 4000,
    }),
    makeEntry({
      source: PROTECTION_SOURCE.STRUCTURE,
      strength: 'hard',
      target: { kind: 'seq', seq: 63 },
      reason: '调用未闭合',
      release: { kind: 'on-pairing', description: '重新配对闭合' },
      costTokens: 3000,
    }),
  ])
  for (let index = 0; index < 4; index += 1) {
    registry.addSoft(makeEntry({
      source: PROTECTION_SOURCE.TASK_LINK,
      strength: 'soft',
      target: { kind: 'range', rangeStart: 70 + index, rangeEnd: 71 + index, seq: 70 + index },
      reason: '弱线索',
      release: { kind: 'after-operations', n: 2, description: '再过 2 个操作' },
      costTokens: 400,
    }))
  }
  const budget = registry.enforceBudget()
  assert.equal(budget.overBudget, true)
  assert.equal(budget.hardTokens, 7000, '硬保护成本如实报告')
  assert.equal(registry.hard.length, 2, '超预算不丢硬保护')
  assert.equal(registry.softCount(), 1, '软保护被降级到预算之内')
  assert.ok(budget.softTokens <= 500)
  const report = registry.report()
  assert.ok(report.lines.some((line) => line.includes('硬保护一段未动')))
  // 硬保护仍然拦截：预算降级不是解除硬保护的授权。
  assert.equal(registry.guard({ rangeStart: 61, rangeEnd: 62, shadowedSeqs: [61, 62], body: 'x' }).safe, false)
})

// ---------------------------------------------------------------------------
// 可观测性
// ---------------------------------------------------------------------------

test('the report explains why a segment is kept, when it clears, and what it costs', () => {
  const registry = registryFor({ budgetTokens: 1024 })
  registry.setHard([makeEntry({
    source: PROTECTION_SOURCE.EXPOSURE,
    strength: 'hard',
    target: { kind: 'seq', seq: 71 },
    reason: '结果尚未被后续助手消息确认曝光',
    release: { kind: 'next-assistant-message', description: '下一次助手消息产生（证据进入主模型请求）' },
    costTokens: 1500,
  })])
  registry.addSoft(makeEntry({
    source: PROTECTION_SOURCE.RECALL,
    strength: 'soft',
    target: { kind: 'range', rangeStart: 73, rangeEnd: 74, seq: 73 },
    reason: '冷记录刚被召回注入',
    release: { kind: 'after-operations', n: 3, description: '再过 3 个操作' },
    costTokens: 300,
  }))
  const report = registry.report()
  assert.equal(report.hardCount, 1)
  assert.equal(report.softCount, 1)
  assert.equal(report.hardTokens, 1500)
  assert.ok(report.lines[0].includes('硬保护 1 段'))
  assert.ok(report.lines.some((line) => line.includes('[硬/曝光证据]') && line.includes('seq 71') && line.includes('解除：下一次助手消息产生')))
  assert.ok(report.lines.some((line) => line.includes('[软/召回临时保护]') && line.includes('解除：再过 3 个操作')))
})

test('occupancyLines renders protection reasons and the batch held back by them', async () => {
  const { occupancyLines } = await import('../src/apply.mjs')
  const lines = occupancyLines({
    host: { provider: 'p', model: 'm', contextWindow: 100000, assembledTokens: 1000, baselineKind: 'estimated' },
    view: { candidates: [], skipped: [] },
    plan: {
      units: [],
      rejected: [{ rangeStart: 9, reason: PROTECTION_CODES.PROTECTED, description: '活跃证据保护（后台任务引用）：job 尚无终态' }],
      plannedReleaseTokens: 0,
      baselineRetention: 4,
      outOfWindowCount: 1,
      baselineReady: false,
      batchSize: 5,
      baselineUnits: 0,
      archivedFromOpenTurn: 0,
    },
    protectionLines: ['活跃证据保护：硬保护 1 段（≈900 token，不可被预算解除）／软保留 0 段（≈0 token，预算 32768 token）'],
    archivedCount: 0,
    cacheStats: null,
  })
  const text = lines.join('\n')
  assert.ok(text.includes('活跃证据保护：硬保护 1 段'))
  assert.ok(text.includes('被活跃证据保护挡下'))
  assert.ok(text.includes('未为凑批量而跨越受保护节点'))
  assert.ok(text.includes('seq 9'))
})
