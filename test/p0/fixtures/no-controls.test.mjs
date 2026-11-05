/** 自测用：删除全部 control 声明并 exit 0，不得因缺陷全 RED 而通过。 */
import { writeReportAndExit } from './run-report.mjs'
writeReportAndExit({ fixture: 'SELFTEST-NOCONTROLS', status: 'EXPECTED_RED', checks: [{ kind: 'defect', id: 'defect.a', status: 'RED' }] }, 0)
