/** 自测用：control 失败必须先落 HARNESS_ERROR，不能算 RED。 */
import { runP0Fixture } from '../harness.mjs'
await runP0Fixture({ id: 'SELFTEST-CONTROL-FAIL', controls: ['control.ok'], defects: ['defect.a'] }, async (t) => {
  t.defect('defect.a', 1, 2)
  t.control('control.ok', false, '注入 control 失败')
})
