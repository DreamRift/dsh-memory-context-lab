/**
 * P0 夹具的结构化结果协议（测试域）。
 *
 * 为什么不用「退出码非 0」判红：node 断言失败、模块缺失、语法错误、子进程信号
 * 都可能 exit 1；把任何非零都当 EXPECTED_RED 会把环境崩溃当成缺陷复现。
 *
 * 本协议要求夹具输出**有身份的断言结果**：
 * - control：夹具自身前置（装配、检索命中、正常路径）必须全部声明并 PASS；
 * - defect：记录 observed/desired；baseline 模式下全为 RED 才是 EXPECTED_RED，
 *   contract 模式下全为 GREEN 才是通过；
 * - 任何未声明/未执行/重复的 id、fatal 异常、报告缺失 → HARNESS_ERROR。
 *
 * 报告写 P0_REPORT_PATH（JSON），顶层 status 必须与 checks 推导结果严格一致；
 * 运行器再次独立校验（不信任夹具自报的 missing/failed 汇总）。
 */
import { writeFileSync } from 'node:fs'

const MODE = process.env.P0_MODE === 'contract' ? 'contract' : 'baseline'
const REPORT_PATH = process.env.P0_REPORT_PATH

function stable(value) {
  try { return JSON.stringify(value) } catch { return String(value) }
}

export function normalizeError(error) {
  return {
    name: error?.name ?? 'Error',
    message: error?.message ?? String(error),
    stack: error?.stack ?? null,
  }
}

function assertSpec(spec) {
  if (spec === null || typeof spec !== 'object') throw new Error('P0 spec 必须是对象')
  if (typeof spec.id !== 'string' || spec.id.length === 0) throw new Error('P0 spec.id 必须是非空字符串')
  for (const key of ['controls', 'defects']) {
    const list = spec[key]
    if (!Array.isArray(list)) throw new Error('P0 spec.' + key + ' 必须是数组（可为空，但空集合会在运行器外置期望处失败）')
    if (new Set(list).size !== list.length) throw new Error('P0 spec.' + key + ' 不得重复')
    if (list.some((id) => typeof id !== 'string' || id.length === 0)) throw new Error('P0 spec.' + key + ' 必须是非空字符串')
  }
}

/**
 * @param {{id: string, controls: string[], defects: string[]}} spec
 * @param {(t: object) => Promise<void>} body
 */
export async function runP0Fixture(spec, body) {
  assertSpec(spec)
  // 安全网：未捕获异常/未处理 rejection 也必须落成 HARNESS_ERROR 报告，
  // 不能只留下 exit 1 让运行器去猜。
  const guard = createGuard(spec)
  try {
    return await runGuarded(guard, spec, body)
  } finally {
    guard.disarm()
  }
}

function writeReport(report) {
  if (typeof REPORT_PATH === 'string' && REPORT_PATH.length > 0) {
    writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2) + '\n', 'utf8')
  }
}

function createGuard(spec) {
  const state = { done: false }
  const onFatal = (error) => {
    if (state.done) return
    state.done = true
    try {
      writeReport({
        schema: 'mcl-p0-fixture/1',
        fixture: spec.id,
        mode: MODE,
        status: 'HARNESS_ERROR',
        declared: { controls: spec.controls, defects: spec.defects },
        checks: [],
        missingDefects: spec.defects,
        missingControls: spec.controls,
        failedControls: [],
        harnessErrors: [{ id: 'fatal', detail: String(error?.message ?? error) }],
        fatal: normalizeError(error),
      })
    } catch { /* 落盘失败只能靠退出码 */ }
    process.exit(3)
  }
  process.on('uncaughtException', onFatal)
  process.on('unhandledRejection', onFatal)
  return {
    state,
    markDone() { state.done = true },
    disarm() {
      process.off('uncaughtException', onFatal)
      process.off('unhandledRejection', onFatal)
    },
  }
}

async function runGuarded(guard, spec, body) {
  const { id, controls: declaredControls, defects: declaredDefects } = spec
  const checks = []
  const harnessErrors = []
  const seenDefects = new Set()
  const seenControls = new Set()
  let fatal = null

  const t = {
    observe(checkId, value, detail = null) {
      checks.push({ kind: 'observation', id: checkId, value, detail })
    },
    control(checkId, ok, detail = null) {
      if (!declaredControls.includes(checkId)) throw new Error('未声明的 control：' + checkId)
      if (seenControls.has(checkId)) throw new Error('重复 control：' + checkId)
      seenControls.add(checkId)
      checks.push({ kind: 'control', id: checkId, status: ok === true ? 'PASS' : 'FAIL', detail })
      if (ok !== true) throw new Error('control 失败：' + checkId + (detail === null ? '' : ' — ' + detail))
    },
    harnessError(checkId, detail = null) {
      harnessErrors.push({ id: checkId, detail })
    },
    defect(checkId, observed, desired, detail = null) {
      if (!declaredDefects.includes(checkId)) throw new Error('未声明的 defect：' + checkId)
      if (seenDefects.has(checkId)) throw new Error('重复 defect：' + checkId)
      seenDefects.add(checkId)
      const equal = stable(observed) === stable(desired)
      checks.push({ kind: 'defect', id: checkId, status: equal ? 'GREEN' : 'RED', observed, desired, detail })
    },
  }

  try {
    await body(t)
  } catch (error) {
    fatal = normalizeError(error)
  }

  const missingDefects = declaredDefects.filter((checkId) => !seenDefects.has(checkId))
  const missingControls = declaredControls.filter((checkId) => !seenControls.has(checkId))
  const failedControls = checks.filter((check) => check.kind === 'control' && check.status !== 'PASS')
  const defectChecks = checks.filter((check) => check.kind === 'defect')
  const allRed = defectChecks.length > 0 && defectChecks.every((check) => check.status === 'RED')
  const allGreen = defectChecks.length > 0 && defectChecks.every((check) => check.status === 'GREEN')

  // 顶层 status 只由这一处推导；下面没有再按 defect 覆盖它的分支。
  let status
  let exitCode
  if (fatal !== null || harnessErrors.length > 0 || missingDefects.length > 0 || missingControls.length > 0 || failedControls.length > 0) {
    status = 'HARNESS_ERROR'
    exitCode = 3
  } else if (MODE === 'baseline') {
    status = allRed ? 'EXPECTED_RED' : 'UNEXPECTED_GREEN'
    exitCode = status === 'EXPECTED_RED' ? 0 : 2
  } else {
    status = allGreen ? 'GREEN' : 'RED'
    exitCode = status === 'GREEN' ? 0 : 1
  }

  guard.markDone()
  const report = {
    schema: 'mcl-p0-fixture/1',
    fixture: id,
    mode: MODE,
    status,
    declared: { controls: declaredControls, defects: declaredDefects },
    checks,
    missingDefects,
    missingControls,
    failedControls: failedControls.map((check) => check.id),
    harnessErrors,
    fatal,
  }
  if (typeof REPORT_PATH !== 'string' || REPORT_PATH.length === 0) {
    console.error('P0: P0_REPORT_PATH 未设置——夹具必须输出结构化结果，不能只靠退出码')
    process.exitCode = 3
    return report
  }
  writeReport(report)
  console.log('P0 ' + id + ' [' + MODE + '] → ' + status + '（defects: '
    + defectChecks.map((check) => check.id + '=' + check.status).join(', ') + '）')
  process.exitCode = exitCode
  return report
}
