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

/** 解析事务日志；返回 { lines, damaged, reason }。damaged 时 lines 为已解析前缀。 */
async function parseTxnLog(filePath) {
  let text
  try {
    text = await readFile(filePath, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return { lines: [], damaged: false, reason: null }
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
      return { lines, damaged: true, reason: 'transactions.jsonl 第 ' + (i + 1) + ' 行不可解析' }
    }
  }
  return { lines, damaged: false, reason: null }
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
  const { lines, damaged, reason } = await parseTxnLog(logPath)
  const vouchersPath = path.join(dir, VOUCHERS_LOG)
  const vouchersParsed = await parseTxnLog(vouchersPath)
  const forgottenPath = path.join(dir, FORGOTTEN_LOG)
  const forgottenParsed = await parseTxnLog(forgottenPath)
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
  // 有 payload 无 commit 行 → 崩溃残留，移入 quarantine（对账即隔离，不静默复用）
  const orphaned = []
  if (!damaged) {
    for (const name of await readdir(path.join(dir, RECORDS_DIR))) {
      const id = name.endsWith('.json') ? name.slice(0, -5) : null
      if (id !== null && !committedIds.has(id)) {
        await rename(path.join(dir, RECORDS_DIR, name), path.join(dir, QUARANTINE_DIR, name))
        orphaned.push(id)
      }
    }
  }
  if (manifest.txnNext <= maxTxn) {
    manifest = { ...manifest, txnNext: maxTxn + 1 }
    await writeFileAtomic(manifestPath, JSON.stringify(manifest) + '\n')
  }

  let closed = false
  let writable = !damaged
  const vouchersDamaged = vouchersParsed.damaged
  const voucherLines = vouchersParsed.lines
  const health = () => ({
    healthy: !damaged && !vouchersDamaged,
    damagedReason: damaged ? reason : (vouchersDamaged ? vouchersParsed.reason : null),
    txnNext: manifest.txnNext,
    recordCount: committedIds.size,
    orphanedAtOpen: orphaned,
    voucherCount: voucherLines.length,
    vouchersDamaged,
    forgottenCount: forgotten.size,
  })

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
      if (!Array.isArray(voucher.recordIds) || voucher.recordIds.some((id) => typeof id !== 'string')) {
        throw new V3ContractViolation('v3 store: voucher.recordIds 必须是字符串数组')
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
      return [...voucherLines]
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

    listForgotten() {
      return [...forgotten]
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

