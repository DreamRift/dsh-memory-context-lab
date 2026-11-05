/**
 * FNV-1a 64 位（16 位小写十六进制）——**变更/关联指纹**，不是密码学摘要，也不能当内容哈希
 * 用于安全判定。
 *
 * ## 为什么单列在 shared
 * - `contracts` 层禁止 import `node:*`（`v3-architecture-guard`），因此摘要必须自实现；
 * - 观测合同（`contracts/cache-observation.mjs`）与生命周期关联合同
 *   （`contracts/observation-lifecycle.mjs`）需要**同一份**口径：本地诊断 ID 与内容摘要
 *   若各写一遍，reviewer 无法判断两个 16 位串是否可比。这里只留实现，不留语义——
 *   "这个指纹代表什么"由各合同在自己的文档里写死。
 *
 * ## 边界
 * - 只做变更检测/关联定位：碰撞可被构造，**不得**用于凭据、去重授权或安全边界；
 * - 输入是字符串（调用方负责先做键排序规范化 JSON），本函数不做序列化判定。
 */

const MASK_64 = 0xffffffffffffffffn
const FNV_PRIME = 0x100000001b3n
const FNV_OFFSET = 0xcbf29ce484222325n

/**
 * @param {string} text 已是确定性的字符串（同一语义 ⇒ 同一字符串由调用方保证）
 * @returns {string} 16 位小写十六进制
 */
export function fnv1a64Of(text) {
  const bytes = new TextEncoder().encode(String(text))
  let hash = FNV_OFFSET
  for (const byte of bytes) {
    hash = (hash ^ BigInt(byte)) & MASK_64
    hash = (hash * FNV_PRIME) & MASK_64
  }
  return hash.toString(16).padStart(16, '0')
}
