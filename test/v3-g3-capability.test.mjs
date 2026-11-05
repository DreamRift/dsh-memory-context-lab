/**
 * G3 分层观测能力表 + usage 逐 provider 归一 + 只读 policy 输入端口（离线守卫）。
 *
 * ## 判据来源
 * - 开发流程 §9.1：四层能力表（plugin-surface / logical-request / wire / provider-usage），
 *   每层记来源、时点、可见字段、缺口；**不得**用 logical-request 哈希冒充 wire；
 *   工具重试不是一次请求。
 * - 开发流程 §9.3：旧合同明确拒绝 outbound-request；**不得**塞伪 plugin-surface 标签绕过验证。
 * - 开发流程 §9.5：usage 逐 provider 归一（input 是否含 cache、能否相加、reasoning 归属）。
 * - 开发流程 §9.6/§9.7：稳定组件哈希/数量/代际与观察范围入观测；G5 另立只读 policy 端口。
 * - P0 宿主合同 §2.4（TokenUsage 字段与缺失语义）/§2.5（wire 无 seam，llm/stream 是逻辑请求）
 *   /§2.9（宿主没有 requestId）。
 *
 * ## 断言组
 * C1 能力表形状与封闭集 / C2 范围判定与原因码（含伪标签绕过）/ C3 layers 段 /
 * C4 组件哈希·数量·代际·覆盖度 / C5 usage 归一与可加性 / C6 policy 端口形状 /
 * C7 边界（导入级：决策层不得导入观测模块；时间戳不进投影）。
 *
 * ## 不适用条件与已知边界
 * 只验合同与 fake 端口；真实宿主的 `llm/stream` 装配、真实 provider 字段、wire 均未验
 * （wire 本就是 `no-seam`，本文件不假装能验）。价格/金额不在本层（G8）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  CACHE_TOKENS_CONTRACT_VERSION,
  buildCacheObservation,
  readObservationRowOf,
  sanitizeCacheObservation,
  surfaceFingerprintOf,
} from '../src/v3/contracts/cache-observation.mjs'
import {
  CAPABILITY_LAYERS,
  CAPABILITY_STATES,
  LAYER_OBSERVATION_STATES,
  OBSERVATION_CAPABILITY_TABLE,
  OBSERVATION_CAPABILITY_VERSION,
  capabilityOf,
  layersSectionOf,
  observationScopeDecisionOf,
  sanitizeLayersSection,
} from '../src/v3/contracts/observation-capability.mjs'
import {
  POLICY_INPUT_FIELDS,
  POLICY_INPUT_PORT,
  POLICY_INPUT_PORT_VERSION,
  sanitizePolicyInput,
} from '../src/v3/contracts/observation-policy-port.mjs'
import {
  PROVIDER_USAGE_PROFILES,
  USAGE_NORMALIZATION_VERSION,
  additivityOf,
  usageProfileOf,
} from '../src/v3/contracts/usage-normalization.mjs'
import { normalizeUsageObservation } from '../src/v3/contracts/cache-observation.mjs'

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src')

const msg = (role, text, extra = {}) => ({ role, content: [{ type: 'text', text }], ...extra })
const PRE_STEP = { system: false, tools: false }
const FULL = { system: true, tools: true }

function buildOf(extra = {}) {
  const built = buildCacheObservation({
    usage: { inputTokens: 100, cacheReadTokens: 300, cacheWriteTokens: 0, outputTokens: 10, totalTokens: 410 },
    at: 1700000000000,
    request: { turn: 1, step: 1, provider: 'deepseek', model: 'deepseek-v4.1-flash' },
    surface: { messages: [msg('user', '问')] },
    surfaceCoverage: PRE_STEP,
    surfaceSnapshot: 'pre-step',
    ...extra,
  })
  assert.equal(built.ok, true, JSON.stringify(built))
  return built
}

// ---------------------------------------------------------------- C1 能力表

test('C1 四层能力表：封闭集、顺序固定、逐层有来源/时点/缺口（wire 恒 no-seam）', () => {
  assert.equal(OBSERVATION_CAPABILITY_VERSION, 1)
  assert.deepEqual([...CAPABILITY_LAYERS], ['plugin-surface', 'logical-request', 'wire', 'provider-usage'])
  assert.deepEqual([...CAPABILITY_STATES], ['available', 'not-wired', 'no-seam'])
  assert.deepEqual([...LAYER_OBSERVATION_STATES], ['observed', 'partial', 'unobservable', 'not-wired', 'no-seam'])
  assert.equal(OBSERVATION_CAPABILITY_TABLE.length, CAPABILITY_LAYERS.length)
  assert.deepEqual(OBSERVATION_CAPABILITY_TABLE.map((entry) => entry.layer), [...CAPABILITY_LAYERS])
  assert.equal(Object.isFrozen(OBSERVATION_CAPABILITY_TABLE), true)
  assert.equal(Object.isFrozen(OBSERVATION_CAPABILITY_TABLE[0]), true, '条目也必须冻结（能力声明不可被运行期改写）')

  for (const entry of OBSERVATION_CAPABILITY_TABLE) {
    assert.ok(CAPABILITY_STATES.includes(entry.state), entry.layer + ' 状态必须在封闭集内')
    assert.ok(Array.isArray(entry.gaps) && entry.gaps.length > 0, entry.layer + ' 必须写明缺口（空缺口等于宣称无缺口）')
    assert.equal(typeof entry.nativeId, 'boolean', entry.layer + ' 必须声明有没有宿主原生 ID')
    assert.ok(Array.isArray(entry.fields))
  }
  // wire：没有来源、没有时点、没有字段——**能力不存在**是结论，不是"待办"
  const wire = capabilityOf('wire')
  assert.equal(wire.state, 'no-seam')
  assert.equal(wire.source, null)
  assert.equal(wire.pointInTime, null)
  assert.deepEqual([...wire.fields], [])
  assert.ok(wire.gaps.some((gap) => /冒充/.test(gap)), 'wire 缺口必须写明"不得用 logical-request 哈希冒充"')
  // logical-request：seam 存在（llm/stream）但未接线；不得宣称已观测
  const logical = capabilityOf('logical-request')
  assert.equal(logical.state, 'not-wired')
  assert.match(logical.source, /llm\/stream/)
  assert.deepEqual([...logical.fields], [], '未接线的层不得声称有可见字段')
  // 已落地的两层
  assert.equal(capabilityOf('plugin-surface').state, 'available')
  assert.equal(capabilityOf('provider-usage').state, 'available')
  assert.equal(capabilityOf('bogus-layer'), null, '未知层返回 null，不猜')
})

// ---------------------------------------------------------------- C2 范围判定

test('C2 范围判定：outbound/wire 一律拒绝并给具体原因码；不得用伪 plugin-surface 标签绕过', () => {
  assert.deepEqual({ ...observationScopeDecisionOf(null) }, {
    scope: 'plugin-surface', state: 'available', layer: 'plugin-surface', reason: null,
  })
  assert.deepEqual({ ...observationScopeDecisionOf({ pluginSurface: { messages: 1 } }) }, {
    scope: 'plugin-surface', state: 'available', layer: 'plugin-surface', reason: null,
  })
  const outbound = observationScopeDecisionOf({ outboundRequest: {} })
  assert.equal(outbound.scope, 'unsupported')
  assert.equal(outbound.reason, 'outbound-request-not-wired')
  assert.equal(outbound.layer, 'logical-request')
  const logical = observationScopeDecisionOf({ logicalRequest: { messages: 3 } })
  assert.equal(logical.reason, 'outbound-request-not-wired')
  const wire = observationScopeDecisionOf({ wire: {} })
  assert.equal(wire.scope, 'unsupported')
  assert.equal(wire.reason, 'wire-no-seam')
  assert.equal(wire.layer, 'wire')
  assert.equal(observationScopeDecisionOf({ wireBytes: {} }).reason, 'wire-no-seam')
  // wire 优先于 logical-request（更靠后、更不可得的层先拒绝）
  assert.equal(observationScopeDecisionOf({ outboundRequest: {}, wire: {} }).reason, 'wire-no-seam')

  // **伪标签绕过**：同时给 pluginSurface 与 outboundRequest，仍必须拒绝，且不产记录
  const forged = buildCacheObservation({
    scope: { pluginSurface: { messages: 3 }, outboundRequest: { messages: 3 } },
    usage: { inputTokens: 1, outputTokens: 1 },
    at: 1,
  })
  assert.equal(forged.ok, false)
  assert.equal(forged.reason, 'unsupported-observation-scope')
  assert.equal(forged.code, 'outbound-request-not-wired', '拒绝必须给具体原因，不是笼统 unsupported')
  assert.equal('record' in forged, false, '拒绝时不得产出记录')
  assert.equal(buildCacheObservation({ scope: { wire: {} }, usage: { inputTokens: 1, outputTokens: 1 } }).code, 'wire-no-seam')
})

// ---------------------------------------------------------------- C3 layers 段

test('C3 layers 段：pre-step 消息面 = partial；system/tools 不可见不冒充 observed；wire/logical 恒为能力缺口', () => {
  const built = buildOf()
  const layers = built.record.layers
  assert.equal(layers.contractVersion, OBSERVATION_CAPABILITY_VERSION)
  assert.equal(layers.pluginSurface, 'partial', '只有消息面被看到 ⇒ partial（不是 observed）')
  assert.equal(layers.providerUsage, 'observed')
  assert.equal(layers.logicalRequest, 'not-wired')
  assert.equal(layers.wire, 'no-seam')

  // 全量覆盖（测试里模拟一个有 system/tools 的 seam）→ observed
  const full = surfaceFingerprintOf({ messages: [msg('user', '问')], system: '提示', tools: [{ name: 'read' }] }, { coverage: FULL })
  assert.deepEqual({ ...layersSectionOf({ hasSurface: true, coverage: full.coverage, hasUsage: true }) }, {
    contractVersion: 1, pluginSurface: 'observed', logicalRequest: 'not-wired', wire: 'no-seam', providerUsage: 'observed',
  })
  // 没有投影面的行：pluginSurface = unobservable（不是"没变化"）
  assert.equal(layersSectionOf({ hasSurface: false, coverage: null, hasUsage: true }).pluginSurface, 'unobservable')

  // sanitize：wire 只许 no-seam、logicalRequest 只许 not-wired、版本与未知键必须拒绝
  const good = { contractVersion: 1, pluginSurface: 'partial', logicalRequest: 'not-wired', wire: 'no-seam', providerUsage: 'observed' }
  assert.equal(sanitizeLayersSection(good).ok, true)
  assert.equal(sanitizeLayersSection({ ...good, wire: 'observed' }).ok, false, 'wire 标成 observed 等于宣称有 wire 观测')
  assert.equal(sanitizeLayersSection({ ...good, logicalRequest: 'available' }).ok, false)
  assert.equal(sanitizeLayersSection({ ...good, contractVersion: 2 }).ok, false)
  assert.equal(sanitizeLayersSection({ ...good, extra: 1 }).ok, false)
  assert.equal(sanitizeLayersSection(null).ok, false)
  assert.equal(sanitizeCacheObservation({ ...built.record, layers: null }).ok, false, 'v4 行缺 layers 必须拒绝')
})

// ---------------------------------------------------------------- C4 组件

test('C4 逐组件：哈希/数量/代际/覆盖度；不可观测时三值为 null（不是 0）', () => {
  const built = buildOf()
  const surface = built.record.surface
  const components = surface.components
  assert.deepEqual({ ...components.system }, { digest: null, count: null, generation: null, coverage: 'unobservable' })
  assert.deepEqual({ ...components.tools }, { digest: null, count: null, generation: null, coverage: 'unobservable' })
  assert.equal(components.messages.coverage, 'observed')
  assert.match(components.messages.digest, /^[0-9a-f]{16}$/)
  assert.equal(components.messages.count, 1, '数量 = 实际看到的条数')
  assert.equal(components.messages.generation, surface.epoch, '代际 = 本行投影代际')
  assert.equal(components.messages.digest, surfaceFingerprintOf({ messages: [msg('user', '问')] }, { coverage: PRE_STEP }).digest.messages)

  // 全量覆盖：tools 数量来自数组长度，system 恒 1 块
  const full = buildOf({
    surface: { messages: [msg('user', 'a'), msg('assistant', 'b')], system: '系统提示', tools: [{ name: 'read' }, { name: 'write' }] },
    surfaceCoverage: FULL,
  })
  const fullComponents = full.record.surface.components
  assert.equal(fullComponents.system.count, 1)
  assert.equal(fullComponents.tools.count, 2)
  assert.equal(fullComponents.messages.count, 2)
  for (const kind of ['system', 'tools', 'messages']) {
    assert.equal(fullComponents[kind].coverage, 'observed')
    assert.match(fullComponents[kind].digest, /^[0-9a-f]{16}$/)
  }

  // 篡改：覆盖度与 surface.coverage 不一致 / unobservable 带值 / 摘要形状非法 → 全部拒绝
  const tamper = (mutate) => {
    const copy = structuredClone(built.record)
    mutate(copy)
    return sanitizeCacheObservation(copy)
  }
  assert.equal(tamper((r) => { r.surface.components.system = { digest: 'a'.repeat(16), count: 1, generation: 0, coverage: 'observed' } }).ok, false,
    '组件覆盖度必须与 surface.coverage 一致')
  assert.equal(tamper((r) => { r.surface.components.messages.count = null }).ok, false, 'observed 组件不许缺数量')
  assert.equal(tamper((r) => { r.surface.components.messages = { digest: '正文', count: 1, generation: 0, coverage: 'observed' } }).ok, false)
  assert.equal(tamper((r) => { r.surface.components.bogus = { digest: null, count: null, generation: null, coverage: 'unobservable' } }).ok, false)
  assert.equal(tamper((r) => { delete r.surface.components }).ok, true, '缺 components 的 surface 允许（旧行读视图就是 null）')
})

// ---------------------------------------------------------------- C5 usage 归一

test('C5 usage 逐 provider 归一：input 与 cache 分报、可加性按 provider、reasoning 归属未知即 null', () => {
  assert.equal(USAGE_NORMALIZATION_VERSION, 1)
  assert.equal(PROVIDER_USAGE_PROFILES.deepseek.inputIncludesCacheRead, false)
  assert.equal(PROVIDER_USAGE_PROFILES.deepseek.inputIncludesCacheWrite, false)
  assert.equal(PROVIDER_USAGE_PROFILES.deepseek.cacheFieldsAddable, true)
  assert.equal(PROVIDER_USAGE_PROFILES.deepseek.reasoningIncludedInOutput, null, 'DeepSeek 路线 reasoning 不产出 ⇒ 归属未知（不是 false）')
  assert.equal(PROVIDER_USAGE_PROFILES['pi-ai'].reasoningIncludedInOutput, true, 'pi-ai 的 reasoning 已折进 output')
  assert.equal(PROVIDER_USAGE_PROFILES['pi-ai'].cacheFieldsAddable, null, 'pi-ai 的 total 由上游给 ⇒ 可加性未核验')

  const full = normalizeUsageObservation({ inputTokens: 100, cacheReadTokens: 300, cacheWriteTokens: 5, outputTokens: 10, totalTokens: 415 }).usage
  const deepseek = additivityOf(full, 'deepseek')
  assert.equal(deepseek.cacheFieldsAddable, true)
  assert.equal(deepseek.billedAxisSum, 415, '四项都 present 才给合计（= in+read+write+out）')
  assert.equal(deepseek.reasoningExtraTokens, null, 'reasoning 归属未知 ⇒ extra 必须是 null，不是 0')

  // 缺一项：可加性仍 true，但**合计为 null**（缺失不是 0）
  const partial = normalizeUsageObservation({ inputTokens: 100, cacheReadTokens: 300, outputTokens: 10 }).usage
  const partialAdd = additivityOf(partial, 'deepseek')
  assert.equal(partialAdd.cacheFieldsAddable, true)
  assert.equal(partialAdd.billedAxisSum, null, '缺 cacheWriteTokens ⇒ 不给合计')

  // 未登记 provider：三个判定全部 null、合计 null（默认 false/0 就是把"不知道"当事实）
  const unknown = additivityOf(full, 'some-vendor')
  assert.equal(unknown.known, false)
  assert.equal(unknown.cacheFieldsAddable, null)
  assert.equal(unknown.billedAxisSum, null)
  assert.equal(unknown.reasoningExtraTokens, null)
  assert.equal(unknown.provider, null)
  assert.deepEqual({ ...usageProfileOf(null) }, { ...usageProfileOf('never-registered') })

  // pi-ai：reasoning 已含在 output 里 ⇒ extra = 0（明确的 0，不是 null）
  const piAi = additivityOf(normalizeUsageObservation({ inputTokens: 10, outputTokens: 20, reasoningTokens: 7 }).usage, 'pi-ai')
  assert.equal(piAi.reasoningIncludedInOutput, true)
  assert.equal(piAi.reasoningExtraTokens, 0)

  // 记录里：arithmetic.additivity 按同行 request.provider 取；没有 provider 就 null
  assert.equal(buildOf().record.arithmetic.additivity.cacheFieldsAddable, true)
  assert.equal(buildOf({ request: { turn: 1, step: 1, provider: 'acme' } }).record.arithmetic.additivity.cacheFieldsAddable, null)
  const noProvider = buildCacheObservation({
    usage: { inputTokens: 1, outputTokens: 1 }, at: 1, surface: { messages: [] }, surfaceCoverage: PRE_STEP,
  })
  assert.equal(noProvider.record.arithmetic.additivity.cacheFieldsAddable, null, '没有 provider 不猜可加性')
  assert.equal(noProvider.record.arithmetic.additivity.billedAxisSum, null)

  // 不产金额/价格：整条记录任何层级都不许出现这些词
  const text = JSON.stringify(built()).toLowerCase()
  for (const forbidden of ['price', 'cost', 'usd', 'billing', '金额', '价格']) {
    assert.equal(text.includes(forbidden), false, '观测记录不得含价格/金额：' + forbidden)
  }

  function built() { return buildOf().record }
})

// ---------------------------------------------------------------- C6 policy 端口

test('C6 只读 policy 端口：形状封闭、拒绝逐行数据与正文、不含任何策略参数', () => {
  assert.equal(POLICY_INPUT_PORT_VERSION, 1)
  assert.equal(POLICY_INPUT_PORT.version, 1)
  assert.equal(POLICY_INPUT_PORT.name, 'observation-policy-input')
  assert.equal(POLICY_INPUT_PORT.direction, 'read-only')
  assert.equal(POLICY_INPUT_PORT.source, 'observation-summary')
  // 端口对象**只**有这些键（多一个"阈值/推荐"就等于在合同里藏策略）
  assert.deepEqual(Object.keys(POLICY_INPUT_PORT).sort(), ['direction', 'fields', 'forbidden', 'name', 'source', 'validate', 'version'])
  assert.deepEqual([...POLICY_INPUT_FIELDS], ['contractVersion', 'session', 'window', 'projection', 'components', 'usage', 'layers'])
  assert.equal(typeof POLICY_INPUT_PORT.validate, 'function', '端口自带校验器（避免第二份形状口径）')

  const valid = {
    contractVersion: 1,
    session: { id: 'sess-local-' + 'a'.repeat(16), source: 'local-diagnostic' },
    window: { fromSeq: 1, toSeq: 2, rows: 2, legacyRows: 0, skippedRows: 0 },
    projection: {
      epoch: 1, lastPhase: 'append', lastMessageChange: 'appended',
      phaseCounts: { initial: 1, steady: 0, append: 1, 'epoch-start': 0 },
    },
    components: {
      messages: { digest: 'b'.repeat(16), count: 3, generation: 1 },
      system: { coverage: 'unobservable' },
      tools: { coverage: 'unobservable' },
    },
    usage: {
      counted: 2, duplicates: 0, late: 0, unknownArrival: 0, unsampledLegacy: 0,
      totals: { inputTokens: 10, outputTokens: 2, totalTokens: null, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null },
      availability: { inputTokens: 'present', outputTokens: 'present', totalTokens: 'missing', cacheReadTokens: 'missing', cacheWriteTokens: 'missing', reasoningTokens: 'missing' },
      cacheReadRatio: null,
      additivity: { provider: 'deepseek', cacheFieldsAddable: true, reasoningExtraTokens: null, verified: 'source-read' },
    },
    layers: { contractVersion: 1, pluginSurface: 'partial', logicalRequest: 'not-wired', wire: 'no-seam', providerUsage: 'observed' },
  }
  assert.equal(sanitizePolicyInput(valid).ok, true)

  const tamper = (mutate) => {
    const copy = structuredClone(valid)
    mutate(copy)
    return sanitizePolicyInput(copy)
  }
  // 禁令分支必须**真实可达**：命中要给具体原因（不是被"未知字段"顶掉）
  // 注：`window.rows` 是**已声明**的合法字段（本窗口聚合了多少行），不得被名字一刀切误杀
  // ——valid fixture 里就有它，能通过即证明不误杀。禁令只对**未声明**的内容类键名生效。
  const topLevelForbidden = tamper((c) => { c.records = [] })
  assert.equal(topLevelForbidden.ok, false, '端口不得携带逐行记录')
  assert.match(topLevelForbidden.reason, /不得含逐行诊断\/正文\/凭据\/价格字段/, '必须命中 forbidden 分支并给具体文案')
  assert.match(topLevelForbidden.reason, /records/, '必须点名命中路径')
  for (const key of ['content', 'credentials', 'prices', 'cost', 'ttft']) {
    const hit = tamper((c) => { c[key] = 'x' })
    assert.equal(hit.ok, false, '内容/凭据/价格类键名必须拒绝：' + key)
    assert.match(hit.reason, /不得含逐行诊断/, '必须走禁令分支：' + key)
  }
  const nestedForbidden = tamper((c) => { c.usage.records = [] })
  assert.equal(nestedForbidden.ok, false, '嵌套位置的逐行数据同样禁止')
  assert.match(nestedForbidden.reason, /不得含逐行诊断/, '嵌套命中必须走同一条禁令（不是未知字段）')
  assert.match(nestedForbidden.reason, /usage\.records/, '必须点名嵌套路径')
  const nestedContent = tamper((c) => { c.components.messages.text = '正文' })
  assert.equal(nestedContent.ok, false)
  assert.match(nestedContent.reason, /components\.messages\.text/, '正文类键名同样被点名')
  assert.equal(tamper((c) => { c.usage.content = '正文' }).ok, false)
  assert.equal(tamper((c) => { c.contractVersion = 2 }).ok, false)
  assert.equal(tamper((c) => { c.usage.totals.inputTokens = '10' }).ok, false)
  assert.equal(tamper((c) => { c.usage.availability.inputTokens = 'unknown' }).ok, false)
  assert.equal(tamper((c) => { c.usage.additivity.cacheFieldsAddable = 'yes' }).ok, false)
  assert.equal(tamper((c) => { c.layers.wire = 'observed' }).ok, false)
  assert.equal(tamper((c) => { c.session.id = 'raw-session-id' }).ok, false, '会话只允许本地诊断 ID')
  assert.equal(sanitizePolicyInput(null).ok, false)
  assert.equal(sanitizePolicyInput([]).ok, false)
})

// ---------------------------------------------------------------- C7 边界守卫

/** 静态 import 提取（与 v3-architecture-guard 同口径的正则，不解析动态 import）。 */
function importSpecifiersOf(source) {
  const out = []
  for (const pattern of [
    /(?:^|\n)\s*import\s+(?:[\w$\{\},\s*]+\s+from\s+)?['"]([^'"]+)['"]/g,
    /(?:^|\n)\s*export\s+(?:\*)?(?:[\w$\{\},\s*]+)?\s+from\s+['"]([^'"]+)['"]/g,
  ]) for (const match of source.matchAll(pattern)) out.push(match[1])
  return out
}

async function mjsFilesOf(root) {
  const out = []
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.name.endsWith('.mjs')) out.push(full)
    }
  }
  await walk(root)
  return out
}

const OBSERVATION_MODULES = new Set([
  'contracts/cache-observation.mjs',
  'contracts/observation-capability.mjs',
  'contracts/observation-lifecycle.mjs',
  'contracts/usage-normalization.mjs',
  'contracts/observation-policy-port.mjs',
  'adapters/storage/usage-log.mjs',
])

/**
 * 扫一个 v3 树：返回违规清单 + 观测导入边（供真树断言与**副本变异**共用同一份判据）。
 * 判据：观测模块只允许被 contracts / adapters / entry 三层导入；application / domain 一律违规。
 */
async function scanObservationImports(root) {
  const files = await mjsFilesOf(root)
  const importers = new Map()
  const violations = []
  let observationEdges = 0
  for (const file of files) {
    const rel = path.relative(root, file).replaceAll('\\', '/')
    const layer = rel.split('/')[0]
    const source = await readFile(file, 'utf8')
    for (const spec of importSpecifiersOf(source)) {
      if (!spec.startsWith('.')) continue
      const target = path.relative(root, path.resolve(path.dirname(file), spec)).replaceAll('\\', '/')
      if (!OBSERVATION_MODULES.has(target)) continue
      observationEdges += 1
      if (!importers.has(rel)) importers.set(rel, new Set())
      importers.get(rel).add(target)
      if (!['contracts', 'adapters', 'entry'].includes(layer)) {
        violations.push({ file: rel, target, layer, reason: '观测模块出现在不该出现的层' })
      }
    }
  }
  return { files: files.length, observationEdges, importers, violations }
}

test('C7 边界：观测模块的导入者必须显式受限（含副本变异自证）', async () => {
  const v3Root = path.join(SRC, 'v3')
  const real = await scanObservationImports(v3Root)
  assert.ok(real.files >= 40, '扫描面过小（' + real.files + '），守卫会恒绿')
  assert.ok(real.observationEdges >= 4, '量具自检：至少要扫到「契约→契约」「适配器→契约」这几条真实导入边（实际 ' + real.observationEdges + '）')
  assert.deepEqual(real.violations, [], '真实树不得有观测模块越界导入')
  assert.ok([...real.importers.keys()].includes('contracts/cache-observation.mjs'), '量具必须看到契约→契约的边')
  assert.ok([...real.importers.keys()].includes('adapters/storage/usage-log.mjs'), '量具必须看到适配器→契约的边')
  // 决策层（application / domain）一条边都不许有——这是「观测不参与归档决策」的导入级判据
  for (const [rel] of real.importers) {
    const layer = rel.split('/')[0]
    assert.notEqual(layer, 'application', 'application 层不得导入观测模块：' + rel)
    assert.notEqual(layer, 'domain', 'domain 层不得导入观测模块：' + rel)
  }

  // ---- 定点变异（真副本，不落盘到真树）：把一条真实观测导入注入 domain 层，判据必须点名
  const realSteps = path.join(v3Root, 'domain', 'archive', 'steps.mjs')
  const before = await readFile(realSteps)
  const tmp = await mkdtemp(path.join(tmpdir(), 'mcl-g3-c7-'))
  const copyRoot = path.join(tmp, 'v3')
  try {
    await cp(v3Root, copyRoot, { recursive: true })
    // 防误杀对照：未改动的副本必须与真树同结论（0 违规）
    const clean = await scanObservationImports(copyRoot)
    assert.deepEqual(clean.violations, [], '未改动的副本不得误报')
    assert.equal(clean.observationEdges, real.observationEdges)
    // 注入：domain 层导入观测合同
    const copySteps = path.join(copyRoot, 'domain', 'archive', 'steps.mjs')
    await writeFile(copySteps, (await readFile(copySteps, 'utf8'))
      + "\nimport { nextProjectionEpoch } from '../../contracts/cache-observation.mjs'\n", 'utf8')
    const mutated = await scanObservationImports(copyRoot)
    assert.ok(
      mutated.violations.some((violation) => violation.file === 'domain/archive/steps.mjs'
        && violation.target === 'contracts/cache-observation.mjs'),
      '副本里 domain→观测合同必须被点名（实际：' + JSON.stringify(mutated.violations) + '）',
    )
    // 复原：删副本后真树字节不变、结论复绿
    await rm(tmp, { recursive: true, force: true })
    assert.deepEqual(await readFile(realSteps), before, '变异只发生在副本，真树字节不得改动')
    assert.deepEqual((await scanObservationImports(v3Root)).violations, [], '复原后必须复绿')
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
})

test('C7b 时间戳只在观测侧：只改 at，投影指纹/相位/代际/组件逐字节不变', () => {
  const surface = { messages: [msg('user', '同一句'), msg('assistant', '同一答')] }
  const early = buildOf({ at: 1, surface })
  const late = buildOf({ at: 999999999999, surface })
  assert.equal(early.record.at, 1)
  assert.equal(late.record.at, 999999999999)
  assert.deepEqual(early.record.surface, late.record.surface, '时间戳不得参与投影指纹/代际')
  assert.deepEqual(early.projection, late.projection)
  // 反向自证：内容真变了，指纹必须变（防"恒等"假绿）
  const changed = buildOf({ at: 1, surface: { messages: [msg('user', '换了一句')] } })
  assert.notEqual(changed.record.surface.fingerprint, early.record.surface.fingerprint)
})

test('C7c 旧行可读且新段为 null：v3 行不得被当前版本默认值"补齐"', () => {
  const built = buildOf().record
  const legacy = structuredClone(built)
  legacy.contractVersion = 3
  delete legacy.layers
  delete legacy.lifecycle
  delete legacy.surface.components
  const view = readObservationRowOf(legacy)
  assert.equal(view.ok, true, JSON.stringify(view))
  assert.equal(view.legacy, true)
  assert.equal(view.contractVersion, 3)
  assert.equal(view.record.layers, null, '旧行没有 layers ⇒ null（未知），不是"按当前默认补一个"')
  assert.equal(view.record.lifecycle, null)
  assert.equal(view.record.surface.components, null)
  assert.deepEqual({ ...view.record.usage }, { ...built.usage }, '旧行的 usage 原样可读')

  // v3 行里塞 v4 字段 ⇒ 不是真 v3 行，拒绝（不"降级读取"）
  const forged = { ...structuredClone(built), contractVersion: 3 }
  assert.equal(readObservationRowOf(forged).ok, false)
  // 嵌套 v4 字段同样拒绝：v3 行的 surface **不得**携带 components。
  // 静默归 null 会把"坏行"读成"只是没有这个观测"，两者是不同的失败语义（审查 P3-2）。
  const nestedForge = structuredClone(legacy)
  // 用**形状完全合法**的 v4 components：若没有 v3 专用拒绝规则，它会静默通过并落成 null，
  // 断言就退化成"形状校验顺手挡住坏值"，而不是"v3 行不许带 v4 段"（审查 P3-2 指出的正是这点）。
  nestedForge.surface.components = structuredClone(built.surface.components)
  const nestedView = readObservationRowOf(nestedForge)
  assert.equal(nestedView.ok, false, 'v3 行嵌套 components（即使形状合法）必须拒绝而不是静默归 null')
  assert.match(nestedView.reason, /components/)
  assert.match(nestedView.reason, /v3/, '拒绝理由必须说明这是 v3 行的形状约束')
  // 未知版本：拒绝，不迁移
  assert.equal(readObservationRowOf({ ...built, contractVersion: 2 }).ok, false)
  assert.equal(readObservationRowOf({ ...built, contractVersion: 5 }).ok, false)
  // v4 行走同一个校验器（写侧不留旁路）
  assert.equal(readObservationRowOf(built).ok, true)
  assert.equal(readObservationRowOf(built).legacy, false)
})
