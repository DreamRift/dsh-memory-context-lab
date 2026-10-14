// Reliability regressions: the failure modes that are invisible until the day
// they cost a user their archive. Each test names the behaviour, not the patch.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  DEFAULT_SETTINGS,
  LAB_ROOT_MARKER_FILE,
  LAB_ROOT_MARKER_KIND,
  MAX_PREVIEW_CHARS,
  NUMERIC_SETTINGS,
  STATE_FILE,
  displayPreview,
  normalizeSettings,
  restoreGrowth,
  truncateCodePoints,
} from '../src/core.mjs'
import {
  SessionStateDamagedError,
  createSessionState,
  ensureLabRoot,
  listSessionStates,
  readSessionState,
  sessionDirectoryFor,
} from '../src/storage.mjs'
import { createSuppressionCoordinator } from '../src/dsh-memory-suppression.mjs'
import { pendingReceipts } from '../src/apply-engine.mjs'

async function withRoot(body) {
  const root = await mkdtemp(path.join(tmpdir(), 'ctxlab-reliability-'))
  try {
    return await body(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

function fakeClient() {
  class MdcgClient {
    async remember() { return { ok: true } }
    async recentAdd() { return { ok: true } }
    async read() { return { results: [] } }
    async timeline() { return { items: [] } }
    async sessionRecall() { return { recent: [] } }
  }
  return MdcgClient
}

// --- root marker: damage is not "never initialised" ---------------------

test('ensureLabRoot refuses to overwrite a damaged root marker', async () => {
  await withRoot(async (root) => {
    const marker = path.join(root, LAB_ROOT_MARKER_FILE)
    const damaged = '{ this is not json'
    await writeFile(marker, damaged, 'utf8')
    await assert.rejects(() => ensureLabRoot(root), (error) => error?.code === 'EDAMAGED')
    assert.equal(await readFile(marker, 'utf8'), damaged, 'the damaged marker must survive untouched')
  })
})

test('ensureLabRoot refuses a foreign marker instead of replacing it', async () => {
  await withRoot(async (root) => {
    const marker = path.join(root, LAB_ROOT_MARKER_FILE)
    const foreign = JSON.stringify({ kind: 'someone-elses-root', schemaVersion: 1 })
    await writeFile(marker, foreign, 'utf8')
    await assert.rejects(() => ensureLabRoot(root), (error) => error?.code === 'EDAMAGED')
    assert.equal(await readFile(marker, 'utf8'), foreign, 'a foreign marker must not be adopted')
  })
})

test('ensureLabRoot still initialises a fresh directory', async () => {
  await withRoot(async (root) => {
    await ensureLabRoot(root)
    const marker = JSON.parse(await readFile(path.join(root, LAB_ROOT_MARKER_FILE), 'utf8'))
    assert.equal(marker.kind, LAB_ROOT_MARKER_KIND)
  })
})

test('readSessionState reports a damaged root marker as session damage', async () => {
  await withRoot(async (root) => {
    await writeFile(path.join(root, LAB_ROOT_MARKER_FILE), 'not json at all', 'utf8')
    await assert.rejects(
      () => readSessionState(root, 'session-a'),
      (error) => error instanceof SessionStateDamagedError,
    )
  })
})

// --- listing: a damaged session must not vanish -------------------------

test('listSessionStates reports a damaged session instead of hiding it', async () => {
  await withRoot(async (root) => {
    await ensureLabRoot(root)
    const directory = sessionDirectoryFor(root, 'session-a')
    await mkdir(directory, { recursive: true })
    await writeFile(path.join(directory, STATE_FILE), '{ broken', 'utf8')
    const result = await listSessionStates(root)
    assert.equal(Array.isArray(result.rows), true)
    assert.equal(Array.isArray(result.damaged), true)
    assert.equal(result.rows.length, 0)
    assert.equal(result.damaged.length, 1, 'the damaged session must be reported')
    assert.equal(result.damaged[0].directory, directory)
  })
})

test('listSessionStates returns healthy sessions in rows', async () => {
  await withRoot(async (root) => {
    await createSessionState(root, 'session-b', DEFAULT_SETTINGS)
    const result = await listSessionStates(root)
    assert.equal(result.rows.length, 1)
    assert.equal(result.rows[0].state.sessionId, 'session-b')
    assert.equal(result.damaged.length, 0)
  })
})

test('listSessionStates returns empty buckets for a root that is not ours', async () => {
  await withRoot(async (root) => {
    const result = await listSessionStates(root)
    assert.deepEqual(result, { rows: [], damaged: [] })
  })
})

// --- settings: an out-of-range value is unusable, not clamped ----------

test('normalizeSettings rejects a value above its declared maximum', () => {
  assert.equal(
    normalizeSettings({ retainOperations: NUMERIC_SETTINGS.retain.max + 1 }).retainOperations,
    DEFAULT_SETTINGS.retainOperations,
  )
  assert.equal(normalizeSettings({ retainOperations: 1e9 }).retainOperations, DEFAULT_SETTINGS.retainOperations)
  assert.equal(normalizeSettings({ archiveBatchSize: 1e9 }).archiveBatchSize, DEFAULT_SETTINGS.archiveBatchSize)
})

test('normalizeSettings keeps the boundary values themselves', () => {
  assert.equal(
    normalizeSettings({ retainOperations: NUMERIC_SETTINGS.retain.max }).retainOperations,
    NUMERIC_SETTINGS.retain.max,
  )
  assert.equal(
    normalizeSettings({ archiveBatchSize: NUMERIC_SETTINGS.batch.max }).archiveBatchSize,
    NUMERIC_SETTINGS.batch.max,
  )
})

// --- previews: never emit half a surrogate pair -------------------------

const LONE_HIGH = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/
const LONE_LOW = /(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

test('displayPreview never cuts a surrogate pair in half', () => {
  const preview = displayPreview('\u{1F600}'.repeat(400), 11)
  assert.equal(preview.endsWith('\u2026'), true)
  assert.equal(LONE_HIGH.test(preview), false, 'no lone high surrogate')
  assert.equal(LONE_LOW.test(preview), false, 'no lone low surrogate')
  assert.equal(Array.from(preview.slice(0, -1)).length, 10)
})

test('truncateCodePoints counts code points, not UTF-16 units', () => {
  assert.equal(truncateCodePoints('abc', 10), 'abc')
  const ten = '\u{1F600}'.repeat(10)
  assert.equal(truncateCodePoints(ten, 10), ten, 'exactly at budget is not truncated')
  assert.equal(truncateCodePoints(ten, 5), '\u{1F600}'.repeat(4) + '\u2026')
  assert.equal(LONE_HIGH.test(truncateCodePoints(ten, 4)), false)
  assert.equal(truncateCodePoints('', MAX_PREVIEW_CHARS), '')
})

test('displayPreview leaves short text alone', () => {
  assert.equal(displayPreview('  hello   world  '), 'hello world')
})

// --- suppression: the prototype is either whole or untouched -----------

test('install leaves the prototype untouched when a method is missing', () => {
  const MdcgClient = fakeClient()
  delete MdcgClient.prototype.sessionRecall
  const before = MdcgClient.prototype.read
  const coordinator = createSuppressionCoordinator(MdcgClient)
  assert.throws(() => coordinator.acquire('session-a'))
  assert.equal(MdcgClient.prototype.read, before, 'no half-applied patch may remain')
  assert.equal(coordinator.activeCount(), 0)
})

test('restore removes the own property that shadowed an inherited method', () => {
  class Base {
    async read() { return { from: 'base' } }
  }
  class MdcgClient extends Base {}
  MdcgClient.prototype.remember = async () => ({ ok: true })
  MdcgClient.prototype.recentAdd = async () => ({ ok: true })
  MdcgClient.prototype.timeline = async () => ({ items: [] })
  MdcgClient.prototype.sessionRecall = async () => ({ recent: [] })
  const coordinator = createSuppressionCoordinator(MdcgClient)
  const handle = coordinator.acquire('session-a')
  assert.notEqual(MdcgClient.prototype.read, Base.prototype.read, 'suppression shadows it while active')
  handle.release()
  assert.equal(
    Object.getOwnPropertyDescriptor(MdcgClient.prototype, 'read'),
    undefined,
    'the shadowing own property must be deleted, not left behind',
  )
  assert.equal(MdcgClient.prototype.read, Base.prototype.read)
})

test('release and dispose do not retain per-session counters', async () => {
  const MdcgClient = fakeClient()
  const coordinator = createSuppressionCoordinator(MdcgClient)
  const first = coordinator.acquire('session-a')
  await MdcgClient.prototype.remember({}, { session: 'session-a' })
  assert.equal(first.stats().write, 1)
  first.release()
  const second = coordinator.acquire('session-a')
  assert.equal(second.stats().write, 0, 'counters from the previous acquisition must be gone')
  second.release()
  const third = coordinator.acquire('session-a')
  await MdcgClient.prototype.remember({}, { session: 'session-a' })
  assert.equal(third.stats().write, 1)
  coordinator.dispose()
  const fourth = coordinator.acquire('session-a')
  assert.equal(fourth.stats().write, 0, 'dispose must drop every counter')
  fourth.release()
})

test('suppression still blocks only its own session', async () => {
  const MdcgClient = fakeClient()
  const coordinator = createSuppressionCoordinator(MdcgClient)
  const handle = coordinator.acquire('session-a')
  const blocked = await MdcgClient.prototype.remember({}, { session: 'session-a' })
  assert.equal(blocked.skipped, 'memory-context-lab')
  const other = await MdcgClient.prototype.remember({}, { session: 'session-b' })
  assert.equal(other.ok, true)
  assert.equal(other.skipped, undefined)
  handle.release()
})

// --- declaration: the peers the plugin actually loads -------------------

test('package.json declares the optional peers the plugin loads', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.ok(manifest.peerDependencies?.['@deepseek-ai/cosmokit'], 'cosmokit must be a declared peer')
  assert.equal(manifest.peerDependenciesMeta?.['@deepseek-ai/cosmokit']?.optional, true)
  assert.ok(manifest.peerDependencies?.['@deepseek-ai/schemastery'])
})

// --- receipts: a failed commit still holds the only copy -------------

test('pendingReceipts counts a verify-failed row', () => {
  const record = {
    state: {
      archive: [
        { rangeStart: 0, status: 'applied', originalTokens: 100, receiptTokens: 10 },
        { rangeStart: 1, status: 'verify-failed', originalTokens: 200, receiptTokens: 20 },
        { rangeStart: 2, status: 'restored' },
        { rangeStart: 3, status: 'restore-skipped: hash 不符' },
        { rangeStart: 4, status: 'orphaned' },
      ],
    },
  }
  const rows = pendingReceipts(record)
  assert.deepEqual(rows.map((row) => row.rangeStart), [0, 1],
    'a verify-failed row shadows its original and must stay restorable')
})

test('pendingReceipts tolerates a record without an archive', () => {
  assert.deepEqual(pendingReceipts({}), [])
  assert.deepEqual(pendingReceipts({ state: {} }), [])
  assert.deepEqual(pendingReceipts(undefined), [])
})

// --- restore guard: growth is original minus receipt -----------------

test('restoreGrowth subtracts the receipts already on the surface', () => {
  const pending = [
    { originalTokens: 1000, receiptTokens: 40 },
    { originalTokens: 500, receiptTokens: 10 },
  ]
  // 4000 assembled + 1450 real growth = 5450, which fits in 5480. Counting the
  // full originals (4000 + 1500 = 5500) would have refused this restore.
  const growth = restoreGrowth(pending, { assembledTokens: 4000, contextWindow: 5480 })
  assert.equal(growth.total, 1500)
  assert.equal(growth.heldByReceipts, 50)
  assert.equal(growth.growth, 1450)
  assert.equal(growth.overflow, false, 'the receipts already inside the assembly must not be counted twice')
})

test('restoreGrowth still refuses a restore that really does not fit', () => {
  const growth = restoreGrowth(
    [{ originalTokens: 2000, receiptTokens: 0 }],
    { assembledTokens: 5000, contextWindow: 6000 },
  )
  assert.equal(growth.overflow, true)
})

test('restoreGrowth treats a missing receipt count as zero', () => {
  const growth = restoreGrowth([{ originalTokens: 300 }], { assembledTokens: 0, contextWindow: 100 })
  assert.equal(growth.heldByReceipts, 0)
  assert.equal(growth.growth, 300)
  assert.equal(growth.overflow, true)
  assert.equal(restoreGrowth([], { assembledTokens: 0, contextWindow: 0 }).overflow, false)
})
