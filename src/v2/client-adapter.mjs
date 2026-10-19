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
import { V2SessionStore, v2SessionDirectoryFor } from './store.mjs'
import { RECORD_KINDS, draftRecord } from './records.mjs'
import { SPAN_KINDS, spanLabelOf } from './history.mjs'
import { INDEX_TEXT_MAX_BYTES, exactPostfilterHit, isPluginAuthoredEntry, pluginAuthoredBody, searchRecords } from './retrieval.mjs'
import { planQuery } from './query-plan.mjs'
import { getForgetIndex, isForgotten } from './disposition.mjs'
import { coldRecordContent } from '../core.mjs'

const ARCHIVED_TAG = 'archived'

/** 插件来源跨度的回注标签：不冒充「用户消息」（D4）。 */
const PLUGIN_SPAN_LABEL = '插件工作资料'

/**
 * 回注信息量门槛（0.12.0 P1-3）：这条命中值不值得进意识层。
 *
 * 准入只看「有没有命中」不看「命中里有没有值得说的」，于是纯壳也会注入——
 * content 只有 `已归档…` 时，模型读到的是一句没有行动价值的话，还占预算。
 * 判据只认**结构事实**（范围 / 工具 / 片段种类 / 插件来源），不复述正文：
 * 复述正文等于撤销归档，会被下一次归档吃掉。
 */
export function hasInformativeStructure(entry) {
  if (!entry || typeof entry !== 'object') return false
  const range = entry.inline?.range
  if (range && Number.isInteger(range.start) && Number.isInteger(range.end)) return true
  const tools = entry.inline?.tools
  if (Array.isArray(tools) ? tools.length > 0 : (typeof tools === 'string' && tools !== '')) return true
  if (typeof entry.refs?.spanKind === 'string' && entry.refs.spanKind !== '') return true
  // nodeId 不算信息：它只是取回句柄，每条记录都有。
  return false
}

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

  /** P2 软遗忘：读面统一按 disposition 账本过滤（账本 = 唯一权威）。getForgetIndex
   * 自带按文件大小失效的进程缓存；账本损坏时返回带 damaged 标记的索引而不抛错
   * —— 读面带告警继续，写面（forget/undo）才失败关闭。 */
  const sessionDir = v2SessionDirectoryFor(labRoot, sessionId)

  async function currentForgetIndex() {
    return getForgetIndex(sessionDir)
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
            // P2：已遗忘的跨度不再复用——write-once 的「复用等于可读」会把已遗忘
            // 内容的可读性声明写回表面；重写同一 nodeId 同样拒绝，undo 恢复可见性
            // 后原有载荷原样可用，不需要新冷写。
            const forgetIndex = await currentForgetIndex()
            if (isForgotten(forgetIndex, existing.id)) {
              throw new Error(`v2 冷写拒绝：node ${nodeId} 已被软遗忘（forget undo 后可恢复）`)
            }
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
          // P2：已遗忘的跨度不回正文——getNode 是冷库正文的唯一精确回源口，
          // 恢复守卫在 runRestore，这里挡的是「按 nodeId 直接要原文」的旁路。
          const forgetIndex = await currentForgetIndex()
          if (isForgotten(forgetIndex, match.id)) {
            return { ok: false, error: 'forgotten' }
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
          const forgottenSpans = []
          const forgetIndex = await currentForgetIndex()
          for (const entry of entries) {
            if (!isArchivedSpan(entry)) continue
            // P2：遗忘的 span 不进回注候选面（计数单列，不与插件来源混算）。
            if (isForgotten(forgetIndex, entry.id)) {
              forgottenSpans.push(entry.id)
              continue
            }
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
          const rawNeedle = typeof query === 'string' ? query.trim() : ''
          // P1-1 查询规划：ID/路径/调用标识与引号短语走精确通道（AND、无门槛），
          // 剩余自然语言作为自由词元走 OR 召回 + 相关门槛。
          const plan = planQuery(rawNeedle)
          const needle = plan.text

          // 有查询词时走与工具面**同一条**多路检索；无词时按时间倒序取最近。
          // 语义后端未启动时 `backendFor` 返回 null，这里如实退化为字面匹配。
          let matched = []
          let matchedBy = 'recency'
          let semanticError = null
          let indexLag = null
          let indexGeneration = null
          let weakHits = null
          if (needle.length > 0 || plan.exact.length > 0) {
            const found = await searchRecords({
              store,
              backend: typeof backendFor === 'function' ? backendFor() : null,
              text: needle,
              exact: plan.exact,
              limit: bounded,
              literalMatcher: (entry, text) => spanHaystackOf(entry).includes(text.toLowerCase()),
              // P2：检索通道同口径过滤遗忘记录（searchRecords 命中前剔除 + 计数）。
              forgetIndex,
            })
            matchedBy = found.semanticUsed ? 'literal+semantic' : 'literal'
            semanticError = found.semanticError ?? null
            // P1-4 索引滞后披露：检索结果可能落后于库（同步间隙），如实带出
            // lag 计数供回注口径使用——命中不因滞后作废，但「没有更多信息」
            // 不冒充「库里只有这些」。
            indexLag = found.laggedRecords ?? null
            indexGeneration = found.indexGeneration ?? null
            // 只自动回注归档跨度：普通历史段的原文由模型按 ID 主动读取。
            matched = found.records.map((hit) => byId.get(hit.id)).filter(Boolean)
          }
          if (needle.length === 0 && plan.exact.length === 0) {
            // 无查询词：显式浏览语义，最近归档 span 倒序列出（插件卡已计入
            // excludedSpans 并排除，此处只剩人类/工具侧 span）。
            matched = spans.slice(-bounded).reverse()
          }
          // P1-8 no-match 零正文（用户拍板 2026-10-16）：有查询词而无命中时返回空
          // 命中，不再按时间倒序退回最近记录——「退回最近」会把无关内容装成相关
          // 证据注入活动面。无查询词的 recall 是显式浏览语义，保留最近列表。
          if ((needle.length > 0 || plan.exact.length > 0) && matched.length === 0) {
            // P1-6 状态区分：零命中先分清「为什么是零」，再报 matchedBy。
            // 语义后端失败且字面也没命中时不能宣称 no-match（检索面不完整）。
            const humanSpans = spans.length - excludedSpans.length
            // P2：零命中区分第五种成因——候选只有遗忘记录（区别于「还没有任何
            // 归档」与「全被插件来源过滤」）。混合场景仍报 no-match，由
            // excludedForgotten 计数披露遗忘贡献，不冒充「库里没有」。
            matchedBy = humanSpans === 0 && excludedSpans.length > 0
              ? 'all-filtered'
              : spans.length === 0 && forgottenSpans.length > 0
                ? 'forgotten'
                : spans.length === 0
                  ? 'not-ready'
                  : semanticError
                    ? 'backend-error'
                    : 'no-match'
          }
          // 0.10.1 弱候选导航（partial-match，pointerOnly）：强命中为零且检索面
          // 就绪（no-match 口径）时，若后端提供 queryDetailed 诊断且有弱重合候选，
          // 只给少量记录 ID 与词元重合说明——不注入正文、不凑 recent（PR #6 吸收
          // 项；弱重合是 query 级信号，不写回读计数）。T2 无 queryDetailed 时如实
          // 保持 no-match（能力缺口，不假造弱候选）。
          if (matchedBy === 'no-match') {
            const liveBackend = typeof backendFor === 'function' ? backendFor() : null
            if (liveBackend && typeof liveBackend.queryDetailed === 'function') {
              try {
                // 遗忘面（0.11.0，PR #8 P2-1）：弱候选必须同样带 exclude。遗忘后、下次
                // 索引同步前，倒排里仍可能留着已遗忘记录；弱指针会把它重新点名（虽不注入
                // 正文，但 ID 与「命中词元」本身就是披露）。
                const detail = await liveBackend.queryDetailed(needle, {
                  exact: plan.exact,
                  limit: bounded,
                  weakLimit: 3,
                  exclude: forgottenSpans,
                })
                const weakSpans = (Array.isArray(detail?.weak) ? detail.weak : [])
                  .map((w) => ({ weak: w, entry: byId.get(w.id) }))
                  .filter((pair) => pair.entry)
                // T3/F-09：弱候选与强命中走**同一份** exact 后验（纯函数
                // exactPostfilterHit）。此前两处各写一份判定，弱指针会带着「通过了
                // exact 闸门」的说法出现，而强命中用的是另一套规则。这里对每条弱
                // 候选重读正文套同一判定；不通过的如实丢弃（不把「弱」当免责）。
                const verifiedWeak = []
                for (const pair of weakSpans) {
                  let body = null
                  try {
                    const loaded = await store.readRecord(pair.weak.id, { verifyHash: false })
                    if (loaded && loaded.ok !== false) body = typeof loaded.payloadText === 'string' ? loaded.payloadText : null
                  } catch { body = null }
                  const exactVerified = exactPostfilterHit({
                    exactTokens: plan.exact,
                    body,
                    haystack: spanHaystackOf(pair.entry),
                  })
                  if (!exactVerified) continue
                  verifiedWeak.push({ ...pair, exactVerified })
                }
                if (verifiedWeak.length > 0) {
                  matchedBy = 'partial-match'
                  const weakNote = '（弱指针（不是命中）：以下记录与查询只有部分词元重合，不构成相关证据；只给 ID，不计入回读计数，本次未注入正文。）'
                  weakHits = verifiedWeak.map((pair) => {
                    const score = Number.isFinite(pair.weak.score) ? pair.weak.score : null
                    const coverage = Number.isFinite(pair.weak.coverage) ? pair.weak.coverage : null
                    return {
                      id: pair.weak.id,
                      nodeId: pair.entry.inline?.nodeId,
                      createdAt: pair.entry.createdAt,
                      range: pair.entry.inline?.range ?? null,
                      tools: pair.entry.inline?.tools ?? null,
                      tags: [ARCHIVED_TAG],
                      // T3/F-09：显式置信度字段——弱指针不是命中，读面/计数/渲染都据此
                      // 分流，不再靠字符串文案推断。
                      weakPointer: true,
                      isHit: false,
                      confidence: {
                        kind: 'weak',
                        score,
                        coverage,
                        exactVerified: pair.exactVerified,
                      },
                      content: `弱指针 ${pair.weak.id}（不是命中）：词元重合 ${pair.weak.matchedTerms?.join('、') ?? '(unknown)'}（覆盖 ${coverage ?? '?'}）；只给 ID，不计入回读计数；原文需按 ID 显式回读。`,
                    }
                  })
                  weakHits[0] = { ...weakHits[0], content: `${weakNote}\n${weakHits[0].content}` }
                }
              } catch { /* 诊断面失败保持 no-match（弱候选是加强信息，不反过来把回注打挂） */ }
            }
          }
          // 逐条正文里不重复自报（那是每条的噪声）；块首声明一次即可。检索口径必须
          // 出现在注入文本里，而不是只留在返回值字段里：模型看到的就是这段文本。
          const basisNote = needle.length === 0 && plan.exact.length === 0
            ? '（以下为最近归档记录，按时间倒序列出；本次没有查询词，未做相关性检索。）'
            : `（以下为与问题「${rawNeedle}」的检索命中，来源：${matchedBy === 'literal+semantic' ? '字面索引 + 语义后端' : '内置字面索引'}${indexLag && indexLag > 0 ? `；索引落后于库 ${indexLag} 条记录（第 ${indexGeneration} 代），未覆盖的记录不参与命中` : ''}。）`
          // 0.10.1 R1-F4a：检索命中保持 searchRecords 的相关性顺序（字面命中按
          // 条目序、语义命中按后端排名，最相关在前），不再整体倒置——此前
          // slice(-bounded).reverse() 把语义 top-k 倒序（best 排最后）且字面命中
          // ≥limit 时把语义命中挤出窗口。无查询词的 recency 浏览分支保持倒序
          // （最新在前，与 basisNote 的「按时间倒序」声明一致）。
          const ordered = needle.length > 0 || plan.exact.length > 0
            ? matched.slice(0, bounded)
            : matched.slice(-bounded).reverse()
          const hits = ordered
            // 0.12.0 P1-3：回注信息量门槛。命中项必须至少有一条**结构事实**可讲
            // （范围 / 工具 / 片段种类 / 插件来源标签）。三样都取不到的纯壳不注入——
            // 它只会占预算，而模型从「已归档 xxx」里读不出任何可行动的信息。
            .filter((entry) => hasInformativeStructure(entry))
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
                // id 取稳定记录 ID：回注里的每一条都能被精确回读（`/memory-lab read <id>`）。
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
          // excludedForgotten：被软遗忘挡在回注面之外的 span 数（P2 读面统一可见性）。
          return { hits: weakHits ?? hits, matchedBy, semanticError, indexLag, indexGeneration, excludedPluginAuthored: excludedSpans.length, excludedForgotten: forgottenSpans.length }
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