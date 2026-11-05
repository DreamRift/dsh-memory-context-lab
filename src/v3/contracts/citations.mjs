/**
 * 读取侧引用区合同（contracts，0.15.0 G2 / C-G2-01..07，单一真源）。
 *
 * 为什么需要一份合同（F03 的根因）：
 * `memory_context_read` 原来只有 status/id/type/source_hash/text/truncated/next_cursor/visible/error，
 * 于是「回执里的记录 ID 能读回正文」成立，但**读回之后没有下一跳**——模型拿不到
 * 「这条记录属于哪张回执」「这次工具调用的结果在哪」「这条摘要的来源是哪些记录」。
 * 摘要工件 contexts（sources/evidenceRefs/supersedes）早就落了盘，却没有合同约束
 * 「读响应必须把它稳定地露出来」，因此谁都可以不实现，也不会被判红。
 *
 * 三条硬纪律（写进 schema 而不是只写注释）：
 * 1. **两条链分开**：普通自动归档回执 → 原记录（relation 'archive-receipt'，靠 voucher）；
 *    协作 compact 回执 → SummaryArtifact → 来源记录（relation 'segment-summary' + 'source'）。
 *    普通回执里只有 `summarizeRecords` 的内联短摘要，**不是** SummaryArtifact——
 *    本文件不提供任何把内联摘要冒充成摘要工件的 relation。
 * 2. **真实关系分开表达**：来源 / 证据 / 取代 / 派生基准 / 所属回执 / 段落摘要 / 调用配对 / 相邻记录
 *    各自一个 relation 值。相邻（'adjacent'）只表示日志相邻，不表示因果——不许把序号邻近
 *    包装成「因为…所以…」。
 * 3. **有界**：条数、跳数、返回字段长度都有上界；超限不给假 EOF，给可继续访问的游标。
 *
 * 本文件零运行时依赖：只导出常量与纯 schema（schema 本体在 contracts/tools.mjs 组装）。
 */

/** 引用区合同版本（字段/关系语义变化 +1；与 cursor 版本相互独立）。 */
export const READ_REFERENCE_VERSION = 1

/**
 * 关系封闭集（新增关系必须同时改本枚举、render 文案与消费者；不许自由字符串）。
 *
 * - source：摘要工件 → 来源记录（链 B 的第二跳；每项带该记录的不可变字节 hash）
 * - evidence：摘要工件 → 证据引用（C-G2-02 要求 evidenceRefs ⊆ sources；这里单独一个
 *   relation 是为了「被当作证据」这件事可见，不是第二条来源）
 * - supersedes：摘要 → 被它取代的旧摘要（不可变对象的派生关系；禁自指）
 * - base：摘要 → baseSummaryId（派生基准；与 supersedes 是两回事）
 * - archive-receipt：记录 → 覆盖它的归档回执（链 A；凭 voucher，不是凭序号猜测）
 * - segment-summary：记录 → 该段落对应的 SummaryArtifact（链 B 的入口；**只有协作 compact
 *   的凭证带 summaryRef 时才存在**，普通自动归档永不产生这个 relation）
 * - call-pair：记录 ↔ 同一 callId 的配对工具调用/结果（真实配对，不是相邻推断）
 * - adjacent：记录 → 日志上前后相邻的记录（**只表示相邻**，不表示因果或从属）
 */
export const READ_REFERENCE_RELATIONS = Object.freeze([
  'source',
  'evidence',
  'supersedes',
  'base',
  'archive-receipt',
  'segment-summary',
  'call-pair',
  'adjacent',
])

/**
 * 被引用对象的身份类别封闭集。
 * - record：v3r-… 记录
 * - summary：v3s-… SummaryArtifact
 * - voucher：v-<receiptSeq> 归档凭证（对象是「回执」这条账本事实）
 * - event：宿主事件（dsh-<seq>；配对/相邻里出现但没有 v3 记录时用它，绝不伪造记录 ID）
 */
export const READ_REFERENCE_KINDS = Object.freeze(['record', 'summary', 'voucher', 'event'])

/**
 * 逐跳核验结果封闭集（C-G2-06）。**每个非 ok 值都表示「这条引用不能当正文读」**，
 * 而不是「没有这条引用」：
 * - ok：本跳重新核验通过（存在、未遗忘、会话一致、hash 对得上）
 * - unknown：旧回执/旧摘要没有这条引用或无法判定——如实标未知，**不补造关系**
 * - missing：对象不存在（并发删除/来源缺失）
 * - forgotten：已遗忘（forget 代际命中；不返回正文/摘要/敏感元数据）
 * - hidden：可见性判定为不可读（摘要来源被忘、来源集合对账失败等）
 * - hash-mismatch：来源记录的当前字节 hash 与摘要里绑定的不一致（来源已漂移）
 * - session-mismatch：对象属于另一个会话（跨会话 ID 一律拒绝，不泄露正文）
 * - unpaired：调用/结果没有配对（未完成对或声明缺失；不假装配对成功）
 * - unreadable：账本/存储不可读（未知 ≠ 没有）
 */
export const READ_REFERENCE_STATUSES = Object.freeze([
  'ok',
  'unknown',
  'missing',
  'forgotten',
  'hidden',
  'hash-mismatch',
  'session-mismatch',
  'unpaired',
  'unreadable',
])

/**
 * 引用上的 hash **含义**封闭集（C-G2-07：三种 hash 不可互换）。
 * - record-source：记录不可变字节 hash（recordHashMaterial 的 sha256）——身份 hash
 * - record-text：本地**脱敏后正文**的 hash（与记录字节 hash 不同义；T2 包装文本偏移不得套到它）
 * - summary-artifact：SummaryArtifact 物化指纹（canonicalSummaryMaterial 的 sha256）
 * - none：该引用没有可用 hash（未知；不得用别的 hash 顶替）
 */
export const READ_REFERENCE_HASH_KINDS = Object.freeze([
  'record-source',
  'record-text',
  'summary-artifact',
  'none',
])

/**
 * 引用区上界（C-G2-05：条数/单页/跳数都有界，超限给「可继续访问」而不是静默丢弃）。
 *
 * - page：一次响应默认给几条引用（模型读得完、上下文可控）
 * - pageMax：refs_limit 的硬上界（再大也只按它截）
 * - total：单次读取最多**编目**多少条引用（防「200 条来源 × 多关系」撑爆）
 * - detail：单条 ref.detail 的码点上界（定位信息是给人/模型看的，不承载正文）
 * - receipts：单条记录最多列几张覆盖它的回执（正常 1 张；异常账本不放大）
 * - hops：引用展开跳数（**恒为 1**：本工具只给下一跳，续读靠新的 read 调用）
 */
export const READ_REFS_LIMITS = Object.freeze({
  page: 8,
  pageMax: 20,
  total: 240,
  detail: 120,
  receipts: 4,
  hops: 1,
})

/** 对象版本值的类别（cursor 绑定它；见 contracts/readback.mjs）。 */
export const READ_OBJECT_VERSION_KINDS = Object.freeze([
  'record-source-hash',
  'summary-artifact-hash',
  'unknown',
])

/** 引用区字段名（schema/render/消费者共用；改名必须同时改三处）。 */
export const READ_REFERENCE_FIELDS = Object.freeze([
  'id',
  'kind',
  'relation',
  'status',
  'hash',
  'hash_kind',
  'seq',
  'start_seq',
  'end_seq',
  'call_id',
  'detail',
])
