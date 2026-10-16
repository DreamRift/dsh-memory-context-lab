/**
 * v2 存储层：全历史按需记忆化的持久会话库。
 *
 * 目录布局（与 v1 的 sessions/<key> 完全分离）：
 *   <labRoot>/v2/sessions/<key>/
 *     engine.json            引擎声明（身份 + 停用状态）
 *     manifest.json          检查点：committedThrough（已提交推进到的位置）
 *     transactions/txn-XXXXXXXX.json   事务 WAL：先写意图，提交时落 committedAt
 *     payloads/<xx>/<hash>   内容寻址不可变载荷（字节级原文）
 *     catalog.json           派生目录缓存（可随时重建）
 *     quarantine/            崩溃/损坏事务的隔离区（保留取证，不参与目录）
 *
 * 事务顺序（崩溃安全）：
 *   1. open：分配事务号并写入无 committedAt 的事务文件（WAL 意图）；
 *   2. stage：每条记录先落载荷（tmp+rename，内容寻址不可变），再把记录
 *      追加进事务文件（整文件原子重写）；
 *   3. commit：原子重写事务文件落 committedAt，然后推进 manifest.committedThrough。
 *
 * 重启对账以磁盘为准：
 *   - 无 committedAt 的事务（含空意图、半程写入）→ 移入 quarantine/，不进目录；
 *   - 提交文件领先于 manifest → 采纳（manifest 回补推进）；
 *   - manifest 领先于磁盘 → 回退并记录 warning；
 *   - 不可解析/不符合 schema 的事务 → 隔离，其余历史照常可达。
 */

import { createHash } from 'node:crypto'
import { access, mkdir, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

import {
  ensureLabRoot,
  sessionKeyFor,
} from '../storage.mjs'
import {
  RECORDS_SCHEMA_VERSION,
  RECORD_KINDS,
  compareRecordIds,
  parseRecordId,
  recordId,
  validateRecord,
} from './records.mjs'

export const ENGINE_V2_NAME = 'full-history-v2'
export const ENGINE_FILE = 'engine.json'
export const MANIFEST_FILE = 'manifest.json'
export const CATALOG_FILE = 'catalog.json'
export const TRANSACTIONS_DIRECTORY = 'transactions'
export const QUARANTINE_DIRECTORY = 'quarantine'
export const PAYLOADS_DIRECTORY = 'payloads'

const ENGINE_KIND = 'dsh-memory-context-lab/v2/engine'
const MANIFEST_KIND = 'dsh-memory-context-lab/v2/manifest'
const CATALOG_KIND = 'dsh-memory-context-lab/v2/catalog'
const TRANSACTION_KIND = 'dsh-memory-context-lab/v2/transaction'

import { EngineV2Error } from './errors.mjs'

export { EngineV2Error } from './errors.mjs'

export function v2SessionsRootFor(labRoot) {
  return path.join(path.resolve(labRoot), 'v2', 'sessions')
}

export function v2SessionDirectoryFor(labRoot, sessionId) {
  return path.join(v2SessionsRootFor(labRoot), sessionKeyFor(sessionId))
}

function isEngineFile(value) {
  return !!value
    && value.kind === ENGINE_KIND
    && value.schemaVersion === RECORDS_SCHEMA_VERSION
    && value.engine === ENGINE_V2_NAME
    && typeof value.sessionId === 'string'
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    return undefined // present but unreadable
  }
}

/** 区分「不存在」（null）与「存在但损坏」（抛 EDAMAGED）。 */
async function readJsonStrict(file, { label }) {
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw new EngineV2Error(`${label}不可读：${error.message}`, { code: 'EDAMAGED', details: { file } })
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new EngineV2Error(`${label}不是有效的 JSON：${error.message}`, { code: 'EDAMAGED', details: { file } })
  }
}

async function writeFileAtomic(file, data) {
  const parent = path.dirname(file)
  await mkdir(parent, { recursive: true })
  const temp = path.join(parent, `.${path.basename(file)}.${randomUUID()}.tmp`)
  try {
    await writeFile(temp, data)
    await rename(temp, file)
  } finally {
    await rm(temp, { force: true }).catch(() => {})
  }
}

// 导出给 verification.mjs 复用同一套「temp + rename + 兜底删除」原子写纪律（V2CHANGE-05）。
export async function writeJsonFileAtomic(file, value) {
  await writeFileAtomic(file, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8'))
}

/**
 * 只读文件前 `maxBytes` 字节（有界读取，不把整篇载入内存）。
 *
 * 句柄一定关闭：读取失败时如果只抛错不关闭，一次坏载荷就能耗尽进程句柄。
 */
async function readPrefix(file, maxBytes) {
  return readRange(file, 0, maxBytes)
}

/**
 * P1-7 分块索引：从 `offsetBytes` 起读一段有界区间（同 readPrefix 的句柄纪律）。
 */
async function readRange(file, offsetBytes, maxBytes) {
  const handle = await open(file, 'r')
  try {
    const buffer = Buffer.allocUnsafe(maxBytes)
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, offsetBytes)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close().catch(() => {})
  }
}

/** 事务号上界：与 records.mjs 的 `recordId` 定宽 8 位一致（超出则 ID 形状失效）。 */
export const MAX_TRANSACTION_NUMBER = 99_999_999

function transactionFileName(txn) {
  return `txn-${String(txn).padStart(8, '0')}.json`
}

/**
 * 解析事务文件名。
 *
 * 只认 `txn-<数字>.json`，且数字必须落在 `recordId` 支持的定宽范围内：
 * 定宽前缀一旦溢出（>8 位），`transactionFileName` 会产出与解析正则不匹配的名字，
 * 重启后该事务既不在目录里、也不推进 `#nextTxn`，事务号会被**复用**——而
 * 「事务号不复用」是崩溃对账能成立的前提。所以这里宁可把越界文件当未知文件
 * 报告，也不静默接受一个会让号复用的形状。
 */
function parseTransactionFileName(name) {
  const match = /^txn-(\d+)\.json$/.exec(name)
  if (!match) return null
  const txn = Number(match[1])
  if (!Number.isSafeInteger(txn) || txn < 1 || txn > MAX_TRANSACTION_NUMBER) return null
  return txn
}

/**
 * 从隔离文件名还原原事务文件名。
 *
 * 隔离命名是 `<原文件名>.<原因>.<时间戳>.json`，所以「第一个 `.json` 结尾处」
 * 就是原文件名。还原它是为了拿到事务号——隔离号必须继续占用，不能被复用。
 */
function originalTransactionNameOf(name) {
  const index = name.indexOf('.json')
  return index >= 0 ? name.slice(0, index + '.json'.length) : name
}

/**
 * 本进程内已打开的会话目录 → 句柄。
 *
 * 存句柄而不只是目录名，是为了让 fork 这类**只读借用**场景能复用活动会话已经
 * 打开的句柄：活动会话的库句柄在本进程内唯一（EOPEN 守卫），fork 再去 open
 * 一次必然失败，于是「活动父会话无法 fork」——那是个假限制，不是安全要求。
 */
const openDirectories = new Map()

/**
 * 正在打开/初始化中的会话目录（同步占位）。
 *
 * 只有 `openDirectories` 一个集合是不够的：`open()` 的占用检查与真正的登记之间
 * 隔着 4 个 `await`（读 engine.json 等），两个并发 `open()` 会**同时通过检查**，
 * 各自建一个句柄，然后整文件原子重写互相覆盖——已提交历史静默丢失。
 * 这个集合在**第一个 await 之前**同步占位，把那个窗口堵死。
 */
const openingDirectories = new Set()

/**
 * 已初始化的 v2 会话库句柄。init 创建；open 采用既有目录并对账。
 */
export class V2SessionStore {
  /** @type {string} session directory */
  directory
  /** @type {string} session id */
  sessionId
  /** @type {string} session key (24 hex) */
  key
  /** @type {{ kind: string, schemaVersion: number, engine: string, sessionId: string, key: string, createdAt: string, disabled: null | { at: string, reason: string } }} */
  #engine
  /** @type {{ committedThrough: { txn: number, recordCount: number }, lastReconciledAt: string, warnings: string[] }} */
  #manifest
  /** @type {Map<string, { txn: number, kind: string, seq: number, fidelity: string, refs: object }>} id → catalog entry */
  #catalog = new Map()
  /** @type {Map<string, object>} callId → pairing entry */
  #pairing = new Map()

  /** seq → 记录 ID 倒排，打开时建一次；见 `idsBySeq`。 */
  #seqIndex = new Map()
  /** @type {boolean} */
  #readOnly
  /** @type {Set<string>} */
  #openTransactions = new Set()
  /** @type {string[]} */
  #committedTxnFiles = []

  constructor({ directory, engine, manifest, readOnly = false }) {
    this.directory = directory
    this.sessionId = engine.sessionId
    this.key = engine.key
    this.#engine = engine
    this.#manifest = manifest
    this.#readOnly = readOnly
  }

  get disabled() {
    return this.#engine.disabled !== null && this.#engine.disabled !== undefined
  }

  get readOnly() {
    return this.#readOnly || this.disabled
  }

  get committedThrough() {
    return { ...this.#manifest.committedThrough }
  }

  get warnings() {
    return [...this.#manifest.warnings]
  }

  get recordCount() {
    return this.#catalog.size
  }

  get hasOpenTransactions() {
    return this.#openTransactions.size > 0
  }

  // ---------------------------------------------------------------- 初始化

  /**
   * 同步占住会话目录（必须在任何 `await` 之前调用）。
   *
   * 「检查 + 占位」必须在同一个同步块里完成，否则并发调用会双双通过检查。
   * 占位失败一律 `EOPEN`：宁可让调用方重试，也不能让两个句柄同时写一个目录。
   */
  static #reserveDirectory(directory) {
    if (openDirectories.has(directory) || openingDirectories.has(directory)) {
      throw new EngineV2Error('同一会话目录不允许在本进程内打开第二个句柄', { code: 'EOPEN' })
    }
    openingDirectories.add(directory)
  }

  static #releaseReservation(directory) {
    openingDirectories.delete(directory)
  }

  /**
   * 打开句柄并对账，失败时把进程内注册项回滚掉。
   *
   * 注册项必须在 `#reconcile()` **之前**登记（否则两个并发 open 会同时通过
   * 目录占用检查），所以对账失败时也必须撤销登记：否则一次失败（例如事务目录
   * 权限问题）会把该会话在本进程内永久毒化成 EOPEN，磁盘修好也无法自愈。
   */
  static async #openWithReconcile({ directory, engine, readOnly }) {
    const store = new V2SessionStore({ directory, engine, readOnly })
    openDirectories.set(directory, store)
    try {
      await store.#reconcile()
    } catch (error) {
      openDirectories.delete(directory)
      throw error
    } finally {
      // 占位与真句柄在这一刻交接完成：无论成败都要撤掉占位，否则目录永久 EOPEN。
      V2SessionStore.#releaseReservation(directory)
    }
    return store
  }

  /**
   * 本进程内该会话已打开的句柄（没有则 null）。
   *
   * 借用方**不得**关闭借用到的句柄：它属于打开它的那一方。这是 fork 读活动父库
   * 的唯一合法途径——活动会话的库句柄在本进程内唯一，重新 open 只会拿到 EOPEN。
   */
  static peekOpen(labRoot, sessionId) {
    return openDirectories.get(v2SessionDirectoryFor(labRoot, sessionId)) ?? null
  }

  /**
   * 打开或借用父库句柄，供 fork 使用。
   *
   * 返回 `{ store, owned }`：`owned` 为 true 时调用方负责 close，为 false 时
   * 句柄属于别人（活动会话），只读借用后原样归还。
   */
  static async acquireShared({ labRoot, sessionId, readOnly = true }) {
    const borrowed = V2SessionStore.peekOpen(labRoot, sessionId)
    if (borrowed) return { store: borrowed, owned: false }
    const store = await V2SessionStore.open({ labRoot, sessionId, readOnly })
    return { store, owned: true }
  }
  static async init({ labRoot, sessionId }) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new EngineV2Error('init 需要 sessionId', { code: 'EINVAL' })
    }
    const root = await ensureLabRoot(labRoot)
    const directory = v2SessionDirectoryFor(root, sessionId)
    // 同步占位：下面的 mkdir / 读 engine.json / 写 engine.json 都是 await 点，
    // 并发 init 会双双通过「没打开过」的判断并各自建库。
    V2SessionStore.#reserveDirectory(directory)
    try {
      return await V2SessionStore.#initReserved({ directory, sessionId })
    } catch (error) {
      V2SessionStore.#releaseReservation(directory)
      throw error
    }
  }

  static async #initReserved({ directory, sessionId }) {
    await mkdir(path.join(directory, TRANSACTIONS_DIRECTORY), { recursive: true })
    await mkdir(path.join(directory, PAYLOADS_DIRECTORY), { recursive: true })
    const enginePath = path.join(directory, ENGINE_FILE)
    let engine = await readJsonStrict(enginePath, { label: 'v2 引擎声明' })
    if (engine !== null && !isEngineFile(engine)) {
      throw new EngineV2Error('v2 会话目录已被非本引擎数据占用，拒绝初始化。', { code: 'EFOREIGN', details: { directory } })
    }
    if (engine === null) {
      engine = {
        kind: ENGINE_KIND,
        schemaVersion: RECORDS_SCHEMA_VERSION,
        engine: ENGINE_V2_NAME,
        sessionId,
        key: sessionKeyFor(sessionId),
        createdAt: new Date().toISOString(),
        disabled: null,
      }
      await writeJsonFileAtomic(enginePath, engine)
    }
    return V2SessionStore.#openWithReconcile({ directory, engine, readOnly: false })
  }

  /** 打开既有 v2 会话库；从未初始化过返回 null。 */
  static async open({ labRoot, sessionId, readOnly = false }) {
    const directory = v2SessionDirectoryFor(labRoot, sessionId)
    // 同步占位：读 engine.json 是 await 点，并发 open 会双双通过检查。
    V2SessionStore.#reserveDirectory(directory)
    let handoff = false
    try {
      const engine = await readJsonStrict(path.join(directory, ENGINE_FILE), { label: 'v2 引擎声明' })
      if (engine === null) return null
      if (!isEngineFile(engine)) {
        throw new EngineV2Error('v2 引擎声明无效（kind/schema/engine 不匹配），拒绝读取。', { code: 'EDAMAGED', details: { directory } })
      }
      if (engine.sessionId !== sessionId) {
        throw new EngineV2Error('v2 引擎声明的 sessionId 与请求不符，拒绝读取。', { code: 'EDAMAGED', details: { directory } })
      }
      handoff = true
      return await V2SessionStore.#openWithReconcile({ directory, engine, readOnly })
    } finally {
      // 句柄交接由 #openWithReconcile 自己收尾；这条路径提前返回/抛错时在这里撤销。
      if (!handoff) V2SessionStore.#releaseReservation(directory)
    }
  }

  /**
   * 探测磁盘上是否有本引擎的 v2 库。
   *
   * 三种结果必须分开：**存在** / **不存在** / **存在但损坏**。把损坏说成「不存在」
   * 会让调用方（v1 接管判定、fork 规划）把未知状态当成空状态处理，所以损坏一律抛出。
   */
  static async exists(labRoot, sessionId) {
    const engine = await readJsonStrict(path.join(v2SessionDirectoryFor(labRoot, sessionId), ENGINE_FILE), { label: 'v2 引擎声明' })
    if (engine === null) return false
    if (!isEngineFile(engine)) {
      throw new EngineV2Error('v2 引擎声明损坏，无法判定会话状态。', { code: 'EDAMAGED' })
    }
    return true
  }

  // ---------------------------------------------------------------- 对账

  /**
   * 隔离区目录（会话根下 `quarantine/`，模块头声明的唯一权威位置）。
   *
   * 曾经有两套写法：写入用会话根，占用检查与对账却查 `transactions/quarantine`。
   * 后果不是「多一个空目录」——被隔离的事务号不再计入 `maxSeenTxn`，重启后
   * `#nextTxn` 回落并**复用隔离号**，于是回执里的稳定 ID 会静默指向另一条记录。
   * 现在两处都走这个函数；`#transactionFileExists` 额外兼容旧的嵌套位置。
   */
  #quarantineDirectory() {
    return path.join(this.directory, QUARANTINE_DIRECTORY)
  }

  /** 旧版本写过的嵌套隔离位置，只为不丢历史占用信息而兼容读取。 */
  #legacyQuarantineDirectory() {
    return path.join(this.directory, TRANSACTIONS_DIRECTORY, QUARANTINE_DIRECTORY)
  }

  async #reconcile() {
    const transactionsDirectory = path.join(this.directory, TRANSACTIONS_DIRECTORY)
    const quarantineDirectory = this.#quarantineDirectory()
    // 只读打开绝不写盘：不建目录、不重写 manifest/catalog、不移动坏事务。
    // 只读视图与持久修复必须分开——「读一次历史」不是一次维护动作。
    if (!this.#readOnly) await mkdir(transactionsDirectory, { recursive: true })

    const warnings = []
    let maxSeenTxn = 0
    const committed = []

    let entries
    try {
      entries = await readdir(transactionsDirectory, { withFileTypes: true })
    } catch (error) {
      if (error?.code === 'ENOENT' && this.#readOnly) {
        // 只读打开一个尚未建目录的会话：等价于「没有已提交历史」，不是损坏。
        entries = []
        warnings.push('事务目录不存在（只读打开），按无已提交历史处理')
      } else {
        throw new EngineV2Error(`事务目录不可读：${error.message}`, { code: 'EDAMAGED' })
      }
    }
    for (const entry of entries) {
      if (entry.name === QUARANTINE_DIRECTORY) continue
      if (!entry.isFile()) continue
      const txn = parseTransactionFileName(entry.name)
      if (txn === null) {
        warnings.push(`transactions 内有未知文件 ${entry.name}，已忽略`)
        continue
      }
      maxSeenTxn = Math.max(maxSeenTxn, txn)
      const file = path.join(transactionsDirectory, entry.name)
      let data
      try {
        data = await readJsonStrict(file, { label: `事务 ${entry.name}` })
      } catch (error) {
        await this.#quarantineOrWarn(transactionsDirectory, quarantineDirectory, entry.name, 'damaged', warnings)
        warnings.push(`事务 ${entry.name} 不可解析，已隔离：${error.message}`)
        continue
      }
      if (data?.kind !== TRANSACTION_KIND || data.schemaVersion !== RECORDS_SCHEMA_VERSION || data.txn !== txn) {
        await this.#quarantineOrWarn(transactionsDirectory, quarantineDirectory, entry.name, 'foreign', warnings)
        warnings.push(`事务 ${entry.name} 不符合 v2 事务 schema，已隔离`)
        continue
      }
      if (typeof data.committedAt !== 'string' || !Array.isArray(data.records)) {
        // 未提交（空意图或半程写入）：隔离保留，不参与目录；事务号不复用。
        await this.#quarantineOrWarn(transactionsDirectory, quarantineDirectory, entry.name, 'uncommitted', warnings)
        warnings.push(`事务 ${entry.name} 未提交（崩溃遗留），已隔离；其载荷不被目录引用`)
        continue
      }
      committed.push({ txn, data, file })
    }

    // 隔离区里的号同样占用：隔离文件保留取证，其事务号绝不能被后来者复用，
    // 否则新事务与隔离文件同号，重启对账时无法分辨谁是崩溃遗留。
    for (const directory of [quarantineDirectory, this.#legacyQuarantineDirectory()]) {
      let quarantined
      try {
        quarantined = await readdir(directory)
      } catch {
        continue
      }
      for (const name of quarantined) {
        const txn = parseTransactionFileName(originalTransactionNameOf(name))
        if (txn !== null) maxSeenTxn = Math.max(maxSeenTxn, txn)
      }
    }

    committed.sort((a, b) => a.txn - b.txn)
    this.#committedTxnFiles = committed.map((row) => row.file)
    const maxCommittedTxn = committed.length ? committed[committed.length - 1].txn : 0
    const committedRecordCount = committed.reduce((sum, row) => sum + row.data.records.length, 0)

    // manifest 对账：磁盘权威。
    //
    // manifest 损坏（坏 JSON / 陌生 schema）不得让整库拒服务：它是**检查点加速**，
    // 权威数据在事务文件里。降级为「空检查点 + 告警」并按事务重建，历史全部仍可达；
    // 只有事务文件本身损坏才隔离那一个事务。
    const manifestPath = path.join(this.directory, MANIFEST_FILE)
    let manifest = null
    try {
      manifest = await readJsonStrict(manifestPath, { label: 'v2 检查点' })
    } catch (error) {
      warnings.push(`检查点不可解析（${error.message}），已按空检查点从事务文件重建`)
      manifest = null
    }
    if (manifest !== null && (manifest?.kind !== MANIFEST_KIND || manifest?.schemaVersion !== RECORDS_SCHEMA_VERSION)) {
      warnings.push('manifest 不符合 schema，已按空检查点处理并重建')
    }
    const previousThrough = (manifest !== null && manifest.kind === MANIFEST_KIND) ? manifest.committedThrough : null
    let throughTxn = 0
    let throughCount = 0
    if (previousThrough && Number.isSafeInteger(previousThrough.txn)) {
      if (previousThrough.txn > maxCommittedTxn) {
        warnings.push(`manifest.committedThrough (${previousThrough.txn}) 领先于磁盘已提交事务 (${maxCommittedTxn})，已回退`)
        throughTxn = maxCommittedTxn
        throughCount = committedRecordCount
      } else {
        throughTxn = previousThrough.txn
        // 记录数以磁盘为准重算。
        throughCount = committed
          .filter((row) => row.txn <= previousThrough.txn)
          .reduce((sum, row) => sum + row.data.records.length, 0)
      }
    }
    if (maxCommittedTxn > throughTxn) {
      throughTxn = maxCommittedTxn
      throughCount = committedRecordCount
    }
    this.#manifest = {
      kind: MANIFEST_KIND,
      schemaVersion: RECORDS_SCHEMA_VERSION,
      committedThrough: { txn: throughTxn, recordCount: throughCount },
      lastReconciledAt: new Date().toISOString(),
      warnings,
    }
    // 只读打开只重建**内存**视图；检查点与目录缓存留给写入路径持久化。
    if (!this.#readOnly) await writeJsonFileAtomic(manifestPath, this.#manifest)

    await this.#buildCatalog(committed, warnings)

    // 预留事务号：包括被隔离的，避免与已隔离文件混淆。
    this.#nextTxn = maxSeenTxn + 1
  }

  /**
   * 隔离一个坏事务文件；只读打开时只记录告警，不移动任何文件。
   *
   * 只读契约要求读取前后文件树内容与时间戳不变，所以「移动坏事务」这个修复
   * 动作必须留给下一次可写打开。
   */
  async #quarantineOrWarn(transactionsDirectory, quarantineDirectory, name, reason, warnings) {
    if (this.#readOnly) {
      warnings.push(`事务 ${name} 需要隔离（${reason}），但本次为只读打开，未移动文件；下次可写打开会处理`)
      return
    }
    await this.#quarantine(transactionsDirectory, quarantineDirectory, name, reason)
  }

  async #quarantine(transactionsDirectory, quarantineDirectory, name, reason) {
    await mkdir(quarantineDirectory, { recursive: true })
    const target = path.join(quarantineDirectory, `${name}.${reason}.${Date.now()}.json`)
    await rename(path.join(transactionsDirectory, name), target).catch((error) => {
      if (error?.code !== 'ENOENT') throw error
    })
  }

  async #buildCatalog(committed, warnings) {
    const catalog = new Map()
    const pairing = new Map()
    let damagedRecords = 0
    for (const { data } of committed) {
      for (const candidate of data.records) {
        let record
        try {
          record = validateRecord(candidate)
        } catch {
          damagedRecords += 1
          continue
        }
        catalog.set(record.id, {
          txn: data.txn,
          kind: record.kind,
          seq: record.seq,
          fidelity: record.fidelity,
          createdAt: record.createdAt,
          refs: record.refs,
          inline: record.inline ?? {},
          payload: record.payload ?? null,
        })
        if (record.kind === RECORD_KINDS.OPERATION_CALL) {
          const entry = pairing.get(record.refs.callId)
          if (!entry) {
            pairing.set(record.refs.callId, { callRecordId: record.id, callSeq: record.seq, resultRecordId: null })
          } else {
            entry.duplicateCallRecordIds = [...(entry.duplicateCallRecordIds ?? []), record.id]
          }
        }
        if (record.kind === RECORD_KINDS.OPERATION_RESULT) {
          const entry = pairing.get(record.refs.callId)
          if (!entry) {
            pairing.set(record.refs.callId, { callRecordId: null, callSeq: null, resultRecordId: record.id, orphan: true })
          } else if (entry.resultRecordId === null) {
            entry.resultRecordId = record.id
          } else {
            entry.orphanResults = [...(entry.orphanResults ?? []), record.id]
          }
        }
      }
    }
    if (damagedRecords > 0) warnings.push(`目录重建时跳过 ${damagedRecords} 条不符合 schema 的已提交记录（保留在事务文件中）`)
    this.#catalog = catalog
    this.#pairing = pairing
    this.#seqIndex = new Map()
    for (const [id, entry] of catalog) this.#indexSeq(entry, id)

    // 目录缓存：可随时重建，仅作打开加速。只读打开不落盘。
    if (!this.#readOnly) await this.#persistCatalogSnapshot()
  }

  /** @type {number} 下一个可分配的事务号 */
  #nextTxn = 1

  // ---------------------------------------------------------------- 事务

  /**
   * 打开一个新事务（WAL 意图落盘）。
   *
   * `txn` 可选：fork 迁移要把父会话的记录**原样**搬进来（ID 不变），
   * 就必须沿用父事务号——否则新会话从 1 重新编号，父 ID 与子 ID 会在
   * 不同含义上重名。显式事务号必须 >= 当前计数器，并推进计数器。
   */
  async openTransaction({ txn: explicitTxn = null } = {}) {
    if (this.readOnly) {
      throw new EngineV2Error(this.disabled ? 'v2 会话已停用，处于只读状态，拒绝新事务。' : 'v2 会话以只读方式打开，拒绝新事务。', { code: 'EREADONLY' })
    }
    if (explicitTxn !== null) {
      if (!Number.isInteger(explicitTxn) || explicitTxn < 1 || explicitTxn > MAX_TRANSACTION_NUMBER) {
        throw new EngineV2Error(`非法事务号 ${explicitTxn}`, { code: 'EINVAL' })
      }
      if (this.#openTransactions.has(explicitTxn)) {
        throw new EngineV2Error(`事务 ${explicitTxn} 已在本库打开`, { code: 'EINVAL' })
      }
      // 显式事务号不得覆盖磁盘上已有的同号事务。stage/commit 都是整文件原子重写，
      // 所以「同号已存在」意味着覆盖——那会静默丢掉已提交的权威记录（fork 重试、
      // 或任何调用方复用号都会踩到）。磁盘是权威，这里必须查磁盘而不是只查内存集合。
      const occupied = await this.#transactionFileExists(explicitTxn)
      if (occupied) {
        throw new EngineV2Error(
          `事务号 ${explicitTxn} 已被磁盘上的既有事务占用，拒绝覆盖（事务号不复用）`,
          { code: 'EINVAL' },
        )
      }
    }
    const txn = explicitTxn ?? this.#nextTxn
    this.#nextTxn = Math.max(this.#nextTxn, txn + 1)
    const handle = {
      txn,
      records: [],
      openedAt: new Date().toISOString(),
    }
    this.#openTransactions.add(txn)
    await writeJsonFileAtomic(path.join(this.directory, TRANSACTIONS_DIRECTORY, transactionFileName(txn)), {
      kind: TRANSACTION_KIND,
      schemaVersion: RECORDS_SCHEMA_VERSION,
      txn,
      openedAt: handle.openedAt,
      committedAt: null,
      records: [],
    })
    return handle
  }

  /**
   * 磁盘上是否已存在该事务号的文件（已提交、未提交或崩溃遗留都算占用）。
   *
   * 也检查隔离区：被隔离的事务号同样不允许复用，否则新事务会与隔离文件的号
   * 混淆，重启对账时无法分辨谁是崩溃遗留。
   */
  async #transactionFileExists(txn) {
    const name = transactionFileName(txn)
    const candidates = [
      path.join(this.directory, TRANSACTIONS_DIRECTORY, name),
      // 隔离区可能有两种历史位置：会话根（现用）与 transactions 下（旧写法）。
      path.join(this.#quarantineDirectory(), name),
      path.join(this.#legacyQuarantineDirectory(), name),
    ]
    for (const candidate of candidates) {
      try {
        await access(candidate)
        return true
      } catch {
        // 不存在：继续查下一个位置。
      }
    }
    // 隔离文件名带后缀（`<name>.<reason>.<ts>.json`），前缀匹配同样算占用。
    for (const directory of [this.#quarantineDirectory(), this.#legacyQuarantineDirectory()]) {
      try {
        const quarantined = await readdir(directory)
        if (quarantined.some((entry) => entry === name || entry.startsWith(`${name}.`))) return true
      } catch {
        // 目录不存在：继续查下一个位置。
      }
    }
    return false
  }

  /**
   * 阶段化一条记录：载荷先落盘（内容寻址不可变），记录追加进事务文件。
   * 返回已赋稳定 ID 且通过 schema 校验的记录（不含 content）。
   */
  async stageRecord(handle, draft) {
    this.#assertWritable(`事务 ${handle.txn} 写入`)
    if (!this.#openTransactions.has(handle.txn)) {
      throw new EngineV2Error(`事务 ${handle.txn} 未在本库打开`, { code: 'EINVAL' })
    }
    if (handle.records.length >= 10_000) {
      throw new EngineV2Error('单事务记录数超限（10000），请先提交', { code: 'ELIMIT' })
    }
    const id = recordId(handle.txn, handle.records.length)
    const validated = validateRecord({ ...draft, id })
    if (validated.fidelity === 'verbatim' && !validated.payload
      && (draft.content === undefined || draft.content === null)) {
      throw new EngineV2Error(`记录 ${id} 声明 verbatim 但缺少载荷`, { code: 'ESCHEMA' })
    }

    if (draft.content !== undefined && draft.content !== null) {
      const buffer = typeof draft.content === 'string' ? Buffer.from(draft.content, 'utf8') : draft.content
      // 载荷哈希必须与声明一致，防止伪造内容寻址。
      const actual = `sha256:${createHash('sha256').update(buffer).digest('hex')}`
      if (validated.payload && actual !== validated.payload.hash) {
        throw new EngineV2Error(`记录 ${id} 的载荷哈希与内容不符（声明 ${validated.payload.hash}，实际 ${actual}）`, { code: 'EHASH' })
      }
      await this.#writePayload(buffer, validated.payload.hash)
    } else if (validated.payload) {
      throw new EngineV2Error(`记录 ${id} 声明了载荷但没有内容`, { code: 'ESCHEMA' })
    }

    handle.records.push(validated)
    await writeJsonFileAtomic(path.join(this.directory, TRANSACTIONS_DIRECTORY, transactionFileName(handle.txn)), {
      kind: TRANSACTION_KIND,
      schemaVersion: RECORDS_SCHEMA_VERSION,
      txn: handle.txn,
      openedAt: handle.openedAt,
      committedAt: null,
      records: handle.records,
    })
    return validated
  }

  async #writePayload(buffer, hashWithScheme) {
    const hex = hashWithScheme.slice('sha256:'.length)
    const target = path.join(this.directory, PAYLOADS_DIRECTORY, hex.slice(0, 2), hex)
    let existing
    try {
      existing = await readFile(target)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    if (existing !== undefined) {
      // 内容寻址：地址即内容哈希，所以同地址必须同内容。只比长度会让
      // 「写入成功」不等于「载荷正确」——读路径才会以 hash-mismatch 暴露它。
      if (existing.equals(buffer)) return
      throw new EngineV2Error(`载荷 ${hex} 已存在但内容不符（同哈希地址却不同内容），拒绝覆盖`, { code: 'EHASH' })
    }
    await writeFileAtomic(target, buffer)
  }

  /** 写入屏障：只读/已停用的库不得接受任何写入，哪怕事务是停用前打开的。 */
  #assertWritable(what) {
    if (this.#readOnly) {
      throw new EngineV2Error(`${what}被拒绝：v2 会话以只读方式打开。`, { code: 'EREADONLY' })
    }
    if (this.disabled) {
      throw new EngineV2Error(`${what}被拒绝：v2 会话已停用（停用即只读）。`, { code: 'EREADONLY' })
    }
  }

  /** 提交：先落 committedAt，再推进 manifest 检查点。 */
  async commitTransaction(handle) {
    this.#assertWritable(`事务 ${handle.txn} 提交`)
    if (!this.#openTransactions.has(handle.txn)) {
      throw new EngineV2Error(`事务 ${handle.txn} 未在本库打开`, { code: 'EINVAL' })
    }
    if (handle.records.length === 0) {
      // 空事务没有可提交内容：删除意图文件，回收事务号无必要（号已跳过）。
      await rm(path.join(this.directory, TRANSACTIONS_DIRECTORY, transactionFileName(handle.txn)), { force: true })
      this.#openTransactions.delete(handle.txn)
      return { committedTxn: null, recordCount: 0 }
    }
    const file = path.join(this.directory, TRANSACTIONS_DIRECTORY, transactionFileName(handle.txn))
    await writeJsonFileAtomic(file, {
      kind: TRANSACTION_KIND,
      schemaVersion: RECORDS_SCHEMA_VERSION,
      txn: handle.txn,
      openedAt: handle.openedAt,
      committedAt: new Date().toISOString(),
      records: handle.records,
    })
    // ── 不可逆提交点：committedAt 已落盘，磁盘事务文件就是权威历史 ──
    // 从这里往后的一切（manifest、目录缓存、配对账本）都是**派生**的：
    // 它们失败只能降级为告警，绝不能反过来删掉权威事务文件。
    this.#openTransactions.delete(handle.txn)

    this.#manifest.committedThrough = {
      txn: Math.max(this.#manifest.committedThrough.txn, handle.txn),
      recordCount: this.#manifest.committedThrough.recordCount + handle.records.length,
    }
    this.#manifest.lastReconciledAt = new Date().toISOString()
    try {
      await writeJsonFileAtomic(path.join(this.directory, MANIFEST_FILE), this.#manifest)
    } catch (error) {
      // 重启对账会从已提交事务文件回补检查点，所以这里不失败、只记录。
      this.#manifest.warnings = [
        ...this.#manifest.warnings,
        `提交后检查点推进失败（${error instanceof Error ? error.message : String(error)}）；重启对账会从已提交事务回补`,
      ]
    }

    // 增量更新内存目录并落盘快照（目录可重建，此处仅为打开加速与观测）。
    for (const record of handle.records) {
      this.#catalog.set(record.id, {
        txn: handle.txn,
        kind: record.kind,
        seq: record.seq,
        fidelity: record.fidelity,
        createdAt: record.createdAt,
        refs: record.refs,
        inline: record.inline ?? {},
        payload: record.payload ?? null,
      })
      this.#indexSeq(record, record.id)
      this.#applyPairing(record)
    }
    try {
      await this.#persistCatalogSnapshot()
    } catch (error) {
      this.#manifest.warnings = [
        ...this.#manifest.warnings,
        `提交后目录缓存落盘失败（${error instanceof Error ? error.message : String(error)}）；缓存可重建，权威事务不受影响`,
      ]
    }
    return { committedTxn: handle.txn, recordCount: handle.records.length }
  }

  /**
   * 主动放弃未提交事务：删除意图文件，返回调用方得到干净失败。
   *
   * **已提交的事务绝不能删**。提交点写在事务文件的 `committedAt` 上，而句柄可能
   * 因提交后的派生步骤失败而残留在内存集合里；只看内存集合会把权威历史删掉，
   * 于是原文再也回不来。所以删之前必须读一次磁盘，以磁盘为准。
   * 孤儿载荷留置（内容寻址、可共享，不回收）。
   */
  async abandonTransaction(handle) {
    if (!this.#openTransactions.has(handle.txn)) {
      return { abandoned: false }
    }
    const file = path.join(this.directory, TRANSACTIONS_DIRECTORY, transactionFileName(handle.txn))
    let onDisk = null
    try {
      onDisk = await readJsonStrict(file, { label: `事务 ${handle.txn}` })
    } catch {
      // 不可解析：无法证明它未提交，按「未知」处理——保留文件并释放句柄。
      this.#openTransactions.delete(handle.txn)
      return { abandoned: false, reason: 'unreadable' }
    }
    if (onDisk === null) {
      // 文件已不在（例如空事务已回收）：只释放句柄。
      this.#openTransactions.delete(handle.txn)
      return { abandoned: false, reason: 'missing' }
    }
    if (typeof onDisk.committedAt === 'string') {
      // 已提交：句柄释放，但权威事务文件保留。
      this.#openTransactions.delete(handle.txn)
      return { abandoned: false, reason: 'committed' }
    }
    if (this.#readOnly) {
      this.#openTransactions.delete(handle.txn)
      return { abandoned: false, reason: 'readonly' }
    }
    await rm(file, { force: true })
    this.#openTransactions.delete(handle.txn)
    return { abandoned: true }
  }

  async #persistCatalogSnapshot() {
    await writeJsonFileAtomic(path.join(this.directory, CATALOG_FILE), {
      kind: CATALOG_KIND,
      schemaVersion: RECORDS_SCHEMA_VERSION,
      builtThroughTxn: this.#manifest.committedThrough.txn,
      recordCount: this.#catalog.size,
      pairingOpenCalls: this.openCalls().length,
      entries: Object.fromEntries([...this.#catalog.entries()].map(([id, entry]) => [id, entry])),
    })
  }

  #applyPairing(record) {
    if (record.kind === RECORD_KINDS.OPERATION_CALL) {
      const entry = this.#pairing.get(record.refs.callId)
      if (!entry) {
        this.#pairing.set(record.refs.callId, { callRecordId: record.id, callSeq: record.seq, resultRecordId: null })
      } else {
        entry.duplicateCallRecordIds = [...(entry.duplicateCallRecordIds ?? []), record.id]
      }
      return
    }
    if (record.kind === RECORD_KINDS.OPERATION_RESULT) {
      const entry = this.#pairing.get(record.refs.callId)
      if (!entry) {
        this.#pairing.set(record.refs.callId, { callRecordId: null, callSeq: null, resultRecordId: record.id, orphan: true })
      } else if (entry.resultRecordId === null) {
        entry.resultRecordId = record.id
      } else {
        entry.orphanResults = [...(entry.orphanResults ?? []), record.id]
      }
    }
  }

  /**
   * 显式放弃未提交事务（保留给调用方的兼容入口）。
   *
   * 与 `abandonTransaction` 同一条安全路径：绝不删已提交事务。
   */
  async abortTransaction(handle) {
    return this.abandonTransaction(handle)
  }

  // ---------------------------------------------------------------- 停用/恢复

  /** 停用：此后拒绝新事务，回读与对账保持可用（只读）。 */
  async disable(reason) {
    if (this.#readOnly) throw new EngineV2Error('只读句柄不能改变停用状态', { code: 'EREADONLY' })
    this.#engine = { ...this.#engine, disabled: { at: new Date().toISOString(), reason: String(reason ?? '') } }
    await writeJsonFileAtomic(path.join(this.directory, ENGINE_FILE), this.#engine)
  }

  async reenable() {
    if (this.#readOnly) throw new EngineV2Error('只读句柄不能改变停用状态', { code: 'EREADONLY' })
    this.#engine = { ...this.#engine, disabled: null }
    await writeJsonFileAtomic(path.join(this.directory, ENGINE_FILE), this.#engine)
  }

  close() {
    openDirectories.delete(this.directory)
  }

  // ---------------------------------------------------------------- 目录查询

  /** 按稳定 ID 全序分页列出目录条目。 */
  listEntries({ afterId = null, limit = 100, kinds = null } = {}) {
    const ids = [...this.#catalog.keys()].sort(compareRecordIds)
    const start = afterId === null ? 0 : ids.findIndex((id) => compareRecordIds(id, afterId) > 0)
    const from = start === -1 ? ids.length : start
    const page = []
    let total = 0
    for (let index = from; index < ids.length; index += 1) {
      const entry = this.#catalog.get(ids[index])
      if (kinds && !kinds.includes(entry.kind)) continue
      total += 1
      if (page.length < limit) page.push({ id: ids[index], ...entry })
    }
    return { entries: page, nextAfter: page.length ? page[page.length - 1].id : afterId, total }
  }

  getEntry(id) {
    const entry = this.#catalog.get(id)
    return entry ? { id, ...entry } : null
  }

  pairingLedger() {
    return new Map(this.#pairing)
  }

  /** 未闭合工具配对（在途动作）。 */
  openCalls() {
    const open = []
    for (const [callId, entry] of this.#pairing) {
      if (entry.callRecordId !== null && entry.resultRecordId === null && !entry.orphan) {
        open.push({ callId, ...entry })
      }
    }
    return open
  }

  /**
   * 按宿主事件 seq 查记录 ID。
   *
   * 走 `#seqIndex`（打开时建一次），不是每次全库扫描：工作状态卡会**对每个活动面
   * 节点**调一次，全库扫描会把卡片成本变成 O(节点数 × 记录数)，热上下文占用
   * 有界了、建卡成本却随历史线性增长。
   */
  idsBySeq(seq) {
    return [...(this.#seqIndex.get(seq) ?? [])].sort(compareRecordIds)
  }

  /** 打开/追加记录时维护 seq → 记录 ID 的倒排。 */
  #indexSeq(entry, id) {
    if (!Number.isInteger(entry?.seq)) return
    const bucket = this.#seqIndex.get(entry.seq)
    if (bucket) bucket.add(id)
    else this.#seqIndex.set(entry.seq, new Set([id]))
  }

  // ---------------------------------------------------------------- 回读

  /**
   * 精确 ID 回读：从事务文件取记录并按需读载荷。
   * 完整性单独报告：hash 校验只是完整性检查，不是「事实验证」。
   *
   * `maxBytes` 给出**有界读取**：载荷大于上限时只读前缀，返回
   * `truncated: true` 且 `integrity: 'prefix'`（明确表示本次没有对全文做哈希
   * 校验）。没有它时读全文并校验——预算受限的调用方不该被迫先把整篇读进内存。
   */
  async readRecord(id, { verifyHash = true, maxBytes = null, offsetBytes = 0 } = {}) {
    const parsed = parseRecordId(id)
    if (!parsed) throw new EngineV2Error(`非法记录 ID：${id}`, { code: 'EINVAL' })
    const entry = this.#catalog.get(id)
    if (!entry) return { ok: false, error: 'not_in_catalog', id }
    const file = path.join(this.directory, TRANSACTIONS_DIRECTORY, transactionFileName(parsed.txn))
    let data
    try {
      data = await readJsonStrict(file, { label: `事务 ${parsed.txn}` })
    } catch (error) {
      return { ok: false, error: 'transaction_unreadable', id, detail: error.message }
    }
    if (data === null || typeof data.committedAt !== 'string') {
      return { ok: false, error: 'transaction_not_committed', id }
    }
    const record = (data.records ?? []).find((candidate) => candidate.id === id)
    if (!record) return { ok: false, error: 'not_in_transaction', id }

    let payloadText = null
    let integrity = 'no-payload'
    let truncated = false
    let fullBytes = record.payload?.size ?? 0
    if (record.payload) {
      const loaded = await this.#readPayload(record.payload, { verifyHash, maxBytes, offsetBytes })
      integrity = loaded.integrity
      payloadText = loaded.text
      truncated = loaded.truncated === true
      fullBytes = loaded.fullBytes ?? fullBytes
    }
    return { ok: true, id, record, entry, payloadText, integrity, truncated, fullBytes }
  }

  async #readPayload(payload, { verifyHash, maxBytes = null, offsetBytes = 0 }) {
    const hex = payload.hash.slice('sha256:'.length)
    const file = path.join(this.directory, PAYLOADS_DIRECTORY, hex.slice(0, 2), hex)
    const fullBytes = payload.size
    const bounded = Number.isFinite(maxBytes) && maxBytes > 0 && fullBytes > maxBytes
    let buffer
    try {
      if (bounded) {
        // P1-7：offsetBytes>0 时读中段（分块索引）；chunk 起点越界时返回空段。
        const start = Math.max(0, Number.isFinite(offsetBytes) ? offsetBytes : 0)
        buffer = start >= fullBytes ? Buffer.alloc(0) : await readRange(file, start, maxBytes)
      } else {
        buffer = await readFile(file)
      }
    } catch (error) {
      if (error?.code === 'ENOENT') return { integrity: 'payload-missing', text: null, fullBytes }
      return { integrity: 'payload-unreadable', text: null, fullBytes }
    }
    if (bounded) {
      // 只读了片段：不对全文做哈希断言，如实标 'prefix'（不是 'ok'）。
      const text = payload.encoding === 'base64' ? buffer.toString('base64') : buffer.toString('utf8')
      return { integrity: 'prefix', text, truncated: fullBytes > (offsetBytes || 0) + buffer.byteLength, fullBytes, prefixBytes: (offsetBytes || 0) + buffer.byteLength }
    }
    if (buffer.byteLength !== fullBytes) {
      return { integrity: 'size-mismatch', text: null, fullBytes }
    }
    if (verifyHash) {
      const actual = createHash('sha256').update(buffer).digest('hex')
      if (actual !== hex) return { integrity: 'hash-mismatch', text: null, fullBytes }
    }
    const text = payload.encoding === 'base64' ? buffer.toString('base64') : buffer.toString('utf8')
    return { integrity: 'ok', text, truncated: false, fullBytes }
  }

  /** 观测统计（成本观测入口）。 */
  stats() {
    const kinds = {}
    for (const entry of this.#catalog.values()) kinds[entry.kind] = (kinds[entry.kind] ?? 0) + 1
    return {
      engine: ENGINE_V2_NAME,
      sessionId: this.sessionId,
      key: this.key,
      committedThrough: this.committedThrough,
      recordCount: this.#catalog.size,
      openCallCount: this.openCalls().length,
      disabled: this.disabled,
      readOnly: this.readOnly,
      warnings: this.warnings,
      kinds,
    }
  }
}
