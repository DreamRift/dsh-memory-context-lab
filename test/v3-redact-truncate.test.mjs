/**
 * B3-2（AUD50-02-07）redactValue 截断可见。
 *
 * ## 0.15.4 口径变更（S-11）
 *
 * 旧实现把截断公示成「数据里的假元素/假键」：
 * - 数组：`items.push('[TRUNCATED:items 80->50]')` —— 该字符串成为**数组元素**，
 *   下游按元素读时会被当成一个真实的工具参数/返回值，语义污染；
 * - 对象：`out['[TRUNCATED:keys 60->50]'] = true` —— 伪键同样是「看起来像真实参数」。
 *
 * 新实现：截断信息走独立元字段 `$truncated`（`$` 前缀不可能是真实工具参数名）。
 * 数组保持纯数组（无字符串标记元素），对象保持纯参数键。截断**仍然可见**，
 * 只是不再伪装成数据。
 *
 * 上限从 50 放宽到 200：50 太窄，60 键的真实工具参数会被截掉 10 个且不可恢复。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { redactValue } from '../src/v3/domain/security/redact.mjs'

const isTruncationMarker = (value) =>
  value !== null && typeof value === 'object' && value.$truncated !== undefined

test('60 键对象：不再截断（上限 200），且不出现伪键', () => {
  const input = Object.fromEntries(Array.from({ length: 60 }, (_, i) => ['k' + i, 'v' + i]))
  const out = redactValue(input)
  const keys = Object.keys(out)
  assert.equal(keys.length, 60, '60 键应全部保留（旧实现截到 50 + 伪键）')
  assert.equal(out.k59, 'v59', '第 60 键不得丢失')
  assert.equal(keys.some((k) => k.startsWith('[TRUNCATED')), false, '不得出现伪键污染参数')
  assert.equal(out.$truncated, undefined, '未截断时不得出现元字段')
})

test('250 键对象：保留 200 键 + 结构化 $truncated 元字段', () => {
  const input = Object.fromEntries(Array.from({ length: 250 }, (_, i) => ['k' + i, 'v' + i]))
  const out = redactValue(input)
  assert.equal(Object.keys(out).filter((k) => !k.startsWith('$')).length, 200, '保留 200 个真实键')
  assert.equal(Object.keys(out).some((k) => k.startsWith('[TRUNCATED')), false, '不得出现伪键')
  const meta = out.$truncated
  assert.ok(meta, '$truncated 元字段存在')
  assert.equal(meta.totalKeys, 250)
  assert.equal(meta.keptKeys, 200)
  assert.equal(meta.droppedKeys, 50)
})

test('250 项数组：保持纯数组 + $truncated 元字段', () => {
  const input = Array.from({ length: 250 }, (_, i) => 'item' + i)
  const out = redactValue(input)
  assert.equal(out.length, 200, '保留 200 项')
  assert.equal(out[199], 'item199')
  // 关键：数组里**不得**出现字符串标记元素（旧实现 push 了 '[TRUNCATED:items …]'）。
  assert.equal(
    out.some((v) => typeof v === 'string' && v.startsWith('[TRUNCATED')),
    false,
    '数组不得被字符串标记污染',
  )
  const meta = out.$truncated
  assert.ok(meta, '$truncated 元字段存在')
  assert.equal(meta.totalItems, 250)
  assert.equal(meta.keptItems, 200)
  assert.equal(meta.droppedItems, 50)
})

test('不超限时不出现任何截断痕迹', () => {
  const input = { small: { a: 1 }, tiny: [1, 2], text: 'hello' }
  const out = redactValue(input)
  assert.equal(out.$truncated, undefined, '未截断不得出现元字段')
  assert.deepEqual([...out.tiny], [1, 2])
})

test('嵌套：子数组被截断时，截断信息上提到父对象（JSON 后仍可见）', () => {
  // 数组的 `$truncated` 是非索引属性，JSON.stringify 会丢弃它；
  // 上提到父对象后，落盘/导出仍然能看到「这里被截过」。
  const input = { list: Array.from({ length: 250 }, (_, i) => i) }
  const out = redactValue(input)
  const serialized = JSON.parse(JSON.stringify(out))
  assert.equal(serialized.list.length, 200, '子数组仍保留 200 项')
  assert.ok(serialized.$truncated, '截断信息上提到父对象，序列化后仍可见')
  assert.ok(serialized.$truncated.list, '记录了是哪个子字段被截断')
  assert.equal(serialized.$truncated.list.totalItems, 250)
})
