/**
 * P1-10（0.15.1）：`/memory-lab off` 把「恢复失败」伪装成「无需恢复」。
 *
 * ## 缺陷
 * `engine.restoreHistory` 用**返回值**表达失败（`{error:'not-ready'}`），不是抛错。旧 off 分支
 * 只 catch 抛错、再判 `result.total > 0`（`undefined > 0` 恒 false）→ 恢复失败时回执只剩
 * 「本对话已停用。」，与「没有可恢复的凭证」同形。用户以为「关掉就自动还原了」，而原文
 * 仍在冷库、活动面仍是回执。同族命令 `restore all`（index.mjs 的 restore 分支）一直判
 * `result.error`，两条路径口径不一致。
 *
 * ## 判据来源
 * docs/dev-0.15.1/记忆上下文-0.15.1-独立排查报告.md §1★8 / §3.1 P1-10；
 * 命令面文案与 `restoreFailureLine` 共用（B3-13 已定的措辞）。
 *
 * ## 修法
 * off 分支与 `restore all` 同口径：先判 `result.error` → 复用 `restoreFailureLine` 并标注
 * 「停用仍生效」；再分「恢复 N/M」「没有可恢复的凭证」两态。三结局一一对应，不合并。
 *
 * ## 断言组
 * 1. 引擎未就绪（从未 on）：回执说「恢复不可用 / 记忆库未就绪」且标注「停用仍生效」，
 *    不得出现「恢复：」这种成功形状；
 * 2. autoRestore=false：说「按设置未恢复」，不提失败（那是另一个结局）；
 * 3. 引擎已就绪但零凭证：说「没有可恢复的凭证」，也不说失败。
 *
 * ## 不适用条件与已知边界
 * - 本用例只锁**命令面文案与判据**；`session-lifecycle.disableSession` 的「已恢复 N/M」假账
 *   是 P2-06（未接线路径，待复核处置方式），不在本条范围；
 * - 恢复失败时停用本身仍生效（设计如此），文案明确这一点，不阻止关机。
 *
 * ## 定点变异自证
 * 把 `if (result?.error !== undefined)` 分支删掉（回到只判 total）→ 第 1 条必红；
 * 把「没有可恢复的凭证」删掉（total=0 时留空）→ 第 3 条必红。读数见台账 R1。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { createFakeSession } from './helpers/fake-session.mjs'

const ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.mjs')

function makeCtx() {
  const commands = []
  const hooks = []
  const ctx = {
    on(name, handler, opts) { hooks.push({ name, handler, opts }); return () => {} },
    effect(fn) { const disposer = fn(); return () => { if (typeof disposer === 'function') disposer() } },
    logger: { warn() {}, info() {} },
    inject() { return { dispose() {} } },
    get() { return undefined },
    commands: { register(row) { commands.push(row); return () => {} } },
  }
  return { ctx, commands, hooks }
}

/** 起一个隔离 home + 真实入口，返回 `run(line)` 与可改的 config。 */
async function boot(tag) {
  const home = await mkdtemp(path.join(tmpdir(), 'mcl-p110-' + tag + '-'))
  const previousHome = process.env.DSH_HOME
  const previousT2 = process.env.MEMORY_LAB_T2
  process.env.DSH_HOME = home
  process.env.MEMORY_LAB_T2 = '0'
  const config = {
    enabled: true, limit: 10, packMinScore: 0.5, previewChars: 160, queryMaxChars: 512,
    fullHistory: true, planFirst: false, coolingGate: 20, autoRestore: true,
  }
  const module = await import(pathToFileURL(ENTRY).href + '?t=' + Date.now() + tag)
  const { ctx, commands, hooks } = makeCtx()
  await module.apply(ctx, config)
  const definition = commands[0]
  assert.ok(definition, '必须注册 /memory-lab 命令')
  const session = createFakeSession({ id: 's-off-' + tag })
  session.pushUser('第一轮：原文')
  const run = (line) => definition.handler({ agent: { session }, rawInput: line })
  const cleanup = async () => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    if (previousT2 === undefined) delete process.env.MEMORY_LAB_T2
    else process.env.MEMORY_LAB_T2 = previousT2
    await rm(home, { recursive: true, force: true }).catch(() => {})
  }
  const ingest = () => {
    const row = hooks.find((hook) => hook.name === 'agent/pre-step' && hook.opts?.prepend !== true)
    assert.ok(row, '摄入钩子必须注册')
    return row.handler({ agent: { session }, messages: [], signal: undefined }, async () => ({ kind: 'enter', messages: [] }))
  }
  const waitIngested = async (timeoutMs = 10000) => {
    const started = Date.now()
    for (;;) {
      const status = await run('status')
      if (typeof status.text === 'string' && /已摄入 [1-9]/.test(status.text) && !/后台摄入进行中/.test(status.text)) return status.text
      if (Date.now() - started > timeoutMs) throw new Error('等待摄入超时：' + status.text)
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
  return { run, config, cleanup, ingest, waitIngested }
}

test('P1-10 off：恢复失败必须如实报告（不是「无需恢复」）', async () => {
  const { run, cleanup } = await boot('notready')
  try {
    // 从未 on：引擎未建库 → restoreHistory 返回 {error:'not-ready'}（返回值，不是抛错）
    const off = await run('off')
    assert.equal(off.kind, 'success', off.text)
    assert.match(off.text, /恢复不可用/, '必须说恢复失败：' + off.text)
    assert.match(off.text, /记忆库未就绪/, '必须点出失败码的含义：' + off.text)
    assert.match(off.text, /停用仍生效/, '停用确实生效，文案要说明：' + off.text)
    assert.doesNotMatch(off.text, /恢复：/, '不得出现「恢复：」这种成功/无凭证形状：' + off.text)
  } finally {
    await cleanup()
  }
})

test('P1-10 off：autoRestore=关 时是「按设置未恢复」，不是失败', async () => {
  const { run, config, cleanup } = await boot('setting-off')
  try {
    config.autoRestore = false
    const off = await run('off')
    assert.match(off.text, /按设置未恢复/, '必须说清是用户设置：' + off.text)
    assert.doesNotMatch(off.text, /恢复失败|恢复不可用/, '设置关掉不是故障：' + off.text)
  } finally {
    await cleanup()
  }
})

test('P1-10 off：引擎就绪但零凭证时说「没有可恢复的凭证」', async () => {
  const { run, cleanup, ingest, waitIngested } = await boot('empty')
  try {
    assert.equal((await run('on')).kind, 'success')
    await ingest()
    await waitIngested()
    const off = await run('off')
    assert.equal(off.kind, 'success', off.text)
    assert.match(off.text, /没有可恢复的凭证/, '零凭证要如实说：' + off.text)
    assert.doesNotMatch(off.text, /恢复失败|恢复不可用/, '零凭证不是故障：' + off.text)
  } finally {
    await cleanup()
  }
})
