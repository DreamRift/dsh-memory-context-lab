/**
 * 活跃证据保护（active evidence protection）。
 *
 * 这一层要守住的核心区分：
 *
 *   工具调用已返回 ≠ 模型已看过结果 ≠ 当前工作不再需要结果。
 *
 * 历史年龄（离开保留窗口、攒够批量阈值）只能决定候选顺序，不能单独证明
 * 一段证据可以退出模型可见投影。因此候选在被 `planCooling` 接受之前，先经过
 * 本模块的可解释判定：**可归档 = 原有结构与冷存检查通过 ∧ 不在近期保留窗口
 * ∧ 不存在未闭合调用／在途动作依赖 ∧ 已满足可靠的主模型曝光条件 ∧ 不是当前
 * 仍需保留的证据 ∧ 满足批量提交要求**。
 *
 * 两条纪律贯穿全文：
 *
 * 1. **硬保护只来自真实结构与宿主状态**：未闭合调用、未曝光结果、待确认副作用、
 *    运行中的后台 job 关键引用、系统／开发者指令与当前人类约束。这些不依赖任何
 *    语义猜测，也不需要额外模型调用。
 * 2. **软保留必须可预算、可到期、可复核**：任务关联、最近回读、显式 pin 之外的
 *    弱信号只做短期保留，受 token 预算约束，到期即释放；预算不足时先释放最弱的
 *    软保护，**绝不**拿硬保护去凑预算。
 *
 * 能力边界（明确声明，不伪造自动理解）：本模块**不能**判断"这段历史是否仍然是
 * 当前任务所需"。它只使用可核验的确定性信号。路径／标识符相同只能作为**关联
 * 线索**，不能证明语义依赖或版本相同——因此 `task-link` 永远是软保护，理由里
 * 必须写明这一点。
 *
 * 保护条目绑定证据修订（`evidenceHash`）：正文变了，旧保护不再冒充新保护，
 * 条目被标记 `stale` 并如实报告，而不是继续沿用它的权威。
 */

import { archiveMac, canonicalHash } from './apply.mjs'

/** 保护强度：硬保护不可被预算或到期解除；软保留可调整。 */
export const PROTECTION_STRENGTH = Object.freeze({ HARD: 'hard', SOFT: 'soft' })

/** 保护来源。每个来源都必须能指向一条真实结构或宿主状态。 */
export const PROTECTION_SOURCE = Object.freeze({
  INSTRUCTION: 'instruction',
  STRUCTURE: 'structure',
  EXPOSURE: 'exposure',
  BACKGROUND_JOB: 'background-job',
  PENDING_EFFECT: 'pending-effect',
  RECALL: 'recall',
  PIN: 'pin',
  TASK_LINK: 'task-link',
  COLD_DEPENDENCY: 'cold-dependency',
})

export const PROTECTION_SOURCE_LABEL = Object.freeze({
  [PROTECTION_SOURCE.INSTRUCTION]: '指令与人类约束',
  [PROTECTION_SOURCE.STRUCTURE]: '结构完整性',
  [PROTECTION_SOURCE.EXPOSURE]: '曝光证据',
  [PROTECTION_SOURCE.BACKGROUND_JOB]: '后台任务引用',
  [PROTECTION_SOURCE.PENDING_EFFECT]: '待确认副作用',
  [PROTECTION_SOURCE.RECALL]: '召回临时保护',
  [PROTECTION_SOURCE.PIN]: '显式 pin',
  [PROTECTION_SOURCE.TASK_LINK]: '任务关联线索',
  [PROTECTION_SOURCE.COLD_DEPENDENCY]: '冷库依赖',
})

/** 软保护默认预算（估算 token）。硬保护不计入预算，但必须如实报告成本。 */
export const DEFAULT_SOFT_PROTECTION_BUDGET_TOKENS = 32768
/** 召回结果临时保护：再过这么多个操作后释放。 */
export const DEFAULT_RECALL_PROTECTION_OPERATIONS = 3
/** 任务关联线索的保留长度：线索很弱，只挡很短一程。 */
export const DEFAULT_TASK_LINK_PROTECTION_OPERATIONS = 2
/** 显式 pin 的上限，避免软性无限堆积；超出即报告并拒绝新增。 */
export const MAX_PINNED_RANGES = 32
/** 软保护的兜底寿命（毫秒）：即便操作计数不前进，软保护也会到期。 */
export const DEFAULT_SOFT_PROTECTION_TTL_MS = 24 * 60 * 60 * 1000

/** 保护判定返回码，供 `planCooling` 原样写入 `rejected`。 */
export const PROTECTION_CODES = Object.freeze({
  PROTECTED: 'protected-evidence',
  OVERLAP: 'protected-range-overlap',
  /** 证据修订已变化：不作为拦截码，而是释放原因码（见 `#releaseStale`）。 */
  STALE: 'stale-protection',
})

/** 证据修订已变化时的统一释放原因。 */
const STALE_RELEASE_REASON = '证据修订已变化：旧保护不再冒充新验证，按失效释放'

/** 结构性跳过原因里，哪些属于**硬保护**而不是"不合格"。 */
const HARD_SKIP_REASONS = Object.freeze({
  'protected-system-head': { source: PROTECTION_SOURCE.INSTRUCTION, reason: '系统指令节点', release: 'manual' },
  'protected-latest-user': { source: PROTECTION_SOURCE.INSTRUCTION, reason: '当前人类约束（最新用户消息）', release: 'manual' },
  'protected-plan-artifact': { source: PROTECTION_SOURCE.INSTRUCTION, reason: '计划工件（exit_plan_mode 调用与计划全文）全程保留', release: 'manual' },
  'not-yet-exposed': { source: PROTECTION_SOURCE.EXPOSURE, reason: '结果尚未被任何后续助手消息确认曝光', release: 'next-assistant-message' },
  unpaired: { source: PROTECTION_SOURCE.STRUCTURE, reason: '调用未闭合：结果缺失或未按序配对', release: 'on-pairing' },
  'no-call-id': { source: PROTECTION_SOURCE.STRUCTURE, reason: '调用缺少可配对的 callId，无法证明调用已闭合', release: 'on-pairing' },
  'not-an-operation': { source: PROTECTION_SOURCE.STRUCTURE, reason: '调用信息不完整，不能证明这是一个已闭合的操作', release: 'on-pairing' },
  'failed-result': { source: PROTECTION_SOURCE.STRUCTURE, reason: '工具结果失败：错误证据仍需保留', release: 'manual' },
})

/** 结构性跳过原因里，哪些只是"不合格"，不构成保护。 */
const NON_PROTECTIVE_SKIP_REASONS = new Set([
  'already-archived',
  'assistant-not-eligible',
  'no-content',
  'non-text-content',
  'too-short',
  'too-large',
  'below-min-release',
])

/**
 * 后台 job 标识：只认显式的 `job_id`／`jobId`／`job id` 形态。
 *
 * id 字符集包含 CJK：蜂巢的 job id 形如 `h_<身份>_<任务>_<单元>_<编号>`，单元名是
 * 中文。旧字符集只吃到第一个中文字符就截断（`h_zcode端…` → `h_zcode`），虽然子串
 * 匹配仍能碰巧找到终态，但报告里显示的 id 是错的——保护理由必须能被人工核对。
 */
const JOB_ID_PATTERNS = Object.freeze([
  // ① 带引号的键值形态（JSON 是工具参数的**正常形态**）：`{"job_id":"h_x"}`、
  //    `{"job_id": "h_x"}`、`'jobId': 'h_x'`。闭合引号在冒号**之前**——旧正则把
  //    引号写在冒号之后，于是 JSON 形态一个都认不出（0.13.2 D-07）。
  /["'`]?job[_\s-]?id["'`]?\s*[:=]\s*["'`]([A-Za-z0-9\u4e00-\u9fff][A-Za-z0-9_.:\u4e00-\u9fff-]{2,63})["'`]/gi,
  // ② 纯文本 / 命令行 flag：`job_id: h_x`、`--job-id h_x`、`jobId=h_x`。
  /\bjob[_\s-]?id\b\s*[:=]?\s*["'`]?([A-Za-z0-9\u4e00-\u9fff][A-Za-z0-9_.:\u4e00-\u9fff-]{2,63})/gi,
])

/** 递归收集 JSON 里所有 `job_id` / `jobId` / `job-id` 的字符串值（任意深度）。 */
function jobIdsFromJson(value, found, depth = 0) {
  if (depth > 12 || value === null || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (const item of value) jobIdsFromJson(item, found, depth + 1)
    return
  }
  for (const [key, item] of Object.entries(value)) {
    if (/^job[_\s-]?id$/i.test(key) && (typeof item === 'string' || typeof item === 'number')) {
      const id = String(item).trim()
      if (id && !/\s/.test(id)) found.add(id)
    }
    if (item && typeof item === 'object') jobIdsFromJson(item, found, depth + 1)
  }
}

/** 终态证据标记：同一事件里同时出现 job 标识与本模式才算"job 已结束"。 */
const TERMINAL_EVIDENCE_PATTERN = /(已结束|已完成|已终止|已取消|已杀掉|退出码|结束|失败|completed|finished|exited|exit code|failed|killed|cancelled|canceled|terminated)/i

/**
 * 受理回执：描述的是"提交这个动作完成了"，不是"job 完成了"。
 *
 * `hive submit` 立刻返回退出码 0 只说明提交成功，后台 job 还在跑。所以判定终态时
 * 必须把受理回执排除，否则启动操作会被自己的"已提交"当成完成证据而提前解除保护。
 */
const SUBMISSION_ACK_PATTERN = /(已提交|提交成功|已排队|已受理|queued|submitted|dispatched)/i

/**
 * 一段文本是否报告了该 job 的终态。
 *
 * 受理回执一律不算——这是"启动成功 ≠ job 完成"在代码里的落点。
 */
function terminalEvidenceIn(text) {
  const source = String(text ?? '')
  if (!TERMINAL_EVIDENCE_PATTERN.test(source)) return false
  return !SUBMISSION_ACK_PATTERN.test(source)
}

/**
 * 待确认副作用：结果明确说"还在等确认"，而不是"已生效"。
 *
 * 这里刻意**不**收裸的 `未提交`：`git status` 的"未提交的更改"会让每个读仓库状态
 * 的操作都被判成待确认副作用，而它的解除条件是"同一工具的后续结果报告已确认"，
 * 于是形成一段永不解除、也无法自证的硬保护。只认明确的等待语气。
 */
const PENDING_EFFECT_PATTERN = /(queued for review|pending review|awaiting (?:approval|confirmation|review)|待确认|待审核|待批准|尚未提交|等待确认|待人工处理)/i
/** 副作用已被确认的标记：同一工具的后续结果出现它才算解除。 */
const EFFECT_CONFIRMED_PATTERN = /(已提交|已确认|已批准|已生效|committed|confirmed|approved|applied)/i

/** 从一段文本里抽出后台 job 标识。 */
export function jobReferencesOf(text) {
  const source = String(text ?? '')
  const found = new Set()
  // JSON 优先：工具参数的正常形态就是 JSON 字符串。
  try {
    const parsed = JSON.parse(source)
    jobIdsFromJson(parsed, found)
  } catch {
    // 不是纯 JSON（命令行文本、混合输出）：正则兜底。
  }
  for (const pattern of JOB_ID_PATTERNS) {
    pattern.lastIndex = 0
    let match
    while ((match = pattern.exec(source)) !== null) {
      const id = String(match[1] ?? '').trim()
      // 过滤掉把句子当 id 的误抓：job id 里不该有空格，也不该是纯噪声词。
      if (id && !/\s/.test(id) && !/^(the|a|an|is|was)$/i.test(id)) found.add(id)
    }
  }
  return [...found]
}

/** 结果正文是否声明了一个尚未确认的副作用。 */
export function hasPendingEffect(text) {
  return PENDING_EFFECT_PATTERN.test(String(text ?? ''))
}

/** 结果正文是否声明了副作用已确认。 */
export function hasConfirmedEffect(text) {
  return EFFECT_CONFIRMED_PATTERN.test(String(text ?? ''))
}

/** 一个 surface 事件的纯文本（assistant/user/system/tool 通用）。 */
export function textOfEvent(event) {
  const blocks = event?.type === 'tool/result' || event?.type === 'user/message' || event?.type === 'system/message' || event?.type === 'developer/message'
    ? event?.data?.message?.content ?? event?.data?.content
    : event?.data?.message?.content
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

/** 一个 surface 事件的工具调用参数拼接（用于发现 `job_id` 这类引用）。 */
export function callArgumentsOf(event) {
  const content = event?.data?.message?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block?.type === 'tool-call')
    .map((block) => (typeof block.arguments === 'string' ? block.arguments : ''))
    .join('\n')
}

/**
 * 扫描一个操作头（含工具调用的 assistant 节点）之后的配对结果。
 *
 * 这里刻意不复用 `collectOperationCandidates`：保护判定必须能在候选集**之外**
 * 独立工作（未闭合的调用根本不会成为候选，却恰恰是最需要硬保护的证据）。
 */
export function scanOperation(surfaceNodes, eventAt, headSeq) {
  const startIdx = surfaceNodes.indexOf(headSeq)
  if (startIdx === -1) return null
  const head = eventAt(headSeq)
  if (head?.type !== 'assistant/message') return null
  const content = head.data?.message?.content
  if (!Array.isArray(content)) return null
  const calls = content.filter((block) => block?.type === 'tool-call')
  if (calls.length === 0) return null
  const results = []
  let cursor = startIdx + 1
  while (cursor < surfaceNodes.length) {
    const seq = surfaceNodes[cursor]
    const event = eventAt(seq)
    if (event?.type !== 'tool/result') break
    results.push({ seq, text: textOfEvent(event) })
    cursor += 1
  }
  return {
    headSeq,
    rangeEnd: results.length ? results[results.length - 1].seq : headSeq,
    resultSeqs: results.map((row) => row.seq),
    callIds: calls.map((block) => (typeof block.id === 'string' ? block.id : '')),
    tools: calls.map((block) => (typeof block.name === 'string' ? block.name : '')),
    callArguments: callArgumentsOf(head),
    resultTexts: results.map((row) => row.text),
    closed: results.length === calls.length,
  }
}

/**
 * 从当前 surface 推导**硬保护**条目。
 *
 * 全部来自真实结构或宿主状态，不做语义猜测：
 * - 系统／开发者指令与当前人类约束；
 * - 未闭合调用（结果缺失、callId 缺失）；
 * - 未曝光结果（其后没有任何助手消息，说明主模型还没可靠看到它）；
 * - 运行中的后台 job 关键引用（只有 job_id、没有终态证据）；
 * - 待确认副作用（结果自称还在等确认）。
 *
 * @param view - `collectOperationCandidates` 的返回值（候选 + 跳过清单）。
 * @param session - surface 视图：`{ surfaceNodes, eventAt }`。
 */
export function collectStructuralProtections({ view, surfaceNodes = [], eventAt, operationEpoch = 0 }) {
  const entries = []
  // 终态证据要绑定 job 身份，而宿主的结果事件不一定带 toolName：
  // 一次解析、按 seq 记忆，避免在长活动面上重复反查。
  const resolveResultToolName = makeResultToolNameResolver(surfaceNodes, eventAt)
  const push = (entry) => {
    if (!entries.some((row) => row.id === entry.id)) entries.push(entry)
  }

  // 1) 结构性与指令性跳过：直接沿用候选选择已经证明过的结论，不另起一套判断。
  for (const item of view?.skipped ?? []) {
    if (NON_PROTECTIVE_SKIP_REASONS.has(item.reason)) continue
    const spec = HARD_SKIP_REASONS[item.reason]
    if (!spec) continue
    push(makeEntry({
      source: spec.source,
      strength: PROTECTION_STRENGTH.HARD,
      target: { kind: 'seq', seq: item.seq },
      reason: spec.reason,
      release: { kind: spec.release, description: releaseTextOf(spec.release) },
      operationEpoch,
    }))
  }

  // 2) 运行中的后台 job 与待确认副作用：需要在操作头之后的整段 surface 里找终态证据。
  const heads = new Set()
  for (const item of view?.skipped ?? []) if (item.reason === 'not-yet-exposed' || item.reason === 'unpaired' || item.reason === 'failed-result') heads.add(item.seq)
  for (const candidate of view?.candidates ?? []) heads.add(candidate.rangeStart)
  for (const headSeq of [...heads].sort((a, b) => a - b)) {
    const scan = scanOperation(surfaceNodes, eventAt, headSeq)
    if (!scan) continue
    const ownText = [scan.callArguments, ...scan.resultTexts].join('\n')
    for (const jobId of jobReferencesOf(ownText)) {
      const terminal = terminalEvidenceFor(surfaceNodes, eventAt, scan.rangeEnd, jobId, scan.tools, resolveResultToolName)
      // 本操作自己的结果若已经报告该 job 的终态，它就是终态证据本身。继续硬保护会
      // 让这段证据永远退不出去——长会话里每轮 poll 都新增一段永不解除的硬保护，
      // 保护集只增不减，最终把整条任务历史钉死在投影里。受理回执由
      // `terminalEvidenceIn` 排除，所以"已提交"不会被误当成"已完成"。
      const selfTerminal = scan.resultTexts.some((text) => text.includes(jobId) && terminalEvidenceIn(text))
      if (terminal || selfTerminal) continue
      push(makeEntry({
        source: PROTECTION_SOURCE.BACKGROUND_JOB,
        strength: PROTECTION_STRENGTH.HARD,
        target: { kind: 'range', rangeStart: headSeq, rangeEnd: scan.rangeEnd, seq: headSeq },
        reason: `后台 job ${jobId} 尚无终态证据（启动成功不等于 job 已完成）`,
        release: { kind: 'on-evidence', ref: jobId, description: `出现同一 job（${jobId}）的终态结果` },
        operationEpoch,
      }))
    }
    if (scan.resultTexts.some((text) => hasPendingEffect(text)) && !confirmedEffectFor(surfaceNodes, eventAt, scan.rangeEnd, scan.tools)) {
      push(makeEntry({
        source: PROTECTION_SOURCE.PENDING_EFFECT,
        strength: PROTECTION_STRENGTH.HARD,
        target: { kind: 'range', rangeStart: headSeq, rangeEnd: scan.rangeEnd, seq: headSeq },
        reason: `工具 ${scan.tools.join('、') || '(unknown)'} 的结果自称待确认，副作用尚未生效`,
        release: { kind: 'on-evidence', ref: scan.tools.join(','), description: '同一工具的后续结果报告已提交／已确认' },
        operationEpoch,
      }))
    }
  }

  return entries
}

/**
 * 在 `afterSeq` 之后找同一 job 的终态证据。找不到就返回 null（保守：继续保护）。
 *
 * **只认工具结果。** 终态必须来自宿主写回的 `tool/result`：模型自己在正文里写
 * "后台任务已完成" 是模型的陈述，不是宿主状态。若把模型的话也算证据，硬保护就会
 * 被旧文本（甚至推测）解除——这正是"不得凭旧文本或推测恢复授权"要防的事。
 */
/**
 * 结果事件声明的工具名。
 *
 * 宿主不保证 `tool/result` 带 `toolName`（本机 app.asar 的 `ToolResultSource` 只有
 * `kind`/`callId`），所以拿不到时回落到「按 callId 反查发起这次调用的 tool-call 块」。
 * 只依赖活动面事实，不猜。
 */
function makeResultToolNameResolver(surfaceNodes, eventAt) {
  const cache = new Map()
  return function resolveToolName(seq, event) {
    const direct = toolNameOf(event)
    if (direct !== '') return direct
    if (cache.has(seq)) return cache.get(seq)
    const callId = event?.data?.message?.source?.callId
    let name = ''
    if (typeof callId === 'string' && callId !== '') {
      for (const node of surfaceNodes) {
        if (node > seq) break
        const candidate = eventAt(node)
        if (candidate?.type !== 'assistant/message') continue
        const blocks = candidate?.data?.message?.content
        if (!Array.isArray(blocks)) continue
        const hit = blocks.find((block) => block?.type === 'tool-call' && block?.id === callId)
        if (hit && typeof hit.name === 'string') {
          name = hit.name
          break
        }
      }
    }
    cache.set(seq, name)
    return name
  }
}

function terminalEvidenceFor(surfaceNodes, eventAt, afterSeq, jobId, tools = [], resolveToolName = null) {
  const wanted = new Set((tools ?? []).filter(Boolean))
  for (const seq of surfaceNodes) {
    if (seq <= afterSeq) continue
    const event = eventAt(seq)
    if (event?.type !== 'tool/result') continue
    const text = textOfEvent(event)
    if (!text.includes(jobId)) continue
    if (!terminalEvidenceIn(text)) continue
    // 终态证据必须**绑定 job 身份**（0.13.2 D-07）：旧实现只要「正文含 id + 一个终态
    // 词」就解除保护，于是任何无关结果（一次 `read` 恰好把该 id 和「失败」写在同一段
    // 日志里）都能解除一条硬保护。现在要求同一工具族；工具身份不可得时只认结构化
    // 终态字段（`state: done`），不认自然语言里的「失败」二字。
    const name = resolveToolName ? resolveToolName(seq, event) : toolNameOf(event)
    if (wanted.size > 0 && name !== '') {
      if (!toolFamiliesOverlap(wanted, name)) continue
    } else if (!structuredTerminalFor(text)) {
      continue
    }
    return { seq }
  }
  return null
}

/** 结果事件声明的工具名（宿主两种形状都认）。 */
function toolNameOf(event) {
  const name = event?.data?.message?.source?.toolName ?? event?.data?.message?.toolName ?? event?.data?.toolName ?? ''
  return typeof name === 'string' ? name : ''
}

/**
 * 工具「族」：`hive_spawn` / `hive_poll` / `hive kill` 同族（首段相同）。
 *
 * 绑定身份不能用精确工具名：一个后台 job 往往由 `hive_spawn` 提交、由 `hive_poll`
 * 报告终态。按族比较既挡住「无关的 `read` 恰好把 id 与『失败』写在一段日志里」，
 * 又不至于把正常的 poll 报告判成无关证据。
 */
function toolFamilyOf(name) {
  const source = String(name ?? '').trim().toLowerCase()
  if (source === '') return ''
  const cut = source.search(/[_\-\s]/)
  return cut > 0 ? source.slice(0, cut) : source
}

function toolFamiliesOverlap(wanted, name) {
  const family = toolFamilyOf(name)
  if (family === '') return false
  for (const candidate of wanted) {
    if (toolFamilyOf(candidate) === family) return true
  }
  return false
}

/** 结构化终态字段：`"state": "done"` / `status=completed` 一类，不认自然语言。 */
function structuredTerminalFor(text) {
  return /["']?\b(state|status|outcome)\b["']?\s*[:=]\s*["']?(done|completed|finished|failed|cancelled|canceled|killed|exited|error)\b/i
    .test(String(text ?? ''))
}

/** 在 `afterSeq` 之后找同一工具的"已确认"证据。 */
function confirmedEffectFor(surfaceNodes, eventAt, afterSeq, tools) {
  const wanted = new Set((tools ?? []).filter(Boolean))
  for (const seq of surfaceNodes) {
    if (seq <= afterSeq) continue
    const event = eventAt(seq)
    if (event?.type !== 'tool/result') continue
    const name = toolNameOf(event)
    if (wanted.size && name && !wanted.has(name)) continue
    if (hasConfirmedEffect(textOfEvent(event))) return { seq }
  }
  return null
}

/**
 * 任务关联线索（**软**保护）。
 *
 * 只在候选正文与当前用户消息共享确定性的路径／标识符时才建立，并且理由里必须
 * 写明"这只是线索"。相同路径**不能**证明语义依赖，也不能证明版本相同，所以它
 * 只是短期保留，不参与硬保护，也永远不阻止到期释放。
 */
export function collectTaskLinkProtections({ candidates = [], latestUserText = '', operationEpoch = 0, operations = DEFAULT_TASK_LINK_PROTECTION_OPERATIONS }) {
  const clues = identifiersOf(latestUserText)
  if (!clues.size) return []
  const entries = []
  for (const candidate of candidates) {
    const shared = [...identifiersOf(candidate.body)].filter((token) => clues.has(token))
    if (!shared.length) continue
    entries.push(makeEntry({
      source: PROTECTION_SOURCE.TASK_LINK,
      strength: PROTECTION_STRENGTH.SOFT,
      target: { kind: 'range', rangeStart: candidate.rangeStart, rangeEnd: candidate.rangeEnd, seq: candidate.rangeStart },
      reason: `与当前用户消息共享标识 ${shared.slice(0, 3).join('、')}（仅关联线索，不构成语义依赖或版本相同的证明）`,
      release: { kind: 'after-operations', n: operations, description: `再过 ${operations} 个操作` },
      operationEpoch,
      evidenceHash: archiveMac(candidate.body),
      costTokens: Number(candidate.originalTokens) || 0,
    }))
  }
  return entries
}

/** 从文本里抽确定性的路径／标识符线索（不用 LLM，不用模糊匹配）。 */
export function identifiersOf(text) {
  const source = String(text ?? '')
  const found = new Set()
  // 路径形态：含分隔符或以已知扩展名结尾的 token。
  for (const match of source.matchAll(/[A-Za-z0-9_./\\@-]*[\\/][A-Za-z0-9_./\\@-]+/g)) {
    const value = match[0].replace(/^[.\\/]+/, '')
    if (value.length >= 3 && value.length <= 200) found.add(value.toLowerCase())
  }
  // 扩展名形态的裸文件名。
  for (const match of source.matchAll(/\b[A-Za-z0-9_-]{1,64}\.[A-Za-z0-9]{1,10}\b/g)) {
    const value = match[0]
    if (value.length >= 4) found.add(value.toLowerCase())
  }
  // 反引号／代码块里的稳定标识（工具名、命令名、符号）。
  for (const match of source.matchAll(/`([^`\n]{3,80})`/g)) {
    const value = match[1].trim().toLowerCase()
    if (value && !/\s/.test(value)) found.add(value)
  }
  return found
}

function releaseTextOf(kind) {
  switch (kind) {
    case 'next-assistant-message': return '下一次助手消息产生（证据进入主模型请求）'
    case 'on-pairing': return '调用与结果重新配对闭合'
    case 'manual': return '仅用户显式解除'
    case 'on-evidence': return '出现对应的终态／确认证据'
    default: return '条件满足时自动解除'
  }
}

/** 生成一个保护条目（补全 id、时间与默认字段）。 */
export function makeEntry({
  source,
  strength,
  target,
  reason,
  release,
  operationEpoch = 0,
  evidenceHash = null,
  costTokens = 0,
  now = null,
}) {
  const targetKey = target.kind === 'range' ? `range:${target.rangeStart}` : `${target.kind}:${target.seq ?? target.nodeId}`
  return {
    id: `${source}:${targetKey}`,
    source,
    strength,
    target,
    reason,
    release: { ...release, establishedEpoch: operationEpoch },
    evidenceHash,
    costTokens,
    createdAt: now ?? new Date().toISOString(),
    createdAtEpoch: operationEpoch,
    stale: false,
  }
}

/**
 * 保护集：硬保护每轮由 surface 重新推导，软保留从持久状态恢复并接受预算与到期约束。
 *
 * 注册表本身不做 IO；持久化由引擎负责，判定是纯函数，便于离线测试。
 */
export class ProtectionRegistry {
  constructor({ soft = [], budgetTokens = DEFAULT_SOFT_PROTECTION_BUDGET_TOKENS, ttlMs = DEFAULT_SOFT_PROTECTION_TTL_MS } = {}) {
    this.hard = []
    this.soft = Array.isArray(soft) ? soft.filter(isEntry).map((entry) => ({ ...entry })) : []
    this.budgetTokens = Number.isFinite(budgetTokens) && budgetTokens >= 0 ? budgetTokens : DEFAULT_SOFT_PROTECTION_BUDGET_TOKENS
    this.ttlMs = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : DEFAULT_SOFT_PROTECTION_TTL_MS
    this.operationEpoch = 0
    this.lastReleased = []
    this.overBudget = false
    this.refusedPins = 0
    this.unknowns = []
  }

  /** 用本轮推导出的硬保护整体替换上一轮的硬保护（硬保护没有记忆，只有事实）。 */
  setHard(entries) {
    this.hard = Array.isArray(entries) ? entries.filter(isEntry) : []
  }

  /** 推进操作纪元：保护到期按"又过了几个操作"计算。 */
  setEpoch(epoch) {
    if (Number.isFinite(epoch) && epoch > this.operationEpoch) this.operationEpoch = epoch
  }

  /** 释放软保护（到期、证据已确认、用户解除）。 */
  refreshSoft(now = Date.now()) {
    const released = []
    const kept = []
    for (const entry of this.soft) {
      const verdict = this.#expired(entry, now)
      if (verdict) released.push({ ...entry, releasedBecause: verdict })
      else kept.push(entry)
    }
    this.soft = kept
    if (released.length) this.lastReleased = released
    return released
  }

  #expired(entry, now) {
    const release = entry.release ?? {}
    if (release.kind === 'after-operations') {
      const done = this.operationEpoch - Number(release.establishedEpoch ?? entry.createdAtEpoch ?? 0)
      if (Number.isFinite(release.n) && done >= release.n) return `已过 ${done} 个操作（上限 ${release.n}）`
    }
    // 显式 pin 是用户意图，不是时间推断：它不因兜底寿命到期而自动解除，
    // 只由 `/memory-lab unpin` 或 `restore` 解除。否则用户 pin 了一晚，
    // 第二天发现它自己没了，而报告里只说"软保护已到期"。
    if (entry.source === PROTECTION_SOURCE.PIN && release.kind === 'manual') return null
    const created = Date.parse(entry.createdAt ?? '')
    if (Number.isFinite(created) && now - created >= this.ttlMs) return `软保护已到期（兜底寿命 ${Math.round(this.ttlMs / 3600000)} 小时）`
    return null
  }

  /** 新增／更新一条软保护。同 id 覆盖，保持幂等。 */
  addSoft(entry) {
    const index = this.soft.findIndex((row) => row.id === entry.id)
    if (index === -1) this.soft.push(entry)
    else this.soft[index] = { ...entry, createdAt: this.soft[index].createdAt ?? entry.createdAt }
    return entry
  }

  /** 显式 pin：受上限约束，超出时拒绝并报告，不静默丢弃。 */
  addPin(entry) {
    const pinned = this.soft.filter((row) => row.source === PROTECTION_SOURCE.PIN)
    const existing = pinned.find((row) => row.id === entry.id)
    if (!existing && pinned.length >= MAX_PINNED_RANGES) {
      this.refusedPins += 1
      return { refused: true, limit: MAX_PINNED_RANGES }
    }
    return { refused: false, entry: this.addSoft(entry) }
  }

  /** 用户解除一条保护（按 id 或目标 seq）。 */
  releaseByTarget(key) {
    const wanted = String(key ?? '').trim()
    if (!wanted) return { removed: 0 }
    const before = this.soft.length
    this.soft = this.soft.filter((entry) => entry.id !== wanted
      && String(entry.target?.seq ?? '') !== wanted
      && String(entry.target?.rangeStart ?? '') !== wanted
      && String(entry.target?.nodeId ?? '') !== wanted)
    return { removed: before - this.soft.length }
  }

  /** 软保护预算：超预算先释放最弱来源，**绝不**触碰硬保护。 */
  enforceBudget() {
    const softTokens = this.soft.reduce((sum, entry) => sum + (Number(entry.costTokens) || 0), 0)
    const hardTokens = this.hard.reduce((sum, entry) => sum + (Number(entry.costTokens) || 0), 0)
    this.overBudget = softTokens > this.budgetTokens
    const released = []
    if (this.overBudget) {
      const order = [...this.soft].sort((a, b) => weightOf(a) - weightOf(b)
        || String(a.createdAt).localeCompare(String(b.createdAt)))
      let running = softTokens
      const drop = new Set()
      for (const entry of order) {
        if (running <= this.budgetTokens) break
        // 显式 pin 是用户意图，最后才降级；弱线索最先释放。
        if (entry.source === PROTECTION_SOURCE.PIN) continue
        drop.add(entry.id)
        running -= Number(entry.costTokens) || 0
        released.push({ ...entry, releasedBecause: `软保护超出预算 ${this.budgetTokens} token，按合法降级释放` })
      }
      this.soft = this.soft.filter((entry) => !drop.has(entry.id))
    }
    const after = this.soft.reduce((sum, entry) => sum + (Number(entry.costTokens) || 0), 0)
    return {
      overBudget: this.overBudget,
      budgetTokens: this.budgetTokens,
      hardTokens,
      softTokensBefore: softTokens,
      softTokens: after,
      released,
    }
  }

  /** 判定一个候选是否可以归档。纯函数：不写声明、不发节点 id。 */
  guard(candidate) {
    const verdict = this.match(candidate)
    if (!verdict) return { safe: true }
    return {
      safe: false,
      code: verdict.code,
      reason: `活跃证据保护（${PROTECTION_SOURCE_LABEL[verdict.entry.source] ?? verdict.entry.source}）：${verdict.entry.reason}；解除条件：${verdict.entry.release?.description ?? '条件满足时自动解除'}`,
      entry: verdict.entry,
    }
  }

  /**
   * 找出拦截该候选的保护条目。
   *
   * 两类匹配：
   * - 目标就是这个操作（`target.rangeStart` 相同）——保护"这段证据"；
   * - 目标 seq 落在候选覆盖的节点里——**非连续保护节点不被范围替换跨越**，
   *   即便未来的候选范围变宽也不允许吞掉受保护节点。
   *
   * 证据修订（`evidenceHash`）不同时，旧保护**失效释放**而不是继续拦截：它当初是
   * 针对另一份正文建立的，让它继续挡下去就是把旧验证冒充成新验证；释放原因写进
   * `lastReleased`，报告里能看见。释放后继续检查其余条目——还有别的保护成立就照拦。
   */
  match(candidate) {
    const shadowed = new Set(Array.isArray(candidate.shadowedSeqs) ? candidate.shadowedSeqs : [])
    const stale = []
    for (const entry of [...this.hard, ...this.soft]) {
      const target = entry.target ?? {}
      const sameRange = target.kind === 'range' && target.rangeStart === candidate.rangeStart
      const inShadow = (target.kind === 'seq' || target.kind === 'range') && shadowed.has(target.seq)
      if (!sameRange && !inShadow) continue
      if (entry.evidenceHash) {
        const current = archiveMac(candidate.body)
        if (current !== entry.evidenceHash) {
          entry.stale = true
          stale.push(entry)
          continue
        }
      }
      return { code: sameRange ? PROTECTION_CODES.PROTECTED : PROTECTION_CODES.OVERLAP, entry }
    }
    if (stale.length) this.#releaseStale(stale)
    return null
  }

  /** 释放证据修订已变化的保护；只有软保护需要落账（硬保护每轮重新推导）。 */
  #releaseStale(entries) {
    const ids = new Set(entries
      .filter((entry) => entry.strength === PROTECTION_STRENGTH.SOFT)
      .map((entry) => entry.id))
    if (ids.size) this.soft = this.soft.filter((entry) => !ids.has(entry.id))
    this.lastReleased = [
      ...entries.map((entry) => ({ ...entry, code: PROTECTION_CODES.STALE, releasedBecause: STALE_RELEASE_REASON })),
      ...this.lastReleased,
    ].slice(0, 20)
  }

  /** 持久化快照：只存软保护（硬保护每轮重新推导，不落盘）。 */
  snapshot() {
    return this.soft.map((entry) => ({
      id: entry.id,
      source: entry.source,
      strength: entry.strength,
      target: entry.target,
      reason: entry.reason,
      release: entry.release,
      evidenceHash: entry.evidenceHash,
      costTokens: entry.costTokens,
      createdAt: entry.createdAt,
      createdAtEpoch: entry.createdAtEpoch,
    }))
  }

  /** 是否还有未解除的软保护（供状态展示与到期复核）。 */
  softCount() {
    return this.soft.length
  }

  /**
   * 可解释报告：某段为何保留、为何可归档、何时解除、保护成本是多少。
   *
   * 只输出确定性元数据（seq、来源、成本、解除条件），不输出冷正文。
   */
  /**
   * 记录"本轮无法判定的条件"。
   *
   * 核心原则：**"未被识别为需要保护"不等于"已证明不需要"**。宿主没给够信息时，
   * 这里显式列出 unknown，并说明本轮的保守处理是什么，而不是让缺口伪装成"没有"。
   */
  setUnknowns(rows) {
    this.unknowns = Array.isArray(rows) ? rows.filter((row) => row && row.code) : []
  }

  report({ limit = 12 } = {}) {
    const hardTokens = this.hard.reduce((sum, entry) => sum + (Number(entry.costTokens) || 0), 0)
    const softTokens = this.soft.reduce((sum, entry) => sum + (Number(entry.costTokens) || 0), 0)
    const lines = [
      `活跃证据保护：硬保护 ${this.hard.length} 段（≈${hardTokens} token，不可被预算解除）／软保留 ${this.soft.length} 段（≈${softTokens} token，预算 ${this.budgetTokens} token）`,
    ]
    const show = [...this.hard, ...this.soft].slice(0, limit)
    for (const entry of show) {
      const where = entry.target?.kind === 'range'
        ? `seq ${entry.target.rangeStart}${entry.target.rangeEnd && entry.target.rangeEnd !== entry.target.rangeStart ? `–${entry.target.rangeEnd}` : ''}`
        : entry.target?.kind === 'seq' ? `seq ${entry.target.seq}` : `冷记录 ${entry.target?.nodeId}`
      const strength = entry.strength === PROTECTION_STRENGTH.HARD ? '硬' : '软'
      // 每条保护都要能自证：来源、原因、建立序号与时间、解除条件、成本。
      // 缺任何一项，用户就无法判断"这段为什么还在、什么时候能退出、代价多少"。
      const born = `；建立：操作 #${Number(entry.createdAtEpoch) || 0}${entry.createdAt ? ` @${entry.createdAt}` : ''}`
      const cost = Number(entry.costTokens) > 0 ? `；成本 ≈${entry.costTokens} token` : '；成本 ≈0 token'
      lines.push(`- [${strength}/${PROTECTION_SOURCE_LABEL[entry.source] ?? entry.source}] ${where}：${entry.reason}${born}；解除：${entry.release?.description ?? '条件满足时自动解除'}${cost}${entry.stale ? '（已过期失效：证据修订已变化）' : ''}`)
    }
    if (this.hard.length + this.soft.length > show.length) {
      lines.push(`- …其余 ${this.hard.length + this.soft.length - show.length} 段见保护集明细。`)
    }
    const staleReleased = this.lastReleased.filter((entry) => entry.code === PROTECTION_CODES.STALE)
    if (staleReleased.length) {
      lines.push(`证据修订已变化的软保护：${staleReleased.length} 段按失效释放（旧验证不冒充新验证；释放后若线索仍成立会在下一个用户消息上重建）。`)
    }
    if (this.overBudget) {
      const budgetReleased = this.lastReleased.filter((entry) => entry.code !== PROTECTION_CODES.STALE).length
      lines.push(`软保护超出预算：已按合法降级释放 ${budgetReleased} 段最弱软保护；硬保护一段未动。`)
    }
    if (this.refusedPins) lines.push(`pin 已达上限 ${MAX_PINNED_RANGES}，${this.refusedPins} 次新增被拒绝（未静默丢弃）。`)
    for (const row of this.unknowns ?? []) {
      lines.push(`无法判定（${row.code}）：${row.reason} → 本轮保守处理：${row.conservative}`)
    }
    return { lines, hardCount: this.hard.length, softCount: this.soft.length, hardTokens, softTokens, overBudget: this.overBudget, unknowns: [...(this.unknowns ?? [])] }
  }
}

/** 来源权重：数值越小越先被预算降级释放。 */
function weightOf(entry) {
  switch (entry.source) {
    case PROTECTION_SOURCE.TASK_LINK: return 0
    case PROTECTION_SOURCE.RECALL: return 1
    case PROTECTION_SOURCE.COLD_DEPENDENCY: return 2
    case PROTECTION_SOURCE.PIN: return 9
    default: return 5
  }
}

function isEntry(value) {
  return !!value && typeof value === 'object' && typeof value.id === 'string' && !!value.target
}

/**
 * 建立一次召回结果临时保护。
 *
 * 插件能证明的事实有两件，且只有两件：
 *
 * 1. 这些冷记录刚刚被读回并注入模型上下文——**不能**证明"模型已经理解并仍
 *    在使用"；
 * 2. 本次召回发生的那一瞬间，哪些操作正排在待归档队列的最前面。
 *
 * 第 2 件才是"避免刚读回又归档"真正要挡的东西：召回把证据重新交给模型的同时，
 * 若同一个稳定边界顺手把模型正要用的那些操作也归档掉，这次召回等于白做。因此
 * 除了保护被读回的冷记录本身，还给**当时的待归档候选**一段短期保留。
 *
 * 两者都是软保护：有来源、有建立序号、有解除条件、计入预算，到期即如实释放。
 * 它们都不阻止用户 `pin`、也不假装知道任务语义。
 *
 * @param ranges - 召回瞬间的待归档候选 `[{ rangeStart, rangeEnd, costTokens }]`。
 * @param nodeIds - 本次召回实际读回的冷记录 id。
 */
export function recallProtectionEntries({
  ranges = [],
  nodeIds = [],
  queryId = '',
  operationEpoch = 0,
  operations = DEFAULT_RECALL_PROTECTION_OPERATIONS,
  now = null,
}) {
  const entries = []
  for (const nodeId of nodeIds) {
    if (!nodeId) continue
    entries.push(makeEntry({
      source: PROTECTION_SOURCE.RECALL,
      strength: PROTECTION_STRENGTH.SOFT,
      target: { kind: 'node', nodeId },
      reason: `冷记录 ${nodeId} 刚被召回注入（曝光不等于理解，仅作短期保留）`,
      release: { kind: 'after-operations', n: operations, description: `再过 ${operations} 个操作` },
      operationEpoch,
      now,
    }))
  }
  for (const range of ranges) {
    if (!Number.isInteger(range?.rangeStart)) continue
    entries.push(makeEntry({
      source: PROTECTION_SOURCE.RECALL,
      strength: PROTECTION_STRENGTH.SOFT,
      target: { kind: 'range', rangeStart: range.rangeStart, rangeEnd: range.rangeEnd, seq: range.rangeStart },
      reason: `本次召回注入时该操作（seq ${range.rangeStart}）正待归档：同一稳定边界上"刚回注又归档"等于白回注一次`,
      release: { kind: 'after-operations', n: operations, description: `再过 ${operations} 个操作` },
      operationEpoch,
      evidenceHash: typeof range.body === 'string' ? archiveMac(range.body) : null,
      costTokens: Number(range.costTokens ?? range.originalTokens) || 0,
      now,
    }))
  }
  if (queryId) entries.push(makeEntry({
    source: PROTECTION_SOURCE.RECALL,
    strength: PROTECTION_STRENGTH.SOFT,
    target: { kind: 'node', nodeId: `recall:${queryId}` },
    reason: `本轮回注内容刚注入（query ${queryId}）`,
    release: { kind: 'after-operations', n: operations, description: `再过 ${operations} 个操作` },
    operationEpoch,
    now,
  }))
  return entries
}

/**
 * 冷库依赖：仍被回执引用的冷记录不可被清理守卫释放。
 *
 * `verify-failed` 必须一并计入。这种行的替换已经提交到活动面、原文已被回执遮蔽，
 * 冷库里的分块是原文唯一的副本；只认 `applied` 会把它当普通冷节点，让清理守卫
 * 释放掉唯一副本。它和 `applied` 的差别只在「替换后的活动面是否通过校验」。
 */
export function coldDependencyEntries({ archiveRows = [], operationEpoch = 0 }) {
  const entries = []
  for (const row of archiveRows) {
    if (!row || (row.status !== 'applied' && row.status !== 'verify-failed')) continue
    entries.push(makeEntry({
      source: PROTECTION_SOURCE.COLD_DEPENDENCY,
      strength: PROTECTION_STRENGTH.HARD,
      target: { kind: 'node', nodeId: row.nodeId },
      reason: `seq ${row.rangeStart} 的回执仍指向冷记录 ${row.nodeId}`,
      release: { kind: 'manual', description: '先 /memory-lab restore 恢复原文，再清理' },
      operationEpoch,
      costTokens: Number(row.originalTokens) || 0,
    }))
  }
  return entries
}

export { canonicalHash }
