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
 * 把 surface 节点按真人回合分组。
 * @returns {Array<{startSeq:number,endSeq:number,seqs:number[],current:boolean,hasPlugin:boolean}>}
 */
export function groupSurfaceOperations({ surfaceNodes, events } = {}) {
  if (!Array.isArray(surfaceNodes) || !Array.isArray(events)) {
    throw new V3ContractViolation('v3 archive/candidates: surfaceNodes/events 必须是数组')
  }
  const bySeq = eventAtOf(events)
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
 * @param {object} input
 * @param {number[]} input.surfaceNodes 当前活动面 seq（升序）
 * @param {object[]} input.events 会话日志（原始 DSH 事件）
 * @param {(seq:number)=>boolean} input.hasRecord 该 surface 节点是否有 v3 记录
 * @param {'full-history'|'cooling'|'recall-only'} input.mode
 * @param {number} [input.retainOperations] cooling 保留的最近完成操作数
 * @param {number} [input.lastArchiveEndSeq] 上次归档结束 seq（含）
 * @returns {null | {startSeq:number,endSeq:number,sourceEventSeqs:number[],recordSeqs:number[],operations:number}}
 */
export function selectArchiveSpan({ surfaceNodes, events, hasRecord, mode, retainOperations = 5, lastArchiveEndSeq = -1, maxOperations = 1, pinnedSeqs = new Set(), minStartSeq = -1 } = {}) {
  if (mode === 'recall-only') return null
  if (typeof hasRecord !== 'function') throw new V3ContractViolation('v3 archive/candidates: hasRecord 必须是函数')
  const groups = groupSurfaceOperations({ surfaceNodes, events })
  const transient = new Set()
  for (const group of groups) for (const seq of group.transient ?? []) transient.add(seq)
  const completed = groups.filter((group) => group.current !== true
    && group.startSeq > lastArchiveEndSeq
    && group.startSeq > minStartSeq)
  if (completed.length === 0) return null
  const eligibleAll = mode === 'cooling'
    ? completed.slice(0, Math.max(0, completed.length - Math.max(0, retainOperations)))
    : completed
  if (eligibleAll.length === 0) return null
  // 每步最多处理 N 个完成操作：pre-step 只做一次有界 surface append，不因历史很长而卡首字。
  const eligible = eligibleAll.slice(0, Math.max(1, Number.isInteger(maxOperations) ? maxOperations : 1))

  // 只取**第一个连续 eligible 段**（中间有当前回合/插件回执/无记录节点即停）。
  const selected = []
  let stopped = false
  for (const group of eligible) {
    if (stopped) break
    if (group.hasPlugin || group.hasUnfinished === true) break
    // 保护/缺记录必须作为**整组边界**：不能把同一个操作切一半归档（恢复/回执都会失真）。
    // 回注包没有记录也不需要记录；其余节点必须有记录、且未被 pin（整组边界，不切半个操作）。
    if (group.seqs.some((seq) => pinnedSeqs.has(seq) || (!transient.has(seq) && !hasRecord(seq)))) break
    selected.push(...group.seqs)
  }
  if (selected.length === 0) return null
  selected.sort((a, b) => a - b)
  const startSeq = selected[0]
  const endSeq = selected[selected.length - 1]
  // 必须连续地在当前 surface 中（宿主 range replace 的硬前提）。
  const startIdx = surfaceNodes.indexOf(startSeq)
  const endIdx = surfaceNodes.indexOf(endSeq)
  if (startIdx === -1 || endIdx === -1 || startIdx > endIdx) return null
  const shadowed = surfaceNodes.slice(startIdx, endIdx + 1)
  if (shadowed.length !== selected.length || shadowed.some((seq, index) => seq !== selected[index])) return null
  // recordSeqs 只收有记录的节点：回注包被遮蔽了也还不了（它本来就没入库）。
  const recordSeqs = shadowed.filter((seq) => !transient.has(seq))
  if (recordSeqs.length === 0) return null
  return {
    startSeq,
    endSeq,
    sourceEventSeqs: shadowed,
    recordSeqs,
    operations: eligible.filter((group) => group.startSeq >= startSeq && group.endSeq <= endSeq).length,
  }
}