/**
 * 查询规划（P1-1）：把一段自然查询拆成两个通道。
 *
 * - exact（精确通道）：记录 ID（t00000037-r0000）、调用 ID（call_…）、路径、
 *   文件名、短十六进制指纹这类「用户照抄的机器标识」与引号短语。这些词元
 *   整串命中才有意义，走 AND 关卡、不参与 OR 阈值。
 * - text（自由通道）：其余自然语言。按 T1 词法分词进入 OR 召回 +
 *   相关门槛；灵枢（T2）侧并入查询串整串检索。
 *
 * 纯函数、无 IO；字符串字段异常输入按空串处理，不抛错（查询规划失败
 * 不该让回注管线整体失败）。
 */

// 成对引号（含 CJK 引号）中的短语进 exact；引号本身从自由文本中移除。
const QUOTED_PHRASE = /[“]([^“”]{1,120})[”]|["]([^"\n]{1,120})["]|[「]([^「」]{1,120})[」]/g
// 词边界：空白与常见中西文标点。标识符词不会跨越这些字符。
const SPLIT = /[\s,;，。；：、·!?！？（）()\[\]【】{}"'“”「」『』<>《》]+/
// 机器标识形状：ASCII 词元且含分隔符（t00000037-r0000、call_x、index.mjs、
// package.json）；或含路径分隔符（src/v2/retrieval.mjs、C:\Users\…、记忆上下文/plugin）；
// 或 ≥12 位的十六进制指纹（git 短哈希 mcl2-2639f5b74a2506dd… 截段）。
const IDENT_ASCII = /^[A-Za-z0-9_][A-Za-z0-9_\-.]*$/
const HEX_RUN = /^[0-9a-fA-F]{12,}$/

function isMachineIdentifier(token) {
  if (typeof token !== 'string' || token.length < 4 || token.length > 200) return false
  if (token.includes('/') || token.includes('\\')) return true
  if (HEX_RUN.test(token)) return true
  if (!IDENT_ASCII.test(token)) return false
  // 纯数字/纯字母不算机器标识（「1234」「abcd」是普通词）。
  if (/^[0-9]+$/.test(token) || /^[A-Za-z]+$/.test(token)) return false
  return token.includes('_') || token.includes('-') || token.includes('.') || token.includes(':')
}

/**
 * @param {string} rawText 用户或回注管线给的原始查询串。
 * @returns {{ text: string, exact: string[], hasQuery: boolean }}
 */
export function planQuery(rawText) {
  const raw = typeof rawText === 'string' ? rawText : ''
  const exact = []
  let text = raw

  // 1) 引号短语整段摘出（含引号本身），重复短语去重。
  text = text.replace(QUOTED_PHRASE, (_whole, ...groups) => {
    const inner = groups.slice(0, -2).find((candidate) => typeof candidate === 'string' && candidate.trim())
    if (inner && inner.trim()) exact.push(inner.trim())
    return ' '
  })

  // 2) 机器标识词摘出：从自由文本里拿走，避免同一词在两通道重复计权。
  // 句尾裸标点（英文句读）先剥离再判形，避免 'end.' 冒充标识符。
  const kept = []
  for (const token of text.split(SPLIT)) {
    if (!token) continue
    const bare = token.replace(/[.:]+$/, '')
    if (bare.length >= 4 && isMachineIdentifier(bare)) exact.push(bare)
    else kept.push(token)
  }
  text = kept.join(' ')

  const seen = new Set()
  const uniqueExact = []
  for (const token of exact) {
    const key = token.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    uniqueExact.push(token)
  }
  return {
    text: text.trim(),
    exact: uniqueExact.slice(0, 16),
    hasQuery: text.trim().length > 0 || uniqueExact.length > 0,
  }
}
