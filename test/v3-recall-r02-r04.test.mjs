/**
 * R02 / R04 回注呈现回归（0.15.0 候选切片，顶层正式套件）。
 *
 * ## 缺陷（P0 红色基线复现，见 worktree memory-v0150-p0-baseline 的 test/p0）
 * - **R02**：10 条命中、预算只装得下 2 条时，`hits` / 头部「命中 N 条」/ 读租约仍按 10 条算。
 * - **R04**：once-per-turn 在**取数前**就占用；读取暂败 / 纯壳 / 非 enter / 取消 /
 *   宿主提交失败都永久消耗掉本回合唯一一次机会。
 * - **R04 确认面**：旧实现在「交给宿主」时就 `injected++` 并写读租约；宿主是否把
 *   decision.messages 写成会话事件、是否 flush 到 JSONL 都还没发生。
 *
 * ## 判据来源
 * `docs/dev-0.15.0/开发流程.md` §7.1（presentedIds/计数/租约、reserve-commit-release、
 * 「只有宿主确认呈现后才标成功」「有限 pending 不永久吞同轮」）、§7.2 R02/R04/R08；
 * 宿主顺序与落盘边界见 `docs/dev-0.15.0/P0-宿主合同.md` §2.1（append 提交 ≠ flush 耐久）。
 *
 * ## 断言组
 * A. 装包呈现面（R02）；B. 真实 `src/index.mjs` pre-step 回调接线（next=stop/抛错/并发/同轮重试）；
 * C. 确认面（只有插件 recall 事件确认）；D. 有限 pending（未确认即释放）；
 * E. 租约状态机与 owner 严格性；F. 租约合并纯函数；G. 用例层重试（纯单元，含超顶同实例红→绿）。
 *
 * ## 不适用条件与已知边界
 * - 全部为**合成夹具**（假 session / 临时 DSH_HOME），不读正式会话库、不碰 profile。
 * - 读租约断言依赖已验收的 R08 锁内 updater（b8c6b38 已合入），因此**真跑、不跳过**。
 * - 不覆盖真实宿主：事件形状、message.id 保留、JSONL flush 都未在真实会话核验。
 *
 * ## 定点变异自证（实测见 docs/dev-0.15.0/R02-R04-回注呈现.md）
 * hits→result.pack / 头部回候选数 / JSON 键当 turn / 去掉 next try-catch / handoff 时计数与写租约 /
 * 确认放宽到任意正文 / 未确认不释放 / owner 放宽 —— 逐条改回去必红。
 *
 * ## 运行命令与退出码
 * `node --test-force-exit test/v3-recall-r02-r04.test.mjs`（顶层，自动被 test-all 发现）；
 * 0 = 全绿，1 = 契约未满足。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { createRecall, RECALL_PACK_MAX_CHARS } from '../src/v3/application/recall.mjs'
import { mergeReadLeaseRows } from '../src/v3/domain/session/read-lease.mjs'
import { createRecallLeaseRegistry, recallBodyIdOf } from '../src/v3/domain/session/recall-counters.mjs'
import {
  createRecallConfirmations,
  isPluginRecallEvent,
  recallIdentityOfEvent,
} from '../src/v3/domain/session/recall-confirmation.mjs'
import { readSessionState, sessionStatePath, updateSessionState, writeSessionState } from '../src/v3/adapters/storage/session-state.mjs'
import { withCrossProcessWriteLock } from '../src/v3/adapters/storage/write-lock.mjs'
import { attachV3Engine } from '../src/v3/entry/v3-entry.mjs'
import { createFakeSession } from './helpers/fake-session.mjs'

const ENTRY = path.join(process.cwd(), 'src', 'index.mjs')
const MARK = 'r02mark'
const PLUGIN_KIND = 'dsh-memory-context-lab'
const RECALL_FORM = 'recall'

/* ------------------------------------------------------------------ helpers */

function providerOf({ hits, failReads = 0, oovTerms = [], sourceLabelSeq = null } = {}) {
  let reads = 0
  let searches = 0
  return {
    reads: () => reads,
    async search() {
      searches += 1
      const sourceLabel = Array.isArray(sourceLabelSeq) ? sourceLabelSeq[Math.min(searches - 1, sourceLabelSeq.length - 1)] : undefined
      return { display: hits, pack: hits, dropped: [], oovTerms, ...(sourceLabel === undefined ? {} : { sourceLabel }) }
    },
    async read(id) {
      reads += 1
      if (reads <= failReads) throw new Error('ETRANSIENT 模拟读取暂败')
      const hit = hits.find((h) => h.id === id)
      if (hit === undefined) throw new Error('未命中：' + id)
      return { text: hit.text, record: { createdAt: hit.createdAt ?? 1 } }
    },
    async health() { return { healthy: true } },
    capabilities() { return { name: 'r02-fake', tier: 'T1', live: true } },
  }
}

function hitsOf(count, bodyLength) {
  return Array.from({ length: count }, (_, i) => ({
    id: 'v3r-' + String(i + 1).padStart(16, '0'),
    score: 1 - i / 100,
    text: MARK + ' 记录' + i + '：' + '材料'.repeat(bodyLength),
    createdAt: 1000 + i,
  }))
}

const hitLineCount = (text) => String(text ?? '').split('\n').filter((line) => line.startsWith('· ')).length
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** R08 锁内 updater 是否已集成（跨分支依赖；没有就 t.skip()，不假装通过）。 */
async function updaterSupported() {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-r02-probe-'))
  try {
    await updateSessionState(root, 'probe', () => undefined)
    return true
  } catch {
    return false
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
}

/** 真实入口装配：`src/index.mjs` 的 apply + 严格宿主替身（只替换宿主服务，不改插件代码路径）。 */
async function withEntry({ id = 's-entry', seed, config = { enabled: true, packMinScore: 0 } } = {}, body) {
  const home = await mkdtemp(path.join(tmpdir(), 'mcl-r02r04-home-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const listeners = []
  const registered = []
  const warnings = []
  const stub = {
    logger: { warn: (m) => warnings.push(String(m)), info() {}, error: (m) => warnings.push(String(m)) },
    on(event, handler, options) { listeners.push({ event, handler, prepend: options?.prepend === true }); return () => {} },
    effect(fn) { const disposer = fn(); return () => { if (typeof disposer === 'function') disposer() } },
    inject(deps, callback) {
      if (typeof callback !== 'function') throw new TypeError('inject callback 必须是函数')
      return { dispose() {} }
    },
    commands: { register(definition) { registered.push(definition); return () => {} } },
  }
  const module = await import(pathToFileURL(ENTRY).href + '?t=' + Date.now())
  await module.apply(stub, config)
  const session = createFakeSession({ id })
  session.pushContextWindow(1_000_000)
  seed?.(session)
  const ingestListener = listeners.find((row) => row.event === 'agent/pre-step' && row.prepend !== true)
  const hook = listeners.find((row) => row.event === 'agent/pre-step' && row.prepend === true)
  assert.ok(hook !== undefined, '入口必须注册回注 pre-step 监听（prepend）')
  const status = async () => (await registered[0].handler({ rawInput: 'status', agent: { session } })).text ?? ''
  // 新对话默认关闭（产品口径 defaultEnabled=false）：先显式启用本会话，否则摄入与回注都被跳过。
  const enabled = await registered[0].handler({ rawInput: 'on', agent: { session } })
  assert.equal(enabled?.kind, 'success', '前置：本会话必须先显式启用（/memory-lab on）')
  const ingest = async () => {
    await ingestListener.handler({ agent: { session }, signal: { aborted: false }, messages: [] }, async () => ({ kind: 'enter', messages: [] }))
    for (let i = 0; i < 600; i += 1) {
      const text = await status()
      const match = /已摄入 (\d+)/.exec(text)
      // 必须等后台摄入**结束**：中途 inflight 非空时回注会如实回 busy（那是正确行为，
      // 但会让「同轮重试」的用例测不到租约语义）。
      if (match !== null && Number(match[1]) > 0 && !text.includes('后台摄入进行中')) return
      await sleep(10)
    }
    throw new Error('摄入超时：状态文本里没有出现「已摄入 N>0」')
  }
  const runHook = async ({ turn = 1, step = 1, messages = [], next = async () => ({ kind: 'enter', messages: [] }) } = {}) =>
    await hook.handler({ agent: { session }, turn, step, signal: { aborted: false }, messages }, next)
  /** 模拟宿主 append 后**同步**发 session/event（dsh-session 核验，监听器不被 await）。 */
  const emit = (event) => {
    for (const row of listeners.filter((item) => item.event === 'session/event')) row.handler(session, event)
  }
  /** 追加一条宿主事件并发出 session/event。 */
  const appendEvent = (type, data) => {
    const seq = session.log.length
    session.append(type, data)
    const event = session.log[session.log.length - 1] ?? { seq, type, data }
    emit(event)
    return event
  }
  try {
    return await body({ session, hook, runHook, ingest, status, warnings, home, id, emit, appendEvent })
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true }).catch(() => {})
  }
}

/** 直接装配 v3 引擎（不含 index 入口）：用于观察 entry 内部顺序与容量。 */
async function withEngine({ id = 's-engine', seed, contextWindow = 1_000_000 } = {}, body) {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-r02r04-engine-'))
  const hooks = []
  const ctx = {
    on(name, handler, opts) { hooks.push({ name, handler, prepend: opts?.prepend === true }); return () => {} },
    effect(fn) { const disposer = fn(); return () => { if (typeof disposer === 'function') disposer() } },
    logger: { warn() {}, info() {} },
  }
  const engine = attachV3Engine(ctx, { v3Root: root })
  try {
    const session = createFakeSession({ id })
    session.pushContextWindow(contextWindow)
    seed?.(session)
    for (const { name, handler, opts } of hooks) {
      if (name !== 'agent/pre-step' || opts?.prepend === true) continue
      await handler({ agent: { session }, turn: 1, step: 1, signal: { aborted: false }, messages: [] }, async () => ({ kind: 'enter', messages: [] }))
    }
    await engine._waitForIdle()
    return await body({ engine, session, root, id })
  } finally {
    await engine._waitForIdle().catch(() => {})
    engine.dispose()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
}

const recallMessagesOf = (decision) => (decision?.messages ?? []).filter((m) => m?.source?.form === RECALL_FORM)

/** 回注正文里实际呈现的条目数（头部「命中 N 条」与行数一致的那一个数）。 */
function outcomePresentedCount(decision) {
  const [message] = recallMessagesOf(decision)
  if (message === undefined) return 0
  const text = message.content?.[0]?.text ?? ''
  return text.split('\n').filter((line) => line.startsWith('· ')).length
}

/**
 * 模拟宿主把 decision.messages 落成 user/message 事件（真实形状：**data 本身即消息**，
 * data.id / data.source / data.content，无 data.message 外壳），并发出 session/event。
 */
function applyDecisionToSession(session, decision) {
  const emitted = []
  for (const message of recallMessagesOf(decision)) {
    session.append('user/message', { id: message.id, role: 'user', content: message.content, source: message.source })
    emitted.push(session.log[session.log.length - 1])
  }
  return emitted
}

/* ------------------------------- A. 装包呈现面（R02） ------------------------------- */

test('R02：hits / presentedIds / 头部计数只对应实际装包的条目', async () => {
  const hits = hitsOf(10, 1000)
  const recall = createRecall({ provider: providerOf({ hits }), sessionKey: 's-r02-a' })
  const out = await recall({ query: MARK, turn: 1, limit: 10, packMinScore: 0, previewChars: 1750 })
  assert.equal(out.injected, true, JSON.stringify({ reason: out.reason }))
  const lines = hitLineCount(out.text)
  assert.equal(out.hits.length, lines, 'hits 必须等于正文里的条目数（实测 ' + out.hits.length + ' vs ' + lines + '）')
  assert.deepEqual(out.presentedIds, out.hits.map((h) => h.id), 'presentedIds 与 hits 同源同序')
  assert.match(out.text.split('\n')[0], new RegExp('命中 ' + lines + ' 条'), '头部按最终装包数计：' + out.text.split('\n')[0])
  assert.equal(out.displayedCandidates, hits.length, '候选数另行如实给出（不等于呈现数）')
  assert.equal(out.omittedHits + lines, hits.length, '省略 + 呈现 = 候选（会计恒等）')
  assert.ok(out.text.length <= RECALL_PACK_MAX_CHARS, '硬顶仍成立')
  const again = await createRecall({ provider: providerOf({ hits }), sessionKey: 's-r02-a' })({ query: MARK, turn: 1, limit: 10, packMinScore: 0, previewChars: 1750 })
  assert.equal(again.bodyId, out.bodyId, '同会话同回合同查询同命中 → 同一 bodyId')
  for (const id of out.presentedIds) assert.ok(out.text.includes(id), 'presentedIds 里的 ID 必须在正文出现：' + id)
})

test('R02：正文里的每个条目 ID 都在 presentedIds 里（防错标）', async () => {
  const hits = hitsOf(6, 600)
  const recall = createRecall({ provider: providerOf({ hits }), sessionKey: 's-r02-b' })
  const out = await recall({ query: MARK, turn: 1, limit: 6, packMinScore: 0, previewChars: 900 })
  assert.equal(out.injected, true)
  const lineIds = out.text.split('\n').filter((line) => line.startsWith('· ')).map((line) => line.slice(2).split('（')[0])
  assert.deepEqual(lineIds, out.presentedIds, '正文行 ID 顺序与 presentedIds 必须一致')
})

/* ------------------------- B. 真实入口 hook 接线（R04） ------------------------- */

test('R04 hook：next=stop 归还后同轮重试可以注入（轮次必须是整数）', async () => {
  await withEntry({
    id: 's-hook-stop',
    seed(session) { session.pushUser(MARK + ' 历史正文 ' + '材料'.repeat(120)) },
  }, async ({ runHook, ingest, status, session, emit }) => {
    await ingest()
    const messages = [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: MARK }] }]
    const stopped = await runHook({ turn: 1, messages, next: async () => ({ kind: 'stop' }) })
    assert.deepEqual(recallMessagesOf(stopped), [], 'next=stop：本步不追加回注消息')
    assert.match(await status(), /注入 0/, 'next=stop 不得计入「已注入」')
    const entered = await runHook({ turn: 1, messages })
    assert.equal(recallMessagesOf(entered).length, 1, 'next=stop 后同轮重试必须能注入（旧实现这里 busy）')
    assert.match(await status(), /注入 0/, '交给宿主但未见宿主事件：仍不得计成功')
    // 宿主 step 内 append 后同步发 session/event：正向证据一到即确认（不必等 step/end）。
    for (const event of applyDecisionToSession(session, entered)) emit(event)
    assert.match(await status(), /注入 1/, '宿主 session/event 到达后才计「已注入」')
  })
})

test('R04 hook：next() 抛错也必须归还租约（同轮可重试）', async () => {
  await withEntry({
    id: 's-hook-throw',
    seed(session) { session.pushUser(MARK + ' 抛错路径 ' + '材料'.repeat(120)) },
  }, async ({ runHook, ingest, session, emit }) => {
    await ingest()
    const messages = [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: MARK }] }]
    await assert.rejects(
      () => runHook({ turn: 1, messages, next: async () => { throw new Error('host-next-boom') } }),
      /host-next-boom/,
      'next 抛错必须原样上抛（钩子不得吞宿主错误）',
    )
    const retry = await runHook({ turn: 1, messages })
    assert.equal(recallMessagesOf(retry).length, 1, 'next 抛错后同轮重试必须能注入（旧实现残留 pending → busy）')
    for (const event of applyDecisionToSession(session, retry)) emit(event)
  })
})

test('R04 hook：并发同回合最多一条回注消息', async () => {
  await withEntry({
    id: 's-hook-concurrent',
    seed(session) { session.pushUser(MARK + ' 并发 ' + '材料'.repeat(120)) },
  }, async ({ runHook, ingest }) => {
    await ingest()
    const messages = [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: MARK }] }]
    const [a, b] = await Promise.all([runHook({ turn: 1, messages }), runHook({ turn: 1, messages })])
    const total = recallMessagesOf(a).length + recallMessagesOf(b).length
    assert.equal(total, 1, '并发同回合最多一条回注消息（实际 ' + total + '）')
  })
})

/* ----------------------------- C. 确认面（R04） ----------------------------- */

test('R04 确认：普通用户消息 / 工具结果携带同一串不确认，插件 recall 事件才确认', async () => {
  await withEntry({
    id: 's-confirm',
    seed(session) { session.pushUser(MARK + ' 确认面 ' + '材料'.repeat(120)) },
  }, async ({ runHook, ingest, status, session, emit, appendEvent }) => {
    await ingest()
    const messages = [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: MARK }] }]
    const decision = await runHook({ turn: 1, messages })
    const [recallMessage] = recallMessagesOf(decision)
    assert.ok(recallMessage !== undefined, '前置：必须产出一条回注消息')
    const bodyId = /v3rl-[0-9a-f]{8}/.exec(recallMessage.content[0].text)?.[0]
    assert.ok(bodyId !== undefined, '回注正文里必须有 bodyId 来源身份')

    // ① 普通用户消息复制同一段正文；② 工具结果里出现同一串；③ 其它 form 的插件事件。
    appendEvent('user/message', { content: [{ type: 'text', text: '用户自己粘贴 ' + bodyId }], source: { kind: 'user' } })
    appendEvent('tool/result', { message: { role: 'tool', content: [{ type: 'text', text: '日志引用 ' + bodyId }] }, callId: 'c1', isError: false })
    appendEvent('user/message', { content: [{ type: 'text', text: bodyId }], source: { kind: PLUGIN_KIND, form: 'restore' } })
    assert.match(await status(), /注入 0/, '非插件 recall 来源一律不算确认')

    // 未确认不是靠时间/窗口释放：正证据到达即确认（宿主 step 内 append 后同步发事件）。
    for (const event of applyDecisionToSession(session, decision)) emit(event)
    assert.match(await status(), /注入 1/, '插件 recall 事件到达后才算确认')
  })
})

test('R04 确认：只认 data.id + 插件来源；正文 bodyId 与旧同 id 事件都不确认', async () => {
  await withEntry({
    id: 's-confirm-bodyid',
    seed(session) { session.pushUser(MARK + ' bodyId 兜底 ' + '材料'.repeat(120)) },
  }, async ({ runHook, ingest, status, session, emit, appendEvent }) => {
    await ingest()
    const messages = [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: MARK }] }]
    const decision = await runHook({ turn: 1, messages })
    const [recallMessage] = recallMessagesOf(decision)
    const bodyId = /v3rl-[0-9a-f]{8}/.exec(recallMessage.content[0].text)?.[0]
    assert.ok(bodyId !== undefined, '前置：正文里有内容身份 bodyId')

    // ① 只有正文（含 bodyId）、没有 data.id 的插件 recall 事件 → 不确认（不再扫正文兜底）
    appendEvent('user/message', { content: recallMessage.content, source: { kind: PLUGIN_KIND, form: RECALL_FORM } })
    assert.match(await status(), /注入 0/, '仅凭正文 bodyId 不得确认')

    // ② 旧同 id 事件（seq 早于登记起点）→ 不确认，也不释放
    const messageId = recallMessage.id
    emit({ seq: 0, type: 'user/message', data: { id: messageId, content: recallMessage.content, source: { kind: PLUGIN_KIND, form: RECALL_FORM } } })
    assert.match(await status(), /注入 0/, '早于登记起点的同 id 事件不得确认')
    assert.match(await status(), /pending-confirm/, '旧事件既不能确认也不能释放')

    // ③ 正常事件（seq 严格大于登记起点、data.id 一致）→ 确认
    appendEvent('user/message', { id: messageId, content: recallMessage.content, source: { kind: PLUGIN_KIND, form: RECALL_FORM } })
    assert.match(await status(), /注入 1/, '新事件 id 一致且 seq 更新时才确认')

    // ④ 来源内部 id 冲突 → 不确认
    const second = await runHook({ turn: 2, messages })
    const [secondMessage] = recallMessagesOf(second)
    appendEvent('user/message', {
      id: secondMessage.id,
      source: { kind: PLUGIN_KIND, form: RECALL_FORM, messageId: 'conflicting-id' },
      content: secondMessage.content,
    })
    assert.match(await status(), /注入 1/, 'data.id 与 source.messageId 冲突时不得确认')
  })
})

test('R04 确认：读租约只在确认后写入（依赖已验收的 R08 updater）', async () => {
  // R08 锁内 updater 已于 b8c6b38 合入（e3827c4 原语 + 5887399 测试）。这里**不再跳过**：
  // 「租约只在确认后写」是本切片的核心断言，跳过它等于不验。
  assert.equal(await updaterSupported(), true, 'updateSessionState 必须支持锁内 updater（R08 已验收原语）')
  await withEntry({
    id: 's-confirm-lease',
    seed(session) { session.pushUser(MARK + ' 租约确认 ' + '材料'.repeat(120)) },
  }, async ({ runHook, ingest, session, home, id, emit }) => {
    await ingest()
    const messages = [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: MARK }] }]
    const decision = await runHook({ turn: 1, messages })
    const v3Root = path.join(home, '.memory-context-lab', 'v3')
    assert.deepEqual(readSessionState(v3Root, id).readLease ?? [], [], '交给宿主但未确认时不得写读租约')
    for (const event of applyDecisionToSession(session, decision)) emit(event)
    // 租约写入是异步排队的（宿主不 await 监听器）；下一个 pre-step 开头会先 flush。
    await runHook({ turn: 1, messages: [], next: async () => ({ kind: 'stop' }) })
    const ids = (readSessionState(v3Root, id).readLease ?? []).map((row) => row.recordId)
    assert.ok(ids.length > 0, '确认后必须为实际呈现的条目写租约')
    const presented = outcomePresentedCount(decision)
    assert.equal(ids.length, presented, '租约条数必须等于实际呈现条数（' + presented + '）')
  })
})

/* ------------------- C2. 顺序：先等租约写入，再归档 ------------------- */

test('R04 顺序（trace 观测）：archiveForStep 在归档前 flush，且归档返回时租约已落盘', async () => {
  await withEngine({
    id: 's-order',
    seed(session) { session.pushUser(MARK + ' 顺序握手 ' + '材料'.repeat(120)) },
  }, async ({ engine, session, root, id }) => {
    const out = await engine.recallForInjection(id, MARK, { turn: 1, packMinScore: 0, previewChars: 200, queryMaxChars: 512 })
    assert.equal(out.status, 'injected', JSON.stringify(out))
    const log = session.log
    const lastSeq = log.length > 0 ? log[log.length - 1].seq : -1
    const handed = engine.handoffInjection(id, 1, {
      reservation: out.reservation,
      messageId: out.messageId,
      bodyId: out.bodyId,
      recordIds: out.presentedIds,
      step: 1,
      seqBase: lastSeq,
    })
    assert.equal(handed.handedOff, true, JSON.stringify(handed))
    session.append('user/message', {
      id: out.messageId,
      role: 'user',
      content: [{ type: 'text', text: '回注包' }],
      source: { kind: PLUGIN_KIND, form: RECALL_FORM, messageId: out.messageId },
    })
    engine.observeSessionEvent(id, session.log[session.log.length - 1])
    await engine.archiveForStep(id, session, {})

    const trace = engine.lifecycleTrace()
    const flushAt = trace.indexOf('flush')
    const archiveAt = trace.indexOf('archive')
    assert.ok(flushAt >= 0 && archiveAt >= 0, 'trace 必须同时记录 flush 与 archive：' + JSON.stringify(trace))
    assert.ok(flushAt < archiveAt, '必须先 flush（等租约写入）再 archive：' + JSON.stringify(trace))
    const state = readSessionState(root, id)
    const leaseIds = (state.readLease ?? []).map((row) => row.recordId).sort()
    assert.deepEqual(leaseIds, [...new Set(out.presentedIds)].sort(), 'archive 返回时租约必须已落盘')
  })
})

test('R04 顺序（真实阻塞握手）：持锁期间写未落盘，两个 flush 与归档都不得越过；释放后落盘并归档', async () => {
  await withEngine({
    id: 's-order-block',
    seed(session) { session.pushUser(MARK + ' 阻塞握手 ' + '材料'.repeat(120)) },
  }, async ({ engine, session, root, id }) => {
    const out = await engine.recallForInjection(id, MARK, { turn: 1, packMinScore: 0, previewChars: 200, queryMaxChars: 512 })
    assert.equal(out.status, 'injected', JSON.stringify(out))
    engine.handoffInjection(id, 1, {
      reservation: out.reservation, messageId: out.messageId, bodyId: out.bodyId,
      recordIds: out.presentedIds, step: 1, seqBase: session.log.length > 0 ? session.log[session.log.length - 1].seq : -1,
    })
    session.append('user/message', {
      id: out.messageId, role: 'user', content: [{ type: 'text', text: '回注包' }],
      source: { kind: PLUGIN_KIND, form: RECALL_FORM, messageId: out.messageId },
    })
    // 用**已有**跨进程写锁做受控阻塞：持锁者不释放，markReadLease 的 updater 就进不去。
    const dir = path.dirname(sessionStatePath(root, id))
    const { stat } = await import('node:fs/promises')
    let releaseLock = () => {}
    const gate = new Promise((resolve) => { releaseLock = resolve })
    const holder = withCrossProcessWriteLock(dir, async () => { await gate }, { ttlMs: 30_000 })
    let locked = false
    for (let i = 0; i < 600 && !locked; i += 1) {
      try { await stat(path.join(dir, '.write-lock', 'owner.json')); locked = true } catch { await sleep(5) }
    }
    assert.equal(locked, true, '前置：必须真的持锁（否则阻塞握手机不成立）')

    engine.observeSessionEvent(id, session.log[session.log.length - 1])
    let archiveSettled = false
    const archivePromise = engine.archiveForStep(id, session, {}).then((result) => { archiveSettled = true; return result })
    let flushSettled = 0
    const flushA = engine.flushInjectionConfirmation(id).then((r) => { flushSettled += 1; return r })
    const flushB = engine.flushInjectionConfirmation(id).then((r) => { flushSettled += 1; return r })
    await sleep(80)
    assert.equal(archiveSettled, false, '持锁期间归档不得完成（租约写还没落盘）')
    assert.equal(flushSettled, 0, '两个并发 flush 都不得越过未完成的写')
    const traceHeld = engine.lifecycleTrace()
    assert.ok(traceHeld.includes('flush'), '应在 flush 等待中')
    assert.equal(traceHeld.includes('archive'), false, '写未落盘时不得进入归档')

    releaseLock()
    await holder
    const archived = await archivePromise
    const [fa, fb] = await Promise.all([flushA, flushB])
    assert.equal(fa.ok, true)
    assert.equal(fb.ok, true)
    assert.notEqual(archived?.status, 'lease-write-failed', JSON.stringify(archived))
    const leaseIds = (readSessionState(root, id).readLease ?? []).map((row) => row.recordId).sort()
    assert.deepEqual(leaseIds, [...new Set(out.presentedIds)].sort(), '释放后租约必须落盘')
    const traceAfter = engine.lifecycleTrace()
    assert.ok(traceAfter.indexOf('flush') < traceAfter.indexOf('archive'), JSON.stringify(traceAfter))
  })
})

test('R04 失败关闭：写失败先 settle，两次归档都拒；明确恢复（同批 recordIds 成功写入）后才可归档', async () => {
  await withEngine({
    id: 's-order-fail',
    seed(session) { session.pushUser(MARK + ' 写入失败 ' + '材料'.repeat(120)) },
  }, async ({ engine, session, root, id }) => {
    const out = await engine.recallForInjection(id, MARK, { turn: 1, packMinScore: 0, previewChars: 200, queryMaxChars: 512 })
    assert.equal(out.status, 'injected', JSON.stringify(out))
    engine.handoffInjection(id, 1, {
      reservation: out.reservation, messageId: out.messageId, bodyId: out.bodyId,
      recordIds: out.presentedIds, step: 1, seqBase: session.log.length > 0 ? session.log[session.log.length - 1].seq : -1,
    })
    session.append('user/message', {
      id: out.messageId, role: 'user', content: [{ type: 'text', text: '回注包' }],
      source: { kind: PLUGIN_KIND, form: RECALL_FORM, messageId: out.messageId },
    })
    const { writeFile } = await import('node:fs/promises')
    const statePath = readSessionState(root, id).path
    await writeFile(statePath, '{"mode":"full-history","pins":', 'utf8')
    engine.observeSessionEvent(id, session.log[session.log.length - 1])
    // 等写**先失败并 settle**（正常「写先结束、下一步才归档」的时序），再归档两次。
    for (let i = 0; i < 300; i += 1) {
      const inspected = await engine.inspect(id)
      if (inspected.injection.lastLease !== null) break
      await sleep(10)
    }
    await sleep(20) // 一个 microtask 后再进入归档
    const first = await engine.archiveForStep(id, session, {})
    const second = await engine.archiveForStep(id, session, {})
    assert.equal(first?.status, 'lease-write-failed', '写已 settle 后仍必须阻断：' + JSON.stringify(first))
    assert.equal(second?.status, 'lease-write-failed', '第二次归档也不得自动清错放行：' + JSON.stringify(second))
    const trace = engine.lifecycleTrace()
    assert.equal(trace.includes('archive'), false, '失败阻断期间不得进入归档')

    // 明确恢复：修好状态文件，并对**同一批 recordIds** 做一次成功写入（下一回合同一查询 → 同记录）。
    await writeSessionState(root, id, { ...readSessionState(root, id) })
    const recovery = await engine.recallForInjection(id, MARK, { turn: 2, packMinScore: 0, previewChars: 200, queryMaxChars: 512 })
    assert.equal(recovery.status, 'injected', '恢复回合应能装包：' + JSON.stringify(recovery))
    engine.handoffInjection(id, 2, {
      reservation: recovery.reservation, messageId: recovery.messageId, bodyId: recovery.bodyId,
      recordIds: recovery.presentedIds, step: 1, seqBase: session.log.length > 0 ? session.log[session.log.length - 1].seq : -1,
    })
    session.append('user/message', {
      id: recovery.messageId, role: 'user', content: [{ type: 'text', text: '回注包' }],
      source: { kind: PLUGIN_KIND, form: RECALL_FORM, messageId: recovery.messageId },
    })
    engine.observeSessionEvent(id, session.log[session.log.length - 1])
    const afterRecovery = await engine.archiveForStep(id, session, {})
    assert.notEqual(afterRecovery?.status, 'lease-write-failed', '明确恢复后必须可以归档：' + JSON.stringify(afterRecovery))
    const traceAfter = engine.lifecycleTrace()
    assert.ok(traceAfter.includes('archive'), '恢复后必须真的进入归档：' + JSON.stringify(traceAfter))
  })
})

test('R04 负向收敛：step/end 必须精确匹配；缺字段不通配；turn/end 结束即可收敛', async () => {
  await withEntry({
    id: 's-bounded',
    seed(session) { session.pushUser(MARK + ' 负向收敛 ' + '材料'.repeat(120)) },
  }, async ({ runHook, ingest, status, appendEvent }) => {
    await ingest()
    const messages = [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: MARK }] }]
    const first = await runHook({ turn: 1, step: 1, messages })
    assert.equal(recallMessagesOf(first).length, 1, '前置：第一步交付了一条回注消息')
    // 异步 step/end（不同 step）不判死
    appendEvent('step/end', { turn: 1, step: 2 })
    assert.match(await status(), /上次结局：pending-confirm/, '不同 step 的 step/end 不得释放')
    // 缺字段不得通配
    appendEvent('step/end', {})
    assert.match(await status(), /上次结局：pending-confirm/, 'step/end 缺 turn/step 不得释放')
    // turn/end：reason.kind=error 不是「未交付」的证明，也不禁止收敛；turn 已结束 → 未交付可释放
    appendEvent('turn/end', { turn: 1, reason: { kind: 'error' } })
    assert.match(await status(), /上次结局：unconfirmed/, 'turn 结束且无证据 → 判未确认（error 也不例外）')
    const retry = await runHook({ turn: 1, step: 2, messages })
    assert.equal(recallMessagesOf(retry).length, 1, '未确认释放后同轮必须能重试（旧实现永久 pending → busy）')
  })
})

test('R04 hook：交接被拒（无法负向收敛）时不追加消息，同轮仍可重试', async () => {
  await withEntry({
    id: 's-handoff-reject',
    seed(session) { session.pushUser(MARK + ' 交接被拒 ' + '材料'.repeat(120)) },
  }, async ({ runHook, ingest, messages: none }) => {
    void none
    await ingest()
    const messages = [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: MARK }] }]
    // step 非法 → 无法做 step/end 收敛 → 交接失败关闭：**不得**把未登记的消息追加进 decision。
    const rejected = await runHook({ turn: 1, step: null, messages })
    assert.deepEqual(recallMessagesOf(rejected), [], '交接被拒时不得追加消息（否则未登记消息仍会落面）')
    const retry = await runHook({ turn: 1, step: 1, messages })
    assert.equal(recallMessagesOf(retry).length, 1, '拒绝只归还自己这次占位，同轮可重试')
  })
})

/* ------------------------- E. 租约状态机与 owner ------------------------- */

test('R04 租约：无 reserve 不能 commit；null owner 不能动别人的占位', () => {
  const leases = createRecallLeaseRegistry()
  assert.equal(leases.confirm('s', 1).confirmed, false, '没有 pending/handed-off 就不存在可确认的呈现')
  assert.equal(leases.confirm('s', 1, { owner: 'wrong' }).confirmed, false)

  assert.equal(leases.reserve('s', 2, { owner: 'A' }).reserved, true)
  assert.equal(leases.stateOf('s', 2), 'pending')
  assert.equal(leases.release('s', 2, { owner: 'B' }).released, false, 'wrong owner 不能 release')
  assert.equal(leases.release('s', 2).released, false, 'null owner 不能撤别人的 pending')
  assert.equal(leases.stateOf('s', 2), 'pending', '占位必须仍在')
  assert.equal(leases.handoff('s', 2, { owner: 'B', messageId: 'm' }).handedOff, false)
  assert.equal(leases.handoff('s', 2, { owner: 'A', messageId: 'm' }).handedOff, true)
  assert.equal(leases.stateOf('s', 2), 'handed-off', '交给宿主只是 handed-off，不是 confirmed')
  assert.equal(leases.confirm('s', 2, { owner: 'B' }).confirmed, false)
  assert.equal(leases.confirm('s', 2, { owner: 'A' }).confirmed, true)
  assert.equal(leases.stateOf('s', 2), 'confirmed')
  assert.equal(leases.forget('s', 2, { owner: 'B' }).forgotten, false)
  assert.equal(leases.forget('s', 2, { owner: 'A' }).forgotten, true)
})

test('R04 确认登记：严格 id + 严格更新 seq；终止事件必须精确匹配（缺字段不通配）', () => {
  const source = { sourceKind: PLUGIN_KIND, sourceForm: RECALL_FORM }
  const confirmations = createRecallConfirmations()
  confirmations.record({ sessionId: 's', turn: 1, step: 1, messageId: 'm-1', bodyId: 'v3rl-12345678', recordIds: ['v3r-a'], owner: 'A', seqBase: 10 })
  const bad = [
    { type: 'tool/result', seq: 11, data: { content: [{ type: 'text', text: 'v3rl-12345678' }] } },
    { type: 'user/message', seq: 12, data: { content: [{ type: 'text', text: 'v3rl-12345678' }], source: { kind: 'user' } } },
    { type: 'user/message', seq: 13, data: { content: [{ type: 'text', text: 'v3rl-12345678' }], source: { kind: PLUGIN_KIND, form: 'restore' } } },
    // 只有正文 bodyId、没有 id：不确认（不再扫正文）
    { type: 'user/message', seq: 14, data: { content: [{ type: 'text', text: 'v3rl-12345678' }], source: { kind: PLUGIN_KIND, form: RECALL_FORM } } },
    // 同 id 但 seq 不大于登记起点：不确认
    { type: 'user/message', seq: 10, data: { id: 'm-1', source: { kind: PLUGIN_KIND, form: RECALL_FORM } } },
    // 同 id 但 seq 非安全整数：不确认
    { type: 'user/message', seq: 1.5, data: { id: 'm-1', source: { kind: PLUGIN_KIND, form: RECALL_FORM } } },
    // 来源内部 id 冲突：不确认
    { type: 'user/message', seq: 16, data: { id: 'm-1', source: { kind: PLUGIN_KIND, form: RECALL_FORM, messageId: 'other' } } },
    // 缺 data.id、只有 source.messageId：不得代替 data.id 确认
    { type: 'user/message', seq: 18, data: { source: { kind: PLUGIN_KIND, form: RECALL_FORM, messageId: 'm-1' } } },
  ]
  for (const event of bad) {
    assert.deepEqual(confirmations.observe({ sessionId: 's', event, ...source }).confirmed, [], '不得确认：' + JSON.stringify(event.data))
  }
  const good = { type: 'user/message', seq: 17, data: { id: 'm-1', source: { kind: PLUGIN_KIND, form: RECALL_FORM } } }
  assert.equal(confirmations.observe({ sessionId: 's', event: good, ...source }).confirmed.length, 1, 'id 一致且 seq 更新时确认')
  // 已确认的呈现不会因为后续 turn/end（哪怕 reason.kind=error）被回退
  assert.equal(confirmations.observe({ sessionId: 's', event: { type: 'turn/end', seq: 18, data: { turn: 1, reason: { kind: 'error' } } }, ...source }).released.length, 0, '已确认的登记不参与回退')
  assert.equal(isPluginRecallEvent(good, source), true)
  assert.deepEqual(recallIdentityOfEvent(good), { ok: true, messageId: 'm-1' })

  // 负向：只认精确匹配的终止事件；缺字段不得通配
  const negative = createRecallConfirmations()
  negative.record({ sessionId: 's', turn: 2, step: 3, messageId: 'm-2', owner: 'B', seqBase: 20 })
  const notMatching = [
    { type: 'step/end', seq: 21, data: { turn: 2, step: 4 } },
    { type: 'step/end', seq: 22, data: {} },
    { type: 'step/end', seq: 23, data: { turn: 2 } },
    { type: 'step/end', seq: 24, data: { turn: null, step: 3 } },
    { type: 'turn/end', seq: 25, data: {} },
    { type: 'turn/end', seq: 26, data: { turn: '2' } },
  ]
  for (const event of notMatching) {
    assert.equal(negative.observe({ sessionId: 's', event, ...source }).released.length, 0, '不精确匹配不得释放：' + JSON.stringify(event))
  }
  // 登记时不知道 turn/step（record 不带）→ 任何 step/end 都不得「通配」释放它
  const unknown = createRecallConfirmations()
  unknown.record({ sessionId: 's', messageId: 'm-u', seqBase: 0 })
  assert.equal(unknown.observe({ sessionId: 's', event: { type: 'step/end', seq: 9, data: { turn: 9, step: 9 } }, ...source }).released.length, 0, '未知 turn/step 的登记不得被 step/end 通配释放')
  assert.equal(unknown.observe({ sessionId: 's', event: { type: 'turn/end', seq: 10, data: { turn: 9 } }, ...source }).released.length, 0, '未知 turn 的登记不得被 turn/end 通配释放')

  const turnEnd = { type: 'turn/end', seq: 27, data: { turn: 2, reason: { kind: 'error' } } }
  const released = negative.observe({ sessionId: 's', event: turnEnd, ...source }).released
  assert.equal(released.length, 1, 'turn 结束且无证据 → 未交付（reason.kind=error 不是反证）')
  assert.equal(released[0].reason, 'turn-ended')
})

test('R04 容量：同会话 cap+2 个已确认轮次全部成功，当前同轮仍拒重，异会话在飞保持', () => {
  const cap = 3
  const leases = createRecallLeaseRegistry({ cap })
  // 异会话的 handed-off 必须全程保持（不被容量清理牵连）
  assert.equal(leases.reserve('other', 1, { owner: 'o' }).reserved, true)
  assert.equal(leases.handoff('other', 1, { owner: 'o', messageId: 'm-o' }).handedOff, true)
  for (let turn = 1; turn <= cap; turn += 1) {
    assert.equal(leases.reserve('A', turn, { owner: 'a' + turn }).reserved, true, 'cap 内第 ' + turn + ' 轮必须能占位')
    assert.equal(leases.handoff('A', turn, { owner: 'a' + turn, messageId: 'm-' + turn }).handedOff, true)
    assert.equal(leases.confirm('A', turn, { owner: 'a' + turn }).confirmed, true)
  }
  // cap+1 / cap+2：旧回合 confirmed 是结构过期（宿主 turn 单调），必须能继续占位
  for (let turn = cap + 1; turn <= cap + 2; turn += 1) {
    const reserved = leases.reserve('A', turn, { owner: 'a' + turn })
    assert.equal(reserved.reserved, true, '第 ' + turn + ' 轮不得因历史 confirmed 被容量卡死：' + JSON.stringify(reserved))
    assert.equal(leases.handoff('A', turn, { owner: 'a' + turn, messageId: 'm-' + turn }).handedOff, true)
    assert.equal(leases.confirm('A', turn, { owner: 'a' + turn }).confirmed, true)
  }
  // 当前同轮仍必须拒绝（once-per-turn），异会话 handed-off 未被淘汰
  assert.equal(leases.reserve('A', cap + 2, { owner: 'again' }).reserved, false)
  assert.equal(leases.stateOf('A', cap + 2), 'confirmed')
  assert.equal(leases.stateOf('other', 1), 'handed-off', '异会话在飞身份不得被容量逻辑抹除')
})

test('R04 容量：满时拒绝新 reserve，绝不淘汰在飞身份（跨会话反例）', () => {
  const leases = createRecallLeaseRegistry({ cap: 2 })
  assert.equal(leases.reserve('A', 1, { owner: 'a' }).reserved, true)
  assert.equal(leases.handoff('A', 1, { owner: 'a', messageId: 'm-a' }).handedOff, true)
  assert.equal(leases.reserve('B', 1, { owner: 'b' }).reserved, true)
  const rejected = leases.reserve('C', 1, { owner: 'c' })
  assert.equal(rejected.reserved, false)
  assert.equal(rejected.reason, 'capacity', '满时拒绝（可见、可重试），而不是淘汰别人')
  assert.equal(leases.stateOf('A', 1), 'handed-off', '在飞身份不得被其它会话的流量淘汰')
  assert.equal(leases.stateOf('B', 1), 'pending')
  assert.equal(leases.confirm('A', 1, { owner: 'a' }).confirmed, true)
  assert.equal(leases.stateOf('A', 1), 'confirmed', 'confirmed 去重键不得被别会话流量抹除')
  // 同会话进入新回合：旧回合 confirmed 结构过期，可以被清；这是**同一会话**的结构推进，
  // 不是「满了删最老」，所以别会话的 B 仍保持 pending。
  assert.equal(leases.reserve('A', 2, { owner: 'a2' }).reserved, true, '同会话新回合应能占位（旧 confirmed 不占容量）')
  assert.equal(leases.stateOf('A', 1), 'absent', '旧回合 confirmed 已清')
  assert.equal(leases.stateOf('B', 1), 'pending', '别会话仍保持')
  assert.equal(leases.reserve('C', 1, { owner: 'c' }).reserved, false, '容量仍满（A/2 + B/1）')
  assert.equal(leases.forget('B', 1, { owner: 'b' }).forgotten, true)
  assert.equal(leases.reserve('C', 1, { owner: 'c' }).reserved, true, '腾出名额后可以继续')
})

test('R04 容量：确认登记满时拒绝新登记，第一凭据仍可精确终结', () => {
  const source = { sourceKind: PLUGIN_KIND, sourceForm: RECALL_FORM }
  const confirmations = createRecallConfirmations({ cap: 1 })
  assert.ok(confirmations.record({ sessionId: 's', turn: 1, step: 1, messageId: 'm-1', seqBase: 0 }))
  assert.equal(confirmations.record({ sessionId: 't', turn: 1, step: 1, messageId: 'm-2', seqBase: 0 }), null, '容量满必须拒绝新登记')
  assert.equal(confirmations.stats().overflow, 1, '拒绝必须可见（overflow 计数）')
  const released = confirmations.observe({ sessionId: 's', event: { type: 'turn/end', seq: 5, data: { turn: 1 } }, ...source })
  assert.equal(released.released.length, 1, '第一凭据仍可被终结事件精确清掉')
  assert.ok(confirmations.record({ sessionId: 't', turn: 1, step: 1, messageId: 'm-2', seqBase: 0 }), '腾出后可以登记')
})

/* ---------------- F. 租约合并纯函数（R08 消费方） ---------------- */

test('R08 租约合并：只延长不缩短、去重、过期清理、上界 200、确定性排序', () => {
  const now = 10_000
  const kept = mergeReadLeaseRows(
    [{ recordId: 'v3r-a', expiresAt: now + 9_000 }, { recordId: 'v3r-a', expiresAt: now + 3_000 }],
    ['v3r-b'],
    { now, ttlMs: 60_000 },
  )
  const map = new Map(kept.rows.map((row) => [row.recordId, row.expiresAt]))
  assert.equal(map.get('v3r-a'), now + 9_000, '同 ID 多行留最晚的一条')
  assert.equal(map.get('v3r-b'), now + 60_000, '新条目按 ttl 写入')
  assert.equal(kept.changed, true)

  const noShrink = mergeReadLeaseRows([{ recordId: 'v3r-a', expiresAt: now + 600_000 }], ['v3r-a'], { now, ttlMs: 1_000 })
  assert.equal(noShrink.rows.find((row) => row.recordId === 'v3r-a').expiresAt, now + 600_000, '不得缩短并发方更晚的到期时间')
  assert.equal(noShrink.changed, false, '无变化时 changed=false（入口据此 no-op，不写盘）')

  const cleaned = mergeReadLeaseRows([{ recordId: 'v3r-old', expiresAt: now - 1 }], [], { now })
  assert.deepEqual(cleaned.rows, [], '过期行在合并时清掉')
  assert.equal(cleaned.changed, true, '清掉过期行也是一次变化')

  const many = Array.from({ length: 210 }, (_, i) => ({ recordId: 'v3r-' + String(i).padStart(4, '0'), expiresAt: now + 1_000 + i }))
  const bounded = mergeReadLeaseRows(many, [], { now, max: 200 })
  assert.equal(bounded.rows.length, 200, '条数上界仍成立')
  assert.ok(!bounded.rows.some((row) => row.recordId === 'v3r-0000'), '被裁掉的是最快要过期的行')
  assert.equal(
    JSON.stringify(mergeReadLeaseRows(many, ['v3r-new'], { now, max: 200 }).rows),
    JSON.stringify(mergeReadLeaseRows(many, ['v3r-new'], { now, max: 200 }).rows),
    '同输入两次结果必须逐字节相同',
  )
})

test('R08 租约合并：只加本次实际呈现的 ID（R02 交叉约束）', () => {
  const now = 1_000
  const out = mergeReadLeaseRows([], ['v3r-p1', 'v3r-p2'], { now, ttlMs: 60_000 })
  assert.deepEqual(out.rows.map((row) => row.recordId).sort(), ['v3r-p1', 'v3r-p2'])
  const none = mergeReadLeaseRows([{ recordId: 'v3r-keep', expiresAt: now + 5_000 }], [], { now })
  assert.deepEqual(none.rows.map((row) => row.recordId), ['v3r-keep'])
  assert.equal(recallBodyIdOf({ sessionKey: 's', turn: 1, query: 'q', ids: [] }), recallBodyIdOf({ sessionKey: 's', turn: 1, query: 'q', ids: [] }), 'bodyId 同输入同输出')
})

/* ------------------- G. 用例层重试（纯单元） ------------------- */

test('R04 用例：读取暂败不消耗本回合唯一一次回注；成功后同轮只一次', async () => {
  const hits = hitsOf(1, 5)
  const recall = createRecall({ provider: providerOf({ hits, failReads: 1 }), sessionKey: 's-r04-a' })
  const first = await recall({ query: MARK, turn: 1 })
  assert.equal(first.injected, false, '第一次读取暂败不注入')
  assert.equal(first.releaseReason, 'all-unreadable', '未呈现必须如实带原因')
  assert.equal(first.released, true, '未呈现必须归还占位')
  const second = await recall({ query: MARK, turn: 1 })
  assert.equal(second.injected, true, '同回合重试必须能注入：' + JSON.stringify(second.reason))
  const third = await recall({ query: MARK, turn: 1 })
  assert.equal(third.injected, false, '成功呈现后同回合只一次')
  assert.match(String(third.reason), /只出现一步/)
})

test('R04 用例：超顶失败后同一实例同回合仍可注入（红→绿同一对象）', async () => {
  const hits = hitsOf(2, 100)
  // 头部固定行本身超硬顶：来源标签一次给 5000 字符（第二次恢复正常）——
  // 这是 capExceeded 唯一确定性入口（OOV 词表在 pack 里已被 boundedTerms 收敛）。
  const hugeLabel = '来源'.repeat(2600)
  const recall = createRecall({ provider: providerOf({ hits, sourceLabelSeq: [hugeLabel, '本地词法索引'] }), sessionKey: 's-r04-cap' })
  const huge = await recall({ query: MARK, turn: 1, limit: 2 })
  assert.equal(huge.injected, false, '固定行超顶必须拒绝注入（前置）')
  assert.equal(huge.capExceeded, true, '超顶如实标记')
  assert.equal(huge.released, true, '拒绝注入时必须归还占位')
  const ok = await recall({ query: MARK, turn: 1, limit: 2 })
  assert.equal(ok.injected, true, '同一实例同回合重试必须成功（旧实现被自己的占位挡住）')
})

test('R04 用例：两个并发同回合调用最多一个成功呈现', async () => {
  const hits = hitsOf(2, 2000)
  const recall = createRecall({ provider: providerOf({ hits }), sessionKey: 's-r04-concurrent' })
  const [a, b] = await Promise.all([
    recall({ query: MARK, turn: 1, limit: 2, packMinScore: 0 }),
    recall({ query: MARK, turn: 1, limit: 2, packMinScore: 0 }),
  ])
  const injected = [a, b].filter((out) => out.injected === true)
  assert.equal(injected.length, 1, '并发同回合最多一次成功呈现（实际 ' + injected.length + '）')
  const skipped = [a, b].find((out) => out.injected === false)
  assert.match(String(skipped.reason), /正在进行|只出现一步/, '被挡住的一侧必须给出可读原因：' + skipped.reason)
})
