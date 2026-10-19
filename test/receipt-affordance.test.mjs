/**
 * 0.13.1 守卫：回执回读指路必须指向真实可用的入口（F4）。
 *
 * ## 缺陷
 * 0.13.0 的归档回执写「可用 /memory-lab2 read <ID> 回读」。0.13.1 删除
 * `/memory-lab2` 之后，这些指路全部失效——模型照着回执去读，得到「未知命令」。
 *
 * ## 判据来源
 * 会话 c1787f24 的 21 条回执：其中 format 3/4 的回执一律指路 `/memory-lab2`。
 * 0.13.1 只有一条命令 `/memory-lab`，且模型可见的只读工具是
 * `memory_lab_recall(record_ids=[...])`。
 *
 * ## 断言组
 * 1. 源码里不再出现 `/memory-lab2` 的**回执文案**（投影折叠的旧命令名除外，已白名单）；
 * 2. 回执/状态文案指向 `memory_lab_recall` 或 `/memory-lab`。
 *
 * ## 不适用条件与已知边界
 * 本守卫是文本扫描：它不验证「回读真的成功」，只验证「指路的字符串没有指向已删除的命令」。
 * 真正的回读链路由 `v2-read-alias` / `v2-readback` / `v2-recall-tool-contract` 覆盖。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src')

/** 允许出现 `/memory-lab2` 的唯一位置：投影必须折叠 0.13.0 的旧命令记录。 */
const ALLOWED = new Set(['projection.mjs'])

async function listFiles(dir = SRC, base = SRC, acc = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) await listFiles(full, base, acc)
    else if (full.endsWith('.mjs') || full.endsWith('.js')) acc.push(path.relative(base, full).replaceAll('\\', '/'))
  }
  return acc
}

test('量具自检：扫描器读到了源码', async () => {
  const files = await listFiles()
  assert.ok(files.length > 30, `扫描面过小：${files.length}`)
})

test('F4a 除投影外，源码不得再出现 /memory-lab2 命令指路', async () => {
  const files = await listFiles()
  const offenders = []
  for (const rel of files) {
    if (ALLOWED.has(rel)) continue
    const text = await readFile(path.join(SRC, rel), 'utf8')
    if (text.includes('/memory-lab2')) offenders.push(rel)
  }
  assert.deepEqual(offenders, [], `仍在指路已删除的命令：\n${offenders.join('\n')}`)
})

test('F4b 回读指路指向真实入口', async () => {
  const core = await readFile(path.join(SRC, 'core.mjs'), 'utf8')
  // 回执的「可回读」行必须给出工具形式，命令面降为第二行。
  assert.match(core, /可回读：memory_lab_recall\(record_ids=/, '回执必须给出可照抄的工具调用')
  assert.match(core, /命令面：\/memory-lab read/, '命令面必须指向唯一命令')
})
