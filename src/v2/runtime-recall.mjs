/**
 * v2 检索域（0.13.1 P4c）。
 *
 * 从 `runtime.mjs` 摘出：字面检索（命令面与模型可见工具共用同一条路径）、
 * 命中归因、查询词生成、增量索引与检索触发判定。函数体**逐字搬移**，语义零改动。
 *
 * ## 装配契约
 * `createRecallDomain({...})` 收：
 *   - **句柄与读取原语**（`withReadableStore` / `readWithForkFallback`）——由
 *     read 域提供，因此装配顺序是 read → recall；
 *   - **检索后端访问器**（`backendFor` / `backendForSession`）与预算常量；
 *   - **宿主上下文**（`labRoot` / `logger` / `sessionIdOf` / `recallQueryFrom`）。
 *
 * ## 口径
 * 检索**只返回元数据与命中理由**，正文一律按记录 ID 单独回读——命中结果里塞
 * 正文会让「按需」变成「无条件」，这是成本纪律而非功能限制。
 * 后端未注入时如实标 `matchedBy: 'literal'`，不假装做过语义检索。
 *
 * ## 不适用条件
 * `indexCommand sync` 是本域唯一会启动后端子进程的入口；检索本身从不隐式启动。
 */
import { randomUUID } from 'node:crypto'
import { MAX_RECALL_QUERY_CHARS, PACKAGE_NAME, escapePromptBraces, renderRecallBlock } from '../core.mjs'
import { rangeTokenOf } from './runtime-render.mjs'
import { v2SessionDirectoryFor } from './state.mjs'
import { readByAlias } from './runtime-read.mjs'
import { compareRecordIds, parseRecordId } from './records.mjs'
import { getForgetIndex } from './disposition.mjs'
import { BYTES_PER_TOKEN, estimateTokensOf, parseBudgetTokens, RECALL_DEFAULT_BUDGET_TOKENS, RECALL_MAX_BUDGET_TOKENS, RECALL_MAX_QUERY_HITS } from './budget.mjs'
import { CURSOR_MODES, encodeCursor, requireCursor } from './cursor.mjs'
import { INDEX_TEXT_MAX_BYTES, renderToolOutput, toToolValue } from './tool.mjs'
import { searchRecords, syncRetrievalIndex, readRetrievalIndex } from './retrieval.mjs'
import { planQuery } from './query-plan.mjs'
import { annotateStale } from './verification.mjs'
import { WORKING_SET_DEFAULTS } from './working-state.mjs'

export function createRecallDomain({
  records,
  engine,
  factoryFor,
  adopt,
  persistCost,
  backendFor,
  backendForSession,
  labRoot,
  logger,
  sessionIdOf,
  recallQueryFrom,
  RECALL_STEP_FALLBACK,
  withReadableStore,
  readWithForkFallback,
  cardFromStore,
  semanticBackend,
  semanticBackendFor,
  semanticBackendEnsure,
  latestReadPathOf,
}) {

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
    // R-01（beta.4）：这里曾有一个 `if (budgetPlan.clamped)` 死分支——parseBudgetTokens
    // 在超上限时返回 ok:false（上面已经返回结构化错误），从不会产出 clamped:true，
    // 也没有 requested 字段。删掉，免得「按上限执行」这条从未发生过的披露继续
    // 留在读路径上误导下一个改这里的人。
    const budgetNotes = []
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
        // Y-22：旁证目录从 labRoot + sessionId 直接算，不依赖进程内 record（重启后仍生效）。
        const staleMarks = await annotateStale({
          sessionDir: records.get(sessionId)?.directory ?? v2SessionDirectoryFor(labRoot, sessionId),
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
                // Y-36：失败行（回读不到、解析失败）没有产生任何正文，
                // 却推进预算游标——它们会把真正可读的记录挤出预算窗口。
                // 失败要如实列出，但不得计费：
                // 预算是「已交回的正文量」，不是「尝试过的条数」。
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
            ? `⚠ 该记录已被人工标记为失效（${staleMark.reason}）；引用前请先 /memory-lab verify。\n`
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
          warnings.push(`已软遗忘记录 ${found.forgottenFiltered} 条被剔除、不参与命中${zeroNote}；恢复可见性用 /memory-lab forget undo`)
        }
        if (found.semanticError) {
          warnings.push(`语义检索后端不可用，已降级为内置字面索引：${found.semanticError}`)
        } else if (!found.semanticUsed) {
          // 没接上语义后端时如实说清楚**字面索引到底覆盖什么**：它不只覆盖元数据，
          // 还覆盖每条记录 ≤8 KiB 的正文词元（含中文二元组）。旧文案写「不含正文词」，
          // 把模型劝退回 tools.read（P1-7 / G4）。
          warnings.push('本次只走内置字面索引（覆盖记录 ID、种类、工具名、callId、seq 范围，'
            + '以及每条记录 ≤' + (INDEX_TEXT_MAX_BYTES / 1024) + ' KiB 的正文词元（含中文二元组））；'
            + '需要更强的语义召回时先 `/memory-lab index sync` 启动语义后端，'
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
      // 0.12.0 P0-1：三路拆分。工具面与命令面**互不覆盖**——把两条入口混成一个数，
      // 正是「插件以为自己回读 0 次」的原因。auto（自动回注）不计入这两路。
      if (attribution === 'tool') record.cost.bump('toolRecallReads', 1)
      else if (attribution === 'command') record.cost.bump('commandRecallReads', 1)
    }
    record.cost.bump('recallReads', 1)
    record.cost.bump('recallReturnedTokens', tokens)
    record.lastAction = `recall:${result.mode}:${attribution}`
    await persistCost(record)
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

  /**
   * 命令参数里的预算：命令面拿到的是字符串，先严格转成整数再交给统一校验，
   * 避免 `"abc"`、`"12.5"` 被 `parseInt` 悄悄截成别的数字。
   */

  async function recallCommand(invocation, args) {
    const sessionId = sessionIdOf(invocation.agent.session)
    const useIds = args[0] === 'id'
    const rest = useIds ? args.slice(1) : args
    // Y-23：帮助文本承诺了 `recall id <ID> [预算]`，但这里把整串都当记录 ID，
    // 于是 `recall id mcl2-… 800` 会拿「800」去回读一条不存在的记录，
    // 白占一行失败项还挤掉真实预算。判据只有一处：末位是纯数字且前面还有 id 时，
    // 它才是预算；否则一律当 id（ID 本身不可能是纯数字）。
    const numericTail = useIds && rest.length >= 2 && /^\d+$/.test(rest[rest.length - 1])
    const idArgs = numericTail ? rest.slice(0, -1) : rest
    const budget = numericTail ? Number(rest[rest.length - 1]) : undefined
    const ids = useIds ? idArgs.flatMap((arg) => arg.split(',')).filter(Boolean) : []
    const query = useIds ? null : (rest.join(' ').trim() || null)
    const result = await recall(sessionId, { recordIds: ids, query, budget, session: invocation.agent.session })
    // 复用工具渲染：命令面与模型可见工具看到的是同一份措辞。
    return { kind: 'success', text: renderToolOutput(sessionId, toToolValue(sessionId, result)) }
  }

  /**
   * `/memory-lab index [status]`：增量索引状态与同步。
   *
   * 没有注入语义后端时如实报告「未接后端」，不假装索引可用。
   */
  async function indexCommand(invocation, args) {
    const sessionId = sessionIdOf(invocation.agent.session)
    // Y-11（beta.7 B 组）：重启后必须先 adopt 再判，否则与 status 自相矛盾。
    const record = records.get(sessionId) ?? await adopt(invocation.agent)
    if (!record) return { kind: 'error', text: 'v2 引擎在本会话未启用。' }
    // 0.13.2-beta.6 G10（store/p-07 W5/W7/W7b）：**子命令必须先校验再执行**。
    //
    // 收口前这里写的是 `(args[0] ?? 'status') === 'status'`——于是**任何**拼错
    // 的子命令（`index syn`、`index stauts`）都落到 statusOnly=false，也就是
    // 「执行同步」分支：不仅拉起后端子进程，还真的去索引。
    // 「不在白名单里」被当成了「就是另一个合法取值」，这是二值化枚举的典型错。
    // 现在先归一化再分派：不认识的参数一律回用法错误，不执行任何副作用。
    const subcommand = args[0] ?? 'status'
    if (subcommand !== 'status' && subcommand !== 'sync') {
      return {
        kind: 'error',
        text: `用法：\`/memory-lab index\`（查看状态）或 \`/memory-lab index sync\`（执行同步）。收到的是「${subcommand}」。`,
      }
    }
    if (args.length > 1) {
      return {
        kind: 'error',
        text: `用法：\`/memory-lab index [status|sync]\` 不接受额外参数。收到 ${args.length} 个：${args.map((a) => `「${a}」`).join(' ')}`,
      }
    }
    const statusOnly = subcommand === 'status'
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
          '此时 /memory-lab recall 与 memory_lab_recall 只走内置字面匹配；',
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

  function recallTriggerOf(record, decision, query, position) {
    if (query) return { kind: 'query', id: query.id, text: query.text }
    // 1) 重读同一文件
    try {
      const lastRead = latestReadPathOf(decision.messages)
      if (lastRead && record.lastRecallReadPath === lastRead.path
        && record.lastRecallReadSeq !== lastRead.seq) {
        record.lastRecallReadPath = lastRead.path
        record.lastRecallReadSeq = lastRead.seq
        return { kind: 'reread', id: 'reread:' + lastRead.path + ':' + lastRead.seq, text: lastRead.path }
      }
      if (lastRead) {
        record.lastRecallReadPath = lastRead.path
        record.lastRecallReadSeq = lastRead.seq
      }
    } catch {
      // 触发点判定失败不阻塞主流程。
    }
    // 2) 步数兜底
    // Y-00（beta.7）：步号只在**宿主传入的 position** 里。`decision` 是 next() 的
    // 返回值（`{kind, messages}`），从来没有 step 字段——读它等于这条兜底永不触发。
    const step = Number(position?.step ?? decision?.step ?? decision?.turn?.step)
    if (Number.isInteger(step)) {
      const last = Number(record.lastRecallStep)
      if (!Number.isInteger(last) || step - last >= RECALL_STEP_FALLBACK) {
        record.lastRecallStep = step
        return { kind: 'step', id: 'step:' + step, text: '' }
      }
    }
    return null
  }

  async function buildRecall(agent, decision, signal, position = null) {
    const record = await adopt(agent)
    if (!record || !engine.settingsOf(record).autoRecall) return decision
    // P0-2：restore-skipped 行的原件仍在冷库且回执在活动面上，回注与工作卡
    // 一样以「是否有冷库依赖」为闸门，跳过行同样算依赖。
    if (engine.pendingReceipts(record).length === 0 && engine.restoreSkippedReceipts(record).length === 0) return decision
    const query = recallQueryFrom(decision.messages)
    const trigger = recallTriggerOf(record, decision, query, position)
    if (!trigger) return decision
    // 去重：同一触发 id 只回注一次。
    if (record.recallQueryId === trigger.id) return decision
    record.recallQueryId = trigger.id
    const digest = await engine.buildRecall(record, String(trigger.text ?? '').slice(0, MAX_RECALL_QUERY_CHARS), signal)
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
    const messageId = randomUUID()
    // G6：回注去重链的写端。`engine.buildRecall` 每次都调 `pruneRecallDeliveries`
    // 读 `record.recallDeliveries` 判断「同一证据是否还在活动面上」，但**全仓没有
    // 一处写它**（`rememberRecall` 定义了、导出了、零调用）——于是每次回注都算
    // 「新鲜」，同一批命中被反复注入。这里补上写端：只有真的注入了才登记。
    try {
      engine.rememberRecall(record, {
        messageId,
        nodeIds: (Array.isArray(digest.hits) ? digest.hits : []).map((hit) => hit?.id).filter((id) => typeof id === 'string' && id),
        queryId: trigger.id,
        status: digest.status,
        reason: digest.reason ?? '',
        hits: Array.isArray(digest.hits) ? digest.hits.length : 0,
        skippedVisible: digest.skippedVisible ?? 0,
        truncated: digest.truncated === true,
        omitted: digest.omitted ?? 0,
      })
    } catch (error) {
      // 登记失败只影响去重，不影响已注入的正文：不吞掉注入，但要留痕。
      logger?.warn?.(`v2 回注登记失败：${error?.message ?? error}`)
    }
    return {
      ...decision,
      messages: [...decision.messages, {
        id: messageId,
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: PACKAGE_NAME, form: 'recall' },
      }],
    }
  }

  return {
    recall,
    recallCommand,
    indexCommand,
    buildRecall,
  }
}
