/**
 * G3 生命周期关联（fake request adapter 驱动：重试 / 取消 / 流式重复 / 迟到乱序）。
 *
 * ## 判据来源
 * - 开发流程 §9.4：用 session/provider/model/logical request/attempt 关联生命周期；
 *   覆盖 retry、取消、流式完成、usage 迟到/乱序；无原生 ID 用**本地诊断 ID 并标来源**；
 *   不能可靠配对记 unpaired，**不拿时间相近强配**。
 * - 开发流程 §9.1：工具重试不是一次请求 —— 同一步内每次 llm 调用是独立 attempt。
 * - 开发流程 §9.5：重复流式 usage **不累加**；缺失用 null。
 * - P0 宿主合同 §2.9：宿主没有 requestId；turn/step/usage 由 `assistant/message` 自带。
 *
 * ## 这个套件证明了什么 / 没证明什么
 * 证明：**fake 端口 + 逻辑时序**下，关联不串会话、不双计、不按时间强配、旧样本不被改写，
 *      且 `counted` 规则让汇总只数一次。
 * 没证明：真实宿主 `llm/stream` 的装配与真实 usage 到达形态（entry 接线属集成分批；
 *      本轮 entry 只读）。所以本文件不声称"已在真实宿主上验证关联"。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { appendCacheObservation, readObservationPolicyInput } from '../src/v3/adapters/storage/usage-log.mjs'
import {
  ATTEMPT_STATES,
  CORRELATION_REASONS,
  DIAGNOSTIC_ID_SOURCE,
  LIFECYCLE_CONTRACT_VERSION,
  USAGE_ARRIVAL_STATES,
  USAGE_SAMPLE_POLICY,
  attemptRefOf,
  lifecycleSectionOf,
  logicalRequestRefOf,
  sanitizeLifecycleSection,
  sessionRefOf,
  usageArrivalOf,
} from '../src/v3/contracts/observation-lifecycle.mjs'

const MODE_PREFIX = 'mcl-g3-lifecycle-'

async function withDir(body) {
  const dir = await mkdtemp(path.join(tmpdir(), MODE_PREFIX))
  try { return await body(dir) } finally { await rm(dir, { recursive: true, force: true }).catch(() => {}) }
}

async function readRows(file) {
  const text = await readFile(file, 'utf8')
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

/**
 * fake request adapter —— 只模拟「宿主在一次 step 里发了几次 llm 调用」这件事：
 *
 * - `startAttempt` 对应一次真实的 llm 调用（重试 = 新 attempt，**不是**一次请求的重复计数）；
 * - `finishAttempt` 对应流式完成：usage 到达后落一条观测行；
 * - 失败的 attempt 不产 usage ⇒ 不产行（宿主行为：无 assistant 事件就没有 usage）；
 * - `usageSeen` 让同一个 attempt 的第二个 usage chunk 判为 `duplicate`；
 * - `maxAttemptSeen` 是**本会话已见过的最大 attempt**，用于判"迟到"（与时间无关）。
 *
 * 它不构造请求体、不碰网络：本文件证明的是**逻辑时序**，不是真实 wire。
 */
class FakeRequestAdapter {
  constructor({ sessionKey, provider = 'deepseek', model = 'deepseek-v4.1-flash', directory }) {
    this.sessionKey = sessionKey
    this.provider = provider
    this.model = model
    this.directory = directory
    this.counts = new Map()
    this.usageSeen = new Set()
    // 「已见过的最大 attempt」必须**按 (turn, step) 分组**：跨步比较没有意义
    // （不同步的 attempt 序号互不相干，会把后开步的 attempt 1 误判成迟到）
    this.maxByKey = new Map()
    this.seq = 0
    // 假"出站请求"：只用来证明观测不改它（内容固定，与观测时间无关）
    this.outbound = []
  }

  startAttempt({ turn, step }) {
    const key = turn + ':' + step
    const index = (this.counts.get(key) ?? 0) + 1
    this.counts.set(key, index)
    const attempt = { turn, step, index }
    this.outbound.push({ turn, step, attempt: index, provider: this.provider, model: this.model, messages: ['user: 固定请求面'] })
    return attempt
  }

  positionKeyOf(attempt) {
    return attempt.turn + ':' + attempt.step
  }

  /** 失败/取消：宿主不会给出 usage ⇒ 观测层没有行（这是真实行为，不是丢弃） */
  abandon(attempt) {
    const key = this.positionKeyOf(attempt)
    this.maxByKey.set(key, Math.max(this.maxByKey.get(key) ?? 0, attempt.index))
    return attempt
  }

  attemptKeyOf(attempt) {
    return [this.sessionKey, attempt.turn, attempt.step, attempt.index].join('|')
  }

  /** usage 到达（可能重复、可能迟到）。返回账本写入结果。 */
  async deliverUsage(attempt, { usage, state = 'completed', seq = null, forceDuplicate = false } = {}) {
    const key = this.attemptKeyOf(attempt)
    const repeated = this.usageSeen.has(key)
    if (!repeated) this.usageSeen.add(key)
    const nextSeq = seq ?? (this.seq + 1)
    this.seq = Math.max(this.seq, nextSeq)
    const positionKey = this.positionKeyOf(attempt)
    const result = await appendCacheObservation(this.directory, nextSeq, {
      usage,
      at: nextSeq * 1000,
      request: { turn: attempt.turn, step: attempt.step, provider: this.provider, model: this.model },
      lifecycle: {
        sessionKey: this.sessionKey,
        attempt: attempt.index,
        attemptState: state,
        arrival: { duplicate: forceDuplicate || repeated, maxAttemptSeen: this.maxByKey.get(positionKey) ?? null },
      },
    })
    this.maxByKey.set(positionKey, Math.max(this.maxByKey.get(positionKey) ?? 0, attempt.index))
    return result
  }
}

const USAGE = { inputTokens: 100, cacheReadTokens: 300, cacheWriteTokens: 0, outputTokens: 10, totalTokens: 410 }

// ---------------------------------------------------------------- L1 配对

test('L1 配对的记录形状：session/logicalRequest/attempt 全是本地诊断 ID，来源如实标注', async () => {
  await withDir(async (directory) => {
    const adapter = new FakeRequestAdapter({ sessionKey: 'sess-pair', directory })
    const attempt = adapter.startAttempt({ turn: 1, step: 2 })
    const result = await adapter.deliverUsage(attempt, { usage: USAGE })
    assert.equal(result.ok, true, JSON.stringify(result))
    const [row] = await readRows(path.join(directory, 'cache-observations.jsonl'))
    const lifecycle = row.lifecycle
    assert.equal(lifecycle.contractVersion, LIFECYCLE_CONTRACT_VERSION)
    assert.match(lifecycle.session.id, /^sess-local-[0-9a-f]{16}$/)
    assert.equal(lifecycle.session.source, DIAGNOSTIC_ID_SOURCE, '本地诊断 ID 必须标来源，不得假称宿主原生')
    assert.match(lifecycle.logicalRequest.id, /^lr-local-[0-9a-f]{16}$/)
    assert.equal(lifecycle.logicalRequest.source, DIAGNOSTIC_ID_SOURCE)
    assert.match(lifecycle.attempt.id, /^at-local-[0-9a-f]{16}$/)
    assert.equal(lifecycle.attempt.index, 1)
    assert.equal(lifecycle.attempt.state, 'completed')
    assert.deepEqual({ ...lifecycle.correlation }, { status: 'paired', reason: null })
    assert.deepEqual({ ...lifecycle.usageArrival }, { state: 'first', counted: true, policy: USAGE_SAMPLE_POLICY })
    assert.equal(lifecycle.provider, 'deepseek')
    assert.equal(lifecycle.model, 'deepseek-v4.1-flash')
    // 记录里不出现原始会话键（诊断面只留摘要）
    assert.equal(JSON.stringify(row).includes('sess-pair'), false)
  })
})

// ---------------------------------------------------------------- L2 unpaired

test('L2 配不上就记 unpaired + 具体原因：不编造 ID，也不拿时间相近强配', () => {
  const noSession = lifecycleSectionOf({ request: { turn: 1, step: 1 }, attempt: 1 })
  assert.deepEqual({ ...noSession.correlation }, { status: 'unpaired', reason: 'session-missing' })
  assert.equal(noSession.session, null)
  assert.equal(noSession.logicalRequest, null, '没有会话就算不出逻辑请求 ID')
  assert.equal(noSession.attempt, null)

  const noPosition = lifecycleSectionOf({ sessionKey: 's', request: null, attempt: 1 })
  assert.deepEqual({ ...noPosition.correlation }, { status: 'unpaired', reason: 'turn-step-missing' })
  assert.equal(noPosition.logicalRequest, null)
  assert.equal(noPosition.attempt, null)

  const noAttempt = lifecycleSectionOf({ sessionKey: 's', request: { turn: 1, step: 1 }, attempt: null })
  assert.deepEqual({ ...noAttempt.correlation }, { status: 'unpaired', reason: 'attempt-missing' })
  assert.equal(noAttempt.attempt, null)
  assert.equal(noAttempt.usageArrival.state, 'unknown', '没有 attempt 就没有到达性质')
  assert.equal(noAttempt.usageArrival.counted, false)
  assert.deepEqual([...CORRELATION_REASONS], ['session-missing', 'turn-step-missing', 'attempt-missing'])
  assert.deepEqual([...ATTEMPT_STATES], ['completed', 'failed', 'cancelled', 'unknown'])
  assert.deepEqual([...USAGE_ARRIVAL_STATES], ['first', 'duplicate', 'late', 'unknown'])
})

// ---------------------------------------------------------------- L3 重试

test('L3 工具重试/换模型 = 新 attempt（不是一次请求）：失败 attempt 不吞掉成功 attempt 的关联', async () => {
  await withDir(async (directory) => {
    const adapter = new FakeRequestAdapter({ sessionKey: 'sess-retry', directory })
    const first = adapter.startAttempt({ turn: 3, step: 1 })
    adapter.abandon(first) // 失败：无 usage ⇒ 无行（真实宿主：没有 assistant 事件就没有 usage）
    const second = adapter.startAttempt({ turn: 3, step: 1 })
    assert.equal(second.index, 2, '同一步第二次 llm 调用必须是 attempt 2')
    await adapter.deliverUsage(second, { usage: USAGE })
    const rows = await readRows(path.join(directory, 'cache-observations.jsonl'))
    assert.equal(rows.length, 1, '失败 attempt 不产行（不是"双计"）')
    assert.equal(rows[0].lifecycle.attempt.index, 2)
    assert.equal(rows[0].lifecycle.usageArrival.state, 'first')
    // 两个 attempt 的逻辑请求 ID 必须不同（换 attempt 就是换请求）
    const session = sessionRefOf('sess-retry')
    const a1 = logicalRequestRefOf({ session, turn: 3, step: 1, attempt: 1, provider: 'deepseek', model: 'deepseek-v4.1-flash' })
    const a2 = logicalRequestRefOf({ session, turn: 3, step: 1, attempt: 2, provider: 'deepseek', model: 'deepseek-v4.1-flash' })
    assert.notEqual(a1.id, a2.id)
    assert.equal(rows[0].lifecycle.logicalRequest.id, a2.id)
    // 同一 (turn, step, attempt) 但换模型 ⇒ 也是不同逻辑请求（模型进身份）
    const otherModel = logicalRequestRefOf({ session, turn: 3, step: 1, attempt: 2, provider: 'deepseek', model: 'deepseek-v4.1-pro' })
    assert.notEqual(otherModel.id, a2.id)
  })
})

// ---------------------------------------------------------------- L4 流式重复

test('L4 流式重复 usage：同 attempt 只数一次，重复 chunk 记 duplicate 且 counted=false（绝不累加）', async () => {
  await withDir(async (directory) => {
    const adapter = new FakeRequestAdapter({ sessionKey: 'sess-stream', directory })
    const attempt = adapter.startAttempt({ turn: 1, step: 1 })
    await adapter.deliverUsage(attempt, { usage: USAGE })
    await adapter.deliverUsage(attempt, { usage: USAGE })
    await adapter.deliverUsage(attempt, { usage: USAGE })
    const rows = await readRows(path.join(directory, 'cache-observations.jsonl'))
    assert.equal(rows.length, 3, '每个 usage 事件一条行（seq 是幂等键，不合并事件）')
    assert.deepEqual(rows.map((row) => row.lifecycle.usageArrival.state), ['first', 'duplicate', 'duplicate'])
    assert.deepEqual(rows.map((row) => row.lifecycle.usageArrival.counted), [true, false, false])

    const policy = await readObservationPolicyInput(directory, { sessionKey: 'sess-stream' })
    assert.equal(policy.ok, true, JSON.stringify(policy))
    assert.equal(policy.input.usage.counted, 1)
    assert.equal(policy.input.usage.duplicates, 2)
    assert.equal(policy.input.usage.totals.inputTokens, 100, '重复流式样本不得累加成 300')
    assert.equal(policy.input.usage.totals.cacheReadTokens, 300)
  })
})

// ---------------------------------------------------------------- L5 迟到/乱序

test('L5 usage 迟到/乱序：仍归它自己的 attempt（不按时间强配），并且只计一次', async () => {
  await withDir(async (directory) => {
    const adapter = new FakeRequestAdapter({ sessionKey: 'sess-late', directory })
    // 同一步内：attempt 1 超时（宿主不会给它 usage）→ 重试 attempt 2 完成 → attempt 1 的
    // 流式 usage 碎片**迟到**（seq/时间都更大）。这正是"时间相近强配"最容易出错的地方。
    const attemptOne = adapter.startAttempt({ turn: 5, step: 1 })
    adapter.abandon(attemptOne)
    const attemptTwo = adapter.startAttempt({ turn: 5, step: 1 })
    await adapter.deliverUsage(attemptTwo, { usage: { inputTokens: 20, outputTokens: 2 } })
    await adapter.deliverUsage(attemptOne, { usage: { inputTokens: 10, outputTokens: 1 } })

    const rows = await readRows(path.join(directory, 'cache-observations.jsonl'))
    assert.equal(rows.length, 2)
    assert.equal(rows[0].seq, 1)
    assert.equal(rows[1].seq, 2, '迟到的样本 seq/时间都更大 —— 正因如此才不能按时间配对')
    const late = rows[1]
    assert.equal(late.lifecycle.attempt.index, 1, '迟到样本必须留在 attempt 1，不能被并到当时刚完成的 attempt 2')
    assert.equal(late.lifecycle.usageArrival.state, 'late')
    assert.equal(late.lifecycle.usageArrival.counted, true, '它仍是 attempt 1 的唯一样本 ⇒ 计一次')
    assert.equal(late.lifecycle.logicalRequest.id, logicalRequestRefOf({
      session: sessionRefOf('sess-late'), turn: 5, step: 1, attempt: 1, provider: 'deepseek', model: 'deepseek-v4.1-flash',
    }).id, '迟到的样本必须归自己的逻辑请求')
    assert.equal(rows[0].lifecycle.attempt.index, 2)
    assert.equal(rows[0].lifecycle.usageArrival.state, 'first')

    const policy = await readObservationPolicyInput(directory)
    assert.equal(policy.input.usage.counted, 2, '两个不同 attempt 各计一次')
    assert.equal(policy.input.usage.late, 1)
    assert.equal(policy.input.usage.totals.inputTokens, 30, '10 + 20：迟到不丢，也不并到 attempt 2')

    // 反例：**新的一步** 的 attempt 1 不得因为"别的步已有 attempt 2"被判成迟到
    const freshStep = adapter.startAttempt({ turn: 5, step: 2 })
    await adapter.deliverUsage(freshStep, { usage: { inputTokens: 1, outputTokens: 1 } })
    const after = await readRows(path.join(directory, 'cache-observations.jsonl'))
    assert.equal(after.at(-1).lifecycle.usageArrival.state, 'first', '迟到判定只在同一 (turn, step) 内成立')
  })
})

// ---------------------------------------------------------------- L6 取消

test('L6 取消：被取消的 attempt 不留 usage 行；若宿主仍报 usage，state 如实记 cancelled', async () => {
  await withDir(async (directory) => {
    const adapter = new FakeRequestAdapter({ sessionKey: 'sess-cancel', directory })
    const cancelled = adapter.startAttempt({ turn: 2, step: 1 })
    adapter.abandon(cancelled)
    const retried = adapter.startAttempt({ turn: 2, step: 1 })
    await adapter.deliverUsage(retried, { usage: USAGE })
    const rows = await readRows(path.join(directory, 'cache-observations.jsonl'))
    assert.equal(rows.length, 1)
    assert.equal(rows[0].lifecycle.attempt.index, 2)
    assert.equal(rows[0].lifecycle.attempt.state, 'completed')
    assert.equal(rows[0].lifecycle.correlation.status, 'paired')

    // 宿主对取消的调用仍报 usage（真机可能发生）：如实记 cancelled，不改成 completed
    const stillReported = adapter.startAttempt({ turn: 2, step: 2 })
    await adapter.deliverUsage(stillReported, { usage: USAGE, state: 'cancelled' })
    const after = await readRows(path.join(directory, 'cache-observations.jsonl'))
    assert.equal(after.at(-1).lifecycle.attempt.state, 'cancelled')
  })
})

// ---------------------------------------------------------------- L7 会话隔离

test('L7 不串会话：同 turn/step/attempt 的两个会话 → ID 全不同、目录与汇总互不混', async () => {
  const rootA = await mkdtemp(path.join(tmpdir(), MODE_PREFIX))
  const rootB = await mkdtemp(path.join(tmpdir(), MODE_PREFIX))
  try {
    const a = new FakeRequestAdapter({ sessionKey: 'sess-A', directory: rootA })
    const b = new FakeRequestAdapter({ sessionKey: 'sess-B', directory: rootB })
    const attemptA = a.startAttempt({ turn: 1, step: 1 })
    const attemptB = b.startAttempt({ turn: 1, step: 1 })
    await a.deliverUsage(attemptA, { usage: { inputTokens: 1, outputTokens: 1 } })
    await b.deliverUsage(attemptB, { usage: { inputTokens: 2, outputTokens: 2 } })
    const rowA = (await readRows(path.join(rootA, 'cache-observations.jsonl')))[0]
    const rowB = (await readRows(path.join(rootB, 'cache-observations.jsonl')))[0]
    assert.notEqual(rowA.lifecycle.session.id, rowB.lifecycle.session.id)
    assert.notEqual(rowA.lifecycle.logicalRequest.id, rowB.lifecycle.logicalRequest.id, '同位置不同会话不得共用逻辑请求 ID')
    assert.notEqual(rowA.lifecycle.attempt.id, rowB.lifecycle.attempt.id)
    const policyA = await readObservationPolicyInput(rootA, { sessionKey: 'sess-A' })
    assert.equal(policyA.input.session.id, rowA.lifecycle.session.id)
    assert.equal(policyA.input.window.rows, 1, '汇总只读本会话目录')
    assert.equal(policyA.input.usage.totals.inputTokens, 1)
    const policyB = await readObservationPolicyInput(rootB, { sessionKey: 'sess-B' })
    assert.equal(policyB.input.usage.totals.inputTokens, 2)
  } finally {
    await rm(rootA, { recursive: true, force: true }).catch(() => {})
    await rm(rootB, { recursive: true, force: true }).catch(() => {})
  }
})

// ---------------------------------------------------------------- L8 严格校验

test('L8 lifecycle 段严格：伪造宿主原生来源、counted 与 state 不自洽、paired 却缺 attempt 全部拒绝', () => {
  const good = lifecycleSectionOf({
    sessionKey: 'sess-x', request: { turn: 1, step: 1, provider: 'deepseek', model: 'm' }, attempt: 1, attemptState: 'completed',
  })
  assert.equal(sanitizeLifecycleSection(good).ok, true)
  const tamper = (mutate) => {
    const copy = structuredClone(good)
    mutate(copy)
    return sanitizeLifecycleSection(copy)
  }
  assert.equal(tamper((c) => { c.session.source = 'host-native' }).ok, false, '不得假称宿主原生关联')
  assert.equal(tamper((c) => { c.attempt.id = 'raw-id' }).ok, false)
  assert.equal(tamper((c) => { c.attempt.index = 0 }).ok, false)
  assert.equal(tamper((c) => { c.attempt.state = 'succeeded' }).ok, false)
  assert.equal(tamper((c) => { c.usageArrival.counted = false }).ok, false, 'first 必须 counted')
  assert.equal(tamper((c) => { c.usageArrival.state = 'duplicate' }).ok, false, 'duplicate 不得 counted')
  assert.equal(tamper((c) => { c.attempt = null }).ok, false, 'paired 却缺 attempt 是自相矛盾')
  assert.equal(tamper((c) => { c.correlation = { status: 'unpaired', reason: null } }).ok, false)
  assert.equal(tamper((c) => { c.correlation = { status: 'paired', reason: 'turn-step-missing' } }).ok, false)
  assert.equal(tamper((c) => { c.contractVersion = 2 }).ok, false)
  assert.equal(tamper((c) => { c.receiptText = '正文' }).ok, false)
  // attemptRefOf：逻辑请求缺失时不造 ID
  assert.equal(attemptRefOf({ logicalRequest: null, attempt: 1 }), null)
  assert.equal(attemptRefOf({ logicalRequest: { id: 'lr-local-' + 'a'.repeat(16) }, attempt: 0 }), null)
  // usageArrivalOf 三条分支
  assert.deepEqual({ ...usageArrivalOf({ attempt: 1 }) }, { state: 'first', counted: true, policy: USAGE_SAMPLE_POLICY })
  assert.deepEqual({ ...usageArrivalOf({ attempt: 1, duplicate: true }) }, { state: 'duplicate', counted: false, policy: USAGE_SAMPLE_POLICY })
  assert.deepEqual({ ...usageArrivalOf({ attempt: 1, maxAttemptSeen: 3 }) }, { state: 'late', counted: true, policy: USAGE_SAMPLE_POLICY })
  assert.deepEqual({ ...usageArrivalOf({ attempt: null }) }, { state: 'unknown', counted: false, policy: USAGE_SAMPLE_POLICY })
})
