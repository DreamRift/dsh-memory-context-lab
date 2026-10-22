/**
 * v2 只读面域（0.13.1 P4c）。
 *
 * 从 `runtime.mjs` 摘出：状态、精确回读、分页历史、检索（命令面与工具面共用）、
 * 验证跟踪、关系与成本报表，共 20 个函数、约 900 行。函数体**逐字搬移**，语义
 * 零改动；原本从闭包自由读取的名字改为显式注入。
 *
 * ## 装配契约
 * `createReadDomain({...})` 收两类依赖：
 *   - **只读访问器**（`records` / `engine` / `factoryFor` / `backendFor` /
 *     `backendForSession` / `adopt` / `persistCost` / `cardFromStore`）——
 *     除 `persistCost` 外都不写账本；`persistCost` 只在读取租约记账后落盘；
 *   - **宿主上下文**（`labRoot` / `logger` / `sessionIdOf` / `recallQueryFrom`）。
 *
 * ## 边界
 * 本域是**恒定只读面**：`read` / `history` / `recall` / `status` / `cost` 都不
 * 替换投影、不改账本正文；`verify` 只补采缺失指纹；`mark-stale` 只写旁证。
 * 真正的写路径（启用/停用/降温/遗忘）不在这里。
 *
 * ## 不适用条件
 * `indexCommand sync` 会显式启动语义后端子进程——那是**唯一**的副作用入口，
 * 由调用方（命令面）决定是否触发，本域不自行启动。
 */
import { formatRange, renderReadResults, renderV2Status } from './runtime-render.mjs'
import { readV2SessionState } from './state.mjs'
import { V2SessionStore } from './store.mjs'
import { parseRecordId } from './records.mjs'
import { MAX_PAGE_SIZE, readRecordById, listRecordsPage, packWorkingSet, resolvePageSize } from './readback.mjs'
import { resolveReadTargets } from './identity-index.mjs'
import { nodeUnitBase } from './disposition.mjs'
import { estimateTokensOf, estimateTokensOfBytes, WORKING_SET_MAX_BUDGET_TOKENS } from './budget.mjs'
import { readForkMap } from './fork.mjs'
import { renderCostReport } from './cost.mjs'
import { loadReadLedger, summarizeReadLedger } from './read-ledger.mjs'
import { readRetrievalIndex, describeRecordRelations } from './retrieval.mjs'
import { getForgetIndex } from './disposition.mjs'
import { syncVerification, checkRecords, markRecordsStale, annotateStale } from './verification.mjs'
import { WORKING_SET_DEFAULTS } from './working-state.mjs'

/** `/memory-lab history` 未给每页条数时的默认值（原语层的默认是 200，命令面更小）。 */
const HISTORY_DEFAULT_PAGE_SIZE = 20

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
export async function readByAlias(store, labRoot, sessionId, target, { maxBytes = null } = {}) {
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

export function createReadDomain({
  records,
  engine,
  factoryFor,
  adopt,
  persistCost,
  cardFromStore,
  backendFor,
  backendForSession,
  labRoot,
  logger,
  sessionIdOf,
  recallQueryFrom,
  semanticBackendStatus,
  semanticBackendFailure,
  RECALL_STEP_FALLBACK,
  parseBudgetArg,
}) {
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
        return { kind: 'success', text: 'v2 引擎在本会话未启用。用 `/memory-lab on` 启用。' }
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
    extra.readLedger = await readLedgerLines(record)
    return { kind: 'success', text: renderV2Status(record, extra) }
  }

  /**
   * 状态面的「重复读取」行（0.12.0 P0-2）。
   *
   * 两个口径分开报，绝不混用（方案 P0-2 的复算纪律）：
   * - 口径 A = 重读字符 / 全部内容字符；
   * - 口径 B = 内容完全未变的重读 / 全部内容字符。
   *
   * 分母只取**本账本能看见的字符**：账本 0.12.0 才有，历史重读不在里面，
   * 所以这里标「本账本口径」而不是「会话口径」——不把看不见的部分算成 0。
   */
  async function readLedgerLines(record) {
    const ledger = await loadReadLedger(record.directory).catch(() => null)
    if (!ledger || !ledger.ok) {
      return ['重复读取：账本不可读（失败关闭，不重建为空）：' + (ledger?.error ?? '未知原因')]
    }
    if (ledger.entries.length === 0) return ['重复读取：账本为空（本会话尚未归档过读取类操作）']
    const totalChars = ledger.entries.reduce((sum, entry) => sum + Number(entry.chars ?? 0), 0)
    const summary = summarizeReadLedger(ledger, { totalChars })
    const pct = (ratio) => (Number.isFinite(ratio) ? (ratio * 100).toFixed(2) + '%' : '未知')
    return [
      '重复读取（本账本口径）：键 ' + summary.keys + ' 个 / 读取 ' + summary.reads + ' 次 / 重读 '
        + summary.repeats + ' 次（' + summary.repeatChars + ' 字）',
      '重复读取占比：口径 A（重读字符/全部内容字符）' + pct(summary.ratioA)
        + '；口径 B（内容未变的重读）' + pct(summary.ratioB) + '（分母=' + summary.totalChars + ' 字）',
    ]
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
      : '字面索引：尚无（运行 `/memory-lab index sync` 建立；在此之前检索只按记录元数据匹配）')

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
        : '检索后端：尚未为本会话启动（只有 `/memory-lab index sync` 会启动；检索当前只用字面索引）')
    } else {
      lines.push('检索后端：未接入（检索只用字面索引，不是语义召回）')
    }
    return lines
  }

  async function read(invocation, ids) {
    const sessionId = sessionIdOf(invocation.agent.session)
    if (ids.length === 0) {
      return { kind: 'error', text: '用法：`/memory-lab read <记录ID...>`（记录 ID 形如 t00000001-r0001）。' }
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

  async function history(invocation, args) {
    const sessionId = sessionIdOf(invocation.agent.session)
    // R-02（beta.4）：页码与 /memory-lab set 的数字键同一把尺子——严格十进制整数。
    // 以前是 Number.parseInt（3.7 读成 3、3abc 读成 3）：用户以为换了页，实际拿到
    // 的是被悄悄改过的页码。给了参数但不合法就回用法错误，不回落默认值。
    const afterId = args[1] ?? null
    // O-01（0.13.2-beta.5）：每页条数走 readback 的**同一把尺子**，上下界都显式判——
    // 旧实现下界报错、上界静默夹到 2000，用户不知道自己要的数字被改过。项目规矩
    // 见 budget.mjs 的 parseBudgetTokens：「超过上限必须显式报错」。
    const sizePlan = resolvePageSize(args[0], { fallback: HISTORY_DEFAULT_PAGE_SIZE })
    if (!sizePlan.ok) {
      return {
        kind: 'error',
        text: `${sizePlan.error}\n用法：\`/memory-lab history [每页条数（1..${MAX_PAGE_SIZE} 的整数）] [起始记录 ID]\``,
      }
    }
    const pageSize = sizePlan.value
    const page = await withReadableStore(sessionId, (store) => listRecordsPage(labRoot, sessionId, {
      pageSize,
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
    lines.push(`共 ${page.total} 条；本页 ${page.entries.length} 条（每页 ${page.pageSize} 条）`
      + (page.hasNextPage ? `；下一页从 ${page.nextAfter} 之后开始` : '；已到末页'))
    return { kind: 'success', text: lines.join('\n') }
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

  async function verifyCommand(invocation, ids) {
    const sessionId = sessionIdOf(invocation.agent.session)
    if (ids.length === 0) return { kind: 'error', text: '用法：`/memory-lab verify <记录ID...>`。' }
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

  async function markStaleCommand(invocation, args) {
    const sessionId = sessionIdOf(invocation.agent.session)
    const recordId = args[0]
    const reason = args.slice(1).join(' ').trim()
    if (!recordId || !reason) {
      return { kind: 'error', text: '用法：`/memory-lab mark-stale <记录ID> <原因（必填，会入旁证留痕）>`。' }
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

  async function relationsCommand(invocation, args) {
    const sessionId = sessionIdOf(invocation.agent.session)
    const recordId = args[0]
    if (!recordId) return { kind: 'error', text: '用法：`/memory-lab relations <记录ID>`。' }
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
        forgetIndex: await getForgetIndex(record.directory).catch(() => null),
      })
      const lines = []
      if (described.relations.length === 0) {
        lines.push(`${recordId}（${described.kind}）：无已解析的结构关系（配对、fork、索引均未命中）。`)
      } else {
        lines.push(`${recordId}（${described.kind}）的结构关系：`)
        lines.push(...described.relations.map((relation) => `- ${relation.kind}/${relation.relation} → ${relation.recordId}${relation.callId ? `（callId ${relation.callId}）` : ''}`))
      }
      // 关系面按遗忘账本过滤后仍如实披露：被隐藏不等于不存在。
      for (const item of described.filtered ?? []) {
        lines.push(`- 已按遗忘账本隐藏：${item.kind}/${item.relation ?? 'pairing'} → ${item.recordId}`)
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

  return {
    withReadableStore,
    readWithForkFallback,
    status,
    read,
    history,
    workingSet,
    verifyCommand,
    markStaleCommand,
    relationsCommand,
    costCommand,
  }
}
