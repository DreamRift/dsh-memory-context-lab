/**
 * v3 会话存储适配器（adapters/storage，M2 第一批）。
 *
 * 数据根（ADR-0001：独立数据根，不读不写 v1/v2 目录）：
 *   <root>/sessions/<sessionKey>/manifest.json      { schemaVersion, sessionKey, txnNext }
 *   <root>/sessions/<sessionKey>/records/<id>.json  记录本体（contracts/records 形状）
 *   <root>/sessions/<sessionKey>/transactions.jsonl 事务日志（append-only，JSON 行）
 *   <root>/sessions/<sessionKey>/quarantine/        崩溃残留隔离区（只进不出，人工审计）
 *
 * 事务协议（单写者假设；跨进程锁在下一批接入）：
 *   1. 校验全部记录（assertValidRecord，fail-closed 拒提交）；
 *   2. 逐条原子写 payload（randomUUID 临时名 + rename，G8）；
 *   3. 追加 commit 行到 transactions.jsonl（含 txn 号与 recordIds）；
 *   4. 原子更新 manifest.txnNext。
 * 崩溃对账（打开时 reconcile）：
 *   - 有 payload 无 commit 行 → 残留记录移入 quarantine，事务视为未提交，
 *     txnNext 不前进 → 重试拿到新事务号（号不复用，D-17/D-18）；
 *   - 有 commit 行但 txnNext 未推进 → 对账推进到 max(txn)+1；
 *   - transactions.jsonl 解析失败（含尾部半行）→ 存储判 damaged：读允许、写拒绝，
 *     文件字节不动（disposition-integrity 保留判据：读路径不得改写日志）。
 */
import { copyFile, mkdir, open, readdir, readFile, rename, rm, stat, truncate, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'

import { v3Error, V3ContractViolation } from '../../contracts/errors.mjs'
import { RECORD_KINDS, assertValidRecord, isRecordId, validateRecord } from '../../contracts/records.mjs'
import { inspectAppendTail } from './append-tail.mjs'
import { fileStampOf } from './file-stamp.mjs'
import { withCrossProcessWriteLock } from './write-lock.mjs'

const SCHEMA_VERSION = 1
const MANIFEST = 'manifest.json'
const TXN_LOG = 'transactions.jsonl'
const VOUCHERS_LOG = 'vouchers.jsonl'
const FORGOTTEN_LOG = 'forgotten.jsonl'
// D-C：隐私面清除/还原的持久标记（history 同步读取，不能现场读宿主活动面）
const REDACTIONS_LOG = 'redactions.jsonl'
// H4（2026-11-04 审计）：物理清除账本。`forget` 是逻辑遗忘（保留正文以支持 undo），
// `purge` 才删除冷库正文；已清除的 ID 必须由对账识别为「合法缺失」——否则
// 「commit 行在、payload 不在」会被判成账实不符（ESTORE_DAMAGED，写拒绝）。
const PURGED_LOG = 'purged.jsonl'
// P1-07：补凭证放弃后的**孤儿回执**账本。与 vouchers.jsonl 故意分开——intent 卡死最常见
// 的原因正是凭证账本本身写不进去（磁盘满 / 中段损坏），同一个文件落「放弃记录」必然跟着失败。
const ORPHAN_LOG = 'orphan-receipts.jsonl'
const RECORDS_DIR = 'records'
const QUARANTINE_DIR = 'quarantine'
// AUD50-03-03（B2-6）：records/ 里的合法记录名。其它名字（writeFileAtomic 崩溃留下
// 的 .tmp、系统文件）不是记录：不参与对账计数，不进 idsOnDisk，打开期移入 quarantine。
const RECORD_FILE = /^v3r-[0-9a-f]{16}\.json$/
// AUD50-04-02（B2-8）：打开期检查点（可重建缓存）。与提交同锁追加：
// baseline 行 = 全量扫描后的完整「事件→记录」映射（迁移旧库只付一次扫描），
// checkpoint 行 = 每笔事务的增量。判据：行内最大 txn 等于事务日志 maxTxn 才可用，
// 落后/缺失/损坏一律回退全量 provenance 扫描（不用旧检查点掩盖新记录）。
const CHECKPOINT_LOG = 'checkpoint.jsonl'

/** 原子写：同目录 randomUUID 临时名 + fsync + rename（G8：禁止 tmp-<pid>-<Date.now()>）。
 *
 * fsync 不能省：rename 只是目录项操作，数据块可能还在页缓存里。断电后会出现
 * 「文件名合法、内容 0 字节/半条」的记录文件——它会被 readdir 认成已提交记录，
 * 然后在 readRecord 抛 ESTORE_CORRUPT，整个索引重建面被打挂。
 * Windows 不支持目录 fsync，这里只保证文件内容落盘（目录项的持久化交给 NTFS 日志）。
 */
export async function writeFileAtomic(filePath, data) {
  const tmp = path.join(path.dirname(filePath), '.' + path.basename(filePath) + '.' + randomUUID() + '.tmp')
  const handle = await open(tmp, 'w')
  try {
    await handle.writeFile(data, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await rename(tmp, filePath)
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {})
    throw error
  }
}

function sessionDirOf(root, sessionKey) {
  return path.join(root, 'sessions', sessionKey)
}

/**
 * 解析 JSONL 日志；返回 { lines, damaged, reason, exists }。damaged 时 lines 为已解析前缀。
 * `exists` 区分「日志不存在」（可能是全新会话）与「日志存在但为空」——对账要用（H-21）。
 */
async function parseTxnLog(filePath, label = path.basename(filePath)) {
  let text
  try {
    text = await readFile(filePath, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return { lines: [], damaged: false, reason: null, exists: false }
    throw error
  }
  const lines = []
  const rawLines = text.split('\n')
  for (let i = 0; i < rawLines.length; i += 1) {
    const raw = rawLines[i]
    if (raw.length === 0) continue
    try {
      lines.push(JSON.parse(raw))
    } catch {
      // 任何不可解析行（含尾部半行）都判 damaged；文件字节不动
      return { lines, damaged: true, reason: label + ' 第 ' + (i + 1) + ' 行不可解析', exists: true }
    }
  }
  return { lines, damaged: false, reason: null, exists: true }
}

/**
 * 日志文件尾部检查（G-A，0.14.0-beta.48）：只认「尾部无换行且 JSON 不可解析」的半行。
 *
 * 安全红线（用户 2026-10-29 拍板）：
 * - 只动**尾部**，中段损坏与完整行解析失败一律判 damaged，绝不截断；
 * - 半行 = 文件末尾（最后一个 \n 之后）非空、且 JSON.parse 失败；
 *   完整行（即使没有结尾换行）可解析 → 视为已提交，不动；
 * - 检查先验证前缀全部可解析，前缀有坏行同样不截断（可能是中段损坏的另一种表现）。
 * @returns {Promise<object>} { state: 'absent'|'ok'|'tail-half-line'|'damaged', ... }
 */
export async function inspectJournalFile(filePath, label = path.basename(filePath)) {
  let buffer
  try {
    buffer = await readFile(filePath)
  } catch (error) {
    if (error?.code === 'ENOENT') return { state: 'absent', file: label, path: filePath }
    return { state: 'unreadable', file: label, path: filePath, reason: error?.code ?? String(error) }
  }
  const lastNewline = buffer.lastIndexOf('\n'.charCodeAt(0))
  const endsWithNewline = lastNewline === buffer.length - 1
  const tailStart = endsWithNewline ? buffer.length : lastNewline + 1
  const tail = buffer.subarray(tailStart).toString('utf8')
  const hasTail = !endsWithNewline && tail.trim().length > 0
  // 前缀（尾部半行之前）必须整体可解析；否则不是「只坏尾部」，不能截断。
  const prefix = buffer.subarray(0, tailStart).toString('utf8')
  const prefixLines = prefix.split('\n')
  for (let i = 0; i < prefixLines.length; i += 1) {
    const raw = prefixLines[i]
    if (raw.length === 0) continue
    try {
      JSON.parse(raw)
    } catch {
      return { state: 'damaged', file: label, path: filePath, line: i + 1, reason: label + ' 第 ' + (i + 1) + ' 行不可解析（中段/完整行损坏，不自动截断）' }
    }
  }
  if (!hasTail) return { state: 'ok', file: label, path: filePath, bytes: buffer.length }
  try {
    JSON.parse(tail)
    // 合法 JSON 但缺结尾换行：视为已提交的完整行（不猜、不改写）。
    return { state: 'ok', file: label, path: filePath, bytes: buffer.length, unterminatedComplete: true }
  } catch {
    return {
      state: 'tail-half-line',
      file: label,
      path: filePath,
      keptBytes: tailStart,
      removedBytes: buffer.length - tailStart,
      // M5（2026-11-04 审计）：半行可能含正文/路径片段，**不再把原文写进审计日志**，
      // 只留可核对的摘要（长度 + sha256 前 16 字符）。审计的用途是「谁截了多少字节」，
      // 不是「被截内容是什么」。
      tailBytes: Buffer.byteLength(tail, 'utf8'),
      tailDigest: 'sha256:' + createHash('sha256').update(tail, 'utf8').digest('hex').slice(0, 16),
      reason: label + ' 尾部半行（无结尾换行且 JSON 不可解析）',
    }
  }
}

const REPAIR_LOG = 'repair-log.jsonl'

/**
 * 修复会话日志尾部（G-A）：锁内重读 → 逐文件只截尾部半行 → 先写审计再截断。
 *
 * 只处理 append-only 日志（transactions / vouchers / forgotten）的尾部半行：
 * 半行是未完成的 append，截掉即回到最后一条完整事实；中段损坏与完整行损坏仍失败关闭。
 * 审计行写进 sessions/<key>/repair-log.jsonl（先落审计，审计失败则不改动任何字节）。
 *
 * @param {string} dir 会话目录
 * @param {{dryRun?: boolean, now?: () => number}} [options]
 */
export async function repairSessionJournals(dir, { dryRun = false, now = () => Date.now() } = {}) {
  const specs = [
    { file: TXN_LOG },
    { file: VOUCHERS_LOG },
    { file: FORGOTTEN_LOG },
    { file: REDACTIONS_LOG },
    // B2-8：检查点是纯缓存（可全量重建），尾部半行截断零风险；纳入 repair 面。
    { file: CHECKPOINT_LOG },
    // P1-04：purged.jsonl 与 forgotten 同族（append-only 隐私账本）。旧 specs 漏登记它，
    // 于是 purge 记账的尾部半行永远不可收敛——repair 说「无需修复」，而读面仍解析失败。
    { file: PURGED_LOG },
    // P1-07：孤儿回执账本同族（append-only），尾部半行必须能修，否则放弃路径写坏就永久不可读。
    { file: ORPHAN_LOG },
  ]
  const inspectAll = async () => {
    const rows = []
    for (const spec of specs) {
      rows.push(await inspectJournalFile(path.join(dir, spec.file), spec.file))
    }
    return rows
  }
  const before = await inspectAll()
  const tails = before.filter((row) => row.state === 'tail-half-line')
  // T-10（0.15.4）：中段损坏的**隐私账本**必须有出口，且出口必须是显式的。
  //
  // 缺陷：`purged.jsonl` 中段坏一行 → 打开期判 damaged → 写面全拒（读允许），
  // 而 `repair` 只会修「尾部半行」，对中段损坏明确拒绝（安全红线，不能自动截断）——
  // 于是整库**永久只读**，没有任何命令能把它救回来。用户只能手动删文件。
  //
  // 红线不变：**绝不自动截断/丢弃任何一行**（丢掉 purge 行 = 已清除的正文复活）。
  // 新增的是「人工裁决」出口：`rebuildPurged` 明确要求调用方给出损坏文件名，
  // 它只做一件事——把**读不出来的账本行**与**盘上真实存在的记录**对比，
  // 把「账本里读不到、但记录文件已经不在」的 ID 视为已清除（补写 purge 行），
  // 并原样备份坏账本（不删字节）。做不到一致就失败关闭，宁可继续只读。
  const damaged = before.filter((row) => row.state === 'damaged')
  if (dryRun) {
    return { dryRun: true, files: before, repaired: [], changed: false, damaged }
  }
  if (tails.length === 0) {
    return { dryRun: false, files: before, repaired: [], changed: false, damaged }
  }
  // 跨进程锁内重读后再截断：别的进程可能刚补完那条 append。
  return withCrossProcessWriteLock(dir, async (ownership) => {
    const inside = await inspectAll()
    // R3-03：失锁（被接管/心跳失败）后拒绝截断——repair 改字节前必须确认仍持锁。
    ownership.assertOwned()
    const repaired = []
    for (const row of inside) {
      if (row.state !== 'tail-half-line') continue
      const audit = {
        schemaVersion: 1,
        at: now(),
        file: row.file,
        keptBytes: row.keptBytes,
        removedBytes: row.removedBytes,
        removedDigest: row.tailDigest,
        removedBytesFromTail: row.tailBytes,
        reason: '尾部半行（无结尾换行且 JSON 不可解析）',
      }
      // 审计先落盘：写不进去就不改数据（不留「悄悄截断」的路径）。
      await appendLine(path.join(dir, REPAIR_LOG), audit)
      await truncate(row.path, row.keptBytes)
      repaired.push(audit)
    }
    const after = await inspectAll()
    return { dryRun: false, files: after, repaired, changed: repaired.length > 0 }
  })
}

/**
 * T-10（0.15.4）：`purged.jsonl` 中段损坏时的**显式**人工出口。
 *
 * 为什么不能自动修：purge 行是「这条正文已被物理清除」的唯一凭证。丢掉一行 →
 * 已清除的内容在下一次索引重建时可能被重新当成可读记录（隐私回退）。
 * 因此安全红线不变：**永不自动截断、永不丢弃任何一行**。
 *
 * 这个出口只在用户明确要求时运行，且判据是「盘上的事实」而不是「账本说的」：
 * - 读不出来的那些行 → 备份原账本（不删字节）；
 * - 用 `transactions.jsonl` 里已提交的 ID 集合 减去 `records/` 实存文件集合，
 *   差集就是「提交过、但文件已经不在」的 ID ——它们只可能是被 purge 掉的；
 * - 把这些 ID 补写成新的 purge 行，写进**新账本**（旧账本备份保留），
 *   使读面恢复「已清除」这一事实。
 *
 * 任何一步读不到/不一致 → 失败关闭（返回 error），保持只读，交人工处理。
 */
export async function rebuildPurgedLedger(dir, { dryRun = false, now = () => Date.now() } = {}) {
  const purgedPath = path.join(dir, PURGED_LOG)
  const txnPath = path.join(dir, TXN_LOG)
  const recordsDir = path.join(dir, RECORDS_DIR)

  const readLines = async (file) => {
    let text
    try {
      text = await readFile(file, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return { ok: true, lines: [], raw: '' }
      return { ok: false, reason: error?.code ?? String(error) }
    }
    const lines = []
    for (const raw of text.split('\n')) {
      if (raw.trim().length === 0) continue
      try {
        lines.push(JSON.parse(raw))
      } catch {
        // 坏行：读不出来就跳过**用于推断**，但原文会随旧账本一起备份保留。
      }
    }
    return { ok: true, lines, raw: text }
  }

  const purgedNow = await readLines(purgedPath)
  if (!purgedNow.ok) return { error: 'purged-unreadable', reason: purgedNow.reason }
  const txnNow = await readLines(txnPath)
  if (!txnNow.ok) return { error: 'txn-unreadable', reason: txnNow.reason }

  // 读不出来的行数（诊断用）：坏行 = 非空但 JSON 不可解析。
  const totalNonEmpty = purgedNow.raw.split('\n').filter((line) => line.trim().length > 0).length
  const badLines = totalNonEmpty - purgedNow.lines.length

  const committed = new Set()
  for (const line of txnNow.lines) {
    // commit 行的形状是 `{action:'commit', txn, recordIds:[...]}`（单条记录时代还可能是 id）。
    // 只认一种写法会让「已提交」集合恒为空，补记就永远算不出来——那正是本出口失效的方式。
    if (Array.isArray(line?.recordIds)) {
      for (const id of line.recordIds) if (typeof id === 'string') committed.add(id)
    } else if (typeof line?.id === 'string') {
      committed.add(line.id)
    }
  }
  let onDisk
  try {
    onDisk = new Set((await readdir(recordsDir)).filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -5)))
  } catch (error) {
    if (error?.code === 'ENOENT') onDisk = new Set()
    else return { error: 'records-unreadable', reason: error?.code ?? String(error) }
  }

  const alreadyPurged = new Set()
  for (const line of purgedNow.lines) {
    if (typeof line?.id === 'string' && line.action === 'purge') alreadyPurged.add(line.id)
  }

  // 「提交过、文件不在、账本里也没记 purge」= 需要补记的候选。
  const missing = [...committed].filter((id) => !onDisk.has(id) && !alreadyPurged.has(id)).sort()

  if (dryRun) {
    return { dryRun: true, badLines, alreadyPurged: alreadyPurged.size, wouldRecord: missing, changed: false }
  }
  if (missing.length === 0) {
    return { dryRun: false, badLines, alreadyPurged: alreadyPurged.size, recorded: [], changed: false }
  }

  return await withCrossProcessWriteLock(dir, async (ownership) => {
    ownership.assertOwned()
    // 旧账本原样备份（**不删字节**）：人工裁决必须可回溯。
    const backupPath = purgedPath + '.bak-' + now()
    try {
      await copyFile(purgedPath, backupPath)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    // 重写账本：先保留所有原行（逐字节语义等价），再追加补记行。
    // 注意：**不丢原行**——即使其中有坏行，坏行文本也原样留在 .bak 里，
    // 新账本只承载「可解析的原行 + 补记行」，坏行本身不再参与解析（否则永远打不开）。
    const kept = purgedNow.lines
      .filter((line) => typeof line?.id === 'string' && line.action === 'purge')
      .map((line) => ({ action: 'purge', id: line.id, at: line.at ?? null }))
    const appended = missing.map((id) => ({ action: 'purge', id, at: null, rebuild: true }))
    const all = [...kept, ...appended]
    const text = all.map((row) => JSON.stringify(row)).join('\n') + '\n'
    await writeFileAtomic(purgedPath, text)
    await appendLine(path.join(dir, REPAIR_LOG), {
      schemaVersion: 1,
      at: now(),
      file: PURGED_LOG,
      action: 'rebuild-purged',
      badLines,
      reRecorded: appended.length,
      backup: path.basename(backupPath),
      reason: 'purged.jsonl 中段损坏（人工裁决：按「已提交但文件不在」补记 purge 行）',
    })
    return { dryRun: false, badLines, alreadyPurged: kept.length, recorded: appended.map((row) => row.id), backup: backupPath, changed: appended.length > 0 }
  })
}

/**
 * 打开（或创建）会话存储，并执行崩溃对账。
 * @returns {object} store：submitTransaction / readRecord / health / close
 */
export async function openV3SessionStore(root, sessionKey, options = {}) {
  if (typeof root !== 'string' || root.length === 0) {
    throw new V3ContractViolation('v3 store: root 必须是非空字符串')
  }
  if (typeof sessionKey !== 'string' || sessionKey.trim().length === 0) {
    throw new V3ContractViolation('v3 store: sessionKey 必须是非空白字符串')
  }
  // stat 可注入（G-B 守卫）：fileExists 只把 ENOENT 当「没有」，其余错误必须向上抛；
  // 测试注入 EACCES 证明「读不到」不再被当成「不存在」而重建 manifest/txn 号。
  const statOf = typeof options.stat === 'function' ? options.stat : stat
  // readdir 可注入（B2-6 守卫）：目录读不了（EACCES 等）必须向上抛，不得当空目录。
  const readdirOf = typeof options.readdir === 'function' ? options.readdir : readdir
  const fileExistsHere = (p) => fileExists(p, statOf)
  const dir = sessionDirOf(root, sessionKey)
  await mkdir(path.join(dir, RECORDS_DIR), { recursive: true })
  await mkdir(path.join(dir, QUARANTINE_DIR), { recursive: true })

  const manifestPath = path.join(dir, MANIFEST)
  const logPath = path.join(dir, TXN_LOG)
  const vouchersPath = path.join(dir, VOUCHERS_LOG)
  const forgottenPath = path.join(dir, FORGOTTEN_LOG)
  const redactionsPath = path.join(dir, REDACTIONS_LOG)

  // AUD50-03-01（B2-4）：打开期对账整段进跨进程写锁。旧实现在锁外读日志、判 damaged、
  // 隔离残留，与在飞提交竞态：第二句柄在写入者「payload 已写、commit 未落」的窗口打开，
  // 把在飞 payload 当崩溃残留隔离 → 写入者随后提交 → 「有 commit 无 payload」账实不符
  // → 之后每次打开都 damaged，永久拒写。现在锁被活写者持有时**等待（有上限）**，
  // 等不到抛 ELOCKED 失败关闭，绝不立即判 damaged；锁内**重新读**日志与记录目录，
  // 不用锁外旧快照做隔离/损坏判定；隔离动作也进锁。同进程重入（端口/repair 已持锁时
  // 再 open）由 write-lock 的 AsyncLocalStorage 重入保证，不死锁。
  // AUD50-03-03（B2-6）：records/ 只认合法记录名（RECORD_FILE）——崩溃 .tmp、系统文件
  // 不参与对账计数（旧实现把一个 .tmp 算成 1 条记录 → 全新库被判「对账依据丢失」）；
  // 非 .json 残留打开期移入 quarantine（字节保留），移动失败只忽略并在 health 报告。
  const opened = await withCrossProcessWriteLock(dir, async () => {
    let manifest
    if (await fileExistsHere(manifestPath)) {
      manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
      if (manifest.sessionKey !== sessionKey || manifest.schemaVersion !== SCHEMA_VERSION) {
        throw v3Error('ESTORE_SESSION_MISMATCH', 'manifest 与请求会话不符（跨会话不串数据的第一道闸）')
      }
    } else {
      manifest = { schemaVersion: SCHEMA_VERSION, sessionKey, txnNext: 1 }
      await writeFileAtomic(manifestPath, JSON.stringify(manifest) + '\n')
    }

    const parsedTxn = await parseTxnLog(logPath, TXN_LOG)
    const lines = parsedTxn.lines
    // 事务日志**缺失**但记录还在（H-21）：对账依据本身丢了，不能把「无法证明已提交」
    // 当成「崩溃残留」——旧实现会把全部记录移进 quarantine，而 health 仍报 healthy，
    // 等于静默全丢（实测 5 条记录 → records/ 清空、quarantine/ 5 条、healthy=true）。
    // 这里判 damaged：读允许（记录字节完好）、写拒绝，交人工裁决；不销毁任何字节。
    const allDiskNames = await readdirOf(path.join(dir, RECORDS_DIR))
    const recordsOnDisk = allDiskNames.filter((name) => RECORD_FILE.test(name))
    const leftoverFiles = allDiskNames.filter((name) => !RECORD_FILE.test(name))
    for (const name of leftoverFiles) {
      await rename(path.join(dir, RECORDS_DIR, name), path.join(dir, QUARANTINE_DIR, name)).catch(() => {})
    }
    // 同一根因的另一个分支：日志文件在、但内容被清空（0 字节 / 只剩空行），而记录与
    // manifest.txnNext（>1，说明历史上确实提交过）都还在——这同样不是「崩溃残留」，
    // 而是对账依据丢失。两种形态一起判 damaged，绝不销毁记录字节。
    const commitLines = lines.filter((line) => line.action === 'commit').length
    const logLostWithRecords = recordsOnDisk.length > 0
      && commitLines === 0
      && Number.isInteger(manifest.txnNext) && manifest.txnNext > 1
    const reconciliationLost = (!parsedTxn.exists || logLostWithRecords) && recordsOnDisk.length > 0
    const vouchersParsed = await parseTxnLog(vouchersPath, VOUCHERS_LOG)
    const forgottenParsed = await parseTxnLog(forgottenPath, FORGOTTEN_LOG)
    const redactionsParsed = await parseTxnLog(redactionsPath, REDACTIONS_LOG)
    const purgedParsed = await parseTxnLog(path.join(dir, PURGED_LOG), PURGED_LOG)
    const orphansParsed = await parseTxnLog(path.join(dir, ORPHAN_LOG), ORPHAN_LOG)
    const orphanRows = orphansParsed.lines.filter((line) => typeof line?.id === 'string' && typeof line?.receiptText === 'string')
    const redactedVouchers = new Set()
    for (const line of redactionsParsed.lines) {
      if (typeof line.voucherId !== 'string') continue
      if (line.action === 'redact') redactedVouchers.add(line.voucherId)
      else if (line.action === 'unredact') redactedVouchers.delete(line.voucherId)
    }
    const forgotten = new Set()
    for (const line of forgottenParsed.lines) {
      if (typeof line.id !== 'string') continue
      if (line.action === 'forget') forgotten.add(line.id)
      else if (line.action === 'revoke') forgotten.delete(line.id)
    }
    const purgedIds = new Set()
    for (const line of purgedParsed.lines) {
      if (typeof line.id === 'string' && line.action === 'purge') purgedIds.add(line.id)
    }

    const committedIds = new Set()
    let maxTxn = 0
    for (const line of lines) {
      if (line.action === 'commit' && Number.isInteger(line.txn)) {
        maxTxn = Math.max(maxTxn, line.txn)
        for (const id of line.recordIds ?? []) committedIds.add(id)
      }
    }
    // 有 payload 无 commit 行 → 崩溃残留，移入 quarantine（对账即隔离，不静默复用）。
    // 反方向（H-55）：**有 commit 行、无 payload** 同样是账实不符，但旧实现完全没查——
    // 对账只做「盘上多出来的」，不做「日志里有而盘上没有的」。后果：health 报 healthy=true、
    // recordCount 把不存在的记录算进去（实测 3 条里删掉 1 条仍报 3），而 rebuildIndex 遍历
    // listRecordIds 时读不到那条 → 抛 ESTORE_CORRUPT，整个索引重建面被一条缺失字节打挂；
    // 写入却照常成功，缺口被固化。判据与 H-21 同口径：账实不符即 damaged（读允许、写拒绝），
    // **不伪造、不删除任何字节**。
    const idsOnDisk = new Set(recordsOnDisk.map((name) => name.slice(0, -5)))
    // H4：已 purge 的记录按定义没有 payload，不算账实不符。
    const missingPayload = [...committedIds].filter((id) => !idsOnDisk.has(id) && !purgedIds.has(id))
    // 已清除的记录不再参与「已提交集」：读面、导出、索引、条数都不该把它们算回来。
    for (const id of purgedIds) committedIds.delete(id)
    const ledgerMismatch = missingPayload.length > 0
    // H-55：账实不符（commit 行在、payload 不在）与 H-21（对账依据丢失）同一处置：
    // 判 damaged，读允许、写拒绝，交人工裁决。两者都**不销毁字节、不伪造记录**。
    const ledgerMismatchReason = ledgerMismatch
      ? TXN_LOG + ' 有 ' + missingPayload.length + ' 条 commit 但记录文件缺失（' + missingPayload.slice(0, 5).join('、') + (missingPayload.length > 5 ? ' 等' : '') + '）：账实不符，读允许、写拒绝，需人工确认'
      : null
    const damaged = parsedTxn.damaged || reconciliationLost || ledgerMismatch
    const reason = ledgerMismatchReason
      ?? (reconciliationLost
        ? TXN_LOG + (parsedTxn.exists ? ' 无 commit 行' : ' 缺失') + '但记录仍在（' + recordsOnDisk.length + ' 条，manifest.txnNext=' + manifest.txnNext + '）：对账依据丢失，读允许、写拒绝，需人工确认'
        : parsedTxn.reason)
    // P1-03 第二阶段补完：purge 是「先落 purged 账本、再删正文」两阶段，两步之间崩溃会留下
    // 「账已清、文件还在」。打开期把删除补完（幂等），而不是把残留当孤儿挪进 quarantine——
    // quarantine 是只进不出的人工审计区，已承诺物理清除的隐私字节不能停在那里。
    const purgedCleanup = []
    if (!damaged) {
      for (const id of [...purgedIds]) {
        if (!idsOnDisk.has(id)) continue
        try {
          await rm(path.join(dir, RECORDS_DIR, id + '.json'), { force: true })
          idsOnDisk.delete(id)
          purgedCleanup.push(id)
        } catch {
          // 删不掉：账已清（读面不会返回它），不阻断打开；下一次打开继续补。
        }
      }
    }
    const onDiskNow = recordsOnDisk.filter((name) => idsOnDisk.has(name.slice(0, -5)))
    const orphaned = []
    if (!damaged && !ledgerMismatch) {
      for (const name of onDiskNow) {
        const id = name.slice(0, -5)
        if (!committedIds.has(id)) {
          await rename(path.join(dir, RECORDS_DIR, name), path.join(dir, QUARANTINE_DIR, name))
          orphaned.push(id)
        }
      }
    }
    // 事务号分配器自愈（H-56）：`txnNext` 必须是 **≥1 的整数**。
    // 旧实现只比 `txnNext <= maxTxn`，于是 `1.5` / `"7"` / `undefined` 这类非法值
    // 一路漏过打开期——open 成功、health 原样回显垃圾值（`txnNext: 1.5` / `"7"`），
    // 而**每一次写入**都在 rereadManifestTxnNext 里抛 ESTORE_CORRUPT：
    // 存储自称健康却永远写不进去，观察面也看不到根因。
    // 自愈方向是确定的、可证明安全的：`maxTxn+1` 一定没被用过（maxTxn 取自事务日志）。
    const txnNextValid = Number.isInteger(manifest.txnNext) && manifest.txnNext >= 1
    if (!txnNextValid || manifest.txnNext <= maxTxn) {
      manifest = { ...manifest, txnNext: maxTxn + 1 }
      await writeFileAtomic(manifestPath, JSON.stringify(manifest) + '\n')
    }
    // B3-5（AUD50-03-04）：commit 行丢失但 manifest 已推进（事务号已消耗）→ 如实报告
    // commit-lost，不只当 orphan 静默隔离——号不复用的前提下，这段缺口「发生过提交」
    // 但提交行不可考。已 damaged 的库由 damagedReason 说明（本字段只补健康库上的事实）。
    const commitLost = !damaged && manifest.txnNext > maxTxn + 1
      ? { gap: manifest.txnNext - maxTxn - 1, missingFrom: maxTxn + 1, missingTo: manifest.txnNext - 1, orphanedCount: orphaned.length }
      : null
    return { manifest, parsedTxn, leftoverFiles, orphaned, damaged, reason, committedIds, maxTxn, forgotten, redactedVouchers, vouchersParsed, forgottenParsed, redactionsParsed, purgedParsed, orphansParsed, orphanRows, commitLost }
  }, options.lock)

  let manifest = opened.manifest
  const parsedTxn = opened.parsedTxn
  const leftoverFiles = opened.leftoverFiles
  const orphaned = opened.orphaned
  const damaged = opened.damaged
  const reason = opened.reason
  const committedIds = opened.committedIds
  // maxTxn 是 syncFromLog 闭包要推进的可变绑定（跨句柄提交后本句柄视图同步），
  // 必须留在 store 作用域，不能关进打开期锁回调里。
  let maxTxn = opened.maxTxn
  const forgotten = opened.forgotten
  const redactedVouchers = opened.redactedVouchers
  const vouchersParsed = opened.vouchersParsed
  const forgottenParsed = opened.forgottenParsed
  const redactionsParsed = opened.redactionsParsed
  // P1-08：redactions.jsonl 的 `seq` 字段（清除回执时落下的新节点 seq）。
  // 老账本（升级前的库）没有这个字段 → 这里查不到，`redactionSeqOf` 返回 null。
  const redactedVoucherSeqs = new Map()
  // A-01（0.15.4）：restore 落下的恢复节点 seq。与上面的 redacted 映射**分账**：
  // redacted 回答「这张凭证被清除了吗」，restored 回答「它现在落在哪个节点上」。
  const restoredVoucherSeqs = new Map()
  // A-01 失败关闭判据：恢复正文的指纹（sha256）。正文被宿主改写即指纹不符 → 不覆盖。
  const restoredVoucherHashes = new Map()
  for (const line of redactionsParsed.lines) {
    if (typeof line.voucherId !== 'string') continue
    if (line.action === 'redact') {
      if (Number.isInteger(line.seq) && line.seq > 0) redactedVoucherSeqs.set(line.voucherId, line.seq)
      else redactedVoucherSeqs.delete(line.voucherId)
    } else if (line.action === 'unredact') {
      redactedVoucherSeqs.delete(line.voucherId)
    } else if (line.action === 'restored') {
      // restore 落面产生的新节点；后续 redact 靠它定位（不再依赖已消失的回执正文）。
      if (Number.isInteger(line.seq) && line.seq > 0) restoredVoucherSeqs.set(line.voucherId, line.seq)
      else restoredVoucherSeqs.delete(line.voucherId)
      if (typeof line.textHash === 'string' && line.textHash.length > 0) restoredVoucherHashes.set(line.voucherId, line.textHash)
      else restoredVoucherHashes.delete(line.voucherId)
    }
  }
  const purgedParsed = opened.purgedParsed
  // P1-07：孤儿回执（补凭证放弃后留下的回执；restore 的兜底来源）。
  const orphansParsed = opened.orphansParsed
  const orphanRows = opened.orphanRows
  const commitLost = opened.commitLost

  let closed = false
  let writable = !damaged
  const vouchersDamaged = vouchersParsed.damaged
  const voucherLines = vouchersParsed.lines
  // H6：凭证 ID 唯一性索引（open 时由账本构建；append / 锁内刷新时同步）。
  const voucherIdSet = new Set(voucherLines.map((voucher) => voucher?.voucherId).filter((id) => typeof id === 'string'))

  /**
   * 锁内重读凭证账本（H6）：`listVouchers()` 返回的是**本句柄打开期解析的内存数组**，
   * 另一个进程刚追加的凭证它看不到；旧去重检查就在这个过期视图上做 .some()，于是
   * 两进程会各追加一条同 ID 凭证（v-<seq>），restore(序号) 的下标随之错位。
   * 调用方必须已在会话跨进程写锁内（端口 appendVoucher 会保证）。
   */
  async function refreshVouchersFromDisk() {
    if (vouchersDamaged) return
    const parsed = await parseTxnLog(vouchersPath, VOUCHERS_LOG)
    if (parsed.damaged) throw v3Error('ESTORE_DAMAGED', VOUCHERS_LOG + ' 损坏：' + (parsed.reason ?? '未给出原因') + '（凭证视图不可刷新，失败关闭）')
    voucherLines.length = 0
    for (const line of parsed.lines) voucherLines.push(line)
    voucherIdSet.clear()
    for (const voucher of voucherLines) {
      if (typeof voucher?.voucherId === 'string') voucherIdSet.add(voucher.voucherId)
    }
  }
  const purgedIds = new Set()
  for (const line of purgedParsed.lines) {
    if (typeof line.id === 'string' && line.action === 'purge') purgedIds.add(line.id)
  }
  let purgedStamp = await fileStampOf(path.join(dir, PURGED_LOG))
  // 遗忘账本损坏（H-09）：前缀之外可能有 forget 行读不到，「哪些被遗忘」不可判定。
  // 此时读路径必须失败关闭——否则已遗忘正文重新可读（隐私面 fail-open）。
  let forgottenDamaged = forgottenParsed.damaged
  let forgottenReason = forgottenParsed.reason ?? null
  // R23（QC 复核）：清除账本的损坏此前**不参与**健康判据，也不挡 purge()。
  // 后果与 P1-03 原症状同构：purged.jsonl 中段坏行 → 前缀读不到那些 purge 行 →
  // 「commit 在、payload 已被上一次 purge 删掉」被算成账实不符 → 整库 ESTORE_DAMAGED，
  // 而 repair 又说不用修。与 forgotten 同族（append-only 隐私账本）必须同口径失败关闭。
  let purgedDamaged = purgedParsed.damaged
  let purgedReason = purgedParsed.reason ?? null
  // 文件戳：别的句柄/进程追加 forget 行后，本句柄必须能察觉（见 refreshForgotten）。
  let forgottenStamp = await fileStampOf(forgottenPath)
  // T-03（0.15.4，P1）：redactions.jsonl 的**跨句柄可见性**。
  //
  // 缺陷：`redactedVouchers` 是打开期解析的内存集合，只有本句柄自己调
  // `markVoucherRedacted` 时才会更新；别的句柄/进程清除一张回执后，本句柄仍然认为
  // 它「未清除」→ 导出把已声明清除的回执正文原样带出（计划 §7.4 的泄露）。
  // forgotten/purged 早已按文件戳刷新，唯独 redactions 漏了——这里补齐同一口径。
  let redactionsStamp = await fileStampOf(path.join(dir, REDACTIONS_LOG))

  /**
   * T-03：按文件戳刷新清除账本（成本 = 未变化时一次 stat）。
   *
   * **语义**：必须在所有读 `redactedVouchers` / `redactedVoucherSeqs` /
   * `restoredVoucherSeqs` 的入口前调用，否则第二个句柄会看到过期视图。
   * 损坏时**不刷新**（保持 `redactionsParsed.damaged` 的失败关闭状态），由
   * `redactionSeqOf` 等按既有口径抛 ESTORE_DAMAGED。
   */
  async function refreshRedactions() {
    const stampNow = await fileStampOf(path.join(dir, REDACTIONS_LOG))
    if (stampNow === redactionsStamp) return
    redactionsStamp = stampNow
    let parsed
    try {
      parsed = await parseTxnLog(path.join(dir, REDACTIONS_LOG), REDACTIONS_LOG)
    } catch { return } // 读不到（瞬态）→ 保留旧视图，下一次调用再试
    if (parsed.damaged) return // 坏账本不覆盖内存视图：读路径继续失败关闭
    redactedVouchers.clear()
    redactedVoucherSeqs.clear()
    restoredVoucherSeqs.clear()
    restoredVoucherHashes.clear()
    for (const line of parsed.lines) {
      if (typeof line.voucherId !== 'string') continue
      if (line.action === 'redact') {
        redactedVouchers.add(line.voucherId)
        if (Number.isInteger(line.seq) && line.seq > 0) redactedVoucherSeqs.set(line.voucherId, line.seq)
      } else if (line.action === 'unredact') {
        redactedVouchers.delete(line.voucherId)
        redactedVoucherSeqs.delete(line.voucherId)
      } else if (line.action === 'restored') {
        if (Number.isInteger(line.seq) && line.seq > 0) restoredVoucherSeqs.set(line.voucherId, line.seq)
        if (typeof line.textHash === 'string' && line.textHash.length > 0) restoredVoucherHashes.set(line.voucherId, line.textHash)
      }
    }
  }
  const health = () => ({
    healthy: !damaged && !vouchersDamaged && !forgottenDamaged && !purgedDamaged,
    damagedReason: damaged
      ? reason
      : (vouchersDamaged
        ? vouchersParsed.reason
        : (forgottenDamaged ? forgottenReason : (purgedDamaged ? purgedReason : null))),
    txnNext: manifest.txnNext,
    // B2-8：事务日志的最大提交号（检查点新鲜度比对基线）
    maxTxn,
    recordCount: committedIds.size,
    orphanedAtOpen: orphaned,
    // B2-6：打开期从 records/ 移入 quarantine 的非记录残留（.tmp 等），供诊断面报告
    leftoversAtOpen: leftoverFiles,
    voucherCount: voucherLines.length,
    vouchersDamaged,
    forgottenCount: forgotten.size,
    forgottenDamaged,
    purgedCount: purgedIds.size,
    purgedDamaged,
    // B3-5：打开期检出的 commit 行丢失缺口（null = 无缺口）；可见、可判读，不静默
    commitLostAtOpen: commitLost,
  })

  /**
   * 遗忘集合读前刷新（隐私面跨句柄一致性）。
   *
   * 遗忘集合在 open 时解析一次，之后只由本句柄的 `forget()` 追加。另一个句柄/进程
   * forget 之后，本句柄的集合是旧的：`readRecord` 会把已遗忘正文照常返回，
   * `rebuildIndex` 会把已遗忘记录重新写进索引——「已忘内容重新可见」。
   * 判据用文件戳（mtimeMs+size），未变化时成本只有一次 stat。
   */
  async function refreshForgotten() {
    // 清除账本的刷新**不能**挂在「遗忘账本变了」之后：已经忘记过的记录再 purge 时，
    // forgotten.jsonl 不会新增行（只剩 purged.jsonl 一行），旧写法会一直看不到 purged，
    // 于是另一个句柄把已删除的文件当 ESTORE_CORRUPT（而不是 EFORGOTTEN），索引也可能把它
    // 重新算进可检索集。这里每次顺手 stat 一次 purged（成本一次 stat）。
    const purgedNow = await fileStampOf(path.join(dir, PURGED_LOG))
    if (purgedNow !== purgedStamp) {
      const purgedParsedNow = await parseTxnLog(path.join(dir, PURGED_LOG), PURGED_LOG)
      purgedIds.clear()
      for (const line of purgedParsedNow.lines) {
        if (typeof line.id === 'string' && line.action === 'purge') purgedIds.add(line.id)
      }
      for (const id of purgedIds) committedIds.delete(id)
      // T-04（0.15.4）：刷新时**必须同步更新 damaged 判据**。
      //
      // 旧实现只重算 `purgedIds`，不更新 `purgedDamaged`/`purgedReason`——那两个值仍是
      // **打开期快照**。后果：运行期账本被外部写坏（中段损坏、尾行半行）时，
      // 本句柄照常追加、照常报 healthy，而「写成功但读不出来」的记录从此不可见。
      // 五本账本里只有 forgotten 做了这件事，其余四本都没有，这里补齐其中最容易
      // 在运行期被外部改写的 purged。
      purgedDamaged = purgedParsedNow.damaged
      purgedReason = purgedParsedNow.reason ?? null
      purgedStamp = purgedNow
    }
    const stamp = await fileStampOf(forgottenPath)
    if (stamp === forgottenStamp) return
    const parsed = await parseTxnLog(forgottenPath, FORGOTTEN_LOG)
    forgotten.clear()
    for (const line of parsed.lines) {
      if (typeof line.id !== 'string') continue
      if (line.action === 'forget') forgotten.add(line.id)
      else if (line.action === 'revoke') forgotten.delete(line.id)
    }
    forgottenDamaged = parsed.damaged
    forgottenReason = parsed.reason ?? null
    forgottenStamp = stamp
  }

  /** 遗忘账本损坏时的读闸：读不到 ≠ 没遗忘（隐私面失败关闭）。 */
  function assertForgottenReadable() {
    if (forgottenDamaged) {
      throw v3Error('ESTORE_DAMAGED', 'forgotten.jsonl 损坏：' + (forgottenReason ?? '未给出原因') + '（无法判定哪些记录已被遗忘，读路径失败关闭；修复后重开）')
    }
  }

  /**
   * 重读盘上 manifest 的 txnNext（并把已提交集合补齐：别的句柄可能刚提交过）。
   * 解析失败 → ESTORE_CORRUPT（不猜、不沿用过期值）。
   */
  async function rereadManifestTxnNext() {
    let text
    try {
      text = await readFile(manifestPath, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') throw v3Error('ESTORE_CORRUPT', 'manifest.json 缺失（无法分配事务号，失败关闭）')
      throw error
    }
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      throw v3Error('ESTORE_CORRUPT', 'manifest.json 不可解析（事务号不可判定，失败关闭）')
    }
    if (parsed?.sessionKey !== sessionKey || parsed?.schemaVersion !== SCHEMA_VERSION) {
      throw v3Error('ESTORE_SESSION_MISMATCH', 'manifest 与请求会话不符（跨会话不串数据的第一道闸）')
    }
    if (!Number.isInteger(parsed.txnNext) || parsed.txnNext < 1) {
      throw v3Error('ESTORE_CORRUPT', 'manifest.txnNext 非法：' + JSON.stringify(parsed.txnNext))
    }
    // P2-01（调用侧自愈）：分配器**落后于日志**（parsed.txnNext <= 本句柄已知 maxTxn）意味着
    // 上一次提交的 commit 行已落盘、manifest 推进却失败了。此时沿用旧值会**复用事务号**
    // （号不复用是对账的前提）。判据与打开期自愈同源：maxTxn+1 一定没被用过。
    if (parsed.txnNext <= maxTxn) {
      const healed = { ...parsed, txnNext: maxTxn + 1 }
      try {
        await writeFileAtomic(manifestPath, JSON.stringify(healed) + '\n')
      } catch (error) {
        // 修不动就失败关闭：宁可拒绝这一笔，也不能带着可能复用的号写下去。
        throw v3Error('ESTORE_CORRUPT', 'manifest.txnNext=' + parsed.txnNext + ' 落后于日志（maxTxn=' + maxTxn + '）且无法自愈：' + (error?.code ?? error?.message ?? String(error)))
      }
      manifest = healed
      return { ...healed }
    }
    return { ...parsed }
  }

  function assertWritable() {
    if (closed) {
      throw v3Error('ESTORE_CLOSED', '存储句柄已 close：一切写原语失败关闭（G9 句柄生命周期）')
    }
    if (!writable) {
      throw v3Error('ESTORE_DAMAGED', '存储已判 damaged（' + reason + '）：读允许、写拒绝，修复后重开')
    }
  }

  return {
    health,

    /** 提交一笔事务：全有或全无（任一记录非法/冲突即整笔拒绝，不烧号）。 */
    async submitTransaction(records, { at } = {}) {
      assertWritable()
      if (!Array.isArray(records) || records.length === 0) {
        throw new V3ContractViolation('v3 store: 事务必须包含至少一条记录')
      }
      for (const record of records) {
        assertValidRecord(record)
        // 写入侧也守会话归属：结构合法不等于属于本会话。放进来之后读路径才拒，
        // 等于先污染再报错——账本里会永远躺着一条本会话无法解释的记录。
        if (record.sessionKey !== sessionKey) {
          throw v3Error('ESTORE_SESSION_MISMATCH', '记录 ' + record.id + ' 属于会话 ' + JSON.stringify(record.sessionKey) + '，拒绝写入本会话 ' + JSON.stringify(sessionKey))
        }
      }
      const ids = records.map((r) => r.id)
      // 已存在（已提交）的 ID → 冲突拒绝（重试须用新事务，不得覆盖）
      for (const id of ids) {
        if (committedIds.has(id) || (await fileExistsHere(path.join(dir, RECORDS_DIR, id + '.json')))) {
          throw v3Error('ESTORE_TXN_CONFLICT', '记录已存在：' + id + '（重试须用新 ID/新事务，不覆盖）')
        }
      }
      // 分配器必须**锁内重读**（H-10）：manifest.txnNext 是磁盘上的分配器，内存副本在
      // 第二个句柄/进程写入后就过期了；沿用旧值会让事务号复用（号不复用是对账的前提）。
      manifest = await rereadManifestTxnNext()
      const txn = manifest.txnNext
      const commitAt = Number.isFinite(at) && at >= 0 ? at : null
      // 步骤 2：逐条原子写 payload
      for (const record of records) {
        await writeFileAtomic(path.join(dir, RECORDS_DIR, record.id + '.json'), JSON.stringify(record) + '\n')
      }
      // 步骤 3：commit 行（提交点——此行落盘前的一切都是可隔离残留）
      //
      // T-01（0.15.4，P1）**追加门**：提交前必须确认 transactions.jsonl 的**尾部**
      // 仍是完好行。理由：`damaged` 是打开期快照，在飞期间账本被别处撕坏（磁盘满、
      // 断电、另一进程半写）时它不会更新。旧实现直接 appendLine，commit 行落在坏行
      // 之后 → 重开整库只读，而 `repair` 只修尾部半行、认为「无需修复」，于是：
      // **提交看起来成功、重开后整库不可写**。
      // 与 checkpoint 的两处追加共用同一实现（inspectAppendTail），失败即拒绝本笔，
      // 保留可恢复残留（payload 已落，重试可用新事务补账），绝不假成功。
      const txnTail = await inspectAppendTail(path.join(dir, TXN_LOG), TXN_LOG)
      if (txnTail.appendable !== true) {
        throw v3Error('ESTORE_DAMAGED', TXN_LOG + ' 尾部不可追加（' + (txnTail.reason ?? '未给出原因') + '）：拒绝提交事务 txn=' + txn + '，已落盘的 payload 保留为可恢复残留，请先 repair')
      }
      const commitLine = { action: 'commit', txn, recordIds: ids }
      if (commitAt !== null) commitLine.at = commitAt
      await appendLine(logPath, commitLine, { sync: true })
      for (const id of ids) committedIds.add(id)
      // commit 行已 fsync：**事实已提交**。先把本句柄的可分配下界推进，
      // 再尝试写 manifest（两者顺序与对账口径一致：日志是真源，manifest 是分配器缓存）。
      if (txn > maxTxn) maxTxn = txn
      // 步骤 4：推进事务号
      const advanced = { ...manifest, txnNext: txn + 1 }
      try {
        await writeFileAtomic(manifestPath, JSON.stringify(advanced) + '\n')
        manifest = advanced
      } catch (error) {
        // P2-01：旧实现把「manifest 写失败」当成整笔事务失败抛出，而 commit 行已经落盘。
        // 调用方据此认为没提交 → 换新 ID 重试 → **同一段内容进库两次**（重复摄入），
        // 而账本无法说明哪一条该在。提交语义以 commit 行为准：如实返回成功 + 标记，
        // 分配器由 rereadManifestTxnNext 的调用侧自愈接手（判据同源，号仍不复用）。
        manifest = advanced
        return { txn, recordIds: [...ids], manifestAdvanceFailed: true, manifestError: error?.code ?? error?.message ?? String(error) }
      }
      return { txn, recordIds: [...ids] }
    },

    /** 导入（M5 fork/share 的落地）：把外部脱敏包正文写成**新记录**，不保留外部 ID/事务号。 */
    async importRecords(inputs) {
      assertWritable()
      if (!Array.isArray(inputs) || inputs.length === 0) {
        throw new V3ContractViolation('v3 store: importRecords 必须是非空数组')
      }
      const at = Date.now()
      const prepared = inputs.map((input, index) => {
        const text = input?.payload?.text
        if (typeof input?.kind !== 'string' || typeof text !== 'string') {
          throw new V3ContractViolation('v3 store: importRecords 每条需要 kind 与 payload.text')
        }

        // B3-20（AUD50-07-02）：导入按 validateRecord 同口径整包预检。旧实现收下
        // 「空正文且非 metaOnly」「未知 kind」「structure 不可 JSON 序列化」的包，
        // 导入成功、读取时才 ESTORE_CORRUPT（audit-import-empty 实测）——库被污染。
        // 预检在 submitTransaction 之前逐条抛错，一条不过整包不落库。
        if (!RECORD_KINDS.includes(input.kind)) {
          throw new V3ContractViolation('v3 store: importRecords kind 必须是封闭集 ' + RECORD_KINDS.join('/') + ' 之一，得到：' + JSON.stringify(input.kind))
        }
        if (text === '' && input.payload.metaOnly !== true) {
          throw new V3ContractViolation('v3 store: importRecords 空正文必须 metaOnly=true（第 ' + index + ' 条）')
        }
        if (input.payload.structure !== null && typeof input.payload.structure === 'object') {
          try { JSON.parse(JSON.stringify(input.payload.structure)) } catch {
            throw new V3ContractViolation('v3 store: importRecords structure 必须可 JSON 序列化（第 ' + index + ' 条）')
          }
        }
        // AUD48-08-03：导入必须保留 metaOnly / structure；否则导出再导入后
        // 「仅元数据」记录会被当成空正文损坏，工具调用参数也会丢失。
        const payload = { text, bytes: Buffer.byteLength(text, 'utf8') }
        if (input.payload.metaOnly === true) payload.metaOnly = true
        if (typeof input.payload.metaReason === 'string' && input.payload.metaReason.length > 0) payload.metaReason = input.payload.metaReason
        if (input.payload.structure !== null && typeof input.payload.structure === 'object') {
          payload.structure = structuredClone(input.payload.structure)
        }
        return {
          id: 'v3r-' + randomUUID().replace(/-/g, '').slice(0, 16),
          kind: input.kind,
          sessionKey,
          createdAt: at + index,
          payload,
          provenance: { sourceEventId: null, sourceForm: 'import', transactionId: 'import-' + randomUUID() },
        }
      })
      return await this.submitTransaction(prepared, { at })
    },

    /** 精确回读：JSON 解析失败或结构非法 → ESTORE_CORRUPT（失败关闭，不静默当空）。 */
    async readRecord(id) {
      // AUD51-03-01：先过**形状白名单**再拼路径。旧实现只查「非空字符串」，
      // `../x` / `..\\x` / 绝对路径都能把 records/<id>.json 指到本会话目录里
      // 别的合法 JSON 上（读得到就认 = 穿越）。形状是第一道闸，路径只是它的结果。
      if (!isRecordId(id)) {
        throw v3Error('EINVALID_ID', '记录 ID 非法：' + JSON.stringify(id) + '（必须形如 v3r-<16 位小写十六进制>）')
      }
      // 遗忘集合必须**读前刷新**：另一个句柄/进程刚 forget 过的记录，本句柄若只用手里的
      // 旧集合判定，就会把已遗忘的正文照常返回——这是「已忘内容重新可见」的隐私回退。
      // 判据用文件戳（mtime+size），没变化时只多一次 stat。
      await refreshForgotten()
      assertForgottenReadable()
      if (purgedIds.has(id)) {
        // H4：物理清除后与遗忘同口径（EFORGOTTEN），不暴露「曾经存在但被删」的差异。
        throw v3Error('EFORGOTTEN', '记录 ' + id + ' 已被物理清除（forget purge），正文不可恢复')
      }
      if (forgotten.has(id)) {
        throw v3Error('EFORGOTTEN', '记录已遗忘：' + id + '（隐私面：不可按 ID 回读）')
      }
      let text
      try {
        text = await readFile(path.join(dir, RECORDS_DIR, id + '.json'), 'utf8')
      } catch (error) {
        if (error?.code === 'ENOENT') {
          // 隔离区里有的话如实说明（崩溃残留不是「从未存在」）
          if (await fileExistsHere(path.join(dir, QUARANTINE_DIR, id + '.json'))) {
            throw v3Error('ESTORE_CORRUPT', '记录 ' + id + ' 是崩溃残留（已隔离），未提交，不可读')
          }
          // 账实不符先于 not-found：commit 行说已提交、记录文件却没有 = 账有实无（H-55），
          // 是损坏不是「从未存在」——否则 B3-17 的改分类会把真实缺口洗成「ID 输错」。
          if (committedIds.has(id)) {
            throw v3Error('ESTORE_CORRUPT', '记录 ' + id + ' 账实不符：事务日志已提交但记录文件缺失（损坏，失败关闭）')
          }
          // B3-17（AUD50-06-06）：未知 ID ≠ 损坏——旧实现共用 ESTORE_CORRUPT，
          // 用户输错 ID 被报「库损坏」。未提交/不存在走 ERECORD_NOT_FOUND。
          throw v3Error('ERECORD_NOT_FOUND', '记录不存在：' + id + '（未提交或 ID 不存在；不是库损坏）')
        }
        throw error
      }
      let record
      try {
        record = JSON.parse(text)
      } catch {
        throw v3Error('ESTORE_CORRUPT', '记录 ' + id + ' JSON 不可解析（损坏，失败关闭）')
      }
      const validation = validateRecord(record)
      if (!validation.ok) {
        throw v3Error('ESTORE_CORRUPT', '记录 ' + id + ' 结构非法：' + validation.errors.join('；'))
      }
      // 跨会话记录不得被当作本会话事实：记录被拷进来/ID 被换成另一条合法记录时，
      // 结构性校验照样通过。会话隔离是硬不变量，读路径必须自己确认归属。
      if (record.sessionKey !== sessionKey) {
        throw v3Error('ESTORE_SESSION_MISMATCH', '记录 ' + id + ' 属于会话 ' + JSON.stringify(record.sessionKey) + '，不是本会话 ' + JSON.stringify(sessionKey))
      }
      return record
    },

    directory: dir,

    /** 追加恢复凭证：归档裁决的 durable 映射（recordIds ↔ targetEventId ↔ 回执正文）。 */
    async appendVoucher(voucher) {
      assertWritable()
      // 账本自己损坏时拒绝追加：新行会落在坏行之后，解析器遇首个坏行即停，
      // 于是「写成功、永不可读」，而健康面还报 healthy。账本不可判定 = 不许产生新事实。
      // 注意这**只**挡凭证写入：记录写入与遗忘账本是独立故障面（H-09 口径）。
      if (vouchersDamaged) {
        throw v3Error('ESTORE_DAMAGED', 'vouchers.jsonl 损坏（' + (vouchersParsed.reason ?? '未给出原因') + '）：拒绝追加凭证，修复后重开')
      }
      if (voucher === null || typeof voucher !== 'object') {
        throw new V3ContractViolation('v3 store: voucher 必须是对象')
      }
      // H-54：元素必须是**非空**字符串（与 forget 的校验同口径）。旧实现只查 typeof，
      // 空串能进账本，而账本里一条指向空 ID 的凭证在恢复面上永远不可能有资格，
      // 却会占一个 voucherIndex（下标是恢复的唯一定位方式）。
      // 注意：**空数组是合法的**——凭证可以只绑定 targetEventId 而不绑定任何 v3 记录
      // （surface 恢复凭证就是这种形状，见 test/v3-session-lifecycle.test.mjs）。
      if (!Array.isArray(voucher.recordIds) || voucher.recordIds.some((id) => typeof id !== 'string' || id.length === 0)) {
        throw new V3ContractViolation('v3 store: voucher.recordIds 必须是非空字符串组成的数组')
      }
      // v2：历史 span 回执用数字 seq；v1 的 surface 恢复凭证用字符串事件 ID。
      const target = voucher.targetEventId
      const targetOk = (typeof target === 'string' && target.length > 0)
        || (Number.isInteger(target) && target >= 1)
      if (!targetOk) {
        throw new V3ContractViolation('v3 store: voucher.targetEventId 必须是非空字符串或 ≥1 的整数 seq')
      }
      if (typeof voucher.receiptText !== 'string' || voucher.receiptText.length === 0) {
        throw new V3ContractViolation('v3 store: voucher.receiptText 必须是非空字符串')
      }
      for (const key of ['sourceEventSeqs', 'startSeq', 'endSeq']) {
        if (voucher[key] === undefined) continue
        if (key === 'sourceEventSeqs') {
          if (!Array.isArray(voucher.sourceEventSeqs)
            || voucher.sourceEventSeqs.some((seq) => !Number.isInteger(seq) || seq < 0)) {
            throw new V3ContractViolation('v3 store: voucher.sourceEventSeqs 必须是非负整数数组')
          }
        } else if (!Number.isInteger(voucher[key]) || voucher[key] < 0) {
          throw new V3ContractViolation('v3 store: voucher.' + key + ' 必须是非负整数')
        }
      }
      if (!Number.isInteger(voucher.txn) || voucher.txn < 1) {
        throw new V3ContractViolation('v3 store: voucher.txn 必须是 ≥1 整数')
      }
      // H6：ID 唯一由**存储层**强制（不是调用方先查后写）。先刷新磁盘视图，再判重；
      // 端口已在跨进程锁内，所以「刷新 → 判重 → 追加」对另一进程是原子的。
      if (typeof voucher.voucherId === 'string' && voucher.voucherId.length > 0) {
        await refreshVouchersFromDisk()
        if (voucherIdSet.has(voucher.voucherId)) {
          throw v3Error('ESTORE_DUPLICATE_VOUCHER', '凭证 ID 已存在：' + voucher.voucherId + '（并发对账/重放，拒绝第二条）')
        }
      }
      await appendLine(vouchersPath, voucher, { sync: true })
      voucherLines.push(voucher)
      if (typeof voucher.voucherId === 'string') voucherIdSet.add(voucher.voucherId)
      return { voucherCount: voucherLines.length }
    },

    /** 列恢复凭证；凭证账本损坏 → ESTORE_DAMAGED（失败关闭，不静默当空）。 */
    listVouchers() {
      if (vouchersDamaged) {
        throw v3Error('ESTORE_DAMAGED', 'vouchers.jsonl 损坏：' + vouchersParsed.reason + '（恢复凭证不可用，修复后重开）')
      }
      // H-53：返回**副本**，不是内部对象引用。旧实现 `[...voucherLines]` 只浅拷贝了数组，
      // 元素还是同一个对象、`recordIds` 还是同一个数组——调用方（恢复命令面）改一下就
      // 污染了内存态，而磁盘上还是旧值：内存与账本分叉，且下次 `restore` 按
      // `voucher.receiptText` 做逐字节比对时会用一个**从没落过盘**的正文去比。
      return voucherLines.map((voucher) => ({
        ...voucher,
        recordIds: Array.isArray(voucher.recordIds) ? [...voucher.recordIds] : voucher.recordIds,
        ...(Array.isArray(voucher.sourceEventSeqs) ? { sourceEventSeqs: [...voucher.sourceEventSeqs] } : {}),
      }))
    },

    /**
     * P1-07：记一条**孤儿回执**（补凭证放弃后仍可恢复的兜底线索）。
     *
     * 为什么需要：intent 补账失败（磁盘满 / vouchers.jsonl 中段损坏）时，旧实现永远
     * `kept:true`——该段原文没有凭证、restore 永远找不到它，同时槽位被占，**该会话的
     * 新归档全停**。放弃时必须先把回执正文与 recordIds 落到独立账本，再清槽；顺序反过来
     * 就是「放弃了却连恢复线索一起丢」。
     *
     * 幂等：id = `o-<receiptSeq>`（surface 节点 seq 唯一），重复放弃同一条不写第二行。
     */
    async appendOrphanReceipt(row) {
      assertWritable()
      if (orphansParsed.damaged) {
        throw v3Error('ESTORE_DAMAGED', ORPHAN_LOG + ' 损坏（' + (orphansParsed.reason ?? '未给出原因') + '）：无法记录孤儿回执')
      }
      if (row === null || typeof row !== 'object') throw new V3ContractViolation('v3 store: 孤儿回执行必须是对象')
      if (!Number.isInteger(row.receiptSeq) || row.receiptSeq < 1) throw new V3ContractViolation('v3 store: 孤儿回执 receiptSeq 必须是 ≥1 整数')
      if (typeof row.receiptText !== 'string' || row.receiptText.length === 0) throw new V3ContractViolation('v3 store: 孤儿回执 receiptText 必须是非空字符串')
      if (!Array.isArray(row.recordIds) || row.recordIds.some((id) => typeof id !== 'string' || id.length === 0)) {
        throw new V3ContractViolation('v3 store: 孤儿回执 recordIds 必须是非空字符串数组')
      }
      const id = 'o-' + row.receiptSeq
      if (orphanRows.some((line) => line.id === id)) return { changed: false, id }
      const line = { ...row, id }
      await appendLine(path.join(dir, ORPHAN_LOG), line, { sync: true })
      orphanRows.push(line)
      return { changed: true, id }
    },

    /** 列孤儿回执（restore 兜底）；损坏 → 失败关闭（不把「读不到」当「没有」）。 */
    listOrphanReceipts() {
      if (orphansParsed.damaged) {
        throw v3Error('ESTORE_DAMAGED', ORPHAN_LOG + ' 损坏（' + (orphansParsed.reason ?? '未给出原因') + '）：孤儿回执不可读')
      }
      return orphanRows.map((row) => ({
        ...row,
        recordIds: Array.isArray(row.recordIds) ? [...row.recordIds] : [],
        ...(Array.isArray(row.sourceEventSeqs) ? { sourceEventSeqs: [...row.sourceEventSeqs] } : {}),
      }))
    },

    /**
     * A-05（0.15.4）：把含指定记录的孤儿回执正文清除掉。
     *
     * 旧缺陷：`orphan-receipts.jsonl` 保存的是**明文回执正文**，却完全不在遗忘/清除
     * 级联里——用户 forget/purge 之后，这段明文永久留在盘上，而且因为没有对应凭证，
     * `restore` 恒 `receipt-changed`：既不可恢复，也不可清除。
     *
     * 语义与 `redactVoucher` 对齐：正文替换成同一个常量标记，记 `redacted: true`
     * 与清除时间；`recordIds` 保留（它是「这段回执属于哪些记录」的审计事实，
     * 不含正文）。**不可 undo**——正文已不在账本里，undo 只能给出谎言，所以
     * `restoreOrphan` 见到 `redacted` 一律失败关闭。
     *
     * @param {string[]} recordIds
     * @returns {Promise<{changed: number, ids: string[], failed: Array<{id: string, reason: string}>}>}
     */
    async redactOrphansFor(recordIds) {
      assertWritable()
      const wanted = new Set(Array.isArray(recordIds) ? recordIds : [])
      const result = { changed: 0, ids: [], failed: [] }
      if (wanted.size === 0) return result
      if (orphansParsed.damaged) {
        throw v3Error('ESTORE_DAMAGED', ORPHAN_LOG + ' 损坏（' + (orphansParsed.reason ?? '未给出原因') + '）：无法清除孤儿回执')
      }
      const lines = []
      let changed = 0
      for (const row of orphanRows) {
        if (row.redacted === true || !(Array.isArray(row.recordIds) ? row.recordIds : []).some((id) => wanted.has(id))) {
          lines.push(row)
          continue
        }
        // A-05：**整本重写**，不是追加一行标记。
        //
        // 这是本条缺陷的要害：orphan-receipts.jsonl 是明文账本，追加一条
        // `{redacted:true}` 只是让读面忽略旧行，**明文仍在磁盘上**——隐私承诺
        // （「正文已清除」）就成了假的。所以这里把命中行原地换成不含正文的审计行。
        // 代价是失去这一行的 append-only 属性；换算的是「已声明删除就必须真的删掉」，
        // 与 purge 删 records/ 同一口径。
        row.redacted = true
        row.redactedAt = new Date().toISOString()
        row.prevReceiptSeq = Number.isInteger(row.receiptSeq) ? row.receiptSeq : null
        row.chars = typeof row.receiptText === 'string' ? row.receiptText.length : 0
        row.receiptText = ''
        lines.push(row)
        result.changed += 1
        result.ids.push(row.id)
      }
      if (result.changed === 0) return result
      try {
        await writeFileAtomic(path.join(dir, ORPHAN_LOG), lines.map((line) => JSON.stringify(line)).join('\n') + '\n')
      } catch (error) {
        result.failed.push({ id: '*', reason: error?.code ?? error?.message ?? String(error) })
        // 写盘失败 → 内存视图不能停留在「已清除」的假象上。
        result.changed = 0
        result.ids = []
        throw error
      }
      return result
    },

    /**
     * 只读来源元数据（不返回 payload）：摄入断点反推用。
     * 刻意**不受遗忘隐藏**——遗忘是可见性，不是「从未摄入」；按可读集反推会让断点回退，
     * 重放时把已遗忘正文重新落成新记录（隐私回退）。损坏同样失败关闭。
     */
    async readProvenance(id) {
      // P2-02（AUD51-03-01 同族）：形状白名单必须与 readRecord 共用**同一处**判据。
      // 旧实现只查「非空字符串」就拼路径，`../../x` / `..\\x` / 绝对路径都能把
      // records/<id>.json 指到本会话目录里别的合法 JSON（读得到就认 = 读穿越）；
      // readRecord 早已拒绝，这条旁路把它绕过去了。
      if (!isRecordId(id)) {
        throw v3Error('EINVALID_ID', '记录 ID 非法：' + JSON.stringify(id) + '（必须形如 v3r-<16 位小写十六进制>）')
      }
      let text
      try {
        text = await readFile(path.join(dir, RECORDS_DIR, id + '.json'), 'utf8')
      } catch (error) {
        if (error?.code === 'ENOENT') throw v3Error('ESTORE_CORRUPT', '记录不存在：' + id)
        throw error
      }
      let record
      try {
        record = JSON.parse(text)
      } catch {
        throw v3Error('ESTORE_CORRUPT', '记录 ' + id + ' JSON 不可解析（损坏，失败关闭）')
      }
      const provenance = record?.provenance
      if (provenance === null || typeof provenance !== 'object' || Array.isArray(provenance)) {
        throw v3Error('ESTORE_CORRUPT', '记录 ' + id + ' 缺 provenance（结构非法，失败关闭）')
      }
      return {
        sourceEventId: typeof provenance.sourceEventId === 'string' ? provenance.sourceEventId : null,
        sourceForm: typeof provenance.sourceForm === 'string' ? provenance.sourceForm : null,
        transactionId: typeof provenance.transactionId === 'string' ? provenance.transactionId : null,
      }
    },

    /** 已提交记录 ID 清单（重建索引用；隔离区不算）。 */
    async listRecordIds() {
      return [...committedIds]
    },

    /**
     * 轻量基线（H-1，0.14.0-beta.48）：索引「锁外构建 + 锁内短写」用它判新鲜度。
     * 任一字段变化都说明构建窗口内有写者，结果不可直接落盘（退回锁内重建）。
     * 事务号从磁盘重读（另一进程提交后本句柄的 manifest 副本会过期）。
     */
    async freshness() {
      const manifestNow = await rereadManifestTxnNext()
      return {
        txnNext: manifestNow.txnNext,
        committed: committedIds.size,
        forgotten: forgotten.size,
        forgottenStamp,
      }
    },

    /** 主动遗忘：幂等（重复遗忘同一 ID 不报错不重复记账）；未提交过的 ID 拒绝。 */
    async forget(id) {
      assertWritable()
      // 同上：向已损坏的遗忘账本追加只会产生不可读行（遗忘不生效但看着像成功）
      if (forgottenDamaged) {
        throw v3Error('ESTORE_DAMAGED', 'forgotten.jsonl 损坏（' + (forgottenReason ?? '未给出原因') + '）：拒绝追加遗忘，修复后重开')
      }
      if (typeof id !== 'string' || id.length === 0) {
        throw new V3ContractViolation('v3 store: forget 的 id 必须是非空字符串')
      }
      if (!committedIds.has(id)) {
        throw v3Error('ESTORE_TXN_CONFLICT', 'forget 目标不存在或未提交：' + id)
      }
      if (!forgotten.has(id)) {
        await appendLine(forgottenPath, { action: 'forget', id, at: null }, { sync: true })
        forgotten.add(id)
      }
      return { forgottenCount: forgotten.size }
    },

    /**
     * 物理清除（H4）：删除冷库正文并记账。
     *
     * 与 `forget` 的分工（2026-11-04 审计后的显式语义）：
     * - `forget` = 逻辑遗忘：读面/检索面/回执/导出都看不到，**正文文件保留**以支持 undo；
     * - `purge` = 物理清除：正文文件删除、从已提交集移除，undo 永久不可用。
     * 删除前先写 forget 行（读面立即失败关闭），再写 purge 行（对账把缺失视为合法）。
     * 调用方必须已持跨进程写锁（端口负责）。
     */
    async purge(id) {
      assertWritable()
      if (forgottenDamaged) {
        throw v3Error('ESTORE_DAMAGED', 'forgotten.jsonl 损坏（' + (forgottenReason ?? '未给出原因') + '）：拒绝清除，修复后重开')
      }
      // R23（QC 复核）：清除账本损坏时**同样**拒绝 purge。理由与 forgotten 完全对称——
      // 追加一行到「读到一半就坏了」的账本后面，会让本次 purge 承诺的物理清除落成
      // 「payload 已删、账本行读不到」，下次打开即成账实不符（P1-03 的原始失败模式）。
      if (purgedDamaged) {
        throw v3Error('ESTORE_DAMAGED', PURGED_LOG + ' 损坏（' + (purgedReason ?? '未给出原因') + '）：拒绝清除，修复后重开')
      }
      if (typeof id !== 'string' || id.length === 0) {
        throw new V3ContractViolation('v3 store: purge 的 id 必须是非空字符串')
      }
      await refreshForgotten()
      if (purgedIds.has(id)) return { purged: true, alreadyPurged: true }
      if (!committedIds.has(id)) {
        throw v3Error('ESTORE_TXN_CONFLICT', 'purge 目标不存在或未提交：' + id)
      }
      if (!forgotten.has(id)) {
        await appendLine(forgottenPath, { action: 'forget', id, at: null }, { sync: true })
        forgotten.add(id)
      }
      // P1-03：**先落账本，再删正文**（两阶段）。旧实现反着来：rm 与 appendLine 之间崩溃
      // 会留下「commit 行在、payload 缺、没有 purge 行」——对账判 damaged，此后所有写入
      // ESTORE_DAMAGED，repair 也修不了（整库永久只能读）。落账先行后，最坏情况只是
      // 「账已清、文件还在」，打开期把删除补完（见 open 对账的 purged 收尾），永远可恢复。
      await appendLine(path.join(dir, PURGED_LOG), { action: 'purge', id, at: null }, { sync: true })
      // T-05（0.15.4）：`rm` 失败**不得**让 purge 看起来没发生。
      //
      // 缺陷：账本行已落、`purgedIds` 语义已生效（读面 EFORGOTTEN、undo 被拒），
      // 但旧实现让 `rm` 的异常直接抛出，调用方看到「报错」→ 以为没清成功 →
      // 重试（每次都同样失败）或改用 forget（此时已被拒）。用户对「到底删了没」无从得知。
      //
      // 现在：删除失败**不再抛出**，而是如实返回 `residue`，由命令面告诉用户
      // 「已承诺清除、逻辑上已不可读，但字节仍在盘上，重启打开时自动补删」。
      // 打开期补删（见 open 对账的 purged 收尾）保证它最终会被物理删掉。
      purgedIds.add(id)
      committedIds.delete(id)
      purgedStamp = await fileStampOf(path.join(dir, PURGED_LOG))
      let residue = null
      try {
        await rm(path.join(dir, RECORDS_DIR, id + '.json'), { force: true })
      } catch (error) {
        residue = {
          id,
          code: error?.code ?? 'rm-failed',
          note: '账本已清除、读面已不可读，但记录字节仍在盘上；下次打开会自动补删',
        }
      }
      return residue === null
        ? { purged: true, alreadyPurged: false }
        : { purged: true, alreadyPurged: false, residue }
    },

    /** 已物理清除的 ID（命令面判 undo 可用性、诊断面报数）。 */
    listPurged() {
      return [...purgedIds]
    },

    /**
     * 撤销遗忘（M3）：追加 `action:'revoke'` 行；幂等（未遗忘时无操作）。
     * 不物理删除记录；读路径按账本顺序让 revoke 覆盖 forget。
     */
    async revokeForget(id) {
      assertWritable()
      if (forgottenDamaged) {
        throw v3Error('ESTORE_DAMAGED', 'forgotten.jsonl 损坏（' + (forgottenReason ?? '未给出原因') + '）：拒绝撤销，修复后重开')
      }
      if (typeof id !== 'string' || id.length === 0) {
        throw new V3ContractViolation('v3 store: revokeForget 的 id 必须是非空字符串')
      }
      // H4：purge 是物理删除，undo 不成立——明确拒绝，而不是「找不到记录」。
      if (purgedIds.has(id)) {
        throw v3Error('ESTORE_TXN_CONFLICT', '记录 ' + id + ' 已被物理清除（forget purge），不可撤销')
      }
      if (!committedIds.has(id)) {
        throw v3Error('ESTORE_TXN_CONFLICT', '撤销遗忘目标不存在或未提交：' + id)
      }
      if (forgotten.has(id)) {
        await appendLine(forgottenPath, { action: 'revoke', id, at: null }, { sync: true })
        forgotten.delete(id)
      }
      return { forgottenCount: forgotten.size }
    },

    /** 隐私面已清除的回执 ID 集合（D-C，history 同步读取）。损坏 → 失败关闭。 */
    /**
     * T-03：**先按戳刷新、再读**的清除视图。
     *
     * 跨句柄语义要求调用前必须刷新；同步的 `redactedVoucherIds()` 无法 await，
     * 所以给读面提供这个异步出口，由端口层统一使用。
     */
    async redactedVoucherIdsFresh() {
      await refreshRedactions()
      return this.redactedVoucherIds()
    },

    redactedVoucherIds() {
      if (redactionsParsed.damaged) {
        throw v3Error('ESTORE_DAMAGED', 'redactions.jsonl 损坏（' + (redactionsParsed.reason ?? '未给出原因') + '）：无法判定哪些回执已清除')
      }
      return [...redactedVouchers]
    },

    /** 标记回执已清除/已还原（幂等；只追加，不物理删除）。 */
    async markVoucherRedacted(voucherId, redacted, { seq = null } = {}) {
      assertWritable()
      if (typeof voucherId !== 'string' || voucherId.length === 0) {
        throw new V3ContractViolation('v3 store: voucherId 必须是非空字符串')
      }
      const action = redacted === true ? 'redact' : 'unredact'
      const seqOk = action === 'redact' && Number.isInteger(seq) && seq > 0
      const alreadyRedacted = (action === 'redact') === redactedVouchers.has(voucherId)
      // 幂等但缺 seq（升级前记的）→ 补记一行，让 undo 能精确定位；其它幂等情况不改。
      const backfillSeq = alreadyRedacted && seqOk && redactedVoucherSeqs.get(voucherId) !== seq
      if (!alreadyRedacted || backfillSeq) {
        // 单提交点：两个分支共用这一处 appendLine（提交点计数守卫按行数校验）。
        await appendLine(redactionsPath, { action, voucherId, at: null, ...(seqOk ? { seq } : {}) }, { sync: true })
      } else {
        return { changed: false, redacted: action === 'redact' }
      }
      if (action === 'redact') {
        redactedVouchers.add(voucherId)
        if (seqOk) redactedVoucherSeqs.set(voucherId, seq)
      } else {
        redactedVouchers.delete(voucherId)
        redactedVoucherSeqs.delete(voucherId)
      }
      return { changed: true, redacted: action === 'redact', ...(seqOk ? { seq } : {}) }
    },

    /**
     * 已清除回执的**节点 seq**（P1-08）。老账本没有记录时返回 null——调用方必须失败关闭，
     * 不能退回正文扫描（所有清除回执正文相同，扫描必然张冠李戴）。
     */
    redactionSeqOf(voucherId) {
      if (redactionsParsed.damaged) {
        throw v3Error('ESTORE_DAMAGED', 'redactions.jsonl 损坏（' + (redactionsParsed.reason ?? '未给出原因') + '）：无法定位已清除回执的节点')
      }
      const seq = redactedVoucherSeqs.get(voucherId)
      return Number.isInteger(seq) && seq > 0 ? seq : null
    },

    /**
     * A-01（0.15.4）：记录「restore 落下的恢复节点当前在哪个 seq」。
     *
     * ## 为什么需要
     *
     * `restore` 把回执节点**原地替换**成原文，宿主会分配一个新 seq，旧 seq 作废。
     * 而 `redact`（清除回执正文）过去是**按正文逐字节定位**的——restore 之后面上
     * 已经没有那段回执正文了，于是 `firstEligibleSeq(receiptText)` 恒返回 null，
     * `redactVoucher` 永远拿到 `receipt-changed`。结果：**一旦 restore 过，
     * 那张凭证就再也 redact 不掉、purge 时也无法从面上清除**（P1 级隐私缺口）。
     *
     * 修法与 `redactions.jsonl` 的 `seq` 字段同源（同一先例）：把「凭证 → 当前节点 seq」
     * 这条**派生映射**持久化，定位改走它，正文比对只作二次复核。
     *
     * ## 语义边界
     *
     * - 这条映射是**派生物**，可被宿主压缩/改写作废；所以读回时仍要复核表面正文，
     *   不一致就失败关闭（宁可 redact 不成立，也不覆盖错节点）；
     * - `action:'unredact'` 时清空（回执正文已恢复，映射不再有意义）；
     * - 老账本没有这条记录 → 返回 null，调用方沿用既有的失败关闭路径，行为不变。
     */
    async markVoucherRestoredSeq(voucherId, seq, textHash = null) {
      assertWritable()
      if (typeof voucherId !== 'string' || voucherId.length === 0) {
        throw new V3ContractViolation('v3 store: voucherId 必须是非空字符串')
      }
      const seqOk = Number.isInteger(seq) && seq > 0
      if (!seqOk) return { changed: false }
      const hashOk = typeof textHash === 'string' && textHash.length > 0
      if (restoredVoucherSeqs.get(voucherId) === seq && restoredVoucherHashes.get(voucherId) === (hashOk ? textHash : null)) {
        return { changed: false }
      }
      // restoredSeq 与 action 分开记：这一行不改变「是否已清除」的状态，
      // 只补一条定位辅助信息（所以用独立 action，不污染 redactedVouchers 的判定）。
      // textHash 是**恢复正文的指纹**——A-01 的失败关闭判据（正文被宿主改写就不许覆盖）。
      await appendLine(redactionsPath, { action: 'restored', voucherId, at: null, seq, ...(hashOk ? { textHash } : {}) }, { sync: true })
      restoredVoucherSeqs.set(voucherId, seq)
      if (hashOk) restoredVoucherHashes.set(voucherId, textHash)
      else restoredVoucherHashes.delete(voucherId)
      return { changed: true, seq }
    },

    /**
     * 读回 restore 落下的节点 seq（A-01）。没有记录 → null（行为与 0.15.3 一致）。
     * 账本损坏 → ESTORE_DAMAGED（与 `redactionSeqOf` 同口径，不静默当「没有」）。
     */
    restoredSeqOf(voucherId) {
      if (redactionsParsed.damaged) {
        throw v3Error('ESTORE_DAMAGED', 'redactions.jsonl 损坏（' + (redactionsParsed.reason ?? '未给出原因') + '）：无法定位已恢复的节点')
      }
      const seq = restoredVoucherSeqs.get(voucherId)
      return Number.isInteger(seq) && seq > 0 ? seq : null
    },

    /** 读回 restore 落下的**恢复正文指纹**（A-01 失败关闭判据）；没有 → null。 */
    restoredTextHashOf(voucherId) {
      if (redactionsParsed.damaged) {
        throw v3Error('ESTORE_DAMAGED', 'redactions.jsonl 损坏（' + (redactionsParsed.reason ?? '未给出原因') + '）：无法复核已恢复的节点')
      }
      const hash = restoredVoucherHashes.get(voucherId)
      return typeof hash === 'string' && hash.length > 0 ? hash : null
    },

    /** 列已遗忘 ID；账本损坏 → ESTORE_DAMAGED（与 listVouchers 同口径，不静默当空）。 */
    listForgotten() {
      assertForgottenReadable()
      return [...forgotten]
    },

    /**
     * 读前刷新遗忘集合（跨句柄一致性）。索引重建必须调用它：
     * 否则另一个句柄刚 forget 的记录会被重新写进索引，检索面重新可见。
     */
    refreshForgotten,

    // H-10-b：跨进程锁内的增量视图同步——重读事务日志，把其他句柄/进程
    // 提交的新 commit 行并入本句柄内存视图（committedIds/maxTxn 纯增量，不清不改）。
    // 没有它，第二个句柄的 rebuildIndex 会漏掉第一个句柄的新提交记录。
    async syncFromLog() {
      assertWritable()
      const parsed = await parseTxnLog(path.join(dir, TXN_LOG), TXN_LOG)
      let merged = 0
      for (const line of parsed.lines) {
        if (line.action === 'commit' && Number.isInteger(line.txn)) {
          if (line.txn > maxTxn) maxTxn = line.txn
          for (const id of line.recordIds ?? []) {
            // H4：已物理清除的 ID 仍留 commit 行（审计事实），但不得被重新并入已提交集。
            if (!committedIds.has(id) && !purgedIds.has(id)) { committedIds.add(id); merged += 1 }
          }
        }
      }
      return { mergedRecords: merged, maxTxn }
    },

    /**
     * AUD50-04-02（B2-8）：读打开期检查点。可用判据 = 行内最大 txn === 事务日志
     * 现读的 maxTxn；落后/缺失/损坏一律 { usable:false }——不用旧检查点掩盖新记录。
     */
    async readCheckpoint() {
      const parsed = await parseTxnLog(path.join(dir, CHECKPOINT_LOG), CHECKPOINT_LOG)
      if (!parsed.exists) return { usable: false, reason: 'absent', txn: 0, pairs: [] }
      if (parsed.damaged) return { usable: false, reason: parsed.reason, txn: 0, pairs: [] }
      let acc = new Map()
      let maxCheckpointTxn = 0
      for (const line of parsed.lines) {
        if (!Number.isInteger(line?.txn) || line.txn < 1 || !Array.isArray(line.pairs)) continue
        const valid = []
        for (const pair of line.pairs) {
          if (!Array.isArray(pair) || typeof pair[0] !== 'string' || typeof pair[1] !== 'string') continue
          valid.push([pair[0], pair[1]])
        }
        if (line.action === 'baseline') {
          // baseline 行必须至少带回一条有效映射：全非法的基线 = 写坏了的缓存。
          // 信任它会把「空映射」当最新检查点（实测：entry 断点回 -1 → 全量重摄、记录翻倍）。
          if (valid.length === 0) return { usable: false, reason: 'baseline 行无有效映射', txn: 0, pairs: [] }
          acc = new Map(valid)
        } else if (line.action === 'checkpoint') {
          for (const pair of valid) acc.set(pair[0], pair[1])
        } else continue
        maxCheckpointTxn = Math.max(maxCheckpointTxn, line.txn)
      }
      const logParsed = await parseTxnLog(logPath, TXN_LOG)
      if (logParsed.damaged) return { usable: false, reason: logParsed.reason, txn: 0, pairs: [] }
      let logMaxTxn = 0
      for (const line of logParsed.lines) {
        if (line.action === 'commit' && Number.isInteger(line.txn)) logMaxTxn = Math.max(logMaxTxn, line.txn)
      }
      return {
        usable: maxCheckpointTxn === logMaxTxn && maxCheckpointTxn >= 1,
        reason: maxCheckpointTxn === logMaxTxn ? null : '检查点落后于事务日志（' + maxCheckpointTxn + ' < ' + logMaxTxn + '）',
        txn: maxCheckpointTxn,
        pairs: [...acc],
      }
    },

    /**
     * 追加增量检查点行（调用方必须在写锁内、紧跟提交之后调用；失败只损失缓存速度）。
     *
     * P3-07：追加门只判**尾部**（`inspectAppendTail`），不再整本解析账本。
     * 旧实现在这里 `parseTxnLog` 整本：2 万行账本每次提交多付 12 ms 线性成本，
     * 而追加只接触文件末尾。读面（`readCheckpoint`）仍整本解析且首个坏行即
     * `usable:false`——**判据没有放宽，只是不再让追加为读面的判据付钱**。
     * 尾部半行是唯一会让「新行粘在坏行后面、两行一起不可解析」的形态，仍然硬拒绝。
     */
    async appendCheckpoint(txn, pairs) {
      if (!Number.isInteger(txn) || txn < 1) {
        throw new V3ContractViolation('v3 store: appendCheckpoint 的 txn 必须是 ≥1 整数')
      }
      if (!Array.isArray(pairs)) throw new V3ContractViolation('v3 store: appendCheckpoint 的 pairs 必须是数组')
      const tail = await inspectAppendTail(path.join(dir, CHECKPOINT_LOG), CHECKPOINT_LOG)
      if (!tail.appendable) return { appended: false, reason: tail.reason }
      // R23（QC 复核实害）：末行是**合法完整 JSON 但缺收尾换行**时，追加门放行是对的
      // （那一行本身没坏），但**必须先把换行补上再写新行**——否则两行粘成一行，
      // 读面立刻多出「第 N 行不可解析」，usable:false（已实测复现）。口径与
      // usage-log.mjs 的 appendUsageLine 一致（那里早就补 '\n'，两处不得再分叉）。
      const prefix = tail.endsWithNewline === false ? '\n' : ''
      await appendLine(path.join(dir, CHECKPOINT_LOG), { action: 'checkpoint', txn, pairs }, { prefix })
      return { appended: true, newlineRepaired: prefix.length > 0 }
    },

    /** 追加全量基线行（迁移/回退路径用；重置累积映射）。判据与 appendCheckpoint 同源。 */
    async appendCheckpointBaseline(txn, pairs) {
      if (!Number.isInteger(txn) || txn < 1) {
        throw new V3ContractViolation('v3 store: appendCheckpointBaseline 的 txn 必须是 ≥1 整数')
      }
      if (!Array.isArray(pairs)) throw new V3ContractViolation('v3 store: appendCheckpointBaseline 的 pairs 必须是数组')
      const tail = await inspectAppendTail(path.join(dir, CHECKPOINT_LOG), CHECKPOINT_LOG)
      if (!tail.appendable) return { appended: false, reason: tail.reason }
      const prefix = tail.endsWithNewline === false ? '\n' : ''
      await appendLine(path.join(dir, CHECKPOINT_LOG), { action: 'baseline', txn, pairs }, { prefix })
      return { appended: true, newlineRepaired: prefix.length > 0 }
    },

    close() {
      closed = true
      writable = false
    },
  }
}

async function appendLine(filePath, value, { sync = false, prefix = '' } = {}) {
  const data = prefix + JSON.stringify(value) + '\n'
  if (!sync) {
    const { appendFile } = await import('node:fs/promises')
    await appendFile(filePath, data, 'utf8')
    return
  }
  // B3-5（AUD50-03-04）：提交点必须落盘——appendFile 只把数据送进页缓存，掉电后
  // 整行可丢（commit 行丢失 = 已成功提交被静默变成「从未发生」）。打开期把
  // 「manifest 已推进但日志无 commit」报告为 commit-lost（health.commitLostAtOpen）。
  const { open } = await import('node:fs/promises')
  const handle = await open(filePath, 'a')
  try {
    await handle.writeFile(data, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/**
 * G-B：只把 ENOENT 当「没有」；EACCES/EMFILE/ELOOP 等一律向上抛（失败关闭）。
 * 旧实现吞掉所有 stat 错误并返回 false：manifest 瞬时读不到 → 以 txnNext=1 重建
 * （事务号复用）；记录冲突检查读不到 → 覆盖同 ID 记录。v2 的 isAbsent 纪律在 v3 落地。
 */
async function fileExists(filePath, statOf = stat) {
  try {
    await statOf(filePath)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

