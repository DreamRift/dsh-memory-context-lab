/**
 * v2 来源图（provenance 旁车账本）测试：append-only 边注册、环拒绝、
 * cause 失效、来源种子有界 BFS、反向边查询、折叠幂等/合并语义、崩溃注入
 * （尾部半行截断修复、中部损坏失败关闭）。全部使用临时隔离目录。
 */
import assert from 'node:assert/strict'
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  PROVENANCE_BFS_MAX_NODES,
  PROVENANCE_EDGE,
  PROVENANCE_HEADER_KIND,
  PROVENANCE_INVALIDATION,
  PROVENANCE_SCHEMA_VERSION,
  ProvenanceError,
  dependentsOf,
  foldProvenance,
  invalidateProvenance,
  loadProvenance,
  propagateInvalidations,
  provenancePath,
  registerProvenanceEdge,
} from '../src/v2/provenance-index.mjs'

const tmpRoots = []

async function newSessionDir() {
  const dir = await mkdtemp(path.join(tmpdir(), 'mcl-v2-provenance-'))
  tmpRoots.push(dir)
  return dir
}

test.after(async () => {
  await Promise.all(tmpRoots.map((root) => rm(root, { recursive: true, force: true })))
})

function provenanceLines(text) {
  return text.split('\n').filter((line) => line.length > 0)
}

// ---------------------------------------------------------------- 基础读写

test('全新会话：文件不存在 → absent，注册边时建账', async () => {
  const dir = await newSessionDir()
  const ledger = await loadProvenance(dir)
  assert.equal(ledger.state, 'absent')
  assert.equal(ledger.damaged, false)
  assert.equal(ledger.entries.length, 0)
  const { entry } = await registerProvenanceEdge({
    sessionDir: dir,
    derivedId: 'doc-1',
    derivedKind: 'retrieval-index',
    sourceIds: ['t00000001-r0002', 't00000001-r0001', 't00000001-r0002'],
  })
  assert.equal(entry.kind, PROVENANCE_EDGE)
  assert.deepEqual(entry.sourceIds, ['t00000001-r0001', 't00000001-r0002'], '来源去重排序')
  const text = await readFile(provenancePath(dir), 'utf8')
  assert.ok(!text.includes('\r'), 'LF 行尾')
  assert.ok(text.endsWith('\n'))
  const lines = provenanceLines(text)
  assert.equal(lines.length, 2)
  assert.equal(JSON.parse(lines[0]).kind, PROVENANCE_HEADER_KIND)
  assert.equal(JSON.parse(lines[0]).schemaVersion, PROVENANCE_SCHEMA_VERSION)
  const keys = Object.keys(JSON.parse(lines[1]))
  assert.deepEqual(keys, [...keys].sort(), '条目键排序')
  const reloaded = await loadProvenance(dir)
  assert.equal(reloaded.state, 'ok')
  assert.equal(reloaded.entries.length, 1)
})

test('注册参数校验：EINVAL', async () => {
  const dir = await newSessionDir()
  await assert.rejects(
    registerProvenanceEdge({ sessionDir: dir, derivedId: '', derivedKind: 'retrieval-index', sourceIds: ['t1'] }),
    (error) => error instanceof ProvenanceError && error.code === 'EINVAL',
  )
  await assert.rejects(
    registerProvenanceEdge({ sessionDir: dir, derivedId: 'doc-1', derivedKind: 'retrieval-index', sourceIds: 't1' }),
    (error) => error instanceof ProvenanceError && error.code === 'EINVAL',
  )
})

// ---------------------------------------------------------------- 环拒绝

test('自指边拒绝：derived 不得是自己的来源', async () => {
  const dir = await newSessionDir()
  await assert.rejects(
    registerProvenanceEdge({ sessionDir: dir, derivedId: 'doc-1', derivedKind: 'retrieval-index', sourceIds: ['doc-1'] }),
    (error) => error instanceof ProvenanceError && error.code === 'ECYCLE',
  )
})

test('传递环拒绝：A←B 已注册时 B←A 拒绝', async () => {
  const dir = await newSessionDir()
  await registerProvenanceEdge({ sessionDir: dir, derivedId: 'doc-1', derivedKind: 'retrieval-index', sourceIds: ['t1'] })
  await registerProvenanceEdge({ sessionDir: dir, derivedId: 'doc-2', derivedKind: 'summary', sourceIds: ['doc-1'] })
  // 此时边语义：doc-1 是 doc-2 的来源。再注册 doc-1 ← doc-2 会形成环。
  await assert.rejects(
    registerProvenanceEdge({ sessionDir: dir, derivedId: 'doc-1', derivedKind: 'retrieval-index', sourceIds: ['doc-2'] }),
    (error) => error instanceof ProvenanceError && error.code === 'ECYCLE',
  )
  // 无关方向不受影响。
  const ok = await registerProvenanceEdge({ sessionDir: dir, derivedId: 'doc-3', derivedKind: 'summary', sourceIds: ['doc-2', 't9'] })
  assert.equal(ok.entry.derivedId, 'doc-3')
})

// ---------------------------------------------------------------- 失效标记

test('登记失效：幂等（同 derived+cause 只记一条生效）', async () => {
  const dir = await newSessionDir()
  await registerProvenanceEdge({ sessionDir: dir, derivedId: 'doc-1', derivedKind: 'retrieval-index', sourceIds: ['t1'] })
  const first = await invalidateProvenance({ sessionDir: dir, derivedId: 'doc-1', cause: 'f000001' })
  assert.equal(first.appended, true)
  const second = await invalidateProvenance({ sessionDir: dir, derivedId: 'doc-1', cause: 'f000001' })
  assert.equal(second.appended, false)
  const ledger = await loadProvenance(dir)
  assert.equal(ledger.entries.filter((entry) => entry.kind === PROVENANCE_INVALIDATION).length, 1)
})

// ---------------------------------------------------------------- 折叠与反向边

test('foldProvenance：重复边合并来源并集，失效 cause 去重累积', () => {
  const entries = [
    { kind: PROVENANCE_EDGE, derivedId: 'doc-1', derivedKind: 'retrieval-index', sourceIds: ['t1'] },
    { kind: PROVENANCE_EDGE, derivedId: 'doc-1', derivedKind: 'retrieval-index', sourceIds: ['t1', 't2'] },
    { kind: PROVENANCE_EDGE, derivedId: 'doc-2', derivedKind: 'summary', sourceIds: ['doc-1', 'doc-1'] },
    { kind: PROVENANCE_INVALIDATION, derivedId: 'doc-1', cause: 'f000001' },
    { kind: PROVENANCE_INVALIDATION, derivedId: 'doc-1', cause: 'f000001' },
    { kind: PROVENANCE_INVALIDATION, derivedId: 'doc-1', cause: 'f000002' },
  ]
  const folded = foldProvenance(entries)
  assert.deepEqual(folded.edges.get('doc-1'), { derivedKind: 'retrieval-index', sourceIds: ['t1', 't2'] })
  assert.deepEqual(folded.edges.get('doc-2'), { derivedKind: 'summary', sourceIds: ['doc-1'] })
  assert.deepEqual(folded.invalidated.get('doc-1'), ['f000001', 'f000002'])
})

test('dependentsOf：反向边查询（forget preview 的级联报告）', () => {
  const folded = foldProvenance([
    { kind: PROVENANCE_EDGE, derivedId: 'doc-1', derivedKind: 'retrieval-index', sourceIds: ['t1', 't2'] },
    { kind: PROVENANCE_EDGE, derivedId: 'doc-2', derivedKind: 'summary', sourceIds: ['doc-1'] },
    { kind: PROVENANCE_EDGE, derivedId: 'doc-3', derivedKind: 'summary', sourceIds: ['t9'] },
  ])
  assert.deepEqual(dependentsOf(['t1', 'doc-1'], folded), [
    { derivedId: 'doc-1', derivedKind: 'retrieval-index', viaSources: ['t1'] },
    { derivedId: 'doc-2', derivedKind: 'summary', viaSources: ['doc-1'] },
  ])
  assert.deepEqual(dependentsOf(['t-none'], folded), [])
})

// ---------------------------------------------------------------- 有界 BFS

test('propagateInvalidations：按层展开，affected 排序', () => {
  const folded = foldProvenance([
    { kind: PROVENANCE_EDGE, derivedId: 'doc-1', derivedKind: 'retrieval-index', sourceIds: ['t1'] },
    { kind: PROVENANCE_EDGE, derivedId: 'doc-2', derivedKind: 'summary', sourceIds: ['doc-1'] },
    { kind: PROVENANCE_EDGE, derivedId: 'doc-3', derivedKind: 'summary', sourceIds: ['doc-2', 't9'] },
  ])
  const report = propagateInvalidations(['t1'], folded)
  assert.deepEqual(report.affected, ['doc-1', 'doc-2', 'doc-3'])
  assert.deepEqual(report.layers, [
    { depth: 1, derivedIds: ['doc-1'] },
    { depth: 2, derivedIds: ['doc-2'] },
    { depth: 3, derivedIds: ['doc-3'] },
  ])
  assert.equal(report.truncated, false)
  // 种子自身是派生物时不自含。
  const selfSeed = propagateInvalidations(['doc-1'], folded)
  assert.deepEqual(selfSeed.affected, ['doc-2', 'doc-3'])
})

test('propagateInvalidations：节点与深度上限如实截断', () => {
  const edges = []
  for (let i = 0; i <= PROVENANCE_BFS_MAX_NODES + 5; i += 1) {
    edges.push({ kind: PROVENANCE_EDGE, derivedId: 'doc-' + i, derivedKind: 'retrieval-index', sourceIds: [i === 0 ? 't1' : 'doc-' + (i - 1)] })
  }
  const report = propagateInvalidations(['t1'], foldProvenance(edges))
  assert.equal(report.truncated, true)
  assert.ok(report.affected.length <= PROVENANCE_BFS_MAX_NODES + 1)
  const deep = foldProvenance([
    { kind: PROVENANCE_EDGE, derivedId: 'doc-1', derivedKind: 'retrieval-index', sourceIds: ['t1'] },
    { kind: PROVENANCE_EDGE, derivedId: 'doc-2', derivedKind: 'summary', sourceIds: ['doc-1'] },
  ])
  const shallow = propagateInvalidations(['t1'], deep, { maxDepth: 1 })
  assert.deepEqual(shallow.affected, ['doc-1'])
  assert.equal(shallow.truncated, true, '深度 1 封顶后仍可达 doc-2 → 截断如实上报')
})

// ---------------------------------------------------------------- 崩溃注入与损坏

test('尾部半行：截断修复并记账 repairedBytes', async () => {
  const dir = await newSessionDir()
  await registerProvenanceEdge({ sessionDir: dir, derivedId: 'doc-1', derivedKind: 'retrieval-index', sourceIds: ['t1'] })
  const before = await readFile(provenancePath(dir), 'utf8')
  const garbage = '{"kind":"provenance/edge","derivedId":"doc-2"'
  await appendFile(provenancePath(dir), garbage, 'utf8')
  const ledger = await loadProvenance(dir)
  assert.equal(ledger.damaged, false)
  assert.equal(ledger.repairedBytes, Buffer.byteLength(garbage, 'utf8'))
  const after = await readFile(provenancePath(dir), 'utf8')
  assert.equal(after, before, '修复后文件回到崩溃前状态')
})

test('中部损坏：写侧拒绝、读侧用已解析前缀继续', async () => {
  const dir = await newSessionDir()
  await registerProvenanceEdge({ sessionDir: dir, derivedId: 'doc-1', derivedKind: 'retrieval-index', sourceIds: ['t1'] })
  await invalidateProvenance({ sessionDir: dir, derivedId: 'doc-1', cause: 'f000001' })
  const text = await readFile(provenancePath(dir), 'utf8')
  const lines = provenanceLines(text)
  await writeFile(provenancePath(dir), [lines[0], 'NOT-JSON', ...lines.slice(1)].join('\n') + '\n', 'utf8')
  const ledger = await loadProvenance(dir)
  assert.equal(ledger.damaged, true)
  assert.equal(ledger.state, 'damaged')
  assert.deepEqual(ledger.entries.map((entry) => entry.kind), [], '首条目即损坏时前缀为空')
  await assert.rejects(
    registerProvenanceEdge({ sessionDir: dir, derivedId: 'doc-9', derivedKind: 'retrieval-index', sourceIds: ['t9'] }),
    (error) => error instanceof ProvenanceError && error.code === 'EPROVENANCEDAMAGED',
  )
  await assert.rejects(
    invalidateProvenance({ sessionDir: dir, derivedId: 'doc-1', cause: 'f000002' }),
    (error) => error instanceof ProvenanceError && error.code === 'EPROVENANCEDAMAGED',
  )
})

test('损坏定位：header 之后的坏行保留前缀条目', async () => {
  const dir = await newSessionDir()
  await registerProvenanceEdge({ sessionDir: dir, derivedId: 'doc-1', derivedKind: 'retrieval-index', sourceIds: ['t1'] })
  const text = await readFile(provenancePath(dir), 'utf8')
  const lines = provenanceLines(text)
  await writeFile(provenancePath(dir), [lines[0], lines[1], 'NOT-JSON'].join('\n') + '\n', 'utf8')
  const ledger = await loadProvenance(dir)
  assert.equal(ledger.damaged, true)
  assert.equal(ledger.entries.length, 1)
  assert.equal(ledger.damageDetail.line, 3)
})

test('header 非法：整账本判损坏', async () => {
  const dir = await newSessionDir()
  await writeFile(provenancePath(dir), JSON.stringify({ kind: 'unknown', schemaVersion: 1 }) + '\n', 'utf8')
  const ledger = await loadProvenance(dir)
  assert.equal(ledger.damaged, true)
  assert.equal(ledger.entries.length, 0)
})

test('空文件：按 absent 处理', async () => {
  const dir = await newSessionDir()
  await writeFile(provenancePath(dir), '', 'utf8')
  const ledger = await loadProvenance(dir)
  assert.equal(ledger.state, 'absent')
  assert.equal(ledger.damaged, false)
})
