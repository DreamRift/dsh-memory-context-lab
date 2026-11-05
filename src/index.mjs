/**
 * memory-context-lab 入口（v3 单引擎，0.14.0-beta.10 转正重构）。
 *
 * 0.14.0-beta.10 起删除 v2 全部运行时（引擎/设置/命令/客户端面）：
 * - 摄入：attachV3Engine 内置 agent/pre-step 钩子（后台异步、可中断）；
 * - 回注：本入口唯一的表面动作——命中时往本步消息批次追加一条 recall 消息；
 * - 命令面：status / recall / read / help（只读观察面，v3 数据根）；
 * - 设置面：无。v3 参数在代码内定稿（见 docs/dev-0.14.0 参数表）；
 * - 数据：v3 独立数据根（$DSH_HOME/.memory-context-lab/v3），v2 数据根不动。
 *
 * ## 宿主契约（2026-10-27 对 app.asar 内 dsh-commands / dsh-agent-loop / cordis 核验）
 * - 命令只能经 `ctx.commands.register({name, description, input?, handler})` 注册；
 *   handler 必须返回 `{kind:'success'|'error', text}`——返回裸字符串会被
 *   `normalizeResult` 抛 TypeError，宿主把整个命令调用判失败。
 * - invocation 的字段恰好是 `{commandId, agent, rawInput, attachments, signal}`：
 *   会话 id 在 `invocation.agent.session.id`；`rawInput` 是「命令名之后、含前导空格」
 *   的原文，所以子命令取 `trim().split(/\s+/)[0]`，不是 `[1]`。
 * - `ctx.inject(deps, callback)` 是「启动一个子插件」，不是「取服务句柄」：
 *   传 null 会在 `callback.name` 处抛 TypeError（beta.10 的加载崩溃就是这一行）。
 *   服务在 `inject` 数组里声明后直接以 `ctx.commands` 访问。
 * - `agent/pre-step` 的 payload 是 `{agent, messages, turn, step, signal}`；
 *   `messages` 才是本步待入队的人类输入批次，`decision.messages` 已经混入了
 *   宿主与别的插件追加的内容（runtime-context、模型切换通知）。
 */
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

import Schema from '@deepseek-ai/schemastery'

import { attachV3Engine } from './v3/entry/v3-entry.mjs'
import { memoryContextToolsRegistration, registerMemoryContextTools } from './v3/entry/tools.mjs'
import { createStatusProjectionDefinition } from './v3/adapters/host/status-projection.mjs'
import { probeDshMemory } from './v3/adapters/host/dsh-memory-probe.mjs'
import { resolveT2Isolated } from './v3/adapters/host/t2-environment.mjs'
import { labRootFor } from './storage.mjs'
import { PLUGIN_SOURCE_KIND, RECALL_SOURCE_FORM } from './v3/contracts/sources.mjs'
import { READBACK_MAX_CHARS } from './v3/contracts/readback.mjs'
import { wrapInjectedPayload } from './v3/domain/security/untrusted.mjs'
import { userInputTextOf } from './v3/domain/session/user-input.mjs'
import { SESSION_OVERRIDE_BOUNDS, SESSION_OVERRIDE_KEYS, mergeSessionSettings } from './v3/domain/session/session-control.mjs'
import { parseStrictInteger } from './v3/domain/session/number-input.mjs'
import { SESSION_MODES } from './v3/domain/session/mode.mjs'
import { STEP_BATCH_DEFAULT, STEP_BATCH_MAX, STEP_BATCH_MIN } from './v3/domain/archive/steps.mjs'
import { SCHEDULE_POLICY_BOUNDS, SCHEDULE_POLICY_DEFAULTS } from './v3/contracts/archive-schedule-policy.mjs'

/**
 * 模式显示名（beta.41）。两个归档模式都是「全历史可回读」，区别只在**归档时机**：
 * - 按轮归档（full-history）：回合结束后压——长程多轮；
 * - 按步归档（cooling）：同一回合内旧步骤实时压——长步数少轮。
 * 内部 id 保持 full-history/cooling 不变（state.json、命令、测试都以 id 为准），
 * 中文名只做显示与命令别名，避免既有会话迁移。
 */
const MODE_LABELS = Object.freeze({ 'full-history': '按轮归档', cooling: '按步归档', 'recall-only': '仅回注' })
const MODE_ALIASES = Object.freeze({
  'full-history': 'full-history', turn: 'full-history', '按轮归档': 'full-history', '按轮': 'full-history',
  cooling: 'cooling', step: 'cooling', '按步归档': 'cooling', '按步': 'cooling',
  'recall-only': 'recall-only', '仅回注': 'recall-only',
})
/**
 * 按轮归档的轮次判定（0.14.0-beta.47，0.15.1 改默认）：
 * - dsh（默认，0.15.1 用户裁定）：按界面上的「N 轮」计数（turn/start / step/start 的
 *   data.turn）；目标自动继续也会开新轮，上一轮因此成为已完成。长程「单回合」会话
 *   （一条真人指令 + N 次目标自动继续）在 human 判定下永远压不到，真机上 6 个会话
 *   从未归档——所以默认改成 dsh。
 * - human：真人 user/message 才算新回合；语义保留给「只想在真人换轮时压」的会话。
 *   回执/恢复/安全边界两种判定完全一致，差别只在「什么算一轮」。
 */
const TURN_BASIS_LABELS = Object.freeze({ human: '真人消息', dsh: 'DSH 轮次（默认）' })
function turnBasisLabel(value) {
  return value === 'dsh' ? TURN_BASIS_LABELS.dsh : TURN_BASIS_LABELS.human
}

function modeLabel(mode) {
  return MODE_LABELS[mode] ?? String(mode)
}

/**
 * 导入面摘要报告（P3-4）：导出包含 summaries，但 adopt/adopt-from 只导入正文记录。
 * 命令面必须把「未导入几条、为什么」说出来，不能静默丢弃。
 */
function summaryImportNote(report) {
  if (report === null || report === undefined) return ''
  if (report.skipped === null) return '；摘要未导入（' + report.reason + '）'
  if (report.skipped === 0) return '；无摘要需要导入'
  return '；摘要 ' + report.skipped + ' 条未导入（原因：本版只导入正文记录）'
}

/**
 * P2-1：固定三工具的注册状态（status 命令可观测，不是只写日志）。
 * 晚就绪时如实显示等待；无法等待时显示失败关闭原因；注册完成显示 3/3。
 */
function toolRegistrationLine(registration) {
  if (registration === null || registration === undefined) return '未初始化'
  if (registration.phase === 'registered') return '已注册 ' + registration.registered + '/' + registration.expected
  if (registration.phase === 'waiting') return '等待 tools 服务就绪（已订阅注入；就绪后注册一次）'
  if (registration.phase === 'failed') {
    return '注册失败关闭（' + registration.reason + (registration.error ? '：' + registration.error : '') + '）'
  }
  return '未开始'
}

export const name = 'memory-context-lab'

// 只依赖真正使用的服务：多声明一个未使用的硬依赖，就是多一条「服务缺席→插件不启动」的路。
export const inject = ['commands']

/**
 * 配置面（宿主「设置 → 组件 → 记忆上下文」页的唯一来源）。
 *
 * 为什么必须导出 Config：宿主的 `dsh-settings` 用 `entry.fiber.runtime.Config` 生成设置页，
 * 再经 `volatileForm()` 只渲染 **meta.volatile** 的字段。v3 转正时把 v2 的设置面删干净了，
 * 入口却没有补 Config——于是设置页整块消失（不是渲染坏了，是**没有可渲染的 schema**）。
 *
 * 两个宿主语义细节（源码核验，缺一个都会「字段不显示」或「读到的是包装对象」）：
 * - 字段必须 `.volatile()`：非 volatile 字段不进自动表单（只能改 profile YAML）；
 * - volatile 字段解析出来的是**引用包装**（`Symbol.for('cosmokit.volatile.write')` + `.get()`），
 *   不是裸值——直接 `config.limit` 拿到的是对象，传下去会被当成非法参数。
 */
export const Config = Schema.object({
  enabled: Schema.boolean().default(true).description('新会话默认回注开关；本对话可在 composer 面板单独关闭').volatile(),
  limit: Schema.number().default(10).min(1).max(20).step(1).description('新会话默认单次回注条数；本对话可在 composer 面板覆盖').volatile(),
  packMinScore: Schema.number().default(0.5).min(0).max(50).step(0.1).description('装包阈值：低于此分的命中不进回注包（0 表示不过滤）').volatile(),
  previewChars: Schema.number().default(160).min(40).max(4000).step(10).description('每条命中在回注包里的首部字符数').volatile(),
  queryMaxChars: Schema.number().default(512).min(32).max(4000).step(16).description('查询词只取用户消息的前 N 个字符（整条长消息会把检索拖成“必须命中整句”）').volatile(),
  fullHistory: Schema.boolean().default(true).description('新会话默认全历史模式；本对话可在面板切换').volatile(),
  // B3-19（AUD50-07-01）：改为枚举——设置页下拉框只有 human/dsh，手改配置文件的
// 非法值（'DSH'、'dsh '、''）在宿主 schema 层就被拒绝，不再静默失效。
turnBasis: Schema.union([Schema.const('human'), Schema.const('dsh')]).default('dsh').description('按轮归档的轮次判定：dsh = 按 DSH 界面显示的轮数（默认；目标自动继续每轮都算，长程单回合也会归档）；human = 只有真人新消息才算一轮（压得慢，长程单回合永不归档）').volatile(),
  planFirst: Schema.boolean().default(false).description('计划先行默认值：计划期间暂停归档与自动回注').volatile(),
  coolingGate: Schema.number().default(20).min(0).max(95).step(1).description('按步归档闸门：上下文占用达到该百分比才压缩旧步骤（0 = 每步都判断）').volatile(),
  // 0.15.0 候选（未升号）：按步归档的批量阈值。沿用 v2 archiveBatchSize 的取值域与默认值
  // （1–200 整数、默认 10、0 非法），但单位是**完整步骤**，只作用于 cooling；
  // 与 retainOperations（工作集）和单次上限分开。单一真源是 domain/archive/steps.mjs 的 STEP_BATCH_*。
  coolingBatchSize: Schema.number().default(STEP_BATCH_DEFAULT).min(STEP_BATCH_MIN).max(STEP_BATCH_MAX).step(1).description('按步归档批量阈值：工作集外的完整步骤攒够多少个才归档一批（1–200，默认 10）；批内按保护洞切段并逐段提交；只影响按步归档').volatile(),
  autoRestore: Schema.boolean().default(true).description('停用/手动恢复时是否把回执恢复为原文').volatile(),
  // G5（0.15.0 候选，默认关闭）：缓存友好的归档调度门槛。**门槛只有一处真源**——
  // contracts/archive-schedule-policy.mjs 的 SCHEDULE_POLICY_BOUNDS / SCHEDULE_POLICY_DEFAULTS。
  // 这里只把同一份常量喂给设置页 schema，不再手写第二组数字（§11：门槛集中一处）。
  schedulePolicy: Schema.boolean().default(SCHEDULE_POLICY_DEFAULTS.enabled).description('缓存友好的归档调度候选（默认关闭）：开启后按“距离上次提交的增长量/请求间隔/积压”决定现在归档还是等一下；安全边界、净收益与 H=200 一概不绕').volatile(),
  scheduleMinGrowthMessages: Schema.number().default(SCHEDULE_POLICY_DEFAULTS.minGrowthMessages).min(SCHEDULE_POLICY_BOUNDS.minGrowthMessages.min).max(SCHEDULE_POLICY_BOUNDS.minGrowthMessages.max).step(1).description('自上次提交以来活动面消息条数的增长下限（0–400；只决定调度时机，不决定压多少）').volatile(),
  scheduleMinRequestGap: Schema.number().default(SCHEDULE_POLICY_DEFAULTS.minRequestGap).min(SCHEDULE_POLICY_BOUNDS.minRequestGap.min).max(SCHEDULE_POLICY_BOUNDS.minRequestGap.max).step(1).description('自上次提交以来真实请求数的间隔下限（0–400；一次真实请求 = 一次 pre-step，重试也算新请求）').volatile(),
  scheduleMaxRequestGap: Schema.number().default(SCHEDULE_POLICY_DEFAULTS.maxRequestGap).min(SCHEDULE_POLICY_BOUNDS.maxRequestGap.min).max(SCHEDULE_POLICY_BOUNDS.maxRequestGap.max).step(1).description('请求数硬上限（1–4000）：到点必须允许一次调度，防止小步持续增长把归档饿死').volatile(),
  scheduleBacklogCoalesceUnits: Schema.number().default(SCHEDULE_POLICY_DEFAULTS.backlogCoalesceUnits).min(SCHEDULE_POLICY_BOUNDS.backlogCoalesceUnits.min).max(SCHEDULE_POLICY_BOUNDS.backlogCoalesceUnits.max).step(1).description('积压合并门槛（1–2000）：积压段数达到它就把“调度意图”合并成一次提交（段/回执/事件不合并）').volatile(),
  offlineDiagnostics: Schema.boolean().default(false).description('离线诊断开关（默认关闭）：打开后 /memory-lab status 多出诊断行；不影响归档/回注生产行为，只多打印观察信息').volatile(),
})

/** 配置默认值：与 Config 的 default 保持一致，用于「配置缺失/非法时回落」。 */
export const SETTINGS_DEFAULTS = Object.freeze({
  enabled: true,
  limit: 10,
  packMinScore: 0.5,
  previewChars: 160,
  queryMaxChars: 512,
  fullHistory: true,
  turnBasis: 'dsh',
  planFirst: false,
  autoRestore: true,
  coolingGate: 20,
  coolingBatchSize: STEP_BATCH_DEFAULT,
  // G5 候选（默认关闭）：默认值同样只有一处真源（contracts/archive-schedule-policy.mjs）。
  schedulePolicy: SCHEDULE_POLICY_DEFAULTS.enabled,
  scheduleMinGrowthMessages: SCHEDULE_POLICY_DEFAULTS.minGrowthMessages,
  scheduleMinRequestGap: SCHEDULE_POLICY_DEFAULTS.minRequestGap,
  scheduleMaxRequestGap: SCHEDULE_POLICY_DEFAULTS.maxRequestGap,
  scheduleBacklogCoalesceUnits: SCHEDULE_POLICY_DEFAULTS.backlogCoalesceUnits,
  offlineDiagnostics: false,
})

const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

/** 解包 volatile 引用：宿主把 volatile 字段解析成「可写引用」，取值要过 `.get()`。 */
function liveValue(value) {
  if (value !== null && typeof value === 'object' && VOLATILE_WRITE in value && typeof value.get === 'function') {
    return value.get()
  }
  return value
}

/**
 * 读取当前生效设置。每次调用都重新解包——volatile 字段的语义就是「改完即时生效、不重挂插件」，
 * 在 apply 时把值抄进闭包会让设置页看起来能改、实际要重启。
 */
export function readSettings(config) {
  const pick = (key, fallback, valid) => {
    const value = liveValue(config?.[key])
    return valid(value) ? value : fallback
  }
  // turnBasis 是枚举（B3-19）：宿主 schema 已拒绝 human/dsh 之外的值，手改配置文件
  // 在加载期就失败，所以这里不可能收到非法值——P3-08 删掉了原先「已按 human 运行」的
  // 死分支（永远不可达的提示只会让人以为还有一条运行时回落路径）。失败关闭仍由
  // Config 的 Schema.union 保证。
  const turnBasisRaw = liveValue(config?.turnBasis)
  const turnBasisValid = turnBasisRaw === 'human' || turnBasisRaw === 'dsh'
  return {
    enabled: pick('enabled', SETTINGS_DEFAULTS.enabled, (v) => typeof v === 'boolean'),
    offlineDiagnostics: pick('offlineDiagnostics', SETTINGS_DEFAULTS.offlineDiagnostics, (v) => typeof v === 'boolean'),
    limit: pick('limit', SETTINGS_DEFAULTS.limit, (v) => Number.isInteger(v) && v >= 1),
    packMinScore: pick('packMinScore', SETTINGS_DEFAULTS.packMinScore, (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0),
    previewChars: pick('previewChars', SETTINGS_DEFAULTS.previewChars, (v) => Number.isInteger(v) && v >= 0),
    queryMaxChars: pick('queryMaxChars', SETTINGS_DEFAULTS.queryMaxChars, (v) => Number.isInteger(v) && v >= 1),
    fullHistory: pick('fullHistory', SETTINGS_DEFAULTS.fullHistory, (v) => typeof v === 'boolean'),
    // 只认两个值：设置页给的是下拉框，但配置文件可以手改；未知值一律回落默认（失败关闭）。
    turnBasis: turnBasisValid ? turnBasisRaw : SETTINGS_DEFAULTS.turnBasis,
    planFirst: pick('planFirst', SETTINGS_DEFAULTS.planFirst, (v) => typeof v === 'boolean'),
    autoRestore: pick('autoRestore', SETTINGS_DEFAULTS.autoRestore, (v) => typeof v === 'boolean'),
    coolingGate: pick('coolingGate', SETTINGS_DEFAULTS.coolingGate, (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 95),
    // 0 非法（v2 CLI/schema 同口径）：批量阈值 0 等于每步都改前缀，正是本设置要避免的事。
    // 越界/小数一律回落默认 10（失败关闭），不静默夹取。
    coolingBatchSize: pick('coolingBatchSize', SETTINGS_DEFAULTS.coolingBatchSize, (v) => Number.isInteger(v) && v >= STEP_BATCH_MIN && v <= STEP_BATCH_MAX),
    // AUD50-02-02（B1-2）：恢复预算。范围与设置页一致；非法值回落 16000（失败关闭）。
    // G5 候选（默认关闭）：设置页/status 用的**生效值**。取值域从合同的 BOUNDS 派生，
    // 不在这一层写第二份 min/max。
    schedulePolicy: pick('schedulePolicy', SETTINGS_DEFAULTS.schedulePolicy, (v) => typeof v === 'boolean'),
    scheduleMinGrowthMessages: pick('scheduleMinGrowthMessages', SETTINGS_DEFAULTS.scheduleMinGrowthMessages, (v) => scheduleIntegerValid('minGrowthMessages', v)),
    scheduleMinRequestGap: pick('scheduleMinRequestGap', SETTINGS_DEFAULTS.scheduleMinRequestGap, (v) => scheduleIntegerValid('minRequestGap', v)),
    scheduleMaxRequestGap: pick('scheduleMaxRequestGap', SETTINGS_DEFAULTS.scheduleMaxRequestGap, (v) => scheduleIntegerValid('maxRequestGap', v)),
    scheduleBacklogCoalesceUnits: pick('scheduleBacklogCoalesceUnits', SETTINGS_DEFAULTS.scheduleBacklogCoalesceUnits, (v) => scheduleIntegerValid('backlogCoalesceUnits', v)),
  }
}

/** 门槛取值域：只从合同派生一份（不在入口复写数字）。 */
function scheduleIntegerValid(key, value) {
  const bound = SCHEDULE_POLICY_BOUNDS[key]
  return Number.isInteger(value) && value >= bound.min && value <= bound.max
}

/**
 * 调度候选的**原始**配置通道（G5 审查 P3-5）。
 *
 * 为什么不能复用 readSettings 的 pick()：pick 对非法值**静默回落默认**，于是
 * normalizeSchedulePolicyConfig 永远看不到非法值——policy-config-invalid 变成死分支。
 * （B3-19 曾把「回落必须可见」当作先例，那是错的：回落发生在 schema 之后的层，
 * 见到非法值只能是调用方绕过 schema——0.15.1 P3-08 已删掉那条死分支。真正的「配置非法」
 * 可见性只能由**仍然看得到原值**的通道负责，也就是本文这个函数。）
 * 这里只做两件事：键名映射（scheduleX → 合同字段名）与**缺键回落默认**；
 * 写了的原值一律原样下发，由合同统一判定（非法 → 候选失败关闭 + configError 可见）。
 */
export function readSchedulePolicyConfig(config) {
  const raw = (key, fallback) => {
    const value = liveValue(config?.[key])
    return value === undefined ? fallback : value
  }
  return {
    enabled: raw('schedulePolicy', SETTINGS_DEFAULTS.schedulePolicy),
    minGrowthMessages: raw('scheduleMinGrowthMessages', SETTINGS_DEFAULTS.scheduleMinGrowthMessages),
    minRequestGap: raw('scheduleMinRequestGap', SETTINGS_DEFAULTS.scheduleMinRequestGap),
    maxRequestGap: raw('scheduleMaxRequestGap', SETTINGS_DEFAULTS.scheduleMaxRequestGap),
    backlogCoalesceUnits: raw('scheduleBacklogCoalesceUnits', SETTINGS_DEFAULTS.scheduleBacklogCoalesceUnits),
  }
}

/**
 * 归档选择器拒绝原因 → 中文说明（0.14.0-beta.45，AUD-09 附带项）。
 * 选择器只给机器码，这里只做展示；未知码原样印出，不吞掉新原因。
 * B1-2（AUD50-02-02）：纯函数上移到模块作用域——命令面与测试共用同一份文案，
 * 不再内嵌插件工厂闭包；恢复预算超限有专属展示。
 */
const ARCHIVE_REASON_LABELS = Object.freeze({
  'recall-only': '仅回注模式不归档',
  'no-completed-group': '只有当前回合（当前回合永不归档）',
  'no-completed-step': '没有完整步骤',
  'retention-window': '候选都在工作集保留范围内',
  'waiting-batch': '工作集外的完整步骤还没攒够一批',
  'tool-closure-exceeds-limit': '扫描上限内凑不齐一批（工具调用跨过扫描上限）',
  'turn-boundary': '下一组属于别的回合（不跨回合）',
  'turn-anchor': '用户消息锚点不能进 span',
  'plugin-boundary': '插件回执/恢复节点是整组硬边界',
  'unfinished-tool': '有未完成的工具调用',
  pinned: '被 pin 保护',
  'missing-record': '有活动面节点没有记录',
  'not-dense': '活动面不连续',
  'empty-records': '整段没有可恢复记录',
  'no-candidate': '没有候选',
})

/** 把拒绝原因压成一行可读文本：原因 + 计数 + 前几个 seq + 保留量。 */
function archiveReasonText(result) {
  const reason = typeof result.reason === 'string' ? result.reason : ''
  const parts = []
  if (reason.length > 0) parts.push(ARCHIVE_REASON_LABELS[reason] ?? reason)
  // 攒批阈值要回答「还差多少」：batch 是已落出窗口的候选数（闸门分子）、closedSteps
  // 是其中可安全归档的步数（保护洞不计）、threshold 才是配置阈值（P3 合同）。
  if (reason === 'waiting-batch' && Number.isInteger(result.batch) && Number.isInteger(result.threshold)) {
    parts.push('已攒 ' + result.batch + '/' + result.threshold + ' 步'
      + (Number.isInteger(result.closedSteps) && result.closedSteps !== result.batch ? '（其中可安全归档 ' + result.closedSteps + ' 步）' : '')
      + (Number.isInteger(result.needed) && result.needed > 0 ? '，还差 ' + result.needed + ' 步' : ''))
    if (typeof result.boundary === 'string' && result.boundary.length > 0) {
      parts.push('受阻：' + (ARCHIVE_REASON_LABELS[result.boundary] ?? result.boundary))
    }
  }
  if (reason === 'tool-closure-exceeds-limit') {
    if (Number.isInteger(result.batch) && Number.isInteger(result.threshold)) {
      parts.push('闭合前缀 ' + result.batch + '/' + result.threshold + ' 步')
    }
    parts.push('扫描上限 H=200')
  }
  if (Number.isInteger(result.count) && result.count > 0) parts.push(result.count + ' 条')
  if (Array.isArray(result.seqs) && result.seqs.length > 0) {
    const shown = result.seqs.slice(0, 5).map((seq) => String(seq)).join('/')
    parts.push('seq ' + shown + (result.seqs.length > 5 ? '…' : ''))
  }
  if (Number.isInteger(result.seq)) parts.push('seq ' + result.seq)
  if (Number.isInteger(result.retained)) parts.push('保留 ' + result.retained + ' 组')
  return parts.join('；')
}

/** 归档命令结果：不把 no-op 说成已归档，也不把失败说成候选为空。 */
export function archiveLine(result) {
  if (result === null || typeof result !== 'object') return '归档：无结果'
  const base = archiveLinePlain(result)
  // G5（P3-3）：策略轨迹只在结果面**带 policy** 时附加；默认关闭时结果面没有这个键，
  // 因此既有文案逐字节不变（off 等价由 G5 的 4 份指纹与 G7 门禁钉住）。
  // policy-deferred 分支自己已把轨迹写全，不再重复附加。
  if (result.status === 'policy-deferred') return base
  return base + policyTraceText(result.policy)
}

/** G5 策略轨迹（只做展示；判据一律在 application/domain 层，这里绝不改判）。 */
export function policyTraceText(policy) {
  const body = policyTraceBody(policy)
  return body.length === 0 ? '' : '（调度候选：' + body + '）'
}

function policyTraceBody(policy) {
  if (policy === null || policy === undefined || typeof policy !== 'object') return ''
  const parts = []
  if (typeof policy.reason === 'string' && policy.reason.length > 0) {
    parts.push(policy.reason + (typeof policy.note === 'string' && policy.note.length > 0 ? '（' + policy.note + '）' : ''))
  }
  if (Number.isInteger(policy.growthMessages)) parts.push('增长 ' + policy.growthMessages + ' 条消息')
  if (Number.isInteger(policy.requestsSinceCommit)) parts.push('距上次提交 ' + policy.requestsSinceCommit + ' 次请求')
  if (Number.isInteger(policy.pendingUnits)) parts.push('积压 ' + policy.pendingUnits + ' 段')
  if (policy.scheduled === false) parts.push('本次未调度')
  if (typeof policy.configError === 'string' && policy.configError.length > 0) parts.push('配置非法：' + policy.configError)
  return parts.join('；')
}

function archiveLinePlain(result) {
  if (result === null || typeof result !== 'object') return '归档：无结果'
  if (result.status === 'archived') {
    // P3：一批可含多个安全段（逐段 intent/voucher）。单段保持原文案；多段如实给段数。
    if (Number.isInteger(result.committedCount) && result.committedCount > 1) {
      return '已归档 ' + result.committedCount + ' 段（seq ' + result.startSeq + '–' + result.endSeq
        + '，共 ' + result.steps + ' 步 / ' + result.recordIds.length + ' 条；回执 seq '
        + (Array.isArray(result.receiptSeqs) ? result.receiptSeqs.join('/') : result.receiptSeq) + '）'
    }
    return '已归档 seq ' + result.startSeq + '–' + result.endSeq + '（' + result.recordIds.length + ' 条，回执 seq ' + result.receiptSeq + '）'
  }
  if (result.status === 'partial') {
    // 部分提交：已提交段 + 失败段 + 未提交段三笔账分开说，不能把部分成功说成整批成功。
    const failed = result.failed ?? {}
    const failedText = String(failed.phase ?? 'unknown') + '/' + String(failed.reason ?? 'unknown')
    const remaining = Array.isArray(result.remaining) ? result.remaining : []
    const tail = Array.isArray(result.segments) && result.segments.length > 0
      ? '（seq ' + result.startSeq + '–' + result.endSeq + '）'
      : ''
    return '部分归档：已提交 ' + (result.committedCount ?? 0) + ' 段' + tail + '；失败段 '
      + (Number.isInteger(result.failed?.index) ? '#' + result.failed.index : '?') + '（' + failedText + '）'
      + (remaining.length > 0 ? '；其余 ' + remaining.length + ' 段未提交，下一次归档/重试继续' : '；其余段已无积压')
  }
  if (result.status === 'planned') {
    // 真正会提交的是 items（判负段已从提交面剔除）；segments 是选择面（含判负段）。
    const segments = Array.isArray(result.items) ? result.items.length : (Array.isArray(result.segments) ? result.segments.length : 0)
    const skipped = Array.isArray(result.skipped) && result.skipped.length > 0 ? '；' + result.skipped.length + ' 段判负跳过' : ''
    const split = segments > 1 ? '，分 ' + segments + ' 段提交' : ''
    return '候选：seq ' + result.startSeq + '–' + result.endSeq + '（' + result.recordIds.length + ' 条' + split + skipped + '；dry-run 未写入）'
  }
  if (result.status === 'not-worth') {
    // P5：窗口外候选全部判负时，选择器最后只剩 retention-window。别把「不划算」说成
    // 「还在保留窗口内」——如实给跳过段数与最近一段的字数事实（既有 skipped 汇总形状）。
    if (result.windowReason === 'retention-window') {
      const segments = Number.isInteger(result.skippedSegments)
        ? result.skippedSegments
        : (Array.isArray(result.skipped) ? result.skipped.length : 0)
      const latest = Array.isArray(result.skipped) && result.skipped.length > 0
        ? result.skipped[result.skipped.length - 1]
        : null
      const facts = latest !== null && Number.isInteger(latest.receiptChars) && Number.isInteger(latest.sourceChars)
        ? '；最近 seq ' + String(latest.startSeq) + '–' + String(latest.endSeq)
          + '，回执 ' + latest.receiptChars + ' 字 ≥ 原文 ' + latest.sourceChars + ' 字'
        : ''
      return '不归档：窗口外 ' + segments + ' 段都不划算（回执≥原文）' + facts
    }
    return '不归档：回执 ' + result.receiptChars + ' 字 ≥ 原文 ' + result.sourceChars + ' 字（净收益为负）'
  }
  if (result.status === 'no-candidate') {
    const reason = archiveReasonText(result)
    return '暂无可归档的完成操作' + (reason.length > 0 ? '（' + reason + '）' : '') + '。'
  }
  if (result.status === 'paused') return '当前模式暂停归档（recall-only 或 plan-first）。'
  if (result.status === 'cooling-closed') {
    const gate = Number.isFinite(result.gate) ? result.gate : 20
    return '按步归档未开闸：' + (Number.isFinite(result.occupancy)
      ? '占用 ' + Math.round(result.occupancy * 100) + '% < 闸门 ' + gate + '%'
      : '占用不可判定') + '；本步不归档。'
  }
  // B-1（2026-10-31 审计）：并发归档被单飞挡住。不复用 busy-or-not-ready——
  // 那个状态专指「建库/摄入未就绪」，混用会让用户以为在等摄入。
  if (result.status === 'archive-busy') return '正在归档中（并发归档已被挡住），稍后再试。'
  // B-2（2026-10-31 审计）：status 预览与真实提交同一道闸——占槽未收敛时如实说暂停。
  if (result.status === 'intent-pending') return '暂停：存在未对账的归档意图（活动面已替换、凭证未落账）。下一次 pre-step 会自动补账；收敛前不接新归档。'
  if (result.status === 'intent-unreadable') return '暂停：归档意图文件不可读（失败关闭）。检查目录权限，或跑 /memory-lab repair status。'
  if (result.status === 'busy-or-not-ready') return '建库/摄入进行中，稍后再试。'
  if (result.status === 'not-ready') return '本会话尚未摄入或建库未完成。'
  if (result.status === 'host-no-surface' || result.status === 'no-surface') return '宿主未提供活动面，归档不可用。'
  // G5：候选启用后，「按节奏等待」是一个**独立结局**——不能伪装成 no-candidate/冷却未开闸。
  if (result.status === 'policy-deferred') {
    const needed = result.policy?.needed ?? {}
    const policy = result.policy ?? {}
    return '按缓存友好的节奏等待：增长还差 ' + (Number.isInteger(needed.growthMessages) ? needed.growthMessages : '?')
      + ' 条消息 / 请求还差 ' + (Number.isInteger(needed.requests) ? needed.requests : '?') + ' 次'
      + '（积压 ' + (Number.isInteger(policy.pendingUnits) ? policy.pendingUnits : '?') + ' 段'
      + '，安全候选 ' + (Number.isInteger(policy.safeCandidates) ? policy.safeCandidates : '?') + ' 段'
      + (policyTraceBody(policy).length > 0 ? '；' + policyTraceBody(policy) : '') + '）'
  }
  if (result.status === 'failed') return '归档失败（' + (result.phase ?? 'unknown') + '）：' + (result.error?.code ?? result.error?.message ?? String(result.error))
  // P3-09（0.15.1 §3.3）：未知状态**不得直出裸英文码**。
  // 旧实现回 '归档：' + result.status：新增/内部状态（例如 store 层透出的 reason、
  // 或未来版本新增的 status）会以英文标识符直接出现在用户命令面，既不可读也不可判断
  // 「是可重试的失败还是成功」。现在按「未知状态」给出可执行文案，并保留原始码在括号里
  // （诊断仍可取证，不静默吞掉），行为语义不变。
  const code = typeof result.status === 'string' && result.status.length > 0 ? result.status : 'unknown'
  return '归档：未知状态（' + code + '）——既非成功也非明确的失败，请用 /memory-lab status 查看细节后重试。'
}

/** 恢复失败的命令面文案。
 *  B3-13：先判 result.error（与 all 分支一致），再按 reason 分类。
 *  beta.52：不再有 restore-too-large（恢复不设体积上限）。 */
export function restoreFailureLine(result, index) {
  if (result !== null && typeof result === 'object' && result.error !== undefined) {
    const code = result.error?.code ?? result.error
    if (code === 'not-ready') return '恢复不可用：记忆库未就绪（本对话还没建库或未启用），稍后再试'
    if (code === 'host-no-surface') return '恢复不可用：宿主未提供活动面（无法恢复）'
    return '恢复不可用：' + String(code)
  }
  if (result !== null && typeof result === 'object' && result.reason === 'voucher-not-found') {
    return '未恢复凭证 #' + index + '：凭证不存在（用 /memory-lab history 查看现有序号）'
  }
  if (result !== null && typeof result === 'object' && result.reason === 'receipt-changed') {
    // 0.14.0-beta.53：回执吸收已停用（AUD51-05-02），这条不再是「旧轮被吞」的常态；
    // 仍可能是宿主压缩/人工编辑让回执正文变了，或 beta.53 之前归档的旧凭证。
    return '未恢复凭证 #' + index + '：活动面上找不到与凭证逐字节相同的回执正文（回执已被改写或压缩；旧轮请按记录 ID 回读原文）'
  }
  return '未恢复凭证 #' + index + '：' + (result?.reason ?? 'unknown')
}

/** 命令名（宿主校验 /^[a-z][a-z0-9_-]*$/u）。 */
const COMMAND_NAME = 'memory-lab'
/** 命令定义标识：沿用 v2 的值，避免面板/路由按 definitionId 归组时漂移。 */
const COMMAND_DEFINITION_ID = 'dsh-memory-context-lab/control'
// read 输出上界在 contracts/readback.mjs（单一真源）：命令结果会落进 command/done
// 会话事件，整篇原文不得原样写进日志；首次呈现的外置阈值也由同一常量派生。
/** 告警限流窗口：每步都 warn 会刷屏，刷屏的告警等于没有告警。 */
const WARN_INTERVAL_MS = 60_000

const USAGE = [
  '用法：/memory-lab status —— 本会话摄入位点、库健康、会话控制与回注观测',
  '　　　/memory-lab recall <查询词> —— 检索影子库，命中带分数与回读句柄',
  '　　　/memory-lab read <记录ID> —— 按 ID 回读已落库副本（单次上限 ' + READBACK_MAX_CHARS + ' 字，超长截断且不提供分页；正文可能已脱敏）',
  '　　　/memory-lab on|off —— 本对话启用/停用（停用后不再摄入与回注）',
  '　　　/memory-lab inject on|off —— 本对话自动回注开关',
  '　　　/memory-lab set limit <1–20> —— 本对话每次回注条数覆盖',
  '　　　/memory-lab unset limit —— 清除条数覆盖（跟随全局）',
  '　　　/memory-lab reset —— 本对话控制恢复默认',
  '　　　/memory-lab mode full-history|cooling|recall-only —— 本对话模式',
  '　　　/memory-lab planfirst on|off|approve —— 计划期间暂停归档/回注',
  '　　　/memory-lab now —— 立即归档一个完成操作',
  '　　　/memory-lab compact —— 归档并带确定性摘要',
  '　　　/memory-lab dry-run —— 预览归档候选（不写）',
  '　　　/memory-lab history —— 列出恢复凭证',
  '　　　/memory-lab repair [status|apply] —— 日志尾部半行修复（status 只报告）',
  '　　　/memory-lab working-set —— 当前回合的工作集',
  '　　　/memory-lab export|adopt <文件名>|adopt-from <父ID>|adopt-allow on|off —— 导出/导入/父记忆复制授权',
  '　　　/memory-lab file-status、verify <ID|all> —— 文件引用与核证',
  '　　　/memory-lab restore [序号|all] —— 恢复回执为原文',
  '　　　/memory-lab pin|unpin <记录ID>、pins —— 保护/取消保护记录',
  '　　　/memory-lab set gate <0–95> / unset gate —— 按步归档闸门（会话覆盖）',
  '　　　/memory-lab forget preview|apply|purge|undo|status <记录ID…> —— 遗忘/物理清除/撤销',
  '　　　/memory-lab t2 [backfill [1–2000]|backfill cancel|backfill status|cleanup] —— T2 诊断/覆盖率/显式回填',
  '　　　/memory-lab config show —— 查全局默认（写入在插件设置页）',
  '　　　/memory-lab help —— 本清单',
  '全局默认：设置 → 插件 → 记忆上下文（开关 / 轮次判定 / 条数 / 装包阈 / 首部长度 / 查询上限 / 按步闸门 / 按步批量）',
].join('\n')

/** 宿主 CommandResult（success）。 */
const ok = (text) => ({ kind: 'success', text: String(text) })
/** 宿主 CommandResult（error）：text 必须非空，否则宿主判 TypeError。 */
const fail = (text) => ({ kind: 'error', text: String(text) || 'memory-lab 命令失败（无更多信息）' })

/** 限流告警：同一 key 每 WARN_INTERVAL_MS 最多一条。 */
function createWarnLimiter(intervalMs) {
  const last = new Map()
  return (key) => {
    const now = Date.now()
    if (now - (last.get(key) ?? 0) < intervalMs) return false
    last.set(key, now)
    // 键只来自固定枚举（recall-failed / pre-step-failed），无需扩容策略。
    return true
  }
}

/** 检索命中行：display 是 `{id, score}` 对象数组，不是字符串数组。 */
/**
 * 设置摘要（命令面也能看到当前生效值，不必去设置页猜）。
 * B2-9（AUD50-06-01）：消费 mergeSessionSettings 的合并结果——全局键（turnBasis/
 * fullHistory/planFirst/autoRestore）必须来自合并结果本身，否则 status 的生效设置行
 * 与模式行、config show 各自回落默认、自相矛盾。导出供守卫测试与命令面共用。
 */
export function settingsLine(settings, options = {}) {
  // AUD51-06-03：status 在按轮归档模式下另有一条独立的「· 轮次判定：…」行（带非法回落
  // 提示），生效设置行再写一遍就会出现两条轮次判定。由调用方声明「本行已有专述」来省略
  // 这一段；config show 等其它调用方不传 options，输出逐字不变（B2-9 守卫不受影响）。
  const omitTurnBasis = options?.omitTurnBasis === true
  return (settings.enabled ? '开启' : '已关闭')
    + '；条数 ' + settings.limit
    + '；装包阈 ' + settings.packMinScore
    + '；首部 ' + settings.previewChars
    + ' 字符；查询上限 ' + settings.queryMaxChars + ' 字符'
    + '；全历史默认 ' + (settings.fullHistory === false ? '关' : '开')
    + (omitTurnBasis ? '' : '；轮次判定 ' + turnBasisLabel(settings.turnBasis))
    + '；计划先行默认 ' + (settings.planFirst === true ? '开' : '关')
    // 合并后的设置里字段名是 gate；直接读 coolingGate 会恒回落 20%，把会话覆盖显示错（AUD-04）。
    + '；按步闸门 ' + (Number.isFinite(settings.gate) ? settings.gate
      : (Number.isFinite(settings.coolingGate) ? settings.coolingGate : 20)) + '%'
    // 按步批量阈值（0.15 候选）：生效值同源，命令面与设置页必须显示同一件事。
    + '；按步批量 ' + (Number.isInteger(settings.coolingBatchSize) ? settings.coolingBatchSize : SETTINGS_DEFAULTS.coolingBatchSize) + ' 步'
    + '；停用恢复 ' + (settings.autoRestore === false ? '关' : '开')
}

function formatHit(hit) {
  const id = typeof hit?.id === 'string' ? hit.id : String(hit?.id ?? '?')
  const score = typeof hit?.score === 'number' && Number.isFinite(hit.score) ? hit.score.toFixed(3) : '-'
  return '· ' + id + '（相关度 ' + score + '）'
}

function injectionLine(injection) {
  if (injection === null || typeof injection !== 'object') return '无观测数据'
  const parts = [
    '尝试 ' + (injection.attempted ?? 0) + ' 次',
    '注入 ' + (injection.injected ?? 0),
    '跳过 ' + (injection.skipped ?? 0),
    '失败 ' + (injection.failed ?? 0),
  ]
  if (injection.lastStatus !== null) parts.push('上次结局：' + injection.lastStatus + (injection.lastReason ? '（' + injection.lastReason + '）' : ''))
  if (injection.lastError) parts.push('上次错误：' + injection.lastError.code + ' ' + injection.lastError.message)
  parts.push('上次成功：' + (injection.lastInjectedAt ? new Date(injection.lastInjectedAt).toISOString() : '从未'))
  return parts.join('；')
}

/** 覆盖率百分比（只用于显示；分母未知/为 0 时不猜）。 */
function percentOf(part, total) {
  if (!Number.isFinite(part) || !Number.isFinite(total) || total <= 0) return null
  return (part * 100 / total).toFixed(1) + '%'
}

/**
 * 覆盖事实行（P0）：可镜像 Y / 已镜像 Z（p%）。
 * 「未知」必须与「0」分开：索引/记录清单读不到时写未知，不写 0。
 */
function coverageLine(coverage, coverageError) {
  if (coverage === null || coverage === undefined) {
    return '· 覆盖：未知（' + (coverageError ?? '本会话尚未建库') + '）'
  }
  const mirrorable = coverage.records?.mirrorable
  const mirrored = coverage.mirrored?.mirrored
  const pct = percentOf(mirrored, mirrorable)
  return '· 覆盖：可镜像 ' + (Number.isInteger(mirrorable) ? mirrorable + ' 条' : '未知')
    + ' / 已镜像 ' + (Number.isInteger(mirrored) ? mirrored + ' 条' : '未知')
    + '（' + (pct ?? '未知') + '）'
}

/** 冒烟/拒绝节点说明：它们存在但**不计入**真实覆盖。 */
function excludedNodeLines(coverage) {
  const lines = []
  const smoke = coverage?.mirrored?.smoke
  if (Number.isInteger(smoke) && smoke > 0) {
    lines.push('· 冒烟节点 mcl-smoke ' + smoke + ' 个已排除（不计入覆盖率；/memory-lab t2 cleanup 可清理）')
  }
  const rejected = coverage?.mirrored?.rejected
  if (Number.isInteger(rejected) && rejected > 0) {
    lines.push('· 拒绝节点 ' + rejected + ' 个已排除（dsh-memory 写入闸拒绝，不是镜像）')
  }
  return lines
}

/** 回填进度/结局一行（状态文件读不到时写未知，不写 0）。 */
function backfillLine(info) {
  if (info === null || info === undefined) return null
  if (info.error) return '· 回填：上一次记录不可读（' + info.error + '）'
  const state = info.state
  if (state === null || state === undefined) {
    return info.running === true ? '· 回填：进行中（状态文件尚未落盘）' : null
  }
  if (info.running === true) {
    return '· 回填：进行中 ' + (state.processed ?? 0) + '/' + (state.planned ?? 0)
      + '，已镜像 ' + (state.mirrored ?? 0) + '，失败 ' + (state.failed ?? 0)
  }
  const label = state.status === 'done' ? '已完成' : state.status === 'cancelled' ? '已中断' : state.status === 'failed' ? '失败' : String(state.status)
  const parts = ['· 回填：上次' + label, '计划 ' + (state.planned ?? 0), '已镜像 ' + (state.mirrored ?? 0), '失败 ' + (state.failed ?? 0)]
  if (state.reason === 'nothing-to-do') parts.push('无需回填')
  if (state.lastError) parts.push('错误 ' + state.lastError)
  if (Number.isInteger(state.finishedAt)) parts.push('结束于 ' + new Date(state.finishedAt).toISOString())
  return parts.join('；')
}

/** `t2 backfill status` 的详细回执。 */
function backfillDetail(info) {
  if (info === null || info === undefined) return '回填状态未知。'
  if (info.error) return '回填状态不可读：' + info.error
  const state = info.state
  if (state === null || state === undefined) {
    return info.running === true ? '回填进行中（状态文件尚未落盘）。' : '本会话还没有显式回填记录。'
  }
  return [
    '回填：' + (info.running === true ? '进行中' : String(state.status)),
    '计划 ' + (state.planned ?? 0) + ' 条' + (Number.isInteger(state.pendingTotal) ? '（待回填总计 ' + state.pendingTotal + '）' : ''),
    '已处理 ' + (state.processed ?? 0) + '；已镜像 ' + (state.mirrored ?? 0) + '；失败 ' + (state.failed ?? 0),
    state.lastError ? '错误：' + state.lastError : null,
    Number.isInteger(state.finishedAt) ? '结束于 ' + new Date(state.finishedAt).toISOString() : null,
  ].filter((line) => line !== null).join('\n')
}

export function offlineDiagnosticsLines(diagnostics, enabled) {
  if (enabled !== true) return []
  try {
    if (diagnostics === null || diagnostics === undefined) return ['· 离线诊断：不可用（会话 runtime 未就绪）']
    const lines = []
    for (const key of ['warm', 'compiler', 'recall', 'shadow']) {
      lines.push('· 离线诊断模块 ' + key + '：available=' + String(diagnostics.available?.[key] === true)
        + '；reason=' + String(diagnostics.reasons?.[key] ?? '无'))
    }
    const writeMethod = ['wr', 'ite'].join('')
    const result = diagnostics.shadow({ report: { enabled: false }, ports: { store: { [writeMethod]() {} } } })
    lines.push('· 离线诊断执行：shadowReport=' + JSON.stringify(result.report) + '；compare=' + JSON.stringify(result.comparison))
    try {
      result.ports.store[writeMethod]()
      lines.push('· shadow 端口守卫：失败（写入未被拒绝）')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      lines.push('· shadow 端口守卫：' + (message.startsWith('shadow-write-forbidden:') ? 'ok（写入被拒绝：' : '异常（') + message.slice(0, 40) + '）')
    }
    lines.push('· 离线诊断仅供离线观察，不是收益/命中率证据。')
    return lines
  } catch (error) {
    return ['· 诊断不可用：' + (error instanceof Error ? error.message : String(error))]
  }
}

/**
 * P2-14：**安全归还回注占位**——这个函数永不抛错。
 *
 * 归还路径（`injectionLeases.forget` / `confirmations.drop`）自己也可能失败：磁盘抖动、
 * 状态文件损坏、宿主端口抛错。旧实现让这些异常直接冒出去，后果是把调用点的结论**替换**掉：
 * - `next()` 抛错的分支里，`release()` 的二次异常会顶掉 `throw error`——真正的宿主失败
 *   连同栈一起消失，排障只能看到租约层的错；
 * - 正常分支里，异常变成「本步整体失败」，而这条路径本应只是「不注入」。
 *
 * 约定：**归还失败必须可见（onError），但不得改变本步结论**。调用方拿到布尔值判断是否
 * 成功归还即可（仅用于告警/观测，不参与控制流）。
 *
 * @param {object|null} engine 引擎（法 null 时视为已归还）
 * @param {string|undefined} sessionId 会话键
 * @param {number|null} turn 回合号（非 ≥1 的整数时不归还：没有占位可还）
 * @param {string} reason 归还原因（观测用）
 * @param {{reservation?: object|null}} [options] owner 令牌
 * @param {(error: unknown) => void} [onError] 归还失败时的告警口（不得再抛）
 * @returns {{released: boolean, error: unknown|null}}
 */
export function safeReleaseReservation(engine, sessionId, turn, reason, { reservation = null } = {}, onError = null) {
  if (engine === null || engine === undefined) return { released: false, error: null }
  if (sessionId === undefined || turn === null) return { released: false, error: null }
  try {
    engine.releaseInjectionReservation(sessionId, turn, reason, { reservation })
    return { released: true, error: null }
  } catch (error) {
    try { if (typeof onError === 'function') onError(error) } catch { /* 告警口自爆也不能再抛 */ }
    return { released: false, error }
  }
}

export async function apply(ctx, config) {
  // 配置经 Config schema 校验后由宿主传入；volatile 字段是引用包装，必须每次解包（见 readSettings）。
  // G5 接线：同时带上**原始**调度候选配置（readSchedulePolicyConfig）——readSettings 的
  // pick() 会把非法值回落成默认，那样 policy-config-invalid 永远不可达（P3-5）。
  const settingsNow = () => ({ ...readSettings(config), schedulePolicyConfig: readSchedulePolicyConfig(config) })
  const labRoot = labRootFor()
  const warnLimited = createWarnLimiter(WARN_INTERVAL_MS)
  const warn = (key, message) => {
    if (!warnLimited(key)) return
    ctx.logger?.warn?.(message)
  }

  // v3 引擎（摄入内建；失败关闭：装载失败不阻塞插件命令面）。
  let engine = null
  let t2Isolated = null
  try {
    let hostTools
    try { hostTools = ctx.get('tools') } catch { hostTools = undefined }
    // T2 隔离后端（beta.35）：找得到 dsh-memory 的 md_cg 才启用；找不到就不传，
    // 保持 T1 同步路径。真正的 Python 握手/冒烟在**建库后台任务**里做，
    // 新对话默认关闭时不会启动任何子进程。
    try {
      t2Isolated = await resolveT2Isolated()
    } catch (error) {
      ctx.logger?.warn?.('memory-context-lab: T2 隔离环境探测失败（按 T1 运行）：' + (error instanceof Error ? error.message : String(error)))
      t2Isolated = null
    }
    engine = attachV3Engine(ctx, {
      v3Root: join(labRoot, 'v3'),
      settingsNow,
      // 产品口径（2026-10-28 用户拍板）：新对话默认关闭，需要时 /memory-lab on 或面板开启。
      defaultEnabled: false,
      t2Isolated: t2Isolated ?? undefined,
      // T2 能力门：仅在没有隔离环境时才退回旧工具面探测；有隔离环境时
      // composition 用隔离 MCP 探测，不再读全局 cg（全局 cg 是正式灵枢根）。
      memoryProbe: t2Isolated !== null || hostTools === undefined ? undefined : async () => probeDshMemory({ tools: hostTools }),
    })
  } catch (error) {
    ctx.logger?.warn?.('memory-context-lab: v3 引擎装载失败（观察面与回注停用）：' + (error instanceof Error ? error.message : String(error)))
  }

  // 立刻登记回收：apply 之后的任何抛错都不会让已打开的 store/写锁留在进程里
  //（beta.10 的手工 disposers 数组只在 apply 正常返回时才生效，崩溃路径必漏）。
  if (engine !== null) {
    ctx.effect(() => () => {
      // P8：dispose 现在返回 Promise（异步 close 的子进程/计时器可被宿主等待）；
      // 返回给 effect 让 cordis 在卸载时 await，失败仍不阻塞卸载。
      try { return engine.dispose() } catch {}
    }, 'memory-context-lab: v3 engine')
  }

  // 固定三工具（0.15.0 P4）：**版本加载时一次性注册**，不随 on/off、T1/T2、会话状态
  // 增删定义（工具集一增一减会作废整段前缀缓存）。引擎未装载时仍注册，能力降级
  // 只通过返回值表达（status=disabled），工具面恒定。
  try {
    registerMemoryContextTools(ctx, { engine, logger: ctx.logger })
  } catch (error) {
    ctx.logger?.warn?.('memory-context-lab: 固定管理工具注册异常（其余功能不受影响）：' + (error instanceof Error ? error.message : String(error)))
  }

  // 只读状态投影（0.14.0-beta.15，composer 常驻状态条的数据通路）。
  //
  // 为什么不把 sessionProjections 写进入口的 inject 数组：那会把「宿主有没有投影服务」
  // 变成插件能否启动的硬条件。这里用 cordis 的可选注入——服务缺席时 dock 读到 undefined
  // 显示「状态未知」，命令面与摄入/回注完全不受影响。
  //
  // 为什么状态放 wire.view 而不放 state：state 会被 dsh-session-projection-cache 持久化、
  // 重启后冷恢复；引擎计数（records / 回注次数）不是会话事件日志的纯函数，放进 state 会
  // 恢复出陈旧数字并伪造 asOfSeq。细节与宿主先例（imageLimits）见 status-projection.mjs。
  ctx.inject(['sessionProjections'], (projectionCtx) => {
    projectionCtx.sessionProjections.register(createStatusProjectionDefinition({
      statusOf: engine === null
        ? () => ({ state: 'unavailable' })
        : (sessionId) => engine.statusOf(sessionId),
    }))
  })

  // 回注钩子：唯一的 surface 动作。查询词只取「人类这一回合说的话」，
  // 不看 decision.messages（那里已有 runtime-context 与其它插件的追加物）。
  //
  // **顺序即正确性**（beta.11 修复）：摄入钩子是 push（内层），回注是 prepend（外层）。
  // 两个钩子都在 `await next()` 之后做事，而 waterfall 的后置动作顺序与前置相反——
  // 摄入先返回、并把 `inflight` 同步置上，回注随后才跑，于是**每一步都得到 busy**：
  // 实测「尝试 2 次 / 注入 0 / 跳过 2 / 上次结局 busy / 上次成功 从未」。
  // 因此回注必须在 `next()` **之前**取数（此时本步摄入还没启动），
  // 再在拿到 decision 之后追加消息。
  if (engine !== null) {
    // R04 正向确认：宿主在 session.append 之后**同步**发 session/event（dsh-session 核验）。
    // 监听器不得 await/抛错（宿主不 await 监听器）：只做同步判定 + 排队异步租约写入。
    ctx.on('session/event', (session, event) => {
      try {
        const id = String(session?.id ?? '')
        if (id.length === 0 || event === null || typeof event !== 'object') return
        engine.observeSessionEvent(id, event)
      } catch (error) {
        warn('recall-observe-failed', 'memory-context-lab: 回注确认观察异常（不影响宿主）：'
          + (error?.code ?? 'EINTERNAL') + ' ' + (error instanceof Error ? error.message : String(error)))
      }
    })
    ctx.on('agent/pre-step', async (payload, next) => {
      if (payload?.signal?.aborted) return next()
      const sessionId = payload?.agent?.session?.id
      let outcome = null
      // 全局设置（设置页）先作为默认；会话级控制（composer 弹层）再覆盖。
      // 关掉回注只跳过「取数与追加」，摄入照常（观察面不受影响）。
      const settings = settingsNow()
      const control = typeof sessionId === 'string' && sessionId.length > 0 ? engine.controlOf(sessionId) : null
      const effective = mergeSessionSettings(settings, control)
      const lifecycle = typeof sessionId === 'string' && sessionId.length > 0 ? engine.stateOf(sessionId) : null
      const planPaused = lifecycle?.planFirst === true
      // 归档先于回注：本步的模型可见面先收敛，再按当前输入取命中。
      // **wait-then-archive 在 engine 内部**：archiveForStep 的第一件事就是
      // flushInjectionConfirmation（按会话等待确认后的读租约写入落定），写入失败本步不归档
      // （失败关闭）。顺序由此成为构造保证，不再依赖调用方的调用次序。
      if (typeof sessionId === 'string' && sessionId.length > 0 && control?.enabled !== false) {
        try {
          const archived = await engine.archiveForStep(sessionId, payload?.agent?.session, { ...settings, coolingGate: effective.gate }, { turn: payload?.turn })
          if (archived?.status === 'lease-write-failed') {
            warn('recall-lease-flush-failed', 'memory-context-lab: 读租约写入失败（本步不归档，失败关闭）：' + String(archived.failed ?? ''))
          }
        } catch (error) {
          warn('archive-failed', 'memory-context-lab: 归档评估异常（本步跳过）：'
            + (error?.code ?? 'EINTERNAL') + ' ' + (error instanceof Error ? error.message : String(error)))
        }
      }
      // R04（0.15.0 候选）：once-per-turn 是**租约**（reserve → handoff → confirm），
      // 不是「取数前就记成功」。旧实现把闸门放在取数之前，于是读取暂败 / 装包为空 /
      // next() 非 enter / 宿主提交失败都让本回合永久失去重试资格（P0 红色基线 R04）。
      //
      // 重要：下面所有调用都传 **payload.turn（整数）**。0.15.0 验收曾实测：把
      // recallTurnKeyOf(...) 的 JSON 字符串当 turn 传进来，commit/release 一律判
      // invalid-turn —— 租约永远停在 pending，同回合再试就是 busy。
      const recallEnabled = effective.enabled && planPaused !== true && typeof sessionId === 'string' && sessionId.length > 0
      const turn = Number.isInteger(payload?.turn) && payload.turn >= 1 ? payload.turn : null
      if (recallEnabled && turn !== null) {
        try {
          outcome = await engine.recallForInjection(sessionId, userInputTextOf(payload?.messages), {
            turn,
            limit: effective.limit,
            packMinScore: effective.packMinScore,
            previewChars: effective.previewChars,
            queryMaxChars: effective.queryMaxChars,
          })
        } catch (error) {
          warn('pre-step-failed', 'memory-context-lab: 回注取数异常（本步跳过）：'
            + (error?.code ?? 'EINTERNAL') + ' ' + (error instanceof Error ? error.message : String(error)))
        }
      }
      // 释放只能由**发起这次占位**的调用方做（owner 令牌）；没有占位就什么都不动。
      //
      // P2-14：**归还租约绝不许抛错**。旧实现直接调 engine 方法，而它内部会碰
      // `injectionLeases.forget` / `confirmations.drop`（这两步没有 try/catch）。一旦归还
      // 路径自己抛错，紧邻的下一条语句（`throw error` / `return decision`）就永远不执行：
      // - 在 `next()` 抛错的分支里，原始异常被「归还时的二次异常」**替换**，栈与原因全丢，
      //   排障时看到的是租约层的错，而真正的宿主失败被吞掉；
      // - 在正常分支里，异常会冒到 pre-step 外层，变成「本步整体失败」，而这条路径本应
      //   只是「不注入」。
      // 归还失败本身必须可见（warn），但它不能改变本步的**结论**。
      const release = (reason) => safeReleaseReservation(
        engine, sessionId, turn, reason,
        { reservation: outcome?.reservation ?? null },
        (error) => warn('recall-release-failed', 'memory-context-lab: 归还回注占位失败（不影响本步结论；同回合可能暂时 busy）：'
          + (error?.code ?? 'EINTERNAL') + ' ' + (error instanceof Error ? error.message : String(error))),
      )
      let decision
      try {
        decision = await next()
      } catch (error) {
        // next() 抛错：本步不会进入，消息没有交出去 —— 占位必须归还，否则同回合永久 busy。
        release('next-threw')
        throw error
      }
      // 这一行之后**任何**不追加消息的返回都代表「本步没有呈现」，租约必须还回去：
      // 宿主的 next() 返回 enter 只说明它愿意继续保持会话，不等于消息已落事件。
      if (decision?.kind !== 'enter' || payload?.signal?.aborted) {
        release('not-entered')
        return decision
      }
      if (outcome === null || outcome.status !== 'injected' || typeof outcome.text !== 'string' || outcome.text.length === 0) {
        release(outcome?.status === 'failed' ? 'recall-failed' : 'not-presented')
        if (outcome?.status === 'failed') {
          warn('recall-failed', 'memory-context-lab: 回注失败（本步跳过，原因见 /memory-lab status）：'
            + (outcome.error?.code ?? 'EINTERNAL') + ' ' + (outcome.error?.message ?? ''))
        }
        return decision
      }
      // 消息 ID 用入口给的确定性身份（同一 bodyId → 同一 ID）：宿主提交失败后同轮重试
      // 不会写成「第二份呈现」。宿主已核证保留该 id（P0 宿主合同 §2.9），
      // 确认面只按 data.id + 本插件 recall 来源匹配，不再扫正文。
      const messageId = typeof outcome.messageId === 'string' && outcome.messageId.length > 0
        ? outcome.messageId
        : 'mcl-v3-recall-' + randomUUID()
      // **先登记再过面**：handoff 被拒（容量满 / 非法状态 / 抛错）时，这条消息还**没有**
      // 交给宿主。此时绝不能把它追加进 decision（否则容量拒绝后未登记的消息仍然落面，
      // 之后既无法确认也无法收敛）；只释放自己这次 reserve，让同轮可以重试。
      if (sessionId !== undefined && turn !== null) {
        try {
          const log = Array.isArray(payload?.agent?.session?.log) ? payload.agent.session.log : []
          const lastSeq = log.length > 0 && Number.isSafeInteger(log[log.length - 1]?.seq) ? log[log.length - 1].seq : -1
          const handed = engine.handoffInjection(sessionId, turn, {
            reservation: outcome.reservation ?? null,
            messageId,
            bodyId: typeof outcome.bodyId === 'string' ? outcome.bodyId : null,
            recordIds: outcome.presentedIds ?? [],
            // step 用于负向收敛（step/end 必须精确匹配 turn+step）；seqBase 是登记时的
            // 日志末 seq（宿主只往后追加），确认要求 event.seq 严格大于它。
            step: Number.isInteger(payload?.step) ? payload.step : null,
            seqBase: lastSeq,
          })
          if (handed?.handedOff !== true) {
            release('handoff-rejected')
            warn('recall-handoff-rejected', 'memory-context-lab: 回注交接登记被拒（' + String(handed?.reason) + '），本次不追加消息、已归还占位')
            return decision
          }
        } catch (error) {
          release('handoff-failed')
          warn('recall-handoff-failed', 'memory-context-lab: 回注交接登记异常（本次不追加消息、已归还占位）：'
            + (error?.code ?? 'EINTERNAL') + ' ' + (error instanceof Error ? error.message : String(error)))
          return decision
        }
      }
      return {
        ...decision,
        messages: [...decision.messages, {
          id: messageId,
          source: { kind: PLUGIN_SOURCE_KIND, form: RECALL_SOURCE_FORM, messageId },
          role: 'user',
          // AUD48-08-01：正文套插件来源标记（模型可见），消息本身声明 source.form=recall
          // （机器可读）。role 仍是 user——宿主对 decision.messages 一律按用户消息落库。
          content: [{ type: 'text', text: wrapInjectedPayload('recall', outcome.text) }],
        }],
      }
    }, { prepend: true })
  }

  /**
   * 命令面的生效设置：全局设置 + 本对话覆盖（gate 是唯一会被命令改的归档参数）。
   * pre-step 已经在入口合并过；now/dry-run/compact/status 也必须用同一份，
   * 否则 `set gate 5` 后 status 预览仍按全局 20 判断，命令与钩子各说各话。
   */
  const effectiveSettingsOf = (id) => {
    const settings = settingsNow()
    let control = null
    try { control = engine === null ? null : engine.controlOf(id) } catch { control = null }
    const effective = mergeSessionSettings(settings, control)
    return { ...settings, coolingGate: effective.gate }
  }

  // 命令面（只读观察 + help）。
  if (engine !== null) {
    ctx.commands.register({
      definitionId: COMMAND_DEFINITION_ID,
      name: COMMAND_NAME,
      description: '记忆上下文：本对话开关 / 摄入与回注 / 检索与回读',
      input: { hint: 'status | on|off | inject on|off | set limit <1–20> | unset limit | set gate <0–95> | unset gate | reset | mode <full-history|cooling|recall-only> | planfirst on|off|approve | now | compact | dry-run | history | repair [status|apply] | working-set | export|adopt <文件名>|adopt-from <父ID>|adopt-allow on|off | file-status | verify <ID|all> | restore [序号|all] | pin|unpin <ID> | pins | forget preview|apply|purge|undo|status <ID…> | t2 [backfill [1–2000]|backfill cancel|backfill status|cleanup] | config show | recall <词> | read <ID> | help' },
      handler: async (invocation) => {
        const words = String(invocation?.rawInput ?? '').trim().split(/\s+/).filter(Boolean)
        const sub = (words[0] ?? 'help').toLowerCase()
        const arg = words.slice(1).join(' ')
        const sessionId = invocation?.agent?.session?.id
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
          return fail('拿不到会话 id（invocation.agent.session.id 不是字符串）——命令面不可用。')
        }
        try {
          if (sub === 'status') return ok(await statusText(sessionId, invocation?.agent?.session ?? null))
          if (sub === 't2') {
            const t2Words = words.slice(1).map((word) => word.toLowerCase())
            const action = t2Words[0] ?? ''
            if (action === 'backfill') {
              const arg = t2Words[1] ?? ''
              if (arg === 'cancel') {
                const result = engine.cancelT2Backfill(sessionId)
                return ok(result.cancelled
                  ? '已请求中断回填（批间生效）。用 /memory-lab t2 查看最终状态；已镜像的节点保留。'
                  : '当前没有在跑的回填。')
              }
              if (arg === 'status') return ok(backfillDetail(await engine.t2BackfillState(sessionId)))
              const result = await engine.startT2Backfill(sessionId, arg)
              if (result.error === 'invalid-limit') return fail(result.message)
              if (result.error === 'not-ready') return ok('本会话尚未建库：先发出任意一条消息，再执行回填。')
              if (result.error === 't2-unavailable') {
                return fail('T2 未启用，不能回填：' + result.reason + '。\n不会回退 T1 假装成功——先 /memory-lab on 并用 /memory-lab t2 确认实际后端为 T2。')
              }
              if (result.alreadyRunning === true) {
                return ok('回填已在进行中：计划 ' + result.planned + ' 条；用 /memory-lab t2 查看进度。')
              }
              const mirrorable = result.records?.mirrorable
              const mirrored = result.mirrored?.mirrored
              const pct = percentOf(mirrored, mirrorable)
              if (result.planned === 0) {
                return ok('没有需要回填的记录：可镜像 ' + (Number.isInteger(mirrorable) ? mirrorable + ' 条' : '未知')
                  + ' / 已镜像 ' + (Number.isInteger(mirrored) ? mirrored + ' 条' : '未知')
                  + '（' + (pct ?? '未知') + '）。\n重复执行幂等：同一记录不会产生第二个节点。')
              }
              return ok('已开始回填：计划 ' + result.planned + ' 条（可镜像 ' + (Number.isInteger(mirrorable) ? mirrorable + ' 条' : '未知')
                + ' / 已镜像 ' + (Number.isInteger(mirrored) ? mirrored + ' 条' : '未知') + '，' + (pct ?? '未知') + '）。\n'
                + '后台执行，不阻塞步骤；用 /memory-lab t2 查看进度，/memory-lab t2 backfill cancel 可中断。')
            }
            if (action === 'cleanup') {
              const result = await engine.cleanupSmokeNode(sessionId)
              if (result.error === 'not-ready') return ok('本会话尚未建库：先发出任意一条消息。')
              if (result.error === 't2-unavailable') return fail('T2 未启用：没有可清理的隔离根。')
              if (result.ok === true) return ok('已清理冒烟节点 ' + result.nodeId + '（它本来就不计入覆盖率）。')
              return fail('清理冒烟节点失败：' + (result.error ?? 'unknown'))
            }
            const info = await engine.t2Info(sessionId)
            const state = engine.stateOf(sessionId)
            const lines = []
            if (info.configured) {
              lines.push('T2 隔离后端：已找到 dsh-memory 环境')
              lines.push('包根：' + (info.repoRoot ?? '未知') + '（版本 ' + (info.version || '未知') + '）')
              lines.push('Python：' + (info.python ?? 'python'))
              lines.push('隔离根：' + (info.isolatedRoot ?? '尚未建库（本会话还没启用/还没发消息）'))
            } else {
              lines.push('T2 隔离后端：未找到 dsh-memory 环境（按 T1 运行）')
              lines.push('提示：需要已安装 @furongjun1999/dsh-memory 且其 md_cg/ 可被解析；可用 MEMORY_LAB_T2_REPO 指定包根。')
            }
            const decision = info.decision ?? state.provider ?? null
            lines.push('实际后端：' + (decision?.tier ?? 'T1') + '（' + (decision?.reason ?? '尚未建库') + '）')
            lines.push(coverageLine(info.coverage, info.coverageError))
            for (const line of excludedNodeLines(info.coverage)) lines.push(line)
            if (info.mirror !== null) {
              lines.push('镜像：成功 ' + info.mirror.mirrored + ' / 失败 ' + info.mirror.mirrorFailed
                + ' / 跳过 ' + info.mirror.mirrorDropped + ' / 待写 ' + info.mirror.pending)
              // P2-16：把**最近若干条不同原因**都列出来。旧实现只有一个 lastError 槽：
              // 队列满/审核被拒/未取到 ACCEPT 接连发生时，前因被后因覆盖，用户只看到最后一条。
              const failures = Array.isArray(info.mirror.recentFailures) ? info.mirror.recentFailures : []
              if (failures.length > 0) {
                lines.push('最近镜像错误（新→旧，最多 ' + failures.length + ' 条）：')
                for (const line of [...failures].reverse()) lines.push('　· ' + line)
              } else if (info.mirror.lastError) {
                lines.push('最近镜像错误：' + info.mirror.lastError)
              }
            }
            const progress = backfillLine(info.backfill)
            if (progress !== null) lines.push(progress)
            lines.push('边界：只写隔离根 ' + (info.isolatedRoot ?? '<会话>/t2-mdcg') + '，不写正式灵枢根；T2 失败不阻塞 T1。')
            if (info.active !== true && info.configured) {
              lines.push('未启用原因见上方「实际后端」；新对话默认关闭，先 /memory-lab on。')
            }
            return ok(lines.join('\n'))
          }
          // 会话级控制（composer 弹层走这些命令；设置页仍管全局默认）。
          if (sub === 'on' || sub === 'off') {
            if (sub === 'off') {
              // 停用恢复是**全局设置**，每次 off 都读当前值；state.autoRestore 是旧版
              // 建库时冻结的快照，不能再作为决策依据（设置页关掉后仍恢复原文的根因）。
              let restoreLine = ''
              if (settingsNow().autoRestore !== false) {
                try {
                  // P1-10：`restoreHistory` 用**返回值**表达失败（`{error:'not-ready'}`），不是抛错；
                  // 旧实现只 catch 抛错、再判 `total > 0`（`undefined > 0` 恒 false），于是
                  // 「恢复失败」与「没有可恢复的凭证」在回执上同一个形状——用户以为关掉就自动
                  // 还原了，而原文仍在冷库。这里与 `restore all` 同一口径：先判 `result.error`，
                  // 再把「恢复 N/M」「无凭证」「失败」三结局分开说。
                  const result = await engine.restoreHistory(sessionId)
                  if (result?.error !== undefined) {
                    restoreLine = '\n' + restoreFailureLine(result, null) + '（停用仍生效）'
                  } else if (result.total > 0) {
                    restoreLine = '\n恢复：' + result.restored + '/' + result.total + '；跳过 ' + result.skipped
                      + (result.forgotten > 0 ? '；已遗忘 ' + result.forgotten : '')
                  } else {
                    restoreLine = '\n恢复：没有可恢复的凭证'
                  }
                } catch (error) {
                  restoreLine = '\n恢复失败（停用仍生效）：' + (error?.code ?? error?.message ?? String(error))
                }
              } else {
                // 三结局必须一一对应：关闭恢复时说清楚是「按设置未恢复」，不是「没有可恢复」。
                restoreLine = '\n恢复：按设置未恢复（autoRestore=关）'
              }
              const control = await engine.setControl(sessionId, { enabled: false })
              return ok('本对话已停用。' + restoreLine + '\n' + controlLine(control))
            }
            const control = await engine.setControl(sessionId, { enabled: true })
            return ok('本对话已启用。\n' + controlLine(control))
          }
          if (sub === 'planfirst') {
            const value = (words[1] ?? '').toLowerCase()
            if (value !== 'on' && value !== 'off' && value !== 'approve') return fail('用法：/memory-lab planfirst on|off|approve')
            if (value === 'approve') {
              const session = invocation?.agent?.session
              let nodes = []
              try {
                nodes = await session?.surface?.nodes ?? []
              } catch {
                nodes = []
              }
              // 不用 Math.max(...nodes)：活动面很大时展开参数会 RangeError；
              // 只收整数 seq，非法值忽略（floor 保持 -1 表示不冻结）。
              let floor = -1
              for (const seq of nodes) if (Number.isInteger(seq) && seq > floor) floor = seq
              const state = await engine.setState(sessionId, { planFirst: false, planFloorSeq: floor })
              return ok('计划已批准：冻结计划工件至 seq ' + floor + '，后续步骤恢复归档。\n' + stateLine(state))
            }
            const state = await engine.setState(sessionId, value === 'on'
              ? { planFirst: true, planFloorSeq: null }
              : { planFirst: false })
            return ok('计划先行：' + (state.planFirst ? '开（暂停归档与自动回注）' : '关') + '\n' + stateLine(state))
          }
          if (sub === 'inject') {
            const value = (words[1] ?? '').toLowerCase()
            if (value !== 'on' && value !== 'off') return fail('用法：/memory-lab inject on|off')
            const control = await engine.setControl(sessionId, { recall: value === 'on' })
            return ok('自动回注已' + (value === 'on' ? '开启' : '关闭') + '。\n' + controlLine(control))
          }
          if (sub === 'set' || sub === 'unset') {
            const key = words[1]
            if (!SESSION_OVERRIDE_KEYS.includes(key)) {
              return fail('用法：/memory-lab ' + sub + ' <' + SESSION_OVERRIDE_KEYS.join('|') + '>' + (sub === 'set' ? ' <数值>' : ''))
            }
            if (sub === 'unset') {
              const control = await engine.setControl(sessionId, { overrides: { [key]: null } })
              return ok('已清除 ' + key + ' 的会话覆盖（跟随全局）。\n' + controlLine(control))
            }
            const raw = words[2]
            if (raw === undefined) return fail('用法：/memory-lab set ' + key + ' <数值>')
            const number = parseStrictInteger(raw)
            const bounds = SESSION_OVERRIDE_BOUNDS[key]
            if (number === null || number < bounds.min || number > bounds.max || (bounds.integer === true && !Number.isInteger(number))) {
              return fail(key + ' 必须在 ' + bounds.min + '–' + bounds.max + ' 之间' + (bounds.integer === true ? '（整数）' : '') + '，得到 ' + JSON.stringify(raw))
            }
            const control = await engine.setControl(sessionId, { overrides: { [key]: number } })
            return ok('本对话 ' + key + ' 已设为 ' + number + '。\n' + controlLine(control))
          }
          if (sub === 'reset') {
            const overrides = Object.fromEntries(SESSION_OVERRIDE_KEYS.map((key) => [key, null]))
            const control = await engine.setControl(sessionId, { enabled: true, recall: true, overrides })
            return ok('本对话控制已恢复默认（跟随全局设置）。\n' + controlLine(control))
          }
          if (sub === 'mode') {
            const raw = words[1] ?? ''
            const value = MODE_ALIASES[raw.toLowerCase()] ?? MODE_ALIASES[raw]
            if (value === undefined || !SESSION_MODES.includes(value)) {
              return fail('用法：/memory-lab mode 按轮归档|按步归档|仅回注（内部 id：' + SESSION_MODES.join('|') + '）')
            }
            const state = await engine.setState(sessionId, { mode: value })
            return ok('本对话模式：' + modeLabel(state.mode) + '（' + state.mode + '）\n' + stateLine(state))
          }
          if (sub === 'config') {
            if ((words[1] ?? '').toLowerCase() !== 'show') return fail('用法：/memory-lab config show（全局设置写入在插件设置页）')
            return ok(settingsLine(settingsNow()))
          }
          if (sub === 'now' || sub === 'dry-run') {
            const effectiveSettings = effectiveSettingsOf(sessionId)
            const run = sub === 'now'
              // now 是显式动作：忽略进程内「判负跳过」游标，重试一次队头 span（AUD48-11-01）。
              // 若仍判负，回执会显示 not-worth，而不是把原因掩成 no-completed-group。
              ? await engine.archiveForStep(sessionId, invocation?.agent?.session, effectiveSettings, { resetNotWorth: true })
              : await engine.dryRunArchive(sessionId, invocation?.agent?.session, effectiveSettings)
            return ok(archiveLine(run))
          }
          if (sub === 'compact') {
            const run = await engine.archiveForStep(sessionId, invocation?.agent?.session, effectiveSettingsOf(sessionId), { compact: true })
            return ok(archiveLine(run))
          }
          if (sub === 'history') {
            const history = await engine.historyOf(sessionId)
            if (history.busy === true) return ok('后台建库/摄入进行中，稍后再查。')
            if (history.error !== undefined) return fail('历史凭证不可读：' + (history.error?.code ?? history.error?.message ?? String(history.error)))
            if (!Array.isArray(history.rows) || history.rows.length === 0) return ok('暂无归档凭证。')
            return ok(history.rows.map((row) => '#' + row.index + ' · seq ' + (row.startSeq ?? '?') + '–' + (row.endSeq ?? '?')
              + ' · ' + row.recordIds.length + ' 条 · 回执 ' + row.chars + ' 字'
              + (Number.isInteger(row.restoreChars) ? ' · 恢复 ' + row.restoreChars + ' 字' : '')
              + (row.redacted === true ? ' · 正文已清除' : '')).join('\n'))
          }
          if (sub === 'repair') {
            const mode = (words[1] ?? 'status').toLowerCase()
            if (mode !== 'status' && mode !== 'apply') return fail('用法：/memory-lab repair [status|apply]（status 只报告，apply 锁内截断尾部半行）')
            const result = await engine.repairStore(sessionId, { dryRun: mode !== 'apply' })
            if (result.error === 'not-ready') return fail('本会话尚未建库/打开：先发出任意一条消息，再执行 repair。')
            if (result.error !== undefined) return fail('修复不可用：' + result.error)
            const rows = (result.files ?? []).map((row) => {
              if (row.state === 'ok') return '· ' + row.file + '：正常（' + (row.bytes ?? '?') + ' 字节）'
              if (row.state === 'absent') return '· ' + row.file + '：不存在'
              if (row.state === 'tail-half-line') {
                return '· ' + row.file + '：尾部半行（将截掉 ' + row.removedBytes + ' 字节；保留 ' + row.keptBytes + ' 字节）'
              }
              return '· ' + row.file + '：' + (row.state === 'damaged' ? '损坏（' + (row.reason ?? '') + '，不自动截断）' : '不可读（' + (row.reason ?? '') + '）')
            })
            if (mode === 'status') {
              return ok('日志尾部检查（只读）：\n' + rows.join('\n')
                + (result.changed === false && (result.files ?? []).every((row) => row.state !== 'tail-half-line')
                  ? '\n没有可自动修复的尾部半行。' : '\n执行 /memory-lab repair apply 截断尾部半行（先写审计再改字节）。'))
            }
            const lines = rows.length > 0 ? rows : ['（无日志文件）']
            if (result.changed === true) {
              lines.push('已修复 ' + result.repaired.length + ' 个文件；审计写入 repair-log.jsonl。本会话库已关闭，下一步自动按修复后的状态重开。')
            } else {
              lines.push('没有可修复的尾部半行（中段损坏/完整行损坏不自动截断，仍失败关闭）。')
            }
            return ok('日志尾部修复：\n' + lines.join('\n'))
          }
          if (sub === 'working-set') {
            const result = await engine.workingSet(sessionId)
            if (result.error !== undefined) return fail('工作集不可读：' + result.error)
            if (result.rows.length === 0) return ok('当前回合没有可读工作集记录。')
            return ok('当前回合（起 seq ' + result.startSeq + '）：\n' + result.rows.slice(0, 50).map((row) => '· seq ' + row.seq + ' → ' + row.recordId).join('\n'))
          }
          if (sub === 'export') {
            const result = await engine.exportSession(sessionId)
            if (result.error !== undefined) return fail('导出不可用：' + result.error)
            return ok('已导出 ' + result.counts.records + ' 条正文（遗忘 ' + result.counts.forgotten + ' 条不导出）\n' + result.file)
          }
          if (sub === 'adopt') {
            const file = words[1]
            if (file === undefined) return fail('用法：/memory-lab adopt <exports 文件名>')
            const result = await engine.importSession(sessionId, file, invocation?.agent?.session)
            if (result.error === 'session-not-empty') return fail('目标会话已有记录；适用于新空会话（fork 后）')
            if (result.error !== undefined) return fail('导入不可用：' + result.error)
            return ok('已导入 ' + result.imported + ' 条正文（来源会话 ' + result.sessionKey + '）' + summaryImportNote(result.summaries))
          }
          if (sub === 'adopt-from') {
            const parentId = words[1]
            if (parentId === undefined) return fail('用法：/memory-lab adopt-from <父会话ID>')
            const result = await engine.adoptFrom(sessionId, parentId, invocation?.agent?.session)
            if (result.error === 'same-session') return fail('不能从自身导入')
            if (result.error === 'parent-not-ready') return fail('父会话未在本进程打开：先打开父会话再执行 adopt-from')
            if (result.error === 'session-not-empty') return fail('目标会话已有记录；fork 子会话必须为空')
            if (result.error === 'parent-consent-required') {
              return fail('父会话未授权被复制（默认拒绝）：先在父会话执行 /memory-lab adopt-allow on'
                + (result.reason ? '（当前同意文件不可读：' + result.reason + '）' : ''))
            }
            if (result.error === 'parent-lineage-mismatch') return fail('目标会话的原生 fork 关系与给定父会话不一致：' + String(result.forkParent))
            if (result.error === 'parent-too-large') return fail('父会话记录过多（' + result.count + ' > ' + result.limit + '），拒绝整库复制；请改用导出/导入分包。')
            if (result.error !== undefined) return fail('父记忆导入不可用：' + result.error)
            return ok('已从父会话复制 ' + result.imported + ' 条正文（新 ID/新事务）' + summaryImportNote(result.summaries))
          }
          if (sub === 'adopt-allow') {
            const value = (words[1] ?? '').toLowerCase()
            if (value !== 'on' && value !== 'off') {
              const status = await engine.adoptStatus(sessionId)
              if (status.error !== undefined) return fail('adopt 授权状态不可读：' + status.error)
              return ok('本会话当前' + (status.allow === true ? '**允许**' : '**不允许**') + '被其他空会话 adopt-from'
                + (status.updatedAt === null || status.updatedAt === undefined ? '' : '（最后修改 ' + new Date(status.updatedAt).toISOString() + '）')
                + '\n用法：/memory-lab adopt-allow on|off')
            }
            const result = await engine.setAdoptAllow(sessionId, value === 'on')
            if (result.error !== undefined) return fail('adopt 授权写入失败：' + result.error)
            return ok(result.allow
              ? '已允许其他空会话 adopt-from 本会话记忆。用完建议改回 off。'
              : '已禁止其他空会话 adopt-from 本会话记忆（默认状态）。')
          }
          if (sub === 'file-status') {
            const result = await engine.fileStatus(sessionId)
            if (result.error !== undefined) return fail('文件引用不可读：' + result.error)
            if (result.refs.length === 0) return ok('暂无文件引用（只有读文件类工具调用会产生）。')
            return ok(result.refs.slice(0, 50).map((ref) => '· ' + ref.id + ' · ' + ref.recordId + ' · ' + ref.path + ' · ' + ref.status + (ref.reason ? '（' + ref.reason + '）' : '')).join('\n'))
          }
          if (sub === 'verify') {
            const target = (words[1] ?? '').toLowerCase()
            if (target === '') return fail('用法：/memory-lab verify <引用ID|记录ID|all>')
            const result = target === 'all'
              ? await engine.verifyFiles(sessionId, { all: true })
              : await engine.verifyFiles(sessionId, { id: words[1], recordId: words[1] })
            if (result.error !== undefined) {
              // B3-14（AUD50-06-03）：零引用/引用 ID 不匹配是**空态**不是故障——
              // 与 file-status 的空态口径一致，不再显示「核证不可用」。
              if (result.error === 'no-matching-reference') return ok('暂无文件引用，或引用 ID 与任何记录不匹配。')
              return fail('核证不可用：' + result.error)
            }
            return ok(result.rows.map((row) => row.id + '：' + row.status + (row.reason ? '（' + row.reason + '）' : '')).join('\n'))
          }
          if (sub === 'restore') {
            const raw = (words[1] ?? '').toLowerCase()
            if (raw === '' || raw === 'all') {
              const result = await engine.restoreHistory(sessionId)
              if (result.error !== undefined) return fail('恢复不可用：' + (result.error?.code ?? result.error))
              return ok('恢复：' + result.restored + '/' + result.total + '；跳过 ' + result.skipped
                + (result.forgotten > 0 ? '；已遗忘 ' + result.forgotten : ''))
            }
            const index = parseStrictInteger(raw)
            if (index === null) return fail('用法：/memory-lab restore [序号|all]（序号必须是十进制整数）')
            const result = await engine.restoreHistory(sessionId, { index })
            return result.restored
              ? ok('已恢复凭证 #' + index + '（' + result.chars + ' 字）')
              : fail(restoreFailureLine(result, index))
          }
          if (sub === 'pin' || sub === 'unpin') {
            const ids = words.slice(1)
            if (ids.length === 0) return fail('用法：/memory-lab ' + sub + ' <记录ID…>')
            const result = await engine.pinRecords(sessionId, ids, { remove: sub === 'unpin' })
            if (result.error !== undefined) return fail('pin 不可用：' + result.error)
            if (sub === 'unpin') {
              // B3-16（AUD50-06-05）：按**实际删除数**回报——unpin 不存在的 ID 不能
              // 再说「已取消 1 条」；无匹配给提示（幂等语义显式化）。
              const removed = Number.isInteger(result.removed) ? result.removed : ids.length
              if (removed === 0) return ok('没有匹配的 pin 记录；当前 pin ' + result.pins.length + ' 条。')
              return ok('已取消 pin ' + removed + ' 条' + (removed < ids.length ? '（请求 ' + ids.length + ' 条）' : '')
                + '；当前 pin ' + result.pins.length + ' 条。')
            }
            // P2-15：按**实际新增数**回报（与 unpin 的 removed 对称）。旧实现回报 `ids.length`：
            // 对已 pin 的 ID 再说一次「已 pin N 条」，用户会以为刚刚新增了 N 条（实际 0 条）。
            const added = Number.isInteger(result.added) ? result.added : ids.length
            const unchanged = Number.isInteger(result.unchanged) ? result.unchanged : 0
            if (added === 0 && unchanged > 0) {
              return ok('没有新增 pin（' + unchanged + ' 条此前已 pin）；当前 pin ' + result.pins.length + ' 条。')
            }
            return ok('已 pin ' + added + ' 条' + (added < ids.length ? '（请求 ' + ids.length + ' 条，' + (ids.length - added) + ' 条此前已 pin）' : '')
              + '；当前 pin ' + result.pins.length + ' 条。')
          }
          if (sub === 'pins') {
            const state = engine.stateOf(sessionId)
            const pins = Array.isArray(state.pins) ? state.pins : []
            return ok(pins.length === 0 ? '当前没有 pin 记录。' : pins.map((id) => '· ' + id).join('\n'))
          }
          if (sub === 'forget') {
            const op = (words[1] ?? '').toLowerCase()
            const ids = words.slice(2)
            if (op === 'status') {
              const result = await engine.listForgotten(sessionId)
              if (result.error !== undefined) return fail('遗忘状态不可读：' + result.error)
              return ok(result.ids.length === 0 ? '没有已遗忘记录。' : result.ids.slice(0, 100).map((id) => '· ' + id).join('\n'))
            }
            if (op !== 'preview' && op !== 'apply' && op !== 'undo' && op !== 'purge') return fail('用法：/memory-lab forget preview|apply|purge|undo|status <记录ID…>')
            if (ids.length === 0) return fail('用法：/memory-lab forget ' + op + ' <记录ID…>')
            if (op === 'preview') {
              const result = await engine.forgetPreview(sessionId, ids)
              if (result.error !== undefined) return fail('遗忘预览不可用：' + result.error)
              return ok(result.rows.map((row) => row.id + '：' + row.status).join('\n'))
            }
            const result = await engine.forgetRecords(sessionId, ids, { undo: op === 'undo', purge: op === 'purge' })
            if (result.error === 'purged') return fail('这些记录已被物理清除（forget purge），正文不可恢复，撤销不成立：' + result.ids.join('、'))
            if (result.error !== undefined) return fail('遗忘' + (op === 'undo' ? '撤销' : '') + '不可用：' + result.error)
            const face = op === 'undo' ? result.unredact : result.redact
            const faceLine = face === undefined || face.attempted === 0
              ? ''
              : '\n隐私面：' + face.changed + '/' + face.attempted + ' 段回执已' + (op === 'undo' ? '还原' : '清除')
                + (face.failed.length > 0 ? '；' + face.failed.length + ' 段失败（#' + face.failed.map((row) => row.index + ':' + row.reason).join('、') + '）' : '')
            // H4：三种遗忘语义必须说清楚，不能一句「已遗忘」让人以为正文已删。
            const head = op === 'undo'
              ? '已撤销遗忘 '
              : (op === 'purge'
                ? '已物理清除 ' + (result.purgedCount ?? ids.length) + ' 条（冷库正文与派生物已删除，不可撤销）'
                : '已遗忘 ' + ids.length + ' 条（可见面/检索/回执/导出已清除；冷库正文保留以支持 undo，需要不可恢复请用 forget purge）')
            const derivedLine = op === 'purge' && result.derived !== null && result.derived !== undefined
              ? '\n派生物：摘要清除 ' + (result.derived.summaries?.removed ?? '未知') + ' 条；repair-log 清理 ' + (result.derived.repairLog?.changed ?? '未知') + ' 行'
              : ''
            return ok(head + (op === 'purge' ? '' : '；当前遗忘 ' + result.forgottenCount + ' 条') + '。' + faceLine + derivedLine)
          }
          if (sub === 'recall') {
            if (arg.length === 0) return fail('用法：/memory-lab recall <查询词>')
            const result = await engine.search(sessionId, arg)
            if (result === null) return ok('本会话尚未摄入：先发出任意一条消息触发一次步骤。')
            if (result.busy === true) return ok('后台摄入进行中，稍后再查。')
            const hits = Array.isArray(result.display) ? result.display : []
            if (hits.length === 0) {
              const oov = Array.isArray(result.oovTerms) && result.oovTerms.length > 0 ? result.oovTerms.join('、') : '无'
              return ok('无命中（词表外词：' + oov + '）')
            }
            return ok(hits.slice(0, 10).map(formatHit).join('\n'))
          }
          if (sub === 'read') {
            if (arg.length === 0) return fail('用法：/memory-lab read <记录ID>')
            const record = await engine.read(sessionId, arg)
            if (record === null) return fail('记录不存在或本会话尚未摄入。')
            if (record.busy === true) return ok('后台摄入进行中，稍后再查。')
            const text = typeof record.text === 'string' ? record.text : JSON.stringify(record)
            if (text.length <= READBACK_MAX_CHARS) return ok(text)
            return ok(text.slice(0, READBACK_MAX_CHARS) + '\n…（已截断到 ' + READBACK_MAX_CHARS + ' 字符；命令结果会进入会话日志，本命令不提供分页或续读，超出部分不会显示）')
          }
          return ok(USAGE)
        } catch (error) {
          const code = error?.code ?? 'EINTERNAL'
          const message = error instanceof Error ? error.message : String(error)
          return fail('memory-lab ' + sub + ' 失败：' + code + ' ' + message)
        }
      },
    })
  } else {
    // 引擎缺席时命令面仍需给出可判读的失败，而不是「命令不存在」。
    ctx.commands.register({
      definitionId: COMMAND_DEFINITION_ID,
      name: COMMAND_NAME,
      description: '记忆上下文：v3 引擎未装载（只回报加载失败）',
      input: { hint: 'status | recall <查询词> | read <记录ID> | help' },
      handler: async () => fail('v3 引擎未装载（见加载日志）；命令面不可用。'),
    })
  }

  /** 会话模式/引擎状态摘要。 */
  function stateLine(state) {
    if (state === null || typeof state !== 'object') return '模式未知'
    // AUD51-06-03：轮次判定只在 status 的独立行出现**一次**（旧实现在这里也拼一段，
    // 于是 status 里出现两条「轮次判定」，且第二条没带非法回落提示）。
    const parts = [
      modeLabel(state.mode) + '（' + (state.mode ?? 'unknown') + '）',
      '计划先行 ' + (state.planFirst === true ? '开' : '关'),
      '停用恢复 ' + (settingsNow().autoRestore === false ? '关' : '开'),
    ]
    if (Number.isInteger(state.surface?.lastArchiveEndSeq) && state.surface.lastArchiveEndSeq >= 0) {
      parts.push('上次归档 seq ' + state.surface.lastArchiveEndSeq)
    } else if (Number.isFinite(state.surface?.lastArchiveAt)) {
      parts.push('上次归档（按步）')
    }
    if (Number.isInteger(state.planFloorSeq) && state.planFloorSeq >= 0) parts.push('计划冻结至 seq ' + state.planFloorSeq)
    if (Array.isArray(state.pins) && state.pins.length > 0) parts.push('pin ' + state.pins.length + ' 条')
    const activeLease = Array.isArray(state.readLease) ? state.readLease.filter((row) => Number.isFinite(row?.expiresAt) && row.expiresAt > Date.now()).length : 0
    if (activeLease > 0) parts.push('读租约 ' + activeLease + ' 条')
    if (state.error !== undefined && state.error !== null) parts.push('state 异常 ' + state.error)
    return parts.join('；')
  }


  /** 会话控制摘要（本对话开关 + 覆盖项）。 */
  function controlLine(control) {
    const overrides = control !== null && typeof control === 'object' && control.overrides !== null && typeof control.overrides === 'object'
      ? control.overrides
      : {}
    const keys = Object.keys(overrides)
    const parts = [
      control !== null && control !== undefined && control.enabled === false ? '已停用' : '已启用',
      '回注' + (control !== null && control !== undefined && control.recall === false ? '关' : '开'),
    ]
    parts.push(keys.length > 0
      ? '覆盖 ' + keys.map((key) => key + '=' + overrides[key]).join('、')
      : '覆盖 无（跟随全局设置页）')
    if (control !== null && control !== undefined && control.error) parts.push('控制文件异常 ' + control.error)
    return parts.join('；')
  }

  /** 状态文本：摄入位点、库健康、占用、回注观测（失败不得伪装成「没有样本」）。 */
  async function statusText(sessionId, session = null) {
    const state = await engine.inspect(sessionId)
    if (state === null) {
      const failure = engine.failureOf?.(sessionId) ?? null
      if (failure !== null) {
        // 建库失败 ≠ 尚未摄入：确定性失败（目录不可写、manifest 损坏）旧实现只回
        // 「先发一条消息试试」，用户会一直等一个永远不会出现的库。
        return [
          '建库失败：' + failure.code + ' ' + failure.message,
          '· 已失败 ' + failure.count + ' 次，最后一次 ' + new Date(failure.at).toISOString(),
          '· 这不是「尚未摄入」——请检查数据根可写性与磁盘状态（' + labRoot + '）。',
        ].join('\n')
      }
      const control = engine.controlOf(sessionId)
      const effective = mergeSessionSettings(settingsNow(), control)
      const lines = [
        '本会话尚未摄入：先发出任意一条消息触发一次步骤，影子库会在后台建库。',
        '· 本对话：' + controlLine(control),
        '· 模式：' + stateLine(engine.stateOf(sessionId)),
        '· 生效回注设置：' + settingsLine(effective),
        '· 固定工具：' + toolRegistrationLine(memoryContextToolsRegistration(ctx)),
        // 计数必须取**本会话**：engine.stats().injection 是跨会话聚合，未摄入的新会话
        // 会把别的会话的「尝试 1 次 / 上次结局 injected」当成自己的观测（审计 F-A）。
        '· 回注：' + injectionLine(engine.statusOf(sessionId)),
      ]
      // 只认设置页开关（H7）：环境变量后门已移除——它能绕过设置页强制打开诊断，
      // 使「诊断只在显式开启时运行」不再是硬保证。runtime 未就绪时由诊断函数给出提示。
      const diagnosticsEnabled = settingsNow().offlineDiagnostics === true
      if (diagnosticsEnabled) lines.push(...offlineDiagnosticsLines(engine.diagnosticsOf?.(sessionId), diagnosticsEnabled))
      return lines.join('\n')
    }
    const control = state.control ?? engine.controlOf(sessionId)
    const effective = mergeSessionSettings(settingsNow(), control)
    // 覆盖口径（P0）：N = 已提交记录数，M = 词法索引的可检索文档数。
    // 两者不是一回事：metadata-only 记录可对账、可回读，但不进全文索引。
    const ingestedCount = Number.isInteger(state.records)
      ? state.records
      : (Number.isInteger(state.coverage?.records?.total) ? state.coverage.records.total : null)
    const searchableCount = state.searchable?.state === 'ok' && Number.isInteger(state.searchable.indexedCount)
      ? state.searchable.indexedCount
      : null
    const searchableReason = state.searchable?.state === 'absent'
      ? '索引尚未生成'
      : (state.searchable?.code ?? state.searchable?.reason ?? state.searchable?.state ?? '索引不可读')
    const metaOnly = state.coverage?.records?.metaOnly
    const metaPart = Number.isInteger(metaOnly) ? '（其中仅元数据 ' + metaOnly + ' 条不进索引）' : ''
    const lifecycle = engine.stateOf(sessionId)
    // F-C：先算一次「下一次归档」预览，闸门行与预览行共用同一组事实（同一时刻）。
    let preview = null
    let previewError = null
    if (session !== null) {
      try {
        preview = await engine.dryRunArchive(sessionId, session, effectiveSettingsOf(sessionId))
      } catch (error) {
        previewError = error
      }
    }
    const gateFacts = preview !== null && Number.isFinite(preview.occupancy) && Number.isFinite(preview.gate)
      ? { occupancy: preview.occupancy, gate: preview.gate, opened: preview.status !== 'cooling-closed', stale: false }
      : {
        occupancy: typeof lifecycle.cooling?.lastOccupancy === 'number' ? lifecycle.cooling.lastOccupancy : null,
        gate: effective.gate,
        opened: lifecycle.cooling?.open === true,
        stale: true,
      }
    const lines = [
      '会话：' + sessionId,
      '· 摄入位点：lastSeq ' + state.lastSeq + (state.ingesting ? '（后台摄入进行中）' : ''),
      '· 覆盖：已摄入 ' + (ingestedCount === null ? '未知' : ingestedCount)
        + ' · 可检索 ' + (searchableCount === null ? '未知（' + searchableReason + '）' : searchableCount + ' 条')
        + metaPart,
      // AUD50-02-03（B2-1）：坏事件不再静默——拒绝计数在 status 可见（不重放，详见日志）。
      ...(Number.isInteger(state.rejectedEvents) && state.rejectedEvents > 0
        ? ['· 摄入拒绝：' + state.rejectedEvents + ' 条事件无法入库（已跳过不重放；详见日志）']
        : []),
      '· 库健康：' + (state.health?.healthy === true ? '正常' : '异常（' + JSON.stringify(state.health) + '）'),
      ...(state.health?.healthy === true ? [] : ['· 修复：/memory-lab repair status 检查日志尾部半行（apply 锁内截断，先写审计）']),
      // P3-02：「有行但全坏」不再与「没有样本」同形——坏行数必须在观察面可见，
      // 否则账本读不出东西时状态面仍显示「暂无样本」（H-48 类盲区）。
      '· 占用：' + (state.usageError
        ? '读取失败（' + state.usageError + '），这不是「没有样本」'
        : state.usage === null || state.usage === undefined
          ? '暂无样本'
          : state.usage.samples > 0
            ? '样本 ' + state.usage.samples + '，p50 ' + (state.usage.occupancy?.p50 ?? '-')
              + (state.usage.badLines > 0 ? '；另有 ' + state.usage.badLines + ' 行无法解析（已跳过）' : '')
            : '账本有 ' + state.usage.badLines + ' 行但全部无法解析（未取到任何样本）'),
      '· 本对话：' + controlLine(control),
      '· 模式：' + stateLine(lifecycle),
      ...(lifecycle.mode === 'full-history' ? ['· 轮次判定：' + turnBasisLabel(settingsNow().turnBasis)
        + '（设置页可切换；DSH 轮次把目标自动继续的每一轮也算一轮）'] : []),
      ...(lifecycle.mode === 'cooling' ? ['· 按步归档闸门：' + gateFacts.gate + '%（' + (gateFacts.opened ? '已开闸' : '未开闸')
        + (typeof gateFacts.occupancy === 'number' ? '；占用 ' + Math.round(gateFacts.occupancy * 100) + '%' : '；占用未知')
        + (gateFacts.stale ? '；来自上一步记录' : '；与「下一次归档」同一时刻')
        + '；0% = 每步都判断）'] : []),
      // 按轮归档模式下「轮次判定」已由上面那条独立行承担（带非法回落提示）；本行省略同一段，
      // 否则同一份 status 会给出两条轮次判定（AUD51-06-03）。
      '· 生效回注设置：' + settingsLine(effective, { omitTurnBasis: lifecycle.mode === 'full-history' }),
      '· 固定工具：' + toolRegistrationLine(memoryContextToolsRegistration(ctx)),
      '· 回注：' + injectionLine(state.injection),
    ]
    // 下一次归档预览（只读）：直接回答「为什么没在压缩」——
    // 归档只在**完成回合**上发生，当前回合永远留在面上。
    if (session !== null) {
      lines.push('· 下一次归档：' + (previewError !== null
        ? '预览失败（' + (previewError?.code ?? 'EINTERNAL') + '）'
        : archiveLine(preview)))
    }
    // 只认设置页开关（H7）：环境变量后门已移除；诊断关闭时诊断函数自身也会拒绝执行。
    const diagnosticsEnabled = settingsNow().offlineDiagnostics === true
    if (diagnosticsEnabled) {
      lines.push(...offlineDiagnosticsLines(engine.diagnosticsOf?.(sessionId), diagnosticsEnabled))
    }
    return lines.join('\n')
  }
}
