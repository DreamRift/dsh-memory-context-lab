/**
 * 可追加账本（append-only ledger）的唯一协议实现。
 *
 * 为什么需要这个模块（0.13.2-beta.6 G1）：
 *
 * 仓里有三份 append-only JSONL 账本——`disposition.jsonl`（遗忘可见性）、
 * `hierarchy.jsonl`（层级压缩）、`provenance.jsonl`（来源图）。它们共用同一套
 * 协议：「首行 header + 每行一条 canonical JSON + LF 结尾 + 尾部半行截断修复 +
 * 写锁内重读」。这套协议此前被**独立实现了三遍**，于是同一个 bug 修了两次、
 * 第三次仍然是修之前的版本：
 *
 * - `disposition`：0 字节账本不补 header（`readFile` 不抛 ENOENT 就以为「有文件」）；
 * - `hierarchy`：与 disposition 逐字同构的同名缺陷；
 * - `provenance`：**整段没有写锁**（并发首写各写一行 header → 永久 damaged），
 *   且 `parseProvenanceText` 还停在 D-01 修复**之前**的口径——末尾缺 LF 就把
 *   最后一条**完整合法条目**当成半行截掉（读一次就物理删除一条边）。
 *
 * 三个症状（拼行、双 header、读一次删条目）都是**同一段 I/O 序列**的失败模式。
 * 所以这里把它收成一份实现，三个账本只保留各自的「行长什么样」（`parse`）与
 * 「header 是什么」（`header`），I/O 与崩溃安全全部共用。
 *
 * 协议（`appendLines` 全程在 `withWriteLock` 内、锁内重读）：
 *
 * 1. 读文件；ENOENT 视为空；
 * 2. 解析；**只有解析失败的尾巴**才算半行，截断走 temp+rename（绝不原地 writeFile）；
 * 3. 内容为空（0 字节）→ 写 header 行；
 * 4. 内容末尾不是 LF → 补一个 LF（否则下一次追加会把两条 JSON 拼成一行）；
 * 5. 追加新行 + fsync。
 *
 * 读路径（`load`）**不**改写字本内容以外的任何东西：只在检测到解析失败的半行时
 * 调用 `repairTail`，而 `repairTail` 自己进写锁并重读——拿旧内容去截会丢掉
 * 别人刚追加的完整条目（W-01b 的教训）。
 */

import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { withWriteLock } from './write-lock.mjs'
import { InvalidArgumentError } from '../errors.mjs'

// ---------------------------------------------------------------- 规范序列化

/**
 * 键排序的规范 JSON（整个值递归排序）。
 *
 * 账本与计划文件落盘一律用它：同一逻辑内容字节稳定，便于逐字节比对与审计。
 * 三个账本各自抄过一份，这里收成唯一实现。
 */
export function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson)
  if (value !== null && typeof value === 'object') {
    const out = {}
    for (const key of Object.keys(value).sort()) out[key] = canonicalJson(value[key])
    return out
  }
  return value
}

export function canonicalLine(value) {
  return JSON.stringify(canonicalJson(value))
}

// ---------------------------------------------------------------- 原子写

/**
 * 用「唯一临时名 + rename」替换文件内容。
 *
 * 临时名必须唯一：`file + '.' + process.pid + '.tmp'` 在同进程的并发写者之间是
 * **同一个名字**，两个写者会互相截断对方正在写的临时文件（0.13.2-beta.6 G8 的
 * read-ledger 就是这么丢条目的）。这里用 randomUUID，写失败时清掉临时文件。
 */
export async function writeFileAtomic(file, text) {
  await mkdir(path.dirname(file), { recursive: true })
  const temp = `${file}.${randomUUID()}.tmp`
  try {
    await writeFile(temp, text, 'utf8')
    await rename(temp, file)
  } catch (error) {
    await unlink(temp).catch(() => {})
    throw error
  }
}

// ---------------------------------------------------------------- 账本

/**
 * 建一个账本句柄。
 *
 * @param {object} options
 * @param {string} options.file       账本绝对路径
 * @param {string} options.sessionDir 写锁所在目录（`withWriteLock` 的键）
 * @param {object} options.header     首行对象（不含 LF）
 * @param {(text: string) => { entries: object[], header: object|null, damaged: boolean, damageDetail: object|null, partialLine: string }} options.parse
 *   该账本自己的行解析器。**必须**遵守「末尾缺 LF 时先试 JSON.parse，只有解析失败
 *   的尾巴才进 partialLine」——这是 D-01 的口径，三个账本一致。
 * @param {(entry: object) => string} [options.serialize] 默认 canonicalLine
 */
export function createAppendableLedger({ file, sessionDir, header, parse, serialize = canonicalLine }) {
  if (typeof file !== 'string' || !file) throw new InvalidArgumentError('createAppendableLedger: file 必填')
  if (typeof sessionDir !== 'string' || !sessionDir) throw new InvalidArgumentError('createAppendableLedger: sessionDir 必填')
  if (!header || typeof header !== 'object') throw new InvalidArgumentError('createAppendableLedger: header 必填')
  if (typeof parse !== 'function') throw new InvalidArgumentError('createAppendableLedger: parse 必填')

  const headerLine = serialize(header)

  /** 读原始文本；不存在返回 null。 */
  async function readText() {
    try {
      return await readFile(file, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return null
      throw error
    }
  }

  /**
   * 截掉尾部解析失败的半行。**必须在写锁内、锁内重读**：拿调用方读到的旧内容
   * 去截，会把别的进程刚追加的完整条目一起丢掉。
   * 返回被截掉的字节数；没有半行返回 0。
   */
  async function repairTail() {
    return withWriteLock(sessionDir, async () => {
      const current = await readText()
      if (current === null) return 0
      const parsed = parse(current)
      const tail = parsed.partialLine
      if (typeof tail !== 'string' || tail.length === 0) return 0
      const keep = current.slice(0, current.length - tail.length)
      // 不原地 writeFile：账本文件头写着「绝不原地改写」，且原地截断在崩溃窗口里
      // 会留下半截内容。temp+rename 至少保证「要么旧、要么新」。
      await writeFileAtomic(file, keep)
      return Buffer.byteLength(tail, 'utf8')
    })
  }

  /**
   * 读账本。返回 `{ state, entries, header, damaged, damageDetail, repairedBytes }`。
   *
   * - `state: 'absent'`：没有文件或 0 字节（全新会话）；
   * - `state: 'ok' | 'damaged'`：`entries` 是已解析前缀。
   *
   * 损坏语义与三个账本此前的口径一致：中部损坏（JSON 解析失败 / header 非法）→
   * `damaged: true`，写侧拒绝、读侧告警；尾部半行 → 截断修复，不算损坏。
   */
  async function load() {
    const text = await readText()
    if (text === null || text.length === 0) {
      return { state: 'absent', entries: [], header: null, damaged: false, damageDetail: null, repairedBytes: 0 }
    }
    const parsed = parse(text)
    const repairedBytes = parsed.partialLine && parsed.partialLine.length > 0
      ? await repairTail().catch(() => 0)
      : 0
    return {
      state: parsed.damaged ? 'damaged' : (parsed.entries.length === 0 && parsed.header === null ? 'absent' : 'ok'),
      entries: parsed.entries,
      header: parsed.header ?? null,
      damaged: parsed.damaged === true,
      damageDetail: parsed.damageDetail ?? null,
      repairedBytes,
    }
  }

  /**
   * 把账本整理成「可以安全追加」的状态。**调用方必须已经持有写锁**
   * （本函数由 `appendLines` 在锁内调用，也可被需要「先修再写」的路径直接调用）。
   *
   * 三件事，缺一不可：
   * 1. 0 字节 → 写 header（否则第一条条目成为第 1 行，下次解析判「首行不是 header」）；
   * 2. 尾部解析失败的半行 → 截断（否则新行接在半行后面，成为一条坏行）；
   * 3. 末尾不是 LF → 补一个 LF（否则新行与旧行**拼成一行**，下一次解析整本 damaged）。
   *
   * 返回整理后的文本（截断后重新读的内容）。
   */
  async function prepareUnlocked() {
    await mkdir(sessionDir, { recursive: true })
    let text = await readText()
    // 对抗审查 finding：只判「0 字节」把缺陷类判窄了。内容为单个 '\n'（1 字节空白）
    // 时 text.length !== 0 会跳过补 header，首条目落在第 1 行 → 下次解析判
    // 「首行不是 header」→ 整本 damaged（disposition 场景下等于遗忘索引归零、
    // 已遗忘记录重新可见）。判据改成「没有任何有效内容」而非「长度为零」。
    if (text === null || text.trim().length === 0) {
      await writeFile(file, headerLine + '\n', 'utf8')
      return headerLine + '\n'
    }
    const parsed = parse(text)
    const tail = parsed.partialLine
    if (typeof tail === 'string' && tail.length > 0) {
      text = text.slice(0, text.length - tail.length)
      await writeFileAtomic(file, text)
    }
    if (text.length === 0) {
      await writeFile(file, headerLine + '\n', 'utf8')
      return headerLine + '\n'
    }
    if (!text.endsWith('\n')) {
      // 末尾缺 LF：补一个。用 append 而不是重写整本——账本可能很大。
      await appendFile(file, '\n', 'utf8')
      text += '\n'
    }
    return text
  }

  /**
   * 追加若干行（每条一个对象）。整段在写锁内：整理 → 追加 → fsync。
   *
   * 追加用 `open(file,'a')` + `handle.sync()`：可见性账本必须先于表面墓碑持久化，
   * 这行丢了会让已遗忘的记录在重启后重新可见（隐私回退），所以不与派生缓存合并。
   */
  async function appendLines(entries) {
    const rows = Array.isArray(entries) ? entries : []
    if (rows.length === 0) return { appended: false, bytes: 0 }
    const payload = rows.map((entry) => serialize(entry) + '\n').join('')
    return withWriteLock(sessionDir, async () => {
      await prepareUnlocked()
      const handle = await open(file, 'a')
      try {
        await handle.writeFile(payload, 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      return { appended: true, bytes: Buffer.byteLength(payload, 'utf8') }
    })
  }

  return { file, headerLine, readText, load, repairTail, prepareUnlocked, appendLines }
}
// ---------------------------------------------------------------- 唯一解析实现

/**
 * 解析一份 append-only 账本文本（三份账本共用）。
 *
 * 为什么必须只有一份（0.13.2-beta.7 L-1）：
 *
 * beta.6 把**写侧**收成了 createAppendableLedger，读侧却留了三份各写一遍的
 * parse。三份的差异不是风格，而是缺陷历史：provenance 那份漏了 D-01（末尾缺 LF
 * 时把最后一条**完整合法**条目当半行删掉），原因是「抄到第三遍时少抄了一段」。
 * 只要「新增账本 = 再抄一份 parse」，第四份账本就会再少抄一段。
 *
 * 所以协议在这里只有一份实现，账本只提供**schema 参数**（header 的 kind 与
 * schemaVersion、条目 kind 白名单、给用户看的名字）。返回形状也只有一种：
 * `{ entries, header, damaged, damageDetail, partialLine, rawByteLength }`——
 * 三份账本此前形状不一致（provenance 不返回 header/rawByteLength），
 * 消费者于是不能互换；统一后「多一个账本」不再意味着「多一套返回契约」。
 *
 * 判据（与 D-01 / W-01b 一致，不再各处重述）：
 * - 末尾没有 LF：**先试解析**，能解析就是完整行，只有解析失败的尾巴才进 partialLine；
 * - 首行必须是 header（kind + schemaVersion 同时匹配）；
 * - 其余行必须在 entryKinds 白名单内；
 * - 中部任何解析失败 / header 非法 / kind 未知 → damaged + damageDetail（带行号）。
 *
 * @param {string} text 账本全文
 * @param {object} schema
 * @param {string} schema.ledgerName 账本名（进 damageDetail 文案）
 * @param {string} schema.headerKind 首行 kind
 * @param {number} schema.schemaVersion 首行 schemaVersion
 * @param {readonly string[]} schema.entryKinds 合法条目 kind 白名单
 * @returns {{ entries: object[], header: object|null, damaged: boolean, damageDetail: object|null, partialLine: string, rawByteLength: number }}
 */
export function parseAppendableLedger(text, { ledgerName, headerKind, schemaVersion, entryKinds }) {
  if (typeof text !== 'string') throw new InvalidArgumentError('parseAppendableLedger: text 必须是字符串')
  if (!ledgerName || !headerKind || !Number.isInteger(schemaVersion)) {
    throw new InvalidArgumentError('parseAppendableLedger: ledgerName / headerKind / schemaVersion 必填')
  }
  const kinds = new Set(Array.isArray(entryKinds) ? entryKinds : [])
  const lines = text.split('\n')
  // 文本以 \n 结尾时 split 会留一个空尾元素，所以完整行恒为 slice(0, -1)。
  const trailingNewline = /\n$/.test(text)
  const completeLines = lines.slice(0, -1)
  let partialLine = ''
  if (!trailingNewline && lines.length > 0) {
    const tail = lines[lines.length - 1]
    if (tail.length > 0) {
      try {
        JSON.parse(tail)
        completeLines.push(tail) // 合法 → 最后一条完整行，不进 partialLine
      } catch {
        partialLine = tail // 只有解析失败的尾巴才是崩溃残留
      }
    }
  }
  const entries = []
  let damaged = false
  let damageDetail = null
  let header = null
  for (let index = 0; index < completeLines.length; index += 1) {
    const raw = completeLines[index]
    if (raw.length === 0) continue
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      damaged = true
      damageDetail = { line: index + 1, message: error.message }
      break
    }
    if (header === null) {
      if (parsed?.kind !== headerKind || parsed?.schemaVersion !== schemaVersion) {
        damaged = true
        damageDetail = { line: index + 1, message: `首行不是合法 ${ledgerName} header` }
        break
      }
      header = parsed
      continue
    }
    if (!kinds.has(parsed?.kind)) {
      damaged = true
      damageDetail = { line: index + 1, message: `未知条目 kind：${JSON.stringify(parsed?.kind)}` }
      break
    }
    entries.push(parsed)
  }
  return { entries, header, damaged, damageDetail, partialLine, rawByteLength: Buffer.byteLength(text, 'utf8') }
}
