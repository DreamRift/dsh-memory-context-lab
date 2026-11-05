#!/usr/bin/env node
/**
 * R06 红色基线探针（0.15.0 P0，2026-10-31；返工版：冻结夹具清单 + 变异反例）。
 *
 * 缺陷（R06，见 docs/dev-0.15.0/开发流程.md §7.2）：
 * assistant/message 的内容块可以同时声明多个 tool-call；宿主 dsh-agent-loop
 * 用 executeToolCalls 并发执行、按模型顺序提交结果，取消/异常时再补 skipped 或
 * recovery 结果。插件现有 candidates.mjs / steps.mjs 只按独立的 tool/call 与
 * tool/result 事件收集闭包，**不读 assistant/message.content 里的 tool-call 块**。
 * 结果是：只要调度器还没写出某个调用的 tool/call，该调用在插件眼里不存在，
 * 含「只到部分结果」的回合/步骤会被判成已完成并归档（后续结果到达时已改面）。
 *
 * ## 判据来源
 * 宿主 0.2.1-rc.5 源码（app.asar 内 dsh-agent-loop/lib/index.js，2026-10-31 核验）：
 * - assistant/message.content 过滤 type === 'tool-call' 得到调用全集；
 * - 每个调用先 appendToolCall（tool/call），结果以 tool/result + sourceEventSeqs:[callSeq] 追加；
 * - 取消 appendSkippedToolCall 补对；异常 ToolCallRecovery.results() 补合成结果。
 * 插件侧：src/v3/domain/archive/{event-shape,candidates,steps}.mjs（只读，未改）。
 *
 * ## 断言组（全部可机械判定）
 * 1. 冻结清单：EXPECTED_FILES / EXPECTED_RED / EXPECTED_CONTROLS / EXPECTED_RISK 必须与
 *    实际夹具逐项一致；缺件、重复、非法 mode/kind/expect、空扫描面 → exit 2。
 * 2. 控制组：必须与 expect 完全一致；不一致 → FAIL（exit 1）。
 * 3. R06 红组：当前实现可归档 = RED（预期基线，exit 1）；修复后不可归档 = PASS。
 * 4. R07 风险对照**单列**：不参与 R06 正确性通过计数；后续媒体保护落地后
 *    旧风险期望（可归档）不会把 R06 判红，也不把 R07 记成 R06 PASS。
 * 5. 变异反例（本文件内建、不落盘）：
 *    - 删掉任一 red 文件后重跑 → exit 2（冻结清单缺件），不会「5 PASS 仍绿」；
 *    - 把冻结清单里的 red 场景从断言中移除 → exit 2（场景集合不一致）。
 *
 * ## 不适用条件与已知边界
 * - 源码/纯函数级基线，不是真实宿主集成；不操作 GUI、profile 或实际会话。
 * - 不模拟宿主并发时序，只用「事件已落盘后的日志形状」表达部分结果。
 * - 修复前禁止接进 test-all（RED 会退出 1）。
 *
 * ## 运行命令与退出码
 *   node test/helpers/p0-r06-tool-closure-baseline.mjs
 *   0 = 全部控制组符合、R06 红组已转绿（修复后）；
 *   1 = 红组仍红或控制组失败；
 *   2 = 用法/夹具集合/形状错误（缺件、重复、非法 mode/kind/expect）。
 * 输出契约：固定顺序、LF、不含绝对路径与时间戳；两次运行 stdout 逐字节相同。
 */
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { selectArchiveSpan } from '../../src/v3/domain/archive/candidates.mjs'
import { selectStepSpan } from '../../src/v3/domain/archive/steps.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixturesDir = path.join(here, '..', 'fixtures')

/** 冻结清单：增删夹具必须显式改这里，否则 exit 2（防「删几个红文件仍绿」）。 */
const EXPECTED_FILES = [
  'r06-control-call-without-result-turn.json',
  'r06-control-cancel-step.json',
  'r06-control-complete-turn.json',
  'r06-control-out-of-order-turn.json',
  'r06-red-cross-step.json',
  'r06-red-partial-step.json',
  'r06-red-partial-turn.json',
  'r07-risk-mixed-media-turn.json',
]
const EXPECTED_RED = ['r06-red-cross-step.json', 'r06-red-partial-step.json', 'r06-red-partial-turn.json']
const EXPECTED_CONTROLS = [
  'r06-control-call-without-result-turn.json',
  'r06-control-cancel-step.json',
  'r06-control-complete-turn.json',
  'r06-control-out-of-order-turn.json',
]
const EXPECTED_RISK = ['r07-risk-mixed-media-turn.json']

function failUsage(message) {
  console.error('[r06] ' + message)
  process.exit(2)
}

function sameSet(actual, expected) {
  if (actual.length !== expected.length) return false
  const a = [...actual].sort()
  const b = [...expected].sort()
  return a.every((item, i) => item === b[i])
}

let listed
try {
  listed = readdirSync(fixturesDir).filter((name) => /^r06-.*\.json$/.test(name) || /^r07-.*\.json$/.test(name)).sort()
} catch (error) {
  failUsage('夹具目录不可读（路径已省略）：' + (error?.code ?? 'EUNKNOWN'))
}
if (listed.length === 0) failUsage('没有 r06/r07 夹具（空扫描面不得判绿）')
if (listed.length !== new Set(listed).size) failUsage('夹具清单含重复项')
if (sameSet(listed, EXPECTED_FILES) === false) {
  const missing = EXPECTED_FILES.filter((name) => !listed.includes(name))
  const extra = listed.filter((name) => !EXPECTED_FILES.includes(name))
  failUsage('夹具集合与冻结清单不一致；missing=' + JSON.stringify(missing) + ' extra=' + JSON.stringify(extra))
}

const VALID_MODES = new Set(['turn', 'step'])
const VALID_KINDS = new Set(['control', 'red', 'risk'])
const cases = []
for (const file of EXPECTED_FILES) {
  let fixture
  try {
    fixture = JSON.parse(readFileSync(path.join(fixturesDir, file), 'utf8'))
  } catch (error) {
    failUsage('夹具解析失败 ' + file + '（' + (error?.code ?? 'EUNKNOWN') + '）')
  }
  if (fixture === null || typeof fixture !== 'object' || Array.isArray(fixture)) failUsage('夹具必须是对象：' + file)
  if (fixture.synthetic !== true) failUsage('夹具必须显式标注 synthetic: true：' + file)
  if (fixture.name !== file.replace(/\.json$/, '')) failUsage('夹具 name 与文件名不一致：' + file)
  if (!VALID_MODES.has(fixture.mode)) failUsage('非法 mode：' + file)
  if (!VALID_KINDS.has(fixture.kind)) failUsage('非法 kind：' + file)
  if (!Array.isArray(fixture.surfaceNodes) || !Array.isArray(fixture.events)) failUsage('surfaceNodes/events 必须是数组：' + file)
  if (fixture.expect === null || typeof fixture.expect !== 'object' || Array.isArray(fixture.expect)) failUsage('缺 expect 对象：' + file)
  const selection = fixture.expect.selection
  if (selection !== null && selection !== 'non-null') failUsage('expect.selection 必须是 null 或 "non-null"：' + file)
  if (selection === 'non-null' && !Array.isArray(fixture.expect.seqs)) failUsage('非 null 选择必须给 expect.seqs：' + file)
  if (selection === null && fixture.expect.seqs !== undefined) failUsage('null 选择不得带 expect.seqs：' + file)
  if (fixture.kind === 'control' && !EXPECTED_CONTROLS.includes(file)) failUsage('control 场景未列入冻结清单：' + file)
  if (fixture.kind === 'red' && !EXPECTED_RED.includes(file)) failUsage('red 场景未列入冻结清单：' + file)
  if (fixture.kind === 'risk' && !EXPECTED_RISK.includes(file)) failUsage('risk 场景未列入冻结清单：' + file)
  cases.push({ file, fixture })
}
for (const file of EXPECTED_RED) if (!cases.some((c) => c.file === file)) failUsage('冻结红组缺件：' + file)
for (const file of EXPECTED_CONTROLS) if (!cases.some((c) => c.file === file)) failUsage('冻结控制组缺件：' + file)
for (const file of EXPECTED_RISK) if (!cases.some((c) => c.file === file)) failUsage('冻结风险组缺件：' + file)

/** 从 assistant 内容块收集声明的 callId（宿主的调用全集来源）。 */
function declaredCallIds(events) {
  const ids = new Set()
  for (const event of events) {
    if (event?.type !== 'assistant/message') continue
    const content = event?.data?.message?.content
    if (!Array.isArray(content)) continue
    for (const block of content) if (block?.type === 'tool-call' && typeof block.id === 'string') ids.add(block.id)
  }
  return [...ids].sort()
}

/** 从日志事件收集 call/result 配对（插件现有判据）。 */
function pairedCallIds(events) {
  const calls = new Set()
  const results = new Set()
  for (const event of events) {
    const callId = event?.data?.callId ?? event?.data?.message?.toolCallId ?? event?.data?.message?.source?.callId
    if (typeof callId !== 'string') continue
    if (event.type === 'tool/call') calls.add(callId)
    if (event.type === 'tool/result') results.add(callId)
  }
  return { calls: [...calls].sort(), results: [...results].sort() }
}

const hasRecord = () => true

function runCase({ file, fixture }) {
  const args = {
    surfaceNodes: fixture.surfaceNodes,
    events: fixture.events,
    hasRecord,
    ...fixture.select,
  }
  const observed = fixture.mode === 'step' ? selectStepSpan(args) : selectArchiveSpan(args)
  const expected = fixture.expect
  const observedSelection = observed === null ? null : observed.sourceEventSeqs ?? null
  let matched = false
  if (expected.selection === null) matched = observed === null
  else if (expected.selection === 'non-null') matched = observed !== null
  if (matched && Array.isArray(expected.seqs) && observed !== null) {
    matched = JSON.stringify(observed.sourceEventSeqs) === JSON.stringify(expected.seqs)
  }
  return {
    file,
    kind: fixture.kind,
    mode: fixture.mode,
    matched,
    declared: declaredCallIds(fixture.events),
    paired: pairedCallIds(fixture.events),
    observed: observedSelection,
    expected: expected.seqs ?? (expected.selection === null ? null : 'non-null'),
  }
}

const rows = cases.map(runCase)
const controls = rows.filter((row) => row.kind === 'control')
const reds = rows.filter((row) => row.kind === 'red')
const risks = rows.filter((row) => row.kind === 'risk')

for (const row of rows) {
  const verdict = row.kind === 'red'
    ? (row.matched ? 'R06-GREEN' : 'RED')
    : (row.matched ? 'PASS' : 'FAIL')
  console.log('[r06] ' + verdict + ' ' + row.file
    + ' mode=' + row.mode
    + ' kind=' + row.kind
    + ' declared=' + JSON.stringify(row.declared)
    + ' pairs=' + JSON.stringify(row.paired.calls) + '/' + JSON.stringify(row.paired.results)
    + ' observed=' + JSON.stringify(row.observed)
    + ' expected=' + JSON.stringify(row.expected))
}

const controlFailures = controls.filter((row) => !row.matched)
const redOpen = reds.filter((row) => !row.matched)
const riskMismatch = risks.filter((row) => !row.matched)
console.log('[r06] files=' + rows.length
  + ' controls=' + controls.length + '/' + controls.filter((row) => row.matched).length
  + ' red_open=' + redOpen.length + '/' + reds.length
  + ' risk=' + risks.length + '/' + risks.filter((row) => row.matched).length)

if (riskMismatch.length > 0) {
  // R07 是风险对照，不参与 R06 正确性；仅当夹具被改坏时才报（不把旧风险期望当 R06 判据）。
  console.error('[r06] R07 风险对照与登记现状不一致（不改变 R06 结论）：' + riskMismatch.map((row) => row.file).join(','))
}
if (controlFailures.length > 0) {
  console.error('[r06] 控制组失败：' + controlFailures.map((row) => row.file).join(','))
  process.exit(1)
}
if (redOpen.length > 0) {
  console.log('[r06] RED = 当前实现把「assistant 声明但结果未落盘」的调用当成不存在；修复目标：按 assistant 内容块取 callId 全集。')
  process.exit(1)
}
console.log('[r06] PASS：R06 调用闭包已与夹具期望一致（R07 风险对照单列，不构成本结论）。')
