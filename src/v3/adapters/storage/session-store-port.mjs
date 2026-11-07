/**
 * SessionStore 端口装配（adapters/storage，M3 第一批）。
 *
 * 把 session-store（事务/对账）、write-lock（串行化）、lexical-index（派生索引）、
 * vouchers/forgotten（恢复与隐私面）组合成 ports 定义的 SessionStore 方法面，
 * 经 assertPort 装配期校验（缺方法即失败，fail-closed）。
 * 索引维护点（2026-10-25 事故修正）：写事务**不再**每笔全量重建——真机实测 2252 条
 * 逐条重建耗时 10 分钟（O(N²)）；索引是派生物（P9），陈化由检索入口自动重建兜底，
 * 批量摄入完成后由调用方显式 rebuildIndex 一次。
 */
import { assertPort } from '../../ports/index.mjs'
import { v3Error, V3ContractViolation } from '../../contracts/index.mjs'
import { restoreEligibilityOf } from '../../domain/archive/restore.mjs'
import { openV3SessionStore, rebuildPurgedLedger, repairSessionJournals } from './session-store.mjs'
import { withCrossProcessWriteLock } from './write-lock.mjs'
import { buildLexicalIndex, isIndexStale, readLexicalIndex, updateLexicalIndexIncremental, writeLexicalIndex } from './lexical-index.mjs'
import { buildChunkIndex, writeChunkIndex } from './chunk-index.mjs'

/**
 * 打开并装配 SessionStore 端口。
 * @param {string} root v3 数据根
 * @param {string} sessionKey 会话隔离键
 */
export async function createSessionStorePort(root, sessionKey) {
  let store = await openV3SessionStore(root, sessionKey)
  // G-A（0.14.0-beta.48）：崩溃留下的**尾部半行**在写锁内自动截断后重开；
  // 中段损坏/完整行损坏/账实不符一概不动，仍按 damaged 失败关闭（读允许、写拒绝）。
  try {
    if (store.health().healthy !== true) {
      const repaired = await repairSessionJournals(store.directory)
      if (repaired.changed === true) {
        store.close()
        store = await openV3SessionStore(root, sessionKey)
      }
    }
  } catch {
    // 修复失败不改变失败关闭语义：保留 damaged 句柄，写入继续被拒绝（不静默放行）。
  }
  const dir = store.directory

  /**
   * 构建索引（可选是否落盘）。H-1："锁外构建 + 锁内短写" 与锁内重建共用这一份，
   * 避免两套遍历逻辑漂移。
   */
  async function buildIndex({ write = true } = {}) {
    // 跨句柄一致性：重建前先把别的句柄/进程写入的 forget 行并进来，
    // 否则已遗忘记录会被重新写进索引（隐私面回退，且 indexStale 不会再纠正）。
    await store.refreshForgotten?.()
    const forgotten = new Set(store.listForgotten())
    const committedIds = await store.listRecordIds()
    // sourceCount 用**未过滤**的已提交数：它是新鲜度的比对基线（见 lexical-index 注释）
    const ids = committedIds.filter((id) => !forgotten.has(id))
    const entries = []
    let metaOnlySkipped = 0
    let dupSuperseded = 0
    // H-01 存量重复合并（查询面口径）：同 sourceEventId 的多份拷贝只留最早 createdAt 一条进索引。
    // 字节不动（记录文件原样保留、按 ID 仍可精确回读），只影响检索/回注面。
    const earliestByEvent = new Map()
    for (const id of ids) {
      const record = await store.readRecord(id)
      // metadata-only 不进全文检索（P1 摄入合同 4.1.5）：可回读、可对账，不占检索位
      if (record.payload?.metaOnly === true) { metaOnlySkipped += 1; continue }
      const ev = record.provenance?.sourceEventId
      if (typeof ev === 'string' && ev.length > 0) {
        const prev = earliestByEvent.get(ev)
        if (prev !== undefined) {
          const at = Number.isFinite(record.createdAt) ? record.createdAt : 0
          const curWins = at < prev.at || (at === prev.at && id > prev.id)
          if (curWins) {
            // 当前条更早/更稳：撤下先前条
            const pi = entries.findIndex((e) => e.id === prev.id)
            if (pi >= 0) entries.splice(pi, 1)
            earliestByEvent.set(ev, { id, at })
          } else {
            dupSuperseded += 1
            continue
          }
        } else {
          earliestByEvent.set(ev, { id, at: Number.isFinite(record.createdAt) ? record.createdAt : 0 })
        }
      }
      entries.push({ id, text: record.payload.text })
    }
    const index = buildLexicalIndex(entries, { sourceCount: committedIds.length, forgottenCount: forgotten.size })
    // 0.15.0 P5：chunk 索引是同一批 entries 的派生引用（只存码点 span），
    // 与词法索引一起落盘；其中任一派生物缺失/换代都不挡检索（查询侧降级现扫）。
    const chunkIndex = buildChunkIndex(entries, { sourceCount: committedIds.length, forgottenCount: forgotten.size })
    if (write) {
      await writeLexicalIndex(store, index)
      await writeChunkIndex(store, chunkIndex)
    }
    return { index, chunkIndex }
  }

  /**
   * M-04（0.15.4，P1）：**增量**并入索引，避免每步全量重建。
   *
   * 记录提交后不可变，所以「旧索引 + 新增 doc − 移除 doc」与全量重扫等价。
   * 旧索引不可信（缺失/损坏/基线与实际不符）时**不猜**：返回 `applied:false`，
   * 由调用方退回 `rebuildIndex()`。宁可多扫一次，也不让索引悄悄偏离真源。
   *
   * @param {{added?: Array<{id,text}>, removed?: string[]}} plan
   */
  async function updateIndexIncrementally(plan = {}) {
    return withCrossProcessWriteLock(dir, async (ownership) => {
      await store.syncFromLog()
      ownership.assertOwned()
      const result = await updateLexicalIndexIncremental(store, plan)
      if (result.applied !== true) return { applied: false, reason: result.reason ?? 'not-applied' }
      await writeLexicalIndex(store, result.index)
      return { applied: true, index: result.index }
    })
  }

  /** 锁内全量重建（调用方必须已持锁）。 */
  async function rebuildIndex() {
    return (await buildIndex({ write: true })).index
  }

  /**
   * H-1（0.14.0-beta.48）：索引重建默认在**锁外构建**，只在锁内做新鲜度复核 + 短写。
   *
   * 旧实现把「读全部记录 + 建索引 + 写 3 MB」整个塞进跨进程写锁：443 条约 307 ms，
   * 线性外推到 5,431 条约 3.7 s，叠加另一进程持锁的最长 5 s 等待，ELOCKED 风险真实。
   * 判据：构建前后取两次轻量基线（事务号/已提交数/遗忘戳），相同才在锁内复核后落盘；
   * 任一字段变化（期间有提交/遗忘）或复核不符 → 退回锁内全量重建（正确性优先）。
   * 记录提交后不可变，锁外读记录本身不会读到半条。
   */
  async function rebuildIndexSafely() {
    let built = null
    try {
      await store.refreshForgotten?.()
      const before = await store.freshness()
      const indexes = await buildIndex({ write: false })
      const after = await store.freshness()
      built = { indexes, baseline: after, stable: JSON.stringify(before) === JSON.stringify(after) }
    } catch {
      built = null // 构建失败不掩盖：锁内重建会如实抛出
    }
    return withCrossProcessWriteLock(dir, async (ownership) => {
      await store.syncFromLog()
      ownership.assertOwned() // R3-03：失锁后不落索引短写，退回锁内全量也一并不做
      if (built !== null && built.stable === true) {
        const current = await store.freshness()
        if (JSON.stringify(current) === JSON.stringify(built.baseline)) {
          // 两份派生物在同一持锁窗口内短写：词法索引先落，chunk 索引后落；
          // 中间崩溃只会留下「chunk 索引较旧」，读取侧按 stale 降级现扫，不误用旧窗口。
          await writeLexicalIndex(store, built.indexes.index)
          await writeChunkIndex(store, built.indexes.chunkIndex)
          return built.indexes.index
        }
      }
      return rebuildIndex()
    })
  }

  // 来源事件 → 记录 ID 缓存：进程内惰性构建，任何写操作后失效（H-01：断点必须能从库反推）。
  // P7 首次呈现复用这张表定位「这次 tool/result 已经有哪条记录」，不新建记录类型/第二套冷库。
  let sourceEventMap = null

  /**
   * 来源事件 ID → 记录 ID。
   *
   * 重复摄入（同 sourceEventId 多份拷贝）时**固定取字典序最小的记录 ID**：
   * H-01 的「最早 createdAt」是检索面口径，而句柄必须逐次稳定；两份拷贝正文相同，
   * 取哪份不影响可读性，取最小 ID 保证跨进程/跨次调用同一个句柄。
   * 含已遗忘记录：遗忘是「不可见」，不是「从未摄入」；读正文时仍会 EFORGOTTEN。
   */
  async function sourceEventMapOf() {
    // T-08（0.15.4）：失败**不再永久粘住**。
    //
    // 旧实现把首次失败的 error 存进 `sourceEventFailure`，此后每次都直接抛它：
    // 磁盘修好后（补回记录、修复权限）进程内也永远恢复不了——只能重启 DSH，
    // 而用户看到的是「怎么修都没用」。
    //
    // 现在：失败只在**本次调用**抛出（fail-closed 不变，绝不返回半张表），
    // 但不把错误记成终态；下一次调用重新尝试构建。仍然失败就仍然抛，
    // 修好了就自然恢复，不需要重启。
    if (sourceEventMap !== null) return sourceEventMap
    const out = new Map()
    for (const id of await store.listRecordIds()) {
      let provenance
      try {
        provenance = await store.readProvenance(id)
      } catch (error) {
        // 读不到 ≠ 没有（fail-closed）：派生物不得掩盖损坏，否则断点会静默回退到 -1。
        // 只让这一次失败，不写终态（T-08）。
        throw error
      }
      const sourceEventId = provenance?.sourceEventId
      if (typeof sourceEventId !== 'string' || sourceEventId.length === 0) continue
      const prev = out.get(sourceEventId)
      if (prev === undefined || id < prev) out.set(sourceEventId, id)
    }
    sourceEventMap = out
    return out
  }

  async function sourceEventIds() {
    return [...(await sourceEventMapOf()).keys()]
  }

  /** 单条来源事件 → 记录 ID；没有则 null（不猜、不扫描正文）。 */
  async function recordIdOfSourceEvent(sourceEventId) {
    if (typeof sourceEventId !== 'string' || sourceEventId.length === 0) {
      throw new V3ContractViolation('v3 store: recordIdOfSourceEvent 的 sourceEventId 必须是非空字符串')
    }
    return (await sourceEventMapOf()).get(sourceEventId) ?? null
  }

  const impl = {
    /** 单笔事务：锁内提交，提交后重建索引（遗忘记录不入索引）。 */
    async transaction(records, { at } = {}) {
      const txn = await withCrossProcessWriteLock(dir, async (ownership) => {
      await store.syncFromLog() // H-10-b：锁内增量视图同步，多句柄/多进程提交不漏
        // R3-03：失锁（被接管/心跳失败）后的提交失败关闭——已发生的写入保留事务
        // 恢复证据，这里只保证不再继续往可能易主的目录里追加新提交。
        ownership.assertOwned()
        const committed = await store.submitTransaction(records, { at })
        // B2-8：检查点与提交同一把锁内追加（纯缓存：失败只损失下次打开的速度，
        // 下次打开回退全量扫描并重建基线，绝不影响正确性）。
        try {
          const pairs = records
            .filter((record) => typeof record?.provenance?.sourceEventId === 'string' && typeof record?.id === 'string')
            .map((record) => [record.provenance.sourceEventId, record.id])
          await store.appendCheckpoint(committed.txn, pairs)
        } catch { /* 检查点追加失败不回滚提交 */ }
        return committed
      })
      sourceEventMap = null
      return txn
    },

    /** 已提交记录的来源事件 ID 清单（摄入断点反推用；派生物，写后失效）。 */
    sourceEventIds,

    /** 单条来源事件 → 记录 ID（P7 首次呈现复用既有记录；读不到返回 null）。 */
    recordIdOfSourceEvent,

    async readRecord(id) {
      return store.readRecord(id)
    },

    /**
     * 物理清除（H4）：整批预检 + 逐条 store.purge + 重建索引。
     * 与 forget 的差别只有一点：正文文件真的删掉，undo 永久不可用。
     */
    async purge(recordIds) {
      if (!Array.isArray(recordIds) || recordIds.length === 0) {
        throw new V3ContractViolation('v3 store: purge 的 recordIds 必须是非空数组')
      }
      for (const id of recordIds) {
        if (typeof id !== 'string' || id.length === 0) {
          throw new V3ContractViolation('v3 store: purge 的每个 id 必须是非空字符串')
        }
      }
      return withCrossProcessWriteLock(dir, async (ownership) => {
        await store.syncFromLog()
        const committed = new Set(await store.listRecordIds())
        const missing = recordIds.filter((id) => !committed.has(id))
        if (missing.length > 0) {
          throw v3Error('ESTORE_TXN_CONFLICT', 'purge 目标不存在或未提交（整批拒绝，一条都未清除）：' + missing.join('、'))
        }
        ownership.assertOwned()
        let purged = 0
        try {
          for (const id of recordIds) {
            const row = await store.purge(id)
            if (row.alreadyPurged !== true) purged += 1
          }
        } finally {
          await rebuildIndex()
        }
        const index = await readLexicalIndex(store)
        return { purgedCount: purged, indexedCount: index?.indexedCount ?? 0 }
      })
    },

    /** 已物理清除 ID（undo 可用性判定）。 */
    listPurged() {
      return typeof store.listPurged === 'function' ? store.listPurged() : []
    },

    /** 记录 ID 清单（归档需要宿主 seq → recordId；只给 ID，不读正文）。 */
    async listRecordIds() {
      return store.listRecordIds()
    },

    /** 单条 provenance（不读正文；来源事件 ID 反推/归档映射用）。 */
    async readProvenance(id) {
      return store.readProvenance(id)
    },

    /** B2-8：读打开期检查点（透传 store；可用性由 store 判定）。 */
    async readCheckpoint() {
      return store.readCheckpoint()
    },

    /**
     * B2-8：全量扫描后落检查点基线（迁移旧库/回退后的重建路径）。
     * 锁内核对 txn 仍是日志最新——不一致就不写（扫描结果已过期，下次打开重扫）。
     */
    async saveCheckpointBaseline(txn, pairs) {
      if (!Number.isInteger(txn) || txn < 1) return { written: false, reason: 'no-txn' }
      if (!(pairs instanceof Map) || pairs.size === 0) return { written: false, reason: 'empty' }
      return withCrossProcessWriteLock(dir, async (ownership) => {
        await store.syncFromLog()
        if (store.health().maxTxn !== txn) return { written: false, reason: 'stale' }
        ownership.assertOwned() // R3-03
        await store.appendCheckpointBaseline(txn, [...pairs])
        return { written: true }
      })
    },

    /** 追加归档凭证（surface 回执 ↔ recordIds 的 durable 映射）。 */
    async appendVoucher(voucher) {
      // B3-7（AUD50-03-06）：凭证追加与其它写原语共用同一把跨进程写锁——裸追加在
      // 两进程并发时会产生半行/丢失，repair 也会误判。已持锁的调用方走 ALS 重入，不死锁。
      return withCrossProcessWriteLock(dir, (ownership) => {
        ownership.assertOwned() // R3-03：失锁后拒绝追加凭证
        return store.appendVoucher(voucher)
      })
    },

    /**
     * 恢复资格：按凭证下标取凭证，与调用方给的当前表面正文做逐字节比对
     * （domain/archive 的 restoreEligibilityOf——N-11b）。
     */
    restore(voucherIndex, surfaceText) {
      const vouchers = store.listVouchers()
      const voucher = vouchers[voucherIndex]
      if (voucher === undefined) {
        return { voucher: null, eligibility: { eligible: false, reason: '凭证下标不存在' } }
      }
      return { voucher, eligibility: restoreEligibilityOf({ receiptText: voucher.receiptText, surfaceText }) }
    },

    /**
     * 批量遗忘：幂等；锁内执行；遗忘后重建索引（检索面立即不可见）。
     *
     * 全有或全无（H-40）：旧实现是「循环逐条 store.forget(id)，然后重建索引」。
     * 第 k 条非法时前 k-1 条**已经提交遗忘**，然后抛出——调用方看到的是「整批失败」，
     * 实际状态是「部分遗忘」，而且**索引重建那一步没跑**，于是：
     * 已遗忘记录仍留在检索面（实测 search 仍返回它），recall 命中它时 read 抛 EFORGOTTEN
     * 把整次回注打挂。一次拼错 ID 就能造出这个状态。
     *
     * 现在：先**整批预检**（ID 形态 + 是否已提交），任一不合格即整批拒绝、一条都不忘；
     * 预检通过后的写入若仍在中途失败（IO），也要在 finally 里重建索引——
     * 「忘了几条」与「索引反映哪几条」必须一致，不能靠调用方补救。
     */
    async forget(recordIds) {
      if (!Array.isArray(recordIds) || recordIds.length === 0) {
        throw new V3ContractViolation('v3 store: forget 的 recordIds 必须是非空数组')
      }
      for (const id of recordIds) {
        if (typeof id !== 'string' || id.length === 0) {
          throw new V3ContractViolation('v3 store: forget 的每个 id 必须是非空字符串')
        }
      }
      return withCrossProcessWriteLock(dir, async (ownership) => {
      await store.syncFromLog() // H-10-b：锁内增量视图同步，多句柄/多进程提交不漏
        // 预检：全部 id 必须已提交（幂等允许「已遗忘」，但**不允许**「从未提交」）
        const committed = new Set(await store.listRecordIds())
        const missing = recordIds.filter((id) => !committed.has(id))
        if (missing.length > 0) {
          throw v3Error('ESTORE_TXN_CONFLICT', 'forget 目标不存在或未提交（整批拒绝，一条都未遗忘）：' + missing.join('、'))
        }
        ownership.assertOwned() // R3-03：失锁后拒绝继续遗忘
        try {
          for (const id of recordIds) await store.forget(id)
        } finally {
          // 无论逐条写入是否中途失败，索引都必须反映**真实的**遗忘集：
          // 否则已遗忘正文会继续留在检索面（隐私面与检索面不一致）。
          await rebuildIndex()
        }
        const index = await readLexicalIndex(store)
        return { forgottenCount: store.listForgotten().length, indexedCount: index?.indexedCount ?? 0 }
      })
    },

    /**
     * 导入外部脱敏包（M5）：新 ID/新事务；导入后重建索引使检索可见。
     * AUD50-03-02（B2-5）：导入必须与 transaction/forget/revokeForget 共用同一把
     * 跨进程写锁——旧实现绕过锁，两个句柄并发 import 会拿到同一个事务号
     * （实测 txnA=txnB=1，commit 行 [1,1]，唯一事务号 1，manifest.txnNext=2）。
     * 锁内先 syncFromLog：事务号基于最新日志分配。索引重建留在锁外（避免长临界区）。
     */
    async importRecords(records) {
      const result = await withCrossProcessWriteLock(dir, async (ownership) => {
        await store.syncFromLog() // 锁内增量视图同步：多句柄/多进程提交不漏
        ownership.assertOwned() // R3-03：失锁后拒绝导入
        const imported = await store.importRecords(records)
        try {
          // B2-8：导入事务也记账（pairs 为空——导入记录没有宿主事件映射），
          // 让检查点的 txn 跟上日志 maxTxn，否则一次导入后每次打开都回退全量扫描。
          await store.appendCheckpoint(imported.txn, [])
        } catch { /* 检查点失败不影响导入事实 */ }
        return imported
      })
      try {
        await rebuildIndex()
      } catch {
        // 索引可重建；导入事实已提交，不因派生物失败回滚
      }
      return result
    },

    /** 撤销遗忘（M3）：整批预检 + 逐条追加 revoke + 重建索引（失败也重建）。 */
    async revokeForget(recordIds) {
      if (!Array.isArray(recordIds) || recordIds.length === 0) {
        throw new V3ContractViolation('v3 store: revokeForget 的 recordIds 必须是非空数组')
      }
      for (const id of recordIds) {
        if (typeof id !== 'string' || id.length === 0) {
          throw new V3ContractViolation('v3 store: revokeForget 的每个 id 必须是非空字符串')
        }
      }
      return withCrossProcessWriteLock(dir, async (ownership) => {
        await store.syncFromLog()
        const committed = new Set(await store.listRecordIds())
        const purged = new Set(typeof store.listPurged === 'function' ? store.listPurged() : [])
        const purgedHit = recordIds.filter((id) => purged.has(id))
        if (purgedHit.length > 0) {
          throw v3Error('ESTORE_TXN_CONFLICT', '记录已被物理清除（forget purge），不可撤销：' + purgedHit.join('、'))
        }
        const missing = recordIds.filter((id) => !committed.has(id))
        if (missing.length > 0) {
          throw v3Error('ESTORE_TXN_CONFLICT', '撤销遗忘目标不存在或未提交（整批拒绝）：' + missing.join('、'))
        }
        ownership.assertOwned() // R3-03
        try {
          for (const id of recordIds) await store.revokeForget(id)
        } finally {
          await rebuildIndex()
        }
        const index = await readLexicalIndex(store)
        return { forgottenCount: store.listForgotten().length, indexedCount: index?.indexedCount ?? 0 }
      })
    },

    /** 列已遗忘 ID（状态面/forget status）。 */
    listForgotten() {
      return store.listForgotten()
    },

    /**
     * 已提交记录数：同步、零 I/O、不读词法索引。
     *
     * 与 health() 的分工：health() 要读二十几 MB 的索引文件（观察面偶尔读一次没问题），
     * 而 composer 状态条会在每个事件后被 view 读一次——这条路径不能背索引解析。
     * 端口方法面（PORT_METHODS）不强制它：测试替身可以缺席，调用方回落 health()。
     */
    recordCount() {
      const base = store.health()
      return Number.isInteger(base?.recordCount) && base.recordCount >= 0 ? base.recordCount : null
    },

    async health() {
      const base = store.health()
      // T-07（0.15.4）：派生索引损坏**不得**把整个库判成坏库。
      //
      // 缺陷：旧实现让 `readLexicalIndex` 的 ESTORE_CORRUPT 直接冒出 health()。
      // 后果是观察面把「索引这个可删可建的缓存坏了」显示成「库坏了」，
      // 而 `/memory-lab on` 路径里任何 health 调用都会因此整体失败——
      // 用户被一个**删掉就能重建**的派生文件挡在门外，还以为是数据损坏。
      //
      // 现在：索引读失败只影响索引面（indexedCount/indexStale/indexDamaged），
      // 账本面的 healthy 保持不动；命令面据 indexDamaged 提示「可重建」。
      let index = null
      let indexError = null
      try {
        index = await readLexicalIndex(store)
      } catch (error) {
        indexError = error?.code ?? error?.message ?? String(error)
      }
      if (indexError !== null) {
        return { ...base, indexedCount: 0, indexStale: true, indexDamaged: true, indexError }
      }
      // 新鲜度只有一把尺子（isIndexStale）：health 与检索入口不得各算一遍（H-03）
      return { ...base, indexedCount: index?.indexedCount ?? 0, indexStale: await isIndexStale(store, index), indexDamaged: false, indexError: null }
    },

    async rebuildIndex() {
      return rebuildIndexSafely()
    },

    /** M-04（0.15.4）：增量并入索引；不可信时返回 applied:false，调用方退回全量重建。 */
    async updateIndexIncrementally(plan) {
      return updateIndexIncrementally(plan)
    },

    /** 日志尾部半行修复（/memory-lab repair）：dryRun 只报告，不写任何字节。 */
    async repairJournals(options = {}) {
      return repairSessionJournals(dir, options)
    },

    /** T-10（0.15.4）：purged.jsonl 中段损坏时的显式人工出口（默认 dryRun）。 */
    async rebuildPurged(options = {}) {
      return rebuildPurgedLedger(dir, options)
    },

    /** 关闭底层句柄（composition.dispose 用；端口方法面之外，测试替身可缺席）。 */
    close() {
      store.close()
    },

    listVouchers() {
      return store.listVouchers()
    },

    /**
     * D-C：隐私面清除标记（history 用；旧测试替身可缺席）。
     *
     * T-03（0.15.4，P1）：**必须按戳刷新后读**。旧实现直接返回本句柄打开期的内存集合，
     * 于是别的句柄/进程清除一张回执后，本句柄仍认为它未清除 → 导出把已声明清除的
     * 回执正文原样带出（计划 §7.4「forget 级联无自有出口泄露」）。
     * 刷新未变化时只有一次 stat；有变化才重解析。
     */
    async redactedVoucherIds() {
      if (typeof store.redactedVoucherIdsFresh === 'function') return store.redactedVoucherIdsFresh()
      return typeof store.redactedVoucherIds === 'function' ? store.redactedVoucherIds() : []
    },

    async markVoucherRedacted(voucherId, redacted, options = {}) {
      if (typeof store.markVoucherRedacted !== 'function') return { changed: false }
      // B3-7：隐私面清除标记同样进写锁（所有写原语一个锁的纪律）。
      // P1-08：options（`{seq}`）必须透传——端口漏传会让「清除时落新节点 seq」静默失效，
      // undo 只能退回正文扫描（多段错位的根因）。
      return withCrossProcessWriteLock(dir, (ownership) => {
        ownership.assertOwned() // R3-03：失锁后拒绝改隐私标记
        return store.markVoucherRedacted(voucherId, redacted, options)
      })
    },

    /** P1-08：已清除回执的节点 seq（老账本/测试替身缺席时返回 null）。 */
    redactionSeqOf(voucherId) {
      return typeof store.redactionSeqOf === 'function' ? store.redactionSeqOf(voucherId) : null
    },

    /**
     * A-01（0.15.4）：记录 restore 落下的恢复节点 seq。
     *
     * 与 `markVoucherRedacted` 同纪律——所有写原语一个锁；端口缺席时降级为
     * `{changed:false}`（应用层据此走旧路径，不会崩）。
     */
    async markVoucherRestoredSeq(voucherId, seq, textHash = null) {
      if (typeof store.markVoucherRestoredSeq !== 'function') return { changed: false }
      return withCrossProcessWriteLock(dir, (ownership) => {
        ownership.assertOwned()
        return store.markVoucherRestoredSeq(voucherId, seq, textHash)
      })
    },

    /** A-01：读回恢复节点 seq（老账本/测试替身缺席时返回 null）。 */
    restoredSeqOf(voucherId) {
      return typeof store.restoredSeqOf === 'function' ? store.restoredSeqOf(voucherId) : null
    },

    /** A-01：读回恢复正文指纹（失败关闭判据；缺席返回 null）。 */
    restoredTextHashOf(voucherId) {
      return typeof store.restoredTextHashOf === 'function' ? store.restoredTextHashOf(voucherId) : null
    },

    /** P1-07：孤儿回执（补凭证放弃后的恢复线索）。写进同一把会话写锁。 */
    async appendOrphanReceipt(row) {
      if (typeof store.appendOrphanReceipt !== 'function') {
        throw new V3ContractViolation('v3 store: 实现缺 appendOrphanReceipt')
      }
      return withCrossProcessWriteLock(dir, (ownership) => {
        ownership.assertOwned()
        return store.appendOrphanReceipt(row)
      })
    },

    /** P1-07：列孤儿回执；测试替身缺席时按空（不影响既有归档路径）。 */
    listOrphanReceipts() {
      return typeof store.listOrphanReceipts === 'function' ? store.listOrphanReceipts() : []
    },

    // 会话目录只读暴露（usage 聚合落盘/观察面 stats 用；不承诺更多）
    directory: dir,
  }

  return { port: assertPort('SessionStore', impl), store }
}
