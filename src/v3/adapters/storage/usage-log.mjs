import { appendFile, mkdir, open, readFile } from 'node:fs/promises'
import path from 'node:path'

/**
 * P2 usage 聚合通道（占用侧定标数据源）。行内 seq 查重幂等：重放（重开 engine/重启宿主）不双写。
 *
 * 两条纪律（H-04，2026-10-26）：
 * - **追加不得全量读**：幂等判据是「seq 严格递增」，只需知道文件里**最后一个** seq。
 *   从尾部读一块解析即可，成本与文件大小无关（旧实现每次追加都 readFile 整个 usage.jsonl，
 *   3000 次追加实测读盘约 299 MiB）；
 * - **统计不得展开参数**：`Math.max(...arr)` 在 20 万样本上直接 RangeError，
 *   读失败会被上层 catch 成 null —— 「读不到」被伪装成「没有」（观察面整段消失）。
 */
const TAIL_BYTES = 64 * 1024

/**
 * 从文件尾部读最后一条可解析记录的 seq，并报告文件是否以换行收尾。
 * 文件缺失 → { lastSeq: -1, endsWithNewline: true }（调用方据此判首次写入）；
 * 尾行半写/坏行 → 继续往前找，找不到就当 -1（不静默当作「有更大的 seq」）。
 * endsWithNewline 是追加前的**粘行判据**：半行残留（无收尾换行）时直接 append 会把新记录
 * 粘在坏行尾部，整行不可解析 → 新样本丢失。
 */
async function tailStateOf(file) {
  let handle
  try {
    handle = await open(file, 'r')
  } catch (error) {
    if (error?.code === 'ENOENT') return { lastSeq: -1, endsWithNewline: true }
    throw error
  }
  try {
    const { size } = await handle.stat()
    if (size === 0) return { lastSeq: -1, endsWithNewline: true }
    // 窗口从 64KiB 起，**解析不出任何行就倍增**（H-39）。
    //
    // 旧实现只读一次 64KiB 就下结论：尾块里一条可解析行都没有时返回 lastSeq=-1，
    // 而那是一个「文件里不存在更大的 seq」的断言——两者并不等价。触发形态不需要
    // 垃圾文件，只要**最后一条 usage 行本身 > 64KiB**（宿主多给了字段就会）：
    // 尾块从该行中间开始 → 解析失败 → 往前也没有行 → -1 → 下一条同 seq 的记录被重复写入
    // （实测：seq=2 出现两次，统计被污染）。
    //
    // 倍增而不是「失败关闭」，是因为这里能**确定地**读到答案：窗口迟早覆盖全文件。
    // 「追加不得全量读」的纪律仍然成立——正常情况（每条几百字节）一次 64KiB 就读完了，
    // 只有病态的超大行才多读几次，成本与该行的长度成正比，与文件总大小无关。
    let readBytes = Math.min(size, TAIL_BYTES)
    let endsWithNewline = true
    for (;;) {
      const buffer = Buffer.alloc(readBytes)
      await handle.read(buffer, 0, readBytes, size - readBytes)
      if (readBytes === Math.min(size, TAIL_BYTES)) {
        // 只看一次：文件最后一个字节是否换行（与窗口大小无关）
        endsWithNewline = buffer[readBytes - 1] === 0x0a
      }
      const lines = buffer.toString('utf8').split('\n')
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const line = lines[i].trim()
        if (line.length === 0) continue
        try {
          const parsed = JSON.parse(line)
          if (Number.isFinite(parsed?.seq)) return { lastSeq: parsed.seq, endsWithNewline }
        } catch {
          // 尾行半写/坏行：继续往前找
        }
      }
      // 窗口已覆盖全文件仍无可解析行：此时 -1 才是真话（文件里确实没有可用的 seq）
      if (readBytes >= size) return { lastSeq: -1, endsWithNewline }
      readBytes = Math.min(size, readBytes * 2)
    }
  } finally {
    await handle.close().catch(() => {})
  }
}

export async function appendUsageLine(directory, seq, usage) {
  if (!directory) return
  if (!Number.isFinite(seq)) return
  const file = path.join(directory, 'usage.jsonl')
  const { lastSeq, endsWithNewline } = await tailStateOf(file)
  if (seq <= lastSeq) return
  await mkdir(path.dirname(file), { recursive: true })
  // 半行残留时先补换行，否则新记录会粘在坏行尾部一起变成不可解析（H-04c）
  const prefix = endsWithNewline ? '' : '\n'
  await appendFile(file, prefix + JSON.stringify({ seq, ...usage }) + '\n', 'utf8')
}

/** usage 样本的字段白名单（读侧归一与写侧提取共用同一份口径）。 */
const USAGE_FIELDS = ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'reasoningTokens']

/** 百分位（最近秩法，量纲无关的整数口径）。 */
function percentileOf(sorted, p) {
  if (sorted.length === 0) return null
  const idx = Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100))
  return sorted[idx]
}

/** 中位数：偶数样本取中间两值平均（与旧口径一致）。 */
function medianOf(sorted) {
  if (sorted.length === 0) return null
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2)
}

/** usage 聚合读取：坏行跳过并计数；空/无文件返回 null。占用近似 = inputTokens + cacheReadTokens。 */
export async function readUsageSummary(directory) {
  if (!directory) return null
  let text
  const file = path.join(directory, 'usage.jsonl')
  try { text = await readFile(file, 'utf8') } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error // 读不到 ≠ 没有（EACCES/EMFILE 不得伪装成「无样本」）
  }
  const rows = []
  let bad = 0
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let parsed
    try { parsed = JSON.parse(line) } catch { bad += 1; continue }
    // H-48/H-49/H-50：合法 JSON 不等于合法样本。`null` 会让 (r.inputTokens) 抛
    // TypeError 打挂整个聚合；`"abc"` 会让 `0 + 'abc'` 变成字符串 "0abc"；
    // 负数会让总额求和成 -70 并被当成事实报出去。一律按**非负有限数**白名单归一，
    // 不合规的字段按缺失处理（与 appendUsageLine 的写入侧口径同源）。
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) { bad += 1; continue }
    const row = { seq: Number.isFinite(parsed.seq) ? parsed.seq : null }
    let usable = 0
    for (const field of USAGE_FIELDS) {
      const value = parsed[field]
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
        row[field] = value
        usable += 1
      }
    }
    // 一个可用数值都没有的行不构成样本（与提取侧「至少 2 个字段才算 usage」同源）
    if (usable === 0) { bad += 1; continue }
    rows.push(row)
  }
  if (rows.length === 0) return null
  const occupancy = rows.map((r) => (r.inputTokens ?? 0) + (r.cacheReadTokens ?? 0)).filter((n) => n > 0)
  const sorted = [...occupancy].sort((a, b) => a - b)
  return {
    samples: rows.length,
    badLines: bad,
    occupancy: sorted.length
      ? {
        p50: medianOf(sorted),
        p90: percentileOf(sorted, 90),
        p95: percentileOf(sorted, 95),
        // 不得用 Math.max(...arr) 展开：20 万样本即 RangeError（H-04b）
        max: sorted[sorted.length - 1],
        latest: occupancy.at(-1),
      }
      : null,
    totals: {
      inputTokens: rows.reduce((s, r) => s + (r.inputTokens ?? 0), 0),
      outputTokens: rows.reduce((s, r) => s + (r.outputTokens ?? 0), 0),
      cacheReadTokens: rows.reduce((s, r) => s + (r.cacheReadTokens ?? 0), 0),
      reasoningTokens: rows.reduce((s, r) => s + (r.reasoningTokens ?? 0), 0),
    },
  }
}
