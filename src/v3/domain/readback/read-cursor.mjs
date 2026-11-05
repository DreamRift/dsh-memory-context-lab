/**
 * 读侧游标域（domain/readback，0.15.0 G2 / C-M-04；对齐 G1 搜索游标的 v1.* 形态）。
 *
 * 旧缺陷（C-M-04 的读侧一半）：`toolRead` 的 cursor 是裸十进制偏移，`cursorOffsetOf`
 * 对任何非 `^\d+$` **返回 0**——非法游标静默回到第一页、换对象接着读也不会报错。
 * 读侧比搜索侧更危险：搜索读错只是页码错，读侧读错会**把另一个对象的第 N 段当成这段**。
 *
 * 新游标把「这段字节属于谁、是哪个版本的、用什么单位数的」写进游标本身：
 * `v1.<o|f>.<对象ID摘要>.<对象版本摘要>.<单位码>.<偏移36>.<会话摘要>.<校验和>`
 * - `o` = 正文页（object page），`f` = 引用页（references page）——两者共用同一套
 *   绑定与错误码，因此「正文分页」与「引用续读」是**可验证的同一套语义**（§8 要求）；
 * - 对象版本：记录 = 记录不可变字节 hash；摘要 = 工件物化指纹（fingerprintOf）。
 *   内容一改，旧游标立即 `read-cursor-object-changed`（显式 stale，不静默错读）；
 * - 偏移单位固定 `c` = 码点（contracts/readback.mjs 的裁决）；
 * - 会话摘要：不把会话 id 原样写进模型可见的游标。
 *
 * 校验和不是安全边界（游标由模型可见、可复制）：它只让「手改一个字段」可被发现；
 * 真正的保护是上列字段与**实际对象/会话/单位**逐项比对。伪造整条游标最多得到
 * 一次同对象的正常分页，不越权、不错读。
 *
 * 本模块是纯函数（无 IO、无时钟、无随机）：sha256 由装配点注入（域层不碰 node:crypto）。
 */
import { V3ContractViolation } from '../../contracts/errors.mjs'
import {
  READBACK_CURSOR_VERSION,
  READBACK_OFFSET_UNIT,
  READBACK_PAGE_MAX_OFFSET,
} from '../../contracts/readback.mjs'

/** 游标最大长度（正常 ~110；上界只防病态输入，解析资源有界）。 */
const CURSOR_MAX_CHARS = 512

/** 校验和盐。**不是密钥**（理由见文件头）。 */
const CURSOR_SALT = 'mcl-v3-read-cursor'

/** 页种类码：正文页 / 引用页（同一套绑定，不同偏移空间）。 */
const PAGE_CODE = Object.freeze({ object: 'o', refs: 'f' })

/** 偏移单位码（当前只有码点；新增单位必须同时改 contracts/readback.mjs 的裁决）。 */
const UNIT_CODE = Object.freeze({ [READBACK_OFFSET_UNIT]: 'c' })

const CURSOR_RE = /^v1\.([of])\.([0-9a-f]{16})\.([0-9a-f]{16})\.(c)\.([0-9a-z]{1,7})\.([0-9a-f]{16})\.([0-9a-f]{16})$/
const LEGACY_RE = /^\d+$/
const VERSION_RE = /^v(\d+)\./

/**
 * 游标错误码（封闭集；render 层按码给模型可读的处理建议）。
 * 每个码都表示「本次没有返回任何一页」，绝不表示「没有更多内容」。
 */
export const READ_CURSOR_ERRORS = Object.freeze({
  invalid: 'read-cursor-invalid',
  legacy: 'read-cursor-legacy-format',
  version: 'read-cursor-version-unsupported',
  id: 'read-cursor-id-mismatch',
  object: 'read-cursor-object-changed',
  unit: 'read-cursor-unit-mismatch',
  session: 'read-cursor-session-mismatch',
})

/** 对象 ID 摘要（不把 ID 原样重复一遍进游标；同一 ID 稳定同摘要）。 */
export function objectDigestOf(hash, id) {
  if (typeof hash !== 'function') throw new V3ContractViolation('v3 read-cursor: 需要 hash.sha256')
  return String(hash('read-object:' + String(id ?? ''))).slice(0, 16)
}

/**
 * 对象版本摘要：把「record 字节 hash / 摘要工件指纹」变成长度固定、可比的 16 位十六进制。
 *
 * 版本值缺失（hash 端口不可用 / 对象没有 hash）时**抛错**——调用方必须放弃铸造游标，
 * 而不是发一个不绑定版本的游标（那正是旧缺陷的读错来源）。
 */
export function objectVersionDigestOf(hash, objectVersion) {
  if (typeof hash !== 'function') throw new V3ContractViolation('v3 read-cursor: 需要 hash.sha256')
  if (typeof objectVersion !== 'string' || objectVersion.length === 0) {
    throw new V3ContractViolation('v3 read-cursor: 对象版本不可用（不得铸造未绑定版本的游标）')
  }
  return String(hash('read-object-version:' + objectVersion)).slice(0, 16)
}

/** 会话摘要（与搜索游标同一写法；不泄露会话 id）。 */
export function sessionDigestOfRead(hash, sessionId) {
  if (typeof hash !== 'function') throw new V3ContractViolation('v3 read-cursor: 需要 hash.sha256')
  return String(hash('read-session:' + String(sessionId ?? ''))).slice(0, 16)
}

function assertOffset(value, name) {
  if (!Number.isInteger(value) || value < 0 || value > READBACK_PAGE_MAX_OFFSET) {
    throw new V3ContractViolation('v3 read-cursor: ' + name + ' 必须是 [0,' + READBACK_PAGE_MAX_OFFSET + '] 的整数，得到 ' + String(value))
  }
}

/**
 * 铸造一条读游标。
 *
 * @param {object} input
 * @param {(text: string) => string} input.hash sha256 注入
 * @param {string} input.sessionId 会话 id（只以摘要形式进游标）
 * @param {string} input.id 对象 ID（v3r-… / v3s-…）
 * @param {'object'|'refs'} [input.page] 页种类（正文页 / 引用页）
 * @param {string} input.objectVersion 对象版本（记录字节 hash / 摘要工件指纹）
 * @param {number} input.offset 下一页起点（正文=码点；引用=引用序号）
 * @returns {string}
 */
export function encodeReadCursor({ hash, sessionId, id, page = 'object', objectVersion, offset = 0 } = {}) {
  if (typeof hash !== 'function') throw new V3ContractViolation('v3 read-cursor: 需要 hash.sha256')
  if (typeof sessionId !== 'string' || sessionId.length === 0) throw new V3ContractViolation('v3 read-cursor: sessionId 必须是非空字符串')
  if (typeof id !== 'string' || id.length === 0) throw new V3ContractViolation('v3 read-cursor: id 必须是非空字符串')
  const pageCode = PAGE_CODE[page]
  if (pageCode === undefined) throw new V3ContractViolation('v3 read-cursor: page 非法：' + String(page))
  assertOffset(offset, 'offset')
  const core = [
    'v' + String(READBACK_CURSOR_VERSION),
    pageCode,
    objectDigestOf(hash, id),
    objectVersionDigestOf(hash, objectVersion),
    UNIT_CODE[READBACK_OFFSET_UNIT],
    offset.toString(36),
    sessionDigestOfRead(hash, sessionId),
  ].join('.')
  return core + '.' + String(hash(CURSOR_SALT + '|' + core)).slice(0, 16)
}

/**
 * 解析并校验游标形态（**不做**语义比对：对象/版本/会话由调用方逐项比对，
 * 以便给出具体错误码）。任何失败都返回错误码，不抛异常。
 *
 * @returns {{ok: true, value: {page:'object'|'refs', object:string, version:string, unit:string, offset:number, session:string}}
 *   | {ok: false, error: string}}
 */
export function decodeReadCursor(cursor, { hash } = {}) {
  if (typeof cursor !== 'string' || cursor.length === 0) return { ok: false, error: READ_CURSOR_ERRORS.invalid }
  if (cursor.length > CURSOR_MAX_CHARS) return { ok: false, error: READ_CURSOR_ERRORS.invalid }
  if (typeof hash !== 'function') return { ok: false, error: READ_CURSOR_ERRORS.invalid }
  if (LEGACY_RE.test(cursor)) return { ok: false, error: READ_CURSOR_ERRORS.legacy }
  const versioned = VERSION_RE.exec(cursor)
  if (versioned !== null && versioned[1] !== String(READBACK_CURSOR_VERSION)) {
    return { ok: false, error: READ_CURSOR_ERRORS.version }
  }
  const matched = CURSOR_RE.exec(cursor)
  if (matched === null) return { ok: false, error: READ_CURSOR_ERRORS.invalid }
  const [, pageCode, objectDigest, versionDigest, unitCode, offsetRaw, sessionDigest, checksum] = matched
  const core = ['v' + String(READBACK_CURSOR_VERSION), pageCode, objectDigest, versionDigest, unitCode, offsetRaw, sessionDigest].join('.')
  if (String(hash(CURSOR_SALT + '|' + core)).slice(0, 16) !== checksum) {
    return { ok: false, error: READ_CURSOR_ERRORS.invalid }
  }
  if (UNIT_CODE[READBACK_OFFSET_UNIT] !== unitCode) return { ok: false, error: READ_CURSOR_ERRORS.unit }
  const offset = parseInt(offsetRaw, 36)
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > READBACK_PAGE_MAX_OFFSET) {
    return { ok: false, error: READ_CURSOR_ERRORS.invalid }
  }
  const page = pageCode === PAGE_CODE.refs ? 'refs' : 'object'
  return {
    ok: true,
    value: { page, object: objectDigest, version: versionDigest, unit: READBACK_OFFSET_UNIT, offset, session: sessionDigest },
  }
}
