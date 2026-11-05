/**
 * P4 摘要派生对象与回执预算（0.15.0）：
 * - 确定性提取不猜结果（outcome 恒 unknown，openItems 明写「结果待查」）；
 * - SummaryArtifact 闭合形状、来源/hash 齐全，跨来源引用/超长/未知字段拒绝；
 * - P2-4：读/导出重算来源指纹；篡改 sources 后 read/export 都不可见且有原因；
 * - P3-1：canonical 指纹覆盖身份/派生字段，不同对象不被同载荷吞掉；
 * - P3-2：回执预算统一按码点，emoji 摘要不被无声丢弃；
 * - 回执基础身份不被摘要挤掉（摘要只占剩余预算）；
 * - 摘要不可变（新对象 + supersedes），forget 级联整条隐藏，导出同口径。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { join } from 'node:path'

import { SUMMARY_LIMITS } from '../src/v3/contracts/summaries.mjs'
import {
  buildSummaryArtifact,
  canonicalSummaryMaterial,
  normalizeSummaryDraft,
  sourceSetMaterial,
  summaryIntegrityOf,
  summaryVisibilityOf,
  validateSummaryArtifact,
} from '../src/v3/domain/compress/summary-artifact.mjs'
import { CANDIDATE_GENERATOR_VERSION, summarizeRecordsStructured } from '../src/v3/domain/compress/summary.mjs'
import { RECEIPT_MAX_CHARS, RECEIPT_MIN_SUMMARY_CHARS, RECEIPT_SUMMARY_SAFETY_MARGIN, renderArchiveReceipt } from '../src/v3/domain/archive/receipt.mjs'
import { buildExportBundle } from '../src/v3/domain/export/bundle.mjs'
import { appendSummary, listSummaries, summariesPath } from '../src/v3/adapters/storage/summary-store.mjs'
import { attachV3Engine } from '../src/v3/entry/v3-entry.mjs'
import { createFakeSession } from './helpers/fake-session.mjs'

const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)
const ID_A = 'v3r-0123456789abcdef'
const ID_B = 'v3r-fedcba9876543210'
const sha256 = (text) => createHash('sha256').update(text).digest('hex')
const SOURCES = Object.freeze([{ recordId: ID_A, hash: HASH_A }, { recordId: ID_B, hash: HASH_B }])
const FINGERPRINT = sha256(sourceSetMaterial(SOURCES))

function records() {
  return [
    { id: ID_A, kind: 'message-user', payload: { text: '目标：修复参数未传递的问题。' + 'x'.repeat(80) } },
    { id: ID_B, kind: 'message-assistant', payload: { text: '已修正并运行测试。' } },
  ]
}

function artifactInput(overrides = {}) {
  return {
    summaryId: 'v3s-0123456789abcdef',
    sessionKey: 'sess-1',
    sources: SOURCES,
    generator: 'model',
    generatorVersion: 'model-draft-v1',
    draft: { shortText: '修正完成；真实宿主行为待验证。', detail: '详细摘要', outcome: 'partial', evidenceRefs: [ID_A] },
    createdAt: 1,
    sourceSetFingerprint: FINGERPRINT,
    ...overrides,
  }
}

test('确定性提取：不推断成功，未知结果显式写「结果待查」', () => {
  const first = summarizeRecordsStructured(records())
  const second = summarizeRecordsStructured(records())
  assert.deepEqual(first, second, '同输入必须逐字段相同（固定呈现）')
  assert.equal(first.outcome, 'unknown', '没有完成度证据时不得写 succeeded')
  assert.ok(first.openItems.some((item) => item.includes('结果待查')))
  assert.match(first.shortText, /结果待查/)
  assert.deepEqual(first.evidenceRefs, [ID_A, ID_B])
  assert.ok(!first.detail.includes('测试通过'), '不得从日志字符串推断测试通过')
})

test('SummaryArtifact：闭合形状 + 来源/hash；跨来源引用/超长/未知字段全部拒绝', () => {
  const artifact = buildSummaryArtifact(artifactInput())
  assert.deepEqual(validateSummaryArtifact(artifact).ok, true)
  assert.equal(artifact.verification, 'evidence-linked', '逐项来源齐全时只到 evidence-linked，仍非已证实')
  assert.equal(artifact.sources.length, 2)
  assert.equal(artifact.sourceSetFingerprint, FINGERPRINT)

  const extractive = buildSummaryArtifact(artifactInput({ generator: 'extractive', draft: summarizeRecordsStructured(records()) }))
  assert.equal(extractive.verification, 'unverified')

  assert.throws(() => buildSummaryArtifact(artifactInput({ draft: { shortText: 'x', evidenceRefs: ['v3r-ffffffffffffffff'] } })), /来源集合之外/)
  assert.throws(() => buildSummaryArtifact(artifactInput({ draft: { shortText: 'x'.repeat(SUMMARY_LIMITS.shortText + 5) } })), /shortText/)
  assert.throws(() => buildSummaryArtifact(artifactInput({ sources: [] })), /至少需要一条来源/)
  assert.throws(() => buildSummaryArtifact(artifactInput({ sources: [{ recordId: 'v3r-0123456789abcdef', hash: 'not-a-hash' }] })), /hash 非法/)

  const extra = { ...artifact, surprise: true }
  assert.equal(validateSummaryArtifact(extra).ok, false)
  assert.ok(validateSummaryArtifact(extra).errors.some((row) => row.includes('未知字段')))
  assert.equal(normalizeSummaryDraft({ shortText: 'x', unknownKey: 1 }).ok, false)

  // 不可变：同一来源再物化是另一个对象；supersedes 只指向旧对象，旧对象字节不变
  const before = canonicalSummaryMaterial(artifact)
  const next = buildSummaryArtifact(artifactInput({ summaryId: 'v3s-ffffffffffffffff', supersedes: artifact.summaryId }))
  assert.notEqual(next.summaryId, artifact.summaryId)
  assert.equal(next.supersedes, artifact.summaryId)
  assert.equal(canonicalSummaryMaterial(artifact), before)
})

test('P2-4：来源指纹与 sources 对账；篡改 sources 后不可见（原因可观测）', () => {
  const artifact = buildSummaryArtifact(artifactInput())
  assert.equal(validateSummaryArtifact(artifact, { sha256 }).ok, true)
  assert.deepEqual(summaryIntegrityOf(artifact, sha256), { ok: true, reason: 'verified' })
  assert.deepEqual(summaryVisibilityOf(artifact, [], { sha256 }), { visible: true, reason: 'visible' })

  // 删掉被遗忘/被误删的 B 但保留旧指纹：形状仍合法，必须被对账判为不可信。
  const tampered = { ...artifact, sources: artifact.sources.filter((source) => source.recordId === ID_A) }
  const checked = validateSummaryArtifact(tampered, { sha256 })
  assert.equal(checked.ok, false)
  assert.ok(checked.errors.some((row) => row.includes('sourceSetFingerprint 与 sources 不一致')))
  assert.deepEqual(summaryVisibilityOf(tampered, [], { sha256 }), { visible: false, reason: 'source-set-mismatch' })
  // 防误杀：同一集合换个顺序仍应通过（指纹材料排序）。
  const reordered = { ...artifact, sources: [...artifact.sources].reverse() }
  assert.equal(validateSummaryArtifact(reordered, { sha256 }).ok, true)
})

test('P3-1：canonical 指纹覆盖身份/派生字段，同 ID 不同载荷不被静默吞掉', async () => {
  const base = buildSummaryArtifact(artifactInput())
  const variants = [
    ['createdAt', buildSummaryArtifact(artifactInput({ createdAt: 2 }))],
    ['supersedes', buildSummaryArtifact(artifactInput({ supersedes: 'v3s-ffffffffffffffff' }))],
    ['baseSummaryId', buildSummaryArtifact(artifactInput({ baseSummaryId: 'v3s-ffffffffffffffff' }))],
    ['baseRevision', buildSummaryArtifact(artifactInput({ baseRevision: 1 }))],
    ['redactionVersion', buildSummaryArtifact(artifactInput({ redactionVersion: 2 }))],
    ['idempotencyKey', buildSummaryArtifact(artifactInput({ idempotencyKey: 'idem-1' }))],
  ]
  for (const [field, variant] of variants) {
    assert.notEqual(canonicalSummaryMaterial(variant), canonicalSummaryMaterial(base), field + ' 必须进入指纹')
  }

  const root = await mkdtemp(path.join(tmpdir(), 'mcl-p4-canon-'))
  try {
    assert.equal((await appendSummary(root, base)).appended, true)
    // 同 summaryId、只改 createdAt：旧实现会当作同载荷返回 existing（静默吞掉），
    // 现在必须按身份撞车失败关闭。
    const conflict = await appendSummary(root, buildSummaryArtifact(artifactInput({ createdAt: 2 })))
    assert.equal(conflict.ok, false)
    assert.equal(conflict.reason, 'idempotency-conflict')
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})

test('P3-03：回执预算按码元统一，emoji 摘要既不被丢弃、也不把回执推过 400', () => {
  // 0.15.1 P3-03 改口径：P3-2 曾把预算改成「按码点」，但净收益判据（receiptText.length
  // < sourceChars）两端都是 UTF-16 码元——星平面字符让「码点预算」产出 2 倍码元的正文，
  // 回执被推过原文。现在只有一个单位（码元）：既保住 emoji 摘要，总长也不超 400。
  const recordIds = [ID_A]
  const base = renderArchiveReceipt({ startSeq: 1, endSeq: 1, recordIds })
  const withEmoji = renderArchiveReceipt({ startSeq: 1, endSeq: 1, recordIds, summary: '😀'.repeat(300) })
  assert.notEqual(withEmoji, base, 'emoji 摘要必须出现在回执里（不得被无声丢弃）')
  assert.match(withEmoji, /摘要：/)
  assert.ok(withEmoji.length <= RECEIPT_MAX_CHARS, '码元预算不得超 400（得到 ' + withEmoji.length + '）')
  assert.ok(withEmoji.length > [...withEmoji].length, '该用例确实含星平面字符（码元数 > 码点数）')
  // 裁剪不得产生半个代理对（落点回退一位）。
  const summaryLine = withEmoji.split('\n')[1]
  assert.ok(!/[\uD800-\uDBFF]$/.test(summaryLine.replace(/…$/, '')), '不得以半个代理对结尾')
})

test('回执预算：摘要只占剩余预算，基础身份（数量/区间/ID/恢复入口）不被挤掉', () => {
  const recordIds = Array.from({ length: 50 }, (_, index) => 'v3r-' + String(index).padStart(16, '0'))
  const receipt = renderArchiveReceipt({
    startSeq: 3, endSeq: 99, recordIds, operations: 2, unitLabel: '回合数',
    summary: '摘'.repeat(SUMMARY_LIMITS.shortText),
  })
  assert.ok([...receipt].length <= RECEIPT_MAX_CHARS)
  assert.match(receipt, /已把 50 条已完成历史（seq 3–99）/)
  assert.match(receipt, /回合数：2/)
  assert.match(receipt, /记录 ID：v3r-0000000000000000/)
  assert.match(receipt, /恢复：\/memory-lab restore/)
  assert.match(receipt, /摘要：/)
  // 摘要被裁剪到剩余预算（不是把恢复行截掉）
  assert.ok(receipt.indexOf('摘要：') < receipt.indexOf('恢复：'))
  const noSummary = renderArchiveReceipt({ startSeq: 3, endSeq: 99, recordIds, operations: 2, unitLabel: '回合数' })
  assert.ok(noSummary.length < receipt.length)
  assert.match(noSummary, /恢复：\/memory-lab restore/)
})

test('forget 可见性与导出：多源摘要整条隐藏，可见摘要正文再脱敏', () => {
  const artifact = buildSummaryArtifact(artifactInput())
  assert.deepEqual(summaryVisibilityOf(artifact, []), { visible: true, reason: 'visible' })
  assert.equal(summaryVisibilityOf(artifact, [ID_B]).visible, false, '任一来源被忘 → 整条隐藏')
  assert.equal(summaryVisibilityOf(artifact, [ID_B]).reason, 'forgotten-source')

  const visible = buildExportBundle({
    sessionKey: 'sess-1',
    records: [],
    forgotten: [],
    vouchers: [],
    summaries: [artifact],
    sha256,
  })
  assert.equal(visible.counts.summaries, 1)
  assert.equal(visible.counts.hiddenSummaries, 0)
  assert.equal(visible.summaries[0].hidden, false)
  assert.ok(visible.summaries[0].sources.length === 2, '导出保留来源 hash（可追溯）')

  const hidden = buildExportBundle({
    sessionKey: 'sess-1',
    records: [],
    forgotten: [ID_B],
    vouchers: [],
    summaries: [artifact],
    sha256,
  })
  assert.equal(hidden.counts.hiddenSummaries, 1)
  assert.deepEqual(hidden.summaries[0], { summaryId: artifact.summaryId, hidden: true, reason: 'forgotten-source' })
  assert.ok(!JSON.stringify(hidden).includes('修正完成'), '已忘来源的摘要正文不得出现在导出包')

  // P2-4：导出与读取同口径——篡改 sources 后必须隐藏并给出 source-set-mismatch。
  const tampered = { ...artifact, sources: artifact.sources.filter((source) => source.recordId === ID_A) }
  const refused = buildExportBundle({
    sessionKey: 'sess-1',
    records: [],
    forgotten: [],
    vouchers: [],
    summaries: [tampered],
    sha256,
  })
  assert.equal(refused.counts.summaries, 1)
  assert.equal(refused.counts.hiddenSummaries, 1)
  assert.deepEqual(refused.summaries[0], { summaryId: artifact.summaryId, hidden: true, reason: 'source-set-mismatch' })
  assert.ok(!JSON.stringify(refused).includes('修正完成'), '指纹对不上的摘要正文不得出现在导出包')

  // 未注入 hash = 无法判定：同样隐藏（失败关闭），不把「验不了」当「没问题」。
  const unverified = buildExportBundle({ sessionKey: 'sess-1', records: [], forgotten: [], vouchers: [], summaries: [artifact] })
  assert.deepEqual(unverified.summaries[0], { summaryId: artifact.summaryId, hidden: true, reason: 'integrity-unavailable' })
})

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

const TAMPER_DRAFT = {
  shortText: '定位到查询参数未传递；修正已完成。摘要正文标记-ZQ9',
  detail: '详细摘要：定位到查询参数未传递，修正已完成。',
  outcome: 'partial',
  evidenceRefs: [],
}

test('P2-4 端到端：落盘后篡改 sources，read 隐藏、export 隐藏且原因可见', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-p4-integrity-'))
  const ctx = fakeCtx()
  const engine = attachV3Engine(ctx, { v3Root: root })
  try {
    const session = createFakeSession({ id: 'session-p4-integrity' })
    session.pushUser('第一问：保留这段文字'.repeat(30))
    session.pushAssistant('第一答：也保留'.repeat(30))
    session.pushUser('当前问题'.repeat(10))
    await ctx.callPreStep(session)
    await settle(engine)

    const inspected = await engine.inspectCompact(session.id, session)
    assert.equal(inspected.executable, true, JSON.stringify(inspected))
    const prepared = await engine.prepareCompact(session.id, session, {
      candidate_id: inspected.candidate_id,
      summary: TAMPER_DRAFT,
    })
    assert.equal(prepared.status, 'prepared', JSON.stringify(prepared))
    const summaryId = prepared.summary_id

    const before = await engine.toolRead(session.id, summaryId, { detail: 'short' })
    assert.equal(before.status, 'ok')
    assert.equal(before.visible, true)
    assert.match(before.text, /ZQ9/)
    // G2：摘要读取必须带**有界来源区**，且每条来源逐跳核验（链 B：摘要工件 → 来源记录）
    assert.ok(before.sources.length >= 2, '多来源摘要必须给出来源引用区（得到 ' + before.sources.length + '）')
    assert.ok(before.sources.every((ref) => ref.relation === 'source' && ref.kind === 'record'))
    assert.ok(before.sources.every((ref) => ref.status === 'ok'), '来源必须逐跳核验通过')
    assert.ok(before.sources.every((ref) => ref.hash_kind === 'record-source'), '来源 hash 必须是记录字节 hash（C-G2-07）')
    assert.ok(before.refs_total >= before.sources.length)
    assert.equal(before.related.filter((ref) => ref.relation === 'archive-receipt').length, 0, '摘要侧的引用关系与记录侧不同')

    // 模拟 summaries.jsonl 被篡改：删掉一条来源，但保留旧 sourceSetFingerprint。
    const file = summariesPath(join(root, 'sessions', session.id))
    const rows = (await readFile(file, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
    assert.ok(rows.length >= 1)
    const target = rows.find((row) => row.summaryId === summaryId)
    assert.ok(target !== undefined)
    assert.ok(target.sources.length >= 2, '夹具需要多来源摘要')
    target.sources = target.sources.slice(0, 1)
    await writeFile(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8')

    const after = await engine.toolRead(session.id, summaryId, {})
    assert.equal(after.status, 'hidden', JSON.stringify(after))
    assert.equal(after.visible, false)
    assert.equal(after.text, null)
    assert.equal(after.error, 'source-set-mismatch')
    // G2：不可读对象不得带出来源元数据（身份/来源也可能是隐私面）
    assert.deepEqual(after.sources, [], '隐藏的摘要不得返回来源引用')
    assert.deepEqual(after.related, [])
    assert.equal(after.refs_total, 0)
    const listed = await engine.summaryList(session.id)
    assert.equal(listed.rows[0].visible, false)
    assert.equal(listed.rows[0].reason, 'source-set-mismatch')

    const exported = await engine.exportSession(session.id)
    assert.equal(exported.error, undefined, JSON.stringify(exported))
    const bundle = JSON.parse(await readFile(exported.file, 'utf8'))
    const exportedSummary = bundle.summaries.find((row) => row.summaryId === summaryId)
    assert.deepEqual(exportedSummary, { summaryId, hidden: true, reason: 'source-set-mismatch' })
    assert.equal(bundle.counts.hiddenSummaries, 1)
    assert.equal(JSON.stringify(bundle).includes('ZQ9'), false, '对账失败的摘要正文不得进导出包')
  } finally {
    await engine._waitForIdle().catch(() => {})
    engine.dispose()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})

// —— 0.15.0 P5：摘要预算必须让出「仍能保持正净收益」的空间，不得拖死归档 ——

test('P5 回执预算：sourceChars 约束摘要；预算不足 40 字整条省略且基础身份不变', () => {
  const recordIds = [ID_A]
  const base = renderArchiveReceipt({ startSeq: 2, endSeq: 2, recordIds })
  const baseChars = [...base].length
  assert.ok(RECEIPT_MIN_SUMMARY_CHARS >= 40, '小步骤省略摘要的阈值不得低于产品口径')
  const longSummary = '助手：' + '数'.repeat(SUMMARY_LIMITS.shortText)

  // 预算恰为 0：必须整条省略摘要，回执与无摘要版本逐字节一致（基础身份一条不少）。
  const zero = renderArchiveReceipt({
    startSeq: 2, endSeq: 2, recordIds, summary: longSummary,
    sourceChars: baseChars + RECEIPT_SUMMARY_SAFETY_MARGIN,
  })
  assert.equal(zero, base, '预算 0 时摘要必须整条省略，而不是截成「摘要：…」')
  assert.match(zero, /记录 ID：v3r-0123456789abcdef/)
  assert.match(zero, /恢复：\/memory-lab restore/)

  // 预算刚好够阈值：摘要保留「摘要：」行，按实际可用长度裁剪并以省略号标示。
  const tightSource = baseChars + RECEIPT_SUMMARY_SAFETY_MARGIN + RECEIPT_MIN_SUMMARY_CHARS
  const tight = renderArchiveReceipt({
    startSeq: 2, endSeq: 2, recordIds, summary: longSummary, sourceChars: tightSource,
  })
  assert.match(tight, /摘要：/)
  assert.ok(tight.split('\n')[1].endsWith('…'), '超出可用长度必须以省略号标示')
  assert.ok([...tight].length < tightSource, '摘要行必须让总字数严格小于原文')
  assert.match(tight, /记录 ID：v3r-0123456789abcdef/, '摘要不得把记录 ID 挤掉')
  assert.match(tight, /恢复：\/memory-lab restore/, '摘要不得把恢复入口挤掉')
})

/** 正文恰好 chars 字的活动面助手消息步骤（sourceChars 与正文字数同口径）。 */
function pushSizedStep(session, index, chars) {
  const prefix = '第' + index + '步：'
  const text = prefix + '据'.repeat(chars - [...prefix].length)
  session.append('step/start', { turn: 1, step: index })
  session.pushAssistant(text)
  session.append('step/end', { turn: 1, step: index })
  return text.length
}

async function withCoolingSession({ steps, chars, id }, body) {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-p5-budget-'))
  const ctx = fakeCtx()
  const engine = attachV3Engine(ctx, { v3Root: root })
  try {
    const session = createFakeSession({ id })
    session.pushContextWindow(1000000)
    session.pushUser('开始')
    for (let index = 1; index <= steps; index += 1) pushSizedStep(session, index, chars)
    await ctx.callPreStep(session)
    await settle(engine)
    await engine.setState(id, { mode: 'cooling' })
    return await body({ ctx, engine, session, root, id })
  } finally {
    await engine._waitForIdle().catch(() => {})
    engine.dispose()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
}

async function openGate(root, id) {
  const dir = path.join(root, 'sessions', id)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'usage.jsonl'), JSON.stringify({ seq: 1, inputTokens: 300000, totalTokens: 300001 }) + '\n')
}

test('P5：单步约 200 字在默认设置下仍能归档（自适应摘要预算，不再 not-worth 死锁）', async () => {
  await withCoolingSession({ steps: 5, chars: 200, id: 's-p5-single-200' }, async ({ engine, session, id }) => {
    const result = await engine.archiveForStep(id, session, {}, { resetNotWorth: true })
    assert.equal(result.status, 'archived', '200 字小步骤不得被摘要拖成 not-worth：' + JSON.stringify(result))
    assert.equal(result.steps, 1)
    assert.ok(Number.isInteger(result.receiptSeq))
    assert.ok(result.receiptText.length < 200, '回执总字数必须小于原文：' + result.receiptText.length + ' vs 200')
    assert.match(result.receiptText, /记录 ID：/)
    assert.match(result.receiptText, /恢复：\/memory-lab restore/)
    assert.equal((await engine.historyOf(id)).total, 1)
  })
})

test('P5：摘要预算不足时整条省略摘要，归档照常且基础身份完整', async () => {
  await withCoolingSession({ steps: 5, chars: 160, id: 's-p5-budget-tight' }, async ({ engine, session, id }) => {
    const result = await engine.archiveForStep(id, session, {}, { resetNotWorth: true })
    assert.equal(result.status, 'archived', '预算不足只省略摘要，不得丢弃归档：' + JSON.stringify(result))
    assert.equal(result.receiptText.includes('摘要：'), false, '预算不足时应明确省略整条摘要')
    assert.ok(result.receiptText.length < 160, '回执仍必须小于原文：' + result.receiptText.length + ' vs 160')
    assert.match(result.receiptText, /记录 ID：/)
    assert.match(result.receiptText, /恢复：\/memory-lab restore/)
    assert.equal((await engine.historyOf(id)).total, 1)
  })
})

test('P5：批量 10 步（默认阈值）回执带「摘要：」，总字数仍小于原文', async () => {
  await withCoolingSession({ steps: 14, chars: 200, id: 's-p5-batch-10' }, async ({ engine, session, root, id }) => {
    await openGate(root, id)
    const result = await engine.archiveForStep(id, session, {})
    assert.equal(result.status, 'archived', JSON.stringify(result))
    assert.equal(result.steps, 10, '默认阈值 10 一次压 10 步')
    assert.match(result.receiptText, /摘要：/, '批量 10 步的原文预算足够，回执必须带摘要')
    assert.ok(result.receiptText.length < 200 * 10, '批量回执必须远小于原文：' + result.receiptText.length)
    assert.match(result.receiptText, /记录 ID：/)
    assert.match(result.receiptText, /恢复：\/memory-lab restore/)
  })
})

// —— 0.15.0 G6a：候选生成器的来源定位随工件落盘/读回/导出，旧摘要按缺失兼容 ——

test('G6a 工件：sourceSpans 随摘要落盘、读回、导出；无该字段的旧摘要照常可读（不自动回填）', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-g6a-p4-spans-'))
  try {
    const legacy = buildSummaryArtifact(artifactInput({
      generator: 'extractive',
      generatorVersion: 'extractive-v1',
      draft: summarizeRecordsStructured(records()),
    }))
    const candidate = buildSummaryArtifact(artifactInput({
      summaryId: 'v3s-fedcba9876543210',
      generator: 'extractive',
      generatorVersion: CANDIDATE_GENERATOR_VERSION,
      draft: {
        ...summarizeRecordsStructured(records()),
        sourceSpans: [{ recordId: ID_A, start: 0, end: 2 }],
      },
    }))
    assert.equal('sourceSpans' in legacy, false, 'v1 工件不得凭空多出 sourceSpans')
    assert.deepEqual(candidate.sourceSpans, [{ recordId: ID_A, start: 0, end: 2 }])
    assert.equal(validateSummaryArtifact(candidate, { sha256 }).ok, true)
    // 来源集合指纹只覆盖 sources：加片段不改变完整性判定。
    assert.deepEqual(summaryIntegrityOf(candidate, sha256), { ok: true, reason: 'verified' })

    const directory = join(root, 'sessions', 'g6a-spans')
    await mkdir(directory, { recursive: true })
    assert.equal((await appendSummary(directory, legacy)).appended, true)
    assert.equal((await appendSummary(directory, candidate)).appended, true)
    const listed = await listSummaries(directory)
    assert.equal(listed.ok, true)
    assert.equal(listed.rows.length, 2)
    const reread = listed.rows.find((row) => row.summaryId === candidate.summaryId)
    assert.deepEqual(reread.sourceSpans, candidate.sourceSpans, '定位信息必须原样读回')

    const bundle = buildExportBundle({
      sessionKey: 'g6a-spans',
      records: [],
      forgotten: [],
      vouchers: [],
      summaries: listed.rows,
      sha256,
    })
    const exportedCandidate = bundle.summaries.find((row) => row.summaryId === candidate.summaryId)
    const exportedLegacy = bundle.summaries.find((row) => row.summaryId === legacy.summaryId)
    assert.deepEqual(exportedCandidate.sourceSpans, candidate.sourceSpans, '导出包保留来源定位（可回跳）')
    assert.equal('sourceSpans' in exportedLegacy, false, '旧摘要导出后仍然没有该字段（不补造）')
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})