/**
 * P2-04（0.15.1）：回合级「记录 ID 映射缺失」被伪装成 `no-candidate`。
 *
 * ## 缺陷
 * `makePlan` 在 `span.recordSeqs` 里有 seq 取不到记录 ID 时 `return null`；回合级
 * `plan()` 把 null 与「选择器没选出 span」混成同一个 `no-candidate`，于是 status 说
 * 「暂无可归档」，而事实是**有候选、只是映射丢了**（数据面异常）。按步级
 * （`planSteps`）早就在同一形状下返回 `{status:'failed', phase:'plan', reason:'record-id-missing'}`，
 * 两个入口口径相反；自动归档还会反复重试同一段并静默失败。
 *
 * ## 判据来源
 * docs/dev-0.15.1/记忆上下文-0.15.1-独立排查报告.md §3.2 P2-04（审读）；用户裁定
 * （2026-11-04）：全部按顺序修、根因修复。
 *
 * ## 修法
 * `makePlan` 缺 ID 时返回**结构化失败**（`phase:'plan'`、`reason:'record-id-missing'`，
 * 并带回缺失的 `seqs` 与整段 `span`/`recordIds`）。两个入口因此同口径：失败原因可观测、
 * dryRun 不改写语义、调用方不会把数据面异常当「没有候选」。
 *
 * ## 断言组
 * 1. 回合级 `plan`：坏映射 → `status:'failed'` + `reason:'record-id-missing'` + 非空 `seqs`，
 *    且**不是** `no-candidate`（旧实现是后者）；
 * 2. `dryRun` 同口径（预览不得把异常洗成「暂无可归档」）；
 * 3. 对照：正常映射 → 正常出计划（不误杀），且计划里带 receiptText/recordIds。
 *
 * ## 不适用条件与已知边界
 * - 选择器层面的「没有候选」仍走 `no-candidate`（那是真的没有候选，不是异常）。
 * - 映射缺失的根因（摄入断点/索引漂移）不在这里修；本用例只保证**如实上报**。
 *
 * ## 定点变异自证
 * 把 `makePlan` 的缺 ID 分支退回 `return null` → 组 1/2 红（返回 no-candidate）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { createArchiveService } from '../src/v3/application/archive.mjs'

const user = (seq, text) => ({ type: 'user/message', seq, time: 1, data: { message: { role: 'user', content: [{ type: 'text', text }] }, source: { kind: 'user' } } })
const assistant = (seq, text) => ({ type: 'assistant/message', seq, time: 1, data: { message: { role: 'assistant', content: [{ type: 'text', text }] }, source: { kind: 'assistant' } } })
const stepStart = (seq, turn) => ({ type: 'step/start', seq, time: 1, data: { turn, step: 1 } })
const stepEnd = (seq, turn) => ({ type: 'step/end', seq, time: 1, data: { turn, step: 1 } })

/** 三个完整回合（human 口径：最后一组是 current，前两组已完成）。 */
function fixture() {
  const events = []
  let seq = 0
  for (let turn = 1; turn <= 3; turn += 1) {
    events.push(user(seq++, '问'.repeat(200)))
    events.push(stepStart(seq++, turn))
    events.push(assistant(seq++, '答'.repeat(400)))
    events.push(stepEnd(seq++, turn))
  }
  const surfaceNodes = events.filter((e) => e.type === 'user/message' || e.type === 'assistant/message').map((e) => e.seq)
  return { events, surfaceNodes }
}

function serviceOf(mapBySeq) {
  const store = {
    async readRecord(id) {
      return { id, kind: 'message-user', sessionKey: 's-p204', createdAt: 1, payload: { text: '正文'.repeat(300), bytes: 1800 }, provenance: {} }
    },
  }
  const host = { async surfaceNodes() { return [] }, async surfaceTextAt() { return null }, async surfaceOp() { return { seq: 0 } } }
  return createArchiveService({ store, host, clock: { now: () => 1 }, random: { uuid: () => 'u' } })
}

/** has() 恒真（选择器认为都有记录），get() 恒 undefined（映射确实缺失）。 */
function brokenMap() {
  const map = new Map()
  map.has = () => true
  map.get = () => undefined
  return map
}

function healthyMap(surfaceNodes) {
  const map = new Map()
  surfaceNodes.forEach((seq, index) => map.set(seq, 'v3r-' + String(index + 1).padStart(16, '0')))
  return map
}

const basePlan = (events, surfaceNodes, seqToRecordId) => ({
  sessionId: 's-p204',
  events,
  surfaceNodes,
  seqToRecordId,
  mode: 'full-history',
  retainOperations: 1,
  lastArchiveEndSeq: -1,
  maxOperations: 1,
  turnBasis: 'human',
  summary: false,
})

test('P2-04 回合级映射缺失：结构化失败，不再伪装 no-candidate', async () => {
  const { events, surfaceNodes } = fixture()
  const svc = serviceOf()
  const planned = await svc.plan(basePlan(events, surfaceNodes, brokenMap()))
  assert.equal(planned.status, 'failed', '映射缺失必须如实报失败：' + JSON.stringify(planned)?.slice(0, 200))
  assert.equal(planned.phase, 'plan')
  assert.equal(planned.reason, 'record-id-missing')
  assert.notEqual(planned.status, 'no-candidate', '数据面异常不得洗成「没有候选」')
  assert.ok(Array.isArray(planned.seqs) && planned.seqs.length > 0, '必须带回缺失的 seq 清单：' + JSON.stringify(planned.seqs))
  assert.ok(planned.span, '失败也要带 span 供定位')
})

test('P2-04 dryRun 同口径：预览不得把异常洗成暂无可归档', async () => {
  const { events, surfaceNodes } = fixture()
  const svc = serviceOf()
  const preview = await svc.dryRun(basePlan(events, surfaceNodes, brokenMap()))
  assert.equal(preview.status, 'failed', JSON.stringify(preview)?.slice(0, 200))
  assert.equal(preview.reason, 'record-id-missing')
})

test('P2-04 对照：正常映射仍出计划（不误杀）', async () => {
  const { events, surfaceNodes } = fixture()
  const svc = serviceOf()
  const planned = await svc.plan(basePlan(events, surfaceNodes, healthyMap(surfaceNodes)))
  assert.equal(planned.status, undefined, '正常路径不该带 failed：' + JSON.stringify(planned)?.slice(0, 200))
  assert.ok(typeof planned.receiptText === 'string' && planned.receiptText.length > 0)
  assert.ok(Array.isArray(planned.recordIds) && planned.recordIds.length > 0)
  assert.equal(planned.startSeq, 0)
})
