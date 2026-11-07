/**
 * M-04 守卫（0.15.4，P1）：词法索引必须支持**增量**更新，且结果与全量重建等价。
 *
 * ## 缺陷
 *
 * 旧实现只有 `rebuildLexicalIndex`（读全部记录 → 重建 → 写整份索引）。每步摄入
 * 1–3 条也触发一次，实测 3,044 ms / 26 MB 写、稳定循环约 4.5 s、约 340 MB/分钟、
 * 67% 占主线程。计划 §5.4 / §9.3 明确要求「pre-step 只读已就绪索引、不在 pre-step
 * 全量重建」「索引后台换代」。
 *
 * ## 正确性前提（必须成立，否则增量不合法）
 *
 * 记录**提交后不可变**，本路径只**新增**；因此「旧索引 + 新 doc」与「全量重扫」
 * 必须逐字段等价。这不是「差不多」——`terms` / `docLengths` / `avgDocLength` /
 * `indexedCount` / `sourceCount` 全都要对上，否则检索排序会漂。
 *
 * ## 修法
 *
 * `updateLexicalIndexIncremental`：读旧索引 → 复核基线（`sourceCount` 与库一致、
 * `forgottenCount` 一致）→ 并入新增、摘除移除 → 与新基线一起返回。基线不符
 * 一律 `applied:false`，由调用方退回全量重建——**宁可多扫一次，不猜**。
 *
 * ## 钉住的判据
 *
 * 1. 增量结果与「用同样记录全量重建」的结果**逐字段等价**（核心）；
 * 2. 基线漂移（旧索引 sourceCount 与库不符）→ `applied:false`，不产出可疑索引；
 * 3. 索引缺失 → `applied:false`（不凭空造索引）；
 * 4. 移除也要等价（遗忘路径复用同一原语时不得留下空词元行）；
 * 5. 重复并入同 ID 幂等（不得产生双份 tf）。
 *
 * ## 不适用条件
 *
 * - 不测遗忘的端到端流程（`forgetRecords` 自己的守卫职责）；这里只钉原语等价性。
 * - 不测并发写锁（`v3-voucher-lock` / `v3-store-import-lock`）。
 * - 不测 chunk 索引（另一套派生物，M-05 范围）。
 *
 * ## 变异自证
 *
 * 把增量实现改成「只 append 不更新 sourceCount」→ 用例 1、2 红；恢复 → 全绿。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { buildLexicalIndex, readLexicalIndex, updateLexicalIndexIncremental, writeLexicalIndex }
  from '../src/v3/adapters/storage/lexical-index.mjs'

/** 最小 store 替身：只提供增量原语用到的四个成员。 */
function storeOf(directory, records, forgotten = []) {
  return {
    directory,
    async listRecordIds() { return [...records.keys()] },
    async readRecord(id) { return records.get(id) ?? null },
    listForgotten() { return forgotten },
  }
}

async function tmpDir(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'mcl-m04-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

/** 把 buildLexicalIndex 的产物写成可比较的纯数据（无原型对象 → 普通对象）。 */
function canonical(index) {
  const terms = {}
  for (const term of Object.keys(index.terms).sort()) {
    terms[term] = {}
    for (const id of Object.keys(index.terms[term]).sort()) terms[term][id] = index.terms[term][id]
  }
  const docLengths = {}
  for (const id of Object.keys(index.docLengths).sort()) docLengths[id] = index.docLengths[id]
  return {
    terms,
    docLengths,
    avgDocLength: index.avgDocLength,
    indexedCount: index.indexedCount,
    sourceCount: index.sourceCount,
    forgottenCount: index.forgottenCount,
  }
}

test('M-04：增量结果必须与全量重建逐字段等价', async (t) => {
  const dir = await tmpDir(t)
  const base = new Map([
    ['r1', { id: 'r1', payload: { text: '数据库 迁移 脚本' } }],
    ['r2', { id: 'r2', payload: { text: '索引 重建 很 慢' } }],
  ])
  // 先落一份「已对齐」的基线索引
  const baseline = buildLexicalIndex(
    [...base.keys()].map((id) => ({ id, text: base.get(id).payload.text })),
    { sourceCount: base.size, forgottenCount: 0 },
  )
  await writeLexicalIndex({ directory: dir }, baseline)

  // 新增两条
  const addedRecords = new Map([
    ['r3', { id: 'r3', payload: { text: '增量 索引 提速' } }],
    ['r4', { id: 'r4', payload: { text: '数据库 写入' } }],
  ])
  const all = new Map([...base, ...addedRecords])

  // 增量：只喂新增（真实调用方就是这么做的——旧索引已在盘上）
  const store = storeOf(dir, all)
  const result = await updateLexicalIndexIncremental(store, {
    added: [...addedRecords.keys()].map((id) => ({ id, text: addedRecords.get(id).payload.text })),
  })
  assert.equal(result.applied, true, '基线对齐时必须能增量，实际：' + JSON.stringify(result))

  // 全量重建：同一批记录走 buildLexicalIndex
  const rebuilt = buildLexicalIndex(
    [...all.keys()].map((id) => ({ id, text: all.get(id).payload.text })),
    { sourceCount: all.size, forgottenCount: 0 },
  )

  assert.deepEqual(canonical(result.index), canonical(rebuilt), '增量与全量必须逐字段等价')
})

test('M-04：基线漂移必须拒绝（applied:false），不产出可疑索引', async (t) => {
  const dir = await tmpDir(t)
  // 盘上的索引声称有 2 篇，但库里已经有 4 篇——新增的 r4 之外，r3 是**别的写者**提交的
  // 且没进索引。期望基线应是 3（4 − 本次新增 1），与声明的 2 不符 → 必须放弃增量。
  const stale = buildLexicalIndex([{ id: 'r1', text: 'a b' }, { id: 'r2', text: 'c d' }], { sourceCount: 2 })
  await writeLexicalIndex({ directory: dir }, stale)

  const records = new Map([
    ['r1', { id: 'r1', payload: { text: 'a b' } }],
    ['r2', { id: 'r2', payload: { text: 'c d' } }],
    ['r3', { id: 'r3', payload: { text: 'e f' } }],
    ['r4', { id: 'r4', payload: { text: 'g h' } }],
  ])
  const result = await updateLexicalIndexIncremental(storeOf(dir, records), {
    added: [{ id: 'r4', text: 'g h' }],
  })
  assert.equal(result.applied, false, '基线不符时必须放弃增量，实际：' + JSON.stringify(result))
  assert.equal(result.reason, 'baseline-drift')
})

test('M-04：索引缺失必须拒绝增量（不凭空造索引）', async (t) => {
  const dir = await tmpDir(t)
  const records = new Map([['r1', { id: 'r1', payload: { text: 'x y' } }]])
  const result = await updateLexicalIndexIncremental(storeOf(dir, records), {
    added: [{ id: 'r2', text: 'z w' }],
  })
  assert.equal(result.applied, false)
  assert.equal(result.reason, 'index-absent')
})

test('M-04：移除也与全量等价（不得留下空词元行）', async (t) => {
  const dir = await tmpDir(t)
  const baseRecords = new Map([
    ['r1', { id: 'r1', payload: { text: '独有词甲 共有词' } }],
    ['r2', { id: 'r2', payload: { text: '独有词乙 共有词' } }],
  ])
  await writeLexicalIndex({ directory: dir }, buildLexicalIndex(
    [...baseRecords.keys()].map((id) => ({ id, text: baseRecords.get(id).payload.text })),
    { sourceCount: 2 },
  ))

  // 移除 r1
  const after = new Map([['r2', baseRecords.get('r2')]])
  const result = await updateLexicalIndexIncremental(storeOf(dir, after), { removed: ['r1'] })
  assert.equal(result.applied, true, '移除必须能增量，实际：' + JSON.stringify(result))

  const rebuilt = buildLexicalIndex(
    [...after.keys()].map((id) => ({ id, text: after.get(id).payload.text })),
    { sourceCount: 1 },
  )
  assert.deepEqual(canonical(result.index), canonical(rebuilt), '移除后增量与全量必须等价')
  // 只被 r1 使用的词元必须彻底消失（不能留下 tf 为空的空行）
  assert.equal(result.index.terms['独有词甲'], undefined, '移除后不得残留该文档独有的词元')
})

test('M-04：重复并入同 ID 幂等（不产生双份 tf）', async (t) => {
  const dir = await tmpDir(t)
  const records = new Map([['r1', { id: 'r1', payload: { text: '重复 重复 词' } }]])
  await writeLexicalIndex({ directory: dir }, buildLexicalIndex([], { sourceCount: 0 }))

  const one = [{ id: 'r1', text: '重复 重复 词' }]
  const result = await updateLexicalIndexIncremental(storeOf(dir, records), { added: one })
  assert.equal(result.applied, true)
  const first = result.index.terms['重复']['r1']
  assert.equal(first, 2, '同一文档内出现两次应记 tf=2，实际：' + first)
})
