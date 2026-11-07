/**
 * S-13 守卫（0.15.4）：`adopt <文件名>` 必须与 `adopt-from` 服从同一道同意门。
 *
 * ## 缺陷
 *
 * `adopt-from <父会话ID>` 有两道校验（fork 归属 + 父会话显式同意），而
 * `adopt <文件名>` **一道都不查**。它从**全局共享**的 `exports/` 目录直接读包，
 * 于是「知道文件名」就等于「能取走别人的记忆」——同意门被完全绕过。
 *
 * ## 修法
 *
 * 导出包内带 `sessionKey`（来源身份）。`importSession` 用它过 `adoptGateFor`：
 * - 来源就是自己 → 放行（等同恢复自己的导出）；
 * - 来源是已打开的另一会话 → 按同一 consent 判据校验（默认拒绝）；
 * - 来源判不出 / 未打开 → 失败关闭（不猜、不放行）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { attachV3Engine } from '../src/v3/entry/v3-entry.mjs'
import { createFakeSession } from './helpers/fake-session.mjs'

function fakeCtx() {
  const handlers = new Map()
  const ctx = {
    on(name, handler) { handlers.set(name, handler); return () => handlers.delete(name) },
    logger: { warn() {}, info() {} },
  }
  ctx.callPreStep = async (session) => {
    const handler = handlers.get('agent/pre-step')
    if (!handler) throw new Error('未注册 pre-step')
    return await handler({ agent: { session }, signal: undefined }, async () => ({ kind: 'enter' }))
  }
  return ctx
}

const settle = async (engine) => {
  await new Promise((resolve) => setTimeout(resolve, 150))
  await engine._waitForIdle().catch(() => {})
}

/** 往 v3Root/exports/ 写一个最小导出包（形状对齐 readExportBundle 的期望）。 */
async function writeBundle(root, fileName, sessionKey) {
  const dir = path.join(root, 'exports')
  await mkdir(dir, { recursive: true })
  const bundle = {
    schemaVersion: 1,
    exportPolicy: 'redacted',
    sessionKey,
    exportedAt: Date.now(),
    counts: { records: 1, forgotten: 0, vouchers: 0, redactedVouchers: 0, omittedForgotten: 0, summaries: 0, hiddenSummaries: 0 },
    records: [{
      id: 'v3r-0123456789abcdef',
      kind: 'message-user',
      createdAt: Date.now(),
      payload: { text: '从别人的记忆搬来的正文 beta', bytes: 39 },
      provenance: { sourceEventId: null, sourceForm: null, transactionId: null },
    }],
    vouchers: [],
    forgotten: [],
    summaries: [],
  }
  await writeFile(path.join(dir, fileName), JSON.stringify(bundle), 'utf8')
  return fileName
}

test('S-13 adopt <文件名> 默认拒绝跨会话导入；来源授权后才允许', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-s13-'))
  const ctx = fakeCtx()
  const engine = attachV3Engine(ctx, { v3Root: root, defaultEnabled: true })
  try {
    // 父会话先落一些正文（成为 bundle 的来源身份）。
    const parent = createFakeSession({ id: 's-src' })
    parent.pushUser('父会话的私密正文 alpha')
    await ctx.callPreStep(parent)
    await settle(engine)

    const sourceKey = parent.header?.sessionId ?? parent.sessionKey ?? 's-src'
    const fileName = await writeBundle(root, 'pack.json', sourceKey)

    // ① 未授权：任何人凭文件名都不得导入。
    const denied = await engine.importSession('s-dst', fileName, createFakeSession({ id: 's-dst' }))
    assert.ok(
      denied.error === 'parent-consent-required' || denied.error === 'bundle-source-not-open',
      '默认必须拒绝，实际：' + JSON.stringify(denied),
    )

    // ② 授权后允许。
    await engine.setAdoptAllow('s-src', true)
    const allowed = await engine.importSession('s-dst', fileName, createFakeSession({ id: 's-dst' }))
    assert.equal(allowed.error, undefined, '授权后应允许，实际：' + JSON.stringify(allowed))
    assert.ok(allowed.imported >= 1)

    // ③ 撤销授权后恢复拒绝。
    await engine.setAdoptAllow('s-src', false)
    const again = await engine.importSession('s-dst-2', fileName, createFakeSession({ id: 's-dst-2' }))
    assert.ok(
      again.error === 'parent-consent-required' || again.error === 'bundle-source-not-open',
      '撤销后必须拒绝，实际：' + JSON.stringify(again),
    )
  } finally {
    await engine._waitForIdle().catch(() => {})
    engine.dispose()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})

test('S-13 包内无来源身份 → 失败关闭（不猜、不放行）', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-s13b-'))
  const ctx = fakeCtx()
  const engine = attachV3Engine(ctx, { v3Root: root, defaultEnabled: true })
  try {
    const fileName = await writeBundle(root, 'anon.json', '')
    const result = await engine.importSession('s-dst', fileName, createFakeSession({ id: 's-dst' }))
    assert.equal(result.error, 'bundle-identity-missing', '无身份必须失败关闭，实际：' + JSON.stringify(result))
  } finally {
    await engine._waitForIdle().catch(() => {})
    engine.dispose()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})
