/**
 * 计划先行（plan-first）：新会话第一条对话前的宿主计划模式联动。
 *
 * 宿主契约（@deepseek-ai/dsh-plan-mode，桌面 0.2.0-rc.2 核验）：
 * - `ctx.get('planMode')` 返回控制器：`get(agent)` → `{ active, pending? }`，
 *   `set(agent, bool)` → `'committed' | 'queued' | 'cancelled' | 'noop'`，均为同步。
 * - 轮次未开（无 open turn）时 `set()` 立即落账（committed）；轮次进行中则排队到
 *   下一个被接受的轮内 pre-step（queued）。
 * - 只读回退：`sessionProjections.stateOf(session, 'plan')` → `{ active, ... }`。
 *   注册表或 key 缺失时该读取显式抛错——这里捕获后返回 null，如实降级。
 *
 * 本模块只做三件事：
 * 1. 读计划模式状态（`planStateOf` / `planActiveFor`）；
 * 2. 全新会话时进入计划模式（`enterIfFresh`）——会话已有历史则不动，返回原因；
 * 3. 给自动降温/回注/工作状态卡提供统一挂起判定（`coolingSuspensionFor`）：
 *    计划模式激活（active 或 pending）期间自动动作全部 no-op，并在测量账本里
 *    记录原因；手动命令不受影响（用户显式动作优先）。
 *
 * 不改宿主 plan-mode 的任何行为（引导文本、评审流程、`/plan off` 均归宿主）；
 * 插件不自动替用户批准计划。
 */

/** 宿主计划模式退出工具的稳定名（计划全文保留在它的调用参数里）。 */
export const EXIT_PLAN_MODE_TOOL = 'exit_plan_mode'

function warn(logger, message, error) {
  try {
    logger?.warn?.(`dsh-memory-context-lab plan-first: ${message}: %o`, error)
  } catch {
    // 日志通道本身不可用时保持静默：计划先行是增强功能，不能拖垮降温本体。
  }
}

export function createPlanFirst({ services, logger = null }) {
  /** 取宿主 planMode 控制器；未组装计划模式插件时为 null。 */
  function controller() {
    try {
      const service = services?.get?.('planMode')
      return service && typeof service.get === 'function' && typeof service.set === 'function' ? service : null
    } catch (error) {
      warn(logger, 'planMode 服务不可用', error)
      return null
    }
  }

  /**
   * 读计划模式状态。优先走服务（含 pending 选择），服务缺失时退回 `plan` 投影
   * 的已落账状态；两者都拿不到返回 null（调用方按「未知=不挂起」处理，绝不
   * 因为读不到状态而冻结降温）。
   */
  function planStateOf(agent) {
    const ctl = controller()
    if (ctl) {
      try {
        const state = ctl.get(agent)
        if (state && typeof state === 'object') {
          return { active: state.active === true, pending: state.pending === true, source: 'service' }
        }
      } catch (error) {
        warn(logger, 'planMode.get 失败，尝试投影回退', error)
      }
    }
    try {
      const state = services?.sessionProjections?.stateOf?.(agent.session, 'plan')
      if (state && typeof state === 'object') {
        return { active: state.active === true, pending: false, source: 'projection' }
      }
    } catch {
      // 宿主未注册 plan 投影：全新环境（无 plan-mode 插件），如实降级。
    }
    return null
  }

  /**
   * 自动降温是否因计划模式挂起。`pending` 选择也算激活：排队生效的选择说明
   * 用户已决定进入（或离开）计划模式，边界轮内的降温动作应保持一致。
   */
  function coolingSuspensionFor(agent) {
    const state = planStateOf(agent)
    if (!state) return { suspended: false, reason: '' }
    if (state.active || state.pending) {
      return { suspended: true, reason: `计划模式激活中（active=${state.active}, pending=${state.pending}），自动降温挂起` }
    }
    return { suspended: false, reason: '' }
  }

  /**
   * 会话是否「全新」：活动面上没有任何 user/assistant 消息。系统提示、运行时
   * 上下文等非消息事件不在 `session.surface.nodes` 里，不会误判。
   */
  function sessionIsFresh(agent) {
    const session = agent?.session
    const nodes = session?.surface?.nodes
    if (!Array.isArray(nodes)) return false
    for (const seq of nodes) {
      const event = session.eventAt(seq)
      const type = event?.type ?? ''
      if (type === 'user/message' || type === 'assistant/message') return false
    }
    return true
  }

  /**
   * pre-step 自动进入用的放宽 fresh 判定：活动面无 assistant 消息，且 user
   * 消息不超过一条。自动进入的钩子只能在 `agent/pre-step` 里跑，那时进行中的
   * 首条用户消息已经落账，严格版（0 条 user）恒为 false。容忍这唯一一条：
   * 只要模型还没有任何回复，就仍然是「对话开头」。
   */
  function sessionIsFreshForAutoEnter(agent) {
    const session = agent?.session
    const nodes = session?.surface?.nodes
    if (!Array.isArray(nodes)) return false
    let userCount = 0
    for (const seq of nodes) {
      const event = session.eventAt(seq)
      const type = event?.type ?? ''
      if (type === 'assistant/message') return false
      if (type === 'user/message') userCount += 1
    }
    return userCount <= 1
  }

  /**
   * 服务缺失时的落账路径：直接 append `plan/mode {active:true}`。
   *
   * 与宿主 `set()` 在无 open turn 时的 committed 路径等价——宿主控制器也是
   * append 同一事件，只是多附一条 hero narration；全新会话
   * `activeAtLastHeader` 为 null，两者对请求前缀的渲染没有差异。计划模式的
   * 引导段落与 `exit_plan_mode` 工具由共享投影与系统提示渲染，不依赖隔离组
   * 里的 `planMode` 服务。
   */
  function enterViaLog(agent) {
    const state = planStateOf(agent)
    if (state?.active === true) return { outcome: 'noop', text: '会话已在计划模式' }
    try {
      agent?.session?.append?.('plan/mode', { active: true })
      return {
        outcome: 'committed',
        text: '已进入计划模式（经会话日志落账）：先完成详细计划，期间自动降温挂起；计划通过后恢复',
      }
    } catch (error) {
      warn(logger, 'plan/mode 落账失败', error)
      return { outcome: 'error', text: `进入计划模式失败：${String(error?.message ?? error).slice(0, 200)}` }
    }
  }

  /**
   * 全新会话时进入宿主计划模式。返回可读结果给命令/面板：
   * - `entered`/`committed`：已落账；
   * - `queued`：当前有 open turn，下一轮生效（正常情况下全新会话不会有 open turn）；
   * - `noop`：已经在计划模式；
   * - `not-fresh`：会话已有历史，不动（面板提示可手动 /plan）；
   * - `unavailable`：宿主既无 planMode 服务，也读不到 `plan` 投影（连落账
   *   契约都不存在），如实降级。
   *
   * 服务可用时优先走服务（含 pending 语义）；顶层插件拿不到隔离组里的服务时
   * 走 `enterViaLog` 落账——`plan/mode` 事件是共享投影折叠的宿主契约，直接
   * 落账与服务路径最终一致。
   */
  function enterIfFresh(agent, { fresh = null } = {}) {
    const isFresh = fresh === null ? sessionIsFresh(agent) : fresh
    if (!isFresh) {
      return { outcome: 'not-fresh', text: '本会话已有对话历史，计划先行不自动进入；可手动 /plan' }
    }
    const ctl = controller()
    if (ctl) {
      try {
        const outcome = ctl.set(agent, true)
        const text = outcome === 'committed'
          ? '已进入计划模式：先完成详细计划，期间自动降温挂起；计划通过后恢复'
          : outcome === 'queued'
            ? '计划模式将在下一轮生效（当前轮次进行中）'
            : outcome === 'noop'
              ? '会话已在计划模式'
              : '计划模式进入被取消（已落账状态与目标一致）'
        return { outcome, text }
      } catch (error) {
        warn(logger, 'planMode.set 失败，尝试落账路径', error)
        // fall through 到落账路径：服务抛错不代表会话日志不可写。
      }
    }
    if (services?.sessionProjections?.stateOf) return enterViaLog(agent)
    return { outcome: 'unavailable', text: '宿主未提供计划模式（无 dsh-plan-mode 服务且读不到 plan 投影），计划先行不生效' }
  }

  return { planStateOf, coolingSuspensionFor, sessionIsFresh, sessionIsFreshForAutoEnter, enterIfFresh, enterViaLog }
}

/**
 * 一条助手消息的内容里是否含 `exit_plan_mode` 调用。
 *
 * 计划全文保留在该调用的 `plan` 参数里；命中即视为计划工件，整段（含配对
 * 结果）不得退热。纯函数，供 v1/v2 两个候选收集器共用。
 */
export function contentHasPlanToolCall(content) {
  if (!Array.isArray(content)) return false
  return content.some((block) => block?.type === 'tool-call' && block?.name === EXIT_PLAN_MODE_TOOL)
}
