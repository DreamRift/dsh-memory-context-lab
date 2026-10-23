/**
 * v2 错误类型（再导出）。
 *
 * 定义已上提到 `src/errors.mjs`（0.13.2-beta.6 G2：统一错误基类要覆盖全仓，
 * 不能只覆盖 v2 存储层）。这里保留文件与导出名，是因为 v2 各模块都写
 * `from './errors.mjs'`；再导出的是**同一个类对象**，instanceof 与 code 都不变。
 */
export { EngineV2Error, InvalidArgumentError, DamagedError } from '../errors.mjs'
