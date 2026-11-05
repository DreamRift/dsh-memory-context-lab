/** 自测用：漏报一个已声明 defect → HARNESS_ERROR，不能算 EXPECTED_RED。 */
import { runP0Fixture } from '../harness.mjs'
await runP0Fixture({ id: 'SELFTEST-MISSING', controls: [], defects: ['defect.a', 'defect.b'] }, async (t) => {
  t.defect('defect.a', 1, 2)
})
