/**
 * T1 本地词法检索后端测试：词条化、AND 语义、持久化、增量幂等、上限如实报、崩溃重建。
 * 全部使用临时隔离目录，不触碰真实 $DSH_HOME，不依赖任何外部进程。
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  createLocalLexicalBackend,
  tokenizeForLexicalIndex,
  LOCAL_LEXICAL_BACKEND_NAME,
  LOCAL_LEXICAL_INDEX_FILE,
  LOCAL_LEXICAL_LOG_FILE,
  LOCAL_LEXICAL_LOG_KIND,
  LOCAL_LEXICAL_COMPACT_LINES,
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

test('多词门槛（P1-2）：只碰一个通用词的记录按无关处理', async () => {
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

test('崩溃/文件缺失：base 与日志都缺失时从空索引重建', async () => {
  const dir = await newDir()
  const first = createLocalLexicalBackend({ directory: dir })
  await first.index([record('r1', '厨房做饭', 1)])
  await rm(path.join(dir, LOCAL_LEXICAL_INDEX_FILE), { force: true })
  await rm(path.join(dir, LOCAL_LEXICAL_LOG_FILE), { force: true })
  const second = createLocalLexicalBackend({ directory: dir })
  assert.deepEqual(await second.query('厨房', { limit: 5 }), [])
})

test('压实前崩溃：base 缺失但日志仍在，新实例重放日志后仍能命中', async () => {
  const dir = await newDir()
  const first = createLocalLexicalBackend({ directory: dir })
  await first.index([record('r1', '厨房做饭', 1)])
  // 只删 base：新 base 还没落盘（或写到一半），日志必须能独立重建已索引状态。
  await rm(path.join(dir, LOCAL_LEXICAL_INDEX_FILE), { force: true })
  const second = createLocalLexicalBackend({ directory: dir })
  assert.deepEqual(await second.query('厨房', { limit: 5 }), ['r1'])
})

test('压实时 base 自足：日志清空后新实例仍能命中', async () => {
  const dir = await newDir()
  const first = createLocalLexicalBackend({ directory: dir })
  await first.index([record('r1', '厨房做饭', 1)])
  await first.dispose()
  await rm(path.join(dir, LOCAL_LEXICAL_LOG_FILE), { force: true })
  const second = createLocalLexicalBackend({ directory: dir })
  assert.deepEqual(await second.query('厨房', { limit: 5 }), ['r1'])
})

test('代次不匹配的旧日志不重放：压实后不会把同一条增量算两次', async () => {
  const dir = await newDir()
  const first = createLocalLexicalBackend({ directory: dir })
  await first.index([record('r1', '厨房做饭', 1)])
  await first.dispose()
  // base 已推进到 gen=1；再伪造一条 base=0 的旧日志，必须被忽略。
  await writeFile(
    path.join(dir, LOCAL_LEXICAL_LOG_FILE),
    JSON.stringify({ kind: LOCAL_LEXICAL_LOG_KIND, base: 0, t: 'doc', id: 'r2', meta: {}, terms: [['书房', 1]] }) + '\n',
    'utf8',
  )
  const second = createLocalLexicalBackend({ directory: dir })
  assert.deepEqual(await second.query('书房', { limit: 5 }), [])
  assert.deepEqual(await second.query('厨房', { limit: 5 }), ['r1'])
})

test('增量索引不重写 base：只追加日志（PR #7 回归）', async () => {
  const dir = await newDir()
  const backend = createLocalLexicalBackend({ directory: dir })
  for (let i = 0; i < 40; i += 1) {
    await backend.index([record('r' + i, '厨房记录' + i, i + 1)])
  }
  // base 只有压实时才写；40 条增量远未到阈值，目录里只应有日志。
  await assert.rejects(stat(path.join(dir, LOCAL_LEXICAL_INDEX_FILE)), (error) => error.code === 'ENOENT')
  const log = await stat(path.join(dir, LOCAL_LEXICAL_LOG_FILE))
  assert.ok(log.size > 0, '日志应包含增量条目')
})

test('日志超过压实阈值：写 base 并清空日志，检索仍正确', async () => {
  const dir = await newDir()
  const backend = createLocalLexicalBackend({ directory: dir })
  const total = LOCAL_LEXICAL_COMPACT_LINES
  for (let i = 0; i < total; i += 1) {
    await backend.index([record('r' + i, '厨房记录' + i, i + 1)])
  }
  const baseInfo = await stat(path.join(dir, LOCAL_LEXICAL_INDEX_FILE))
  assert.ok(baseInfo.size > 0, '越过阈值后必须落一次 base')
  const log = await stat(path.join(dir, LOCAL_LEXICAL_LOG_FILE))
  assert.equal(log.size, 0, '压实后日志必须清空')
  const second = createLocalLexicalBackend({ directory: dir })
  assert.deepEqual(await second.query('厨房记录' + (total - 1), { limit: 5 }), ['r' + (total - 1)])
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

test('queryDetailed 的 exclude：被排除记录不进弱候选（PR #8 P2-1 回归）', async () => {
  const dir = await newDir()
  const backend = createLocalLexicalBackend({ directory: dir })
  await backend.index([
    record('r1', '厨房做饭', 1),
    record('r2', '书房收纳', 2),
    record('r3', '客厅布置', 3),
  ])
  // 三个词元都已知且各只被一条文档覆盖：单条文档的覆盖率约 1/3，落在弱候选区。
  const detail = await backend.queryDetailed('厨房 书房 客厅', { weakLimit: 5 })
  assert.ok(detail.weak.some((item) => item.id === 'r1'), '未排除时应能给出弱候选')
  const excluded = await backend.queryDetailed('厨房 书房 客厅', { weakLimit: 5, exclude: ['r1'] })
  assert.ok(!excluded.weak.some((item) => item.id === 'r1'), 'exclude 的记录不得出现在弱候选')
})

test('新近度破平：同分时 seq 大者优先', async () => {
  const dir = await newDir()
  const backend = createLocalLexicalBackend({ directory: dir })
  await backend.index([record('r1', '厨房记录', 1), record('r2', '厨房记录', 2)])
  assert.deepEqual(await backend.query('厨房', { limit: 5 }), ['r2', 'r1'])
})

test('P1-2 dev 集：OR 召回 + 覆盖率放行——改写记录可命中，无关主题零命中', async () => {
  const dir = await newDir()
  const backend = createLocalLexicalBackend({ directory: dir })
  await backend.index([
    record('a', '恢复失败的重试路径已在冷库留档，恢复与重试都可按记录 ID 回读', 1),
    record('b', '厨房做饭洗碗，今天的午饭做了两菜一汤，味道不错', 2),
    record('c', '失败之后重试：路径与恢复策略讨论，含恢复失败案例', 3),
    record('d', '周报：本周完成了三件事，下周计划继续开发', 4),
    record('e', '周报里的失败总结与 retrospective 无关内容', 5),
  ])
  // 主题词全中（a）与主题词多数中的改写记录（c）都能命中——旧 AND 只会返回 a。
  assert.deepEqual(await backend.query('恢复失败的重试路径', { limit: 5 }), ['a', 'c'])
  // 无关主题（厨房做饭）只返回自己的记录，开发/周报记录零正文。
  assert.deepEqual(await backend.query('厨房 做饭', { limit: 5 }), ['b'])
  // 只碰一个通用词（失败，且是低 idf 词）的记录 e：低于门槛，按无关处理。
  assert.deepEqual(await backend.query('恢复 重试 冷库 留档 失败', { limit: 5 }), ['a', 'c'])
})

test('P1-2 精确通道：exact 词元全部命中才返回，与自由通道 AND 组合', async () => {
  const dir = await newDir()
  const backend = createLocalLexicalBackend({ directory: dir })
  await backend.index([
    record('a', '恢复失败的重试路径已在冷库留档，恢复与重试都可按记录 ID 回读', 1),
    record('c', '失败之后重试：路径与恢复策略讨论，含恢复失败案例', 3),
  ])
  // exact 记录 ID 不在任何文档里：AND 关卡如实空手，不降级成 OR。
  assert.deepEqual(await backend.query('冷库 留档', { limit: 5, exact: ['t00000037-r0000'] }), [])
  // exact 命中 + 自由词命中：a 同时满足。
  assert.deepEqual(await backend.query('冷库', { limit: 5, exact: ['留档'] }), ['a'])
  // exact 命中但自由词不存在：exact 是硬闸门、自由词只参与排序，仍返回（按计划「精确通道不走 OR 阈值」）。
  assert.deepEqual(await backend.query('洗碗', { limit: 5, exact: ['留档'] }), ['a'])
})

test('cleanup', async () => {
  for (const root of tmpRoots.splice(0)) await rm(root, { recursive: true, force: true })
})
