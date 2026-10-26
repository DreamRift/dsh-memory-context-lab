/**
 * P0-3（beta.9）：批次回执两态生命周期 + Z-01 模板压缩判定。
 *
 * 缺陷来源：修复计划-beta.9 P0-3——beta.6 会话 82e24b72 实测 537 条回执 / 192KB，
 * 回执注入后永不回收；台账 Z-01：可回读/命令面/hash 三行约占回执开销 47%。
 *
 * 两态：明细回执（批次摘要，最近 `RECEIPT_DETAIL_KEEP` 条）与合并回执
 * （一行一批，`RECEIPT_MERGED_MAX_LINES` 行封顶，最老的转计数占位行）。
 * 收敛 = 把超出的明细节点 `surfaceOp.replace` 成一行合并行：节点数不变、
 * 字符大减；宿主拒绝 replace 时该节点保持明细原样（fail-visible，调用方
 * 计 `receiptMergeFallbacks`），下次收敛再试。合并行与占位行都是纯函数
 * 渲染（无时间戳、无动态统计），重复渲染字节一致，不扰动前缀缓存。
 *
 * 信息边界：合并行携带成员数与首条冷记录 id（回读入口）；被占位行替代的
 * 批次 id 不在活动面上，但归档行（冷库）仍是唯一权威副本，`/memory-lab
 * restore` 按 seq 取回——占位行明说这一点，不假装信息还在。
 */

/** 明细批次回执保留条数（最近 N 批）。 */
import { PLUGIN_SOURCE_FORMS } from '../core.mjs'

export const RECEIPT_DETAIL_KEEP = 5
/** 合并行上限；超出把最老的转占位行。 */
export const RECEIPT_MERGED_MAX_LINES = 20
/** 合并行的识别标记（解析活动面时用；纯文本，无 {{）。 */
export const MERGED_LINE_MARKER = '批次 seq '
/** 占位行的识别标记。 */
export const PLACEHOLDER_LINE_MARKER = '批次占位：更早批次已并入'
const PLACEHOLDER_LINE = '- ' + PLACEHOLDER_LINE_MARKER + '；原文可 /memory-lab restore 按 seq 取回。'

/**
 * 活动面上的明细批次回执节点（seq 升序 = 旧→新）。
 *
 * 识别判据：插件表面事件（form = SURFACE_RECEIPT 形态）+ 文本含批次归档头
 * 「批次归档：」。合并行/占位行不含该头，天然被排除。
 */
export function detailReceiptNodesOf(session) {
  const nodes = Array.isArray(session?.surface?.nodes) ? session.surface.nodes : []
  const out = []
  for (const seq of nodes) {
    const event = typeof session?.eventAt === 'function' ? session.eventAt(seq) : null
    if (event?.type !== 'user/message') continue
    const form = event?.data?.source?.form ?? event?.source?.form
    if (form !== PLUGIN_SOURCE_FORMS.SURFACE_RECEIPT) continue
    const text = (event.data?.content ?? []).find((block) => block?.type === 'text')?.text ?? ''
    if (typeof text !== 'string' || !text.includes('批次归档：')) continue
    out.push({ seq, text })
  }
  return out
}

/** 解析一条明细批次回执：成员冷记录 id、成员数、seq 范围、释放 token 估算。 */
export function parseDetailReceipt(text) {
  const body = String(text ?? '')
  const nodeIds = [...body.matchAll(/冷记录 (\S+)/g)].map((m) => m[1]).filter((id) => id !== '(unknown)')
  const spans = [...body.matchAll(/seq (\d+)[–-](\d+)/g)].map((m) => [Number(m[1]), Number(m[2])])
  // 不得用 Math.min(...arr) 展开参数（H-16）：回执正文规模不受控（逐条列 seq 的明细回执、
  // 或用户/工具正文里出现大量 "seq a–b"），20 万段即 RangeError: Maximum call stack size exceeded。
  let seqStart = null
  let seqEnd = null
  for (const [start, end] of spans) {
    if (seqStart === null || start < seqStart) seqStart = start
    if (seqEnd === null || end > seqEnd) seqEnd = end
  }
  const tokens = [...body.matchAll(/原 ≈(\d+) token/g)].reduce((sum, m) => sum + Number(m[1]), 0)
  const head = /批次归档：本批 (\d+)\/(\d+)/.exec(body)
  const members = head ? Number(head[1]) : nodeIds.length
  return { nodeIds, members, seqStart, seqEnd, releasedTokens: tokens }
}

/** 一条合并行（纯函数：同样解析结果渲染字节一致）。 */
export function mergedLineOf(batch) {
  const first = batch.nodeIds[0] ?? '(unknown)'
  const range = batch.seqStart !== null ? `seq ${batch.seqStart}–${batch.seqEnd}` : 'seq 未知'
  return `- ${MERGED_LINE_MARKER}${range}：${batch.members} 个操作，冷记录 ${first}…（共 ${batch.members} 条），释放 ≈${batch.releasedTokens} token`
}

/** 活动面上的合并行计数（占位行不计——它替代一行而非新增一行）。 */
export function mergedLineCountOf(session) {
  const nodes = Array.isArray(session?.surface?.nodes) ? session.surface.nodes : []
  let count = 0
  for (const seq of nodes) {
    const event = typeof session?.eventAt === 'function' ? session.eventAt(seq) : null
    if (event?.type !== 'user/message') continue
    const form = event?.data?.source?.form ?? event?.source?.form
    if (form !== PLUGIN_SOURCE_FORMS.SURFACE_RECEIPT) continue
    const text = (event.data?.content ?? []).find((block) => block?.type === 'text')?.text ?? ''
    if (text.includes(MERGED_LINE_MARKER) && !text.includes('批次归档：')) count += 1
  }
  return count
}

/** 面上的合并行节点（seq 升序），供占位收敛挑最老。 */
function mergedLineNodesOf(session) {
  const nodes = Array.isArray(session?.surface?.nodes) ? session.surface.nodes : []
  const out = []
  for (const seq of nodes) {
    const event = typeof session?.eventAt === 'function' ? session.eventAt(seq) : null
    if (event?.type !== 'user/message') continue
    const form = event?.data?.source?.form ?? event?.source?.form
    if (form !== PLUGIN_SOURCE_FORMS.SURFACE_RECEIPT) continue
    const text = (event.data?.content ?? []).find((block) => block?.type === 'text')?.text ?? ''
    if (text.includes(MERGED_LINE_MARKER) && !text.includes('批次归档：')) out.push({ seq, text })
  }
  return out
}

/**
 * 收敛一次。返回 { merged, fallbacks, releasedChars }：
 * - merged：本次成功转合并行的明细条数；
 * - fallbacks：宿主拒绝 replace 的次数（调用方记 `receiptMergeFallbacks`）；
 * - releasedChars：本次收敛净释放的回执字符数（明细文本 − 合并行文本之和）。
 */
export function consolidateReceipts(session, { pluginSourceKind } = {}) {
  let merged = 0
  let fallbacks = 0
  let releasedChars = 0
  let details = detailReceiptNodesOf(session)
  while (details.length > RECEIPT_DETAIL_KEEP) {
    const oldest = details[0]
    const batch = parseDetailReceipt(oldest.text)
    const line = mergedLineOf(batch)
    const ok = replaceSurfaceText(session, oldest.seq, line, { pluginSourceKind })
    if (!ok) {
      fallbacks += 1
      break
    }
    releasedChars += Math.max(0, oldest.text.length - line.length)
    merged += 1
    details = detailReceiptNodesOf(session)
  }
  // 合并行 > 上限：最老的合并行转占位行（净行数回到上限内）。
  let lines = mergedLineCountOf(session)
  while (lines > RECEIPT_MERGED_MAX_LINES) {
    const oldestLine = mergedLineNodesOf(session)[0]
    if (!oldestLine) break
    const ok = replaceSurfaceText(session, oldestLine.seq, PLACEHOLDER_LINE, { pluginSourceKind })
    if (!ok) {
      fallbacks += 1
      break
    }
    releasedChars += Math.max(0, oldestLine.text.length - PLACEHOLDER_LINE.length)
    lines -= 1
  }
  return { merged, fallbacks, releasedChars }
}

/** 把一个表面节点 replace 成新文本；宿主拒绝/抛错返回 false（调用方计数）。 */
function replaceSurfaceText(session, seq, text, { pluginSourceKind }) {
  try {
    session.append('user/message', {
      id: 'surface-receipt-merge-' + String(seq),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: pluginSourceKind ?? 'dsh-memory-context-lab', form: PLUGIN_SOURCE_FORMS.SURFACE_RECEIPT },
    }, {
      surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq },
      sourceEventSeqs: [seq],
    })
    return true
  } catch {
    return false
  }
}

/**
 * Z-01：本会话回执是否走 slim 模板。
 *
 * `receiptSamplePrinted` 未置位 = 本会话第一批 → 全样例（可回读/命令面/hash 行
 * 全印，让模型见过一次完整形态）；置位后 → slim（`read:` 单行、无 hash 行）。
 * 置位点在生产批次归档完成处（runtime），幂等：重复置位无副作用。
 */
export function slimStyleOf(state) {
  return state?.receiptSamplePrinted === true ? 'slim' : 'full'
}
