/**
 * 步骤级归档候选（普通降温 / 实时压缩，beta.40；0.15.0 P3 批量多段）。
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
 * 4. 未完成 tool 对、插件回执、pin、缺记录是整步边界；回注包透明（与回合级同一口径）；
 * 5. 整步每个**活动面节点**都必须有 v3 记录（回注包除外），否则不压；
 * 6. 批量阈值 batchSteps：工作集外的完整步骤攒够一批才提交（v2 archiveBatchSize 同义）。
 *    达到阈值后按**最旧的一批候选**（窗口 = 最旧 T 个合格候选）处理：批内按硬边界
 *    切成多个安全连续 run，**逐个 run 各自提交**（逐段 intent/voucher）——这是 0.15.0
 *    P3 对 beta 批次行为「只提交第一段、保护洞后的段要等下一批」的修正；
 * 7. 工具闭包不能拆：一个 run 的声明/结果可以跨步，但必须都落在同一段连续范围；
 *    批尾的调用未闭合时只向**后**扩到下一个闭合点（受 maxSteps/H=200 硬上限约束），
 *    绝不越过 pin/插件/缺记录/回合边界去凑闭合；
 * 8. 失败关闭：run 的闭合前缀之外（含跨洞的开尾）不遮蔽；没有任何安全段时如实拒绝。
 *
 * 灵枢（dsh-memory）参考：工具输出/命令默认低价值（role 分层）、越旧越可弃（时间衰减）、
 * 丢弃前必须可回读（记录 + 回执）。这里用「工作集窗口 + 整步可恢复」落地这三条，
 * 不用概率模型（确定性优先，与 P9 单源口径一致）。
 */
import { V3ContractViolation } from '../../contracts/errors.mjs'
import { callIdOf, createToolCallIndex, indexToolCallEvent, isHumanUserEvent, isPluginSurfaceEvent, isRecallPackEvent, toolCallDeclarationsOf, toolClosureOf, toolClosureOfRange } from './event-shape.mjs'

/**
 * 按步归档的**批量阈值**（默认/取值域沿用 v2 archiveBatchSize 的权威口径）。
 *
 * v2 core-settings.mjs 的 DEFAULT_SETTINGS.archiveBatchSize 注释原文：
 * 「How many operations must have fallen out of the retention window before a batch
 * is submitted」——窗口外候选不足阈值就等待；达到阈值取最旧一批，阈值外的候选
 * 留给后续批次；活动面保护/非合格单元会切断连续 run，所以单张回执段可小于阈值。
 * **闸门只判候选总量**：窗口外候选不足阈值时等待，不因 pin/硬边界提前提交（v2 §40）。
 * v2 的 NUMERIC_SETTINGS.batch 是 **1–200 的整数**（0 在 CLI 与 schema 两处都被拒绝：
 * 批量阈值 0 等于每步都改前缀，正是这个设置要避免的事）；默认 10。
 *
 * 在 v3 按步归档里单位改为**完整步骤**，且与另外两个参数严格分离：
 * - retainSteps（来自 retainOperations）决定**工作集**：最近 N 步不压；
 * - batchSteps（本常量域）决定**什么时候压**：窗口外攒够 N 个候选才提交一批；
 * - maxSteps 决定**单次调用最多触碰几步**（含闭合扩展；可选硬上限）：缺省时自动
 *   通道的候选窗口就是 batchSteps，但批尾跨步闭包最多扩到 H=200 的扫描上限；
 *   显式传 maxSteps 时它同时限制窗口与扩展（R06 的「被 maxSteps 切开 → 拒绝」）。
 *
 * 非法值（0/负数/小数/超上界）回落默认 10，不静默夹取、也不退化成每步归档。
 */
export const STEP_BATCH_DEFAULT = 10
export const STEP_BATCH_MIN = 1
export const STEP_BATCH_MAX = 200

export function normalizeStepBatch(value) {
  if (!Number.isInteger(value) || value < STEP_BATCH_MIN || value > STEP_BATCH_MAX) return STEP_BATCH_DEFAULT
  return value
}

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
        declared: new Set(),
        calls: new Set(),
        results: new Set(),
        malformedDeclaration: false,
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
    // R06（0.15.0）：调用全集优先取 assistant 结构块声明的 id（tool/call 在真实宿主
    // 是 log-only，活动面上看不到）。只认独立 tool/call 会把「声明了但结果还没到」
    // 的调用当成不存在 → 部分结果的步骤被判完成并归档。缺 id 的畸形块按未知保护，
    // id/callId 冲突则两个候选都收（不静默偏爱）。
    const declaration = toolCallDeclarationsOf(event)
    for (const declaredId of declaration.ids) open.declared.add(declaredId)
    if (declaration.malformed) open.malformedDeclaration = true
    const callId = callIdOf(event)
    if (event.type === 'tool/call' && callId !== null) open.calls.add(callId)
    if (event.type === 'tool/result' && callId !== null) open.results.add(callId)
  }
  // 单元级闭包（诊断/兼容）：声明的 id ∪ 已见 tool/call，与同一单元内的 tool/result
  // 比较。**它不是选择判据**——一次操作的声明与结果可以落在相邻步骤，选择器按
  // 「候选范围」整体验证（见 traceBatch），否则跨步收口会永久钉死队头。
  for (const unit of units) {
    unit.invocationIds = [...unit.declared, ...unit.calls]
    unit.resultIds = [...unit.results]
    const closure = toolClosureOf({
      invocationIds: unit.invocationIds,
      resultIds: unit.resultIds,
      malformed: unit.malformedDeclaration,
    })
    unit.hasUnfinished = closure.closed !== true
    unit.missingCallIds = closure.missingIds
    unit.orphanCallIds = closure.orphanIds
    delete unit.declared
    delete unit.calls
    delete unit.results
  }
  return units
}

/** 一个 run 的拒绝/开尾诊断（缺结果 / 孤立结果 / 单边留在范围外）。 */
function diagnosticsOf(closure) {
  return {
    callIds: closure?.missingIds,
    orphanCallIds: closure?.orphanIds,
    splitCallIds: closure?.splitIds ?? [],
  }
}

/**
 * 把落在两个步骤单元**之间**的活动面节点归到前一个单元（0.15.1 修）。
 *
 * 真实 DSH 的 pre-step 在上一轮 `step/end` 之后、下一步 `step/start` 之前追加回执，
 * 于是回执既不在 `unit.seqs` 里（`buildStepUnits` 只收「打开的步骤内」的事件），
 * 也不会被 `unit.hasPlugin` 看见——**两步之间的插件节点在选择器眼里根本不存在**。
 * 旧实现把这些节点直接丢给密度判据（`shadowed.length !== wanted.length`），
 * 结果就是「每压一次就有一次 not-dense」：按步归档在真实会话里表现为
 * **压完一批就永久停摆**（回执是 pre-step 追加的，位置恒在两步之间）。
 *
 * 口径与 F1 / AUD51-05-02 一致（回执不吸收、每张凭证的正文都要留在活动面）：
 * - **回注包透明**：并进前一个单元的 surfaceSeqs 一起遮蔽，但不进 recordSeqs；
 * - **回执/恢复、真人消息、其余无记录节点是硬边界**：前一个单元到此收尾，
 *   边界及其之后的整段留在活动面，后续单元另起一个 run（P3 多段提交）。
 *
 * 只读推进、确定：只改传入的 units（调用方刚 map 出来的副本）。
 */
function attachInterStepNodes({ units, surfaceNodes, eventBySeq }) {
  if (units.length === 0) return units
  const ownerBySeq = new Map()
  units.forEach((unit, index) => { for (const seq of unit.surfaceSeqs) ownerBySeq.set(seq, index) })
  const gaps = units.map(() => [])
  let owner = -1
  for (const seq of surfaceNodes) {
    const found = ownerBySeq.get(seq)
    if (found !== undefined) { owner = found; continue }
    // 第一个单元之前的孤点：不在任何 span 里（span 从单元的面上首节点开始），不需要归属。
    if (owner < 0) continue
    gaps[owner].push(seq)
  }
  units.forEach((unit, index) => {
    for (const seq of gaps[index]) {
      // 边界之后的节点整段留在面上：下一个 run 从下个单元起，天然跳过它们。
      if (unit.trailingBoundary !== undefined) break
      const event = eventBySeq.get(seq)
      if (isRecallPackEvent(event)) {
        unit.surfaceSeqs = [...unit.surfaceSeqs, seq]
        unit.transient = [...unit.transient, seq]
        continue
      }
      unit.trailingBoundary = {
        reason: isPluginSurfaceEvent(event) ? 'plugin-boundary'
          : isHumanUserEvent(event) ? 'turn-anchor'
            : 'missing-record',
        seq,
      }
    }
  })
  return units
}

/**
 * 把候选窗口切成 run，并为每个 run 记录**最大闭合前缀**（0..units.length）。
 */
function traceBatch({ eligible, budget, hardCap, toolIndex, pinnedSeqs, hasRecord }) {
  const runs = []
  const blocks = []
  const windowUnits = []
  let current = null
  let turn = null
  let stop = null
  let scanned = 0
  let index = 0
  let headSeq = null
  // 首个硬边界事实（只读诊断）：等待面要说清「为什么还没攒够」时不能被后面的
  // 安全段覆盖成 null（P3 审阅：闸门原因必须如实上报）。
  let firstBoundary = null
  // P1-09：窗口还空时被**只读跳过**的硬边界单元（pin / 插件边界 / 缺记录）。
  const skippedHead = []

  const addUnit = (unit) => {
    if (current === null) {
      current = {
        units: [],
        startSeq: unit.startSeq,
        turn: unit.turn,
        closedCount: 0,
        invocation: new Set(),
        result: new Set(),
        malformed: false,
        closure: null,
      }
    }
    current.units.push(unit)
    for (const id of unit.invocationIds) current.invocation.add(id)
    for (const id of unit.resultIds) current.result.add(id)
    if (unit.malformedDeclaration === true) current.malformed = true
    current.closure = toolClosureOfRange({
      invocationIds: [...current.invocation],
      resultIds: [...current.result],
      malformed: current.malformed,
      index: toolIndex,
      startSeq: current.startSeq,
      endSeq: unit.endSeq,
    })
    // 记录**最大的**已闭合前缀：独立完成的步骤照旧成段；跨步收口则在结果落盘
    // 的那一步补上右端，整段一起遮蔽（不把一侧留在面上）。
    if (current.closure.closed === true) current.closedCount = current.units.length
  }

  const closeRun = (boundary, detail = null) => {
    if (current === null) return
    const run = { ...current, boundary, detail }
    runs.push(run)
    if (run.closedCount < run.units.length) {
      // run 尾部有未闭合的调用：只能提交闭合前缀；开尾原因由后续扩展/拒绝面承担。
      if (run.closedCount === 0) {
        blocks.push({ reason: boundary ?? 'unfinished-tool', ...(detail ?? {}), ...diagnosticsOf(run.closure), seq: run.units[0]?.endSeq })
      } else {
        blocks.push({ reason: 'unfinished-tool', ...diagnosticsOf(run.closure), seq: run.units[run.closedCount]?.endSeq })
      }
    }
    current = null
  }

  // 阶段 1：取最旧的一批候选（budget 个候选；前导用户锚点跳过、不计入窗口）。
  while (index < eligible.length && windowUnits.length < budget && scanned < hardCap) {
    const unit = eligible[index]
    // P1-09（★6）：窗口的左端恒取「最旧候选」，而队头单元一旦本身是硬边界（pin /
    // 插件边界 / 缺记录），旧实现只能 `reject('pinned')`——**它后面的所有安全步永远拿不到**。
    // 周转级有 minStartSeq 游标可以越过，按步级没有，于是 pin 了队头一步就永久停摆。
    //
    // 这里做**有界只读跳过**：只在窗口还空时越过队头硬边界单元（不遮蔽、不写任何东西，
    // 被跳过的单元仍留在活动面，仍由用户/后续策略处理），并把跳过事实写进诊断。
    // 扫描仍受 hardCap 约束，因此跳过次数有上界，不会因「全是保护洞」而失控。
    if (windowUnits.length === 0 && current === null && runs.length === 0) {
      const blockedReason = unit.hasPlugin === true ? 'plugin-boundary'
        : unit.surfaceSeqs.some((seq) => pinnedSeqs.has(seq)) ? 'pinned'
          : unit.surfaceSeqs.some((seq) => !unit.transient.includes(seq) && !hasRecord(seq)) ? 'missing-record'
            : null
      if (blockedReason !== null) {
        // 队头事实仍指向真正的第一个候选（headBlocked 语义不变）。
        if (headSeq === null) headSeq = unit.surfaceSeqs[0]
        skippedHead.push({ reason: blockedReason, turn: unit.turn, startSeq: unit.startSeq, seq: unit.surfaceSeqs[0] ?? null })
        index += 1
        scanned += 1
        continue
      }
    }
    if (turn === null) turn = unit.turn
    else if (unit.turn !== turn) {
      stop = { reason: 'turn-boundary', seq: unit.startSeq }
      if (firstBoundary === null) firstBoundary = 'turn-boundary'
      break
    }
    if (unit.hasHuman) {
      // 真实 DSH 的 user/message 在 step 1 内：前导锚点只跳过，不阻断后续步骤；
      // 一旦窗口里已经有候选，锚点就是不可跨越的硬边界。
      if (windowUnits.length === 0 && runs.length === 0 && current === null) { index += 1; continue }
      stop = { reason: 'turn-anchor', seq: unit.startSeq }
      if (firstBoundary === null) firstBoundary = 'turn-anchor'
      break
    }
    // 队头判据用**活动面**首节点：step/start 不是面节点，段起点会跳过它。
    if (headSeq === null) headSeq = unit.surfaceSeqs[0]
    windowUnits.push(unit)
    index += 1
    scanned += 1
  }

  // 阶段 2：窗口内按硬边界拆 run；洞之后的段继续处理（同批多段，P3）。
  for (const unit of windowUnits) {
    if (unit.hasPlugin) {
      if (firstBoundary === null) firstBoundary = 'plugin-boundary'
      if (current === null && runs.length === 0) blocks.push({ reason: 'plugin-boundary', seq: unit.endSeq })
      closeRun('plugin-boundary')
      continue
    }
    const pinned = unit.surfaceSeqs.filter((seq) => pinnedSeqs.has(seq))
    if (pinned.length > 0) {
      if (firstBoundary === null) firstBoundary = 'pinned'
      if (current === null && runs.length === 0) blocks.push({ reason: 'pinned', seqs: pinned, count: pinned.length })
      closeRun('pinned', { seqs: pinned, count: pinned.length })
      continue
    }
    const missing = unit.surfaceSeqs.filter((seq) => !unit.transient.includes(seq) && !hasRecord(seq))
    if (missing.length > 0) {
      if (firstBoundary === null) firstBoundary = 'missing-record'
      if (current === null && runs.length === 0) blocks.push({ reason: 'missing-record', seqs: missing, count: missing.length })
      closeRun('missing-record', { seqs: missing, count: missing.length })
      continue
    }
    addUnit(unit)
    // 单元与本步之后的活动面节点之间有硬边界（回执/恢复、真人消息、无记录节点）：
    // 本 run 到此收尾，边界之后的步另起一段。回执不吸收（F1/AUD51-05-02）。
    // 边界事实只写 run.boundary / firstBoundary，**不写 blocks**：blocks 的语义是
    // 「这一段提交不了」，而这里收尾的 run 已经完整闭合（与 closeRun 内口径一致）。
    if (unit.trailingBoundary !== undefined) {
      if (firstBoundary === null) firstBoundary = unit.trailingBoundary.reason
      closeRun(unit.trailingBoundary.reason, { seqs: [unit.trailingBoundary.seq], count: 1 })
    }
  }

  // 阶段 3：批尾 run 的调用未闭合时向**后**扩到闭合点（最多到 maxSteps/H 上限）。
  // 不越过任何硬边界（pin/插件/缺记录/回合/锚点）——闭包不能靠跳过保护洞来凑。
  while (current !== null && current.closedCount < current.units.length
    && index < eligible.length && scanned < hardCap) {
    const unit = eligible[index]
    if (turn !== null && unit.turn !== turn) {
      stop = { reason: 'turn-boundary', seq: unit.startSeq }
      if (firstBoundary === null) firstBoundary = 'turn-boundary'
      break
    }
    if (unit.hasHuman) {
      stop = { reason: 'turn-anchor', seq: unit.startSeq }
      if (firstBoundary === null) firstBoundary = 'turn-anchor'
      break
    }
    if (unit.hasPlugin) break
    if (unit.surfaceSeqs.some((seq) => pinnedSeqs.has(seq))) break
    if (unit.surfaceSeqs.some((seq) => !unit.transient.includes(seq) && !hasRecord(seq))) break
    addUnit(unit)
    index += 1
    scanned += 1
    // 新收进来的这一步之后就是硬边界（回执/恢复、真人消息、无记录节点）：闭合到此为止，
    // 边界之后的节点必须留在活动面（否则密度判据会把它算成缺口）。run 在这里就地收尾，
    // 段边界如实报出来（与阶段 2 同一口径）。
    if (unit.trailingBoundary !== undefined) {
      if (firstBoundary === null) firstBoundary = unit.trailingBoundary.reason
      closeRun(unit.trailingBoundary.reason, { seqs: [unit.trailingBoundary.seq], count: 1 })
      break
    }
  }
  if (current !== null) closeRun(null)
  return { runs, blocks, stop, windowUnits, scanned, headSeq, firstBoundary, skippedHead }
}

/**
 * 选出一次可压缩的步骤批次（只由活动面节点组成）。
 *
 * 返回对象顶层是**第一段**的字段（兼容既有单 span 消费者与守卫），并带
 * segments（同批全部安全段，按 seq 升序）。headOnly=true 时只在第一段
 * 从窗口队头开始时返回；否则队头被保护洞挡住也返回洞之后的段（P3 多段语义，
 * 供 application 逐段提交；旧单 span 守卫测试用 headOnly 保留原断言）。
 *
 * @returns {null | object}
 */
export function selectStepSpan({ surfaceNodes, events, hasRecord, retainSteps = 4, scanLimit = STEP_BATCH_MAX, maxSteps = null, batchSteps = STEP_BATCH_DEFAULT, bypassBatch = false, headOnly = false, pinnedSeqs = new Set(), minStartSeq = -1, onReject = null } = {}) {
  // 拒绝出口与回合级同形（0.14.0-beta.45）：契约仍是 null，原因只走观察回调。
  const reject = (row) => {
    // 兼容传裸字符串的调用点：原因码永远不丢（宁可归一化，也不让 UI 印出 undefined）。
    const rejection = typeof row === 'string' ? { reason: row } : row
    if (typeof onReject === 'function') {
      try { onReject(rejection) } catch { /* 观察面不得左右判据 */ }
    }
    return null
  }
  if (!Array.isArray(surfaceNodes) || !Array.isArray(events)) {
    throw new V3ContractViolation('v3 archive/steps: surfaceNodes/events 必须是数组')
  }
  if (typeof hasRecord !== 'function') throw new V3ContractViolation('v3 archive/steps: hasRecord 必须是函数')
  const onSurface = new Set(surfaceNodes)
  // 闭包索引（callId → 声明/调用/结果所在 seq）：用来证明候选范围没有把一次调用
  // 拆到范围外。步骤选择本来就要整表切步骤，这里同量级一次遍历。
  const toolIndex = createToolCallIndex()
  for (const event of events) indexToolCallEvent(toolIndex, event)
  const units = buildStepUnits(events)
    .filter((unit) => unit.complete === true)
    .map((unit) => ({ ...unit, surfaceSeqs: unit.seqs.filter((seq) => onSurface.has(seq)) }))
    .filter((unit) => unit.surfaceSeqs.length > 0)
  if (units.length === 0) return reject({ reason: 'no-completed-step' })
  // 两步之间的活动面节点（真实宿主的 pre-step 回执恒落在这里）必须归到前一个单元，
  // 否则密度判据必然失败——见 attachInterStepNodes 的说明。
  const eventBySeq = new Map()
  for (const event of events) if (Number.isInteger(event?.seq)) eventBySeq.set(event.seq, event)
  attachInterStepNodes({ units, surfaceNodes, eventBySeq })
  const keep = Math.max(1, Number.isInteger(retainSteps) ? retainSteps : 4)
  // scanLimit（P3 合同 H=200）：单次扫描的窗口外步骤上限，避免超长会话把选择器拖成无界扫描。
  const scan = Math.max(1, Math.min(Number.isInteger(scanLimit) && scanLimit >= 1 ? scanLimit : STEP_BATCH_MAX, STEP_BATCH_MAX))
  const outsideWindow = units.slice(0, Math.min(Math.max(0, units.length - keep), scan))
  const batch = normalizeStepBatch(batchSteps)
  // 候选列表是否被 scanLimit（H=200）截断：截断时闭合缺口不能冒充「安全短批」，
  // 也不能无限等待——尾段的 reachedLimit 由 blocked 如实报出（P3 policy 合同）。
  const truncated = Math.max(0, units.length - keep) > outsideWindow.length
  const eligible = outsideWindow.filter((unit) => unit.startSeq > minStartSeq)
  if (eligible.length === 0) return reject({ reason: 'retention-window', retained: units.length })
  // 阈值决定「什么时候压」：窗口外候选（含保护洞）攒够 batch 才提交。显式动作绕闸门。
  // 诊断口径（P3）：batch = 已落出窗口的候选数（闸门分子），closedSteps = 其中可安全
  // 归档的步数（跨 run 合计，保护洞不计）。旧实现只报第一段，保护洞后会误导「还差」。
  const gateOpen = bypassBatch === true || outsideWindow.length >= batch
  if (!gateOpen) {
    // 等待面只读、无副作用：算一次窗口内可安全归档的步数与首个受阻原因，供 status 如实显示。
    const diag = traceBatch({ eligible, budget: eligible.length, hardCap: scan, toolIndex, pinnedSeqs, hasRecord })
    const closedSteps = diag.runs.reduce((sum, run) => sum + run.closedCount, 0)
    const boundary = diag.firstBoundary ?? diag.blocks[0]?.reason ?? diag.stop?.reason ?? null
    return reject({
      reason: 'waiting-batch',
      threshold: batch,
      batch: eligible.length,
      closedSteps,
      needed: Math.max(0, batch - eligible.length),
      eligible: outsideWindow.length,
      scanned: outsideWindow.length,
      boundary,
      // 只在真的发生跳过时带诊断字段：off 路径的等待面必须与 HEAD 逐字节一致（G5 指纹守卫）。
      ...(diag.skippedHead.length > 0 ? { skippedHeads: diag.skippedHead } : {}),
      reachedLimit: false,
    })
  }
  // 窗口 = 最旧的一批候选：自动/预览受阈值约束；显式动作可绕阈值，但仍受 H=200 上限。
  // maxSteps 是调用方显式硬上限（同时限制窗口与闭包扩展），R06「被 maxSteps 切开 → 拒绝」。
  const hardCap = Number.isInteger(maxSteps) && maxSteps >= 1 ? Math.min(maxSteps, scan) : scan
  const budget = bypassBatch === true
    ? hardCap
    : (Number.isInteger(maxSteps) && maxSteps >= 1 ? Math.min(maxSteps, batch) : batch)
  const trace = traceBatch({ eligible, budget, hardCap, toolIndex, pinnedSeqs, hasRecord })
  const segments = []
  for (const run of trace.runs) {
    const closedCount = run.closedCount
    if (closedCount === 0) continue
    const chosen = run.units.slice(0, closedCount)
    const wanted = chosen.flatMap((unit) => unit.surfaceSeqs)
    const startSeq = wanted[0]
    const endSeq = wanted[wanted.length - 1]
    const foundIdx = surfaceNodes.indexOf(startSeq)
    const endIdx = surfaceNodes.indexOf(endSeq)
    if (foundIdx === -1 || endIdx === -1 || foundIdx > endIdx) {
      trace.blocks.push({ reason: 'not-dense', seqs: [startSeq, endSeq] })
      continue
    }
    const shadowed = surfaceNodes.slice(foundIdx, endIdx + 1)
    // 必须密集覆盖且顺序一致：宿主 range replace 的硬前提，也保证不会吞掉锚点。
    if (shadowed.length !== wanted.length || shadowed.some((seq, index) => seq !== wanted[index])) {
      trace.blocks.push({ reason: 'not-dense', seqs: [startSeq, endSeq] })
      continue
    }
    const transient = new Set(chosen.flatMap((unit) => unit.transient))
    const recordSeqs = shadowed.filter((seq) => !transient.has(seq))
    if (recordSeqs.length === 0) {
      trace.blocks.push({ reason: 'empty-records', seqs: shadowed, count: shadowed.length })
      continue
    }
    // 0.14.0-beta.53（AUD51-05-02）：按步归档同样**不吸收**上一张回执——回执是硬边界，
    // span 从它之后开始；每张凭证的正文都留在活动面，restore 才找得到。
    segments.push({
      startSeq,
      endSeq,
      sourceEventSeqs: shadowed,
      recordSeqs,
      operations: chosen.length,
      steps: chosen.length,
      // P3 合同：返回闭合前缀与边界事实，供 policy/application 计算「最旧安全前缀」。
      closedPrefix: chosen.length,
      closedEndSeq: endSeq,
      threshold: batch,
      boundary: run.boundary,
      reachedLimit: false,
      shortRunFlush: chosen.length < batch,
    })
  }
  // blocked：批内第一个「不能提交」的原因（队头的保护洞/开尾，或批尾未闭合调用）。
  // 它为 null 表示整批候选都已成段；status 只在需要时显示。
  let reachedLimit = false
  if (segments.length === 0) {
    // 一段都没有：原样拒绝（与旧单 span 判据同形，诊断字段不丢）。窗口全被前导锚点
    // 跳空的极端形状也要在这里收口，不能返回一个 startSeq=undefined 的「成功」对象。
    // P1-09：一段都没有，但队头有被跳过的硬边界单元 → 如实报它（而不是笼统 no-candidate），
    // 同时给出跳过条数：观察面能区分「全是保护洞」与「真的没有候选」。
    return reject(trace.blocks[0] ?? trace.stop
      ?? (trace.skippedHead.length > 0
        ? { reason: trace.skippedHead[0].reason, skipped: trace.skippedHead.length, skippedHeads: trace.skippedHead }
        : { reason: 'no-candidate' }))
  }
  const lastRun = trace.runs[trace.runs.length - 1] ?? null
  const tailOpen = lastRun !== null && lastRun.closedCount < lastRun.units.length
  if (tailOpen && (truncated || trace.scanned >= hardCap)) {
    reachedLimit = true
    const limitBlock = { reason: 'tool-closure-exceeds-limit', reachedLimit: true, ...diagnosticsOf(lastRun.closure) }
    // 尾段的开尾原因优先报 reachesLimit（它比泛化的 unfinished-tool 更能解释
    // 「被 H=200 截断」）；前面还有队头阻塞原因时保留队头（更有行动价值）。
    if (trace.blocks.length === 0 || trace.blocks[0].reason === 'unfinished-tool') trace.blocks[0] = limitBlock
    else if (!trace.blocks.some((row) => row.reason === 'tool-closure-exceeds-limit')) trace.blocks.push(limitBlock)
  }
  const blocked = trace.blocks[0] ?? null
  const first = segments[0]
  const headBlocked = first === undefined || (trace.headSeq !== null && first.startSeq !== trace.headSeq)
  if (headOnly === true && headBlocked) {
    // 旧单 span 视图：队头不可归档就返回 null（后续段由多段 API 负责）。
    return reject(blocked ?? trace.stop ?? { reason: 'no-candidate' })
  }
  return {
    ...first,
    // 同批全部安全段（旧单 span 消费者只读顶层字段；application 逐段提交）。
    segments,
    totalSteps: segments.reduce((sum, segment) => sum + segment.steps, 0),
    threshold: batch,
    eligible: outsideWindow.length,
    scanned: outsideWindow.length,
    truncated,
    reachedLimit,
    blocked,
    headBlocked,
    // P1-09：本次选择**只读越过**的队头硬边界单元（未遮蔽、未改动，仍在活动面）。
    // 只有发生跳过时才出现这些字段：未跳过的路径（含 off 路径）保持与 HEAD 逐字节一致。
    ...(trace.skippedHead.length > 0 ? { skippedHeads: trace.skippedHead, headSkipped: trace.skippedHead.length } : {}),
    stop: trace.stop,
    scanLimit: scan,
  }
}
