/**
 * shared 层首个通用原语：深冻结。decision 等领域产物一经生成即不可变（计划 §2.4
 * 「application 调用 domain 生成不可变 decision」），由本函数统一实施。
 * shared 层约束：无业务语义、零外部依赖（架构守卫判红）。
 */
export function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value
  for (const key of Object.keys(value)) deepFreeze(value[key])
  return Object.freeze(value)
}
