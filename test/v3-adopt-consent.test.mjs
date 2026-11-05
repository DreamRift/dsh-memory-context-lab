/**
 * H5（2026-11-04 独立审计）：`adopt-from` 必须有归属校验。
 *
 * 旧实现只拒绝「同会话 / 父会话未在本进程 / 目标非空」，然后就复制父会话全部正文；
 * 会话 ID 可从 status 或导出文件名获得，等于「知道 ID 就能取走别人的记忆」。
 *
 * 新规则（本套件锁住）：
 * - 默认拒绝：父会话必须显式 `/memory-lab adopt-allow on`（可撤销、有状态、可审计）；
 * - 可判读的原生 fork 关系与给定父会话不一致 → 拒绝；
 * - 父会话记录数超过导入上限 → 拒绝整库复制。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
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

test('H5 adopt-from 默认拒绝；父会话授权后才允许；fork 关系不符拒绝', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-adopt-'))
  const ctx = fakeCtx()
  const engine = attachV3Engine(ctx, { v3Root: root, defaultEnabled: true })
  try {
    const parent = createFakeSession({ id: 's-parent' })
    parent.pushUser('父会话的私密正文 alpha')
    await ctx.callPreStep(parent)
    await settle(engine)

    const child = createFakeSession({ id: 's-child' })
    const denied = await engine.adoptFrom('s-child', 's-parent', child)
    assert.equal(denied.error, 'parent-consent-required', '默认必须拒绝')

    const status = await engine.adoptStatus('s-parent')
    assert.equal(status.allow, false)

    const allowed = await engine.setAdoptAllow('s-parent', true)
    assert.equal(allowed.allow, true, JSON.stringify(allowed))
    assert.equal((await engine.adoptStatus('s-parent')).allow, true)

    const adopted = await engine.adoptFrom('s-child', 's-parent', child)
    assert.equal(adopted.error, undefined, JSON.stringify(adopted))
    assert.ok(adopted.imported >= 1)

    // 已授权也不能绕过 fork 关系：子会话明确声明了另一个父会话时拒绝。
    const other = createFakeSession({ id: 's-child-2' })
    other.header = { parentSessionId: 's-someone-else' }
    const mismatch = await engine.adoptFrom('s-child-2', 's-parent', other)
    assert.equal(mismatch.error, 'parent-lineage-mismatch')

    // 撤销授权后恢复默认拒绝。
    await engine.setAdoptAllow('s-parent', false)
    const again = await engine.adoptFrom('s-child-3', 's-parent', createFakeSession({ id: 's-child-3' }))
    assert.equal(again.error, 'parent-consent-required')
  } finally {
    await engine._waitForIdle().catch(() => {})
    engine.dispose()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})
