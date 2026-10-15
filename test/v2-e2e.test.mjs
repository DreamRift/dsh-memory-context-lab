/**
 * v2 真实归档全链路端到端回归。
 *
 * 为什么单独一套：现有 v2 用例大量直接 `stageRecord` 合法记录来测存储，或用
 * 「调用与结果紧邻」的假日志测门禁——两条都绕过了真实路径最容易坏的地方。本套
 * 用例只走**产品真实入口**：
 *
 *   真实事件（含宿主必然穿插的非 surface `tool/call`）
 *     → collectHistoryCandidates（合法候选）
 *     → guard 门禁
 *     → createV2ClientFactory().createClient().rememberArchived（真实适配器）
 *     → V2SessionStore 提交（权威事务）
 *     → 宿主表层替换（fake-host 按真实 surface 规则校验，替换必须被接受）
 *     → 按稳定记录 ID 回读原文
 *     → 模型可见工具的 execute/render
 *
 * 断言的重点是「来源是真的」：冷库配对索引里的 messageId / toolName /
 * blockIndex / resultMessageId 必须来自宿主事件本身，不是编的；schema 闭合集
 * 必须被满足（否则 ESCHEMA 会把整个事务回滚，表现为「一条都没归档」）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { apply as applyPlugin } from '../src/index.mjs'
import { FakeColdStore, FakeSession, fakeMeter } from './helpers/fake-host.mjs'
import { V2SessionStore } from '../src/v2/store.mjs'
import { RECORD_KINDS, REF_KEYS_BY_KIND } from '../src/v2/records.mjs'
import { readRecordById } from '../src/v2/readback.mjs'
import { pairingRecordsFor } from '../src/v2/client-adapter.mjs'
import { readV2SessionState } from '../src/v2/state.mjs'

const COMMAND = 'memory-lab2'
const SESSION_ID = 'e2e000000000000000000001'

// ── 夹具 ────────────────────────────────────────────────────────────────────

/** Cordis 形状的最小上下文（与 v2-runtime / v2-guard 的 stub 同形）。 */
function createStubContext() {
  const listeners = new Map()
  const commands = []
  const cleanups = []
  const warnings = []
  const tools = []
  const ctx = {
    logger: { info() {}, warn(message) { warnings.push(String(message)) }, error() {} },
    get(name) {
      if (name === 'tokenMeter') return fakeMeter
      if (name === 'llm') return { resolveModelInfo: async () => ({ context: { contextWindow: 100000 }, defaultMaxTokens: 4096 }) }
      if (name === 'agents') return { get: () => undefined }
      return undefined
    },
    on(event, handler, options) {
      const rows = listeners.get(event) ?? []
      if (options?.prepend) rows.unshift(handler)
      else rows.push(handler)
      listeners.set(event, rows)
      return () => listeners.set(event, (listeners.get(event) ?? []).filter((row) => row !== handler))
    },
    effect(fn) {
      const local = []
      const result = fn()
      if (result && typeof result.next === 'function') {
        let step = result.next()
        while (!step.done) { local.push(step.value); step = result.next() }
      } else if (typeof result === 'function') local.push(result)
      cleanups.push(...local)
      return () => { for (const cleanup of local.splice(0).reverse()) cleanup?.() }
    },
    commands: { register(definition) { commands.push(definition); return () => {} } },
    sessionProjections: { register() { return () => {} } },
    tools: { register(definition) { tools.push(definition); return () => {} } },
    inject(deps, callback) {
      if (deps.every((dep) => ctx[dep] !== undefined)) callback(ctx)
      return { dispose() {} }
    },
    async _dispose() { for (const cleanup of cleanups.splice(0).reverse()) { try { await cleanup?.() } catch { /* 尽力而为 */ } } },
    _listeners: listeners,
    _commands: commands,
    _tools: tools,
    _warnings: warnings,
  }
  return ctx
}

function agentFor(session) {
  return {
    session,
    ctx: { tools: { schemas: () => [], restrict: () => () => {}, guard: () => () => {}, register: () => () => {} } },
    async runMaintenance(action) { return action(new AbortController().signal) },
  }
}

function run(ctx, agent, rawInput) {
  const definition = ctx._commands.find((row) => row.name === COMMAND)
  assert.ok(definition, `${COMMAND} 命令必须已注册`)
  return definition.handler({ agent, rawInput, signal: new AbortController().signal })
}

/**
 * 启用并收窄保留窗口：默认 retain=5 / batch=5 会让 3 个操作全留在热面上，
 * 「没有候选」是正确行为，但那样就测不到归档链路。显式设 retain=1 / batch=1，
 * 让每个已完成的、已曝光的操作都成为候选。
 */
async function enableAndNarrow(ctx, agent) {
  const on = await run(ctx, agent, 'on')
  assert.equal(on.kind, 'success', `启用必须成功：${on.text}`)
  for (const setting of ['retain 1', 'batch 1']) {
    const result = await run(ctx, agent, `set ${setting}`)
    assert.equal(result.kind, 'success', `set ${setting} 必须成功：${result.text}`)
  }
}

async function withTempLab(name, body) {
  const root = await mkdtemp(path.join(tmpdir(), `mcl2e2e-${name}-`))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = root
  try {
    await body(path.join(root, '.memory-context-lab'))
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * 造一个**真实布局**的会话：助手工具调用与结果之间必然夹着宿主的日志专用事件。
 *
 * `tool/call` 不在宿主的 `SURFACE_EVENT_TYPES` 里（本机 app.asar 的
 * `dsh-session` 核验），所以它只能走非 surface append。仓库原有夹具不带它，
 * 于是「区间里每个 seq 都必须是 surface 节点」的旧判定在测试里全绿、在生产里
 * 100% 拒绝——本夹具就是补上这个差异。
 */
function buildRealLayoutSession({ operations = 3, resultChars = 4000, id = SESSION_ID, withToolCall = true } = {}) {
  const session = new FakeSession({ id })
  session.append('system/message', {
    turn: 0,
    step: 0,
    message: { id: 'sys', role: 'system', content: [{ type: 'text', text: 'system prompt' }], source: { kind: 'system-prompt' } },
  }, { surfaceOp: 'append' })
  session.append('user/message', {
    id: 'u1',
    role: 'user',
    content: [{ type: 'text', text: '请阅读这些文件并总结' }],
    source: { kind: 'user', rpcId: 'rpc-1' },
  }, { surfaceOp: 'append' })

  for (let index = 0; index < operations; index += 1) {
    const callId = `call-${index + 1}`
    const turn = index + 1
    session.append('assistant/message', {
      turn,
      step: 1,
      message: {
        id: `m-${callId}`,
        role: 'assistant',
        content: [{ type: 'tool-call', id: callId, name: index % 2 === 0 ? 'read' : 'edit', arguments: `{"file":"file-${index + 1}.md"}` }],
        source: { kind: 'model', provider: 'fake', model: 'fake-model' },
      },
    }, { surfaceOp: 'append' })
    if (withToolCall) {
      // 宿主在结果之前落一条日志专用事件（不参与消息投影）。
      session.append('tool/call', { callId, name: 'read', arguments: '{"file":"file-1.md"}' })
    }
    session.append('tool/result', {
      turn,
      step: 1,
      message: {
        id: `r-${callId}`,
        role: 'tool',
        content: [{ type: 'text', text: `标记-${index}:${'内容'.repeat(Math.ceil(resultChars / 2))}` }],
        source: { kind: 'tool', callId },
        toolCallId: callId,
      },
    }, { surfaceOp: 'append' })
    session.append('turn/end', { turn, reason: { kind: 'complete' } })
  }
  return session
}

/** 会话里模型可见的文本投影（替换后的表层）。 */
function visibleText(session) {
  return session.surface.nodes
    .map((seq) => session.eventAt(seq))
    .filter((event) => event?.type === 'user/message' || event?.type === 'assistant/message' || event?.type === 'tool/result')
    .map((event) => JSON.stringify(event.data?.message?.content ?? event.data?.content ?? ''))
    .join('\n')
}

/**
 * 释放插件持有的库句柄后再直接打开存储。
 *
 * 同一个会话目录在本进程内只允许一个句柄（EOPEN 守卫，这是刻意的），所以插件
 * 运行期间测试不能另开一个。先 `_dispose()`（= 插件的 shutdown 路径，同时释放
 * 句柄）再打开，既拿到原始记录，又顺带验证了「重启后仍可读」。
 */
async function openStoreAfterShutdown(ctx, labRoot) {
  await ctx._dispose()
  return V2SessionStore.open({ labRoot, sessionId: SESSION_ID, readOnly: true })
}

async function openStore(labRoot) {
  return V2SessionStore.open({ labRoot, sessionId: SESSION_ID, readOnly: true })
}

// ── 用例 ────────────────────────────────────────────────────────────────────

test('端到端：真实布局（含 tool/call 穿插）下归档真的发生，冷库来源字段来自宿主事件', async () => {
  await withTempLab('archive', async (labRoot) => {
    const ctx = createStubContext()
    await applyPlugin(ctx)
    const session = buildRealLayoutSession({ operations: 3, resultChars: 3000 })
    const agent = agentFor(session)
    await enableAndNarrow(ctx, agent)

    const outcome = await run(ctx, agent, 'now')
    assert.equal(outcome.kind, 'success', `真实布局下归档必须成功：${outcome.text}`)
    // batch=1：一次只归档一个操作；再跑一次把第二个也归档。
    // 保留窗口（retain=1）内的最后一个操作**必须**留在热面上——这正是「不把整条
    // 长任务全部永久 pin」与「最近操作不提前退出」两条规则的交叉点。
    const second = await run(ctx, agent, 'now')
    assert.equal(second.kind, 'success', `第二次归档必须成功：${second.text}`)

    // 插件自己的读取面（命令）先确认记录存在且可按 ID 回读原文。
    const history = await run(ctx, agent, 'history')
    assert.equal(history.kind, 'success')
    assert.ok(!history.text.includes('（没有更多记录）'), `真实布局下必须列出记录：${history.text}`)
    assert.ok(!history.text.includes('[object Object]'), '范围必须渲染成人读得懂的形式')
    const listedId = /t\d{8}-r\d{4}/.exec(history.text)?.[0]
    assert.ok(listedId, `history 必须给出稳定记录 ID：${history.text}`)
    const readBack = await run(ctx, agent, `read ${listedId}`)
    assert.equal(readBack.kind, 'success', `按 ID 回读必须成功：${readBack.text}`)
    assert.ok(readBack.text.includes('内容'), '回读必须是原文，不是回执')

    // 宿主表层替换：被归档那几段的原文不再出现在模型可见投影里，回执取而代之。
    // 用逐操作唯一标记判断，而不是「正文一个字都搜不到」——保留期内还有未归档的操作，
    // 断言必须精确到「哪几段退出了」。
    const visible = visibleText(session)
    assert.ok(visible.includes('已归档操作'), '表层必须出现回执')
    const stillVisible = new Set([...visible.matchAll(/标记-(\d+):/g)].map((match) => Number(match[1])))
    assert.deepEqual([...stillVisible], [2], '保留窗口内的最后一个操作必须仍在热面上，其余必须已退出投影')

    // 关掉插件（= 释放句柄）后直接查存储：核对来源字段与配对索引。
    const store = await openStoreAfterShutdown(ctx, labRoot)
    try {
      assert.ok(store.recordCount > 0, '真实布局下必须真的落库（旧门禁在此 100% 拒绝，记录数为 0）')

      const { entries } = store.listEntries({ limit: store.recordCount + 1 })
      const spans = entries.filter((entry) => entry.kind === RECORD_KINDS.PROJECTION_SPAN)
      assert.ok(spans.length > 0, '必须存在归档跨度记录')

      // 配对索引：调用与结果各一条，refs 只含封闭集里的键，值来自宿主事件。
      const calls = entries.filter((entry) => entry.kind === RECORD_KINDS.OPERATION_CALL)
      const results = entries.filter((entry) => entry.kind === RECORD_KINDS.OPERATION_RESULT)
      assert.ok(calls.length > 0, '必须落工具调用索引（在途动作判定的依据）')
      assert.ok(results.length > 0, '必须落工具结果索引')

      for (const entry of [...calls, ...results]) {
        const allowed = new Set(REF_KEYS_BY_KIND[entry.kind])
        for (const key of Object.keys(entry.refs)) {
          assert.ok(allowed.has(key), `${entry.kind} 的 refs.${key} 不在封闭集内（会被 store 以 ESCHEMA 拒写）`)
        }
        for (const key of allowed) {
          assert.ok(entry.refs[key] !== undefined && entry.refs[key] !== null, `${entry.kind} 缺少必填 refs.${key}`)
        }
      }

      const callIds = calls.map((entry) => entry.refs.callId)
      assert.deepEqual([...callIds].sort(), ['call-1', 'call-2'], 'callId 必须来自宿主工具调用块')
      for (const entry of calls) {
        assert.match(entry.refs.messageId, /^m-call-\d$/, 'messageId 必须来自助手消息本身')
        assert.ok(['read', 'edit'].includes(entry.refs.toolName), 'toolName 必须来自工具调用块')
        assert.equal(entry.refs.blockIndex, 0, 'blockIndex 必须是该块在 content 里的真实下标')
      }
      for (const entry of results) {
        assert.match(entry.refs.resultMessageId, /^r-call-\d$/, 'resultMessageId 必须来自结果消息本身')
      }

      // 按稳定 ID 回读：正文逐字等于宿主结果原文。
      const loaded = await readRecordById(labRoot, SESSION_ID, spans[0].id, { store })
      assert.equal(loaded.ok, true)
      assert.ok(loaded.payloadText.includes('内容'), '回读必须是原文，不是回执')
      assert.ok(loaded.payloadText.length > 1000, '回读正文长度应接近原始结果')
    } finally {
      store.close()
    }
  })
})

test('端到端：宿主接受下一次请求所需的投影形状（替换后仍可继续 append）', async () => {
  await withTempLab('resume', async (labRoot) => {
    const ctx = createStubContext()
    await applyPlugin(ctx)
    const session = buildRealLayoutSession({ operations: 3, resultChars: 2500 })
    const agent = agentFor(session)
    await enableAndNarrow(ctx, agent)
    await run(ctx, agent, 'now')

    // 替换之后宿主仍能继续追加事件（surface 校验通过 = 投影合法）。
    assert.doesNotThrow(() => {
      session.append('assistant/message', {
        turn: 9,
        step: 1,
        message: { id: 'm-after', role: 'assistant', content: [{ type: 'text', text: '继续' }], source: { kind: 'model', provider: 'fake', model: 'fake-model' } },
      }, { surfaceOp: 'append' })
    }, '替换后宿主必须仍接受新的 surface 事件')

    // 重启（新进程语义 = 释放句柄后重开）后旧 ID 仍可读。
    const store = await openStoreAfterShutdown(ctx, labRoot)
    try {
      const { entries } = store.listEntries({ limit: 50 })
      const span = entries.find((entry) => entry.kind === RECORD_KINDS.PROJECTION_SPAN)
      assert.ok(span, '重启后必须仍能列出归档跨度')
      const loaded = await readRecordById(labRoot, SESSION_ID, span.id, { store })
      assert.equal(loaded.ok, true, '停用/重启后旧 ID 仍必须可读')
      assert.ok(loaded.payloadText.length > 500)
    } finally {
      store.close()
    }
  })
})

test('端到端：模型可见工具按 ID 回读同一批记录，used/budget 真实且计入预算', async () => {
  await withTempLab('tool', async (labRoot) => {
    const ctx = createStubContext()
    await applyPlugin(ctx)
    const session = buildRealLayoutSession({ operations: 3, resultChars: 3000 })
    const agent = agentFor(session)
    await enableAndNarrow(ctx, agent)
    await run(ctx, agent, 'now')

    const history = await run(ctx, agent, 'history')
    const spanId = /t\d{8}-r\d{4}/.exec(history.text)?.[0]
    assert.ok(spanId, `必须能从命令面拿到稳定记录 ID：${history.text}`)

    const tool = ctx._tools[0]
    const value = await tool.execute({ record_ids: [spanId], budget_tokens: 4000 }, { agent })
    assert.ok(value.used_tokens > 0, 'used_tokens 必须是真实计量，不是硬编码 0')
    assert.equal(value.budget_tokens, 4000, 'budget_tokens 必须回显真实预算')
    assert.equal(value.records[0].id, spanId)
    assert.ok(value.records[0].text.includes('内容'), '按稳定 ID 必须能取回正文')
    const rendered = tool.output.render({ record_ids: [spanId], budget_tokens: 4000 }, value)
      .map((part) => part.text)
      .join('\n')
    assert.ok(rendered.includes(spanId), '渲染必须给出可回读的稳定 ID')
    assert.ok(!rendered.includes('[object Object]'), '渲染不得出现 [object Object]')

    // 预算远小于单条正文时：有界读取（只带回预算内的前缀）+ 说明，
    // 既不得静默塞满整条，也不得把「读不完」伪装成「记录不存在」。
    const tiny = await tool.execute({ record_ids: [spanId], budget_tokens: 10 }, { agent })
    assert.ok(tiny.warnings.length > 0, '预算不足必须给出告警而不是静默塞满')
    // 预算小到放不下「元数据 + 说明」本身时，必须**如实报溢出**并给出原因，
    // 而不是把 used 改小或吞掉说明来假装没超。
    assert.equal(tiny.budget_overflow, true, '放不下时必须报 budget_overflow')
    assert.ok(typeof tiny.overflow_reason === 'string' && tiny.overflow_reason.length > 0, '溢出必须带原因')
    const tinyText = tiny.records[0]?.text ?? ''
    assert.ok(tinyText.length < 500, `预算 10 时不得把整条正文装回来，实际带回 ${tinyText.length} 字`)
    assert.ok(tiny.warnings.some((line) => line.includes('字节')), '截断必须说明原文总长与本次范围')

    // 0 / 负数 / 超限：结构化错误，不静默放大预算（规范 §6.1）。
    for (const bad of [0, -1, 32001]) {
      const rejected = await tool.execute({ record_ids: [spanId], budget_tokens: bad }, { agent })
      assert.ok(rejected.error, `budget_tokens=${bad} 必须报错而不是静默换值`)
      assert.match(String(rejected.error), /budget_tokens|预算/)
    }

    await ctx._dispose()
  })
})

test('适配器：来源坐标缺失时如实跳过索引，绝不编造 messageId/toolName/blockIndex', () => {
  const staged = { id: 't00000001-r0000', inline: { nodeId: 'n1' } }
  // 完全没有 sources（旧调用方）→ 只报「缺来源坐标」，不写任何索引记录。
  const none = pairingRecordsFor({ sources: null, callIds: ['c1'], tools: ['read'], staged })
  assert.equal(none.filter((row) => row.record).length, 0, '没有来源坐标时不得写索引')
  assert.ok(none.some((row) => row.skip?.reason === 'missing-source-coordinates'))

  // 只有 callId：调用索引缺 messageId/toolName/blockIndex → 跳过并说明缺什么。
  const partial = pairingRecordsFor({
    sources: [{ callId: 'c1', messageId: null, toolName: 'read', blockIndex: null, resultMessageId: null }],
    callIds: ['c1'],
    tools: ['read'],
    staged,
  })
  const skips = partial.filter((row) => row.skip).map((row) => row.skip.reason)
  assert.ok(skips.some((reason) => reason.includes('callId') === false && reason.includes('messageId')), `应报出缺 messageId：${skips}`)
  assert.equal(partial.filter((row) => row.record).length, 0, '必填项缺失时不得写伪造索引')

  // 完整来源坐标 → 两条索引，refs 严格落在封闭集内。
  const full = pairingRecordsFor({
    sources: [{ callId: 'c1', messageId: 'm-1', toolName: 'read', blockIndex: 2, resultMessageId: 'r-1' }],
    callIds: ['c1'],
    tools: ['read'],
    staged,
  })
  const records = full.filter((row) => row.record).map((row) => row.record)
  assert.equal(records.length, 2)
  assert.deepEqual(records[0].refs, { callId: 'c1', messageId: 'm-1', toolName: 'read', blockIndex: 2 })
  assert.deepEqual(records[1].refs, { callId: 'c1', resultMessageId: 'r-1' })
})

test('端到端：没有穿插事件时行为不变（对照布局仍归档）', async () => {
  await withTempLab('control', async (labRoot) => {
    const ctx = createStubContext()
    await applyPlugin(ctx)
    const session = buildRealLayoutSession({ operations: 3, resultChars: 2500, withToolCall: false })
    const agent = agentFor(session)
    await enableAndNarrow(ctx, agent)
    const outcome = await run(ctx, agent, 'now')
    assert.equal(outcome.kind, 'success')
    const store = await openStoreAfterShutdown(ctx, labRoot)
    try {
      assert.ok(store.recordCount > 0, '对照布局也必须归档（门禁放宽的是日志专用穿插，不是放行一切）')
    } finally {
      store.close()
    }
  })
})

/** 给会话追加一条「已完成请求」的 usage 样本（携带它的 assistant/message seq 即标识）。 */
function appendUsage(session, index, { inputTokens, cacheReadTokens }) {
  return session.append('assistant/message', {
    turn: 100 + index,
    step: 1,
    message: {
      id: `usage-${index}`,
      role: 'assistant',
      content: [{ type: 'text', text: `第 ${index} 次回复（短文本，不构成批候选）。` }],
      source: { kind: 'model', provider: 'fake', model: 'fake-model' },
    },
    usage: { inputTokens, cacheReadTokens, outputTokens: 10 },
  }, { surfaceOp: 'append' })
}

test('C3/O3：批提交前后各取一次 usage，差额记 observedInvalidationTokens（只观测不因果）', async () => {
  await withTempLab('usage-watch', async (labRoot) => {
    const ctx = createStubContext()
    await applyPlugin(ctx)
    const session = buildRealLayoutSession({ operations: 3, resultChars: 3000, id: 'session-v2-usage-01' })
    const agent = agentFor(session)
    // 批提交时刻的「最近完成请求」：高命中、低未命中。
    appendUsage(session, 1, { inputTokens: 500, cacheReadTokens: 4000 })
    await enableAndNarrow(ctx, agent)

    // 第一批：挂基线（pending = usage 样本 A），不产生差额。
    const first = await run(ctx, agent, 'now')
    assert.equal(first.kind, 'success', `第一批必须成功：${first.text}`)
    const cost1 = await run(ctx, agent, 'cost')
    assert.match(cost1.text, /批前后 usage 差额累计：≈0 token/)
    const state1 = await readV2SessionState(labRoot, 'session-v2-usage-01')
    assert.equal(state1.state.usageWatch.pending.inputTokens, 500, '批提交时刻的基线必须落盘')
    assert.equal(state1.state.usageWatch.batchReplacements, 1, '本批实际替换段数回填')

    // 批后「下一次完成的请求」：未命中暴涨（前缀失效的样子）。
    appendUsage(session, 2, { inputTokens: 5000, cacheReadTokens: 100 })

    // 第二批：结算 A→B 差额（5000−500=4500），换命中率入账。
    const second = await run(ctx, agent, 'now')
    assert.equal(second.kind, 'success', `第二批必须成功：${second.text}`)
    const cost2 = await run(ctx, agent, 'cost')
    assert.match(cost2.text, /批前后 usage 差额累计：≈4500 token（观测口径/)
    assert.match(cost2.text, /不宣称因果/, '报表必须声明口径边界')
    const status2 = await run(ctx, agent, 'status')
    assert.match(status2.text, /批前后观测（/)
    assert.match(status2.text, /命中率 88\.9% → 2\.0%；含并发因素/, '前后命中率都要给出')
    const state2 = await readV2SessionState(labRoot, 'session-v2-usage-01')
    assert.equal(state2.state.usageWatch.pending.inputTokens, 5000, '结算后基线前进到样本 B')
    assert.equal(state2.state.usageWatch.settled.deltaTokens, 4500)
    assert.equal(state2.state.usageWatch.settled.batchReplacements, 1, '结算行对应上一批的段数')

    // 幂等：候选耗尽后再跑（无批提交），同一份 usage 不会被重复结算。
    const third = await run(ctx, agent, 'now')
    assert.equal(third.kind, 'success')
    const cost3 = await run(ctx, agent, 'cost')
    assert.match(cost3.text, /批前后 usage 差额累计：≈4500 token/, '无新批提交时不得重复结算')

    await ctx._dispose()
  })
})

test('B2 端到端：v2 会话的 restore 恢复回执原文且不停用引擎', async () => {
  await withTempLab('restore', async (labRoot) => {
    const ctx = createStubContext()
    await applyPlugin(ctx)
    const session = buildRealLayoutSession({ operations: 3, resultChars: 3000 })
    const agent = agentFor(session)
    await enableAndNarrow(ctx, agent)

    const first = await run(ctx, agent, 'now')
    assert.equal(first.kind, 'success', `归档必须成功：${first.text}`)
    const archived = visibleText(session)
    assert.ok(archived.includes('已归档操作'), '归档后表层必须出现回执')
    // 归档后仍有部分原文在热面上（retain 窗口），只记录哪些标记被退热。
    const archivedMarks = new Set([...archived.matchAll(/标记-(\d+):/g)].map((match) => Number(match[1])))
    assert.ok(archivedMarks.size >= 2, `3 个操作 retain=1 至少退出 2 段，实际 ${[...archivedMarks]}`)

    // B2 核心：restore 恢复全部可恢复回执，引擎保持启用（与 off 的唯一区别）。
    const restored = await run(ctx, agent, 'restore')
    assert.equal(restored.kind, 'success', `v2 restore 必须成功：${restored.text}`)
    assert.match(restored.text, /引擎保持启用/)
    assert.ok(Number(restored.restored) >= 1, `必须如实报告恢复段数：${restored.restored}`)
    const afterRestore = visibleText(session)
    assert.ok(!afterRestore.includes('已归档操作'), 'restore 后回执必须退出表层')
    const backMarks = new Set([...afterRestore.matchAll(/标记-(\d+):/g)].map((match) => Number(match[1])))
    assert.ok(backMarks.size > archivedMarks.size, `被归档的原文必须回到表层：${[...backMarks]} vs ${[...archivedMarks]}`)

    // 引擎未停用：状态仍启用、账本 enabled。
    const status = await run(ctx, agent, 'status')
    assert.match(status.text, /v2 引擎：已启用/, `restore 不得停用引擎：${status.text}`)
    const stored = await readV2SessionState(labRoot, SESSION_ID)
    assert.equal(stored?.state?.enabled, true, 'restore 不得停用 v2 账本')
    await ctx._dispose()
  })
})

test('B2：未启用会话的 v2 restore 如实报告，不冒用 v1 的「请先启用」文案', async () => {
  await withTempLab('restore-absent', async () => {
    const ctx = createStubContext()
    await applyPlugin(ctx)
    const session = buildRealLayoutSession({ operations: 1, resultChars: 3000, id: 'e2e-no-v2-01' })
    const agent = agentFor(session)
    const outcome = await run(ctx, agent, 'restore')
    assert.equal(outcome.kind, 'error', `未启用时必须是 error：${outcome.text}`)
    assert.match(outcome.text, /v2 引擎在本会话未启用/)
    assert.ok(!outcome.text.includes('请先使用 /memory-lab on'), '不得冒用 v1 的「未启用」文案')
    await ctx._dispose()
  })
})
