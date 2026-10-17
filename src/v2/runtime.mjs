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
  buildForgetTombstone,
  buildSpanReceipt,
  escapePromptBraces,
  normalizeSettings,
  renderRecallBlock,
  restoreGrowth,
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
  COMPRESS_SUBCOMMANDS,
  compressPreview,
  compressRun,
  compressStatus,
  describeHierarchyError,
  expandVoucher,
  maybeStageCompress,
  reconcileVouchers,
} from './hierarchy-coordinator.mjs'
import { AGG_VOUCHER_MARKER } from './agg-voucher.mjs'
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
import { compareRecordIds, parseRecordId } from './records.mjs'
import { readRecordById, listRecordsPage, packWorkingSet } from './readback.mjs'
import { resolveReadTargets } from './identity-index.mjs'
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
import { planCardFolds } from './card-fold.mjs'
import { extractClaims } from './claims.mjs'
import { renderToolOutput, toToolValue } from './tool.mjs'
import { searchRecords, syncRetrievalIndex, readRetrievalIndex, describeRecordRelations } from './retrieval.mjs'
import { planQuery } from './query-plan.mjs'
import {
  DispositionError,
  applyForget,
  applyUndo,
  buildForgetPreview,
  describeForgetStatus,
  getForgetIndex,
  getForgetPlan,
  isForgotten,
  nodeUnitBase,
  resolveForgetTargets,
  saveForgetPlan,
} from './disposition.mjs'
import { invalidateProvenance, registerProvenanceEdge } from './provenance-index.mjs'
import { syncVerification, checkRecords, markRecordsStale, annotateStale } from './verification.mjs'
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
  '/memory-lab2 verify <记录ID...> 验证跟踪：核对记录引用的文件与归档时是否一致（三态，只读）',
  '/memory-lab2 mark-stale <记录ID> <原因>   人工把记录标记为失效（只写旁证，不改不可变记录）',
  '/memory-lab2 forget preview <目标…> 预览主动遗忘：目标=记录ID|nodeId|callId|kind=片段|before=<记录ID>',
  '                                  宽条件必须先预览拿计划ID；硬保护目标会被拦截并列出',
  '/memory-lab2 forget apply <计划ID|目标…> 提交软遗忘（回执换墓碑、读面不再泄漏、可 undo）',
  '/memory-lab2 forget undo <操作ID>   撤销一次遗忘：只恢复可见性，原文回注仍需显式 restore',
  '/memory-lab2 forget status [操作ID] 账本与收口状态：操作清单、待收口条目、隔离灵枢残留披露',
  '/memory-lab2 compress preview   预览层级压缩：连续回执组 → 聚合凭证候选与 no-safe-gain 报告',
  '                                  （层级压缩默认关，preview 只读不改任何状态）',
  '/memory-lab2 compress run       按事务序提交压缩：凭证替换、层级账本落盘、可重复收口',
  '/memory-lab2 compress status    层级账本状态：L0–L3 与凭证清单（只读，未启用也能查）',
  '/memory-lab2 expand <凭证ID> [页] 分页展开聚合凭证成员原文（恒定只读面，不替换任何投影）',
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
    const viaAlias = item.resolvedVia === 'node-alias' || item.resolvedVia === 'call-id'
      ? `\n（经 ${item.resolvedVia} 别名解析自 ${item.requestedId}；span 分块已按 chunk 序合并，配对记录为来源索引）`
      : ''
    // 人工失效标记的注记（mark-stale 写入旁证；内容级失效用 verify 命令裁决）。
    const stale = item.staleReason ? `\n⚠ 该记录已被人工标记为失效（${item.staleReason}）；引用前请先 /memory-lab2 verify。` : ''
    blocks.push(`${head}${note}${via}${viaAlias}${stale}\n${item.text}`)
  }
  return blocks.join('\n\n')
}

/**
 * 别名回读（0.10.1 S2a/S2b）：把回执/工具面可见的 nodeId（基名/分块名）与 callId
 * 解析到单元闭包的记录 ID，span 分块按 chunk 序合并拼接，pair 记录独立成条。
 *
 * 复用只读 identity-index（与 forget 的单元闭包同口径，但不带宽条件/硬保护/写入）；
 * fork 与遗忘守卫仍在 readRecordById 层生效——别名只解决「ID 形态失配」
 * （取证 §5 S2：回执只印 mcl2-… nodeId，模型按它回读必然全部落 warnings）。
 *
 * 返回逐目标结果数组（与 renderReadResults 的输入形状一致）。
 */
async function readByAlias(store, labRoot, sessionId, target, { maxBytes = null } = {}) {
  const entries = store.listEntries({ limit: Number.MAX_SAFE_INTEGER }).entries
  const { resolved, unresolved } = resolveReadTargets({ targets: [target], entries })
  if (unresolved.length > 0) {
    return [{ id: target, ok: false, error: 'EREADNOTFOUND：无法解析的标识（不是本会话已知的记录 ID / 冷节点 / callId）。' }]
  }
  const item = resolved[0]
  if (!item || item.recordIds.length === 0) {
    return [{ id: target, ok: false, error: 'EREADALIASEMPTY：别名存在但展开为空。' }]
  }
  // span 分块合并 + pair 独立条目：按 identity-index 的顺序（span chunk 序在前）。
  const results = []
  let spanParts = []
  let spanHead = null
  const flushSpan = () => {
    if (spanParts.length === 0) return
    const text = spanParts.join('')
    results.push({
      id: spanHead.base,
      requestedId: target,
      resolvedVia: item.resolvedVia,
      ok: true,
      kind: 'projection.span（合并）',
      fidelity: spanHead.fidelity ?? null,
      integrity: spanHead.integrity ?? 'ok',
      bytes: Buffer.byteLength(text, 'utf8'),
      text,
    })
    spanParts = []
    spanHead = null
  }
  for (const recordId of item.recordIds) {
    const entry = store.getEntry(recordId)
    const isSpan = entry?.kind === 'projection.span'
    let loaded
    try {
      loaded = await readRecordById(labRoot, sessionId, recordId, { store, maxBytes })
    } catch (error) {
      // 遗忘守卫（EFORGOTTEN）等失败不吞：整段别名读失败关闭。
      if (isSpan) flushSpan()
      results.push({ id: target, requestedId: target, resolvedVia: item.resolvedVia, ok: false, error: `${error?.code ?? 'E'}：${error instanceof Error ? error.message : String(error)}` })
      return results
    }
    if (isSpan) {
      if (spanHead && spanHead.base !== nodeUnitBase(entry.inline?.nodeId)) flushSpan()
      if (!spanHead) {
        spanHead = {
          base: nodeUnitBase(entry.inline?.nodeId) ?? recordId,
          fidelity: loaded.entry?.fidelity ?? null,
          integrity: loaded.integrity ?? 'ok',
        }
      }
      spanParts.push(typeof loaded.payloadText === 'string' ? loaded.payloadText : '')
    } else {
      flushSpan()
      const text = typeof loaded.payloadText === 'string' ? loaded.payloadText : ''
      results.push({
        id: recordId,
        requestedId: target,
        resolvedVia: item.resolvedVia,
        ok: true,
        kind: loaded.entry?.kind ?? null,
        fidelity: loaded.entry?.fidelity ?? null,
        integrity: loaded.integrity ?? 'ok',
        bytes: Buffer.byteLength(text, 'utf8'),
        text: text || '（该记录无载荷：结构化索引记录）',
      })
    }
  }
  flushSpan()
  return results
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
    // 层级压缩模型模式的全局默认（设置页）。缺省 false：旧账本无该字段时
    // 播种为关；只在值缺失时补，绝不覆盖用户在本会话写下的选择。
    defaultCompressModel = () => false,
    // 模型相位解析点（P4）：(sessionId, { signal }) => { stream, model, timeoutMs,
    // cacheLookup, cacheSave, onUsage } | null。宿主无已核验 LLM 契约时注入方
    // 直接返回 null，全链路按程序档工作；不在此直连宿主内部。
    modelPhaseResolver = null,
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
        // BUG-001：标签由候选携带（与归档行同一份），恢复侧按它逐字节重建。
        label: candidate.spanLabel ?? (candidate.pluginAuthored ? '插件工作资料' : spanLabelOf(candidate.spanKind)),
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
      // S3 三态分离：prepared 未确认载荷（preparedId → 载荷）。只在内存：
      // 宿主确认（confirmInjection）即消费删除；进程重启丢的只是未确认的
      // prepare，下一张卡按「无上卡」语义回落全量（诚实降级）。
      pendingInjections: new Map(),
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

  /**
   * 崩溃窗口对账：账本已提交、表面撤回/行状态未收口的残差，在下次 adopt 时收敛。
   *
   * 判定完全确定性：受影响回执组的期望墓碑文本逐字节重建后与当前比对——
   * 只有「当前就是原回执」才替换（已撤过、或用户已手工改写过的都不动，如实计数）。
   * 行状态只补标缺失的 forgotten 标记，不重放任何工具副作用。失败时下一次
   * adopt 仍会重试（缓存只在成功后写入）。
   */
  const reconciledAt = new Map()

  async function reconcileForgetState(record) {
    if (!record?.directory) return null
    let forgetIndex
    try {
      forgetIndex = await getForgetIndex(record.directory)
    } catch {
      return null // 账本不可读：读面自带告警，这里不再放大。
    }
    const revision = forgetIndex?.revision ?? 0
    if (reconciledAt.get(record.sessionId) === revision) return null
    const targetIds = [...(forgetIndex?.forgotten?.keys() ?? [])]
    if (targetIds.length === 0) {
      reconciledAt.set(record.sessionId, revision)
      return null
    }
    const plan = await planWithdrawals(
      record,
      forgetNodeBasesOf(await collectForgetEntries(record), targetIds),
      targetIds,
    )
    const outcome = await withdrawForgottenSurfaces(
      record,
      { entry: { operationId: null }, targetIds },
      plan,
    )
    reconciledAt.set(record.sessionId, revision)
    if (outcome.withdrawn > 0 || outcome.reconciledRows > 0) {
      logger?.info?.(`memory-lab2: 遗忘对账收敛（撤回 ${outcome.withdrawn}，补标 ${outcome.reconciledRows}）`)
    }
    return outcome
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
    // P2：账本已提交但表面未收口的崩溃窗口，在此收敛（失败不阻塞命令主路径）。
    reconcileForgetState(record).catch(() => {})
    // P3：凭证计划已保存但替换未落表面的崩溃窗口，同路收敛（不阻塞 adopt）。
    reconcileVouchers(await compressDepsOf(record)).catch(() => {})
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
    // 1a) 检索后端显式指定预检（PR #4 端口二）：强制 lingshu 时，dsh-memory
    //     不在场或后端模块加载失败 → 拒绝启用（EBACKENDUNAVAILABLE），不静默降级。
    //     auto / local-lexical-v1 模式不预检（auto 降级是既有语义，不是错误）。
    if (typeof backendPrecheck === 'function') {
      const precheck = await backendPrecheck()
      if (precheck?.ok === false) {
        await rollbackV2Activation(sessionId, precheck.reason ?? '检索后端预检失败，回滚启用')
        throw new EngineV2Error(precheck.message ?? `检索后端不可用：${precheck.reason ?? '未知原因'}`, { code: precheck.code ?? 'EBACKENDUNAVAILABLE' })
      }
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
    // 模型模式默认值播种：口径同上（只在缺失时补）。
    if (record.state.compressModel === undefined) {
      record.state.compressModel = defaultCompressModel() === true
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
    let windowGuardRefusal = null

    if (record) {
      // 0) 窗口守卫（rc.5，与 v1 normalizeAndStop 同口径）：恢复会让组装输入
      // 超出模型窗口时跳过恢复、照常停用，原文留在冷库并如实给出路。
      // 「无测量不设闸」——测量不可用时照常恢复（与 v1 一致），不静默扣留。
      // P0-2：restore-skipped 的行同样「原文只在冷库」，停用前同样要走窗口守卫，
      // 否则跳过行在恢复时突然全部回来会击穿模型窗口。
      const pendingCount = engine.pendingReceipts(record).length + engine.restoreSkippedReceipts(record).length
      if (pendingCount > 0 && engine.settingsOf(record).autoRestore) {
        try {
          const occupancy = await engine.measureOccupancy(record, undefined)
          const growth = restoreGrowth([...engine.pendingReceipts(record), ...engine.restoreSkippedReceipts(record)], {
            assembledTokens: occupancy.host.assembledTokens,
            contextWindow: occupancy.host.contextWindow,
          })
          if (growth.overflow) {
            windowGuardRefusal = {
              total: growth.total,
              heldByReceipts: growth.heldByReceipts,
              assembled: occupancy.host.assembledTokens,
              window: occupancy.host.contextWindow,
            }
          }
        } catch (error) {
          logger?.warn?.(`memory-context-lab2: restore guard unavailable: ${error instanceof Error ? error.message : String(error)}`)
        }
      }

      // 1) 先恢复所有已替换区间：投影回到原文，再停用。
      if (!windowGuardRefusal) {
        try {
          const outcome = await engine.runRestore(record)
          restored = outcome?.restored ?? 0
          before = outcome?.before ?? 0
          // P0-2：停用回执必须如实报告仍未恢复的行——它们的原文只在冷库，
          // 停用后冷库按只读保留，旧记录 ID 仍可回读，但不能宣称「全部恢复」。
          const stillSkipped = outcome?.stillSkipped ?? 0
          if (stillSkipped > 0) {
            lines.push(`仍有 ${stillSkipped} 段原文未恢复（restore 跳过，原因见上）：它们的正文仍在冷库里，历史与载荷按只读保留，旧记录 ID 仍可回读。`)
          }
          // P2：软遗忘的行不会随 off 恢复（可见性由 disposition 账本持有，
          // 与引擎开关解耦）；停用回执必须如实披露这段「不在恢复范围内」。
          const forgottenCount = outcome?.forgotten ?? 0
          if (forgottenCount > 0) {
            lines.push(`另有 ${forgottenCount} 段已软遗忘未恢复：off 只停用引擎，不改变遗忘状态；如需恢复可见性，先重新启用后用 /memory-lab2 forget undo <操作ID>。`)
          }
        } catch (error) {
          // 恢复失败不静默：仍继续停用，但把失败写进回执文本，且不宣称已恢复。
          lines.push(`恢复未完成：${error instanceof Error ? error.message : String(error)}`)
        }
      } else {
        const growth = windowGuardRefusal.total - (windowGuardRefusal.heldByReceipts ?? 0)
        lines.push(
          `停用了降温，但恢复会让组装输入超出模型窗口（当前约 ${windowGuardRefusal.assembled} + 待恢复约 ${growth} > 窗口 ${windowGuardRefusal.window}），`,
          '因此**没有**恢复，原文仍在冷库里。要取回原文，请先缩小上下文，或直接丢弃冷库：',
          '  /memory-lab2 clean confirm delete-session',
        )
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
      windowGuardRefusal
        ? `已停用 v2 引擎，未恢复原文（窗口守卫拒绝，见下）。历史与载荷按只读保留，旧记录 ID 仍可回读。`
        : `已停用 v2 引擎。恢复 ${restored}/${before} 段原文；`
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
    // 验证跟踪：回读前查人工失效标记（只读旁证，零 hash；内容级失效走 verify）。
    const staleMarks = record
      ? await annotateStale({ sessionDir: record.directory, recordIds: ids }).catch(() => new Map())
      : new Map()
    // 证据重读计数：冷记录被再次读取是要计入成本账本的（T-12）。
    let reRead = 0
    let reReadBytes = 0
    for (const id of ids) {
      try {
        // 停用后仍可读：优先用活动记录，否则只读打开隔离根；旧父 ID 走 fork 兜底。
        // 0.10.1 S2a：非记录 ID 形态（nodeId 基名/分块名、callId）先走别名解析——
        // 回执正文只印 mcl2-… nodeId，模型按它回读此前必然全部落 warnings。
        let loaded = null
        if (parseRecordId(id)) {
          loaded = await withReadableStore(sessionId, (store) => readWithForkFallback(store, sessionId, id))
        } else {
          const aliasResults = await withReadableStore(sessionId, (store) => readByAlias(store, labRoot, sessionId, id))
          if (aliasResults && aliasResults.length > 0) {
            results.push(...aliasResults.map((row) => ({ ...row, staleReason: staleMarks.get(row.id) ?? null })))
            reRead += aliasResults.filter((row) => row.ok).length
            reReadBytes += aliasResults.reduce((sum, row) => sum + (row.bytes ?? 0), 0)
          } else {
            results.push({ id, ok: false, error: 'ENOSTORE：本会话没有 v2 库（从未启用）。' })
          }
          continue
        }
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
          staleReason: staleMarks.get(id) ?? null,
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
      const hidden = page.forgottenCount ?? 0
      return {
        kind: 'success',
        text: hidden > 0
          ? '（没有更多记录；另有 ' + hidden + ' 条已软遗忘记录被隐藏，用 forget undo 恢复可见性）'
          : '（没有更多记录）',
      }
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
        // 验证跟踪：人工失效标记（只读旁证，零 hash，查询失败静默不注记——
        // 失效注记是加强信息，不能反过来把正常回读打挂）。
        const staleMarks = await annotateStale({
          sessionDir: records.get(sessionId)?.directory,
          recordIds: ids,
        }).catch(() => new Map())
        let used = 0
        let stoppedAt = null
        // 别名展开在预算中途失败时必须回到「这个 id 尚未处理」的起点：
        // 否则 already 返回的成员会随 ids.slice(stoppedAt) 被再读一遍，
        // 而更早未装下的 id 会被后续 id 的 stoppedAt 覆盖、永久漏读（BUG-015）。
        idsLoop: for (let index = 0; index < ids.length; index += 1) {
          const id = ids[index]
          const remaining = budget - used
          if (remaining <= 0) {
            stoppedAt = index
            warnings.push(`预算 ${budget} token 已用尽，${id} 及之后未读取；用更大 budget_tokens 或按 next_cursor 续读`)
            break
          }
          // 0.10.1 S2a：非记录 ID 形态（nodeId 基名/分块名、callId）走别名解析——
          // 回执只印 mcl2-… nodeId，模型按它回读此前必然全部落 warnings（空成功）。
          if (!parseRecordId(id)) {
            let aliasRows = null
            try {
              aliasRows = await readByAlias(store, labRoot, sessionId, id, {
                maxBytes: remaining * BYTES_PER_TOKEN,
              })
            } catch (error) {
              entries.push({
                id,
                resolvedId: null,
                resolvedVia: null,
                kind: null,
                fidelity: null,
                integrity: 'error',
                tokens: 0,
                truncated: false,
                fullBytes: null,
                text: null,
                error: `${error?.code ?? 'E'}：${error instanceof Error ? error.message : String(error)}`,
              })
              continue
            }
            const entryStart = entries.length
            const usedBeforeAlias = used
            for (const row of aliasRows ?? []) {
              if (!row.ok) {
                entries.push({
                  id: row.id,
                  resolvedId: null,
                  resolvedVia: null,
                  kind: null,
                  fidelity: null,
                  integrity: 'error',
                  tokens: 0,
                  truncated: false,
                  fullBytes: null,
                  text: null,
                  error: row.error,
                })
                used += 1
                continue
              }
              const rowTokens = estimateTokensOf(row.text)
              // remaining 已是 budget - used；再减一次 used 会把装得下的正文误报成
              // 「预算不足」（BUG-015 的双扣）。预算不足时回滚本别名已展开的部分，
              // 让游标精确指向「未处理」的 id 前缀（不漏读，也不重复读）。
              if (rowTokens > budget - used) {
                entries.length = entryStart
                used = usedBeforeAlias
                stoppedAt = index
                warnings.push(
                  `预算 ${budget} token 不足，${id}（别名展开 ≈${rowTokens} token）及之后未附正文；`
                  + '用更大 budget_tokens、按 next_cursor 续读，或单独回读该 ID',
                )
                break idsLoop
              }
              used += rowTokens
              entries.push({
                id: row.id,
                resolvedId: row.id,
                resolvedVia: row.resolvedVia,
                requestedId: row.requestedId ?? id,
                kind: row.kind,
                fidelity: row.fidelity,
                integrity: row.integrity,
                tokens: rowTokens,
                truncated: false,
                fullBytes: row.bytes ?? null,
                text: row.text,
              })
            }
            continue
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
          const staleMark = staleMarks.get(loaded.resolvedId ?? id)
          const stalePrefix = staleMark
            ? `⚠ 该记录已被人工标记为失效（${staleMark.reason}）；引用前请先 /memory-lab2 verify。\n`
            : ''
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
            text: stalePrefix + (text || '（该记录无载荷：结构化索引记录）'),
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
        // P1-1 查询规划：ID/路径/调用标识与引号短语走精确通道，自然语言部分
        // 留给 OR 召回 + 相关门槛；与自动回注同一条规划逻辑，避免两端口径漂移。
        const plan = planQuery(literal)
        const needle = plan.text.toLowerCase()
        // 多路检索：内置字面索引为主，语义后端（灵枢）作为可注入的附加路。
        // 命中只带来源，不带分数；后端失败如实降级并带出原因。
        // 后端按会话取用：只有该会话的隔离灵枢已经启动时才拿到它，
        // 否则这里是 null，检索如实走字面匹配（不会隐式起子进程）。
        const found = await searchRecords({
          store,
          backend: backendForSession(sessionId),
          text: needle,
          exact: plan.exact.map((token) => token.toLowerCase()),
          limit: RECALL_MAX_QUERY_HITS,
          literalMatcher: entryMatchesLiteral,
          // P2 软遗忘：查询路径的权威过滤在复验处（searchRecords 内部按账本
          // 剔除 forgotten 命中并计数）；T2 服务端残留如实披露，不假装已清除。
          forgetIndex: await getForgetIndex(v2SessionDirectoryFor(labRoot, sessionId)),
        })
        const warnings = [...budgetNotes]
        if (found.truncated) {
          warnings.push(`命中 ${found.totalMatched} 条，只返回前 ${found.records.length} 条；用 record_ids 精确回读全文`)
        }
        // P2：遗忘剔除如实披露——命中为 0 且全是遗忘记录时，明确「不是库里没有」。
        if (found.forgottenFiltered > 0) {
          const zeroNote = found.totalMatched === 0 ? '（本次候选全部为遗忘记录，非库中无历史）' : ''
          warnings.push(`已软遗忘记录 ${found.forgottenFiltered} 条被剔除、不参与命中${zeroNote}；恢复可见性用 /memory-lab2 forget undo`)
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

      const card = cardFromStore(store, sessionId, Math.min(budget, WORKING_SET_DEFAULTS.cardTokens), session,
        await getForgetIndex(v2SessionDirectoryFor(labRoot, sessionId)))
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
   * S1 助手结论盘点数据源：从活动面 assistant 消息正文即时提取 claim。
   *
   * extractClaims 是确定性纯函数（claims.mjs），不依赖冷库/hierarchy——
   * 「只读盘点单元兜底」语义：任何路径的工作卡都能看到最近助手结论。
   * recordRef 优先用 recordIdsForSeq 给的稳定记录 ID（可回读）；无映射时按
   * host-seq 标注（卡片读者据此知道这不是记录 ID）。遗忘记录的 claim 不进卡
   * （印出去等于绕过遗忘，与 idsBySeq 过滤同口径）。
   */
  function surfaceClaimsOf(session, recordIdsForSeq, forgetIndex) {
    const nodes = Array.isArray(session?.surface?.nodes) ? session.surface.nodes : []
    const claims = []
    for (const seq of nodes) {
      const event = typeof session?.eventAt === 'function' ? session.eventAt(seq) : null
      if (event?.type !== 'assistant/message') continue
      const content = event?.data?.message?.content
      if (!Array.isArray(content)) continue
      const text = content
        .filter((block) => block?.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n')
      if (text === '') continue
      let recordRef = null
      if (typeof recordIdsForSeq === 'function') {
        try { {
          const ids = recordIdsForSeq(seq)
          if (Array.isArray(ids) && ids.length > 0) recordRef = ids[0]
        } } catch { recordRef = null }
      }
      if (recordRef === null) recordRef = 'host-seq:' + seq
      for (const claim of extractClaims(text)) {
        if (recordRef.startsWith('t') && forgetIndex && isForgotten(forgetIndex, recordRef)) continue
        claims.push({ ...claim, recordRef })
      }
    }
    return claims
  }

  /**
   * 从既有句柄直接渲染工作状态卡（只读召回路径用）。
   *
   * 与 `buildCard` 的区别：不需要活动记录，因而也不需要占用率与成本账本——
   * 只读召回不该有副作用，这里一个计数器都不动。
   */
  function cardFromStore(store, sessionId, budgetTokens, session, forgetIndex = null) {
    // 配对账本取一次（Map 复制），卡片构建期按 callId 闭包查询：并行调用共享
    // 宿主 seq，seq 侧倒排无法与调用序列对位（错位句柄会误导模型回读别人正文）。
    const pairing = store.pairingLedger()
    // P2 软遗忘：卡片是读面之一，被遗忘记录的 ID 不再印进热上下文——模型拿
    // 到句柄就会去回读，印出去等于绕过遗忘。过滤在 idsBySeq 之后、状态构建
    // 之前，配对账本同理会剔除遗忘的调用/结果记录。
    const visibleIds = (ids) => (forgetIndex ? ids.filter((id) => !isForgotten(forgetIndex, id)) : ids)
    const state = buildWorkingState({
      sessionId,
      surfaceNodes: session?.surface?.nodes ?? [],
      eventAt: (seq) => (typeof session?.eventAt === 'function' ? session.eventAt(seq) : null),
      openCalls: store.openCalls(),
      lastAssistantSeq: lastAssistantSeqOf(session),
      // S1：面上的助手结论即时提取（只读盘点兜底，与 idsBySeq 同遗忘口径）。
      claims: surfaceClaimsOf(session, (seq) => visibleIds(store.idsBySeq(seq)), forgetIndex),
      // 冷库里已经归档的宿主 seq → 稳定记录 ID：卡片要印出**工具真能回读**的 ID，
      // 而不是 `seq:N`（工具只认 t00000001-r0000 这种稳定 ID，印 seq 等于印废号）。
      recordIdsForSeq: (seq) => visibleIds(store.idsBySeq(seq)),
      // callId → 调用/结果记录 ID 的精确对位：共享同一 seq 的并行调用各拿各的记录。
      recordIdsForCallId: (callId) => {
        const entry = pairing.get(callId)
        if (!entry) return null
        const callRecordId = entry.callRecordId ?? null
        const resultRecordId = entry.resultRecordId ?? null
        if (forgetIndex) {
          if (callRecordId && isForgotten(forgetIndex, callRecordId)) return null
          if (resultRecordId && isForgotten(forgetIndex, resultRecordId)) return null
        }
        return { callRecordId, resultRecordId }
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
    // P2 软遗忘：卡片构建前先取一次账本快照（进程缓存），同 `cardFromStore`。
    const forgetIndex = await getForgetIndex(v2SessionDirectoryFor(labRoot, record.sessionId))
    // 与 `cardFromStore` 同源：卡片里出现的宿主 seq 必须换成**工具真能回读**的稳定
    // 记录 ID。这里曾经漏传 `recordIdsForSeq`，于是注入路径的卡片只印 `seq:609`
    // 并自报 `readable:false`——模型照着抄，工具一律不认（审计 P2-5）。
    const state = await factoryFor(record).withStore((store) => {
      // 同 `cardFromStore`：配对账本一次取齐，按 callId 精确对位（并行调用共享 seq）。
      const pairing = store.pairingLedger()
      const visibleIds = (ids) => (forgetIndex ? ids.filter((id) => !isForgotten(forgetIndex, id)) : ids)
      return buildWorkingState({
        sessionId: record.sessionId,
        surfaceNodes: session?.surface?.nodes ?? [],
        eventAt: (seq) => (typeof session?.eventAt === 'function' ? session.eventAt(seq) : null),
        openCalls: store.openCalls(),
        lastAssistantSeq: lastAssistantSeqOf(session),
        // S1：面上的助手结论即时提取（只读盘点兜底，与 idsBySeq 同遗忘口径）。
        claims: surfaceClaimsOf(session, (seq) => visibleIds(store.idsBySeq(seq)), forgetIndex),
        recordIdsForSeq: (seq) => visibleIds(store.idsBySeq(seq)),
        recordIdsForCallId: (callId) => {
          const entry = pairing.get(callId)
          if (!entry) return null
          const callRecordId = entry.callRecordId ?? null
          const resultRecordId = entry.resultRecordId ?? null
          if (forgetIndex) {
            if (callRecordId && isForgotten(forgetIndex, callRecordId)) return null
            if (resultRecordId && isForgotten(forgetIndex, resultRecordId)) return null
          }
          return { callRecordId, resultRecordId }
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
    const synced = await factoryFor(record).withStore(async (store) => syncRetrievalIndex({
      directory: record.directory,
      backend,
      store,
      // P2：同步侧把软遗忘记录当 pluginAuthored 同款差集——已索引的遗忘记录
      // 不再留在索引记账里，T1 文档同时确定性清除；旧索引读到未知代际照常握手。
      forgetIndex: await getForgetIndex(record.directory),
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

  /** `/memory-lab2 verify <记录ID...>`：验证跟踪（只读）。先补采缺失指纹再裁决。 */
  async function verifyCommand(invocation, ids) {
    const sessionId = sessionIdOf(invocation.agent.session)
    if (ids.length === 0) return { kind: 'error', text: '用法：`/memory-lab2 verify <记录ID...>`。' }
    const record = records.get(sessionId)
    if (!record) return { kind: 'error', text: 'v2 引擎在本会话未启用。' }
    // 先补采：升级前落库的旧记录没有旁证条目，直接 check 会全部 unverified。
    // 差集式采集只补缺口，已采过的绝不重采（重采会把事后改动洗成 valid）。
    await factoryFor(record).withStore((store) => syncVerification({
      store,
      sessionDir: record.directory,
      warn: (message) => logger?.warn?.(message),
    }))
    const checked = await checkRecords({
      sessionDir: record.directory,
      recordIds: ids,
      warn: (message) => logger?.warn?.(message),
    })
    const VERDICT_TEXT = {
      valid: '一致（valid）',
      stale: '已失效（stale）',
      unverified: '未验证（unverified）',
    }
    const lines = ids.map((id, index) => {
      const verdict = checked.results[index]
      if (!verdict || verdict.recordId !== id) return `- ${id}：内部结果错位，请重试。`
      const base = `- ${id}：${VERDICT_TEXT[verdict.verdict] ?? verdict.verdict}`
      if (verdict.verdict === 'valid') return `${base}，核对 ${verdict.matchedFiles} 个文件`
      return `${base}——${verdict.reason ?? '无说明'}`
    })
    return { kind: 'success', text: ['验证跟踪（比对「现在」与「归档时」的文件指纹；不追溯工具读取瞬间）：', ...lines].join('\n') }
  }

  /** `/memory-lab2 mark-stale <记录ID> <原因>`：人工失效标记（只写旁证）。 */
  async function markStaleCommand(invocation, args) {
    const sessionId = sessionIdOf(invocation.agent.session)
    const recordId = args[0]
    const reason = args.slice(1).join(' ').trim()
    if (!recordId || !reason) {
      return { kind: 'error', text: '用法：`/memory-lab2 mark-stale <记录ID> <原因（必填，会入旁证留痕）>`。' }
    }
    const record = records.get(sessionId)
    if (!record) return { kind: 'error', text: 'v2 引擎在本会话未启用。' }
    try {
      const marked = await markRecordsStale({
        sessionDir: record.directory,
        recordIds: [recordId],
        reason,
      })
      return {
        kind: 'success',
        text: [
          `已把 ${recordId} 标记为失效（仅写旁证 verification.json，不改不可变记录本体）。`,
          `原因：${reason}`,
          `标记时间：${marked.markedAt}`,
          '此后 read/recall 与 memory_lab_recall 回读该记录时会带失效注记。',
        ].join('\n'),
      }
    } catch (error) {
      return { kind: 'error', text: `标记失败：${error?.message ?? error}` }
    }
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

  /**
   * S3 锚点反查：活动面上最近一张 source.form='working-set' 的节点 seq。
   *
   * 双形态取 source（append 事件顶层 / 消息体 data.source，与 foldWorkingCards
   * 的取法一致）。没有已注入卡在面上时返回 null。
   */
  function findLastInjectedCardSeq(session) {
    const nodes = Array.isArray(session?.surface?.nodes) ? session.surface.nodes : []
    for (let index = nodes.length - 1; index >= 0; index -= 1) {
      const event = typeof session?.eventAt === 'function' ? session.eventAt(nodes[index]) : null
      if (event?.type !== 'user/message') continue
      const form = event?.source?.form ?? event?.data?.source?.form
      if (form === 'working-set') return nodes[index]
    }
    return null
  }

  async function workingSetInjection(agent) {
    const record = await adopt(agent)
    if (!record) return null
    if (record.state.settings?.workingSet === false) return null
    // P0-2：跳过行未恢复时，保护卡与软保留仍以冷库依赖为事实来源继续注入。
    if (engine.pendingReceipts(record).length === 0 && engine.restoreSkippedReceipts(record).length === 0) return null
    const { card } = await buildCard(record)
    if (!card.text) return null

    // S3 三态分离（prepare→宿主确认→commit）：本函数只 **prepare**。
    //
    // 方案 §6「缺失的提交确认」：注入决策发生在 agent/pre-step，宿主真正把
    // 消息追加进会话是之后的事——「确定要注入」不等于「已经持久化/发送」。
    // 修复前 workingSetCard 状态与成本计数在这里（确认前）就推进，宿主拒绝
    // 或中断时状态已经脏了：下一张增量卡会引用一张模型从未见过的全量卡。
    //
    // 现在：裁决照旧（去重/形态），但状态推进与计费全部移入 confirmInjection；
    // prepared 载荷挂在 record.pendingInjections（preparedId 一次性令牌），
    // index.mjs 在宿主实际追加后回调用 confirmInjection 才生效。未确认的
    // prepared 只记 workingStatePrepared 计数，天然可对账（报表三态行）。
    const cardState = record.workingSetCard ?? { text: null, injections: 0, keys: [], anchorSeq: null }
    // S3 锚点刷新（G1-S3 第 3 条）：从活动面反查最近一张已注入工作卡的 seq。
    // 确认注入时消息尚未落面（decision 消费后才 append），所以锚点在**下一次
    // prepare** 时刷新——它回答的是「上一张卡现在还在不在模型可见的面上」。
    // 宿主压缩把锚点移出面 → 如实归 null，下一张卡按「无上卡」语义回落全量，
    // 绝不注入引用了模型从未见过的全量卡的增量卡（诚实降级）。
    const surfaceSeqs = Array.isArray(record.agent?.session?.surface?.nodes) ? record.agent.session.surface.nodes : []
    const lastCardSeq = findLastInjectedCardSeq(record.agent?.session)
    if (lastCardSeq !== null) {
      cardState.anchorSeq = lastCardSeq
    } else if (cardState.anchorSeq !== null && !surfaceSeqs.includes(cardState.anchorSeq)) {
      // 锚点已不在面上：丢锚点。text 是上一张的渲染文本，但模型上下文里
      // 已经没有它——把它当作「无上卡」传给形态裁决。
      cardState.anchorSeq = null
      cardState.text = null
    }
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

    // prepare 计数在此时此刻发生（这是「跑过 prepare」的如实记录）；
    // committed/sent 只能由 confirmInjection 推进。
    record.cost.bump('workingStatePrepared', 1)
    const preparedId = randomUUID()
    record.pendingInjections.set(preparedId, {
      kind: 'working-set',
      cardText: card.text,
      text,
      form,
      dedupKey,
      verdictKeys: verdict.keys,
      usedTokens: card.usedTokens,
      dropped: card.dropped,
      prefixHash: card.prefix?.hash ?? null,
      cardStateInjections: cardState.injections,
      at: Date.now(),
    })
    void persistCost(record)
    return {
      kind: 'prepared',
      preparedId,
      text,
      usedTokens: card.usedTokens,
      hostTokens: null,
      dropped: card.dropped,
      // 注入形态（full/delta）：调用方与报表据此区分全量与增量。
      form,
      dedupKey,
      // 调用方据此去重：前缀哈希不变 = 同一张卡，不需要再注入一次。
      prefixHash: card.prefix?.hash ?? null,
    }
  }

  /**
   * S3 宿主确认：把一次 prepared 注入真正提交。
   *
   * 只有两件事发生在这里：推进 workingSetCard 状态（下一张增量卡的正确基准）、
   * 计 committed/sent 账。幂等保护：同一 preparedId 只能确认一次，重复确认
   * 返回 false 不重复计数；未知/已失效的 preparedId 同样返回 false。
   *
   * 计费口径不变（D5）：sent 只认宿主 meter，不可用时记
   * workingStateTokensUnmetered 缺口，不折算混记。
   */
  function confirmInjection(sessionId, preparedId) {
    const record = records.get(sessionId)
    if (!record || typeof preparedId !== 'string') return false
    const prepared = record.pendingInjections.get(preparedId)
    if (!prepared || prepared.kind !== 'working-set') return false
    record.pendingInjections.delete(preparedId)

    // 状态推进 = 「这张卡已经交给宿主」：下一张增量卡的基准是它。
    record.workingSetCard = {
      text: prepared.cardText,
      injections: prepared.cardStateInjections + 1,
      keys: prepared.verdictKeys,
      // 锚点在下次 prepare 时从面反查刷新；确认时先继承旧值（或 null）。
      anchorSeq: record.workingSetCard?.anchorSeq ?? null,
    }
    record.cost.bump('workingStateInjections', 1)
    record.cost.bump(prepared.form === 'full' ? 'workingStateFullInjections' : 'workingStateDeltaInjections', 1)
    record.cost.bump('workingStateCommitted', 1)
    // D5：注入记账只认宿主 meter（与归档侧 originalTokens 同一把尺子）。
    const hostTokens = hostMeterTokensOf(prepared.text)
    if (hostTokens !== null) {
      record.cost.bump('workingStateTokens', hostTokens)
      record.cost.bump('workingStateSent', 1)
    } else {
      record.cost.bump('workingStateTokensUnmetered', 1)
    }
    // 计数必须落盘：这是每步都会走的常驻路径，只改内存的话重启就归零。
    void persistCost(record)
    return true
  }

  /**
   * S3 卡片组折叠：把活动面上连续的插件工作卡组合并成折叠回执（surface replace）。
   *
   * 身份判定与边界规则在 card-fold.mjs（纯函数）；这里只做接线：构造节点视图、
   * 逐计划提交 replace、如实返回计数。非卡消息绝不进入替换区间（红线），任何
   * append 异常都按失败关闭处理：记告警、返回已成功的部分，不让折叠失败阻塞归档。
   *
   * 折叠回执自身用独立 marker（[已折叠工作卡·v2]），不以 V2_RECEIPT_MARKER 开头，
   * 因此不会再次入组（无自激循环）；全历史模式的凭证收集器如需纳入可按前缀识别。
   */
  async function foldWorkingCards(agent) {
    const record = await adopt(agent)
    if (!record) return { folded: 0, receipts: [], failed: 0 }
    const session = record.agent?.session
    if (!session || typeof session.append !== 'function' || !Array.isArray(session.surface?.nodes)) {
      return { folded: 0, receipts: [], failed: 0 }
    }
    const nodes = session.surface.nodes.map((seq) => {
      const event = typeof session.eventAt === 'function' ? session.eventAt(seq) : null
      const content = event?.data?.content
      const first = Array.isArray(content) ? content.find((block) => block?.type === 'text') : null
      // sourceForm 双形态：append 事件顶层 opts.source 会被宿主存进 event.source；
      // 旧形状消息体的 source 在 data.source。两者都查，身份判定不依赖单一形状。
      return {
        seq,
        type: event?.type ?? null,
        sourceForm: event?.source?.form ?? event?.data?.source?.form ?? null,
        text: typeof first?.text === 'string' ? first.text : null,
      }
    })
    const { plans } = planCardFolds(nodes)
    const receipts = []
    let failed = 0
    for (const plan of plans) {
      try {
        const event = session.append('user/message', {
          id: `surface-${randomUUID()}`,
          role: 'user',
          content: [{ type: 'text', text: plan.text }],
        }, {
          surfaceOp: { op: 'replace', startSeq: plan.startSeq, endSeq: plan.endSeq },
          sourceEventSeqs: [...plan.memberSeqs],
          source: { kind: 'user', form: 'memory-lab2-surface' },
        })
        receipts.push({ seq: event?.seq, startSeq: plan.startSeq, endSeq: plan.endSeq, members: plan.memberSeqs.length })
      } catch (error) {
        failed += 1
        logger?.warn?.(`memory-lab2: 卡组折叠提交失败（seq ${plan.startSeq}–${plan.endSeq} 保持原样）：${error?.message ?? error}`)
      }
    }
    if (receipts.length > 0) {
      record.cost.bump('historyReplacements', receipts.length)
      void persistCost(record)
    }
    return { folded: receipts.length, receipts, failed }
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
      // rc.5：off 先恢复原文再翻开关位——已归档的操作不能以回执形态留在投影里
      // 却宣称「全历史已关」。恢复失败不阻断关闭（与 v2 off 同语义），如实逐条报告。
      // 窗口守卫与停用同口径：overflow 则跳过恢复但开关照翻，如实给出路。
      const restoreNotes = []
      let fullHistoryGuardRefusal = null
      if (rawValue === 'off' && record.state.fullHistory === true) {
        // P0-2：待恢复行与跳过行合并计数——两者恢复到活动面的增量同源，
        // 窗口守卫只看总量，不看上次尝试的成败。
        const restoreRows = [...engine.pendingReceipts(record), ...engine.restoreSkippedReceipts(record)]
        const pendingCount = restoreRows.length
        if (pendingCount > 0) {
          try {
            const occupancy = await engine.measureOccupancy(record, undefined)
            const growth = restoreGrowth(restoreRows, {
              assembledTokens: occupancy.host.assembledTokens,
              contextWindow: occupancy.host.contextWindow,
            })
            if (growth.overflow) {
              fullHistoryGuardRefusal = {
                total: growth.total,
                heldByReceipts: growth.heldByReceipts,
                assembled: occupancy.host.assembledTokens,
                window: occupancy.host.contextWindow,
              }
            }
          } catch (error) {
            logger?.warn?.(`memory-context-lab2: restore guard unavailable: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
        if (fullHistoryGuardRefusal) {
          const growth = fullHistoryGuardRefusal.total - (fullHistoryGuardRefusal.heldByReceipts ?? 0)
          restoreNotes.push(
            `已关闭全历史，但恢复会让组装输入超出模型窗口（当前约 ${fullHistoryGuardRefusal.assembled} + 待恢复约 ${growth} > 窗口 ${fullHistoryGuardRefusal.window}），`,
            '因此**没有**恢复，原文仍在冷库里。要取回原文，请先缩小上下文后再 /memory-lab2 restore，或直接丢弃冷库：',
            '  /memory-lab2 clean confirm delete-session',
          )
        } else {
          try {
            const outcome = await engine.runRestore(record)
            const restored = outcome?.restored ?? 0
            const before = outcome?.before ?? 0
            if (before > 0) restoreNotes.push(`已恢复 ${restored}/${before} 段原文。`)
            const stillSkipped = outcome?.stillSkipped ?? 0
            if (stillSkipped > 0) restoreNotes.push(`仍有 ${stillSkipped} 段原文未恢复（restore 跳过，原因见逐条结局）：它们的正文仍在冷库里，历史与载荷按只读保留，旧记录 ID 仍可回读。`)
          } catch (error) {
            restoreNotes.push(`恢复未完成：${error instanceof Error ? error.message : String(error)}；` +
              '可稍后用 /memory-lab2 restore 重试（历史按只读保留，旧记录 ID 仍可回读）。')
          }
        }
      }
      record.state.fullHistory = rawValue === 'on'
      if (record.state.fullHistory) {
        settings.retainOperations = normalizeSettings(settings).retainOperations
      }
      record.state.settings = normalizeSettings(settings)
      // 设置必须落盘：只改内存会让「设置成功」在重启后失效，而 v1 的 set 是持久的。
      await writeV2SessionState(record.directory, record.state)
      const lines = [`全历史记忆上下文已设为 ${rawValue === 'on' ? '开' : '关'}（写入 v2 账本）。`]
      lines.push(...restoreNotes)
      return { kind: 'success', text: lines.join('\n') }
    } else if (key === 'compress') {
      // 层级压缩开关（P3）：默认关；开启后自动降温收尾会尝试对连续已完成回执组
      // 做聚合凭证替换（preview 不受开关影响，任何时候都可只读预览）。
      if (rawValue !== 'on' && rawValue !== 'off') {
        return { kind: 'error', text: '用法：`/memory-lab2 set compress on|off`' }
      }
      record.state.hierarchyCompress = rawValue === 'on'
      await writeV2SessionState(record.directory, record.state)
      return { kind: 'success', text: `层级压缩已设为 ${rawValue === 'on' ? '开' : '关'}（默认关；可用 /memory-lab2 compress preview 先行预览）。` }
    } else if (key === 'compressmodel') {
      // 层级压缩模型模式开关（P4）：只在 compress 已开时有实效；模型不可用或
      // 产出不合格时自动落回程序摘要（失败关闭），这里只记偏好位。
      if (rawValue !== 'on' && rawValue !== 'off') {
        return { kind: 'error', text: '用法：`/memory-lab2 set compressmodel on|off`' }
      }
      record.state.compressModel = rawValue === 'on'
      await writeV2SessionState(record.directory, record.state)
      const note = record.state.compressModel
        ? '已设为开：聚合摘要将先经模型改写（注入的 stream 契约），失败或校验不过时自动落回程序摘要。'
        : '已设为关：聚合摘要直接用程序版本。'
      return { kind: 'success', text: `层级压缩模型模式已设为 ${rawValue === 'on' ? '开' : '关'}。${note}` }
    } else if (key === 'planfirst') {
      // 插件级开关（与 /memory-lab set planfirst 同义）：v2 账本只记位置，
      // 联动动作由注入的回调执行（服务缺失时回调返回提示，不阻断）。
      if (rawValue !== 'on' && rawValue !== 'off') {
        return { kind: 'error', text: '用法：`/memory-lab2 set planfirst on|off`' }
      }
      record.state.planFirst = rawValue === 'on'
      // 回调可能返回 Promise 或普通对象（v1 的 enter/exitIfFresh 是 async，但不在
      // 手里兜底），统一经 Promise.resolve 吞错——退出失败不阻断开关位落账。
      const note = onPlanFirstToggle
        ? (await Promise.resolve(onPlanFirstToggle(invocation.agent, rawValue === 'on')).catch(() => null))
        : null
      record.state.settings = normalizeSettings(settings)
      await writeV2SessionState(record.directory, record.state)
      const lines = [`新会话计划先行已设为 ${rawValue === 'on' ? '开' : '关'}（写入 v2 账本）。`]
      if (note) lines.push(note.text)
      return { kind: 'success', text: lines.join('\n') }
    } else {
return { kind: 'error', text: `未知设置项 ${key ?? ''}；支持 auto|recall|batch|retain|fullhistory|planfirst|compress|compressmodel。` }
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

  // ── P2 主动遗忘：命令面、表面撤回与重启对账 ──────────────────────────────
  //
  // 权威顺序（计划 §5 P2-5）：disposition 账本先提交，读面立即过滤；随后收口
  // 表面回执（换墓碑）、行状态（status='forgotten'，脱离 restore 待办与 off 清
  // 理判定）、T1 记忆索引文档、provenance 失效标记。收口步骤幂等可重放：任一
  // 步失败只挂进 forget status 的待收口清单并如实报告，绝不回滚账本。undo 只
  // 恢复可见性并按撤回快照重建可见回执；原文回注仍走显式 restore。

  const FORGET_TOMBSTONE_TAG = '本段已按用户指令软遗忘'

  async function collectForgetEntries(record) {
    return factoryFor(record).withStore((store) => {
      const entries = []
      let afterId = null
      for (;;) {
        const page = store.listEntries({ afterId, limit: 500 })
        if (page.entries.length === 0) break
        entries.push(...page.entries)
        if (!page.nextAfter) break
        afterId = page.nextAfter
      }
      return entries
    })
  }

  function forgetNodeBasesOf(entries, recordIds) {
    const wanted = new Set(recordIds)
    const bases = new Set()
    for (const entry of entries) {
      if (!wanted.has(entry.id)) continue
      const nodeId = entry.inline?.nodeId
      if (typeof nodeId === 'string' && nodeId) bases.add(nodeUnitBase(nodeId))
    }
    return bases
  }

  function isTombstoneText(text) {
    return typeof text === 'string' && text.includes(FORGET_TOMBSTONE_TAG)
  }

  function appendSurfaceText(session, seq, text) {
    return session.append(
      'user/message',
      {
        id: `surface-${randomUUID()}`,
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'user', form: 'memory-lab2-surface' },
      },
      { surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq] },
    )
  }

  /**
   * 计算一次遗忘的表面撤回计划：行按 replacementSeq 分组（P1-5 批组共享同一
   * 表面节点），组内任一行被遗忘则整组换墓碑；换墓碑前把当前表面文本快照进
   * 账本的 withdrawals，undo 据此逐字节恢复。已经是墓碑或原文已变的节点不重
   * 复快照，如实计入 pendingWithdrawals 交由对账重放。
   */
  async function planWithdrawals(record, forgetNodeIds, targetIds) {
    const session = record.agent?.session
    const rows = Array.isArray(record.state?.archive) ? record.state.archive : []
    const bySeq = new Map()
    for (const row of rows) {
      if (!row?.replacementSeq || !row?.nodeId) continue
      const list = bySeq.get(row.replacementSeq) ?? []
      list.push(row)
      bySeq.set(row.replacementSeq, list)
    }
    const withdrawals = []
    const pendingWithdrawals = []
    const touchedRows = []
    for (const [seq, group] of bySeq) {
      const affected = group.filter((row) => forgetNodeIds.has(nodeUnitBase(row.nodeId)))
      if (affected.length === 0) continue
      touchedRows.push(...affected)
      const current = receiptTextOf(typeof session?.eventAt === 'function' ? session.eventAt(seq) : null)
      if (current === null || isTombstoneText(current)) {
        // 表面已经是墓碑（先前撤回过）或文本已不存在：不重复快照。
        if (current === null) pendingWithdrawals.push({ nodeIds: [...new Set(group.map((row) => row.nodeId))], replacementSeq: seq, reason: 'surface-missing' })
        continue
      }
      withdrawals.push({
        nodeIds: [...new Set(group.map((row) => row.nodeId))].sort(),
        recordIds: targetIds.slice().sort(),
        replacementSeq: seq,
        receiptText: current,
      })
    }
    return { withdrawals, pendingWithdrawals, touchedRows }
  }

  async function withdrawForgottenSurfaces(record, result, precomputed = null) {
    const session = record.agent?.session
    const plan = precomputed
      ?? await planWithdrawals(record, forgetNodeBasesOf(await collectForgetEntries(record), result.targetIds ?? []), result.targetIds ?? [])
    const failures = []
    for (const withdrawal of plan.withdrawals) {
      try {
        appendSurfaceText(session, withdrawal.replacementSeq, buildForgetTombstone({
          range: { start: withdrawal.replacementSeq, end: withdrawal.replacementSeq },
          nodeId: withdrawal.nodeIds[0] ?? '(unknown)',
          hash: null,
          reason: result.entry?.reason ?? null,
        }))
      } catch (error) {
        failures.push({ replacementSeq: withdrawal.replacementSeq, message: error?.message ?? String(error) })
      }
    }
    for (const row of plan.touchedRows) {
      row.status = 'forgotten'
      row.forgottenBy = result.entry?.operationId ?? null
    }
    if (plan.touchedRows.length > 0) await writeV2SessionState(record.directory, record.state)
    return {
      failures,
      pendingWithdrawals: plan.pendingWithdrawals,
      withdrawn: plan.withdrawals.length,
      reconciledRows: plan.touchedRows.length,
    }
  }

  /**
   * undo 侧：账本已把可见性放回，这里按撤销条目携带的撤回快照恢复可见回执。
   * 快照缺失或表面已再次变化时不动表面、如实报告（账本仍是权威）。
   */
  async function restoreForgottenSurfaces(record, undoResult) {
    const session = record.agent?.session
    const rows = Array.isArray(record.state?.archive) ? record.state.archive : []
    const failures = []
    let restoredSurfaces = 0
    for (const withdrawal of undoResult.withdrawals ?? []) {
      try {
        const current = receiptTextOf(typeof session?.eventAt === 'function' ? session.eventAt(withdrawal.replacementSeq) : null)
        if (current === null) {
          failures.push({ replacementSeq: withdrawal.replacementSeq, message: 'surface-missing' })
          continue
        }
        if (!isTombstoneText(current)) continue
        appendSurfaceText(session, withdrawal.replacementSeq, withdrawal.receiptText)
        restoredSurfaces += 1
      } catch (error) {
        failures.push({ replacementSeq: withdrawal.replacementSeq, message: error?.message ?? String(error) })
      }
    }
    // 行状态跟随账本（权威）：forgotten 行的 node 基名若已不再遗忘，放回 applied。
    const forgetIndex = await getForgetIndex(record.directory)
    let changed = false
    let bases = new Set()
    if (forgetIndex.forgotten && forgetIndex.forgotten.size > 0) {
      const entries = await collectForgetEntries(record)
      bases = forgetNodeBasesOf(entries, [...forgetIndex.forgotten.keys()])
    }
    for (const row of rows) {
      if (row?.status !== 'forgotten' || !row.nodeId) continue
      if (!bases.has(nodeUnitBase(row.nodeId))) {
        row.status = 'applied'
        row.forgottenBy = null
        changed = true
      }
    }
    if (changed) await writeV2SessionState(record.directory, record.state)
    return { failures, restoredSurfaces }
  }

  async function forgetCommand(invocation, args) {
    const subcommand = (args[0] ?? '').toLowerCase()
    const targets = args.slice(1)
    const sessionId = sessionIdOf(invocation.agent.session)
    const sessionDir = v2SessionDirectoryFor(labRoot, sessionId)
    if (!['preview', 'apply', 'undo', 'status'].includes(subcommand)) {
      return { kind: 'error', code: 'EFORGETUSAGE', message: '用法：/memory-lab2 forget preview|apply|undo|status <目标…>' }
    }
    if (subcommand === 'status') {
      try {
        const report = await describeForgetStatus(sessionDir)
        const lines = ['账本状态 ' + report.state + '（revision ' + report.revision + '，当前遗忘 ' + report.forgottenCount + ' 条）。']
        for (const op of report.operations.slice(-40).reverse()) {
          if (op.kind === 'undo') {
            lines.push(op.operationId + ' undo ' + op.undoOf + '（恢复 ' + op.restoredCount + '，保持 ' + op.keptCount + '）')
          } else {
            lines.push(op.operationId + ' forget ' + op.targetCount + ' 条（' + (op.reason || '无备注') + '）' + (op.undone ? ' — 已撤销' : ''))
          }
        }
        if (report.operations.length > 40) lines.push('（仅显示最近 40 条操作，共 ' + report.operations.length + ' 条）')
        if (report.repairedBytes > 0) lines.push('本次读取截断了 ' + report.repairedBytes + ' 字节的账本半行（崩溃残留，已修复）。')
        // 诚实边界（计划 §8）：T2 派生索引在服务端，插件没有探针过的删除原语；
        // 权威过滤在读面拦截，但残留计数要如实说，不假装已清除。
        const statusBackend = backendForSession(sessionId)
        if (statusBackend?.kind === 'lingshu' && report.forgottenCount > 0) {
          lines.push('隔离灵枢侧派生索引仍可能残留已遗忘内容的命中（读面已拦截，服务端未清除）。')
        }
        return { kind: 'success', text: lines.join('\n') }
      } catch (error) {
        if (error instanceof DispositionError) {
          return { kind: 'error', code: error.code, message: error.message }
        }
        throw error
      }
    }
    if (subcommand === 'preview') {
      if (targets.length === 0) {
        return { kind: 'error', code: 'EFORGETUSAGE', message: 'preview 需要至少一个目标：记录ID | nodeId | callId | kind=<片段> | before=<记录ID>' }
      }
      const record = await adopt(invocation.agent)
      // BUG-005：未启用会话 adopt() 返回 null。判空后给结构化错误信封，
      // 绝不能把 null 传进 collectForgetEntries（那里读 record.sessionId 会 TypeError）。
      if (!record) return { kind: 'error', code: 'ENOTENABLED', message: '本会话尚未启用记忆上下文（/memory-lab2 on）。' }
      const entries = await collectForgetEntries(record)
      const reader = async (id) => {
        const result = await factoryFor(record).withStore((store) => store.readRecord(id))
        return { ok: result.ok, text: result.ok ? result.payloadText ?? null : null }
      }
      const preview = await buildForgetPreview({ sessionDir, targets, entries, readRecord: reader })
      const lines = ['当前 revision ' + preview.revision + '。']
      for (const expansion of preview.expansions) {
        lines.push(expansion.from + ' → ' + expansion.to.length + ' 条记录（' + expansion.note + '）')
      }
      if (preview.unknown.length > 0) lines.push('未命中目标（不在本会话冷库）：' + preview.unknown.join('、'))
      if (preview.blocked.length > 0) {
        lines.push('硬保护拦截：' + preview.blocked.map((item) => item.id + '（' + item.rule + '）').join('、'))
      }
      if (preview.warnings.length > 0) {
        lines.push('警告（显式目标已放行）：' + preview.warnings.map((item) => item.id + '（' + item.detail + '）').join('、'))
      }
      if (preview.already.length > 0) lines.push('已遗忘（幂等跳过）：' + preview.already.map((item) => item.id).join('、'))
      lines.push('本次将遗忘 ' + preview.toForget.length + ' 条记录。')
      if (preview.plan) {
        await saveForgetPlan(sessionDir, preview.plan)
        lines.push('宽条件目标已生成计划 ' + preview.plan.planId + '（revision ' + preview.plan.revision + '）；apply 用：/memory-lab2 forget apply ' + preview.plan.planId)
      } else if (preview.wide) {
        lines.push('宽条件无可遗忘集合，未生成计划。')
      }
      if (preview.repairedBytes > 0) lines.push('账本读取截断 ' + preview.repairedBytes + ' 字节半行（崩溃残留，已修复）。')
      return { kind: 'success', text: lines.join('\n') }
    }
    if (subcommand === 'undo') {
      const operationId = targets[0]
      if (!operationId) {
        return { kind: 'error', code: 'EFORGETUSAGE', message: 'undo 需要操作ID，先用 /memory-lab2 forget status 查看' }
      }
      const record = await adopt(invocation.agent)
      // 账本权威：先提交 undo，再做表面回执重建（幂等、失败如实报告）。
      let result
      try {
        result = await applyUndo({ sessionDir, operationId })
      } catch (error) {
        if (error instanceof DispositionError) {
          return { kind: 'error', code: error.code, message: error.message }
        }
        throw error
      }
      // BUG-005：undo 的账本侧只依赖 sessionDir，record 仅在表面回执重建时用。
      // 未启用会话（record=null）仍可完成账本级 undo；此时没有活动面可重建，
      // 如实说明而不是 TypeError，也不是假成功。
      const surface = record ? await restoreForgottenSurfaces(record, result) : null
      const lines = [
        `已撤销遗忘操作 ${result.entry.operationId}（恢复可见 ${result.restoredIds.length} 条；其余 ${result.keptIds.length} 条保持遗忘——多原因命中，逐条列出剩余 cause）。`,
        surface
          ? `可见性已由账本放回；被撤销对象里的表面回执恢复 ${surface.restoredSurfaces} 个。`
          : '本会话的 v2 引擎未启用：只提交了账本级 undo，没有表面回执需要重建。',
      ]
      if (result.keptIds.length > 0) lines.push(`保持遗忘：${result.keptIds.join('、')}`)
      if (surface?.failures.length > 0) lines.push(`表面恢复失败（可重试）：${surface.failures.map((f) => `seq${f.replacementSeq}(${f.message})`).join('、')}`)
      lines.push('原文回注（把内容重新注入热上下文）仍需显式 /memory-lab2 restore。')
      return { kind: 'success', text: lines.join('\n') }
    }
    // apply
    if (targets.length === 0) {
      return { kind: 'error', code: 'EFORGETUSAGE', message: 'apply 需要 <计划ID>（宽条件）或显式记录ID列表' }
    }
    const record = await adopt(invocation.agent)
    // BUG-005：同 preview，未启用会话给结构化错误而不是 TypeError。
    if (!record) return { kind: 'error', code: 'ENOTENABLED', message: '本会话尚未启用记忆上下文（/memory-lab2 on）。' }
    const entries = await collectForgetEntries(record)
    let plan = null
    let targetIds = null
    let reason = null
    if (targets.length === 1 && /^[0-9a-f]{16}$/.test(targets[0])) {
      plan = await getForgetPlan(sessionDir, targets[0])
      if (!plan) {
        return { kind: 'error', code: 'EFORGETPLAN', message: `计划 ${targets[0]} 不存在或已被消费；请重新 /memory-lab2 forget preview` }
      }
      targetIds = plan.resolvedIds
      reason = `plan:${plan.planId}`
    } else {
      // 显式目标也先解析再提交：别名（nodeId/callId/导入指针）按单元闭包展开；
      // 宽条件（kind=/before=）拒绝直通——计划通道是宽条件的唯一提交路径；
      // 未知目标如实报错，不把字符串当记录 ID 写进账本。
      const resolved = await resolveForgetTargets({
        targets,
        entries,
        readRecord: (id) => factoryFor(record).withStore((store) => {
          try {
            return store.readRecord(id, { verifyHash: false, maxBytes: 64 * 1024 })
          } catch {
            return { ok: false }
          }
        }),
      })
      if (resolved.wide) {
        return { kind: 'error', code: 'EFORGETWIDE', message: '宽条件目标必须先 /memory-lab2 forget preview，再用计划 ID apply；apply 不接受宽条件直通' }
      }
      if (resolved.unknown.length > 0) {
        return { kind: 'error', code: 'EFORGETTARGET', message: '未知目标：' + resolved.unknown.join('、') }
      }
      if (resolved.recordIds.length === 0) {
        return { kind: 'error', code: 'EFORGETTARGET', message: '目标解析后为空集合' }
      }
      targetIds = resolved.recordIds
      reason = 'explicit'
    }
    // 先快照再提交：账本条目携带 undo 所需的回执原文（崩溃窗口内不丢快照）。
    const forgetNodeIds = forgetNodeBasesOf(entries, targetIds)
    const withdrawalPlan = await planWithdrawals(record, forgetNodeIds, targetIds)
    let result
    try {
      result = await applyForget({
        sessionDir,
        targetIds,
        actor: 'user',
        reason,
        expectedRevision: plan ? plan.revision : null,
        withdrawals: withdrawalPlan.withdrawals,
      })
    } catch (error) {
      if (error instanceof DispositionError) {
        return { kind: 'error', code: error.code, message: error.message }
      }
      throw error
    }
    if (!result.appended) {
      return { kind: 'success', text: '目标已全部处于遗忘状态（幂等，未追加条目）；当前 revision ' + result.revision + '。' }
    }
    const withdrawal = await withdrawForgottenSurfaces(record, result, withdrawalPlan)
    // provenance：先注册「表面回执 ← 遗忘记录」来源边，再标记失效（undo 后复验
    // 有结构可查）。注册/失效都失败不阻断遗忘本体——账本才是权威，status 披露。
    for (const withdrawalItem of withdrawalPlan.withdrawals) {
      try {
        await registerProvenanceEdge({
          sessionDir,
          derivedId: 'surface:' + withdrawalItem.replacementSeq,
          derivedKind: 'surface-receipt',
          sourceIds: withdrawalItem.recordIds,
        })
      } catch { /* 已注册或只读时跳过 */ }
      try {
        await invalidateProvenance({ sessionDir, derivedId: 'surface:' + withdrawalItem.replacementSeq, cause: result.entry.operationId })
      } catch { /* 失效标记失败不阻断遗忘 */ }
    }
    const lines = [
      '软遗忘已生效（操作 ' + result.entry.operationId + '）：新增 ' + result.entry.targetIds.length + ' 条，已遗忘 ' + result.alreadyForgotten.length + ' 条幂等跳过。',
      '表面回执撤回 ' + withdrawal.withdrawn + ' 个节点' + (withdrawal.failures.length ? '，失败 ' + withdrawal.failures.length + ' 个（forget status 待收口清单可重放）' : '') + '。',
    ]
    if (withdrawal.pendingWithdrawals.length > 0) {
      lines.push('表面缺失待对账 ' + withdrawal.pendingWithdrawals.length + ' 组（下次 adopt 时收敛）。')
    }
    lines.push('冷库原文与审计日志保留；撤销用 /memory-lab2 forget undo ' + result.entry.operationId + '。')
    return { kind: 'success', text: lines.join('\n') }
  }

  /**
   * P3 层级压缩命令面：/memory-lab2 compress preview|run|status。
   * 两段式与 forget 一致：preview 不改任何状态；run 按事务序提交并可重复收口。
   */
  async function compressCommand(invocation, args) {
    const subcommand = (args[0] ?? '').toLowerCase()
    const sessionId = sessionIdOf(invocation.agent.session)
    if (!COMPRESS_SUBCOMMANDS.includes(subcommand)) {
      return { kind: 'error', code: 'ECOMPRESSUSAGE', message: '用法：/memory-lab2 compress preview|run|status' }
    }
    if (subcommand === 'status') {
      try {
        const report = await compressStatus(await lightHierarchyDepsOf(invocation))
        return { kind: 'success', text: report.text }
      } catch (error) {
        return { kind: 'error', code: 'ECOMPRESSSTATE', message: describeHierarchyError(error) }
      }
    }
    const record = await adopt(invocation.agent)
    if (!record) return { kind: 'error', code: 'ENOTENABLED', message: '本会话尚未启用记忆上下文（/memory-lab2 on）。' }
    const deps = await compressDepsOf(record)
    try {
      const outcome = subcommand === 'preview' ? await compressPreview(deps) : await compressRun(deps)
      return { kind: 'success', text: outcome.text }
    } catch (error) {
      return { kind: 'error', code: 'ECOMPRESSRUN', message: describeHierarchyError(error) }
    }
  }

  /** P3 凭证展开：/memory-lab2 expand <凭证ID> [页码]（恒定只读面，分页回读原文）。 */
  async function expandCommand(invocation, args) {
    const voucherId = args[0]
    if (!voucherId) {
      return { kind: 'error', code: 'EEXPANDUSAGE', message: '用法：/memory-lab2 expand <凭证ID> [页码]（凭证ID 见 /memory-lab2 compress status）' }
    }
    try {
      const outcome = await expandVoucher(await lightHierarchyDepsOf(invocation), voucherId, args[1])
      return { kind: 'success', text: outcome.text }
    } catch (error) {
      return { kind: 'error', code: 'EEXPANDVOUCHER', message: describeHierarchyError(error) }
    }
  }

  /**
   * hierarchy-coordinator 依赖注入：表面与冷库都从已启用会话取（与 forget 相同的
   * adopt + factory 通道）。getRecordBody 走 withStore 事务读，isRecordVisible 用
   * 遗忘账本做同步过滤（展开页如实标注已遗忘成员）。
   */
  async function compressDepsOf(record) {
    const sessionId = record.sessionId
    const sessionDir = record.directory
    const session = record.agent?.session
    const forgetIndex = await getForgetIndex(record.directory).catch(() => null)
    const forgotten = forgetIndex?.forgotten instanceof Map ? forgetIndex.forgotten : new Map()
    const kindById = new Map()
    return {
      sessionDir,
      eventAt: (seq) => (typeof session?.eventAt === 'function' ? session.eventAt(seq) : null),
      surfaceNodes: () => (Array.isArray(session?.surface?.nodes) ? [...session.surface.nodes] : []),
      surfaceVoucherNodes: surfaceVoucherNodesOf(session),
      getRecordBody: async (recordId) => {
        const result = await factoryFor(record).withStore((store) => store.readRecord(recordId))
        if (!result?.ok) return null
        kindById.set(recordId, result.record?.kind ?? result.entry?.kind ?? null)
        return result.payloadText
      },
      getRecordKind: (recordId) => {
        // kind 只用于渲染标签；读不到就按 tool-output 呈现，不猜。
        return kindById.get(recordId) ?? 'tool-output'
      },
      isRecordVisible: (recordId) => !forgotten.has(recordId),
      // 模型相位（P4 依赖注入解析点）：所有宿主 LLM 契约风险收敛在
      // modelPhaseResolver 一个回调里。会话偏好未开或解析不出 stream 时返回
      // null → 协调器整体走程序档；解析失败同样按程序档处理（失败关闭）。
      modelPhase: await (async () => {
        if (record.state.compressModel !== true) return null
        try {
          const resolved = modelPhaseResolver
            ? await Promise.resolve(modelPhaseResolver(sessionId, { signal: record.abortSignal }))
            : null
          if (!resolved || typeof resolved.stream !== 'function') return null
          return resolved
        } catch {
          return null
        }
      })(),
      appendVoucherMessage: async ({ startSeq, endSeq, memberSeqs, sourceEventSeqs, text }) => {
        // 协调器显式给了来源事件就用之；否则按成员 seq 推导（仍是本段范围内的）。
        const given = (sourceEventSeqs ?? memberSeqs ?? []).filter((s) => Number.isSafeInteger(s) && s >= 0)
        const shadowed = given.length > 0 ? given : [startSeq]
        const event = session.append('user/message', { content: [{ type: 'text', text }] }, {
          surfaceOp: { op: 'replace', startSeq, endSeq },
          sourceEventSeqs: shadowed,
          source: { kind: 'user', form: 'memory-lab2-surface' },
        })
        return { seq: event?.seq }
      },
    }
  }

  /** 表面聚合凭证节点视图：[{ seq, text }]，供 coordinator 直接消费。 */
  function surfaceVoucherNodesOf(session) {
    const nodes = session?.surface?.nodes
    if (!Array.isArray(nodes)) return []
    const found = []
    for (const seq of nodes) {
      const event = typeof session?.eventAt === 'function' ? session.eventAt(seq) : null
      if (event?.type !== 'user/message') continue
      const content = event.data?.content
      if (!Array.isArray(content)) continue
      const first = content.find((part) => part?.type === 'text')
      if (typeof first?.text === 'string' && first.text.startsWith(AGG_VOUCHER_MARKER)) {
        found.push({ seq, text: first.text })
      }
    }
    return found
  }

  /**
   * 只读轻依赖：compress status 与 expand 不需要 adopt（会话未启用也能查已有
   * 账本与凭证），只装 sessionDir、表面凭证视图与遗忘过滤。
   */
  async function lightHierarchyDepsOf(invocation) {
    const sessionId = sessionIdOf(invocation.agent.session)
    const sessionDir = v2SessionDirectoryFor(labRoot, sessionId)
    const forgetIndex = await getForgetIndex(sessionDir).catch(() => null)
    const forgotten = forgetIndex?.forgotten instanceof Map ? forgetIndex.forgotten : new Map()
    return {
      sessionDir,
      surfaceVoucherNodes: surfaceVoucherNodesOf(invocation.agent.session),
      isRecordVisible: (recordId) => !forgotten.has(recordId),
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
    await captureNewFingerprints(record)
    // P3：层级压缩默认关；显式开启后，本批归档结束时尝试对连续已完成回执组做
    // 聚合凭证替换。失败只记告警、不破坏归档结果（失败不破坏原状态）。
    if (record.state.hierarchyCompress === true && Number(outcome.applied) > 0) {
      try {
        const stage = typeof stageCompress === 'function' ? stageCompress : maybeStageCompress
        const compressOutcome = await stage(await compressDepsOf(record), { enabled: true })
        if (compressOutcome?.triggered && Number(compressOutcome.applied) > 0) {
          logger?.info?.(`v2 层级压缩：${compressOutcome.applied} 组已替换为聚合凭证（拒绝 ${compressOutcome.rejected ?? 0}，失败 ${compressOutcome.failures ?? 0}）。`)
        }
      } catch (error) {
        // 保留错误类型：ReferenceError/TypeError 与业务拒绝必须能在日志里区分。
        logger?.warn?.(`v2 层级压缩尝试失败（原回执保持原样）：${error?.name ?? 'Error'}: ${error?.message ?? error}`)
      }
    }
    // S3 卡片组折叠（有界治理）：归档批完成后顺带收敛插件卡组。失败只记告警，
    // 绝不影响归档结果；无卡组时是零开销的一次扫描。
    try {
      const foldOutcome = await foldWorkingCards(agent)
      if (foldOutcome.folded > 0) {
        logger?.info?.(`memory-lab2: 折叠 ${foldOutcome.folded} 组插件工作卡（失败 ${foldOutcome.failed ?? 0}）。`)
      }
    } catch (error) {
      logger?.warn?.(`memory-lab2: 卡组折叠跳过：${error?.message ?? error}`)
    }
    return outcome
  }

  /**
   * 归档后增量采集验证指纹（差集式，只补「已落库但旁证无条目」的记录）。
   *
   * 纪律与 indexNewRecords 一致：旁证失败不影响归档（原文已在权威事务里），
   * 只记告警；check 时这些记录按未验证处理，绝不伪造 valid。
   */
  async function captureNewFingerprints(record) {
    if (typeof record?.directory !== 'string') return
    try {
      await factoryFor(record).withStore((store) => syncVerification({
        store,
        sessionDir: record.directory,
        warn: (message) => logger?.warn?.(message),
      }))
    } catch (error) {
      logger?.warn?.(`v2 归档后指纹采集失败（原文已保存，验证按未验证处理）：${error?.message ?? error}`)
    }
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
      const synced = await factoryFor(record).withStore(async (store) => syncRetrievalIndex({
        directory: record.directory,
        backend,
        store,
        // 同 sync 命令面：归档后增量同步排除软遗忘记录。
        forgetIndex: await getForgetIndex(record.directory),
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
    // P0-2：restore-skipped 行的原件仍在冷库且回执在活动面上，回注与工作卡
    // 一样以「是否有冷库依赖」为闸门，跳过行同样算依赖。
    if (engine.pendingReceipts(record).length === 0 && engine.restoreSkippedReceipts(record).length === 0) return decision
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
    confirmInjection,
    foldWorkingCards,
    shutdown,
    // 测试与诊断入口。
    guardCandidate,
    v2ArchiveNodeId,
  }
}

export { V2_RECEIPT_MARKER }
