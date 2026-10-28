/**
 * 0.14.0-beta.44：停用恢复（autoRestore）必须读**当前全局设置**，不能读建库时冻结的 state。
 *
 * 0.14.0-beta.43 的真实故障：ensureStateSnapshot 把 lastSeq>=0 的会话强制
 * autoRestore=true，off 又只读 state.autoRestore；设置页关掉「停用恢复」后，
 * 已有会话仍会按 16000 字符窗口恢复原文。
 *
 * 本用例走真实入口 + 真实引擎 + 真实 off 命令，不是只测纯函数。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { createFakeSession } from './helpers/fake-session.mjs'

const ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.mjs')

function makeCtx() {
  const hooks = []
  const commands = []
  const ctx = {
    on(name, handler, opts) { hooks.push({ name, handler, opts }); return () => {} },
    effect(fn) { const disposer = fn(); return () => { if (typeof disposer === 'function') disposer() } },
    logger: { warn() {}, info() {} },
    inject() { return { dispose() {} } },
    get() { return undefined },
    commands: { register(row) { commands.push(row); return () => {} } },
  }
  return { ctx, hooks, commands }
}

async function waitIngested(run, sessionId, timeoutMs = 10000) {
  const started = Date.now()
  for (;;) {
    const status = await run('status')
    if (typeof status.text === 'string' && /已摄入 [1-9]/.test(status.text) && !/后台摄入进行中/.test(status.text)) return status.text
    if (Date.now() - started > timeoutMs) throw new Error('等待摄入超时：' + status.text)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

test('off 读当前全局 autoRestore：会话建库后再改设置也生效', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'mcl-autorestore-'))
  const previousHome = process.env.DSH_HOME
  const previousT2 = process.env.MEMORY_LAB_T2
  process.env.DSH_HOME = home
  process.env.MEMORY_LAB_T2 = '0'
  try {
    const config = {
      enabled: true, limit: 10, packMinScore: 0.5, previewChars: 160, queryMaxChars: 512,
      fullHistory: true, planFirst: false, coolingGate: 20, autoRestore: true,
    }
    const module = await import(pathToFileURL(ENTRY).href + '?t=' + Date.now())
    const { ctx, hooks, commands } = makeCtx()
    await module.apply(ctx, config)
    const definition = commands[0]
    const session = createFakeSession({ id: 's-auto' })
    session.pushUser('第一轮：请记住这段原文')
    session.append('assistant/message', { turn: 1, step: 1, message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: '需要被恢复的原文' + '甲'.repeat(400) }] } })
    session.append('step/end', { turn: 1, step: 1 })
    session.pushUser('第二轮：继续')
    session.append('assistant/message', { turn: 2, step: 1, message: { id: 'a2', role: 'assistant', content: [{ type: 'text', text: 'ok' }] } })
    const run = (line) => definition.handler({ agent: { session }, rawInput: line })

    assert.equal((await run('on')).kind, 'success')
    const ingest = hooks.find((row) => row.name === 'agent/pre-step' && row.opts?.prepend !== true)
    assert.ok(ingest, '摄入钩子必须注册')
    await ingest.handler({ agent: { session }, messages: [], signal: undefined }, async () => ({ kind: 'enter', messages: [] }))
    await waitIngested(run, 's-auto')

    const archived = await run('now')
    assert.equal(archived.kind, 'success', archived.text)
    assert.match(archived.text, /已归档 seq/)
    const root = path.join(home, '.memory-context-lab', 'v3', 'sessions', 's-auto')
    const vouchers = (await readFile(path.join(root, 'vouchers.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
    const receiptSeq = vouchers.at(-1).targetEventId
    const receiptText = session.textOf(receiptSeq)
    assert.match(receiptText, /^\[记忆上下文\]/)

    // 建库之后把全局设置改成 false：off 必须**跳过恢复**，回执保持原样。
    config.autoRestore = false
    const surfaceTexts = () => session.surface.nodes.map((seq) => session.textOf(seq))
    const off = await run('off')
    assert.equal(off.kind, 'success', off.text)
    assert.match(off.text, /按设置未恢复/, '关闭恢复时必须说清是「按设置」，不是「没有可恢复」')
    assert.ok(surfaceTexts().includes(receiptText), 'autoRestore=false 时回执必须保持原样')

    // 再改回 true：off 必须恢复原文。restore 会 replace 出新节点，不能只看旧回执 seq。
    assert.equal((await run('on')).kind, 'success')
    config.autoRestore = true
    const off2 = await run('off')
    assert.equal(off2.kind, 'success', off2.text)
    assert.match(off2.text, /恢复：1\/1/, 'autoRestore=true 时必须回报真实恢复计数')
    assert.equal(surfaceTexts().includes(receiptText), false, 'autoRestore=true 时回执应被原文替换')
    assert.ok(surfaceTexts().some((text) => text.includes('需要被恢复的原文')), '必须恢复出原文')
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    if (previousT2 === undefined) delete process.env.MEMORY_LAB_T2
    else process.env.MEMORY_LAB_T2 = previousT2
    await rm(home, { recursive: true, force: true }).catch(() => {})
  }
})
