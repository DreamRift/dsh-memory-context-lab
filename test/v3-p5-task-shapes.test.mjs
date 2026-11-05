import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { buildWarmSummaryReference } from '../src/v3/domain/compress/warm/summary-reference.mjs'
import { compileContext } from '../src/v3/domain/compiler/context-compiler.mjs'
import { planRecall } from '../src/v3/domain/recall/planner.mjs'

const rid = (n) => 'v3r-' + n.toString(16).padStart(16, '0')
function warmInput({ count = 1, budget = 240, sessionKey = 's-1', nodeSessionKey = sessionKey, candidateSessionKey = sessionKey, text = '短句。' } = {}) {
  const activeSurfaceNodes = Array.from({ length: count }, (_, i) => ({ seq: i, eventId: 'e' + i, text: typeof text === 'function' ? text(i) : text, recordId: rid(i + 1), sessionKey: nodeSessionKey }))
  return { sessionKey, activeSurfaceNodes, archiveCandidate: { startSeq: 0, endSeq: count - 1, sourceEventSeqs: activeSurfaceNodes.map(n => n.seq), recordIds: activeSurfaceNodes.map(n => n.recordId), sessionKey: candidateSessionKey }, summaryBudgetCodePoints: budget }
}
function compilerInput(count = 8) {
  const nodes = Array.from({ length: count }, (_, i) => ({ seq: i, recordId: rid(i + 1000), bytes: 'b' + i }))
  const parts = ['R0', 'R1', 'R2', 'R3'].map((key, p) => ({ key, nodeIndexes: nodes.map((_, i) => i).filter(i => i % 4 === p) }))
  return { surface: { nodes, partition: parts }, receipts: [], toolPairs: [], pins: [], plan: { planFloorSeq: 0, artifactSeqs: [] }, protection: { protectedSeqs: [], completeness: { status: 'ok', missingSources: [] } }, budget: { scannedCount: Math.min(count, 200), limit: 200 } }
}
function recallInput(candidates = [], patch = {}) {
  return { query: 'q', sessionId: 's-a', generation: 2, completeness: 'ok', complete: true, truncated: false, candidateLimit: 10, maxCodePoints: 10000, candidates, followUpHandle: null, ...patch }
}
function candidate(id, patch = {}) {
  return { id, kind: 'record', relation: 'evidence', text: id, confidence: 0.9, generation: 2, sessionId: 's-a', sourceVerified: true, permissionVerified: true, forgotten: false, ...patch }
}

describe('G1 短文本', () => {
  test('Warm 无损且不填充；1 码点预算进入 partial 边界', () => {
    const result = buildWarmSummaryReference(warmInput())
    assert.equal(result.status, 'ok') // 预算充足时应保持完整状态，状态错即红。
    assert.equal(result.capped, false) // 短文本不应触发截断。
    assert.equal(result.shortText, '短句。') // 原文必须逐字保留，不得补填。
    assert.equal(result.detail, result.shortText) // 输出摘要与详情当前应完全一致。
    assert.equal(result.omittedAfterSeq, null) // 未截断时不能伪报遗漏位置。
    assert.equal(result.omittedRefs, 0) // 唯一引用不得被遗漏。
    assert.equal(result.sources.length, 1) // 来源凭证必须保留。
    const tiny = buildWarmSummaryReference(warmInput({ budget: 1 }))
    assert.equal(tiny.status, 'partial') // 预算压到 1 必须跨过 ok/partial 边界。
    assert.equal(tiny.capped, true) // 同时必须明确报告截断。
  })
})

describe('G2 长文本', () => {
  test('G2a Warm 预算截断；G2b detail 4000 上限守卫不可达（死代码锁定）', () => {
    const long = buildWarmSummaryReference(warmInput({ count: 300, budget: 240, text: () => '甲乙丙丁戊己庚辛壬。' }))
    assert.equal(long.capped, true) // 300 句超出 240 码点预算必须截断。
    assert.equal(long.status, 'partial') // 被截断摘要不得标为完整。
    assert.ok([...long.shortText].length <= 240) // P2 shortText 上限不可被越过。
    assert.notEqual(long.omittedAfterSeq, null) // 截断必须留下最后选中来源序号。
    const detail = buildWarmSummaryReference(warmInput({ count: 300, budget: 1000000, text: () => '甲乙丙丁戊己庚辛壬。' }))
    assert.equal(detail.status, 'partial') // 240 码点短文本上限先截断，不能伪称触发 detail failed。
    assert.equal(detail.capped, true) // 预算的有效上限仍是 240。
    assert.equal(detail.detail, detail.shortText) // 两字段源自同一 summary 变量。
    assert.ok([...detail.detail].length <= 240) // detail 当前不可能越过 shortText 上限。
    // :145 的 P2_DETAIL_LIMIT fail-closed 在当前实现上不可达；本条不是验证它生效，而是锁定「它不生效」这一事实，防止将来有人以为它被覆盖了。
  })
  test('G2c Warm >200 引用截断', () => {
    const result = buildWarmSummaryReference(warmInput({ count: 201, budget: 1000000, text: () => '逐项来源。' }))
    assert.equal(result.capped, true) // 超过来源上限必须报告截断。
    assert.equal(result.status, 'partial') // 引用截断须降低完整性状态。
    assert.equal(result.sources.length, 200) // 来源最多输出 200 项。
    assert.equal(result.evidenceRefs.length, 50) // 证据引用最多输出 50 项。
    assert.equal(result.omittedRefs, 1) // 超出的第 201 项必须计入遗漏数。
  })
  test('G2d Compiler H=200 截断', () => {
    const input = compilerInput(250)
    const result = compileContext(input)
    assert.equal(result.completeness.truncated, true) // 超过 H 必须标截断。
    assert.equal(result.completeness.omittedCount, 50) // 250 扣除 200 应遗漏 50。
    assert.equal(result.completeness.scannedCount, 200) // 实际扫描量不得超过 H。
    assert.equal(result.completeness.status, 'partial') // 截断输出必须是不完整态。
    assert.ok(result.completeness.missingSources.includes('surface.nodes beyond H limit')) // 遗漏来源需明示。
  })
  test('G2e 超限未扫描硬保护区后置拒绝', () => {
    const input = compilerInput(250)
    input.toolPairs = [{ callId: 'late', callSeq: 220, resultSeq: null, state: 'unclosed' }]
    input.protection.protectedSeqs = [220]
    assert.throws(() => compileContext(input), { message: 'unscanned hard-protected node; refusing partial draft' }) // H 外硬保护节点必须精确拒绝部分草案。
  })
})

describe('G3 工具密集', () => {
  function toolsFixture() {
    const input = compilerInput(32)
    input.toolPairs = Array.from({ length: 12 }, (_, i) => {
      const callSeq = i * 2
      if (i < 8) return { callId: 'call-' + i, callSeq, resultSeq: callSeq + 1, state: 'closed' }
      if (i < 10) return { callId: 'call-' + i, callSeq, resultSeq: null, state: 'unclosed' }
      return { callId: 'call-' + i, callSeq, resultSeq: null, state: 'unknown' }
    })
    input.protection.protectedSeqs = [16, 18, 20, 22]
    return input
  }
  test('12 对工具的保护、三态校验及 closed 反向保护', () => {
    const base = toolsFixture()
    const missing = structuredClone(base); missing.protection.protectedSeqs = [18, 20, 22]
    assert.throws(() => compileContext(missing), { message: 'unclosed/unknown pair missing protection' }) // 未闭合 pair 漏保护必须拒绝。
    for (const pair of [{ callId: 'bad', callSeq: 16, resultSeq: null, state: 'closed' }, { callId: 'bad', callSeq: 16, resultSeq: 17, state: 'unclosed' }]) {
      const input = toolsFixture(); input.toolPairs[8] = pair
      assert.throws(() => compileContext(input), { message: 'tool state/result mismatch' }) // state 与 resultSeq 不一致必须拒绝。
    }
    const duplicate = toolsFixture(); duplicate.toolPairs[1].callId = duplicate.toolPairs[0].callId
    assert.throws(() => compileContext(duplicate), { message: 'duplicate or unordered tool pair' }) // 重复 callId 不可静默接受。
    const invalidResult = toolsFixture(); invalidResult.toolPairs[0].resultSeq = 0
    assert.throws(() => compileContext(invalidResult), { message: 'invalid resultSeq' }) // result 不晚于 call 必须拒绝。
    const closedUnprotected = toolsFixture(); closedUnprotected.protection.protectedSeqs = [16, 18, 20, 22]
    assert.doesNotThrow(() => compileContext(closedUnprotected)) // closed 对不属于硬保护集，漏列其 seq 仍应成功。
  })
})

describe('G4 否定更正', () => {
  test('supersedes 投影保留、旧值现状与 forgotten 唯一淘汰通道', () => {
    const old = candidate('c-old', { text: '旧值 42' })
    const newer = candidate('c-new', { relation: 'supersedes', text: '新值 43' })
    const corrected = planRecall(recallInput([old, newer]))
    assert.ok(corrected.selected.some(x => x.id === 'c-new')) // 更正候选必须进入选择结果。
    assert.equal(corrected.citations.find(x => x.id === 'c-new').relation, 'supersedes') // 更正关系必须原样保留。
    // planner 不做旧值淘汰，否定/更正的方向与时序由上游保证；本断言锁定当前语义，防止将来静默改变而不被发现。
    assert.deepEqual(new Set(corrected.selected.map(x => x.id)), new Set(['c-old', 'c-new'])) // 当前旧值仍返回，关系方向由上游处理。
    const forgotten = planRecall(recallInput([old, { ...newer, forgotten: true }]))
    assert.ok(!forgotten.selected.some(x => x.id === 'c-new')) // forgotten 项必须被淘汰。
    assert.equal(forgotten.status, 'partial') // 被过滤候选须标示结果被截断/不完整。
  })
})

describe('G5 跨轮来源', () => {
  test('relationRank、handle 代际与引用投影完整性', () => {
    const adjacent = candidate('a-adjacent', { relation: 'adjacent' })
    const source = candidate('z-source', { relation: 'source' })
    const evidence = candidate('m-evidence', { relation: 'evidence' })
    const sorted = planRecall(recallInput([adjacent, evidence, source], { followUpHandle: { cursor: 'c1', generation: 2 } }))
    assert.deepEqual(sorted.selected.map(x => x.relation), ['evidence', 'source', 'adjacent']) // source/evidence 优先于 adjacent；同级依 id 稳定排序。
    const cross = planRecall(recallInput([source], { followUpHandle: { cursor: 'c1', generation: 3 } }))
    assert.equal(cross.status, 'unknown') // 跨代句柄不能给出可用结果。
    assert.deepEqual(cross.selected, []) // 跨代句柄应拒绝候选选择。
    assert.deepEqual(cross.citations, []) // 拒绝时不得留下引用投影。
    assert.equal(cross.followUp, null) // 跨代游标必须清空。
    const same = planRecall(recallInput([source], { followUpHandle: { cursor: 'c1', generation: 2 } }))
    assert.deepEqual(same.followUp, { cursor: 'c1', generation: 2 }) // 同代句柄应精确保留。
    assert.equal(same.citations.length, same.selected.length) // 每个 selected 均须恰有一条 citation。
    for (let i = 0; i < same.citations.length; i++) {
      assert.deepEqual(Object.keys(same.citations[i]).sort(), ['generation', 'id', 'kind', 'relation']) // 引用字段严格闭合。
      assert.deepEqual(same.citations[i], { id: same.selected[i].id, kind: same.selected[i].kind, relation: same.selected[i].relation, generation: same.selected[i].generation }) // 身份投影逐项同源。
    }
  })
})

describe('G6 多任务隔离', () => {
  test('Recall 会话过滤状态与 Warm 会话冲突', () => {
    const foreign = candidate('foreign', { sessionId: 's-b', confidence: 0.99, relation: 'source' })
    const local = candidate('local', { confidence: 0.5, relation: 'adjacent' })
    const mixed = planRecall(recallInput([foreign, local]))
    assert.ok(!mixed.selected.some(x => x.id === 'foreign')) // 外来会话候选不得串入。
    assert.ok(mixed.selected.some(x => x.id === 'local')) // 本地候选仍须正常选择。
    const onlyForeign = planRecall(recallInput([foreign]))
    assert.equal(onlyForeign.status, 'unknown') // 过滤外来候选不等于证明真实无结果；移除 rejectedUnknown=cut 会变 unavailable。
    assert.notEqual(onlyForeign.status, 'unavailable') // 明确防止将过滤误报为 EOF。
    assert.equal(mixed.status, 'partial') // 有本地结果但有被过滤外来项须标 partial。
    assert.equal(buildWarmSummaryReference(warmInput({ sessionKey: 's-a', nodeSessionKey: 's-b' })).status, 'conflict') // 活动面会话冲突必须失败关闭。
    assert.equal(buildWarmSummaryReference(warmInput({ sessionKey: 's-a', candidateSessionKey: 's-b' })).status, 'conflict') // 候选归属冲突必须失败关闭。
  })
})

describe('G7 稳定前缀', () => {
  test('确定性、R3 变更不扰动 R0-R2、指纹明确未知', () => {
    const input = compilerInput(12)
    const first = compileContext(input)
    const second = compileContext(input)
    assert.equal(JSON.stringify(first), JSON.stringify(second)) // 相同快照必须字节级序列化一致。
    const changed = structuredClone(input); changed.surface.nodes[11].bytes = 'changed-R3'
    const after = compileContext(changed)
    assert.deepEqual(after.draft.filter(x => x.partitionKey !== 'R3'), first.draft.filter(x => x.partitionKey !== 'R3')) // R3 改动不得触碰 R0-R2 draft。
    assert.deepEqual(first.fingerprints, ['R0', 'R1', 'R2', 'R3'].map(partitionKey => ({ partitionKey, value: null }))) // 未冻结指纹必须全部 null。
    assert.deepEqual(first.diagnostics, ['R0', 'R1', 'R2', 'R3'].map(partitionKey => ({ partitionKey, status: 'unknown', change: 'unknown' }))) // 诊断不得暗示缓存命中。
  })
})

describe('G8 任务结束边界', () => {
  test('Recall EOF 证明、未完成状态与 Compiler 完整性自洽', () => {
    assert.equal(planRecall(recallInput([])).status, 'unavailable') // 空候选且完整性证明为 ok 才是 EOF。
    assert.equal(planRecall(recallInput([], { complete: false })).status, 'unknown') // 未证明完成不得当成 EOF。
    assert.equal(planRecall(recallInput([], { completeness: 'partial' })).status, 'unknown') // 完整性不足不得当成 EOF。
    const withResult = planRecall(recallInput([candidate('one')], { complete: false }))
    assert.equal(withResult.status, 'partial') // 不完整但有候选只能返回 partial。
    assert.equal(withResult.complete, false) // 结果不能伪造完成证明。
    const mismatch = compilerInput(4); mismatch.protection.completeness = { status: 'ok', missingSources: ['x'] }
    assert.throws(() => compileContext(mismatch), { message: 'completeness/missingSources mismatch' }) // ok 与非空缺口集合矛盾必须拒绝。
    const unknown = compilerInput(4); unknown.protection.completeness = { status: 'unknown', missingSources: ['x'] }
    assert.equal(compileContext(unknown).completeness.status, 'unknown') // unknown 完整性必须原样传播，不能提升为 ok。
  })
})
