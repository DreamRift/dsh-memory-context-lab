/**
 * v3 能力协商契约测试（M1 + beta.35 隔离 T2）。
 *
 * ## 缺陷
 * 旧线教训（retrieval-provider D1）：available ≠ 已启动、版本号猜测接口、坏响应进缓存。
 * D3 裁决：未知版本 fail-closed 回 T1，绝不静默当可用。
 *
 * ## 判据来源
 * 《开发计划-v3》§0.2 D3、§2.5 MemoryProvider 端口、T2 隔离 MCP 设计文档。
 *
 * ## 断言组
 * - 已实测清单是唯一门：0.9.10 已登记；清单外版本、无版本、缺工具、冒烟未过各自回 T1；
 * - 直连路线要求 memory_* 工具面；隔离路线要求 cg，且 isolated 必须显式为 true；
 * - 形状非法（null / tools 非数组）→ V3ContractViolation（编程错误，不是协商结果）；
 * - 清单冻结，运行期不可被探测代码自抬门槛。
 *
 * ## 不适用条件与已知边界
 * 只测协商纯函数；真实探测（MCP 调用、工具面发现、冒烟）属 adapters。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  negotiateMemoryProvider,
  REQUIRED_ISOLATED_T2_TOOLS,
  REQUIRED_T2_TOOLS,
  TESTED_DSH_MEMORY_VERSIONS,
} from '../src/v3/contracts/capabilities.mjs'

const FULL = {
  name: '@furongjun1999/dsh-memory',
  version: '0.9.10',
  tools: [...REQUIRED_T2_TOOLS],
  smokePassed: true,
}

const ISOLATED = {
  name: '@furongjun1999/dsh-memory',
  version: '0.9.10',
  tools: ['cg', 'stg'],
  smokePassed: true,
  isolated: true,
  root: 'C:/tmp/session/t2-mdcg',
}

test('已实测清单登记 0.9.10：直连齐全探测结果升 T2', () => {
  assert.deepEqual([...TESTED_DSH_MEMORY_VERSIONS], ['0.9.10'], '前置：0.9.10 已完成真实冒烟并登记')
  const result = negotiateMemoryProvider(FULL)
  assert.equal(result.tier, 'T2')
  assert.match(result.reason, /已实测版本/)
})

test('隔离路线：cg 工具面 + isolated=true + 冒烟通过 → T2 isolated', () => {
  assert.deepEqual([...REQUIRED_ISOLATED_T2_TOOLS], ['cg'], '隔离路线只要求 cg（kernel 工具面）')
  const result = negotiateMemoryProvider(ISOLATED)
  assert.equal(result.tier, 'T2')
  assert.equal(result.provider, 'dsh-memory-isolated')
  assert.match(result.reason, /隔离 MDCG_ROOT/)
})

test('隔离路线不放宽：isolated 缺失/为 false 时，cg 不能冒充直连 T2', () => {
  const spoofed = { ...ISOLATED, isolated: false }
  const result = negotiateMemoryProvider(spoofed)
  assert.equal(result.tier, 'T1')
  assert.match(result.reason, /缺必需工具/)

  const missing = { ...ISOLATED, tools: ['stg'] }
  const missingResult = negotiateMemoryProvider(missing)
  assert.equal(missingResult.tier, 'T1')
  assert.match(missingResult.reason, /缺必需工具：cg/)
})

test('各失败分支分别有独立 reason 回 T1（失败关闭）', () => {
  const cases = [
    [{ ...FULL, name: 'other-pkg' }, /非 dsh-memory/],
    [{ ...FULL, version: undefined }, /版本未知/],
    [{ ...FULL, version: '0.0.1' }, /版本未实测通过/],
    [{ ...FULL, tools: ['memory_store'] }, /缺必需工具/],
    [{ ...FULL, smokePassed: false }, /冒烟未通过/],
    [{ ...FULL, smokePassed: undefined }, /冒烟未通过/],
    [{ ...ISOLATED, version: '0.0.1' }, /版本未实测通过/],
    [{ ...ISOLATED, smokePassed: false }, /冒烟未通过/],
  ]
  for (const [probe, pattern] of cases) {
    const result = negotiateMemoryProvider(probe)
    assert.equal(result.tier, 'T1', JSON.stringify(probe))
    assert.match(result.reason, pattern)
  }
})

test('探测错误进 reason：冒烟失败时保留前 300 字诊断', () => {
  const result = negotiateMemoryProvider({ ...ISOLATED, smokePassed: false, error: 'Python 启动超时' })
  assert.equal(result.tier, 'T1')
  assert.match(result.reason, /Python 启动超时/)
})

test('形状非法抛 V3ContractViolation（编程错误）', () => {
  for (const bad of [null, 123, {}, { ...FULL, tools: 'memory_store' }]) {
    assert.throws(
      () => negotiateMemoryProvider(bad),
      (error) => error?.name === 'V3ContractViolation',
      '输入 ' + JSON.stringify(bad) + ' 必须抛 V3ContractViolation',
    )
  }
})

test('清单与工具面只读：冻结，运行期不可被探测代码自抬门槛', () => {
  assert.ok(Object.isFrozen(TESTED_DSH_MEMORY_VERSIONS), '已实测清单必须冻结')
  assert.ok(Object.isFrozen(REQUIRED_T2_TOOLS), '必需工具清单必须冻结')
  assert.ok(Object.isFrozen(REQUIRED_ISOLATED_T2_TOOLS), '隔离工具清单必须冻结')
})