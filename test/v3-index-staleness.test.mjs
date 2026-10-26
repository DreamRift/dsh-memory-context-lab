/**
 * v3 索引新鲜度守卫（H-03，2026-10-26 缺陷排查批）。
 *
 * ## 缺陷
 * isIndexStale 拿 index.indexedCount（**可检索文档数**，已扣除 metadata-only 与已遗忘）
 * 跟 store.listRecordIds().length（**已提交数**，未扣除）比。两个口径不同，于是只要库里有
 * 一条 metadata-only 记录或被遗忘过一条记录，索引就永久判 stale —— 每次检索都全量重建
 * （O(N) 次记录读盘）。同时 session-store-port.health 用的是另一套算法（扣除 forgotten），
 * 于是 health 说「新鲜」而检索入口说「陈旧」，两把尺子互相矛盾。
 *
 * ## 判据
 * - 遗忘后连续多次检索：重建计数不再增长（只允许 0 次）；
 * - 存在 metadata-only 记录时同样稳定；
 * - 新增记录 → 恰好重建一次，之后稳定；
 * - health.indexStale 与 isIndexStale() 必须逐次一致（单一判据）。
 *
 * ## 不适用条件与已知边界
 * 旧索引（无 sourceCount 字段）按 indexedCount 比较，重建一次后自愈——本套件覆盖该迁移路径。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createSessionStorePort } from '../src/v3/adapters/storage/session-store-port.mjs'
import { createT1Provider } from '../src/v3/adapters/retrieval/t1-provider.mjs'
import { isIndexStale, readLexicalIndex } from '../src/v3/adapters/storage/lexical-index.mjs'

function record(id, text, metaOnly = false) {
  const payload = { text, bytes: Buffer.byteLength(text, 'utf8') }
  if (metaOnly) {
    payload.metaOnly = true
    payload.metaReason = '测试夹具：无可见正文'
  }
  return {
    id,
    kind: 'message-user',
    sessionKey: 'sess-idx',
    createdAt: 1792845000000,
    payload,
    provenance: { sourceEventId: 'dsh-' + id.slice(-1), sourceForm: null, transactionId: 'tx-1' },
  }
}

async function withPort(body) {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-v3-indexstale-'))
  const { port, store } = await createSessionStorePort(root, 'sess-idx')
  try {
    return await body({ port, store, root })
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
}

function countingMetrics() {
  const counters = new Map()
  return {
    counters,
    counter(name, value) { counters.set(name, (counters.get(name) ?? 0) + value) },
    observe() {},
  }
}

test('H-03 遗忘后检索不再全量重建（旧：每次检索 +1 次重建）', async () => {
  await withPort(async ({ port, store }) => {
    for (let i = 0; i < 3; i += 1) {
      await port.transaction([record('v3r-' + String(i).padStart(16, '0'), '记忆插件检索测试正文' + i)])
    }
    const metrics = countingMetrics()
    const provider = createT1Provider({ port, store, metrics })
    await provider.search('记忆插件')
    const afterWarmup = metrics.counters.get('v3.t1.indexRebuilt') ?? 0

    await port.forget(['v3r-0000000000000001'])
    for (let i = 0; i < 3; i += 1) await provider.search('记忆插件')
    assert.equal(metrics.counters.get('v3.t1.indexRebuilt') ?? 0, afterWarmup, '遗忘后不得每次检索都重建')
    assert.equal((await port.health()).indexStale, false)
    assert.equal(await isIndexStale(store, await readLexicalIndex(store)), false)
  })
})

test('H-03 metadata-only 记录不得让索引永久 stale', async () => {
  await withPort(async ({ port, store }) => {
    await port.transaction([record('v3r-0000000000000010', '可检索正文')])
    await port.transaction([record('v3r-0000000000000011', '', true)])
    const metrics = countingMetrics()
    const provider = createT1Provider({ port, store, metrics })
    await provider.search('可检索')
    const afterWarmup = metrics.counters.get('v3.t1.indexRebuilt') ?? 0
    for (let i = 0; i < 3; i += 1) await provider.search('可检索')
    assert.equal(metrics.counters.get('v3.t1.indexRebuilt') ?? 0, afterWarmup, 'metadata-only 存在时不得每次重建')
    const health = await port.health()
    assert.equal(health.indexedCount, 1, 'metadata-only 不进索引')
    assert.equal(health.indexStale, false)
  })
})

test('H-03 新增记录 → 恰好重建一次后稳定；health 与 isIndexStale 同判据', async () => {
  await withPort(async ({ port, store }) => {
    await port.transaction([record('v3r-0000000000000020', '第一段正文')])
    const metrics = countingMetrics()
    const provider = createT1Provider({ port, store, metrics })
    await provider.search('第一段')
    const warm = metrics.counters.get('v3.t1.indexRebuilt') ?? 0

    await port.transaction([record('v3r-0000000000000021', '第二段正文')])
    const healthBefore = await port.health()
    assert.equal(healthBefore.indexStale, true, '新增记录后必须判 stale')
    assert.equal(await isIndexStale(store, await readLexicalIndex(store)), true, '两把尺子必须一致')

    await provider.search('第二段')
    await provider.search('第二段')
    assert.equal(metrics.counters.get('v3.t1.indexRebuilt') ?? 0, warm + 1, '只重建一次')
    assert.equal((await port.health()).indexStale, false)
  })
})

test('H-03 旧索引（无 sourceCount）在新增记录后自愈一次，之后稳定', async () => {
  await withPort(async ({ port, store }) => {
    await port.transaction([record('v3r-0000000000000030', '遗留索引正文甲')])
    await port.transaction([record('v3r-0000000000000031', '遗留索引正文乙')])
    const indexPath = path.join(store.directory, 'lexical-index.json')
    await port.rebuildIndex()
    const parsed = JSON.parse(await readFile(indexPath, 'utf8'))
    delete parsed.sourceCount
    await writeFile(indexPath, JSON.stringify(parsed) + '\n', 'utf8')

    assert.equal(await isIndexStale(store, await readLexicalIndex(store)), false, '无遗忘/无 metadata-only 时旧索引仍新鲜')

    // 新增一条（写路径不重建索引）→ 旧索引按 indexedCount 比较判 stale → 检索时重建一次自愈
    await port.transaction([record('v3r-0000000000000032', '遗留索引正文丙')])
    const metrics = countingMetrics()
    const provider = createT1Provider({ port, store, metrics })
    await provider.search('遗留')
    const afterHeal = metrics.counters.get('v3.t1.indexRebuilt') ?? 0
    assert.equal(afterHeal, 1, '旧索引判 stale 时重建一次')
    await provider.search('遗留')
    await provider.search('遗留')
    assert.equal(metrics.counters.get('v3.t1.indexRebuilt') ?? 0, afterHeal, '自愈后不再重建')
    const healed = JSON.parse(await readFile(indexPath, 'utf8'))
    assert.equal(typeof healed.sourceCount, 'number', '重建后必须写回 sourceCount')
    assert.equal((await port.health()).indexStale, false)
  })
})
