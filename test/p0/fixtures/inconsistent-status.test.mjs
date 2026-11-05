/** 自测用（主验收反例）：status=HARNESS_ERROR + defect RED + exit3 不得回 EXPECTED_RED。 */
import { writeReportAndExit } from './run-report.mjs'
writeReportAndExit({ fixture: 'SELFTEST-INCONSISTENT', status: 'HARNESS_ERROR', checks: [{ kind: 'defect', id: 'defect.a', status: 'RED' }] }, 3)
