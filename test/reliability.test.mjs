// Reliability regressions: the failure modes that are invisible until the day
// they cost a user their archive. Each test names the behaviour, not the patch.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  DEFAULT_SETTINGS,
  LAB_ROOT_MARKER_FILE,
  LAB_ROOT_MARKER_KIND,
  MAX_PREVIEW_CHARS,
  MIN_OPERATION_CHARS,
  NUMERIC_SETTINGS,
  RECEIPT_FORMAT_BATCH,
  RECEIPT_FORMAT_VERSION,
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
  writeJsonAtomic,
} from '../src/storage.mjs'
import { createSuppressionCoordinator } from '../src/dsh-memory-suppression.mjs'
import { createEngine, pendingReceipts } from '../src/apply-engine.mjs'
import {
  applyOperations,
  collectOperationCandidates,
  openTurnOf,
  planCooling,
  restoreReceipts,
} from '../src/apply.mjs'
import { FakeColdStore, buildSession, fakeMeter } from './helpers/fake-host.mjs'

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

// --- atomic state writes: the bytes must survive a crash -----------------
// B1：writeJsonAtomic 的持久化次序与落盘卫生。崩溃落在 rename 之后、盘刷之前
// 会留下空文件或半截文件，而旧状态已经没了——这是回执账本不可重建的损失。

test('writeJsonAtomic fsyncs the temp file before the rename takes over', async () => {
  const source = await readFile(new URL('../src/storage.mjs', import.meta.url), 'utf8')
  const start = source.indexOf('export async function writeJsonAtomic')
  const end = source.indexOf('async function readLabRootMarker', start)
  assert.ok(start >= 0 && end > start, 'the source layout this contract pins has changed')
  const body = source.slice(start, end)
  assert.ok(body.includes('handle.sync()'), 'the temp file must be flushed while it is still the temp name')
  assert.ok(
    body.indexOf('handle.sync()') < body.indexOf('await rename('),
    'the flush must happen BEFORE the rename: after it, a crash lands on the final name',
  )
})

test('writeJsonAtomic leaves no temp residue and fully replaces prior content', async () => {
  await withRoot(async (root) => {
    const file = path.join(root, 'nested', 'state.json')
    await writeJsonAtomic(file, { v: 1 })
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { v: 1 })
    let names = await readdir(path.dirname(file))
    assert.equal(names.some((name) => name.endsWith('.tmp')), false, 'a completed write leaves no .tmp behind')
    await writeJsonAtomic(file, { v: 2 })
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { v: 2 }, 'prior content must be fully replaced')
    names = await readdir(path.dirname(file))
    assert.deepEqual(names, ['state.json'], 'the directory holds exactly the one state file')
  })
})

// --- listing: a session that vanishes mid-scan is not damage -------------
// B2/C7：并发清理（`/memory-lab clean`、另一会话、用户手动删）会让目录消失在
// `readdir` 与逐项检查之间。那不是损坏，不该掀掉整次扫描。窗口本身无法确定性
// 复现，所以行为侧断言同一终态（状态文件已消失的会话目录被跳过、不算损坏），
// 源码侧钉住 ENOENT 容忍分支确实存在。

test('listSessionStates skips a vanished session instead of reporting damage', async () => {
  const source = await readFile(new URL('../src/storage.mjs', import.meta.url), 'utf8')
  const start = source.indexOf('export async function listSessionStates')
  const body = source.slice(start, source.indexOf('\nexport ', start + 10) === -1 ? undefined : source.indexOf('\nexport ', start + 10))
  assert.ok(start >= 0, 'the source layout this contract pins has changed')
  assert.equal((body.match(/'ENOENT'/g) || []).length >= 2, true,
    'listSessionStates must tolerate ENOENT from the lstat fallbacks (the concurrent-removal race)')

  await withRoot(async (root) => {
    await ensureLabRoot(root)
    // 终态一：目录还在、状态文件已被并发清掉（readJsonStrict → null → 跳过）。
    const directory = sessionDirectoryFor(root, 'session-vanish')
    await mkdir(directory, { recursive: true })
    // 终态二：目录被同名普通文件顶替（ENOTDIR 同源竞态）。
    await writeFile(path.join(root, 'sessions', 'a'.repeat(24)), 'not a session', 'utf8')
    const result = await listSessionStates(root)
    assert.equal(result.rows.length, 0)
    assert.equal(result.damaged.length, 0, 'a vanished session is a race, not damage')
  })
})

// --- verify-failed: the shadowed original must stay restorable -----------
// B3/B6/C1：替换已提交、原文已被回执遮蔽之后校验才失败。此时冷库分块是原文
// 唯一的副本，归档行必须带着与实际写入一致的回执重建元数据——否则 restore
// 会按另一种格式重建正文而被「回执正文已变化」拒绝，原文永久不可恢复。

function planFor(session, { retainOperations = 0, batchSize = 1, receiptMarker } = {}) {
  const measured = fakeMeter.measure(session)
  const view = collectOperationCandidates({
    surfaceNodes: session.surface.nodes,
    eventAt: (seq) => session.eventAt(seq),
    measuredNodes: measured.nodes,
    retainOperations,
    openTurn: openTurnOf(session),
    archivedRanges: [],
    minimumChars: MIN_OPERATION_CHARS,
  })
  const plan = planCooling({
    candidates: view.candidates,
    meter: fakeMeter,
    nodeIdFor: (candidate) => `node-${candidate.rangeStart}`,
    retainOperations,
    batchSize,
    maxOperations: 64,
    minNetReleaseTokens: 128,
    ...(receiptMarker ? { receiptMarker } : {}),
  })
  return { view, plan }
}

function archiveRowFromOutcome(outcome) {
  return {
    rangeStart: outcome.rangeStart,
    rangeEnd: outcome.rangeEnd,
    callIds: outcome.callIds,
    tools: outcome.tools,
    nodeId: outcome.nodeId,
    hash: outcome.hash,
    chars: outcome.chars,
    originalTokens: outcome.originalTokens,
    replacementSeq: outcome.replacementSeq,
    locators: outcome.locators ?? [],
    statuses: outcome.statuses ?? [],
    receiptFormat: outcome.receiptFormat,
    batchSize: outcome.batchSize,
    chunkCount: outcome.chunkCount ?? 1,
  }
}

test('a verify-failed batch keeps full receipt metadata and restores every original', async () => {
  const session = buildSession({ operations: 4, resultChars: 4000 })
  const { plan } = planFor(session, { retainOperations: 0, batchSize: 4, receiptMarker: 'V2-RECEIPT' })
  const store = new FakeColdStore()
  // 让提交后的校验失败：此刻冷节点已写入、替换已提交（deriveMessages 只在
  // commitSurfaceRun 的校验段被调用）。
  session.deriveMessages = () => { throw new Error('fake surface assembly failed') }

  const outcomes = await applyOperations({
    session, client: store, units: plan.units, meter: fakeMeter, hostVersion: 'test', receiptMarker: 'V2-RECEIPT',
  })
  assert.equal(outcomes.length, 4)
  for (const outcome of outcomes) {
    assert.equal(outcome.state, 'verify-failed', outcome.reason)
    assert.ok(outcome.reason.includes('fake surface assembly failed'))
    // C1：这些字段描述的是已提交的替换，与校验结果无关，restore 靠它们重建。
    assert.equal(typeof outcome.replacementSeq, 'number')
    assert.equal(outcome.chunkCount, outcome.chunkIds.length)
    assert.ok(outcome.chunkIds.length >= 1)
    assert.equal(typeof outcome.shadowedTokenCount, 'number')
    assert.equal(typeof outcome.surfaceGeneration, 'number')
    assert.equal(outcome.hostVersion, 'test')
    assert.equal(outcome.receiptFormat, RECEIPT_FORMAT_BATCH)
    assert.equal(outcome.batchSize, 4)
    for (const seq of [outcome.rangeStart, outcome.rangeEnd]) {
      assert.equal(session.surface.nodes.includes(seq), false, `seq ${seq} is shadowed even though verification failed`)
    }
  }

  const rows = outcomes.map(archiveRowFromOutcome)
  const restored = await restoreReceipts({ session, client: store, receipts: rows, receiptMarker: 'V2-RECEIPT' })
  assert.equal(
    restored.filter((outcome) => outcome.state === 'restored').length,
    4,
    `every verify-failed row must restore: ${JSON.stringify(restored.map((o) => [o.state, o.reason]))}`,
  )
})

test('a verify-failed single-unit commit keeps the legacy receipt rebuildable', async () => {
  const session = buildSession({ operations: 3, resultChars: 60000 })
  const { plan } = planFor(session, { retainOperations: 0, batchSize: 3 })
  assert.equal(plan.units.length, 3, 'the fixture needs all three units planned')
  // 跳过中间单元：0 与 2 的宿主 seq 不相邻 → 断成两个单单元 run，各自保持
  // 逐条（legacy）回执——这正是 0.9.0-rc.2 之前的字节形态。
  const units = [plan.units[0], plan.units[2]]
  const store = new FakeColdStore()
  session.deriveMessages = () => { throw new Error('fake surface assembly failed') }

  const outcomes = await applyOperations({
    session, client: store, units, meter: fakeMeter, hostVersion: 'test',
  })
  assert.equal(outcomes.length, 2)
  assert.ok(outcomes.some((outcome) => outcome.chunkCount > 1), 'the fixture must include a multi-chunk unit — that is the shape the old bug corrupted')
  for (const outcome of outcomes) {
    assert.equal(outcome.state, 'verify-failed', outcome.reason)
    assert.equal(outcome.chunkCount, outcome.chunkIds.length)
    assert.equal(outcome.receiptFormat, RECEIPT_FORMAT_VERSION, 'a single-unit run keeps the per-unit (format-2) receipt')
    assert.equal(outcome.batchSize, undefined)
  }

  const restored = await restoreReceipts({ session, client: store, receipts: outcomes.map(archiveRowFromOutcome) })
  assert.equal(
    restored.filter((outcome) => outcome.state === 'restored').length,
    2,
    `both verify-failed rows must restore via the legacy rebuild: ${JSON.stringify(restored.map((o) => [o.state, o.reason]))}`,
  )
})

// --- engine: measurement and cold-store lifecycle -------------------------

function makeEngineRecord(session) {
  return {
    agent: { session },
    state: {
      enabled: true,
      // 0.13.0：本套件验证的是归档机制，与压力无关；夹具占用只有约 2%，
      // 默认闸门（20%）会正确地拒绝归档，所以显式关闸门。
      settings: { auto: true, autoRecall: true, retainOperations: 1, archiveBatchSize: 1, pressureGate: 0 },
      archive: [],
      lastMeasurement: null,
      lastFailures: [],
    },
    lastAction: null,
    occupancy: null,
    occupancyError: null,
    client: null,
    clientError: null,
    cost: null,
  }
}

// B4：批次提交后的占用率必须重新测量。批前快照描述的活动面已经不存在——
// 原文被回执替换了；把旧数落盘，status 会报一个用户再也看不到的占用量。
test('a committed batch re-measures occupancy so the stored figure matches the new surface', async () => {
  const engine = createEngine({
    persist: async () => {},
    nodeIdFor: (record, ordinal) => `reliability-node-${ordinal}`,
    hostVersion: 'reliability-test',
    services: {
      get(name) {
        if (name === 'tokenMeter') return fakeMeter
        if (name === 'llm') return { resolveModelInfo: async () => ({ context: { contextWindow: 100000 }, defaultMaxTokens: 4096 }) }
        return undefined
      },
    },
    logger: { info() {}, warn() {}, error() {} },
    createClient: async () => new FakeColdStore(),
  })
  const session = buildSession({ operations: 2, resultChars: 4000 })
  const record = makeEngineRecord(session)
  const before = fakeMeter.measure(session).totalTokens

  // 复测发生在 runAutoCooling 的批次成功路径上（runOnce 是手动入口，不落测量）。
  const outcome = await engine.runAutoCooling(record, new AbortController().signal)
  assert.equal(outcome.action, 'applied', `the batch must really commit: ${JSON.stringify(outcome)}`)
  assert.equal(
    record.state.archive.filter((row) => row.status === 'applied').length,
    1,
    'exactly the one out-of-window operation must be archived',
  )
  const after = fakeMeter.measure(session).totalTokens
  assert.ok(after < before, 'the committed batch must shrink the surface')
  assert.equal(record.state.lastMeasurement.kind, 'applied')
  assert.equal(
    record.state.lastMeasurement.assembledTokens,
    after,
    'the stored measurement must equal the POST-batch surface, not the stale pre-batch snapshot',
  )
})

// B5：冷库创建失败要被记住、只失败一次——每个 pre-step 边界都重试一次工厂
// 会让一个坏掉的冷库把会话的每一步都拖进失败循环。
test('a cold-store creation failure is remembered instead of retried at every boundary', async () => {
  let attempts = 0
  const engine = createEngine({
    persist: async () => {},
    nodeIdFor: (record, ordinal) => `reliability-node-${ordinal}`,
    hostVersion: 'reliability-test',
    services: { get: () => undefined },
    logger: { info() {}, warn() {}, error() {} },
    createClient: async () => {
      attempts += 1
      throw new Error('cold store unavailable')
    },
  })
  const record = makeEngineRecord(buildSession({ operations: 1 }))

  await assert.rejects(() => engine.ensureClient(record), /cold store unavailable/)
  await assert.rejects(() => engine.ensureClient(record), /cold store unavailable/)
  assert.equal(attempts, 1, 'the factory must run exactly once; later calls rethrow the cached failure')
  assert.ok(record.clientError, 'the failure must be remembered on the record')
  assert.equal(record.client, null, 'no half-built client may be cached')
})

