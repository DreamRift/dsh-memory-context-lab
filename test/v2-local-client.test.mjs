/**
 * 统一本地客户端测试（设计文档 v1.2 §2）：v1 引擎契约（rememberArchived/
 * getNode/recall）由 client-adapter 的本地实现满足——实施核验发现该契约
 * **本就已完整实现**，解绑缺口只在装配闸（index.mjs 的 createClient 曾硬性
 * 要求 dsh-memory）。getNode 回读走 coldRecordContent 重渲染，带尾随换行
 * （v1 的 normalizeColdBody 依赖该形状）；因此写入必须带 range。
 * 全部使用临时隔离目录，不触碰真实 $DSH_HOME，不依赖任何外部进程。
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createV2ClientFactory } from '../src/v2/client-adapter.mjs'
import { v2SessionDirectoryFor } from '../src/v2/store.mjs'
import { createLocalLexicalBackend } from '../src/v2/local-lexical-backend.mjs'
import { syncRetrievalIndex } from '../src/v2/retrieval.mjs'

const tmpRoots = []

async function newClient(t) {
  const labRoot = await mkdtemp(path.join(tmpdir(), 'mcl-local-client-'))
  tmpRoots.push(labRoot)
  const sessionId = 'sess-' + path.basename(labRoot).slice(-12)
  const backendFor = () => createLocalLexicalBackend({
    directory: v2SessionDirectoryFor(labRoot, sessionId),
  })
  const factory = createV2ClientFactory({ labRoot, sessionId, logger: null, backendFor })
  const client = await factory.createClient()
  t.after(async () => {
    await client.close()
    await rm(labRoot, { recursive: true, force: true })
  })
  return { client, factory, labRoot, sessionId }
}

test('客户端契约：rememberArchived/getNode/recall/close 齐备', async (t) => {
  const { client } = await newClient(t)
  assert.equal(typeof client.rememberArchived, 'function')
  assert.equal(typeof client.getNode, 'function')
  assert.equal(typeof client.recall, 'function')
  assert.equal(typeof client.close, 'function')
})

test('getNode：写入后按 nodeId 回读，正文带元数据块与尾随换行（v1 形状）', async (t) => {
  const { client } = await newClient(t)
  const result = await client.rememberArchived({
    nodeId: 'node-1',
    text: '她在厨房里做饭，然后把菜端上桌。',
    range: { start: 10, end: 12 },
    tools: ['read'],
    callIds: ['call_1'],
    contentHash: 'hash-1',
  })
  assert.equal(result.ok, true)
  assert.equal(result.committed, true)
  const read = await client.getNode('node-1')
  assert.equal(read.ok, true)
  assert.ok(read.content.includes('她在厨房里做饭，然后把菜端上桌。'))
  assert.ok(read.content.endsWith('\n'))
})

test('getNode：未知 nodeId 返回 not-found（三态之二）', async (t) => {
  const { client } = await newClient(t)
  const read = await client.getNode('node-missing')
  assert.equal(read.ok, false)
  assert.equal(read.error, 'not-found')
})

test('getNode：分块场景每个 chunk 一个 nodeId，各自回读（apply-engine 的 chunkIds[index] 契约）', async (t) => {
  const { client } = await newClient(t)
  const range = { start: 10, end: 12 }
  await client.rememberArchived({ nodeId: 'node-c1', text: '第一段。', range, tools: ['read'], callIds: ['call_c1'], chunk: 1, chunkCount: 2, contentHash: 'hash-all' })
  await client.rememberArchived({ nodeId: 'node-c2', text: '第二段。', range, tools: ['read'], callIds: ['call_c2'], chunk: 2, chunkCount: 2, contentHash: 'hash-all' })
  const first = await client.getNode('node-c1')
  const second = await client.getNode('node-c2')
  assert.equal(first.ok, true)
  assert.ok(first.content.includes('第一段。'))
  assert.equal(second.ok, true)
  assert.ok(second.content.includes('第二段。'))
})

test('write-once：同 nodeId 不同 contentHash 拒收，失败关闭', async (t) => {
  const { client } = await newClient(t)
  const range = { start: 10, end: 12 }
  await client.rememberArchived({ nodeId: 'node-x', text: '第一版', range, contentHash: 'hash-a' })
  await assert.rejects(
    () => client.rememberArchived({ nodeId: 'node-x', text: '第二版', range, contentHash: 'hash-b' }),
    /冷写冲突/,
  )
})

test('recall：索引同步后走 T1 命中并如实标注来源；未命中退回最近且自报家门', async (t) => {
  const labRoot = await mkdtemp(path.join(tmpdir(), 'mcl-local-client-'))
  tmpRoots.push(labRoot)
  const sessionId = 'sess-' + path.basename(labRoot).slice(-12)
  const directory = v2SessionDirectoryFor(labRoot, sessionId)
  const backend = createLocalLexicalBackend({ directory })
  const factory = createV2ClientFactory({ labRoot, sessionId, logger: null, backendFor: () => backend })
  const client = await factory.createClient()
  t.after(async () => {
    await client.close()
    await rm(labRoot, { recursive: true, force: true })
  })

  await client.rememberArchived({ nodeId: 'node-1', text: '她在厨房里做饭，然后把菜端上桌。', range: { start: 10, end: 12 }, contentHash: 'h1' })
  await client.rememberArchived({ nodeId: 'node-2', text: '他去书房看书。', range: { start: 13, end: 14 }, contentHash: 'h2' })
  // 生产里由 fullhistory 自动触发；测试显式同步，让 T1 索引与冷库对齐。
  await factory.withStore(async (store) => {
    const stats = await syncRetrievalIndex({ directory: store.directory, backend, store })
    assert.equal(stats.indexedNow, 2)
  })

  const hit = await client.recall('厨房', null, 5)
  assert.equal(hit.matchedBy, 'literal+semantic')
  assert.ok(hit.hits.some((entry) => entry.content.includes('厨房')))

  const miss = await client.recall('完全无关的查询词', null, 5)
  assert.equal(miss.matchedBy, 'recency-fallback')
  assert.ok(
    miss.hits.some((entry) => entry.content.includes('最近归档记录') && entry.content.includes('不是')),
    '退回说明应出现在注入文本中',
  )
})
