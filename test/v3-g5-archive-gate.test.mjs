/**
 * G5 应用层闸门：显式策略检查**挂**在既有 batchSize 闸门之上（0.15.0 候选，默认关闭）。
 *
 * 本套件钉的是「off 路径逐字节等价 + on 路径只改调度时机」：
 * 1. **旧策略回归**：安全闭包/多段提交/判负/等待面的结果用 HEAD 抓的 sha256 冻结
 *    （两个 off 入口——不传 policy、传 policy 但 enabled:false——必须都命中同一份指纹）；
 * 2. 策略 defer 只"等"：surface / voucher / intent / 记录一概不动，候选原样留在活动面；
 * 3. 策略 allow 后提交的段边界、回执数量、恢复能力与 off 完全一致（不合并事件/回执）；
 * 4. 显式 now/compact（lane=manual）绕节奏门，但仍不绕 pin/闭包/净收益/H=200；
 * 5. 没有安全候选时如实报告（允许调度但没有候选），不为降 token 丢数据；
 * 6. 部分提交失败/pending intent/restore 一致性与 off 同一套事务语义；
 * 7. C7 边界：application/domain 不 import 任何观测模块，端口数据只能**以参数**注入。
 *
 * 度量说明（§11）：这里只证明**调度次数/开销与判据**，不宣称省 token、不宣称省费——
 * 收益必须等 G8 的真实宿主/usage 对照。token/费用估算不在本层出现（也不伪造）。
 */
import { createHash, randomUUID } from 'node:crypto'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createV3Runtime } from '../src/v3/composition/composition.mjs'
import { createArchiveService } from '../src/v3/application/archive.mjs'
import { createFakeSession } from './helpers/fake-session.mjs'
import { seqOfDshEventId } from '../src/v3/adapters/host/dsh-host.mjs'
import { textOfDshEvent } from '../src/v3/entry/v3-entry.mjs'
import { archiveIntentPath, clearArchiveIntentIfMatches, readArchiveIntent, writeArchiveIntent } from '../src/v3/adapters/storage/archive-intent.mjs'
import { normalizeSchedulePolicyConfig } from '../src/v3/contracts/archive-schedule-policy.mjs'
import { POLICY_INPUT_PORT } from '../src/v3/contracts/observation-policy-port.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SESSION_ID = 's-g5'

/**
 * HEAD（08345de1）抓的**行为指纹**：record ID 归一后 JSON.stringify(…, 2) 的 sha256。
 * 抓取脚本与命令见证据 `G5-实现.md` §5；改动使任一指纹变化 = off 路径不再逐字节等价。
 */
const HEAD_GOLDEN = Object.freeze({
  waiting: '487cd290a15508aff3cd56f50211fcebe072cedf05d9f1678573ee957716e598',
  planned: '660cb98815dc34859fa2791ad0761370781d5548ac234f30282420d2d0edff39',
  // P2-19（0.15.1）**有意重抓**：多段批的顶层 `receiptText` 旧实现只取首段，而
  // `receiptChars` 是各段之和——两个字段互相矛盾。现在 `receiptText` 按段序拼接、
  // `receiptChars` 与之同源。单段批仍与旧值逐字节相同（不传 policy 的其他场景未变）。
  archived: '8b3e2aed34be5cc1e529e2d1b0e8e7c7cda8e1f4f85761d08ef4a706c7aa1b08',
  notWorth: '8dee8fca2322c068abd15b09c970a45706d4b1cc1184a7a5eff3b01bdb596235',
})

const normalizeRecordIds = (value) => JSON.parse(JSON.stringify(value, (key, inner) => (
  typeof inner === 'string' ? inner.replace(/v3r-[0-9a-f]+/g, '<rid>') : inner
)))
const digestOf = (value) => createHash('sha256').update(JSON.stringify(normalizeRecordIds(value), null, 2)).digest('hex')

const CONFIG = Object.freeze({
  enabled: true,
  minGrowthMessages: 5,
  minRequestGap: 3,
  maxRequestGap: 10,
  backlogCoalesceUnits: 20,
})
const FINGERPRINT = normalizeSchedulePolicyConfig(CONFIG).fingerprint

/** 只读 policy 端口形状（真实端口校验过的输入；本层只读 components.messages.count）。 */
const policyInputOf = (count) => ({
  contractVersion: 1,
  session: { id: 'sess-local-' + 'a'.repeat(16), source: 'local-diagnostic' },
  window: { fromSeq: 1, toSeq: 2, rows: 2, legacyRows: 0, skippedRows: 0 },
  projection: { epoch: 1, lastPhase: 'append', lastMessageChange: 'appended', phaseCounts: { initial: 0, steady: 0, append: 2, 'epoch-start': 0 } },
  components: { messages: { digest: 'a'.repeat(16), count, generation: 1 }, system: { coverage: 'unobservable' }, tools: { coverage: 'unobservable' } },
  usage: {
    counted: 1, duplicates: 0, late: 0, unknownArrival: 0, unsampledLegacy: 0,
    totals: { inputTokens: 10, outputTokens: 2, totalTokens: null, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null },
    availability: { inputTokens: 'present', outputTokens: 'present', totalTokens: 'missing', cacheReadTokens: 'missing', cacheWriteTokens: 'missing', reasoningTokens: 'missing' },
    cacheReadRatio: null,
    additivity: { provider: 'deepseek', cacheFieldsAddable: true, reasoningExtraTokens: null, verified: 'source-read' },
  },
  layers: null,
})
const policyStateOf = ({ ordinal = 9, baseline = 5, baselineCount = 100, fingerprint = FINGERPRINT } = {}) => ({
  contractVersion: 1,
  attemptOrdinal: ordinal,
  lastCommit: { attemptOrdinal: baseline, messagesCount: baselineCount, configFingerprint: fingerprint },
})
/** 增长 5（100→105）、间隔 4（5→9）：两门都满足 → allow。 */
const allowPolicy = () => ({ config: CONFIG, state: policyStateOf(), input: policyInputOf(105) })
/** 增长 1、间隔 1：两门都不满足 → defer。 */
const deferPolicy = () => ({ config: CONFIG, state: policyStateOf({ ordinal: 6, baseline: 5, baselineCount: 100 }), input: policyInputOf(101) })

function pushBigStep(session, index) {
  session.append('step/start', { turn: 1, step: index })
  session.pushAssistant(('第 ' + index + ' 步数据 ').repeat(120))
  session.append('step/end', { turn: 1, step: index })
}
function pushTinyStep(session, index) {
  session.append('step/start', { turn: 1, step: index })
  session.append('assistant/message', {
    message: { role: 'assistant', content: [{ type: 'tool-call', callId: 'c' + index, name: 'run', arguments: '{"code":"1"}' }] },
  })
  session.append('tool/result', { message: { role: 'tool', toolCallId: 'c' + index, content: [{ type: 'text', text: 'ok' }] } })
  session.append('step/end', { turn: 1, step: index })
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

/**
 * 夹具：contextWindow(0) + user(1) + N 个步骤（每步 start/assistant/end，assistant 在 seq 3i）。
 * 返回真实 composition runtime + archive service（含真实 archive-intent journal）。
 */
async function withArchive({ steps = 0, tiny = false, pinStep = null, storeWrap = null } = {}, body) {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-g5-gate-'))
  const session = createFakeSession({ cwd: 'C:\\ws', contextWindow: 1000000, id: SESSION_ID })
  session.pushContextWindow(1000000)
  session.pushUser('开始')
  for (let index = 1; index <= steps; index += 1) {
    if (tiny) pushTinyStep(session, index)
    else pushBigStep(session, index)
  }
  const runtime = await createV3Runtime({ v3Root: root, dshSession: session, sessionKey: SESSION_ID })
  try {
    const rows = session.log.map((event) => ({ event, text: textOfDshEvent(event), meta: {} }))
    await runtime.handleDshEventBatch(rows)
    const store = storeWrap === null ? runtime.store : storeWrap(runtime.store)
    const journal = {
      write: (data) => writeArchiveIntent(root, SESSION_ID, data),
      read: () => readArchiveIntent(root, SESSION_ID),
      clear: (expected) => clearArchiveIntentIfMatches(root, SESSION_ID, expected),
    }
    const archive = createArchiveService({ random: { uuid: () => randomUUID() }, store, host: runtime.host, clock: { now: () => 1 }, intent: journal })
    const seqToRecordId = await seqMapOf(runtime.store)
    const surfaceNodes = await runtime.host.surfaceNodes()
    const pinnedSeqs = pinStep === null ? new Set() : new Set([pinStep * 3])
    const args = { sessionId: SESSION_ID, events: session.log, surfaceNodes, seqToRecordId, retainSteps: 1, batchSteps: 10, pinnedSeqs, summary: true }
    return await body({ root, session, runtime, archive, store, args, surfaceNodes })
  } finally {
    runtime.close()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
}

// ---------------------------------------------------------------- off 路径（旧策略回归）

test('off 路径逐字节等价：不传 policy 与 enabled:false 都命中 HEAD 抓的行为指纹', async () => {
  // A：等待面（10 步，retain 1 → 窗口外 9 < 阈值 10）
  await withArchive({ steps: 10 }, async ({ archive, args }) => {
    const waiting = await archive.planSteps(args)
    assert.equal(waiting.status, 'no-candidate')
    assert.equal(waiting.reason, 'waiting-batch')
    assert.equal(digestOf(waiting), HEAD_GOLDEN.waiting, '等待面结果必须与 HEAD 逐字节一致')
    assert.equal('policy' in waiting, false, 'off 路径不得新增字段')
    const waitingOff = await archive.planSteps({ ...args, policy: { config: { enabled: false } } })
    assert.equal(digestOf(waitingOff), HEAD_GOLDEN.waiting, '显式关闭与不传 policy 必须同一份字节')
  })

  // B：多段计划 + 多段提交（13 步，pin 第 4 步 → 3 步 + 6 步两段）
  await withArchive({ steps: 13, pinStep: 4 }, async ({ archive, args }) => {
    const planned = await archive.planSteps(args)
    assert.equal(planned.status, 'planned')
    assert.equal(planned.segments.length, 2)
    assert.equal(digestOf(planned), HEAD_GOLDEN.planned, '计划结果必须与 HEAD 逐字节一致')
    assert.equal('policy' in planned, false, 'off 路径不得新增字段')
    const plannedOff = await archive.planSteps({ ...args, policy: { config: { enabled: false } } })
    assert.equal(digestOf(plannedOff), HEAD_GOLDEN.planned)
    const archived = await archive.archiveStepBatch(args)
    assert.equal(archived.status, 'archived')
    assert.equal(archived.committedCount, 2)
    assert.equal(digestOf(archived), HEAD_GOLDEN.archived, '提交结果必须与 HEAD 逐字节一致')
    assert.equal('policy' in archived, false, 'off 路径不得新增字段')
  })

  // C：判负（12 个 mini 步：回执比原文长）
  await withArchive({ steps: 12, tiny: true }, async ({ archive, args }) => {
    const notWorth = await archive.planSteps(args)
    assert.equal(notWorth.status, 'not-worth')
    assert.equal(digestOf(notWorth), HEAD_GOLDEN.notWorth, '判负结果必须与 HEAD 逐字节一致')
    const notWorthOff = await archive.planSteps({ ...args, policy: { config: { enabled: false } } })
    assert.equal(digestOf(notWorthOff), HEAD_GOLDEN.notWorth)
  })
})

test('策略开启但配置非法：候选保持关闭（fallback），归档行为与 off 完全一致并说明原因', async () => {
  await withArchive({ steps: 13, pinStep: 4 }, async ({ archive, args }) => {
    const off = await archive.planSteps(args)
    const invalid = await archive.planSteps({ ...args, policy: { config: { enabled: 'yes' } } })
    assert.equal(invalid.status, 'planned', '非法配置不得改变能不能归档')
    assert.equal(invalid.policy.decision, 'fallback')
    assert.equal(invalid.policy.reason, 'policy-config-invalid')
    assert.match(invalid.policy.configError, /enabled/)
    assert.equal(invalid.policy.enabled, false)
    const { policy, ...rest } = invalid
    assert.equal(digestOf(rest), digestOf(off), '除去可见的 policy 说明，结果必须与 off 完全相同')
  })
})

// ---------------------------------------------------------------- defer：只等，不动任何东西

test('策略 defer：surface/voucher/intent/记录一概不动，候选原样留在活动面', async () => {
  await withArchive({ steps: 13, pinStep: 4 }, async ({ root, runtime, archive, args, surfaceNodes, session }) => {
    const before = [...surfaceNodes]
    const logBefore = session.log.length
    const deferred = await archive.archiveStepBatch({ ...args, policy: deferPolicy() })
    assert.equal(deferred.status, 'policy-deferred', JSON.stringify(deferred))
    assert.equal(deferred.reason, 'rhythm-deferred')
    assert.equal(deferred.policy.scheduled, false)
    assert.equal(deferred.policy.safeCandidates, 2, '安全候选已经选出来了（说明闸门在安全闭包之后）')
    assert.deepEqual(deferred.policy.needed, { growthMessages: 4, requests: 2 })
    assert.equal('items' in deferred, false, 'defer 不得读记录/生成回执')
    assert.equal('recordIds' in deferred, false)
    assert.deepEqual(await runtime.host.surfaceNodes(), before, 'defer 不得改活动面')
    assert.equal((await runtime.store.listVouchers()).length, 0, 'defer 不得写凭证')
    assert.equal(await readArchiveIntent(root, SESSION_ID), null, 'defer 不得占 intent 槽')
    assert.equal(session.log.length, logBefore, 'defer 不得向会话日志追加任何东西')
  })
})

test('重复调用/重试不额外触发：同一请求序号重复评估给出同一决策，间隔不累计', async () => {
  await withArchive({ steps: 13, pinStep: 4 }, async ({ archive, args }) => {
    const first = await archive.planSteps({ ...args, policy: deferPolicy() })
    const second = await archive.planSteps({ ...args, policy: deferPolicy() })
    assert.equal(first.status, 'policy-deferred')
    assert.equal(JSON.stringify(first.policy), JSON.stringify(second.policy), '同一次真实请求的两次尝试必须同结论')
    assert.equal(second.policy.requestsSinceCommit, 1, '重试不是新请求：间隔不得被累加')
    // 真正的下一次请求（序号 +1）仍然是 1 次间隔 → 还是 defer
    const next = await archive.planSteps({ ...args, policy: { ...deferPolicy(), state: policyStateOf({ ordinal: 7, baseline: 5, baselineCount: 100 }) } })
    assert.equal(next.policy.requestsSinceCommit, 2)
    assert.equal(next.status, 'policy-deferred')
  })
})

// ---------------------------------------------------------------- allow：只改时机，不改段/回执/事务

test('策略 allow：段边界、回执数量、恢复能力与 off 完全一致（不合并事件/回执/用户历史）', async () => {
  let offResult
  await withArchive({ steps: 13, pinStep: 4 }, async ({ archive, args }) => {
    offResult = await archive.archiveStepBatch(args)
  })
  await withArchive({ steps: 13, pinStep: 4 }, async ({ archive, args }) => {
    const archived = await archive.archiveStepBatch({ ...args, policy: allowPolicy() })
    assert.equal(archived.status, 'archived', JSON.stringify(archived))
    assert.equal(archived.policy.scheduled, true)
    assert.equal(archived.policy.reason, 'rhythm-satisfied')
    assert.equal(archived.policy.growthMessages, 5)
    // 段/回执与 off 逐字段一致：策略只决定"现在调度"，不合并任何内容
    for (const key of ['committedCount', 'steps', 'startSeq', 'endSeq', 'receiptSeqs']) {
      assert.deepEqual(archived[key], offResult[key], '允许调度不得改变 ' + key)
    }
    assert.equal((await archive.history()).total, offResult.committedCount, '每段仍各记一张凭证')
    // 策略状态：提交成功才产出 nextState（交给调用方持久化）
    assert.equal(archived.policy.nextState.contractVersion, 1)
    assert.equal(archived.policy.nextState.attemptOrdinal, 9)
    assert.equal(archived.policy.nextState.lastCommit.messagesCount, 105)
    assert.equal(archived.policy.nextState.lastCommit.configFingerprint, FINGERPRINT)
    // 除去策略轨迹，提交结果与 off 的字节一致
    const { policy, ...rest } = archived
    assert.equal(digestOf(rest), digestOf(offResult))
  })
})

test('显式 now/compact 绕节奏门但不绕安全：pin 队头不被遮蔽，manual 只提交 pin 之后的安全段', async () => {
  await withArchive({ steps: 13, pinStep: 4 }, async ({ runtime, archive, args }) => {
    const manual = await archive.archiveStepBatch({ ...args, lane: 'manual', policy: deferPolicy() })
    assert.equal(manual.status, 'archived', JSON.stringify(manual))
    assert.equal(manual.policy.reason, 'manual-bypass', 'manual 通道绕的是节奏门')
    assert.equal(manual.committedCount, 2, '两段安全段照常提交：段边界仍由安全判据决定')
    const nodes = await runtime.host.surfaceNodes()
    assert.ok(nodes.includes(12), 'pin 节点（step4 的 assistant）必须留在活动面')
    // H=200 上限不受策略影响：显式动作也不能一次压超过选择器上限的候选
    assert.ok(manual.steps <= 200)
  })
})

test('没有安全候选时如实报告：策略允许调度但没有候选 → no-candidate + scheduled:false，不丢数据', async () => {
  await withArchive({ steps: 10 }, async ({ runtime, archive, args, surfaceNodes }) => {
    const idle = await archive.planSteps({ ...args, policy: allowPolicy() })
    assert.equal(idle.status, 'no-candidate', '没有安全候选时不得因策略改判据')
    assert.equal(idle.reason, 'waiting-batch')
    assert.equal(idle.policy.scheduled, false)
    assert.equal(idle.policy.safeCandidates, 0)
    assert.equal(idle.policy.decision, 'allow', '压力/节奏已允许调度，但现场没有安全候选')
    assert.deepEqual(await runtime.host.surfaceNodes(), surfaceNodes, '不压任何东西')
    assert.equal((await runtime.store.listVouchers()).length, 0)
  })
})

test('积压合并只合并调度意图：积压 ≥ 门槛时照样按 batchSize 窗口提交，回执与段不合并', async () => {
  let offResult
  await withArchive({ steps: 33 }, async ({ archive, args }) => {
    offResult = await archive.archiveStepBatch(args)
  })
  await withArchive({ steps: 33 }, async ({ archive, args }) => {
    // 32 个候选 ≥ backlogCoalesceUnits(20)：即使增长/间隔都不满足也要调度（防积压饥饿）
    const coalesced = await archive.archiveStepBatch({
      ...args,
      policy: { config: CONFIG, state: policyStateOf({ ordinal: 6, baseline: 5 }), input: policyInputOf(100) },
    })
    assert.equal(coalesced.status, 'archived', JSON.stringify(coalesced))
    assert.equal(coalesced.policy.reason, 'backlog-coalesce')
    assert.equal(coalesced.policy.pendingUnits, 32)
    for (const key of ['committedCount', 'steps', 'startSeq', 'endSeq', 'receiptSeqs']) {
      assert.deepEqual(coalesced[key], offResult[key], '积压合并不得改变段/回执（只合并调度意图）')
    }
  })
})

// ---------------------------------------------------------------- 事务：部分失败 / intent / restore

test('部分提交失败：已提交段照常入账、失败段保留 intent、restore 仍可用（与 off 同一套事务）', async () => {
  let calls = 0
  const storeWrap = (store) => Object.assign({}, store, {
    appendVoucher: async (voucher) => {
      calls += 1
      if (calls >= 2) throw new Error('voucher 写入失败注入（第二段）')
      return store.appendVoucher(voucher)
    },
  })
  await withArchive({ steps: 13, pinStep: 4, storeWrap }, async ({ root, archive, args }) => {
    const partial = await archive.archiveStepBatch({ ...args, policy: allowPolicy() })
    assert.equal(partial.status, 'partial', JSON.stringify(partial))
    assert.equal(partial.committedCount, 1, '第一段已提交')
    assert.equal(partial.failed.phase, 'voucher')
    assert.equal(partial.policy.scheduled, true)
    assert.equal(partial.policy.nextState.lastCommit.messagesCount, 105, '已提交段仍要更新策略基线')
    assert.equal(partial.remaining.length, 1, '失败段及之后都在未提交账里')
    const kept = await readArchiveIntent(root, SESSION_ID)
    assert.ok(kept !== null, '失败段必须保留 intent 供对账补凭证')
    assert.equal(kept.receiptText, partial.failedSegment.receiptText, 'intent 必须指向失败段的回执')
    assert.equal((await archive.history()).total, 1, '只有已提交段有凭证')
    const restored = await archive.restoreVoucher(0)
    assert.equal(restored.restored, true, JSON.stringify(restored))
  })
})

// ---------------------------------------------------------------- C7 边界 + 端口闭环

test('C7：application/domain 不 import 任何观测模块；policy 数据只能经端口校验后以参数注入', async () => {
  const OBSERVATION_MODULES = [
    'contracts/cache-observation.mjs', 'contracts/observation-capability.mjs',
    'contracts/observation-lifecycle.mjs', 'contracts/usage-normalization.mjs',
    'contracts/observation-policy-port.mjs', 'adapters/storage/usage-log.mjs',
  ]
  for (const rel of ['src/v3/application/archive.mjs', 'src/v3/domain/archive/schedule-policy.mjs']) {
    const source = await readFile(path.join(HERE, '..', rel), 'utf8')
    for (const match of source.matchAll(/(?:^|\n)\s*(?:import|export)\s+(?:[\w$\{\},\s*]+\s+from\s+)?['"]([^'"]+)['"]/g)) {
      const target = path.relative(path.join(HERE, '..', 'src/v3'), path.resolve(path.dirname(path.join(HERE, '..', rel)), match[1])).replaceAll('\\', '/')
      assert.equal(OBSERVATION_MODULES.includes(target), false, rel + ' 不得直接 import 观测模块：' + target)
    }
  }
  // 端口闭环：真实 POLICY_INPUT_PORT 校验过的输入可以直接喂给策略（无需决策层认识观测模块）
  const validated = POLICY_INPUT_PORT.validate(policyInputOf(105))
  assert.equal(validated.ok, true, JSON.stringify(validated))
  await withArchive({ steps: 13, pinStep: 4 }, async ({ archive, args }) => {
    const planned = await archive.planSteps({
      ...args,
      policy: { config: CONFIG, state: policyStateOf(), input: validated.input },
    })
    assert.equal(planned.status, 'planned')
    assert.equal(planned.policy.reason, 'rhythm-satisfied', '端口输入通过校验后即可驱动判据')
    assert.equal(planned.policy.growthMessages, 5)
  })
})
