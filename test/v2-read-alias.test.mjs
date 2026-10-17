/**
 * v2 按别名回读测试（0.10.1 S2a/S2b）。
 *
 * 缺陷（五会话 8e1b 实测形状）：recall 的 record_ids 只认精确 t…-r… 记录 ID；
 * 回执正文只印 mcl2-… nodeId——模型拿回执上唯一可见的 ID 回读必然全部落进
 * warnings，且「全部失败」伪装成「空成功」（matched/records 不带任何结局）,
 * 回读通道在实践中不可用（取证 R0 问题 1；docs/0.10.1-修复取证 §5 S2）。
 *
 * 判据：nodeId 基名/分块名/callId 解析到单元闭包；span 分块按 chunk 序合并拼接；
 * 未解析 ID 有显式 error 行；空展开报 EREADALIASEMPTY；成功路径（精确 ID）
 * 的返回形状与旧行为完全一致。fork/遗忘守卫在别路径上仍生效。
 *
 * 不适用条件：宽条件（kind=/before=）不适用（那是 forget 语义）；本套件不测
 * T1 检索通道（v2-local-lexical/v2-retrieval 负责）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { apply as applyPlugin } from '../src/index.mjs'
import { buildSession, fakeMeter } from './helpers/fake-host.mjs'
import { createV2SessionState, writeV2SessionState } from '../src/v2/state.mjs'
import { V2SessionStore } from '../src/v2/store.mjs'
import { RECORD_KINDS, draftRecord } from '../src/v2/records.mjs'
import { getForgetIndex, isForgotten } from '../src/v2/disposition.mjs'

const COMMAND = 'memory-lab2'

function createStubContext() {
  const listeners = new Map()
  const commands = []
  const cleanups = []
  const warnings = []
  const tools = []
  const ctx = {
    logger: {
      info() {},
      warn(message) { warnings.push(String(message)) },
      error() {},
    },
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
        while (!step.done) {
          local.push(step.value)
          step = result.next()
        }
      } else if (typeof result === 'function') {
        local.push(result)
      }
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
    async _dispose() {
      for (const cleanup of cleanups.splice(0).reverse()) {
        try { await cleanup?.() } catch { /* 尽力而为 */ }
      }
    },
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

function invocationFor(agent, rawInput) {
  return { agent, rawInput, signal: new AbortController().signal }
}

function run(ctx, agent, rawInput) {
  const definition = ctx._commands.find((row) => row.name === COMMAND)
  assert.ok(definition, COMMAND + ' 命令必须已注册')
  return definition.handler(invocationFor(agent, rawInput))
}

async function withTempLab(name, body) {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl2alias-' + name + '-'))
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

async function boot() {
  const ctx = createStubContext()
  await applyPlugin(ctx)
  return ctx
}

/**
 * 预置一个归档形状的 v2 库（8e1b 形状的抽象）：
 * - span 两分块（nodeId mcl2-alias-001_p1/_p2，chunk 1/2，正文前后两半）；
 * - 同单元一对 call/result（callId call_alias_1）；
 * - 一个无关用户消息记录（不带 nodeId/callId）。
 * 返回各记录 ID。
 */
async function seedAliasUnit(labRoot, sessionId) {
  const store = await V2SessionStore.init({ labRoot, sessionId })
  try {
    const txn = await store.openTransaction()
    const stage = (draft) => store.stageRecord(txn, draft)
    const span1 = await stage(draftRecord({
      kind: RECORD_KINDS.PROJECTION_SPAN,
      seq: 2,
      fidelity: 'synthesized',
      refs: { sourceKinds: 'operation', sourceSeqs: '2', spanKind: 'operation' },
      inline: { nodeId: 'mcl2-alias-001_p1', chunk: 1, chunkCount: 2, range: { start: 2, end: 3 }, tools: ['read'] },
      content: 'ALIAS-PART-ONE',
    }))
    const span2 = await stage(draftRecord({
      kind: RECORD_KINDS.PROJECTION_SPAN,
      seq: 2,
      fidelity: 'synthesized',
      refs: { sourceKinds: 'operation', sourceSeqs: '2', spanKind: 'operation' },
      inline: { nodeId: 'mcl2-alias-001_p2', chunk: 2, chunkCount: 2, range: { start: 2, end: 3 }, tools: ['read'] },
      content: 'ALIAS-PART-TWO',
    }))
    const callRec = await stage(draftRecord({
      kind: RECORD_KINDS.OPERATION_CALL,
      seq: 2,
      fidelity: 'verbatim',
      refs: { callId: 'call_alias_1', messageId: 'm2', toolName: 'read', blockIndex: 0 },
      inline: { nodeId: 'mcl2-alias-001_p1' },
      content: '{"file":"a.txt"}',
    }))
    const resultRec = await stage(draftRecord({
      kind: RECORD_KINDS.OPERATION_RESULT,
      seq: 3,
      fidelity: 'verbatim',
      refs: { callId: 'call_alias_1', resultMessageId: 'm3' },
      inline: { nodeId: 'mcl2-alias-001_p1' },
      content: 'ALIAS-RESULT',
    }))
    const userRec = await stage(draftRecord({
      kind: RECORD_KINDS.TURN_USER,
      seq: 1,
      fidelity: 'verbatim',
      refs: { messageId: 'm1', rpcId: null },
      content: 'unrelated user text',
    }))
    await store.commitTransaction(txn)
    return { span1: span1.id, span2: span2.id, call: callRec.id, result: resultRec.id, user: userRec.id }
  } finally {
    store.close()
  }
}

test('S2a：recall 按 nodeId 基名回读单元闭包，span 按 chunk 序合并拼接', async () => {
  await withTempLab('node', async (labRoot) => {
    const sessionId = 'session-alias-node-01'
    await seedAliasUnit(labRoot, sessionId)
    const ctx = await boot()
    const session = buildSession({ operations: 1, id: sessionId })
    const agent = agentFor(session)
    const result = await run(ctx, agent, 'read mcl2-alias-001')
    assert.equal(result.kind, 'success', result.text)
    // 拼接语义：span 两分块按 chunk 序合并（ALIAS-PART-ONE + ALIAS-PART-TWO）
    assert.ok(result.text.includes('ALIAS-PART-ONEALIAS-PART-TWO'), 'span 分块必须按 chunk 序合并拼接')
    // 配对记录在来源索引中可读（独立条目或包含在闭包渲染中）
    assert.ok(result.text.includes('ALIAS-RESULT'), '同单元配对结果必须可读')
    await ctx._dispose()
  })
})

test('S2a：recall 按分块名回读解析到同一单元闭包', async () => {
  await withTempLab('chunk', async (labRoot) => {
    const sessionId = 'session-alias-chunk-01'
    await seedAliasUnit(labRoot, sessionId)
    const ctx = await boot()
    const session = buildSession({ operations: 1, id: sessionId })
    const agent = agentFor(session)
    const result = await run(ctx, agent, 'read mcl2-alias-001_p2')
    assert.equal(result.kind, 'success', result.text)
    assert.ok(result.text.includes('ALIAS-PART-ONEALIAS-PART-TWO'))
    await ctx._dispose()
  })
})

test('S2a：recall 按 callId 回读配对记录与单元 span', async () => {
  await withTempLab('callid', async (labRoot) => {
    const sessionId = 'session-alias-callid-01'
    await seedAliasUnit(labRoot, sessionId)
    const ctx = await boot()
    const session = buildSession({ operations: 1, id: sessionId })
    const agent = agentFor(session)
    const result = await run(ctx, agent, 'read call_alias_1')
    assert.equal(result.kind, 'success', result.text)
    assert.ok(result.text.includes('ALIAS-RESULT'), 'callId 必须能读到配对结果')
    assert.ok(result.text.includes('ALIAS-PART-ONEALIAS-PART-TWO'), 'callId 的单元闭包包含 span 全部块')
    await ctx._dispose()
  })
})

test('S2b：未解析 ID 有显式 error 行，全失败不再伪装空成功', async () => {
  await withTempLab('unresolved', async (labRoot) => {
    const sessionId = 'session-alias-unres-01'
    const ids = await seedAliasUnit(labRoot, sessionId)
    const ctx = await boot()
    const session = buildSession({ operations: 1, id: sessionId })
    const agent = agentFor(session)
    // 混合：一个可解析 nodeId + 一个不存在的 ID
    const result = await run(ctx, agent, 'read mcl2-alias-001 t99999999-r9999')
    assert.equal(result.kind, 'success', result.text)
    assert.ok(result.text.includes('ALIAS-PART-ONEALIAS-PART-TWO'), '可解析部分照常返回')
    // 未解析 ID：显式 error 行（不藏在 warnings）
    assert.ok(/t99999999-r9999.*(EREADNOTFOUND|不存在|失败|无法)/.test(result.text), '未解析 ID 必须有显式结局')
    await ctx._dispose()
  })
})

test('S2a：精确记录 ID 路径返回形状不变（回归）', async () => {
  await withTempLab('exact', async (labRoot) => {
    const sessionId = 'session-alias-exact-01'
    const ids = await seedAliasUnit(labRoot, sessionId)
    const ctx = await boot()
    const session = buildSession({ operations: 1, id: sessionId })
    const agent = agentFor(session)
    const result = await run(ctx, agent, 'read ' + ids.result)
    assert.equal(result.kind, 'success', result.text)
    assert.ok(result.text.includes('ALIAS-RESULT'), '精确 ID 回读不受别名改动影响')
    assert.ok(!result.text.includes('（经 node-alias 映射）'), '精确 ID 不标注 alias 映射')
    await ctx._dispose()
  })
})

test('S2a：遗忘记录在别名路径上仍被守卫拦截', async () => {
  await withTempLab('forgotten', async (labRoot) => {
    const sessionId = 'session-alias-forg-01'
    const ids = await seedAliasUnit(labRoot, sessionId)
    // 把整个单元闭包遗忘：用 applyForget 直接写账本
    const { applyForget } = await import('../src/v2/disposition.mjs')
    const store = await V2SessionStore.open({ labRoot, sessionId })
    const dir = store.directory
    store.close()
    await applyForget({
      sessionDir: dir,
      actor: 'test',
      reason: '测试遗忘单元闭包',
      targetIds: [ids.span1, ids.span2, ids.call, ids.result],
    })
    const ctx = await boot()
    const session = buildSession({ operations: 1, id: sessionId })
    const agent = agentFor(session)
    const result = await run(ctx, agent, 'read mcl2-alias-001')
    assert.equal(result.kind, 'success', result.text)
    // 遗忘的单元不回正文：既不是 ALIAS-PART 也不是「空成功」的无提示
    assert.ok(!result.text.includes('ALIAS-PART-ONEALIAS-PART-TWO'), '遗忘记录不得经别名回读复活')
    assert.ok(/遗忘/.test(result.text), '遗忘拦截必须显式披露')
    await ctx._dispose()
  })
})

test('S2a 工具面：memory_lab_recall 按 record_ids 别名回读（8e1b 形状回放）', async () => {
  await withTempLab('tool', async (labRoot) => {
    const sessionId = 'session-alias-tool-01'
    await seedAliasUnit(labRoot, sessionId)
    const ctx = await boot()
    const session = buildSession({ operations: 1, id: sessionId })
    const agent = agentFor(session)
    const tool = ctx._tools.find((row) => row.name === 'memory_lab_recall')
    assert.ok(tool, 'memory_lab_recall 工具必须已注册')
    const value = await tool.execute({ record_ids: ['mcl2-alias-001'] }, { agent })
    assert.equal(value.mode, 'ids')
    assert.equal(value.error, null)
    const joined = (value.records ?? []).map((r) => r.text ?? '').join('')
    assert.ok(joined.includes('ALIAS-PART-ONEALIAS-PART-TWO'), '别名展开的 span 必须合并拼接');
    assert.ok(joined.includes('ALIAS-RESULT'), '别名展开的配对结果必须可读')
    const via = new Set((value.records ?? []).map((r) => r.resolved_via));
    assert.ok(via.has('node-alias'), '别名路径必须标注 resolved_via')
    // S2b：渲染文本披露别名解析
    const rendered = tool.output.render({}, value);
    assert.ok(rendered[0].text.includes('node-alias'), '渲染文本必须披露别名解析')
    await ctx._dispose()
  })
})
