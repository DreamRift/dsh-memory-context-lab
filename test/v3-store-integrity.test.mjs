/**
 * 存储完整性守卫（beta.11 第三轮排查）：账本写闸 + 会话归属。
 *
 * 两条不变量：
 * 1. **账本自己损坏时不得再写它**：解析器遇首个坏行即停，新行落在坏行之后 → 写成功、
 *    永不可读，而 `health()` 只看 damagedReason，患者看起来「写进去了」。账本不可判定
 *    = 不允许产生新事实（与「读不到 ≠ 没有」同一条纪律的写侧）。
 *    注意故障面是**按账本独立**的：记录写入不因遗忘账本损坏而锁死（H-09 已定口径）。
 * 2. **记录必须属于本会话**：结构性校验只保证「是一条合法记录」，把另一会话的记录文件
 *    拷进来同样合法——会话隔离是硬不变量，读路径必须自己确认归属。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { openV3SessionStore } from '../src/v3/adapters/storage/session-store.mjs'

function record(id, text, sessionKey = 's') {
  return {
    id,
    kind: 'message-user',
    sessionKey,
    createdAt: 1792845000000,
    payload: { text, bytes: Buffer.byteLength(text, 'utf8') },
    provenance: { sourceEventId: 'dsh-1', sourceForm: null, transactionId: 'tx-1' },
  }
}

async function withRoot(body) {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-store-integrity-'))
  try {
    return await body(root)
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
}

test('遗忘账本损坏 → forget 拒绝追加（记录写入仍可用：独立故障面）', async () => {
  await withRoot(async (root) => {
    const first = await openV3SessionStore(root, 's')
    await first.submitTransaction([record('v3r-0000000000000001', '甲')])
    first.close()

    await writeFile(path.join(root, 'sessions', 's', 'forgotten.jsonl'), 'BROKEN-NOT-JSON\n', 'utf8')
    const store = await openV3SessionStore(root, 's')
    try {
      assert.equal(store.health().forgottenDamaged, true)
      await assert.rejects(
        () => store.forget('v3r-0000000000000001'),
        (error) => error?.code === 'ESTORE_DAMAGED',
        '向损坏账本追加遗忘只会产生不可读行（看着成功、实际永不生效）',
      )
      // 独立故障面：记录写入不因遗忘账本损坏而锁死
      const txn = await store.submitTransaction([record('v3r-0000000000000002', '乙')])
      assert.equal(txn.recordIds.length, 1)
    } finally {
      store.close()
    }
  })
})

test('凭证账本损坏 → appendVoucher 拒绝追加', async () => {
  await withRoot(async (root) => {
    const first = await openV3SessionStore(root, 's')
    await first.submitTransaction([record('v3r-0000000000000010', '甲')])
    first.close()

    await writeFile(path.join(root, 'sessions', 's', 'vouchers.jsonl'), 'BROKEN-NOT-JSON\n', 'utf8')
    const store = await openV3SessionStore(root, 's')
    try {
      await assert.rejects(
        () => store.appendVoucher({ recordIds: ['v3r-0000000000000010'], targetEventId: 'dsh-1', receiptText: '回执', txn: 1 }),
        (error) => error?.code === 'ESTORE_DAMAGED',
        '坏行之后追加的凭证永远解析不到，必须拒绝而不是假成功',
      )
    } finally {
      store.close()
    }
  })
})

test('跨会话记录不得当作本会话事实：写入与读取两侧都拒', async () => {
  await withRoot(async (root) => {
    const a = await openV3SessionStore(root, 'a')
    await a.submitTransaction([record('v3r-0000000000000020', '甲会话的正文', 'a')])
    a.close()

    const b = await openV3SessionStore(root, 'b')
    try {
      // 写入侧：结构合法但 sessionKey 属于别的会话 → 直接拒绝
      await assert.rejects(
        () => b.submitTransaction([record('v3r-0000000000000021', '外来正文', 'a')]),
        (error) => error?.code === 'ESTORE_SESSION_MISMATCH',
        '不属于本会话的记录必须拒绝写入（不能先污染再在读路径报错）',
      )
      // 读取侧：盘上被人手工放入一条「合法但属于别的会话」的记录（带 commit 行）
      const foreign = record('v3r-0000000000000020', '甲会话的正文', 'a')
      await copyFile(
        path.join(root, 'sessions', 'a', 'records', 'v3r-0000000000000020.json'),
        path.join(root, 'sessions', 'b', 'records', 'v3r-0000000000000020.json'),
      )
      const txnLog = path.join(root, 'sessions', 'b', 'transactions.jsonl')
      await writeFile(txnLog, JSON.stringify({ action: 'commit', txn: 99, recordIds: [foreign.id] }) + '\n', 'utf8')
      const manifestPath = path.join(root, 'sessions', 'b', 'manifest.json')
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
      await writeFile(manifestPath, JSON.stringify({ ...manifest, txnNext: 100 }) + '\n', 'utf8')
    } finally {
      b.close()
    }

    const b2 = await openV3SessionStore(root, 'b')
    try {
      await assert.rejects(
        () => b2.readRecord('v3r-0000000000000020'),
        (error) => error?.code === 'ESTORE_SESSION_MISMATCH',
        '跨会话记录必须在读路径被拒（隔离是硬不变量）',
      )
    } finally {
      b2.close()
    }
  })
})
