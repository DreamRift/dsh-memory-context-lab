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
import { createStatusProjectionDefinition } from './v3/adapters/host/status-projection.mjs'
import { probeDshMemory } from './v3/adapters/host/dsh-memory-probe.mjs'
import { resolveT2Isolated } from './v3/adapters/host/t2-environment.mjs'
import { labRootFor } from './storage.mjs'
import { PLUGIN_SOURCE_KIND, RECALL_SOURCE_FORM } from './v3/contracts/sources.mjs'
import { userInputTextOf } from './v3/domain/session/user-input.mjs'
import { SESSION_OVERRIDE_BOUNDS, SESSION_OVERRIDE_KEYS, mergeSessionSettings } from './v3/domain/session/session-control.mjs'
import { parseStrictInteger } from './v3/domain/session/number-input.mjs'
import { SESSION_MODES } from './v3/domain/session/mode.mjs'

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
 * 按轮归档的轮次判定（0.14.0-beta.47）：
 * - human（默认）：真人 user/message 才算新回合；DSH 目标自动继续不产生新回合，
 *   所以一条真人指令下的 10 次自动继续都属于同一个「当前回合」，永远压不到。
 * - dsh：按界面上的「N 轮」计数（turn/start / step/start 的 data.turn）；目标自动
 *   继续也会开新轮，上一轮因此成为已完成。回执/恢复/安全边界两种判定完全一致。
 */
const TURN_BASIS_LABELS = Object.freeze({ human: '真人消息（默认）', dsh: 'DSH 轮次' })
function turnBasisLabel(value) {
  return value === 'dsh' ? TURN_BASIS_LABELS.dsh : TURN_BASIS_LABELS.human
}

function modeLabel(mode) {
  return MODE_LABELS[mode] ?? String(mode)
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
  turnBasis: Schema.string().default('human').description('按轮归档的轮次判定：human = 真人消息（默认）；dsh = 按 DSH 界面显示的轮数（目标自动继续每轮都算，压得更快）').volatile(),
  planFirst: Schema.boolean().default(false).description('计划先行默认值：计划期间暂停归档与自动回注').volatile(),
  coolingGate: Schema.number().default(20).min(0).max(95).step(1).description('按步归档闸门：上下文占用达到该百分比才压缩旧步骤（0 = 每步都判断）').volatile(),
  autoRestore: Schema.boolean().default(true).description('停用/手动恢复时是否把回执恢复为原文').volatile(),
})

/** 配置默认值：与 Config 的 default 保持一致，用于「配置缺失/非法时回落」。 */
export const SETTINGS_DEFAULTS = Object.freeze({
  enabled: true,
  limit: 10,
  packMinScore: 0.5,
  previewChars: 160,
  queryMaxChars: 512,
  fullHistory: true,
  turnBasis: 'human',
  planFirst: false,
  autoRestore: true,
  coolingGate: 20,
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
  return {
    enabled: pick('enabled', SETTINGS_DEFAULTS.enabled, (v) => typeof v === 'boolean'),
    limit: pick('limit', SETTINGS_DEFAULTS.limit, (v) => Number.isInteger(v) && v >= 1),
    packMinScore: pick('packMinScore', SETTINGS_DEFAULTS.packMinScore, (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0),
    previewChars: pick('previewChars', SETTINGS_DEFAULTS.previewChars, (v) => Number.isInteger(v) && v >= 0),
    queryMaxChars: pick('queryMaxChars', SETTINGS_DEFAULTS.queryMaxChars, (v) => Number.isInteger(v) && v >= 1),
    fullHistory: pick('fullHistory', SETTINGS_DEFAULTS.fullHistory, (v) => typeof v === 'boolean'),
    // 只认两个值：设置页给的是下拉框，但配置文件可以手改；未知值一律回落默认（失败关闭）。
    turnBasis: pick('turnBasis', SETTINGS_DEFAULTS.turnBasis, (v) => v === 'human' || v === 'dsh'),
    planFirst: pick('planFirst', SETTINGS_DEFAULTS.planFirst, (v) => typeof v === 'boolean'),
    autoRestore: pick('autoRestore', SETTINGS_DEFAULTS.autoRestore, (v) => typeof v === 'boolean'),
    coolingGate: pick('coolingGate', SETTINGS_DEFAULTS.coolingGate, (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 95),
  }
}

/** 命令名（宿主校验 /^[a-z][a-z0-9_-]*$/u）。 */
const COMMAND_NAME = 'memory-lab'
/** 命令定义标识：沿用 v2 的值，避免面板/路由按 definitionId 归组时漂移。 */
const COMMAND_DEFINITION_ID = 'dsh-memory-context-lab/control'
/** read 输出上界：命令结果会落进 command/done 会话事件，整篇原文不得原样写进日志。 */
const READ_MAX_CHARS = 8000
/** 告警限流窗口：每步都 warn 会刷屏，刷屏的告警等于没有告警。 */
const WARN_INTERVAL_MS = 60_000

const USAGE = [
  '用法：/memory-lab status —— 本会话摄入位点、库健康、会话控制与回注观测',
  '　　　/memory-lab recall <查询词> —— 检索影子库，命中带分数与回读句柄',
  '　　　/memory-lab read <记录ID> —— 精确回读原文（有上界）',
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
  '　　　/memory-lab export|adopt <文件名>|adopt-from <父ID> —— 导出/导入/父记忆复制',
  '　　　/memory-lab file-status、verify <ID|all> —— 文件引用与核证',
  '　　　/memory-lab restore [序号|all] —— 恢复回执为原文',
  '　　　/memory-lab pin|unpin <记录ID>、pins —— 保护/取消保护记录',
  '　　　/memory-lab forget preview|apply|undo|status <记录ID…> —— 遗忘/撤销',
  '　　　/memory-lab t2 [backfill [1–2000]|backfill cancel|backfill status|cleanup] —— T2 诊断/覆盖率/显式回填',
  '　　　/memory-lab config show —— 查全局默认（写入在插件设置页）',
  '　　　/memory-lab help —— 本清单',
  '全局默认：设置 → 插件 → 记忆上下文（开关 / 轮次判定 / 条数 / 装包阈 / 首部长度 / 查询上限）',
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

export async function apply(ctx, config) {
  // 配置经 Config schema 校验后由宿主传入；volatile 字段是引用包装，必须每次解包（见 readSettings）。
  const settingsNow = () => readSettings(config)
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
      try { engine.dispose() } catch {}
    }, 'memory-context-lab: v3 engine')
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
      // 归档失败/忙只告警，不阻塞用户回合；当前回合与保护集由 engine 内部排除。
      if (typeof sessionId === 'string' && sessionId.length > 0 && control?.enabled !== false) {
        try {
          // 闸门可以按本对话覆盖（/memory-lab set gate N）：effective 已合并控制文件。
          // turn 只用于「DSH 轮次」判定：当前轮刚开、活动面还没有它的节点时，
          // 也能把上一轮判为已完成（否则会晚一轮才压）。
          await engine.archiveForStep(sessionId, payload?.agent?.session, { ...settings, coolingGate: effective.gate }, { turn: payload?.turn })
        } catch (error) {
          warn('archive-failed', 'memory-context-lab: 归档评估异常（本步跳过）：'
            + (error?.code ?? 'EINTERNAL') + ' ' + (error instanceof Error ? error.message : String(error)))
        }
      }
      if (effective.enabled && planPaused !== true && typeof sessionId === 'string' && sessionId.length > 0) {
        try {
          const query = userInputTextOf(payload?.messages)
          if (query.length > 0) {
            outcome = await engine.recallForInjection(sessionId, query, {
              turn: payload?.turn,
              limit: effective.limit,
              packMinScore: effective.packMinScore,
              previewChars: effective.previewChars,
              queryMaxChars: effective.queryMaxChars,
            })
          }
        } catch (error) {
          warn('pre-step-failed', 'memory-context-lab: 回注取数异常（本步跳过）：'
            + (error?.code ?? 'EINTERNAL') + ' ' + (error instanceof Error ? error.message : String(error)))
        }
      }
      const decision = await next()
      if (decision?.kind !== 'enter' || payload?.signal?.aborted) return decision
      if (outcome === null) return decision
      if (outcome.status === 'failed') {
        warn('recall-failed', 'memory-context-lab: 回注失败（本步跳过，原因见 /memory-lab status）：'
          + (outcome.error?.code ?? 'EINTERNAL') + ' ' + (outcome.error?.message ?? ''))
        return decision
      }
      if (outcome.status !== 'injected' || typeof outcome.text !== 'string' || outcome.text.length === 0) return decision
      return {
        ...decision,
        messages: [...decision.messages, {
          id: 'mcl-v3-recall-' + randomUUID(),
          role: 'user',
          content: [{ type: 'text', text: outcome.text }],
          source: { kind: PLUGIN_SOURCE_KIND, form: RECALL_SOURCE_FORM },
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
      input: { hint: 'status | on|off | inject on|off | set limit <1–20> | unset limit | reset | mode <full-history|cooling|recall-only> | planfirst on|off|approve | now | compact | dry-run | history | repair [status|apply] | working-set | export|adopt <文件名>|adopt-from <父ID> | file-status | verify <ID|all> | restore [序号|all] | pin|unpin <ID> | pins | forget preview|apply|undo|status <ID…> | t2 [backfill [1–2000]|backfill cancel|backfill status|cleanup] | config show | recall <词> | read <ID> | help' },
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
              if (info.mirror.lastError) lines.push('最近镜像错误：' + info.mirror.lastError)
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
                  const result = await engine.restoreHistory(sessionId, { maxChars: 16000 })
                  if (result.total > 0) restoreLine = '\n恢复：' + result.restored + '/' + result.total + '；跳过 ' + result.skipped
                    + (result.forgotten > 0 ? '；已遗忘 ' + result.forgotten : '')
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
              + ' · ' + row.recordIds.length + ' 条 · 回执 ' + row.chars + ' 字' + (row.redacted === true ? ' · 正文已清除' : '')).join('\n'))
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
            return ok('已导入 ' + result.imported + ' 条正文（来源会话 ' + result.sessionKey + '）')
          }
          if (sub === 'adopt-from') {
            const parentId = words[1]
            if (parentId === undefined) return fail('用法：/memory-lab adopt-from <父会话ID>')
            const result = await engine.adoptFrom(sessionId, parentId, invocation?.agent?.session)
            if (result.error === 'same-session') return fail('不能从自身导入')
            if (result.error === 'parent-not-ready') return fail('父会话未在本进程打开：先打开父会话再执行 adopt-from')
            if (result.error === 'session-not-empty') return fail('目标会话已有记录；fork 子会话必须为空')
            if (result.error !== undefined) return fail('父记忆导入不可用：' + result.error)
            return ok('已从父会话复制 ' + result.imported + ' 条正文（新 ID/新事务）')
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
            if (result.error !== undefined) return fail('核证不可用：' + result.error)
            return ok(result.rows.map((row) => row.id + '：' + row.status + (row.reason ? '（' + row.reason + '）' : '')).join('\n'))
          }
          if (sub === 'restore') {
            const raw = (words[1] ?? '').toLowerCase()
            if (raw === '' || raw === 'all') {
              const result = await engine.restoreHistory(sessionId, { maxChars: 16000 })
              if (result.error !== undefined) return fail('恢复不可用：' + (result.error?.code ?? result.error))
              return ok('恢复：' + result.restored + '/' + result.total + '；跳过 ' + result.skipped
                + (result.forgotten > 0 ? '；已遗忘 ' + result.forgotten : ''))
            }
            const index = parseStrictInteger(raw)
            if (index === null) return fail('用法：/memory-lab restore [序号|all]（序号必须是十进制整数）')
            const result = await engine.restoreHistory(sessionId, { index, maxChars: 16000 })
            return result.restored
              ? ok('已恢复凭证 #' + index + '（' + result.chars + ' 字）')
              : fail('未恢复凭证 #' + index + '：' + (result.reason ?? 'unknown'))
          }
          if (sub === 'pin' || sub === 'unpin') {
            const ids = words.slice(1)
            if (ids.length === 0) return fail('用法：/memory-lab ' + sub + ' <记录ID…>')
            const result = await engine.pinRecords(sessionId, ids, { remove: sub === 'unpin' })
            if (result.error !== undefined) return fail('pin 不可用：' + result.error)
            return ok((sub === 'pin' ? '已 pin ' : '已取消 pin ') + ids.length + ' 条；当前 pin ' + result.pins.length + ' 条。')
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
            if (op !== 'preview' && op !== 'apply' && op !== 'undo') return fail('用法：/memory-lab forget preview|apply|undo|status <记录ID…>')
            if (ids.length === 0) return fail('用法：/memory-lab forget ' + op + ' <记录ID…>')
            if (op === 'preview') {
              const result = await engine.forgetPreview(sessionId, ids)
              if (result.error !== undefined) return fail('遗忘预览不可用：' + result.error)
              return ok(result.rows.map((row) => row.id + '：' + row.status).join('\n'))
            }
            const result = await engine.forgetRecords(sessionId, ids, { undo: op === 'undo' })
            if (result.error !== undefined) return fail('遗忘' + (op === 'undo' ? '撤销' : '') + '不可用：' + result.error)
            const face = op === 'undo' ? result.unredact : result.redact
            const faceLine = face === undefined || face.attempted === 0
              ? ''
              : '\n隐私面：' + face.changed + '/' + face.attempted + ' 段回执已' + (op === 'undo' ? '还原' : '清除')
                + (face.failed.length > 0 ? '；' + face.failed.length + ' 段不可定位（#' + face.failed.map((row) => row.index + ':' + row.reason).join('、') + '）' : '')
            return ok((op === 'undo' ? '已撤销遗忘 ' : '已遗忘 ') + ids.length + ' 条；当前遗忘 ' + result.forgottenCount + ' 条。' + faceLine)
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
            if (text.length <= READ_MAX_CHARS) return ok(text)
            return ok(text.slice(0, READ_MAX_CHARS) + '\n…（已截断到 ' + READ_MAX_CHARS + ' 字符；命令结果会进入会话日志，完整正文请按 ID 走工具回读）')
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

  /** 设置摘要（命令面也能看到当前生效值，不必去设置页猜）。 */
  function settingsLine(settings) {
    return (settings.enabled ? '开启' : '已关闭')
      + '；条数 ' + settings.limit
      + '；装包阈 ' + settings.packMinScore
      + '；首部 ' + settings.previewChars
      + ' 字符；查询上限 ' + settings.queryMaxChars + ' 字符'
      + '；全历史默认 ' + (settings.fullHistory === false ? '关' : '开')
      + '；轮次判定 ' + turnBasisLabel(settings.turnBasis)
      + '；计划先行默认 ' + (settings.planFirst === true ? '开' : '关')
      // 合并后的设置里字段名是 gate；直接读 coolingGate 会恒回落 20%，把会话覆盖显示错（AUD-04）。
      + '；按步闸门 ' + (Number.isFinite(settings.gate) ? settings.gate
        : (Number.isFinite(settings.coolingGate) ? settings.coolingGate : 20)) + '%'
      + '；停用恢复 ' + (settings.autoRestore === false ? '关' : '开')
  }

  /** 会话模式/引擎状态摘要。 */
  function stateLine(state) {
    if (state === null || typeof state !== 'object') return '模式未知'
    const parts = [
      modeLabel(state.mode) + '（' + (state.mode ?? 'unknown') + '）',
      ...(state.mode === 'full-history' ? ['轮次判定 ' + turnBasisLabel(settingsNow().turnBasis)] : []),
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

  /**
   * 归档选择器拒绝原因 → 中文说明（0.14.0-beta.45，AUD-09 附带项）。
   * 选择器只给机器码，这里只做展示；未知码原样印出，不吞掉新原因。
   */
  const ARCHIVE_REASON_LABELS = Object.freeze({
    'recall-only': '仅回注模式不归档',
    'no-completed-group': '只有当前回合（当前回合永不归档）',
    'no-completed-step': '没有完整步骤',
    'retention-window': '候选都在工作集保留范围内',
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
  function archiveLine(result) {
    if (result === null || typeof result !== 'object') return '归档：无结果'
    if (result.status === 'archived') {
      return '已归档 seq ' + result.startSeq + '–' + result.endSeq + '（' + result.recordIds.length + ' 条，回执 seq ' + result.receiptSeq + '）'
    }
    if (result.status === 'planned') return '候选：seq ' + result.startSeq + '–' + result.endSeq + '（' + result.recordIds.length + ' 条；dry-run 未写入）'
    if (result.status === 'not-worth') return '不归档：回执 ' + result.receiptChars + ' 字 ≥ 原文 ' + result.sourceChars + ' 字（净收益为负）'
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
    if (result.status === 'busy-or-not-ready') return '建库/摄入进行中，稍后再试。'
    if (result.status === 'not-ready') return '本会话尚未摄入或建库未完成。'
    if (result.status === 'host-no-surface' || result.status === 'no-surface') return '宿主未提供活动面，归档不可用。'
    if (result.status === 'failed') return '归档失败（' + (result.phase ?? 'unknown') + '）：' + (result.error?.code ?? result.error?.message ?? String(result.error))
    return '归档：' + result.status
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
      return [
        '本会话尚未摄入：先发出任意一条消息触发一次步骤，影子库会在后台建库。',
        '· 本对话：' + controlLine(control),
        '· 模式：' + stateLine(engine.stateOf(sessionId)),
        '· 生效回注设置：' + settingsLine(effective),
        // 计数必须取**本会话**：engine.stats().injection 是跨会话聚合，未摄入的新会话
        // 会把别的会话的「尝试 1 次 / 上次结局 injected」当成自己的观测（审计 F-A）。
        '· 回注：' + injectionLine(engine.statusOf(sessionId)),
      ].join('\n')
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
      '· 库健康：' + (state.health?.healthy === true ? '正常' : '异常（' + JSON.stringify(state.health) + '）'),
      ...(state.health?.healthy === true ? [] : ['· 修复：/memory-lab repair status 检查日志尾部半行（apply 锁内截断，先写审计）']),
      '· 占用：' + (state.usageError
        ? '读取失败（' + state.usageError + '），这不是「没有样本」'
        : state.usage
          ? '样本 ' + state.usage.samples + '，p50 ' + (state.usage.occupancy?.p50 ?? '-')
          : '暂无样本'),
      '· 本对话：' + controlLine(control),
      '· 模式：' + stateLine(lifecycle),
      ...(lifecycle.mode === 'full-history' ? ['· 轮次判定：' + turnBasisLabel(settingsNow().turnBasis)
        + '（设置页可切换；DSH 轮次把目标自动继续的每一轮也算一轮）'] : []),
      ...(lifecycle.mode === 'cooling' ? ['· 按步归档闸门：' + gateFacts.gate + '%（' + (gateFacts.opened ? '已开闸' : '未开闸')
        + (typeof gateFacts.occupancy === 'number' ? '；占用 ' + Math.round(gateFacts.occupancy * 100) + '%' : '；占用未知')
        + (gateFacts.stale ? '；来自上一步记录' : '；与「下一次归档」同一时刻')
        + '；0% = 每步都判断）'] : []),
      '· 生效回注设置：' + settingsLine(effective),
      '· 回注：' + injectionLine(state.injection),
    ]
    // 下一次归档预览（只读）：直接回答「为什么没在压缩」——
    // 归档只在**完成回合**上发生，当前回合永远留在面上。
    if (session !== null) {
      lines.push('· 下一次归档：' + (previewError !== null
        ? '预览失败（' + (previewError?.code ?? 'EINTERNAL') + '）'
        : archiveLine(preview)))
    }
    return lines.join('\n')
  }
}
