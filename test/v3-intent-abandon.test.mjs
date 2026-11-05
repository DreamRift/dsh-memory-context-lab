/**
 * P1-07（0.15.1）：证书补账失败**无上界** → 该段永久不可恢复 + 该会话归档全停。
 *
 * ## 缺陷
 * `commitPlanned` 在 `appendVoucher` 失败时保留 intent；`recoverIntent` 每次对账失败都
 * 返回 `kept:true`，没有任何计数或时限。于是磁盘满 / `vouchers.jsonl` 中段损坏这种
 * **持续性**失败会让：
 * 1. 该段原文**永远没有凭证** → `/memory-lab restore` 找不到它（数据事实不可用）；
 * 2. intent 永远占着槽位 → 入口对每次归档返回 `intent-pending`，**该会话的新归档全停**。
 * 旧行为只能靠人工删 `archive-intent.json` 才恢复，而删了连恢复线索也一起丢。
 *
 * ## 判据来源
 * docs/dev-0.15.1/记忆上下文-0.15.1-独立排查报告.md §1★4 / §3.1 P1-07；用户裁定
 * （2026-11-04）：全部按顺序修、根因修复；放弃必须「可见 + 可恢复」，不能静默丢段。
 *
 * ## 修法
 * - intent 累计 `attempts` 与 `firstFailedAt`（随 intent 落盘，跨 pre-step/重启可见）；
 * - 未到阈值（默认 5 次 / 6 小时，可注入）→ 保留并重试，返回值带 `attempts`/`retryAt`；
 * - 到阈值 → **先**把回执正文 + recordIds 落进独立的 `orphan-receipts.jsonl`（与
 *   vouchers.jsonl 分开——后者正是失败源头），**再**按身份清槽；`restoreAll` 把孤儿回执
 *   当作可恢复段处理；
 * - 孤儿账本写失败 → **不放弃**（继续挡，不丢线索）。
 *
 * ## 断言组
 * 1. 未到阈值：kept:true、intent 的 attempts 递增并落盘、孤儿账本为空；
 * 2. 到阈值：abandoned:true、intent 已清、孤儿行含 receiptText/recordIds、槽位可再次占；
 * 3. 放弃后 restoreAll 能恢复该段原文（落面为带来源标记的恢复正文）；
 * 4. 孤儿账本写失败：不放弃、intent 仍在、`abandonFailed` 如实上报。
 *
 * ## 不适用条件与已知边界
 * - 阈值是运维口径（次数/时限），不是安全边界：放弃后原文本仍可恢复（孤儿账本），
 *   不存在静默丢数据；
 * - 孤儿回执不自动清理：重复 restore 会因「回执正文已不在活动面」失败关闭（幂等可见）；
 * - 多段同时放弃时按 receiptSeq（surface 节点 seq）独立成行，id = `o-<seq>`。
 *
 * ## 定点变异自证
 * 把 `giveUp` 恒置 false（退回无界重试）→ 组 2/3 红；跳过孤儿记账直接清槽 → 组 2/3 红
 * （restore 少一段）；孤儿账本抛错仍清槽 → 组 4 红。读数见台账 R1/R2。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createArchiveService } from '../src/v3/application/archive.mjs'
import { createSessionStorePort } from '../src/v3/adapters/storage/session-store-port.mjs'
import { clearArchiveIntentIfMatches, readArchiveIntent, reserveArchiveIntent, writeArchiveIntent } from '../src/v3/adapters/storage/archive-intent.mjs'
import { createFakeSession } from './helpers/fake-session.mjs'

const SESSION = 's-p107'

function hostOf(session) {
  return {
    async surfaceNodes() { return [...session.surface.nodes] },
    async surfaceTextAt(seq) { return session.textOf(seq) },
    async surfaceOp(op) {
      if (op?.op !== 'replace') throw new Error('fake host: 只支持 replace')
      // 归档用区间形态（startSeq/endSeq + sourceEventSeqs），恢复用单节点形态（targetEventId）。
      const start = Number.isInteger(op.targetEventId) ? op.targetEventId : op.startSeq
      const end = Number.isInteger(op.targetEventId) ? op.targetEventId : op.endSeq
      if (!Number.isInteger(start) || !Number.isInteger(end)) throw new Error('fake host: replace 需要区间')
      const sources = Array.isArray(op.sourceEventSeqs) && op.sourceEventSeqs.length > 0 ? op.sourceEventSeqs : [start]
      const { seq } = session.append('user/message', { content: [{ type: 'text', text: op.text }], source: { kind: 'plugin' } }, {
        surfaceOp: { op: 'replace', startSeq: start, endSeq: end },
        sourceEventSeqs: sources,
      })
      return { seq }
    },
  }
}

function archiveOf({ root, store, session, now = () => 1000, abandon = { afterAttempts: 3, afterMs: 60 * 60 * 1000 } }) {
  let counter = 0
  return createArchiveService({
    store,
    host: hostOf(session),
    clock: { now },
    random: { uuid: () => 'intent-' + (counter += 1) },
    abandon,
    intent: {
      write: (data) => writeArchiveIntent(root, SESSION, data),
      read: () => readArchiveIntent(root, SESSION),
      reserve: (data) => reserveArchiveIntent(root, SESSION, data),
      clear: (expected) => clearArchiveIntentIfMatches(root, SESSION, expected),
    },
  })
}

async function setup(abandon) {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-p107-'))
  const { port: store } = await createSessionStorePort(root, SESSION)
  const session = createFakeSession({ id: SESSION })
  session.pushUser('第一段问'.repeat(20))
  session.pushAssistant('第一段答'.repeat(20))
  const txn = await store.transaction([{
    id: 'v3r-' + 'a1'.repeat(8),
    kind: 'message-user',
    sessionKey: SESSION,
    createdAt: 1,
    payload: { text: '原文甲'.repeat(10), bytes: 90 },
    provenance: { sourceEventId: 'evt-a1', sourceForm: 'live', transactionId: 'tx-a1' },
  }])
  const archive = archiveOf({ root, store, session, abandon })
  const plan = {
    startSeq: 0,
    endSeq: 0,
    sourceEventSeqs: [0],
    recordIds: ['v3r-' + 'a1'.repeat(8)],
    receiptText: '回执：一段已归档',
    operations: 1,
    txn: txn.txn,
  }
  return { root, store, session, archive, plan }
}

const reconcile = (archive) => archive.recoverIntent({
  sessionId: SESSION,
  surfaceNodes: undefined,
  surfaceTextOf: undefined,
})

test('P1-07 未到阈值：保留 intent 并让 attempts 落盘（不谎报放弃）', async () => {
  const { root, store, session, archive, plan } = await setup()
  try {
    const original = store.appendVoucher
    store.appendVoucher = async () => { throw Object.assign(new Error('disk full'), { code: 'EIO' }) }
    const committed = await archive.commitPrepared({ sessionId: SESSION, plan, txn: plan.txn })
    assert.equal(committed.status, 'failed')
    assert.equal(committed.phase, 'voucher', JSON.stringify(committed))
    const first = await archive.recoverIntent({ sessionId: SESSION, surfaceNodes: [...session.surface.nodes], surfaceTextOf: (seq) => session.textOf(seq) })
    assert.equal(first.kept, true)
    assert.equal(first.abandoned, undefined)
    assert.equal(first.attempts, 2, 'attempts 必须累加：' + JSON.stringify(first))
    const persisted = await readArchiveIntent(root, SESSION)
    assert.equal(persisted?.attempts, 2, '重试计数必须落盘（跨 pre-step/重启可见）')
    assert.equal(store.listOrphanReceipts().length, 0, '未到阈值不得记孤儿')
    store.appendVoucher = original
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})

test('P1-07 到阈值：放弃 + 孤儿回执落账 + 清槽 + 新归档不再被挡', async () => {
  const { root, store, session, archive, plan } = await setup()
  try {
    const original = store.appendVoucher
    store.appendVoucher = async () => { throw Object.assign(new Error('disk full'), { code: 'EIO' }) }
    const committed = await archive.commitPrepared({ sessionId: SESSION, plan, txn: plan.txn })
    assert.equal(committed.phase, 'voucher')
    const first = await archive.recoverIntent({ sessionId: SESSION, surfaceNodes: [...session.surface.nodes], surfaceTextOf: (seq) => session.textOf(seq) })
    assert.equal(first.kept, true)
    const second = await archive.recoverIntent({ sessionId: SESSION, surfaceNodes: [...session.surface.nodes], surfaceTextOf: (seq) => session.textOf(seq) })
    assert.equal(second.abandoned, true, '第 3 次失败必须放弃：' + JSON.stringify(second))
    assert.equal(second.cleared, true, '放弃必须清掉槽位（否则归档仍全停）')
    assert.match(String(second.orphanId), /^o-\d+$/)
    assert.equal(await readArchiveIntent(root, SESSION), null, 'intent 必须已清')
    const orphans = store.listOrphanReceipts()
    assert.equal(orphans.length, 1)
    assert.equal(orphans[0].receiptText, plan.receiptText)
    assert.deepEqual(orphans[0].recordIds, plan.recordIds)
    assert.equal(orphans[0].attempts, 3)
    assert.equal((await store.listVouchers()).length, 0, '凭证台账仍没有这一段（事实如此）')

    // 槽位已腾出：新归档应能再次走到提交边界（这里仍因 appendVoucher 坏在 voucher 阶段，
    // 但**不是** intent-pending —— 旧实现会一直停在 intent）。
    const nodes = await session.surface.nodes
    const next = await archive.commitPrepared({
      sessionId: SESSION,
      plan: { ...plan, startSeq: nodes[0], endSeq: nodes[0], sourceEventSeqs: [nodes[0]], receiptText: '回执：第二段' },
      txn: plan.txn,
    })
    assert.equal(next.phase, 'voucher', '槽位必须已腾出：' + JSON.stringify(next))
    store.appendVoucher = original
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})

test('P1-07 放弃后 restoreAll 能恢复该段原文（孤儿回执是恢复线索）', async () => {
  const { root, store, session, archive, plan } = await setup()
  try {
    const original = store.appendVoucher
    store.appendVoucher = async () => { throw Object.assign(new Error('disk full'), { code: 'EIO' }) }
    await archive.commitPrepared({ sessionId: SESSION, plan, txn: plan.txn })
    await archive.recoverIntent({ sessionId: SESSION, surfaceNodes: [...session.surface.nodes], surfaceTextOf: (seq) => session.textOf(seq) })
    const abandoned = await archive.recoverIntent({ sessionId: SESSION, surfaceNodes: [...session.surface.nodes], surfaceTextOf: (seq) => session.textOf(seq) })
    assert.equal(abandoned.abandoned, true)
    const restored = await archive.restoreAll()
    assert.equal(restored.orphanTotal, 1, JSON.stringify(restored).slice(0, 300))
    assert.equal(restored.orphanRestored, 1, JSON.stringify(restored.orphans))
    assert.equal(restored.orphanFailed, 0)
    const texts = (await session.surface.nodes).map((seq) => session.textOf(seq))
    assert.ok(texts.some((text) => typeof text === 'string' && text.includes('原文甲')), '原文必须回到活动面：' + JSON.stringify(texts.map((t) => String(t).slice(0, 40))))
    store.appendVoucher = original
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})

test('P1-07 孤儿账本写失败：不放弃、继续保留 intent（宁可挡也不丢线索）', async () => {
  const { root, store, session, archive, plan } = await setup()
  try {
    const originalVoucher = store.appendVoucher
    store.appendVoucher = async () => { throw Object.assign(new Error('disk full'), { code: 'EIO' }) }
    store.appendOrphanReceipt = async () => { throw Object.assign(new Error('no space'), { code: 'ENOSPC' }) }
    await archive.commitPrepared({ sessionId: SESSION, plan, txn: plan.txn })
    await archive.recoverIntent({ sessionId: SESSION, surfaceNodes: [...session.surface.nodes], surfaceTextOf: (seq) => session.textOf(seq) })
    const third = await archive.recoverIntent({ sessionId: SESSION, surfaceNodes: [...session.surface.nodes], surfaceTextOf: (seq) => session.textOf(seq) })
    assert.equal(third.kept, true, '孤儿记账失败时必须继续保留 intent：' + JSON.stringify(third))
    assert.equal(third.abandoned, undefined)
    assert.equal(third.abandonFailed, 'ENOSPC')
    assert.notEqual(await readArchiveIntent(root, SESSION), null, 'intent 不得被清')
    store.appendVoucher = originalVoucher
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})
