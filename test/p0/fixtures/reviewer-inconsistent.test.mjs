/** 自测用：精确复刻主验收反例（fixture=REVIEW，status=HARNESS_ERROR，checks 仅 defect.a=RED，exit3）。 */
import { writeReportAndExit } from './run-report.mjs'
writeReportAndExit({ fixture: 'REVIEW', status: 'HARNESS_ERROR', checks: [{ kind: 'defect', id: 'defect.a', status: 'RED' }] }, 3)
