/**
 * v3 存储适配器故障注入测试（M2 第一批）。
 *
 * ## 缺陷
 * v2 存储族教训（store-hardening / store-guard / disposition-integrity）：能写进去
 * 读不回来、已提交事务被回写为未提交、号复用、读路径删日志、半行静默截断。
 *
 * ## 判据来源
 * 《开发计划-v3》M2 验收：失败不伪成功、原文可读、重试不重复、跨会话不串数据。
 *
 * ## 断言组
 * - 正常路径：提交→精确回读逐字节同义（JSON 等价）、txn 号单调；
 * - 崩溃窗口①（payload 无 commit 行）：重开后残留进 quarantine、事务未提交、
 *   重试拿新号（号不复用）；
 * - 崩溃窗口②（commit 行在、txnNext 未推进）：重开对账推进；
 * - 尾损坏：transactions.jsonl 追加半行 → damaged：写拒绝、读照常、文件字节不动；
 * - 冲突：重复 ID 拒绝且不烧号（txnNext 不变）；非法记录整笔拒绝；
 * - 跨会话：manifest 不符 → ESTORE_SESSION_MISMATCH；
 * - close 后写失败关闭。
 *
 * ## 不适用条件与已知边界
 * 单写者假设（跨进程锁下一批）；fsync 与断电语义（Windows rename 原子性）未注入。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { openV3SessionStore } from '../src/v3/adapters/storage/session-store.mjs'

function record(id, overrides = {}) {
  return {
    id,
    kind: 'operation',
    sessionKey: 'sess-a',
    createdAt: 1792845000000,
    payload: { text: '正文-' + id, bytes: Buffer.byteLength('正文-' + id, 'utf8') },
    provenance: { sourceEventId: 'evt-1', sourceForm: 'tool/result', transactionId: 't' },
    ...overrides,
  }
}

async function withRoot(body) {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-v3-store-'))
  try {
    return await body(root)
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
}

test('正常路径：提交→回读等价、txn 单调递增', async () => {
  await withRoot(async (root) => {
    const store = await openV3SessionStore(root, 'sess-a')
    const a = await store.submitTransaction([record('v3r-0123456789abc000')])
    const b = await store.submitTransaction([record('v3r-0123456789abc001')])
    assert.equal(a.txn, 1)
    assert.equal(b.txn, 2)
    const read = await store.readRecord('v3r-0123456789abc000')
    assert.equal(read.payload.text, '正文-v3r-0123456789abc000')
    assert.equal(store.health().recordCount, 2)
    store.close()
  })
})

test('崩溃窗口①：payload 无 commit 行 → 隔离、未提交、重试新号', async () => {
  await withRoot(async (root) => {
    const store = await openV3SessionStore(root, 'sess-a')
    await store.submitTransaction([record('v3r-0123456789abc000')])
    store.close()
    // 模拟：写进 payload 但 commit 行没落盘
    const dir = path.join(root, 'sessions', 'sess-a')
    await writeFile(path.join(dir, 'records', 'v3r-0123456789abc00f.json'), JSON.stringify(record('v3r-0123456789abc00f')) + '\n')
    const reopened = await openV3SessionStore(root, 'sess-a')
    const health = reopened.health()
    assert.deepEqual(health.orphanedAtOpen, ['v3r-0123456789abc00f'])
    assert.equal(health.txnNext, 2, '残留不推进事务号')
    const quarantined = await readdir(path.join(dir, 'quarantine'))
    assert.ok(quarantined.includes('v3r-0123456789abc00f.json'))
    await assert.rejects(() => reopened.readRecord('v3r-0123456789abc00f'), (e) => e?.code === 'ESTORE_CORRUPT' && /崩溃残留/.test(e.message))
    const next = await reopened.submitTransaction([record('v3r-0123456789abc001')])
    assert.equal(next.txn, 2, '重试拿到新号（号不复用）')
    reopened.close()
  })
})

test('崩溃窗口②：commit 行在、txnNext 未推进 → 对账推进', async () => {
  await withRoot(async (root) => {
    const store = await openV3SessionStore(root, 'sess-a')
    await store.submitTransaction([record('v3r-0123456789abc000')])
    await store.submitTransaction([record('v3r-0123456789abc001')])
    store.close()
    // 模拟：第三次 commit 行已落盘、manifest 未推进（手工造第 3 行）
    const dir = path.join(root, 'sessions', 'sess-a')
    const log = await readFile(path.join(dir, 'transactions.jsonl'), 'utf8')
    await writeFile(path.join(dir, 'transactions.jsonl'), log + JSON.stringify({ action: 'commit', txn: 3, recordIds: [] }) + '\n')
    const reopened = await openV3SessionStore(root, 'sess-a')
    assert.equal(reopened.health().txnNext, 4, '对账推进到 max(txn)+1')
    reopened.close()
  })
})

test('尾损坏：半行 → damaged；写拒绝、读照常、字节不动', async () => {
  await withRoot(async (root) => {
    const store = await openV3SessionStore(root, 'sess-a')
    await store.submitTransaction([record('v3r-0123456789abc000')])
    store.close()
    const dir = path.join(root, 'sessions', 'sess-a')
    const logPath = path.join(dir, 'transactions.jsonl')
    const before = await readFile(logPath, 'utf8')
    await writeFile(logPath, before + '{"action":"commit","txn":2,"recordI') // 半行
    const reopened = await openV3SessionStore(root, 'sess-a')
    const health = reopened.health()
    assert.equal(health.healthy, false)
    assert.match(health.damagedReason, /不可解析/)
    await assert.rejects(() => reopened.submitTransaction([record('v3r-0123456789abc001')]), (e) => e?.code === 'ESTORE_DAMAGED')
    const read = await reopened.readRecord('v3r-0123456789abc000')
    assert.equal(read.id, 'v3r-0123456789abc000', '读不受损日志影响')
    const after = await readFile(logPath, 'utf8')
    assert.equal(after, before + '{"action":"commit","txn":2,"recordI', '读路径不得改写日志（字节不动）')
    reopened.close()
  })
})

test('冲突与非法：重复 ID 拒绝不烧号；非法记录整笔拒绝', async () => {
  await withRoot(async (root) => {
    const store = await openV3SessionStore(root, 'sess-a')
    await store.submitTransaction([record('v3r-0123456789abc000')])
    await assert.rejects(
      () => store.submitTransaction([record('v3r-0123456789abc000')]),
      (e) => e?.code === 'ESTORE_TXN_CONFLICT',
    )
    assert.equal(store.health().txnNext, 2, '冲突拒绝不烧号')
    const bad = record('v3r-0123456789abc001', { payload: { text: 'x', bytes: 99 } })
    await assert.rejects(() => store.submitTransaction([bad]), (e) => e?.name === 'V3ContractViolation')
    assert.equal(store.health().txnNext, 2, '整笔拒绝不烧号')
    await assert.rejects(() => store.submitTransaction([]), (e) => e?.name === 'V3ContractViolation')
    store.close()
  })
})

test('跨会话不串：manifest 不符拒绝；close 后写失败关闭', async () => {
  await withRoot(async (root) => {
    const store = await openV3SessionStore(root, 'sess-a')
    store.close()
    await assert.rejects(() => store.submitTransaction([record('v3r-0123456789abc002')]), (e) => e?.code === 'ESTORE_CLOSED')
    // 手工改 manifest 的 sessionKey 模拟串目录
    const dir = path.join(root, 'sessions', 'sess-a')
    const manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8'))
    manifest.sessionKey = 'sess-other'
    await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest) + '\n')
    await assert.rejects(() => openV3SessionStore(root, 'sess-a'), (e) => e?.code === 'ESTORE_SESSION_MISMATCH')
  })
})
