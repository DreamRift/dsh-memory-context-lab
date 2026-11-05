/** 自测用：未捕获断言异常 → HARNESS_ERROR，不能算 RED。 */
import assert from 'node:assert/strict'
import { runP0Fixture } from '../harness.mjs'
await runP0Fixture({ id: 'SELFTEST-ASSERT', controls: ['control.ok'], defects: ['defect.a'] }, async (t) => {
  t.control('control.ok', true)
  assert.equal(1, 2, '非预期断言必须判 HARNESS_ERROR')
  t.defect('defect.a', 1, 2)
})
