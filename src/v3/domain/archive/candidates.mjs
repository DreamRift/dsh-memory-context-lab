/**
 * 归档候选选择（domain/archive，纯函数，M2）。
 *
 * 判据（安全优先）：
 * - 真人 user/message 是操作边界；当前回合（最后一个真人消息及其后的节点）永不归档；
 * - 只选**连续 surface 节点**；`sourceEventSeqs` 必须覆盖被遮蔽的全部节点；
 * - 插件自己的回执/恢复节点不参与归档，也不跨过它们拼 span；
 * - **不做回执吸收**（0.14.0-beta.53，AUD51-05-02）：每次归档保留独立回执节点。
 *   吸收（B3-11）会把旧回执的正文从活动面抹掉，而 restore 是按「回执正文逐字节
 *   在活动面找节点」定位的——旧凭证因此永久不可恢复（实测 restore all 1/5）。
 * - M2 只归档「每个节点都有 v3 记录」的 span：没有记录就无法按 ID 恢复，不做不可恢复的遮蔽。
 * - full-history：所有已完成操作；cooling：只保留最近 retainOperations 个完成操作，等压力闸门。
 */
import { V3ContractViolation } from '../../contracts/errors.mjs'
import { callIdOf, createToolCallIndex, indexToolCallEvent, isHumanUserEvent, isPluginSurfaceEvent, isRecallPackEvent, isStructuralSurfaceEvent, toolCallDeclarationsOf, toolClosureOfRange } from './event-shape.mjs'

// —— B3-8（AUD50-04-03）增量投影缓存 ——
// 选择器每个 pre-step 都被调用，旧实现每次全量扫 events 建全量 Map（bySeq + dsh 的
// turnAt），35k 事件的会话每步固定 ~2.5ms 且随历史线性。会话日志是 **append-only**：
// 按「数组身份 + 长度」做增量缓存——长度没变直接复用；变长只合并新增段；变短
// （测试替身重排/复用数组）全量重建。失效条件就这两条；「已有元素不被改写」与宿主
// append-only 契约一致——改写内容但不换数组身份的用法不在适用面，调用方应传新数组。
const bySeqCache = new WeakMap()
const turnCache = new WeakMap()
const cacheStats = { builds: 0, merges: 0, mergedEvents: 0, hits: 0 }

/** 测试/诊断用：缓存命中画像（生产不调用；守卫测试用它做「不随历史线性变慢」的结构断言）。 */
export function _candidatesCacheStats() {
  return { ...cacheStats }
}

/** 测试用：清零缓存画像计数（不改缓存内容）。 */
export function _resetCandidatesCacheStats() {
  cacheStats.builds = 0
  cacheStats.merges = 0
  cacheStats.mergedEvents = 0
  cacheStats.hits = 0
}

function cachedBySeq(events) {
  let entry = bySeqCache.get(events)
  if (entry === undefined || events.length < entry.upto) {
    entry = { upto: 0, bySeq: new Map(), toolIndex: createToolCallIndex() }
    bySeqCache.set(events, entry)
    cacheStats.builds += 1
  } else {
    cacheStats.hits += 1
  }
  if (events.length > entry.upto) {
    for (let i = entry.upto; i < events.length; i += 1) {
      const event = events[i]
      if (Number.isInteger(event?.seq)) entry.bySeq.set(event.seq, event)
      // R06：同一趟增量遍历维护「callId → 声明/调用/结果所在 seq」索引，
      // 用于证明候选范围没有把一次调用拆到范围外（不额外扫全会话）。
      indexToolCallEvent(entry.toolIndex, event)
    }
    cacheStats.mergedEvents += events.length - entry.upto
    cacheStats.merges += 1
    entry.upto = events.length
  }
  return entry
}

/** dsh 分组的轮次投影：seq → 最近一次 turn/start|step/start 的 turn（回执节点除外）。 */
function cachedTurnProjection(events) {
  let entry = turnCache.get(events)
  if (entry === undefined || events.length < entry.upto) {
    entry = { upto: 0, turnAt: new Map(), lastTurn: null }
    turnCache.set(events, entry)
    cacheStats.builds += 1
  } else {
    cacheStats.hits += 1
  }
  if (events.length > entry.upto) {
    for (let i = entry.upto; i < events.length; i += 1) mergeTurnEvent(entry, events[i])
    cacheStats.mergedEvents += events.length - entry.upto
    cacheStats.merges += 1
    entry.upto = events.length
  }
  return entry
}

function mergeTurnEvent(entry, event) {
  if (!Number.isInteger(event?.seq)) return
  // 非回注的插件节点（归档回执/恢复）是表面分隔，不是轮次成员：给它打 turn 会让
  // 回执在下一轮被当成「插件边界」，把那一轮整组挡住（真实形状：回执替换了上一段后
  // 落在下一轮第一个节点之前，turn/start 已把它的 seq 归到下一轮）。它在选择循环里
  // 走 turn === undefined 的 finish/跳过分支，轮组从回执之后重新开始。
  if (isPluginSurfaceEvent(event) && !isRecallPackEvent(event)) return
  // turn/start 与 step/start 都带 turn；step/start 覆盖「turn 内每一步」，更细。
  if (event.type === 'turn/start' || event.type === 'step/start') {
    if (Number.isInteger(event?.data?.turn)) entry.lastTurn = event.data.turn
  }
  // 第一轮开始之前的节点没有轮次归属：不猜、不归档（留在活动面上）。
  if (entry.lastTurn !== null) entry.turnAt.set(event.seq, entry.lastTurn)
}

/**
 * 把 surface 节点按「一轮」分组。
 *
 * 两种判定（0.14.0-beta.47，可在插件设置页切换；默认不变）：
 * - `human`：**真人 user/message** 是回合边界。目标自动继续（`source.kind='goal'`）
 *   不产生新回合 → 一次真人指令下的多次自动继续都属于同一个「当前回合」，
 *   按轮归档从结构上永远压不到它们（本会话「14 轮 281 步」只压到 2 轮）。
 * - `dsh`：按 DSH 自己的轮次计数（`turn/start` / `step/start` 的 `data.turn`，
 *   与界面上的「N 轮」同一口径）。目标自动继续会让 DSH 开新轮，上一轮因此
 *   变成「已完成」，可以归档。
 *
 * 两种判定的**安全边界完全一致**：当前轮永不归档；插件回执/恢复是硬边界；
 * 回注包透明；整组节点必须有记录。差别只在「什么算一轮」。
 *
 * @param {object} input
 * @param {number[]} input.surfaceNodes 活动面 seq（升序）
 * @param {object[]} input.events 会话日志
 * @param {'human'|'dsh'} [input.turnBasis] 轮次判定（未知值按 human 处理，失败关闭）
 * @param {number|null} [input.currentTurn] 当前 DSH 轮（pre-step 的 payload.turn）；
 *   只在 turnBasis='dsh' 时使用：当前轮刚开、活动面里还没有它的节点时，
 *   也能把上一轮判为「已完成」。
 * @returns {Array<{startSeq:number,endSeq:number,seqs:number[],current:boolean,hasPlugin:boolean,turn?:number}>}
 */
export function groupSurfaceOperations({ surfaceNodes, events, turnBasis = 'human', currentTurn = null } = {}) {
  if (!Array.isArray(surfaceNodes) || !Array.isArray(events)) {
    throw new V3ContractViolation('v3 archive/candidates: surfaceNodes/events 必须是数组')
  }
  const entry = cachedBySeq(events)
  return turnBasis === 'dsh'
    ? groupByDshTurn({ surfaceNodes, entry, events, currentTurn })
    : groupByHumanTurn({ surfaceNodes, entry })
}

/** DSH 轮次判定：真人消息只是普通节点，轮次边界由宿主自己的 turn 计数给出。 */
function groupByDshTurn({ surfaceNodes, entry, events, currentTurn }) {
  const { bySeq, toolIndex } = entry
  // B3-8：轮次投影走增量缓存（append-only 日志，只合并新增段）
  const { turnAt, lastTurn } = cachedTurnProjection(events)
  // 旧宿主/旧夹具没有 turn 计数：退回真人判定（= 切换前的行为），不猜轮次。
  // 注意传的是入口对象（entry 内含 bySeq 与 toolIndex）：直接传 bySeq 会让被调方
  // 解构不到 entry.bySeq（Cannot destructure property 'bySeq'）。等价回退必须同源。
  if (lastTurn === null) return groupByHumanTurn({ surfaceNodes, entry })
  const groups = []
  let current = null
  function finish(group) {
    if (group === null) return
    // 闭包判据唯一实现在 event-shape：范围内两侧相等，且没有单边留在范围外
    // （缺结果 = 操作没做完；孤立结果/声明留外 = 会拆散一次操作，单边遮蔽）。
    const closure = toolClosureOfRange({
      invocationIds: [...group.declared, ...group.calls],
      resultIds: [...group.results],
      malformed: group.malformedDeclaration,
      index: toolIndex,
      startSeq: group.startSeq,
      endSeq: group.endSeq,
    })
    group.hasUnfinished = closure.closed !== true
    group.missingCallIds = closure.missingIds
    group.orphanCallIds = closure.orphanIds
    group.splitCallIds = closure.splitIds ?? []
    delete group.declared
    delete group.calls
    delete group.results
    delete group.malformedDeclaration
    groups.push(group)
  }
  for (const seq of surfaceNodes) {
    const event = bySeq.get(seq)
    if (event === undefined) continue
    // 结构性节点（system/developer）没有 v3 记录、宿主要求 node 0 只能由系统消息改写：
    // 不纳入轮组，作为边界留在活动面（AUD48-04-04）。它出现在组头时，组从下一个节点开始；
    // 组中段出现时切段（不跨它拼 span），后续轮仍可继续。
    if (isStructuralSurfaceEvent(event)) { finish(current); current = null; continue }
    const turn = turnAt.get(seq)
    if (turn === undefined) { finish(current); current = null; continue }
    if (current === null || current.turn !== turn) {
      finish(current)
      current = { startSeq: seq, endSeq: seq, seqs: [seq], turn, current: false, hasPlugin: false, transient: [], declared: new Set(), calls: new Set(), results: new Set(), malformedDeclaration: false }
    } else {
      current.seqs.push(seq)
      current.endSeq = seq
    }
    if (isPluginSurfaceEvent(event)) {
      if (isRecallPackEvent(event)) current.transient.push(seq)
      else current.hasPlugin = true
    }
    // R06（0.15.0）：调用全集以 assistant 结构块声明为准（tool/call 在真实宿主是
    // log-only）。只认独立 tool/call 会把「已声明、结果未到」的调用当成不存在；
    // 缺 id 的畸形块按「未知」保护，id/callId 冲突则两个候选都收（不静默偏爱）。
    const declaration = toolCallDeclarationsOf(event)
    for (const declaredId of declaration.ids) current.declared.add(declaredId)
    if (declaration.malformed) current.malformedDeclaration = true
    const callId = callIdOf(event)
    if (event.type === 'tool/call' && callId !== null) current.calls.add(callId)
    if (event.type === 'tool/result' && callId !== null) current.results.add(callId)
  }
  finish(current)
  if (groups.length === 0) return groups
  // 当前轮判定（B3-12，AUD50-05-02）：turn/start 已写入日志时**日志是权威**——
  // 当前轮 = max(日志 lastTurn, payload.turn)。
  // - 同步（payload = lastTurn）：与旧口径一致；
  // - payload 滞后（新轮首步宿主还没交新轮号，beta.49 之后的已知晚一步）：max 取日志
  //   lastTurn → 新轮首步即归档上一轮（本条修复的目标）；
  // - payload 超前一轮（当前轮刚开、turn/start 还没落日志）：currentTurn = lastTurn + 1
  //   → 日志里没有任何当前轮节点，已完成轮立即可归档（beta.47 行为保留）；
  // - payload 超前两轮以上（宿主计数与日志脱节）：不可信，保守回退「最后一组 = 当前轮」
  //   （滞后不得误压的守卫，beta.49：payload 传成 1 而日志在 3 时绝不能把已完成轮全标当前轮）；
  // - 没有 payload.turn（now/status 无参调用）：保守按「最后一组 = 当前轮」（beta.47 口径）。
  if (!Number.isInteger(currentTurn) || (Number.isInteger(currentTurn) && currentTurn > lastTurn + 1)) {
    groups[groups.length - 1].current = true
  } else {
    const effectiveTurn = Math.max(currentTurn, lastTurn)
    for (const group of groups) group.current = group.turn >= effectiveTurn
  }
  return groups
}

/** 真人回合判定（默认）：边界 = 真人 user/message。 */
function groupByHumanTurn({ surfaceNodes, entry }) {
  const { bySeq, toolIndex } = entry
  const groups = []
  let current = null
  function finish(group) {
    if (group === null) return
    // 闭包判据唯一实现在 event-shape：范围内两侧相等，且没有单边留在范围外
    // （缺结果 = 操作没做完；孤立结果/声明留外 = 会拆散一次操作，单边遮蔽）。
    const closure = toolClosureOfRange({
      invocationIds: [...group.declared, ...group.calls],
      resultIds: [...group.results],
      malformed: group.malformedDeclaration,
      index: toolIndex,
      startSeq: group.startSeq,
      endSeq: group.endSeq,
    })
    group.hasUnfinished = closure.closed !== true
    group.missingCallIds = closure.missingIds
    group.orphanCallIds = closure.orphanIds
    group.splitCallIds = closure.splitIds ?? []
    delete group.declared
    delete group.calls
    delete group.results
    delete group.malformedDeclaration
    groups.push(group)
  }
  for (const seq of surfaceNodes) {
    const event = bySeq.get(seq)
    if (event === undefined) continue
    // 结构性节点与 dsh 分组同口径：不纳入回合、作为边界留在活动面（不跨它拼 span）。
    if (isStructuralSurfaceEvent(event)) { finish(current); current = null; continue }
    if (isHumanUserEvent(event)) {
      finish(current)
      current = { startSeq: seq, endSeq: seq, seqs: [seq], current: false, hasPlugin: false, transient: [], declared: new Set(), calls: new Set(), results: new Set(), malformedDeclaration: false }
      continue
    }
    if (current === null) continue
    current.seqs.push(seq)
    current.endSeq = seq
    if (isPluginSurfaceEvent(event)) {
      // 回注包不进 hasPlugin（不阻断），也不进记录要求；回执/恢复仍是硬边界。
      if (isRecallPackEvent(event)) current.transient.push(seq)
      else current.hasPlugin = true
    }
    // R06（0.15.0）：调用全集以 assistant 结构块声明为准（tool/call 在真实宿主是
    // log-only）。只认独立 tool/call 会把「已声明、结果未到」的调用当成不存在；
    // 缺 id 的畸形块按「未知」保护，id/callId 冲突则两个候选都收（不静默偏爱）。
    const declaration = toolCallDeclarationsOf(event)
    for (const declaredId of declaration.ids) current.declared.add(declaredId)
    if (declaration.malformed) current.malformedDeclaration = true
    const callId = callIdOf(event)
    if (event.type === 'tool/call' && callId !== null) current.calls.add(callId)
    if (event.type === 'tool/result' && callId !== null) current.results.add(callId)
  }
  finish(current)
  if (groups.length > 0) groups[groups.length - 1].current = true
  return groups
}

/**
 * 选出本次可归档的连续 span。
 *
 * **失败原因可观测**（0.14.0-beta.45，AUD-09 附带项）：返回 null 的同时把
 * `{reason, seq?, seqs?, count?, retained?}` 交给 `onReject`。旧实现只回 null，
 * 线上只能反推「为什么没压」；现在 `status` 的「下一次归档」能直接说清是
 * 当前回合 / 工作集 / pin / 无记录 / 未完成工具对 / 不连续。
 *
 * @param {object} input
 * @param {number[]} input.surfaceNodes 当前活动面 seq（升序）
 * @param {object[]} input.events 会话日志（原始 DSH 事件）
 * @param {(seq:number)=>boolean} input.hasRecord 该 surface 节点是否有 v3 记录
 * @param {'full-history'|'cooling'|'recall-only'} input.mode
 * @param {number} [input.retainOperations] cooling 保留的最近完成操作数
 * @param {number} [input.lastArchiveEndSeq] 上次归档结束 seq（含）
 * @param {'human'|'dsh'} [input.turnBasis] 轮次判定（默认 human，与 0.14.0-beta.46 行为一致）
 * @param {number|null} [input.currentTurn] 当前 DSH 轮（只在 turnBasis='dsh' 时生效）
 * @param {(row:{reason:string})=>void} [input.onReject] 仅观察：选择结果不因它改变
 * @returns {null | {startSeq:number,endSeq:number,sourceEventSeqs:number[],recordSeqs:number[],operations:number}}
 */
export function selectArchiveSpan({ surfaceNodes, events, hasRecord, mode, retainOperations = 5, lastArchiveEndSeq = -1, maxOperations = 1, pinnedSeqs = new Set(), minStartSeq = -1, turnBasis = 'human', currentTurn = null, onReject = null } = {}) {
  // 拒绝出口：契约仍是 null；原因只走观察回调，回调抛错不得改变选择结果。
  const reject = (row) => {
    // 兼容传裸字符串的调用点：原因码永远不丢（宁可归一化，也不让 UI 印出 undefined）。
    const rejection = typeof row === 'string' ? { reason: row } : row
    if (typeof onReject === 'function') {
      try { onReject(rejection) } catch { /* 观察面不得左右判据 */ }
    }
    return null
  }
  if (mode === 'recall-only') return reject({ reason: 'recall-only' })
  if (typeof hasRecord !== 'function') throw new V3ContractViolation('v3 archive/candidates: hasRecord 必须是函数')
  const groups = groupSurfaceOperations({ surfaceNodes, events, turnBasis, currentTurn })
  const transient = new Set()
  for (const group of groups) for (const seq of group.transient ?? []) transient.add(seq)
  const completed = groups.filter((group) => group.current !== true
    && group.startSeq > lastArchiveEndSeq
    && group.startSeq > minStartSeq)
  if (completed.length === 0) return reject({ reason: 'no-completed-group' })
  const eligibleAll = mode === 'cooling'
    ? completed.slice(0, Math.max(0, completed.length - Math.max(0, retainOperations)))
    : completed
  if (eligibleAll.length === 0) return reject({ reason: 'retention-window', retained: completed.length })
  // 每步最多处理 N 个完成操作：pre-step 只做一次有界 surface append，不因历史很长而卡首字。
  const eligible = eligibleAll.slice(0, Math.max(1, Number.isInteger(maxOperations) ? maxOperations : 1))

  // 只取**第一个连续 eligible 段**（中间有当前回合/插件回执/无记录节点即停）。
  // 注意 break 只表示「不再往后拼」，**已经选到的完成操作照常归档**；
  // 因此诊断信息只在「一段都没选到」时才作为拒绝原因上报。
  const selected = []
  // 回合数按「本次选中的组」计数（AUD51-09-01）：与是否发生回执改道无关。
  let operations = 0
  let stop = null
  for (const group of eligible) {
    if (group.hasPlugin) { stop = { reason: 'plugin-boundary', seq: group.endSeq }; break }
    if (group.hasUnfinished === true) {
      stop = {
        reason: 'unfinished-tool',
        seq: group.endSeq,
        callIds: group.missingCallIds,
        orphanCallIds: group.orphanCallIds,
        splitCallIds: group.splitCallIds,
      }
      break
    }
    // 保护/缺记录必须作为**整组边界**：不能把同一个操作切一半归档（恢复/回执都会失真）。
    // 回注包没有记录也不需要记录；其余节点必须有记录、且未被 pin（整组边界，不切半个操作）。
    const pinned = group.seqs.filter((seq) => pinnedSeqs.has(seq))
    if (pinned.length > 0) { stop = { reason: 'pinned', seqs: pinned, count: pinned.length }; break }
    const missing = group.seqs.filter((seq) => !transient.has(seq) && !hasRecord(seq))
    if (missing.length > 0) { stop = { reason: 'missing-record', seqs: missing, count: missing.length }; break }
    selected.push(...group.seqs)
    operations += 1
  }
  if (selected.length === 0) return reject(stop ?? { reason: 'no-candidate' })
  selected.sort((a, b) => a - b)
  const startSeq = selected[0]
  const endSeq = selected[selected.length - 1]
  // 必须连续地在当前 surface 中（宿主 range replace 的硬前提）。
  const foundIdx = surfaceNodes.indexOf(startSeq)
  const endIdx = surfaceNodes.indexOf(endSeq)
  if (foundIdx === -1 || endIdx === -1 || foundIdx > endIdx) return reject({ reason: 'not-dense', seqs: [startSeq, endSeq] })
  // span 严格等于本次选中的组（不吸收前驱回执）：每轮归档各留一张独立回执，
  // 旧凭证的正文永远留在活动面，restore 才找得到（AUD51-05-02）。
  const shadowed = surfaceNodes.slice(foundIdx, endIdx + 1)
  if (shadowed.length !== selected.length || shadowed.some((seq, index) => seq !== selected[index])) return reject({ reason: 'not-dense', seqs: [startSeq, endSeq] })
  // recordSeqs 只收有记录的节点：回注包被遮蔽了也还不了（它本来就没入库）。
  const recordSeqs = shadowed.filter((seq) => !transient.has(seq))
  if (recordSeqs.length === 0) return reject('empty-records', { seqs: shadowed, count: shadowed.length })
  return {
    startSeq,
    endSeq,
    sourceEventSeqs: shadowed,
    recordSeqs,
    operations,
  }
}
