/**
 * P1-09（0.15.1）：按步归档「队头硬边界」死锁。
 *
 * ## 缺陷
 * 按步归档的候选窗口恒从**最旧**的候选开始，且 stage-1 一遇回合边界就停。于是最旧回合的
 * 队头步被 pin（或缺记录/插件边界）时：窗口里只有那一步 → 阶段 2 只产出 `pinned` block →
 * `segments=[]` → `reject('pinned')`。周转级有 `minStartSeq` 游标能越过，**按步级只跳过
 * not-worth**，因此它后面所有安全步永远拿不到——用户 pin 了队头一步，按步归档永久停摆，
 * 而 status 只说「被 pin 挡住」。
 *
 * ## 判据来源
 * docs/dev-0.15.1/记忆上下文-0.15.1-独立排查报告.md §1★6 / §3.1 P1-09；用户裁定
 * （2026-11-04）：全部按顺序修、根因修复；跳过必须是**有界只读**（不遮蔽、不改面）。
 *
 * ## 修法
 * `traceBatch` 在「窗口还空」时把队头硬边界单元**只读跳过**并记入诊断
 * （`skippedHead`）：不遮蔽、不写盘、被跳过的单元留在活动面；扫描仍受 `hardCap` 约束，
 * 跳过次数因此有上界。窗口内中段的保护洞仍按原逻辑切段（不跨越），跳过只发生在队头。
 *
 * ## 断言组
 * 1. 报告场景（turn1 一步被 pin + turn2 12 步、阈值 10）：必须出段，且段从 turn2 起步、
 *    不包含被 pin 的 seq；`skippedHeads` 如实记录 reason=pinned；
 * 2. 全部候选都是保护洞：不产生段，且拒绝原因报 `pinned` + skipped 条数（不是笼统
 *    no-candidate），证明跳过有界且不谎报成功；
 * 3. 缺记录队头同族：`missing-record` 也能越过；
 * 4. 中段保护洞仍然切段（不并吞），证明「跳过」只作用于队头、不改变同批多段语义；
 * 5. 纯函数：选择器不改动传入的 surfaceNodes 数组（只读越过）。
 *
 * ## 不适用条件与已知边界
 * - 跳过只解决「队头被挡」；窗口内部洞之后的安全段本来就由多 run 产出（P3 合同）。
 * - 跳过不推进任何持久游标：每次选择都会重新越过同一批保护洞（幂等、无写入）；
 *   若用户后来取消 pin，这些步骤会自然回到候选窗口。
 * - 若全部候选都被挡，仍然返回 null（没有可提交段时不伪造段）。
 *
 * ## 定点变异自证
 * 关闭队头跳过（`if (false)`）→ 组 1/3 必红（返回 null + reason=pinned）；
 * 把跳过放宽到窗口内（不判 windowUnits 为空）→ 组 4 红（中段保护洞被并吞）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { selectStepSpan } from '../src/v3/domain/archive/steps.mjs'

/** 一步占 3 个 seq：start / 一个活动面 assistant / end（与 v3-step-batch 同夹具口径）。 */
function step(turn, index, start) {
  return [
    { seq: start, type: 'step/start', data: { turn, step: index } },
    { seq: start + 1, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'a' + (start + 1) }] } } },
    { seq: start + 2, type: 'step/end', data: { turn, step: index } },
  ]
}
const surfaceOf = (events) => events.filter((e) => !String(e.type).startsWith('step/')).map((e) => e.seq)
const rejectionOf = (run) => {
  let rejection = null
  run((row) => { rejection = rejection ?? row })
  return rejection
}

/** turn1 一步 + turn2 N 步。 */
function headThenTurn2(count) {
  const events = []
  let start = 1
  events.push(...step(1, 1, start)); start += 3
  for (let index = 1; index <= count; index += 1) { events.push(...step(2, index, start)); start += 3 }
  return events
}

test('P1-09 队头被 pin：跳过它，后面的回合照常成段（报告场景）', () => {
  const events = headThenTurn2(12) // 13 个单元；retainSteps=1 → 窗口外 12 >= 阈值 10
  const surface = surfaceOf(events)
  const span = selectStepSpan({
    surfaceNodes: surface,
    events,
    hasRecord: () => true,
    retainSteps: 1,
    batchSteps: 10,
    pinnedSeqs: new Set([surface[0]]),
  })
  assert.ok(span !== null, '队头被 pin 不得让整批永久拿不到段')
  assert.equal(span.steps, 10)
  assert.equal(span.startSeq, surface[1], '段必须从 turn2 的第一步开始（不能吞被 pin 的那步）')
  assert.equal(span.sourceEventSeqs.includes(surface[0]), false, '被 pin 的 seq 不得进入遮蔽范围')
  assert.equal(span.headSkipped, 1)
  assert.equal(span.skippedHeads[0].reason, 'pinned')
  assert.equal(span.skippedHeads[0].seq, surface[0])
})

test('P1-09 全部候选都是保护洞：不出段，但拒绝原因如实报 pinned 与跳过条数', () => {
  const events = []
  let start = 1
  for (let index = 1; index <= 4; index += 1) { events.push(...step(1, index, start)); start += 3 }
  const surface = surfaceOf(events)
  const rejection = rejectionOf((onReject) => selectStepSpan({
    surfaceNodes: surface,
    events,
    hasRecord: () => true,
    retainSteps: 1,
    batchSteps: 1,
    pinnedSeqs: new Set(surface),
    onReject,
  }))
  assert.equal(rejection?.reason, 'pinned', '全是保护洞时如实报 pinned：' + JSON.stringify(rejection))
  assert.ok(rejection.skipped >= 3, '跳过的队头单元要计数：' + JSON.stringify(rejection))
})

test('P1-09 缺记录队头同族：同样可以越过', () => {
  const events = headThenTurn2(12)
  const surface = surfaceOf(events)
  const span = selectStepSpan({
    surfaceNodes: surface,
    events,
    hasRecord: (seq) => seq !== surface[0],
    retainSteps: 1,
    batchSteps: 10,
  })
  assert.ok(span !== null, '缺记录的队头不得让整批永久停摆')
  assert.equal(span.startSeq, surface[1])
  assert.equal(span.sourceEventSeqs.includes(surface[0]), false)
  assert.equal(span.skippedHeads[0].reason, 'missing-record')
})

test('P1-09 中段保护洞仍然切段：跳过只作用于队头', () => {
  const events = stepsOf(13)
  const surface = surfaceOf(events)
  const span = selectStepSpan({
    surfaceNodes: surface,
    events,
    hasRecord: () => true,
    retainSteps: 1,
    batchSteps: 10,
    pinnedSeqs: new Set([surface[4]]),
  })
  assert.ok(span !== null)
  assert.equal(span.headSkipped ?? 0, 0, '队头未被挡时不得跳过头（字段缺席即 0）')
  assert.equal(span.sourceEventSeqs.includes(surface[4]), false, '中段被 pin 的步不得被并吞')
  assert.ok(span.endSeq < surface[4] || span.startSeq > surface[4], '段必须停在保护洞之前（或从洞后开始）')
})

test('P1-09 跳过是只读的：surfaceNodes 原样不变', () => {
  const events = headThenTurn2(6)
  const surface = surfaceOf(events)
  const before = [...surface]
  selectStepSpan({ surfaceNodes: surface, events, hasRecord: () => true, retainSteps: 1, batchSteps: 5, pinnedSeqs: new Set([surface[0]]) })
  assert.deepEqual(surface, before, '选择器不得改动传入的活动面数组（也不得遮蔽任何节点）')
})

function stepsOf(count) {
  const events = []
  for (let index = 1; index <= count; index += 1) events.push(...step(1, index, (index - 1) * 3 + 1))
  return events
}
