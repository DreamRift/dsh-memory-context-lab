/**
 * 0.13.1 守卫：模块体积预算（P4 拆分的验收口径）。
 *
 * ## 缺陷
 * runtime.mjs 一度长到 3588 行、76 个闭包内函数，改一处要读整文件。拆分做完后
 * 如果没有守卫，下一批改动会悄悄把行数堆回去——「≤800 行」就变成一次性口号。
 *
 * ## 判据
 * - runtime.mjs 是装配层：只放模块级常量、命令解析、域装配、命令分发与三五个
 *   跨域小工具。上限 800 行。
 * - runtime-*.mjs 各域上限 800 行。域是「一域一文件」，再大就该继续拆。
 * - 其余 v2 模块不在本守卫范围（working-state.mjs 2306 行是已知技术债，已记入
 *   进展卡；给它设预算会让本守卫长期红着，失去告警价值）。
 *
 * ## 不适用条件与已知边界
 * 行数只是代理指标。它拦得住「堆回去」，拦不住「一个函数又变 400 行」。真正的
 * 约束是函数粒度，那要靠评审而不是脚本。本守卫绿不等于拆分质量合格。
 *
 * ## 运行
 * node --test-force-exit test/runtime-module-budget.test.mjs；超限退出码 1。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src')
const V2 = path.join(SRC, 'v2')

/** 单文件行数上限。域与装配层同一个口径。 */
const MAX_LINES = 800

/** 已知超限且已记账的模块：新增条目必须写理由，否则本守卫形同虚设。 */
const KNOWN_DEBT = new Map([
  ['v2/working-state.mjs', '工作状态卡的构建/去重/增量/预算全在一处；拆分要动 pin 与去重键契约，留待独立批次。'],
  ['v2/store.mjs', '会话冷库的存储层（条目/事务/manifest/索引）；按功能拆会把一次写事务拆到多个文件，反而更难保证原子性。'],
  ['v2/hierarchy-coordinator.mjs', '层级压缩的协调器；与 store 的事务边界耦合。'],
  ['v2/disposition.mjs', '遗忘账本（预览/提交/撤销/状态）单一事务域。'],
])

async function listModules(dir) {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) continue
    if (!entry.name.endsWith('.mjs')) continue
    out.push(entry.name)
  }
  return out
}

async function lineCountOf(file) {
  const text = await readFile(file, 'utf8')
  return text.split(String.fromCharCode(10)).length
}

test('量具自检：真的读到了模块', async () => {
  const mods = await listModules(V2)
  assert.ok(mods.length > 30, '扫描面过小（' + mods.length + ' 个模块），扫描器可能失效')
  assert.ok(mods.includes('runtime.mjs'))
  const n = await lineCountOf(path.join(V2, 'runtime.mjs'))
  assert.ok(n > 100, 'runtime.mjs 只有 ' + n + ' 行，行数统计可能失效')
})

test('runtime.mjs 是装配层：不超过 800 行', async () => {
  const n = await lineCountOf(path.join(V2, 'runtime.mjs'))
  assert.ok(n <= MAX_LINES, 'runtime.mjs 已 ' + n + ' 行（上限 ' + MAX_LINES + '）：新逻辑应进对应的 runtime-*.mjs 域')
})

test('每个域模块不超过 800 行', async () => {
  const mods = (await listModules(V2)).filter((f) => f.startsWith('runtime-'))
  assert.ok(mods.length >= 10, '域模块只有 ' + mods.length + ' 个，拆分可能回退了')
  const over = []
  for (const f of mods) {
    const n = await lineCountOf(path.join(V2, f))
    if (n > MAX_LINES) over.push(f + ': ' + n)
  }
  assert.deepEqual(over, [], '域模块超限：' + over.join(' / '))
})

test('超限模块必须登记在已知债务里（不准静默变胖）', async () => {
  const mods = await listModules(V2)
  const unregistered = []
  for (const f of mods) {
    const n = await lineCountOf(path.join(V2, f))
    if (n <= MAX_LINES) continue
    if (!KNOWN_DEBT.has('v2/' + f)) unregistered.push('v2/' + f + ': ' + n)
  }
  assert.deepEqual(unregistered, [], '超限但未登记：' + unregistered.join(' / ') + '（要么拆，要么在 KNOWN_DEBT 写明理由）')
})

test('已知债务条目必须仍然超限（拆完了就该删条目）', async () => {
  const stale = []
  for (const [rel, reason] of KNOWN_DEBT) {
    const n = await lineCountOf(path.join(SRC, rel))
    if (n <= MAX_LINES) stale.push(rel + ': ' + n + ' 行')
    assert.ok(reason.length > 10, rel + ' 的理由太短，等于没写')
  }
  assert.deepEqual(stale, [], '这些模块已回到预算内，应删除 KNOWN_DEBT 条目：' + stale.join(' / '))
})
