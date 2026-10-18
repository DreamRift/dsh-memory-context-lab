/**
 * v2 引擎统一错误类型。
 *
 * 独立成模块，records.mjs（纯函数层）与 store.mjs（存储层）都可导入而不成环。
 * 所有对外抛出的 v2 错误都应是 EngineV2Error，code 稳定可判别。
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
