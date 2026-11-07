/**
 * S-10 守卫：深度上限不得改变数据类型（0.15.4）。
 *
 * ## 缺陷
 *
 * 旧实现 `if (depth > 6) return '[REDACTED:depth]'` 把第 7 层的**整个对象/数组**
 * 换成字符串。后果不是「少脱敏」而是**结构不一致**：
 * - 同一份工具参数，摄入侧（起点 depth 0）保留结构，导出侧（对已脱敏对象再跑一遍，
 *   仍在 depth 0，但真实嵌套更深）被压成字符串；
 * - 导出包出现「类型漂移」（object → string），回读方按结构解析会失败或误读；
 * - 逐步审计断链：原本可以指着 `a.b.c.d` 说「这里被标了」，现在只剩一个扁平字符串。
 *
 * 深度上限本身是合理的（防爆炸），错的是**用改变类型的方式**实现它。
 * 新实现保留容器骨架，只把标量叶子换成标记。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { redactValue } from '../src/v3/domain/security/redact.mjs'

function nest(depth, leaf = { password: 'abc123' }) {
  let node = leaf
  for (let i = 0; i < depth; i += 1) node = { level: node }
  return node
}

test('超限层仍是对象（类型不漂移）', () => {
  const out = redactValue(nest(8))
  let cursor = out
  let hops = 0
  while (cursor !== null && typeof cursor === 'object') {
    if (cursor.level === undefined) break
    cursor = cursor.level
    hops += 1
  }
  assert.equal(typeof cursor, 'object', '穿透到底的应当是对象/标记对象，而不是字符串')
  assert.ok(hops >= 7, '嵌套层数应保留到超限层，实际 ' + hops)
})

test('超限层以下的明文标量必须被标记，不得泄漏', () => {
  const secret = 'PLAINTEXT_MUST_NOT_LEAK'
  const out = redactValue(nest(9, { note: secret, password: 'p1' }))
  const serialized = JSON.stringify(out)
  assert.equal(serialized.includes(secret), false, '超限层的明文泄漏了：' + serialized.slice(0, 200))
  assert.ok(serialized.includes('[REDACTED:depth]'), '超限层的标量叶子应带 depth 标记')
})

test('数组同样保留数组类型', () => {
  let node = { password: 'x' }
  for (let i = 0; i < 8; i += 1) node = { level: [node] }
  const out = redactValue(node)
  let cursor = out
  for (let i = 0; i < 8; i += 1) {
    assert.equal(Array.isArray(cursor.level), true, '第 ' + (i + 1) + ' 层应是数组')
    cursor = cursor.level[0]
  }
  assert.equal(typeof cursor, 'object', '数组穿透到底仍是对象，不是字符串')
})

test('未超限时结构完全不变', () => {
  const input = { a: { b: { c: { password: 'x' } } } }
  const out = redactValue(input)
  assert.equal(typeof out.a, 'object')
  assert.equal(typeof out.a.b, 'object')
  assert.equal(typeof out.a.b.c, 'object')
  assert.equal(out.a.b.c.password, '[REDACTED]')
})
