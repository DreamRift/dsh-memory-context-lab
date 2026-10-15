/**
 * T1 本地词法检索后端测试：词条化、AND 语义、持久化、增量幂等、上限如实报、崩溃重建。
 * 全部使用临时隔离目录，不触碰真实 $DSH_HOME，不依赖任何外部进程。
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  createLocalLexicalBackend,
  tokenizeForLexicalIndex,
  LOCAL_LEXICAL_BACKEND_NAME,
  LOCAL_LEXICAL_INDEX_FILE,
} from '../src/v2/local-lexical-backend.mjs'

const tmpRoots = []

async function newDir() {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-lexical-'))
  tmpRoots.push(root)
  return root
}

function record(id, text, seq = 1) {
  return {
    id,
    kind: 'projection-span',
    fidelity: 'synthesized',
    seq,
    refs: {},
    inline: {},
    payload: null,
    text,
    textTruncated: false,
    textIntegrity: 'ok',
    textMaxBytes: 8192,
  }
}

test('词条化：ASCII 词元小写、CJK 二元组、单字 run 保留整字', () => {
  assert.deepEqual(tokenizeForLexicalIndex('Hello 世界'), ['hello', '世界'])
  assert.deepEqual(tokenizeForLexicalIndex('上下文管理'), ['上下', '下文', '文管', '管理'])
  assert.deepEqual(tokenizeForLexicalIndex('猫'), ['猫'])
})

test('契约符合：name/capabilities/index/query/dispose/ping 齐备，能力自述不冒充语义', async () => {
  const dir = await newDir()
  const backend = createLocalLexicalBackend({ directory: dir })
  assert.equal(backend.name, LOCAL_LEXICAL_BACKEND_NAME)
  assert.equal(typeof backend.index, 'function')
  assert.equal(typeof backend.query, 'function')
  assert.equal(typeof backend.dispose, 'function')
  assert.equal(typeof backend.ping, 'function')
  assert.equal(backend.capabilities.semanticVectors, false)
  assert.equal(backend.capabilities.kind, 'lexical-structural')
  assert.equal(await backend.ping(), true)
})

test('CJK 二元组命中：只返回记录 ID；单字查询与无关词如实返回空', async () => {
  const dir = await newDir()
  const backend = createLocalLexicalBackend({ directory: dir })
  const result = await backend.index([record('t00000001-r00000001', '她在厨房里做饭，然后把菜端上桌。', 3)])
  assert.deepEqual(result.skipped, [])
  assert.equal(result.externalIds['t00000001-r00000001'], 't00000001-r00000001')
  assert.deepEqual(await backend.query('厨房', { limit: 5 }), ['t00000001-r00000001'])
  // 单字查询：词表里只有二元组，单字不命中——如实返回空，不冒充命中
  assert.deepEqual(await backend.query('厨', { limit: 5 }), [])
  assert.deepEqual(await backend.query('完全无关的词', { limit: 5 }), [])
})

test('ASCII 词元大小写不敏感', async () => {
  const dir = await newDir()
  const backend = createLocalLexicalBackend({ directory: dir })
  await backend.index([record('r1', 'failed with EACCES on /tmp/x', 1)])
  assert.deepEqual(await backend.query('eacces', { limit: 5 }), ['r1'])
})

test('多词 AND：两词都在才命中', async () => {
  const dir = await newDir()
  const backend = createLocalLexicalBackend({ directory: dir })
  await backend.index([record('r1', '厨房做饭洗碗', 1), record('r2', '厨房打扫', 2)])
  assert.deepEqual(await backend.query('厨房 做饭', { limit: 5 }), ['r1'])
  assert.deepEqual((await backend.query('厨房', { limit: 5 })).sort(), ['r1', 'r2'])
})

test('增量幂等：同一记录重复送达不重复计频，查询结果稳定', async () => {
  const dir = await newDir()
  const backend = createLocalLexicalBackend({ directory: dir })
  const doc = record('r1', '厨房做饭', 1)
  await backend.index([doc])
  const again = await backend.index([doc])
  assert.equal(again.externalIds['r1'], 'r1')
  assert.deepEqual(await backend.query('厨房', { limit: 5 }), ['r1'])
})

test('持久化：新实例从同一目录读到已索引状态', async () => {
  const dir = await newDir()
  const first = createLocalLexicalBackend({ directory: dir })
  await first.index([record('r1', '厨房做饭', 1)])
  const second = createLocalLexicalBackend({ directory: dir })
  assert.deepEqual(await second.query('厨房', { limit: 5 }), ['r1'])
})

test('崩溃/文件缺失：从空索引重建，如实返回空而不是假装命中', async () => {
  const dir = await newDir()
  const first = createLocalLexicalBackend({ directory: dir })
  await first.index([record('r1', '厨房做饭', 1)])
  await rm(path.join(dir, LOCAL_LEXICAL_INDEX_FILE))
  const second = createLocalLexicalBackend({ directory: dir })
  assert.deepEqual(await second.query('厨房', { limit: 5 }), [])
})

test('词条上限：超限后如实报 skipped，绝不算已索引', async () => {
  const dir = await newDir()
  const backend = createLocalLexicalBackend({ directory: dir, maxTerms: 2 })
  const ok = await backend.index([record('r1', '厨房', 1)])
  assert.deepEqual(ok.skipped, [])
  const limited = await backend.index([record('r2', '书房读书', 2)])
  assert.equal(limited.skipped.length, 1)
  assert.equal(limited.skipped[0].id, 'r2')
  assert.equal(limited.skipped[0].reason, 'term-limit-reached')
  assert.deepEqual(await backend.query('书房', { limit: 5 }), [])
  assert.deepEqual(await backend.query('厨房', { limit: 5 }), ['r1'])
})

test('空正文/缺正文如实报 skipped，不进命中面', async () => {
  const dir = await newDir()
  const backend = createLocalLexicalBackend({ directory: dir })
  const result = await backend.index([record('r1', '', 1)])
  assert.equal(result.skipped.length, 1)
  assert.match(result.skipped[0].reason, /^text-/)   
  assert.deepEqual(await backend.query('厨房', { limit: 5 }), [])
})

test('新近度破平：同分时 seq 大者优先', async () => {
  const dir = await newDir()
  const backend = createLocalLexicalBackend({ directory: dir })
  await backend.index([record('r1', '厨房记录', 1), record('r2', '厨房记录', 2)])
  assert.deepEqual(await backend.query('厨房', { limit: 5 }), ['r2', 'r1'])
})

test('cleanup', async () => {
  for (const root of tmpRoots.splice(0)) await rm(root, { recursive: true, force: true })
})