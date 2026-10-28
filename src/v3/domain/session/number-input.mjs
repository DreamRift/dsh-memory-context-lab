/**
 * 数字参数的唯一解析器（0.14.0-beta.44）。
 *
 * 纪律（0.13.2-beta.5 起）：命令面与设置页只认十进制数字串，不静默换值。
 * 0.14.0-beta.43 的命令面用 Number()，于是 `0x10`→16、`1e1`→10 会被当成合法输入；
 * 这不是「宽容」，而是把用户没输入的数字写进 control.json。
 *
 * 只接受 /^\d+$/（前后空白已由调用方 trim/分词处理）；超过安全整数返回 null。
 */
export function parseStrictInteger(value) {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (!/^\d+$/.test(text)) return null
  const number = Number(text)
  return Number.isSafeInteger(number) ? number : null
}
