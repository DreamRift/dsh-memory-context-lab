/**
 * v3 恢复凭证与词法索引测试（M2 第三批）。
 *
 * ## 判据来源
 * 《开发计划-v3》§2.4（恢复凭证随事务提交）、P9（派生物可删除可重建）、
 * §2.6（v3 数据根）；archive 域 restoreEligibilityOf 的 durable 数据面。
 *
 * ## 断言组
 * - voucher：追加/列表/计数；形状非法拒绝；账本尾损坏 → listVouchers 失败关闭
 *   且 health 报 vouchersDamaged，但记录写不受影响（独立故障面）；
 * - 索引：CJK 查询命中（单字+双字同一把尺子）；空查询不造通配；损坏 →
 *   ESTORE_CORRUPT；删除/损坏后 rebuild 从记录完整重建；新增记录 → stale。
 *
 * ## 不适用条件与已知边界
 * BM25/IDF、增量索引与缓存精确失效属 M4；voucher 与 surface 对账属 M3。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { openV3SessionStore } from '../src/v3/adapters/storage/session-store.mjs'
import {
  buildLexicalIndex, isIndexStale, readLexicalIndex, rebuildLexicalIndex, searchLexical, writeLexicalIndex,
} from '../src/v3/adapters/storage/lexical-index.mjs'

function record(id, text) {
  return {
    id,
    kind: 'operation',
    sessionKey: 'sess-a',
    createdAt: 1792845000000,
    payload: { text, bytes: Buffer.byteLength(text, 'utf8') },
    provenance: { sourceEventId: 'evt-1', sourceForm: 'tool/result', transactionId: 't' },
  }
}

async function withStore(body) {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-v3-idx-'))
  try {
    const store = await openV3SessionStore(root, 'sess-a')
    try {
      return await body(store, root)
    } finally {
      store.close()
    }
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
}

test('voucher：追加/列表；形状非法拒绝', async () => {
  await withStore(async (store) => {
    const voucher = { txn: 1, recordIds: ['v3r-0123456789abc000'], targetEventId: 'evt-9', receiptText: '回执正文' }
    const appended = await store.appendVoucher(voucher)
    assert.equal(appended.voucherCount, 1)
    assert.deepEqual(store.listVouchers(), [voucher])
    await assert.rejects(() => store.appendVoucher({ txn: 0 }), (e) => e?.name === 'V3ContractViolation')
    await assert.rejects(() => store.appendVoucher(null), (e) => e?.name === 'V3ContractViolation')
    assert.equal(store.health().voucherCount, 1)
  })
})

test('voucher 账本尾损坏：恢复面失败关闭，记录写不受影响（独立故障面）', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-v3-vch-'))
  try {
    const store = await openV3SessionStore(root, 'sess-a')
    await store.appendVoucher({ txn: 1, recordIds: [], targetEventId: 'evt-9', receiptText: 'r' })
    store.close()
    const vouchersPath = path.join(root, 'sessions', 'sess-a', 'vouchers.jsonl')
    const before = await readFile(vouchersPath, 'utf8')
    await writeFile(vouchersPath, before + '{"txn":2,"half')
    const reopened = await openV3SessionStore(root, 'sess-a')
    const health = reopened.health()
    assert.equal(health.vouchersDamaged, true)
    assert.equal(health.healthy, false)
    assert.throws(() => reopened.listVouchers(), (e) => e?.code === 'ESTORE_DAMAGED')
    // 记录面独立：仍可提交与回读
    const txn = await reopened.submitTransaction([record('v3r-0123456789abc000', '正文')])
    assert.equal(txn.txn, 1)
    assert.equal((await reopened.readRecord('v3r-0123456789abc000')).id, 'v3r-0123456789abc000')
    reopened.close()
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})

test('索引：CJK 命中（单字+双字同尺）；空查询不造通配', () => {
  const index = buildLexicalIndex([
    { id: 'a', text: '记忆插件开发' },
    { id: 'b', text: '检索引擎维护' },
  ])
  const hits = searchLexical(index, '记忆')
  assert.ok(hits.length >= 1 && hits[0].id === 'a')
  const preferB = searchLexical(index, '检索引擎')
  assert.equal(preferB[0].id, 'b', '命中词元更多者得分更高')
  const tie = searchLexical(index, '记忆 检索') // 两文档各 3 分 → 并列，id 升序
  assert.equal(tie[0].id, 'a', '同分时 id 升序（确定性）')
  assert.deepEqual(searchLexical(index, '   '), [])
})

test('索引持久化：损坏 → ESTORE_CORRUPT；rebuild 从记录完整重建；新增记录 → stale', async () => {
  await withStore(async (store) => {
    await store.submitTransaction([record('v3r-0123456789abc000', '记忆插件开发')])
    const built = await rebuildLexicalIndex(store)
    assert.equal(built.indexedCount, 1)
    assert.deepEqual(readLexicalIndexResult(await readLexicalIndex(store)), ['a-like'])
    assert.equal(await isIndexStale(store, await readLexicalIndex(store)), false)

    // 损坏 → ESTORE_CORRUPT → 删除后重建
    const indexPath = path.join(store.directory, 'lexical-index.json')
    await writeFile(indexPath, '{broken')
    await assert.rejects(() => readLexicalIndex(store), (e) => e?.code === 'ESTORE_CORRUPT')
    await rm(indexPath, { force: true })
    assert.equal(await readLexicalIndex(store), null, '缺失返回 null（可重建）')
    const rebuilt = await rebuildLexicalIndex(store)
    assert.equal(rebuilt.indexedCount, 1)

    // 新增记录 → stale → 重建后恢复
    await store.submitTransaction([record('v3r-0123456789abc001', '检索引擎')])
    assert.equal(await isIndexStale(store, rebuilt), true)
    const fresh = await rebuildLexicalIndex(store)
    assert.equal(await isIndexStale(store, fresh), false)
    assert.ok(searchLexical(fresh, '检索')[0].id === 'v3r-0123456789abc001')
  })
})

function readLexicalIndexResult(index) {
  return index === null ? null : Object.keys(index.terms).length > 0 ? ['a-like'] : []
}
