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
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

import { v3Error, V3ContractViolation } from '../../contracts/errors.mjs'
import { assertValidRecord, validateRecord } from '../../contracts/records.mjs'

const SCHEMA_VERSION = 1
const MANIFEST = 'manifest.json'
const TXN_LOG = 'transactions.jsonl'
const VOUCHERS_LOG = 'vouchers.jsonl'
const FORGOTTEN_LOG = 'forgotten.jsonl'
const RECORDS_DIR = 'records'
const QUARANTINE_DIR = 'quarantine'

/** 原子写：同目录 randomUUID 临时名 + rename（G8：禁止 tmp-<pid>-<Date.now()>）。 */
export async function writeFileAtomic(filePath, data) {
  const tmp = path.join(path.dirname(filePath), '.' + path.basename(filePath) + '.' + randomUUID() + '.tmp')
  await writeFile(tmp, data, 'utf8')
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
 * 打开（或创建）会话存储，并执行崩溃对账。
 * @returns {object} store：submitTransaction / readRecord / health / close
 */
export async function openV3SessionStore(root, sessionKey) {
  if (typeof root !== 'string' || root.length === 0) {
    throw new V3ContractViolation('v3 store: root 必须是非空字符串')
  }
  if (typeof sessionKey !== 'string' || sessionKey.trim().length === 0) {
    throw new V3ContractViolation('v3 store: sessionKey 必须是非空白字符串')
  }
  const dir = sessionDirOf(root, sessionKey)
  await mkdir(path.join(dir, RECORDS_DIR), { recursive: true })
  await mkdir(path.join(dir, QUARANTINE_DIR), { recursive: true })

  const manifestPath = path.join(dir, MANIFEST)
  let manifest
  if (await fileExists(manifestPath)) {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    if (manifest.sessionKey !== sessionKey || manifest.schemaVersion !== SCHEMA_VERSION) {
      throw v3Error('ESTORE_SESSION_MISMATCH', 'manifest 与请求会话不符（跨会话不串数据的第一道闸）')
    }
  } else {
    manifest = { schemaVersion: SCHEMA_VERSION, sessionKey, txnNext: 1 }
    await writeFileAtomic(manifestPath, JSON.stringify(manifest) + '\n')
  }

  const logPath = path.join(dir, TXN_LOG)
  const parsedTxn = await parseTxnLog(logPath, TXN_LOG)
  const lines = parsedTxn.lines
  // 事务日志**缺失**但记录还在（H-21）：对账依据本身丢了，不能把「无法证明已提交」
  // 当成「崩溃残留」——旧实现会把全部记录移进 quarantine，而 health 仍报 healthy，
  // 等于静默全丢（实测 5 条记录 → records/ 清空、quarantine/ 5 条、healthy=true）。
  // 这里判 damaged：读允许（记录字节完好）、写拒绝，交人工裁决；不销毁任何字节。
  const recordsOnDisk = await readdir(path.join(dir, RECORDS_DIR))
  // 同一根因的另一个分支：日志文件在、但内容被清空（0 字节 / 只剩空行），而记录与
  // manifest.txnNext（>1，说明历史上确实提交过）都还在——这同样不是「崩溃残留」，
  // 而是对账依据丢失。两种形态一起判 damaged，绝不销毁记录字节。
  const commitLines = lines.filter((line) => line.action === 'commit').length
  const logLostWithRecords = recordsOnDisk.length > 0
    && commitLines === 0
    && Number.isInteger(manifest.txnNext) && manifest.txnNext > 1
  const reconciliationLost = (!parsedTxn.exists || logLostWithRecords) && recordsOnDisk.length > 0
  const vouchersPath = path.join(dir, VOUCHERS_LOG)
  const vouchersParsed = await parseTxnLog(vouchersPath, VOUCHERS_LOG)
  const forgottenPath = path.join(dir, FORGOTTEN_LOG)
  const forgottenParsed = await parseTxnLog(forgottenPath, FORGOTTEN_LOG)
  const forgotten = new Set(
    forgottenParsed.lines
      .filter((line) => line.action === 'forget' && typeof line.id === 'string')
      .map((line) => line.id),
  )

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
  const idsOnDisk = new Set()
  for (const name of recordsOnDisk) {
    if (name.endsWith('.json')) idsOnDisk.add(name.slice(0, -5))
  }
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
      const id = name.endsWith('.json') ? name.slice(0, -5) : null
      if (id !== null && !committedIds.has(id)) {
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

  let closed = false
  let writable = !damaged
  const vouchersDamaged = vouchersParsed.damaged
  const voucherLines = vouchersParsed.lines
  // 遗忘账本损坏（H-09）：前缀之外可能有 forget 行读不到，「哪些被遗忘」不可判定。
  // 此时读路径必须失败关闭——否则已遗忘正文重新可读（隐私面 fail-open）。
  const forgottenDamaged = forgottenParsed.damaged
  const health = () => ({
    healthy: !damaged && !vouchersDamaged && !forgottenDamaged,
    damagedReason: damaged
      ? reason
      : (vouchersDamaged ? vouchersParsed.reason : (forgottenDamaged ? forgottenParsed.reason : null)),
    txnNext: manifest.txnNext,
    recordCount: committedIds.size,
    orphanedAtOpen: orphaned,
    voucherCount: voucherLines.length,
    vouchersDamaged,
    forgottenCount: forgotten.size,
    forgottenDamaged,
  })

  /** 遗忘账本损坏时的读闸：读不到 ≠ 没遗忘（隐私面失败关闭）。 */
  function assertForgottenReadable() {
    if (forgottenDamaged) {
      throw v3Error('ESTORE_DAMAGED', 'forgotten.jsonl 损坏：' + forgottenParsed.reason + '（无法判定哪些记录已被遗忘，读路径失败关闭；修复后重开）')
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
      for (const record of records) assertValidRecord(record)
      const ids = records.map((r) => r.id)
      // 已存在（已提交）的 ID → 冲突拒绝（重试须用新事务，不得覆盖）
      for (const id of ids) {
        if (committedIds.has(id) || (await fileExists(path.join(dir, RECORDS_DIR, id + '.json')))) {
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
      await appendLine(logPath, commitLine)
      for (const id of ids) committedIds.add(id)
      // 步骤 4：推进事务号
      manifest = { ...manifest, txnNext: txn + 1 }
      await writeFileAtomic(manifestPath, JSON.stringify(manifest) + '\n')
      return { txn, recordIds: [...ids] }
    },

    /** 精确回读：JSON 解析失败或结构非法 → ESTORE_CORRUPT（失败关闭，不静默当空）。 */
    async readRecord(id) {
      if (typeof id !== 'string' || id.length === 0) {
        throw new V3ContractViolation('v3 store: id 必须是非空字符串')
      }
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
          if (await fileExists(path.join(dir, QUARANTINE_DIR, id + '.json'))) {
            throw v3Error('ESTORE_CORRUPT', '记录 ' + id + ' 是崩溃残留（已隔离），未提交，不可读')
          }
          throw v3Error('ESTORE_CORRUPT', '记录不存在：' + id)
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
      return record
    },

    directory: dir,

    /** 追加恢复凭证：归档裁决的 durable 映射（recordIds ↔ targetEventId ↔ 回执正文）。 */
    async appendVoucher(voucher) {
      assertWritable()
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
      if (typeof voucher.targetEventId !== 'string' || voucher.targetEventId.length === 0) {
        throw new V3ContractViolation('v3 store: voucher.targetEventId 必须是非空字符串')
      }
      if (typeof voucher.receiptText !== 'string' || voucher.receiptText.length === 0) {
        throw new V3ContractViolation('v3 store: voucher.receiptText 必须是非空字符串')
      }
      if (!Number.isInteger(voucher.txn) || voucher.txn < 1) {
        throw new V3ContractViolation('v3 store: voucher.txn 必须是 ≥1 整数')
      }
      await appendLine(vouchersPath, voucher)
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

    /** 主动遗忘：幂等（重复遗忘同一 ID 不报错不重复记账）；未提交过的 ID 拒绝。 */
    async forget(id) {
      assertWritable()
      if (typeof id !== 'string' || id.length === 0) {
        throw new V3ContractViolation('v3 store: forget 的 id 必须是非空字符串')
      }
      if (!committedIds.has(id)) {
        throw v3Error('ESTORE_TXN_CONFLICT', 'forget 目标不存在或未提交：' + id)
      }
      if (!forgotten.has(id)) {
        await appendLine(forgottenPath, { action: 'forget', id, at: null })
        forgotten.add(id)
      }
      return { forgottenCount: forgotten.size }
    },

    /** 列已遗忘 ID；账本损坏 → ESTORE_DAMAGED（与 listVouchers 同口径，不静默当空）。 */
    listForgotten() {
      assertForgottenReadable()
      return [...forgotten]
    },

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

    close() {
      closed = true
      writable = false
    },
  }
}

async function appendLine(filePath, value) {
  const { appendFile } = await import('node:fs/promises')
  await appendFile(filePath, JSON.stringify(value) + '\n', 'utf8')
}

async function fileExists(filePath) {
  const { stat } = await import('node:fs/promises')
  try {
    await stat(filePath)
    return true
  } catch {
    return false
  }
}

