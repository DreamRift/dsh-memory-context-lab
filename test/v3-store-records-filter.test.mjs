/**
 * AUD50-03-03（B2-6）：records/ 非 .json 残留被算作记录。
 *
 * 修前：recordsOnDisk = readdir(records/) 全收——全新库里只放一个崩溃 .tmp，
 * 重开就报「transactions.jsonl 缺失但记录仍在（1 条…）」判 damaged；真实记录
 * 0 条，.tmp 永不清理。修法：records/ 只认 v3r-<16 位十六进制>.json；
 * 非 .json 残留打开期移入 quarantine（字节保留），health 报告 leftoversAtOpen；
 * 目录读失败（EACCES 等）向上抛，失败关闭。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { openV3SessionStore } from '../src/v3/adapters/storage/session-store.mjs'

async function withRoot(body) {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-v3-records-filter-'))
  try {
    return await body(root)
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
}

const RECORD_ID = "v3r-" + "ab".repeat(8)

test('B2-6 全新库 + 崩溃 .tmp：不判 damaged，残留移入 quarantine', async () => {
  await withRoot(async (root) => {
    const recordsDir = path.join(root, 'sessions', 's-tmp', 'records')
    await mkdir(recordsDir, { recursive: true })
    // writeFileAtomic 的崩溃临时名形状：.<原名>.<uuid>.tmp
    await writeFile(path.join(recordsDir, '.' + RECORD_ID + '.json.deadbeef.tmp'), '{"partial":true')
    await writeFile(path.join(recordsDir, 'desktop.ini'), 'junk')
    const store = await openV3SessionStore(root, 's-tmp')
    try {
      const health = store.health()
      assert.equal(health.healthy, true, JSON.stringify(health))
      assert.equal(health.recordCount, 0, ".tmp 不被算作记录")
      assert.equal(health.damagedReason, null)
      assert.equal(health.leftoversAtOpen.length, 2, '非记录残留要在 health 报告')
      assert.deepEqual(await readdir(recordsDir), [], 'records/ 里的残留已清走')
      const quarantine = await readdir(path.join(root, 'sessions', 's-tmp', 'quarantine'))
      assert.equal(quarantine.length, 2, "残留字节保留在 quarantine（可人工审计）")
    } finally {
      store.close()
    }
  })
})

test('B2-6 合法 orphan .json 仍被隔离（既有语义不回退）', async () => {
  await withRoot(async (root) => {
    const recordsDir = path.join(root, 'sessions', 's-orphan', 'records')
    await mkdir(recordsDir, { recursive: true })
    const record = { id: RECORD_ID, kind: "message-user", sessionKey: "s-orphan", createdAt: 1, payload: { text: "残留", bytes: 6 }, provenance: { sourceEventId: "evt-1", sourceForm: "live", transactionId: "tx-x" } }
    await writeFile(path.join(recordsDir, RECORD_ID + '.json'), JSON.stringify(record))
    // 日志文件在（空）：有日志、无 commit 行 → 该记录是崩溃残留；若日志整个缺失
    // 则按 H-21 判 damaged（对账依据丢失），那是另一条既有路径。
    await writeFile(path.join(root, 'sessions', 's-orphan', 'transactions.jsonl'), '')
    const store = await openV3SessionStore(root, 's-orphan')
    try {
      const health = store.health()
      assert.equal(health.healthy, true)
      assert.deepEqual(health.orphanedAtOpen, [RECORD_ID], '无 commit 行的合法记录名仍按崩溃残留隔离')
    } finally {
      store.close()
    }
  })
})

test('B2-6 目录读失败（EACCES）失败关闭：不吞错误、不当空目录', async () => {
  await withRoot(async (root) => {
    await assert.rejects(
      openV3SessionStore(root, 's-eacces', { readdir: async () => { const error = new Error('denied'); error.code = 'EACCES'; throw error } }),
      (error) => error.code === 'EACCES',
    )
  })
})
