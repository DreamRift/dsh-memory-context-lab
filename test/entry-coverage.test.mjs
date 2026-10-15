/**
 * 测试入口覆盖：`npm test` 必须跑到磁盘上的每一个 `test/*.test.mjs`。
 *
 * 这不是形式主义——本仓库已经**两次**踩到同一个坑：第二轮复核时发现两个新增的
 * 灵枢测试文件没接进 `npm test`（当时磁盘 21 套、入口 19 套），随后加入的
 * `v2-card-budget.test.mjs` 又漏了一次（磁盘 22 套、入口 21 套）。漏掉的测试文件
 * 在本地手工 `node test/x.test.mjs` 时全绿，于是「全绿」这句结论对 CI/入口而言是假的，
 * 而 `需求追踪表` 的 F5 正是引用 `v2-card-budget` 作为 P0-1 的回归证据。
 *
 * 所以这里把「入口 == 磁盘」变成一条会失败的断言，而不是每次靠人工比对清单。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.join(here, '..')

/**
 * `node [flags] test/x.test.mjs` 形式的条目；容忍 `&&` 分隔、node 标志
 * （如 B5 的 `--test-force-exit`）与多余空白。标志必须是 `--` 开头的裸 token，
 * 文件名仍以 `.test.mjs` 收尾——除此之外的形态不认，防止入口悄悄变成别的跑法。
 */
function testEntryOf(part) {
  const match = part.trim().match(/^node\s+(?:--\S+\s+)*(\S+\.test\.mjs)$/)
  return match ? match[1].replaceAll('\\', '/') : null
}

function testEntriesOf(script) {
  const entries = new Set()
  for (const part of String(script).split('&&')) {
    const entry = testEntryOf(part)
    if (entry) entries.add(entry)
  }
  return entries
}

test('`npm test` 覆盖磁盘上的全部 test/*.test.mjs（含本文件）', async () => {
  const manifest = JSON.parse(await readFile(path.join(pluginRoot, 'package.json'), 'utf8'))
  const script = manifest.scripts?.test
  assert.equal(typeof script, 'string', 'package.json 必须定义 test 脚本')

  const onDisk = (await readdir(here))
    .filter((name) => name.endsWith('.test.mjs'))
    .map((name) => `test/${name}`)
    .sort()
  assert.ok(onDisk.length > 0, '磁盘上必须至少有一个测试文件')

  const inEntry = [...testEntriesOf(script)].sort()
  const missing = onDisk.filter((file) => !inEntry.includes(file))
  const extra = inEntry.filter((file) => !onDisk.includes(file))

  assert.deepEqual(missing, [], `以下测试文件没接进 npm test：${missing.join('、')}`)
  assert.deepEqual(extra, [], `npm test 指向了磁盘上不存在的文件：${extra.join('、')}`)
  assert.deepEqual(inEntry, onDisk, '入口清单必须与磁盘清单逐项一致')
})

test('入口顺序稳定且不重复（同一文件只跑一次）', async () => {
  const manifest = JSON.parse(await readFile(path.join(pluginRoot, 'package.json'), 'utf8'))
  const raw = String(manifest.scripts.test)
    .split('&&')
    .map(testEntryOf)
    .filter(Boolean)
  assert.equal(new Set(raw).size, raw.length, '同一个测试文件不得在入口里出现两次')
})
