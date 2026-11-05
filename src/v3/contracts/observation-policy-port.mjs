/**
 * G5 只读 policy 输入端口合同（0.15.0，端口合同 v1）——**只定义端口与数据形状**。
 *
 * ## 为什么需要一份「独立的端口合同」
 * 开发流程 §9.7 与 P2-b §6.8 都写死了同一条边界：**观测不参与归档/调度决策**。
 * 但 G5（缓存收益/调度策略）确实需要信号。合法做法不是让决策层去读诊断账本，而是：
 *
 * 1. **适配器**（`adapters/storage/usage-log.mjs` 的 `readObservationPolicyInput`）读账本，
 *    在**账本侧**把逐行诊断数据聚合成**汇总**；
 * 2. 决策层只拿到本文件定义的端口形状——**没有任何逐行的 seq/指纹/正文**，
 *    也没有内容、凭据、价格；
 * 3. 本文件**不实现任何策略**（没有阈值、没有默认值、没有推荐动作）。它只回答
 *    「G5 允许看到哪些字段、这些字段是什么类型、什么取值是未知」。
 *
 * ## 为什么端口里没有「逐行记录」
 * - 逐行记录会诱导决策层按 seq 顺序推断"先后因果"，那是运行期数据流，不是合同；
 * - 逐行记录仍带会话内的指纹链，组合多个会话即可做跨会话关联（违反会话隔离）；
 * - 汇总里的 `usage.counted` 已经排除了重复/迟到样本被双计的可能。
 *
 * ## 未知的表达
 * 端口里所有"可能没有"的量都允许 `null`，语义是 **未知**，不是 0：
 * `usage.totals.*` 只在对应字段至少有一份已计数样本时才是数字；`additivity.*` 的判定
 * 都可能是 `null`（未核验的 provider）。
 *
 * ## 不适用条件
 * - 不产出策略结论、不比较会话、不算金额；
 * - 不读盘、不读宿主对象：本文件是纯数据与纯校验。
 */
import { deepFreeze } from '../shared/deep-freeze.mjs'

/** 端口合同版本（字段增减/语义变化才动它）。 */
export const POLICY_INPUT_PORT_VERSION = 1

/** 端口可出现的顶层字段（**封闭集**；多一个字段就拒绝）。 */
export const POLICY_INPUT_FIELDS = Object.freeze([
  'contractVersion', 'session', 'window', 'projection', 'components', 'usage', 'layers',
])

const USAGE_TOKEN_FIELDS = Object.freeze([
  'inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens',
])
const PHASES = Object.freeze(['initial', 'steady', 'append', 'epoch-start'])
const MESSAGE_CHANGES = Object.freeze(['unchanged', 'appended', 'message-prefix-rewritten'])
const COVERAGE = Object.freeze(['observed', 'unobservable'])
const WINDOW_FIELDS = Object.freeze(['fromSeq', 'toSeq', 'rows', 'legacyRows', 'skippedRows'])
const PROJECTION_FIELDS = Object.freeze(['epoch', 'lastPhase', 'lastMessageChange', 'phaseCounts'])
const COMPONENTS_FIELDS = Object.freeze(['messages', 'system', 'tools'])
const MESSAGES_COMPONENT_FIELDS = Object.freeze(['digest', 'count', 'generation'])
const USAGE_FIELDS = Object.freeze([
  'counted', 'duplicates', 'late', 'unknownArrival', 'unsampledLegacy', 'totals', 'availability', 'cacheReadRatio', 'additivity',
])
const ADDITIVITY_FIELDS = Object.freeze(['provider', 'cacheFieldsAddable', 'reasoningExtraTokens', 'verified'])
const FINGERPRINT_RE = /^[0-9a-f]{16}$/
const LOCAL_ID_RE = /^(sess|lr|at)-local-[0-9a-f]{16}$/

/**
 * 禁令的**按位置豁免**（P4-2）：只豁免"这个键在**这个位置**上是已声明字段"，
 * 而不是"这个键名在任意位置都合法"。
 *
 * 例：`window.rows` 是合法聚合字段（本窗口聚合了多少行）；`usage.rows` /
 * `components.messages.rows` 仍然是"逐行记录"的偷渡位。旧实现用**全局并集**按名字
 * 一刀切，结果后者只拿到「未知字段」文案——禁令在最常见的那个名字上打不中它该打的位置。
 * 现在豁免路径由各字段封闭集**按所属容器**派生，不另抄一份名单。
 */
const DECLARED_KEY_PATHS = new Set([
  ...WINDOW_FIELDS.map((key) => 'window.' + key),
  ...PROJECTION_FIELDS.map((key) => 'projection.' + key),
  ...COMPONENTS_FIELDS.map((key) => 'components.' + key),
  ...MESSAGES_COMPONENT_FIELDS.map((key) => 'components.messages.' + key),
  ...USAGE_FIELDS.map((key) => 'usage.' + key),
  ...USAGE_TOKEN_FIELDS.flatMap((key) => ['usage.totals.' + key, 'usage.availability.' + key]),
  ...ADDITIVITY_FIELDS.map((key) => 'usage.additivity.' + key),
  'session.id',
  'session.source',
])

const isNonNegativeInt = (value) => Number.isSafeInteger(value) && value >= 0

/** 只认非负有限数或 null（null = 未知，不是 0）。 */
function numberOrNull(value) {
  return value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0)
}

/**
 * **端口定义**（唯一真源）。G5 的实现只能按这个对象取数据：
 * `validate` 由端口自带（函数声明提升，故可在定义处直接引用），
 * 消费方不必自己重写形状校验（避免第二份口径）。
 */
export const POLICY_INPUT_PORT = deepFreeze({
  version: POLICY_INPUT_PORT_VERSION,
  name: 'observation-policy-input',
  direction: 'read-only',
  source: 'observation-summary',
  fields: POLICY_INPUT_FIELDS,
  // 明确不允许流进决策层的东西：校验器对**整棵树（含嵌套）**做键名扫描，命中即拒绝并点名路径。
  // 先于「未知字段」检查执行 ⇒ 内容类键名得到**具体**原因，而不是被泛化成"未知字段"。
  // 豁免**按位置**（只有 `window.rows` 这种已声明位置才合法）；未声明位置的同名键
  // （`usage.rows` / `components.messages.rows`）仍命中禁令并点名路径——见 DECLARED_KEY_PATHS。
  forbidden: Object.freeze(['rows', 'records', 'content', 'text', 'credentials', 'prices', 'cost', 'ttft']),
  validate: sanitizePolicyInput,
})

/**
 * 在**整棵对象树**上扫描 `POLICY_INPUT_PORT.forbidden` 的键名（含嵌套），命中即返回路径。
 *
 * 为什么不能只查顶层：端口禁止的是"逐行诊断/正文/凭据/价格"这类**内容**，最自然的偷渡
 * 位置是某个分段内部（如 `usage.rows`、`components.text`）。只查顶层会让这条禁令变成
 * 永远打不中的死检查——那等于没有禁令。
 *
 * @param {unknown} value 任意候选值
 * @param {string} [prefix] 当前路径前缀（用于报出命中位置）
 * @returns {string|null} 命中路径（如 `usage.rows`）或 null
 */
function forbiddenKeyPathOf(value, prefix = '') {
  if (value === null || typeof value !== 'object') return null
  if (Array.isArray(value)) {
    for (const [index, inner] of value.entries()) {
      const hit = forbiddenKeyPathOf(inner, prefix + '[' + index + '].')
      if (hit !== null) return hit
    }
    return null
  }
  for (const [key, inner] of Object.entries(value)) {
    if (POLICY_INPUT_PORT.forbidden.includes(key) && !DECLARED_KEY_PATHS.has(prefix + key)) return prefix + key
    const hit = forbiddenKeyPathOf(inner, prefix + key + '.')
    if (hit !== null) return hit
  }
  return null
}

/**
 * 端口输入严格校验：字段封闭、类型封闭、枚举封闭。
 * 校验失败返回 `{ok:false, reason}`（**不抛**），消费方据此失败关闭。
 *
 * @param {object} candidate 适配器聚合出的汇总
 * @returns {{ok:true, input:object} | {ok:false, reason:string}}
 */
export function sanitizePolicyInput(candidate) {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return { ok: false, reason: 'policy 输入必须是对象' }
  }
  // P3-6：扫描必须**不抛**（本函数对外的约定就是失败返回 {ok:false}）。调用方直接构造的
  // **循环引用**对象会让全树递归抛 RangeError；深度极大的对象同理。两者都按合同失败关闭，
  // 而不是把异常抛给"以为拿到一个布尔/对象"的消费方。
  let forbiddenPath = null
  try {
    forbiddenPath = forbiddenKeyPathOf(candidate)
  } catch (error) {
    return { ok: false, reason: 'policy 输入不可扫描：' + (error?.message ?? String(error)) }
  }
  // 先扫禁令键（含嵌套），再查未知字段：否则禁令永远被"未知字段"挡在前面、分支不可达
  if (forbiddenPath !== null) {
    return { ok: false, reason: 'policy 输入不得含逐行诊断/正文/凭据/价格字段：' + forbiddenPath }
  }
  for (const key of Object.keys(candidate)) {
    if (!POLICY_INPUT_FIELDS.includes(key)) return { ok: false, reason: 'policy 输入未知字段：' + key }
  }
  if (candidate.contractVersion !== POLICY_INPUT_PORT_VERSION) {
    return { ok: false, reason: 'policy 输入端口版本不符：' + JSON.stringify(candidate.contractVersion) }
  }

  // session：本地诊断引用或 null（不得出现原始会话键/宿主原生 ID）
  let session = null
  if (candidate.session !== null && candidate.session !== undefined) {
    const raw = candidate.session
    if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'session 必须是对象或 null' }
    for (const key of Object.keys(raw)) {
      if (!['id', 'source'].includes(key)) return { ok: false, reason: 'session 未知字段：' + key }
    }
    if (typeof raw.id !== 'string' || !LOCAL_ID_RE.test(raw.id)) return { ok: false, reason: 'session.id 形状非法' }
    if (raw.source !== 'local-diagnostic') return { ok: false, reason: 'session.source 必须是 local-diagnostic' }
    session = { id: raw.id, source: 'local-diagnostic' }
  }

  const window = candidate.window
  if (window === null || typeof window !== 'object' || Array.isArray(window)) return { ok: false, reason: 'window 必须是对象' }
  for (const key of Object.keys(window)) if (!WINDOW_FIELDS.includes(key)) return { ok: false, reason: 'window 未知字段：' + key }
  for (const key of ['rows', 'legacyRows', 'skippedRows']) {
    if (!isNonNegativeInt(window[key])) return { ok: false, reason: 'window.' + key + ' 必须是非负整数' }
  }
  for (const key of ['fromSeq', 'toSeq']) {
    if (window[key] !== null && !isNonNegativeInt(window[key])) return { ok: false, reason: 'window.' + key + ' 必须是非负整数或 null' }
  }

  const projection = candidate.projection
  if (projection === null || typeof projection !== 'object' || Array.isArray(projection)) {
    return { ok: false, reason: 'projection 必须是对象' }
  }
  for (const key of Object.keys(projection)) if (!PROJECTION_FIELDS.includes(key)) return { ok: false, reason: 'projection 未知字段：' + key }
  if (projection.epoch !== null && !isNonNegativeInt(projection.epoch)) return { ok: false, reason: 'projection.epoch 非法' }
  if (projection.lastPhase !== null && !PHASES.includes(projection.lastPhase)) return { ok: false, reason: 'projection.lastPhase 非法' }
  if (projection.lastMessageChange !== null && !MESSAGE_CHANGES.includes(projection.lastMessageChange)) {
    return { ok: false, reason: 'projection.lastMessageChange 非法' }
  }
  const phaseCounts = projection.phaseCounts
  if (phaseCounts === null || typeof phaseCounts !== 'object' || Array.isArray(phaseCounts)) {
    return { ok: false, reason: 'projection.phaseCounts 必须是对象' }
  }
  for (const key of Object.keys(phaseCounts)) {
    if (!PHASES.includes(key)) return { ok: false, reason: 'projection.phaseCounts 未知字段：' + key }
  }
  for (const key of PHASES) {
    if (!isNonNegativeInt(phaseCounts[key])) return { ok: false, reason: 'projection.phaseCounts.' + key + ' 必须是非负整数' }
  }

  const components = candidate.components
  if (components === null || typeof components !== 'object' || Array.isArray(components)) {
    return { ok: false, reason: 'components 必须是对象' }
  }
  for (const key of Object.keys(components)) if (!COMPONENTS_FIELDS.includes(key)) return { ok: false, reason: 'components 未知字段：' + key }
  const messages = components.messages
  if (messages === null || typeof messages !== 'object' || Array.isArray(messages)) return { ok: false, reason: 'components.messages 必须是对象' }
  for (const key of Object.keys(messages)) if (!MESSAGES_COMPONENT_FIELDS.includes(key)) return { ok: false, reason: 'components.messages 未知字段：' + key }
  if (messages.digest !== null && (typeof messages.digest !== 'string' || !FINGERPRINT_RE.test(messages.digest))) {
    return { ok: false, reason: 'components.messages.digest 非法' }
  }
  if (messages.count !== null && !isNonNegativeInt(messages.count)) return { ok: false, reason: 'components.messages.count 非法' }
  if (messages.generation !== null && !isNonNegativeInt(messages.generation)) return { ok: false, reason: 'components.messages.generation 非法' }
  for (const key of ['system', 'tools']) {
    const entry = components[key]
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return { ok: false, reason: 'components.' + key + ' 必须是对象' }
    for (const inner of Object.keys(entry)) if (inner !== 'coverage') return { ok: false, reason: 'components.' + key + ' 未知字段：' + inner }
    if (!COVERAGE.includes(entry.coverage)) return { ok: false, reason: 'components.' + key + '.coverage 非法' }
  }

  const usage = candidate.usage
  if (usage === null || typeof usage !== 'object' || Array.isArray(usage)) return { ok: false, reason: 'usage 必须是对象' }
  for (const key of Object.keys(usage)) if (!USAGE_FIELDS.includes(key)) return { ok: false, reason: 'usage 未知字段：' + key }
  for (const key of ['counted', 'duplicates', 'late', 'unknownArrival', 'unsampledLegacy']) {
    if (!isNonNegativeInt(usage[key])) return { ok: false, reason: 'usage.' + key + ' 必须是非负整数' }
  }
  for (const bucket of ['totals', 'availability']) {
    const value = usage[bucket]
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return { ok: false, reason: 'usage.' + bucket + ' 必须是对象' }
    for (const key of Object.keys(value)) {
      if (!USAGE_TOKEN_FIELDS.includes(key)) return { ok: false, reason: 'usage.' + bucket + ' 未知字段：' + key }
    }
    for (const key of USAGE_TOKEN_FIELDS) {
      if (bucket === 'totals') {
        if (!numberOrNull(value[key])) return { ok: false, reason: 'usage.totals.' + key + ' 必须是数字或 null（缺失不是 0）' }
      } else if (!['present', 'missing'].includes(value[key])) {
        return { ok: false, reason: 'usage.availability.' + key + ' 非法：' + JSON.stringify(value[key]) }
      }
    }
  }
  if (!numberOrNull(usage.cacheReadRatio)) return { ok: false, reason: 'usage.cacheReadRatio 必须是数字或 null' }
  const additivity = usage.additivity
  if (additivity === null || typeof additivity !== 'object' || Array.isArray(additivity)) {
    return { ok: false, reason: 'usage.additivity 必须是对象' }
  }
  for (const key of Object.keys(additivity)) if (!ADDITIVITY_FIELDS.includes(key)) return { ok: false, reason: 'usage.additivity 未知字段：' + key }
  if (additivity.provider !== null && typeof additivity.provider !== 'string') return { ok: false, reason: 'usage.additivity.provider 非法' }
  const addable = additivity.cacheFieldsAddable
  if (addable !== null && typeof addable !== 'boolean') {
    return { ok: false, reason: 'usage.additivity.cacheFieldsAddable 必须是布尔或 null' }
  }
  if (!numberOrNull(additivity.reasoningExtraTokens)) {
    return { ok: false, reason: 'usage.additivity.reasoningExtraTokens 必须是数字或 null' }
  }
  if (!['source-read', 'live', 'unknown'].includes(additivity.verified)) {
    return { ok: false, reason: 'usage.additivity.verified 非法' }
  }

  // layers：与观测行同形状（或 null = 本窗口没有可用行）
  let layers = null
  if (candidate.layers !== null && candidate.layers !== undefined) {
    const raw = candidate.layers
    if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'layers 必须是对象或 null' }
    for (const key of Object.keys(raw)) {
      if (!['contractVersion', 'pluginSurface', 'logicalRequest', 'wire', 'providerUsage'].includes(key)) {
        return { ok: false, reason: 'layers 未知字段：' + key }
      }
    }
    if (!isNonNegativeInt(raw.contractVersion)) return { ok: false, reason: 'layers.contractVersion 非法' }
    for (const [key, allowed] of Object.entries({
      pluginSurface: ['observed', 'partial', 'unobservable'],
      logicalRequest: ['not-wired'],
      wire: ['no-seam'],
      providerUsage: ['observed', 'unobservable'],
    })) {
      if (!allowed.includes(raw[key])) return { ok: false, reason: 'layers.' + key + ' 非法：' + JSON.stringify(raw[key]) }
    }
    layers = {
      contractVersion: raw.contractVersion,
      pluginSurface: raw.pluginSurface,
      logicalRequest: raw.logicalRequest,
      wire: raw.wire,
      providerUsage: raw.providerUsage,
    }
  }

  return {
    ok: true,
    input: {
      contractVersion: POLICY_INPUT_PORT_VERSION,
      session,
      window: {
        fromSeq: window.fromSeq ?? null,
        toSeq: window.toSeq ?? null,
        rows: window.rows,
        legacyRows: window.legacyRows,
        skippedRows: window.skippedRows,
      },
      projection: {
        epoch: projection.epoch ?? null,
        lastPhase: projection.lastPhase ?? null,
        lastMessageChange: projection.lastMessageChange ?? null,
        phaseCounts: {
          initial: phaseCounts.initial,
          steady: phaseCounts.steady,
          append: phaseCounts.append,
          'epoch-start': phaseCounts['epoch-start'],
        },
      },
      components: {
        messages: {
          digest: messages.digest ?? null,
          count: messages.count ?? null,
          generation: messages.generation ?? null,
        },
        system: { coverage: components.system.coverage },
        tools: { coverage: components.tools.coverage },
      },
      usage: {
        counted: usage.counted,
        duplicates: usage.duplicates,
        late: usage.late,
        unknownArrival: usage.unknownArrival,
        unsampledLegacy: usage.unsampledLegacy,
        totals: Object.fromEntries(USAGE_TOKEN_FIELDS.map((key) => [key, usage.totals[key] ?? null])),
        availability: Object.fromEntries(USAGE_TOKEN_FIELDS.map((key) => [key, usage.availability[key]])),
        cacheReadRatio: usage.cacheReadRatio ?? null,
        additivity: {
          provider: additivity.provider ?? null,
          cacheFieldsAddable: additivity.cacheFieldsAddable ?? null,
          reasoningExtraTokens: additivity.reasoningExtraTokens ?? null,
          verified: additivity.verified,
        },
      },
      layers,
    },
  }
}
