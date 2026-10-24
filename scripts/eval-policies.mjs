/**
 * 离线策略对照：同一任务起点下，三条策略各留下多少热上下文、保护了什么。
 *
 * 三条策略（`--policy`）：
 *   host  宿主基线：不降温，热上下文就是整个活动面（对照组，证明「省了多少」不是自说自话）。
 *   v1    旧版基线：只对「助手工具调用 + 结果」整段退热（`collectOperationCandidates`）。
 *   v2    新版完整策略：全历史候选 + 门禁 + 工作集保护（`collectHistoryCandidates`）。
 *
 * 这个脚本只做**离线**判定，回答的是「保护决策对不对、热上下文有没有界」。
 * 它**不能**证明真实任务质量、重复探索、费用、缓存与时延——那些必须在真实会话里
 * 用相同任务起点续跑比较，步骤见 docs/全历史按需记忆化v2-缺陷修复与活跃工作集交付-20261012.md。
 *
 * 用法：
 *   node scripts/eval-policies.mjs              三条都跑并打印对照表
 *   node scripts/eval-policies.mjs --json       机器可读输出
 *   node scripts/eval-policies.mjs --scenario=long --operations=400
 */

import { parseArgs } from 'node:util'

import { collectOperationCandidates, planCooling } from '../src/apply.mjs'
import { classifyRange } from '../src/v2/guard.mjs'
import { collectHistoryCandidates, bodyOfSpan, spanLabelOf } from '../src/v2/history.mjs'
import { buildWorkingState, renderWorkingStateCard } from '../src/v2/working-state.mjs'
import { estimateTokensOf } from '../src/v2/budget.mjs'
import { V2_RECEIPT_MARKER } from '../src/core.mjs'
import { buildSpanReceipt } from '../src/core.mjs'
import { FakeSession, fakeMeter, operation } from '../test/helpers/fake-host.mjs'

const SCENARIOS = {
  /** 普通长任务：多次工具操作 + 中途出现的关键约束 + 尾部未闭合调用。 */
  long: (operations) => buildTask({ operations }),
  /** 只有普通正文、没有工具调用：v1 收集器在这里会一个候选都没有。 */
  'plain-text': (operations) => buildTask({ operations, toolEvery: 0 }),
  /** 中途改过需求：远处有一条仍然生效的约束。 */
  'constraint-far': (operations) => buildTask({ operations, constraintAt: Math.floor(operations / 4) }),
}

function buildTask({ operations = 120, toolEvery = 1, constraintAt = 2 } = {}) {
  const session = new FakeSession({ id: 'eval-session-0001' })
  session.append('system/message', {
    turn: 0,
    step: 0,
    message: { id: 'sys', role: 'system', content: [{ type: 'text', text: '系统提示：只读调查，不要改文件。' }], source: { kind: 'system-prompt' } },
  }, { surfaceOp: 'append' })
  session.append('user/message', {
    id: 'u1',
    role: 'user',
    content: [{ type: 'text', text: '调查这个仓库的构建流程，先不要改任何文件。' }],
    source: { kind: 'user', rpcId: 'rpc-1' },
  }, { surfaceOp: 'append' })

  for (let index = 0; index < operations; index += 1) {
    if (index === constraintAt) {
      session.append('user/message', {
        id: `u-constraint-${index}`,
        role: 'user',
        content: [{ type: 'text', text: '补充约束：所有命令必须带 --dry-run，禁止写入仓库。' }],
        source: { kind: 'user', rpcId: `rpc-c-${index}` },
      }, { surfaceOp: 'append' })
    }
    if (toolEvery > 0 && index % toolEvery === 0) {
      operation({
        session,
        callId: `call-${index + 1}`,
        toolName: index % 3 === 0 ? 'read' : (index % 3 === 1 ? 'grep' : 'edit'),
        args: `{"path":"file-${index + 1}.md"}`,
        result: `${'内容内容内容内容内容内容内容内容'.repeat(120)}-${index}`,
        turn: index + 1,
        step: 1,
      })
    } else {
      session.append('assistant/message', {
        turn: index + 1,
        step: 1,
        message: {
          id: `m-plain-${index}`,
          role: 'assistant',
          content: [{ type: 'text', text: `${'分析文本'.repeat(400)}（第 ${index + 1} 段推理）` }],
          source: { kind: 'model' },
        },
      }, { surfaceOp: 'append' })
    }
    session.append('turn/end', { turn: index + 1, reason: { kind: 'complete' } })
  }

  // 尾部：一个刚发出、还没有结果的调用 + 最新的人类请求。两者都不许退热。
  session.append('assistant/message', {
    turn: operations + 1,
    step: 1,
    message: {
      id: 'm-open',
      role: 'assistant',
      content: [{ type: 'tool-call', id: 'call-open', name: 'read', arguments: '{"path":"README.md"}' }],
      source: { kind: 'model' },
    },
  }, { surfaceOp: 'append' })
  session.append('user/message', {
    id: 'u-last',
    role: 'user',
    content: [{ type: 'text', text: '继续，把结论写出来。' }],
    source: { kind: 'user', rpcId: 'rpc-last' },
  }, { surfaceOp: 'append' })
  return session
}

function viewOf(session, { retainOperations, archivedRanges = [] }) {
  const surfaceNodes = [...session.surface.nodes]
  return {
    surfaceNodes,
    eventAt: (seq) => session.eventAt(seq),
    measuredNodes: fakeMeter.measure(session).nodes,
    retainOperations,
    openTurn: null,
    archivedRanges,
    minimumChars: 0,
    lastAssistantSeq: lastAssistantSeqOf(session),
  }
}

/**
 * 逐步稳态：真实会话里每个 pre-step 只提交一批，跨多步才把积压清完。
 * 这里按同样节奏迭代，把已归档区间累积进下一次候选收集，得到稳态占用。
 */
function steadyState(session, { retainOperations, batchSize, policy }, { maxSteps = 200 } = {}) {
  const archivedRanges = []
  const archived = []
  let hotTokens = measureHot(session)
  let steps = 0
  const rejectedReasons = new Map()
  for (let step = 0; step < maxSteps; step += 1) {
    const view = viewOf(session, { retainOperations, archivedRanges })
    const plan = policy(view, session)
    if (plan.units.length === 0) {
      for (const entry of plan.rejected) {
        rejectedReasons.set(entry.reason, (rejectedReasons.get(entry.reason) ?? 0) + 1)
      }
      break
    }
    for (const unit of plan.units) {
      archivedRanges.push({ start: unit.rangeStart, end: unit.rangeEnd })
      archived.push({ kind: unit.spanKind ?? 'operation', range: `${unit.rangeStart}-${unit.rangeEnd}`, tokens: unit.originalTokens })
      hotTokens -= unit.originalTokens
      hotTokens += unit.receiptTokens
    }
    steps += 1
  }
  return { hotTokens, archived, steps, rejectedReasons: [...rejectedReasons] }
}

/** 宿主基线：什么都不做。 */
function hostPolicy(session) {
  return {
    policy: 'host',
    hotTokens: measureHot(session),
    archived: [],
    protectedItems: session.surface.nodes.length,
    notes: ['不降温：全部历史留在热上下文'],
  }
}

function v1Plan(view) {
  const collected = collectOperationCandidates(view)
  const plan = planCooling({
    candidates: collected.candidates,
    meter: fakeMeter,
    nodeIdFor: (candidate) => `mcl-${candidate.rangeStart}`,
    retainOperations: view.retainOperations,
    batchSize: 5,
    archiveFromSeq: view.lastAssistantSeq,
    receiptMarker: '[已归档操作]',
  })
  return { units: plan.units, rejected: plan.rejected, collected }
}

function v2Plan(view, session) {
  const collected = collectHistoryCandidates(view)
  const plan = planCooling({
    candidates: collected.candidates,
    meter: fakeMeter,
    nodeIdFor: (candidate) => `mcl2-${candidate.rangeStart}`,
    retainOperations: view.retainOperations,
    batchSize: 5,
    archiveFromSeq: view.lastAssistantSeq,
    receiptMarker: V2_RECEIPT_MARKER,
    guard: (candidate) => classifyRange({
      eventAt: (seq) => session.eventAt(seq),
      rangeStart: candidate.rangeStart,
      rangeEnd: candidate.rangeEnd,
      surfaceSeqs: session.surface.nodes,
      lastAssistantSeq: view.lastAssistantSeq,
      allowPlainText: candidate.spanKind !== 'operation',
    }),
    receiptOf: (candidate, meta) => buildSpanReceipt({
      label: spanLabelOf(candidate.spanKind),
      range: { start: candidate.rangeStart, end: candidate.rangeEnd },
      nodeId: meta.nodeId,
      hash: meta.hash,
      chars: meta.chars,
      tokens: meta.tokens,
      chunks: meta.chunks,
      marker: meta.marker,
    }),
  })
  return { units: plan.units, rejected: plan.rejected, collected }
}

function v1Policy(session, { retainOperations, batchSize }) {
  const steady = steadyState(session, { retainOperations, batchSize, policy: v1Plan })
  const collected = collectOperationCandidates(viewOf(session, { retainOperations }))
  return {
    policy: 'v1',
    hotTokens: steady.hotTokens,
    archived: steady.archived,
    protectedItems: collected.skipped.length,
    skipped: collected.skipped,
    steps: steady.steps,
    rejectedReasons: steady.rejectedReasons,
    notes: [`稳态 ${steady.steps} 步归档 ${steady.archived.length} 段`, '只认工具操作：普通 user/assistant 正文不在候选里'],
  }
}

function v2Policy(session, { retainOperations, batchSize }) {
  const steady = steadyState(session, { retainOperations, batchSize, policy: v2Plan })
  const view = viewOf(session, { retainOperations })
  const collected = collectHistoryCandidates(view)
  const state = buildWorkingState({
    surfaceNodes: view.surfaceNodes,
    eventAt: (seq) => session.eventAt(seq),
    nodeAt: (seq) => session.eventAt(seq),
    lastAssistantSeq: view.lastAssistantSeq,
    openCalls: [],
    pins: [],
  })
  const card = renderWorkingStateCard(state)
  return {
    policy: 'v2',
    hotTokens: steady.hotTokens,
    archived: steady.archived,
    protectedItems: state.protectedSet?.length ?? collected.skipped.length,
    skipped: collected.skipped,
    steps: steady.steps,
    rejectedReasons: steady.rejectedReasons,
    workingSet: {
      tokens: card.usedTokens,
      unclosedPairCount: state.unclosedPairCount,
      exposureDecidable: state.exposureDecidable,
      // 0.13.2-beta.8（Q4）：pinnedEvidence 字段随 pin 类目摘除；改报 unknowns 计数。
      unknownCount: state.unknowns.length,
    },
    notes: [
      `稳态 ${steady.steps} 步归档 ${steady.archived.length} 段`,
      '覆盖普通 user/assistant 正文与旧卡/旧回执；失败结果同样进候选',
      '未闭合调用来自活动面（不依赖冷库账本）',
    ],
  }
}

function lastAssistantSeqOf(session) {
  for (let index = session.surface.nodes.length - 1; index >= 0; index -= 1) {
    const seq = session.surface.nodes[index]
    if (session.eventAt(seq)?.type === 'assistant/message') return seq
  }
  return null
}

function measureHot(session) {
  const measured = fakeMeter.measure(session)
  return measured.totalTokens
}

/** 宿主基线：什么都不做。 */
function protectionAudit(session, policies) {
  const surface = session.surface.nodes
  const openCallSeq = surface.find((seq) => (session.eventAt(seq)?.data?.message?.content ?? []).some((block) => block?.type === 'tool-call' && block.id === 'call-open'))
  const lastUserSeq = surface.filter((seq) => session.eventAt(seq)?.type === 'user/message').at(-1)
  const v2 = policies.v2
  const archivedRanges = v2.archived.map((entry) => entry.range.split('-').map(Number))
  const touched = (seq) => archivedRanges.some(([start, end]) => seq >= start && seq <= end)
  return {
    openCallSeq,
    lastUserSeq,
    openCallProtected: openCallSeq === undefined ? null : !touched(openCallSeq),
    lastUserProtected: lastUserSeq === undefined ? null : !touched(lastUserSeq),
  }
}

function render(results) {
  const lines = []
  lines.push(`场景：${results.scenario}｜操作数：${results.operations}｜retain=${results.retainOperations}｜batch=${results.batchSize}`)
  lines.push('')
  lines.push('策略   热上下文 token   归档段数   保护项   说明')
  for (const policy of [results.policies.host, results.policies.v1, results.policies.v2]) {
    lines.push([
      policy.policy.padEnd(6),
      String(policy.hotTokens).padStart(15),
      String(policy.archived.length).padStart(10),
      String(policy.protectedItems).padStart(8),
      ` ${policy.notes[0]}`,
    ].join(''))
  }
  lines.push('')
  const host = results.policies.host.hotTokens
  for (const key of ['v1', 'v2']) {
    const policy = results.policies[key]
    const saved = host === 0 ? 0 : Math.round((1 - policy.hotTokens / host) * 1000) / 10
    lines.push(`${key} 相对宿主基线释放 ${saved}% 热上下文`)
  }
  const kinds = new Map()
  for (const entry of results.policies.v2.archived) kinds.set(entry.kind, (kinds.get(entry.kind) ?? 0) + 1)
  lines.push('')
  lines.push(`v2 归档段种类：${[...kinds].map(([kind, count]) => `${kind}×${count}`).join('，') || '（无）'}`)
  lines.push(`v1 归档段种类：${[...new Set(results.policies.v1.archived.map((entry) => entry.kind))].join('，') || '（无）'}`)
  lines.push('')
  lines.push('保护决策自检：')
  lines.push(`  未闭合调用（seq ${results.audit.openCallSeq}）未被打包：${results.audit.openCallProtected}`)
  lines.push(`  最新人类请求（seq ${results.audit.lastUserSeq}）未被打包：${results.audit.lastUserProtected}`)
  lines.push(`  v2 未曝光判定可决：${results.policies.v2.workingSet.exposureDecidable}`)
  lines.push(`  v2 工作状态卡 ≈${results.policies.v2.workingSet.tokens} token，在途配对 ${results.policies.v2.workingSet.unclosedPairCount} 个`)
  lines.push('')
  lines.push('离线结论只覆盖保护决策与热上下文占用；任务质量/重复探索/费用/缓存/时延必须在真实会话续跑比较。')
  for (const key of ['v1', 'v2']) {
    const reasons = results.policies[key].rejectedReasons ?? []
    if (reasons.length > 0) {
      lines.push(`  ${key} 停止时剩余拒绝原因：${reasons.map(([reason, count]) => `${reason}×${count}`).join('，')}`)
    }
  }
  return lines.join('\n')
}

async function main() {
  const { values } = parseArgs({
    options: {
      policy: { type: 'string', default: 'all' },
      scenario: { type: 'string', default: 'long' },
      operations: { type: 'string', default: '120' },
      retain: { type: 'string', default: '5' },
      batch: { type: 'string', default: '5' },
      json: { type: 'boolean', default: false },
    },
  })
  const scenario = SCENARIOS[values.scenario]
  if (!scenario) {
    console.error(`未知场景 ${values.scenario}；可用：${Object.keys(SCENARIOS).join(', ')}`)
    process.exit(2)
  }
  const operations = Number.parseInt(values.operations, 10)
  const retainOperations = Number.parseInt(values.retain, 10)
  const batchSize = Number.parseInt(values.batch, 10)
  const session = scenario(operations)
  const options = { retainOperations, batchSize }
  const policies = {
    host: hostPolicy(session),
    v1: v1Policy(session, options),
    v2: v2Policy(session, options),
  }
  const results = {
    scenario: values.scenario,
    operations,
    retainOperations,
    batchSize,
    policies,
    audit: protectionAudit(session, policies),
  }
  if (values.json) {
    console.log(JSON.stringify(results, null, 2))
    return
  }
  console.log(render(results))
  void estimateTokensOf
}

await main()
