/**
 * P5 T2：版本合同、参数/资格、partial/超时/取消与 T1 回退（合同 + 假 MCP client）。
 *
 * 判据（开发流程 P5 验收 / §4.2 / §7.2 R03、R09）：
 * - 0.9.17 已隔离冒烟 + 查询合同探针 → 登记；0.9.10 保留，read-query 仅 contract；
 * - cg read 用 k（未验证版本同时带 limit），不得再把 limit 当检索条数；
 * - state 四态（ACCEPT/DEFER/BLINDSPOT/REJECT）→ eligible/deferred/rejected/unknown；
 * - RRF 名次分不得穿本地 pack 门（R03）：外部首名也不自动装包；
 * - 外部超时/取消/失败一律回 T1，并把 status/partial/reason 如实带回；
 * - 能力 searchQuery=off 时不发外部请求（fail-closed，不付等待）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { negotiateMemoryProvider, CANDIDATE_DSH_MEMORY_VERSIONS, TESTED_DSH_MEMORY_VERSIONS } from '../src/v3/contracts/capabilities.mjs'
import { t2CapabilitiesOf, t2ContractOf } from '../src/v3/contracts/t2-contract.mjs'
import {
  T2_EXTERNAL_SEARCH_DEFAULT_TIMEOUT_MS,
  T2_EXTERNAL_SEARCH_MAX_TIMEOUT_MS,
  createT2IsolatedProvider,
  eligibilityOfState,
  externalSearchArgsOf,
  mergeHits,
} from '../src/v3/adapters/retrieval/t2-isolated-provider.mjs'
import { createRecall } from '../src/v3/application/recall.mjs'

const LOCAL_A = 'v3r-aaaaaaaaaaaaaaaa'
const EXT_ACCEPT = 'v3r-cccccccccccccccc'
const EXT_DEFER = 'v3r-dddddddddddddddd'
const EXT_REJECT = 'v3r-eeeeeeeeeeeeeeee'
const EXT_UNKNOWN = 'v3r-ffffffffffffffff'
const EXT_WEAK = 'v3r-9999999999999999'

function fakeT1({ pack = [{ id: LOCAL_A, score: 10 }], display = [{ id: LOCAL_A, score: 10 }] } = {}) {
  return {
    async search() { return { display, pack, dropped: [], oovTerms: [] } },
    async read(id) { return { text: '本地正文 ' + id, record: { id, createdAt: 1 } } },
    async health() { return { healthy: true } },
    capabilities() { return { name: 'local-lexical-v3', tier: 'T1' } },
  }
}

function fakeClient({ rows = [], warning = null, hang = false, onCall = null } = {}) {
  const calls = []
  return {
    calls,
    async callTool(name, args, opts) {
      calls.push({ name, args, opts })
      if (typeof onCall === 'function') return await onCall(name, args, opts)
      if (hang) return new Promise(() => {})
      if (args.op === 'write') return { ok: true }
      if (args.op === 'forget') return { ok: true }
      if (args.op === 'read' && typeof args.query === 'string') {
        return { meta: {}, results: rows, ...(warning === null ? {} : { warning }) }
      }
      return { ok: true }
    },
    async close() {},
  }
}

const CAPS_0917 = {
  providerVersion: '0.9.17',
  contractId: 'cg-read-v1',
  schemaDigest: 'abc123',
  features: {
    basicMirror: { state: 'on', reason: 'ok' },
    searchQuery: { state: 'on', reason: 'k 已验证' },
    queryExcerpt: { state: 'off', reason: '包装映射未验证' },
    multiPathRecall: { state: 'off', reason: '未启用' },
    taskFactMirror: { state: 'off', reason: '未实现' },
  },
  packExternal: { state: 'off', reason: 'R03' },
}

function providerOf({ client = fakeClient(), t1 = fakeT1(), capabilities = CAPS_0917 } = {}) {
  return createT2IsolatedProvider({ t1, client, sessionKey: 'sess-p5', capabilities })
}

test('版本合同：0.9.17 只登记 candidate；默认启用仍只有 0.9.10', () => {
  assert.deepEqual([...TESTED_DSH_MEMORY_VERSIONS], ['0.9.10'])
  assert.deepEqual([...CANDIDATE_DSH_MEMORY_VERSIONS], ['0.9.17'])
  assert.equal(t2ContractOf('0.9.17').status, 'candidate')
  assert.equal(t2ContractOf('0.9.17').readQueryVerified, true)
  assert.equal(t2ContractOf('0.9.10').readQueryVerified, false)
  assert.equal(t2ContractOf('0.0.1'), null)
  // 候选版本能力报告可以描述「能做到什么」，但协商不升 T2（避免默认切换生产路径）。
  const caps = t2CapabilitiesOf({
    version: '0.9.17', tools: ['cg', 'stg'], smokePassed: true, isolated: true,
    queryContract: { passed: true, rows: 2 }, schemaDigest: 'abc123',
  })
  assert.equal(caps.features.basicMirror.state, 'on')
  assert.equal(caps.features.searchQuery.state, 'on')
  assert.equal(caps.features.queryExcerpt.state, 'off')
  assert.equal(caps.packExternal.state, 'off')
  assert.equal(caps.schemaDigest, 'abc123')
  assert.ok(caps.downgraded.some((item) => item.feature === 'queryExcerpt'))
  const candidate = negotiateMemoryProvider({
    name: '@furongjun1999/dsh-memory', version: '0.9.17', tools: ['cg', 'stg'], smokePassed: true, isolated: true,
    queryContract: { passed: true, rows: 2 }, schemaDigest: 'abc123',
  })
  assert.equal(candidate.tier, 'T1')
  assert.match(candidate.reason, /候选版本/)
  assert.match(candidate.reason, /未默认启用/)
  // 已实测 0.9.10 仍可升 T2，能力报告随决策返回。
  const t2 = negotiateMemoryProvider({
    name: '@furongjun1999/dsh-memory', version: '0.9.10', tools: ['cg', 'stg'], smokePassed: true, isolated: true,
    schemaDigest: 'legacy',
  })
  assert.equal(t2.tier, 'T2')
  assert.equal(t2.capabilities.providerVersion, '0.9.10')
  assert.equal(t2.capabilities.features.basicMirror.state, 'on')
  assert.equal(t2.capabilities.features.searchQuery.state, 'contract')
  const unknown = negotiateMemoryProvider({
    name: '@furongjun1999/dsh-memory', version: '9.9.9', tools: ['cg'], smokePassed: true, isolated: true,
  })
  assert.equal(unknown.tier, 'T1')
  assert.match(unknown.reason, /版本未实测/)
})

test('分能力：探针未过的 0.9.17 searchQuery=off；0.9.10 无查询探针时=contract', () => {
  const failed = t2CapabilitiesOf({
    version: '0.9.17', tools: ['cg'], smokePassed: true, isolated: true,
    queryContract: { passed: false, reason: '结果行缺 state' },
  })
  assert.equal(failed.features.searchQuery.state, 'off')
  assert.match(failed.features.searchQuery.reason, /合同探针未通过/)
  const legacy = t2CapabilitiesOf({
    version: '0.9.10', tools: ['cg'], smokePassed: true, isolated: true,
  })
  assert.equal(legacy.features.basicMirror.state, 'on')
  assert.equal(legacy.features.searchQuery.state, 'contract')
})

test('R09：0.9.17 合同只发 k；0.9.10 未验证时同时带 k 与 limit；k 受双重上限', () => {
  const verified = externalSearchArgsOf(t2ContractOf('0.9.17'), '查询', { session: 's', limit: 100 })
  assert.equal(verified.k, 50)
  assert.equal(Object.hasOwn(verified, 'limit'), false)
  const unverified = externalSearchArgsOf(t2ContractOf('0.9.10'), '查询', { session: 's', limit: 10 })
  assert.equal(unverified.k, 10)
  assert.equal(unverified.limit, 10)
  assert.equal(externalSearchArgsOf(null, '查询', { session: 's', limit: 10 }).k, 10, '未知版本也受外部上限约束')
})

test('资格四态映射与 R03：外部首名/弱候选不得穿本地 pack 门', async () => {
  assert.equal(eligibilityOfState('ACCEPT'), 'eligible')
  assert.equal(eligibilityOfState('DEFER'), 'deferred')
  assert.equal(eligibilityOfState('BLINDSPOT'), 'deferred')
  assert.equal(eligibilityOfState('REJECT'), 'rejected')
  assert.equal(eligibilityOfState(undefined), 'unknown')

  const merged = mergeHits(
    { display: [{ id: LOCAL_A, score: 10 }], pack: [{ id: LOCAL_A, score: 10 }] },
    [
      { id: EXT_ACCEPT, score: 0.016, state: 'ACCEPT', eligibility: 'eligible' },
      { id: EXT_DEFER, score: 0.015, state: 'DEFER', eligibility: 'deferred' },
      { id: EXT_REJECT, score: 0.014, state: 'REJECT', eligibility: 'rejected' },
    ],
    { limit: 10, packMinScore: 0.5 },
  )
  assert.deepEqual(merged.pack.map((hit) => hit.id), [LOCAL_A], '外部命中默认不自动装包')
  assert.equal(merged.externalEligibility.eligible, 1)
  assert.equal(merged.externalEligibility.deferred, 1)
  assert.equal(merged.externalEligibility.rejected, 1)

  const weak = await providerOf({ client: fakeClient({ rows: [{ node: { id: EXT_WEAK }, score: 0.0001 }] }), t1: fakeT1({ pack: [], display: [] }) })
    .search('查询', { packMinScore: 0.001 })
  assert.equal(weak.pack.length, 0, '唯一外部弱候选不得因「第一名」自动装包')
  assert.equal(weak.display.length, 1, '展示面仍可见（带 unknown 资格）')
  assert.equal(weak.externalEligibility.unknown, 1)

  const packed = await providerOf({
    client: fakeClient({ rows: [{ node: { id: EXT_ACCEPT }, score: 0.016, state: 'ACCEPT' }] }),
    capabilities: { ...CAPS_0917, packExternal: { state: 'on', reason: 'test' } },
  }).search('查询', { packMinScore: 0.5 })
  assert.deepEqual(packed.pack.map((hit) => hit.id).sort(), [EXT_ACCEPT, LOCAL_A].sort(), '显式开启时仅 eligible 外部命中可进包')
})

test('partial：warning（k 越界/夹紧）如实返回；无命中时回退 T1', async () => {
  const merged = await providerOf({
    client: fakeClient({ rows: [{ node: { id: EXT_ACCEPT }, score: 0.2, state: 'ACCEPT' }], warning: { code: 'k_out_of_range', hint: 'k 被夹紧到 500' } }),
  }).search('查询', { packMinScore: 0.5 })
  assert.equal(merged.status, 'partial')
  assert.equal(merged.partial, true)
  assert.match(merged.reason, /k 被夹紧/)
  assert.equal(merged.t1Fallback, false, '仍有外部命中参与展示')
  const fallback = await providerOf({
    client: fakeClient({ rows: [], warning: { code: 'k_out_of_range', hint: 'k=0 显式空结果' } }),
  }).search('查询', { packMinScore: 0.5 })
  assert.equal(fallback.status, 'partial')
  assert.equal(fallback.t1Fallback, true)
  assert.deepEqual(fallback.pack.map((hit) => hit.id), [LOCAL_A])
})

test('P2：显式 deadline 不被静默夹到 10 秒，只受文档化硬顶约束', async () => {
  // 0.15.0 P5 验收缺陷：externalSearch 无条件 Math.min(10000, remaining)，
  // 调用方给的 15 秒预算被静默缩水成 10 秒，而文档写的是「尊重统一 deadline」。
  assert.equal(T2_EXTERNAL_SEARCH_DEFAULT_TIMEOUT_MS, 10000)
  assert.equal(T2_EXTERNAL_SEARCH_MAX_TIMEOUT_MS, 60000, '硬顶必须有文档化数值')
  const client = fakeClient({ rows: [{ node: { id: EXT_ACCEPT }, score: 0.2, state: 'ACCEPT' }] })
  const provider = providerOf({ client })

  await provider.search('查询', { deadline: Date.now() + 15000 })
  const explicit = client.calls.at(-1).opts
  assert.ok(explicit.timeoutMs > T2_EXTERNAL_SEARCH_DEFAULT_TIMEOUT_MS, '显式 deadline 必须大于默认值：' + explicit.timeoutMs)
  assert.ok(explicit.timeoutMs <= 15000, '不得超过调用方给的截止时间：' + explicit.timeoutMs)

  await provider.search('查询', { deadline: Date.now() + 10 * 60 * 1000 })
  assert.equal(client.calls.at(-1).opts.timeoutMs, T2_EXTERNAL_SEARCH_MAX_TIMEOUT_MS, '超过硬顶时按硬顶，并如实可见')

  await provider.search('查询')
  assert.equal(client.calls.at(-1).opts.timeoutMs, T2_EXTERNAL_SEARCH_DEFAULT_TIMEOUT_MS, '无 deadline 才用默认值')
})

test('P3：mergeHits 装包面是本地 pack 与展示面的并集（不静默丢本地装包项）', () => {
  // 本地 pack 里若有 display（前 limit 条）之外的命中，旧实现只从 mergedAll 里筛，
  // 该条目会静默消失——装包面比 T1 决定的还小。
  const PACK_ONLY = 'v3r-bbbbbbbbbbbbbbbb'
  const merged = mergeHits(
    { display: [{ id: LOCAL_A, score: 10 }], pack: [{ id: LOCAL_A, score: 10 }, { id: PACK_ONLY, score: 8 }] },
    [],
    { limit: 1 },
  )
  assert.equal(merged.display.length, 1, '展示面仍受 limit 约束')
  assert.deepEqual(merged.pack.map((hit) => hit.id).sort(), [LOCAL_A, PACK_ONLY].sort(), '装包面取并集：' + JSON.stringify(merged.pack))
})

test('超时：统一截止时间到 → partial + 回退 T1（不拖住 pre-step）', async () => {
  const started = Date.now()
  const result = await providerOf({ client: fakeClient({ hang: true }) }).search('查询', {
    packMinScore: 0.5,
    deadline: Date.now() + 20,
  })
  const elapsed = Date.now() - started
  assert.equal(result.status, 'partial')
  assert.equal(result.t1Fallback, true)
  assert.match(result.reason, /超时/)
  assert.ok(elapsed < 1000, '等待应受截止时间约束，实测 ' + elapsed + 'ms')
  assert.deepEqual(result.pack.map((hit) => hit.id), [LOCAL_A])
})

test('取消：截止时间已到 / AbortSignal 都回 cancelled，T1 结果原样返回', async () => {
  const missed = await providerOf({ client: fakeClient() }).search('查询', { deadline: Date.now() - 1 })
  assert.equal(missed.status, 'cancelled')
  assert.equal(missed.t1Fallback, true)

  const client = fakeClient({ hang: true })
  const controller = new AbortController()
  const promise = providerOf({ client }).search('查询', { deadline: Date.now() + 5000, signal: controller.signal })
  setTimeout(() => controller.abort(), 20)
  const result = await promise
  assert.equal(result.status, 'cancelled')
  assert.deepEqual(result.pack.map((hit) => hit.id), [LOCAL_A])
})

test('能力 searchQuery=off：不发起外部请求（fail-closed）', async () => {
  const client = fakeClient()
  const result = await providerOf({
    client,
    capabilities: { ...CAPS_0917, features: { ...CAPS_0917.features, searchQuery: { state: 'off', reason: '合同探针未过' } } },
  }).search('查询')
  assert.equal(result.status, 'unsupported')
  assert.equal(result.t1Fallback, true)
  assert.match(result.reason, /合同探针未过/)
  assert.equal(client.calls.length, 0)
})

test('recall 集成：partial 状态在回注包头部可见，窗口仍从本地原记录选', async () => {
  const provider = {
    async search() {
      return { display: [{ id: LOCAL_A, score: 1 }], pack: [{ id: LOCAL_A, score: 1 }], oovTerms: [], status: 'partial', partial: true, t1Fallback: true, sourceLabel: '本地词法索引（T2 回退）', reason: '外部超时' }
    },
    async read() { return { text: '开头无关。'.repeat(50) + ' 结论 ERR_TAIL_X7', record: { createdAt: 1 } } },
    async chunksOf() { return { state: 'absent', spans: [] } },
    async health() { return { healthy: true } },
    capabilities() { return { name: 'fake', tier: 'T2', live: true } },
  }
  const recall = createRecall({ provider, sessionKey: 'sess-p5', metrics: null })
  const out = await recall({ query: 'ERR_TAIL_X7', turn: 1, previewChars: 80 })
  assert.equal(out.injected, true)
  assert.equal(out.searchStatus, 'partial')
  assert.equal(out.partial, true)
  assert.equal(out.t1Fallback, true)
  assert.match(out.text, /检索状态：部分结果/)
  assert.equal(out.text.includes('ERR_TAIL_X7'), true)
})

test('recall 把统一 deadline 与 signal 传给 provider（不各自计时）', async () => {
  let seen = null
  const provider = {
    async search(_query, opts) { seen = opts; return { display: [], pack: [], oovTerms: [] } },
    async read() { throw new Error('不应读取') },
    async health() { return { healthy: true } },
    capabilities() { return { name: 'fake', tier: 'T2', live: true } },
  }
  const recall = createRecall({ provider, sessionKey: 'sess-p5', metrics: null })
  const controller = new AbortController()
  await recall({ query: '查询', turn: 1, timeoutMs: 123, signal: controller.signal })
  assert.ok(Number.isFinite(seen.deadline))
  assert.equal(seen.signal, controller.signal)
  assert.ok(seen.deadline - Date.now() <= 123)
})
