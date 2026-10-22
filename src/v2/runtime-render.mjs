/**
 * v2 命令面的纯渲染器（0.13.1 P4a）。
 *
 * 从 `runtime.mjs` 摘出的原因：这四个函数**只读参数**（`record` 与 `extra`），
 * 不碰闭包里的任何可变状态（records / factories / engine / logger）。因此它们
 * 可以零风险迁出——不需要注入、不会引入装配顺序问题，也不会改变任何行为。
 *
 * 行为契约：输出逐字节与迁出前相同。任何需要读闭包状态的渲染都必须留在
 * `runtime.mjs`，不要往这里加。
 */

export function rangeTokenOf(range) {
  if (!range || typeof range !== 'object') return null
  const start = Number.isInteger(range.start) ? range.start : null
  const end = Number.isInteger(range.end) ? range.end : null
  if (start === null || end === null) return null
  return `${start}-${end} ${start}–${end} seq:${start}-${end}`
}

/**
 * 把 inline.range 渲染成人读得懂的一列。
 *
 * range 在记录里是 `{start,end}` 对象（真实跨度的形状），历史列表里直接插值会
 * 变成 `[object Object]`。非对象/非法的值一律如实标未知，不猜。
 */
export function formatRange(range) {  if (!range || typeof range !== 'object') return ''
  const start = Number.isInteger(range.start) ? range.start : null
  const end = Number.isInteger(range.end) ? range.end : null
  if (start === null || end === null) return ' 范围=未知'
  return ` 范围=${start}–${end}`
}

export function renderV2Status(record, extra = {}) {
  const settings = record.state.settings ?? {}
  const applied = record.state.archive.filter((row) => row.status === 'applied').length
  // 单列 `verify-failed`：它和 `applied` 一样遮蔽了原文（原文只在冷库），
  // 但替换后的活动面没通过校验。并进 `applied` 会虚报已归档段数。
  const verifyFailed = record.state.archive.filter((row) => row.status === 'verify-failed').length
  const restored = record.state.archive.filter((row) => row.status === 'restored').length
  const lines = [
    `v2 引擎：${record.state.enabled ? '已启用' : '已停用'}${record.state.fullHistory === true ? '（全历史记忆上下文）' : ''}`,
    `会话：${record.sessionId}`,
    `隔离根：${record.directory}`,
    // R-03（beta.4）：三个开关都在面板上，状态行必须三个都印——只印 auto/recall 时，
    // 「off 到底会不会恢复原文」用户只能去猜（autoRestore 决定停用时是否把原文放回）。
    `设置：auto=${settings.auto ? 'on' : 'off'} recall=${settings.autoRecall ? 'on' : 'off'} `
      + `restore=${settings.autoRestore ? 'on' : 'off'} `
      + `batch=${settings.archiveBatchSize} retain=${record.state.fullHistory === true ? `${settings.retainOperations}（全历史模式下失效）` : settings.retainOperations}`,
    `账本：已归档 ${applied} 段，已恢复 ${restored} 段`
      + (verifyFailed ? `，校验未通过 ${verifyFailed} 段（原文只在冷库，可 restore 取回）` : ''),
    // 抑制实况必须出现在 status 里（0.13.2 D-04）：删 v1 时「真实灵枢抑制」那一行
    // 一起没了，于是「抑制 0 次」与「抑制根本没装上」在用户面前无法区分。
    `真实灵枢抑制：${record.suppression?.available === true
      ? '已启用（本会话对真实灵枢的自动读写被拦截）'
      : `未启用（${record.suppression?.reason ?? '原因未知'}）；真实灵枢的自动读写未被拦截`}`,
  ]
  if (record.state.lastMeasurement) {
    const m = record.state.lastMeasurement
    lines.push(`最近测量：≈${m.assembledTokens ?? '?'} token / 窗口 ${m.contextWindow ?? '?'}，动作 ${m.action ?? '?'}`)
  }
  if (record.state.lastAction) lines.push(`最近动作：${record.state.lastAction}`)
  if (extra.records !== undefined) lines.push(`v2 记录数：${extra.records}`)
  if (extra.openPairs !== undefined) lines.push(`在途工具配对：${extra.openPairs}`)
  if (extra.workingSet) {
    lines.push(`工作状态：≈${extra.workingSet.usedTokens} token（卡片内部口径，4 字节≈1 token；注入记账走宿主 meter）`
      + ` / 预算 ${extra.workingSet.budgetTokens}`
      + (extra.workingSet.dropped?.length ? `（因预算丢弃 ${extra.workingSet.dropped.length} 段）` : ''))
  }
  if (extra.cost) {
    // 「缓存失效」插件观测不到：写 unknown，不写 0 —— 0 会被读成「没有失效」，
    // 那是我们无权断言的事实。替换次数是我们的动作，单独列出。
    lines.push(`成本计数：冷库写入 ${extra.cost.memoryWrites} 次 / 记录 ${extra.cost.recordsWritten} 条 / `
      + `历史替换 ${extra.cost.historyReplacements} 段 / 证据重读 ${extra.cost.evidenceReReads} 次 / `
      + `辅助模型调用 ${extra.cost.extraModelCalls} 次`)
    lines.push('供应商前缀缓存失效次数：未知（插件观测不到宿主/供应商的缓存行为，不冒充 0）')
  }
  // C3/O3：最近一个观测窗口的批前后 usage 对比（只观测，不宣称因果）。
  const settled = record.state?.usageWatch?.settled ?? null
  if (settled && Number.isFinite(settled.deltaTokens)) {
    const pct = (ratio) => (Number.isFinite(ratio) ? `${(ratio * 100).toFixed(1)}%` : '未知')
    lines.push(`批前后观测（${settled.at}）：批 ${settled.batchReplacements ?? '?'} 段替换后，最近请求未命中 +≈${settled.deltaTokens} token`
      + `（命中率 ${pct(settled.beforeHitRatio)} → ${pct(settled.afterHitRatio)}；含并发因素，仅量级参考）`)
  }
  if (extra.readLedger?.length) lines.push(...extra.readLedger)
  if (extra.retrieval) lines.push(...extra.retrieval)
  if (extra.warnings?.length) lines.push(`告警：${extra.warnings.join('；')}`)
  return lines.join('\n')
}

/**
 * 回读结果渲染。
 *
 * 每段都带「冷库历史原文」抬头，并且明确写出它**不是**什么：不是新的授权、
 * 不是对文件当前状态的观察。历史记录里的内容（哪怕是「允许」「已批准」这类
 * 字样，或某个文件当时的内容）都只是当时发生过的原文，不构成当前许可。
 * 完整性=ok 只说明载荷与登记哈希一致，不是事实核验。
 */
export function renderReadResults(results) {
  const blocks = []
  for (const item of results) {
    if (!item.ok) {
      blocks.push(`【${item.id}】读取失败：${item.error}`)
      continue
    }
    const head = `【${item.id}】冷库历史原文｜${item.kind ?? ''} 保真=${item.fidelity ?? '?'} `
      + `完整性=${item.integrity ?? 'ok'} 字节=${item.bytes ?? '?'}`
    const note = '（这是已归档的当时原文，不是新授权、也不是对文件当前状态的观察）'
    const via = item.resolvedVia === 'fork-map' ? `\n（经 fork 映射自 ${item.requestedId}）` : ''
    const viaAlias = item.resolvedVia === 'node-alias' || item.resolvedVia === 'call-id'
      ? `\n（经 ${item.resolvedVia} 别名解析自 ${item.requestedId}；span 分块已按 chunk 序合并，配对记录为来源索引）`
      : ''
    // 人工失效标记的注记（mark-stale 写入旁证；内容级失效用 verify 命令裁决）。
    const stale = item.staleReason ? `\n⚠ 该记录已被人工标记为失效（${item.staleReason}）；引用前请先 /memory-lab verify。` : ''
    blocks.push(`${head}${note}${via}${viaAlias}${stale}\n${item.text}`)
  }
  return blocks.join('\n\n')
}
