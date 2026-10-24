/**
 * 灵枢重要度驱动的软保留评分（F1）。
 *
 * 确定性白箱评分器：对 v2 全历史模式的**软保留候选**算重要度分值，装包时按
 * 分值降序装（等价于按分值升序丢，低分先丢），替代「非必要历史按类目+recency
 * 一刀切」。分量分解输出（relevance / source / basis / hits），不给黑盒总分。
 *
 * 设计戒律（开发要求 §2.3，不可违反）：
 * - 纯函数：不调模型、不引第三方依赖、不读写冷库、不触碰宿主、不改写
 *   append-only 日志；同输入同输出。
 * - 只作用于软保留排序，**绝不动硬保护区与守卫层**（guard.mjs 管结构安全，
 *   这里只管先丢哪条）。人类请求、未闭合调用、未曝光结果、计划工件等硬保护
 *   不参与打分、不被低分丢弃。
 * - 分值只决定丢弃顺序，不当作「内容可信/正确」的证据（不是事实验证、不是
 *   置信度、不是安全隔离）。
 * - novelty 反向校准（与灵枢原语的关键差异）：`relevance` 项是「与当前工作
 *   状态卡硬前缀 + 当前人类请求的 bigram 相关度」——**越相关分越高**，绝不
 *   照抄灵枢「越新越好」，否则与当前请求高度重合的历史会被误判为冗余丢弃。
 *
 * 算法来源与映射（灵枢 `lingshu-src/md_cg`，确定性白箱）：
 * - 写入侧重要度 `importance = 0.5·novelty + 0.3·source_weight + 0.2·length`
 *   （forgetting.py:224）：本项目**改造**——novelty 反向校准为 relevance（见上），
 *   length 项不迁移（软保留行数由预算裁剪，不是重要性信号）。
 * - 来源权重 external=1.0 / self=0.5 / internal_deterministic=0.25
 *   （forgetting.py:68）：映射为 真实用户消息=1.0 / 助手产出=0.5 /
 *   插件自产卡片与工具输出=0.25。
 * - 结构重要度 `basis×信任`（weights.py:443 node_importance）：证据状态
 *   valid=1.0、stale/unverified=0.3（'unverified' 字符串与 working-state 软段共用同一口径；
 *   beta.8 起软保留只剩 unverified 一档）。
 * - 长期提升 `hits = max(merge_count, access_count, recall_count)`
 *   （consolidate.py:899 promote_memories）：反复被回读者留热区，log 压缩。
 *
 * 诚实边界：`retrievalHits`（每记录 ID 的回读/回注次数）由调用方注入——当前
 * v2 的 retrieval-index.json 只有「recordId → 外部 ID」的索引记账，**没有**
 * per-record 回读计数，接入侧暂传空映射（hitBoost 如实为 0）；数据源就绪后
 * 接入，评分器接口不变。
 */

/** 权重常量：出处与映射见模块头注释；改权重必须同步更新 v2-importance 测试。 */
export const IMPORTANCE_WEIGHTS = Object.freeze({
  relevance: 0.5,
  source: 0.3,
  basis: 0.1,
  hits: 0.1,
})

/** 来源权重（灵枢 forgetting.py:68 的三档映射）。 */
export const SOURCE_WEIGHTS = Object.freeze({
  user: 1.0,
  model: 0.5,
  plugin: 0.25,
})

/**
 * 证据状态信任（灵枢 weights.py:443 的 basis×trust 分量）。
 * `UNSTATED` 给「没有证据语义」的软保留项（历史/选项/问题类）：不奖励也不
 * 重罚——它们的价值由 relevance 与 source 分量决定。
 */
export const BASIS_TRUST = Object.freeze({
  valid: 1.0,
  stale: 0.3,
  unverified: 0.3,
})
export const BASIS_TRUST_UNSTATED = 0.6

/** hitBoost 的对数压缩饱和点：≥ 此次数的回读不再线性加分。 */
export const HITS_SATURATION = 8

/** 模板骨架行：剥掉再算 bigram，避免卡片句式污染相关度。 */
const TEMPLATE_LINE_PATTERNS = [
  /^■/,                       // 段标题行
  /^依据\/释放：/,             // 规则说明行
  /^重要度 /,                  // 本评分器自己写入的分量行
]

/**
 * 剥模板骨架：去掉标题行与规则说明行，剩下的才是候选正文。
 * 纯文本操作，不猜语义。
 */
export function stripTemplateSkeleton(lines) {
  const rows = Array.isArray(lines) ? lines : String(lines ?? '').split('\n')
  return rows.filter((line) => {
    const text = String(line ?? '').trim()
    if (text === '') return false
    return !TEMPLATE_LINE_PATTERNS.some((pattern) => pattern.test(text))
  })
}

/**
 * 文本的有序 bigram 集合（字符级，中英文同一口径）。
 * 空文本与单字符文本返回空集合（没有可比较的重叠单元）。
 */
export function bigramsOf(text) {
  const raw = String(text ?? '').replace(/\s+/g, '')
  if (raw.length < 2) return new Set()
  const grams = new Set()
  for (let index = 0; index + 1 < raw.length; index += 1) {
    grams.add(raw.slice(index, index + 2))
  }
  return grams
}

/**
 * 候选正文与上下文（硬前缀 + 当前请求）的 bigram 覆盖率：
 * `|candidate ∩ context| / |candidate|` ∈ [0, 1]。
 *
 * 用覆盖率而不是 Jaccard：语义是「候选内容有多少出现在当前工作语境里」——
 * 与当前请求高度重合的历史**不得**被评低分（novelty 反向校准）。
 * 候选无有效 bigram 时返回 0（无信号，不给默认分）。
 */
export function relevanceOf(candidateText, contextText) {
  const candidate = bigramsOf(candidateText)
  if (candidate.size === 0) return 0
  const context = bigramsOf(contextText)
  let overlap = 0
  for (const gram of candidate) {
    if (context.has(gram)) overlap += 1
  }
  return overlap / candidate.size
}

/**
 * 软保留项的来源档位（'user' | 'model' | 'plugin'）。
 *
 * 保守默认映射，接入方可显式传 `sourceBucket` 覆盖：
 * - 撤销的约束（`constraint:` 前缀）源自真实用户消息 → user；
 * - 已否决选项（模型决策）→ model；
 * - 其余（surface:/host:/readback 等宿主与插件自产事实）→ plugin。
 *
 * 0.13.2-beta.8（Q4）：`rejected-option` 类目摘除（零生产方），特判随之清理；
 * `constraint:` 前缀判据保留——它同时覆盖未来可能回归的约束类目。
 */
export function sourceBucketForRetentionItem({ source = null } = {}) {
  const sourceText = String(source ?? '')
  if (sourceText === 'user' || sourceText.startsWith('user:') || sourceText.startsWith('constraint:')) return 'user'
  if (sourceText.startsWith('decision') || sourceText.startsWith('model')) return 'model'
  return 'plugin'
}

/**
 * hitBoost：回读/回注次数的对数压缩，∈ [0, 1]。
 * `log2(1+hits) / log2(1+饱和点)`；hits ≤ 0 → 0。
 */
export function hitBoostOf(hits) {
  const count = Number(hits)
  if (!Number.isFinite(count) || count <= 0) return 0
  const saturate = Math.max(1, HITS_SATURATION)
  return Math.min(1, Math.log2(1 + count) / Math.log2(1 + saturate))
}

/**
 * 对一个软保留候选项打分。
 *
 * @param candidate - `{ lines?, text?, sourceBucket?, evidenceStatus?, recordId?, source?, retentionClass? }`
 *   `lines` 优先于 `text`；`evidenceStatus` 词汇为 valid/stale/unverified
 *   （当前生产路径只产 'unverified'），缺省按「无证据语义」处理。
 * @param context - `{ hardPrefixText?, currentRequestText?, retrievalHits? }`
 *   `retrievalHits` 是 `{ recordId: 次数 }`；只读，不写。
 * @returns `{ score, components, weights }`——分数只决定丢弃顺序（戒律：
 *   不是置信度、不是事实验证）；分量分解输出，可解释。
 */
export function scoreSoftRetention(candidate = {}, context = {}) {
  const item = candidate && typeof candidate === 'object' ? candidate : {}
  const ctx = context && typeof context === 'object' ? context : {}

  const bodyLines = stripTemplateSkeleton(item.lines ?? [item.text ?? ''])
  const candidateText = bodyLines.join('\n')
  const contextText = [
    typeof ctx.hardPrefixText === 'string' ? ctx.hardPrefixText : '',
    typeof ctx.currentRequestText === 'string' ? ctx.currentRequestText : '',
  ].filter((part) => part !== '').join('\n')
  const relevance = relevanceOf(candidateText, contextText)

  const bucket = item.sourceBucket ?? sourceBucketForRetentionItem({ source: item.source })
  const sourceWeight = SOURCE_WEIGHTS[bucket] ?? SOURCE_WEIGHTS.plugin

  const status = typeof item.evidenceStatus === 'string' ? item.evidenceStatus : null
  const basisTrust = BASIS_TRUST[status] ?? BASIS_TRUST_UNSTATED

  const hitsMap = ctx.retrievalHits && typeof ctx.retrievalHits === 'object' ? ctx.retrievalHits : {}
  const recordId = typeof item.recordId === 'string' && item.recordId !== '' ? item.recordId : null
  const hits = recordId !== null ? Number(hitsMap[recordId] ?? 0) : 0
  const hitBoost = hitBoostOf(Number.isFinite(hits) ? hits : 0)

  const weights = IMPORTANCE_WEIGHTS
  const score = weights.relevance * relevance
    + weights.source * sourceWeight
    + weights.basis * basisTrust
    + weights.hits * hitBoost

  return {
    score,
    components: {
      relevance,
      sourceBucket: bucket,
      sourceWeight,
      evidenceStatus: status,
      basisTrust,
      hits,
      hitBoost,
    },
    weights,
  }
}

/**
 * 把分量渲染成一行可解释文本（写进软保留项的 reason 字段，戒律：给分量不给黑盒）。
 */
export function formatImportanceReason(scored) {
  if (!scored || typeof scored !== 'object') return ''
  const { score, components, weights } = scored
  const parts = [
    `相关性 ${components.relevance.toFixed(2)}×${weights.relevance}`,
    `来源 ${components.sourceBucket} ${components.sourceWeight.toFixed(2)}×${weights.source}`,
    `证据 ${components.evidenceStatus ?? '未标注'} ${components.basisTrust.toFixed(2)}×${weights.basis}`,
    `回读 ${components.hits} 次→${components.hitBoost.toFixed(2)}×${weights.hits}`,
  ]
  return `重要度 ${score.toFixed(2)}（${parts.join(' ＋ ')}）`
}
