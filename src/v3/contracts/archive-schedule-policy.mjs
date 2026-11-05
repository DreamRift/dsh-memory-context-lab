/**
 * 归档调度候选（G5）的**配置合同**：门槛集中一处、默认关闭、非法值失败关闭。
 *
 * ## 这份文件回答什么
 * 开发流程 §11（G5）要求「需要的新增门槛集中在一处配置」，并且「候选通过独立开关启用、
 * 默认关闭」。实现分散在设置页/入口/application 时，最容易出现两套上限、两套默认值，
 * 以及「配置写错但看起来生效」——所以这里只做三件事：
 *
 * 1. **默认值**（`DEFAULTS`，模块内唯一一份）：`enabled: false`，即默认完全关掉候选；
 * 2. **取值域**（`BOUNDS`，与默认值同处一处）：每个门槛的上下界与整数性；
 * 3. **归一化 + 校验**（`normalizeSchedulePolicyConfig`）：字段封闭、类型封闭，
 *    **任何非法值都返回 `{ok:false}`**，调用方据此让候选保持关闭（回退原策略），
 *    绝不因为「配置看不懂」而启用候选、改默认行为或静默夹取一个近似的阈值。
 *
 * ## 门槛语义（都只是"要不要现在调度"，不改变任何安全/事务判据）
 * - `minGrowthMessages`：自上次成功提交以来，**活动面消息条数**的增长下限
 *   （来源 = 只读 policy 端口的 `components.messages.count`，是**计数**，不是 token/字符
 *   估算；字符收益仍由 `makePlan` 的正净字符收益判据负责，不在这里重复计算）；
 * - `minRequestGap`：自上次成功提交以来的**真实请求数**下限（对齐 G3 的 attempt 语义：
 *   一次真实请求 = 一个请求序号；归档尝试本身不是请求，重试不额外计数）；
 * - `maxRequestGap`：请求数硬上限。到点必须允许一次调度，防止「小步持续增长」把
 *   队列饿死（反例：每步只长大一点点，增长门永远差一截）；
 * - `backlogCoalesceUnits`：积压上限。积压（工作集外的候选步数）超过它就把**调度意图**
 *   合并成一次提交；段边界、回执、凭证、事件与用户历史一律不合并。
 *
 * ## 不适用条件
 * - 不定义策略动作（allow/defer 由 domain/archive/schedule-policy.mjs 决定）；
 * - 不读盘、不读宿主、不引观测模块：本文件只有常量与纯校验（contracts → shared 合法）。
 */
import { deepFreeze } from '../shared/deep-freeze.mjs'
import { fnv1a64Of } from '../shared/fnv1a64.mjs'

/** 配置合同版本（字段/语义变化才动它；策略状态里按它比对）。 */
export const SCHEDULE_POLICY_VERSION = 1

/**
 * 默认门槛。**默认关闭**是产品边界：候选未启用时归档路径与 0.15.0 逐字节等价。
 *
 * 这些数字**未经标定**（G8 才做真实宿主/成本对照），因此只作为"启用后有个确定的起点"，
 * 不宣称最优。把它们写在这里的原因只有一个：全仓只有这一处默认值。
 */
export const SCHEDULE_POLICY_DEFAULTS = Object.freeze({
  enabled: false,
  minGrowthMessages: 8,
  minRequestGap: 4,
  maxRequestGap: 40,
  backlogCoalesceUnits: 30,
})

const DEFAULTS = SCHEDULE_POLICY_DEFAULTS

/**
 * 取值域：整数、闭区间；越界/小数一律非法（不夹取）。
 *
 * **导出原因（G7 接线，单一真源）**：入口的设置 schema（src/index.mjs 的
 * scheduleMinGrowthMessages 等 5 个字段）必须从**这里**派生 min/max，不得手写第二份数字；
 * 否则「设置页允许 500、校验只到 400」这种两套上限会再次出现（§11 要求门槛集中一处）。
 */
export const SCHEDULE_POLICY_BOUNDS = Object.freeze({
  minGrowthMessages: { min: 0, max: 400 },
  minRequestGap: { min: 0, max: 400 },
  maxRequestGap: { min: 1, max: 4000 },
  backlogCoalesceUnits: { min: 1, max: 2000 },
})

const BOUNDS = SCHEDULE_POLICY_BOUNDS

const INTEGER_KEYS = Object.freeze(Object.keys(BOUNDS))

const fail = (reason) => ({ ok: false, reason })

/**
 * 失败消息里的值描述（G5 审查 P3-7）。旧实现直接 JSON.stringify(value)：1n / 循环引用会**抛错**，
 * 于是「非法值失败关闭」在极端输入下变成异常，与本文件「校验不抛」的约定冲突。
 * 失败消息不承担数据回显职责，因此退化到 String(value) / 类型名即可。
 */
function describeValue(value) {
  try {
    const text = JSON.stringify(value)
    if (typeof text === 'string') return text
  } catch {
    // BigInt / 循环引用 / toJSON 抛错：落到下面的安全描述
  }
  try {
    return String(value)
  } catch {
    return typeof value
  }
}

function isIntegerWithin(key, value) {
  const bound = BOUNDS[key]
  return Number.isInteger(value) && value >= bound.min && value <= bound.max
}

/**
 * 归一化并校验调度候选配置。
 *
 * `raw` 允许为 `null/undefined`（= 没配置）：结果就是默认值（`enabled:false`）。
 * 未知字段一律拒绝而不是忽略——写错键名时不能"看起来已生效"。
 *
 * @param {unknown} raw 入口/设置页传下来的原始配置
 * @returns {{ok:true, config:object, fingerprint:string} | {ok:false, reason:string}}
 */
export function normalizeSchedulePolicyConfig(raw) {
  const candidate = raw === null || raw === undefined ? {} : raw
  if (typeof candidate !== 'object' || Array.isArray(candidate)) return fail('调度候选配置必须是对象')
  for (const key of Object.keys(candidate)) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULTS, key)) {
      return fail('调度候选配置未知字段：' + key)
    }
  }
  const config = { ...DEFAULTS }
  if (candidate.enabled !== undefined) {
    if (typeof candidate.enabled !== 'boolean') return fail('enabled 必须是布尔：' + describeValue(candidate.enabled))
    config.enabled = candidate.enabled
  }
  for (const key of INTEGER_KEYS) {
    if (candidate[key] === undefined) continue
    if (!isIntegerWithin(key, candidate[key])) {
      const bound = BOUNDS[key]
      return fail(key + ' 必须是 ' + bound.min + '–' + bound.max + ' 的整数：' + describeValue(candidate[key]))
    }
    config[key] = candidate[key]
  }
  if (config.minRequestGap > config.maxRequestGap) {
    return fail('minRequestGap 不得大于 maxRequestGap')
  }
  // 指纹只由**生效值**派生：配置一改，旧策略状态的基线立即失效（配置切换不污染节奏门）。
  const fingerprint = fnv1a64Of(JSON.stringify([
    SCHEDULE_POLICY_VERSION,
    config.enabled,
    config.minGrowthMessages,
    config.minRequestGap,
    config.maxRequestGap,
    config.backlogCoalesceUnits,
  ]))
  return { ok: true, config: deepFreeze(config), fingerprint }
}
