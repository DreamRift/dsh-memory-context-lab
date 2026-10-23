/**
 * 命令结果的宿主契约（0.13.2-beta.6 G5）。
 *
 * 宿主 `@deepseek-ai/dsh-commands` 的 `normalizeResult` 对 error 分支断言：
 *
 *     if (result.kind === 'error') {
 *       if (typeof result.text !== 'string' || result.text.trim().length === 0) {
 *         throw new TypeError(`command "…" error text must be a non-empty string`)
 *       }
 *     }
 *
 * 插件内部一直用 `{ kind:'error', code, message }`——**没有 text**。于是所有
 * 用法文案、`ENOTENABLED`、`EFORGETPLAN` 之类的解释**从未到达用户**，
 * 用户看到的是一条宿主级 TypeError（gate/p-08 W1/W2/W3）。
 *
 * 为什么不是逐处补 `text`：内部有 29 处 `{kind:'error', …}`，每新增一处都要
 * 记得写 text，忘了就复活同一个缺陷。这里把「内部形状 → 宿主形状」做成
 * **一道包装**，由每个命令域的工厂在返回时统一套上；域内部继续用
 * `code`/`message`（调用方与既有测试依赖这两个字段）。
 */

/** 把一条内部错误结果补成宿主可接受的形态（幂等）。 */
export function toHostResult(result) {
  if (!result || typeof result !== 'object' || result.kind !== 'error') return result
  if (typeof result.text === 'string' && result.text.trim() !== '') return result
  const fallback = typeof result.message === 'string' && result.message.trim() !== ''
    ? result.message
    : `命令执行失败（${result.code ?? '未知错误'}）`
  return { ...result, text: fallback }
}

/**
 * 把命令域导出的**每个异步命令函数**套上 `toHostResult`。
 *
 * 只包装函数值，不改对象形状；返回同一个对象（就地替换函数引用），
 * 因此解构导出的调用方无需改动。
 */
export function withHostContract(domain) {
  for (const [name, value] of Object.entries(domain)) {
    if (typeof value !== 'function') continue
    domain[name] = async (...args) => toHostResult(await value(...args))
  }
  return domain
}
