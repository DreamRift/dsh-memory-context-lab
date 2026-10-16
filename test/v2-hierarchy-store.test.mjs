/**
 * P3 层级账本（hierarchy.jsonl 旁车）单测。
 *
 * 覆盖：单条/批量追加的 revision CAS、批量原子性、禁「摘要再摘要」守卫、
 * 折叠索引、叶子解析，以及崩溃注入（半行、坏行、损坏态拒写、缓存失效）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, appendFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  HIERARCHY_ENTRY_L1,
  HIERARCHY_ENTRY_L2,
  HIERARCHY_ENTRY_L3,
  HIERARCHY_ENTRY_RUN,
  HIERARCHY_ENTRY_VOUCHER,
  HierarchyStoreError,
  appendHierarchyEntries,
  appendHierarchyEntry,
  foldHierarchy,
  getHierarchyIndex,
  hierarchyPath,
  hierarchyStatus,
  invalidateHierarchyIndex,
  loadHierarchy,
  resolveLeafRecordIds,
} from '../src/v2/hierarchy-store.mjs'

const AT = '2026-10-16T08:00:00.000Z'

function l1Entry(cardId, recordId, text = '卡片文本', tokens = 10) {
  return { kind: HIERARCHY_ENTRY_L1, cardId, recordId, text, tokens, at: AT }
}

function l2Entry(cardId, phaseKey, sourceRecordIds) {
  return { kind: HIERARCHY_ENTRY_L2, cardId, phaseKey, phaseLabel: '阶段', sourceRecordIds, text: '阶段摘要', tokens: 5, blocks: [], at: AT }
}

async function withTempDir(name, body) {
  const dir = await mkdtemp(path.join(tmpdir(), 'mcl2hier-' + name + '-'))
  try {
    await body(dir)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

test('appendHierarchyEntry：单条追加分配 entrySeq/revision；CAS 不匹配拒绝且不写', async () => {
  await withTempDir('cas', async (dir) => {
    const first = await appendHierarchyEntry(dir, l1Entry('l1-a', 't00000001-r0001'))
    assert.equal(first.appended, true)
    assert.equal(first.entry.entrySeq, 1)
    assert.equal(first.revision, 1)

    await assert.rejects(
      () => appendHierarchyEntry(dir, l1Entry('l1-b', 't00000001-r0002'), { expectedRevision: 0 }),
      (error) => error instanceof HierarchyStoreError && error.code === 'EREVISION',
    )
    const ledger = await loadHierarchy(dir)
    assert.equal(ledger.entries.length, 1, '被拒条目不得落盘')

    const second = await appendHierarchyEntry(dir, l1Entry('l1-b', 't00000001-r0002'), { expectedRevision: 1 })
    assert.equal(second.entry.entrySeq, 2)
  })
})

test('appendHierarchyEntry：形状校验拒绝（坏前缀/坏 at/空 text）', async () => {
  await withTempDir('shape', async (dir) => {
    const bad = { kind: HIERARCHY_ENTRY_L1, cardId: 'x-a', recordId: 't1', text: 't', tokens: 1, at: AT }
    await assert.rejects(
      () => appendHierarchyEntry(dir, bad),
      (error) => error instanceof HierarchyStoreError && error.code === 'EINVAL',
    )
    await assert.rejects(
      () => appendHierarchyEntry(dir, l1Entry('l1-a', 't1', '', 1)),
      (error) => error.code === 'EINVAL',
    )
  })
})

test('appendHierarchyEntries：批量原子——合法批全进，含非法条目的批一行不写', async () => {
  await withTempDir('atomic', async (dir) => {
    const run = { kind: HIERARCHY_ENTRY_RUN, runId: 'run-1', outcome: 'committed', phaseKey: 'phase-1', sourceRevision: 0, at: AT }
    const ok = await appendHierarchyEntries(dir, [l1Entry('l1-a', 't00000001-r0001'), l1Entry('l1-b', 't00000001-r0002'), run])
    assert.equal(ok.appended, true)
    assert.deepEqual(ok.entries.map((e) => e.entrySeq), [1, 2, 3])

    const before = await readFile(hierarchyPath(dir), 'utf8')
    await assert.rejects(
      () => appendHierarchyEntries(dir, [l1Entry('l1-c', 't00000001-r0003'), { kind: 'bogus', at: AT }]),
      (error) => error instanceof HierarchyStoreError && error.code === 'EINVAL',
    )
    assert.equal(await readFile(hierarchyPath(dir), 'utf8'), before, '非法批必须一行不写')
  })
})

test('禁摘要再摘要：L2 引用账本内卡片 id 即拒绝（单条与批量都拦）', async () => {
  await withTempDir('nosummary', async (dir) => {
    await appendHierarchyEntry(dir, l1Entry('l1-a', 't00000001-r0001'))
    const l2 = l2Entry('l2-a', 'phase-1', ['t00000001-r0001', 'l1-a'])
    await assert.rejects(
      () => appendHierarchyEntry(dir, l2),
      (error) => error instanceof HierarchyStoreError && error.code === 'EHIERARCHYNOSUMMARY',
    )
    await assert.rejects(
      () => appendHierarchyEntries(dir, [l2]),
      (error) => error.code === 'EHIERARCHYNOSUMMARY',
    )
  })
})

test('折叠索引：L1 按记录、L2 按 phase 取最后、L3 取最新、凭证按 id、run 保序', () => {
  const entries = [
    l1Entry('l1-a', 't00000001-r0001'),
    l1Entry('l1-b', 't00000001-r0002'),
    l2Entry('l2-a', 'p1', ['t00000001-r0001']),
    l2Entry('l2-b', 'p1', ['t00000001-r0002']),
    { kind: HIERARCHY_ENTRY_L3, indexId: 'l3-a', phases: [{ phaseKey: 'p1' }], text: '索引', at: AT },
    { kind: HIERARCHY_ENTRY_VOUCHER, voucherId: 'agg-1', memberSeqs: [3, 4], replacementSeq: 9, startSeq: 3, endSeq: 4, text: '凭证', memberRecordIds: ['t00000001-r0001'], at: AT },
    { kind: HIERARCHY_ENTRY_RUN, runId: 'run-1', outcome: 'committed', phaseKey: 'p1', sourceRevision: 2, at: AT },
  ]
  const fold = foldHierarchy(entries)
  assert.equal(fold.l1ByRecord.get('t00000001-r0001'), 'l1-a')
  assert.equal(fold.l2ByPhase.get('p1')?.cardId, 'l2-b', '同 phaseKey 后写覆盖')
  assert.equal(fold.l3Latest?.indexId, 'l3-a')
  assert.equal(fold.vouchers.get('agg-1')?.voucherId, 'agg-1')
  assert.equal(fold.runs.length, 1)
})

test('resolveLeafRecordIds：按 L2 phase 展开叶子并去重；缺卡如实记 missing', () => {
  const index = {
    phases: [
      { cardId: 'l2-a', sourceRecordIds: ['t00000001-r0001', 't00000001-r0002'] },
      { cardId: 'l2-b', sourceRecordIds: ['t00000001-r0002', 't00000001-r0003'] },
      { cardId: 'l2-missing' },
    ],
  }
  const cardsById = new Map([
    ['l2-a', l2Entry('l2-a', 'p1', ['t00000001-r0001', 't00000001-r0002'])],
    ['l2-b', l2Entry('l2-b', 'p2', ['t00000001-r0002', 't00000001-r0003'])],
  ])
  const leaves = resolveLeafRecordIds(index, cardsById)
  assert.deepEqual(leaves.leaves, ['t00000001-r0001', 't00000001-r0002', 't00000001-r0003'], '跨 phase 去重')
  assert.deepEqual(leaves.missing, ['l2-missing'], '缺卡不误报为叶子')
})

test('崩溃注入：无 LF 半行如实披露；坏行 → damaged 且拒写', async () => {
  await withTempDir('crash', async (dir) => {
    await appendHierarchyEntry(dir, l1Entry('l1-a', 't00000001-r0001'))
    await appendFile(hierarchyPath(dir), '{"kind":"hierarchy/l1","cardId":"l1-half', 'utf8')
    const torn = await loadHierarchy(dir)
    assert.equal(torn.damaged, false, '半行不是坏行，只是不完整')
    assert.ok(torn.repairedBytes > 0, '必须报告半行已被物理截断修复')
    const after = await readFile(hierarchyPath(dir), 'utf8')
    assert.ok(after.endsWith('\n'), '截断后文件必须以完整行结尾')
    assert.ok(!after.includes('l1-half'), '半行必须被移除')
    assert.equal(torn.entries.length, 1, '半行不进条目')

    await appendFile(hierarchyPath(dir), '"}\n', 'utf8')
    const damaged = await loadHierarchy(dir)
    assert.equal(damaged.damaged, true)
    assert.ok(damaged.damageDetail, '必须给出坏行定位')
    await assert.rejects(
      () => appendHierarchyEntry(dir, l1Entry('l1-c', 't00000001-r0003')),
      (error) => error.code === 'EHIERARCHYDAMAGED',
      '损坏态必须拒绝追加',
    )
  })
})

test('索引缓存：追加后 getHierarchyIndex 看到新 revision（缓存被失效）', async () => {
  await withTempDir('cache', async (dir) => {
    await appendHierarchyEntry(dir, l1Entry('l1-a', 't00000001-r0001'))
    const first = await getHierarchyIndex(dir)
    assert.equal(first.revision, 1)
    await appendHierarchyEntry(dir, l1Entry('l1-b', 't00000001-r0002'))
    const second = await getHierarchyIndex(dir)
    assert.equal(second.revision, 2, '追加必须失效缓存')
    invalidateHierarchyIndex(dir)
  })
})

test('hierarchyStatus：空账本 absent，有条目后汇总各类计数', async () => {
  await withTempDir('status', async (dir) => {
    const empty = await hierarchyStatus(dir)
    assert.equal(empty.state, 'absent')
    await appendHierarchyEntries(dir, [
      l1Entry('l1-a', 't00000001-r0001'),
      { kind: HIERARCHY_ENTRY_VOUCHER, voucherId: 'agg-1', memberSeqs: [3, 4], replacementSeq: 9, startSeq: 3, endSeq: 4, text: '凭证', memberRecordIds: ['t00000001-r0001'], at: AT },
      { kind: HIERARCHY_ENTRY_RUN, runId: 'run-1', outcome: 'committed', phaseKey: 'p1', sourceRevision: 2, at: AT },
    ])
    const status = await hierarchyStatus(dir)
    assert.equal(status.state, 'ok')
    assert.equal(status.revision, 3)
    assert.equal(status.l1Count, 1)
    assert.equal(status.vouchers.length, 1)
    assert.equal(status.runs.length, 1)
  })
})