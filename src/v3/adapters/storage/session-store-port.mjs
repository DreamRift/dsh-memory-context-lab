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
import { restoreEligibilityOf } from '../../domain/archive/restore.mjs'
import { openV3SessionStore } from './session-store.mjs'
import { withWriteLock } from './write-lock.mjs'
import { buildLexicalIndex, readLexicalIndex, writeLexicalIndex } from './lexical-index.mjs'

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
    const ids = (await store.listRecordIds()).filter((id) => !forgotten.has(id))
    const entries = []
    let metaOnlySkipped = 0
    for (const id of ids) {
      const record = await store.readRecord(id)
      // metadata-only 不进全文检索（P1 摄入合同 4.1.5）：可回读、可对账，不占检索位
      if (record.payload?.metaOnly === true) { metaOnlySkipped += 1; continue }
      entries.push({ id, text: record.payload.text })
    }
    const index = buildLexicalIndex(entries)
    await writeLexicalIndex(store, index)
    return index
  }

  const impl = {
    /** 单笔事务：锁内提交，提交后重建索引（遗忘记录不入索引）。 */
    async transaction(records, { at } = {}) {
      return withWriteLock(dir, async () => {
        const txn = await store.submitTransaction(records, { at })
        return txn
      })
    },

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

    /** 批量遗忘：幂等；锁内执行；遗忘后重建索引（检索面立即不可见）。 */
    async forget(recordIds) {
      return withWriteLock(dir, async () => {
        for (const id of recordIds) await store.forget(id)
        const index = await rebuildIndex()
        return { forgottenCount: store.listForgotten().length, indexedCount: index.indexedCount }
      })
    },

    async health() {
      const base = store.health()
      const index = await readLexicalIndex(store)
      const forgotten = new Set(store.listForgotten())
      const committed = (await store.listRecordIds()).length - forgotten.size
      return { ...base, indexedCount: index?.indexedCount ?? 0, indexStale: index === null || index.indexedCount !== committed }
    },

    async rebuildIndex() {
      return withWriteLock(dir, () => rebuildIndex())
    },

    listVouchers() {
      return store.listVouchers()
    },

    // 会话目录只读暴露（usage 聚合落盘/观察面 stats 用；不承诺更多）
    directory: dir,
  }

  return { port: assertPort('SessionStore', impl), store }
}
