/**
 * 摄入与导出共用的敏感信息脱敏（domain/security）。
 *
 * 单一实现原则（AUD50-02-01 B1-1 / AUD50-07-01 B2-10）：文本与结构脱敏只此一份，
 * 摄入侧（v3/entry）与导出侧（domain/export）都调用这里——导出是分享前的最后一道
 * 闸门，两套规则迟早漂移。依赖方向：domain 内部模块，entry/application 均可引。
 */

/** 敏感字段脱敏（P1 摄入合同 4.1.3：凭据/令牌不静默入库）。 */
export const SENSITIVE_KEY = /token|secret|pass(word|wd)?|credential|api[-_]?key|auth|cookie|session[-_]?id|bearer|密钥|密码|令牌|凭据|凭证/i

/**
 * B3-3（AUD50-02-08）：明确不是凭据的键名白名单——旧规则里的裸 `auth` 把
 * `author`（作者）、`authMode`（认证模式）也当凭据键整值吞掉（{"author":"张三"} → [REDACTED]）。
 * 白名单之外的判定不变：不确定仍按凭据处理（宁可误伤不可漏）。
 */
const NON_SECRET_KEY = /^(?:author|authmode)$/i

/** 键名是否敏感（白名单先行）；redactValue 与文本规则的唯一判定入口。 */
export function isSensitiveKey(key) {
  return typeof key === 'string' && !NON_SECRET_KEY.test(key) && SENSITIVE_KEY.test(key)
}

/** 已知凭据前缀（出现即按凭据处理，不看长度）。 */
const CREDENTIAL_VALUE_PREFIX = /^(?:sk-|sk_|gh[pousr]_|github_pat_|xox[baprs]-|AKIA|ASIA|AIza|eyJ|rk_|rk-live)/

/** 引号成对时剥掉外壳，形态判据看裸值。 */
function bareOfQuoted(raw) {
  if (raw.length >= 2 && ((raw.charCodeAt(0) === 34 && raw.charCodeAt(raw.length - 1) === 34)
    || (raw.charCodeAt(0) === 39 && raw.charCodeAt(raw.length - 1) === 39))) return raw.slice(1, -1)
  return raw
}

/**
 * B3-3：值是否「像凭据」。只否掉**明确的普通词形态**——纯字母词（任意文字，含中文人名/普通单词）
 * 与纯数字；已知前缀、含数字/标点/符号/空白混排之外的一律按凭据处理（不确定仍替换）。
 * 空串没有可保护的内容，按非凭据。
 */
export function credentialShapedValue(raw) {
  if (typeof raw !== 'string') return true
  const value = bareOfQuoted(raw)
  if (value.length === 0) return false
  if (CREDENTIAL_VALUE_PREFIX.test(value)) return true
  if (/^\p{L}+$/u.test(value)) return false
  if (/^\d+$/.test(value)) return false
  return true
}

/**
 * 真实宿主的 tool/call 参数是 **JSON 字符串**（dsh-agent-loop appendToolCall：
 * `arguments: block.arguments`，content 块里是序列化后的字符串）。只对 object 递归的
 * 脱敏会整体漏掉这种形态（H-06：apiKey/password 明文入库）。这里先尝试解析成对象再脱敏；
 * 不是 JSON 的普通字符串原样返回（不猜、不改写用户文本）。
 */
export function parseJsonishArguments(value) {
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  if (trimmed.length < 2 || (trimmed[0] !== '{' && trimmed[0] !== '[')) return value
  try {
    const parsed = JSON.parse(trimmed)
    return parsed !== null && typeof parsed === 'object' ? parsed : value
  } catch {
    return value
  }
}

/**
 * 值里出现凭据形态的**文本**也要脱敏（H-27）：只按 key 名匹配会漏掉
 * `{headers: 'Authorization: Bearer sk-…'}`、`{url: '…?token=sk-…'}`、
 * `{args: ['--password=hunter2']}` 这类「凭据写在普通字段的值里」的形态。
 * 只改匹配到的凭据片段，不整段吞掉用户正文（保持可读性与对账价值）。
 */
export const SENSITIVE_VALUE_PATTERNS = Object.freeze([
  // PEM 私钥（RSA/EC/OPENSSH/PKCS8 等）：整段替换，避免 base64 段被当成普通文本。
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, '[REDACTED]'],
  // Authorization: Bearer xxx / Basic xxx
  [/\b(authorization\s*[:=]\s*)(bearer|basic|token)?\s*([A-Za-z0-9._~+/=-]{8,})/gi, '$1[REDACTED]'],
  // key=value / key: value / key：value / key%3Dvalue 形态的常见凭据名。
  // AUD48-02-04：旧式的 \b 边界在 AWS_SECRET_ACCESS_KEY / MY_API_KEY 这类**前缀/后缀键**
  // 上不成立（_ 是词字符），全角冒号与 URL 编码分隔符也不认；键名允许由 . _ - 连接，
  // 保留键名本身、只替换值（可读性与对账价值不丢）。
  // AUD50-02-05（B2-3）：值的边界按上下文区分——旧值字符类在 ;/, 处停止，
  // `DB_PASSWORD=abcdef;ghij` 会把 `;ghij` 留在正文里（后半段泄露）。
  // - URL/查询串（键前是 ? 或 &）：值到 &/#/空白为止，下一个参数不被误吞；
  // - 普通 key=value：值到行尾/换行为止（允许 ; 与 ,），宁可多脱敏不可漏；
  // - 引号值：引号内整段替换（含分隔符），支持 \" 转义。
  // 单条正则两分支：URL 分支先消费 [?&]key= 形态，普通分支不再重复命中同一处。
  [
    /([?&]([A-Za-z0-9_.-]*(?:api[-_]?key|access[-_]?token|refresh[-_]?token|secret|password|passwd|credential|token)[A-Za-z0-9_.-]*)(?:=|%3[dDaA]))([^&#\s]{4,})|\b([A-Za-z0-9_.-]*(?:api[-_]?key|access[-_]?token|refresh[-_]?token|secret|password|passwd|credential|token)[A-Za-z0-9_.-]*)(\s*[:=：]\s*|%3[dDaA])("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\r\n]{4,})/gi,
    (_match, urlPrefix, _urlKey, urlValue, plainKey, plainSeparator, plainValue) => {
      if (urlPrefix !== undefined) return urlPrefix + '[REDACTED]'
      // B3-3：普通词形态（the token: appears）不替换；形态判据失败时原样返回整段匹配。
      if (plainValue !== undefined && !credentialShapedValue(plainValue)) return _match
      if (typeof plainValue !== 'string') return plainKey + plainSeparator + '[REDACTED]'
      return plainKey + plainSeparator
        + (plainValue.charCodeAt(0) === 34 ? '"[REDACTED]"' : plainValue.charCodeAt(0) === 39 ? "'[REDACTED]'" : '[REDACTED]')
    },
  ],
  // AUD50-02-01（B1-1）：JSON 引号键形态——键可被 " 或 ' 包裹（JSON.stringify 的标准输出），
  // 键与分隔符之间允许空白，分隔符支持 :/=/全角冒号/URL 编码；值支持双引号串（含 \" 转义）、
  // 单引号串、无引号串。只替换值、保留键名与键引号（JSON 仍可解析，对账价值不丢）。
  // 键名核心词与上一条裸键规则一致：不含 auth——author/authMode 的对象路径误伤由
  // AUD50-02-08（B3-3）统一收紧，文本路径不在此扩大误伤面。
  [
    /(["'])([A-Za-z0-9_.-]*(?:api[-_]?key|access[-_]?token|refresh[-_]?token|secret|password|passwd|credential|token)[A-Za-z0-9_.-]*)\1(\s*[:=：]\s*|%3[dDaA])("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s"',&;}\]]{4,})/gi,
    (_match, keyQuote, key, separator, value) => {
      // B3-3：JSON 引号键同口径——值是明确普通词（authMode:'oauth' 之外的 token:'oauth' 等）不替换
      if (!credentialShapedValue(value)) return _match
      return keyQuote + key + keyQuote + separator
      + (value.charCodeAt(0) === 34 ? '"[REDACTED]"' : value.charCodeAt(0) === 39 ? "'[REDACTED]'" : '[REDACTED]')
    },
  ],
  // sk- 开头的常见密钥前缀（OpenAI/Anthropic 等）
  [/\bsk-[A-Za-z0-9_-]{8,}/g, '[REDACTED]'],
  // AWS access key ID（AKIA/ASIA/AIDA/AROA/... + 16 位大写字母数字）
  [/\b(?:AKIA|ASIA|AIDA|AROA|AIPA|ANPA|ANVA|ASCA)[0-9A-Z]{16}\b/g, '[REDACTED]'],
  // GitHub token（ghp_/gho_/ghu_/ghs_/ghr_ 与细粒度 github_pat_）
  [/\bgh[pousr]_[A-Za-z0-9]{36,}\b/g, '[REDACTED]'],
  [/\bgithub_pat_[A-Za-z0-9_]{22,}\b/g, '[REDACTED]'],
  // Slack token
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, '[REDACTED]'],
  // Google API key
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, '[REDACTED]'],
  // Stripe secret/restricted key
  [/\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,}\b/g, '[REDACTED]'],
  // JWT（三段式；只匹配足够长的段，避免误伤普通点号文本）
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED]'],
  // CLI 形态 --password=xxx
  [/(--?(?:password|passwd|token|secret|api[-_]?key)\s*[= ]\s*)([^\s"']{4,})/gi, '$1[REDACTED]'],
])

export function redactText(text) {
  if (typeof text !== 'string' || text.length === 0) return text
  let out = text
  for (const [pattern, replacement] of SENSITIVE_VALUE_PATTERNS) out = out.replace(pattern, replacement)
  return out
}

export function redactValue(value, depth = 0) {
  // 深度超限**不是**「放行原值」（H-27）：旧实现 depth > 6 直接 return value，
  // 于是第 7 层以下的凭据完全不脱敏——脱敏函数的失败模式必须是「更严」而不是「更松」。
  if (depth > 6) return '[REDACTED:depth]'
  if (value === null) return value
  if (typeof value === 'string') return redactText(value)
  if (typeof value !== 'object') return value
  // B3-2（AUD50-02-07）：上限保留（防爆炸），但截断必须可见——旧实现静默丢掉
  // 第 51 个之后的键/数组项，60 键参数只剩 50 键且无任何标记，不可审计。
  // 截断数写进标记本身（原值 -> 保留数）；不超限时不出现标记。
  if (Array.isArray(value)) {
    const items = value.slice(0, 50).map((v) => redactValue(v, depth + 1))
    if (value.length > items.length) items.push('[TRUNCATED:items ' + value.length + '->' + items.length + ']')
    return items
  }
  const entries = Object.entries(value)
  const out = {}
  // B3-3：键判定走 isSensitiveKey（author/authMode 白名单）；token/令牌类键的值是
  // 明确普通词时保留（oauth 等），password/secret 等仍无条件脱敏（宁可误伤不可漏）。
  const TOKENISH_KEY = /token|令牌/i
  for (const [k, v] of entries.slice(0, 50)) {
    if (!isSensitiveKey(k)) {
      out[k] = redactValue(v, depth + 1)
    } else if (TOKENISH_KEY.test(k) && typeof v === 'string' && !credentialShapedValue(v)) {
      out[k] = redactValue(v, depth + 1)
    } else {
      out[k] = '[REDACTED]'
    }
  }
  if (entries.length > 50) out['[TRUNCATED:keys ' + entries.length + '->50]'] = true
  return out
}
