/**
 * 0.13.2 守卫：v2 存储层的四处失败关闭缺口（D-03 / D-15 / D-16 / D-17 / D-18）。
 *
 * ## 缺陷
 * - **D-03**：`commitTransaction` 不参与 `stageRecord` 的串行队列。调用方少 await 一个
 *   stage 时，commit 落完 `committedAt`，那个 stage 醒来又把整文件重写成
 *   `committedAt: null`——已提交事务被回写为「未提交」，重启对账整事务进隔离区，
 *   commit 却返回成功。
 * - **D-15**：`maxBytes = 0 / 负数 / NaN / "10"` 让有界判据恒 false，静默退化为读全文
 *   （`integrity:'ok'`），预算栅栏失效。
 * - **D-16**：`offsetBytes = 1.5` 的 TypeError 被 catch-all 伪装成 `payload-unreadable`，
 *   与真 IO 损坏不可区分。
 * - **D-17**：隐式事务号没有上界校验 → 9 位文件名不被识别 → 该会话写路径永久不可用。
 * - **D-18**：abandon / 空提交 `rm` 掉意图文件后，重启对账看不到该号 → 号被复用，
 *   同一 ID 指向另一条正文。
 *
 * ## 判据（改回去必红）
 * 全部以「失败关闭 + code 明确」为断言，不依赖日志文本。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { V2SessionStore, MAX_TRANSACTION_NUMBER } from '../src/v2/store.mjs'
import { RECORD_KINDS, draftRecord } from '../src/v2/records.mjs'
import { EngineV2Error } from '../src/v2/errors.mjs'
import { v2SessionDirectoryFor } from '../src/v2/state.mjs'

async function withLab(body) {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-store-guard-'))
  try {
    return await body(root)
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
}

function spanDraft(text, seq = 1) {
  return draftRecord({
    kind: RECORD_KINDS.PROJECTION_SPAN,
    seq,
    fidelity: 'synthesized',
    refs: { sourceKinds: ['assistant.text'], sourceSeqs: [seq], spanKind: 'operation' },
    inline: { label: '测试跨度', range: { start: seq, end: seq } },
    content: text,
  })
}

test('D-03：commit 必须先排空在途 stage；之后的 stage 失败关闭而不是把提交标记回写掉', async () => {
  await withLab(async (labRoot) => {
    const sessionId = 'd03'.padEnd(24, '0')
    const store = await V2SessionStore.init({ labRoot, sessionId })
    try {
      const handle = await store.openTransaction()
      const inFlight = store.stageRecord(handle, spanDraft('在途正文'))
      const committed = await store.commitTransaction(handle)
      assert.equal(committed.recordCount, 1, 'commit 必须等排队中的 stage 落库后再提交')

      // commit 之后的 stage 必须失败关闭（句柄已 closed）。
      await assert.rejects(
        () => store.stageRecord(handle, spanDraft('迟到正文', 2)),
        (error) => error instanceof EngineV2Error && error.code === 'EINVAL',
      )
      await inFlight.catch(() => {})

      const transactionFile = path.join(v2SessionDirectoryFor(labRoot, sessionId), 'transactions', `txn-${String(handle.txn).padStart(8, '0')}.json`)
      const data = JSON.parse(await readFile(transactionFile, 'utf8'))
      assert.equal(typeof data.committedAt, 'string', '已提交事务不得被回写为未提交')
    } finally {
      store.close()
    }
  })
})

test('D-15／D-16：非法 maxBytes 与 offsetBytes 一律 EINVAL，不静默读全文、不伪装成损坏', async () => {
  await withLab(async (labRoot) => {
    const sessionId = 'd15'.padEnd(24, '0')
    const store = await V2SessionStore.init({ labRoot, sessionId })
    try {
      const handle = await store.openTransaction()
      const staged = await store.stageRecord(handle, spanDraft('0123456789'.repeat(20)))
      await store.commitTransaction(handle)

      for (const bad of [0, -5, Number.NaN, '10', 1.5]) {
        await assert.rejects(
          () => store.readRecord(staged.id, { maxBytes: bad }),
          (error) => error instanceof EngineV2Error && error.code === 'EINVAL',
          `maxBytes=${String(bad)} 必须 EINVAL（否则会静默读全文）`,
        )
      }
      for (const bad of [1.5, -1, Number.NaN, '0']) {
        await assert.rejects(
          () => store.readRecord(staged.id, { offsetBytes: bad }),
          (error) => error instanceof EngineV2Error && error.code === 'EINVAL',
          `offsetBytes=${String(bad)} 必须 EINVAL（不是 payload-unreadable）`,
        )
      }
      const ok = await store.readRecord(staged.id, { maxBytes: 10 })
      assert.equal(ok.integrity, 'prefix')
      assert.equal(ok.truncated, true)
      assert.equal(ok.payloadText, '0123456789')
    } finally {
      store.close()
    }
  })
})

test('D-17：隐式事务号越界必须带 code 失败关闭，不得写出 9 位文件名', async () => {
  await withLab(async (labRoot) => {
    const sessionId = 'd17'.padEnd(24, '0')
    const store = await V2SessionStore.init({ labRoot, sessionId })
    try {
      const top = await store.openTransaction({ txn: MAX_TRANSACTION_NUMBER })
      await assert.rejects(
        () => store.openTransaction(),
        (error) => error instanceof EngineV2Error && error.code === 'ELIMIT',
        '隐式路径越过上界必须 ELIMIT，而不是写出重启后不被承认的 9 位文件名',
      )
      await store.abandonTransaction(top)
      const rows = await readdir(path.join(v2SessionDirectoryFor(labRoot, sessionId), 'transactions')).catch(() => [])
      assert.equal(rows.some((name) => /^txn-\d{9,}\.json$/.test(name)), false, `不得出现 9 位事务文件：${rows.join(', ')}`)
    } finally {
      store.close()
    }
  })
})

test('D-18：abandon 与空提交都退役进隔离区（号不复用），不再直接删文件', async () => {
  await withLab(async (labRoot) => {
    const sessionId = 'd18'.padEnd(24, '0')
    const store = await V2SessionStore.init({ labRoot, sessionId })
    let abandonedTxn
    try {
      const abandoned = await store.openTransaction()
      abandonedTxn = abandoned.txn
      await store.stageRecord(abandoned, spanDraft('放弃的正文'))
      const outcome = await store.abandonTransaction(abandoned)
      assert.equal(outcome.abandoned, true)
      const empty = await store.openTransaction()
      await store.commitTransaction(empty) // 空事务
    } finally {
      store.close()
    }

    const quarantine = path.join(v2SessionDirectoryFor(labRoot, sessionId), 'quarantine')
    const rows = await readdir(quarantine).catch(() => [])
    assert.ok(
      rows.some((name) => name.startsWith(`txn-${String(abandonedTxn).padStart(8, '0')}.json.abandoned.`)),
      `被放弃的事务必须留在隔离区（号继续占用）：${rows.join(', ')}`,
    )

    // 重开后事务号不得回落复用。
    const reopened = await V2SessionStore.open({ labRoot, sessionId })
    try {
      const next = await reopened.openTransaction()
      assert.ok(next.txn > abandonedTxn, `重开后不得复用已退役事务号（得到 ${next.txn}，放弃的是 ${abandonedTxn}）`)
      await reopened.abandonTransaction(next)
    } finally {
      reopened.close()
    }
  })
})
