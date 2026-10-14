/**
 * v1 → v2 迁移导入测试（合成夹具，不触真实会话）：
 * 合法条目导入、畸形条目整批拒绝、重复导入幂等、导入后历史仍可回读。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { V2SessionStore, EngineV2Error } from '../src/v2/store.mjs'
import { importV1ArchiveEntries, validateV1ArchiveEntry } from '../src/v2/import-v1.mjs'
import { RECORD_KINDS } from '../src/v2/records.mjs'
import { readRecordById } from '../src/v2/readback.mjs'
import { ensureLabRoot } from '../src/storage.mjs'

const SESSION_ID = 'c3d4e5f6a7b8c9d0e1f2a3b4'

function validEntry(overrides = {}) {
  return {
    rangeStart: 10,
    rangeEnd: 14,
    callIds: ['call-1', 'call-2'],
    tools: ['read_file', 'pwsh'],
    nodeId: 'node-0001',
    hash: 'a'.repeat(64),
    chars: 12345,
    originalTokens: 4567,
    replacementSeq: 300,
    chunkCount: 2,
    chunkIds: ['chunk-0', 'chunk-1'],
    appliedAt: '2026-10-11T10:00:00.000Z',
    status: 'applied',
    ...overrides,
  }
}

async function makeLabRoot() {
  const root = await mkdtemp(path.join(tmpdir(), 'mclv2import-'))
  await ensureLabRoot(root)
  return root
}

test('v1 合法条目导入为 synthesized 指针记录，且可按 ID 回读', async () => {
  const root = await makeLabRoot()
  try {
    const store = await V2SessionStore.init({ labRoot: root, sessionId: SESSION_ID })
    const { committedTxn, recordIds, skipped } = await importV1ArchiveEntries(store, [
      validEntry(),
      validEntry({ rangeStart: 20, rangeEnd: 22, nodeId: 'node-0002', replacementSeq: 301 }),
    ])
    assert.equal(skipped, 0)
    assert.ok(committedTxn >= 1)
    assert.equal(recordIds.length, 2)
    await store.close()

    // readRecordById 自开新句柄，等价于重开后按 ID 回读。
    const loaded = await readRecordById(root, SESSION_ID, recordIds[0])
    assert.equal(loaded.ok, true)
    assert.equal(loaded.record.kind, RECORD_KINDS.PROJECTION_SPAN)
    assert.equal(loaded.record.fidelity, 'synthesized')
    const descriptor = JSON.parse(loaded.payloadText)
    assert.equal(descriptor.nodeId, 'node-0001')
    assert.equal(descriptor.source, 'v1-archive')
    assert.deepEqual(descriptor.callIds, ['call-1', 'call-2'])
    // v1 回执 nodeId 仍指向 v1 冷库——指针未被抹掉。
    assert.equal(descriptor.hash, 'a'.repeat(64))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('畸形条目整批拒绝，绝不半批入库', async () => {
  const root = await makeLabRoot()
  try {
    const store = await V2SessionStore.init({ labRoot: root, sessionId: SESSION_ID })
    await assert.rejects(
      () => importV1ArchiveEntries(store, [validEntry(), validEntry({ nodeId: undefined })]),
      (error) => error instanceof EngineV2Error && error.code === 'ESCHEMA',
    )
    // 非对象垃圾同样整批拒绝。
    await assert.rejects(
      () => importV1ArchiveEntries(store, [validEntry(), 'junk-string', 42]),
      (error) => error instanceof EngineV2Error && error.code === 'ESCHEMA',
    )
    assert.equal(store.recordCount, 0, '拒绝后不得留下半批记录')
    await store.close()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('重复导入幂等：同一条目第二次导入不再产生新记录', async () => {
  const root = await makeLabRoot()
  try {
    const store = await V2SessionStore.init({ labRoot: root, sessionId: SESSION_ID })
    const first = await importV1ArchiveEntries(store, [validEntry()])
    assert.equal(first.recordIds.length, 1)
    const second = await importV1ArchiveEntries(store, [validEntry()])
    assert.equal(second.recordIds.length, 0)
    assert.equal(second.skipped, 1)
    assert.equal(store.recordCount, 1)
    await store.close()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('validateV1ArchiveEntry 拒绝常见伪造字段', () => {
  assert.ok(typeof validateV1ArchiveEntry(validEntry({ status: 'pending' })) === 'string')
  assert.ok(typeof validateV1ArchiveEntry(validEntry({ rangeEnd: 1 })) === 'string')
  assert.ok(typeof validateV1ArchiveEntry(validEntry({ callIds: [] })) === 'string')
  assert.ok(typeof validateV1ArchiveEntry(validEntry({ appliedAt: 'not-a-date' })) === 'string')
  assert.equal(validateV1ArchiveEntry(validEntry()), null)
})
