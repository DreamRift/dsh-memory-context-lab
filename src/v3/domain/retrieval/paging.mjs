/**
 * 检索分页域（domain/retrieval，0.15.0 G1 / C-G1-05、C-G1-06、C-G1-07）。
 *
 * 旧缺陷（F01）：`toolSearch` 把 provider top-k 长度当 total，`cursor` 只是裸十进制
 * 偏移——不绑定 query/scope/会话/排序/快照，非法值静默回到第一页。这里把「分页」变成
 * 可验证的纯函数：
 *
 * - **游标只由本模块铸造**：格式 `v1.<scope>.<query>.<order>.<generation>.<r>.<m>.<session>.<checksum>`，
 *   偏移用 base36、摘要 16 位十六进制；长度上界 512（解析资源有界），
 *   `SEARCH_PAGE_MAX_OFFSET` 拒绝病态偏移（不让一次检索做无界排序）。
 * - **绑定维度**：schema 版本、query 摘要、scope、排序规则 id、快照代际、会话摘要。
 *   逐项比对失败即返回**具体错误码**（不清零、不回第一页、不跳页）——
 *   C-G1-05 与 C-M-04 的「宁可重查，不得错读」。
 * - **旧裸十进制游标**明确拒绝（`cursor-legacy-format`），不兼容读。
 * - 校验和只做**完整性/篡改可发现**（见下），不是安全边界：游标由模型可见、可复制，
 *   真正的保护是上列字段逐项与实际查询/会话/快照比对；伪造一个「同 query 别的偏移」
 *   会被校验和挡下，伪造整条游标最多得到一次同 query 的分页结果，不越权、不错读。
 * - `scope=all` 的单页额度由 `allocatePageSlots` 确定性分配（C-G1-06）：
 *   两个集合**分别**推进；两边都有剩余时各至少 1 条（limit=1 时按已消费偏移公平轮转），
 *   任一非空集合不会永久饥饿。
 *
 * 本模块是纯函数（无 IO、无时钟、无随机）：hash 由装配点注入（域层禁 node:crypto）。
 */
import { V3ContractViolation } from '../../contracts/errors.mjs'

/** 游标形态版本（C-M-04）：字段语义变化 +1，旧版本一律拒绝而不是猜读。 */
const CURSOR_VERSION = 'v1'

/** 游标最大长度（正常 ~110；上界只防病态输入）。 */
const CURSOR_MAX_CHARS = 512

/**
 * 校验和盐。**不是密钥**：它只让「手改一个字段」可被发现，不提供密码学不可伪造性
 * （游标里没有密钥材料，也不该有——它要进模型上下文）。
 */
const CURSOR_SALT = 'mcl-v3-search-cursor'

/**
 * 单页偏移/取窗上界：超过它说明游标被改过或调用方在病态翻页，失败关闭。
 * 同一上界也用于「一次取窗最多要看多少条」（records 的 r+limit、summaries 的固定窗口）。
 */
export const SEARCH_PAGE_MAX_OFFSET = 1000000

const SCOPE_CODE = Object.freeze({ records: 'r', summaries: 's', all: 'a' })
const CODE_TO_SCOPE = Object.freeze({ r: 'records', s: 'summaries', a: 'all' })

/** 排序规则 id：进入游标绑定，后端/排序一换就不能续读（C-G1-07）。 */
const ORDER_IDS = Object.freeze({
  records: 't1-bm25-score-desc-id-asc',
  summaries: 'summary-created-desc-append',
  all: 'interleave-records-summaries',
})

/** 非可分页后端（T2 top-k）的排序 id：让 T1 铸造的游标在这里显式不匹配。 */
const ORDER_UNPAGINATED = 'unpaginated-top-k'

const ORDER_CODE = Object.freeze({ records: 'o1', summaries: 'o2', all: 'o3' })
const CODE_TO_ORDER = Object.freeze({
  o1: ORDER_IDS.records,
  o2: ORDER_IDS.summaries,
  o3: ORDER_IDS.all,
})

const CURSOR_RE = /^v1\.([rsa])\.([0-9a-f]{16})\.(o[123])\.([0-9a-f]{16})\.([0-9a-z]{1,7})\.([0-9a-z]{1,7})\.([0-9a-f]{16})\.([0-9a-f]{16})$/
const LEGACY_RE = /^\d+$/
const VERSION_RE = /^v(\d+)\./
const DIGEST_RE = /^[0-9a-f]{16}$/

/**
 * 游标错误码（封闭集；render 层按码给模型可读的处理建议）。
 * 每个码都表示「本次没有返回任何一页」，绝不表示「没有更多结果」。
 */
export const SEARCH_CURSOR_ERRORS = Object.freeze({
  invalid: 'cursor-invalid',
  legacy: 'cursor-legacy-format',
  version: 'cursor-version-unsupported',
  query: 'cursor-query-mismatch',
  scope: 'cursor-scope-mismatch',
  order: 'cursor-order-mismatch',
  session: 'cursor-session-mismatch',
  stale: 'cursor-stale',
})

/** 当前 scope 的排序规则 id（非可分页后端传 false，得到显式不可续读的 id）。 */
export function orderIdOf(scope, paginable = true) {
  if (paginable !== true) return ORDER_UNPAGINATED
  return ORDER_IDS[scope] ?? ORDER_IDS.all
}

/** 查询摘要（游标绑定用；同一 query 的空白差异由调用方 trim 后消除）。 */
export function queryDigestOf(hash, query) {
  if (typeof hash !== 'function') throw new V3ContractViolation('v3 paging: 需要 hash.sha256')
  return String(hash('search-query:' + String(query ?? ''))).slice(0, 16)
}

/** 会话摘要（不把会话 id 原样放进模型可见的游标）。 */
export function sessionDigestOf(hash, sessionId) {
  if (typeof hash !== 'function') throw new V3ContractViolation('v3 paging: 需要 hash.sha256')
  return String(hash('search-session:' + String(sessionId ?? ''))).slice(0, 16)
}

function assertOffset(value, name) {
  if (!Number.isInteger(value) || value < 0 || value > SEARCH_PAGE_MAX_OFFSET) {
    throw new V3ContractViolation('v3 paging: ' + name + ' 必须是 [0,' + SEARCH_PAGE_MAX_OFFSET + '] 的整数，得到 ' + String(value))
  }
}

/**
 * 铸造一条搜索游标。
 *
 * @param {object} input
 * @param {(text: string) => string} input.hash sha256 注入
 * @param {string} input.sessionId 会话 id（只以摘要形式进游标）
 * @param {string} input.query 已 trim 的查询
 * @param {'records'|'summaries'|'all'} input.scope
 * @param {string} input.generation 快照代际摘要（16 位十六进制）
 * @param {number} input.recordsOffset 下一次从 records 的第几条开始（槽位数，不是已返回条数）
 * @param {number} input.summariesOffset 同上，summaries 独立推进
 * @returns {string}
 */
export function encodeSearchCursor({ hash, sessionId, query, scope, generation, recordsOffset = 0, summariesOffset = 0 } = {}) {
  if (typeof hash !== 'function') throw new V3ContractViolation('v3 paging: 需要 hash.sha256')
  if (typeof sessionId !== 'string' || sessionId.length === 0) throw new V3ContractViolation('v3 paging: sessionId 必须是非空字符串')
  const scopeCode = SCOPE_CODE[scope]
  const orderCode = ORDER_CODE[scope]
  if (scopeCode === undefined || orderCode === undefined) throw new V3ContractViolation('v3 paging: scope 非法：' + String(scope))
  if (typeof generation !== 'string' || !DIGEST_RE.test(generation)) {
    throw new V3ContractViolation('v3 paging: generation 必须是 16 位十六进制摘要')
  }
  assertOffset(recordsOffset, 'recordsOffset')
  assertOffset(summariesOffset, 'summariesOffset')
  const core = [
    CURSOR_VERSION,
    scopeCode,
    queryDigestOf(hash, query),
    orderCode,
    generation,
    recordsOffset.toString(36),
    summariesOffset.toString(36),
    sessionDigestOf(hash, sessionId),
  ].join('.')
  return core + '.' + String(hash(CURSOR_SALT + '|' + core)).slice(0, 16)
}

/**
 * 解析并校验游标形态（**不做**语义比对：query/scope/session/order/generation 由调用方
 * 逐项比对，以便给出具体错误码）。任何失败都返回错误码，不抛异常。
 *
 * @returns {{ok: true, value: object} | {ok: false, error: string}}
 */
export function decodeSearchCursor(cursor, { hash } = {}) {
  if (typeof cursor !== 'string' || cursor.length === 0) return { ok: false, error: SEARCH_CURSOR_ERRORS.invalid }
  if (cursor.length > CURSOR_MAX_CHARS) return { ok: false, error: SEARCH_CURSOR_ERRORS.invalid }
  if (typeof hash !== 'function') return { ok: false, error: SEARCH_CURSOR_ERRORS.invalid }
  if (LEGACY_RE.test(cursor)) return { ok: false, error: SEARCH_CURSOR_ERRORS.legacy }
  const versioned = VERSION_RE.exec(cursor)
  if (versioned !== null && versioned[1] !== '1') return { ok: false, error: SEARCH_CURSOR_ERRORS.version }
  const matched = CURSOR_RE.exec(cursor)
  if (matched === null) return { ok: false, error: SEARCH_CURSOR_ERRORS.invalid }
  const [, scopeCode, queryDigest, orderCode, generation, recordsRaw, summariesRaw, sessionDigest, checksum] = matched
  const core = [
    CURSOR_VERSION, scopeCode, queryDigest, orderCode, generation, recordsRaw, summariesRaw, sessionDigest,
  ].join('.')
  if (String(hash(CURSOR_SALT + '|' + core)).slice(0, 16) !== checksum) {
    return { ok: false, error: SEARCH_CURSOR_ERRORS.invalid }
  }
  const recordsOffset = parseInt(recordsRaw, 36)
  const summariesOffset = parseInt(summariesRaw, 36)
  if (!Number.isSafeInteger(recordsOffset) || recordsOffset < 0 || recordsOffset > SEARCH_PAGE_MAX_OFFSET) {
    return { ok: false, error: SEARCH_CURSOR_ERRORS.invalid }
  }
  if (!Number.isSafeInteger(summariesOffset) || summariesOffset < 0 || summariesOffset > SEARCH_PAGE_MAX_OFFSET) {
    return { ok: false, error: SEARCH_CURSOR_ERRORS.invalid }
  }
  return {
    ok: true,
    value: {
      scope: CODE_TO_SCOPE[scopeCode],
      query: queryDigest,
      order: CODE_TO_ORDER[orderCode],
      generation,
      recordsOffset,
      summariesOffset,
      session: sessionDigest,
    },
  }
}

/**
 * 单页额度分配（C-G1-06）。
 *
 * 规则（确定性、可单测，无随机）：
 * 1. 单集合 scope 把整页给该集合；
 * 2. `all`：两边都有剩余时各占一半（records 取 ceil），因此 limit≥2 时两边都至少 1 条；
 *    limit=1 时按「谁读得少给谁」轮转（相等时先 records），保证不会永久饿死任一边；
 * 3. 一边耗尽（remaining=0）时整页给另一边；remaining=null 表示**未知**（不可穷尽的后端），
 *    按「还有」处理但不承诺额度。
 *
 * @param {object} input
 * @param {'records'|'summaries'|'all'} input.scope
 * @param {number} input.limit 本页条数上限（1..10）
 * @param {number} [input.recordsOffset] 已消费的 records 槽位数
 * @param {number} [input.summariesOffset] 已消费的 summaries 槽位数
 * @param {number|null} [input.recordsRemaining] 剩余条数；null = 未知
 * @param {number|null} [input.summariesRemaining] 同上
 * @returns {{records: number, summaries: number}}
 */
export function allocatePageSlots({ scope, limit, recordsOffset = 0, summariesOffset = 0, recordsRemaining = null, summariesRemaining = null } = {}) {
  if (!Number.isInteger(limit) || limit < 1) throw new V3ContractViolation('v3 paging: limit 必须是 ≥1 的整数，得到 ' + String(limit))
  if (scope === 'records') return { records: limit, summaries: 0 }
  if (scope === 'summaries') return { records: 0, summaries: limit }
  if (scope !== 'all') throw new V3ContractViolation('v3 paging: scope 非法：' + String(scope))
  const recordsLeft = recordsRemaining === null ? null : Math.max(0, recordsRemaining)
  const summariesLeft = summariesRemaining === null ? null : Math.max(0, summariesRemaining)
  if (recordsLeft === 0 && summariesLeft === 0) return { records: 0, summaries: 0 }
  if (recordsLeft === 0) return { records: 0, summaries: Math.min(limit, summariesLeft ?? limit) }
  if (summariesLeft === 0) return { records: Math.min(limit, recordsLeft ?? limit), summaries: 0 }
  if (limit === 1) return recordsOffset <= summariesOffset ? { records: 1, summaries: 0 } : { records: 0, summaries: 1 }
  let records = Math.ceil(limit / 2)
  let summaries = limit - records
  for (let round = 0; round < 2; round += 1) {
    if (recordsLeft !== null && records > recordsLeft) { summaries += records - recordsLeft; records = recordsLeft }
    if (summariesLeft !== null && summaries > summariesLeft) { records += summaries - summariesLeft; summaries = summariesLeft }
  }
  records = Math.min(records, limit)
  summaries = Math.min(summaries, limit - records)
  return { records, summaries }
}
