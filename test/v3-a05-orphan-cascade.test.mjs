/**
 * A-05 守卫（0.15.4 全面排查）：孤儿回执必须进入遗忘/清除级联。
 *
 * 旧缺陷（实跑确证）：`orphan-receipts.jsonl` 里存的是**明文回执正文**，却完全不在
 * 遗忘级联里。于是 forget/purge 之后：
 *   ① 这段明文永久留在盘上（隐私承诺失效）；
 *   ② 因为没有对应凭证，`restore` 恒 `receipt-changed`——既不可恢复，也不可清除。
 *
 * 修法：store 新增 `redactOrphansFor`（正文换成常量、记 redacted 与清除时间，
 * 保留 recordIds 作审计）；`forgetRecords` 在删正文之前调用；`restoreOrphan`
 * 见到 `redacted` 明确报 `orphan-redacted`（不可恢复要说清，不许含糊成 receipt-changed）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { openV3SessionStore } from '../src/v3/adapters/storage/session-store.mjs'

const withStore = async (body) => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-a05-'))
  const store = await openV3SessionStore(root, 'a05')
  try {
    return await body(store, root)
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
}

const orphanRow = (seq, recordIds) => ({
  receiptSeq: seq,
  receiptText: '[记忆上下文] 已把 ' + seq + ' 条历史归档为回执。正文里有敏感内容 AAAAA' + seq,
  recordIds,
  startSeq: seq,
  endSeq: seq + 10,
})

test('A-05：遗忘必须把孤儿回执正文清除掉，且账本里不再有明文', async () => {
  await withStore(async (store, root) => {
    const added = await store.appendOrphanReceipt(orphanRow(11, ['r1', 'r2']))
    assert.equal(added.changed, true, '夹具：孤儿回执应写入成功')
    const before = store.listOrphanReceipts()
    assert.equal(before.length, 1)
    assert.equal(before[0].receiptText.includes('敏感内容'), true, '夹具：写入时是明文')

    const result = await store.redactOrphansFor(['r1'])
    assert.equal(result.changed, 1, '含该记录的孤儿回执必须被清除：' + JSON.stringify(result))
    assert.deepEqual(result.ids, ['o-11'])
    assert.deepEqual(result.failed, [])

    // ① 内存视图立刻不可读（不能等下次打开）。
    const after = store.listOrphanReceipts()
    assert.equal(after[0].redacted, true, '必须标记已清除')
    assert.equal(after[0].receiptText, '', '正文必须清空')
    assert.deepEqual(after[0].recordIds, ['r1', 'r2'], 'recordIds 是审计事实，保留')

    // ② 磁盘上不得再有明文（这是隐私承诺的落点）。
    const disk = await readFile(path.join(root, 'sessions', 'a05', 'orphan-receipts.jsonl'), 'utf8')
    assert.equal(disk.includes('敏感内容'), false, '磁盘上不得残留孤儿回执明文：' + disk.slice(0, 200))
  })
})

test('A-05：不相关的孤儿回执不得被连带清除', async () => {
  await withStore(async (store) => {
    await store.appendOrphanReceipt(orphanRow(11, ['r1']))
    await store.appendOrphanReceipt(orphanRow(22, ['other']))
    const result = await store.redactOrphansFor(['r1'])
    assert.equal(result.changed, 1)
    const rows = store.listOrphanReceipts()
    assert.equal(rows.find((row) => row.id === 'o-11').redacted, true)
    assert.equal(rows.find((row) => row.id === 'o-22').redacted, undefined, '别的孤儿回执不得被清')
    assert.equal(rows.find((row) => row.id === 'o-22').receiptText.length > 0, true)
  })
})

test('A-05：重复清除是幂等的，不会写第二行', async () => {
  await withStore(async (store) => {
    await store.appendOrphanReceipt(orphanRow(11, ['r1']))
    assert.equal((await store.redactOrphansFor(['r1'])).changed, 1)
    assert.equal((await store.redactOrphansFor(['r1'])).changed, 0, '已清除的不再重复写')
    assert.equal(store.listOrphanReceipts()[0].redacted, true)
  })
})
