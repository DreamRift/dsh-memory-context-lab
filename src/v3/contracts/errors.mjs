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
  'ERECORD_NOT_FOUND',
  'ESTORE_DAMAGED',
  'ESTORE_TXN_CONFLICT',
  // H6（2026-11-04 审计）：凭证 ID 唯一性由存储层在跨进程锁内强制——并发对账不能
  // append 两条同 ID 凭证（restore 按下标定位会错位）。冲突码与事务冲突区分开。
  'ESTORE_DUPLICATE_VOUCHER',
  'ESTORE_CLOSED',
  'ELOCKED',
  // R3-03（2026-10-30）：事务期间失锁（被接管/心跳失败）——失锁后的后续提交失败关闭。
  'ELOCK_LOST',
  'EFORGOTTEN',
  'ECONTROL_RANGE',
  // AUD51-03-01（beta.53）：记录 ID 形状白名单（路径穿越的第一道闸）。
  'EINVALID_ID',
  // P7 P2-1（2026-11-01）：受限改写已 append 但活动面复核失败——写入事实存疑，
  // 必须与「被拒绝、原文仍在」分开上报，不得让调用方以为面没变。
  'EWRITE_UNCONFIRMED',
])

const CODE_KIND = new Map([
  ['ESESSION_INVALID_ID', 'invalid'],
  ['EINTERNAL', 'internal'],
  ['ESTORE_SESSION_MISMATCH', 'conflict'],
  ['ESTORE_CORRUPT', 'corrupt'],
  // B3-17（AUD50-06-06）：ID 不存在不是库损坏——用户输错 ID 不再被报「损坏」
  ['ERECORD_NOT_FOUND', 'invalid'],
  ['ESTORE_DAMAGED', 'corrupt'],
  ['ESTORE_TXN_CONFLICT', 'conflict'],
  ['ESTORE_DUPLICATE_VOUCHER', 'conflict'],
  ['ESTORE_CLOSED', 'unavailable'],
  ['ELOCKED', 'conflict'],
  ['ELOCK_LOST', 'conflict'],
  ['EFORGOTTEN', 'unavailable'],
  ['ECONTROL_RANGE', 'invalid'],
  ['EINVALID_ID', 'invalid'],
  ['EWRITE_UNCONFIRMED', 'internal'],
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
