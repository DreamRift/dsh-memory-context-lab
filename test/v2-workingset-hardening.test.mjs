/**
 * 0.13.1 守卫：工作状态卡的六处「该看见的看不见」缺陷。
 *
 * 全部由独立复审实测发现（每条都先写成必红用例）：
 * 1. claim 配额按列表顺序截断 → 否定/撤回（最新、排最后）被 8 条 positive 挤掉，
 *    与 1498 行注释「否定/更正可见」相反：模型可能按已撤回结论行动。
 * 2. required:true 的软条目在预算装包时不被必选 → 承诺的「必选」从不生效。
 * 3. readback 的 tokens=null 被 Number(null)=0 当成「取回 0 token」→ 未知代价印成免费。
 * 4. 增量卡截断后基线已推进 → 被省略的变化行在后续增量卡里永不出现。
 * 5. 非有限 maxProgressItems → 进度整段消失，连「另有 N 条」也不印。
 * 6. 未曝光结果 take() 保留最旧 → 最新的未曝光结果掉出卡片与最小依赖集。
 *
 * ## 不适用条件
 * 只测卡片的文本产物与状态字段，不测宿主注入时序（那由 v2-card-* 系列负责）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildWorkingState,
  renderWorkingSetInjection,
  readbackSectionOf,
  workingStateCardDelta,
  RETENTION_CLASSES,
  PROTECTION_CLASSES,
  WORKING_SET_DEFAULTS,
} from '../src/v2/working-state.mjs'

const SESSION_ID = 'session-ws-hardening'

function stateOf(extra = {}) {
  return buildWorkingState({
    sessionId: SESSION_ID,
    surfaceNodes: [],
    eventAt: () => null,
    openCalls: [],
    lastAssistantSeq: null,
    now: 0,
    ...extra,
  })
}

const claimItemsOf = (state) => (state.retention[RETENTION_CLASSES.UNVERIFIED_EVIDENCE] ?? [])
  .filter((item) => (item.itemId ?? '').startsWith('assistant-claim:'))

test('否定/撤回的 claim 不会被 positive 挤掉', () => {
  const claims = []
  for (let i = 0; i < 8; i += 1) {
    claims.push({ value: '已完成：第 ' + i + ' 项。', polarity: 'positive', verified: false, recordRef: 'r' + i })
  }
  claims.push({ value: '更正：上面第 3 项其实是失败的。', polarity: 'retracted', verified: false, recordRef: 'r-retract' })

  const state = stateOf({ claims })
  const items = claimItemsOf(state)
  const lines = items.map((item) => item.lines.join('\n')).join('\n')
  assert.match(lines, /上面第 3 项其实是失败的/,
    '被撤回的结论必须在卡里可见（否则模型会按已撤回结论行动）')
  assert.match(lines, /retracted/)
  const retraction = items.find((item) => (item.lines.join('\n')).includes('上面第 3 项'))
  assert.equal(retraction.required, true, '否定/撤回条目必须标 required')
  // 配额仍然有界（不能因为优先保留否定就无界）。
  assert.ok(items.filter((item) => item.itemId !== 'assistant-claim:overflow').length
    <= (WORKING_SET_DEFAULTS.maxAssistantClaims ?? 8))
})

test('required 的软条目在预算不足时仍然必选', () => {
  const state = stateOf({
    constraints: [{ text: '不要修改 runtime.mjs', sourceRef: 'seq:1' }],
    claims: [
      { value: '更正：上一条结论作废。', polarity: 'retracted', verified: false, recordRef: 'r-retract' },
      ...Array.from({ length: 12 }, (_, i) => ({
        value: '已完成：第 ' + i + ' 项，这一条刻意写得很长以便把预算挤满。'.repeat(3),
        polarity: 'positive',
        verified: false,
        recordRef: 'r' + i,
      })),
    ],
  })
  // 预算刚好够硬保护：普通软条目会被丢弃，required 的必须留下。
  const card = renderWorkingSetInjection(state, { budgetTokens: 700 })
  assert.match(card.text, /上一条结论作废/,
    'required 条目被预算丢掉了（826 行承诺的「必选」不成立）')
  assert.ok(card.dropped.length > 0, '这条用例必须真的处在预算不足的处境（否则证明不了必选）')
})

test('tokens 未知时不得印成「取回 ≈0 token」', () => {
  const section = readbackSectionOf([{ recordId: 't00000001-r0000', kind: 'read', range: 'seq 1–2', tokens: null }])
  const text = [section.title, ...(section.lines ?? [])].join('\n')
  assert.doesNotMatch(text, /取回 ≈0 token/, '未知代价被印成免费：' + text)
  assert.match(text, /t00000001-r0000/, '条目本身仍要列出')
})

test('增量卡被截断时如实标注，并要求下一次给全量卡', () => {
  const previous = ['head-a', 'head-b', 'x1'].join('\n')
  const next = ['head-a', 'head-b', ...Array.from({ length: 60 }, (_, i) => 'line-' + i)].join('\n')
  const delta = workingStateCardDelta({ previousText: previous, nextText: next })
  assert.ok(delta, '变化行必须产出增量卡')
  assert.equal(delta.truncated, true, '60 行变化必然触发截断，必须如实标 truncated')
  assert.match(delta.text, /另有 \d+ 行变化未在本卡列出/)
  assert.doesNotMatch(delta.text, /完整内容以最近一张全量卡为准/,
    '模型手里的最近一张全量卡并不含这些行，这句话不成立')
})

/**
 * 造一批「一条助手消息里 N 个并行 tool-call + 各自结果」的活动面。
 *
 * 进度与未曝光结果都是**从活动面推导**的（不是入参），所以必须造真实事件形态。
 * 结果 seq 全部大于 lastAssistantSeq，因此都算「未曝光」。
 */
function surfaceWithCalls(count) {
  const nodes = [1]
  const events = new Map()
  const callIds = Array.from({ length: count }, (_, i) => 'call-' + i)
  events.set(1, {
    type: 'assistant/message',
    seq: 1,
    data: {
      turn: 1,
      step: 1,
      message: {
        id: 'm1',
        content: callIds.map((id) => ({ type: 'tool-call', id, name: 'read_file', arguments: { path: 'x' } })),
      },
    },
  })
  for (const [i, callId] of callIds.entries()) {
    const seq = 10 + i
    events.set(seq, {
      type: 'tool/result',
      seq,
      data: { message: { id: 'r' + i, source: { callId }, content: [{ type: 'text', text: 'out' + i }] } },
    })
    nodes.push(seq)
  }
  return { nodes, events }
}

test('maxProgressItems 非有限时进度不消失（不是被夹成 0）', () => {
  const { nodes, events } = surfaceWithCalls(14)
  // Y-31（beta.8）后进度只收「已曝光的完成态」：补一个收尾助手节点（seq 30），
  // 让全部结果都落在最后助手之前（曝光），本测试的主题「非有限上限 = 不截断」
  // 不被曝光口径干扰。
  events.set(30, {
    type: 'assistant/message',
    seq: 30,
    data: { turn: 2, step: 2, message: { id: 'm30', content: [{ type: 'text', text: '汇总。' }] } },
  })
  nodes.push(30)
  const state = buildWorkingState({
    sessionId: SESSION_ID,
    surfaceNodes: nodes,
    eventAt: (seq) => events.get(seq),
    openCalls: [],
    lastAssistantSeq: 30,
    now: 0,
    limits: { maxProgressItems: undefined },
  })
  assert.equal(state.progressCount, 14, '进度总数应如实报 14')
  assert.equal((state.progress ?? []).length, 14,
    '非有限上限必须当作「不截断」，不是「一条不留」')
  const card = renderWorkingSetInjection(state, { budgetTokens: 40000 })
  assert.match(card.text, /进度/, '进度整段消失了（非有限 cap 被夹成 0）')
})

test('未曝光结果超过配额时保留最新的，不是最旧的', () => {
  const { nodes, events } = surfaceWithCalls(9)
  const state = buildWorkingState({
    sessionId: SESSION_ID,
    surfaceNodes: nodes,
    eventAt: (seq) => events.get(seq),
    openCalls: [],
    lastAssistantSeq: 1,
    now: 0,
  })
  const listed = (state.unseenResults ?? []).map((item) => item.recordRef)
  assert.equal(listed.length, WORKING_SET_DEFAULTS.maxUnseenResults ?? 6,
    '未曝光结果条数应等于配额，实际 ' + listed.length)
  assert.ok(listed.includes('seq:18'), '最新的未曝光结果必须列出（现在是保留最旧的）：' + listed.join(','))
  assert.ok(!listed.includes('seq:10'), '最旧的应让位给最新的：' + listed.join(','))
})
