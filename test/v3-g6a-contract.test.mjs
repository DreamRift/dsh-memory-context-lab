/**
 * G6a：生成器开关与摘要工件合同（sourceSpans）——**合同面**。
 *
 * ## 缺陷/缺口
 * 0.15.0 的确定性摘要只有一个版本（extractive-v1，首部切片），工件里没有「这段摘要来自
 * 哪条记录的第几个码点」；生成器要换版本时也没有失败关闭的开关，容易把候选误开成默认。
 *
 * ## 判据来源
 * 开发流程 §12.1；G0 合同 C-M-01（生成器版本独立版本化、只加字段可读旧格式）、
 * C-G2-02（摘要字段复用既有集合，新增字段必须同改校验/读路径）。
 *
 * ## 断言组
 * 1. 开关：默认关闭；非法配置**失败关闭**（回 extractive-v1）且不抛错；仅显式版本启用候选。
 * 2. 工件：sourceSpans 为可选字段；跨来源/空数组/坏区间一律拒绝；模型草稿不得声明区间。
 * 3. 兼容：旧摘要（无 sourceSpans）仍合法、材料字符串逐字节不变、读路径不自动回填。
 * 4. 用例：materialize 候选路径落 spans；预算不足/空文本返回 summary-omitted（不让归档失败）。
 *
 * ## 不适用条件与已知边界
 * 本套件只证明**离线合同与用例**；共享回执接线（archive 侧换成新生成器）属集成批，
 * 未在本批改动，因此这里不宣称回执层已切换。
 * 运行：node --test test/v3-g6a-contract.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import { SUMMARY_LIMITS } from '../src/v3/contracts/summaries.mjs'
import {
  CANDIDATE_GENERATOR_VERSION,
  EXTRACTIVE_GENERATOR_VERSION,
  resolveSummaryGenerator,
  summarizeRecordsStructured,
} from '../src/v3/domain/compress/summary.mjs'
import {
  buildSummaryArtifact,
  canonicalSummaryMaterial,
  normalizeSummaryDraft,
  sourceSetMaterial,
  summaryIntegrityOf,
  validateSummaryArtifact,
} from '../src/v3/domain/compress/summary-artifact.mjs'
import { MODEL_GENERATOR_VERSION, createSummaryService } from '../src/v3/application/summary.mjs'

const sha256 = (text) => createHash('sha256').update(text).digest('hex')

const RECORDS = Object.freeze([
  {
    id: 'v3r-1111111111111111',
    kind: 'message-user',
    payload: { text: '目标：修复登录接口 query 参数未透传导致 401 的问题。' },
  },
  {
    id: 'v3r-2222222222222222',
    kind: 'tool-result',
    payload: { text: '无关输出占位。'.repeat(20) + '失败原因：/api/refresh 在代理环境下超时（上游 504）。' },
  },
  {
    id: 'v3r-3333333333333333',
    kind: 'message-assistant',
    payload: { text: '最终结果：补上 token 刷新后，登录测试通过 3/3。' },
  },
])

const SOURCES = Object.freeze([
  { recordId: RECORDS[0].id, hash: sha256('a') },
  { recordId: RECORDS[1].id, hash: sha256('b') },
])
const FINGERPRINT = sha256(sourceSetMaterial(SOURCES))

/** 摘要用例夹具：内存 store + 内存 summaries（append 走调用方的锁内 guard）。 */
function harness(records = RECORDS) {
  const written = []
  const store = {
    async readRecord(id) { return records.find((record) => record.id === id) ?? null },
    listForgotten() { return [] },
  }
  const summaries = {
    async append(directory, artifact, { guard } = {}) {
      if (typeof guard === 'function') {
        const verdict = await guard({ existing: written.slice() })
        if (verdict?.ok !== true) return { ok: false, reason: verdict?.reason ?? 'guard-rejected' }
      }
      written.push(artifact)
      return { appended: true, artifact }
    },
    async list() { return { ok: true, rows: written.slice() } },
  }
  const service = createSummaryService({
    store,
    clock: { now: () => 1700000000000 },
    random: { uuid: () => '11111111-2222-3333-4444-555555555555' },
    hash: { sha256 },
    summaries,
  })
  const entry = { runtime: { store: { directory: 'mcl-g6a-fixture' } } }
  return { service, entry, written }
}

test('G6a-8 开关默认关闭 + 非法配置失败关闭 + 仅显式版本启用候选', () => {
  assert.deepEqual(resolveSummaryGenerator(null), { enabled: false, version: EXTRACTIVE_GENERATOR_VERSION, candidate: false, reason: 'default-off' })
  assert.deepEqual(resolveSummaryGenerator(), { enabled: false, version: EXTRACTIVE_GENERATOR_VERSION, candidate: false, reason: 'default-off' })
  assert.equal(resolveSummaryGenerator({ enabled: false, version: CANDIDATE_GENERATOR_VERSION }).candidate, false)
  assert.deepEqual(resolveSummaryGenerator({ enabled: true, version: EXTRACTIVE_GENERATOR_VERSION }), {
    enabled: true, version: EXTRACTIVE_GENERATOR_VERSION, candidate: false, reason: 'v1-selected',
  })
  assert.deepEqual(resolveSummaryGenerator({ enabled: true, version: CANDIDATE_GENERATOR_VERSION }), {
    enabled: true, version: CANDIDATE_GENERATOR_VERSION, candidate: true, reason: 'candidate-enabled',
  })

  // 非法配置一律失败关闭：**不启用候选、不抛错**（归档不能因配置看不懂而失败）。
  const invalid = [
    ['candidate', 'config-invalid'],
    [{ enabled: 'yes' }, 'config-invalid-enabled'],
    [{ enabled: 1 }, 'config-invalid-enabled'],
    [{ enabled: true }, 'config-invalid-version'],
    [{ enabled: true, version: '' }, 'config-invalid-version'],
    [{ enabled: true, version: 'extractive-v9' }, 'config-invalid-version'],
    [{ enabled: true, version: CANDIDATE_GENERATOR_VERSION, extra: 1 }, 'config-unknown-key'],
    [{ enabled: false, on: true }, 'config-unknown-key'],
  ]
  for (const [config, reason] of invalid) {
    const decision = resolveSummaryGenerator(config)
    assert.equal(decision.candidate, false, '非法配置不得启用候选：' + JSON.stringify(config))
    assert.equal(decision.version, EXTRACTIVE_GENERATOR_VERSION)
    assert.equal(decision.reason, reason)
    assert.equal(decision.enabled, false)
  }
})

test('G6a-9 materialize：候选路径写 sourceSpans；开关关闭/非法时工件的字段集合与 v1 完全相同', async () => {
  const candidate = await harness().service.materialize({
    entry: harness().entry,
    sessionKey: 'sess-g6a',
    recordIds: [RECORDS[0].id, RECORDS[1].id, RECORDS[2].id],
    summaryGenerator: { enabled: true, version: CANDIDATE_GENERATOR_VERSION },
  })
  assert.equal(candidate.ok, true, JSON.stringify(candidate))
  assert.equal(candidate.generator.reason, 'candidate-enabled')
  assert.equal(candidate.artifact.generator, 'extractive', '生成路径仍是确定性提取（不是模型）')
  assert.equal(candidate.artifact.generatorVersion, CANDIDATE_GENERATOR_VERSION)
  assert.equal(candidate.artifact.verification, 'unverified', '不因换生成器就升级可信度')
  assert.ok(Array.isArray(candidate.artifact.sourceSpans) && candidate.artifact.sourceSpans.length >= 2)
  const sourceIds = new Set(candidate.artifact.sources.map((source) => source.recordId))
  for (const span of candidate.artifact.sourceSpans) {
    assert.ok(sourceIds.has(span.recordId), '片段只能指向本摘要的来源：' + span.recordId)
    assert.ok(Number.isInteger(span.start) && Number.isInteger(span.end) && span.end > span.start)
  }
  assert.equal(validateSummaryArtifact(candidate.artifact, { sha256 }).ok, true)
  assert.ok(canonicalSummaryMaterial(candidate.artifact).includes('"sourceSpans"'))
  // 工件正文逐字来自来源记录：失败原因整段在详细摘要里。
  assert.ok(candidate.artifact.detail.includes('失败原因：/api/refresh 在代理环境下超时（上游 504）。'))
  assert.ok([...candidate.artifact.shortText].length <= SUMMARY_LIMITS.shortText)

  // 默认（不传开关）/显式关闭/非法配置：三条路径都必须与 v1 逐字段一致（无 sourceSpans）。
  for (const summaryGenerator of [null, { enabled: false, version: CANDIDATE_GENERATOR_VERSION }, { enabled: 'yes' }]) {
    const fixture = harness()
    const plain = await fixture.service.materialize({
      entry: fixture.entry,
      sessionKey: 'sess-g6a',
      recordIds: [RECORDS[0].id, RECORDS[1].id],
      summaryGenerator,
    })
    assert.equal(plain.ok, true)
    assert.equal(plain.generator, undefined, 'off 路径不新增返回字段')
    assert.equal(plain.artifact.generatorVersion, EXTRACTIVE_GENERATOR_VERSION)
    assert.equal('sourceSpans' in plain.artifact, false, 'v1 工件不得凭空多出 sourceSpans：' + JSON.stringify(summaryGenerator))
    assert.equal(canonicalSummaryMaterial(plain.artifact).includes('sourceSpans'), false)
    assert.equal(validateSummaryArtifact(plain.artifact, { sha256 }).ok, true)
  }

  // 模型草稿路径完全不受影响（版本/字段/校验都照旧）。
  const modelFixture = harness()
  const model = await modelFixture.service.materialize({
    entry: modelFixture.entry,
    sessionKey: 'sess-g6a',
    recordIds: [RECORDS[0].id],
    generator: 'model',
    draft: { shortText: '模型草稿摘要', detail: '详细', evidenceRefs: [RECORDS[0].id] },
    summaryGenerator: { enabled: true, version: CANDIDATE_GENERATOR_VERSION },
  })
  assert.equal(model.ok, true)
  assert.equal(model.artifact.generatorVersion, MODEL_GENERATOR_VERSION)
  assert.equal('sourceSpans' in model.artifact, false)
})

test('G6a-10 预算不足/无可摘引片段：materialize 返回 summary-omitted（不让归档失败）', async () => {
  const tight = await harness().service.materialize({
    entry: harness().entry,
    sessionKey: 'sess-g6a',
    recordIds: [RECORDS[0].id, RECORDS[1].id],
    summaryGenerator: { enabled: true, version: CANDIDATE_GENERATOR_VERSION },
    summaryOptions: { maxShortChars: 4, maxDetailChars: 4 },
  })
  assert.equal(tight.ok, false)
  assert.equal(tight.reason, 'summary-omitted')
  assert.equal(tight.omitted, true)
  assert.equal(tight.detail, 'budget-too-small', '预算原因要如实带出，供回执/status 说明')
  assert.equal(tight.generator.reason, 'candidate-enabled')

  const blank = harness([{ id: 'v3r-4444444444444444', kind: 'message-assistant', payload: { text: '   ' } }])
  const empty = await blank.service.materialize({
    entry: blank.entry,
    sessionKey: 'sess-g6a',
    recordIds: ['v3r-4444444444444444'],
    summaryGenerator: { enabled: true, version: CANDIDATE_GENERATOR_VERSION },
  })
  assert.equal(empty.ok, false)
  assert.equal(empty.reason, 'summary-omitted')
  assert.equal(empty.detail, 'no-selection')
  assert.equal(blank.written.length, 0, '省略摘要时不得写入任何工件')
})

test('G6a-11 工件合同：sourceSpans 可选、可校验、进指纹；旧摘要只读兼容、不自动回填', () => {
  const draft = summarizeRecordsStructured([RECORDS[0], RECORDS[1]])
  const legacy = buildSummaryArtifact({
    summaryId: 'v3s-2222222222222222',
    sessionKey: 'sess-g6a',
    sources: SOURCES,
    generator: 'extractive',
    generatorVersion: EXTRACTIVE_GENERATOR_VERSION,
    draft,
    createdAt: 1,
    sourceSetFingerprint: FINGERPRINT,
  })
  // 旧形状：没有 sourceSpans，校验通过，材料字符串里不出现该键（既有指纹不被改写）。
  assert.equal('sourceSpans' in legacy, false)
  assert.equal(validateSummaryArtifact(legacy, { sha256 }).ok, true)
  assert.deepEqual(summaryIntegrityOf(legacy, sha256), { ok: true, reason: 'verified' })
  assert.equal(canonicalSummaryMaterial(legacy).includes('sourceSpans'), false)

  // 同一个工件加上片段：材料指纹必须变（否则「同载荷不同定位」会被吞掉）。
  const withSpans = { ...legacy, sourceSpans: [{ recordId: RECORDS[0].id, start: 0, end: 6 }] }
  assert.equal(validateSummaryArtifact(withSpans, { sha256 }).ok, true)
  assert.notEqual(canonicalSummaryMaterial(withSpans), canonicalSummaryMaterial(legacy))
  assert.deepEqual(summaryIntegrityOf(withSpans, sha256), { ok: true, reason: 'verified' }, '片段不参与来源集合指纹')

  // 坏形状一律拒绝：空数组、越界记录、坏区间、未知字段。
  const bad = [
    { ...legacy, sourceSpans: [] },
    { ...legacy, sourceSpans: [{ recordId: 'v3r-9999999999999999', start: 0, end: 1 }] },
    { ...legacy, sourceSpans: [{ recordId: RECORDS[0].id, start: 5, end: 5 }] },
    { ...legacy, sourceSpans: [{ recordId: RECORDS[0].id, start: -1, end: 3 }] },
    { ...legacy, sourceSpans: [{ recordId: RECORDS[0].id, start: 0, end: 3, note: 'x' }] },
  ]
  for (const artifact of bad) assert.equal(validateSummaryArtifact(artifact).ok, false, JSON.stringify(artifact.sourceSpans))

  // 模型草稿不得声明码点区间（模型不可能知道偏移）：归一化与构造两层都拒绝。
  const modelDraft = { shortText: 'x', detail: 'y', sourceSpans: [{ recordId: RECORDS[0].id, start: 0, end: 1 }] }
  const normalized = normalizeSummaryDraft(modelDraft)
  assert.equal(normalized.ok, false)
  assert.ok(normalized.errors.some((row) => row.includes('只允许确定性生成器')))
  assert.throws(() => buildSummaryArtifact({
    summaryId: 'v3s-3333333333333333',
    sessionKey: 'sess-g6a',
    sources: SOURCES,
    generator: 'model',
    generatorVersion: MODEL_GENERATOR_VERSION,
    draft: modelDraft,
    createdAt: 1,
    sourceSetFingerprint: FINGERPRINT,
  }), /只允许确定性生成器/)

  // 确定性路径的区间必须落在来源集合里（跨来源 = 可回跳是假的）。
  assert.throws(() => buildSummaryArtifact({
    summaryId: 'v3s-4444444444444444',
    sessionKey: 'sess-g6a',
    sources: SOURCES,
    generator: 'extractive',
    generatorVersion: CANDIDATE_GENERATOR_VERSION,
    draft: { shortText: 'x', detail: 'y', sourceSpans: [{ recordId: 'v3r-9999999999999999', start: 0, end: 1 }] },
    createdAt: 1,
    sourceSetFingerprint: FINGERPRINT,
  }), /sourceSpans 指向来源集合之外/)

  // 旧摘要在读路径上「只读兼容」：校验/可见性判定不修改对象、不补造区间。
  const before = JSON.stringify(legacy)
  validateSummaryArtifact(legacy, { sha256 })
  assert.equal(JSON.stringify(legacy), before, '读路径不得回填/改写旧摘要')
})
