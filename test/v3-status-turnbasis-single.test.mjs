/**
 * AUD51-06-03（0.14.0-beta.53）+ P3-08（0.15.1 §3.3）：status 里的「轮次判定」**只出现一次**。
 *
 * ## 缺陷
 * ①（AUD51-06-03）`stateLine`（拼在「· 模式：…」那一行）与 status 的独立「· 轮次判定：…」
 *   行**都**会拼一段轮次判定，于是按轮归档下 status 出现两条「轮次判定」。
 * ②（P3-08）独立行还挂过 `配置值非法，已按 human 运行` 的**死分支提示**——宿主 schema
 *   早已拒绝非法值，这条提示永远不可达；0.15.1 把默认改成 `dsh` 后它还指向一个错误的
 *   「回落值」，属于同一处根因（判据放错层）的两种表现。
 *
 * ## 修法
 * 轮次判定只由 status 的独立行输出（一次），文案取**当前生效值**（默认 `dsh`）；
 * `stateLine` 只保留「模式 / 计划先行 / 停用恢复」这类真正属于状态摘要的事实；
 * `readSettings` 不再产生任何回落标记（见 `v3-turnbasis-enum`）。
 *
 * ## 断言组
 * 1. 默认配置：status 里恰好 1 行含「轮次判定」，内容是 DSH 轮次（默认），且无「配置值非法」；
 * 2. 显式 human：同样恰好 1 行，内容是真人消息，且无「配置值非法」；
 * 3. 回归护栏：stateLine 的输出（/memory-lab mode 的回执）不得再出现「轮次判定」；
 * 4. 死分支护栏：非法的 `'DSH'` 配置下，status **不打印**任何「配置值非法」提示
 *    （非法值在 schema 层就被拒，入口不再撒谎说有运行时回落）。
 *
 * ## 定点变异自证（改回去必红）
 * - 把轮次判定那段加回 `stateLine` → 第 1 组红（出现 2 行）；
 * - 把 `（配置值非法，已按 human 运行）` 拼回独立行 → 第 4 组红。
 * 两次读数见台账 R21。
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
  const hooks = []
  const registered = []
  const ctx = {
    on(name, handler) { hooks.push({ name, handler }); return () => {} },
    effect(fn) { const disposer = fn(); return () => { if (typeof disposer === 'function') disposer() } },
    logger: { warn() {}, info() {} },
    commands: { register(row) { registered.push(row); return () => {} } },
    inject() { return { dispose() {} } },
  }
  return { ctx, hooks, commands: registered }
}

async function withEngine(config, body) {
  const home = await mkdtemp(path.join(tmpdir(), 'mcl-turnbasis-status-'))
  const previousHome = process.env.DSH_HOME
  const previousT2 = process.env.MEMORY_LAB_T2
  process.env.DSH_HOME = home
  process.env.MEMORY_LAB_T2 = '0'
  try {
    const module = await import(pathToFileURL(ENTRY).href + '?t=' + Date.now())
    const { ctx, hooks, commands } = makeCtx()
    await module.apply(ctx, config)
    const ingest = hooks.find((hook) => hook.name === 'agent/pre-step' && hook.opts?.prepend !== true)
    assert.ok(ingest, '摄入钩子必须注册')
    const run = (session, line) => commands[0].handler({ agent: { session }, rawInput: line })
    return await body({ run, ingest, session: () => createFakeSession({ id: 's-turnbasis-' + Math.random().toString(16).slice(2) }) })
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    if (previousT2 === undefined) delete process.env.MEMORY_LAB_T2
    else process.env.MEMORY_LAB_T2 = previousT2
    await rm(home, { recursive: true, force: true }).catch(() => {})
  }
}

/** 让会话摄入并处于按轮归档模式，再取 status 正文（等后台建库完成）。 */
async function statusOf(run, ingest, factory) {
  const session = factory()
  assert.equal((await run(session, 'on')).kind, 'success')
  assert.equal((await run(session, 'mode 按轮归档')).kind, 'success')
  session.pushUser('轮次判定状态行：驱动一次摄入')
  await ingest.handler({ agent: { session }, signal: undefined }, async () => ({ kind: 'enter' }))
  let text = ''
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const status = await run(session, 'status')
    text = status.text
    if (/已摄入 [1-9]/.test(text) && !/后台摄入进行中/.test(text)) break
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return text
}

test('AUD51-06-03 默认 turnBasis：status 只有一条「轮次判定」，且写的是当前生效值', async () => {
  await withEngine({}, async ({ run, ingest, session }) => {
    const text = await statusOf(run, ingest, session)
    const lines = text.split('\n').filter((line) => line.includes('轮次判定'))
    assert.equal(lines.length, 1, '轮次判定只该有一条：' + JSON.stringify(lines))
    // 0.15.1 §1★9：默认值是 dsh；独立行必须如实显示生效值，而不是某个固定的历史默认。
    assert.match(lines[0], /DSH 轮次（默认）/, '默认配置下应显示 DSH 轮次（默认）：' + lines[0])
    assert.equal(text.includes('配置值非法'), false, '合法配置不得出现回落提示')
  })
})

test('AUD51-06-03 显式 human：同样只有一条，且显示真人消息', async () => {
  await withEngine({ turnBasis: 'human' }, async ({ run, ingest, session }) => {
    const text = await statusOf(run, ingest, session)
    const lines = text.split('\n').filter((line) => line.includes('轮次判定'))
    assert.equal(lines.length, 1, '轮次判定只该有一条：' + JSON.stringify(lines))
    assert.match(lines[0], /真人消息/, '显式 human 必须显示真人消息：' + lines[0])
    assert.equal(text.includes('配置值非法'), false, '合法配置不得出现回落提示')
  })
})

test('P3-08 非法 turnBasis：不再打印不可达的「配置值非法」提示', async () => {
  // 'DSH' 在宿主 schema 层就被拒；这里直接调 apply 绕过 schema，模拟「非法值真到了入口」。
  await withEngine({ turnBasis: 'DSH' }, async ({ run, ingest, session }) => {
    const text = await statusOf(run, ingest, session)
    const lines = text.split('\n').filter((line) => line.includes('轮次判定'))
    assert.equal(lines.length, 1, '轮次判定只该有一条：' + JSON.stringify(lines))
    assert.equal(text.includes('配置值非法'), false, 'P3-08：那条提示是死分支，不得再出现')
    assert.match(lines[0], /DSH 轮次（默认）/, '非法值回落当前默认（dsh）：' + lines[0])
  })
})

test('AUD51-06-03 stateLine 不再拼轮次判定（/memory-lab mode 回执）', async () => {
  await withEngine({ turnBasis: 'human' }, async ({ run, ingest, session }) => {
    await statusOf(run, ingest, session)
    const fresh = session()
    assert.equal((await run(fresh, 'on')).kind, 'success')
    const mode = await run(fresh, 'mode 按轮归档')
    assert.equal(mode.kind, 'success', mode.text)
    assert.equal(mode.text.includes('轮次判定'), false, '状态摘要行不得重复轮次判定：' + mode.text)
  })
})
