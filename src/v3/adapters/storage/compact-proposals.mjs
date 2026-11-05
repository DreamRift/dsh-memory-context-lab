/**
 * 压缩提案台账（adapters/storage，0.15.0 P4）。
 *
 * 形状：<会话目录>/compact-proposals.jsonl，**append-only 事件流**：
 *   proposal/prepared → proposal/accepted → proposal/committed | proposal/stale
 *   proposal/late-summary（迟到摘要，不改旧回执）
 * 状态由事件折叠得出（最新一条决定），因此重启/重试天然幂等：
 * 同一 proposalId 不会因为重放被「复活」成另一个状态，也不会重复提交。
 *
 * 纪律：
 * - 追加进跨进程写锁，锁内执行 guard（遗忘代际/来源绑定）；
 * - 事件不保存摘要正文（只保存 summaryId/hash 与候选身份），避免台账变成第二份正文库；
 * - 完整行不可解析 = 台账损坏，读面失败关闭（不把「读不到」当成「没有提案」）。
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { V3ContractViolation } from '../../contracts/errors.mjs'
import { withCrossProcessWriteLock } from './write-lock.mjs'

export const PROPOSALS_LOG = 'compact-proposals.jsonl'
export const PROPOSAL_ID_PATTERN = /^v3p-[0-9a-f]{16}$/

/** 提案事件类型封闭集。 */
export const PROPOSAL_EVENT_TYPES = Object.freeze([
  'proposal/prepared',
  'proposal/accepted',
  'proposal/committed',
  'proposal/stale',
  'proposal/late-summary',
])

export function proposalsPath(directory) {
  return join(directory, PROPOSALS_LOG)
}

export function isProposalId(value) {
  return typeof value === 'string' && PROPOSAL_ID_PATTERN.test(value)
}

/** 读全部事件行（损坏返回结构化失败）。 */
export async function listProposalEvents(directory) {
  let text
  try {
    text = await readFile(proposalsPath(directory), 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: true, rows: [] }
    return { ok: false, reason: error?.code ?? String(error), line: null }
  }
  const rows = []
  const rawLines = text.split('\n')
  for (let index = 0; index < rawLines.length; index += 1) {
    const raw = rawLines[index]
    if (raw.length === 0) continue
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      return { ok: false, reason: PROPOSALS_LOG + ' 第 ' + (index + 1) + ' 行不可解析', line: index + 1 }
    }
    if (parsed === null || typeof parsed !== 'object' || !PROPOSAL_EVENT_TYPES.includes(parsed.type) || !isProposalId(parsed.proposalId)) {
      return { ok: false, reason: PROPOSALS_LOG + ' 第 ' + (index + 1) + ' 行不是合法提案事件', line: index + 1 }
    }
    rows.push(parsed)
  }
  return { ok: true, rows }
}

/**
 * 事件流折叠：proposalId → 最新状态。
 *
 * 事件类型是事实，status 是**派生**——late-summary（迟到摘要）不是生命周期迁移，
 * 不能把已 committed 的提案改回「有摘要待提交」；它只记 lateSummaryId。
 */
export function foldProposals(events) {
  const out = new Map()
  for (const event of Array.isArray(events) ? events : []) {
    if (!isProposalId(event?.proposalId)) continue
    const previous = out.get(event.proposalId)
    const merged = { ...(previous ?? {}), ...event }
    if (event.type === 'proposal/late-summary') {
      merged.status = previous?.status ?? 'accepted'
      merged.lateSummaryId = event.summaryId ?? null
    } else {
      merged.status = event.type.slice('proposal/'.length)
    }
    out.set(event.proposalId, merged)
  }
  return out
}

/** 读当前所有提案状态（Map；损坏时抛错——调用方按不可用处理）。 */
export async function readProposals(directory) {
  const listed = await listProposalEvents(directory)
  if (!listed.ok) {
    const error = new Error(listed.reason)
    error.code = 'EPROPOSALS_DAMAGED'
    throw error
  }
  return foldProposals(listed.rows)
}

/**
 * P1-06：追加前的台账健康前置（锁内）。
 *
 * 旧实现直接 `open(..., 'a')` 追加：
 * - 尾半行（最后一行没有换行）时，新事件与半行**拼成同一行**，两条一起变成不可解析行；
 * - 中段/完整行已损坏时，追加仍返回成功，而 `readProposals` 之后一直抛
 *   `EPROPOSALS_DAMAGED`——提案全部卡在「不可用」，命令面却报成功（假成功）。
 *
 * 现在的顺序：先补换行 → 再读一遍 → 仍损坏就**拒绝追加**并返回结构化失败（不改任何字节）。
 */
async function prepareAppendTarget(directory) {
  const file = proposalsPath(directory)
  try {
    const { open } = await import('node:fs/promises')
    const handle = await open(file, 'r+')
    try {
      const info = await handle.stat()
      if (info.size > 0) {
        const last = Buffer.alloc(1)
        await handle.read(last, 0, 1, info.size - 1)
        if (last[0] !== 10) {
          await handle.write('\n', info.size, 'utf8')
          await handle.sync()
        }
      }
    } finally {
      await handle.close()
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') return { ok: false, reason: 'proposals-unreadable', detail: error?.code ?? String(error) }
  }
  const listed = await listProposalEvents(directory)
  if (!listed.ok) return { ok: false, reason: 'proposals-damaged', detail: listed.reason, line: listed.line ?? null }
  return { ok: true }
}

/**
 * 追加提案事件（锁内）。
 * @param {string} directory
 * @param {object} event 必须有 type/proposalId/at
 * @param {{guard?:Function}} [options] 锁内 guard（返回 {ok,reason}）
 */
export async function appendProposalEvent(directory, event, { guard } = {}) {
  if (event === null || typeof event !== 'object') throw new V3ContractViolation('v3 proposals: 事件必须是对象')
  if (!PROPOSAL_EVENT_TYPES.includes(event.type)) throw new V3ContractViolation('v3 proposals: 未知事件类型：' + String(event.type))
  if (!isProposalId(event.proposalId)) throw new V3ContractViolation('v3 proposals: proposalId 形状非法：' + String(event.proposalId))
  return withCrossProcessWriteLock(directory, async (ownership) => {
    if (typeof guard === 'function') {
      const verdict = await guard({})
      if (verdict?.ok !== true) return { ok: false, reason: verdict?.reason ?? 'guard-rejected' }
    }
    ownership.assertOwned()
    const prepared = await prepareAppendTarget(directory)
    if (prepared.ok !== true) return prepared
    const { open } = await import('node:fs/promises')
    const handle = await open(proposalsPath(directory), 'a')
    try {
      await handle.write(JSON.stringify(event) + '\n')
      await handle.sync()
    } finally {
      await handle.close()
    }
    return { ok: true, appended: true }
  })
}
