/**
 * v2 工作状态卡域（0.13.1 P4b）。
 *
 * 从 `runtime.mjs` 摘出：这一域负责「有界工作状态卡」的构建、注入裁决、宿主
 * 确认与卡组折叠，共 10 个函数、约 340 行。函数体是**逐字搬移**，语义零改动；
 * 唯一变化是原本从闭包自由读取的名字改为显式注入。
 *
 * ## 装配契约
 * `createCardDomain({ records, engine, factoryFor, adopt, lastAssistantSeqOf,
 * parseBudgetArg, persistCost, logger, labRoot, sessionIdOf, services })`
 * 返回该域的全部函数。`records` 是**活引用**（Map），必须传对象本体而不是副本。
 *
 * ## 依赖方向
 * 本域只读 record 与 session，不写账本；需要 records 注册表的命令分发
 * （`commandHandler`）仍留在 runtime。
 *
 * ## 不适用条件
 * 本模块不持有跨会话状态。`workingSetInjection` / `foldWorkingCards` 会读
 * `record.state.settings`，但不会修改它——写设置只走 `setSetting`。
 */
import { randomUUID } from 'node:crypto'
import { PLUGIN_SOURCE_KIND } from '../core.mjs'
import { v2SessionDirectoryFor } from './state.mjs'
import { WORKING_SET_MAX_BUDGET_TOKENS } from './budget.mjs'
import { cardOccupancyOf, planCardFolds } from './card-fold.mjs'
import { extractClaims } from './claims.mjs'
import { getForgetIndex, isForgotten } from './disposition.mjs'
import { buildWorkingState, decideWorkingSetInjection, planWorkingSetBudget, renderWorkingSetInjection, shouldInjectFullWorkingStateCard, workingSetDedupKeyOf, workingStateCardDelta, WORKING_SET_DEFAULTS, WORKING_SET_DEDUP_HISTORY_LIMIT } from './working-state.mjs'

export function createCardDomain({
  records,
  engine,
  factoryFor,
  adopt,
  lastAssistantSeqOf,
  parseBudgetArg,
  persistCost,
  logger,
  labRoot,
  sessionIdOf,
  services,
}) {
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
        try {
          const ids = recordIdsForSeq(seq)
          if (Array.isArray(ids) && ids.length > 0) recordRef = ids[0]
        } catch { recordRef = null }
      }
      if (recordRef === null) recordRef = 'host-seq:' + seq
      for (const claim of extractClaims(text)) {
        if (recordRef.startsWith('t') && forgetIndex && isForgotten(forgetIndex, recordRef)) continue
        claims.push({ ...claim, recordRef })
      }
    }
    return claims
  }

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

  function readbackEntriesOf(record) {
    const rows = engine.pendingReceipts(record)
    const out = []
    for (let index = rows.length - 1; index >= 0 && out.length < 3; index -= 1) {
      const row = rows[index]
      if (!row || typeof row.nodeId !== 'string' || row.nodeId === '') continue
      const locator = Array.isArray(row.locators) && typeof row.locators[0] === 'string' && row.locators[0] !== ''
        ? row.locators[0]
        : null
      out.push({
        recordId: row.nodeId,
        tools: Array.isArray(row.tools) ? row.tools : [],
        range: { start: row.rangeStart, end: row.rangeEnd },
        locator,
        tokens: Number.isFinite(Number(row.originalTokens)) ? Number(row.originalTokens) : null,
      })
    }
    return out
  }

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
        // P0-1：本步可回读（最近 3 条已归档，只给结构与取回代价）。
        readback: readbackEntriesOf(record),
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

  async function cardCommand(invocation, args) {
    const sessionId = sessionIdOf(invocation.agent.session)
    const record = records.get(sessionId) ?? await adopt(invocation.agent)
    if (!record) return { kind: 'error', text: 'v2 引擎在本会话未启用。先 `/memory-lab on`。' }
    const budgetPlan = parseBudgetArg(args[0], {
      fallback: WORKING_SET_DEFAULTS.cardTokens,
      max: WORKING_SET_MAX_BUDGET_TOKENS,
      label: 'card 预算',
    })
    if (!budgetPlan.ok) return { kind: 'error', text: budgetPlan.error }
    // 手工预览不是「注入」：不把预览的丢弃段数记进注入成本，
    // 否则跑几次 `/memory-lab card` 就会污染「因预算丢弃段数」这个真实运行指标。
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
    if (!verdict.inject) {
      // 键命中历史只说明「这张卡本会话注入过」，**不**说明「模型手上现在就是它」
      // （0.13.2 D-08）。全量卡时代两者等价；增量卡时代模型手上是「上一张全量卡 +
      // 后续增量」。状态回退到某个旧全量卡形态时，增量卡宣告过的行（未曝光结果、
      // 进度）在新状态里已不存在，却没有任何卡撤回它们——模型继续按不存在的事实
      // 行动。所以只有基线**就是**这张卡时才真的无需重复注入；否则落到下面的
      // 增量分支，把差异说清。
      if (cardState.text === card.text) return null
    }

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
      // 增量卡被上界截断时**改发全量卡**。否则确认注入会把基线推进到本步全量卡，
      // 而被省略的变化行从此再也不会出现在任何增量卡里（模型最多等到 ≤20 次注入
      // 后的周期性全量卡）——信息静默丢失。宁可多付一次全量的钱。
      if (delta.truncated === true) {
        text = card.text
        form = 'full'
      } else {
        text = delta.text
        form = 'delta'
      }
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

  async function foldWorkingCards(agent, { requireOverCap = false } = {}) {
    const record = await adopt(agent)
    if (!record) return { folded: 0, receipts: [], failed: 0, occupancy: null }
    const session = record.agent?.session
    if (!session || typeof session.append !== 'function' || !Array.isArray(session.surface?.nodes)) {
      return { folded: 0, receipts: [], failed: 0, occupancy: null }
    }
    const nodes = session.surface.nodes.map((seq) => {
      const event = typeof session.eventAt === 'function' ? session.eventAt(seq) : null
      const content = event?.data?.content
      const first = Array.isArray(content) ? content.find((block) => block?.type === 'text') : null
      // sourceForm 双形态：宿主只把 `source` 存进 `data`（append 的 opts 只认
      // surfaceOp/sourceEventSeqs，其余键静默丢弃），历史日志里也出现过顶层
      // `event.source` 的形状（旧夹具/旧版本），所以两处都查；读取端不假设单一形状。
      return {
        seq,
        type: event?.type ?? null,
        sourceForm: event?.source?.form ?? event?.data?.source?.form ?? null,
        text: typeof first?.text === 'string' ? first.text : null,
      }
    })
    // 0.12.0 P0-4：最新一张工作状态卡永远保护；它是模型当前能看到的状态面。
    const occupancy = cardOccupancyOf(nodes)
    const { plans } = planCardFolds(nodes, {
      // 0.13.0 F5：最新工作卡 + 最新**全量卡**都保护。增量卡的语义是「相对
      // 最近一张全量卡的变化」，折掉全量卡等于抽掉增量卡的基准（实测 2565 被折
      // 之后，后续 5 张增量卡仍写「以最近一张全量卡为准」）。
      protectSeqs: [occupancy.newestWorkingStateSeq, occupancy.newestFullCardSeq]
        .filter((seq) => Number.isInteger(seq)),
    })
    const receipts = []
    let failed = 0
    for (const plan of plans) {
      try {
        const event = session.append('user/message', {
          id: `surface-${randomUUID()}`,
          role: 'user',
          content: [{ type: 'text', text: plan.text }],
          // 宿主只认 opts 的 surfaceOp/sourceEventSeqs，source 必须写进 data（缺了会让投影读 data.source.kind 崩掉整条历史）
          source: { kind: PLUGIN_SOURCE_KIND, form: 'memory-lab2-surface' },
        }, {
          surfaceOp: { op: 'replace', startSeq: plan.startSeq, endSeq: plan.endSeq },
          sourceEventSeqs: [...plan.memberSeqs],
        })
        receipts.push({ seq: event?.seq, startSeq: plan.startSeq, endSeq: plan.endSeq, members: plan.memberSeqs.length })
      } catch (error) {
        failed += 1
        logger?.warn?.(`memory-context-lab: 卡组折叠提交失败（seq ${plan.startSeq}–${plan.endSeq} 保持原样）：${error?.message ?? error}`)
      }
    }
    if (receipts.length > 0) {
      record.cost.bump('historyReplacements', receipts.length)
      record.cost.bump('cardFoldBatches', 1)
      void persistCost(record)
    }
    return { folded: receipts.length, receipts, failed, occupancy }
  }

  return {
    cardFromStore,
    cardCommand,
    workingSetInjection,
    confirmInjection,
    foldWorkingCards,
  }
}
