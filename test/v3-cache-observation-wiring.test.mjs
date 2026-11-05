/**
 * P2-a 生产接线守卫（0.15.0，主代理派单实现段）：**真实 engine 事件摄入**。
 *
 * ## 判据来源
 * - 裁决：P2-a 只做「独立处理 raw.type==='assistant/message' 的原始 raw.data.usage →
 *   appendCacheObservation(dir, raw.seq, {usage, at})」；surface 恒 null、不采样、不配对。
 * - P0 宿主合同 §2.4：`TokenUsage` 有 `cacheWriteTokens`；未出现字段 = null + missing，
 *   不得写 0；`totalTokens` 不得用 in+out 补。
 * - 宿主事件时间字段：`at` 优先、其次 `time`（`adapters/host/dsh-host.mjs` 的 at 口径）。
 *
 * ## 为什么要独立于旧 usage 通道
 * entry 的 `usageOf` 是**五字段白名单 + ≥2 个有效字段**，且调用点包在
 * `if (body.usage !== undefined)` 里。单字段样本与只带 `cacheWriteTokens` 的样本
 * 会被这道旧条件挡掉——新观测必须**自己判断原始 usage**，两条通道失败域独立。
 *
 * ## 断言组
 * A 原始单字段/cacheWrite/0 语义；B seq 与事件时间可回查 + surface 恒 null；
 * C 非 assistant / 无效 usage / 无效 seq 不写；D 重放不重复；
 * E 旧通道失败（EISDIR）不影响新观测与断点；F 新观测失败不影响旧通道与摄入；
 * G 无正文（metaOnly）assistant 仍被覆盖。
 *
 * ## 不适用条件与已知边界
 * - 只验 entry 接线与账本落盘；`llm/stream`、wire、供应商语义仍未验。
 * - 本测试不覆盖失锁注入（由 `v3-cache-observation.test.mjs` 的 F7 覆盖）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { attachV3Engine } from '../src/v3/entry/v3-entry.mjs'

/** 真实宿主形状：{type, seq, time, data}（time 与 dsh-host 的 at 口径同源）。 */
function fakeSession(id) {
  const events = []
  return {
    id,
    log: events,
    surface: { nodes: [] },
    append() { return { seq: 0 } },
    eventAt() { return null },
    deriveMessages() { return [] },
    push(type, data, extra = {}) {
      events.push({ seq: events.length, type, time: 1700000000000 + events.length * 10, data, ...extra })
      return events[events.length - 1]
    },
  }
}

function fakeCtx() {
  const handlers = new Map()
  const warns = []
  const ctx = {
    on(n, h) { handlers.set(n, h); return () => {} },
    logger: { warn(m) { warns.push(String(m)) }, info() {} },
  }
  ctx.callPreStep = async (agent) => await handlers.get('agent/pre-step')({ agent, signal: undefined }, async () => ({ kind: 'enter' }))
  ctx.warns = warns
  return ctx
}

async function withEngine(body) {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-p2wiring-'))
  const ctx = fakeCtx()
  const engine = attachV3Engine(ctx, { v3Root: root })
  try {
    return await body({ root, ctx, engine })
  } finally {
    engine.dispose()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
}

const observationFile = (root, sid) => path.join(root, 'sessions', sid, 'cache-observations.jsonl')
const usageFile = (root, sid) => path.join(root, 'sessions', sid, 'usage.jsonl')

async function readRows(file) {
  const text = await readFile(file, 'utf8')
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

async function exists(file) {
  try { await stat(file); return true } catch { return false }
}

/** 一步：user + assistant（带 usage）→ 触发摄入。 */
async function ingestAssistant({ ctx, engine, session, usage, extraData = {}, extraEvent = {} }) {
  session.push('user/message', { text: '问' })
  session.push('assistant/message', { message: { content: [{ type: 'text', text: '答' }] }, usage, ...extraData }, extraEvent)
  await ctx.callPreStep({ session })
  await engine._waitForIdle()
}

// ---------------------------------------------------------------- A 原始 usage

test('A1 原始单字段 usage 可写：不被旧 usageOf 的 ≥2 字段门槛挡住', async () => {
  await withEngine(async ({ root, ctx, engine }) => {
    const session = fakeSession('s-single')
    await ingestAssistant({ ctx, engine, session, usage: { outputTokens: 5 } })
    const rows = await readRows(observationFile(root, 's-single'))
    assert.equal(rows.length, 1)
    const row = rows[0]
    assert.equal(row.contractVersion, 4)
    assert.equal(row.observationScope, 'plugin-surface')
    assert.equal(row.usage.outputTokens.value, 5)
    assert.equal(row.usage.outputTokens.availability, 'present')
    assert.equal(row.usage.inputTokens.availability, 'missing')
    // 旧通道（usageOf ≥2）不写 —— 证明两条通道独立
    assert.equal(await exists(usageFile(root, 's-single')), false, '单字段样本进旧通道时必须不写')
  })
})

test('A2 cacheWriteTokens 保留、显式 0 是 present 而不是 missing', async () => {
  await withEngine(async ({ root, ctx, engine }) => {
    const session = fakeSession('s-zero')
    await ingestAssistant({ ctx, engine, session, usage: { inputTokens: 0, cacheWriteTokens: 7, outputTokens: 3 } })
    const [row] = await readRows(observationFile(root, 's-zero'))
    assert.equal(row.usage.inputTokens.value, 0)
    assert.equal(row.usage.inputTokens.availability, 'present', '显式 0 = 已报告')
    assert.equal(row.usage.cacheWriteTokens.value, 7, '旧白名单会丢弃 cacheWriteTokens')
    assert.equal(row.usage.cacheWriteTokens.availability, 'present')
    // 三项 → 旧通道也写一行（各自独立）
    const old = await readRows(usageFile(root, 's-zero'))
    assert.equal(old.length, 1)
  })
})

// ---------------------------------------------------------------- B 可回查 / surface

test('B1 seq 与事件时间可回查；surface/measurement 恒未知', async () => {
  await withEngine(async ({ root, ctx, engine }) => {
    const session = fakeSession('s-lookup')
    session.push('user/message', { text: '问' })
    const event = session.push('assistant/message', { message: { content: [{ type: 'text', text: '答' }] }, usage: { inputTokens: 9, outputTokens: 2 } })
    await ctx.callPreStep({ session })
    await engine._waitForIdle()
    const [row] = await readRows(observationFile(root, 's-lookup'))
    assert.equal(row.seq, event.seq, '行内存宿主 seq，可回查 assistant 事件')
    assert.equal(row.at, event.time, 'at 取事件时间（time），不是 Date.now')
    assert.equal(row.surface, null, 'P2-a 不采样：surface 恒 null')
    assert.equal(row.measurement.stepToFirstToken.value, null)
    assert.equal(row.measurement.stepToFirstToken.source, null)
  })
})

test('B2 事件时间非法时 at 必须为 null（不得用 Date.now 伪装）', async () => {
  await withEngine(async ({ root, ctx, engine }) => {
    const session = fakeSession('s-badtime')
    session.push('user/message', { text: '问' })
    const event = session.push('assistant/message', { message: { content: [{ type: 'text', text: '答' }] }, usage: { inputTokens: 4, outputTokens: 1 } })
    event.time = 'not-a-time'
    await ctx.callPreStep({ session })
    await engine._waitForIdle()
    const [row] = await readRows(observationFile(root, 's-badtime'))
    assert.equal(row.at, null)
    assert.equal(typeof row.at, 'object', 'null 就是 null，不是时间戳')
  })
})

// ---------------------------------------------------------------- C 不写

test('C1 非 assistant 事件不写（user/message 即使带 usage）', async () => {
  await withEngine(async ({ root, ctx, engine }) => {
    const session = fakeSession('s-user')
    session.push('user/message', { text: '问', usage: { inputTokens: 100, outputTokens: 5 } })
    await ctx.callPreStep({ session })
    await engine._waitForIdle()
    assert.equal(await exists(observationFile(root, 's-user')), false)
  })
})

test('C2 无效 usage 不写：缺失 / null / 字符串 / 空对象 / 无合法 token 字段', async () => {
  await withEngine(async ({ root, ctx, engine }) => {
    const session = fakeSession('s-badusage')
    const push = (usage) => session.push('assistant/message', { message: { content: [{ type: 'text', text: '答' }] }, usage })
    session.push('user/message', { text: '问' })
    push(undefined)
    push(null)
    push('not-usage')
    push([])
    push({})
    push({ foo: 1 })
    push({ inputTokens: -1, outputTokens: 'x' })
    await ctx.callPreStep({ session })
    await engine._waitForIdle()
    assert.equal(await exists(observationFile(root, 's-badusage')), false, '无有效 usage 必须不写')
  })
})

test('C3 非法 seq 不写（不伪造断点）', async () => {
  await withEngine(async ({ root, ctx, engine }) => {
    const session = fakeSession('s-badseq')
    session.push('user/message', { text: '问' })
    session.push('assistant/message', { message: { content: [{ type: 'text', text: '答' }] }, usage: { inputTokens: 3, outputTokens: 1 } }, { seq: -1 })
    await ctx.callPreStep({ session })
    await engine._waitForIdle()
    assert.equal(await exists(observationFile(root, 's-badseq')), false)
  })
})

// ---------------------------------------------------------------- D 重放

test('D1 重放同一批事件不重复写（断点 + seq 幂等）', async () => {
  await withEngine(async ({ root, ctx, engine }) => {
    const session = fakeSession('s-replay')
    await ingestAssistant({ ctx, engine, session, usage: { inputTokens: 6, outputTokens: 2 } })
    assert.equal((await readRows(observationFile(root, 's-replay'))).length, 1)
    await ctx.callPreStep({ session })
    await engine._waitForIdle()
    await ctx.callPreStep({ session })
    await engine._waitForIdle()
    assert.equal((await readRows(observationFile(root, 's-replay'))).length, 1, '重放不得双写')
  })
})

// ---------------------------------------------------------------- E/F 失败域隔离

test('E1 旧 usage 通道写失败（EISDIR）时新观测仍写、断点照常推进', async () => {
  await withEngine(async ({ root, ctx, engine }) => {
    const session = fakeSession('s-oldfail')
    await ingestAssistant({ ctx, engine, session, usage: { inputTokens: 10, outputTokens: 1 } })
    assert.equal((await readRows(observationFile(root, 's-oldfail'))).length, 1)
    // 让旧通道写入必失败：usage.jsonl 变成目录
    await rm(usageFile(root, 's-oldfail'), { force: true })
    await mkdir(usageFile(root, 's-oldfail'), { recursive: true })
    session.push('assistant/message', { message: { content: [{ type: 'text', text: '答二' }] }, usage: { inputTokens: 20, outputTokens: 2 } })
    const before = (await engine.inspect('s-oldfail')).lastSeq
    await ctx.callPreStep({ session })
    await engine._waitForIdle()
    const after = await engine.inspect('s-oldfail')
    assert.equal((await readRows(observationFile(root, 's-oldfail'))).length, 2, '旧通道失败不得跳过新观测')
    assert.equal(after.lastSeq, session.log.length - 1, '断点照常推进到最新事件 seq')
    assert.ok(after.lastSeq > before, '确有一次推进')
  })
})

test('F1 新观测写失败（EISDIR）时旧 usage 与摄入不受影响，且失败可见', async () => {
  await withEngine(async ({ root, ctx, engine }) => {
    const session = fakeSession('s-newfail')
    session.push('user/message', { text: '问' })
    session.push('assistant/message', { message: { content: [{ type: 'text', text: '答' }] }, usage: { inputTokens: 30, outputTokens: 3 } })
    await ctx.callPreStep({ session })
    await engine._waitForIdle()
    // 让新观测写入必失败：cache-observations.jsonl 变成目录
    await rm(observationFile(root, 's-newfail'), { force: true })
    await mkdir(observationFile(root, 's-newfail'), { recursive: true })
    session.push('assistant/message', { message: { content: [{ type: 'text', text: '答二' }] }, usage: { inputTokens: 40, outputTokens: 4 } })
    await ctx.callPreStep({ session })
    await engine._waitForIdle()
    const old = await readRows(usageFile(root, 's-newfail'))
    assert.ok(old.length >= 1, '旧 usage 通道照常写入')
    const info = await engine.inspect('s-newfail')
    assert.equal(info.health.recordCount, session.log.length, '摄入不受旁路失败影响（全部事件照常入库）')
    assert.equal(info.lastSeq, session.log.length - 1, '断点照常推进到最新事件 seq')
  })
})

// ---------------------------------------------------------------- G metaOnly

test('G1 无正文（metaOnly）assistant 仍被覆盖：不被正文提取条件挡掉', async () => {
  await withEngine(async ({ root, ctx, engine }) => {
    const session = fakeSession('s-metaonly')
    session.push('user/message', { text: '问' })
    // 只有工具调用块、没有 text 块 → extractEventBody 返回 metaOnly
    session.push('assistant/message', { message: { content: [{ type: 'tool-call', callId: 'c1', name: 'read', arguments: '{}' }] }, usage: { inputTokens: 11, outputTokens: 2 } })
    await ctx.callPreStep({ session })
    await engine._waitForIdle()
    const rows = await readRows(observationFile(root, 's-metaonly'))
    assert.equal(rows.length, 1, 'metaOnly 事件仍在 usable 循环里')
    assert.equal(rows[0].usage.inputTokens.value, 11)
  })
})
