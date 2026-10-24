/**
 * 0.13.2-beta.3 守卫：第 2 轮真机排查的 8 条缺陷（N-01…N-08）。
 *
 * 每条断言都对应一个**真实会话里发生过的**可观察后果，而不是实现细节：
 *   N-01 全量卡同类目标题只出现一次（旧：11 次）
 *   N-02 增量卡不出现相邻重复行、不留空段
 *   N-03 回注命中项带原文摘录（旧：只有指针）
 *   N-04 全量卡不自指「见全量卡」，且真的印出类目兜底次序
 *   N-05 同一毫秒内的建锁残留必须被清扫（旧：随机漏清）
 *   N-06 span 候选记生产渲染格式；归档行落 spanLabel 与批次口径；旧行可迁移恢复
 *   N-07 停用回执给出跳过原因（旧：「原因见上」而上面没有原因）
 *   N-08 客户端解 volatile；defaultFullHistory 已注入；schema 声明两个字段
 *
 * 夹具一律用**产品真实入口**（applyOperations / restoreReceipts / acquireWriteLock），
 * 不自己拼一个「和生产同口径」的渲染器——那正是 N-06a 让测试恒真的原因。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { FakeSession, FakeColdStore, fakeMeter, operation } from './helpers/fake-host.mjs'
import {
  RETENTION_CLASSES,
  DROP_ORDER,
  renderWorkingStateCard,
  workingStateCardDelta,
} from '../src/v2/working-state.mjs'
import { acquireWriteLock, writeLockDirectoryFor, WRITE_LOCK_KIND } from '../src/v2/write-lock.mjs'
import {
  RECEIPT_FORMAT_SPAN_SLIM,
  RECEIPT_FORMAT_SPAN_V2,
  V2_RECEIPT_MARKER,
  buildReceipt,
  buildSpanReceipt,
} from '../src/core.mjs'
import { applyOperations, archiveMac, restoreReceipts, describeRestoreSkipReasons } from '../src/apply.mjs'
import { bodyOfSpan, collectHistoryCandidates, spanLabelOf } from '../src/v2/history.mjs'
import { recallPreviewOf } from '../src/v2/client-adapter.mjs'

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src')

async function withTemp(name, body) {
  const root = await mkdtemp(path.join(tmpdir(), `mcl-beta3-${name}-`))
  try {
    await body(root)
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
}

const stateWithSoft = (n) => ({
  protection: { humanRequest: { text: 'do the thing', sourceId: 'seq:20' } },
  retention: {
    [RETENTION_CLASSES.NON_ESSENTIAL_HISTORY]: Array.from({ length: n }, (_, i) => ({
      lines: ['进度 seq:' + (1000 + i) + ' 工具 run_code 状态 result-visible'],
      source: 'surface:progress',
      sourceRef: 'record-' + i,
    })),
  },
})

const SOFT_TITLE = '■ 软保留·非必要历史（可丢弃）（soft/non-essential-history）'

// ------------------------------------------------------------------ N-01

test('N-01 全量卡同类目只印一个标题，内容行一个不少', () => {
  const card = renderWorkingStateCard(stateWithSoft(3), { budgetTokens: 20000 })
  const lines = card.text.split('\n')
  assert.equal(lines.filter((line) => line === SOFT_TITLE).length, 1, '同一软类目标题只能出现一次')
  assert.equal(lines.filter((line) => line.startsWith('- 进度 seq:')).length, 3, '三项内容都必须在卡里')
  // 预算不足时仍按项丢弃并如实报类目（合并不改变丢弃语义）
  const tight = renderWorkingStateCard(stateWithSoft(3), { budgetTokens: card.hardTokens + 40 })
  assert.ok(tight.dropped.length > 0)
  assert.ok(tight.droppedClasses.some((row) => row.class === RETENTION_CLASSES.NON_ESSENTIAL_HISTORY))
  assert.match(tight.text, /因预算丢弃/)
})

// ------------------------------------------------------------------ N-02

test('N-02 增量卡没有相邻重复行，也没有空段标题', () => {
  const prev = renderWorkingStateCard(stateWithSoft(1), { budgetTokens: 20000 })
  const next = renderWorkingStateCard(stateWithSoft(2), { budgetTokens: 20000 })
  const delta = workingStateCardDelta({ previousText: prev.text, nextText: next.text })
  assert.ok(delta, '有真实变化时必须产出增量卡')
  const lines = delta.text.split('\n')
  const duplicates = []
  for (let i = 1; i < lines.length; i += 1) if (lines[i] === lines[i - 1]) duplicates.push(lines[i])
  assert.deepEqual(duplicates, [], '增量卡不得出现相邻重复行')
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].startsWith('■ 软保留')) continue
    const nextLine = lines[i + 1] ?? ''
    assert.ok(nextLine.startsWith('- ') || nextLine === '', '软段标题后面必须紧跟内容行：' + lines[i])
  }
  assert.match(delta.text, /进度 seq:1001/)

  // N-02 的真实触发条件：新增行**本身就是段标题**（这里让一个新的软类目首次出现；
  // beta.8 起软保留只有非必要历史与未验证证据两类，用后者造「新类目首次出现」）。
  // 旧实现会先补一次「前导标题」、再把标题当变化行印一次，于是相邻两行完全相同。
  const withQuestion = stateWithSoft(1)
  withQuestion.retention[RETENTION_CLASSES.UNVERIFIED_EVIDENCE] = [{
    lines: ['未决：回注摘录长度是否应可配置'],
    source: 'claim:q-1',
    sourceRef: 'q-1',
  }]
  const grown = renderWorkingStateCard(withQuestion, { budgetTokens: 20000 })
  const grownDelta = workingStateCardDelta({
    previousText: renderWorkingStateCard(stateWithSoft(1), { budgetTokens: 20000 }).text,
    nextText: grown.text,
  })
  assert.ok(grownDelta, '新类目出现时必须产出增量卡')
  const grownLines = grownDelta.text.split('\n')
  const grownDup = []
  for (let i = 1; i < grownLines.length; i += 1) {
    if (grownLines[i] === grownLines[i - 1]) grownDup.push(grownLines[i])
  }
  assert.deepEqual(grownDup, [], '新增段标题不得被当成变化行再印一次')
  for (let i = 0; i < grownLines.length; i += 1) {
    if (!grownLines[i].startsWith('■ 软保留·')) continue
    assert.ok((grownLines[i + 1] ?? '').startsWith('- '), '段标题后面必须紧跟内容行：' + grownLines[i])
  }
  assert.match(grownDelta.text, /未决：回注摘录长度是否应可配置/)
})

// ------------------------------------------------------------------ N-04

test('N-04 全量卡不自指「见全量卡」，并真的印出类目兜底次序', () => {
  const full = renderWorkingStateCard(stateWithSoft(2), { budgetTokens: 20000 })
  assert.ok(!full.text.includes('见全量卡'), '全量卡不能指向自己')
  const missing = DROP_ORDER.filter((cls) => !full.text.includes(cls))
  assert.deepEqual(missing, [], '类目兜底次序必须真的渲染出来')
  // 增量卡引用全量卡是成立的，不得被一起改掉
  const delta = workingStateCardDelta({
    previousText: renderWorkingStateCard(stateWithSoft(1), { budgetTokens: 20000 }).text,
    nextText: full.text,
  })
  assert.match(delta.text, /最近一张全量卡/)
})

// ------------------------------------------------------------------ N-05

test('N-05 同一毫秒内的建锁残留必须被清扫（粗时钟 vs 细时钟）', async () => {
  await withTemp('n05', async (dir) => {
    const lockDir = writeLockDirectoryFor(dir)
    const parent = path.dirname(lockDir)
    const orphan = `${lockDir}.00000000-deadbeef.tmp`
    await mkdir(orphan, { recursive: true })
    await writeFile(path.join(orphan, 'owner.json'), JSON.stringify({
      kind: WRITE_LOCK_KIND, token: 'dead', pid: 1, host: hostname(), heartbeatAt: 0,
    }), 'utf8')
    // 残留 mtime 钉在某个整数毫秒的 +0.7ms 处；获取开始时刻是该毫秒的整数部分。
    const startedMs = Math.floor(Date.now()) - 1000
    await utimes(orphan, startedMs / 1000 + 0.0007, startedMs / 1000 + 0.0007)
    const mtime = (await stat(orphan)).mtimeMs
    assert.ok(mtime % 1 > 0, '夹具必须真的落在毫秒的小数段（否则测不到精度差）')

    const handle = await acquireWriteLock(dir, { waitMs: 300, now: () => startedMs })
    const leftovers = (await readdir(parent)).filter((n) => n.includes('.write-lock.') && n.endsWith('.tmp'))
    assert.deepEqual(leftovers, [], '同毫秒的残留也必须清掉')
    handle.release()

    // 反面：本次获取开始之后出现的竞争者 stage 不得被误清（判据没被放宽成无界）。
    const competitor = `${lockDir}.11111111-cafebabe.tmp`
    await mkdir(competitor, { recursive: true })
    await utimes(competitor, (startedMs + 5) / 1000, (startedMs + 5) / 1000)
    const second = await acquireWriteLock(dir, { waitMs: 300, now: () => startedMs })
    assert.ok((await readdir(parent)).includes(path.basename(competitor)), '竞争者 stage 不得被误清')
    second.release()
  })
})

// ------------------------------------------------------------------ N-06

test('N-06a span 候选记的是生产渲染格式，且行内字段能逐字节重建表面回执', async () => {
  const LONG = '这是一段足够长的用户正文，用来让它成为全历史归档的候选。'.repeat(20)
  const nodes = [1, 2]
  const events = new Map([
    [1, { type: 'user/message', data: { content: [{ type: 'text', text: LONG }], source: { kind: 'user', rpcId: 'rpc-1' } } }],
    [2, { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: LONG }] } } }],
  ])
  const { candidates } = collectHistoryCandidates({
    surfaceNodes: nodes,
    eventAt: (seq) => events.get(seq) ?? null,
    measuredNodes: nodes.map(() => ({ tokens: 400, heuristicTokens: 400 })),
    retainOperations: 0,
    fullHistory: true,
    archivedRanges: [],
    minimumChars: 0,
    lastAssistantSeq: null,
  })
  assert.ok(candidates.length > 0)
  for (const candidate of candidates) {
    assert.equal(candidate.receiptFormat, RECEIPT_FORMAT_SPAN_V2, '候选必须记生产渲染格式（7）')
    assert.equal(candidate.spanLabel, spanLabelOf(candidate.spanKind), '候选必须带标签')
    const surface = buildSpanReceipt({
      label: candidate.spanLabel,
      range: { start: candidate.rangeStart, end: candidate.rangeEnd },
      nodeId: 'mcl2-x',
      hash: 'hash',
      chars: candidate.chars,
      tokens: candidate.originalTokens,
      chunks: 1,
      marker: V2_RECEIPT_MARKER,
      formatVersion: candidate.receiptFormat,
      releasedTokens: candidate.originalTokens,
      errorLine: null,
    })
    const restored = buildSpanReceipt({
      label: candidate.spanLabel,
      range: { start: candidate.rangeStart, end: candidate.rangeEnd },
      nodeId: 'mcl2-x',
      hash: 'hash',
      chars: candidate.chars,
      tokens: candidate.originalTokens,
      chunks: 1,
      marker: V2_RECEIPT_MARKER,
      formatVersion: candidate.receiptFormat,
      releasedTokens: candidate.originalTokens,
      errorLine: null,
    })
    assert.equal(surface, restored)
  }
})

test('N-06b/c 归档行落 spanLabel 与批次口径，且 off 能逐字节恢复', async () => {
  await withTemp('n06row', async () => {
    const session = new FakeSession({ id: 'session-n06' })
    session.append('system/message', {
      turn: 0, step: 0,
      message: { id: 'sys', role: 'system', content: [{ type: 'text', text: 'sys' }], source: { kind: 'system-prompt' } },
    }, { surfaceOp: 'append' })
    const longText = '这一段足够长，应当作为普通历史段被归档，并且之后必须能原样恢复。'.repeat(40)
    // 全历史模式下**人类消息全部原位保留**（不可压缩凭证），span 候选只能是
    // 助手正文；最新人类请求也受保护，所以这里只放一条短的收尾请求。
    session.append('assistant/message', {
      turn: 1, step: 1,
      message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: longText }], source: { kind: 'model' } },
    }, { surfaceOp: 'append' })
    session.append('user/message', {
      id: 'u-latest', role: 'user', content: [{ type: 'text', text: '继续' }], source: { kind: 'user', rpcId: 'rpc-2' },
    }, { surfaceOp: 'append' })
    operation({ session, callId: 'c1', toolName: 'read', args: '{"file":"a"}', result: 'x'.repeat(3000), turn: 2, step: 1 })
    operation({ session, callId: 'c2', toolName: 'read', args: '{"file":"b"}', result: 'y'.repeat(3000), turn: 3, step: 1 })

    const measured = fakeMeter.measure(session)
    const view = collectHistoryCandidates({
      surfaceNodes: session.surface.nodes,
      eventAt: (seq) => session.eventAt(seq),
      measuredNodes: measured.nodes,
      retainOperations: 0,
      openTurn: null,
      archivedRanges: [],
      minimumChars: 0,
      lastAssistantSeq: null,
      fullHistory: true,
    })
    const spanCandidate = view.candidates.find((row) => row.spanKind !== 'operation')
    const operationCandidates = view.candidates.filter((row) => row.spanKind === 'operation')
    assert.ok(spanCandidate && operationCandidates.length >= 2, '夹具必须同时覆盖 span 与操作')

    const { planCooling } = await import('../src/apply.mjs')
    const rows = []
    const plan = planCooling({
      candidates: view.candidates,
      meter: fakeMeter,
      nodeIdFor: (() => { let i = 0; return () => 'mcl2-n06-' + (++i) })(),
      retainOperations: 0,
      // 批阈值 3：三个候选（1 span + 2 操作）全部入批；两个相邻操作合成一条批次回执，
      // span 因为中间夹着未归档的最新人类请求而单独成一条。
      batchSize: 3,
      minNetReleaseTokens: 1,
      receiptMarker: V2_RECEIPT_MARKER,
      receiptOf: (row, { nodeId, hash, marker }) => (row.spanKind === 'operation'
        ? buildReceipt({
          tools: row.tools,
          range: { start: row.rangeStart, end: row.rangeEnd },
          callIds: row.callIds,
          nodeId,
          hash,
          chars: row.chars,
          tokens: row.originalTokens,
          chunks: row.chunkCount ?? 1,
          marker,
          formatVersion: 6,
          releasedTokens: row.originalTokens,
          errorLine: row.firstErrorLine ?? null,
        })
        : buildSpanReceipt({
          label: row.spanLabel,
          range: { start: row.rangeStart, end: row.rangeEnd },
          nodeId,
          hash,
          chars: row.chars,
          tokens: row.originalTokens,
          chunks: row.chunkCount ?? 1,
          marker,
          formatVersion: row.receiptFormat,
          releasedTokens: row.originalTokens,
          errorLine: null,
        })),
    })
    const store = new FakeColdStore()
    const outcomes = await applyOperations({
      session,
      client: store,
      units: plan.units,
      meter: fakeMeter,
      hostVersion: 'test',
      bodyOf: (liveSession, liveUnit) => bodyOfSpan(liveSession, liveUnit),
      receiptMarker: V2_RECEIPT_MARKER,
      batchThreshold: 3,
      batchMembers: plan.units.length,
      onOutcome: async (outcome) => { rows.push(outcome) },
    })
    assert.ok(outcomes.length > 0)

    const batchRows = rows.filter((row) => row.receiptFormat === 8)
    assert.ok(batchRows.length > 0, '夹具必须产出批次回执')
    for (const row of batchRows) {
      assert.equal(row.batchThreshold, 3, '批次阈值必须随 outcome 带出（否则恢复只能回落）')
      assert.equal(row.batchMembers, plan.units.length, '本批成员数必须随 outcome 带出')
    }
    const spanRows = rows.filter((row) => row.receiptFormat === RECEIPT_FORMAT_SPAN_V2)
    assert.ok(spanRows.length > 0, '夹具必须产出 span 回执')
    for (const row of spanRows) assert.equal(typeof row.spanLabel, 'string', 'span 行必须带标签')

    // 恢复：按行内字段逐字节重建 → 全部恢复
    const receiptRows = rows.map((row) => ({
      rangeStart: row.rangeStart,
      rangeEnd: row.rangeEnd,
      callIds: row.callIds,
      tools: row.tools,
      nodeId: row.nodeId,
      hash: row.hash,
      chars: row.chars,
      originalTokens: row.originalTokens,
      replacementSeq: row.replacementSeq,
      receiptFormat: row.receiptFormat,
      spanKind: row.spanKind,
      spanLabel: row.spanLabel,
      locators: row.locators ?? [],
      statuses: row.statuses ?? [],
      chunkCount: row.chunkCount ?? 1,
      batchSize: row.batchSize,
      batchThreshold: row.batchThreshold,
      batchMembers: row.batchMembers,
      releaseCapped: row.releaseCapped,
    }))
    const restored = await restoreReceipts({ session, client: store, receipts: receiptRows, receiptMarker: V2_RECEIPT_MARKER })
    const skipped = restored.filter((row) => row.state !== 'restored')
    assert.deepEqual(skipped.map((row) => row.reason), [], '所有回执都必须能恢复')
  })
})

test('N-06 旧行迁移：缺 spanLabel 的旧 span 行按 spanKind 反推后恢复', async () => {
  await withTemp('n06migrate', async () => {
    const session = new FakeSession({ id: 'session-migrate' })
    const longText = '旧行迁移用的正文，长度必须够长。'.repeat(60)
    session.append('user/message', {
      id: 'u1', role: 'user', content: [{ type: 'text', text: longText }], source: { kind: 'user', rpcId: 'rpc-1' },
    }, { surfaceOp: 'append' })
    const store = new FakeColdStore()
    // 手工造一条「旧行」：格式 7、没有 spanLabel，但表面是按「用户消息」渲染的。
    const body = longText
    const hash = archiveMac(body)
    const nodeId = 'mcl2-old-000001'
    // 冷节点按 `_p1` 编号（archiveChunkNodeId 的单一命名规则）。
    await store.rememberArchived({ nodeId: nodeId + '_p1', text: body, range: { start: 1, end: 1 }, tools: [], callIds: [], spanKind: 'turn.user', contentHash: hash })
    const surfaceText = buildSpanReceipt({
      label: '用户消息',
      range: { start: 1, end: 1 },
      nodeId,
      hash,
      chars: body.length,
      tokens: 100,
      chunks: 1,
      marker: V2_RECEIPT_MARKER,
      formatVersion: RECEIPT_FORMAT_SPAN_V2,
      releasedTokens: 100,
      errorLine: null,
    })
    const replacement = session.append('user/message', {
      id: 'r1', role: 'user', content: [{ type: 'text', text: surfaceText }], source: { kind: 'user', rpcId: 'rpc-r' },
    }, { surfaceOp: 'append' })

    const legacyRow = {
      rangeStart: 1, rangeEnd: 1, nodeId, hash, chars: body.length, originalTokens: 100,
      replacementSeq: replacement.seq, receiptFormat: 5, spanKind: 'turn.user',
      callIds: [], tools: [], chunkCount: 1,
    }
    const restored = await restoreReceipts({ session, client: store, receipts: [legacyRow], receiptMarker: V2_RECEIPT_MARKER })
    assert.equal(restored[0].state, 'restored', JSON.stringify(restored[0]))
    assert.equal(restored[0].migrated?.spanLabel, '用户消息', '迁移必须记下反推出的标签')
    assert.equal(restored[0].migrated?.receiptFormat, RECEIPT_FORMAT_SPAN_V2)
  })
})

// ------------------------------------------------------------------ N-07

test('N-07 停用回执的跳过原因按「原因 × 段数」聚合，不再写「见上」', async () => {
  const text = describeRestoreSkipReasons([
    { reason: '回执正文已变化，拒绝覆盖', count: 58 },
    { reason: '冷节点缺失', count: 2 },
  ])
  assert.match(text, /58 段：回执正文已变化/)
  assert.match(text, /2 段：冷节点缺失/)
  assert.equal(describeRestoreSkipReasons([]), '')
  // 光有聚合函数不够：两条回执路径必须**真的调用**它，且不得再写「原因见上」
  // （上面没有原因，等于把解释丢掉）。
  for (const file of ['v2/runtime-lifecycle.mjs', 'v2/runtime-settings.mjs']) {
    const source = await readFile(path.join(SRC, file), 'utf8')
    assert.match(source, /describeRestoreSkipReasons\(/, file + ' 必须给出跳过原因')
    // 只钉**回执文案**（`restore 跳过，原因见上`）：注释里提到旧文案是解释，不是回执。
    assert.ok(!source.includes('restore 跳过，原因见上'), file + ' 的回执不得再写「原因见上」')
  }
})

// ------------------------------------------------------------------ N-08

test('N-08a 客户端设置读取必须解开 volatile 引用', async () => {
  const source = await readFile(path.join(SRC, 'client.js'), 'utf8')
  const start = source.indexOf('function settingsValueOf')
  assert.ok(start > 0)
  const body = source.slice(start, start + 1200)
  assert.match(body, /\.get\(\)/, 'settingsValueOf 必须先解引用 volatile（否则每个字段都读成 undefined）')
})

test('N-08b/c index.mjs 注入 defaultFullHistory，schema 声明 fullHistory 与 retainOperations', async () => {
  const source = await readFile(path.join(SRC, 'index.mjs'), 'utf8')
  assert.match(source, /defaultFullHistory:\s*resolveFullHistoryDefault/, '必须注入全局默认，否则空开关')
  assert.match(source, /fullHistory:\s*SCHEMAS\.boolean\(\)/, 'fullHistory 必须进 schema')
  assert.match(source, /retainOperations:\s*SCHEMAS\.natural\(\)/, 'retainOperations 必须进 schema')
})

// ------------------------------------------------------------------ N-03

test('N-03 回注摘录是确定性首部切片，且不含换行', () => {
  const body = '修复写锁的两阶段创建：先在临时目录写好 owner.json 再 rename 成锁目录。'
  const preview = recallPreviewOf(body)
  assert.ok(preview.includes('owner.json'))
  assert.equal(preview, recallPreviewOf(body), '同样入参必须逐字节一致（不扰动前缀缓存）')
  assert.ok(!preview.includes('\n'))
  const long = recallPreviewOf('x'.repeat(1000))
  assert.ok(Array.from(long).length <= 160)
  assert.ok(long.endsWith('…'))
})

// ------------------------------------------------------------------ N-06b/c（真实入口）

/**
 * 走**产品真实入口**（apply → `/memory-lab on|set|now|off`）核对归档行的持久字段。
 *
 * 为什么必须有这一条：`applyOperations` 只把字段放进 outcome，**落盘发生在
 * apply-engine 的 onOutcome 里**。只断言 outcome 的测试在「行没落字段」时仍然全绿——
 * 而那正是真实会话 58/60 段不可恢复的直接原因。
 */
function createStubContext(meter) {
  const listeners = new Map()
  const commands = []
  const cleanups = []
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    get(name) {
      if (name === 'tokenMeter') return meter
      if (name === 'llm') return { resolveModelInfo: async () => ({ context: { contextWindow: 100000 }, defaultMaxTokens: 4096 }) }
      if (name === 'agents') return { get: () => undefined }
      return undefined
    },
    on(event, handler, options) {
      const rows = listeners.get(event) ?? []
      if (options?.prepend) rows.unshift(handler)
      else rows.push(handler)
      listeners.set(event, rows)
      return () => listeners.set(event, (listeners.get(event) ?? []).filter((row) => row !== handler))
    },
    effect(fn) {
      const local = []
      const result = fn()
      if (result && typeof result.next === 'function') {
        let step = result.next()
        while (!step.done) { local.push(step.value); step = result.next() }
      } else if (typeof result === 'function') local.push(result)
      cleanups.push(...local)
      return () => { for (const cleanup of local.splice(0).reverse()) cleanup?.() }
    },
    commands: { register(definition) { commands.push(definition); return () => {} } },
    sessionProjections: { register() { return () => {} } },
    tools: { register() { return () => {} } },
    inject(deps, callback) { if (deps.every((dep) => ctx[dep] !== undefined)) callback(ctx); return { dispose() {} } },
    async _dispose() { for (const cleanup of cleanups.splice(0).reverse()) { try { await cleanup?.() } catch {} } },
    _commands: commands,
  }
  return ctx
}

function buildEndToEndSession(sessionId) {
  const session = new FakeSession({ id: sessionId })
  session.append('system/message', {
    turn: 0, step: 0,
    message: { id: 'sys', role: 'system', content: [{ type: 'text', text: 'system prompt' }], source: { kind: 'system-prompt' } },
  }, { surfaceOp: 'append' })
  const longText = (prefix) => prefix + '这一段足够长，应当作为普通历史段被归档，并且之后必须能原样恢复。'.repeat(60)
  for (let index = 0; index < 8; index += 1) {
    const callId = 'call-' + (index + 1)
    session.append('assistant/message', {
      turn: index + 1, step: 1,
      message: {
        id: 'm-' + callId, role: 'assistant',
        content: [{ type: 'tool-call', id: callId, name: 'read', arguments: '{"file":"file-' + (index + 1) + '.md"}' }],
        source: { kind: 'model', provider: 'fake', model: 'fake-model' },
      },
    }, { surfaceOp: 'append' })
    session.append('tool/call', { callId, name: 'read', arguments: '{"file":"file-1.md"}' })
    session.append('tool/result', {
      turn: index + 1, step: 1,
      message: {
        id: 'r-' + callId, role: 'tool',
        content: [{ type: 'text', text: '标记-' + index + ':' + '内容'.repeat(2000) }],
        source: { kind: 'tool', callId }, toolCallId: callId,
      },
    }, { surfaceOp: 'append' })
    session.append('turn/end', { turn: index + 1, reason: { kind: 'complete' } })
  }
  // 长助手正文 → 极短消息（断开相邻）→ 长助手正文：制造单段 span 回执（format 7）。
  session.append('assistant/message', {
    turn: 9, step: 1,
    message: { id: 'a-long-1', role: 'assistant', content: [{ type: 'text', text: longText('助手总结甲：') }], source: { kind: 'model', provider: 'fake', model: 'fake-model' } },
  }, { surfaceOp: 'append' })
  session.append('assistant/message', {
    turn: 9, step: 2,
    message: { id: 'a-short', role: 'assistant', content: [{ type: 'text', text: '好。' }], source: { kind: 'model', provider: 'fake', model: 'fake-model' } },
  }, { surfaceOp: 'append' })
  session.append('assistant/message', {
    turn: 9, step: 3,
    message: { id: 'a-long-2', role: 'assistant', content: [{ type: 'text', text: longText('助手总结乙：') }], source: { kind: 'model', provider: 'fake', model: 'fake-model' } },
  }, { surfaceOp: 'append' })
  session.append('user/message', {
    id: 'u-latest', role: 'user',
    content: [{ type: 'text', text: longText('最新请求：') }],
    source: { kind: 'user', rpcId: 'rpc-latest' },
  }, { surfaceOp: 'append' })
  return session
}

test('N-06b/c 真实入口：归档行落 spanLabel 与批次口径，off 后 8/8 段全部恢复', async () => {
  const { apply: applyPlugin } = await import('../src/index.mjs')
  const { v2SessionDirectoryFor } = await import('../src/v2/state.mjs')
  const { readFile: readText } = await import('node:fs/promises')
  const sessionId = 'n06e2e0000000000000001'
  const lab = await mkdtemp(path.join(tmpdir(), 'mcl-beta3-e2e-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = lab
  try {
    const ctx = createStubContext(fakeMeter)
    await applyPlugin(ctx)
    const session = buildEndToEndSession(sessionId)
    const agent = {
      session,
      ctx: { tools: { schemas: () => [], restrict: () => () => {}, guard: () => () => {}, register: () => () => {} } },
      async runMaintenance(action) { return action(new AbortController().signal) },
    }
    const run = (rawInput) => {
      const definition = ctx._commands.find((row) => row.name === 'memory-lab')
      return definition.handler({ agent, rawInput, signal: new AbortController().signal })
    }
    const on = await run('on')
    assert.equal(on.kind, 'success', on.text)
    for (const setting of ['set retain 1', 'set batch 4']) await run(setting)
    for (let round = 0; round < 8; round += 1) {
      const out = await run('now')
      if (!String(out.text).includes('已归档')) break
    }
    await run('set batch 1')
    for (let round = 0; round < 10; round += 1) {
      const out = await run('now')
      if (!String(out.text).includes('已归档')) break
    }

    const stateFile = path.join(v2SessionDirectoryFor(path.join(lab, '.memory-context-lab'), sessionId), 'state.json')
    const rowsBefore = JSON.parse(await readText(stateFile, 'utf8')).archive ?? []
    assert.ok(rowsBefore.length > 0, '夹具必须真的归档出若干行')

    const batchRows = rowsBefore.filter((row) => row.receiptFormat === 8)
    assert.ok(batchRows.length > 0, '夹具必须产出批次回执行')
    for (const row of batchRows) {
      assert.ok(Number.isInteger(row.batchThreshold), '批次行必须落 batchThreshold（否则恢复只能回落）')
      assert.ok(Number.isInteger(row.batchMembers), '批次行必须落 batchMembers')
    }
    // P0-3（Z-01）：第一批印全样例（format 7），后续批次走 slim（format 10）——
    // 两种都是合法归档行，恢复侧对两种都能逐字节重建。
    const spanRows = rowsBefore.filter((row) => row.receiptFormat === RECEIPT_FORMAT_SPAN_V2
      || row.receiptFormat === RECEIPT_FORMAT_SPAN_SLIM)
    assert.ok(spanRows.length > 0, '夹具必须产出 span 回执行')
    for (const row of spanRows) {
      assert.equal(typeof row.spanLabel, 'string', 'span 行必须落 spanLabel（否则恢复只能回落成「历史片段」）')
      assert.ok(row.spanLabel.length > 0)
    }

    const off = await run('off')
    const match = /恢复 (\d+)\/(\d+) 段原文/.exec(off.text)
    assert.ok(match, 'off 回执必须报出恢复计数：' + off.text.split('\n')[0])
    assert.equal(Number(match[1]), Number(match[2]), 'off 必须恢复全部归档段，不得有 restore-skipped：' + off.text.split('\n')[0])
    const rowsAfter = JSON.parse(await readText(stateFile, 'utf8')).archive ?? []
    const skipped = rowsAfter.filter((row) => String(row.status).startsWith('restore-skipped'))
    assert.deepEqual(skipped.map((row) => row.status), [], '不得有 restore-skipped 行')
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(lab, { recursive: true, force: true }).catch(() => {})
  }
})
