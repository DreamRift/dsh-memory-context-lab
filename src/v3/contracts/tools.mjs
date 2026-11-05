/**
 * 固定 AI 管理工具合同（contracts，0.15.0 P4，单一真源）。
 *
 * 为什么放在 contracts：工具名、参数/输出 schema、结果来源标记必须**一处定义**——
 * - 工具定义在请求前缀里，schema 一旦随会话/模式变化就作废整段前缀缓存，
 *   因此三个工具在版本加载时一次性注册、启停与降级只通过**返回值**表达；
 * - 摄入侧要按工具名/结果标记判断「这是本插件自己的管理产物」，不能另写一份名单；
 * - 测试用宿主注册替身做严格校验：schema 只用宿主已核实的关键字
 *   （type/oneOf/properties/required/additionalProperties/items/enum/const），
 *   多写 minimum 之类会让整份 schema 注册失败。
 *
 * 依赖方向：只 import 同目录的 contracts（readback / citations），它们同样零运行时依赖；
 * 不 import domain/adapters——schema 是注册期事实，不得随会话状态或实现细节变化。
 * 宿主门槛（§6.2）：submit 在真实工具结果→归档→下一请求顺序验证前只做「持久化待执行」，
 * 不提供改面副作用。
 */
import {
  READ_OBJECT_VERSION_KINDS,
  READ_REFERENCE_FIELDS,
  READ_REFERENCE_HASH_KINDS,
  READ_REFERENCE_KINDS,
  READ_REFERENCE_RELATIONS,
  READ_REFERENCE_STATUSES,
  READ_REFS_LIMITS,
} from './citations.mjs'
import { READBACK_OFFSET_UNIT } from './readback.mjs'

/** 三个固定工具名（封闭集；新增工具须走 ADR + 前缀稳定性评估）。 */
export const MEMORY_CONTEXT_TOOL_NAMES = Object.freeze({
  search: 'memory_context_search',
  read: 'memory_context_read',
  compact: 'memory_context_compact',
})

/** 工具名清单（摄入侧 own-source 判定与测试共用）。 */
export const MEMORY_CONTEXT_TOOL_LIST = Object.freeze([
  MEMORY_CONTEXT_TOOL_NAMES.search,
  MEMORY_CONTEXT_TOOL_NAMES.read,
  MEMORY_CONTEXT_TOOL_NAMES.compact,
])

/**
 * 本插件管理工具结果的来源标记（工具 render 的首行）。
 * 摄入侧据此把工具结果标成 metaOnly（可回读、不进检索），避免「搜索/读取结果
 * 又变成新的可检索记忆」的管理循环；跨重启也成立（不依赖内存里的 callId 表）。
 */
export const OWN_TOOL_RESULT_MARKER = '[记忆上下文·工具结果]'

/** 可空字段的宿主子集写法（nullable:true 不在子集里）。 */
const nullable = (type) => ({ oneOf: [{ type }, { type: 'null' }] })
const stringArray = { type: 'array', items: { type: 'string' } }

/**
 * 搜索完整性封闭集（C-G1-03 / U3）。
 *
 * - `complete`：该 scope 下已经**穷尽**（没有任何未返回的命中，也没有不可读的命中被跳过）；
 * - `partial`：还有下一页，或后端无法证明穷尽（T2 top-k / 索引未就绪 / 摘要窗口被截）；
 * - `unavailable`：这次没有给出结果可信度（游标被拒、引擎未就绪、能力不足）；
 * - `failed`：检索本身失败（错误码在 error）。
 * 语义收紧后写进 schema：模型不会再从自由字符串里读出一个自造的「complete」。
 */
export const SEARCH_COMPLETENESS = Object.freeze(['complete', 'partial', 'unavailable', 'failed'])

/**
 * 摘录偏移单位（C-G1-09 裁决）：模型工具面（search/read）一律**码点**。
 * 命令面 `/memory-lab read` 本轮保持 UTF-16 计数 + 单次上限截断的现状（不在本批改动面）。
 * 上限的数字只认 contracts/readback.mjs 的 READBACK_MAX_CHARS——本条注释不重复数字
 * （P7-20 全仓源码扫描只允许单一真源出现该字面量）。
 */
export const SEARCH_OFFSET_UNIT = 'code-point'

/**
 * 单个**窗口**的码点预算（C-G1-08；entry 不得再写第二个 160 字面量）。
 *
 * P2-10（0.15.1）：这条曾经写成「单条摘录的码点预算」，读起来像**总预算**——但实现一直
 * 是「每个窗口各给一份」，于是两个互补窗口时单条摘录的真实长度可达
 * `MAX_CHARS × MAX_SPANS + (MAX_SPANS − 1) × 3`（160 → 323，实测吻合）。设置语义与实测
 * 因此漂移：按 160 估算回注预算会**低估近一倍**。
 *
 * 两种修法：把实现收紧成总预算（会牺牲「两个远处事实都可见」，与 G1/P5 的既有产品行为
 * 冲突，且 P2-10 的判定本就是「语义漂移」而不是「超额」），或把措辞改成与实测一致。
 * 这里取后者：语义真源改为「每窗口预算」，并用 `SEARCH_EXCERPT_MAX_TOTAL_CHARS`
 * 给出真实上界，任何预算推算都必须用它而不是 `SEARCH_EXCERPT_MAX_CHARS`。
 */
export const SEARCH_EXCERPT_MAX_CHARS = 160

/** 单条摘录最多几个互补窗口（中间缺口必须可见，见 excerpt.mjs 的 truncated 判据）。 */
export const SEARCH_EXCERPT_MAX_SPANS = 2

/** 窗口之间的连接符（" … "，3 个码点）——算真实上界时要计入。 */
export const SEARCH_EXCERPT_JOINER = ' … '

/**
 * 单条摘录的**真实长度上界**（码点）：每窗口预算 × 窗口数 + 连接符。
 * 任何「一条命中最多占多少字符」的预算推算都必须用这个常量，不要再用 MAX_CHARS。
 */
export const SEARCH_EXCERPT_MAX_TOTAL_CHARS = SEARCH_EXCERPT_MAX_CHARS * SEARCH_EXCERPT_MAX_SPANS
  + [...SEARCH_EXCERPT_JOINER].length * (SEARCH_EXCERPT_MAX_SPANS - 1)

/** 窗口左侧上下文码点数（窗口吸附回文首时的阈值，与 selectExcerpt 的语义一致）。 */
export const SEARCH_EXCERPT_CONTEXT_CHARS = 24

/** 摘录合同版本：字段/偏移语义变化 +1（与 cursor 版本相互独立）。 */
export const SEARCH_EXCERPT_VERSION = 1

/** 搜索参数 schema。 */
export const SEARCH_TOOL_PARAMETERS = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    query: { type: 'string' },
    scope: { type: 'string', enum: ['records', 'summaries', 'all'] },
    limit: { type: 'integer' },
    cursor: { type: 'string' },
  },
  required: ['query'],
})

/** 摘录 span（码点半开区间；与本地脱敏正文同尺，C-G1-08/C-G1-09）。 */
const EXCERPT_SPAN_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    start: { type: 'number' },
    end: { type: 'number' },
  },
  required: ['start', 'end'],
})

/**
 * 搜索结果输出 schema（C-G1-01：字段名是协议；新增字段必须同改本 schema、
 * entry/tools.mjs 的 render 与消费者）。
 *
 * 关键语义（模型读得懂的部分写在 render 文案里）：
 * - `total_match_count`：**精确**总数或 null。只有可穷尽枚举/可信计数才给数字，
 *   provider 的 top-k 长度不是 total（F01 的根因）；
 * - `has_more`：true=还有下一页（此时必有 next_cursor）；false=已穷尽；null=未知/不支持继续；
 * - `reason`：降级/无法继续/跳过命中的原因码（普通「还有下一页」不写原因）；
 * - `skipped_count`：命中但正文读不出来的条数（已遗忘/并发删除），如实计数、不静默吞。
 */
export const SEARCH_TOOL_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    status: { type: 'string' },
    scope: { type: 'string' },
    returned_count: { type: 'number' },
    total_match_count: nullable('number'),
    completeness: { type: 'string', enum: [...SEARCH_COMPLETENESS] },
    reason: nullable('string'),
    has_more: nullable('boolean'),
    offset_unit: { type: 'string', enum: [SEARCH_OFFSET_UNIT] },
    excerpt_version: { type: 'number' },
    skipped_count: { type: 'number' },
    next_cursor: nullable('string'),
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          kind: { type: 'string' },
          title: nullable('string'),
          excerpt: nullable('string'),
          source_hash: nullable('string'),
          text_hash: nullable('string'),
          excerpt_spans: { type: 'array', items: EXCERPT_SPAN_SCHEMA },
          excerpt_strategy: { type: 'string' },
          excerpt_truncated: { type: 'boolean' },
          excerpt_source: { type: 'string', enum: ['record-text', 'summary-short-text'] },
        },
      },
    },
    error: nullable('string'),
  },
  required: ['status', 'scope', 'returned_count', 'completeness', 'items'],
})

/**
 * 读取参数 schema。
 *
 * G2 新增两个**可选**参数（旧调用不传即旧行为）：
 * - `refs_cursor`：引用区分页游标（与 `cursor` 是两条独立的可验证分页语义：
 *   `cursor` 续正文页、`refs_cursor` 续引用页；两者共用同一套 v1.* 绑定与错误码）；
 * - `refs_limit`：本页引用条数（1..READ_REFS_LIMITS.pageMax）。**越界失败关闭**
 *   （`error=invalid-refs-limit`），不再静默夹取——夹取会让模型以为「本页就是全部引用」
 *   （P2-12，与搜索侧 limit 同一口径）。
 *
 * P2-12 统一口径（0.15.1）：工具面三个数量参数 `limit` / `length` / `refs_limit` 的合法域
 * 见各自上界；**缺省走默认值，越界一律失败关闭**并在信封里带可读 `error`
 * （`invalid-limit` / `invalid-length` / `invalid-refs-limit`）。旧实现是 `Math.min/max`
 * 静默夹取——「有界热上下文」因此变成失败开放：请求 999 条被悄悄改成 10 条，
 * 模型看不到任何越界信号（与 H-38 在 provider 层确立的失败关闭口径自相矛盾）。
 * 工具集恒定：没有新增/删除工具，只是同一工具的可选参数在版本加载时统一注册一次。
 */
export const READ_TOOL_PARAMETERS = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    detail: { type: 'string', enum: ['short', 'full', 'auto'] },
    cursor: { type: 'string' },
    offset: { type: 'integer' },
    length: { type: 'integer' },
    refs_cursor: { type: 'string' },
    refs_limit: { type: 'integer' },
  },
  required: ['id'],
})

/**
 * 单条引用 schema（C-G2-01；字段名是协议，改名必须同改 render 与消费者）。
 *
 * 每条引用都必须有**稳定 ID + 关系类型 + 必要定位**：
 * - id：v3r-… / v3s-… / v-<seq> / dsh-<seq> 之一（kind 说明是哪一种）；
 * - relation：封闭集，见 contracts/citations.mjs（两条链、来源/证据/配对/相邻分开）；
 * - seq/start_seq/end_seq：宿主 seq 定位（回执区间、配对事件位置）；
 * - call_id：工具调用配对键（真实配对，不是序号推断）；
 * - hash/hash_kind：三种 hash 各自命名（记录字节 / 脱敏正文 / 摘要工件），不可互换；
 * - status：本跳重新核验的结果（不可读/已忘/跨会话/哈希不符都如实给，不当成「没有」）。
 */
export const READ_REFERENCE_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    kind: { type: 'string', enum: [...READ_REFERENCE_KINDS] },
    relation: { type: 'string', enum: [...READ_REFERENCE_RELATIONS] },
    status: { type: 'string', enum: [...READ_REFERENCE_STATUSES] },
    hash: nullable('string'),
    hash_kind: { type: 'string', enum: [...READ_REFERENCE_HASH_KINDS] },
    seq: nullable('number'),
    start_seq: nullable('number'),
    end_seq: nullable('number'),
    call_id: nullable('string'),
    detail: nullable('string'),
  },
  // 只要「身份 + 关系 + 核验结果」在，定位字段就可以缺（未知就缺，不猜）。
  required: READ_REFERENCE_FIELDS.filter((field) => ['id', 'kind', 'relation', 'status'].includes(field)),
})

/**
 * 读取输出 schema（**旧字段全部保留**，只做增量；C-G2-01/C-G2-04/C-G2-07）。
 *
 * 新增字段的语义：
 * - offset_unit/cursor_version：本响应的分页单位（码点）与游标合同版本——模型据此知道自己
 *   拿到的是哪一版语义，而不是靠猜；
 * - object_version/object_version_kind：cursor 绑定的对象版本（记录字节 hash / 摘要工件指纹），
 *   内容一变旧游标就显式失效（不静默错读）；
 * - text_hash：**脱敏后正文**的 hash（C-G2-07 的第二义；与 source_hash 不同义，不许互相顶替）；
 * - offset/returned_chars：本页起点与长度（码点），与 next_cursor 自洽；
 * - sources/related/evidence_refs：有界引用区（见 contracts/citations.mjs）；
 * - refs_total/refs_truncated/refs_capped/next_refs_cursor：引用区的可继续访问协议
 *   （超限给游标，不静默遗失；硬上界封顶时明说 capped）。
 */
export const READ_TOOL_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    status: { type: 'string' },
    id: { type: 'string' },
    type: { type: 'string' },
    source_hash: nullable('string'),
    text: nullable('string'),
    truncated: { type: 'boolean' },
    next_cursor: nullable('string'),
    visible: { type: 'boolean' },
    error: nullable('string'),
    offset_unit: { type: 'string', enum: [READBACK_OFFSET_UNIT] },
    cursor_version: { type: 'number' },
    object_version: nullable('string'),
    object_version_kind: { type: 'string', enum: [...READ_OBJECT_VERSION_KINDS] },
    text_hash: nullable('string'),
    offset: { type: 'number' },
    returned_chars: { type: 'number' },
    reference_version: { type: 'number' },
    sources: { type: 'array', items: READ_REFERENCE_SCHEMA },
    related: { type: 'array', items: READ_REFERENCE_SCHEMA },
    evidence_refs: stringArray,
    refs_total: { type: 'number' },
    refs_truncated: { type: 'boolean' },
    refs_capped: { type: 'boolean' },
    next_refs_cursor: nullable('string'),
  },
  required: ['status', 'id', 'type', 'truncated', 'visible'],
})


/** 提案草稿 schema（模型可写文本，但只是**未验证草稿**）。 */
export const COMPACT_SUMMARY_DRAFT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    shortText: { type: 'string' },
    detail: { type: 'string' },
    goal: { type: 'string' },
    changes: stringArray,
    outcome: { type: 'string', enum: ['succeeded', 'failed', 'blocked', 'partial', 'unknown'] },
    decisions: stringArray,
    openItems: stringArray,
    evidenceRefs: stringArray,
  },
})

/** compact 参数 schema。 */
export const COMPACT_TOOL_PARAMETERS = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    op: { type: 'string', enum: ['inspect', 'prepare', 'submit', 'status'] },
    candidate_id: { type: 'string' },
    proposal_id: { type: 'string' },
    idempotency_key: { type: 'string' },
    summary: COMPACT_SUMMARY_DRAFT_SCHEMA,
  },
  required: ['op'],
})

/** compact 输出 schema。 */
export const COMPACT_TOOL_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    status: { type: 'string' },
    stage: { type: 'string' },
    candidate_id: nullable('string'),
    proposal_id: nullable('string'),
    executable: nullable('boolean'),
    receipt_chars: nullable('number'),
    source_chars: nullable('number'),
    summary_id: nullable('string'),
    summary_hash: nullable('string'),
    committed: { type: 'boolean' },
    accepted: { type: 'boolean' },
    receipt_seq: nullable('number'),
    expires_at: nullable('number'),
    reasons: stringArray,
    summary_line: nullable('string'),
    error: nullable('string'),
  },
  required: ['status', 'stage', 'committed', 'accepted', 'reasons'],
})

/** 结果摘要（供 error/停用文案共用；不参与 schema）。 */
export function describeToolUnavailable(reason) {
  return '本次未执行：' + String(reason ?? 'unknown')
}
