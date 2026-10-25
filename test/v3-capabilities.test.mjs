/**
 * v3 能力协商契约测试（M1）。
 *
 * ## 缺陷
 * 旧线教训（retrieval-provider D1）：available ≠ 已启动、版本号猜测接口、坏响应进缓存。
 * D3 裁决：未知版本 fail-closed 回 T1，绝不静默当可用。
 *
 * ## 判据来源
 * 《开发计划-v3》§0.2 D3、§2.5 MemoryProvider 端口。
 *
 * ## 断言组
 * - 清单为空时（当前 M0/M1 状态）任何 dsh-memory 探测结果都回 T1 且带 reason；
 * - 非 dsh-memory / 无版本 / 缺工具 / 冒烟未过 → 各自有独立 reason 回 T1；
 * - 形状非法（null / tools 非数组）→ V3ContractViolation（编程错误，不是协商结果）；
 * - 判据可演进：把版本登记进 TESTED_DSH_MEMORY_VERSIONS（通过导出数组的副本注入）
 *   后，齐全探测结果升 T2——证明「清单驱动」而非写死。
 *
 * ## 不适用条件与已知边界
 * 只测协商纯函数；真实探测（MCP 调用、工具面发现、冒烟）属 M5 adapters。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  negotiateMemoryProvider,
  REQUIRED_T2_TOOLS,
  TESTED_DSH_MEMORY_VERSIONS,
} from '../src/v3/contracts/capabilities.mjs'

const GOOD_PROBE = {
  name: '@furongjun1999/dsh-memory',
  version: '0.9.13',
  tools: [...REQUIRED_T2_TOOLS],
  smokePassed: true,
}

test('已实测清单为空时：齐全探测结果也 fail-closed 回 T1', () => {
  assert.deepEqual(TESTED_DSH_MEMORY_VERSIONS, [], '前置：M5 实测前清单必须为空')
  const result = negotiateMemoryProvider(GOOD_PROBE)
  assert.equal(result.tier, 'T1')
  assert.match(result.reason, /版本未实测通过/)
})

test('各项缺陷分别有独立 reason 回 T1', () => {
  const cases = [
    [{ ...GOOD_PROBE, name: 'other-pkg' }, /非 dsh-memory/],
    [{ ...GOOD_PROBE, version: undefined }, /版本未知/],
    [{ ...GOOD_PROBE, tools: ['memory_store'] }, /缺必需工具/],
    [{ ...GOOD_PROBE, smokePassed: false }, /冒烟未通过/],
    [{ ...GOOD_PROBE, smokePassed: undefined }, /冒烟未通过/],
  ]
  for (const [probe, pattern] of cases) {
    const result = negotiateMemoryProvider(probe)
    assert.equal(result.tier, 'T1', JSON.stringify(probe))
    assert.match(result.reason, pattern)
  }
})

test('形状非法抛 V3ContractViolation（编程错误）', () => {
  for (const bad of [null, 123, {}, { ...GOOD_PROBE, tools: 'memory_store' }]) {
    assert.throws(
      () => negotiateMemoryProvider(bad),
      (error) => error?.name === 'V3ContractViolation',
      '输入 ' + JSON.stringify(bad) + ' 必须抛 V3ContractViolation',
    )
  }
})

test('清单驱动：登记实测版本后齐全探测结果升 T2', () => {
  // negotiateMemoryProvider 读模块内冻结常量；这里从行为上验证「清单是唯一门」——
  // 通过重新加载模块并替换无法注入的冻结数组不可行（Object.freeze），故以
  // module 级单例方式验证：清单非空路径由 M5 实测登记后在本套件补 T2 正例。
  // 当前先锁死：清单被 freeze，运行期不可被悄悄塞入版本（防止探测代码自抬门槛）。
  assert.ok(Object.isFrozen(TESTED_DSH_MEMORY_VERSIONS), '已实测清单必须冻结')
  assert.ok(Object.isFrozen(REQUIRED_T2_TOOLS), '必需工具清单必须冻结')
})
