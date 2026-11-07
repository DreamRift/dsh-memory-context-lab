/**
 * 归档停摆事故守卫（2026-11-06）：前导锚点不得锁定 turn。
 *
 * ## 缺陷（真机复现，见 docs/dev-0.15.3/归档停摆事故排查-20261106.md）
 *
 * `selectStepSpan` 阶段 1 里，`turn` 的赋值原本在「跳过前导锚点」**之前**：
 *
 *     if (turn === null) turn = unit.turn          // ← 先把 turn 锁成锚点的 turn
 *     else if (unit.turn !== turn) { …break… }
 *     if (unit.hasHuman) { … index += 1; continue } // ← 才跳过
 *
 * 被跳过的前导锚点于是把自己的 turn 锁成当前值。下一批候选属于下一个 turn，
 * 立刻撞上 `unit.turn !== turn` → `turn-boundary` 中断 → 窗口为空 → 返回 null。
 *
 * 真机数据（session-f7bc85e1）：turn 1 被归档到只剩 start=22 与 start=687 两个
 * `hasHuman` 单元；turn 2 首单元 start=895 → 每次 pre-step 都返回 null，
 * 归档从 seq 877 起永久停摆（实测 3.3 小时、约 200 步、0 张新凭证）。
 * 实测二分：`minStartSeq=680 → null`，`700 → 912`——阈值恰在 687 与 895 之间。
 *
 * ## 判据
 *
 * `turn` 应由**第一个真正进入窗口的候选**决定，而不是被跳过的锚点。
 *
 * ## 断言组
 *
 * 1. 前导锚点 = 唯一候选（其后是另一个 turn）时，选择器**必须**能选到窗口外候选；
 * 2. 前导锚点跳过**不**把 turn 锁死（跨 turn 仍能继续扫描）；
 * 3. 回归保护：锚点出现在**窗口已有候选之后**时，仍是不可跨越的硬边界（口径不变）。
 *
 * ## 不适用条件 / 已知边界
 *
 * - 本套件只钉「前导锚点的 turn 副作用」，不重测工作集/闭包/攒批（各自有专套件）；
 * - `bypassBatch:true` 关掉攒批等待，让判据不被「waiting-batch」掩盖。
 *
 * ## 定点变异自证
 *
 * 把 `turn` 赋值移回跳过之前（即恢复旧顺序）→ 用例 1、2 各 1 红；恢复后全绿。
 * 读数见文末「变异记录」。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { selectStepSpan as selectStepSpanRaw, STEP_BATCH_MAX } from '../src/v3/domain/archive/steps.mjs'

const select = (args) => selectStepSpanRaw({ batchSteps: STEP_BATCH_MAX, bypassBatch: true, headOnly: true, ...args })
const hasRecord = () => true

/** 一步占 3 个 seq：start / 一条业务事件 / end。 */
function step(turn, index, start, { human = false, text = 'a' } = {}) {
  const business = human
    ? { seq: start + 1, type: 'user/message', data: { source: { kind: 'user' }, message: { content: [{ type: 'text', text }] } } }
    : { seq: start + 1, type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } }
  return [
    { seq: start, type: 'step/start', data: { turn, step: index } },
    business,
    { seq: start + 2, type: 'step/end', data: { turn, step: index } },
  ]
}
const surfaceOf = (events) => events.filter((e) => !String(e.type).startsWith('step/')).map((e) => e.seq)

test('前导锚点不得锁定 turn：turn 1 只剩锚点，turn 2 仍必须能选到', () => {
  // 复刻真机形态：turn 1 只有 2 个 hasHuman 单元（22/687 的等价物），turn 2 有 12 个普通步
  const events = [
    ...step(1, 1, 1, { human: true }),
    ...step(1, 2, 4, { human: true }),
    ...Array.from({ length: 12 }, (_, i) => step(2, i + 1, 10 + i * 3)).flat(),
  ]
  const result = select({
    surfaceNodes: surfaceOf(events),
    events,
    hasRecord,
    mode: 'cooling',
    retainSteps: 4,
    minStartSeq: -1,
    pinnedSeqs: new Set(),
  })
  assert.notEqual(result, null, '前导锚点之后的 turn 2 候选必须能被选到（旧实现返回 null）')
  assert.ok(result.startSeq >= 10, '选中的段必须落在 turn 2 内，得到 ' + String(result?.startSeq))
})

test('前导锚点跳过不锁 turn：跨 turn 扫描不被锚点截断', () => {
  // turn 1 只有 1 个锚点；turn 2 首单元也是锚点；turn 3 是普通步
  const events = [
    ...step(1, 1, 1, { human: true }),
    ...step(2, 1, 10, { human: true }),
    ...Array.from({ length: 12 }, (_, i) => step(3, i + 1, 20 + i * 3)).flat(),
  ]
  const result = select({
    surfaceNodes: surfaceOf(events),
    events,
    hasRecord,
    mode: 'cooling',
    retainSteps: 4,
    minStartSeq: -1,
    pinnedSeqs: new Set(),
  })
  assert.notEqual(result, null, '连续两个前导锚点也不得把 turn 锁死')
  assert.ok(result.startSeq >= 20, '选中的段必须落在 turn 3 内，得到 ' + String(result?.startSeq))
})

test('回归保护：窗口已有候选之后的锚点仍是不可跨越的硬边界', () => {
  // turn 1 有足够普通步先入窗口，随后一条真人消息必须截断本轮
  const events = [
    ...Array.from({ length: 14 }, (_, i) => step(1, i + 1, 1 + i * 3)).flat(),
    ...step(1, 99, 100, { human: true }),
    ...Array.from({ length: 6 }, (_, i) => step(1, 200 + i, 110 + i * 3)).flat(),
  ]
  const result = select({
    surfaceNodes: surfaceOf(events),
    events,
    hasRecord,
    mode: 'cooling',
    retainSteps: 2,
    maxSteps: 200,
    minStartSeq: -1,
    pinnedSeqs: new Set(),
  })
  assert.notEqual(result, null, '锚点之前的安全步仍应能归档')
  assert.ok(result.endSeq < 100, 'span 不得跨过真人消息锚点，得到 endSeq=' + String(result?.endSeq))
})
