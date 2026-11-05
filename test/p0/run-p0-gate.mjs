#!/usr/bin/env node
/**
 * 0.15.0 P0 门禁（测试域单入口，**不**接入 scripts/test-all.mjs）。
 *
 * 目标不是「让数字好看」，而是让 P0 的五类证据**可一条命令复算**，并把范围写在输出里：
 *   1. baseline-freeze  现行基线指纹（git blob 计算、两次运行逐字节一致、与冻结表逐字段相等）
 *   2. red-baseline     有效红 R01/R03 复现 + 已转正/已超期件逐 defect 冻结比对
 *   3. ci-isolation     P0 目录按设计不进入全量 CI（静态证据）
 *   4. r06-closure      R06 调用闭包探针在修后应转绿（R07 风险对照单列）
 *   5. host-contract    宿主源码契约探针（28 条；未给 asar → SKIP，不当 PASS 也不当 FAIL）
 *
 * ## 证据边界（不得升级）
 * 本门禁只产出 `source-level` 与 `fixture-level` 证据：
 * - **不是**真实宿主运行时序（pre-step → append → buildRequest 的运行时隙未观测）；
 * - **不是**供应商 wire JSON（llm/stream 只是 adapter 之前的逻辑请求）；
 * - 未给 `--asar` 时 host-contract 是 SKIP，**不**等于契约通过。
 * 这些非主张随每次输出一起打印，避免下游把「门禁绿」当成「真实宿主已验」。
 *
 * ## 运行
 *   node test/p0/run-p0-gate.mjs
 *   node test/p0/run-p0-gate.mjs --asar "<DSH>/resources/app.asar"
 *   node test/p0/run-p0-gate.mjs --json > .tmp/p0-gate.json   # 机器可读（stdout 仅 JSON）
 *
 * ## 退出码
 *   0 = 全部 PASS/SKIP（SKIP 会显式列出，绝不冒充 PASS）
 *   1 = 证据漂移（指纹/冻结口径/契约探针不符，或有效红变绿）
 *   3 = HARNESS_ERROR（子进程崩溃/输出不可解析——失败关闭）
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { BASELINE, EVIDENCE_SCOPE, NON_CLAIMS } from './baseline-freeze.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.resolve(here, '..', '..')
const argv = process.argv.slice(2)
const jsonOnly = argv.includes('--json')
const asarIndex = argv.indexOf('--asar')
const asarArg = asarIndex >= 0 ? argv[asarIndex + 1] : undefined
if (asarIndex >= 0 && (typeof asarArg !== 'string' || asarArg.length === 0 || asarArg.startsWith('--'))) {
  console.error('[p0-gate] 用法错误：--asar 必须带值（要 SKIP 请完全省略该参数）')
  process.exit(2)
}

const checks = []
function record(id, status, scope, detail) {
  checks.push({ id, status, scope, detail })
  if (!jsonOnly) console.log('[' + status + '] ' + id + '（' + scope + '）' + (detail ? ' — ' + detail : ''))
}
function harness(id, scope, detail) {
  record(id, 'HARNESS_ERROR', scope, detail)
}

function node(args, options = {}) {
  const result = spawnSync(process.execPath, args, { cwd: pluginRoot, encoding: 'utf8', timeout: options.timeoutMs ?? 300000 })
  return { status: result.status, signal: result.signal, stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: result.error }
}

// 1) 基线指纹：两次运行逐字节一致 + 与冻结表逐字段相等。
try {
  const script = path.join('test', 'p0', 'fingerprint-baseline.mjs')
  const first = node([script, BASELINE.commit])
  const second = node([script, BASELINE.commit])
  if (first.error !== undefined || first.signal !== null) {
    harness('baseline-freeze', 'repo', '指纹子进程异常：' + String(first.error?.message ?? first.signal))
  } else if (first.status !== 0) {
    harness('baseline-freeze', 'repo', '指纹脚本非零退出（exit=' + String(first.status) + '）：' + first.stderr.trim().slice(0, 200))
  } else if (first.stdout !== second.stdout) {
    record('baseline-freeze', 'FAIL', 'repo', '同提交两次运行输出不一致（确定性被破坏）')
  } else {
    let parsed = null
    try { parsed = JSON.parse(first.stdout) } catch { parsed = null }
    if (parsed === null) {
      harness('baseline-freeze', 'repo', '指纹输出不可解析为 JSON')
    } else {
      const problems = []
      if (parsed.commit !== BASELINE.commit) problems.push('commit=' + String(parsed.commit))
      if (parsed.tree !== BASELINE.tree) problems.push('tree=' + String(parsed.tree))
      if (parsed.manifest?.version !== BASELINE.manifest.version) problems.push('manifest=' + String(parsed.manifest?.version))
      if (parsed.testSuite?.topLevelTestFiles !== BASELINE.topLevelTestFiles) problems.push('topLevelTestFiles=' + String(parsed.testSuite?.topLevelTestFiles))
      for (const [key, expected] of Object.entries(BASELINE.fingerprints)) {
        if (parsed.fingerprints?.[key] !== expected) problems.push(key + '=' + String(parsed.fingerprints?.[key]) + '（冻结 ' + expected + '）')
      }
      if (problems.length > 0) record('baseline-freeze', 'FAIL', 'repo', '指纹漂移：' + problems.join('；'))
      else record('baseline-freeze', 'PASS', 'repo', BASELINE.commit.slice(0, 12) + ' manifest=' + BASELINE.manifest.version + ' 两次一致')
    }
  }
} catch (error) {
  harness('baseline-freeze', 'repo', '门禁内部错误：' + String(error?.message ?? error))
}

// 2) 红色基线会计（含已转正件的冻结比对）。
try {
  const result = node([path.join('test', 'p0', 'run-red-baseline.mjs'), '--expect-red'])
  if (result.error !== undefined || result.signal !== null) {
    harness('red-baseline', 'fixture', '子进程异常：' + String(result.error?.message ?? result.signal))
  } else if (result.status === 0) {
    record('red-baseline', 'PASS', 'fixture', 'R01/R03 有效红复现；R02/R04/R08 冻结口径一致')
  } else if (result.status === 3) {
    harness('red-baseline', 'fixture', '运行器失败关闭：' + (result.stderr.trim().split(/\r?\n/).pop() ?? ''))
  } else {
    record('red-baseline', 'FAIL', 'fixture', 'exit=' + String(result.status) + '：' + (result.stderr.trim().split(/\r?\n/)[0] ?? ''))
  }
} catch (error) {
  harness('red-baseline', 'fixture', '门禁内部错误：' + String(error?.message ?? error))
}

// 3) CI 隔离：P0 目录不得被全量聚合器或 npm 脚本扫到。
try {
  const allSource = readFileSync(path.join(pluginRoot, 'scripts', 'test-all.mjs'), 'utf8')
  const manifest = JSON.parse(readFileSync(path.join(pluginRoot, 'package.json'), 'utf8'))
  const problems = []
  if (/p0/i.test(allSource)) problems.push('scripts/test-all.mjs 提及 p0')
  for (const [name, value] of Object.entries(manifest.scripts ?? {})) {
    if (typeof value === 'string' && /p0|test\/p0/i.test(value)) problems.push('package.json scripts.' + name + ' 提及 p0')
  }
  const topLevel = readdirSync(path.join(pluginRoot, 'test')).filter((name) => name.endsWith('.test.mjs'))
  if (topLevel.some((name) => /^p0/i.test(name))) problems.push('顶层 test/ 出现 p0*.test.mjs')
  if (problems.length > 0) record('ci-isolation', 'FAIL', 'repo', problems.join('；'))
  else record('ci-isolation', 'PASS', 'repo', '全量聚合器只扫顶层 ' + topLevel.length + ' 套；P0 目录不入 CI')
} catch (error) {
  harness('ci-isolation', 'repo', '读取聚合器/manifest 失败：' + String(error?.message ?? error))
}

// 4) R06 调用闭包探针（修后应 R06-GREEN；R07 风险对照单列）。
try {
  const result = node([path.join('test', 'helpers', 'p0-r06-tool-closure-baseline.mjs')])
  if (result.error !== undefined || result.signal !== null) {
    harness('r06-closure', 'fixture', '子进程异常：' + String(result.error?.message ?? result.signal))
  } else if (result.status === 0 && /red_open=0\/3/.test(result.stdout)) {
    record('r06-closure', 'PASS', 'fixture', '4/4 控制 PASS、3/3 红组转绿（R06 已修）；R07 风险仅登记')
  } else if (result.status === 2) {
    harness('r06-closure', 'fixture', '夹具清单/形状错误（exit 2）')
  } else {
    record('r06-closure', 'FAIL', 'fixture', 'exit=' + String(result.status) + '：' + (result.stdout.trim().split(/\r?\n/).pop() ?? ''))
  }
} catch (error) {
  harness('r06-closure', 'fixture', '门禁内部错误：' + String(error?.message ?? error))
}

// 5) 宿主源码契约（未给 asar = SKIP，不当 PASS）。
try {
  const probeArgs = [path.join('test', 'helpers', 'host-contract-probe-0150.mjs')]
  if (asarArg !== undefined) probeArgs.push('--asar', asarArg)
  const result = node(probeArgs, { timeoutMs: 180000 })
  const out = result.stdout
  if (result.error !== undefined || result.signal !== null) {
    harness('host-contract', 'source', '子进程异常：' + String(result.error?.message ?? result.signal))
  } else if (/^\[probe:host-0150\] SKIP/m.test(out)) {
    record('host-contract', 'SKIP', 'source', '未提供 --asar/DSH_ASAR：契约探针未执行（不是通过）')
  } else if (result.status === 2) {
    harness('host-contract', 'source', '用法/asar 结构错误（exit 2）')
  } else {
    const match = /checks=(\d+) failed=(\d+)/.exec(out)
    if (match === null) {
      harness('host-contract', 'source', '探针输出不可解析')
    } else if (result.status === 0 && Number(match[2]) === 0 && Number(match[1]) === BASELINE.host.contractChecks) {
      record('host-contract', 'PASS', 'source', 'dsh=' + BASELINE.host.version + ' ' + match[1] + '/' + match[1] + ' 契约（源码级）')
    } else {
      record('host-contract', 'FAIL', 'source', '契约漂移：checks=' + match[1] + ' failed=' + match[2] + ' exit=' + String(result.status))
    }
  }
} catch (error) {
  harness('host-contract', 'source', '门禁内部错误：' + String(error?.message ?? error))
}

const failed = checks.filter((row) => row.status === 'FAIL')
const harnessed = checks.filter((row) => row.status === 'HARNESS_ERROR')
const skipped = checks.filter((row) => row.status === 'SKIP')
const summary = {
  schema: 'mcl-p0-gate/1',
  baseline: { commit: BASELINE.commit, manifest: BASELINE.manifest, fingerprints: BASELINE.fingerprints },
  checks,
  accounting: {
    total: checks.length,
    pass: checks.filter((row) => row.status === 'PASS').length,
    skip: skipped.length,
    fail: failed.length,
    harnessError: harnessed.length,
  },
  evidenceScope: EVIDENCE_SCOPE,
  nonClaims: NON_CLAIMS,
  verdict: harnessed.length > 0 ? 'HARNESS_ERROR' : failed.length > 0 ? 'DRIFT' : skipped.length > 0 ? 'PASS_WITH_SKIP' : 'PASS',
}

if (jsonOnly) {
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n')
} else {
  console.log('')
  console.log('证据范围：' + EVIDENCE_SCOPE.join(' + ') + '（不含真实宿主运行时序与供应商 wire）')
  for (const claim of NON_CLAIMS) console.log('非主张：' + claim)
  console.log('会计：PASS=' + summary.accounting.pass + ' / SKIP=' + summary.accounting.skip + ' / FAIL=' + summary.accounting.fail + ' / HARNESS_ERROR=' + summary.accounting.harnessError + ' / 共 ' + summary.accounting.total)
  for (const row of skipped) console.log('SKIP 明细：' + row.id + ' — ' + row.detail)
  console.log('verdict=' + summary.verdict)
}

if (harnessed.length > 0) process.exit(3)
if (failed.length > 0) process.exit(1)
process.exit(0)
