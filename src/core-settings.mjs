/**
 * core-settings.mjs —— core 拆分块①：设置/预设/命令折叠/投影初始状态域
 * （beta.9 P1-1，纯搬移；语义零改动。任务书「core → 常量表真源、模板文案、
 * 杂项工具三块」的杂项工具块）。
 *
 * 本文件不 import core（避免循环）：SURFACE_INJECTION_MARKERS 族随迁，
 * core.mjs 以 import + re-export 维持外部 import 路径零改动。
 */

/** Fixed first line of a replacement receipt; also the receipt's identity marker. */
export const RECEIPT_MARKER = '[已归档操作]'

/**
 * v2 引擎的回执标记。
 *
 * 故意与 v1 的 `[已归档操作]` 不同：`'[已归档操作·v2]'.startsWith('[已归档操作]')`
 * 为 false（']' 前多了 '·v2'），所以两套引擎的回执在日志里天然互不冒充，
 * 面板折叠仍可同时识别两者。
 */
export const V2_RECEIPT_MARKER = '[已归档操作·v2]'

/**
 * 卡组折叠回执的标记（0.10.1 S3）。
 *
 * 与回执标记分开：折叠回执替换的是插件工作卡，不是归档操作；两者都是插件
 * 注入的 user/message，都必须被「最新人类请求」判定排除（0.12.0 P1-2）。
 * 常量只在这里定义一份，card-fold.mjs 与判定函数共用，禁止各写一份。
 */
export const FOLD_RECEIPT_MARKER = '[已折叠工作卡·v2]'

/**
 * 聚合凭证的标记（P3-8/P3-9）。
 *
 * 同上：凭证是插件生成的指针卡，不是人类输入；常量单一出处。
 */
export const AGG_VOUCHER_MARKER = '[聚合凭证·v2]'



/**
 * 全部「活动面上的程序注入消息」标记（0.12.0 P1-2 单一判定函数）。
 *
 * 判定只认标记，不看内容前缀的相似度：人类手打同样的文字不会命中，
 * 因为它不是以这些标记开头（标记都在正文第一行）。
 */
export const SURFACE_INJECTION_MARKERS = Object.freeze([
  RECEIPT_MARKER,
  V2_RECEIPT_MARKER,
  FOLD_RECEIPT_MARKER,
  AGG_VOUCHER_MARKER,
])

/** True when one text block starts with any plugin surface-injection marker. */
export function isSurfaceInjectionText(text) {
  if (typeof text !== 'string' || text === '') return false
  return SURFACE_INJECTION_MARKERS.some((marker) => text.startsWith(marker))
}

/**
 * Default per-session settings. Every value here is user-adjustable from the
 * composer panel; nothing in the archive path is hard-coded to these.
 *
 * The 5/10 pair：保留窗口取小值（5）保持常驻面紧凑，批阈值取 10——2026-10-14
 * 真实会话重放（513 请求、GLM-5.3）显示批 10 把批次数与失效溢价近乎减半，常驻
 * 窗口只多约 7.6 CNY；价差悬殊的路由（DeepSeek 闲时 u/c≈50）适合更大批，见
 * {@link BUILTIN_PRESETS} 的模型预设。
 */
export const DEFAULT_SETTINGS = Object.freeze({
  /**
   * Number of newest operations kept verbatim. Anything older is archived once
   * the batch threshold is met, regardless of how much of the window is used.
   */
  retainOperations: 5,
  /**
   * How many operations must have fallen out of the retention window before a
   * batch is submitted.
   *
   * Archiving is never free: replacing a range invalidates the prefix cache from
   * that point on, so the cost is driven by batch *count*. Waiting for a few
   * operations to pile up cuts the number of invalidations several-fold, at the
   * price of holding those operations verbatim a little longer.
   *
   * The default is 10, not 5: on the 2026-10-14 real-session replay (513 requests,
   * GLM-5.3, 4:1 miss/hit price ratio) batch 10 halved the batch count and the
   * invalidation premium (57.6 → 21.8 CNY) while adding only ~7.6 CNY of resident
   * window cost. Past ~20 the resident window starts to outweigh the savings.
   * A provider whose miss/hit ratio is far higher (e.g. DeepSeek off-peak, ~50)
   * wants a larger batch; see the bundled presets.
   */
  archiveBatchSize: 10,
  /** Cool automatically at the stable pre-step boundary. */
  auto: true,
  /** Inject matching cold-store excerpts at the tail of each new user turn. */
  autoRecall: true,
  /**
   * On stop, put the archived originals back and delete the isolated data.
   *
   * Stopping cooling (or archiving the session) is the end of this session's
   * plugin data, and the only way to make the session self-contained again is to
   * restore first: receipts left in the log point at a cold store that would
   * otherwise have to be kept forever. Turning this off leaves the originals in
   * the cold store and keeps the receipts resolvable.
   */
  autoRestore: true,
  /**
   * 软保护预算（估算 token）。
   *
   * 活跃证据保护分两层：硬保护来自真实结构（未闭合调用、未曝光结果、待确认
   * 副作用、运行中的后台 job、系统／人类约束），不可被预算解除；软保留来自弱
   * 信号（召回刚读回、任务关联线索），受这个预算约束，超预算时按合法降级先释放
   * 最弱的一条并如实报告。它**不是**冷却参数，所以不进预设快照。
   */
  protectBudgetTokens: 32768,
  /**
   * 最近多少个**含读取结果**的操作强制保留（0.12.0 P0-3）。
   *
   * 全历史模式下 `retainOperations` 仍为 0（设计不变）：唯一的节流阀是证据保护层，
   * 而它的判据里没有「刚读过、很可能马上要用」。实测可见窗口中位 9.5 步、18 次
   * ≤2 步——证据刚读完就被归档，模型只能再读一次。
   *
   * 这是**带 TTL 的租约**（智能论 3.2.2 stable），不是永久保护位：被保护的读取在
   * `retainReadsTtl` 步后自动失效，不累积（v1.2 §8.3「受保护集无界增长」是明确
   * 未解问题，不能往里面加料）。设为 0 完全退回旧行为。
   */
  retainReads: 3,
  /**
   * 压力闸门（0.13.0）：上下文占用率达到该百分比才自动降温；0 = 无压力也降温。
   *
   * 默认 20：实测会话占用 8.3%–13.5%，在这个默认下它一次都不会归档——
   * 这正是修复。低占用时降温释放的是最便宜的缓存读，付出的是最贵的未命中输入。
   */
  pressureGate: 20,
})

/** retainReads 的租约步数：默认 2×N（N=0 时为 0，即不启用）。 */
export function retainReadsTtlOf(retainReads) {
  const n = Number.isInteger(retainReads) && retainReads > 0 ? retainReads : 0
  return n === 0 ? 0 : n * 2
}

/** Label of the unnamed fallback preset: the global defaults. */
export const GLOBAL_PRESET_LABEL = '全局预设'

/**
 * Presets bundled with the plugin, also the schema default for the `presets`
 * config field, so a fresh install serves them in the settings page.
 *
 * Values come from the cost grids simulated on the two reference sessions in
 * `docs/预设成本分析.md` (prices of 2026-02):
 * - GLM-5.3-flash misses are cheap but cache hits are ~3.5× cheaper still, and
 *   its operation sizes are small — batch 3 is the optimum, batch 5 costs
 *   ~0.3% more, batch 8+ drifts into double digits.
 * - DeepSeek V4.1-flash pays real money per cache miss, so the optimum is the
 *   other end: batch 16 (with retain ≥ 5) cuts about a fifth off batch 5.
 * - GLM-5.3 (non-flash, 4:1 miss/hit) sits between them: batch 10 is the
 *   optimum on the 2026-10-14 replay, batch 20 is roughly break-even and
 *   batch 50 loses money to the resident window.
 * The floor of 5 retained operations is the product requirement, not an
 * accident; `retain` 5 + `batch` 16 keeps at most 21 operations live.
 */
export const BUILTIN_PRESETS = Object.freeze([
  Object.freeze({
    id: 'glm-5.3-flash-eco',
    name: 'GLM 5.3 Flash 省流',
    settings: Object.freeze({
      retainOperations: 5,
      archiveBatchSize: 3,
      auto: true,
      autoRecall: true,
      autoRestore: true,
    }),
  }),
  Object.freeze({
    id: 'glm-5.3-eco',
    name: 'GLM 5.3 省流',
    settings: Object.freeze({
      retainOperations: 5,
      archiveBatchSize: 10,
      auto: true,
      autoRecall: true,
      autoRestore: true,
    }),
  }),
  Object.freeze({
    id: 'deepseek-v4.1-flash-eco',
    name: 'DeepSeek V4.1 Flash 省流',
    settings: Object.freeze({
      retainOperations: 5,
      archiveBatchSize: 16,
      auto: true,
      autoRecall: true,
      autoRestore: true,
    }),
  }),
])

/** Settings whose value is a plain number with an inclusive range. */
export const NUMERIC_SETTINGS = Object.freeze({
  retain: { key: 'retainOperations', min: 0, max: 200, integer: true, label: '保留最近操作数' },
  batch: { key: 'archiveBatchSize', min: 1, max: 200, integer: true, label: '批量阈值' },
  protect: { key: 'protectBudgetTokens', min: 0, max: 2_000_000, integer: true, label: '软保护预算（估算 token）' },
  readlease: { key: 'retainReads', min: 0, max: 50, integer: true, label: '最近读取保留数（带 TTL 租约）' },
  pressure: { key: 'pressureGate', min: 0, max: 95, integer: true, label: '压力闸门阈值（占用率 %，0 = 无压力也降温）' },
})

/** Settings whose value is a boolean switch. */
export const BOOLEAN_SETTINGS = Object.freeze({
  auto: { key: 'auto', label: '自动降温' },
  recall: { key: 'autoRecall', label: '自动回注' },
  autorestore: { key: 'autoRestore', label: '停用时恢复原文' },
  // 引擎级与插件级开关（面板投影用；v1 引擎不消费 fullHistory 的语义，仅在
  // 折叠状态里随命令记录，供面板在引擎切换时还原开关位置）。
  fullhistory: { key: 'fullHistory', label: '全历史记忆上下文（v2）' },
  planfirst: { key: 'planFirst', label: '新会话计划先行' },
  // v2 层级压缩（P3）与其模型模式（P4）：折叠进投影状态供面板显示开关位置。
  compress: { key: 'hierarchyCompress', label: '层级压缩（v2）' },
  compressmodel: { key: 'compressModel', label: '层级压缩模型模式（v2）' },
  // T1/F-03：层级卡是否共享成员正文摘录。默认关（卡里只给属性与来源）。
  sharel2content: { key: 'shareL2Content', label: '层级卡共享正文摘录（v2）' },
})

/** Split a slash-command's unparsed input into an operation and its literal remainder. */
export function parseOperation(rawInput) {
  const raw = String(rawInput ?? '').trim()
  if (!raw) return { operation: 'status', remainder: '' }
  const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(raw)
  return {
    operation: (match?.[1] ?? '').toLowerCase(),
    remainder: (match?.[2] ?? '').trim(),
  }
}

/** Keep only text blocks; DSH tool-result payloads may also carry images or JSON. */
export function textFromContent(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

/** A deliberately coarse capacity estimate; the host token meter is authoritative. */
export function estimateTokens(text) {
  return Math.ceil(String(text ?? '').length / 4)
}

/** Configuration mistakes the user can fix. */
export class SettingsError extends Error {
  constructor(message) {
    super(message)
    this.name = 'SettingsError'
  }
}

/**
 * Parse one numeric setting value.
 *
 * Accepted forms are a plain fraction (`0.6`) or an explicit percentage
 * (`60%`). A bare number above the range is deliberately **not** reinterpreted
 * as a percentage: silently turning `set margin 2` into `0.02` would change a
 * setting the user did not ask for.
 *
 * @param raw - the literal the user typed.
 * @param spec - the entry from {@link NUMERIC_SETTINGS}.
 * @returns the normalized number.
 * @throws {SettingsError} when the value is missing, unparsable, or out of range.
 */
export function parseNumericSetting(raw, spec) {
  const text = String(raw ?? '').trim()
  if (!text) throw new SettingsError(`${spec.label}不能为空。`)
  const percent = /^(\d+(?:\.\d+)?)\s*%$/.exec(text)
  const value = percent ? Number(percent[1]) / 100 : Number(text)
  if (!Number.isFinite(value)) throw new SettingsError(`${spec.label}必须是数字，收到 "${text}"。`)
  if (spec.integer && !Number.isInteger(value)) {
    throw new SettingsError(`${spec.label}必须是整数，收到 "${text}"。`)
  }
  const inside = spec.exclusive ? value > spec.min && value < spec.max : value >= spec.min && value <= spec.max
  if (!inside) {
    const range = spec.exclusive ? `严格位于 (${spec.min}, ${spec.max}) 之间，或写成百分比` : `位于 [${spec.min}, ${spec.max}]`
    throw new SettingsError(`${spec.label}必须${range}，收到 "${text}"。`)
  }
  return value
}

/**
 * 严格十进制整数（N-10，0.13.2-beta.4）。
 *
 * `Number.parseInt` 会把 12.7 截成 12、把 1e6 读成 1、把 10abc 当成 10——用户
 * 要的值、落盘的值与回执里照抄的值三者不一致。项目自己的规矩是「0/负数/小数/
 * 字符串/NaN 都不接受，不静默换值」（见 v2/budget.mjs 的 parseBudgetTokens），
 * 面板的 parseCount 也明确拒绝小数；命令面必须是同一把尺子。
 *
 * 只认 /^\d+$/：前后空格允许，正负号、小数点、指数、单位、其它字符一律拒绝。
 * 返回 null 表示「不是合法整数」，调用方必须回用法错误，不得回落默认值。
 *
 * 与 parseNumericSetting 的分工：后者是百分比口径（接受 0.6 / 60%，Number() 也会
 * 接受指数写法），命令面的计数/预算参数一律用这个。
 */
export function parseStrictInteger(raw) {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null
  const text = String(raw).trim()
  if (!/^\d+$/.test(text)) return null
  const value = Number(text)
  return Number.isSafeInteger(value) ? value : null
}

/** Normalize any partial settings object onto the defaults. */
/**
 * Accept a numeric setting only when it is an integer inside its declared range.
 *
 * The command path goes through parseNumericSetting, which THROWS on bad input.
 * This one is for the normalisation path, where the value may come from a settings
 * file, a preset, or an older version; there the established contract is
 * "unusable falls back to the default", so an out-of-range value is rejected here
 * rather than clamped onto the boundary.
 *
 * Both bounds matter. Checking the lower bound alone (the previous behaviour) let
 * retainOperations: 1e9 through untouched, so one bad settings file could ask the
 * plugin to retain a million operations.
 */
export function boundedNumericSetting(raw, spec) {
  if (!Number.isInteger(raw)) return undefined
  if (raw < spec.min || raw > spec.max) return undefined
  return raw
}

export function normalizeSettings(raw) {
  const value = raw && typeof raw === 'object' ? raw : {}
  const retain = boundedNumericSetting(value.retainOperations, NUMERIC_SETTINGS.retain)
    ?? DEFAULT_SETTINGS.retainOperations
  const batch = boundedNumericSetting(value.archiveBatchSize, NUMERIC_SETTINGS.batch)
    ?? DEFAULT_SETTINGS.archiveBatchSize
  return {
    retainOperations: retain,
    archiveBatchSize: batch,
    auto: typeof value.auto === 'boolean' ? value.auto : DEFAULT_SETTINGS.auto,
    autoRecall: typeof value.autoRecall === 'boolean' ? value.autoRecall : DEFAULT_SETTINGS.autoRecall,
    autoRestore: typeof value.autoRestore === 'boolean' ? value.autoRestore : DEFAULT_SETTINGS.autoRestore,
    // M2 修复：证据安全预算在归一化时保持输入原值（缺省回 DEFAULT）。
    // 旧实现把它丢掉，导致任何「读配置 → normalizeSettings → 写回」的路径
    // 都会把 protectBudgetTokens 静默重置回默认值。
    protectBudgetTokens: normalizeProtectionBudget(value.protectBudgetTokens),
    // 0.12.0 P0-3：读取租约不是冷却成本档位，但必须随设置持久化与归一化；
    // 旧状态文件没有这个字段时回落到默认 3（不是 0——0 会让修复对新会话失效）。
    retainReads: boundedNumericSetting(value.retainReads, NUMERIC_SETTINGS.readlease)
      ?? DEFAULT_SETTINGS.retainReads,
    // 0.13.0 压力闸门：0 是合法值（= 无压力也降温），所以不能用 ?? 的语义丢掉 0。
    pressureGate: boundedNumericSetting(value.pressureGate, NUMERIC_SETTINGS.pressure)
      ?? DEFAULT_SETTINGS.pressureGate,
  }
}

/**
 * Normalize the soft-protection budget.
 *
 * The budget is deliberately **outside** the preset snapshot: a preset is a
 * cooling-cost profile (retain/batch/auto/recall/restore), while the protection
 * budget belongs to the evidence-safety layer. Folding it into a preset would
 * let `/memory-lab preset` silently change how much evidence the plugin is
 * willing to hold, which is not what the user asked for.
 */
export function normalizeProtectionBudget(value) {
  return Number.isInteger(value) && value >= 0 && value <= 2_000_000
    ? value
    : DEFAULT_SETTINGS.protectBudgetTokens
}

/**
 * Normalize the full engine settings, including the fields `normalizeSettings`
 * deliberately leaves out of the preset snapshot.
 */
export function normalizeProtectionSettings(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  return {
    ...normalizeSettings(source),
    protectBudgetTokens: normalizeProtectionBudget(source.protectBudgetTokens),
  }
}

/** Normalize one user-defined preset; null when it has no usable id. */
export function normalizePresetEntry(raw) {
  const value = raw && typeof raw === 'object' ? raw : {}
  const id = String(value.id ?? '').trim()
  if (!id) return null
  const name = String(value.name ?? '').trim() || id
  // Config schema 与用户编辑都可能是「嵌套 settings」形态；平铺字段形态也兼容。
  const source = value.settings && typeof value.settings === 'object' ? value.settings : value
  return { id, name, settings: normalizeSettings(source) }
}

/** Normalize a preset list: drop unusable entries and duplicate ids, keep order. */
export function normalizePresets(raw) {
  if (!Array.isArray(raw)) return []
  const seen = new Set()
  const list = []
  for (const item of raw) {
    const entry = normalizePresetEntry(item)
    if (!entry || seen.has(entry.id)) continue
    seen.add(entry.id)
    list.push(entry)
  }
  return list
}

/** Words that switch a session back to the global-default preset when used as `/memory-lab preset <word>`. */
export const PRESET_RESET_WORDS = ['reset', '默认', '全局', 'global']

/** Find a preset by id or name; unique prefixes and unique substrings also count.
 * Order: exact id → exact name → unique prefix → unique substring. Null when ambiguous or absent. */
export function resolvePreset(presets, query) {
  const text = String(query ?? '').trim().toLowerCase()
  if (!text) return null
  const list = Array.isArray(presets) ? presets : []
  const exact = list.find((entry) => entry.id.toLowerCase() === text)
  if (exact) return exact
  const byName = list.find((entry) => entry.name.toLowerCase() === text)
  if (byName) return byName
  const byPrefix = list.filter((entry) => entry.id.toLowerCase().startsWith(text) || entry.name.toLowerCase().startsWith(text))
  if (byPrefix.length === 1) return byPrefix[0]
  const bySubstring = list.filter((entry) => entry.id.toLowerCase().includes(text) || entry.name.toLowerCase().includes(text))
  if (bySubstring.length === 1) return bySubstring[0]
  return null
}

function applySettingsSnapshot(state, settings) {
  const normalized = normalizeSettings(settings)
  state.retainOperations = normalized.retainOperations
  state.retainReads = normalized.retainReads
  state.archiveBatchSize = normalized.archiveBatchSize
  state.auto = normalized.auto
  state.autoRecall = normalized.autoRecall
  state.autoRestore = normalized.autoRestore
}

/**
 * Apply one `/memory-lab ...` input line to a settings-shaped state object.
 *
 * This is the single parser shared by the command handler and the session
 * projection: the projection folds `command/run` records, so the settings it
 * publishes are reconstructed from the session log itself rather than from
 * plugin memory. That is what makes a resumed or forked session correct.
 *
 * The optional `context` carries the plugin configuration (`presets` and
 * `defaults`); when absent, the built-in presets and defaults are used. The
 * projection and the command handler must always pass the same context, or a
 * preset applied at runtime would fold differently on resume.
 *
 * @param state - the folded state to update in place.
 * @param rawInput - the command's raw input, exactly as `command/run` recorded it.
 * @param context - optional `{ presets, defaults }` from the plugin config.
 * @returns true when the line changed the state.
 */
export function foldCommandIntoState(state, rawInput, context = null) {
  const { operation, remainder } = parseOperation(rawInput)
  if (operation === 'on') {
    if (state.enabled === true) return false
    state.enabled = true
    return true
  }
  if (operation === 'off') {
    if (state.enabled === false) return false
    state.enabled = false
    return true
  }
  if (operation === 'preset') {
    const query = remainder.trim()
    if (!query) return false
    const isReset = PRESET_RESET_WORDS.includes(query.toLowerCase()) || query === '默认' || query === '全局'
    const entry = isReset ? null : resolvePreset(normalizePresets(context?.presets ?? BUILTIN_PRESETS), query)
    // A preset that no longer exists keeps the current settings: the command
    // still reads as if it ran, and folding it must not silently reseed values.
    if (!isReset && !entry) return false
    const settings = normalizeSettings(entry ? entry.settings : context?.defaults)
    applySettingsSnapshot(state, settings)
    state.presetId = entry ? entry.id : ''
    state.presetLabel = entry ? entry.name : GLOBAL_PRESET_LABEL
    state.presetBaseline = settings
    return true
  }
  if (operation !== 'set') return false
  const [name = '', ...rest] = remainder.split(/\s+/).filter(Boolean)
  const value = rest.join(' ')
  const numeric = NUMERIC_SETTINGS[name]
  if (numeric) {
    try {
      const parsed = parseNumericSetting(value, numeric)
      if (state[numeric.key] === parsed) return false
      state[numeric.key] = parsed
      return true
    } catch {
      return false
    }
  }
  const boolean = BOOLEAN_SETTINGS[name]
  if (boolean) {
    const next = value === 'on' ? true : value === 'off' ? false : null
    if (next === null || state[boolean.key] === next) return false
    state[boolean.key] = next
    return true
  }
  return false
}

/** Build the initial folded projection state. */
export function initialProjectionState() {
  return {
    enabled: false,
    ...normalizeSettings({}),
    // 保护预算不进预设快照（见 DEFAULT_SETTINGS 注释），只随命令与配置默认值变化。
    protectBudgetTokens: DEFAULT_SETTINGS.protectBudgetTokens,
    // 全历史与计划先行是开关位，不进 normalizeSettings/预设快照：它们由
    // BOOLEAN_SETTINGS 的 set 命令折叠，初始值恒为 false（配置默认值由面板
    // 在无命令记录时叠加显示）。
    fullHistory: false,
    planFirst: false,
    // v2 层级压缩与模型模式：同上，折叠位初始恒 false（层级压缩默认关是拍板决策）。
    hierarchyCompress: false,
    compressModel: false,
    // T1/F-03：默认不共享正文摘录（失败关闭：没开就不复制正文）。
    shareL2Content: false,
    presetId: '',
    presetLabel: GLOBAL_PRESET_LABEL,
    presetBaseline: null,
    archived: 0,
    restored: 0,
    revision: 0,
  }
}

/**
 * True when one `user/message` event is one of this plugin's program-injected
 * surface messages: v1/v2 归档回执、卡组折叠回执、聚合凭证。
 *
 * 0.12.0 P1-2：判定收进一个函数，标记常量单一出处（{@link SURFACE_INJECTION_MARKERS}）。
 * 修复前只认前两种，于是**没有 `source.form` 的旧折叠回执**仍被「最新人类请求」
 * 选中——实测 8 张工作卡锚到折叠回执 seq。折叠回执与聚合凭证同样是程序生成的，
 * 把它们读成人类请求会把整轮任务陈述替换掉。
 */
export function isReceiptMessage(message) {
  if (!message || typeof message !== 'object') return false
  const blocks = message.content
  if (!Array.isArray(blocks) || blocks.length === 0) return false
  const first = blocks[0]
  if (!first || first.type !== 'text' || typeof first.text !== 'string') return false
  return isSurfaceInjectionText(first.text)
}
