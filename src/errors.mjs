/**
 * 全仓统一错误类型（0.13.2-beta.6 G2）。
 *
 * 为什么把它从 `v2/errors.mjs` 提到根目录：
 *
 * `EngineV2Error` 从引入起就只覆盖 v2 存储层。仓里另有约 25 处裸
 * `throw new Error / TypeError`（`core.mjs`、`index.mjs`、
 * `dsh-memory-suppression.mjs`、`lingshu-lab-client.mjs`、`v2/client-adapter.mjs`、
 * `v2/working-state.mjs`、`v2/cost.mjs`、`v2/tool.mjs` …），它们的 `code` 恒
 * `undefined`。而本仓**唯一**的错误判别口径就是 `error.code`（调用方按
 * `ELIMIT`/`EINVAL`/`EREVISION` 分支），于是这些错误的调用方分支全部落空，
 * 只能读 message 猜；命令面则直接把它们当成宿主级崩溃上报。
 *
 * 收口之后有一条静态守卫（`test/v2-beta6-g2-error-contract.test.mjs`）禁止再写裸
 * `throw new Error(` / `throw new TypeError(`——否则下一个新增的抛出点还会重演。
 *
 * `v2/errors.mjs` 保留为再导出，既有的 `from './errors.mjs'` 导入零改动，
 * 且拿到的仍是**同一个类对象**（instanceof 跨模块成立）。
 */

export class EngineV2Error extends Error {
  constructor(message, { code = 'EV2', details = null } = {}) {
    super(message)
    this.name = 'EngineV2Error'
    this.code = code
    // 结构化细节（0.11.0）：调用方按 code 分支，按 details 定位具体原因；
    // 之前传进来的 details 被静默丢弃，错误只剩一句人话，测试与工具都无从判别。
    this.details = details
  }
}

/**
 * 参数非法（用户输入、配置值、调用约定不满足）。
 *
 * 这是最常见的一类：它能被用户修好，所以必须与「内部坏了」区分开。
 */
export class InvalidArgumentError extends EngineV2Error {
  constructor(message, { code = 'EINVAL', details = null } = {}) {
    super(message, { code, details })
    this.name = 'InvalidArgumentError'
  }
}

/** 账本/状态文件损坏（失败关闭口径；**不是**「从未存在」）。 */
export class DamagedError extends EngineV2Error {
  constructor(message, { code = 'EDAMAGED', details = null } = {}) {
    super(message, { code, details })
    this.name = 'DamagedError'
  }
}
