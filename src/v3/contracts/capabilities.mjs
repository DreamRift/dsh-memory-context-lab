/**
 * v3 能力协商契约（单一真源）：T2（dsh-memory）是否启用的裁决（计划 D3）。
 *
 * 裁决口径：契约以工具、参数、响应和冒烟结果为准，版本号只用于记录与诊断；
 * 任何未知、缺工具、冒烟未过 → **失败关闭回落 T1**，绝不把「探测不出」当成「可用」。
 *
 * TESTED_DSH_MEMORY_VERSIONS 是「已实测通过」清单，M5 对 0.9.12/0.9.13 实测后登记；
 * 清单为空时一切探测结果都回落 T1（fail-closed），这是设计而非缺陷。
 */
import { V3ContractViolation } from './errors.mjs'

/** 已实测（工具面 + 冒烟）通过的 dsh-memory 版本；M5 实测后登记，禁止预先登记。 */
export const TESTED_DSH_MEMORY_VERSIONS = Object.freeze([])

/** T2 必须提供的工具面（能力探测的核心判据；M5 按实测修订）。 */
export const REQUIRED_T2_TOOLS = Object.freeze(['memory_store', 'memory_search', 'memory_read'])

/**
 * 协商记忆提供方层级。
 *
 * @param {object} described 探测结果：{ name, version, tools: string[], smokePassed: boolean }
 * @returns {{ tier: 'T1'|'T2', provider: string, reason: string }}
 *   T1 恒可用；T2 只有全部判据通过才启用，否则带 reason 回落 T1。
 * @throws {V3ContractViolation} 探测结果本身形状非法（编程错误，不是协商结果）。
 */
export function negotiateMemoryProvider(described) {
  if (described === null || typeof described !== 'object') {
    throw new V3ContractViolation('v3 capabilities: 探测结果必须是对象')
  }
  const { name, version, tools, smokePassed } = described
  if (typeof name !== 'string' || name.length === 0) {
    throw new V3ContractViolation('v3 capabilities: name 必须是非空字符串')
  }
  if (!Array.isArray(tools) || tools.some((t) => typeof t !== 'string')) {
    throw new V3ContractViolation('v3 capabilities: tools 必须是字符串数组')
  }

  const t1 = (reason) => ({ tier: 'T1', provider: 'local', reason })
  if (name !== '@furongjun1999/dsh-memory') {
    return t1('非 dsh-memory 提供方：' + name)
  }
  const missing = REQUIRED_T2_TOOLS.filter((tool) => !tools.includes(tool))
  if (missing.length > 0) {
    return t1('缺必需工具：' + missing.join(', '))
  }
  if (smokePassed !== true) {
    return t1('冒烟未通过或未执行')
  }
  if (typeof version !== 'string' || version.length === 0) {
    return t1('版本未知（fail-closed 回 T1）')
  }
  if (!TESTED_DSH_MEMORY_VERSIONS.includes(version)) {
    return t1('版本未实测通过：' + version + '（已实测清单：' + (TESTED_DSH_MEMORY_VERSIONS.join('/') || '空') + '）')
  }
  return { tier: 'T2', provider: name, reason: '已实测版本 + 工具面齐全 + 冒烟通过' }
}
