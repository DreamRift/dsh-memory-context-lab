/**
 * B3-28（AUD50-10-06）探针守卫：宿主契约探针的字段缺口防线。
 *
 * 旧探针 6/6 全绿是假绿——插件实际消费的 payload.turn / data.turn / session.log /
 * surface.nodes / payload.messages 一个都没查（beta.50 审计实测）。这里钉两件事：
 * ① checks 数量固定：增删检查必须显式同步本文件的 EXPECTED_CHECKS，防止「顺手加一行
 *    却忘了锁」与「升级时静默缩水」两个方向；
 * ② 失败必须非零退出：宿主升级后 npm run probe:host 红得起，才算探针。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const EXPECTED_CHECKS = 11
const PROBE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'helpers', 'host-contract-probe.mjs')

test('探针 checks 数量固定，字段清单可审计（B3-28）', async () => {
  const source = await readFile(PROBE, 'utf8')
  const block = source.match(/const checks = \[([\s\S]*?)\n  \]/)
  assert.ok(block, '探针必须保留 checks 数组')
  const count = (block[1].match(/^\s*\[/gm) || []).length
  assert.equal(count, EXPECTED_CHECKS,
    'checks 数量漂移（现在 ' + count + '）：在探针里增删检查时，必须同步本文件 EXPECTED_CHECKS，' +
    '并按探针头注释对「插件 src 对宿主对象的字段读取」做人工核对')
  for (const field of ['payload.turn', 'data.turn', 'session.log', 'surface.nodes', 'payload.messages']) {
    assert.ok(source.includes(field), '探针必须覆盖插件消费的宿主契约字段：' + field)
  }
})

test('探针失败必须非零退出（不假绿，B3-28）', async () => {
  const source = await readFile(PROBE, 'utf8')
  assert.ok(/process\.exit\(1\)/.test(source), '探针失败路径必须 process.exit(1)')
})
