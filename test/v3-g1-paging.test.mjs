/**
 * G1 搜索分页行为（F01 修复的承重用例）。
 *
 * ## 缺陷（G0 §7 已复现）
 * `toolSearch` 把 provider top-k 长度当 total：9 条 CACHEPROBE 记录、`limit=2` 时返回
 * `total_match_count=2 / completeness=complete / next_cursor=null`——模型会认为「只有 2 条，
 * 已经查全」，而实际还有 7 条。`scope=all` 还共用同一个 offset（摘要永远饥饿）。
 *
 * ## 判据
 * - total 只来自**可信计数**（T1 索引全量枚举的 matchedCount），不是窗口长度；
 * - 翻页并集必须等于**完整基线集合**（基线由 store 逐条回读得出，不用生产的检索算法当 oracle）；
 * - 页内不重复、页数按 limit 推进、最后一页 has_more=false / completeness=complete；
 * - 0 / 1 / 恰好一页 / 整页倍数 / 最后半页 五个边界都有断言；
 * - 同分记录（正文完全一致）也必须有稳定顺序：limit=1 翻页得到的 id 序列按升序，
 *   证明 rankResults 的同分 tie-break（U2）在分页面上成立；
 * - `scope=all` 两集合分别推进，任一非空集合不得永久饥饿。
 *
 * ## 不适用条件
 * 只覆盖 T1（可穷尽枚举）后端；T2 的「不可分页」在 v3-g1-contract 里断言。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { attachV3Engine } from '../src/v3/entry/v3-entry.mjs'
import { createV3Runtime } from '../src/v3/composition/composition.mjs'
import { buildSummaryArtifact, sourceSetMaterial } from '../src/v3/domain/compress/summary-artifact.mjs'
import { recordHashMaterial } from '../src/v3/application/summary.mjs'
import { appendSummary } from '../src/v3/adapters/storage/summary-store.mjs'
import { createFakeSession } from './helpers/fake-session.mjs'

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

/** 建引擎 → 推消息 → 走一次真实 pre-step 摄入 → 交给用例。 */
async function withEngine(id, texts, fn) {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-g1-paging-'))
  const ctx = fakeCtx()
  const engine = attachV3Engine(ctx, { v3Root: root })
  try {
    const session = createFakeSession({ id })
    for (const text of texts) session.pushUser(text)
    session.pushUser('当前问题：请总结上面的记录。')
    await ctx.callPreStep(session)
    await settle(engine)
    return await fn({ engine, session, root })
  } finally {
    try { await engine.dispose() } catch {}
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
}

/** 同一会话但要拿到 runtime 句柄（摘要只能经 store 目录落盘）。 */
async function withRuntimeEngine(id, texts, fn) {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-g1-paging-mixed-'))
  const ctx = fakeCtx()
  const session = createFakeSession({ id })
  for (const text of texts) session.pushUser(text)
  session.pushUser('当前问题：请总结上面的记录。')
  const runtime = await createV3Runtime({ v3Root: root, dshSession: session, sessionKey: id })
  const engine = attachV3Engine(ctx, { v3Root: root, runtimeFactory: async () => runtime })
  try {
    await ctx.callPreStep(session)
    await settle(engine)
    return await fn({ engine, session, root, runtime })
  } finally {
    try { await engine.dispose() } catch {}
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
}

/** 基线集合：逐条回读记录正文，按**内容**判定，而不是用检索结果反推检索结果。 */
async function recordIdsContaining(engine, sessionId, marker) {
  const { ids } = await engine.recordIdsOf(sessionId)
  const out = []
  for (const recordId of ids) {
    const read = await engine.toolRead(sessionId, recordId, { detail: 'full' })
    if (read.status === 'ok' && typeof read.text === 'string' && read.text.includes(marker)) out.push(recordId)
  }
  return out
}

/** 连续翻页直到没有 next_cursor（带上限，防止实现给出原地踏步的 cursor）。 */
async function paginate(engine, session, { query, scope = 'records', limit = 2 }) {
  const pages = []
  let cursor = null
  for (let index = 0; index < 40; index += 1) {
    const result = await engine.toolSearch(session.id, session, { query, scope, limit, cursor })
    pages.push(result)
    if (typeof result.next_cursor !== 'string') return pages
    assert.notEqual(result.next_cursor, cursor, 'next_cursor 不得原地踏步')
    cursor = result.next_cursor
  }
  assert.fail('翻页没有终止（可能返回了自指的 cursor）')
  return pages
}

function idsOf(pages) {
  return pages.flatMap((page) => page.items.map((item) => item.id))
}

const CACHEPROBES = Array.from({ length: 9 }, (_, index) => 'CACHEPROBE-' + index + ' 合成记录正文，用于分页反例。编号 ' + index)

test('F01 核心：limit=2 连续翻页拿全 9 条、不重复、total 是可信计数（旧实现只走 1 页拿 2 条）', async () => {
  await withEngine('g1-paging-core', CACHEPROBES, async ({ engine, session }) => {
    const baseline = await recordIdsContaining(engine, session.id, 'CACHEPROBE')
    assert.equal(baseline.length, 9, '夹具必须有 9 条可检索的 CACHEPROBE 记录')

    const pages = await paginate(engine, session, { query: 'CACHEPROBE', scope: 'records', limit: 2 })
    assert.ok(pages.length >= 2, '旧缺陷：第 1 页就 next_cursor=null（本次 ' + pages.length + ' 页）')

    const first = pages[0]
    assert.equal(first.total_match_count, 9, 'total 必须是 9（可信计数），不是 top-k 长度 2')
    assert.equal(first.completeness, 'partial', '还有下一页时不得报 complete')
    assert.equal(first.has_more, true)
    assert.equal(typeof first.next_cursor, 'string')
    assert.equal(first.reason, null, '普通分页不是降级，不该写原因码')

    const ids = idsOf(pages)
    assert.equal(ids.length, new Set(ids).size, '翻页不得重复返回同一条')
    assert.deepEqual([...ids].sort(), [...baseline].sort(), '各页并集必须等于完整基线集合')

    const last = pages[pages.length - 1]
    assert.equal(last.has_more, false, '最后一页必须明确「没有下一页」')
    assert.equal(last.completeness, 'complete', '最后一页才是 complete（= 该 scope 已穷尽）')
    assert.equal(last.next_cursor, null)
    assert.deepEqual(pages.map((page) => page.returned_count), [2, 2, 2, 2, 1])
    for (const page of pages) assert.equal(page.total_match_count, 9, '每页 total 一致（同一快照的事实）')
  })
})

test('scope=all（只有记录）：同样翻页取全，不把两个集合的 offset 混用', async () => {
  await withEngine('g1-paging-all', CACHEPROBES, async ({ engine, session }) => {
    const baseline = await recordIdsContaining(engine, session.id, 'CACHEPROBE')
    const pages = await paginate(engine, session, { query: 'CACHEPROBE', scope: 'all', limit: 2 })
    assert.equal(pages[0].total_match_count, 9)
    const ids = idsOf(pages)
    assert.equal(ids.length, new Set(ids).size)
    assert.deepEqual([...ids].sort(), [...baseline].sort())
    assert.equal(pages[pages.length - 1].completeness, 'complete')
  })
})

test('边界：0 条命中 = total 0 + complete（「查了没有」不是失败）', async () => {
  await withEngine('g1-paging-zero', CACHEPROBES, async ({ engine, session }) => {
    const result = await engine.toolSearch(session.id, session, { query: 'ZZZ_NO_SUCH_PROBE', scope: 'records', limit: 5 })
    assert.equal(result.status, 'ok')
    assert.equal(result.returned_count, 0)
    assert.equal(result.total_match_count, 0, '0 条是可穷尽枚举得到的精确值，不是未知')
    assert.equal(result.completeness, 'complete')
    assert.equal(result.has_more, false)
    assert.equal(result.next_cursor, null)
    assert.equal(result.reason, null)
  })
})

test('边界：1 条 / 恰好一页 / 整页倍数 / 最后半页', async () => {
  for (const [count, expectedPages] of [[1, [1]], [2, [2]], [4, [2, 2]], [5, [2, 2, 1]]]) {
    const texts = Array.from({ length: count }, (_, index) => 'PAGEPROBE-' + index + ' 分页边界记录。')
    await withEngine('g1-paging-bound-' + count, texts, async ({ engine, session }) => {
      const pages = await paginate(engine, session, { query: 'PAGEPROBE', scope: 'records', limit: 2 })
      assert.deepEqual(pages.map((page) => page.returned_count), expectedPages, count + ' 条记录的页形')
      assert.equal(pages[0].total_match_count, count)
      assert.equal(pages[pages.length - 1].has_more, false)
      const ids = idsOf(pages)
      assert.equal(ids.length, new Set(ids).size)
      assert.equal(ids.length, count)
    })
  }
})

test('重复得分稳定排序（U2）：正文完全相同的记录，limit=1 翻页按 id 升序且不重不漏', async () => {
  const identical = Array.from({ length: 6 }, () => '同分探针 SAME-SCORE 正文完全一致。')
  await withEngine('g1-paging-tie', identical, async ({ engine, session }) => {
    const baseline = await recordIdsContaining(engine, session.id, 'SAME-SCORE')
    assert.equal(baseline.length, 6)
    const pages = await paginate(engine, session, { query: 'SAME-SCORE', scope: 'records', limit: 1 })
    const ids = idsOf(pages)
    assert.equal(ids.length, 6)
    assert.equal(new Set(ids).size, 6)
    assert.deepEqual(ids, [...ids].sort(), '同分必须按 id 升序（rankResults 的 tie-break），否则翻页会重/漏')
    // 同一页重复请求必须逐条一致（确定性）
    const again = await engine.toolSearch(session.id, session, { query: 'SAME-SCORE', scope: 'records', limit: 2 })
    const twice = await engine.toolSearch(session.id, session, { query: 'SAME-SCORE', scope: 'records', limit: 2 })
    assert.deepEqual(twice.items.map((item) => item.id), again.items.map((item) => item.id))
  })
})

test('limit 边界：越界失败关闭并给出可读理由，合法值原样生效（P2-12 口径）', async () => {
  const texts = Array.from({ length: 5 }, (_, index) => 'LIMITPROBE-' + index + ' 条数边界记录。')
  await withEngine('g1-paging-limit', texts, async ({ engine, session }) => {
    // P2-12（0.15.1）：旧实现把越界 limit **静默夹取**（0/-3→1、11→10、2.5→5），
    // 模型以为「要 11 条只给 10 条」是服务端的正常答复，看不到任何「你越界了」的信号。
    // 现在越界一律 rejected + error=invalid-limit：有界热上下文上的失败**关闭**而不是失败开放。
    for (const bad of [0, -3, 11, 2.5, 1e9]) {
      const refused = await engine.toolSearch(session.id, session, { query: 'LIMITPROBE', scope: 'records', limit: bad })
      assert.equal(refused.status, 'rejected', '越界 limit 必须 rejected：' + bad)
      assert.equal(refused.error, 'invalid-limit', '必须给出可读理由：' + bad)
      assert.equal(refused.returned_count, 0)
    }
    // 合法值不夹取：上限本身（10）与命中数之间的较小者原样生效。
    const atCap = await engine.toolSearch(session.id, session, { query: 'LIMITPROBE', scope: 'records', limit: 10 })
    assert.equal(atCap.returned_count, 5, '上限内请求数超过命中数时给现有的 5 条')
    assert.equal(atCap.has_more, false)
    const one = await engine.toolSearch(session.id, session, { query: 'LIMITPROBE', scope: 'records', limit: 1 })
    assert.equal(one.returned_count, 1)
    assert.equal(one.total_match_count, 5)
    assert.equal(one.has_more, true, '要 1 条时如实说还有更多')
    const missing = await engine.toolSearch(session.id, session, { query: 'LIMITPROBE', scope: 'records' })
    assert.equal(missing.returned_count, 5, '未指定 limit → 默认 5')
  })
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
  assert.notEqual(written.ok, false, '摘要工件必须落盘成功（' + JSON.stringify(written) + '）')
  assert.equal(written.appended, true, '首次写入必须是新追加')
  return artifact
}

test('混合 scope：记录远多于摘要时摘要不饥饿，各页并集 = 记录基线 ∪ 摘要基线', async () => {
  const texts = Array.from({ length: 6 }, (_, index) => 'MIXPROBE R-' + index + ' 混合范围记录。')
  await withRuntimeEngine('g1-paging-mixed', texts, async ({ engine, session, runtime }) => {
    const recordBaseline = await recordIdsContaining(engine, session.id, 'MIXPROBE')
    assert.equal(recordBaseline.length, 6)
    await appendTestSummary(runtime, { summaryId: 'v3s-00000000000000a1', shortText: 'MIXPROBE 摘要甲：记录已整理。', recordIds: [recordBaseline[0]], createdAt: 1000 })
    await appendTestSummary(runtime, { summaryId: 'v3s-00000000000000a2', shortText: 'MIXPROBE 摘要乙：记录待复核。', recordIds: [recordBaseline[1]], createdAt: 2000 })

    const pages = await paginate(engine, session, { query: 'MIXPROBE', scope: 'all', limit: 3 })
    const ids = idsOf(pages)
    assert.equal(ids.length, new Set(ids).size, '并集不得重复')
    assert.equal(pages[0].total_match_count, 8, 'total = 6 记录 + 2 摘要')
    const summaryIdsInPages = ids.filter((id) => id.startsWith('v3s-'))
    assert.equal(summaryIdsInPages.length, 2, '摘要在分页里必须出现（不得因记录多而永久饥饿）')
    assert.deepEqual([...ids].sort(), [...recordBaseline, 'v3s-00000000000000a1', 'v3s-00000000000000a2'].sort())
    // 每一页在两边都还有剩余时，都要各至少 1 条（确定性交织）
    for (const page of pages.slice(0, 2)) {
      assert.ok(page.items.some((item) => item.kind === 'summary'), '前两页都必须含摘要')
      assert.ok(page.items.some((item) => item.kind !== 'summary'), '前两页都必须含记录')
    }
    assert.equal(pages[pages.length - 1].completeness, 'complete')
  })
})

test('混合 scope 反向：摘要多于记录时，记录耗尽后摘要继续翻页', async () => {
  const texts = ['REVERSEPROBE 唯一一条记录。']
  await withRuntimeEngine('g1-paging-mixed-reverse', texts, async ({ engine, session, runtime }) => {
    const recordBaseline = await recordIdsContaining(engine, session.id, 'REVERSEPROBE')
    assert.equal(recordBaseline.length, 1)
    const summaryIds = ['v3s-00000000000000b1', 'v3s-00000000000000b2', 'v3s-00000000000000b3']
    for (const [index, summaryId] of summaryIds.entries()) {
      await appendTestSummary(runtime, { summaryId, shortText: 'REVERSEPROBE 摘要 ' + index + '：等待复核。', recordIds: [recordBaseline[0]], createdAt: 1000 + index })
    }
    const pages = await paginate(engine, session, { query: 'REVERSEPROBE', scope: 'all', limit: 2 })
    const ids = idsOf(pages)
    assert.equal(ids.length, new Set(ids).size)
    assert.equal(pages[0].total_match_count, 4, 'total = 1 记录 + 3 摘要')
    assert.deepEqual([...ids].sort(), [...recordBaseline, ...summaryIds].sort())
    assert.equal(pages[pages.length - 1].completeness, 'complete')
    // 第一页必须是「1 记录 + 1 摘要」：两个集合都前进，后面才轮到纯摘要页
    assert.equal(pages[0].items.length, 2)
    assert.equal(pages[0].items.filter((item) => item.kind === 'summary').length, 1)
  })
})
/**
 * P2-2（修复批）：摘要窗口封顶 + scope=all + limit=1 的自指 cursor 死循环。
 *
 * 复现输入（审查者实测）：60 条记录 + 60 条命中摘要（summary 服务单次只给前 50 条），
 * scope=all、limit=1 连续翻页。旧实现在 (records=51, summaries=50) 之后仍把 limit=1 的
 * 额度按「谁读得少」给 summaries，但摘要面已到窗口尾巴 → consumedSummaries=0，
 * 返回 0 条 + has_more=true，且 next_cursor 与输入**逐字节相同**（模型侧无界循环）。
 *
 * 判据：
 * 1) 翻页必须终止，且任何一页都不得「has_more=true 但 0 条 + cursor 原地踏步」；
 * 2) 60 条记录全部可达；前 50 条摘要可达；第 51 条起够不到必须**显式**标记
 *    （has_more=null + reason=summary-window-capped），不得冒充「已查全」；
 * 3) 页并集不重复。
 */
test('P2-2：>50 摘要 + 60 记录、scope=all、limit=1 长翻页必须终止且不发自指 cursor', async () => {
  const recordTexts = Array.from({ length: 60 }, (_, index) => 'LOOPPROBE R-' + index + ' 长翻页记录。')
  await withRuntimeEngine('g1-paging-loop', recordTexts, async ({ engine, session, runtime }) => {
    const recordBaseline = await recordIdsContaining(engine, session.id, 'LOOPPROBE')
    assert.equal(recordBaseline.length, 60, '夹具：60 条可检索记录')
    const summaryIds = Array.from({ length: 60 }, (_, index) => 'v3s-' + String(index).padStart(16, '0'))
    for (const [index, summaryId] of summaryIds.entries()) {
      await appendTestSummary(runtime, { summaryId, shortText: 'LOOPPROBE 摘要 ' + index + '：等待复核。', recordIds: [recordBaseline[index % recordBaseline.length]], createdAt: 1000 + index })
    }

    const pages = []
    let cursor = null
    for (let index = 0; index < 200; index += 1) {
      const result = await engine.toolSearch(session.id, session, { query: 'LOOPPROBE', scope: 'all', limit: 1, cursor })
      pages.push(result)
      assert.equal(result.total_match_count, 120, 'total 不受窗口封顶影响（120 = 60 记录 + 60 摘要）')
      if (typeof result.next_cursor !== 'string') break
      assert.notEqual(result.next_cursor, cursor, 'cursor 不得原地踏步（P2-2 的自指死循环）')
      cursor = result.next_cursor
    }
    assert.ok(pages.length < 200, '翻页必须终止（本次 ' + pages.length + ' 页）')
    const last = pages[pages.length - 1]
    assert.equal(last.has_more, null, '窗口封顶时不得声称还有下一页，也不得声称已查全')
    assert.equal(last.reason, 'summary-window-capped')
    assert.equal(last.next_cursor, null)
    assert.notEqual(last.completeness, 'complete')

    const ids = idsOf(pages)
    assert.equal(ids.length, new Set(ids).size, '并集不得重复')
    const reachedRecords = ids.filter((id) => id.startsWith('v3r-'))
    assert.equal(new Set(reachedRecords).size, 60, '60 条记录必须全部可达（额度封顶后让给 records）')
    const reachedSummaries = new Set(ids.filter((id) => id.startsWith('v3s-')))
    assert.equal(reachedSummaries.size, 50, '摘要只能取到服务端窗口（前 50 条），其余必须显式不可达')
    for (const page of pages) {
      assert.ok(!(page.has_more === true && page.returned_count === 0), '不得出现「还有下一页但本页 0 条」的页')
    }
  })
})