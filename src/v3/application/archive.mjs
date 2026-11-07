/**
 * 历史归档用例（application/archive，M2）。
 *
 * 顺序（安全优先）：
 * 1. 纯函数选连续 span（当前回合/插件节点/无记录节点不选）；
 * 2. 读记录，生成回执；
 * 3. 写 archive-intent；
 * 4. 宿主 range replace（失败 → 清 intent、surface 不变）；
 * 5. 追加 voucher；成功后清 intent / 推进 state。
 *
 * 这里不做压力/保留策略的“决定”，只执行已选 span；策略在 domain/archive/candidates。
 */
import { RESTORE_SOURCE_FORM, V3ContractViolation } from '../contracts/index.mjs'
// G5：调度候选的配置合同（contracts，零外部依赖）与纯策略（domain）。两者都不引观测
// 模块——观测数据只能经 POLICY_INPUT_PORT 校验后**以参数**进来（C7 边界保持）。
import { normalizeSchedulePolicyConfig } from '../contracts/archive-schedule-policy.mjs'
import { evaluateSchedulePolicy, nextSchedulePolicyState } from '../domain/archive/schedule-policy.mjs'
import { renderArchiveReceipt } from '../domain/archive/receipt.mjs'
import { restoreEligibilityOf, settleRestore, outcomeOfRestore } from '../domain/archive/restore.mjs'
import { selectArchiveSpan } from '../domain/archive/candidates.mjs'
import { STEP_BATCH_DEFAULT, selectStepSpan } from '../domain/archive/steps.mjs'
import { summarizeRecords } from '../domain/compress/summary.mjs'
import { wrapInjectedPayload } from '../domain/security/untrusted.mjs'

function textOfRecord(record) {
  if (record === null || typeof record !== 'object') return ''
  const text = record.payload?.text ?? record.text
  return typeof text === 'string' ? text : ''
}

/**
 * 恢复正文渲染（B-1 A，0.14.0-beta.48）：正文 + 确定性「工具调用」块。
 *
 * 归档恢复的承诺是「可按 ID 回读」，而 assistant 的工具调用参数不在 text 里
 * （旧实现 27/27 凭证、81 次调用、105,975 字参数不可恢复）。摄入侧已把调用块
 * 脱敏后写进 payload.structure.toolCalls；这里只渲染，不重新解释、不二次脱敏。
 * textOfRecord 本身保持原样——sourceChars 与 not-worth 判据不变。
 */
function toolCallsTextOf(structure) {
  const calls = structure?.toolCalls
  if (!Array.isArray(calls) || calls.length === 0) return ''
  const lines = []
  for (const call of calls) {
    const name = typeof call?.name === 'string' && call.name.length > 0 ? call.name : 'unknown'
    const callId = typeof call?.callId === 'string' ? call.callId : ''
    let argsText = ''
    try {
      argsText = typeof call?.arguments === 'string' ? call.arguments : JSON.stringify(call?.arguments ?? {})
    } catch {
      argsText = '[不可序列化参数]'
    }
    lines.push('· ' + name + (callId.length > 0 ? '(' + callId + ')' : '') + ' ' + argsText)
  }
  return '[工具调用]\n' + lines.join('\n')
}

function restoreTextOfRecord(record) {
  const text = textOfRecord(record)
  const calls = toolCallsTextOf(record?.payload?.structure)
  if (calls.length === 0) return text
  return text.length > 0 ? text + '\n\n' + calls : calls
}

/**
 * 「没有候选」也是一个**结果**，不是空值（0.14.0-beta.45，AUD-09 附带项）：
 * 带上选择器给的 reason，status 才能说清是当前回合 / 工作集 / pin / 无记录 / 未完成工具对，
 * 而不是只印一句「暂无可归档」，让用户只能靠反推。
 */
function noCandidate(rejection) {
  const reason = typeof rejection?.reason === 'string' && rejection.reason.length > 0 ? rejection.reason : 'no-candidate'
  return { ...(rejection ?? {}), status: 'no-candidate', reason }
}

/**
 * 调度候选（G5）运行时上下文：**未传 policy，或候选已关闭且配置合法 → null**。
 *
 * 返回 null 时下面的路径与 0.15.0 逐字节一致——off 路径唯一的分叉点就在这里（用测试钉死）。
 * 配置**非法**时不返回 null：要让调用方/status 看得到「候选被失败关闭」，
 * 而不是静默当成"没启用"（§11：非法值失败关闭 + 说明原因）。
 */
function schedulePolicyRuntimeOf(policy) {
  if (policy === null || policy === undefined) return null
  if (typeof policy !== 'object' || Array.isArray(policy)) return null
  const normalized = normalizeSchedulePolicyConfig(policy.config)
  if (normalized.ok === true && normalized.config.enabled !== true) return null
  return { config: policy.config, state: policy.state ?? null, input: policy.input ?? null }
}

/**
 * 策略决策 → 结果面（另加两个只读事实）：`scheduled` = 策略闸门是否放行本次调度，
 * `safeCandidates` = 现场安全候选段数（0 时如实说明"允许调度但没有安全候选"）。
 */
function schedulePolicyViewOf(decision, scheduled, safeCandidates) {
  if (decision === null) return null
  return { ...decision, scheduled, safeCandidates }
}

export function createArchiveService({ store, host, clock, intent = null, random = null, abandon = null, sha256 = null } = {}) {
  if (store === null || typeof store !== 'object') throw new V3ContractViolation('v3 archive: 需要 store')
  if (host === null || typeof host !== 'object') throw new V3ContractViolation('v3 archive: 需要 host')
  // R2-01（2026-10-30）：intentId 由 random 端口生成——application 层禁 import node:*，
  // 随机性按「只在 composition 出现」的约定经端口注入（composition.mjs random.uuid）。
  if (random === null || typeof random?.uuid !== 'function') {
    throw new V3ContractViolation('v3 archive: 需要 random.uuid 端口（R2-01 intentId 生成，composition 注入）')
  }
  const journal = intent !== null && typeof intent === 'object' ? intent : null
  // A-01（0.15.4）：restore 落下的恢复正文指纹。application 层禁 import node:*，
  // sha256 由 composition 注入（缺失时该路径自动失败关闭，退回正文扫描）。
  const hashOf = typeof sha256 === 'function' ? sha256 : null
  // P1-07：补凭证失败的**有界**放弃阈值。默认 5 次 / 6 小时——磁盘满这类瞬时故障通常
  // 在几分钟内被用户处理掉；中段损坏（永久性）不该让归档无限期停摆，也不该让该段
  // 永久无法恢复。两条任一命中即放弃（放弃前先把孤儿回执落盘）。
  const abandonAfterAttempts = Number.isInteger(abandon?.afterAttempts) && abandon.afterAttempts > 0 ? abandon.afterAttempts : 5
  const abandonAfterMs = Number.isFinite(abandon?.afterMs) && abandon.afterMs > 0 ? abandon.afterMs : 6 * 60 * 60 * 1000

  async function recordsOf(recordIds) {
    const rows = []
    for (const id of recordIds) {
      try {
        rows.push(await store.readRecord(id))
      } catch (error) {
        return { ok: false, error }
      }
    }
    return { ok: true, rows }
  }

  async function plan({ sessionId, events, surfaceNodes, seqToRecordId, mode, retainOperations = 5, lastArchiveEndSeq = -1, maxOperations = 1, pinnedSeqs = new Set(), minStartSeq = -1, turnBasis = 'human', currentTurn = null, summary = true }) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) throw new V3ContractViolation('v3 archive: sessionId 必填')
    if (!(seqToRecordId instanceof Map)) throw new V3ContractViolation('v3 archive: seqToRecordId 必须是 Map')
    // 拒绝原因（AUD-09 附带项）：选择器只回 null，原因经 onReject 带出，供 status 直读。
    let rejection = null
    const span = selectArchiveSpan({
      surfaceNodes,
      events,
      mode,
      retainOperations,
      lastArchiveEndSeq,
      maxOperations,
      pinnedSeqs,
      minStartSeq,
      turnBasis,
      currentTurn,
      hasRecord: (seq) => seqToRecordId.has(seq),
      onReject: (row) => { rejection = rejection ?? row },
    })
    if (span === null) return noCandidate(rejection)
    return await makePlan(span, { summary, seqToRecordId, unitLabel: mode === 'cooling' ? '步骤数' : '回合数' })
  }

  /**
   * span → 回执计划（回合级与步骤级共用）。
   * 净收益门槛在这里只有一处：回执本身也是上下文税，小段（回执比原文长）归档会让占用变大。
   */
  async function makePlan(span, { summary = false, seqToRecordId, unitLabel = '操作数' } = {}) {
    const recordIds = span.recordSeqs.map((seq) => seqToRecordId.get(seq))
    if (recordIds.some((id) => typeof id !== 'string' || id.length === 0)) {
      // P2-04：记录 ID 映射缺失是**数据面异常**，不是「没有候选」。旧实现返回 null，
      // 回合级调用方把它与「选择器没选出 span」混成同一个 `no-candidate`——于是
      // /memory-lab status 说「暂无可归档」，而实际上有候选、只是映射丢了（按步级
      // 早就返回结构化失败，两个入口口径相反）。这里返回结构化失败，让两个入口同口径：
      // 缺哪些 seq 一并带回，便于定位是摄入断点还是索引漂移。
      const missingSeqs = span.recordSeqs.filter((seq) => {
        const id = seqToRecordId.get(seq)
        return typeof id !== 'string' || id.length === 0
      })
      return {
        status: 'failed',
        phase: 'plan',
        reason: 'record-id-missing',
        seqs: missingSeqs,
        span,
        recordIds,
      }
    }
    const loaded = await recordsOf(recordIds)
    if (!loaded.ok) return { status: 'failed', reason: 'record-read-failed', error: loaded.error, span, recordIds }
    // 原文总字数必须先算：摘要预算 = max(0, sourceChars - 基础回执字数 - 安全余量)，
    // 否则固定 220 字摘要会让小步骤（原文约 200 字）的回执 ≥ 原文，永远判负死锁。
    const sourceChars = loaded.rows.reduce((sum, row) => sum + textOfRecord(row).length, 0)
    const summaryText = summary === true ? summarizeRecords(loaded.rows) : ''
    // 回执正文打印**记录 seq 范围**（recordSeqs 首尾）：span 起点可能是回注包这类
    // 无记录节点（它不该出现在「已把 seq A–B」的账目里）。
    const receiptStart = span.recordSeqs.length > 0 ? span.recordSeqs[0] : span.startSeq
    const receiptEnd = span.recordSeqs.length > 0 ? span.recordSeqs[span.recordSeqs.length - 1] : span.endSeq
    const receiptText = renderArchiveReceipt({
      startSeq: receiptStart,
      endSeq: receiptEnd,
      recordIds,
      operations: span.operations,
      unitLabel,
      summary: summaryText,
      sourceChars,
    })
    // 0.14.0-beta.52（用户拍板）：归档不再有恢复体积预算。restoreChars 只作为
    // 凭证上的观测值（history 可预判），不再阻止归档；超上下文交给宿主压缩。
    const restoreChars = loaded.rows.reduce((sum, row) => sum + restoreTextOfRecord(row).length, 0)
    // AUD48-04-01：sourceChars === 0（空正文/纯 metaOnly 回合）时旧条件被短路，160 字回执
    // 替换 0 字正文 → 活动面净增。回执本身也是上下文税，0 源必须判负；结构（toolCalls）
    // 的可恢复性不改变「可见正文为 0」这一事实，不能拿它给负收益开绿灯。
    if (receiptText.length >= sourceChars) {
      return { status: 'not-worth', span, recordIds, receiptText, sourceChars, receiptChars: receiptText.length }
    }
    // P4：候选预算随计划透出（工具 inspect 与 commit 同源；旧调用方多两个只读字段不改变行为）。
    return { ...span, recordIds, receiptText, summaryText, restoreChars, receiptChars: receiptText.length, sourceChars }
  }

  /**
   * 步骤级计划（普通降温 / 实时压缩）：在当前回合内压已完成步骤。
   * 与回合级共用回执与净收益口径，只是候选选择换成 steps.mjs。
   *
   * P3（0.15.0）：一批候选按保护洞切成多个安全 run，这里**逐段**做回执与净收益判断，
   * 返回 items（可提交段）与 skipped（判负段）。自动 / 预览 / 手动走同一个 planner，
   * lane 只决定是否绕闸门（manual），不改变安全/闭包/H=200/净收益判据。
   *
   * G5（0.15.0 候选，默认关闭）：`policy` 在**安全闭包之后、回执与正净收益之前**多出一道
   * 显式策略闸门（增长量/请求间隔/积压），只决定「现在调度还是等一下」：
   * - 安全判据、段边界、H=200、净收益判据一概不变（它只看得到选择器已经选出的安全段）；
   * - `policy` 未传 / 已关闭 → 本函数行为与 0.15.0 逐字节一致；
   * - 关闭状态下不读记录、不写任何东西；`policy-deferred` 同样不改 surface、不占 intent。
   */
  async function planSteps({ sessionId, events, surfaceNodes, seqToRecordId, retainSteps = 4, maxSteps = null, batchSteps = STEP_BATCH_DEFAULT, bypassBatch = false, pinnedSeqs = new Set(), minStartSeq = -1, summary = true, lane = 'auto', policy = null } = {}) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) throw new V3ContractViolation('v3 archive: sessionId 必填')
    if (!(seqToRecordId instanceof Map)) throw new V3ContractViolation('v3 archive: seqToRecordId 必须是 Map')
    let rejection = null
    // G5：off 路径的唯一分叉点（runtime 为 null ⇒ 后面的代码与 0.15.0 完全一致）。
    const policyRuntime = schedulePolicyRuntimeOf(policy)
    const batch = selectStepSpan({
      surfaceNodes,
      events,
      retainSteps,
      maxSteps,
      batchSteps,
      bypassBatch: bypassBatch === true || lane === 'manual',
      pinnedSeqs,
      minStartSeq,
      hasRecord: (seq) => seqToRecordId.has(seq),
      onReject: (row) => { rejection = rejection ?? row },
    })
    if (batch === null) {
      const rejected = noCandidate(rejection)
      if (policyRuntime === null) return rejected
      // 压力/节奏已满足但没有安全候选 → 如实报告（不为降 token 丢数据：不压、不改判据）。
      const idle = evaluateSchedulePolicy({
        config: policyRuntime.config,
        state: policyRuntime.state,
        input: policyRuntime.input,
        lane,
        facts: { pendingUnits: 0, batchSteps: 0, safeSegments: 0 },
      })
      return { ...rejected, policy: schedulePolicyViewOf(idle, false, 0) }
    }
    // G5：显式策略闸门（在安全闭包之后、回执/净收益之前）。
    const policyDecision = policyRuntime === null ? null : evaluateSchedulePolicy({
      config: policyRuntime.config,
      state: policyRuntime.state,
      input: policyRuntime.input,
      lane,
      facts: {
        pendingUnits: batch.eligible,
        batchSteps: batch.totalSteps,
        safeSegments: batch.segments.length,
      },
    })
    if (policyDecision !== null && policyDecision.decision === 'defer') {
      // 只"等"，不动任何东西：surface / intent / voucher / 记录都不碰，候选原样留在活动面。
      return {
        status: 'policy-deferred',
        reason: policyDecision.reason,
        segments: batch.segments,
        blocked: batch.blocked,
        threshold: batch.threshold,
        eligible: batch.eligible,
        scanned: batch.scanned,
        steps: batch.totalSteps,
        policy: schedulePolicyViewOf(policyDecision, false, batch.segments.length),
      }
    }
    // P3-3（G5 审查）：策略**放行后**的三个「没有可提交段」返回同样要带轨迹——
    // 否则 status/命令面看不到触发理由（"允许调度但没有正收益段"成了唯一不可解释的路径）。
    // off 路径 policyDecision 为 null ⇒ 下面三处展开为空对象，字节不变。
    const policyTrace = policyDecision === null ? {} : { policy: schedulePolicyViewOf(policyDecision, true, batch.segments.length) }
    const items = []
    const skipped = []
    for (let index = 0; index < batch.segments.length; index += 1) {
      const planned = await makePlan(batch.segments[index], { summary, seqToRecordId, unitLabel: '步骤数' })
      if (planned === null) {
        // 记录 ID 映射缺失是数据面异常（不是「没有候选」）：失败关闭，不提交任何段。
        return { status: 'failed', phase: 'plan', reason: 'record-id-missing', segments: batch.segments, blocked: batch.blocked, ...policyTrace }
      }
      if (planned.status === 'failed') return { ...planned, segments: batch.segments, blocked: batch.blocked, ...policyTrace }
      if (planned.status === 'not-worth') { skipped.push({ index, planned }); continue }
      items.push({ index, planned })
    }
    if (items.length === 0) {
      if (skipped.length > 0) {
        // 没有可提交段：把**最后一个**判负段交回入口推进游标（同批判负一次跳过，
        // 避免每个 pre-step 都从同一段队头重读记录）。
        const last = skipped[skipped.length - 1].planned
        return { ...last, status: 'not-worth', segments: batch.segments, skipped: skipped.map((entry) => summarizeSkipped(entry)), blocked: batch.blocked, ...policyTrace }
      }
      return {
        status: 'no-candidate',
        reason: batch.blocked?.reason ?? 'no-candidate',
        segments: batch.segments,
        blocked: batch.blocked,
        ...(batch.blocked ?? {}),
        ...policyTrace,
      }
    }
    return {
      status: 'planned',
      lane,
      segments: batch.segments,
      items,
      skipped,
      steps: items.reduce((sum, item) => sum + (item.planned.steps ?? 0), 0),
      startSeq: items[0].planned.startSeq,
      endSeq: items[items.length - 1].planned.endSeq,
      recordIds: items.flatMap((item) => item.planned.recordIds),
      receiptChars: items.reduce((sum, item) => sum + (item.planned.receiptText?.length ?? 0), 0),
      threshold: batch.threshold,
      eligible: batch.eligible,
      scanned: batch.scanned,
      truncated: batch.truncated,
      reachedLimit: batch.reachedLimit,
      blocked: batch.blocked,
      // G5：策略放行时带出轨迹（触发理由可打印）；off 路径不产生这个键。
      ...(policyDecision === null ? {} : { policy: schedulePolicyViewOf(policyDecision, true, batch.segments.length) }),
    }
  }

  /** 判负段的可观察摘要（不把整张回执搬进结果面）。 */
  function summarizeSkipped(entry) {
    return {
      index: entry.index,
      startSeq: entry.planned?.span?.startSeq ?? null,
      endSeq: entry.planned?.span?.endSeq ?? null,
      recordIds: entry.planned?.recordIds ?? [],
      sourceChars: entry.planned?.sourceChars ?? null,
      receiptChars: entry.planned?.receiptChars ?? null,
      reason: 'not-worth',
    }
  }

  /**
   * 提交前重验证（P3 §3.3）：同批多段提交会连续改活动面，后一段在提交前必须
   * 重新核对「它覆盖的节点仍是当前活动面上的一段密集区间」。计划里的记录正文
   * 已由 makePlan 读取；这里不做全量 hash，只拒绝**范围漂移**——
   * 不用过期计划去盖新面（宿主压缩/另进程改动都会让范围消失）。
   */
  async function revalidatePlanned({ host: hostPort, planned }) {
    if (typeof hostPort?.surfaceNodes !== 'function') return { ok: true }
    let nodes
    try {
      nodes = await hostPort.surfaceNodes()
    } catch (error) {
      return { ok: false, reason: 'surface-read-failed', error }
    }
    const startIdx = nodes.indexOf(planned.startSeq)
    const endIdx = nodes.indexOf(planned.endSeq)
    if (startIdx === -1 || endIdx === -1 || startIdx > endIdx) return { ok: false, reason: 'surface-changed' }
    const shadowed = nodes.slice(startIdx, endIdx + 1)
    if (shadowed.length !== planned.sourceEventSeqs.length
      || shadowed.some((seq, index) => seq !== planned.sourceEventSeqs[index])) {
      return { ok: false, reason: 'surface-changed' }
    }
    return { ok: true }
  }

  /** 只预览，不触碰 surface/store。 */
  async function dryRun(input) {
    const planned = await plan(input)
    if (planned === null) return { status: 'no-candidate', reason: 'no-candidate' }
    return { status: planned.status ?? 'planned', ...planned }
  }

  /** 执行一次归档；失败绝不推进 state。 */
  async function archiveOnce({ sessionId, events, surfaceNodes, seqToRecordId, mode, retainOperations = 5, lastArchiveEndSeq = -1, maxOperations = 1, pinnedSeqs = new Set(), minStartSeq = -1, turnBasis = 'human', currentTurn = null, summary = true, txn = 1 }) {
    const planned = await plan({ sessionId, events, surfaceNodes, seqToRecordId, mode, retainOperations, lastArchiveEndSeq, maxOperations, pinnedSeqs, minStartSeq, turnBasis, currentTurn, summary })
    return await commitPlanned({ sessionId, planned, txn, mode: mode === 'cooling' ? 'cooling' : 'full-history' })
  }

  /**
   * 执行一次**步骤级批量**归档（普通降温 / 实时压缩）：当前回合内已完成步骤。
   *
   * P3（0.15.0）：同一批的多个安全 run **逐段**提交——每段各自占 intent、改面、记 voucher，
   * 中途失败立即停下并如实回报「已提交 / 失败段 / 未提交」。跨区间没有宿主级原子性，
   * 不假装整批成功；也不因一段失败回滚已提交的段（那需要宿主提供事务，本版没有）。
   * 不推进 lastArchiveEndSeq（那是回合级位点，步骤级用磁盘上的真实节点判幂等）。
   */
  async function archiveStepBatch({ sessionId, events, surfaceNodes, seqToRecordId, retainSteps = 4, maxSteps = null, batchSteps = STEP_BATCH_DEFAULT, bypassBatch = false, pinnedSeqs = new Set(), minStartSeq = -1, summary = true, txn = 1, lane = 'auto', policy = null } = {}) {
    const planned = await planSteps({ sessionId, events, surfaceNodes, seqToRecordId, retainSteps, maxSteps, batchSteps, bypassBatch, pinnedSeqs, minStartSeq, summary, lane, policy })
    if (planned.status !== 'planned') return planned
    // G5：off（policy 未传/已关闭）时 planned.policy 不存在 ⇒ policyFields 为空对象，
    // 下面所有返回对象与 0.15.0 逐字节一致。提交成功才产出新的策略状态（nextState），
    // 由调用方按会话持久化；本层不写盘。
    const policyFieldsOf = (committedCount) => {
      if (planned.policy === undefined) return {}
      if (committedCount < 1) return { policy: { ...planned.policy, scheduled: false } }
      const nextState = nextSchedulePolicyState({ config: policy?.config, state: policy?.state, input: policy?.input })
      return { policy: { ...planned.policy, ...(nextState === null ? {} : { nextState }) } }
    }
    const committed = []
    let failure = null
    let stoppedIndex = planned.items.length
    for (let index = 0; index < planned.items.length; index += 1) {
      const item = planned.items[index]
      const check = await revalidatePlanned({ host, planned: item.planned })
      if (check.ok !== true) {
        failure = { index: item.index, phase: 'revalidate', reason: check.reason, error: check.error }
        stoppedIndex = index
        break
      }
      const result = await commitPlanned({ sessionId, planned: item.planned, txn: txn + index, mode: 'cooling' })
      if (result.status === 'archived') { committed.push(result); continue }
      failure = { index: item.index, ...result }
      stoppedIndex = index
      break
    }
    // 只有**已经处理过**的判负段才能推进游标；失败点之后的段没有评估/提交，
    // 不能因为同批计划里算出了 not-worth 就提前跳过（失败恢复后还要重试）。
    const stopAt = failure === null ? Number.POSITIVE_INFINITY : planned.items[stoppedIndex].index
    const processedSkipped = planned.skipped.filter((entry) => entry.index < stopAt)
    const notWorthThroughSeq = processedSkipped.reduce((max, entry) => {
      const endSeq = entry.planned?.span?.endSeq
      return Number.isInteger(endSeq) && endSeq > max ? endSeq : max
    }, -1)
    const skipped = processedSkipped.map((entry) => summarizeSkipped(entry))
    // 未提交集合 = 失败段及其之后的所有段（失败段不是「已提交」，不能从账目里消失）。
    const remaining = planned.items.slice(stoppedIndex).map((item) => ({
      startSeq: item.planned.startSeq,
      endSeq: item.planned.endSeq,
      steps: item.planned.steps,
      recordIds: item.planned.recordIds,
    }))
    if (committed.length === 0) {
      if (failure === null) {
        // 计划里至少有一项可提交，却一段都没成——只可能是并发/占槽把第一段挡下。
        return { status: 'failed', phase: 'commit', reason: 'no-segment-committed', segments: planned.segments, blocked: planned.blocked, ...policyFieldsOf(0) }
      }
      return {
        status: 'failed',
        phase: failure.phase,
        reason: failure.reason,
        error: failure.error,
        existing: failure.existing ?? null,
        intentKept: failure.intentKept ?? false,
        span: planned.items[stoppedIndex]?.planned ?? null,
        segments: planned.segments,
        blocked: planned.blocked,
        skipped,
        notWorthThroughSeq: notWorthThroughSeq >= 0 ? notWorthThroughSeq : null,
        remaining,
        ...policyFieldsOf(0),
      }
    }
    return {
      status: failure === null ? 'archived' : 'partial',
      // 已提交段的真实账目（逐段 receiptSeq/范围）。
      segments: committed,
      committedCount: committed.length,
      steps: committed.reduce((sum, row) => sum + (row.steps ?? 0), 0),
      startSeq: committed[0].startSeq,
      endSeq: committed[committed.length - 1].endSeq,
      recordIds: committed.flatMap((row) => row.recordIds),
      receiptSeq: committed[committed.length - 1].receiptSeq,
      receiptSeqs: committed.map((row) => row.receiptSeq),
      // P2-19：顶层 `receiptText` 曾经只取**首段**（`committed[0].receiptText`），而
      // `receiptChars` 是**各段之和**——同一份结果里两个字段量的是两件事：拿到 receiptText 的
      // 调用方以为它是本批全部回执（实际只有第一段），按它算长度/比对必然对不上。
      // 现在顶层字段按段序拼接（与 receiptChars 同一口径），逐段原文另给 `receiptTexts`。
      // 注意：单段批（最常见）拼出来与旧值**逐字节相同**，所以既有单段消费方不受影响。
      receiptText: committed.map((row) => row.receiptText).join(''),
      // P2-19：`receiptChars` 必须与上面的 `receiptText` 是**同一份正文**的长度（旧实现里
      // receiptText 只有首段、receiptChars 却是各段之和，两个字段互相矛盾）。
      receiptChars: committed.map((row) => row.receiptText).join('').length,
      // 计划面事实：本批候选数、跳过的判负段、批尾阻塞原因（status 可解释）。
      plannedSegments: planned.segments.length,
      plannedCount: planned.items.length,
      threshold: planned.threshold,
      eligible: planned.eligible,
      reachedLimit: planned.reachedLimit,
      blocked: planned.blocked,
      skipped,
      notWorthThroughSeq: notWorthThroughSeq >= 0 ? notWorthThroughSeq : null,
      failed: failure === null ? null : {
        index: failure.index,
        phase: failure.phase,
        reason: failure.reason,
        error: failure.error,
        existing: failure.existing ?? null,
        intentKept: failure.intentKept ?? false,
      },
      failedSegment: failure === null ? null : (planned.items[stoppedIndex]?.planned ?? null),
      remaining,
      ...policyFieldsOf(committed.length),
    }
  }

  /**
   * 清 intent（best-effort，AUD51-05-03）：`journal.clear` 可能是**同步**实现（返回
   * undefined）。旧实现直接 `.catch()`，同步实现会抛 TypeError——归档已经成功落面，
   * 却因为这个收尾动作把整次调用变成异常。这里同时接受 Promise 与非 Promise；
   * 同步抛错同样吞掉（清 intent 是收尾动作，不是归档成败的判据）。
   *
   * R3-02（2026-10-30）：清理带**身份**（expected intent）——journal 实现据此在锁内
   * 比对后再删，迟到的旧清理不再可能删除后来创建的新意图。旧 journal 合同
   * （clear 不接受参数）忽略 expected，行为不变。
   */
  async function clearIntentOf(journal, expected = undefined) {
    if (journal === null || journal === undefined || journal.clear === undefined) return
    try {
      const pending = journal.clear(expected)
      if (pending !== null && typeof pending?.then === 'function') await pending
    } catch {
      // 清 intent 失败不影响已落面的事实：下一次 pre-step 对账会再清一次。
    }
  }

  /**
   * 同 clearIntentOf 但带回结果（recoverIntent 的清理必须可观测）：
   * journal 返回 {ok:false,status:'conflict'|'unreadable'} 或抛错时如实上报
   * 「没删成」，不能冒充清理成功（R3-02）。
   */
  async function clearIntentWithResult(journal, expected) {
    if (journal === null || journal === undefined || journal.clear === undefined) return { cleared: true }
    try {
      const pending = journal.clear(expected)
      const result = pending !== null && typeof pending?.then === 'function' ? await pending : pending
      if (result !== null && typeof result === 'object' && result.ok === false) {
        return { cleared: false, status: result.status, existing: result.existing ?? null, error: result.error }
      }
      return { cleared: true }
    } catch (error) {
      return { cleared: false, status: 'error', error }
    }
  }
  /** 落面 + 记 voucher（失败保留 intent，绝不假装成功）。
   *
   * 0.15.0 P4：`summaryRef` / `proposalId` 随 intent 与 voucher 落盘——崩溃补账使用
   * **原字节**（不重跑生成器、不改回执），摘要只作为派生引用的
   * {summaryId, hash, sourceSetFingerprint} 三元组，不把正文复制进凭证。
   */
  async function commitPlanned({ sessionId, planned, txn = 1, mode = 'full-history', summaryRef = null, proposalId = null }) {
    if (planned === null) return { status: 'no-candidate', reason: 'no-candidate' }
    // no-candidate 现在带 reason（选择器拒绝原因），必须原样透传，不能在这里重新拼成空对象。
    if (planned.status === 'no-candidate' || planned.status === 'failed' || planned.status === 'not-worth') return planned
    const intent = {
      schemaVersion: 1,
      // R2-01（2026-10-30）：稳定操作身份——占槽/对账/清理都按它比对，恢复补凭证沿用。
      intentId: random.uuid(),
      sessionId,
      // C-D（0.14.0-beta.48）：崩溃恢复必须知道是回合级还是步骤级——按步归档的
      // 恢复绝不能写 lastArchiveEndSeq（那会成为回合级选择的永久下限）。
      mode: mode === 'cooling' ? 'cooling' : 'full-history',
      // C-E：凭证事务号随 intent 落盘（旧实现恢复时硬编码 txn:1，对账回溯对不上）。
      txn: Number.isInteger(txn) && txn >= 1 ? txn : 1,
      startSeq: planned.startSeq,
      endSeq: planned.endSeq,
      sourceEventSeqs: [...planned.sourceEventSeqs],
      recordIds: [...planned.recordIds],
      receiptText: planned.receiptText,
      // AUD50-02-02：恢复体积随 intent 落盘，崩溃对账补凭证时体积估计不丢。
      restoreChars: Number.isInteger(planned.restoreChars) ? planned.restoreChars : null,
      // P4：摘要引用只存身份/hash（正文在 summaries.jsonl，不可变）。旧 intent 没有这两个
      // 字段，恢复路径按缺省处理，行为与旧版一致。
      ...(summaryRef === null ? {} : { summaryRef }),
      ...(typeof proposalId === 'string' && proposalId.length > 0 ? { proposalId } : {}),
      createdAt: clock.now(),
    }
    // R2-01：先占槽再落面。槽位已被未对账意图占用（或不可读）→ 结构化阻断：
    // 不写 intent、不碰宿主面、不追加凭证；正常对话与只读能力不受影响。
    // 有 reserve 的 journal（真实存储）走锁内占槽校验；旧 journal 合同（仅 write）
    // 退回原写入，行为不变。
    if (journal?.reserve !== undefined) {
      const reserved = await journal.reserve(intent)
      if (reserved !== null && typeof reserved === 'object' && reserved.ok === false) {
        return {
          status: 'failed',
          phase: 'intent',
          reason: reserved.status === 'unreadable' ? 'intent-unreadable' : 'intent-pending',
          error: reserved.error,
          existing: reserved.existing ?? null,
        }
      }
    } else if (journal?.write !== undefined) {
      await journal.write(intent)
    }
    let receiptSeq
    try {
      const confirmation = await host.surfaceOp({
        op: 'replace',
        startSeq: planned.startSeq,
        endSeq: planned.endSeq,
        sourceEventSeqs: planned.sourceEventSeqs,
        text: planned.receiptText,
      })
      receiptSeq = confirmation?.seq
      if (!Number.isInteger(receiptSeq) || receiptSeq < 1) throw new V3ContractViolation('v3 archive: 宿主未返回 receipt seq')
    } catch (error) {
      // 宿主可能**已经 append 成功、只是确认面失败**（dsh-host 的 surfaceOp 在 appendReceipt
      // 之后才校验 eventAt/被遮蔽节点，失败就抛）。旧实现把这个 catch 当成「surface 没变」
      // 并清掉 intent，于是活动面留下一条回执、凭证账本却没有它，而对账线索也被删掉——
      // 恢复面永远找不到这条回执（审计 C-A：history=0、vouchers=0、intent 已清）。
      // 保留 intent 交给 recoverIntent：找得到同正文节点就补 voucher，找不到就清，
      // 两种结局都安全，且不需要假设「replace 失败 = surface 不变」。
      return { status: 'failed', phase: 'surface', error, span: planned, intentKept: journal?.clear !== undefined }
    }
    try {
      await store.appendVoucher({
        schemaVersion: 2,
        voucherId: 'v-' + receiptSeq,
        kind: 'span',
        recordIds: planned.recordIds,
        sourceEventSeqs: planned.sourceEventSeqs,
        startSeq: planned.startSeq,
        endSeq: planned.endSeq,
        targetEventId: receiptSeq,
        receiptText: planned.receiptText,
        summaryText: planned.summaryText ?? '',
        restoreChars: Number.isInteger(planned.restoreChars) ? planned.restoreChars : null,
        ...(summaryRef === null ? {} : { summaryRef, summaryId: summaryRef.summaryId }),
        ...(typeof proposalId === 'string' && proposalId.length > 0 ? { proposalId } : {}),
        txn: Number.isInteger(txn) && txn >= 1 ? txn : 1,
      })
    } catch (error) {
      // 保留 intent：下个 pre-step 可按 receiptText 找到 surface 节点补 voucher。
      // P1-07：提交失败本身就是第 1 次失败——把 attempts/firstFailedAt 随 intent 落盘，
      // 放弃阈值覆盖「提交失败」而不是从下一次对账才开始计数。
      const now = clock.now()
      try {
        await journal?.write?.({ ...intent, attempts: 1, firstFailedAt: now, lastFailedAt: now, lastError: error?.code ?? 'EINTERNAL' })
      } catch { /* 记不上不影响对账：下一次失败会重新从 1 开始计数（只多挡几步，不会误放弃） */ }
      return { status: 'failed', phase: 'voucher', error, receiptSeq, span: planned, attempts: 1 }
    }
    await clearIntentOf(journal, intent)
    return {
      status: 'archived',
      receiptSeq,
      startSeq: planned.startSeq,
      endSeq: planned.endSeq,
      recordIds: planned.recordIds,
      receiptText: planned.receiptText,
      operations: planned.operations,
      steps: Number.isInteger(planned.steps) ? planned.steps : undefined,
      voucherId: 'v-' + receiptSeq,
      summaryId: summaryRef?.summaryId ?? null,
    }
  }

  /**
   * 提交一个已准备计划（P4 工具/提案路径）。与自动归档走**同一个** commitPlanned：
   * 占槽、intent、宿主 replace、凭证、清理全部复用，不新增第二套提交器。
   *
   * @param {object} input
   * @param {object} input.plan 已包含 receiptText/recordIds/…（由统一 planner 的候选构造）
   * @param {object|null} [input.summaryRef] {summaryId, hash, sourceSetFingerprint}
   */
  async function commitPrepared({ sessionId, plan, txn = 1, mode = 'full-history', summaryRef = null, proposalId = null } = {}) {
    if (plan === null || typeof plan !== 'object') return { status: 'failed', phase: 'plan', error: new V3ContractViolation('v3 archive: commitPrepared 需要计划') }
    if (typeof plan.receiptText !== 'string' || plan.receiptText.length === 0) return { status: 'failed', phase: 'plan', reason: 'receipt-missing' }
    if (!Array.isArray(plan.recordIds) || plan.recordIds.length === 0) return { status: 'failed', phase: 'plan', reason: 'records-missing' }
    return await commitPlanned({ sessionId, planned: plan, txn, mode, summaryRef, proposalId })
  }

  /**
   * 崩溃对账：intent 在、surface 上能找到同正文节点 → 补 voucher；
   * 找不到 → 清 intent（不推进 state）。返回是否做了修复。
   */
  async function recoverIntent({ sessionId, surfaceNodes, surfaceTextOf } = {}) {
    if (typeof surfaceTextOf !== 'function') return { recovered: false }
    const intent = journal?.read === undefined ? null : await journal.read().catch(() => null)
    if (intent === null || typeof intent !== 'object') return { recovered: false }
    // C-D：恢复必须按 intent 里记录的模式落 state（旧版 intent 没有 mode → 回合级）。
    const mode = intent.mode === 'cooling' ? 'cooling' : 'full-history'
    const nodes = (surfaceNodes ?? []).filter((seq) => Number.isInteger(seq) && seq > intent.endSeq)
    const receiptSeq = await firstEligibleSeq(nodes, intent.receiptText, surfaceTextOf)
    if (receiptSeq === null) {
      // R3-02：按身份清理——对账期间槽位被新意图占走（conflict）时**不删**，
      // 如实上报 cleared:false，让下一次对账接手（新意图属于新事务）。
      const cleared = await clearIntentWithResult(journal, intent)
      return { recovered: false, cleared: cleared.cleared, clearStatus: cleared.cleared ? undefined : cleared.status, mode }
    }
    // 幂等（审计 C-C / H6）：崩溃窗口「voucher 已追加、intent 未清」会重进这里。
    // 旧实现在**锁外**用本句柄的内存视图 .some() 判重：另一进程刚追加的凭证它看不到，
    // 于是两进程各写一条 v-<seq>，history/restoreAll 的条数与 restore(序号) 的下标全部错位。
    // 现在把「刷新 → 判重 → 追加」交给存储层在跨进程写锁内完成（appendVoucher），
    // 重复由 ESTORE_DUPLICATE_VOUCHER 表达，这里只是把冲突翻译成 duplicateSkipped。
    let duplicateSkipped = false
    try {
      {
        await store.appendVoucher({
          schemaVersion: 2,
          voucherId: 'v-' + receiptSeq,
          kind: 'span',
          recordIds: intent.recordIds,
          sourceEventSeqs: intent.sourceEventSeqs,
          startSeq: intent.startSeq,
          endSeq: intent.endSeq,
          targetEventId: receiptSeq,
          receiptText: intent.receiptText,
          restoreChars: Number.isInteger(intent.restoreChars) ? intent.restoreChars : null,
          // P4：摘要引用随 intent 补账（使用原字节；不重跑生成器）。
          ...(intent.summaryRef === undefined || intent.summaryRef === null ? {} : { summaryRef: intent.summaryRef, summaryId: intent.summaryRef.summaryId }),
          ...(typeof intent.proposalId === 'string' && intent.proposalId.length > 0 ? { proposalId: intent.proposalId } : {}),
          // C-E：用 intent 里的事务号（旧版 intent 没有 txn → 1，与旧行为一致）。
          txn: Number.isInteger(intent.txn) && intent.txn >= 1 ? intent.txn : 1,
        })
      }
    } catch (error) {
      if (error?.code === 'ESTORE_DUPLICATE_VOUCHER') {
        // 另一进程/重放已经补过同 ID 凭证：幂等成功，继续清 intent。
        duplicateSkipped = true
      } else {
        // P1-07：补账失败必须**有界**。旧实现每次都 kept:true——磁盘满或 vouchers.jsonl 中段
        // 损坏时，该段原文永远没有凭证（restore 找不到），槽位被占又**永久停掉该会话的新归档**。
        //
        // 现在累计尝试次数与首败时间（随 intent 落盘）：未到阈值 → 保留并重试；到阈值 →
        // 放弃：先把回执正文 + recordIds 落进 orphan-receipts.jsonl（restore 的兜底线索），
        // 再按身份清槽。孤儿账本写失败就**不放弃**（宁可继续挡，也不丢恢复线索）。
        const now = clock.now()
        const attempts = (Number.isInteger(intent.attempts) && intent.attempts > 0 ? intent.attempts : 0) + 1
        const firstFailedAt = Number.isFinite(intent.firstFailedAt) ? intent.firstFailedAt : now
        const lastError = error?.code ?? 'EINTERNAL'
        const giveUp = attempts >= abandonAfterAttempts || (now - firstFailedAt) >= abandonAfterMs
        if (!giveUp) {
          try {
            await journal?.write?.({ ...intent, attempts, firstFailedAt, lastFailedAt: now, lastError })
          } catch {
            // 记不上就下次再试：绝不因为「记不上」而谎报放弃（attempts 只在内存推进）。
          }
          return { recovered: false, kept: true, receiptSeq, mode, error: lastError, attempts, retryAt: firstFailedAt + abandonAfterMs }
        }
        if (typeof store.appendOrphanReceipt !== 'function') {
          // 存储实现没有孤儿账本（旧替身）：不能放弃——放弃就等于丢恢复线索。
          return { recovered: false, kept: true, receiptSeq, mode, error: lastError, attempts, abandonFailed: 'store-no-orphan-ledger' }
        }
        let orphanId = null
        try {
          const appended = await store.appendOrphanReceipt({
            receiptSeq,
            receiptText: intent.receiptText,
            recordIds: Array.isArray(intent.recordIds) ? [...intent.recordIds] : [],
            startSeq: Number.isInteger(intent.startSeq) ? intent.startSeq : null,
            endSeq: Number.isInteger(intent.endSeq) ? intent.endSeq : null,
            sourceEventSeqs: Array.isArray(intent.sourceEventSeqs) ? [...intent.sourceEventSeqs] : [],
            restoreChars: Number.isInteger(intent.restoreChars) ? intent.restoreChars : null,
            mode,
            txn: Number.isInteger(intent.txn) ? intent.txn : null,
            attempts,
            firstFailedAt,
            abandonedAt: now,
            lastError,
          })
          orphanId = appended?.id ?? null
        } catch (orphanError) {
          return { recovered: false, kept: true, receiptSeq, mode, error: lastError, attempts, abandonFailed: orphanError?.code ?? 'orphan-append-failed' }
        }
        // 清槽用**磁盘上那份 intent** 的身份（放弃分支没有改写 attempts，指纹仍匹配）。
        const cleared = await clearIntentWithResult(journal, intent)
        return { recovered: false, abandoned: true, orphanId, receiptSeq, mode, attempts, error: lastError, cleared: cleared.cleared, clearStatus: cleared.cleared ? undefined : cleared.status }
      }
    }
    // 成功路径同样按身份清理（R3-02）：conflict（对账期间槽位被新意图占走）时
    // 不删并如实上报——凭证已补上，新意图留给下一次对账。
    const cleared = await clearIntentWithResult(journal, intent)
    return {
      recovered: true,
      receiptSeq,
      endSeq: intent.endSeq,
      mode,
      duplicateSkipped,
      cleared: cleared.cleared,
      ...(cleared.cleared ? {} : { clearStatus: cleared.status }),
    }
  }

  /**
   * 恢复资格只有一个实现（D-E）：domain 的 restoreEligibilityOf 是唯一判据，
   * 归档服务不再自己写一套「逐字节相等」的循环。返回首个合格节点的 seq。
   */
  async function firstEligibleSeq(nodes, expected, textAt) {
    for (const seq of nodes) {
      if (!Number.isInteger(seq)) continue
      const surfaceText = await textAt(seq)
      if (restoreEligibilityOf({ receiptText: expected, surfaceText }).eligible) return seq
    }
    return null
  }

  const REDACTED_RECEIPT = '[记忆上下文] 该回执涉及已遗忘记录，摘要已清除；原文不可恢复。'

async function replaceVoucherReceipt(index, expected, next) {
    const vouchers = store.listVouchers()
    const voucher = vouchers[index]
    if (voucher === undefined) return { changed: false, reason: 'voucher-not-found' }
    if (typeof host.surfaceNodes !== 'function' || typeof host.surfaceTextAt !== 'function') {
      return { changed: false, reason: 'host-no-surface-text' }
    }
    // 单节点 replace 会生成新 seq；凭证里的 targetEventId 只在首次落面时有效。
    //
    // A-01（0.15.4）：定位顺序改为「先账本 seq、再正文扫描」。
    //
    // 为什么必须这样：`restore` 把回执节点**原地替换**成原文后，面上再也没有那段回执
    // 正文了，正文扫描必然返回 null → `receipt-changed` → 这张凭证永远 redact 不掉。
    // 账本里由 restore 落下的 `restored` 行给了确定 seq，先按它定位并**复核正文**
    // （节点可能已被宿主压缩/改写，那就不许覆盖）。账本没有记录（老库/从未 restore）
    // 时才退回正文扫描，行为与 0.15.3 完全一致。
    const nodes = await host.surfaceNodes()
    let targetSeq = null
    if (typeof store.restoredSeqOf === 'function') {
      let recorded = null
      try { recorded = store.restoredSeqOf(voucher.voucherId) } catch { recorded = null }
      if (Number.isInteger(recorded) && nodes.includes(recorded)) {
        // 复核：这个 seq 现在装的是不是**restore 当初落下的那段正文**？
        //
        // restore 之后节点里是恢复出来的原文，不是回执正文，所以不能拿 expected 比。
        // 也不能只判「不是回执/不是清除标记」——那样宿主压缩改写过的任何正文都会被
        // 当成可覆盖，违背失败关闭。判据用**记下来的恢复正文指纹**：落面时把
        // sha256 写进账本，这里逐字节复核；指纹缺（老库）或不符一律不走这条路径。
        let fingerprintOk = false
        if (hashOf !== null && typeof store.restoredTextHashOf === 'function') {
          let recordedHash = null
          try { recordedHash = store.restoredTextHashOf(voucher.voucherId) } catch { recordedHash = null }
          if (typeof recordedHash === 'string' && recordedHash.length > 0) {
            const currentText = await host.surfaceTextAt(recorded)
            fingerprintOk = hashOf(currentText) === recordedHash
          }
        }
        if (fingerprintOk) targetSeq = recorded
      }
    }
    if (targetSeq === null) {
      targetSeq = await firstEligibleSeq(nodes, expected, (seq) => host.surfaceTextAt(seq))
    }
    if (targetSeq === null) return { changed: false, reason: 'receipt-changed' }
    try {
      const confirmation = await host.surfaceOp({ op: 'replace', targetEventId: targetSeq, text: next })
      // P1-08：把**新节点 seq** 带回给调用方（redact 要落进 redactions.jsonl）。
      return { changed: true, seq: Number.isInteger(confirmation?.seq) ? confirmation.seq : null }
    } catch (error) {
      return { changed: false, reason: 'surface-rejected', error }
    }
  }

  /**
   * 遗忘级联：把含已遗忘记录的回执替换成不含正文的标记（可 undo 还原）。
   *
   * H4（2026-11-04 审计）：持久标记失败**不得被吞**。旧实现 `.catch(() => {})` 后仍返回
   * `changed:true`，命令面于是显示「N 段回执已清除」，而 history/export 读不到
   * redactions 标记，会把该回执正文原样带出。现在把标记结果作为返回值的一部分：
   * `marked:false` + `markError`，调用方据此计入失败，不再谎报全部清除。
   */
  async function redactVoucher(index) {
    const voucher = store.listVouchers()[index]
    if (voucher === undefined) return { changed: false, reason: 'voucher-not-found' }
    let result = await replaceVoucherReceipt(index, voucher.receiptText, REDACTED_RECEIPT)
    if (result.changed !== true && result.reason === 'receipt-changed') {
      // P2-05（可收敛）：表面**已经**是清除标记、只是上次标记写失败 → 本次是补标记的
      // 重试机会，不能因为「没有可替换的正文」就提前返回（那样这张回执的 redactions
      // 行永远补不上，history/export 会一直把它的正文当可导出）。
      const already = await firstEligibleSeq(await host.surfaceNodes(), REDACTED_RECEIPT, (seq) => host.surfaceTextAt(seq))
      if (already !== null) result = { changed: false, reason: 'already-redacted', seq: already }
    }
    if (result.changed !== true && result.reason !== 'already-redacted') return result
    if (typeof store.markVoucherRedacted !== 'function') return { ...result, marked: false, markError: 'store-no-redaction-ledger' }
    try {
      const marked = await store.markVoucherRedacted(voucher.voucherId, true, { seq: result.seq })
      // 同一判据两处（redact / unredact）：changed:false 且状态不对 = 标记没写成功。
      return marked?.changed === false && marked?.redacted !== true
        ? { ...result, marked: false, markError: 'redaction-mark-noop' }
        : { ...result, marked: true, ...(result.changed === true ? {} : { repaired: true }) }
    } catch (error) {
      return { ...result, marked: false, markError: error?.code ?? error?.message ?? String(error) }
    }
  }

  async function unredactVoucher(index) {
    const voucher = store.listVouchers()[index]
    if (voucher === undefined) return { changed: false, reason: 'voucher-not-found' }
    if (typeof host.surfaceNodes !== 'function' || typeof host.surfaceTextAt !== 'function') {
      return { changed: false, reason: 'host-no-surface-text' }
    }
    // P1-08：undo 必须按「清除时落下的新节点 seq」定位。旧实现按正文逐字节比对，而**所有**
    // 已清除回执的正文都是同一个常量串 REDACTED_RECEIPT——两块都被清后 unredact(#1) 会把
    // #1 的正文写进 #0 的槽位，位置与内容互换，history 却都显示 redacted:false。
    let result = null
    let targetSeq = typeof store.redactionSeqOf === 'function' ? store.redactionSeqOf(voucher.voucherId) : null
    if (!Number.isInteger(targetSeq)) {
      // 老账本没有 seq：只有「当前恰好只有这一张已清除回执」时映射才无歧义；
      // 多于一张就失败关闭——宁可 undo 不成立，也不把别人的正文写到错位置。
      let redacted = null
      // T-03：端口层已改为「按戳刷新后读」，必须 await（否则拿到 Promise，判据失真）。
      try { redacted = await store.redactedVoucherIds() } catch { redacted = null }
      if (redacted === null || redacted.length !== 1 || redacted[0] !== voucher.voucherId) {
        return { changed: false, reason: 'redaction-seq-missing' }
      }
      // A-03（0.15.4）：即便「当前只有这一张已清除」，面上仍可能有**多个**常量节点
      // （别的凭证被清除后又恢复、或并发写入留下的残留）。取「第一个」等于赌它是本凭证的，
      // 赌错就把别处的正文写进这个槽位（位置与内容互换）。所以要求**唯一**，不唯一就失败关闭。
      const nodes0 = await host.surfaceNodes()
      const constantSeqs = []
      for (const seq of nodes0) {
        if ((await host.surfaceTextAt(seq)) === REDACTED_RECEIPT) constantSeqs.push(seq)
      }
      if (constantSeqs.length !== 1) {
        return { changed: false, reason: constantSeqs.length === 0 ? 'receipt-changed' : 'redaction-seq-ambiguous' }
      }
      targetSeq = constantSeqs[0]
      if (targetSeq === null) return { changed: false, reason: 'receipt-changed' }
    } else {
      // seq 定位后仍要复核表面正文：节点可能已被宿主压缩/改写（那就不能覆盖）。
      const nodes = await host.surfaceNodes()
      if (!nodes.includes(targetSeq)) return { changed: false, reason: 'receipt-changed' }
      if ((await host.surfaceTextAt(targetSeq)) !== REDACTED_RECEIPT) return { changed: false, reason: 'receipt-changed' }
    }
    try {
      const confirmation = await host.surfaceOp({ op: 'replace', targetEventId: targetSeq, text: voucher.receiptText })
      result = { changed: true, seq: Number.isInteger(confirmation?.seq) ? confirmation.seq : null }
    } catch (error) {
      return { changed: false, reason: 'surface-rejected', error }
    }
    if (typeof store.markVoucherRedacted !== 'function') return { ...result, marked: false, markError: 'store-no-redaction-ledger' }
    try {
      // P2-05：旧实现**不看返回值**，于是标记没写成功也报 marked:true——命令面显示
      // 「N 段已还原」，history 里却仍是 redacted:true（观察面与事实分叉）。判据与
      // redactVoucher 同源：changed:false 且状态仍为「已清除」= 没写成功。
      const marked = await store.markVoucherRedacted(voucher.voucherId, false)
      return marked?.changed === false && marked?.redacted === true
        ? { ...result, marked: false, markError: 'redaction-mark-noop' }
        : { ...result, marked: true }
    } catch (error) {
      return { ...result, marked: false, markError: error?.code ?? error?.message ?? String(error) }
    }
  }

  /** 恢复一个凭证：正文逐字节相等，失败关闭；不设体积上限（超上下文交给宿主压缩）。 */
  async function restoreVoucher(index) {
    let vouchers
    try { vouchers = store.listVouchers() } catch (error) { return { restored: false, reason: 'vouchers-unreadable', error } }
    const voucher = vouchers[index]
    if (voucher === undefined) return { restored: false, reason: 'voucher-not-found' }
    if (!Number.isInteger(voucher.targetEventId) || voucher.targetEventId < 1) {
      return { restored: false, reason: 'not-a-span-voucher' }
    }
    if (typeof host.surfaceNodes !== 'function' || typeof host.surfaceTextAt !== 'function') {
      return { restored: false, reason: 'host-no-surface-text' }
    }
    // P2-07：凭证任一记录已被物理清除 → 该段不可恢复（先判，不去碰宿主面）。
    try {
      const purgedNow = typeof store.listPurged === 'function' ? new Set(store.listPurged()) : null
      if (purgedNow !== null && (voucher.recordIds ?? []).some((id) => purgedNow.has(id))) {
        return { restored: false, reason: 'record-purged' }
      }
    } catch {
      return { restored: false, reason: 'purge-ledger-unreadable' }
    }
    const targetSeq = await firstEligibleSeq(await host.surfaceNodes(), voucher.receiptText, (seq) => host.surfaceTextAt(seq))
    if (targetSeq === null) {
      // A-08（0.15.4）：`receipt-changed` 一个码掩盖了**三类完全不同的事实**：
      //   ① 这一张已经恢复过（面上早就是原文了）——不是失败，是「已完成」；
      //   ② 面上被别的东西改过（真冲突）；
      //   ③ 段早已出面/被回收（确实没得恢复）。
      // 旧实现一律记 skipped，于是 `restore all` 跑第二次会把所有「已恢复」报成跳过，
      // 用户看到「N 段跳过」以为出了问题。这里用账本里记下的恢复节点 seq 判定 ①。
      let alreadyRestored = null
      try {
        alreadyRestored = typeof store.restoredSeqOf === 'function' ? store.restoredSeqOf(voucher.voucherId) : null
      } catch { alreadyRestored = null }
      if (Number.isInteger(alreadyRestored) && alreadyRestored > 0) {
        const nodesNow = await host.surfaceNodes()
        if (nodesNow.includes(alreadyRestored)) {
          return { restored: false, alreadyRestored: true, reason: 'already-restored', restoredSeq: alreadyRestored }
        }
      }
      return { restored: false, reason: 'receipt-changed' }
    }
    const loaded = await recordsOf(voucher.recordIds)
    if (!loaded.ok) {
      // D-B：已遗忘与「读失败」必须分开记账（旧实现只表现为 record-read-failed）。
      const reason = loaded.error?.code === 'EFORGOTTEN' ? 'record-forgotten'
        : loaded.error?.code === 'ERECORD_NOT_FOUND' ? 'record-not-found'
        : 'record-read-failed'
      return { restored: false, reason, error: loaded.error }
    }
    const text = loaded.rows.map(restoreTextOfRecord).filter((part) => part.length > 0).join('\n\n')
    if (text.length === 0) return { restored: false, reason: 'no-restorable-text' }
    // AUD48-08-01：恢复正文首尾加插件来源标记（模型据此知道这是资料，不是新指令），
    // 并声明本次落面的 source.form = restore（与归档回执区分开）。正文本身一字不改。
    const next = wrapInjectedPayload('restore', text, {
      startSeq: voucher.startSeq, endSeq: voucher.endSeq, count: loaded.rows.length,
    })
    try {
      const confirmation = await host.surfaceOp({ op: 'replace', targetEventId: targetSeq, text: next, sourceForm: RESTORE_SOURCE_FORM })
      const newSeq = Number.isInteger(confirmation?.seq) ? confirmation.seq : null
      // A-01（0.15.4）：把恢复节点的 seq 落进账本。
      //
      // 这是「restore 之后就无法 redact」的根因修复：restore 会把回执节点原地替换成原文，
      // 宿主分配新 seq、旧 seq 作废，面上再也没有那段回执正文——过去 redact 靠正文扫描
      // 定位，于是恒拿到 receipt-changed，那张凭证就**永久清洗不掉**了。
      // 现在把「凭证 → 当前节点 seq」持久化，redact/unredact 优先按 seq 定位。
      // 写失败不影响本次 restore（正文已经落面），只让清洗退回旧路径——如实记进返回值。
      let seqRecorded = false
      if (newSeq !== null && typeof store.markVoucherRestoredSeq === 'function') {
        try {
          // 同时记下**恢复正文的指纹**：后续 redact 靠它确认「这个 seq 装的确实是我
          // 当初恢复的那段正文」，而非宿主改写后的别的内容（失败关闭判据）。
          const marked = await store.markVoucherRestoredSeq(voucher.voucherId, newSeq, hashOf === null ? null : hashOf(next))
          seqRecorded = marked?.changed === true || marked?.seq === newSeq
        } catch { seqRecorded = false }
      }
      return { restored: true, seq: newSeq, chars: text.length, voucherIndex: index, seqRecorded }
    } catch (error) {
      return { restored: false, reason: 'surface-rejected', error }
    }
  }

  /**
   * P1-07：恢复一条**孤儿回执**（补凭证放弃后的兜底）。落面口径与 restoreVoucher 同源：
   * 按回执正文定位节点 → 读记录 → 包来源标记后 replace；正文被宿主改写/记录已遗忘都失败关闭。
   */
  async function restoreOrphan(orphan) {
    if (typeof host.surfaceNodes !== 'function' || typeof host.surfaceTextAt !== 'function') {
      return { restored: false, reason: 'host-no-surface-text' }
    }
    // A-05（0.15.4）：孤儿回执被遗忘级联清除过 → 正文已不在账本里，永远不可恢复。
    // 必须**明确**说清，不能落到 `receipt-changed`（那会让用户以为「也许还有救」）。
    if (orphan?.redacted === true) return { restored: false, reason: 'orphan-redacted' }
    const targetSeq = await firstEligibleSeq(await host.surfaceNodes(), orphan.receiptText, (seq) => host.surfaceTextAt(seq))
    if (targetSeq === null) return { restored: false, reason: 'receipt-changed' }
    const loaded = await recordsOf(Array.isArray(orphan.recordIds) ? orphan.recordIds : [])
    if (!loaded.ok) {
      const reason = loaded.error?.code === 'EFORGOTTEN' ? 'record-forgotten'
        : loaded.error?.code === 'ERECORD_NOT_FOUND' ? 'record-not-found'
        : 'record-read-failed'
      return { restored: false, reason, error: loaded.error }
    }
    const text = loaded.rows.map(restoreTextOfRecord).filter((part) => part.length > 0).join('\n\n')
    if (text.length === 0) return { restored: false, reason: 'no-restorable-text' }
    const facts = { count: loaded.rows.length }
    if (Number.isInteger(orphan.startSeq) && Number.isInteger(orphan.endSeq)) {
      facts.startSeq = orphan.startSeq
      facts.endSeq = orphan.endSeq
    }
    const next = wrapInjectedPayload('restore', text, facts)
    try {
      const confirmation = await host.surfaceOp({ op: 'replace', targetEventId: targetSeq, text: next, sourceForm: RESTORE_SOURCE_FORM })
      return { restored: true, seq: confirmation?.seq, chars: text.length, orphanId: orphan.id }
    } catch (error) {
      return { restored: false, reason: 'surface-rejected', error }
    }
  }

  async function restoreAll() {
    let vouchers
    try { vouchers = store.listVouchers() } catch (error) { return { restored: 0, skipped: 0, forgotten: 0, total: 0, rows: [], error } }
    const rows = []
    for (let index = 0; index < vouchers.length; index += 1) {
      const result = await restoreVoucher(index)
      rows.push({ index, ...result })
    }
    // A-08（0.15.4）：三桶之外单列 alreadyRestored——「上次已经恢复过」是**完成**，
    // 不是跳过。把它算进 skipped 会让第二次 `restore all` 看起来「全部失败」。
    // 折算规则收在 `outcomeOfRestore`（纯函数，可单独钉住）。
    const settled = settleRestore(rows.map(outcomeOfRestore))
    // P1-07：孤儿回执是「放弃补凭证」留下的恢复线索——不恢复它，放弃就等于永久丢原文。
    const orphanRows = []
    let orphans = []
    try {
      orphans = typeof store.listOrphanReceipts === 'function' ? store.listOrphanReceipts() : []
    } catch (error) {
      // 孤儿账本读不到：如实报告，不把「读不到」当「没有」（那会让恢复静默少段）。
      orphanRows.push({ orphanId: null, restored: false, reason: 'orphans-unreadable', error: error?.code ?? String(error) })
    }
    for (const orphan of orphans) {
      orphanRows.push({ orphanId: orphan.id, receiptSeq: orphan.receiptSeq ?? null, ...(await restoreOrphan(orphan)) })
    }
    return {
      total: settled.total,
      restored: settled.restored,
      // A-08：三桶里 alreadyRestored 已并入 restored（它们确实处于「已恢复」状态），
      // 这里单列出来，让命令面能说「其中 N 段上次就恢复过」而不是含糊地算成跳过。
      alreadyRestored: rows.filter((row) => row.alreadyRestored === true).length,
      skipped: settled.skipped,
      forgotten: settled.forgotten,
      balanced: settled.balanced,
      rows,
      orphanTotal: orphans.length,
      orphanRestored: orphanRows.filter((row) => row.restored === true).length,
      orphanFailed: orphanRows.filter((row) => row.restored !== true).length,
      orphans: orphanRows,
    }
  }

  async function history() {
    let vouchers
    try { vouchers = store.listVouchers() } catch (error) { return { error } }
    let redactedIds = new Set()
    try {
      // T-03：端口层「按戳刷新后读」，必须 await。
      redactedIds = new Set(typeof store.redactedVoucherIds === 'function' ? await store.redactedVoucherIds() : [])
    } catch {
      // 标记账本损坏不阻断历史列表：只把 redacted 标为 null（未知），不伪造「未清除」。
      redactedIds = null
    }
    // P2-07：**purge 事实优先于 redactions 标记**。物理清除删正文在前、回执清除在后，
    // 中间任一步失败（redact 的 receipt-changed / 标记写失败）都会让 vouchers.jsonl 里
    // 继续留着 ≤400 字原文首部——而读面只看 redactions 就把它当「未清除」导出去。
    // 判据改为「凭证任一记录已被 purge ⇒ 该段正文一律不可见、不可恢复」，与 redact 解耦。
    let purgedIds = new Set()
    try {
      purgedIds = new Set(typeof store.listPurged === 'function' ? store.listPurged() : [])
    } catch {
      // 读不到 purge 账本：按「未知」失败关闭——宁可整列按已清除显示，也不谎报可导出。
      purgedIds = null
    }
    const purgedOf = (voucher) => {
      if (purgedIds === null) return true
      const ids = Array.isArray(voucher?.recordIds) ? voucher.recordIds : []
      return ids.some((id) => purgedIds.has(id))
    }
    return {
      total: vouchers.length,
      // P1-07：孤儿回执数（补凭证放弃后仍可恢复的段）。读不到时如实返回 null，不报 0。
      orphanCount: (() => {
        try {
          return typeof store.listOrphanReceipts === 'function' ? store.listOrphanReceipts().length : 0
        } catch {
          return null
        }
      })(),
      rows: vouchers.map((voucher, index) => ({
        index,
        targetEventId: voucher.targetEventId,
        startSeq: voucher.startSeq ?? null,
        endSeq: voucher.endSeq ?? null,
        recordIds: Array.isArray(voucher.recordIds) ? [...voucher.recordIds] : [],
        chars: typeof voucher.receiptText === 'string' ? voucher.receiptText.length : 0,
        // AUD50-02-02：归档时记录的恢复体积（旧凭证没有 → null，不猜）。
        restoreChars: Number.isInteger(voucher.restoreChars) ? voucher.restoreChars : null,
        summary: typeof voucher.summaryText === 'string' && voucher.summaryText.length > 0,
        // P4：摘要引用（旧凭证没有 → null，不猜）。
        summaryId: typeof voucher.summaryRef?.summaryId === 'string' ? voucher.summaryRef.summaryId : null,
        // D-C：隐私面已清除的回执在历史里必须看得出来（否则观察面以为它仍可恢复）。
        // P2-07：purge 事实同样算「已清除」——正文已被删除，无论 redact 成功与否。
        redacted: redactedIds === null ? (purgedOf(voucher) ? true : null) : (redactedIds.has(voucher.voucherId) || purgedOf(voucher)),
        // 观测面：区分「按 redactions 标记清除」与「按 purge 事实兜底」。后者说明级联没走完，
        // history 消费者（含导出）不得把 receiptText 当可导出正文。
        purged: purgedOf(voucher),
      })),
    }
  }

  return { plan, planSteps, dryRun, archiveOnce, archiveStepBatch, commitPrepared, recoverIntent, redactVoucher, unredactVoucher, restoreVoucher, restoreAll, history }
}
