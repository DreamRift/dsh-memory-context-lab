/**
 * P2 主动遗忘端到端回归（真实入口：命令 → 账本 → 表面撤回 → 读面过滤 → undo）。
 *
 * 与 v2-disposition 单测的分工：单测覆盖账本纯逻辑（CAS、幂等、多 cause、
 * 崩溃半行）；本套只走产品真实入口，断言「各读面不泄漏、重启不复活、
 * undo 后可读、restore 在遗忘期间被守卫拦截」。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { apply as applyPlugin } from '../src/index.mjs'
import { FakeSession, fakeMeter } from './helpers/fake-host.mjs'
import { V2SessionStore } from '../src/v2/store.mjs'

const COMMAND = 'memory-lab2'
const SESSION_ID = 'forget0000000000000000001'

function createStubContext() {
  const listeners = new Map()
  const commands = []
  const cleanups = []
  const warnings = []
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
    tools: { register() { return () => {} } },
    inject(deps, callback) {
      if (deps.every((dep) => ctx[dep] !== undefined)) callback(ctx)
      return { dispose() {} }
    },
    async _dispose() { for (const cleanup of cleanups.splice(0).reverse()) { try { await cleanup?.() } catch { /* 尽力而为 */ } } },
    _commands: commands,
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
  assert.ok(definition, 'memory-lab2 命令必须已注册')
  return definition.handler({ agent, rawInput, signal: new AbortController().signal })
}

async function enableAndNarrow(ctx, agent) {
  const on = await run(ctx, agent, 'on')
  assert.equal(on.kind, 'success', '启用必须成功')
  for (const setting of ['retain 1', 'batch 1']) {
    const result = await run(ctx, agent, 'set ' + setting)
    assert.equal(result.kind, 'success', 'set ' + setting + ' 必须成功：' + result.text)
  }
}

async function withTempLab(name, body) {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl2forget-' + name + '-'))
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

function buildSession() {
  const session = new FakeSession({ id: SESSION_ID })
  session.append('user/message', {
    id: 'u1', role: 'user',
    content: [{ type: 'text', text: '总结这些文件' }],
    source: { kind: 'user', rpcId: 'rpc-1' },
  }, { surfaceOp: 'append' })
  for (let index = 0; index < 3; index += 1) {
    const callId = 'call-' + (index + 1)
    session.append('assistant/message', {
      turn: index + 1, step: 1,
      message: {
        id: 'm-' + callId, role: 'assistant',
        content: [{ type: 'tool-call', id: callId, name: 'read', arguments: '{"file":"f' + (index + 1) + '.md"}' }],
        source: { kind: 'model', provider: 'fake', model: 'fake-model' },
      },
    }, { surfaceOp: 'append' })
    session.append('tool/call', { callId, name: 'read', arguments: '{"file":"f' + (index + 1) + '.md"}' })
    session.append('tool/result', {
      turn: index + 1, step: 1,
      message: {
        id: 'r-' + callId, role: 'tool',
        content: [{ type: 'text', text: '标记-' + index + ':' + '内容'.repeat(2000) }],
        source: { kind: 'tool', callId }, toolCallId: callId,
      },
    }, { surfaceOp: 'append' })
    session.append('turn/end', { turn: index + 1, reason: { kind: 'complete' } })
  }
  return session
}

function visibleText(session) {
  return session.surface.nodes
    .map((seq) => session.eventAt(seq))
    .filter((event) => event?.type === 'user/message' || event?.type === 'assistant/message' || event?.type === 'tool/result')
    .map((event) => JSON.stringify(event.data?.message?.content ?? event.data?.content ?? ''))
    .join('\n')
}

test('遗忘全链路：显式 ID → 表面墓碑 → 读面过滤 → 重启不复活 → undo 恢复可见性', async () => {
  await withTempLab('lifecycle', async (labRoot) => {
    const ctx = createStubContext()
    await applyPlugin(ctx)
    const session = buildSession()
    const agent = agentFor(session)
    await enableAndNarrow(ctx, agent)
    for (let i = 0; i < 2; i += 1) {
      const outcome = await run(ctx, agent, 'now')
      assert.equal(outcome.kind, 'success', '归档 ' + i + ' 必须成功：' + outcome.text)
    }
    // 收集已归档记录 ID（含 span 与配对记录）。
    const history = await run(ctx, agent, 'history')
    assert.equal(history.kind, 'success')
    const recordIds = [...new Set([...history.text.matchAll(/t\d{8}-r\d{4}/g)].map((m) => m[0]))]
    assert.ok(recordIds.length >= 2, 'history 必须列出已归档记录：' + history.text)
    // 确保回读通路先正常。
    const readOk = await run(ctx, agent, 'read ' + recordIds[0])
    assert.equal(readOk.kind, 'success', '遗忘前回读必须成功：' + readOk.text)

    // preview 显式目标：解析 + 无计划（显式不走两段式）。
    const preview = await run(ctx, agent, 'forget preview ' + recordIds.join(' '))
    assert.equal(preview.kind, 'success', 'preview 必须成功：' + preview.text)
    assert.match(preview.text, /当前 revision 0/)
    assert.match(preview.text, /本次将遗忘 \d+ 条记录/)

    // apply：账本生效 + 表面回执撤成墓碑。
    const apply = await run(ctx, agent, 'forget apply ' + recordIds.join(' '))
    assert.equal(apply.kind, 'success', 'apply 必须成功：' + apply.text)
    assert.match(apply.text, /软遗忘已生效/)
    assert.match(apply.text, /表面回执撤回 \d+ 个节点/)
    const visible = visibleText(session)
    assert.match(visible, /本段已按用户指令软遗忘/)
    // 墓碑自身合法携带 V2 回执标记（凭证保护按行首标记识别），判「原回执残留」
    // 要用回执专属行（沉库指引/恢复指引），不能用共享标记。
    assert.ok(!visible.includes('正文已沉入本会话隔离冷库'), '表面不得残留原回执正文')
    assert.ok(!visible.includes('恢复：/memory-lab restore 或 /memory-lab2 恢复流程'), '表面不得残留原回执恢复指引')
    assert.ok(visible.includes('本段已按用户指令软遗忘'), '墓碑回执应在表面')

    // 幂等：重复 apply 同一批目标不追加条目。
    const again = await run(ctx, agent, 'forget apply ' + recordIds.join(' '))
    assert.equal(again.kind, 'success')
    assert.match(again.text, /已全部处于遗忘状态/)

    // 读面统一过滤：read 拒绝、recall 查询剔除、history 披露。
    const readDenied = await run(ctx, agent, 'read ' + recordIds[0])
    assert.ok(String(readDenied.text).includes('EFORGOTTEN') || String(readDenied.text).includes('已被主动遗忘'),
      'read 必须拒绝遗忘记录：' + JSON.stringify(readDenied.text))
    const recall = await run(ctx, agent, 'recall 内容')
    assert.equal(recall.kind, 'success')
    assert.match(recall.text, /已软遗忘记录 \d+ 条被剔除/)
    const historyAfter = await run(ctx, agent, 'history')
    assert.match(historyAfter.text, /已软遗忘/)

    // 状态面：操作列表 + 撤销指引。
    const status = await run(ctx, agent, 'forget status')
    assert.equal(status.kind, 'success')
    const opId = /f\d{6}/.exec(status.text)?.[0]
    assert.ok(opId, 'status 必须列出操作ID：' + status.text)

    // 重启不复活：dispose（释放句柄）后新进程形状重进，表面墓碑保持、读面照拦。
    await ctx._dispose()
    const ctx2 = createStubContext()
    await applyPlugin(ctx2)
    const agent2 = agentFor(session)
    const readAfterRestart = await run(ctx2, agent2, 'read ' + recordIds[0])
    assert.ok(String(readAfterRestart.text).includes('EFORGOTTEN') || String(readAfterRestart.text).includes('已被主动遗忘'),
      '重启后仍必须拒绝回读：' + JSON.stringify(readAfterRestart.text))
    const recallAfterRestart = await run(ctx2, agent2, 'recall 内容')
    assert.match(recallAfterRestart.text, /已软遗忘记录 \d+ 条被剔除/)

    // undo：可见性放回，表面回执重建，回读恢复。
    const undo = await run(ctx2, agent2, 'forget undo ' + opId)
    assert.equal(undo.kind, 'success', 'undo 必须成功：' + undo.text)
    assert.match(undo.text, /已撤销遗忘操作/)
    const visibleAfterUndo = visibleText(session)
    assert.ok(visibleAfterUndo.includes('[已归档操作·v2]'), 'undo 后表面必须重建原回执')
    const readRestored = await run(ctx2, agent2, 'read ' + recordIds[0])
    assert.equal(readRestored.kind, 'success', 'undo 后回读必须恢复：' + readRestored.text)

    // 冷库原文全程未动（无物理 GC）。先释放插件句柄再开只读句柄，
    // 规避进程内同目录单句柄约束（store 契约，不是遗忘语义的一部分）。
    await ctx2._dispose()
    const store = await V2SessionStore.open({ labRoot, sessionId: SESSION_ID, readOnly: true })
    try {
      assert.ok(store.recordCount >= recordIds.length, '冷库记录数不得因遗忘减少')
    } finally {
      store.close()
    }
  })
})

test('宽条件两段式：preview 生成计划、apply 凭计划ID、重放已消费计划被拒', async () => {
  await withTempLab('wide', async () => {
    const ctx = createStubContext()
    await applyPlugin(ctx)
    const session = buildSession()
    const agent = agentFor(session)
    await enableAndNarrow(ctx, agent)
    for (let i = 0; i < 2; i += 1) {
      await run(ctx, agent, 'now')
    }
    const preview = await run(ctx, agent, 'forget preview kind=operation')
    assert.equal(preview.kind, 'success', '宽条件 preview 必须成功：' + preview.text)
    const planId = /宽条件目标已生成计划 ([0-9a-f]{16})/.exec(preview.text)?.[1]
    assert.ok(planId, 'preview 必须给出 planId：' + preview.text)

    // 宽条件不允许绕过计划直接 apply。
    const direct = await run(ctx, agent, 'forget apply kind=operation')
    assert.equal(direct.kind, 'error', '宽条件无计划必须拒绝：' + JSON.stringify(direct.text))

    const apply = await run(ctx, agent, 'forget apply ' + planId)
    assert.equal(apply.kind, 'success', '凭计划 apply 必须成功：' + apply.text)
    assert.match(apply.text, /软遗忘已生效/)

    // 计划消费后重放被拒（不重复扩大集合）。
    const replay = await run(ctx, agent, 'forget apply ' + planId)
    assert.equal(replay.kind, 'error', '已消费计划必须拒绝：' + JSON.stringify(replay.text))
    await ctx._dispose()
  })
})

test('恢复守卫：遗忘期间 restore 报告拦截计数，undo 后恢复通路不受影响', async () => {
  await withTempLab('guard', async () => {
    const ctx = createStubContext()
    await applyPlugin(ctx)
    const session = buildSession()
    const agent = agentFor(session)
    await enableAndNarrow(ctx, agent)
    for (let i = 0; i < 2; i += 1) {
      await run(ctx, agent, 'now')
    }
    const history = await run(ctx, agent, 'history')
    const recordIds = [...new Set([...history.text.matchAll(/t\d{8}-r\d{4}/g)].map((m) => m[0]))]
    const apply = await run(ctx, agent, 'forget apply ' + recordIds[0])
    assert.equal(apply.kind, 'success')

    // 遗忘期间 restore：被守卫拦下的行以 forgotten 计数如实披露。
    const restore = await run(ctx, agent, 'restore')
    assert.equal(restore.kind, 'success', 'restore 必须可运行并如实报告：' + JSON.stringify(restore.text))
    assert.ok(String(restore.text).includes('遗忘') || String(restore.text).includes('f000'),
      'restore 报告必须披露遗忘拦截：' + JSON.stringify(restore.text))

    // undo 后再 restore：恢复通路不受影响（行为由 v2-e2e 覆盖，这里只验证不因账本存在而失败）。
    const undo = await run(ctx, agent, 'forget undo f000001')
    assert.equal(undo.kind, 'success', 'undo 必须成功：' + undo.text)
    const restore2 = await run(ctx, agent, 'restore')
    assert.equal(restore2.kind, 'success')
    await ctx._dispose()
  })
})
