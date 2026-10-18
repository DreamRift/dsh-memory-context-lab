/**
 * v2 成本账本（规范 §7）。
 *
 * 只记可观测的确定性计数，不估算金钱、不把 token 下降当收益：
 * 规范明确要求「质量与成本分别验收」，所以这里只负责**如实记账**，
 * 由验收方去和任务成功率对照。
 *
 * 硬边界：v2 首版不调用任何辅助模型（guard 只读宿主事件结构、
 * working-state 只做确定性提取），因此 `extraModelCalls` 必须恒为 0。
 * 一旦将来引入辅助模型，必须新增计数器并在这里显式登记，
 * 不允许用「没有记录」冒充「没有成本」。
 */

export const COST_COUNTER_KEYS = Object.freeze([
  /** 辅助模型调用次数（v2 首版必须为 0）。 */
  'extraModelCalls',
  /** 辅助模型消耗 token。 */
  'extraModelTokens',
  /** 冷库写入次数（每次提交一批降温 = 1 次写入）。 */
  'memoryWrites',
  /** 记录数写入量。 */
  'recordsWritten',
  /**
   * 本插件**自己**替换掉的历史段数。
   *
   * 注意口径：这是我们的替换次数，**不是**供应商前缀缓存的失效次数——宿主/供应商
   * 实际失效了多少，插件观测不到。该指标一律标 unknown，不得用替换次数冒充。
   */
  'historyReplacements',
  /** 供应商前缀缓存失效次数：插件无法观测，恒为 0 且报告里标 unknown。 */
  'cacheInvalidations',
  /** 证据重读次数（退出热上下文后再次按 ID 回读）。 */
  'evidenceReReads',
  /**
   * 按 ID 回读的三路拆分（0.12.0 P0-1）。
   *
   * 修复前只有一个 `evidenceReReads`，把「按 ID 回读」与「重读文件」混在一起，
   * 于是插件以为自己「回读 0 次」——真实会话 303 步里工具回读 0 次、文件重读 55 次，
   * 账本却只有一个含混的数。三路**互不覆盖**：
   * - `toolRecallReads`：模型可见工具 `memory_lab_recall` 的回读；
   * - `commandRecallReads`：命令面 `/memory-lab2 read` 的回读（人用的那条）；
   * - `fileReReads`：同键文件重读（同一个 path|offset 被再次归档）。
   */
  'toolRecallReads',
  /** 命令面回读次数（与 toolRecallReads 互不覆盖）。 */
  'commandRecallReads',
  /** 同键文件重读次数（读取账本判定，不拦截、不改写工具行为）。 */
  'fileReReads',
  /** 同键文件重读带进来的字符数（口径 A 的分子，可复算）。 */
  'fileReReadChars',
  /** 卡片折叠批次数（P0-4：独立成批，不占用操作批的 countable）。 */
  'cardFoldBatches',
  /** 净占用已超上限、但活动面上没有可折叠连续卡组的步数（如实报告上界未达成）。 */
  'cardCapUnreached',
  /** 证据重读带回的 token 估算（重读不是免费：这部分要计入成本）。 */
  'evidenceReReadTokens',
  /** 召回请求次数（命令面与模型可见工具面合并计数）。 */
  'recallReads',
  /** 召回实际带回热上下文的 token 估算（含元数据、包装与告警）。 */
  'recallReturnedTokens',
  /**
   * 有界工作状态注入次数（全量 + 增量合计）。
   *
   * 口径（S3 三态分离后）：只有宿主确认过的注入才计入（= committed）。
   * prepared / committed / sent 三态分别由下面三个计数器对账。
   */
  'workingStateInjections',
  /**
   * S3 三态之一：prepare 出载荷但**尚未获得宿主确认**的次数。
   *
   * 每次成功 prepare 计 1（确认时不再重复计）。abort / 宿主拒绝的注入
   * 只留在这个计数器里——「跑过但没注入」不是「注入了」，成本报表必须
   * 能把这部分残差单独读出来。
   */
  'workingStatePrepared',
  /**
   * S3 三态之二：宿主确认（confirmInjection）过的注入次数。
   *
   * 与 workingStateInjections（committed 口径）相等是健康不变量；两者
   * 分开保留是为了让「确认」这一步在账本上可审计。
   */
  'workingStateCommitted',
  /**
   * S3 三态之三：确认后宿主 meter 成功计量的注入次数。
   *
   * meter 不可用的确认计入 workingStateTokensUnmetered，不折算混记
   * （D5 纪律）：sent ≤ committed 是结构事实，不是抽样。
   */
  'workingStateSent',
  /** 全量状态卡注入次数（会话首张 + 周期性再锚定）。 */
  'workingStateFullInjections',
  /** 增量状态卡注入次数（只带相对上一张全量卡的变化行）。 */
  'workingStateDeltaInjections',
  /**
   * 有界工作状态注入的 token 计量（宿主 meter 口径）。
   *
   * 口径纪律（D5）：这里与归档侧的 originalTokens 用**同一把尺子**——宿主
   * tokenMeter 的 estimateMessage。修复前这里记的是卡片内部预算口径
   * （`estimateTokensOf`，4 字节≈1 token），中文场景比宿主 meter 高约 2 倍：
   * 实测同一批卡片注入侧 429,145 token、归档侧 213,247 token，比值 2.01，
   * 成本报表对不上账。卡片**内部装包预算**仍可用内部口径（那只是控制参数），
   * 但对外记账只认宿主 meter。
   */
  'workingStateTokens',
  /**
   * 注入时宿主 meter 不可用的次数：这些注入的 token **未入账**。
   *
   * 不按卡片内部口径折算混记——两种口径进同一个计数器正是 D5 的病根；
   * 记不出就如实留缺口，报表把缺口单独列出来。
   */
  'workingStateTokensUnmetered',
  /** 因预算不足而丢弃的工作状态段数。 */
  'workingStateDrops',
  /** 工具配对护栏拦下的降温候选数。 */
  'guardRejections',
  /**
   * 观测到的批前后 usage 差额累计（C3/O3）。
   *
   * 口径：每批提交时取最近完成请求的 usage 作基线，下一批提交时若出现更新的
   * usage 样本，把 input 差额（负数记 0）累计进来。**只观测不宣称因果**：差额
   * 包含宿主自身压缩、其他注入等并发因素，是量级参考与回归对比基线，不是
   * 「插件造成的前缀失效」。观测不到时保持 0——「没有样本」不等于「没有失效」。
   */
  'observedInvalidationTokens',
])

export function emptyCostCounters() {
  const counters = {}
  for (const key of COST_COUNTER_KEYS) counters[key] = 0
  return counters
}

/** 规范化：只保留已知键，负数与 NaN 归零，未知键丢弃（不静默膨胀 schema）。 */
export function normalizeCostCounters(raw) {
  const counters = emptyCostCounters()
  if (raw && typeof raw === 'object') {
    for (const key of COST_COUNTER_KEYS) {
      const value = Number(raw[key])
      counters[key] = Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
    }
  }
  return counters
}

export function createCostLedger(initial = {}) {
  const counters = normalizeCostCounters(initial)
  return {
    bump(key, by = 1) {
      if (!COST_COUNTER_KEYS.includes(key)) throw new Error(`未知成本计数键：${key}`)
      const amount = Number(by)
      if (!Number.isFinite(amount) || amount < 0) throw new Error(`成本计数增量非法：${by}`)
      counters[key] += Math.floor(amount)
      return counters[key]
    },
    add(partial = {}) {
      for (const [key, value] of Object.entries(partial)) {
        if (value) this.bump(key, value)
      }
      return { ...counters }
    },
    snapshot() {
      return { ...counters }
    },
    reset() {
      for (const key of COST_COUNTER_KEYS) counters[key] = 0
      return { ...counters }
    },
  }
}

export function mergeCostCounters(...snapshots) {
  const merged = emptyCostCounters()
  for (const snapshot of snapshots) {
    const normalized = normalizeCostCounters(snapshot)
    for (const key of COST_COUNTER_KEYS) merged[key] += normalized[key]
  }
  return merged
}

/** 人类可读报告：逐项列出，并显式声明哪些项在本版恒为 0 及原因。 */
export function renderCostReport(counters, { sessionId = null } = {}) {
  const value = normalizeCostCounters(counters)
  const lines = [
    'v2 成本观测（只记确定性计数，不代表效果）：',
    `- 冷库写入次数：${value.memoryWrites}`,
    `- 写入记录数：${value.recordsWritten}`,
    `- 本插件替换的历史段数：${value.historyReplacements}`,
    `- 供应商前缀缓存失效次数：unknown（宿主/供应商侧观测，插件看不到，不用替换次数冒充）`,
    `- 证据重读次数：${value.evidenceReReads}（带回 ≈${value.evidenceReReadTokens} token）`,
    `- 回读三路：工具 memory_lab_recall ${value.toolRecallReads} 次 / 命令面 ${value.commandRecallReads} 次 / 同键文件重读 ${value.fileReReads} 次（${value.fileReReadChars} 字）`,
    `- 召回请求次数：${value.recallReads}（带回 ≈${value.recallReturnedTokens} token，含元数据/包装/告警）`,
    `- 工作状态注入：${value.workingStateInjections} 次，≈${value.workingStateTokens} token（宿主 meter 口径，与归档侧同一把尺子）`,
    ...(value.workingStatePrepared > value.workingStateCommitted
      ? [`- 注入三态对账：prepared ${value.workingStatePrepared} / committed ${value.workingStateCommitted} / sent ${value.workingStateSent}（差值 = 准备后未获宿主确认的残差，不算注入）`]
      : []),
    ...(value.workingStateFullInjections > 0 || value.workingStateDeltaInjections > 0
      ? [`- 其中全量卡 ${value.workingStateFullInjections} 次 / 增量卡 ${value.workingStateDeltaInjections} 次（增量卡只带相对上一张全量卡的变化行）`]
      : []),
    ...(value.workingStateTokensUnmetered > 0
      ? [`- 工作状态注入未计量：${value.workingStateTokensUnmetered} 次（注入时宿主 meter 不可用，未折算、不冒充计数）`]
      : []),
    `- 工作状态因预算丢弃段数：${value.workingStateDrops}`,
    `- 工具配对护栏拦截次数：${value.guardRejections}`,
    `- 批前后 usage 差额累计：≈${value.observedInvalidationTokens} token（观测口径：批提交前后两次已完成请求的 input 差额，含宿主压缩等并发因素，只作量级参考，不宣称因果）`,
    `- 辅助模型调用次数：${value.extraModelCalls}（首版不调用辅助模型，恒为 0）`,
    `- 辅助模型 token：${value.extraModelTokens}（同上）`,
  ]
  if (sessionId) lines.push(`会话：${sessionId}`)
  lines.push('本报告不含任务成功率；未做真实任务对照前不得据此宣称效果或成本改善。')
  return lines.join('\n')
}
