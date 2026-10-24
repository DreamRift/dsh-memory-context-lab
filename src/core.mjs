import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { InvalidArgumentError } from './errors.mjs'

export const PACKAGE_NAME = 'dsh-memory-context-lab'

import {
  RECEIPT_MARKER,
  V2_RECEIPT_MARKER,
  FOLD_RECEIPT_MARKER,
  AGG_VOUCHER_MARKER,
  SURFACE_INJECTION_MARKERS,
  isSurfaceInjectionText,
  DEFAULT_SETTINGS,
  retainReadsTtlOf,
  GLOBAL_PRESET_LABEL,
  BUILTIN_PRESETS,
  NUMERIC_SETTINGS,
  BOOLEAN_SETTINGS,
  parseOperation,
  textFromContent,
  estimateTokens,
  SettingsError,
  parseNumericSetting,
  parseStrictInteger,
  boundedNumericSetting,
  normalizeSettings,
  normalizeProtectionBudget,
  normalizeProtectionSettings,
  normalizePresetEntry,
  normalizePresets,
  PRESET_RESET_WORDS,
  resolvePreset,
  foldCommandIntoState,
  initialProjectionState,
  isReceiptMessage,
} from './core-settings.mjs'

import {
  displayPreview,
  renderRecallBlock,
  escapePromptBraces,
  formatRecallDigest,
  digestRecall,
  RECALL_PREVIEW_NOTE,
  RECALL_STATUS,
  normalizeRecallPayload,
  TRI_STATE,
  isKnownNumber,
} from './core-recall.mjs'
export {
  displayPreview,
  renderRecallBlock,
  escapePromptBraces,
  formatRecallDigest,
  digestRecall,
  RECALL_PREVIEW_NOTE,
  RECALL_STATUS,
  normalizeRecallPayload,
  TRI_STATE,
  isKnownNumber,
} from './core-recall.mjs'
export {
  RECEIPT_MARKER,
  V2_RECEIPT_MARKER,
  FOLD_RECEIPT_MARKER,
  AGG_VOUCHER_MARKER,
  SURFACE_INJECTION_MARKERS,
  isSurfaceInjectionText,
  DEFAULT_SETTINGS,
  retainReadsTtlOf,
  GLOBAL_PRESET_LABEL,
  BUILTIN_PRESETS,
  NUMERIC_SETTINGS,
  BOOLEAN_SETTINGS,
  parseOperation,
  textFromContent,
  estimateTokens,
  SettingsError,
  parseNumericSetting,
  parseStrictInteger,
  boundedNumericSetting,
  normalizeSettings,
  normalizeProtectionBudget,
  normalizeProtectionSettings,
  normalizePresetEntry,
  normalizePresets,
  PRESET_RESET_WORDS,
  resolvePreset,
  foldCommandIntoState,
  initialProjectionState,
  isReceiptMessage,
} from './core-settings.mjs'

/**
 * 版本号的唯一权威是 `package.json`，这里读它而不是再抄一份常量。
 * 旧实现把 '0.6.0' 硬编码在源码里，manifest 升到 0.8.0-rc.3 后两者长期不一致
 * （审计 P2-5）。读不到 manifest 时退回到 `'unknown'`：如实标未知，不编造版本。
 */
export const PACKAGE_VERSION = (() => {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url))
    const manifest = JSON.parse(readFileSync(path.join(here, '..', 'package.json'), 'utf8'))
    return typeof manifest.version === 'string' && manifest.version ? manifest.version : 'unknown'
  } catch {
    return 'unknown'
  }
})()

export const COMMAND_NAME = 'memory-lab'

export const LAB_ROOT_NAME = '.memory-context-lab'
export const SESSIONS_DIRECTORY = 'sessions'
export const STATE_FILE = 'state.json'
export const LAB_ROOT_MARKER_FILE = 'lab-root.json'
export const LAB_ROOT_MARKER_KIND = 'dsh-memory-context-lab/root'
export const STATE_KIND = 'dsh-memory-context-lab/session'
export const SCHEMA_VERSION = 1



/**
 * 回执格式版本（0.10.1 S2c：显式 dispatch，废弃「>= 最新」比较）。
 *
 * 1 = 历史格式（只有工具／来源／冷记录／hash）；
 * 2 = 增加确定性定位元数据（每次调用的对象与返回状态、稳定调用引用）；
 * 4 = 在 2 的基础上增加「记录 ID」行——规划期 recordId 尚未产生（它在冷写提交后才
 *      存在），该行指路到 nodeId 别名回读（0.10.1 S2a 已支持）；提交期拿到可用
 *      recordIds 时渲染真实记录 ID。
 *
 * **编号 3 被 RECEIPT_FORMAT_BATCH（批次摘要）占用**，新格式从 4 起。
 *
 * 恢复的精确比较要求回执正文逐字节相等，所以**每个历史版本必须继续可渲染**：
 * 归档行记录自己写入时的版本，恢复时按该版本重建期望正文；缺失该字段的旧行按 1
 * 处理。dispatch 表是**冻结的历史版本映射**——常量递增不得改变旧版本的渲染结果
 * （取证 R0 问题 4 实证：`>=` 比较在升版后会丢弃 format 2 旧行的 locator/status
 * 行，恢复被整体拒绝）。未知版本抛错（失败关闭），不猜测渲染。
 */
export const RECEIPT_FORMAT_LEGACY = 1
export const RECEIPT_FORMAT_VERSION = 4
/**
 * 批次摘要回执（P1-5）。
 *
 * 一批里**区间相邻**的多个操作合并为一次表面替换，共用一条批次摘要回执；
 * 归档行按 `receiptFormat = 3` 记账，恢复时按行分组（同一 replacementSeq 且
 * 相邻）重建整条摘要并一次性恢复全部原文。格式 2 的逐条回执保持字节不变。
 */
export const RECEIPT_FORMAT_BATCH = 3
/**
 * 0.13.1（F2/F3）：批次摘要回执的**新文案版本**。
 *
 * 旧 format 3 只写「N 个相邻操作」——那个 N 是相邻段长度，既不是本批操作数，
 * 也不是配置阈值，事后审计读不出「阈值 10 是否生效」。新文案把三个数分开：
 * 阈值 / 本批成员数 / 本段相邻数，并在被单批释放上限截断时如实说明。
 *
 * **为什么必须新开编号**：回执正文参与 restore 的逐字节比对。就地改 format 3
 * 的渲染会让 0.13.0 及更早写下的批次回执全部对不上（「回执正文已变化」），
 * 原文永久不可恢复。旧 3 的渲染路径保持冻结，新写入用 8。
 */
export const RECEIPT_FORMAT_BATCH_V2 = 8
/**
 * 普通历史段回执（0.10.1 修复 BUG-001）。
 *
 * v2 对非工具操作跨度（用户/助手正文、旧卡、召回包）用 buildSpanReceipt 渲染，
 * 与工具操作回执（buildReceipt）逐字节不同。归档行必须记录这个专用版本，恢复侧
 * 才能按同一函数重建期望正文——曾经统一记成 4，恢复时套用 buildReceipt 重建，
 * 逐字节不等 → 永久 `回执正文已变化` 跳过，原文滞留冷库且无恢复通道。
 */
export const RECEIPT_FORMAT_SPAN = 5
/**
 * 操作回执 · 投影经济学版（0.12.0 P0-5/P0-1/P1-5）。
 *
 * 与 format 4 的差别只有**追加/改写三类行**，正文、范围、hash 的渲染不变：
 * - 投影头：同时声明「释放多少」与「失真等级 + 取回代价」（灵枢 v1.2 P5-3）；
 * - 可回读：首行是**工具调用形式**（模型直接照抄），命令面提示降到第二行（给人）；
 * - status：工具结果带 ok/fail/partial（失败附首错行，截断），非工具结果标 kind=message。
 *
 * 为什么要新号：恢复要求回执**逐字节**相等，旧行必须继续按旧渲染器重建，
 * 所以新形状只能占新号，绝不改旧号的输出（{@link RECEIPT_FORMAT_LEGACY} 的教训）。
 */
export const RECEIPT_FORMAT_OPERATION = 6
/** 普通历史段回执 · 投影经济学版（0.12.0）；与 format 5 的差别同 {@link RECEIPT_FORMAT_OPERATION}。 */
export const RECEIPT_FORMAT_SPAN_V2 = 7

/**
 * beta.9（P0-3/Z-01）：slim 格式。台账实测可回读/命令面/hash 三行约占回执开销
 * 47%，而「怎么回读」只需要在**每个会话**教一次（第一批印全样例），之后的批次
 * 全部压成 `read:` 单行并删掉 hash 行（hash 是冷库一致性校验用的，不是模型
 * 消费用的新息；需要它时按冷记录 id 从归档行取）。旧版本渲染逐字节冻结不变；
 * slim 行的恢复重建走同一 builder（`apply.mjs` 候选集已收录 9/10/11）。
 */
export const RECEIPT_FORMAT_OPERATION_SLIM = 9
export const RECEIPT_FORMAT_SPAN_SLIM = 10
export const RECEIPT_FORMAT_BATCH_SLIM = 11
/** Minimum original body length before one operation may be archived. */
export const MIN_OPERATION_CHARS = 1200
/**
 * Largest single cold node that can still be verified after a cold write.
 *
 * `mdcg_get` clips its answer at 2000 lines / 50 KiB and flags `truncated`, so a
 * bigger node could be stored but never read back whole. These bounds leave
 * headroom for the cold record's provenance header.
 *
 * This is a *chunk* limit, not an archiving limit: a larger operation is split
 * into several nodes of at most this size, each verified on its own, so a big
 * `read` or `edit` is still archivable without giving up read-back fidelity.
 */
export const MAX_OPERATION_BYTES = 48 * 1024
export const MAX_OPERATION_LINES = 1900
/**
 * Ceiling on one operation's total archived body.
 *
 * Chunking removes the read-back limit, so this exists only to stop a
 * pathological node (a runaway dump) from turning one archive step into
 * hundreds of cold writes. Exceeding it is reported as `too-large`.
 */
export const MAX_OPERATION_TOTAL_BYTES = 4 * 1024 * 1024

/** Safety ceiling on the operations committed by one batch. */
export const MAX_OPERATIONS_PER_BATCH = 64
/** An operation must free at least this many estimated tokens to be worth a rewrite. */
export const MIN_NET_RELEASE_TOKENS = 128
/**
 * One batch may release at most this many estimated tokens (C-12 sizing, C-07
 * bounded batches). A giant burst of old evidence is drained over several
 * measured turns instead of vanishing from the projection in one rewrite.
 *
 * 0.13.1：这个上限从**硬编码常量**改为「窗口百分比」，默认仍是 6.25%——
 * 1M 窗口下正好等于原来的 65,536，行为不变；小窗口（200k）下不再让一批
 * 吃掉三分之一的上下文。
 *
 * 实测依据（会话 c1787f24）：配置 `batch 10`，但第 1、2 批只提交了 6 和 3 个
 * 操作——因为第 7 位操作本身就有 42,074 token，加上去就超了 65,536。用户看到
 * 的是「没按 10 个归档」，而真实原因是这个隐藏常量。现在它出现在 `status` 里，
 * 回执也会说明「被单批上限截断」。
 */
export const MAX_BATCH_RELEASE_WINDOW_RATIO = 0.0625
/** 兜底值：窗口不可判定时使用（与 0.13.0 的硬编码值相同）。 */
export const MAX_BATCH_RELEASE_TOKENS = 65_536

/**
 * 按窗口解析单批释放上限。
 *
 * 窗口不可判定时回落到 {@link MAX_BATCH_RELEASE_TOKENS}——这是**保守**方向：
 * 宁可沿用旧值，也不因为算不出窗口就把上限放大。
 */
/**
 * P1-3（beta.9）：回执头文案真源。渲染侧（buildBatchReceipt 族）与解析侧
 * （apply-restore 的批头正则）共用同一串前缀——文案改动只改这里，
 * 解析正则从常量构造，两处永不漂移。
 */
export const RECEIPT_TEMPLATES = Object.freeze({
  batchHead: '批次归档：本批',
  batchHeadMerged: '批次归档：',
  cappedSuffix: '（单批释放上限截断，其余留待下批）',
})

export function batchReleaseCeilingOf(contextWindow) {
  const window = Number(contextWindow)
  if (!Number.isFinite(window) || window <= 0) return MAX_BATCH_RELEASE_TOKENS
  const ceiling = Math.floor(window * MAX_BATCH_RELEASE_WINDOW_RATIO)
  // 下限防止极小窗口算出「一批什么都放不下」。
  return Math.max(4096, ceiling)
}

/** Recall digest bounds. */
export const MAX_RECALL_QUERY_CHARS = 800
export const MAX_RECALL_HITS = 5
export const MAX_RECALL_DIGEST_CHARS = 1200
export const MAX_PREVIEW_CHARS = 700

/**
 * 本插件自己注入的 `user/message` 的来源标记。
 *
 * 回执、恢复回执与工作状态卡都以 `role: 'user'` 的事件出现在活动面上，早期版本
 * 把它们的 `source.kind` 一律写成 `'user'`，于是所有「最新人类请求」的判定都被
 * 插件自己的消息占满（审计 P0-3）。现在写入端带上 `form`，读取端据来源判定。
 */
/**
 * 本插件注入消息的 `source.kind`（0.13.0 F8）。
 *
 * 修复前一律写 `'user'`，于是**宿主侧**所有按 `source.kind === 'user'` 取人类输入的
 * 功能都把这些消息当成人类输入。已取证的宿主消费点（app.asar 源码核对）：
 *   - `dsh-session-title`：标题生成把归档回执当人类消息（实测 seq 162 的
 *     messageSeqs 是 [31, 155, 157, 159]，后三条全是回执）；
 *   - `dsh-session-turn-outline`：轮次大纲用回执填「本轮提问」预览；
 *   - `dsh-session-reference` / `dsh-web-deepseek-api`：prompt 推导与引用面；
 *   - `dsh-client-ui-chat`：非 `'user'` 的 kind 走 `contextProducer` 默认分支，
 *     渲染成 `role:'inject'`——比冒充用户气泡诚实。
 *
 * `dsh-session` 的 `user/message` 不变量对 `source.kind` **无约束**（已核对
 * `lib/types/invariant.js`），所以改这个值不会让日志打不开。
 *
 * 兼容：旧日志里仍然是 `kind:'user'` + `form`，读取端继续按 `form` 识别
 * （见 {@link isPluginAuthoredMessage}），不依赖 kind。
 */
export const PLUGIN_SOURCE_KIND = 'dsh-memory-context-lab'

export const PLUGIN_SOURCE_FORMS = Object.freeze({
  ARCHIVE_RECEIPT: 'archive-receipt',
  ARCHIVE_RESTORE: 'archive-restore',
  WORKING_STATE: 'working-state',
  // 卡片写入端（index.mjs）历史用过的形态，保留识别，避免旧日志被当成人类输入。
  WORKING_SET: 'working-set',
  // 自动回注包同样是插件自己注入的 user/message，不能占人类请求的位置。
  RECALL: 'recall',
  // 活动面上的程序替换节点：聚合凭证、卡组折叠回执、遗忘墓碑。它们都以
  // `kind: 'user'` + 本形态出现在活动面上，但正文是插件生成的，不是人类输入；
  // 不登记就会被「最新人类请求」判定当成任务陈述（0.11.0 缺陷修复）。
  //
  // 0.13.1 保留旧字面量 `memory-lab2-surface`：它是**日志里的历史形态值**，
  // 改名会让 0.13.0 及更早写下的表面节点重新被当成人类输入。命令已改名为
  // `/memory-lab`，但形态标识符不随命令改名——形态是数据契约，命令是界面。
  SURFACE_RECEIPT: 'memory-lab2-surface',
})

const PLUGIN_SOURCE_FORM_SET = new Set(Object.values(PLUGIN_SOURCE_FORMS))

/**
 * True when one `user/message` was injected by this plugin itself.
 *
 * 两条独立判据取或：新写入路径的 `source.form` 标记，以及旧日志里只能靠正文
 * 标记辨认的回执。旧版把回执写成 `source.kind: 'user'`，无法回溯改来源，所以
 * 正文标记必须一起看，否则升级后旧会话里的回执仍会被当成人类请求。
 */
export function isPluginAuthoredMessage(eventOrMessage) {
  const message = unwrapEvent(eventOrMessage)
  if (!message || typeof message !== 'object') return false
  const source = message.source
  if (source && typeof source === 'object' && typeof source.form === 'string'
    && PLUGIN_SOURCE_FORM_SET.has(source.form)) {
    return true
  }
  return isReceiptMessage(message)
}

function unwrapEvent(eventOrMessage) {
  return eventOrMessage && typeof eventOrMessage === 'object' && eventOrMessage.data
    && typeof eventOrMessage.data === 'object' && eventOrMessage.type !== undefined
    ? eventOrMessage.data
    : eventOrMessage
}

/**
 * True only for a message the **human** authored.
 *
 * 判据是来源而不是「它是不是最新一条 user/message」：
 * - `source.form` 命中插件标记 → 不是人类输入（新写入路径）；
 * - 正文首行是回执标记 → 不是人类输入（旧版已经写进日志的回执，无法回溯改来源）；
 * - `source.kind === 'user'` 且以上都不成立 → 人类输入。
 *
 * 入参既可以是 `{ type, data }` 事件，也可以是裸的 message 对象（`data`），
 * 这样卡片、最小依赖集、候选保护与召回触发可以共用同一个判定。
 */
export function isHumanAuthoredMessage(eventOrMessage) {
  const message = unwrapEvent(eventOrMessage)
  if (!message || typeof message !== 'object') return false
  const source = message.source
  if (!source || typeof source !== 'object') return false
  if (source.kind !== 'user') return false
  return !isPluginAuthoredMessage(message)
}

/**
 * Cold-node id for one chunk of an archived operation.
 *
 * Every operation uses the numbered form, including single-chunk ones, so
 * restore has exactly one naming rule to follow.
 */
export function archiveChunkNodeId(baseNodeId, index) {
  return `${baseNodeId}_p${index + 1}`
}

/**
 * Split an archived body into cold nodes that can each be read back whole.
 *
 * Chunks are cut on a code-point boundary — never inside a multi-byte character
 * — and `chunks.join('')` reproduces the input exactly. Cutting on *lines* alone
 * is not enough: a tool call's arguments are single-line JSON, and a minified
 * file read is one enormous line, so a line-based splitter would emit an
 * oversized chunk exactly for the bodies that most need splitting and then fail
 * the read-back check. A character wider than the whole budget is therefore
 * still emitted, on its own, rather than dropped.
 *
 * @returns an array of chunk strings; empty input yields no chunks.
 */
export function chunkArchiveBody(body, maxBytes = MAX_OPERATION_BYTES, maxLines = MAX_OPERATION_LINES) {
  const text = String(body ?? '')
  if (!text) return []
  const chunks = []
  let current = ''
  let currentBytes = 0
  let currentLines = 0
  const flush = () => {
    if (current === '') return
    chunks.push(current)
    current = ''
    currentBytes = 0
    currentLines = 0
  }
  for (const char of text) {
    const charBytes = Buffer.byteLength(char, 'utf8')
    const overBytes = currentBytes + charBytes > maxBytes
    const overLines = char === '\n' && currentLines >= maxLines
    if (current !== '' && (overBytes || overLines)) flush()
    current += char
    currentBytes += charBytes
    if (char === '\n') currentLines += 1
  }
  flush()
  return chunks
}

/**
 * Generate cold-store text that is clear about provenance without changing
 * payload bytes. The payload is always the last section after a blank line, so
 * `coldRecordBody` recovers the original bytes exactly.
 */
export function coldRecordContent({ sessionId, range, tools, callIds, text, contentHash, chunk, chunkCount }) {
  const lines = [
    '# 上下文降温归档',
    `- session: ${sessionId}`,
    `- surface_range: ${range.start}–${range.end}`,
    `- tools: ${tools.join(', ') || '(unknown)'}`,
    `- call_ids: ${callIds.join(', ') || '(none)'}`,
  ]
  if (Number.isInteger(chunk) && Number.isInteger(chunkCount)) lines.push(`- chunk: ${chunk}/${chunkCount}`)
  if (contentHash) lines.push(`- content_sha256: ${contentHash}`)
  lines.push('- policy: injected only on a matching question; never auto-injected whole', '', text)
  return lines.join('\n')
}

/** Recover the archived payload bytes from a stored cold record. */
export function coldRecordBody(content) {
  const text = String(content ?? '')
  const separator = text.indexOf('\n\n')
  return separator === -1 ? '' : text.slice(separator + 2)
}

/**
 * Undo the isolated store's one appended trailing newline.
 *
 * The store appends exactly one `\n` to a node's content (verified against
 * `@furongjun1999/dsh-memory@0.8.1`), so exactly one must be removed. Stripping
 * *all* trailing newlines would silently truncate any body that legitimately
 * ends with a blank line, and the round-trip hash check would then either fail
 * or — worse — pass against a body that no longer matches what was archived.
 */
export function normalizeColdBody(content) {
  const text = String(content ?? '')
  return text.endsWith('\n') ? text.slice(0, -1) : text
}

/**
 * Render the replacement receipt.
 *
 * It is a pure function of stable identifiers, contains zero original body
 * bytes, and embeds no timestamp or dynamic statistic, so repeated runs produce
 * byte-identical text and do not disturb prefix caching.
 *
 * Format 2 adds deterministic locator metadata (C-13「原文回执可定位」): for each
 * call, the object it acted on and the status its result reported. Both are read
 * straight off the call arguments and result text — no model, no summary — and
 * the status is labelled as the *tool's* return status so an `exit 0` is never
 * read as "the user's goal is complete".
 *
 * `formatVersion` exists so that receipts already written in format 1 stay
 * byte-reproducible for restore; new archives use {@link RECEIPT_FORMAT_VERSION}.
 * v2 的跨度回执（{@link buildSpanReceipt}）与不带 locators 的调用（两个附加行
 * 整体省略）不因格式版本而变化，输出与既有字节一致。
 */
// ---------------------------------------------------------------- 投影头（P5-3）

/**
 * 投影失真等级。**只有 A 类**：原文在冷库、append-only 日志仍在、可逐字节重建。
 *
 * B 类（不可重建）在本项目里**禁止出现**（v1.2 P5-2 / 本项目「不做 B 类有损投影」）：
 * 本函数对任何非 A 类输入直接抛错，把「本来就对」写成可执行的不变量，而不是注释。
 */
export const PROJECTION_KIND = Object.freeze({ EXACT: 'A' })

/** 投影头一行的字符上限（不含换行）。超出说明我们把正文塞进了头部。 */
export const PROJECTION_HEADER_MAX_CHARS = 120

/**
 * 投影头：**率与失真同时声明**（灵枢统一架构 v1.2 P5-3）。
 *
 * 形状（纯函数、无时间戳、逐字节确定）：
 *
 *     投影：A 类（可完整重建）｜释放 ≈3968 token / 15805 字｜取回 ≈1200 token
 *
 * - 释放 = 原文估算 token − 回执估算 token（归档行已算过，这里只做渲染）；
 * - 取回 = 冷库载荷已有的 token 估算（originalTokens），**不新增计算**；
 * - 拿不到取回估算时如实省略该段，不猜一个数。
 */
export function buildProjectionHeader({
  kind = PROJECTION_KIND.EXACT,
  releasedTokens = 0,
  releasedChars = 0,
  readbackTokens = null,
} = {}) {
  if (kind !== PROJECTION_KIND.EXACT) {
    throw new InvalidArgumentError('投影失真等级只能是 A 类（可完整重建）；B 类有损投影被禁止（收到 '
      + JSON.stringify(kind) + '）')
  }
  const released = Math.max(0, Math.trunc(Number(releasedTokens) || 0))
  const chars = Math.max(0, Math.trunc(Number(releasedChars) || 0))
  const head = '投影：' + kind + ' 类（可完整重建）'
  const release = '释放 ≈' + released + ' token / ' + chars + ' 字'
  // null / undefined 表示「没有这个估算」，必须如实省略；Number(null) === 0，
  // 不显式挡掉就会被渲染成「取回 ≈0 token」——那是编造。
  const readback = readbackTokens === null || readbackTokens === undefined ? Number.NaN : Number(readbackTokens)
  const hasReadback = Number.isFinite(readback) && readback >= 0
  const full = [head, release, hasReadback ? '取回 ≈' + Math.trunc(readback) + ' token' : null]
    .filter((part) => part !== null).join('｜')
  // 上限是硬约束：超出时先丢取回段（它同时也出现在「可回读」行），再丢字数列。
  if (full.length <= PROJECTION_HEADER_MAX_CHARS) return full
  const shorter = head + '｜' + release
  if (shorter.length <= PROJECTION_HEADER_MAX_CHARS) return shorter
  return head + '｜释放 ≈' + released + ' token'
}

/**
 * 工具结果的 status 行（0.12.0 P1-5）：ok / fail / partial，失败附首错行。
 *
 * 数据源是归档时已经算好的 `statuses`（`apply.mjs` 一直在算、v2 侧一直没渲染），
 * 以及收集器从结果正文里取到的首错行——**不改写原文**，只取首行并截断。
 */
export function receiptStatusOf({ statuses = [], errorLine = null, spanKind = null } = {}) {
  const list = (Array.isArray(statuses) ? statuses : []).filter((value) => typeof value === 'string' && value !== '')
  if (list.length === 0) {
    // 非工具结果（普通历史段、旧卡、回注包）：不硬造 status，如实标 kind=message。
    return typeof spanKind === 'string' && spanKind !== '' ? 'kind=message' : null
  }
  const failed = list.filter((status) => /(?:^|\s)error\b|exit\s*[1-9]/i.test(status))
  const verdict = failed.length === 0 ? 'ok' : failed.length === list.length ? 'fail' : 'partial'
  const firstError = typeof errorLine === 'string' && errorLine.trim() !== '' ? clipErrorLine(errorLine) : null
  return verdict === 'ok' || firstError === null
    ? 'status=' + verdict
    : 'status=' + verdict + '（首错：' + firstError + '）'
}

/** 首错行：单行、≤200 字符，超长截断并显式标出被截断。 */
export function clipErrorLine(text, limit = 200) {
  const single = String(text ?? '').split(/\r?\n/).map((line) => line.trim()).find((line) => line !== '') ?? ''
  if (single.length <= limit) return single
  return single.slice(0, limit) + '…（截断）'
}

/**
 * 「可回读」两行：首行是**工具调用形式**（模型照抄即可），第二行是命令面（给人）。
 *
 * 0.12.0 P0-1 的核心：回读工具存在、系统提示也写了，但真实会话 303 步里调用 0 次——
 * 因为回执只写「正文已沉入冷库」，从不把「用哪个动作、拿哪个 ID、花多少钱」推到
 * 模型眼前。命令面提示降到第二行，不删（人还要用）。
 */
export function receiptReadbackLines(nodeId) {
  const id = typeof nodeId === 'string' ? nodeId : ''
  return [
    '可回读：memory_lab_recall(record_ids=["' + id + '"])｜A 类可完整重建',
    '命令面：/memory-lab read ' + id,
  ]
}

/**
 * slim 版回读行（Z-01）：单行、可照抄，仍是**工具调用形态**（0.12.0 P0-1 的
 * 教训是回读动作必须推到模型眼前——压缩掉的是「第二行命令面给人看的重复」，
 * 不是动作本身）。
 */
export function receiptReadbackSlimLine(nodeId) {
  const id = typeof nodeId === 'string' ? nodeId : ''
  return 'read: memory_lab_recall(record_ids=["' + id + '"])'
}

export function buildReceipt({
  tools,
  range,
  callIds,
  nodeId,
  hash,
  chars,
  tokens,
  chunks = 1,
  marker = RECEIPT_MARKER,
  formatVersion = RECEIPT_FORMAT_VERSION,
  locators = [],
  statuses = [],
  recordIds = [],
  // 0.12.0：投影经济学所需的既有字段（都不新增计算）。releasedTokens 是原文载荷的
  // token 估算（≈ 回执替换掉的那部分），不是「原文 − 回执」的净值——净值依赖回执
  // 自身的 token 数，会让回执渲染自指。
  releasedTokens = null,
  errorLine = null,
}) {
  const known = [RECEIPT_FORMAT_LEGACY, 2, RECEIPT_FORMAT_VERSION, RECEIPT_FORMAT_OPERATION, RECEIPT_FORMAT_OPERATION_SLIM]
  // 显式 dispatch（0.10.1 S2c）：每个历史版本一个冻结分支，未知版本失败关闭。
  if (!known.includes(formatVersion)) {
    throw new InvalidArgumentError(`未知的回执格式版本：${JSON.stringify(formatVersion)}（已知 1/2/4/6/9；批次摘要走 buildBatchReceipt，片段回执走 buildSpanReceipt）`)
  }
  const modern = formatVersion === RECEIPT_FORMAT_OPERATION || formatVersion === RECEIPT_FORMAT_OPERATION_SLIM
  // Z-01 slim：read: 单行 + 删 hash 行（旧版本逐字节不变）。
  const slim = formatVersion === RECEIPT_FORMAT_OPERATION_SLIM
  const lines = [marker]
  if (modern) {
    // P5-3：率与失真同时声明。取回代价直接取冷库载荷的既有 token 估算。
    lines.push(buildProjectionHeader({
      releasedTokens: releasedTokens === null ? tokens : releasedTokens,
      releasedChars: chars,
      readbackTokens: tokens,
    }))
  }
  lines.push(
    `工具：${tools.join('、') || '(unknown)'}`,
    `来源：seq ${range.start}–${range.end}（${callIds.length} 次调用，原 ≈${tokens} token / ${chars} 字）`,
  )
  if (formatVersion >= 2) {
    const located = locators.length ? formatLocatorLine(tools, callIds, locators) : ''
    if (located) lines.push(located)
    const statusLine = formatStatusLine(tools, callIds, statuses)
    if (statusLine) lines.push(statusLine)
    if (modern) {
      const status = receiptStatusOf({ statuses, errorLine })
      if (status) lines.push(status)
    }
  }
  lines.push(`冷记录：${nodeId}`)
  if (modern) {
    lines.push(...(slim ? [receiptReadbackSlimLine(nodeId)] : receiptReadbackLines(nodeId)))
  } else if (formatVersion === RECEIPT_FORMAT_VERSION) {
    const ids = (Array.isArray(recordIds) ? recordIds : []).filter((id) => typeof id === 'string' && id.length > 0)
    if (ids.length > 0) {
      lines.push(`记录 ID：${ids.join('、')}`)
    } else {
      lines.push(`记录 ID：按 ${nodeId} 别名回读（/memory-lab read ${nodeId}）`)
    }
  }
  if (chunks > 1) lines.push(`分块：${chunks} 段（恢复时按序拼接）`)
  if (!modern) {
    // 旧格式的这句「会自动回注要点」在真实会话里一次都没兑现过，而且不给取回代价；
    // 新格式用「可回读」两行取代它，不再重复声明。
    lines.push('正文已沉入本会话隔离冷库；相关提问会自动回注要点。')
  }
  if (!slim) lines.push(`hash：${String(hash ?? '').slice(0, 12)}`)
  return lines.join('\n')
}

/**
 * Render one batch-summary receipt for several adjacent archived operations (P1-5).
 *
 * 一批 N 个相邻操作的逐条模板回执是每批重复注入同一批样板（实测 ≈185k token/会话）；
 * 合并成一条摘要后，每条成员行只保留模型恢复与回读所需的稳定标识（范围、冷记录、
 * hash、分块），省掉 N−1 份样板头尾。它是**纯函数**：输入只含恢复所需的稳定字段
 * （与归档行一一对应），无时间戳、无动态统计、无原文正文字节，重复渲染字节一致，
 * 不扰动前缀缓存。恢复侧按同一函数从归档行重建期望正文（见 `restoreReceipts`）。
 *
 * `members` 每项：`{ tools, range: {start,end}, callIds, nodeId, hash, chars,
 * tokens, chunks }`——正是归档行已记录的字段，恢复侧无需额外信息。
 */
export function buildBatchReceipt({ members, marker = RECEIPT_MARKER, batchThreshold = null, batchMembers = null, releaseCapped = false, formatVersion = RECEIPT_FORMAT_BATCH_V2, runLength = null }) {
  const rows = Array.isArray(members) ? members : []
  // `runLength` 是**本段相邻成员数**（原文写入时的值）。恢复时可能只重建组内
  // 一个成员（BUG-010 的部分恢复），此时 rows.length 会小于原文写的段长，
  // 直接用它渲染必然对不上。默认取 rows.length，恢复侧从归档行取原值。
  const runSize = Number.isInteger(runLength) && runLength > 0 ? runLength : rows.length
  // format 3 的渲染**冻结**：0.13.0 及更早写下的批次回执必须逐字节可重建。
  if (formatVersion === RECEIPT_FORMAT_BATCH) {
    const legacyLines = [
      marker,
      `批次归档：${rows.length} 个相邻操作已合并替换；正文已沉入本会话隔离冷库，相关提问会自动回注要点。`,
    ]
    for (const [index, member] of rows.entries()) {
      const tools = Array.isArray(member.tools) ? member.tools : []
      const range = member.range ?? { start: 0, end: 0 }
      const callIds = Array.isArray(member.callIds) ? member.callIds : []
      const chunks = Number.isInteger(member.chunks) && member.chunks > 0 ? member.chunks : 1
      const label = tools.length > 0 ? tools.join('、') : '历史片段'
      let line = `- #${index + 1} ${label}：seq ${range.start}–${range.end}`
        + `（${callIds.length} 次调用，原 ≈${member.tokens ?? 0} token / ${member.chars ?? 0} 字）`
        + ` 冷记录 ${member.nodeId ?? '(unknown)'} hash ${String(member.hash ?? '').slice(0, 12)}`
      if (chunks > 1) line += `（分块 ${chunks} 段）`
      legacyLines.push(line)
    }
    legacyLines.push('恢复：/memory-lab restore 或 /memory-lab 恢复流程会把本条摘要连同全部成员原文一并还原。')
    return legacyLines.join('\n')
  }
  // 0.13.1（F2/F3）：批次口径必须可审计。
  //
  // 旧文案只有一个「N 个相邻操作」——那个 N 是**相邻段长度**，不是本批操作数，
  // 也不是配置阈值。实测会话 c1787f24 里配置 batch=10，回执却出现 6/3/2/4/1，
  // 事后审计完全看不出「阈值 10 确实生效了 5 次，另有 2 次被单批释放上限截断」。
  //
  // 现在三个数分开写：阈值（配置）、本批成员数（实际提交）、本段相邻数（本回执）。
  // 被上限截断时如实说明还剩多少留待下批。
  const threshold = Number.isInteger(batchThreshold) && batchThreshold > 0 ? batchThreshold : null
  const total = Number.isInteger(batchMembers) && batchMembers > 0 ? batchMembers : rows.length
  // 三个数各说各的：阈值（配置）、本批成员（整批）、本段相邻（本条回执）。
  // 三者相等时省略冗余，只报一次，避免短文案里出现「本批 4/4；本条覆盖 4 个」。
  const head = threshold && total !== runSize
    ? `批次归档：本批 ${total}/${threshold} 个操作${releaseCapped ? '（单批释放上限截断，其余留待下批）' : ''}；本条回执覆盖其中相邻的 ${runSize} 个。`
    : threshold
      ? `批次归档：本批 ${total}/${threshold} 个操作${releaseCapped ? '（单批释放上限截断，其余留待下批）' : ''}。`
      : `批次归档：${runSize} 个相邻操作已合并替换。`
  const lines = [
    marker,
    `${head}正文已沉入本会话隔离冷库，相关提问会自动回注要点。`,
  ]
  for (const [index, member] of rows.entries()) {
    const tools = Array.isArray(member.tools) ? member.tools : []
    const range = member.range ?? { start: 0, end: 0 }
    const callIds = Array.isArray(member.callIds) ? member.callIds : []
    const chunks = Number.isInteger(member.chunks) && member.chunks > 0 ? member.chunks : 1
    const label = tools.length > 0 ? tools.join('、') : '历史片段'
    let line = `- #${index + 1} ${label}：seq ${range.start}–${range.end}`
      + `（${callIds.length} 次调用，原 ≈${member.tokens ?? 0} token / ${member.chars ?? 0} 字）`
      // Z-01 slim：成员行不印 hash 尾巴（冷记录 id 已足够回读定位）。
      + ` 冷记录 ${member.nodeId ?? '(unknown)'}${formatVersion === RECEIPT_FORMAT_BATCH_SLIM ? '' : ` hash ${String(member.hash ?? '').slice(0, 12)}`}`
    if (chunks > 1) line += `（分块 ${chunks} 段）`
    lines.push(line)
  }
  lines.push('恢复：/memory-lab restore 或 /memory-lab 恢复流程会把本条摘要连同全部成员原文一并还原。')
  return lines.join('\n')
}

/** Keys worth quoting as an operation's object, in descending usefulness. */
const LOCATOR_KEYS = ['file_path', 'path', 'file', 'filename', 'pattern', 'glob', 'command', 'query', 'url', 'node_id', 'id', 'name']

/**
 * Deterministically extract the object one tool call acted on.
 *
 * Only the call's own arguments are consulted, and only literal scalar fields —
 * so the locator is stable across runs (prefix-cache safe) and never invents an
 * interpretation. Unparsable arguments fall back to their first short token.
 */
export function extractCallLocator(call, limit = 60) {
  const raw = typeof call?.arguments === 'string' ? call.arguments : ''
  if (!raw) return ''
  let parsed = null
  try {
    parsed = JSON.parse(raw)
  } catch {
    parsed = null
  }
  if (parsed && typeof parsed === 'object') {
    for (const key of LOCATOR_KEYS) {
      const value = parsed[key]
      if (typeof value === 'string' && value.trim()) return clipLocator(value, limit)
      if (typeof value === 'number' && Number.isFinite(value)) return clipLocator(String(value), limit)
    }
    // No known key: fall back to the first literal scalar in declaration order.
    for (const value of Object.values(parsed)) {
      if (typeof value === 'string' && value.trim()) return clipLocator(value, limit)
      if (typeof value === 'number' && Number.isFinite(value)) return clipLocator(String(value), limit)
    }
    return ''
  }
  return clipLocator(raw, limit)
}

function clipLocator(value, limit) {
  const text = String(value).replace(/\s+/g, ' ').trim()
  return truncateCodePoints(text, limit)
}

function formatLocatorLine(tools, callIds, locators) {
  const parts = []
  for (let index = 0; index < locators.length; index += 1) {
    const locator = locators[index]
    if (!locator) continue
    const tool = tools[index] ?? 'unknown'
    const callId = callIds[index] ? `#${String(callIds[index]).slice(0, 24)}` : ''
    parts.push(`${tool}${callId} → ${locator}`)
    if (parts.length >= 3) break
  }
  return parts.length ? `对象：${parts.join('；')}` : ''
}

/**
 * Deterministically read the status a tool result reported.
 *
 * This is *data about the tool return*, not a judgement about the task: `exit 0`
 * means the process exited zero, and the rendered line says so.
 */
export function resultStatusOf(text) {
  const source = String(text ?? '')
  const exit = /(?:exit code|退出码)\s*[:：]?\s*(\d{1,3})/i.exec(source)
  if (exit) return `exit ${exit[1]}`
  if (/"?(?:isError|is_error)"?\s*[:]\s*true/i.test(source)) return 'error'
  // 0.13.2-beta.6 G3：三态。此前这里直接返回 'ok'，把「没看到失败」写成了
  // 「看到成功」——read / edit / MCP 这类不带 exit code、也不带 isError 的结果
  // （含空正文、Python 异常栈）于是全部被记成成功。这是「未知量没有三态」根因组
  // 在回执层的表现：一个恒 false 的比较被当成了否定结论。
  //
  // 字节影响面（实测，非推测）：本函数的返回值进 statuses 数组。
  // - format 5/6/7/8 走 receiptStatusOf，它只把匹配 error / exit[1-9] 的算失败，
  //   'unknown' 与 'ok' 同属「非失败」，verdict 仍是 ok → 字节不变。
  // - format 2 的「返回状态：tool#id=ok」会变成 =unknown（该行本就逐条列状态，
  //   是如实披露，不是格式变化）。
  // 回执层面的 status=ok 仍把「未知」读成「成功」——那要开新格式号才能改，
  // 见 修复计划-beta.6 的「不修」节。
  return 'unknown'
}

function formatStatusLine(tools, callIds, statuses) {
  const parts = []
  for (let index = 0; index < statuses.length; index += 1) {
    const status = statuses[index]
    if (!status) continue
    const tool = tools[index] ?? 'unknown'
    const callId = callIds[index] ? `#${String(callIds[index]).slice(0, 24)}` : ''
    parts.push(`${tool}${callId}=${status}`)
    if (parts.length >= 3) break
  }
  return parts.length ? `返回状态：${parts.join('、')}（工具返回状态，不代表用户目标已完成）` : ''
}

/**
 * 普通历史段（非工具操作）的回执。
 *
 * 与工具操作回执的关键差别：**不印「工具」「N 次调用」**——普通 user/assistant
 * 正文、旧回执、旧状态卡、旧召回包根本没有工具调用，套用操作回执等于对模型谎称
 * 那里发生过一次工具操作。格式仍是稳定 ID 的纯函数，不含时间戳与动态统计。
 */
/**
 * Soft-forget tombstone receipt（0.10.0 P2）。
 *
 * 主动遗忘把表面上的原回执替换成这块墓碑：seq 范围与冷记录指针保留（审计与
 * undo 的结构依据），但正文指针被明确宣告「已软遗忘、不再回注」。以
 * V2_RECEIPT_MARKER 开头，全历史模式的凭证收集器因此天然把它计入不可压缩
 * 凭证——遗忘不是删除，冷库原文与 append-only 日志都在。
 *
 * 逐字节确定：同样入参永远得到同样文本，供对账与「重建后比对再替换」的
 * 撤回/恢复路径使用。
 */
export function buildForgetTombstone({ range, nodeId, hash, reason = null }) {
  const lines = [
    V2_RECEIPT_MARKER,
    '本段已按用户指令软遗忘（在本插件记忆中停用）。',
    `来源：seq ${range.start}–${range.end}`,
    `冷记录：${nodeId}`,
  ]
  if (reason) lines.push(`缘由：${reason}`)
  lines.push(
    '撤销遗忘：/memory-lab forget undo <操作ID>；恢复原文回注仍需显式 restore。',
    '冷库原文与审计日志保留（软遗忘不是物理删除）；隔离灵枢检索侧可能仍有残留，见 /memory-lab forget status。',
    `hash：${String(hash ?? '').slice(0, 12)}`,
  )
  return lines.join('\n')
}

export function buildSpanReceipt({
  label,
  range,
  nodeId,
  hash,
  chars,
  tokens,
  chunks = 1,
  marker = RECEIPT_MARKER,
  // 0.12.0：默认仍是 format 5（旧行逐字节可重建）；新写入显式传 format 7。
  formatVersion = RECEIPT_FORMAT_SPAN,
  releasedTokens = null,
  errorLine = null,
}) {
  const known = [RECEIPT_FORMAT_SPAN, RECEIPT_FORMAT_SPAN_V2, RECEIPT_FORMAT_SPAN_SLIM]
  if (!known.includes(formatVersion)) {
    throw new InvalidArgumentError(`未知的片段回执格式版本：${JSON.stringify(formatVersion)}（已知 5/7/10）`)
  }
  const modern = formatVersion === RECEIPT_FORMAT_SPAN_V2 || formatVersion === RECEIPT_FORMAT_SPAN_SLIM
  // Z-01 slim：read: 单行 + 删 hash 行（旧版本逐字节不变）。
  const slim = formatVersion === RECEIPT_FORMAT_SPAN_SLIM
  const lines = [marker]
  if (modern) {
    lines.push(buildProjectionHeader({
      releasedTokens: releasedTokens === null ? tokens : releasedTokens,
      releasedChars: chars,
      readbackTokens: tokens,
    }))
  }
  lines.push(
    `片段：${label || '历史片段'}`,
    `来源：seq ${range.start}–${range.end}（原 ≈${tokens} token / ${chars} 字）`,
  )
  if (modern) {
    const status = receiptStatusOf({ statuses: [], errorLine, spanKind: 'span' })
    if (status) lines.push(status)
  }
  lines.push(`冷记录：${nodeId}`)
  if (modern) lines.push(...(slim ? [receiptReadbackSlimLine(nodeId)] : receiptReadbackLines(nodeId)))
  if (chunks > 1) lines.push(`分块：${chunks} 段（恢复时按序拼接）`)
  if (!modern) lines.push('正文已沉入本会话隔离冷库；相关提问会自动回注要点。')
  if (!slim) lines.push(`hash：${String(hash ?? '').slice(0, 12)}`)
  return lines.join('\n')
}

/**
 * Tokens a restore would ADD to the surface, and whether that overflows.
 *
 * Restoring swaps each receipt for the original it replaced, so the growth is
 * (original - receipt): the receipt tokens are already inside the measured
 * assembly. Counting the full original instead double-counts that share and
 * refuses restores that would have fit, pushing the user to delete the session
 * -- the opposite of the guard's purpose.
 *
 * ## 未知量（0.13.2-beta.6 G3）
 *
 * 旧实现有三处失败开放，全部来自「拿未知量做比较」：
 *
 * 1. `overflow: assembledTokens + growth > contextWindow` —— 两个参数任一缺失时
 *    `number > undefined` / `NaN > x` 恒 false，于是**判不了就当成没超窗**，
 *    恢复照做。这正是 Q-01 修好的那条窗口守卫，又从这里漏出去。
 *    同文件 `batchReleaseCeilingOf` 对同一个未知量明确失败关闭，两处口径相反。
 * 2. `Number(row?.originalTokens) || 0` —— 缺失的原文量被当成 0，增长被**系统性
 *    低估**，守卫放过本该拒绝的恢复。
 * 3. 没有任何字段告诉调用方「这个结论不可靠」。
 *
 * 现在：`overflow` 是**三态**，任一必需量未知即 `'unknown'`（调用方必须按
 * 失败关闭处理）；`unknown` 布尔位与 `unknownRows` 计数如实披露有多少行
 * 缺原文量；`total` 只累加**已知**的行，不再用 0 冒充。
 *
 * @returns {{ total: number, heldByReceipts: number, growth: number,
 *            overflow: boolean|'unknown', unknown: boolean, unknownRows: number,
 *            unknownReasons: string[] }}
 */
export function restoreGrowth(pending, { assembledTokens, contextWindow } = {}) {
  const rows = Array.isArray(pending) ? pending : []
  const unknownReasons = []
  let total = 0
  let heldByReceipts = 0
  let unknownRows = 0
  for (const row of rows) {
    const original = row?.originalTokens
    const receipt = row?.receiptTokens
    // 缺 originalTokens 的行只**披露**、不参与「判不了就拒绝」：0.12 之前的旧回执
    // 行本来就没有这个字段，若按 unknown 失败关闭，全部历史数据都永远恢复不了
    // ——那正是本文档开头警告的「守卫拒绝本可以放下的恢复」。故按 0 计入下界
    // （增长只会被低估），同时用 unknownRows/unknownReasons 如实告诉调用方。
    if (isKnownNumber(original)) total += original
    else unknownRows += 1
    // receiptTokens 缺失时按 0 计是**安全方向**：增长只会被高估（更保守），
    // 不会被低估。这一点与 originalTokens 相反，所以两处口径不同。
    if (isKnownNumber(receipt)) heldByReceipts += receipt
  }
  const growth = total - heldByReceipts
  const assembledKnown = isKnownNumber(assembledTokens)
  const windowKnown = isKnownNumber(contextWindow)
  if (!assembledKnown) unknownReasons.push('assembledTokens')
  if (!windowKnown) unknownReasons.push('contextWindow')
  if (unknownRows > 0) unknownReasons.push('originalTokens')
  let overflow
  if (!assembledKnown || !windowKnown) {
    // 判不了超没超窗。**失败关闭**：调用方必须当作「可能超窗」处理。
    overflow = TRI_STATE.UNKNOWN
  } else if (unknownRows > 0) {
    // 有行缺原文量 → growth 只是下界。下界已经超窗就直接判 true（结论仍然成立）；
    // 下界没超时**不**升级成 unknown：拒绝会锁死旧数据，而这里的缺口方向已知
    // （只可能低估），披露在 unknown/unknownRows 里由调用方决定要不要更保守。
    overflow = assembledTokens + growth > contextWindow
  } else {
    overflow = assembledTokens + growth > contextWindow
  }
  return {
    total,
    heldByReceipts,
    growth,
    overflow,
    // `unknown` 的口径是「本次判定**涉及**未知量」，不是「结论未知」：
    // 即使下界已经足以判定超窗（overflow=true），「有一行的原文量我们不知道」
    // 这件事仍然必须披露——调用方据此才能判断这个结论的可靠边界。
    unknown: unknownReasons.length > 0,
    unknownRows,
    unknownReasons,
  }
}

/**
 * 窗口守卫的**唯一**判据（0.13.2-beta.6 G3）。
 *
 * `overflow === true` 拒绝，`'unknown'` 也拒绝——「判不了」与「超了」在
 * 用户可见后果上是同一件事（都可能顶穿窗口），区别只在回执文案。把这条
 * 收成一个函数，是为了让每个调用点都**必须**做同一个决定，而不是各自
 * 写 `if (growth.overflow)`（那样 `'unknown'` 会被当成假值放行）。
 */
export function windowGuardRefuses(growth) {
  return growth?.overflow === TRI_STATE.TRUE || growth?.overflow === TRI_STATE.UNKNOWN
}

/**
 * Truncate to a budget counted in CODE POINTS, not UTF-16 units.
 *
 * String.prototype.slice counts UTF-16 code units, so a cut that lands inside a
 * surrogate pair leaves a lone high surrogate: it renders as a replacement
 * character and, once written into a message, is a permanently broken sequence.
 * Counting with Array.from keeps emoji and any astral-plane character whole.
 */
export function truncateCodePoints(text, limit) {
  const value = String(text ?? '')
  if (value.length <= limit) return value
  const points = Array.from(value)
  if (points.length <= limit) return value
  return `${points.slice(0, Math.max(0, limit - 1)).join('')}…`
}

/**
 * P0-2（beta.9）预览层的推理段过滤（N-5：推理段不回灌）。
 *
 * buildOperationBody（v2/history.mjs）把助手推理块以 `[推理]` 段头写进操作正文；
 * 回注预览从正文头部取样，旧推理摘录就随预览重新回到模型面前（beta.6 会话实测）。
 * 本助手与 parseOperationBody（v2/evidence-atoms.mjs）同一**行级**切段约定
 * （`[推理]`/`[结果]`/`[失败结果]`/`[工具]` 段头；不按空行切段——参数 JSON
 * 里可能有空行），把 `[推理]` 段整段替换为一行说明。
 *
 * 边界：没有 `[推理]` 段头的文本原样返回（assistant.text 跨度的推理块没有段头，
 * 不冒认）；按 record id 的精确回读与装包走原文通道，不经这里。
 */
export const REASONING_SECTION_OMITTED_NOTE = '（推理段已省略，原文可按 id 回读）'

/** 分块续段预览的失败关闭占位：开头无法判定是否处于已省略段内（P0-2 补充）。 */
export const REASONING_CONTINUATION_NOTE = '（分块续段：起始无法判定是否处于已省略段内，原文可按 id 回读）'

export function skipReasonSection(text, { continuation = false } = {}) {
  const source = String(text ?? '')
  if (source.length === 0) return source
  const out = []
  let skipping = false
  // 分块续段（inline.chunk ≥ 2）的开头可能是 [推理] 段的中部——没有段头行，
  // 无法判定它是推理尾还是别的段正文。失败关闭：首个段头行之前的内容一律
  // 不进预览，用占位行如实披露；段头出现后照常走既有状态机。
  let continuationPending = continuation === true
  for (const line of source.split('\n')) {
    const trimmed = line.trim()
    const isSectionHead = trimmed === '[推理]' || trimmed === '[结果]' || trimmed === '[失败结果]' || trimmed.startsWith('[工具]')
    if (continuationPending) {
      // 披露在进入续段的第一行就给出：有界读可能把段头截掉（那时全块都
      // 是不可判定内容），绑在「遇到段头」上会让披露跟内容一起消失。
      out.push(REASONING_CONTINUATION_NOTE)
      continuationPending = false
      if (!isSectionHead) continue
    }
    if (trimmed === '[推理]') {
      skipping = true
      out.push(REASONING_SECTION_OMITTED_NOTE)
      continue
    }
    if (skipping) {
      if (trimmed === '[结果]' || trimmed === '[失败结果]' || trimmed.startsWith('[工具]')) {
        skipping = false
      } else {
        continue
      }
    }
    out.push(line)
  }
  return out.join('\n')
}

