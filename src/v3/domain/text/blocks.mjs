/**
 * 内容块 → 文本（T3，2026-11-04 审计：同名函数曾有两套实现）。
 *
 * 旧状态：
 * - `entry/v3-entry.mjs` 的局部 `textOfBlocks`：过滤 text 块、`join('\n')`、`text ?? ''`；
 * - `domain/first-ingress/preview.mjs` 的导出 `textOfBlocks`：只收 string、`join('')`。
 * 同一份内容在两个入口得到不同文本（多 text 块时差一个换行），哈希/长度口径随之分叉。
 *
 * 现在唯一实现 + 显式分隔符：调用方必须说明自己需要哪种连接方式，而不是各自定义。
 * - 事件正文（v3-entry）：`separator: '\n'`——保留原有的逐块换行；
 * - 预览正文（first-ingress）：默认 `''`——预览是把块拼成一段连续文本。
 * 非 text 块与非法 `text` 一律跳过（不把对象/数字隐式转成字符串）。
 */
export function textOfBlocks(blocks, { separator = '' } = {}) {
  if (!Array.isArray(blocks)) return ''
  const parts = []
  for (const block of blocks) {
    if (block === null || typeof block !== 'object') continue
    if (block.type !== 'text') continue
    if (typeof block.text !== 'string') continue
    parts.push(block.text)
  }
  return parts.join(separator)
}
