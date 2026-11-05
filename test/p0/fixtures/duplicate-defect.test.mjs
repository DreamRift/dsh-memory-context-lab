/** 自测用：重复 defect id 必须 HARNESS_ERROR。 */
import { writeReportAndExit } from './run-report.mjs'
writeReportAndExit({
  fixture: 'SELFTEST-DUPLICATE',
  status: 'EXPECTED_RED',
  checks: [
    { kind: 'control', id: 'control.ok', status: 'PASS' },
    { kind: 'defect', id: 'defect.a', status: 'RED' },
    { kind: 'defect', id: 'defect.a', status: 'RED' },
  ],
}, 0)
