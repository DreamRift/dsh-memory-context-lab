/**
 * P0-3 retainReads：给证据保护层补「刚读过」判据（0.12.0）。
 *
 * 全历史模式下唯一节流阀是证据保护层，而它的判据不含「刚读过、很可能马上要用」：
 * 可见窗口中位 9.5 步、18 次 ≤2 步（其中 12 次只有 1 步）。于是证据刚读完就被归档，
 * 模型只能再读一次——这就是自激循环的一半。
 *
 * 设计约束（不可越界）：
 * - `retainOperations` 在全历史下仍为 0（设计不变）；
 * - `retainReads` 是**带 TTL 的租约**（智能论 3.2.2 stable），不是永久保护位：
 *   M 步后自动失效并转「需复核」，绝不累积（v1.2 §8.3 受保护集无界增长是未解问题）；
 * - `retainReads: 0` 完全退回旧行为；写类操作不受影响。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { collectHistoryCandidates } from '../src/v2/history.mjs'
import { readKeyOf } from '../src/v2/read-ledger.mjs'

function readerOf(table) {
  return (seq) => table.get(seq) ?? null
}

function numbered(events) {
  const table = new Map()
  events.forEach((event, index) => table.set(index + 1, event))
  return { surfaceNodes: events.map((_, index) => index + 1), eventAt: readerOf(table) }
}

function systemHead() {
  return { type: 'system/message', data: { message: { id: 'sys', role: 'system', content: [{ type: 'text', text: 'system prompt' }], source: { kind: 'system-prompt' } } } }
}

function humanUser(text, id = 'u') {
  return { type: 'user/message', surfaceOp: 'append', data: { message: { id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user', rpcId: 'rpc-' + id } } } }
}

function callEvent(callId, { name = 'read', args = '{"file_path":"src/core.mjs","offset":0}', step = 1 } = {}) {
  return {
    type: 'assistant/message',
    surfaceOp: 'append',
    data: {
      turn: 1,
      step,
      message: {
        id: 'm-' + callId,
        role: 'assistant',
        content: [{ type: 'tool-call', id: callId, name, arguments: args }],
        source: { kind: 'model', provider: 'fake', model: 'fake-model' },
      },
    },
  }
}

function resultEvent(callId, { text = 'x'.repeat(2000), step = 1 } = {}) {
  return {
    type: 'tool/result',
    surfaceOp: 'append',
    data: {
      turn: 1,
      step,
      message: { id: 'r-' + callId, role: 'tool', content: [{ type: 'text', text }], source: { kind: 'tool', callId }, toolCallId: callId },
    },
  }
}

/** 一次读取操作：call + result，step 相同。 */
function readOp(index, { step = index, file = 'src/core.mjs', offset = 0 } = {}) {
  return [
    callEvent('read-' + index, { args: JSON.stringify({ file_path: file, offset }), step }),
    resultEvent('read-' + index, { step }),
  ]
}

function writeOp(index, { step = index } = {}) {
  return [
    callEvent('write-' + index, { name: 'edit', args: JSON.stringify({ file_path: 'src/a.mjs' }), step }),
    resultEvent('write-' + index, { step }),
  ]
}

function buildView(events, { retainReads = 3, ttl = 6 } = {}) {
  return {
    ...numbered(events),
    retainOperations: 0,
    retainReads,
    retainReadsTtl: ttl,
    fullHistory: true,
    minimumChars: 100,
    lastAssistantSeq: null,
  }
}

function skipMapOf(result) {
  return Object.fromEntries(result.skipped.map((row) => [row.seq, row.reason]))
}

test('P0-3a readKeyOf：read 的键是 path|offset，不同 offset 不合并，写类工具没有键', () => {
  assert.equal(readKeyOf('read', '{"file_path":"src/core.mjs","offset":0}'), 'src/core.mjs|0')
  assert.equal(readKeyOf('read', '{"file_path":"src/core.mjs","offset":120}'), 'src/core.mjs|120')
  assert.notEqual(readKeyOf('read', '{"file_path":"src/core.mjs","offset":0}'), readKeyOf('read', '{"file_path":"src/core.mjs","offset":120}'))
  assert.equal(readKeyOf('grep', '{"pattern":"foo","path":"src"}'), 'grep|foo|src')
  assert.equal(readKeyOf('edit', '{"file_path":"src/a.mjs"}'), null)
  assert.equal(readKeyOf('pwsh', '{"command":"ls"}'), null)
})

test('P0-3b 最近 3 次读取不进候选（租约内保留在热上下文）', () => {
  // 4 次读取：seq 3/4、5/6、7/8、9/10；当前步 = 4。
  const events = [systemHead(), humanUser('需求')]
  for (let index = 1; index <= 4; index += 1) events.push(...readOp(index, { step: index }))
  const result = collectHistoryCandidates(buildView(events, { retainReads: 3, ttl: 8 }))
  const skip = skipMapOf(result)
  const candidateStarts = result.candidates.map((row) => row.rangeStart)
  // 最近 3 次读取（read-2/3/4 的调用 seq 5/7/9）受租约保护。
  assert.equal(skip[5], 'retained-recent-read')
  assert.equal(skip[7], 'retained-recent-read')
  assert.equal(skip[9], 'retained-recent-read')
  // 第 1 次读取被挤出（read-1 的调用 seq 3）。
  assert.ok(candidateStarts.includes(3), '第 1 次读取必须进候选（被更新的读取挤出）')
})

test('P0-3c 第 4 次读取挤出第 1 次（窗口是「最近 N 个」，不是累积）', () => {
  const events = [systemHead(), humanUser('需求')]
  for (let index = 1; index <= 5; index += 1) events.push(...readOp(index, { step: index }))
  const result = collectHistoryCandidates(buildView(events, { retainReads: 3, ttl: 99 }))
  const skip = skipMapOf(result)
  const candidateStarts = result.candidates.map((row) => row.rangeStart)
  // 5 次读取：受保护的是最后 3 次（seq 7/9/11），前两次进候选。
  assert.ok(candidateStarts.includes(3), '第 1 次已挤出')
  assert.ok(candidateStarts.includes(5), '第 2 次已挤出')
  assert.equal(skip[7], 'retained-recent-read')
  assert.equal(skip[9], 'retained-recent-read')
  assert.equal(skip[11], 'retained-recent-read')
})

test('P0-3d TTL 到期后保护失效，并如实标「需复核」（readLeaseExpired）', () => {
  const events = [systemHead(), humanUser('需求')]
  for (let index = 1; index <= 4; index += 1) events.push(...readOp(index, { step: index }))
  // 再插入两个写操作把「当前步」推到 6，TTL=2 时 4 步前的读取已过期。
  events.push(...writeOp(1, { step: 5 }), ...writeOp(2, { step: 6 }))
  const result = collectHistoryCandidates(buildView(events, { retainReads: 3, ttl: 2 }))
  const skip = skipMapOf(result)
  const expired = result.candidates.filter((row) => row.readLeaseExpired === true).map((row) => row.rangeStart)
  assert.equal(skip[5], undefined, 'TTL 到期后不得再受租约保护')
  assert.ok(expired.length > 0, '过期读取必须带 readLeaseExpired 标记（转需复核）')
})

test('P0-3e retainReads: 0 完全退回旧行为（最近读取照常进候选）', () => {
  const events = [systemHead(), humanUser('需求')]
  for (let index = 1; index <= 4; index += 1) events.push(...readOp(index, { step: index }))
  const result = collectHistoryCandidates(buildView(events, { retainReads: 0, ttl: 0 }))
  const candidateStarts = result.candidates.map((row) => row.rangeStart)
  for (const seq of [3, 5, 7, 9]) assert.ok(candidateStarts.includes(seq), 'retainReads=0 时读取操作全部进候选：seq ' + seq)
  assert.equal(result.skipped.some((row) => row.reason === 'retained-recent-read'), false)
})

test('P0-3f 写类操作不受影响：编辑操作既不占租约，也不被租约保护', () => {
  const events = [systemHead(), humanUser('需求')]
  events.push(...readOp(1, { step: 1 }))
  events.push(...writeOp(1, { step: 2 }))
  events.push(...readOp(2, { step: 3 }))
  const result = collectHistoryCandidates(buildView(events, { retainReads: 1, ttl: 99 }))
  const skip = skipMapOf(result)
  const candidateStarts = result.candidates.map((row) => row.rangeStart)
  // 写操作 seq 5（call）永远进候选；最近 1 次读取（seq 7）受保护。
  assert.ok(candidateStarts.includes(5), '写类操作不受读取租约影响')
  assert.equal(skip[7], 'retained-recent-read')
  assert.ok(candidateStarts.includes(3), '第 1 次读取被第 2 次挤出（N=1）')
})

test('P0-3h TTL 缺省是 2×N（蜂巢复审 F2）：不传 TTL 时租约仍然生效，且不谎报过期', () => {
  const events = [systemHead(), humanUser('需求')]
  for (let index = 1; index <= 3; index += 1) events.push(...readOp(index, { step: index }))
  const view = {
    ...numbered(events),
    retainOperations: 0,
    retainReads: 3,
    // 刻意不传 retainReadsTtl：默认必须是 2×3=6，而不是 0。
    fullHistory: true,
    minimumChars: 100,
    lastAssistantSeq: null,
  }
  const result = collectHistoryCandidates(view)
  const retained = result.skipped.filter((row) => row.reason === 'retained-recent-read')
  assert.equal(retained.length, 3, 'TTL 缺省时最近 3 次读取仍受租约保护')
  assert.equal(result.candidates.some((row) => row.readLeaseExpired === true), false, '不得把所有读取标成过期')
})
test('P0-3g 租约是租约不是保护集扩张：受保护读取不在 candidates 里，也不出现在保护集（protectedSet）语义里', () => {
  const events = [systemHead(), humanUser('需求')]
  for (let index = 1; index <= 3; index += 1) events.push(...readOp(index, { step: index }))
  const result = collectHistoryCandidates(buildView(events, { retainReads: 3, ttl: 9 }))
  // 全部读取都被租约挡住时，候选里不应出现它们；跳过原因明确写着「租约内」。
  const retained = result.skipped.filter((row) => row.reason === 'retained-recent-read')
  assert.equal(retained.length, 3)
  assert.equal(result.candidates.some((row) => retained.some((skipRow) => skipRow.seq === row.rangeStart)), false)
})
test('P0-3i 命令面 `/memory-lab2 set readlease`：0..50 生效并落盘，越界与非法值拒绝', async () => {
  const path = await import('node:path')
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { createV2Runtime } = await import('../src/v2/runtime.mjs')
  const { createV2SessionState, writeV2SessionState, readV2SessionState } = await import('../src/v2/state.mjs')
  const { buildSession, fakeMeter } = await import('./helpers/fake-host.mjs')
  const root = await mkdtemp(path.join(tmpdir(), 'mcl2rl-set-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = root
  try {
    const labRoot = path.join(root, '.memory-context-lab')
    const sessionId = 'session-p03i'
    const created = await createV2SessionState(labRoot, sessionId, {})
    created.state.enabled = true
    await writeV2SessionState(created.directory, created.state)
    const runtime = createV2Runtime({
      labRoot,
      services: { get: (name) => (name === 'tokenMeter' ? fakeMeter : undefined) },
      logger: { info() {}, warn() {}, error() {} },
      hostVersion: 'test-host',
      sessionIdOf: (session) => session.id,
      recallQueryFrom: () => null,
    })
    try {
      const session = buildSession({ operations: 1, id: sessionId })
      const agent = { session, ctx: { tools: { schemas: () => [], restrict: () => () => {}, guard: () => () => {}, register: () => () => {} } } }
      await runtime.adopt(agent)
      const ok = await runtime.commandHandler({ agent, rawInput: 'set readlease 5' })
      assert.equal(ok.kind, 'success', JSON.stringify(ok))
      const stored = await readV2SessionState(labRoot, sessionId)
      assert.equal(stored.state.settings.retainReads, 5, '必须落盘，重启后仍生效')
      const zero = await runtime.commandHandler({ agent, rawInput: 'set readlease 0' })
      assert.equal(zero.kind, 'success', '0 是「关闭租约」的合法入口')
      assert.equal((await readV2SessionState(labRoot, sessionId)).state.settings.retainReads, 0)
      const tooBig = await runtime.commandHandler({ agent, rawInput: 'set readlease 51' })
      assert.equal(tooBig.kind, 'error', '越界不得静默夹取')
      const bad = await runtime.commandHandler({ agent, rawInput: 'set readlease abc' })
      assert.equal(bad.kind, 'error')
      const unknown = await runtime.commandHandler({ agent, rawInput: 'set nope 1' })
      assert.match(unknown.text, /readlease/, '未知键提示必须列出 readlease')
    } finally {
      await runtime.shutdown()
    }
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})