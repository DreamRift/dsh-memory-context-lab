/** 自测用：非法 check 形状（kind/status/重复）必须 HARNESS_ERROR。 */
import { writeReportAndExit } from './run-report.mjs'
writeReportAndExit({
  fixture: 'SELFTEST-ILLEGAL-SHAPE',
  status: 'EXPECTED_RED',
  checks: [
    { kind: 'control', id: 'control.ok', status: 'PASS' },
    { kind: 'nonsense', id: 'defect.a', status: 'RED' },
  ],
}, 0)
