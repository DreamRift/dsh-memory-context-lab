/**
 * P1-4 卡片角色/编号一致性（0.12.0，降级版）。
 *
 * 旧提案的「同 seq 冲突」在 107 张卡里 **0 次复现**（human 取 user seq、unexposed
 * 取 tool/result seq，结构上不可能相同）；真实问题只有「当前请求滞后」（8 张卡锚到
 * 折叠回执）。所以本轮**不引入 req:/evt: 双命名空间**，只补两条可执行断言：
 * - 新 user 事件到达后锚立即切换；
 * - 取不到时显示 unknown，不回落上一轮；
 * - 同一 seq 不得同时出现在两类硬保护，违反时降级为「角色未确认」。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { buildWorkingState, PROTECTION_CLASSES, resolveProtectionIdentity } from '../src/v2/working-state.mjs'

function userEvent(seq, text) {
  return {
    type: 'user/message',
    surfaceOp: 'append',
    // 真实 user/message 是扁平形状（content/source 直接挂在 data 上）。
    data: { id: 'u' + seq, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user', rpcId: 'rpc' + seq } },
  }
}

function buildWith(events, surfaceNodes) {
  const table = new Map(events.map((event, index) => [surfaceNodes[index], event]))
  return buildWorkingState({
    sessionId: 'anchor-test',
    surfaceNodes,
    eventAt: (seq) => table.get(seq) ?? null,
  })
}

function humanRequestItem(state) {
  return (state.protectedSet ?? []).find((item) => item.protectionClass === PROTECTION_CLASSES.HUMAN_REQUEST)
}

test('P1-4a 新 user 事件到达后锚立即切换（取本轮 user 事件，不回落上一轮）', () => {
  const first = buildWith([userEvent(2, '第一轮请求')], [2])
  const firstItem = humanRequestItem(first)
  assert.match(firstItem.lines[0], /第一轮请求/)
  assert.equal(firstItem.role, 'user')
  assert.equal(firstItem.kind, 'human-request')

  // 第二轮：旧请求仍在面上，但新请求是新的锚。
  const second = buildWith([userEvent(2, '第一轮请求'), userEvent(5, '第二轮请求')], [2, 5])
  const secondItem = humanRequestItem(second)
  assert.match(secondItem.lines[0], /第二轮请求/)
  // 没有记录 ID 映射时 ref 如实退回 host-seq 形态（readable:false），不编造稳定 ID。
  assert.equal(secondItem.sourceRef, 'seq:5')
})

test('P1-4b 取不到人类请求时显式 unknown，不回落上一轮', () => {
  const state = buildWith([], [])
  const item = humanRequestItem(state)
  assert.ok(item, '该保护位必须保留（不能当作「没有请求」）')
  assert.equal(item.itemId, 'human-request:missing')
  assert.match(item.lines[0], /未能从表面确定性提取/)
  assert.match(item.lines[0], /不猜/)
})

test('P1-4c 同一 seq 出现在两类硬保护时降级为「角色未确认」，并给出告警', () => {
  const items = [
    { protectionClass: PROTECTION_CLASSES.HUMAN_REQUEST, sourceRef: '7', itemId: 'human-request:7', lines: ['x'] },
    { protectionClass: PROTECTION_CLASSES.UNEXPOSED_RESULT, sourceRef: '7', itemId: 'unexposed:7', lines: ['y'] },
    { protectionClass: PROTECTION_CLASSES.HUMAN_REQUEST, sourceRef: '9', itemId: 'human-request:9', lines: ['z'] },
  ]
  const resolved = resolveProtectionIdentity(items)
  assert.deepEqual(resolved.duplicates, ['7'])
  assert.equal(resolved.degraded, true)
  const conflicted = resolved.items.filter((item) => item.sourceRef === '7')
  for (const item of conflicted) {
    assert.equal(item.role, 'unknown', '冲突项不得被同时标成两类角色')
    assert.equal(item.kind, 'unconfirmed')
  }
  const clean = resolved.items.find((item) => item.sourceRef === '9')
  assert.equal(clean.role, 'user')
  assert.equal(clean.kind, 'human-request')
})

test('P1-4d 不冲突时卡片状态不带 identityWarnings（不引入噪声）', () => {
  const state = buildWith([userEvent(2, '请求')], [2])
  assert.deepEqual(state.identityWarnings, [])
  for (const item of state.protectedSet) {
    assert.equal(item.role === 'unknown', false, '无冲突时不得降级：' + item.itemId)
  }
})
