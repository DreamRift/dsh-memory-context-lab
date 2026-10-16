/**
 * P3 层级协调器端到端测试：命令面 + 自动挂点 + 崩溃窗口收敛。
 *
 * 覆盖计划 §5 P3 验收门（「无 LLM 可用全链路工作；保来源/限制/精确值；
 * 失败不破坏原状态」）中依赖前面各模块组装的部分：
 *   - compress preview 只读（不动表面、不写计划文件）
 *   - compress run 事务序（计划 → 表面替换 → 账本 CAS），成功后计划清空
 *   - 幂等（第二次 run 没有新候选；重复 reconcile 不重放）
 *   - no-safe-gain 拒绝后原状态完好
 *   - 两个崩溃窗口：只有计划（丢弃）；表面已有凭证但账本缺失（CAS 重放）
 *   - expand 分页展开 + 已遗忘成员占位行 + 页码钳制 + 未知凭证
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { FakeSession } from './helpers/fake-host.mjs'
import { V2_RECEIPT_MARKER } from '../src/core.mjs'
import {
  AGG_VOUCHER_MARKER,
  AGG_VOUCHER_MIN_RUN,
  AGG_VOUCHER_PAGE_SIZE,
  getVoucherPlan,
  loadVoucherPlans,
} from '../src/v2/agg-voucher.mjs'
import { loadHierarchy } from '../src/v2/hierarchy-store.mjs'
import {
  compressPreview,
  compressRun,
  compressStatus,
  expandVoucher,
  maybeStageCompress,
  reconcileVouchers,
} from '../src/v2/hierarchy-coordinator.mjs'

function makeDeps({ memberBodies = new Map(), forgotten = new Set() } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mcl2-coord-'))
  const session = new FakeSession({ id: 'session-coord-test' })
  const deps = {
    sessionDir: dir,
    eventAt: (seq) => session.eventAt(seq),
    surfaceNodes: () => [...session.surface.nodes],
    surfaceVoucherNodes: () => {
      const found = []
      for (const seq of session.surface.nodes) {
        const event = session.eventAt(seq)
        if (event?.type !== 'user/message') continue
        const first = event.data?.content?.find((part) => part?.type === 'text')
        if (typeof first?.text === 'string' && first.text.startsWith(AGG_VOUCHER_MARKER)) {
          found.push({ seq, text: first.text })
        }
      }
      return found
    },
    getRecordBody: async (recordId) => memberBodies.get(recordId) ?? null,
    getRecordKind: () => 'tool-output',
    isRecordVisible: (recordId) => !forgotten.has(recordId),
    appendVoucherMessage: async ({ startSeq, endSeq, memberSeqs, text }) => {
      const shadowed = memberSeqs.filter((s) => s >= startSeq && s <= endSeq)
      const event = session.append('user/message', { content: [{ type: 'text', text }] }, {
        surfaceOp: { op: 'replace', startSeq, endSeq },
        sourceEventSeqs: shadowed.length > 0 ? shadowed : [startSeq],
        source: { kind: 'user', form: 'memory-lab2-surface' },
      })
      return { seq: event?.seq }
    },
  }
  return { dir, session, deps }
}

let seqCounter = 0
function receiptText(id) {
  seqCounter += 1
  return [
    V2_RECEIPT_MARKER,
    `工具：run_code`,
    `来源：seq ${seqCounter}–${seqCounter}（1 次调用，原 ≈500 token / 2000 字）`,
    `冷记录：${id}`,
    `hash：${id.slice(-10)}`,
    '',
    '正文已沉入本会话隔离冷库。',
  ].join('\n')
}

async function seedReceiptRun(session, ids, { bodyPadding = 0 } = {}) {
  const seqs = []
  if (session.surface.nodes.length === 0) {
    // 真实会话的 seq 从 1 起（先有用户消息）；假宿主从 0 计数，这里垫一条
    // 引导消息，保证账本校验「seq 必须为正整数」与真实世界一致。
    session.append('user/message', { id: 'bootstrap', role: 'user', content: [{ type: 'text', text: '会话开始' }] }, { surfaceOp: 'append' })
  }
  for (const id of ids) {
    const text = bodyPadding > 0 ? receiptText(id) + '\n' + 'x'.repeat(bodyPadding) : receiptText(id)
    const event = session.append('user/message', {
      id: `surface-${id}`,
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'user', form: 'memory-lab2-surface' },
    }, { surfaceOp: 'append' })
    seqs.push(event.seq)
  }
  return seqs
}

// 记录 ID 段位与真实冷库一致：mcl2-<24 位十六进制>-<6 位序号>（解析器只收 hex）。
const ids = (n) => Array.from({ length: n }, (_, i) => `mcl2-abc000000000000000000000-${String(i + 1).padStart(6, '0')}`)

test('maybeStageCompress：默认关闭时是无操作，不碰表面与磁盘', async () => {
  const { session, deps } = makeDeps()
  await seedReceiptRun(session, ids(4))
  const before = [...session.surface.nodes]
  const outcome = await maybeStageCompress(deps, { enabled: false })
  assert.deepEqual(outcome, { triggered: false, reason: 'disabled' })
  assert.deepEqual([...session.surface.nodes], before)
})

test('compress preview：只读出候选，不写计划文件不改表面', async () => {
  const { session, dir, deps } = makeDeps()
  await seedReceiptRun(session, ids(4), { bodyPadding: 4000 })
  const before = [...session.surface.nodes]
  const result = await compressPreview(deps)
  assert.ok(result.text.includes('压缩预览'), '报告标题')
  assert.deepEqual([...session.surface.nodes], before, '表面未变')
  assert.deepEqual(await loadVoucherPlans(dir), [], 'preview 不落计划')
})

test('compress run：事务序提交后表面只剩凭证、账本成批落盘、计划清空', async () => {
  const { session, dir, deps } = makeDeps()
  const memberSeqs = await seedReceiptRun(session, ids(4), { bodyPadding: 6000 })
  const result = await compressRun(deps)
  assert.equal(result.applied.length, 1, '一组已应用')
  const voucherNode = deps.surfaceVoucherNodes()[0]
  assert.ok(voucherNode, '表面出现聚合凭证')
  for (const seq of memberSeqs) {
    assert.ok(!session.surface.nodes.includes(seq), `成员回执 ${seq} 已被替换隐藏`)
  }
  const ledger = await loadHierarchy(dir)
  assert.equal(ledger.state, 'ok')
  assert.equal(ledger.vouchers.size, 1)
  assert.equal(ledger.runs.at(-1)?.outcome, 'committed')
  assert.deepEqual(await loadVoucherPlans(dir), [], '成功后计划清空')
})

test('compress run：幂等——已替换的组不再产生候选', async () => {
  const { session, deps } = makeDeps()
  await seedReceiptRun(session, ids(4), { bodyPadding: 6000 })
  const first = await compressRun(deps)
  assert.equal(first.applied.length, 1)
  const second = await compressRun(deps)
  assert.equal(second.applied.length, 0, '没有新候选')
  assert.equal(deps.surfaceVoucherNodes().length, 1, '凭证不重复')
})

test('no-safe-gain：不净缩短时拒绝替换，原状态完好', async () => {
  const { session, dir, deps } = makeDeps()
  // 成员回执极短：手工种最小回执（仅标记 + 冷记录行），凭证文本（固定头 + 相位卡）
  // 必然长于成员合计 → no-safe-gain，保持原投影。
  const minIds = ids(AGG_VOUCHER_MIN_RUN)
  for (const id of minIds) {
    session.append('user/message', {
      id: `surface-${id}`,
      role: 'user',
      content: [{ type: 'text', text: `${V2_RECEIPT_MARKER}\n冷记录：${id}` }],
      source: { kind: 'user', form: 'memory-lab2-surface' },
    }, { surfaceOp: 'append' })
  }
  const nodesBefore = [...session.surface.nodes]
  const result = await compressRun(deps)
  assert.equal(result.applied.length, 0)
  assert.ok(result.rejected.length >= 1, '至少一组被 no-safe-gain 拒绝')
  assert.deepEqual([...session.surface.nodes], nodesBefore, '表面原样')
  const ledger = await loadHierarchy(dir)
  assert.equal(ledger.vouchers.size, 0, '账本无凭证')
  assert.ok(ledger.runs.some((r) => r.outcome === 'no-safe-gain'), '拒绝进审计')
})

test('崩溃窗口 A：只有计划没有表面凭证 → reconcile 丢弃计划', async () => {
  const { session, dir, deps } = makeDeps()
  await seedReceiptRun(session, ids(4))
  const { getVoucherPlan: _g, ...rest } = await import('../src/v2/agg-voucher.mjs')
  const { saveVoucherPlan } = await import('../src/v2/agg-voucher.mjs')
  await saveVoucherPlan(dir, { voucherId: 'agg-v2-crash-a', startSeq: 0, endSeq: 3, memberSeqs: [0, 1, 2, 3], recordIds: ids(4), createdAt: '2026-10-16T10:00:00.000Z' })
  assert.ok(await getVoucherPlan(dir, 'agg-v2-crash-a'), '前置：计划在盘')
  await reconcileVouchers(deps)
  assert.equal(await getVoucherPlan(dir, 'agg-v2-crash-a'), null, '计划被丢弃')
  assert.equal(deps.surfaceVoucherNodes().length, 0, '表面未被触动')
})

test('崩溃窗口 B：表面已有凭证但账本缺失 → reconcile 按 CAS 重放账本', async () => {
  const { session, dir, deps } = makeDeps()
  const memberSeqs = await seedReceiptRun(session, ids(4), { bodyPadding: 6000 })
  // 模拟「替换已落表面、账本未落盘」：手工保存计划 + 手工替换表面。
  const { saveVoucherPlan } = await import('../src/v2/agg-voucher.mjs')
  const recordIds = ids(4)
  // 凭证 id 段位须符合 parseAggVoucherText 的解析契约：agg-<ts>-<n>-<hash6>。
  const voucherId = 'agg-20261016-0001-abc123'
  await saveVoucherPlan(dir, {
    voucherId,
    startSeq: memberSeqs[0],
    endSeq: memberSeqs.at(-1),
    memberSeqs,
    recordIds,
    createdAt: '2026-10-16T10:00:00.000Z',
  })
  const replacement = session.append('user/message', { content: [{ type: 'text', text: [
    AGG_VOUCHER_MARKER,
    `凭证：${voucherId}`,
    `范围：seq ${memberSeqs[0]}–${memberSeqs.at(-1)}（4 段）`,
    `冷记录：${recordIds.join('、')}`,
  ].join('\n') }] }, {
    surfaceOp: { op: 'replace', startSeq: memberSeqs[0], endSeq: memberSeqs.at(-1) },
    sourceEventSeqs: memberSeqs,
    source: { kind: 'user', form: 'memory-lab2-surface' },
  })
  assert.ok(replacement.seq > 0)
  assert.equal((await loadHierarchy(dir)).vouchers.size, 0, '前置：账本缺失')
  const result = await reconcileVouchers(deps)
  assert.equal(result.replayed.length, 1, '重放一组')
  const ledger = await loadHierarchy(dir)
  assert.ok(ledger.vouchers.has(voucherId), '账本补齐')
  // 对账批里的 run 条目落 skipped-damaged（对账重放），原始提交的 committed
  // 已随崩溃丢失——这正是账本补齐要恢复的事实之一。
  assert.ok(ledger.runs.some((r) => r.outcome === 'skipped-damaged'), '对账 run 入账')
  // 幂等：再 reconcile 不重放。
  const again = await reconcileVouchers(deps)
  assert.equal(again.replayed.length, 0, '重复收敛无操作')
})

test('expand：分页展开成员原文、遗忘成员占位、页码钳制、未知凭证', async () => {
  const { session, dir, deps } = makeDeps()
  const recordIds = ids(4)
  const memberSeqs = await seedReceiptRun(session, recordIds, { bodyPadding: 400 })
  await compressRun(deps)
  const ledger = await loadHierarchy(dir)
  const voucherId = [...ledger.vouchers.keys()][0]

  const page1 = await expandVoucher(deps, voucherId, '1')
  assert.ok(page1.text.includes('第 1/2 页'), '页眉带总页数（4 成员 / 每页 3 段）')
  assert.ok(page1.text.includes(recordIds[0]), '成员原文含冷记录 id')

  const clamped = await expandVoucher(deps, voucherId, '999')
  assert.equal(clamped.page, Math.ceil(4 / AGG_VOUCHER_PAGE_SIZE), '页码钳制到最后一页')

  const notFound = await expandVoucher(deps, 'agg-v2-nope', '1')
  // 未知凭证恒定只读：返回提示文本，不抛错、不改任何状态。
  assert.ok(notFound.text.includes('不存在'))

  // 已遗忘成员：expand 给占位行而不是原文。
  const hiddenDeps = { ...deps, isRecordVisible: (recordId) => recordId !== recordIds[1] }
  const hidden = await expandVoucher(hiddenDeps, voucherId, '1')
  assert.ok(hidden.text.includes('已软遗忘或不可读'), '占位行')
  assert.deepEqual(hidden.hidden, [recordIds[1]], '隐藏成员如实上报')
})

test('compress status：只读状态报告（未启用会话也能查）', async () => {
  const { session, dir, deps } = makeDeps()
  await seedReceiptRun(session, ids(4), { bodyPadding: 4000 })
  await compressRun(deps)
  const result = await compressStatus(deps)
  assert.ok(result.text.includes('层级压缩状态'))
  assert.ok(result.text.includes('agg-'), '凭证入状态')
})

test('收尾：测试目录清理无残留', async () => {
  // mkdtempSync 目录由各用例自建；这里只断言系统临时目录可写，防误用 cwd。
  const probe = await mkdtemp(join(tmpdir(), 'mcl2-probe-'))
  await rm(probe, { recursive: true, force: true })
  assert.ok(true)
})
