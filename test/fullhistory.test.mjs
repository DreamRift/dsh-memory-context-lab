/**
 * 全历史记忆上下文模式（v2 `fullHistory`）回归测试。
 *
 * 用户契约：
 * - 开启后除「必要完整历史」外全部可退热：全部人类 user 消息原位保留（顺序
 *   自然保持在凭证之间）、退热凭证不再退热（不可压缩）、系统头保留；
 * - 「保留最近操作」整体失效（retentionFromIndex = 0），留下与否完全由守卫与
 *   保护层按证据安全裁决；
 * - 计划工件（exit_plan_mode 调用与计划全文）任何模式下都不退热；
 * - 关闭后（fullHistory=false）行为回到默认：只有最新人类请求受保护，保留窗口
 *   恢复生效。
 *
 * 只测收集器（collectHistoryCandidates）与投影折叠这两个纯函数面；引擎级行为
 * 由 v2-runtime / v2-matrix 覆盖。全程内存事件表。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { collectHistoryCandidates, describeHistorySkip } from '../src/v2/history.mjs'
import { V2_RECEIPT_MARKER, RECEIPT_MARKER } from '../src/core.mjs'

/** `{ seq: event }` 事件表 → view 用的 eventAt。 */
function readerOf(table) {
  return (seq) => table.get(seq) ?? null
}

function systemHead() {
  return { type: 'system/message', data: { message: { id: 'sys', role: 'system', content: [{ type: 'text', text: 'system prompt' }], source: { kind: 'system-prompt' } } } }
}

function humanUser(text, id = 'u') {
  // surfaceOp:'append' 是宿主活动面事件的标配：v2 收集器靠它区分「原始事件」与
  // 「已被表层替换的替换文本」（替换后不再是 append，对应 already-archived）。
  return { type: 'user/message', surfaceOp: 'append', data: { message: { id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user', rpcId: `rpc-${id}` } } } }
}

function pluginUser(text, form = 'working-state') {
  // 真实写入端带 source.form（PLUGIN_SOURCE_FORMS），读取端靠它区分插件消息与人类输入。
  return { type: 'user/message', surfaceOp: 'append', data: { message: { id: 'card', role: 'user', content: [{ type: 'text', text }], source: { kind: 'user', form } } } }
}

function assistantText(text, id = 'a') {
  return { type: 'assistant/message', surfaceOp: 'append', data: { turn: 1, step: 1, message: { id, role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model', provider: 'fake', model: 'fake-model' } } } }
}

function assistantCall(callId, name = 'read') {
  return { type: 'assistant/message', surfaceOp: 'append', data: { turn: 1, step: 1, message: { id: `m-${callId}`, role: 'assistant', content: [{ type: 'tool-call', id: callId, name, arguments: '{}' }], source: { kind: 'model', provider: 'fake', model: 'fake-model' } } } }
}

function toolResult(callId, text = 'x'.repeat(2000)) {
  return { type: 'tool/result', surfaceOp: 'append', data: { turn: 1, step: 1, message: { id: `r-${callId}`, role: 'tool', content: [{ type: 'text', text }], source: { kind: 'tool', callId }, toolCallId: callId } } }
}

/** seq 从 1 开始连续编号的事件表。 */
function numbered(events) {
  const table = new Map()
  events.forEach((event, index) => table.set(index + 1, event))
  return { surfaceNodes: events.map((_, index) => index + 1), eventAt: readerOf(table) }
}

function skippedOf(result) {
  return Object.fromEntries(result.skipped.map((row) => [row.seq, row.reason]))
}

test('fullHistory：全部人类 user 消息原位保留，插件卡片与助手文本仍可退热', () => {
  const events = [
    systemHead(),               // 1
    humanUser('第一个需求'),      // 2
    assistantText('旧回复' + '长'.repeat(300)), // 3
    assistantCall('call-1'),    // 4
    toolResult('call-1'),       // 5
    pluginUser('[工作状态卡] ' + '长'.repeat(300)), // 6
    humanUser('第二个需求'),      // 7
    assistantCall('call-2'),    // 8
    toolResult('call-2'),       // 9
  ]
  const view = { ...numbered(events), retainOperations: 1, fullHistory: true, minimumChars: 100, lastAssistantSeq: null }
  const result = collectHistoryCandidates(view)
  const skip = skippedOf(result)
  assert.equal(skip[2], 'protected-user-history')
  assert.equal(skip[7], 'protected-user-history')
  assert.equal(skip[1], 'protected-system-head')
  // 助手旧文本与插件卡片都是候选，不受保留窗口影响。
  const candidateStarts = result.candidates.map((c) => c.rangeStart)
  assert.ok(candidateStarts.includes(3), `旧助手文本应可退热，candidates: ${JSON.stringify(candidateStarts)}`)
  assert.ok(candidateStarts.includes(6), `插件工作状态卡应可退热，candidates: ${JSON.stringify(candidateStarts)}`)
  // 全历史模式忽略 retainOperations=1：call-1 操作也应是候选。
  assert.ok(candidateStarts.includes(4), `保留窗口失效，旧操作应可退热，candidates: ${JSON.stringify(candidateStarts)}`)
})

test('fullHistory：v1/v2 退热凭证不再退热（不可压缩）', () => {
  const events = [
    systemHead(), // 1
    humanUser('需求'), // 2
    pluginUser(`${V2_RECEIPT_MARKER} 工具 read，冷记录 cold-1，hash abc`), // 3
    pluginUser(`${RECEIPT_MARKER} 工具 read，冷记录 cold-2，hash def`), // 4
  ]
  const view = { ...numbered(events), retainOperations: 0, fullHistory: true, minimumChars: 0, lastAssistantSeq: null }
  const skip = skippedOf(collectHistoryCandidates(view))
  assert.equal(skip[3], 'protected-receipt-voucher')
  assert.equal(skip[4], 'protected-receipt-voucher')
})

test('fullHistory：v1 命令回执（[已归档操作]）同样按凭证保护', () => {
  const events = [
    systemHead(),
    pluginUser('[已归档操作] 工具 read → 冷记录 cold-1'),
  ]
  const view = { ...numbered(events), retainOperations: 0, fullHistory: true, minimumChars: 0, lastAssistantSeq: null }
  const skip = skippedOf(collectHistoryCandidates(view))
  assert.equal(skip[2], 'protected-receipt-voucher')
})

test('计划工件：exit_plan_mode 调用头在任何模式下都不可退热', () => {
  for (const fullHistory of [false, true]) {
    const events = [
      systemHead(), // 1
      humanUser('开始'), // 2
      { type: 'assistant/message', data: { turn: 1, step: 1, message: { id: 'm-plan', role: 'assistant', content: [
        { type: 'text', text: '计划如下' },
        { type: 'tool-call', id: 'call-plan', name: 'exit_plan_mode', arguments: JSON.stringify({ plan: '# 开发计划\n全文' }) },
      ], source: { kind: 'model', provider: 'fake', model: 'fake-model' } } } }, // 3
      { type: 'tool/result', data: { turn: 1, step: 1, message: { id: 'r-plan', role: 'tool', content: [{ type: 'text', text: '已退出计划模式' }], source: { kind: 'tool', callId: 'call-plan' }, toolCallId: 'call-plan' } } }, // 4
    ]
    const view = { ...numbered(events), retainOperations: 0, fullHistory, minimumChars: 0, lastAssistantSeq: null }
    const skip = skippedOf(collectHistoryCandidates(view))
    assert.equal(skip[3], 'protected-plan-artifact', `fullHistory=${fullHistory} 时计划调用头必须受保护`)
    assert.ok(['orphan-result', 'already-archived', 'protected-plan-artifact'].includes(skip[4] ?? ''), '计划结果留在活动面')
  }
})

test('默认模式（fullHistory=false）：旧人类消息可退热，保留窗口生效', () => {
  const events = [
    systemHead(), // 1
    humanUser('旧需求' + '详'.repeat(200), 'u-old'), // 2
    assistantText('旧回复' + '长'.repeat(300)), // 3
    humanUser('最新需求', 'u-new'), // 4
  ]
  const view = { ...numbered(events), retainOperations: 0, fullHistory: false, minimumChars: 100, lastAssistantSeq: null }
  const result = collectHistoryCandidates(view)
  const skip = skippedOf(result)
  assert.ok(
    ['protected-latest-human-request', 'protected-latest-user'].includes(skip[4]),
    `最新人类消息必须受保护，got: ${skip[4]}`,
  )
  // 旧人类消息不在保护集里（可按普通段退热），旧助手文本是候选。
  assert.equal(skip[2], undefined)
  assert.ok(result.candidates.some((c) => c.rangeStart === 2))
  assert.ok(result.candidates.some((c) => c.rangeStart === 3))
})

test('skip 描述：新保护理由有人类可读文案', () => {
  for (const reason of ['protected-user-history', 'protected-receipt-voucher', 'protected-plan-artifact']) {
    const text = describeHistorySkip(reason)
    assert.ok(typeof text === 'string' && text.length > 0, `${reason} 需要可读描述`)
  }
})
