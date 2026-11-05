/**
 * B-2（2026-10-31 审计后续）：status 的「下一次归档」对齐 pending intent。
 *
 * ## 缺陷
 * dryRunArchive 只跑选择器、不看槽位：槽位压着未对账意图时，status 仍显示
 * 「下一次归档：seq X–Y（可归档）」，而真实提交会被锁内占槽挡下（intent-pending）
 * ——预览与实际自相矛盾。
 *
 * ## 修法
 * archive-intent 抽出只读 peekArchiveIntent，与 reserveArchiveIntent 共用同一分类判据
 * （classifyArchiveIntent 唯一实现，判据同源）；dryRunArchive 在 paused 之后、选 span
 * 之前插 peek：pending/invalid → intent-pending，unreadable → intent-unreadable。
 * peek 禁止副作用（不写盘、不补账、不清理）。
 *
 * ## 断言组
 * 1. 槽位压着未对账意图（凭证故障真实路径，与 v3-archive-intent-guard B1 同源）：
 *    dryRunArchive 返回 intent-pending；archiveLine 文本含「暂停」且不含「可归档」；
 * 2. 意图文件不可读（目录占位注入读错误，win32/POSIX 同形）：返回 intent-unreadable，
 *    文本含「不可读」；
 * 3. 槽位为空：行为与本批之前完全一致（planned 候选 + peek 零副作用回归保护）。
 *
 * ## 定点变异自证
 * 删掉 dryRunArchive 的 peek 分支 → 第 1、2 条必红（预览回到 planned）；复原 → 全绿。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createV3Runtime } from '../src/v3/composition/composition.mjs'
import { attachV3Engine } from '../src/v3/entry/v3-entry.mjs'
import { createFakeSession } from './helpers/fake-session.mjs'
import { archiveIntentPath, readArchiveIntent } from '../src/v3/adapters/storage/archive-intent.mjs'
import { archiveLine } from '../src/index.mjs'

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
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-v3-status-peek-'))
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
  const session = createFakeSession({ cwd: 'C:\\ws', contextWindow: 100000, id: 's-peek' })
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

test('P1 槽位压着未对账意图：预览返回 intent-pending，文本暂停且不说「可归档」', async () => {
  await withEngine(async ({ ctx, engine, root, session, runtime }) => {
    await ingestTurn(ctx, session, engine, '第一问'.repeat(60), '第一答'.repeat(60))
    await ingestTurn(ctx, session, engine, '第二问'.repeat(60), '第二答'.repeat(60))
    const ok = await engine.archiveForStep('s-peek', session, {})
    assert.equal(ok.status, 'archived', JSON.stringify(ok))

    // 真实路径造 pending 槽（与 v3-archive-intent-guard B1 同一注入点）：凭证拒写 →
    // surface 已替换、voucher 失败 → intent 留槽。
    const rt = runtime()
    const realAppend = rt.store.appendVoucher.bind(rt.store)
    rt.store.appendVoucher = async () => {
      throw Object.assign(new Error('注入：凭证拒写'), { code: 'EINJECTED' })
    }
    try {
      await ingestTurn(ctx, session, engine, '第三问'.repeat(60), '第三答'.repeat(60))
      const failing = await engine.archiveForStep('s-peek', session, {})
      assert.equal(failing.status, 'failed', JSON.stringify(failing))
      assert.equal((await readArchiveIntent(root, 's-peek'))?.intentId != null, true, 'intent 留槽')
    } finally {
      rt.store.appendVoucher = realAppend
    }

    const preview = await engine.dryRunArchive('s-peek', session, {})
    assert.equal(preview.status, 'intent-pending', JSON.stringify(preview))
    const line = archiveLine(preview)
    assert.ok(line.includes('暂停'), 'status 文本含「暂停」：' + line)
    assert.equal(line.includes('可归档'), false, 'status 文本不得再说「可归档」：' + line)
    // peek 只读：槽位原样
    const intentId = (await readArchiveIntent(root, 's-peek'))?.intentId
    assert.ok(typeof intentId === 'string' && intentId.length > 0, '槽位意图仍在')
  })
})

test('P2 意图文件不可读：预览返回 intent-unreadable，文本含「不可读」', async () => {
  await withEngine(async ({ ctx, engine, root, session }) => {
    await ingestTurn(ctx, session, engine, '第一问'.repeat(60), '第一答'.repeat(60))
    await ingestTurn(ctx, session, engine, '第二问'.repeat(60), '第二答'.repeat(60))
    const ok = await engine.archiveForStep('s-peek', session, {})
    assert.equal(ok.status, 'archived', JSON.stringify(ok))

    // 不可读注入（跨平台）：把意图路径换成目录——readFile 得到 EISDIR，
    // 与 EACCES 同属「读错误 ≠ ENOENT」一类（分类器 unreadable 态）。
    const intentPath = archiveIntentPath(root, 's-peek')
    await mkdir(intentPath, { recursive: true })
    try {
      const preview = await engine.dryRunArchive('s-peek', session, {})
      assert.equal(preview.status, 'intent-unreadable', JSON.stringify(preview))
      const line = archiveLine(preview)
      assert.ok(line.includes('不可读'), 'status 文本含「不可读」：' + line)
      assert.equal(line.includes('可归档'), false, 'status 文本不得说「可归档」：' + line)
    } finally {
      await rm(intentPath, { recursive: true, force: true }).catch(() => {})
    }
    // 解除后回到常态预览（不残留失败关闭态）
    const preview = await engine.dryRunArchive('s-peek', session, {})
    assert.notEqual(preview.status, 'intent-unreadable', JSON.stringify(preview))
  })
})

test('P3 槽位为空：预览与本批之前一致（planned 候选），peek 零副作用', async () => {
  await withEngine(async ({ ctx, engine, root, session }) => {
    await ingestTurn(ctx, session, engine, '第一问'.repeat(60), '第一答'.repeat(60))
    await ingestTurn(ctx, session, engine, '第二问'.repeat(60), '第二答'.repeat(60))
    const before = (await engine.historyOf('s-peek')).total
    const preview = await engine.dryRunArchive('s-peek', session, {})
    assert.equal(preview.status, 'planned', JSON.stringify(preview))
    assert.ok(Number.isInteger(preview.startSeq) && Number.isInteger(preview.endSeq), '候选 span 完整：' + JSON.stringify(preview))
    const line = archiveLine(preview)
    assert.ok(line.includes('候选'), '回归保护：候选文案不变：' + line)
    assert.equal(line.includes('暂停'), false, '无意图时不得误报暂停：' + line)
    // peek 零副作用：槽位仍空、凭证未增
    assert.equal(await readArchiveIntent(root, 's-peek'), null, 'peek 不得写槽位')
    assert.equal((await engine.historyOf('s-peek')).total, before, 'peek 不得追加凭证')
  })
})
