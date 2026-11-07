/**
 * T-01 守卫（0.15.4，P1）：提交路径必须有**追加门**。
 *
 * ## 缺陷（计划 §10.2 事务故障组的直接违背）
 *
 * `damaged` 是**打开期快照**。账本在飞期间被别处撕坏（磁盘满、断电、另一进程半写）时
 * 它不会更新。旧 `submitTransaction` 的 commit 行是裸 `appendLine`：
 *
 *   1. 打开库（healthy）→ `damaged=false` 这个结论被缓存；
 *   2. 期间 transactions.jsonl 尾部被撕出半行；
 *   3. `submitTransaction` 照旧追加 commit 行 → 落在坏行之后；
 *   4. 重开：整库判定 damaged → **读允许、写拒绝**；
 *   5. `repair` 只截尾部半行，而坏行已在中间 → 报「无需修复」。
 *
 * 净效果：**提交看起来成功，重开后整库不可写**，且自动修复说没事。
 *
 * ## 修法
 *
 * 提交前用与 checkpoint 同一实现（`inspectAppendTail`）判尾部可追加；
 * 不可追加就**拒绝本笔**，保留已落盘的 payload 作为可恢复残留（重试可用新事务补账），
 * 绝不假成功。这是计划 §5.5-4「一个追加门」的落实。
 *
 * ## 钉住的判据
 *
 * 1. 尾部有半行 → `submitTransaction` **抛 ESTORE_DAMAGED**（不返回成功）；
 * 2. 抛错时**不写 commit 行**（账本字节数不变）；
 * 3. 尾部完好 → 正常提交（不回归）；
 * 4. 拒绝对已打开库发生后写入（不是只在打开期判）。
 *
 * ## 不适用条件
 *
 * - 不测跨进程真并发撕裂（`v3-lock-*` 覆盖锁；这里直接构造坏尾部）；
 * - 不测 `repair` 的中段损坏判定（`v3-store-repair` 既有职责）；
 * - 不测 payload 清理策略（既有 `scrub` 职责）。
 *
 * ## 变异自证
 *
 * 删掉追加门那几行 → 用例 1、2 红（提交假成功）；恢复 → 全绿。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createSessionStorePort } from '../src/v3/adapters/storage/session-store-port.mjs'

const TXN_LOG = 'transactions.jsonl'

async function openFresh(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-t01-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { port, store } = await createSessionStorePort(root, 'session-t01')
  return { root, port, store, dir: store.directory }
}

/** 构造一条结构合法的记录（形状以 contracts/records.mjs 为准）。 */
function recordOf(seq) {
  const text = '记录正文' + seq
  return {
    id: 'v3r-' + String(seq).padStart(16, '0'),
    kind: 'message-user',
    sessionKey: 'session-t01',
    createdAt: 1700000000000 + seq,
    payload: { text, bytes: Buffer.byteLength(text, 'utf8') },
    provenance: { transactionId: 'txn-test-' + seq, sourceEventId: 'event-' + seq, sourceForm: null },
  }
}

test('T-01：尾部有半行时，提交必须失败关闭（不得假成功）', async (t) => {
  const { port, dir } = await openFresh(t)
  const txnPath = path.join(dir, TXN_LOG)
  // 先正常提交一笔，让账本里有完整行
  await port.transaction([recordOf(1)], { at: 1 })
  // 模拟「在飞期间被撕坏」：尾部追加一个半行（无结尾换行、JSON 不完整）
  await writeFile(txnPath, await readFile(txnPath, 'utf8') + '{"action":"commit","txn":99,"recordIds":[', 'utf8')

  await assert.rejects(
    () => port.transaction([recordOf(2)], { at: 2 }),
    (error) => error?.code === 'ESTORE_DAMAGED',
    '尾部不可追加时必须抛 ESTORE_DAMAGED，不得返回成功',
  )
})

test('T-01：失败时不得写 commit 行（账本字节数不变）', async (t) => {
  const { port, dir } = await openFresh(t)
  const txnPath = path.join(dir, TXN_LOG)
  await port.transaction([recordOf(1)], { at: 1 })
  await writeFile(txnPath, await readFile(txnPath, 'utf8') + '{"half":', 'utf8')
  const before = (await readFile(txnPath, 'utf8')).length

  await assert.rejects(() => port.transaction([recordOf(2)], { at: 2 }))
  const after = (await readFile(txnPath, 'utf8')).length
  assert.equal(after, before, '拒绝提交时账本一个字节都不该多出来')
})

test('T-01 不回归：尾部完好时正常提交', async (t) => {
  const { port } = await openFresh(t)
  const result = await port.transaction([recordOf(3)], { at: 3 })
  assert.ok(Number.isInteger(result?.txn), '正常提交必须返回事务号，实际：' + JSON.stringify(result))
})

test('T-01：追加门在**已打开**的库上生效（不是只在打开期判）', async (t) => {
  const { port, dir } = await openFresh(t)
  const txnPath = path.join(dir, TXN_LOG)
  await port.transaction([recordOf(4)], { at: 4 })
  // 同一个已打开的句柄：先把账本撕坏，再提交
  await writeFile(txnPath, await readFile(txnPath, 'utf8') + '{"torn":', 'utf8')
  await assert.rejects(
    () => port.transaction([recordOf(5)], { at: 5 }),
    (error) => error?.code === 'ESTORE_DAMAGED',
    '打开期快照不得成为免检依据',
  )
})
