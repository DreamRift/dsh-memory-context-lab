/**
 * v2 全历史候选收集器。
 *
 * 为什么不是 `collectOperationCandidates`：那个收集器只认「助手工具调用 + 紧邻
 * 结果」，并且**遇到失败结果就整段跳过**。v2 的产品口径是「原始历史全部可存、
 * 已完成历史按需读取」——普通 user/assistant 正文、旧回执、旧状态卡、旧召回包
 * 同样占热上下文，也必须能退热；失败结果属于必要证据，不能因为「失败了」就从
 * 归档面消失。把 v1 的收集器改宽会顺手改掉 v1 的行为，所以这里单独实现。
 *
 * 两类候选：
 * - `operation`：助手工具调用 + 紧随其后的结果（含失败结果），正文由
 *   `buildOperationBody` 生成，保留 callId 以便按操作回读；
 * - `span`：单个 surface 节点（用户/助手正文、旧回执、旧卡、旧召回包），正文是
 *   该节点的逐字文本，带 `--- seq:N kind ---` 头。
 *
 * 两者共用同一条边界：**最后一次助手决策之后的内容不退热**（主模型还没机会看到
 * 结果），**最新的人类请求不退热**（那是任务陈述）。人类请求按作者判定，插件
 * 自己注入的卡片/回执/召回包不算人类请求。
 */

import { isHumanAuthoredMessage, isPluginAuthoredMessage, RECEIPT_MARKER, V2_RECEIPT_MARKER } from '../core.mjs'
import { contentHasPlanToolCall } from '../plan-first.mjs'

/** 跨度种类：回执与冷库记录都按它区分正文形态，工具操作不冒充普通历史。 */
export const SPAN_KINDS = Object.freeze({
  OPERATION: 'operation',
  USER_TEXT: 'turn.user',
  ASSISTANT_TEXT: 'assistant.text',
  TOOL_RESULT: 'tool.result',
  SYSTEM_TEXT: 'head.system',
  DEVELOPER_TEXT: 'head.developer',
})

const KIND_BY_TYPE = Object.freeze({
  'user/message': SPAN_KINDS.USER_TEXT,
  'assistant/message': SPAN_KINDS.ASSISTANT_TEXT,
  'tool/result': SPAN_KINDS.TOOL_RESULT,
  'system/message': SPAN_KINDS.SYSTEM_TEXT,
  'developer/message': SPAN_KINDS.DEVELOPER_TEXT,
})

const SPAN_LABELS = Object.freeze({
  [SPAN_KINDS.USER_TEXT]: '用户消息',
  [SPAN_KINDS.ASSISTANT_TEXT]: '助手消息',
  [SPAN_KINDS.TOOL_RESULT]: '工具结果',
  [SPAN_KINDS.SYSTEM_TEXT]: '系统消息',
  [SPAN_KINDS.DEVELOPER_TEXT]: '开发者消息',
  [SPAN_KINDS.OPERATION]: '工具操作',
})

export function spanLabelOf(kind) {
  return SPAN_LABELS[kind] ?? '历史片段'
}

/** 可以被逐字保存的块类型；其余（图片/附件/供应商私有块）整段拒绝。 */
const TEXT_BLOCK_TYPES = new Set(['text', 'reasoning'])

function textPartsOf(content, { includeReasoning }) {
  if (!Array.isArray(content)) return null
  const parts = []
  for (const block of content) {
    if (!block || typeof block.type !== 'string') return null
    if (!TEXT_BLOCK_TYPES.has(block.type)) return null
    if (block.type === 'reasoning' && !includeReasoning) continue
    if (typeof block.text !== 'string') return null
    parts.push(block.text)
  }
  return parts
}

/**
 * 取一条 surface 事件的正文块。
 *
 * 事件形态不止一种：`assistant/message` 与 `tool/result` 的正文在
 * `data.message.content`，而 `user/message` 的正文在 `data.content`（DSH 宿主
 * 的两种事件形状）。只读 `data.message.content` 会让所有 user/message 取到
 * `undefined` → 判定为 span-not-eligible，于是「全历史退热」对用户正文恒为
 * no-op（审计 P0-1）。这里两条路径都取，谁先给出可用数组就用谁。
 *
 * 返回 `null` 表示「没有可逐字保存的正文」——既包括两条路径都没有数组，也包括
 * 数组里含图片/供应商私有块这类不可逐字保存的内容；调用方据此拒绝该跨度。
 */
function contentBlocksOf(event) {
  const candidates = [event?.data?.content, event?.data?.message?.content]
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate
  }
  return null
}

function eventTextOf(event, kind) {
  if (!event || typeof event.type !== 'string') return null
  const includeReasoning = kind === SPAN_KINDS.ASSISTANT_TEXT
  const parts = textPartsOf(contentBlocksOf(event), { includeReasoning })
  if (parts === null) return null
  return parts.join('\n').trim()
}

/** 单节点跨度的正文格式：收集与提交前漂移检查共用的唯一定义。 */
function spanBodyFor(seq, kind, text) {
  return `--- seq:${seq} ${kind} ---\n${text}\n`
}

/** 失败判定与门禁同口径：显式 error 字段或消息级 isError。 */
export function resultFailed(result) {
  return result?.data?.error !== undefined || result?.data?.message?.isError === true
}

function toolResultText(result) {
  const blocks = result?.data?.message?.content
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

function errorTextOf(result) {
  const error = result?.data?.error
  if (typeof error === 'string') return error
  if (error && typeof error === 'object') {
    if (typeof error.message === 'string') return error.message
    try {
      return JSON.stringify(error)
    } catch {
      return String(error)
    }
  }
  return ''
}

/**
 * 工具操作正文的唯一构造点：收集与提交前重建都走它，保证两边逐字一致。
 *
 * 与 v1 的 `buildArchiveBody` 同形，失败结果额外带一行失败标记：失败证据要留下，
 * 而且要在正文里看得出来它失败了，不能读起来像一次成功。
 */
function buildOperationBody({ content, entries }) {
  const collect = (type) => (Array.isArray(content)
    ? content.filter((block) => block?.type === type && typeof block.text === 'string').map((block) => block.text).join('\n')
    : '')
  const parts = []
  const assistantText = collect('text')
  const reasoning = collect('reasoning')
  if (assistantText.trim()) parts.push(assistantText.trim())
  if (reasoning.trim()) parts.push(`[推理]\n${reasoning.trim()}`)
  for (const entry of entries) {
    const args = entry.arguments.trim()
    parts.push(`[工具] ${entry.name}${args ? `\n参数：${args}` : ''}`)
    const body = entry.text || ''
    parts.push(entry.failed ? `[失败结果]\n${body || '（结果正文为空）'}` : `[结果]\n${body}`)
  }
  return parts.join('\n\n')
}

/**
 * 按 unit 的形状从活跃事件重建操作条目。
 *
 * @returns `{ ok: true, entries }` 或 `{ ok: false, reason }`。
 */
function operationEntriesOf({ content, callIds, resultSeqs, eventOf }) {
  const calls = Array.isArray(content) ? content.filter((block) => block?.type === 'tool-call') : []
  if (calls.length !== callIds.length) return { ok: false, reason: 'unpaired' }
  const blockIndexes = []
  for (const [blockIndex, block] of content.entries()) {
    if (block?.type === 'tool-call') blockIndexes.push(blockIndex)
  }
  const entries = []
  let hasFailedResult = false
  for (const [index, callId] of callIds.entries()) {
    if (calls[index]?.id !== callId) return { ok: false, reason: 'unpaired' }
    const result = eventOf(resultSeqs[index])
    if (result?.type !== 'tool/result') return { ok: false, reason: 'unpaired' }
    if (result.surfaceOp !== 'append') return { ok: false, reason: 'already-archived' }
    const source = result.data?.message?.source
    if (!source || source.kind !== 'tool' || source.callId !== callId) return { ok: false, reason: 'unpaired' }
    const blocks = result.data?.message?.content
    if (!Array.isArray(blocks) || blocks.length === 0) return { ok: false, reason: 'no-content' }
    if (blocks.some((block) => !block || block.type !== 'text' || typeof block.text !== 'string')) {
      return { ok: false, reason: 'non-text-content' }
    }
    const failed = resultFailed(result)
    if (failed) hasFailedResult = true
    const text = toolResultText(result)
    entries.push({
      name: typeof calls[index].name === 'string' ? calls[index].name : 'tool',
      arguments: typeof calls[index].arguments === 'string' ? calls[index].arguments : '',
      // 失败结果如果连正文都没有，至少留下错误文本：失败证据不能是空的。
      text: failed && !text ? errorTextOf(result) : text,
      callId,
      blockIndex: blockIndexes[index] ?? null,
      resultMessageId: result.data?.message?.id ?? null,
      failed,
    })
  }
  return { ok: true, entries, hasFailedResult }
}

/**
 * 从活跃 surface 事件重建一个单元的正文。
 *
 * 提交前用它做漂移检查：光凭「区间还在活动面上」不够，同形状的区间可能装着
 * 不同内容。
 */
export function bodyOfSpan(session, unit) {
  const eventOf = (seq) => (typeof session?.eventAt === 'function' ? session.eventAt(seq) : null)
  const seqs = Array.isArray(unit.shadowedSeqs) ? unit.shadowedSeqs : []
  if (unit.spanKind === SPAN_KINDS.OPERATION) {
    const content = eventOf(unit.rangeStart)?.data?.message?.content
    if (!Array.isArray(content)) return null
    const built = operationEntriesOf({ content, callIds: unit.callIds ?? [], resultSeqs: seqs.slice(1), eventOf })
    if (!built.ok) return null
    return buildOperationBody({ content, entries: built.entries })
  }
  const parts = []
  for (const seq of seqs) {
    const text = eventTextOf(eventOf(seq), unit.spanKind)
    if (text === null || text === '') return null
    parts.push(spanBodyFor(seq, unit.spanKind, text))
  }
  return parts.length === 0 ? null : parts.join('\n')
}

/**
 * 收集候选。契约与 v1 收集器一致（`apply-engine.surfaceViewOf` 调用它）。
 */
export function collectHistoryCandidates(view) {
  const {
    surfaceNodes = [],
    eventAt,
    measuredNodes = [],
    retainOperations = 0,
    openTurn,
    archivedRanges = [],
    minimumChars = 0,
    lastAssistantSeq = null,
    // 全历史记忆上下文模式：除硬保护外的一切都可退热，保留窗口失效。
    // 由 v2 账本的 `set fullhistory on` 驱动（引擎 surfaceViewOf 注入）。
    fullHistory = false,
  } = view
  const total = surfaceNodes.length
  const eventOf = (index) => (typeof eventAt === 'function' ? eventAt(surfaceNodes[index]) : null)
  const skip = new Map()
  const protectedIdx = new Set()
  const protect = (index, reason) => {
    protectedIdx.add(index)
    if (Number.isInteger(surfaceNodes[index])) skip.set(surfaceNodes[index], reason)
  }

  if (total > 0 && eventOf(0)?.type === 'system/message') protect(0, 'protected-system-head')

  /**
   * isPlugin/isHuman 判据吃的是**归一化 message**（`{...data, content, source}`），
   * 不是 `{type, data}` 事件壳：unwrapEvent 只会退到 `data`，壳上的 `data.message`
   * 不展开，直接传事件会让两个判据恒为 false（所有 user 消息都被当外来源）。
   * apply-engine.latestUserSurface 已是同一归一化，这里共用。
   */
  const messageOf = (event) => {
    const data = event?.data ?? {}
    return { ...data, content: data?.content ?? data?.message?.content, source: data?.source ?? data?.message?.source }
  }

  // 最新的人类请求是任务陈述，永远不退热。注意「最新的 user/message」在 v2 里
  // 常常是插件自己注入的工作状态卡/回注包/归档回执，所以保护位必须按作者判定：
  // 只保护真实人类输入，以及来源不明的非插件 user/message（保守兜底）。插件消息
  // 一律不占保护位，否则旧卡片永远退不了热（审计 P0-3 / P1-4）。
  let latestHumanIndex = -1
  let latestForeignIndex = -1
  for (let index = total - 1; index >= 0; index -= 1) {
    const event = eventOf(index)
    if (event?.type !== 'user/message') continue
    if (latestForeignIndex === -1 && !isPluginAuthoredMessage(messageOf(event))) latestForeignIndex = index
    if (latestHumanIndex === -1 && isHumanAuthoredMessage(messageOf(event))) latestHumanIndex = index
  }
  if (latestHumanIndex >= 0) protect(latestHumanIndex, 'protected-latest-human-request')
  if (latestForeignIndex >= 0 && latestForeignIndex !== latestHumanIndex) {
    protect(latestForeignIndex, 'protected-latest-user')
  }

  // ── 计划工件：`exit_plan_mode` 调用及其计划全文，任何模式下都不退热 ──
  // 计划先行（以及手动 /plan）产出的计划 markdown 就在这次调用的参数里；用户
  // 批准与否都不改变「开发全程计划可见」的契约。这里保护的是调用头消息本身，
  // 其后续 tool/result 因失去配对会以 orphan-result 如实跳过，同样留在活动面。
  for (let index = 0; index < total; index += 1) {
    const event = eventOf(index)
    if (event?.type !== 'assistant/message') continue
    // 计划工件判定与凭证判定共用 contentBlocksOf 的双形状归一（审计 P0-1）：
    // 只读 data.message.content 会让扁平形状（data.content，插件回执/注入的真实
    // 写入形态）取到 undefined，计划调用头与退热凭证双双失去保护。
    if (contentHasPlanToolCall(contentBlocksOf(event))) {
      protect(index, 'protected-plan-artifact')
    }
  }

  // ── 全历史模式的两类不可压缩凭证 ──
  // ① 全部人类（及来源不明的非插件）user 消息：表层替换原位进行，所以它们自然
  //   保持原始顺序，插在退热凭证之间；②退热凭证本身：v2 回执极小且逐字节稳定，
  //   再退热只会让凭证失去「不可压缩」属性，没有任何收益。
  if (fullHistory) {
    for (let index = 0; index < total; index += 1) {
      const event = eventOf(index)
      if (event?.type !== 'user/message') continue
      const blocks = contentBlocksOf(event)
      const text = Array.isArray(blocks)
        ? blocks.filter((block) => block?.type === 'text' && typeof block.text === 'string').map((block) => block.text).join('\n')
        : ''
      // 凭证判定先行：正文以任一回执标记开头就是凭证（v1/v2 两代）。不能依赖
      // isPluginAuthoredMessage——它的回执兜底只认 v1 标记，v2 回执会被误判成
      // 人类消息而失去「不可压缩」保护。
      if (text.startsWith(RECEIPT_MARKER) || text.startsWith(V2_RECEIPT_MARKER)) {
        protect(index, 'protected-receipt-voucher')
        continue
      }
      if (!isPluginAuthoredMessage(messageOf(event))) {
        protect(index, 'protected-user-history')
      }
    }
  }

  // ── 计划工件（两种模式都保护，不只在全历史模式）──
  // 计划全文保留在 exit_plan_mode 调用参数里，是整个会话的开发方向锚点：计划
  // 先行要求「计划文本开发全程保留」。保护消息头即可——其配对结果随后被
  // orphan-result 规则跳过（仍可见），不需要重复保护。

  const covered = new Set()
  const raw = []
  const archivedSeqOf = (seq) => (archivedRanges ?? []).some((range) => seq >= range.start && seq <= range.end)

  for (let index = 0; index < total; index += 1) {
    if (covered.has(index) || protectedIdx.has(index)) continue
    const event = eventOf(index)
    if (!event || typeof event.type !== 'string') {
      skip.set(surfaceNodes[index], 'unreadable-event')
      continue
    }
    const kind = KIND_BY_TYPE[event.type]
    if (kind === undefined) {
      // surface 上出现了本收集器不认识的可见类型：不猜正文，如实跳过。
      skip.set(surfaceNodes[index], 'unsupported-surface-type')
      continue
    }
    if (archivedSeqOf(surfaceNodes[index])) {
      skip.set(surfaceNodes[index], 'already-archived')
      continue
    }
    // 曝光栅栏（当前回合不退热）**不在这里**把单元丢掉：丢掉它就等于把它从
    // 「保留最近 N 个操作」的窗口里抹掉，于是窗口会往前吃掉上一个操作，表现为
    // 「刚拿到结果的那个操作还没曝光、所以上一批也不许退」——正常会话里最后
    // 一回合总是开着的，结果就是永远退不了热。这里只做标记，拒绝交给门禁
    // （guard.mjs 的曝光边界）与 planCooling，窗口仍按全部操作计算。
    const notYetExposed = lastAssistantSeq !== null && surfaceNodes[index] >= lastAssistantSeq

    if (event.type === 'assistant/message') {
      const content = event.data?.message?.content
      const calls = Array.isArray(content) ? content.filter((block) => block?.type === 'tool-call') : []
      if (calls.length > 0) {
        const operation = operationCandidateAt({
          index,
          event,
          content,
          calls,
          eventOf,
          // 注意两把尺子：`eventOf` 吃**活动面下标**，`eventAtSeq` 吃**宿主 seq**。
          // 混用会把「结果事件」读成另一个下标上的事件，于是每个操作都变成
          // 「没有同范围闭合」——真实布局下表现为 100% 退不了热。
          eventAtSeq: (seq) => (typeof eventAt === 'function' ? eventAt(seq) : null),
          total,
          minimumChars,
          surfaceNodes,
        })
        if (operation.ok) {
          for (let scan = index; scan <= operation.endIndex; scan += 1) covered.add(scan)
          raw.push({ ...operation, startIndex: index, notYetExposed })
        } else {
          skip.set(surfaceNodes[index], operation.reason)
        }
        continue
      }
    } else if (event.type === 'tool/result') {
      // 孤儿结果（没有配对调用）没有可替换的合法区间，门禁也会拒绝。如实跳过，
      // 不编造一个调用出来。
      skip.set(surfaceNodes[index], 'orphan-result')
      continue
    }

    // 插件自己注入的 user/message（工作状态卡、回注包）仍然进候选：不进去，旧卡就
    // 永远退不了热。真正要治的是「卡片自己触发一批归档」——那由 planCooling 的
    // countable/piggyback 拆分负责（卡片搭车，不计数）。这里只把作者信息标出来，
    // 供上游计数与回执文案区分，不在这里跳过。
    const pluginAuthored = event.type === 'user/message' && isPluginAuthoredMessage(messageOf(event))

    const text = eventTextOf(event, kind)
    if (text === null) {
      skip.set(surfaceNodes[index], 'span-not-eligible')
      continue
    }
    if (text === '') {
      skip.set(surfaceNodes[index], 'too-short')
      continue
    }
    const body = spanBodyFor(surfaceNodes[index], kind, text)
    if (body.length < minimumChars) {
      skip.set(surfaceNodes[index], 'too-short')
      continue
    }
    raw.push({
      startIndex: index,
      endIndex: index,
      spanKind: kind,
      body,
      callIds: [],
      tools: [],
      sources: [],
      turn: event.data?.turn ?? null,
      step: event.data?.step ?? null,
      hasFailedResult: false,
      pluginAuthored,
    })
  }

  raw.sort((a, b) => a.startIndex - b.startIndex)

  // 「保留最近 N 个操作」按**操作单元**计（设置名就是 retainOperations）：普通
  // 历史段不占用这个窗口，否则一段长正文就能把窗口吃满、把更早的操作挤出去。
  // 全历史模式下保留窗口整体失效（面板上的「保留最近操作」同步变灰），留下与否
  // 完全由守卫与保护层按证据安全裁决。
  const operationUnits = raw.filter((entry) => entry.spanKind === SPAN_KINDS.OPERATION)
  let retentionFromIndex = total
  if (fullHistory) {
    retentionFromIndex = total
  } else if (retainOperations > 0) {
    retentionFromIndex = operationUnits.length > retainOperations
      ? operationUnits[operationUnits.length - retainOperations].startIndex
      : 0
  }

  const candidates = []
  for (const entry of raw) {
    if (entry.notYetExposed === true) {
      // 曝光栅栏在这里**只登记不产出**：窗口已经把它算进保留基线（见上），
      // 所以「最近一个操作还在途」不会连带冻结上一个已曝光操作。
      skip.set(surfaceNodes[entry.startIndex], 'not-yet-exposed')
      continue
    }
    candidates.push({
      rangeStart: surfaceNodes[entry.startIndex],
      rangeEnd: surfaceNodes[entry.endIndex],
      surfaceStartIndex: entry.startIndex,
      surfaceEndIndex: entry.endIndex,
      shadowedSeqs: surfaceNodes.slice(entry.startIndex, entry.endIndex + 1),
      spanKind: entry.spanKind,
      callIds: entry.callIds,
      tools: entry.tools,
      sources: entry.sources,
      body: entry.body,
      chars: entry.body.length,
      originalTokens: sumTokens(measuredNodes, entry.startIndex, entry.endIndex),
      turn: entry.turn,
      step: entry.step,
      chunkCount: 1,
      withinRetention: entry.spanKind === SPAN_KINDS.OPERATION && entry.startIndex >= retentionFromIndex,
      inOpenTurn: Number.isInteger(openTurn) && Number.isInteger(entry.turn) && entry.turn >= openTurn,
      hasFailedResult: entry.hasFailedResult === true,
      // 插件自己注入的工作资料（状态卡/回注包）。仍然进候选——否则旧卡永远退不了
      // 热——但**不计入够批门槛**：卡片的产生与替换互为因果，若把卡片计入批次，
      // 插件会自己把批次凑满、替换后立刻重注入、再凑满，形成自激循环（实测 181 批
      // 里 484 条 turn.user 全是插件卡片）。由 planCooling 拆 countable/piggyback。
      pluginAuthored: entry.pluginAuthored === true,
    })
  }

  const skipped = [...skip.entries()]
    .map(([seq, reason]) => ({ seq, reason, description: describeHistorySkip(reason) }))
    .sort((a, b) => a.seq - b.seq)
  return { candidates, skipped, lastAssistantSeq }
}

function sumTokens(measuredNodes, startIndex, endIndex) {
  let total = 0
  for (let index = startIndex; index <= endIndex; index += 1) {
    total += measuredNodes[index]?.heuristicTokens ?? measuredNodes[index]?.tokens ?? 0
  }
  return total
}

/**
 * 一个助手节点 + 紧随其后的结果 = 一个工具操作单元。
 *
 * 与 v1 的差别只有一处：**失败结果不跳过**。失败结果是必要证据，所以它照样进
 * 单元，正文里带失败标记；只有「结果缺失/不成对/跨到另一个助手节点」才拒绝。
 */
function operationCandidateAt({ index, event, content, calls, eventOf, eventAtSeq, total, minimumChars, surfaceNodes }) {
  if (content.some((block) => block && block.type !== 'tool-call' && block.type !== 'text' && block.type !== 'reasoning')) {
    return { ok: false, reason: 'assistant-not-eligible' }
  }
  const callIds = calls.map((block) => (typeof block.id === 'string' ? block.id : ''))
  if (callIds.some((id) => !id)) return { ok: false, reason: 'no-call-id' }
  if (calls.some((block) => typeof block.name !== 'string' || !block.name)) {
    return { ok: false, reason: 'not-an-operation' }
  }
  // 结果必须紧跟在这些调用之后，并且都在活动面上。
  const resultSeqs = []
  for (let cursor = index + 1; cursor <= index + callIds.length; cursor += 1) {
    if (cursor >= total) return { ok: false, reason: 'unpaired' }
    if (eventOf(cursor)?.type === 'assistant/message') return { ok: false, reason: 'unpaired' }
    resultSeqs.push(surfaceNodes[cursor])
  }
  const built = operationEntriesOf({ content, callIds, resultSeqs, eventOf: eventAtSeq })
  if (!built.ok) return { ok: false, reason: built.reason }
  const body = buildOperationBody({ content, entries: built.entries })
  if (body.length < minimumChars) return { ok: false, reason: 'too-short' }
  return {
    ok: true,
    endIndex: index + callIds.length,
    spanKind: SPAN_KINDS.OPERATION,
    body,
    callIds,
    tools: built.entries.map((entry) => entry.name),
    sources: built.entries.map((entry) => ({
      callId: entry.callId,
      toolName: entry.name,
      blockIndex: entry.blockIndex,
      messageId: event.data?.message?.id ?? null,
      resultMessageId: entry.resultMessageId,
    })),
    turn: event.data?.turn ?? null,
    step: event.data?.step ?? null,
    hasFailedResult: built.hasFailedResult,
  }
}

const HISTORY_SKIP_DESCRIPTIONS = Object.freeze({
  'protected-system-head': '系统头保留在热上下文',
  'protected-latest-human-request': '当前人类请求（任务陈述）保留在热上下文',
  'protected-latest-user': '最新一条用户消息保留在热上下文',
  'protected-user-history': '全历史模式：人类消息保留在热上下文（不可压缩凭证之间的原始顺序）',
  'protected-receipt-voucher': '全历史模式：退热凭证不参与再退热（不可压缩）',
  'protected-plan-artifact': '计划工件（exit_plan_mode 调用与计划全文）全程保留在热上下文',
  'unreadable-event': '事件读不到（不猜内容）',
  'unsupported-surface-type': '本版本不认识的 surface 事件类型，不猜正文',
  'span-not-eligible': '含无法逐字保存的块（图片/附件/私有块）',
  'orphan-result': '工具结果没有配对调用，不能单独成段',
  'already-archived': '已经归档过',
  'not-yet-exposed': '主模型还没机会看到这段内容（当前回合）',
  'too-short': '太短，不值得单独归档',
  'no-call-id': '工具调用没有 callId，无法配对',
  'not-an-operation': '工具调用缺名字，不是合法操作',
  unpaired: '工具调用与结果没有同范围闭合',
  'no-content': '工具结果没有正文',
  'non-text-content': '工具结果含非文本块',
  'assistant-not-eligible': '助手消息含无法逐字保存的块',
})

export function describeHistorySkip(reason) {
  return HISTORY_SKIP_DESCRIPTIONS[reason] ?? reason
}
