/**
 * v2 隔离客户端适配器：把 apply 管线对「冷库客户端」的窄接口
 * （rememberArchived / getNode / recall）映射到本会话 v2 隔离存储。
 *
 * 设计边界：
 * - 数据不出会话隔离根：写入是本会话 v2 库里的 synthesized 投影跨度记录，
 *   不碰真实灵枢；读取按 node_id 精确回源。
 * - 与 v1 冷库逐字节兼容：getNode 返回的 content 用 core.coldRecordContent
 *   的同一构建器重建成 v1 正文格式，使 v1 的回执/恢复/校验管线原样可用；
 *   v1 规范化会剥掉恰好一个尾随 \n，因此重建时补回一个。
 * - recall 与工具/命令面的检索走**同一条多路检索**（内置字面索引 + 可选的隔离灵枢
 *   语义后端），命中按 seq 倒序返回，配合 apply 管线的相关性过滤使用。
 *   两条路径共用 `searchRecords`，因此后端形状、外部 ID 映射与降级语义完全一致 ——
 *   自动回注和模型主动读取不会出现「一边接了灵枢、另一边只做关键词」的分裂。
 */
import { V2SessionStore } from './store.mjs'
import { RECORD_KINDS, draftRecord } from './records.mjs'
import { SPAN_KINDS, spanLabelOf } from './history.mjs'
import { INDEX_TEXT_MAX_BYTES, isPluginAuthoredEntry, pluginAuthoredBody, searchRecords } from './retrieval.mjs'
import { coldRecordContent } from '../core.mjs'

const ARCHIVED_TAG = 'archived'

/** 插件来源跨度的回注标签：不冒充「用户消息」（D4）。 */
const PLUGIN_SPAN_LABEL = '插件工作资料'

function spanInlineFromArgs({ nodeId, text, range, tools, callIds, contentHash, chunk, chunkCount, pluginAuthored = false }) {
  return {
    nodeId,
    chunk,
    chunkCount,
    contentHash,
    range: range ?? null,
    tools: tools ?? null,
    callIds: callIds ?? null,
    // D4：作者事实随记录落库（unit.pluginAuthored 由 apply 管线传入）。检索索引
    // 同步与命中过滤、回注文案都按它区分插件工作资料与人类消息。
    pluginAuthored: pluginAuthored === true,
  }
}

/** 归档跨度记录的统一判定：有 spanKind 且有 nodeId。 */
function isArchivedSpan(entry) {
  return typeof entry?.refs?.spanKind === 'string' && entry.refs.spanKind.length > 0
    && typeof entry?.inline?.nodeId === 'string'
}

/**
 * 归档跨度的字面检索面：覆盖**真实归档字段**——nodeId、范围、工具名、callId、
 * 跨度种类、内容哈希。这些正是回执和工具描述对模型宣称可搜的字段，
 * 宣称了就必须真能搜到（与工具面 `entryMatchesLiteral` 同口径）。
 */
function spanHaystackOf(entry) {
  const inline = entry?.inline ?? {}
  const parts = [
    inline.nodeId,
    entry?.refs?.spanKind,
    inline.contentHash,
    Array.isArray(inline.tools) ? inline.tools.join(' ') : inline.tools,
    Array.isArray(inline.callIds) ? inline.callIds.join(' ') : inline.callIds,
    typeof inline.range === 'string' ? inline.range : null,
    Number.isFinite(inline.range?.start) ? `${inline.range.start}-${inline.range.end}` : null,
  ]
  return parts.filter((value) => typeof value === 'string').join(' ').toLowerCase()
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * 由真实来源坐标生成工具配对索引记录草案（纯函数，不写盘）。
 *
 * refs 严格照 `records.mjs` 的封闭集与必填规则填写：
 * - `operation.call`   → `{ callId, messageId, toolName, blockIndex }`
 * - `operation.result` → `{ callId, resultMessageId }`
 *
 * 任一必填项缺失就**不写**这条索引，并在 `skip` 里如实报出缺哪个字段：
 * 既不写伪造值、也不放宽 schema，更不静默丢弃。
 */
export function pairingRecordsFor({ sources, callIds, tools, staged }) {
  const out = []
  const spanRecordId = staged.id
  const nodeId = staged.inline?.nodeId ?? null
  const toolList = Array.isArray(tools) ? tools.filter((name) => nonEmptyString(name)) : []

  if (!Array.isArray(sources)) {
    const ids = Array.isArray(callIds) ? callIds.filter((id) => nonEmptyString(id)) : []
    if (ids.length > 0) {
      out.push({ skip: { callId: null, reason: 'missing-source-coordinates', count: ids.length } })
    }
    return out
  }

  for (const [index, source] of sources.entries()) {
    const callId = nonEmptyString(source?.callId)
    const messageId = nonEmptyString(source?.messageId)
    const toolName = nonEmptyString(source?.toolName) ?? toolList[index] ?? null
    const blockIndex = Number.isSafeInteger(source?.blockIndex) && source.blockIndex >= 0 ? source.blockIndex : null
    const resultMessageId = nonEmptyString(source?.resultMessageId)

    const missingCall = []
    if (!callId) missingCall.push('callId')
    if (!messageId) missingCall.push('messageId')
    if (!toolName) missingCall.push('toolName')
    if (blockIndex === null) missingCall.push('blockIndex')
    if (missingCall.length > 0) {
      out.push({ skip: { callId, reason: `call-missing-${missingCall.join('+')}` } })
    } else {
      out.push({
        record: {
          kind: RECORD_KINDS.OPERATION_CALL,
          seq: 0,
          fidelity: 'synthesized',
          refs: { callId, messageId, toolName, blockIndex },
          inline: { callId, toolName, messageId, blockIndex, spanRecordId, nodeId },
        },
      })
    }

    if (!callId) continue
    if (!resultMessageId) {
      out.push({ skip: { callId, reason: 'result-missing-resultMessageId' } })
      continue
    }
    out.push({
      record: {
        kind: RECORD_KINDS.OPERATION_RESULT,
        seq: 0,
        fidelity: 'synthesized',
        refs: { callId, resultMessageId },
        inline: { callId, resultMessageId, toolName, spanRecordId, nodeId },
      },
    })
  }
  return out
}

export function createV2ClientFactory({ labRoot, sessionId, logger = null, backendFor = null }) {
  let sharedStore = null

  async function acquireStore() {
    if (sharedStore === null) {
      sharedStore = await V2SessionStore.init({ labRoot, sessionId })
    }
    return sharedStore
  }

  async function releaseStore() {
    if (sharedStore !== null) {
      const store = sharedStore
      sharedStore = null
      try {
        await store.close()
      } catch (error) {
        logger?.warn?.(`v2 客户端关闭存储失败：${error?.message ?? error}`)
      }
    }
  }

  /** 在目录缓存里按 nodeId 找已落库的跨度记录（目录在内存，成本可忽略）。 */
  function findSpanEntry(store, nodeId) {
    const { entries } = store.listEntries({ limit: store.recordCount + 1 })
    return entries.find((entry) => entry.inline?.nodeId === nodeId && isArchivedSpan(entry)) ?? null
  }

  return {
    /**
     * 借用本会话的共享库句柄执行只读工作。
     *
     * 存在的理由：同一会话目录在本进程内只允许一个 `V2SessionStore` 句柄，
     * 而运行时的 status/read/history/working-set 也要读同一个库。让它们借用
     * 这个句柄，比放开单句柄约束更安全——约束本身就是防重复打开的护栏。
     */
    async withStore(work) {
      const store = await acquireStore()
      return work(store)
    },
    async createClient() {
      const store = await acquireStore()
      return {
        async rememberArchived({ nodeId, text, range, tools, callIds, sources = null, spanKind = null, contentHash = null, chunk = null, chunkCount = null, pluginAuthored = false, signal }) {
          if (signal?.aborted) throw new Error('aborted')
          if (typeof text !== 'string' || text.length === 0) {
            throw new Error('v2 冷写需要非空正文')
          }
          const kind = nonEmptyString(spanKind) ?? SPAN_KINDS.OPERATION
          // 写一次（write-once）：同一 nodeId 已有同哈希载荷则复用（重试幂等）；
          // 同 nodeId 不同哈希按冷写冲突失败关闭，绝不覆盖。
          const existing = findSpanEntry(store, nodeId)
          if (existing) {
            if (existing.inline?.contentHash && contentHash && existing.inline.contentHash !== contentHash) {
              throw new Error(`v2 冷写冲突：node ${nodeId} 已持有不同内容（write-once 保护）`)
            }
            return { ok: true, committed: false, reused: true, recordId: existing.id, nodeId }
          }
          const txn = await store.openTransaction()
          try {
            const draft = draftRecord({
              kind: RECORD_KINDS.PROJECTION_SPAN,
              seq: 0,
              fidelity: 'synthesized',
              refs: {
                sourceKinds: kind,
                sourceSeqs: String(range?.start ?? ''),
                spanKind: kind,
              },
              inline: spanInlineFromArgs({ nodeId, text, range, tools, callIds, contentHash, chunk, chunkCount, pluginAuthored }),
              content: text,
            })
            const staged = await store.stageRecord(txn, draft)
            // 结构化配对账本：同一次归档的调用与结果各落一条索引记录（先调用后结果），
            // 使「在途动作 / 未闭合工具配对」在重启后仍可判定，而不是只活在内存里。
            // 索引记录不复制正文，用 refs 指向不可变的跨度载荷。
            //
            // refs 只允许写真实来源坐标（records.mjs 的封闭集 + 必填规则）。
            // 来源由 apply 管线从宿主事件里读出并随单元传递；这里缺什么就跳过什么，
            // 既不放宽 schema，也不编造 messageId/toolName/blockIndex。
            // 多段载荷只在第一段写一次配对索引，避免同一工具组被重复记账。
            const pairingNotes = []
            if (chunk === null || chunk === 1) {
              for (const note of pairingRecordsFor({ sources, callIds, tools, staged })) {
                if (note.skip) {
                  pairingNotes.push(note.skip)
                  continue
                }
                await store.stageRecord(txn, draftRecord(note.record))
              }
            }
            await store.commitTransaction(txn)
            return { ok: true, committed: true, recordId: staged.id, nodeId, pairingNotes }
          } catch (error) {
            try {
              await store.abandonTransaction(txn)
            } catch {
              // 放弃失败不掩盖原错误。
            }
            throw error
          }
        },

        async getNode(nodeId, signal) {
          if (signal?.aborted) throw new Error('aborted')
          const match = findSpanEntry(store, nodeId)
          if (!match) {
            return { ok: false, error: 'not-found' }
          }
          const loaded = await store.readRecord(match.id)
          if (!loaded.ok || typeof loaded.payloadText !== 'string') {
            return { ok: false, error: loaded.integrity ?? 'unreadable' }
          }
          const inline = match.inline ?? {}
          const content = coldRecordContent({
            sessionId,
            range: inline.range ?? undefined,
            tools: inline.tools ?? undefined,
            callIds: inline.callIds ?? undefined,
            text: loaded.payloadText,
            contentHash: inline.contentHash ?? null,
            chunk: inline.chunk ?? null,
            chunkCount: inline.chunkCount ?? null,
          })
          // lingshu 冷库正文恰带一个尾随 \n；v1 的 normalizeColdBody 依赖这个形状。
          return { ok: true, content: `${content}\n` }
        },

        async recall(query, signal, limit = 5) {
          if (signal?.aborted) throw new Error('aborted')
          const { entries } = store.listEntries({ limit: store.recordCount + 1 })
          // D4：插件来源的归档跨度（工作状态卡/回注包/回执沉入冷库的记录）不进回注
          // 候选面——它们是插件自己的工作资料，回注给模型等于把插件输出说成历史证据；
          // 旧记录没有 inline 标记，用已读到的正文前缀兜底（这里是候选集的子集，逐条
          // 有界读取成本可控）。人类消息与工具操作的 span 照常参与。
          const spanEntries = []
          const excludedSpans = []
          for (const entry of entries) {
            if (!isArchivedSpan(entry)) continue
            if (isPluginAuthoredEntry(entry)) {
              excludedSpans.push(entry.id)
              continue
            }
            const loaded = await store.readRecord(entry.id, { verifyHash: false, maxBytes: INDEX_TEXT_MAX_BYTES })
            const body = loaded.ok === false || typeof loaded.payloadText !== 'string' ? null : loaded.payloadText
            if (body !== null && pluginAuthoredBody(body)) {
              excludedSpans.push(entry.id)
              continue
            }
            spanEntries.push(entry)
          }
          const spans = spanEntries
          const byId = new Map(spans.map((entry) => [entry.id, entry]))
          const bounded = Math.max(1, limit)
          const needle = typeof query === 'string' ? query.trim() : ''

          // 有查询词时走与工具面**同一条**多路检索；无词时按时间倒序取最近。
          // 语义后端未启动时 `backendFor` 返回 null，这里如实退化为字面匹配。
          let matched = []
          let matchedBy = 'recency'
          let semanticError = null
          if (needle.length > 0) {
            const found = await searchRecords({
              store,
              backend: typeof backendFor === 'function' ? backendFor() : null,
              text: needle,
              limit: bounded,
              literalMatcher: (entry, text) => spanHaystackOf(entry).includes(text.toLowerCase()),
            })
            matchedBy = found.semanticUsed ? 'literal+semantic' : 'literal'
            semanticError = found.semanticError ?? null
            // 只自动回注归档跨度：普通历史段的原文由模型按 ID 主动读取。
            matched = found.records.map((hit) => byId.get(hit.id)).filter(Boolean)
          }
          // 查询无命中时退回最近跨度，保证回注不空转（v1 recall 同语义）。但退回必须
          // **如实自报家门**：命中为空是「没有相关记录」，最近 N 条是「时间上最近」，
          // 两者在模型面前不能长得一样（审计 P2-5(b)：4 个回注块逐字节相同，而前缀却
          // 宣称它们「与当前问题相关」）。所以退回结果带上非相关的固定说明，并回显本次
          // 查询词——这样「没命中」这件事不会被冒充成「相关命中」，不同问题也不会得到
          // 逐字节相同的块。
          const fellBack = matched.length === 0 && spans.length > 0
          if (fellBack) {
            matched = spans.slice(-bounded)
            matchedBy = needle.length > 0 ? 'recency-fallback' : 'recency'
          }
          // 逐条正文里不重复自报（那是每条的噪声）；块首声明一次即可。检索口径必须
          // 出现在注入文本里，而不是只留在返回值字段里：模型看到的就是这段文本。
          const basisNote = !fellBack
            ? `（以下为与问题「${needle}」的检索命中，来源：${matchedBy === 'literal+semantic' ? '字面索引 + 语义后端' : '内置字面索引'}。）`
            : (needle.length > 0
              ? `（以下为最近归档记录，**不是**与问题「${needle}」的相关命中：本次检索没有任何记录匹配该问题，故按时间倒序退回最近 ${Math.min(bounded, spans.length)} 条。${semanticError ? `语义检索后端不可用：${semanticError}。` : ''}）`
              : '（以下为最近归档记录，按时间倒序列出；本次没有查询词，未做相关性检索。）')
          const hits = matched
            .slice(-bounded)
            .reverse()
            .map((entry) => {
              // range 是 `{start,end}` 对象：直接插值会渲染成 [object Object]。
              const range = entry.inline.range
              const rangeText = range && Number.isInteger(range.start) && Number.isInteger(range.end)
                ? `${range.start}–${range.end}`
                : '未知范围'
              const toolsText = Array.isArray(entry.inline.tools)
                ? entry.inline.tools.join(',')
                : (entry.inline.tools ?? '未记录')
              const label = isPluginAuthoredEntry(entry) ? PLUGIN_SPAN_LABEL : spanLabelOf(entry.refs?.spanKind)
              const detail = entry.refs?.spanKind === SPAN_KINDS.OPERATION
                ? `范围 ${rangeText}；工具 ${toolsText}`
                : `范围 ${rangeText}`
              return {
                // id 取稳定记录 ID：回注里的每一条都能被精确回读（`/memory-lab2 read <id>`）。
                id: entry.id,
                nodeId: entry.inline.nodeId,
                createdAt: entry.createdAt,
                range: entry.inline.range ?? null,
                tools: entry.inline.tools ?? null,
                tags: [ARCHIVED_TAG],
                content: `已归档${label} ${entry.inline.nodeId}（${detail}）。原文可用记录 ID ${entry.id} 精确回读。`,
              }
            })
          if (hits.length > 0 && basisNote) {
            // 说明挂在**第一条**命中的正文前：下游把 hits 拼成注入块时，这句话出现在
            // 块首，与「命中还是最近退回」这个事实同时到达模型；同时也让不同问题拿到
            // 不同的块（审计 P2-5(b)：旧实现里 4 个不同问题的块逐字节相同）。
            hits[0] = { ...hits[0], content: `${basisNote}\n${hits[0].content}` }
          }
          // matchedBy/semanticError 如实透出：调用方据此知道本次是字面命中还是
          // 语义命中、后端是否报错，而不是笼统地把两者都说成「检索到了」。
          // excludedPluginAuthored 同理：因插件来源被挡在回注面之外的 span 数（D4）。
          return { hits, matchedBy, semanticError, excludedPluginAuthored: excludedSpans.length }
        },

        async probeReceiptView() {
          // v2 存储不依赖外部视图参数，探针恒支持。
          return { supported: true }
        },

        async close() {
          await releaseStore()
        },
      }
    },
    async dispose() {
      await releaseStore()
    },
  }
}
