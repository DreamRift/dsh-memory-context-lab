import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { existsSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  archiveNodeId,
  BOOLEAN_SETTINGS,
  BUILTIN_PRESETS,
  COMMAND_NAME,
  DEFAULT_SETTINGS,
  escapePromptBraces,
  foldCommandIntoState,
  formatPresetValue,
  formatRatio,
  GLOBAL_PRESET_LABEL,
  initialProjectionState,
  MAX_RECALL_QUERY_CHARS,
  normalizePresets,
  normalizeSettings,
  NUMERIC_SETTINGS,
  PACKAGE_NAME,
  parseNumericSetting,
  parseOperation,
  PLUGIN_SOURCE_FORMS,
  PRESET_RESET_WORDS,
  renderRecallBlock,
  resolvePreset,
  restoreGrowth,
  SettingsError,
} from './core.mjs'
import { cleanDecision, recallQueryFrom } from './apply.mjs'
import { createEngine, restoreSkippedReceipts } from './apply-engine.mjs'
import { createMemoryContextLabProjection } from './projection.mjs'
import { assertV2AllowsV1, getEngineRegistry } from './v2/engine.mjs'
import { EngineV2Error } from './v2/errors.mjs'
import { createV2Runtime, V2_COMMAND_NAME } from './v2/runtime.mjs'
import { createV2ClientFactory } from './v2/client-adapter.mjs'
import { v2SessionDirectoryFor } from './v2/store.mjs'
import { createCompositeRetrievalBackendProvider } from './v2/retrieval-backend-provider.mjs'
import { createPlanFirst } from './plan-first.mjs'
import { createV2RecallTool } from './v2/tool.mjs'
import {
  globalSuppressionCoordinator,
  locatePinnedDshMemory,
} from './dsh-memory-suppression.mjs'
import {
  createSessionState,
  labRootFor,
  readSessionState,
  removeSessionDirectory,
  SessionStateDamagedError,
  writeSessionState,
} from './storage.mjs'

export const name = 'memory-context-lab'
// 只硬依赖 v1 已在用的两个服务。`tools` 故意**不**放进 inject：它是 agent/preset
// 作用域提供的服务，而本插件挂在 profile 作用域；写成硬依赖会让整个插件（含正在
// 工作的 v1）在拿不到该服务时加载失败。改为反应式注入 ctx.inject(['tools'], …)，
// 拿不到就跳过工具注册并告警。
export const inject = ['commands', 'sessionProjections']

const requireFromPlugin = createRequire(import.meta.url)

/**
 * Load the vendored schemastery fork for the settings-page schema.
 *
 * The copy lives in this plugin's `node_modules` (same pattern the web-search
 * pool plugin uses). Under the installed profile junction the bare specifier
 * cannot be resolved — Node walks `.dsh/profiles/desktop/node_modules` upward,
 * which has no `@deepseek-ai` — so also try the realpath of this module (the
 * junction target's own `node_modules`). When it cannot be loaded the plugin
 * still works: `Config` stays undefined, the loader does not serve a settings
 * namespace, and only the global-defaults / preset editor is absent — commands
 * keep running.
 */
function loadSchemastery() {
  const candidates = []
  try {
    candidates.push(requireFromPlugin('@deepseek-ai/schemastery'))
  } catch {}
  try {
    candidates.push(requireFromPlugin(realpathSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', '@deepseek-ai', 'schemastery'))))
  } catch {}
  for (const candidate of candidates) {
    try {
      const mod = candidate?.default?.object ? candidate.default : candidate
      if (typeof mod?.object === 'function') return mod
    } catch {}
  }
  return null
}

/**
 * Load the vendored cosmokit fork for the shared volatile-reference protocol.
 *
 * Mirrors `loadSchemastery()`: tries the bare specifier first, then the
 * realpath of this module's vendored copy. The loaded copy only needs to
 * recognise the shared protocol symbol (`Symbol.for`), so a version skew with
 * the host's own cosmokit is harmless — the protocol is defined cross-copy.
 */
function loadCosmokit() {
  const candidates = []
  try {
    candidates.push(requireFromPlugin('@deepseek-ai/cosmokit'))
  } catch {}
  try {
    candidates.push(requireFromPlugin(realpathSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', '@deepseek-ai', 'cosmokit'))))
  } catch {}
  for (const candidate of candidates) {
    try {
      const mod = candidate?.default?.isVolatile ? candidate.default : candidate
      if (typeof mod?.isVolatile === 'function' && typeof mod?.createVolatile === 'function') return mod
    } catch {}
  }
  return null
}

const SCHEMAS = loadSchemastery()
const KIT = loadCosmokit()

/**
 * Normalize a config field value the host may hand over as a volatile
 * reference (a frozen `{ get(), [Symbol.for("cosmokit.volatile.write")] }`).
 * Hosts wrap volatile schema fields this way on startup, so every read of
 * such a field goes through this helper; plain values pass through.
 */
function unwrapVolatile(value) {
  return KIT?.isVolatile(value) ? value.get() : value
}

/** Wrap fresh rows in the shared volatile protocol when cosmokit is present. */
function asVolatile(value) {
  return KIT ? KIT.createVolatile(value) : value
}

/** One flattened preset row as stored in the plugin config and edited on the settings page. */
function presetToConfigRow(preset) {
  return Object.freeze({
    id: preset.id,
    name: preset.name,
    retainOperations: preset.settings.retainOperations,
    archiveBatchSize: preset.settings.archiveBatchSize,
    auto: preset.settings.auto,
    autoRecall: preset.settings.autoRecall,
    autoRestore: preset.settings.autoRestore,
  })
}

/** The plugin-shipped presets double as the schema default for fresh installs. */
const SHIPPED_PRESET_ROWS = BUILTIN_PRESETS.map(presetToConfigRow)

function buildConfigSchema() {
  if (!SCHEMAS) return undefined
  const settingFields = {
    retainOperations: SCHEMAS.natural().max(200).default(5)
      .i18n({ 'zh-CN': '保留最近操作数', en: 'Retained recent operations' }),
    archiveBatchSize: SCHEMAS.natural().max(200).default(DEFAULT_SETTINGS.archiveBatchSize)
      .i18n({ 'zh-CN': '归档批量阈值', en: 'Archive batch size' }),
    auto: SCHEMAS.boolean().default(true)
      .i18n({ 'zh-CN': '自动降温', en: 'Auto cooling' }),
    autoRecall: SCHEMAS.boolean().default(true)
      .i18n({ 'zh-CN': '命中回注', en: 'Recall on hit' }),
    autoRestore: SCHEMAS.boolean().default(true)
      .i18n({ 'zh-CN': '停用时恢复原文', en: 'Restore originals on disable' }),
  }
  return SCHEMAS.object({
    defaults: SCHEMAS.object({
      ...settingFields,
      // 保护预算只存在于全局默认：它不是「一组可切换的降温档位」的一部分，
      // 预设行保持原有形状，避免把保护策略伪装成模式开关。
      protectBudgetTokens: SCHEMAS.natural().max(2000000).default(32768)
        .i18n({ 'zh-CN': '软保护预算（估算 token）', en: 'Soft protection budget (estimated tokens)' }),
      // 插件级开关的全局默认：只在「无会话内命令记录」时作为面板初始位置与
      // v2 新账本播种值，不进预设行（同保护预算的理由）。
      fullHistory: SCHEMAS.boolean().default(false)
        .i18n({ 'zh-CN': '全历史记忆上下文（v2）', en: 'Full-history memory context (v2)' }),
      planFirst: SCHEMAS.boolean().default(false)
        .i18n({ 'zh-CN': '新会话计划先行', en: 'Plan first in new sessions' }),
      // 检索后端显式指定（PR #4 接口设计 §端口二）：auto = 现状自动梯队（T2 优先、
      // 失败降级 T1 带原因）；local-lexical-v1 = 不尝试 T2；lingshu-mdcg-receipt =
      // 强制 T2，不可用即失败关闭（EBACKENDUNAVAILABLE/EBACKENDPINGFAIL），不静默降级。
      // schemastery 没有 .enum()，字符串枚举用 union(const(...))。
      retrievalBackend: SCHEMAS.union([
        SCHEMAS.const('auto'),
        SCHEMAS.const('local-lexical-v1'),
        SCHEMAS.const('lingshu-mdcg-receipt'),
      ]).default('auto')
        .i18n({ 'zh-CN': '检索后端选择', en: 'Retrieval backend' }),
    })
      // Volatile fields never leave the root config object; the host stores a
      // detached reference instead of inlining rows, so preset rows are not
      // frozen into the persisted defaults when one session mutates them.
      .volatile()
      .i18n({ 'zh-CN': '全局默认设置', en: 'Global defaults' }),
    presets: SCHEMAS.array(
      SCHEMAS.object({
        id: SCHEMAS.string().required().i18n({ 'zh-CN': '稳定标识', en: 'Stable id' }),
        name: SCHEMAS.string().required().i18n({ 'zh-CN': '预设名称', en: 'Preset name' }),
        ...settingFields,
      }),
    ).default(SHIPPED_PRESET_ROWS)
      .volatile()
      .i18n({ 'zh-CN': '预设（可新增、改名、编辑；切换在对话框的「降温」面板里）', en: 'Presets (add, rename, edit; switch them in the cooling panel)' }),
  })
}

export const Config = buildConfigSchema()

/**
 * Probe the running host's own package version instead of assuming one.
 *
 * `@deepseek-ai/dsh-session` is resolved from the same install that loaded this
 * plugin, so the recorded value is the host that actually accepted the
 * replacement. A failed probe is reported as `unknown`, never guessed.
 */
function probeHostVersion() {
  try {
    return String(requireFromPlugin('@deepseek-ai/dsh-session/package.json')?.version ?? 'unknown')
  } catch {
    return 'unknown'
  }
}

const HOST_VERSION = probeHostVersion()

const HELP = [
  '上下文降温（仅当前会话）：把已执行完的操作沉入隔离冷库，减少上下文占用。',
  '',
  '/memory-lab on                  在本会话启用降温（同时抑制真实灵枢对本会话的自动读写）。',
  '/memory-lab off                 停用降温并让本会话回到正常：恢复原文、清除隔离数据。',
  '/memory-lab status              查看保留量、批量阈值、归档数、占用率与前缀缓存命中。',
  '/memory-lab set retain 10       保留最近 N 个操作原文；更旧的攒够批量阈值就归档（唯一触发线）。',
  '/memory-lab set batch 10        保留窗口外攒够 N 个操作提交一批（越大越省缓存重算，上下文留得越多）。',
  '/memory-lab set auto on|off     自动降温开关（默认开）。',
  '/memory-lab set recall on|off   命中回注开关（默认开）。',
  '/memory-lab set autorestore on|off  停用时是否恢复原文并清数据（默认开）。',
  '/memory-lab set protect 32768   软保护预算（估算 token）；超预算先释放最弱的软保留，硬保护不动。',
  '/memory-lab preset              查看全局预设与可用预设列表。',
  '/memory-lab preset <名称>|reset 应用整组预设；reset 回到全局预设。新增/改名/编辑在设置页。',
  '/memory-lab now                 立即测量并按当前规则归档一批。',
  '/memory-lab dry-run             只做估算与候选选择，零副作用；并解释每段为何保留、为何可归档。',
  '/memory-lab restore             把与回执一致且活动面稳定的操作恢复为原文。',
  '/memory-lab clean               删除本会话的隔离数据（有未恢复回执时会拒绝）。',
  '/memory-lab pin <seq>           显式保护某个操作，使它不因超过保留窗口而退出（可重复）。',
  '/memory-lab unpin <seq>         解除该显式保护。',
  '/memory-lab protect             查看活跃证据保护集：来源、原因、建立序号、解除条件与成本。',
  '',
  '归档单位是「一次完整操作」：助手的工具调用（含参数）加对应的工具结果，整体换成一条回执。',
  '**保留最近 N 个操作是唯一触发线**：不管占用率多少，更旧的操作攒够批量阈值就归档。',
  '**可归档 = 结构与冷存检查通过 ∧ 不在保留窗口 ∧ 无未闭合调用／在途依赖 ∧ 已可靠曝光 ∧ 不是当前仍需保留的证据 ∧ 满足批量阈值。**',
  '硬保护来自真实结构与宿主状态（未返回的调用、未曝光结果、待确认副作用、运行中的后台 job、系统／人类约束），',
  '不因超过 N 个操作而失效；软保留（召回刚读回、任务关联线索）受预算约束，到期即释放。',
  '路径相同只能作为关联线索，不能证明语义依赖或版本相同——插件不假装能自动理解任务关系。',
  '上下文上限由宿主的自动压缩兜底，插件不再自己看护占用率（历史上从未触发，宿主压缩也从未触发）。',
  '批量阈值是成本杠杆：每提交一批就会让替换点之后的上下文按未命中价重算一次，批次数越多代价越大，',
  '所以攒几个再提交比来一个归档一个便宜得多。',
  '模型可见的工具集永不改变——工具定义在请求前缀里，增删工具会作废整段前缀缓存。',
  '自动回注只追加在进入步骤的消息批次尾部，每条用户消息最多一次，因此不影响前缀命中。',
].join('\n')

function combineSignals(...signals) {
  const active = signals.filter(Boolean)
  if (!active.length) return undefined
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(active)
  const controller = new AbortController()
  const abort = (signal) => controller.abort(signal.reason)
  for (const signal of active) {
    if (signal.aborted) {
      abort(signal)
      break
    }
    signal.addEventListener('abort', () => abort(signal), { once: true })
  }
  return controller.signal
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('操作已取消。')
}

function sessionIdOf(session) {
  const raw = session?.id
  if (typeof raw !== 'string' || !raw.trim()) throw new Error('DSH 未提供当前会话标识，已拒绝启用降温。')
  return raw.trim()
}

/**
 * Fold this session's own `/memory-lab …` records into a settings object.
 *
 * The session log is the authority for settings, not the durable state file.
 * The panel renders the folded values (the projection folds the same records),
 * so anything else lets the panel show one target while the engine enforces
 * another. That is exactly how a session could display 40% and still cool
 * against the 60% default: `set target 0.4` was recorded before `on`, so it
 * reached the projection but never the state file the engine read.
 *
 * Every record is folded, including `set` lines that predate the enable, because
 * that is precisely what the projection does — the two must agree.
 *
 * @returns a normalized settings object, or null when the log holds no
 *   `/memory-lab` record at all or cannot be read. Null means "no opinion": the
 *   caller must then keep the durable settings, since folding an empty log would
 *   silently reset a stored configuration back to the defaults.
 */
function settingsFromSessionLog(session, context = null) {
  let events
  try {
    // `snapshotEvents()` covers inherited (resumed/forked) records too, which is
    // what makes a restored session behave like a continued one; `ownEvents()`
    // alone would forget every setting recorded before this process started.
    events = typeof session?.snapshotEvents === 'function'
      ? session.snapshotEvents()
      : session?.ownEvents?.()
  } catch {
    return null
  }
  if (!Array.isArray(events)) return null
  const state = initialProjectionState()
  let seen = 0
  for (const event of events) {
    if (event?.type !== 'command/run') continue
    const data = event.data ?? {}
    if (data.name !== COMMAND_NAME) continue
    seen += 1
    foldCommandIntoState(state, typeof data.args === 'string' ? data.args : '', context)
  }
  return seen > 0 ? normalizeSettings(state) : null
}

export async function apply(ctx, config) {
  const labRoot = labRootFor()
  const records = new Map()
  const absent = new Set()
  /** C-11: sessions whose durable state exists but cannot be trusted. */
  const damagedSessions = new Map()
  /**
   * Damage notice for a session whose state file exists but is unreadable
   * (C-11). Returns null when the session is not damaged. The notice never
   * says "never enabled" and never purges anything; only the explicit
   * `clean confirm delete-session` may drop the cold store.
   */
  function damagedNotice(sessionId) {
    const damaged = damagedSessions.get(sessionId)
    if (!damaged) return null
    return {
      kind: 'error',
      text: `本会话的降温状态文件损坏（${damaged.reason}）。`
        + '插件已停止干预：不会归档、恢复或清理该会话，冷库数据原样保留。'
        + '确认放弃原文后可删除冷库：/memory-lab clean confirm delete-session。',
    }
  }
  const activeOperations = new Set()

  /**
   * Global defaults from the plugin config (settings page), with the same
   * clamping `normalizeSettings` applies everywhere else. Volatile fields may
   * arrive as detached references the host stored outside the root config.
   */
  function resolveDefaultsSettings() {
    return normalizeSettings(unwrapVolatile(config?.defaults) ?? DEFAULT_SETTINGS)
  }

  /**
   * 设置页的全局默认「全历史记忆上下文」。v2 账本没有旧值时用它播种；
   * v1 引擎不消费它（v1 无全历史模式）。
   */
  function resolveFullHistoryDefault(configObject) {
    const defaults = unwrapVolatile(configObject?.defaults)
    return defaults?.fullHistory === true
  }

  /**
   * 设置页的全局默认「计划先行」。投影折叠的 planFirst 位没有旧值时以它
   * 为初值；会话内 `set planfirst` 的折叠结果仍然覆盖它（命令事件在 init
   * 之后重放）。v1/v2 引擎共用这一位。
   */
  function resolvePlanFirstDefault(configObject) {
    const defaults = unwrapVolatile(configObject?.defaults)
    return defaults?.planFirst === true
  }

  /**
   * User-managed presets from the plugin config. Shipped presets are only the
   * schema default for fresh installs; once the user edits the list the saved
   * value (even an empty one) wins.
   */
  function resolveGlobalPresets() {
    return normalizePresets(unwrapVolatile(config?.presets) ?? BUILTIN_PRESETS)
  }

  const buildFoldContext = () => ({ presets: resolveGlobalPresets(), defaults: resolveDefaultsSettings() })

  let dependencies
  try {
    const dshMemory = await locatePinnedDshMemory(requireFromPlugin)
    dependencies = {
      labRoot,
      lingshuPackageRoot: dshMemory.packageRoot,
      coordinator: globalSuppressionCoordinator(dshMemory.MdcgClient),
      startupError: null,
    }
  } catch (error) {
    ctx.logger.warn(`memory-context-lab: dsh-memory compatibility guard unavailable: ${error instanceof Error ? error.message : String(error)}`)
    dependencies = { labRoot, lingshuPackageRoot: '', coordinator: null, startupError: error }
  }

  /** Optional host-service lookup: never a hard dependency, so a missing one degrades instead of failing the load. */
  const services = { get: (service) => ctx.get(service) }

  // ── 检索后端提供者（设计文档 v1.2 §4；PR #4 后端显式指定）─────────────
  // retrievalBackend 配置：'auto'（默认）保持既有梯队——T2 灵枢（可选，
  // dsh-memory 在位且 mcp_server 握手成功）优先、失败降级 T1 本地词法；
  // 'local-lexical-v1' 不尝试 T2；'lingshu-mdcg-receipt' 强制 T2，
  // 显式指定不可用即失败关闭（EBACKENDUNAVAILABLE / EBACKENDPINGFAIL），
  // 绝不静默降级。独立运行的关键不变：缺 dsh-memory 时 auto 插件照常启用。
  const retrievalBackendMode = (() => {
    const raw = unwrapVolatile(ctx.config?.defaults)?.retrievalBackend
    return raw === 'local-lexical-v1' || raw === 'lingshu-mdcg-receipt' ? raw : 'auto'
  })()
  // lingshu-backend 动态加载（PR #4 依赖图约定）：主装配路径与 T2 实现解耦，
  // 模块加载失败走 startupError 失败关闭路径，不拖垮插件加载。
  let lingshuBackend = null
  try {
    const { createLingshuBackendProvider } = await import('./v2/lingshu-backend.mjs')
    lingshuBackend = createLingshuBackendProvider({
      lingshuPackageRoot: dependencies.lingshuPackageRoot,
      logger: ctx.logger,
    })
  } catch (error) {
    ctx.logger.warn(`memory-context-lab: lingshu-backend 动态加载失败：${error instanceof Error ? error.message : String(error)}`)
    lingshuBackend = null
  }
  const retrievalBackend = createCompositeRetrievalBackendProvider({
    lingshu: lingshuBackend,
    logger: ctx.logger,
    forcedMode: retrievalBackendMode,
  })

  /**
   * v1 引擎的本地客户端工厂（按会话缓存，句柄在 disposeRecord 释放）。
   *
   * v1 与 v2 的 client 契约同构（rememberArchived/getNode/recall），两个引擎
   * 共用同一实现与同一冷库格式：冷写与原文永远在本会话冷库，不依赖外部进程；
   * 检索走同一梯队（T0 字面 + T1 本地词法，灵枢可用时 T2）。
   */
  const v1ClientFactories = new Map()

  function localClientFactoryFor(sessionId) {
    let factory = v1ClientFactories.get(sessionId)
    if (!factory) {
      factory = createV2ClientFactory({
        labRoot,
        sessionId,
        logger: ctx.logger,
        backendFor: () => retrievalBackend.backendFor({
          sessionId,
          storeRoot: v2SessionDirectoryFor(labRoot, sessionId),
        }),
      })
      v1ClientFactories.set(sessionId, factory)
    }
    return factory
  }

  const engine = createEngine({
    persist,
    nodeIdFor: (record, ordinal) => archiveNodeId(record.state.key, ordinal),
    hostVersion: HOST_VERSION,
    services,
    logger: ctx.logger,
    createClient: async (record) => localClientFactoryFor(record.sessionId).createClient(),
  })

  /**
   * 旧冷库如实提示（0.9.0-rc.6，PR #3 复核补充）：
   * 0.9.0-rc.6 之前由灵枢子进程归档的 v1 冷库（`sessions/<键>/mdcg/`）是灵枢
   * contextual 节点格式；本地冷库客户端（v2 store）读不了这种节点。它在场且会话
   * 还有待恢复/已跳过回执时，`on`/`status`/`restore` 的输出必须指出：旧回执原文
   * 已读不回、数据不会被删除、回收磁盘走 `clean confirm delete-session`。否则
   * 等于让用户在不知情的情况下以为旧回执仍可恢复（诚实边界）。无需提示时返回 null。
   */
  function legacyColdStoreNote(record) {
    if (!record || !record.directory) return null
    try {
      if (!existsSync(join(record.directory, 'mdcg'))) return null
      if (engine.pendingReceipts(record).length === 0 && restoreSkippedReceipts(record).length === 0) return null
    } catch {
      return null
    }
    return '注意：本会话隔离根内存在旧版灵枢格式冷库（mdcg/）：若其中有旧回执仍未恢复，其原文已读不回（恢复会如实报「冷节点不可读」）。'
      + '这些数据仍在磁盘上、不会被删除；确认不再需要后，可用 /memory-lab clean confirm delete-session 放弃并回收。'
  }

  async function persist(record) {
    await writeSessionState(record.directory, record.state)
  }

  function makeRecord({ agent, sessionId, directory, state }) {
    let suppressionLease = null
    try {
      suppressionLease = dependencies.coordinator?.acquire(sessionId) ?? null
    } catch (error) {
      ctx.logger.warn(`memory-context-lab: suppression unavailable: ${error instanceof Error ? error.message : String(error)}`)
    }
    return {
      agent,
      sessionId,
      directory,
      state: { ...state, settings: normalizeSettings(state.settings) },
      suppressionLease,
      client: null,
      clientError: null,
      occupancy: null,
      occupancyError: null,
      recallQueryId: null,
      // 当前可见集合与历史注入记录分开：`recallDeliveries` 只在对应回注消息仍在
      // 活动面上时才算"证据仍可见"，退出后同一冷节点可再次读回。
      recallDeliveries: [],
      recallAttempts: [],
      lastRecall: null,
      lastAction: null,
    }
  }

  /**
   * Find the live record for a session, rebuilding it from durable state when
   * this process never saw the enable command.
   *
   * Nothing about a record lives only in memory: the durable state file holds
   * the receipt list, and the settings the panel shows are folded from the
   * session log's own `command/run` records. That is what makes a resumed
   * session behave exactly like a continued one.
   */
  async function adopt(agent) {
    let sessionId
    try {
      sessionId = sessionIdOf(agent?.session)
    } catch {
      return null
    }
    const existing = records.get(sessionId)
    if (existing) {
      existing.agent = agent
      return existing
    }
    if (absent.has(sessionId)) return null
    // C-11: a session whose state file is damaged is remembered as damaged —
    // never folded into `absent`. Status surfaces the damage; automatic hooks
    // skip the session (no archive, no restore, no clean-up) until a command
    // resolves the damage explicitly.
    const damaged = damagedSessions.get(sessionId)
    if (damaged) return null
    let found
    try {
      found = await readSessionState(labRoot, sessionId)
    } catch (error) {
      if (error instanceof SessionStateDamagedError) {
        damagedSessions.set(sessionId, {
          reason: error.reason,
          directory: error.directory,
          at: new Date().toISOString(),
        })
        ctx.logger.warn(`memory-context-lab: session state damaged (${sessionId}): ${error.reason}`)
        return null
      }
      ctx.logger.warn(`memory-context-lab: cannot read session state: ${error instanceof Error ? error.message : String(error)}`)
      absent.add(sessionId)
      return null
    }
    if (!found || found.state.enabled !== true) {
      absent.add(sessionId)
      return null
    }
    // The log outranks the durable file for settings: the panel folds the same
    // records, so adopting anything else would let the displayed target differ
    // from the one the engine actually enforces. Applied before the record is
    // built so the record cannot capture the stale file values.
    const folded = settingsFromSessionLog(agent?.session, buildFoldContext())
    if (folded) found.state.settings = folded
    const record = makeRecord({ agent, sessionId, directory: found.directory, state: found.state })
    records.set(sessionId, record)
    return record
  }

  /**
   * Adopt a session by id alone, for events that carry no `Agent` object.
   *
   * `workspace/session-stop` reports only a session id, so the live agent is
   * resolved through the host registry. When the agent is already gone there is
   * no surface left to restore into, so this returns null and the caller leaves
   * the data alone rather than deleting a cold store the receipts still point at.
   */
  async function adoptById(sessionId) {
    const agents = services.get('agents')
    const agent = typeof agents?.get === 'function' ? agents.get(sessionId) : null
    if (!agent) return null
    return adopt(agent)
  }

  /**
   * C-11: after an adopt that came back null, distinguish a genuinely absent
   * session from one whose durable state is damaged. Returns an error payload
   * when the session is damaged, null when it is simply not enabled.
   */
  function damagedNotice(sessionId) {
    const damaged = damagedSessions.get(sessionId)
    if (!damaged) return null
    return {
      kind: 'error',
      text: `会话状态文件损坏，降温已停止干预本会话（${damaged.reason}）。`
        + '冷库数据保留，未做任何恢复或清理。'
        + '要丢弃冷库（原文将无法恢复）：/memory-lab clean confirm delete-session。',
    }
  }

  async function disposeRecord(record) {
    let closeError
    try {
      await record.client?.close?.()
    } catch (error) {
      closeError = error
    }
    try { v1ClientFactories.get(record.sessionId)?.dispose?.() } catch { /* best-effort release */ }
    v1ClientFactories.delete(record.sessionId)
    try { record.suppressionLease?.release?.() } catch { /* best-effort unpatch */ }
    record.client = null
    record.suppressionLease = null
    if (closeError) throw closeError
  }

  /**
   * Put the archived originals back, stop cooling, and delete the isolated data.
   *
   * This is what "return the session to normal" means: the receipts in the log
   * are replaced by the originals they stood for, so nothing in the session
   * depends on the cold store any more and the store can be removed. Shared by
   * `/memory-lab off` and the archive hook.
   *
   * @param guardWindow - refuse the restore when it would push the surface past
   *   the model window. A live session keeps taking requests, so an oversized
   *   restore would break the very next one; an archived session takes no more
   *   requests, so the same restore is harmless there.
   */
  async function normalizeAndStop(record, signal, { guardWindow }) {
    const settings = engine.settingsOf(record)
    const before = engine.pendingReceipts(record).length
    const restoredBefore = record.state.archive.filter((row) => row.status === 'restored').length
    let refused = null

    if (before > 0 && settings.autoRestore) {
      if (guardWindow) {
        const pending = engine.pendingReceipts(record)
        try {
          const occupancy = await engine.measureOccupancy(record, signal)
          const growth = restoreGrowth(pending, {
            assembledTokens: occupancy.host.assembledTokens,
            contextWindow: occupancy.host.contextWindow,
          })
          if (growth.overflow) {
            refused = {
              total: growth.total,
              heldByReceipts: growth.heldByReceipts,
              assembled: occupancy.host.assembledTokens,
              window: occupancy.host.contextWindow,
            }
          }
        } catch (error) {
          // No measurement, no guard: restoring is what the user asked for, and
          // an unmeasured refusal would silently keep the data forever.
          ctx.logger.warn(`memory-context-lab: restore guard unavailable: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      if (!refused) {
        try {
          await engine.runRestore(record)
        } catch (error) {
          ctx.logger.warn(`memory-context-lab: restore on stop failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }

    const restored = record.state.archive.filter((row) => row.status === 'restored').length - restoredBefore
    // B3：冷依赖 = pending（applied/verify-failed，原文只在冷库）+ restore-skipped
    // （restore 尝试失败、原文**仍只在冷库**的行）。restoreAll 把失败行改写为
    // `restore-skipped: <原因>` 后就脱离 pendingReceipts，若只看 pending 会把
    // 「remaining=0」误判成「无回执依赖冷库」而删掉原文唯一副本（issue #2）。
    const pending = engine.pendingReceipts(record).length
    const remaining = pending + restoreSkippedReceipts(record).length
    record.state.enabled = false
    await persist(record)
    await disposeRecord(record)
    records.delete(record.sessionId)
    absent.add(record.sessionId)

    // The cold store is the only thing `restore` can read the originals back
    // from, so it is removed only once no receipt still needs it.
    let removed = false
    if (remaining === 0) {
      try {
        await removeSessionDirectory(labRoot, record.directory)
        removed = true
      } catch (error) {
        ctx.logger.warn(`memory-context-lab: purge after stop failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    // `skipped` 仍是「本轮 off 尝试恢复但没成功」的行数（文案用）；它与
    // `remaining` 的分工：skipped 讲为什么没恢复，remaining 讲冷库为什么不能删。
    return { before, restored, skipped: before - restored - pending, remaining, removed, refused }
  }

  async function runMaintenance(invocation, action) {
    try {
      return await invocation.agent.runMaintenance(async (maintenanceSignal) => {
        const signal = combineSignals(invocation.signal, maintenanceSignal)
        throwIfAborted(signal)
        return action(signal)
      })
    } catch (error) {
      // The host reserves maintenance exclusively; a mid-turn session surface
      // the raw English throw. Say what to do instead of leaking the internals.
      if (error instanceof Error && /already has active work/.test(error.message)) {
        throw new Error('会话正在运行，无法独占维护窗口；自动降温会在下一次请求前的稳定边界继续，或等这一步结束后再点。')
      }
      throw error
    }
  }

  // ── Session projection ───────────────────────────────────────────────────
  // Settings and receipt counts are folded from the session log itself; see
  // `projection.mjs` for why that is what makes resume and fork correct. The
  // fold context (presets + global defaults) is read fresh at every fold so a
  // settings-page edit is reflected on the next replay without a manual sync.
  const projection = createMemoryContextLabProjection({
    getPresets: resolveGlobalPresets,
    getDefaults: resolveDefaultsSettings,
    // 插件级 planFirst 配置默认：全新会话的折叠位从它取初值，`set planfirst`
    // 命令的折叠结果仍然覆盖它（事件折叠在 init 之后）。读取端保持惰性，
    // 配置页改动在下次重放时生效，与 preset/default 的口径一致。
    planFirstDefault: () => resolvePlanFirstDefault(config),
  })

  // ── v2 引擎（全历史按需记忆化）────────────────────────────────────────────
  // 与 v1 并存但互斥：同一会话只允许一个引擎替换模型可见投影。v2 不重定向正式
  // lingshu_cg；它把 v1 的降温管线接到自己的隔离库上（见 v2/runtime.mjs 顶部说明），
  // 并固定注册一个只读召回工具（见下方 ctx.inject(['tools'], …)）。
  // v2 检索后端：接本机已安装的灵枢，但**只**在会话隔离根上起独立子进程
  // （`buildIsolatedMdcgEnvironment` 会把 MDCG_ROOT/STATE_ROOT/DATA_ROOT 全部改写到
  // 该会话的 v2 目录）。灵枢里放的是派生索引表示，原文权威仍是本会话 ArchiveStore。
  // 未定位到 dsh-memory 时如实报不可用，绝不回退正式灵枢根。
  // 计划先行：宿主 planMode 服务联动（服务缺失时如实降级，不影响降温本体）。
  const planFirst = createPlanFirst({ services: ctx, logger: ctx.logger })

  /**
   * 读本插件投影的 planFirst 开关位（从会话日志折叠，不依赖引擎账本）。
   * 投影不可读时按 false 处理：宁可少联动，不凭记忆猜开关位置。
   */
  function readProjectionPlanFirst(session) {
    try {
      const state = ctx.sessionProjections?.stateOf?.(session, 'memoryContextLab')
      return state?.planFirst === true
    } catch {
      return false
    }
  }

  // 检索后端提供者已在引擎装配前创建（retrievalBackend）：v1/v2 共用同一提供者，
  // 保证「模型主动读」与「自动回注」走同一条多路检索。

  const v2 = createV2Runtime({
    labRoot,
    services,
    logger: ctx.logger,
    hostVersion: HOST_VERSION,
    sessionIdOf: (session) => sessionIdOf(session),
    recallQueryFrom,
    defaultSettings: resolveDefaultsSettings,
    defaultFullHistory: () => resolveFullHistoryDefault(config),
    onEnabled: (agent) => (readProjectionPlanFirst(agent.session) ? planFirst.enterIfFresh(agent) : null),
    // off 联动退出计划模式（rc.5）：关「新会话计划先行」时若计划模式仍处于
    // active/pending，同步退出——这是用户显式开关动作的一部分，不是插件自作主张。
    onPlanFirstToggle: (agent, value) => (value ? planFirst.enterIfFresh(agent) : planFirst.exitIfActive(agent)),
    coordinator: dependencies.coordinator,
    // 同步取用：检索热路径不会隐式起子进程（只在 /memory-lab2 index 时启动）。
    semanticBackendFor: ({ sessionId, storeRoot }) => retrievalBackend.backendFor({ sessionId, storeRoot }),
    semanticBackendEnsure: ({ sessionId, storeRoot, signal }) => retrievalBackend.ensureBackend({ sessionId, storeRoot, signal }),
    semanticBackendClose: ({ sessionId }) => retrievalBackend.close(sessionId),
    semanticBackendStatus: () => retrievalBackend.describe(),
    // PR #4 端口二：显式 lingshu 模式的启用预检（EBACKENDUNAVAILABLE 失败关闭）。
    backendPrecheck: () => (retrievalBackendMode === 'lingshu-mdcg-receipt'
      ? retrievalBackend.precheck()
      : { ok: true }),
    semanticBackendFailure: ({ sessionId }) => retrievalBackend.failureReason({ sessionId }),
    semanticBackendCloseAll: () => retrievalBackend.closeAll(),
  })

  async function v2CommandHandler(invocation) {
    const pending = v2.commandHandler(invocation)
    activeOperations.add(pending)
    pending.finally(() => activeOperations.delete(pending)).catch(() => {})
    return pending
  }

  // ── Command surface ──────────────────────────────────────────────────────
  /**
   * 与 `/memory-lab on` 完全相同的启用路径：命令面与「计划批准后自动启用」
   * 共用，保证两条入口产生同一份账本与互斥裁决。调用方拿到 record 后自行
   * 组织文案；抛错（含 EV2ACTIVE）由调用方处理。
   */
  async function enableV1(agent, signal) {
    const sessionId = sessionIdOf(agent.session)
    // v2 引擎若持有本会话投影，v1 不得同时接管（互斥由 v2/engine.mjs 裁决）。
    await assertV2AllowsV1(labRoot, sessionId)
    const record = await runMaintenance({ agent, signal }, async () => {
      const existing = await readSessionState(labRoot, sessionId)
      // Seed from the log, not from the defaults: a `set` issued before `on`
      // is still the user's latest intent, and the panel already shows it.
      const folded = settingsFromSessionLog(agent.session, buildFoldContext())
      const created = existing ?? await createSessionState(labRoot, sessionId, folded ?? resolveDefaultsSettings())
      if (folded) created.state.settings = folded
      created.state.enabled = true
      await writeSessionState(created.directory, created.state)
      const made = makeRecord({
        agent,
        sessionId,
        directory: created.directory,
        state: created.state,
      })
      records.set(sessionId, made)
      absent.delete(sessionId)
      return made
    })
    ctx.logger.info(`memory-context-lab: enabled for session ${sessionId}`)
    return record
  }

  /**
   * B2：v1 维护入口的引擎感知。v1 的 adopt 为 null 时，若 v2 引擎仍持有本会话
   * 投影（engine.json 激活中，读引擎声明而不是猜），如实指路 v2 的等价入口，
   * 不再误报「请先启用」（会话 c896f803：v2 账本 1845 段完好，面板却报未启用）。
   * 返回 null 表示 v2 未持有，调用方维持原文案。
   */
  function v2HeldNotice(sessionId) {
    try {
      if (getEngineRegistry(labRoot, sessionId).holder !== 'v2') return null
    } catch {
      return null
    }
    return {
      kind: 'error',
      text: '本会话由 v2 引擎（/memory-lab2）持有投影：恢复原文请用面板「恢复原文」按钮或 /memory-lab2 restore；'
        + '单段回读用 /memory-lab2 read <ID>；立即归档/预演用 /memory-lab2 now / dry-run；停用并整批恢复用 /memory-lab2 off。',
    }
  }

  async function commandHandler(invocation) {
    const { operation, remainder } = parseOperation(invocation.rawInput)
    const sessionId = sessionIdOf(invocation.agent.session)

    if (operation === 'help') return { kind: 'success', text: HELP }

    if (operation === 'status') {
      // Adopt first: it classifies the session (active / absent / damaged,
      // C-11). A damaged session must surface as damage, never as "never
      // enabled".
      const record = records.get(sessionId) ?? await adopt(invocation.agent)
      if (!record) {
        const notice = damagedNotice(sessionId)
        if (notice) return notice
      }
      const legacyNote = legacyColdStoreNote(record)
      return { kind: 'success', text: engine.formatStatus(record) + (legacyNote ? `\n\n${legacyNote}` : '') }
    }

    if (operation === 'on') {
      if (remainder) return { kind: 'error', text: '用法：/memory-lab on' }
      if (records.get(sessionId)) {
        const existing = records.get(sessionId)
        const legacyNote = legacyColdStoreNote(existing)
        return { kind: 'success', text: engine.formatStatus(existing) + (legacyNote ? `\n\n${legacyNote}` : '') }
      }
      let record
      try {
        record = await enableV1(invocation.agent, invocation.signal)
      } catch (error) {
        if (error instanceof EngineV2Error && error.code === 'EV2ACTIVE') {
          return { kind: 'error', text: `本会话已由全历史按需记忆化引擎（v2）接管投影。\n请先执行 /memory-lab2 off 退出 v2，再启用维护版降温。` }
        }
        return { kind: 'error', text: `未启用降温：${error instanceof Error ? error.message : String(error)}` }
      }
      // 计划先行：启用时若该开关已折叠为开且会话仍全新，立即联动宿主计划模式
      // （hero 态无 open turn，set() 即时落账，第一条用户消息就在计划引导下运行）。
      const planNote = readProjectionPlanFirst(invocation.agent.session)
        ? planFirst.enterIfFresh(invocation.agent)
        : null
      // 独立运行（设计文档 v1.2）：dsh-memory 缺席只损失可选增强（灵枢词法/结构
      // 检索），冷库与检索由本地实现承担——告警措辞必须与实际能力一致，
      // 不得再把「归档与回注会失败关闭」挂在独立模式下（那是旧绑定期的真话）。
      const degraded = dependencies.startupError
        ? `

注意：未检测到 dsh-memory（${dependencies.startupError instanceof Error ? dependencies.startupError.message : String(dependencies.startupError)}），本插件以独立模式运行——本地冷库与词法检索照常工作；灵枢词法/结构检索增强不可用，不会回退到正式灵枢根。
        `
        : ''
      const legacyNote = legacyColdStoreNote(record)
      return { kind: 'success', text: `已在本会话启用上下文降温。\n\n${engine.formatStatus(record)}${planNote ? `\n${planNote.text}` : ''}${degraded}${legacyNote ? `\n\n${legacyNote}` : ''}` }
    }

    if (operation === 'off') {
      if (remainder) return { kind: 'error', text: '用法：/memory-lab off' }
      const record = records.get(sessionId) ?? await adopt(invocation.agent)
      if (!record) {
        const notice = damagedNotice(sessionId)
        if (notice) return notice
        // rc.5：关闭按钮与引擎解耦。v2 引擎仍持有本会话投影时，/memory-lab off
        // 不再报「未启用」（那只会让面板显示已关、v2 引擎继续每步归档，形成
        // 「关不掉」的失同步，见会话 c250b0cf），而是转交 v2 的同一停用语义：
        // 先恢复原文、再停用、清引擎声明。
        try {
          if (getEngineRegistry(labRoot, sessionId).holder === 'v2') {
            const outcome = await v2.disable(invocation, 'memory-lab off 转交')
            return {
              kind: 'success',
              text: `本会话投影由 v2 引擎持有：/memory-lab off 已按同一停用语义转交。\n${outcome.text}`,
            }
          }
        } catch (error) {
          return {
            kind: 'error',
            text: `v2 转交停用失败：${error instanceof Error ? error.message : String(error)}`,
          }
        }
        // A directory can outlive the enable (an earlier run, or a resume in a new
        // process). Reclaim it when nothing depends on it, so `off` is idempotent
        // and never leaves plugin data behind.
        // "Nothing depends on it" is exactly `pendingReceipts` plus the
        // restore-skipped rows (B3: those originals are also only in the cold
        // store): a verify-failed row shadowed an original just as firmly, and a
        // restore-skipped row never got its original back.
        const leftover = await readSessionState(labRoot, sessionId)
        if (leftover && engine.pendingReceipts(leftover).length === 0 && restoreSkippedReceipts(leftover).length === 0) {
          try {
            await removeSessionDirectory(labRoot, leftover.directory)
            return { kind: 'success', text: '当前会话未启用上下文降温；已清除遗留的插件隔离数据。' }
          } catch (error) {
            ctx.logger.warn(`memory-context-lab: leftover purge failed: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
        return { kind: 'success', text: '当前会话未启用上下文降温。' }
      }
      try {
        // One stop path for both `off` and the archive hook: restore, stop, purge.
        // The window guard applies here because the session is still live.
        const outcome = await runMaintenance(invocation, (signal) => normalizeAndStop(record, signal, { guardWindow: true }))
        const lines = []
        if (outcome.refused) {
          // 真正会涨上去的是 `total - heldByReceipts`：回执本身已经在组装输入里，
          // 拿 `total` 当增量会把它们重复计一遍，把拒绝理由说得比实际更吓人。
          const growth = outcome.refused.total - (outcome.refused.heldByReceipts ?? 0)
          lines.push(
            `已停用降温。但恢复会让组装输入超出模型窗口（当前约 ${outcome.refused.assembled} + 待恢复约 ${growth} > 窗口 ${outcome.refused.window}），`,
            '因此**没有**恢复，原文仍在冷库里。要回到正常会话，请先缩小上下文，或直接丢弃冷库：',
            '  /memory-lab clean confirm delete-session',
          )
        } else {
          if (outcome.restored > 0) lines.push(`已恢复 ${outcome.restored} 个操作的原文。`)
          if (outcome.skipped > 0) {
            lines.push(outcome.removed
              ? `有 ${outcome.skipped} 个未能恢复（回执已变化或冷节点不可读），其原文不可找回，已随冷库一并清除。`
              : `有 ${outcome.skipped} 个未能恢复（回执已变化或冷节点不可读），它们仍依赖冷库。`)
          }
        }
        if (outcome.removed) {
          lines.push('已停用降温，并清除了本会话的插件隔离数据（冷库节点、状态与令牌文件）。DSH 的会话日志与命令审计不由插件改写。')
        } else if (outcome.remaining === 0) {
          lines.push('已停用降温（隔离数据未能删除，可稍后重试 /memory-lab clean）。')
        } else if (!outcome.refused) {
          lines.push(
            `仍有 ${outcome.remaining} 个已归档操作依赖冷库，因此没有删除冷库。`,
            '要直接丢弃冷库（原文将无法恢复）：/memory-lab clean confirm delete-session。',
          )
        }
        if (!engine.settingsOf(record).autoRestore && outcome.before > 0) {
          lines.push(
            `（「停用时恢复原文」为关，${outcome.before} 个操作的原文仍留在冷库里。）`,
            // `off` clears `enabled`, and `adopt` refuses a disabled session, so
            // `restore` cannot see these receipts again until the session is
            // re-enabled. Saying so is the difference between "recoverable" and
            // "apparently lost".
            '要取回它们：先 /memory-lab on 重新启用（冷库未删除，回执仍可解析），再 /memory-lab restore。',
          )
        }
        return { kind: 'success', text: lines.join('\n') }
      } catch (error) {
        return { kind: 'error', text: `无法停用降温：${error instanceof Error ? error.message : String(error)}` }
      }
    }

    if (operation === 'set') {
      const [settingName = '', ...rest] = remainder.split(/\s+/).filter(Boolean)
      const rawValue = rest.join(' ')
      const numeric = NUMERIC_SETTINGS[settingName]
      const boolean = BOOLEAN_SETTINGS[settingName]
      if (!numeric && !boolean) {
        return { kind: 'error', text: '用法：/memory-lab set retain 10 | batch 10 | auto on|off | recall on|off | autorestore on|off | protect 32768 | planfirst on|off' }
      }
      // 计划先行是插件级开关（两引擎通用），不进 v1 引擎设置账本；开启且会话
      // 全新时立即联动宿主计划模式，其余情况只记位置。
      if (settingName === 'planfirst') {
        if (rawValue !== 'on' && rawValue !== 'off') {
          return { kind: 'error', text: '计划先行只能是 on 或 off。' }
        }
        // rc.5：off 时若计划模式仍 active/pending，联动退出并如实报告。
        const note = rawValue === 'on' ? planFirst.enterIfFresh(invocation.agent) : planFirst.exitIfActive(invocation.agent)
        const recordForPlan = records.get(sessionId)
        if (recordForPlan) {
          recordForPlan.state.planFirst = rawValue === 'on'
          await persist(recordForPlan).catch(() => {})
        }
        const lines = [`新会话计划先行已设为 ${rawValue === 'on' ? '开' : '关'}。`]
        if (note?.text) lines.push(note.text)
        if (!records.get(sessionId)) lines.push('（本会话尚未启用降温；开关位置已记下，随会话日志折叠生效。）')
        return { kind: 'success', text: lines.join('\n') }
      }
      // 全历史只在 v2 引擎下存在：v1 命令面如实指路，不静默吞掉拼写正确的开关。
      if (settingName === 'fullhistory') {
        if (rawValue !== 'on' && rawValue !== 'off') {
          return { kind: 'error', text: '全历史记忆上下文只能是 on 或 off。' }
        }
        return {
          kind: 'error',
          text: '全历史记忆上下文只在 v2 引擎下有意义：请用 /memory-lab2 set fullhistory on|off，或在面板开关里启用（面板会自动切换引擎）。',
        }
      }
      const record = records.get(sessionId) ?? await adopt(invocation.agent)
      if (!record) {
        // D6：v2 引擎若正持有本会话投影，这里写的 v1 设置永远不会生效——用户
        // 随后的 /memory-lab on 会被互斥拒绝（EV2ACTIVE），「已记下、on 后生效」
        // 就是谎报（实测会话 v2 启用后 set batch，v2 的 store.settings 纹丝不动，
        // 批形态由 v2 自己的批次逻辑决定，用户以为改了却毫无提示）。如实指路。
        const registry = getEngineRegistry(labRoot, sessionId)
        if (registry.holder === 'v2') {
          return {
            kind: 'error',
            text: '本会话当前由 v2 引擎（/memory-lab2）持有投影：/memory-lab set 写入的是 v1 设置，对 v2 行为不生效。请改用 /memory-lab2 set batch N（v2 侧同名设置即时生效），或先 /memory-lab2 off 回到 v1。',
          }
        }
        // Settings are configuration, not activation, and the host has already
        // written this command into the session log — which is where `on` folds
        // them from. Reporting a failure here would be a lie: the value does take
        // effect. Validate it first so a typo is still caught.
        try {
          if (numeric) parseNumericSetting(rawValue, numeric)
          else if (rawValue !== 'on' && rawValue !== 'off') throw new SettingsError(`${boolean.label}只能是 on 或 off。`)
        } catch (error) {
          return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
        }
        return {
          kind: 'success',
          text: `已记下设置；在本会话执行 /memory-lab on 后生效（设置从会话日志折叠，不必重新输入）。`,
        }
      }
      try {
        await runMaintenance(invocation, async () => {
          if (numeric) {
            record.state.settings[numeric.key] = parseNumericSetting(rawValue, numeric)
          } else {
            if (rawValue !== 'on' && rawValue !== 'off') throw new SettingsError(`${boolean.label}只能是 on 或 off。`)
            record.state.settings[boolean.key] = rawValue === 'on'
          }
          await persist(record)
        })
      } catch (error) {
        return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
      }
      const settings = engine.settingsOf(record)
      const shown = numeric
        ? (numeric.integer ? String(settings[numeric.key]) : formatRatio(settings[numeric.key]))
        : (settings[boolean.key] ? '开' : '关')
      return { kind: 'success', text: `${numeric?.label ?? boolean.label}已设为 ${shown}。` }
    }

    if (operation === 'preset') {
      const query = remainder.trim()
      const presets = resolveGlobalPresets()
      if (!query) {
        const defaults = resolveDefaultsSettings()
        const lines = [
          `全局预设：保留 ${defaults.retainOperations} / 批量 ${defaults.archiveBatchSize} / 自动 ${defaults.auto ? '开' : '关'} / 回注 ${defaults.autoRecall ? '开' : '关'} / 恢复 ${defaults.autoRestore ? '开' : '关'}。`,
          '可用预设：',
          ...presets.map((preset) => `  ${preset.name} — ${formatPresetValue(preset.settings)}（预设名含空格时按完整名称输入）`),
          '用法：/memory-lab preset <名称> 应用整组预设；/memory-lab preset reset 回到全局预设；新增/改名/编辑在设置页。',
        ]
        if (presets.length === 0) lines.splice(2, 1, '  （暂无预设；可在设置页新增，或恢复为默认附带的两个模型预设）')
        return { kind: 'success', text: lines.join('\n') }
      }
      const entry = resolvePreset(presets, query)
      if (query === 'reset' || query === '默认' || query === '全局' || query === 'global') {
        const defaults = resolveDefaultsSettings()
        const record = records.get(sessionId) ?? await adopt(invocation.agent)
        if (record) {
          await runMaintenance(invocation, async () => {
            record.state.settings = normalizeSettings(defaults)
            await persist(record)
          })
        }
        return { kind: 'success', text: `已回到全局预设：${formatPresetValue(defaults)}。` }
      }
      if (!entry) {
        const names = presets.map((preset) => preset.name).join('、') || '（无）'
        return { kind: 'error', text: `找不到预设「${query}」。可用：${names}；或用 reset 回到全局预设。` }
      }
      const record = records.get(sessionId) ?? await adopt(invocation.agent)
      if (!record) {
        // Same contract as `set` before `on`: the command is already in the log
        // and `on` will fold it — validate the preset exists, then report so.
        return { kind: 'success', text: `已记下预设「${entry.name}」；在本会话执行 /memory-lab on 后生效（${formatPresetValue(entry.settings)}）。` }
      }
      await runMaintenance(invocation, async () => {
        record.state.settings = normalizeSettings(entry.settings)
        await persist(record)
      })
      return { kind: 'success', text: `预设「${entry.name}」已应用：${formatPresetValue(entry.settings)}。` }
    }

    if (operation === 'now' || operation === 'dry-run') {
      const record = records.get(sessionId) ?? await adopt(invocation.agent)
      if (!record) {
        const notice = damagedNotice(sessionId)
        if (notice) return notice
        const v2Notice = v2HeldNotice(sessionId)
        if (v2Notice) return v2Notice
        return { kind: 'error', text: '请先使用 /memory-lab on 在当前会话启用降温。' }
      }
      try {
        return await runMaintenance(invocation, (signal) => engine.runOnce(record, signal, { dryRun: operation === 'dry-run' }))
      } catch (error) {
        return { kind: 'error', text: `操作失败（原文未作静默删除）：${error instanceof Error ? error.message : String(error)}` }
      }
    }

    if (operation === 'protect') {
      const record = records.get(sessionId) ?? await adopt(invocation.agent)
      if (!record) {
        const notice = damagedNotice(sessionId)
        if (notice) return notice
        return { kind: 'error', text: '请先使用 /memory-lab on 在当前会话启用降温。' }
      }
      try {
        // 无副作用测量：查询保护集不会写状态、不会租用冷节点 id。
        return await runMaintenance(invocation, async (signal) => {
          const occupancy = await engine.measureOccupancy(record, signal, { persistClaims: false })
          return { kind: 'success', text: engine.formatProtection(occupancy) }
        })
      } catch (error) {
        return { kind: 'error', text: `无法读取保护集：${error instanceof Error ? error.message : String(error)}` }
      }
    }

    if (operation === 'pin' || operation === 'unpin') {
      const target = remainder.trim()
      const record = records.get(sessionId) ?? await adopt(invocation.agent)
      if (!record) {
        const notice = damagedNotice(sessionId)
        if (notice) return notice
        return { kind: 'error', text: '请先使用 /memory-lab on 在当前会话启用降温。' }
      }
      if (!target) {
        return { kind: 'error', text: `用法：/memory-lab ${operation} <seq>（seq 见 dry-run／protect 报告）` }
      }
      try {
        return await runMaintenance(invocation, async () => {
          const outcome = operation === 'pin'
            ? engine.pinOperation(record, target)
            : engine.unpinOperation(record, target)
          await persist(record)
          return { kind: outcome.ok ? 'success' : 'error', text: outcome.text }
        })
      } catch (error) {
        return { kind: 'error', text: `${operation} 失败：${error instanceof Error ? error.message : String(error)}` }
      }
    }

    if (operation === 'restore') {
      const record = records.get(sessionId) ?? await adopt(invocation.agent)
      if (!record) {
        const notice = damagedNotice(sessionId)
        if (notice) return notice
        const v2Notice = v2HeldNotice(sessionId)
        if (v2Notice) return v2Notice
        return { kind: 'error', text: '请先使用 /memory-lab on 在当前会话启用降温。' }
      }
      if (remainder) return { kind: 'error', text: '用法：/memory-lab restore' }
      try {
        const outcome = await runMaintenance(invocation, () => engine.runRestore(record))
        const legacyNote = legacyColdStoreNote(record)
        if (legacyNote && outcome?.kind === 'success') {
          return { ...outcome, text: `${outcome.text}\n\n${legacyNote}` }
        }
        return outcome
      } catch (error) {
        return { kind: 'error', text: `恢复失败（未覆盖任何新事件）：${error instanceof Error ? error.message : String(error)}` }
      }
    }

    if (operation === 'clean') {
      const [cleanAction = '', ...rest] = remainder.split(/\s+/).filter(Boolean)
      const confirmDelete = cleanAction === 'confirm' && rest[0] === 'delete-session'
      if (cleanAction && !confirmDelete) {
        return { kind: 'error', text: '用法：/memory-lab clean（或在确认删除整个会话后）/memory-lab clean confirm delete-session' }
      }
      try {
        const guard = await runMaintenance(invocation, async () => {
          // C-11: adopt throws for a damaged session (that is how the damage
          // is sticky). Here the damage itself is the case we are handling, so
          // fall through with no live record and let the branch below decide.
          let live = records.get(sessionId)
          if (!live && !damagedSessions.has(sessionId)) live = await adopt(invocation.agent)
          // C-11: the durable file is unreadable, so no receipt accounting is
          // possible — deletion needs explicit confirmation and then removes
          // the whole session directory.
          if (damagedSessions.has(sessionId)) {
            if (!confirmDelete) {
              return {
                damaged: true,
                confirmDelete,
              }
            }
            if (live) {
              await disposeRecord(live)
              records.delete(sessionId)
            }
            const damaged = damagedSessions.get(sessionId)
            await removeSessionDirectory(labRoot, damaged.directory)
            damagedSessions.delete(sessionId)
            absent.add(sessionId)
            return { refused: false, removed: true }
          }
          // The durable file is the authority for what still depends on the cold
          // store; a stale in-memory record must never be able to authorize a
          // delete that orphans a receipt.
          const found = await readSessionState(labRoot, sessionId)
          const rows = found?.state.archive ?? live?.state.archive ?? []
          // Count what `restore` can actually get back, via the same predicate
          // the restore path uses: a verify-failed row is restorable, so it must
          // still gate the delete confirmation; a restore-skipped row never got
          // its original back (B3), so it gates the delete just as firmly.
          const rowsRecord = { state: { archive: rows } }
          const pending = engine.pendingReceipts(rowsRecord).length + restoreSkippedReceipts(rowsRecord).length
          const decision = cleanDecision({ pendingReceipts: pending, confirmDelete })
          if (decision.refuse) return { refused: true, pending: decision.pending }
          if (!found) {
            if (live) {
              await disposeRecord(live)
              records.delete(sessionId)
            }
            absent.add(sessionId)
            return { refused: false, removed: false }
          }
          if (live) {
            await disposeRecord(live)
            records.delete(sessionId)
          }
          await removeSessionDirectory(labRoot, found.directory)
          absent.add(sessionId)
          return { refused: false, removed: true }
        })
        if (guard.damaged) {
          return {
            kind: 'error',
            text: '会话状态文件损坏，无法核对依赖冷库的已归档操作。'
              + '原文可能无法恢复，确认后才能删除整个会话目录：/memory-lab clean confirm delete-session。',
          }
        }
        if (guard.refused) {
          return {
            kind: 'error',
            text: [
              `拒绝直接删除：当前会话有 ${guard.pending} 个已归档操作依赖隔离冷库。`,
              '请选择：',
              '  1) 先恢复原文再清理：/memory-lab restore，然后 /memory-lab clean；',
              '  2) 确认删除整个会话后再删除会话目录：/memory-lab clean confirm delete-session；',
              '  3) 保留会话目录：不做任何操作。',
              '插件不会在原文可能仍被回执引用时静默删除冷库。',
            ].join('\n'),
          }
        }
        return {
          kind: 'success',
          text: guard.removed
            ? '已删除当前会话的插件自有隔离数据（冷库节点、状态与令牌文件）。DSH 的会话日志与命令审计不由插件改写。'
            : '当前会话没有需要清理的隔离数据。',
        }
      } catch (error) {
        return { kind: 'error', text: `清理失败（数据未作静默删除）：${error instanceof Error ? error.message : String(error)}` }
      }
    }

    return { kind: 'error', text: HELP }
  }

  // ── Plan-first automation（自动进入计划模式 + 批准后自动启用降温）────────
  // 注册在自动降温钩子之前：同一稳定边界上，先完成「批准 → 自动 on」，再让
  // 自动降温钩子拿到已存在的 record 正常续跑，避免空转一步。
  // 自动进入只在「全新会话的首个 enter 步」发生一次；自动启用只在
  // planActive 观察 true→false（计划退出）且 v1 未启用、v2 未接管时发生一次。
  // 两个内存集合都以宿主会话 id 为键：插件重启后集合为空，但投影折叠位与
  // plan/mode 落账仍在，重放不会重复进入或重复启用。
  const autoEnteredPlanSessions = new Set()
  const autoEnabledCoolingSessions = new Set()
  const lastObservedPlanActive = new Map()
  const disposePlanFirstAutomation = ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next()
    if (decision?.kind !== 'enter' || signal?.aborted) return decision
    try {
      const sessionId = sessionIdOf(agent.session)
      // 投影折叠位即生效判定：init 由插件级配置播种，`set planfirst` 折叠覆盖。
      // 折叠位为 false 时本钩子完全静默（含用户显式 set off）。
      if (!sessionId || !readProjectionPlanFirst(agent.session)) return decision

      // (1) 全新会话自动进入计划模式。pre-step 时首条用户消息已入 surface，
      //     所以放宽的 fresh 判定允许「无 assistant 消息且 user 消息 ≤ 1」。
      if (!autoEnteredPlanSessions.has(sessionId)) {
        const stateBefore = planFirst.planStateOf(agent)
        if (stateBefore.available && stateBefore.active !== true && planFirst.sessionIsFreshForAutoEnter(agent)) {
          const result = planFirst.enterIfFresh(agent, { fresh: true })
          if (result?.outcome === 'committed') {
            autoEnteredPlanSessions.add(sessionId)
            ctx.logger.info(`memory-context-lab: plan-first auto-entered fresh session ${sessionId} (via ${result.via})`)
          } else if (result?.outcome === 'error') {
            ctx.logger.warn(`memory-context-lab: plan-first auto-enter failed: ${result.reason}`)
          }
        } else {
          // 一旦会话不再全新（或已处于计划模式），永久关闭本会话的自动进入。
          autoEnteredPlanSessions.add(sessionId)
        }
      }

      // (2) 计划批准退出（planActive true→false）→ 自动启用 v1 降温。
      //     只在未启用且 v2 未接管时触发；EV2ACTIVE 等互斥冲突按静默跳过
      //     处理（v2 在管时由 v2 自己的机制负责，不抢投影）。
      const activeNow = planFirst.planStateOf(agent).active === true
      const activeBefore = lastObservedPlanActive.get(sessionId)
      lastObservedPlanActive.set(sessionId, activeNow)
      if (activeBefore === true && activeNow === false && !autoEnabledCoolingSessions.has(sessionId)) {
        autoEnabledCoolingSessions.add(sessionId)
        if (!records.get(sessionId)) {
          try {
            const record = await enableV1(agent, signal)
            if (record) {
              ctx.logger.info(`memory-context-lab: plan approved; cooling auto-enabled for session ${sessionId}`)
              const messageId = randomUUID()
              return {
                ...decision,
                messages: [...decision.messages, {
                  id: messageId,
                  role: 'user',
                  content: [{ type: 'text', text: escapePromptBraces('[计划已批准] 上下文降温已自动启用（/memory-lab on 等效）；计划工件保持常驻，后续操作以小回执替换、正文沉入会话隔离冷库。') }],
                  source: { kind: PACKAGE_NAME, form: PLUGIN_SOURCE_FORMS.WORKING_STATE },
                }],
              }
            }
          } catch (error) {
            ctx.logger.warn(`memory-context-lab: auto-enable after plan approval skipped: ${error?.message || error}`)
          }
        }
      }
    } catch (error) {
      // 自动化是增强：任何失败都不得影响本次请求。
      ctx.logger.warn(`memory-context-lab: plan-first automation error: ${error?.message || error}`)
    }
    return decision
  })

  // ── Automatic cooling at the confirmed stable boundary ───────────────────
  // `agent/pre-step` is a waterfall that runs after the inbox is claimed and
  // before `step/start`, `agent/request`, and request derivation, so a surface
  // replacement committed here is folded into the very next request without
  // touching the frozen message array. The listener delegates first and only
  // acts on an `enter` decision, so a step another listener rejects never
  // triggers work.
  const disposeAutoCooling = ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next()
    if (decision?.kind !== 'enter' || signal?.aborted) return decision
    // 计划模式激活期间挂起自动降温：计划生成与评审依赖完整历史，退热会破坏
    // 计划阶段的信息完整性。手动命令不受影响（用户显式动作优先）。
    const suspension = planFirst.coolingSuspensionFor(agent)
    if (suspension.suspended) {
      ctx.logger.info(`memory-context-lab: ${suspension.reason}`)
      return decision
    }
    try {
      const record = await adopt(agent)
      if (record) {
        const outcome = await engine.runAutoCooling(record, signal)
        if (outcome.action === 'applied') {
          ctx.logger.info(`memory-context-lab: archived ${outcome.applied} operations (~${outcome.releasedTokens} tokens)`)
        } else if (outcome.action === 'failed') {
          ctx.logger.warn(`memory-context-lab: archive batch failed (0 units applied): ${outcome.reason}`)
        } else if (outcome.action === 'unavailable') {
          ctx.logger.warn(`memory-context-lab: cooling unavailable: ${outcome.reason}`)
        }
      }
    } catch (error) {
      ctx.logger.warn(`memory-context-lab: auto cooling skipped: ${error instanceof Error ? error.message : String(error)}`)
    }
    return decision
  })

  // ── Matching recall, injected at the tail ────────────────────────────────
  // Same mechanism the shipped `time-context` plugin uses: delegate first, then
  // fold one sourced `UserMessage` into the entering batch. The message is
  // durable, lands after everything already claimed, and carries
  // `form: 'recall'` from the host's own `ContextFormed` vocabulary.
  //
  // Because it is appended to the batch rather than written into the prefix,
  // the prefix cache is untouched; and because it is emitted at most once per
  // claimed user message, one turn never injects twice.
  const disposeRecall = ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next()
    if (decision?.kind !== 'enter' || signal?.aborted) return decision
    // 计划模式激活期间不回注：计划阶段需要的上下文由计划本身与完整历史承担。
    if (planFirst.coolingSuspensionFor(agent).suspended) return decision
    // Declared outside the try so the failure path can still report the attempt.
    let recallRecord = null
    try {
      const record = await adopt(agent)
      recallRecord = record
      if (!record || !engine.settingsOf(record).autoRecall) return decision
      // Nothing archived means nothing to recall, and a search would only
      // surface unrelated cold-store content while permanently growing history.
      if (engine.pendingReceipts(record).length === 0) return decision
      const query = recallQueryFrom(decision.messages)
      if (query) record.humanPromptSeen = true
      if (!query || record.recallQueryId === query.id) return decision
      // Remember the attempt either way: a failed search must not be retried on
      // every step of the same turn.
      record.recallQueryId = query.id
      const digest = await engine.buildRecall(record, query.text.slice(0, MAX_RECALL_QUERY_CHARS), signal)
      if (!digest.text) {
        // 「没有命中」「冷库拒答」「冷库不可用」是三件事，必须分开记：把后端故障
        // 静默当成"没有相关信息"，模型会以为工作已丢失并重做。空命中不记日志
        // （那是正常结果），失败一定记。
        engine.rememberRecall(record, {
          queryId: query.id,
          status: digest.status,
          reason: digest.reason,
          hits: digest.hits.length,
          skippedVisible: digest.skippedVisible,
          truncated: digest.truncated === true,
          omitted: digest.omitted ?? 0,
        })
        if (digest.status !== 'ok') {
          ctx.logger.warn(`memory-context-lab: recall ${digest.status}: ${digest.reason || 'no reason reported'}（未注入任何内容，也未记为"无相关信息"）`)
        } else if (digest.skippedVisible > 0) {
          ctx.logger.info(`memory-context-lab: recall hit ${digest.skippedVisible} node(s) already visible; nothing new injected`)
        }
        return decision
      }
      // 召回结果临时保护：把刚注入的冷记录（以及本次注入时仍在待归档计划里的
      // 操作）挂上短期软保护，避免同一稳定边界上"刚读回又归档"。曝光不等于
      // 理解，所以它只是软保护：带来源、原因、建立序号与解除条件，到期即释放。
      engine.protectRecall(record, {
        hits: digest.hits,
        queryId: query.id,
        ranges: (record.occupancy?.plan?.units ?? []).map((unit) => ({
          rangeStart: unit.rangeStart,
          rangeEnd: unit.rangeEnd,
          costTokens: Number(unit.originalTokens) || 0,
        })),
      })
      const text = escapePromptBraces(renderRecallBlock(digest.text))
      const messageId = randomUUID()
      engine.rememberRecall(record, {
        messageId,
        nodeIds: digest.hits.map((hit) => hit.id),
        queryId: query.id,
        status: digest.status,
        hits: digest.hits.length,
        skippedVisible: digest.skippedVisible,
        truncated: digest.truncated === true,
        omitted: digest.omitted ?? 0,
      })
      return {
        ...decision,
        messages: [...decision.messages, {
          id: messageId,
          role: 'user',
          content: [{ type: 'text', text }],
          source: { kind: PACKAGE_NAME, form: PLUGIN_SOURCE_FORMS.RECALL },
        }],
      }
    } catch (error) {
      // Recall is an enhancement: a cold-store failure must never fail the
      // request, and it must never leave a partially folded decision.
      // 这是"冷库不可用"（调用本身抛错），与"空命中"和"冷库拒答"都不同。
      // 抛错路径同样要记一次尝试：否则 status 会停留在上一次成功的结果上，
      // 把一次后端故障显示成一切正常。
      const reason = error instanceof Error ? error.message : String(error)
      if (recallRecord) {
        engine.rememberRecall(recallRecord, {
          queryId: recallRecord.recallQueryId ?? '',
          status: 'unavailable',
          reason,
        })
      }
      ctx.logger.warn(`memory-context-lab: recall unavailable (call threw): ${reason}`)
      return decision
    }
  }, { prepend: true })

  // ── v2 引擎的同位钩子 ─────────────────────────────────────────────────────
  // 与 v1 完全相同的挂载点与顺序（先 delegate 再动作），但只在 v2 账本启用的
  // 会话上生效。两套钩子各自 `adopt`，同一会话不会同时命中：v2 的 adopt 只认
  // v2 状态文件，v1 的 adopt 只认 v1 状态文件，而引擎互斥保证两者不会同时启用。
  const disposeV2AutoCooling = ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next()
    if (decision?.kind !== 'enter' || signal?.aborted) return decision
    // 与 v1 同一条挂起规则：计划模式激活期间自动降温 no-op。
    const suspension = planFirst.coolingSuspensionFor(agent)
    if (suspension.suspended) {
      ctx.logger.info(`memory-lab2: ${suspension.reason}`)
      return decision
    }
    try {
      const outcome = await v2.autoCooling(agent, signal)
      if (outcome.action === 'applied') {
        ctx.logger.info(`memory-lab2: archived ${outcome.applied} operations (~${outcome.releasedTokens} tokens)`)
      } else if (outcome.action === 'unavailable') {
        ctx.logger.warn(`memory-lab2: cooling unavailable: ${outcome.reason}`)
      }
    } catch (error) {
      ctx.logger.warn(`memory-lab2: auto cooling skipped: ${error instanceof Error ? error.message : String(error)}`)
    }
    return decision
  })

  const disposeV2Recall = ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next()
    if (decision?.kind !== 'enter' || signal?.aborted) return decision
    // 计划模式激活期间不回注（与 v1 同规则）。
    if (planFirst.coolingSuspensionFor(agent).suspended) return decision
    try {
      return await v2.buildRecall(agent, decision, signal)
    } catch (error) {
      ctx.logger.warn(`memory-lab2: recall skipped: ${error instanceof Error ? error.message : String(error)}`)
      return decision
    }
  }, { prepend: true })

  // 有界工作状态注入：只在 v2 启用且本会话已有退热历史时追加一张确定性状态卡。
  // 失败关闭：注入失败不得阻塞这一步。
  //
  // 去重与注入形态（全量卡 / 增量卡）的裁决都在引擎里（`v2.workingSetInjection`，
  // D1 升级）：固定协议文案只在会话首张与周期性再锚定的全量卡里注入，其余步只
  // 注入相对上一张全量卡的变化行。裁决需要「注入成功才推进状态」，而注入是否
  // 发生只有拿到返回值才知道——所以裁决收进引擎，钩子只负责把返回的文本挂上
  // 稳定 id 追加进消息。
  const disposeV2WorkingSet = ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next()
    if (decision?.kind !== 'enter' || signal?.aborted) return decision
    // 计划模式激活期间不注入工作状态卡：计划阶段历史保持完整，卡片没有意义。
    if (planFirst.coolingSuspensionFor(agent).suspended) return decision
    try {
      const card = await v2.workingSetInjection(agent)
      if (!card) return decision
      const content = escapePromptBraces(card.text)
      return {
        ...decision,
        messages: [
          ...(Array.isArray(decision.messages) ? decision.messages : []),
          {
            // 宿主契约要求每条消息有稳定 id：`Session.create`（= resume/replay）
            // 会校验 seed 里每条 user/message 都有 id，缺了写入不报错、重放直接
            // 拒绝，整个会话恢复不了。append 路径不校验，所以这个坑只能靠重放测出来。
            id: randomUUID(),
            role: 'user',
            content: [{ type: 'text', text: content }],
            source: { kind: PACKAGE_NAME, form: 'working-set' },
          },
        ],
      }
    } catch (error) {
      ctx.logger.warn(`memory-lab2: working set skipped: ${error instanceof Error ? error.message : String(error)}`)
      return decision
    }
  })

  ctx.effect(() => ctx.sessionProjections.register(projection), 'memory-context-lab: projection')

  // ── Archiving the session returns it to normal ───────────────────────────
  // The archive set is the `workspace` domain's global singleton, and every domain
  // write emits `domain/changed` once durability is acknowledged. Watching that is
  // what makes this complete: `workspace/session-stop` only fires when the host had
  // to stop running work, so an idle session archived from the GUI would never
  // reach a plugin, but the archive set itself always changes.
  //
  // The restore runs without the window guard: an archived session takes no more
  // requests, so putting the originals back cannot break one, and leaving the
  // receipts behind would keep the cold store alive for a session nobody resumes.
  // Seed from the registry when it is available so an archive landing between load
  // and the first domain event is still seen. When it is not, the first event
  // establishes the baseline instead — either way, archives that predate this
  // process are never treated as new.
  const registryArchiveIds = services.get('workspaceRegistry')?.archivedSessionIds
  let archivedBaseline = Array.isArray(registryArchiveIds) ? new Set(registryArchiveIds.map(String)) : null

  function archivedIdsOf(value) {
    const ids = value?.archivedSessionIds
    return Array.isArray(ids) ? ids.map(String) : null
  }

  const disposeArchiveWatch = ctx.on('domain/changed', (change) => {
    if (change?.domain !== 'workspace') return
    const ids = archivedIdsOf(change.value)
    // A workspace *record* write carries no archive set; only the singleton does.
    if (ids === null) return
    if (archivedBaseline === null) {
      // First sighting after load: adopt the current set without acting on
      // archives that happened before this plugin was watching.
      archivedBaseline = new Set(ids)
      return
    }
    const newly = ids.filter((id) => !archivedBaseline.has(id))
    archivedBaseline = new Set(ids)
    // Fire-and-forget: `domain/changed` is an emit, so the write that triggered it
    // must not be held open by a restore.
    for (const sessionId of newly) void archiveCleanup(sessionId)
  })

  async function archiveCleanup(sessionId) {
    try {
      const record = records.get(sessionId) ?? await adoptById(sessionId)
      if (!record) return
      const outcome = await normalizeAndStop(record, undefined, { guardWindow: false })
      ctx.logger.info(
        `memory-context-lab: session archived; restored ${outcome.restored}/${outcome.before}, `
        + `purged=${outcome.removed}`,
      )
    } catch (error) {
      ctx.logger.warn(`memory-context-lab: archive cleanup skipped: ${error instanceof Error ? error.message : String(error)}`)
    }
    // v2 走同一条收尾语义：恢复原文、置停用、只读保留（不删冷库）。
    // 归档的会话不会再收到请求，所以这里不带窗口守卫，与 v1 一致。
    try {
      const record = v2.records.get(sessionId) ?? await v2.adoptById(sessionId)
      if (!record) return
      const outcome = await v2.disableById(sessionId, 'session-archived')
      ctx.logger.info(`memory-lab2: session archived; restored ${outcome.restored}/${outcome.before}`)
    } catch (error) {
      ctx.logger.warn(`memory-lab2: archive cleanup skipped: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  ctx.effect(function* memoryContextLabLifecycle() {
    yield async () => {
      await Promise.allSettled([...activeOperations])
      disposePlanFirstAutomation()
      disposeAutoCooling()
      disposeRecall()
      disposeV2AutoCooling()
      disposeV2Recall()
      disposeV2WorkingSet()
      disposeArchiveWatch()
      for (const record of records.values()) {
        try { await disposeRecord(record) } catch { /* best-effort teardown */ }
      }
      records.clear()
      try { await v2.shutdown() } catch { /* best-effort teardown */ }
    }
    yield ctx.commands.register({
      definitionId: 'dsh-memory-context-lab/control',
      name: COMMAND_NAME,
      description: 'Archive finished operations into an isolated cold store to reduce context',
      input: { hint: 'on | off | status | preset [名称|reset] | set retain|batch|auto|recall|autorestore <value> | now | dry-run | restore | clean | help' },
      handler: (invocation) => {
        const pending = commandHandler(invocation)
        activeOperations.add(pending)
        pending.finally(() => activeOperations.delete(pending)).catch(() => {})
        return pending
      },
    })
    // v2 命令与 v1 命令并存：不隐藏、不改写 v1 的 schema，也不随 on/off 增删。
    yield ctx.commands.register({
      definitionId: 'dsh-memory-context-lab/control-v2',
      name: V2_COMMAND_NAME,
      description: 'Full-history on-demand memory (v2): structured records with bounded working state',
      input: { hint: 'on | off | restore | status | now | dry-run | read <ID...> | history [页大小] | working-set [预算] | recall [查询|id <ID...>] | index [status|sync] | relations | cost | import-v1 | fork <子会话ID> | fork-status | fork-reset <子会话ID> | set auto|recall|batch|retain <value> | help' },
      handler: (invocation) => v2CommandHandler(invocation),
    })
    // 固定注册的只读召回工具：完整模式的一部分，不随 v2 的 on/off 增删 schema。
    // 未启用 v2 的会话调用它只会得到一条「未启用」结果，工具集恒定。
    // 走反应式注入：拿不到 `tools` 服务就跳过并告警，不影响 v1。
    // `ctx.inject` 在依赖缺失时是静默的（回调不触发），所以这里另外显式探一次——
    // 「悄悄没注册」不可接受，必须留下痕迹；服务后到时会由 inject 补上注册。
    //
    // 探测必须走 `ctx.get('tools')`，**不能**写 `ctx.tools`：`tools` 由 agent/preset
    // 作用域提供，不在本插件的 `inject` 里，而宿主 cordis 的 context 代理对未注入的
    // 属性读取是**抛错**（`cannot get property "tools" without inject`），不是返回
    // undefined。抛错点在 lifecycle effect 里，会冒泡出 `apply`，让整个插件加载失败并
    // 回滚已注册的 effect（投影与两个命令一并消失）——表现就是面板上一切命令都返回
    // 「命令没有返回结果（可能是未知命令）」。`ctx.get()` 的契约是无注入读取，未提供
    // 时返回 undefined，正是这里要的语义。
    if (typeof ctx.get('tools')?.register !== 'function') {
      ctx.logger?.warn?.('memory-context-lab: 当前作用域拿不到 ctx.tools.register，v2 只读召回工具暂未注册（服务就绪后会自动注册）')
    }
    const toolFiber = ctx.inject(['tools'], (inner) => {
      const disposer = registerV2RecallTool(inner, v2, sessionIdOf)
      if (disposer) inner.effect(() => disposer, 'memory-context-lab: v2 recall tool')
    })
    yield () => { try { toolFiber.dispose?.() } catch { /* best-effort teardown */ } }
  }, 'memory-context-lab lifecycle')
}

/**
 * 注册 v2 的只读召回工具。
 *
 * 契约（用户已确认的边界）：固定注册、只读、只读本会话 v2 隔离库、
 * 不重定向正式 `lingshu_cg`、不随 on/off 增删 schema、不隐藏任何原工具。
 * 宿主没给 `ctx.tools.register` 时返回 null（调用方跳过），不伪造半成品注册路径。
 */
function registerV2RecallTool(ctx, runtime, sessionIdOf) {
  if (!ctx.tools || typeof ctx.tools.register !== 'function') {
    ctx.logger?.warn?.('memory-context-lab: 宿主未提供 ctx.tools.register，v2 只读召回工具未注册')
    return null
  }
  try {
    return ctx.tools.register(createV2RecallTool({ runtime, sessionIdOf }))
  } catch (error) {
    ctx.logger?.warn?.(`memory-context-lab: v2 只读召回工具注册失败：${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

// cordis 只从插件对象本身读 Config（runtime.Config = plugin.Config），
// 顶层 `export const Config` 不会生效，必须挂到 apply 上，设置域才会 serve 本命名空间。
apply.Config = Config
