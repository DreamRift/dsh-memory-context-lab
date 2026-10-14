/**
 * v2 引擎统一错误类型。
 *
 * 独立成模块，records.mjs（纯函数层）与 store.mjs（存储层）都可导入而不成环。
 * 所有对外抛出的 v2 错误都应是 EngineV2Error，code 稳定可判别。
 */
export class EngineV2Error extends Error {
  constructor(message, { code = 'EV2' } = {}) {
    super(message)
    this.name = 'EngineV2Error'
    this.code = code
  }
}
