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
  normalizeColdBody,
  normalizeSettings,
  NUMERIC_SETTINGS,
  parseNumericSetting,
  parseOperation,
  recallSummaries,
  renderRecallBlock,
  SettingsError,
  textFromContent,
} from '../src/core.mjs'
import { applyEvent, initProjectionState, viewOf } from '../src/projection.mjs'

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

test('numeric settings accept fractions, percentages, and integers', () => {
  assert.equal(parseNumericSetting('0.6', NUMERIC_SETTINGS.target), 0.6)
  assert.equal(parseNumericSetting('60%', NUMERIC_SETTINGS.target), 0.6)
  assert.equal(parseNumericSetting('5%', NUMERIC_SETTINGS.margin), 0.05)
  assert.equal(parseNumericSetting('0', NUMERIC_SETTINGS.margin), 0)
  assert.equal(parseNumericSetting('10', NUMERIC_SETTINGS.retain), 10)
  assert.equal(parseNumericSetting('0', NUMERIC_SETTINGS.retain), 0)
})

test('numeric settings reject out-of-range and malformed values', () => {
  assert.throws(() => parseNumericSetting('0', NUMERIC_SETTINGS.target), SettingsError)
  assert.throws(() => parseNumericSetting('1', NUMERIC_SETTINGS.target), SettingsError)
  assert.throws(() => parseNumericSetting('abc', NUMERIC_SETTINGS.target), SettingsError)
  assert.throws(() => parseNumericSetting('', NUMERIC_SETTINGS.target), SettingsError)
  assert.throws(() => parseNumericSetting('1.5', NUMERIC_SETTINGS.retain), SettingsError)
  assert.throws(() => parseNumericSetting('-1', NUMERIC_SETTINGS.retain), SettingsError)
  assert.throws(() => parseNumericSetting('201', NUMERIC_SETTINGS.retain), SettingsError)
  // A bare out-of-range number is never silently rescaled into a percentage.
  assert.throws(() => parseNumericSetting('60', NUMERIC_SETTINGS.target), SettingsError)
  assert.throws(() => parseNumericSetting('2', NUMERIC_SETTINGS.margin), SettingsError)
})

test('normalizeSettings falls back to defaults for anything unusable', () => {
  assert.deepEqual(normalizeSettings(undefined), { ...DEFAULT_SETTINGS })
  assert.deepEqual(normalizeSettings({ targetOccupancy: 5, retainOperations: -1, auto: 'yes' }), { ...DEFAULT_SETTINGS })
  // A batch threshold below 1 would mean "never submit", which is not a state the
  // planner can express; anything unusable falls back to the default.
  assert.deepEqual(normalizeSettings({ archiveBatchSize: 0 }), { ...DEFAULT_SETTINGS })
  assert.deepEqual(normalizeSettings({ archiveBatchSize: 2.5 }), { ...DEFAULT_SETTINGS })
  const kept = normalizeSettings({ targetOccupancy: 0.5, retainOperations: 3, archiveBatchSize: 4, releaseMarginRatio: 0.1, auto: false, autoRecall: false, autoRestore: false })
  assert.deepEqual(kept, { targetOccupancy: 0.5, retainOperations: 3, archiveBatchSize: 4, releaseMarginRatio: 0.1, auto: false, autoRecall: false, autoRestore: false })
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

  assert.equal(foldCommandIntoState(state, 'set target 50%'), true)
  assert.equal(state.targetOccupancy, 0.5)
  assert.equal(foldCommandIntoState(state, 'set target 50%'), false, 'a repeated identical value is not a change')
  assert.equal(foldCommandIntoState(state, 'set retain 4'), true)
  assert.equal(state.retainOperations, 4)
  assert.equal(foldCommandIntoState(state, 'set margin 0.1'), true)
  assert.equal(state.releaseMarginRatio, 0.1)
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
  for (const line of ['set', 'set target', 'set target nope', 'set target 5', 'set target 60', 'set retain -2', 'set auto maybe', 'set unknown 1', 'status', 'now', 'restore', 'dry-run', 'help', 'nonsense']) {
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
  const rows = recallSummaries({ results: [{ id: 'n1', content: 'c'.repeat(900), score: 0.5 }] })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].id, 'n1')
  assert.ok(rows[0].preview.length <= 700)
  assert.equal(recallSummaries({}).length, 0)
  assert.equal(formatRecallDigest([]), '')
  assert.ok(formatRecallDigest(rows, 100).length <= 100)
})

test('archive node ids are stable and filesystem-safe', () => {
  assert.equal(archiveNodeId('abc123', 2), 'archived_abc123_2')
  assert.equal(archiveNodeId('abc123', 2), archiveNodeId('abc123', 2))
})

test('the projection folds settings from command/run records', () => {
  let state = initProjectionState()
  const run = (args) => { state = applyEvent(state, { type: 'command/run', seq: state.revision + 100, data: { name: 'memory-lab', args } }) }
  run('on')
  run('set target 0.5')
  run('set retain 3')
  run('set auto off')
  const view = viewOf(state)
  assert.equal(view.enabled, true)
  assert.equal(view.targetOccupancy, 0.5)
  assert.equal(view.retainOperations, 3)
  assert.equal(view.auto, false)
  assert.equal(view.autoRecall, true)
  assert.ok(view.revision >= 4)
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
    assert.ok(['boolean', 'number', 'string'].includes(typeof value) || value === null, `${key} must be a primitive`)
  }
  assert.deepEqual(JSON.parse(JSON.stringify(view)), view)
})

test('the projection tolerates a corrupted state instead of throwing', () => {
  const broken = { enabled: 'yes', receiptSeqs: null, targetOccupancy: 'x', retainOperations: -5, releaseMarginRatio: 7, restored: null }
  assert.doesNotThrow(() => applyEvent(broken, { type: 'command/run', data: { name: 'memory-lab', args: 'set retain 2' } }))
  const view = viewOf(broken)
  assert.equal(view.retainOperations, 0)
  assert.equal(view.targetOccupancy, null)
  assert.equal(view.archived, 0)
})
