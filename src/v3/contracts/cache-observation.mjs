/**
 * P2 缓存观测合同（0.15.0；G3 分层观测扩展，合同版本 4）——纯函数、零外部依赖。
 *
 * ## 版本沿革
 * - v2（P2 基础 / P2-a 接线）：usage 三态归一、算术一致性、可核验比率、范围判定、
 *   投影面指纹与代际、记录构造与严格校验。surface 字段就位但生产未采样（恒 null）。
 * - v3（P2-b）：**投影观测落地**——逐请求的 pre-step 局部指纹、代际链与相位、
 *   覆盖度、跨进程种子（消息链），以及**请求/步骤配对**（turn/step/provider/model）。
 *   旧行仍按 v2 落盘、不迁移不读取；新写入一律 v3。
 * - v4（G3，本版）：**分层观测 + 生命周期关联 + usage 逐 provider 归一**。
 *   新增三段：`layers`（本行覆盖了四层里的哪几层，缺口由能力表声明）、
 *   `lifecycle`（session/logicalRequest/attempt 的**本地诊断**关联与 usage 到达性质）、
 *   `surface.components`（逐组件哈希/数量/代际/覆盖度）。`arithmetic` 增 `additivity`
 *   （逐 provider 的"能否相加"声明）。**v3 行仍可读**（`readObservationRowOf`），
 *   但新段一律为 null——「旧行没记」不得被读成"观测到了"；
 *   代际种子同时接受 v3/v4（surface 段形状未变），避免升级当口 epoch 回退。
 *
 * ## v4 的三条新增边界（与 v3 的边界并存，不是替代）
 * 1. **分层不冒充**：`layers.wire` 只能是 `no-seam`、`layers.logicalRequest` 只能是
 *    `not-wired`（能力表 `contracts/observation-capability.mjs` 是唯一声明处）。
 *    `observationScopeOf` 仍拒绝 outbound-request/wire 输入，并给出**具体原因码**。
 * 2. **关联不伪造**：`lifecycle` 里所有 ID 都标 `source:'local-diagnostic'`
 *    （宿主没有原生 requestId）；配对不上记 `unpaired` + 具体原因，不拿时间相近强配。
 * 3. **usage 不双计**：`lifecycle.usageArrival` 规定每个 attempt 至多一份计数样本
 *    （`counted`）；重复流式 chunk 记 `duplicate`、迟到的仍归自己的 attempt。
 *
 * ## 这一版坚守的三条边界
 * 1. **未知就是 null/unknown**：没有前一次观测 → `messageChange/phase` 为 null；
 *    system/tools 在 pre-step 不可见 → `coverage` 标 `unobservable`（不是「没变化」）；
 *    只有消息面参与比较时，system/tools 的结论**绝不**伪造。
 * 2. **不宣称供应商语义**：epoch 只表示「插件可见的投影前缀变了」，不是「供应商缓存失效」；
 *    不产出任何命中/未命中、互斥计费桶、金额或 TTFT。
 * 3. **正文永不回显**：记录只留定长指纹、消息链（长度 + 指纹值）、枚举与整数；
 *    正文只进指纹，指纹函数用键排序规范化 JSON（同一语义内容 ⇒ 同指纹）。
 *
 * ## 指纹与增量成本
 * contracts 层不得 import `node:*`，指纹用本模块内 FNV-1a 64 位（16 位小写十六进制），
 * 只做**变更检测**，不是密码学摘要。消息级摘要由 `messageDigestOf` 计算；调用方（entry）
 * 可用 WeakMap 缓存同一 message 对象的摘要，再经 `messageDigests` 传入——这样每次请求
 * 只需为**新增消息**做规范化序列化，指纹与消息链在摘要数组上计算（O(n) 但只处理 16 字符摘要）。
 *
 * ## 不适用条件
 * - 不估算金额/价格/TTL；不判定供应商计费语义；
 * - 不读宿主对象、不读盘、不记录任何正文；
 * - pre-step 的 system prompt 与工具 schema 组装在宿主 `step()` 内部，本层拿不到 ⇒ 覆盖度
 *   标 unobservable（P0 宿主合同 §2.1/§2.5：pre-step 拿到的是 claimed messages，不是最终请求）。
 */
import { deepFreeze } from '../shared/deep-freeze.mjs'
import { fnv1a64Of as fnv1a64 } from '../shared/fnv1a64.mjs'
import {
  layersSectionOf,
  observationScopeDecisionOf,
  sanitizeLayersSection,
} from './observation-capability.mjs'
import { lifecycleSectionOf, sanitizeLifecycleSection } from './observation-lifecycle.mjs'
import { additivityOf } from './usage-normalization.mjs'

/**
 * 观测合同版本（v4 = G3：layers/lifecycle/surface.components/arithmetic.additivity）。
 * **写侧只接受本版本**；读侧另走 `readObservationRowOf`（v3 可读、新段为 null）。
 */
export const CACHE_TOKENS_CONTRACT_VERSION = 4

/**
 * 可作**跨进程代际种子**的合同版本（surface 段形状在 v3→v4 未变：指纹/消息链/epoch 同义）。
 * 只多接受 v3：升级当口若不接旧种子，每个存量会话都会把 epoch 重置成 0（无条件回退，
 * 比 P2-b 已登记的"种子在窗口外"更糟）。未来版本若改 surface 段形状，必须**从这里删掉**旧版本。
 */
export const CACHE_PROJECTION_SEED_VERSIONS = Object.freeze([3, 4])

/** 允许出现的观测范围（**封闭集且最小**：只有插件活动面；wire 无 seam）。 */
export const OBSERVATION_SCOPES = Object.freeze(['plugin-surface'])

/** 宿主 `TokenUsage` 的字段封闭集（P0 §2.4 逐字对齐；与账本读写白名单同源）。 */
export const USAGE_CACHE_FIELDS = Object.freeze([
  'inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens',
])

/** 投影面变更种类：追加与改写必须分开（内容增长不是缓存失效）。 */
export const SURFACE_CHANGE_KINDS = Object.freeze([
  'unchanged', 'appended', 'message-prefix-rewritten', 'system-changed', 'tools-changed',
])

/** 变更原因（`message-appended` 也在此列：它**不**使缓存失效）。 */
export const SURFACE_CHANGE_REASONS = Object.freeze([
  'system-changed', 'tools-changed', 'message-appended', 'message-prefix-rewritten',
])

/** 投影相位（**只描述与上一次观测的关系**，不是开发流程 §3.5 的展示分组）。 */
export const PROJECTION_PHASES = Object.freeze(['initial', 'steady', 'append', 'epoch-start'])

/** 快照采样点（P2-b 只有 pre-step 局部面；outbound 请求面没有接）。 */
export const SURFACE_SNAPSHOT_POINTS = Object.freeze(['pre-step'])

/** 覆盖度取值：`unobservable` = 该部分不在本快照里（**不是**「没变化」）。 */
export const COVERAGE_STATES = Object.freeze(['observed', 'unobservable'])

/** 「step 开始 → 首个 token」的测量来源标识（不是供应商 TTFT）。 */
export const STEP_TO_FIRST_TOKEN_SOURCE = 'step-to-first-token'

/** 该测量的口径说明（写进记录，避免后人误读）。 */
const STEP_TO_FIRST_TOKEN_NOTE = 'step/start 之后的请求准备与构建耗时（不含此前 pre-step）；不是供应商 TTFT'

/** 算术等式的四个组件（顺序固定，用于 missing 列表）。 */
const ARITHMETIC_COMPONENTS = Object.freeze(['inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens'])

/** 指纹格式（16 位小写十六进制）。 */
const FINGERPRINT_RE = /^[0-9a-f]{16}$/

/** 归档意图 ID 的允许形状（只允许 ID 字符，杜绝正文夹带）。 */
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/

/** provider/model 标识的允许形状（标识符字符集，杜绝正文夹带）。 */
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@+/-]{0,127}$/

/** 顶层字段封闭集（sanitize 的 allowlist；未知键一律拒绝）。 */
const RECORD_FIELDS = Object.freeze([
  'contractVersion', 'observationScope', 'at', 'request', 'usage', 'measurement', 'arithmetic',
  'cacheReadRatio', 'surface', 'archive', 'layers', 'lifecycle',
])

/** v3 行的顶层字段集（读侧兼容用；**不含** layers/lifecycle）。 */
const LEGACY_V3_RECORD_FIELDS = Object.freeze([
  'contractVersion', 'observationScope', 'at', 'request', 'usage', 'measurement', 'arithmetic',
  'cacheReadRatio', 'surface', 'archive',
])

/** 记录里 surface 段的字段封闭集（v4 增 components）。 */
const SURFACE_FIELDS = Object.freeze([
  'fingerprint', 'messageChain', 'epoch', 'phase', 'reason', 'firstDivergence', 'messageChange', 'coverage', 'snapshot',
  'components',
])

/** surface.components 的组件封闭集（**顺序固定**：system → tools → messages）。 */
const SURFACE_COMPONENT_KINDS = Object.freeze(['system', 'tools', 'messages'])

/** 单个组件的字段封闭集。 */
const COMPONENT_FIELDS = Object.freeze(['digest', 'count', 'generation', 'coverage'])

/** 记录里 request 段的字段封闭集。 */
const REQUEST_FIELDS = Object.freeze(['turn', 'step', 'provider', 'model'])

const MASK_64 = 0xffffffffffffffffn
const FNV_PRIME = 0x100000001b3n
const FNV_OFFSET = 0xcbf29ce484222325n

/** 规范化 JSON（键排序、递归稳定）——指纹的唯一序列化口径（键序无关）。 */
function canonicalJson(value) {
  if (value === undefined || value === null) return 'null'
  if (Array.isArray(value)) return '[' + value.map((item) => canonicalJson(item)).join(',') + ']'
  if (typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}'
  }
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null'
  return JSON.stringify(value)
}

/**
 * 单条消息的摘要（16 位十六进制）。**纯函数**：同一内容 ⇒ 同一摘要。
 * 消息无法规范化序列化（循环引用/BigInt）时返回 null——调用方据此把消息面标为
 * `unobservable`，绝不拿占位摘要冒充不同消息。
 */
export function messageDigestOf(message) {
  try {
    return fnv1a64(canonicalJson(message ?? null))
  } catch {
    return null
  }
}

/** 指纹形状的唯一判据（合同写侧与账本种子读侧共用，不得在适配器重抄正则）。 */
export function isFingerprint(value) {
  return typeof value === 'string' && FINGERPRINT_RE.test(value)
}

/**
 * 消息链形状的唯一判据（`{length, value}`）：sanitize 与账本种子读取共用同一份校验，
 * 适配器只做「可用/不可用」的取舍，不再自带长度/指纹规则。
 *
 * @returns {{ok:true, chain:{length:number, value:string}|null} | {ok:false, reason:string}}
 */
export function messageChainShapeOf(chain) {
  if (chain === null || chain === undefined) return { ok: true, chain: null }
  if (typeof chain !== 'object' || Array.isArray(chain)) {
    return { ok: false, reason: 'surface.messageChain 必须是对象或 null' }
  }
  for (const key of Object.keys(chain)) {
    if (!['length', 'value'].includes(key)) return { ok: false, reason: 'surface.messageChain 未知字段：' + key }
  }
  if (!Number.isSafeInteger(chain.length) || chain.length < 0) {
    return { ok: false, reason: 'surface.messageChain.length 非法' }
  }
  if (!isFingerprint(chain.value)) {
    return { ok: false, reason: 'surface.messageChain.value 必须是 16 位小写十六进制' }
  }
  return { ok: true, chain: { length: chain.length, value: chain.value } }
}

/**
 * 账本行 → 投影种子（**跨进程代际链的唯一读取判据**）。
 *
 * 只接受**当前合同版本**且 surface 形状合格的行：
 * - `contractVersion` 必须等于 `CACHE_TOKENS_CONTRACT_VERSION`：v2 旧行即使 surface
 *   看起来合法也不得冒充种子（旧口径曾是「形状对就收」，于是旧行把代际链接错）；
 * - `fingerprint` 必须 16 位小写十六进制；
 * - `epoch` 必须是**合法非负整数**：缺失/非法整行作废，**不伪造 0**——0 是 initial
 *   观测的合法值，拿它顶替缺失会让重启后的代际链悄悄回退且无从分辨。
 *
 * @param {object} observation 账本行（含 seq/contractVersion/surface）
 * @returns {{epoch:number, fingerprint:string, digest:object|null}|null}
 */
export function projectionSeedOf(observation) {
  if (observation === null || typeof observation !== 'object' || Array.isArray(observation)) return null
  // v3/v4 的 surface 段同形状 ⇒ 都作种子（见 CACHE_PROJECTION_SEED_VERSIONS 的理由）；
  // 其它版本（v2 及未来未知版本）一律不作种子，绝不"形状对就收"。
  if (!CACHE_PROJECTION_SEED_VERSIONS.includes(observation.contractVersion)) return null
  const surface = observation.surface
  if (surface === null || typeof surface !== 'object' || Array.isArray(surface)) return null
  if (!isFingerprint(surface.fingerprint)) return null
  if (!Number.isInteger(surface.epoch) || surface.epoch < 0) return null
  const chain = messageChainShapeOf(surface.messageChain)
  if (chain.ok !== true) return null
  const digest = chain.chain === null
    ? null
    : { system: null, tools: null, messages: null, messageChain: chain.chain }
  return { epoch: surface.epoch, fingerprint: surface.fingerprint, digest }
}

/** 摘要链（长度 + 链值）：用于跨进程判断「旧前缀是否仍是新序列的前缀」。 */
function chainOf(digests) {
  let value = FNV_OFFSET
  for (const digest of digests) {
    for (const byte of new TextEncoder().encode(digest)) {
      value = (value ^ BigInt(byte)) & MASK_64
      value = (value * FNV_PRIME) & MASK_64
    }
  }
  return deepFreeze({ length: digests.length, value: value.toString(16).padStart(16, '0') })
}

/** 摘要链在前 `limit` 条处的前缀值。 */
function chainValueAt(digests, limit) {
  let value = FNV_OFFSET
  for (let index = 0; index < limit; index += 1) {
    for (const byte of new TextEncoder().encode(digests[index])) {
      value = (value ^ BigInt(byte)) & MASK_64
      value = (value * FNV_PRIME) & MASK_64
    }
  }
  return value.toString(16).padStart(16, '0')
}

/** 是否为「可用的非负有限数」（与账本读侧白名单同一口径）。 */
function usableNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/** 安全标识符（provider/model；非法/缺失一律 null，不猜）。 */
function safeIdentifier(value) {
  return typeof value === 'string' && MODEL_ID_RE.test(value) ? value : null
}

/**
 * 单个 token 字段归一：键不存在/undefined = `missing`；键存在但值非法 = `invalid`（附 reason）；
 * 合法（含 0）= `present`。三态必须可区分——「没报」与「报了 0」是相反的事实。
 */
function normalizeField(value, reported) {
  if (!reported || value === undefined) return { value: null, availability: 'missing' }
  if (!usableNumber(value)) {
    return { value: null, availability: 'invalid', reason: '已报告但不是非负有限数（按缺失处理，不猜值）' }
  }
  return { value, availability: 'present' }
}

/**
 * usage 归一（写入与读取共用）。
 *
 * @param {object} raw 宿主 usage（`TokenUsage` 或其子集）
 * @param {{stepStartedAt?: number, firstTokenAt?: number}} [timing] 见 `STEP_TO_FIRST_TOKEN_NOTE`
 * @returns {{ok:true, usage:object, measurement:object} | {ok:false, reason:string}}
 */
export function normalizeUsageObservation(raw, timing = {}) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return deepFreeze({ ok: false, reason: 'usage 不是对象（缺字段与「空 usage」是两种事实）' })
  }
  const usage = {}
  let present = 0
  for (const field of USAGE_CACHE_FIELDS) {
    const cell = normalizeField(raw[field], Object.prototype.hasOwnProperty.call(raw, field))
    usage[field] = cell
    if (cell.availability === 'present') present += 1
  }
  if (present === 0) return deepFreeze({ ok: false, reason: '没有任何可用的 token 字段（不构成观测样本）' })
  return deepFreeze({ ok: true, usage, measurement: measurementOf(timing) })
}

/**
 * 「step 开始 → 首 token」测量：两端都必须是有限非负数且不倒置，否则 `null`（不可观测不是 0）。
 * 明确不叫 TTFT：起点是 step/start，包含其后的请求准备与构建耗时，**不包含此前 pre-step**（见 note）。
 */
function measurementOf(timing) {
  const started = timing?.stepStartedAt
  const first = timing?.firstTokenAt
  // 刻度是整毫秒——小数时间戳一律归未知，避免「构造接受、校验拒绝」的自相矛盾
  const valid = Number.isInteger(started) && started >= 0
    && Number.isInteger(first) && first >= started
  return deepFreeze({
    stepToFirstToken: {
      value: valid ? first - started : null,
      source: valid ? STEP_TO_FIRST_TOKEN_SOURCE : null,
      note: STEP_TO_FIRST_TOKEN_NOTE,
    },
  })
}

/** 读归一 usage 里某字段的值（非 present 一律 null，不把缺失当 0）。 */
function valueOf(usage, field) {
  const cell = usage?.[field]
  return cell?.availability === 'present' && usableNumber(cell.value) ? cell.value : null
}

/**
 * 算术一致性（**只报算术，不报语义**）。
 *
 * `totalTokens === input + cacheRead + cacheWrite + output` 成立时 status=consistent——
 * 它只说明这几个数字彼此自洽（适配器本来就是这么算的），**不说明**供应商把
 * cache read / cache write 与 uncached input 分成互斥计费桶。因此本函数
 * **不产出** `mutuallyExclusive` / `uncached` / `billedInput` / 计费总额。
 *
 * v4 增 `additivity`：逐 provider 的**可否相加**声明（见 `contracts/usage-normalization.mjs`）。
 * 它同样是算术属性，不是计费语义——`cacheFieldsAddable:true` 只说"这几个数可以相加"，
 * 不说"供应商把它们分成互斥计费桶"。
 *
 * @param {object} usage `normalizeUsageObservation(...).usage`
 * @param {{provider?:string|null}} [options] provider 来自同行 `request.provider`（缺则不猜）
 * @returns {{status:string, sum:number|null, total:number|null, evidence:string, missing:string[], note:string, additivity:object}}
 */
export function arithmeticConsistencyOf(usage, options = {}) {
  const additivity = additivityOf(usage, options?.provider ?? null)
  const values = {}
  const missing = []
  for (const field of ARITHMETIC_COMPONENTS) {
    const value = valueOf(usage, field)
    if (value === null) missing.push(field)
    else values[field] = value
  }
  const total = valueOf(usage, 'totalTokens')
  if (missing.length > 0 || total === null) {
    return deepFreeze({
      status: 'unknown',
      sum: null,
      total,
      evidence: 'insufficient-fields',
      missing: Object.freeze(missing.length > 0 ? missing : ['totalTokens']),
      note: '缺字段（未报 ≠ 0）：不做算术判定，也不猜语义',
      additivity,
    })
  }
  const sum = ARITHMETIC_COMPONENTS.reduce((acc, field) => acc + values[field], 0)
  const consistent = sum === total
  return deepFreeze({
    status: consistent ? 'consistent' : 'inconsistent',
    sum,
    total,
    evidence: consistent ? 'total-equals-component-sum' : 'total-differs-from-component-sum',
    missing: Object.freeze([]),
    note: consistent
      ? '算术自洽不等于计费语义已核验：total 本就是分项之和，不证明供应商计费桶互斥'
      : 'totalTokens ' + total + ' 不等于分项之和 ' + sum + '：算术不自洽',
    additivity,
  })
}

/**
 * 缓存读比率（**只在分母可核验时给值**）。
 *
 * 分母 = `inputTokens + cacheReadTokens + cacheWriteTokens`（三项都必须 present）。
 * 分母为 0 也不给 0%，一律 `null` 并在 `coverage` 里写明发生了什么。
 * **语义标 `unverified`**：这只是「已报告字段之间的算术比」，不是供应商缓存命中率。
 */
export function cacheReadRatioOf(usage) {
  const input = valueOf(usage, 'inputTokens')
  const read = valueOf(usage, 'cacheReadTokens')
  const write = valueOf(usage, 'cacheWriteTokens')
  const coverage = {
    inputTokens: usage?.inputTokens?.availability ?? 'missing',
    cacheReadTokens: usage?.cacheReadTokens?.availability ?? 'missing',
    cacheWriteTokens: usage?.cacheWriteTokens?.availability ?? 'missing',
    denominator: 'input+cacheRead+cacheWrite',
  }
  if (input === null || read === null || write === null) {
    const absent = []
    if (input === null) absent.push('inputTokens')
    if (read === null) absent.push('cacheReadTokens')
    if (write === null) absent.push('cacheWriteTokens')
    return deepFreeze({
      value: null,
      coverage,
      reason: '分母不可核验：缺 ' + absent.join('/') + '（缺失或非法，未报 ≠ 0；显式 0 才算）',
      semantics: 'unverified',
    })
  }
  const denominator = input + read + write
  if (denominator === 0) {
    return deepFreeze({ value: null, coverage, reason: '分母为 0：不给 0%（无意义比率）', semantics: 'unverified' })
  }
  return deepFreeze({ value: read / denominator, coverage, reason: null, semantics: 'unverified' })
}

/**
 * 观测范围判定：**本版本只有 `plugin-surface`**。
 * 出现 `outboundRequest`/`logicalRequest`（哪怕空对象）或 `wire` 一类输入都判
 * `unsupported`——不升级、不伪造。具体原因码由能力合同给出
 * （`observationScopeDecisionOf`），这里保留字符串返回面以兼容既有调用方/测试。
 */
export function observationScopeOf(parts) {
  return observationScopeDecisionOf(parts).scope
}


/**
 * 投影面指纹（确定性、顺序无关、不含正文）与**变更种类**。
 *
 * - `options.coverage`：`{system:false, tools:false}` 表示该部分**不在本快照里**——
 *   digest 对应位置为 null、覆盖度标 unobservable，且**不参与**变更判定（不得把「没看」说成「没变」）。
 * - `options.messageDigests`：调用方缓存的逐消息摘要（长度一致才采用）；不传则逐条计算。
 * - `options.previous`：上一次的指纹结果（或账本种子 `{fingerprint, digest:{messageChain}}`）。
 *
 * 消息**尾部追加**只是内容增长（`appended`），**不是**旧前缀被改写；
 * 只有同位置内容变化才叫 `message-prefix-rewritten`。
 * 没有前一次观测 → `messageChange:null`（不是 'unchanged'）。
 *
 * @param {{system?:any, tools?:any, messages?:any}} surface
 * @param {{previous?:object, coverage?:{system?:boolean, tools?:boolean}, messageDigests?:string[]}} [options]
 */
export function surfaceFingerprintOf(surface, options = {}) {
  const systemObserved = options?.coverage?.system !== false
  const toolsObserved = options?.coverage?.tools !== false
  const system = systemObserved ? (surface?.system ?? null) : null
  const tools = toolsObserved ? (surface?.tools ?? null) : null
  const messages = Array.isArray(surface?.messages) ? surface.messages : []
  const provided = Array.isArray(options?.messageDigests) ? options.messageDigests : null
  const digests = provided !== null && provided.length === messages.length
    ? provided.map((digest) => (typeof digest === 'string' && FINGERPRINT_RE.test(digest) ? digest : null))
    : messages.map((message) => messageDigestOf(message))
  const messagesObserved = digests.every((digest) => digest !== null)
  const digest = {
    system: systemObserved ? fnv1a64(canonicalJson(system)) : null,
    tools: toolsObserved ? fnv1a64(canonicalJson(tools)) : null,
    messages: messagesObserved ? fnv1a64(canonicalJson(digests)) : null,
    messageDigests: messagesObserved ? Object.freeze([...digests]) : null,
    messageChain: messagesObserved ? chainOf(digests) : null,
  }
  const coverage = {
    system: systemObserved ? 'observed' : 'unobservable',
    tools: toolsObserved ? 'observed' : 'unobservable',
    messages: messagesObserved ? 'observed' : 'unobservable',
  }
  const fingerprint = fnv1a64(canonicalJson({ system: digest.system, tools: digest.tools, messages: digest.messages }))
  const previous = options?.previous ?? null
  const previousDigest = previous?.digest ?? null
  const messageChange = previousDigest === null ? null : messageChangeOf(previousDigest, digest)
  const changed = previousDigest === null
    ? null
    : {
      system: systemObserved && previousDigest.system !== null && previousDigest.system !== undefined && previousDigest.system !== digest.system,
      tools: toolsObserved && previousDigest.tools !== null && previousDigest.tools !== undefined && previousDigest.tools !== digest.tools,
      messages: messageChange === null ? null : messageChange !== 'unchanged',
    }
  const fieldsChanged = changed === null
    ? null
    : (changed.system === true ? ['system'] : []).concat(changed.tools === true ? ['tools'] : []).concat(changed.messages === true ? ['messages'] : [])
  // 组件数量：只报**真的看到了**的数量（没看到 = null，不是 0）。
  // system 恒为 1 个提示块（宿主只提交一条 system/message）；tools/messages 用数组长度。
  const counts = {
    system: systemObserved ? 1 : null,
    tools: toolsObserved ? (Array.isArray(tools) ? tools.length : null) : null,
    messages: messagesObserved ? messages.length : null,
  }
  const result = {
    fingerprint,
    digest,
    coverage,
    counts,
    messageChange,
    reason: reasonOf(changed, messageChange),
    firstDivergence: messageChange === 'message-prefix-rewritten' ? firstDivergenceIndexOf(previousDigest, digest) : null,
    epoch: null,
  }
  if (fieldsChanged !== null && fieldsChanged.length > 0) result.fieldsChanged = Object.freeze(fieldsChanged)
  return deepFreeze(result)
}

/**
 * 逐组件视图（`surface.components`）：**哈希 / 数量 / 代际 / 观察范围**四件事一次说清。
 *
 * - `digest`：该组件的 16 位变更指纹（system/tools 是规范化 JSON 的摘要，messages 是
 *   逐消息摘要序列的摘要）；不可观测 → null；
 * - `count`：**实际看到的**数量（没看到 → null，不是 0）；
 * - `generation`：本次观测所属的**投影代际**（= 同一行的 `surface.epoch`）。
 *   它不是「该组件上次变化的代际」——账本不存逐组件历史，这里如实只报"属于哪一代"；
 * - `coverage`：`observed` / `unobservable`（与 surface.coverage 同源，不另立口径）。
 *
 * @param {object} fingerprint `surfaceFingerprintOf(...)` 的结果
 * @param {number|null} generation 投影代际（epoch）
 */
export function componentsOf(fingerprint, generation) {
  const digest = fingerprint?.digest ?? null
  const coverage = fingerprint?.coverage ?? null
  const counts = fingerprint?.counts ?? null
  const build = (kind) => {
    const observed = coverage?.[kind] === 'observed'
      && typeof digest?.[kind] === 'string' && FINGERPRINT_RE.test(digest[kind])
    if (!observed) return deepFreeze({ digest: null, count: null, generation: null, coverage: 'unobservable' })
    return deepFreeze({
      digest: digest[kind],
      count: Number.isSafeInteger(counts?.[kind]) && counts[kind] >= 0 ? counts[kind] : null,
      generation: Number.isSafeInteger(generation) && generation >= 0 ? generation : null,
      coverage: 'observed',
    })
  }
  return deepFreeze({
    system: build('system'),
    tools: build('tools'),
    messages: build('messages'),
  })
}

/**
 * 消息面变更种类：未变 / 尾部追加 / 前缀改写（追加判定 = 旧序列是新序列的严格前缀）。
 * 前一次摘要缺失时返回 null（未知），绝不默认成 unchanged。
 */
function messageChangeOf(previousDigest, digest) {
  const before = previousDigest?.messageDigests
  const after = digest?.messageDigests
  if (Array.isArray(before) && Array.isArray(after)) {
    if (before.length === after.length) {
      for (let index = 0; index < before.length; index += 1) if (before[index] !== after[index]) return 'message-prefix-rewritten'
      return 'unchanged'
    }
    if (after.length > before.length) {
      for (let index = 0; index < before.length; index += 1) if (before[index] !== after[index]) return 'message-prefix-rewritten'
      return 'appended'
    }
    return 'message-prefix-rewritten'
  }
  // 跨进程种子：只有消息链（长度 + 值），没有逐消息摘要。
  const beforeChain = previousDigest?.messageChain
  const afterChain = digest?.messageChain
  if (beforeChain !== null && beforeChain !== undefined && afterChain !== null && afterChain !== undefined) {
    if (!Array.isArray(after)) return null
    if (afterChain.length < beforeChain.length) return 'message-prefix-rewritten'
    if (chainValueAt(after, beforeChain.length) !== beforeChain.value) return 'message-prefix-rewritten'
    return afterChain.length === beforeChain.length ? 'unchanged' : 'appended'
  }
  return null
}

/** 变更原因（系统/工具优先，其次消息；顺序固定）。 */
function reasonOf(changed, messageChange) {
  if (changed === null) return null
  if (changed.system === true) return 'system-changed'
  if (changed.tools === true) return 'tools-changed'
  if (messageChange === 'appended') return 'message-appended'
  if (messageChange === 'message-prefix-rewritten') return 'message-prefix-rewritten'
  return null
}

/**
 * 消息序**首个差异下标**（只比同位置摘要；追加不产生差异；跨进程种子无法定位时 null）。
 *
 * 语义（`surface.firstDivergence` 的契约含义，勿读成「新序列长度」）：
 * - 同位置内容不同 → 该下标；
 * - 新序列是旧序列的**真前缀**（尾部被删除）→ 返回 `after.length`，即「从该下标起
 *   旧序列不再在新序列中存在」。数值上等于新长度，但含义是**首个不再有对应项的下标**，
 *   不是「删了几条」或「新长度」这个统计量。
 * - 旧序列被追加（`appended`）→ 本函数不会被调用（调用点限定 prefix-rewritten）。
 */
function firstDivergenceIndexOf(previousDigest, digest) {
  const before = previousDigest?.messageDigests
  const after = digest?.messageDigests
  if (!Array.isArray(before) || !Array.isArray(after)) return null
  const limit = Math.min(before.length, after.length)
  for (let index = 0; index < limit; index += 1) {
    if (before[index] !== after[index]) return index
  }
  return limit
}

/**
 * 代际与相位：**只有真正改变旧前缀的变化才推进 epoch**。
 * 追加（`appended`）不推进——把内容变长当成缓存失效是 P2 基础版修过的错误归因。
 *
 * `phase` 只描述与上一次观测的关系：initial / steady / append / epoch-start；
 * 无法判定（例如跨进程种子缺消息摘要且指纹已变）→ null，epoch 保持不动。
 *
 * @param {{epoch?:number, fingerprint?:string, digest?:object}|null} previous
 * @param {object} current `surfaceFingerprintOf(...)` 的结果
 */
export function nextProjectionEpoch(previous, current) {
  const before = previous?.epoch
  const base = Number.isInteger(before) ? before : 0
  const systemChanged = current?.coverage?.system === 'observed'
    && previous?.digest?.system !== null && previous?.digest?.system !== undefined
    && current?.digest?.system !== null && current?.digest?.system !== undefined
    && previous.digest.system !== current.digest.system
  const toolsChanged = current?.coverage?.tools === 'observed'
    && previous?.digest?.tools !== null && previous?.digest?.tools !== undefined
    && current?.digest?.tools !== null && current?.digest?.tools !== undefined
    && previous.digest.tools !== current.digest.tools
  const messageChange = current?.messageChange ?? null
  const prefixChanged = systemChanged || toolsChanged || messageChange === 'message-prefix-rewritten'
    ? true
    : (messageChange === 'unchanged' || messageChange === 'appended' ? false : null)
  const phase = previous?.fingerprint === null || previous?.fingerprint === undefined
    ? 'initial'
    : (prefixChanged === true
      ? 'epoch-start'
      : (prefixChanged === false ? (messageChange === 'appended' ? 'append' : 'steady') : null))
  return deepFreeze({
    // initial 的语义是「没有可用的前值」，因此代际必须从 0 起算：任何没有 fingerprint
    // 的 previous（含只给 epoch 的旧形态 / 账本种子缺 fingerprint）都不得把 epoch 带进来，
    // 否则会出现「phase=initial 但 epoch=5」这种自相矛盾的记录。
    epoch: phase === 'initial' ? 0 : (prefixChanged === true ? base + 1 : base),
    phase,
    fingerprint: current?.fingerprint ?? null,
    digest: current?.digest ?? null,
    reason: prefixChanged === true ? (current?.reason ?? null) : null,
    firstDivergence: prefixChanged === true ? (current?.firstDivergence ?? null) : null,
    prefixChanged,
    changed: previous?.fingerprint !== undefined && previous?.fingerprint !== current?.fingerprint,
  })
}

/** 请求/步骤配对：turn/step 必须同时是宿主给出的非负安全整数，否则整段 null（不猜）。 */
function requestSectionOf(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const turn = Number.isSafeInteger(raw.turn) && raw.turn >= 0 ? raw.turn : null
  const step = Number.isSafeInteger(raw.step) && raw.step >= 0 ? raw.step : null
  if (turn === null || step === null) return null
  return { turn, step, provider: safeIdentifier(raw.provider), model: safeIdentifier(raw.model) }
}

/**
 * 构造观测记录（一次请求一条）：合同版本 + 范围 + **请求/步骤配对** + 归一 usage
 * + 算术一致性 + 读比率 + step→首 token 测量 + **投影面指纹/代际/相位/覆盖度**
 * + 归档关联（只留事务号/意图 ID）。
 *
 * **不支持的范围直接失败**（不制造假观测）；**任何异常都返回 `{ok:false}`**（不抛）。
 * 正文只进指纹，永不回显。
 *
 * @returns {{ok:true, record:object, projection:object|null} | {ok:false, reason:string}}
 *   `projection` 供调用方存为**下一次比较的前值**（进程内链），不落盘。
 */
export function buildCacheObservation(input) {
  try {
    const parts = input?.scope !== null && typeof input?.scope === 'object' ? input.scope : {}
    // 范围判定走合同层唯一实现（`observationScopeOf` 是兼容读面，`...DecisionOf` 带原因码）
    const scope = observationScopeOf(parts)
    if (scope === 'unsupported') {
      const scopeDecision = observationScopeDecisionOf(parts)
      // 拒绝是结论，**原因码**是证据：「拒绝了什么」必须可分辨（wire 无 seam vs 未接线）。
      return deepFreeze({
        ok: false,
        reason: 'unsupported-observation-scope',
        code: scopeDecision.reason,
        layer: scopeDecision.layer,
      })
    }
    const normalized = input?.usage === undefined || input?.usage === null
      ? { ok: false, reason: '没有 usage 就无从观测' }
      : (input.usage?.usage !== undefined && typeof input.usage?.ok === 'boolean'
        ? input.usage
        : normalizeUsageObservation(input.usage, input?.timing))
    if (normalized.ok !== true) return deepFreeze({ ok: false, reason: normalized.reason })
    // 只有一种前值形态：`previousSurface`（上一份 projection 或账本种子）。
    // 旧的 `previousSurfaceEpoch` 入参无任何调用方，且会造出「initial + epoch=N」的
    // 自相矛盾记录，已删除——不保留一个只能被误用的旁路。
    const previous = input?.previousSurface !== undefined && input?.previousSurface !== null
      ? input.previousSurface
      : null
    const fingerprint = input?.surface === undefined || input?.surface === null
      ? null
      : surfaceFingerprintOf(input.surface, {
        previous,
        coverage: input?.surfaceCoverage,
        messageDigests: input?.messageDigests,
      })
    const epoch = fingerprint === null ? null : nextProjectionEpoch(previous, fingerprint)
    const snapshot = typeof input?.surfaceSnapshot === 'string' && SURFACE_SNAPSHOT_POINTS.includes(input.surfaceSnapshot)
      ? input.surfaceSnapshot
      : null
    const request = requestSectionOf(input?.request)
    const record = {
      contractVersion: CACHE_TOKENS_CONTRACT_VERSION,
      observationScope: scope,
      at: usableNumber(input?.at) ? input.at : null,
      request,
      usage: normalized.usage,
      measurement: normalized.measurement,
      // provider 从同行 request 段取：可加性判定是 provider 属性的函数，缺 provider 即 null
      arithmetic: arithmeticConsistencyOf(normalized.usage, { provider: request?.provider ?? null }),
      cacheReadRatio: cacheReadRatioOf(normalized.usage),
      surface: fingerprint === null
        ? null
        : {
          fingerprint: fingerprint.fingerprint,
          messageChain: fingerprint.digest.messageChain,
          epoch: epoch.epoch,
          phase: epoch.phase,
          reason: epoch.reason,
          firstDivergence: epoch.firstDivergence,
          messageChange: fingerprint.messageChange,
          coverage: fingerprint.coverage,
          snapshot,
          // 逐组件：哈希/数量/代际/观察范围（system/tools 在 pre-step 恒 unobservable）
          components: componentsOf(fingerprint, epoch.epoch),
        },
      archive: input?.archiveEvent === null || input?.archiveEvent === undefined
        ? null
        : {
          txn: Number.isInteger(input.archiveEvent.txn) ? input.archiveEvent.txn : null,
          intentId: typeof input.archiveEvent.intentId === 'string' && ID_RE.test(input.archiveEvent.intentId)
            ? input.archiveEvent.intentId
            : null,
        },
      // 分层覆盖度：本行看到了哪几层（来源/时点/缺口由能力表声明，行里只留状态）
      layers: layersSectionOf({
        hasSurface: fingerprint !== null,
        coverage: fingerprint?.coverage ?? null,
        hasUsage: true,
      }),
      // 生命周期关联：**只有调用方给了会话/attempt 才写**（不给 = null = 未知，不编造）
      lifecycle: input?.lifecycle === undefined || input?.lifecycle === null
        ? null
        : lifecycleSectionOf({
          request,
          sessionKey: input.lifecycle.sessionKey ?? null,
          attempt: input.lifecycle.attempt ?? null,
          attemptState: input.lifecycle.attemptState,
          arrival: input.lifecycle.arrival ?? null,
        }),
    }
    const projection = fingerprint === null
      ? null
      : { epoch: epoch.epoch, fingerprint: fingerprint.fingerprint, digest: epoch.digest }
    return deepFreeze({ ok: true, record, projection })
  } catch (error) {
    return deepFreeze({ ok: false, reason: 'build 失败：' + (error?.message ?? String(error)) })
  }
}

/**
 * 公共段（v3/v4 同形状的九个段）的唯一校验与重算路径。
 * v3 读侧与 v4 写侧共用它——**不复制一份校验**，否则旧行会走上一条更宽松的旁路。
 *
 * @returns {{ok:true, at:number|null, request:object|null, usage:object|null, measurement:object|null, arithmetic:object, cacheReadRatio:object, surface:object|null, archive:object|null} | {ok:false, reason:string}}
 */
function coreSectionsOf(observation) {
  const at = Number.isInteger(observation.at) && observation.at >= 0 ? observation.at : null
  const request = sanitizeRequest(observation.request)
  if (request.ok !== true) return request
  const usageResult = sanitizeUsage(observation.usage)
  if (usageResult.ok !== true) return usageResult
  const usage = usageResult.usage
  const measurement = sanitizeMeasurement(observation.measurement)
  if (measurement.ok !== true) return measurement
  const surface = sanitizeSurface(observation.surface)
  if (surface.ok !== true) return surface
  const archive = sanitizeArchive(observation.archive)
  if (archive.ok !== true) return archive
  return {
    ok: true,
    at,
    request: request.request,
    usage,
    measurement: measurement.measurement,
    // 派生量一律重算：外部声称的结论不采信。provider 取同行 request 段（可加性按 provider 变）
    arithmetic: arithmeticConsistencyOf(usage, { provider: request.request?.provider ?? null }),
    cacheReadRatio: cacheReadRatioOf(usage),
    surface: surface.surface,
    archive: archive.archive,
  }
}

/**
 * 落盘前的严格校验（唯一入口）：**未知字段拒绝、格式封闭、派生量重算**。
 *
 * `arithmetic`/`cacheReadRatio` 从 usage 重算（不接受外部声称）；
 * 指纹/消息链/epoch/phase 无法从记录重算（记录里没有正文），只做形状与枚举校验——
 * 它们是观测值，不是可推导结论，这一边界写在文档里。
 *
 * v4 的两段**必填**：`layers`（四层覆盖度）必须存在且状态自洽；`lifecycle` 允许 null
 * （= 调用方没给会话/attempt，未知），给了就必须过关联合同的严格校验。
 *
 * @returns {{ok:true, record:object} | {ok:false, reason:string}}
 */
export function sanitizeCacheObservation(observation) {
  try {
    if (observation === null || typeof observation !== 'object' || Array.isArray(observation)) {
      return { ok: false, reason: '观测记录必须是对象' }
    }
    for (const key of Object.keys(observation)) {
      if (!RECORD_FIELDS.includes(key)) return { ok: false, reason: '未知字段：' + key }
    }
    if (observation.contractVersion !== CACHE_TOKENS_CONTRACT_VERSION) {
      return { ok: false, reason: '观测记录合同版本不符：' + JSON.stringify(observation.contractVersion) }
    }
    if (!OBSERVATION_SCOPES.includes(observation.observationScope)) {
      return { ok: false, reason: '不支持的观测范围：' + JSON.stringify(observation.observationScope) }
    }
    const core = coreSectionsOf(observation)
    if (core.ok !== true) return core
    const layersResult = sanitizeLayersSection(observation.layers)
    if (layersResult.ok !== true) return { ok: false, reason: layersResult.reason }
    let lifecycle = null
    if (observation.lifecycle !== null && observation.lifecycle !== undefined) {
      const lifecycleResult = sanitizeLifecycleSection(observation.lifecycle)
      if (lifecycleResult.ok !== true) return lifecycleResult
      lifecycle = lifecycleResult.lifecycle
    }
    return {
      ok: true,
      record: {
        contractVersion: CACHE_TOKENS_CONTRACT_VERSION,
        observationScope: observation.observationScope,
        at: core.at,
        request: core.request,
        usage: core.usage,
        measurement: core.measurement,
        arithmetic: core.arithmetic,
        cacheReadRatio: core.cacheReadRatio,
        surface: core.surface,
        archive: core.archive,
        layers: layersResult.layers,
        lifecycle,
      },
    }
  } catch (error) {
    return { ok: false, reason: 'sanitize 失败：' + (error?.message ?? String(error)) }
  }
}

/**
 * **读侧**入口：账本行 → 可用视图（新旧兼容的**唯一**读路径）。
 *
 * - v4 行：走 `sanitizeCacheObservation`（同一个校验器，不给写侧留旁路）；
 * - v3 行：按**v3 字段集**校验同一批公共段，然后显式把 `layers/lifecycle` 置 null、
 *   `surface.components` 置 null。**null = 旧行没记，不是"观测到了"**——读侧不许
 *   用当前版本的默认值把旧行"补齐"，否则上游会把"没有证据"当成"有证据"。
 * - 其它版本：拒绝（不猜、不迁移）。
 *
 * @returns {{ok:true, legacy:boolean, contractVersion:number, record:object} | {ok:false, reason:string}}
 */
export function readObservationRowOf(observation) {
  try {
    if (observation === null || typeof observation !== 'object' || Array.isArray(observation)) {
      return { ok: false, reason: '观测记录必须是对象' }
    }
    // 账本行形状是 `{seq, ...record}`（C-G3-06：宿主 seq 在记录**之外**做幂等键）。
    // 读侧必须先剥掉它，否则每一行都会被自己的幂等键判成"未知字段"。
    const row = { ...observation }
    delete row.seq
    const version = row.contractVersion
    if (version === CACHE_TOKENS_CONTRACT_VERSION) {
      const canonical = sanitizeCacheObservation(row)
      if (canonical.ok !== true) return canonical
      return { ok: true, legacy: false, contractVersion: CACHE_TOKENS_CONTRACT_VERSION, record: canonical.record }
    }
    if (version !== 3) {
      return { ok: false, reason: '不支持的观测合同版本：' + JSON.stringify(version) }
    }
    for (const key of Object.keys(row)) {
      if (!LEGACY_V3_RECORD_FIELDS.includes(key)) {
        // v3 行里出现 v4 才有的段（或被塞进来的未知键）⇒ 不是真 v3 行，拒绝而不是"降级读取"
        return { ok: false, reason: 'v3 记录出现非 v3 字段：' + key }
      }
    }
    if (!OBSERVATION_SCOPES.includes(row.observationScope)) {
      return { ok: false, reason: '不支持的观测范围：' + JSON.stringify(row.observationScope) }
    }
    // v3 行不得**嵌套**携带 v4 段：顶层已经拒绝（LEGACY_V3_RECORD_FIELDS），
    // surface.components 也必须同样拒绝——静默归 null 会让"旧行带着不该有的字段"被读成
    // "旧行只是没有这个观测"，两者是不同的失败语义（前者是坏行，后者是缺记录）。
    if (row.surface !== null && typeof row.surface === 'object' && !Array.isArray(row.surface)
      && Object.prototype.hasOwnProperty.call(row.surface, 'components')) {
      return { ok: false, reason: 'v3 记录的 surface 不得含 components（v4 字段；拒绝而不是静默归 null）' }
    }
    const core = coreSectionsOf(row)
    if (core.ok !== true) return core
    return {
      ok: true,
      legacy: true,
      contractVersion: 3,
      record: {
        contractVersion: 3,
        observationScope: row.observationScope,
        at: core.at,
        request: core.request,
        usage: core.usage,
        measurement: core.measurement,
        arithmetic: core.arithmetic,
        cacheReadRatio: core.cacheReadRatio,
        // 未携带 components ⇒ sanitizeSurface 已给 null（旧行没记，不是"没有组件"）
        surface: core.surface,
        archive: core.archive,
        layers: null,
        lifecycle: null,
      },
    }
  } catch (error) {
    return { ok: false, reason: 'read 失败：' + (error?.message ?? String(error)) }
  }
}

/** request 段严格校验：字段封闭、turn/step 必须同时给出且为非负整数、标识符走字符集。 */
function sanitizeRequest(candidate) {
  if (candidate === null || candidate === undefined) return { ok: true, request: null }
  if (typeof candidate !== 'object' || Array.isArray(candidate)) return { ok: false, reason: 'request 必须是对象或 null' }
  for (const key of Object.keys(candidate)) {
    if (!REQUEST_FIELDS.includes(key)) return { ok: false, reason: 'request 未知字段：' + key }
  }
  const turn = candidate.turn
  const step = candidate.step
  if (!Number.isSafeInteger(turn) || turn < 0) return { ok: false, reason: 'request.turn 必须是非负安全整数' }
  if (!Number.isSafeInteger(step) || step < 0) return { ok: false, reason: 'request.step 必须是非负安全整数' }
  const provider = candidate.provider === null || candidate.provider === undefined ? null : candidate.provider
  if (provider !== null && (typeof provider !== 'string' || !MODEL_ID_RE.test(provider))) {
    return { ok: false, reason: 'request.provider 只允许标识符字符集（不得夹带正文）' }
  }
  const model = candidate.model === null || candidate.model === undefined ? null : candidate.model
  if (model !== null && (typeof model !== 'string' || !MODEL_ID_RE.test(model))) {
    return { ok: false, reason: 'request.model 只允许标识符字符集（不得夹带正文）' }
  }
  return { ok: true, request: { turn, step, provider, model } }
}

/** usage 段严格校验：字段封闭、单元格形状封闭、present 必为数值、非 present 必为 null。 */
function sanitizeUsage(candidate) {
  if (candidate === null || candidate === undefined) return { ok: true, usage: null }
  if (typeof candidate !== 'object' || Array.isArray(candidate)) return { ok: false, reason: 'usage 必须是对象或 null' }
  for (const key of Object.keys(candidate)) {
    if (!USAGE_CACHE_FIELDS.includes(key)) return { ok: false, reason: 'usage 未知字段：' + key }
  }
  const usage = {}
  for (const field of USAGE_CACHE_FIELDS) {
    const cell = candidate[field]
    if (cell === undefined) continue
    if (cell === null) return { ok: false, reason: 'usage.' + field + ' 不能是 null（缺失请省略该字段）' }
    if (typeof cell !== 'object' || Array.isArray(cell)) return { ok: false, reason: 'usage.' + field + ' 必须是单元格对象' }
    const availability = cell.availability
    if (!['present', 'missing', 'invalid'].includes(availability)) {
      return { ok: false, reason: 'usage.' + field + '.availability 非法：' + JSON.stringify(availability) }
    }
    if (availability === 'present') {
      if (!usableNumber(cell.value)) return { ok: false, reason: 'usage.' + field + ' 标为 present 但不是非负有限数' }
      usage[field] = { value: cell.value, availability: 'present' }
      continue
    }
    if (cell.value !== null) return { ok: false, reason: 'usage.' + field + ' 非 present 却带数值（不得用 0 冒充缺失）' }
    usage[field] = availability === 'invalid'
      ? { value: null, availability: 'invalid', reason: '已报告但不是非负有限数（按缺失处理，不猜值）' }
      : { value: null, availability: 'missing' }
  }
  return { ok: true, usage }
}

/** 测量段严格校验：只接受本合同的来源枚举，值为 null 或非负整数。 */
function sanitizeMeasurement(candidate) {
  if (candidate === null || candidate === undefined) return { ok: true, measurement: null }
  if (typeof candidate !== 'object' || Array.isArray(candidate)) return { ok: false, reason: 'measurement 必须是对象或 null' }
  for (const key of Object.keys(candidate)) {
    if (key !== 'stepToFirstToken') return { ok: false, reason: 'measurement 未知字段：' + key }
  }
  const cell = candidate.stepToFirstToken
  if (cell === null || typeof cell !== 'object' || Array.isArray(cell)) {
    return { ok: false, reason: 'measurement.stepToFirstToken 必须是对象' }
  }
  for (const key of Object.keys(cell)) {
    if (!['value', 'source', 'note'].includes(key)) return { ok: false, reason: 'measurement.stepToFirstToken 未知字段：' + key }
  }
  const value = cell.value === null ? null : (Number.isInteger(cell.value) && cell.value >= 0 ? cell.value : undefined)
  if (value === undefined) return { ok: false, reason: 'measurement.stepToFirstToken.value 非法' }
  const source = cell.source === null || cell.source === undefined ? null : cell.source
  if (source !== null && source !== STEP_TO_FIRST_TOKEN_SOURCE) {
    return { ok: false, reason: 'measurement.stepToFirstToken.source 非法：' + JSON.stringify(source) }
  }
  return {
    ok: true,
    measurement: {
      stepToFirstToken: { value, source: value === null ? null : source, note: STEP_TO_FIRST_TOKEN_NOTE },
    },
  }
}

/** 投影面段严格校验：指纹/消息链定长十六进制，相位/原因/种类/覆盖度走封闭枚举，正文无从进入。 */
function sanitizeSurface(candidate) {
  if (candidate === null || candidate === undefined) return { ok: true, surface: null }
  if (typeof candidate !== 'object' || Array.isArray(candidate)) return { ok: false, reason: 'surface 必须是对象或 null' }
  for (const key of Object.keys(candidate)) {
    if (!SURFACE_FIELDS.includes(key)) return { ok: false, reason: 'surface 未知字段：' + key }
  }
  if (!isFingerprint(candidate.fingerprint)) {
    return { ok: false, reason: 'surface.fingerprint 必须是 16 位小写十六进制' }
  }
  // 消息链形状的唯一判据在 messageChainShapeOf（与账本种子读取共用同一份规则）
  const chainResult = messageChainShapeOf(candidate.messageChain)
  if (chainResult.ok !== true) return chainResult
  const chain = chainResult.chain
  const epoch = candidate.epoch === null || candidate.epoch === undefined ? null : candidate.epoch
  if (epoch !== null && (!Number.isInteger(epoch) || epoch < 0)) return { ok: false, reason: 'surface.epoch 非法' }
  const phase = candidate.phase === null || candidate.phase === undefined ? null : candidate.phase
  if (phase !== null && !PROJECTION_PHASES.includes(phase)) return { ok: false, reason: 'surface.phase 非法：' + JSON.stringify(phase) }
  const reason = candidate.reason === null || candidate.reason === undefined ? null : candidate.reason
  if (reason !== null && !SURFACE_CHANGE_REASONS.includes(reason)) return { ok: false, reason: 'surface.reason 非法：' + JSON.stringify(reason) }
  const firstDivergence = candidate.firstDivergence === null || candidate.firstDivergence === undefined ? null : candidate.firstDivergence
  if (firstDivergence !== null && (!Number.isInteger(firstDivergence) || firstDivergence < 0)) {
    return { ok: false, reason: 'surface.firstDivergence 非法' }
  }
  const messageChange = candidate.messageChange === null || candidate.messageChange === undefined ? null : candidate.messageChange
  if (messageChange !== null && !SURFACE_CHANGE_KINDS.includes(messageChange)) {
    return { ok: false, reason: 'surface.messageChange 非法：' + JSON.stringify(messageChange) }
  }
  const coverage = candidate.coverage
  if (coverage === null || coverage === undefined || typeof coverage !== 'object' || Array.isArray(coverage)) {
    return { ok: false, reason: 'surface.coverage 必须是对象' }
  }
  for (const key of Object.keys(coverage)) {
    if (!['system', 'tools', 'messages'].includes(key)) return { ok: false, reason: 'surface.coverage 未知字段：' + key }
    if (!COVERAGE_STATES.includes(coverage[key])) {
      return { ok: false, reason: 'surface.coverage.' + key + ' 非法：' + JSON.stringify(coverage[key]) }
    }
  }
  for (const key of ['system', 'tools', 'messages']) {
    if (coverage[key] === undefined) return { ok: false, reason: 'surface.coverage 缺 ' + key }
  }
  const snapshot = candidate.snapshot === null || candidate.snapshot === undefined ? null : candidate.snapshot
  if (snapshot !== null && !SURFACE_SNAPSHOT_POINTS.includes(snapshot)) {
    return { ok: false, reason: 'surface.snapshot 非法：' + JSON.stringify(snapshot) }
  }
  const componentsResult = sanitizeComponents(candidate.components, coverage)
  if (componentsResult.ok !== true) return componentsResult
  return {
    ok: true,
    surface: {
      fingerprint: candidate.fingerprint,
      messageChain: chain,
      epoch,
      phase,
      reason,
      firstDivergence,
      messageChange,
      coverage: { system: coverage.system, tools: coverage.tools, messages: coverage.messages },
      snapshot,
      // 缺失（v3 行）→ null = 旧行没记，**不是**「没有组件」
      components: componentsResult.components,
    },
  }
}

/**
 * `surface.components` 严格校验：三个组件必须齐全、字段封闭、覆盖度与组件摘要存在性自洽。
 *
 * - 缺失（v3 行）→ `null`（旧行没记；读侧不补齐）；
 * - `coverage:'observed'` ⇒ digest 必须是 16 位十六进制、count 非负整数、generation 非负整数；
 * - `coverage:'unobservable'` ⇒ 三个值**必须**是 null（不许用 0 冒充「没看到」）；
 * - 组件覆盖度必须与本行 `surface.coverage` 逐项一致（同一行里不许两套口径）。
 */
function sanitizeComponents(candidate, coverage) {
  if (candidate === null || candidate === undefined) return { ok: true, components: null }
  if (typeof candidate !== 'object' || Array.isArray(candidate)) {
    return { ok: false, reason: 'surface.components 必须是对象或 null' }
  }
  for (const key of Object.keys(candidate)) {
    if (!SURFACE_COMPONENT_KINDS.includes(key)) return { ok: false, reason: 'surface.components 未知组件：' + key }
  }
  const components = {}
  for (const kind of SURFACE_COMPONENT_KINDS) {
    const entry = candidate[kind]
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return { ok: false, reason: 'surface.components.' + kind + ' 必须是对象' }
    }
    for (const key of Object.keys(entry)) {
      if (!COMPONENT_FIELDS.includes(key)) return { ok: false, reason: 'surface.components.' + kind + ' 未知字段：' + key }
    }
    if (!COVERAGE_STATES.includes(entry.coverage)) {
      return { ok: false, reason: 'surface.components.' + kind + '.coverage 非法：' + JSON.stringify(entry.coverage) }
    }
    if (coverage[kind] !== entry.coverage) {
      return { ok: false, reason: 'surface.components.' + kind + ' 覆盖度与 surface.coverage 不一致（同一行不许两套口径）' }
    }
    if (entry.coverage === 'unobservable') {
      if (entry.digest !== null || entry.count !== null || entry.generation !== null) {
        return { ok: false, reason: 'surface.components.' + kind + ' 标为 unobservable 却带值（不得用 0 冒充没看到）' }
      }
      components[kind] = { digest: null, count: null, generation: null, coverage: 'unobservable' }
      continue
    }
    if (!isFingerprint(entry.digest)) {
      return { ok: false, reason: 'surface.components.' + kind + '.digest 必须是 16 位小写十六进制' }
    }
    if (!Number.isSafeInteger(entry.count) || entry.count < 0) {
      return { ok: false, reason: 'surface.components.' + kind + '.count 必须是非负整数' }
    }
    if (!Number.isSafeInteger(entry.generation) || entry.generation < 0) {
      return { ok: false, reason: 'surface.components.' + kind + '.generation 必须是非负整数' }
    }
    components[kind] = {
      digest: entry.digest,
      count: entry.count,
      generation: entry.generation,
      coverage: 'observed',
    }
  }
  return { ok: true, components }
}

/** 归档关联严格校验：事务号整数，意图 ID 只允许 ID 字符（不接受任意字符串）。 */
function sanitizeArchive(candidate) {
  if (candidate === null || candidate === undefined) return { ok: true, archive: null }
  if (typeof candidate !== 'object' || Array.isArray(candidate)) return { ok: false, reason: 'archive 必须是对象或 null' }
  for (const key of Object.keys(candidate)) {
    if (!['txn', 'intentId'].includes(key)) return { ok: false, reason: 'archive 未知字段：' + key }
  }
  const txn = candidate.txn === null || candidate.txn === undefined ? null : candidate.txn
  if (txn !== null && (!Number.isInteger(txn) || txn < 0)) return { ok: false, reason: 'archive.txn 非法' }
  const intentId = candidate.intentId === null || candidate.intentId === undefined ? null : candidate.intentId
  if (intentId !== null && (typeof intentId !== 'string' || !ID_RE.test(intentId))) {
    return { ok: false, reason: 'archive.intentId 只允许 [A-Za-z0-9_-]{1,64}（不得夹带正文）' }
  }
  return { ok: true, archive: { txn, intentId } }
}
