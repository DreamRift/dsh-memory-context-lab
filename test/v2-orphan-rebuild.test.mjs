
/**
 * 0.13.0 F0 第二通道：回执节点不在活动面时的冷库重建。
 *
 * 场景：归档后回执被折叠（或宿主压缩）移出活动面，账本仍在、冷库仍在。
 * 修复前一律 `skipped: 回执节点已不在活动面`；修复后按冷库 hash 校验重建。
 *
 * 两条边界必须同时成立：
 *   - hash 相符 → 重建成功（原文回到活动面）；
 *   - hash 不符 → 仍然失败关闭（绝不把来历不明的正文塞回上下文）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  applyOneOperation,
  archiveMac,
  collectOperationCandidates,
  openTurnOf,
  planCooling,
  restoreReceipts,
} from '../src/apply.mjs'
import { archiveChunkNodeId, MIN_OPERATION_CHARS } from '../src/core.mjs'
import { FakeSession, FakeColdStore, fakeMeter } from './helpers/fake-host.mjs'

function buildSession() {
  const session = new FakeSession()
  session.append('system/message', { message: { role: 'system', content: [{ type: 'text', text: 'sys' }] } }, { surfaceOp: 'append' })
  session.append('turn/start', { turn: 1 })
  const args = '{"file":"a.md"}'
  session.append('assistant/message', {
    turn: 1, step: 1,
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: '先看这个文件。' },
        { type: 'tool-call', id: 'call-1', name: 'read', arguments: args },
      ],
    },
  }, { surfaceOp: 'append' })
  session.append('tool/result', {
    turn: 1, step: 1,
    message: { role: 'tool', source: { kind: 'tool', callId: 'call-1' }, toolCallId: 'call-1', content: [{ type: 'text', text: '文件正文'.repeat(400) }], isError: false },
  }, { surfaceOp: 'append' })
  session.append('turn/end', { turn: 1, reason: { kind: 'complete' } })
  return session
}

async function archiveOnce() {
  const session = buildSession()
  const measured = fakeMeter.measure(session)
  const view = collectOperationCandidates({
    surfaceNodes: session.surface.nodes,
    eventAt: (seq) => session.eventAt(seq),
    measuredNodes: measured.nodes,
    retainOperations: 0,
    openTurn: openTurnOf(session),
    archivedRanges: [],
    minimumChars: MIN_OPERATION_CHARS,
  })
  const candidate = view.candidates[0]
  assert.ok(candidate, 'fixture must produce one candidate')
  const store = new FakeColdStore()
  const plan = planCooling({
    candidates: [candidate],
    meter: fakeMeter,
    nodeIdFor: () => 'orphan-node',
    retainOperations: 0,
    minNetReleaseTokens: 128,
  })
  const outcome = await applyOneOperation({ session, client: store, unit: plan.units[0], meter: fakeMeter, hostVersion: 'test' })
  assert.equal(outcome.state, 'applied')
  return {
    session,
    store,
    receipt: {
      rangeStart: plan.units[0].rangeStart,
      rangeEnd: plan.units[0].rangeEnd,
      nodeId: 'orphan-node',
      replacementSeq: outcome.replacementSeq,
      hash: plan.units[0].hash,
      tools: plan.units[0].tools,
      callIds: plan.units[0].callIds,
      chars: plan.units[0].chars,
      originalTokens: plan.units[0].originalTokens,
      locators: outcome.locators ?? [],
      statuses: outcome.statuses ?? [],
      receiptFormat: outcome.receiptFormat,
      chunkCount: 1,
    },
  }
}

/** 模拟「回执被折叠移出活动面」：直接把它从 surface 节点表里摘掉。 */
function dropFromSurface(session, seq) {
  const index = session.nodes.indexOf(seq)
  assert.notEqual(index, -1, 'receipt must be on the surface before dropping')
  session.nodes.splice(index, 1)
}

test('F0-1 回执不在活动面 + rebuildOrphan=false → 仍然如实 skip（旧行为可复现）', async () => {
  const { session, store, receipt } = await archiveOnce()
  dropFromSurface(session, receipt.replacementSeq)
  const outcomes = await restoreReceipts({ session, client: store, receipts: [receipt], rebuildOrphan: false })
  assert.equal(outcomes[0].state, 'skipped')
  assert.match(outcomes[0].reason, /回执节点已不在活动面/)
})

test('F0-2 回执不在活动面 + rebuildOrphan=true → 按冷库 hash 重建原文', async () => {
  const { session, store, receipt } = await archiveOnce()
  dropFromSurface(session, receipt.replacementSeq)
  const outcomes = await restoreReceipts({ session, client: store, receipts: [receipt], rebuildOrphan: true })
  assert.equal(outcomes[0].state, 'restored', JSON.stringify(outcomes[0]))
  assert.equal(outcomes[0].rebuilt, true)
  const text = session.eventAt(outcomes[0].restoredSeq).data.content.map((b) => b.text).join('')
  assert.ok(text.includes('文件正文'), 'the original body must come back')
})

test('F0-3 冷库正文被篡改时拒绝重建（失败关闭，不塞来历不明的正文）', async () => {
  const { session, store, receipt } = await archiveOnce()
  dropFromSurface(session, receipt.replacementSeq)
  const key = archiveChunkNodeId(receipt.nodeId, 0)
  store.nodes.set(key, { content: '被篡改的正文' })
  const outcomes = await restoreReceipts({ session, client: store, receipts: [receipt], rebuildOrphan: true })
  assert.equal(outcomes[0].state, 'skipped')
  assert.match(outcomes[0].reason, /hash 与账本不符/)
})

test('F0-4 重建后的原文 hash 与账本一致（可再次审计）', async () => {
  const { session, store, receipt } = await archiveOnce()
  dropFromSurface(session, receipt.replacementSeq)
  const outcomes = await restoreReceipts({ session, client: store, receipts: [receipt], rebuildOrphan: true })
  const text = session.eventAt(outcomes[0].restoredSeq).data.content.map((b) => b.text).join('')
  assert.equal(archiveMac(text), receipt.hash)
})
