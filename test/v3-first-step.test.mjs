/**
 * v3 首次挂载不阻塞首字的守卫（H-19，2026-10-26 缺陷排查批）。
 *
 * ## 缺陷
 * pre-step 钩子首次见到某会话时 `await makeRuntime(...)`：open 存储要读全部日志、
 * resumeCheckpointOf 要**逐条记录**读 provenance 文件——O(记录数) 的磁盘活被同步
 * await 在钩子里。实测重启后首个 pre-step：500 条 48ms、2000 条 189ms、5000 条 450ms，
 * 正是 beta.1「钩子阻塞首字」事故的形态（会话越长越慢，且随记录数线性增长）。
 *
 * ## 判据
 * - 重启（新引擎实例）后的首个 pre-step 不随记录数变慢（毫秒级、近似常数）；
 * - 后台建库完成后摄入照常：记录数不丢、断点从库反推（不重放）；
 * - 观察面/检索面（命令路径）能等到建库完成，不因后台化而永远返回 null；
 * - 并发 pre-step 不重复建库。
 *
 * ## 不适用条件与已知边界
 * 只覆盖「首次建库」的调度形态；摄入本身仍是后台异步（2026-10-25 事故修正），不在本判据。
 * 首个 pre-step 不再摄入本步事件，改由建库完成后的那次 ingest 与后续 pre-step 续传——
 * 这是「钩子立即返回」的必然代价，测试显式验证「最终不丢」。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { attachV3Engine } from '../src/v3/entry/v3-entry.mjs'

function makeSession(id) {
  const log = []
  return {
    id,
    log,
    surface: { nodes: [] },
    append() { return { seq: log.length } },
    eventAt() { return undefined },
    deriveMessages() { return [] },
    push() {
      const seq = log.length
      log.push({ seq, type: 'user/message', at: seq, data: { content: [{ type: 'text', text: '正文' + seq }] } })
    },
  }
}

function makeCtx() {
  const handlers = new Map()
  const ctx = {
    on(name, handler) { handlers.set(name, handler); return () => handlers.delete(name) },
    logger: { warn() {}, info() {} },
  }
  ctx.step = async (agent) => handlers.get('agent/pre-step')({ agent, signal: undefined }, async () => ({ kind: 'enter' }))
  return ctx
}

async function withRoot(body) {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-v3-firststep-'))
  try {
    return await body(root)
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
}

test('H-19 重启后首个 pre-step 不阻塞：耗时不随记录数增长（旧：5000 条 450ms）', async () => {
  await withRoot(async (root) => {
    const session = makeSession('s-first')
    for (let i = 0; i < 1500; i += 1) session.push()
    {
      const ctx = makeCtx()
      const engine = attachV3Engine(ctx, { v3Root: root })
      await ctx.step({ session })
      await engine._waitForIdle()
      engine.dispose()
    }
    // 模拟重启：新引擎实例、runtimes 清空
    const ctx = makeCtx()
    const engine = attachV3Engine(ctx, { v3Root: root })
    const started = process.hrtime.bigint()
    await ctx.step({ session })
    const hookMs = Number(process.hrtime.bigint() - started) / 1e6
    assert.ok(hookMs < 20, '首个 pre-step 必须毫秒级返回（实测 ' + hookMs.toFixed(1) + 'ms）')
    await engine._waitForIdle()
    engine.dispose()
  })
})

test('H-19 后台建库后摄入不丢：记录数与事件数一致，且断点从库反推（不重放）', async () => {
  await withRoot(async (root) => {
    const session = makeSession('s-nowrite')
    for (let i = 0; i < 50; i += 1) session.push()
    const ctx = makeCtx()
    const engine = attachV3Engine(ctx, { v3Root: root })
    await ctx.step({ session })   // 本步只触发后台建库
    await engine._waitForIdle()
    const first = await engine.inspect('s-nowrite')
    assert.equal(first.health.recordCount, 50, '首次挂载必须最终把 50 条全部摄入')
    assert.equal(first.lastSeq, 49, '断点必须推进到最后一条')

    // 再走一步：不得重复摄入
    session.push()
    await ctx.step({ session })
    await engine._waitForIdle()
    const second = await engine.inspect('s-nowrite')
    assert.equal(second.health.recordCount, 51, '新事件续传，旧事件不重放')
    engine.dispose()
  })
})

test('H-19 命令面等得到后台建库：inspect/search 不因后台化而返回 null', async () => {
  await withRoot(async (root) => {
    const session = makeSession('s-cmd')
    for (let i = 0; i < 5; i += 1) session.push()
    const ctx = makeCtx()
    const engine = attachV3Engine(ctx, { v3Root: root })
    await ctx.step({ session })
    // 立刻查（建库可能还在飞）：必须等到结果，而不是 null
    const inspected = await engine.inspect('s-cmd')
    assert.notEqual(inspected, null, 'inspect 必须等到建库完成')
    await engine._waitForIdle()
    const hits = await engine.search('s-cmd', '正文')
    assert.ok(Array.isArray(hits.display), 'search 必须等到建库完成并返回结果面')
    engine.dispose()
  })
})

test('H-19 并发 pre-step 不重复建库（记录数不翻倍）', async () => {
  await withRoot(async (root) => {
    const session = makeSession('s-race')
    for (let i = 0; i < 20; i += 1) session.push()
    const ctx = makeCtx()
    const engine = attachV3Engine(ctx, { v3Root: root })
    await Promise.all([ctx.step({ session }), ctx.step({ session }), ctx.step({ session })])
    await engine._waitForIdle()
    const info = await engine.inspect('s-race')
    assert.equal(info.health.recordCount, 20, '并发首次 pre-step 不得重复建库/重复摄入')
    engine.dispose()
  })
})
