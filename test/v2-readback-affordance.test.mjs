/**
 * P0-1 回读可用性：让「按 ID 回读」成为默认动作（0.12.0）。
 *
 * 事实：`memory_lab_recall` 存在、系统提示也写了，真实会话 303 步里调用 **0 次**
 * （read 182 / pwsh 109 / grep 80）。回执只写「正文已沉入冷库」，从不把「用哪个
 * 动作、拿哪个 ID、花多少钱」推到模型眼前。
 *
 * 本套件锁死三条：回执首行是工具调用形式（命令形式仍在）；工作卡「本步可回读」
 * ≤3 条且只描述结构；三路计数互不覆盖、fileReReads 在 status 可见；工具集恒定。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'

import { createV2Runtime } from '../src/v2/runtime.mjs'
import { createV2SessionState, writeV2SessionState } from '../src/v2/state.mjs'
import { buildSession, fakeMeter } from './helpers/fake-host.mjs'
import {
  buildReceipt,
  RECEIPT_FORMAT_OPERATION,
  V2_RECEIPT_MARKER,
} from '../src/core.mjs'
import {
  CARD_READBACK_MAX_LINE_CHARS,
  CARD_READBACK_MAX_LINES,
  readbackSectionOf,
} from '../src/v2/working-state.mjs'
import { V2_RECALL_TOOL_DESCRIPTION, V2_RECALL_TOOL_NAME, V2_RECALL_TOOL_PARAMETERS } from '../src/v2/tool.mjs'
import { createCostLedger, renderCostReport } from '../src/v2/cost.mjs'

function agentFor(session) {
  return {
    session,
    ctx: { tools: { schemas: () => [], restrict: () => () => {}, guard: () => () => {}, register: () => () => {} } },
    async runMaintenance(action) {
      return action(new AbortController().signal)
    },
  }
}

async function withTempLab(name, body) {
  const root = await mkdtemp(path.join(tmpdir(), `mcl2ra-${name}-`))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = root
  try {
    await body(path.join(root, '.memory-context-lab'))
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
}

async function seedEnabled(labRoot, sessionId, rows = []) {
  const created = await createV2SessionState(labRoot, sessionId, {})
  created.state.enabled = true
  for (const row of rows) created.state.archive.push(row)
  await writeV2SessionState(created.directory, created.state)
}

function archiveRow(index, { tokens = 500 } = {}) {
  return {
    status: 'applied',
    rangeStart: index * 2,
    rangeEnd: index * 2 + 1,
    callIds: [`call-${index}`],
    tools: ['read'],
    nodeId: `mcl2-aaaabbbbcccc-00000${index}`,
    hash: String(index).repeat(64).slice(0, 64),
    chars: 800,
    originalTokens: tokens,
    replacementSeq: index * 2 + 2,
    chunkCount: 1,
    appliedAt: '2026-10-18T00:00:00.000Z',
  }
}

test('P0-1a 回执首行是可照抄的工具调用，命令形式仍在第二行', () => {
  const text = buildReceipt({
    tools: ['read'],
    range: { start: 10, end: 12 },
    callIds: ['call_1'],
    nodeId: 'mcl2-aaaabbbbcccc-000001',
    hash: 'deadbeefdeadbeef',
    chars: 4000,
    tokens: 1000,
    marker: V2_RECEIPT_MARKER,
    formatVersion: RECEIPT_FORMAT_OPERATION,
    releasedTokens: 1000,
  })
  const lines = text.split('\n')
  const readbackIndex = lines.findIndex((line) => line.startsWith('可回读：'))
  assert.ok(readbackIndex > 0, '必须有「可回读」行')
  assert.match(lines[readbackIndex], /^可回读：memory_lab_recall\(record_ids=\["mcl2-aaaabbbbcccc-000001"\]\)｜A 类可完整重建$/)
  assert.match(lines[readbackIndex + 1], /^命令面：\/memory-lab read mcl2-aaaabbbbcccc-000001$/)
  assert.ok(readbackIndex < lines.findIndex((line) => line.startsWith('命令面：')), '工具形式在命令形式之前')
})

test('P0-1b 「本步可回读」≤3 条、每条 ≤80 字符、只描述结构不复述正文', () => {
  const readback = [1, 2, 3, 4, 5].map((index) => ({
    recordId: `mcl2-aaaabbbbcccc-00000${index}`,
    tools: ['read'],
    range: { start: index * 2, end: index * 2 + 1 },
    locator: 'src/core.mjs',
    tokens: 500,
  }))
  const section = readbackSectionOf(readback)
  assert.ok(section, '有候选时必须产出小节')
  const lines = section.lines
  // 3 条正文 + 1 行「另有 N 条未列出」
  assert.equal(lines.length, CARD_READBACK_MAX_LINES + 1)
  for (const line of lines.slice(0, CARD_READBACK_MAX_LINES)) {
    assert.ok(line.length <= CARD_READBACK_MAX_LINE_CHARS, '单行 ≤80 字符：' + line)
    assert.match(line, /^mcl2-[0-9a-f]+-\d{6}｜read｜seq \d+–\d+/, line)
    assert.ok(line.includes('取回 ≈500 token'), '必须给取回代价')
  }
  assert.match(lines.at(-1), /^另有 2 条可回读未列出$/)
  // 只描述结构：不得出现正文片段。
  assert.equal(section.lines.join('\n').includes('const value'), false)
})

test('P0-1c 工作卡里出现「本步可回读」小节，条目来自已归档行（真实 runtime 路径）', async () => {
  await withTempLab('c', async (labRoot) => {
    const sessionId = 'session-p01c'
    await seedEnabled(labRoot, sessionId, [archiveRow(1), archiveRow(2)])
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
      const agent = agentFor(session)
      const record = await runtime.adopt(agent)
      assert.ok(record)
      const card = await runtime.workingSetInjection(agent)
      assert.ok(card, '有已归档行时必须注入卡片')
      assert.ok(card.text.includes('■ 本步可回读'), card.text)
      assert.ok(card.text.includes('memory_lab_recall(record_ids=[…])'), '小节标题要给出动作')
      assert.ok(card.text.includes('mcl2-aaaabbbbcccc-000002'), '最新一条已归档行必须出现')
    } finally {
      await runtime.shutdown()
    }
  })
})

test('P0-1d 三路计数互不覆盖：工具 / 命令 / 文件重读各自独立，且都出现在成本报告里', () => {
  const ledger = createCostLedger()
  ledger.bump('toolRecallReads', 2)
  ledger.bump('commandRecallReads', 5)
  ledger.bump('fileReReads', 3)
  ledger.bump('fileReReadChars', 2400)
  const snapshot = ledger.snapshot()
  assert.equal(snapshot.toolRecallReads, 2)
  assert.equal(snapshot.commandRecallReads, 5)
  assert.equal(snapshot.fileReReads, 3)
  assert.equal(snapshot.fileReReadChars, 2400)
  const report = renderCostReport(snapshot)
  assert.ok(report.includes('回读三路：工具 memory_lab_recall 2 次 / 命令面 5 次 / 同键文件重读 3 次（2400 字）'), report)
})

test('P0-1e 工具集恒定：注入前后工具清单逐字节相同（不新增模型可见工具）', async () => {
  const before = JSON.stringify({ name: V2_RECALL_TOOL_NAME, description: V2_RECALL_TOOL_DESCRIPTION, parameters: V2_RECALL_TOOL_PARAMETERS })
  await withTempLab('e', async (labRoot) => {
    const sessionId = 'session-p01e'
    await seedEnabled(labRoot, sessionId, [archiveRow(1)])
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
      const agent = agentFor(session)
      await runtime.adopt(agent)
      const card = await runtime.workingSetInjection(agent)
      assert.ok(card)
    } finally {
      await runtime.shutdown()
    }
  })
  const after = JSON.stringify({ name: V2_RECALL_TOOL_NAME, description: V2_RECALL_TOOL_DESCRIPTION, parameters: V2_RECALL_TOOL_PARAMETERS })
  assert.equal(after, before, '注入不得改动工具定义（前缀缓存纪律）')
})
