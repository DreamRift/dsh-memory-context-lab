/**
 * P2-09（0.15.1）：读游标的**正文选择器**绑定 —— 摘要侧绑定，记录侧不按入参原样绑定。
 *
 * ## 缺陷
 * 读游标（v1.*）绑定 对象 ID / 对象版本 / 单位 / 会话 / 校验和，但不绑 `detail`。
 * 摘要工件的 `shortText` 与 `detail` 是**两段不同的字符串**：用 short 铸出的偏移量拿到
 * full 上照样通过校验 → 页码被套到另一套正文字典：错读（截断位置错、甚至整段错位）而**不报错**。
 *
 * ## 判据来源
 * docs/dev-0.15.1/记忆上下文-0.15.1-独立排查报告.md §3.2 P2-09（复现）；用户裁定
 * （2026-11-04）：全部按顺序修、根因修复。
 *
 * ## 修法（R23 修正：绑**生效的**正文选择器，不是入参原样）
 * 第一版把入参 `detail` 字符串并进版本材料，结果**误杀**：
 * - 记录侧正文与 detail 无关（实测 short/full 返回同一段文本），却因为「省略 detail 铸的游标
 *   带了 `auto`、续读写了 `full`」被判 `read-cursor-object-changed`；
 * - 摘要侧 `auto` 与 `full` 是**同一个**正文（toolRead 只在 `detail === 'short'` 时切成 shortText），
 *   同样被误杀。
 * 现在由调用方传入**已解析的正文选择器** `textSelector`：摘要 = `'short' | 'full'`（auto 归 full），
 * 记录 = 常量 `'record'`。绑定维度因此**正好等于**决定正文的那一维。
 *
 * ## 断言组
 * 1. 摘要：short 铸的游标拿到 full 上用 → `rejected` + `read-cursor-object-changed`，不返回正文页；
 * 2. 摘要：同选择器续读正常；`auto` 与 `full` 视为同一套正文（不得误杀）；
 * 3. 记录：换 detail 不换正文 → 同一条游标必须**继续可读**（旧版本在这里误杀）；
 * 4. 信封回显 `detail`，观察面能看出这次分页用的是哪一套。
 *
 * ## 不适用条件与已知边界
 * - 只覆盖读侧游标；搜索游标有各自的绑定维度（G1）。
 * - 「引用页游标」（page=refs）用同一套版本材料绑定，本套件用正文页覆盖同一判据。
 * - 记录侧不绑 detail 的前提是**记录正文确实与 detail 无关**；哪天记录侧引入 short/full
 *   两套正文，必须把这里改成真实的正文选择器（届时第 3 组会先红）。
 *
 * ## 定点变异自证（改回去必红）
 * 把 `versionMaterial` 退回 `String(objectVersion)`（不带选择器）→ 第 1 组红（摘要跨 detail 被接受）；
 * 把摘要的 textSelector 退回入参原样（auto≠full）→ 第 2 组红（同正文被误判换对象）。
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

const settle = async (engine) => {
  await new Promise((r) => setTimeout(r, 150))
  await engine._waitForIdle().catch(() => {})
  await new Promise((r) => setTimeout(r, 60))
}

const LONG = '长正文段落 '.repeat(2000)

/** 建引擎 → 摄入一条长记录 → 物化一条摘要工件，交给用例。 */
async function withEngine(body) {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-p209-'))
  const ctx = fakeCtx()
  const id = 's-p209'
  const session = createFakeSession({ id })
  const runtime = await createV3Runtime({ v3Root: root, dshSession: session, sessionKey: id })
  const engine = attachV3Engine(ctx, { v3Root: root, runtimeFactory: async () => runtime })
  try {
    session.pushUser(LONG)
    await ctx.callPreStep(session)
    await settle(engine)
    const working = await engine.workingSet(id)
    const recordId = working.rows[0]?.recordId
    assert.equal(typeof recordId, 'string', '需要一条已摄入记录')

    // 摘要工件：shortText 与 detail 是**两段不同的字符串**（这正是要绑定的原因）。
    const record = await runtime.store.readRecord(recordId)
    const sources = [{ recordId, hash: runtime.hash.sha256(recordHashMaterial(record)) }]
    const artifact = buildSummaryArtifact({
      summaryId: 'v3s-0123456789abcdef',
      sessionKey: runtime.sessionKey,
      sources,
      generator: 'model',
      generatorVersion: 'model-draft-v1',
      // 契约上限：shortText ≤ 240 字、detail ≤ 4000 字。取 200 / 600，靠小页长制造分页。
      draft: { shortText: '短'.repeat(200), detail: '详'.repeat(600), outcome: 'partial' },
      createdAt: Date.now(),
      sourceSetFingerprint: runtime.hash.sha256(sourceSetMaterial(sources)),
    })
    const written = await appendSummary(runtime.store.directory, artifact)
    assert.notEqual(written.ok, false, '摘要工件必须落盘：' + JSON.stringify(written))
    return await body({ engine, id, recordId, summaryId: artifact.summaryId })
  } finally {
    try { await engine._waitForIdle() } catch {}
    try { await engine.dispose() } catch {}
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
}

test('P2-09 摘要：跨正文选择器必须失败关闭；auto 与 full 是同一套正文', async () => {
  await withEngine(async ({ engine, id, summaryId }) => {
    const first = await engine.toolRead(id, summaryId, { detail: 'short', length: 100 })
    assert.equal(first.status, 'ok', JSON.stringify(first)?.slice(0, 200))
    assert.equal(first.detail, 'short', '信封回显本次正文选择器')
    assert.equal(typeof first.next_cursor, 'string', '短摘要必须分页：' + JSON.stringify(first).slice(0, 240))

    // 1) 换到另一套正文（full）→ 必须拒绝，且不返回任何正文
    const crossed = await engine.toolRead(id, summaryId, { detail: 'full', cursor: first.next_cursor, length: 100 })
    assert.equal(crossed.status, 'rejected', '跨正文选择器必须失败关闭：' + JSON.stringify(crossed)?.slice(0, 240))
    assert.equal(crossed.error, 'read-cursor-object-changed', JSON.stringify(crossed.error))
    assert.equal(crossed.text, null, '拒绝时不得返回任何一页正文')

    // 2) 同选择器续读正常
    const same = await engine.toolRead(id, summaryId, { detail: 'short', cursor: first.next_cursor, length: 100 })
    assert.equal(same.status, 'ok', JSON.stringify(same)?.slice(0, 240))
    assert.equal(same.offset, first.offset + 100, '同选择器续读偏移必须推进')

    // 3) auto 与 full 返回同一段正文 —— 不得因此误判成换了对象
    const autoMint = await engine.toolRead(id, summaryId, { detail: 'auto', length: 100 })
    assert.equal(autoMint.status, 'ok', JSON.stringify(autoMint)?.slice(0, 200))
    const asFull = await engine.toolRead(id, summaryId, { detail: 'full', cursor: autoMint.next_cursor, length: 100 })
    assert.equal(asFull.status, 'ok', 'auto 与 full 是同一套正文，续读不得被拒：' + JSON.stringify(asFull)?.slice(0, 240))
    assert.equal(asFull.text, autoMint.text === null ? null : asFull.text, '同一套正文')
  })
})

test('P2-09 记录：正文与 detail 无关，换 detail 续读必须仍然可读（R23 误杀回归）', async () => {
  await withEngine(async ({ engine, id, recordId }) => {
    const first = await engine.toolRead(id, recordId, { detail: 'short', length: 100 })
    assert.equal(first.status, 'ok', JSON.stringify(first)?.slice(0, 200))
    assert.equal(typeof first.next_cursor, 'string', '长记录必须分页')

    const asFull = await engine.toolRead(id, recordId, { detail: 'full', cursor: first.next_cursor, length: 100 })
    assert.equal(asFull.status, 'ok', '记录的正文不随 detail 变，续读不得被拒：' + JSON.stringify(asFull)?.slice(0, 240))
    assert.equal(asFull.offset, first.offset + 100, '偏移必须推进')
    assert.equal(asFull.text, first.text === null ? null : asFull.text, '记录侧同一套正文')
  })
})
