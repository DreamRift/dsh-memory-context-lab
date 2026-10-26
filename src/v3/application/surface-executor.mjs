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
    // 计划形状在执行前校验（H-24）：执行层是**端口边界**，不能信任调用方递进来的 plan。
    // 旧实现直接按 plan.ops 发 op，实测 targetEventId = 0 / 1.5 / "18" / -1 全部原样发给宿主；
    // 其中 0 是宿主 surface 节点 0（系统提示）。更糟的是：宿主适配器拒绝这类 target 时，
    // 执行器会把它当成「replace 被拒」走**降级 append**——一个编程错误被静默降级成
    // 「多追加一张卡」，槽位还照常推进（失败不可见）。非法计划必须失败关闭，不进 fallback。
    if (!Array.isArray(plan.ops) || plan.ops.length === 0) {
      throw new V3ContractViolation('v3 surface-executor: plan.ops 必须是非空数组')
    }
    for (const op of plan.ops) {
      if (op === null || typeof op !== 'object') {
        throw new V3ContractViolation('v3 surface-executor: plan.ops 的每一项必须是对象')
      }
      if (op.op !== 'replace' && op.op !== 'append') {
        throw new V3ContractViolation('v3 surface-executor: plan.ops 的 op 必须是 replace/append，得到 ' + JSON.stringify(op.op))
      }
      if (op.role !== 'full-slot' && op.role !== 'delta-slot' && op.role !== 'placeholder') {
        throw new V3ContractViolation('v3 surface-executor: plan.ops 的 role 必须是 full-slot/delta-slot/placeholder，得到 ' + JSON.stringify(op.role))
      }
      if (op.op === 'replace' && (!Number.isInteger(op.targetEventId) || op.targetEventId < 1)) {
        throw new V3ContractViolation('v3 surface-executor: replace 的 targetEventId 必须是 ≥1 的整数（得到 ' + JSON.stringify(op.targetEventId) + '）——seq 0 是宿主的系统提示节点')
      }
    }
    const failures = []
    const appliedOps = []
    const fallbacks = []
    let newCardSeq = null
    // 占位是否落面（H-43）：占位**没落地**时，旧增量卡仍在活动面上，
    // 增量槽指针绝不能清空——清了就没人能再 replace 它，那张卡永久留在活动面，
    // 每失败一次泄漏一张，直接违反「稳态活动面恒为两个卡节点」。
    let placeholderFailed = false

    // 执行顺序（H-17）：**先落卡、后落占位**。
    // 计划里占位 op 排在前面（人读顺序是「旧增量 → 全量」），但占位一旦落地就把增量槽
    // 覆盖成占位行；若随后卡片 op 失败（replace + 降级 append 都失败），调用方拿不到新
    // surfaceState，仍持有「增量槽 = 原 seq」的旧状态，下一步增量步会去 replace 那个
    // **已经是占位行**的节点，把唯一的活动面指针吃掉。先落卡后落占位，卡片失败时面上
    // 什么都没变，旧状态仍然正确；占位失败时卡片已落面，outcome 如实记 partial。
    const executionOrder = [
      ...plan.ops.map((op, index) => ({ op, index })).filter((entry) => entry.op.role !== 'placeholder'),
      ...plan.ops.map((op, index) => ({ op, index })).filter((entry) => entry.op.role === 'placeholder'),
    ]
    for (const { op, index: i } of executionOrder) {
      // 卡片没落面就绝不落占位（H-17）：占位会把增量槽覆盖成占位行，而调用方此时拿不到
      // 新 surfaceState（下面的「新卡未落面」抛错），旧状态仍指向被覆盖的 seq——下一步
      // 增量步会 replace 掉占位行，丢掉唯一的活动面指针。跳过并如实记账。
      if (op.role === 'placeholder' && newCardSeq === null) {
        failures.push({ effectIndex: i, code: 'ESLOT_NO_CARD', message: '卡片未落面，占位回执不执行（否则会吃掉唯一的活动面指针）' })
        continue
      }
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
          if (op.role === 'placeholder') placeholderFailed = true
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
          if (op.role === 'placeholder') placeholderFailed = true
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
    const nextState = nextSurfaceState(surfaceState, plan, newCardSeq)
    // 占位没落面 → 旧增量卡还在面上：保留它的指针，下一步全量步会再试一次折叠。
    // 「失败要留在可重试的位置」——把指针清掉等于把失败变成永久残留。
    if (placeholderFailed && surfaceState?.deltaSlotSeq !== null && surfaceState?.deltaSlotSeq !== undefined) {
      nextState.deltaSlotSeq = surfaceState.deltaSlotSeq
    }
    return { outcome: outcomeRaw, surfaceState: nextState, fallbacks, appliedOps }
  }

  return { executePlan }
}
