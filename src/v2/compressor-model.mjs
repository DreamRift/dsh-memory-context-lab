/**
 * P4 模型摘要模式：程序摘要之上的可选 LLM 升级档。
 *
 * 架构约束（P0 探针结论）：宿主没有已核验的插件侧 LLM 调用契约，所以本模块
 * 只接收注入的 stream({ model, messages, signal })——所有宿主契约风险收敛在
 * runtime 的一个解析点（compressDepsOf.modelPhase），不直连宿主内部。
 *
 * 失败关闭阶梯（任何一档都落回程序摘要，不阻塞压缩事务）：
 *   no-model → auth / rate-limit / host-error / timeout → cancelled（任务撤
 *   销，结果丢弃不落账）→ invalid-shape / empty-output / invalid-ref /
 *   over-budget / no-gain。
 * 任务撤销（用户取消 / 插件关闭 / 阶段重开 / 来源过期）不是失败：run 即停，
 * 绝不借程序兜底继续提交。
 */
import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

/** 阶段模型调用超时（拍板区间 30–60s，默认 45s）。 */
export const MODEL_PHASE_TIMEOUT_MS_MIN = 30_000
export const MODEL_PHASE_TIMEOUT_MS_MAX = 60_000
export const MODEL_PHASE_TIMEOUT_MS_DEFAULT = 45_000

/** 摘要行数上限（超过即 invalid-shape，防止模型用长文绕过增益判定）。 */
export const MODEL_SUMMARY_MAX_LINES = 32

/** 模型卡 token 预算（与压缩拍板的 ~1k 摘要预算一致）。 */
export const MODEL_CARD_TOKEN_BUDGET = 1024

/** 粗略 token 估算：中文按字、ASCII 按词计，宁紧勿松。 */
function approxTokens(text) {
  const s = String(text ?? '')
  let tokens = 0
  for (const ch of s) tokens += ch.codePointAt(0) > 0x2e80 ? 1 : 0.5
  return Math.ceil(tokens)
}

/** 程序选块指纹：块行文列表的 sha256 前 24 hex（缓存过期判据）。 */
export function blocksHashOf(selected) {
  const h = createHash('sha256')
  for (const b of selected ?? []) h.update(b.blockId + '\u0000' + b.line + '\u0001')
  return h.digest('hex').slice(0, 24)
}

/** 缓存键：模型名 + 消息体的 sha256 前 24 hex。 */
export function modelCacheKeyOf({ model, messages }) {
  const h = createHash('sha256')
  h.update(String(model ?? ''))
  h.update('\u0000')
  for (const m of messages ?? []) h.update(m.role + '\u0000' + m.content + '\u0001')
  return 'mc-' + h.digest('hex').slice(0, 24)
}

/**
 * 组装 LLM 消息：system 强约束（只许挑选、不许改写数字），user 带程序选中
 * 块的 L0 行文与编号，要求输出严格 JSON 行列表。
 */
export function buildModelMessages({ model, facts, blocks, selected }) {
  void model
  void facts
  const chosen = Array.isArray(selected) && selected.length > 0 ? selected : (blocks ?? [])
  const factLines = chosen.map((b, i) => (i + 1) + '. [' + b.blockId + '] ' + b.line)
  const system =
    '你是压缩摘要校验员。只允许从给出的精确事实清单中挑选条目组成摘要，' +
    '不得改写、推断或新增任何数值。输出严格的 JSON：{"lines":[{"text":"…","refs":["块ID"]}]}，' +
    '每条结论的 refs 必须引用清单中的块 ID，text 中出现的每个数字串都必须原样出现在被引用块的行文中。' +
    '不要输出其他文本。'
  const user =
    'L0 精确事实清单（块ID | 行文）：\n' + factLines.join('\n') +
    '\n\n请挑出构成该阶段关键结论的最小条目集，按上述 JSON 输出。'
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]
}

/** 超时中止错误（name 用于 classifyModelError 分类）。 */
function TimeoutAbortError() {
  const e = new Error('模型摘要超时')
  e.name = 'TimeoutAbortError'
  return e
}

/**
 * 失败分类：错误 → 档位。取消优先（signal 已中止即 cancelled，即使错误表面
 * 是别的）；其余按消息关键词；非错误值也必须有档位，不许抛出。
 */
export function classifyModelError(error, { signal } = {}) {
  if (signal?.aborted) return 'cancelled'
  if (error instanceof Error && error.name === 'TimeoutAbortError') return 'timeout'
  const msg = String((error && (error.message ?? error)) ?? '')
  if (/\b(401|403)\b/i.test(msg) || /unauthorized|invalid api key|forbidden/i.test(msg)) return 'auth'
  if (/\b429\b/.test(msg) || /too many requests|rate limit/i.test(msg)) return 'rate-limit'
  return 'host-error'
}

/**
 * 机械校验：逐条对回 L0 精确值。合法行必须：
 * 1. refs 非空且全部指向程序选中的块（invalid-ref）；
 * 2. text 中的数字串都能在任一被引用块行文中原样找到（invalid-shape，
 *    编造数字与非法形态共用档位）；
 * 3. 行数 ≤ MODEL_SUMMARY_MAX_LINES 且 kept 非空。
 */
export function verifyModelSummary({ parsed, selected }) {
  const lines = parsed?.lines
  if (!Array.isArray(lines)) return { ok: false, reason: 'invalid-shape', kept: [], rejected: [] }
  if (lines.length > MODEL_SUMMARY_MAX_LINES) return { ok: false, reason: 'invalid-shape', kept: [], rejected: [] }
  const byId = new Map((selected ?? []).map((b) => [b.blockId, b]))
  const kept = []
  const rejected = []
  for (const line of lines) {
    const refs = Array.isArray(line?.refs) ? line.refs : []
    const text = typeof line?.text === 'string' ? line.text : ''
    const validRefs = refs.length > 0 && refs.every((r) => byId.has(r))
    if (!text.trim()) { rejected.push({ text, refs, reason: 'invalid-shape' }); continue }
    if (!validRefs) { rejected.push({ text, refs, reason: 'invalid-ref' }); continue }
    const hay = refs.map((r) => byId.get(r).line ?? '').join('\n')
    const numbers = String(text).match(/[0-9][0-9.]*/g) ?? []
    const badNumbers = numbers.filter((n) => !hay.includes(n))
    if (badNumbers.length > 0) { rejected.push({ text, refs, reason: 'invalid-shape' }); continue }
    kept.push({ text, refs })
  }
  if (kept.length === 0) return { ok: false, reason: rejected.some((r) => r.reason === 'invalid-ref') ? 'invalid-ref' : 'empty-output', kept, rejected }
  return { ok: true, kept, rejected }
}

/** 模型卡渲染：与程序卡同构（阶段卡形态），剔除行数如实标注。 */
export function renderModelPhaseCard({ summaryId, phaseLabel, memberCount, tools, lines, manifestId, voucherId, rejectedCount }) {
  const out = []
  out.push('【阶段卡 ' + summaryId + '】' + (phaseLabel ? phaseLabel : '') + '（' + String(memberCount ?? 0) + ' 条回执）')
  for (const line of lines) out.push('· ' + line.text + '（' + (line.refs ?? []).join('/') + '）')
  if (Number(rejectedCount) > 0) out.push('（' + String(rejectedCount) + ' 条未通过对回 L0 的机械校验，已剔除）')
  out.push('工具：' + (tools ?? []).join('、'))
  out.push('来源清单 manifest ' + String(manifestId ?? '') + '，凭证 ' + String(voucherId ?? '') + '；/memory-lab expand ' + String(voucherId ?? ''))
  out.push('模型摘要模式：以上结论逐条对回 L0 精确值，未通过者已剔除。')
  return out.join('\n')
}

/**
 * 运行模型阶段：上游事务前调用，返回 { mode: 'model'|'program', reason?,
 * card?, cacheHit?, cancelled? }。mode=program 时一律携带 reason；取消时
 * cancelled=true。观察面钩子（cacheLookup/cacheSave/onUsage）抛错只记
 * fail-open，不阻断压缩。
 */
export async function runModelPhase({
  stream, model, selected, programCardTokens, signal,
  timeoutMs, onUsage, cacheLookup, cacheSave,
  summaryId, phaseLabel, memberCount, tools, manifestId, voucherId,
} = {}) {
  const program = (extra = {}) => ({ mode: 'program', ...extra })
  if (typeof stream !== 'function') return program({ reason: 'no-model' })
  if (signal?.aborted) return program({ reason: 'cancelled', cancelled: true })
  const messages = buildModelMessages({ model, facts: [], blocks: selected, selected })
  const key = modelCacheKeyOf({ model, messages })
  const hash = blocksHashOf(selected)

  // 缓存命中：key+blocksHash 双匹配；lookup 抛错按未命中处理。缓存里存的是
  // 已通过机械校验的行列表，复验通过才可用（来源块过期即不命中）。
  let cached = null
  try { cached = typeof cacheLookup === 'function' ? await cacheLookup(key, hash) : null } catch { cached = null }
  const cachedVerdict = cached && (Array.isArray(cached.lines) || typeof cached.text === 'string')
    ? verifyModelSummary({
        parsed: Array.isArray(cached.lines) ? { lines: cached.lines } : safeParse(cached.text),
        selected,
      })
    : null
  if (cachedVerdict?.ok) {
    const card = renderModelPhaseCard({ summaryId, phaseLabel, memberCount, tools, lines: cachedVerdict.kept, manifestId, voucherId, rejectedCount: cachedVerdict.rejected.length })
    await safely(() => onUsage?.({ model, usage: cached.usage ?? { input: 0, output: 0 }, cacheHit: true }))
    return { mode: 'model', card, cacheHit: true }
  }

  // 真调用：超时只做 abort 传播（计时器不碰网络）。
  const effectiveTimeout = Math.min(MODEL_PHASE_TIMEOUT_MS_MAX, Math.max(MODEL_PHASE_TIMEOUT_MS_MIN, Number(timeoutMs) || MODEL_PHASE_TIMEOUT_MS_DEFAULT))
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  signal?.addEventListener('abort', onAbort, { once: true })
  const timer = delay(effectiveTimeout, undefined, { signal: controller.signal }).then(() => { throw TimeoutAbortError() }, () => {})
  let raw, usage
  try {
    const raced = await Promise.race([
      Promise.resolve().then(() => stream({ model, messages, signal: controller.signal })),
      timer,
    ])
    raw = raced?.text
    usage = raced?.usage ?? null
  } catch (error) {
    const reason = classifyModelError(error, { signal })
    if (reason === 'cancelled') return program({ reason, cancelled: true })
    return program({ reason })
  } finally {
    controller.abort()
    signal?.removeEventListener('abort', onAbort)
  }

  if (signal?.aborted) return program({ reason: 'cancelled', cancelled: true })
  if (typeof raw !== 'string' || raw.trim() === '') return program({ reason: 'invalid-shape' })

  // 解析：严格 JSON；包裹在代码栏里的也接受。
  let parsed = null
  try {
    const trimmed = raw.trim().replace(/^\`\`\`(?:json)?/i, '').replace(/\`\`\`\s*$/, '').trim()
    parsed = JSON.parse(trimmed)
  } catch { return program({ reason: 'invalid-shape' }) }
  if (parsed === null || typeof parsed !== 'object') return program({ reason: 'invalid-shape' })

  const verdict = verifyModelSummary({ parsed, selected })
  if (!verdict.ok) {
    if (verdict.reason === 'invalid-ref' || verdict.reason === 'empty-output') return program({ reason: verdict.reason })
    return program({ reason: 'invalid-shape' })
  }

  // 增益判定：模型卡必须严格短于程序卡，且不超卡预算。
  const card = renderModelPhaseCard({ summaryId, phaseLabel, memberCount, tools, lines: verdict.kept, manifestId, voucherId, rejectedCount: verdict.rejected.length })
  const cardTokens = approxTokens(card)
  // 增益判定的两条独立闸门：①卡预算上限（MODEL_CARD_TOKEN_BUDGET）无条件生效——
  // 超限的模型卡无论程序卡多大都不采纳（此前它在 programCardTokens 为 Infinity 时
  // 被短路漏检，实测 32 行长文照常走 model 档，0.10.0 既有缺陷）；②严格短于程序卡。
  // 顺序先 over-budget 后 no-gain：同卡超限且不省时按更具体的 over-budget 报因。
  if (cardTokens > MODEL_CARD_TOKEN_BUDGET) return program({ reason: 'over-budget' })
  if (cardTokens >= Number(programCardTokens ?? Number.POSITIVE_INFINITY)) return program({ reason: 'no-gain' })

  // 观察面：落账与缓存写入，抛错不阻断。
  await safely(() => onUsage?.({ model, usage, cacheHit: false }))
  await safely(() => cacheSave?.({ key, blocksHash: hash, lines: verdict.kept, usage, model }))
  return { mode: 'model', card, cacheHit: false }
}

async function safely(fn) {
  try { await fn() } catch { /* 观察面失败不阻断压缩 */ }
}

/** JSON 正文缓存格式的容错解析：坏正文返回 null（按未命中处理）。 */
function safeParse(text) {
  try { return JSON.parse(String(text)) } catch { return null }
}
