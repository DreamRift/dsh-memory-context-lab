/**
 * AUD50-06-01（B2-9）：status 的「生效设置行」丢失 4 个全局键。
 *
 * 修前：mergeSessionSettings 只回 6 个键，turnBasis / fullHistory / planFirst /
 * autoRestore 在合并结果里不存在，settingsLine 只好各自回落默认——同一份 status
 * 出现「轮次判定 DSH 轮次」（模式行读 settingsNow）与「轮次判定 真人消息（默认）」
 * （生效设置行读合并结果）并存的自相矛盾；config show 是对的。
 * 修法：mergeSessionSettings 先铺全局键再覆写覆盖项；settingsLine 上移模块作用域
 * 并导出（与 archiveLine 同先例），供守卫测试与命令面共用同一实现。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { mergeSessionSettings } from '../src/v3/domain/session/session-control.mjs'
import { readSettings, settingsLine, SETTINGS_DEFAULTS } from '../src/index.mjs'

const NON_DEFAULT = { ...SETTINGS_DEFAULTS, turnBasis: "dsh", planFirst: true, autoRestore: false }

test('B2-9 无覆盖时：生效设置行与 config show（settingsNow）逐字一致', () => {
  const globals = readSettings(NON_DEFAULT)
  const merged = mergeSessionSettings(globals, null)
  assert.equal(settingsLine(merged), settingsLine(globals), '生效设置行不得与全局设置自相矛盾')
  assert.match(settingsLine(merged), /轮次判定 DSH 轮次/)
  assert.match(settingsLine(merged), /计划先行默认 开/)
  assert.match(settingsLine(merged), /停用恢复 关/)
})

test('B2-9 合并结果携带全部全局键（readSettings 键集逐键存在）', () => {
  const globals = readSettings(NON_DEFAULT)
  const merged = mergeSessionSettings(globals, { enabled: true, recall: true, overrides: {} })
  for (const key of Object.keys(SETTINGS_DEFAULTS)) {
    assert.ok(key in merged, '合并结果缺全局键：' + key)
    assert.equal(merged[key], globals[key], "键 " + key + " 的值必须来自全局设置")
  }
})

test('B2-9 会话覆盖仍生效：limit/gate 覆盖，其余跟随全局', () => {
  const globals = readSettings(NON_DEFAULT)
  const merged = mergeSessionSettings(globals, { enabled: true, recall: true, overrides: { limit: 3, gate: 5 } })
  assert.equal(settingsLine(merged).includes('条数 3'), true, 'limit 覆盖生效')
  assert.match(settingsLine(merged), /按步闸门 5%/, 'gate 覆盖生效（AUD-04 既有口径不回退）')
  assert.match(settingsLine(merged), /轮次判定 DSH 轮次/, '覆盖项不得挤掉全局键')
})

test('B2-9 默认设置不回归', () => {
  const globals = readSettings({ ...SETTINGS_DEFAULTS })
  const merged = mergeSessionSettings(globals, null)
  assert.equal(settingsLine(merged), settingsLine(globals))
  assert.match(settingsLine(merged), /轮次判定 真人消息/)
  assert.match(settingsLine(merged), /计划先行默认 关/)
})
