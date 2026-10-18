import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { V2_RECEIPT_MARKER } from '../src/core.mjs'
import {
  compressPreview,
  compressRun,
  reconcileVouchers,
} from '../src/v2/hierarchy-coordinator.mjs'
import {
  dropVoucherPlansForRecords,
  loadVoucherPlans,
  renderVoucherText,
  saveVoucherPlan,
  voucherIdOf,
} from '../src/v2/agg-voucher.mjs'
import { loadHierarchy } from '../src/v2/hierarchy-store.mjs'

const NL = String.fromCharCode(10)

function receiptOf(seq, recordId) {
  return [
    V2_RECEIPT_MARKER,
    '操作：pwsh ×1',
    '来源：seq ' + seq + '–' + seq,
    '冷记录：' + recordId,
    'hash：deadbeef000' + seq,
  ].join(NL)
}

function makeDeps({ sessionDir, ids, forgottenIds = [], readBodies = [], surfaceVoucherNodes = null, eventAt = null }) {
  const events = new Map([1, 2, 3].map((seq) => [seq, {
    type: 'user/message',
    data: {
      content: [{ type: 'text', text: receiptOf(seq, ids[seq - 1]) }],
      source: { kind: 'user', form: 'memory-lab2-surface' },
    },
  }]))
  const forgotten = new Set(forgottenIds)
  return {
    sessionDir,
    surfaceNodes: () => [1, 2, 3],
    ...(surfaceVoucherNodes ? { surfaceVoucherNodes } : {}),
    eventAt: eventAt ?? ((seq) => events.get(seq) ?? null),
    getRecordBody: async (id) => {
      readBodies.push(id)
      return '[工具] pwsh' + NL + '参数：Get-Content src/secret.mjs' + NL + '[结果]' + NL + 'const value = 8842'
    },
    getRecordKind: () => 'tool-output',
    isRecordVisible: (id) => !forgotten.has(id),
    appendVoucherMessage: async ({ startSeq }) => ({ seq: 900 + startSeq }),
  }
}

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'mcl-forget-hierarchy-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * T2/F-15 改写了这条契约：遗忘不再是「整组作废」，而是「把被遗忘的成员排除出参与集」。
 * 旧断言钉的是整组 blocked——那是粒度错误的那一版；这里钉新契约的硬要求：
 * 不读被排除者的正文、它不进任何账本/计划、其余成员照常压缩。
 */
test('遗忘成员被排除出参与集：不读其正文、不进 L1/L2/计划，其余成员照常压缩', async () => {
  await withTempDir(async (sessionDir) => {
    const ids = ['mcl2-aaaabbbbcccc-000001', 'mcl2-aaaabbbbcccc-000002', 'mcl2-aaaabbbbcccc-000003']
    const readBodies = []
    // 成员回执要够长：聚合凭证多了一行排除披露，短回执会先触发 no-safe-gain，
    // 那测的就不是排除语义了（no-safe-gain 本身由 compressor-program 套件覆盖）。
    const pad = NL + '正文：' + 'x'.repeat(1200)
    const deps = makeDeps({
      sessionDir,
      ids,
      forgottenIds: [ids[0]],
      readBodies,
      eventAt: (seq) => ({
        type: 'user/message',
        data: {
          content: [{ type: 'text', text: receiptOf(seq, ids[seq - 1]) + pad }],
          source: { kind: 'user', form: 'memory-lab2-surface' },
        },
      }),
    })
    const preview = await compressPreview(deps)
    assert.equal(preview.candidates.length, 1)
    assert.equal(preview.candidates[0].status, 'ready', preview.text)
    assert.deepEqual(preview.candidates[0].plan.recordIds, [ids[1], ids[2]], '参与集只含未遗忘成员')
    assert.deepEqual(preview.candidates[0].plan.excludedRecordIds, [ids[0]], '被排除者单独记账')
    assert.equal(preview.candidates[0].plan.planSchema, 2, '新计划一律 schema 2')
    assert.match(preview.candidates[0].plan.voucherText, /排除：1 段成员因遗忘未参与聚合/)
    assert.equal(readBodies.includes(ids[0]), false, '已遗忘成员的正文不得被读取')
    assert.deepEqual([...readBodies].sort(), [ids[1], ids[2]].sort(), '只读参与成员的正文')

    const run = await compressRun(deps)
    assert.match(run.text, /已替换 seq 1–3/)
    const ledger = await loadHierarchy(sessionDir)
    const l2 = ledger.entries.find((entry) => entry.kind === 'hierarchy/l2-phase')
    assert.ok(l2, 'L2 相位卡必须写出来')
    assert.deepEqual(l2.sourceRecordIds, [ids[1], ids[2]], 'sourceRecordIds 不得含被排除者')
    const l3 = ledger.entries.find((entry) => entry.kind === 'hierarchy/l3-task')
    assert.deepEqual(l3.leafIds, [ids[1], ids[2]], 'leafIds 不得含被排除者')
    const l1Ids = ledger.entries.filter((entry) => entry.kind === 'hierarchy/l1-card').map((entry) => entry.recordId)
    assert.deepEqual(l1Ids.sort(), [ids[1], ids[2]].sort(), 'L1 只为参与成员建卡')
  })
})

test('全部成员被遗忘：没有安全子集，整组失败关闭', async () => {
  await withTempDir(async (sessionDir) => {
    const ids = ['mcl2-aaaabbbbcccc-000021', 'mcl2-aaaabbbbcccc-000022', 'mcl2-aaaabbbbcccc-000023']
    const readBodies = []
    const deps = makeDeps({ sessionDir, ids, forgottenIds: ids, readBodies })
    const preview = await compressPreview(deps)
    assert.equal(preview.candidates[0].status, 'blocked')
    assert.equal(preview.candidates[0].reason, 'member-forgotten')
    assert.deepEqual(readBodies, [], '全部排除时一条正文都不读')

    const run = await compressRun(deps)
    assert.match(run.text, /没有可替换的候选组/)
    assert.deepEqual((await loadHierarchy(sessionDir)).entries, [], '不得写任何 L1/L2 账本')
    assert.deepEqual(await loadVoucherPlans(sessionDir), [], '不得留下可重放的凭证计划')
  })
})
test('对照组：全部可见时压缩照常提交，证明守卫不是无条件拒绝', async () => {
  await withTempDir(async (sessionDir) => {
    const ids = ['mcl2-aaaabbbbcccc-000011', 'mcl2-aaaabbbbcccc-000012', 'mcl2-aaaabbbbcccc-000013']
    const readBodies = []
    const deps = makeDeps({ sessionDir, ids, readBodies })
    const preview = await compressPreview(deps)
    assert.equal(preview.candidates[0]?.status, 'ready')
    assert.equal(readBodies.length, 3)
    const run = await compressRun(deps)
    assert.match(run.text, /已替换 seq 1–3/)
    const ledger = await loadHierarchy(sessionDir)
    assert.ok(ledger.entries.some((entry) => entry.kind === 'hierarchy/l2-phase'))
  })
})

test('遗忘后计划文件按记录 ID 失效，保留无关计划', async () => {
  await withTempDir(async (sessionDir) => {
    const [a, b] = ['mcl2-ddddeeeeffff-000001', 'mcl2-ddddeeeeffff-000002']
    await saveVoucherPlan(sessionDir, { voucherId: 'agg-1-3-a', recordIds: [a], createdAt: '2026-10-17T00:00:00.000Z' })
    await saveVoucherPlan(sessionDir, { voucherId: 'agg-1-3-b', recordIds: [b], createdAt: '2026-10-17T00:00:01.000Z' })
    const result = await dropVoucherPlansForRecords(sessionDir, [a])
    assert.deepEqual(result.dropped, ['agg-1-3-a'])
    assert.deepEqual((await loadVoucherPlans(sessionDir)).map((plan) => plan.voucherId), ['agg-1-3-b'])
  })
})

test('重放对账：计划含已遗忘成员时作废、不补写账本', async () => {
  await withTempDir(async (sessionDir) => {
    const ids = ['mcl2-ffffaaaabbbb-000001', 'mcl2-ffffaaaabbbb-000002', 'mcl2-ffffaaaabbbb-000003']
    const voucherId = voucherIdOf(1, 3, [1, 2, 3])
    const voucherText = renderVoucherText({
      voucherId,
      startSeq: 1,
      endSeq: 3,
      memberCount: 3,
      recordCount: 3,
      toolHistogram: { pwsh: 3 },
      tokensEstimate: 30,
    })
    await saveVoucherPlan(sessionDir, {
      voucherId,
      startSeq: 1,
      endSeq: 3,
      memberSeqs: [1, 2, 3],
      memberCount: 3,
      recordIds: ids,
      memberTexts: ids.map((id) => 'member ' + id),
      phaseCard: 'phase card should not be replayed',
      voucherText,
      createdAt: '2026-10-17T00:00:00.000Z',
    })
    const deps = makeDeps({
      sessionDir,
      ids,
      forgottenIds: [ids[1]],
      surfaceVoucherNodes: () => [{ seq: 99, text: voucherText }],
    })
    const report = await reconcileVouchers(deps)
    assert.deepEqual(report.replayed, [])
    assert.equal(report.forgotten.length, 1)
    assert.equal(report.forgotten[0].voucherId, voucherId)
    assert.deepEqual(report.forgotten[0].recordIds, [ids[1]])
    assert.deepEqual(await loadVoucherPlans(sessionDir), [], '含遗忘成员的计划必须被删除')
    assert.deepEqual((await loadHierarchy(sessionDir)).entries, [], '不得凭计划重放 L1/L2')
  })
})

test('重放对账对照组：全部可见时按计划补账', async () => {
  await withTempDir(async (sessionDir) => {
    const ids = ['mcl2-ccccddddeeee-000001', 'mcl2-ccccddddeeee-000002', 'mcl2-ccccddddeeee-000003']
    const voucherId = voucherIdOf(1, 3, [1, 2, 3])
    const voucherText = renderVoucherText({
      voucherId,
      startSeq: 1,
      endSeq: 3,
      memberCount: 3,
      recordCount: 3,
      toolHistogram: { pwsh: 3 },
      tokensEstimate: 30,
    })
    await saveVoucherPlan(sessionDir, {
      voucherId,
      startSeq: 1,
      endSeq: 3,
      memberSeqs: [1, 2, 3],
      memberCount: 3,
      recordIds: ids,
      memberTexts: ids.map((id) => 'member ' + id),
      phaseCard: 'visible phase card',
      voucherText,
      createdAt: '2026-10-17T00:00:00.000Z',
    })
    const deps = makeDeps({
      sessionDir,
      ids,
      surfaceVoucherNodes: () => [{ seq: 99, text: voucherText }],
    })
    const report = await reconcileVouchers(deps)
    assert.deepEqual(report.replayed, [voucherId])
    assert.ok((await loadHierarchy(sessionDir)).entries.length > 0)
  })
})
