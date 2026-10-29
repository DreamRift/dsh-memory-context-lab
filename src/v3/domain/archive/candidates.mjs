/**
 * 归档候选选择（domain/archive，纯函数，M2）。
 *
 * 判据（安全优先）：
 * - 真人 user/message 是操作边界；当前回合（最后一个真人消息及其后的节点）永不归档；
 * - 只选**连续 surface 节点**；`sourceEventSeqs` 必须覆盖被遮蔽的全部节点；
 * - 插件自己的回执/恢复节点不参与归档，也不跨过它们拼 span；
 * - M2 只归档「每个节点都有 v3 记录」的 span：没有记录就无法按 ID 恢复，不做不可恢复的遮蔽。
 * - full-history：所有已完成操作；cooling：只保留最近 retainOperations 个完成操作，等压力闸门。
 */
import { V3ContractViolation } from '../../contracts/errors.mjs'
import { callIdOf, isHumanUserEvent, isPluginSurfaceEvent, isRecallPackEvent } from './event-shape.mjs'

function eventAtOf(events) {
  const map = new Map()
  for (const event of events) {
    if (Number.isInteger(event?.seq)) map.set(event.seq, event)
  }
  return map
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
  const bySeq = eventAtOf(events)
  return turnBasis === 'dsh'
    ? groupByDshTurn({ surfaceNodes, bySeq, events, currentTurn })
    : groupByHumanTurn({ surfaceNodes, bySeq })
}

/** DSH 轮次判定：真人消息只是普通节点，轮次边界由宿主自己的 turn 计数给出。 */
function groupByDshTurn({ surfaceNodes, bySeq, events, currentTurn }) {
  const turnAt = new Map()
  let lastTurn = null
  for (const event of events) {
    if (!Number.isInteger(event?.seq)) continue
    // turn/start 与 step/start 都带 turn；step/start 覆盖「turn 内每一步」，更细。
    if (event.type === 'turn/start' || event.type === 'step/start') {
      if (Number.isInteger(event?.data?.turn)) lastTurn = event.data.turn
    }
    // 第一轮开始之前的节点没有轮次归属：不猜、不归档（留在活动面上）。
    if (lastTurn !== null) turnAt.set(event.seq, lastTurn)
  }
  // 旧宿主/旧夹具没有 turn 计数：退回真人判定（= 切换前的行为），不猜轮次。
  if (lastTurn === null) return groupByHumanTurn({ surfaceNodes, bySeq })
  const groups = []
  let current = null
  function finish(group) {
    if (group === null) return
    group.hasUnfinished = [...group.calls].some((callId) => !group.results.has(callId))
    delete group.calls
    delete group.results
    groups.push(group)
  }
  for (const seq of surfaceNodes) {
    const turn = turnAt.get(seq)
    if (turn === undefined) { finish(current); current = null; continue }
    const event = bySeq.get(seq)
    if (event === undefined) continue
    if (current === null || current.turn !== turn) {
      finish(current)
      current = { startSeq: seq, endSeq: seq, seqs: [seq], turn, current: false, hasPlugin: false, transient: [], calls: new Set(), results: new Set() }
    } else {
      current.seqs.push(seq)
      current.endSeq = seq
    }
    if (isPluginSurfaceEvent(event)) {
      if (isRecallPackEvent(event)) current.transient.push(seq)
      else current.hasPlugin = true
    }
    const callId = callIdOf(event)
    if (event.type === 'tool/call' && callId !== null) current.calls.add(callId)
    if (event.type === 'tool/result' && callId !== null) current.results.add(callId)
  }
  finish(current)
  if (groups.length === 0) return groups
  // 当前轮 = 宿主说正在跑的那一轮；没有 payload.turn 时退回「最后一组」。
  // 若 payload.turn 比日志里的最大轮还超前一步以上（日志滞后/异常），
  // 不猜——按「最后一组是当前轮」保守处理，宁可少压也不压活动内容。
  const canTrustTurn = Number.isInteger(currentTurn) && Number.isInteger(lastTurn) && currentTurn <= lastTurn + 1
  if (canTrustTurn) {
    for (const group of groups) group.current = group.turn >= currentTurn
  } else {
    groups[groups.length - 1].current = true
  }
  return groups
}

/** 真人回合判定（默认）：边界 = 真人 user/message。 */
function groupByHumanTurn({ surfaceNodes, bySeq }) {
  const groups = []
  let current = null
  function finish(group) {
    if (group === null) return
    group.hasUnfinished = [...group.calls].some((callId) => !group.results.has(callId))
    delete group.calls
    delete group.results
    groups.push(group)
  }
  for (const seq of surfaceNodes) {
    const event = bySeq.get(seq)
    if (event === undefined) continue
    if (isHumanUserEvent(event)) {
      finish(current)
      current = { startSeq: seq, endSeq: seq, seqs: [seq], current: false, hasPlugin: false, transient: [], calls: new Set(), results: new Set() }
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
  let stop = null
  for (const group of eligible) {
    if (group.hasPlugin) { stop = { reason: 'plugin-boundary', seq: group.endSeq }; break }
    if (group.hasUnfinished === true) { stop = { reason: 'unfinished-tool', seq: group.endSeq }; break }
    // 保护/缺记录必须作为**整组边界**：不能把同一个操作切一半归档（恢复/回执都会失真）。
    // 回注包没有记录也不需要记录；其余节点必须有记录、且未被 pin（整组边界，不切半个操作）。
    const pinned = group.seqs.filter((seq) => pinnedSeqs.has(seq))
    if (pinned.length > 0) { stop = { reason: 'pinned', seqs: pinned, count: pinned.length }; break }
    const missing = group.seqs.filter((seq) => !transient.has(seq) && !hasRecord(seq))
    if (missing.length > 0) { stop = { reason: 'missing-record', seqs: missing, count: missing.length }; break }
    selected.push(...group.seqs)
  }
  if (selected.length === 0) return reject(stop ?? { reason: 'no-candidate' })
  selected.sort((a, b) => a - b)
  const startSeq = selected[0]
  const endSeq = selected[selected.length - 1]
  // 必须连续地在当前 surface 中（宿主 range replace 的硬前提）。
  const startIdx = surfaceNodes.indexOf(startSeq)
  const endIdx = surfaceNodes.indexOf(endSeq)
  if (startIdx === -1 || endIdx === -1 || startIdx > endIdx) return reject({ reason: 'not-dense', seqs: [startSeq, endSeq] })
  const shadowed = surfaceNodes.slice(startIdx, endIdx + 1)
  if (shadowed.length !== selected.length || shadowed.some((seq, index) => seq !== selected[index])) return reject({ reason: 'not-dense', seqs: [startSeq, endSeq] })
  // recordSeqs 只收有记录的节点：回注包被遮蔽了也还不了（它本来就没入库）。
  const recordSeqs = shadowed.filter((seq) => !transient.has(seq))
  if (recordSeqs.length === 0) return reject('empty-records', { seqs: shadowed, count: shadowed.length })
  return {
    startSeq,
    endSeq,
    sourceEventSeqs: shadowed,
    recordSeqs,
    operations: eligible.filter((group) => group.startSeq >= startSeq && group.endSeq <= endSeq).length,
  }
}