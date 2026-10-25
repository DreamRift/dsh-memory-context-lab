/**
 * v3 端口定义（单一真源）：各端口的方法面。实现方（adapters）与消费方
 * （application）都以此处清单为准；测试替身按同一清单伪造（计划 §2.5）。
 *
 * 本模块只描述形状，不含实现；禁止依赖 domain 与 node:fs（架构守卫判红）。
 */

/**
 * 各端口必须提供的方法名。composition root 在装配时逐端口校验；
 * 缺方法即装配失败（fail-closed），不允许「先跑起来再说」。
 */
import { v3Error } from '../contracts/errors.mjs'

export const PORT_METHODS = Object.freeze({
  HostSurface: Object.freeze(['events', 'surfaceOp', 'sessionInfo', 'tools', 'commands', 'settings']),
  SessionStore: Object.freeze([
    'transaction', 'readRecord', 'restore', 'forget', 'health', 'rebuildIndex', 'listVouchers',
  ]),
  MemoryProvider: Object.freeze(['search', 'read', 'health', 'capabilities']),
  Clock: Object.freeze(['now']),
  Random: Object.freeze(['uuid']),
  Metrics: Object.freeze(['counter', 'observe']),
})

/**
 * 装配期端口校验：缺任一必需方法即抛错并列出缺口。
 * 错误信封走 contracts（ports 允许依赖 contracts）。
 */
export function assertPort(name, implementation) {
  const required = PORT_METHODS[name]
  if (required === undefined) {
    throw v3Error('EINTERNAL', `v3 ports: 未知端口 ${name}（先在 PORT_METHODS 登记）`)
  }
  if (implementation === null || typeof implementation !== 'object') {
    throw v3Error('EINTERNAL', `v3 ports: 端口 ${name} 的实现必须是对象`)
  }
  const missing = required.filter((method) => typeof implementation[method] !== 'function')
  if (missing.length > 0) {
    throw v3Error('EINTERNAL', `v3 ports: 端口 ${name} 缺少方法: ${missing.join(', ')}`)
  }
  return implementation
}
