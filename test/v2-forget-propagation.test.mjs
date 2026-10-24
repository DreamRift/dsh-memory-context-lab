/**
 * P0-1（beta.9）遗忘传播回归：forget 一个来源记录时，依赖它的派生记录
 * （fork 摘要等）必须一并进可见性账本，检索命中面不得再出现它们。
 *
 * 缺陷形态（beta.8 树）：provenance-index 的 propagateInvalidations 在 src 内
 * 零调用（仅测试消费），applyForget 只写显式目标——forget(A) 后 B/B' 仍可被
 * searchRecords 命中（读面闸门只查记录自身 id）。
 *
 * 判据（beta.9 任务书 P0-1 验收）：
 * ① 注册 A→B→B' 派生链，forget(A) 后 B/B' 并入同一条 forget 条目，undo 一次
 *   还原全级联；
 * ② searchRecords 命不到 B/B'；
 * ③ 非记录级派生 id（index-doc: 前缀）不进可见性账本；
 * ④ 来源图缺席/损坏失败关闭：只忘显式目标，不冒充「没有级联」；
 * ⑤ 有界 BFS 截断如实报告：未遍历到的派生记录不并入，回执披露截断。
 * 全部使用临时隔离目录，不依赖宿主与灵枢。
 */
import assert from 'node:assert/strict'
import { appendFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { V2SessionStore } from '../src/v2/store.mjs'
import { draftRecord, RECORD_KINDS } from '../src/v2/records.mjs'
import { ensureLabRoot } from '../src/storage.mjs'
import { searchRecords } from '../src/v2/retrieval.mjs'
import {
  applyForget,
  applyUndo,
  buildForgetPreview,
  getForgetIndex,
} from '../src/v2/disposition.mjs'
import {
  PROVENANCE_EDGE,
  PROVENANCE_HEADER_KIND,
  PROVENANCE_SCHEMA_VERSION,
  provenancePath,
  registerProvenanceEdge,
} from '../src/v2/provenance-index.mjs'
import { describeForgetPropagation } from '../src/v2/runtime-forget.mjs'

const tmpRoots = []

async function makeRoot(name) {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-forget-prop-'))
  tmpRoots.push(root)
  await ensureLabRoot(root)
  return root
}

test.after(async () => {
  await Promise.all(tmpRoots.map((root) => rm(root, { recursive: true, force: true })))
})

/** 元数据 haystack 匹配（与 v2-retrieval-contract 同款简化口径）。 */
function literalMatcher(entry, needle) {
  const hay = [entry.id, entry.kind, entry.refs?.callId ?? '', entry.inline?.nodeId ?? ''].join(' ').toLowerCase()
  return hay.includes(String(needle).toLowerCase())
}

async function seedRecords(root, sessionId, texts) {
  const store = await V2SessionStore.init({ labRoot: root, sessionId })
  try {
    const txn = await store.openTransaction()
    const ids = []
    for (const [index, text] of texts.entries()) {
      const staged = await store.stageRecord(txn, draftRecord({
        kind: RECORD_KINDS.OPERATION_RESULT,
        seq: index + 1,
        fidelity: 'verbatim',
        refs: { callId: 'call-' + (index + 1), resultMessageId: 'm' + (index + 1) },
        inline: { nodeId: 'mcl2-fp-' + (index + 1) },
        content: text,
      }))
      ids.push(staged.id)
    }
    await store.commitTransaction(txn)
    return { ids, directory: store.directory }
  } finally {
    store.close()
  }
}

async function searchAll(root, sessionId, { forgetIndex = null } = {}) {
  const store = await V2SessionStore.open({ labRoot: root, sessionId, readOnly: true })
  try {
    const found = await searchRecords({ store, backend: null, text: 'mcl2-fp', limit: 10, literalMatcher, forgetIndex })
    return found.records.map((record) => record.id)
  } finally {
    store.close()
  }
}

test('P0-1 验收：forget(A) 后派生链 B/B\' 并入同一条 forget 条目，检索命中不到', async () => {
  const root = await makeRoot('chain')
  const { ids: [idA, idB, idC], directory } = await seedRecords(root, 'session-fp-chain-01', [
    'mcl2-fp 源记录 A',
    'mcl2-fp 派生摘要 B（fork 自 A）',
    'mcl2-fp 派生摘要 B2（fork 自 B）',
  ])
  await registerProvenanceEdge({ sessionDir: directory, derivedId: idB, derivedKind: 'fork-summary', sourceIds: [idA] })
  await registerProvenanceEdge({ sessionDir: directory, derivedId: idC, derivedKind: 'fork-summary', sourceIds: [idB] })
  // 非记录级派生物：index-doc 旁支的 derivedId 不是 store 记录 id，不得进可见性账本。
  await registerProvenanceEdge({ sessionDir: directory, derivedId: 'index-doc:' + idA, derivedKind: 'retrieval-index', sourceIds: [idA] })

  // 好样本对照：遗忘前三个记录都可被同一查询命中（证明命中面真实存在）。
  assert.deepEqual((await searchAll(root, 'session-fp-chain-01')).sort(), [idA, idB, idC].sort())

  const knownRecordIds = new Set([idA, idB, idC])
  const result = await applyForget({
    sessionDir: directory,
    targetIds: [idA],
    actor: 'user',
    reason: 'test',
    expectedRevision: null,
    knownRecordIds,
  })
  assert.equal(result.appended, true)

  // 传播报告：B/B' 并入，index-doc 旁支不并入。
  assert.equal(result.propagation.state, 'ok')
  assert.ok(result.propagation.recordIds.includes(idB), '派生记录 B 应并入')
  assert.ok(result.propagation.recordIds.includes(idC), '派生记录 B\' 应并入')
  assert.ok(!result.propagation.recordIds.includes('index-doc:' + idA), 'index-doc 旁支不得并入')
  assert.equal(result.propagation.truncated, false)

  // 同一条目：undo 一次即可还原全级联。
  assert.deepEqual([...result.entry.targetIds].sort(), [idA, idB, idC].sort())
  assert.deepEqual([...result.entry.propagatedIds].sort(), [idB, idC].sort())

  // 可见性账本里只有记录级 id。
  const forgetIndex = await getForgetIndex(directory)
  assert.equal(forgetIndex.forgotten.has(idA), true)
  assert.equal(forgetIndex.forgotten.has(idB), true)
  assert.equal(forgetIndex.forgotten.has(idC), true)
  for (const key of forgetIndex.forgotten.keys()) {
    assert.ok(!String(key).startsWith('index-doc:'), '非记录 id 不得进可见性账本：' + key)
  }

  // 验收判据：forget(A) 后 searchRecords 命不到 B/B'（也命不到 A）。
  assert.deepEqual(await searchAll(root, 'session-fp-chain-01', { forgetIndex }), [])
})

test('P0-1：undo 一次还原全级联', async () => {
  const root = await makeRoot('undo')
  const { ids: [idA, idB], directory } = await seedRecords(root, 'session-fp-undo-01', [
    'mcl2-fp 源记录 A',
    'mcl2-fp 派生摘要 B',
  ])
  await registerProvenanceEdge({ sessionDir: directory, derivedId: idB, derivedKind: 'fork-summary', sourceIds: [idA] })
  const result = await applyForget({
    sessionDir: directory,
    targetIds: [idA],
    actor: 'user',
    reason: 'test',
    knownRecordIds: new Set([idA, idB]),
  })
  assert.equal(result.appended, true)
  const undone = await applyUndo({ sessionDir: directory, operationId: result.entry.operationId, actor: 'user', reason: 'test' })
  // 全级联恢复：restoredIds 同时包含显式目标与传播目标。
  assert.deepEqual([...undone.restoredIds].sort(), [idA, idB].sort())
  const forgetIndex = await getForgetIndex(directory)
  assert.equal(forgetIndex.forgotten.has(idA), false)
  assert.equal(forgetIndex.forgotten.has(idB), false)
  assert.deepEqual((await searchAll(root, 'session-fp-undo-01', { forgetIndex })).sort(), [idA, idB].sort())
})

test('P0-1：来源图缺席 → 失败关闭，只忘显式目标并披露未传播', async () => {
  const root = await makeRoot('absent')
  const { ids: [idA], directory } = await seedRecords(root, 'session-fp-absent-01', [
    'mcl2-fp 孤立记录 A',
  ])
  const result = await applyForget({
    sessionDir: directory,
    targetIds: [idA],
    actor: 'user',
    reason: 'test',
    knownRecordIds: new Set([idA]),
  })
  assert.equal(result.appended, true)
  assert.equal(result.propagation.state, 'absent')
  assert.deepEqual(result.entry.targetIds, [idA])
  assert.equal(result.entry.propagatedIds, undefined)
  const lines = describeForgetPropagation(result.propagation)
  assert.equal(lines.length, 1)
  assert.ok(lines[0].includes('未传播'), '缺席态必须披露未传播：' + lines[0])
})

test('P0-1：来源图损坏 → 失败关闭，只忘显式目标', async () => {
  const root = await makeRoot('damaged')
  const { ids: [idA, idB], directory } = await seedRecords(root, 'session-fp-damaged-01', [
    'mcl2-fp 源记录 A',
    'mcl2-fp 派生摘要 B',
  ])
  await registerProvenanceEdge({ sessionDir: directory, derivedId: idB, derivedKind: 'fork-summary', sourceIds: [idA] })
  // 中部损坏（后面还有完整行，不属于可修复的尾部半行）。
  const corruptMiddle = JSON.stringify({ kind: PROVENANCE_EDGE, derivedId: 'broken' }) + '{corrupt\n'
  const validTail = JSON.stringify({
    kind: PROVENANCE_EDGE,
    derivedId: 'tail-edge',
    derivedKind: 'retrieval-index',
    sourceIds: [idA],
    registeredAt: new Date().toISOString(),
  }) + '\n'
  await appendFile(provenancePath(directory), corruptMiddle + validTail, 'utf8')

  const result = await applyForget({
    sessionDir: directory,
    targetIds: [idA],
    actor: 'user',
    reason: 'test',
    knownRecordIds: new Set([idA, idB]),
  })
  assert.equal(result.appended, true)
  assert.equal(result.propagation.state, 'damaged')
  assert.deepEqual(result.entry.targetIds, [idA])
  const lines = describeForgetPropagation(result.propagation)
  assert.ok(lines.some((line) => line.includes('损坏')), '损坏态必须如实披露：' + JSON.stringify(lines))
})

test('P0-1：有界 BFS 截断如实报告——未遍历的派生记录不并入', async () => {
  const root = await makeRoot('truncated')
  const { ids: [idA], directory } = await seedRecords(root, 'session-fp-truncated-01', [
    'mcl2-fp 源记录 A',
  ])
  // 10 层派生链 d1←A、d2←d1、…：BFS 深度上限 8，d9/d10 不可达 → truncated。
  // 逐条注册（批量 registerProvenanceEdges 对「派生 id 又是批内来源」的链会误判
  // 成环——既有缺陷，另行记录，不在本批夹带修复）。
  // 合成 id 用合法记录 ID 形态（compareRecordIds 排序时会校验格式）。
  const chainIds = Array.from({ length: 10 }, (_, i) => 't00000002-r' + String(i + 1).padStart(4, '0'))
  for (const [index, derivedId] of chainIds.entries()) {
    await registerProvenanceEdge({
      sessionDir: directory,
      derivedId,
      derivedKind: 'fork-summary',
      sourceIds: [index === 0 ? idA : chainIds[index - 1]],
    })
  }
  const knownRecordIds = new Set([idA, ...chainIds])
  const result = await applyForget({
    sessionDir: directory,
    targetIds: [idA],
    actor: 'user',
    reason: 'test',
    knownRecordIds,
  })
  assert.equal(result.appended, true)
  assert.equal(result.propagation.state, 'ok')
  assert.equal(result.propagation.truncated, true, '超过深度上限必须如实报截断')
  for (let i = 0; i < 8; i += 1) {
    assert.ok(result.propagation.recordIds.includes(chainIds[i]), '可达层应并入：' + chainIds[i])
  }
  assert.ok(!result.propagation.recordIds.includes(chainIds[8]), '未遍历的 d9 不得并入')
  assert.ok(!result.propagation.recordIds.includes(chainIds[9]), '未遍历的 d10 不得并入')
  assert.ok(!result.entry.targetIds.includes(chainIds[9]))
  const lines = describeForgetPropagation(result.propagation)
  assert.ok(lines.some((line) => line.includes('截断')), '截断必须披露：' + JSON.stringify(lines))
})

test('P0-1：幂等重放不重复传播', async () => {
  const root = await makeRoot('idempotent')
  const { ids: [idA, idB], directory } = await seedRecords(root, 'session-fp-idem-01', [
    'mcl2-fp 源记录 A',
    'mcl2-fp 派生摘要 B',
  ])
  await registerProvenanceEdge({ sessionDir: directory, derivedId: idB, derivedKind: 'fork-summary', sourceIds: [idA] })
  const knownRecordIds = new Set([idA, idB])
  const first = await applyForget({ sessionDir: directory, targetIds: [idA], actor: 'user', reason: 'test', knownRecordIds })
  assert.equal(first.appended, true)
  const second = await applyForget({ sessionDir: directory, targetIds: [idA], actor: 'user', reason: 'test', knownRecordIds })
  assert.equal(second.appended, false)
  assert.equal(second.propagation, null)
  assert.equal(second.entry, null)
})

test('describeForgetPropagation：四态披露口径', () => {
  assert.deepEqual(describeForgetPropagation(null), [])
  assert.deepEqual(describeForgetPropagation({ state: 'absent' }).length, 1)
  assert.ok(describeForgetPropagation({ state: 'absent' })[0].includes('未传播'))
  assert.ok(describeForgetPropagation({ state: 'damaged' })[0].includes('损坏'))
  assert.deepEqual(describeForgetPropagation({ state: 'ok', recordIds: [], truncated: false, layers: 0 }), [])
  const okLines = describeForgetPropagation({ state: 'ok', recordIds: ['x', 'y'], truncated: false, layers: 2 })
  assert.equal(okLines.length, 1)
  assert.ok(okLines[0].includes('2 条'), '并入条数必须披露：' + okLines[0])
  const truncLines = describeForgetPropagation({ state: 'ok', recordIds: ['x'], truncated: true, layers: 8, maxNodes: 512, maxDepth: 8 })
  assert.equal(truncLines.length, 2)
  assert.ok(truncLines[1].includes('截断'))
})

test('P0-4 接线：forget preview 报告来源图级联影响（dependentsOf）', async () => {
  const root = await makeRoot('preview-cascade')
  const { ids: [idA, idB, idC], directory } = await seedRecords(root, 'session-fp-pvc-01', [
    'mcl2-fp 源记录 A',
    'mcl2-fp 派生摘要 B',
    'mcl2-fp 派生摘要 B2',
  ])
  await registerProvenanceEdge({ sessionDir: directory, derivedId: idB, derivedKind: 'fork-summary', sourceIds: [idA] })
  await registerProvenanceEdge({ sessionDir: directory, derivedId: idC, derivedKind: 'fork-summary', sourceIds: [idB] })
  const entries = await (async () => {
    const store = await V2SessionStore.open({ labRoot: root, sessionId: 'session-fp-pvc-01', readOnly: true })
    try { return store.listEntries({ limit: 100 }).entries } finally { store.close() }
  })()
  const preview = await buildForgetPreview({ sessionDir: directory, targets: [idA], entries })
  assert.equal(preview.cascade.state, 'ok')
  const depIds = preview.cascade.dependents.map((item) => item.derivedId)
  assert.ok(depIds.includes(idB), 'B 应出现在级联报告：' + JSON.stringify(depIds))
  assert.ok(depIds.includes(idC), 'B2 应出现在级联报告：' + JSON.stringify(depIds))
})
