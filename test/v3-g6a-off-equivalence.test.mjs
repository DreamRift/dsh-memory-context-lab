/**
 * G6a：**开关关闭时输出与 HEAD 逐字节等价**（学 G5 §4 的指纹法）。
 *
 * ## 方法
 * 改动**前**用 HEAD 代码（分支 memory-v0150-g1 @ 08345de）跑一遍固定输入，
 * 把每个用例的 `sha256(JSON.stringify(结果))` 冻结成常量（见 §指纹表注释）。
 * 本套件在新代码上重算同样的输入与哈希：任何字节漂移都会红。这不是「看起来一样」，
 * 而是「同一序列化字节」。
 *
 * ## 覆盖
 * - 存量生成器：`summarizeRecords`（默认/空/极限预算/非法预算）、
 *   `summarizeRecordsStructured`（默认/空/极小预算）；
 * - 常量：extractive-v1、历史 220 字上限、model-draft-v1；
 * - 用例：`materialize` 的 v1 路径（工件字段集合 + canonical 材料 + 物化指纹）与模型草稿路径。
 *
 * ## 反假绿
 * ① 量具自检：改动任一输入字节，指纹必须变；② 开关打开必须真的改变输出（否则「等价」是
 * 因为候选根本没接上，而不是因为关闭路径干净）。
 *
 * ## 不适用条件
 * 只覆盖**离线生成器与摘要用例**。回执文本/活动面由 archive 侧（集成批）渲染，本批未改；
 * 因此这里不宣称「整条归档链路逐字节等价」，只宣称本批改动面内等价。
 * 运行：node --test test/v3-g6a-off-equivalence.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import {
  CANDIDATE_GENERATOR_VERSION,
  EXTRACTIVE_GENERATOR_VERSION,
  SUMMARY_MAX_CHARS,
  summarizeRecords,
  summarizeRecordsStructured,
} from '../src/v3/domain/compress/summary.mjs'
import { canonicalSummaryMaterial } from '../src/v3/domain/compress/summary-artifact.mjs'
import { MODEL_GENERATOR_VERSION, createSummaryService } from '../src/v3/application/summary.mjs'

const sha256 = (text) => createHash('sha256').update(text).digest('hex')

/** 与抓取脚本完全相同的固定输入（合成串，无真实凭据）。 */
const R1 = { id: 'v3r-0123456789abcdef', kind: 'message-user', payload: { text: '目标：修复登录参数未传递。' + '甲乙'.repeat(70) } }
const R2 = { id: 'v3r-fedcba9876543210', kind: 'message-assistant', payload: { text: '已经补上透传；准备跑测试。😀' } }
const R3 = { id: 'v3r-0000111122223333', kind: 'tool-result', payload: { text: '' } }
const R4 = { id: 'v3r-4444555566667777', kind: 'message-assistant', payload: { text: undefined } }
const R5 = { id: 'v3r-88889999aaaabbbb', kind: 'message-assistant', payload: { text: '😀'.repeat(200) } }
const RECORDS = [R1, R2, R3, R4, R5]
const EMPTY = []

/**
 * HEAD 指纹表（改动前抓取，Node v26.12.1 / win32-x64，2026-11-01）。
 * 键 = 用例名，值 = sha256(JSON.stringify(该用例结果))。
 */
const HEAD_FINGERPRINTS = Object.freeze({
  'summarizeRecords:empty': '12ae32cb1ec02d01eda3581b127c1fee3b0dc53572ed6baf239721a03d82e126',
  'summarizeRecords:default': '7404f841baaf8ccb60445ea167a1b17d6c568be3650888d777a06b31ccec0886',
  'summarizeRecords:maxChars1': 'c8d400fc2de0b15c0dfb3a365267f3f0e3d604b224bbbfb69452ab85b10fa795',
  'summarizeRecords:maxChars7': 'cdf52d07cd4c4143546aa48d7144c455bcbfd208118d6a9f0c49c4c076b79fd0',
  'summarizeRecords:nan': 'd8c7eb30019b3225d426200ddbdf4ba15243a164845636ff444213b73b4242df',
  'structured:empty': '4e29bb935f70d5ea00c9583702786d14dede419b3153b5672573c57536b06e8a',
  'structured:default': 'e029a0a4c35a4b1246275413d1e8dd85cdad179289870870de9f7ee1f228d905',
  'structured:tiny': '32e9b61ae56d3c86a953276f3a43d328b3ec43ad558784e2c4018f763b11e2a1',
  'const:EXTRACTIVE_GENERATOR_VERSION': 'd2072528e84ddb656c1887ed3d2ae65c0a4108a7d0d1134f2d85d305adade4d2',
  'const:SUMMARY_MAX_CHARS': '36790ecd55c2030dc553685bef719df653f413a20cdad1bfd1dc934c76686ddd',
  'const:MODEL_GENERATOR_VERSION': '1bdf5b52e4d885b4e651a5ee2b0a5a9b1457dfdfc06e0e9abd3200b0df2aac39',
  'materialize:default': '528f8bca4b8e9e22753b4c5136b65f790bd2eb22593080893376af4f8a68c771',
  'materialize:model': '48fdd58580f8ee3d66efe1e1d27101aae3899f4792e3b2140c19441ee38285f7',
})

/** HEAD 上 v1 工件的字段顺序（顺序本身也是字节；多一个键就是漂移）。 */
const HEAD_ARTIFACT_KEYS = Object.freeze([
  'schemaVersion', 'summaryId', 'sessionKey', 'generator', 'generatorVersion', 'verification',
  'createdAt', 'sources', 'sourceSetFingerprint', 'baseSummaryId', 'baseRevision', 'supersedes',
  'shortText', 'detail', 'goal', 'changes', 'outcome', 'decisions', 'openItems', 'evidenceRefs',
  'redactionVersion', 'idempotencyKey',
])

function harness(records = RECORDS) {
  const memory = []
  const store = {
    async readRecord(id) { return records.find((row) => row.id === id) ?? null },
    listForgotten() { return [] },
  }
  const summaries = {
    async append(directory, artifact) { memory.push(artifact); return { appended: true, artifact } },
    async list() { return { ok: true, rows: memory.slice() } },
  }
  const service = createSummaryService({
    store,
    clock: { now: () => 1700000000000 },
    random: { uuid: () => '11111111-2222-3333-4444-555555555555' },
    hash: { sha256 },
    summaries,
  })
  const entry = { runtime: { store: { directory: 'mcl-g6a-off-equivalence' } } }
  return { service, entry, memory }
}

function grab(rawRecords = RECORDS, EMPTYRECORDS = EMPTY) {
  const out = {}
  const put = (key, value) => { out[key] = { sha256: sha256(JSON.stringify(value)), value } }
  put('summarizeRecords:empty', summarizeRecords(EMPTYRECORDS))
  put('summarizeRecords:default', summarizeRecords(rawRecords))
  put('summarizeRecords:maxChars1', summarizeRecords(rawRecords, { maxChars: 1 }))
  put('summarizeRecords:maxChars7', summarizeRecords(rawRecords, { maxChars: 7 }))
  let nan
  try {
    nan = { threw: String(summarizeRecords(rawRecords, { maxChars: 0.5 })?.constructor?.name ?? '') }
  } catch (error) {
    nan = { threw: error?.constructor?.name, message: error?.message }
  }
  put('summarizeRecords:nan', nan)
  put('structured:empty', summarizeRecordsStructured(EMPTYRECORDS))
  put('structured:default', summarizeRecordsStructured(rawRecords))
  put('structured:tiny', summarizeRecordsStructured(rawRecords, { maxShortChars: 9, maxDetailChars: 11 }))
  put('const:EXTRACTIVE_GENERATOR_VERSION', EXTRACTIVE_GENERATOR_VERSION)
  put('const:SUMMARY_MAX_CHARS', SUMMARY_MAX_CHARS)
  put('const:MODEL_GENERATOR_VERSION', MODEL_GENERATOR_VERSION)
  return out
}

async function grabMaterialize() {
  const out = {}
  const put = (key, value) => { out[key] = { sha256: sha256(JSON.stringify(value)), value } }
  const fixture = harness()
  const materialized = await fixture.service.materialize({
    entry: fixture.entry,
    sessionKey: 'g6a-fixed-session',
    recordIds: [R1.id, R2.id],
  })
  put('materialize:default', {
    ok: materialized.ok,
    appended: materialized.appended,
    artifactMaterial: materialized.ok ? canonicalSummaryMaterial(materialized.artifact) : null,
    artifactKeys: materialized.ok ? Object.keys(materialized.artifact) : null,
    fingerprint: materialized.ok ? fixture.service.fingerprintOf(materialized.artifact) : null,
  })
  const modelFixture = harness()
  const model = await modelFixture.service.materialize({
    entry: modelFixture.entry,
    sessionKey: 'g6a-fixed-session',
    recordIds: [R1.id],
    generator: 'model',
    draft: { shortText: '模型草稿短摘要', detail: '详细', evidenceRefs: [R1.id] },
  })
  put('materialize:model', { ok: model.ok, material: model.ok ? canonicalSummaryMaterial(model.artifact) : null })
  return out
}

test('G6a-12 off 等价：旧生成器与 v1 用例的输出与 HEAD 逐字节相同（13 项冻结指纹）', async () => {
  const current = grab()
  const materialized = await grabMaterialize()
  const all = { ...current, ...materialized }
  assert.deepEqual(Object.keys(all).sort(), Object.keys(HEAD_FINGERPRINTS).sort(), '指纹表必须覆盖同一组用例')
  const drifted = []
  for (const [key, expected] of Object.entries(HEAD_FINGERPRINTS)) {
    const actual = all[key].sha256
    if (actual !== expected) drifted.push(key + '：' + expected + ' → ' + actual)
  }
  assert.deepEqual(drifted, [], '开关关闭时不得有任何字节漂移：\n' + drifted.join('\n'))

  // v1 工件的字段集合/顺序也必须与 HEAD 完全相同（不多出 sourceSpans）。
  assert.deepEqual(all['materialize:default'].value.artifactKeys, HEAD_ARTIFACT_KEYS)
  assert.equal(all['materialize:default'].value.artifactMaterial.includes('sourceSpans'), false)
})

test('G6a-13 反假绿：改一个字节指纹必变；开关打开必须真的改变输出', async () => {
  // ① 量具自检：输入差一个字符，指纹必须不同（否则「等价」是恒真）。
  const mutated = RECORDS.map((row, index) => (index === 1 ? { ...row, payload: { text: row.payload.text + '。' } } : row))
  const base = grab()
  const changed = grab(mutated)
  assert.notEqual(changed['summarizeRecords:default'].sha256, base['summarizeRecords:default'].sha256)
  assert.notEqual(changed['structured:default'].sha256, base['structured:default'].sha256)

  // ② 开关打开：生成器版本与工件形状必须真的变（证明关着的路径不是「候选没接上」）。
  const fixture = harness()
  const on = await fixture.service.materialize({
    entry: fixture.entry,
    sessionKey: 'g6a-fixed-session',
    recordIds: [R1.id, R2.id],
    summaryGenerator: { enabled: true, version: CANDIDATE_GENERATOR_VERSION },
  })
  assert.equal(on.ok, true)
  assert.equal(on.artifact.generatorVersion, CANDIDATE_GENERATOR_VERSION)
  assert.notEqual(canonicalSummaryMaterial(on.artifact), (await grabMaterialize())['materialize:default'].value.artifactMaterial)
  assert.ok(Array.isArray(on.artifact.sourceSpans) && on.artifact.sourceSpans.length > 0)
  assert.equal(on.generator.version, CANDIDATE_GENERATOR_VERSION)
})
