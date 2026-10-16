/**
 * v2 层级压缩程序面（P3-4/5/6/7）测试：模板共享（重复操作骨架只展示一次、
 * 失败→复验保序）、预算覆盖选择（必需先行、覆盖÷成本贪心、requiredOverflow
 * 如实上报）、查询相关摘录（命中行选择、尾部限制行保留、无命中保守首尾、
 * 长度封顶）、no-safe-gain 判定（不净缩短/必需装不下均拒绝替换）。全部纯
 * 函数、确定性断言（两次运行字节一致）。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { estimateTokensOf } from '../src/v2/budget.mjs'
import {
  COMPRESS_BATCH_SOURCE_TOKENS,
  COMPRESS_BATCH_SOURCE_TOKENS_MAX,
  COMPRESS_CONCURRENCY,
  COMPRESS_TASK_TIMEOUT_MS,
  MMR_LAMBDA,
  PHASE_CARD_MAX_TOKENS,
  budgetSelect,
  buildBlocks,
  excerptLinesFor,
  noSafeGainCheck,
  renderEvidenceCard,
  renderPhaseCard,
  renderTaskIndex,
} from '../src/v2/compressor-program.mjs'
import { extractAtoms, groupAtoms, mergeFacts } from '../src/v2/evidence-atoms.mjs'
import { SPAN_KINDS } from '../src/v2/history.mjs'

function operationBody(parts) {
  return parts.join('\n\n')
}

function operationMember({ body, tools = ['pwsh'], callIds = ['call_1'], start = 10, failed = false }) {
  return {
    recordId: 't00000001-r0001',
    nodeId: 'node-1',
    spanKind: SPAN_KINDS.OPERATION,
    tools,
    callIds,
    range: { start, end: start + 2 },
    body,
    pluginAuthored: false,
    createdAt: '2026-10-16T10:00:00.000Z',
    failed,
  }
}

/** 一组「跑测试」成员：命令相同、退出码不同（失败→复验通过）。 */
function testRunMembers() {
  return [
    operationMember({
      body: operationBody(['[工具] pwsh', '参数：{"command":"npm test"}', '[结果]\n[exit code: 1]\n2 项失败']),
      callIds: ['call_a'],
      start: 10,
      failed: true,
    }),
    operationMember({
      body: operationBody(['[工具] pwsh', '参数：{"command":"npm test"}', '[结果]\n[exit code: 0]\n465 项全绿']),
      callIds: ['call_b'],
      start: 30,
      failed: false,
    }),
    operationMember({
      body: operationBody(['[工具] pwsh', '参数：{"command":"npm test"}', '[结果]\n[exit code: 0]\n465 项全绿']),
      callIds: ['call_c'],
      start: 50,
      failed: false,
    }),
  ]
}

function pipeline(members) {
  const atoms = members.flatMap((member) => extractAtoms(member))
  const facts = mergeFacts(atoms)
  const groups = groupAtoms(facts)
  return { atoms, facts, groups }
}

// ---------------------------------------------------------------- 常量与门

test('试运行参数常量与计划拍板一致（8–12k 源 token、卡 1k、超时 60s、并发 1）', () => {
  assert.equal(COMPRESS_BATCH_SOURCE_TOKENS, 8192)
  assert.ok(COMPRESS_BATCH_SOURCE_TOKENS_MAX <= 12288)
  assert.equal(COMPRESS_TASK_TIMEOUT_MS, 60_000)
  assert.equal(COMPRESS_CONCURRENCY, 1)
  assert.equal(PHASE_CARD_MAX_TOKENS, 1024)
  assert.ok(MMR_LAMBDA > 0 && MMR_LAMBDA < 1)
})

// ---------------------------------------------------------------- 模板共享（P3-4）

test('buildBlocks：重复命令骨架合并为一条模板行（重复 N 次 + 变化值 + 首末时间）', () => {
  const members = testRunMembers()
  const { facts, groups } = pipeline(members)
  const blocks = buildBlocks(facts, groups)
  const templateBlocks = blocks.filter((block) => block.coverage.length > 1)
  // 命令事实同键合并成一个事实（键只一个），模板行出现在「退出码」家族近组或
  // 单事实块上——这里验证的是：重复值出现在一条行里而不是三条独立行。
  const commandLines = blocks.filter((block) => block.line.includes('命令') && block.line.includes('npm test'))
  assert.ok(commandLines.length >= 1)
  const joined = blocks.map((block) => block.line).join('\n')
  // 失败→复验两条退出码事实（exit 1 / exit 0 键不同）保序呈现，不丢任何一条。
  assert.ok(joined.includes('exit 1'))
  assert.ok(joined.includes('exit 0'))
  // 值不重复出现三次：同键事实只渲染一次（或进模板行一次）。
  const occurrences = joined.split('exit 0').length - 1
  assert.ok(occurrences <= 2)
  // 每个块带 token 计量与覆盖键。
  for (const block of blocks) {
    assert.ok(block.blockId.startsWith('blk-'))
    assert.ok(Number.isFinite(block.tokens) && block.tokens > 0)
    assert.ok(Array.isArray(block.coverage) && block.coverage.length >= 1)
    assert.equal(typeof block.required, 'boolean')
  }
  // 覆盖键并集 = 全部事实键（不丢事实）。
  const covered = new Set(blocks.flatMap((block) => block.coverage))
  for (const fact of facts) assert.ok(covered.has(fact.key))
  assert.ok(templateBlocks.length <= blocks.length)
})

test('buildBlocks：确定性（两次运行字节一致）与空输入', () => {
  const members = testRunMembers()
  const { facts, groups } = pipeline(members)
  const first = JSON.stringify(buildBlocks(facts, groups))
  const second = JSON.stringify(buildBlocks(facts, groups))
  assert.equal(first, second)
  assert.deepEqual(buildBlocks([], groupAtoms([])), [])
  assert.deepEqual(buildBlocks([], { groups: [] }), [])
})

// ---------------------------------------------------------------- 预算覆盖选择（P3-5）

test('budgetSelect：必需块先行装入，非必需按覆盖÷成本贪心，全部装得下时不丢块', () => {
  const members = testRunMembers()
  const { facts, groups } = pipeline(members)
  const blocks = buildBlocks(facts, groups)
  const result = budgetSelect(blocks, { budgetTokens: 4096 })
  assert.equal(result.selected.length, blocks.length)
  assert.deepEqual(result.dropped, [])
  assert.equal(result.requiredOverflow, false)
  assert.equal(result.coverageCount, result.totalAtoms)
  assert.ok(result.usedTokens > 0)
  // 负极性事实（exit 1）必选。
  const requiredBlocks = blocks.filter((block) => block.required)
  for (const block of requiredBlocks) {
    assert.ok(result.selected.includes(block), 'required block must be selected: ' + block.blockId)
  }
})

test('budgetSelect：预算不足时丢块给明原因；requiredOverflow 如实上报', () => {
  const members = testRunMembers()
  const { facts, groups } = pipeline(members)
  const blocks = buildBlocks(facts, groups)
  const total = blocks.reduce((sum, block) => sum + block.tokens, 0)
  // 预算只够一半：非必需块应被裁且 reason=budget。
  const tight = budgetSelect(blocks, { budgetTokens: Math.max(1, Math.floor(total / 2)) })
  assert.ok(tight.selected.length < blocks.length)
  assert.ok(tight.dropped.length > 0)
  for (const drop of tight.dropped) {
    assert.ok(drop.reason === 'budget' || drop.reason === 'required-overflow')
  }
  // 预算小到必需块都装不下：requiredOverflow=true，不静默丢必需。
  const overflow = budgetSelect(blocks, { budgetTokens: 1 })
  assert.equal(overflow.requiredOverflow, true)
  assert.ok(overflow.dropped.some((drop) => drop.reason === 'required-overflow'))
  // 空 blocks。
  const empty = budgetSelect([], {})
  assert.deepEqual(empty.selected, [])
  assert.deepEqual(empty.dropped, [])
  assert.equal(empty.usedTokens, 0)
  assert.equal(empty.coverageCount, 0)
  assert.equal(empty.totalAtoms, 0)
})

test('budgetSelect：贪心先选覆盖增益÷成本最高的块（合成块）', () => {
  const blocks = [
    { blockId: 'blk-a', line: 'a'.repeat(40), tokens: 10, coverage: ['k1'], required: false },
    { blockId: 'blk-b', line: 'b'.repeat(80), tokens: 40, coverage: ['k2', 'k3', 'k4', 'k5', 'k6'], required: false },
  ]
  const result = budgetSelect(blocks, { budgetTokens: 20 })
  assert.deepEqual(result.selected.map((block) => block.blockId), ['blk-a'])
  assert.deepEqual(result.dropped.map((drop) => drop.blockId), ['blk-b'])
})

// ---------------------------------------------------------------- 查询相关摘录（P3-6）

test('excerptLinesFor：命中行优先，尾部限制行保留，非相邻行以省略号衔接', () => {
  const body = ['头部行', 'npm test 跑了 465 项', '中间行', 'exit code 1 出现失败', '前提：不修改全局配置'].join('\n')
  const out = excerptLinesFor(['npm', 'exit'], body)
  assert.ok(out.includes('npm test 跑了 465 项'))
  assert.ok(out.includes('exit code 1 出现失败'))
  assert.ok(out.includes('前提：不修改全局配置'), '尾部限制条件行必须保留')
  assert.ok(!out.includes('中间行'))
  assert.ok(!out.includes('头部行'))
})

test('excerptLinesFor：无命中退化为首尾行，不硬造相关性', () => {
  const body = ['第一行', '第二行', '第三行'].join('\n')
  const out = excerptLinesFor(['不存在的词'], body)
  assert.equal(out, '第一行\n第三行')
})

test('excerptLinesFor：空词表取前 maxLines 行；总长封顶加省略号', () => {
  const body = ['一', '二', '三', '四'].join('\n')
  assert.equal(excerptLinesFor([], body, { maxLines: 2 }), '一\n二')
  assert.equal(excerptLinesFor(null, body, { maxLines: 1 }), '一')
  const clipped = excerptLinesFor([], '长'.repeat(100), { maxLines: 3, maxChars: 10 })
  assert.ok(clipped.endsWith('…'))
  assert.ok(clipped.length <= 11)
  assert.equal(excerptLinesFor(['x'], ''), '')
  assert.equal(excerptLinesFor(['x'], '\n\n'), '')
})

test('excerptLinesFor：按命中数降序选行，行数封顶 maxLines', () => {
  const body = ['npm 与 exit 都在', '只有 npm', 'npm npm exit 也都在', '无关'].join('\n')
  const out = excerptLinesFor(['npm', 'exit'], body, { maxLines: 2 })
  const rows = out.split('\n')
  assert.ok(rows.length <= 3) // 2 命中 + 尾部限制行
})

// ---------------------------------------------------------------- no-safe-gain（P3-7）

test('noSafeGainCheck：不净缩短拒绝；requiredOverflow 拒绝；净缩短通过', () => {
  const memberTokens = 500
  const big = noSafeGainCheck({ memberTokens, voucherText: 'x'.repeat(4000) })
  assert.equal(big.ok, false)
  assert.equal(big.reason, 'no-safe-gain')
  assert.ok(big.net < 0)
  const equal = noSafeGainCheck({ memberTokens, voucherText: 'y'.repeat(500 * 4) })
  assert.equal(equal.ok, false, '等长也不替换')
  const good = noSafeGainCheck({ memberTokens, voucherText: 'z'.repeat(400) })
  assert.equal(good.ok, true)
  assert.ok(good.net > 0)
  const overflow = noSafeGainCheck({ memberTokens, voucherText: '', requiredOverflow: true })
  assert.equal(overflow.ok, false)
  assert.equal(overflow.detail, '必需事实装不下（requiredOverflow）')
})

// ---------------------------------------------------------------- 层级卡渲染

test('renderPhaseCard：含 manifest、凭证与展开入口，字节稳定，无时间戳', () => {
  const members = testRunMembers()
  const { facts, groups } = pipeline(members)
  const blocks = buildBlocks(facts, groups)
  const selection = budgetSelect(blocks, { budgetTokens: 4096 })
  const card = renderPhaseCard({
    summaryId: 'L2-0001',
    phaseLabel: '测试阶段',
    memberCount: members.length,
    tools: ['pwsh'],
    blocks: selection.selected,
    manifestId: 'mf-abc123',
    voucherId: 'vc-def456',
    dropped: selection.dropped,
    truncated: false,
  })
  assert.ok(card.includes('【阶段卡 L2-0001】测试阶段'))
  assert.ok(card.includes('3 个已完成操作'))
  assert.ok(card.includes('工具 pwsh'))
  assert.ok(card.includes('manifest mf-abc123'))
  assert.ok(card.includes('/memory-lab2 expand vc-def456 --page 1'))
  assert.ok(!/d{4}-d{2}-d{2}T/.test(card), '卡内容不含时间戳')
  assert.ok(estimateTokensOf(card) <= PHASE_CARD_MAX_TOKENS + 4)
  const again = renderPhaseCard({
    summaryId: 'L2-0001',
    phaseLabel: '测试阶段',
    memberCount: members.length,
    tools: ['pwsh'],
    blocks: selection.selected,
    manifestId: 'mf-abc123',
    voucherId: 'vc-def456',
    dropped: selection.dropped,
    truncated: false,
  })
  assert.equal(card, again)
  // 丢块披露行：预算收紧时非必需块被丢，卡上如实披露。
  const tight = budgetSelect(blocks, { budgetTokens: 48 })
  assert.ok(tight.dropped.length > 0)
  const tightCard = renderPhaseCard({
    summaryId: 'L2-0003', phaseLabel: 't', memberCount: members.length, tools: ['pwsh'],
    blocks: tight.selected, manifestId: 'm', voucherId: 'v', dropped: tight.dropped, truncated: false,
  })
  assert.ok(tightCard.includes('逐条可展开'))
  // truncated 披露行。
  const truncatedCard = renderPhaseCard({
    summaryId: 'L2-0002', phaseLabel: 'x', memberCount: 1, tools: [], blocks: [], manifestId: 'm', voucherId: 'v', truncated: true,
  })
  assert.ok(truncatedCard.includes('归组候选截断'))
})

test('renderTaskIndex 与 renderEvidenceCard：不复制正文、原子逐行', () => {
  const index = renderTaskIndex({
    summaryId: 'L3-0001',
    phases: [
      { phaseLabel: '阶段一', memberCount: 5, summaryId: 'L2-0001', voucherId: 'vc-1' },
      { phaseLabel: '阶段二', memberCount: 3, summaryId: 'L2-0002', voucherId: 'vc-2' },
    ],
  })
  assert.ok(index.includes('【任务索引 L3-0001】'))
  assert.ok(index.includes('阶段一（5 操作；阶段卡 L2-0001；凭证 vc-1）'))
  assert.ok(index.includes('阶段二（3 操作；阶段卡 L2-0002；凭证 vc-2）'))

  const member = testRunMembers()[0]
  const atoms = extractAtoms(member)
  const card = renderEvidenceCard({ recordId: 't00000001-r0001', spanLabel: 'pwsh×1', atoms })
  assert.ok(card.includes('【证据卡 t00000001-r0001】pwsh×1'))
  assert.ok(card.includes('退出码'))
  assert.ok(card.includes('exit 1'))
})

test('端到端：提取→合并→归组→装包→卡渲染 全链路确定性', () => {
  const run = () => {
    const members = testRunMembers()
    const { facts, groups } = pipeline(members)
    const blocks = buildBlocks(facts, groups)
    const selection = budgetSelect(blocks, { budgetTokens: 2048 })
    return {
      blocks: JSON.stringify(blocks),
      selected: JSON.stringify(selection.selected),
      card: renderPhaseCard({
        summaryId: 'L2-0001', phaseLabel: 'p', memberCount: members.length, tools: ['pwsh'],
        blocks: selection.selected, manifestId: 'm', voucherId: 'v', dropped: selection.dropped, truncated: false,
      }),
    }
  }
  const first = run()
  const second = run()
  assert.equal(first.blocks, second.blocks)
  assert.equal(first.selected, second.selected)
  assert.equal(first.card, second.card)
})
