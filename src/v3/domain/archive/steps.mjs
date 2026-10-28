/**
 * 步骤级归档候选（普通降温 / 实时压缩，beta.40）。
 *
 * 与 candidates.mjs（回合级）的分工：
 * - 回合级（full-history）：只压**已完成回合**，当前回合永不归档——长程多轮；
 * - 步骤级（cooling）：在**当前回合内**把已完成、且不在工作集里的步骤压成回执——
 *   长步数少轮（一个回合跑几十步）。
 *
 * 关键事实：step/start、step/end 是**日志事件**，不是活动面节点。活动面只含
 * 消息与工具事件。所以 span 只能由「步骤内落在活动面上的节点」拼成，否则
 * 宿主 range replace 的密集覆盖判据必然失败（beta.40 实现时的真实坑）。
 *
 * 判据（确定性、可测试、失败关闭）：
 * 1. 单位 = step/start…step/end 的完整步骤；半截步骤不参与；
 * 2. 工作集：最近 retainSteps 个步骤保留（模型刚用过的结果不能撤）；
 * 3. 不跨回合：到回合锚点（用户消息/运行期上下文）即停，锚点绝不能被遮蔽；
 * 4. 未完成 tool 对、插件回执、pin 是整步硬边界；回注包透明（与回合级同一口径）；
 * 5. 整步每个**活动面节点**都必须有 v3 记录（回注包除外），否则不压；
 * 6. 一次最多 maxSteps 步，减少表面抖动与前缀缓存作废次数。
 *
 * 灵枢（dsh-memory）参考：工具输出/命令默认低价值（role 分层）、越旧越可弃（时间衰减）、
 * 丢弃前必须可回读（记录 + 回执）。这里用「工作集窗口 + 整步可恢复」落地这三条，
 * 不用概率模型（确定性优先，与 P9 单源口径一致）。
 */
import { V3ContractViolation } from '../../contracts/errors.mjs'
import { callIdOf, isHumanUserEvent, isPluginSurfaceEvent, isRecallPackEvent } from './event-shape.mjs'

/** 把会话事件切成步骤单元；只有 start…end 成对的步骤标 complete。 */
export function buildStepUnits(events) {
  if (!Array.isArray(events)) throw new V3ContractViolation('v3 archive/steps: events 必须是数组')
  const units = []
  let open = null
  for (const event of events) {
    if (!Number.isInteger(event?.seq)) continue
    if (event.type === 'step/start') {
      open = {
        turn: Number.isInteger(event.data?.turn) ? event.data.turn : null,
        step: Number.isInteger(event.data?.step) ? event.data.step : null,
        startSeq: event.seq,
        endSeq: event.seq,
        seqs: [event.seq],
        complete: false,
        hasHuman: false,
        hasPlugin: false,
        transient: [],
        calls: new Set(),
        results: new Set(),
      }
      units.push(open)
      continue
    }
    if (open === null) continue
    open.seqs.push(event.seq)
    open.endSeq = event.seq
    if (event.type === 'step/end') { open.complete = true; open = null; continue }
    if (isHumanUserEvent(event)) open.hasHuman = true
    if (isPluginSurfaceEvent(event)) {
      if (isRecallPackEvent(event)) open.transient.push(event.seq)
      else open.hasPlugin = true
    }
    const callId = callIdOf(event)
    if (event.type === 'tool/call' && callId !== null) open.calls.add(callId)
    if (event.type === 'tool/result' && callId !== null) open.results.add(callId)
  }
  for (const unit of units) {
    unit.hasUnfinished = [...unit.calls].some((callId) => !unit.results.has(callId))
    delete unit.calls
    delete unit.results
  }
  return units
}

/**
 * 选出一次可压缩的步骤 span（只由活动面节点组成）。
 *
 * @param {object} input
 * @param {number[]} input.surfaceNodes 活动面 seq（升序）
 * @param {object[]} input.events 原始会话事件
 * @param {(seq:number)=>boolean} input.hasRecord 该**活动面节点**是否有 v3 记录
 * @param {number} [input.retainSteps] 工作集保留的最近步骤数（默认 4）
 * @param {number} [input.maxSteps] 单次最多压缩的步骤数（默认 3）
 * @param {Set<number>} [input.pinnedSeqs] pin 的 seq（整步边界）
 * @returns {null | {startSeq:number,endSeq:number,sourceEventSeqs:number[],recordSeqs:number[],operations:number,steps:number}}
 */
export function selectStepSpan({ surfaceNodes, events, hasRecord, retainSteps = 4, maxSteps = 3, pinnedSeqs = new Set() } = {}) {
  if (!Array.isArray(surfaceNodes) || !Array.isArray(events)) {
    throw new V3ContractViolation('v3 archive/steps: surfaceNodes/events 必须是数组')
  }
  if (typeof hasRecord !== 'function') throw new V3ContractViolation('v3 archive/steps: hasRecord 必须是函数')
  const onSurface = new Set(surfaceNodes)
  const units = buildStepUnits(events)
    .filter((unit) => unit.complete === true)
    .map((unit) => ({ ...unit, surfaceSeqs: unit.seqs.filter((seq) => onSurface.has(seq)) }))
    .filter((unit) => unit.surfaceSeqs.length > 0)
  if (units.length === 0) return null
  const keep = Math.max(1, Number.isInteger(retainSteps) ? retainSteps : 4)
  const eligible = units.slice(0, Math.max(0, units.length - keep))
  if (eligible.length === 0) return null
  const limit = Math.max(1, Number.isInteger(maxSteps) ? maxSteps : 3)
  const selected = []
  let turn = null
  for (const unit of eligible) {
    if (selected.length >= limit) break
    // 跨回合即停：回合锚点（用户消息/运行期上下文）绝不能被卷进 span。
    if (turn === null) turn = unit.turn
    else if (unit.turn !== turn) break
    // 前导锚点（用户消息所在的 step 1）只跳过，不阻断后续步骤：真实 DSH 的
    // user/message 就在 step 1 里（step/start 先于 user/message），若在这里 break，
    // 按步归档永远到不了第 2 步。一旦已经开始选步，锚点仍是硬边界（不能跨过它拼接）。
    if (unit.hasPlugin || unit.hasUnfinished === true) break
    if (unit.hasHuman) {
      if (selected.length === 0) continue
      break
    }
    if (unit.surfaceSeqs.some((seq) => pinnedSeqs.has(seq))) break
    if (unit.surfaceSeqs.some((seq) => !unit.transient.includes(seq) && !hasRecord(seq))) break
    selected.push(unit)
  }
  if (selected.length === 0) return null
  const wanted = selected.flatMap((unit) => unit.surfaceSeqs)
  const startSeq = wanted[0]
  const endSeq = wanted[wanted.length - 1]
  const startIdx = surfaceNodes.indexOf(startSeq)
  const endIdx = surfaceNodes.indexOf(endSeq)
  if (startIdx === -1 || endIdx === -1 || startIdx > endIdx) return null
  const shadowed = surfaceNodes.slice(startIdx, endIdx + 1)
  // 必须密集覆盖且顺序一致：宿主 range replace 的硬前提，也保证不会吞掉锚点。
  if (shadowed.length !== wanted.length || shadowed.some((seq, index) => seq !== wanted[index])) return null
  const transient = new Set(selected.flatMap((unit) => unit.transient))
  const recordSeqs = shadowed.filter((seq) => !transient.has(seq))
  if (recordSeqs.length === 0) return null
  return { startSeq, endSeq, sourceEventSeqs: shadowed, recordSeqs, operations: selected.length, steps: selected.length }
}
