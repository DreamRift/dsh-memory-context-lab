/**
 * P2 最小缓存观测（0.15.0）——**主验收 4740fc9 驳回后的收紧版**，先红用例。
 *
 * ## 上一版被驳回的六类问题（本文件逐条锁住）
 * ① **擅自改 entry**：本分支不得改 `src/v3/entry/`；上一版留下的 `appendObservation`
 *    既没调用点、又引用了作用域外的 `ctx`（warn 路径会再抛）。已撤回，并加静态守卫 G1。
 * ② **算术相等被当成语义互斥**：适配器的 `totalTokens` 本来就是 `in+out+read+write` 求和，
 *    `100+50+0+10 === 160` 只能证明**算术自洽**，不能证明供应商计费桶互斥。
 *    上一版据此产出 `mutuallyExclusive:'proven'` / `uncached` / `billedInput` 是**伪造结论**。
 * ③ **缺失误报命中率**：`{cacheReadTokens:50, outputTokens:10}` 缺输入分母，上一版把
 *    缺项过滤成 0 ⇒ 比率 `1`（100%）。分母缺项必须 null。
 * ④ **ttft 命名越界**：`stepStartedAt` 含检索/构建时间，不是供应商 TTFT。
 * ⑤ **sanitize 不安全**：无严格嵌套检查（`usage.field === null` 在 try 外抛）、
 *    `ttftSource/evidence/fingerprint/reason/intentId` 接受任意字符串（可夹带正文）。
 * ⑥ **范围可伪造**：`outboundRequest = {}` 即升级，再传 `input.surface` 又换成插件面 → 自相矛盾。
 * ⑦ **尾部追加被当成前缀改写**：内容增长也推进 epoch，把「正常变长」冒充「缓存失效」。
 * ⑧ **append 无锁**：`tailStateOf` 读后发现到追加之间有窗口，seq 幂等只在串行成立。
 *
 * ## 判据来源
 * P0 宿主合同（DSH 0.2.1-rc.5）§2.4（TokenUsage 字段/缺失语义）、§2.5（无 wire seam）；
 * 开发流程 §3.5（观测字段、缺失 null）与 §8 P2（先证明测量可靠，不宣称省费）。
 *
 * ## 断言组
 * A 归一 / B 算术一致（不再产语义结论）/ C 范围（仅 plugin-surface）/
 * D 指纹与 append-vs-rewrite / E 账本 / F 失败与并发 / G entry 归属守卫。
 *
 * ## 不适用条件与已知边界
 * 只验纯函数与账本写入路径；真实 `llm/stream`、真实 usage 到达形态、供应商语义均未验。
 * 不估价格/TTL/金额；不实现 P3 调度；不注册模型工具。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  CACHE_TOKENS_CONTRACT_VERSION,
  OBSERVATION_SCOPES,
  STEP_TO_FIRST_TOKEN_SOURCE,
  SURFACE_CHANGE_KINDS,
  USAGE_CACHE_FIELDS,
  arithmeticConsistencyOf,
  buildCacheObservation,
  cacheReadRatioOf,
  normalizeUsageObservation,
  observationScopeOf,
  sanitizeCacheObservation,
  surfaceFingerprintOf,
  nextProjectionEpoch,
} from '../src/v3/contracts/cache-observation.mjs'
import { appendCacheObservation, appendUsageLine, readUsageSummary } from '../src/v3/adapters/storage/usage-log.mjs'
import { withCrossProcessWriteLock } from '../src/v3/adapters/storage/write-lock.mjs'

async function withDir(body) {
  const dir = await mkdtemp(path.join(tmpdir(), 'mcl-cacheobs2-'))
  try { return await body(dir) } finally { await rm(dir, { recursive: true, force: true }).catch(() => {}) }
}

// ---------------------------------------------------------------- A 归一

test('A1 合同版本与字段封闭集（宿主 TokenUsage 六字段；测量值不属于 usage）', () => {
  // G3：合同升到 4（layers/lifecycle/surface.components/arithmetic.additivity）；
  // v2/v3 行按版本拒绝或走 readObservationRowOf 的兼容读路径，不误读
  assert.equal(CACHE_TOKENS_CONTRACT_VERSION, 4)
  assert.deepEqual([...USAGE_CACHE_FIELDS], ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'])
  assert.deepEqual([...OBSERVATION_SCOPES], ['plugin-surface'])
  // 三态是封闭集（导出已删：src 内零消费；判据仍由 B1–B4 锁住）
  assert.deepEqual([...new Set(['consistent', 'inconsistent', 'unknown'])], ['consistent', 'inconsistent', 'unknown'])
})

test('A2 缺失 = null + availability=missing（不写 0）', () => {
  const obs = normalizeUsageObservation({ inputTokens: 1000, outputTokens: 50 })
  assert.equal(obs.ok, true)
  assert.equal(obs.usage.inputTokens.value, 1000)
  assert.equal(obs.usage.inputTokens.availability, 'present')
  for (const field of ['cacheReadTokens', 'cacheWriteTokens', 'totalTokens', 'reasoningTokens']) {
    assert.equal(obs.usage[field].value, null, field)
    assert.equal(obs.usage[field].availability, 'missing', field)
  }
})

test('A3 显式 0 与「未报」可区分', () => {
  const zero = normalizeUsageObservation({ inputTokens: 10, outputTokens: 1, cacheReadTokens: 0 })
  const absent = normalizeUsageObservation({ inputTokens: 10, outputTokens: 1 })
  assert.equal(zero.usage.cacheReadTokens.value, 0)
  assert.equal(zero.usage.cacheReadTokens.availability, 'present')
  assert.equal(absent.usage.cacheReadTokens.value, null)
  assert.equal(absent.usage.cacheReadTokens.availability, 'missing')
})

test('A4 显式合法 reasoningTokens 如实保留（不硬编码 null）', () => {
  const obs = normalizeUsageObservation({ inputTokens: 10, outputTokens: 2, reasoningTokens: 7 })
  assert.equal(obs.usage.reasoningTokens.value, 7)
  assert.equal(obs.usage.reasoningTokens.availability, 'present')
  assert.equal(normalizeUsageObservation({ inputTokens: 10, outputTokens: 2 }).usage.reasoningTokens.availability, 'missing')
})

test('A5 非法值 → invalid + reason，不污染其它字段', () => {
  for (const bad of [-1, 'abc', Number.NaN, Number.POSITIVE_INFINITY, null, {}]) {
    const obs = normalizeUsageObservation({ inputTokens: 10, outputTokens: 1, cacheReadTokens: bad })
    assert.equal(obs.ok, true)
    assert.equal(obs.usage.cacheReadTokens.value, null, String(bad))
    assert.equal(obs.usage.cacheReadTokens.availability, 'invalid', String(bad))
    assert.equal(typeof obs.usage.cacheReadTokens.reason, 'string')
    assert.equal(obs.usage.inputTokens.availability, 'present')
  }
})

test('A5b 键存在但 undefined 视为未报；完全无字段不成样本', () => {
  assert.equal(normalizeUsageObservation({ inputTokens: 10, outputTokens: 1, cacheReadTokens: undefined }).usage.cacheReadTokens.availability, 'missing')
  assert.equal(normalizeUsageObservation({}).ok, false)
  assert.equal(normalizeUsageObservation(null).ok, false)
  assert.equal(normalizeUsageObservation({ outputTokens: 3 }).ok, true)
})

test('A6 ④ step 开始→首 token 测量：语义写明，不叫 TTFT；不可观测 = null', () => {
  assert.equal(STEP_TO_FIRST_TOKEN_SOURCE, 'step-to-first-token')
  const ok = normalizeUsageObservation({ inputTokens: 1, outputTokens: 1 }, { stepStartedAt: 1000, firstTokenAt: 1250 })
  assert.equal(ok.measurement.stepToFirstToken.value, 250)
  assert.equal(ok.measurement.stepToFirstToken.source, STEP_TO_FIRST_TOKEN_SOURCE)
  assert.match(ok.measurement.stepToFirstToken.note, /step\/start 之后的请求准备与构建耗时|不含此前 pre-step|不是供应商 TTFT/)
  assert.equal('ttft' in ok, false, '顶层不得再用 ttft 这个名字')
  assert.equal('ttftSource' in ok, false)
  for (const pair of [[1000, 900], [1000, Number.NaN], [-5, 10], [null, 10]]) {
    const bad = normalizeUsageObservation({ inputTokens: 1, outputTokens: 1 }, { stepStartedAt: pair[0], firstTokenAt: pair[1] })
    assert.equal(bad.measurement.stepToFirstToken.value, null, JSON.stringify(pair))
    assert.equal(bad.measurement.stepToFirstToken.source, null, JSON.stringify(pair))
  }
  // ③（主复审）：小数毫秒不是可接受的观测值——构造层归未知，不能生成 sanitize 会拒绝的记录
  const fractional = normalizeUsageObservation({ inputTokens: 1, outputTokens: 1 }, { stepStartedAt: 1.1, firstTokenAt: 2.5 })
  assert.equal(fractional.measurement.stepToFirstToken.value, null, '小数毫秒 → 构造层必须归未知')
  assert.equal(fractional.measurement.stepToFirstToken.source, null)
})

// ---------------------------------------------------------------- B 算术（不再产语义结论）

test('B1 ② 算术自洽只报 consistent，绝不产出 proven/uncached/billedInput', () => {
  const obs = normalizeUsageObservation({ inputTokens: 100, cacheReadTokens: 50, cacheWriteTokens: 0, outputTokens: 10, totalTokens: 160 })
  const arithmetic = arithmeticConsistencyOf(obs.usage)
  assert.equal(arithmetic.status, 'consistent')
  assert.equal(arithmetic.sum, 160)
  assert.equal(arithmetic.evidence, 'total-equals-component-sum')
  // 语义结论必须不存在：主审实测的反例就是这些字段把算术当成了语义
  for (const forbidden of ['mutuallyExclusive', 'proven', 'uncached', 'billedInput', 'inputTotal', 'totalCost']) {
    assert.equal(forbidden in arithmetic, false, '不得产出语义结论字段：' + forbidden)
  }
  assert.match(arithmetic.note, /算术自洽不等于|未核验/)
})

test('B2 缺 total（或任一组件）→ unknown，不猜', () => {
  const arithmetic = arithmeticConsistencyOf(normalizeUsageObservation({ inputTokens: 100, cacheReadTokens: 900, outputTokens: 20 }).usage)
  assert.equal(arithmetic.status, 'unknown')
  assert.equal(arithmetic.sum, null)
  assert.ok(arithmetic.missing.length > 0)
})

test('B3 算术不自洽 → inconsistent（仅此而已）', () => {
  const arithmetic = arithmeticConsistencyOf(normalizeUsageObservation({ inputTokens: 100, cacheReadTokens: 900, cacheWriteTokens: 0, outputTokens: 20, totalTokens: 200 }).usage)
  assert.equal(arithmetic.status, 'inconsistent')
  assert.equal(arithmetic.sum, 1020)
  assert.match(arithmetic.note, /不符|不等于/)
})

test('B4 无 cache 字段时不把缺失当 0 参与等式：status unknown，且不产语义结论', () => {
  const arithmetic = arithmeticConsistencyOf(normalizeUsageObservation({ inputTokens: 100, outputTokens: 20, totalTokens: 120 }).usage)
  assert.equal(arithmetic.status, 'unknown', 'cacheRead/cacheWrite 未报就不能按 0 凑等式')
  assert.ok(arithmetic.missing.includes('cacheReadTokens'))
  assert.equal('mutuallyExclusive' in arithmetic, false)
})

test('B5 ③ 分母缺项必须 null + coverage（不得把缺项当 0 算出 100%）', () => {
  const partial = cacheReadRatioOf(normalizeUsageObservation({ cacheReadTokens: 50, outputTokens: 10 }).usage)
  assert.equal(partial.value, null, '缺 inputTokens 分母时不得给比率')
  assert.equal(partial.coverage.inputTokens, 'missing')
  assert.equal(partial.coverage.cacheReadTokens, 'present')
  assert.match(partial.reason, /missing|缺/)
  assert.equal('hitRateWeighted' in partial, false, '旧名已删除')

  // 主复审：分母标三项，就不得只核验 input 而把缺失的 write 当 0
  const writeMissing = cacheReadRatioOf(normalizeUsageObservation({ inputTokens: 0, cacheReadTokens: 50 }).usage)
  assert.equal(writeMissing.value, null, '写入项缺失时不得按 0 参与分母')
  assert.equal(writeMissing.coverage.cacheWriteTokens, 'missing')
  assert.match(writeMissing.reason, /cacheWriteTokens/)

  // 显式 write=0 才算「已核验的三项分母」
  const full = cacheReadRatioOf(normalizeUsageObservation({ inputTokens: 100, cacheReadTokens: 300, cacheWriteTokens: 0, outputTokens: 5 }).usage)
  assert.ok(Math.abs(full.value - 0.75) < 1e-9)
  assert.equal(full.coverage.denominator, 'input+cacheRead+cacheWrite')
  assert.equal(full.semantics, 'unverified')

  const zeroDenominator = cacheReadRatioOf(normalizeUsageObservation({ inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 5 }).usage)
  assert.equal(zeroDenominator.value, null, '分母为 0 不是 0%')
})

// ---------------------------------------------------------------- C 范围

test('C1 ⑥ 只支持 plugin-surface；outboundRequest 返回 unsupported，不制造假观测', () => {
  assert.equal(observationScopeOf({ pluginSurface: { messages: 1 } }), 'plugin-surface')
  assert.equal(observationScopeOf({}), 'plugin-surface')
  assert.equal(observationScopeOf({ outboundRequest: { messages: 1 } }), 'unsupported')
  assert.equal(observationScopeOf({ outboundRequest: {}, pluginSurface: {} }), 'unsupported', '空对象也不得升级')
  const built = buildCacheObservation({ scope: { outboundRequest: { messages: 3 } }, usage: { inputTokens: 1, outputTokens: 1 }, at: 1 })
  assert.equal(built.ok, false)
  assert.equal(built.reason, 'unsupported-observation-scope')
  assert.equal('record' in built, false, '不支持的范围不得产出观测记录')
})

test('C2 观测对象里不出现 wire/vendor 口径的词（v4：layers 只声明 no-seam，不算观测 wire）', () => {
  const built = buildCacheObservation({ scope: { pluginSurface: { messages: 3, tools: 2 } }, usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 }, at: 1700000000000 })
  assert.equal(built.ok, true)
  assert.equal(built.record.observationScope, 'plugin-surface')
  // v4 新增的 layers 段用 `wire:'no-seam'` **明确否认**有 wire 观测：这是能力声明，
  // 不是"观测到了 wire"。因此断言收紧为「除这一处声明外，记录里不得出现 wire/vendor 口径」。
  const { layers, ...rest } = built.record
  assert.equal(layers.wire, 'no-seam')
  assert.equal(layers.logicalRequest, 'not-wired')
  assert.equal(/\bwire\b|vendor|供应商请求体/i.test(JSON.stringify(rest)), false)
})

// ---------------------------------------------------------------- D 指纹 / ⑦ append

function surfaceOf(overrides = {}) {
  return {
    messages: [{ role: 'user', text: '同一份内容' }, { role: 'assistant', text: '同一个回答' }],
    system: '固定系统提示',
    tools: [{ name: 'read', schemaHash: 'h-read' }],
    ...overrides,
  }
}

test('D1 相同语义内容 → 同指纹（键序无关）；无前值 change=null（P2-b：未知不是 unchanged）', () => {
  const a = surfaceFingerprintOf(surfaceOf())
  const b = surfaceFingerprintOf({ tools: [{ schemaHash: 'h-read', name: 'read' }], system: '固定系统提示', messages: [{ text: '同一份内容', role: 'user' }, { text: '同一个回答', role: 'assistant' }] })
  assert.equal(a.fingerprint, b.fingerprint)
  assert.equal(a.messageChange, null, '没有前一次观测时不得声称 unchanged')
  assert.equal(a.reason, null)
  assert.deepEqual([...SURFACE_CHANGE_KINDS], ['unchanged', 'appended', 'message-prefix-rewritten', 'system-changed', 'tools-changed'])
})

test('D2 ⑦ 尾部追加 = appended（不是 prefix rewrite），不推进 epoch', () => {
  const prev = surfaceFingerprintOf(surfaceOf())
  const appended = surfaceFingerprintOf(surfaceOf({
    messages: [{ role: 'user', text: '同一份内容' }, { role: 'assistant', text: '同一个回答' }, { role: 'user', text: '新一句话' }],
  }), { previous: prev })
  assert.notEqual(appended.fingerprint, prev.fingerprint)
  assert.equal(appended.messageChange, 'appended', '内容增长 ≠ 前缀改写')
  const epoch = nextProjectionEpoch(prev, appended)
  assert.equal(epoch.epoch, 0, '追加不推进投影前缀代际')
  assert.equal(epoch.reason, null)
  assert.equal(epoch.prefixChanged, false, '追加不改旧前缀')
})

test('D3 ⑦ 中间改写 = message-prefix-rewritten，才推进 epoch', () => {
  const prev = surfaceFingerprintOf(surfaceOf())
  const rewritten = surfaceFingerprintOf(surfaceOf({ messages: [{ role: 'user', text: '换了一句' }, { role: 'assistant', text: '同一个回答' }] }), { previous: prev })
  assert.equal(rewritten.messageChange, 'message-prefix-rewritten')
  assert.equal(rewritten.firstDivergence, 0)
  assert.deepEqual([...rewritten.fieldsChanged], ['messages'])
  const epoch = nextProjectionEpoch(prev, rewritten)
  assert.equal(epoch.epoch, 1)
  assert.equal(epoch.prefixChanged, true, '只报「投影前缀已变化」，不宣称供应商缓存失效')
  assert.equal('cacheInvalidated' in epoch, false, '不得越过 plugin-surface 证据范围宣称缓存失效')
  assert.equal(epoch.reason, 'message-prefix-rewritten')
})

test('D4 system/tools 变化分别可辨，并推进 epoch', () => {
  const base = surfaceFingerprintOf(surfaceOf())
  const sys = surfaceFingerprintOf(surfaceOf({ system: 'x' }), { previous: base })
  assert.equal(sys.reason, 'system-changed')
  assert.equal(nextProjectionEpoch(base, sys).epoch, 1)
  const tools = surfaceFingerprintOf(surfaceOf({ tools: [] }), { previous: base })
  assert.equal(tools.reason, 'tools-changed')
  assert.equal(nextProjectionEpoch(base, tools).epoch, 1)
})

test('D5 指纹不含正文：定长十六进制，观测记录里不出现原文', () => {
  const secret = '这是一段绝不应该出现在观测记录里的正文'
  const fp = surfaceFingerprintOf(surfaceOf({ messages: [{ role: 'user', text: secret }] }))
  assert.match(fp.fingerprint, /^[0-9a-f]{16}$/)
  assert.equal(JSON.stringify(fp).includes(secret), false)
  const built = buildCacheObservation({ scope: { pluginSurface: surfaceOf() }, usage: { inputTokens: 10, outputTokens: 1 }, at: 1700000000001, archiveEvent: { txn: 7, intentId: 'i-1' } })
  assert.equal(built.ok, true)
  for (const text of ['同一份内容', '同一个回答', '固定系统提示', 'h-read']) {
    assert.equal(JSON.stringify(built.record).includes(text), false, '不得含正文：' + text)
  }
})

// ---------------------------------------------------------------- E 账本

test('E1 cacheWriteTokens/ttft 读数保留：只进 cache 段，不改占用口径', async () => {
  await withDir(async (dir) => {
    await appendUsageLine(dir, 1, { inputTokens: 100, cacheReadTokens: 900, outputTokens: 20, totalTokens: 1020, cacheWriteTokens: 5 })
    await appendUsageLine(dir, 2, { inputTokens: 200, cacheReadTokens: 300, outputTokens: 10, totalTokens: 510 })
    const summary = await readUsageSummary(dir)
    assert.equal(summary.samples, 2)
    assert.equal(summary.cache.totals.cacheWriteTokens, 5, '旧实现读侧静默丢弃')
    assert.equal(summary.cache.totals.cacheReadTokens, 1200)
    assert.equal(summary.cache.totals.totalTokens, 1530)
    assert.equal(summary.occupancy.latest, 500, '占用口径不变：in + read')
    // 主复审④：不新增「本来不存在」的 ttft 总和字段，也不把它写进旧 totals
    assert.equal('ttftMs' in summary.totals, false, '旧 totals 不得新增 ttftMs')
    assert.equal('ttftMs' in summary.cache.totals, false, '诚实 totals 也不得新增 ttftMs')
    assert.equal('samplesWithTtft' in summary.cache, false, '不得新增 samplesWithTtft')
    assert.equal('cacheWriteTokens' in summary.totals, false, '旧 totals 只保既有键：cacheWriteTokens 只进 cache.totals')
  })
})

test('E2 缺失字段仍不写 0：availability=missing，诚实 totals=null', async () => {
  await withDir(async (dir) => {
    await appendUsageLine(dir, 1, { inputTokens: 10, outputTokens: 1 })
    const rows = (await readFile(path.join(dir, 'usage.jsonl'), 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line))
    assert.equal('cacheReadTokens' in rows[0], false)
    const summary = await readUsageSummary(dir)
    assert.equal(summary.cache.availability.cacheReadTokens, 'missing')
    assert.equal(summary.cache.availability.cacheWriteTokens, 'missing')
    assert.equal(summary.cache.totals.cacheWriteTokens, null, '缺失 = null，不硬写 0')
    assert.equal(summary.cache.samplesWithCacheRead, 0)
  })
})

test('E3 观测账本旁路：一行、合同版本、不污染 usage 聚合', async () => {
  await withDir(async (dir) => {
    const input = { scope: { pluginSurface: surfaceOf() }, usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 }, at: 1700000000002 }
    assert.equal(buildCacheObservation(input).ok, true, '前置：入参可构造')
    const written = await appendCacheObservation(dir, 7, input)
    assert.equal(written.ok, true)
    assert.equal(written.appended, true)
    const rows = (await readFile(path.join(dir, 'cache-observations.jsonl'), 'utf8')).trimEnd().split('\n')
    assert.equal(rows.length, 1)
    const row = JSON.parse(rows[0])
    assert.equal(row.seq, 7)
    assert.equal(row.contractVersion, 4)
    assert.equal(row.observationScope, 'plugin-surface')
    assert.equal(await readUsageSummary(dir), null)
  })
})

test('E4 ④ 读侧没有 ttft 白名单项：ttftMs 不构成 token 样本、不进任何输出字段', async () => {
  // 主复审：`USAGE_FIELDS` 仍带 'ttftMs'，等于给一个「本批已删除」的字段留了读侧入口。
  // 先核对返回面命名：`readUsageSummary` 返回 {samples,badLines,occupancy{p50,p90,p95,max,latest},totals,cache}，
  // **没有 recent 字段**；唯一「最新」口径是 `occupancy.latest`（= input + cacheRead）。
  await withDir(async (dir) => {
    // ① 只带 ttftMs 的行不是 token 样本（旧白名单把它算成 usable 字段 → samples=1）
    await writeFile(path.join(dir, 'usage.jsonl'), JSON.stringify({ seq: 9, ttftMs: 250 }) + '\n', 'utf8')
    // P3-02 改口径：全坏行不再返回 null，改为 samples===0 + badLines 计数。
    const ttftOnly = await readUsageSummary(dir)
    assert.notEqual(ttftOnly, null, '有行就返回对象（P3-02）')
    assert.equal(ttftOnly.samples, 0, 'ttftMs 不是 token 字段，不得让聚合以为有样本')
    assert.equal(ttftOnly.badLines, 1)

    // ② 混入行：latest 只能由 input+cacheRead 决定，不得被 ttft 值放大
    await writeFile(path.join(dir, 'usage.jsonl'), [
      JSON.stringify({ seq: 1, inputTokens: 100, cacheReadTokens: 900, outputTokens: 20, ttftMs: 5000 }),
      JSON.stringify({ seq: 2, inputTokens: 50, outputTokens: 5, ttftMs: 1 }),
    ].join('\n') + '\n', 'utf8')
    const summary = await readUsageSummary(dir)
    assert.equal(summary.samples, 2)
    // 核对过命名与语义：latest = **最后一条样本**的 in+read（不是最大值）；max = 最大占用
    assert.equal(summary.occupancy.latest, 50, 'latest 仍是最后一条的 in+read，不含 ttft')
    assert.equal(summary.occupancy.max, 1000, 'max 只由 in+read 决定')
    assert.equal('recent' in summary, false, '返回面没有 recent 字段（不要凭旧字段造一个）')
    const keys = []
    const walk = (value, prefix) => {
      if (value === null || typeof value !== 'object') return
      for (const [key, inner] of Object.entries(value)) { keys.push(prefix + key); walk(inner, prefix + key + '.') }
    }
    walk(summary, '')
    assert.deepEqual(keys.filter((key) => /ttft/i.test(key)), [], '任何层级都不得输出 ttft 字段：' + keys.join(','))
  })
})

// ---------------------------------------------------------------- F 失败 / ⑤ sanitize / ⑧ 并发

test('F1 ⑤ sanitize 严格：null usage 单元格不抛、未知字段拒绝、非法格式拒绝', () => {
  // 旧实现在 try 外读 usage[field].value ⇒ null 直接 TypeError 抛出
  const nullCell = { contractVersion: 4, observationScope: 'plugin-surface', at: 1, request: null, usage: { inputTokens: null }, measurement: null, arithmetic: null, cacheReadRatio: null, surface: null, archive: null, layers: null, lifecycle: null }
  const r1 = sanitizeCacheObservation(nullCell)
  assert.equal(r1.ok, false, 'null 单元格必须结构化拒绝而不是抛')
  assert.match(r1.reason, /inputTokens/)

  // 恶意/未知字段：不得静默剥离后保存（会被当成已核验）
  const unknown = { contractVersion: 4, observationScope: 'plugin-surface', at: 1, request: null, usage: null, measurement: null, arithmetic: null, cacheReadRatio: null, surface: null, archive: null, receiptText: '正文' }
  const r2 = sanitizeCacheObservation(unknown)
  assert.equal(r2.ok, false)
  assert.match(r2.reason, /未知字段|receiptText/)

  // 任意字符串冒充指纹/原因/ID：全部拒绝
  const badShape = { contractVersion: 4, observationScope: 'plugin-surface', at: 1, request: null, usage: null, measurement: null, arithmetic: null, cacheReadRatio: null, surface: { fingerprint: '正文夹带', epoch: 1, reason: '正文', firstDivergence: 0, messageChange: 'appended' }, archive: null }
  assert.equal(sanitizeCacheObservation(badShape).ok, false)

  assert.equal(sanitizeCacheObservation({ contractVersion: 2, observationScope: 'plugin-surface' }).ok, false, 'P2-b 后 v2 记录按版本拒绝')
  assert.equal(sanitizeCacheObservation({ contractVersion: 4, observationScope: 'outbound-request' }).ok, false)
  assert.equal(sanitizeCacheObservation({ contractVersion: 1, observationScope: 'plugin-surface' }).ok, false)
  assert.equal(sanitizeCacheObservation(null).ok, false)
  assert.equal(sanitizeCacheObservation('string').ok, false)
})

test('F2 ⑤ sanitize 通过合法形状时重算派生量（不信外部声称）', () => {
  const built = buildCacheObservation({ scope: { pluginSurface: surfaceOf() }, usage: { inputTokens: 100, cacheReadTokens: 300, cacheWriteTokens: 0, outputTokens: 5, totalTokens: 405 }, at: 3 })
  assert.equal(built.ok, true)
  const tampered = structuredClone(built.record)
  tampered.arithmetic = { status: 'consistent', sum: 1, evidence: 'total-equals-component-sum', missing: [] }
  tampered.cacheReadRatio = { value: 0.999, coverage: { inputTokens: 'present', cacheReadTokens: 'present', denominator: 'input+cacheRead+cacheWrite' }, reason: null, semantics: 'unverified' }
  const sanitized = sanitizeCacheObservation(tampered)
  assert.equal(sanitized.ok, true)
  assert.equal(sanitized.record.arithmetic.sum, 405, '派生量必须重算')
  assert.ok(Math.abs(sanitized.record.cacheReadRatio.value - 0.75) < 1e-9, '比率必须重算')
})

test('F3 观测失败返回结构化 error，不抛、不写半行', async () => {
  await withDir(async (dir) => {
    await mkdir(path.join(dir, 'cache-observations.jsonl'), { recursive: true })
    const result = await appendCacheObservation(dir, 1, { scope: { pluginSurface: { messages: 1 } }, usage: { inputTokens: 1, outputTokens: 1 }, at: 1 })
    assert.equal(result.ok, false)
    assert.equal(typeof result.error, 'string')
    assert.ok(result.error.length > 0)
  })
})

test('F4 不适用（无目录/无 seq）安静返回且不建文件', async () => {
  assert.equal((await appendCacheObservation(null, 1, {})).ok, true)
  assert.equal((await appendCacheObservation(undefined, Number.NaN, {})).ok, true)
  await withDir(async (dir) => {
    assert.equal((await appendCacheObservation(dir, Number.NaN, {})).ok, true)
    assert.equal((await appendCacheObservation(dir, 1, { usage: { inputTokens: 'x' } })).ok, false, '非法 usage 必须返回 error 而不是抛')
    await assert.rejects(() => readFile(path.join(dir, 'cache-observations.jsonl'), 'utf8'), (e) => e?.code === 'ENOENT')
  })
})

test('F5 ⑧ 同 seq 并发追加（锁内 check+append）：只落一行', async () => {
  await withDir(async (dir) => {
    const input = { scope: { pluginSurface: { messages: 1 } }, usage: { inputTokens: 1, outputTokens: 1 }, at: 1 }
    const results = await Promise.all([
      appendCacheObservation(dir, 3, input),
      appendCacheObservation(dir, 3, input),
      appendCacheObservation(dir, 3, input),
    ])
    assert.ok(results.every((r) => r.ok === true), '并发调用不得报错')
    const rows = (await readFile(path.join(dir, 'cache-observations.jsonl'), 'utf8')).trimEnd().split('\n')
    assert.equal(rows.length, 1, '并发同 seq 只能写一行：' + JSON.stringify(rows.map((r) => JSON.parse(r).seq)))
    assert.equal(results.filter((r) => r.appended === true).length, 1)
  })
})

test('F6 seq 回退不追加（串行幂等）', async () => {
  await withDir(async (dir) => {
    const input = { scope: { pluginSurface: { messages: 1 } }, usage: { inputTokens: 1, outputTokens: 1 }, at: 1 }
    await appendCacheObservation(dir, 5, input)
    assert.equal((await appendCacheObservation(dir, 5, input)).appended, false)
    assert.equal((await appendCacheObservation(dir, 4, input)).appended, false)
    assert.equal((await readFile(path.join(dir, 'cache-observations.jsonl'), 'utf8')).trimEnd().split('\n').length, 1)
  })
})

// ---------------------------------------------------------------- F 续：锁语义 / 构造-校验一致

/**
 * ①（主复审）：失锁传播。上一版 append 用 `async () =>` 忽略 ownership，
 * 新增写原语退回了 beta.54 已修的失锁漏洞：外层锁被接管后仍照写。
 * 判据与 `test/v3-lock-ownership-propagation.test.mjs` 同源：锁内改 owner.json 为别人的
 * token，等过 2×心跳间隔 → `ownership.isLost()` 为真 → 写原语必须失败关闭且字节不变。
 */
async function stealLock(dir) {
  const takeover = { token: 'token-of-new-owner', pid: 1, host: 'other', acquiredAt: Date.now(), heartbeatAt: Date.now() }
  await writeFile(path.join(dir, '.write-lock', 'owner.json'), JSON.stringify(takeover) + '\n', 'utf8')
}

test('F7 失锁后 append 必须失败关闭（ELOCK_LOST）且不动字节', async () => {
  await withDir(async (dir) => {
    const input = { usage: { inputTokens: 1, outputTokens: 1 }, at: 1 }
    await withCrossProcessWriteLock(dir, async (ownership) => {
      ownership.assertOwned()
      await stealLock(dir)
      await new Promise((resolve) => setTimeout(resolve, 260)) // ttl 200 → 心跳 66ms
      assert.equal(ownership.isLost(), true, '前置：心跳必须判出失锁')
      const result = await appendCacheObservation(dir, 1, input)
      assert.equal(result.ok, false, '失锁后不得返回成功')
      assert.equal(result.error, 'ELOCK_LOST', '必须结构化报失锁，不吞成普通错误')
    }, { ttlMs: 200 })
    await assert.rejects(() => readFile(path.join(dir, 'cache-observations.jsonl'), 'utf8'), (e) => e?.code === 'ENOENT', '失锁后不得落任何字节')
  })
})

test('F8 正对照：重入（同一把锁）时 append 照常成功，不误挡正常路径', async () => {
  await withDir(async (dir) => {
    const input = { usage: { inputTokens: 7, outputTokens: 1 }, at: 2 }
    await withCrossProcessWriteLock(dir, async (ownership) => {
      ownership.assertOwned()
      const result = await appendCacheObservation(dir, 1, input)
      assert.equal(result.ok, true, JSON.stringify(result))
      assert.equal(result.appended, true, '重入路径必须复用外层锁，而不是另抢一把')
    }, { ttlMs: 5000 })
    const rows = (await readFile(path.join(dir, 'cache-observations.jsonl'), 'utf8')).trimEnd().split('\n')
    assert.equal(rows.length, 1)
    assert.equal(JSON.parse(rows[0]).usage.inputTokens.value, 7)
  })
})

/**
 * ③（主复审）：构造与校验必须同口径。
 * 上一版 `build` 接受小数时间戳（得到 1.3999…），而 `sanitize` 要求整数——
 * 生成了一条自己拒绝的「合法记录」。这里锁死：同一输入走 build → sanitize → append 全链通过。
 */
test('F9 build → sanitize → append 同一输入链通过（含小数时间戳归未知）', async () => {
  await withDir(async (dir) => {
    for (const timing of [
      { stepStartedAt: 1000, firstTokenAt: 1250 },
      { stepStartedAt: 1.1, firstTokenAt: 2.5 }, // 小数毫秒：构造层归 null，两层都不接受该值
      { stepStartedAt: null, firstTokenAt: 10 },
    ]) {
      const input = { scope: { pluginSurface: { messages: 1 } }, usage: { inputTokens: 3, outputTokens: 1 }, timing, at: 5 }
      const built = buildCacheObservation(input)
      assert.equal(built.ok, true, JSON.stringify(timing))
      const sanitized = sanitizeCacheObservation(built.record)
      assert.equal(sanitized.ok, true, '构造产物必须能过自校验：' + JSON.stringify(sanitized.reason))
      assert.deepEqual(sanitized.record.measurement, built.record.measurement, '两层测量口径必须一致：' + JSON.stringify(timing))
      assert.equal(sanitized.record.contractVersion, 4)
    }
    const written = await appendCacheObservation(dir, 1, { usage: { inputTokens: 3, outputTokens: 1 }, timing: { stepStartedAt: 1.1, firstTokenAt: 2.5 }, at: 5 })
    assert.equal(written.ok, true, JSON.stringify(written))
    const row = JSON.parse((await readFile(path.join(dir, 'cache-observations.jsonl'), 'utf8')).trimEnd())
    assert.equal(row.measurement.stepToFirstToken.value, null, '小数毫秒不得落成小数值')
  })
})