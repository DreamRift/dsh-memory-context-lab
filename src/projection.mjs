/**
 * The `memoryContextLab` session projection.
 *
 * This is the whole reason the plugin survives resume, fork, and HMR: the
 * settings the composer panel shows, and the count of archived operations, are
 * folded from the session log itself — never from plugin memory. The command
 * executor already records every `/memory-lab ...` line as a log-only
 * `command/run`, so folding those records reconstructs the user's intent, and
 * folding surface replacements reconstructs what is currently archived.
 *
 * `apply` is pure and synchronous and returns the same reference for events it
 * ignores, so unchanged state costs nothing downstream. It never throws: a
 * malformed event must not be able to blank a client slot.
 *
 * The projection is built through {@link createMemoryContextLabProjection} with
 * the plugin configuration as context, so `preset` commands fold against the
 * same preset list the command handler resolved them against. The exported
 * `memoryContextLabProjection` keeps the no-context shape for tests and for a
 * host that registers the projection before configuration is available.
 */

import { DEFAULT_SETTINGS, foldCommandIntoState, GLOBAL_PRESET_LABEL, initialProjectionState, isReceiptMessage, parseOperation } from './core.mjs'
import { STATE_RECORD_TYPE, stateRecordOf } from './authoritative-state.mjs'

/** Surface event types that can carry a `surfaceOp`. */
const SURFACE_TYPES = new Set(['system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result'])

/**
 * Command names whose runs this projection folds.
 *
 * `memory-lab` is the v1 engine, `memory-lab2` the v2 engine. Both write their
 * settings into the same fold shape, so the panel keeps working across an
 * engine switch; `engine` in the view records which one is currently enabled.
 */
const COMMAND_ENGINE = new Map([['memory-lab', 'v1'], ['memory-lab2', 'v2']])

/** The projection registry only requires a `.parse`; values are already plain JSON. */
export const PASSTHROUGH_SCHEMA = Object.freeze({ parse: (value) => value })

/**
 * Resolve the fold context to plain values (BUG-009).
 *
 * The plugin registers the projection with lazy getters so a settings-page edit
 * is reflected on the next replay without a manual sync. `foldCommandIntoState`
 * reads value fields (`context.presets` / `context.defaults`), so passing the
 * getter object straight through made every preset fold fall back to the
 * built-in list — the panel and the command handler could disagree after
 * resume/fork. Resolve here, at every fold, keeping that freshness contract.
 */
function resolvedFoldContext(context) {
  if (!context || typeof context !== 'object') return context
  let presets = context.presets
  let defaults = context.defaults
  try {
    if (typeof context.getPresets === 'function') presets = context.getPresets()
  } catch {
    // 配置读取失败时保持原值（fold 仍用内置预设，不让投影抛错）。
  }
  try {
    if (typeof context.getDefaults === 'function') defaults = context.getDefaults()
  } catch {
    // 同上。
  }
  return presets === context.presets && defaults === context.defaults
    ? context
    : { ...context, presets, defaults }
}

/** Build the initial fold state, including the receipt bookkeeping. */
export function initProjectionState() {
  return { ...initialProjectionState(), receiptSeqs: [] }
}

/**
 * The preset slice of the client view.
 *
 * `presetId` is empty for the global default; `modified` is true when a later
 * `set` moved a value away from the preset's own baseline. Old fold states that
 * predate presets read as the global default, which is exactly what they were.
 */
function presetViewOf(state) {
  const label = typeof state.presetLabel === 'string' && state.presetLabel ? state.presetLabel : GLOBAL_PRESET_LABEL
  const id = typeof state.presetId === 'string' ? state.presetId : ''
  const baseline = state.presetBaseline && typeof state.presetBaseline === 'object' ? state.presetBaseline : null
  const modified = baseline !== null && (
    state.retainOperations !== baseline.retainOperations
    || state.archiveBatchSize !== baseline.archiveBatchSize
    || (state.auto === true) !== (baseline.auto === true)
    || (state.autoRecall === true) !== (baseline.autoRecall === true)
    || (state.autoRestore !== false) !== (baseline.autoRestore !== false)
  )
  return { id, label, modified }
}

/** The client-visible view. Plain JSON, no functions, no undefined. */
export function viewOf(state) {
  const retain = state.retainOperations
  const batch = state.archiveBatchSize
  // 0.13.1 修复（A2）：压力闸门是会话设置的一部分，视图必须带上它。
  // 缺失时面板读到的永远是 undefined → `pressureOn` 恒为 false → 开关画成「关」、
  // 阈值框永远 disabled、状态行永远「未启用」，而命令其实已经写出去了：
  // 用户看到的就是「点了没反应」。范围与 core 的 NUMERIC_SETTINGS.pressure 同域（0..95）。
  const pressure = Number.isInteger(state.pressureGate)
    && state.pressureGate >= 0 && state.pressureGate <= 95
    ? state.pressureGate
    : DEFAULT_SETTINGS.pressureGate
  return {
    enabled: state.enabled === true,
    retainOperations: Number.isInteger(retain) && retain >= 0 && retain <= 200 ? retain : 0,
    // 兜底默认与 core 的 DEFAULT_SETTINGS 同源：批阈值的默认是 10（C2），面板
    // 折叠态不该再显示旧默认 5。
    archiveBatchSize: Number.isInteger(batch) && batch >= 1 && batch <= 200 ? batch : DEFAULT_SETTINGS.archiveBatchSize,
    // 0.13.1：0 = 无压力也降温（旧行为），>0 = 达到该占用率才归档。
    pressureGate: pressure,
    auto: state.auto === true,
    autoRecall: state.autoRecall === true,
    autoRestore: state.autoRestore !== false,
    preset: presetViewOf(state),
    engine: state.engine === 'v1' || state.engine === 'v2' ? state.engine : '',
    fullHistory: state.fullHistory === true,
    planFirst: state.planFirst === true,
    planActive: state.planActive === true,
    // v2 层级压缩与模型模式（P4）：面板开关位。v1 会话恒为 false（状态里没有
    // 这两个键），面板也只在 v2 下渲染模型模式行。
    hierarchyCompress: state.hierarchyCompress === true,
    compressModel: state.compressModel === true,
    // T1/F-03：默认关；只有显式开过才为真（失败关闭）。
    shareL2Content: state.shareL2Content === true,
    archived: Array.isArray(state.receiptSeqs) ? state.receiptSeqs.length : 0,
    restored: Number.isInteger(state.restored) && state.restored >= 0 ? state.restored : 0,
    revision: Number.isInteger(state.revision) && state.revision >= 0 ? state.revision : 0,
  }
}

/**
 * Fold one committed session event into the projection state.
 *
 * @param state - the previous state.
 * @param event - one committed session event.
 * @param context - optional `{ presets, defaults }` for `preset` folding.
 * @returns the next state, or the same reference when nothing changed.
 */
export function applyEvent(state, event, context = null) {
  if (!event || typeof event !== 'object') return state

  // 权威状态记录（P0-3）：插件在每条状态类命令结束后追加，值取自当时的真实
  // 状态。它排在 command/run 之后，天然后写覆盖前写——命令被拒绝时它写的是
  // 「仍然开着」，面板因此不会显示成已生效。重放（resume/fork）同样生效。
  if (event.type === STATE_RECORD_TYPE) {
    const record = stateRecordOf(event, { requireFromPlugin: resolvedFoldContext(context)?.requireFromPlugin })
    if (!record) return state
    const next = { ...state, ...record }
    // 设置类字段落在 settings 里，与 normalizeSettings 的形状一致。
    const settings = { ...(state.settings ?? {}) }
    let settingsChanged = false
    for (const key of ['auto', 'autoRecall', 'autoRestore']) {
      if (!(key in record) || settings[key] === record[key]) continue
      settings[key] = record[key]
      settingsChanged = true
    }
    if (settingsChanged) next.settings = settings
    next.revision = (state.revision ?? 0) + 1
    return next
  }

  if (event.type === 'command/run') {
    const engine = COMMAND_ENGINE.get(event.data?.name)
    if (engine === undefined) return state
    const next = { ...state }
    if (next.presetId === undefined) next.presetId = ''
    if (next.presetLabel === undefined) next.presetLabel = GLOBAL_PRESET_LABEL
    const args = event.data?.args ?? ''
    const { operation } = parseOperation(args)
    // `on`/`off` also record which engine now owns the projection, so a session
    // that switches engines does not leave a stale panel label behind. The v1
    // fold shape itself is unchanged.
    const engineAfter = operation === 'on' ? engine : operation === 'off' ? '' : null
    const engineChanged = engineAfter !== null && (next.engine ?? '') !== engineAfter
    if (engineChanged) next.engine = engineAfter
    // B1 修复：v2 停用即全历史模式失效。`memory-lab2 off` 的折叠同时清掉
    // fullHistory 残留位，否则 v2 停用后面板开关仍显示「已启用」，而关闭分支
    // 按 enabled/engine 分流一条命令都发不出（投影停在
    // {enabled:false, engine:'', fullHistory:true} 的实测形态）。v1 的 off 不动
    // 该位：v1 停用与 v2 的全历史开关无关。
    const fullHistoryCleared = engine === 'v2' && operation === 'off' && next.fullHistory === true
    if (fullHistoryCleared) next.fullHistory = false
    // BUG-009：每次折叠都重新取值（getter 形态也解包），保证 resume/fork 重放
    // 与命令执行读的是同一份预设/默认值。
    if (!foldCommandIntoState(next, args, resolvedFoldContext(context)) && !engineChanged && !fullHistoryCleared) return state
    next.revision = (state.revision ?? 0) + 1
    return next
  }

  // 宿主计划模式日志事件：面板状态行显示「计划模式进行中」并解释挂起原因。
  // 只读状态，不参与任何裁决；事件缺失（宿主未装计划模式）时恒为 false。
  if (event.type === 'plan/mode') {
    const active = event.data?.active === true
    if ((state.planActive === true) === active) return state
    const next = { ...state, planActive: active }
    next.revision = (state.revision ?? 0) + 1
    return next
  }

  if (!SURFACE_TYPES.has(event.type) || event.surfaceOp === undefined) return state

  const shadowed = event.surfaceOp === 'append'
    ? null
    : new Set(Array.isArray(event.sourceEventSeqs) ? event.sourceEventSeqs : [])
  const isReceipt = event.type === 'user/message' && isReceiptMessage(event.data)
  const seqs = Array.isArray(state.receiptSeqs) ? state.receiptSeqs : []
  const replacedReceipt = shadowed !== null && seqs.some((seq) => shadowed.has(seq))

  // A replacement that shadows no receipt and is not itself a receipt is not
  // ours: compaction and the runtime-context snapshot replace spans too.
  if (!replacedReceipt && !isReceipt) return state

  let receiptSeqs = seqs
  let restored = Number.isInteger(state.restored) && state.restored >= 0 ? state.restored : 0
  if (replacedReceipt) {
    receiptSeqs = receiptSeqs.filter((seq) => !shadowed.has(seq))
    // Replacing a receipt with something else is exactly what `restore` does.
    if (!isReceipt) restored += 1
  }
  // Only a replacement makes a receipt an archive action. A receipt that merely
  // appended never shadowed an operation, so counting it would overstate what
  // the plugin has actually cooled.
  if (isReceipt && shadowed !== null) {
    if (receiptSeqs.includes(event.seq)) return state
    receiptSeqs = [...receiptSeqs, event.seq]
  }

  return {
    ...state,
    receiptSeqs,
    archived: receiptSeqs.length,
    restored,
    revision: (state.revision ?? 0) + 1,
  }
}

/** Assemble the registry definition; `context` feeds `preset` folding. */
export function createMemoryContextLabProjection(context = null) {
  return {
    key: 'memoryContextLab',
    // v2: init may now seed `planFirst` from `context.planFirstDefault` (plugin
    // config), so the folded bit starts enabled in brand-new sessions without a
    // per-session `set planfirst on`. Existing caches folded under v1 do not
    // carry that seeding, hence the bump.
    stateVersion: 2,
    stateSchema: PASSTHROUGH_SCHEMA,
    init: () => {
      const state = initProjectionState()
      // 接受布尔或返回布尔的惰性函数：注册期拿不到配置的宿主可以传函数，
      // 在每次重放 init 时求值；函数抛错按未开启处理，不让配置页杀死投影。
      let seed = context?.planFirstDefault
      if (typeof seed === 'function') {
        try { seed = seed() } catch { seed = false }
      }
      return seed === true ? { ...state, planFirst: true } : state
    },
    apply: (state, event) => applyEvent(state, event, context),
    wire: { viewSchema: PASSTHROUGH_SCHEMA, view: viewOf },
  }
}

/** The registry definition, ready for `ctx.sessionProjections.register(...)`. */
export const memoryContextLabProjection = createMemoryContextLabProjection(null)