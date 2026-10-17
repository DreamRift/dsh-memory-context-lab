/**
 * P4 模型摘要模式测试：失败关闭阶梯 + 机械校验 + 缓存/费用侧车 + 协调器接线。
 *
 * 覆盖计划 §5 P4 验收门：
 * - 无 LLM 可用全链路工作（stream 缺失 / 任何失败都落回程序版本，不阻塞压缩）；
 * - 失败关闭阶梯各档位（no-model/auth/rate-limit/timeout/over-budget/
 *   empty-output/invalid-ref/invalid-shape/no-gain/host-error）；
 * - 任务撤销（cancelled）不借兜底继续提交——协调器 run 即停，原状态保留；
 * - 机械校验：每条结论必须引用程序选中的块，行内数字串必须对回 L0 行文；
 * - 缓存键稳定、命中必须 key+blocksHash 双匹配；usage 落账（含缓存命中）。
 *
 * 超时档说明：模块把 timeoutMs 钳制在 [30s, 60s]（拍板区间），测试不等 30s
 * 真钟；超时分类由 classifyModelError 的 TimeoutAbortError 单测覆盖，
 * 计时器只做 abort 传播（不经网络），行为与网络超时同构。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { FakeSession } from './helpers/fake-host.mjs'
import { V2_RECEIPT_MARKER } from '../src/core.mjs'
import { AGG_VOUCHER_MARKER } from '../src/v2/agg-voucher.mjs'
import {
  MODEL_PHASE_TIMEOUT_MS_DEFAULT,
  MODEL_PHASE_TIMEOUT_MS_MIN,
  MODEL_PHASE_TIMEOUT_MS_MAX,
  MODEL_SUMMARY_MAX_LINES,
  blocksHashOf,
  buildModelMessages,
  classifyModelError,
  modelCacheKeyOf,
  renderModelPhaseCard,
  runModelPhase,
  verifyModelSummary,
} from '../src/v2/compressor-model.mjs'
import {
  appendModelCacheEntry,
  appendModelUsageEntry,
  readModelCacheEntry,
  readModelUsageEntries,
} from '../src/v2/model-ledger.mjs'
import {
  compressPreview,
  compressRun,
} from '../src/v2/hierarchy-coordinator.mjs'

// ── 通用桩 ───────────────────────────────────────────────────────────────

const BLOCKS = [
  { blockId: 'blk-1', line: '工具：run_code；exit 0；版本 1.2.3；共 5 条' },
  { blockId: 'blk-2', line: '测试 41 套 540 项全绿' },
]
const SELECTED = [BLOCKS[0]]

/** 合法模型输出：结论里的数字串全部能在 blk-1 行文里找到。 */
function goodSummary() {
  return { lines: [{ text: 'run_code 以 exit 0 完成，版本 1.2.3。', refs: ['blk-1'] }] }
}

function okStream(summary = goodSummary(), usage = { input: 10, output: 5 }) {
  return async () => ({ text: JSON.stringify(summary), usage })
}

// ── classifyModelError：失败关闭阶梯档位 ────────────────────────────────

test('classifyModelError：超时 / 取消 / 鉴权 / 限流 / 宿主错误', () => {
  const timeout = new Error('模型摘要超时')
  timeout.name = 'TimeoutAbortError'
  assert.equal(classifyModelError(timeout), 'timeout')
  const external = new AbortController()
  external.abort()
  assert.equal(classifyModelError(new Error('boom'), { signal: external.signal }), 'cancelled')
  assert.equal(classifyModelError(new Error('HTTP 401 unauthorized')), 'auth')
  assert.equal(classifyModelError(new Error('invalid api key')), 'auth')
  assert.equal(classifyModelError(new Error('429 too many requests')), 'rate-limit')
  assert.equal(classifyModelError(new Error('ECONNRESET')), 'host-error')
  // 非错误值也必须有档位，不许抛出。
  assert.equal(classifyModelError('字符串错误'), 'host-error')
  assert.equal(classifyModelError(null), 'host-error')
})

test('超时常量与拍板区间一致（30–60s，默认 45s）', () => {
  assert.equal(MODEL_PHASE_TIMEOUT_MS_MIN, 30_000)
  assert.equal(MODEL_PHASE_TIMEOUT_MS_MAX, 60_000)
  assert.ok(MODEL_PHASE_TIMEOUT_MS_DEFAULT >= MODEL_PHASE_TIMEOUT_MS_MIN)
  assert.ok(MODEL_PHASE_TIMEOUT_MS_DEFAULT <= MODEL_PHASE_TIMEOUT_MS_MAX)
})

// ── 缓存键与来源指纹 ─────────────────────────────────────────────────────

test('modelCacheKeyOf：同输入稳定、模型名与消息体敏感', () => {
  const messages = buildModelMessages({ model: 'm1', facts: [], blocks: BLOCKS, selected: SELECTED })
  const a = modelCacheKeyOf({ model: 'm1', messages })
  assert.equal(a, modelCacheKeyOf({ model: 'm1', messages }))
  assert.notEqual(a, modelCacheKeyOf({ model: 'm2', messages }))
  assert.notEqual(a, modelCacheKeyOf({ model: 'm1', messages: [{ role: 'user', content: '换了' }] }))
  assert.match(a, /^mc-[0-9a-f]{24}$/)
})

test('blocksHashOf：程序选块变化即指纹变化（缓存过期判据）', () => {
  assert.equal(blocksHashOf(SELECTED), blocksHashOf([{ blockId: 'blk-1', line: '工具：run_code；exit 0；版本 1.2.3；共 5 条' }]))
  assert.notEqual(blocksHashOf(SELECTED), blocksHashOf(BLOCKS))
})

// ── verifyModelSummary：机械校验（对回 L0 精确值） ──────────────────────

test('verifyModelSummary：合法行保留，非法引用/编造数字剔除', () => {
  const verdict = verifyModelSummary({
    parsed: {
      lines: [
        { text: 'exit 0，版本 1.2.3。', refs: ['blk-1'] },
        { text: '引用了没选中的块。', refs: ['blk-2'] },
        { text: '编造数字 99999 条。', refs: ['blk-1'] },
        { text: '', refs: ['blk-1'] },
        { text: '没有引用。', refs: [] },
      ],
    },
    selected: SELECTED,
  })
  assert.equal(verdict.ok, true)
  assert.equal(verdict.kept.length, 1)
  assert.equal(verdict.kept[0].text, 'exit 0，版本 1.2.3。')
  assert.equal(verdict.rejected.length, 4)
  // blk-2 未选中 → invalid-ref；空文本 → invalid-shape；编造 99999 → invalid-shape；无引用 → invalid-ref
  assert.deepEqual(verdict.rejected.map((r) => r.reason).sort(), ['invalid-ref', 'invalid-ref', 'invalid-shape', 'invalid-shape'])
})

test('verifyModelSummary：全剔 / 空行集 / 超行数 都不用', () => {
  const allBad = verifyModelSummary({ parsed: { lines: [{ text: '编造 1.0.0', refs: ['blk-1'] }] }, selected: SELECTED })
  assert.equal(allBad.ok, false)
  // 全剔且剔除原因是数字编造（invalid-shape）→ 如实报 empty-output，不冒充 invalid-ref。
  assert.equal(allBad.reason, 'empty-output')
  const empty = verifyModelSummary({ parsed: { lines: [] }, selected: SELECTED })
  assert.equal(empty.ok, false)
  assert.equal(empty.reason, 'empty-output')
  const notArray = verifyModelSummary({ parsed: { lines: '不是数组' }, selected: SELECTED })
  assert.equal(notArray.ok, false)
  const tooMany = verifyModelSummary({
    parsed: { lines: Array.from({ length: MODEL_SUMMARY_MAX_LINES + 1 }, () => ({ text: '无数字', refs: ['blk-1'] })) },
    selected: SELECTED,
  })
  assert.equal(tooMany.ok, false)
  assert.equal(tooMany.reason, 'invalid-shape')
})

// ── runModelPhase：失败关闭阶梯全档位 ───────────────────────────────────

test('runModelPhase：无 stream 即 no-model，程序档', async () => {
  const result = await runModelPhase({ selected: SELECTED, programCardTokens: 500 })
  assert.equal(result.mode, 'program')
  assert.equal(result.reason, 'no-model')
})

for (const [name, error, expected] of [
  ['鉴权失败落回 auth', new Error('401 unauthorized'), 'auth'],
  ['限流落回 rate-limit', new Error('429 too many requests'), 'rate-limit'],
  ['其他宿主错误落回 host-error', new Error('boom'), 'host-error'],
]) {
  test('runModelPhase：stream 抛错——' + name, async () => {
    let onUsageCalls = 0
    const result = await runModelPhase({
      stream: async () => { throw error },
      model: 'm1',
      selected: SELECTED,
      programCardTokens: 500,
      onUsage: () => { onUsageCalls += 1 },
    })
    assert.equal(result.mode, 'program')
    assert.equal(result.reason, expected)
    // 没拿到 usage 就不该落账。
    assert.equal(onUsageCalls, 0)
  })
}

test('runModelPhase：空输出与非 JSON 落回', async () => {
  const empty = await runModelPhase({ stream: async () => ({ text: '', usage: null }), model: 'm1', selected: SELECTED, programCardTokens: 500 })
  assert.equal(empty.mode, 'program')
  assert.equal(empty.reason, 'invalid-shape')
  const junk = await runModelPhase({ stream: async () => ({ text: '这不是 JSON', usage: null }), model: 'm1', selected: SELECTED, programCardTokens: 500 })
  assert.equal(junk.mode, 'program')
  assert.equal(junk.reason, 'invalid-shape')
})

test('runModelPhase：全部结论非法引用 → invalid-ref，程序档', async () => {
  // 引用块 ID 不在 selected → invalid-ref 剔除；全部结论如此 → 全剔如实报 invalid-ref。
  const bad = { lines: [{ text: '工具 exit 0。', refs: ['blk-x'] }] }
  const result = await runModelPhase({ stream: okStream(bad), model: 'm1', selected: SELECTED, programCardTokens: 500 })
  assert.equal(result.mode, 'program')
  assert.equal(result.reason, 'invalid-ref')
})

test('runModelPhase：模型卡不比程序卡省 → no-gain；超卡预算 → over-budget', async () => {
  const noGain = await runModelPhase({ stream: okStream(), model: 'm1', selected: SELECTED, programCardTokens: 1 })
  assert.equal(noGain.mode, 'program')
  assert.equal(noGain.reason, 'no-gain')
  // 32 行中文长行（每行都在上限内、无数字）：合计远超 1024 token 卡预算。
  const longLines = Array.from({ length: MODEL_SUMMARY_MAX_LINES }, () => ({
    text: '这' .repeat(380),
    refs: ['blk-1'],
  }))
  const overBudget = await runModelPhase({
    stream: okStream({ lines: longLines }),
    model: 'm1',
    selected: SELECTED,
    programCardTokens: Number.POSITIVE_INFINITY,
  })
  assert.equal(overBudget.mode, 'program')
  assert.equal(overBudget.reason, 'over-budget')
})

test('runModelPhase：成功路径——模型卡 + usage 落账 + 缓存写入', async () => {
  const usageRows = []
  const cacheSaves = []
  const result = await runModelPhase({
    stream: okStream(),
    model: 'm1',
    selected: SELECTED,
    programCardTokens: 4096,
    onUsage: async (row) => { usageRows.push(row) },
    cacheSave: async (entry) => { cacheSaves.push(entry) },
    summaryId: 'ph-x',
    phaseLabel: '阶段 1-9',
    memberCount: 9,
    tools: ['run_code'],
    manifestId: 'mf-x',
    voucherId: 'agg-0009',
  })
  assert.equal(result.mode, 'model')
  assert.equal(result.cacheHit, false)
  assert.ok(result.card.includes('1.2.3'))
  assert.ok(result.card.includes('blk-1'))
  assert.ok(result.card.includes('ag-0009') === false)
  assert.equal(usageRows.length, 1)
  assert.deepEqual(usageRows[0].usage, { input: 10, output: 5 })
  assert.equal(usageRows[0].cacheHit, false)
  assert.equal(cacheSaves.length, 1)
  assert.equal(typeof cacheSaves[0].key, 'string')
  assert.equal(cacheSaves[0].blocksHash, blocksHashOf(SELECTED))
})

test('runModelPhase：缓存命中不调 stream，usage 沿用缓存并如实落账', async () => {
  let streamCalls = 0
  const usageRows = []
  let cacheSaveCalls = 0
  const messages = buildModelMessages({ model: 'm1', facts: [], blocks: SELECTED, selected: SELECTED })
  const key = modelCacheKeyOf({ model: 'm1', messages })
  const result = await runModelPhase({
    stream: () => { streamCalls += 1; return okStream()() },
    model: 'm1',
    selected: SELECTED,
    programCardTokens: 4096,
    cacheLookup: async (lookupKey, blocksHash) => {
      assert.equal(lookupKey, key)
      assert.equal(blocksHash, blocksHashOf(SELECTED))
      return { text: JSON.stringify(goodSummary()), usage: { input: 0, output: 0 } }
    },
    cacheSave: async () => { cacheSaveCalls += 1 },
    onUsage: async (row) => { usageRows.push(row) },
  })
  assert.equal(result.mode, 'model')
  assert.equal(result.cacheHit, true)
  assert.equal(streamCalls, 0)
  assert.equal(cacheSaveCalls, 0)
  assert.equal(usageRows.length, 1)
  assert.equal(usageRows[0].cacheHit, true)
})

test('runModelPhase：缓存正文过期（blocksHash 不匹配）不命中', async () => {
  let streamCalls = 0
  const result = await runModelPhase({
    stream: () => { streamCalls += 1; return okStream()() },
    model: 'm1',
    selected: SELECTED,
    programCardTokens: 4096,
    cacheLookup: async () => null,
  })
  assert.equal(result.mode, 'model')
  assert.equal(streamCalls, 1)
})

test('runModelPhase：缓存与账本钩子抛错都不阻断（观察面失败不破坏压缩）', async () => {
  const result = await runModelPhase({
    stream: okStream(),
    model: 'm1',
    selected: SELECTED,
    programCardTokens: 4096,
    cacheLookup: async () => { throw new Error('cache read failed') },
    cacheSave: async () => { throw new Error('cache write failed') },
    onUsage: async () => { throw new Error('ledger write failed') },
  })
  assert.equal(result.mode, 'model')
})

test('runModelPhase：外部取消（已中止 / 返回后中止）→ cancelled 不落账', async () => {
  const controller = new AbortController()
  controller.abort()
  const preAborted = await runModelPhase({
    stream: okStream(),
    model: 'm1',
    selected: SELECTED,
    signal: controller.signal,
    onUsage: async () => { throw new Error('不该落账') },
  })
  assert.equal(preAborted.mode, 'program')
  assert.equal(preAborted.reason, 'cancelled')
  assert.equal(preAborted.cancelled, true)

  // stream 成功返回之后才外部中止：任务撤销，结果丢弃。
  const late = new AbortController()
  const lateResult = await runModelPhase({
    stream: async () => { late.abort(); return { text: JSON.stringify(goodSummary()), usage: { input: 1 } } },
    model: 'm1',
    selected: SELECTED,
    programCardTokens: 4096,
    signal: late.signal,
    onUsage: async () => { throw new Error('不该落账') },
  })
  assert.equal(lateResult.mode, 'program')
  assert.equal(lateResult.cancelled, true)
})

test('renderModelPhaseCard：与程序卡同构，剔除行数如实标注', () => {
  const card = renderModelPhaseCard({
    summaryId: 'ph-x',
    phaseLabel: '阶段 1-9',
    memberCount: 9,
    tools: ['run_code'],
    lines: [{ text: 'exit 0', refs: ['blk-1'] }],
    manifestId: 'mf-x',
    voucherId: 'agg-0009',
    rejectedCount: 2,
  })
  assert.ok(card.startsWith('【阶段卡 ph-x】'))
  assert.ok(card.includes('· exit 0（blk-1）'))
  assert.ok(card.includes('2 条未通过对回 L0 的机械校验'))
  assert.ok(card.includes('/memory-lab2 expand agg-0009'))
})

// ── model-ledger：缓存/费用侧车（JSONL、双匹配、坏行跳过） ─────────────

function ledgerDir() {
  return mkdtempSync(join(tmpdir(), 'mcl2-model-ledger-'))
}

test('侧车缓存：写入后按 key+blocksHash 双匹配读回', async () => {
  const dir = ledgerDir()
  await appendModelCacheEntry(dir, { key: 'k1', blocksHash: 'h1', text: '正文', model: 'm1' })
  await appendModelCacheEntry(dir, { key: 'k1', blocksHash: 'h2', text: '过期正文', model: 'm1' })
  const hit = await readModelCacheEntry(dir, 'k1', 'h1')
  assert.equal(hit.text, '正文')
  const stale = await readModelCacheEntry(dir, 'k1', 'h2')
  assert.equal(stale.text, '过期正文')
  assert.equal(await readModelCacheEntry(dir, 'k1', 'hX'), null)
  assert.equal(await readModelCacheEntry(dir, 'kX', 'h1'), null)
  assert.equal(await readModelCacheEntry(dir, '', 'h1'), null)
})

test('侧车缓存：撕裂半行与坏行跳过，不拦命中', async () => {
  const dir = ledgerDir()
  await appendModelCacheEntry(dir, { key: 'k1', blocksHash: 'h1', text: '正文', model: 'm1' })
  // 模拟 append 中途崩溃：手工补一行半截 JSON。
  const { appendFile } = await import('node:fs/promises')
  await appendFile(join(dir, 'model-summary-cache.jsonl'), '{"key":"k1","blocksHas', 'utf8')
  const hit = await readModelCacheEntry(dir, 'k1', 'h1')
  assert.equal(hit.text, '正文')
})

test('侧车缓存：文件不存在返回 null（ENOENT 是常态）', async () => {
  assert.equal(await readModelCacheEntry(ledgerDir(), 'k1', 'h1'), null)
})

test('费用账本：追加与倒序读取', async () => {
  const dir = ledgerDir()
  await appendModelUsageEntry(dir, { model: 'm1', usage: { input: 1 }, cacheHit: false })
  await appendModelUsageEntry(dir, { model: 'm1', usage: { input: 2 }, cacheHit: true })
  const rows = await readModelUsageEntries(dir)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].usage.input, 2)
  assert.equal(rows[0].cacheHit, true)
  assert.equal(rows[1].usage.input, 1)
  assert.equal((await readModelUsageEntries(dir, { limit: 1 })).length, 1)
  assert.deepEqual(await readModelUsageEntries(ledgerDir()), [])
})

// ── 协调器接线：模型卡替换相位卡、取消即停不落兜底 ─────────────────────

let receiptSeq = 0
function receiptText() {
  receiptSeq += 1
  const id = 'mcl2-def000000000000000000000-' + String(receiptSeq).padStart(6, '0')
  // 正文行带成员序号：程序卡的证据块按内容去重，全部相同的模板行会让 8 个成员
  // 折叠成 1 块，模型卡的「净省」比对场景就不成立（no-gain 恒真）。
  return [
    V2_RECEIPT_MARKER,
    '工具：run_code',
    '来源：seq ' + receiptSeq + '–' + receiptSeq + '（1 次调用，原 ≈500 token / 2000 字）',
    '冷记录：' + id,
    'hash：' + id.slice(-10),
    '',
    'run_code 以 exit 0 完成，版本 1.2.3，第 ' + receiptSeq + ' 轮共 5 条输出。',
  ].join('\n')
}

function wiredDeps({ stream, signal, model = 'm1' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mcl2-model-wire-'))
  const session = new FakeSession({ id: 'session-model-wire' })
  const memberBodies = new Map()
  const deps = {
    sessionDir: dir,
    eventAt: (seq) => session.eventAt(seq),
    surfaceNodes: () => [...session.surface.nodes],
    surfaceVoucherNodes: () => {
      const found = []
      for (const seq of session.surface.nodes) {
        const event = session.eventAt(seq)
        if (event?.type !== 'user/message') continue
        const first = event.data?.content?.find((part) => part?.type === 'text')
        if (typeof first?.text === 'string' && first.text.startsWith(AGG_VOUCHER_MARKER)) found.push({ seq, text: first.text })
      }
      return found
    },
    getRecordBody: async (recordId) => memberBodies.get(recordId) ?? null,
    getRecordKind: () => 'tool-output',
    isRecordVisible: () => true,
    appendVoucherMessage: async ({ startSeq, endSeq, memberSeqs, text }) => {
      const event = session.append('user/message', { content: [{ type: 'text', text }] }, {
        surfaceOp: { op: 'replace', startSeq, endSeq },
        sourceEventSeqs: memberSeqs,
        source: { kind: 'user', form: 'memory-lab2-surface' },
      })
      return { seq: event?.seq }
    },
  }
  if (stream !== undefined || signal !== undefined) {
    deps.modelPhase = {
      stream,
      model,
      cacheLookup: async (key, blocksHash) => readModelCacheEntry(dir, key, blocksHash),
      cacheSave: async (entry) => appendModelCacheEntry(dir, entry),
      onUsage: async (row) => appendModelUsageEntry(dir, row),
      signal,
    }
  }
  return { dir, session, deps, memberBodies }
}

async function seedRun(session, memberBodies, count) {
  session.append('user/message', { id: 'bootstrap', role: 'user', content: [{ type: 'text', text: '会话开始' }] }, { surfaceOp: 'append' })
  for (let i = 0; i < count; i++) {
    const text = receiptText()
    session.append('user/message', {
      id: 'surface-' + i,
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'user', form: 'memory-lab2-surface' },
    }, { surfaceOp: 'append' })
    const recordId = 'mcl2-def000000000000000000000-' + String(receiptSeq).padStart(6, '0')
    memberBodies.set(recordId, text)
  }
}

test('接线：模型模式开启时，ready 候选相位卡换成校验过的模型卡，凭证正文不变', async () => {
  const { session, deps, memberBodies } = wiredDeps({ stream: async ({ messages }) => {
    // 消息里应带程序选中的块行文（含可校验的数字）；refs 必须用清单里的真实块 ID
    // （写死 'blk-1' 会因 invalid-ref 落回程序卡——0.10.1 修复时的实测教训）。
    const user = messages.find((m) => m.role === 'user')
    assert.ok(user && user.content.includes('1.2.3'))
    const blockIdMatch = /\[([^\]]+)\] /.exec(user.content)
    assert.ok(blockIdMatch, '事实清单必须带块 ID')
    const blockId = blockIdMatch[1]
    return { text: JSON.stringify({ lines: [{ text: 'run_code exit 0，版本 1.2.3，共 5 条。', refs: [blockId] }] }), usage: { input: 7 } }
  } })
  // 8 成员：程序卡逐块行文（≥8 行）天然大于单行结论的模型卡——no-gain 判定
  // 的比对场景必须让「模型卡更省」成立，否则接线测试实际测的是 no-gain 落回。
  await seedRun(session, memberBodies, 8)
  const preview = await compressPreview(deps)
  assert.ok(preview.text.includes('模型'), '预览应标注模型模式：' + preview.text)
  const run = await compressRun(deps)
  assert.equal(run.applied.length, 1)
  const { loadHierarchy } = await import('../src/v2/hierarchy-store.mjs')
  const ledger = await loadHierarchy(deps.sessionDir)
  const l2 = ledger.entries.find((e) => e.kind === 'hierarchy/l2-phase')
  assert.ok(l2, '应有 L2 相位卡条目')
  assert.ok(l2.text.includes('模型摘要模式'), 'L2 应是模型卡：' + l2.text)
  assert.ok(l2.text.includes('1.2.3'))
  // 凭证正文保持恒定渲染（不含模型卡脚注）。
  const voucher = ledger.entries.find((e) => e.kind === 'hierarchy/agg-voucher')
  assert.ok(!voucher.text.includes('模型摘要模式'))
  // 费用账本已落一行。
  const usageRows = await readModelUsageEntries(deps.sessionDir)
  assert.equal(usageRows.length, 1)
  assert.deepEqual(usageRows[0].usage, { input: 7 })
})

test('接线：模型失败（host-error）落回程序卡，run 照常提交', async () => {
  const { session, deps, memberBodies } = wiredDeps({ stream: async () => { throw new Error('boom') } })
  await seedRun(session, memberBodies, 4)
  const run = await compressRun(deps)
  assert.equal(run.applied.length, 1, '失败不阻断提交')
  const { loadHierarchy } = await import('../src/v2/hierarchy-store.mjs')
  const ledger = await loadHierarchy(deps.sessionDir)
  const l2 = ledger.entries.find((e) => e.kind === 'hierarchy/l2-phase')
  assert.ok(!l2.text.includes('模型摘要模式'), '应是程序卡')
  // 失败也花了钱吗？没有 usage（抛错没有返回 usage），不落账。
  assert.equal((await readModelUsageEntries(deps.sessionDir)).length, 0)
})

test('接线：用户取消是任务撤销——run 即停、不借兜底提交、原状态保留', async () => {
  const controller = new AbortController()
  const { session, deps, memberBodies } = wiredDeps({
    stream: async () => { controller.abort(); throw new Error('外部中止') },
    signal: controller.signal,
  })
  await seedRun(session, memberBodies, 4)
  const run = await compressRun(deps)
  assert.equal(run.applied.length, 0, '取消不提交')
  assert.equal(run.cancelled, true, 'run 结果应标注任务撤销')
  const preview = await compressPreview(deps)
  assert.ok(preview.text.includes('取消'), '预览应如实标注取消')
  // 表面没有凭证消息（原回执保留）。
  const { loadHierarchy } = await import('../src/v2/hierarchy-store.mjs')
  const ledger = await loadHierarchy(deps.sessionDir)
  assert.equal(ledger.entries.filter((e) => e.kind === 'hierarchy/agg-voucher').length, 0)
})

test('接线：模型模式未注入（modelPhase 缺失）全链路程序档可用', async () => {
  const { session, deps, memberBodies } = wiredDeps({})
  await seedRun(session, memberBodies, 4)
  const run = await compressRun(deps)
  assert.equal(run.applied.length, 1)
  const { loadHierarchy, HIERARCHY_ENTRY_L2 } = await import('../src/v2/hierarchy-store.mjs')
  const ledger = await loadHierarchy(deps.sessionDir)
  const l2 = ledger.entries.find((e) => e.kind === HIERARCHY_ENTRY_L2)
  assert.ok(l2, '程序档也应写 L2 相位卡')
  assert.ok(!l2.text.includes('模型摘要模式'))
})
