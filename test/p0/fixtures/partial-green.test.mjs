/** 自测用：基线模式下部分 defect 变绿 → UNEXPECTED_GREEN（exit 2），不能算复现成功。 */
import { runP0Fixture } from '../harness.mjs'
await runP0Fixture({ id: 'SELFTEST-PARTIAL', controls: ['control.ok'], defects: ['defect.a', 'defect.b'] }, async (t) => {
  t.control('control.ok', true)
  t.defect('defect.a', 1, 1)
  t.defect('defect.b', 1, 2)
})
