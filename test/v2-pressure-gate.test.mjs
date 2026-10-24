/**
 * 0.13.0 压力闸门（pressure.mjs + 回放夹具）。
 *
 * 缺陷背景：实测会话 246 步、占用 8.3%–13.5%，插件仍每 2.7 步做一次前缀替换
 * （92 次失效、103,083 个未命中 token），而释放的是最便宜的缓存读。
 *
 * 本套件锁死四条：
 *   G1 低占用不开闸；G2 高占用开闸；
 *   G3 滞回：开闸后要掉到 exit 以下才关，不在 enter 附近抖动；
 *   G4 占用率不可判定时失败关闭（不猜）。
 *
 * 另附一条回放断言：把真实会话的占用序列喂进闸门，归档次数必须为 0。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  decidePressureGate,
  hysteresisPercentOf,
  occupancyPercentOf,
  PRESSURE_DEFAULTS,
} from '../src/v2/pressure.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))

test('G1 低占用（13.5%）不开闸', () => {
  const verdict = decidePressureGate({ occupancyPercent: 13.5, enterPercent: 20 })
  assert.equal(verdict.open, false)
  assert.equal(verdict.reason, 'below-enter')
})

test('G2 高占用（21%）开闸', () => {
  const verdict = decidePressureGate({ occupancyPercent: 21, enterPercent: 20 })
  assert.equal(verdict.open, true)
  assert.equal(verdict.reason, 'above-enter')
})

test('G3 滞回：开闸后 17% 仍开（未到 exit 15%），掉到 14% 才关', () => {
  const stillOn = decidePressureGate({ occupancyPercent: 17, coolingOn: true, enterPercent: 20 })
  assert.equal(stillOn.open, true, '在滞回区内应保持开闸')
  const nowOff = decidePressureGate({ occupancyPercent: 14, coolingOn: true, enterPercent: 20 })
  assert.equal(nowOff.open, false)
  assert.equal(nowOff.reason, 'below-exit')
})

test('G3b 未开闸时 17% 不开（必须越过 enter）', () => {
  const verdict = decidePressureGate({ occupancyPercent: 17, coolingOn: false, enterPercent: 20 })
  assert.equal(verdict.open, false, '滞回只对「已开闸」生效，不能提前开')
})

test('G4 占用率不可判定 → 失败关闭（不猜）', () => {
  const verdict = decidePressureGate({ occupancyPercent: null, enterPercent: 20 })
  assert.equal(verdict.open, false)
  assert.equal(verdict.reason, 'pressure-unknown')
})

test('G5 闸门设为 0 = 无压力也降温（显式旧行为，不是缺省）', () => {
  const verdict = decidePressureGate({ occupancyPercent: 1, enterPercent: 0 })
  assert.equal(verdict.open, true)
  assert.equal(verdict.reason, 'gate-disabled')
})

test('G6 动态死区：σ 大时死区变宽，但有上限', () => {
  const flat = hysteresisPercentOf([20, 20, 20, 20])
  assert.equal(flat, PRESSURE_DEFAULTS.minHysteresisPercent, '样本无波动时取下限')
  const noisy = hysteresisPercentOf([5, 25, 5, 25, 5, 25])
  assert.ok(noisy > PRESSURE_DEFAULTS.minHysteresisPercent, '波动大时死区应变宽')
  assert.ok(noisy <= PRESSURE_DEFAULTS.maxHysteresisPercent, '死区不得超过上限')
})


test('G8 occupancyPercentOf 对缺失/非法窗口返回 null（不编造）', () => {
  assert.equal(occupancyPercentOf({ assembledTokens: 100, contextWindow: 0 }), null)
  assert.equal(occupancyPercentOf({ assembledTokens: 100 }), null)
  assert.equal(occupancyPercentOf({}), null)
  assert.equal(occupancyPercentOf({ assembledTokens: 51200, contextWindow: 512000 }), 10)
})

test('G9 回放真实会话占用序列：闸门 20% 下归档 0 次', () => {
  const fixture = readFileSync(path.join(here, 'fixtures', 'replay-c5af11b4.jsonl'), 'utf8')
    .split('\n').filter(Boolean).slice(1).map((line) => JSON.parse(line))
  // 夹具只保留结构；这里还原「活动面占用」：新增内容累加，归档时扣掉释放量
  // （shadowedTokenCount），窗口取 512000。字符→token 用 4:1 的保守口径。
  const WINDOW = 512000
  const CHARS_PER_TOKEN = 4
  let assembled = 21570
  let archived = 0
  let coolingOn = false
  let maxPercent = 0
  for (const row of fixture) {
    if (row.type === 'assistant/message') assembled += Math.ceil((row.textChars ?? 0) / CHARS_PER_TOKEN)
    else if (row.type === 'tool/result') assembled += Math.ceil((row.chars ?? 0) / CHARS_PER_TOKEN)
    else if (row.type === 'user/message') assembled += Math.ceil((row.chars ?? 0) / CHARS_PER_TOKEN)
    else if (row.type === 'compaction/prune') {
      const percent = occupancyPercentOf({ assembledTokens: assembled, contextWindow: WINDOW })
      if (percent !== null) maxPercent = Math.max(maxPercent, percent)
      const verdict = decidePressureGate({ occupancyPercent: percent, coolingOn, enterPercent: 20 })
      coolingOn = verdict.open
      if (verdict.open) archived += 1
      // 归档后活动面换成回执：扣掉释放量（这正是插件当时做的事）。
      assembled = Math.max(0, assembled - (row.tokens ?? 0))
    }
  }
  assert.equal(archived, 0, `闸门 20% 下不应归档，实际 ${archived} 次（峰值占用 ${maxPercent.toFixed(1)}%）`)
})
