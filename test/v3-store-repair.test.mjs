/**
 * G-A / G-B（0.14.0-beta.48）：日志尾部半行自动修复 + 「读不到 ≠ 没有」。
 *
 * 用户口径：A（写锁内截断尾部半行自动恢复）+ B（/memory-lab repair 手动/审计）。
 * 红线：只认「尾部无换行且 JSON 不可解析」的半行；锁内重读；只截到最后一个完整行；
 * 中段损坏与完整行解析失败一律失败关闭；截断后按现有 payload/commit/manifest 对账；
 * 修复写审计记录（repair-log.jsonl，先写审计再改字节）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { openV3SessionStore, repairSessionJournals, inspectJournalFile } from '../src/v3/adapters/storage/session-store.mjs'
import { createSessionStorePort } from '../src/v3/adapters/storage/session-store-port.mjs'

function record(id, text = '正文') {
  return {
    id,
    kind: 'message-user',
    sessionKey: 's-repair',
    createdAt: 1,
    payload: { text, bytes: Buffer.byteLength(text, 'utf8') },
    provenance: { sourceEventId: 'dsh-1-' + id, sourceForm: 'event', transactionId: 't-' + id },
  }
}

async function newStore(root) {
  const store = await openV3SessionStore(root, 's-repair')
  await store.submitTransaction([record('v3r-aaaaaaaaaaaaaaaa', '第一段')])
  return store
}

test('尾部半行：dry-run 不动字节；apply 截断 + 写审计 + 重开后继续分配事务号', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-repair-'))
  try {
    const store = await newStore(root)
    const dir = store.directory
    store.close()
    const logPath = path.join(dir, 'transactions.jsonl')
    const beforeBytes = await readFile(logPath)
    await appendFile(logPath, '{"action":"commit","txn":2,"recordIds":["v3r-', 'utf8')

    const inspected = await inspectJournalFile(logPath, 'transactions.jsonl')
    assert.equal(inspected.state, 'tail-half-line', JSON.stringify(inspected))
    assert.equal(inspected.keptBytes, beforeBytes.length)

    const dry = await repairSessionJournals(dir, { dryRun: true })
    assert.equal(dry.changed, false)
    assert.equal((await readFile(logPath)).length, beforeBytes.length + Buffer.byteLength('{"action":"commit","txn":2,"recordIds":["v3r-'), 'dry-run 不得改字节')
    assert.equal(dry.files.find((row) => row.file === 'transactions.jsonl').state, 'tail-half-line')

    const applied = await repairSessionJournals(dir)
    assert.equal(applied.changed, true)
    assert.equal(applied.repaired.length, 1)
    assert.equal(applied.repaired[0].file, 'transactions.jsonl')
    assert.equal((await readFile(logPath)).length, beforeBytes.length, '只截到最后一个完整行')
    const auditText = await readFile(path.join(dir, 'repair-log.jsonl'), 'utf8')
    const audit = JSON.parse(auditText.trim().split('\n')[0])
    assert.equal(audit.file, 'transactions.jsonl')
    assert.equal(audit.removedBytes > 0, true)
    assert.match(audit.removedPreview, /^\{"action":"commit"/)

    const reopened = await openV3SessionStore(root, 's-repair')
    assert.equal(reopened.health().healthy, true, JSON.stringify(reopened.health()))
    const txn = await reopened.submitTransaction([record('v3r-bbbbbbbbbbbbbbbb', '第二段')])
    assert.equal(txn.txn, 2, '修复后事务号从完整行之后继续，不复用')
    reopened.close()
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})

test('中段/完整行损坏不自动截断（失败关闭，字节不动）', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-repair-mid-'))
  try {
    const dir = path.join(root, 'sessions', 's-repair')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(dir, { recursive: true })
    const logPath = path.join(dir, 'transactions.jsonl')
    const original = '{"action":"commit","txn":1,"recordIds":["a"]}\n{坏行}\n{"action":"commit","txn":2,"recordIds":["b"]}\n'
    await writeFile(logPath, original, 'utf8')
    const inspected = await inspectJournalFile(logPath, 'transactions.jsonl')
    assert.equal(inspected.state, 'damaged', JSON.stringify(inspected))
    const applied = await repairSessionJournals(dir)
    assert.equal(applied.changed, false, '中段损坏不得被截断')
    assert.equal(await readFile(logPath, 'utf8'), original)
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})

test('createSessionStorePort：打开时自动修复尾部半行，库恢复可写', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-repair-open-'))
  try {
    const store = await newStore(root)
    store.close()
    await appendFile(path.join(store.directory, 'transactions.jsonl'), '{"action":"commit","txn":2,"recordIds":["v3r-', 'utf8')
    const { port } = await createSessionStorePort(root, 's-repair')
    assert.equal((await port.health()).healthy, true, '打开期自动截断后应恢复健康')
    const txn = await port.transaction([record('v3r-cccccccccccccccc', '第三段')])
    assert.equal(txn.txn, 2)
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})

test('G-B：fileExists 只吞 ENOENT；stat 报 EACCES 必须失败关闭（不重建 manifest/txn 号）', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-repair-eacces-'))
  try {
    const denied = async () => {
      const error = new Error('access denied')
      error.code = 'EACCES'
      throw error
    }
    await assert.rejects(
      () => openV3SessionStore(root, 's-repair', { stat: denied }),
      (error) => error.code === 'EACCES',
      '读不到不得被当成「没有」',
    )
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})
