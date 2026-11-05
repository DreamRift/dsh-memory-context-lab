import { appendFile, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

import {
  CACHE_TOKENS_CONTRACT_VERSION,
  USAGE_CACHE_FIELDS,
  buildCacheObservation,
  projectionSeedOf,
  readObservationRowOf,
  sanitizeCacheObservation,
} from '../../contracts/cache-observation.mjs'
import { sessionRefOf } from '../../contracts/observation-lifecycle.mjs'
import { POLICY_INPUT_PORT, sanitizePolicyInput } from '../../contracts/observation-policy-port.mjs'
import { withCrossProcessWriteLock } from './write-lock.mjs'

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
 * 从文件尾部读最后一条可解析记录的 seq、文件是否以换行收尾，以及**可用的投影种子**
 * （窗口内最后一条**合同版本合格**的观测行；判据唯一实现在合同层的 `projectionSeedOf`）。
 * 文件缺失 → { lastSeq: -1, endsWithNewline: true, lastSurface: null }（调用方据此判首次写入）；
 * 尾行半写/坏行 → 继续往前找，找不到就当 -1（不静默当作「有更大的 seq」）。
 * endsWithNewline 是追加前的**粘行判据**：半行残留（无收尾换行）时直接 append 会把新记录
 * 粘在坏行尾部，整行不可解析 → 新样本丢失。
 *
 * **投影种子只在确定 lastSeq 的同一窗口内找**：为找种子而继续扩大窗口，会让旧大会话在
 * 每次建条目时读整个账本（P2-b 之前的历史行可能一条种子都没有）。找不到就是 null，
 * 不把「本窗口没看到」说成「从来没有」——调用方据此把首次观测标成 initial。
 */
async function tailStateOf(file) {
  let handle
  try {
    handle = await open(file, 'r')
  } catch (error) {
    if (error?.code === 'ENOENT') return { lastSeq: -1, endsWithNewline: true, lastSurface: null }
    throw error
  }
  try {
    const { size } = await handle.stat()
    if (size === 0) return { lastSeq: -1, endsWithNewline: true, lastSurface: null }
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
      let lastSeq = null
      let lastSurface = null
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const line = lines[i].trim()
        if (line.length === 0) continue
        let parsed
        try {
          parsed = JSON.parse(line)
        } catch {
          // 尾行半写/坏行：继续往前找
          continue
        }
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue
        if (lastSeq === null && Number.isFinite(parsed.seq)) lastSeq = parsed.seq
        // 种子判据（合同版本 / 指纹 / epoch / 消息链）只在合同层那一份实现里，
        // 这里不重抄正则或形状；不合格的行当作「本行没有种子」，继续往前找。
        if (lastSurface === null) lastSurface = projectionSeedOf(parsed)
      }
      // 首窗口内已确定最后 seq：种子只在本窗口里找，找不到就是 null——不为找种子扩大窗口
      // （旧大会话可能一条 v3 种子都没有，扩大窗口会退化成每次建条目读整本账）。
      if (lastSeq !== null) return { lastSeq, endsWithNewline, lastSurface }
      // 窗口已覆盖全文件仍无可解析行：此时 -1 才是真话（文件里确实没有可用的 seq）
      if (readBytes >= size) return { lastSeq: -1, endsWithNewline, lastSurface }
      readBytes = Math.min(size, readBytes * 2)
    }
  } finally {
    await handle.close().catch(() => {})
  }
}

/**
 * usage 账本的**有界保留**（M1，2026-11-04 审计：旧实现无上限，长会话聚合全量读，
 * 内存随会话线性增长）。与观测账本同一套取舍：按字节上限 + 行数上限，追加时顺手压实。
 * 容量比观测账本大（usage 是统计口径，行更短、保留更多样本）。
 */
export const USAGE_RETENTION = Object.freeze({ maxBytes: 1024 * 1024, keepRows: 4096 })

/**
 * 追加一行 usage。
 *
 * M1 两条修复：
 * - **进跨进程写锁**：旧实现「读尾判 seq → 追加」在锁外，两进程同 seq 都通过检查
 *   （实测 3 行同 seq → samples=3 / inputTokens×3）；同文件 appendCacheObservation 早已
 *   进锁，usage 是遗漏的一路；
 * - **有界保留**：超过上限时在锁内压实到「最后 N 行且不超过上限」。
 */
export async function appendUsageLine(directory, seq, usage) {
  if (!directory) return
  if (!Number.isFinite(seq)) return
  const file = path.join(directory, 'usage.jsonl')
  await withCrossProcessWriteLock(directory, async (ownership) => {
    const { lastSeq, endsWithNewline } = await tailStateOf(file)
    if (seq <= lastSeq) return
    ownership.assertOwned()
    await mkdir(path.dirname(file), { recursive: true })
    // 半行残留时先补换行，否则新记录会粘在坏行尾部一起变成不可解析（H-04c）
    const prefix = endsWithNewline ? '' : '\n'
    await appendFile(file, prefix + JSON.stringify({ seq, ...usage }) + '\n', 'utf8')
    try {
      const { size } = await stat(file)
      if (size > USAGE_RETENTION.maxBytes) await pruneUsageLedger(directory)
    } catch { /* 清理是旁路：失败不改本行结果，下次追加再试 */ }
  })
}

/** 锁内压实 usage 账本（只保留完整行；原子写回）。 */
async function pruneUsageLedger(directory) {
  const file = path.join(directory, 'usage.jsonl')
  let text
  try { text = await readFile(file, 'utf8') } catch (error) {
    if (error?.code === 'ENOENT') return { ok: true, kept: 0, removed: 0 }
    return { ok: false, error: error?.code ?? String(error) }
  }
  const rows = text.split('\n').slice(0, -1).filter((line) => line.trim().length > 0)
  const keep = []
  let bytes = 0
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const line = rows[index]
    if (keep.length >= USAGE_RETENTION.keepRows) break
    const cost = Buffer.byteLength(line, 'utf8') + 1
    if (keep.length > 0 && bytes + cost > USAGE_RETENTION.maxBytes) break
    keep.unshift(line)
    bytes += cost
  }
  const removed = rows.length - keep.length
  if (removed <= 0) return { ok: true, kept: rows.length, removed: 0 }
  const temporary = file + '.compact-' + process.pid + '-' + Date.now()
  await writeFile(temporary, keep.join('\n') + '\n', 'utf8')
  await rename(temporary, file)
  return { ok: true, kept: keep.length, removed }
}

/**
 * usage 样本的字段白名单（**只含真实 token 字段**）。
 *
 * 0.15.0（P2 最小缓存观测）：`cacheWriteTokens` 原先读侧被静默丢弃（宿主 TokenUsage 有它）。
 * 字段集由 contracts 的 `USAGE_CACHE_FIELDS` 派生，**不在这里另抄一份**：
 * 单一真源纪律——新增字段只改合同模块，读写两侧自动跟随。
 *
 * `stepToFirstToken` 属**独立观测**（合同 `measurement` 段、`cache-observations.jsonl`），
 * 不是 usage 账本的 token 字段——不得再出现在这里的白名单里，否则只带时间戳的行
 * 会被当成 token 样本，聚合就凭一个非 token 字段输出了「延迟」事实。
 */
const USAGE_FIELDS = [...USAGE_CACHE_FIELDS]

/**
 * 新口径聚合的字段集：**缺失 = null**（不写 0）。包含 totalTokens/cacheWriteTokens
 * ——这两项在旧 totals 里根本不存在，正是「静默丢弃」的落点。
 * 不含任何延迟量：延迟走 `measurement.stepToFirstToken`，不混进 token 汇总。
 */
const CACHE_TOTAL_FIELDS = ['totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']

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

/**
 * usage 聚合读取：坏行跳过并计数。占用近似 = inputTokens + cacheReadTokens。
 *
 * 返回 `null` 只表示**真的没有样本可读**：目录未给、文件不存在、文件里一行非空内容都没有。
 * P3-02（0.15.1 独立排查报告 §3.3）：旧实现在「有行、但每一行都是坏行」时也返回 null——
 * 与「没有样本」完全同形，`badLines` 连同「这本账已经读不出东西了」这一事实一起消失。
 * 观察面于是把「10 行全坏」显示成「没有 usage 样本」，而这正是 H-48 能长期潜伏的同类盲区。
 * 现在只要有非空行，就一定返回带 `badLines` 的对象；全坏时 `samples === 0`、
 * `usable === false` 由调用方显式判读（占用/冷却闸门自然拿不到 latest → 不开闸）。
 *
 * @returns {Promise<null|object>} null = 无样本可读；否则 samples 可能为 0（全坏）
 */
export async function readUsageSummary(directory) {
  if (!directory) return null
  let text
  const file = path.join(directory, 'usage.jsonl')
  try { text = await readFile(file, 'utf8') } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error // 读不到 ≠ 没有（EACCES/EMFILE 不得伪装成「无样本」）
  }
  let rows = []
  let bad = 0
  // M1：按 seq 去重（后写覆盖先写）。旧实现逐行 push，历史重复行会让 samples 与
  // token 汇总整体翻倍；去重同时把重复行数单列，避免「少了几行」变成不可见。
  const bySeq = new Map()
  let duplicates = 0
  // P2-03：无整数 seq 的行需要一个**逐行唯一**的键。旧实现用 `'row-' + rows.length`，
  // 而 `rows` 在循环里恒为空数组（`rows = Array.from(bySeq.values())` 在循环之后才执行），
  // 于是所有无 seq 行都落到同一个键 `row-0` 上互相覆盖——实测应 1000 报 500。
  // 行序号是稳定的行身份：既不与 seq 冲突（前缀不同），也不随落盘顺序变化。
  let rowOrdinal = 0
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
    if (Number.isInteger(row.seq) && bySeq.has(row.seq)) duplicates += 1
    // 有整数 seq 的按 seq 去重（后写覆盖先写）；无 seq 的按行序号各自成样本（无法判定重复）。
    bySeq.set(Number.isInteger(row.seq) ? row.seq : 'row-' + (rowOrdinal += 1), row)
  }
  rows = Array.from(bySeq.values())
  // P3-02：只有「一行非空内容都没有」才是真的没样本（上面 ENOENT 已返回 null）。
  // 到这里说明文件里确实有行；全坏也要如实返回，让 badLines 有机会被看见。
  if (rows.length === 0 && bad === 0) return null
  // 全坏行（或全部行都只有 seq、没有可用 token）时 rows 为空：占用统计没有样本可算。
  // P3-02：不能因此退回 null——那会和「这本账不存在」同形；occupancy=null 才是诚实口径。
  const occupancy = rows.map((r) => (r.inputTokens ?? 0) + (r.cacheReadTokens ?? 0)).filter((n) => n > 0)
  const sorted = [...occupancy].sort((a, b) => a - b)
  return {
    samples: rows.length,
    badLines: bad,
    // P3-02：本账是否还能给出样本。false 只由「有行但全坏」产生（坏行不静默）。
    usable: rows.length > 0,
    duplicateRows: duplicates,
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
      // 既有键保持原形状（求和口径，缺失按 0）——不动既有命令语义。
      // 主复审④：**不**在这里新增 cacheWriteTokens / ttftMs——旧键没有生产方也没有消费者，
      // 新增一个「名为兼容却本来不存在」的字段只会误导；新口径统一放 summary.cache。
      inputTokens: rows.reduce((s, r) => s + (r.inputTokens ?? 0), 0),
      outputTokens: rows.reduce((s, r) => s + (r.outputTokens ?? 0), 0),
      cacheReadTokens: rows.reduce((s, r) => s + (r.cacheReadTokens ?? 0), 0),
      reasoningTokens: rows.reduce((s, r) => s + (r.reasoningTokens ?? 0), 0),
    },
    // 诚实口径（与上面 totals 并存）：缺失 = null，不写 0。
    // availability 逐字段说明「本会话样本里有没有这个字段」，totals 只对出现过的字段求和。
    cache: {
      contractVersion: CACHE_TOKENS_CONTRACT_VERSION,
      availability: availabilityOf(rows),
      totals: cacheTotalsOf(rows),
      samplesWithCacheRead: rows.filter((r) => Number.isFinite(r.cacheReadTokens)).length,
      samplesWithCacheWrite: rows.filter((r) => Number.isFinite(r.cacheWriteTokens)).length,
    },
  }
}

/**
 * 逐字段 availability：`present` = 至少一条样本带该字段；`missing` = 一条都没有。
 * 这是「本会话有没有观测到」的**计数事实**，不是供应商能力断言。
 */
function availabilityOf(rows) {
  const out = {}
  for (const field of USAGE_CACHE_FIELDS) {
    const seen = rows.filter((row) => Number.isFinite(row[field])).length
    out[field] = seen > 0 ? 'present' : 'missing'
  }
  return out
}

/** 诚实 totals：只对**出现过**的字段求和；一个样本都没有的字段返回 null（不是 0）。 */
function cacheTotalsOf(rows) {
  const out = {}
  for (const field of CACHE_TOTAL_FIELDS) {
    const values = rows.map((row) => row[field]).filter((value) => Number.isFinite(value))
    out[field] = values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0)
  }
  return out
}
/**
 * 观测账本（P2 最小缓存观测的第二路）：`cache-observations.jsonl`，与会话同目录、append-only。
 *
 * 为什么不塞进 `usage.jsonl`：usage 行是**占用侧**样本（一请求一行、只留 token），
 * 观测行多带范围/指纹/代际/归档关联。两者消费者不同、失败域也不同——
 * 观测写坏不得污染占用聚合（反过来也一样）。目录与 `usage.jsonl` 相同，**不新建数据库**。
 *
 * 四条纪律：
 * - **`buildCacheObservation` 是唯一构造入口**：调用方只给原始 usage / 可选的投影面，
 *   重算与形状都由合同层负责（entry 接线方不需要自己拼记录）；
 * - **`sanitizeCacheObservation` 再校验一次**：账本只收合同形状，未知/恶意字段拒绝；
 * - **失败可见但不抛出**：观测是旁路，失败返回 `{ok:false, error}`，由调用方决定是否告警；
 * - **锁内 check + append（⑧）**：`tailStateOf` 读与追加之间存在窗口，仅靠「seq 严格递增」
 *   只在串行成立；本实现把两者放进**同一把会话跨进程写锁**（与 store 同一锁域，
 *   不新增锁目录），因此同 seq 并发调用也只会落一行。
 */
const OBSERVATION_FILE = 'cache-observations.jsonl'

/**
 * 诊断数据的**有界保留**（开发流程 §9.6：按会话隔离、限量保留、纳入 forget 清理）。
 *
 * 触发是**字节上限**：正常一行几百字节，256 KiB 已够数千次请求的观测；
 * 超过就在锁内压实到「最后 N 行且不超过上限」。行数上限（512）在压实同时生效，
 * 避免"一行很小但行数极多"的病态文件拖慢尾部读取。
 *
 * 为什么不用定期清理：本插件没有后台调度器，也**不该**为诊断数据引入一个；
 * 追加路径顺手压实的成本是一次 stat，与文件大小无关。
 */
export const OBSERVATION_RETENTION = Object.freeze({ maxBytes: 256 * 1024, keepRows: 512 })

/** policy 输入只读尾窗口的上限（与追加侧的幂等窗口同量级；不为汇总读整本账）。 */
const POLICY_READ_BYTES = 256 * 1024

/**
 * 追加一条观测记录。
 *
 * @param {string|null|undefined} directory 会话目录（`runtime.store.directory`）
 * @param {number} seq 宿主事件 seq（幂等键；非有限数按「不适用」安静返回）
 * @param {object} input `buildCacheObservation` 的入参（`{usage, timing?, scope?, surface?, ...}`）
 * @returns {Promise<{ok:true, appended:boolean, projection?:object}|{ok:false, error:string}>}
 *   只有 `appended:true` 才带 `projection`（下一次比较的前值）；跳过行不带。
 */
export async function appendCacheObservation(directory, seq, input) {
  // 不适用（无目录 / 无 seq）：与 appendUsageLine 同口径，安静返回且不建文件
  if (!directory) return { ok: true, appended: false }
  if (!Number.isFinite(seq)) return { ok: true, appended: false }
  try {
    const built = buildCacheObservation(input)
    if (built.ok !== true) return { ok: false, error: built.reason }
    const sanitized = sanitizeCacheObservation(built.record)
    if (sanitized.ok !== true) return { ok: false, error: sanitized.reason }
    const file = path.join(directory, OBSERVATION_FILE)
    // ⑧ 锁内完成「读尾 → 判 seq → 追加」：跨进程/并发同 seq 都只有一个写入者成功。
    // ①（主复审）：必须用上 ownership 并在**写盘之前**复核——锁在本事务期间被接管后，
    // 新增写原语若忽略 ownership，就退回了 beta.54 已修的失锁传播漏洞。
    return await withCrossProcessWriteLock(directory, async (ownership) => {
      const { lastSeq, endsWithNewline } = await tailStateOf(file)
      // projection 是**下一次比较的前值**（进程内链，不落盘）：只有真正落账的行才把它
      // 交回调用方。跳过分支（seq 回退/重放）**不带 projection**——否则未落账的投影会
      // 变成内存前值，下一次比较凭空多推进一个 epoch（账本里没有、内存里多出来的偏移）。
      const projection = built.projection ?? null
      if (seq <= lastSeq) return { ok: true, appended: false }
      ownership.assertOwned() // 提交前复核：失锁则抛 ELOCK_LOST（被 catch 成结构化 error），字节不变
      await mkdir(path.dirname(file), { recursive: true })
      const prefix = endsWithNewline ? '' : '\n'
      await appendFile(file, prefix + JSON.stringify({ seq, ...sanitized.record }) + '\n', 'utf8')
      // 有界保留：只在真的超上限时压实（一次 stat 的成本，与文件大小无关）。
      // 失败只影响本行之外的清理，不把已经落盘的观测说成失败。
      try {
        const { size } = await stat(file)
        if (size > OBSERVATION_RETENTION.maxBytes) await pruneCacheObservationLedger(directory)
      } catch { /* 清理是旁路：失败不改本行结果，下次追加再试 */ }
      return { ok: true, appended: true, projection }
    })
  } catch (error) {
    return { ok: false, error: error?.code ?? error?.message ?? String(error) }
  }
}

/**
 * 读账本尾部的**投影种子**（P2-b 跨进程代际链）：窗口内最后一条**合同版本合格**的
 * 观测行（`projectionSeedOf` 判定）的 `{epoch, fingerprint, digest:{messageChain}}`。
 *
 * 只读、只读尾部窗口；文件缺失/窗口内没有合格行 → null（不伪造 initial 之外的结论；
 * 种子在窗口外同样得到 null ⇒ 下次观测 `initial`、epoch 从 0 起算）。
 * 逐消息摘要不落盘，因此重启后的第一次比较只能用「消息链前缀」判追加/改写，
 * `firstDivergence` 为 null——这一边界写在专题文档里，不在这里猜。
 */
export async function readCacheProjectionState(directory) {
  if (!directory) return null
  const file = path.join(directory, OBSERVATION_FILE)
  const { lastSurface } = await tailStateOf(file)
  return lastSurface
}

/**
 * 诊断账本的**压实 / 清理**（开发流程 §9.6：限量保留 + 纳入 forget 清理）。
 *
 * - 正常路径：追加后超字节上限时由 `appendCacheObservation` 在**同一把会话写锁**内调用
 *   （重入合法，见 `v3-cache-observation` 的 F8）；
 * - forget 路径（集成分批接线）：`pruneCacheObservationLedger(dir, { keepRows: 0 })`
 *   —— 把本会话的诊断行全部删除（不仅是截断），返回删除计数供命令面回报。
 *
 * 纪律：
 * - 只保留**完整行**（无收尾换行的半行在压实时丢弃：它是崩溃残留，本来也不可用）；
 * - 写回走 temp + rename（原子），不做「先截断再写」；
 * - 失锁失败关闭（`ownership.assertOwned()`），不动字节；
 * - 压实只动本会话目录内的这一个文件，不碰 usage.jsonl 与其它账本。
 *
 * @param {string|null|undefined} directory 会话目录
 * @param {{keepRows?:number, maxBytes?:number}} [options] 覆盖默认上限（测试与 forget 用）
 * @returns {Promise<{ok:true, kept:number, removed:number}|{ok:false, error:string}>}
 */
export async function pruneCacheObservationLedger(directory, options = {}) {
  if (!directory) return { ok: true, kept: 0, removed: 0 }
  const file = path.join(directory, OBSERVATION_FILE)
  const keepRows = Number.isSafeInteger(options.keepRows) && options.keepRows >= 0
    ? options.keepRows
    : OBSERVATION_RETENTION.keepRows
  const maxBytes = Number.isFinite(options.maxBytes) && options.maxBytes > 0
    ? Math.floor(options.maxBytes)
    : OBSERVATION_RETENTION.maxBytes
  try {
    return await withCrossProcessWriteLock(directory, async (ownership) => {
      let text
      try {
        text = await readFile(file, 'utf8')
      } catch (error) {
        if (error?.code === 'ENOENT') return { ok: true, kept: 0, removed: 0 }
        throw error
      }
      // split 的最后一个元素有两种可能：以换行收尾时是空串，否则是**半行**（崩溃残留）。
      // 两种都必须丢掉——压实只保留完整行。
      const rows = text.split('\n').slice(0, -1).filter((line) => line.trim().length > 0)
      const keep = []
      let bytes = 0
      for (let index = rows.length - 1; index >= 0; index -= 1) {
        const line = rows[index]
        const cost = Buffer.byteLength(line, 'utf8') + 1
        if (keep.length >= keepRows) break
        if (keep.length > 0 && bytes + cost > maxBytes) break
        keep.unshift(line)
        bytes += cost
      }
      const removed = rows.length - keep.length
      if (removed <= 0) return { ok: true, kept: rows.length, removed: 0 }
      ownership.assertOwned() // 提交前复核：失锁则抛 ELOCK_LOST（被 catch 成结构化 error）
      if (keep.length === 0) {
        await rm(file, { force: true })
        return { ok: true, kept: 0, removed }
      }
      const temporary = file + '.compact-' + process.pid + '-' + Date.now()
      await writeFile(temporary, keep.join('\n') + '\n', 'utf8')
      await rename(temporary, file)
      return { ok: true, kept: keep.length, removed }
    })
  } catch (error) {
    return { ok: false, error: error?.code ?? error?.message ?? String(error) }
  }
}

/**
 * 读**只读 policy 输入**（G5 端口的数据来源）：**适配器负责读账本并聚合**，
 * 决策层只拿到 `POLICY_INPUT_PORT` 的形状——它看不到任何逐行记录、指纹链或正文。
 *
 * 纪律：
 * - 只读**尾窗口**（`POLICY_READ_BYTES`），不为汇总读整本账；
 * - 逐行走 `readObservationRowOf` 的**唯一读路径**（v3 行可读，但新段为 null）：
 *   旧行的 `usageArrival` 是 null ⇒ **不计入** token 汇总，单列 `unsampledLegacy`
 *   ——「旧行没记」不许被读成「观测到了」；
 * - usage 只对 `lifecycle.usageArrival.counted === true` 的样本求和（重复流式 chunk 不累加）；
 * - 缺字段是 null，不是 0（与观测合同的三态同源）。
 *
 * @param {string|null|undefined} directory 会话目录
 * @param {{sessionKey?:string|null, maxBytes?:number}} [options]
 * @returns {Promise<{ok:true, port:string, input:object}|{ok:false, reason:string}>}
 */
export async function readObservationPolicyInput(directory, options = {}) {
  if (!directory) return { ok: false, reason: 'no-directory' }
  const file = path.join(directory, OBSERVATION_FILE)
  const maxBytes = Number.isFinite(options.maxBytes) && options.maxBytes > 0
    ? Math.floor(options.maxBytes)
    : POLICY_READ_BYTES
  let text
  try {
    text = await readTailText(file, maxBytes)
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: false, reason: 'no-observations' }
    return { ok: false, reason: error?.code ?? error?.message ?? String(error) }
  }
  if (text === null) return { ok: false, reason: 'no-observations' }
  const lines = text.split('\n').filter((line) => line.trim().length > 0)
  const phaseCounts = { initial: 0, steady: 0, append: 0, 'epoch-start': 0 }
  let rows = 0
  let legacyRows = 0
  let skippedRows = 0
  let fromSeq = null
  let toSeq = null
  let lastSurface = null
  let lastLayers = null
  const counted = []
  let duplicates = 0
  let late = 0
  let unknownArrival = 0
  let unsampledLegacy = 0
  for (const line of lines) {
    let parsed
    try {
      parsed = JSON.parse(line)
    } catch {
      skippedRows += 1
      continue
    }
    const view = readObservationRowOf(parsed)
    if (view.ok !== true) {
      skippedRows += 1
      continue
    }
    rows += 1
    if (view.legacy === true) legacyRows += 1
    if (Number.isFinite(parsed.seq)) {
      if (fromSeq === null || parsed.seq < fromSeq) fromSeq = parsed.seq
      if (toSeq === null || parsed.seq > toSeq) toSeq = parsed.seq
    }
    const record = view.record
    if (record.surface !== null) {
      lastSurface = record.surface
      if (record.surface.phase !== null && Object.prototype.hasOwnProperty.call(phaseCounts, record.surface.phase)) {
        phaseCounts[record.surface.phase] += 1
      }
    }
    if (record.layers !== null) lastLayers = record.layers
    const arrival = record.lifecycle?.usageArrival ?? null
    if (arrival === null) {
      // 旧行/未接线行：**有 usage 但没有到达性质** ⇒ 不可判定是否重复，单列而不入汇总
      if (record.usage !== null) unsampledLegacy += 1
      unknownArrival += 1
      continue
    }
    if (arrival.state === 'duplicate') duplicates += 1
    if (arrival.state === 'late') late += 1
    if (arrival.state === 'unknown') unknownArrival += 1
    if (arrival.counted === true) counted.push(record)
  }
  if (rows === 0) return { ok: false, reason: 'no-usable-observations' }
  const totals = {}
  const availability = {}
  for (const field of USAGE_CACHE_FIELDS) {
    const values = counted
      .map((record) => record.usage?.[field])
      .filter((cell) => cell?.availability === 'present' && typeof cell.value === 'number' && Number.isFinite(cell.value))
      .map((cell) => cell.value)
    totals[field] = values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0)
    availability[field] = values.length === 0 ? 'missing' : 'present'
  }
  const lastCounted = counted.at(-1) ?? null
  const additivity = lastCounted?.arithmetic?.additivity ?? null
  const input = {
    contractVersion: POLICY_INPUT_PORT.version,
    session: sessionRefOf(options.sessionKey ?? null),
    window: { fromSeq, toSeq, rows, legacyRows, skippedRows },
    projection: {
      epoch: lastSurface?.epoch ?? null,
      lastPhase: lastSurface?.phase ?? null,
      lastMessageChange: lastSurface?.messageChange ?? null,
      phaseCounts,
    },
    components: {
      messages: {
        digest: lastSurface?.components?.messages?.digest ?? null,
        count: lastSurface?.components?.messages?.count ?? null,
        generation: lastSurface?.components?.messages?.generation ?? null,
      },
      system: { coverage: lastSurface?.coverage?.system ?? 'unobservable' },
      tools: { coverage: lastSurface?.coverage?.tools ?? 'unobservable' },
    },
    usage: {
      counted: counted.length,
      duplicates,
      late,
      unknownArrival,
      unsampledLegacy,
      totals,
      availability,
      cacheReadRatio: lastCounted?.cacheReadRatio?.value ?? null,
      additivity: {
        provider: additivity?.provider ?? null,
        cacheFieldsAddable: additivity?.cacheFieldsAddable ?? null,
        reasoningExtraTokens: additivity?.reasoningExtraTokens ?? null,
        verified: additivity?.verified ?? 'unknown',
      },
    },
    layers: lastLayers,
  }
  const validated = sanitizePolicyInput(input)
  if (validated.ok !== true) return { ok: false, reason: validated.reason }
  return { ok: true, port: POLICY_INPUT_PORT.name, input: validated.input }
}

/**
 * 只读文件尾部的文本（最多 `maxBytes`；截断时丢弃首个半行）。
 * 文件为空 → null（"没有观测"与"有观测但都是坏行"由调用方分别处理）。
 */
async function readTailText(file, maxBytes) {
  // open 的失败原样上抛（ENOENT / EACCES / EMFILE 由调用方分别处理）——这里不再包一层
  // "两个分支都 throw" 的 try/catch，那只会让读者误以为 ENOENT 有特殊处理。
  const handle = await open(file, 'r')
  try {
    const { size } = await handle.stat()
    if (size === 0) return null
    const readBytes = Math.min(size, maxBytes)
    const buffer = Buffer.alloc(readBytes)
    await handle.read(buffer, 0, readBytes, size - readBytes)
    let text = buffer.toString('utf8')
    if (readBytes < size) {
      // 从行中间开始：丢掉第一段（它可能只是半行）
      const newline = text.indexOf('\n')
      text = newline >= 0 ? text.slice(newline + 1) : ''
    }
    return text
  } finally {
    await handle.close().catch(() => {})
  }
}

