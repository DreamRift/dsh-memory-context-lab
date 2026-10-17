/**
 * 0.10.1 fix-brief P2 regressions (BUG-011 ... BUG-016).
 * Each test is revert-red; all state is temporary.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { FakeSession, fakeMeter } from './helpers/fake-host.mjs'
import { createV2Runtime } from '../src/v2/runtime.mjs'
import { V2SessionStore } from '../src/v2/store.mjs'
import { ensureLabRoot, sessionKeyFor } from '../src/storage.mjs'
import { RECORD_KINDS, draftRecord } from '../src/v2/records.mjs'
import { parseTestSummary } from '../src/v2/evidence-atoms.mjs'
import { packWorkingSet } from '../src/v2/readback.mjs'
import { loadHierarchy, hierarchyPath } from '../src/v2/hierarchy-store.mjs'
import { loadDisposition, dispositionPath } from '../src/v2/disposition.mjs'
import { captureFingerprints, checkRecords, markRecordsStale, syncVerification } from '../src/v2/verification.mjs'
import { createLingshuSemanticBackend } from '../src/v2/lingshu-backend.mjs'

async function withTemp(name, body) {
  const root = await mkdtemp(path.join(tmpdir(), `mcl-fixp2-${name}-`))
  try {
    await body(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

function makeRuntime(labRoot) {
  return createV2Runtime({
    labRoot,
    services: {
      get: (name) => {
        if (name === 'tokenMeter') return fakeMeter
        if (name === 'llm') return { resolveModelInfo: async () => ({ context: { contextWindow: 100000 }, defaultMaxTokens: 4096 }) }
        return undefined
      },
    },
    logger: { info() {}, warn() {}, error() {} },
    hostVersion: 'test-host',
    sessionIdOf: (session) => session.id,
    recallQueryFrom: () => null,
    defaultSettings: () => ({}),
    defaultFullHistory: () => false,
    defaultCompressModel: () => false,
    modelPhaseResolver: () => null,
  })
}

// ---------------------------------------------------------------- BUG-011

test('BUG-011: a same-line pass+fail summary aggregates both counts and reports failure', () => {
  const mixed = parseTestSummary('Tests: 3 passed | 2 failed')
  assert.deepEqual({ total: mixed.total, passed: mixed.passed, failed: mixed.failed }, { total: 5, passed: 3, failed: 2 })
  assert.match(mixed.summary, /失败/)

  const green = parseTestSummary('Tests: 3 passed')
  assert.deepEqual({ total: green.total, passed: green.passed, failed: green.failed }, { total: 3, passed: 3, failed: 0 })
  assert.match(green.summary, /全绿/)
  assert.match(parseTestSummary('3 项全绿').summary, /全绿/)
  assert.equal(parseTestSummary('nothing to report'), null)
})

// ---------------------------------------------------------------- BUG-012

test('BUG-012: verifyHash:false payloads carry no verified semantics', async () => {
  await withTemp('bug012', async (root) => {
    await ensureLabRoot(root)
    const sessionId = 'a1b2c3d4e5f6a7b8c9d0e1f2'
    const store = await V2SessionStore.init({ labRoot: root, sessionId })
    try {
      const txn = await store.openTransaction()
      const staged = await store.stageRecord(txn, draftRecord({
        kind: RECORD_KINDS.ASSISTANT_TEXT,
        seq: 1,
        fidelity: 'verbatim',
        refs: { messageId: 'm1', turn: 1 },
        content: 'ORIGINAL-PAYLOAD-0123456789',
      }))
      await store.commitTransaction(txn)
      const entry = store.listEntries({ limit: 100 }).entries.find((row) => row.id === staged.id)
      const hex = entry.payload.hash.slice('sha256:'.length)
      const sessionDir = path.join(path.resolve(root), 'v2', 'sessions', sessionKeyFor(sessionId))
      const payloadPath = path.join(sessionDir, 'payloads', hex.slice(0, 2), hex)
      const original = await readFile(payloadPath, 'utf8')
      await writeFile(payloadPath, 'X'.repeat(original.length), 'utf8')

      const unverified = await store.readRecord(staged.id, { verifyHash: false })
      assert.equal(unverified.ok, true)
      assert.equal(unverified.integrity, 'ok')
      assert.equal(unverified.verified, false, 'unverified read must not claim verified')
      const checked = await store.readRecord(staged.id, { verifyHash: true })
      assert.equal(checked.integrity, 'hash-mismatch')

      const pack = await packWorkingSet(root, sessionId, { budgetTokens: 20_000, store })
      const header = pack.entries.find((row) => row.id === staged.id)
      assert.ok(header)
      assert.equal(header.payloadIncluded, true)
      assert.notEqual(header.integrity, 'ok', 'scan-path payload must be labelled unverified')
      assert.equal(header.verified, false)
    } finally {
      store.close()
    }
  })
})

// ---------------------------------------------------------------- BUG-013

test('BUG-013: a damaged first line reports damaged; empty/missing still absent', async () => {
  await withTemp('bug013', async (root) => {
    const dir = path.join(root, 's1')
    await mkdir(dir, { recursive: true })
    assert.equal((await loadHierarchy(path.join(root, 'missing'))).state, 'absent')
    await writeFile(hierarchyPath(dir), '', 'utf8')
    assert.equal((await loadHierarchy(dir)).state, 'absent')
    await writeFile(hierarchyPath(dir), 'not-json\n', 'utf8')
    const damaged = await loadHierarchy(dir)
    assert.equal(damaged.state, 'damaged')
    assert.equal(damaged.damaged, true)

    const dispositionDir = path.join(root, 's2')
    await mkdir(dispositionDir, { recursive: true })
    await writeFile(dispositionPath(dispositionDir), '{"kind":"bad"}\n', 'utf8')
    assert.equal((await loadDisposition(dispositionDir)).state, 'damaged')
  })
})

// ---------------------------------------------------------------- BUG-014

test('BUG-014: sidecar rebuild freezes recapture so later edits cannot be whitened', async () => {
  await withTemp('bug014', async (root) => {
    const sessionDir = path.join(root, 'session')
    await mkdir(sessionDir, { recursive: true })
    const target = path.join(root, 'target.txt')
    await writeFile(target, 'v1 original', 'utf8')
    const records = {
      't00000001-r0001': { kind: 'operation.call', paramsText: JSON.stringify({ file_path: target }), createdAt: '2026-01-01T00:00:00.000Z' },
      't00000002-r0002': { kind: 'operation.call', paramsText: JSON.stringify({ file_path: target }), createdAt: '2026-01-01T00:00:01.000Z' },
    }
    const store = {
      listEntries() { return { entries: Object.keys(records).map((id) => ({ id, createdAt: records[id].createdAt })) } },
      async readRecord(id) {
        const record = records[id]
        if (!record) return { ok: false, error: 'not found' }
        return { ok: true, id, record, payloadText: record.paramsText ?? null, integrity: 'ok', truncated: false, fullBytes: 0 }
      },
    }
    await captureFingerprints({ store, sessionDir, recordIds: Object.keys(records) })
    await writeFile(target, 'v2 changed after archive', 'utf8')
    await writeFile(path.join(sessionDir, 'verification.json'), '{"kind": "dsh-memory-context-lab/v2/verif', 'utf8')
    await markRecordsStale({ sessionDir, recordIds: ['t00000001-r0001'], reason: 'human mark after damage' })
    const synced = await syncVerification({ store, sessionDir })
    assert.equal(synced.captured, 0, 'pre-damage records must not be recaptured')
    assert.ok(synced.frozen >= 1, JSON.stringify(synced))
    const checked = await checkRecords({ sessionDir, recordIds: ['t00000002-r0002'] })
    assert.equal(checked.results[0].verdict, 'unverified', 'no fingerprint means unverified, never valid')
  })
})

// ---------------------------------------------------------------- BUG-015

async function seedRecallAlias(root, sessionId) {
  const store = await V2SessionStore.init({ labRoot: root, sessionId })
  try {
    const txn = await store.openTransaction()
    const staged = []
    staged.push(await store.stageRecord(txn, draftRecord({
      kind: RECORD_KINDS.ASSISTANT_TEXT,
      seq: 1,
      fidelity: 'verbatim',
      refs: { messageId: 'm1', turn: 1 },
      content: 'A'.repeat(400),
    })))
    const alias = 'mcl2-recallalias-000001'
    for (let chunk = 1; chunk <= 3; chunk += 1) {
      staged.push(await store.stageRecord(txn, draftRecord({
        kind: RECORD_KINDS.PROJECTION_SPAN,
        seq: chunk + 1,
        fidelity: 'synthesized',
        refs: { spanKind: 'turn.user', sourceKinds: 'user/message', sourceSeqs: String(chunk + 1) },
        inline: { nodeId: alias, chunk, spanKind: 'turn.user' },
        content: 'B'.repeat(400),
      })))
    }
    staged.push(await store.stageRecord(txn, draftRecord({
      kind: RECORD_KINDS.ASSISTANT_TEXT,
      seq: 5,
      fidelity: 'verbatim',
      refs: { messageId: 'm5', turn: 2 },
      content: 'C'.repeat(40),
    })))
    await store.commitTransaction(txn)
    return { ids: staged.map((row) => row.id), alias, directLast: staged[staged.length - 1].id }
  } finally {
    store.close()
  }
}

test('BUG-015: alias content that fits is not rejected by a double-subtracted budget', async () => {
  await withTemp('bug015a', async (root) => {
    await ensureLabRoot(root)
    const sessionId = 'b1b2c3d4e5f6a7b8c9d0e1f2'
    const { ids, alias, directLast } = await seedRecallAlias(root, sessionId)
    const rt = makeRuntime(root)
    const result = await rt.recall(sessionId, { recordIds: [ids[0], alias, directLast], budgetTokens: 450 })
    assert.equal(result.error ?? null, null)
    assert.ok(result.entries.some((entry) => entry.resolvedVia === 'node-alias'), JSON.stringify(result.entries.map((e) => e.resolvedVia)))
    assert.ok(result.usedTokens <= 450, `used=${result.usedTokens}`)
    assert.equal(result.nextCursor, null)
  })
})

test('BUG-015: alias interruption leaves exactly the unprocessed id prefix for the cursor', async () => {
  await withTemp('bug015b', async (root) => {
    await ensureLabRoot(root)
    const sessionId = 'c1b2c3d4e5f6a7b8c9d0e1f2'
    const { ids, alias, directLast } = await seedRecallAlias(root, sessionId)
    const rt = makeRuntime(root)
    const first = await rt.recall(sessionId, { recordIds: [ids[0], alias, directLast], budgetTokens: 250 })
    assert.ok(first.usedTokens <= 250, `used=${first.usedTokens}`)
    assert.ok(first.nextCursor)
    assert.ok(!first.entries.some((entry) => entry.id === directLast), 'must not read later ids after an alias break')

    const second = await rt.recall(sessionId, { budgetTokens: 1000, cursor: first.nextCursor })
    assert.equal(second.error ?? null, null)
    const secondIds = second.entries.map((entry) => entry.id)
    assert.ok(second.entries.some((entry) => entry.resolvedVia === 'node-alias'))
    assert.ok(secondIds.includes(directLast))
    assert.ok(!secondIds.includes(ids[0]))
    assert.equal(second.nextCursor, null)
  })
})

// ---------------------------------------------------------------- BUG-016

test('BUG-016: T2 committed:false reads content and treats the rewrite as a retry success', async () => {
  const id = 't00000001-r0001'
  const client = {
    sessionId: 'session-bug016',
    async callTool() { return { ok: true, committed: false } },
    async getNode(nodeId) {
      assert.equal(nodeId, id)
      return { ok: true, id, content: `[v2 派生索引] 记录 ${id}\nkind=assistant.text` }
    },
  }
  const backend = createLingshuSemanticBackend({ client })
  const result = await backend.index([{ id, kind: 'assistant.text', fidelity: 'verbatim', seq: 1, text: '正文' }])
  assert.deepEqual(result.conflicts, [], JSON.stringify(result.conflicts))
  assert.equal(result.externalIds[id], id)
})
