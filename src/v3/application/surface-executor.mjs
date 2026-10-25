/**
 * 投影执行器（application，M4 第三批）：把 slot-planner 的计划落到 HostSurface 端口。
 *
 * R4 判据（card-replace 保留项）的 v3 重证：
 * - 宿主拒绝 replace（surfaceOp 报错或返回 refused）→ 降级 append 同内容，
 *   cardReplaceFallbacks 计数（fail-visible：持续增长 = 双槽在退化）；
 * - 一步恢复：降级 append 得到的新 seq 立刻记为该槽位的当前 seq，
 *   下一步的 replace 就落在它上面——多余槽位最多存活一步；
 * - 结算走 contracts/outcomes：op 级失败如实进 failures，不伪成功。
 */
import { validateOutcome, V3ContractViolation } from '../contracts/index.mjs'
import { nextSurfaceState } from '../domain/context/slot-planner.mjs'
import { assertPort } from '../ports/index.mjs'

/** 占位回执（一行；成员原文在 append-only 日志可回读）。 */
export function placeholderReceipt({ kind, count }) {
  return '[' + kind + ' 卡占位] 此前 ' + count + ' 张卡的内容已并入最近一张全量卡；原文在日志，可按记录 ID 回读。'
}

const ROLE_OF = { 'full-slot': '全量', 'delta-slot': '增量' }

/**
 * 创建投影执行器。
 * @param {object} deps { host: HostSurface 端口, clock: Clock, metrics? }
 */
export function createSurfaceExecutor({ host, clock, metrics } = {}) {
  assertPort('HostSurface', host)
  assertPort('Clock', clock)

  /**
   * 执行一次槽位计划。
   * @param {object} input
   * @param {{kind:'full'|'delta', ops:Array}} input.plan planSlots 产物
   * @param {{fullSlotSeq, deltaSlotSeq}} input.surfaceState 执行前槽位状态
   * @param {string} input.cardText 新卡正文
   * @param {string} input.decisionId 关联裁决（outcome 用）
   * @param {string} input.sessionKey 会话隔离键（outcome 账本必填）
   * @param {number} input.placeholderCount 占位回执声称并入的卡数
   * @returns {{ outcome, surfaceState, fallbacks, appliedOps }}
   */
  async function executePlan({ plan, surfaceState, cardText, decisionId, sessionKey, placeholderCount = 0 } = {}) {
    if (plan === null || typeof plan !== 'object' || !Array.isArray(plan.ops)) {
      throw new V3ContractViolation('v3 surface-executor: plan 必须是 planSlots 产物')
    }
    if (typeof cardText !== 'string' || cardText.length === 0) {
      throw new V3ContractViolation('v3 surface-executor: cardText 必须是非空字符串')
    }
    if (typeof decisionId !== 'string' || decisionId.length === 0 || typeof sessionKey !== 'string' || sessionKey.length === 0) {
      throw new V3ContractViolation('v3 surface-executor: decisionId/sessionKey 必须是非空字符串')
    }
    const failures = []
    const appliedOps = []
    const fallbacks = []
    let newCardSeq = null

    for (let i = 0; i < plan.ops.length; i += 1) {
      const op = plan.ops[i]
      const text = op.role === 'placeholder'
        ? placeholderReceipt({ kind: plan.kind === 'full' ? '增量' : ROLE_OF[op.role] ?? '工作', count: placeholderCount })
        : cardText
      const surfaceOp = op.op === 'replace'
        ? { op: 'replace', targetEventId: op.targetEventId, text }
        : { op: 'append', form: 'memory-lab3-surface', text }
      try {
        const confirmation = await host.surfaceOp(surfaceOp)
        const seq = confirmation?.seq
        if (!Number.isInteger(seq) || seq < 1) {
          throw new V3ContractViolation('v3 surface-executor: 宿主确认必须带 ≥1 的 seq（槽位状态推进的依据）')
        }
        appliedOps.push({ index: i, role: op.role, mode: op.op, seq })
        if (op.role !== 'placeholder') newCardSeq = seq
      } catch (error) {
        if (op.op !== 'replace') {
          failures.push({ effectIndex: i, code: error?.code ?? 'EINTERNAL', message: error?.message ?? String(error) })
          continue
        }
        // R4：replace 被拒 → 降级 append 同内容；新 seq 记入槽位（一步恢复）
        try {
          const confirmation = await host.surfaceOp({ op: 'append', form: 'memory-lab3-surface', text })
          const seq = confirmation?.seq
          if (!Number.isInteger(seq) || seq < 1) {
            throw new V3ContractViolation('v3 surface-executor: 宿主确认必须带 ≥1 的 seq')
          }
          appliedOps.push({ index: i, role: op.role, mode: 'append-fallback', seq })
          fallbacks.push({ index: i, role: op.role })
          metrics?.counter?.('v3.surface.cardReplaceFallbacks', 1)
          if (op.role !== 'placeholder') newCardSeq = seq
        } catch (fallbackError) {
          failures.push({ effectIndex: i, code: fallbackError?.code ?? 'EINTERNAL', message: 'replace 与降级 append 均失败：' + (fallbackError?.message ?? String(fallbackError)) })
        }
      }
    }

    const status = failures.length === 0 ? 'applied' : (appliedOps.length === 0 ? 'failed' : 'partial')
    const outcomeRaw = {
      decisionId,
      sessionKey,
      at: clock.now(),
      status,
      totalEffects: plan.ops.length,
      appliedEffects: appliedOps.length,
      failures,
    }
    const outcomeCheck = validateOutcome(outcomeRaw)
    if (!outcomeCheck.ok) {
      throw new V3ContractViolation('v3 surface-executor: outcome 结构非法——' + outcomeCheck.errors.join('；'))
    }
    if (newCardSeq === null) {
      throw new V3ContractViolation('v3 surface-executor: 新卡未落面（宿主未确认 seq），不得推进槽位状态')
    }
    return { outcome: outcomeRaw, surfaceState: nextSurfaceState(surfaceState, plan, newCardSeq), fallbacks, appliedOps }
  }

  return { executePlan }
}
