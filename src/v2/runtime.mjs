/**
 * v2 运行时：把 v2 存储/回读内核接进 DSH 的会话生命周期。
 *
 * 与 v1 的关系（本项目最关键的边界）：
 * - **同一会话同时只有一个引擎能替换模型可见投影**。v2 通过
 *   `claimV2Engine` 声明所有权，v1 的 `on` 通过 `assertV2AllowsV1` 反向检查；
 *   两边都在激活前检查，所以不存在「两个引擎同时投影同一会话」的窗口。
 * - **复用 v1 的降温管线，不重写**：候选收集、保留窗口、缓存统计、回执渲染、
 *   恢复路径全部走 `createEngine`（`apply.mjs` + `apply-engine.mjs`）。
 *   v2 只替换三件事：冷库客户端（本会话 v2 隔离库）、回执标记、候选门禁。
 * - **v2 自己的数据 schema 独立**：记录、载荷、事务、目录、状态文件都在
 *   `<labRoot>/v2/` 下，kind/schema 与 v1 不同，互不读取、互不覆盖。
 *
 * 本模块不注册任何模型可见工具，也不重定向正式 `lingshu_cg`。
 */

import { randomUUID } from 'node:crypto'

import {
  COMMAND_NAME,
  DEFAULT_SETTINGS,
  MAX_RECALL_QUERY_CHARS,
  PACKAGE_NAME,
  buildReceipt,
  buildSpanReceipt,
  escapePromptBraces,
  normalizeSettings,
  renderRecallBlock,
  V2_RECEIPT_MARKER,
} from '../core.mjs'
import { createEngine } from '../apply-engine.mjs'
import { classifyRange } from './guard.mjs'
import { bodyOfSpan, collectHistoryCandidates, spanLabelOf, SPAN_KINDS } from './history.mjs'
import {
  claimV2Engine,
  disableV2Engine,
  releaseV2Engine,
} from './engine.mjs'
import { createV2ClientFactory } from './client-adapter.mjs'
import {
  createV2SessionState,
  disabledV2State,
  readV2SessionState,
  v2SessionDirectoryFor,
  writeV2SessionState,
} from './state.mjs'
import { importV1ArchiveEntries } from './import-v1.mjs'
import { readSessionState } from '../storage.mjs'
import { V2SessionStore } from './store.mjs'
import { compareRecordIds } from './records.mjs'
import { readRecordById, listRecordsPage, packWorkingSet } from './readback.mjs'
import { EngineV2Error } from './errors.mjs'
import { BYTES_PER_TOKEN, estimateTokensOf, estimateTokensOfBytes, parseBudgetTokens } from './budget.mjs'
import { CURSOR_MODES, encodeCursor, requireCursor } from './cursor.mjs'
import {
  executeForkClosure,
  planForkClosure,
  readForkMap,
  readNeedsMigration,
  resetForkChild,
} from './fork.mjs'
import { createCostLedger, renderCostReport } from './cost.mjs'
import { renderToolOutput, toToolValue } from './tool.mjs'
import { searchRecords, syncRetrievalIndex, readRetrievalIndex, describeRecordRelations } from './retrieval.mjs'
import {
  buildWorkingState,
  decideWorkingSetInjection,
  planWorkingSetBudget,
  renderWorkingSetInjection,
  shouldInjectFullWorkingStateCard,
  workingSetDedupKeyOf,
  workingStateCardDelta,
  WORKING_SET_DEFAULTS,
  WORKING_SET_DEDUP_HISTORY_LIMIT,
} from './working-state.mjs'

export const V2_COMMAND_NAME = 'memory-lab2'

/** 只读召回（命令面与模型可见工具共用）的默认/上限 token 预算。 */
export const RECALL_DEFAULT_BUDGET_TOKENS = 6000
export const RECALL_MAX_BUDGET_TOKENS = 32_000
/** 工作状态卡/工作集预算上限：同样有界，避免调用方用一个巨大数字把卡撑成全文。 */
export const WORKING_SET_MAX_BUDGET_TOKENS = 16_000
/** 字面检索一次最多返回多少条索引命中（正文仍要按 ID 单独回读）。 */
export const RECALL_MAX_QUERY_HITS = 20

export const V2_HELP = [
  '记忆上下文 v2（全历史按需记忆化）——与 /memory-lab 互斥，同一会话只能启用一个引擎。',
  '',
  '/memory-lab2 on                 启用 v2：本会话历史进入 v2 隔离库，已完成操作可退出热上下文',
  '/memory-lab2 off [原因]         停用 v2：恢复所有已替换区间，历史转只读保留',
  '/memory-lab2 restore            恢复全部可恢复的回执原文，引擎保持启用（不停用）',
  '/memory-lab2 status             当前引擎、记录数、在途配对、最近一次动作',
  '/memory-lab2 now                立刻执行一次降温（不等自动触发线）',
  '/memory-lab2 dry-run            只规划不落库：报告会降温哪些范围、被门禁拦下哪些',
  '/memory-lab2 read <记录ID...>   按稳定 ID 精确回读原文（可多个，逗号或空格分隔）',
  '/memory-lab2 recall <查询词>    字面检索（ID/kind/工具名/callId/范围）；只读，不返回分数',
  '/memory-lab2 recall id <记录ID...> [预算]   与模型可见只读工具同一条路径的精确回读',
  '/memory-lab2 index [sync]       语义检索后端的增量索引状态/同步（未注入后端时如实报告）',
  '/memory-lab2 relations <记录ID> 只报可验证的结构关系：配对、fork 迁移、索引外部 ID',
  '/memory-lab2 history [页大小] [记录ID之后]   分页列出已落库记录（只读，不含正文）',
  '/memory-lab2 working-set [token预算]         按预算装包当前工作集（含在途配对与显式 ID）',
  '/memory-lab2 import-v1          把本会话 v1 归档导入 v2（指针级：记录 v1 条目描述符与 nodeId，不复制正文）',
  '/memory-lab2 fork <子会话ID>    把本会话闭包迁移给子会话；迁移后核对指纹，不一致则标记 needs-migration',
  '/memory-lab2 fork-status        只读预览：本会话闭包多大、能不能搬、有什么告警',
  '/memory-lab2 fork-reset <子会话ID>  清掉 fork 半成品子库（仅限带 needs-migration 标记），使失败可重试',
  '/memory-lab2 card [token预算]   渲染有界工作状态卡（就是注入主模型的那份文本）',
  '/memory-lab2 cost               成本账本：注入/重读/批次数与 token 量（含缓存失效口径）',
  '/memory-lab2 help               本帮助',
  '',
  'v2 复用 /memory-lab 的设置词汇（auto/recall/batch/retain 等）：',
  '/memory-lab2 set <键> <值> 与 /memory-lab 的 set 同义，但只写 v2 账本。',
  '/memory-lab2 set fullhistory on|off  全历史记忆上下文：除系统头、人类消息、凭证、',
  '                                  计划工件外全部退热入隔离灵枢临时记忆；「保留最近',
  '                                  操作」随之失效（面板变灰），保留由证据保护层裁决。',
].join('\n')

/** v2 归档节点的稳定 ID 前缀：与 v1 的 `archiveNodeId` 形状不同，两库节点 ID 不会撞车。 */
export function v2ArchiveNodeId(sessionKey, ordinal) {
  return `mcl2-${sessionKey}-${String(ordinal).padStart(6, '0')}`
}

/**
 * 解析 `/memory-lab2` 的输入。
 * 与 v1 的 `parseOperation` 分开实现：v2 的操作面不同（read/history/working-set/import-v1），
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
function rangeTokenOf(range) {
  if (!range || typeof range !== 'object') return null
  const start = Number.isInteger(range.start) ? range.start : null
  const end = Number.isInteger(range.end) ? range.end : null
  if (start === null || end === null) return null
  return `${start}-${end} ${start}–${end} seq:${start}-${end}`
}

/**
 * 把 inline.range 渲染成人读得懂的一列。
 *
 * range 在记录里是 `{start,end}` 对象（真实跨度的形状），历史列表里直接插值会
 * 变成 `[object Object]`。非对象/非法的值一律如实标未知，不猜。
 */
function formatRange(range) {  if (!range || typeof range !== 'object') return ''
  const start = Number.isInteger(range.start) ? range.start : null
  const end = Number.isInteger(range.end) ? range.end : null
  if (start === null || end === null) return ' 范围=未知'
  return ` 范围=${start}–${end}`
}

function renderV2Status(record, extra = {}) {
  const settings = record.state.settings ?? {}
  const applied = record.state.archive.filter((row) => row.status === 'applied').length
  // 单列 `verify-failed`：它和 `applied` 一样遮蔽了原文（原文只在冷库），
  // 但替换后的活动面没通过校验。并进 `applied` 会虚报已归档段数。
  const verifyFailed = record.state.archive.filter((row) => row.status === 'verify-failed').length
  const restored = record.state.archive.filter((row) => row.status === 'restored').length
  const lines = [
    `v2 引擎：${record.state.enabled ? '已启用' : '已停用'}${record.state.fullHistory === true ? '（全历史记忆上下文）' : ''}`,
    `会话：${record.sessionId}`,
    `隔离根：${record.directory}`,
    `设置：auto=${settings.auto ? 'on' : 'off'} recall=${settings.autoRecall ? 'on' : 'off'} `
      + `batch=${settings.archiveBatchSize} retain=${record.state.fullHistory === true ? `${settings.retainOperations}（全历史模式下失效）` : settings.retainOperations}`,
    `账本：已归档 ${applied} 段，已恢复 ${restored} 段`
      + (verifyFailed ? `，校验未通过 ${verifyFailed} 段（原文只在冷库，可 restore 取回）` : ''),
  ]
  if (record.state.lastMeasurement) {
    const m = record.state.lastMeasurement
    lines.push(`最近测量：≈${m.assembledTokens ?? '?'} token / 窗口 ${m.contextWindow ?? '?'}，动作 ${m.action ?? '?'}`)
  }
  if (record.state.lastAction) lines.push(`最近动作：${record.state.lastAction}`)
  if (extra.records !== undefined) lines.push(`v2 记录数：${extra.records}`)
  if (extra.openPairs !== undefined) lines.push(`在途工具配对：${extra.openPairs}`)
  if (extra.workingSet) {
    lines.push(`工作状态：≈${extra.workingSet.usedTokens} token（卡片内部口径，4 字节≈1 token；注入记账走宿主 meter）`
      + ` / 预算 ${extra.workingSet.budgetTokens}`
      + (extra.workingSet.dropped?.length ? `（因预算丢弃 ${extra.workingSet.dropped.length} 段）` : ''))
  }
  if (extra.cost) {
    // 「缓存失效」插件观测不到：写 unknown，不写 0 —— 0 会被读成「没有失效」，
    // 那是我们无权断言的事实。替换次数是我们的动作，单独列出。
    lines.push(`成本计数：冷库写入 ${extra.cost.memoryWrites} 次 / 记录 ${extra.cost.recordsWritten} 条 / `
      + `历史替换 ${extra.cost.historyReplacements} 段 / 证据重读 ${extra.cost.evidenceReReads} 次 / `
      + `辅助模型调用 ${extra.cost.extraModelCalls} 次`)
    lines.push('供应商前缀缓存失效次数：未知（插件观测不到宿主/供应商的缓存行为，不冒充 0）')
  }
  // C3/O3：最近一个观测窗口的批前后 usage 对比（只观测，不宣称因果）。
  const settled = record.state?.usageWatch?.settled ?? null
  if (settled && Number.isFinite(settled.deltaTokens)) {
    const pct = (ratio) => (Number.isFinite(ratio) ? `${(ratio * 100).toFixed(1)}%` : '未知')
    lines.push(`批前后观测（${settled.at}）：批 ${settled.batchReplacements ?? '?'} 段替换后，最近请求未命中 +≈${settled.deltaTokens} token`
      + `（命中率 ${pct(settled.beforeHitRatio)} → ${pct(settled.afterHitRatio)}；含并发因素，仅量级参考）`)
  }
  if (extra.retrieval) lines.push(...extra.retrieval)
  if (extra.warnings?.length) lines.push(`告警：${extra.warnings.join('；')}`)
  return lines.join('\n')
}

/**
 * 回读结果渲染。
 *
 * 每段都带「冷库历史原文」抬头，并且明确写出它**不是**什么：不是新的授权、
 * 不是对文件当前状态的观察。历史记录里的内容（哪怕是「允许」「已批准」这类
 * 字样，或某个文件当时的内容）都只是当时发生过的原文，不构成当前许可。
 * 完整性=ok 只说明载荷与登记哈希一致，不是事实核验。
 */
function renderReadResults(results) {
  const blocks = []
  for (const item of results) {
    if (!item.ok) {
      blocks.push(`【${item.id}】读取失败：${item.error}`)
      continue
    }
    const head = `【${item.id}】冷库历史原文｜${item.kind ?? ''} 保真=${item.fidelity ?? '?'} `
      + `完整性=${item.integrity ?? 'ok'} 字节=${item.bytes ?? '?'}`
    const note = '（这是已归档的当时原文，不是新授权、也不是对文件当前状态的观察）'
    const via = item.resolvedVia === 'fork-map' ? `\n（经 fork 映射自 ${item.requestedId}）` : ''
    blocks.push(`${head}${note}${via}\n${item.text}`)
  }
  return blocks.join('\n\n')
}

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
    // 计划先行联动（index.mjs 注入）：v2 启用成功后回调，返回提示文本对象或 null。
    onEnabled = null,
    // 计划先行开关切换回调（agent, value) => note|null）：on 时尝试进入计划模式。
    onPlanFirstToggle = null,
    coordinator = null,
    // 可注入的语义检索后端（灵枢）。缺省为 null：只用内置字面索引，并在
    // 结果里如实标注 `matchedBy: 'literal'`，不假装做过语义检索。
    // 注入方负责 backend 自己的会话隔离（独立隔离根 + 独立子进程）。
    semanticBackend = null,
    // 按会话解析检索后端（每个会话一个隔离根，因此后端必须按会话取用）。
    // `semanticBackend` 保留给测试直接注入单个后端；两者都给时以解析器为准。
    semanticBackendFor = null,
    // 会话停用时释放该会话的后端资源（隔离灵枢子进程）。
    semanticBackendClose = null,
    // 显式启动某会话的后端（只有 /memory-lab2 index 会调用）。
    semanticBackendEnsure = null,
    // 后端可用性自述（只读）：状态面照抄，避免把「没接后端」说成「检索可用」。
    semanticBackendStatus = null,
    // 某会话的启动失败原因（只读，不触发启动）。
    semanticBackendFailure = null,
    // 进程收尾时释放全部隔离灵枢子进程（含已不在册的会话）。
    semanticBackendCloseAll = null,
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
      })
      : buildSpanReceipt({
        // D4：插件自己注入的跨度（工作状态卡/回注包/回执）不冒充「用户消息」，
        // 回执标签按作者区分，模型读回执就知道那段历史是插件工作资料。
        label: candidate.pluginAuthored ? '插件工作资料' : spanLabelOf(candidate.spanKind),
        range: { start: candidate.rangeStart, end: candidate.rangeEnd },
        nodeId,
        hash,
        chars: candidate.chars,
        tokens: candidate.originalTokens,
        chunks: candidate.chunkCount ?? 1,
        marker,
      })),
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

  function makeRecord({ agent, sessionId, directory, state }) {
    let suppressionLease = null
    try {
      suppressionLease = coordinator?.acquire(sessionId) ?? null
    } catch (error) {
      logger?.warn?.(`memory-lab2: 灵枢抑制租约获取失败：${error instanceof Error ? error.message : String(error)}`)
    }
    return {
      engineName: 'v2',
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
      // 工作状态卡注入状态（D1 升级）：最近一次**渲染出的全量卡文本**与已注入
      // 总数、已注入语义键的有界历史。只存内存：重启后丢失即回落「下一张全量卡」，
      // 这是诚实降级（不注入引用了模型从未见过的全量卡的增量卡）。
      workingSetCard: null,
      // 成本账本：从持久化快照续记，进程内累计；停用与每批降温后落盘。
      cost: createCostLedger(state.cost),
    }
  }

  /**
   * 把成本计数落盘（best-effort）。
   *
   * 记账失败不能让降温或回读失败——但也不能静默：写失败会记一条告警，
   * 并把内存里的计数保留到下次尝试。
   */
  async function persistCost(record) {
    try {
      const counters = record.cost.snapshot()
      record.state = { ...record.state, cost: counters }
      await writeV2SessionState(record.directory, record.state)
    } catch (error) {
      logger?.warn?.(`memory-lab2: 成本计数落盘失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** 取会话记录：只有 v2 状态存在且 enabled 才返回（绝不自动启用）。 */
  async function adopt(agent) {
    const sessionId = sessionIdOf(agent.session)
    if (!sessionId) return null
    const cached = records.get(sessionId)
    if (cached) return cached
    let loaded
    try {
      loaded = await readV2SessionState(labRoot, sessionId)
    } catch (error) {
      logger?.warn?.(`memory-lab2: 状态文件不可读，本会话按未启用处理：${error instanceof Error ? error.message : String(error)}`)
      return null
    }
    if (!loaded || loaded.state.enabled !== true) return null
    const record = makeRecord({ agent, sessionId, directory: loaded.directory, state: loaded.state })
    records.set(sessionId, record)
    return record
  }

  async function disposeRecord(record) {
    try {
      await record.client?.close?.()
    } catch {
      // 关闭失败不阻塞退出。
    }
    try {
      await factories.get(record.sessionId)?.dispose?.()
    } catch {
      // 同上。
    }
    factories.delete(record.sessionId)
    // 释放该会话的检索后端资源（隔离灵枢子进程）。会话停用后不再需要它，
    // 留着会白白常驻一个 Python 进程。失败不阻塞退出。
    try {
      await semanticBackendClose?.({ sessionId: record.sessionId })
    } catch (error) {
      logger?.warn?.(`v2 检索后端释放失败（${record.sessionId}）：${error?.message ?? error}`)
    }
    try {
      record.suppressionLease?.release?.()
    } catch {
      // 租约释放失败由协调器自己的超时兜底。
    }
  }

  async function runExclusive(sessionId, work) {
    const pending = (async () => work())()
    activeOperations.add(pending)
    try {
      return await pending
    } finally {
      activeOperations.delete(pending)
    }
  }

  /**
   * 继承历史审计：热投影里的 v2 回执，其记录 ID 必须在本会话可解析。
   *
   * 存在的理由（规范 10.2）：「设置继承不等于历史可读性继承」。fork 出来的子会话
   * 会带着父会话的对话历史（含父 namespace 的回执），但子会话自己的冷库是空的；
   * 模型看到指向不存在证据的回执，比没有回执更糟。启用前查出来并阻断，
   * 而不是等模型真的去读的时候才发现。
   */
  async function auditInheritedArchive(record, { maxCheck = 50 } = {}) {
    const session = record.agent?.session
    const nodes = Array.isArray(session?.surface?.nodes) ? session.surface.nodes : []
    const referenced = []
    for (const seq of nodes) {
      const event = typeof session?.eventAt === 'function' ? session.eventAt(seq) : null
      const text = receiptTextOf(event)
      if (text === null || !text.startsWith(V2_RECEIPT_MARKER)) continue
      for (const match of text.matchAll(/\bt\d{8}-r\d{4}\b/g)) referenced.push(match[0])
    }
    const unique = [...new Set(referenced)]
    if (unique.length === 0) return { checked: 0, missing: [], truncated: false }
    const sample = unique.slice(0, maxCheck)
    const missing = []
    const factory = factoryFor(record)
    await factory.withStore(async (store) => {
      for (const id of sample) {
        try {
          await readRecordById(labRoot, record.sessionId, id, { store })
        } catch {
          missing.push(id)
        }
      }
    })
    return { checked: sample.length, missing, truncated: unique.length > sample.length }
  }

  // ── 生命周期：on / off ───────────────────────────────────────────────────

  /**
   * 阻断路径的完整回滚（审计 H2）：账本可能已初始化，单独 releaseV2Engine 会
   * 因「已初始化且激活」抛 EENGINEACTIVE，被 .catch 吞掉后恰好留下最坏的
   * 悬空状态（engine.json active + 台账在 + 账本 on）。先正式停用（写
   * disabled）再 release，两步各自的失败都只降级为告警，不掩盖原始错误。
   */
  async function rollbackV2Activation(sessionId, reason) {
    try {
      await disableV2Engine(labRoot, sessionId, reason)
    } catch (error) {
      logger?.warn?.(`memory-lab2: 阻断回滚时停用失败（${error instanceof Error ? error.message : String(error)}）`)
    }
    try {
      await releaseV2Engine(labRoot, sessionId)
    } catch (error) {
      logger?.warn?.(`memory-lab2: 阻断回滚时释放声明失败（${error instanceof Error ? error.message : String(error)}）`)
    }
  }

  async function enable(invocation) {
    const agent = invocation.agent
    const sessionId = sessionIdOf(agent.session)
    if (!sessionId) throw new EngineV2Error('无法确定会话 ID，拒绝启用 v2。', { code: 'EINVAL' })

    // 1) 引擎所有权：v1 若持有本会话投影则拒绝（双引擎互斥的 v2→v1 方向）。
    const claim = await claimV2Engine(labRoot, sessionId)
    if (!claim.claimed) {
      throw new EngineV2Error(
        'v2 已持有本会话投影，无需重复启用。',
        { code: 'EENGINEACTIVE', details: { holder: 'v2' } },
      )
    }
    // 1b) fork 阻断：子会话若停在 needs-migration，不得用空库继续任务（规范 10.2）。
    const stuck = await readNeedsMigration(labRoot, sessionId)
    if (stuck) {
      await rollbackV2Activation(sessionId, '启用前发现 needs-migration 残留，回滚声明')
      throw new EngineV2Error(
        `本会话停在 needs-migration（父会话 ${stuck.parentSessionId ?? '未知'}，原因：${stuck.reason ?? '未记录'}）。\n`
        + `继承历史不等于历史可读；请先完成迁移：\n${(stuck.steps ?? []).join('\n')}`,
        { code: 'ENEEDSMIGRATION', details: { needsMigration: stuck } },
      )
    }
    // 2) 会话账本：创建或重新启用（已启用时 createV2SessionState 抛 EALREADYON）。
    let created
    try {
      created = await createV2SessionState(labRoot, sessionId, normalizeSettings(defaultSettings()))
    } catch (error) {
      // 账本建不起来就完整回滚（账本可能部分写入：停用再释放），避免留下
      // 「已声明但无账本」或「账本 on + 声明 active」的悬空状态。
      await rollbackV2Activation(sessionId, '账本创建失败，回滚启用')
      throw error
    }
    const record = makeRecord({
      agent,
      sessionId,
      directory: created.directory,
      state: created.state,
    })
    // 全历史默认值播种：旧账本（含 off/on 往返）按已有值走；全新账本按设置页默认。
    // 只在值缺失时补，绝不覆盖用户在本会话写下的选择。
    if (record.state.fullHistory === undefined) {
      record.state.fullHistory = defaultFullHistory() === true
      await writeV2SessionState(record.directory, record.state).catch(() => {})
    }
    records.set(sessionId, record)
    const warnings = [...(claim.warnings ?? [])]

    // 3) 继承历史审计：热投影里已有 v2 回执但本会话库解析不到 → 阻断启用。
    //    典型场景是 fork：子会话继承父会话对话历史，却没有父会话冷库闭包。
    try {
      const audit = await auditInheritedArchive(record)
      if (audit.missing.length > 0) {
        // 阻断启用：完整回滚（账本已 on、engine 已声明），先停用再释放，
        // 保证「台账声明 / engine.json / 会话账本」三者回到启用前状态。
        records.delete(sessionId)
        await rollbackV2Activation(sessionId, `继承审计失败：${audit.missing.length} 条回执不可解析`)
        throw new EngineV2Error(
          `本会话热投影里有 ${audit.missing.length} 条 v2 回执指向本会话冷库中不存在的记录`
          + `${audit.truncated ? '（仅抽查了前 50 条）' : ''}：${audit.missing.slice(0, 5).join('、')}\n`
          + '这通常意味着会话是从父会话 fork 而来但历史尚未迁移。\n'
          + `请先迁移：/memory-lab2 fork ${sessionId}，或 /memory-lab2 import-v1 后重试。`,
          { code: 'EINHERITEDUNREADABLE', details: audit },
        )
      }
      if (audit.checked > 0) warnings.push(`继承审计：${audit.checked} 条回执在本会话可解析`)
    } catch (error) {
      if (error instanceof EngineV2Error) throw error
      // 审计本身失败（例如库打不开）不阻断启用，但必须留下告警而不是静默放过。
      warnings.push(`继承审计未完成：${error instanceof Error ? error.message : String(error)}`)
    }

    if (warnings.length) logger?.warn?.(`memory-lab2: ${warnings.join('；')}`)
    // 计划先行联动（由 index.mjs 注入）：启用成功且开关为开、会话全新时进入计划模式。
    // 失败只降级为提示，不阻断启用（计划模式不是降温的前置条件）。
    const planNote = (await onEnabled?.(agent)?.catch(() => null)) ?? null
    return {
      kind: 'success',
      text: `已启用 v2 引擎（全历史按需记忆化）。\n隔离根：${created.directory}\n`
        + `本会话对真实灵枢的自动读写已抑制；v1 引擎在本会话不可同时启用。\n`
        + (warnings.length ? `告警：${warnings.join('；')}` : '')
        + (planNote ? `\n${planNote.text}` : ''),
    }
  }

  /**
   * 停用一个会话的 v2：先恢复投影，再置停用、清引擎声明。
   *
   * 以 record 为中心（而不是以命令调用为中心），因为归档清理路径只拿得到
   * sessionId，拿不到命令 invocation，但两者必须是同一条停用语义。
   */
  async function disableRecord(record, sessionId, reason) {
    const lines = []
    let restored = 0
    let before = 0

    if (record) {
      // 1) 先恢复所有已替换区间：投影回到原文，再停用。
      try {
        const outcome = await engine.runRestore(record)
        restored = outcome?.restored ?? 0
        before = outcome?.before ?? 0
      } catch (error) {
        // 恢复失败不静默：仍继续停用，但把失败写进回执文本，且不宣称已恢复。
        lines.push(`恢复未完成：${error instanceof Error ? error.message : String(error)}`)
      }
      const disabledState = disabledV2State(record.state, reason)
      await writeV2SessionState(record.directory, disabledState)
      record.state = disabledState
      await disposeRecord(record)
      records.delete(sessionId)
    } else {
      lines.push('本会话没有活动的 v2 记录（可能已停用）。')
    }

    // 2) 引擎所有权：置 disabled 并清台账声明。
    const outcome = await disableV2Engine(labRoot, sessionId, reason)
    if (outcome.warnings?.length) lines.push(...outcome.warnings)

    lines.unshift(
      `已停用 v2 引擎。恢复 ${restored}/${before} 段原文；`
      + '历史与载荷按只读保留，旧记录 ID 仍可回读。',
    )
    return { kind: 'success', text: lines.join('\n'), restored, before }
  }

  async function disable(invocation, reason) {
    const sessionId = sessionIdOf(invocation.agent.session)
    if (!sessionId) throw new EngineV2Error('无法确定会话 ID，拒绝停用 v2。', { code: 'EINVAL' })
    const record = records.get(sessionId) ?? await adopt(invocation.agent)
    return disableRecord(record, sessionId, reason)
  }

  /**
   * 只按 sessionId 停用（归档清理路径）。
   *
   * 会话已被归档、拿不到 Agent 时返回 skipped：没有活动面可恢复，此时删数据
   * 才是错的——回执仍指向冷库，留着它才对。
   */
  async function disableById(sessionId, reason) {
    const record = records.get(sessionId) ?? await adoptById(sessionId)
    if (!record) return { restored: 0, before: 0, skipped: true }
    return disableRecord(record, sessionId, reason)
  }

  async function adoptById(sessionId) {
    const agents = services?.get?.('agents')
    const agent = typeof agents?.get === 'function' ? agents.get(sessionId) : null
    if (!agent) return null
    return adopt(agent)
  }

  /**
   * `/memory-lab2 restore`（B2）：不停用引擎，把全部可恢复的回执恢复回原文。
   *
   * 与 `off` 的区别只在「不停用」：恢复管线复用同一套 `engine.runRestore`
   * （逐回执校验冷节点与表层一致性，失败行如实逐条说明并保持可按 ID 回读）。
   * 面板的「恢复原文」在 v2 会话改发本命令，不再硬编码 v1 的 `/memory-lab restore`
   * （后者在 v1 adopt 为 null 时会误报「未启用」，见会话 c896f803 的排查）。
   */
  async function restoreOnly(invocation) {
    const sessionId = sessionIdOf(invocation.agent.session)
    if (!sessionId) throw new EngineV2Error('无法确定会话 ID，拒绝恢复。', { code: 'EINVAL' })
    const record = records.get(sessionId) ?? await adopt(invocation.agent)
    if (!record) {
      return {
        kind: 'error',
        text: 'v2 引擎在本会话未启用，没有可整批恢复的 v2 回执。\n'
          + '若此前启用过又停用：回执仍在会话日志里，单段原文可用 /memory-lab2 read <ID> 回读（停用后旧 ID 仍可解析）；'
          + 'v1 降温的恢复请用 /memory-lab restore。',
      }
    }
    const outcome = await engine.runRestore(record)
    return {
      kind: 'success',
      text: `${outcome.text}\n引擎保持启用（本次不停用）；单段回读用 /memory-lab2 read <ID>，整批恢复并停用用 /memory-lab2 off。`,
      restored: outcome.restored,
      before: outcome.before,
    }
  }

  // ── 只读操作 ─────────────────────────────────────────────────────────────

  /**
   * 在「可读的 v2 库」上执行只读工作，覆盖三种情形：
   * 1. 本进程已启用 → 借用适配器持有的句柄（同一目录只允许一个句柄）；
   * 2. 本会话曾启用、现在已停用 → 只读打开隔离根（停用后旧 ID 必须仍可回读）；
   * 3. 从未启用或没有数据 → 返回 null，由调用方如实说明。
   *
   * 停用后仍然可读是产品要求的一部分：回执留在日志里，冷库必须能兑现它。
   */
  async function withReadableStore(sessionId, work) {
    const record = records.get(sessionId)
    if (record) return factoryFor(record).withStore((store) => work(store))
    if (!await V2SessionStore.exists(labRoot, sessionId)) return null
    const store = await V2SessionStore.open({ labRoot, sessionId, readOnly: true })
    try {
      return await work(store)
    } finally {
      store.close()
    }
  }

  /**
   * 按记录 ID 回读。fork 迁移后的旧父 ID 由 readback 层统一兜底解析
   * （`resolvedVia: 'fork-map'`），这里不重复实现第二条路径。
   */
  async function readWithForkFallback(store, sessionId, id, { maxBytes = null } = {}) {
    return readRecordById(labRoot, sessionId, id, { store, maxBytes })
  }

  async function status(invocation) {
    const agent = invocation.agent
    const sessionId = sessionIdOf(agent.session)
    const record = records.get(sessionId) ?? await adopt(agent)
    if (!record) {
      // 本进程没有活动记录，但磁盘上可能留有「已停用、历史保留」的账本。
      // 这时必须如实报告停用状态与记录数，而不是说成「从未启用」。
      const stored = await readV2SessionState(labRoot, sessionId)
      if (!stored) {
        return { kind: 'success', text: 'v2 引擎在本会话未启用。用 `/memory-lab2 on` 启用。' }
      }
      let counts = {}
      try {
        await withReadableStore(sessionId, async (store) => {
          counts = { records: store.recordCount, openPairs: store.openCalls().length }
        })
      } catch (error) {
        counts = { warnings: [`读取 v2 库失败：${error instanceof Error ? error.message : String(error)}`] }
      }
      return {
        kind: 'success',
        text: renderV2Status({
          sessionId,
          directory: stored.directory,
          state: stored.state,
          lastAction: null,
        }, counts),
      }
    }
    let extra = {}
    try {
      // 借用适配器已持有的句柄：同一会话目录在本进程内只允许一个 store 句柄。
      await factoryFor(record).withStore(async (store) => {
        extra = { records: store.recordCount, openPairs: store.openCalls().length, warnings: store.warnings }
      })
    } catch (error) {
      extra = { warnings: [`读取 v2 库失败：${error instanceof Error ? error.message : String(error)}`] }
    }
    extra.retrieval = await retrievalStatusLines(record)
    return { kind: 'success', text: renderV2Status(record, extra) }
  }

  /**
   * 状态面的检索能力自述（只读、不启动后端）。
   *
   * 这一段是**如实报告**的核心：字面索引和灵枢后端是两条独立的路，各自说自己
   * 到底可用不可用。没有后端就说没有后端，绝不把「字面匹配」写成「语义召回」。
   */
  async function retrievalStatusLines(record) {
    const lines = []
    const index = await readRetrievalIndex(record.directory)
    const indexed = index ? Object.keys(index.indexed ?? {}).length : 0
    lines.push(index
      ? `字面索引：${indexed} 条已索引，更新于 ${index.updatedAt}（内置，始终可用）`
      : '字面索引：尚无（运行 `/memory-lab2 index sync` 建立；在此之前检索只按记录元数据匹配）')

    const status = typeof semanticBackendStatus === 'function' ? semanticBackendStatus() : null
    const backend = backendForSession(record.sessionId)
    if (backend) {
      lines.push(`检索后端：${backend.name}（${backend.capabilities?.kind ?? 'unknown'}；向量语义=${backend.capabilities?.semanticVectors === true ? '有' : '无'}）`)
    } else if (status && status.available === false) {
      lines.push(`检索后端：不可用 —— ${status.reason}`)
    } else if (typeof semanticBackendFailure === 'function') {
      const reason = semanticBackendFailure({ sessionId: record.sessionId })
      lines.push(reason
        ? `检索后端：本会话启动失败 —— ${reason}（当前检索只用字面索引，不是语义召回）`
        : '检索后端：尚未为本会话启动（只有 `/memory-lab2 index sync` 会启动；检索当前只用字面索引）')
    } else {
      lines.push('检索后端：未接入（检索只用字面索引，不是语义召回）')
    }
    return lines
  }

  async function read(invocation, ids) {
    const sessionId = sessionIdOf(invocation.agent.session)
    if (ids.length === 0) {
      return { kind: 'error', text: '用法：`/memory-lab2 read <记录ID...>`（记录 ID 形如 t00000001-r0001）。' }
    }
    const record = records.get(sessionId)
    const results = []
    // 证据重读计数：冷记录被再次读取是要计入成本账本的（T-12）。
    let reRead = 0
    let reReadBytes = 0
    for (const id of ids) {
      try {
        // 停用后仍可读：优先用活动记录，否则只读打开隔离根；旧父 ID 走 fork 兜底。
        const loaded = await withReadableStore(sessionId, (store) => readWithForkFallback(store, sessionId, id))
        if (!loaded) {
          results.push({ id, ok: false, error: 'ENOSTORE：本会话没有 v2 库（从未启用）。' })
          continue
        }
        results.push({
          id,
          ok: true,
          kind: loaded.entry?.kind ?? loaded.record?.kind ?? null,
          fidelity: loaded.entry?.fidelity ?? loaded.record?.fidelity ?? null,
          integrity: loaded.integrity,
          verified: loaded.verified,
          bytes: typeof loaded.payloadText === 'string' ? Buffer.byteLength(loaded.payloadText, 'utf8') : 0,
          text: loaded.payloadText ?? '（该记录无载荷：结构化索引记录）',
          // 经 fork 映射命中时如实标注，避免把父会话 ID 说成子会话自己的记录。
          resolvedVia: loaded.resolvedVia ?? null,
          requestedId: loaded.requestedId ?? null,
        })
        reRead += 1
        reReadBytes += typeof loaded.payloadText === 'string' ? Buffer.byteLength(loaded.payloadText, 'utf8') : 0
      } catch (error) {
        results.push({ id, ok: false, error: `${error?.code ?? 'E'}：${error instanceof Error ? error.message : String(error)}` })
      }
    }
    if (record && reRead > 0) {
      record.cost.bump('evidenceReReads', reRead)
      // reReadBytes 已经是字节数：必须走 estimateTokensOfBytes，
      // 再喂给 estimateTokensOf 会被当文本二次编码，实测误差可达数千倍。
      record.cost.bump('evidenceReReadTokens', estimateTokensOfBytes(reReadBytes))
      await persistCost(record)
    }
    return { kind: 'success', text: renderReadResults(results) }
  }

  async function history(invocation, args) {    const sessionId = sessionIdOf(invocation.agent.session)
    const pageSize = Number.parseInt(args[0] ?? '', 10)
    const afterId = args[1] ?? null
    const page = await withReadableStore(sessionId, (store) => listRecordsPage(labRoot, sessionId, {
      pageSize: Number.isInteger(pageSize) && pageSize > 0 ? pageSize : 20,
      afterId,
      store,
    }))
    if (!page) return { kind: 'error', text: '本会话没有 v2 库（从未启用）。' }
    if (page.entries.length === 0) {
      return { kind: 'success', text: '（没有更多记录）' }
    }
    const lines = page.entries.map((entry) => {
      const inline = entry.inline ?? {}
      const extra = inline.callId ? ` callId=${inline.callId}` : ''
      // range 是对象（{start,end}）而不是字符串：直接插值会渲染成 [object Object]，
      // 把「范围」这一列变成噪声。
      const range = formatRange(inline.range)
      const tools = Array.isArray(inline.tools) && inline.tools.length > 0
        ? ` 工具=${inline.tools.join(',')}`
        : ''
      return `${entry.id}  ${entry.kind}  保真=${entry.fidelity}${range}${tools}${extra}`
    })
    lines.push(`共 ${page.total} 条；本页 ${page.entries.length} 条`
      + (page.hasNextPage ? `；下一页从 ${page.nextAfter} 之后开始` : '；已到末页'))
    return { kind: 'success', text: lines.join('\n') }
  }

  /**
   * 只读按需召回：模型可见工具与命令面共用的唯一入口。
   *
   * 三种模式，全部只读、全部走 withReadableStore（本进程内唯一的句柄入口）：
   * - `ids`：按稳定 ID 精确回源，逐条计入 token 预算；
   * - `query`：**字面**检索（ID/kind/工具名/callId/正文子串），不是语义检索，
   *   也不返回任何分数——分数不是置信度，所以这里根本不产生分数；
   * - 空：返回有界工作状态卡。
   *
   * 不写库、不调用灵枢、不触发 consolidate/verify。
   */
  async function recall(sessionId, {
    recordIds = [],
    query = null,
    budgetTokens = RECALL_DEFAULT_BUDGET_TOKENS,
    session = null,
    attribution = 'command',
    cursor = null,
  } = {}) {
    const budgetPlan = parseBudgetTokens(budgetTokens, {
      fallback: RECALL_DEFAULT_BUDGET_TOKENS,
      max: RECALL_MAX_BUDGET_TOKENS,
    })
    if (!budgetPlan.ok) {
      return {
        engineEnabled: true,
        mode: 'none',
        entries: [],
        warnings: [],
        error: budgetPlan.error,
        usedTokens: 0,
        budgetTokens: null,
        matchedBy: null,
        nextCursor: null,
      }
    }
    // 坏游标必须显式报错：把「读错了」伪装成「读完了」会让调用方以为历史已读尽。
    let resume = null
    try {
      resume = requireCursor(cursor)
    } catch (error) {
      return {
        engineEnabled: true,
        mode: 'none',
        entries: [],
        warnings: [],
        error: error instanceof Error ? error.message : String(error),
        usedTokens: 0,
        budgetTokens: budgetPlan.value,
        matchedBy: null,
        nextCursor: null,
      }
    }
    const budget = budgetPlan.value
    const budgetNotes = []
    if (budgetPlan.clamped) {
      budgetNotes.push(`请求的 budget_tokens=${budgetPlan.requested} 超过上限 ${RECALL_MAX_BUDGET_TOKENS}，已按上限执行`)
    }
    if (resume) {
      if (resume.mode === CURSOR_MODES.IDS) {
        recordIds = resume.ids
        query = null
      } else {
        query = resume.query
        recordIds = []
      }
      budgetNotes.push(`从 cursor 续读（模式 ${resume.mode}${resume.skipped > 0 ? `，已跳过 ${resume.skipped} 条` : ''}）`)
    }
    const ids = [...new Set((recordIds ?? []).filter((id) => typeof id === 'string' && id.length > 0))]
    const literal = typeof query === 'string' && query.trim().length > 0 ? query.trim() : null

    const result = await withReadableStore(sessionId, async (store) => {
      if (ids.length > 0) {
        const entries = []
        const warnings = [...budgetNotes]
        let used = 0
        let stoppedAt = null
        for (let index = 0; index < ids.length; index += 1) {
          const id = ids[index]
          const remaining = budget - used
          if (remaining <= 0) {
            stoppedAt = index
            warnings.push(`预算 ${budget} token 已用尽，${id} 及之后未读取；用更大 budget_tokens 或按 next_cursor 续读`)
            break
          }
          let loaded = null
          try {
            // 有界读取：最多只从磁盘读 remaining 个 token 对应的字节数，
            // 不为了「先看有多大」把整篇载荷读进内存。
            loaded = await readWithForkFallback(store, sessionId, id, {
              maxBytes: remaining * BYTES_PER_TOKEN,
            })
          } catch (error) {
            warnings.push(`${id}：${error instanceof Error ? error.message : String(error)}`)
            continue
          }
          const text = typeof loaded.payloadText === 'string' ? loaded.payloadText : ''
          const cost = loaded.payloadText === null ? 0 : estimateTokensOf(text)
          if (cost > remaining) {
            // 第一条同样受预算约束：预算小于单条记录时不能因为「entries 为空」就
            // 把整条塞进去——那会让 used_tokens 超出 budget 且看起来没超。
            stoppedAt = index
            warnings.push(
              `预算 ${budget} token 不足，${id}（≈${cost} token）及之后未附正文；`
              + '用更大 budget_tokens、按 next_cursor 续读，或单独回读该 ID',
            )
            break
          }
          used += cost
          if (loaded.truncated) {
            warnings.push(
              `${id} 正文超出剩余预算，只带回首 ${Buffer.byteLength(text, 'utf8')} 字节 / 共 ${loaded.fullBytes} 字节；`
              + '本次未对全文做哈希校验（integrity=prefix），需要完整正文请单独回读该 ID',
            )
          }
          entries.push({
            id,
            resolvedId: loaded.id,
            resolvedVia: loaded.resolvedVia ?? null,
            kind: loaded.entry?.kind ?? null,
            fidelity: loaded.entry?.fidelity ?? null,
            integrity: loaded.integrity,
            tokens: cost,
            truncated: loaded.truncated === true,
            fullBytes: loaded.fullBytes ?? null,
            text: text || '（该记录无载荷：结构化索引记录）',
          })
        }
        // 包装与告警文本也占预算：不能只算正文再宣称「没超」。
        used += estimateTokensOf(warnings.join('\n'))
        const nextCursor = stoppedAt === null
          ? null
          : encodeCursor({ mode: CURSOR_MODES.IDS, ids: ids.slice(stoppedAt), skipped: stoppedAt })
        // 预算小到连「为什么读不完」的说明都放不下时，如实报溢出并说明原因——
        // 绝不能悄悄把 used 改小、或把说明吞掉来维持「没超预算」的样子。
        const overflow = used > budget
        return {
          mode: 'ids',
          entries,
          warnings,
          usedTokens: used,
          budgetTokens: budget,
          matchedBy: 'record-id',
          budgetOverflow: overflow,
          overflowReason: overflow
            ? `预算 ${budget} token 放不下「元数据 + 告警说明」本身（≈${used} token）；正文未完整带回，请提高 budget_tokens 或按 next_cursor 续读`
            : null,
          nextCursor,
        }
      }

      if (literal !== null) {
        const needle = literal.toLowerCase()
        // 多路检索：内置字面索引为主，语义后端（灵枢）作为可注入的附加路。
        // 命中只带来源，不带分数；后端失败如实降级并带出原因。
        // 后端按会话取用：只有该会话的隔离灵枢已经启动时才拿到它，
        // 否则这里是 null，检索如实走字面匹配（不会隐式起子进程）。
        const found = await searchRecords({
          store,
          backend: backendForSession(sessionId),
          text: needle,
          limit: RECALL_MAX_QUERY_HITS,
          literalMatcher: entryMatchesLiteral,
        })
        const warnings = [...budgetNotes]
        if (found.truncated) {
          warnings.push(`命中 ${found.totalMatched} 条，只返回前 ${found.records.length} 条；用 record_ids 精确回读全文`)
        }
        if (found.semanticError) {
          warnings.push(`语义检索后端不可用，已降级为内置字面索引：${found.semanticError}`)
        } else if (!found.semanticUsed) {
          // 没接上语义后端时说清楚「字面索引覆盖的是元数据」，别让模型把
          // 「0 命中」读成「库里没有这段历史」——正文词只能靠语义后端或按 ID 回读。
          warnings.push('本次只走内置字面索引（覆盖记录 ID、种类、工具名、callId、seq 范围等元数据，'
            + '不含正文词）；需要按正文内容检索时先 `/memory-lab2 index sync` 启动语义后端，'
            + '或用 record_ids 精确回读。')
        }
        // 续读：跳过已经列过的命中（稳定 ID 全序，游标只记住位置）。
        //
        // `after` 指向的是**第一条没装下的记录**，所以这里必须用 `>=` 把它包含进来。
        // 用 `>` 会把它永久排除：调用方收到「从 X 起未列出」，按 next_cursor 续读却
        // 永远读不到 X —— 那是分页静默漏读。IDS 模式的 `ids.slice(stoppedAt)` 本来就是
        // 包含语义，这里与它对齐。
        const remainingRecords = resume?.after
          ? found.records.filter((record) => compareRecordIds(record.id, resume.after) >= 0)
          : found.records
        // query 模式的元数据同样占预算：逐条累计，装不下就停并如实告知，
        // 不再硬编码 usedTokens=0 让「命中 20 条」看起来免费。
        const entries = []
        let used = 0
        let droppedByBudget = 0
        let stoppedAt = null
        for (let index = 0; index < remainingRecords.length; index += 1) {
          const record = remainingRecords[index]
          const entry = {
            id: record.id,
            kind: record.entry?.kind ?? null,
            fidelity: record.entry?.fidelity ?? null,
            seq: record.entry?.seq ?? null,
            refs: record.entry?.refs ?? {},
            hasPayload: Boolean(record.entry?.payload),
            sources: record.sources,
          }
          const cost = estimateTokensOf(JSON.stringify(entry))
          if (used + cost > budget) {
            // 预算不足时不静默截断：明说哪一条、还差多少，让调用方决定放大预算还是续读。
            warnings.push(
              `预算 ${budget} token 只够列出 ${entries.length}/${found.records.length} 条命中元数据，`
              + `从 ${record.id} 起未列出（本条元数据 ≈${cost} token）；用更大 budget_tokens、按 next_cursor 续读或 record_ids 精确回读`,
            )
            droppedByBudget = found.records.length - entries.length
            stoppedAt = record.id
            break
          }
          used += cost
          entries.push(entry)
        }
        used += estimateTokensOf(warnings.join('\n'))
        const nextCursor = stoppedAt === null
          ? null
          : encodeCursor({ mode: CURSOR_MODES.QUERY, query: literal, after: stoppedAt, skipped: entries.length })
        return {
          mode: 'query',
          matchedBy: found.semanticUsed ? 'literal+semantic' : 'literal',
          sources: found.sources,
          totalMatched: found.totalMatched,
          entries,
          warnings,
          usedTokens: used,
          budgetTokens: budget,
          budgetOverflow: used > budget,
          nextCursor,
        }
      }

      const card = cardFromStore(store, sessionId, Math.min(budget, WORKING_SET_DEFAULTS.cardTokens), session)
      const wrapperTokens = estimateTokensOf([...budgetNotes, ...(card.dropped?.length ? [`因预算丢弃 ${card.dropped.length} 段`] : [])].join('\n'))
      return {
        mode: 'working-set',
        entries: [],
        text: card.text,
        openCalls: card.openCalls ?? [],
        warnings: [...budgetNotes, ...(card.dropped?.length ? [`因预算丢弃 ${card.dropped.length} 段`] : [])],
        usedTokens: card.usedTokens + wrapperTokens,
        budgetTokens: card.budgetTokens,
        matchedBy: null,
        nextCursor: null,
        overflow: card.overflow === true,
        overflowReason: card.overflowReason ?? null,
      }
    })

    if (!result) {
      return {
        engineEnabled: false,
        mode: 'none',
        entries: [],
        warnings: ['本会话没有 v2 库（从未启用或隔离根已清理）'],
        usedTokens: 0,
        budgetTokens: budget,
        matchedBy: null,
        nextCursor: null,
      }
    }
    // 回读是要计账的：模型可见工具的回读与命令面回读同等归因，且落盘，
    // 否则「证据重读次数」在重启后归零、看起来像是没读过。
    await attributeRecall(sessionId, session, result, attribution)
    return { engineEnabled: true, ...result }
  }

  /**
   * 把一次回读记进成本账本并落盘。
   *
   * 记账只写引擎自己的状态文件，不碰只读冷库——「为了记账去写只读库」是不允许的。
   */
  async function attributeRecall(sessionId, session, result, attribution) {
    const record = records.get(sessionId) ?? (session ? await adopt({ session }) : null)
    if (!record) return
    const texts = []
    if (typeof result.text === 'string') texts.push(result.text)
    for (const entry of result.entries ?? []) if (typeof entry.text === 'string') texts.push(entry.text)
    const tokens = texts.length > 0 ? estimateTokensOf(texts.join('\n')) : 0
    if (result.mode === 'ids') {
      const hits = (result.entries ?? []).filter((entry) => entry.text).length
      if (hits > 0) {
        record.cost.bump('evidenceReReads', hits)
        record.cost.bump('evidenceReReadTokens', tokens)
      }
    }
    record.cost.bump('recallReads', 1)
    record.cost.bump('recallReturnedTokens', tokens)
    record.lastAction = `recall:${result.mode}:${attribution}`
    await persistCost(record)
  }

  /**
   * 从既有句柄直接渲染工作状态卡（只读召回路径用）。
   *
   * 与 `buildCard` 的区别：不需要活动记录，因而也不需要占用率与成本账本——
   * 只读召回不该有副作用，这里一个计数器都不动。
   */
  function cardFromStore(store, sessionId, budgetTokens, session) {
    // 配对账本取一次（Map 复制），卡片构建期按 callId 闭包查询：并行调用共享
    // 宿主 seq，seq 侧倒排无法与调用序列对位（错位句柄会误导模型回读别人正文）。
    const pairing = store.pairingLedger()
    const state = buildWorkingState({
      sessionId,
      surfaceNodes: session?.surface?.nodes ?? [],
      eventAt: (seq) => (typeof session?.eventAt === 'function' ? session.eventAt(seq) : null),
      openCalls: store.openCalls(),
      lastAssistantSeq: lastAssistantSeqOf(session),
      // 冷库里已经归档的宿主 seq → 稳定记录 ID：卡片要印出**工具真能回读**的 ID，
      // 而不是 `seq:N`（工具只认 t00000001-r0000 这种稳定 ID，印 seq 等于印废号）。
      recordIdsForSeq: (seq) => store.idsBySeq(seq),
      // callId → 调用/结果记录 ID 的精确对位：共享同一 seq 的并行调用各拿各的记录。
      recordIdsForCallId: (callId) => {
        const entry = pairing.get(callId)
        return entry ? { callRecordId: entry.callRecordId ?? null, resultRecordId: entry.resultRecordId ?? null } : null
      },
    })
    return renderWorkingSetInjection(state, { budgetTokens })
  }

  /**
   * 字面命中：ID / kind / 保真 / 工具名 / callId / 正文子串。
   *
   * 刻意不做语义检索、不算分数、不排序——分数不是置信度，
   * 语义召回留给灵枢那条路径，这里只承诺「字面命中」这一件可验证的事。
   *
   * 真实归档跨度把 `nodeId / range(对象) / tools(数组) / callIds(数组)` 放在
   * `inline` 里，而不是 `refs` 里：只扫 refs 会让「按 nodeId、按工具名、按范围、
   * 按 callId 搜索已归档操作」全部 0 命中——工具对模型宣称的能力必须真的能兑现。
   * 这里把 inline 结构化字段（含嵌套数组/对象）一并摊平进 haystack。
   */
  function entryMatchesLiteral(entry, needle) {
    const inline = entry.inline ?? {}
    const parts = [
      entry.id,
      entry.kind,
      entry.fidelity,
      entry.refs?.toolName,
      entry.refs?.callId,
      entry.refs?.command,
      entry.refs?.spanKind,
      entry.refs?.sourceKinds,
      inline.nodeId,
      inline.callId,
      inline.toolName,
      inline.spanKind,
      typeof inline.range === 'string' ? inline.range : null,
      Array.isArray(inline.tools) ? inline.tools.join(' ') : null,
      Array.isArray(inline.callIds) ? inline.callIds.join(' ') : null,
      inline.contentHash,
      // 回执上印的是「seq 2–3」这种写法：模型会照着抄，所以两种破折号都要能命中。
      rangeTokenOf(inline.range),
    ]
    const haystack = parts.filter((value) => typeof value === 'string').join(' ').toLowerCase()
    if (haystack.includes(needle)) return true
    // 结构化字段（如 range 对象 {start,end}）按 JSON 文本兜底，避免「范围 10-11」搜不到。
    const structured = [inline.range, inline.tools, inline.callIds, inline.extra]
      .filter((value) => value !== undefined && value !== null)
    if (structured.length === 0) return false
    try {
      return JSON.stringify(structured).toLowerCase().includes(needle)
    } catch {
      return false
    }
  }

  async function workingSet(invocation, args) {
    const sessionId = sessionIdOf(invocation.agent.session)
    const budgetPlan = parseBudgetArg(args[0], {
      fallback: WORKING_SET_DEFAULTS.cardTokens,
      max: WORKING_SET_MAX_BUDGET_TOKENS,
      label: 'working-set 预算',
    })
    if (!budgetPlan.ok) return { kind: 'error', text: budgetPlan.error }
    const packed = await withReadableStore(sessionId, (store) => packWorkingSet(labRoot, sessionId, {
      budgetTokens: budgetPlan.value,
      store,
    }))
    if (!packed) return { kind: 'error', text: '本会话没有 v2 库（从未启用）。' }
    const lines = [
      `预算 ${packed.budgetTokens} token，已用 ≈${packed.usedTokens} token，条目 ${packed.entries.length} 条`,
      ...packed.entries.map((entry) => `- ${entry.id} ${entry.kind}（保真=${entry.fidelity}`
        + `${entry.payloadIncluded ? `，含载荷 ≈${entry.text?.length ?? 0} 字` : ''}）`),
    ]
    if (packed.openCalls.length) {
      lines.push(`在途工具配对 ${packed.openCalls.length} 个（必须留在热上下文）：`
        + packed.openCalls.map((pair) => `${pair.callId}→${pair.callRecordId}`).join(', '))
    }
    if (packed.warnings.length) lines.push(`告警：${packed.warnings.join('；')}`)
    return { kind: 'success', text: lines.join('\n') }
  }

  /**
   * 构建本会话的工作状态卡（有界常驻）。
   *
   * 只用宿主结构事实 + v2 配对账本，不调用模型、不生成有损摘要。
   */
  async function buildCard(record, { budgetTokens = WORKING_SET_DEFAULTS.cardTokens, countDrops = true } = {}) {
    const session = record.agent?.session
    // 与 `cardFromStore` 同源：卡片里出现的宿主 seq 必须换成**工具真能回读**的稳定
    // 记录 ID。这里曾经漏传 `recordIdsForSeq`，于是注入路径的卡片只印 `seq:609`
    // 并自报 `readable:false`——模型照着抄，工具一律不认（审计 P2-5）。
    const state = await factoryFor(record).withStore((store) => {
      // 同 `cardFromStore`：配对账本一次取齐，按 callId 精确对位（并行调用共享 seq）。
      const pairing = store.pairingLedger()
      return buildWorkingState({
        sessionId: record.sessionId,
        surfaceNodes: session?.surface?.nodes ?? [],
        eventAt: (seq) => (typeof session?.eventAt === 'function' ? session.eventAt(seq) : null),
        openCalls: store.openCalls(),
        lastAssistantSeq: lastAssistantSeqOf(session),
        recordIdsForSeq: (seq) => store.idsBySeq(seq),
        recordIdsForCallId: (callId) => {
          const entry = pairing.get(callId)
          return entry ? { callRecordId: entry.callRecordId ?? null, resultRecordId: entry.resultRecordId ?? null } : null
        },
      })
    })
    const card = renderWorkingSetInjection(state, { budgetTokens })
    const budget = planWorkingSetBudget({
      contextWindow: record.occupancy?.host?.contextWindow ?? record.state.lastMeasurement?.contextWindow ?? 0,
      reservedCompletionTokens: record.occupancy?.host?.reservedCompletionTokens ?? 0,
      fixedBaseTokens: record.occupancy?.host?.assembledTokens ?? 0,
    })
    if (card.dropped.length > 0 && countDrops) record.cost.bump('workingStateDrops', card.dropped.length)
    return { state, card, budget }
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

  async function cardCommand(invocation, args) {
    const sessionId = sessionIdOf(invocation.agent.session)
    const record = records.get(sessionId) ?? await adopt(invocation.agent)
    if (!record) return { kind: 'error', text: 'v2 引擎在本会话未启用。先 `/memory-lab2 on`。' }
    const budgetPlan = parseBudgetArg(args[0], {
      fallback: WORKING_SET_DEFAULTS.cardTokens,
      max: WORKING_SET_MAX_BUDGET_TOKENS,
      label: 'card 预算',
    })
    if (!budgetPlan.ok) return { kind: 'error', text: budgetPlan.error }
    // 手工预览不是「注入」：不把预览的丢弃段数记进注入成本，
    // 否则跑几次 `/memory-lab2 card` 就会污染「因预算丢弃段数」这个真实运行指标。
    const { card, budget: plan } = await buildCard(record, {
      budgetTokens: budgetPlan.value,
      countDrops: false,
    })
    const lines = [
      card.text,
      '',
      `状态卡 ≈${card.usedTokens} token（卡片内部口径，4 字节≈1 token；注入记账走宿主 meter）${card.dropped.length ? `（因预算丢弃 ${card.dropped.length} 段）` : '（未丢弃）'}`,
      plan.overflow
        ? `工作集预算溢出：${plan.reason}`
        : `工作集可用动态预算 A ≈${plan.available} token（W=${plan.parts.contextWindow} − O=${plan.parts.reservedCompletionTokens} − B=${plan.parts.fixedBaseTokens} − M=${plan.parts.protocolMarginTokens} − P=${plan.parts.protectedTokens}）`,
      '本卡是确定性提取，不含模型摘要；未列出的内容不等于不存在，可按记录 ID 回读。',
    ]
    if (card.overflow) lines.push(`⚠ ${card.overflowReason}`)
    return { kind: 'success', text: lines.join('\n') }
  }

  async function recallCommand(invocation, args) {
    const sessionId = sessionIdOf(invocation.agent.session)
    const useIds = args[0] === 'id'
    const rest = useIds ? args.slice(1) : args
    const ids = useIds ? rest.flatMap((arg) => arg.split(',')).filter(Boolean) : []
    const query = useIds ? null : (rest.join(' ').trim() || null)
    const result = await recall(sessionId, { recordIds: ids, query, session: invocation.agent.session })
    // 复用工具渲染：命令面与模型可见工具看到的是同一份措辞。
    return { kind: 'success', text: renderToolOutput(sessionId, toToolValue(sessionId, result)) }
  }

  /**
   * `/memory-lab2 index [status]`：增量索引状态与同步。
   *
   * 没有注入语义后端时如实报告「未接后端」，不假装索引可用。
   */
  async function indexCommand(invocation, args) {
    const sessionId = sessionIdOf(invocation.agent.session)
    const record = records.get(sessionId)
    if (!record) return { kind: 'error', text: 'v2 引擎在本会话未启用。' }
    const statusOnly = (args[0] ?? 'status') === 'status'
    const retrievalIndex = await readRetrievalIndex(record.directory)

    /** 后端不可用时的如实报告：不假装索引可用，也不回退正式灵枢根。 */
    const unavailable = (reason) => {
      const existing = retrievalIndex
      return {
        kind: 'success',
        text: [
          `检索后端：不可用 —— ${reason}`,
          existing
            ? `历史索引记账：后端 ${existing.backend}，${Object.keys(existing.indexed ?? {}).length} 条（陈旧记账，当前后端未生效）。`
            : '历史索引记账：无。',
          '此时 /memory-lab2 recall 与 memory_lab_recall 只走内置字面匹配；',
          '字面匹配是降级，不冒充语义召回，也不会回退到正式灵枢根。',
        ].join('\n'),
      }
    }

    let backend = backendFor(record)
    let startupReason = null
    if (!backend && typeof semanticBackendEnsure === 'function') {
      const started = await semanticBackendEnsure({
        sessionId,
        storeRoot: record.directory,
        signal: invocation.signal ?? undefined,
      })
      backend = started?.backend ?? null
      startupReason = started?.reason ?? null
    }
    if (!backend) {
      return unavailable(startupReason
        ?? (typeof semanticBackendFor === 'function' || semanticBackend
          ? '后端尚未为该会话启动且本次启动失败'
          : '本安装未提供检索后端（未注入后端解析器）'))
    }

    const capabilities = backend.capabilities ?? null
    const capabilityLine = capabilities
      ? `后端 ${backend.name}：${capabilities.kind}${capabilities.semanticVectors ? '（含向量）' : '（不含向量语义检索）'}；view=${capabilities.view}`
      : `后端 ${backend.name}`

    if (statusOnly) {
      return {
        kind: 'success',
        text: retrievalIndex
          ? `${capabilityLine}\n索引记账：${Object.keys(retrievalIndex.indexed ?? {}).length} 条，更新于 ${retrievalIndex.updatedAt}`
          : `${capabilityLine}\n索引记账：无（尚未同步）`,
      }
    }
    const synced = await factoryFor(record).withStore((store) => syncRetrievalIndex({
      directory: record.directory,
      backend,
      store,
    }))
    const lines = [
      capabilityLine,
      `本次新增索引 ${synced.indexedNow} 条，累计 ${synced.indexedTotal}/${synced.total}。`,
      synced.rebuilt ? '（换了后端，记账作废并从零重建）' : '（增量：只处理新增记录）',
    ]
    if (synced.skippedNow.length > 0) {
      // 后端明确拒收的条目：记账里没有它们，召回就缺它们。必须说出来。
      lines.push(`后端未接收 ${synced.skippedNow.length} 条（未计入索引记账，召回会缺这些段）：${synced.skippedNow.slice(0, 5).join(', ')}${synced.skippedNow.length > 5 ? ' …' : ''}`)
    }
    if (synced.indexedTotal < synced.total) {
      lines.push(`索引尚未覆盖全部记录（${synced.indexedTotal}/${synced.total}）；未覆盖部分按记录 ID 仍可精确回读。`)
    }
    return { kind: 'success', text: lines.join('\n') }
  }

  /** `/memory-lab2 relations <记录ID>`：只报可验证的结构关系。 */
  async function relationsCommand(invocation, args) {
    const sessionId = sessionIdOf(invocation.agent.session)
    const recordId = args[0]
    if (!recordId) return { kind: 'error', text: '用法：`/memory-lab2 relations <记录ID>`。' }
    const record = records.get(sessionId)
    if (!record) return { kind: 'error', text: 'v2 引擎在本会话未启用。' }
    return factoryFor(record).withStore(async (store) => {
      const [forkMap, retrievalIndex] = await Promise.all([
        readForkMap(labRoot, sessionId),
        readRetrievalIndex(record.directory),
      ])
      const described = describeRecordRelations({
        store,
        recordId,
        forkMap,
        retrievalIndex,
        backendName: backendFor(record)?.name ?? null,
      })
      const lines = []
      if (described.relations.length === 0) {
        lines.push(`${recordId}（${described.kind}）：无已解析的结构关系（配对、fork、索引均未命中）。`)
      } else {
        lines.push(`${recordId}（${described.kind}）的结构关系：`)
        lines.push(...described.relations.map((relation) => `- ${relation.kind}/${relation.relation} → ${relation.recordId}${relation.callId ? `（callId ${relation.callId}）` : ''}`))
      }
      // 有引用但目标不在本库时如实说明，不用「无关系」掩盖。
      for (const item of described.unresolved ?? []) {
        lines.push(`- 未解析引用：${item.ref}=${item.value}（${item.note}）`)
      }
      lines.push('以上只列可验证的结构关系；本命令不做语义推断。')
      return { kind: 'success', text: lines.join('\n') }
    })
  }

  async function costCommand(invocation) {
    const sessionId = sessionIdOf(invocation.agent.session)
    const record = records.get(sessionId) ?? await adopt(invocation.agent)
    if (!record) {
      const stored = await readV2SessionState(labRoot, sessionId)
      if (!stored) return { kind: 'error', text: 'v2 引擎在本会话未启用。' }
      return { kind: 'success', text: renderCostReport(stored.state.cost, { sessionId }) }
    }
    return { kind: 'success', text: renderCostReport(record.cost.snapshot(), { sessionId }) }
  }

  /**
   * 供注入钩子使用：返回要追加的工作状态消息，或 null（未启用／无需注入）。
   *
   * 只在「本会话确实有已退热历史」时注入：没有回执就说明热上下文里什么都还在，
   * 再塞一张状态卡纯属重复计费。这是成本纪律，不是功能开关。
   */
  /**
   * 宿主 meter 口径的卡片 token（D5 统一尺子）。
   *
   * 归档侧的 originalTokens 是宿主 tokenMeter 的启发式价，注入侧此前用的却是
   * `estimateTokensOf`（4 字节≈1 token）——同一批卡片两把尺子差 2.01 倍（实测
   * 429,145 vs 213,247 token），成本报表无法自洽。这里把注入记账拉回宿主 meter：
   * meter 不可用时返回 null，调用方记「未计量」次数，**不折算混记**。
   */
  function hostMeterTokensOf(text) {
    try {
      const meter = typeof services?.get === 'function' ? services.get('tokenMeter') : null
      if (!meter || typeof meter.estimateMessage !== 'function') return null
      const tokens = meter.estimateMessage({ role: 'user', content: [{ type: 'text', text }] })
      return Number.isFinite(tokens) && tokens >= 0 ? Math.floor(tokens) : null
    } catch {
      return null
    }
  }

  async function workingSetInjection(agent) {
    const record = await adopt(agent)
    if (!record) return null
    if (record.state.settings?.workingSet === false) return null
    if (engine.pendingReceipts(record).length === 0) return null
    const { card } = await buildCard(record)
    if (!card.text) return null

    // D1 升级（c896f803 循环根因 #1）：固定协议文案（约 33 行）不再随每张卡重复。
    // 全量卡只在会话首张与每 WORKING_SET_FULL_REFRESH_EVERY 张再锚定时注入；
    // 其余步注入**增量卡**——相对上一张全量卡的行级变化（多集行差异：新增行
    // 按段标题列出，消失行只报计数）。实测全量卡 ≈1.8k token/步且 95% 逐字相同，
    // 增量卡把每步注入量降到变化行量级。
    //
    // 去重与形态裁决都收在引擎里（此前在 index.mjs）：只有这里能在「裁决为跳过」
    // 时不推进注入状态，避免「状态记了、消息没注」的错位——错位会让下一张增量卡
    // 引用一个模型从未见过的全量卡。
    const cardState = record.workingSetCard ?? { text: null, injections: 0, keys: [] }
    const dedupKey = card.prefix?.dedupKey ?? workingSetDedupKeyOf(card.text)
    const verdict = decideWorkingSetInjection({
      dedupKey,
      sessionId: record.sessionId,
      injectedKeys: cardState.keys,
      limit: WORKING_SET_DEDUP_HISTORY_LIMIT,
    })
    if (!verdict.inject) return null

    const fullCard = shouldInjectFullWorkingStateCard({
      previousText: cardState.text,
      injectionCount: cardState.injections,
    })
    let text = card.text
    let form = 'full'
    if (!fullCard) {
      const delta = workingStateCardDelta({ previousText: cardState.text, nextText: card.text })
      // 相对上一张全量卡没有任何行变化：语义键仍判新说明只是键历史外的抖动，
      // 没有可注入的新信息，跳过（与去重同向，双保险）。
      if (delta === null) return null
      text = delta.text
      form = 'delta'
    }
    // 状态只在「确定要注入」后推进：verdict.inject 为 false 的路径已在上面返回。
    record.workingSetCard = {
      text: card.text,
      injections: cardState.injections + 1,
      keys: verdict.keys,
    }

    record.cost.bump('workingStateInjections', 1)
    record.cost.bump(form === 'full' ? 'workingStateFullInjections' : 'workingStateDeltaInjections', 1)
    // D5：注入记账只认宿主 meter（与归档侧 originalTokens 同一把尺子）。卡片内部
    // 的 usedTokens 仍是装包预算口径（4 字节≈1 token），那只是控制参数，不进账本。
    // meter 不可用 → 记「未计量」次数，不按内部口径折算冒充（两种口径进同一个
    // 计数器正是实测 2.01 倍口径差的病根）。
    const hostTokens = hostMeterTokensOf(text)
    if (hostTokens !== null) {
      record.cost.bump('workingStateTokens', hostTokens)
    } else {
      record.cost.bump('workingStateTokensUnmetered', 1)
    }
    // 注入计数必须落盘：这是每步都会走的常驻路径，只改内存的话重启就归零，
    // 「这张卡到底花了多少」永远算不清。同一份纪律适用于 read/recall/批量归档。
    await persistCost(record)
    return {
      text,
      usedTokens: card.usedTokens,
      hostTokens,
      dropped: card.dropped,
      // 注入形态（full/delta）：调用方与报表据此区分全量与增量。
      form,
      dedupKey,
      // 调用方据此去重：前缀哈希不变 = 同一张卡，不需要再注入一次。
      prefixHash: card.prefix?.hash ?? null,
    }
  }

  async function importV1(invocation) {
    const sessionId = sessionIdOf(invocation.agent.session)
    const record = records.get(sessionId) ?? await adopt(invocation.agent)
    if (!record) return { kind: 'error', text: 'v2 引擎在本会话未启用。先 `/memory-lab2 on`。' }
    // v1 账本只读：直接读 v1 状态文件的 archive 指针条目，绝不写 v1 目录。
    let v1State = null
    try {
      v1State = await readSessionState(labRoot, sessionId)
    } catch (error) {
      return { kind: 'error', text: `读取 v1 账本失败：${error instanceof Error ? error.message : String(error)}` }
    }
    const archive = Array.isArray(v1State?.state?.archive) ? v1State.state.archive : []
    if (archive.length === 0) {
      return { kind: 'success', text: '本会话没有 v1 归档条目可导入。' }
    }
    const summary = await factoryFor(record).withStore((store) => importV1ArchiveEntries(store, archive))
    return { kind: 'success', text: [
      `v1 归档导入：扫描 ${archive.length} 条，导入 ${summary.recordIds.length} 条，跳过 ${summary.skipped} 条（已存在）。`,
      summary.recordIds.length > 0
        ? '这是指针级导入：v2 侧只存 v1 条目描述符（nodeId/hash/范围/callIds），原文仍只在 v1 冷库，需回 v1 按 nodeId 取；不冒充 verbatim 原文。'
        : '没有需要导入的条目。',
    ].join('\n') }
  }

  /**
   * `/memory-lab2 fork-status`：只读预览本会话闭包能不能搬、有多大。
   *
   * 不写任何文件；借活动句柄读（同一目录只允许一个句柄，重开会 EOPEN）。
   */
  async function forkStatus(invocation) {
    const parentSessionId = sessionIdOf(invocation.agent.session)
    try {
      const plan = await planForkClosure({ labRoot, parentSessionId })
      if (!plan.exists) {
        return { kind: 'success', text: '本会话没有 v2 账本，没有可继承闭包（fork 会以 EFORKNOPARENT 拒绝）。' }
      }
      const lines = [
        `父会话 ${parentSessionId}：${plan.recordCount} 条记录，载荷 ${plan.payloadBytes} 字节，未提交事务 ${plan.pendingTransactions} 个。`,
        `闭包指纹 ${plan.closureFingerprint ?? '不可计算'}。`,
      ]
      if (plan.blocked.length > 0) lines.push(`不可迁移：${plan.blocked.join('；')}`)
      else lines.push('可以迁移：`/memory-lab2 fork <子会话ID>`。')
      if (plan.warnings.length > 0) lines.push(`告警（不阻断）：${plan.warnings.join('；')}`)
      return { kind: 'success', text: lines.join('\n') }
    } catch (error) {
      return { kind: 'error', text: `fork-status 失败：${error instanceof Error ? error.message : String(error)}` }
    }
  }

  /** `/memory-lab2 fork-reset <子会话ID>`：清掉 fork 半成品子库，让失败可重试。 */
  async function forkReset(invocation, args) {
    const childSessionId = String(args[0] ?? '').trim()
    if (!childSessionId) {
      return { kind: 'error', text: '用法：`/memory-lab2 fork-reset <子会话ID>`（只清带 needs-migration 标记的半成品）。' }
    }
    try {
      const result = await resetForkChild({ labRoot, childSessionId })
      if (!result.reset) {
        return { kind: 'success', text: `子会话 ${childSessionId} 没有 v2 账本，无需清理。` }
      }
      return { kind: 'success', text: `已清掉子会话 ${childSessionId} 的 fork 半成品；现在可以重新执行 fork。` }
    } catch (error) {
      return { kind: 'error', text: `fork-reset 失败：${error instanceof Error ? error.message : String(error)}` }
    }
  }

  /**
   * `/memory-lab2 fork <子会话ID>`：把本会话闭包复制进子会话隔离根。
   *
   * 只写**尚未建档**的子会话；ID 逐字保留；父库只读不改。
   */
  async function forkTo(invocation, args) {
    const parentSessionId = sessionIdOf(invocation.agent.session)
    const childSessionId = String(args[0] ?? '').trim()
    if (!childSessionId) {
      return { kind: 'error', text: '用法：`/memory-lab2 fork <子会话ID>`（子会话必须尚未建立 v2 账本）。' }
    }
    if (childSessionId === parentSessionId) {
      return { kind: 'error', text: '子会话不能是当前会话。' }
    }
    try {
      const result = await executeForkClosure({ labRoot, parentSessionId, childSessionId })
      return { kind: 'success', text: [
        `fork 完成：${result.recordCount} 条记录复制进子会话 ${childSessionId}。`,
        `闭包指纹 ${result.closureFingerprint}（父子一致才落盘）。`,
        '记录 ID 逐字保留：子会话可直接按旧 ID 回读；父库未被改动。',
        `子会话尚未启用 v2；在子会话执行 /memory-lab2 on 接管投影。`,
      ].join('\n') }
    } catch (error) {
      const code = error instanceof EngineV2Error ? error.code : 'EFORK'
      // 只有**真的**留下了 needs-migration 标记才这么说。fork 在写子库之前就失败
      // （父库不可读、父闭包被阻断）时子会话目录根本不存在，报「已标记」是谎报，
      // 会把用户指向一个不存在的恢复入口。
      let marker = null
      try { marker = await readNeedsMigration(labRoot, childSessionId) } catch { marker = null }
      return {
        kind: 'error',
        text: [
          `fork 未完成（${code}）：${error instanceof Error ? error.message : String(error)}`,
          marker
            ? `子会话已标记 needs-migration；用 /memory-lab2 fork-reset ${childSessionId} 清掉半成品后重试。`
            : '子会话未被改动（未留下标记），处理完上面的原因后可直接重试。',
        ].filter(Boolean).join('\n'),
      }
    }
  }

  async function runNow(invocation, { dryRun }) {
    const record = records.get(sessionIdOf(invocation.agent.session)) ?? await adopt(invocation.agent)
    if (!record) {
      return { kind: 'error', text: 'v2 引擎在本会话未启用。先 `/memory-lab2 on`。' }
    }
    const outcome = await engine.runOnce(record, undefined, { dryRun })
    // 预演零副作用：不记账（它没提交任何东西）。
    if (!dryRun) {
      accountBatch(record, outcome)
      await indexNewRecords(record)
    }
    // 全失败不能报成功：runOnce 失败关闭时返回 kind:'error'，命令面必须跟随它，
    // 否则「一段都没归档」会被渲染成「已归档一批」。
    return {
      kind: outcome?.kind === 'error' ? 'error' : 'success',
      text: outcome?.text ?? JSON.stringify(outcome),
    }
  }

  async function setSetting(invocation, args) {
    // 与 status/read 一致：重启后先接管磁盘上已启用的会话，否则「设置成功」在
    // 进程重启后会变成「未启用」——那是错的，会话在磁盘上确实是启用的。
    const record = records.get(sessionIdOf(invocation.agent.session)) ?? await adopt(invocation.agent)
    if (!record) return { kind: 'error', text: 'v2 引擎在本会话未启用。' }
    const [key, rawValue] = args
    const settings = record.state.settings
    if (key === 'auto' || key === 'recall') {
      const target = key === 'auto' ? 'auto' : 'autoRecall'
      if (rawValue !== 'on' && rawValue !== 'off') {
        return { kind: 'error', text: `用法：\`/memory-lab2 set ${key} on|off\`` }
      }
      settings[target] = rawValue === 'on'
    } else if (key === 'batch' || key === 'retain') {
      const target = key === 'batch' ? 'archiveBatchSize' : 'retainOperations'
      const value = Number.parseInt(rawValue ?? '', 10)
      if (!Number.isInteger(value) || value < 1) {
        return { kind: 'error', text: `用法：\`/memory-lab2 set ${key} <正整数>\`` }
      }
      settings[target] = value
    } else if (key === 'fullhistory') {
      // 全历史记忆上下文：独立于 settings 五字段存在（normalizeSettings 会把它剥掉），
      // 引擎按 record.state.fullHistory 读取。开启即代表「除不可压缩凭证外全部退热」，
      // 「保留最近操作」同时失效（面板输入框变灰）。
      if (rawValue !== 'on' && rawValue !== 'off') {
        return { kind: 'error', text: '用法：`/memory-lab2 set fullhistory on|off`' }
      }
      record.state.fullHistory = rawValue === 'on'
      if (record.state.fullHistory) {
        settings.retainOperations = normalizeSettings(settings).retainOperations
      }
    } else if (key === 'planfirst') {
      // 插件级开关（与 /memory-lab set planfirst 同义）：v2 账本只记位置，
      // 联动动作由注入的回调执行（服务缺失时回调返回提示，不阻断）。
      if (rawValue !== 'on' && rawValue !== 'off') {
        return { kind: 'error', text: '用法：`/memory-lab2 set planfirst on|off`' }
      }
      record.state.planFirst = rawValue === 'on'
      const note = (await onPlanFirstToggle?.(invocation.agent, rawValue === 'on')?.catch(() => null)) ?? null
      record.state.settings = normalizeSettings(settings)
      await writeV2SessionState(record.directory, record.state)
      const lines = [`新会话计划先行已设为 ${rawValue === 'on' ? '开' : '关'}（写入 v2 账本）。`]
      if (note) lines.push(note.text)
      return { kind: 'success', text: lines.join('\n') }
    } else {
      return { kind: 'error', text: `未知设置项 ${key ?? ''}；支持 auto|recall|batch|retain|fullhistory|planfirst。` }
    }
    record.state.settings = normalizeSettings(settings)
    // 设置必须落盘：只改内存会让「设置成功」在重启后失效，而 v1 的 set 是持久的。
    await writeV2SessionState(record.directory, record.state)
    return { kind: 'success', text: `已设置 ${key}=${rawValue}（写入 v2 账本，重启后仍生效）。` }
  }

  // ── 命令处理 ─────────────────────────────────────────────────────────────

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
      case 'recall': return recallCommand(invocation, parsed.args)
      case 'index': return indexCommand(invocation, parsed.args)
      case 'relations': return relationsCommand(invocation, parsed.args)
      case 'history': return history(invocation, parsed.args)
      case 'working-set': return workingSet(invocation, parsed.args)
      case 'import-v1': return importV1(invocation)
      case 'fork': return forkTo(invocation, parsed.args)
      case 'fork-status': return forkStatus(invocation)
      case 'fork-reset': return forkReset(invocation, parsed.args)
      case 'now': return runNow(invocation, { dryRun: false })
      case 'dry-run': return runNow(invocation, { dryRun: true })
      case 'set': return setSetting(invocation, parsed.args)
      default: return { kind: 'success', text: V2_HELP }
    }
  }

  // ── 自动钩子 ─────────────────────────────────────────────────────────────

  async function autoCooling(agent, signal) {
    const record = await adopt(agent)
    if (!record) return { action: 'skip' }
    const outcome = await engine.runAutoCooling(record, signal)
    accountBatch(record, outcome)
    // 全历史模式下，灵枢临时记忆是一等回注来源：有写入就保证后端在线并增量同步。
    // 启动一次，之后 backendForSession 直接命中；启动失败不重试、不影响归档，
    // 状态面照实显示「检索当前只用字面索引」。
    if (record.state.fullHistory === true && Number(outcome.applied) > 0 && !backendForSession(record.sessionId)) {
      try {
        if (typeof semanticBackendEnsure === 'function') {
          await semanticBackendEnsure({
            sessionId: record.sessionId,
            storeRoot: record.directory,
            signal: signal ?? undefined,
          })
        }
      } catch (error) {
        logger?.warn?.(`v2 全历史模式检索后端启动失败（归档不受影响）：${error?.message ?? error}`)
      }
    }
    await indexNewRecords(record)
    return outcome
  }

  /**
   * 归档之后增量更新检索索引——**只在后端已经为该会话启动时**。
   *
   * 为什么不隐式启动：起一个隔离灵枢子进程是有真实代价的动作，自动降温每批都
   * 触发它会把「按需」变成「无条件」。所以启动权留给显式的 `/memory-lab2 index sync`，
   * 之后新写入的记录会随归档增量进索引，不需要反复手工同步。
   *
   * 索引失败不影响归档结果（原文已经在权威事务里）：如实记一条告警，
   * 状态面的「索引记账」会显示缺口，绝不把失败说成索引完整。
   */
  async function indexNewRecords(record) {
    const backend = backendForSession(record?.sessionId ?? null)
    if (!backend || typeof record?.directory !== 'string') return
    try {
      const synced = await factoryFor(record).withStore((store) => syncRetrievalIndex({
        directory: record.directory,
        backend,
        store,
      }))
      if (synced.indexedTotal < synced.total) {
        logger?.warn?.(`v2 索引未覆盖全部记录（${synced.indexedTotal}/${synced.total}），`
          + '未覆盖部分仍可按记录 ID 精确回读')
      }
    } catch (error) {
      logger?.warn?.(`v2 归档后增量索引失败（原文已保存，索引落后）：${error?.message ?? error}`)
    }
  }

  /**
   * 把一次批量结果记进成本账本。
   *
   * 计数必须挂在**真正发生提交**的地方：`recordsWritten` 用实际写入的记录数，
   * `historyReplacements` 用实际替换的段数。没有提交就一个都不加——「跑了但没写」
   * 不能算成写入，否则账本会替一个没发生的动作作证。
   */
  function accountBatch(record, outcome) {
    if (!record?.cost || !outcome) return
    const applied = Number(outcome.applied)
    if (!Number.isFinite(applied) || applied <= 0) return
    record.cost.bump('historyReplacements', applied)
    record.cost.bump('memoryWrites', 1)
    const written = Number(outcome.recordsWritten)
    record.cost.bump('recordsWritten', Number.isFinite(written) && written > 0 ? written : applied)
    void persistCost(record)
  }

  async function buildRecall(agent, decision, signal) {
    const record = await adopt(agent)
    if (!record || !engine.settingsOf(record).autoRecall) return decision
    if (engine.pendingReceipts(record).length === 0) return decision
    const query = recallQueryFrom(decision.messages)
    if (!query || record.recallQueryId === query.id) return decision
    record.recallQueryId = query.id
    const digest = await engine.buildRecall(record, query.text.slice(0, MAX_RECALL_QUERY_CHARS), signal)
    // 合并后的引擎 buildRecall 契约：`{ text, hits, status, reason, ... }`，非 OK 时
    // `text` 为空串。空文本一律不注入（失败关闭），命中数从 `hits` 取。
    if (!digest || typeof digest.text !== 'string' || digest.text === '') return decision
    const text = escapePromptBraces(renderRecallBlock(digest.text))
    // 自动回注同样要计账：审计发现 `recallReads=0` 而活动面已经出现 recall 块——
    // 只有命令面/工具面回读记账，自动回注不记账，成本报表就会漏掉最大的一笔。
    // 记账失败不得阻塞注入（失败关闭只针对「注入」本身）。
    try {
      await attributeRecall(record.sessionId, record.agent?.session ?? null, {
        mode: 'query',
        text,
        entries: Array.isArray(digest.hits) ? digest.hits : [],
      }, 'auto')
    } catch (error) {
      logger?.warn?.(`v2 自动回注记账失败：${error?.message ?? error}`)
    }
    return {
      ...decision,
      messages: [...decision.messages, {
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: PACKAGE_NAME, form: 'recall' },
      }],
    }
  }

  async function shutdown() {
    await Promise.allSettled([...activeOperations])
    for (const record of records.values()) {
      try { await disposeRecord(record) } catch { /* best-effort */ }
    }
    records.clear()
    factories.clear()
    // 兜底：disposeRecord 只覆盖仍在册的会话。任何已启动但会话已不在册的
    // 隔离灵枢子进程也要收掉，否则进程退出后留下孤儿 Python。
    try {
      await semanticBackendCloseAll?.()
    } catch (error) {
      logger?.warn?.(`v2 检索后端整体释放失败：${error?.message ?? error}`)
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
    importV1,
    commandHandler,
    autoCooling,
    buildRecall,
    workingSetInjection,
    shutdown,
    // 测试与诊断入口。
    guardCandidate,
    v2ArchiveNodeId,
  }
}

export { V2_RECEIPT_MARKER }
