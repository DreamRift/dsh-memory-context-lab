/**
 * 双槽规划器（domain/context，M4）——Q3-A/B（注入即替换、稳态双槽）的纯决策层。
 * 归属说明：槽位规划是决策不是渲染（application 只依赖 domain/ports 的架构口径），
 * 渲染留在 projection/card-renderer。
 *
 * 不变量（beta.8 拍板口径）：
 * - 稳态活动面恒为 [全量基准卡][最新增量卡] 两个卡节点；
 * - 增量步：新卡 surface-replace 进最新增量槽；全量步（每 fullEvery 步或截断兜底）：
 *   新全量卡 replace 全量槽，旧增量槽转一行占位回执（也是 replace）；
 * - 回注包（recall）不是卡形态，不进任何槽（P0-6：注入即被折掉的自激循环另一半），
 *   且同回合同类回注经 oncePerTurnGate 只放行一次（P3）；
 * - 宿主拒绝 replace 的降级 append 由 M5 执行层处理，本层只产计划并标记 fallbackAllowed。
 */
import { oncePerTurnGate } from '../session/turn.mjs'
import { V3ContractViolation } from '../../contracts/index.mjs'

/**
 * 规划下一步的槽位操作。
 * @param {object} input
 * @param {number} input.step 当前步号（≥1）
 * @param {{ fullSlotSeq: number|null, deltaSlotSeq: number|null }} input.surfaceState 面上槽位的事件 seq
 * @param {number} [input.fullEvery=20] 全量刷新周期（≥1）
 * @param {boolean} [input.truncated=false] 本步是否发生上下文截断（触发全量兜底）
 * @returns {{ kind: 'full'|'delta', ops: Array<{op:'replace', targetEventId: number, role:'full-slot'|'delta-slot'|'placeholder'}|{op:'append', role:'full-slot'|'delta-slot'}>, fallbackAllowed: boolean }}
 */
export function planSlots({ step, surfaceState, fullEvery = 20, truncated = false } = {}) {
  if (!Number.isInteger(step) || step < 1) {
    throw new V3ContractViolation('v3 slot-planner: step 必须是 ≥1 整数')
  }
  if (!Number.isInteger(fullEvery) || fullEvery < 1) {
    throw new V3ContractViolation('v3 slot-planner: fullEvery 必须是 ≥1 整数')
  }
  if (surfaceState === null || typeof surfaceState !== 'object' || !('fullSlotSeq' in surfaceState) || !('deltaSlotSeq' in surfaceState)) {
    throw new V3ContractViolation('v3 slot-planner: surfaceState 必须含 fullSlotSeq/deltaSlotSeq')
  }
  // 槽位 seq 的合法域（H-23）：null（无槽）或 **≥1 的整数**。
  // 旧实现不校验，于是 deltaSlotSeq=0 会生成 `replace targetEventId: 0`——而宿主把
  // surface 节点 0 当作**系统提示**（dsh types_surface.js assertSystemHeadRewrite）；
  // seq 0 上不是 system/message 的会话里，这条 replace 会真的把系统提示折掉。
  // 1.5 / "18" 这类值则一路漂到宿主才被拒，错误现场离根因很远。
  for (const [name, value] of [['fullSlotSeq', surfaceState.fullSlotSeq], ['deltaSlotSeq', surfaceState.deltaSlotSeq]]) {
    if (value === null) continue
    if (!Number.isInteger(value) || value < 1) {
      throw new V3ContractViolation('v3 slot-planner: surfaceState.' + name + ' 必须是 null 或 ≥1 的整数（得到 ' + JSON.stringify(value) + '）——seq 0 是宿主的系统提示节点')
    }
  }
  const isFull = step % fullEvery === 0 || truncated || surfaceState.fullSlotSeq === null
  if (isFull) {
    const ops = []
    if (surfaceState.deltaSlotSeq !== null) {
      ops.push({ op: 'replace', targetEventId: surfaceState.deltaSlotSeq, role: 'placeholder' })
    }
    if (surfaceState.fullSlotSeq !== null) {
      ops.push({ op: 'replace', targetEventId: surfaceState.fullSlotSeq, role: 'full-slot' })
    } else {
      ops.push({ op: 'append', role: 'full-slot' })
    }
    return { kind: 'full', ops, fallbackAllowed: true }
  }
  if (surfaceState.deltaSlotSeq === null) {
    return { kind: 'delta', ops: [{ op: 'append', role: 'delta-slot' }], fallbackAllowed: true }
  }
  return { kind: 'delta', ops: [{ op: 'replace', targetEventId: surfaceState.deltaSlotSeq, role: 'delta-slot' }], fallbackAllowed: true }
}

/**
 * 回注放行闸（P3 + P0-6）：回注包不占槽、不进卡形态；同 (session, turn, category) 只一次。
 * @returns {{ emit: boolean, seen: Set<string> }}
 */
export function gateRecallInjection({ seen, sessionKey, turn, category = 'recall-injection' }) {
  if (!Number.isInteger(turn) || turn < 1) {
    throw new V3ContractViolation('v3 slot-planner: turn 必须 ≥1（turn 0 不允许注入）')
  }
  return oncePerTurnGate(seen, sessionKey, turn, category)
}

/** 槽位状态推进：按计划与新卡 seq 折算下一状态（纯函数，供执行层回写）。 */
export function nextSurfaceState(surfaceState, plan, newCardSeq) {
  if (!Number.isInteger(newCardSeq) || newCardSeq < 1) {
    throw new V3ContractViolation('v3 slot-planner: newCardSeq 必须是 ≥1 整数')
  }
  if (plan.kind === 'full') return { fullSlotSeq: newCardSeq, deltaSlotSeq: null }
  return { fullSlotSeq: surfaceState.fullSlotSeq, deltaSlotSeq: newCardSeq }
}
