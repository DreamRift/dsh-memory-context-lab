import test from 'node:test'
import assert from 'node:assert/strict'

import {
  archiveChunkNodeId,
  archiveNodeId,
  BOOLEAN_SETTINGS,
  buildReceipt,
  chunkArchiveBody,
  coldRecordBody,
  coldRecordContent,
  DEFAULT_SETTINGS,
  escapePromptBraces,
  foldCommandIntoState,
  formatRatio,
  formatRecallDigest,
  initialProjectionState,
  isReceiptMessage,
  MAX_RECALL_HITS,
  normalizeColdBody,
  normalizeRecallPayload,
  normalizeSettings,
  NUMERIC_SETTINGS,
  PACKAGE_NAME,
  PACKAGE_VERSION,
  parseNumericSetting,
  parseOperation,
  RECALL_STATUS,
  renderRecallBlock,
  SettingsError,
  textFromContent,
} from '../src/core.mjs'
import { recallDigest } from '../src/apply.mjs'
import { applyEvent, initProjectionState, viewOf } from '../src/projection.mjs'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

test('parseOperation splits the verb from its literal remainder', () => {
  assert.deepEqual(parseOperation(''), { operation: 'status', remainder: '' })
  assert.deepEqual(parseOperation('  on  '), { operation: 'on', remainder: '' })
  assert.deepEqual(parseOperation('set target 0.6'), { operation: 'set', remainder: 'target 0.6' })
  assert.deepEqual(parseOperation('set retain 10'), { operation: 'set', remainder: 'retain 10' })
})

test('textFromContent keeps only text blocks', () => {
  assert.equal(textFromContent([{ type: 'text', text: ' a ' }, { type: 'image' }]), 'a')
  assert.equal(textFromContent(null), '')
})

test('numeric settings accept integers', () => {
  assert.equal(parseNumericSetting('10', NUMERIC_SETTINGS.retain), 10)
  assert.equal(parseNumericSetting('0', NUMERIC_SETTINGS.retain), 0)
  assert.equal(parseNumericSetting('5', NUMERIC_SETTINGS.batch), 5)
  // The percent form still parses to a fraction; a non-integer then trips the
  // integer check, so "10%" is rejected for batch rather than silently accepted.
  assert.throws(() => parseNumericSetting('10%', NUMERIC_SETTINGS.batch), SettingsError)
})

test('numeric settings reject out-of-range and malformed values', () => {
  assert.throws(() => parseNumericSetting('abc', NUMERIC_SETTINGS.retain), SettingsError)
  assert.throws(() => parseNumericSetting('', NUMERIC_SETTINGS.retain), SettingsError)
  assert.throws(() => parseNumericSetting('1.5', NUMERIC_SETTINGS.retain), SettingsError)
  assert.throws(() => parseNumericSetting('-1', NUMERIC_SETTINGS.retain), SettingsError)
  assert.throws(() => parseNumericSetting('201', NUMERIC_SETTINGS.retain), SettingsError)
  assert.throws(() => parseNumericSetting('0', NUMERIC_SETTINGS.batch), SettingsError)
  assert.throws(() => parseNumericSetting('2.5', NUMERIC_SETTINGS.batch), SettingsError)
  // A bare out-of-range number is never silently rescaled into a percentage.
  assert.throws(() => parseNumericSetting('600', NUMERIC_SETTINGS.batch), SettingsError)
  assert.throws(() => parseNumericSetting('2.5', NUMERIC_SETTINGS.retain), SettingsError)
})

test('normalizeSettings falls back to defaults for anything unusable', () => {
  // protectBudgetTokens 属于证据安全层，不进预设快照，但 normalizeSettings
  // 必须完整回传它（否则 set 写回会把它删掉、保护层回退默认）。
  const SNAPSHOT = {
    retainOperations: DEFAULT_SETTINGS.retainOperations,
    archiveBatchSize: DEFAULT_SETTINGS.archiveBatchSize,
    auto: DEFAULT_SETTINGS.auto,
    autoRecall: DEFAULT_SETTINGS.autoRecall,
    autoRestore: DEFAULT_SETTINGS.autoRestore,
    protectBudgetTokens: DEFAULT_SETTINGS.protectBudgetTokens,
  }
  assert.deepEqual(normalizeSettings(undefined), SNAPSHOT)
  assert.deepEqual(normalizeSettings({ retainOperations: -1, auto: 'yes' }), SNAPSHOT)
  // A batch threshold below 1 would mean "never submit", which is not a state the
  // planner can express; anything unusable falls back to the default.
  assert.deepEqual(normalizeSettings({ archiveBatchSize: 0 }), SNAPSHOT)
  assert.deepEqual(normalizeSettings({ archiveBatchSize: 2.5 }), SNAPSHOT)
  // Retired occupancy keys are no longer folded back in: they are gone from
  // DEFAULT_SETTINGS, so normalizeSettings must not resurrect them either.
  const kept = normalizeSettings({ targetOccupancy: 0.5, retainOperations: 3, archiveBatchSize: 4, releaseMarginRatio: 0.1, auto: false, autoRecall: false, autoRestore: false })
  assert.deepEqual(kept, { retainOperations: 3, archiveBatchSize: 4, auto: false, autoRecall: false, autoRestore: false, protectBudgetTokens: DEFAULT_SETTINGS.protectBudgetTokens })
  // 写回路径不丢保护预算：显式值原样保留。
  assert.equal(normalizeSettings({ protectBudgetTokens: 8192 }).protectBudgetTokens, 8192)
})

test('the stop-time restore switch is user-settable and defaults on', () => {
  assert.equal(DEFAULT_SETTINGS.autoRestore, true)
  assert.equal(BOOLEAN_SETTINGS.autorestore.key, 'autoRestore')
  const state = initialProjectionState()
  assert.equal(state.autoRestore, true)
  assert.equal(foldCommandIntoState(state, 'set autorestore off'), true)
  assert.equal(state.autoRestore, false)
  assert.equal(foldCommandIntoState(state, 'set autorestore on'), true)
  assert.equal(state.autoRestore, true)
  // A bad value must not corrupt the switch.
  assert.equal(foldCommandIntoState(state, 'set autorestore maybe'), false)
  assert.equal(state.autoRestore, true)
})

test('formatRatio renders a fraction as a percentage', () => {
  assert.equal(formatRatio(0.6), '60%')
  assert.equal(formatRatio(null), '未设置')
})

test('foldCommandIntoState applies on/off and every set form', () => {
  const state = { ...initialProjectionState() }
  assert.equal(foldCommandIntoState(state, 'on'), true)
  assert.equal(state.enabled, true)
  assert.equal(foldCommandIntoState(state, 'on'), false, 'a repeated on is not a change')

  assert.equal(foldCommandIntoState(state, 'set retain 4'), true)
  assert.equal(state.retainOperations, 4)
  assert.equal(foldCommandIntoState(state, 'set retain 4'), false, 'a repeated identical value is not a change')
  assert.equal(foldCommandIntoState(state, 'set batch 6'), true)
  assert.equal(state.archiveBatchSize, 6)
  assert.equal(foldCommandIntoState(state, 'set auto off'), true)
  assert.equal(state.auto, false)
  assert.equal(foldCommandIntoState(state, 'set recall off'), true)
  assert.equal(state.autoRecall, false)

  assert.equal(foldCommandIntoState(state, 'off'), true)
  assert.equal(state.enabled, false)
})

test('foldCommandIntoState ignores malformed lines instead of corrupting state', () => {
  const state = { ...initialProjectionState() }
  const before = JSON.stringify(state)
  for (const line of ['set', 'set target', 'set target 5', 'set target 60', 'set margin 0.1', 'set retain', 'set retain nope', 'set retain -2', 'set auto maybe', 'set unknown 1', 'status', 'now', 'restore', 'dry-run', 'help', 'nonsense']) {
    assert.equal(foldCommandIntoState(state, line), false, `"${line}" must not change state`)
  }
  assert.equal(JSON.stringify(state), before)
})

test('receipts are recognized by their marker, not by shape luck', () => {
  assert.equal(isReceiptMessage({ content: [{ type: 'text', text: '[已归档操作]\n工具：read' }] }), true)
  assert.equal(isReceiptMessage({ content: [{ type: 'text', text: '普通用户消息' }] }), false)
  assert.equal(isReceiptMessage({ content: [] }), false)
  assert.equal(isReceiptMessage(null), false)
})

test('the cold record round-trips its payload bytes exactly', () => {
  const body = '## 调用 1：edit\n参数：\n{"a":1}\n\n结果：\n内容'
  const content = coldRecordContent({
    sessionId: 'session-x',
    range: { start: 4, end: 5 },
    tools: ['edit'],
    callIds: ['call-1'],
    text: body,
    contentHash: 'abc',
  })
  assert.equal(coldRecordBody(content), body)
  // The isolated store appends exactly one newline, so exactly one is removed.
  assert.equal(normalizeColdBody(`${body}\n`), body)
  assert.equal(normalizeColdBody(body), body)
  assert.ok(content.includes('- surface_range: 4–5'))
})

test('a body that legitimately ends with a blank line survives the round trip', () => {
  // Stripping every trailing newline would truncate this body silently.
  for (const body of ['a\n', 'a\n\n', 'a\n\n\n', 'tail  ']) {
    const content = coldRecordContent({
      sessionId: 's', range: { start: 1, end: 2 }, tools: ['read'], callIds: ['c'], text: body,
    })
    assert.equal(normalizeColdBody(coldRecordBody(`${content}\n`)), body, `body ${JSON.stringify(body)} must survive`)
  }
})

test('the cold record names its chunk when the body was split', () => {
  const content = coldRecordContent({
    sessionId: 's', range: { start: 1, end: 2 }, tools: ['read'], callIds: ['c'], text: 'x',
    chunk: 2, chunkCount: 5,
  })
  assert.ok(content.includes('- chunk: 2/5'))
})

test('chunkArchiveBody splits on code-point boundaries and reassembles byte-exactly', () => {
  const lines = Array.from({ length: 40 }, (_, index) => `line ${index} ${'x'.repeat(30)}`)
  const body = lines.join('\n')
  const chunks = chunkArchiveBody(body, 300, 10)
  assert.ok(chunks.length > 1, 'the body must actually split')
  assert.equal(chunks.join(''), body, 'joining the chunks must reproduce the input exactly')
  for (const chunk of chunks) {
    assert.ok(Buffer.byteLength(chunk, 'utf8') <= 300, 'each chunk must respect the byte budget')
  }
})

test('chunkArchiveBody splits a single enormous line, which is the common real case', () => {
  // A tool call's arguments are single-line JSON, and a minified read is one
  // line: a line-based splitter would emit one oversized chunk here and the
  // read-back check would then fail for exactly the bodies that need splitting.
  const oneLine = `{"content":"${'中'.repeat(20000)}"}`
  assert.equal(oneLine.includes('\n'), false)
  const chunks = chunkArchiveBody(oneLine, 4096, 1900)
  assert.ok(chunks.length > 1, 'an oversized single line must still be split')
  assert.equal(chunks.join(''), oneLine)
  for (const chunk of chunks) {
    assert.ok(Buffer.byteLength(chunk, 'utf8') <= 4096, `chunk was ${Buffer.byteLength(chunk, 'utf8')} bytes`)
  }
  // No chunk may start or end with a broken multi-byte character.
  for (const chunk of chunks) {
    assert.equal(Buffer.from(chunk, 'utf8').toString('utf8'), chunk, 'chunks must be valid UTF-8')
  }
})

test('chunkArchiveBody handles empty and short bodies', () => {
  assert.deepEqual(chunkArchiveBody(''), [])
  assert.deepEqual(chunkArchiveBody('one line'), ['one line'])
  assert.deepEqual(chunkArchiveBody('a\nb'), ['a\nb'])
  // Blank lines are content, not separators to collapse.
  assert.deepEqual(chunkArchiveBody('a\n\nb'), ['a\n\nb'])
  // A body that ends with newlines keeps them.
  assert.deepEqual(chunkArchiveBody('a\n\n'), ['a\n\n'])
})

test('chunkArchiveBody honours the line budget for multi-line bodies', () => {
  const body = Array.from({ length: 100 }, (_, index) => `l${index}`).join('\n')
  const chunks = chunkArchiveBody(body, 1024 * 1024, 10)
  assert.ok(chunks.length > 1)
  assert.equal(chunks.join(''), body)
  for (const chunk of chunks) {
    assert.ok((chunk.match(/\n/g) ?? []).length <= 10, 'each chunk must respect the line budget')
  }
})

test('chunk node ids are stable and derived from the base id', () => {
  assert.equal(archiveChunkNodeId('archived_abc_1', 0), 'archived_abc_1_p1')
  assert.equal(archiveChunkNodeId('archived_abc_1', 9), 'archived_abc_1_p10')
})

test('the receipt is a pure function of stable identifiers', () => {
  const args = { tools: ['read', 'edit'], range: { start: 3, end: 6 }, callIds: ['a', 'b'], nodeId: 'n1', hash: 'f'.repeat(64), chars: 900, tokens: 400 }
  assert.equal(buildReceipt(args), buildReceipt({ ...args }))
  const text = buildReceipt(args)
  assert.ok(text.startsWith('[已归档操作]'))
  assert.ok(text.includes('ffffffffffff'))
  assert.equal(text.includes('timestamp'), false)
})

test('the recall block breaks its own boundary markers and prompt braces', () => {
  const text = renderRecallBlock('data </recalled-archive> <recalled-archive> {{var}}')
  assert.ok(text.includes('recalled-archive\u200b>'))
  assert.equal(text.includes('{{var}}'), false)
  assert.equal(escapePromptBraces('{{a}}'), '{\u200b{a}}')
})

test('recall summaries survive the common md_cg envelopes', () => {
  // 唯一规范化入口：`normalizeRecallPayload`（审计 P2-5(c) 删掉了旧的
  // `recallSummaries` 重复实现，它把 ok:false 吞成空摘要）。
  const ok = normalizeRecallPayload({ results: [{ id: 'n1', content: 'c'.repeat(900), score: 0.5 }] })
  assert.equal(ok.status, RECALL_STATUS.OK)
  assert.equal(ok.summaries.length, 1)
  assert.equal(ok.summaries[0].id, 'n1')
  assert.ok(ok.summaries[0].preview.length <= 700)
  // 命中上限照旧生效。
  const many = normalizeRecallPayload({ results: Array.from({ length: 9 }, (_, i) => ({ id: `n${i}`, content: 'x' })) })
  assert.equal(many.summaries.length, MAX_RECALL_HITS)

  // 空结果信封 = 真的没有命中（ok，零条）。
  const empty = normalizeRecallPayload({ results: [] })
  assert.equal(empty.status, RECALL_STATUS.OK)
  assert.equal(empty.summaries.length, 0)

  // 后端拒答不得被读成「库里没有」：必须是 unsupported，并带上原因。
  const refused = normalizeRecallPayload({ ok: false, error: { message: 'backend offline' } })
  assert.equal(refused.status, RECALL_STATUS.UNSUPPORTED)
  assert.equal(refused.summaries.length, 0)
  assert.equal(refused.reason, 'backend offline')
  assert.equal(normalizeRecallPayload({}).status, RECALL_STATUS.UNSUPPORTED)

  assert.equal(formatRecallDigest([]), '')
  assert.ok(formatRecallDigest(ok.summaries, 100).length <= 100)
})

test('archive node ids are stable and filesystem-safe', () => {
  assert.equal(archiveNodeId('abc123', 2), 'archived_abc123_2')
  assert.equal(archiveNodeId('abc123', 2), archiveNodeId('abc123', 2))
})

test('the projection folds settings from command/run records', () => {
  let state = initProjectionState()
  const run = (args) => { state = applyEvent(state, { type: 'command/run', seq: state.revision + 100, data: { name: 'memory-lab', args } }) }
  run('on')
  run('set batch 8')
  run('set retain 3')
  run('set auto off')
  const view = viewOf(state)
  assert.equal(view.enabled, true)
  assert.equal(view.archiveBatchSize, 8)
  assert.equal(view.retainOperations, 3)
  assert.equal(view.auto, false)
  assert.equal(view.autoRecall, true)
  assert.equal(view.revision, 4)
  assert.equal(view.preset.id, '')
  assert.equal(view.preset.label, '全局预设')
  assert.equal(view.preset.modified, false)
})

test('B1: memory-lab2 off folds away the full-history bit and the engine stays in sync', () => {
  // B1（session-3e4bad47 实测时间线）：`set fullhistory on` 之后 `/memory-lab2 off`
  // 停用引擎，fullHistory 折叠若残留 true，面板开关仍显示「已启用」而关闭分支
  // 按 enabled/engine 分流一条命令都发不出。v2 停用即全历史模式失效：off 折叠
  // 必须同时清掉残留位，投影 enabled/engine 与引擎实际状态保持一致。
  let state = initProjectionState()
  const run2 = (args) => { state = applyEvent(state, { type: 'command/run', seq: state.revision + 300, data: { name: 'memory-lab2', args } }) }

  run2('on')
  run2('set fullhistory on')
  let view = viewOf(state)
  assert.equal(view.enabled, true)
  assert.equal(view.engine, 'v2')
  assert.equal(view.fullHistory, true)

  run2('off')
  view = viewOf(state)
  assert.equal(view.enabled, false, 'off folds the engine as not enabled')
  assert.equal(view.engine, '', 'off folds the engine slot back to empty')
  assert.equal(view.fullHistory, false, 'v2 off must clear the stale full-history bit')

  // v1 的 off 不动 fullHistory 位：v1 停用与 v2 的全历史开关无关（v1 off 在
  // v2 持投影时会被运行时拒绝，但 command/run 仍落账、折叠仍会读它）。
  state = initProjectionState()
  const run1 = (args) => { state = applyEvent(state, { type: 'command/run', seq: state.revision + 400, data: { name: 'memory-lab', args } }) }
  run1('on')
  run2('on')
  run2('set fullhistory on')
  run1('off')
  view = viewOf(state)
  assert.equal(view.enabled, false)
  assert.equal(view.engine, '')
  assert.equal(view.fullHistory, true, 'a v1 off leaves the v2 full-history bit alone')
})

test('the projection folds preset commands and flags manual adjustments', () => {
  const presets = [
    { id: 'eco', name: 'GLM 5.3 Flash 省流', settings: { retainOperations: 5, archiveBatchSize: 3, auto: true, autoRecall: true, autoRestore: true } },
    { id: 'ds', name: 'DeepSeek V4.1 Flash 省流', settings: { retainOperations: 5, archiveBatchSize: 16, auto: true, autoRecall: true, autoRestore: true } },
  ]
  const context = { presets, defaults: { retainOperations: 5, archiveBatchSize: 5, auto: true, autoRecall: true, autoRestore: true } }
  let state = initProjectionState()
  const run = (args) => { state = applyEvent(state, { type: 'command/run', seq: state.revision + 200, data: { name: 'memory-lab', args } }, context) }

  // id 与名称都能命中；折叠进设置字段并记录基线。
  run('preset ds')
  assert.equal(state.presetId, 'ds')
  assert.equal(state.presetLabel, 'DeepSeek V4.1 Flash 省流')
  assert.equal(state.archiveBatchSize, 16)
  run('preset eco')
  assert.equal(state.presetId, 'eco')
  assert.equal(state.archiveBatchSize, 3)

  // 预设之后的手动 set 不清除选择，但标记「已调整」。
  run('set retain 8')
  let view = viewOf(state)
  assert.equal(view.preset.id, 'eco')
  assert.equal(view.preset.modified, true)
  assert.equal(view.retainOperations, 8)

  // 回到全局预设：恢复 defaults 并清空选择。
  run('preset reset')
  view = viewOf(state)
  assert.equal(view.preset.id, '')
  assert.equal(view.preset.label, '全局预设')
  assert.equal(view.preset.modified, false)
  assert.equal(view.retainOperations, 5)
  assert.equal(view.archiveBatchSize, 5)

  // 不存在的预设不改变状态。
  const before = { ...state }
  assert.equal(applyEvent(state, { type: 'command/run', seq: 999, data: { name: 'memory-lab', args: 'preset nope' } }, context), state)
  assert.deepEqual(state, before)

  // 无 context 时回退内置预设，仍可折叠。
  state = initProjectionState()
  state = applyEvent(state, { type: 'command/run', seq: 1, data: { name: 'memory-lab', args: 'preset glm-5.3-flash-eco' } })
  assert.equal(state.presetId, 'glm-5.3-flash-eco')
  assert.equal(state.archiveBatchSize, 3)
})

test('the projection ignores other commands and log-only events', () => {
  const state = initProjectionState()
  assert.equal(applyEvent(state, { type: 'command/run', data: { name: 'plan', args: 'on' } }), state)
  assert.equal(applyEvent(state, { type: 'turn/start', data: { turn: 1 } }), state)
  assert.equal(applyEvent(state, { type: 'assistant/message', surfaceOp: 'append', data: {} }), state)
  assert.equal(applyEvent(state, null), state)
})

test('the projection counts receipts and restores from surface replacements', () => {
  let state = initProjectionState()
  const receipt = { id: 'r1', role: 'user', content: [{ type: 'text', text: '[已归档操作]\n工具：read' }], source: { kind: 'user' } }
  state = applyEvent(state, { type: 'user/message', seq: 10, surfaceOp: 'append', data: receipt })
  assert.equal(viewOf(state).archived, 0, 'an appended receipt is not an archive action')

  state = applyEvent(state, {
    type: 'user/message',
    seq: 20,
    surfaceOp: { op: 'replace', startSeq: 3, endSeq: 4 },
    sourceEventSeqs: [9, 3, 4],
    data: receipt,
  })
  assert.equal(viewOf(state).archived, 1)

  // Restoring replaces the receipt with a plain user message.
  state = applyEvent(state, {
    type: 'user/message',
    seq: 30,
    surfaceOp: { op: 'replace', startSeq: 20, endSeq: 20 },
    sourceEventSeqs: [20],
    data: { id: 'u2', role: 'user', content: [{ type: 'text', text: '原文正文' }], source: { kind: 'user' } },
  })
  const view = viewOf(state)
  assert.equal(view.archived, 0)
  assert.equal(view.restored, 1)
})

test('the projection ignores replacements that are not ours', () => {
  const state = initProjectionState()
  // A compaction checkpoint shadows an ordinary range and is not a receipt.
  const next = applyEvent(state, {
    type: 'user/message',
    seq: 40,
    surfaceOp: { op: 'replace', startSeq: 3, endSeq: 9 },
    sourceEventSeqs: [3, 4, 5],
    data: { id: 'c1', role: 'user', content: [{ type: 'text', text: '摘要' }], source: { kind: 'compact-checkpoint' } },
  })
  assert.equal(next, state)
})

test('the projection view is plain JSON with no undefined values', () => {
  const view = viewOf(initProjectionState())
  for (const [key, value] of Object.entries(view)) {
    assert.notEqual(value, undefined, `${key} must not be undefined`)
    if (key === 'preset') {
      for (const [inner, innerValue] of Object.entries(value)) {
        assert.notEqual(innerValue, undefined, `preset.${inner} must not be undefined`)
        assert.ok(['boolean', 'number', 'string'].includes(typeof innerValue), `preset.${inner} must be a primitive`)
      }
      continue
    }
    assert.ok(['boolean', 'number', 'string'].includes(typeof value) || value === null, `${key} must be a primitive`)
  }
  assert.deepEqual(JSON.parse(JSON.stringify(view)), view)
})

test('the projection tolerates a corrupted state instead of throwing', () => {
  const broken = { enabled: 'yes', receiptSeqs: null, targetOccupancy: 'x', retainOperations: -5, releaseMarginRatio: 7, restored: null }
  assert.doesNotThrow(() => applyEvent(broken, { type: 'command/run', data: { name: 'memory-lab', args: 'set retain 2' } }))
  const view = viewOf(broken)
  assert.equal(view.retainOperations, 0)
  assert.equal(view.targetOccupancy, undefined, 'retired occupancy keys must not appear in the view')
  assert.equal(view.archived, 0)
})
