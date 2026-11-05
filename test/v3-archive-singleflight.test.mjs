/**
 * B-1（2026-10-31 审计后续）归档单飞：同一进程内同一会话的归档同时只允许一个在跑。
 *
 * ## 缺陷
 * entry.inflight 只挡摄入，挡不住 /memory-lab now 与 pre-step 同时进入 archiveForStep；
 * 两路并跑会在占槽层撞出一条 intent-pending 失败（无数据损坏，但用户看到一条 failed 噪音），
 * 或对同一 span 二次归档留下意图等下一步对账。
 *
 * ## 修法
 * archiveForStep 变成单飞包装：entry.archiveInflight 非空即拒（archive-busy，不排队），
 * runArchiveForStep 是原主体；try/finally 保证抛错也清闸。dryRunArchive 不加单飞
 * （status 只读必须永远能答）。单飞只覆盖本进程，跨进程仍由占槽兜底（本套件第 4 条钉死）。
 *
 * ## 断言组
 * 1. Promise.all 两次归档：恰好 1 archived + 1 archive-busy，活动面只多一张回执；
 * 2. 单飞期间槽位 absent：busy 不产生 intent，释放后正常归档并清槽；
 * 3. busy/抛错后可恢复：archived 后再调不得 busy；runArchiveForStep 抛错后 finally 清闸、
 *    下一次调用正常归档（try/finally 反向守卫点）；
 * 4. 跨进程仍由占槽兜底：单飞挂起窗口内，外来 reserveArchiveIntent 被**占槽**挡住
 *    （pending，身份不被覆盖）——单飞没有越权替代占槽。
 *
 * ## 定点变异自证
 * 删掉 wrapper 的 if (entry.archiveInflight !== null) 一行 → 第 1 条必红；
 * 把 try/finally 改成裸 await → 第 3 条的抛错子断言必红（永久 busy）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createV3Runtime } from '../src/v3/composition/composition.mjs'
import { attachV3Engine } from '../src/v3/entry/v3-entry.mjs'
import { createFakeSession } from './helpers/fake-session.mjs'
import { readArchiveIntent, reserveArchiveIntent } from '../src/v3/adapters/storage/archive-intent.mjs'

function fakeCtx() {
  const handlers = new Map()
  const ctx = {
    on(name, handler) { handlers.set(name, handler); return () => handlers.delete(name) },
    logger: { warn() {}, info() {} },
  }
  ctx.callPreStep = async (agent) => {
    const handler = handlers.get('agent/pre-step')
    if (!handler) throw new Error('未注册 pre-step')
    return await handler({ agent, signal: undefined }, async () => ({ kind: 'enter' }))
  }
  return ctx
}

async function withEngine(body) {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-v3-singleflight-'))
  const ctx = fakeCtx()
  let runtimeRef = null
  const engine = attachV3Engine(ctx, {
    v3Root: root,
    runtimeFactory: async (dshSession, sessionId) => {
      const runtime = await createV3Runtime({ v3Root: root, dshSession, sessionKey: sessionId })
      runtimeRef = runtime
      return runtime
    },
  })
  const session = createFakeSession({ cwd: 'C:\\ws', contextWindow: 100000, id: 's-sf' })
  try {
    return await body({ ctx, engine, root, session, runtime: () => runtimeRef })
  } finally {
    await engine._waitForIdle().catch(() => {})
    engine.dispose()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
}

async function ingestTurn(ctx, session, engine, userText, replyText) {
  session.pushUser(userText)
  session.pushAssistant(replyText)
  await ctx.callPreStep({ session })
  await engine._waitForIdle()
}

test('S1 并发两次归档：恰好 1 archived + 1 archive-busy，只多一张回执', async () => {
  await withEngine(async ({ ctx, engine, session }) => {
    await ingestTurn(ctx, session, engine, '第一问'.repeat(60), '第一答'.repeat(60))
    await ingestTurn(ctx, session, engine, '第二问'.repeat(60), '第二答'.repeat(60))
    const [a, b] = await Promise.all([
      engine.archiveForStep('s-sf', session, {}),
      engine.archiveForStep('s-sf', session, {}),
    ])
    const statuses = [a.status, b.status].sort()
    assert.deepEqual(statuses, ['archive-busy', 'archived'], JSON.stringify([a, b]))
    assert.equal((await engine.historyOf('s-sf')).total, 1, '活动面只多一张回执（一张凭证）')
  })
})

test('S2 单飞期间槽位 absent：busy 不产生 intent，释放后正常归档并清槽', async () => {
  await withEngine(async ({ ctx, engine, root, session, runtime }) => {
    await ingestTurn(ctx, session, engine, '第一问'.repeat(60), '第一答'.repeat(60))
    await ingestTurn(ctx, session, engine, '第二问'.repeat(60), '第二答'.repeat(60))
    const rt = runtime()
    const realNodes = rt.host.surfaceNodes.bind(rt.host)
    let release
    const gate = new Promise((resolve) => { release = resolve })
    // 闸在 surfaceNodes（选择之前、占槽之前）：挂起窗口内任何一方都不该写意图。
    rt.host.surfaceNodes = async () => { await gate; return realNodes() }
    try {
      const inFlight = engine.archiveForStep('s-sf', session, {})
      await new Promise((resolve) => setTimeout(resolve, 30)) // 让 inFlight 挂到闸上
      const busy = await engine.archiveForStep('s-sf', session, {})
      assert.equal(busy.status, 'archive-busy', JSON.stringify(busy))
      assert.equal(await readArchiveIntent(root, 's-sf'), null, 'busy 不得产生意图（槽位 absent）')
      release()
      const done = await inFlight
      assert.equal(done.status, 'archived', JSON.stringify(done))
    } finally {
      release?.()
      rt.host.surfaceNodes = realNodes
    }
    assert.equal(await readArchiveIntent(root, 's-sf'), null, '归档完成后槽位清空')
    assert.equal((await engine.historyOf('s-sf')).total, 1)
  })
})

test('S3 busy/抛错后可恢复：archived 后再调不得 busy；抛错后 finally 清闸', async () => {
  await withEngine(async ({ ctx, engine, session, runtime }) => {
    await ingestTurn(ctx, session, engine, '第一问'.repeat(60), '第一答'.repeat(60))
    await ingestTurn(ctx, session, engine, '第二问'.repeat(60), '第二答'.repeat(60))
    const first = await engine.archiveForStep('s-sf', session, {})
    assert.equal(first.status, 'archived', JSON.stringify(first))
    // 正常路径：上一次调用结束后闸必须已清（finally），下一次照常评估（当前轮保护 → no-candidate）。
    const second = await engine.archiveForStep('s-sf', session, {})
    assert.notEqual(second.status, 'archive-busy', JSON.stringify(second))
    assert.equal(['no-candidate', 'not-worth'].includes(second.status), true, JSON.stringify(second))

    // 抛错路径：runArchiveForStep 异常逃逸时 wrapper 的 finally 必须清闸，否则永久 busy。
    const rt = runtime()
    const realNodes = rt.host.surfaceNodes.bind(rt.host)
    rt.host.surfaceNodes = async () => {
      throw Object.assign(new Error('注入：surface 读取失败'), { code: 'EINJECTED' })
    }
    try {
      await assert.rejects(() => engine.archiveForStep('s-sf', session, {}), (error) => error?.code === 'EINJECTED')
    } finally {
      rt.host.surfaceNodes = realNodes
    }
    const third = await engine.archiveForStep('s-sf', session, {})
    assert.notEqual(third.status, 'archive-busy', '抛错后必须可恢复（try/finally 清闸）：' + JSON.stringify(third))
  })
})

test('S4 跨进程仍由占槽兜底：单飞窗口内外来占槽被槽位挡住（pending），单飞不越权', async () => {
  await withEngine(async ({ ctx, engine, root, session, runtime }) => {
    await ingestTurn(ctx, session, engine, '第一问'.repeat(60), '第一答'.repeat(60))
    await ingestTurn(ctx, session, engine, '第二问'.repeat(60), '第二答'.repeat(60))
    const rt = runtime()
    const realSurfaceOp = rt.host.surfaceOp.bind(rt.host)
    let release
    const gate = new Promise((resolve) => { release = resolve })
    // 闸在 surfaceOp（占槽之后、凭证之前）：窗口内意图在槽、会话锁空闲——正是
    // 跨进程写入者会到达的状态。单飞是本进程内存闸，挡不住也不该挡住它。
    rt.host.surfaceOp = async (op) => { await gate; return realSurfaceOp(op) }
    try {
      const inFlight = engine.archiveForStep('s-sf', session, {})
      let intent = null
      for (let i = 0; i < 100 && intent === null; i += 1) {
        intent = await readArchiveIntent(root, 's-sf')
        if (intent === null) await new Promise((resolve) => setTimeout(resolve, 10))
      }
      assert.ok(intent?.intentId, '窗口内意图已占槽：' + JSON.stringify(intent))
      const foreign = {
        schemaVersion: 1,
        intentId: 'intent-foreign-x',
        sessionId: 's-sf',
        mode: 'full-history',
        txn: 1,
        startSeq: 0,
        endSeq: 0,
        sourceEventSeqs: [],
        recordIds: [],
        receiptText: '外来写入者',
        createdAt: 1,
      }
      const blocked = await reserveArchiveIntent(root, 's-sf', foreign)
      assert.equal(blocked.ok, false, JSON.stringify(blocked))
      assert.equal(blocked.status, 'pending', '跨进程写入者由占槽挡住（不是被单飞挡住）')
      assert.equal(blocked.existing?.intentId, intent.intentId, '外来者看到的是在飞意图的身份')
      release()
      const done = await inFlight
      assert.equal(done.status, 'archived', JSON.stringify(done))
    } finally {
      release?.()
      rt.host.surfaceOp = realSurfaceOp
    }
    assert.equal(await readArchiveIntent(root, 's-sf'), null, '归档完成后按身份清槽')
    assert.equal((await engine.historyOf('s-sf')).total, 1, '恰好一张凭证')
  })
})
