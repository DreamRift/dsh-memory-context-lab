/**
 * processTurn 用例（application，M3 第一批）。
 *
 * 事件顺序（计划 §2.8 固化，不得重排）：归一化 → 裁决 → 持久化 → 投影 → 计量。
 * 本批口径：裁决策略 = 全事件按需记忆化（每事件一条记录，M4 引入保护集/降温策略后
 * 在此替换）；投影面（surface effects）尚未接入宿主，outcome 只结算 store-record。
 * application 只依赖 contracts/domain/ports（架构守卫）；存储经注入的 SessionStore 端口。
 *
 * ## 批量提交（beta.11）
 * 回填时逐事件 `store.transaction([record])` 的成本不是「一次写」：每笔事务都要取跨进程
 * 写锁、同步事务日志、原子写 payload、追加 commit、重写 manifest——本机实测 1500 条要 45 秒，
 * 5000 条要 8 分钟。这段时间里 `inflight` 一直非空，回注被 busy 挡住，等于把「回填」变成了
 * 「功能不可用时段」。
 *
 * 现在提供 `processTurnMany`：**同一批事件共用一笔存储事务**（记录仍是每事件一条、ID 与
 * 来源事件一一对应），单笔失败即整批 failed——与存储层「全有或全无」的语义一致。
 * `processTurn` 退化为批量为 1 的特例，保证两条路径的行为不可能分叉。
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

  /**
   * 批量推进：同一批共用一笔存储事务。
   *
   * @param {object} input { items: Array<{ event, text, meta }> }（event 必须是**已归一化**事件）
   * @returns {Promise<Array<object>>} 与入参同序的结果（rejected / applied / failed）
   */
  async function processTurnMany({ items } = {}) {
    if (!Array.isArray(items)) {
      throw new V3ContractViolation('v3 processTurn: items 必须是数组')
    }
    const prepared = []
    // 回滚点：整批事务失败时，回合号必须回到批前——否则「0 条落库但 turn 已前进」，
    // 下一步重放同一批会二次计数（批量把这条放大到 100 条/次）。
    const turnBeforeBatch = turnState
    // 同一批共用同一个事务句柄：provenance.transactionId 必须与真实提交对得上，
    // 否则「按事务回溯」会把一批记录指到不存在的事务号上。
    const batchTxnHandle = 'tx-' + random.uuid()

    for (const item of items) {
      // ① 归一化：非法事件失败关闭（不落库、不计量 applied）
      const validation = validateEvent(item?.event)
      if (!validation.ok) {
        metrics?.counter?.('v3.processTurn.rejected', 1)
        prepared.push({ rejected: true, errors: validation.errors, turn: turnState.turn })
        continue
      }
      const normalized = validation.event

      // ② 裁决：回合推进（只有真实人类输入开新回合）+ 不可变 decision
      turnState = nextTurnState(turnState, normalized, ownSourceKinds)
      const now = clock.now()
      const hex16 = HEX_OF_UUID(random.uuid()).slice(0, 16)
      const body = typeof item.text === 'string' ? item.text : ''
      const meta = item.meta
      const record = {
        id: 'v3r-' + hex16,
        kind: KIND_OF_TYPE[normalized.type],
        sessionKey: normalized.sessionKey,
        createdAt: now,
        payload: {
          text: body,
          bytes: Buffer.byteLength(body, 'utf8'),
          ...(meta?.metaOnly === true ? { metaOnly: true, metaReason: typeof meta.metaReason === 'string' ? meta.metaReason : 'unknown' } : {}),
          ...(meta?.structure !== undefined ? { structure: meta.structure } : {}),
        },
        provenance: {
          sourceEventId: normalized.id,
          sourceForm: normalized.source.form,
          transactionId: batchTxnHandle,
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
      prepared.push({ rejected: false, record, decision, now, turn: turnState.turn })
    }

    // ③ 持久化：一批一笔事务（全有或全无）
    const records = prepared.filter((entry) => entry.rejected === false).map((entry) => entry.record)
    let txn = null
    let failure = null
    if (records.length > 0) {
      try {
        txn = await store.transaction(records)
      } catch (error) {
        failure = { effectIndex: 0, code: error?.code ?? 'EINTERNAL', message: error?.message ?? String(error) }
        // 一条都没落库：回合推进一并撤回（与「全有或全无」同一语义）
        turnState = turnBeforeBatch
      }
    }

    // ④⑤ 投影（本批无 surface effects）→ 计量 + outcome（结构校验不过即编程错误）
    return prepared.map((entry) => {
      if (entry.rejected === true) {
        return { status: 'rejected', errors: entry.errors, turn: entry.turn }
      }
      const appliedEffects = failure === null ? 1 : 0
      const outcomeRaw = {
        decisionId: entry.decision.id,
        sessionKey: entry.decision.sessionKey,
        at: entry.now,
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
      metrics?.observe?.('v3.processTurn.turn', entry.turn)
      return {
        status: outcomeRaw.status,
        decision: entry.decision,
        outcome: outcomeRaw,
        txn,
        turn: entry.turn,
        recordId: entry.record.id,
        // 已提交记录的完整对象：镜像等派生写入不必再按 ID 读一次盘（回填时是 O(N) 次读）。
        record: entry.record,
      }
    })
  }

  /** 单事件入口：批量为 1 的特例（行为与批量路径同源，不会分叉）。 */
  const processTurn = async function processTurn({ event, text, meta }) {
    const [result] = await processTurnMany({ items: [{ event, text, meta }] })
    return result
  }
  /** 批量入口：同一批共用一笔存储事务（回填路径用）。 */
  processTurn.many = processTurnMany
  return processTurn
}
