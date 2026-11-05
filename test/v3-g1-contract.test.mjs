/**
 * G1 合同面：封闭集、schema 与消费者一致、T2 不可分页（C-G1-01..03、C-G1-08..10、U3/U4）。
 *
 * ## 缺陷背景
 * - F01 的第二个成因是合同撒谎：`completeness` 是自由字符串，schema 不写枚举；
 *   `total_match_count` 没有「精确/未知」区分——top-k 长度冒充总数时没有一条合同能拦住。
 * - T2 只有 top-k/partial，没有穷尽信号（U4 读源码核实），必须**明确不支持继续**，
 *   不得编造 cursor/EOF。
 *
 * ## 判据
 * - `completeness` 是封闭集且写进 schema；所有真实返回值都落在集合内；
 * - `offset_unit`/摘录字段与域层 `EXCERPT_OFFSET_UNIT` 同源（不写第二份单位字面量）；
 * - 引擎真实输出逐字段通过 output schema（闭合对象：多一个字段都算破坏协议）；
 * - T2：total=null、completeness=partial、has_more=null、无 cursor，reason 反映真实降级状态；
 *   T1 的快照游标拿到 T2 上续读 → cursor-order-mismatch；
 * - 命中正文读不出来时如实计 `skipped_count`，不静默吞。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  SEARCH_COMPLETENESS,
  SEARCH_EXCERPT_MAX_CHARS,
  SEARCH_EXCERPT_VERSION,
  SEARCH_OFFSET_UNIT,
  SEARCH_TOOL_OUTPUT_SCHEMA,
  MEMORY_CONTEXT_TOOL_NAMES,
} from '../src/v3/contracts/tools.mjs'
import { EXCERPT_OFFSET_UNIT } from '../src/v3/domain/retrieval/excerpt.mjs'
import { encodeSearchCursor, orderIdOf } from '../src/v3/domain/retrieval/paging.mjs'
import { createMemoryContextTools } from '../src/v3/entry/tools.mjs'
import { attachV3Engine } from '../src/v3/entry/v3-entry.mjs'
import { createV3Runtime } from '../src/v3/composition/composition.mjs'
import { buildSummaryArtifact, sourceSetMaterial } from '../src/v3/domain/compress/summary-artifact.mjs'
import { recordHashMaterial } from '../src/v3/application/summary.mjs'
import { appendSummary } from '../src/v3/adapters/storage/summary-store.mjs'
import { createFakeSession } from './helpers/fake-session.mjs'

const sha256 = (text) => createHash('sha256').update(String(text), 'utf8').digest('hex')

function fakeCtx() {
  const handlers = new Map()
  const ctx = {
    on(name, handler) { handlers.set(name, handler); return () => handlers.delete(name) },
    logger: { warn() {}, info() {} },
  }
  ctx.callPreStep = async (session) => {
    const handler = handlers.get('agent/pre-step')
    return await handler({ agent: { session }, signal: undefined }, async () => ({ kind: 'enter' }))
  }
  return ctx
}

async function settle(engine) {
  await new Promise((resolve) => setTimeout(resolve, 200))
  await engine._waitForIdle().catch(() => {})
  await new Promise((resolve) => setTimeout(resolve, 100))
}

const PROBES = Array.from({ length: 5 }, (_, index) => 'CONTRACTPROBE-' + index + ' 合同面记录。')

/** 宿主子集 schema 校验器（只覆盖本 schema 用到的关键字；闭合对象多字段即红）。 */
function assertMatchesSchema(schema, value, at) {
  if (Array.isArray(schema.oneOf)) {
    const passes = schema.oneOf.some((child) => {
      try { assertMatchesSchema(child, value, at); return true } catch { return false }
    })
    assert.ok(passes, at + ' 不匹配任何 oneOf 分支：' + JSON.stringify(value))
    return
  }
  if (Array.isArray(schema.enum)) assert.ok(schema.enum.includes(value), at + ' 不在 enum 内：' + JSON.stringify(value))
  if (schema.type === 'array') {
    assert.ok(Array.isArray(value), at + ' 需要 array')
    for (const [index, item] of value.entries()) assertMatchesSchema(schema.items, item, at + '[' + index + ']')
    return
  }
  if (schema.type === 'object') {
    assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), at + ' 需要 object')
    const properties = schema.properties ?? {}
    for (const key of Object.keys(value)) {
      assert.ok(Object.hasOwn(properties, key), at + '.' + key + ' 不在 schema 声明里（闭合对象）')
      assertMatchesSchema(properties[key], value[key], at + '.' + key)
    }
    for (const key of schema.required ?? []) assert.ok(Object.hasOwn(value, key), at + ' 缺必填字段 ' + key)
    return
  }
  if (schema.type === 'string') assert.equal(typeof value, 'string', at + ' 需要 string')
  else if (schema.type === 'number') assert.equal(typeof value, 'number', at + ' 需要 number')
  else if (schema.type === 'boolean') assert.equal(typeof value, 'boolean', at + ' 需要 boolean')
  else if (schema.type === 'null') assert.equal(value, null, at + ' 需要 null')
}

test('合同：completeness 是封闭集且写进 schema；偏移单位与域层同源', () => {
  assert.deepEqual([...SEARCH_COMPLETENESS], ['complete', 'partial', 'unavailable', 'failed'])
  assert.deepEqual(SEARCH_TOOL_OUTPUT_SCHEMA.properties.completeness.enum, [...SEARCH_COMPLETENESS], 'schema 必须锁死枚举（旧缺陷：自由字符串）')
  assert.equal(SEARCH_OFFSET_UNIT, 'code-point')
  assert.equal(EXCERPT_OFFSET_UNIT, SEARCH_OFFSET_UNIT, '摘录单位只能有一个真源（C-G1-09）')
  assert.deepEqual(SEARCH_TOOL_OUTPUT_SCHEMA.properties.offset_unit.enum, [SEARCH_OFFSET_UNIT])
  assert.equal(SEARCH_EXCERPT_MAX_CHARS, 160)
  assert.equal(SEARCH_EXCERPT_VERSION, 1)
  const properties = SEARCH_TOOL_OUTPUT_SCHEMA.properties
  for (const field of ['total_match_count', 'reason', 'has_more', 'next_cursor', 'skipped_count', 'excerpt_version', 'offset_unit', 'items']) {
    assert.ok(Object.hasOwn(properties, field), 'schema 必须声明 ' + field)
  }
  const itemProperties = properties.items.items.properties
  for (const field of ['id', 'kind', 'title', 'excerpt', 'source_hash', 'text_hash', 'excerpt_spans', 'excerpt_strategy', 'excerpt_truncated', 'excerpt_source']) {
    assert.ok(Object.hasOwn(itemProperties, field), '命中项 schema 必须声明 ' + field)
  }
  assert.deepEqual(SEARCH_TOOL_OUTPUT_SCHEMA.required, ['status', 'scope', 'returned_count', 'completeness', 'items'], '旧必填字段不得删（兼容消费者）')
})

test('真实输出逐字段通过 output schema（含分页/游标/摘录字段）；completeness 恒在封闭集内', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-g1-contract-schema-'))
  const ctx = fakeCtx()
  const engine = attachV3Engine(ctx, { v3Root: root })
  try {
    const session = createFakeSession({ id: 'g1-contract-schema' })
    for (const text of PROBES) session.pushUser(text)
    const longText = '开头无关内容。'.repeat(200) + ' 尾部事实 SCHEMAPROBE99。'
    session.pushUser(longText)
    session.pushUser('当前问题：合同面校验。')
    await ctx.callPreStep(session)
    await settle(engine)
    const pages = []
    let cursor = null
    for (let index = 0; index < 10; index += 1) {
      const result = await engine.toolSearch(session.id, session, { query: 'CONTRACTPROBE', scope: 'all', limit: 2, cursor })
      assertMatchesSchema(SEARCH_TOOL_OUTPUT_SCHEMA, result, 'search[' + index + ']')
      assert.ok(SEARCH_COMPLETENESS.includes(result.completeness), 'completeness 越界：' + result.completeness)
      pages.push(result)
      if (typeof result.next_cursor !== 'string') break
      cursor = result.next_cursor
    }
    assert.ok(pages.length >= 2)
    // 摘要面：scope=summaries 走同一条 schema 路径（空集合也要合法）
    const summaries = await engine.toolSearch(session.id, session, { query: 'CONTRACTPROBE', scope: 'summaries', limit: 2 })
    assertMatchesSchema(SEARCH_TOOL_OUTPUT_SCHEMA, summaries, 'search[summaries]')
    assert.equal(summaries.returned_count, 0)
    assert.equal(summaries.total_match_count, 0)
    assert.equal(summaries.completeness, 'complete')
    // 摘录字段：尾部命中必须带可复核的 span（码点）
    const tail = await engine.toolSearch(session.id, session, { query: 'SCHEMAPROBE99', scope: 'records', limit: 5 })
    assertMatchesSchema(SEARCH_TOOL_OUTPUT_SCHEMA, tail, 'search[tail]')
    const item = tail.items[0]
    assert.ok(item.excerpt.includes('SCHEMAPROBE99'))
    assert.ok(item.excerpt_spans.length > 0)
    assert.ok(item.excerpt_spans.every((span) => Number.isInteger(span.start) && Number.isInteger(span.end) && span.end > span.start))
  } finally {
    try { await engine.dispose() } catch {}
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})

/** 造一个 T2 形态的后端（本地结果照常，能力面声明 tier=T2、exhaustive=false）。 */
async function withT2Engine(id, texts, fn) {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-g1-contract-t2-'))
  const ctx = fakeCtx()
  const session = createFakeSession({ id })
  for (const text of texts) session.pushUser(text)
  session.pushUser('当前问题：T2 合同面。')
  const runtime = await createV3Runtime({ v3Root: root, dshSession: session, sessionKey: id })
  const state = { mode: 'success' }
  const t2Provider = {
    async search(query, opts) {
      const base = await runtime.provider.search(query, opts)
      if (state.mode === 'success') return { ...base, status: 'success', t1Fallback: false }
      if (state.mode === 'partial') return { ...base, status: 'partial', t1Fallback: true, reason: '外部检索超时（回退 T1）' }
      return { ...base, status: state.mode, t1Fallback: true, reason: '外部检索降级' }
    },
    read: (recordId) => runtime.provider.read(recordId),
    health: () => runtime.provider.health(),
    capabilities: () => ({ name: 'local-lexical-v3+t2-isolated', tier: 'T2', live: true, isolated: true }),
    retrievalSnapshot: async () => ({ tier: 'T2', exhaustive: false, generation: '0123456789abcdef' }),
    chunksOf: (recordId) => runtime.provider.chunksOf(recordId),
  }
  const engine = attachV3Engine(ctx, { v3Root: root, runtimeFactory: async () => ({ ...runtime, provider: t2Provider }) })
  try {
    await ctx.callPreStep(session)
    await settle(engine)
    return await fn({ engine, session, runtime, state })
  } finally {
    try { await engine.dispose() } catch {}
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
}

test('T2：没有穷尽信号 → total=null / partial / has_more=null / 不给 cursor（不编造继续）', async () => {
  await withT2Engine('g1-contract-t2', PROBES, async ({ engine, session, state }) => {
    for (const [mode, reason] of [['success', 't2-no-exhaustion-signal'], ['partial', 't2-partial'], ['failed', 't2-failed'], ['cancelled', 't2-cancelled'], ['unsupported', 't2-unsupported']]) {
      state.mode = mode
      const result = await engine.toolSearch(session.id, session, { query: 'CONTRACTPROBE', scope: 'records', limit: 2 })
      assert.equal(result.status, 'ok', mode + '：工具本身成功（后端降级通过 reason 表达）')
      assert.equal(result.total_match_count, null, mode + '：T2 不得给精确 total')
      assert.equal(result.completeness, 'partial', mode + '：T2 不得声称查全')
      assert.equal(result.has_more, null, mode + '：是否还有更多=未知')
      assert.equal(result.next_cursor, null, mode + '：不得编造 cursor')
      assert.equal(result.reason, reason, mode + '：原因码必须反映真实降级状态')
      assert.ok(result.items.length > 0, mode + '：本地结果照常返回（不是整页失败）')
      assertMatchesSchema(SEARCH_TOOL_OUTPUT_SCHEMA, result, 't2[' + mode + ']')
    }
    // T1 快照游标拿到 T2 上续读 → 排序规则不匹配（不把偏移套进另一套排序）
    const t1Cursor = encodeSearchCursor({
      hash: sha256,
      sessionId: session.id,
      query: 'CONTRACTPROBE',
      scope: 'records',
      generation: 'fedcba9876543210',
      recordsOffset: 2,
    })
    const rejected = await engine.toolSearch(session.id, session, { query: 'CONTRACTPROBE', scope: 'records', limit: 2, cursor: t1Cursor })
    assert.equal(rejected.status, 'rejected')
    assert.equal(rejected.reason, 'cursor-order-mismatch')
    assert.equal(rejected.returned_count, 0)
    assert.notEqual(orderIdOf('records', true), orderIdOf('records', false))
  })
})

test('命中正文读不出来：如实计 skipped_count 并给原因，不静默吞（total 不变）', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-g1-contract-skip-'))
  const ctx = fakeCtx()
  const session = createFakeSession({ id: 'g1-contract-skip' })
  for (const text of PROBES) session.pushUser(text)
  session.pushUser('当前问题：跳过计数。')
  const runtime = await createV3Runtime({ v3Root: root, dshSession: session, sessionKey: 'g1-contract-skip' })
  const storeProxy = Object.create(runtime.store)
  const hidden = { id: null }
  storeProxy.readRecord = async (recordId) => (recordId === hidden.id ? null : runtime.store.readRecord(recordId))
  const engine = attachV3Engine(ctx, { v3Root: root, runtimeFactory: async () => ({ ...runtime, store: storeProxy }) })
  try {
    await ctx.callPreStep(session)
    await settle(engine)
    const probe = await engine.toolSearch(session.id, session, { query: 'CONTRACTPROBE', scope: 'records', limit: 10 })
    assert.equal(probe.total_match_count, 5)
    hidden.id = probe.items[0].id
    const result = await engine.toolSearch(session.id, session, { query: 'CONTRACTPROBE', scope: 'records', limit: 2 })
    assert.equal(result.total_match_count, 5, 'total 是索引侧的可信计数，不因一次读取失败而缩小')
    assert.equal(result.skipped_count, 1, '读不出来的一条必须计数')
    assert.equal(result.returned_count, 1, '本页只剩 1 条可读')
    assert.equal(result.reason, 'some-hits-unreadable')
    assert.equal(result.has_more, true, '还有下一页（索引侧仍有剩余）')
    assertMatchesSchema(SEARCH_TOOL_OUTPUT_SCHEMA, result, 'search[skipped]')
  } finally {
    try { await engine.dispose() } catch {}
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})

test('render：游标被拒给出可执行建议；total 未知不冒充 0；T2 说明覆盖差别', async () => {
  const [search] = createMemoryContextTools({ engine: null })
  const rejected = search.output.render({}, {
    status: 'rejected', scope: 'records', returned_count: 0, total_match_count: null,
    completeness: 'unavailable', reason: 'cursor-legacy-format', has_more: null,
    offset_unit: SEARCH_OFFSET_UNIT, excerpt_version: SEARCH_EXCERPT_VERSION, skipped_count: 0,
    next_cursor: null, items: [], error: 'cursor-legacy-format',
  })[0].text
  assert.match(rejected, /cursor-legacy-format/)
  assert.match(rejected, /旧版裸数字 cursor/, '必须告诉模型这是旧格式被拒')
  assert.match(rejected, /不带 cursor 重新检索/, '必须给出可执行建议（不许静默回第一页）')
  assert.match(rejected, /total=未知/)

  const t2 = search.output.render({}, {
    status: 'ok', scope: 'records', returned_count: 1, total_match_count: null,
    completeness: 'partial', reason: 't2-no-exhaustion-signal', has_more: null,
    offset_unit: SEARCH_OFFSET_UNIT, excerpt_version: SEARCH_EXCERPT_VERSION, skipped_count: 0,
    next_cursor: null,
    items: [{ id: 'v3r-0000000000000001', kind: 'message-user', title: null, excerpt: '片段', source_hash: null, text_hash: null, excerpt_spans: [{ start: 3, end: 5 }], excerpt_strategy: 'scan-fallback', excerpt_truncated: true, excerpt_source: 'record-text' }],
    error: null,
  })[0].text
  assert.match(t2, /total=未知/)
  assert.match(t2, /是否还有更多=未知/)
  assert.match(t2, /T2（隔离灵枢）只给 top-k/)
  assert.match(t2, /码点 3–5；已截断/, '摘录要标注码点 span 与截断状态')
  assert.match(t2, /memory_context_read/)
})

test('execute 归一：缺省字段补全为封闭信封（宿主 output.schema 不容多/少字段）', async () => {
  const engine = {
    noteOwnToolCall() {},
    async toolSearch() {
      return { status: 'ok', scope: 'records', returned_count: 0, total_match_count: 0, completeness: 'complete', items: [], error: null }
    },
  }
  const [search] = createMemoryContextTools({ engine })
  const value = await search.execute({ query: 'q' }, { callId: 'c1', agent: { session: { id: 's1' } } })
  assertMatchesSchema(SEARCH_TOOL_OUTPUT_SCHEMA, value, 'execute')
  assert.equal(value.has_more, null, '引擎没给 has_more 时按未知（不是 false=已查全）')
  assert.equal(value.reason, null)
  assert.equal(value.skipped_count, 0)
  assert.equal(value.offset_unit, SEARCH_OFFSET_UNIT)
  assert.equal(value.excerpt_version, SEARCH_EXCERPT_VERSION)
  assert.equal(MEMORY_CONTEXT_TOOL_NAMES.search, 'memory_context_search')
})
/**
 * P2-1（修复批）：末页（limit ≥ 命中数）有不可读命中时，completeness 不得为 complete。
 *
 * 合同（contracts/tools.mjs 的 SEARCH_COMPLETENESS 注释 + 证据 §4.2）：complete = 该 scope
 * 已穷尽，**且没有不可读命中被跳过**。旧实现只看 has_more，于是同一页既说「已查全」
 * 又说「另有 1 条未列入」。本用例钉住末页分支（另一分支 has_more=true 见 skipped 用例）。
 */
test('P2-1：末页有不可读命中 → has_more=false 但 completeness=partial，render 不得说「已查全」', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-g1-contract-skip-last-'))
  const ctx = fakeCtx()
  const session = createFakeSession({ id: 'g1-contract-skip-last' })
  for (const text of PROBES) session.pushUser(text)
  session.pushUser('当前问题：末页跳过。')
  const runtime = await createV3Runtime({ v3Root: root, dshSession: session, sessionKey: 'g1-contract-skip-last' })
  const storeProxy = Object.create(runtime.store)
  const hidden = { id: null }
  storeProxy.readRecord = async (recordId) => (recordId === hidden.id ? null : runtime.store.readRecord(recordId))
  const engine = attachV3Engine(ctx, { v3Root: root, runtimeFactory: async () => ({ ...runtime, store: storeProxy }) })
  try {
    await ctx.callPreStep(session)
    await settle(engine)
    const probe = await engine.toolSearch(session.id, session, { query: 'CONTRACTPROBE', scope: 'records', limit: 10 })
    assert.equal(probe.total_match_count, 5)
    assert.equal(probe.returned_count, 5, '前置：正常情况下 5 条都能读出（limit ≥ 命中数 = 末页）')
    hidden.id = probe.items[0].id
    const result = await engine.toolSearch(session.id, session, { query: 'CONTRACTPROBE', scope: 'records', limit: 10 })
    assert.equal(result.total_match_count, 5)
    assert.equal(result.returned_count, 4)
    assert.equal(result.skipped_count, 1)
    assert.equal(result.has_more, false, '枚举确实已穷尽（没有更多页）')
    assert.equal(result.completeness, 'partial', '跳过了一条命中就不许报 complete（P2-1）')
    assert.equal(result.reason, 'some-hits-unreadable')
    assert.equal(result.next_cursor, null)
    assertMatchesSchema(SEARCH_TOOL_OUTPUT_SCHEMA, result, 'search[skipped-last]')
    const [search] = createMemoryContextTools({ engine: null })
    const rendered = search.output.render({}, result)[0].text
    assert.ok(!rendered.includes('已查全'), 'render 不得在 partial 页写「已查全」：' + rendered)
    assert.match(rendered, /没有更多页（但本页结果不完整/)
    assert.match(rendered, /另有 1 条命中/)
  } finally {
    try { await engine.dispose() } catch {}
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})

/** 直接在 store 目录物化一条摘要工件（与 compact 服务同一套 domain/适配器，不复制算法）。 */
async function appendTestSummary(runtime, { summaryId, shortText, recordIds, createdAt }) {
  const sources = []
  for (const recordId of recordIds) {
    const record = await runtime.store.readRecord(recordId)
    sources.push({ recordId, hash: runtime.hash.sha256(recordHashMaterial(record)) })
  }
  const artifact = buildSummaryArtifact({
    summaryId,
    sessionKey: runtime.sessionKey,
    sources,
    generator: 'model',
    generatorVersion: 'model-draft-v1',
    draft: { shortText, detail: shortText + '（详细摘要）。', outcome: 'partial' },
    createdAt,
    sourceSetFingerprint: runtime.hash.sha256(sourceSetMaterial(sources)),
  })
  const written = await appendSummary(runtime.store.directory, artifact)
  assert.notEqual(written.ok, false, '摘要工件必须落盘成功：' + JSON.stringify(written))
  return artifact
}

/**
 * P3-1（修复批，分集合判定）：摘要检索来自**本地 summary-store**（total 精确、顺序确定），
 * 与 T2 外部融合无关，所以 T2 会话下 scope=summaries 必须能翻页；只有 records 面才受
 * 「T2 没有穷尽信号」约束。旧实现用 tier 一刀切 → 第 3 条摘要永远取不到。
 */
test('P3-1：T2 会话下 scope=summaries 仍可分页（摘要本地可枚举，不受外部 top-k 限制）', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-g1-contract-t2-summaries-'))
  const ctx = fakeCtx()
  const session = createFakeSession({ id: 'g1-contract-t2-sums' })
  const recordTexts = Array.from({ length: 3 }, (_, index) => 'SUMPROBE R-' + index + ' 摘要来源记录。')
  for (const text of recordTexts) session.pushUser(text)
  session.pushUser('当前问题：T2 摘要分页。')
  const runtime = await createV3Runtime({ v3Root: root, dshSession: session, sessionKey: 'g1-contract-t2-sums' })
  const t2Provider = {
    async search(query, opts) {
      const base = await runtime.provider.search(query, opts)
      return { ...base, status: 'success', t1Fallback: false }
    },
    read: (recordId) => runtime.provider.read(recordId),
    health: () => runtime.provider.health(),
    capabilities: () => ({ name: 'local-lexical-v3+t2-isolated', tier: 'T2', live: true }),
    retrievalSnapshot: async () => ({ tier: 'T2', exhaustive: false, generation: '0123456789abcdef' }),
    chunksOf: (recordId) => runtime.provider.chunksOf(recordId),
  }
  const engine = attachV3Engine(ctx, { v3Root: root, runtimeFactory: async () => ({ ...runtime, provider: t2Provider }) })
  try {
    await ctx.callPreStep(session)
    await settle(engine)
    const { ids } = await engine.recordIdsOf(session.id)
    const summaryIds = ['v3s-00000000000000c1', 'v3s-00000000000000c2', 'v3s-00000000000000c3']
    for (const [index, summaryId] of summaryIds.entries()) {
      await appendTestSummary(runtime, { summaryId, shortText: 'SUMPROBE 摘要 ' + index + '：待复核。', recordIds: [ids[0]], createdAt: 1000 + index })
    }
    const first = await engine.toolSearch(session.id, session, { query: 'SUMPROBE', scope: 'summaries', limit: 2 })
    assert.equal(first.total_match_count, 3, '摘要 total 精确（本地可穷尽）')
    assert.equal(first.returned_count, 2)
    assert.equal(first.has_more, true, 'T2 下摘要仍应能翻页（P3-1）')
    assert.equal(typeof first.next_cursor, 'string')
    assert.equal(first.reason, null, '摘要面分页不是降级，不该带 T2 原因码')
    const second = await engine.toolSearch(session.id, session, { query: 'SUMPROBE', scope: 'summaries', limit: 2, cursor: first.next_cursor })
    assert.equal(second.returned_count, 1)
    assert.equal(second.has_more, false)
    assert.equal(second.completeness, 'complete')
    const union = [...first.items, ...second.items].map((item) => item.id)
    assert.deepEqual([...union].sort(), [...summaryIds].sort(), '两页并集必须覆盖全部 3 条摘要')
    // 反证：同一 T2 会话的 records 面仍不可分页（没有穷尽信号）
    const records = await engine.toolSearch(session.id, session, { query: 'SUMPROBE', scope: 'records', limit: 1 })
    assert.equal(records.has_more, null)
    assert.equal(records.next_cursor, null)
    assert.equal(records.reason, 't2-no-exhaustion-signal')
  } finally {
    try { await engine.dispose() } catch {}
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})
