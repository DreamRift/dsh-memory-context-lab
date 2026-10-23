/**
 * 命令面（command surface）：宿主契约的**唯一强制点**（0.13.2-beta.7 C 组）。
 *
 * ## 为什么需要这一层
 * `command-result.mjs` 的 `withHostContract` 只处理**返回值**：
 *
 *     domain[name] = async (...args) => toHostResult(await value(...args))
 *
 * `await` 抛出的异常不会经过 `toHostResult`。而本仓把「损坏不是从未启用」
 * （beta.6 G4）实现成**抛 ESTATEDAMAGED**：`adopt()` 里显式 rethrow。于是：
 *
 *     adopt() 抛 ESTATEDAMAGED
 *       → commandHandler 的 30 分支 switch（全函数没有一处 catch）
 *       → index.mjs 的 commandHandler（只有 finally，没有 catch）
 *       → 宿主
 *
 * 用户看到的是宿主级崩溃，插件写好的解释（「不会把它当作从未启用，也不会覆盖它」）
 * 一个字都到不了；而且宿主对 error 分支要求非空 text，崩溃形态与「命令被拒」在
 * 界面上无法区分。
 *
 * ## 为什么不是「给每个 case 加 try/catch」
 * 那是调用点修补：新增第 31 个 case、第 11 个命令域时，必须**记得**加。判据是
 * 「下一个新增命令不必记得也能满足契约」，所以强制点必须在**出口**——命令面
 * 只有两处出口（`v2.commandHandler` 与 `index.mjs` 的 `commandHandler`），
 * 两处都经过 `withCommandSurface`。
 *
 * ## 与 `withHostContract` 的分工
 * - `withCommandSurface(domain)`：给**一个对象上的每个函数**加「抛出 → 错误结果」；
 * - `commandSurface(fn)`：给**单个函数**加同样的转换（runtime 的 commandHandler
 *   是一个裸函数，不是域对象）。
 * 两者都仍走 `toHostResult`，所以「内部形状 → 宿主形状」只有一份实现。
 *
 * ## 不适用条件
 * 这一层**只**做形状转换，不做失败关闭决策：它不判断该不该失败，只保证失败
 * 以宿主能读懂的形态出现。把异常吞成成功是禁止的（见项目规则「明确禁止」）。
 */
import { EngineV2Error } from '../errors.mjs'
import { toHostResult } from './command-result.mjs'

/** 意外抛出（非 EngineV2Error）的 code：可分支、可审计，且与业务 code 不混。 */
export const UNEXPECTED_ERROR_CODE = 'EV2UNEXPECTED'

/** 从任意抛出物里取出可用的 code 与文本。 */
function describeThrown(error) {
  if (error instanceof EngineV2Error) {
    return {
      code: typeof error.code === 'string' && error.code ? error.code : 'EV2',
      message: typeof error.message === 'string' && error.message.trim() ? error.message : String(error),
      details: error.details ?? null,
    }
  }
  const message = error instanceof Error
    ? (error.message || error.name || '未知错误')
    : String(error ?? '未知错误')
  return { code: UNEXPECTED_ERROR_CODE, message, details: null }
}

/**
 * 把一次「可能抛出」的命令执行转成宿主结果。
 *
 * 成功返回值原样交给 `toHostResult`（幂等）；抛出转成
 * `{kind:'error', code, message, text, details}`。
 */
export async function toHostOutcome(run) {
  try {
    return toHostResult(await run())
  } catch (error) {
    const described = describeThrown(error)
    return toHostResult({
      kind: 'error',
      code: described.code,
      message: described.message,
      details: described.details,
    })
  }
}

/** 给单个命令函数套上命令面（runtime 的 commandHandler 用这个）。 */
export function commandSurface(fn) {
  return async (...args) => toHostOutcome(() => fn(...args))
}

/**
 * 给一个域对象的**每个函数**套上命令面（与 `withHostContract` 同一手法：
 * 就地替换函数引用、返回同一个对象，解构导出的调用方无需改动）。
 */
export function withCommandSurface(domain) {
  for (const [name, value] of Object.entries(domain)) {
    if (typeof value !== 'function') continue
    domain[name] = commandSurface(value)
  }
  return domain
}
