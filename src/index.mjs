import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { realpathSync } from 'node:fs'
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
  parseNumericSetting,
  parseOperation,
  PRESET_RESET_WORDS,
  renderRecallBlock,
  resolvePreset,
  SettingsError,
} from './core.mjs'
import { cleanDecision, recallQueryFrom } from './apply.mjs'
import { createEngine } from './apply-engine.mjs'
import { createMemoryContextLabProjection } from './projection.mjs'
import { TemporaryLingshuClient } from './lingshu-lab-client.mjs'
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
    archiveBatchSize: SCHEMAS.natural().max(200).default(5)
      .i18n({ 'zh-CN': '归档批量阈值', en: 'Archive batch size' }),
    auto: SCHEMAS.boolean().default(true)
      .i18n({ 'zh-CN': '自动降温', en: 'Auto cooling' }),
    autoRecall: SCHEMAS.boolean().default(true)
      .i18n({ 'zh-CN': '命中回注', en: 'Recall on hit' }),
    autoRestore: SCHEMAS.boolean().default(true)
      .i18n({ 'zh-CN': '停用时恢复原文', en: 'Restore originals on disable' }),
  }
  return SCHEMAS.object({
    defaults: SCHEMAS.object(settingFields)
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
  '/memory-lab preset              查看全局预设与可用预设列表。',
  '/memory-lab preset <名称>|reset 应用整组预设；reset 回到全局预设。新增/改名/编辑在设置页。',
  '/memory-lab now                 立即测量并按当前规则归档一批。',
  '/memory-lab dry-run             只做估算与候选选择，零副作用。',
  '/memory-lab restore             把与回执一致且活动面稳定的操作恢复为原文。',
  '/memory-lab clean               删除本会话的隔离数据（有未恢复回执时会拒绝）。',
  '',
  '归档单位是「一次完整操作」：助手的工具调用（含参数）加对应的工具结果，整体换成一条回执。',
  '**保留最近 N 个操作是唯一触发线**：不管占用率多少，更旧的操作攒够批量阈值就归档。',
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

  const engine = createEngine({
    persist,
    nodeIdFor: (record, ordinal) => archiveNodeId(record.state.key, ordinal),
    hostVersion: HOST_VERSION,
    services,
    logger: ctx.logger,
    createClient: async (record) => {
      if (!dependencies.lingshuPackageRoot) {
        throw new Error(`隔离冷库不可用：${dependencies.startupError instanceof Error ? dependencies.startupError.message : '未定位到 @furongjun1999/dsh-memory。'}`)
      }
      return TemporaryLingshuClient.create({
        storeRoot: record.directory,
        lingshuPackageRoot: dependencies.lingshuPackageRoot,
        sessionId: record.sessionId,
      })
    },
  })

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
        const total = engine.pendingReceipts(record)
          .reduce((sum, row) => sum + (Number(row.originalTokens) || 0), 0)
        try {
          const occupancy = await engine.measureOccupancy(record, signal)
          if (occupancy.host.assembledTokens + total > occupancy.host.contextWindow) {
            refused = {
              total,
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
    const remaining = engine.pendingReceipts(record).length
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
    return { before, restored, skipped: before - restored - remaining, remaining, removed, refused }
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
  })

  // ── Command surface ──────────────────────────────────────────────────────
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
      return { kind: 'success', text: engine.formatStatus(record) }
    }

    if (operation === 'on') {
      if (remainder) return { kind: 'error', text: '用法：/memory-lab on' }
      if (records.get(sessionId)) return { kind: 'success', text: engine.formatStatus(records.get(sessionId)) }
      try {
        const record = await runMaintenance(invocation, async () => {
          const existing = await readSessionState(labRoot, sessionId)
          // Seed from the log, not from the defaults: a `set` issued before `on`
          // is still the user's latest intent, and the panel already shows it.
          const folded = settingsFromSessionLog(invocation.agent.session, buildFoldContext())
          const created = existing ?? await createSessionState(labRoot, sessionId, folded ?? resolveDefaultsSettings())
          if (folded) created.state.settings = folded
          created.state.enabled = true
          await writeSessionState(created.directory, created.state)
          const made = makeRecord({
            agent: invocation.agent,
            sessionId,
            directory: created.directory,
            state: created.state,
          })
          records.set(sessionId, made)
          absent.delete(sessionId)
          return made
        })
        ctx.logger.info(`memory-context-lab: enabled for session ${sessionId}`)
        // Enabling never touches the cold store, so a missing or incompatible
        // dsh-memory must not block it. The degradation is reported here and
        // again by any archive attempt, which is where it actually matters.
        const degraded = dependencies.startupError
          ? `\n\n注意：隔离冷库当前不可用（${dependencies.startupError instanceof Error ? dependencies.startupError.message : String(dependencies.startupError)}）。设置与状态照常工作，但归档与回注会在尝试时失败关闭，不会改写任何会话内容。`
          : ''
        return { kind: 'success', text: `已在本会话启用上下文降温。\n\n${engine.formatStatus(record)}${degraded}` }
      } catch (error) {
        return { kind: 'error', text: `未启用降温：${error instanceof Error ? error.message : String(error)}` }
      }
    }

    if (operation === 'off') {
      if (remainder) return { kind: 'error', text: '用法：/memory-lab off' }
      const record = records.get(sessionId) ?? await adopt(invocation.agent)
      if (!record) {
        const notice = damagedNotice(sessionId)
        if (notice) return notice
        // A directory can outlive the enable (an earlier run, or a resume in a new
        // process). Reclaim it when nothing depends on it, so `off` is idempotent
        // and never leaves plugin data behind.
        const leftover = await readSessionState(labRoot, sessionId)
        if (leftover && !leftover.state.archive.some((row) => row.status === 'applied')) {
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
          lines.push(
            `已停用降温。但恢复会让组装输入超出模型窗口（当前约 ${outcome.refused.assembled} + 待恢复约 ${outcome.refused.total} > 窗口 ${outcome.refused.window}），`,
            '因此**没有**恢复，原文仍在冷库里。要回到正常会话，请先缩小上下文，或直接丢弃冷库：',
            '  /memory-lab clean confirm delete-session',
          )
        } else {
          if (outcome.restored > 0) lines.push(`已恢复 ${outcome.restored} 个操作的原文。`)
          if (outcome.skipped > 0) lines.push(`有 ${outcome.skipped} 个未能恢复（回执已变化或冷节点不可读），它们仍依赖冷库。`)
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
        return { kind: 'error', text: '用法：/memory-lab set retain 10 | batch 10 | auto on|off | recall on|off | autorestore on|off' }
      }
      const record = records.get(sessionId) ?? await adopt(invocation.agent)
      if (!record) {
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
        return { kind: 'error', text: '请先使用 /memory-lab on 在当前会话启用降温。' }
      }
      try {
        return await runMaintenance(invocation, (signal) => engine.runOnce(record, signal, { dryRun: operation === 'dry-run' }))
      } catch (error) {
        return { kind: 'error', text: `操作失败（原文未作静默删除）：${error instanceof Error ? error.message : String(error)}` }
      }
    }

    if (operation === 'restore') {
      const record = records.get(sessionId) ?? await adopt(invocation.agent)
      if (!record) {
        const notice = damagedNotice(sessionId)
        if (notice) return notice
        return { kind: 'error', text: '请先使用 /memory-lab on 在当前会话启用降温。' }
      }
      if (remainder) return { kind: 'error', text: '用法：/memory-lab restore' }
      try {
        return await runMaintenance(invocation, () => engine.runRestore(record))
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
          const pending = rows.filter((row) => row.status === 'applied').length
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
    try {
      const record = await adopt(agent)
      if (record) {
        const outcome = await engine.runAutoCooling(record, signal)
        if (outcome.action === 'applied') {
          ctx.logger.info(`memory-context-lab: archived ${outcome.applied} operations (~${outcome.releasedTokens} tokens)`)
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
    try {
      const record = await adopt(agent)
      if (!record || !engine.settingsOf(record).autoRecall) return decision
      // Nothing archived means nothing to recall, and a search would only
      // surface unrelated cold-store content while permanently growing history.
      if (engine.pendingReceipts(record).length === 0) return decision
      const query = recallQueryFrom(decision.messages)
      if (!query || record.recallQueryId === query.id) return decision
      // Remember the attempt either way: a failed search must not be retried on
      // every step of the same turn.
      record.recallQueryId = query.id
      const digest = await engine.buildRecall(record, query.text.slice(0, MAX_RECALL_QUERY_CHARS), signal)
      if (!digest) return decision
      const text = escapePromptBraces(renderRecallBlock(digest))
      return {
        ...decision,
        messages: [...decision.messages, {
          id: randomUUID(),
          role: 'user',
          content: [{ type: 'text', text }],
          source: { kind: PACKAGE_NAME, form: 'recall' },
        }],
      }
    } catch (error) {
      // Recall is an enhancement: a cold-store failure must never fail the
      // request, and it must never leave a partially folded decision.
      ctx.logger.warn(`memory-context-lab: recall skipped: ${error instanceof Error ? error.message : String(error)}`)
      return decision
    }
  }, { prepend: true })

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
  }

  ctx.effect(function* memoryContextLabLifecycle() {
    yield async () => {
      await Promise.allSettled([...activeOperations])
      disposeAutoCooling()
      disposeRecall()
      disposeArchiveWatch()
      for (const record of records.values()) {
        try { await disposeRecord(record) } catch { /* best-effort teardown */ }
      }
      records.clear()
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
  }, 'memory-context-lab lifecycle')
}

// cordis 只从插件对象本身读 Config（runtime.Config = plugin.Config），
// 顶层 `export const Config` 不会生效，必须挂到 apply 上，设置域才会 serve 本命名空间。
apply.Config = Config
