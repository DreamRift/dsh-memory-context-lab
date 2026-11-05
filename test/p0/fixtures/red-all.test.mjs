/** 自测用：全部 defect 未满足（基线模式下应是 EXPECTED_RED）。 */
import { runP0Fixture } from '../harness.mjs'
await runP0Fixture({ id: 'SELFTEST-RED', controls: ['control.ok'], defects: ['defect.a', 'defect.b'] }, async (t) => {
  t.control('control.ok', true)
  t.defect('defect.a', 1, 2)
  t.defect('defect.b', 'x', 'y')
})
