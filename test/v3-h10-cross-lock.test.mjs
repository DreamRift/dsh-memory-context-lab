import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createSessionStorePort } from '../src/v3/adapters/storage/session-store-port.mjs'

let seqN = 0
function rec(id, text) {
  seqN += 1
  const body = text ?? ('正文 ' + id)
  return {
    id: 'v3r-' + String(id).padStart(16, '0'),
    kind: 'message-user',
    sessionKey: 's-h10',
    createdAt: 1770000000000 + seqN,
    payload: { text: body, bytes: Buffer.byteLength(body, 'utf8') },
    provenance: { sourceEventId: 'ev-' + String(seqN).padStart(8, '0'), sourceForm: null, transactionId: 'tx-h10-' + String(seqN).padStart(6, '0') },
  }
}

test('H-10-a/b：跨进程锁串行 + 多句柄锁内视图同步（rebuild 不漏新提交）', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-h10-'))
  try {
    // 句柄 A、B 同时打开同一会话目录（模拟两个 DSH 进程/同进程双句柄）
    const a = await createSessionStorePort(root, 's-h10')
    const b = await createSessionStorePort(root, 's-h10')

    // A 先提交一条
    await a.port.transaction([rec('1', '甲号记录正文')])

    // B 的内存视图是打开时快照（看不到 r1）；写路径在锁内先 syncFromLog，
    // 因此 B 提交自己的记录不应与 A 冲突，且 B 的 rebuildIndex 不漏 r1。
    await b.port.transaction([rec('2', '乙号记录正文')])

    const idsB = await b.store.listRecordIds()
    assert.ok(idsB.includes('v3r-0000000000000001'), 'B 锁内同步后能看到 A 提交的 r1（H-10-b 增量合并）')
    assert.ok(idsB.includes('v3r-0000000000000002'), 'B 自己的 r2 在')

    // A 再看 B 的提交（A 下次写时同样锁内同步）
    await a.port.transaction([rec('3', '丙号记录正文')])
    const idsA = await a.store.listRecordIds()
    assert.ok(idsA.includes('v3r-0000000000000002') && idsA.includes('v3r-0000000000000003'), 'A 锁内同步后看到 B 的 r2 与自己的 r3')

    // 并发事务：两个句柄同时提交不冲突不撞号（跨进程锁 + 进程内队列串行化）
    const [ra, rb] = await Promise.allSettled([
      a.port.transaction([rec('4', '并发甲')]),
      b.port.transaction([rec('5', '并发乙')]),
    ])
    assert.equal(ra.status, 'fulfilled', '并发提交 A 成功')
    assert.equal(rb.status, 'fulfilled', '并发提交 B 成功')

    // 索引重建走锁内同步：B 重建后 r4/r5 都在索引里
    const out = await b.port.rebuildIndex()
    assert.ok(out.indexedCount >= 5, 'B 锁内重建索引包含全部 5 条（不漏他方提交），实际 ' + out.indexedCount)

    // 写后锁目录应被清理（每次事务取锁、结束即释放）
    const lockDir = path.join(root, 'sessions/s-h10', '.write-lock')
    const { stat } = await import('node:fs/promises')
    await assert.rejects(() => stat(lockDir), '锁释放后目录清除（不留常驻锁）')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
