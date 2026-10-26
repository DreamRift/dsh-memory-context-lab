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
import { openV3SessionStore } from './session-store.mjs'
import { withCrossProcessWriteLock, withWriteLock } from './write-lock.mjs'
import { buildLexicalIndex, isIndexStale, readLexicalIndex, writeLexicalIndex } from './lexical-index.mjs'

/**
 * 打开并装配 SessionStore 端口。
 * @param {string} root v3 数据根
 * @param {string} sessionKey 会话隔离键
 */
export async function createSessionStorePort(root, sessionKey) {
  const store = await openV3SessionStore(root, sessionKey)
  const dir = store.directory

  async function rebuildIndex() {
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
    await writeLexicalIndex(store, index)
    return index
  }

  // 来源事件 ID 缓存：进程内惰性构建，任何写操作后失效（H-01：断点必须能从库反推）
  let sourceEventCache = null
  let sourceEventFailure = null

  async function sourceEventIds() {
    if (sourceEventFailure !== null) throw sourceEventFailure
    if (sourceEventCache !== null) return [...sourceEventCache]
    const out = new Set()
    for (const id of await store.listRecordIds()) {
      // 含已遗忘记录：遗忘是「不可见」，不是「从未摄入」。按可读集反推会让断点回退，
      // 重放时把已遗忘正文重新落成新记录（H-02 隐私回退）。这里只取 provenance，不读正文。
      let provenance
      try {
        provenance = await store.readProvenance(id)
      } catch (error) {
        // 读不到 ≠ 没有（fail-closed）：派生物不得掩盖损坏，否则断点会静默回退到 -1
        sourceEventFailure = error
        throw error
      }
      const sourceEventId = provenance?.sourceEventId
      if (typeof sourceEventId === 'string' && sourceEventId.length > 0) out.add(sourceEventId)
    }
    sourceEventCache = out
    return [...out]
  }

  const impl = {
    /** 单笔事务：锁内提交，提交后重建索引（遗忘记录不入索引）。 */
    async transaction(records, { at } = {}) {
      const txn = await withCrossProcessWriteLock(dir, async () => {
      await store.syncFromLog() // H-10-b：锁内增量视图同步，多句柄/多进程提交不漏
        const committed = await store.submitTransaction(records, { at })
        return committed
      })
      sourceEventCache = null
      return txn
    },

    /** 已提交记录的来源事件 ID 清单（摄入断点反推用；派生物，写后失效）。 */
    sourceEventIds,

    async readRecord(id) {
      return store.readRecord(id)
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
      return withCrossProcessWriteLock(dir, async () => {
      await store.syncFromLog() // H-10-b：锁内增量视图同步，多句柄/多进程提交不漏
        // 预检：全部 id 必须已提交（幂等允许「已遗忘」，但**不允许**「从未提交」）
        const committed = new Set(await store.listRecordIds())
        const missing = recordIds.filter((id) => !committed.has(id))
        if (missing.length > 0) {
          throw v3Error('ESTORE_TXN_CONFLICT', 'forget 目标不存在或未提交（整批拒绝，一条都未遗忘）：' + missing.join('、'))
        }
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

    async health() {
      const base = store.health()
      const index = await readLexicalIndex(store)
      // 新鲜度只有一把尺子（isIndexStale）：health 与检索入口不得各算一遍（H-03）
      return { ...base, indexedCount: index?.indexedCount ?? 0, indexStale: await isIndexStale(store, index) }
    },

    async rebuildIndex() {
      return withCrossProcessWriteLock(dir, async () => { await store.syncFromLog(); return rebuildIndex() })
    },

    listVouchers() {
      return store.listVouchers()
    },

    // 会话目录只读暴露（usage 聚合落盘/观察面 stats 用；不承诺更多）
    directory: dir,
  }

  return { port: assertPort('SessionStore', impl), store }
}
