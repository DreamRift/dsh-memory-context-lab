/**
 * 聚合凭证（aggregate voucher，P3-8/P3-9）。
 *
 * 只替换**无用户消息穿插的连续已完成回执组**：活动面上相邻的 v2 归档
 * 回执（memory-lab2-surface 事件）合并成一条恒定格式的凭证消息，把整段
 * 回执的「来源/限制/精确值」保下来：
 *
 * - 来源：seq 范围 + 成员冷记录 id（从回执原文逐条解析，不猜测）；
 * - 限制：凭证只是指针卡，成员原文仍在 append-only 日志里，分页展开
 *   `/memory-lab expand <凭证ID>` 走恒定只读面逐页回读；
 * - 精确值：成员数、冷记录数、工具直方图、token 估算都来自回执原文。
 *
 * 边界纪律：任何人类消息、插件状态卡、未归档事件都打断候选组；凭证
 * 文本以 AGG_VOUCHER_MARKER 开头而非 V2_RECEIPT_MARKER，收集器不把它当
 * 回执成员，因此**不会被再次聚合**（禁止「凭证再凭证」递归）。人类消息
 * 在组内出现时整组放弃（宁可少合，不吞用户输入）。
 *
 * 计划文件（voucher-plans.json）是两步提交的重放窗口：先落计划 → 账本
 * 登记凭证条目 → 表面追加凭证消息（可见面最后变）；中途崩溃由协调器
 * 对账（见 hierarchy-coordinator.mjs 的 reconcileVouchers）。账本条目才
 * 是权威，计划文件损坏时按「找不到凭证」处理，不静默重建。
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { withWriteLock } from './write-lock.mjs'

import { AGG_VOUCHER_MARKER, buildProjectionHeader, V2_RECEIPT_MARKER } from '../core.mjs'
import { estimateTokensOf } from './budget.mjs'
import { canonicalLine } from './disposition.mjs'
import { writeFileAtomic } from './appendable-ledger.mjs'

// 标记常量单一出处（core.mjs）：isReceiptMessage 与本模块共用同一份，改一处即两处同步。
export { AGG_VOUCHER_MARKER }
export const AGG_VOUCHER_PLANS_FILE = 'voucher-plans.json'
export const AGG_VOUCHER_PLAN_LIMIT = 32
/** 组长下限：低于它的连续回执组不值得换一条凭证（no-safe-gain）。 */
export const AGG_VOUCHER_MIN_RUN = 3
/** 组长上限：单张凭证覆盖的回执数封顶，展开分页每页 3 段。 */
export const AGG_VOUCHER_MAX_RUN = 40
export const AGG_VOUCHER_PAGE_SIZE = 3

const COLD_RECORD_ID_PATTERN = /mcl2-[0-9a-f]+-\d{6}/g

// ---------------------------------------------------------------- 成员识别

/**
 * 一个表面节点是不是 v2 归档回执。只认 `memory-lab2-surface` 形态 +
 * V2_RECEIPT_MARKER 开头：聚合凭证、v1 回执、状态卡都不算成员。
 */
export function isV2ReceiptNode(node) {
  if (!node || typeof node !== 'object') return false
  // 宿主事件是嵌套 source.form；coordinator 的表面快照是平铺 sourceForm。两种都认。
  if ((node.source?.form ?? node.sourceForm) !== 'memory-lab2-surface') return false
  const text = nodeTextOf(node)
  return typeof text === 'string' && text.startsWith(V2_RECEIPT_MARKER)
}

function nodeTextOf(node) {
  if (typeof node.text === 'string') return node.text
  const blocks = node.content ?? node.message?.content
  if (Array.isArray(blocks) && blocks.length > 0) {
    const first = blocks[0]
    if (first?.type === 'text' && typeof first.text === 'string') return first.text
  }
  return null
}

/** 任何不是回执成员的节点都是边界：人类消息、助手正文、工具事件、状态卡。 */
export function isBoundaryNode(node) {
  return !isV2ReceiptNode(node)
}

/** 从回执原文解析成员冷记录 id（冷记录：mcl2-… 行，逐条全局扫描）。 */
export function parseReceiptRecordIds(text) {
  if (typeof text !== 'string') return []
  const ids = text.match(COLD_RECORD_ID_PATTERN) ?? []
  return [...new Set(ids)]
}

/**
 * 从回执解析工具直方图。「工具：a、b」行（单段）与批次回执首行
 * 「工具：a、b、a」（按成员出现）都覆盖；无工具行返回空对象。
 */
export function parseReceiptTools(text) {
  const histogram = Object.create(null)
  if (typeof text !== 'string') return histogram
  for (const line of text.split('\n')) {
    const match = /^工具：(.+)$/.exec(line.trim()) ?? /^#\d+ 工具：(.+?) 状态/.exec(line.trim())
    if (!match) continue
    for (const name of match[1].split(/[、,，]/)) {
      const tool = name.trim()
      if (!tool) continue
      histogram[tool] = (histogram[tool] ?? 0) + 1
    }
  }
  return histogram
}

function mergeHistogram(target, source) {
  for (const [tool, count] of Object.entries(source)) {
    target[tool] = (target[tool] ?? 0) + count
  }
  return target
}

// ---------------------------------------------------------------- 计划

export function voucherIdOf(startSeq, endSeq, memberSeqs) {
  const digest = createHash('sha256').update([...memberSeqs].join(',')).digest('hex').slice(0, 6)
  return `agg-${startSeq}-${endSeq}-${digest}`
}

/**
 * 扫描按 seq 升序的活动面节点，规划聚合凭证。纯函数：
 * - 只有**连续**回执节点成组（任何其他节点都断组）；
 * - 组长低于 minRunLength 不动（no-safe-gain）；
 * - 组长超过 maxRunLength 按上限切片；
 * - 每组的 recordIds / 工具直方图 / token 估算全部从成员回执原文解析。
 *
 * 返回 { plans, runs, skippedShort }：plans 是可提交计划（含渲染文本）；
 * runs 是全部连续组（含太短的）；skippedShort 是因过短被跳过的组数。
 */
/**
 * 计划 schema 版本（T2/F-15 成员级排除）：2 起 recordIds 是「参与蒸馏的子集」，
 * 被排除者进 excludedRecordIds/excludedMembers；缺省（无该字段）的计划按 v1 语义
 * 处理——任一成员不可见即整条作废，不做子集。
 */
export const AGG_VOUCHER_PLAN_SCHEMA = 2

/**
 * 成员摘要：memberSeqs（表面全集）｜included｜excluded 三段拼接后取 sha256 前 12 位。
 * 重放时与当前遗忘账本对不上，就说明计划已过期——不拿旧计划重放。
 */
export function memberDigestOf({ memberSeqs = [], includedRecordIds = [], excludedRecordIds = [] } = {}) {
  const digest = createHash('sha256')
  digest.update([...memberSeqs].join(','))
  digest.update('|')
  digest.update([...includedRecordIds].join(','))
  digest.update('|')
  digest.update([...excludedRecordIds].join(','))
  return digest.digest('hex').slice(0, 12)
}

/**
 * 把「哪些成员被排除」落到计划上（T2）：只收窄 recordIds（下游 sourceRecordIds、
 * leafIds、L1 卡集合的唯一来源），memberSeqs/memberTexts 保持表面全集——区间身份
 * 与 voucherId 因此不变。无排除时原样返回，保证输出逐字节不变。
 */
export function withMemberExclusions(plan, { excludedMembers = [] } = {}) {
  const excluded = (Array.isArray(excludedMembers) ? excludedMembers : [])
    .filter((member) => member && typeof member.recordId === 'string' && member.recordId)
  if (excluded.length === 0) return plan
  const excludedIds = excluded.map((member) => member.recordId)
  const excludedSet = new Set(excludedIds)
  const included = (plan.recordIds ?? []).filter((id) => !excludedSet.has(id))
  return {
    ...plan,
    planSchema: AGG_VOUCHER_PLAN_SCHEMA,
    recordIds: included,
    excludedRecordIds: excludedIds,
    excludedMembers: excluded,
    memberDigest: memberDigestOf({ memberSeqs: plan.memberSeqs, includedRecordIds: included, excludedRecordIds: excludedIds }),
    voucherText: renderVoucherText({
      voucherId: plan.voucherId,
      startSeq: plan.startSeq,
      endSeq: plan.endSeq,
      memberCount: plan.memberCount,
      recordCount: included.length,
      toolHistogram: plan.toolHistogram,
      tokensEstimate: plan.tokensEstimate,
      chars: plan.chars ?? 0,
      excludedCount: excludedIds.length,
    }),
  }
}

export function planAggregateVouchers(nodes, { minRunLength = AGG_VOUCHER_MIN_RUN, maxRunLength = AGG_VOUCHER_MAX_RUN } = {}) {
  const ordered = [...(nodes ?? [])].filter((node) => Number.isInteger(node?.seq)).sort((a, b) => a.seq - b.seq)
  const runs = []
  let current = []
  for (const node of ordered) {
    if (isV2ReceiptNode(node)) {
      current.push(node)
    } else {
      if (current.length > 0) runs.push(current)
      current = []
    }
  }
  if (current.length > 0) runs.push(current)

  const plans = []
  let skippedShort = 0
  for (const run of runs) {
    if (run.length < minRunLength) {
      skippedShort += 1
      continue
    }
    for (let offset = 0; offset < run.length; offset += maxRunLength) {
      const chunk = run.slice(offset, offset + maxRunLength)
      plans.push(buildVoucherPlan(chunk))
    }
  }
  return { plans, runs: runs.map((run) => run.map((node) => node.seq)), skippedShort }
}

function buildVoucherPlan(memberNodes) {
  const memberSeqs = memberNodes.map((node) => node.seq)
  const recordIds = []
  const toolHistogram = Object.create(null)
  let tokensEstimate = 0
  let chars = 0
  const memberTexts = []
  for (const node of memberNodes) {
    const text = nodeTextOf(node) ?? ''
    memberTexts.push(text)
    for (const id of parseReceiptRecordIds(text)) {
      if (!recordIds.includes(id)) recordIds.push(id)
    }
    mergeHistogram(toolHistogram, parseReceiptTools(text))
    tokensEstimate += estimateTokensOf(text)
    chars += text.length
  }
  const startSeq = memberSeqs[0]
  const endSeq = memberSeqs[memberSeqs.length - 1]
  const voucherId = voucherIdOf(startSeq, endSeq, memberSeqs)
  const voucherText = renderVoucherText({
    voucherId,
    startSeq,
    endSeq,
    memberCount: memberSeqs.length,
    recordCount: recordIds.length,
    toolHistogram,
    tokensEstimate,
    chars,
  })
  return {
    // T2/F-15：新计划一律带 schema 2 与空排除集（无排除时渲染与 0.10.x 逐字节一致）。
    planSchema: AGG_VOUCHER_PLAN_SCHEMA,
    voucherId,
    startSeq,
    endSeq,
    memberSeqs,
    recordIds,
    excludedRecordIds: [],
    excludedMembers: [],
    memberDigest: memberDigestOf({ memberSeqs, includedRecordIds: recordIds }),
    toolHistogram,
    tokensEstimate,
    chars,
    memberCount: memberSeqs.length,
    memberTexts,
    voucherText,
  }
}

// ---------------------------------------------------------------- 渲染与解析

/** 恒定格式凭证文本：字段固定、无时间戳，同计划永远渲染同一字节。 */
export function renderVoucherText({ voucherId, startSeq, endSeq, memberCount, recordCount, toolHistogram, tokensEstimate, excludedCount = 0, chars = 0 }) {
  const tools = Object.entries(toolHistogram ?? {})
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([tool, count]) => `${tool}×${count}`)
    .join('、')
  const lines = [
    AGG_VOUCHER_MARKER,
    // P0-5 / v1.2 P5-3：聚合凭证同样是一次投影，率与失真一起声明。
    buildProjectionHeader({
      releasedTokens: Number.isFinite(Number(tokensEstimate)) ? Number(tokensEstimate) : 0,
      releasedChars: Number.isFinite(Number(chars)) ? Number(chars) : 0,
      readbackTokens: Number.isFinite(Number(tokensEstimate)) ? Number(tokensEstimate) : null,
    }),
    `范围：seq ${startSeq}–${endSeq}（${memberCount} 段已归档操作；本条为程序聚合凭证，成员原文在 append-only 日志）`,
    `凭证：${voucherId}`,
    `成员冷记录：${recordCount} 条${tools ? `；工具：${tools}` : ''}`,
    `展开：/memory-lab expand ${voucherId}（分页回读成员回执原文；已软遗忘的成员只显示占位）`,
  ]
  // T2/F-15：只有真的排除了成员才追加这一行——无排除时输出与今天逐字节一致。
  if (Number(excludedCount) > 0) lines.push(`排除：${Number(excludedCount)} 段成员因遗忘未参与聚合（其余照常；成员原文仍在 append-only 日志）`)
  return lines.join('\n')
}

/** 反向解析凭证文本（对账与 expand 用）；非凭证文本返回 null。 */
export function parseAggVoucherText(text) {
  if (typeof text !== 'string' || !text.startsWith(AGG_VOUCHER_MARKER)) return null
  const voucherId = /^凭证：(agg-\d+-\d+-[0-9a-f]{6})$/m.exec(text)?.[1] ?? null
  const range = /^范围：seq (\d+)–(\d+)（(\d+) 段/m.exec(text)
  if (!voucherId || !range) return null
  return {
    voucherId,
    startSeq: Number(range[1]),
    endSeq: Number(range[2]),
    memberCount: Number(range[3]),
  }
}

/**
 * 渲染 expand 的一页：恒定只读面。成员回执原文逐字节放入（每页至多
 * pageSize 段）；forgotten 成员以占位行说明，不显示原文。页脚带下一页
 * 提示；尾页如实标记。
 */
export function renderExpansionPage({ voucher, receiptTexts, forgottenMemberSeqs = [], page = 1, pageSize = AGG_VOUCHER_PAGE_SIZE }) {
  const total = voucher.memberSeqs.length
  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  const clampedPage = Math.min(Math.max(1, page), pageCount)
  const from = (clampedPage - 1) * pageSize
  const slice = voucher.memberSeqs.slice(from, from + pageSize)
  const forgotten = new Set(forgottenMemberSeqs ?? [])
  const lines = [
    `■ 聚合凭证 ${voucher.voucherId}（seq ${voucher.startSeq}–${voucher.endSeq}，成员 ${total} 段）第 ${clampedPage}/${pageCount} 页`,
  ]
  slice.forEach((seq, index) => {
    // BUG-006：receiptTexts 是全量数组（按成员 seq 平行），index 是页内下标；
    // 第 2 页起必须加上页起点偏移，否则显示上一页原文（或把已遗忘占位错配）。
    const receiptText = receiptTexts[from + index]
    lines.push('')
    if (forgotten.has(seq) || receiptText === undefined) {
      lines.push(`[成员 seq:${seq} 已软遗忘或不可读，原文不回注；undo 遗忘后可恢复]`)
    } else {
      lines.push(`── 成员 seq:${seq} 原文 ──`)
      lines.push(receiptText)
    }
  })
  lines.push('')
  if (clampedPage < pageCount) {
    lines.push(`下一页：/memory-lab expand ${voucher.voucherId} ${clampedPage + 1}`)
  } else {
    lines.push('（末页）')
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------- 计划文件

export function voucherPlansPath(sessionDir) {
  return path.join(sessionDir, AGG_VOUCHER_PLANS_FILE)
}

/** 保存一张凭证计划（重放窗口，非权威账本；超限丢最旧）。 */
/**
 * 保存一条聚合凭证计划。
 *
 * 0.13.2-beta.2（W-01c）：整段「读 JSON → 计算 → 写 temp → rename」必须在写锁内。
 * 旧实现把读放在锁外、只给最后的整文件替换加锁，于是两个并发的
 * `saveVoucherPlan` 都基于同一份旧 `plans` 计算，后写者整文件覆盖先写者——
 * 计划是重放窗口，丢一条就等于那批凭证再也展开不回来。
 */
export async function saveVoucherPlan(sessionDir, plan) {
  return withWriteLock(sessionDir, () => saveVoucherPlanUnlocked(sessionDir, plan))
}

async function saveVoucherPlanUnlocked(sessionDir, plan) {
  const file = voucherPlansPath(sessionDir)
  let current = { plans: [] }
  try {
    current = JSON.parse(await readFile(file, 'utf8'))
  } catch {
    // 计划文件损坏时重建（它只是重放窗口）。
  }
  if (!Array.isArray(current.plans)) current.plans = []
  const next = [...current.plans.filter((item) => item?.voucherId !== plan.voucherId), plan]
    .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))
    .slice(0, AGG_VOUCHER_PLAN_LIMIT)
  const payload = canonicalLine({ plans: next }) + '\n'
  // Y-14（beta.7 A 组）：临时名必须唯一且要 fsync。旧写法固定 `file + '.tmp'`：
  // 同进程两个并发写者互相截断对方正在写的临时文件，后写者 rename 走的是残缺内容。
  // 同仓 writeFileAtomic 已是唯一原子写实现（randomUUID 临时名），不再自造一份。
  await writeFileAtomic(file, payload)
  return { voucherId: plan.voucherId, kept: next.length }
}

export async function loadVoucherPlans(sessionDir) {
  try {
    const parsed = JSON.parse(await readFile(voucherPlansPath(sessionDir), 'utf8'))
    return Array.isArray(parsed?.plans) ? parsed.plans : []
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    return []
  }
}

async function writeVoucherPlansUnlocked(sessionDir, plans) {
  const file = voucherPlansPath(sessionDir)
  const payload = canonicalLine({ plans }) + '\n'
  await writeFileAtomic(file, payload) // Y-14：唯一临时名 + fsync
}

export async function dropVoucherPlan(sessionDir, voucherId) {
  // 读-改-写整段进锁（W-01c）：锁只包住最后的 rename 时，并发删除会互相覆盖。
  return withWriteLock(sessionDir, async () => {
    const plans = await loadVoucherPlans(sessionDir)
    const next = plans.filter((item) => item?.voucherId !== voucherId)
    if (next.length === plans.length) return { dropped: false, kept: next.length }
    await writeVoucherPlansUnlocked(sessionDir, next)
    return { dropped: true, kept: next.length }
  })
}

/**
 * 遗忘后的计划失效（0.11.0，外部审计 P0 的配套）：只要计划里有一条成员记录已
 * 不可见，就整条作废。计划文件是重放窗口而不是权威账本，删掉它不会丢原文；
 * 留着它则会在崩溃窗口里把已遗忘成员的事实重新写成 L1/L2。
 */
export async function dropVoucherPlansForRecords(sessionDir, recordIds) {
  // 同 dropVoucherPlan：读-改-写整段进锁（W-01c）。
  return withWriteLock(sessionDir, () => dropVoucherPlansForRecordsUnlocked(sessionDir, recordIds))
}

async function dropVoucherPlansForRecordsUnlocked(sessionDir, recordIds) {
  const wanted = new Set((Array.isArray(recordIds) ? recordIds : []).filter((id) => typeof id === 'string' && id))
  const plans = await loadVoucherPlans(sessionDir)
  if (wanted.size === 0) return { dropped: [], kept: plans.length }
  const dropped = []
  const kept = []
  for (const plan of plans) {
    const ids = Array.isArray(plan?.recordIds) ? plan.recordIds : []
    const hit = ids.filter((id) => wanted.has(id))
    if (hit.length === 0) { kept.push(plan); continue }
    // T2/F-15：v2 计划按子集重放——只把被遗忘的成员移出参与集，其余照常。
    // 参与集被清空才整条作废（没有安全子集）。v1 计划（无 planSchema）保持整条作废。
    if (plan?.planSchema === AGG_VOUCHER_PLAN_SCHEMA) {
      const remaining = ids.filter((id) => !wanted.has(id))
      if (remaining.length > 0) {
        const excludedMembers = [...(Array.isArray(plan.excludedMembers) ? plan.excludedMembers : [])]
        for (const id of hit) {
          if (excludedMembers.some((member) => member?.recordId === id)) continue
          excludedMembers.push({ recordId: id, seq: null, reason: 'forgotten' })
        }
        kept.push(withMemberExclusions({ ...plan, recordIds: ids }, { excludedMembers }))
        continue
      }
    }
    dropped.push(plan.voucherId)
  }
  if (dropped.length === 0) return { dropped, kept: plans.length }
  await writeVoucherPlansUnlocked(sessionDir, kept)
  return { dropped, kept: kept.length }
}

export async function getVoucherPlan(sessionDir, voucherId) {
  const plans = await loadVoucherPlans(sessionDir)
  return plans.find((item) => item?.voucherId === voucherId) ?? null
}