/** 自测用：全部 defect 满足（契约门 GREEN）。 */
import { runP0Fixture } from '../harness.mjs'
await runP0Fixture({ id: 'SELFTEST-GREEN', controls: ['control.ok'], defects: ['defect.a', 'defect.b'] }, async (t) => {
  t.control('control.ok', true)
  t.defect('defect.a', 1, 1)
  t.defect('defect.b', 'x', 'x')
})
