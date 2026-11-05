/**
 * 判定缓存与重复计数（domain/visibility，G6b）。
 *
 * ## 为什么需要它
 * 每次 pre-step 都要判定一批命中片段。活动面与账本是只读输入，重判本身是纯函数；
 * 这里只做两件事：**按代际复用**判定结果、**累计** unknown 重复次数。
 *
 * ## 生命周期与上界（开发流程 §12.2「缓存有容量与生命周期上界」）
 * - 缓存只在**本进程、本实例**内（R-13：派生值不落盘，重启即空）；
 * - 条目上界 `stateMax`，超限按插入序淘汰最旧并计数（不静默）；
 * - 代际变化时：非纯 append 变化整批失效（旧结论可能已被推翻）；纯 append 变化
 *   （R-2：两个 generation 都没变 + 节点只在尾部增长 + 其余材料相同）才复用；
 * - `forget` / `undo` / `restore` / 归档 / 归档意图变化都会改变代际 → 缓存必然失效，
 *   所以「forget 同时清理派生信息」在这里是构造性成立的，不靠额外清理钩子；
 * - 迟到的异步写入不会复活内容：本实例没有任何异步写路径，判定只读快照。
 *
 * ## 与观测代际的隔离（R-3）
 * 这里的 `visibilityDigest` 不是观测合同的 `surface.epoch`，两者不可比较、不互相喂值。
 */
import { VISIBILITY_LIMITS } from '../../contracts/visibility.mjs'
import { V3ContractViolation } from '../../contracts/errors.mjs'
import { dedupeKeyOf } from './fragments.mjs'
import { isPureAppendAdvance, visibilityEpochOf } from './epoch.mjs'
import { visibilityOf } from './coverage.mjs'
import { resolveVisibilitySnapshot } from './snapshot.mjs'
import { visibleFragmentKeys } from './policy.mjs'

function assertLimits(limits) {
  const integers = ['fragmentBatch', 'stateMax', 'repeatTurn', 'repeatSession']
  for (const name of integers) {
    if (!Number.isInteger(limits?.[name]) || limits[name] < 1) {
      throw new V3ContractViolation('v3 visibility: limits.' + name + ' 必须是 ≥1 的整数（非法配置失败关闭）')
    }
  }
  if (!Number.isInteger(limits?.unknownCharsPerTurn) || limits.unknownCharsPerTurn < 0) {
    throw new V3ContractViolation('v3 visibility: limits.unknownCharsPerTurn 必须是 ≥0 的整数（非法配置失败关闭）')
  }
}

/** 把下标数组切成长度 ≤ size 的块（批量接口有界）。 */
function chunkIndexes(indexes, size) {
  const chunks = []
  for (let offset = 0; offset < indexes.length; offset += size) {
    chunks.push(indexes.slice(offset, offset + size))
  }
  return chunks
}

/**
 * 创建判定状态机（每会话每用例实例一个；进程内、无 IO）。
 * @param {{limits?: object}} [options]
 */
export function createVisibilityState({ limits = VISIBILITY_LIMITS } = {}) {
  assertLimits(limits)
  const cache = new Map()
  const counters = { digest: null, turnNo: null, turn: new Map(), session: new Map(), unknownChars: 0 }
  let previousEpoch = null
  let cacheEvictions = 0
  let cacheDrops = 0
  let counterResets = 0

  /**
   * 判定一批片段（只读快照；返回顺序与入参一致）。
   * @param {object} input {snapshot, fragments, sessionKey}
   */
  function evaluate({ snapshot = null, fragments = [], sessionKey = null } = {}) {
    if (!Array.isArray(fragments)) {
      throw new V3ContractViolation('v3 visibility: fragments 必须是数组')
    }
    if (typeof sessionKey !== 'string' || sessionKey.length === 0) {
      throw new V3ContractViolation('v3 visibility: 判定需要非空 sessionKey')
    }
    // P2-1-residual（审查行号 73-74/93/100/120）：**先解析快照、再算跨会话**。
    // 可见性摘要不含 sessionKey（同 material 的快照摘要相同），所以只要允许复用缓存，
    // 外来快照就会命中「本会话判出的 visible」→ 误跳过（危险方向）；反过来，外来快照首判
    // 的 unknown 也会被写进缓存，粘住后续同 material 的本会话快照。
    // 因此：cross=true 时**既不读也不写复用缓存**，也不更新本会话的代际基线。
    const resolved = resolveVisibilitySnapshot(snapshot)
    const normalizedSnapshot = resolved.ok ? resolved.snapshot : null
    const crossSession = normalizedSnapshot !== null
      && normalizedSnapshot.sessionKey !== null
      && normalizedSnapshot.sessionKey !== sessionKey
    const epoch = visibilityEpochOf(normalizedSnapshot)
    const reusable = !crossSession
      && previousEpoch !== null
      && (epoch.digest === previousEpoch.digest || isPureAppendAdvance(previousEpoch, epoch))
    if (!crossSession && !reusable && cache.size > 0) {
      cacheDrops += cache.size
      cache.clear()
    }
    const keys = fragments.map((fragment) => dedupeKeyOf(sessionKey, fragment))
    const verdicts = new Array(fragments.length)
    const pending = []
    let hits = 0
    for (let index = 0; index < fragments.length; index += 1) {
      const cached = reusable ? cache.get(keys[index]) : undefined
      if (cached !== undefined) {
        verdicts[index] = cached
        hits += 1
        continue
      }
      pending.push(index)
    }
    let misses = 0
    for (const chunk of chunkIndexes(pending, limits.fragmentBatch)) {
      const judged = visibilityOf({
        snapshot: normalizedSnapshot,
        sessionKey,
        fragments: chunk.map((index) => fragments[index]),
      })
      for (let offset = 0; offset < chunk.length; offset += 1) {
        const verdict = judged.verdicts[offset]
        verdicts[chunk[offset]] = verdict
        // 跨会话判定不得进缓存（否则未知/可见结论都会粘住后续正常快照）。
        if (!crossSession && !cache.has(verdict.dedupeKey)) {
          cache.set(verdict.dedupeKey, verdict)
          misses += 1
          while (cache.size > limits.stateMax) {
            const oldest = cache.keys().next()
            if (oldest.done) break
            cache.delete(oldest.value)
            cacheEvictions += 1
          }
        }
      }
    }
    if (!crossSession) previousEpoch = epoch
    return {
      digest: epoch.digest,
      // 跨会话快照（P2-1）也算降级：结论全部 unknown，必须让调用方看见而不是静默。
      degraded: !epoch.ok || crossSession,
      crossSession,
      verdicts,
      generations: { ...epoch.generations },
      cache: {
        hits,
        misses,
        evictions: cacheEvictions,
        dropped: cacheDrops,
        reused: reusable,
        size: cache.size,
      },
    }
  }

  /**
   * 注入决策（就地累计计数）。
   * @param {object} input {digest, verdicts, turn, charsOf}
   */
  function plan({ digest, verdicts = [], turn = null, charsOf = null } = {}) {
    if (typeof digest !== 'string' || digest.length === 0) {
      throw new V3ContractViolation('v3 visibility: 注入决策需要可见性摘要')
    }
    let reset = false
    if (digest !== counters.digest) {
      counters.digest = digest
      counters.turn.clear()
      counters.session.clear()
      counters.unknownChars = 0
      counterResets += 1
      reset = true
    }
    if (turn !== null && turn !== counters.turnNo) {
      counters.turnNo = turn
      counters.turn.clear()
      counters.unknownChars = 0
    }
    const decision = visibleFragmentKeys({ verdicts, counters, turn, charsOf, limits })
    decision.reset = reset
    decision.resets = counterResets
    decision.turnNo = counters.turnNo
    return decision
  }

  /** 只读诊断（测试与 status 面用；不改变任何计数）。 */
  function inspect() {
    return {
      digest: counters.digest,
      turnNo: counters.turnNo,
      turnKeys: counters.turn.size,
      sessionKeys: counters.session.size,
      unknownChars: counters.unknownChars,
      cacheSize: cache.size,
      cacheEvictions,
      cacheDrops,
      counterResets,
      limits,
    }
  }

  return { evaluate, plan, inspect }
}
