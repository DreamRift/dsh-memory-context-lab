/**
 * P4-3 模型模式侧车账本：摘要缓存与费用账本。
 *
 * 两份都是会话隔离根下的 JSONL 侧车（LF、append-only，与 hierarchy 账本同一
 * 文件纪律）：
 * - model-summary-cache.jsonl：模型摘要缓存行 { key, blocksHash, text, model, at }。
 *   命中必须 key 与 blocksHash **双匹配**——来源变了（程序选块不同）即视为过期，
 *   不返回旧正文。
 * - model-usage.jsonl：费用账本行 { at, model, usage, cacheHit }。观察面：
 *   落账失败不阻断压缩，读坏了不拦截检索。
 *
 * 撕裂行（append 中途崩溃的半行）读取时跳过，不重写——append-only 缓存
 * 丢一行只影响一次命中率，不值得引入重写事务。
 */

import { mkdir, appendFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { InvalidArgumentError } from '../errors.mjs'

export const MODEL_CACHE_FILE = 'model-summary-cache.jsonl'
export const MODEL_USAGE_FILE = 'model-usage.jsonl'

/** 追加一行 JSONL（LF 结尾；目录不存在则创建）。 */
async function appendLedgerLine(sessionDir, fileName, payload) {
  if (!sessionDir || typeof sessionDir !== 'string') throw new InvalidArgumentError('model-ledger：缺少 sessionDir')
  await mkdir(sessionDir, { recursive: true })
  await appendFile(join(sessionDir, fileName), JSON.stringify(payload) + '\n', 'utf8')
}

/** 解析 JSONL 侧车：坏行跳过；文件不存在返回空数组（ENOENT 是常态不是错误）。 */
async function readLedgerLines(sessionDir, fileName) {
  let raw
  try {
    raw = await readFile(join(sessionDir, fileName), 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  const rows = []
  for (const line of raw.split('\n')) {
    if (line.length === 0) continue
    try {
      const parsed = JSON.parse(line)
      if (parsed && typeof parsed === 'object') rows.push(parsed)
    } catch {
      // 撕裂/损坏行：跳过。
    }
  }
  return rows
}

/** 追加一条模型摘要缓存（text 或 lines 至少一项；usage 原样透传）。 */
export function appendModelCacheEntry(sessionDir, entry) {
  const payload = {
    key: String(entry?.key ?? ''),
    blocksHash: String(entry?.blocksHash ?? ''),
    text: entry?.text == null ? null : String(entry.text),
    model: entry?.model == null ? null : String(entry.model),
    at: String(entry?.at ?? new Date().toISOString()),
  }
  if (Array.isArray(entry?.lines)) payload.lines = entry.lines
  if (entry?.usage != null) payload.usage = entry.usage
  return appendLedgerLine(sessionDir, MODEL_CACHE_FILE, payload)
}

/**
 * 查缓存：返回与 key、blocksHash 双匹配的最新一行 { text, lines, usage }；
 * 没有就 null。usage 原样透传（可能是 null）——缓存命中也要如实落账（那次
 * 调用真实花过钱）。lines 是机械校验通过的行列表（新格式），text 是 JSON
 * 正文（兼容格式）；消费方按自身格式解析。
 */
export async function readModelCacheEntry(sessionDir, key, blocksHash) {
  if (!key || !blocksHash) return null
  const rows = await readLedgerLines(sessionDir, MODEL_CACHE_FILE)
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]
    if (row.key !== key || row.blocksHash !== blocksHash) continue
    const hasText = typeof row.text === 'string' && row.text.length > 0
    const hasLines = Array.isArray(row.lines) && row.lines.length > 0
    if (hasText || hasLines) {
      return { text: hasText ? row.text : null, lines: hasLines ? row.lines : null, usage: row.usage ?? null, at: row.at ?? null, model: row.model ?? null }
    }
  }
  return null
}

/** 追加一条费用账本（usage 是宿主返回的原始 usage 对象，不规整它）。 */
export function appendModelUsageEntry(sessionDir, entry) {
  return appendLedgerLine(sessionDir, MODEL_USAGE_FILE, {
    at: String(entry?.at ?? new Date().toISOString()),
    model: entry?.model == null ? null : String(entry.model),
    usage: entry?.usage ?? null,
    cacheHit: entry?.cacheHit === true,
  })
}

/** 读费用账本（倒序返回最近 limit 条，默认 50；status 面与 P5 预算提案用）。 */
export async function readModelUsageEntries(sessionDir, { limit = 50 } = {}) {
  const rows = await readLedgerLines(sessionDir, MODEL_USAGE_FILE)
  return rows.slice(-Math.max(1, Number(limit) || 50)).reverse()
}
