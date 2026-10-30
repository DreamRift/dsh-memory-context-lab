/**
 * M5 fork/share 的落地：导出 → 空会话 adopt；新 ID/新事务，正文可检索/可再导出。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { attachV3Engine } from '../src/v3/entry/v3-entry.mjs'
import { createFakeSession } from './helpers/fake-session.mjs'
import { openV3SessionStore } from '../src/v3/adapters/storage/session-store.mjs'
import { V3ContractViolation } from '../src/v3/contracts/errors.mjs'

function fakeCtx() {
  const handlers = new Map()
  const ctx = {
    on(name, handler) { handlers.set(name, handler); return () => handlers.delete(name) },
    logger: { warn() {}, info() {} },
  }
  ctx.callPreStep = async (session) => {
    const handler = handlers.get('agent/pre-step')
    return await handler({ agent: { session }, signal: undefined }, async () => ({ kind: 'enter' }))
  }
  return ctx
}

async function settle(engine) {
  await new Promise((resolve) => setTimeout(resolve, 150))
  await engine._waitForIdle().catch(() => {})
  await new Promise((resolve) => setTimeout(resolve, 50))
}

test('export → adopt：空会话导入后正文可回读，且拒绝非空会话', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-import-'))
  const ctxA = fakeCtx()
  const ctxB = fakeCtx()
  const engineA = attachV3Engine(ctxA, { v3Root: root })
  const engineB = attachV3Engine(ctxB, { v3Root: root })
  try {
    const sessionA = createFakeSession({ id: 'session-a' })
    sessionA.pushUser('第一问：可分享')
    sessionA.pushAssistant('第一答：可分享')
    await ctxA.callPreStep(sessionA)
    await settle(engineA)
    const exported = await engineA.exportSession('session-a')
    assert.equal(exported.error, undefined)
    const fileName = path.basename(exported.file)

    const sessionB = createFakeSession({ id: 'session-b' })
    const imported = await engineB.importSession('session-b', fileName, sessionB)
    assert.equal(imported.error, undefined, JSON.stringify(imported))
    assert.equal(imported.imported, 2)
    const again = await engineB.importSession('session-b', fileName, sessionB)
    assert.equal(again.error, 'session-not-empty')

    const exportedB = await engineB.exportSession('session-b')
    const parsed = JSON.parse(await readFile(exportedB.file, 'utf8'))
    assert.equal(parsed.records.length, 2)
    assert.equal(JSON.stringify(parsed).includes('第一问'), true)
  } finally {
    await engineA._waitForIdle().catch(() => {})
    await engineB._waitForIdle().catch(() => {})
    engineA.dispose()
    engineB.dispose()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})

test('adoptFrom：同一引擎父会话 → 空子会话（原生 fork 记忆复制）', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-adopt-from-'))
  const ctx = fakeCtx()
  const engine = attachV3Engine(ctx, { v3Root: root })
  try {
    const parent = createFakeSession({ id: 'parent-a' })
    parent.pushUser('父问题')
    parent.pushAssistant('父回答')
    await ctx.callPreStep(parent)
    await settle(engine)

    const child = createFakeSession({ id: 'child-b' })
    const result = await engine.adoptFrom('child-b', 'parent-a', child)
    assert.equal(result.error, undefined, JSON.stringify(result))
    assert.equal(result.imported, 2)
    const again = await engine.adoptFrom('child-b', 'parent-a', child)
    assert.equal(again.error, 'session-not-empty')

    const exported = await engine.exportSession('child-b')
    const parsed = JSON.parse(await readFile(exported.file, 'utf8'))
    assert.equal(parsed.records.length, 2)
    assert.match(JSON.stringify(parsed), /父问题/)
  } finally {
    await engine._waitForIdle().catch(() => {})
    engine.dispose()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})

test('importRecords：脏记录整包预检拒绝，库不被污染（B3-20 / AUD50-07-02）', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-import-validate-'))
  const store = await openV3SessionStore(root, 'sess-validate')
  try {
    const good = { kind: 'message-user', payload: { text: '正常正文' } }
    const circular = { self: null }
    circular.self = circular
    const cases = [
      [{ kind: 'message-user', payload: { text: '', metaOnly: false } }, '空正文非 metaOnly'],
      [{ kind: 'operation-unknown', payload: { text: 'x' } }, '未知 kind'],
      [{ kind: 'message-user', payload: { text: 'x', structure: { big: 1n } } }, 'structure 含 BigInt'],
      [{ kind: 'message-user', payload: { text: 'x', structure: circular } }, 'structure 循环引用'],
    ]
    for (const [bad, label] of cases) {
      await assert.rejects(() => store.importRecords([good, bad]), (error) => error instanceof V3ContractViolation,
        label + ' 必须整包拒绝')
      assert.deepEqual(await store.listRecordIds(), [], label + ' 拒绝后不得留下半包（good 也不能落库）')
    }
    // 同包去掉脏行后照常导入：拒绝的是数据不是能力
    const ok = await store.importRecords([good])
    assert.equal(ok.recordIds.length, 1)
  } finally {
    store.close?.()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})
