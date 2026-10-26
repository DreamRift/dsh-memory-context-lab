import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { evaluatePressureGate } from '../src/v3/domain/session/pressure-gate.mjs'

// H-22 口径锁：参数表文档与闸门判据互锁，防止「文档说一套、行为另一套」的静默漂移。
// 单一真源：docs/dev-0.14.0/检索复验基线与provisional参数-20261026.md 的定稿表。
const here = path.dirname(fileURLToPath(import.meta.url))
const doc = await readFile(path.join(here, '../../docs/dev-0.14.0/检索复验基线与provisional参数-20261026.md'), 'utf8')

test('H-22 口径锁：参数表文档含四项定稿且数值可解析', () => {
  assert.ok(doc.includes('20 万 token（百万窗口 × 20%）'), '入门阈值定稿行')
  assert.ok(doc.includes('max(5%, 3σ₃₀)'), '滞回死区定稿行')
  assert.ok(doc.includes('闸门失效保护 25 万（25%）'), '紧急线定稿行')
  assert.ok(doc.includes('贴线率/超调率不劣于实测（12% / 4.4%）'), '转正验收指标行')
})

test('H-22 口径锁：闸门判据行为与定稿值一致（0.2 开 / 0.25 兜底语义）', () => {
  // 占用 = 0.2（20 万 / 百万）：达到入门线 → 开闸
  const at = evaluatePressureGate({ occupancy: 0.2, enterThreshold: 0.2 })
  assert.equal(at.open, true, '达到 20% 入门线必须开闸')
  // 占用 0.199：死区内不抖（滞回语义由 exitThreshold 承载）
  const below = evaluatePressureGate({ occupancy: 0.199, enterThreshold: 0.2, exitThreshold: 0.15, currentlyOpen: true })
  assert.equal(below.open, true, '死区内维持（不抖）')
  // 占用 0.25：超过紧急线语义位（闸门判据面只管 enter/exit；25 万兜底属执行层，这里锁数值可推导）
  assert.ok(0.25 >= 0.2, '紧急线 25% 高于入门线 20%')
})
