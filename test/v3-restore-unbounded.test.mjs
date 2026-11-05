/**
 * 无预算恢复守卫（0.14.0-beta.52，用户拍板）。
 *
 * ## 变更
 * - 归档**不再**按恢复体积拒绝：restoreChars 只作为凭证观测值；
 * - 恢复**不再**有 maxChars 上限：超上下文交给宿主压缩（DSH 自身机制）；
 * - 设置项 restoreMaxChars 移除，readSettings 不再产出该键；
 * - 命令面不再有 restore-too-large；receipt-changed 给出「被吸收、按 ID 回读」的指引。
 *
 * ## 断言组
 * - 恢复体积 18,000 字（旧默认 16k）的完成轮照常归档；
 * - restore 返回完整文本（无截断、无 too-large）；
 * - dry-run 不再出现 restore-budget-exceeded；
 * - readSettings 不再带 restoreMaxChars；archiveLine 不再有超预算文案；
 * - receipt-changed 文案说明吸收与按 ID 回读。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { attachV3Engine } from '../src/v3/entry/v3-entry.mjs'
import { readSettings, archiveLine, restoreFailureLine } from '../src/index.mjs'
import { createFakeSession } from './helpers/fake-session.mjs'

function fakeCtx() {
  const handlers = new Map()
  const warnings = []
  const ctx = {
    warnings,
    on(name, handler) { handlers.set(name, handler); return () => handlers.delete(name) },
    logger: { warn: (m) => warnings.push(m), info() {} },
  }
  ctx.callPreStep = async (session) => {
    const handler = handlers.get('agent/pre-step')
    if (!handler) throw new Error('未注册 pre-step')
    return await handler({ agent: { session }, signal: undefined }, async () => ({ kind: 'enter' }))
  }
  return ctx
}

async function settle(engine) {
  await new Promise((resolve) => setTimeout(resolve, 150))
  await engine._waitForIdle().catch(() => {})
  await new Promise((resolve) => setTimeout(resolve, 50))
}

const USER_TEXT = '问'.repeat(4000)
const ASSISTANT_TEXT = '答'.repeat(14000)

async function withEngine(body) {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-unbounded-'))
  const ctx = fakeCtx()
  const engine = attachV3Engine(ctx, { v3Root: root })
  try {
    return await body({ ctx, engine, root })
  } finally {
    await engine._waitForIdle().catch(() => {})
    engine.dispose()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
}

test('beta.52 恢复体积不再阻止归档：18,000 字完成轮照常归档', async () => {
  await withEngine(async ({ ctx, engine }) => {
    const session = createFakeSession({ cwd: 'C:\\ws' })
    session.pushUser(USER_TEXT)
    session.pushAssistant(ASSISTANT_TEXT)
    session.pushUser('当前问题')
    await ctx.callPreStep(session)
    await settle(engine)

    const before = await session.surface.nodes
    const result = await engine.archiveForStep('session-fake', session, {})
    assert.equal(result.status, 'archived', JSON.stringify(result))
    assert.equal(result.recordIds.length > 0, true)
    assert.ok(Number.isInteger(result.receiptSeq), '归档必须落下回执节点：' + JSON.stringify(result))
    const history = await engine.historyOf('session-fake')
    assert.equal(history.total, 1)
    assert.equal(history.rows[0].restoreChars, USER_TEXT.length + ASSISTANT_TEXT.length, '凭证仍携带恢复体积观测值')
    assert.deepEqual(ctx.warnings, [], '归档不得因体积告警')
  })
})

test('beta.52 恢复不设上限：一次恢复完整文本', async () => {
  await withEngine(async ({ ctx, engine }) => {
    const session = createFakeSession({ cwd: 'C:\\ws' })
    session.pushUser(USER_TEXT)
    session.pushAssistant(ASSISTANT_TEXT)
    session.pushUser('当前问题')
    await ctx.callPreStep(session)
    await settle(engine)
    const archived = await engine.archiveForStep('session-fake', session, {})
    assert.equal(archived.status, 'archived', JSON.stringify(archived))

    const restored = await engine.restoreHistory('session-fake', { index: 0 })
    assert.equal(restored.restored, true, JSON.stringify(restored))
    // restore 把各记录正文用连接符拼接：18,000 + 2。
    assert.equal(restored.chars, USER_TEXT.length + 2 + ASSISTANT_TEXT.length)
    assert.equal(restored.maxChars, undefined, '不再返回 maxChars')
    assert.equal(restored.reason, undefined, '不再有 restore-too-large')
  })
})

test('beta.52 dry-run 不再出现 restore-budget-exceeded', async () => {
  await withEngine(async ({ ctx, engine }) => {
    const session = createFakeSession({ cwd: 'C:\\ws' })
    session.pushUser(USER_TEXT)
    session.pushAssistant(ASSISTANT_TEXT)
    session.pushUser('当前问题')
    await ctx.callPreStep(session)
    await settle(engine)
    const preview = await engine.dryRunArchive('session-fake', session, {})
    assert.notEqual(preview.reason, 'restore-budget-exceeded', JSON.stringify(preview))
    assert.ok(Number.isInteger(preview.startSeq), '预览应给出候选 span：' + JSON.stringify(preview))
  })
})

test('beta.52 设置与文案：restoreMaxChars 移除、预算文案消失、receipt-changed 有指引', () => {
  const settings = readSettings({ restoreMaxChars: 50000 })
  assert.equal(Object.hasOwn(settings, 'restoreMaxChars'), false, '设置面不再产出 restoreMaxChars')
  const line = archiveLine({ status: 'no-candidate', reason: 'restore-budget-exceeded', chars: 18000, maxChars: 16000 })
  assert.equal(line.includes('恢复体积超预算'), false, '不再有超预算文案：' + line)
  assert.ok(line.includes('暂无可归档'), line)
  const changed = restoreFailureLine({ restored: false, reason: 'receipt-changed' }, 0)
  // 0.14.0-beta.53：回执吸收已停用（AUD51-05-02），文案不再归因「被吸收」，改说判据（逐字节比对失败）。
  assert.ok(changed.includes('逐字节'), 'receipt-changed 要说明判据是回执正文逐字节比对：' + changed)
  assert.ok(changed.includes('ID'), 'receipt-changed 要指引按 ID 回读：' + changed)
})
