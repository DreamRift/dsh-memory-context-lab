/**
 * 遗忘面与检索面的一致性守卫（H-40 / H-41，2026-10-26 缺陷排查批）。
 *
 * 两条不变量：
 * 1. **批量遗忘全有或全无**（H-40）：一个拼错的 ID 不得让整批处于「部分遗忘」；
 * 2. **遗忘必须让索引陈化**（H-41）：遗忘不改变「已提交记录数」，若新鲜度只看这个数，
 *    「遗忘已提交、索引重建没跑」（崩溃/被杀/IO 失败）的状态下索引永不被判 stale，
 *    已遗忘正文永久留在检索面，recall 还会把它回注出去。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createV3Runtime } from '../src/v3/composition/composition.mjs'
import { openV3SessionStore } from '../src/v3/adapters/storage/session-store.mjs'

const dshSession = () => ({ id: 'k', append() { return { seq: 1 } }, eventAt() { return undefined }, surface: { nodes: [] } })

async function withRoot(fn) {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-forget-'))
  try { return await fn(root) } finally { await rm(root, { recursive: true, force: true }).catch(() => {}) }
}

async function seed(runtime, texts) {
  for (let i = 0; i < texts.length; i += 1) {
    await runtime.handleDshEvent(
      { seq: i, at: 1000 + i, type: 'user/message', data: { content: [{ type: 'text', text: texts[i] }] } },
      texts[i], {},
    )
  }
  return (await runtime.provider.search('秘密', {})).display.map((d) => d.id)
}

test('H-40 批量遗忘含非法 ID → 整批拒绝，一条都不忘（旧：部分遗忘 + 索引不重建）', async () => {
  await withRoot(async (root) => {
    const runtime = await createV3Runtime({ v3Root: root, dshSession: dshSession(), sessionKey: 'k' })
    try {
      const ids = await seed(runtime, ['秘密 甲 苹果', '秘密 乙 香蕉', '秘密 丙 橘子'])
      assert.equal(ids.length, 3)
      await assert.rejects(
        () => runtime.store.forget([ids[0], 'v3r-00000000000000ff', ids[1]]),
        (error) => error?.code === 'ESTORE_TXN_CONFLICT',
        '含未提交 ID 的整批必须拒绝',
      )
      // 一条都没忘：仍可回读、检索仍命中 3 条
      for (const id of ids) {
        const read = await runtime.provider.read(id).then((r) => r.text, (e) => 'THROW ' + e.code)
        assert.ok(!String(read).startsWith('THROW'), '整批拒绝后 ' + id + ' 仍应可读，得到 ' + read)
      }
      assert.equal((await runtime.provider.search('秘密', {})).display.length, 3, '索引与库一致：3 条都还在')
    } finally { runtime.close() }
  })
})

test('H-40 批量遗忘成功 → 全部不可读、检索面同步清空', async () => {
  await withRoot(async (root) => {
    const runtime = await createV3Runtime({ v3Root: root, dshSession: dshSession(), sessionKey: 'k' })
    try {
      const ids = await seed(runtime, ['秘密 甲 苹果', '秘密 乙 香蕉'])
      const result = await runtime.store.forget(ids)
      assert.equal(result.forgottenCount, 2)
      for (const id of ids) {
        await assert.rejects(() => runtime.provider.read(id), (error) => error?.code === 'EFORGOTTEN')
      }
      assert.equal((await runtime.provider.search('秘密', {})).display.length, 0, '检索面必须立即不可见')
    } finally { runtime.close() }
  })
})

test('H-41 遗忘已提交但索引未重建 → 索引判 stale，检索面自愈（旧：永久泄漏）', async () => {
  await withRoot(async (root) => {
    const first = await createV3Runtime({ v3Root: root, dshSession: dshSession(), sessionKey: 'k' })
    const ids = await seed(first, ['秘密 甲 苹果', '秘密 乙 香蕉'])
    assert.equal(ids.length, 2)
    first.close()

    // 模拟「遗忘已提交、进程在索引重建前被杀」：底层句柄只 forget
    const low = await openV3SessionStore(root, 'k')
    await low.forget(ids[0])
    low.close()

    const third = await createV3Runtime({ v3Root: root, dshSession: dshSession(), sessionKey: 'k' })
    try {
      const health = await third.store.health()
      assert.equal(health.forgottenCount, 1)
      // 核心判据：遗忘让索引陈化（旧实现这里 indexStale=false）
      assert.equal(health.indexStale, true, '遗忘后索引必须被判 stale')
      const hits = (await third.provider.search('秘密', {})).display.map((d) => d.id)
      assert.ok(!hits.includes(ids[0]), '检索面不得返回已遗忘记录，得到 ' + JSON.stringify(hits))
      assert.equal(hits.length, 1)
      const recall = await third.recall({ query: '秘密', turn: 1, packMinScore: 0, resultMinScore: 0 })
      assert.equal(recall.injected, true)
      assert.ok(!recall.text.includes(ids[0]), '回注包不得包含已遗忘记录 ID')
    } finally { third.close() }
  })
})

test('H-41 遗忘后索引重建一次即稳定（不会永久 stale）', async () => {
  await withRoot(async (root) => {
    const runtime = await createV3Runtime({ v3Root: root, dshSession: dshSession(), sessionKey: 'k' })
    try {
      const ids = await seed(runtime, ['秘密 甲 苹果', '秘密 乙 香蕉'])
      await runtime.store.forget([ids[0]])
      const health = await runtime.store.health()
      assert.equal(health.indexStale, false, '端口 forget 内部重建后不应再 stale')
      await runtime.provider.search('秘密', {}) // 触发 freshIndex
      assert.equal((await runtime.store.health()).indexStale, false, '检索后仍稳定，不反复重建')
    } finally { runtime.close() }
  })
})
