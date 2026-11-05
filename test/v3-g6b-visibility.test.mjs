/**
 * G6b：可见性判定合同（C-V-01 裁决 R-1/R-2/R-3/R-6/R-7/R-9/R-10/R-11/R-12）。
 *
 * ## 覆盖
 * A. V1–V16 抽验（提案 §7 的判定反例）；B. 可见性摘要与纯 append 增量（R-2/R-3/R-4）；
 * C. 注入决策（R-1 unknown 必注入 / R-11 有界重复 / R-12 v1 信任集）；
 * D. 归档意图强制（R-6）；E. shadow 纪律与证明跳数（R-7）。
 *
 * ## 量具自检
 * 判定函数全走 `visibilityOf`（唯一构造点），回执由 `assertVisibilityVerdict` 校验；
 * 测试自己也显式断言 `visible !== null ⇔ state !== 'unknown'`，防「判定函数写歪但断言跟着歪」。
 *
 * ## 不适用条件
 * 全部是**合成快照**（无真实宿主、无真实账本）。真实宿主的活动面形状、contentGeneration
 * 语义仍未在真机核验（见证据文件 §未验边界），本套件只证明纯逻辑与 fake 端口。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  VISIBILITY_CONTRACT_VERSION,
  VISIBILITY_CAUSES,
  VISIBILITY_HIDDEN_CAUSES,
  VISIBILITY_LIMITS,
  VISIBILITY_STATES,
  VISIBILITY_TRUSTED_STATES_V1,
  consumerStateOf,
} from '../src/v3/contracts/visibility.mjs'
import { PLUGIN_SOURCE_KIND, RECEIPT_SOURCE_FORM, RESTORE_SOURCE_FORM } from '../src/v3/contracts/sources.mjs'
import { dedupeKeyOf, recordFragmentOf } from '../src/v3/domain/visibility/fragments.mjs'
import { EMPTY_SURFACE_MAX, isPureAppendAdvance, visibilityEpochOf } from '../src/v3/domain/visibility/epoch.mjs'
import { visibilityOf } from '../src/v3/domain/visibility/coverage.mjs'
import { createVisibilityState } from '../src/v3/domain/visibility/state.mjs'

const SESSION = 'g6b-session'

/** 合成快照（形状即接线清单 §snapshot 的字段）。 */
function snapshotOf({
  nodes = [],
  events = [],
  vouchers = [],
  forgotten = [],
  redacted = [],
  intent = 'absent',
  recordSeq = {},
  registry = null,
  generations = { contentGeneration: 0, replaceGeneration: 0 },
  sessionKey = SESSION,
  extra = {},
} = {}) {
  return {
    sessionKey,
    nodes,
    events: events.map((event) => ({
      seq: event.seq,
      type: event.type ?? 'user/message',
      sourceForm: event.sourceForm ?? null,
      sourceKind: event.sourceKind ?? null,
      sourceEventSeqs: event.shadow ?? [],
      text: event.text ?? null,
    })),
    vouchers,
    forgotten,
    redactedVoucherIds: redacted,
    archiveIntent: intent,
    recordSeq,
    recallRegistry: registry,
    generations,
    ...extra,
  }
}

function fragmentOf(id, text = '正文-' + id) {
  return recordFragmentOf({ id, text })
}

function judge(snapshot, id, text = '正文-' + id) {
  const out = visibilityOf({ snapshot, fragments: [fragmentOf(id, text)], sessionKey: SESSION })
  return { ...out, verdict: out.verdicts[0] }
}

const RECORD = 'v3r-00000000000000aa'
const OTHER = 'v3r-00000000000000bb'

/** 记录来源 seq = 0；活动面 [0,1] 只有普通用户消息。 */
function plainSurface() {
  return snapshotOf({
    nodes: [0, 1],
    events: [
      { seq: 0, type: 'user/message' },
      { seq: 1, type: 'assistant/message' },
    ],
    recordSeq: { [RECORD]: 0, [OTHER]: 1 },
  })
}

/** 归档后的活动面：receipt(seq 2) 覆盖 [0,1]。 */
function archivedSurface({ restore = false, forgotten = [], intent = 'absent' } = {}) {
  const nodes = restore ? [3] : [2]
  const events = [
    { seq: 0, type: 'user/message' },
    { seq: 1, type: 'assistant/message' },
    { seq: 2, type: 'user/message', sourceForm: RECEIPT_SOURCE_FORM, sourceKind: PLUGIN_SOURCE_KIND, shadow: [0, 1] },
  ]
  if (restore) {
    events.push({ seq: 3, type: 'user/message', sourceForm: RESTORE_SOURCE_FORM, sourceKind: PLUGIN_SOURCE_KIND, shadow: [2] })
  }
  return snapshotOf({
    nodes,
    events,
    vouchers: [{ voucherId: 'v-root', recordIds: [RECORD, OTHER], startSeq: 0, endSeq: 1, targetEventId: 2 }],
    forgotten,
    intent,
    recordSeq: { [RECORD]: 0, [OTHER]: 1 },
  })
}

/* ------------------------------------------------------------------ A 判定 */

test('G6b-V1 记录源事件仍在活动面：visible-surface / observed', () => {
  const { verdict, digest } = judge(plainSurface(), RECORD)
  assert.equal(verdict.state, 'visible-surface')
  assert.equal(verdict.visible, true)
  assert.equal(verdict.proof, 'observed')
  assert.equal(verdict.cause, null)
  assert.equal(verdict.contractVersion, VISIBILITY_CONTRACT_VERSION)
  assert.equal(verdict.claim, 'surface-projected')
  assert.match(digest, /^[0-9a-f]{16}$/)
  assert.equal(verdict.visibilityDigest, digest)
  assert.deepEqual(verdict.evidence, [{ kind: 'surface-node', seq: 0, id: null }])
})

test('G6b-V2 已归档：hidden-receipt / cause=plugin-archive（不是 visible）', () => {
  const { verdict } = judge(archivedSurface(), RECORD)
  assert.equal(verdict.state, 'hidden-receipt')
  assert.equal(verdict.visible, false)
  assert.equal(verdict.proof, 'observed')
  assert.equal(verdict.cause, 'plugin-archive')
  assert.ok(verdict.evidence.some((item) => item.kind === 'voucher' && item.id === 'v-root'))
})

test('G6b-V3 归档后 restore：visible-restored（两跳恢复链闭合）', () => {
  const { verdict } = judge(archivedSurface({ restore: true }), RECORD)
  assert.equal(verdict.state, 'visible-restored')
  assert.equal(verdict.visible, true)
  assert.equal(verdict.proof, 'observed')
  assert.ok(verdict.evidence.some((item) => item.kind === 'restore-node' && item.seq === 3))
})

test('G6b-V4 restore 后又被下一次归档压掉：absent（不是 visible-restored）', () => {
  const snapshot = snapshotOf({
    nodes: [4],
    events: [
      { seq: 0, type: 'user/message' },
      { seq: 1, type: 'assistant/message' },
      { seq: 2, type: 'user/message', sourceForm: RECEIPT_SOURCE_FORM, sourceKind: PLUGIN_SOURCE_KIND, shadow: [0, 1] },
      { seq: 3, type: 'user/message', sourceForm: RESTORE_SOURCE_FORM, sourceKind: PLUGIN_SOURCE_KIND, shadow: [2] },
      { seq: 4, type: 'user/message', sourceForm: RECEIPT_SOURCE_FORM, sourceKind: PLUGIN_SOURCE_KIND, shadow: [3] },
    ],
    vouchers: [
      { voucherId: 'v-a', recordIds: [RECORD], startSeq: 0, endSeq: 1, targetEventId: 2 },
      { voucherId: 'v-b', recordIds: [RECORD], startSeq: 3, endSeq: 3, targetEventId: 4 },
    ],
    recordSeq: { [RECORD]: 0 },
  })
  const { verdict } = judge(snapshot, RECORD)
  assert.equal(verdict.state, 'absent')
  assert.equal(verdict.visible, false)
  assert.equal(verdict.cause, 'not-covered')
})

test('G6b-V5 回执被宿主压缩掉（回执节点消失）：absent，不猜宿主意图', () => {
  const snapshot = snapshotOf({
    nodes: [9],
    events: [
      { seq: 0, type: 'user/message' },
      { seq: 1, type: 'assistant/message' },
      { seq: 2, type: 'user/message', sourceForm: RECEIPT_SOURCE_FORM, sourceKind: PLUGIN_SOURCE_KIND, shadow: [0, 1] },
      { seq: 9, type: 'user/message', shadow: [2] },
    ],
    vouchers: [{ voucherId: 'v-root', recordIds: [RECORD], startSeq: 0, endSeq: 1, targetEventId: 2 }],
    recordSeq: { [RECORD]: 0 },
  })
  const { verdict } = judge(snapshot, RECORD)
  assert.equal(verdict.state, 'absent')
  assert.equal(verdict.visible, false)
})

test('G6b-V6 forget：forgotten 覆盖一切可见证据，且永不注入', () => {
  const { verdict } = judge(archivedSurface({ forgotten: [RECORD] }), RECORD)
  assert.equal(verdict.state, 'forgotten')
  assert.equal(verdict.visible, false)
  assert.equal(verdict.cause, 'forgotten')
  // 即使源事件仍在活动面上，遗忘也是更高优先级
  const live = snapshotOf({ nodes: [0], events: [{ seq: 0 }], forgotten: [RECORD], recordSeq: { [RECORD]: 0 } })
  assert.equal(judge(live, RECORD).verdict.state, 'forgotten')
})

test('G6b-V7 forget 后 undo：按活动面重新判定（forgotten 集合已清）', () => {
  const snapshot = plainSurface()
  const before = judge({ ...snapshot, forgotten: [RECORD] }, RECORD).verdict
  const after = judge(snapshot, RECORD).verdict
  assert.equal(before.state, 'forgotten')
  assert.equal(after.state, 'visible-surface')
  assert.equal(before.dedupeKey, after.dedupeKey, '片段身份不随可见性变（键稳定，判定才是变量）')
  assert.notEqual(visibilityEpochOf({ ...snapshot, forgotten: [RECORD] }).digest, visibilityEpochOf(snapshot).digest)
})

test('G6b-V8 同文本的两条不同记录：两条独立片段（键不同）', () => {
  const snapshot = plainSurface()
  const text = '完全相同的正文'
  const a = judge(snapshot, RECORD, text).verdict
  const b = judge(snapshot, OTHER, text).verdict
  assert.equal(a.state, 'visible-surface')
  assert.equal(b.state, 'visible-surface')
  assert.notEqual(a.dedupeKey, b.dedupeKey)
  assert.equal(a.dedupeKey, dedupeKeyOf(SESSION, fragmentOf(RECORD, text)))
})

test('G6b-V9/V10 confirmed 与读租约都不是可见性输入（多带字段不改变判定）', () => {
  const snapshot = archivedSurface({ extra: { confirmedTurns: [1], readLease: { until: Date.now() + 60000 }, recallConfirmed: true } })
  const { verdict } = judge(snapshot, RECORD)
  assert.equal(verdict.state, 'hidden-receipt', '确认/租约字段不得把 hidden 变成 visible')
  assert.equal(verdict.visible, false)
})

test('G6b-V11 活动面读不到：unknown + cause=surface-unreadable，visible 必须是 null', () => {
  const out = visibilityOf({ snapshot: null, fragments: [fragmentOf(RECORD)], sessionKey: SESSION })
  assert.equal(out.ok, false)
  assert.equal(out.degraded, true)
  assert.equal(out.digest, 'unavailable')
  const verdict = out.verdicts[0]
  assert.equal(verdict.state, 'unknown')
  assert.equal(verdict.visible, null)
  assert.equal(verdict.proof, 'unknown')
  assert.equal(verdict.cause, 'surface-unreadable')
})

test('G6b-V12 跨会话片段：unknown / session-mismatch（不判定）', () => {
  const snapshot = plainSurface()
  const out = visibilityOf({
    snapshot,
    sessionKey: SESSION,
    fragments: [{ ...fragmentOf(RECORD), sessionKey: 'another-session' }],
  })
  assert.equal(out.verdicts[0].state, 'unknown')
  assert.equal(out.verdicts[0].cause, 'session-mismatch')
  assert.equal(out.verdicts[0].visible, null)
})

test('G6b-V13 重启：新实例缓存为空，不得继承旧结论（先 unknown，快照到了再判）', () => {
  const first = createVisibilityState()
  const snapshot = plainSurface()
  const fragments = [fragmentOf(RECORD)]
  const a = first.evaluate({ snapshot, fragments, sessionKey: SESSION })
  assert.equal(a.verdicts[0].state, 'visible-surface')
  const b = first.evaluate({ snapshot, fragments, sessionKey: SESSION })
  assert.equal(b.cache.hits, 1, '同实例同代际应命中缓存')
  const restarted = createVisibilityState()
  const c = restarted.evaluate({ snapshot: null, fragments, sessionKey: SESSION })
  assert.equal(c.verdicts[0].state, 'unknown', '重启后没有活动面证据时只能是 unknown')
  assert.equal(c.cache.hits, 0, '新实例不得继承任何缓存')
  assert.equal(c.cache.size, 1)
})

test('G6b-V14 tool/call 记录：not-applicable（log-only），即使误在活动面上也不判可见', () => {
  const snapshot = snapshotOf({
    nodes: [5],
    events: [{ seq: 5, type: 'tool/call' }],
    recordSeq: { [RECORD]: 5 },
  })
  const { verdict } = judge(snapshot, RECORD)
  assert.equal(verdict.state, 'not-applicable')
  assert.equal(verdict.visible, false)
  assert.equal(verdict.cause, 'not-applicable')
})

test('G6b-V15 metaOnly/工具结果记录：在活动面即 visible-surface', () => {
  const snapshot = snapshotOf({
    nodes: [1],
    events: [{ seq: 1, type: 'tool/result' }],
    recordSeq: { [RECORD]: 1 },
  })
  const { verdict } = judge(snapshot, RECORD)
  assert.equal(verdict.state, 'visible-surface')
  assert.equal(verdict.visible, true)
})

test('G6b-V16 回注包：登记命中=observed visible；只解析正文=unknown，永不 visible:true', () => {
  const base = {
    nodes: [5],
    events: [{ seq: 5, type: 'user/message', sourceForm: 'recall', sourceKind: PLUGIN_SOURCE_KIND, text: '回注包（命中 1 条）\n· ' + RECORD + '（相关度 0.900）首部：正文' }],
    recordSeq: { [RECORD]: 0 },
  }
  const registered = judge(snapshotOf({ ...base, registry: [{ seq: 5, bodyId: 'body-1', recordIds: [RECORD] }] }), RECORD).verdict
  assert.equal(registered.state, 'visible-recall-pack')
  assert.equal(registered.visible, true)
  assert.equal(registered.proof, 'observed')
  assert.equal(registered.cause, 'recall-registry-hit')

  const parsedOnly = judge(snapshotOf({ ...base, registry: null }), RECORD).verdict
  assert.equal(parsedOnly.state, 'unknown', '解析自产包正文只作补充证据（R-10）')
  assert.equal(parsedOnly.visible, null)
  assert.equal(parsedOnly.cause, 'recall-pack-parsed')

  const packText = '回注包（命中 1 条；来源 ID body-1）'
  const registryMiss = judge(snapshotOf({
    ...base,
    events: [{ seq: 5, type: 'user/message', sourceForm: 'recall', sourceKind: PLUGIN_SOURCE_KIND, text: packText }],
    registry: null,
  }), RECORD).verdict
  assert.equal(registryMiss.state, 'unknown')
  assert.equal(registryMiss.cause, 'recall-registry-miss', '包在面上但登记缺失 → unknown（R-10）')

  const registeredOther = judge(snapshotOf({
    ...base,
    events: [{ seq: 5, type: 'user/message', sourceForm: 'recall', sourceKind: PLUGIN_SOURCE_KIND, text: packText }],
    registry: [{ seq: 5, bodyId: 'body-1', recordIds: [OTHER] }],
  }), RECORD).verdict
  assert.equal(registeredOther.state, 'absent', '登记明确说了这条不在包里 → 可以说未覆盖（absent）')
  assert.equal(registeredOther.cause, 'not-covered')
})

/* ------------------------------------------------------------------ B epoch */

test('G6b-E1 空活动面：max 显式 = -1，摘要仍是 16 位 FNV（R-2/R-4）', () => {
  const epoch = visibilityEpochOf(snapshotOf({ nodes: [], events: [] }))
  assert.equal(epoch.ok, true)
  assert.equal(epoch.max, EMPTY_SURFACE_MAX)
  assert.equal(epoch.max, -1)
  assert.match(epoch.digest, /^[0-9a-f]{16}$/)
  // 命名隔离（R-3）：返回值里没有 epoch 字段，判定回执也没有
  assert.equal(Object.hasOwn(epoch, 'epoch'), false)
  const { verdict } = judge(snapshotOf({ nodes: [], events: [], recordSeq: { [RECORD]: 0 } }), RECORD)
  assert.equal(Object.hasOwn(verdict, 'epoch'), false)
  assert.equal(verdict.state, 'absent')
})

test('G6b-E2 摘要确定性：同输入同摘要；顺序无关；真变化必变（R-2）', () => {
  const a = visibilityEpochOf(archivedSurface())
  const b = visibilityEpochOf(archivedSurface())
  assert.equal(a.digest, b.digest)
  const vouchers = [
    { voucherId: 'v-2', recordIds: [OTHER], startSeq: 0, endSeq: 0, targetEventId: 2 },
    { voucherId: 'v-1', recordIds: [RECORD], startSeq: 0, endSeq: 1, targetEventId: 2 },
  ]
  const c = visibilityEpochOf(snapshotOf({ ...archivedSurface(), vouchers }))
  const d = visibilityEpochOf(snapshotOf({ ...archivedSurface(), vouchers: [...vouchers].reverse() }))
  assert.equal(c.digest, d.digest, '凭证顺序不是语义，摘要不得随顺序变')
  const changedContent = visibilityEpochOf(snapshotOf({
    ...plainSurface(),
    generations: { contentGeneration: 1, replaceGeneration: 0 },
  }))
  assert.notEqual(changedContent.digest, visibilityEpochOf(plainSurface()).digest, 'contentGeneration 必须进摘要（R-2 投影不改节点 seq）')
  const changedReplace = visibilityEpochOf(snapshotOf({
    ...plainSurface(),
    generations: { contentGeneration: 0, replaceGeneration: 1 },
  }))
  assert.notEqual(changedReplace.digest, visibilityEpochOf(plainSurface()).digest, 'replaceGeneration 必须进摘要')
  const forgotten = visibilityEpochOf({ ...plainSurface(), forgotten: [RECORD] })
  assert.notEqual(forgotten.digest, visibilityEpochOf(plainSurface()).digest, 'forget 必须改代际（缓存失效）')
})

test('G6b-E3 纯 append 增量：只有两代际都不变 + 节点尾部增长 + 其余材料相同才允许复用（R-2）', () => {
  const base = visibilityEpochOf(plainSurface())
  const appended = visibilityEpochOf(snapshotOf({
    ...plainSurface(),
    nodes: [0, 1, 2],
    events: [...plainSurface().events, { seq: 2, type: 'user/message' }],
  }))
  assert.equal(isPureAppendAdvance(base, appended), true)
  assert.equal(isPureAppendAdvance(appended, base), false, '节点不能缩短')
  const replaceBumped = visibilityEpochOf(snapshotOf({
    ...plainSurface(),
    nodes: [0, 1, 2],
    events: [...plainSurface().events, { seq: 2, type: 'user/message' }],
    generations: { contentGeneration: 0, replaceGeneration: 1 },
  }))
  assert.equal(isPureAppendAdvance(base, replaceBumped), false, 'replaceGeneration 变了就不是纯 append')
  const contentBumped = visibilityEpochOf(snapshotOf({
    ...plainSurface(),
    nodes: [0, 1, 2],
    events: [...plainSurface().events, { seq: 2, type: 'user/message' }],
    generations: { contentGeneration: 1, replaceGeneration: 0 },
  }))
  assert.equal(isPureAppendAdvance(base, contentBumped), false, 'contentGeneration 变了就不是纯 append')
  const unknownGen = visibilityEpochOf(snapshotOf({
    ...plainSurface(),
    nodes: [0, 1, 2],
    events: [...plainSurface().events, { seq: 2, type: 'user/message' }],
    generations: { contentGeneration: null, replaceGeneration: null },
  }))
  assert.equal(isPureAppendAdvance(unknownGen, unknownGen), false, '代际未知时不得假设没变')
  const replaced = visibilityEpochOf(snapshotOf({
    ...plainSurface(),
    nodes: [0, 2],
    events: [...plainSurface().events, { seq: 2, type: 'user/message', shadow: [1] }],
  }))
  assert.equal(isPureAppendAdvance(base, replaced), false, '非尾部增长（replace）不得复用')
  // 语义面：纯 append 时缓存可复用（省重判），非纯 append 时整批失效
  const state = createVisibilityState()
  state.evaluate({ snapshot: plainSurface(), fragments: [fragmentOf(RECORD)], sessionKey: SESSION })
  const reused = state.evaluate({ snapshot: snapshotOf({
    ...plainSurface(),
    nodes: [0, 1, 2],
    events: [...plainSurface().events, { seq: 2, type: 'user/message' }],
  }), fragments: [fragmentOf(RECORD)], sessionKey: SESSION })
  assert.equal(reused.cache.reused, true)
  assert.equal(reused.cache.hits, 1, '纯 append 后旧片段判定可复用（节点全部保留）')
  const invalidated = state.evaluate({ snapshot: snapshotOf({
    ...plainSurface(),
    generations: { contentGeneration: 2, replaceGeneration: 2 },
  }), fragments: [fragmentOf(RECORD)], sessionKey: SESSION })
  assert.equal(invalidated.cache.reused, false)
  assert.equal(invalidated.cache.hits, 0, '非纯 append 变化必须整批重判')
})

/* ------------------------------------------------------------------ C 决策 */

function verdictFactory(state, key) {
  return {
    contractVersion: VISIBILITY_CONTRACT_VERSION,
    claim: 'surface-projected',
    dedupeKey: key,
    visibilityDigest: '0123456789abcdef',
    state,
    visible: state === 'unknown' ? null : state.startsWith('visible-'),
    proof: state === 'unknown' ? 'unknown' : 'observed',
    cause: null,
    evidence: [],
  }
}

test('G6b-C1 三种结局：visible 跳过、not-visible 注入、unknown 必注入且可计数（R-1/R-9）', () => {
  const state = createVisibilityState()
  const FORGOTTEN = 'v3r-00000000000000cc'
  const ids = [RECORD, OTHER, FORGOTTEN]
  const fragments = ids.map((id) => fragmentOf(id))
  const judged = state.evaluate({
    snapshot: snapshotOf({
      ...plainSurface(),
      forgotten: [FORGOTTEN],
    }),
    fragments,
    sessionKey: SESSION,
  })
  const decision = state.plan({ digest: judged.digest, verdicts: judged.verdicts, turn: 1 })
  const byId = new Map(judged.verdicts.map((verdict, n) => [ids[n], verdict]))
  assert.equal(byId.get(RECORD).state, 'visible-surface')
  assert.equal(byId.get(OTHER).state, 'visible-surface')
  assert.equal(byId.get(FORGOTTEN).state, 'forgotten')
  assert.equal(decision.skip.length, 3)
  assert.equal(decision.inject.length, 0)

  // 未知宿主面：全部注入，且 unknown ⊆ inject（visible:null 永不进 skip）
  const unknownJudged = state.evaluate({ snapshot: null, fragments, sessionKey: SESSION })
  const unknownDecision = state.plan({ digest: unknownJudged.digest, verdicts: unknownJudged.verdicts, turn: 2 })
  assert.equal(unknownDecision.inject.length, 3)
  assert.equal(unknownDecision.unknown.length, 3)
  assert.deepEqual([...unknownDecision.unknown].sort(), [...unknownDecision.inject].sort())
  assert.equal(unknownDecision.skip.length, 0)
  for (const verdict of unknownJudged.verdicts) {
    assert.equal(verdict.visible, null)
    assert.equal(consumerStateOf(verdict), 'unknown')
  }
})

test('G6b-C2 有界重复：同回合 2 次后标 unknown-capped，但仍照常注入（R-11）', () => {
  const state = createVisibilityState()
  const fragments = [fragmentOf(RECORD)]
  const decisions = []
  for (let step = 1; step <= VISIBILITY_LIMITS.repeatTurn + 1; step += 1) {
    const judged = state.evaluate({ snapshot: null, fragments, sessionKey: SESSION })
    decisions.push(state.plan({ digest: judged.digest, verdicts: judged.verdicts, turn: 1 }))
  }
  const last = decisions[decisions.length - 1]
  assert.equal(last.inject.length, 1, 'unknown-capped 只作标记，不得改变注入决定')
  assert.equal(last.unknown.length, 1)
  assert.equal(last.capped.length, 1)
  assert.equal(decisions[0].capped.length, 0)
})

test('G6b-C3 会话上界：代际不变时同会话累计 4 次后标记（R-11）', () => {
  const state = createVisibilityState()
  const fragments = [fragmentOf(RECORD)]
  const capped = []
  for (let turn = 1; turn <= VISIBILITY_LIMITS.repeatSession + 1; turn += 1) {
    const judged = state.evaluate({ snapshot: null, fragments, sessionKey: SESSION })
    const decision = state.plan({ digest: judged.digest, verdicts: judged.verdicts, turn })
    capped.push(decision.capped.length)
  }
  assert.deepEqual(capped.slice(0, VISIBILITY_LIMITS.repeatSession), capped.slice(0, VISIBILITY_LIMITS.repeatSession).map(() => 0))
  assert.equal(capped[VISIBILITY_LIMITS.repeatSession], 1, '同会话超过上界必须标记')
})

test('G6b-C4 代际变化即重置未知计数（R-11）', () => {
  const state = createVisibilityState()
  const fragments = [fragmentOf(RECORD)]
  const unknown = state.evaluate({ snapshot: null, fragments, sessionKey: SESSION })
  state.plan({ digest: unknown.digest, verdicts: unknown.verdicts, turn: 1 })
  state.plan({ digest: unknown.digest, verdicts: unknown.verdicts, turn: 1 })
  const before = state.inspect()
  assert.equal(before.turnKeys, 1)
  const visible = state.evaluate({ snapshot: plainSurface(), fragments, sessionKey: SESSION })
  const decision = state.plan({ digest: visible.digest, verdicts: visible.verdicts, turn: 2 })
  assert.equal(decision.reset, true, '代际变化必须重置 unknown 计数')
  assert.equal(state.inspect().turnKeys, 0)
  assert.equal(state.inspect().sessionKeys, 0)
})

test('G6b-C5 每回合 unknown 字符预算只作可见标记（不改注入决定）', () => {
  const state = createVisibilityState()
  const fragments = [fragmentOf(RECORD), fragmentOf(OTHER)]
  const judged = state.evaluate({ snapshot: null, fragments, sessionKey: SESSION })
  const huge = VISIBILITY_LIMITS.unknownCharsPerTurn + 1
  const decision = state.plan({
    digest: judged.digest,
    verdicts: judged.verdicts,
    turn: 1,
    charsOf: () => huge,
  })
  assert.equal(decision.inject.length, 2)
  assert.equal(decision.unknown.length, 2)
  assert.ok(decision.capped.length >= 1)
  assert.ok(decision.unknownChars > VISIBILITY_LIMITS.unknownCharsPerTurn)
})

test('G6b-C6 v1 信任集：visible-restored / visible-recall-pack 判定保留，但消费者按 unknown 注入（R-9/R-12）', () => {
  assert.deepEqual(VISIBILITY_TRUSTED_STATES_V1, ['visible-surface', 'hidden-receipt', 'absent', 'forgotten', 'unknown'])
  const state = createVisibilityState()
  const verdicts = [verdictFactory('visible-restored', 'k1'), verdictFactory('visible-recall-pack', 'k2'), verdictFactory('visible-surface', 'k3')]
  const decision = state.plan({ digest: 'aaaaaaaaaaaaaaaa', verdicts, turn: 1 })
  assert.deepEqual(decision.skip, ['k3'])
  assert.deepEqual([...decision.inject].sort(), ['k1', 'k2'])
  assert.deepEqual([...decision.unknown].sort(), ['k1', 'k2'])
})

test('G6b-C7 缓存有容量上界：超过 stateMax 淘汰最旧并计数（不静默）', () => {
  const state = createVisibilityState({ limits: { ...VISIBILITY_LIMITS, stateMax: 2 } })
  const ids = ['v3r-0000000000000011', 'v3r-0000000000000022', 'v3r-0000000000000033']
  for (const id of ids) {
    const judged = state.evaluate({
      snapshot: snapshotOf({ nodes: [0], events: [{ seq: 0 }], recordSeq: { [id]: 0 } }),
      fragments: [fragmentOf(id)],
      sessionKey: SESSION,
    })
    assert.equal(judged.verdicts[0].state, 'visible-surface')
  }
  const info = state.inspect()
  assert.equal(info.cacheSize, 2)
  assert.ok(info.cacheEvictions >= 1)
})

test('G6b-C8 非法配置失败关闭：limits 与去重开关都不得静默降级', () => {
  assert.throws(() => createVisibilityState({ limits: { ...VISIBILITY_LIMITS, repeatTurn: 0 } }), /repeatTurn/)
  assert.throws(() => createVisibilityState({ limits: { ...VISIBILITY_LIMITS, stateMax: 1.5 } }), /stateMax/)
  assert.throws(() => createVisibilityState({ limits: { ...VISIBILITY_LIMITS, unknownCharsPerTurn: -1 } }), /unknownCharsPerTurn/)
  const state = createVisibilityState()
  assert.throws(
    () => state.evaluate({ snapshot: plainSurface(), fragments: [fragmentOf(RECORD)], sessionKey: '' }),
    /sessionKey/,
  )
  assert.throws(
    () => visibilityOf({ snapshot: plainSurface(), fragments: new Array(VISIBILITY_LIMITS.fragmentBatch + 1).fill(fragmentOf(RECORD)), sessionKey: SESSION }),
    /单批片段/,
  )
})

/* ------------------------------------------------------------------ D 归档意图 */

test('G6b-D1 归档意图 pending：absent/hidden 强制 unknown（R-6），visible-surface 不受影响', () => {
  const hidden = judge(archivedSurface({ intent: 'pending' }), RECORD).verdict
  assert.equal(hidden.state, 'unknown')
  assert.equal(hidden.visible, null)
  assert.equal(hidden.cause, 'archive-intent-pending')
  assert.ok(hidden.evidence.some((item) => item.kind === 'archive-intent'))

  const absent = judge(snapshotOf({
    ...plainSurface(),
    intent: 'pending',
    recordSeq: { [RECORD]: 7 },
  }), RECORD).verdict
  assert.equal(absent.state, 'unknown')
  assert.equal(absent.cause, 'archive-intent-pending')

  const visible = judge(snapshotOf({ ...plainSurface(), intent: 'pending' }), RECORD).verdict
  assert.equal(visible.state, 'visible-surface', '结构性强证据不因意图在飞而失效')
})

test('G6b-D2 归档意图 invalid/unreadable/缺失：失败关闭为 unknown，不是 absent', () => {
  for (const [intent, cause] of [
    ['invalid', 'archive-intent-invalid'],
    ['unreadable', 'archive-intent-unreadable'],
  ]) {
    const verdict = judge(snapshotOf({ ...plainSurface(), intent, recordSeq: { [RECORD]: 7 } }), RECORD).verdict
    assert.equal(verdict.state, 'unknown')
    assert.equal(verdict.cause, cause)
  }
  const missingSnapshot = snapshotOf({ ...plainSurface(), recordSeq: { [RECORD]: 7 } })
  delete missingSnapshot.archiveIntent
  const missing = judge(missingSnapshot, RECORD).verdict
  assert.equal(missing.state, 'unknown')
  assert.equal(missing.cause, 'archive-intent-unreadable', '没观测到意图 ≠ 没有意图（不可读）')
})

/* ------------------------------------------------------------------ E shadow 纪律 */

test('G6b-E4 assistant/message 不得携带 sourceEventSeqs：一律忽略，不当覆盖证据（R-7）', () => {
  const snapshot = snapshotOf({
    nodes: [2],
    events: [
      { seq: 0, type: 'user/message' },
      { seq: 2, type: 'assistant/message', shadow: [0] },
    ],
    recordSeq: { [RECORD]: 0 },
  })
  const { verdict } = judge(snapshot, RECORD)
  assert.equal(verdict.state, 'absent', '复述文本只能靠直接节点命中，不能当覆盖证据')
  assert.equal(verdict.visible, false)
  assert.equal(visibilityEpochOf(snapshot).ignoredShadows, 1)
})

test('G6b-E5 超过证明跳数（≥3 层遮蔽）：不推测——纯遮蔽链落 absent（注入方向同 unknown）', () => {
  const snapshot = snapshotOf({
    nodes: [5],
    events: [
      { seq: 0, type: 'user/message' },
      { seq: 2, type: 'user/message', sourceForm: RECEIPT_SOURCE_FORM, sourceKind: PLUGIN_SOURCE_KIND, shadow: [0] },
      { seq: 3, type: 'user/message', sourceForm: RECEIPT_SOURCE_FORM, sourceKind: PLUGIN_SOURCE_KIND, shadow: [2] },
      { seq: 4, type: 'user/message', sourceForm: RECEIPT_SOURCE_FORM, sourceKind: PLUGIN_SOURCE_KIND, shadow: [3] },
      { seq: 5, type: 'user/message', sourceForm: RECEIPT_SOURCE_FORM, sourceKind: PLUGIN_SOURCE_KIND, shadow: [4] },
    ],
    recordSeq: { [RECORD]: 0 },
  })
  const { verdict } = judge(snapshot, RECORD)
  assert.equal(verdict.state, 'absent')
  assert.equal(verdict.visible, false, '深层链路不推测可见：绝不因为「可能有恢复」就跳过注入')
})

/* ------------------------------------------------------------------ F 合同自检 */

test('G6b-F1 合同封闭集：8 值状态、cause 封闭、四通道、可见三态一致', () => {
  assert.equal(VISIBILITY_STATES.length, 8)
  for (const cause of VISIBILITY_HIDDEN_CAUSES) {
    assert.ok(VISIBILITY_CAUSES.includes(cause), '隐藏通道必须纳入 cause 封闭集：' + cause)
  }
  assert.deepEqual(VISIBILITY_HIDDEN_CAUSES, ['plugin-archive', 'host-compaction', 'host-prune', 'system-message'])
  const cases = [
    ['forgotten', false],
    ['absent', false],
    ['hidden-receipt', false],
    ['visible-surface', true],
    ['visible-restored', true],
    ['visible-recall-pack', true],
    ['not-applicable', false],
    ['unknown', null],
  ]
  for (const [state, visible] of cases) {
    const verdict = verdictFactory(state, 'key-' + state)
    assert.equal(verdict.visible, visible)
    assert.equal(verdict.visible !== null, state !== 'unknown', 'R-1：visible 非 null ⇔ 非 unknown')
  }
})
/* ------------------------------------------------------------------ G 审查修复（P1-1 / P2-1） */

test('G6b-G1 活动面顺序不是判定输入：位置 splice 的 [4,2,3] 必须正确判定（P1-1）', () => {
  const events = [
    { seq: 0, type: 'user/message' },
    { seq: 1, type: 'assistant/message' },
    { seq: 2, type: 'user/message' },
    { seq: 3, type: 'assistant/message' },
    { seq: 4, type: 'user/message', sourceForm: RECEIPT_SOURCE_FORM, sourceKind: PLUGIN_SOURCE_KIND, shadow: [0, 1] },
  ]
  const vouchers = [{ voucherId: 'v-1', recordIds: [RECORD], startSeq: 0, endSeq: 1, targetEventId: 4 }]
  const recordSeq = { [RECORD]: 0, [OTHER]: 2 }
  // 真实宿主归档后的活动面（test/v3-archive-e2e.test.mjs:68 断言 [5,2,3,4]）：
  // 回执在原位置 splice 进来，seq 不是升序。旧实现按「严格升序」判 → 整份快照不可读。
  const outOfOrder = snapshotOf({ nodes: [4, 2, 3], events, vouchers, recordSeq })
  const hidden = judge(outOfOrder, RECORD).verdict
  assert.equal(hidden.state, 'hidden-receipt')
  assert.equal(hidden.visible, false)
  assert.equal(hidden.cause, 'plugin-archive')
  const visible = judge(outOfOrder, OTHER).verdict
  assert.equal(visible.state, 'visible-surface')
  assert.equal(visible.visible, true)

  // 同一节点集合、不同顺序 → 摘要与 max 必须相同（顺序不是语义，只做规范形）
  const sortedEdges = snapshotOf({ nodes: [2, 3, 4], events, vouchers, recordSeq })
  assert.equal(visibilityEpochOf(outOfOrder).digest, visibilityEpochOf(sortedEdges).digest)
  assert.equal(visibilityEpochOf(outOfOrder).max, 4, 'max 必须取最大值而不是末元素')
  assert.equal(visibilityEpochOf(sortedEdges).max, 4)
})

test('G6b-G2 重复活动面节点：unreadable（失败关闭），不接受同一节点出现两次', () => {
  const duplicated = snapshotOf({ nodes: [0, 0], events: [{ seq: 0 }] })
  const out = visibilityOf({ snapshot: duplicated, fragments: [fragmentOf(RECORD)], sessionKey: SESSION })
  assert.equal(out.ok, false)
  assert.equal(out.degraded, true)
  assert.equal(out.verdicts[0].state, 'unknown')
  assert.equal(out.verdicts[0].cause, 'surface-unreadable')
  // 防误杀对照：同一集合去重后（[0]）是可读的
  assert.equal(visibilityOf({ snapshot: snapshotOf({ nodes: [0], events: [{ seq: 0 }] }), fragments: [fragmentOf(RECORD)], sessionKey: SESSION }).ok, true)
})

test('G6b-G3 快照属于别的会话：整批 unknown / session-mismatch（P2-1）', () => {
  // 片段**不带** sessionKey（recall 路径正是这种）：只看片段字段会漏判，必须看快照会话。
  const otherSession = snapshotOf({ ...plainSurface(), sessionKey: 'session-b' })
  const out = visibilityOf({ snapshot: otherSession, fragments: [fragmentOf(RECORD)], sessionKey: SESSION })
  assert.equal(out.ok, true, '快照本身形状可读')
  assert.equal(out.crossSession, true)
  assert.equal(out.degraded, true, '跨会话必须按降级显式上报，不得静默')
  assert.equal(out.reason, 'session-mismatch')
  assert.equal(out.verdicts[0].state, 'unknown')
  assert.equal(out.verdicts[0].visible, null)
  assert.equal(out.verdicts[0].cause, 'session-mismatch')
  // 同会话照常判定（防误杀）
  assert.equal(visibilityOf({ snapshot: plainSurface(), fragments: [fragmentOf(RECORD)], sessionKey: SESSION }).verdicts[0].state, 'visible-surface')
})
