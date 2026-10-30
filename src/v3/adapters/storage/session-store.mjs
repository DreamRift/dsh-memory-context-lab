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
import { mkdir, open, readdir, readFile, rename, rm, stat, truncate, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

import { v3Error, V3ContractViolation } from '../../contracts/errors.mjs'
import { RECORD_KINDS, assertValidRecord, validateRecord } from '../../contracts/records.mjs'
import { withCrossProcessWriteLock } from './write-lock.mjs'

const SCHEMA_VERSION = 1
const MANIFEST = 'manifest.json'
const TXN_LOG = 'transactions.jsonl'
const VOUCHERS_LOG = 'vouchers.jsonl'
const FORGOTTEN_LOG = 'forgotten.jsonl'
// D-C：隐私面清除/还原的持久标记（history 同步读取，不能现场读宿主活动面）
const REDACTIONS_LOG = 'redactions.jsonl'
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
      tailPreview: tail.slice(0, 120),
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
  if (dryRun) {
    return { dryRun: true, files: before, repaired: [], changed: false }
  }
  if (tails.length === 0) {
    return { dryRun: false, files: before, repaired: [], changed: false }
  }
  // 跨进程锁内重读后再截断：别的进程可能刚补完那条 append。
  return withCrossProcessWriteLock(dir, async () => {
    const inside = await inspectAll()
    const repaired = []
    for (const row of inside) {
      if (row.state !== 'tail-half-line') continue
      const audit = {
        schemaVersion: 1,
        at: now(),
        file: row.file,
        keptBytes: row.keptBytes,
        removedBytes: row.removedBytes,
        removedPreview: row.tailPreview,
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
    const missingPayload = [...committedIds].filter((id) => !idsOnDisk.has(id))
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
    const orphaned = []
    if (!damaged && !ledgerMismatch) {
      for (const name of recordsOnDisk) {
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
    return { manifest, parsedTxn, leftoverFiles, orphaned, damaged, reason, committedIds, maxTxn, forgotten, redactedVouchers, vouchersParsed, forgottenParsed, redactionsParsed, commitLost }
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
  const commitLost = opened.commitLost

  let closed = false
  let writable = !damaged
  const vouchersDamaged = vouchersParsed.damaged
  const voucherLines = vouchersParsed.lines
  // 遗忘账本损坏（H-09）：前缀之外可能有 forget 行读不到，「哪些被遗忘」不可判定。
  // 此时读路径必须失败关闭——否则已遗忘正文重新可读（隐私面 fail-open）。
  let forgottenDamaged = forgottenParsed.damaged
  let forgottenReason = forgottenParsed.reason ?? null
  // 文件戳：别的句柄/进程追加 forget 行后，本句柄必须能察觉（见 refreshForgotten）。
  let forgottenStamp = await fileStampOf(forgottenPath)
  const health = () => ({
    healthy: !damaged && !vouchersDamaged && !forgottenDamaged,
    damagedReason: damaged
      ? reason
      : (vouchersDamaged ? vouchersParsed.reason : (forgottenDamaged ? forgottenReason : null)),
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
      const commitLine = { action: 'commit', txn, recordIds: ids }
      if (commitAt !== null) commitLine.at = commitAt
      await appendLine(logPath, commitLine, { sync: true })
      for (const id of ids) committedIds.add(id)
      // 步骤 4：推进事务号
      manifest = { ...manifest, txnNext: txn + 1 }
      await writeFileAtomic(manifestPath, JSON.stringify(manifest) + '\n')
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
      if (typeof id !== 'string' || id.length === 0) {
        throw new V3ContractViolation('v3 store: id 必须是非空字符串')
      }
      // 遗忘集合必须**读前刷新**：另一个句柄/进程刚 forget 过的记录，本句柄若只用手里的
      // 旧集合判定，就会把已遗忘的正文照常返回——这是「已忘内容重新可见」的隐私回退。
      // 判据用文件戳（mtime+size），没变化时只多一次 stat。
      await refreshForgotten()
      assertForgottenReadable()
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
      await appendLine(vouchersPath, voucher, { sync: true })
      voucherLines.push(voucher)
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
     * 只读来源元数据（不返回 payload）：摄入断点反推用。
     * 刻意**不受遗忘隐藏**——遗忘是可见性，不是「从未摄入」；按可读集反推会让断点回退，
     * 重放时把已遗忘正文重新落成新记录（隐私回退）。损坏同样失败关闭。
     */
    async readProvenance(id) {
      if (typeof id !== 'string' || id.length === 0) {
        throw new V3ContractViolation('v3 store: id 必须是非空字符串')
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
    redactedVoucherIds() {
      if (redactionsParsed.damaged) {
        throw v3Error('ESTORE_DAMAGED', 'redactions.jsonl 损坏（' + (redactionsParsed.reason ?? '未给出原因') + '）：无法判定哪些回执已清除')
      }
      return [...redactedVouchers]
    },

    /** 标记回执已清除/已还原（幂等；只追加，不物理删除）。 */
    async markVoucherRedacted(voucherId, redacted) {
      assertWritable()
      if (typeof voucherId !== 'string' || voucherId.length === 0) {
        throw new V3ContractViolation('v3 store: voucherId 必须是非空字符串')
      }
      const action = redacted === true ? 'redact' : 'unredact'
      if ((action === 'redact') === redactedVouchers.has(voucherId)) return { changed: false, redacted: action === 'redact' }
      await appendLine(redactionsPath, { action, voucherId, at: null }, { sync: true })
      if (action === 'redact') redactedVouchers.add(voucherId)
      else redactedVouchers.delete(voucherId)
      return { changed: true, redacted: action === 'redact' }
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
            if (!committedIds.has(id)) { committedIds.add(id); merged += 1 }
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

    /** 追加增量检查点行（调用方必须在写锁内、紧跟提交之后调用；失败只损失缓存速度）。 */
    async appendCheckpoint(txn, pairs) {
      if (!Number.isInteger(txn) || txn < 1) {
        throw new V3ContractViolation('v3 store: appendCheckpoint 的 txn 必须是 ≥1 整数')
      }
      if (!Array.isArray(pairs)) throw new V3ContractViolation('v3 store: appendCheckpoint 的 pairs 必须是数组')
      // 账本自己损坏时拒绝追加：好行写在坏行后面永远不可读（与 appendVoucher 同口径）。
      const existing = await parseTxnLog(path.join(dir, CHECKPOINT_LOG), CHECKPOINT_LOG)
      if (existing.damaged) return { appended: false, reason: existing.reason }
      await appendLine(path.join(dir, CHECKPOINT_LOG), { action: 'checkpoint', txn, pairs })
      return { appended: true }
    },

    /** 追加全量基线行（迁移/回退路径用；重置累积映射）。 */
    async appendCheckpointBaseline(txn, pairs) {
      if (!Number.isInteger(txn) || txn < 1) {
        throw new V3ContractViolation('v3 store: appendCheckpointBaseline 的 txn 必须是 ≥1 整数')
      }
      if (!Array.isArray(pairs)) throw new V3ContractViolation('v3 store: appendCheckpointBaseline 的 pairs 必须是数组')
      const existing = await parseTxnLog(path.join(dir, CHECKPOINT_LOG), CHECKPOINT_LOG)
      if (existing.damaged) return { appended: false, reason: existing.reason }
      await appendLine(path.join(dir, CHECKPOINT_LOG), { action: 'baseline', txn, pairs })
      return { appended: true }
    },

    close() {
      closed = true
      writable = false
    },
  }
}

async function appendLine(filePath, value, { sync = false } = {}) {
  const data = JSON.stringify(value) + '\n'
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

/**
 * 文件戳（mtimeMs + size）：用来判「别的句柄有没有改过这本账」。
 * 文件不存在也是一种稳定状态（'absent'），不能返回 null 让调用方无法区分。
 */
async function fileStampOf(filePath) {
  const { stat } = await import('node:fs/promises')
  try {
    const info = await stat(filePath)
    return info.mtimeMs + ':' + info.size
  } catch (error) {
    if (error?.code === 'ENOENT') return 'absent'
    throw error
  }
}
