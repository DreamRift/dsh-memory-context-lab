/**
 * P0 回归守卫（0.11.0 收口）：插件写活动面的两个硬契约。
 *
 * P0-1：宿主 Session.append(type, data, opts) 只从 opts 取 surfaceOp /
 * sourceEventSeqs，其余键静默丢弃。0.11.1 的三处写路径把 source 写进 opts，
 * 真实宿主上等于没写：投影读 data.source.kind 抛错，整条会话历史打不开。
 * FakeSession 原先用 ...opts 摊平，测试因此看不出来——夹具已收紧到宿主语义，
 * 这里再加静态守卫，防止下一次把 source 写回 opts。
 *
 * P0-2：compaction/prune.shadowedSeqs 必须等于活动面的**位置切片**。区间里夹着
 * 插件自己的回执时，规划期按单元拼出来的名单会漏掉它，prune 落盘即非法。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createV2Runtime } from '../src/v2/runtime.mjs'
import {
  applyOperations,
  bodyFromSurface,
  collectOperationCandidates,
  openTurnOf,
  planCooling,
  tokenAccountingOf,
} from '../src/apply.mjs'
import { MIN_OPERATION_CHARS } from '../src/core.mjs'
import { createV2SessionState, writeV2SessionState } from '../src/v2/state.mjs'
import { buildSession, FakeColdStore, fakeMeter, operation } from './helpers/fake-host.mjs'

const SRC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src')
/** 规划只看活动面前 6 个节点：够 2 个完整操作，且中间留得下外来节点。 */
const SPAN_NODES = 6
const TICK = String.fromCharCode(96)
const QUOTES = new Set(["'", '"', TICK])

/* ---------- 轻量源码扫描：够用即可，不引入解析器 ---------- */

function walkSource(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walkSource(full))
    else if (/\.(mjs|js)$/.test(entry.name) && !entry.name.includes('.bak')) out.push(full)
  }
  return out
}

function skipString(src, i) {
  const quote = src[i]
  i += 1
  while (i < src.length) {
    const ch = src[i]
    if (ch === '\\') { i += 2; continue }
    if (quote === TICK && ch === '$' && src[i + 1] === '{') { i = skipBalanced(src, i + 1); continue }
    if (ch === quote) return i + 1
    i += 1
  }
  return i
}

function skipLineComment(src, i) {
  while (i < src.length && src[i] !== '\n') i += 1
  return i
}

function skipBlockComment(src, i) {
  i += 2
  while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i += 1
  return i + 2
}

function skipBalanced(src, i) {
  let depth = 0
  while (i < src.length) {
    const ch = src[i]
    if (QUOTES.has(ch)) { i = skipString(src, i); continue }
    if (ch === '/' && src[i + 1] === '/') { i = skipLineComment(src, i); continue }
    if (ch === '/' && src[i + 1] === '*') { i = skipBlockComment(src, i); continue }
    if (ch === '(' || ch === '{' || ch === '[') { depth += 1; i += 1; continue }
    if (ch === ')' || ch === '}' || ch === ']') {
      depth -= 1
      i += 1
      if (depth === 0) return i
      continue
    }
    i += 1
  }
  return i
}

/** 切出一次 append 调用的顶层实参；open 指向左括号本身。 */
function splitArgs(src, open) {
  const args = []
  let depth = 0
  let start = open + 1
  let i = open + 1
  while (i < src.length) {
    const ch = src[i]
    if (QUOTES.has(ch)) { i = skipString(src, i); continue }
    if (ch === '/' && src[i + 1] === '/') { i = skipLineComment(src, i); continue }
    if (ch === '/' && src[i + 1] === '*') { i = skipBlockComment(src, i); continue }
    if (ch === '(' || ch === '{' || ch === '[') { depth += 1; i += 1; continue }
    if (ch === ')' || ch === '}' || ch === ']') {
      if (depth === 0) { args.push(src.slice(start, i)); return args }
      depth -= 1
      i += 1
      continue
    }
    if (ch === ',' && depth === 0) { args.push(src.slice(start, i)); start = i + 1; i += 1; continue }
    i += 1
  }
  return args
}

/** 对象字面量的顶层键名。 */
function topLevelKeys(text) {
  const open = text.indexOf('{')
  if (open < 0) return []
  const keys = []
  let i = open + 1
  let depth = 0
  let expectKey = true
  while (i < text.length) {
    const ch = text[i]
    if (QUOTES.has(ch)) { i = skipString(text, i); expectKey = false; continue }
    if (ch === '/' && text[i + 1] === '/') { i = skipLineComment(text, i); continue }
    if (ch === '/' && text[i + 1] === '*') { i = skipBlockComment(text, i); continue }
    if (ch === '{' || ch === '(' || ch === '[') { depth += 1; i += 1; continue }
    if (ch === '}' || ch === ')' || ch === ']') {
      if (depth === 0) break
      depth -= 1
      i += 1
      continue
    }
    if (ch === ',' && depth === 0) { expectKey = true; i += 1; continue }
    if (depth === 0 && expectKey && /[A-Za-z_$]/.test(ch)) {
      let j = i
      while (j < text.length && /[A-Za-z0-9_$]/.test(text[j])) j += 1
      const name = text.slice(i, j)
      let k = j
      while (k < text.length && /\s/.test(text[k])) k += 1
      if (text[k] === ':') keys.push(name)
      i = j
      expectKey = false
      continue
    }
    i += 1
  }
  return keys
}

function appendCallSites() {
  const sites = []
  for (const file of walkSource(SRC_DIR)) {
    const src = readFileSync(file, 'utf8')
    const re = /\.append\s*\(/g
    let match
    while ((match = re.exec(src))) {
      const open = match.index + match[0].length - 1
      const args = splitArgs(src, open)
      sites.push({
        file: path.relative(SRC_DIR, file),
        line: src.slice(0, match.index).split('\n').length,
        data: args[1] ? topLevelKeys(args[1]) : [],
        opts: args[2] ? topLevelKeys(args[2]) : [],
      })
    }
  }
  return sites
}

/* ---------- P0-1 静态守卫 ---------- */

test('P0-1 静态守卫：source 不得写进 append 的 opts（宿主会静默丢弃）', () => {
  const offenders = appendCallSites()
    .filter((site) => site.opts.includes('source'))
    .map((site) => site.file + ':' + site.line)
  assert.deepEqual(offenders, [], 'source 必须写在 data 里；写进 opts 会被宿主丢弃')
})

test('P0-1 静态守卫：带 surfaceOp 的写入必须在消息体里带 source', () => {
  const missing = appendCallSites()
    .filter((site) => site.opts.includes('surfaceOp'))
    .filter((site) => !site.data.includes('source'))
    .map((site) => site.file + ':' + site.line)
  assert.deepEqual(missing, [], '带 surfaceOp 的写入必须在消息体里带 source')
})

/* ---------- P0-1 动态守卫 ---------- */

async function withTempLab(name, body) {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl2src-' + name + '-'))
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

function agentFor(session) {
  return {
    session,
    ctx: { tools: { schemas: () => [], restrict: () => () => {}, guard: () => () => {}, register: () => () => {} } },
    async runMaintenance(action) {
      return action(new AbortController().signal)
    },
  }
}

function injectCard(session, text) {
  return session.append('user/message', {
    id: 'card-' + Math.random().toString(36).slice(2, 8),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'memory-context-lab', form: 'working-set' },
  }, { surfaceOp: 'append' }).seq
}

test('P0-1 动态：折叠回执的来源写在 data.source 上，读取端认得出是插件卡', async () => {
  await withTempLab('fold', async (labRoot) => {
    const sessionId = 'session-p0-1-fold'
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
      const agent = agentFor(session)
      await runtime.adopt(agent)
      injectCard(session, '[工作状态·v2] 卡1')
      injectCard(session, '[工作状态·v2] 卡2')
      injectCard(session, '[工作状态·v2] 卡3')
      const outcome = await runtime.foldWorkingCards(agent)
      assert.equal(outcome.folded, 1)

      const receiptSeq = session.surface.nodes.find((seq) => {
        const event = session.eventAt(seq)
        const first = event?.data?.content?.[0]
        return typeof first?.text === 'string' && first.text.startsWith('[已折叠工作卡')
      })
      assert.ok(receiptSeq !== undefined, '折叠回执必须在活动面上')
      const receipt = session.eventAt(receiptSeq)
      assert.equal(receipt.data?.source?.form, 'memory-lab2-surface', '回执来源必须在 data.source 里')
      assert.equal(receipt.source, undefined, 'source 不该出现在事件顶层')
    } finally {
      await runtime.shutdown()
    }
  })
})

/* ---------- P0-2：prune 的 shadowedSeqs 必须是活动面位置切片 ---------- */

function planFor(session, { retainOperations = 0, batchSize = 1, receiptMarker } = {}) {
  const measured = fakeMeter.measure(session)
  const view = collectOperationCandidates({
    surfaceNodes: session.surface.nodes,
    eventAt: (seq) => session.eventAt(seq),
    measuredNodes: measured.nodes,
    retainOperations,
    openTurn: openTurnOf(session),
    archivedRanges: [],
    minimumChars: MIN_OPERATION_CHARS,
  })
  return planCooling({
    candidates: view.candidates,
    meter: fakeMeter,
    nodeIdFor: (candidate) => 'node-' + candidate.rangeStart,
    retainOperations,
    batchSize,
    maxOperations: 64,
    minNetReleaseTokens: 128,
    ...(receiptMarker ? { receiptMarker } : {}),
  })
}

function receiptEvent(session, text) {
  return session.append('user/message', {
    id: 'receipt-' + Math.random().toString(36).slice(2, 8),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'memory-context-lab', form: 'memory-lab2-surface' },
  }, { surfaceOp: 'append' })
}

/** 宿主 invariant：shadowedSeqs 逐项等于活动面的位置切片（nodes 取提交前的快照）。 */
function assertPositionSlice(nodes, prune, startSeq, endSeq) {
  const startIndex = nodes.indexOf(startSeq)
  const endIndex = nodes.indexOf(endSeq)
  assert.ok(startIndex >= 0 && endIndex >= startIndex, '两端必须都在活动面上')
  assert.deepEqual(prune.data.shadowedSeqs, nodes.slice(startIndex, endIndex + 1))
  assert.deepEqual(prune.data.shadowedRange, { start: startSeq, end: endSeq })
}

test('P0-2 合并提交：prune 的 shadowedSeqs 逐项等于活动面位置切片，对账差额归零', async () => {
  const session = buildSession({ operations: 4, resultChars: 4000 })
  const plan = planFor(session, { retainOperations: 0, batchSize: 4 })
  assert.equal(plan.units.length, 4, '夹具需要 4 个相邻单元')
  // 提交前快照：prune 校验的是「提交那一刻」的活动面位置切片。
  const nodesBefore = [...session.surface.nodes]

  const outcomes = await applyOperations({
    session,
    client: new FakeColdStore(),
    units: plan.units,
    meter: fakeMeter,
    hostVersion: 'test',
    receiptMarker: 'V2-RECEIPT',
  })
  const applied = outcomes.filter((outcome) => outcome.state === 'applied')
  assert.equal(applied.length, 4, JSON.stringify(outcomes.map((o) => [o.state, o.reason])))

  const prune = session.events.find((event) => event.type === 'compaction/prune')
  assert.ok(prune, '必须写出 compaction/prune')
  assertPositionSlice(nodesBefore, prune, applied[0].rangeStart, applied.at(-1).rangeEnd)
  assert.equal(prune.data.shadowedTokenCount, applied.reduce((sum, row) => sum + row.shadowedTokenCount, 0))

  const accounting = tokenAccountingOf(
    outcomes.map((outcome) => ({
      status: outcome.state,
      originalTokens: outcome.originalTokens,
      shadowedTokenCount: outcome.shadowedTokenCount,
      spanExtraTokens: outcome.spanExtraTokens,
    })),
  )
  assert.ok(accounting, '必须有可对账的行')
  assert.equal(accounting.ratio, 0, '对账差额必须归零，实际 ' + JSON.stringify(accounting))
})

test('P0-2 回执经 replace 落进区间内部（seq 数值比区间末尾大）：旧实现会写出非法 prune', async () => {
  // 真实形状：回执是**替换**出来的节点，所以它的 seq 比被它顶掉的节点大得多，
  // 位置却落在区间中间。旧实现的相邻判定只看 seq 数值，判不出中间隔着它，
  // 于是把两段合并成一个 run，再用 flatMap 拼名单——名单里没有这条回执，
  // 与活动面位置切片不符，prune 落盘即非法。
  const session = buildSession({ operations: 4, resultChars: 4000 })
  const nodesBefore = [...session.surface.nodes]
  const thirdStart = nodesBefore[6]
  const thirdEnd = nodesBefore[7]
  const receipt = session.append('user/message', {
    id: 'receipt-replace',
    role: 'user',
    content: [{ type: 'text', text: '[已折叠工作卡·v2] 折叠卡 2 张' }],
    source: { kind: 'memory-context-lab', form: 'memory-lab2-surface' },
  }, {
    surfaceOp: { op: 'replace', startSeq: thirdStart, endSeq: thirdEnd },
    sourceEventSeqs: [thirdStart, thirdEnd],
  })
  assert.ok(receipt.seq > nodesBefore.at(-1), '回执 seq 必须比它之后的节点数值都大')

  // 被顶掉的那个操作不再可规划，剩下 3 个；旧的相邻判定只看 seq 数值，
  // 会把 [5,6] 与 [11,12] 判成相邻（回执 seq 14 不小于 11），合并成一个 run。
  const plan = planFor(session, { retainOperations: 0, batchSize: 3 })
  assert.equal(plan.units.length, 3, '被顶掉的第三个操作不再可规划')

  const nodesAtCommit = [...session.surface.nodes]
  const receiptIndex = nodesAtCommit.indexOf(receipt.seq)
  assert.ok(receiptIndex > 0 && receiptIndex < nodesAtCommit.length - 1, '回执位置必须居中')

  const outcomes = await applyOperations({
    session,
    client: new FakeColdStore(),
    units: plan.units,
    meter: fakeMeter,
    hostVersion: 'test',
    receiptMarker: 'V2-RECEIPT',
  })
  assert.equal(
    outcomes.filter((outcome) => outcome.state === 'applied').length,
    3,
    JSON.stringify(outcomes.map((o) => [o.state, o.reason])),
  )

  const prunes = session.events.filter((event) => event.type === 'compaction/prune')
  assert.ok(prunes.length >= 1, '必须写出 compaction/prune')
  let sawReceipt = false
  for (const prune of prunes) {
    const startSeq = prune.data.shadowedRange.start
    const endSeq = prune.data.shadowedRange.end
    const startIndex = nodesAtCommit.indexOf(startSeq)
    const endIndex = nodesAtCommit.indexOf(endSeq)
    assert.ok(startIndex >= 0 && endIndex >= startIndex, '两端必须在提交前的活动面上')
    const expected = nodesAtCommit.slice(startIndex, endIndex + 1)
    assert.deepEqual(prune.data.shadowedSeqs, expected, 'shadowedSeqs 必须是位置切片')
    if (prune.data.shadowedSeqs.includes(receipt.seq)) sawReceipt = true
  }
  assert.equal(sawReceipt, true, '跨越回执的区间必须把这条回执列进 shadowedSeqs')
})

test('P0-2 反例：提交前活动面漂移时失败关闭，不写 prune、不报成功', async () => {
  const session = buildSession({ operations: 4, resultChars: 4000 })
  const plan = planFor(session, { retainOperations: 0, batchSize: 4 })
  assert.equal(plan.units.length, 4)
  const lastUnit = plan.units.at(-1)
  let mutated = false
  const bodyOf = (target, unit) => {
    const body = bodyFromSurface(target, unit)
    // 模拟并发漂移：最后一个单元刚写完冷库，宿主就把它的终点节点换掉了。
    if (!mutated && unit.nodeId === lastUnit.nodeId) {
      mutated = true
      const original = target.eventAt(lastUnit.rangeEnd)
      target.append('tool/result', {
        ...original.data,
        message: { ...original.data.message, content: null },
      }, { surfaceOp: { op: 'replace', startSeq: lastUnit.rangeEnd, endSeq: lastUnit.rangeEnd }, sourceEventSeqs: [lastUnit.rangeEnd] })
    }
    return body
  }

  const outcomes = await applyOperations({
    session,
    client: new FakeColdStore(),
    units: plan.units,
    meter: fakeMeter,
    hostVersion: 'test',
    receiptMarker: 'V2-RECEIPT',
    bodyOf,
  })
  assert.equal(mutated, true, '夹具必须在提交前制造一次漂移')
  assert.equal(
    session.events.filter((event) => event.type === 'compaction/prune').length,
    0,
    '失败关闭时不得写 prune',
  )
  assert.equal(outcomes.some((outcome) => outcome.state === 'applied'), false, '漂移后不能报成功')
  assert.equal(
    outcomes.some((outcome) => String(outcome.reason ?? '').includes('提交前复核')),
    true,
    '失败原因必须说明是提交前复核，实际 ' + JSON.stringify(outcomes.map((o) => [o.state, o.reason])),
  )
})
/* ---------- P0-3：命令被拒绝时面板不得翻转 ---------- */

/**
 * 宿主 appendPluginRecord 的替身：真实宿主把记录写成 ignorable 事件，投影按
 * 事件类型读取。这里保持同一形状，足够验证「后写覆盖前写」。
 */
function fakeAppendPluginRecord(session, type, data) {
  const seq = session.events.length
  session.events.push({ type, seq, time: seq, data: JSON.parse(JSON.stringify(data)), ignorable: true })
  return seq
}

function fakePluginRecordOf(event) {
  if (event?.ignorable !== true) return undefined
  return { type: event.type, seq: event.seq, time: event.time, data: event.data }
}

/** 用插件自身的折叠逻辑重放一段事件，得到面板看到的视图。 */
async function viewAfter(events) {
  const { applyEvent, viewOf } = await import('../src/projection.mjs')
  let state = (await import('../src/core.mjs')).initialProjectionState()
  for (const event of events) state = applyEvent(state, event)
  return viewOf(state)
}

function commandRun(name, args) {
  return { type: 'command/run', data: { name, args } }
}

test('P0-3 权威状态记录：命令被拒绝时视图不翻转，成功时才翻转，重放后一致', async () => {
  const { appendStateRecord, resetHostSessionModuleCache, STATE_RECORD_TYPE } = await import('../src/authoritative-state.mjs')
  resetHostSessionModuleCache()
  // 用假的宿主模块注入：把解析器换成固定的替身，避免依赖本机是否装了 dsh-session。
  const { __setHostSessionModuleForTest } = await import('../src/authoritative-state.mjs')
  __setHostSessionModuleForTest({ appendPluginRecord: fakeAppendPluginRecord, pluginRecordOf: fakePluginRecordOf })

  // 1) 命令被维护窗口拒绝：持久状态一个字节没动，权威记录写的是「仍然开着」。
  const session = buildSession({ operations: 1, id: 'session-p0-3-refused' })
  session.append('command/run', { name: 'memory-lab', args: 'on' }, {})
  appendStateRecord(session, { enabled: true, engine: 'v2' })
  session.append('command/run', { name: 'memory-lab', args: 'off' }, {})
  // 命令被拒绝 → 真实状态仍是 enabled/v2，权威记录如实写回。
  appendStateRecord(session, { enabled: true, engine: 'v2' })

  const refusedView = await viewAfter(session.events)
  assert.equal(refusedView.enabled, true, '被拒绝的 off 不得把面板翻成已关闭')
  assert.equal(refusedView.engine, 'v2', '被拒绝的 off 不得清掉引擎归属')

  // 2) 命令成功：真实状态已停用，权威记录跟着写。
  session.append('command/run', { name: 'memory-lab', args: 'off' }, {})
  appendStateRecord(session, { enabled: false, engine: '' })
  const okView = await viewAfter(session.events)
  assert.equal(okView.enabled, false)
  assert.equal(okView.engine, '')

  // 3) 重放（模拟重启/resume）：事件序列本身就能重建同样的结论。
  const replayed = await viewAfter([...session.events])
  assert.deepEqual(replayed, okView, '重放后的视图必须与实时视图一致')

  // 4) 记录类型必须落在宿主的 plugin: 命名空间里。
  assert.match(STATE_RECORD_TYPE, /^plugin:[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/)
})

test('P0-3 拒绝路径不写记录时，视图按命令行折叠会翻转——这正是本修复要堵的洞', async () => {
  // 对照实验：只有 command/run、没有权威记录时，被拒绝的 off 确实会翻成已关闭。
  const withoutRecord = await viewAfter([commandRun('memory-lab', 'on'), commandRun('memory-lab', 'off')])
  assert.equal(withoutRecord.enabled, false, '没有权威记录时命令行折叠会误判（记录现状，不是期望）')
  assert.equal(withoutRecord.engine, '', '没有权威记录时引擎归属也会被清空')
})
