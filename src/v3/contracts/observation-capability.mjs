/**
 * G3 分层观测能力合同（0.15.0，能力合同 v1）——**纯数据 + 纯函数，零外部依赖**。
 *
 * ## 交付的是「能力表」而不是「能力」
 * 开发流程 §9.1 要求先把四层分开：**plugin-surface / logical-request / wire / provider-usage**。
 * 每一层都要写清来源、时点、可见字段与缺口；不属于本版本能观测的东西，就写「没有 seam」，
 * 不许用近似物顶替：
 *
 * - **不允许**拿 `logical-request` 的指纹冒充 `wire` 的字节哈希（二者不是同一对象：
 *   wire JSON 的字段重排、系统提示折叠、工具 schema 序列化、缓存标记都在 provider adapter
 *   内部完成，插件没有只读 seam —— P0 宿主合同 §2.5）；
 * - **不允许**把一次工具重试当成一次请求：同一步内的每次 llm 调用是独立的 attempt，
 *   见 `contracts/observation-lifecycle.mjs`；
 * - **不允许**猜宿主事件名或对已安装宿主打猴补丁来「凑出」wire 观测（§9.2）。
 *
 * ## 两层结构（能力表 vs 每行覆盖度）
 * - `OBSERVATION_CAPABILITY_TABLE`：**静态能力声明**（本文件），逐层写来源/时点/字段/缺口；
 * - 观测行里的 `layers` 段：**这一行到底覆盖了哪几层**（observed/partial/unobservable/
 *   not-wired/no-seam）。两者用 `OBSERVATION_CAPABILITY_VERSION` 对齐，行里只留状态，
 *   不逐行抄来源与缺口（否则每条几十字节的固定噪音会挤掉真正的测量值）。
 *
 * ## 不适用条件
 * - 不产任何「命中/未命中」「金额」「供应商 TTFT」结论；
 * - 不读宿主对象、不读盘、不记录正文；本模块只描述「能观测到什么」。
 */
import { deepFreeze } from '../shared/deep-freeze.mjs'

/** 能力表版本（与观测行合同版本独立：加一层/改一处缺口声明才动它）。 */
export const OBSERVATION_CAPABILITY_VERSION = 1

/** 观测分层（**顺序固定且封闭**；第 3 项 wire 的 state 必须恒为 no-seam）。 */
export const CAPABILITY_LAYERS = Object.freeze([
  'plugin-surface', 'logical-request', 'wire', 'provider-usage',
])

/**
 * 每层在本版本的能力状态：
 * - `available`：有 seam 且已在本版本落地（plugin-surface / provider-usage）；
 * - `not-wired`：seam 存在（`llm/stream` waterfall），但插件本轮**没有**接线；
 * - `no-seam`：宿主/供应商内部，插件拿不到只读视图（wire）。
 */
export const CAPABILITY_STATES = Object.freeze(['available', 'not-wired', 'no-seam'])

/**
 * 单行观测的层覆盖度（比能力状态多两个观测值）：
 * - `observed`：本行完整看到了该层要求的全部字段；
 * - `partial`：只看到一部分（如 pre-step 只有消息面，system/tools 不可见）；
 * - `unobservable`：本行没采到（**不是「没变化」**）；
 * - `not-wired` / `no-seam`：**能力**层面的缺口，与本次采样无关。
 */
export const LAYER_OBSERVATION_STATES = Object.freeze([
  'observed', 'partial', 'unobservable', 'not-wired', 'no-seam',
])

/**
 * 四层能力表（**唯一的静态真源**）。字段含义：
 * - `layer` / `state`：层名与能力状态；
 * - `source`：宿主符号/事件（逐字对齐 P0 宿主合同；wire 为 null）；
 * - `pointInTime`：相对请求生命周期的采样位置；
 * - `fields`：该层能给出的事实（自然语言条目，不是 schema —— schema 在观测行合同里）；
 * - `gaps`：**本版本明确拿不到的东西**（失败关闭的依据，不得在别处含糊掉）；
 * - `nativeId`：该层是否有宿主原生请求 ID（wire/logical-request/provider-usage 都没有；
 *   因此生命周期关联只能用 `local-diagnostic` 来源的本地诊断 ID）。
 */
export const OBSERVATION_CAPABILITY_TABLE = deepFreeze([
  {
    layer: 'plugin-surface',
    state: 'available',
    source: 'agent/pre-step 的 session.deriveMessages()（与宿主 buildRequest 的 boundaryMessages 同源）+ assistant/message.data（turn/step/usage/source）',
    pointInTime: 'pre-step（第 N 步请求之前）/ assistant/message（该步完成之后）',
    fields: [
      '消息链指纹与逐消息摘要（正文只进指纹）',
      '快照点 snapshot=pre-step 与覆盖度 coverage（system/tools/messages 三键）',
      '投影相位 phase 与代际 epoch（只描述插件可见前缀的变化）',
      '请求/步骤配对 request.turn/step 与 provider/model（宿主字段）',
      'usage 六字段三态（见 provider-usage 层）',
    ],
    gaps: [
      '不含 system prompt 与工具 schema：宿主在随后 step() 内部组装（P0 §2.1）',
      '不含 pre-step 之后追加的 runtime context 与 decision.messages',
      '不能证明该步最终请求的完整消息集，也不能当供应商缓存键',
    ],
    nativeId: false,
  },
  {
    layer: 'logical-request',
    state: 'not-wired',
    source: "宿主 llm/stream waterfall 的 options（config + messages + tools + toolHistory + sessionId，外壳 Object.freeze）",
    pointInTime: '宿主组装请求之后、provider adapter 之前',
    fields: [],
    gaps: [
      '插件本轮未注册 llm/stream 监听器（接线属集成分批，entry 不在本切片可改范围）',
      '宿主没有 requestId 字段：只能给 local-diagnostic 来源的本地诊断 ID，不得声称宿主原生关联',
      '同一步内的每次 llm 调用是独立 attempt（工具重试不是一次请求），本条目不改变这一点',
    ],
    nativeId: false,
  },
  {
    layer: 'wire',
    state: 'no-seam',
    source: null,
    pointInTime: null,
    fields: [],
    gaps: [
      'provider 线格式（字段重排、系统提示折叠、工具 schema 序列化、缓存标记）在 adapter 内部完成，插件没有只读 seam（P0 §2.5，U6 结论）',
      '不得用 logical-request 的哈希冒充 wire 字节哈希',
      '不猜事件名、不 patch 已安装宿主、不做跨隐私边界的猴子补丁',
    ],
    nativeId: false,
  },
  {
    layer: 'provider-usage',
    state: 'available',
    source: 'assistant/message.data.usage（宿主 TokenUsage）；退路：assistant/attempt 的末 usage chunk（P0 §2.4）',
    pointInTime: 'assistant/message 落面之后（插件摄入是异步的，接入时间不是发生时间）',
    fields: [
      'inputTokens / outputTokens / totalTokens / cacheReadTokens / cacheWriteTokens / reasoningTokens',
      '每字段 availability ∈ present/missing/invalid（缺失 = null，不写 0）',
      '算术一致性（分项之和是否等于 total）与逐 provider 可加性声明',
    ],
    gaps: [
      'totalTokens 不用 in+out 自行补齐；缺失即 null',
      'reasoningTokens 是否已含在 output 内由 provider 决定（见 usage 归一合同），未核验就 null',
      '不估金额/价格/TTL，不判定供应商计费桶语义（价格只进 G8 外部结算表）',
    ],
    nativeId: false,
  },
])

/**
 * 表自检（**加载期不变量**）：顺序必须与 `CAPABILITY_LAYERS` 一致、状态必须在封闭集内。
 * 这张表是"能力声明"的唯一真源，一旦有人手改出未登记状态或调换顺序，
 * 读侧（`layersSectionOf`）会静默给出错位的覆盖度——所以这里直接失败，不留隐患。
 */
for (const [index, entry] of OBSERVATION_CAPABILITY_TABLE.entries()) {
  if (entry.layer !== CAPABILITY_LAYERS[index]) {
    throw new Error('观测能力表顺序与 CAPABILITY_LAYERS 不一致：' + entry.layer)
  }
  if (!CAPABILITY_STATES.includes(entry.state)) {
    throw new Error('观测能力表状态未登记：' + entry.layer + ' = ' + entry.state)
  }
}

/** 按层取能力条目（未知层返回 null，不猜）。 */
export function capabilityOf(layer) {
  return OBSERVATION_CAPABILITY_TABLE.find((entry) => entry.layer === layer) ?? null
}

/**
 * 观测范围判定（**唯一判据**）：出现任何「本版本没有 seam / 没有接线」的分层输入即拒绝，
 * 并给出**具体原因码**，而不是笼统的 `unsupported`——「拒绝」与「拒绝了什么」必须分开，
 * 否则后续很容易靠塞一个空对象把范围升级上去（旧实现就是 `outboundRequest = {}` 即升级）。
 *
 * 判据顺序固定：wire 优先于 logical-request（wire 是更靠后的、更不可得的层）。
 *
 * @param {object|null|undefined} parts 分层输入（`{wire?, logicalRequest?, outboundRequest?, pluginSurface?}`）
 * @returns {{scope:string, state:string, layer:string|null, reason:string|null}}
 */
export function observationScopeDecisionOf(parts) {
  const bag = parts !== null && typeof parts === 'object' ? parts : {}
  if (bag.wire !== undefined || bag.wireRequest !== undefined || bag.wireBytes !== undefined) {
    return deepFreeze({ scope: 'unsupported', state: 'no-seam', layer: 'wire', reason: 'wire-no-seam' })
  }
  if (bag.logicalRequest !== undefined || bag.outboundRequest !== undefined) {
    return deepFreeze({
      scope: 'unsupported',
      state: 'not-wired',
      layer: 'logical-request',
      reason: 'outbound-request-not-wired',
    })
  }
  return deepFreeze({ scope: 'plugin-surface', state: 'available', layer: 'plugin-surface', reason: null })
}

/**
 * 本行的分层覆盖度（写进观测行的 `layers` 段）。
 *
 * @param {{hasSurface?: boolean, coverage?: {system?:string,tools?:string,messages?:string}, hasUsage?: boolean}} input
 * @returns {{contractVersion:number, pluginSurface:string, logicalRequest:string, wire:string, providerUsage:string}}
 */
export function layersSectionOf(input) {
  const hasSurface = input?.hasSurface === true
  const hasUsage = input?.hasUsage === true
  const coverage = input?.coverage ?? null
  const observedParts = ['system', 'tools', 'messages']
    .filter((key) => coverage !== null && coverage?.[key] === 'observed').length
  const pluginSurface = hasSurface !== true
    ? 'unobservable'
    : (observedParts === 3 ? 'observed' : (observedParts === 0 ? 'unobservable' : 'partial'))
  return deepFreeze({
    contractVersion: OBSERVATION_CAPABILITY_VERSION,
    pluginSurface,
    // 这两个不是「本次没看到」，而是**能力**缺口：与采样无关，永远如实写在行里
    logicalRequest: capabilityOf('logical-request').state,
    wire: capabilityOf('wire').state,
    providerUsage: hasUsage === true ? 'observed' : 'unobservable',
  })
}

/** layers 段的字段封闭集（sanitize 与构造共用）。 */
const LAYERS_FIELDS = Object.freeze([
  'contractVersion', 'pluginSurface', 'logicalRequest', 'wire', 'providerUsage',
])

/**
 * layers 段严格校验：版本必须是当前能力合同版本；四个状态各走自己的封闭集；
 * `wire` 只允许 `no-seam`（写别的值等于宣称有 wire 观测），`logicalRequest` 只允许
 * `not-wired`（本轮没接线；接线后必须同时改能力表与这里，不许在行里偷改）。
 *
 * @returns {{ok:true, layers:object} | {ok:false, reason:string}}
 */
export function sanitizeLayersSection(candidate) {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return { ok: false, reason: 'layers 必须是对象' }
  }
  for (const key of Object.keys(candidate)) {
    if (!LAYERS_FIELDS.includes(key)) return { ok: false, reason: 'layers 未知字段：' + key }
  }
  if (candidate.contractVersion !== OBSERVATION_CAPABILITY_VERSION) {
    return { ok: false, reason: 'layers.contractVersion 不符：' + JSON.stringify(candidate.contractVersion) }
  }
  const expectations = {
    pluginSurface: ['observed', 'partial', 'unobservable'],
    logicalRequest: ['not-wired'],
    wire: ['no-seam'],
    providerUsage: ['observed', 'unobservable'],
  }
  const layers = { contractVersion: OBSERVATION_CAPABILITY_VERSION }
  for (const [key, allowed] of Object.entries(expectations)) {
    const value = candidate[key]
    // 先过"全体层状态"的并集，再过该层的封闭集：两处口径不同（并集是能力表的状态词表，
    // 单层是这张表的约束），分开判才能给出"这个值根本不是状态"还是"这一层不许这个状态"。
    if (!LAYER_OBSERVATION_STATES.includes(value)) {
      return { ok: false, reason: 'layers.' + key + ' 不是合法的层状态：' + JSON.stringify(value) }
    }
    if (!allowed.includes(value)) {
      return { ok: false, reason: 'layers.' + key + ' 非法（本版本只允许 ' + allowed.join('/') + '）：' + JSON.stringify(value) }
    }
    layers[key] = value
  }
  return { ok: true, layers }
}
