/**
 * P4 摘要事务 + 提案安全边界（0.15.0）：
 * - inspect 与 commit 同一 planer/判据：同快照 candidate_id 稳定，inspect 可执行 → 边界提交成功；
 * - submit 只落 accepted（不改活动面），committed 只能由真实凭证确认；
 * - 正常尾部追加仍可提交；相关漂移（forget/相关 pin）才拒绝，且不改面；
 * - 重启后 pending 由台账恢复并重验证；摘要缺失回落确定性摘要但仍归档；
 * - 幂等键同载荷复用、不同载荷拒绝；跨会话提案/摘要不可读。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { join } from 'node:path'

import { attachV3Engine } from '../src/v3/entry/v3-entry.mjs'
import { createCompactService } from '../src/v3/application/compact.mjs'
import { ARCHIVE_POLICY_VERSION } from '../src/v3/domain/archive/plan-fingerprints.mjs'
import { summariesPath } from '../src/v3/adapters/storage/summary-store.mjs'
import { createFakeSession } from './helpers/fake-session.mjs'

function fakeCtx() {
  const handlers = new Map()
  const ctx = {
    on(name, handler) { handlers.set(name, handler); return () => handlers.delete(name) },
    logger: { warn() {}, info() {} },
  }
  ctx.callPreStep = async (session) => {
    const handler = handlers.get('agent/pre-step')
    return await handler({ agent: { session }, signal: undefined }, async () => ({ kind: 'enter' }))
  }
  return ctx
}

async function settle(engine) {
  await new Promise((resolve) => setTimeout(resolve, 150))
  await engine._waitForIdle().catch(() => {})
  await new Promise((resolve) => setTimeout(resolve, 50))
}

function seed(session) {
  session.pushUser('第一问：保留这段文字'.repeat(30))
  session.pushAssistant('第一答：也保留'.repeat(30))
  session.pushUser('当前问题'.repeat(10))
}

const DRAFT = {
  shortText: '定位到查询参数未传递；修正已完成，真实宿主行为待验证。',
  detail: '详细摘要：定位到查询参数未传递，修正已完成。未完：核验取消与重试。',
  goal: '修复参数未传递',
  outcome: 'partial',
  decisions: ['先修参数'],
  openItems: ['核验取消与重试'],
  evidenceRefs: [],
}

async function mount(root) {
  const ctx = fakeCtx()
  const engine = attachV3Engine(ctx, { v3Root: root })
  return { ctx, engine }
}

test('inspect→prepare→submit 不改面；accepted 不冒充完成；尾部追加后边界提交成功且回执带摘要', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-p4-happy-'))
  const { ctx, engine } = await mount(root)
  try {
    const session = createFakeSession({ id: 'session-p4' })
    seed(session)
    await ctx.callPreStep(session)
    await settle(engine)

    const surfaceBefore = [...session.surface.nodes]
    const inspected = await engine.inspectCompact(session.id, session)
    assert.equal(inspected.status, 'ok')
    assert.equal(inspected.executable, true)
    const inspectedAgain = await engine.inspectCompact(session.id, session)
    assert.equal(inspectedAgain.candidate_id, inspected.candidate_id, '同快照候选身份必须稳定（inspect 与 commit 一致）')

    const prepared = await engine.prepareCompact(session.id, session, {
      candidate_id: inspected.candidate_id, idempotency_key: 'k-happy', summary: DRAFT,
    })
    assert.equal(prepared.status, 'prepared')
    assert.ok(typeof prepared.proposal_id === 'string' && prepared.proposal_id.startsWith('v3p-'))
    const submitted = await engine.submitCompact(session.id, session, { proposal_id: prepared.proposal_id })
    assert.equal(submitted.status, 'accepted')
    assert.equal(submitted.accepted, true)
    assert.equal(submitted.committed, false, 'submit 不得报 committed')
    const statusBefore = await engine.compactStatus(session.id, prepared.proposal_id)
    assert.equal(statusBefore.status, 'accepted')
    assert.equal(statusBefore.receipt_seq, null)
    assert.deepEqual([...session.surface.nodes], surfaceBefore, 'submit/prepare/status 不得改活动面')
    assert.equal((await engine.historyOf(session.id)).total, 0, 'accepted 不得产生凭证')

    // 正常尾部追加（当前回合新消息）不使候选失效
    session.pushUser('追加的下一步'.repeat(5))
    const archived = await engine.archiveForStep(session.id, session, {}, {})
    assert.equal(archived.status, 'archived', JSON.stringify(archived))
    assert.equal(archived.viaProposal, true)
    assert.equal(archived.proposalId, prepared.proposal_id)
    assert.match(archived.receiptText, /摘要：定位到查询参数未传递/)
    assert.match(archived.receiptText, /恢复：\/memory-lab restore/)
    const statusAfter = await engine.compactStatus(session.id, prepared.proposal_id)
    assert.equal(statusAfter.status, 'committed')
    assert.equal(statusAfter.committed, true)
    assert.equal(statusAfter.receipt_seq, archived.receiptSeq)

    const history = await engine.historyOf(session.id)
    assert.equal(history.total, 1)
    assert.equal(history.rows[0].summary, true)
    assert.equal(history.rows[0].summaryId, prepared.summary_id)
    const restored = await engine.restoreHistory(session.id, { index: 0 })
    assert.equal(restored.restored, true, JSON.stringify(restored))
    const surfaceText = await session.textOf(session.surface.nodes[0])
    assert.match(surfaceText, /第一问/, '逐张凭证恢复必须回完整原文')
    assert.match(surfaceText, /第一答/)
  } finally {
    engine.dispose()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})

test('P2-3：基础身份本身超过原文时 inspect 即不可执行（净收益判据不变）', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-p4-receipt-'))
  const { ctx, engine } = await mount(root)
  try {
    const session = createFakeSession({ id: 'session-receipt' })
    // 两条记录原文只有 101 字，而基础身份回执约 160 字：即使摘要已被预算挤掉，
    // 回执本身仍 ≥ 原文 → 必须判负（P5 只调整摘要预算，不放宽净收益判据）。
    session.pushUser('短')
    session.pushAssistant('答'.repeat(100))
    session.pushUser('当前问题'.repeat(10))
    await ctx.callPreStep(session)
    await settle(engine)

    const inspected = await engine.inspectCompact(session.id, session)
    assert.equal(inspected.status, 'not-worth', JSON.stringify(inspected))
    assert.equal(inspected.executable, false, '基础身份回执 ≥ 原文时 inspect 阶段就必须判不可执行')
    assert.deepEqual(inspected.reasons, ['net-gain-negative'])
    assert.ok(Number.isInteger(inspected.receipt_chars) && Number.isInteger(inspected.source_chars))
    assert.ok(inspected.receipt_chars >= inspected.source_chars, '回执不得短于原文（负收益）')
    assert.equal((await engine.historyOf(session.id)).total, 0)
  } finally {
    engine.dispose()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})

test('P2-3 交叉断言：长模型草稿按可用预算裁剪，prepare/提交不得因摘要判负', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-p4-receipt-draft-'))
  const { ctx, engine } = await mount(root)
  try {
    const session = createFakeSession({ id: 'session-receipt-draft' })
    // 原文 255 字、基础身份约 160 字：摘要可用预算 = 255-160-12 = 83 字。
    // P5 之前 240 字草稿会把回执推过原文 → prepare not-worth；现在按预算裁剪后仍可执行。
    session.pushUser('第一问：短')
    session.pushAssistant('答'.repeat(250))
    session.pushUser('当前问题'.repeat(10))
    await ctx.callPreStep(session)
    await settle(engine)

    const inspected = await engine.inspectCompact(session.id, session)
    assert.equal(inspected.status, 'ok', JSON.stringify(inspected))
    assert.equal(inspected.executable, true)
    assert.ok(inspected.receipt_chars < inspected.source_chars)

    const prepared = await engine.prepareCompact(session.id, session, {
      candidate_id: inspected.candidate_id,
      summary: { shortText: '长'.repeat(240), detail: '长草稿详细摘要' },
    })
    assert.equal(prepared.status, 'prepared', JSON.stringify(prepared))
    assert.equal(prepared.executable, true, '摘要超出可用长度时应裁剪，而不是判负')
    assert.equal(prepared.source_chars, inspected.source_chars, '两条路径 sourceChars 必须同口径')
    assert.ok(prepared.receipt_chars < prepared.source_chars, '裁剪后回执必须仍小于原文')
    assert.ok(prepared.receipt_chars >= inspected.receipt_chars, '更长的草稿只会被裁到同一上限')

    const submitted = await engine.submitCompact(session.id, session, { proposal_id: prepared.proposal_id })
    assert.equal(submitted.status, 'accepted')
    assert.equal(submitted.accepted, true)
    // 直接带候选 submit 走同一 prepare 判据，也不得绕过裁剪后的净收益判断。
    const direct = await engine.submitCompact(session.id, session, {
      candidate_id: inspected.candidate_id,
      summary: { shortText: '长'.repeat(240), detail: '长草稿详细摘要' },
    })
    assert.equal(direct.accepted, true, JSON.stringify(direct))
    // 边界提交该提案：回执带「摘要：」，且摘要行被省略号截断、总字数仍小于原文。
    const archived = await engine.archiveForStep(session.id, session, {}, {})
    assert.equal(archived.status, 'archived', JSON.stringify(archived))
    assert.equal(archived.viaProposal, true, '可执行的提案必须在边界被提交')
    assert.match(archived.receiptText, /摘要：/)
    assert.ok(archived.receiptText.length < inspected.source_chars, '含摘要的回执仍必须小于原文')
    assert.ok(archived.receiptText.split('\n')[1].endsWith('…'), '超出可用长度的摘要必须带省略号')
    assert.equal((await engine.compactStatus(session.id, prepared.proposal_id)).status, 'committed')
  } finally {
    engine.dispose()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})

test('漂移拒绝：来源被忘 / 相关记录被 pin → stale 且不改活动面', async () => {
  for (const mode of ['forget', 'pin']) {
    const root = await mkdtemp(path.join(tmpdir(), 'mcl-p4-drift-'))
    const { ctx, engine } = await mount(root)
    try {
      const session = createFakeSession({ id: 'session-drift-' + mode })
      seed(session)
      await ctx.callPreStep(session)
      await settle(engine)
      const inspected = await engine.inspectCompact(session.id, session)
      const prepared = await engine.prepareCompact(session.id, session, { candidate_id: inspected.candidate_id, summary: DRAFT })
      const submitted = await engine.submitCompact(session.id, session, { proposal_id: prepared.proposal_id })
      assert.equal(submitted.status, 'accepted')
      const recordId = inspected.identity.recordIds[0]
      const surfaceBefore = [...session.surface.nodes]
      if (mode === 'forget') await engine.forgetRecords(session.id, [recordId])
      else await engine.pinRecords(session.id, [recordId])

      const result = await engine.archiveForStep(session.id, session, {}, {})
      assert.notEqual(result.status, 'archived', mode + '：漂移后不得提交提案')
      assert.deepEqual([...session.surface.nodes], surfaceBefore, mode + '：漂移不得改活动面')
      const status = await engine.compactStatus(session.id, prepared.proposal_id)
      assert.equal(status.status, 'stale', mode + '：必须标记 stale')
      assert.equal(status.committed, false)
      assert.equal((await engine.historyOf(session.id)).total, 0)
    } finally {
      engine.dispose()
      await rm(root, { recursive: true, force: true }).catch(() => {})
    }
  }
})

test('幂等与摘要失败：同键同载荷复用、不同载荷拒绝；摘要缺失回落确定性摘要仍归档', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-p4-idem-'))
  const { ctx, engine } = await mount(root)
  try {
    const session = createFakeSession({ id: 'session-idem' })
    seed(session)
    await ctx.callPreStep(session)
    await settle(engine)
    const inspected = await engine.inspectCompact(session.id, session)
    const first = await engine.prepareCompact(session.id, session, { candidate_id: inspected.candidate_id, idempotency_key: 'same', summary: DRAFT })
    const second = await engine.prepareCompact(session.id, session, { candidate_id: inspected.candidate_id, idempotency_key: 'same', summary: DRAFT })
    assert.equal(second.proposal_id, first.proposal_id, '同键同载荷必须复用同一提案')
    assert.equal(second.status, 'prepared')
    const conflict = await engine.prepareCompact(session.id, session, {
      candidate_id: inspected.candidate_id, idempotency_key: 'same',
      summary: { ...DRAFT, shortText: '另一个正文' },
    })
    assert.equal(conflict.ok === undefined || conflict.status !== 'prepared', true, '同键不同载荷不得静默建第二份')
    assert.equal(conflict.status, 'rejected')

    const submitted = await engine.submitCompact(session.id, session, { proposal_id: first.proposal_id })
    assert.equal(submitted.status, 'accepted')
    // 摘要在提交截止前不可读：不阻塞归档，回落确定性摘要，凭证不带 summaryRef
    await rm(summariesPath(join(root, 'sessions', 'session-idem')), { force: true })
    const archived = await engine.archiveForStep(session.id, session, {}, {})
    assert.equal(archived.status, 'archived', JSON.stringify(archived))
    assert.equal(archived.summaryId, null)
    assert.match(archived.receiptText, /摘要：/, '回落确定性摘要仍应有摘要行')
    const history = await engine.historyOf(session.id)
    assert.equal(history.rows[0].summaryId, null)
    assert.equal((await engine.compactStatus(session.id, first.proposal_id)).status, 'committed', '凭证已落账即 committed')
  } finally {
    engine.dispose()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})

test('P2-2：过期 accepted 提案再次 submit 必须 stale，不得复用为 accepted', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mcl-p4-expiry-'))
  try {
    let now = 1000
    const proposals = new Map()
    const proposalsPort = {
      async append(_directory, event) {
        const previous = proposals.get(event.proposalId) ?? {}
        const status = event.type === 'proposal/prepared' ? 'prepared'
          : event.type === 'proposal/accepted' ? 'accepted'
            : event.type === 'proposal/stale' ? 'stale' : previous.status
        proposals.set(event.proposalId, { ...previous, ...event, status })
        return { ok: true, appended: true }
      },
      async read() { return new Map([...proposals].map(([key, value]) => [key, { ...value }])) },
    }
    const compact = createCompactService({
      proposals: proposalsPort,
      summary: {
        async materialize() {
          return {
            ok: true,
            artifact: {
              summaryId: 'v3s-1111111111111111',
              shortText: '摘要',
              sources: [{ recordId: 'v3r-0123456789abcdef', hash: 'a'.repeat(64) }],
              sourceSetFingerprint: 'b'.repeat(64),
            },
          }
        },
        fingerprintOf() { return 'c'.repeat(64) },
      },
      clock: { now: () => now },
      random: { uuid: () => '0123456789abcdef0123456789abcdef' },
      hash: { sha256: () => 'd'.repeat(64) },
    })
    const entry = { runtime: { store: { directory, listForgotten: () => [] } } }
    const candidate = {
      policyVersion: ARCHIVE_POLICY_VERSION,
      startSeq: 1,
      endSeq: 2,
      recordIds: ['v3r-0123456789abcdef'],
      sourceEventSeqs: [1, 2],
      sourceHashes: [{ recordId: 'v3r-0123456789abcdef', hash: 'a'.repeat(64) }],
      surfaceFingerprint: 's'.repeat(16),
      protectionFingerprint: 'p'.repeat(16),
      forgetFingerprint: 'f'.repeat(16),
      operations: 1,
      unitLabel: '回合数',
      restoreChars: 10,
    }
    const prepared = await compact.prepare({ entry, sessionKey: 'sess-expiry', candidate, ttlMs: 1000 })
    assert.equal(prepared.status, 'prepared', JSON.stringify(prepared))
    const first = await compact.submit({ entry, sessionKey: 'sess-expiry', proposalId: prepared.proposalId })
    assert.equal(first.status, 'accepted')
    // 未过期：幂等复用 accepted（防误杀）。
    const reused = await compact.submit({ entry, sessionKey: 'sess-expiry', proposalId: prepared.proposalId })
    assert.equal(reused.status, 'accepted')
    assert.equal(reused.reused, true)
    // 过期后：必须先判 stale，不得再走 accepted 复用分支。
    now = 5000
    const expired = await compact.submit({ entry, sessionKey: 'sess-expiry', proposalId: prepared.proposalId })
    assert.equal(expired.status, 'stale')
    assert.deepEqual(expired.reasons, ['expired'])
    assert.equal(expired.accepted, undefined)
    assert.equal((await compact.status({ entry, proposalId: prepared.proposalId })).status, 'stale')
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {})
  }
})

test('重启幂等：pending 提案从台账恢复、重验证后恰好提交一次', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-p4-restart-'))
  let engine = null
  try {
    const first = await mount(root)
    engine = first.engine
    const session = createFakeSession({ id: 'session-restart' })
    seed(session)
    await first.ctx.callPreStep(session)
    await settle(engine)
    const inspected = await engine.inspectCompact(session.id, session)
    const prepared = await engine.prepareCompact(session.id, session, { candidate_id: inspected.candidate_id, summary: DRAFT })
    assert.equal((await engine.submitCompact(session.id, session, { proposal_id: prepared.proposal_id })).status, 'accepted')
    engine.dispose()

    const second = await mount(root)
    engine = second.engine
    await second.ctx.callPreStep(session)
    await settle(engine)
    const archived = await engine.archiveForStep(session.id, session, {}, {})
    assert.equal(archived.status, 'archived', JSON.stringify(archived))
    assert.equal(archived.viaProposal, true)
    assert.equal((await engine.historyOf(session.id)).total, 1, '重启后只能提交一次（不重复凭证）')
    assert.equal((await engine.compactStatus(session.id, prepared.proposal_id)).status, 'committed')

    // 再跑一次边界：不得再归档同一段
    const again = await engine.archiveForStep(session.id, session, {}, {})
    assert.notEqual(again.status, 'archived')
    assert.equal((await engine.historyOf(session.id)).total, 1)
  } finally {
    engine?.dispose()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})

test('跨会话拒绝：另一会话读不到本会话提案/摘要', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-p4-xsession-'))
  const { ctx, engine } = await mount(root)
  try {
    const sessionA = createFakeSession({ id: 'session-a' })
    seed(sessionA)
    await ctx.callPreStep(sessionA)
    await settle(engine)
    const inspected = await engine.inspectCompact(sessionA.id, sessionA)
    const prepared = await engine.prepareCompact(sessionA.id, sessionA, { candidate_id: inspected.candidate_id, summary: DRAFT })

    const sessionB = createFakeSession({ id: 'session-b' })
    sessionB.pushUser('另一个会话的当前问题')
    await ctx.callPreStep(sessionB)
    await settle(engine)
    const crossProposal = await engine.compactStatus(sessionB.id, prepared.proposal_id)
    assert.equal(crossProposal.status, 'not-found')
    const crossRead = await engine.toolRead(sessionB.id, prepared.summary_id, {})
    assert.equal(crossRead.status, 'not-found')
    assert.equal(crossRead.visible, false)
  } finally {
    engine.dispose()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})
