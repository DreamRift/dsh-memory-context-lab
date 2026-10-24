/**
 * P0-2 补充（beta.9 核验小项②）：推理段的分块边界——大操作正文按
 * chunkArchiveBody 机械切分（不保证段边界），续块（nodeId _p2 起、
 * inline.chunk ≥ 2）可能从 [推理] 段中部开始而无段头，P0-2 的段头过滤
 * 对它失效，预览会漏进推理尾。
 *
 * 判据：inline.chunk ≥ 2 的续块预览必须失败关闭——开头到首个段头之间的
 * 不可判定内容不进预览，并以占位行如实披露；首块行为逐字节不变。
 * 全部使用临时隔离目录。
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createV2ClientFactory } from '../src/v2/client-adapter.mjs'
import { createLocalLexicalBackend } from '../src/v2/local-lexical-backend.mjs'
import { syncRetrievalIndex } from '../src/v2/retrieval.mjs'
import { v2SessionDirectoryFor } from '../src/v2/store.mjs'
import { chunkArchiveBody } from '../src/core.mjs'

const NL2 = String.fromCharCode(10)
const REASONING_TAIL_MARK = '推理段尾部的秘密推演：极性校准参数 42'
const CONTINUATION_NOTE = '（分块续段：起始无法判定是否处于已省略段内，原文可按 id 回读）'

/** 构造一个 [推理] 段大到必然跨块的正文。 */
function buildSplitBody() {
  const head = '已完成配置检查。'
  const reasoningLines = []
  // 每行约 60 字节 × 1200 行 ≈ 72KB，超过 MAX_OPERATION_BYTES(48KB)：
  // 夹具必然跨块；标记行 1000 > 第一块约 819 行，保证落在续块内。
  for (let i = 0; i < 1200; i += 1) {
    reasoningLines.push(i === 1000 ? 'r'.repeat(30) + REASONING_TAIL_MARK : 'reasoning line ' + i + ' ' + 'y'.repeat(38))
  }
  return [head, '[推理]', ...reasoningLines, '[工具] fs.read', '参数：{"path":"config.yaml"}', '[结果]', '读取成功：42 字节。'].join(NL2)
}

test('chunkArchiveBody 夹具自证：[推理] 段必然跨块，续块开头无段头', () => {
  const body = buildSplitBody()
  const chunks = chunkArchiveBody(body)
  assert.ok(chunks.length >= 2, '夹具必须产生多块：' + chunks.length)
  const second = chunks[1]
  const firstLine = second.split(NL2)[0]
  assert.ok(!['[推理]', '[工具] fs.read', '[结果]'].includes(firstLine.trim()), '续块首行必须不是段头（否则夹具无效）：' + firstLine)
  assert.ok(second.includes(REASONING_TAIL_MARK), '续块必须含推理尾（泄漏载体）')
})

async function newClient(t, tag) {
  const labRoot = await mkdtemp(path.join(tmpdir(), 'mcl-reasoning-chunk-'))
  const sessionId = 'sess-' + path.basename(labRoot).slice(-12)
  const directory = v2SessionDirectoryFor(labRoot, sessionId)
  const backend = createLocalLexicalBackend({ directory })
  const factory = createV2ClientFactory({ labRoot, sessionId, logger: null, backendFor: () => backend })
  const client = await factory.createClient()
  t.after(async () => {
    await client.close()
    await rm(labRoot, { recursive: true, force: true })
  })
  return { client, factory }
}

test('client-adapter：续块（inline.chunk ≥ 2）预览失败关闭——不可判定开头不进预览', async (t) => {
  const { client, factory } = await newClient(t)
  const body = buildSplitBody()
  const chunks = chunkArchiveBody(body)
  // 只写续块（_p2）作为独立冷记录：预览面对的就是它。
  await client.rememberArchived({
    nodeId: 'node-op-1_p2',
    text: chunks[1],
    range: { start: 30, end: 34 },
    tools: ['fs.read'],
    callIds: ['call_1'],
    contentHash: 'h-p2',
    chunk: 2,
    chunkCount: chunks.length,
  })
  await factory.withStore(async (store) => {
    await syncRetrievalIndex({ directory: store.directory, backend: createLocalLexicalBackend({ directory: store.directory }), store })
  })
  const call = await client.recall('推理行', null, 5)
  for (const hit of call.hits) {
    assert.ok(!hit.preview.includes(REASONING_TAIL_MARK), '推理尾不得进续块预览：' + hit.preview)
    assert.ok(!hit.content.includes(REASONING_TAIL_MARK), '推理尾不得进续块 content：' + hit.content)
  }
  assert.ok(
    call.hits.some((hit) => hit.preview.includes(CONTINUATION_NOTE) || hit.content.includes(CONTINUATION_NOTE)),
    '续块预览必须携带失败关闭披露：' + JSON.stringify(call.hits.map((h) => h.preview)),
  )
})

test('首块（inline.chunk 缺省或 = 1）行为逐字节不变：正常段头过滤，无续段占位', async (t) => {
  const { client, factory } = await newClient(t)
  const p1Body = [
    '已完成配置检查。',
    '[推理]',
    '秘密推演内容 A',
    '[工具] fs.read',
    '参数：{}',
    '[结果]',
    '完成',
  ].join(NL2)
  await client.rememberArchived({
    nodeId: 'node-op-2_p1',
    text: p1Body,
    range: { start: 10, end: 14 },
    tools: ['fs.read'],
    callIds: ['call_1'],
    contentHash: 'h-p1',
    chunk: 1,
    chunkCount: 2,
  })
  await factory.withStore(async (store) => {
    await syncRetrievalIndex({ directory: store.directory, backend: createLocalLexicalBackend({ directory: store.directory }), store })
  })
  const call = await client.recall('配置检查', null, 5)
  assert.ok(call.hits.length >= 1)
  for (const hit of call.hits) {
    assert.ok(!hit.preview.includes('秘密推演内容 A'), '首块推理段照常过滤')
    assert.ok(!hit.preview.includes(CONTINUATION_NOTE), '首块不得出现续段占位：' + hit.preview)
  }
})