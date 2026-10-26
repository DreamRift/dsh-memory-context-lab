/**
 * v3 事务号分配守卫（H-10，2026-10-26 缺陷排查批）。
 *
 * ## 缺陷
 * submitTransaction 用**内存里的** manifest.txnNext 分配事务号，而 withWriteLock 只做
 * 同进程排队（不重读盘上 manifest）。于是同一会话目录被两个句柄/两个进程同时写时，
 * 各自从 1 开始编号：transactions.jsonl 里 txn 序列变成 1,2,3,4,5,1,2,3,4,5 —— 号复用，
 * 与 session-store 头部声明的「号不复用（D-17/D-18）」直接矛盾，也让崩溃对账
 * （max(txn)+1）失去意义。
 *
 * ## 判据
 * - 两个句柄交替提交 → 事务号全局单调、无重复；
 * - 重开后 txnNext 仍等于 max(txn)+1（对账不倒退）；
 * - 同句柄连续提交行为不变（回归）。
 *
 * ## 不适用条件与已知边界（待拍板）
 * 跨**进程**并发仍缺跨进程写锁：write-lock.mjs 的 acquireWriteLock 已实现但 v3 存储
 * 路径没有接入（session-store 头部写明「跨进程锁在下一批接入」）。本套件只覆盖
 * 「锁内重读分配器」这一最小修复，跨进程接入属设计级决定，记录在
 * docs/dev-0.14.0/bug-hunt-20261026.md 的 H-10「待拍板」。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { openV3SessionStore } from '../src/v3/adapters/storage/session-store.mjs'

function record(id, text) {
  return {
    id,
    kind: 'message-user',
    sessionKey: 's',
    createdAt: 1792845000000,
    payload: { text, bytes: Buffer.byteLength(text, 'utf8') },
    provenance: { sourceEventId: 'dsh-' + id.slice(-2), sourceForm: null, transactionId: 'tx-1' },
  }
}

async function withRoot(body) {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-v3-txn-'))
  try {
    return await body(root)
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
}

test('H-10 两个句柄交替提交：事务号不得复用（旧：1,2,3,4,5,1,2,3,4,5）', async () => {
  await withRoot(async (root) => {
    const a = await openV3SessionStore(root, 's')
    const b = await openV3SessionStore(root, 's')
    const assigned = []
    for (let i = 0; i < 5; i += 1) {
      assigned.push((await a.submitTransaction([record('v3r-' + String(i).padStart(16, '0'), 'A' + i)])).txn)
      assigned.push((await b.submitTransaction([record('v3r-' + String(100 + i).padStart(16, '0'), 'B' + i)])).txn)
    }
    a.close()
    b.close()
    const unique = new Set(assigned)
    assert.equal(unique.size, assigned.length, '事务号必须唯一（实测 ' + assigned.join(',') + '）')
    const sorted = [...assigned].sort((x, y) => x - y)
    assert.deepEqual(sorted, Array.from({ length: assigned.length }, (_, i) => i + 1), '事务号连续不跳号')

    const log = (await readFile(path.join(root, 'sessions', 's', 'transactions.jsonl'), 'utf8'))
      .trim().split('\n').map((line) => JSON.parse(line))
    assert.deepEqual(log.map((l) => l.txn), assigned, '日志顺序与分配顺序一致')
  })
})

test('H-10 重开后 txnNext === max(txn)+1，不倒退', async () => {
  await withRoot(async (root) => {
    const a = await openV3SessionStore(root, 's')
    await a.submitTransaction([record('v3r-0000000000000001', '甲')])
    const b = await openV3SessionStore(root, 's')
    await b.submitTransaction([record('v3r-0000000000000002', '乙')])
    a.close()
    b.close()

    const reopened = await openV3SessionStore(root, 's')
    const health = reopened.health()
    assert.equal(health.txnNext, 3, '对账后事务号必须接在最大号之后')
    const next = await reopened.submitTransaction([record('v3r-0000000000000003', '丙')])
    assert.equal(next.txn, 3)
    reopened.close()
  })
})

test('H-10 同句柄连续提交不回归：号连续、记录都在', async () => {
  await withRoot(async (root) => {
    const store = await openV3SessionStore(root, 's')
    for (let i = 0; i < 3; i += 1) {
      const out = await store.submitTransaction([record('v3r-' + String(i).padStart(16, '0'), '正文' + i)])
      assert.equal(out.txn, i + 1)
    }
    assert.equal((await store.listRecordIds()).length, 3)
    store.close()
  })
})
