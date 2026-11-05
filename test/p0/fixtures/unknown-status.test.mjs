/** 自测用：未知顶层 status，必须 HARNESS_ERROR。 */
import { writeReportAndExit } from './run-report.mjs'
writeReportAndExit({ fixture: 'SELFTEST-UNKNOWN-STATUS', status: 'TOTALLY_FINE', checks: [{ kind: 'defect', id: 'defect.a', status: 'RED' }] }, 0)
