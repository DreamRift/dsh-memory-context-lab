/**
 * v3 词法索引的原型污染守卫（H-13，2026-10-26 缺陷排查批）。
 *
 * ## 缺陷
 * buildLexicalIndex 用普通 `{}` 做倒排表。词元 `constructor`（英文正文里很常见：
 * "the class constructor"）会命中 Object.prototype.constructor 这个**继承属性**，
 * 于是 `terms[term][id] = …` 把记录 ID 写进**全局 Object 构造函数**：
 * - 进程内原型污染（任何后续 `Object.keys(Object)` 都能看到记录 ID）；
 * - 该词元在 JSON.stringify 时被丢弃（自有函数属性不序列化）→ 索引里没有
 *   `constructor`，检索这个常见英文词永久 OOV；
 * - 同一路径对 `toString` / `valueOf` / `hasOwnProperty` 等同样成立。
 *
 * ## 判据
 * - 建索引不得改动全局 Object 构造函数的自有属性（原型污染为零）；
 * - `constructor` 必须作为**自有词元**进索引并能在序列化后保留（可检索）；
 * - 从磁盘读回旧索引（可能带继承属性）后，查询必须只认自有词元；
 * - 正常词元与既有检索行为不回归。
 *
 * ## 不适用条件与已知边界
 * 只覆盖 lexical-index 的倒排表；v2 的检索索引（local-lexical-backend）不在本判据，
 * 若同样用普通对象则需另开一条（本轮只排查 v3）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { buildLexicalIndex, readLexicalIndex, searchLexical } from '../src/v3/adapters/storage/lexical-index.mjs'

// 词元化会把英文小写化，所以真正能撞原型的是这些**小写**词元
const PROTO_KEYS = ['constructor', 'tostring', 'valueof', 'hasownproperty', 'isprototypeof', '__proto__']

test('H-13 建索引不得污染全局 Object 构造函数', () => {
  const before = Object.getOwnPropertyNames(Object).sort()
  for (const key of PROTO_KEYS) {
    buildLexicalIndex([{ id: 'v3r-0000000000000001', text: '正文里的 ' + key + ' 用法' }])
  }
  assert.deepEqual(Object.getOwnPropertyNames(Object).sort(), before, '全局 Object 不得被写入任何自有属性')
  assert.equal(Object.getOwnPropertyNames(Object).some((name) => name.startsWith('v3r-')), false)
})

test('H-13 原型链词元必须是自有词元且可序列化（旧：被 JSON 丢弃 → 永久 OOV）', () => {
  for (const key of ['constructor', 'tostring', 'valueof']) {
    const index = buildLexicalIndex([{ id: 'v3r-0000000000000001', text: '英文正文含 ' + key + ' 一词' }])
    assert.equal(Object.hasOwn(index.terms, key), true, key + ' 必须作为自有词元存在')
    const roundTripped = JSON.parse(JSON.stringify(index))
    assert.equal(Object.hasOwn(roundTripped.terms, key), true, key + ' 必须能序列化保留')
    assert.equal(roundTripped.terms[key]['v3r-0000000000000001'], 1, key + ' 的 tf 正确')
    const hits = searchLexical(roundTripped, key, { limit: 5 })
    assert.equal(hits.length, 1, key + ' 必须可检索到')
    assert.equal(hits[0].id, 'v3r-0000000000000001')
  }
})

test('H-13 旧索引文件带继承属性时，读回后只认自有词元', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-v3-indexproto-'))
  try {
    const file = path.join(root, 'lexical-index.json')
    // 模拟旧版本写出的索引：普通对象 + 未命中 constructor
    await writeFile(file, JSON.stringify({
      terms: { 记忆: { 'v3r-0000000000000001': 2 } },
      docLengths: { 'v3r-0000000000000001': 2 },
      avgDocLength: 2,
      indexedCount: 1,
    }) + '\n', 'utf8')
    const index = await readLexicalIndex({ directory: root })
    assert.equal(Object.getPrototypeOf(index.terms), null, '读回后必须是空原型表')
    assert.equal(index.terms.constructor, undefined, '继承的 constructor 不得可见')
    assert.equal(searchLexical(index, 'constructor', { limit: 5 }).length, 0, '未索引的原型词元必须落 OOV')
    assert.equal(searchLexical(index, '记忆', { limit: 5 }).length, 1, '正常词元不受影响')
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})

test('H-13 正常检索不回归：CJK 单字+双字与英文词', () => {
  const index = buildLexicalIndex([
    { id: 'v3r-0000000000000001', text: '记忆上下文插件的检索' },
    { id: 'v3r-0000000000000002', text: 'retrieval baseline' },
  ])
  assert.ok(searchLexical(index, '检索', { limit: 5 }).some((hit) => hit.id === 'v3r-0000000000000001'))
  assert.ok(searchLexical(index, 'retrieval', { limit: 5 }).some((hit) => hit.id === 'v3r-0000000000000002'))
  assert.deepEqual(searchLexical(index, '   ', { limit: 5 }), [], '空查询不造通配')
})
