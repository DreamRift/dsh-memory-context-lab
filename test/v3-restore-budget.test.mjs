/**
 * 恢复预算守卫（AUD50-02-02，B1-2：归档前不校验恢复预算，超限凭证永远不可恢复）。
 *
 * ## 缺陷
 * makePlan 只按正文算净收益，恢复体积（restoreTextOfRecord = 正文 + toolCalls 参数）
 * 从不在归档前校验；16000 字预算写死在 index.mjs 调用点。净收益为正但恢复体积超预算
 * 的回合照常写凭证、替换活动面——事后 restore 永远 restore-too-large，原文只能靠
 * 会话日志按 ID 回读。超限发生在「归档后」，status 里看不到任何预兆。
 *
 * ## 判据来源
 * docs/dev-0.14.0/审计-0.14.0-beta.50-后续-20261029.md §5 AUD50-02-02；任务书 B1-2。
 * 修法（默认路线 C，不截断）：makePlan 在写凭证前按 restoreTextOfRecord 算恢复体积，
 * 超过生效预算（Config.restoreMaxChars，默认 16000）→ 不写凭证、不改活动面，返回
 * no-candidate/restore-budget-exceeded（可重试，不进 not-worth 游标）；restore 命令
 * 读取同一预算；restore-too-large 与历史凭证恢复体积在命令面可见。
 *
 * ## 断言组
 * - 完成轮恢复体积 > 预算：archiveForStep 返回 restore-budget-exceeded，凭证 0、活动面不变；
 * - 调高预算后同一轮可归档（同时证明拒绝未推进 not-worth 游标），restore 成功；
 * - 历史超限凭证：restore 返回 chars/maxChars，命令面文案包含两者；
 * - history 行携带 restoreChars；下一次归档文案显示超预算原因与体积；
 * - readSettings 对非法/缺失 restoreMaxChars 回落 16000。
 *
 * ## 不适用条件与已知边界
 * - 不做隐式截断：超限如实返回，截断语义是产品决策（任务书 2.3）。
 * - 命令面文案经导出的 archiveLine/restoreFailureLine 断言（index.mjs 命令分发无测试夹具）。
 *
 * ## 定点变异自证
 * 临时删除 makePlan 的预算守卫 → 预算用例必红；恢复后全绿（证据存 .tmp/fix-B1-2/）。
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
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-b12-budget-'))
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

test('B1-2 完成轮恢复体积超预算：不写凭证、不改活动面、如实返回体积', async () => {
  await withEngine(async ({ ctx, engine }) => {
    const session = createFakeSession({ cwd: 'C:\\ws' })
    session.pushUser(USER_TEXT)
    session.pushAssistant(ASSISTANT_TEXT)
    session.pushUser('当前问题')
    await ctx.callPreStep(session)
    await settle(engine)

    const before = await session.surface.nodes
    const result = await engine.archiveForStep('session-fake', session, {})
    assert.equal(result.status, 'no-candidate', JSON.stringify(result))
    assert.equal(result.reason, 'restore-budget-exceeded', JSON.stringify(result))
    assert.equal(result.chars, (USER_TEXT + ASSISTANT_TEXT).length, '如实返回恢复体积（含 toolCalls 通道）')
    assert.equal(result.maxChars, 16000, '默认预算 16000')
    assert.deepEqual(await session.surface.nodes, before, '活动面不变')
    assert.equal((await engine.historyOf('session-fake')).total, 0, '不写凭证')
    assert.deepEqual(ctx.warnings, [], '预算拒绝不是故障，不得告警刷屏')
  })
})

test('B1-2 调高预算后同一轮可归档且可恢复（拒绝不推进 not-worth 游标）', async () => {
  await withEngine(async ({ ctx, engine }) => {
    const session = createFakeSession({ cwd: 'C:\\ws' })
    session.pushUser(USER_TEXT)
    session.pushAssistant(ASSISTANT_TEXT)
    session.pushUser('当前问题')
    await ctx.callPreStep(session)
    await settle(engine)

    const rejected = await engine.archiveForStep('session-fake', session, {})
    assert.equal(rejected.reason, 'restore-budget-exceeded', JSON.stringify(rejected))

    // 若拒绝被记进 not-worth 游标，这里同一轮会被跳过而不是归档。
    const archived = await engine.archiveForStep('session-fake', session, { restoreMaxChars: 200000 })
    assert.equal(archived.status, 'archived', JSON.stringify(archived))
    const history = await engine.historyOf('session-fake')
    assert.equal(history.total, 1)
    assert.equal(history.rows[0].restoreChars, (USER_TEXT + ASSISTANT_TEXT).length, '凭证携带恢复体积（history 可预判）')

    // 预算内的恢复成功。
    const restored = await engine.restoreHistory('session-fake', { index: 0, maxChars: 200000 })
    assert.equal(restored.restored, true, JSON.stringify(restored))
    // restore 把各记录正文用 \n\n 连接，chars 是恢复文本的真实长度（比逐条和多 2）。
    assert.equal(restored.chars, USER_TEXT.length + 2 + ASSISTANT_TEXT.length)
  })
})

test('B1-2 历史超限凭证：restore 如实返回 chars/maxChars，文案包含两者', async () => {
  await withEngine(async ({ ctx, engine }) => {
    const session = createFakeSession({ cwd: 'C:\\ws' })
    session.pushUser(USER_TEXT)
    session.pushAssistant(ASSISTANT_TEXT)
    session.pushUser('当前问题')
    await ctx.callPreStep(session)
    await settle(engine)
    const archived = await engine.archiveForStep('session-fake', session, { restoreMaxChars: 200000 })
    assert.equal(archived.status, 'archived', JSON.stringify(archived))

    const tooLarge = await engine.restoreHistory('session-fake', { index: 0, maxChars: 1000 })
    assert.equal(tooLarge.restored, false)
    assert.equal(tooLarge.reason, 'restore-too-large')
    // restore 文本按 \n\n 连接各记录，chars 比逐条和多 2（连接符）。
    assert.equal(tooLarge.chars, USER_TEXT.length + 2 + ASSISTANT_TEXT.length)
    assert.equal(tooLarge.maxChars, 1000)
    const text = restoreFailureLine(tooLarge, 0)
    assert.ok(text.includes(String(USER_TEXT.length + 2 + ASSISTANT_TEXT.length)), '文案含实际体积：' + text)
    assert.ok(text.includes('1000'), '文案含预算：' + text)
  })
})

test('B1-2 下一次归档文案：显示超预算原因与体积', () => {
  const line = archiveLine({ status: 'no-candidate', reason: 'restore-budget-exceeded', chars: 18000, maxChars: 16000 })
  assert.ok(line.includes('恢复体积超预算'), line)
  assert.ok(line.includes('18000'), line)
  assert.ok(line.includes('16000'), line)
})

test('B1-2 dryRun 同判据：超预算轮在预览可见', async () => {
  await withEngine(async ({ ctx, engine }) => {
    const session = createFakeSession({ cwd: 'C:\\ws' })
    session.pushUser(USER_TEXT)
    session.pushAssistant(ASSISTANT_TEXT)
    session.pushUser('当前问题')
    await ctx.callPreStep(session)
    await settle(engine)
    const preview = await engine.dryRunArchive('session-fake', session, {})
    assert.equal(preview.status, 'no-candidate', JSON.stringify(preview))
    assert.equal(preview.reason, 'restore-budget-exceeded')
    assert.equal(preview.chars, (USER_TEXT + ASSISTANT_TEXT).length)
  })
})

test('B1-2 预算可配：readSettings 校验与回落', () => {
  assert.equal(readSettings({ restoreMaxChars: 50000 }).restoreMaxChars, 50000)
  assert.equal(readSettings({}).restoreMaxChars, 16000, '缺失回落默认')
  assert.equal(readSettings({ restoreMaxChars: 999 }).restoreMaxChars, 16000, '低于下限回落')
  assert.equal(readSettings({ restoreMaxChars: 999999 }).restoreMaxChars, 16000, '高于上限回落')
  assert.equal(readSettings({ restoreMaxChars: 1234.5 }).restoreMaxChars, 16000, '非整数回落')
})
