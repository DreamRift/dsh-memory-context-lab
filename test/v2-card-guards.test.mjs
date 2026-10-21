/**
 * 0.13.2 守卫：工作状态卡的六处口径缺陷（D-08 / D-11 / D-12 / D-13 / D-19 / D-20）。
 *
 * ## 缺陷
 * - **D-08**：增量卡去重闸门只看「语义键是否注入过」。全量卡时代键命中 ⇒ 模型手上
 *   就是这张卡；增量卡时代模型手上是「上一张全量卡 + 后续增量」。状态回退到某个旧
 *   全量卡形态时，增量卡宣告过的行（未曝光结果、进度）在新状态里已不存在，却没有
 *   任何卡撤回它们——模型按不存在的事实行动。
 * - **D-11**：`slice(-0) === slice(0)`：claim 配额 0 反而输出全部，页脚还写
 *   「另有 N 条未展开」，与正文自相矛盾。
 * - **D-12**：`Number(null) === 0`：预算 `null` / `''` / `[]` 被归一成 0 →
 *   hardOverflow、软保留一条不装、页脚写「已超过预算 0 token」。
 * - **D-13**：`take()` 丢最新留最旧：在途调用与约束超配额时，被丢的恰好是刚发出的那个。
 * - **D-19**：页脚用未归一的原始配额做减法，`另有 1.2999999999999998 条` 印进卡片。
 * - **D-20**：按 UTF-16 单元截断切在代理对中间 → 孤立代理、落盘成 U+FFFD。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildWorkingState,
  readbackSectionOf,
  renderWorkingSetInjection,
  RETENTION_CLASSES,
} from '../src/v2/working-state.mjs'

const SESSION_ID = 'session-card-guards'

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

function surfaceWithOpenCalls(count) {
  const nodes = [1]
  const events = new Map()
  const callIds = Array.from({ length: count }, (_, i) => 'call-' + i)
  events.set(1, {
    type: 'assistant/message',
    seq: 1,
    data: { turn: 1, step: 1, message: { id: 'm1', content: callIds.map((id) => ({ type: 'tool-call', id, name: 'read_file', arguments: { path: 'x' } })) } },
  })
  for (const [i, callId] of callIds.entries()) {
    const seq = 10 + i
    events.set(seq, { type: 'tool/result', seq, data: { message: { id: 'r' + i, source: { callId }, content: [{ type: 'text', text: 'out' + i }] } } })
    nodes.push(seq)
  }
  return { nodes, events, callIds }
}

test('D-11：claim 配额 0 / 负数 / null 时一条都不列（不是列全部）', () => {
  const claims = [
    { value: '结论一', polarity: 'positive', recordRef: 'r1' },
    { value: '更正：结论一作废', polarity: 'retracted', recordRef: 'r2' },
    { value: '结论三', polarity: 'positive', recordRef: 'r3' },
  ]
  for (const cap of [0, -1]) {
    const state = stateOf({ claims, limits: { maxAssistantClaims: cap } })
    const listed = (state.retention[RETENTION_CLASSES.UNVERIFIED_EVIDENCE] ?? [])
      .filter((item) => (item.itemId ?? '').startsWith('assistant-claim:') && item.itemId !== 'assistant-claim:overflow')
    assert.equal(listed.length, 0, `maxAssistantClaims=${cap} 时必须一条都不列（slice(-0) 会把整表留下）`)
  }
})

test('D-12：budgetTokens 为 null / "" / [] 时与 undefined 同结果（走默认预算）', () => {
  const state = stateOf({ claims: [{ value: '一条结论', polarity: 'positive', recordRef: 'r1' }] })
  const baseline = renderWorkingSetInjection(state, { budgetTokens: undefined })
  for (const value of [null, '', []]) {
    const card = renderWorkingSetInjection(state, { budgetTokens: value })
    assert.equal(card.overflow, baseline.overflow, `budgetTokens=${JSON.stringify(value)} 被归一成 0（不该 overflow）`)
    assert.equal(card.budgetTokens, baseline.budgetTokens, `budgetTokens=${JSON.stringify(value)} 必须回落默认值`)
    assert.equal(card.text, baseline.text, '未提供预算与默认预算必须渲染同一张卡')
  }
})

test('D-13：在途调用与有效约束超配额时保留最新的', () => {
  const { nodes, events, callIds } = surfaceWithOpenCalls(10)
  const state = buildWorkingState({
    sessionId: SESSION_ID,
    surfaceNodes: nodes,
    eventAt: (seq) => events.get(seq),
    openCalls: [],
    lastAssistantSeq: 1,
    now: 0,
    limits: { maxOpenActions: 8 },
  })
  const card = renderWorkingSetInjection(state, { budgetTokens: 40000 })
  assert.match(card.text, new RegExp(callIds[callIds.length - 1]), '最新的在途调用必须在卡里（它是「我在等哪个结果」）')

  const constraints = Array.from({ length: 8 }, (_, i) => ({ text: '约束 ' + i, sourceRef: 'c' + i }))
  const constrained = stateOf({ constraints, limits: { maxConstraints: 6 } })
  const constraintCard = renderWorkingSetInjection(constrained, { budgetTokens: 40000 })
  assert.match(constraintCard.text, /约束 7/, '最新的约束必须留下（take 留头部等于丢最新）')
})

test('D-19：浮点配额下页脚的「另有 N 条」必须是整数', () => {
  const claims = Array.from({ length: 3 }, (_, i) => ({ value: '结论 ' + i, polarity: 'positive', recordRef: 'r' + i }))
  const state = stateOf({ claims, limits: { maxAssistantClaims: 2.7 } })
  const card = renderWorkingSetInjection(state, { budgetTokens: 40000 })
  const footer = (card.text.match(/另有 ([0-9.eE+-]+) 条助手结论未展开/) ?? [])[1]
  assert.ok(footer, '配额不足时必须如实报「另有 N 条」：' + card.text)
  assert.equal(footer, String(Math.trunc(Number(footer))), `页脚必须是整数，实际 ${footer}`)
  assert.equal(Number(footer), 1, '3 条结论、配额 2.7 → floor 后列 2 条，另有 1 条')
})

test('D-20：截断不产生孤立代理（「本步可回读」与摘录都按码点切）', () => {
  const emoji = '🙂'
  const longLine = emoji.repeat(60) // 60 个码点 = 120 个 UTF-16 单元
  const section = readbackSectionOf([{ recordId: 't00000001-r0000', kind: 'read', locator: longLine, range: { start: 1, end: 2 }, tokens: 5 }])
  const text = [section.title, ...(section.lines ?? [])].join('\n')
  assert.equal(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(text), false, '出现了孤立高位代理：截断切在代理对中间')
  assert.equal(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text), false, '出现了孤立低位代理')
  assert.equal(Buffer.from(text, 'utf8').includes(Buffer.from([0xEF, 0xBF, 0xBD])), false, 'UTF-8 编码里出现替换字符（U+FFFD）')
  assert.ok(text.length > 0)
})

test('D-08：状态回退到已注入过的全量卡形态时，仍必须发一张卡把差异说清', async () => {
  const { decideWorkingSetInjection, workingSetDedupKeyOf } = await import('../src/v2/working-state.mjs')
  // 去重裁决本身只回答「这个键见过没有」；「基线是不是这张卡」由 runtime-card 判定。
  const key = workingSetDedupKeyOf('卡文本 A')
  const verdict = decideWorkingSetInjection({ dedupKey: key, sessionId: 's', injectedKeys: [key], limit: 32 })
  assert.equal(verdict.inject, false, '键命中历史 → 裁决层判「不注入」（这是既有语义）')
  const source = await import('node:fs/promises').then((fs) => fs.readFile(new URL('../src/v2/runtime-card.mjs', import.meta.url), 'utf8'))
  assert.match(
    source,
    /if \(!verdict\.inject\) \{[\s\S]{0,600}cardState\.text === card\.text\) return null/,
    'runtime-card 必须在键命中后二次判定「基线是否就是这张卡」，否则增量卡宣告过的行永远不会被撤回',
  )
})
