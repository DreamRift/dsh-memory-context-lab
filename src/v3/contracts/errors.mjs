/**
 * v3 错误契约（单一真源）：对外错误一律是 kind/code/message/text 四字段信封，
 * 内部异常只在边界转换一次（计划 §2.5 Output 端口）。
 *
 * 本模块必须保持零运行时依赖（架构守卫把 contracts 层的任何 import 外部模块判红）。
 */

/** 错误大类。语义冻结：新增 kind 属于破坏性变更，须走 ADR。 */
export const ERROR_KINDS = Object.freeze(['invalid', 'unavailable', 'conflict', 'corrupt', 'unknown', 'internal'])

/**
 * 错误码枚举。M0 先立骨架；M1 起按用例逐个补齐，禁止先囤积「可能用到」的码
 * （真源纪律：新增导出必须有消费者）。
 */
export const ERROR_CODES = Object.freeze([
  'ESESSION_INVALID_ID',
  'EINTERNAL',
  'ESTORE_SESSION_MISMATCH',
  'ESTORE_CORRUPT',
  'ESTORE_DAMAGED',
  'ESTORE_TXN_CONFLICT',
  'ESTORE_CLOSED',
  'ELOCKED',
  'EFORGOTTEN',
])

const CODE_KIND = new Map([
  ['ESESSION_INVALID_ID', 'invalid'],
  ['EINTERNAL', 'internal'],
  ['ESTORE_SESSION_MISMATCH', 'conflict'],
  ['ESTORE_CORRUPT', 'corrupt'],
  ['ESTORE_DAMAGED', 'corrupt'],
  ['ESTORE_TXN_CONFLICT', 'conflict'],
  ['ESTORE_CLOSED', 'unavailable'],
  ['ELOCKED', 'conflict'],
  ['EFORGOTTEN', 'unavailable'],
])

/**
 * 构造 v3 错误信封。未知 code 直接抛出编程错误（fail fast），而不是静默造出
 * 契约外的形状——「判定不出时失败关闭」在错误构造层的第一道落点。
 */
/**
 * 编程错误（契约误用）专用出口：与业务错误信封（V3Error）分开——调用方不该
 * 捕获它，出现即 bug。统一命名基类满足 G2「不抛裸 Error」契约。
 */
export class V3ContractViolation extends Error {
  constructor(message) {
    super(message)
    this.name = 'V3ContractViolation'
    this.code = 'EV3CONTRACT'
  }
}

export function v3Error(code, message, options = {}) {
  const kind = CODE_KIND.get(code)
  if (kind === undefined) {
    throw new V3ContractViolation(`v3 contracts: 未注册的错误码 ${code}（先在 ERROR_CODES/CODE_KIND 登记）`)
  }
  if (typeof message !== 'string' || message.length === 0) {
    throw new V3ContractViolation('v3 contracts: message 必须是非空字符串')
  }
  const error = new Error(message)
  error.name = 'V3Error'
  error.kind = kind
  error.code = code
  error.text = options.text === undefined ? null : options.text
  if (options.cause !== undefined) error.cause = options.cause
  return error
}

/** 判定任意值是否为本契约产出的错误信封（供边界转换与测试使用）。 */
export function isV3Error(value) {
  return (
    value instanceof Error &&
    value.name === 'V3Error' &&
    ERROR_KINDS.includes(value.kind) &&
    typeof value.code === 'string' && CODE_KIND.has(value.code) &&
    typeof value.message === 'string' && value.message.length > 0
  )
}
