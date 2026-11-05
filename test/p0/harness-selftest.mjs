#!/usr/bin/env node
/**
 * P0 运行器自测：只验证「判定器」能否区分正常/崩溃，不验证任何产品缺陷。
 *
 * 覆盖：
 * 1. 真实 R01 基线 → EXPECTED_RED；
 * 2. 契约门全绿夹具 → GREEN；
 * 3. 基线部分变绿 → UNEXPECTED_GREEN；
 * 4. control 失败 → HARNESS_ERROR；
 * 5. 漏声明 defect → HARNESS_ERROR；
 * 6. 未捕获断言 → HARNESS_ERROR；
 * 7. 缺文件 → HARNESS_ERROR；
 * 8. 坏报告 / 缺报告 / 身份不符 → HARNESS_ERROR；
 * 9. 信号 / 超时 → HARNESS_ERROR；
 * 10. status=HARNESS_ERROR + checks 全 RED + exit3 → HARNESS_ERROR（主验收反例）；
 * 11. 删除全部 control → HARNESS_ERROR（不能靠自报 missingControls=[] 静默通过）；
 * 12. control FAIL 但 failedControls=[] → HARNESS_ERROR（不信自报汇总）；
 * 13. checks 不是数组 → HARNESS_ERROR（先形状校验，不在 filter 失控）；
 * 14. 未知顶层 status → HARNESS_ERROR；
 * 15. 非法 check kind / 重复 defect → HARNESS_ERROR；
 * 16. SUPERSEDED 冻结比对：逐 defect 一致 → FROZEN，状态/缺项变化 → DRIFT，运行器失败 → harness。
 *
 * 退出码 0 仅当全部断言通过；失败 exit 1。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { runOne, FIXTURES, classifySuperseded } from './run-red-baseline.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixtureDir = path.join(here, 'fixtures')

const REVIEW_SPEC = (id, file, controls, defects) => ({ id, file, controls, defects })

function runFixture(id, file, controls, defects, mode = 'baseline', extra = {}) {
  return runOne(REVIEW_SPEC(id, file, controls, defects), { mode, root: fixtureDir, allowHarnessErrorReport: true, ...extra })
}

// 1) 正常预期红：真实 R01 夹具。
const r01 = FIXTURES.find((row) => row.id === 'R01')
assert.equal(runOne(r01, { mode: 'baseline' }).status, 'EXPECTED_RED', '真实 R01 在基线模式应 EXPECTED_RED')

// 2) 正常绿：契约门用自测绿夹具。
const green = runFixture('SELFTEST-GREEN', 'green-all.test.mjs', ['control.ok'], ['defect.a', 'defect.b'], 'contract')
assert.equal(green.status, 'GREEN', '全满足夹具在契约门应 GREEN')

// 3) 基线模式下部分变绿。
const partial = runFixture('SELFTEST-PARTIAL', 'partial-green.test.mjs', ['control.ok'], ['defect.a', 'defect.b'], 'baseline')
assert.equal(partial.status, 'UNEXPECTED_GREEN', '部分 defect 变绿必须 UNEXPECTED_GREEN')

// 4) control 失败 → HARNESS_ERROR。
const controlFail = runFixture('SELFTEST-CONTROL-FAIL', 'control-fail.test.mjs', ['control.ok'], ['defect.a'])
assert.equal(controlFail.status, 'HARNESS_ERROR_REPORT', 'control 失败必须 HARNESS_ERROR')
assert.match(controlFail.detail, /control 失败|报告/, '错误信息应点名 control：' + controlFail.detail)

// 5) 漏声明 defect → HARNESS_ERROR。
const missing = runFixture('SELFTEST-MISSING', 'missing-defect.test.mjs', [], ['defect.a', 'defect.b'])
assert.equal(missing.status, 'HARNESS_ERROR_REPORT', '漏声明必须 HARNESS_ERROR')
assert.match(missing.detail, /未执行 defect|control 集合|报告/, '错误信息应点名未执行/集合：' + missing.detail)

// 6) 未捕获断言 → HARNESS_ERROR。
const assertion = runFixture('SELFTEST-ASSERT', 'unexpected-assertion.test.mjs', ['control.ok'], ['defect.a'])
assert.equal(assertion.status, 'HARNESS_ERROR_REPORT', '未捕获断言必须 HARNESS_ERROR（夹具安全网落报告，运行器失败关闭）')

// 7) 缺文件 → HARNESS_ERROR。
const missingFile = runFixture('SELFTEST-MISSING-FILE', 'does-not-exist.test.mjs', [], ['defect.a'])
assert.equal(missingFile.status, 'HARNESS_ERROR', '缺文件必须 HARNESS_ERROR')

// 8) 坏报告 / 缺报告 / 身份不符。
const root = mkdtempSync(path.join(tmpdir(), 'mcl-p0-selftest-'))
try {
  const badFile = path.join(root, 'bad-report.test.mjs')
  writeFileSync(badFile, 'import { writeFileSync } from "node:fs"\nwriteFileSync(process.env.P0_REPORT_PATH, "{not-json")\n', 'utf8')
  const badReport = runOne(REVIEW_SPEC('SELFTEST-BADREPORT', 'bad-report.test.mjs', [], ['defect.a']), { mode: 'baseline', root })
  assert.equal(badReport.status, 'HARNESS_ERROR', '坏报告必须 HARNESS_ERROR')

  const noReportFile = path.join(root, 'no-report.test.mjs')
  writeFileSync(noReportFile, 'process.exit(1)\n', 'utf8')
  const noReport = runOne(REVIEW_SPEC('SELFTEST-NOREPORT', 'no-report.test.mjs', [], ['defect.a']), { mode: 'baseline', root })
  assert.equal(noReport.status, 'HARNESS_ERROR', '无报告必须 HARNESS_ERROR')

  const wrongIdFile = path.join(root, 'wrong-id.test.mjs')
  writeFileSync(wrongIdFile, 'import { writeFileSync } from "node:fs"\nwriteFileSync(process.env.P0_REPORT_PATH, JSON.stringify({schema:"mcl-p0-fixture/1",fixture:"OTHER",mode:"baseline",status:"EXPECTED_RED",declared:{controls:[],defects:[]},checks:[{kind:"defect",id:"defect.a",status:"RED"}],missingDefects:[],missingControls:[],failedControls:[],harnessErrors:[],fatal:null}))\n', 'utf8')
  const wrongId = runOne(REVIEW_SPEC('SELFTEST-WRONGID', 'wrong-id.test.mjs', [], ['defect.a']), { mode: 'baseline', root })
  assert.equal(wrongId.status, 'HARNESS_ERROR', '身份不匹配必须 HARNESS_ERROR')

  const signalFile = path.join(root, 'signal.test.mjs')
  writeFileSync(signalFile, 'process.kill(process.pid, "SIGTERM")\n', 'utf8')
  const signal = runOne(REVIEW_SPEC('SELFTEST-SIGNAL', 'signal.test.mjs', [], ['defect.a']), { mode: 'baseline', root })
  assert.equal(signal.status, 'HARNESS_ERROR', '信号终止必须 HARNESS_ERROR')

  const hangFile = path.join(root, 'hang.test.mjs')
  writeFileSync(hangFile, 'setInterval(() => {}, 1000)\n', 'utf8')
  const hang = runOne(REVIEW_SPEC('SELFTEST-HANG', 'hang.test.mjs', [], ['defect.a']), { mode: 'baseline', root, timeoutMs: 150 })
  assert.equal(hang.status, 'HARNESS_ERROR', '超时必须 HARNESS_ERROR')
  assert.match(hang.detail, /超时|启动|信号/, '超时信息应可判读：' + hang.detail)
} finally {
  rmSync(root, { recursive: true, force: true })
}

// 10) 主验收反例：status=HARNESS_ERROR + checks 全 RED + exit3 不得回 EXPECTED_RED。
const inconsistent = runFixture('SELFTEST-INCONSISTENT', 'inconsistent-status.test.mjs', [], ['defect.a'])
assert.equal(inconsistent.status, 'HARNESS_ERROR_REPORT', 'status=HARNESS_ERROR 必须无条件失败，不能按 checks 全 RED 回 EXPECTED_RED')
assert.match(inconsistent.detail, /HARNESS_ERROR/, '错误信息应保留失败关闭原因：' + inconsistent.detail)

// 10b) 精确复刻主验收反例：fixture=REVIEW，status=HARNESS_ERROR，checks 仅 defect.a=RED，exit3。
const review = runOne({ id: 'REVIEW', file: 'reviewer-inconsistent.test.mjs', controls: [], defects: ['defect.a'] }, { mode: 'baseline', root: fixtureDir, allowHarnessErrorReport: true })
assert.equal(review.status, 'HARNESS_ERROR_REPORT', '主验收反例必须回失败关闭（不得回 EXPECTED_RED）')
assert.match(review.detail, /HARNESS_ERROR/, '主验收反例的错误原文应保留：' + review.detail)

// 11) 删除全部 control 声明但 exit0：必须因外置 control 集合不匹配而失败。
const noControls = runFixture('SELFTEST-NOCONTROLS', 'no-controls.test.mjs', ['control.ok'], ['defect.a'])
assert.equal(noControls.status, 'HARNESS_ERROR', '删除全部 control 必须 HARNESS_ERROR（不能只信自报 missingControls）')
assert.match(noControls.detail, /control 集合不匹配/, '错误信息应点名 control 集合：' + noControls.detail)

// 12) control FAIL 但 failedControls=[]：必须因 checks 中 control 非 PASS 而失败。
const controlLie = runFixture('SELFTEST-CONTROL-LIE', 'control-fail-lie.test.mjs', ['control.ok'], ['defect.a'])
assert.equal(controlLie.status, 'HARNESS_ERROR', 'control FAIL + 自报空汇总必须 HARNESS_ERROR')
assert.match(controlLie.detail, /control 未全部 PASS/, '错误信息应点名 control 未 PASS：' + controlLie.detail)

// 13) checks 不是数组：先形状校验，不得在 filter 处失控。
const notArray = runFixture('SELFTEST-CHECKS-NOT-ARRAY', 'checks-not-array.test.mjs', ['control.ok'], ['defect.a'])
assert.equal(notArray.status, 'HARNESS_ERROR', 'checks 非数组必须 HARNESS_ERROR')
assert.match(notArray.detail, /checks 不是数组/, '错误信息应点名 checks 形状：' + notArray.detail)

// 14) 未知顶层 status。
const unknown = runFixture('SELFTEST-UNKNOWN-STATUS', 'unknown-status.test.mjs', [], ['defect.a'])
assert.equal(unknown.status, 'HARNESS_ERROR', '未知顶层 status 必须 HARNESS_ERROR')
assert.match(unknown.detail, /未知顶层 status/, '错误信息应点名未知 status：' + unknown.detail)

// 15) 非法 check kind / 重复 defect。
const illegal = runFixture('SELFTEST-ILLEGAL-SHAPE', 'illegal-check-shape.test.mjs', ['control.ok'], ['defect.a'])
assert.equal(illegal.status, 'HARNESS_ERROR', '非法 check kind 必须 HARNESS_ERROR')
assert.match(illegal.detail, /kind 非法/, '错误信息应点名 kind：' + illegal.detail)

const duplicate = runFixture('SELFTEST-DUPLICATE', 'duplicate-defect.test.mjs', ['control.ok'], ['defect.a'])
assert.equal(duplicate.status, 'HARNESS_ERROR', '重复 defect 必须 HARNESS_ERROR')
assert.match(duplicate.detail, /defect 重复/, '错误信息应点名重复：' + duplicate.detail)

// 16) SUPERSEDED 冻结口径：逐 defect 比对，状态一变即 DRIFT（不静默放绿/删件）。
const FROZEN_SPEC = { id: 'SUPERSEDED-X', defects: ['defect.a', 'defect.b'], frozen: { 'defect.a': 'GREEN', 'defect.b': 'RED' } }
const frozenReport = (statuses) => ({
  status: 'x',
  report: { checks: statuses.map(([id, status]) => ({ kind: 'defect', id, status })) },
})
const frozenOk = classifySuperseded(FROZEN_SPEC, frozenReport([['defect.a', 'GREEN'], ['defect.b', 'RED']]))
assert.equal(frozenOk.ok, true, '冻结口径一致必须判 FROZEN')
assert.equal(frozenOk.kind, 'frozen')

const frozenDrift = classifySuperseded(FROZEN_SPEC, frozenReport([['defect.a', 'GREEN'], ['defect.b', 'GREEN']]))
assert.equal(frozenDrift.ok, false, '冻结口径变化必须判 DRIFT（不得静默接受）')
assert.equal(frozenDrift.kind, 'drift')
assert.match(frozenDrift.detail, /defect\.b/, 'DRIFT 必须点名变化项：' + frozenDrift.detail)

const frozenMissing = classifySuperseded(FROZEN_SPEC, frozenReport([['defect.a', 'GREEN']]))
assert.equal(frozenMissing.ok, false, '缺项必须判 DRIFT（不能只比对报告里出现的键）')
assert.equal(frozenMissing.kind, 'drift')

const frozenHarness = classifySuperseded(FROZEN_SPEC, { status: 'HARNESS_ERROR', detail: '报告缺失' })
assert.equal(frozenHarness.ok, false, '运行器失败必须判 harness，不能当口径一致')
assert.equal(frozenHarness.kind, 'harness')

console.log('P0 harness 自测：全部 16 组 + SUPERSEDED 冻结比对 4 断言通过（判定器能区分 EXPECTED_RED / HARNESS_ERROR / 冻结口径漂移；主验收反例已精确复刻）。')
