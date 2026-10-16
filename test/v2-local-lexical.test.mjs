/**
 * T1 本地词法检索后端测试：词条化、AND 语义、持久化、增量幂等、上限如实报、崩溃重建。
 * 全部使用临时隔离目录，不触碰真实 $DSH_HOME，不依赖任何外部进程。
 */
import assert from 'node:assert/strict'
import { appendFile, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  createLocalLexicalBackend,
  tokenizeForLexicalIndex,
  LOCAL_LEXICAL_BACKEND_NAME,
  LOCAL_LEXICAL_INDEX_FILE,
  LOCAL_LEXICAL_INDEX_KIND,
  LOCAL_LEXICAL_SCHEMA_VERSION,
} from '../src/v2/local-lexical-backend.mjs'

// 增量日志文件名：与实现内的常量同名（导出面保持不变，故测试内用字面量）。
const LOCAL_LEXICAL_LOG_FILE = 'lexical-index.log'

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

// ── base 快照 + 增量 append 日志（消除每次 index 的全量重写）─────────────────
// 不变量：lexical-index.json = base 快照（仅 compaction/首批建快照时写）；
//         lexical-index.log = 追加式 JSONL，每次 index 有增量时恰好 append 一行。

const basePathFor = (dir) => path.join(dir, LOCAL_LEXICAL_INDEX_FILE)
const logPathFor = (dir) => path.join(dir, LOCAL_LEXICAL_LOG_FILE)

async function readLogLines(dir) {
  const text = await readFile(logPathFor(dir), 'utf8')
  return text.split('\n').filter((line) => line.trim() !== '')
}

test('阳性对照：第二批 index 只追加日志、不重写 base（字节数/mtime 均不变）', async () => {
  const dir = await newDir()
  const backend = createLocalLexicalBackend({ directory: dir })
  await backend.index([record('r1', '厨房做饭', 1)])
  const before = await stat(basePathFor(dir))
  await new Promise((resolve) => setTimeout(resolve, 30))
  await backend.index([record('r2', '书房读书', 2)])
  const after = await stat(basePathFor(dir))
  assert.equal(after.size, before.size, 'base 字节数不应变化：第二批不得重写 base')
  assert.equal(after.mtimeMs, before.mtimeMs, 'base mtime 不应变化：第二批不得重写 base')
  const base = JSON.parse(await readFile(basePathFor(dir), 'utf8'))
  assert.equal(Object.prototype.hasOwnProperty.call(base.docs, 'r2'), false, '第二批不得进入 base 快照')
  const lines = await readLogLines(dir)
  assert.equal(lines.length, 1, '第二批应恰好追加一行日志')
  const delta = JSON.parse(lines[0])
  assert.deepEqual(Object.keys(delta.docs), ['r2'])
  assert.deepEqual(delta.postings['书房'], [['r2', 1]])
  assert.equal(delta.limitReached, false)
  assert.deepEqual(await backend.query('书房', { limit: 5 }), ['r2'])
})

test('单批一次 append：一次 index(多记录) 只写一行日志', async () => {
  const dir = await newDir()
  const backend = createLocalLexicalBackend({ directory: dir })
  await backend.index([record('r1', '厨房做饭', 1)])
  await backend.index([record('r2', '书房读书', 2), record('r3', '厨房打扫', 3)])
  const lines = await readLogLines(dir)
  assert.equal(lines.length, 1, '一次 index 只允许一行 delta')
  const delta = JSON.parse(lines[0])
  assert.deepEqual(Object.keys(delta.docs).sort(), ['r2', 'r3'])
  assert.equal(delta.limitReached, false)
})

test('重放等价：三批增量 → 新实例重放与内存路径一致；docs/terms 计数与跨批合并正确', async () => {
  const dir = await newDir()
  const live = createLocalLexicalBackend({ directory: dir })
  await live.index([record('r1', '厨房做饭', 3)])
  await live.index([record('r2', '厨房厨房记录', 2)])
  await live.index([record('r3', '厨房打扫', 1)])
  const inMemory = await live.query('厨房', { limit: 10 })
  // r2 的「厨房」词频 2 > r1/r3 的 1；r1/r3 同分时 seq 大者（r1）在前
  assert.deepEqual(inMemory, ['r2', 'r1', 'r3'])
  assert.deepEqual(await live.query('厨房 做饭', { limit: 10 }), ['r1'])
  assert.ok((await stat(logPathFor(dir))).size > 0, '三批后应留下增量日志')
  // 纯重放路径：只读 base + 逐行重放日志（不落盘、不改文件）
  const replayed = createLocalLexicalBackend({ directory: dir })
  assert.deepEqual(await replayed.query('厨房', { limit: 10 }), inMemory)
  assert.deepEqual(await replayed.query('厨房 做饭', { limit: 10 }), ['r1'])
  assert.deepEqual(await replayed.query('打扫', { limit: 10 }), ['r3'])
  // 归并路径：dispose 后 base 承载全量，跨批同 term 必须合并（不覆盖、不重复）
  await live.dispose()
  const base = JSON.parse(await readFile(basePathFor(dir), 'utf8'))
  assert.deepEqual(Object.keys(base.docs).sort(), ['r1', 'r2', 'r3'])
  const expectedTerms = new Set()
  for (const text of ['厨房做饭', '厨房厨房记录', '厨房打扫']) {
    for (const term of tokenizeForLexicalIndex(text)) expectedTerms.add(term)
  }
  assert.equal(Object.keys(base.postings).length, expectedTerms.size, 'terms 计数应与内存一致')
  assert.deepEqual(base.postings['厨房'].d, ['r1', 'r2', 'r3'])
  assert.deepEqual(base.postings['厨房'].f, [1, 2, 1])
  const afterDispose = createLocalLexicalBackend({ directory: dir })
  assert.deepEqual(await afterDispose.query('厨房', { limit: 10 }), inMemory)
})

test('向后兼容：旧格式单文件仍可加载检索，且此后增量只进日志、不重写旧 base', async () => {
  const dir = await newDir()
  const legacy = {
    kind: LOCAL_LEXICAL_INDEX_KIND,
    schemaVersion: LOCAL_LEXICAL_SCHEMA_VERSION,
    backend: LOCAL_LEXICAL_BACKEND_NAME,
    updatedAt: '2026-01-01T00:00:00.000Z',
    limitReached: false,
    docs: { 'legacy-1': { seq: 7, kind: 'projection-span', bytes: 24 } },
    postings: { '厨房': { d: ['legacy-1'], f: [2] }, '做饭': { d: ['legacy-1'], f: [1] } },
  }
  await writeFile(basePathFor(dir), JSON.stringify(legacy) + '\n', 'utf8')
  const before = await stat(basePathFor(dir))
  const backend = createLocalLexicalBackend({ directory: dir })
  assert.deepEqual(await backend.query('厨房', { limit: 5 }), ['legacy-1'])
  assert.deepEqual(await backend.query('厨房 做饭', { limit: 5 }), ['legacy-1'])
  await backend.index([record('r9', '书房读书', 9)])
  const after = await stat(basePathFor(dir))
  assert.equal(after.size, before.size, '旧格式 base 不应被重写')
  assert.equal(after.mtimeMs, before.mtimeMs, '旧格式 base 不应被重写')
  const lines = await readLogLines(dir)
  assert.equal(lines.length, 1)
  const delta = JSON.parse(lines[0])
  assert.equal(delta.docs.r9.seq, 9)
  assert.deepEqual(delta.postings['书房'], [['r9', 1]])
  const reloaded = createLocalLexicalBackend({ directory: dir })
  assert.deepEqual(await reloaded.query('厨房', { limit: 5 }), ['legacy-1'])
  assert.deepEqual(await reloaded.query('书房', { limit: 5 }), ['r9'])
})

test('日志损坏/半截行：跳过不抛，之前的记录仍命中，后续追加不被污染', async () => {
  const dir = await newDir()
  const first = createLocalLexicalBackend({ directory: dir })
  await first.index([record('r1', '厨房做饭', 1)])
  await appendFile(logPathFor(dir), 'this-is-not-json\n{"docs":{"r2":{"seq":2,"kind":', 'utf8')
  const second = createLocalLexicalBackend({ directory: dir })
  assert.deepEqual(await second.query('厨房', { limit: 5 }), ['r1'])
  assert.deepEqual(await second.query('记录', { limit: 5 }), [])
  await second.index([record('r3', '厨房记录', 3)])
  const third = createLocalLexicalBackend({ directory: dir })
  assert.deepEqual((await third.query('厨房', { limit: 5 })).sort(), ['r1', 'r3'])
  assert.deepEqual(await third.query('记录', { limit: 5 }), ['r3'])
})

test('compaction（日志字节阈值）：base 完整、日志清空、检索等价', async () => {
  const dir = await newDir()
  const backend = createLocalLexicalBackend({ directory: dir, compactionBytes: 1 })
  await backend.index([record('r1', '厨房做饭', 1)])
  await backend.index([record('r2', '书房读书', 2)])
  assert.equal((await stat(logPathFor(dir))).size, 0, 'compaction 后日志必须清空')
  const base = JSON.parse(await readFile(basePathFor(dir), 'utf8'))
  assert.deepEqual(Object.keys(base.docs).sort(), ['r1', 'r2'])
  assert.deepEqual(base.postings['厨房'].d, ['r1'])
  assert.deepEqual(base.postings['书房'].d, ['r2'])
  const reopened = createLocalLexicalBackend({ directory: dir })
  assert.deepEqual(await reopened.query('厨房', { limit: 5 }), ['r1'])
  assert.deepEqual(await reopened.query('书房', { limit: 5 }), ['r2'])
})

test('compaction（新增 docs 阈值）：达到阈值后并入 base 并清空日志', async () => {
  const dir = await newDir()
  const backend = createLocalLexicalBackend({ directory: dir, compactionDocs: 2 })
  await backend.index([record('r1', '厨房做饭', 1)])
  await backend.index([record('r2', '书房读书', 2)])
  assert.ok((await stat(logPathFor(dir))).size > 0, '未达 docs 阈值时仍应是增量日志')
  await backend.index([record('r3', '客厅休息', 3)])
  assert.equal((await stat(logPathFor(dir))).size, 0, '达阈值后日志必须清空')
  const base = JSON.parse(await readFile(basePathFor(dir), 'utf8'))
  assert.deepEqual(Object.keys(base.docs).sort(), ['r1', 'r2', 'r3'])
  const reopened = createLocalLexicalBackend({ directory: dir })
  assert.deepEqual(await reopened.query('厨房', { limit: 5 }), ['r1'])
  assert.deepEqual(await reopened.query('书房', { limit: 5 }), ['r2'])
  assert.deepEqual(await reopened.query('客厅', { limit: 5 }), ['r3'])
})

test('dispose：日志并入 base 并清空日志，新实例结果与 dispose 前等价（且幂等）', async () => {
  const dir = await newDir()
  const first = createLocalLexicalBackend({ directory: dir })
  await first.index([record('r1', '厨房做饭', 1)])
  await first.index([record('r2', '书房读书', 2)])
  const before = await first.query('厨房', { limit: 5 })
  assert.ok((await stat(logPathFor(dir))).size > 0, 'dispose 前应有悬空日志')
  const pending = first.dispose()
  assert.ok(pending instanceof Promise, 'dispose 仍须返回 Promise')
  await pending
  assert.equal((await stat(logPathFor(dir))).size, 0, 'dispose 后日志必须清空')
  const base = JSON.parse(await readFile(basePathFor(dir), 'utf8'))
  assert.deepEqual(Object.keys(base.docs).sort(), ['r1', 'r2'])
  const second = createLocalLexicalBackend({ directory: dir })
  assert.deepEqual(await second.query('厨房', { limit: 5 }), before)
  assert.deepEqual(await second.query('书房', { limit: 5 }), ['r2'])
  const settled = await stat(basePathFor(dir))
  await second.dispose()
  await second.dispose()
  assert.equal((await stat(basePathFor(dir))).mtimeMs, settled.mtimeMs, '无悬空日志时 dispose 不应重写 base')
})

test('崩溃窗口：base 已含某批而日志未截断时，重放不得把词频/记录重复计一次', async () => {
  const dir = await newDir()
  const base = {
    kind: LOCAL_LEXICAL_INDEX_KIND,
    schemaVersion: LOCAL_LEXICAL_SCHEMA_VERSION,
    backend: LOCAL_LEXICAL_BACKEND_NAME,
    updatedAt: '2026-01-01T00:00:00.000Z',
    limitReached: false,
    docs: { r1: { seq: 1, kind: 'projection-span', bytes: 8 }, r2: { seq: 2, kind: 'projection-span', bytes: 8 } },
    postings: { '厨房': { d: ['r1', 'r2'], f: [2, 1] } },
  }
  await writeFile(basePathFor(dir), JSON.stringify(base) + '\n', 'utf8')
  await writeFile(logPathFor(dir), JSON.stringify({ docs: base.docs, postings: { '厨房': [['r1', 2], ['r2', 1]] }, limitReached: false }) + '\n', 'utf8')
  const backend = createLocalLexicalBackend({ directory: dir })
  assert.deepEqual(await backend.query('厨房', { limit: 5 }), ['r1', 'r2'])
  await backend.dispose()
  const after = JSON.parse(await readFile(basePathFor(dir), 'utf8'))
  assert.deepEqual(after.postings['厨房'].d, ['r1', 'r2'], '重放已并入 base 的旧行不得重复追加 d')
  assert.deepEqual(after.postings['厨房'].f, [2, 1], '重放已并入 base 的旧行不得重复追加 f')
  assert.equal(Object.keys(after.docs).length, 2)
})

test('compaction 阈值跨重启：logBytes/docsSinceBase 由磁盘日志初始化，不因重启归零', async () => {
  const dir = await newDir()
  const first = createLocalLexicalBackend({ directory: dir })
  await first.index([record('r1', '厨房做饭', 1)]) // 建立 base
  // 磁盘上已有约 1 MB 日志（首行是合法 delta，其余为无法解析的填充）
  await writeFile(
    logPathFor(dir),
    JSON.stringify({ docs: { pad: { seq: 0, kind: 'pad', bytes: 0 } }, postings: { '厨房': [['pad', 1]] }, limitReached: false }) + '\n' + 'x'.repeat(1000000) + '\n',
    'utf8',
  )
  assert.ok((await stat(logPathFor(dir))).size >= 1000000)
  const second = createLocalLexicalBackend({ directory: dir })
  await second.index([record('r2', '书房读书', 2)])
  assert.equal((await stat(logPathFor(dir))).size, 0, '重启后仍须识别磁盘日志体量并触发 compaction')
  const base = JSON.parse(await readFile(basePathFor(dir), 'utf8'))
  assert.deepEqual(Object.keys(base.docs).sort(), ['pad', 'r1', 'r2'])
  assert.deepEqual(await second.query('书房', { limit: 5 }), ['r2'])
  assert.deepEqual((await second.query('厨房', { limit: 5 })).sort(), ['pad', 'r1'])
})

test('cleanup', async () => {
  for (const root of tmpRoots.splice(0)) await rm(root, { recursive: true, force: true })
})
