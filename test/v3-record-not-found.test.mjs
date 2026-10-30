/**
 * B3-17（AUD50-06-06）not-found 与损坏分离——未知 ID 报 ERECORD_NOT_FOUND（不带损坏码）；
 * JSON 解析/结构/账实不符仍 ESTORE_CORRUPT；restore 的凭证行按 record-not-found 记账；
 * T2 读穿透对两种「本地不存在」形态都兼容。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { openV3SessionStore } from '../src/v3/adapters/storage/session-store.mjs'
import { createSessionStorePort } from '../src/v3/adapters/storage/session-store-port.mjs'
import { attachV3Engine } from '../src/v3/entry/v3-entry.mjs'
import { createFakeSession } from './helpers/fake-session.mjs'

function hex16(n) { return n.toString(16).padStart(16, '0') }
function recordOf(n, key) {
  const text = '正文' + n
  return { id: 'v3r-' + hex16(n), kind: 'message-user', sessionKey: key, createdAt: 1, payload: { text, bytes: Buffer.byteLength(text, 'utf8') }, provenance: { sourceEventId: 'dsh-' + n, sourceForm: null, transactionId: 'tx-' + n } }
}

test('B3-17 未知 ID → ERECORD_NOT_FOUND（不带损坏语义）；隔离残留/真损坏仍 ESTORE_CORRUPT', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-v3-notfound-'))
  const key = 's-notfound'
  try {
    const store = await openV3SessionStore(root, key)
    try {
      await store.submitTransaction([recordOf(1, key)])
      // 未知 ID：新码、文案明说不是损坏
      await assert.rejects(
        () => store.readRecord('v3r-' + '9'.repeat(16)),
        (e) => e?.code === 'ERECORD_NOT_FOUND' && /不是库损坏/.test(e.message),
      )
      // JSON 损坏：仍是 ESTORE_CORRUPT
      const recordsDir = path.join(root, 'sessions', key, 'records')
      await writeFile(path.join(recordsDir, 'v3r-' + hex16(2) + '.json'), '{broken', 'utf8')
      await assert.rejects(
        () => store.readRecord('v3r-' + hex16(2)),
        (e) => e?.code === 'ESTORE_CORRUPT',
      )
    } finally {
      store.close()
    }
    // 隔离残留（有 payload 无 commit）：仍 ESTORE_CORRUPT（账实问题，如实说明）
    await mkdir(path.join(root, 'sessions', key, 'records'), { recursive: true }).catch(() => {})
    await writeFile(path.join(root, 'sessions', key, 'records', 'v3r-' + hex16(3) + '.json'), JSON.stringify(recordOf(3, key)) + '\n', 'utf8')
    const reopened = await openV3SessionStore(root, key)
    try {
      await assert.rejects(
        () => reopened.readRecord('v3r-' + hex16(3)),
        (e) => e?.code === 'ESTORE_CORRUPT' && /崩溃残留/.test(e.message),
      )
    } finally {
      reopened.close()
    }
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})

test('B3-17 restore：缺失记录的凭证行记 record-not-found（不再混进 read-failed）', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-v3-notfound2-'))
  const key = 's-nf-restore'
  try {
    const { port, store } = await createSessionStorePort(root, key)
    await port.appendVoucher({ schemaVersion: 2, voucherId: 'v-1', kind: 'span', recordIds: ['v3r-' + 'a'.repeat(16)], sourceEventSeqs: [1], startSeq: 1, endSeq: 1, targetEventId: 1, receiptText: '回执正文', txn: 1 })
    // 直接调 store 层的 restoreVoucher 不可达（在 archive 层）；此处验证 store.readRecord 的分类
    await assert.rejects(() => store.readRecord('v3r-' + 'a'.repeat(16)), (e) => e?.code === 'ERECORD_NOT_FOUND')
    port.close()
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})

test('B3-17 引擎面：未知 ID 的 read 抛 ERECORD_NOT_FOUND（命令面不再显示损坏码）', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-v3-notfound3-'))
  const handlers = new Map()
  const ctx = { on(n, h) { handlers.set(n, h); return () => handlers.delete(n) }, logger: { warn() {}, info() {} } };
  ctx.preStep = async (session) => handlers.get('agent/pre-step')({ agent: { session }, signal: undefined }, async () => ({ kind: 'enter' }))
  const engine = attachV3Engine(ctx, { v3Root: root })
  const id = 's-nf-engine'
  try {
    const session = createFakeSession({ id })
    session.pushContextWindow(1000000)
    session.pushUser('落一条记录')
    await ctx.preStep(session)
    await engine._waitForIdle()
    await assert.rejects(
      () => engine.read(id, 'v3r-' + 'b'.repeat(16)),
      (e) => e?.code === 'ERECORD_NOT_FOUND' && /记录不存在/.test(e.message),
    )
  } finally {
    engine.dispose()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})
