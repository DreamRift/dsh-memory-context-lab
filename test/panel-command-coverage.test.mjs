/**
 * 0.13.1 守卫：面板与命令面不得指向不存在的子命令。
 *
 * ## 缺陷（本轮实测发现 3 处）
 * 1. 面板「清理」按钮发 `/memory-lab clean`，而 v2 命令面**没有** `clean` 分支 →
 *    用户点下去只得到帮助文本，冷库原封不动。更糟的是 `off` 与
 *    `set fullhistory off` 的**失败提示**都写着 `/memory-lab clean confirm delete-session`
 *    ——那条命令当时也不存在，用户被指向一条死路。
 * 2. 面板「停用时恢复原文」开关发 `/memory-lab set autorestore on|off`，而
 *    `setSetting` 的键位闭集里没有 `autorestore` → 点了只回「未知设置键」。
 * 3. `index.mjs` 的命令输入提示宣称有 `debug <sub>` 二级命令面，实际从未实现。
 *
 * ## 判据
 * - 每个 `run('/memory-lab <子命令> …')` 的子命令必须在 runtime 的 switch 里有 case；
 * - 每个 `run('/memory-lab set <键> …')` 的键必须在 setSetting 的键位闭集里；
 * - 帮助文本与输入提示里出现的子命令同样必须在 switch 里。
 *
 * ## 不适用条件与已知边界
 * 本守卫只做**字面**比对：它证明「这个名字有分支」，不证明分支行为正确；
 * 也不覆盖 `confirm` 之类的参数级用法。`set` 的键位表由正则从 setSetting 提取，
 * 改动 setSetting 的写法（例如改成查表）需要同步本文件。
 *
 * ## 运行
 * `node --test-force-exit test/panel-command-coverage.test.mjs`；有悬空引用退出码 1。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src')

async function readSource(rel) {
  return readFile(path.join(SRC, rel), 'utf8')
}

test('量具自检：读到了命令面与面板源码', async () => {
  const runtime = await readSource('v2/runtime.mjs')
  const client = await readSource('client.js')
  assert.ok(runtime.includes("case 'on':"), 'runtime 命令面缺失，扫描器可能失效')
  assert.ok(client.includes('/memory-lab'), 'client 面板缺失，扫描器可能失效')
})

test('面板发出的每个子命令都在命令面里有分支', async () => {
  const runtime = await readSource('v2/runtime.mjs')
  const client = await readSource('client.js')
  const cases = new Set([...runtime.matchAll(/case '([^']+)':/g)].map((m) => m[1]))
  const issued = new Set()
  for (const m of client.matchAll(/\/memory-lab ([a-z][a-z-]*)/g)) issued.add(m[1])
  const dangling = [...issued].filter((op) => !cases.has(op) && op !== 'set')
  assert.deepEqual(dangling, [], '面板发了没有实现的子命令：' + dangling.join(' / '))
})

test('面板发出的每个 set 键都在 setSetting 的键位闭集里', async () => {
  const settings = await readSource('v2/runtime-settings.mjs')
  const client = await readSource('client.js')
  const keys = new Set([...settings.matchAll(/key === '([a-z0-9]+)'/g)].map((m) => m[1]))
  const issued = new Set()
  for (const m of client.matchAll(/\/memory-lab set ([a-z0-9]+)/g)) issued.add(m[1])
  const dangling = [...issued].filter((k) => !keys.has(k))
  assert.deepEqual(dangling, [], '面板发了 setSetting 不认识的键：' + dangling.join(' / '))
})

test('帮助文本与输入提示里的子命令都在命令面里有分支', async () => {
  const runtime = await readSource('v2/runtime.mjs')
  const index = await readSource('index.mjs')
  const cases = new Set([...runtime.matchAll(/case '([^']+)':/g)].map((m) => m[1]))
  const helpStart = runtime.indexOf('export const V2_HELP');
  const helpEnd = runtime.indexOf('].join(', helpStart);
  const help = runtime.slice(helpStart, helpEnd);
  const advertised = new Set()
  for (const m of help.matchAll(/\/memory-lab ([a-z][a-z-]*)/g)) advertised.add(m[1])
  // help 自身由 default 分支处理，不需要 case。
  advertised.delete('help')
  const dangling = [...advertised].filter((op) => !cases.has(op))
  assert.deepEqual(dangling, [], '帮助里写了没有实现的子命令：' + dangling.join(' / '))
  // 输入提示同理（它是另一处字面量，容易单独漂移）。
  const hintMatch = /input: \{ hint: '([^']+)' \}/.exec(index)
  assert.ok(hintMatch, 'index.mjs 的命令输入提示必须仍是一行字面量（本守卫依赖该形态）')
  const hinted = hintMatch[1].split('|').map((s) => s.trim()).filter((s) => /^[a-z][a-z-]*$/.test(s))
  const hintDangling = hinted.filter((op) => !cases.has(op) && op !== 'set' && op !== 'help')
  assert.deepEqual(hintDangling, [], '输入提示里写了没有实现的子命令：' + hintDangling.join(' / '))
})
