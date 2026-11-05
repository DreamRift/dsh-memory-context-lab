#!/usr/bin/env node
/**
 * 逐文件跑全部测试并汇总失败，不因第一套失败而中断。
 *
 * `npm test` 的 `&&` 链适合快速失败，但它会让第 7 套一红就掩盖其余套件的状态；
 * 发布前的门禁需要「跑完再汇总」。两者都保留：日常用 npm test，收尾用 test:all。
 *
 * 三条纪律（2026-11-04 独立审计 H2/T6）：
 * - **递归收集**：旧实现只 readdir 根目录，19 个 `test/p0/**` 用例（含 5 个 P0 反例）
 *   从来没进过门禁。现在递归，只排除 `p0/fixtures/`（它们是被 P0 校验器读取的**测试数据**，
 *   自身不是套件；排除名单写在这里，不靠「正好没被扫到」）。
 * - **不用 --test-force-exit**：它会把未收尾的异步用例强行掐掉，失败被记成通过。
 *   套件自己必须能自然退出。
 * - **skip 单列**：skip 不等于通过。逐文件解析 TAP 的 `# skip` 计数，汇总时单独报出。
 */
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const testDir = path.join(root, 'test')

// 只排除测试数据目录（不是套件）。新增排除必须在这里写明，不能靠扫描规则漏掉。
// `p0/` 下的夹具需要结构化报告环境（P0_REPORT_PATH）与模式选择，由专用运行器
// `test/p0/run-red-baseline.mjs` 单独执行（见下方额外门禁），不能用 node --test 直接跑。
const EXCLUDED_DIRS = new Set([path.join('p0', 'fixtures'), 'p0'])

function collect(dir, prefix = '') {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = path.join(prefix, entry.name)
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(relative)) continue
      out.push(...collect(path.join(dir, entry.name), relative))
    } else if (entry.name.endsWith('.test.mjs')) {
      out.push(relative)
    }
  }
  return out
}

const files = collect(testDir)
if (files.length === 0) {
  console.error('没有找到任何 *.test.mjs（测试目录为空或路径错误）')
  process.exit(1)
}

const skipPattern = /^# skip (\d+)$/gm
const failures = []
let skippedTotal = 0
let suites = 0
for (const relative of files) {
  const result = spawnSync(process.execPath, ['--test', path.join(testDir, relative)], { encoding: 'utf8' })
  const output = (result.stdout ?? '') + (result.stderr ?? '')
  process.stdout.write(output)
  for (const match of output.matchAll(skipPattern)) skippedTotal += Number(match[1])
  suites += 1
  if (result.status !== 0) failures.push({ file: relative, status: result.status ?? 'signal' })
}

// P0 结构化门禁（此前 19 个 p0 用例从未进门禁）：契约模式下 R01/R03 必须 GREEN，
// 已转正/已超期件逐 defect 与冻结口径比对；任何 HARNESS_ERROR 或漂移都失败关闭。
const p0 = spawnSync(process.execPath, [path.join(testDir, 'p0', 'run-red-baseline.mjs')], { encoding: 'utf8' })
process.stdout.write((p0.stdout ?? '') + (p0.stderr ?? ''))
suites += 1
if (p0.status !== 0) failures.push({ file: path.join('p0', 'run-red-baseline.mjs'), status: p0.status ?? 'signal' })

console.log('')
if (failures.length === 0) {
  console.log(`全部 ${suites} 套件通过${skippedTotal > 0 ? `（其中 skip ${skippedTotal} 个用例，不计为通过）` : ''}。`)
  process.exit(0)
}
console.error(`${failures.length}/${suites} 套件失败${skippedTotal > 0 ? `（另有 skip ${skippedTotal} 个用例）` : ''}：`)
for (const failure of failures) console.error(`- ${failure.file}（exit ${failure.status}）`)
process.exit(1)
