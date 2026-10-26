/**
 * v3 事务日志丢失的数据保护守卫（H-21，2026-10-26 缺陷排查批）。
 *
 * ## 缺陷
 * openV3SessionStore 的崩溃对账是「有 payload 无 commit 行 → 移入 quarantine」。
 * 当 `transactions.jsonl` **整个缺失**（杀软隔离 / 用户误删 / 同步工具冲突）或**被清空**
 * 时，已解析的 commit 行为 0 条 → committedIds 为空 → 全部记录都被当成「崩溃残留」
 * 搬进 quarantine：**记录从 records/ 里消失、读不到，而 health 仍报 healthy=true**
 * （实测 5 条记录 → records/ 剩 0、quarantine/ 5 条、healthy=true）。这是静默全丢。
 *
 * ## 判据
 * - 日志缺失或清空但记录仍在、且 manifest.txnNext > 1（历史上确实提交过）→ 判 damaged：
 *   记录字节不动、不隔离、读仍然可读、写拒绝（ESTORE_DAMAGED），交人工裁决；
 * - **真崩溃残留**（日志在、有 commit 行、某条 payload 没有对应 commit）→ 仍照旧隔离；
 * - 全新会话（无日志无记录）→ 仍 healthy（不得把正常首启判成损坏）。
 *
 * ## 不适用条件与已知边界
 * 只覆盖「对账依据丢失」的判定；真正的跨进程写锁缺口（两个进程同时写同一会话目录）
 * 属 H-10 的「待拍板」设计级问题，不在本判据。
 * damaged 状态下 recordCount 报 0——已提交集合无法判定，这是如实标注而非数据丢失
 * （记录本身仍可读，health.damagedReason 说明原因）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { openV3SessionStore } from '../src/v3/adapters/storage/session-store.mjs'

function hex16(n) {
  return n.toString(16).padStart(16, '0')
}

function recordOf(n, sessionKey) {
  const text = '正文' + n
  return {
    id: 'v3r-' + hex16(n),
    kind: 'message-user',
    sessionKey,
    createdAt: 1,
    payload: { text, bytes: Buffer.byteLength(text, 'utf8') },
    provenance: { sourceEventId: 'dsh-' + n, sourceForm: null, transactionId: 'tx-' + n },
  }
}

async function seededSession(sessionKey, count) {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-v3-logloss-'))
  const store = await openV3SessionStore(root, sessionKey)
  for (let i = 1; i <= count; i += 1) await store.submitTransaction([recordOf(i, sessionKey)])
  store.close()
  return root
}

test('H-21 事务日志缺失 → 判 damaged、记录不隔离、读仍可、写拒绝（旧：全量隔离 + healthy）', async () => {
  const root = await seededSession('log-gone', 5)
  try {
    await rm(path.join(root, 'sessions', 'log-gone', 'transactions.jsonl'), { force: true })
    const store = await openV3SessionStore(root, 'log-gone')
    const health = store.health()
    assert.equal(health.healthy, false, '日志缺失必须判 damaged（不得报 healthy）')
    assert.deepEqual(health.orphanedAtOpen, [], '不得把记录当成崩溃残留隔离')
    assert.match(String(health.damagedReason), /transactions\.jsonl/)
    const read = await store.readRecord('v3r-' + hex16(1)).then(() => true, () => false)
    assert.equal(read, true, '记录字节完好，读必须仍然可读')
    await assert.rejects(
      () => store.submitTransaction([recordOf(9, 'log-gone')]),
      (error) => error?.code === 'ESTORE_DAMAGED',
      'damaged 状态写必须失败关闭',
    )
    store.close()
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})

test('H-21 事务日志被清空（0 字节）→ 同样判 damaged，不隔离', async () => {
  const root = await seededSession('log-empty', 3)
  try {
    await writeFile(path.join(root, 'sessions', 'log-empty', 'transactions.jsonl'), '', 'utf8')
    const store = await openV3SessionStore(root, 'log-empty')
    const health = store.health()
    assert.equal(health.healthy, false)
    assert.deepEqual(health.orphanedAtOpen, [])
    assert.equal(await store.readRecord('v3r-' + hex16(2)).then(() => true, () => false), true)
    store.close()
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})

test('H-21 回归：真崩溃残留（有 commit 行、某条 payload 无 commit）仍必须隔离', async () => {
  const root = await seededSession('real-orphan', 3)
  try {
    const recordsDir = path.join(root, 'sessions', 'real-orphan', 'records')
    await writeFile(path.join(recordsDir, 'v3r-' + hex16(999) + '.json'), JSON.stringify(recordOf(999, 'real-orphan')) + '\n', 'utf8')
    const store = await openV3SessionStore(root, 'real-orphan')
    const health = store.health()
    assert.equal(health.healthy, true, '有 commit 行的正常库不得被判损坏')
    assert.deepEqual(health.orphanedAtOpen, ['v3r-' + hex16(999)], '无 commit 的 payload 仍要隔离')
    assert.equal(health.recordCount, 3)
    store.close()
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})

test('H-21 回归：全新会话（无日志无记录）仍 healthy', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-v3-fresh-'))
  try {
    const store = await openV3SessionStore(root, 'fresh')
    const health = store.health()
    assert.equal(health.healthy, true, '首启不得被判损坏')
    assert.equal(health.damagedReason, null)
    assert.deepEqual(health.orphanedAtOpen, [])
    store.close()
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})
