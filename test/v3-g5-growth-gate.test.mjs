/**
 * P3-05 调度节奏门不得被「活动面变小」绕过。
 *
 * ## 缺陷（0.15.1 独立排查报告 §3.3 P3-05）
 * `evaluateSchedulePolicy` 在 `growthMessages < 0` 时返回
 * `verdict('allow', 'policy-growth-reset')` 并 `baselineReset: true`。负增长有两个来源：
 * 宿主压缩/替换（旧基线确实不可比），以及**归档自己刚把消息摘走**。旧实现把两者都当成
 * 「允许 + 重置基线」：归档摘掉一批消息 → 下一次评估立刻看到 growth<0 → 立即再允许归档。
 * `minGrowthMessages` 与 `minRequestGap` 这对节奏门被绕过（越归档越容易继续归档）。
 *
 * ## 判据来源
 * `src/v3/domain/archive/schedule-policy.mjs`：负增长时**重建基线**（旧计数不可比）但把
 * **本次**增长按 0 计，再走原有门序（硬上限防饥饿 → 积压合并 → 双门）。仍不满足时
 * 以 `reason='policy-growth-reset'` 判 defer，并给出与 `rhythm-deferred` 同形的 `needed`。
 *
 * ## 断言组
 * A. 负增长 + 双门未达 → `defer`（旧实现 `allow` → 红），`baselineReset: true` 仍保留；
 * B. 负增长但**请求数已达硬上限** → 仍 `allow`（防饥饿不能被本修复取消）；
 * C. 负增长且积压达合并门槛 → 仍 `allow`（积压合并是另一条独立放行理由）；
 * D. 正增长时决策与既有完全一致（`growthObserved` 与 `growthMessages` 相等，reason 不变）；
 * E. 确定性：同输入同字节（新字段不引入时间戳/随机）。
 *
 * ## 不适用条件与已知边界
 * - 只改**节奏门**；安全候选、净收益、上限、保护洞一律不在此模块，未受影响；
 * - 负增长后基线仍会重建（下一次按新计数比较）——这是原有的、正确的行为，本修复不改；
 * - `growthMessages` 在负增长时被规范成 0（而不是保留负值），因此下游「增长差多少」的
 *   计算不会出现「已超出门槛」的错觉；观测值另存 `growthObserved`。
 *
 * ## 定点变异自证（`node --test test/v3-g5-growth-gate.test.mjs`）
 * - 把负增长分支改回 `return { ...verdict('allow', 'policy-growth-reset'), baselineReset: true }`
 *   → A 组红（决策变 allow）；
 * - 恢复后 5 组全绿。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { normalizeSchedulePolicyConfig } from '../src/v3/contracts/archive-schedule-policy.mjs'
import { evaluateSchedulePolicy } from '../src/v3/domain/archive/schedule-policy.mjs'

const CONFIG = Object.freeze({
  enabled: true,
  minGrowthMessages: 5,
  minRequestGap: 3,
  maxRequestGap: 10,
  backlogCoalesceUnits: 20,
})
const FINGERPRINT = normalizeSchedulePolicyConfig(CONFIG).fingerprint

const inputOf = (count) => ({
  contractVersion: 1,
  session: null,
  window: { fromSeq: 1, toSeq: 2, rows: 2, legacyRows: 0, skippedRows: 0 },
  projection: { epoch: 1, lastPhase: 'append', lastMessageChange: 'appended', phaseCounts: { initial: 0, steady: 0, append: 2, 'epoch-start': 0 } },
  components: { messages: { digest: 'a'.repeat(16), count, generation: 1 }, system: { coverage: 'unobservable' }, tools: { coverage: 'unobservable' } },
  usage: null,
  layers: null,
})

const stateOf = ({ ordinal = 9, baseline = 5, baselineCount = 100 } = {}) => ({
  contractVersion: 1,
  attemptOrdinal: ordinal,
  lastCommit: { attemptOrdinal: baseline, messagesCount: baselineCount, configFingerprint: FINGERPRINT },
})
const factsOf = ({ pendingUnits = 12, batchSteps = 10, safeSegments = 2 } = {}) => ({ pendingUnits, batchSteps, safeSegments })

const decide = (overrides = {}) => evaluateSchedulePolicy({
  config: CONFIG,
  state: stateOf(),
  input: inputOf(90), // 负增长：基线 100 → 现在 90
  facts: factsOf(),
  lane: 'auto',
  ...overrides,
})

test('P3-05-A 负增长不得直接放行：双门未达必须 defer（旧实现 allow → 红）', () => {
  // 请求间隔 = 9 - 5 = 4 ≥ minRequestGap(3)，但增长按 0 计 < minGrowthMessages(5)
  const decision = decide()
  assert.equal(decision.baselineReset, true, '基线仍要重建（旧计数确实不可比）')
  assert.equal(decision.growthObserved, -10, '观测值必须如实（-10 条）')
  assert.equal(decision.growthMessages, 0, '本次增长按 0 计，不得把负值当成「已达标」')
  assert.equal(decision.decision, 'defer', '旧实现在这里 allow（节奏门被绕过）')
  assert.equal(decision.reason, 'policy-growth-reset', '原因码要能看出是变短导致的等待')
  assert.deepEqual(decision.needed, { growthMessages: 5, requests: 0 }, '差多少必须如实（还需 5 条增长）')
})

test('P3-05-B 负增长但请求数达硬上限：仍放行（防饥饿不得被取消）', () => {
  // 请求间隔 = 15 - 5 = 10 ≥ maxRequestGap(10)
  const decision = decide({ state: stateOf({ ordinal: 15, baseline: 5 }) })
  assert.equal(decision.decision, 'allow')
  assert.equal(decision.reason, 'request-gap-max')
})

test('P3-05-C 负增长但积压达合并门槛：仍放行（积压合并是独立放行理由）', () => {
  const decision = decide({ facts: factsOf({ pendingUnits: 25 }) })
  assert.equal(decision.decision, 'allow')
  assert.equal(decision.reason, 'backlog-coalesce')
})

test('P3-05-D 正增长路径与既有完全一致（新字段不改变旧结论）', () => {
  const decision = decide({ input: inputOf(120) }) // +20 条，请求间隔 4
  assert.equal(decision.decision, 'allow')
  assert.equal(decision.reason, 'rhythm-satisfied')
  assert.equal(decision.growthMessages, 20)
  assert.equal(decision.growthObserved, 20, '正增长时观测值就是增长值')
  assert.equal(decision.baselineReset, false)
})

test('P3-05-E 确定性：同输入逐字节相同，且不携带时间戳', () => {
  const a = JSON.stringify(decide())
  const b = JSON.stringify(decide())
  assert.equal(a, b, '同输入必须逐字节相同')
  for (const key of ['at', 'now', 'time', 'timestamp']) assert.equal(a.includes('"' + key + '"'), false, '决策不得带时间戳：' + key)
})
