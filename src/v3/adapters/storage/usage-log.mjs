import { appendFile, readFile } from 'node:fs/promises'
import path from 'node:path'

/** P2 usage 聚合通道（占用侧定标数据源）。行内 seq 查重幂等：重放（重开 engine/重启宿主）不双写。 */
export async function appendUsageLine(directory, seq, usage) {
  if (!directory) return
  const file = path.join(directory, 'usage.jsonl')
  let lastSeq = -1
  try {
    for (const line of (await readFile(file, 'utf8')).split('\n')) {
      if (!line.trim()) continue
      try {
        const s = JSON.parse(line).seq
        if (Number.isFinite(s) && s > lastSeq) lastSeq = s
      } catch {}
    }
  } catch {}
  if (!Number.isFinite(seq) || seq <= lastSeq) return
  await appendFile(file, JSON.stringify({ seq, ...usage }) + '\n', 'utf8')
}

/** usage 聚合读取：坏行跳过并计数；空/无文件返回 null。占用近似 = inputTokens + cacheReadTokens。 */
export async function readUsageSummary(directory) {
  if (!directory) return null
  let text
  const file = path.join(directory, 'usage.jsonl')
  try { text = await readFile(file, 'utf8') } catch { return null }
  const rows = []
  let bad = 0
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try { rows.push(JSON.parse(line)) } catch { bad += 1 }
  }
  if (rows.length === 0) return null
  const occupancy = rows.map((r) => (r.inputTokens ?? 0) + (r.cacheReadTokens ?? 0)).filter((n) => n > 0)
  const pct = (arr, p) => { const a = [...arr].sort((x, y) => x - y); return a.length ? a[Math.min(a.length - 1, Math.floor(a.length * p / 100))] : null }
  // p50 统计惯例：偶数样本取中间两值平均（pct 的 floor 取上界会高估中位）
  const median = (arr) => { const a = [...arr].sort((x, y) => x - y); if (!a.length) return null; const m = a.length >> 1; return a.length % 2 ? a[m] : Math.round((a[m - 1] + a[m]) / 2) }
  return {
    samples: rows.length,
    badLines: bad,
    occupancy: occupancy.length ? { p50: median(occupancy), p90: pct(occupancy, 90), p95: pct(occupancy, 95), max: Math.max(...occupancy), latest: occupancy.at(-1) } : null,
    totals: {
      inputTokens: rows.reduce((s, r) => s + (r.inputTokens ?? 0), 0),
      outputTokens: rows.reduce((s, r) => s + (r.outputTokens ?? 0), 0),
      cacheReadTokens: rows.reduce((s, r) => s + (r.cacheReadTokens ?? 0), 0),
      reasoningTokens: rows.reduce((s, r) => s + (r.reasoningTokens ?? 0), 0),
    },
  }
}
