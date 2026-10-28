/**
 * v3 会话投影单元：把宿主进程内的引擎状态投影成客户端只读状态（0.14.0-beta.15，方案 B）。
 *
 * ## 为什么是投影（而不是轮询 / 写会话事件）
 *
 * 客户端的 composer 槽位（`conversation.input.dock`）拿不到宿主进程里的对象；它能读的
 * 只有宿主主动推送的**会话读模型**。宿主的读模型缝就是 `ctx.sessionProjections`：
 * 宿主 `dsh-api-session-controller` 的 `SessionControlController` 订阅
 * `sessionProjections.onChanged`，把 `{type:'projection', sessionId, key, value, seq}`
 * 原样广播；baseline 用 `sessionProjections.snapshot(session)` 取**所有**带 `wire` 的 key，
 * 没有白名单。客户端 `ProjectionValueStore` 是开放 key 空间，槽位标准属性里的
 * `useProjection(key)` 直接按 key 读。所以注册一个单元即可，不需要新传输、不需要轮询、
 * 不需要把状态写进会话事件。
 *
 * ## 状态与视图的分工（关键约束）
 *
 * 投影的 **state 是纯折叠**，会被 `dsh-session-projection-cache` 持久化成检查点，重启后
 * 从日志冷恢复。引擎的 `records / lastSeq / 回注计数` **不是**事件日志的纯函数（它们在
 * 后台摄入任务里推进），把它们放进 state 会让冷恢复读出一份陈旧的数字，并且伪造
 * `asOfSeq` 的语义。因此：
 *
 * - `state` 只存 `{ sessionId, tick }`。`tick` 是本会话最近一个事件的 seq；每个事件都换
 *   状态引用，驱动 view 重算（这是「读模型水位」，不是引擎计数）。
 * - `wire.view` 读引擎的**同步** `statusOf(sessionId)`（O(1) 内存读，零 I/O）。视图不落盘，
 *   冷恢复时由当前进程重新算一遍。
 *
 * 这不是自创形态：宿主自己的 `imageLimits` 投影就是 `state: null` + `wire.view: () =>
 * attachments.imageLimits`（`dsh-api-session-controller` 的 `ApiSessionList`）。区别只在于
 * 我们的 tick 每个事件都变，所以视图会随事件刷新，而不是只在 baseline 时算一次。
 *
 * ## 校验
 *
 * 宿主注册表只调用 schema 的 `.parse()`（`stateSchema.parse` / `wire.viewSchema.parse`），
 * 见 `dsh-session-projection/lib/index.js`。这里用最小的严格校验器（不引入 zod 依赖）：
 * 任一字段不合法即抛 TypeError——失败关闭，不静默归一。state 拒绝多余字段，正是为了
 * 钉住「引擎计数不得进 state」这条不变量（测试 `v3-client-dock` 会改回去必红）。
 */

/** 投影 key（客户端 `useProjection` 读同一个字符串；测试交叉核对）。 */
export const STATUS_PROJECTION_KEY = 'memoryContextLabStatus'
/** 状态结构变化时递增；检查点版本不匹配会被宿主丢弃并重折。 */
export const STATUS_PROJECTION_VERSION = 1

/** 视图允许的状态枚举（封闭集；未知状态按 failed 处理，不伪装成 ready）。 */
const VIEW_STATES = new Set(['ready', 'pending', 'absent', 'failed', 'unavailable'])
const VIEW_MODES = new Set(['full-history', 'cooling', 'recall-only'])
const VIEW_MODE_SOURCES = new Set(['default', 'migration', 'explicit'])

function invalid(label, value) {
  throw new TypeError('status projection: ' + label + ' 非法：' + JSON.stringify(value))
}

/** state 的严格形状：只有 sessionId 与 tick 两个键（多余键 = 把引擎计数塞进了检查点）。 */
export const statusStateSchema = Object.freeze({
  parse(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid('state', value)
    const keys = Object.keys(value)
    if (keys.length !== 2 || !keys.includes('sessionId') || !keys.includes('tick')) {
      invalid('state.keys', keys)
    }
    if (typeof value.sessionId !== 'string') invalid('state.sessionId', value.sessionId)
    if (!Number.isInteger(value.tick) || value.tick < -1) invalid('state.tick', value.tick)
    return { sessionId: value.sessionId, tick: value.tick }
  },
})

const nullableInt = (value, minimum) => (Number.isInteger(value) && value >= minimum ? value : null)
const nullableNumber = (value) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null)
const nullableString = (value) => (typeof value === 'string' && value.length > 0 ? value : null)

/** 会话控制的客户端视图：四项数值覆盖固定为 null（未覆盖）或数字。 */
const CONTROL_KEYS = Object.freeze(['limit'])
function controlViewOf(raw) {
  const overrides = Object.fromEntries(CONTROL_KEYS.map((key) => [key, null]))
  const out = { enabled: true, recall: true, overrides, error: null }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const key of ['enabled', 'recall']) {
    if (typeof raw[key] === 'boolean') out[key] = raw[key]
  }
  if (raw.overrides !== null && typeof raw.overrides === 'object' && !Array.isArray(raw.overrides)) {
    for (const key of CONTROL_KEYS) {
      const value = raw.overrides[key]
      if (typeof value === 'number' && Number.isFinite(value)) overrides[key] = value
    }
  }
  if (typeof raw.error === 'string' && raw.error.length > 0) out.error = raw.error
  return out
}

/** 把引擎状态（或任何坏值）压成一个固定形状，绝不抛错、绝不把坏值说成 ready。 */
function viewOf(readStatus, state) {
  const sessionId = state.sessionId
  let raw
  if (sessionId.length === 0) {
    raw = { state: 'unavailable' }
  } else {
    try {
      raw = readStatus(sessionId)
    } catch (error) {
      // 边界转换，不是吞错：异常变成视图里的 failed + code，dock 会显示「状态异常」。
      raw = { state: 'failed', errorCode: error?.code ?? 'ESTATUS_READ', errorMessage: error instanceof Error ? error.message : String(error) }
    }
  }
  if (raw === null || typeof raw !== 'object') {
    raw = { state: 'failed', errorCode: 'ESTATUS_SHAPE', errorMessage: 'statusOf 返回了非对象' }
  }
  const known = VIEW_STATES.has(raw.state)
  const viewState = known ? raw.state : 'failed'
  const errorCode = viewState === 'failed'
    ? (nullableString(raw.errorCode) ?? (known ? 'ESTATUS_UNKNOWN' : 'ESTATUS_STATE'))
    : null
  const mode = VIEW_MODES.has(raw.mode) ? raw.mode : 'recall-only'
  const modeSource = VIEW_MODE_SOURCES.has(raw.modeSource) ? raw.modeSource : 'default'
  const surface = raw.surface !== null && typeof raw.surface === 'object' && !Array.isArray(raw.surface) ? raw.surface : {}
  const cooling = raw.cooling !== null && typeof raw.cooling === 'object' && !Array.isArray(raw.cooling) ? raw.cooling : {}
  const provider = raw.provider !== null && typeof raw.provider === 'object' && !Array.isArray(raw.provider) ? raw.provider : {}
  return {
    state: viewState,
    ingested: nullableInt(raw.ingested, 0),
    // 可检索数（0.14.0-beta.38）：来源是词法索引 indexedCount，不是「已摄入」。
    // null = 索引缺失/损坏/尚未生成——客户端必须显示「未知」，不得回落成 0。
    searchable: nullableInt(raw.searchable, 0),
    lastSeq: nullableInt(raw.lastSeq, -1),
    ingesting: raw.ingesting === true,
    attempted: nullableInt(raw.attempted, 0) ?? 0,
    injected: nullableInt(raw.injected, 0) ?? 0,
    skipped: nullableInt(raw.skipped, 0) ?? 0,
    failed: nullableInt(raw.failed, 0) ?? 0,
    lastStatus: nullableString(raw.lastStatus),
    lastReason: nullableString(raw.lastReason),
    lastInjectedAt: nullableNumber(raw.lastInjectedAt),
    lastErrorCode: nullableString(raw.lastErrorCode),
    errorCode,
    errorMessage: viewState === 'failed' ? nullableString(raw.errorMessage) : null,
    control: controlViewOf(raw.control),
    mode,
    modeSource,
    planFirst: raw.planFirst === true,
    autoRestore: raw.autoRestore !== false,
    surface: {
      lastArchiveEndSeq: Number.isInteger(surface.lastArchiveEndSeq) && surface.lastArchiveEndSeq >= -1 ? surface.lastArchiveEndSeq : -1,
      // 两种模式都推进的「压过历史」事实；null = 从未归档。
      lastArchiveAt: typeof surface.lastArchiveAt === 'number' && Number.isFinite(surface.lastArchiveAt) && surface.lastArchiveAt >= 0 ? surface.lastArchiveAt : null,
    },
    cooling: {
      open: cooling.open === true,
      lastOccupancy: typeof cooling.lastOccupancy === 'number' && Number.isFinite(cooling.lastOccupancy) ? cooling.lastOccupancy : null,
      lastRunAt: typeof cooling.lastRunAt === 'number' && Number.isFinite(cooling.lastRunAt) ? cooling.lastRunAt : null,
      lastReason: nullableString(cooling.lastReason),
    },
    provider: {
      tier: provider.tier === 'T2' ? 'T2' : 'T1',
      reason: nullableString(provider.reason),
    },
    stateError: nullableString(raw.stateError),
  }
}

/** 视图的严格形状：字段集合固定，客户端只读。 */
export const statusViewSchema = Object.freeze({
  parse(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid('view', value)
    const expected = [
      'state', 'ingested', 'searchable', 'lastSeq', 'ingesting', 'attempted', 'injected', 'skipped', 'failed',
      'lastStatus', 'lastReason', 'lastInjectedAt', 'lastErrorCode', 'errorCode', 'errorMessage', 'control',
      'mode', 'modeSource', 'planFirst', 'autoRestore', 'surface', 'cooling', 'provider', 'stateError',
    ]
    const keys = Object.keys(value)
    if (keys.length !== expected.length || !expected.every((key) => Object.hasOwn(value, key))) {
      invalid('view.keys', keys)
    }
    if (!VIEW_STATES.has(value.state)) invalid('view.state', value.state)
    if (value.ingested !== null && (!Number.isInteger(value.ingested) || value.ingested < 0)) invalid('view.ingested', value.ingested)
    if (value.searchable !== null && (!Number.isInteger(value.searchable) || value.searchable < 0)) invalid('view.searchable', value.searchable)
    if (value.lastSeq !== null && (!Number.isInteger(value.lastSeq) || value.lastSeq < -1)) invalid('view.lastSeq', value.lastSeq)
    if (value.lastInjectedAt !== null && (typeof value.lastInjectedAt !== 'number' || !Number.isFinite(value.lastInjectedAt) || value.lastInjectedAt < 0)) invalid('view.lastInjectedAt', value.lastInjectedAt)
    for (const key of ['lastStatus', 'lastReason', 'lastErrorCode', 'errorCode', 'errorMessage']) {
      if (value[key] !== null && typeof value[key] !== 'string') invalid('view.' + key, value[key])
    }
    if (typeof value.ingesting !== 'boolean') invalid('view.ingesting', value.ingesting)
    for (const key of ['attempted', 'injected', 'skipped', 'failed']) {
      if (!Number.isInteger(value[key]) || value[key] < 0) invalid('view.' + key, value[key])
    }
    const control = value.control
    if (control === null || typeof control !== 'object' || Array.isArray(control)) invalid('view.control', control)
    const controlKeys = ['enabled', 'recall', 'overrides', 'error']
    if (Object.keys(control).length !== controlKeys.length || !controlKeys.every((key) => Object.hasOwn(control, key))) {
      invalid('view.control.keys', Object.keys(control))
    }
    for (const key of ['enabled', 'recall']) {
      if (typeof control[key] !== 'boolean') invalid('view.control.' + key, control[key])
    }
    if (control.error !== null && typeof control.error !== 'string') invalid('view.control.error', control.error)
    if (control.overrides === null || typeof control.overrides !== 'object' || Array.isArray(control.overrides)) {
      invalid('view.control.overrides', control.overrides)
    }
    if (Object.keys(control.overrides).length !== CONTROL_KEYS.length || !CONTROL_KEYS.every((key) => Object.hasOwn(control.overrides, key))) {
      invalid('view.control.overrides.keys', Object.keys(control.overrides))
    }
    for (const key of CONTROL_KEYS) {
      const entry = control.overrides[key]
      if (entry !== null && (typeof entry !== 'number' || !Number.isFinite(entry) || entry < 0)) {
        invalid('view.control.overrides.' + key, entry)
      }
    }
    if (!VIEW_MODES.has(value.mode)) invalid('view.mode', value.mode)
    if (!VIEW_MODE_SOURCES.has(value.modeSource)) invalid('view.modeSource', value.modeSource)
    for (const key of ['planFirst', 'autoRestore']) {
      if (typeof value[key] !== 'boolean') invalid('view.' + key, value[key])
    }
    const surface = value.surface
    if (surface === null || typeof surface !== 'object' || Array.isArray(surface)
      || Object.keys(surface).length !== 2 || typeof surface.lastArchiveEndSeq !== 'number'
      || !Number.isInteger(surface.lastArchiveEndSeq) || surface.lastArchiveEndSeq < -1) {
      invalid('view.surface', surface)
    }
    if (surface.lastArchiveAt !== null && (typeof surface.lastArchiveAt !== 'number' || !Number.isFinite(surface.lastArchiveAt) || surface.lastArchiveAt < 0)) {
      invalid('view.surface.lastArchiveAt', surface.lastArchiveAt)
    }
    const cooling = value.cooling
    const coolingKeys = ['open', 'lastOccupancy', 'lastRunAt', 'lastReason']
    if (cooling === null || typeof cooling !== 'object' || Array.isArray(cooling)
      || Object.keys(cooling).length !== coolingKeys.length || !coolingKeys.every((key) => Object.hasOwn(cooling, key))) {
      invalid('view.cooling.keys', Object.keys(cooling ?? {}))
    }
    if (typeof cooling.open !== 'boolean') invalid('view.cooling.open', cooling.open)
    for (const key of ['lastOccupancy', 'lastRunAt']) {
      if (cooling[key] !== null && (typeof cooling[key] !== 'number' || !Number.isFinite(cooling[key]))) invalid('view.cooling.' + key, cooling[key])
    }
    if (cooling.lastReason !== null && typeof cooling.lastReason !== 'string') invalid('view.cooling.lastReason', cooling.lastReason)
    const provider = value.provider
    if (provider === null || typeof provider !== 'object' || Array.isArray(provider)
      || Object.keys(provider).length !== 2 || !Object.hasOwn(provider, 'tier') || !Object.hasOwn(provider, 'reason')) {
      invalid('view.provider.keys', Object.keys(provider ?? {}))
    }
    if (provider.tier !== 'T1' && provider.tier !== 'T2') invalid('view.provider.tier', provider.tier)
    if (provider.reason !== null && typeof provider.reason !== 'string') invalid('view.provider.reason', provider.reason)
    if (value.stateError !== null && typeof value.stateError !== 'string') invalid('view.stateError', value.stateError)
    return value
  },
})

/**
 * 创建投影定义。注册方式（宿主半）：
 *
 * ```js
 * ctx.inject(['sessionProjections'], (projectionCtx) => {
 *   projectionCtx.sessionProjections.register(createStatusProjectionDefinition({ statusOf }))
 * })
 * ```
 *
 * @param {object} options { statusOf(sessionId): object } 同步、只读、绝不抛错的引擎状态读取器
 * @returns {object} ProjectionDefinition（key / stateVersion / stateSchema / init / apply / wire）
 */
export function createStatusProjectionDefinition({ statusOf } = {}) {
  const readStatus = typeof statusOf === 'function'
    ? statusOf
    : () => ({ state: 'unavailable' })
  return {
    key: STATUS_PROJECTION_KEY,
    stateVersion: STATUS_PROJECTION_VERSION,
    stateSchema: statusStateSchema,
    init(header) {
      return { sessionId: typeof header?.id === 'string' ? header.id : '', tick: -1 }
    },
    /**
     * tick 是整个单元的观测水位：每个事件都推进，因此每个事件都会让 view 重算一次。
     * 这不是「无关事件也换引用」的浪费——投影的职责就是让 dock 在每一步看到最新状态；
     * 状态本身仍然只有 sessionId 与 tick 两个字段。
     */
    apply(state, event) {
      const seq = Number.isInteger(event?.seq) ? event.seq : state.tick
      return { sessionId: state.sessionId, tick: seq }
    },
    wire: {
      viewSchema: statusViewSchema,
      view: (state) => viewOf(readStatus, state),
    },
  }
}
