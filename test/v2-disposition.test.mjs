/**
 * v2 主动遗忘（disposition 旁车账本）测试：软遗忘唯一权威、多 cause undo、
 * 幂等、revision CAS、硬保护（在途调用 / 人类用户消息）、别名统一（记录 ID /
 * nodeId / callId / kind= / before= / v1 导入指针）、两段式计划、崩溃注入点①
 * （尾部半行截断修复、中部损坏失败关闭）。全部使用临时隔离目录，不触碰真实
 * $DSH_HOME。
 */
import assert from 'node:assert/strict'
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  DispositionError,
  DISPOSITION_ENTRY_FORGET,
  DISPOSITION_ENTRY_UNDO,
  DISPOSITION_HEADER_KIND,
  DISPOSITION_SCHEMA_VERSION,
  FORGET_PLAN_LIMIT,
  applyForget,
  applyUndo,
  buildForgetPreview,
  canonicalJson,
  canonicalLine,
  computePlanId,
  describeForgetStatus,
  dispositionPath,
  evaluateForgetProtection,
  foldVisibility,
  getForgetIndex,
  getForgetPlan,
  invalidateForgetIndex,
  isForgotten,
  loadDisposition,
  loadForgetPlans,
  resetForgetIndexCache,
  resolveForgetTargets,
  saveForgetPlan,
} from '../src/v2/disposition.mjs'
import { RECORD_KINDS } from '../src/v2/records.mjs'

const tmpRoots = []

async function newSessionDir() {
  const dir = await mkdtemp(path.join(tmpdir(), 'mcl-v2-disposition-'))
  tmpRoots.push(dir)
  return dir
}

test.after(async () => {
  await Promise.all(tmpRoots.map((root) => rm(root, { recursive: true, force: true })))
})

// ---------------------------------------------------------------- 记录条目工厂

function spanEntry(id, nodeId, { spanKind = 'turn.assistant', pluginAuthored, chunk } = {}) {
  return {
    id,
    kind: RECORD_KINDS.PROJECTION_SPAN,
    refs: { spanKind },
    inline: {
      nodeId,
      chunk: chunk ?? 1,
      totalChunks: 2,
      ...(pluginAuthored === undefined ? {} : { pluginAuthored }),
    },
  }
}

function callEntry(id, callId, nodeId) {
  return { id, kind: RECORD_KINDS.OPERATION_CALL, refs: { callId, toolName: 'run_code' }, inline: { nodeId } }
}

function resultEntry(id, callId, nodeId) {
  return { id, kind: RECORD_KINDS.OPERATION_RESULT, refs: { callId }, inline: { nodeId, spanRecordId: 't00000001-r0009' } }
}

function importPointerEntry(id) {
  return {
    id,
    kind: RECORD_KINDS.PROJECTION_SPAN,
    refs: { spanKind: 'v1-archive-import', sourceSeqs: [3] },
    inline: { spanKind: 'v1-archive-import' },
  }
}

async function readJsonl(file) {
  const text = await readFile(file, 'utf8')
  assert.ok(!text.includes('\r'), '账本必须是 LF 行尾')
  return { text, lines: text.split('\n').filter((line) => line.length > 0) }
}

// ---------------------------------------------------------------- 账本基础

test('全新会话：账本不存在 → absent', async () => {
  const dir = await newSessionDir()
  resetForgetIndexCache()
  const ledger = await loadDisposition(dir)
  assert.equal(ledger.state, 'absent')
  assert.equal(ledger.revision, 0)
  assert.equal(ledger.damaged, false)
})

test('applyForget 建账：header + 条目，canonical 行 + LF，键排序', async () => {
  const dir = await newSessionDir()
  resetForgetIndexCache()
  const applied = await applyForget({ sessionDir: dir, targetIds: ['t00000002-r0001'], actor: 'user', reason: '测试' })
  assert.equal(applied.appended, true)
  assert.equal(applied.entry.operationId, 'f000001')
  assert.equal(applied.revision, 1)
  const { text, lines } = await readJsonl(dispositionPath(dir))
  assert.equal(lines.length, 2)
  const header = JSON.parse(lines[0])
  assert.equal(header.kind, DISPOSITION_HEADER_KIND)
  assert.equal(header.schemaVersion, DISPOSITION_SCHEMA_VERSION)
  const entry = JSON.parse(lines[1])
  assert.equal(entry.kind, DISPOSITION_ENTRY_FORGET)
  assert.equal(entry.targetIds.length, 1)
  assert.equal(entry.visibilityRevisionBefore, 0)
  assert.equal(entry.visibilityRevisionAfter, 1)
  // 键排序：canonical 形式的对象键必须升序出现。
  const keys = Object.keys(entry)
  assert.deepEqual(keys, [...keys].sort(), '条目键必须排序')
  assert.ok(text.endsWith('\n'))
  const reloaded = await loadDisposition(dir)
  assert.equal(reloaded.state, 'ok')
  assert.equal(reloaded.revision, 1)
})

test('applyForget：目标排序去重，只写零 cause 记录', async () => {
  const dir = await newSessionDir()
  resetForgetIndexCache()
  const applied = await applyForget({
    sessionDir: dir,
    targetIds: ['t00000002-r0001', 't00000001-r0001', 't00000002-r0001'],
    actor: 'user',
  })
  assert.deepEqual(applied.entry.targetIds, ['t00000001-r0001', 't00000002-r0001'])
})

test('applyForget 幂等：全部已遗忘时不追加条目', async () => {
  const dir = await newSessionDir()
  resetForgetIndexCache()
  await applyForget({ sessionDir: dir, targetIds: ['t00000001-r0001'], actor: 'user' })
  const again = await applyForget({ sessionDir: dir, targetIds: ['t00000001-r0001'], actor: 'user' })
  assert.equal(again.appended, false)
  assert.deepEqual(again.alreadyForgotten, ['t00000001-r0001'])
  assert.equal(again.entry, null)
  const { lines } = await readJsonl(dispositionPath(dir))
  assert.equal(lines.length, 2, '幂等提交不追加任何条目')
})

test('applyForget revision CAS：过期即拒绝', async () => {
  const dir = await newSessionDir()
  resetForgetIndexCache()
  await applyForget({ sessionDir: dir, targetIds: ['t00000001-r0001'], actor: 'user' })
  await assert.rejects(
    applyForget({ sessionDir: dir, targetIds: ['t00000002-r0001'], actor: 'user', expectedRevision: 0 }),
    (error) => error instanceof DispositionError && error.code === 'EREVISION',
  )
  const ok = await applyForget({ sessionDir: dir, targetIds: ['t00000002-r0001'], actor: 'user', expectedRevision: 1 })
  assert.equal(ok.revision, 2)
})

// ---------------------------------------------------------------- 多 cause 与 undo

test('多 cause：undo 只摘自己的 cause，仍有 cause 的记录保持遗忘', async () => {
  // applyForget 是记录级幂等（重复遗忘同一目标不追加 cause），多 cause 状态
  // 由外部合并账本构造（P3 批量通道或 fork 合并的前向兼容路径）。
  const dir = await newSessionDir()
  resetForgetIndexCache()
  const header = canonicalLine({ kind: DISPOSITION_HEADER_KIND, schemaVersion: DISPOSITION_SCHEMA_VERSION })
  const f1 = canonicalLine({
    kind: DISPOSITION_ENTRY_FORGET, operationId: 'f000001', entrySeq: 1, actor: 'user', reason: 'r1',
    targetIds: ['t00000001-r0001', 't00000002-r0001'], undoOf: null,
    visibilityRevisionBefore: 0, visibilityRevisionAfter: 1, at: '2026-10-16T01:00:00.000Z',
  })
  const f2 = canonicalLine({
    kind: DISPOSITION_ENTRY_FORGET, operationId: 'f000002', entrySeq: 2, actor: 'user', reason: 'r2',
    targetIds: ['t00000002-r0001', 't00000003-r0001'], undoOf: null,
    visibilityRevisionBefore: 1, visibilityRevisionAfter: 2, at: '2026-10-16T01:01:00.000Z',
  })
  await appendFile(dispositionPath(dir), [header, f1, f2].join('\n') + '\n', 'utf8')
  let index = await getForgetIndex(dir)
  assert.deepEqual(index.forgotten.get('t00000002-r0001').causes, ['f000001', 'f000002'])
  const undo = await applyUndo({ sessionDir: dir, operationId: 'f000001', actor: 'user' })
  assert.deepEqual(undo.restoredIds, ['t00000001-r0001'])
  assert.deepEqual(undo.keptIds, ['t00000002-r0001'])
  index = await getForgetIndex(dir)
  assert.equal(isForgotten(index, 't00000001-r0001'), false)
  assert.deepEqual(index.forgotten.get('t00000002-r0001').causes, ['f000002'])
  assert.equal(isForgotten(index, 't00000003-r0001'), true)
  // 多 cause 摘除后 reasons 同步收敛为剩余 cause 的理由。
  assert.deepEqual(index.forgotten.get('t00000002-r0001').reasons, ['r2'])
})

test('applyUndo：不存在 / 重复撤销都明确报错', async () => {
  const dir = await newSessionDir()
  resetForgetIndexCache()
  await assert.rejects(
    applyUndo({ sessionDir: dir, operationId: 'f000009', actor: 'user' }),
    (error) => error instanceof DispositionError && error.code === 'ENOOP',
  )
  await applyForget({ sessionDir: dir, targetIds: ['t00000001-r0001'], actor: 'user' })
  await applyUndo({ sessionDir: dir, operationId: 'f000001', actor: 'user' })
  await assert.rejects(
    applyUndo({ sessionDir: dir, operationId: 'f000001', actor: 'user' }),
    (error) => error instanceof DispositionError && error.code === 'EALREADYUNDONE',
  )
})

test('foldVisibility：多 cause 条目流折叠与 reasons 映射', () => {
  const entries = [
    { kind: DISPOSITION_ENTRY_FORGET, operationId: 'f000001', targetIds: ['t00000001-r0001'], reason: 'r1', at: '2026-10-16T01:00:00.000Z' },
    { kind: DISPOSITION_ENTRY_FORGET, operationId: 'f000002', targetIds: ['t00000001-r0001'], reason: 'r2', at: '2026-10-16T01:01:00.000Z' },
    { kind: DISPOSITION_ENTRY_UNDO, operationId: 'u000001', undoOf: 'f000002', restoredIds: [], keptIds: ['t00000001-r0001'] },
  ]
  const folded = foldVisibility(entries)
  const slot = folded.get('t00000001-r0001')
  assert.deepEqual(slot.causes, ['f000001'])
  assert.deepEqual(slot.reasons, ['r1'])
  assert.equal(slot.forgottenAt, '2026-10-16T01:00:00.000Z')
  // undo 兼容只写 restoredIds 的旧式条目：origin 目标集合同样摘 cause。
  const legacy = foldVisibility([
    { kind: DISPOSITION_ENTRY_FORGET, operationId: 'f000001', targetIds: ['t00000001-r0001'], reason: 'r1', at: '2026-10-16T01:00:00.000Z' },
    { kind: DISPOSITION_ENTRY_UNDO, operationId: 'u000001', undoOf: 'f000001', restoredIds: ['t00000001-r0001'] },
  ])
  assert.equal(legacy.has('t00000001-r0001'), false)
})

// ---------------------------------------------------------------- 崩溃注入点①

test('尾部半行：截断修复并记账 repairedBytes（崩溃注入点①）', async () => {
  const dir = await newSessionDir()
  resetForgetIndexCache()
  await applyForget({ sessionDir: dir, targetIds: ['t00000001-r0001'], actor: 'user' })
  const before = await readFile(dispositionPath(dir), 'utf8')
  const garbage = '{"kind":"disposition/forget","operationId":"f000002"'
  await appendFile(dispositionPath(dir), garbage, 'utf8')
  const ledger = await loadDisposition(dir)
  assert.equal(ledger.damaged, false)
  assert.equal(ledger.repairedBytes, Buffer.byteLength(garbage, 'utf8'))
  assert.equal(ledger.revision, 1)
  const after = await readFile(dispositionPath(dir), 'utf8')
  assert.equal(after, before, '修复后文件回到崩溃前的完整状态')
})

test('中部损坏：写侧拒绝、读侧带告警继续（失败关闭口径）', async () => {
  const dir = await newSessionDir()
  resetForgetIndexCache()
  await applyForget({ sessionDir: dir, targetIds: ['t00000001-r0001'], actor: 'user' })
  await applyForget({ sessionDir: dir, targetIds: ['t00000002-r0001'], actor: 'user' })
  const { lines } = await readJsonl(dispositionPath(dir))
  const damagedText = [lines[0], lines[1], 'NOT-JSON', lines[2]].join('\n') + '\n'
  await writeFile(dispositionPath(dir), damagedText, 'utf8')
  invalidateForgetIndex(dir)
  const ledger = await loadDisposition(dir)
  assert.equal(ledger.damaged, true)
  assert.deepEqual(ledger.entries.map((entry) => entry.operationId), ['f000001'])
  await assert.rejects(
    applyForget({ sessionDir: dir, targetIds: ['t00000003-r0001'], actor: 'user' }),
    (error) => error instanceof DispositionError && error.code === 'EDISPOSITIONDAMAGED',
  )
  await assert.rejects(
    applyUndo({ sessionDir: dir, operationId: 'f000001', actor: 'user' }),
    (error) => error instanceof DispositionError && error.code === 'EDISPOSITIONDAMAGED',
  )
  await assert.rejects(
    describeForgetStatus(dir),
    (error) => error instanceof DispositionError && error.code === 'EDISPOSITIONDAMAGED',
  )
  const index = await getForgetIndex(dir)
  assert.equal(index.damaged, true)
  assert.equal(isForgotten(index, 't00000001-r0001'), true, '读侧用已解析前缀继续过滤')
  assert.equal(isForgotten(index, 't00000002-r0001'), false)
})

// ---------------------------------------------------------------- 别名统一

test('resolveForgetTargets：记录 ID 精确命中不扩大', async () => {
  const entries = [spanEntry('t00000001-r0001', 'mcl2-a-000001')]
  const resolved = await resolveForgetTargets({ targets: ['t00000001-r0001'], entries })
  assert.deepEqual(resolved.recordIds, ['t00000001-r0001'])
  assert.equal(resolved.wide, false)
  assert.deepEqual(resolved.expansions, [])
})

test('resolveForgetTargets：nodeId 别名 → 单元闭包（分块 + 配对记录）', async () => {
  const entries = [
    spanEntry('t00000001-r0001', 'mcl2-a-000001', { chunk: 1 }),
    spanEntry('t00000001-r0002', 'mcl2-a-000001_p2', { chunk: 2 }),
    callEntry('t00000001-r0003', 'call-1', 'mcl2-a-000001'),
    resultEntry('t00000001-r0004', 'call-1', 'mcl2-a-000001'),
    spanEntry('t00000001-r0005', 'mcl2-b-000001'),
  ]
  const resolved = await resolveForgetTargets({ targets: ['mcl2-a-000001_p2'], entries })
  assert.deepEqual(resolved.recordIds, ['t00000001-r0001', 't00000001-r0002', 't00000001-r0003', 't00000001-r0004'])
  assert.equal(resolved.expansions.length, 1)
  assert.equal(resolved.wide, false)
})

test('resolveForgetTargets：callId 别名 → 配对记录 + 单元闭包', async () => {
  const entries = [
    spanEntry('t00000001-r0001', 'mcl2-a-000001'),
    callEntry('t00000001-r0002', 'call-1', 'mcl2-a-000001'),
    resultEntry('t00000001-r0003', 'call-1', 'mcl2-a-000001'),
  ]
  const resolved = await resolveForgetTargets({ targets: ['call-1'], entries })
  assert.deepEqual(resolved.recordIds, ['t00000001-r0001', 't00000001-r0002', 't00000001-r0003'])
})

test('resolveForgetTargets：kind= / before= 宽条件', async () => {
  const entries = [
    spanEntry('t00000001-r0001', 'mcl2-a-000001', { spanKind: 'turn.user' }),
    spanEntry('t00000001-r0002', 'mcl2-b-000001', { spanKind: 'turn.user' }),
    spanEntry('t00000001-r0003', 'mcl2-c-000001', { spanKind: 'turn.assistant' }),
  ]
  const byKind = await resolveForgetTargets({ targets: ['kind=turn.user'], entries })
  assert.equal(byKind.wide, true)
  assert.deepEqual(byKind.recordIds, ['t00000001-r0001', 't00000001-r0002'])
  const before = await resolveForgetTargets({ targets: ['before=t00000001-r0003'], entries })
  assert.equal(before.wide, true)
  assert.deepEqual(before.recordIds, ['t00000001-r0001', 't00000001-r0002'])
})

test('resolveForgetTargets：未知目标如实上报', async () => {
  const entries = [spanEntry('t00000001-r0001', 'mcl2-a-000001')]
  const resolved = await resolveForgetTargets({ targets: ['t00000099-r0001', 'mcl2-none-000001'], entries })
  assert.deepEqual(resolved.recordIds, [])
  assert.deepEqual(resolved.unknown, ['t00000099-r0001', 'mcl2-none-000001'])
})

test('resolveForgetTargets：v1 导入指针按内容 nodeId 尽力命中', async () => {
  const entries = [
    importPointerEntry('t00000001-r0001'),
    spanEntry('t00000001-r0002', 'mcl2-v1-000001'),
  ]
  const readRecord = async (id) => (id === 't00000001-r0001'
    ? { ok: true, text: JSON.stringify({ nodeId: 'mcl2-v1-000001', hash: 'x' }) }
    : { ok: false })
  const resolved = await resolveForgetTargets({ targets: ['mcl2-v1-000001'], entries, readRecord })
  assert.deepEqual(resolved.recordIds, ['t00000001-r0001', 't00000001-r0002'])
  // readRecord 缺席时指针不命中别名，但 nodeId 自身的记录仍可解析。
  const bare = await resolveForgetTargets({ targets: ['mcl2-v1-000001'], entries })
  assert.deepEqual(bare.recordIds, ['t00000001-r0002'])
})

// ---------------------------------------------------------------- 硬保护

test('硬保护：在途工具调用宽条件与显式一律拒绝', () => {
  const entries = [
    spanEntry('t00000001-r0001', 'mcl2-a-000001'),
    callEntry('t00000001-r0002', 'call-1', 'mcl2-a-000001'),
  ]
  for (const mode of ['wide', 'explicit']) {
    const protection = evaluateForgetProtection({ recordIds: ['t00000001-r0002'], entries, mode })
    assert.equal(protection.blocked.length, 1)
    assert.equal(protection.blocked[0].rule, 'in-flight')
  }
})

test('硬保护：已闭合配对不再拦截', () => {
  const entries = [
    callEntry('t00000001-r0002', 'call-1', 'mcl2-a-000001'),
    resultEntry('t00000001-r0003', 'call-1', 'mcl2-a-000001'),
  ]
  const protection = evaluateForgetProtection({ recordIds: ['t00000001-r0002', 't00000001-r0003'], entries, mode: 'wide' })
  assert.deepEqual(protection.blocked, [])
})

test('硬保护：人类用户消息宽条件拒绝、显式放行带警告', () => {
  const entries = [spanEntry('t00000001-r0001', 'mcl2-a-000001', { spanKind: 'turn.user' })]
  const wide = evaluateForgetProtection({ recordIds: ['t00000001-r0001'], entries, mode: 'wide' })
  assert.equal(wide.blocked.length, 1)
  assert.equal(wide.blocked[0].rule, 'human-user')
  const explicit = evaluateForgetProtection({ recordIds: ['t00000001-r0001'], entries, mode: 'explicit' })
  assert.deepEqual(explicit.blocked, [])
  assert.equal(explicit.warnings.length, 1)
  assert.equal(explicit.warnings[0].rule, 'human-user')
  const pluginAuthored = [spanEntry('t00000001-r0001', 'mcl2-a-000001', { spanKind: 'turn.user', pluginAuthored: true })]
  const pluginResult = evaluateForgetProtection({ recordIds: ['t00000001-r0001'], entries: pluginAuthored, mode: 'wide' })
  assert.deepEqual(pluginResult.blocked, [])
})

// ---------------------------------------------------------------- 两段式计划

test('buildForgetPreview：显式目标给全集信息但不生成计划', async () => {
  const dir = await newSessionDir()
  resetForgetIndexCache()
  const entries = [
    spanEntry('t00000001-r0001', 'mcl2-a-000001'),
    callEntry('t00000001-r0002', 'call-1', 'mcl2-a-000001'),
    resultEntry('t00000001-r0003', 'call-1', 'mcl2-a-000001'),
  ]
  const preview = await buildForgetPreview({ sessionDir: dir, targets: ['mcl2-a-000001'], entries })
  assert.deepEqual(preview.toForget, ['t00000001-r0001', 't00000001-r0002', 't00000001-r0003'])
  assert.equal(preview.wide, false)
  assert.equal(preview.plan, null)
  assert.equal(preview.revision, 0)
})

test('buildForgetPreview：宽条件生成计划，硬保护拦截不进集合', async () => {
  const dir = await newSessionDir()
  resetForgetIndexCache()
  const entries = [
    spanEntry('t00000001-r0001', 'mcl2-a-000001', { spanKind: 'turn.user' }),
    spanEntry('t00000001-r0002', 'mcl2-b-000001', { spanKind: 'turn.user' }),
  ]
  const preview = await buildForgetPreview({ sessionDir: dir, targets: ['kind=turn.user'], entries })
  assert.equal(preview.wide, true)
  assert.deepEqual(preview.blocked.map((item) => item.id), ['t00000001-r0001', 't00000001-r0002'])
  assert.deepEqual(preview.toForget, [])
  assert.equal(preview.plan, null, '全被拦截时无有效集合，不生成计划')
  // 换成插件代发的用户 span：可进集合，生成计划。
  const safeEntries = [
    spanEntry('t00000001-r0001', 'mcl2-a-000001', { spanKind: 'turn.user', pluginAuthored: true }),
    spanEntry('t00000001-r0002', 'mcl2-b-000001', { spanKind: 'turn.user', pluginAuthored: true }),
  ]
  const safePreview = await buildForgetPreview({ sessionDir: dir, targets: ['kind=turn.user'], entries: safeEntries })
  assert.deepEqual(safePreview.toForget, ['t00000001-r0001', 't00000001-r0002'])
  assert.equal(safePreview.plan.planId, computePlanId(safePreview.toForget, 0))
  assert.deepEqual(safePreview.plan.resolvedIds, safePreview.toForget)
})

test('buildForgetPreview：已遗忘目标进 already 而非 toForget', async () => {
  const dir = await newSessionDir()
  resetForgetIndexCache()
  await applyForget({ sessionDir: dir, targetIds: ['t00000001-r0001'], actor: 'user' })
  const entries = [spanEntry('t00000001-r0001', 'mcl2-a-000001'), spanEntry('t00000001-r0002', 'mcl2-b-000001')]
  const preview = await buildForgetPreview({ sessionDir: dir, targets: ['t00000001-r0001', 't00000001-r0002'], entries })
  assert.deepEqual(preview.already.map((item) => item.id), ['t00000001-r0001'])
  assert.deepEqual(preview.already[0].causes, ['f000001'])
  assert.deepEqual(preview.toForget, ['t00000001-r0002'])
})

test('forget-plans.json：原子写、去重、上限 32 条', async () => {
  const dir = await newSessionDir()
  resetForgetIndexCache()
  const plan = {
    planId: computePlanId(['t00000001-r0001'], 0),
    targets: ['kind=turn.user'],
    resolvedIds: ['t00000001-r0001'],
    blockedIds: [],
    unknown: [],
    revision: 0,
    createdAt: '2026-10-16T00:00:00.000Z',
  }
  await saveForgetPlan(dir, plan)
  const again = await saveForgetPlan(dir, { ...plan, createdAt: '2026-10-16T00:01:00.000Z' })
  assert.equal(again.kept, 1, '同 planId 去重')
  const text = await readFile(path.join(dir, 'forget-plans.json'), 'utf8')
  assert.ok(text.endsWith('\n'))
  assert.ok(!text.includes('\r'))
  for (let i = 0; i < FORGET_PLAN_LIMIT + 5; i += 1) {
    await saveForgetPlan(dir, {
      planId: computePlanId(['t00000002-r0001'], i + 1) + String(i),
      targets: ['kind=turn.user'],
      resolvedIds: ['t00000002-r0001'],
      blockedIds: [],
      unknown: [],
      revision: i + 1,
      createdAt: new Date(Date.parse('2026-10-16T01:00:00.000Z') + i * 1000).toISOString(),
    })
  }
  const plans = await loadForgetPlans(dir)
  assert.equal(plans.length, FORGET_PLAN_LIMIT)
  assert.equal(await getForgetPlan(dir, plan.planId), null, '最旧计划被淘汰')
})

// ---------------------------------------------------------------- 状态与缓存

test('describeForgetStatus：操作流水、撤销标记、遗忘计数', async () => {
  const dir = await newSessionDir()
  resetForgetIndexCache()
  await applyForget({ sessionDir: dir, targetIds: ['t00000001-r0001', 't00000002-r0001'], actor: 'user', reason: '清理' })
  await applyForget({ sessionDir: dir, targetIds: ['t00000003-r0001'], actor: 'user' })
  await applyUndo({ sessionDir: dir, operationId: 'f000002', actor: 'user' })
  const status = await describeForgetStatus(dir)
  assert.equal(status.state, 'ok')
  assert.equal(status.revision, 3)
  assert.equal(status.forgottenCount, 2)
  const forgets = status.operations.filter((op) => op.kind === 'forget')
  assert.equal(forgets.length, 2)
  assert.equal(forgets.find((op) => op.operationId === 'f000002').undone, true)
  assert.equal(forgets.find((op) => op.operationId === 'f000001').undone, false)
  const undo = status.operations.find((op) => op.kind === 'undo')
  assert.equal(undo.undoOf, 'f000002')
})

test('getForgetIndex 缓存：(size, mtime) 失效 + 提交路径主动失效', async () => {
  const dir = await newSessionDir()
  resetForgetIndexCache()
  await applyForget({ sessionDir: dir, targetIds: ['t00000001-r0001'], actor: 'user' })
  let index = await getForgetIndex(dir)
  assert.equal(isForgotten(index, 't00000001-r0001'), true)
  await applyForget({ sessionDir: dir, targetIds: ['t00000002-r0001'], actor: 'user' })
  index = await getForgetIndex(dir)
  assert.equal(isForgotten(index, 't00000002-r0001'), true, 'appendEntry 后缓存立即失效')
  // 外部追加（尺寸变化）也会被 stat 失效机制感知：读面不会读到旧视图。
  await appendFile(dispositionPath(dir), canonicalLine({ kind: DISPOSITION_ENTRY_FORGET, operationId: 'f000003' }) + '\n', 'utf8')
  const fresh = await getForgetIndex(dir)
  assert.equal(fresh.revision, 3)
  // 读侧对缺字段的手工行按宽入口径解析：kind 合法即成条目（写侧才有严格
  // 形状校验），折叠时空 targetIds 不影响可见性。
  assert.equal(fresh.damaged, false)
  assert.equal(isForgotten(fresh, 't00000001-r0001'), true)
  invalidateForgetIndex(dir)
  const afterInvalidate = await getForgetIndex(dir)
  assert.equal(afterInvalidate.revision, 3, '显式失效后重读仍一致')
})

test('canonicalJson：递归键排序', () => {
  assert.equal(
    JSON.stringify(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: 2 } })),
    '{"a":{"c":2,"d":[3,{"y":2,"z":1}]},"b":1}',
  )
})
