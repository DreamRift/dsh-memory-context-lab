/**
 * 归档意图（crash journal）：surface replace 前落盘，成功后清。
 *
 * 为什么需要：surface 与 store 不是一个事务。若 replace 已生效、voucher 还没写，
 * 原文仍在日志但活动面只剩回执，恢复凭证缺失。下个 pre-step 按 intent 找“正文等于
 * receiptText 的 surface 节点”，补 voucher；找不到就清掉（不推进 state）。
 *
 * R2-01/R3-02（2026-10-30）：temp+rename 只是落盘手段，不是事务保护——
 * - **占槽（reserve）**：未对账的旧意图不得被下一笔归档覆盖。新归档先占槽，
 *   锁内重读校验：槽位非空且身份不同 → 拒绝；不可读 → 失败关闭。
 * - **按身份清理（clearIfMatches）**：迟到的旧清理不得删除新意图。锁内重读比对
 *   身份（新格式比 intentId；旧格式没有 ID 时以规范化完整载荷指纹作一次性比较），
 *   不匹配返回 conflict 而不删除。
 * 全部读改写复用会话目录的跨进程写锁（与 store 同一把锁域，不新增锁目录）。
 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { V3ContractViolation } from '../../contracts/errors.mjs'
import { sessionStatePath } from './session-state.mjs'
import { writeFileAtomic } from './session-store.mjs'
import { withCrossProcessWriteLock } from './write-lock.mjs'

const FILE = 'archive-intent.json'

export function archiveIntentPath(v3Root, sessionId) {
  return join(dirname(sessionStatePath(v3Root, sessionId)), FILE)
}

function sessionDirOf(v3Root, sessionId) {
  return dirname(archiveIntentPath(v3Root, sessionId))
}

export async function writeArchiveIntent(v3Root, sessionId, intent) {
  await writeFileAtomic(archiveIntentPath(v3Root, sessionId), JSON.stringify(intent) + '\n')
}

export async function readArchiveIntent(v3Root, sessionId) {
  try {
    return JSON.parse(await readFile(archiveIntentPath(v3Root, sessionId), 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

/** 规范化 JSON（键排序、递归稳定序列化）——旧格式没有 intentId 时的身份指纹真源。 */
function canonicalJson(value) {
  if (Array.isArray(value)) return '[' + value.map((item) => canonicalJson(item ?? null)).join(',') + ']'
  if (value !== null && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}'
  }
  return JSON.stringify(value ?? null)
}

export function intentFingerprintOf(intent) {
  return createHash('sha256').update(canonicalJson(intent ?? null)).digest('hex')
}

/** 身份比较：两侧都有 intentId 时比 ID；任一侧是旧格式时比全载荷指纹。 */
function sameIntentIdentity(current, expected) {
  if (current === null || typeof current !== 'object') return false
  if (expected === null || typeof expected !== 'object') return false
  if (typeof current.intentId === 'string' && current.intentId.length > 0
    && typeof expected.intentId === 'string' && expected.intentId.length > 0) {
    return current.intentId === expected.intentId
  }
  return intentFingerprintOf(current) === intentFingerprintOf(expected)
}

/** 诊断摘要（不回显 receiptText 全文，避免日志放大）。 */
function existingSummary(current) {
  if (current === null || typeof current !== 'object') return null
  return {
    intentId: typeof current.intentId === 'string' ? current.intentId : null,
    createdAt: Number.isFinite(current.createdAt) ? current.createdAt : null,
    mode: current.mode === 'cooling' ? 'cooling' : current.mode === 'full-history' ? 'full-history' : null,
    txn: Number.isInteger(current.txn) ? current.txn : null,
  }
}

/** 读原始字节（不做判定、无副作用；分类统一走 classifyArchiveIntent 唯一实现）。 */
async function readRawArchiveIntent(v3Root, sessionId) {
  try {
    return { ok: true, text: await readFile(archiveIntentPath(v3Root, sessionId), 'utf8'), error: null }
  } catch (error) {
    return { ok: false, text: null, error }
  }
}

/**
 * 槽位现状分类（B-2 判据同源，2026-10-31 审计）：peekArchiveIntent 与
 * reserveArchiveIntent 共用这一个判定，**不得各写一套**。输入 readFile 的原始结果，
 * 输出四态：
 * - absent：文件不存在（ENOENT）；
 * - pending：可读且解析为非空对象——合法意图占着槽；
 * - invalid：可读但不是合法意图对象（半截 JSON / 数组 / 标量）；
 * - unreadable：读取失败（EACCES/EISDIR 等非 ENOENT）。
 * 纯函数：不写盘、不补账、不清理。
 */
function classifyArchiveIntent(raw) {
  if (raw.ok === false) {
    if (raw.error?.code === 'ENOENT') return { state: 'absent', intent: null, error: null }
    return { state: 'unreadable', intent: null, error: raw.error }
  }
  try {
    const parsed = JSON.parse(raw.text)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { state: 'pending', intent: parsed, error: null }
    }
    return { state: 'invalid', intent: null, error: null }
  } catch (error) {
    return { state: 'invalid', intent: null, error }
  }
}

/**
 * 只读窥探（B-2，2026-10-31 审计）：status 预览在选 span 前看一眼槽位，让
 * 「下一次归档」与真实提交同一道闸——预览不再显示一个会被占槽挡下的候选。
 * 与 reserve 的差别只在调用时机与外层锁：分类判据共用 classifyArchiveIntent；
 * peek 不进写锁（避免排在在飞归档后面）、**无任何写副作用**（不写盘、不补账、
 * 不清理，特别是不拿 recoverArchiveIntent 当 peek——它会补凭证并清槽）。
 * @returns {Promise<{state:'absent'|'pending'|'invalid'|'unreadable', intent?:object}>}
 */
export async function peekArchiveIntent(v3Root, sessionId) {
  const slot = classifyArchiveIntent(await readRawArchiveIntent(v3Root, sessionId))
  if (slot.state === 'pending') return { state: 'pending', intent: slot.intent }
  return { state: slot.state }
}

/**
 * 占槽（R2-01）：锁内重读当前意图，只有 absent（或同一身份的幂等重占）才写入。
 * 不依赖调用方先检查——入口检查只是快速路径，这里才是提交边界。
 * @param {object} intent 必须带稳定 intentId（归档服务生成，恢复补凭证沿用同一 ID）。
 * @param {object} [options] 透传给跨进程写锁（ttlMs/waitMs/now）。
 * @returns {{ok:true,status:'reserved',reasserted?:boolean}
 *   |{ok:false,status:'pending'|'unreadable',existing:object|null,error?:Error}}
 */
export async function reserveArchiveIntent(v3Root, sessionId, intent, options = {}) {
  if (intent === null || typeof intent !== 'object'
    || typeof intent.intentId !== 'string' || intent.intentId.length === 0) {
    throw new V3ContractViolation('archive intent: reserve 需要带稳定 intentId 的意图对象')
  }
  return withCrossProcessWriteLock(sessionDirOf(v3Root, sessionId), async (ownership) => {
    // B-2（2026-10-31 审计）：槽位现状与 peek 共用 classifyArchiveIntent（判据同源）。
    const slot = classifyArchiveIntent(await readRawArchiveIntent(v3Root, sessionId))
    if (slot.state === 'unreadable' || slot.state === 'invalid') {
      // 槽位内容不可读/不可解析 ≠ 空：失败关闭，不覆盖（意图读取异常必须阻止新占槽）。
      return { ok: false, status: 'unreadable', existing: null, error: slot.error ?? new Error('archive intent: 槽位内容不是合法的意图对象') }
    }
    if (slot.state === 'pending') {
      if (sameIntentIdentity(slot.intent, intent)) {
        ownership.assertOwned() // R3-03b（2026-10-31 审计）：提交前复核，失锁后不再占槽
        await writeArchiveIntent(v3Root, sessionId, intent) // 幂等重占（重试/恢复路径）
        return { ok: true, status: 'reserved', reasserted: true }
      }
      // 已有未结算意图：保留原字节，拒绝覆盖（核心验收：旧意图字节与 ID 不变）。
      return { ok: false, status: 'pending', existing: existingSummary(slot.intent) }
    }
    ownership.assertOwned() // R3-03b：提交前复核（失锁后不得占槽——否则新持有者的归档被误挡）
    await writeArchiveIntent(v3Root, sessionId, intent)
    return { ok: true, status: 'reserved' }
  }, options)
}

/**
 * 按身份清理（R3-02）：锁内重读比对；不匹配返回 conflict，不删除。
 * @param {object} expected 调用方相信仍在槽位上的那份意图（新格式带 intentId；
 *   旧格式没有 ID 时以完整载荷指纹作一次性比较条件，不只比 txn/时间戳）。
 * @returns {{ok:true,status:'cleared'|'absent'}
 *   |{ok:false,status:'conflict'|'unreadable',existing:object|null,error?:Error}}
 */
export async function clearArchiveIntentIfMatches(v3Root, sessionId, expected, options = {}) {
  if (expected === null || typeof expected !== 'object') {
    throw new V3ContractViolation('archive intent: clearIfMatches 需要 expected 意图对象（身份比较条件）')
  }
  return withCrossProcessWriteLock(sessionDirOf(v3Root, sessionId), async (ownership) => {
    let current = null
    try {
      current = await readArchiveIntent(v3Root, sessionId)
    } catch (error) {
      // 不可读不是 absent：失败关闭，不 rm（否则等于盲清一个身份未知的槽位）。
      return { ok: false, status: 'unreadable', existing: null, error }
    }
    if (current === null) return { ok: true, status: 'absent' } // 幂等：已清即成功
    if (!sameIntentIdentity(current, expected)) {
      return { ok: false, status: 'conflict', existing: existingSummary(current) }
    }
    ownership.assertOwned() // R3-03b（2026-10-31 审计）：删字节前复核（失锁后的 rm 会删新持有者的槽位）
    const { rm } = await import('node:fs/promises')
    await rm(archiveIntentPath(v3Root, sessionId), { force: true })
    return { ok: true, status: 'cleared' }
  }, options)
}