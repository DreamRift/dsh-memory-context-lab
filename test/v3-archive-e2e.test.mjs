/**
 * 历史归档端到端（M2）：
 * - 真实 composition/runtime + 假 DSH session（surface fold）；
 * - 只归档已完成的第一个操作（当前回合/后续回合不动）；
 * - 回执落面、voucher 可列、restore 回原文、失败不推进。
 */
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createV3Runtime } from '../src/v3/composition/composition.mjs'
import { createArchiveService } from '../src/v3/application/archive.mjs'
import { createFakeSession } from './helpers/fake-session.mjs'
import { seqOfDshEventId } from '../src/v3/adapters/host/dsh-host.mjs'
import { readArchiveIntent, writeArchiveIntent, clearArchiveIntentIfMatches } from '../src/v3/adapters/storage/archive-intent.mjs'
import { textOfDshEvent } from '../src/v3/entry/v3-entry.mjs'
import { normalizeSchedulePolicyConfig } from '../src/v3/contracts/archive-schedule-policy.mjs'

async function ingest(session, runtime) {
  const rows = session.log.map((event) => ({ event, text: textOfDshEvent(event), meta: {} }))
  await runtime.handleDshEventBatch(rows)
}

async function seqMapOf(store) {
  const map = new Map()
  for (const recordId of await store.listRecordIds()) {
    const provenance = await store.readProvenance(recordId)
    const seq = seqOfDshEventId(provenance?.sourceEventId)
    if (seq !== null) map.set(seq, recordId)
  }
  return map
}

test('archive e2e：只归档已完成操作、回执落面、restore 回原文', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-archive-'))
  const session = createFakeSession({ cwd: 'C:\\ws', contextWindow: 100000 })
  session.pushUser('第一问'.repeat(60))
  session.pushAssistant('第一答'.repeat(60))
  session.pushUser('第二问'.repeat(60))
  session.pushAssistant('第二答'.repeat(60))
  session.pushUser('当前问题'.repeat(10))
  const runtime = await createV3Runtime({ v3Root: root, dshSession: session, sessionKey: 's-archive' })
  try {
    await ingest(session, runtime)
    const originalLog = structuredClone(session.log)
    const archive = createArchiveService({ random: { uuid: () => randomUUID() }, store: runtime.store, host: runtime.host, clock: { now: () => 1 }, v3Root: root })
    const seqToRecordId = await seqMapOf(runtime.store)
    assert.equal(seqToRecordId.size, 5)

    const result = await archive.archiveOnce({
      sessionId: 's-archive',
      events: session.log,
      surfaceNodes: await runtime.host.surfaceNodes(),
      seqToRecordId,
      mode: 'full-history',
      maxOperations: 1,
    })
    assert.equal(result.status, 'archived', JSON.stringify(result))
    assert.equal(result.startSeq, 0)
    assert.equal(result.endSeq, 1, '只归档第一个完成操作')
    assert.equal(result.recordIds.length, 2)
    assert.ok(result.receiptText.includes('已把 2 条'))
    assert.match(result.receiptText, /摘要：用户：第一问/)
    const nodes = await runtime.host.surfaceNodes()
    assert.deepEqual(nodes, [5, 2, 3, 4], '回执插在原位置，后续节点保留')
    assert.equal(session.log.length, originalLog.length + 1, '宿主以追加一条回执事件表达 surface 替换')
    assert.deepEqual(session.log.slice(0, originalLog.length), originalLog, '归档不改写或删除 append-only session log 中的原事件')
    assert.equal(session.log.at(-1)?.data?.content?.[0]?.text, result.receiptText)
    assert.equal(await runtime.host.surfaceTextAt(5), result.receiptText)

    const vouchers = await runtime.store.listVouchers()
    assert.equal(vouchers.length, 1)
    assert.equal(vouchers[0].targetEventId, 5)
    assert.deepEqual(vouchers[0].sourceEventSeqs, [0, 1])
    assert.deepEqual(vouchers[0].recordIds, result.recordIds)

    const restored = await archive.restoreVoucher(0)
    assert.equal(restored.restored, true, JSON.stringify(restored))
    const after = await runtime.host.surfaceNodes()
    assert.equal(after.length, 4)
    const restoredText = await runtime.host.surfaceTextAt(after[0])
    const originalArchivedText = '第一问'.repeat(60) + '\n\n' + '第一答'.repeat(60)
    assert.ok(restoredText.includes(originalArchivedText), '恢复必须完整、按序包含归档原文（来源标记除外）')
    assert.doesNotMatch(restoredText, /第二问/, '后续未归档回合不得被恢复文本吞入')
  } finally {
    runtime.close()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})

test('archive e2e：当前回合/无记录节点不归档；dry-run 不写', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-archive-'))
  const session = createFakeSession()
  session.pushUser('唯一一问')
  session.pushAssistant('唯一一答')
  const runtime = await createV3Runtime({ v3Root: root, dshSession: session, sessionKey: 's-archive' })
  try {
    await ingest(session, runtime)
    const archive = createArchiveService({ random: { uuid: () => randomUUID() }, store: runtime.store, host: runtime.host, clock: { now: () => 1 }, v3Root: root })
    const seqToRecordId = await seqMapOf(runtime.store)
    const dry = await archive.dryRun({
      sessionId: 's-archive', events: session.log, surfaceNodes: await runtime.host.surfaceNodes(), seqToRecordId, mode: 'full-history',
    })
    assert.equal(dry.status, 'no-candidate')
    assert.deepEqual(await runtime.host.surfaceNodes(), [0, 1], 'dry-run 不写 surface')
    assert.equal((await runtime.store.listVouchers()).length, 0)
  } finally {
    runtime.close()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})
/**
 * 审计 C-A（beta.46 排查）：surface replace 的失败不一定等于「surface 没变」。
 * dsh-host 的 surfaceOp 先 appendReceipt、再校验 eventAt/被遮蔽节点，失败时抛错——
 * 此时活动面已有回执、凭证还没写。旧实现把这个 catch 当成「没变」并清掉 intent，
 * 于是回执永远没有凭证（history=0），连对账线索也没了。修法：保留 intent。
 */
test('commit 表面失败（宿主 append 后抛错）保留 intent，恢复面对账补 voucher', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-archive-intent-'))
  const session = createFakeSession({ cwd: 'C:\\ws', contextWindow: 100000 })
  session.pushUser('第一问'.repeat(60))
  session.pushAssistant('第一答'.repeat(60))
  session.pushUser('第二问'.repeat(60))
  session.pushAssistant('第二答'.repeat(60))
  session.pushUser('当前问题'.repeat(10))
  const runtime = await createV3Runtime({ v3Root: root, dshSession: session, sessionKey: 's-intent' })
  try {
    await ingest(session, runtime)
    const journal = {
      write: (data) => writeArchiveIntent(root, 's-intent', data),
      read: () => readArchiveIntent(root, 's-intent'),
      clear: (expected) => clearArchiveIntentIfMatches(root, 's-intent', expected),
    }
    // 宿主行为：replace 已经生效，随后确认面失败 → 抛错（真实 dsh-host 的失败路径之一）。
    const hostAfterAppendFailure = {
      ...runtime.host,
      surfaceOp: async (args) => {
        await runtime.host.surfaceOp(args)
        throw new Error('模拟宿主确认面失败（append 已生效）')
      },
    }
    const archive = createArchiveService({ random: { uuid: () => randomUUID() }, store: runtime.store, host: hostAfterAppendFailure, clock: { now: () => 1 }, intent: journal })
    const seqToRecordId = await seqMapOf(runtime.store)
    const result = await archive.archiveOnce({
      sessionId: 's-intent', events: session.log, surfaceNodes: await runtime.host.surfaceNodes(), seqToRecordId, mode: 'full-history', maxOperations: 1,
    })
    assert.equal(result.status, 'failed', JSON.stringify(result))
    assert.equal(result.phase, 'surface')
    assert.equal(result.intentKept, true, 'surface 失败必须保留 intent（不得假设 surface 没变）')
    assert.equal((await runtime.store.listVouchers()).length, 0, '凭证还没写')
    const nodes = await runtime.host.surfaceNodes()
    assert.notDeepEqual(nodes, [0, 1, 2, 3, 4], '宿主已把 span 替换成回执')
    const retained = await readArchiveIntent(root, 's-intent')
    assert.equal(retained?.receiptText, result.span.receiptText, 'intent 必须能定位那条回执')
    const recovered = await archive.recoverIntent({
      sessionId: 's-intent', surfaceNodes: nodes, surfaceTextOf: (seq) => runtime.host.surfaceTextAt(seq),
    })
    assert.equal(recovered.recovered, true, JSON.stringify(recovered))
    assert.equal((await runtime.store.listVouchers()).length, 1, '对账必须补上凭证，回执才可恢复')
    assert.equal(await readArchiveIntent(root, 's-intent'), null, '补成功后清 intent')
    assert.equal((await archive.history()).total, 1)
  } finally {
    runtime.close()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})

/**
 * 审计 C-C：崩溃窗口「voucher 已追加、intent 未清」会重新进入 recoverIntent。
 * 旧实现无条件再追加一条同 ID 凭证（v-9 / v-9），history 与 restoreAll 的下标全部失真。
 */
test('崩溃窗口：voucher 已追加、intent 未清 → 恢复不产生重复凭证', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-archive-dup-'))
  const session = createFakeSession()
  const runtime = await createV3Runtime({ v3Root: root, dshSession: session, sessionKey: 's-dup' })
  try {
    const journal = {
      write: (data) => writeArchiveIntent(root, 's-dup', data),
      read: () => readArchiveIntent(root, 's-dup'),
      clear: (expected) => clearArchiveIntentIfMatches(root, 's-dup', expected),
    }
    const receiptText = '[记忆上下文] 已把 2 条已完成历史（seq 0–1）归档为可恢复回执。'
    await journal.write({ schemaVersion: 1, sessionId: 's-dup', startSeq: 0, endSeq: 1, sourceEventSeqs: [0, 1], recordIds: [], receiptText, createdAt: 1 })
    await runtime.store.appendVoucher({ schemaVersion: 2, voucherId: 'v-9', kind: 'span', recordIds: [], sourceEventSeqs: [0, 1], startSeq: 0, endSeq: 1, targetEventId: 9, receiptText, txn: 5 })
    const host = { async surfaceNodes() { return [9] }, async surfaceTextAt() { return receiptText }, async surfaceOp() { return { seq: 10 } } }
    const archive = createArchiveService({ random: { uuid: () => randomUUID() }, store: runtime.store, host, clock: { now: () => 1 }, intent: journal })
    const recovered = await archive.recoverIntent({ sessionId: 's-dup', surfaceNodes: [9], surfaceTextOf: async () => receiptText })
    assert.equal(recovered.recovered, true, JSON.stringify(recovered))
    assert.equal(recovered.duplicateSkipped, true)
    assert.equal((await runtime.store.listVouchers()).length, 1, '同 ID 凭证不得重复追加')
    assert.equal(await readArchiveIntent(root, 's-dup'), null)
  } finally {
    runtime.close()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})
/**
 * C-D / C-E（0.14.0-beta.48）：崩溃恢复必须按 intent 的模式分流，并沿用 intent 的事务号。
 * 旧实现无条件写回合级 lastArchiveEndSeq（按步归档也写，切回按轮后早于该 seq 的回合被跳过），
 * 恢复凭证还硬编码 txn:1（与真实事务号脱节，按 txn 回溯对不上）。
 */
test('崩溃恢复：intent.mode=cooling 时不写回合位点；凭证沿用 intent.txn', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-archive-mode-'))
  const session = createFakeSession()
  const runtime = await createV3Runtime({ v3Root: root, dshSession: session, sessionKey: 's-mode' })
  try {
    const journal = {
      write: (data) => writeArchiveIntent(root, 's-mode', data),
      read: () => readArchiveIntent(root, 's-mode'),
      clear: (expected) => clearArchiveIntentIfMatches(root, 's-mode', expected),
    }
    const receiptText = '[记忆上下文] 已把 2 条已完成历史（seq 0–1）归档为可恢复回执。'
    await journal.write({
      schemaVersion: 1, sessionId: 's-mode', mode: 'cooling', txn: 7,
      startSeq: 0, endSeq: 1, sourceEventSeqs: [0, 1], recordIds: [], receiptText, createdAt: 1,
    })
    const host = {
      async surfaceNodes() { return [9] },
      async surfaceTextAt() { return receiptText },
      async surfaceOp() { return { seq: 10 } },
    }
    const archive = createArchiveService({ random: { uuid: () => randomUUID() }, store: runtime.store, host, clock: { now: () => 1 }, intent: journal })
    const recovered = await archive.recoverIntent({ sessionId: 's-mode', surfaceNodes: [9], surfaceTextOf: async () => receiptText })
    assert.equal(recovered.recovered, true, JSON.stringify(recovered))
    assert.equal(recovered.mode, 'cooling', '恢复结果必须带出模式，供入口决定写哪个位点')
    const voucher = (await runtime.store.listVouchers())[0]
    assert.equal(voucher.txn, 7, '凭证事务号必须沿用 intent.txn（不再硬编码 1）')
    assert.equal(await readArchiveIntent(root, 's-mode'), null)
  } finally {
    runtime.close()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})

/**
 * P4（0.15.0）：commitPrepared 的摘要引用与提案身份必须随 intent 落盘，崩溃补账原样搬运。
 * 旧实现丢了 commitPrepared 本体与这两个字段（集成回归），补出来的凭证 history.summaryId
 * 恒为 null、提案永远停在 accepted——摘要正文本身不可变，补账不得重跑生成器。
 */
test('崩溃补账：commitPrepared 的 summaryRef/proposalId 随 intent 保留，对账原样补进凭证', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-archive-summaryref-'))
  const session = createFakeSession()
  const runtime = await createV3Runtime({ v3Root: root, dshSession: session, sessionKey: 's-ref' })
  try {
    const journal = {
      write: (data) => writeArchiveIntent(root, 's-ref', data),
      read: () => readArchiveIntent(root, 's-ref'),
      clear: (expected) => clearArchiveIntentIfMatches(root, 's-ref', expected),
    }
    const receiptText = '[记忆上下文] 已把 2 条已完成历史（seq 0–1）归档为可恢复回执。'
    const summaryRef = {
      summaryId: 'v3s-0123456789abcdef',
      hash: 'a'.repeat(64),
      sourceSetFingerprint: 'b'.repeat(64),
    }
    const proposalId = 'v3p-0123456789abcdef'
    // 宿主「append 已生效、确认面失败」：intent 留下，补账走 recoverIntent。
    const failingHost = {
      async surfaceOp() { throw new Error('模拟宿主确认面失败（append 已生效）') },
    }
    const archive = createArchiveService({ random: { uuid: () => randomUUID() }, store: runtime.store, host: failingHost, clock: { now: () => 1 }, intent: journal })
    const committed = await archive.commitPrepared({
      sessionId: 's-ref',
      plan: {
        startSeq: 0,
        endSeq: 1,
        sourceEventSeqs: [0, 1],
        recordIds: ['v3r-0123456789abcdef'],
        receiptText,
        summaryText: '摘要',
        sourceChars: 100,
        restoreChars: 5,
      },
      txn: 3,
      summaryRef,
      proposalId,
    })
    assert.equal(committed.status, 'failed', JSON.stringify(committed))
    assert.equal(committed.phase, 'surface')
    const retained = await readArchiveIntent(root, 's-ref')
    assert.deepEqual(retained?.summaryRef, summaryRef, '摘要引用必须随 intent 落盘')
    assert.equal(retained?.proposalId, proposalId)

    const recovered = await archive.recoverIntent({ sessionId: 's-ref', surfaceNodes: [9], surfaceTextOf: async () => receiptText })
    assert.equal(recovered.recovered, true, JSON.stringify(recovered))
    const voucher = (await runtime.store.listVouchers())[0]
    assert.deepEqual(voucher.summaryRef, summaryRef, '摘要引用必须原字节搬运（不重跑生成器）')
    assert.equal(voucher.summaryId, summaryRef.summaryId)
    assert.equal(voucher.proposalId, proposalId, '提案身份必须随凭证落账，入口才能标 committed')
    assert.equal(voucher.txn, 3)
    assert.equal((await archive.history()).rows[0].summaryId, summaryRef.summaryId, 'history 必须读得到摘要引用')
    assert.equal(await readArchiveIntent(root, 's-ref'), null)
  } finally {
    runtime.close()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})
/**
 * G5（0.15.0 候选，默认关闭）：按步批量闸门可以多出一道**显式策略**检查，但
 * - 回合级路径不消费它（`policy` 不在 plan 的参数面里，结果不带 policy 键）；
 * - 端口拿不到可信 `messages.count`（旧行/未接线）→ **回退原策略**并说明原因，归档照常。
 */
test('G5：回合级路径不消费策略；按步闸门的策略输入缺失时回退原策略并照常归档', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-archive-g5-'))
  const session = createFakeSession({ cwd: 'C:\\ws', contextWindow: 1000000 })
  session.pushContextWindow(1000000)
  session.pushUser('开始'.repeat(30))
  for (let index = 1; index <= 12; index += 1) {
    session.append('step/start', { turn: 1, step: index })
    session.pushAssistant(('第 ' + index + ' 步数据 ').repeat(120))
    session.append('step/end', { turn: 1, step: index })
  }
  const runtime = await createV3Runtime({ v3Root: root, dshSession: session, sessionKey: 's-g5-e2e' })
  try {
    await ingest(session, runtime)
    const archive = createArchiveService({ random: { uuid: () => randomUUID() }, store: runtime.store, host: runtime.host, clock: { now: () => 1 } })
    const seqToRecordId = await seqMapOf(runtime.store)
    const args = {
      sessionId: 's-g5-e2e', events: session.log, surfaceNodes: await runtime.host.surfaceNodes(),
      seqToRecordId, retainSteps: 1, batchSteps: 10,
    }
    // 回合级：policy 不在它的参数面里 → 结果不带 policy（行为不变）
    const turnPlan = await archive.plan({ ...args, mode: 'full-history', maxOperations: 1, policy: { config: { enabled: true } } })
    assert.equal('policy' in turnPlan, false, '回合级路径不消费按步批量闸门的策略')

    const config = { enabled: true, minGrowthMessages: 5, minRequestGap: 3 }
    const fingerprint = normalizeSchedulePolicyConfig(config).fingerprint
    const fallbackPolicy = {
      config,
      state: { contractVersion: 1, attemptOrdinal: 9, lastCommit: { attemptOrdinal: 5, messagesCount: 100, configFingerprint: fingerprint } },
      input: { components: { messages: { count: null } } },
    }
    // 按步：off 计划 → 端口无可信计数 → 回退原策略（不是"不归档"）
    const offPlanned = await archive.planSteps(args)
    assert.equal(offPlanned.status, 'planned', JSON.stringify(offPlanned))
    const fallbackPlanned = await archive.planSteps({ ...args, policy: fallbackPolicy })
    assert.equal(fallbackPlanned.status, 'planned')
    assert.equal(fallbackPlanned.policy.reason, 'policy-input-unavailable')
    assert.equal(fallbackPlanned.policy.decision, 'allow')
    const { policy: fallbackTrace, ...fallbackRest } = fallbackPlanned
    assert.deepEqual(fallbackRest, offPlanned, '回退原策略时，除 policy 轨迹外结果必须与 off 完全相同')

    const archived = await archive.archiveStepBatch({ ...args, policy: fallbackPolicy })
    assert.equal(archived.status, 'archived', JSON.stringify(archived))
    assert.equal(archived.policy.reason, 'policy-input-unavailable')
    assert.equal(archived.policy.nextState.lastCommit.messagesCount, null, '没有可信计数就记 null（未知，不是 0）')
    assert.equal((await runtime.store.listVouchers()).length, archived.committedCount)
  } finally {
    runtime.close()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})
