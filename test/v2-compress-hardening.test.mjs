/**
 * 0.13.1 守卫：层级压缩的三处「真实库上跑不通」缺陷。
 *
 * 全部由独立复审 + 探针实测发现：
 * 1. 回执正文只印**冷节点 id**（`冷记录：mcl2-…`），而 `store.readRecord` 只认
 *    `tXXXXXXXX-rYYYY` 形态的稳定记录 ID —— 传进去直接 EINVAL。层级压缩的
 *    memberViewOf 第一次读就抛，preview/run 在真实会话上**从未成功执行过**；
 *    代码里「读不到就退化用回执文本」那条兜底走不到（`body ?? receiptText` 兜不住 throw）。
 * 2. run 审计汇总行的 phaseKey 是 null，而 hierarchy-store 的写入校验要求**非空字符串**
 *    → 整批审计条目被 EINVAL 拒绝，compressRun 又 `.catch(() => {})` 吞掉。于是
 *    「已应用 + 被拒/失败」同批时，被拒与失败行一起消失（单看账本像没有拒绝过）。
 * 3. `compress status` 读 `ledger.repairNotes`，而 loadHierarchy 从不返回该字段 →
 *    账本一旦带损坏修复记录，status 直接 TypeError。
 *
 * ## 不适用条件与已知边界
 * 第 1 条用**假 store** 复刻真实 store 的两条契约（记录 ID 形态严格、条目带
 * `inline.nodeId`），不是真文件系统：本用例证明「别名会被展开再读」，
 * 不证明 store 的读取语义（那由 v2-store-* 负责）。第 3 条直接构造损坏账本。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { FakeSession } from './helpers/fake-host.mjs'
import { V2_RECEIPT_MARKER } from '../src/core.mjs'
import { loadHierarchy } from '../src/v2/hierarchy-store.mjs'
import { compressRun, compressStatus } from '../src/v2/hierarchy-coordinator.mjs'
import { createCompressDomain } from '../src/v2/runtime-compress.mjs'

const ids = (n) => Array.from({ length: n }, (_, i) => `mcl2-abc000000000000000000000-${String(i + 1).padStart(6, '0')}`)

function makeDeps(dir, session) {
  return {
    sessionDir: dir,
    eventAt: (seq) => session.eventAt(seq),
    surfaceNodes: () => [...session.surface.nodes],
    surfaceVoucherNodes: () => [],
    getRecordBody: async () => null,
    getRecordKind: () => 'tool-output',
    isRecordVisible: () => true,
    appendVoucherMessage: async ({ startSeq, endSeq, memberSeqs, text }) => {
      // 宿主契约：替换范围内的**每个**表面节点都必须在 sourceEventSeqs 里。
      const shadowed = [...session.surface.nodes].filter((seq) => seq >= startSeq && seq <= endSeq)
      const event = session.append('user/message', { content: [{ type: 'text', text }] }, {
        surfaceOp: { op: 'replace', startSeq, endSeq },
        sourceEventSeqs: shadowed.length > 0 ? shadowed : memberSeqs,
      })
      return { seq: event?.seq }
    },
  }
}

function seed(session, { long = 0, short = 0 } = {}) {
  if (session.surface.nodes.length === 0) {
    session.append('user/message', { id: 'boot', role: 'user', content: [{ type: 'text', text: '会话开始' }] }, { surfaceOp: 'append' })
  }
  const all = ids(long + short)
  let index = 1
  for (const id of all.slice(0, long)) {
    const text = [
      V2_RECEIPT_MARKER,
      '工具：run_code',
      `来源：seq ${index}–${index}`,
      `冷记录：${id}`,
      `hash：${id.slice(-10)}`,
      '',
      'x'.repeat(6000),
    ].join('\n')
    session.append('user/message', { id: `surface-${id}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user', form: 'memory-lab2-surface' } }, { surfaceOp: 'append' })
    index += 1
  }
  if (long > 0 && short > 0) {
    // 组边界：非回执节点把两组切开（否则 7 条连续回执会并成一组，整体够长就不算 no-safe-gain）。
    session.append('user/message', { id: 'boundary', role: 'user', content: [{ type: 'text', text: '分组边界（人类消息，不是回执）' }] }, { surfaceOp: 'append' })
  }
  for (const id of all.slice(long)) {
    session.append('user/message', {
      id: `surface-${id}`,
      role: 'user',
      content: [{ type: 'text', text: `${V2_RECEIPT_MARKER}\n冷记录：${id}` }],
      source: { kind: 'user', form: 'memory-lab2-surface' },
    }, { surfaceOp: 'append' })
    index += 1
  }
}

test('run 审计汇总行必须落账（phaseKey 非空）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcl2-audit-'))
  const session = new FakeSession({ id: 'session-audit' })
  seed(session, { long: 4 })
  const result = await compressRun(makeDeps(dir, session))
  assert.equal(result.applied.length, 1)
  const ledger = await loadHierarchy(dir)
  const summary = ledger.runs.filter((row) => typeof row.note === 'string' && row.note.startsWith('applied='))
  assert.equal(summary.length, 1,
    'run 汇总审计行丢了（phaseKey=null 会让整批审计被 EINVAL 拒绝）：' + JSON.stringify(ledger.runs.map((r) => r.outcome)))
  assert.equal(typeof summary[0].phaseKey, 'string')
  assert.ok(summary[0].phaseKey.length > 0)
})

test('同批的「已应用 + 被拒」两条审计行都要在账本里', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcl2-audit2-'))
  const session = new FakeSession({ id: 'session-audit2' })
  seed(session, { long: 4, short: 3 })
  const result = await compressRun(makeDeps(dir, session))
  assert.equal(result.applied.length, 1, '前置：长组必须被应用；报告=' + result.text)
  assert.ok(result.rejected.length >= 1, '短回执组必须被 no-safe-gain 拒绝；报告=' + result.text)
  const ledger = await loadHierarchy(dir)
  assert.ok(ledger.runs.some((row) => row.outcome === 'no-safe-gain'),
    '被拒行被同批的 phaseKey=null 拖下水了：' + JSON.stringify(ledger.runs.map((r) => r.outcome)))
  assert.ok(ledger.runs.some((row) => typeof row.note === 'string' && row.note.startsWith('applied=')),
    '汇总行同样必须在')
})

test('compress status 在账本带损坏记录时不崩', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcl2-damaged-'))
  await mkdir(dir, { recursive: true })
  const header = JSON.stringify({ kind: 'hierarchy/ledger-header', schemaVersion: 1, createdAt: '2026-10-19T00:00:00.000Z' })
  const good = JSON.stringify({ kind: 'hierarchy/run', entrySeq: 1, runId: 'r1', phaseKey: 'p1', outcome: 'no-safe-gain', evidenceIds: [], sourceRevision: 0, at: '2026-10-19T00:00:01.000Z' })
  await writeFile(join(dir, 'hierarchy.jsonl'), [header, good, '{broken'].join('\n') + '\n', 'utf8')
  const ledger = await loadHierarchy(dir)
  assert.equal(ledger.damaged, true, '前置：账本必须被判为带损坏')
  const report = await compressStatus({ sessionDir: dir, surfaceVoucherNodes: () => [], isRecordVisible: () => true })
  assert.match(report.text, /损坏/)
})

test('压缩成员按冷节点 id（mcl2-…）能读到正文，不是 EINVAL', async () => {
  const labRoot = await mkdtemp(join(tmpdir(), 'mcl2-alias-'))
  const sessionDir = join(labRoot, 'v2', 'sessions', 'k')
  const nodeId = ids(1)[0]
  const recordId = 't00000001-r0000'
  // 假 store：复刻真实 store 的两条契约——
  // 1) readRecord 只接受 tXXXXXXXX-rYYYY 形态（其他一律 EINVAL）；
  // 2) listEntries 的条目带 inline.nodeId，供只读身份索引做别名展开。
  const entries = [
    { id: recordId, kind: 'projection.span', seq: 3, fidelity: 'verbatim', inline: { nodeId, chunk: 1 } },
  ]
  const fakeStore = {
    listEntries: ({ limit }) => ({ entries: entries.slice(0, limit), total: entries.length, nextAfter: null }),
    getEntry: (id) => entries.find((entry) => entry.id === id) ?? null,
    readRecord: async (id) => {
      if (!/^t\d{8}-r\d{4}$/.test(id)) {
        const error = new Error('记录 ID 非法：' + id)
        error.code = 'EINVAL'
        throw error
      }
      return { ok: true, id, payloadText: '成员正文（来自冷库）', record: { kind: 'projection.span' }, integrity: 'ok' }
    },
  }
  const domain = createCompressDomain({
    adopt: async () => null,
    factoryFor: () => ({ withStore: (fn) => fn(fakeStore) }),
    labRoot,
    sessionIdOf: () => 'k',
    modelPhaseResolver: null,
    stageCompress: async () => ({ triggered: false }),
  })
  const deps = await domain.compressDepsOf({
    sessionId: 'k',
    directory: sessionDir,
    agent: { session: new FakeSession({ id: 'k' }) },
    state: {},
  })
  const body = await deps.getRecordBody(nodeId)
  assert.equal(body, '成员正文（来自冷库）', '冷节点 id 必须先展开成记录 ID 再读，不能直接当记录 ID')
  assert.equal(deps.getRecordKind(nodeId), 'projection.span')
  await rm(labRoot, { recursive: true, force: true })
})
