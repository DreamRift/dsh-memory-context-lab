/**
 * 压力闸门（0.13.0）：把「什么时候降温」从无条件改成压力驱动。
 *
 * ## 为什么要有它
 *
 * 实测会话（session-c5af11b4，246 步）：上下文占用全程 8.3%–13.5%（中位 42,422 /
 * 窗口 512,000），插件仍然每 2.7 步做一次前缀替换——23 批归档 + 69 次折叠 =
 * 92 次失效，实测失效溢价 103,083 个未命中 token。而被释放的 290,458 token
 * 本来按缓存价读（命中率 85.9%），是最便宜的那部分。
 *
 * 结论：**低占用时降温是净亏**。省下的是缓存读，花掉的是未命中输入。
 * Chroma 的 Context Rot 也说明收益是渐进的——只在真正长上下文里才成立。
 *
 * ## 为什么是滞回而不是单阈值
 *
 * 单阈值会在阈值附近抖动：归档→占用下降→停止→增长→归档，每轮都付一次
 * 失效溢价。这里用**双阈值 + 动态死区**（智能论 3.4 §2.7.2）：
 *
 *     进入 = enter
 *     退出 = enter − max(floor, 3σ)
 *
 * σ 取最近 N 次占用率的标准差，floor 保证样本不足时也有最小死区。
 *
 * ## 为什么还有净收益判据
 *
 * 压力只回答「上下文是否紧张」，不回答「这一批划不划算」。§5.3 的目标函数
 * 是 `π* = argmax[ΣValue − λ·K_π]`，K_π 含失效溢价与导航税。所以开闸后还要
 * 过一次净收益：预计释放 × 缓存读价 > 失效溢价 + 导航税代理。
 *
 * 纯函数：不读时钟、不碰 IO、不做统计以外的推断。所有输入由调用方给。
 */

/** 闸门默认值。0 表示「无压力也降温」（旧行为）。 */
export const PRESSURE_DEFAULTS = Object.freeze({
  /** 进入降温的占用率阈值（百分比，0–95）。 */
  enterPercent: 20,
  /** 最小死区（百分点）：样本不足时的下限。 */
  minHysteresisPercent: 5,
  /** 动态死区的 σ 倍数（智能论 2.7.2：3σ）。 */
  sigmaMultiplier: 3,
  /** σ 的样本窗口。 */
  sigmaWindow: 30,
  /** 死区上限（百分点）：防止 σ 过大导致永不退出。 */
  maxHysteresisPercent: 20,
})

/**
 * 占用率（百分比）。窗口或估算不可用时返回 null——**不猜**。
 *
 * @param {{assembledTokens?: number, contextWindow?: number}} host
 * @returns {number|null}
 */
export function occupancyPercentOf(host) {
  const assembled = Number(host?.assembledTokens)
  const window = Number(host?.contextWindow)
  if (!Number.isFinite(assembled) || !Number.isFinite(window) || window <= 0) return null
  return Math.max(0, Math.min(100, (assembled / window) * 100))
}

/**
 * 动态死区：max(floor, 3σ)，上限 cap。
 *
 * @param {number[]} recentPercents 最近的占用率样本（百分比）
 * @returns {number} 死区百分点
 */
export function hysteresisPercentOf(recentPercents, {
  minHysteresisPercent = PRESSURE_DEFAULTS.minHysteresisPercent,
  sigmaMultiplier = PRESSURE_DEFAULTS.sigmaMultiplier,
  sigmaWindow = PRESSURE_DEFAULTS.sigmaWindow,
  maxHysteresisPercent = PRESSURE_DEFAULTS.maxHysteresisPercent,
} = {}) {
  const samples = (Array.isArray(recentPercents) ? recentPercents : [])
    .filter((value) => Number.isFinite(value))
    .slice(-Math.max(1, sigmaWindow))
  if (samples.length < 2) return minHysteresisPercent
  const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length
  const variance = samples.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (samples.length - 1)
  const sigma = Math.sqrt(variance)
  const dynamic = Math.max(minHysteresisPercent, sigmaMultiplier * sigma)
  return Math.min(maxHysteresisPercent, dynamic)
}

/**
 * 闸门裁决（纯函数）。
 *
 * @param {object} input
 * @param {number} input.occupancyPercent 当前占用率；null = 不可判定
 * @param {boolean} input.coolingOn 上一次的闸门状态（用于滞回）
 * @param {number} input.enterPercent 进入阈值（0 = 关闭闸门，恒开）
 * @param {number[]} [input.recentPercents] 最近占用率样本
 * @returns {{open: boolean, reason: string, exitPercent: number, hysteresis: number}}
 */
export function decidePressureGate({
  occupancyPercent,
  coolingOn = false,
  enterPercent = PRESSURE_DEFAULTS.enterPercent,
  recentPercents = [],
} = {}) {
  const enter = Number.isFinite(Number(enterPercent)) ? Math.max(0, Math.min(95, Number(enterPercent))) : PRESSURE_DEFAULTS.enterPercent
  const hysteresis = hysteresisPercentOf(recentPercents)
  const exit = Math.max(0, enter - hysteresis)

  // 0 = 无压力也降温（旧行为）。这是显式的用户选择，不是缺省。
  if (enter <= 0) {
    return { open: true, reason: 'gate-disabled', exitPercent: 0, hysteresis }
  }
  // 判定不出占用率时**不猜**：关闭闸门，并如实报告原因（失败关闭）。
  if (occupancyPercent === null || !Number.isFinite(occupancyPercent)) {
    return { open: false, reason: 'pressure-unknown', exitPercent: exit, hysteresis }
  }
  if (coolingOn) {
    // 已在降温中：只有掉到 exit 以下才停（滞回）。
    return occupancyPercent < exit
      ? { open: false, reason: 'below-exit', exitPercent: exit, hysteresis }
      : { open: true, reason: 'above-exit', exitPercent: exit, hysteresis }
  }
  return occupancyPercent >= enter
    ? { open: true, reason: 'above-enter', exitPercent: exit, hysteresis }
    : { open: false, reason: 'below-enter', exitPercent: exit, hysteresis }
}

/**
 * 净收益判据（纯函数）。
 *
 * 保守估计：释放的 token 按**缓存读价**计收益（最便宜的那部分），失效溢价按
 * 「替换点之后的上下文重算」计成本。只有收益严格大于成本才放行。
 *
 * 任何一项不可判定 → 返回 `unknown: true`，由调用方决定（当前策略：放行，
 * 因为压力已经确认，此时不降温的代价是窗口溢出）。这一取舍写在文档里，
 * 不假装它是精确经济学。
 *
 * @param {object} input
 * @param {number} input.releaseTokens 预计释放
 * @param {number} input.invalidationTokens 预计失效溢价（替换点之后的组装量）
 * @param {number} [input.navigationTaxTokens] 导航税代理（近期回读/重读量）
 * @param {number} [input.cacheReadDiscount] 缓存读相对未命中的折扣（0–1）
 * @returns {{profitable: boolean|null, reason: string}}
 */
export function decideNetBenefit({
  releaseTokens,
  invalidationTokens,
  navigationTaxTokens = 0,
  cacheReadDiscount = 0.1,
} = {}) {
  const release = Number(releaseTokens)
  const invalidation = Number(invalidationTokens)
  if (!Number.isFinite(release) || !Number.isFinite(invalidation)) {
    return { profitable: null, reason: 'net-benefit-unknown' }
  }
  const tax = Number.isFinite(Number(navigationTaxTokens)) ? Math.max(0, Number(navigationTaxTokens)) : 0
  const discount = Number.isFinite(Number(cacheReadDiscount)) ? Math.max(0, Math.min(1, Number(cacheReadDiscount))) : 0.1
  const benefit = release * discount
  const cost = invalidation + tax
  if (benefit > cost) return { profitable: true, reason: 'benefit-exceeds-cost' }
  return { profitable: false, reason: 'benefit-below-cost' }
}
