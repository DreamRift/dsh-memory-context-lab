/**
 * 注入决策（domain/visibility，G6b / R-1 / R-9 / R-11 / R-12）。
 *
 * ## 只有三种结局
 * - `skip`：已证明当前仍可见（信任集内 `visible: true`）或已遗忘（隐私面，永不注入）；
 * - `inject`：其余全部——包括 `unknown`。**unknown 一律注入**（R-1）：去重省的是 token，
 *   误删召回赔的是任务；两者不对称，`visible: null` 永不进 skip 集合。
 * - `unknown`：`inject` 的子集，单独列出以便上游如实计数（R-1 一致性断言：
 *   `unknown ⊆ inject`）。
 *
 * ## v1 信任集（R-12）
 * 只信 `VISIBILITY_TRUSTED_STATES_V1` 五态。`visible-restored` /
 * `visible-recall-pack` 的判定照样产出（R-9/R-10），但在这里按 unknown 处理：
 * 保守方向是多注入一次，不会误挡召回；证据强度区分留 v2。
 *
 * ## 重复上界（R-11）
 * - 同回合 ≤ `repeatTurn`、同会话 ≤ `repeatSession`；**代际变化即重置**（新证据到了，
 *   旧的「已经重复过几次」不再代表同一情形）；
 * - 每回合 unknown 注入字符预算 `unknownCharsPerTurn`；
 * - 超限只**标记** `capped`（`unknown-capped`），**不改变注入决定**——不静默丢弃。
 *
 * ## 有界
 * 计数表按 `stateMax` 淘汰最旧键并计数；不落盘（R-13：派生值不进存储）。
 */
import { VISIBILITY_CONSUMER_STATES, VISIBILITY_LIMITS, VISIBILITY_TRUSTED_STATES_V1, consumerStateOf } from '../../contracts/visibility.mjs'
import { V3ContractViolation } from '../../contracts/errors.mjs'

/** 计数表容量收口：超限按插入序淘汰最旧（Map 顺序即插入序）。 */
function boundCounter(counterMap, limits) {
  let evicted = 0
  while (counterMap.size > limits.stateMax) {
    const oldest = counterMap.keys().next()
    if (oldest.done) break
    counterMap.delete(oldest.value)
    evicted += 1
  }
  return evicted
}

/**
 * 批量注入决策（唯一决策点）。
 * @param {object} input
 * @param {object[]} input.verdicts 判定回执（顺序与片段一致）
 * @param {{turn:Map<string,number>, session:Map<string,number>, unknownChars:number}} input.counters
 *        进程内计数（调用方持有；本函数就地更新）
 * @param {number|null} [input.turn] 当前回合号（未知时 null，不清回合计数）
 * @param {((key:string)=>number)|null} [input.charsOf] 片段注入字符数（未知时按 0）
 * @param {object} [input.limits]
 */
export function visibleFragmentKeys({ verdicts = [], counters, turn = null, charsOf = null, limits = VISIBILITY_LIMITS } = {}) {
  if (!Array.isArray(verdicts)) {
    throw new V3ContractViolation('v3 visibility: verdicts 必须是数组')
  }
  if (counters === null || typeof counters !== 'object' || !(counters.turn instanceof Map) || !(counters.session instanceof Map)) {
    throw new V3ContractViolation('v3 visibility: 决策需要计数表（turn/session Map）')
  }
  const decision = {
    skip: [],
    inject: [],
    unknown: [],
    capped: [],
    visible: [],
    forgotten: [],
    unknownChars: counters.unknownChars,
    budgetCapped: 0,
  }
  for (const verdict of verdicts) {
    if (verdict === null || typeof verdict !== 'object' || typeof verdict.dedupeKey !== 'string') {
      throw new V3ContractViolation('v3 visibility: 判定回执必须带 dedupeKey')
    }
    const key = verdict.dedupeKey
    if (verdict.state === 'forgotten') {
      // 隐私维度优先：遗忘永远不注入，也不参与重复计数。
      decision.skip.push(key)
      decision.forgotten.push(key)
      continue
    }
    const consumer = consumerStateOf(verdict)
    if (!VISIBILITY_CONSUMER_STATES.includes(consumer)) {
      // 消费者面只有三态：新增第四态必须先改合同与守卫，不能在这里悄悄多出一条路径。
      throw new V3ContractViolation('v3 visibility: 消费者状态不在封闭集：' + JSON.stringify(consumer))
    }
    if (consumer === 'visible' && VISIBILITY_TRUSTED_STATES_V1.includes(verdict.state)) {
      decision.skip.push(key)
      decision.visible.push(key)
      continue
    }
    if (consumer === 'not-visible') {
      decision.inject.push(key)
      continue
    }
    // unknown（含 v1 不信的 visible-restored / visible-recall-pack）：按可见保守注入。
    const turnCount = (counters.turn.get(key) ?? 0) + 1
    const sessionCount = (counters.session.get(key) ?? 0) + 1
    counters.turn.set(key, turnCount)
    counters.session.set(key, sessionCount)
    const chars = typeof charsOf === 'function' ? Number(charsOf(key)) : 0
    counters.unknownChars += Number.isFinite(chars) && chars > 0 ? chars : 0
    decision.unknownChars = counters.unknownChars
    if (counters.unknownChars > limits.unknownCharsPerTurn) decision.budgetCapped += 1
    if (turnCount > limits.repeatTurn || sessionCount > limits.repeatSession || counters.unknownChars > limits.unknownCharsPerTurn) {
      decision.capped.push(key)
    }
    decision.unknown.push(key)
    decision.inject.push(key)
  }
  if (counters.turn instanceof Map && turn !== null) {
    counters.turnNo = turn
  }
  if (turn === null) {
    // 回合未知时不清回合计数（不知道换没换回合，不能假装换了）。
    decision.turnUnknown = true
  }
  decision.evicted = boundCounter(counters.turn, limits) + boundCounter(counters.session, limits)
  // R-1 一致性：unknown 必须全部进 inject（结构上不可能违反，仍显式断言）。
  const injectSet = new Set(decision.inject)
  for (const key of decision.unknown) {
    if (!injectSet.has(key)) {
      throw new V3ContractViolation('v3 visibility: unknown 片段必须注入（visible:null 不得进 skip 集合）')
    }
  }
  for (const key of decision.skip) {
    if (injectSet.has(key)) {
      throw new V3ContractViolation('v3 visibility: 同一片段不得同时进 skip 与 inject')
    }
  }
  return decision
}
