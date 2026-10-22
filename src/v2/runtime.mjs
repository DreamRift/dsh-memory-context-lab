/**
 * v2 运行时：把 v2 存储/回读内核接进 DSH 的会话生命周期。
 *
 * 与 v1 的关系（本项目最关键的边界）：
 * - **同一会话同时只有一个引擎能替换模型可见投影**。v2 通过
 *   `claimV2Engine` 声明所有权；0.13.1 起 v1 引擎已移除，不再有反向检查；
 *   两边都在激活前检查，所以不存在「两个引擎同时投影同一会话」的窗口。
 * - **复用 v1 的降温管线，不重写**：候选收集、保留窗口、缓存统计、回执渲染、
 *   恢复路径全部走 `createEngine`（`apply.mjs` + `apply-engine.mjs`）。
 *   v2 只替换三件事：冷库客户端（本会话 v2 隔离库）、回执标记、候选门禁。
 * - **v2 自己的数据 schema 独立**：记录、载荷、事务、目录、状态文件都在
 *   `<labRoot>/v2/` 下，kind/schema 与 v1 不同，互不读取、互不覆盖。
 *
 * 本模块不注册任何模型可见工具，也不重定向正式 `lingshu_cg`。
 */

import { DEFAULT_SETTINGS, buildReceipt, buildSpanReceipt, RECEIPT_FORMAT_OPERATION, RECEIPT_FORMAT_SPAN_V2, V2_RECEIPT_MARKER } from '../core.mjs'
import { createEngine } from '../apply-engine.mjs'
import { createForgetCommand, createForgetDomain } from './runtime-forget.mjs'
import { createLifecycleDomain } from './runtime-lifecycle.mjs'
import { createCardDomain } from './runtime-card.mjs'
import { createReadDomain } from './runtime-read.mjs'
import { createRecallDomain } from './runtime-recall.mjs'
import { createForkDomain } from './runtime-fork.mjs'
import { createSettingsDomain } from './runtime-settings.mjs'
import { createCompressDomain } from './runtime-compress.mjs'
import { createCoolingDomain, createRunNow } from './runtime-cooling.mjs'
import { classifyRange } from './guard.mjs'
import { bodyOfSpan, collectHistoryCandidates, spanLabelOf, SPAN_KINDS } from './history.mjs'
import { claimV2Engine } from './engine.mjs'
import { createV2ClientFactory } from './client-adapter.mjs'
import { maybeStageCompress } from './hierarchy-coordinator.mjs'
import { v2SessionDirectoryFor, writeV2SessionState } from './state.mjs'
import { parseBudgetTokens, RECALL_DEFAULT_BUDGET_TOKENS, RECALL_MAX_BUDGET_TOKENS, RECALL_MAX_QUERY_HITS, WORKING_SET_MAX_BUDGET_TOKENS } from './budget.mjs'
import { getForgetIndex, nodeUnitBase } from './disposition.mjs'

/**
 * 单回合长任务里的回注触发（0.13.1 F5）。
 *
 * 旧实现只在**新的人类提示**上触发回注：`recallQueryFrom` 取不到 query 就
 * 直接返回。实测会话 c1787f24 是 1 个回合 120 步——全程没有第二次人类输入，
 * 于是自动回注 0 次，而同期归档了 59 个操作。模型只能自己回盘重读文件。
 *
 * 新增两个补充触发点，都受 `autoRecall` 开关与去重约束：
 *   1. **重读同一文件**：连续 read 同一 file_path 通常意味着「刚才的原文
 *      已被归档、模型在凭记忆重建」——这正是该回注的时刻；
 *   2. **步数兜底**：同一回合内每 N 步最多一次，避免长任务彻底没有回注。
 *
 * 两者都只生成**查询词**，不改变注入形态；命中与否仍由检索面决定。
 */
const RECALL_STEP_FALLBACK = 15

export const V2_COMMAND_NAME = 'memory-lab'

/** 只读召回与工作集的预算上限统一在 `budget.mjs`（本文件只做再导出）。 */
export {
  RECALL_DEFAULT_BUDGET_TOKENS,
  RECALL_MAX_BUDGET_TOKENS,
  RECALL_MAX_QUERY_HITS,
  WORKING_SET_MAX_BUDGET_TOKENS,
}

export const V2_HELP = [
  '记忆上下文：全历史按需记忆化——把已完成操作换成小回执、正文沉入会话隔离冷库，',
  '原文随时按记录 ID 回读。插件只有一个引擎（v1 已于 0.13.1 移除）。',
  '',
  '【生命周期】',
  '/memory-lab on                 启用：本会话历史进入隔离库，已完成操作可退出热上下文',
  '/memory-lab off [原因]         停用：恢复所有已替换区间，历史转只读保留',
  '/memory-lab restore            恢复全部可恢复的回执原文，引擎保持启用（不停用）',
  '/memory-lab status             当前状态、记录数、在途配对、最近一次动作',
  '/memory-lab now                立刻执行一次降温（不等自动触发线）',
  '/memory-lab dry-run            只规划不落库：报告会降温哪些范围、被门禁拦下哪些',
  '',
  '【回读与检索】',
  '/memory-lab read <记录ID...>   按稳定 ID 精确回读原文（可多个，逗号或空格分隔）',
  '/memory-lab recall <查询词>    字面检索（ID/kind/工具名/callId/范围）；只读，不返回分数',
  '/memory-lab recall id <记录ID...> [预算]   与模型可见只读工具同一条路径的精确回读',
  '/memory-lab history [页大小 1..2000] [记录ID之后]  分页列出已落库记录（只读，不含正文）',
  '/memory-lab working-set [token预算]         按预算装包当前工作集（含在途配对与显式 ID）',
  '/memory-lab card [token预算]   渲染有界工作状态卡（就是注入主模型的那份文本）',
  '/memory-lab index [sync]       语义检索后端的增量索引状态/同步（未注入后端时如实报告）',
  '/memory-lab relations <记录ID> 只报可验证的结构关系：配对、fork 迁移、索引外部 ID',
  '',
  '【证据与失效】',
  '/memory-lab verify <记录ID...> 验证跟踪：核对记录引用的文件与归档时是否一致（三态，只读）',
  '/memory-lab mark-stale <记录ID> <原因>   人工把记录标记为失效（只写旁证，不改不可变记录）',
  '',
  '【主动遗忘】',
  '/memory-lab forget preview <目标…> 预览软遗忘：目标=记录ID|nodeId|callId|kind=片段|before=<记录ID>',
  '                                  宽条件必须先预览拿计划ID；硬保护目标会被拦截并列出',
  '/memory-lab forget apply <计划ID|目标…> 提交软遗忘（回执换墓碑、读面不再泄漏、可 undo）',
  '/memory-lab forget undo <操作ID>   撤销一次遗忘：只恢复可见性，原文回注仍需显式 restore',
  '/memory-lab forget status [操作ID] 账本与收口状态：操作清单、待收口条目、隔离灵枢残留披露',
  '',
  '【层级压缩（默认关）】',
  '/memory-lab compress preview   预览：连续回执组 → 聚合凭证候选与 no-safe-gain 报告',
  '/memory-lab compress run       按事务序提交压缩：凭证替换、层级账本落盘、可重复收口',
  '/memory-lab compress status    层级账本状态：L0–L3 与凭证清单（只读，未启用也能查）',
  '/memory-lab expand <凭证ID> [页] 分页展开聚合凭证成员原文（恒定只读面，不替换任何投影）',
  '',
  '【会话迁移】',
  '/memory-lab fork <子会话ID>    把本会话闭包迁移给子会话；迁移后核对指纹，不一致则标记 needs-migration',
  '/memory-lab fork-status        只读预览：本会话闭包多大、能不能搬、有什么告警',
  '/memory-lab fork-reset <子会话ID>  清掉 fork 半成品子库（仅限带 needs-migration 标记），使失败可重试',
  '',
  '【设置与诊断】',
  '/memory-lab set <键> <值>      键位：auto | recall | autorestore | batch | retain | readlease |',
  '                               pressure | protect | fullhistory | compress | compressmodel |',
  '                               sharel2content | planfirst',
  '/memory-lab cost               成本账本：注入/重读/批次数与 token 量（含缓存失效口径）',
  '/memory-lab clean confirm delete-session   丢弃本会话隔离冷库（不可撤销；须先 off）',
  '/memory-lab help               本帮助',
  '',
  '全历史记忆上下文（set fullhistory on）：除系统头、人类消息、凭证、计划工件外全部退热；',
  '「保留最近操作」随之失效（面板变灰），保留由证据保护层裁决。',
  '读取租约（set readlease N）：最近 N 个含读取结果的操作保留 M=2N 步（0=关闭），是带 TTL 的租约。',
  '停用时恢复原文（set autorestore on|off）：off = 停用只关引擎、原文留在冷库；',
  '  窗口守卫照常生效（它保护模型窗口，与这个开关无关）。恢复用 restore 或先 on 再 restore。',
  '软保护预算（set protect N）：活跃证据保护层每轮可用的估算 token 上界，0 = 只保留硬保护。',
].join('\n')

/** v2 归档节点的稳定 ID 前缀：与 v1 的 `archiveNodeId` 形状不同，两库节点 ID 不会撞车。 */
export function v2ArchiveNodeId(sessionKey, ordinal) {
  return `mcl2-${sessionKey}-${String(ordinal).padStart(6, '0')}`
}

/**
 * 解析 `/memory-lab` 的输入。
 * 操作面与命令解析独立实现（read/history/working-set 等子命令），
 * 共用解析器会让两边命令语义互相牵连。
 */
export function parseV2Operation(rawInput) {
  const text = typeof rawInput === 'string' ? rawInput.trim() : ''
  if (!text) return { operation: 'help', args: [] }
  const parts = text.split(/\s+/)
  const operation = parts[0].toLowerCase()
  return { operation, args: parts.slice(1), rest: text.slice(parts[0].length).trim() }
}

/** 回执与卡片里用的 seq 区间写法（两种破折号都给，便于模型照抄检索）。 */

/**
 * 创建 v2 运行时。
 *
 * 依赖全部由宿主注入（index.mjs），因此本模块可在测试里用假宿主直接驱动，
 * 不需要加载 DSH 运行时。
 */
export function createV2Runtime(dependencies) {
  const {
    labRoot,
    services,
    logger,
    hostVersion,
    sessionIdOf,
    recallQueryFrom,
    defaultSettings = () => DEFAULT_SETTINGS,
    // 设置页的全局默认（全历史记忆上下文）。缺省 false：v2 启用时若无旧账本值，
    // 按这里播种；返回真值时引擎直接以全历史模式运行。
    defaultFullHistory = () => false,
    // 层级压缩模型模式的全局默认（设置页）。缺省 false：旧账本无该字段时
    // 播种为关；只在值缺失时补，绝不覆盖用户在本会话写下的选择。
    defaultCompressModel = () => false,
  // T1/F-03：层级卡共享正文摘录的全局默认（失败关闭：默认不共享）。
  defaultShareL2Content = () => false,
    // 模型相位解析点（P4）：(sessionId, { signal }) => { stream, model, timeoutMs,
    // cacheLookup, cacheSave, onUsage } | null。宿主无已核验 LLM 契约时注入方
    // 直接返回 null，全链路按程序档工作；不在此直连宿主内部。
    modelPhaseResolver = null,
    // 计划先行联动（index.mjs 注入）：v2 启用成功后回调，返回提示文本对象或 null。
    onEnabled = null,
    // 计划先行开关切换回调（agent, value) => note|null）：on 时尝试进入计划模式。
    onPlanFirstToggle = null,
    coordinator = null,
    // 抑制闸门失败的原因（index.mjs 注入）：装配不到抑制协调器时，`on` 回执与
    // `status` 必须如实写「抑制未启用 + 原因」，不得无条件宣称「已抑制」（0.13.2 D-04）。
    suppressionUnavailableReason = null,
    // 可注入的语义检索后端（灵枢）。缺省为 null：只用内置字面索引，并在
    // 结果里如实标注 `matchedBy: 'literal'`，不假装做过语义检索。
    // 注入方负责 backend 自己的会话隔离（独立隔离根 + 独立子进程）。
    semanticBackend = null,
    // 按会话解析检索后端（每个会话一个隔离根，因此后端必须按会话取用）。
    // `semanticBackend` 保留给测试直接注入单个后端；两者都给时以解析器为准。
    semanticBackendFor = null,
    // 会话停用时释放该会话的后端资源（隔离灵枢子进程）。
    semanticBackendClose = null,
    // 显式启动某会话的后端（只有 /memory-lab index 会调用）。
    semanticBackendEnsure = null,
    // 后端可用性自述（只读）：状态面照抄，避免把「没接后端」说成「检索可用」。
    semanticBackendStatus = null,
    // 某会话的启动失败原因（只读，不触发启动）。
    semanticBackendFailure = null,
    // 进程收尾时释放全部隔离灵枢子进程（含已不在册的会话）。
    semanticBackendCloseAll = null,
    // 启用前预检（index.mjs 注入，PR #4 端口二）：显式指定 lingshu 后端且不可用时
    // 拒绝启用（EBACKENDUNAVAILABLE），不静默降级。返回 Error 或 null。
    backendPrecheck = null,
    // 层级压缩阶段钩子的可注入点（BUG-004）：生产默认走真实
    // maybeStageCompress；测试可注入替身观察「确实被调用」，避免只验证
    // 静态 import 文本。缺省 null = 使用真实实现。
    stageCompress = null,
  } = dependencies

  /** sessionId → v2 会话记录（只在启用时存在）。 */
  const records = new Map()
  /** sessionId → 客户端工厂（每个会话一个，持有自己的 store 句柄）。 */
  const factories = new Map()
  /** 正在执行的会话操作，用于退出时等待。 */
  const activeOperations = new Set()

  const engine = createEngine({
    persist: async (record) => {
      await writeV2SessionState(record.directory, record.state)
    },
    nodeIdFor: (record, ordinal) => v2ArchiveNodeId(record.state.key, ordinal),
    hostVersion,
    services,
    logger,
    // v2 的回执标记与 v1 不同：日志里能直接看出哪套引擎替换了这段历史。
    receiptMarker: V2_RECEIPT_MARKER,
    createClient: async (record) => factoryFor(record).createClient(),
    // P2 软遗忘：恢复守卫按行级 nodeId 对账 disposition 账本（权威）。
    // 账本按记录 ID 键控；行是 node 基名粒度，因此先经 store 条目把遗忘
    // 记录映射回 node 基名，再判定该行。账本已提交、行状态尚未收口的
    // 崩溃窗口同样拦得住；v1 不注入此依赖。
    isForgottenRow: async (record, row) => {
      if (!row?.nodeId) return false
      const forgetIndex = await getForgetIndex(record.directory)
      if (!forgetIndex.forgotten || forgetIndex.forgotten.size === 0) return false
      const entries = await collectForgetEntries(record)
      const bases = forgetNodeBasesOf(entries, [...forgetIndex.forgotten.keys()])
      return bases.has(nodeUnitBase(row.nodeId))
    },
    // 候选门禁：在租用节点 ID 之前判定，被拦下的候选不留下任何 claim。
    guardUnit: (record, candidate) => guardCandidate(record, candidate),
    // v2 的候选收集器与 v1 不同：v2 要覆盖**全历史**（普通 user/assistant 正文、
    // 旧回执、旧状态卡、旧召回包），而 v1 的收集器只认「助手工具调用 + 紧邻结果」，
    // 还会把失败结果整段跳过。改宽 v1 的收集器等于顺手改掉 v1 的行为，所以另走一个。
    collectCandidates: (view) => collectHistoryCandidates(view),
    // 提交前漂移检查按跨度种类重建正文；工具操作与普通历史段的形状不同。
    spanBodyOf: (session, unit) => bodyOfSpan(session, unit),
    // 普通历史段的回执不冒充工具操作回执：操作段照旧印工具与调用次数，其他段
    // 印「片段：用户消息/助手消息/…」。
    // 0.12.0 P0-5/P0-1/P1-5：v2 的回执走投影经济学版（format 6/7），
    // 投影头、可回读动作行、status 都由同一批既有字段渲染，不新增计算。
    receiptOf: (candidate, { nodeId, hash, marker }) => (candidate.spanKind === SPAN_KINDS.OPERATION
      ? buildReceipt({
        tools: candidate.tools,
        range: { start: candidate.rangeStart, end: candidate.rangeEnd },
        callIds: candidate.callIds,
        nodeId,
        hash,
        chars: candidate.chars,
        tokens: candidate.originalTokens,
        chunks: candidate.chunkCount ?? 1,
        marker,
        formatVersion: RECEIPT_FORMAT_OPERATION,
        releasedTokens: candidate.originalTokens,
        errorLine: candidate.firstErrorLine ?? null,
      })
      : buildSpanReceipt({
        // D4：插件自己注入的跨度（工作状态卡/回注包/回执）不冒充「用户消息」，
        // 回执标签按作者区分，模型读回执就知道那段历史是插件工作资料。
        // BUG-001：标签由候选携带（与归档行同一份），恢复侧按它逐字节重建。
        label: candidate.spanLabel ?? (candidate.pluginAuthored ? '插件工作资料' : spanLabelOf(candidate.spanKind)),
        range: { start: candidate.rangeStart, end: candidate.rangeEnd },
        nodeId,
        hash,
        chars: candidate.chars,
        tokens: candidate.originalTokens,
        chunks: candidate.chunkCount ?? 1,
        marker,
        // N-06a：格式以**候选自己携带的值**为唯一真源——候选是归档行的来源，
        // 渲染器另写一个常量就是两份清单，一旦漂移，恢复侧按行内版本重建的正文
        // 与表面逐字节不同，这类回执全部不可恢复（真实会话 58/60）。
        formatVersion: Number.isInteger(candidate.receiptFormat) ? candidate.receiptFormat : RECEIPT_FORMAT_SPAN_V2,
        releasedTokens: candidate.originalTokens,
        errorLine: candidate.firstErrorLine ?? null,
      })),
  })
  // ── 域装配（P4b / P4c）───────────────────────────────────────────────────
  // 装配顺序由依赖方向决定，不能随手换：forget 域只要 factoryFor / receiptTextOf
  // （本文件的函数声明，已提升）；lifecycle 域要用 forget 域做重启对账与停用清理；
  // card 域要用 lifecycle 域的 adopt / persistCost；read 域要用 card 域的
  // cardFromStore；compress 与 cooling 域最后装配。engine 先构造，它的回调都是
  // 惰性调用，装配完成前不会跑到这些域里。

  // 软遗忘域：表面撤回、墓碑与行状态对账。
  const {
    collectForgetEntries,
    forgetNodeBasesOf,
    planWithdrawals,
    withdrawForgottenSurfaces,
    restoreForgottenSurfaces,
  } = createForgetDomain({ factoryFor, nodeUnitBase, receiptTextOf, writeV2SessionState, getForgetIndex })

  // 会话生命周期域：记录建立与回收、启用/停用、重启对账、恢复。
  const {
    persistCost,
    adopt,
    disposeRecord,
    runExclusive,
    enable,
    disable,
    disableById,
    adoptById,
    restoreOnly,
    cleanSession,
  } = createLifecycleDomain({
    records,
    factories,
    activeOperations,
    engine,
    labRoot,
    services,
    logger,
    sessionIdOf,
    coordinator,
    suppressionUnavailableReason,
    factoryFor,
    receiptTextOf,
    backendPrecheck,
    onEnabled,
    semanticBackend,
    semanticBackendFor,
    semanticBackendClose,
    defaultSettings,
    defaultFullHistory,
    defaultCompressModel,
    defaultShareL2Content,
    collectForgetEntries,
    forgetNodeBasesOf,
    planWithdrawals,
    withdrawForgottenSurfaces,
    // 后置绑定：这两个函数由后面的 compress / cooling 域提供，但装配顺序上
    // lifecycle 在前（它要给 card / read 域提供 adopt）。它们只在停用路径被调用，
    // 那一刻装配早已完成，所以用惰性取值而不是提前解构（否则命中 TDZ）。
    compressDepsOf: (record) => compressDepsOf(record),
    invalidateLedgerForRestore: (record, outcome) => invalidateLedgerForRestore(record, outcome),
  })

  // 工作状态卡域：构建、注入裁决、宿主确认与卡组折叠。
  const {
    cardFromStore,
    cardCommand,
    workingSetInjection,
    confirmInjection,
    foldWorkingCards,
  } = createCardDomain({
    records, engine, factoryFor, adopt, lastAssistantSeqOf, parseBudgetArg,
    persistCost, logger, labRoot, sessionIdOf, services,
  })

  // 只读面域：状态、精确回读、分页历史、检索、验证跟踪、关系与成本报表。
  const {
    withReadableStore,
    readWithForkFallback,
    status,
    read,
    history,
    workingSet,
    verifyCommand,
    markStaleCommand,
    relationsCommand,
    costCommand,
  } = createReadDomain({
    records, engine, factoryFor, adopt, persistCost, cardFromStore,
    backendFor, backendForSession, labRoot, logger, sessionIdOf, recallQueryFrom,
    semanticBackendStatus, semanticBackendFailure,
    RECALL_STEP_FALLBACK, parseBudgetArg,
  })
  // 检索域：字面检索、命中归因、查询词生成、增量索引与触发判定。它要用 read 域的
  // 句柄与读取原语，所以排在 read 之后。
  const {
    recall,
    recallCommand,
    indexCommand,
    buildRecall,
  } = createRecallDomain({
    records, engine, factoryFor, adopt, persistCost,
    backendFor, backendForSession, labRoot, logger, sessionIdOf, recallQueryFrom,
    RECALL_STEP_FALLBACK, withReadableStore, readWithForkFallback, cardFromStore,
    semanticBackend, semanticBackendFor, semanticBackendEnsure, latestReadPathOf,
  })

  // 遗忘命令面：要在 lifecycle 之后装配（它用 adopt / records），但共用 forget 域
  // 的表面撤回函数实例，所以不重新构造整个 forget 域。
  const { forgetCommand } = createForgetCommand({
    records, adopt, backendForSession, factoryFor, labRoot, sessionIdOf,
    collectForgetEntries, forgetNodeBasesOf, planWithdrawals,
    withdrawForgottenSurfaces, restoreForgottenSurfaces,
  })

  // fork 迁移域：闭包预览、半成品清理与迁移提交（不碰 records / engine）。
  const { forkStatus, forkReset, forkTo } = createForkDomain({ labRoot, sessionIdOf })

  // 设置写入域：`/memory-lab set <键> <值>` 的全部键位与校验。
  const { setSetting } = createSettingsDomain({
    records, engine, adopt, logger, sessionIdOf, onPlanFirstToggle,
  })

  // 层级压缩域：凭证预览/提交/状态、分页展开，以及压缩与降温共用的依赖收集。
  const {
    compressCommand,
    expandCommand,
    compressDepsOf,
  } = createCompressDomain({
    adopt, factoryFor, labRoot, sessionIdOf, modelPhaseResolver, stageCompress,
  })

  // 降温自动钩子域：触发与执行、指纹补采、索引增量、批次记账、读取账本失效、
  // 归档读取登记与进程收尾。records / factories 传对象本体（共享注册表）。
  const {
    autoCooling,
    indexNewRecords,
    accountBatch,
    invalidateLedgerForRestore,
    shutdown,
  } = createCoolingDomain({
    records,
    factories,
    activeOperations,
    engine,
    factoryFor,
    adopt,
    disposeRecord,
    persistCost,
    logger,
    backendForSession,
    compressDepsOf,
    foldWorkingCards,
    semanticBackendCloseAll,
    semanticBackendEnsure,
    stageCompress,
  })

  // 手动降温入口（now / dry-run）：与 autoCooling 同一条执行路径，只绕过触发线。
  const { runNow } = createRunNow({
    records, engine, adopt, sessionIdOf, accountBatch, indexNewRecords,
  })

  /**
   * 取本会话的检索后端（同步、零副作用；不会隐式起子进程）。
   *
   * 只在真正要用后端时调用：`semanticBackend`（测试注入）优先，否则问解析器。
   * 解析器尚未为该会话启动后端时返回 null —— 此时检索**如实降级为字面匹配**，
   * 不会因为「后端还没起来」而谎称命中或谎称语义可用。
   *
   * 会话目录由 `v2SessionDirectoryFor` 确定性推出，因此**只读路径不需要先 adopt**
   * 就能拿到正确的隔离根：模型可见工具的回读与命令面走的是同一个后端。
   */
  function backendForSession(sessionId) {
    if (semanticBackend) return semanticBackend
    if (typeof semanticBackendFor !== 'function' || !sessionId) return null
    return semanticBackendFor({
      sessionId,
      storeRoot: v2SessionDirectoryFor(labRoot, sessionId),
    }) ?? null
  }

  function backendFor(record) {
    return backendForSession(record?.sessionId ?? null)
  }

  function factoryFor(record) {
    let factory = factories.get(record.sessionId)
    if (!factory) {
      factory = createV2ClientFactory({
        labRoot,
        sessionId: record.sessionId,
        logger,
        // 自动回注走与工具面同一条多路检索：这里把同一会话的后端解析器交给适配器，
        // 避免「模型主动读用灵枢、自动回注只做关键词」的两套形状。
        backendFor: () => backendForSession(record.sessionId),
      })
      factories.set(record.sessionId, factory)
    }
    return factory
  }

  /**
   * 主模型曝光面与配对门禁。
   *
   * 只做结构判定：范围必须全在主模型活动面上、工具调用与结果必须同范围闭合、
   * 不得包含主模型正在进行的回合。判定结果**不是**置信度、不是事实验证、
   * 也不构成安全隔离——它只回答「这段历史现在能不能退出热上下文」。
   */
  function guardCandidate(record, candidate) {
    const session = record.agent?.session
    const surfaceSeqs = session?.surface?.nodes ?? []
    const eventAt = (seq) => (typeof session?.eventAt === 'function' ? session.eventAt(seq) : null)
    const lastAssistantSeq = lastAssistantSeqOf(session)
    // 契约：planCooling 只看 `safe !== true`，拒绝时用 code/reason 说明原因。
    const verdict = classifyRange({
      eventAt,
      rangeStart: candidate.rangeStart,
      rangeEnd: candidate.rangeEnd,
      surfaceSeqs,
      lastAssistantSeq,
      // 普通历史跨度（用户/助手正文、旧卡、旧回执）本来就没有工具调用，
      // 按跨度种类显式豁免「空范围」，而不是放宽工具操作的配对要求。
      allowPlainText: candidate.spanKind !== SPAN_KINDS.OPERATION,
    })
    if (verdict?.safe !== true) {
      // 被门禁拦下的候选要计数：否则「本批释放 ≈0」看不出是没候选还是全被拒。
      record.cost?.bump?.('guardRejections', 1)
    }
    return verdict
  }

  /** 从一条宿主事件里取出回执正文；不是回执就返回 null。 */
  function receiptTextOf(event) {
    if (!event || event.type !== 'user/message') return null
    const blocks = event.data?.content
    if (!Array.isArray(blocks) || blocks.length === 0) return null
    const first = blocks[0]
    if (!first || first.type !== 'text' || typeof first.text !== 'string') return null
    return first.text
  }

  function lastAssistantSeqOf(session) {
    const nodes = session?.surface?.nodes
    if (!Array.isArray(nodes) || nodes.length === 0) return null
    for (let index = nodes.length - 1; index >= 0; index -= 1) {
      const seq = nodes[index]
      const event = typeof session?.eventAt === 'function' ? session.eventAt(seq) : null
      if (event?.type === 'assistant/message') return seq
    }
    return null
  }

  /**
   * 命令参数里的预算：命令面拿到的是字符串，先严格转成整数再交给统一校验，
   * 避免 `"abc"`、`"12.5"` 被 `parseInt` 悄悄截成别的数字。
   */
  function parseBudgetArg(raw, options) {
    if (raw === undefined || raw === null || raw === '') return parseBudgetTokens(undefined, options)
    if (typeof raw !== 'string' || !/^[0-9]+$/.test(raw.trim())) {
      return { ok: false, error: `${options?.label ?? 'budget_tokens'} 必须是正整数（收到 ${JSON.stringify(raw)}）` }
    }
    return parseBudgetTokens(Number(raw.trim()), options)
  }

  async function commandHandler(invocation) {
    const parsed = parseV2Operation(invocation.rawInput ?? invocation.input)
    switch (parsed.operation) {
      case 'on': return runExclusive(sessionIdOf(invocation.agent.session), () => enable(invocation))
      case 'off': return runExclusive(sessionIdOf(invocation.agent.session), () => disable(invocation, parsed.rest))
      case 'restore': return runExclusive(sessionIdOf(invocation.agent.session), () => restoreOnly(invocation))
      case 'status': return status(invocation)
      case 'card': return cardCommand(invocation, parsed.args)
      case 'cost': return costCommand(invocation)
      case 'read': return read(invocation, parsed.args.flatMap((arg) => arg.split(',')).filter(Boolean))
      case 'verify': return verifyCommand(invocation, parsed.args.flatMap((arg) => arg.split(',')).filter(Boolean))
      case 'mark-stale': return markStaleCommand(invocation, parsed.args)
      case 'forget': return runExclusive(sessionIdOf(invocation.agent.session), () => forgetCommand(invocation, parsed.args))
      case 'compress': return runExclusive(sessionIdOf(invocation.agent.session), () => compressCommand(invocation, parsed.args))
      case 'expand': return runExclusive(sessionIdOf(invocation.agent.session), () => expandCommand(invocation, parsed.args))
      case 'recall': return recallCommand(invocation, parsed.args)
      case 'index': return indexCommand(invocation, parsed.args)
      case 'relations': return relationsCommand(invocation, parsed.args)
      case 'history': return history(invocation, parsed.args)
      case 'working-set': return workingSet(invocation, parsed.args)
      case 'fork': return forkTo(invocation, parsed.args)
      case 'fork-status': return forkStatus(invocation)
      case 'fork-reset': return forkReset(invocation, parsed.args)
      case 'now': return runNow(invocation, { dryRun: false })
      case 'dry-run': return runNow(invocation, { dryRun: true })
      case 'clean': return runExclusive(sessionIdOf(invocation.agent.session), () => cleanSession(invocation, parsed.args))
      case 'set': return setSetting(invocation, parsed.args)
      default: return { kind: 'success', text: V2_HELP }
    }
  }

  return {
    engineName: 'v2',
    commandName: V2_COMMAND_NAME,
    help: V2_HELP,
    engine,
    records,
    adopt,
    adoptById,
    enable,
    disable,
    disableById,
    restoreOnly,
    status,
    read,
    history,
    workingSet,
    recall,
    commandHandler,
    autoCooling,
    buildRecall,
    workingSetInjection,
    confirmInjection,
    foldWorkingCards,
    shutdown,
    // 测试与诊断入口。
    guardCandidate,
    v2ArchiveNodeId,
  }
}

/**
 * 从本步消息里找出最近一次「读取某个文件」的痕迹（0.13.1 F5）。
 *
 * 只认两种确定性形状，不做语义猜测：`<path>…</path>` 标签与工具参数里的
 * `file_path` 字面量。取不到返回 null——「没识别出重读」不等于「没有重读」，
 * 但宁可漏报也不误报：误报会让回注在正常流程里频繁触发，白耗上下文。
 *
 * 导出是为了让守卫能直接断言触发判定，而不必拉起整个运行时。
 */
export function latestReadPathOf(messages) {
  if (!Array.isArray(messages)) return null
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const blocks = messages[index]?.content
    if (!Array.isArray(blocks)) continue
    for (const block of blocks) {
      const text = typeof block?.text === 'string' ? block.text : ''
      const tagged = /<path>([^<]+)<\/path>/.exec(text)
      if (tagged) return { path: tagged[1].trim(), seq: index }
      const field = /"file_path"\s*:\s*"((?:[^"\\]|\\.)+)"/.exec(text)
      if (field) return { path: field[1].replace(/\\\\/g, '/'), seq: index }
    }
  }
  return null
}

export { V2_RECEIPT_MARKER }
