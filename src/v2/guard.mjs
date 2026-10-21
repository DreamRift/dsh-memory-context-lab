/**
 * v2 守卫层：一段候选历史能否退出热上下文的独立判定。
 *
 * 这是对 v1 候选收集器的**第二道**判定，不是它的替代：
 * - v1 的 `collectOperationCandidates` 已经要求「助手节点紧跟同名同序结果」；
 * - v2 这里再从**主模型曝光面**出发独立复核，并且只把结论当作「可否降温」的
 *   门，不把它当作事实验证、置信度或安全隔离（规范明确禁止的三种误用）。
 *
 * 判定只看事件结构，不做内容语义判断；`safe === true` 仅表示「结构上允许降温」。
 *
 * 每条规则对应一个真实失败模式（每条都有 test/v2-guard.test.mjs 的用例）：
 *
 * 1. `not-in-surface`：范围内**会进入模型可见投影**的事件（`SURFACE_VISIBLE_TYPES`）
 *    有不在主模型活动面（`session.surface.nodes`）上的——例如辅助模型请求（标题、
 *    摘要、裁决）产生的事件。这类事件没有被主模型看到，把「曾经写入日志」当成
 *    「主模型已曝光」会让插件替主模型丢掉它尚未收到的证据。
 *    但范围是「seq 区间」，**不等于**「区间里每个 seq 都是 surface 节点」：宿主在
 *    工具调用与结果之间还会落 `tool/call`、`turn/end`、`step/start` 这类**日志专用**
 *    事件（本机 `@deepseek-ai/dsh-session@0.2.0-rc.2` 的 `lib/surface.js`
 *    `SURFACE_EVENT_TYPES` 与 `lib/known-event-types.js`）。把审计事件也算成「未曝光
 *    证据」会让降温在真实宿主上**永远无法发生**（真实宿主每次结果前都先落一条
 *    `tool/call`；仓库 fake-host 布局没有它，所以测试全绿而生产恒为 no-op）。
 *    因此日志专用事件**允许穿插**，但必须如实记进 `scan.interleaved`，绝不静默当成
 *    surface 节点；既不是日志专用、也没有 `ignorable` 标记的类型按**未知**处理并拒绝。
 * 2. `unclosed-pair` / `orphan-result` / `duplicate-call` / `duplicate-result` /
 *    `ambiguous-pair`：范围内的工具调用组必须**一一对应、不重复、不乱序、不嵌套**。
 *    用 Set 去重判配对会把「同一个 callId 声明两次」「一次调用两个结果」判成闭合；
 *    按集合而非按位置配对又会放过「结果先于调用」。这些组退热后会留下无法归属的证据。
 * 3. `not-yet-exposed`：范围属于主模型当前正在进行的回合——**并且**曝光边界本身必须
 *    站得住脚：中断的、内容为空的、不是主任务模型结算的助手消息都不算曝光证据
 *    （见 `resolveExposureBoundary`）。辅助模型调用、超时与中断都不解除保护。
 * 4. `empty-range` / `malformed-range` / `unknown-events` / `unknown-event-type`：
 *    范围本身不成立时如实说明，绝不当成「空 = 安全」。
 */

import { EngineV2Error } from './errors.mjs'
import { RECORD_KINDS } from './records.mjs'

export const GUARD_CODES = Object.freeze({
  NOT_IN_SURFACE: 'not-in-surface',
  UNCLOSED_PAIR: 'unclosed-pair',
  ORPHAN_RESULT: 'orphan-result',
  DUPLICATE_CALL: 'duplicate-call',
  DUPLICATE_RESULT: 'duplicate-result',
  AMBIGUOUS_PAIR: 'ambiguous-pair',
  NOT_YET_EXPOSED: 'not-yet-exposed',
  EMPTY_RANGE: 'empty-range',
  MULTI_NODE_PLAIN_RANGE: 'multi-node-plain-range',
  MALFORMED_RANGE: 'malformed-range',
  UNKNOWN_EVENTS: 'unknown-events',
  UNKNOWN_EVENT_TYPE: 'unknown-event-type',
})

/** 人类可读的判定理由，命令面与状态文本共用。 */
export const GUARD_REASONS = Object.freeze({
  [GUARD_CODES.NOT_IN_SURFACE]: '范围内有主模型可见事件不在主模型活动面上（辅助模型请求或未提交事件）',
  [GUARD_CODES.UNCLOSED_PAIR]: '范围内有工具调用没有同范围内的结果（在途动作）',
  [GUARD_CODES.ORPHAN_RESULT]: '范围内有工具结果没有对应的调用（无法归属）',
  [GUARD_CODES.DUPLICATE_CALL]: '范围内同一个 callId 出现多次调用（配对不明确，无法安全降温）',
  [GUARD_CODES.DUPLICATE_RESULT]: '范围内同一个 callId 出现多个结果（配对不明确，无法安全降温）',
  [GUARD_CODES.AMBIGUOUS_PAIR]: '范围内的调用与结果无法按顺序一一对应（乱序、嵌套、穿插或读不到 id）',
  [GUARD_CODES.NOT_YET_EXPOSED]: '范围属于主模型当前正在进行的回合，或曝光证据不成立（中断／空内容／非主任务模型结算）',
  [GUARD_CODES.EMPTY_RANGE]: '范围内没有任何工具调用与结果，也没有可替换的正文节点',
  [GUARD_CODES.MULTI_NODE_PLAIN_RANGE]: '纯文本跨度必须恰好是一个活动面节点，多节点范围没有唯一的替换目标',
  [GUARD_CODES.MALFORMED_RANGE]: '范围端点不是整数或起止颠倒',
  [GUARD_CODES.UNKNOWN_EVENTS]: '范围内有事件读不到（surface 与日志不一致）',
  [GUARD_CODES.UNKNOWN_EVENT_TYPE]: '范围内有无法判定为日志专用的事件类型（可能影响模型可见投影），按未知处理并拒绝',
})

/**
 * 主模型**可见**的事件类型：会进入模型可见投影的那些。
 *
 * 前五个是宿主的 surface 事件类型（`lib/surface.js` 的 `SURFACE_EVENT_TYPES`），
 * `image/offload` 不是 surface 节点但会通过消息投影改变可见内容
 * （`lib/known-event-types.js` 的 `MESSAGE_PROJECTION_EVENT_TYPES`）。
 * `tool/call`、`turn/end` 一类是宿主审计事件，不构成主模型可见的上下文。
 */
export const SURFACE_VISIBLE_TYPES = Object.freeze(new Set([
  'system/message',
  'developer/message',
  'user/message',
  'assistant/message',
  'tool/result',
  'image/offload',
]))

/**
 * 宿主已知的**日志专用**事件类型（`lib/known-event-types.js` 减去可见类型，
 * 2026-10-12 按本机 app.asar 内 dsh-session@0.2.0-rc.2 核验）。
 *
 * 它们既不产生模型消息、也不改变已提交的投影，因此允许在一次操作的 seq 区间里
 * 穿插。清单外的类型一律按未知处理并拒绝：宿主升级新增了日志专用类型时，退热会
 * 明确失败（计划里能看到原因），而不是悄悄跨过没见过的投影。
 */
// 导出只为守卫核对（test/guard-event-coverage.test.mjs 与宿主 KNOWN_SESSION_EVENT_TYPES 做差集）：
// 「清单漏一项」的失败模式是静默的——该操作永远退不了热，没有任何告警。
export const LOG_ONLY_EVENT_TYPES = new Set([
  'agent-preset/selected',
  'agent/inbox/spliced',
  'approval/asked',
  'approval/decided',
  'approval/policy',
  'assistant/attempt',
  'command/done',
  'command/run',
  'compaction/end',
  'compaction/prune',
  'compaction/start',
  'compaction/summary',
  'deliverables/presented',
  'feedback/message-delete',
  'feedback/message-put',
  'feedback/record',
  'goal/change',
  'hook/invoked',
  'hook/result',
  // 0.13.2 D-09：这三个宿主事件在**工具执行期间**写入，正好落在操作区间内，
  // 而旧清单漏了它们——含这些事件的操作区间永久判 `unknown-event-type`，
  // 该操作**永不退热**（全历史退热在这些操作上恒为 no-op）。
  // 发射点：job/registered、job/settled 在 dsh-jobs-local/lib/index.js；
  // working-directory/change 在 dsh-working-directory/lib/index.js。
  'job/registered',
  'job/settled',
  'llm/retry',
  'llm/retry-started',
  'model/selection',
  'permission/preset',
  'plan/mode',
  'request/context',
  'request/header',
  'sandbox/mode',
  'schedule/change',
  'session-log-deepseek/delivery-accepted',
  'session/end-seed',
  'session/title',
  'session/title-llm-request',
  'step/end',
  'step/start',
  'subagent/catalog',
  'subagent/descriptor',
  'subagent/model-selection-policy',
  'team/member',
  'team/message/delivered',
  'team/message/queued',
  'team/task',
  'todo/write',
  'tool-workflow/agent-end',
  'tool-workflow/agent-start',
  'tool-workflow/run-end',
  'tool-workflow/run-start',
  'tool/call',
  'tool/ptc-dispatch',
  'tool/ptc-dispatch-start',
  'turn/end',
  'turn/start',
  'web/deepseek-search-llm-request',
  'working-directory/change',
  'workspace/changes',
])

/** 读事件的安全封装：`eventAt` 缺失时按「读不到」处理，绝不当成「没有事件」。 */
function eventReader(eventAt) {
  return typeof eventAt === 'function' ? eventAt : () => null
}

/** 一次助手消息里的工具调用块（保持块顺序）。 */
function toolCallBlocksOf(event) {
  const content = event?.data?.message?.content
  if (!Array.isArray(content)) return []
  return content.filter((block) => block?.type === 'tool-call')
}

/** 一个工具结果回答的调用 id：结果消息的 `source.callId`。 */
function resultCallIdOf(event) {
  const source = event?.data?.message?.source
  if (!source || source.kind !== 'tool') return null
  return typeof source.callId === 'string' && source.callId ? source.callId : null
}

/**
 * 逐事件分类一个范围。
 *
 * @param eventAt - `(seq) => event | null`，与 `session.eventAt` 同形。
 * @param rangeStart/rangeEnd - 闭区间端点。
 * @param surfaceSeqs - 主模型活动面的 seq 集合（数组或 Set）。
 * @returns `{ calls, results, unclosed, orphans, offSurface, interleaved, unknownTypes,
 *   missing, surfaceNodes, duplicateCalls, duplicateResults, ambiguousCalls,
 *   ambiguousPairs, plainSurfaceNodes, lastCallSeq, lastResultSeq }`
 *
 * `plainSurfaceNodes` 是范围内既非助手决策也非工具结果的 surface 节点（纯文本跨度的
 * 典型本体）。它们**只在范围里确实存在工具调用/结果时**才升级为 `ambiguousPairs`
 * ——那时才是真正的归属歧义（`unexpected-surface-node`）。纯文本范围没有调用，
 * `classifyRange` 直接按 `surfaceNodes` 判定替换目标是否唯一（审计 P0-2）。
 *
 * 配对按**位置**走：宿主自己的活动面平衡就是「助手节点开一个调用、每个结果关
 * 一个」（fake-host 的 `#recomputeBalance` 与真实宿主一致），所以调用按声明顺序
 * 排队、结果必须应答队首。集合式配对（Set.has）会把重复声明与乱序都判成闭合。
 */
export function scanRange({ eventAt, rangeStart, rangeEnd, surfaceSeqs = [] }) {
  const read = eventReader(eventAt)
  const onSurface = surfaceSeqs instanceof Set ? surfaceSeqs : new Set(surfaceSeqs)
  const calls = []
  const results = []
  const unclosed = []
  const orphans = []
  const offSurface = []
  const interleaved = []
  const unknownTypes = []
  const missing = []
  const surfaceNodes = []
  const duplicateCalls = []
  const duplicateResults = []
  const ambiguousCalls = []
  const ambiguousPairs = []
  /** 范围内既不是助手决策也不是工具结果的 surface 节点（纯文本跨度的本体）。 */
  const plainSurfaceNodes = []
  let lastCallSeq = null
  let lastResultSeq = null

  /** 范围内声明过的 callId（含已应答的）：用于识别重复声明。 */
  const seenCalls = new Set()
  const seenResults = new Set()
  /** 仍在等待结果的调用，按声明顺序排队（宿主就是按位置配对）。 */
  const open = []
  /** 没应答到队首的结果：整段走完再定性（真孤儿还是乱序）。 */
  const pending = []
  /** 与结果乱序相遇的调用：它已被应答，只是顺序不合法。 */
  const misordered = new Set()

  for (let seq = rangeStart; seq <= rangeEnd; seq += 1) {
    const event = read(seq)
    if (!event || typeof event !== 'object') {
      missing.push(seq)
      continue
    }
    if (!onSurface.has(seq)) {
      // 非 surface 事件：只有会进入模型可见投影的类型才是「未曝光证据」；
      // 日志专用事件允许穿插，但必须记下来，绝不静默当成 surface 节点。
      if (SURFACE_VISIBLE_TYPES.has(event.type)) {
        offSurface.push(seq)
      } else if (LOG_ONLY_EVENT_TYPES.has(event.type) || event.ignorable === true) {
        interleaved.push(seq)
      } else {
        unknownTypes.push({ seq, type: typeof event.type === 'string' ? event.type : String(event.type) })
      }
      continue
    }
    surfaceNodes.push(seq)

    if (event.type === 'assistant/message') {
      // 一次操作只有一个助手决策节点（rangeStart）。区间里再出现助手节点，
      // 说明这段历史里嵌了第二次决策，归属不唯一。
      if (seq !== rangeStart) ambiguousPairs.push({ seq, callId: null, reason: 'nested-assistant-message' })
      lastCallSeq = seq
      for (const block of toolCallBlocksOf(event)) {
        const callId = typeof block?.id === 'string' ? block.id : ''
        if (!callId) {
          // 读不到 id 的调用无法配对：记下来按「不明确」拒绝，绝不当成可闭合。
          ambiguousCalls.push(seq)
          continue
        }
        calls.push(callId)
        if (seenCalls.has(callId)) {
          duplicateCalls.push(callId)
          continue
        }
        seenCalls.add(callId)
        open.push({ callId, seq })
      }
      continue
    }

    if (event.type === 'tool/result') {
      lastResultSeq = seq
      const callId = resultCallIdOf(event)
      // 读不到 callId 的结果无法配对：绝不当成「已配对」。
      results.push(callId ?? '')
      if (!callId) {
        ambiguousPairs.push({ seq, callId: null, reason: 'unreadable-result-call-id' })
        continue
      }
      if (open.length > 0 && open[0].callId === callId) {
        open.shift()
        seenResults.add(callId)
        continue
      }
      if (seenResults.has(callId)) {
        duplicateResults.push(callId)
        continue
      }
      pending.push({ seq, callId })
      continue
    }

    // 操作区间里出现别的 surface 节点（穿插的用户／系统消息等）：这段历史无法
    // 归属到一次操作。**先只登记**，等整段扫完再定性：v2 也归档纯文本跨度，那种
    // 范围里本来就全是这种节点，不是「配对不明确」（审计 P0-2）。
    plainSurfaceNodes.push({ seq, type: typeof event.type === 'string' ? event.type : String(event.type) })
  }

  // 只有「范围里确实存在工具调用/结果」时，夹杂的 surface 节点才是真正的归属
  // 歧义。纯文本范围（无调用无结果）把这份清单交给 classifyRange 按跨度种类判定。
  if (calls.length > 0 || results.length > 0) {
    for (const node of plainSurfaceNodes) {
      ambiguousPairs.push({ seq: node.seq, callId: null, reason: `unexpected-surface-node:${node.type}` })
    }
  }

  for (const item of pending) {
    // 调用在范围内但排在结果后面 → 乱序（这个结果确实应答了那个调用，调用因此
    // 不再是「在途」）；范围内根本没有这个调用 → 真孤儿。
    if (seenCalls.has(item.callId)) {
      ambiguousPairs.push({ ...item, reason: 'result-before-call' })
      misordered.add(item.callId)
    } else {
      orphans.push(item.callId)
    }
  }
  for (const entry of open) {
    if (!misordered.has(entry.callId)) unclosed.push(entry.callId)
  }

  return {
    calls,
    results,
    unclosed,
    orphans,
    offSurface,
    interleaved,
    unknownTypes,
    missing,
    surfaceNodes,
    duplicateCalls,
    duplicateResults,
    ambiguousCalls,
    ambiguousPairs,
    plainSurfaceNodes,
    lastCallSeq,
    lastResultSeq,
  }
}

/**
 * 一条助手消息被**正面否证**的原因；没有被否证时返回 null。
 *
 * 「正面否证」= 这条消息确定不是「一个完成的模型消息」，而不是「我们看不出它
 * 是不是」。宿主在中断时也会在活动面上落一条 `assistant/message`
 * （`interrupted: true`，见 asar 内 dsh-agent-loop/lib/index.js:1086-1100）；
 * 内容为空的消息宿主也不会投影成模型消息（`deriveEventMessage` 返回 null）。
 * 这两种情况会解除保护，与规范 §5.3 相反（「中断、超时或仅部分流式响应不自动
 * 解除保护」），所以必须单独认出来。
 */
export function exposureRefutedReason(event) {
  if (!event || event.type !== 'assistant/message') return 'not-an-assistant-message'
  if (event.data?.interrupted === true) return 'interrupted-stream'
  const content = event.data?.message?.content
  if (!Array.isArray(content) || content.length === 0) return 'no-model-visible-message'
  return null
}

/**
 * 一条助手消息为什么**不能**当作主模型曝光证据；能当证据时返回 null。
 *
 * 规范 §5.3：曝光必须由「确实进入主任务模型请求的最终发送投影」＋「该请求成功
 * 产出一个完成的 assistant 决策／动作」共同证明。超时／失败落的是**非 surface**
 * 的 `assistant/attempt`（不构成曝光），辅助模型请求（标题、摘要、裁决）根本不是
 * 活动面上的助手消息。因此证据必须同时满足：
 *
 * - 没有被正面否证（见 `exposureRefutedReason`）；
 * - 有宿主契约要求的稳定 id 与 `source.kind === 'model'`（主任务模型结算，
 *   宿主 `assertMessageEventShape` 对 `assistant/message` 的要求）；
 * - 带主循环的结算坐标 `turn`/`step`（宿主 `assertAssistantSettlementShape`）。
 *
 * 这些条件的缺失就是「未知」，未知按**不算曝光**处理：保护只能由站得住脚的证据
 * 解除，不能由「没看出来有问题」解除。
 */
export function exposureRefusalReason(event) {
  const refuted = exposureRefutedReason(event)
  if (refuted) return refuted
  const message = event?.data?.message
  if (typeof message?.id !== 'string' || message.id === '') return 'no-message-id'
  if (message?.source?.kind !== 'model') return 'not-a-main-model-settlement'
  if (!Number.isInteger(event.data?.turn) || !Number.isInteger(event.data?.step)) return 'no-settlement-coordinates'
  return null
}

/** 一条助手消息的曝光证据摘要（可审计，不含正文）。 */
function exposureEvidenceOf(seq, event) {
  return {
    seq,
    turn: event?.data?.turn ?? null,
    step: event?.data?.step ?? null,
    messageId: event?.data?.message?.id ?? null,
    provider: event?.data?.message?.source?.provider ?? null,
    model: event?.data?.message?.source?.model ?? null,
  }
}

/**
 * 解析主模型曝光边界：范围里 seq ≥ 边界即「主模型还没机会看到」。
 *
 * 边界是「活动面上最新一条**站得住脚的**助手消息」的 seq，语义与 C-12 一致：
 * 该助手消息自己那一轮还在进行，它的调用与结果都还不算已曝光。
 *
 * 为什么边界要在这里复核、而不是直接相信调用方给的数字：曝光是解除保护的唯一
 * 依据，而调用方（`runtime.mjs` 的 `lastAssistantSeqOf`）只按「活动面上最后一条
 * `assistant/message`」取数——中断、空内容、辅助模型产物都会被它算成曝光。门禁
 * 不能把「调用方说是几」当事实，只接受能被活动面上的事件正面证实的边界：
 *
 * - 边界命名的活动面节点是助手消息且通过 `exposureRefusalReason` → 采信；
 * - 最新助手消息被正面否证（中断／空内容）而边界 ≥ 它 → 下移到最新一条站得住脚
 *   的助手消息；下移不到就 `fenceAll`（一条完成的请求都没有，什么都不许退热）；
 * - 边界命名的节点存在但站不住脚（例如辅助模型产出的助手消息）→ 同样下移；
 * - 边界不落在活动面上（无法核验）→ 采信，但 `verified: false` 如实标注。
 *
 * 调用方没给边界（`null`／非整数）时按活动面自己推，绝不解释成「无边界 = 都能退」。
 */
export function resolveExposureBoundary({ eventAt, surfaceSeqs = [], claimedSeq = null }) {
  const read = eventReader(eventAt)
  const seqs = surfaceSeqs instanceof Set ? [...surfaceSeqs] : [...surfaceSeqs]
  const onSurface = new Set(seqs)
  const assistants = []
  for (const seq of seqs) {
    if (!Number.isInteger(seq)) continue
    const event = read(seq)
    if (event?.type === 'assistant/message') assistants.push({ seq, event })
  }
  const claimed = Number.isInteger(claimedSeq) && claimedSeq >= 0 ? claimedSeq : null
  const newest = assistants.length > 0 ? assistants[assistants.length - 1] : null
  // 没有可用声明时按活动面推：宁可少退热，也不把「不知道」当成「都曝光了」。
  const base = claimed !== null ? claimed : (newest ? newest.seq : null)

  /** 最新的、通过主模型结算契约的助手消息，且 seq 严格小于 belowSeq。 */
  const usableBelow = (belowSeq) => {
    for (let index = assistants.length - 1; index >= 0; index -= 1) {
      const candidate = assistants[index]
      if (candidate.seq >= belowSeq) continue
      if (exposureRefusalReason(candidate.event) === null) return candidate
    }
    return null
  }
  const lowered = (vetoed) => {
    const lower = vetoed === null ? null : usableBelow(vetoed.seq)
    return {
      boundarySeq: lower ? lower.seq : null,
      fenceAll: lower === null,
      verified: false,
      evidence: lower ? exposureEvidenceOf(lower.seq, lower.event) : null,
      vetoed: vetoed === null ? [] : [{ seq: vetoed.seq, reason: vetoed.reason }],
      reason: lower
        ? '曝光边界被活动面证据否证，已下移到最新一条站得住脚的主模型结算'
        : '活动面上没有任何站得住脚的主模型结算，不解除保护',
    }
  }

  if (base === null) {
    // 活动面上一条助手消息都没有（也没有可核验的声明）：**没有任何曝光证据**。
    // 旧实现返回 `fenceAll: false, boundarySeq: null`，于是 classifyRange 里的边界
    // 判断整段被跳过——不是保守拒绝，是**不判**（0.13.2 D-21b）。可达路径：第一批
    // 归档把助手消息连同结果换成回执之后。没有证据就不许退热。
    return {
      boundarySeq: null,
      fenceAll: true,
      verified: false,
      evidence: null,
      vetoed: [],
      reason: '活动面上没有助手消息节点，也没有可核验的曝光边界：没有任何曝光证据，不解除保护',
    }
  }

  // 1) 最新助手消息被正面否证（中断／空内容）：它不能解除任何保护。
  //    这里只看「正面否证」而不是完整契约：契约字段缺失只说明这条消息无法核验，
  //    不能反过来证明「最新那条不是曝光」——那会把调用方给的、指向别处的边界也
  //    一起推翻。完整契约在第 2 步、也就是边界正好命名这个节点时才生效。
  if (newest && newest.seq <= base) {
    const refuted = exposureRefutedReason(newest.event)
    if (refuted) return lowered({ seq: newest.seq, event: newest.event, reason: refuted })
  }

  // 2) 边界正好命名活动面上的一个节点：该节点必须站得住脚才采信。
  if (onSurface.has(base)) {
    const event = read(base)
    if (event?.type === 'assistant/message') {
      const refusal = exposureRefusalReason(event)
      if (refusal) return lowered({ seq: base, event, reason: refusal })
      return {
        boundarySeq: base,
        fenceAll: false,
        verified: true,
        evidence: exposureEvidenceOf(base, event),
        vetoed: [],
        reason: '',
      }
    }
  }

  // 3) 边界不落在活动面上（无法核验）：采信并如实标注未核验。
  return {
    boundarySeq: base,
    fenceAll: false,
    verified: false,
    evidence: null,
    vetoed: [],
    reason: '曝光边界不是活动面上的助手消息节点，无法核验',
  }
}

/**
 * 判定一个候选范围能否降温。
 *
 * 返回 `{ safe, code, reason, scan, exposure }`；`safe === false` 时 `code`/`reason`
 * 说明原因。判定顺序刻意从「范围本身是否成立」到「是否已被主模型看到」再到
 * 「配对是否闭合」，这样最具体的原因先报出来。
 */
export function classifyRange({
  eventAt,
  rangeStart,
  rangeEnd,
  surfaceSeqs = [],
  lastAssistantSeq = null,
  // v2 也归档普通 user/assistant 正文：那种范围里本来就没有工具调用，调用方按
  // 跨度种类显式声明后，「没有调用」不再等于「空范围」。默认 false，v1 口径不变。
  allowPlainText = false,
}) {
  if (!Number.isInteger(rangeStart) || !Number.isInteger(rangeEnd) || rangeStart > rangeEnd) {
    return {
      safe: false,
      code: GUARD_CODES.MALFORMED_RANGE,
      reason: GUARD_REASONS[GUARD_CODES.MALFORMED_RANGE],
      scan: null,
      exposure: null,
    }
  }
  const exposure = resolveExposureBoundary({ eventAt, surfaceSeqs, claimedSeq: lastAssistantSeq })
  if (exposure.fenceAll) {
    return {
      safe: false,
      code: GUARD_CODES.NOT_YET_EXPOSED,
      reason: exposure.reason || GUARD_REASONS[GUARD_CODES.NOT_YET_EXPOSED],
      scan: null,
      exposure,
    }
  }
  if (exposure.boundarySeq !== null && rangeEnd >= exposure.boundarySeq) {
    // 主模型正在进行的回合：证据可能还在路上，一律留在热上下文。
    return { safe: false, code: GUARD_CODES.NOT_YET_EXPOSED, reason: GUARD_REASONS[GUARD_CODES.NOT_YET_EXPOSED], scan: null, exposure }
  }
  const scan = scanRange({ eventAt, rangeStart, rangeEnd, surfaceSeqs })
  if (scan.missing.length > 0) {
    return { safe: false, code: GUARD_CODES.UNKNOWN_EVENTS, reason: GUARD_REASONS[GUARD_CODES.UNKNOWN_EVENTS], scan, exposure }
  }
  if (scan.unknownTypes.length > 0) {
    return { safe: false, code: GUARD_CODES.UNKNOWN_EVENT_TYPE, reason: GUARD_REASONS[GUARD_CODES.UNKNOWN_EVENT_TYPE], scan, exposure }
  }
  // 端点必须是活动面节点：范围按 seq 表示，替换却按活动面下标做（宿主
  // `replacementRange` 用 `nodes.indexOf(startSeq/endSeq)`），端点不在活动面上的
  // 范围没有确定的替换目标。
  if (!scan.surfaceNodes.includes(rangeStart) || !scan.surfaceNodes.includes(rangeEnd)) {
    return { safe: false, code: GUARD_CODES.NOT_IN_SURFACE, reason: GUARD_REASONS[GUARD_CODES.NOT_IN_SURFACE], scan, exposure }
  }
  if (scan.offSurface.length > 0) {
    return { safe: false, code: GUARD_CODES.NOT_IN_SURFACE, reason: GUARD_REASONS[GUARD_CODES.NOT_IN_SURFACE], scan, exposure }
  }
  // 读不到 id 的调用块只进 `ambiguousCalls`、不进 `calls`，所以它必须在「空范围」分支
  // **之前**判（0.13.2 D-21a）。旧顺序下先命中空范围分支，这条检查永远轮不到：
  // `allowPlainText=false` 时只表现为原因码错（报 empty-range，真相是在途动作无法
  // 配对）；`allowPlainText=true` 的调用方会拿到 `safe:true`——**放行在途调用**。
  if (scan.ambiguousCalls.length > 0) {
    return { safe: false, code: GUARD_CODES.AMBIGUOUS_PAIR, reason: GUARD_REASONS[GUARD_CODES.AMBIGUOUS_PAIR], scan, exposure }
  }
  if (scan.calls.length === 0 && scan.results.length === 0) {
    // 只有工具调用/结果的旧口径：v1 的候选范围里必须有调用。`allowPlainText` 由
    // 调用方（v2 全历史候选）按跨度种类显式声明：纯文本跨度本来就没有任何调用，
    // 那不是「空范围」。
    //
    // 纯文本范围里可替换的正文节点就是 `surfaceNodes`（范围内的全部活动面节点，
    // 含助手正文与用户正文；日志专用事件在扫描时已排除）。助手正文节点不会被记进
    // `plainSurfaceNodes`——它走的是 `assistant/message` 分支——所以这里必须用
    // `surfaceNodes` 判定，否则「只有助手正文的区间」会被误判成空范围（审计 P0-2）。
    if (!allowPlainText) {
      return { safe: false, code: GUARD_CODES.EMPTY_RANGE, reason: GUARD_REASONS[GUARD_CODES.EMPTY_RANGE], scan, exposure }
    }
    if (scan.surfaceNodes.length === 0) {
      // 声明了纯文本却没有可替换的正文节点（例如区间里只有日志专用事件）：
      // 真为空的区间仍然拒绝，且原因与「配对不明确」可区分。
      return { safe: false, code: GUARD_CODES.EMPTY_RANGE, reason: GUARD_REASONS[GUARD_CODES.EMPTY_RANGE], scan, exposure }
    }
    if (scan.surfaceNodes.length > 1) {
      // 纯文本跨度必须恰好是一个 surface 节点：多节点范围会跨过节点边界，
      // 宿主 `replacementRange` 的替换目标就不再唯一。拒绝并给出专门的原因码，
      // 而不是笼统报成配对不明确。
      return {
        safe: false,
        code: GUARD_CODES.MULTI_NODE_PLAIN_RANGE,
        reason: GUARD_REASONS[GUARD_CODES.MULTI_NODE_PLAIN_RANGE],
        scan,
        exposure,
      }
    }
    // 纯文本跨度：配对（不存在）、曝光边界（上面已判）、端点归属都已确认，放行。
    return { safe: true, code: null, reason: '', scan, exposure }
  }
  if (scan.unclosed.length > 0) {
    return { safe: false, code: GUARD_CODES.UNCLOSED_PAIR, reason: GUARD_REASONS[GUARD_CODES.UNCLOSED_PAIR], scan, exposure }
  }
  // 重复必须显式拒绝：用 Set 去重时第二个同名调用被静默吞掉，
  // 于是「两次调用一次结果」看起来是闭合的——那正是配对不明确。
  if (scan.duplicateCalls.length > 0) {
    return { safe: false, code: GUARD_CODES.DUPLICATE_CALL, reason: GUARD_REASONS[GUARD_CODES.DUPLICATE_CALL], scan, exposure }
  }
  if (scan.duplicateResults.length > 0) {
    return { safe: false, code: GUARD_CODES.DUPLICATE_RESULT, reason: GUARD_REASONS[GUARD_CODES.DUPLICATE_RESULT], scan, exposure }
  }
  if (scan.ambiguousPairs.length > 0) {
    return { safe: false, code: GUARD_CODES.AMBIGUOUS_PAIR, reason: GUARD_REASONS[GUARD_CODES.AMBIGUOUS_PAIR], scan, exposure }
  }
  if (scan.orphans.length > 0) {
    return { safe: false, code: GUARD_CODES.ORPHAN_RESULT, reason: GUARD_REASONS[GUARD_CODES.ORPHAN_RESULT], scan, exposure }
  }
  return { safe: true, code: null, reason: '', scan, exposure }
}

/** 门禁形式：不安全时抛 `EGUARD`，绝不静默放行。 */
export function assertCoolableRange(options) {
  const verdict = classifyRange(options)
  if (verdict.safe !== true) {
    throw new EngineV2Error(`候选范围 seq ${options.rangeStart}–${options.rangeEnd} 不允许降温：${verdict.reason}`, {
      code: 'EGUARD',
      details: { code: verdict.code, rangeStart: options.rangeStart, rangeEnd: options.rangeEnd },
    })
  }
  return verdict
}

/**
 * 冷库配对账本自检：一段归档跨度写完后，它的调用/结果索引必须成对闭合。
 *
 * 与 `classifyRange` 的区别是数据来源：这里读的是**已落库的** v2 索引记录，
 * 用来证明「冷库里的配对」与「会话里的配对」一致——冷写成功但索引缺失时，
 * 重启后仍然能判定出未闭合配对，而不是相信内存里的一次成功返回。
 */
export function auditPairingRecords(records = []) {
  const calls = new Map()
  const results = new Map()
  const malformed = []
  for (const record of records) {
    if (!record || typeof record !== 'object') {
      malformed.push({ id: null, kind: null, reason: 'not-a-record' })
      continue
    }
    if (record.kind !== RECORD_KINDS.OPERATION_CALL && record.kind !== RECORD_KINDS.OPERATION_RESULT) continue
    // callId 的权威位置是 refs（records.mjs 的 REF_KEYS_BY_KIND）；
    // 兼容早期把 callId 放进 inline 的写法，但绝不因此漏检。
    const callId = record.refs?.callId ?? record.inline?.callId
    if (typeof callId !== 'string' || !callId) {
      // 配对记录读不到 callId 就无法判定归属。这里以前直接 `continue`，于是
      // 「索引缺字段」被算成「配对闭合」——正是这条自检要防的失败模式：
      // 判不出来就必须如实报出来，绝不当成通过。
      malformed.push({ id: record.id ?? null, kind: record.kind, reason: 'missing-call-id' })
      continue
    }
    if (record.kind === RECORD_KINDS.OPERATION_CALL) calls.set(callId, record)
    else results.set(callId, record)
  }
  const unclosed = [...calls.keys()].filter((callId) => !results.has(callId))
  const orphans = [...results.keys()].filter((callId) => !calls.has(callId))
  return {
    calls: calls.size,
    results: results.size,
    unclosed,
    orphans,
    malformed,
    closed: unclosed.length === 0 && orphans.length === 0 && malformed.length === 0,
  }
}
