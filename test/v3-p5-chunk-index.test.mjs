/**
 * P5 T1：chunk 索引派生、迁移降级与回注窗口集成。
 *
 * 判据（开发流程 §5.3/§7.1/§9.3）：
 * - chunk 索引只存 recordId → 码点 span；不复制正文、不成为第二份证据；
 * - 删除/损坏/版本不匹配/落后时，检索与回注仍可用（窗口回退现扫）；
 * - 同一条长文的多个 chunk 只产生**一条**回注证据（presentedIds 去重）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createSessionStorePort } from '../src/v3/adapters/storage/session-store-port.mjs'
import { createT1Provider } from '../src/v3/adapters/retrieval/t1-provider.mjs'
import { buildChunkIndex, chunkRecordTruncated, chunkSpansOf } from '../src/v3/adapters/storage/chunk-index.mjs'
import { createRecall } from '../src/v3/application/recall.mjs'
import { selectExcerpt } from '../src/v3/domain/retrieval/excerpt.mjs'
import { CHUNK_OVERLAP, CHUNK_SCHEMA_VERSION, CHUNK_SIZE } from '../src/v3/domain/retrieval/chunks.mjs'
import { TOKENIZER_VERSION } from '../src/v3/domain/retrieval/query.mjs'

const SESSION_KEY = 'sess-p5'

function record(id, text) {
  return {
    id,
    kind: 'operation',
    sessionKey: SESSION_KEY,
    createdAt: 1792845000000,
    payload: { text, bytes: Buffer.byteLength(text, 'utf8') },
    provenance: { sourceEventId: 'evt-' + id, sourceForm: 'tool/result', transactionId: 'tx-' + id },
  }
}

async function withStack(body) {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-v3-p5-'))
  const { port, store } = await createSessionStorePort(root, SESSION_KEY)
  const metrics = { counters: new Map(), counter(n, v) { this.counters.set(n, (this.counters.get(n) ?? 0) + v) }, observe() {} }
  try {
    const provider = createT1Provider({ port, store, metrics })
    const recall = createRecall({ provider, metrics, sessionKey: SESSION_KEY })
    return await body({ provider, recall, port, store, metrics, root })
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
}

const LONG_ID = 'v3r-0000000000000001'
const LONG_TEXT = 'ERR_ONE_X1 ' + '填充'.repeat(600) + ' ERR_ONE_X1 结论'

test('重建写入 chunk 索引：schema/tokenizer/码点 span 与词法索引同批', async () => {
  await withStack(async ({ port, store }) => {
    await port.transaction([record(LONG_ID, LONG_TEXT), record('v3r-0000000000000002', '短正文')])
    await port.rebuildIndex()
    const raw = JSON.parse(await readFile(path.join(store.directory, 'chunk-index.json'), 'utf8'))
    assert.equal(raw.schemaVersion, CHUNK_SCHEMA_VERSION)
    assert.equal(raw.tokenizerVersion, TOKENIZER_VERSION)
    assert.equal(raw.chunkSize, CHUNK_SIZE)
    assert.equal(raw.chunkOverlap, CHUNK_OVERLAP)
    assert.equal(raw.indexedCount, 2)
    const spans = raw.chunks[LONG_ID]
    assert.ok(Array.isArray(spans) && spans.length >= 3, '长文至少 3 个 chunk：' + JSON.stringify(spans))
    const cps = [...LONG_TEXT]
    for (const [start, end] of spans) {
      assert.ok(Number.isInteger(start) && Number.isInteger(end) && end > start)
      assert.ok(end <= cps.length)
    }
    // 重叠：第二块起点 < 第一块终点
    assert.ok(spans[1][0] < spans[0][1], 'chunk 必须重叠')
  })
})

test('chunksOf：ok/absent/corrupt/incompatible 四态都不抛错', async () => {
  await withStack(async ({ provider, port, store }) => {
    await port.transaction([record(LONG_ID, LONG_TEXT)])
    await port.rebuildIndex()
    const ok = await provider.chunksOf(LONG_ID)
    assert.equal(ok.state, 'ok')
    assert.ok(ok.spans.length >= 3)
    assert.equal(ok.tokenizerVersion, TOKENIZER_VERSION)
    const missingRecord = await provider.chunksOf('v3r-00000000000000ff')
    assert.equal(missingRecord.state, 'ok')
    assert.deepEqual(missingRecord.spans, [])

    const chunkPath = path.join(store.directory, 'chunk-index.json')
    await writeFile(chunkPath, '{broken', 'utf8')
    const corrupt = await provider.chunksOf(LONG_ID)
    assert.equal(corrupt.state, 'corrupt')
    assert.deepEqual(corrupt.spans, [])

    await writeFile(chunkPath, JSON.stringify({
      schemaVersion: CHUNK_SCHEMA_VERSION,
      tokenizerVersion: 'old-tokenizer',
      chunkSize: CHUNK_SIZE,
      chunkOverlap: CHUNK_OVERLAP,
      indexedCount: 1,
      sourceCount: 1,
      forgottenCount: 0,
      chunks: {},
    }), 'utf8')
    const incompatible = await provider.chunksOf(LONG_ID)
    assert.equal(incompatible.state, 'incompatible')

    await rm(chunkPath, { force: true })
    const absent = await provider.chunksOf(LONG_ID)
    assert.equal(absent.state, 'absent')
  })
})

test('chunksOf：新增记录后索引落后 → stale（不拿旧窗口）', async () => {
  await withStack(async ({ provider, port }) => {
    await port.transaction([record(LONG_ID, LONG_TEXT)])
    await port.rebuildIndex()
    assert.equal((await provider.chunksOf(LONG_ID)).state, 'ok')
    await port.transaction([record('v3r-0000000000000002', '新增记录')])
    const stale = await provider.chunksOf(LONG_ID)
    assert.equal(stale.state, 'stale')
    assert.deepEqual(stale.spans, [])
  })
})

test('回注窗口：chunk 索引缺失时现扫仍命中尾部答案（迁移期可用）', async () => {
  await withStack(async ({ provider, recall, port, store }) => {
    await port.transaction([record(LONG_ID, '开头无关。'.repeat(200) + ' 结论 ERR_TAIL_X7')])
    await port.rebuildIndex()
    await rm(path.join(store.directory, 'chunk-index.json'), { force: true })
    const out = await recall({ query: 'ERR_TAIL_X7', turn: 1, previewChars: 120 })
    assert.equal(out.injected, true)
    assert.equal(out.text.includes('ERR_TAIL_X7'), true, out.text)
    assert.equal(out.offsetUnit, 'code-point')
    assert.equal(out.presentedIds.length, 1)
    assert.equal(out.excerpts.length, 1)
    assert.equal(out.excerpts[0].strategy, 'scan-fallback')
  })
})

test('同文多 chunk：只产生一条证据，chunkHits 不虚增 hits/presentedIds', async () => {
  await withStack(async ({ recall, port }) => {
    await port.transaction([record(LONG_ID, LONG_TEXT)])
    await port.rebuildIndex()
    const out = await recall({ query: 'ERR_ONE_X1', turn: 1, previewChars: 100 })
    assert.equal(out.injected, true)
    assert.equal(out.hits.length, 1, '一条记录 = 一条证据')
    assert.equal(out.presentedIds.length, 1)
    assert.equal(out.excerpts.length, 1)
    assert.ok(out.excerpts[0].chunkHits >= 2, '同一记录跨多个 chunk 命中：' + JSON.stringify(out.excerpts[0]))
    assert.ok(out.excerpts[0].spans.length >= 2, '互补窗口合并为同一条记录内的多个 span')
  })
})

test('P3：单记录 chunk 被硬顶截断 → 覆盖不全必须回退现扫，尾段标识符不得丢', () => {
  // 0.15.0 P5 验收缺陷：`chunks` 有单记录硬顶（1024 块），截断后该记录的尾段不在任何
  // chunk 里。旧选窗只看「scoped 非空」就采用 chunk 范围，尾段命中静默消失。
  const text = 'ERR_ONE_X1 ' + '填充'.repeat(400) + ' ERR_TAIL_X7 结论'
  const recordId = 'v3r-0000000000000001'
  const index = buildChunkIndex([{ id: recordId, text }], { maxChunks: 1 })
  assert.equal(index.truncatedRecords, 1, '截断必须计数')
  assert.deepEqual(index.truncatedIds, [recordId], '截断必须逐记录留痕')
  assert.equal(chunkRecordTruncated(index, recordId), true)
  assert.equal(chunkRecordTruncated(index, 'v3r-00000000000000ff'), false)
  const spans = chunkSpansOf(index, recordId)
  assert.equal(spans.length, 1)
  assert.ok(spans[0].end < [...text].length, '前置：chunk 只覆盖了头部')

  const out = selectExcerpt(text, 'ERR_ONE_X1 ERR_TAIL_X7', { maxChars: 60, maxSpans: 2, chunkSpans: spans })
  assert.equal(out.strategy, 'scan-fallback', '覆盖不全时不得用 chunk 范围：' + out.strategy)
  assert.ok(typeof out.reason === 'string' && out.reason.includes('chunk'), '回退原因必须可见：' + out.reason)
  assert.equal(out.text.includes('ERR_TAIL_X7'), true, '尾段标识符必须保留：' + out.text)
  assert.equal(out.text.includes('ERR_ONE_X1'), true)

  // 反例对照：同一批记录里**没**被截断的那条仍走 chunk-window（能力不退化）。
  const shortIndex = buildChunkIndex([{ id: recordId, text: 'ERR_ONE_X1 ' + '填充'.repeat(10) }])
  assert.equal(shortIndex.truncatedRecords, 0)
  const scoped = selectExcerpt('ERR_ONE_X1 ' + '填充'.repeat(10), 'ERR_ONE_X1', { maxChars: 60, chunkSpans: chunkSpansOf(shortIndex, recordId) })
  assert.equal(scoped.strategy, 'chunk-window')
})

test('P3：recall 诊断暴露 truncatedRecords，且窗口仍能拿到尾段答案', async () => {
  const LOCAL_ID = 'v3r-0000000000000001'
  const longText = 'ERR_ONE_X1 ' + '填充'.repeat(400) + ' ERR_TAIL_X7 结论'
  const provider = {
    async search() { return { display: [{ id: LOCAL_ID, score: 1 }], pack: [{ id: LOCAL_ID, score: 1 }], oovTerms: [] } },
    async read() { return { text: longText, record: { id: LOCAL_ID, createdAt: 1 } } },
    async chunksOf() {
      return { state: 'ok', spans: [{ start: 0, end: 600 }], truncated: true, indexTruncatedRecords: 3 }
    },
    async health() { return { healthy: true } },
    capabilities() { return { name: 'fake', tier: 'T1', live: true } },
  }
  const recall = createRecall({ provider, sessionKey: 'sess-p5', metrics: null })
  const out = await recall({ query: 'ERR_ONE_X1 ERR_TAIL_X7', turn: 1, previewChars: 80 })
  assert.equal(out.injected, true, out.reason)
  assert.equal(out.text.includes('ERR_TAIL_X7'), true, '尾部答案仍要出现：' + out.text)
  assert.equal(out.chunkIndexTruncatedRecords, 3, '索引级 truncatedRecords 必须进诊断')
  assert.equal(out.chunkIndexTruncatedHits, 1, '本批命中里被截断的记录数必须可见')
  assert.equal(out.excerpts[0].strategy, 'scan-fallback')
})

test('回注窗口：chunk 索引版本不匹配时回退现扫并如实标 strategy', async () => {
  await withStack(async ({ recall, port, store }) => {
    await port.transaction([record(LONG_ID, LONG_TEXT)])
    await port.rebuildIndex()
    const chunkPath = path.join(store.directory, 'chunk-index.json')
    const parsed = JSON.parse(await readFile(chunkPath, 'utf8'))
    parsed.tokenizerVersion = 'future-tokenizer'
    await writeFile(chunkPath, JSON.stringify(parsed), 'utf8')
    const out = await recall({ query: 'ERR_ONE_X1', turn: 1, previewChars: 100 })
    assert.equal(out.injected, true)
    assert.equal(out.excerpts[0].strategy, 'scan-fallback')
  })
})
