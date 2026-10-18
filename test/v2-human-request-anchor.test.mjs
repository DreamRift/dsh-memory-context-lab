/**
 * P1-2 任务锚回归 + 旧日志覆盖（0.12.0）。
 *
 * 缺陷：`core.mjs` 已登记 `SURFACE_RECEIPT`，但 `isReceiptMessage` 只认
 * `[已归档操作]` 与 `[已归档操作·v2]`，**不认 `[已折叠工作卡·v2]`**——无
 * `source.form` 的旧折叠回执仍会被当成人类请求。实测 8 张卡把折叠回执
 * seq（1480/1621/1631/2276）当「当前人类请求」。
 *
 * 不变量：四种注入形态（回执 / 折叠回执 / 聚合凭证 / 工作卡）都不得被
 * 「最新人类请求」选中；真实人类消息仍被选中；多轮注入后锚不漂移。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  AGG_VOUCHER_MARKER,
  FOLD_RECEIPT_MARKER,
  isHumanAuthoredMessage,
  isPluginAuthoredMessage,
  isReceiptMessage,
  isSurfaceInjectionText,
  RECEIPT_MARKER,
  SURFACE_INJECTION_MARKERS,
  V2_RECEIPT_MARKER,
} from '../src/core.mjs'
import { collectHistoryCandidates } from '../src/v2/history.mjs'
import { CARD_HEADER } from '../src/v2/working-state.mjs'

function message(text, { kind = 'user', form = null } = {}) {
  return {
    content: [{ type: 'text', text }],
    source: form === null ? { kind } : { kind, form },
  }
}

function eventOf(text, { seq = 1, form = null, flat = false } = {}) {
  const source = form === null ? { kind: 'user' } : { kind: 'user', form }
  const data = flat
    ? { content: [{ type: 'text', text }], source }
    : { message: { id: 'm' + seq, role: 'user', content: [{ type: 'text', text }], source } }
  return { type: 'user/message', surfaceOp: 'append', data }
}

test('P1-2a 四种注入形态都被认作程序注入（标记单一出处）', () => {
  assert.deepEqual([...SURFACE_INJECTION_MARKERS], [RECEIPT_MARKER, V2_RECEIPT_MARKER, FOLD_RECEIPT_MARKER, AGG_VOUCHER_MARKER])
  assert.equal(isSurfaceInjectionText(RECEIPT_MARKER + '\n工具：read'), true)
  assert.equal(isSurfaceInjectionText(V2_RECEIPT_MARKER + '\n工具：read'), true)
  assert.equal(isSurfaceInjectionText(FOLD_RECEIPT_MARKER + '\n折叠卡 2 张'), true)
  assert.equal(isSurfaceInjectionText(AGG_VOUCHER_MARKER + '\n凭证：agg-1-3-abcdef'), true)
  assert.equal(isSurfaceInjectionText('帮我修一下这个测试'), false)
  assert.equal(isSurfaceInjectionText(''), false)
  assert.equal(isSurfaceInjectionText(null), false)
})

test('P1-2b 旧日志形态（没有 source.form，只靠正文标记）也不被当成人类请求', () => {
  for (const marker of [FOLD_RECEIPT_MARKER, AGG_VOUCHER_MARKER]) {
    const old = { content: [{ type: 'text', text: marker + '\n程序生成' }], source: { kind: 'user' } }
    assert.equal(isReceiptMessage(old), true, marker + ' 必须被识别为回执')
    assert.equal(isPluginAuthoredMessage(old), true)
    assert.equal(isHumanAuthoredMessage(old), false)
  }
})

test('P1-2c 工作卡靠 source.form 判定（正文头不是回执标记，旧日志也带 form）', () => {
  const card = message(CARD_HEADER + '\n■ 保护集…', { form: 'working-state' })
  assert.equal(isPluginAuthoredMessage(card), true)
  assert.equal(isHumanAuthoredMessage(card), false)
  // 没有 form 但正文以卡片头开头：这不是回执标记，无法回溯判定——如实当人类输入，
  // 不做启发式猜测（宁可多保护一段，也不把用户请求判成插件消息）。
  const formless = message(CARD_HEADER + '\n■ 保护集…')
  assert.equal(isReceiptMessage(formless), false)
})

test('P1-2d 收集器：四种注入形态都不占「最新人类请求」保护位，真实人类消息仍被选中', () => {
  const events = [
    { type: 'system/message', data: { message: { id: 'sys', role: 'system', content: [{ type: 'text', text: 'sys' }], source: { kind: 'system-prompt' } } } },
    eventOf('真实的人类请求', { seq: 2 }),
    eventOf(FOLD_RECEIPT_MARKER + '\n折叠卡 2 张', { seq: 3 }),
    eventOf(AGG_VOUCHER_MARKER + '\n凭证：agg-1-3-abcdef', { seq: 4 }),
    eventOf(V2_RECEIPT_MARKER + '\n工具：read', { seq: 5 }),
    eventOf(CARD_HEADER + '\n■ 保护集…', { seq: 6, form: 'working-state' }),
  ]
  const table = new Map(events.map((event, index) => [index + 1, event]))
  const view = {
    surfaceNodes: events.map((_, index) => index + 1),
    eventAt: (seq) => table.get(seq) ?? null,
    // 非全历史模式：锚的保护位是唯一会占用「人类请求」位的规则，
    // 不会被 fullHistory 的「人类消息全部保护」覆盖成另一个原因。
    retainOperations: 0,
    fullHistory: false,
    minimumChars: 0,
    lastAssistantSeq: null,
  }
  const result = collectHistoryCandidates(view)
  const skip = Object.fromEntries(result.skipped.map((row) => [row.seq, row.reason]))
  assert.equal(skip[2], 'protected-latest-human-request', '锚必须落在真实人类请求上')
  for (const seq of [3, 4, 5]) {
    assert.notEqual(skip[seq], 'protected-latest-human-request', '注入形态 seq ' + seq + ' 不得占用人类请求锚')
    assert.notEqual(skip[seq], 'protected-latest-user', '注入形态 seq ' + seq + ' 不得占用「最新用户消息」位')
  }
})

test('P1-2e 20 轮注入后锚仍指向真实人类请求（seq:2），不漂移到最后一条注入', () => {
  const events = [
    { type: 'system/message', data: { message: { id: 'sys', role: 'system', content: [{ type: 'text', text: 'sys' }], source: { kind: 'system-prompt' } } } },
    eventOf('真实的人类请求', { seq: 2 }),
  ]
  let seq = 3
  for (let round = 0; round < 20; round += 1) {
    events.push(eventOf(FOLD_RECEIPT_MARKER + '\n折叠卡 2 张（第 ' + round + ' 轮）', { seq: seq++ }))
    events.push(eventOf(CARD_HEADER + '\n■ 保护集（第 ' + round + ' 轮）', { seq: seq++, form: 'working-state' }))
  }
  const table = new Map(events.map((event, index) => [index + 1, event]))
  const view = {
    surfaceNodes: events.map((_, index) => index + 1),
    eventAt: (s) => table.get(s) ?? null,
    // 非全历史模式：锚的保护位是唯一会占用「人类请求」位的规则，
    // 不会被 fullHistory 的「人类消息全部保护」覆盖成另一个原因。
    retainOperations: 0,
    fullHistory: false,
    minimumChars: 0,
    lastAssistantSeq: null,
  }
  const result = collectHistoryCandidates(view)
  const skip = Object.fromEntries(result.skipped.map((row) => [row.seq, row.reason]))
  assert.equal(skip[2], 'protected-latest-human-request')
  const anchored = Object.entries(skip).filter(([, reason]) => reason === 'protected-latest-human-request')
  assert.deepEqual(anchored.map(([seqText]) => Number(seqText)), [2], '人类请求锚只能有一个，且必须是 seq:2')
})

test('P1-2f 扁平形状（data.content，真实回执写入形态）同样覆盖', () => {
  const events = [
    { type: 'system/message', data: { message: { id: 'sys', role: 'system', content: [{ type: 'text', text: 'sys' }], source: { kind: 'system-prompt' } } } },
    eventOf('真实的人类请求', { seq: 2, flat: true }),
    eventOf(FOLD_RECEIPT_MARKER + '\n折叠卡 2 张', { seq: 3, flat: true }),
  ]
  const table = new Map(events.map((event, index) => [index + 1, event]))
  const view = {
    surfaceNodes: events.map((_, index) => index + 1),
    eventAt: (s) => table.get(s) ?? null,
    // 非全历史模式：锚的保护位是唯一会占用「人类请求」位的规则，
    // 不会被 fullHistory 的「人类消息全部保护」覆盖成另一个原因。
    retainOperations: 0,
    fullHistory: false,
    minimumChars: 0,
    lastAssistantSeq: null,
  }
  const skip = Object.fromEntries(collectHistoryCandidates(view).skipped.map((row) => [row.seq, row.reason]))
  assert.equal(skip[2], 'protected-latest-human-request')
  assert.notEqual(skip[3], 'protected-latest-human-request')
})