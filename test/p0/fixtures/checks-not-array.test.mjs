/** 自测用：checks 不是数组，不得在 filter 处失控抛异常。 */
import { writeReportAndExit } from './run-report.mjs'
writeReportAndExit({ fixture: 'SELFTEST-CHECKS-NOT-ARRAY', status: 'EXPECTED_RED', checks: 'not-an-array' }, 0)
