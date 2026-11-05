#!/usr/bin/env node
/**
 * P0 红色基线运行器（测试域专用）。0.15.0 收尾后由 `scripts/test-all.mjs` 以**契约模式**
 * 接入全量门禁（此前 19 个 p0 用例从未进门禁）；本文件仍可单独运行以复现基线。
 *
 * 状态不是由子进程退出码猜的，也不是只信夹具自报的汇总字段。运行器独立校验：
 * - 报告存在、JSON 合法、schema/fixture/mode 匹配；
 * - checks 必须是数组且每个元素形状合法（kind/id/status 等白名单）；
 * - control/defect 的 id 集合与 FIXTURES/SUPERSEDED 外置声明**精确相等**且无重复；
 * - 所有 control 为 PASS；所有 defect 为 RED/GREEN 合法值；
 * - 顶层 status 必须与 checks 推导一致（HARNESS_ERROR 无条件保持失败）；
 * - 子进程退出码必须与顶层 status 一致（不是「非零即红」）。
 *
 * 两张表（2026-11-04 复核后）：
 * - `FIXTURES`：**原红色基线，现已转正为契约门**（R01/R03，两个 defect 都已 GREEN）。
 *   契约模式要求整件 GREEN；`--expect-red` 会因 UNEXPECTED_GREEN 失败（这是提醒：
 *   已满足的契约必须转正，不能继续当「预期红」）。
 * - `SUPERSEDED`：**已被集成修复或契约替换**的三件（R02/R04/R08）→ 不再要求「整件红」，
 *   而是逐 defect 与冻结口径**精确比对**；口径一变就报 DRIFT（冻结证据失效，需重新取证），
 *   绝不因为「反正修了」就删掉证据或放它变绿而无人记录。
 *
 * EXPECTED_RED：报告有效、全部 control PASS、全部 defect RED、status=EXPECTED_RED、exit 0。
 * GREEN：契约门全部 defect GREEN、status=GREEN、exit 0。
 * HARNESS_ERROR：缺报告/坏 JSON/身份不符/control FAIL/缺声明/重复/非法形状/
 *                状态不自洽/退出码不符/信号/超时——一律 exit 3，绝不进入成功路径。
 *
 * 退出码：0 = 全 EXPECTED_RED（--expect-red）或全 GREEN（契约门），且 SUPERSEDED 口径一致；
 *         1 = 契约未满足 / SUPERSEDED 冻结口径漂移；
 *         2 = 意外变绿（有效红件被修好却没转正）；
 *         3 = 运行器/夹具错误（失败关闭）。
 *
 * 自测：node test/p0/harness-selftest.mjs。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const TIMEOUT_MS = 180000

// 外置身份：每件的 control/defect id 集合都是运行器的独立期望，不取自报告自报。
export const FIXTURES = [
  { id: 'R01', file: 'r01-tail-window.test.mjs', controls: ['fixture.length927', 'search.hitsTail', 'recall.injected'], defects: ['recall.windowIncludesTail'] },
  { id: 'R03', file: 'r03-weak-candidate.test.mjs', controls: ['fixture.displayThree'], defects: ['pack.weakCandidatesExcluded'] },
]

/**
 * 已转正 / 已超期的三件。`frozen` 是从 ca1083a 快照实测得到的逐 defect 状态，不是推测。
 * 任何一项对不上 → DRIFT（exit 1），必须重新取证并更新本文档与 P0 基线证据，不能静默丢证据。
 */
export const SUPERSEDED = [
  {
    id: 'R02',
    file: 'r02-presented-lease.test.mjs',
    controls: ['recall.injected', 'fixture.presentedTwo'],
    defects: ['hits.onlyPresented', 'header.presentedCount', 'lease.onlyPresented'],
    frozen: { 'hits.onlyPresented': 'GREEN', 'header.presentedCount': 'GREEN', 'lease.onlyPresented': 'RED' },
    promotedTo: 'test/v3-recall-r02-r04.test.mjs',
    note: 'hits/header 已按呈现集合修好；lease=RED 是契约冲突——新契约要求宿主 session/event 确认后才写租约，夹具直接调 recallForInjection 且不发宿主事件，故租约恒 0。见 docs/dev-0.15.0/R02-R04-回注呈现.md §4.3。',
  },
  {
    id: 'R04',
    file: 'r04-retry-after-failure.test.mjs',
    controls: ['first.injectedFalse', 'first.providerReadReached'],
    defects: ['retry.sameTurnInjects'],
    frozen: { 'retry.sameTurnInjects': 'GREEN' },
    promotedTo: 'test/v3-recall-r02-r04.test.mjs',
    note: '读取暂败后同回合可重试，已修（9e8b20a）；第三次仍按 once-per-turn 不重复注入。',
  },
  {
    id: 'R08',
    file: 'r08-lost-update.test.mjs',
    controls: ['sequential.controlKeepsBoth'],
    defects: ['lease.concurrentKeepsBoth', 'pin.concurrentKeepsBoth'],
    frozen: { 'lease.concurrentKeepsBoth': 'RED', 'pin.concurrentKeepsBoth': 'RED' },
    promotedTo: 'test/v3-session-state-updater.test.mjs（原语 C2/C3）+ test/v3-recall-r02-r04.test.mjs（合并纯函数）',
    note: '夹具复刻的是**已被替换的调用方形态**（锁外读快照 → 整数组 patch）；生产 markReadLease/pinRecords 已改锁内 updater（v3-entry.mjs L530/L921）。RED 只证明该旧形态仍会丢更新，不是当前生产路径缺陷，也不据此宣称 R08 端到端在真实宿主成立。',
  },
]

const ALLOWED_KINDS = new Set(['control', 'defect', 'observation'])
const ALLOWED_STATUSES = new Set(['PASS', 'FAIL', 'RED', 'GREEN'])

function sameSet(actual, expected) {
  if (!Array.isArray(actual)) return false
  if (actual.length !== expected.length) return false
  const set = new Set(actual)
  return set.size === actual.length && expected.every((value) => set.has(value))
}

function text(value) {
  try { return JSON.stringify(value) } catch { return String(value) }
}

/** 校验 checks 形状；返回问题数组（先于任何 .filter 使用）。 */
function checkShape(checks) {
  const problems = []
  if (!Array.isArray(checks)) return ['checks 不是数组']
  for (let i = 0; i < checks.length; i += 1) {
    const check = checks[i]
    const at = 'checks[' + i + ']'
    if (check === null || typeof check !== 'object' || Array.isArray(check)) { problems.push(at + ' 不是对象'); continue }
    if (typeof check.kind !== 'string' || !ALLOWED_KINDS.has(check.kind)) { problems.push(at + ' kind 非法：' + text(check.kind)); continue }
    if (typeof check.id !== 'string' || check.id.length === 0) { problems.push(at + ' id 非法：' + text(check.id)); continue }
    if (check.kind === 'observation') continue
    if (typeof check.status !== 'string' || !ALLOWED_STATUSES.has(check.status)) problems.push(at + ' status 非法：' + text(check.status))
    if (check.kind === 'control' && check.status !== 'PASS' && check.status !== 'FAIL') problems.push(at + ' control status 必须是 PASS/FAIL')
    if (check.kind === 'defect' && check.status !== 'RED' && check.status !== 'GREEN') problems.push(at + ' defect status 必须是 RED/GREEN')
  }
  return problems
}

/** 由 checks 独立推导状态；不信任报告顶层 status / 自报汇总。 */
function derive(checks, mode) {
  const controls = checks.filter((check) => check.kind === 'control')
  const defects = checks.filter((check) => check.kind === 'defect')
  const controlIds = controls.map((check) => check.id)
  const defectIds = defects.map((check) => check.id)
  return {
    controls,
    defects,
    controlIds,
    defectIds,
    duplicateControl: new Set(controlIds).size !== controlIds.length,
    duplicateDefect: new Set(defectIds).size !== defectIds.length,
    controlPass: controls.every((check) => check.status === 'PASS'),
    allRed: defects.length > 0 && defects.every((check) => check.status === 'RED'),
    allGreen: defects.length > 0 && defects.every((check) => check.status === 'GREEN'),
    mode,
  }
}

function validateReport(report, spec, mode) {
  if (report === null || typeof report !== 'object' || Array.isArray(report)) return { problems: ['报告不是对象'], derived: null }
  const problems = []
  if (report.schema !== 'mcl-p0-fixture/1') problems.push('schema 不匹配：' + text(report.schema))
  if (report.fixture !== spec.id) problems.push('fixture 身份不匹配：' + text(report.fixture))
  if (report.mode !== mode) problems.push('mode 不匹配：' + text(report.mode))

  const shapeProblems = checkShape(report.checks)
  // 形状非法：先返回（problems 必须带上具体形状错误），绝不继续 filter 抛异常。
  if (shapeProblems.length > 0) return { problems: problems.concat(shapeProblems), derived: null }
  const derived = derive(report.checks, mode)

  if (report.status !== 'HARNESS_ERROR') {
    if (!sameSet(derived.controlIds, spec.controls)) problems.push('control 集合不匹配：[' + derived.controlIds.join(',') + '] != [' + spec.controls.join(',') + ']')
    if (!sameSet(derived.defectIds, spec.defects)) problems.push('defect 集合不匹配：[' + derived.defectIds.join(',') + '] != [' + spec.defects.join(',') + ']')
  }
  if (derived.duplicateControl) problems.push('control 重复：[' + derived.controlIds.join(',') + ']')
  if (derived.duplicateDefect) problems.push('defect 重复：[' + derived.defectIds.join(',') + ']')
  if (!derived.controlPass) problems.push('control 未全部 PASS：' + derived.controls.filter((check) => check.status !== 'PASS').map((check) => check.id).join(','))
  if (report.fatal !== null && report.fatal !== undefined) problems.push('夹具 fatal：' + text(report.fatal?.message ?? report.fatal))

  // 顶层 status 必须与 checks 推导严格一致，且只允许本文定义的四种。
  // HARNESS_ERROR 无条件保持失败：不再进入 EXPECTED_RED 分支。
  if (report.status === 'HARNESS_ERROR') {
    // 无条件失败；把自报缺失/失败/致命原因一并带出，便于定位「为什么红」。
    const reasons = problems.slice()
    if (Array.isArray(report.missingDefects) && report.missingDefects.length > 0) reasons.push('报告自报未执行 defect：' + report.missingDefects.join(','))
    if (Array.isArray(report.missingControls) && report.missingControls.length > 0) reasons.push('报告自报未执行 control：' + report.missingControls.join(','))
    if (Array.isArray(report.harnessErrors) && report.harnessErrors.length > 0) reasons.push('报告自报 harness 错误：' + report.harnessErrors.map((row) => row?.id + ':' + row?.detail).join('；'))
    return { problems: reasons.length > 0 ? reasons : ['status=HARNESS_ERROR（失败关闭）'], derived }
  }
  if (report.status !== 'EXPECTED_RED' && report.status !== 'UNEXPECTED_GREEN' && report.status !== 'GREEN' && report.status !== 'RED') {
    return { problems: problems.concat('未知顶层 status：' + text(report.status)), derived }
  }
  if (problems.length > 0) return { problems, derived }

  const expected = mode === 'baseline'
    ? (derived.allRed ? 'EXPECTED_RED' : 'UNEXPECTED_GREEN')
    : (derived.allGreen ? 'GREEN' : 'RED')
  if (report.status !== expected) problems.push('顶层 status 与 checks 推导不一致：' + report.status + ' != ' + expected)

  // 自报汇总只能作为附加证据；与独立推导不一致本身就是坏报告。
  if (Array.isArray(report.missingDefects) && report.missingDefects.length > 0) problems.push('报告自报未执行 defect：' + report.missingDefects.join(','))
  if (Array.isArray(report.missingControls) && report.missingControls.length > 0) problems.push('报告自报未执行 control：' + report.missingControls.join(','))
  if (Array.isArray(report.failedControls) && report.failedControls.length > 0) problems.push('报告自报 control 失败：' + report.failedControls.join(','))
  if (Array.isArray(report.harnessErrors) && report.harnessErrors.length > 0) problems.push('报告自报 harness 错误：' + report.harnessErrors.map((row) => row?.id + ':' + row?.detail).join('；'))
  return { problems, derived }
}

export function runOne(spec, { mode = 'baseline', root = here, timeoutMs = TIMEOUT_MS, allowHarnessErrorReport = false } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'mcl-p0-run-'))
  const reportPath = path.join(dir, 'report.json')
  try {
    const result = spawnSync(process.execPath, [path.join(root, spec.file)], {
      cwd: path.resolve(root, '..', '..'),
      env: { ...process.env, P0_MODE: mode, P0_REPORT_PATH: reportPath },
      timeout: timeoutMs,
      stdio: 'inherit',
    })
    const signal = result.signal ?? null
    const exitCode = result.status
    if (result.error !== undefined) {
      const timedOut = result.error?.code === 'ETIMEDOUT' || String(result.error?.message ?? '').includes('timed out')
      return { fixture: spec.id, status: 'HARNESS_ERROR', detail: (timedOut ? '子进程超时（' + String(timeoutMs) + ' ms）' : '子进程启动错误：') + String(result.error?.message ?? result.error), exitCode, signal }
    }
    if (signal !== null) return { fixture: spec.id, status: 'HARNESS_ERROR', detail: '子进程被信号终止：' + signal, exitCode, signal }
    if (!existsSync(reportPath)) return { fixture: spec.id, status: 'HARNESS_ERROR', detail: '缺少结构化报告（P0_REPORT_PATH=' + reportPath + '）', exitCode, signal }
    let report
    try {
      report = JSON.parse(readFileSync(reportPath, 'utf8'))
    } catch (error) {
      return { fixture: spec.id, status: 'HARNESS_ERROR', detail: '报告 JSON 不可解析：' + String(error?.message ?? error), exitCode, signal }
    }
    const validated = validateReport(report, spec, mode)
    if (validated.problems.length > 0) {
      // 自测需要精确看见「未自洽报告被拒」的原文；产品夹具仍走失败关闭。
      const status = allowHarnessErrorReport && report.status === 'HARNESS_ERROR' ? 'HARNESS_ERROR_REPORT' : 'HARNESS_ERROR'
      return { fixture: spec.id, status, detail: validated.problems.join('；'), exitCode, signal, report }
    }
    const { derived } = validated
    // 退出码必须与顶层状态一致；非零本身不足以判红，也不足以判任何状态。
    const expectedExit = report.status === 'EXPECTED_RED' || report.status === 'GREEN' ? 0
      : report.status === 'RED' ? 1
        : report.status === 'UNEXPECTED_GREEN' ? 2 : 3
    if (exitCode !== expectedExit) {
      return { fixture: spec.id, status: 'HARNESS_ERROR', detail: 'exit=' + String(exitCode) + ' 与 status=' + String(report.status) + ' 的预期 exit=' + expectedExit + ' 不一致', exitCode, signal, report }
    }
    if (report.status === 'EXPECTED_RED') {
      if (derived === null || !derived.allRed) return { fixture: spec.id, status: 'HARNESS_ERROR', detail: 'status=EXPECTED_RED 但并非全部 defect RED', exitCode, signal, report }
      return { fixture: spec.id, status: 'EXPECTED_RED', detail: '', exitCode, signal, report }
    }
    if (report.status === 'UNEXPECTED_GREEN') {
      return { fixture: spec.id, status: 'UNEXPECTED_GREEN', detail: '有 defect 变绿：' + derived.defects.filter((check) => check.status === 'GREEN').map((check) => check.id).join(','), exitCode, signal, report }
    }
    if (report.status === 'GREEN') return { fixture: spec.id, status: 'GREEN', detail: '', exitCode, signal, report }
    return { fixture: spec.id, status: 'RED', detail: '未满足：' + derived.defects.filter((check) => check.status === 'RED').map((check) => check.id).join(','), exitCode, signal, report }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * SUPERSEDED 件的判定：报告/control 已由 runOne 校验，这里只做**逐 defect 冻结比对**。
 * 返回 {ok, kind, detail}；kind ∈ 'frozen' | 'drift' | 'harness'。
 */
export function classifySuperseded(spec, row) {
  if (row === null || typeof row !== 'object') return { ok: false, kind: 'harness', detail: '无运行结果' }
  if (row.status === 'HARNESS_ERROR' || row.status === 'HARNESS_ERROR_REPORT') {
    return { ok: false, kind: 'harness', detail: row.detail ?? row.status }
  }
  const report = row.report
  if (report === null || typeof report !== 'object' || !Array.isArray(report.checks)) {
    return { ok: false, kind: 'harness', detail: '报告缺少 checks（无法核对冻结口径）' }
  }
  const actual = new Map()
  for (const check of report.checks) {
    if (check?.kind === 'defect' && typeof check.id === 'string') actual.set(check.id, check.status)
  }
  const drift = []
  for (const [id, expected] of Object.entries(spec.frozen ?? {})) {
    const got = actual.get(id)
    if (got !== expected) drift.push(id + '=' + String(got) + '（冻结口径为 ' + expected + '）')
  }
  for (const id of spec.defects ?? []) {
    if (!actual.has(id)) drift.push(id + '=缺失')
  }
  return drift.length === 0
    ? { ok: true, kind: 'frozen', detail: Object.entries(spec.frozen).map(([id, status]) => id + '=' + status).join(', ') }
    : { ok: false, kind: 'drift', detail: drift.join('；') }
}

function main() {
  const expectRed = process.argv.includes('--expect-red')
  const mode = expectRed ? 'baseline' : 'contract'
  const rows = FIXTURES.map((spec) => runOne(spec, { mode }))
  const superseded = SUPERSEDED.map((spec) => {
    const row = runOne(spec, { mode: 'baseline' })
    return { spec, row, verdict: classifySuperseded(spec, row) }
  })

  console.log('')
  console.log('P0 有效红色基线（' + (expectRed ? '--expect-red / 基线复现' : '契约门') + '）：')
  for (const row of rows) {
    console.log('- ' + row.fixture + ' ' + row_statusText(row) + (row.detail ? ' — ' + row.detail : ''))
  }
  const counts = rows.reduce((acc, row) => { acc[row.status] = (acc[row.status] ?? 0) + 1; return acc }, {})
  console.log('有效件会计：' + Object.entries(counts).map(([k, v]) => k + '=' + v).join(' / ') + ' / 共 ' + rows.length + ' 件')

  console.log('')
  console.log('P0 已转正 / 已超期件（逐 defect 冻结比对，不是「整件红」）：')
  for (const { spec, verdict } of superseded) {
    console.log('- ' + spec.id + ' ' + (verdict.ok ? '→ FROZEN（' : '→ ' + verdict.kind.toUpperCase() + '（') + verdict.detail + '）｜' + spec.promotedTo)
  }
  console.log('说明：' + SUPERSEDED.length + ' 件已由集成修复或契约替换（见 docs/dev-0.15.0/P0-基线证据.md §8）；RED 不等于当前缺陷，GREEN 也不等于整体通过。')

  const harnessErrors = rows.filter((row) => row.status === 'HARNESS_ERROR')
  const supersededHarness = superseded.filter(({ verdict }) => verdict.kind === 'harness')
  if (harnessErrors.length > 0 || supersededHarness.length > 0) {
    console.error('HARNESS_ERROR：运行器失败关闭——不能把环境崩溃/未执行断言/状态不自洽当成缺陷复现。')
    for (const { spec, verdict } of supersededHarness) console.error('- ' + spec.id + '：' + verdict.detail)
    process.exit(3)
  }
  const drifted = superseded.filter(({ verdict }) => verdict.kind === 'drift')
  if (drifted.length > 0) {
    console.error('冻结口径漂移：' + drifted.map(({ spec, verdict }) => spec.id + '（' + verdict.detail + '）').join('；'))
    console.error('处置：重新取证并把新口径写进 docs/dev-0.15.0/P0-基线证据.md 与本运行器；不得直接删件或放绿。')
    process.exit(1)
  }

  if (expectRed) {
    const unexpected = rows.filter((row) => row.status !== 'EXPECTED_RED')
    if (unexpected.length > 0) {
      console.error('未按预期红：' + unexpected.map((row) => row.fixture + '=' + row.status).join('、') + '——请把已满足的契约转正进正常 CI，并更新 P0 基线。')
      process.exit(2)
    }
    console.log('RED BASELINE REPRODUCED：' + rows.length + '/' + rows.length + ' 件有效红按预期红（缺陷复现成功，不是正确性通过）；'
      + SUPERSEDED.length + ' 件已转正/已超期按冻结口径一致。')
    process.exit(0)
  }
  const unmet = rows.filter((row) => row.status === 'RED')
  if (unmet.length > 0) {
    console.error('契约未满足：' + unmet.map((row) => row.fixture).join('、'))
    process.exit(1)
  }
  console.log('全部 ' + rows.length + ' 件有效契约通过（不含已转正/已超期件）。')
  process.exit(0)
}

function row_statusText(row) {
  if (row.status === 'EXPECTED_RED') return '→ EXPECTED_RED（缺陷复现）'
  if (row.status === 'GREEN') return '→ GREEN（契约满足）'
  if (row.status === 'RED') return '→ RED（契约未满足）'
  if (row.status === 'UNEXPECTED_GREEN') return '→ UNEXPECTED_GREEN（基线已变绿）'
  return '→ HARNESS_ERROR'
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
