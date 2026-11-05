/** 自测用：control FAIL 但自报 failedControls=[]，不得因“自报干净”而通过。 */
import { writeReportAndExit } from './run-report.mjs'
writeReportAndExit({
  fixture: 'SELFTEST-CONTROL-LIE',
  status: 'EXPECTED_RED',
  checks: [
    { kind: 'control', id: 'control.ok', status: 'FAIL' },
    { kind: 'defect', id: 'defect.a', status: 'RED' },
  ],
  failedControls: [],
}, 0)
