/**
 * recall 用例（application，M4 第二批）。
 *
 * 判据（0.12.0 保留族）：
 * - 纯壳不注入：无合格命中（低于装包阈）不注入空块（recall-gate）；
 * - 回注包带确定性首部切片（N-03：切片是定长首部，不是摘要不是全文）；
 * - OOV 词单独披露（retrieval-contract F3）；
 * - 同回合同类回注只一次（P3：domain 的 oncePerTurnGate，category=recall-injection）；
 * - 句柄可执行：正文里给 memory 侧可照抄的按 ID 回读形态（readback-affordance）。
 */
import { V3ContractViolation } from '../contracts/index.mjs'
import { READBACK_MAX_CHARS } from '../contracts/readback.mjs'
import { VISIBILITY_LIMITS } from '../contracts/visibility.mjs'
import { assertPort } from '../ports/index.mjs'
import { createRecallLeaseRegistry, recallBodyIdOf } from '../domain/session/recall-counters.mjs'
import { EXCERPT_OFFSET_UNIT, selectExcerpt } from '../domain/retrieval/excerpt.mjs'
import { recordFragmentOf } from '../domain/visibility/fragments.mjs'
import { createVisibilityState } from '../domain/visibility/state.mjs'

/** 确定性首部切片长度（N-03 口径）。 */
export const RECALL_PREVIEW_CHARS = 160

/**
 * 结果面（display）隐含下限。
 *
 * 为什么它必须被导出：设置页只暴露一个「装包阈值」（`packMinScore`，下界 0，
 * 文案写着「0 表示不过滤」），而用例内部另有一个 `resultMinScore = 0.01` 的默认值。
 * 两者之间的约束是「装包面 ⊆ 结果面」，即 `packMinScore ≥ resultMinScore`。
 * 于是用户把装包阈拖到 0（文案承诺的合法取值）时，**每一步**的回注都会在
 * `applyMinScore` 抛 `V3ContractViolation`，被 `recallForInjection` 记成 failed——
 * 一个设置页允许、文档鼓励的值，让功能整体失效，而观察面只看到「失败 N 次」。
 *
 * 修法不是放宽校验（那会让「装包面只会更严」这条不变量失效），而是把
 * 「结果面下限」变成**可被调用方派生**的公开量：设置侧按
 * `Math.min(RECALL_RESULT_MIN_SCORE, packMinScore)` 给出成对参数，
 * 让用户说的「不过滤」真的落到两面都不过滤。
 */
export const RECALL_RESULT_MIN_SCORE = 0.01

/** 注入上界（P0-4：能注入→有上界；2026-10-25 用户拍板移植⑤）：回注包总字符硬顶。 */
export const RECALL_PACK_MAX_CHARS = 4000

/**
 * 自动回注的外部检索截止时间（0.15.0 P5 / 开发流程 §5.4）。
 *
 * 旧实现把 T2 外部查询的 10 秒超时直接挂在 pre-step 的 awaited 路径上：外部卡住
 * 就把首字延迟拖满 10 秒。自动回注统一给一个短截止时间，超时按 **partial** 回 T1；
 * 手动检索可显式传更大的 timeoutMs（独立预算）。
 */
export const RECALL_T2_DEADLINE_MS = 800

/**
 * 命中窗口的行内标注（码点半开区间）。
 * 从 0 开始的单窗口仍写「首部」，保持旧回执的可读性与既有断言；其余写精确 span。
 */
function excerptLabelOf(excerpt) {
  const spans = Array.isArray(excerpt?.spans) ? excerpt.spans : []
  if (spans.length === 0) return '首部'
  const label = spans.map((span) => span.start + '–' + span.end).join('、')
  return spans.length === 1 && spans[0].start === 0 ? '首部' : '命中片段（码点 ' + label + '）'
}

/** 窗口被截断时在行内明示省略号（旧「首部」语义的可观测性保留）。 */
function excerptBodyOf(excerpt) {
  const text = typeof excerpt?.text === 'string' ? excerpt.text : ''
  if (excerpt?.truncated !== true) return text
  if (text.length === 0) return '…'
  return text.endsWith('…') ? text : text + '…'
}

/** 精确记录 ID 形态（v3r- + 16 位十六进制）；不匹配即按别名走解析（⑨）。 */
export function isExactRecordId(ref) {
  return typeof ref === 'string' && /^v3r-[0-9a-f]{16}$/.test(ref)
}

/** 按码点切片（UTF-16 slice 会把代理对切成半个——reliability 码点纪律的 v3 落点）。 */
export function sliceByChars(text, n) {
  return [...text].slice(0, n).join('')
}

/** OOV 词表在回注包里的展示上界（完整性由计数行承担，不靠无限枚举）。 */
export const RECALL_OOV_MAX_TERMS = 8

/**
 * 有界、去重的 OOV 词表。
 *
 * 旧实现直接 `join('、')`：查询是整条用户消息时，CJK 分词会给每个字生成「单字 + 双字」，
 * 一条 1200 字的新词长句能把词表撑到几千项，头部行单独就超过 4000 字符硬顶。
 * 展示有界、总数如实（`等 N 个`），是「省略可见」而不是「没发生」。
 */
export function boundedTerms(terms) {
  const unique = [...new Set(Array.isArray(terms) ? terms : [])]
  if (unique.length <= RECALL_OOV_MAX_TERMS) return unique
  return [...unique.slice(0, RECALL_OOV_MAX_TERMS), '等 ' + unique.length + ' 个']
}

export function createRecall({ provider, metrics, sessionKey, visibility = null, dedupeVisible = false } = {}) {
  assertPort('MemoryProvider', provider)
  if (typeof sessionKey !== 'string' || sessionKey.length === 0) {
    throw new V3ContractViolation('v3 recall: sessionKey 必须是非空字符串')
  }
  // G6b 候选开关（默认关闭）：非法值失败关闭，不静默当成 true/false。
  if (typeof dedupeVisible !== 'boolean') {
    throw new V3ContractViolation('v3 recall: dedupeVisible 必须是布尔值（非法配置失败关闭，得到 ' + JSON.stringify(dedupeVisible) + '）')
  }
  // 开启去重就必须有判定快照端口：拿不到活动面时宁可「不启用」而不是「假装都可见」。
  if (dedupeVisible === true && (visibility === null || typeof visibility?.snapshotOf !== 'function')) {
    throw new V3ContractViolation('v3 recall: 开启可见片段去重需要 visibility 端口（snapshotOf）')
  }
  const visibilityState = dedupeVisible === true ? createVisibilityState() : null
  // R04：同回合「只成功呈现一次」由租约登记保证（reserve/commit/release），
  // 不再用取数前就写死的 oncePerTurnGate 键。详见 domain/session/recall-counters.mjs。
  const leases = createRecallLeaseRegistry()

  /**
   * 本回合是否**已确认呈现过**同类回注（只读；不占位）。
   * 入口的预检与状态面用它，避免把「上次取数失败」误报成「本回合已注入」。
   */
  function presentedTurn(turn) {
    const state = leases.stateOf(sessionKey, turn)
    return state === 'handed-off' || state === 'confirmed'
  }

  /** 按 ID 或别名回读（⑨ 别名解析，2026-10-25 用户拍板移植）：别名经端口可选方法解析，未实现则失败关闭。 */
  async function readByRef(ref) {
    if (isExactRecordId(ref)) return provider.read(ref)
    if (typeof provider.resolveAlias !== 'function') {
      throw new V3ContractViolation('v3 recall: 引用不是精确记录 ID 且提供者未实现 resolveAlias（别名解析不可用）')
    }
    const resolved = await provider.resolveAlias(ref)
    if (resolved === null || resolved === undefined) {
      throw new V3ContractViolation('v3 recall: 别名未命中：' + ref)
    }
    return provider.read(resolved)
  }

  const api = async function recall({
    query,
    turn,
    limit = 10,
    resultMinScore = 0.01,
    packMinScore = 0.5,
    previewChars = RECALL_PREVIEW_CHARS,
    allowRebuild = true,
    excludeRecordIds = null,
    timeoutMs = RECALL_T2_DEADLINE_MS,
    deadline = null,
    signal = null,
  } = {}) {
    if (typeof query !== 'string' || query.trim().length === 0) {
      throw new V3ContractViolation('v3 recall: 查询必须是非空白字符串（空查询失败关闭）')
    }
    if (!Number.isInteger(turn) || turn < 1) {
      throw new V3ContractViolation('v3 recall: turn 必须 ≥1（turn 0 不允许注入）')
    }
    // H-47：切片长度必须落在 [0, +∞) 的整数域。旧实现直接拿调用方的值做
    // `text.length > previewChars` 与 `slice(0, previewChars)`：
    // - 负数 → slice(0,-1) 取「除最后一个字符外的全文」（越界**放宽**）；
    // - NaN / Infinity / 非数字 → 比较恒为 false → 直接注入**全文**。
    // 两者都绕过 N-03 的「定长首部切片」纪律：回注包不是摘要也不是全文，
    // 而这两条路径把 800 字符正文原样塞进下一步的上下文。
    if (!Number.isInteger(previewChars) || previewChars < 0) {
      throw new V3ContractViolation('v3 recall: previewChars 必须是 ≥0 的整数（得到 ' + JSON.stringify(previewChars) + '）——负数会 slice(0,-1) 取到全文，NaN/Infinity 会让比较恒假')
    }
    // 切片长度超过整包硬顶没有意义（一条命中就撑满整个回注包，其余全被省略）：
    // 这种参数不是「多要一点」，是配置错误。失败关闭而不是静默当成「全要」。
    if (previewChars > RECALL_PACK_MAX_CHARS) {
      throw new V3ContractViolation('v3 recall: previewChars 不得超过回注包硬顶 ' + RECALL_PACK_MAX_CHARS + '（得到 ' + previewChars + '）')
    }
    // 外部检索统一截止时间：显式 deadline 优先；否则 timeoutMs 从进入用例时起算。
    // timeoutMs=0 是合法值（显式不给外部检索预算），不是「未提供」。
    if (!Number.isInteger(timeoutMs) || timeoutMs < 0) {
      throw new V3ContractViolation('v3 recall: timeoutMs 必须是 ≥0 的整数（得到 ' + String(timeoutMs) + '）')
    }
    const searchDeadline = Number.isFinite(deadline) ? deadline : Date.now() + timeoutMs
    let result = await provider.search(query, { limit, resultMinScore, packMinScore, allowRebuild, deadline: searchDeadline, signal })
    const excluded = excludeRecordIds instanceof Set
      ? excludeRecordIds
      : new Set(Array.isArray(excludeRecordIds) ? excludeRecordIds.filter((id) => typeof id === 'string') : [])
    if (excluded.size > 0 && Array.isArray(result.pack)) {
      const pack = result.pack.filter((hit) => !excluded.has(hit.id))
      result = { ...result, pack, display: (result.display ?? []).filter((hit) => !excluded.has(hit.id)) }
    }
    if (result.pack.length === 0) {
      metrics?.counter?.('v3.recall.skipped', 1)
      // 「无命中」不等于「没有可用信号」：全部词都 OOV 时，最需要披露的是那些词。
      // 旧实现把 oovTerms 塞进返回值却没有任何调用方读，观察面只显示「无命中」。
      const oov = boundedTerms(result.oovTerms)
      // 「索引还没追上」与「真的没命中」是两种事实，不得同形（见 t1-provider 的
      // allowRebuild 分支：热路径宁可回空也不重建）。把它如实披露，否则用户在
      // 新会话第一回合看到的「无命中」会与「检索坏了」无法区分。
      const baseReason = result.indexAbsent === true
        ? '索引尚未就绪（后台重建中，本步不回注）'
        : (result.display.length > 0
          ? '命中不足装包阈（纯壳不注入）'
          : (oov.length > 0 ? '无命中（词表外词：' + oov.join('、') + '）' : '无命中'))
      // P5：外部部分/失败/取消不得被「无命中」吞掉（那会让「后端超时」看起来像「资料不存在」）。
      const statusNote = result.partial === true || result.status === 'partial' ? '；外部检索部分结果'
        : result.status === 'cancelled' ? '；外部检索已取消'
          : result.status === 'failed' ? '；外部检索失败'
            : result.status === 'unsupported' ? '；T2 检索能力未启用' : ''
      return {
        injected: false,
        reason: baseReason + statusNote,
        display: result.display,
        oovTerms: result.oovTerms,
        searchStatus: typeof result.status === 'string' ? result.status : 'success',
        partial: result.partial === true || result.status === 'partial',
        t1Fallback: result.t1Fallback === true,
        searchReason: typeof result.reason === 'string' ? result.reason : null,
      }
    }
    // R04：占位而不是「记成功」。占不到 = 本回合已有一次成功呈现（或另一并发正在呈现）。
    // 之后的任何失败路径都走 release，同回合可以重试；只有末尾真正装包成功才 commit。
    const reservation = leases.reserve(sessionKey, turn)
    if (!reservation.reserved) {
      const done = reservation.reason === 'handed-off' || reservation.reason === 'confirmed'
      metrics?.counter?.(done ? 'v3.recall.gated' : 'v3.recall.concurrent-skip', 1)
      return {
        injected: false,
        released: true,
        reason: done
          ? '本回合已注入过同类回注（P3 命中只出现一步）'
          : '本回合已有一次回注正在进行（并发只允许一次成功呈现）',
        dispatch: reservation.reason,
        display: result.display,
        oovTerms: result.oovTerms,
      }
    }
    // 未呈现就返回：一律释放占位，并如实带上 releaseReason（观察面/测试据此区分失败种类）。
    // R04：**必须用 forget 而不是 release**。占位是「reserve 之后、commit 之前」的队列位；
    // release 只清 pending，对已经 commit 的回合是无操作——而宿主提交失败的场景里
    // 用例层早就 commit 过了。forget 同时清 pending/committed，语义才等于「这次呈现不算数」。
    const notPresented = (reason, extra = {}) => {
      const forgotten = leases.forget(sessionKey, turn).forgotten
      return {
        injected: false,
        released: forgotten,
        releaseReason: reason,
        reason,
        display: result.display,
        oovTerms: result.oovTerms,
        searchStatus: typeof result.status === 'string' ? result.status : 'success',
        partial: result.partial === true,
        t1Fallback: result.t1Fallback === true,
        ...extra,
      }
    }

    // R02：头部「命中 N 条」必须按**最终装包数**计（开发流程 §7.1）。候选数另写在
    // 「候选」段，供诊断区分「检索到 10 条」与「真正呈现 2 条」——旧实现用候选数冒充呈现数。
    //
    // 头部同时带**确定性来源 ID**（bodyId）：它是入口据以对账「宿主是否真的落了这条」的
    // 唯一稳定身份，必须出现在落面正文里——只在内存里算一个 ID，宿主事件里就找不到它，
    // 确认面只能靠 message.id（P0 宿主合同未核到宿主保留该字段）。
    // bodyId 只由 (sessionKey, turn, query) 决定：同一回合同一查询无论预算收敛到几条都是同一 ID，
    // 因此可以先算出它再拼头部（不受「最终保留几条」影响）。
    const bodyId = recallBodyIdOf({ sessionKey, turn, query })
    const headerLineFor = (presentedCount) => '回注包（命中 ' + presentedCount + ' 条；来源：' + (result.sourceLabel ?? '本地词法索引') + '；来源 ID ' + bodyId + '）'
    const headerLines = []
    if (result.oovTerms.length > 0) {
      headerLines.push('词表外词（未参与打分）：' + boundedTerms(result.oovTerms).join('、'))
    }
    // P5：部分/失败/取消是**可见状态**，不是「看起来像正常结果」。
    // T1 结果仍照常呈现（降级不丢内容），但头部必须说明外部后端的真实结局。
    const searchStatus = typeof result.status === 'string' ? result.status : 'success'
    const statusLine = (() => {
      if (result.partial === true || searchStatus === 'partial') return '检索状态：部分结果（外部检索超时/截断，已回退本地结果）'
      if (searchStatus === 'cancelled') return '检索状态：已取消（外部检索未完成，已回退本地结果）'
      if (searchStatus === 'failed') return '检索状态：外部检索失败（已回退本地结果）'
      if (searchStatus === 'unsupported') return '检索状态：T2 检索能力未启用（本地词法索引）'
      return null
    })()
    if (statusLine !== null) headerLines.push(statusLine)
    let hitLines = []
    let hitBodyCharsText = [] // 与 hitLines 同序：该行**摘录正文**原文（P2-08 纯壳判据按有效字符算）
    let excerptInfos = [] // 每条可读命中的窗口（码点 span + 策略），与 hitLines 同序
    let chunkSpanLists = [] // 与 hitLines 同序：该记录可用 chunk spans（null = 无索引）
    const chunkIndexStates = []
    // P3 诊断：索引级「被硬顶截断的记录数」与本批「命中记录自身被截断的条数」。
    // 两者都不影响注入（窗口会回退现扫），但必须可见——否则「尾部答案没了」只能靠猜。
    let chunkIndexTruncatedRecords = 0
    let chunkIndexTruncatedHits = 0
    let hitPackIndex = [] // hitLines[n] 对应的 result.pack 下标（不可读命中被跳过，两者会错位）
    let sourceTexts = [] // 每条命中的原文（预算不足时据此缩短首部，见 compose）
    let hitTimes = [] // D-13 口径（2026-10-26 拍板「优先保最新的」）：截断丢最旧，不砍尾部
    let presentedIds = [] // R02：按 **hitLines 顺序**记录真正进了装包候选的 record ID（实际呈现的以 finalPresented 为准）
    let unreadableHits = 0
    for (let packIndex = 0; packIndex < result.pack.length; packIndex += 1) {
      const hit = result.pack[packIndex]
      let record = null
      try {
        record = await provider.read(hit.id)
      } catch (error) {
        // 单条读取失败不得废掉整包（旧实现让一条 ESTORE_CORRUPT 把同回合全部命中丢掉）。
        // 失败仍要留痕：计数 + 包内如实标注「N 条读取失败」，不静默跳过。
        unreadableHits += 1
        metrics?.counter?.('v3.recall.hit-unreadable', 1)
        continue
      }
      const recordText = record?.text ?? ''
      // P5：用**命中窗口**替换固定首部（R01）。chunk 索引只提供码点 span；
      // 索引缺失/换代/落后时 selectExcerpt 自动现扫，窗口能力不依赖派生索引。
      let chunkSpans = null
      if (typeof provider.chunksOf === 'function') {
        try {
          const info = await provider.chunksOf(hit.id)
          const state = typeof info?.state === 'string' ? info.state : 'unknown'
          chunkIndexStates.push(state)
          if (state === 'ok' && Array.isArray(info.spans) && info.spans.length > 0) chunkSpans = info.spans
          if (state === 'ok') {
            if (Number.isInteger(info.indexTruncatedRecords)) {
              chunkIndexTruncatedRecords = Math.max(chunkIndexTruncatedRecords, info.indexTruncatedRecords)
            }
            if (info.truncated === true) {
              chunkIndexTruncatedHits += 1
              metrics?.counter?.('v3.recall.chunkIndex.truncatedRecord', 1)
            }
          }
          if (state !== 'ok') metrics?.counter?.('v3.recall.chunkIndex.' + state, 1)
        } catch {
          chunkIndexStates.push('error')
          metrics?.counter?.('v3.recall.chunkIndex.error', 1)
        }
      } else {
        chunkIndexStates.push('unsupported')
      }
      const excerpt = selectExcerpt(recordText, query, { maxChars: previewChars, chunkSpans })
      {
        const body = excerptBodyOf(excerpt)
        hitLines.push('· ' + hit.id + '（相关度 ' + hit.score.toFixed(3) + '）' + excerptLabelOf(excerpt) + '：' + body)
        // P2-08：正文原文随行存（compose 按「有效字符」算纯壳，不解析行文、不猜前缀）。
        hitBodyCharsText.push(body)
      }
      metrics?.counter?.('v3.recall.excerpt.' + (excerpt.strategy === 'head' ? 'head' : 'window'), 1)
      excerptInfos.push({
        recordId: hit.id,
        spans: excerpt.spans,
        strategy: excerpt.strategy,
        chunkHits: excerpt.chunkHits,
        matchedNeedles: excerpt.matchedNeedles,
        truncated: excerpt.truncated,
      })
      chunkSpanLists.push(chunkSpans)
      // 收缩路径必须按 hitLines 自己的映射取 pack 项：不可读命中被 continue 跳过后，
      // hitLines[n] 与 result.pack[n] 不再同指——旧实现用 result.pack[n] 打 ID，
      // 会把「可读正文」标成另一条（不可读）记录的 ID（审计 E-A 实测）。
      hitPackIndex.push(packIndex)
      presentedIds.push(hit.id)
      // 原文单独留一份：预算收敛时要按可用余量**重选更短的命中窗口**，不得只靠「整条丢弃」。
      sourceTexts.push(recordText)
      hitTimes.push(Number.isFinite(record?.record?.createdAt) ? record.record.createdAt : 0)
    }
    if (hitLines.length === 0) {
      metrics?.counter?.('v3.recall.skipped', 1)
      // R04：单条读取失败（哪怕全部失败）不消耗本回合唯一一次机会。
      return notPresented('all-unreadable', { reason: '命中记录全部不可读（' + unreadableHits + ' 条）' })
    }
    if (unreadableHits > 0) headerLines.push('读取失败：' + unreadableHits + ' 条命中不可读（已如实跳过，不代表没有）')
    // ---------------------------------------------------------------- G6b 去重（候选，默认关闭）
    //
    // 判据只服务「这次要不要再呈现这段片段」：只有**被证明当前仍可见**的片段才跳过，
    // 已遗忘片段永不注入（隐私维度），unknown 一律注入（R-1：宁可重复，不误删召回）。
    // 判定输入全部来自 visibility 端口（活动面快照），本用例不读观测/日志/租约——
    // 那三者都不是可见性证据（合同 §1.2）。
    let dedupe = null
    if (visibilityState !== null) {
      const fragments = []
      for (let n = 0; n < hitLines.length; n += 1) {
        const info = excerptInfos[n]
        const firstSpan = Array.isArray(info.spans) && info.spans.length > 0 ? info.spans[0] : null
        fragments.push(recordFragmentOf({
          id: info.recordId,
          text: sourceTexts[n] ?? '',
          span: firstSpan === null ? null : { unit: EXCERPT_OFFSET_UNIT, start: firstSpan.start, end: firstSpan.end },
        }))
      }
      let snapshot = null
      let snapshotFailed = false
      try {
        snapshot = await visibility.snapshotOf({ recordIds: fragments.map((fragment) => fragment.id) })
      } catch {
        // 宿主面读不到不是错误路径而是**已知退化**：全部按 unknown 处理（照常注入并计数）。
        snapshot = null
        snapshotFailed = true
        metrics?.counter?.('v3.recall.dedupe.snapshot-unreadable', 1)
      }
      const judged = visibilityState.evaluate({ snapshot, fragments, sessionKey })
      const charsByKey = new Map()
      judged.verdicts.forEach((verdict, n) => { charsByKey.set(verdict.dedupeKey, hitLines[n].length) })
      const decision = visibilityState.plan({
        digest: judged.digest,
        verdicts: judged.verdicts,
        turn,
        charsOf: (key) => charsByKey.get(key) ?? 0,
      })
      const skippedKeys = new Set(decision.skip)
      const keptIndexes = []
      for (let n = 0; n < hitLines.length; n += 1) {
        if (skippedKeys.has(judged.verdicts[n].dedupeKey)) continue
        keptIndexes.push(n)
      }
      dedupe = {
        enabled: true,
        degraded: snapshotFailed || judged.degraded,
        // P2-1：跨会话快照（端口给错了会话）单独可见——它不是「宿主面读不到」。
        crossSession: judged.crossSession === true,
        digest: judged.digest,
        skipped: decision.skip.length,
        stillVisible: decision.visible.length,
        forgotten: decision.forgotten.length,
        unknown: decision.unknown.length,
        capped: decision.capped.length,
        unknownChars: decision.unknownChars,
        cache: judged.cache,
      }
      metrics?.counter?.('v3.recall.dedupe.judged', judged.verdicts.length)
      if (dedupe.skipped > 0) metrics?.counter?.('v3.recall.dedupe.skipped', dedupe.skipped)
      if (dedupe.unknown > 0) metrics?.counter?.('v3.recall.dedupe.unknown', dedupe.unknown)
      if (dedupe.capped > 0) metrics?.counter?.('v3.recall.dedupe.unknown-capped', dedupe.capped)
      if (dedupe.degraded) metrics?.counter?.('v3.recall.dedupe.degraded', 1)
      if (keptIndexes.length !== hitLines.length) {
        const pick = (list) => keptIndexes.map((n) => list[n])
        hitLines = pick(hitLines)
        excerptInfos = pick(excerptInfos)
        chunkSpanLists = pick(chunkSpanLists)
        hitTimes = pick(hitTimes)
        sourceTexts = pick(sourceTexts)
        hitPackIndex = pick(hitPackIndex)
        presentedIds = pick(presentedIds)
      }
      if (keptIndexes.length === 0) {
        metrics?.counter?.('v3.recall.skipped', 1)
        return notPresented('all-deduped', {
          reason: '命中片段均已被证明当前仍可见或已遗忘（去重后无新内容可注入）',
          dedupe,
        })
      }
      if (dedupe.skipped > 0) {
        headerLines.push('可见片段去重：跳过 ' + dedupe.skipped + ' 条（当前仍可见 ' + dedupe.stillVisible + ' 条；已遗忘 ' + dedupe.forgotten + ' 条）；按 ID 仍可回读')
      }
      if (dedupe.crossSession) {
        headerLines.push('可见性判定降级：活动面快照不属于本会话（接线错误），全部片段按可见保守注入（去重本步不生效）')
      } else if (dedupe.degraded) {
        headerLines.push('可见性判定降级：宿主活动面不可读，全部片段按可见保守注入（去重本步不生效）')
      }
      if (dedupe.unknown > 0) {
        headerLines.push('可见性未知：' + dedupe.unknown + ' 条片段无法判定是否已可见，按可见保守注入（未知重复上限：本回合 ' + VISIBILITY_LIMITS.repeatTurn + ' 次／会话 ' + VISIBILITY_LIMITS.repeatSession + ' 次）')
      }
      if (dedupe.capped > 0) {
        headerLines.push('未知重复已达上限：' + dedupe.capped + ' 条已标记 unknown-capped（仍照常注入，未静默丢弃）')
      }
    }
    // 注入上界（P0-4）：超出硬顶时保完整行截断，省略可见、可按 ID 回读——不静默缩每条。
    // 上界必须对**最终正文**成立：省略行与回读尾行都在预算内（H-05：旧实现先算长度再追加两行，
    // 结果超上限；省略条数还用 lines.length-2 硬编码「标题+OOV」两行，无 OOV 时多算一条）。
    // 句柄必须指向**真实存在**的入口：beta.10 这里印的是 `memory_lab_recall(...)`，
    // 而本版没有注册任何模型可见工具（工具集恒定），模型照抄只会拿到 unknown tool。
    // P1-1 同族：read 有单次上限且记录正文可能已脱敏，不能写「精确回读全文」。
    //
    // P2-18：尾行曾是**只给命令面**的句柄（`/memory-lab read <ID>`），而命令面单次上限就是
    // `READBACK_MAX_CHARS`（且**不分页**）——长记录读到一半就没有下文了。本版已经注册了可分页的模型工具
    // `memory_context_read`（码点分页 + 游标续读），尾行却完全没提它：模型拿到的唯一
    // 回读指引是不可分页的那条，超过该上限的正文实际读不全。
    // 现在两条都给，且**先给可分页的那条**（默认路径），命令面作为人读的回退入口。
    const firstHandleId = hitLines[0].split('（')[0].replace('· ', '')
    const tailLine = '按 ID 回读已落库副本（可能已脱敏）：优先用 memory_context_read（按码点分页，可续读）'
      + '，或命令面 /memory-lab read ' + firstHandleId + '（单次 ' + READBACK_MAX_CHARS + ' 字、不分页，超长会截断）'
      + '（同回合其余 ID 见上）；丢弃不等于不存在。'
    // 超预算时丢 createdAt 最旧的行（保显示分数序；丢弃集合按时间选出，省略行如实计数）。
    // 时间戳缺失（回落 0）时按**原始下标倒序**丢弃：下标 0 是分数最高的一条，
    // 旧实现按正序丢，等价于「先丢最相关的」。缺时间的记录无法判新旧，就不拿它开刀。
    const orderToDrop = hitTimes
      .map((at, n) => ({ at, n }))
      .sort((a, b) => (a.at - b.at) || (b.n - a.n))
      .map((x) => x.n)
    /** 按每条命中的原文重建一行（窗口长度可变，但仍是**命中窗口**而不是重新退回首部）。 */
    const hitLineAt = (n, capChars) => {
      const text = sourceTexts[n] ?? ''
      const excerpt = selectExcerpt(text, query, { maxChars: capChars, chunkSpans: chunkSpanLists[n] ?? null })
      // 预算收缩后正文长度会变：以本次重建的行为准（调用方据此累计正文总量）。
      // 预算收缩后实际呈现的窗口可能变化：诊断字段跟最终行同步更新，不能只报原始窗口。
      const previous = excerptInfos[n]
      if (previous !== undefined) {
        excerptInfos[n] = {
          ...previous,
          spans: excerpt.spans,
          strategy: excerpt.strategy,
          chunkHits: excerpt.chunkHits,
          matchedNeedles: excerpt.matchedNeedles,
          truncated: excerpt.truncated,
        }
      }
      const packHit = result.pack[hitPackIndex[n] ?? n]
      const body = excerptBodyOf(excerpt)
      return {
        line: '· ' + packHit.id + '（相关度 ' + packHit.score.toFixed(3) + '）' + excerptLabelOf(excerpt) + '：' + body,
        bodyText: body,
      }
    }
    /**
     * 组装回注包。
     * @param keepCount 保留的命中条数（其余按 orderToDrop 丢弃并如实计数）
     * @param capChars 每条首部保留多少个**码点**
     */
    /**
     * P2-08：装包同时算**实际进了正文的字符总量**（只数命中行的摘录正文，不含前缀/固定行）。
     * 旧实现只用 `keep === 0` 判「纯壳」，而 `previewChars = 0`（设置页合法、Schema 通过）
     * 时每条命中仍算「放得下」，行内正文却是空的（只剩「…」）——包里 3 条命中、0 字正文，
     * 照样注入并占掉配额。判据必须落在**正文总量**上，而不是条数。
     */
    /**
     * P2-08：**有效正文字符数** = 去掉省略号与空白后的长度。
     * 用「去掉悬浮标记后还剩什么」定义纯壳，比猜「哪段是正文」的实现细节稳：
     * previewChars=0 时行正文只有「…」→ 计 0，判纯壳；正常摘录 → 计实际字数。
     */
    const effectiveBodyChars = (text) => typeof text === 'string' ? text.replace(/[…\s]/g, '').length : 0
    const compose = (keepCount, capChars) => {
      const dropped = new Set(orderToDrop.slice(0, hitLines.length - keepCount))
      const omitted = hitLines.length - keepCount
      const lines = [headerLineFor(keepCount), ...headerLines]
      let bodyChars = 0
      for (let n = 0; n < hitLines.length; n += 1) {
        if (dropped.has(n)) continue
        if (capChars >= previewChars) {
          bodyChars += effectiveBodyChars(hitBodyCharsText[n] ?? '')
          lines.push(hitLines[n])
        } else {
          const rebuilt = hitLineAt(n, capChars)
          bodyChars += effectiveBodyChars(rebuilt.bodyText)
          lines.push(rebuilt.line)
        }
      }
      if (omitted > 0) lines.push('注入上界：超出 ' + RECALL_PACK_MAX_CHARS + ' 字符的 ' + omitted + ' 条已省略（按 ID 回读全文）')
      lines.push(tailLine)
      return { lines, bodyChars }
    }
    const lengthOf = (lines) => lines.join('\n').length

    // ① 先按用户设置的 previewChars 丢命中：这是 `previewChars` 的**本义**
    //    （「每条保留多少首部字符」），丢掉的条数如实计入省略行。
    let cap = previewChars
    let keep = hitLines.length
    let composed = compose(keep, cap)
    let lines = composed.lines
    while (lengthOf(lines) > RECALL_PACK_MAX_CHARS && keep > 0) {
      keep -= 1
      composed = compose(keep, cap)
      lines = composed.lines
    }
    // ② 只有「连一条命中都放不下」时，才把首部压短作为兜底。
    //
    // 为什么需要这一步：`previewChars` 在设置页的上界就是硬顶（4000），而一条命中行
    // 除了首部还有「· <id>（相关度 x.xxx）首部：」的前缀。用户把首部长度拖到上限时，
    // **单条命中行单独就超预算**——旧实现只会整条丢弃，于是 keep 一路收敛到 0，
    // 整包退化成只有标题与尾行的「纯壳」被拒绝注入：一个设置页允许、Schema 校验
    // 通过的合法值让回注 100% 失效，观察面只显示「预算被固定行占满」。
    //
    // 口径：首部长度是**上限**不是下限，装不下时按余量压短是收紧而不是放宽——
    // 总字符数仍 ≤ 硬顶，且被压短的行以「…」明示截断。
    if (keep === 0) {
      // P1-02：旧实现每轮只减 ceil(over/命中数)，贴近边界后退化为「每次减 1」，且每轮
      // compose() 对**每条**命中重跑 selectExcerpt（O(正文) 扫描）——设置页合法的
      // previewChars=4000 + 8k 正文 + 10 条命中实测 8.3 秒（5 万字符正文 39 秒），而这条
      // 路径挂在 await 的 pre-step 上，直接变成首字延迟。
      //
      // 新实现：对 cap 二分（轮数 = ceil(log2(previewChars+1))，**与正文长度无关**），取
      // 「装得下的最大 cap」，尽量少截断。长度对 cap 近似单调（窗口只随 cap 放宽），非单调
      // 只可能来自窗口合并，所以二分结果必须复核：不装就放弃压缩（宁可拒绝注入，
      // 也不带着超限的包进模型——硬顶是「能注入就有上界」的承诺）。
      const fits = (capChars) => lengthOf(compose(hitLines.length, capChars).lines) <= RECALL_PACK_MAX_CHARS
      let chosen = -1
      if (fits(0)) {
        let lo = 0
        let hi = previewChars
        while (lo <= hi) {
          const mid = Math.floor((lo + hi) / 2)
          if (fits(mid)) {
            chosen = mid
            lo = mid + 1
          } else {
            hi = mid - 1
          }
        }
        if (chosen >= 0 && !fits(chosen)) chosen = -1
      }
      if (chosen >= 0) {
        metrics?.counter?.('v3.recall.preview-shrunk', 1)
        cap = chosen
        keep = hitLines.length
        composed = compose(hitLines.length, chosen)
        lines = composed.lines
      }
    }
    // R02：预算收敛之后**实际**进了正文的命中（compose 的 dropped 集合是唯一判据，
    // 与正文逐行同源），下游的 hits / 计数 / 租约 / 返回字段一律以它为准。
    const keptPackIndexes = []
    for (let n = 0; n < hitLines.length; n += 1) {
      if (keep > 0 && orderToDrop.slice(0, hitLines.length - keep).includes(n)) continue
      if (keep === 0) continue
      keptPackIndexes.push(n)
    }
    const finalPresented = keptPackIndexes.map((n) => hitPackIndex[n])
    const presentedHits = finalPresented.map((packIndex) => result.pack[packIndex])
    const pack = lines.join('\n')
    // 头尾固定行本身超上限（超长 OOV 词表）：**拒绝注入**而不是带着「已超限」的包进模型。
    // 硬顶是「能注入→有上界」的承诺，capExceeded 只做标记等于失败开放。
    if (pack.length > RECALL_PACK_MAX_CHARS) {
      metrics?.counter?.('v3.recall.cap-exceeded', 1)
      return notPresented('pack-over-cap', {
        reason: '回注包固定行超过硬顶 ' + RECALL_PACK_MAX_CHARS + ' 字符（拒绝注入）',
        capExceeded: true,
      })
    }
    // 零命中的「纯壳」不注入：预算被固定行占满时 keep 会收敛到 0，
    // 若只判长度就会把一条命中都没有的壳包塞进模型（与「纯壳不注入」纪律相悖）。
    // P2-08：纯壳判据 = **正文总量为 0**（`keep === 0` 只是其中一种形态）。
    // previewChars=0 时条数不为 0 但正文为 0——同样不得注入（否则模型只看到三行「…」，
    // 既违反纪律又白耗配额）。
    if (keep === 0 || composed.bodyChars === 0) {
      metrics?.counter?.('v3.recall.skipped', 1)
      return notPresented('empty-pack', {
        reason: keep === 0
          ? '预算被固定行占满，命中条目全部放不下（纯壳不注入）'
          : '命中条目的摘录正文为空（previewChars=' + previewChars + '，纯壳不注入）',
        bodyChars: composed.bodyChars,
      })
    }
    if (keep < hitLines.length) metrics?.counter?.('v3.recall.pack-truncated', 1)
    metrics?.counter?.('v3.recall.injected', 1)
    // R04：装包确认成功才提交占位。bodyId 是确定性来源身份（同回合同查询同命中 → 同 ID），
    // 入口下一轮据它对账「宿主是否真的落了这条消息」；宿主提交失败时同一回合重试拿到同一个 ID。
    const ids = presentedHits.map((hit) => hit.id)
    // 用例层的「已装包」= handoff（本层没有宿主通道）：它只阻止同回合再装一次；
    // **是否算成功呈现由入口的宿主事件确认决定**（entry.reconcileInjectionFromEvents）。
    leases.handoff(sessionKey, turn, { bodyId, recordIds: ids })
    return {
      injected: true,
      text: pack,
      // R02：hits / injectedHits / 租约都只对应**实际呈现**的条目；候选数（装包阈内的
      // 命中总数）另给 displayedCandidates，避免「用 10 条候选冒充 10 条呈现」。
      hits: presentedHits,
      displayedCandidates: result.pack.length,
      presentedIds: ids,
      bodyId,
      injectedHits: presentedHits.length,
      omittedHits: hitLines.length - keep,
      unreadableHits,
      capExceeded: false,
      oovTerms: result.oovTerms,
      // P5：窗口与偏移契约（码点半开区间）；chunkHits 是该记录命中的 chunk 数，
      // **不是证据条数**——证据仍按记录去重（presentedIds），多个 chunk 不虚增 hits。
      excerpts: excerptInfos.filter((_info, n) => keep > 0 && !orderToDrop.slice(0, hitLines.length - keep).includes(n)),
      offsetUnit: EXCERPT_OFFSET_UNIT,
      chunkIndexStates: [...new Set(chunkIndexStates)],
      chunkIndexTruncatedRecords,
      chunkIndexTruncatedHits,
      searchStatus,
      partial: result.partial === true || searchStatus === 'partial',
      t1Fallback: result.t1Fallback === true,
      searchReason: typeof result.reason === 'string' ? result.reason : null,
      // 候选关闭时**不出现这个键**：off 路径与 HEAD 逐字节等价（见 v3-g6b-recall-dedupe 的指纹表）。
      ...(dedupe === null ? {} : { dedupe }),
    }
  }
  api.readByRef = readByRef
  /** 本回合是否已确认呈现过一次回注（只读）。 */
  api.presentedTurn = presentedTurn
  /** 已确认呈现的 (session, turn) 键（诊断用）。 */
  api.committedTurns = () => leases.committedKeys()
  /**
   * 撤销本回合的「已呈现」记账（R04）：调用方在**取数成功但消息没交给宿主**时调用
   * （next() 非 enter / 取消 / 宿主提交抛错）。只清本用例自己的进程内租约，
   * 不碰任何存储与宿主面。
   */
  api.releasePresentedTurn = (turn) => leases.forget(sessionKey, turn)
  return api
}
