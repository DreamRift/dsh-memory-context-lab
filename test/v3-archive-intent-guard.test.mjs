/**
 * R2-01 / R3-02（2026-10-30）：归档提交边界的意图阻断与按身份清理（应用层 + 引擎级）。
 *
 * ## 缺陷（审计 round2 动态复现）
 * surface 已落面而 appendVoucher 失败时，下一次 recover 返回 kept=true 仍继续，
 * 新的 journal.write 覆盖旧意图——两张活动回执最后只剩后一张凭证。
 *
 * ## 修法
 * - commitPlanned 先 `journal.reserve(intent)`（锁内占槽）：槽位被未对账意图占用
 *   （pending）或不可读（unreadable）时返回结构化阻断，不写 intent、不碰宿主面；
 * - 意图带稳定 intentId，占槽/对账/清理全程同一身份；
 * - 入口（archiveForStep）对账后仍见 keptIntent（补凭证失败/清理冲突/不可读）→
 *   暂停本会话新的归档提交，正常对话与只读能力不受影响。
 *
 * ## 断言组
 * A（应用层，真实存储 journal）：
 *  1. 正常归档 archived 且意图已清（清理收到带 intentId 的身份）；
 *  2. 凭证持续失败时反复归档：旧意图字节与 ID 不变，不产生第二张无账回执；
 *  3. 解除故障后对账恰好补一次旧凭证，再允许新归档，history 与回执一一对应；
 *  4. 意图不可读：归档被阻断（intent-unreadable），宿主面与凭证账本不动；
 *  5. 迟到清理与新意图并发：A 的清理不删 B 的意图（conflict 可观测）。
 * B（引擎级，runtimeFactory 注入凭证故障）：
 *  6. pre-step/now 共用路径：凭证失败 → 下一次归档被 intent-pending 阻断；
 *  7. 解除故障后自愈：补一次旧凭证 + 新归档成功；
 *  8. 意图不可读在引擎级阻断（intent-unreadable），清掉后恢复。
 *
 * ## 定点变异自证
 * 把 commitPlanned 的 reserve 分支退回无条件 journal.write → 组 2/6 红（旧意图被覆盖）。
 */
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { join } from 'node:path'

import { createV3Runtime } from '../src/v3/composition/composition.mjs'
import { attachV3Engine } from '../src/v3/entry/v3-entry.mjs'
import { createArchiveService } from '../src/v3/application/archive.mjs'
import { createFakeSession } from './helpers/fake-session.mjs'
import { seqOfDshEventId } from '../src/v3/adapters/host/dsh-host.mjs'
import { textOfDshEvent } from '../src/v3/entry/v3-entry.mjs'
import { sessionIsolationKey } from '../src/v3/domain/session/isolation-key.mjs'
import { archiveIntentPath, clearArchiveIntentIfMatches, readArchiveIntent, reserveArchiveIntent, writeArchiveIntent } from '../src/v3/adapters/storage/archive-intent.mjs'

function buildSeqToRecordId(runtime) {
  return (async () => {
    const seqToRecordId = new Map()
    for (const recordId of await runtime.store.listRecordIds()) {
      const provenance = await runtime.store.readProvenance(recordId)
      const seq = seqOfDshEventId(provenance?.sourceEventId)
      if (seq !== null) seqToRecordId.set(seq, recordId)
    }
    return seqToRecordId
  })()
}

function surfaceFingerprint(session) {
  return session.surface.nodes.map((seq) => seq + ':' + session.textOf(seq)).join('|')
}

// —— A：应用层（真实存储 journal，故障注入在 store.appendVoucher）——

async function withArchiveService(body) {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-v3-intent-guard-'))
  const session = createFakeSession({ cwd: 'C:\\ws', contextWindow: 100000, id: 's-guard' })
  session.pushUser('第一问'.repeat(60))
  session.pushAssistant('第一答'.repeat(60))
  session.pushUser('第二问'.repeat(60))
  session.pushAssistant('第二答'.repeat(60))
  session.pushUser('当前问题'.repeat(10))
  const runtime = await createV3Runtime({ v3Root: root, dshSession: session, sessionKey: 's-guard' })
  try {
    // 摄入（与 v3-journal-clear-sync 同一方式）：无记录就没有可归档的组。
    const rows = session.log.map((event) => ({ event, text: textOfDshEvent(event), meta: {} }))
    await runtime.handleDshEventBatch(rows)
    const seqToRecordId = await buildSeqToRecordId(runtime)
    let failAppend = null
    const realAppend = runtime.store.appendVoucher.bind(runtime.store)
    runtime.store.appendVoucher = async (voucher) => {
      if (failAppend) throw failAppend
      return realAppend(voucher)
    }
    const journal = {
      write: (data) => writeArchiveIntent(root, 's-guard', data),
      reserve: (data) => reserveArchiveIntent(root, 's-guard', data),
      read: () => readArchiveIntent(root, 's-guard'),
      clear: (expected) => clearArchiveIntentIfMatches(root, 's-guard', expected),
    }
    const clearedWith = []
    journal.clear = async (expected) => {
      clearedWith.push(expected?.intentId ?? null)
      return clearArchiveIntentIfMatches(root, 's-guard', expected)
    }
    const archive = () => createArchiveService({ random: { uuid: () => randomUUID() }, store: runtime.store, host: runtime.host, clock: { now: () => 1 }, intent: journal })
    const archiveOnce = async () => archive().archiveOnce({
      sessionId: 's-guard',
      events: session.log,
      surfaceNodes: await runtime.host.surfaceNodes(),
      seqToRecordId,
      mode: 'full-history',
      maxOperations: 1,
    })
    const recover = async () => archive().recoverIntent({
      sessionId: 's-guard',
      surfaceNodes: await runtime.host.surfaceNodes(),
      surfaceTextOf: (seq) => runtime.host.surfaceTextAt(seq),
    })
    return await body({ session, runtime, root, archiveOnce, recover, setFailAppend: (e) => { failAppend = e }, clearedWith })
  } finally {
    runtime.close()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
}

test('A1 正常归档：archived 且意图已清（清理带 intentId 身份）', async () => {
  await withArchiveService(async ({ archiveOnce, clearedWith, root }) => {
    const result = await archiveOnce()
    assert.equal(result.status, 'archived', JSON.stringify(result))
    assert.equal(await readArchiveIntent(root, 's-guard'), null, '成功后槽位必须清空')
    assert.equal(clearedWith.length, 1)
    assert.ok(typeof clearedWith[0] === 'string' && clearedWith[0].length > 0, '清理必须带 intentId 身份')
  })
})

test('A2 凭证持续失败：反复归档不覆盖旧意图、不产生第二张无账回执', async () => {
  await withArchiveService(async ({ archiveOnce, runtime, root, session, setFailAppend }) => {
    setFailAppend(Object.assign(new Error('注入：凭证拒写'), { code: 'EINJECTED' }))
    const first = await archiveOnce()
    assert.equal(first.status, 'failed')
    assert.equal(first.phase, 'voucher')
    const intentAfterFirst = await readArchiveIntent(root, 's-guard')
    assert.ok(intentAfterFirst?.intentId, '失败后意图必须保留')
    const intentBytes = await readFile(archiveIntentPath(root, 's-guard'), 'utf8')
    const vouchersBefore = runtime.store.listVouchers().length
    const surfaceBefore = surfaceFingerprint(session)

    // 反复自动/手动归档：占槽层阻断，宿主面与凭证账本都不动
    for (let i = 0; i < 2; i += 1) {
      const blocked = await archiveOnce()
      assert.equal(blocked.status, 'failed', JSON.stringify(blocked))
      assert.equal(blocked.phase, 'intent', '第 ' + (i + 2) + ' 次归档必须在占槽层被阻断')
      assert.equal(blocked.reason, 'intent-pending')
      assert.equal(surfaceFingerprint(session), surfaceBefore, '阻断路径不得触碰宿主面')
      assert.equal(runtime.store.listVouchers().length, vouchersBefore, '阻断路径不得追加凭证')
      assert.equal(await readFile(archiveIntentPath(root, 's-guard'), 'utf8'), intentBytes, '旧意图字节与 ID 不变')
    }
    assert.equal((await readArchiveIntent(root, 's-guard'))?.intentId, intentAfterFirst.intentId)
  })
})

test('A3 解除故障：对账恰好补一次旧凭证，再允许新归档', async () => {
  await withArchiveService(async ({ archiveOnce, recover, runtime, root, session, setFailAppend }) => {
    setFailAppend(Object.assign(new Error('注入：凭证拒写'), { code: 'EINJECTED' }))
    await archiveOnce()
    setFailAppend(null)
    const recovery = await recover()
    assert.equal(recovery.recovered, true, JSON.stringify(recovery))
    assert.equal(await readArchiveIntent(root, 's-guard'), null, '对账成功后意图必须清掉')
    const afterRecover = runtime.store.listVouchers().length
    // 再对账一次：凭证已在，幂等（不重复补）
    const again = await recover()
    assert.equal(again.recovered, false, '没有未结算意图时对账是 no-op')
    assert.equal(runtime.store.listVouchers().length, afterRecover, '重复对账不得再补凭证')

    const second = await archiveOnce()
    assert.equal(second.status, 'archived', '解除故障后新归档必须放行：' + JSON.stringify(second))
    const vouchers = runtime.store.listVouchers()
    assert.equal(vouchers.length, 2, '旧凭证恰好补一次 + 新归档一张')
    // history 与活动回执一一对应：两张回执都在活动面上
    const surfaceTexts = session.surface.nodes.map((seq) => session.textOf(seq))
    for (const voucher of vouchers) {
      assert.ok(surfaceTexts.some((t) => t === voucher.receiptText), '每张凭证都有对应活动回执')
    }
  })
})

test('A4 意图不可读：归档被阻断（intent-unreadable），面与账本不动', async () => {
  await withArchiveService(async ({ archiveOnce, runtime, root, session }) => {
    await writeFile(archiveIntentPath(root, 's-guard'), '{"intentId":"broken"', 'utf8')
    const vouchersBefore = runtime.store.listVouchers().length
    const surfaceBefore = surfaceFingerprint(session)
    const blocked = await archiveOnce()
    assert.equal(blocked.status, 'failed')
    assert.equal(blocked.phase, 'intent')
    assert.equal(blocked.reason, 'intent-unreadable')
    assert.equal(runtime.store.listVouchers().length, vouchersBefore)
    assert.equal(surfaceFingerprint(session), surfaceBefore)
    assert.equal(await readFile(archiveIntentPath(root, 's-guard'), 'utf8'), '{"intentId":"broken"', '不可读意图不得被覆盖或清除')
  })
})

test('A5 迟到清理与新意图并发：A 的清理不删 B（conflict 可观测）', async () => {
  await withArchiveService(async ({ archiveOnce, runtime, root, setFailAppend }) => {
    setFailAppend(Object.assign(new Error('注入：凭证拒写'), { code: 'EINJECTED' }))
    await archiveOnce()
    const intentA = await readArchiveIntent(root, 's-guard')
    setFailAppend(null)

    // 模拟「A 的清理落地之前，B 已占槽」：clear 时先把槽位换成 B，再按 A 身份清理
    const intentB = { ...intentA, intentId: 'intent-b-late', txn: 2, createdAt: intentA.createdAt + 1 }
    const lateClearArchive = createArchiveService({
      random: { uuid: () => randomUUID() },
      store: runtime.store,
      host: runtime.host,
      clock: { now: () => 1 },
      intent: {
        write: (data) => writeArchiveIntent(root, 's-guard', data),
        reserve: (data) => reserveArchiveIntent(root, 's-guard', data),
        read: () => readArchiveIntent(root, 's-guard'),
        clear: async (expected) => {
          await writeArchiveIntent(root, 's-guard', intentB) // B 抢在 A 的清理之前占槽
          return clearArchiveIntentIfMatches(root, 's-guard', expected)
        },
      },
    })
    const recovered = await lateClearArchive.recoverIntent({
      sessionId: 's-guard',
      surfaceNodes: await runtime.host.surfaceNodes(),
      surfaceTextOf: (seq) => runtime.host.surfaceTextAt(seq),
    })
    assert.equal(recovered.recovered, true, 'A 的凭证照常补上')
    assert.equal(recovered.cleared, false, '清理必须如实报告没删成（不能冒充成功）')
    assert.equal(recovered.clearStatus, 'conflict')
    assert.equal((await readArchiveIntent(root, 's-guard'))?.intentId, 'intent-b-late', 'B 的新意图必须完好')
  })
})

// —— B：引擎级（runtimeFactory 注入凭证故障；pre-step 与 now 共用 archiveForStep）——

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

async function withEngine(body, hooks = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-v3-intent-engine-'))
  const ctx = fakeCtx()
  let failVoucher = null
  const engine = attachV3Engine(ctx, {
    v3Root: root,
    runtimeFactory: async (dshSession, sessionId) => {
      const runtime = await createV3Runtime({ v3Root: root, dshSession, sessionKey: sessionId })
      const realAppend = runtime.store.appendVoucher.bind(runtime.store)
      runtime.store.appendVoucher = async (voucher) => {
        if (failVoucher) throw failVoucher
        return realAppend(voucher)
      }
      if (typeof hooks.onRuntime === 'function') await hooks.onRuntime(runtime)
      return runtime
    },
  })
  const session = createFakeSession({ cwd: 'C:\\ws', contextWindow: 100000, id: 's-eng' })
  try {
    return await body({ ctx, engine, root, session, setFailVoucher: (e) => { failVoucher = e } })
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

test('B1 引擎级：凭证失败后下一次归档被 intent-pending 阻断，自愈后补账再放行', async () => {
  await withEngine(async ({ ctx, engine, root, session, setFailVoucher }) => {
    await ingestTurn(ctx, session, engine, '第一问'.repeat(60), '第一答'.repeat(60))
    await ingestTurn(ctx, session, engine, '第二问'.repeat(60), '第二答'.repeat(60))
    const first = await engine.archiveForStep('s-eng', session, {})
    assert.equal(first.status, 'archived', JSON.stringify(first))
    assert.equal((await engine.historyOf('s-eng')).rows.length, 1)

    setFailVoucher(Object.assign(new Error('注入：凭证拒写'), { code: 'EINJECTED' }))
    await ingestTurn(ctx, session, engine, '第三问'.repeat(60), '第三答'.repeat(60))
    const failing = await engine.archiveForStep('s-eng', session, {})
    assert.equal(failing.status, 'failed')
    assert.equal(failing.phase, 'voucher')
    const intent = await readArchiveIntent(root, 's-eng')
    assert.ok(intent?.intentId, '失败后意图保留')
    const intentBytes = await readFile(archiveIntentPath(root, 's-eng'), 'utf8')
    const surfaceBefore = surfaceFingerprint(session)
    const vouchersBefore = (await engine.historyOf('s-eng')).total

    // 下一次（pre-step 自动或手动 now 同一路径）：阻断，不碰面
    const blocked = await engine.archiveForStep('s-eng', session, {})
    assert.equal(blocked.status, 'failed')
    assert.equal(blocked.phase, 'intent')
    assert.equal(blocked.reason, 'intent-pending')
    assert.equal(surfaceFingerprint(session), surfaceBefore, '阻断路径不得触碰宿主面')
    assert.equal((await engine.historyOf('s-eng')).total, vouchersBefore)
    // P1-07 语义更新：保留期内**允许**追加重试计数（attempts/firstFailedAt/lastFailedAt/
    // lastError），但载荷本身（身份 + 回执正文 + 记录集 + 范围）不得被改写——旧断言用
    // 「整字节相等」表达的正是这一点，现在按载荷比较（字节里的计数是合法的观测增量）。
    const afterBlocked = JSON.parse(await readFile(archiveIntentPath(root, 's-eng'), 'utf8'))
    const stripAccounting = (row) => {
      const { attempts: _attempts, firstFailedAt: _first, lastFailedAt: _last, lastError: _error, ...rest } = row
      return rest
    }
    assert.deepEqual(stripAccounting(afterBlocked), stripAccounting(intent), '旧意图载荷不变（只允许追加重试计数）')
    assert.ok(Number.isInteger(afterBlocked.attempts) && afterBlocked.attempts >= 1, '保留期必须可见重试计数：' + JSON.stringify(afterBlocked.attempts))

    // 解除故障：同一路径先对账补凭证（intent 清空、位点推进）；最新轮仍是「当前轮」，
    // 本轮没有可归档组（no-candidate）——这正是当前轮保护在工作。
    setFailVoucher(null)
    const healed = await engine.archiveForStep('s-eng', session, {})
    assert.equal(healed.status, 'no-candidate', '对账后无未结算意图，最新轮受当前轮保护：' + JSON.stringify(healed))
    assert.equal(await readArchiveIntent(root, 's-eng'), null, '对账后意图必须清空')
    assert.equal((await engine.historyOf('s-eng')).total, 2, '旧凭证恰好补一次（turn1 + 对账补回的 turn2）')
    // R3-01 路径：对账进度经锁内 patch 写入 state，回合级位点推进
    const state = engine.stateOf('s-eng')
    assert.ok(state.surface.lastArchiveEndSeq > 0, '归档位点必须推进：' + JSON.stringify(state.surface))
    // 再来一个完成回合：新归档恢复放行
    await ingestTurn(ctx, session, engine, '第四问'.repeat(60), '第四答'.repeat(60))
    const next = await engine.archiveForStep('s-eng', session, {})
    assert.equal(next.status, 'archived', JSON.stringify(next))
    assert.equal((await engine.historyOf('s-eng')).total, 3, '对账补回 1 张 + turn3 新归档 1 张 = 3')
  })
})

test('B2 引擎级：意图不可读阻断新归档，清掉后恢复', async () => {
  await withEngine(async ({ ctx, engine, root, session }) => {
    await ingestTurn(ctx, session, engine, '第一问'.repeat(60), '第一答'.repeat(60))
    await ingestTurn(ctx, session, engine, '第二问'.repeat(60), '第二答'.repeat(60))
    assert.equal((await engine.archiveForStep('s-eng', session, {})).status, 'archived')

    const intentPath = archiveIntentPath(root, 's-eng')
    await writeFile(intentPath, '{"intentId":"broken"', 'utf8')
    const surfaceBefore = surfaceFingerprint(session)
    const vouchersBefore = (await engine.historyOf('s-eng')).total
    const blocked = await engine.archiveForStep('s-eng', session, {})
    assert.equal(blocked.status, 'failed')
    assert.equal(blocked.phase, 'intent')
    assert.equal(blocked.reason, 'intent-unreadable', JSON.stringify(blocked))
    assert.equal(surfaceFingerprint(session), surfaceBefore)
    assert.equal((await engine.historyOf('s-eng')).total, vouchersBefore)
    assert.equal(await readFile(intentPath, 'utf8'), '{"intentId":"broken"')

    // 清掉坏意图（身份未知，只能整文件移除——用户/运维显式动作）：归档恢复。
    // 最新轮仍是「当前轮」，先补一个完成回合再验证放行。
    await rm(intentPath, { force: true })
    await ingestTurn(ctx, session, engine, '第三问'.repeat(60), '第三答'.repeat(60))
    const healed = await engine.archiveForStep('s-eng', session, {})
    assert.equal(healed.status, 'archived', JSON.stringify(healed))
    assert.equal((await engine.historyOf('s-eng')).total, 2)
  })
})
test('B3 意图在两次读取之间被清掉：不得误报 keptIntent 白挡一步（R2-01b）', async () => {
  // 入口先读一次 intent（有），随后对账服务再读时它已被另一进程清掉
  // （recovered=false 且没有 cleared 字段）。旧判据由 recovered/cleared 两个布尔推演，
  // 算出 keptIntent=true → 白挡一步归档；新判据直接读槽位现状 → 槽位空 → 不阻断。
  const state = { arm: false, fired: false }
  await withEngine(async ({ ctx, engine, root, session, setFailVoucher }) => {
    await ingestTurn(ctx, session, engine, '第一问'.repeat(60), '第一答'.repeat(60))
    await ingestTurn(ctx, session, engine, '第二问'.repeat(60), '第二答'.repeat(60))
    setFailVoucher(Object.assign(new Error('注入：凭证拒写'), { code: 'EINJECTED' }))
    const failing = await engine.archiveForStep('s-eng', session, {})
    assert.equal(failing.status, 'failed')
    assert.equal(failing.phase, 'voucher')
    assert.ok((await readArchiveIntent(root, 's-eng'))?.intentId, '失败后意图保留')

    setFailVoucher(null)
    state.arm = true // 从这一次起：入口读完意图、服务再读之前把槽位清掉
    const after = await engine.archiveForStep('s-eng', session, {})
    assert.equal(state.fired, true, '夹具必须真的插进「两次读取之间」')
    assert.notEqual(after.reason, 'intent-pending', '槽位已空时不得按 pending 阻断：' + JSON.stringify(after))
    assert.equal(await readArchiveIntent(root, 's-eng'), null)

    // 自愈后照常归档：再来一个完成回合
    await ingestTurn(ctx, session, engine, '第三问'.repeat(60), '第三答'.repeat(60))
    const next = await engine.archiveForStep('s-eng', session, {})
    assert.ok(['archived', 'no-candidate'].includes(next.status), JSON.stringify(next))
  }, {
    onRuntime: async (runtime) => {
      const realNodes = runtime.host.surfaceNodes.bind(runtime.host)
      runtime.host.surfaceNodes = async () => {
        if (state.arm && !state.fired) {
          state.fired = true
          await rm(path.join(runtime.store.directory, 'archive-intent.json'), { force: true })
        }
        return realNodes()
      }
    },
  })
})
