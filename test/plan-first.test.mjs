/**
 * 计划先行（`src/plan-first.mjs`）回归测试。
 *
 * 覆盖四条产品要求：
 * 1. 全新会话（活动面无任何 user/assistant 消息）时 `enterIfFresh` 立即进入宿主
 *    计划模式（committed），并给出可读文案；
 * 2. 会话已有历史时不自动进入（not-fresh），文案引导手动 /plan；
 * 3. 宿主未组装 plan-mode 服务时如实降级（unavailable），不影响降温本体；
 * 4. 计划模式激活（active 或 pending）期间 `coolingSuspensionFor` 挂起自动动作，
 *    读不到任何状态时绝不挂起（未知≠冻结）。
 *
 * 另外验证计划工件识别：`exit_plan_mode` 调用被 `contentHasPlanToolCall` 命中，
 * 其他工具不误命中。
 *
 * 全程内存假服务，不触碰真实会话与已安装插件数据。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { createPlanFirst, contentHasPlanToolCall, EXIT_PLAN_MODE_TOOL } from '../src/plan-first.mjs'

/** 假 planMode 服务：记录 set 调用，返回指定 outcome。 */
function fakePlanMode({ state = { active: false, pending: false }, outcome = 'committed' } = {}) {
  const sets = []
  return {
    sets,
    service: {
      get: () => state,
      set: (agent, value) => {
        sets.push({ agentId: agent?.session?.id ?? '(no-id)', value })
        return outcome
      },
    },
  }
}

/** 合成 agent：surface.nodes + eventAt。 */
function agentOf(events) {
  const nodes = events.map((_, index) => index + 1)
  return {
    session: {
      id: 'session-plan-first-01',
      surface: { nodes },
      eventAt: (seq) => events[seq - 1] ?? null,
    },
  }
}

function userMessage(text = '开始开发') {
  return { type: 'user/message', data: { message: { id: 'u1', role: 'user', content: [{ type: 'text', text }], source: { kind: 'user', rpcId: 'rpc-1' } } } }
}

function assistantMessage() {
  return { type: 'assistant/message', data: { turn: 1, step: 1, message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: '收到' }], source: { kind: 'model', provider: 'fake', model: 'fake-model' } } } }
}

test('全新会话立即进入宿主计划模式（committed）', () => {
  const { service, sets } = fakePlanMode()
  const pf = createPlanFirst({ services: { get: () => service } })
  const agent = agentOf([])
  const result = pf.enterIfFresh(agent)
  assert.equal(result.outcome, 'committed')
  assert.ok(result.text.includes('计划模式'), `文案应说明已进入计划模式，got: ${result.text}`)
  assert.equal(sets.length, 1)
  assert.equal(sets[0].value, true)
})

test('queued 与 noop 结果都有如实文案', () => {
  for (const outcome of ['queued', 'noop', 'cancelled']) {
    const { service } = fakePlanMode({ outcome })
    const pf = createPlanFirst({ services: { get: () => service } })
    const result = pf.enterIfFresh(agentOf([]))
    assert.equal(result.outcome, outcome)
    assert.ok(typeof result.text === 'string' && result.text.length > 0)
  }
})

test('会话已有历史时不自动进入，并提示手动 /plan', () => {
  const { service, sets } = fakePlanMode()
  const pf = createPlanFirst({ services: { get: () => service } })
  const result = pf.enterIfFresh(agentOf([userMessage()]))
  assert.equal(result.outcome, 'not-fresh')
  assert.ok(result.text.includes('/plan'), `文案应引导手动 /plan，got: ${result.text}`)
  assert.equal(sets.length, 0, '绝不调用 set')
})

test('宿主未组装 planMode 服务时如实降级（unavailable）', () => {
  const pf = createPlanFirst({ services: { get: () => undefined } })
  const result = pf.enterIfFresh(agentOf([]))
  assert.equal(result.outcome, 'unavailable')
  assert.ok(result.text.includes('dsh-plan-mode'))
  // services 完全缺失（连 get 都没有）也不抛异常。
  const bare = createPlanFirst({ services: null })
  assert.equal(bare.enterIfFresh(agentOf([])).outcome, 'unavailable')
})

test('active 或 pending 期间挂起自动降温；状态未知绝不挂起', () => {
  // active
  const active = fakePlanMode({ state: { active: true, pending: false } })
  const pfActive = createPlanFirst({ services: { get: () => active.service } })
  const suspended = pfActive.coolingSuspensionFor(agentOf([]))
  assert.equal(suspended.suspended, true)
  assert.ok(suspended.reason.includes('计划模式'))

  // pending（轮内排队的选择）同样挂起
  const pending = fakePlanMode({ state: { active: false, pending: true } })
  const pfPending = createPlanFirst({ services: { get: () => pending.service } })
  assert.equal(pfPending.coolingSuspensionFor(agentOf([])).suspended, true)

  // 未激活
  const idle = fakePlanMode({ state: { active: false, pending: false } })
  const pfIdle = createPlanFirst({ services: { get: () => idle.service } })
  assert.equal(pfIdle.coolingSuspensionFor(agentOf([])).suspended, false)

  // 服务与投影都读不到：未知≠冻结
  const pfUnknown = createPlanFirst({ services: { get: () => undefined } })
  assert.equal(pfUnknown.coolingSuspensionFor(agentOf([])).suspended, false)
})

test('投影回退：服务缺失时读 plan 投影的已落账状态', () => {
  const services = {
    get: () => undefined,
    sessionProjections: { stateOf: () => ({ active: true }) },
  }
  const pf = createPlanFirst({ services })
  const state = pf.planStateOf(agentOf([]))
  assert.equal(state.source, 'projection')
  assert.equal(state.active, true)
  assert.equal(pf.coolingSuspensionFor(agentOf([])).suspended, true)
})

test('contentHasPlanToolCall：只命中 exit_plan_mode 调用', () => {
  const planCall = [
    { type: 'text', text: '先给计划' },
    { type: 'tool-call', id: 'call-plan-1', name: EXIT_PLAN_MODE_TOOL, arguments: '{"plan":"# 计划\\n全文"}' },
  ]
  assert.equal(contentHasPlanToolCall(planCall), true)
  const otherCall = [
    { type: 'tool-call', id: 'call-read-1', name: 'read', arguments: '{}' },
  ]
  assert.equal(contentHasPlanToolCall(otherCall), false)
  assert.equal(contentHasPlanToolCall(null), false)
  assert.equal(contentHasPlanToolCall('not-an-array'), false)
})

test('sessionIsFresh：只有非消息事件（如计划模式日志）不算历史', () => {
  const { service } = fakePlanMode({ outcome: 'noop' })
  const pf = createPlanFirst({ services: { get: () => service } })
  // 全新对话 hero 态可能已有 plan/mode 日志事件，但 surface 上无消息。
  const agent = agentOf([{ type: 'plan/mode', data: { active: true } }])
  assert.equal(pf.sessionIsFresh(agent), true)
  assert.equal(pf.enterIfFresh(agent).outcome, 'noop', '已在计划模式：noop 而不是重复进入')
  assert.equal(pf.sessionIsFresh(agentOf([assistantMessage()])), false)
})
