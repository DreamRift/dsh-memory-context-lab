/**
 * 记忆上下文插件 · 装配入口（0.13.1 单引擎）
 *
 * 0.13.1 起插件只有**一个引擎**：全历史按需记忆化（v2）。v1 引擎、v1 账本、
 * 双引擎互斥台账与 v1 命令面已全部移除。
 *
 * 本文件的职责收敛为四件事：
 *   1. 读配置、装配检索后端与 v2 运行时；
 *   2. 挂载 agent/pre-step 钩子（计划先行、自动降温、回注、工作状态卡）；
 *   3. 注册**一条**命令 `/memory-lab` 与固定只读召回工具；
 *   4. 会话归档时恢复原文并停用。
 *
 * 行为逻辑一律在引擎里（`v2/runtime.mjs` 与共享降温管线），本文件不实现业务规则。
 */

import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  COMMAND_NAME,
  DEFAULT_SETTINGS,
  escapePromptBraces,
  PACKAGE_NAME,
  parseOperation,
} from './core.mjs'
import { recallQueryFrom } from './apply.mjs'
import { createMemoryContextLabProjection } from './projection.mjs'
import { appendStateRecord, stateRecordDataOf } from './authoritative-state.mjs'
import { getEngineRegistry } from './v2/engine.mjs'
import { createV2Runtime } from './v2/runtime.mjs'
import { v2SessionDirectoryFor } from './v2/store.mjs'
import { createCompositeRetrievalBackendProvider } from './v2/retrieval-backend-provider.mjs'
import { createPlanFirst } from './plan-first.mjs'
import { createV2RecallTool } from './v2/tool.mjs'
import { labRootFor } from './storage.mjs'
import { globalSuppressionCoordinator, locatePinnedDshMemory } from './dsh-memory-suppression.mjs'

export const name = 'memory-context-lab'

// `tools` 故意**不**放进 inject：它是 agent/preset 作用域提供的服务，而本插件挂在
// profile 作用域；写成硬依赖会让整个插件在拿不到该服务时加载失败。改为反应式注入
// `ctx.inject(['tools'], …)`，拿不到就跳过工具注册并告警（工具集恒定的要求）。
export const inject = ['commands', 'sessionProjections']

const requireFromPlugin = createRequire(import.meta.url)

/**
 * 加载插件自带的 schemastery 分叉，用于设置页 schema。
 *
 * 安装到 profile 后裸说明符解析不到（Node 会沿 `.dsh/profiles/desktop/node_modules`
 * 向上找，那里没有 `@deepseek-ai`），所以再试一次本模块 realpath 旁的 `node_modules`。
 * 加载不到时插件照常工作：`Config` 保持 undefined，宿主不 serve 设置命名空间，
 * 只有全局默认与预设编辑器缺席。
 */
function loadSchemastery() {
  const candidates = []
  try { candidates.push(requireFromPlugin('@deepseek-ai/schemastery')) } catch {}
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

/** 加载插件自带的 cosmokit 分叉，用于共享 volatile 引用协议。 */
function loadCosmokit() {
  const candidates = []
  try { candidates.push(requireFromPlugin('@deepseek-ai/cosmokit')) } catch {}
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

/** 宿主可能把 volatile 字段以引用形态交出；读取一律经过本函数，普通值原样返回。 */
function unwrapVolatile(value) {
  return KIT?.isVolatile(value) ? value.get() : value
}

function buildConfigSchema() {
  if (!SCHEMAS) return undefined
  return SCHEMAS.object({
    defaults: SCHEMAS.object({
      // 降温开关与批量阈值。
      // N-08：设置页一直在编辑 retainOperations 与 fullHistory，但两者**从未声明进
      // schema**——靠 schemastery 对未知键的宽容才活下来。一旦宿主收紧校验或走
      // simplify() 回写，用户勾选的「全历史记忆上下文」会直接消失。这里显式声明。
      retainOperations: SCHEMAS.natural().max(200).default(DEFAULT_SETTINGS.retainOperations)
        .i18n({ 'zh-CN': '保留最近操作数', en: 'Retain recent operations' }),
      fullHistory: SCHEMAS.boolean().default(false)
        .i18n({ 'zh-CN': '全历史记忆上下文', en: 'Full-history memory context' }),
      archiveBatchSize: SCHEMAS.natural().max(200).default(DEFAULT_SETTINGS.archiveBatchSize)
        .i18n({ 'zh-CN': '归档批量阈值', en: 'Archive batch size' }),
      auto: SCHEMAS.boolean().default(true)
        .i18n({ 'zh-CN': '自动降温', en: 'Auto cooling' }),
      autoRecall: SCHEMAS.boolean().default(true)
        .i18n({ 'zh-CN': '命中回注', en: 'Recall on hit' }),
      autoRestore: SCHEMAS.boolean().default(true)
        .i18n({ 'zh-CN': '停用时恢复原文', en: 'Restore originals on disable' }),
      protectBudgetTokens: SCHEMAS.natural().max(2000000).default(32768)
        .i18n({ 'zh-CN': '软保护预算（估算 token）', en: 'Soft protection budget (estimated tokens)' }),
      planFirst: SCHEMAS.boolean().default(false)
        .i18n({ 'zh-CN': '新会话计划先行', en: 'Plan first in new sessions' }),
      // 压力闸门阈值。**不进 settingFields**——它是阈值不是档位。
      // 范围与 core 的 NUMERIC_SETTINGS.pressure（0..95）同域，由 config-contract 守卫。
      pressureGate: SCHEMAS.natural().max(95).default(DEFAULT_SETTINGS.pressureGate)
        .i18n({
          'zh-CN': '压力闸门阈值（占用率 %，0 = 无压力也降温）',
          en: 'Pressure gate threshold (% occupancy; 0 = no gate)',
        }),
      shareL2Content: SCHEMAS.boolean().default(false)
        .i18n({ 'zh-CN': '层级卡共享正文摘录（默认关）', en: 'Share member excerpts in hierarchy cards (default off)' }),
      compressModelDefault: SCHEMAS.boolean().default(false)
        .i18n({ 'zh-CN': '层级压缩模型模式（默认关，失败自动落回程序摘要）', en: 'Hierarchy compression model mode (default off; falls back to program summaries)' }),
      // 检索后端显式指定：auto = 自动梯队（T2 灵枢优先、失败降级 T1）；
      // local-lexical-v1 = 不尝试 T2；lingshu-mdcg-receipt = 强制 T2，不可用即失败关闭。
      retrievalBackend: SCHEMAS.union([
        SCHEMAS.const('auto'),
        SCHEMAS.const('local-lexical-v1'),
        SCHEMAS.const('lingshu-mdcg-receipt'),
      ]).default('auto')
        .i18n({ 'zh-CN': '检索后端选择', en: 'Retrieval backend' }),
    })
      .volatile()
      .i18n({ 'zh-CN': '全局默认设置', en: 'Global defaults' }),
  })
}

export const Config = buildConfigSchema()

/** 探测运行中宿主的版本，不假设；探测失败如实记 `unknown`。 */
function probeHostVersion() {
  try {
    return String(requireFromPlugin('@deepseek-ai/dsh-session/package.json')?.version ?? 'unknown')
  } catch {
    return 'unknown'
  }
}

const HOST_VERSION = probeHostVersion()

function sessionIdOf(session) {
  const raw = session?.id
  if (typeof raw !== 'string' || !raw.trim()) throw new Error('DSH 未提供当前会话标识，已拒绝启用降温。')
  return raw.trim()
}

export async function apply(ctx, config) {
  const labRoot = labRootFor()
  const activeOperations = new Set()

  /** 全局默认设置（设置页），与 normalizeSettings 同口径收敛。 */
  function resolveDefaultsSettings() {
    return unwrapVolatile(config?.defaults) ?? DEFAULT_SETTINGS
  }

  function resolvePlanFirstDefault() {
    return unwrapVolatile(config?.defaults)?.planFirst === true
  }

  /** 设置页的「全历史记忆上下文」全局默认（N-08b）：新会话账本按它播种。 */
  function resolveFullHistoryDefault() {
    return unwrapVolatile(config?.defaults)?.fullHistory === true
  }

  function resolveCompressModelDefault() {
    return unwrapVolatile(config?.defaults)?.compressModelDefault === true
  }

  function resolveShareL2ContentDefault() {
    return unwrapVolatile(config?.defaults)?.shareL2Content === true
  }

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

  /** 可选宿主服务查询：永不作为硬依赖，缺失时降级而不是加载失败。 */
  const services = { get: (service) => ctx.get(service) }

  const retrievalBackendMode = (() => {
    const raw = unwrapVolatile(config?.defaults)?.retrievalBackend
    return raw === 'local-lexical-v1' || raw === 'lingshu-mdcg-receipt' ? raw : 'auto'
  })()

  // lingshu-backend 动态加载：主装配路径与 T2 实现解耦，模块加载失败走
  // startupError 失败关闭路径，不拖垮插件加载。
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

  const projection = createMemoryContextLabProjection({
    getDefaults: resolveDefaultsSettings,
    planFirstDefault: resolvePlanFirstDefault,
  })

  const planFirst = createPlanFirst({ services: ctx, logger: ctx.logger })

  /** 读本插件投影的 planFirst 开关位（从会话日志折叠，不依赖引擎账本）。 */
  function readProjectionPlanFirst(session) {
    try {
      return ctx.sessionProjections?.stateOf?.(session, 'memoryContextLab')?.planFirst === true
    } catch {
      return false
    }
  }

  const v2 = createV2Runtime({
    labRoot,
    services,
    logger: ctx.logger,
    hostVersion: HOST_VERSION,
    sessionIdOf: (session) => sessionIdOf(session),
    recallQueryFrom,
    defaultSettings: resolveDefaultsSettings,
    // N-08b：这条全局默认此前从未注入 → 恒走 runtime 的缺省 `() => false`，
    // 「全历史记忆上下文」对**新会话**完全无效（设置从头到尾是个空开关）。
    defaultFullHistory: resolveFullHistoryDefault,
    defaultCompressModel: resolveCompressModelDefault,
    defaultShareL2Content: resolveShareL2ContentDefault,
    // 宿主没有已核验的插件侧 LLM 调用契约 → 解析点恒返回 null，
    // 模型模式全链路按程序档工作（失败关闭）。未来接入时只改这里。
    modelPhaseResolver: () => null,
    onEnabled: (agent) => (readProjectionPlanFirst(agent.session) ? planFirst.enterIfFresh(agent) : null),
    onPlanFirstToggle: (agent, value) => (value ? planFirst.enterIfFresh(agent) : planFirst.exitIfActive(agent)),
    coordinator: dependencies.coordinator,
    // 闸门失败的原因要一路带到 `on` 回执与 `status`：抑制没装上必须说「未启用 + 原因」，
    // 而不是继续宣称「已抑制」（0.13.2 D-04）。
    suppressionUnavailableReason: dependencies.startupError instanceof Error
      ? `dsh-memory 兼容性闸门未通过：${dependencies.startupError.message}`
      : null,
    // 同步取用：检索热路径不会隐式起子进程（只在 `/memory-lab index sync` 时启动）。
    semanticBackendFor: ({ sessionId, storeRoot }) => retrievalBackend.backendFor({ sessionId, storeRoot }),
    semanticBackendEnsure: ({ sessionId, storeRoot, signal }) => retrievalBackend.ensureBackend({ sessionId, storeRoot, signal }),
    semanticBackendClose: ({ sessionId }) => retrievalBackend.close(sessionId),
    semanticBackendStatus: () => retrievalBackend.describe(),
    backendPrecheck: () => (retrievalBackendMode === 'lingshu-mdcg-receipt' ? retrievalBackend.precheck() : { ok: true }),
    semanticBackendFailure: ({ sessionId }) => retrievalBackend.failureReason({ sessionId }),
    semanticBackendCloseAll: () => retrievalBackend.closeAll(),
  })

  /**
   * 把「命令跑完之后的真实状态」写成一条权威记录。
   *
   * 宿主对每次斜杠命令都会记一条 command/run，投影按命令行折叠——命令被拒绝时
   * 它照样翻开关，面板与真实状态相反。这里在命令**结束后**（成功或失败都写）
   * 追加一条插件记录，值取自当时的引擎状态而不是命令意图；投影以它为准。
   * 宿主拿不到 appendPluginRecord 时返回 ok:false，由调用方如实说明并退回按命令行折叠。
   */
  function recordAuthoritativeState(agent) {
    try {
      const session = agent?.session
      if (!session) return { ok: false, reason: '当前会话不可用' }
      const sessionId = sessionIdOf(session)
      const record = v2.records.get(sessionId) ?? null
      const stored = record?.state ?? null
      let engine = ''
      try {
        engine = getEngineRegistry(labRoot, sessionId).holder === 'v2' ? 'v2' : ''
      } catch {
        engine = record ? 'v2' : ''
      }
      const enabled = record ? record.state?.enabled !== false : engine !== ''
      const data = stateRecordDataOf({ enabled, engine, state: stored ?? {} })
      return appendStateRecord(session, data, { requireFromPlugin })
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * 命令是否可能改变投影状态（开关位、引擎归属、设置）。
   *
   * 只读命令不动状态，不必追加权威记录——每条都写会让日志无谓变长，
   * 也会让前缀缓存白白多一段字节。
   */
  const STATE_CHANGING = new Set(['on', 'off', 'set', 'restore', 'forget', 'compress', 'expand'])

  function operationOf(invocation) {
    try {
      return parseOperation(invocation?.rawInput ?? invocation?.input ?? '').operation
    } catch {
      return ''
    }
  }

  async function commandHandler(invocation) {
    const pending = v2.commandHandler(invocation)
    activeOperations.add(pending)
    pending.finally(() => activeOperations.delete(pending)).catch(() => {})
    let result
    try {
      result = await pending
    } finally {
      // 成功或失败都写：命令被拒绝时读到的仍是「开着」，面板不会翻转。
      if (STATE_CHANGING.has(operationOf(invocation))) {
        const written = recordAuthoritativeState(invocation?.agent)
        if (!written.ok && result && typeof result === 'object' && result.kind === 'success') {
          result = {
            ...result,
            text: result.text + '\n（未能写入权威状态记录：' + written.reason + '；面板按命令行折叠，可能与真实状态不符。）',
          }
        }
      }
    }
    return result
  }

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

      // (2) 计划批准退出（planActive true→false）→ 自动启用降温。
      //     只在尚未启用时触发；启用失败（如后端预检不过）按静默跳过处理，
      //     用户仍可手动 `/memory-lab on` 拿到完整错误。
      const activeNow = planFirst.planStateOf(agent).active === true
      const activeBefore = lastObservedPlanActive.get(sessionId)
      lastObservedPlanActive.set(sessionId, activeNow)
      if (activeBefore === true && activeNow === false && !autoEnabledCoolingSessions.has(sessionId)) {
        autoEnabledCoolingSessions.add(sessionId)
        if (!v2.records.get(sessionId)) {
          try {
            const outcome = await v2.enable({ agent, signal })
            if (outcome?.kind === 'success') {
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



  const disposeAutoCooling = ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next()
    if (decision?.kind !== 'enter' || signal?.aborted) return decision
    // 与 v1 同一条挂起规则：计划模式激活期间自动降温 no-op。
    const suspension = planFirst.coolingSuspensionFor(agent)
    if (suspension.suspended) {
      ctx.logger.info(`memory-context-lab: ${suspension.reason}`)
      return decision
    }
    try {
      const outcome = await v2.autoCooling(agent, signal)
      if (outcome.action === 'applied') {
        ctx.logger.info(`memory-context-lab: archived ${outcome.applied} operations (~${outcome.releasedTokens} tokens)`)
      } else if (outcome.action === 'unavailable') {
        ctx.logger.warn(`memory-context-lab: cooling unavailable: ${outcome.reason}`)
      }
    } catch (error) {
      ctx.logger.warn(`memory-context-lab: auto cooling skipped: ${error instanceof Error ? error.message : String(error)}`)
    }
    return decision
  })

  const disposeRecall = ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next()
    if (decision?.kind !== 'enter' || signal?.aborted) return decision
    // 计划模式激活期间不回注（与 v1 同规则）。
    if (planFirst.coolingSuspensionFor(agent).suspended) return decision
    try {
      return await v2.buildRecall(agent, decision, signal)
    } catch (error) {
      ctx.logger.warn(`memory-context-lab: recall skipped: ${error instanceof Error ? error.message : String(error)}`)
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
  const disposeWorkingSet = ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next()
    if (decision?.kind !== 'enter' || signal?.aborted) return decision
    // 计划模式激活期间不注入工作状态卡：计划阶段历史保持完整，卡片没有意义。
    if (planFirst.coolingSuspensionFor(agent).suspended) return decision
    try {
      const card = await v2.workingSetInjection(agent)
      if (!card) return decision
      // S3 prepare→确认→commit：pre-step 钩子返回的 decision 就是「宿主已接受
      // 本次注入」的确认面——消息被宿主实际携带进这一步，等价于已经持久化到
      // 会话批次。只有走到这里才 confirm；早退路径（skip / aborted / 抛错）
      // 不会到这里，prepared 载荷自然留在未确认账上（prepared−committed 残差）。
      v2.confirmInjection(sessionIdOf(agent.session), card.preparedId)
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
      ctx.logger.warn(`memory-context-lab: working set skipped: ${error instanceof Error ? error.message : String(error)}`)
      return decision
    }
  })



  ctx.effect(() => ctx.sessionProjections.register(projection), 'memory-context-lab: projection')

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

  /**
   * 会话被归档时恢复原文并停用（数据只读保留，不删冷库）。
   *
   * 归档的会话不会再收到请求，所以这里**不带窗口守卫**——放回原文不可能破坏
   * 下一次请求；留着回执反而会让一个没人再打开过的会话继续占用冷库。
   */
  async function archiveCleanup(sessionId) {
    try {
      const record = v2.records.get(sessionId) ?? await v2.adoptById(sessionId)
      if (!record) return
      const outcome = await v2.disableById(sessionId, 'session-archived')
      ctx.logger.info(`memory-context-lab: session archived; restored ${outcome.restored}/${outcome.before}`)
    } catch (error) {
      ctx.logger.warn(`memory-context-lab: archive cleanup skipped: ${error instanceof Error ? error.message : String(error)}`)
    }
  }



  ctx.effect(function* memoryContextLabLifecycle() {
    yield async () => {
      await Promise.allSettled([...activeOperations])
      disposePlanFirstAutomation()
      disposeAutoCooling()
      disposeRecall()
      disposeWorkingSet()
      disposeArchiveWatch()
      try { await v2.shutdown() } catch { /* best-effort teardown */ }
    }
    yield ctx.commands.register({
      definitionId: 'dsh-memory-context-lab/control',
      name: COMMAND_NAME,
      description: '记忆上下文：已完成历史沉入会话隔离冷库，按需回读，必要工作状态有界常驻',
      input: { hint: 'on | off | status | restore | now | dry-run | read <ID...> | set <key> <value> | help' },
      handler: (invocation) => commandHandler(invocation),
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
