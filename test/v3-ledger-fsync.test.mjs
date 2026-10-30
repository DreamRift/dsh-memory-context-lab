/**
 * B3-5（AUD50-03-04）账本追加落盘——commit 行 / vouchers / forgotten / redactions 追加
 * 走 fsync（提交点必须落盘）；打开期把「manifest 已推进但日志无 commit」报告为
 * commit-lost（health.commitLostAtOpen），不只当 orphan 静默隔离；号不复用不回退。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { openV3SessionStore } from '../src/v3/adapters/storage/session-store.mjs'

function hex16(n) { return n.toString(16).padStart(16, '0') }

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
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-v3-fsync-'))
  const store = await openV3SessionStore(root, sessionKey)
  for (let i = 1; i <= count; i += 1) await store.submitTransaction([recordOf(i, sessionKey)])
  store.close()
  return root
}

test('B3-5 掉电等价：commit 行丢失但 manifest 已推进 → commit-lost 可见、号不复用', async () => {
  const root = await seededSession('commit-lost', 2)
  try {
    const dir = path.join(root, 'sessions', 'commit-lost')
    const log = await readFile(path.join(dir, 'transactions.jsonl'), 'utf8')
    const kept = log.split('\n').filter((line) => {
      if (line.trim().length === 0) return true
      const parsed = JSON.parse(line)
      return !(parsed.action === 'commit' && parsed.txn === 2)
    }).join('\n')
    await writeFile(path.join(dir, 'transactions.jsonl'), kept, 'utf8')
    const store = await openV3SessionStore(root, 'commit-lost')
    try {
      const health = store.health()
      assert.equal(health.healthy, true, '崩溃残留语义不回退（隔离、不判损坏）')
      assert.deepEqual(health.orphanedAtOpen, ['v3r-' + hex16(2)], '无 commit 的 payload 照旧隔离（字节保留）')
      assert.ok(health.commitLostAtOpen, 'commit 丢失必须可见，不得静默')
      assert.equal(health.commitLostAtOpen.gap, 1)
      assert.equal(health.commitLostAtOpen.missingFrom, 2)
      assert.equal(health.commitLostAtOpen.missingTo, 2)
      assert.equal(health.commitLostAtOpen.orphanedCount, 1)
      const next = await store.submitTransaction([recordOf(9, 'commit-lost')])
      assert.equal(next.txn, 3, '号不复用：跳过丢失的 2 号')
    } finally {
      store.close()
    }
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})

test('B3-5 正常库无缺口：commitLostAtOpen 为 null', async () => {
  const root = await seededSession('no-gap', 3)
  try {
    const store = await openV3SessionStore(root, 'no-gap')
    try {
      assert.equal(store.health().commitLostAtOpen, null)
    } finally {
      store.close()
    }
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})

test('B3-5 静态守卫：提交点走 fsync，可重建缓存不走（性能面不回退）', async () => {
  const { fileURLToPath } = await import('node:url')
  const src = await readFile(fileURLToPath(new URL('../src/v3/adapters/storage/session-store.mjs', import.meta.url)), 'utf8')
  const lines = src.split('\n')
  const syncCalls = lines.filter((l) => l.includes('appendLine(') && l.includes('{ sync: true }'))
  assert.equal(syncCalls.length, 5, 'commit + vouchers + forget + revoke + redaction 共 5 个提交点')
  assert.ok(syncCalls.every((l) => /logPath, commitLine|vouchersPath, voucher|forgottenPath|redactionsPath/.test(l)), 'fsync 只落在提交点')
  const plainAppends = lines.filter((l) => /appendLine\(path\.join/.test(l) && !l.includes('{ sync: true }'))
  assert.ok(plainAppends.every((l) => /REPAIR_LOG|CHECKPOINT_LOG/.test(l)), 'repair 审计/检查点缓存保持非 fsync 路径')
})
