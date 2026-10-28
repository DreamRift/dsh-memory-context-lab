/**
 * 真实用户输入提取（domain/session 纯函数）。
 *
 * 为什么需要它：回注的查询词必须来自**人类这一回合说的话**，不能来自其它生产者
 * 塞进同一个批次里的内容。宿主 `agent/pre-step` 的 payload 里 `messages` 是
 * 「已领用、尚未入队的用户消息批次」，但同一批次里可能同时有：
 * - `source.kind = 'user'`：人类输入；
 * - `source.kind = 'runtime-context'`：宿主运行时上下文快照（role 也是 'user'）；
 * - 其它插件追加的 user 消息（如 model-selection 的模型切换通知）。
 *
 * 旧实现从 `decision.messages` 末尾往前找第一条 role==='user'，而宿主默认 inner 会把
 * `runtime-context` 追加在末尾——查询词于是变成整块运行时上下文，回注检索的是「系统提示
 * 里出现过哪些词」，而不是用户刚说的话。判据改成 host 自己的约定 `source.kind === 'user'`，
 * 而不是「排除已知污染源的启发式」：明天多一个插件，这条判据不需要跟着改。
 *
 * 纯函数、无 IO：调用方给消息数组，这里只回答「人类说了什么」。
 */
import { HUMAN_SOURCE_KIND } from '../../contracts/sources.mjs'
import { V3ContractViolation } from '../../contracts/errors.mjs'

/** 从 content（块数组或字符串）取可见文本；非文本块（图片/思考）不进查询词。 */
export function textOfContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join(' ')
    .trim()
}

/**
 * 取本批次里最后一条人类输入的文本（多行合并为单个空格）。
 *
 * @param {ReadonlyArray<object>} messages 宿主 payload.messages（或 decision.messages）
 * @returns {string} 没有人类输入时返回空串（调用方据此跳过本步，不猜）
 * @throws {V3ContractViolation} messages 不是数组（编程错误，不是「没有输入」）
 */
export function userInputTextOf(messages) {
  if (!Array.isArray(messages)) {
    throw new V3ContractViolation('v3 user-input: messages 必须是数组（缺字段与空数组是两种事实）')
  }
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message?.role !== 'user') continue
    if (message?.source?.kind !== HUMAN_SOURCE_KIND) continue
    const text = textOfContent(message.content)
    if (text.length > 0) return text
  }
  return ''
}
