/**
 * processTurn 用例（application，M3 第一批）。
 *
 * 事件顺序（计划 §2.8 固化，不得重排）：归一化 → 裁决 → 持久化 → 投影 → 计量。
 * 本批口径：裁决策略 = 全事件按需记忆化（每事件一条记录，M4 引入保护集/降温策略后
 * 在此替换）；投影面（surface effects）尚未接入宿主，outcome 只结算 store-record。
 * application 只依赖 contracts/domain/ports（架构守卫）；存储经注入的 SessionStore 端口。
 */
import { sealDecision, validateEvent, validateOutcome, V3ContractViolation } from '../contracts/index.mjs'
import { nextTurnState } from '../domain/session/turn.mjs'
import { assertPort } from '../ports/index.mjs'

/** 事件类型 → 记录种类（封闭映射）。 */
const KIND_OF_TYPE = Object.freeze({
  user: 'message-user',
  assistant: 'message-assistant',
  'tool-call': 'operation',
  'tool-result': 'operation',
})

const HEX_OF_UUID = (uuid) => String(uuid).replace(/-/g, '').toLowerCase()

/**
 * 创建 processTurn 用例。
 * @param {object} deps { store: SessionStore 端口, clock: Clock, random: Random, metrics?: Metrics, ownSourceKinds: string[] }
 */
export function createProcessTurn({ store, clock, random, metrics, ownSourceKinds }) {
  if (!Array.isArray(ownSourceKinds) || ownSourceKinds.length === 0) {
    throw new V3ContractViolation('v3 processTurn: ownSourceKinds 必须非空（判定真实用户回合的依据）')
  }
  assertPort('SessionStore', store)
  assertPort('Clock', clock)
  assertPort('Random', random)
  // 装配期探针：random.uuid() 必须能派生 16 位十六进制（坏注入当场失败，不留到运行期）
  if (HEX_OF_UUID(random.uuid()).slice(0, 16).length !== 16) {
    throw new V3ContractViolation('v3 processTurn: random.uuid() 必须能派生 16 位十六进制')
  }

  let turnState = { turn: 0, eventsInTurn: 0 }

  return async function processTurn({ event, text }) {
    // ① 归一化：非法事件失败关闭（不落库、不计量 applied）
    const validation = validateEvent(event)
    if (!validation.ok) {
      metrics?.counter?.('v3.processTurn.rejected', 1)
      return { status: 'rejected', errors: validation.errors, turn: turnState.turn }
    }
    const normalized = validation.event

    // ② 裁决：回合推进（插件自有来源不推进）+ 不可变 decision
    turnState = nextTurnState(turnState, normalized, ownSourceKinds)
    const now = clock.now()
    const hex16 = HEX_OF_UUID(random.uuid()).slice(0, 16)
    const body = typeof text === 'string' ? text : ''
    const transactionHandle = 'tx-' + random.uuid()
    const record = {
      id: 'v3r-' + hex16,
      kind: KIND_OF_TYPE[normalized.type],
      sessionKey: normalized.sessionKey,
      createdAt: now,
      payload: { text: body, bytes: Buffer.byteLength(body, 'utf8') },
      provenance: {
        sourceEventId: normalized.id,
        sourceForm: normalized.source.form,
        transactionId: transactionHandle,
      },
    }
    const decision = sealDecision({
      id: 'dec-' + random.uuid(),
      kind: 'archive',
      sessionKey: normalized.sessionKey,
      createdAt: now,
      effects: [{ kind: 'store-record', recordId: record.id }],
      basis: '全事件按需记忆化（M3-b1 策略）',
    })

    // ③ 持久化：单笔事务；失败 → outcome failed（不伪成功），错误如实带回
    let txn = null
    let failure = null
    try {
      txn = await store.transaction([record])
    } catch (error) {
      failure = { effectIndex: 0, code: error?.code ?? 'EINTERNAL', message: error?.message ?? String(error) }
    }

    // ④ 投影：本批无 surface effects（M4 接入），failed 即 0 applied
    const appliedEffects = failure === null ? 1 : 0

    // ⑤ 计量 + outcome（结构校验不过即编程错误）
    const outcomeRaw = {
      decisionId: decision.id,
      sessionKey: decision.sessionKey,
      at: now,
      status: failure === null ? 'applied' : 'failed',
      totalEffects: 1,
      appliedEffects,
      failures: failure === null ? [] : [failure],
    }
    const outcomeCheck = validateOutcome(outcomeRaw)
    if (!outcomeCheck.ok) {
      throw new V3ContractViolation('v3 processTurn: outcome 结构非法——' + outcomeCheck.errors.join('；'))
    }
    metrics?.counter?.(failure === null ? 'v3.processTurn.applied' : 'v3.processTurn.failed', 1)
    metrics?.observe?.('v3.processTurn.turn', turnState.turn)

    return {
      status: outcomeRaw.status,
      decision,
      outcome: outcomeRaw,
      txn,
      turn: turnState.turn,
      recordId: record.id,
    }
  }
}
