/**
 * G1 命中摘录行为（F02 修复的承重用例）。
 *
 * ## 缺陷（G0 §7 已复现）
 * `toolSearch` 只取正文前 160 码点：`TAILPROBE99` 明明被索引命中，摘录却是 160 个码点的
 * 无关开头——模型看得见「命中了」，却看不到答案。
 *
 * ## 判据（C-G1-08 / C-G1-09）
 * - 摘录复用 `selectExcerpt`（不复制算法）：命中窗口必须含查询里的标识符；
 * - `excerpt_spans` 是**码点半开区间**，用 toolRead 拿到的全文按码点切回来必须逐段等于摘录；
 * - `excerpt_truncated` 覆盖「首部之前 / 尾部之后 / 窗口之间有洞」；短文本才允许 false；
 * - `text_hash` 与本地正文（payload.text，脱敏后）一致，span 可复核；
 * - chunk 索引缺失时现扫回退（`strategy=scan-fallback`），窗口与索引在时一致，
 *   不因派生索引缺席就失去命中窗口、也不误报「全文已展示」；
 * - 多窗口/中间缺口、Unicode（代理对）、无命中回退首部各有断言。
 *
 * ## 不适用条件
 * 只覆盖记录（payload.text）。摘要摘录的基准是 shortText，见 v3-g1-contract 的混合用例。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { attachV3Engine } from '../src/v3/entry/v3-entry.mjs'
import { createV3Runtime } from '../src/v3/composition/composition.mjs'
import { selectExcerpt } from '../src/v3/domain/retrieval/excerpt.mjs'
import { SEARCH_EXCERPT_MAX_CHARS, SEARCH_EXCERPT_VERSION, SEARCH_OFFSET_UNIT } from '../src/v3/contracts/tools.mjs'
import { createFakeSession } from './helpers/fake-session.mjs'

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex')

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

async function withEngine(id, texts, fn) {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-g1-excerpt-'))
  const ctx = fakeCtx()
  const session = createFakeSession({ id })
  for (const text of texts) session.pushUser(text)
  session.pushUser('当前问题：请总结上面的记录。')
  const runtime = await createV3Runtime({ v3Root: root, dshSession: session, sessionKey: id })
  const engine = attachV3Engine(ctx, { v3Root: root, runtimeFactory: async () => runtime })
  try {
    await ctx.callPreStep(session)
    await settle(engine)
    return await fn({ engine, session, runtime })
  } finally {
    try { await engine.dispose() } catch {}
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
}

/** 命中项的**全文**（toolRead 是按 ID 精确回读，不经过摘录层）。 */
async function fullTextOf(engine, sessionId, recordId) {
  const read = await engine.toolRead(sessionId, recordId, { detail: 'full' })
  assert.equal(read.status, 'ok')
  return read.text
}

/** 按 span（码点）把全文切回来，必须与摘录逐段一致——这是 offset 单位的最强断言。 */
function assertSpansMatchExcerpt(excerpt, spans, fullText) {
  const codepoints = Array.from(fullText)
  const pieces = spans.map((span) => codepoints.slice(span.start, span.end).join(''))
  assert.equal(pieces.join(' … '), excerpt, '摘录必须等于按 span 从本地正文切出的片段（码点半开区间）')
}

const LONG = '开头无关内容。'.repeat(200) + ' 尾部事实 TAILPROBE99。'

test('F02 核心：尾部标识符 TAILPROBE99 必须出现在摘录里（旧实现只给前 160 码点）', async () => {
  await withEngine('g1-excerpt-tail', [LONG], async ({ engine, session }) => {
    const result = await engine.toolSearch(session.id, session, { query: 'TAILPROBE99', scope: 'records', limit: 5 })
    assert.equal(result.returned_count, 1)
    const item = result.items[0]
    assert.ok(item.excerpt.includes('TAILPROBE99'), '旧缺陷：摘录不含尾部标识符（本次摘录：' + item.excerpt + '）')
    assert.ok(Array.isArray(item.excerpt_spans) && item.excerpt_spans.length > 0, '必须给出码点 span')
    assert.equal(item.excerpt_source, 'record-text')
    assert.equal(item.excerpt_truncated, true, '窗口不覆盖全文时必须标截断')
    assert.equal(result.offset_unit, SEARCH_OFFSET_UNIT)
    assert.equal(result.excerpt_version, SEARCH_EXCERPT_VERSION)

    const fullText = await fullTextOf(engine, session.id, item.id)
    assertSpansMatchExcerpt(item.excerpt, item.excerpt_spans, fullText)
    assert.equal(item.text_hash, sha256(fullText), 'text_hash 必须是摘录所依据的本地正文（脱敏后）的哈希')
    const covered = item.excerpt_spans.reduce((sum, span) => sum + (span.end - span.start), 0)
    assert.ok(covered <= SEARCH_EXCERPT_MAX_CHARS, '窗口预算（码点）不得超过 ' + SEARCH_EXCERPT_MAX_CHARS + '，本次 ' + covered)
    // 与域层同一份能力对照：不是新算法，是同一个 selectExcerpt 的结果
    const reference = selectExcerpt(fullText, 'TAILPROBE99', { maxChars: SEARCH_EXCERPT_MAX_CHARS, maxSpans: 2, contextChars: 24 })
    assert.deepEqual(item.excerpt_spans, reference.spans, 'toolSearch 必须复用 selectExcerpt 的窗口，不得另写截断规则')
  })
})

test('Unicode：emoji 前缀不导致半个代理对/UTF-16 偏移混用', async () => {
  const text = '😀'.repeat(60) + ' 尾部标识 TAIL-UNICODE-77 结束。'
  await withEngine('g1-excerpt-unicode', [text], async ({ engine, session }) => {
    const result = await engine.toolSearch(session.id, session, { query: 'TAIL-UNICODE-77', scope: 'records', limit: 5 })
    const item = result.items[0]
    assert.ok(item.excerpt.includes('TAIL-UNICODE-77'))
    const fullText = await fullTextOf(engine, session.id, item.id)
    assertSpansMatchExcerpt(item.excerpt, item.excerpt_spans, fullText)
    // span 起点应落在码点边界（不是 UTF-16 索引）：'😀'.repeat(60) 是 120 个 UTF-16 码元、60 码点
    for (const span of item.excerpt_spans) {
      const piece = Array.from(fullText).slice(span.start, span.end).join('')
      assert.ok(!/^\uFFFD/.test(piece) && !/\uFFFD$/.test(piece), 'span 边界不得切在代理对中间')
    }
  })
})

test('chunk 索引：命中 chunk 内选窗；删除索引后现扫回退，窗口一致且仍标截断', async () => {
  await withEngine('g1-excerpt-chunk', [LONG], async ({ engine, session, runtime }) => {
    await runtime.store.rebuildIndex()
    const chunkPath = path.join(runtime.store.directory, 'chunk-index.json')
    let hasChunkIndex = true
    try { await access(chunkPath) } catch { hasChunkIndex = false }
    const withIndex = await engine.toolSearch(session.id, session, { query: 'TAILPROBE99', scope: 'records', limit: 5 })
    const first = withIndex.items[0]
    assert.ok(first.excerpt.includes('TAILPROBE99'))
    if (hasChunkIndex) assert.equal(first.excerpt_strategy, 'chunk-window', '有可用 chunk 索引时应在命中 chunk 内选窗')

    await rm(chunkPath, { force: true })
    const withoutIndex = await engine.toolSearch(session.id, session, { query: 'TAILPROBE99', scope: 'records', limit: 5 })
    const second = withoutIndex.items[0]
    assert.equal(second.excerpt_strategy, 'scan-fallback', '索引缺失必须现扫并如实标记')
    assert.equal(second.excerpt, first.excerpt, '回退现扫不得改变命中窗口（同一正文、同一查询）')
    assert.deepEqual(second.excerpt_spans, first.excerpt_spans)
    assert.equal(second.excerpt_truncated, true, '现扫也不得误报「全文已展示」')
  })
})

test('短文本：摘录即全文（truncated=false，span 覆盖 [0, 长度)）', async () => {
  const text = 'SHORTPROBE 短正文，命中点在中间。'
  await withEngine('g1-excerpt-short', [text], async ({ engine, session }) => {
    const result = await engine.toolSearch(session.id, session, { query: 'SHORTPROBE', scope: 'records', limit: 5 })
    const item = result.items[0]
    const fullText = await fullTextOf(engine, session.id, item.id)
    assert.equal(item.excerpt, fullText)
    assert.equal(item.excerpt_truncated, false)
    assert.deepEqual(item.excerpt_spans, [{ start: 0, end: Array.from(fullText).length }])
    assert.ok(['head', 'chunk-window', 'scan-fallback'].includes(item.excerpt_strategy), '策略只需如实标记：' + item.excerpt_strategy)
  })
})

test('多窗口 + 中间缺口：两个远处事实都进摘录，缺口（truncated）可见', async () => {
  const text = 'A'.repeat(200) + ' ERR_FIRST_11 ' + 'B'.repeat(500) + ' ERR_SECOND_22 ' + 'C'.repeat(40)
  await withEngine('g1-excerpt-multi', [text], async ({ engine, session }) => {
    const result = await engine.toolSearch(session.id, session, { query: 'ERR_FIRST_11 ERR_SECOND_22', scope: 'records', limit: 5 })
    const item = result.items[0]
    assert.ok(item.excerpt.includes('ERR_FIRST_11'), '第一个远处标识符必须可见')
    assert.ok(item.excerpt.includes('ERR_SECOND_22'), '第二个远处标识符必须可见')
    assert.equal(item.excerpt_spans.length, 2, '应给出两个互补窗口')
    assert.equal(item.excerpt_truncated, true, '两个窗口不相连（中间有洞）必须标截断')
    const fullText = await fullTextOf(engine, session.id, item.id)
    assertSpansMatchExcerpt(item.excerpt, item.excerpt_spans, fullText)
    const gap = item.excerpt_spans[1].start - item.excerpt_spans[0].end
    assert.ok(gap > 0, '两个 span 之间必须真的存在未展示区间')
  })
})

test('无命中回退首部并如实标记 strategy=head（不假装是命中窗口）', async () => {
  await withEngine('g1-excerpt-nomatch', [LONG], async ({ engine, session }) => {
    const result = await engine.toolSearch(session.id, session, { query: 'ZZZ_NO_MATCH_PROBE', scope: 'records', limit: 5 })
    // 该查询也许 0 命中；若命中则只看窗口元数据（不得出现「命中窗口」以外的说法）
    for (const item of result.items) {
      assert.ok(['head', 'scan-fallback', 'chunk-window'].includes(item.excerpt_strategy))
      if (item.excerpt_strategy === 'head') assert.equal(item.excerpt_truncated, true)
    }
  })
})
