/**
 * P7 首次呈现用例（0.15.0 候选，**默认关闭**，装配可达但零激活）。
 *
 * ## 职责边界
 * 在**一次 pre-step 内同步完成**：选本轮新出现的纯文本大结果 → 持久化原件 →
 * 回读逐字校验 → 用受限端口改写成固定回执 → 由端口复核活动面 → 复核遗忘代际。
 * 任一步失败即**保留原文**（fail-open），不排队、不重试、不后台化（§3.6）。
 *
 * ## 为什么必须同步
 * 「首次入模」依赖源码顺序：pre-step 之后 buildRequest 才 deriveMessages
 * （dsh-agent-loop lib/index.js:956/1075/1274）。若把持久化丢到后台，替换时点可能晚于
 * 下一个请求，原文已入模——那就不是首次呈现。故本用例只做有界同步工作。
 *
 * ## 默认关闭与装配边界（G4）
 * 真实入模时序（替换发生在目标请求之前）与 wire 层可见性**未验**（G3 判定
 * logical-request=not-wired / wire=no-seam）→ 本轮交付离线可实施子集：
 * 入口只 import + 构造候选句柄（createFirstIngressCandidate，默认关闭、独立开关），
 * pre-step 钩子**不引用它**；真实时序留 G8。不能把「装配可达」写成「候选已生效」。
 *
 * ## 选点口径（P1-2）
 * - **最新优先**（seq 降序），每步仍只做 maxPerStep 个；
 * - 只处理**本次新出现**（seq > state.presentedThroughSeq）且未预览过的结果；
 * - 水位缺失 → status=no-watermark，失败关闭不动作（无法判定「是否已呈现」时不得猜）；
 * - 已先以全文呈现过的结果默认**不改写**（accounting.presentedFull）；
 *   rewritePresented=true 才改写，并逐条计入 accounting.presentedThenArchived——
 *   那是**消费后归档成本**，不是首次呈现收益。
 *
 * ## 状态机（持久化 → 回读核验 → 替换表层 → 确认实际呈现）
 * 每一步都有独立结局，且与持久层/表层/报告三者对齐（reconcileFirstIngress 可外部复核）：
 * persist-failed / persist-invalid / readback-failed / readback-mismatch / generation-changed /
 * not-worth / pairing-unbalanced / replace-failed / replaced-unconfirmed / cancelled；
 * 成功项无 reason 字段。取消只在**替换前**保留原文；替换后确认失败一律 rewritten-unconfirmed
 * （不得声称原文没动）。
 *
 * ## 与回读入口的关系（G4）
 * 回执只指向**能实际分页**的 memory_context_read（码点 offset/length/cursor）；命令面
 * /memory-lab read 是不分页的另一条通道，回执里如实提示不要依赖它。
 *
 * ## 收益口径
 * 回执大小计入收益：每项报 sourceChars（正文码点）与 receiptChars（预览码点）与 netChars；
 * 预览不比正文短就不换（not-worth）——回执本身也是要付 token 的。
 */
import { V3ContractViolation } from '../contracts/errors.mjs'
import {
  FIRST_INGRESS_DEFAULTS,
  charCountOf,
  contentHashOf,
  externalIdOf,
  isPreviewContent,
  isReadbackResult,
  pairingOfSurface,
  pagingOf,
  previewBlocksOf,
  shouldExternalize,
  surfaceStateOf,
  textOfBlocks,
  toolCallOf,
} from '../domain/first-ingress/preview.mjs'
import { isRecordId } from '../contracts/records.mjs'
import {
  FIRST_INGRESS_ASSEMBLY_CONTRACT,
  FIRST_INGRESS_POLICY_VERSION,
  FIRST_INGRESS_STATUSES,
} from '../contracts/readback.mjs'

/** 运行参数：enabled 缺省 false（未接线 + 未显式开启时永不动作）。 */
const RUNTIME_DEFAULTS = Object.freeze({
  enabled: false,
  maxPerStep: 3,
  /** 已先以全文呈现过的结果是否允许改写：默认不允许（见文件头「选点口径」）。 */
  rewritePresented: false,
})

/** 停用结局的固定形状（不读 store、不碰 session）。 */
const DISABLED_REPORT = Object.freeze({ status: 'disabled', previewed: 0, skipped: 0, items: [] })

/**
 * 读取呈现水位：非负整数才算数，其余一律 null（不可判定 → 失败关闭）。
 * 水位语义 = 「上次运行前已进入过请求的活动面最大 seq」。
 */
function presentedThroughSeqOf(state) {
  if (state === null || typeof state !== 'object') return null
  const value = state.presentedThroughSeq
  return Number.isInteger(value) && value >= 0 ? value : null
}

/**
 * 独立开关（G4 §10 默认与门禁）：只认设置里 firstIngress.enabled === true。
 * 与既有 cooling/recall/fullHistory 开关**无耦合**——候选启用不是「模式」的一部分。
 */
function switchOn(settings) {
  const raw = settings === null || typeof settings !== 'object' ? null : settings.firstIngress
  return raw !== null && typeof raw === 'object' && raw.enabled === true
}

/** 活动面上某个 seq 的 content（不存在/形状不符返回 null，不猜）。 */
function contentAt(session, seq) {
  if (!Number.isInteger(seq) || seq < 0 || typeof session?.eventAt !== 'function') return null
  const event = session.eventAt(seq)
  const content = event?.data?.message?.content
  return Array.isArray(content) ? content : null
}
/**
 * 表层状态（**按活动面判**，对账与替换失败后的复核共用这一份判据）。
 *
 * 目标 seq 还在面上 → 直接看它的正文；已经离面（被替换）→ 在面上找带本次幂等 ID 的回执：
 * 找到 = 这次外置已经成立（可能是并发/上一轮写的），找不到 = 被别的东西改掉了（diverged）。
 * 两种诊断含义完全不同，不能合成「原文仍在」。
 */
function surfaceStateAfter(session, { seq, externalId, expectedSurfaceHash }) {
  const nodes = Array.isArray(session.surface?.nodes) ? session.surface.nodes : []
  if (nodes.includes(seq)) {
    return surfaceStateOf({ content: contentAt(session, seq), externalId, expectedSurfaceHash })
  }
  let state = 'diverged'
  for (const node of nodes) {
    const content = contentAt(session, node)
    if (!isPreviewContent(content)) continue
    const found = surfaceStateOf({ content, externalId, expectedSurfaceHash })
    if (found === 'externalized') return 'externalized'
    if (found === 'externalized-other') state = 'externalized-other'
  }
  return state
}

/** 结局必须落在封闭集里（报告状态是协议，不允许自由字符串）。 */
function assertStatus(status) {
  if (!FIRST_INGRESS_STATUSES.includes(status)) {
    throw new V3ContractViolation('v3 first-ingress: 未登记的结局 ' + String(status))
  }
  return status
}

/** 错误码归一（只用于报告字段，不改变抛出语义）。 */
function codeOf(error) {
  return typeof error?.code === 'string' && error.code.length > 0 ? error.code : 'EINTERNAL'
}

/**
 * 遗忘代际读取（G4：forget/undo 在异步完成前后都复核）。
 *
 * 优先用端口自己的 generationOf（能区分「读不到」与「内容变了」）；没有该方法时退回
 * readOriginal 的正文 hash。任何异常都归一成 unreadable:<code>——「不知道」绝不当成「没变」。
 */
async function generationOf(store, recordId) {
  try {
    if (typeof store.generationOf === 'function') {
      const row = await store.generationOf(recordId)
      if (row === null || typeof row !== 'object') return 'unknown'
      return row.readable === true ? String(row.digest) : 'unreadable:' + String(row.digest)
    }
    const read = await store.readOriginal(recordId)
    const text = typeof read?.text === 'string' ? read.text : ''
    return text.length > 0 ? contentHashOf([{ type: 'text', text }]) : 'unreadable:empty'
  } catch (error) {
    return 'unreadable:' + codeOf(error)
  }
}

/**
 * 执行一轮首次呈现候选处理（持久化 → 回读核验 → 替换表层 → 确认实际呈现）。
 *
 * @param {object} deps
 * @param {object} deps.session 宿主 session（surface.nodes / eventAt）
 * @param {object} deps.host HostSurface（需实现受限的 replaceToolResultContent）
 * @param {object} deps.store { persistOriginal, readOriginal, generationOf? }（见 adapters/storage/first-ingress-records.mjs）
 * @param {object} [deps.state] 呈现代理状态（{presentedThroughSeq}；调用方跨请求持有）
 * @param {object} [deps.config] { enabled, thresholdChars, headChars, tailChars, maxPerStep, rewritePresented, policyVersion }
 * @param {object} [deps.signal] AbortSignal 形状（{aborted}）：替换前取消一律保留原文
 * @param {string} [deps.sessionKey] 会话键（幂等 ID 的维度之一；缺省取 session.id）
 * @returns {Promise<object>} 结局与逐项报告（status 落在 contracts/readback.mjs 的封闭集）
 */
export async function runFirstIngressPreview({ session, host, store, state = null, config = {}, signal = null, sessionKey = null } = {}) {
  const settings = { ...FIRST_INGRESS_DEFAULTS, ...RUNTIME_DEFAULTS, ...(config ?? {}) }
  if (settings.enabled !== true) return { ...DISABLED_REPORT, items: [] }
  if (session === null || typeof session !== 'object' || typeof session.eventAt !== 'function' || session.surface === undefined) {
    throw new V3ContractViolation('v3 first-ingress: 需要宿主 session（surface.nodes + eventAt）')
  }
  if (host === null || typeof host !== 'object' || typeof host.replaceToolResultContent !== 'function') {
    throw new V3ContractViolation('v3 first-ingress: 宿主端口缺受限方法 replaceToolResultContent（不允许降级成通用 surfaceOp）')
  }
  if (store === null || typeof store !== 'object'
    || typeof store.persistOriginal !== 'function' || typeof store.readOriginal !== 'function') {
    throw new V3ContractViolation('v3 first-ingress: store 端口必须提供 persistOriginal 与 readOriginal（无法回读就不外置）')
  }
  const maxPerStep = Number.isInteger(settings.maxPerStep) && settings.maxPerStep >= 0 ? settings.maxPerStep : 0
  const nodesOf = () => (Array.isArray(session.surface?.nodes) ? [...session.surface.nodes] : [])
  const eventAt = (seq) => session.eventAt(seq)
  const nodes = nodesOf()

  // 安全前提（P7 硬边界）：活动面上还有未闭合 tool-call 时**整轮不动作**。
  // 此时请求本身就不能合法派生；再改一个 tool/result 只会把插件写进可疑现场。
  const pairing = pairingOfSurface({ nodes, eventAt })
  if (!pairing.balanced) {
    return {
      status: 'pairing-unbalanced',
      previewed: 0,
      skipped: 0,
      items: [],
      open: pairing.open,
      orphanResultSeq: pairing.orphanResultSeq,
    }
  }

  const accounting = {
    newlyAppeared: 0,
    presentedFull: 0,
    presentedThenArchived: 0,
    belowThreshold: 0,
    unconfirmed: 0,
    alreadyExternalized: 0,
    cancelled: 0,
    notWorth: 0,
    sourceChars: 0,
    receiptChars: 0,
    netChars: 0,
  }
  const watermark = presentedThroughSeqOf(state)
  // 水位缺失：无法判定「哪些结果已经在之前的请求里出现过」——不猜，整轮不动作（§5）。
  if (watermark === null) {
    return {
      status: 'no-watermark',
      previewed: 0,
      skipped: 0,
      items: [],
      rewritten: 0,
      unconfirmed: 0,
      accounting,
      presentedThroughSeq: null,
    }
  }
  const key = typeof sessionKey === 'string' && sessionKey.length > 0 ? sessionKey : String(session?.id ?? '')
  if (key.length === 0) {
    throw new V3ContractViolation('v3 first-ingress: 需要会话键（幂等 ID 与会话隔离都依赖它）')
  }
  const policyVersion = Number.isInteger(settings.policyVersion) ? settings.policyVersion : FIRST_INGRESS_POLICY_VERSION
  const aborted = () => signal !== null && typeof signal === 'object' && signal.aborted === true
  const items = []
  let previewed = 0
  let skipped = 0
  let rewritten = 0
  let unconfirmed = 0
  let cancelled = false
  let divergent = false
  const rewritePresented = settings.rewritePresented === true
  const ordered = [...nodes].sort((a, b) => b - a)
  // 「本次新出现」按整面先数一遍（不受 maxPerStep 截断影响）——这是观测口径，
  // 不是待处理队列，不然后面的预算会把计数也一起截掉。
  for (const seq of ordered) {
    if (!Number.isInteger(seq) || seq <= watermark) continue
    const event = eventAt(seq)
    if (event?.type === 'tool/result' && Array.isArray(event.data?.message?.content)
      && !isPreviewContent(event.data.message.content)) {
      accounting.newlyAppeared += 1
    }
  }

  // 最新优先：seq 降序即「最近的工具结果先处理」，每步仍受 maxPerStep 限制。
  for (const seq of ordered) {
    if (rewritten >= maxPerStep) break
    if (!Number.isInteger(seq) || seq < 0) continue
    const event = eventAt(seq)
    if (event === null || typeof event !== 'object' || event.type !== 'tool/result') continue
    const content = event.data?.message?.content
    if (!Array.isArray(content)) continue
    // 已外置过（带标记）的正文不再处理：旧回执 / 回读副本都在这里出局（幂等）。
    if (isPreviewContent(content)) { accounting.alreadyExternalized += 1; continue }

    const isNew = seq > watermark
    if (!isNew && !rewritePresented) {
      // 已先以全文呈现过：默认保留原文，只记账（不是「跳过了一个候选」）。
      accounting.presentedFull += 1
      continue
    }
    // P2-3 / G4：回读来源（插件写回/带 readbackOf 标记/本插件工具结果标记）不是新工具结果。
    if (isReadbackResult(event)) {
      skipped += 1
      items.push({ seq, reason: 'readback-source' })
      continue
    }
    if (!shouldExternalize(content, settings)) {
      if (isNew) accounting.belowThreshold += 1
      continue
    }

    const surfaceContentHash = contentHashOf(content)
    // 稳定来源身份（dsh-<seq>）由**记录端口**给出（adapters 层是宿主事件 ID 形状的唯一读取点）；
    // application 不 import adapters（层规则），也不在这里另写一份形状。
    const base = { seq, surfaceContentHash }
    const message = event.data?.message ?? {}
    const isError = message.isError === true
    const callId = typeof message.toolCallId === 'string' && message.toolCallId.length > 0
      ? message.toolCallId
      : (typeof message.source?.callId === 'string' && message.source.callId.length > 0 ? message.source.callId : null)
    // P2-4：回执必须带工具身份（工具名/callId）；找不到声明就如实写「未知」。
    const toolCall = toolCallOf({ nodes, eventAt, callId })
    const toolName = toolCall?.name ?? null

    // 取消（替换前）：一律保留原文；报告与表层一致（cancelled-before-replace）。
    if (aborted()) {
      cancelled = true
      accounting.cancelled += 1
      items.push({ ...base, reason: 'cancelled-before-replace' })
      break
    }

    // 复用既有摄入记录：persistOriginal 只查找/回读，不新建记录类型、不写第二套冷库。
    let persisted
    try {
      persisted = await store.persistOriginal({ seq, contentHash: surfaceContentHash, isError, callId })
    } catch (error) {
      skipped += 1
      items.push({ ...base, reason: 'persist-failed', error: codeOf(error) })
      continue
    }
    const recordId = persisted?.recordId
    const storedText = persisted?.text
    if (!isRecordId(recordId) || typeof storedText !== 'string' || storedText.length === 0) {
      skipped += 1
      items.push({ ...base, reason: 'persist-invalid' })
      continue
    }
    // 记录正文与宿主原文是否一致（脱敏/改写会让 hash 不等）；未知不冒充。
    const exactCopy = persisted?.surfaceHashMatched === true ? true : (persisted?.surfaceHashMatched === false ? false : null)
    const recordTextHash = typeof persisted?.recordTextHash === 'string'
      ? persisted.recordTextHash
      : contentHashOf([{ type: 'text', text: storedText }])
    const sourceEventId = typeof persisted?.surfaceEventId === 'string' && persisted.surfaceEventId.length > 0
      ? persisted.surfaceEventId
      : null
    if (sourceEventId === null) {
      skipped += 1
      items.push({ ...base, recordId, reason: 'persist-invalid' })
      continue
    }
    const externalId = externalIdOf({ sessionKey: key, sourceEventId, surfaceContentHash, policyVersion })
    const sourceChars = charCountOf(storedText)
    const itemBase = { ...base, sourceEventId, externalId, recordId, recordTextHash, sourceChars }
    // 遗忘代际基线：持久化完成、回读之前取一次，之后每次异步窗口结束都比对它。
    const generation = await generationOf(store, recordId)

    // 取消（持久化后、替换前）：同样保留原文——持久层可以已有记录（幂等），表层不动。
    if (aborted()) {
      cancelled = true
      accounting.cancelled += 1
      items.push({ ...itemBase, reason: 'cancelled-before-replace' })
      break
    }

    let readback
    try {
      readback = await store.readOriginal(recordId)
    } catch (error) {
      skipped += 1
      items.push({ ...itemBase, reason: 'readback-failed', error: codeOf(error) })
      continue
    }
    // 回读必须逐字等于已保存正文：读不回就不改面（§3.6「回读成功」是启用前提）。
    // 比较的是**记录正文**（可能已脱敏），不是宿主原始字节——预览以可读副本为准。
    if (typeof readback?.text !== 'string' || readback.text !== storedText) {
      skipped += 1
      items.push({ ...itemBase, reason: 'readback-mismatch' })
      continue
    }

    // 遗忘代际复核（读回之后、改写之前）：forget/undo 都可能发生在这段异步窗口里。
    const afterReadback = await generationOf(store, recordId)
    if (afterReadback !== generation) {
      skipped += 1
      items.push({ ...itemBase, reason: 'generation-changed', generation: afterReadback })
      continue
    }
    if (aborted()) {
      cancelled = true
      accounting.cancelled += 1
      items.push({ ...itemBase, reason: 'cancelled-before-replace', generation })
      break
    }

    let preview
    try {
      preview = previewBlocksOf({
        content: [{ type: 'text', text: storedText }],
        handle: recordId,
        sourceEventId,
        externalId,
        surfaceContentHash,
        recordTextHash,
        toolName,
        callId,
        isError,
        exactCopy,
        config: settings,
      })
    } catch {
      skipped += 1
      items.push({ ...itemBase, reason: 'preview-invalid' })
      continue
    }
    // 回执大小计入收益：回执不比正文短就不换（换一次只会更大）。
    const receiptChars = charCountOf(textOfBlocks(preview))
    if (receiptChars >= sourceChars) {
      skipped += 1
      accounting.notWorth += 1
      items.push({ ...itemBase, receiptChars, reason: 'not-worth' })
      continue
    }

    // 逐项再复核一次配对：循环里没有别的写者，但宿主可能有；宁可不换，不猜。
    const stillPaired = pairingOfSurface({ nodes: nodesOf(), eventAt })
    if (!stillPaired.balanced) {
      skipped += 1
      items.push({ ...itemBase, reason: 'pairing-unbalanced' })
      break
    }

    let replaced
    try {
      replaced = await host.replaceToolResultContent({ seq, expectedContentHash: surfaceContentHash, content: preview })
    } catch (error) {
      // P2-1：端口已 append 但复核失败——请求面已变，必须独立上报，不得宣称原文仍全文。
      if (error?.code === 'EWRITE_UNCONFIRMED') {
        rewritten += 1
        unconfirmed += 1
        accounting.unconfirmed += 1
        items.push({ ...itemBase, receiptChars, reason: 'replaced-unconfirmed', rewritten: true, confirmed: false, charsAfter: null })
        break
      }
      // 替换失败后复核表层（**按活动面判**，不是只看那个 seq 的旧正文）：
      // - 面上已经有本次幂等 ID 的回执 → 并发/上一轮已经完成这次外置，如实记
      //   externalized-concurrently（不是失败，也不是「原文仍在」）；
      // - 面上被别的东西改掉 → state-diverged；
      // - 仍是原文 → replace-failed（可以重试）。
      const afterState = surfaceStateAfter(session, { seq, externalId, expectedSurfaceHash: surfaceContentHash })
      if (afterState === 'externalized') {
        accounting.alreadyExternalized += 1
        items.push({ ...itemBase, receiptChars, reason: 'externalized-concurrently', surface: afterState })
        continue
      }
      skipped += 1
      items.push({ ...itemBase, receiptChars, reason: 'replace-failed', surface: afterState, error: codeOf(error) })
      if (afterState !== 'original') {
        divergent = true
        break
      }
      continue
    }

    // 替换之后复核持久层（遗忘代际）：读不回来就不再宣称成功。
    const postGeneration = await generationOf(store, recordId)
    if (postGeneration !== generation) {
      rewritten += 1
      unconfirmed += 1
      accounting.unconfirmed += 1
      items.push({
        ...itemBase,
        receiptChars,
        reason: 'post-replace-generation-changed',
        rewritten: true,
        confirmed: false,
        charsAfter: charCountOf(textOfBlocks(preview)),
        generation: postGeneration,
      })
      break
    }

    previewed += 1
    rewritten += 1
    if (!isNew) accounting.presentedThenArchived += 1
    accounting.sourceChars += sourceChars
    accounting.receiptChars += receiptChars
    items.push({
      ...itemBase,
      replacementSeq: replaced?.seq ?? null,
      charsBefore: sourceChars,
      charsAfter: receiptChars,
      toolName,
      callId,
      isError,
      exactCopy,
      presentedBefore: !isNew,
      pages: pagingOf(storedText).pages,
      cancelledAfterReplace: aborted(),
    })
  }

  // 用**当前**活动面（含本次改写追加的节点）：它才是下一个请求真正会看到的范围。
  const surfaceMax = nodesOf().reduce((max, seq) => (Number.isInteger(seq) && seq >= 0 ? Math.max(max, seq) : max), -1)
  const status = unconfirmed > 0 ? 'rewritten-unconfirmed' : (divergent ? 'state-diverged' : (cancelled ? 'cancelled' : 'ok'))
  accounting.netChars = accounting.sourceChars - accounting.receiptChars
  let presentedThroughSeq = watermark
  // 确认失败/取消/状态不符时活动面处于可疑状态：不推进水位（下一次仍按旧水位复核，
  // 不把未知当已处理）。
  if (status === 'ok' && !aborted() && state !== null && typeof state === 'object') {
    presentedThroughSeq = Math.max(watermark, surfaceMax)
    state.presentedThroughSeq = presentedThroughSeq
  }
  return {
    status: assertStatus(status),
    previewed,
    skipped,
    items,
    rewritten,
    unconfirmed,
    accounting,
    presentedThroughSeq,
  }
}

/**
 * 持久层状态（对账用）：只回答「这条记录现在还能不能按 ID 读回、内容还是不是那一份」。
 * 与 contracts/readback.mjs 的两种 hash 同名：compared 时用的是 record-text-hash。
 */
async function persistenceStateOf(store, item) {
  if (typeof item?.recordId !== 'string' || !isRecordId(item.recordId)) return 'not-persisted'
  let read
  try {
    read = await store.readOriginal(item.recordId)
  } catch (error) {
    return codeOf(error) === 'EFORGOTTEN' ? 'forgotten' : 'missing'
  }
  const text = typeof read?.text === 'string' ? read.text : ''
  if (text.length === 0) return 'missing'
  if (typeof item.recordTextHash === 'string') {
    return (typeof read?.recordTextHash === 'string' ? read.recordTextHash : contentHashOf([{ type: 'text', text }]))
      === item.recordTextHash ? 'readable' : 'changed'
  }
  return 'readable'
}

/**
 * 三态对账（G4 §10「每种情况断言持久层/表层/报告状态三者一致」）。
 *
 * 输入是 runFirstIngressPreview 返回的 items（含 seq / externalId / surfaceContentHash /
 * recordId / recordTextHash / reason），输出逐项 { surface, persistence, report, consistent }。
 *
 * 表层判定按**活动面**判：目标 seq 还在面上 → 直接看它的正文；已经离面（被替换）→ 在面上
 * 找带本次幂等 ID 的回执，找不到就是 diverged（被别的写入者改掉，不是「原文仍在」）。
 *
 * 一致性规则（报告 ↔ 表层 ↔ 持久层）：
 * - 报告 ok：表层必须 externalized，且持久层可读；
 * - 报告 replaced-unconfirmed / post-replace-generation-changed：表层必须**不是**原文（已改写），
 *   持久层仍必须可读（写回执前已经过回读校验）；
 * - 其余失败/取消结局：表层必须仍是 original；有 recordId 的必须仍可读，没有的必须 not-persisted。
 */
export async function reconcileFirstIngress({ session, store, items } = {}) {
  if (session === null || typeof session !== 'object' || typeof session.eventAt !== 'function') {
    throw new V3ContractViolation('v3 first-ingress: 对账需要宿主 session（eventAt）')
  }
  if (!Array.isArray(items)) {
    throw new V3ContractViolation('v3 first-ingress: 对账需要 items 数组（runFirstIngressPreview 的返回）')
  }
  const rows = []
  for (const item of items) {
    const expectedSurfaceHash = typeof item?.surfaceContentHash === 'string' ? item.surfaceContentHash : null
    const externalId = typeof item?.externalId === 'string' ? item.externalId : null
    const surface = surfaceStateAfter(session, { seq: item?.seq, externalId, expectedSurfaceHash })
    const persistence = store === null || typeof store !== 'object' ? 'unknown' : await persistenceStateOf(store, item)
    const report = typeof item?.reason === 'string' && item.reason.length > 0 ? item.reason : 'ok'
    // 报告 → 表层期望：成功类必须看到回执；已改写类必须**不是**原文；其余必须仍是原文。
    const expectsSurface = report === 'ok' || report === 'externalized-concurrently'
      ? 'externalized'
      : (report === 'replaced-unconfirmed' || report === 'post-replace-generation-changed' ? 'rewritten' : 'original')
    const surfaceOk = expectsSurface === 'externalized' ? surface === 'externalized'
      : expectsSurface === 'rewritten' ? (surface !== 'original' && surface !== 'unknown')
      : surface === 'original'
    // 持久层期望：只有「声称成功」才要求可读；其余有 recordId 的允许 readable/changed/forgotten/missing
    // （失败本身常常就是遗忘/改写造成的），但不能是「未持久化」；没有 recordId 的必须未持久化。
    const claimsSuccess = report === 'ok' || report === 'externalized-concurrently'
    const persistenceOk = typeof item?.recordId === 'string'
      ? (claimsSuccess ? persistence === 'readable' : persistence !== 'not-persisted' && persistence !== 'unknown')
      : persistence === 'not-persisted'
    rows.push({
      seq: item?.seq ?? null,
      externalId,
      recordId: typeof item?.recordId === 'string' ? item.recordId : null,
      report,
      surface,
      persistence,
      consistent: surfaceOk && persistenceOk,
    })
  }
  return { rows, consistent: rows.every((row) => row.consistent === true) }
}

/**
 * 候选装配句柄（G4「装配可达、默认关闭、零激活」）。
 *
 * 入口只 import + 构造它：零 I/O、零监听、零写盘；pre-step 钩子不引用它。
 * 开关独立（设置里的 firstIngress.enabled，与 cooling/recall/fullHistory 无耦合），
 * 缺省 false。真机时序未验（G8），因此**装配可达 ≠ 候选已生效**。
 */
export function createFirstIngressCandidate({ settingsNow } = {}) {
  const readSettings = typeof settingsNow === 'function' ? settingsNow : () => ({})
  const enabledNow = () => {
    try {
      return switchOn(readSettings())
    } catch {
      return false // 读设置失败 = 不开（失败关闭，不把异常当「默认开」）
    }
  }
  return Object.freeze({
    contract: FIRST_INGRESS_ASSEMBLY_CONTRACT,
    status: 'inactive',
    activation: 'none',
    enabled: enabledNow(),
    reason: 'default-off',
    policyVersion: FIRST_INGRESS_POLICY_VERSION,
    /** 当前开关值（每次重读设置；未开启时不读 store、不碰 session）。 */
    enabledNow,
    /** 显式开启后才会真的执行；未开启时直接 disabled（调用方也拿不到副作用）。 */
    async run(deps = {}) {
      if (!enabledNow()) return { ...DISABLED_REPORT, items: [] }
      return runFirstIngressPreview({ ...deps, config: { ...(deps.config ?? {}), enabled: true } })
    },
    /** 三态对账（重试/重启/迟到回调后由调用方复核）。 */
    async reconcile(deps = {}) {
      return reconcileFirstIngress(deps)
    },
  })
}
