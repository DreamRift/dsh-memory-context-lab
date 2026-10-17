/**
 * S1 只读盘点单元兜底红例（0.10.1 第二批）：claim 进工作状态卡。
 *
 * 方案 §7：只读盘点结论给**全局有界配额**（不是每单元无限兜底），按当前
 * 对象/阶段选择；否定/更正可见（不被 positive 淹没）；版本变化标 stale 由
 * 既有 stale-evidence 机制承担。claim 行必须自报 unverified。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildWorkingState, renderWorkingSetInjection, WORKING_SET_DEFAULTS, RETENTION_CLASSES } from '../src/v2/working-state.mjs'

const SESSION_ID = 'session-s1-card'

function stateWithClaims(claims) {
  return buildWorkingState({
    sessionId: SESSION_ID,
    surfaceNodes: [],
    eventAt: () => null,
    openCalls: [],
    lastAssistantSeq: null,
    now: 0,
    constraints: [{ text: '不要修改 runtime.mjs', sourceRef: 'seq:1' }],
    claims,
  })
}

test('S1-R1 claims 进卡：软保留池出现助手结论条目，行内带极性/原句/unverified', () => {
  const state = stateWithClaims([
    { value: '已完成：检索修复。', polarity: 'positive', verified: false, recordRef: 't00000001-r0001' },
    { value: '但尚未通过复审。', polarity: 'negated', verified: false, recordRef: 't00000001-r0002' },
  ])
  const items = state.retention[RETENTION_CLASSES.UNVERIFIED_EVIDENCE] ?? []
  const claimItems = items.filter((item) => (item.itemId ?? '').startsWith('assistant-claim:'))
  assert.equal(claimItems.length, 2, '两条 claim 都进池')
  const lines = claimItems.map((item) => item.lines.join('\n')).join('\n')
  assert.match(lines, /已完成：检索修复。/, '原句保留')
  assert.match(lines, /尚未通过复审/)
  assert.match(lines, /unverified/, '行内自报 unverified（不冒充事实）')
  assert.match(lines, /助手结论/, '段标题声明这是助手结论')

  // 渲染面：大预算下软保留段可见 claim 行。
  const card = renderWorkingSetInjection(state, { budgetTokens: 40000 })
  assert.match(card.text, /助手结论/)
})

test('S1-R2 有界配额：maxAssistantClaims 上限截断，超出只报数量', () => {
  const claims = []
  for (let i = 0; i < 40; i += 1) {
    claims.push({ value: '已完成：第 ' + i + ' 项。', polarity: 'positive', verified: false, recordRef: 'r' + i })
  }
  const state = buildWorkingState({
    sessionId: SESSION_ID,
    surfaceNodes: [],
    eventAt: () => null,
    openCalls: [],
    lastAssistantSeq: null,
    now: 0,
    claims,
  })
  const items = state.retention[RETENTION_CLASSES.UNVERIFIED_EVIDENCE] ?? []
  const claimItems = items.filter((item) => (item.itemId ?? '').startsWith('assistant-claim:') && (item.itemId ?? '') !== 'assistant-claim:overflow')
  assert.ok(claimItems.length <= (WORKING_SET_DEFAULTS.maxAssistantClaims ?? 8),
    'claim 条目数受 maxAssistantClaims 上限约束，实际 ' + claimItems.length)
  // 超出部分有「只报数量」的溢出行。
  if (claims.length > (WORKING_SET_DEFAULTS.maxAssistantClaims ?? 8)) {
    const overflow = items.find((item) => (item.itemId ?? '') === 'assistant-claim:overflow')
    assert.ok(overflow, '超出上限必须只报数量（不静默丢）')
  }
})

test('S1-R3 否定/更正可见：negated/retracted claim 标 required（不被预算先丢）', () => {
  const state = stateWithClaims([
    { value: '已完成：接线。', polarity: 'positive', verified: false, recordRef: 'r1' },
    { value: '更正：先前的结论不成立。', polarity: 'retracted', verified: false, recordRef: 'r2' },
    { value: '尚未通过复审。', polarity: 'negated', verified: false, recordRef: 'r3' },
  ])
  const items = state.retention[RETENTION_CLASSES.UNVERIFIED_EVIDENCE] ?? []
  const byId = new Map(items.map((item) => [item.itemId, item]))
  const retracted = byId.get('assistant-claim:r2')
  const negated = byId.get('assistant-claim:r3')
  assert.ok(retracted, 'retracted claim 必须在盘点里')
  assert.ok(negated, 'negated claim 必须在盘点里')
  assert.equal(retracted.required, true, '撤回结论必须 required（否定/更正可见）')
  assert.equal(negated.required, true, '否定结论必须 required')
  assert.notEqual(byId.get('assistant-claim:r1').required, true, 'positive claim 不标 required（不冒充已完成）')
})

test('S1-R4 无 claims 时不产出 claim 条目：卡片形状向后兼容', () => {
  const state = stateWithClaims([])
  const items = state.retention[RETENTION_CLASSES.UNVERIFIED_EVIDENCE] ?? []
  const claimItems = items.filter((item) => (item.itemId ?? '').startsWith('assistant-claim:'))
  assert.equal(claimItems.length, 0)
  const card = renderWorkingSetInjection(state, { budgetTokens: 40000 })
  assert.doesNotMatch(card.text, /助手结论/)
})
