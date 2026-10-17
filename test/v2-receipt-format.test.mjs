/**
 * 回执格式版本化测试（0.10.1 S2c）。
 *
 * 缺陷：buildReceipt 用 `formatVersion >= RECEIPT_FORMAT_VERSION` 决定附加行——
 * 常量递增后 format 2 旧行的 locator/status 行被丢弃，恢复时重建正文与存档
 * 不一致，旧回执被整体拒绝恢复（取证 R0 问题 4 实证；docs/0.10.1-方案复核
 * §5「旧回执恢复必须隔离保留」）。编号冲突：3 已被 RECEIPT_FORMAT_BATCH
 * 占用，新格式必须是 4（R0 新发现）。
 *
 * 判据：
 * - buildReceipt 显式 dispatch：format 1 无附加行；format 2 有 locator/status；
 *   format 4 在 2 的基础上多「记录 ID 指路」行（规划期 recordId 未产生，指路到
 *   S2a 别名回读——取证 §6 S2c 预判的回退路径）；
 * - 旧 format（1/2/3）restore-only：行内 receiptFormat 恒定重建，不随常量递增漂移；
 * - 未知 formatVersion 抛错（失败关闭，不猜测渲染）。
 *
 * 不适用条件：本套件不测恢复整链路（session.test.mjs / v2-e2e.test.mjs 负责）；
 * 批次摘要 format 3 的渲染由 buildBatchReceipt 单独负责。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  RECEIPT_FORMAT_BATCH,
  RECEIPT_FORMAT_LEGACY,
  RECEIPT_FORMAT_VERSION,
  buildReceipt,
  buildSpanReceipt,
  buildBatchReceipt,
  RECEIPT_MARKER,
  V2_RECEIPT_MARKER,
} from '../src/core.mjs'

const baseArgs = () => ({
  tools: ['read', 'edit'],
  range: { start: 2, end: 5 },
  callIds: ['call-1', 'call-2'],
  nodeId: 'mcl2-key-001_p1',
  hash: 'a'.repeat(64),
  chars: 1200,
  tokens: 800,
  chunks: 2,
  marker: V2_RECEIPT_MARKER,
  locators: [{ file: 'a.txt' }, { file: 'b.txt' }],
  statuses: [{ status: 'exit 0' }, { status: 'exit 1' }],
})

test('格式常量：版本 4 未与批次格式 3 冲突', () => {
  assert.equal(RECEIPT_FORMAT_VERSION, 4)
  assert.equal(RECEIPT_FORMAT_BATCH, 3)
  assert.equal(RECEIPT_FORMAT_LEGACY, 1)
})

test('显式 dispatch：format 1（legacy）不带 locator/status/记录 ID 行', () => {
  const text = buildReceipt({ ...baseArgs(), formatVersion: 1 })
  assert.ok(!text.includes('对象：'), 'format 1 不得渲染 locator 行')
  assert.ok(!text.includes('状态：'), 'format 1 不得渲染 status 行')
  assert.ok(!text.includes('记录 ID'), 'format 1 不得渲染记录 ID 行')
  assert.ok(text.includes('冷记录：mcl2-key-001_p1'))
})

test('显式 dispatch：format 2 有 locator/status 行，无记录 ID 行', () => {
  const text = buildReceipt({ ...baseArgs(), formatVersion: 2 })
  assert.ok(text.includes('对象：'), 'format 2 必须渲染 locator 行')
  assert.ok(text.includes('状态：'), 'format 2 必须渲染 status 行')
  assert.ok(!text.includes('记录 ID'), 'format 2 不得渲染记录 ID 行（那是 format 4 的新增）')
})

test('显式 dispatch：format 4 在 format 2 基础上多「记录 ID 指路」行', () => {
  const text = buildReceipt({ ...baseArgs(), formatVersion: 4 })
  assert.ok(text.includes('对象：'), 'format 4 必须渲染 locator 行')
  assert.ok(text.includes('状态：'), 'format 4 必须渲染 status 行')
  assert.ok(text.includes('记录 ID'), 'format 4 必须渲染记录 ID 行')
  assert.ok(text.includes('mcl2-key-001'), '记录 ID 行必须指路到 nodeId 别名回读')
})

test('显式 dispatch：format 4 带可用 recordIds 时渲染记录 ID', () => {
  const text = buildReceipt({ ...baseArgs(), formatVersion: 4, recordIds: ['t00000001-r0001', 't00000001-r0002'] })
  assert.ok(text.includes('t00000001-r0001'), 'format 4 有 recordIds 时必须渲染真实记录 ID')
  assert.ok(text.includes('t00000001-r0002'))
})

test('失败关闭：未知 formatVersion 抛错，不猜测渲染', () => {
  assert.throws(() => buildReceipt({ ...baseArgs(), formatVersion: 5 }))
  assert.throws(() => buildReceipt({ ...baseArgs(), formatVersion: 0 }))
})

test('恢复隔离：旧行（format 1/2）的重建不随 RECEIPT_FORMAT_VERSION 递增漂移', () => {
  // 恢复侧按行内 receiptFormat 重建；这里的守卫是「常量递增后，显式 dispatch
  // 的 format 2 渲染与升版前逐字节一致」——即 dispatch 表是冻结的历史版本映射，
  // 不是「>= 最新」的相对判断。
  const f2 = buildReceipt({ ...baseArgs(), formatVersion: 2 })
  const f2Again = buildReceipt({ ...baseArgs(), formatVersion: 2 })
  assert.equal(f2, f2Again, '同参渲染必须确定性')
  const f1 = buildReceipt({ ...baseArgs(), formatVersion: 1 })
  assert.notEqual(f1, f2, 'format 1 与 2 的渲染必须可区分')
  const f4 = buildReceipt({ ...baseArgs(), formatVersion: 4 })
  assert.notEqual(f4, f2, 'format 4 与 2 的渲染必须可区分')
  // format 4 = format 2 的行集 + 记录 ID 行：f4 必须包含 f2 的全部行。
  const f4Lines = new Set(f4.split('\n'))
  for (const line of f2.split('\n')) assert.ok(f4Lines.has(line), `format 4 必须包含 format 2 的行：${line}`)
})

test('批次摘要 format 3 渲染不受常量递增影响', () => {
  const text = buildBatchReceipt({
    members: [{
      tools: ['read'],
      range: { start: 2, end: 5 },
      callIds: ['call-1'],
      nodeId: 'mcl2-key-001_p1',
      hash: 'a'.repeat(64),
      chars: 1200,
      tokens: 800,
      chunks: 2,
    }],
  })
  assert.ok(text.includes('批次归档'))
  assert.ok(text.includes('冷记录 mcl2-key-001_p1'))
})
