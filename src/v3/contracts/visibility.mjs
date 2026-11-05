/**
 * 「当前可见」判定合同（C-V-01 裁决 + G6b v1 范围）。
 *
 * ## 这个合同回答什么
 * 「这段片段**当前**是不是已经在模型可见的活动面投影里」——只服务 G6b 的可见片段去重。
 * 它**不是**「模型确实收到了」的主张：logical-request 未接线、wire 无 seam（G3 能力表），
 * 所以 `claim` 恒为 `surface-projected`，消费者不得把它读成「请求里确实有」。
 *
 * ## 为什么需要一份新合同（三个「看起来像可见性、其实不是」的量）
 * - append-only 日志 / `records/` 里有这条记录 = **可回读**，归档后的记录全都还在库里；
 * - once-per-turn 的 confirmed = 宿主**事件曾经存在**的历史事实；
 * - 读租约未过期 = 归档**保护**窗口，内容可能早已被遮蔽。
 * 三者都不是当前可见证据；本合同的输入只有活动面节点表、事件信封的遮蔽链接
 * （`sourceEventSeqs`）、凭证/遗忘账本与插件自有的有界登记。
 *
 * ## 8 值状态与 3 值消费者面
 * 内部枚举保留 8 值（判定能力完整），消费者面按 R-9 收敛成
 * `visible / not-visible / unknown` + proof。v1 的**信任集**只有五态
 * （`VISIBILITY_TRUSTED_STATES_V1`，R-12）：`visible-restored` 与
 * `visible-recall-pack` 的判定照常产出（R-9/R-10），但消费者在 v1 只把它们当
 * unknown 处理（保守注入），证据强度区分留 v2。
 *
 * ## 纪律
 * - 本文件零运行时依赖（只 import contracts/errors 的违规类型）；
 * - `visible: null` **只**属于 `unknown`；`visible !== null ⇔ state !== 'unknown'`
 *   是断言级不变量（R-1）；
 * - 时间戳不参与任何判定（C-G3-06：时间只在观测侧）；
 * - 派生值不落盘（R-13）——判定结果、可见性摘要、重复计数只活在调用方进程内。
 *   若未来要落盘，**必须**同时满足：新 schema 版本 + 会话隔离 + 纳入 retention/forget
 *   清理（对齐观测账本的 OBSERVATION_RETENTION 与 pruneCacheObservationLedger）；
 *   在此之前任何「缓存到隔离根」的写法都算违约。
 */
import { V3ContractViolation } from './errors.mjs'

/** 判定合同版本（状态语义变化必须升号；消费者按版本拒绝）。 */
export const VISIBILITY_CONTRACT_VERSION = 1

/**
 * 判定主张：恒为「活动面投影」（surface-projected）。
 * 接线 logical-request 之前，任何消费者不得把它读成「模型已收到」。
 */
export const VISIBILITY_CLAIM = 'surface-projected'

/**
 * 8 值状态封闭集（顺序即优先级，见 `visibilityOf` 的判据）。
 * forgotten > not-applicable > visible-* > hidden-receipt > absent > unknown。
 */
export const VISIBILITY_STATES = Object.freeze([
  'visible-surface',
  'visible-restored',
  'visible-recall-pack',
  'hidden-receipt',
  'absent',
  'forgotten',
  'not-applicable',
  'unknown',
])

/** 证明等级：结构证据（observed）/ 依赖自有登记或自产格式（inferred）/ 证据不足（unknown）。 */
export const VISIBILITY_PROOF_LEVELS = Object.freeze(['observed', 'inferred', 'unknown'])

/**
 * `hidden-receipt` 的四条通道（R-7）。
 *
 * 归因只看**可观测形状**，不推断宿主意图（U-V1 仍是未知）：
 * - `plugin-archive`：能匹配到凭证，或节点来源是插件回执（kind=插件、form=回执）；
 * - `system-message`：改写节点是系统消息（node 0 只可由系统消息改写）；
 * - `host-compaction`：宿主改写的多节点 replace（遮蔽 ≥2 个节点）；
 * - `host-prune`：宿主改写的单节点 replace。
 */
export const VISIBILITY_HIDDEN_CAUSES = Object.freeze([
  'plugin-archive',
  'host-compaction',
  'host-prune',
  'system-message',
])

/**
 * cause 封闭集（新增必须同时改合同与消费者）。
 * 与 `hidden-receipt` 四通道合在一起，构成判定回执里 `cause` 的全部合法取值。
 */
export const VISIBILITY_CAUSES = Object.freeze([
  'forgotten',
  'not-applicable',
  'not-covered',
  'proof-depth-exceeded',
  'surface-unreadable',
  'session-mismatch',
  'provenance-unknown',
  'voucher-missing',
  'restore-chain-unclosed',
  'recall-registry-hit',
  'recall-registry-miss',
  'recall-pack-parsed',
  'archive-intent-pending',
  'archive-intent-invalid',
  'archive-intent-unreadable',
  ...VISIBILITY_HIDDEN_CAUSES,
])

/** 证据条目种类封闭集（每条只带 kind/seq/id，不含正文；≤4 条）。 */
export const VISIBILITY_EVIDENCE_KINDS = Object.freeze([
  'surface-node',
  'shadow-link',
  'voucher',
  'restore-node',
  'recall-pack',
  'forgotten',
  'archive-intent',
])

/**
 * 只能留在 append-only 日志、结构上不可能出现在活动面的事件类型（P0 §2.1）。
 * 这类事件的记录内容若随 assistant 消息可见，那是**另一个片段身份**，不得混用。
 */
export const VISIBILITY_LOG_ONLY_EVENT_TYPES = Object.freeze(['tool/call'])

/**
 * v1 消费者信任的五态（R-12）：其余状态（`visible-restored` /
 * `visible-recall-pack`）照常判定，但消费者按 unknown 处理——保守方向是多注入，
 * 不会误删召回。信任集是**数据**，v2/G8 后可扩；扩展时必须同时改本数组与守卫。
 */
export const VISIBILITY_TRUSTED_STATES_V1 = Object.freeze([
  'visible-surface',
  'hidden-receipt',
  'absent',
  'forgotten',
  'unknown',
])

/** 消费者面三态（R-9）。 */
export const VISIBILITY_CONSUMER_STATES = Object.freeze(['visible', 'not-visible', 'unknown'])

/**
 * 有界参数（提案值，非已标定产品参数；G8 实测后调整）。
 * - `fragmentBatch`：单次判定批上界（批量接口有界，不做游标）；
 * - `evidenceMax`：判定回执的证据条数上界；
 * - `stateMax`：派生缓存条目上界（超限按最旧淘汰并计数）；
 * - `proofDepth`：遮蔽链跳数上界（超出落 unknown，不猜）；
 * - `repeatTurn` / `repeatSession`：unknown 重复上界（R-11）；
 * - `unknownCharsPerTurn`：每回合 unknown 注入字符预算（R-11，只作可见标记）。
 */
export const VISIBILITY_LIMITS = Object.freeze({
  fragmentBatch: 50,
  evidenceMax: 4,
  stateMax: 4096,
  proofDepth: 2,
  repeatTurn: 2,
  repeatSession: 4,
  unknownCharsPerTurn: 2000,
})

/**
 * 可见性摘要（visibilityDigest）的材料版本。
 * 注意：它与观测合同的 `surface.epoch`（整数代际）**不同源、不可比较、不参与种子判定**（R-3）。
 */
export const VISIBILITY_DIGEST_VERSION = 1

/** 去重键材料版本（键形状变化必须升号，否则旧键会与新键混算）。 */
export const VISIBILITY_DEDUPE_KEY_VERSION = 1

/**
 * 判定回执 → 消费者三态（唯一映射点）。
 * `visible: null` 恒为 unknown；不得把「不知道」读成「不可见」（会误删召回）。
 */
export function consumerStateOf(verdict) {
  if (verdict === null || typeof verdict !== 'object') return 'unknown'
  if (verdict.visible === true) return 'visible'
  if (verdict.visible === false) return 'not-visible'
  return 'unknown'
}

/**
 * 判定回执形状与一致性断言（R-1）。
 *
 * 唯一入口，不做「宽松读」：状态/证明/cause/证据越界即抛，`visible !== null`
 * 与 `state === 'unknown'` 必须互斥。这条断言就是「unknown 必须注入」的结构保证：
 * 任何把 unknown 写成 `visible: false` 的改动都会在这里红。
 */
export function assertVisibilityVerdict(verdict) {
  if (verdict === null || typeof verdict !== 'object') {
    throw new V3ContractViolation('v3 visibility: 判定回执必须是对象')
  }
  if (!VISIBILITY_STATES.includes(verdict.state)) {
    throw new V3ContractViolation('v3 visibility: state 不在封闭集：' + JSON.stringify(verdict.state))
  }
  if (!VISIBILITY_PROOF_LEVELS.includes(verdict.proof)) {
    throw new V3ContractViolation('v3 visibility: proof 不在封闭集：' + JSON.stringify(verdict.proof))
  }
  if (verdict.cause !== null && !VISIBILITY_CAUSES.includes(verdict.cause)) {
    throw new V3ContractViolation('v3 visibility: cause 不在封闭集：' + JSON.stringify(verdict.cause))
  }
  const unknown = verdict.state === 'unknown'
  if ((verdict.visible === null) !== unknown) {
    throw new V3ContractViolation('v3 visibility: visible 为 null 必须恰好对应 unknown（state=' + verdict.state + '，visible=' + JSON.stringify(verdict.visible) + '）')
  }
  if ((verdict.proof === 'unknown') !== unknown) {
    throw new V3ContractViolation('v3 visibility: proof=unknown 必须恰好对应 state=unknown（state=' + verdict.state + '）')
  }
  if (verdict.state.startsWith('visible-') && verdict.visible !== true) {
    throw new V3ContractViolation('v3 visibility: visible-* 状态必须 visible=true（state=' + verdict.state + '）')
  }
  if (!Array.isArray(verdict.evidence) || verdict.evidence.length > VISIBILITY_LIMITS.evidenceMax) {
    throw new V3ContractViolation('v3 visibility: evidence 必须是数组且 ≤' + VISIBILITY_LIMITS.evidenceMax + ' 条')
  }
  for (const item of verdict.evidence) {
    if (item === null || typeof item !== 'object' || !VISIBILITY_EVIDENCE_KINDS.includes(item.kind)) {
      throw new V3ContractViolation('v3 visibility: evidence.kind 不在封闭集：' + JSON.stringify(item?.kind))
    }
  }
  return verdict
}
