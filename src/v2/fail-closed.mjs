/**
 * 失败关闭原语（0.13.2-beta.7 B 组）——「读不到 / 判不了 / 失败了」的**唯一判据**。
 *
 * ## 为什么需要这一层
 * beta.6 把「损坏不是从未启用」写进了 G4，但那只覆盖了**状态文件**一处。
 * 同一句话在仓里另有八处反着写，而且形态各异：
 *
 * | 落点 | 形态 | 实际语义 |
 * |---|---|---|
 * | disposition.mjs refreshForgetIndex | catch 后 absent:true | EACCES/EMFILE/ELOOP 被当成「没有账本」→ 遗忘索引归零 → **已遗忘记录重新可见** |
 * | runtime-settings.mjs set fullhistory off | catch 后只 warn，随后照常 runRestore | 「判不了窗口」被当成「没超窗」 |
 * | hierarchy-coordinator.mjs auditRun | .catch(() => {}) | 审计失败＝审计通过 |
 * | working-state.mjs limits | Math.max(undefined,0) → NaN → slice(0,NaN)=[] | 参数缺失＝硬保护清零 |
 * | runtime-forget.mjs withdrawForgottenSurfaces | 失败仍写 status='forgotten' | 撤回失败＝撤回成功 |
 * | runtime-lifecycle.mjs disableRecord | 先恢复、后写盘 | 写盘失败＝已停用（其实还开着） |
 *
 * 它们的共同点不是「某一行写错了」，而是**「失败关闭」只是口头约定**：
 * 没有一个可复用的原语，于是每个新调用点都按自己那一刻的直觉写一遍。
 * 新增第九个「读取外部状态」的调用点时，照样会重犯。
 *
 * ## 本模块提供什么
 * 1. classifyReadFailure(error)：把「读一个可能不存在的文件」的异常分成
 *    **absent（真的没有）/ unreadable（读不到）/ damaged（读到了但坏了）** 三态。
 *    只有 absent 允许被当成「空」，其余必须失败关闭。
 * 2. refusalFromError(error)：构造**统一的拒绝形状**（refused + reason + code + undetermined），
 *    让三条恢复路径说同一句话。
 * 3. assertReadable(result)：读原语收口——非 ok 一律抛带 code 的错误。
 * 4. unreadableNote(what, error)：给**不能抛**的渲染路径用，把「没读成」如实写进文本，
 *    而不是渲染成「（无）」。
 *
 * ## 不适用条件
 * 本模块不判断「该不该失败」（那是业务语义），只判断「这个异常算不算读不到」。
 * 也**不**把异常吞成成功：所有出口一律返回拒绝或抛错。
 */
import { EngineV2Error } from '../errors.mjs'

/** 读失败的三态。absent 是唯一允许被当作「空」的一态。 */
export const READ_FAILURE = Object.freeze({
  ABSENT: 'absent',
  UNREADABLE: 'unreadable',
  DAMAGED: 'damaged',
})

/**
 * 「文件真的不存在」的 errno 集合。
 *
 * 只有 ENOENT / ENOTDIR 算 absent。
 * **EACCES / EPERM / EMFILE / ENFILE / ELOOP / EIO / EBUSY 一律不是 absent**：
 * 它们是「现在读不到」，不代表「从来没有」。把它们当成 absent 是本组最贵的
 * 那个缺陷（Y-01 的隐私回退）的成因。
 */
const ABSENT_CODES = new Set(['ENOENT', 'ENOTDIR'])

/** 读到了内容但内容坏了——由调用方用 DamagedError 表达。 */
const DAMAGED_CODES = new Set(['EDAMAGED', 'EENGINEDAMAGED', 'ESTATEDAMAGED'])

/** 把一次读失败分类。未知异常一律 unreadable（失败关闭），绝不默认 absent。 */
export function classifyReadFailure(error) {
  const code = typeof error?.code === 'string' ? error.code : null
  if (code && ABSENT_CODES.has(code)) return { state: READ_FAILURE.ABSENT, code, error }
  if (code && DAMAGED_CODES.has(code)) return { state: READ_FAILURE.DAMAGED, code, error }
  return { state: READ_FAILURE.UNREADABLE, code, error }
}

/** 这次读失败能不能被当成「没有」。**唯一**的判据入口。 */
export function isAbsent(error) {
  return classifyReadFailure(error).state === READ_FAILURE.ABSENT
}

/** 这次读失败是不是「读到了但坏了」。 */
export function isDamaged(error) {
  return classifyReadFailure(error).state === READ_FAILURE.DAMAGED
}

/** 统一的拒绝形状：三条恢复路径（off / restore / set fullhistory off）共用。 */
export function refusalFromError(error, { what = '判定', code = 'EGUARDUNDETERMINED' } = {}) {
  const classified = classifyReadFailure(error)
  const reason = error instanceof Error ? (error.message || error.name) : String(error ?? '未知原因')
  const carried = classified.code && classified.code !== 'ENOENT' ? classified.code : code
  return {
    refused: true,
    undetermined: true,
    what,
    code: carried,
    reason: what + '失败（' + reason + '）：无法判定，按失败关闭处理',
    readFailure: classified.state,
  }
}

/** 是否是一个「拒绝」结果。 */
export function isRefusal(value) {
  return Boolean(value) && typeof value === 'object' && value.refused === true
}

/**
 * 读原语收口：非 ok 的结果一律抛带 code 的错误。
 *
 * 为什么不是返回空表：返回空表等于把「读不到」洗成「没有」，正是本组要根除的形态。
 */
export function assertReadable(result, { what = '读取', code = 'EREADFAILED' } = {}) {
  if (result && result.ok === true) return result
  const detail = result?.error ?? result?.reason ?? '未知原因'
  throw new EngineV2Error(what + '失败：' + detail, {
    code: result?.code ?? code,
    details: { what },
  })
}

/**
 * 给那些**不能抛**的路径（状态渲染、卡片渲染）用：它们必须继续产出文本，
 * 但要把「这一项没读成」如实带进文本，而不是渲染成「（无）」。
 */
export function unreadableNote(what, error) {
  const reason = error instanceof Error ? (error.message || error.name) : String(error ?? '未知原因')
  return what + '：不可读（' + reason + '）——不是「没有」，按失败关闭不展示结论'
}
