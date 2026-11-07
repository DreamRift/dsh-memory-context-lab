/**
 * 摄入与导出共用的敏感信息脱敏（domain/security）。
 *
 * 单一实现原则（AUD50-02-01 B1-1 / AUD50-07-01 B2-10）：文本与结构脱敏只此一份，
 * 摄入侧（v3/entry）与导出侧（domain/export）都调用这里——导出是分享前的最后一道
 * 闸门，两套规则迟早漂移。依赖方向：domain 内部模块，entry/application 均可引。
 */

/**
 * 中文凭据键核心词（P1-01 单一真源）：对象面 \`isSensitiveKey\` 与文本面键名共用这一份词表。
 * 两套词表迟早漂移——0.15.1 的缺口正是「对象面认中文、文本面只认 ASCII」。
 * \`口令/私钥\` 只进文本面与对象面判据（不是新工具、不改合同）。
 */
const SECRET_KEY_CJK = ['密码', '密钥', '令牌', '凭据', '凭证', '口令', '私钥']

/** 敏感字段脱敏（P1 摄入合同 4.1.3：凭据/令牌不静默入库）。 */
export const SENSITIVE_KEY = new RegExp(
  'token|secret|pass(word|wd)?|credential|api[-_]?key|auth|cookie|session[-_]?id|bearer|' + SECRET_KEY_CJK.join('|'),
  'i',
)

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
/** 文本规则里「凭据键核心词」的唯一真源（裸键 / 引号键 / URL 查询串三处共用）。 */
const SECRET_KEY_WORDS = 'api[-_]?key|access[-_]?token|refresh[-_]?token|secret|password|passwd|credential|token|cookie|session[-_]?id'
/** 键名允许由 . _ - 连接（DB_PASSWORD / MY_API_KEY / db.password 这类前缀/后缀键）。 */
const SECRET_KEY_ASCII_BODY = '[A-Za-z0-9_.-]*(?:' + SECRET_KEY_WORDS + ')[A-Za-z0-9_.-]*'
/**
 * P1-01：中文键形态。核心词与对象面同源（SECRET_KEY_CJK），前缀允许至多 8 个「ASCII/CJK」
 * 字符（数据库密码 / 登录口令 / API密钥），但**不允许中文字后缀**——后缀会把
 * \`密码学：…\`、\`密钥长度：256\` 这类技术名词当成凭据键，误伤散文（宁可少误伤，
 * 后缀键的真实凭据会在文本里另有 ASCII 形态或对象面兜底）。
 */
const SECRET_KEY_CJK_BODY = '[A-Za-z0-9_.\\-\\u4e00-\\u9fff]{0,8}?(?:' + SECRET_KEY_CJK.join('|') + ')'
const SECRET_KEY_BODY = '(?:' + SECRET_KEY_ASCII_BODY + '|' + SECRET_KEY_CJK_BODY + ')'
/**
 * 键名起点边界（P1-01）：ASCII 词边界 \`\b\` 对 CJK 字符不成立（JS 的 \\w 只有 ASCII，
 * \`密码\` 前不会出现 \`\b\`），旧写法导致中文键整条规则失效。改用「前一个字符不是
 * ASCII 词字符」的零宽后视——语义与 \`\b\` 等价，且对 CJK 起首的键成立。
 */
const KEY_BOUNDARY = String.raw`(?<![A-Za-z0-9_])`
/** key: value / key=value / 全角冒号 / URL 编码分隔符（单独一段：三个规则共用同一份分隔符）。 */
/**
 * 分隔符（S-07 / S-08，0.15.4）。
 *
 * 旧形态 `(\s*[:=：]\s*|%3[dDaA])` 漏掉三类真实写法：
 * - 全角等号 `＝`（中文输入法下 `密码＝abc` 极常见）；
 * - 中文系词 `密码为/是/设为 X`——中文用户不写冒号，写「密码为 abc」；
 * - 零宽字符（`pass\u200bword=`）把键名拆开，`SECRET_KEY_BODY` 匹配不上。
 *
 * 零宽字符在**键名归一化**里处理（见 `normalizeKeyShapes`），不放进这里：
 * 把 `\u200b` 塞进正则会把「键名」和「分隔符」两件事混起来。
 */
const SECRET_KEY_SEP = String.raw`(\s*(?:[:=：＝]|为|是|设为|设置为)\s*|%3[dDaA])`

/**
 * M-01 修复（0.15.4，用户裁定问题 1-C「两步法」）：普通分支的值**不再吃到行尾**。
 *
 * ## 旧行为（缺陷）
 *
 * 值边界是 `[^\r\n]{4,}`——一旦命中凭据键，**整行剩余正文**都被替换成 `[REDACTED]`。
 * 真机实测：一条 9,010 字的工具结果被压成 759 字；全库 23 条记录确认被吞。
 * 用户可见后果是「记住的内容莫名其妙缺一大段」，而缺的部分和凭据无关。
 *
 * ## 新行为（两步法）
 *
 * 1. **第一步**：只切出「值 token」——遇到空白 / 引号闭合 / `,;)]}>` / 行尾就停。
 *    这与值本身像不像凭据无关，纯粹是**词边界**。
 * 2. **第二步**：拿切出的 token 过 `textValueIsSecret` 的形态判据（`credentialShapedValue`）：
 *    - 像凭据（有 `sk-`/AKIA/JWT/高熵串/混合字符）→ 只替换**这个 token**；
 *    - 不像凭据（纯字母单词、普通散文）→ **原样保留**，让后续规则按需处理。
 *
 * ## 取舍（已在方案文档登记）
 *
 * - 纯字母短口令（`DB_PASSWORD=swordfish`）在普通散文里**不再无条件替换**——
 *   这是两步法的已知残留，用户已裁定接受（问题 1 选 C）；
 * - 但**引号包裹**的值仍整段替换（`password: "swordfish"` 引号就是明确的值边界），
 *   以及中文凭据键（`密码：xxx`）仍无条件替换——这两类没有歧义，不参与第一步放松。
 */
/**
 * 值 token 的边界 = **空白**（或引号闭合）。
 *
 * 这是两步法里最关键的一条：`;` `,` `)` 这些符号**不切断值**——因为
 * `DB_PASSWORD=abcdef;ghij` 的 `;ghij` 是同一凭据的后半段（0.15.1 修的正是这个漏），
 * 而 `API_KEY=sk-xxx 这是后面的一段中文正文` 的中文正文前有**空白**，自然被切开。
 *
 * 换言之：「值到哪结束」由空白决定（可判定、无歧义），
 * 「这段值要不要替换」由形态决定（`credentialShapedValue`）。两件事分开做，才是两步法。
 */
const VALUE_TOKEN = String.raw`(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s"']{1,})`

/** 裸键形态（含 URL 查询串分支，分支判据见下方回调）。 */
const KEY_VALUE_RE = new RegExp(
  String.raw`([?&](` + SECRET_KEY_BODY + String.raw`)(?:=|%3[dDaA]))([^&#\s]{4,})` + String.raw`|` + KEY_BOUNDARY + '(' + SECRET_KEY_BODY + ')' + SECRET_KEY_SEP + '(' + VALUE_TOKEN + ')',
  'gi',
)

/** JSON 引号键形态（键可被 " 或 ' 包裹）。 */
const QUOTED_KEY_VALUE_RE = new RegExp(
  String.raw`(["'])(` + SECRET_KEY_BODY + String.raw`)\1` + SECRET_KEY_SEP + String.raw`("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s"',&;}\]]{4,})`,
  'gi',
)

/** token 类键：值是明确普通词时保留（`token: oauth` / `the token: appears`），B3-3 的收敛不回退。 */
const TOKENISH_KEY = /token|令牌/i
/** 中文凭据键（P1-01）：命中即无条件替换值，与 SECRET_KEY_CJK 同源。 */
const CJK_KEY = new RegExp(SECRET_KEY_CJK.join('|'))

/**
 * 文本路径的值判据。对象路径与文本路径共用这一处判据（两套规则迟早漂移）。
 *
 * ## 0.15.4 变更（M-01 / 用户裁定问题 1-C「两步法」）
 *
 * 旧实现里，除 token 类键之外的所有凭据键都**无条件替换**。在值边界还是「吃到行尾」时，
 * 这条无条件规则是「宁可多脱敏」的合理选择；但值边界收紧成单 token 之后，它会把
 * 普通散文里的裸词也替换掉，既误伤可读性，又救不了真正的泄密。
 *
 * 新判据按值的形态分层，与值边界严格分工：
 * - 引号包裹（password: "swordfish"）→ 恒替换。引号是作者给出的明确值边界，没有歧义；
 * - 中文凭据键（密码：xxx）→ 恒替换。中文标签后跟的就是它的值，不做形态放宽；
 * - 其余裸值 → 只有看起来像凭据（credentialShapedValue：密钥前缀 / 高熵串 /
 *   数字字母混合的长串）才替换，纯字母单词与普通散文保留。
 *
 * ## 已知残留（用户已裁定接受）
 *
 * DB_PASSWORD=swordfish 这种「全小写纯字母短口令 + 裸值」不再被替换。
 * 选 C（两步法）就是接受这个残留，换取「不再吞掉整行正文」——真机上后者造成
 * 23 条记录被截断、一条 9,010 字的结果被压成 759 字。
 */
/**
 * **对象路径**的值判据（与文本路径分开，0.15.4）。
 *
 * 对象路径的值边界是天然的（JSON 的键值对），不存在「值吃到行尾」的问题，
 * 因此这里保持 0.15.1 的失败关闭口径：凭据键命中即无条件替换。
 * 文本路径才需要「两步法」——那是为了不吞掉同一行里与凭据无关的正文。
 *
 * 把两条路径的判据分开，是为了不让「文本面放宽」泄漏到对象面上。
 */
function objectValueIsSecret(key, rawValue) {
  if (typeof rawValue !== 'string') return true
  // 中文凭据键：无条件替换（与文本路径一致）。
  if (CJK_KEY.test(key)) return true
  const value = bareOfQuoted(rawValue)
  if (value.length === 0) return false
  // token 类键：值像凭据才替换（oauth / appears 这类普通词放行，B3-3 不回退）。
  if (TOKENISH_KEY.test(key)) return credentialShapedValue(rawValue)
  // 其余凭据键：无条件替换（对象边界清晰，保持失败关闭）。
  return true
}

function textValueIsSecret(key, rawValue) {
  // 值边界已经收窄到「空白」（见 VALUE_TOKEN），这里**不再按值的形态放宽**。
  //
  // 为什么不需要放宽了：两步法的收益来自「值不再吃到行尾」，而不是来自「少替换几个词」。
  // 值边界是空白之后，被替换的永远只是「键=值」里那一段值本身，后面与凭据无关的正文
  // 天然留在外面。既然边界已经没有歧义，值判据就该保持失败关闭（0.15.1 口径）：
  // 凭据键命中即替换，不论值是纯字母、纯中文还是纯数字。
  //
  // 这样 M-01（吞掉整行正文）与 B2-3（半段凭据泄露）可以**同时**成立：
  //   API_KEY=sk-xxx 这是后面很长的一段中文正文   → 只替换 sk-xxx，中文正文保留
  //   DB_PASSWORD=abcdef;ghij                      → 无空白，整段都是值，全部替换
  if (typeof rawValue !== 'string') return true
  const value = bareOfQuoted(rawValue)
  if (value.length === 0) return false
  // 中文凭据键（含「令牌」）：命中即替换，不走 token 的形态放宽——
  // 中文标签后跟的就是它的值（令牌：myword 是真口令，不是普通词）。
  if (CJK_KEY.test(key)) return true
  // ASCII token 是**弱键**：后面常跟普通词（token: oauth / the token: appears /
  // token: 12345），保持 0.15.1 的形态收敛，不无条件替换（B3-3 不回退）。
  if (TOKENISH_KEY.test(key)) return credentialShapedValue(rawValue)
  // 其余凭据键（password/secret/api_key/credential/cookie/session_id…）：失败关闭。
  return true
}

/** 替换值并保留引号外壳（JSON 仍可解析，对账价值不丢）。 */
function redactedValueOf(rawValue) {
  if (typeof rawValue !== 'string' || rawValue.length === 0) return '[REDACTED]'
  if (rawValue.charCodeAt(0) === 34) return '"[REDACTED]"'
  if (rawValue.charCodeAt(0) === 39) return "'[REDACTED]'"
  return '[REDACTED]'
}

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
    KEY_VALUE_RE,
    (_match, urlPrefix, _urlKey, urlValue, plainKey, plainSeparator, plainValue) => {
      // URL 查询串分支恒替换（值边界到 &/#/空白，下一个参数不被误吞）。
      // URL 分支要整段替换（键名在查询串里也是敏感信息的一部分）。
      if (urlPrefix !== undefined) return { prefixOffset: 0, replacement: urlPrefix + '[REDACTED]' }
      // 键名判据（AUD51-07-01）：token 类看形态，其余凭据键无条件替换。
      if (!textValueIsSecret(plainKey, plainValue)) return null
      // 只替换「值」，键名与分隔符取原文（S-08：全角/零宽形态不得被顺手规范化）。
      return { prefixOffset: _match.length - plainValue.length, replacement: redactedValueOf(plainValue) }
    },
  ],
  // AUD50-02-01（B1-1）：JSON 引号键形态——键可被 " 或 ' 包裹（JSON.stringify 的标准输出），
  // 键与分隔符之间允许空白，分隔符支持 :/=/全角冒号/URL 编码；值支持双引号串（含 \" 转义）、
  // 单引号串、无引号串。只替换值、保留键名与键引号（JSON 仍可解析，对账价值不丢）。
  // 键名核心词与上一条裸键规则一致：不含 auth——author/authMode 的对象路径误伤由
  // AUD50-02-08（B3-3）统一收紧，文本路径不在此扩大误伤面。
  [
    QUOTED_KEY_VALUE_RE,
    (_match, keyQuote, key, separator, value) => {
      // 与裸键同一判据：token 类看形态，其余凭据键无条件替换。
      if (!textValueIsSecret(key, value)) return null
      // 同 S-08：键名与分隔符取原文，只换值。
      return { prefixOffset: _match.length - value.length, replacement: redactedValueOf(value) }
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

/**
 * S-08（0.15.4）：同形键归一化。
 *
 * ## 缺陷
 *
 * `ｐａｓｓｗｏｒｄ＝abc`（全角 ASCII）与 `pass\u200bword=abc`（零宽字符插入）在正则上
 * 都**不是**凭据键，于是整条明文通过。这两类不是边角案例：全角来自中文输入法，
 * 零宽来自网页复制。
 *
 * ## 做法：检测用归一化副本，替换落回原文
 *
 * **不**直接归一化原文——脱敏函数改写用户正文是不可接受的副作用，而且会让
 * 「脱敏后可见面」与「账本原文」对不上。这里保持两份：
 * - `normalized`：剥零宽、全角折半角，只用于**匹配**；
 * - `map[i]`：`normalized[i]` 在原文里的下标，用于把匹配区间**映射回原文**。
 *
 * 匹配区间 `[s, e)` 映射为原文 `[map[s], map[e-1]+1)`，因此区间内的零宽字符
 * 会随原文片段一起被替换掉（它们本来就该消失）。
 *
 * 归一化只做两件不改变语义的事：去掉零宽格式字符、把全角 ASCII 折成半角。
 * 其余字符一律一码点对一码点，映射是精确的。
 */
const ZERO_WIDTH_RE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g

function foldFullwidth(code) {
  // U+FF01..U+FF5E 与 ASCII 0x21..0x7E 一一对应。
  return code >= 0xff01 && code <= 0xff5e ? code - 0xfee0 : code
}

function normalizeWithMap(text) {
  let normalized = ''
  const map = []
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    if (ZERO_WIDTH_RE.test(text[i])) {
      ZERO_WIDTH_RE.lastIndex = 0
      continue
    }
    ZERO_WIDTH_RE.lastIndex = 0
    normalized += String.fromCharCode(foldFullwidth(code))
    map.push(i)
  }
  return { normalized, map }
}

/**
 * 把归一化文本上的替换结果落回原文。
 *
 * ## 为什么不能直接把回调结果写进原文
 *
 * 回调拿到的是**归一化副本**里的键名与分隔符（已折半角、已剥零宽）。若直接写回，
 * `密码＝abc` 会变成 `密码=[REDACTED]`——把用户的全角等号改成了半角，属于**改写正文**。
 * 脱敏只允许替换敏感值，不允许顺手规范化别的字符。
 *
 * 因此这里按 `map` 精确切分：**原文区间内的字符一律保留原样**，只把「值」那一段
 * 换成替换串。实现上让回调返回 `{ prefixEnd, replacement }`：`prefixEnd` 是
 * 归一化串里的「值起点」，值之前的键名与分隔符原样取自原文。
 */
function redactPatternOnNormalized(text, pattern, replacer) {
  const { normalized, map } = normalizeWithMap(text)
  let out = ''
  let cursor = 0
  pattern.lastIndex = 0
  let match = pattern.exec(normalized)
  while (match !== null) {
    const start = match.index
    const end = start + match[0].length
    const decision = replacer(...match)
    if (decision !== null && decision !== undefined) {
      // 值起点在归一化串里的位置；它必然落在本次匹配内。
      const prefixEnd = start + decision.prefixOffset
      // 原文里「键名 + 分隔符」的结束位置 = 归一化值起点对应的原文下标。
      const origPrefixEnd = prefixEnd < map.length ? map[prefixEnd] : text.length
      out += text.slice(cursor, origPrefixEnd) + decision.replacement
      cursor = end > 0 ? map[end - 1] + 1 : origPrefixEnd
    }
    if (match[0].length === 0) pattern.lastIndex += 1
    match = pattern.exec(normalized)
  }
  return cursor === 0 ? text : out + text.slice(cursor)
}

export function redactText(text) {
  if (typeof text !== 'string' || text.length === 0) return text
  let out = text
  for (const [pattern, replacement] of SENSITIVE_VALUE_PATTERNS) {
    if (typeof replacement === 'function') {
      out = redactPatternOnNormalized(out, pattern, replacement)
    } else {
      out = out.replace(pattern, replacement)
    }
  }
  return out
}

/**
 * S-11（0.15.4）：截断上限与截断元字段。
 *
 * 上限仍然存在（防真爆炸），但**不再用伪键**公示截断：
 * 旧实现塞进 `out['[TRUNCATED:keys 60->50]'] = true`，那一行会以普通参数的身份
 * 被下游当成真实工具参数读取，语义被污染。
 *
 * 现在截断信息走独立键 `$truncated`（`$` 前缀不可能是真实工具参数名），
 * 值是结构化描述，不参与参数语义。
 */
const REDACT_KEY_LIMIT = 200
const REDACT_ITEM_LIMIT = 200
const REDACT_TRUNCATION_KEY = '$truncated'

/**
 * 深度超限时的骨架保留（S-10，0.15.4）。
 *
 * 容器继续按同一规则展开一层（**不再下探**是被标量叶子承担的责任），
 * 目的是让「对象仍是对象、数组仍是数组」。标量叶子一律换成标记。
 *
 * 注意这里**不做进一步的递归脱敏**：已经超限了，继续下探就失去上限的意义。
 * 但也正因为不下探，容器里的**标量**必须全部标记掉，否则第 8 层的明文会原样带出。
 */
function redactDepthMarker(value) {
  if (value === null || typeof value !== 'object') return '[REDACTED:depth]'
  if (Array.isArray(value)) return value.map((item) => redactDepthMarker(item))
  const out = {}
  for (const [key, item] of Object.entries(value)) {
    Object.defineProperty(out, key, {
      value: redactDepthMarker(item),
      enumerable: true,
      writable: true,
      configurable: true,
    })
  }
  return out
}

export function redactValue(value, depth = 0) {
  // 深度超限**不是**「放行原值」（H-27）：旧实现 depth > 6 直接 return value，
  // 于是第 7 层以下的凭据完全不脱敏——脱敏函数的失败模式必须是「更严」而不是「更松」。
  //
  // S-10（0.15.4）：超限时**保留容器骨架**，只把叶子换成标记。
  //
  // 旧实现把整枝对象替换成字符串 `'[REDACTED:depth]'`：外层明明是个对象，第 7 层
  // 突然变成字符串，导出包因此**结构不一致**（摄入时保留、导出时毁掉；同一份参数
  // 在两条路径上形状不同，回读与对账都会错）。深度是防爆炸的上限，不该改变类型。
  //
  // 骨架保留后，超限层以下的容器仍是对象/数组，只有**标量叶子**变成标记——
  // 那样既不泄密，也仍然可逐步遍历审计。
  if (depth > 6) return redactDepthMarker(value)
  if (value === null) return value
  if (typeof value === 'string') return redactText(value)
  if (typeof value !== 'object') return value
  // B3-2（AUD50-02-07）：上限保留（防爆炸），但截断必须可见——旧实现静默丢掉
  // 第 51 个之后的键/数组项，60 键参数只剩 50 键且无任何标记，不可审计。
  //
  // S-11（0.15.4）：改用**对象包装**而不是往数组里 push 一个字符串标记。
  // 旧实现 `items.push('[TRUNCATED:items n->50]')` 把标记塞进**数据数组**，
  // 下游按数组元素读取时会把它当成一个真实的工具参数/返回值——语义污染。
  // 数组保持纯数组，截断信息挂在独立的 `$truncated` 属性上（不可枚举，
  // 因此 JSON.stringify 不会把它混进元素列表）。
  if (Array.isArray(value)) {
    const items = value.slice(0, REDACT_ITEM_LIMIT).map((v) => redactValue(v, depth + 1))
    if (value.length > items.length) {
      Object.defineProperty(items, REDACT_TRUNCATION_KEY, {
        value: Object.freeze({
          totalItems: value.length,
          keptItems: items.length,
          droppedItems: value.length - items.length,
        }),
        enumerable: false,
        writable: true,
        configurable: true,
      })
    }
    return items
  }
  const entries = Object.entries(value)
  // S-15（0.15.4）：`__proto__` 赋值会改写返回对象的原型，并让该键的数据**静默丢失**。
  //
  // `out['__proto__'] = x` 在普通对象上不创建自有属性，而是走原型设置器——
  // 于是 `payload.__proto__` 的内容变成返回对象的原型，`Object.keys` 里看不到它，
  // 但 `{}` 继承链上却能读到载荷内容。这是**原型污染**，且丢失不可见。
  //
  // 修法：无原型对象 + `defineProperty` 写入。`defineProperty` 不触发 setter，
  // `__proto__` 会作为普通自有数据属性落地（后续 JSON.stringify 也照常序列化，
  // 反而不丢数据）。无原型对象同时保证不会继承任何被污染的成员。
  const out = {}
  // S-11：子数组被截断时，把它们的 `$truncated` 上提到本对象，保证 JSON 后仍可见。
  const truncations = {}
  // B3-3：键判定走 isSensitiveKey（author/authMode 白名单）；token/令牌类键的值是
  // 明确普通词时保留（oauth 等），password/secret 等仍无条件脱敏（宁可误伤不可漏）。
  // 0.15.4：对象路径用自己的判据（objectValueIsSecret），不与文本路径共用——
  // 文本面的「两步法」放宽只服务于「不吞正文」，不该泄漏到边界清晰的对象面。
  //
  // S-11（0.15.4）：**不再把键硬截断到 50**。
  //
  // 缺陷：`entries.slice(0, 50)` 让第 51 个之后的参数**永久丢失**（不可恢复、不可审计），
  // 而旧实现用来公示截断的 `out['[TRUNCATED:keys n->50]'] = true` 是**伪键**——
  // 它以合法参数的身份混进 `structure`，下游把它当真实工具参数读，语义被污染。
  //
  // 新口径：
  // - 键按 `REDACT_KEY_LIMIT` 放宽（仍然有界，防真爆炸），保留的是**原始键名**；
  // - 截断信息写进独立的 `REDACT_TRUNCATION_KEY`，值是一个描述对象，
  //   键名带保留前缀 `$`（工具参数名不可能是 `$` 开头），不参与参数语义；
  // - 未截断时不出现该元字段（不制造空噪音）。
  for (const [k, v] of entries.slice(0, REDACT_KEY_LIMIT)) {
    const next = !isSensitiveKey(k) || !objectValueIsSecret(k, v) ? redactValue(v, depth + 1) : '[REDACTED]'
    Object.defineProperty(out, k, { value: next, enumerable: true, writable: true, configurable: true })
    // S-11：数组的截断信息挂在数组自身的 `$truncated` 上（不可枚举，不污染元素列表），
    // 但 JSON 序列化会丢掉非索引属性。这里把它**上提到父对象**，让截断在落盘/导出后
    // 仍然可见（B3-2 的「截断必须可见」不回退）。
    if (next !== null && typeof next === 'object' && next[REDACT_TRUNCATION_KEY] !== undefined) {
      truncations[k] = next[REDACT_TRUNCATION_KEY]
    }
  }
  if (entries.length > REDACT_KEY_LIMIT) {
    Object.defineProperty(out, REDACT_TRUNCATION_KEY, {
      value: Object.freeze({
        totalKeys: entries.length,
        keptKeys: REDACT_KEY_LIMIT,
        droppedKeys: entries.length - REDACT_KEY_LIMIT,
      }),
      enumerable: true,
      writable: true,
      configurable: true,
    })
  } else if (Object.keys(truncations).length > 0) {
    // 没有键级截断，但有子数组被截断：把子数组的截断信息上提。
    Object.defineProperty(out, REDACT_TRUNCATION_KEY, {
      value: Object.freeze(truncations),
      enumerable: true,
      writable: true,
      configurable: true,
    })
  }
  return out
}
