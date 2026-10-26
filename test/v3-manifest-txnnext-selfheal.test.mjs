/**
 * manifest.txnNext 的打开期自愈（H-56，2026-10-26）。
 *
 * ## 缺陷
 * 打开期只比 `txnNext <= maxTxn`，不校验它是不是**合法事务号**。于是：
 * - `1.5` / `"7"` / `undefined` 漏过打开期 → `open` 成功、`health.txnNext` 原样回显
 *   垃圾值（`1.5` / `"7"` / `undefined`），而**每一次写入**都在
 *   `rereadManifestTxnNext` 里抛 `ESTORE_CORRUPT`——存储自称健康却永远写不进去，
 *   观察面也看不到根因。
 *
 * ## 判据
 * `txnNext` 必须是 **≥1 的整数**；不合法（或 `<= maxTxn`）一律自愈为 `maxTxn+1`。
 * 自愈方向确定且可证明安全：`maxTxn` 取自事务日志，`maxTxn+1` 一定没被用过。
 *
 * ## 不适用条件
 * 只修「打开期漏校验」；`rereadManifestTxnNext`（每次提交前重读）的失败关闭语义不变
 * ——真损坏（文件缺失/不可解析/会话不符）仍抛错，不自愈。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { openV3SessionStore } from '../src/v3/adapters/storage/session-store.mjs'

function recordOf(n) {
  const text = '正文' + n
  return {
    id: 'v3r-' + String(n).padStart(16, '0'),
    kind: 'message-user',
    sessionKey: 's',
    createdAt: 1700000000000 + n,
    payload: { text, bytes: Buffer.byteLength(text, 'utf8') },
    provenance: { sourceEventId: 'dsh-' + n, sourceForm: 'text', transactionId: 'txn-' + n },
  }
}

async function seededWithBadTxnNext(bad) {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-txnnext-'))
  const store = await openV3SessionStore(root, 's')
  await store.submitTransaction([recordOf(1)])
  store.close()
  const manifestPath = path.join(root, 'sessions', 's', 'manifest.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  if (bad === undefined) delete manifest.txnNext
  else manifest.txnNext = bad
  await writeFile(manifestPath, JSON.stringify(manifest) + '\n', 'utf8')
  return root
}

const BAD_VALUES = [
  ['小数', 1.5],
  ['数字字符串', '7'],
  ['缺字段', undefined],
  ['NaN', NaN],
  ['零', 0],
  ['负数', -5],
  ['null', null],
]

for (const [label, bad] of BAD_VALUES) {
  test('H-56 txnNext=' + label + ' → 打开期自愈为合法整数且可写', async () => {
    const root = await seededWithBadTxnNext(bad)
    const store = await openV3SessionStore(root, 's')
    const health = store.health()
    assert.ok(Number.isInteger(health.txnNext) && health.txnNext >= 1, 'health.txnNext 必须是合法整数，得到 ' + JSON.stringify(health.txnNext))
    assert.equal(health.healthy, true, '自愈后应是健康库')
    await store.submitTransaction([recordOf(2)])
    assert.equal(store.health().recordCount, 2)
    store.close()
  })
}

test('H-56 自愈值确定：maxTxn+1，不复用旧号', async () => {
  const root = await seededWithBadTxnNext(1.5)
  const store = await openV3SessionStore(root, 's')
  assert.equal(store.health().txnNext, 2, 'maxTxn=1 → txnNext 必须是 2')
  store.close()
})

test('H-56 合法值不受影响：不回退、不重写', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-txnnext-ok-'))
  const store = await openV3SessionStore(root, 's')
  await store.submitTransaction([recordOf(1)])
  const before = store.health().txnNext
  store.close()
  const reopened = await openV3SessionStore(root, 's')
  assert.equal(reopened.health().txnNext, before, '合法值必须原样保留')
  reopened.close()
})
