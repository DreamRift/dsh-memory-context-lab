/**
 * 自测用：按传入的 JSON 片段写报告并退出指定码。
 * 只用于验证运行器是否独立校验，不承载任何产品断言。
 */
import { writeFileSync } from 'node:fs'

export function writeReportAndExit(spec, exitCode) {
  const report = {
    schema: 'mcl-p0-fixture/1',
    fixture: spec.fixture,
    mode: spec.mode ?? 'baseline',
    status: spec.status,
    declared: { controls: [], defects: [] },
    checks: spec.checks,
    missingDefects: spec.missingDefects ?? [],
    missingControls: spec.missingControls ?? [],
    failedControls: spec.failedControls ?? [],
    harnessErrors: spec.harnessErrors ?? [],
    fatal: spec.fatal ?? null,
  }
  writeFileSync(process.env.P0_REPORT_PATH, JSON.stringify(report, null, 2) + '\n', 'utf8')
  process.exit(exitCode)
}
