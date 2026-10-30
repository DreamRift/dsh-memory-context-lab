/**
 * B3-2（AUD50-02-07）redactValue 截断可见——60 键对象/80 项数组截到 50 后必须带
 * [TRUNCATED:…] 标记（截断数写进标记），不超限时不出现标记；嵌套超限各层各自标记。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { redactValue } from '../src/v3/domain/security/redact.mjs'

test('60 键对象：保留 50 键 + keys 截断标记', () => {
  const input = Object.fromEntries(Array.from({ length: 60 }, (_, i) => ['k' + i, 'v' + i]))
  const out = redactValue(input)
  const keys = Object.keys(out)
  assert.equal(keys.length, 51, '50 个原键 + 1 个标记键')
  assert.equal(out['k59'], undefined, '第 51 键起被截')
  const marker = keys.find((k) => k.startsWith('[TRUNCATED:keys '))
  assert.ok(marker, 'keys 截断标记存在')
  assert.ok(marker.includes('60->50'), '标记含原值->保留数')
})

test('80 项数组：保留 50 项 + items 截断标记', () => {
  const input = Array.from({ length: 80 }, (_, i) => 'item' + i)
  const out = redactValue(input)
  assert.equal(out.length, 51)
  assert.equal(out[49], 'item49')
  assert.equal(out.some((v) => typeof v === 'string' && v.startsWith('[TRUNCATED:items ')), true)
  const marker = out[out.length - 1]
  assert.ok(marker.includes('80->50'), '标记含原值->保留数')
})

test('嵌套超限：对象与数组各自标记；不超限不出现标记', () => {
  const input = {
    big: Object.fromEntries(Array.from({ length: 52 }, (_, i) => ['x' + i, 1])),
    list: Array.from({ length: 51 }, (_, i) => i),
    small: { a: 1 },
    tiny: [1, 2],
  }
  const out = redactValue(input)
  assert.ok(Object.keys(out.big).some((k) => k.startsWith('[TRUNCATED:keys ')))
  assert.ok(out.list.some((v) => typeof v === 'string' && v.startsWith('[TRUNCATED:items ')))
  const serialized = JSON.stringify(out)
  assert.equal((serialized.match(/TRUNCATED/g) || []).length, 2, '恰好两处标记')
  assert.equal(JSON.stringify(redactValue({ a: 1, b: [1, 2, 3] })).includes('TRUNCATED'), false, '不超限无标记')
})
